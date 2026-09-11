import { execFileSync } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { AdapterDefinition, AdapterExecutionResult } from "@openclaw/domain"
import { loadProjectProfile } from "@openclaw/project-profiles"
import { afterEach, describe, expect, it } from "vitest"
import { createFakeGhScript, createTempWorkspace } from "./helpers.js"
import { HAS_NODE_SQLITE } from "./node-sqlite.js"

let DispatcherStore: typeof import("@openclaw/db").DispatcherStore | null = null
let DispatcherExecutor: typeof import("@openclaw/executor").DispatcherExecutor | null = null
let runCli: typeof import("../apps/dispatcher-cli/src/index.js").runCli | null = null
if (HAS_NODE_SQLITE) {
  ;({ DispatcherStore } = await import("@openclaw/db"))
  ;({ DispatcherExecutor } = await import("@openclaw/executor"))
  ;({ runCli } = await import("../apps/dispatcher-cli/src/index.js"))
}

function fakeAdapter(type: "codex_local" | "gemini_local", execute: AdapterDefinition["execute"]): AdapterDefinition {
  return {
    type,
    label: type === "codex_local" ? "Codex Local" : "Gemini Local",
    capabilities: {
      supportsSessionResume: true,
      supportsCompaction: true,
      compactionStrategy: type === "codex_local" ? "rotate" : "summarize",
      preferredPlanningContextWindow: null,
      planningPriority: type === "codex_local" ? 100 : 80,
      planningCostClass: type === "codex_local" ? "high" : "medium",
      nativeContextManagement: type === "codex_local" ? "confirmed" : "unknown",
      heartbeatIdentityMode: "prompt_and_env",
      defaultSessionCompaction:
        type === "codex_local"
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

const describeDb = HAS_NODE_SQLITE ? describe : describe.skip

describeDb("persona, workflow, and promotion flows", () => {
  const cleanups: Array<() => void> = []
  const originalPath = process.env.PATH
  const originalLog = process.env.OPENCLAW_FAKE_GH_LOG
  const originalReleaseList = process.env.OPENCLAW_FAKE_GH_RELEASE_LIST

  afterEach(() => {
    process.env.PATH = originalPath
    if (originalLog === undefined) {
      delete process.env.OPENCLAW_FAKE_GH_LOG
    } else {
      process.env.OPENCLAW_FAKE_GH_LOG = originalLog
    }
    if (originalReleaseList === undefined) {
      delete process.env.OPENCLAW_FAKE_GH_RELEASE_LIST
    } else {
      process.env.OPENCLAW_FAKE_GH_RELEASE_LIST = originalReleaseList
    }
    while (cleanups.length > 0) cleanups.pop()?.()
  })

  it("exposes persona, workflow, automation, and status commands through the CLI", async () => {
    const workspace = createTempWorkspace("dispatcher-persona-cli")
    cleanups.push(workspace.cleanup)

    const output: string[] = []
    const io = {
      stdout: (message: string) => output.push(message),
      stderr: (message: string) => output.push(message)
    }

    await runCli!(["--db", workspace.dbPath, "init"], io)
    await runCli!(["--db", workspace.dbPath, "company", "create", "OpenClaw Labs"], io)
    await runCli!(["--db", workspace.dbPath, "project", "add", "repo", "--repo-path", workspace.repoPath], io)
    await runCli!(
      ["--db", workspace.dbPath, "persona", "add", "planner", "--stage", "planner", "--adapter", "codex_local"],
      io
    )
    await runCli!(
      ["--db", workspace.dbPath, "persona", "add", "coder", "--stage", "coder", "--adapter", "codex_local"],
      io
    )
    await runCli!(
      ["--db", workspace.dbPath, "persona", "add", "reviewer", "--stage", "reviewer", "--adapter", "codex_local"],
      io
    )
    await runCli!(
      ["--db", workspace.dbPath, "persona", "add", "promoter", "--stage", "promoter", "--adapter", "codex_local"],
      io
    )
    await runCli!(["--db", workspace.dbPath, "workflow", "create", "Ship feature", "--project", "repo"], io)
    await runCli!(
      [
        "--db",
        workspace.dbPath,
        "automation",
        "add",
        "repo-health",
        "--project",
        "repo",
        "--kind",
        "repo_health",
        "--cron",
        "* * * * *"
      ],
      io
    )
    await runCli!(["--db", workspace.dbPath, "status"], io)

    const fullOutput = output.join("\n")
    expect(fullOutput).toContain("Added persona planner")
    expect(fullOutput).toContain("Created workflow Ship feature")
    expect(fullOutput).toContain("Added automation repo-health")
    expect(fullOutput).toContain("workflows: 1")

    const store = new DispatcherStore!(workspace.dbPath)
    try {
      expect(store.listPersonas()).toHaveLength(4)
      expect(store.listWorkflows()).toHaveLength(1)
      expect(store.listWorkflowTasks(store.listWorkflows()[0]!.id)).toHaveLength(4)
      expect(store.listAutomations()).toHaveLength(1)
    } finally {
      store.close()
    }
  })

  it("merges a promotion task automatically when review threads are clear and checks pass", async () => {
    const workspace = createTempWorkspace("dispatcher-promotion-merge")
    cleanups.push(workspace.cleanup)
    initGitRepo(workspace.repoPath, workspace.root)
    appendFileSync(join(workspace.repoPath, "README.md"), "ship it\n", "utf8")
    mkdirSync(join(workspace.repoPath, ".openclaw"), { recursive: true })
    writeFileSync(
      join(workspace.repoPath, ".openclaw", "profile.json"),
      JSON.stringify({
        ...loadProjectProfile("minimal-repo"),
        promotionPolicy: {
          ...loadProjectProfile("minimal-repo").promotionPolicy,
          mode: "ready_pr",
          maxOpenPrsPerLane: 1,
          allowParallelLanes: true,
          autoMerge: true,
          autoRelease: true,
          releaseTagBase: "v1.2.3",
          mergeMethod: "squash",
          requireCi: true,
          requireReviewDecision: "manual"
        }
      }),
      "utf8"
    )
    writeFileSync(
      join(workspace.repoPath, ".openclaw", "policy.json"),
      JSON.stringify({ allowPush: true, allowPrCreation: true, allowPrMerge: true }),
      "utf8"
    )

    const ghLog = join(workspace.root, "gh.log")
    createFakeGhScript(workspace.root, "merge")
    process.env.PATH = `${workspace.root}:${originalPath}`
    process.env.OPENCLAW_FAKE_GH_LOG = ghLog

    const store = new DispatcherStore!(workspace.dbPath)
    store.migrate()
    try {
      const company = store.createCompany({ name: "OpenClaw Labs" })
      const project = store.createProject({
        companyRef: company.id,
        name: "repo",
        repoPath: workspace.repoPath,
        verifyCommand: null
      })
      const workflow = store.createWorkflow({
        projectRef: project.id,
        title: "Ship feature"
      })
      const promotionTask = store.createTask({
        projectRef: project.id,
        workflowId: workflow.id,
        stage: "promoter",
        kind: "promote",
        title: "Promote: Ship feature",
        description: "Ship feature to main",
        labels: ["promotion"],
        maxRetries: 1
      })
      let mergedPromotionLastError: string | null | undefined = "not-seen"
      const originalUpdatePromotion = store.updatePromotion.bind(store)
      store.updatePromotion = ((promotionId, patch) => {
        if (patch.promotionStatus === "merged") {
          mergedPromotionLastError = patch.lastError
        }
        return originalUpdatePromotion(promotionId, patch)
      }) as typeof store.updatePromotion

      const executor = new DispatcherExecutor!(store, {
        codex_local: fakeAdapter(
          "codex_local",
          async (): Promise<AdapterExecutionResult> => ({ ok: true, response: "unused" })
        ),
        gemini_local: fakeAdapter(
          "gemini_local",
          async (): Promise<AdapterExecutionResult> => ({ ok: true, response: "unused" })
        )
      })

      const summary = await executor.tick()
      expect(summary.executedRuns).toBe(1)

      const refreshedPromotionTask = store.getTaskById(promotionTask.id)
      const promotion = store.getPromotionByTaskId(refreshedPromotionTask.id)!
      expect(refreshedPromotionTask.status).toBe("done")
      expect(promotion.promotionStatus).toBe("merged")
      expect(promotion.lastError).toBeNull()
      expect(mergedPromotionLastError).toBeNull()
      expect(store.listReleases(project.id).map((release) => release.version)).toContain("v1.2.3.1")
      expect(store.getTaskEvents(refreshedPromotionTask.id).map((event) => event.kind)).toContain("release-published")
      expect(readFileSync(ghLog, "utf8")).toContain("release create v1.2.3.1")
      expect(
        execFileSync("git", ["branch", "--show-current"], { cwd: workspace.repoPath, encoding: "utf8" }).trim()
      ).toBe("main")
    } finally {
      store.close()
    }
  }, 15000)

  it("marks an existing draft pull request ready before auto-merging it", async () => {
    const workspace = createTempWorkspace("dispatcher-promotion-draft")
    cleanups.push(workspace.cleanup)
    initGitRepo(workspace.repoPath, workspace.root)
    appendFileSync(join(workspace.repoPath, "README.md"), "draft promotion\n", "utf8")
    mkdirSync(join(workspace.repoPath, ".openclaw"), { recursive: true })
    writeFileSync(
      join(workspace.repoPath, ".openclaw", "profile.json"),
      JSON.stringify({
        ...loadProjectProfile("minimal-repo"),
        promotionPolicy: {
          ...loadProjectProfile("minimal-repo").promotionPolicy,
          mode: "ready_pr",
          maxOpenPrsPerLane: 1,
          allowParallelLanes: true,
          autoMerge: true,
          mergeMethod: "squash",
          requireCi: true,
          requireReviewDecision: "manual"
        }
      }),
      "utf8"
    )
    writeFileSync(
      join(workspace.repoPath, ".openclaw", "policy.json"),
      JSON.stringify({ allowPush: true, allowPrCreation: true, allowPrMerge: true }),
      "utf8"
    )

    const ghLog = join(workspace.root, "gh.log")
    createFakeGhScript(workspace.root, "draft")
    process.env.PATH = `${workspace.root}:${originalPath}`
    process.env.OPENCLAW_FAKE_GH_LOG = ghLog

    const store = new DispatcherStore!(workspace.dbPath)
    store.migrate()
    try {
      const company = store.createCompany({ name: "OpenClaw Labs" })
      const project = store.createProject({
        companyRef: company.id,
        name: "repo",
        repoPath: workspace.repoPath,
        verifyCommand: null
      })
      const workflow = store.createWorkflow({
        projectRef: project.id,
        title: "Ship draft feature"
      })
      store.createTask({
        projectRef: project.id,
        workflowId: workflow.id,
        stage: "promoter",
        kind: "promote",
        title: "Promote: Ship draft feature",
        description: "Ship draft feature to main",
        labels: ["promotion"],
        maxRetries: 1
      })

      const executor = new DispatcherExecutor!(store, {
        codex_local: fakeAdapter(
          "codex_local",
          async (): Promise<AdapterExecutionResult> => ({ ok: true, response: "unused" })
        ),
        gemini_local: fakeAdapter(
          "gemini_local",
          async (): Promise<AdapterExecutionResult> => ({ ok: true, response: "unused" })
        )
      })

      const summary = await executor.tick()
      expect(summary.executedRuns).toBe(1)

      const promotionTask = store.listTasks().find((entry) => entry.kind === "promote")!
      expect(promotionTask.status).toBe("done")
      expect(store.getPromotionByTaskId(promotionTask.id)?.promotionStatus).toBe("merged")
      const ghCalls = readFileSync(ghLog, "utf8")
      expect(ghCalls).toContain("pr ready 17")
      expect(ghCalls.indexOf("pr ready 17")).toBeLessThan(ghCalls.indexOf("pr merge 17"))
      expect(store.getTaskEvents(promotionTask.id).map((event) => event.kind)).toContain("promotion-pr-marked-ready")
    } finally {
      store.close()
    }
  }, 15000)

  it("continues auto-release tags from the highest three-part semantic version", async () => {
    const workspace = createTempWorkspace("dispatcher-promotion-release-semver")
    cleanups.push(workspace.cleanup)
    initGitRepo(workspace.repoPath, workspace.root)
    appendFileSync(join(workspace.repoPath, "README.md"), "ship semantic release\n", "utf8")
    mkdirSync(join(workspace.repoPath, ".openclaw"), { recursive: true })
    writeFileSync(
      join(workspace.repoPath, ".openclaw", "profile.json"),
      JSON.stringify({
        ...loadProjectProfile("minimal-repo"),
        promotionPolicy: {
          ...loadProjectProfile("minimal-repo").promotionPolicy,
          mode: "ready_pr",
          maxOpenPrsPerLane: 1,
          allowParallelLanes: true,
          autoMerge: true,
          autoRelease: true,
          mergeMethod: "squash",
          requireCi: true,
          requireReviewDecision: "manual"
        }
      }),
      "utf8"
    )
    writeFileSync(
      join(workspace.repoPath, ".openclaw", "policy.json"),
      JSON.stringify({ allowPush: true, allowPrCreation: true, allowPrMerge: true }),
      "utf8"
    )

    const ghLog = join(workspace.root, "gh.log")
    createFakeGhScript(workspace.root, "merge")
    process.env.PATH = `${workspace.root}:${originalPath}`
    process.env.OPENCLAW_FAKE_GH_LOG = ghLog
    process.env.OPENCLAW_FAKE_GH_RELEASE_LIST = JSON.stringify([
      {
        tagName: "v2.9.7.975",
        name: "v2.9.7.975",
        isDraft: false,
        isPrerelease: false,
        publishedAt: "2026-06-10T06:28:56Z",
        createdAt: "2026-06-10T06:28:56Z"
      },
      {
        tagName: "v2.9.12",
        name: "v2.9.12",
        isDraft: false,
        isPrerelease: false,
        publishedAt: "2026-06-10T16:00:28Z",
        createdAt: "2026-06-10T16:00:28Z"
      }
    ])

    const store = new DispatcherStore!(workspace.dbPath)
    store.migrate()
    try {
      const company = store.createCompany({ name: "OpenClaw Labs" })
      const project = store.createProject({
        companyRef: company.id,
        name: "repo",
        repoPath: workspace.repoPath,
        verifyCommand: null
      })
      const workflow = store.createWorkflow({
        projectRef: project.id,
        title: "Ship semantic release"
      })
      store.createTask({
        projectRef: project.id,
        workflowId: workflow.id,
        stage: "promoter",
        kind: "promote",
        title: "Promote: Ship semantic release",
        description: "Ship semantic release to main",
        labels: ["promotion"],
        maxRetries: 1
      })

      const executor = new DispatcherExecutor!(store, {
        codex_local: fakeAdapter(
          "codex_local",
          async (): Promise<AdapterExecutionResult> => ({ ok: true, response: "unused" })
        ),
        gemini_local: fakeAdapter(
          "gemini_local",
          async (): Promise<AdapterExecutionResult> => ({ ok: true, response: "unused" })
        )
      })

      const summary = await executor.tick()
      expect(summary.executedRuns).toBe(1)

      const promotionTask = store.listTasks().find((entry) => entry.kind === "promote")!
      expect(promotionTask.status).toBe("done")
      expect(store.listReleases(project.id).map((release) => release.version)).toContain("v2.9.13")
      expect(readFileSync(ghLog, "utf8")).toContain("release create v2.9.13")
    } finally {
      store.close()
    }
  }, 15000)

  it("promotes recovered implementation runs from saved head SHA when the old branch is gone", async () => {
    const workspace = createTempWorkspace("dispatcher-promotion-saved-head")
    cleanups.push(workspace.cleanup)
    initGitRepo(workspace.repoPath, workspace.root)
    execFileSync("git", ["checkout", "-b", "old-implementation"], { cwd: workspace.repoPath, encoding: "utf8" })
    appendFileSync(join(workspace.repoPath, "README.md"), "saved head change\n", "utf8")
    execFileSync("git", ["add", "README.md"], { cwd: workspace.repoPath, encoding: "utf8" })
    execFileSync("git", ["commit", "-m", "saved head implementation"], { cwd: workspace.repoPath, encoding: "utf8" })
    const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace.repoPath, encoding: "utf8" }).trim()
    execFileSync("git", ["checkout", "main"], { cwd: workspace.repoPath, encoding: "utf8" })
    execFileSync("git", ["branch", "-D", "old-implementation"], { cwd: workspace.repoPath, encoding: "utf8" })
    writeFileSync(join(workspace.repoPath, "BASE.md"), "new base work\n", "utf8")
    execFileSync("git", ["add", "BASE.md"], { cwd: workspace.repoPath, encoding: "utf8" })
    execFileSync("git", ["commit", "-m", "advance base"], { cwd: workspace.repoPath, encoding: "utf8" })
    execFileSync("git", ["push", "origin", "main"], { cwd: workspace.repoPath, encoding: "utf8" })
    appendFileSync(join(workspace.repoPath, "README.md"), "operator work in progress\n", "utf8")
    mkdirSync(join(workspace.repoPath, ".openclaw"), { recursive: true })
    writeFileSync(
      join(workspace.repoPath, ".openclaw", "profile.json"),
      JSON.stringify({
        ...loadProjectProfile("minimal-repo"),
        promotionPolicy: {
          ...loadProjectProfile("minimal-repo").promotionPolicy,
          mode: "ready_pr",
          maxOpenPrsPerLane: 1,
          allowParallelLanes: true,
          autoMerge: true,
          autoRelease: false,
          mergeMethod: "squash",
          requireCi: true,
          requireReviewDecision: "manual"
        }
      }),
      "utf8"
    )
    writeFileSync(
      join(workspace.repoPath, ".openclaw", "policy.json"),
      JSON.stringify({ allowPush: true, allowPrCreation: true, allowPrMerge: true }),
      "utf8"
    )

    const ghLog = join(workspace.root, "gh.log")
    createFakeGhScript(workspace.root, "merge")
    process.env.PATH = `${workspace.root}:${originalPath}`
    process.env.OPENCLAW_FAKE_GH_LOG = ghLog

    const store = new DispatcherStore!(workspace.dbPath)
    store.migrate()
    try {
      const company = store.createCompany({ name: "OpenClaw Labs" })
      const project = store.createProject({
        companyRef: company.id,
        name: "repo",
        repoPath: workspace.repoPath,
        verifyCommand: null
      })
      const implementationTask = store.createTask({
        projectRef: project.id,
        kind: "implement",
        title: "Recovered implementation",
        laneId: "release-ops"
      })
      const implementationRun = store.createRun({
        companyId: company.id,
        projectId: project.id,
        taskId: implementationTask.id,
        adapterType: "codex_local",
        kind: "implement"
      })
      store.completeRun(implementationRun.id, {
        status: "succeeded",
        responseText: "Implemented",
        branchName: "openclaw/run/missing-old-implementation",
        headSha
      })
      store.updateTaskStatus(implementationTask.id, "promotion_pending")
      store.createTask({
        projectRef: project.id,
        parentTaskId: implementationTask.id,
        stage: "promoter",
        kind: "promote",
        title: "Promote: Recovered implementation",
        labels: ["promotion"],
        laneId: "release-ops",
        maxRetries: 1
      })

      const executor = new DispatcherExecutor!(store, {
        codex_local: fakeAdapter(
          "codex_local",
          async (): Promise<AdapterExecutionResult> => ({ ok: true, response: "unused" })
        ),
        gemini_local: fakeAdapter(
          "gemini_local",
          async (): Promise<AdapterExecutionResult> => ({ ok: true, response: "unused" })
        )
      })

      const summary = await executor.tick()
      expect(summary.executedRuns).toBe(1)

      const promoteTask = store.listChildTasks(implementationTask.id, "promote")[0]!
      const promotion = store.getPromotionByTaskId(implementationTask.id)!
      const run = store.listRuns().find((entry) => entry.kind === "promote")!
      expect(store.getTaskById(promoteTask.id).status, run.errorText ?? "promotion run did not report an error").toBe(
        "done"
      )
      expect(promotion.promotionStatus).toBe("merged")
      expect(store.getRunEvents(run.id)).toContainEqual(
        expect.objectContaining({
          message: "Resolved promotion implementation ref",
          data: expect.objectContaining({ source: "saved_head" })
        })
      )
      expect(store.getRunEvents(run.id)).toContainEqual(
        expect.objectContaining({
          message: "Synchronized promotion branch with latest base",
          data: expect.objectContaining({ baseBranch: "main", merged: true })
        })
      )
      execFileSync("git", ["fetch", "origin"], { cwd: workspace.repoPath, encoding: "utf8" })
      expect(() =>
        execFileSync("git", ["merge-base", "--is-ancestor", "origin/main", `origin/${promotion.branchName}`], {
          cwd: workspace.repoPath,
          encoding: "utf8"
        })
      ).not.toThrow()
      expect(readFileSync(ghLog, "utf8")).toContain("pr create")
      expect(readFileSync(join(workspace.repoPath, "README.md"), "utf8")).toContain("operator work in progress")
      expect(
        execFileSync("git", ["branch", "--show-current"], { cwd: workspace.repoPath, encoding: "utf8" }).trim()
      ).toBe("main")
    } finally {
      store.close()
    }
  }, 15000)

  it("marks recovered promotion branches already on main as merged without opening a PR", async () => {
    const workspace = createTempWorkspace("dispatcher-promotion-already-integrated")
    cleanups.push(workspace.cleanup)
    initGitRepo(workspace.repoPath, workspace.root)
    const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace.repoPath, encoding: "utf8" }).trim()
    createFakeGhScript(workspace.root, "merge")
    process.env.PATH = `${workspace.root}:${originalPath}`

    const store = new DispatcherStore!(workspace.dbPath)
    store.migrate()
    try {
      const company = store.createCompany({ name: "OpenClaw Labs" })
      const project = store.createProject({
        companyRef: company.id,
        name: "repo",
        repoPath: workspace.repoPath,
        verifyCommand: null
      })
      const implementationTask = store.createTask({
        projectRef: project.id,
        kind: "implement",
        title: "Already integrated implementation",
        laneId: "release-ops"
      })
      const implementationRun = store.createRun({
        companyId: company.id,
        projectId: project.id,
        taskId: implementationTask.id,
        adapterType: "codex_local",
        kind: "implement"
      })
      store.completeRun(implementationRun.id, {
        status: "succeeded",
        responseText: "Implemented",
        branchName: "openclaw/run/already-integrated",
        headSha
      })
      store.updateTaskStatus(implementationTask.id, "promotion_pending")
      const promoteTask = store.createTask({
        projectRef: project.id,
        parentTaskId: implementationTask.id,
        stage: "promoter",
        kind: "promote",
        title: "Promote: Already integrated implementation",
        labels: ["promotion"],
        laneId: "release-ops",
        maxRetries: 1
      })

      const executor = new DispatcherExecutor!(store, {
        codex_local: fakeAdapter(
          "codex_local",
          async (): Promise<AdapterExecutionResult> => ({ ok: true, response: "unused" })
        ),
        gemini_local: fakeAdapter(
          "gemini_local",
          async (): Promise<AdapterExecutionResult> => ({ ok: true, response: "unused" })
        )
      })

      const summary = await executor.tick()
      expect(summary.executedRuns).toBe(1)

      expect(store.getTaskById(promoteTask.id).status).toBe("done")
      expect(store.getTaskById(implementationTask.id).status).toBe("done")
      expect(store.getPromotionByTaskId(implementationTask.id)?.promotionStatus).toBe("merged")
      expect(store.getTaskEvents(promoteTask.id).map((event) => event.kind)).toContain("promotion-already-integrated")
    } finally {
      store.close()
    }
  }, 15000)

  it("blocks unrecoverable promotion branches without creating AI follow-up tasks", async () => {
    const workspace = createTempWorkspace("dispatcher-promotion-missing-branch")
    cleanups.push(workspace.cleanup)
    initGitRepo(workspace.repoPath, workspace.root)
    mkdirSync(join(workspace.repoPath, ".openclaw"), { recursive: true })
    writeFileSync(
      join(workspace.repoPath, ".openclaw", "profile.json"),
      JSON.stringify({
        ...loadProjectProfile("minimal-repo"),
        promotionPolicy: {
          ...loadProjectProfile("minimal-repo").promotionPolicy,
          mode: "ready_pr",
          autoMerge: false,
          mergeMethod: "squash",
          requireCi: true,
          requireReviewDecision: "manual"
        }
      }),
      "utf8"
    )
    writeFileSync(
      join(workspace.repoPath, ".openclaw", "policy.json"),
      JSON.stringify({ allowPush: true, allowPrCreation: true, allowPrMerge: true }),
      "utf8"
    )

    createFakeGhScript(workspace.root, "merge")
    process.env.PATH = `${workspace.root}:${originalPath}`

    const store = new DispatcherStore!(workspace.dbPath)
    store.migrate()
    try {
      const company = store.createCompany({ name: "OpenClaw Labs" })
      const project = store.createProject({
        companyRef: company.id,
        name: "repo",
        repoPath: workspace.repoPath,
        verifyCommand: null
      })
      const implementationTask = store.createTask({
        projectRef: project.id,
        kind: "implement",
        title: "Lost implementation branch",
        laneId: "release-ops"
      })
      const implementationRun = store.createRun({
        companyId: company.id,
        projectId: project.id,
        taskId: implementationTask.id,
        adapterType: "codex_local",
        kind: "implement"
      })
      store.completeRun(implementationRun.id, {
        status: "succeeded",
        responseText: "Implemented",
        branchName: "openclaw/run/lost-implementation",
        headSha: "0123456789012345678901234567890123456789"
      })
      store.updateTaskStatus(implementationTask.id, "promotion_pending")
      const promoteTask = store.createTask({
        projectRef: project.id,
        parentTaskId: implementationTask.id,
        stage: "promoter",
        kind: "promote",
        title: "Promote: Lost implementation branch",
        labels: ["promotion"],
        laneId: "release-ops",
        maxRetries: 1
      })

      const executor = new DispatcherExecutor!(store, {
        codex_local: fakeAdapter(
          "codex_local",
          async (): Promise<AdapterExecutionResult> => ({ ok: true, response: "unused" })
        ),
        gemini_local: fakeAdapter(
          "gemini_local",
          async (): Promise<AdapterExecutionResult> => ({ ok: true, response: "unused" })
        )
      })

      const summary = await executor.tick()
      expect(summary.executedRuns).toBe(1)

      const refreshed = store.getTaskById(promoteTask.id)
      expect(refreshed.status).toBe("blocked")
      expect(refreshed.blockedReason).toBe("adapter_capability:unknown")
      expect(store.getPromotionByTaskId(implementationTask.id)?.promotionStatus).toBe("failed")
      expect(store.isLaneBusy(project.id, "release-ops", implementationTask.id)).toBe(false)
      expect(store.listChildTasks(promoteTask.id, "follow_up")).toHaveLength(0)
      expect(store.getTaskEvents(promoteTask.id).map((event) => event.kind)).toContain("human-action-required")
    } finally {
      store.close()
    }
  }, 15000)

  it("marks promotion records failed when branch push fails", async () => {
    const workspace = createTempWorkspace("dispatcher-promotion-push-failure")
    cleanups.push(workspace.cleanup)
    initGitRepo(workspace.repoPath, workspace.root)
    appendFileSync(join(workspace.repoPath, "README.md"), "push failure\n", "utf8")
    execFileSync("git", ["remote", "set-url", "origin", join(workspace.root, "missing-origin.git")], {
      cwd: workspace.repoPath,
      encoding: "utf8"
    })
    mkdirSync(join(workspace.repoPath, ".openclaw"), { recursive: true })
    writeFileSync(
      join(workspace.repoPath, ".openclaw", "profile.json"),
      JSON.stringify({
        ...loadProjectProfile("minimal-repo"),
        promotionPolicy: {
          ...loadProjectProfile("minimal-repo").promotionPolicy,
          mode: "ready_pr",
          maxOpenPrsPerLane: 1,
          allowParallelLanes: true,
          autoMerge: true,
          mergeMethod: "squash",
          requireCi: true,
          requireReviewDecision: "manual"
        }
      }),
      "utf8"
    )
    writeFileSync(
      join(workspace.repoPath, ".openclaw", "policy.json"),
      JSON.stringify({ allowPush: true, allowPrCreation: true, allowPrMerge: true }),
      "utf8"
    )
    createFakeGhScript(workspace.root, "merge")
    process.env.PATH = `${workspace.root}:${originalPath}`

    const store = new DispatcherStore!(workspace.dbPath)
    store.migrate()
    try {
      const company = store.createCompany({ name: "OpenClaw Labs" })
      const project = store.createProject({
        companyRef: company.id,
        name: "repo",
        repoPath: workspace.repoPath,
        verifyCommand: null
      })
      const promotionTask = store.createTask({
        projectRef: project.id,
        stage: "promoter",
        kind: "promote",
        title: "Promote: Push failure",
        labels: ["promotion"],
        laneId: "release-ops",
        maxRetries: 1
      })

      const executor = new DispatcherExecutor!(store, {
        codex_local: fakeAdapter(
          "codex_local",
          async (): Promise<AdapterExecutionResult> => ({ ok: true, response: "unused" })
        ),
        gemini_local: fakeAdapter(
          "gemini_local",
          async (): Promise<AdapterExecutionResult> => ({ ok: true, response: "unused" })
        )
      })

      const summary = await executor.tick()
      const promotion = store.getPromotionByTaskId(promotionTask.id)!

      expect(summary.executedRuns).toBe(1)
      expect(store.getTaskById(promotionTask.id).status).toBe("blocked")
      expect(promotion.promotionStatus).toBe("failed")
      expect(promotion.lastError).toContain("missing-origin.git")
      expect(store.isLaneBusy(project.id, "release-ops", promotionTask.id)).toBe(false)
    } finally {
      store.close()
    }
  }, 15000)

  it("recovers stale active promotion records for failed parent tasks", async () => {
    const workspace = createTempWorkspace("dispatcher-promotion-stale-record")
    cleanups.push(workspace.cleanup)
    initGitRepo(workspace.repoPath, workspace.root)

    const store = new DispatcherStore!(workspace.dbPath)
    store.migrate()
    try {
      const company = store.createCompany({ name: "OpenClaw Labs" })
      const project = store.createProject({
        companyRef: company.id,
        name: "repo",
        repoPath: workspace.repoPath,
        verifyCommand: null
      })
      const implementationTask = store.createTask({
        projectRef: project.id,
        kind: "implement",
        title: "Stale failed promotion subject",
        laneId: "release-ops"
      })
      store.updateTaskStatus(implementationTask.id, "blocked", {
        blockedReason: "promotion_failed:old-promote-task",
        lastError: "old promotion failed"
      })
      const promotion = store.createPromotion({
        companyId: company.id,
        projectId: project.id,
        taskId: implementationTask.id,
        branchName: "openclaw/run/stale-active",
        promotionStatus: "pending_branch"
      })

      const executor = new DispatcherExecutor!(store, {
        codex_local: fakeAdapter(
          "codex_local",
          async (): Promise<AdapterExecutionResult> => ({ ok: true, response: "unused" })
        ),
        gemini_local: fakeAdapter(
          "gemini_local",
          async (): Promise<AdapterExecutionResult> => ({ ok: true, response: "unused" })
        )
      })

      await executor.tick()

      expect(store.getPromotionByTaskId(implementationTask.id)?.promotionStatus).toBe("failed")
      expect(store.getPromotionByTaskId(implementationTask.id)?.lastError).toBe("old promotion failed")
      expect(store.isLaneBusy(project.id, "release-ops", implementationTask.id)).toBe(false)
      expect(store.getTaskEvents(implementationTask.id).map((event) => event.kind)).toContain(
        "stale-promotion-record-failed"
      )
      expect(store.getPromotionByTaskId(implementationTask.id)?.id).toBe(promotion.id)
    } finally {
      store.close()
    }
  }, 15000)

  it("retries manual-merge promotion blocks when auto-merge is enabled", async () => {
    const workspace = createTempWorkspace("dispatcher-promotion-retry-manual-merge")
    cleanups.push(workspace.cleanup)
    initGitRepo(workspace.repoPath, workspace.root)
    execFileSync("git", ["checkout", "-b", "reviewed-implementation"], {
      cwd: workspace.repoPath,
      encoding: "utf8"
    })
    appendFileSync(join(workspace.repoPath, "README.md"), "retry manual merge\n", "utf8")
    execFileSync("git", ["add", "README.md"], { cwd: workspace.repoPath, encoding: "utf8" })
    execFileSync("git", ["commit", "-m", "reviewed implementation"], {
      cwd: workspace.repoPath,
      encoding: "utf8"
    })
    const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: workspace.repoPath,
      encoding: "utf8"
    }).trim()
    execFileSync("git", ["checkout", "main"], { cwd: workspace.repoPath, encoding: "utf8" })
    mkdirSync(join(workspace.repoPath, ".openclaw"), { recursive: true })
    writeFileSync(
      join(workspace.repoPath, ".openclaw", "profile.json"),
      JSON.stringify({
        ...loadProjectProfile("minimal-repo"),
        promotionPolicy: {
          ...loadProjectProfile("minimal-repo").promotionPolicy,
          mode: "ready_pr",
          maxOpenPrsPerLane: 1,
          allowParallelLanes: true,
          autoMerge: true,
          autoRelease: false,
          mergeMethod: "squash",
          requireCi: true,
          requireReviewDecision: "none"
        }
      }),
      "utf8"
    )
    writeFileSync(
      join(workspace.repoPath, ".openclaw", "policy.json"),
      JSON.stringify({ allowPush: true, allowPrCreation: true, allowPrMerge: true }),
      "utf8"
    )
    createFakeGhScript(workspace.root, "merge")
    process.env.PATH = `${workspace.root}:${originalPath}`

    const store = new DispatcherStore!(workspace.dbPath)
    store.migrate()
    try {
      const company = store.createCompany({ name: "OpenClaw Labs" })
      const project = store.createProject({
        companyRef: company.id,
        name: "repo",
        repoPath: workspace.repoPath,
        verifyCommand: null
      })
      const implementationTask = store.createTask({
        projectRef: project.id,
        kind: "implement",
        title: "Retry manual merge block",
        laneId: "release-ops"
      })
      const implementationRun = store.createRun({
        companyId: company.id,
        projectId: project.id,
        taskId: implementationTask.id,
        adapterType: "codex_local",
        kind: "implement"
      })
      store.completeRun(implementationRun.id, {
        status: "succeeded",
        responseText: "Implemented",
        branchName: "reviewed-implementation",
        headSha
      })
      store.updateTaskStatus(implementationTask.id, "promotion_pending")
      store.createPromotion({
        companyId: company.id,
        projectId: project.id,
        taskId: implementationTask.id,
        branchName: "openclaw/run/retry-manual-merge",
        prNumber: 17,
        prUrl: "https://example.test/pr/17",
        headSha,
        promotionStatus: "ready_to_merge",
        mergeMethod: "squash"
      })
      const promoteTask = store.createTask({
        projectRef: project.id,
        parentTaskId: implementationTask.id,
        stage: "promoter",
        kind: "promote",
        title: "Promote: Retry manual merge block",
        labels: ["promotion"],
        laneId: "release-ops",
        maxRetries: 1
      })
      store.updateTaskStatus(promoteTask.id, "blocked", {
        blockedReason: "waiting_for_manual_merge"
      })

      const executor = new DispatcherExecutor!(store, {
        codex_local: fakeAdapter(
          "codex_local",
          async (): Promise<AdapterExecutionResult> => ({ ok: true, response: "unused" })
        ),
        gemini_local: fakeAdapter(
          "gemini_local",
          async (): Promise<AdapterExecutionResult> => ({ ok: true, response: "unused" })
        )
      })

      const summary = await executor.tick()

      expect(summary.executedRuns).toBe(1)
      expect(store.getTaskById(promoteTask.id).status).toBe("done")
      expect(store.getPromotionByTaskId(implementationTask.id)?.promotionStatus).toBe("merged")
      expect(store.getTaskEvents(promoteTask.id).map((event) => event.kind)).toContain(
        "retryable-promotion-block-requeued"
      )
    } finally {
      store.close()
    }
  }, 15000)

  it("does not immediately retry promotions waiting on external checks", async () => {
    const workspace = createTempWorkspace("dispatcher-promotion-check-wait-idempotent")
    cleanups.push(workspace.cleanup)
    initGitRepo(workspace.repoPath, workspace.root)
    mkdirSync(join(workspace.repoPath, ".openclaw"), { recursive: true })
    writeFileSync(
      join(workspace.repoPath, ".openclaw", "profile.json"),
      JSON.stringify({
        ...loadProjectProfile("minimal-repo"),
        promotionPolicy: {
          ...loadProjectProfile("minimal-repo").promotionPolicy,
          mode: "ready_pr",
          maxOpenPrsPerLane: 1,
          allowParallelLanes: true,
          autoMerge: true,
          mergeMethod: "squash",
          requireCi: true,
          requireReviewDecision: "manual"
        }
      }),
      "utf8"
    )

    const store = new DispatcherStore!(workspace.dbPath)
    store.migrate()
    try {
      const company = store.createCompany({ name: "OpenClaw Labs" })
      const project = store.createProject({
        companyRef: company.id,
        name: "repo",
        repoPath: workspace.repoPath,
        verifyCommand: null
      })
      const implementationTask = store.createTask({
        projectRef: project.id,
        kind: "implement",
        title: "Wait for checks",
        laneId: "release-ops"
      })
      store.updateTaskStatus(implementationTask.id, "promotion_pending")
      store.createPromotion({
        companyId: company.id,
        projectId: project.id,
        taskId: implementationTask.id,
        branchName: "openclaw/run/wait-for-checks",
        prNumber: 17,
        prUrl: "https://example.test/pr/17",
        promotionStatus: "waiting_for_checks",
        mergeMethod: "squash"
      })
      const promoteTask = store.createTask({
        projectRef: project.id,
        parentTaskId: implementationTask.id,
        stage: "promoter",
        kind: "promote",
        title: "Promote: Wait for checks",
        labels: ["promotion"],
        laneId: "release-ops",
        maxRetries: 1
      })
      store.updateTaskStatus(promoteTask.id, "blocked", {
        blockedReason: "waiting_for_checks"
      })

      const executor = new DispatcherExecutor!(store, {
        codex_local: fakeAdapter(
          "codex_local",
          async (): Promise<AdapterExecutionResult> => ({ ok: true, response: "unused" })
        ),
        gemini_local: fakeAdapter(
          "gemini_local",
          async (): Promise<AdapterExecutionResult> => ({ ok: true, response: "unused" })
        )
      })

      const summary = await executor.tick()

      expect(summary.executedRuns).toBe(0)
      expect(store.getTaskById(promoteTask.id).status).toBe("blocked")
      expect(store.getTaskById(promoteTask.id).blockedReason).toBe("waiting_for_checks")
      expect(store.getTaskEvents(promoteTask.id).map((event) => event.kind)).not.toContain(
        "retryable-promotion-block-requeued"
      )
    } finally {
      store.close()
    }
  })

  it("fails a dirty promotion PR without keeping the lane busy", async () => {
    const workspace = createTempWorkspace("dispatcher-promotion-dirty")
    cleanups.push(workspace.cleanup)
    initGitRepo(workspace.repoPath, workspace.root)
    appendFileSync(join(workspace.repoPath, "README.md"), "dirty pr\n", "utf8")
    mkdirSync(join(workspace.repoPath, ".openclaw"), { recursive: true })
    writeFileSync(
      join(workspace.repoPath, ".openclaw", "profile.json"),
      JSON.stringify({
        ...loadProjectProfile("minimal-repo"),
        promotionPolicy: {
          ...loadProjectProfile("minimal-repo").promotionPolicy,
          mode: "ready_pr",
          maxOpenPrsPerLane: 1,
          allowParallelLanes: true,
          autoMerge: true,
          mergeMethod: "squash",
          requireCi: true,
          requireReviewDecision: "manual"
        }
      }),
      "utf8"
    )
    writeFileSync(
      join(workspace.repoPath, ".openclaw", "policy.json"),
      JSON.stringify({ allowPush: true, allowPrCreation: true, allowPrMerge: true }),
      "utf8"
    )

    const ghLog = join(workspace.root, "gh.log")
    createFakeGhScript(workspace.root, "dirty")
    process.env.PATH = `${workspace.root}:${originalPath}`
    process.env.OPENCLAW_FAKE_GH_LOG = ghLog

    const store = new DispatcherStore!(workspace.dbPath)
    store.migrate()
    try {
      const company = store.createCompany({ name: "OpenClaw Labs" })
      const project = store.createProject({
        companyRef: company.id,
        name: "repo",
        repoPath: workspace.repoPath,
        verifyCommand: null
      })
      const workflow = store.createWorkflow({
        projectRef: project.id,
        title: "Ship dirty feature"
      })
      const implementationTask = store.createTask({
        projectRef: project.id,
        workflowId: workflow.id,
        stage: "coder",
        kind: "implement",
        laneId: "timeline",
        title: "Ship dirty feature",
        labels: ["timeline"]
      })
      store.updateTaskStatus(implementationTask.id, "promotion_pending")
      store.createPromotion({
        companyId: company.id,
        projectId: project.id,
        workflowId: workflow.id,
        taskId: implementationTask.id,
        branchName: "openclaw/run/dirty-feature",
        prNumber: 17,
        prUrl: "https://example.test/pr/17",
        headSha: "deadbeef",
        promotionStatus: "ready_to_merge",
        mergeMethod: "squash"
      })
      store.createTask({
        projectRef: project.id,
        workflowId: workflow.id,
        parentTaskId: implementationTask.id,
        stage: "promoter",
        kind: "promote",
        laneId: "timeline",
        title: "Promote: Ship dirty feature",
        description: "Ship dirty feature to main",
        labels: ["promotion"],
        maxRetries: 1
      })

      const executor = new DispatcherExecutor!(store, {
        codex_local: fakeAdapter(
          "codex_local",
          async (): Promise<AdapterExecutionResult> => ({ ok: true, response: "unused" })
        ),
        gemini_local: fakeAdapter(
          "gemini_local",
          async (): Promise<AdapterExecutionResult> => ({ ok: true, response: "unused" })
        )
      })

      const summary = await executor.tick()
      expect(summary.executedRuns).toBe(1)

      const promotionTask = store.listTasks().find((entry) => entry.kind === "promote")!
      const promotion = store.getPromotionByTaskId(implementationTask.id)!
      expect(promotionTask.status).toBe("blocked")
      expect(promotionTask.blockedReason).toBe("human_action_required:promotion_conflict")
      expect(promotion.promotionStatus).toBe("failed")
      expect(promotion.lastError).toContain("mergeStateStatus=DIRTY")
      expect(store.isLaneBusy(project.id, "timeline", promotionTask.id)).toBe(false)
      expect(readFileSync(ghLog, "utf8")).not.toContain("pr merge")
    } finally {
      store.close()
    }
  }, 15000)

  it("skips nested untracked git checkouts while staging promotion changes", async () => {
    const workspace = createTempWorkspace("dispatcher-promotion-nested-checkout")
    cleanups.push(workspace.cleanup)
    initGitRepo(workspace.repoPath, workspace.root)
    appendFileSync(join(workspace.repoPath, "README.md"), "ship it\n", "utf8")
    mkdirSync(join(workspace.repoPath, ".openclaw"), { recursive: true })
    writeFileSync(
      join(workspace.repoPath, ".openclaw", "profile.json"),
      JSON.stringify({
        ...loadProjectProfile("minimal-repo"),
        promotionPolicy: {
          ...loadProjectProfile("minimal-repo").promotionPolicy,
          mode: "ready_pr",
          maxOpenPrsPerLane: 1,
          allowParallelLanes: true,
          autoMerge: true,
          mergeMethod: "squash",
          requireCi: true,
          requireReviewDecision: "manual"
        }
      }),
      "utf8"
    )
    const reviewerPath = join(workspace.repoPath, "reviewer")
    execFileSync("git", ["init", reviewerPath], { encoding: "utf8" })
    writeFileSync(join(reviewerPath, "notes.md"), "review notes\n", "utf8")

    const ghLog = join(workspace.root, "gh-nested.log")
    createFakeGhScript(workspace.root, "merge")
    process.env.PATH = `${workspace.root}:${originalPath}`
    process.env.OPENCLAW_FAKE_GH_LOG = ghLog

    const store = new DispatcherStore!(workspace.dbPath)
    store.migrate()
    try {
      const company = store.createCompany({ name: "OpenClaw Labs" })
      const project = store.createProject({
        companyRef: company.id,
        name: "repo",
        repoPath: workspace.repoPath,
        verifyCommand: null
      })
      const workflow = store.createWorkflow({
        projectRef: project.id,
        title: "Ship feature"
      })
      store.createTask({
        projectRef: project.id,
        workflowId: workflow.id,
        stage: "promoter",
        kind: "promote",
        title: "Promote: Ship feature",
        description: "Ship feature to main",
        labels: ["promotion"],
        maxRetries: 1
      })

      const executor = new DispatcherExecutor!(store, {
        codex_local: fakeAdapter(
          "codex_local",
          async (): Promise<AdapterExecutionResult> => ({ ok: true, response: "unused" })
        ),
        gemini_local: fakeAdapter(
          "gemini_local",
          async (): Promise<AdapterExecutionResult> => ({ ok: true, response: "unused" })
        )
      })

      const summary = await executor.tick()
      expect(summary.executedRuns).toBe(1)

      const promotionTask = store.listTasks().find((entry) => entry.kind === "promote")!
      const promotion = store.getPromotionByTaskId(promotionTask.id)!
      expect(promotionTask.status).toBe("done")
      expect(promotion.promotionStatus).toBe("merged")
      expect(store.getTaskEvents(promotionTask.id).map((event) => event.kind)).toContain(
        "promotion-skipped-nested-git-checkouts"
      )
      expect(existsSync(join(reviewerPath, ".git"))).toBe(true)
      expect(execFileSync("git", ["status", "--porcelain"], { cwd: workspace.repoPath, encoding: "utf8" })).toContain(
        "?? reviewer/"
      )
    } finally {
      store.close()
    }
  }, 15000)

  it("does not fail promotion staging when only a nested checkout is untracked", async () => {
    const workspace = createTempWorkspace("dispatcher-promotion-only-nested-checkout")
    cleanups.push(workspace.cleanup)
    initGitRepo(workspace.repoPath, workspace.root)
    mkdirSync(join(workspace.repoPath, ".openclaw"), { recursive: true })
    writeFileSync(
      join(workspace.repoPath, ".openclaw", "profile.json"),
      JSON.stringify({
        ...loadProjectProfile("minimal-repo"),
        promotionPolicy: {
          ...loadProjectProfile("minimal-repo").promotionPolicy,
          mode: "ready_pr",
          maxOpenPrsPerLane: 1,
          allowParallelLanes: true,
          autoMerge: true,
          mergeMethod: "squash",
          requireCi: true,
          requireReviewDecision: "manual"
        }
      }),
      "utf8"
    )
    const reviewerPath = join(workspace.repoPath, "reviewer")
    execFileSync("git", ["init", reviewerPath], { encoding: "utf8" })
    writeFileSync(join(reviewerPath, "notes.md"), "review notes\n", "utf8")

    const ghLog = join(workspace.root, "gh-only-nested.log")
    createFakeGhScript(workspace.root, "merge")
    process.env.PATH = `${workspace.root}:${originalPath}`
    process.env.OPENCLAW_FAKE_GH_LOG = ghLog

    const store = new DispatcherStore!(workspace.dbPath)
    store.migrate()
    try {
      const company = store.createCompany({ name: "OpenClaw Labs" })
      const project = store.createProject({
        companyRef: company.id,
        name: "repo",
        repoPath: workspace.repoPath,
        verifyCommand: null
      })
      const workflow = store.createWorkflow({
        projectRef: project.id,
        title: "Ship feature"
      })
      store.createTask({
        projectRef: project.id,
        workflowId: workflow.id,
        stage: "promoter",
        kind: "promote",
        title: "Promote: Ship feature",
        description: "Ship feature to main",
        labels: ["promotion"],
        maxRetries: 1
      })

      const executor = new DispatcherExecutor!(store, {
        codex_local: fakeAdapter(
          "codex_local",
          async (): Promise<AdapterExecutionResult> => ({ ok: true, response: "unused" })
        ),
        gemini_local: fakeAdapter(
          "gemini_local",
          async (): Promise<AdapterExecutionResult> => ({ ok: true, response: "unused" })
        )
      })

      const summary = await executor.tick()
      expect(summary.executedRuns).toBe(1)

      const promotionTask = store.listTasks().find((entry) => entry.kind === "promote")!
      const promotion = store.getPromotionByTaskId(promotionTask.id)!
      expect(promotionTask.status).toBe("done")
      expect(promotion.promotionStatus).toBe("merged")
      expect(store.getTaskEvents(promotionTask.id).map((event) => event.kind)).toContain(
        "promotion-skipped-nested-git-checkouts"
      )
      expect(execFileSync("git", ["status", "--porcelain"], { cwd: workspace.repoPath, encoding: "utf8" })).toContain(
        "?? reviewer/"
      )
    } finally {
      store.close()
    }
  }, 15000)

  it("creates a fix_review_feedback task when a PR has unresolved review threads", async () => {
    const workspace = createTempWorkspace("dispatcher-promotion-feedback")
    cleanups.push(workspace.cleanup)
    initGitRepo(workspace.repoPath, workspace.root)
    mkdirSync(join(workspace.repoPath, ".openclaw"), { recursive: true })
    writeFileSync(
      join(workspace.repoPath, ".openclaw", "profile.json"),
      JSON.stringify({
        ...loadProjectProfile("minimal-repo"),
        promotionPolicy: {
          ...loadProjectProfile("minimal-repo").promotionPolicy,
          mode: "ready_pr",
          maxOpenPrsPerLane: 1,
          allowParallelLanes: true,
          mergeMethod: "squash",
          requireCi: false,
          requireReviewDecision: "manual"
        }
      }),
      "utf8"
    )
    writeFileSync(
      join(workspace.repoPath, ".openclaw", "policy.json"),
      JSON.stringify({ allowPush: true, allowPrCreation: true }),
      "utf8"
    )

    const ghLog = join(workspace.root, "gh-feedback.log")
    createFakeGhScript(workspace.root, "feedback")
    process.env.PATH = `${workspace.root}:${originalPath}`
    process.env.OPENCLAW_FAKE_GH_LOG = ghLog

    const store = new DispatcherStore!(workspace.dbPath)
    store.migrate()
    try {
      const company = store.createCompany({ name: "OpenClaw Labs" })
      const project = store.createProject({
        companyRef: company.id,
        name: "repo",
        repoPath: workspace.repoPath,
        verifyCommand: null
      })
      store.createPersona({
        companyRef: company.id,
        name: "coder",
        stage: "coder",
        preferredAdapterType: "codex_local"
      })
      const workflow = store.createWorkflow({
        projectRef: project.id,
        title: "Ship feature"
      })
      const promotionTask = store.createTask({
        projectRef: project.id,
        workflowId: workflow.id,
        stage: "promoter",
        kind: "promote",
        title: "Promote: Ship feature",
        description: "Ship feature to main",
        labels: ["promotion"],
        maxRetries: 1
      })

      const executor = new DispatcherExecutor!(store, {
        codex_local: fakeAdapter(
          "codex_local",
          async (): Promise<AdapterExecutionResult> => ({ ok: true, response: "unused" })
        ),
        gemini_local: fakeAdapter(
          "gemini_local",
          async (): Promise<AdapterExecutionResult> => ({ ok: true, response: "unused" })
        )
      })

      const summary = await executor.tick()
      expect(summary.executedRuns).toBe(1)

      const feedbackTask = store.listChildTasks(promotionTask.id, "fix_review_feedback")[0]!
      expect(feedbackTask.title).toContain("Address review feedback")
      expect(feedbackTask.labels).toContain("review-thread:PRRT_feedback")
      expect(feedbackTask.status).toBe("queued")
      expect(store.getTaskById(promotionTask.id).status).toBe("blocked")
      expect(store.getTaskById(promotionTask.id).blockedReason).toBe("awaiting_review_feedback")
    } finally {
      store.close()
    }
  })

  it("waits for PR approval before auto-merging when the profile requires it", async () => {
    const workspace = createTempWorkspace("dispatcher-promotion-approval-gate")
    cleanups.push(workspace.cleanup)
    initGitRepo(workspace.repoPath, workspace.root)
    appendFileSync(join(workspace.repoPath, "README.md"), "ship it after approval\n", "utf8")
    mkdirSync(join(workspace.repoPath, ".openclaw"), { recursive: true })
    writeFileSync(
      join(workspace.repoPath, ".openclaw", "profile.json"),
      JSON.stringify({
        ...loadProjectProfile("minimal-repo"),
        promotionPolicy: {
          ...loadProjectProfile("minimal-repo").promotionPolicy,
          mode: "ready_pr",
          maxOpenPrsPerLane: 1,
          allowParallelLanes: true,
          autoMerge: true,
          mergeMethod: "squash",
          requireCi: true,
          requireReviewDecision: "approved"
        }
      }),
      "utf8"
    )
    writeFileSync(
      join(workspace.repoPath, ".openclaw", "policy.json"),
      JSON.stringify({ allowPush: true, allowPrCreation: true }),
      "utf8"
    )

    const ghLog = join(workspace.root, "gh-approval.log")
    createFakeGhScript(workspace.root, "pending_approval")
    process.env.PATH = `${workspace.root}:${originalPath}`
    process.env.OPENCLAW_FAKE_GH_LOG = ghLog

    const store = new DispatcherStore!(workspace.dbPath)
    store.migrate()
    try {
      const company = store.createCompany({ name: "OpenClaw Labs" })
      const project = store.createProject({
        companyRef: company.id,
        name: "repo",
        repoPath: workspace.repoPath,
        verifyCommand: null
      })
      const workflow = store.createWorkflow({
        projectRef: project.id,
        title: "Ship feature"
      })
      store.createTask({
        projectRef: project.id,
        workflowId: workflow.id,
        stage: "promoter",
        kind: "promote",
        title: "Promote: Ship feature",
        description: "Ship feature to main",
        labels: ["promotion"],
        maxRetries: 1
      })

      const executor = new DispatcherExecutor!(store, {
        codex_local: fakeAdapter(
          "codex_local",
          async (): Promise<AdapterExecutionResult> => ({ ok: true, response: "unused" })
        ),
        gemini_local: fakeAdapter(
          "gemini_local",
          async (): Promise<AdapterExecutionResult> => ({ ok: true, response: "unused" })
        )
      })

      const summary = await executor.tick()
      expect(summary.executedRuns).toBe(1)

      const promotionTask = store.listTasks().find((entry) => entry.kind === "promote")!
      const promotion = store.getPromotionByTaskId(promotionTask.id)!
      expect(promotionTask.status).toBe("blocked")
      expect(promotionTask.blockedReason).toBe("waiting_for_pr_approval")
      expect(promotion.promotionStatus).toBe("waiting_for_review")
    } finally {
      store.close()
    }

    const ghCalls = execFileSync("cat", [ghLog], { encoding: "utf8" })
    expect(ghCalls).not.toContain("pr merge")
  })

  it("creates deterministic GitHub branches and review-ready PRs for runs", async () => {
    const workspace = createTempWorkspace("dispatcher-github-pr")
    cleanups.push(workspace.cleanup)
    initGitRepo(workspace.repoPath, workspace.root)
    appendFileSync(join(workspace.repoPath, "README.md"), "codex change\n", "utf8")

    const ghLog = join(workspace.root, "gh-pr.log")
    createFakeGhScript(workspace.root, "pending_approval")
    process.env.PATH = `${workspace.root}:${originalPath}`
    process.env.OPENCLAW_FAKE_GH_LOG = ghLog

    const output: string[] = []
    const io = {
      stdout: (message: string) => output.push(message),
      stderr: (message: string) => output.push(message)
    }

    const store = new DispatcherStore!(workspace.dbPath)
    store.migrate()
    let runId = ""
    let taskId = ""
    try {
      const company = store.createCompany({ name: "OpenClaw Labs" })
      const project = store.createProject({
        companyRef: company.id,
        name: "repo",
        repoPath: workspace.repoPath,
        verifyCommand: null
      })
      const persona = store.createPersona({
        companyRef: company.id,
        name: "github-automation",
        stage: "promoter",
        preferredAdapterType: "codex_local",
        ownedLanes: ["release-ops"]
      })
      const task = store.createTask({
        projectRef: project.id,
        personaRef: persona.id,
        stage: "promoter",
        kind: "promote",
        laneId: "release-ops",
        title: "Publish autonomous run",
        description: "Create the pull request for an approved autonomous run.",
        labels: ["promotion"],
        changedFiles: ["README.md"]
      })
      taskId = task.id
      const run = store.createRun({
        companyId: company.id,
        projectId: project.id,
        taskId: task.id,
        adapterType: "codex_local",
        kind: "promote"
      })
      runId = run.id
      store.completeRun(run.id, {
        status: "succeeded",
        responseText: "Review report: change is scoped and ready.",
        verificationSummary: "pnpm test -- github integration passed"
      })
      store.createPromotion({
        companyId: company.id,
        projectId: project.id,
        taskId: task.id,
        branchName: "pending",
        baseBranch: "main",
        promotionStatus: "pending_pr"
      })
    } finally {
      store.close()
    }

    await runCli!(["--db", workspace.dbPath, "github", "branch", "create", "--run", runId], io)
    await runCli!(["--db", workspace.dbPath, "github", "pr", "create", "--run", runId], io)
    await runCli!(["--db", workspace.dbPath, "github", "pr", "status", "--run", runId], io)

    const fullOutput = output.join("\n")
    expect(fullOutput).toContain("branch: openclaw/run/")
    expect(fullOutput).toContain("pr: 17")
    expect(fullOutput).toContain("labels: openclaw, lane:release-ops, persona:github-automation")
    expect(fullOutput).toContain("body_artifact:")

    const reopened = new DispatcherStore!(workspace.dbPath)
    const promotion = reopened.getPromotionByTaskId(taskId)
    reopened.close()
    expect(promotion).toMatchObject({
      prNumber: 17,
      promotionStatus: "waiting_for_review"
    })
    expect(promotion?.branchName).toContain("openclaw/run/")

    const ghCalls = execFileSync("cat", [ghLog], { encoding: "utf8" })
    expect(ghCalls).toContain("api repos/")
    expect(ghCalls).toContain("/pulls --method POST")
    expect(ghCalls).toContain("/issues/17/labels --method POST")
    expect(ghCalls).not.toContain("pr merge")
  }, 15000)

  it("blocks a second promotion in the same lane while one PR is already open", async () => {
    const workspace = createTempWorkspace("dispatcher-promotion-lane-block")
    cleanups.push(workspace.cleanup)
    initGitRepo(workspace.repoPath, workspace.root)

    const ghLog = join(workspace.root, "gh-lane.log")
    createFakeGhScript(workspace.root, "merge")
    process.env.PATH = `${workspace.root}:${originalPath}`
    process.env.OPENCLAW_FAKE_GH_LOG = ghLog

    const store = new DispatcherStore!(workspace.dbPath)
    store.migrate()
    try {
      const company = store.createCompany({ name: "OpenClaw Labs" })
      const project = store.createProject({
        companyRef: company.id,
        name: "repo",
        repoPath: workspace.repoPath,
        verifyCommand: null
      })
      const workflow = store.createWorkflow({
        projectRef: project.id,
        title: "Ship lane work"
      })
      const firstPromotionTask = store.createTask({
        projectRef: project.id,
        workflowId: workflow.id,
        stage: "promoter",
        kind: "promote",
        title: "Promote lane A",
        laneId: "lane-a"
      })
      store.createPromotion({
        companyId: company.id,
        projectId: project.id,
        workflowId: workflow.id,
        taskId: firstPromotionTask.id,
        branchName: "openclaw/lane-a-existing",
        prNumber: 11,
        prUrl: "https://example.test/pr/11",
        promotionStatus: "waiting_for_review"
      })
      store.updateTaskStatus(firstPromotionTask.id, "done")
      const blockedPromotionTask = store.createTask({
        projectRef: project.id,
        workflowId: workflow.id,
        stage: "promoter",
        kind: "promote",
        title: "Promote lane A again",
        laneId: "lane-a"
      })

      const executor = new DispatcherExecutor!(store, {
        codex_local: fakeAdapter(
          "codex_local",
          async (): Promise<AdapterExecutionResult> => ({ ok: true, response: "unused" })
        ),
        gemini_local: fakeAdapter(
          "gemini_local",
          async (): Promise<AdapterExecutionResult> => ({ ok: true, response: "unused" })
        )
      })

      const summary = await executor.tick()
      expect(summary.executedRuns).toBe(0)
      expect(store.getTaskById(blockedPromotionTask.id).status).toBe("blocked")
      expect(store.getTaskById(blockedPromotionTask.id).blockedReason).toContain("lane_busy_with_active_pr")
      expect(store.getTaskEvents(blockedPromotionTask.id).some((event) => event.kind === "lane-pr-blocked")).toBe(true)
    } finally {
      store.close()
    }
  })

  it("checks every promotion gate and persists promotion artifacts", async () => {
    const workspace = createTempWorkspace("dispatcher-promote-check")
    cleanups.push(workspace.cleanup)
    mkdirSync(join(workspace.repoPath, ".openclaw"), { recursive: true })
    writeFileSync(
      join(workspace.repoPath, ".openclaw", "profile.json"),
      JSON.stringify({
        ...loadProjectProfile("minimal-repo"),
        profileId: "test-ready-pr",
        promotionPolicy: {
          ...loadProjectProfile("minimal-repo").promotionPolicy,
          mode: "ready_pr",
          maxOpenPrsPerLane: 1,
          allowParallelLanes: true,
          mergeMethod: "squash",
          requireCi: false,
          requireReviewDecision: "approved"
        }
      }),
      "utf8"
    )

    const store = new DispatcherStore!(workspace.dbPath)
    store.migrate()
    let runId = ""
    try {
      const company = store.createCompany({ name: "OpenClaw Labs" })
      const project = store.createProject({
        companyRef: company.id,
        name: "repo",
        repoPath: workspace.repoPath,
        verifyCommand: null
      })
      const task = store.createTask({
        projectRef: project.id,
        title: "Completed release work",
        kind: "implement",
        labels: ["release"],
        changedFiles: ["src/app.ts", "CHANGELOG.md"],
        allowedPaths: ["src/**", "CHANGELOG.md"],
        verificationCommands: ["pnpm test"],
        laneId: "release-ops"
      })
      store.updateTaskStatus(task.id, "done")
      store.appendTaskEvent(task.id, "review-passed", "Reviewer approved the run.")
      const run = store.createRun({
        companyId: company.id,
        projectId: project.id,
        taskId: task.id,
        adapterType: "codex_local",
        kind: "implement",
        reviewVerdict: "approved"
      })
      runId = run.id
      store.completeRun(run.id, {
        status: "succeeded",
        verificationSummary: "pnpm test passed",
        reviewVerdict: "approved",
        headSha: "abc123"
      })
      store.updateRunMetadata(run.id, {
        testsRun: ["pnpm test"],
        securityFindings: [],
        changelogUpdated: true
      })
    } finally {
      store.close()
    }

    const output: string[] = []
    await runCli!(["--db", workspace.dbPath, "promote", "check", runId], {
      stdout: (message) => output.push(message),
      stderr: (message) => output.push(message)
    })

    const fullOutput = output.join("\n")
    expect(fullOutput).toContain("promotion.promotable=true")
    expect(fullOutput).toContain("PASS task_completed")
    expect(fullOutput).toContain("PASS verification_passed")
    expect(fullOutput).toContain("PASS review_approved")
    expect(fullOutput).toContain("PASS security_findings")
    expect(fullOutput).toContain("PASS diff_scope")
    expect(fullOutput).toContain("PASS required_tests")
    expect(fullOutput).toContain("PASS changelog_release_notes")
    expect(fullOutput).toContain("PASS profile_policy")

    const artifactPath = fullOutput.match(/promotion\.artifact=(.+)/)?.[1]?.trim()
    expect(artifactPath).toBeTruthy()
    expect(existsSync(artifactPath!)).toBe(true)
    const artifact = JSON.parse(readFileSync(artifactPath!, "utf8"))
    expect(artifact.promotable).toBe(true)
    expect(artifact.reviewerBundle).toMatchObject({
      version: 1,
      verdict: "ready",
      summary: "All 8 required promotion gates passed.",
      blockingGateIds: []
    })
    expect(artifact.reviewerBundle.checks).toHaveLength(8)
    expect(artifact.reviewerBundle.checks.every((check: { passed: boolean }) => check.passed)).toBe(true)

    const renderedBundle = fullOutput.match(/promotion\.reviewer_bundle=(.+)/)?.[1]?.trim()
    expect(renderedBundle).toBeTruthy()
    expect(JSON.parse(renderedBundle!)).toEqual(artifact.reviewerBundle)
  })

  it("accounts for repaired nested backend pytest paths during promotion", async () => {
    const workspace = createTempWorkspace("dispatcher-promote-repaired-pytest")
    cleanups.push(workspace.cleanup)
    const nestedTestsPath = join(workspace.repoPath, "apps", "backend", "lawyer_rag", "tests")
    mkdirSync(nestedTestsPath, { recursive: true })
    writeFileSync(join(nestedTestsPath, "test_case_guidance_service.py"), "def test_placeholder(): pass\n", "utf8")

    const store = new DispatcherStore!(workspace.dbPath)
    store.migrate()
    let runId = ""
    try {
      const company = store.createCompany({ name: "OpenClaw Labs" })
      const project = store.createProject({
        companyRef: company.id,
        name: "repo",
        repoPath: workspace.repoPath,
        verifyCommand: null
      })
      const staleCommand = "cd apps/backend && uv run pytest tests/test_case_guidance_service.py -q --no-cov"
      const repairedCommand =
        "cd apps/backend && uv run pytest lawyer_rag/tests/test_case_guidance_service.py -q --no-cov"
      const task = store.createTask({
        projectRef: project.id,
        title: "Verified backend guidance work",
        kind: "implement",
        verificationCommands: [staleCommand]
      })
      store.updateTaskStatus(task.id, "done")
      store.appendTaskEvent(task.id, "review-passed", "Reviewer approved the run.")
      const run = store.createRun({
        companyId: company.id,
        projectId: project.id,
        taskId: task.id,
        adapterType: "codex_local",
        kind: "implement",
        reviewVerdict: "approved"
      })
      runId = run.id
      store.completeRun(run.id, {
        status: "succeeded",
        verificationSummary: `${repairedCommand} passed`,
        reviewVerdict: "approved"
      })
      store.updateRunMetadata(run.id, { testsRun: [repairedCommand] })
    } finally {
      store.close()
    }

    const output: string[] = []
    await runCli!(["--db", workspace.dbPath, "promote", "check", runId], {
      stdout: (message) => output.push(message),
      stderr: (message) => output.push(message)
    })

    const fullOutput = output.join("\n")
    expect(fullOutput).toContain("promotion.promotable=true")
    expect(fullOutput).toContain("PASS required_tests")
    const artifactPath = fullOutput.match(/promotion\.artifact=(.+)/)?.[1]?.trim()
    expect(artifactPath).toBeTruthy()
    expect(readFileSync(artifactPath!, "utf8")).toContain(
      "required=cd apps/backend && uv run pytest lawyer_rag/tests/test_case_guidance_service.py -q --no-cov"
    )
  })

  it("lets a deterministic blocked outcome override stale approval evidence", async () => {
    const workspace = createTempWorkspace("dispatcher-promote-deterministic-block")
    cleanups.push(workspace.cleanup)
    const store = new DispatcherStore!(workspace.dbPath)
    store.migrate()
    let runId = ""
    try {
      const company = store.createCompany({ name: "OpenClaw Labs" })
      const project = store.createProject({
        companyRef: company.id,
        name: "repo",
        repoPath: workspace.repoPath,
        verifyCommand: null
      })
      const task = store.createTask({
        projectRef: project.id,
        title: "Blocked architecture change",
        kind: "implement"
      })
      store.updateTaskStatus(task.id, "done")
      store.appendTaskEvent(task.id, "review-passed", "Stale legacy approval evidence.")
      const run = store.createRun({
        companyId: company.id,
        projectId: project.id,
        taskId: task.id,
        adapterType: "codex_local",
        kind: "implement",
        reviewVerdict: "approved"
      })
      runId = run.id
      store.completeRun(run.id, {
        status: "succeeded",
        responseText: "implementation complete",
        verificationSummary: "tests passed",
        reviewVerdict: "approved"
      })
      store.createReviewResult({
        companyId: company.id,
        projectId: project.id,
        runId: run.id,
        taskId: task.id,
        outcome: "architecture_blocked",
        summary: "Architecture review blocked promotion.",
        findings: [],
        severity: "high",
        changedFiles: ["src/schema.ts"],
        riskLevel: "high",
        requiredFixes: ["Add migration coverage."],
        suggestedRepairPrompt: "Add migration coverage and rerun review.",
        promotionRecommendation: "Do not promote."
      })
    } finally {
      store.close()
    }

    const output: string[] = []
    await runCli!(["--db", workspace.dbPath, "promote", "check", runId], {
      stdout: (message) => output.push(message),
      stderr: (message) => output.push(message)
    })

    const fullOutput = output.join("\n")
    expect(fullOutput).toContain("promotion.promotable=false")
    expect(fullOutput).toContain("FAIL review_approved")
    const artifactPath = fullOutput.match(/promotion\.artifact=(.+)/)?.[1]?.trim()
    const artifact = JSON.parse(readFileSync(artifactPath!, "utf8"))
    expect(artifact.reviewerBundle).toMatchObject({
      version: 1,
      verdict: "blocked"
    })
    expect(artifact.reviewerBundle.blockingGateIds).toEqual(
      artifact.reviewerBundle.checks
        .filter((check: { passed: boolean }) => !check.passed)
        .map((check: { id: string }) => check.id)
    )
    expect(artifact.reviewerBundle.blockingGateIds).toContain("review_approved")
    expect(artifact.reviewerBundle.checks.find((check: { id: string }) => check.id === "review_approved")).toEqual({
      id: "review_approved",
      passed: false,
      evidence: expect.arrayContaining(["deterministic_review=architecture_blocked"])
    })
    expect(artifact.gates.find((gate: { id: string }) => gate.id === "review_approved")?.evidence).toContain(
      "deterministic_review=architecture_blocked"
    )

    const renderedBundle = fullOutput.match(/promotion\.reviewer_bundle=(.+)/)?.[1]?.trim()
    expect(renderedBundle).toBeTruthy()
    expect(JSON.parse(renderedBundle!)).toEqual(artifact.reviewerBundle)
  })

  it("treats reviewed promotion-pending implementation tasks as promotable", async () => {
    const workspace = createTempWorkspace("dispatcher-promote-pending-task")
    cleanups.push(workspace.cleanup)
    mkdirSync(join(workspace.repoPath, ".openclaw"), { recursive: true })
    writeFileSync(
      join(workspace.repoPath, ".openclaw", "profile.json"),
      JSON.stringify({
        ...loadProjectProfile("minimal-repo"),
        profileId: "test-ready-pr",
        promotionPolicy: {
          ...loadProjectProfile("minimal-repo").promotionPolicy,
          mode: "ready_pr",
          maxOpenPrsPerLane: 1,
          allowParallelLanes: true,
          mergeMethod: "squash",
          requireCi: false,
          requireReviewDecision: "approved"
        }
      }),
      "utf8"
    )
    const store = new DispatcherStore!(workspace.dbPath)
    store.migrate()
    let runId = ""
    try {
      const company = store.createCompany({ name: "OpenClaw Labs" })
      const project = store.createProject({
        companyRef: company.id,
        name: "repo",
        repoPath: workspace.repoPath,
        verifyCommand: null
      })
      const task = store.createTask({
        projectRef: project.id,
        title: "Reviewed implementation work",
        kind: "implement",
        verificationCommands: ["pnpm test"],
        laneId: "ui-workspaces-and-viewer"
      })
      store.updateTaskStatus(task.id, "promotion_pending")
      store.appendTaskEvent(task.id, "review-passed", "Reviewer approved the run.")
      const run = store.createRun({
        companyId: company.id,
        projectId: project.id,
        taskId: task.id,
        adapterType: "codex_local",
        kind: "implement",
        reviewVerdict: "approved"
      })
      runId = run.id
      store.completeRun(run.id, {
        status: "succeeded",
        verificationSummary: "pnpm test passed",
        reviewVerdict: "approved",
        headSha: "abc123"
      })
      store.updateRunMetadata(run.id, {
        testsRun: ["pnpm test"],
        securityFindings: []
      })
    } finally {
      store.close()
    }

    const output: string[] = []
    await runCli!(["--db", workspace.dbPath, "promote", "check", runId], {
      stdout: (message) => output.push(message),
      stderr: (message) => output.push(message)
    })

    const fullOutput = output.join("\n")
    expect(fullOutput).toContain("promotion.promotable=true")
    expect(fullOutput).toContain("PASS task_completed")
  })

  it("blocks unsafe promotion checks with high-severity security findings", async () => {
    const workspace = createTempWorkspace("dispatcher-promote-security-block")
    cleanups.push(workspace.cleanup)
    mkdirSync(join(workspace.repoPath, ".openclaw"), { recursive: true })
    writeFileSync(
      join(workspace.repoPath, ".openclaw", "profile.json"),
      JSON.stringify({
        ...loadProjectProfile("minimal-repo"),
        promotionPolicy: {
          ...loadProjectProfile("minimal-repo").promotionPolicy,
          mode: "ready_pr",
          maxOpenPrsPerLane: 1,
          allowParallelLanes: true,
          mergeMethod: "squash",
          requireCi: false,
          requireReviewDecision: "approved"
        }
      }),
      "utf8"
    )

    const store = new DispatcherStore!(workspace.dbPath)
    store.migrate()
    let runId = ""
    try {
      const company = store.createCompany({ name: "OpenClaw Labs" })
      const project = store.createProject({
        companyRef: company.id,
        name: "repo",
        repoPath: workspace.repoPath,
        verifyCommand: null
      })
      const task = store.createTask({
        projectRef: project.id,
        title: "Unsafe completed work",
        kind: "implement",
        changedFiles: ["src/app.ts"],
        allowedPaths: ["src/**"],
        verificationCommands: ["pnpm test"],
        laneId: "release-ops"
      })
      store.updateTaskStatus(task.id, "done")
      store.appendTaskEvent(task.id, "review-passed", "Reviewer approved the run.")
      const run = store.createRun({
        companyId: company.id,
        projectId: project.id,
        taskId: task.id,
        adapterType: "codex_local",
        kind: "implement",
        reviewVerdict: "approved"
      })
      runId = run.id
      store.completeRun(run.id, {
        status: "succeeded",
        verificationSummary: "pnpm test passed",
        reviewVerdict: "approved"
      })
      store.updateRunMetadata(run.id, {
        testsRun: ["pnpm test"],
        securityFindings: [{ severity: "high", title: "credential exposure" }]
      })
    } finally {
      store.close()
    }

    const previousExitCode = process.exitCode
    process.exitCode = undefined
    const output: string[] = []
    await runCli!(["--db", workspace.dbPath, "promote", "check", runId], {
      stdout: (message) => output.push(message),
      stderr: (message) => output.push(message)
    })

    expect(process.exitCode).toBe(1)
    process.exitCode = previousExitCode
    const fullOutput = output.join("\n")
    expect(fullOutput).toContain("promotion.promotable=false")
    expect(fullOutput).toContain("FAIL security_findings")
  })

  it("refuses to requeue non-promotion tasks through promotion sync", async () => {
    const workspace = createTempWorkspace("dispatcher-promotion-sync-kind")
    cleanups.push(workspace.cleanup)

    const store = new DispatcherStore!(workspace.dbPath)
    store.migrate()
    let implementationTaskId = ""
    let promotionTaskId = ""
    try {
      const company = store.createCompany({ name: "OpenClaw Labs" })
      const project = store.createProject({
        companyRef: company.id,
        name: "repo",
        repoPath: workspace.repoPath
      })
      const implementationTask = store.createTask({
        projectRef: project.id,
        title: "Implement feature",
        kind: "user"
      })
      store.updateTaskStatus(implementationTask.id, "done")
      const promotionTask = store.createTask({
        projectRef: project.id,
        title: "Promote feature",
        kind: "promote"
      })
      store.updateTaskStatus(promotionTask.id, "blocked", {
        blockedReason: "waiting_for_pr_sync",
        lastError: "stale check state"
      })
      implementationTaskId = implementationTask.id
      promotionTaskId = promotionTask.id
    } finally {
      store.close()
    }

    const previousExitCode = process.exitCode
    const output: string[] = []
    const io = {
      stdout: (message: string) => output.push(message),
      stderr: (message: string) => output.push(message)
    }

    try {
      process.exitCode = undefined
      await runCli!(["--db", workspace.dbPath, "promotion", "sync", implementationTaskId], io)
      expect(process.exitCode).toBe(1)

      const afterRefusal = new DispatcherStore!(workspace.dbPath)
      try {
        expect(afterRefusal.getTaskById(implementationTaskId).status).toBe("done")
      } finally {
        afterRefusal.close()
      }

      process.exitCode = undefined
      await runCli!(["--db", workspace.dbPath, "promotion", "sync", promotionTaskId], io)
      expect(process.exitCode).toBeUndefined()

      const afterPromotionSync = new DispatcherStore!(workspace.dbPath)
      try {
        const syncedPromotion = afterPromotionSync.getTaskById(promotionTaskId)
        expect(syncedPromotion.status).toBe("queued")
        expect(syncedPromotion.blockedReason).toBeNull()
        expect(syncedPromotion.lastError).toBeNull()
      } finally {
        afterPromotionSync.close()
      }
    } finally {
      process.exitCode = previousExitCode
    }

    const fullOutput = output.join("\n")
    expect(fullOutput).toContain("promotion sync expects a promote task id")
    expect(fullOutput).toContain(`Queued promotion task ${promotionTaskId}`)
  })
})
