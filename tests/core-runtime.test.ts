import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { AdapterDefinition, AdapterType } from "@openclaw/domain"
import { loadProjectProfile } from "@openclaw/project-profiles"
import { afterEach, describe, expect, it } from "vitest"
import { createFakeGhScript, createTempWorkspace } from "./helpers.js"
import { HAS_NODE_SQLITE } from "./node-sqlite.js"

let DispatcherStore: typeof import("@openclaw/db").DispatcherStore | null = null
let DispatcherExecutor: typeof import("@openclaw/executor").DispatcherExecutor | null = null
let DirectorRuntime: typeof import("@openclaw/core-runtime").DirectorRuntime | null = null
let archiveHistoricalBlockedTasks: typeof import("@openclaw/core-runtime").archiveHistoricalBlockedTasks | null = null
let backupRuntimeState: typeof import("@openclaw/core-runtime").backupRuntimeState | null = null
let diagnoseQueueHealth: typeof import("@openclaw/core-runtime").diagnoseQueueHealth | null = null
let pruneDuplicateQueuedWorkflows: typeof import("@openclaw/core-runtime").pruneDuplicateQueuedWorkflows | null = null
let repairQueueHealth: typeof import("@openclaw/core-runtime").repairQueueHealth | null = null
let recoverStaleRuns: typeof import("@openclaw/core-runtime").recoverStaleRuns | null = null
let resetRuntimeState: typeof import("@openclaw/core-runtime").resetRuntimeState | null = null
let sendTelegramDigest: typeof import("@openclaw/core-runtime").sendTelegramDigest | null = null
let reviewCompletedRun: typeof import("@openclaw/executor").reviewCompletedRun | null = null
if (HAS_NODE_SQLITE) {
  ;({ DispatcherStore } = await import("@openclaw/db"))
  ;({ DispatcherExecutor, reviewCompletedRun } = await import("@openclaw/executor"))
  ;({
    DirectorRuntime,
    archiveHistoricalBlockedTasks,
    backupRuntimeState,
    diagnoseQueueHealth,
    pruneDuplicateQueuedWorkflows,
    repairQueueHealth,
    recoverStaleRuns,
    resetRuntimeState,
    sendTelegramDigest
  } = await import("@openclaw/core-runtime"))
}

const describeDb = HAS_NODE_SQLITE ? describe : describe.skip

function fakeAdapter(type: AdapterType, execute: AdapterDefinition["execute"]): AdapterDefinition {
  return {
    type,
    label: type === "codex_local" ? "Codex Local" : type === "gemini_local" ? "Gemini Local" : "Azure Foundry",
    capabilities: {
      supportsSessionResume: type !== "azure_foundry",
      supportsCompaction: true,
      compactionStrategy: type === "codex_local" ? "rotate" : type === "azure_foundry" ? "none" : "summarize",
      preferredPlanningContextWindow: null,
      planningPriority: type === "codex_local" ? 100 : type === "azure_foundry" ? 75 : 80,
      planningCostClass: type === "codex_local" ? "high" : "medium",
      nativeContextManagement: type === "codex_local" ? "confirmed" : type === "azure_foundry" ? "none" : "unknown",
      heartbeatIdentityMode: "prompt_and_env",
      defaultSessionCompaction:
        type === "azure_foundry"
          ? { enabled: false, maxSessionRuns: 0, maxRawInputTokens: 0, maxSessionAgeHours: 0 }
          : type === "codex_local"
            ? { enabled: true, maxSessionRuns: 0, maxRawInputTokens: 0, maxSessionAgeHours: 0 }
            : { enabled: true, maxSessionRuns: 200, maxRawInputTokens: 2_000_000, maxSessionAgeHours: 72 }
    },
    prepare: async () => ({ argv: [], cwd: process.cwd(), env: process.env }),
    execute,
    resume: async (sessionState) => sessionState?.state ?? null,
    parseResult: (stdout) => ({ ok: true, response: stdout, stdout, stderr: "" }),
    healthcheck: async () => ({ ok: true, message: "ok" })
  }
}

function initGitRepo(repoPath: string, root: string): void {
  const originPath = join(root, "origin.git")
  execFileSync("git", ["init", "--bare", originPath], { encoding: "utf8" })
  execFileSync("git", ["init", "-b", "main"], { cwd: repoPath, encoding: "utf8" })
  execFileSync("git", ["config", "user.email", "openclaw@example.test"], { cwd: repoPath, encoding: "utf8" })
  execFileSync("git", ["config", "user.name", "OpenClaw Test"], { cwd: repoPath, encoding: "utf8" })
  writeFileSync(join(repoPath, "README.md"), "# repo\n", "utf8")
  execFileSync("git", ["add", "README.md"], { cwd: repoPath, encoding: "utf8" })
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repoPath, encoding: "utf8" })
  execFileSync("git", ["remote", "add", "origin", originPath], { cwd: repoPath, encoding: "utf8" })
  execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repoPath, encoding: "utf8" })
}

describeDb("core runtime", () => {
  const cleanups: Array<() => void> = []

  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.()
  })

  function setup() {
    const workspace = createTempWorkspace("core-runtime")
    cleanups.push(workspace.cleanup)
    const store = new DispatcherStore!(workspace.dbPath)
    store.migrate()
    const company = store.createCompany({ name: "OpenClaw Labs" })
    const project = store.createProject({
      companyRef: company.id,
      name: "lawyerrag-repo",
      repoPath: workspace.repoPath
    })
    const executor = new DispatcherExecutor!(store, {})
    const runtime = new DirectorRuntime!(store, executor)
    return { workspace, store, company, project, executor, runtime }
  }

  it("refreshes queue state from a project profile and seeds profile-backed workflows", () => {
    const { store, company, project, runtime } = setup()

    const result = runtime.queueRefresh(project.id, "lawyerrag")

    expect(result.profileId).toBe("lawyerrag")
    expect(result.createdWorkflows).toBeGreaterThan(0)
    expect(result.createdTasks).toBeGreaterThan(0)
    expect(result.personasSynced).toBeGreaterThan(0)
    expect(result.jobsSynced).toBe(6)
    expect(store.listPersonas(company.id).map((persona) => persona.name)).toContain("backend-engineer")
    expect(store.listJobSpecs(company.id).map((job) => job.jobId)).toContain("queue-refresh")

    const workflows = store.listWorkflows()
    expect(workflows[0]?.sourceProfileId).toBe("lawyerrag")
    expect(workflows[0]?.orchestraKind).toBe("codex")

    const tasks = store.listTasks()
    expect(tasks[0]?.laneId).toBeTruthy()
    expect(tasks[0]?.requiredReading.length).toBeGreaterThan(0)
    expect(tasks[0]?.verificationCommands.length).toBeGreaterThan(0)

    store.close()
  })

  it("runs execution-sweep immediately when requested as a director job", async () => {
    const workspace = createTempWorkspace("core-runtime-forced-execution")
    cleanups.push(workspace.cleanup)
    const store = new DispatcherStore!(workspace.dbPath)
    store.migrate()
    const company = store.createCompany({ name: "OpenClaw Labs" })
    const project = store.createProject({
      companyRef: company.id,
      name: "lawyerrag-repo",
      repoPath: workspace.repoPath
    })
    store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Run now even when cron is fresh"
    })
    const job = store.upsertJobSpec({
      companyId: company.id,
      projectId: project.id,
      jobId: "execution-sweep",
      sourcePath: ".openclaw/jobs/execution-sweep.json",
      cron: "* * * * *",
      timezone: "UTC",
      entryAgent: "main"
    })
    store.updateJobSpecRuntime(job.id, {
      lastTriggeredAt: new Date().toISOString()
    })
    const automation = store.createAutomation({
      companyRef: company.id,
      projectRef: project.id,
      name: "execution-sweep",
      kind: "repo_health",
      cron: "*/5 * * * *",
      nextRunAt: new Date(Date.now() - 60_000).toISOString(),
      payload: { projectRef: project.id }
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async () => ({ ok: true, response: "done" }))
    })
    const runtime = new DirectorRuntime!(store, executor)

    const result = await runtime.runJob(project.id, "execution-sweep", null)

    expect(result.tickSummary?.executedRuns).toBe(1)
    expect(result.tickSummary?.executedJobs).toBe(1)
    expect(store.getTaskById(task.id).status).toBe("done")
    const acknowledged = store.getAutomationById(automation.id)
    expect(acknowledged.lastRunAt).not.toBeNull()
    expect(acknowledged.nextRunAt).not.toBeNull()
    expect(new Date(acknowledged.nextRunAt!).getTime()).toBeGreaterThan(new Date(acknowledged.lastRunAt!).getTime())

    store.close()
  })

  it("runs queue-refresh full cycle through agent loops and automatic release", async () => {
    const workspace = createTempWorkspace("core-runtime-full-cycle")
    cleanups.push(workspace.cleanup)
    const originalPath = process.env.PATH
    const originalGhLog = process.env.OPENCLAW_FAKE_GH_LOG
    const ghLog = join(workspace.root, "gh.log")
    initGitRepo(workspace.repoPath, workspace.root)
    writeFileSync(
      join(workspace.repoPath, "package.json"),
      JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }, null, 2),
      "utf8"
    )
    execFileSync("git", ["add", "package.json"], { cwd: workspace.repoPath, encoding: "utf8" })
    execFileSync("git", ["commit", "-m", "add test script"], { cwd: workspace.repoPath, encoding: "utf8" })
    execFileSync("git", ["push"], { cwd: workspace.repoPath, encoding: "utf8" })
    createFakeGhScript(workspace.root, "merge")
    process.env.PATH = `${workspace.root}:${originalPath ?? ""}`
    process.env.OPENCLAW_FAKE_GH_LOG = ghLog
    mkdirSync(join(workspace.repoPath, ".openclaw"), { recursive: true })
    const profile = loadProjectProfile("minimal-repo")
    writeFileSync(
      join(workspace.repoPath, ".openclaw", "profile.json"),
      JSON.stringify(
        {
          ...profile,
          promotionPolicy: {
            ...profile.promotionPolicy,
            mode: "ready_pr",
            allowParallelLanes: true,
            autoMerge: true,
            autoRelease: true,
            releaseTagBase: "v9.0.0",
            requireCi: false,
            requireReviewDecision: "none"
          }
        },
        null,
        2
      ),
      "utf8"
    )
    writeFileSync(
      join(workspace.repoPath, ".openclaw", "policy.json"),
      JSON.stringify({ allowPush: true, allowPrCreation: true, allowPrMerge: true }),
      "utf8"
    )

    const store = new DispatcherStore!(workspace.dbPath)
    store.migrate()
    try {
      const company = store.createCompany({ name: "OpenClaw Labs" })
      const project = store.createProject({
        companyRef: company.id,
        name: "lawyerrag-repo",
        repoPath: workspace.repoPath,
        verifyCommand: "npm test"
      })
      store.createAgent({
        companyRef: company.id,
        name: "codex",
        role: "Engineer",
        adapterType: "codex_local"
      })
      const implementationTask = store.createTask({
        projectRef: project.id,
        title: "Ship full-cycle release task",
        kind: "implement",
        reviewRequired: true,
        requestedAdapterType: "codex_local",
        laneId: "app-core"
      })
      const executor = new DispatcherExecutor!(store, {
        codex_local: fakeAdapter("codex_local", async (context) => {
          if (context.task.title.startsWith("Planner run")) {
            return {
              ok: true,
              response: JSON.stringify({
                version: 1,
                summary: "no additional planner work",
                candidates: []
              })
            }
          }
          if (context.task.kind === "implement") {
            writeFileSync(join(context.project.repoPath, "full-cycle.txt"), `implemented by ${context.runId}\n`, "utf8")
          }
          return { ok: true, response: `${context.task.kind} completed` }
        })
      })
      const runtime = new DirectorRuntime!(store, executor)

      const report = await runtime.runQueueRefreshFullCycle(project.id, {
        profileId: "minimal-repo",
        maxPasses: 6,
        waitForLoops: true,
        waitTimeoutMs: 1_000,
        waitPollMs: 1
      })

      expect(report.stopReason).toBe("queue_drained")
      expect(store.getTaskById(implementationTask.id).status).toBe("done")
      expect(report.runs.some((run) => run.taskKind === "implement" && run.loopStatus === "ok")).toBe(true)
      expect(report.runs.some((run) => run.taskKind === "review" && run.lifecyclePhase === "end")).toBe(true)
      expect(report.runs.some((run) => run.taskKind === "promote" && run.lifecyclePhase === "end")).toBe(true)
      expect(report.promotions.some((promotion) => promotion.status === "merged")).toBe(true)
      expect(report.releases.length).toBeGreaterThan(0)
      expect(report.releases.some((release) => release.status === "released")).toBe(true)
      expect(store.getTaskEvents(implementationTask.id).map((event) => event.kind)).toContain("release-published")
      expect(execFileSync("cat", [ghLog], { encoding: "utf8" })).toContain("release create")
    } finally {
      store.close()
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
      if (originalGhLog === undefined) delete process.env.OPENCLAW_FAKE_GH_LOG
      else process.env.OPENCLAW_FAKE_GH_LOG = originalGhLog
    }
  }, 20000)

  it("runs five coding sessions end-to-end through waitable agent loops", async () => {
    const workspace = createTempWorkspace("core-runtime-five-coding-sessions")
    cleanups.push(workspace.cleanup)
    const store = new DispatcherStore!(workspace.dbPath)
    store.migrate()
    try {
      const company = store.createCompany({ name: "OpenClaw Labs" })
      const project = store.createProject({
        companyRef: company.id,
        name: "five-session-repo",
        repoPath: workspace.repoPath
      })
      for (let index = 1; index <= 5; index += 1) {
        store.createAgent({
          companyRef: company.id,
          name: `codex-${index}`,
          role: "Engineer",
          adapterType: "codex_local"
        })
      }

      const profile = loadProjectProfile("minimal-repo")
      const seedProject = profile.managerStateDefaults.projects[0]!
      const seededWorkflow = store.createWorkflow({
        projectRef: project.id,
        title: seedProject.title
      })
      const seededTask = store.createTask({
        projectRef: project.id,
        workflowId: seededWorkflow.id,
        title: seedProject.seedTask.title,
        kind: "implement"
      })
      store.updateTaskStatus(seededTask.id, "done")

      const taskIds: string[] = []
      for (let index = 1; index <= 5; index += 1) {
        const task = store.createTask({
          projectRef: project.id,
          title: `Five-session task ${index}`,
          kind: "implement",
          reviewRequired: false,
          requestedAdapterType: "codex_local",
          laneId: "app-core",
          verificationCommands: []
        })
        taskIds.push(task.id)
      }

      const executor = new DispatcherExecutor!(store, {
        codex_local: fakeAdapter("codex_local", async (context) => {
          if (context.task.title.startsWith("Planner run")) {
            return {
              ok: true,
              response: JSON.stringify({
                version: 1,
                summary: "no additional planner work",
                candidates: []
              })
            }
          }
          return { ok: true, response: `completed ${context.task.title}` }
        })
      })
      const runtime = new DirectorRuntime!(store, executor)

      const report = await runtime.runQueueRefreshFullCycle(project.id, {
        profileId: "minimal-repo",
        maxPasses: 3,
        waitForLoops: true,
        waitTimeoutMs: 1_000,
        waitPollMs: 1
      })

      const codingRuns = report.runs.filter((run) => taskIds.includes(run.taskId))
      expect(report.stopReason).toBe("queue_drained")
      expect(codingRuns).toHaveLength(5)
      expect(codingRuns.map((run) => run.taskTitle).sort()).toEqual(
        Array.from({ length: 5 }, (_, index) => `Five-session task ${index + 1}`)
      )
      for (const run of codingRuns) {
        expect(run.runStatus).toBe("succeeded")
        expect(run.taskStatus).toBe("done")
        expect(run.loopStatus).toBe("ok")
        expect(run.lifecyclePhase).toBe("end")
        expect(run.streams).toEqual(["assistant", "lifecycle", "tool"])
        expect(run.assistantDeltas).toBeGreaterThan(0)
        expect(run.toolEvents).toBeGreaterThanOrEqual(2)
      }
      for (const taskId of taskIds) {
        expect(store.getTaskById(taskId).status).toBe("done")
      }
    } finally {
      store.close()
    }
  })

  it("syncs already merged GitHub promotion PRs back into local task state", async () => {
    const workspace = createTempWorkspace("core-runtime-gh-pr-sweep")
    cleanups.push(workspace.cleanup)
    const originalPath = process.env.PATH
    const originalGhLog = process.env.OPENCLAW_FAKE_GH_LOG
    const ghLog = `${workspace.root}/gh.log`
    createFakeGhScript(workspace.root, "merged")
    process.env.PATH = `${workspace.root}:${originalPath ?? ""}`
    process.env.OPENCLAW_FAKE_GH_LOG = ghLog

    const store = new DispatcherStore!(workspace.dbPath)
    store.migrate()
    try {
      const company = store.createCompany({ name: "OpenClaw Labs" })
      const project = store.createProject({
        companyRef: company.id,
        name: "lawyerrag-repo",
        repoPath: workspace.repoPath
      })
      const workflow = store.createWorkflow({
        projectRef: project.id,
        title: "Ship a reviewed task"
      })
      const implementationTask = store.createTask({
        projectRef: project.id,
        workflowId: workflow.id,
        title: "Add release-safe feature",
        kind: "implement"
      })
      const promoteTask = store.createTask({
        projectRef: project.id,
        workflowId: workflow.id,
        parentTaskId: implementationTask.id,
        title: "Promote release-safe feature",
        kind: "promote"
      })
      store.updateTaskStatus(implementationTask.id, "promotion_pending")
      store.updateTaskStatus(promoteTask.id, "blocked", {
        blockedReason: "waiting_for_pr_approval"
      })
      store.createPromotion({
        companyId: company.id,
        projectId: project.id,
        workflowId: workflow.id,
        taskId: implementationTask.id,
        branchName: "openclaw/run/release-safe-feature",
        prNumber: 17,
        prUrl: "https://example.test/pr/17",
        promotionStatus: "waiting_for_review"
      })

      const executor = new DispatcherExecutor!(store, {})
      const runtime = new DirectorRuntime!(store, executor)

      const result = await runtime.runJob(project.id, "github-pr-sweep", null)

      expect(result.resultSummary).toContain("merged=1")
      expect(store.getPromotionByTaskId(implementationTask.id)?.promotionStatus).toBe("merged")
      expect(store.getPromotionByTaskId(implementationTask.id)?.headSha).toBe("feedface")
      expect(store.getTaskById(implementationTask.id).status).toBe("done")
      expect(store.getTaskById(promoteTask.id).status).toBe("done")
      expect(store.getTaskEvents(implementationTask.id).some((event) => event.kind === "github-pr-sweep-merged")).toBe(
        true
      )
    } finally {
      store.close()
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
      if (originalGhLog === undefined) delete process.env.OPENCLAW_FAKE_GH_LOG
      else process.env.OPENCLAW_FAKE_GH_LOG = originalGhLog
    }
  })

  it("forces promotion-sweep job actions even when the scheduled job is not due", async () => {
    const { store, company, project, runtime } = setup()
    const implementationTask = store.createTask({
      projectRef: project.id,
      title: "Promote after direct review",
      kind: "implement"
    })
    const reviewTask = store.createTask({
      projectRef: project.id,
      parentTaskId: implementationTask.id,
      title: "Review: Promote after direct review",
      kind: "review"
    })
    store.updateTaskStatus(implementationTask.id, "promotion_pending")
    store.updateTaskStatus(reviewTask.id, "done")
    const implementationRun = store.createRun({
      companyId: company.id,
      projectId: project.id,
      taskId: implementationTask.id,
      adapterType: "codex_local",
      kind: "implement"
    })
    store.completeRun(implementationRun.id, {
      status: "succeeded",
      responseText: "implementation complete",
      verificationSummary: "tests passed"
    })
    const reviewerRun = store.createRun({
      companyId: company.id,
      projectId: project.id,
      taskId: reviewTask.id,
      adapterType: "codex_local",
      kind: "review"
    })
    store.completeRun(reviewerRun.id, {
      status: "succeeded",
      responseText: "review complete",
      verificationSummary: "tests passed"
    })
    reviewCompletedRun!(store, implementationRun.id, { reviewerRunId: reviewerRun.id })

    const result = await runtime.runJob(project.id, "promotion-sweep", "lawyerrag")

    expect(result.resultSummary).toBe("promoted 1 task")
    const promoteTask = store.listChildTasks(implementationTask.id, "promote")[0]!
    expect(promoteTask.status).toBe("queued")
    expect(promoteTask.dependsOnTaskIds).toEqual([reviewTask.id])

    store.close()
  })

  it("re-arms fresh execution-sweep jobs when the autonomous director dispatches queued work", async () => {
    const workspace = createTempWorkspace("core-runtime-autonomous-dispatch-rearm")
    cleanups.push(workspace.cleanup)
    const store = new DispatcherStore!(workspace.dbPath)
    store.migrate()
    const company = store.createCompany({ name: "OpenClaw Labs" })
    const project = store.createProject({
      companyRef: company.id,
      name: "lawyerrag-repo",
      repoPath: workspace.repoPath
    })
    store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Dispatch despite fresh cron"
    })
    const job = store.upsertJobSpec({
      companyId: company.id,
      projectId: project.id,
      jobId: "execution-sweep",
      sourcePath: ".openclaw/jobs/execution-sweep.json",
      cron: "*/45 * * * *",
      timezone: "UTC",
      entryAgent: "main"
    })
    store.updateJobSpecRuntime(job.id, {
      lastTriggeredAt: new Date().toISOString()
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async () => ({ ok: true, response: "done" }))
    })
    const runtime = new DirectorRuntime!(store, executor)

    const report = await runtime.runAutonomousCycle(project.id, {
      profileId: "lawyerrag",
      autonomous: true,
      maxPasses: 2,
      riskThreshold: 100
    })

    expect(report.decisions.map((decision) => decision.action)).toContain("dispatch_task")
    expect(store.getTaskById(task.id).status).toBe("done")

    store.close()
  })

  it("backs up, resets, prunes duplicates, and recovers stale runs", () => {
    const { store, company, project } = setup()

    const workflowA = store.createWorkflow({ projectRef: project.id, title: "Duplicate lane work" })
    const workflowB = store.createWorkflow({ projectRef: project.id, title: "Duplicate lane work" })
    store.createTask({ projectRef: project.id, workflowId: workflowA.id, title: "Old queued task" })
    store.createTask({ projectRef: project.id, workflowId: workflowB.id, title: "New queued task" })

    const duplicateResult = pruneDuplicateQueuedWorkflows!(store)
    expect(duplicateResult.duplicateWorkflowsRecovered).toBe(1)
    expect(duplicateResult.duplicateTasksRecovered).toBe(1)
    expect(store.listWorkflows().filter((entry) => entry.status === "failed")).toHaveLength(1)
    expect(
      store.listTasks().filter((entry) => entry.lastRecoveryReason === "duplicate_workflow_recovered")
    ).toHaveLength(1)

    const agent = store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const task = store.createTask({ projectRef: project.id, title: "Recover me" })
    store.claimTask(task.id)
    const run = store.createRun({
      companyId: company.id,
      projectId: project.id,
      taskId: task.id,
      agentId: agent.id,
      adapterType: "codex_local",
      sessionKey: `${agent.id}:${project.id}:${task.id}`,
      wakeReason: "execution-sweep"
    })
    const plannerRun = store.createPlannerRun({
      companyId: company.id,
      projectId: project.id,
      trigger: "queue_refresh",
      plannerAgentId: agent.id,
      adapterType: "codex_local"
    })

    expect(store.listRunningRuns().map((entry) => entry.id)).toContain(run.id)
    expect(store.listRunningPlannerRuns(project.id).map((entry) => entry.id)).toContain(plannerRun.id)
    store.setAgentStatus(agent.id, "running")

    ;(store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db
      .prepare("UPDATE runs SET started_at = ?, created_at = ?, updated_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z", run.id)
    ;(store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db
      .prepare("UPDATE planner_runs SET started_at = ?, created_at = ?, updated_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z", plannerRun.id)

    const staleResult = recoverStaleRuns!(store)
    expect(staleResult.recoveredRuns).toBe(1)
    expect(store.getTaskById(task.id).status).toBe("queued")
    expect(store.getTaskById(task.id).claimStatus).toBe("expired")
    expect(store.getTaskById(task.id).lastRecoveryReason).toBe("maintenance_stale_run_recovery")
    expect(store.getAgentById(agent.id).status).toBe("idle")
    expect(store.getPlannerRunById(plannerRun.id).status).toBe("failed")
    expect(store.getPlannerRunById(plannerRun.id).errorText).toContain("planner run exceeded stale threshold")

    const backupPath = backupRuntimeState!(store)
    expect(backupPath).toContain(".backup-")

    const resetResult = resetRuntimeState!(store)
    expect(resetResult.backupPath).toContain(".backup-")
    expect(store.listTasks()).toHaveLength(0)
    expect(store.listWorkflows()).toHaveLength(0)

    store.close()
  })

  it("keeps a shared agent running when another active run survives stale recovery", () => {
    const { store, company, project } = setup()
    const agent = store.createAgent({
      companyRef: company.id,
      name: "shared-codex",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const staleTask = store.createTask({ projectRef: project.id, title: "Recover stale work" })
    const activeTask = store.createTask({ projectRef: project.id, title: "Keep active work running" })
    store.claimTask(staleTask.id)
    store.claimTask(activeTask.id)
    const staleRun = store.createRun({
      companyId: company.id,
      projectId: project.id,
      taskId: staleTask.id,
      agentId: agent.id,
      adapterType: "codex_local",
      sessionKey: `${agent.id}:${project.id}:${staleTask.id}`,
      wakeReason: "execution-sweep"
    })
    const activeRun = store.createRun({
      companyId: company.id,
      projectId: project.id,
      taskId: activeTask.id,
      agentId: agent.id,
      adapterType: "codex_local",
      sessionKey: `${agent.id}:${project.id}:${activeTask.id}`,
      wakeReason: "execution-sweep"
    })
    store.setAgentStatus(agent.id, "running")

    ;(store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db
      .prepare("UPDATE runs SET started_at = ?, created_at = ?, updated_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z", staleRun.id)

    const result = recoverStaleRuns!(store)

    expect(result.recoveredRuns).toBe(1)
    expect(store.getRunById(staleRun.id).status).toBe("failed")
    expect(store.getRunById(activeRun.id).status).toBe("running")
    expect(store.getTaskById(staleTask.id).status).toBe("queued")
    expect(store.getTaskById(activeTask.id).status).toBe("running")
    expect(store.getAgentById(agent.id).status).toBe("running")

    store.close()
  })

  it("archives historical blockers without deleting audit history or active dependencies", () => {
    const { store, project, executor } = setup()
    const oldBlocked = store.createTask({
      projectRef: project.id,
      title: "Old terminal blocker",
      kind: "implement",
      reviewRequired: true
    })
    const activeParent = store.createTask({ projectRef: project.id, title: "Old blocker with active dependent" })
    const recentBlocked = store.createTask({ projectRef: project.id, title: "Recent blocker" })
    store.updateTaskStatus(oldBlocked.id, "blocked", { blockedReason: "verification_failure:old" })
    store.updateTaskStatus(activeParent.id, "blocked", { blockedReason: "verification_failure:parent" })
    store.updateTaskStatus(recentBlocked.id, "blocked", { blockedReason: "verification_failure:recent" })
    const failedReview = store.createTask({
      projectRef: project.id,
      title: "Review: Old terminal blocker",
      kind: "review",
      parentTaskId: oldBlocked.id
    })
    store.updateTaskStatus(failedReview.id, "blocked", { lastError: "historical review failure" })
    store.createTask({
      projectRef: project.id,
      title: "Active repair",
      parentTaskId: activeParent.id,
      dependsOnTaskIds: [activeParent.id]
    })
    store.db
      .prepare("UPDATE tasks SET updated_at = ? WHERE id IN (?, ?)")
      .run("2026-04-01T00:00:00.000Z", oldBlocked.id, activeParent.id)

    const dryRun = archiveHistoricalBlockedTasks!(store, {
      projectId: project.id,
      olderThanHours: 24,
      at: "2026-04-11T09:00:00.000Z",
      dryRun: true
    })
    expect(dryRun.candidateTaskIds).toEqual([oldBlocked.id])
    expect(dryRun.skippedActiveTaskIds).toEqual([activeParent.id])
    expect(store.getTaskById(oldBlocked.id).status).toBe("blocked")

    const applied = archiveHistoricalBlockedTasks!(store, {
      projectId: project.id,
      olderThanHours: 24,
      at: "2026-04-11T09:00:00.000Z"
    })
    expect(applied.archivedTaskIds).toEqual([oldBlocked.id])
    expect(store.getTaskById(oldBlocked.id)).toMatchObject({
      status: "failed",
      blockedReason: "verification_failure:old",
      lastRecoveryReason: "historical_blocker_archived"
    })
    const archivedDescendant = archiveHistoricalBlockedTasks!(store, {
      projectId: project.id,
      olderThanHours: 24,
      at: "2026-04-11T09:00:00.500Z"
    })
    expect(archivedDescendant.archivedTaskIds).toEqual([failedReview.id])
    expect(store.getTaskEvents(oldBlocked.id).map((event) => event.kind)).toContain("historical-blocker-archived")
    executor.runReviewSweep(project.id)
    expect(store.getTaskById(oldBlocked.id).status).toBe("failed")
    store.updateTaskStatus(oldBlocked.id, "blocked", { blockedReason: "review_failed:resurrected" })
    const rearchived = archiveHistoricalBlockedTasks!(store, {
      projectId: project.id,
      olderThanHours: 24,
      at: "2026-04-11T09:00:01.000Z"
    })
    expect(rearchived.archivedTaskIds).toEqual([oldBlocked.id])
    expect(store.getTaskById(oldBlocked.id).status).toBe("failed")
    expect(store.getTaskById(activeParent.id).status).toBe("blocked")
    expect(store.getTaskById(recentBlocked.id).status).toBe("blocked")

    store.close()
  })

  it("diagnoses and repairs planner lineage partial failures and zombie agents", () => {
    const { store, company, project } = setup()

    const plannerAgent = store.createAgent({
      companyRef: company.id,
      name: "planner",
      role: "Planner",
      adapterType: "codex_local"
    })
    store.setAgentStatus(plannerAgent.id, "running")

    const zombieAgent = store.createAgent({
      companyRef: company.id,
      name: "zombie-runner",
      role: "Engineer",
      adapterType: "codex_local"
    })
    store.setAgentStatus(zombieAgent.id, "running")

    const plannerRun = store.createPlannerRun({
      companyId: company.id,
      projectId: project.id,
      automationId: "queue-refresh",
      trigger: "automation",
      plannerAgentId: plannerAgent.id,
      adapterType: "codex_local",
      status: "running",
      summaryJson: {
        createdTaskIds: ["task-1"],
        skippedCandidates: 0,
        blockedCandidates: 0,
        deferred: false
      },
      outputJson: {
        version: 1,
        summary: "partial planner completion",
        candidates: []
      }
    })

    const staleTask = store.createTask({ projectRef: project.id, title: "Recover me too" })
    store.claimTask(staleTask.id)
    const staleRun = store.createRun({
      companyId: company.id,
      projectId: project.id,
      taskId: staleTask.id,
      agentId: plannerAgent.id,
      adapterType: "codex_local",
      sessionKey: `${plannerAgent.id}:${project.id}:${staleTask.id}`,
      wakeReason: "execution-sweep"
    })
    ;(store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db
      .prepare("UPDATE runs SET started_at = ?, created_at = ?, updated_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z", staleRun.id)

    const diagnosis = diagnoseQueueHealth!(store, {
      companyId: company.id,
      projectId: project.id
    })
    expect(diagnosis.counts.staleRuns).toBe(1)
    expect(diagnosis.counts.repairedPlannerLineages).toBe(1)
    expect(diagnosis.counts.zombieAgents).toBe(1)

    const repaired = repairQueueHealth!(store, {
      companyId: company.id,
      projectId: project.id
    })
    expect(repaired.repaired).toBe(3)
    expect(store.getPlannerRunById(plannerRun.id).status).toBe("succeeded")
    expect(store.getAgentById(zombieAgent.id).status).toBe("idle")
    expect(store.getTaskById(staleTask.id).status).toBe("queued")

    store.close()
  })

  it("repairs a fresh run immediately when its recorded dispatcher owner exited", () => {
    const { store, company, project } = setup()
    const task = store.createTask({ projectRef: project.id, title: "Recover dead owner" })
    store.claimTask(task.id)
    const run = store.createRun({
      companyId: company.id,
      projectId: project.id,
      taskId: task.id,
      kind: "promote"
    })
    store.appendRunEvent(run.id, "info", "agent.loop.lifecycle.start", {
      agentLoop: {
        version: 1,
        runId: run.id,
        stream: "lifecycle",
        emittedAt: new Date().toISOString(),
        phase: "start",
        payload: { ownerPid: 9_999_999 }
      }
    })

    const diagnosis = diagnoseQueueHealth!(store, {
      companyId: company.id,
      projectId: project.id
    })
    expect(diagnosis.counts.staleRuns).toBe(1)
    expect(diagnosis.actions[0]?.detail).toContain("owner process 9999999 exited")

    repairQueueHealth!(store, {
      companyId: company.id,
      projectId: project.id
    })
    expect(store.getRunById(run.id).status).toBe("failed")
    expect(store.getTaskById(task.id).status).toBe("queued")

    store.close()
  })

  it("does not diagnose a long-running adapter as stale while it emits heartbeats", () => {
    const { store, company, project } = setup()
    const task = store.createTask({ projectRef: project.id, title: "Keep active adapter work" })
    store.claimTask(task.id)
    const run = store.createRun({
      companyId: company.id,
      projectId: project.id,
      taskId: task.id,
      kind: "implement"
    })
    ;(store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db
      .prepare("UPDATE runs SET started_at = ?, created_at = ?, updated_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z", run.id)
    store.appendRunEvent(run.id, "info", "Adapter execution heartbeat", {
      elapsedMs: 31 * 60 * 1000,
      heartbeatCount: 15
    })

    const diagnosis = diagnoseQueueHealth!(store, {
      companyId: company.id,
      projectId: project.id,
      at: new Date(Date.now() + 60_000).toISOString()
    })

    expect(diagnosis.counts.staleRuns).toBe(0)
    expect(diagnosis.actions.some((action) => action.runId === run.id)).toBe(false)
    expect(store.getRunById(run.id).status).toBe("running")

    store.close()
  })

  it("builds a dry-run Telegram digest preview without configured credentials", async () => {
    const { store, company, project, runtime } = setup()

    const agent = store.createAgent({
      companyRef: company.id,
      name: "gemini-ui",
      role: "UI Engineer",
      adapterType: "gemini_local",
      model: "gemini-2.5-pro",
      budgetLimit: 10,
      budgetWindow: "daily"
    })
    store.recordBudgetUsage(company.id, agent.id, "daily", 8, "2026-04-11T06:00:00.000Z")

    const completedTask = store.createTask({ projectRef: project.id, title: "Completed task" })
    store.updateTaskStatus(completedTask.id, "done")

    const failedTask = store.createTask({ projectRef: project.id, title: "Failed task" })
    store.updateTaskStatus(failedTask.id, "failed", { lastError: "Verification failed" })

    const queuedTask = store.createTask({ projectRef: project.id, title: "Queued task" })
    store.appendTaskEvent(queuedTask.id, "stale-run-reaped", "Recovered stale task.")

    const digest = await runtime.sendDigest(project.id, {
      kind: "daily",
      dryRun: true
    })

    expect(digest.delivery).toBe("dry-run")
    expect(digest.resultSummary).toBe("daily digest preview generated")
    expect(digest.message).toContain("OpenClaw daily digest")
    expect(digest.message).toContain("Done 1")
    expect(digest.message).toContain("Failed 1")
    expect(digest.message).toContain("Pressure:")
    expect(digest.message).toContain("Recoveries: stale runs reaped x1")

    store.close()
  })

  it("routes Telegram delivery through the configured OpenClaw channel when no raw bot token is exposed", async () => {
    const { store, project } = setup()
    const previousTarget = process.env.OPENCLAW_FEEDBACK_TARGET
    const previousToken = process.env.OPENCLAW_TELEGRAM_BOT_TOKEN
    process.env.OPENCLAW_FEEDBACK_TARGET = "test-chat"
    delete process.env.OPENCLAW_TELEGRAM_BOT_TOKEN
    cleanups.push(() => {
      if (previousTarget === undefined) delete process.env.OPENCLAW_FEEDBACK_TARGET
      else process.env.OPENCLAW_FEEDBACK_TARGET = previousTarget
      if (previousToken === undefined) delete process.env.OPENCLAW_TELEGRAM_BOT_TOKEN
      else process.env.OPENCLAW_TELEGRAM_BOT_TOKEN = previousToken
    })

    const calls: Array<{ command: string; args: string[] }> = []
    const digest = await sendTelegramDigest!({
      store,
      projectRef: project.id,
      profile: loadProjectProfile("lawyerrag"),
      kind: "daily",
      openClawExecImpl: async (command, args) => {
        calls.push({ command, args })
        return { stdout: '{"ok":true}' }
      }
    })

    expect(digest.delivery).toBe("sent")
    expect(digest.resultSummary).toBe("daily digest sent to Telegram")
    expect(calls).toHaveLength(1)
    expect(calls[0]?.command).toBe("openclaw")
    expect(calls[0]?.args).toEqual(
      expect.arrayContaining(["message", "send", "--channel", "telegram", "--target", "test-chat", "--json"])
    )
    store.close()
  })

  it("records auditable dry-run director decisions without mutating queue state", async () => {
    const { store, project, runtime } = setup()

    const report = await runtime.runAutonomousCycle(project.id, {
      profileId: "lawyerrag",
      dryRun: true,
      maxPasses: 3
    })

    expect(report.dryRun).toBe(true)
    expect(report.passes).toBe(1)
    expect(report.stopReason).toBe("no_progress")
    expect(report.decisions).toHaveLength(1)
    expect(report.decisions[0]?.action).toBe("create_tasks")
    expect(report.decisions[0]?.status).toBe("skipped")
    expect(store.listProjectTasks(project.id)).toHaveLength(0)

    const latest = store.getLatestDirectorDecision(project.id)
    expect(latest?.cycleId).toBe(report.cycleId)
    expect(latest?.dryRun).toBe(true)
    expect(latest?.reason).toContain("queue is drained")

    store.close()
  })

  it("pauses the director when risk crosses the configured threshold", async () => {
    const { store, company, project, runtime } = setup()
    const agent = store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Risky queued task"
    })
    const run = store.createRun({
      companyId: company.id,
      projectId: project.id,
      taskId: task.id,
      agentId: agent.id,
      adapterType: "codex_local"
    })
    store.completeRun(run.id, {
      status: "failed",
      errorText: "Verification failed",
      retryClass: "verification",
      verificationSummary: "verification failed"
    })

    const report = await runtime.runAutonomousCycle(project.id, {
      profileId: "lawyerrag",
      riskThreshold: 10,
      maxPasses: 3
    })

    expect(report.stopReason).toBe("risk_threshold_exceeded")
    expect(report.decisions).toHaveLength(1)
    expect(report.decisions[0]?.action).toBe("pause_due_to_risk")
    expect(report.decisions[0]?.status).toBe("blocked")
    expect(report.incidentNotification).not.toBeNull()
    expect(["dry-run", "failed-soft", "sent", "skipped"]).toContain(report.incidentNotification?.delivery)
    expect(store.getTaskById(task.id).status).toBe("queued")

    store.close()
  })
})
