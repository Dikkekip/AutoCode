import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { loadProjectProfile } from "@openclaw/project-profiles"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createFakeCodexScript, createFakeGeminiScript, createFakeGhScript, createTempWorkspace } from "./helpers.js"
import { HAS_NODE_SQLITE } from "./node-sqlite.js"

let DispatcherStore: typeof import("@openclaw/db").DispatcherStore | null = null
let runCli: typeof import("../apps/dispatcher-cli/src/index.js").runCli | null = null
if (HAS_NODE_SQLITE) {
  ;({ DispatcherStore } = await import("@openclaw/db"))
  ;({ runCli } = await import("../apps/dispatcher-cli/src/index.js"))
}

const describeDb = HAS_NODE_SQLITE ? describe : describe.skip

describeDb("dispatcher CLI smoke flow", () => {
  const cleanups: Array<() => void> = []

  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.()
  })

  it("boots the control plane and processes a task end-to-end", async () => {
    const previousCompressionOverride = process.env.OPENCLAW_RESPONSE_COMPRESSION_OVERRIDE
    const workspace = createTempWorkspace("dispatcher-cli")
    cleanups.push(workspace.cleanup)
    const codexScript = createFakeCodexScript(workspace.root)
    const geminiScript = createFakeGeminiScript(workspace.root)
    const output: string[] = []
    const io = {
      stdout: (message: string) => output.push(message),
      stderr: (message: string) => output.push(message)
    }

    await runCli!(["--db", workspace.dbPath, "init"], io)
    await runCli!(["--db", workspace.dbPath, "company", "create", "OpenClaw Labs"], io)
    await runCli!(["--db", workspace.dbPath, "project", "add", "repo", "--repo-path", workspace.repoPath], io)
    await runCli!(
      [
        "--db",
        workspace.dbPath,
        "agent",
        "add",
        "codex",
        "--role",
        "Engineer",
        "--adapter",
        "codex_local",
        "--command",
        codexScript
      ],
      io
    )
    await runCli!(
      [
        "--db",
        workspace.dbPath,
        "agent",
        "add",
        "gemini-ui",
        "--role",
        "UI Engineer",
        "--adapter",
        "gemini_local",
        "--command",
        geminiScript
      ],
      io
    )
    await runCli!(
      ["--db", workspace.dbPath, "task", "create", "Polish the landing page", "--project", "repo", "--label", "ui"],
      io
    )
    await runCli!(["--db", workspace.dbPath, "tick", "--caveman", "ultra"], io)
    await runCli!(["--db", workspace.dbPath, "run", "list"], io)
    await runCli!(["--db", workspace.dbPath, "budget", "status"], io)
    await runCli!(["--db", workspace.dbPath, "diagnostics", "manifest", "--project", "repo", "--session", "smoke"], io)

    const fullOutput = output.join("\n")
    expect(fullOutput).toContain("Dispatcher initialized.")
    expect(fullOutput).toContain("Created company OpenClaw Labs")
    expect(fullOutput).toContain("Tick complete.")
    expect(fullOutput).toContain("gemini_local")
    expect(fullOutput).toContain("gemini-ui")
    expect(fullOutput).toContain('"bundleName": "diagnostics_smoke_')
    expect(fullOutput).toContain('"sensitivePaths"')
    const reopened = new DispatcherStore!(workspace.dbPath)
    expect(reopened.listRuns()[0]?.metadata.responseCompression).toMatchObject({
      mode: "ultra",
      source: "cli_override"
    })
    reopened.close()
    expect(process.env.OPENCLAW_RESPONSE_COMPRESSION_OVERRIDE).toBe(previousCompressionOverride)
  })

  it("shows the verification outcome in the recent run list", async () => {
    const workspace = createTempWorkspace("dispatcher-cli-run-list")
    cleanups.push(workspace.cleanup)
    const output: string[] = []
    const io = {
      stdout: (message: string) => output.push(message),
      stderr: (message: string) => output.push(message)
    }
    const store = new DispatcherStore!(workspace.dbPath)
    store.migrate()
    const company = store.createCompany({ name: "Run List Co" })
    const project = store.createProject({
      companyRef: company.id,
      name: "repo",
      repoPath: workspace.repoPath
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Surface autonomous blockers"
    })
    const run = store.createRun({
      companyId: company.id,
      projectId: project.id,
      taskId: task.id,
      adapterType: "codex_local"
    })
    store.completeRun(run.id, {
      status: "succeeded",
      verificationSummary: "autonomous-blocked"
    })
    store.close()

    await runCli!(["--db", workspace.dbPath, "run", "list"], io)

    expect(output.join("\n")).toContain(`${run.id} | succeeded`)
    expect(output.join("\n")).toContain("verification=autonomous-blocked")
  })

  it("shows durable team assignments and active artifact claims", async () => {
    const workspace = createTempWorkspace("dispatcher-cli-team")
    cleanups.push(workspace.cleanup)
    const output: string[] = []
    const io = {
      stdout: (message: string) => output.push(message),
      stderr: (message: string) => output.push(message)
    }
    const store = new DispatcherStore!(workspace.dbPath)
    store.migrate()
    const company = store.createCompany({ name: "OpenClaw Labs" })
    const project = store.createProject({
      companyRef: company.id,
      name: "repo",
      repoPath: workspace.repoPath
    })
    const agent = store.createAgent({
      companyRef: company.id,
      name: "codex-backend",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const reviewer = store.createAgent({
      companyRef: company.id,
      name: "reviewer",
      role: "Reviewer",
      adapterType: "codex_local"
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Own queue implementation",
      changedFiles: ["packages/executor/src/runner.ts"]
    })
    const started = store.startRunWithClaim({
      companyId: company.id,
      projectId: project.id,
      taskId: task.id,
      agentId: agent.id,
      adapterType: agent.adapterType,
      teamAssignment: {
        artifactPaths: task.changedFiles,
        routingReason: "executor ownership"
      }
    })
    const lockouts = store.createTeamReviewerLockouts({
      companyId: company.id,
      projectId: project.id,
      taskId: task.id,
      sourceTaskId: task.id,
      sourceRunId: started!.run.id,
      sourceAssignmentId: started!.assignment!.id,
      lockedAgentId: agent.id,
      reviewerAgentId: reviewer.id,
      reviewerActor: reviewer.name,
      artifactPaths: task.changedFiles,
      reason: "Independent revision required."
    })
    const blockerMessage = store.listTeamMessages({ toAgentId: agent.id })[0]!
    store.close()

    await runCli!(["--db", workspace.dbPath, "team", "assignments", "--project", "repo", "--status", "active"], io)
    await runCli!(["--db", workspace.dbPath, "team", "claims", "--project", "repo"], io)
    await runCli!(["--db", workspace.dbPath, "team", "lockouts", "--project", "repo"], io)
    await runCli!(["--db", workspace.dbPath, "team", "inbox", "--agent", agent.id], io)
    await runCli!(["--db", workspace.dbPath, "team", "acknowledge", blockerMessage.id, "--agent", agent.id], io)
    await runCli!(["--db", workspace.dbPath, "status", "--company", company.id], io)

    const fullOutput = output.join("\n")
    expect(fullOutput).toContain("codex-backend")
    expect(fullOutput).toContain("Own queue implementation")
    expect(fullOutput).toContain("packages/executor/src/runner.ts")
    expect(fullOutput).toContain("active_team_assignments: 1")
    expect(fullOutput).toContain("active_artifact_claims: 1")
    expect(fullOutput).toContain("active_reviewer_lockouts: 1")
    expect(fullOutput).toContain("Reviewer lockout")
    expect(fullOutput).toContain(`Acknowledged team message ${blockerMessage.id}`)
    expect(lockouts[0]?.threadId).toBeTruthy()
  })

  it("bounds status history to the most recently updated tasks", async () => {
    const workspace = createTempWorkspace("dispatcher-cli-status-limit")
    cleanups.push(workspace.cleanup)
    const output: string[] = []
    const io = {
      stdout: (message: string) => output.push(message),
      stderr: (message: string) => output.push(message)
    }
    const store = new DispatcherStore!(workspace.dbPath)
    store.migrate()
    const company = store.createCompany({ name: "Status Limit Co" })
    const project = store.createProject({
      companyRef: company.id,
      name: "repo",
      repoPath: workspace.repoPath
    })
    const titles = ["oldest task", "middle task", "newest task"]
    for (const title of titles) {
      store.createTask({ projectRef: project.id, title })
    }
    store.close()

    await runCli!(["--db", workspace.dbPath, "status", "--limit", "2"], io)

    const fullOutput = output.join("\n")
    expect(fullOutput).toContain("Tasks by stage (showing 2 of 3 recent):")
    expect(fullOutput).toContain("newest task")
    expect(fullOutput).toContain("middle task")
    expect(fullOutput).not.toContain("oldest task")
  })

  it("drains repeated state transitions until terminal promotion state in autonomous tick mode", async () => {
    const workspace = createTempWorkspace("dispatcher-cli-autonomous")
    cleanups.push(workspace.cleanup)
    const originalPath = process.env.PATH
    createFakeGhScript(workspace.root, "merge")
    process.env.PATH = `${workspace.root}:${originalPath ?? ""}`
    cleanups.push(() => {
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
    })
    execFileSync("git", ["init"], { cwd: workspace.repoPath })
    execFileSync("git", ["config", "user.email", "openclaw@example.test"], { cwd: workspace.repoPath })
    execFileSync("git", ["config", "user.name", "OpenClaw"], { cwd: workspace.repoPath })
    execFileSync("git", ["add", "README.md"], { cwd: workspace.repoPath })
    execFileSync("git", ["commit", "-m", "init"], { cwd: workspace.repoPath })
    const originPath = join(workspace.root, "origin.git")
    execFileSync("git", ["init", "--bare", originPath])
    execFileSync("git", ["remote", "add", "origin", originPath], { cwd: workspace.repoPath })
    execFileSync("git", ["push", "-u", "origin", "HEAD:main"], { cwd: workspace.repoPath })
    mkdirSync(join(workspace.repoPath, ".openclaw"), { recursive: true })
    writeFileSync(
      join(workspace.repoPath, ".openclaw", "profile.json"),
      JSON.stringify({
        ...loadProjectProfile("minimal-repo"),
        promotionPolicy: {
          ...loadProjectProfile("minimal-repo").promotionPolicy,
          autoMerge: true,
          mergeMethod: "squash",
          requireCi: true,
          requireReviewDecision: "approved"
        }
      }),
      "utf8"
    )

    const codexScript = createFakeCodexScript(workspace.root)
    const output: string[] = []
    const io = {
      stdout: (message: string) => output.push(message),
      stderr: (message: string) => output.push(message)
    }

    const store = new DispatcherStore!(workspace.dbPath)
    store.migrate()
    const company = store.createCompany({ name: "OpenClaw Labs" })
    const project = store.createProject({
      companyRef: company.id,
      name: "repo",
      repoPath: workspace.repoPath
    })
    store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local",
      command: codexScript
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Needs autonomous follow-through",
      kind: "implement",
      reviewRequired: true
    })
    const implementationBranch = "openclaw/run/autonomous-follow-through"
    execFileSync("git", ["switch", "-c", implementationBranch], { cwd: workspace.repoPath })
    writeFileSync(join(workspace.repoPath, "autonomous-change.txt"), "autonomous change\n", "utf8")
    execFileSync("git", ["add", "autonomous-change.txt"], { cwd: workspace.repoPath })
    execFileSync("git", ["commit", "-m", "test: autonomous implementation"], { cwd: workspace.repoPath })
    const implementationHead = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: workspace.repoPath,
      encoding: "utf8"
    }).trim()
    execFileSync("git", ["switch", "master"], { cwd: workspace.repoPath })
    const implementationRun = store.createRun({
      companyId: company.id,
      projectId: project.id,
      taskId: task.id,
      agentId: store.listAgents(company.id)[0]?.id ?? null,
      adapterType: "codex_local",
      kind: "implement"
    })
    store.completeRun(implementationRun.id, {
      status: "succeeded",
      responseText: "Implemented the autonomous test change.",
      branchName: implementationBranch,
      headSha: implementationHead,
      verificationSummary: "1 test passed"
    })
    store.updateTaskStatus(task.id, "review_needed", {
      assignedAgentId: store.listAgents(company.id)[0]?.id ?? null,
      lastError: null
    })
    const overdue = new Date(Date.now() - 60_000).toISOString()
    for (const jobId of ["execution-sweep", "review-sweep", "promotion-sweep"] as const) {
      const job = store.upsertJobSpec({
        companyId: company.id,
        projectId: project.id,
        jobId,
        sourcePath: `.openclaw/jobs/${jobId}.json`,
        cron: "* * * * *",
        timezone: "UTC",
        entryAgent: "main"
      })
      store.updateJobSpecRuntime(job.id, {
        lastTriggeredAt: overdue
      })
    }
    store.close()

    await runCli!(["--db", workspace.dbPath, "tick", "--company", company.id, "--autonomous", "--max-passes", "8"], io)

    const reopened = new DispatcherStore!(workspace.dbPath)
    const finalTask = reopened.getTaskById(task.id)
    const tasks = reopened.listTasks()
    const taskEvents = reopened.getTaskEvents(task.id)
    reopened.close()

    const fullOutput = output.join("\n")
    expect(fullOutput).toContain("autonomous.pass=1")
    expect(fullOutput).toContain("Autonomous tick complete.")
    expect(finalTask.status, JSON.stringify({ tasks, taskEvents }, null, 2)).toBe("done")
    const promoteTasks = tasks.filter((entry) => entry.kind === "promote")
    expect(promoteTasks).toHaveLength(1)
    expect(promoteTasks[0]?.status).toBe("done")
    expect(taskEvents.some((event) => event.kind === "promote-child-blocked")).toBe(false)
  })

  it("prints structured queue-refresh full-cycle JSON", async () => {
    const workspace = createTempWorkspace("dispatcher-cli-full-cycle-json")
    cleanups.push(workspace.cleanup)
    const codexScript = createFakeCodexScript(workspace.root)
    writeFileSync(
      join(workspace.repoPath, "package.json"),
      JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }, null, 2),
      "utf8"
    )
    const output: string[] = []
    const io = {
      stdout: (message: string) => output.push(message),
      stderr: (message: string) => output.push(message)
    }

    const store = new DispatcherStore!(workspace.dbPath)
    store.migrate()
    const company = store.createCompany({ name: "OpenClaw Labs" })
    store.createProject({
      companyRef: company.id,
      name: "repo",
      repoPath: workspace.repoPath
    })
    store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local",
      command: codexScript
    })
    store.close()

    await runCli!(
      [
        "--db",
        workspace.dbPath,
        "queue-refresh",
        "run",
        "--project",
        "repo",
        "--profile",
        "minimal-repo",
        "--full-cycle",
        "--wait",
        "--max-passes",
        "1",
        "--json"
      ],
      io
    )

    const report = JSON.parse(output.join("")) as {
      stopReason: string
      queueRefresh: { profileId: string }
      passes: unknown[]
      runs: Array<{ loopStatus: string; lifecyclePhase: string | null }>
    }
    expect(report.queueRefresh.profileId).toBe("minimal-repo")
    expect(report.passes).toHaveLength(1)
    expect(report.runs.some((run) => run.loopStatus === "ok" && run.lifecyclePhase === "end")).toBe(true)
    expect(["queue_drained", "pass_limit_reached", "no_progress"]).toContain(report.stopReason)
  }, 15_000)

  it("re-arms fresh execution jobs before stopping autonomous tick mode", async () => {
    const workspace = createTempWorkspace("dispatcher-cli-autonomous-rearm")
    cleanups.push(workspace.cleanup)
    execFileSync("git", ["init"], { cwd: workspace.repoPath })
    execFileSync("git", ["config", "user.email", "openclaw@example.test"], { cwd: workspace.repoPath })
    execFileSync("git", ["config", "user.name", "OpenClaw"], { cwd: workspace.repoPath })
    execFileSync("git", ["add", "README.md"], { cwd: workspace.repoPath })
    execFileSync("git", ["commit", "-m", "init"], { cwd: workspace.repoPath })

    const codexScript = createFakeCodexScript(workspace.root)
    const output: string[] = []
    const io = {
      stdout: (message: string) => output.push(message),
      stderr: (message: string) => output.push(message)
    }

    const store = new DispatcherStore!(workspace.dbPath)
    store.migrate()
    const company = store.createCompany({ name: "OpenClaw Labs" })
    const project = store.createProject({
      companyRef: company.id,
      name: "repo",
      repoPath: workspace.repoPath
    })
    store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local",
      command: codexScript
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Queued behind fresh schedule"
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
    store.close()

    await runCli!(["--db", workspace.dbPath, "tick", "--company", company.id, "--autonomous", "--max-passes", "2"], io)

    const reopened = new DispatcherStore!(workspace.dbPath)
    const finalTask = reopened.getTaskById(task.id)
    reopened.close()

    const fullOutput = output.join("\n")
    expect(fullOutput).toContain("autonomous.rearmed_jobs=1")
    expect(finalTask.status).toBe("done")
  })

  it("does not re-arm a transition job that just ran without task progress", async () => {
    const workspace = createTempWorkspace("dispatcher-cli-autonomous-stall")
    cleanups.push(workspace.cleanup)
    const output: string[] = []
    const io = {
      stdout: (message: string) => output.push(message),
      stderr: (message: string) => output.push(message)
    }

    const store = new DispatcherStore!(workspace.dbPath)
    store.migrate()
    const company = store.createCompany({ name: "OpenClaw Labs" })
    const project = store.createProject({
      companyRef: company.id,
      name: "repo",
      repoPath: workspace.repoPath
    })
    store.createAgent({
      companyRef: company.id,
      name: "paused-codex",
      role: "Engineer",
      adapterType: "codex_local",
      status: "paused"
    })
    store.createTask({ projectRef: project.id, title: "Cannot dispatch without an agent" })
    const job = store.upsertJobSpec({
      companyId: company.id,
      projectId: project.id,
      jobId: "execution-sweep",
      sourcePath: ".openclaw/jobs/execution-sweep.json",
      cron: "* * * * *",
      timezone: "UTC",
      entryAgent: "main"
    })
    store.updateJobSpecRuntime(job.id, { lastTriggeredAt: new Date(Date.now() - 120_000).toISOString() })
    store.close()

    await runCli!(["--db", workspace.dbPath, "tick", "--company", company.id, "--autonomous", "--max-passes", "5"], io)

    const fullOutput = output.join("\n")
    expect(fullOutput).toContain("autonomous.pass=1")
    expect(fullOutput).not.toContain("autonomous.pass=2")
    expect(fullOutput).not.toContain("autonomous.rearmed_jobs")
    expect(fullOutput).toContain("stop_reason=no_progress")
  })

  it("reports queue health repairs in dry-run mode", async () => {
    const workspace = createTempWorkspace("dispatcher-cli-health")
    cleanups.push(workspace.cleanup)
    const output: string[] = []
    const io = {
      stdout: (message: string) => output.push(message),
      stderr: (message: string) => output.push(message)
    }

    const store = new DispatcherStore!(workspace.dbPath)
    store.migrate()
    const company = store.createCompany({ name: "OpenClaw Labs" })
    const project = store.createProject({
      companyRef: company.id,
      name: "repo",
      repoPath: workspace.repoPath
    })
    const zombieAgent = store.createAgent({
      companyRef: company.id,
      name: "zombie-agent",
      role: "Engineer",
      adapterType: "codex_local"
    })
    store.setAgentStatus(zombieAgent.id, "running")
    const task = store.createTask({
      projectRef: project.id,
      title: "Expired lease task"
    })
    store.claimTask(task.id)
    store.updateTask(task.id, {
      claimExpiresAt: "2000-01-01T00:00:00.000Z"
    })
    store.close()

    await runCli!(["--db", workspace.dbPath, "state", "diagnose-queue-health", "--project", "repo"], io)

    const fullOutput = output.join("\n")
    expect(fullOutput).toContain("queue_health.detected=")
    expect(fullOutput).toContain("claim_timeout")
    expect(fullOutput).toContain("zombie_agent_released")
  })

  it("keeps director dry-run from executing planner or queue work", async () => {
    const workspace = createTempWorkspace("dispatcher-cli-director-dry-run")
    cleanups.push(workspace.cleanup)
    const output: string[] = []
    const io = {
      stdout: (message: string) => output.push(message),
      stderr: (message: string) => output.push(message)
    }

    const store = new DispatcherStore!(workspace.dbPath)
    store.migrate()
    const company = store.createCompany({ name: "OpenClaw Labs" })
    const project = store.createProject({
      companyRef: company.id,
      name: "repo",
      repoPath: workspace.repoPath
    })
    store.close()

    await runCli!(["--db", workspace.dbPath, "director", "cycle", "--project", "repo", "--dry-run"], io)

    const reopened = new DispatcherStore!(workspace.dbPath)
    expect(reopened.listProjectTasks(project.id)).toHaveLength(0)
    expect(reopened.listProjectRuns(project.id)).toHaveLength(0)
    expect(reopened.listPlannerRuns(project.id)).toHaveLength(0)
    const decision = reopened.getLatestDirectorDecision(project.id)
    reopened.close()

    const fullOutput = output.join("\n")
    expect(fullOutput).toContain("mode=dry-run")
    expect(decision?.dryRun).toBe(true)
    expect(decision?.status).toBe("skipped")
  })

  it("manages company project goals milestones and status overviews", async () => {
    const workspace = createTempWorkspace("dispatcher-cli-operating-model")
    cleanups.push(workspace.cleanup)
    const output: string[] = []
    const io = {
      stdout: (message: string) => output.push(message),
      stderr: (message: string) => output.push(message)
    }

    await runCli!(["--db", workspace.dbPath, "init"], io)
    await runCli!(["--db", workspace.dbPath, "company", "create", "OpenClaw Labs"], io)
    await runCli!(["--db", workspace.dbPath, "project", "add", "core", "--repo-path", workspace.repoPath], io)
    await runCli!(
      ["--db", workspace.dbPath, "milestone", "create", "M1", "--project", "core", "--target-date", "2026-05-01"],
      io
    )
    await runCli!(
      [
        "--db",
        workspace.dbPath,
        "goal",
        "create",
        "Ship multi-project control",
        "--project",
        "core",
        "--milestone",
        "M1",
        "--task",
        "Model entities",
        "--task",
        "Expose CLI"
      ],
      io
    )
    await runCli!(["--db", workspace.dbPath, "company", "list"], io)
    await runCli!(["--db", workspace.dbPath, "project", "list"], io)
    await runCli!(["--db", workspace.dbPath, "status", "company"], io)
    await runCli!(["--db", workspace.dbPath, "status", "project", "--project", "core"], io)

    const store = new DispatcherStore!(workspace.dbPath)
    const project = store.resolveProject("core")
    const repositories = store.listRepositories(project.id)
    const milestones = store.listMilestones(project.id)
    const goals = store.listGoals(project.id)
    const goalTasks = store.listProjectTasks(project.id).filter((task) => task.goalId === goals[0]?.id)
    store.close()

    expect(repositories).toHaveLength(1)
    expect(repositories[0]?.role).toBe("primary")
    expect(milestones).toHaveLength(1)
    expect(goals).toHaveLength(1)
    expect(goalTasks.length).toBeGreaterThanOrEqual(3)

    const fullOutput = output.join("\n")
    expect(fullOutput).toContain("Created milestone M1")
    expect(fullOutput).toContain("Created goal Ship multi-project control")
    expect(fullOutput).toContain("Company OpenClaw Labs")
    expect(fullOutput).toContain("Project core")
    expect(fullOutput).toContain("Repositories:")
    expect(fullOutput).toContain("Milestones:")
    expect(fullOutput).toContain("Goals:")
  })

  it("generates evaluation artifacts and scorecards from persisted runs", async () => {
    const workspace = createTempWorkspace("dispatcher-cli-eval")
    cleanups.push(workspace.cleanup)
    const output: string[] = []
    const io = {
      stdout: (message: string) => output.push(message),
      stderr: (message: string) => output.push(message)
    }

    const store = new DispatcherStore!(workspace.dbPath)
    store.migrate()
    const company = store.createCompany({ name: "OpenClaw Labs" })
    const project = store.createProject({
      companyRef: company.id,
      name: "repo",
      repoPath: workspace.repoPath
    })
    const persona = store.createPersona({
      companyRef: company.id,
      name: "Evaluation Engineer",
      stage: "coder",
      preferredAdapterType: "codex_local"
    })
    const agent = store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const task = store.createTask({
      projectRef: project.id,
      personaRef: persona.id,
      stage: "coder",
      title: "Implement evaluation report",
      description: "Create deterministic reports with verification and planner recommendations.",
      labels: ["eval"],
      changedFiles: ["packages/evaluation/src/autonomous-company.ts"],
      requiredReading: ["packages/evaluation/README.md"],
      verificationCommands: ["pnpm test"]
    })
    const run = store.createRun({
      companyId: company.id,
      projectId: project.id,
      taskId: task.id,
      agentId: agent.id,
      adapterType: "codex_local",
      kind: "implement"
    })
    store.completeRun(run.id, {
      status: "succeeded",
      verificationSummary: "pnpm test passed",
      reviewVerdict: "approved"
    })
    store.updateRunMetadata(run.id, { changedLines: 12 })
    store.updateTaskStatus(task.id, "done")
    store.close()

    await runCli!(["--db", workspace.dbPath, "eval", "run", "--project", "repo"], io)
    await runCli!(["--db", workspace.dbPath, "eval", "persona-scorecard", "--project", "repo"], io)
    await runCli!(["--db", workspace.dbPath, "eval", "adapter-scorecard", "--project", "repo"], io)

    const fullOutput = output.join("\n")
    expect(fullOutput).toContain("task_success_rate=1.000")
    expect(fullOutput).toContain("planner-recommendations.json")
    expect(fullOutput).toContain("Evaluation Engineer")
    expect(fullOutput).toContain("codex_local")
    expect(existsSync(join(workspace.repoPath, ".openclaw", "evaluation", "evaluation-output.json"))).toBe(true)
  })

  it("runs the adapter smoke command for a local lane", async () => {
    const workspace = createTempWorkspace("dispatcher-adapter-smoke")
    cleanups.push(workspace.cleanup)
    const geminiScript = createFakeGeminiScript(workspace.root)
    const output: string[] = []
    const io = {
      stdout: (message: string) => output.push(message),
      stderr: (message: string) => output.push(message)
    }

    await runCli!(
      [
        "adapter-smoke",
        "gemini_local",
        "--repo",
        workspace.repoPath,
        "--command",
        geminiScript,
        "--model",
        "gemini-2.5-flash"
      ],
      io
    )

    const fullOutput = output.join("\n")
    expect(fullOutput).toContain("adapter: gemini_local")
    expect(fullOutput).toContain("transport: acpx")
    expect(fullOutput).toContain("ok: yes")
    expect(fullOutput).toContain("gemini completed")
  })

  it("runs the adapter smoke command for Azure Foundry", async () => {
    const workspace = createTempWorkspace("dispatcher-adapter-smoke-foundry")
    cleanups.push(workspace.cleanup)
    const originalFetch = globalThis.fetch
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ choices: [{ message: { content: "foundry ok" } }] }), { status: 200 })
    })
    globalThis.fetch = fetchMock as typeof fetch
    const output: string[] = []
    const io = {
      stdout: (message: string) => output.push(message),
      stderr: (message: string) => output.push(message)
    }

    try {
      await runCli!(
        [
          "adapter-smoke",
          "azure_foundry",
          "--repo",
          workspace.repoPath,
          "--model",
          "Kimi-K2.6",
          "--env",
          `OPENCLAW_AZURE_FOUNDRY_ENDPOINTS=${JSON.stringify([
            {
              name: "test-foundry",
              projectUrl: "https://example.services.ai.azure.com/api/projects/test",
              apiKeyEnv: "TEST_FOUNDRY_KEY",
              models: ["Kimi-K2.6"]
            }
          ])}`,
          "--env",
          "TEST_FOUNDRY_KEY=test-key"
        ],
        io
      )
    } finally {
      globalThis.fetch = originalFetch
    }

    const fullOutput = output.join("\n")
    expect(fullOutput).toContain("adapter: azure_foundry")
    expect(fullOutput).toContain("ok: yes")
    expect(fullOutput).toContain("model: Kimi-K2.6")
    expect(fullOutput).toContain("foundry ok")
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it("backs up the database and extracts task references from the CLI", async () => {
    const workspace = createTempWorkspace("dispatcher-cli-db-backup")
    cleanups.push(workspace.cleanup)
    const output: string[] = []
    const io = {
      stdout: (message: string) => output.push(message),
      stderr: (message: string) => output.push(message)
    }
    const backupPath = join(workspace.root, "manual-backup.db")

    await runCli!(["--db", workspace.dbPath, "init"], io)
    await runCli!(["--db", workspace.dbPath, "db", "backup", "--output", backupPath], io)
    await runCli!(["--db", workspace.dbPath, "db", "compact", "--dry-run", "--no-vacuum"], io)
    await runCli!(["--db", workspace.dbPath, "task", "refs", "Fix APP-123 and /tasks/OPS-9"], io)

    expect(existsSync(backupPath)).toBe(true)
    expect(existsSync(join(workspace.root, "backups"))).toBe(false)
    expect(output.join("\n")).toContain(`backup: ${backupPath}`)
    expect(output.join("\n")).toContain("dry_run: true")
    expect(output.join("\n")).toContain("- run_events: 0")
    expect(output.join("\n")).toContain("APP-123")
    expect(output.join("\n")).toContain("OPS-9")
  })

  it("persists autonomous review reports through the review CLI", async () => {
    const workspace = createTempWorkspace("dispatcher-review-cli")
    cleanups.push(workspace.cleanup)
    const output: string[] = []
    const io = {
      stdout: (message: string) => output.push(message),
      stderr: (message: string) => output.push(message)
    }
    const store = new DispatcherStore!(workspace.dbPath)
    store.migrate()
    const company = store.createCompany({ name: "Review CLI Co" })
    const project = store.createProject({
      companyRef: company.id,
      name: "repo",
      repoPath: workspace.repoPath
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Touch schema",
      changedFiles: ["packages/db/src/schema.ts"]
    })
    const run = store.createRun({
      companyId: company.id,
      projectId: project.id,
      taskId: task.id,
      adapterType: "codex_local"
    })
    store.completeRun(run.id, {
      status: "succeeded",
      verificationSummary: "no verification command"
    })
    store.close()

    await runCli!(["--db", workspace.dbPath, "review", "run", run.id, "--create-repair"], io)
    const reviewId = output.join("\n").match(/review_id: ([a-f0-9-]+)/)?.[1]
    expect(reviewId).toBeTruthy()
    await runCli!(["--db", workspace.dbPath, "review", "pending"], io)
    await runCli!(["--db", workspace.dbPath, "review", "explain", reviewId!], io)

    const fullOutput = output.join("\n")
    expect(fullOutput).toContain("outcome: architecture_blocked")
    expect(fullOutput).toContain("repair_task_id:")
    expect(fullOutput).toContain("Inspected task prompt:")
  })

  it("does not classify schema-named test files as persistence architecture changes", async () => {
    const workspace = createTempWorkspace("dispatcher-review-schema-test")
    cleanups.push(workspace.cleanup)
    const output: string[] = []
    const io = {
      stdout: (message: string) => output.push(message),
      stderr: (message: string) => output.push(message)
    }
    const store = new DispatcherStore!(workspace.dbPath)
    store.migrate()
    const company = store.createCompany({ name: "Review Test File Co" })
    const project = store.createProject({
      companyRef: company.id,
      name: "repo",
      repoPath: workspace.repoPath
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Test API schema validation",
      changedFiles: ["apps/reports-ui/src/__contracts__/schemaValidation.test.ts"]
    })
    const run = store.createRun({
      companyId: company.id,
      projectId: project.id,
      taskId: task.id,
      adapterType: "codex_local"
    })
    store.completeRun(run.id, {
      status: "succeeded",
      verificationSummary: "1 test passed"
    })
    store.close()

    await runCli!(["--db", workspace.dbPath, "review", "run", run.id], io)

    const fullOutput = output.join("\n")
    expect(fullOutput).toContain("outcome: approve")
    expect(fullOutput).toContain("risk_level: low")
    expect(fullOutput).not.toContain("Architecture or persistence rules may be affected.")
  })

  it("does not classify API DTO modules as persistence schema changes", async () => {
    const workspace = createTempWorkspace("dispatcher-review-api-schema-module")
    cleanups.push(workspace.cleanup)
    const output: string[] = []
    const io = {
      stdout: (message: string) => output.push(message),
      stderr: (message: string) => output.push(message)
    }
    const store = new DispatcherStore!(workspace.dbPath)
    store.migrate()
    const company = store.createCompany({ name: "Review API Schema Co" })
    const project = store.createProject({
      companyRef: company.id,
      name: "repo",
      repoPath: workspace.repoPath
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Add an incident response DTO",
      changedFiles: ["apps/backend/lawyer_rag/schemas_incidents.py"]
    })
    const run = store.createRun({
      companyId: company.id,
      projectId: project.id,
      taskId: task.id,
      adapterType: "codex_local"
    })
    store.completeRun(run.id, {
      status: "succeeded",
      verificationSummary: "1 API contract test passed"
    })
    store.close()

    await runCli!(["--db", workspace.dbPath, "review", "run", run.id], io)

    const fullOutput = output.join("\n")
    expect(fullOutput).toContain("outcome: approve")
    expect(fullOutput).not.toContain("Architecture or persistence rules may be affected.")
  })

  it("marks failed verification evidence as changes requested during review", async () => {
    const workspace = createTempWorkspace("dispatcher-review-verification-failure")
    cleanups.push(workspace.cleanup)
    const output: string[] = []
    const io = {
      stdout: (message: string) => output.push(message),
      stderr: (message: string) => output.push(message)
    }
    const store = new DispatcherStore!(workspace.dbPath)
    store.migrate()
    const company = store.createCompany({ name: "Review Verification Co" })
    const project = store.createProject({
      companyRef: company.id,
      name: "repo",
      repoPath: workspace.repoPath
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Docs smoke",
      changedFiles: ["docs/smoke.md"],
      allowedPaths: ["docs/smoke.md"]
    })
    const run = store.createRun({
      companyId: company.id,
      projectId: project.id,
      taskId: task.id,
      adapterType: "codex_local"
    })
    store.completeRun(run.id, {
      status: "succeeded",
      verificationSummary: "pytest -q tests/smoke.test.ts",
      responseText: "Verification: pytest -q tests/smoke.test.ts failed, 20 passed / 1 failed"
    })
    store.close()

    await runCli!(["--db", workspace.dbPath, "review", "run", run.id], io)

    const reviewedStore = new DispatcherStore!(workspace.dbPath)
    const reviewedRun = reviewedStore.getRunById(run.id)
    reviewedStore.close()
    const fullOutput = output.join("\n")
    expect(fullOutput).toContain("outcome: needs_tests")
    expect(fullOutput).toContain("Verification evidence reports a failure")
    expect(reviewedRun.reviewVerdict).toBe("changes_requested")
  })

  it("approves passing verification that emits stderr warnings", async () => {
    const workspace = createTempWorkspace("dispatcher-review-verification-stderr-warning")
    cleanups.push(workspace.cleanup)
    const output: string[] = []
    const io = {
      stdout: (message: string) => output.push(message),
      stderr: (message: string) => output.push(message)
    }
    const store = new DispatcherStore!(workspace.dbPath)
    store.migrate()
    const company = store.createCompany({ name: "Review Warning Co" })
    const project = store.createProject({
      companyRef: company.id,
      name: "repo",
      repoPath: workspace.repoPath
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "UI warning smoke",
      changedFiles: ["src/app.ts"],
      allowedPaths: ["src/app.ts"],
      verificationCommands: ["npm test"],
      reviewRequired: true
    })
    store.updateTaskStatus(task.id, "review_needed")
    const run = store.createRun({
      companyId: company.id,
      projectId: project.id,
      taskId: task.id,
      adapterType: "codex_local"
    })
    store.completeRun(run.id, {
      status: "succeeded",
      verificationSummary: "npm test",
      responseText: "Verified: npm test passed"
    })
    store.appendRunEvent(run.id, "warn", "Verification stderr", {
      command: "npm test",
      output: "Smart Scan failed: Error: Network Error\nTests 14 passed"
    })
    store.close()

    await runCli!(["--db", workspace.dbPath, "review", "run", run.id], io)

    const reviewedStore = new DispatcherStore!(workspace.dbPath)
    const reviewedRun = reviewedStore.getRunById(run.id)
    const reviewedTask = reviewedStore.getTaskById(task.id)
    const events = reviewedStore.getTaskEvents(task.id)
    const reviewChildren = reviewedStore.listChildTasks(task.id, "review")
    const reviewResult = reviewedStore.getLatestReviewResultForTask(task.id)
    const reviewerRun = reviewResult?.reviewerRunId ? reviewedStore.getRunById(reviewResult.reviewerRunId) : null
    reviewedStore.close()
    const fullOutput = output.join("\n")
    expect(fullOutput).toContain("outcome: approve")
    expect(fullOutput).not.toContain("Verification evidence reports a failure")
    expect(reviewedRun.reviewVerdict).toBe("approved")
    expect(reviewedTask.status).toBe("promotion_pending")
    expect(events.some((event) => event.kind === "review-passed")).toBe(true)
    expect(events.some((event) => event.kind === "direct-review-carrier-linked")).toBe(true)
    expect(reviewChildren).toHaveLength(1)
    expect(reviewChildren[0]).toMatchObject({ status: "done", kind: "review", parentTaskId: task.id })
    expect(reviewerRun).toMatchObject({ status: "succeeded", taskId: reviewChildren[0]?.id })
  })

  it("does not treat removed TODO markers as newly introduced review blockers", async () => {
    const workspace = createTempWorkspace("dispatcher-review-removed-todo")
    cleanups.push(workspace.cleanup)
    const output: string[] = []
    const io = {
      stdout: (message: string) => output.push(message),
      stderr: (message: string) => output.push(message)
    }
    execFileSync("git", ["init"], { cwd: workspace.repoPath })
    execFileSync("git", ["config", "user.email", "openclaw@example.test"], { cwd: workspace.repoPath })
    execFileSync("git", ["config", "user.name", "OpenClaw"], { cwd: workspace.repoPath })
    const sourcePath = join(workspace.repoPath, "service.py")
    writeFileSync(sourcePath, "# TODO: migrate this facade\nvalue = 1\n", "utf8")
    execFileSync("git", ["add", "service.py"], { cwd: workspace.repoPath })
    execFileSync("git", ["commit", "-m", "seed todo"], { cwd: workspace.repoPath })
    writeFileSync(sourcePath, "# Migration note: keep compatibility until callers move\nvalue = 1\n", "utf8")
    execFileSync("git", ["add", "service.py"], { cwd: workspace.repoPath })
    execFileSync("git", ["commit", "-m", "remove todo marker"], { cwd: workspace.repoPath })
    const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: workspace.repoPath,
      encoding: "utf8"
    }).trim()

    const store = new DispatcherStore!(workspace.dbPath)
    store.migrate()
    const company = store.createCompany({ name: "Review Removed Todo Co" })
    const project = store.createProject({
      companyRef: company.id,
      name: "repo",
      repoPath: workspace.repoPath
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Remove legacy TODO",
      changedFiles: ["service.py"],
      verificationCommands: ["pytest"]
    })
    store.updateTaskStatus(task.id, "review_needed")
    const run = store.createRun({
      companyId: company.id,
      projectId: project.id,
      taskId: task.id,
      adapterType: "codex_local"
    })
    store.completeRun(run.id, {
      status: "succeeded",
      headSha,
      verificationSummary: "pytest",
      responseText: "Verified: pytest passed"
    })
    store.close()

    await runCli!(["--db", workspace.dbPath, "review", "run", run.id], io)

    const reviewedStore = new DispatcherStore!(workspace.dbPath)
    const reviewedRun = reviewedStore.getRunById(run.id)
    const reviewedTask = reviewedStore.getTaskById(task.id)
    reviewedStore.close()
    const fullOutput = output.join("\n")
    expect(fullOutput).toContain("outcome: approve")
    expect(fullOutput).not.toContain("Diff introduces unresolved TODO/FIXME markers")
    expect(reviewedRun.reviewVerdict).toBe("approved")
    expect(reviewedTask.status).toBe("promotion_pending")
  })

  it("uses changed-file hints as allowed scope for ad hoc task creation", async () => {
    const workspace = createTempWorkspace("dispatcher-task-changed-file-scope")
    cleanups.push(workspace.cleanup)
    const output: string[] = []
    const io = {
      stdout: (message: string) => output.push(message),
      stderr: (message: string) => output.push(message)
    }
    const store = new DispatcherStore!(workspace.dbPath)
    store.migrate()
    const company = store.createCompany({ name: "Scope Co" })
    store.createProject({
      companyRef: company.id,
      name: "repo",
      repoPath: workspace.repoPath
    })
    store.close()

    await runCli!(
      [
        "--db",
        workspace.dbPath,
        "task",
        "create",
        "Scoped docs task",
        "--project",
        "repo",
        "--changed-file",
        "docs/openclaw/e2e-dispatch-smoke.md",
        "--description",
        "Change one docs file. Verification: git diff --check and pytest -q tests/test_openclaw_prompt_pack.py."
      ],
      io
    )

    const createdId = output.join("\n").match(/id: ([a-f0-9-]+)/)?.[1]
    expect(createdId).toBeTruthy()
    const scopedStore = new DispatcherStore!(workspace.dbPath)
    const task = scopedStore.getTaskById(createdId!)
    scopedStore.close()
    expect(task.changedFiles).toEqual(["docs/openclaw/e2e-dispatch-smoke.md"])
    expect(task.allowedPaths).toEqual(["docs/openclaw/e2e-dispatch-smoke.md"])
    expect(task.verificationCommands).toContain("git diff --check")
    expect(task.taskPackage?.verificationChecklist).toContain("pytest -q tests/test_openclaw_prompt_pack.py")
    expect(task.taskPackage?.verificationChecklist).not.toContain("make test-openapi")
  })
})
