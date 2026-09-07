import { execFileSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type {
  AdapterDefinition,
  AdapterExecutionResult,
  AdapterType,
  CodexQuotaOverview,
  RepoPlanningSnapshot
} from "@openclaw/domain"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createTempWorkspace } from "./helpers.js"
import { HAS_NODE_SQLITE } from "./node-sqlite.js"

let DispatcherStore: typeof import("@openclaw/db").DispatcherStore | null = null
let DispatcherExecutor: typeof import("@openclaw/executor").DispatcherExecutor | null = null
let failureRetryClass: typeof import("@openclaw/executor").failureRetryClass | null = null
let componentSizeFailureIsNonWorsening: typeof import("@openclaw/executor").componentSizeFailureIsNonWorsening | null =
  null
let featureBoundaryFailureIsNonWorsening:
  | typeof import("@openclaw/executor").featureBoundaryFailureIsNonWorsening
  | null = null
let focusedVerificationFailureIsNonWorsening:
  | typeof import("@openclaw/executor").focusedVerificationFailureIsNonWorsening
  | null = null
let deterministicFallbackDiffBudgetViolation:
  | typeof import("@openclaw/executor").deterministicFallbackDiffBudgetViolation
  | null = null
let deterministicFallbackTestOnlyViolation:
  | typeof import("@openclaw/executor").deterministicFallbackTestOnlyViolation
  | null = null
let focusedChangedTestVerificationCommands:
  | typeof import("@openclaw/executor").focusedChangedTestVerificationCommands
  | null = null
let normalizeVerificationCommand: typeof import("@openclaw/executor").normalizeVerificationCommand | null = null
let repairBackendPytestPaths: typeof import("@openclaw/executor").repairBackendPytestPaths | null = null
let runBranchIsMergedIntoExecutionBase: typeof import("@openclaw/executor").runBranchIsMergedIntoExecutionBase | null =
  null
let verificationTimeoutMs: typeof import("@openclaw/executor").verificationTimeoutMs | null = null
let readAgentLoopEvents: typeof import("@openclaw/executor").readAgentLoopEvents | null = null
let recoverDeadPlannerOwnerRuns: typeof import("@openclaw/executor").recoverDeadPlannerOwnerRuns | null = null
let resolvePlannerExecutionAgent: typeof import("@openclaw/executor").resolvePlannerExecutionAgent | null = null
let reviewCompletedRun: typeof import("@openclaw/executor").reviewCompletedRun | null = null
let waitForAgentRun: typeof import("@openclaw/executor").waitForAgentRun | null = null
let selectAdapterHealthcheckAgent: typeof import("@openclaw/executor").selectAdapterHealthcheckAgent | null = null
let plannerAgentCandidates: typeof import("@openclaw/executor").plannerAgentCandidates | null = null
let plannerSatisfiedTaskIdsFromRuns: typeof import("@openclaw/executor").plannerSatisfiedTaskIdsFromRuns | null = null
let deterministicFallbackPlannerCandidates:
  | typeof import("@openclaw/executor").deterministicFallbackPlannerCandidates
  | null = null
let loadProjectProfile: typeof import("@openclaw/project-profiles").loadProjectProfile | null = null
if (HAS_NODE_SQLITE) {
  ;({ DispatcherStore } = await import("@openclaw/db"))
  ;({
    DispatcherExecutor,
    failureRetryClass,
    componentSizeFailureIsNonWorsening,
    featureBoundaryFailureIsNonWorsening,
    focusedVerificationFailureIsNonWorsening,
    deterministicFallbackDiffBudgetViolation,
    deterministicFallbackTestOnlyViolation,
    focusedChangedTestVerificationCommands,
    normalizeVerificationCommand,
    repairBackendPytestPaths,
    runBranchIsMergedIntoExecutionBase,
    verificationTimeoutMs,
    readAgentLoopEvents,
    recoverDeadPlannerOwnerRuns,
    resolvePlannerExecutionAgent,
    reviewCompletedRun,
    waitForAgentRun,
    selectAdapterHealthcheckAgent,
    plannerAgentCandidates,
    plannerSatisfiedTaskIdsFromRuns,
    deterministicFallbackPlannerCandidates
  } = await import("@openclaw/executor"))
  ;({ loadProjectProfile } = await import("@openclaw/project-profiles"))
}

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

const describeDb = HAS_NODE_SQLITE ? describe : describe.skip

describeDb("DispatcherExecutor", () => {
  const cleanups: Array<() => void> = []
  const originalStaleRunThreshold = process.env.OPENCLAW_STALE_RUN_THRESHOLD_MS
  const originalRunHeartbeatInterval = process.env.OPENCLAW_RUN_HEARTBEAT_INTERVAL_MS
  const originalQueuedTaskWindow = process.env.OPENCLAW_QUEUED_TASK_WINDOW
  const originalMaxPlannerRuns = process.env.OPENCLAW_MAX_PLANNER_RUNS_PER_TICK
  const originalMaxConcurrentCodexRuns = process.env.OPENCLAW_MAX_CONCURRENT_CODEX_RUNS
  const originalCodexAccountsDir = process.env.OPENCLAW_CODEX_ACCOUNTS_DIR
  const originalCodexAuthFile = process.env.OPENCLAW_CODEX_AUTH_FILE
  const originalAutonomousMode = process.env.OPENCLAW_AUTONOMOUS_EXECUTION_MODE
  const originalAutonomousTurns = process.env.OPENCLAW_AUTONOMOUS_EXECUTION_MAX_TURNS
  const originalMinWorktreeFreeBytes = process.env.OPENCLAW_MIN_WORKTREE_FREE_BYTES
  const originalMinWorktreeFreePercent = process.env.OPENCLAW_MIN_WORKTREE_FREE_PERCENT
  const originalFailureFixCooldownMs = process.env.OPENCLAW_FAILURE_FIX_COOLDOWN_MS
  const originalVerificationTimeoutMs = process.env.OPENCLAW_VERIFICATION_TIMEOUT_MS

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.useRealTimers()

    if (originalStaleRunThreshold === undefined) delete process.env.OPENCLAW_STALE_RUN_THRESHOLD_MS
    else process.env.OPENCLAW_STALE_RUN_THRESHOLD_MS = originalStaleRunThreshold

    if (originalRunHeartbeatInterval === undefined) delete process.env.OPENCLAW_RUN_HEARTBEAT_INTERVAL_MS
    else process.env.OPENCLAW_RUN_HEARTBEAT_INTERVAL_MS = originalRunHeartbeatInterval

    if (originalQueuedTaskWindow === undefined) delete process.env.OPENCLAW_QUEUED_TASK_WINDOW
    else process.env.OPENCLAW_QUEUED_TASK_WINDOW = originalQueuedTaskWindow

    if (originalMaxPlannerRuns === undefined) delete process.env.OPENCLAW_MAX_PLANNER_RUNS_PER_TICK
    else process.env.OPENCLAW_MAX_PLANNER_RUNS_PER_TICK = originalMaxPlannerRuns

    if (originalMaxConcurrentCodexRuns === undefined) delete process.env.OPENCLAW_MAX_CONCURRENT_CODEX_RUNS
    else process.env.OPENCLAW_MAX_CONCURRENT_CODEX_RUNS = originalMaxConcurrentCodexRuns

    if (originalCodexAccountsDir === undefined) delete process.env.OPENCLAW_CODEX_ACCOUNTS_DIR
    else process.env.OPENCLAW_CODEX_ACCOUNTS_DIR = originalCodexAccountsDir

    if (originalCodexAuthFile === undefined) delete process.env.OPENCLAW_CODEX_AUTH_FILE
    else process.env.OPENCLAW_CODEX_AUTH_FILE = originalCodexAuthFile

    if (originalAutonomousMode === undefined) delete process.env.OPENCLAW_AUTONOMOUS_EXECUTION_MODE
    else process.env.OPENCLAW_AUTONOMOUS_EXECUTION_MODE = originalAutonomousMode

    if (originalAutonomousTurns === undefined) delete process.env.OPENCLAW_AUTONOMOUS_EXECUTION_MAX_TURNS
    else process.env.OPENCLAW_AUTONOMOUS_EXECUTION_MAX_TURNS = originalAutonomousTurns

    if (originalMinWorktreeFreeBytes === undefined) delete process.env.OPENCLAW_MIN_WORKTREE_FREE_BYTES
    else process.env.OPENCLAW_MIN_WORKTREE_FREE_BYTES = originalMinWorktreeFreeBytes

    if (originalMinWorktreeFreePercent === undefined) delete process.env.OPENCLAW_MIN_WORKTREE_FREE_PERCENT
    else process.env.OPENCLAW_MIN_WORKTREE_FREE_PERCENT = originalMinWorktreeFreePercent

    if (originalFailureFixCooldownMs === undefined) delete process.env.OPENCLAW_FAILURE_FIX_COOLDOWN_MS
    else process.env.OPENCLAW_FAILURE_FIX_COOLDOWN_MS = originalFailureFixCooldownMs

    if (originalVerificationTimeoutMs === undefined) delete process.env.OPENCLAW_VERIFICATION_TIMEOUT_MS
    else process.env.OPENCLAW_VERIFICATION_TIMEOUT_MS = originalVerificationTimeoutMs

    while (cleanups.length > 0) {
      cleanups.pop()?.()
    }
  })

  it("uses structured adapter failure categories before echoed verification text", () => {
    expect(failureRetryClass!("Task prompt says npm run test", "auth")).toBe("transient")
    expect(failureRetryClass!("verification command failed: npm run test")).toBe("verification")
    expect(failureRetryClass!("Deterministic fallback produced a test-only patch")).toBe("policy")
  })

  it("requests review changes when JSX attributes are embedded in class strings", async () => {
    const { store, company, project } = await setupBase()
    const sourcePath = join(project.repoPath, "Queue.tsx")
    writeFileSync(sourcePath, "export function Queue() { return <section /> }\n", "utf8")
    execFileSync("git", ["add", "Queue.tsx"], { cwd: project.repoPath })
    execFileSync("git", ["commit", "-m", "seed queue"], { cwd: project.repoPath, stdio: "ignore" })
    writeFileSync(
      sourcePath,
      "export function Queue() { return <section className={'data-testid=\"review-queue\"'} /> }\n",
      "utf8"
    )
    execFileSync("git", ["add", "Queue.tsx"], { cwd: project.repoPath })
    execFileSync("git", ["commit", "-m", "malform jsx attribute"], { cwd: project.repoPath, stdio: "ignore" })
    const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: project.repoPath, encoding: "utf8" }).trim()
    const task = store.createTask({
      projectRef: project.id,
      title: "Add a review queue",
      kind: "implement",
      changedFiles: ["Queue.tsx"],
      verificationCommands: ["npm test"]
    })
    const run = store.createRun({
      companyId: company.id,
      projectId: project.id,
      taskId: task.id,
      adapterType: "gemini_local",
      kind: "implement"
    })
    store.completeRun(run.id, {
      status: "succeeded",
      headSha,
      verificationSummary: "npm test",
      responseText: "implemented and tested"
    })

    const result = reviewCompletedRun!(store, run.id)

    expect(result.outcome).toBe("request_changes")
    expect(result.findings.some((finding) => finding.summary.includes("JSX test or accessibility attribute"))).toBe(
      true
    )
    store.close()
  })

  it("requests review changes for an exported implementation with no caller or test", async () => {
    const { store, company, project } = await setupBase()
    const sourcePath = join(project.repoPath, "queue.ts")
    writeFileSync(sourcePath, "export const existingQueue = []\n", "utf8")
    execFileSync("git", ["add", "queue.ts"], { cwd: project.repoPath })
    execFileSync("git", ["commit", "-m", "seed queue utility"], { cwd: project.repoPath, stdio: "ignore" })
    writeFileSync(
      sourcePath,
      "export const existingQueue = []\nexport function generateReviewQueue() { return [] }\n",
      "utf8"
    )
    execFileSync("git", ["add", "queue.ts"], { cwd: project.repoPath })
    execFileSync("git", ["commit", "-m", "add unused queue implementation"], {
      cwd: project.repoPath,
      stdio: "ignore"
    })
    const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: project.repoPath, encoding: "utf8" }).trim()
    const task = store.createTask({
      projectRef: project.id,
      title: "Generate a review queue",
      kind: "implement",
      changedFiles: ["queue.ts"],
      verificationCommands: ["npm test"]
    })
    const run = store.createRun({
      companyId: company.id,
      projectId: project.id,
      taskId: task.id,
      adapterType: "gemini_local",
      kind: "implement"
    })
    store.completeRun(run.id, {
      status: "succeeded",
      headSha,
      verificationSummary: "npm test",
      responseText: "implemented and tested"
    })

    const result = reviewCompletedRun!(store, run.id)

    expect(result.outcome).toBe("request_changes")
    expect(result.requiredFixes.join(" ")).toContain("generateReviewQueue")
    store.close()
  })

  it("does not mistake multiline failed-page categories for a failed test runner", async () => {
    const { store, company, project } = await setupBase()
    const task = store.createTask({
      projectRef: project.id,
      title: "Summarize failed and retryable pages",
      kind: "implement",
      verificationCommands: ["npm test"]
    })
    const run = store.createRun({
      companyId: company.id,
      projectId: project.id,
      taskId: task.id,
      adapterType: "gemini_local",
      kind: "implement"
    })
    store.completeRun(run.id, {
      status: "succeeded",
      verificationSummary: "npm test",
      responseText: "Page categories:\n    failed\n    retryable\nAll focused tests passed."
    })

    const result = reviewCompletedRun!(store, run.id)

    expect(result.outcome).toBe("approve")
    expect(result.findings.some((finding) => finding.summary.includes("Verification evidence"))).toBe(false)
    store.close()
  })

  it("requests tests when explicit coverage criteria only remove test code", async () => {
    const { store, company, project } = await setupBase()
    writeFileSync(join(project.repoPath, "feature.ts"), "export const feature = 'old'\n", "utf8")
    writeFileSync(join(project.repoPath, "feature.test.ts"), "import './feature.js'\n", "utf8")
    execFileSync("git", ["add", "feature.ts", "feature.test.ts"], { cwd: project.repoPath })
    execFileSync("git", ["commit", "-m", "seed covered feature"], { cwd: project.repoPath, stdio: "ignore" })
    writeFileSync(join(project.repoPath, "feature.ts"), "export const feature = 'new'\n", "utf8")
    writeFileSync(join(project.repoPath, "feature.test.ts"), "", "utf8")
    execFileSync("git", ["add", "feature.ts", "feature.test.ts"], { cwd: project.repoPath })
    execFileSync("git", ["commit", "-m", "change feature without coverage"], {
      cwd: project.repoPath,
      stdio: "ignore"
    })
    const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: project.repoPath, encoding: "utf8" }).trim()
    const task = store.createTask({
      projectRef: project.id,
      title: "Change a covered feature",
      kind: "implement",
      taskPackage: {
        version: 1,
        generatedAt: new Date().toISOString(),
        repoProfile: "test-profile",
        likelyOwnershipLane: "frontend",
        laneReason: "test",
        inferenceSignals: [],
        requiredReading: ["feature.ts", "feature.test.ts"],
        verificationChecklist: ["npm test"],
        contractUpdateReminders: [],
        repoNotes: [],
        acceptanceCriteria: ["Focused unit tests cover the changed feature behavior."]
      }
    })
    const run = store.createRun({
      companyId: company.id,
      projectId: project.id,
      taskId: task.id,
      adapterType: "gemini_local",
      kind: "implement"
    })
    store.completeRun(run.id, {
      status: "succeeded",
      headSha,
      verificationSummary: "npm test: 1 passed",
      responseText: "feature changed and existing tests passed"
    })

    const result = reviewCompletedRun!(store, run.id)

    expect(result.outcome).toBe("needs_tests")
    expect(result.findings.some((finding) => finding.summary.includes("adds no verification assertions"))).toBe(true)
    expect(result.inspectedAcceptanceCriteria).toContain("Focused unit tests cover")
    store.close()
  })

  it("requests UI implementation when acceptance criteria are satisfied only by contracts, imports, and tests", async () => {
    const { store, company, project } = await setupBase()
    writeFileSync(join(project.repoPath, "apiTypes.ts"), "export const EvidenceSchema = { complete: true }\n", "utf8")
    writeFileSync(
      join(project.repoPath, "IncidentDetail.tsx"),
      "export function IncidentDetail() { return <section>Incident</section> }\n",
      "utf8"
    )
    writeFileSync(join(project.repoPath, "IncidentDetail.test.tsx"), "import './IncidentDetail.js'\n", "utf8")
    execFileSync("git", ["add", "apiTypes.ts", "IncidentDetail.tsx", "IncidentDetail.test.tsx"], {
      cwd: project.repoPath
    })
    execFileSync("git", ["commit", "-m", "seed incident detail"], { cwd: project.repoPath, stdio: "ignore" })
    writeFileSync(
      join(project.repoPath, "apiTypes.ts"),
      "export const EvidenceSchema = { complete: true, hasSourceTitle: false }\n",
      "utf8"
    )
    writeFileSync(
      join(project.repoPath, "IncidentDetail.tsx"),
      "import type { EvidenceSchema } from './apiTypes.js'\nexport function IncidentDetail() { return <section>Incident</section> }\n",
      "utf8"
    )
    writeFileSync(
      join(project.repoPath, "IncidentDetail.test.tsx"),
      "import './IncidentDetail.js'\nexpect(true).toBe(true)\n",
      "utf8"
    )
    execFileSync("git", ["add", "apiTypes.ts", "IncidentDetail.tsx", "IncidentDetail.test.tsx"], {
      cwd: project.repoPath
    })
    execFileSync("git", ["commit", "-m", "add contract without incident workflow"], {
      cwd: project.repoPath,
      stdio: "ignore"
    })
    const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: project.repoPath, encoding: "utf8" }).trim()
    const task = store.createTask({
      projectRef: project.id,
      title: "Triage incomplete incident metadata",
      kind: "implement",
      taskPackage: {
        version: 1,
        generatedAt: new Date().toISOString(),
        repoProfile: "test-profile",
        likelyOwnershipLane: "frontend",
        laneReason: "test",
        inferenceSignals: [],
        requiredReading: ["apiTypes.ts", "IncidentDetail.tsx"],
        verificationChecklist: ["npm test"],
        contractUpdateReminders: [],
        repoNotes: [],
        acceptanceCriteria: [
          "Incident detail presents an actionable incomplete-metadata review section with accessible source actions.",
          "Focused component tests cover complete and incomplete evidence."
        ]
      }
    })
    const run = store.createRun({
      companyId: company.id,
      projectId: project.id,
      taskId: task.id,
      adapterType: "gemini_local",
      kind: "implement"
    })
    store.completeRun(run.id, {
      status: "succeeded",
      headSha,
      verificationSummary: "npm test: 1 passed",
      responseText: "contract and tests updated"
    })

    const result = reviewCompletedRun!(store, run.id)

    expect(result.outcome).toBe("request_changes")
    expect(result.findings.some((finding) => finding.summary.includes("adds no executable UI change"))).toBe(true)
    store.close()
  })

  function installExecutionCompatibility(repoPath: string): void {
    const profile = loadProjectProfile!("minimal-repo")
    profile.executionPolicy = loadProjectProfile!("lawyerrag").executionPolicy
    mkdirSync(join(repoPath, ".openclaw"), { recursive: true })
    writeFileSync(join(repoPath, ".openclaw", "profile.json"), JSON.stringify(profile))
  }

  async function setupBase(options: { verifyCommand?: string | null } = {}) {
    const workspace = createTempWorkspace("dispatcher-executor")
    cleanups.push(workspace.cleanup)
    process.env.OPENCLAW_CODEX_ACCOUNTS_DIR = join(workspace.root, "codex-accounts")
    process.env.OPENCLAW_CODEX_AUTH_FILE = join(workspace.root, "codex-auth.json")
    mkdirSync(process.env.OPENCLAW_CODEX_ACCOUNTS_DIR, { recursive: true })
    const store = new DispatcherStore!(workspace.dbPath)
    store.migrate()
    const company = store.createCompany({ name: "Test Co" })
    const project = store.createProject({
      companyRef: company.id,
      name: "repo",
      repoPath: workspace.repoPath,
      verifyCommand: options.verifyCommand ?? null
    })
    initGitRepo(workspace.repoPath)
    return { workspace, store, company, project }
  }

  it("runs an implementation and inferred verification through an alternate repository profile", async () => {
    const { store, company, project } = await setupBase()
    cpSync(join(import.meta.dirname, "fixtures/profile-repositories/split-services"), project.repoPath, {
      recursive: true
    })
    mkdirSync(join(project.repoPath, ".openclaw"), { recursive: true })
    cpSync(join(project.repoPath, "profile.json"), join(project.repoPath, ".openclaw/profile.json"))
    execFileSync("git", ["add", "ui", "services"], { cwd: project.repoPath })
    execFileSync("git", ["commit", "-m", "seed alternate layout"], { cwd: project.repoPath, stdio: "ignore" })
    store.createAgent({ companyRef: company.id, name: "coder", role: "Engineer", adapterType: "codex_local" })
    const task = store.createTask({
      projectRef: project.id,
      title: "Support an empty catalog",
      kind: "implement",
      allowedPaths: ["ui/console"]
    })
    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async (context) => {
        writeFileSync(
          join(context.project.repoPath, "ui/console/src/catalog.js"),
          "export const total = (items = []) => items.reduce((sum, item) => sum + item, 0)\n"
        )
        writeFileSync(
          join(context.project.repoPath, "ui/console/src/item.test.js"),
          'import { total } from "./catalog.js"\nimport assert from "node:assert/strict"\nimport { test } from "node:test"\ntest("empty catalog", () => assert.equal(total(), 0))\n'
        )
        return { ok: true, response: "Implemented empty catalog support and a regression test." }
      })
    })
    try {
      await executor.tick()
      const run = store.getLatestRunForTask(task.id)!
      expect(run.status, run.errorText ?? "").toBe("succeeded")
      expect(run.verificationSummary).toContain("cd ui/console && npm test -- src/item.test.js")
    } finally {
      store.close()
    }
  })

  it("selects a dispatchable agent for adapter health instead of a paused registration", async () => {
    const { store, company } = await setupBase()
    store.createAgent({
      companyRef: company.id,
      name: "paused-gemini",
      role: "Paused Gemini",
      adapterType: "gemini_local",
      status: "paused",
      model: "gemini-3.1-pro"
    })
    const active = store.createAgent({
      companyRef: company.id,
      name: "opencode-fallback",
      role: "OpenCode Fallback",
      adapterType: "gemini_local",
      status: "idle",
      model: "opencode/big-pickle"
    })

    expect(selectAdapterHealthcheckAgent!(store.listAgents(company.id), "gemini_local")?.id).toBe(active.id)
    store.setAgentStatus(active.id, "paused")
    expect(selectAdapterHealthcheckAgent!(store.listAgents(company.id), "gemini_local")).toBeNull()
  })

  it("does not recover an empty run branch merely because its base commit was merged", async () => {
    const { store, project, workspace } = await setupBase()
    const task = store.createTask({
      projectRef: project.id,
      title: "Implement audit trail",
      kind: "implement"
    })
    const run = store.createRun({
      companyId: task.companyId,
      projectId: project.id,
      taskId: task.id,
      kind: "implement",
      adapterType: "codex_local"
    })
    const branchName = `openclaw/run/${run.id.slice(0, 8)}-implement-audit-trail`
    execFileSync("git", ["branch", branchName], { cwd: workspace.repoPath })

    expect(
      runBranchIsMergedIntoExecutionBase!(workspace.repoPath, task, {
        ...run,
        branchName
      })
    ).toBe(false)

    store.close()
  })

  it("does not recover a captured zero-diff run when main has the same generated commit subject", async () => {
    const { store, project, workspace } = await setupBase()
    const title = "Implement audit trail"
    writeFileSync(join(workspace.repoPath, "existing-audit.txt"), "already delivered\n", "utf8")
    execFileSync("git", ["add", "existing-audit.txt"], { cwd: workspace.repoPath })
    execFileSync("git", ["commit", "-m", `openclaw: ${title}`], {
      cwd: workspace.repoPath,
      stdio: "ignore"
    })
    const baseHead = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: workspace.repoPath,
      encoding: "utf8"
    }).trim()
    const task = store.createTask({
      projectRef: project.id,
      title,
      kind: "implement"
    })
    const run = store.createRun({
      companyId: task.companyId,
      projectId: project.id,
      taskId: task.id,
      kind: "implement",
      adapterType: "codex_local"
    })
    const branchName = `openclaw/run/${run.id.slice(0, 8)}-implement-audit-trail`
    store.appendRunEvent(run.id, "info", "Execution worktree changes captured", {
      branchName,
      headSha: baseHead,
      committed: false,
      skippedNestedGitCheckouts: []
    })
    store.completeRun(run.id, {
      status: "failed",
      branchName,
      headSha: baseHead,
      retryClass: "policy"
    })
    store.updateTaskStatus(task.id, "blocked", {
      blockedReason: "adapter_capability:policy",
      lastError: "Implementation produced no repository changes after verification."
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async () => ({ ok: true, response: "unused" }))
    })
    await executor.tick()

    expect(store.getRunById(run.id)).toMatchObject({ status: "failed" })
    expect(store.getTaskById(task.id)).toMatchObject({
      status: "blocked",
      blockedReason: "adapter_capability:policy"
    })
    expect(
      store
        .getRunEvents(run.id)
        .some((event) => event.message === "Recovered failed run after branch was already merged")
    ).toBe(false)

    store.close()
  })

  it("fetches each project origin once while recovering multiple merged failed runs", async () => {
    const { store, project, workspace } = await setupBase()
    const baseBranch = execFileSync("git", ["branch", "--show-current"], {
      cwd: workspace.repoPath,
      encoding: "utf8"
    }).trim()

    for (const suffix of ["first", "second"]) {
      const task = store.createTask({
        projectRef: project.id,
        title: `Recover merged ${suffix} change`,
        kind: "implement",
        reviewRequired: true
      })
      const run = store.createRun({
        companyId: task.companyId,
        projectId: project.id,
        taskId: task.id,
        kind: "implement",
        adapterType: "codex_local"
      })
      const branchName = `openclaw/run/${run.id.slice(0, 8)}-recover-${suffix}`
      execFileSync("git", ["switch", "-c", branchName], { cwd: workspace.repoPath, stdio: "ignore" })
      writeFileSync(join(workspace.repoPath, `${suffix}.txt`), `${suffix}\n`, "utf8")
      execFileSync("git", ["add", `${suffix}.txt`], { cwd: workspace.repoPath })
      execFileSync("git", ["commit", "-m", `openclaw: ${task.title}`], {
        cwd: workspace.repoPath,
        stdio: "ignore"
      })
      const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: workspace.repoPath,
        encoding: "utf8"
      }).trim()
      execFileSync("git", ["switch", baseBranch], { cwd: workspace.repoPath, stdio: "ignore" })
      execFileSync("git", ["merge", "--ff-only", branchName], { cwd: workspace.repoPath, stdio: "ignore" })
      store.completeRun(run.id, {
        status: "failed",
        branchName,
        headSha,
        retryClass: "unknown"
      })
      store.updateTaskStatus(task.id, "failed", { lastError: "stale failure after merge" })
    }

    for (const [suffix, lastRecoveryReason] of [
      ["retired", "blocked_state_retired_for_persona_ideation"],
      ["quarantined", "over_retry_quarantined"]
    ] as const) {
      const task = store.createTask({
        projectRef: project.id,
        title: `Keep ${suffix} merged change terminal`,
        kind: "implement",
        reviewRequired: true
      })
      const run = store.createRun({
        companyId: task.companyId,
        projectId: project.id,
        taskId: task.id,
        kind: "implement",
        adapterType: "codex_local"
      })
      const branchName = `openclaw/run/${run.id.slice(0, 8)}-${suffix}`
      execFileSync("git", ["switch", "-c", branchName], { cwd: workspace.repoPath, stdio: "ignore" })
      writeFileSync(join(workspace.repoPath, `${suffix}.txt`), `${suffix}\n`, "utf8")
      execFileSync("git", ["add", `${suffix}.txt`], { cwd: workspace.repoPath })
      execFileSync("git", ["commit", "-m", `openclaw: ${task.title}`], {
        cwd: workspace.repoPath,
        stdio: "ignore"
      })
      const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: workspace.repoPath,
        encoding: "utf8"
      }).trim()
      execFileSync("git", ["switch", baseBranch], { cwd: workspace.repoPath, stdio: "ignore" })
      execFileSync("git", ["merge", "--ff-only", branchName], { cwd: workspace.repoPath, stdio: "ignore" })
      store.completeRun(run.id, {
        status: "failed",
        branchName,
        headSha,
        retryClass: "unknown"
      })
      store.updateTaskStatus(task.id, "failed", {
        lastError: `terminal ${suffix} state`,
        lastRecoveryReason
      })
    }

    const tracePath = join(workspace.root, "git-trace.jsonl")
    const previousTrace = process.env.GIT_TRACE2_EVENT
    process.env.GIT_TRACE2_EVENT = tracePath
    try {
      const executor = new DispatcherExecutor!(store, {
        codex_local: fakeAdapter("codex_local", async () => ({ ok: true, response: "unused" }))
      })
      await executor.tick()
    } finally {
      if (previousTrace === undefined) delete process.env.GIT_TRACE2_EVENT
      else process.env.GIT_TRACE2_EVENT = previousTrace
    }

    const fetchStarts = readFileSync(tracePath, "utf8")
      .split("\n")
      .filter((line) => line.includes('"event":"start"') && line.includes('"fetch","origin"'))
    expect(fetchStarts).toHaveLength(1)
    expect(
      store
        .listProjectTasks(project.id)
        .filter((task) => task.title.startsWith("Recover merged "))
        .every((task) => task.status === "review_needed")
    ).toBe(true)
    expect(
      store
        .listProjectTasks(project.id)
        .filter((task) => task.title.startsWith("Keep "))
        .every((task) => task.status === "failed")
    ).toBe(true)

    store.close()
  })

  it("allows baseline component-size debt but rejects worsened violations", async () => {
    const { store, workspace } = await setupBase()
    installExecutionCompatibility(workspace.repoPath)
    const componentDir = join(workspace.repoPath, "apps", "reports-ui", "src")
    mkdirSync(componentDir, { recursive: true })
    const componentPath = join(componentDir, "LargePanel.tsx")
    writeFileSync(componentPath, `${Array.from({ length: 500 }, (_, index) => `// line ${index + 1}`).join("\n")}\n`)
    execFileSync("git", ["add", "apps/reports-ui/src/LargePanel.tsx"], { cwd: workspace.repoPath })
    execFileSync("git", ["commit", "-m", "add baseline component debt"], {
      cwd: workspace.repoPath,
      stdio: "ignore"
    })

    const baselineOutput = "Component size guard failed (1 file(s)).\n- src/LargePanel.tsx: 500 lines (max 450)"
    expect(componentSizeFailureIsNonWorsening!(workspace.repoPath, baselineOutput)).toBe(true)

    writeFileSync(componentPath, `${Array.from({ length: 501 }, (_, index) => `// line ${index + 1}`).join("\n")}\n`)
    const worsenedOutput = "Component size guard failed (1 file(s)).\n- src/LargePanel.tsx: 501 lines (max 450)"
    expect(componentSizeFailureIsNonWorsening!(workspace.repoPath, worsenedOutput)).toBe(false)

    store.close()
  })

  it("allows baseline feature-boundary debt but rejects a new cross-feature import", async () => {
    const { store, workspace } = await setupBase()
    installExecutionCompatibility(workspace.repoPath)
    const sourceDir = join(workspace.repoPath, "apps", "reports-ui", "src", "features", "incidents")
    mkdirSync(sourceDir, { recursive: true })
    const sourcePath = join(sourceDir, "IncidentDetail.tsx")
    writeFileSync(sourcePath, 'import { review } from "@/features/evidence/evidenceReview"\n')
    execFileSync("git", ["add", "apps/reports-ui/src/features/incidents/IncidentDetail.tsx"], {
      cwd: workspace.repoPath
    })
    execFileSync("git", ["commit", "-m", "add baseline feature-boundary debt"], {
      cwd: workspace.repoPath,
      stdio: "ignore"
    })

    const baselineOutput =
      "Feature boundary guard failed (1 import(s)).\n- src/features/incidents/IncidentDetail.tsx imports @/features/evidence/evidenceReview (feature: incidents -> evidence)"
    expect(featureBoundaryFailureIsNonWorsening!(workspace.repoPath, baselineOutput)).toBe(true)

    writeFileSync(
      sourcePath,
      'import { review } from "@/features/evidence/evidenceReview"\nimport { query } from "@/features/reviews/queryKeys"\n'
    )
    const worsenedOutput = `${baselineOutput}\n- src/features/incidents/IncidentDetail.tsx imports @/features/reviews/queryKeys (feature: incidents -> reviews)`
    expect(featureBoundaryFailureIsNonWorsening!(workspace.repoPath, worsenedOutput)).toBe(false)

    store.close()
  })

  it("allows inferred focused tests to improve baseline failures but rejects new failures", async () => {
    const { store, workspace } = await setupBase()
    const verificationScript = join(workspace.repoPath, "verify.cjs")
    writeFileSync(
      verificationScript,
      [
        'console.error("FAIL  src/feature.test.ts > feature > keeps baseline behavior")',
        'console.error("FAIL  src/feature.test.ts > feature > keeps second baseline behavior")',
        "process.exit(1)"
      ].join("\n"),
      "utf8"
    )
    execFileSync("git", ["add", "verify.cjs"], { cwd: workspace.repoPath })
    execFileSync("git", ["commit", "-m", "add baseline focused failures"], {
      cwd: workspace.repoPath,
      stdio: "ignore"
    })
    execFileSync("git", ["switch", "-c", "openclaw/run/improve-focused-test"], {
      cwd: workspace.repoPath,
      stdio: "ignore"
    })

    const improved = await focusedVerificationFailureIsNonWorsening!(
      workspace.repoPath,
      "node verify.cjs",
      "FAIL  src/feature.test.ts > feature > keeps baseline behavior"
    )
    expect(improved.nonWorsening).toBe(true)
    expect(improved.candidateFailures).toHaveLength(1)
    expect(improved.baselineFailures).toHaveLength(2)

    const regressed = await focusedVerificationFailureIsNonWorsening!(
      workspace.repoPath,
      "node verify.cjs",
      "FAIL  src/feature.test.ts > feature > introduces a new failure"
    )
    expect(regressed.nonWorsening).toBe(false)

    store.close()
  })

  it("recovers planner runs whose owning dispatcher process exited", async () => {
    const { store, company, project } = await setupBase()
    const plannerRun = store.createPlannerRun({
      companyId: company.id,
      projectId: project.id,
      trigger: "automation"
    })
    store.appendPlannerEvent(plannerRun.id, "planner-run-started", "Planner automation started.", {
      ownerPid: 424_242
    })

    expect(
      recoverDeadPlannerOwnerRuns!({
        store,
        projectId: project.id,
        ownerProcessIsAlive: () => false
      })
    ).toEqual([plannerRun.id])
    expect(store.getPlannerRunById(plannerRun.id)).toMatchObject({
      status: "failed",
      finishedAt: expect.any(String)
    })
    expect(store.getPlannerEvents(plannerRun.id).some((event) => event.kind === "planner-run-owner-recovered")).toBe(
      true
    )

    store.close()
  })

  it("disables backend pytest coverage for focused verification commands", () => {
    expect(
      normalizeVerificationCommand!(
        'cd apps/backend && uv run pytest tests/ -k "smart_scan" -q',
        {},
        loadProjectProfile!("lawyerrag").executionPolicy
      )
    ).toBe('cd apps/backend && uv run pytest tests/ -k "smart_scan" -q --no-cov')
    expect(
      normalizeVerificationCommand!(
        'cd apps/backend && uv run pytest --no-cov tests/contracts/ -v -m "contract or openapi"'
      )
    ).toBe('cd apps/backend && uv run pytest --no-cov tests/contracts/ -v -m "contract or openapi"')
    expect(normalizeVerificationCommand!("cd apps/reports-ui && npm test -- __contracts__/")).toBe(
      "cd apps/reports-ui && npm test -- __contracts__/"
    )
    expect(normalizeVerificationCommand!("pnpm test", { pnpm: false, corepack: true })).toBe("corepack pnpm test")
    expect(normalizeVerificationCommand!("pnpm test", { pnpm: true, corepack: true })).toBe("pnpm test")
  })

  it("repairs uniquely nested backend pytest targets before verification", () => {
    const workspace = createTempWorkspace("verification-path-repair")
    cleanups.push(workspace.cleanup)
    const nestedTest = join(workspace.repoPath, "apps", "backend", "lawyer_rag", "tests")
    mkdirSync(nestedTest, { recursive: true })
    writeFileSync(join(nestedTest, "test_case_guidance_service.py"), "")

    expect(
      repairBackendPytestPaths!(
        "cd apps/backend && uv run pytest tests/test_case_preparation_routes.py tests/test_case_guidance_service.py::test_grounding -q --no-cov",
        workspace.repoPath
      )
    ).toBe(
      "cd apps/backend && uv run pytest tests/test_case_preparation_routes.py lawyer_rag/tests/test_case_guidance_service.py::test_grounding -q --no-cov"
    )
    expect(repairBackendPytestPaths!("cd apps/reports-ui && npm test", workspace.repoPath)).toBe(
      "cd apps/reports-ui && npm test"
    )
  })

  it("allows long verification suites while bounding configured timeouts", () => {
    process.env.OPENCLAW_VERIFICATION_TIMEOUT_MS = "420000"
    expect(verificationTimeoutMs!()).toBe(420_000)

    process.env.OPENCLAW_VERIFICATION_TIMEOUT_MS = "1000"
    expect(verificationTimeoutMs!()).toBe(30_000)

    process.env.OPENCLAW_VERIFICATION_TIMEOUT_MS = "9000000"
    expect(verificationTimeoutMs!()).toBe(7_200_000)
  })

  it("applies repo profile response compression and records run telemetry", async () => {
    const { workspace, store, company, project } = await setupBase()
    const profile = loadProjectProfile!("minimal-repo")
    mkdirSync(join(workspace.repoPath, ".openclaw"), { recursive: true })
    writeFileSync(
      join(workspace.repoPath, ".openclaw", "profile.json"),
      JSON.stringify({ ...profile, responsePolicy: { compressionMode: "ultra" } }),
      "utf8"
    )
    store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Use compressed reporting"
    })
    let prompt = ""
    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async (context) => {
        prompt = context.prompt
        return { ok: true, response: "done", usage: { outputTokens: 1, totalTokens: 10 } }
      })
    })

    await executor.tick()

    expect(store.getTaskById(task.id).status).toBe("done")
    expect(prompt).toContain("Response compression: ultra")
    expect(store.getLatestRunForTask(task.id)?.metadata.responseCompression).toMatchObject({
      mode: "ultra",
      source: "profile",
      actualOutputTokens: 1
    })
    store.close()
  })

  it("runs only the explicitly targeted queued task", async () => {
    const { store, company, project } = await setupBase()
    store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const requested = store.createTask({
      projectRef: project.id,
      title: "Run this repair",
      priority: 1
    })
    const unrelated = store.createTask({
      projectRef: project.id,
      title: "Higher priority unrelated work",
      priority: 1000
    })
    const executedTaskIds: string[] = []
    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async (context) => {
        executedTaskIds.push(context.task.id)
        return { ok: true, response: "done" }
      })
    })

    const summary = await executor.runTask(requested.id)

    expect(summary.executedRuns).toBe(1)
    expect(summary.blockedTasks).toBe(0)
    expect(executedTaskIds).toEqual([requested.id])
    expect(store.getTaskById(requested.id).status).toBe("done")
    expect(store.getTaskById(unrelated.id).status).toBe("queued")
    store.close()
  })

  function initGitRepo(repoPath: string): boolean {
    try {
      execFileSync("git", ["init"], { cwd: repoPath, stdio: "ignore" })
      execFileSync("git", ["config", "user.email", "openclaw-test@example.test"], { cwd: repoPath })
      execFileSync("git", ["config", "user.name", "OpenClaw Test"], { cwd: repoPath })
      execFileSync("git", ["add", "README.md"], { cwd: repoPath })
      try {
        execFileSync("git", ["commit", "-m", "init"], { cwd: repoPath, stdio: "ignore" })
      } catch {}
      return true
    } catch {
      return false
    }
  }

  it("restores session state on retry", async () => {
    const { store, company, project } = await setupBase()
    const agent = store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Retry me",
      maxRetries: 2
    })

    let callCount = 0
    let secondRunSawSession = false

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async (context): Promise<AdapterExecutionResult> => {
        callCount += 1
        if (callCount === 2 && context.sessionState?.state.sessionId === "session-1") {
          secondRunSawSession = true
        }

        return callCount === 1
          ? {
              ok: false,
              response: "first failure",
              error: "fail once",
              sessionDisplayId: "session-1",
              sessionState: { sessionId: "session-1" }
            }
          : {
              ok: true,
              response: "recovered",
              sessionDisplayId: "session-1",
              sessionState: { sessionId: "session-1" }
            }
      }),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" })),
      azure_foundry: fakeAdapter("azure_foundry", async () => ({ ok: true, response: "unused" }))
    })

    await executor.tick()
    expect(store.getTaskById(task.id).status).toBe("queued")

    await executor.tick()
    expect(store.getTaskById(task.id).status).toBe("done")
    expect(secondRunSawSession).toBe(true)

    store.close()
  })

  it("self-prompts within a single autonomous run until the task is complete", async () => {
    process.env.OPENCLAW_AUTONOMOUS_EXECUTION_MODE = "1"
    process.env.OPENCLAW_AUTONOMOUS_EXECUTION_MAX_TURNS = "3"

    const { store, company, project } = await setupBase()
    store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Autonomous continuation"
    })

    const prompts: string[] = []
    let callCount = 0
    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async (context): Promise<AdapterExecutionResult> => {
        callCount += 1
        prompts.push(context.prompt)
        if (callCount === 1) {
          return {
            ok: true,
            response: [
              "Completed the first chunk of work.",
              "<openclaw-autonomous>",
              '{"action":"continue","summary":"Initial edits landed.","self_reflection":"The task still needs one follow-up pass.","next_prompt":"Finish the remaining task-local edits and summarize the result."}',
              "</openclaw-autonomous>"
            ].join("\n"),
            sessionDisplayId: "session-1",
            sessionState: { sessionId: "session-1" }
          }
        }

        return {
          ok: true,
          response: [
            "Finished the remaining work.",
            "<openclaw-autonomous>",
            '{"action":"complete","summary":"Task complete.","self_reflection":"No additional task-local work remains.","next_prompt":null}',
            "</openclaw-autonomous>"
          ].join("\n"),
          sessionDisplayId: "session-1",
          sessionState: { sessionId: "session-1" }
        }
      }),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" })),
      azure_foundry: fakeAdapter("azure_foundry", async () => ({ ok: true, response: "unused" }))
    })

    const summary = await executor.tick()

    expect(summary.executedRuns).toBe(1)
    expect(callCount).toBe(2)
    expect(prompts[0]).toContain("Autonomous execution mode is enabled for this run.")
    expect(prompts[0]).toContain("run only the narrowest focused check")
    expect(prompts[0]).toContain("the dispatcher runs every configured verification command after you return")
    expect(prompts[0]).not.toContain("run the task's verification commands")
    expect(prompts[1]).toContain("Autonomous continuation turn 2.")
    expect(prompts[1]).toContain("Finish the remaining task-local edits and summarize the result.")
    expect(store.getTaskById(task.id).status).toBe("done")
    expect(store.listRuns().length).toBe(1)
    expect(store.getLatestRunForTask(task.id)?.responseText).toContain("Finished the remaining work.")

    store.close()
  })

  it("emits waitable agent loop lifecycle, tool, and assistant events", async () => {
    const { store, company, project } = await setupBase()
    store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Agent loop event contract"
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async () => ({
        ok: true,
        response: "Implemented the requested task.",
        metadata: {
          adapterType: "codex_local",
          provider: "codex",
          model: "gpt-5.4",
          capabilities: fakeAdapter("codex_local", async () => ({ ok: true, response: "unused" })).capabilities,
          transport: "acpx"
        }
      })),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" })),
      azure_foundry: fakeAdapter("azure_foundry", async () => ({ ok: true, response: "unused" }))
    })

    await executor.tick()

    const run = store.getLatestRunForTask(task.id)!
    const wait = await waitForAgentRun!(store, run.id, { timeoutMs: 10, pollMs: 1 })
    const events = readAgentLoopEvents!(store, run.id)

    expect(wait).toMatchObject({
      status: "ok",
      runId: run.id,
      startedAt: run.startedAt,
      endedAt: run.finishedAt
    })
    expect(events.filter((event) => event.stream === "lifecycle").map((event) => event.phase)).toEqual(["start", "end"])
    expect(events.filter((event) => event.stream === "tool").map((event) => event.phase)).toEqual(["start", "end"])
    expect(events.find((event) => event.stream === "assistant")?.payload.delta).toContain("Implemented")
    expect(store.getRunById(run.id).metadata?.agentLoop).toMatchObject({
      version: 1,
      sessionKey: run.sessionKey,
      streams: ["lifecycle", "assistant", "tool"]
    })

    store.close()
  })

  it("blocks terminal adapter blocker packages instead of marking them done", async () => {
    const { store, company, project } = await setupBase()
    store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Blocked package",
      kind: "implement"
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async () => ({
        ok: true,
        response: [
          "```yaml",
          "task_package:",
          "  dispatch_status: blocked",
          "  blocker:",
          "    reason: Missing lane exception prevents safe edits.",
          "```",
          "",
          "Blocked as a coding dispatch package. No files were changed."
        ].join("\n")
      })),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" })),
      azure_foundry: fakeAdapter("azure_foundry", async () => ({ ok: true, response: "unused" }))
    })

    const summary = await executor.tick()
    const updated = store.getTaskById(task.id)
    const run = store.getLatestRunForTask(task.id)

    expect(summary.executedRuns).toBe(1)
    expect(updated.status).toBe("blocked")
    expect(updated.blockedReason).toBe("autonomous_blocked")
    expect(updated.lastError).toContain("dispatch_status: blocked")
    expect(run?.verificationSummary).toBe("autonomous-blocked")
    expect(store.getTaskEvents(task.id).some((event) => event.kind === "autonomous-blocked")).toBe(true)

    store.close()
  })

  it("preserves implementation edits when autonomous execution reports a blocker", async () => {
    const { store, company, project } = await setupBase()
    store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Partially implemented blocked package",
      kind: "implement"
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async (context) => {
        writeFileSync(join(context.project.repoPath, "blocked-change.txt"), "preserve me\n")
        return {
          ok: true,
          response: [
            "```yaml",
            "task_package:",
            "  dispatch_status: blocked",
            "  blocker:",
            "    reason: Broader contract scope required.",
            "```",
            "",
            "Implemented and tested the in-scope repair."
          ].join("\n")
        }
      }),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" })),
      azure_foundry: fakeAdapter("azure_foundry", async () => ({ ok: true, response: "unused" }))
    })

    await executor.tick()

    const updated = store.getTaskById(task.id)
    const run = store.getLatestRunForTask(task.id)
    expect(updated.status).toBe("blocked")
    expect(updated.lastError).toContain("Implementation worktree preserved for repair")
    expect(run?.worktreePath).toBeTruthy()
    expect(existsSync(join(run!.worktreePath!, "blocked-change.txt"))).toBe(true)
    expect(
      store.getRunEvents(run!.id).some((event) => event.message === "Execution worktree preserved after failure")
    ).toBe(true)
    expect(store.getRunEvents(run!.id).some((event) => event.message === "Execution worktree cleaned up")).toBe(false)

    store.close()
  })

  it("blocks implementation runs that explicitly make no code changes", async () => {
    const { store, company, project } = await setupBase()
    store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Implementation that only reports",
      kind: "implement"
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async () => ({
        ok: true,
        response: "I did not make code changes. This is a diagnostic package only."
      })),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" })),
      azure_foundry: fakeAdapter("azure_foundry", async () => ({ ok: true, response: "unused" }))
    })

    const summary = await executor.tick()
    const updated = store.getTaskById(task.id)

    expect(summary.executedRuns).toBe(1)
    expect(updated.status).toBe("blocked")
    expect(updated.blockedReason).toBe("autonomous_blocked")
    expect(updated.lastError).toContain("I did not make code changes")

    store.close()
  })

  it("rotates persisted sessions when compaction thresholds are exceeded", async () => {
    const { store, company, project } = await setupBase()
    const agent = store.createAgent({
      companyRef: company.id,
      name: "gemini",
      role: "Engineer",
      adapterType: "gemini_local",
      env: {
        OPENCLAW_SESSION_COMPACTION_MAX_RAW_INPUT_TOKENS: "5000"
      }
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Rotate my session"
    })
    const sessionKey = `${agent.id}:${project.id}:${task.id}`
    store.upsertSessionState({
      sessionKey,
      companyId: company.id,
      projectId: project.id,
      taskId: task.id,
      agentId: agent.id,
      adapterType: agent.adapterType,
      sessionDisplayId: "gemini-session-old",
      state: {
        sessionId: "gemini-session-old",
        __openclaw_session_v1: {
          version: 1,
          createdAt: "2026-04-10T00:00:00Z",
          updatedAt: "2026-04-10T00:00:00Z",
          runCount: 1,
          accumulatedRawInputTokens: 6000,
          lastPromptTokens: 6000,
          lastBudget: {
            band: "large",
            budgetTokens: 8000,
            estimatedBeforeTokens: 10000,
            estimatedAfterTokens: 6000,
            compactionApplied: true,
            reasons: ["replaced oversized file inclusions with orientation-only attachment summaries"],
            selectedFiles: ["README.md"],
            summarizedFiles: [],
            rawArtifactTokens: 9000,
            attachments: [
              {
                path: "README.md",
                kind: "reference",
                inclusion: "reference",
                estimatedTokens: 150,
                rawEstimatedTokens: 9000,
                oversized: true,
                truncated: true,
                byteSize: 36000
              }
            ]
          },
          lastAttachments: [
            {
              path: "README.md",
              kind: "reference",
              inclusion: "reference",
              estimatedTokens: 150,
              rawEstimatedTokens: 9000,
              oversized: true,
              truncated: true,
              byteSize: 36000
            }
          ],
          lastCompactionReasons: ["replaced oversized file inclusions with orientation-only attachment summaries"],
          lastResponseSummary: "Prior run summarized the oversized README."
        }
      }
    })

    let resumedSessionId: string | null = "unset"
    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async () => ({ ok: true, response: "unused" })),
      gemini_local: fakeAdapter("gemini_local", async (context): Promise<AdapterExecutionResult> => {
        resumedSessionId =
          context.sessionState?.state && typeof context.sessionState.state.sessionId === "string"
            ? context.sessionState.state.sessionId
            : null
        return {
          ok: true,
          response: "fresh session established",
          continuation: {
            sessionDisplayId: "gemini-session-new",
            state: { sessionId: "gemini-session-new" }
          }
        }
      }),
      azure_foundry: fakeAdapter("azure_foundry", async () => ({ ok: true, response: "unused" }))
    })

    await executor.tick()

    expect(resumedSessionId).toBeNull()
    const refreshedSession = store.getSessionState(sessionKey)
    expect(refreshedSession?.sessionDisplayId).toBe("gemini-session-new")
    expect(
      (refreshedSession?.state.__openclaw_session_v1 as { accumulatedRawInputTokens?: number })
        .accumulatedRawInputTokens
    ).toBeGreaterThan(6000)
    const run = store.getLatestRunForTask(task.id)!
    expect(store.getRunEvents(run.id).some((event) => event.message === "Session rotation applied")).toBe(true)

    store.close()
  })

  it("defers Codex execution when cached account quotas are exhausted", async () => {
    const { store, company, project, workspace } = await setupBase()
    store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Blocked by Codex quota"
    })

    const accountsDir = join(workspace.root, "codex", "accounts")
    const authFile = join(workspace.root, "codex", "auth.json")
    mkdirSync(accountsDir, { recursive: true })
    const authSnapshot = JSON.stringify({ account: "alpha" }, null, 2)
    writeFileSync(join(accountsDir, "alpha.json"), authSnapshot, "utf8")
    writeFileSync(authFile, authSnapshot, "utf8")
    writeFileSync(
      join(accountsDir, ".alpha.quota.json"),
      JSON.stringify({
        cached_at: Math.floor(Date.now() / 1000),
        rate_limits: {
          primary: { used_percent: 100, resets_at: Math.floor(Date.now() / 1000) + 3600 },
          secondary: { used_percent: 100, resets_at: Math.floor(Date.now() / 1000) + 86400 }
        }
      }),
      "utf8"
    )
    process.env.OPENCLAW_CODEX_ACCOUNTS_DIR = accountsDir
    process.env.OPENCLAW_CODEX_AUTH_FILE = authFile

    let codexCalls = 0
    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async (): Promise<AdapterExecutionResult> => {
        codexCalls += 1
        return { ok: true, response: "should not run" }
      }),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" })),
      azure_foundry: fakeAdapter("azure_foundry", async () => ({ ok: true, response: "unused" }))
    })

    const summary = await executor.tick()
    expect(summary.executedRuns).toBe(0)
    expect(summary.skippedTasks).toBe(1)
    expect(codexCalls).toBe(0)
    expect(store.getTaskById(task.id).status).toBe("queued")
    expect(store.getTaskEvents(task.id).some((event) => event.kind === "codex-quota-deferred")).toBe(true)

    store.close()
  })

  it("does not apply managed Codex account exhaustion to a custom Codex-compatible command", async () => {
    const { store, company, project, workspace } = await setupBase()
    store.createAgent({
      companyRef: company.id,
      name: "custom-codex",
      role: "Engineer",
      adapterType: "codex_local",
      command: join(workspace.root, "custom-codex-compatible")
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Run through the independent Codex-compatible lane"
    })

    const accountsDir = join(workspace.root, "codex", "accounts")
    const authFile = join(workspace.root, "codex", "auth.json")
    mkdirSync(accountsDir, { recursive: true })
    const authSnapshot = JSON.stringify({ account: "alpha" }, null, 2)
    writeFileSync(join(accountsDir, "alpha.json"), authSnapshot, "utf8")
    writeFileSync(authFile, authSnapshot, "utf8")
    writeFileSync(
      join(accountsDir, ".alpha.quota.json"),
      JSON.stringify({
        cached_at: Math.floor(Date.now() / 1000),
        rate_limits: {
          primary: { used_percent: 100, resets_at: Math.floor(Date.now() / 1000) + 3600 },
          secondary: { used_percent: 100, resets_at: Math.floor(Date.now() / 1000) + 86400 }
        }
      }),
      "utf8"
    )
    process.env.OPENCLAW_CODEX_ACCOUNTS_DIR = accountsDir
    process.env.OPENCLAW_CODEX_AUTH_FILE = authFile

    let customCalls = 0
    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async (): Promise<AdapterExecutionResult> => {
        customCalls += 1
        return { ok: true, response: "custom lane completed" }
      }),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" })),
      azure_foundry: fakeAdapter("azure_foundry", async () => ({ ok: true, response: "unused" }))
    })

    const summary = await executor.tick()
    expect(summary.executedRuns).toBe(1)
    expect(customCalls).toBe(1)
    expect(store.getTaskById(task.id).status).toBe("done")
    expect(store.getTaskEvents(task.id).some((event) => event.kind === "codex-quota-deferred")).toBe(false)

    store.close()
  })

  it("does not apply direct Codex account exhaustion to native OpenClaw transport", async () => {
    const { store, company, project, workspace } = await setupBase()
    store.createAgent({
      companyRef: company.id,
      name: "native-openclaw-codex",
      role: "OpenClaw native engineer",
      adapterType: "codex_local",
      env: { OPENCLAW_CODEX_TRANSPORT: "native" }
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Run through the native OpenClaw session lane",
      kind: "implement"
    })

    const accountsDir = join(workspace.root, "codex", "accounts")
    const authFile = join(workspace.root, "codex", "auth.json")
    mkdirSync(accountsDir, { recursive: true })
    const authSnapshot = JSON.stringify({ account: "alpha" }, null, 2)
    writeFileSync(join(accountsDir, "alpha.json"), authSnapshot, "utf8")
    writeFileSync(authFile, authSnapshot, "utf8")
    writeFileSync(
      join(accountsDir, ".alpha.quota.json"),
      JSON.stringify({
        cached_at: Math.floor(Date.now() / 1000),
        rate_limits: {
          primary: { used_percent: 100, resets_at: Math.floor(Date.now() / 1000) + 3600 },
          secondary: { used_percent: 100, resets_at: Math.floor(Date.now() / 1000) + 86400 }
        }
      }),
      "utf8"
    )
    process.env.OPENCLAW_CODEX_ACCOUNTS_DIR = accountsDir
    process.env.OPENCLAW_CODEX_AUTH_FILE = authFile

    let nativeCalls = 0
    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async (context): Promise<AdapterExecutionResult> => {
        nativeCalls += 1
        writeFileSync(join(context.project.repoPath, "native-openclaw.txt"), "native session edited\n", "utf8")
        return { ok: true, response: "native OpenClaw lane completed" }
      }),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" })),
      azure_foundry: fakeAdapter("azure_foundry", async () => ({ ok: true, response: "unused" }))
    })

    const summary = await executor.tick()
    expect(summary.executedRuns).toBe(1)
    expect(nativeCalls).toBe(1)
    expect(store.getTaskById(task.id).status).toBe("done")
    expect(store.getTaskEvents(task.id).some((event) => event.kind === "codex-quota-deferred")).toBe(false)

    store.close()
  })

  it("honors explicit Codex concurrency caps even when quota cache is unknown", async () => {
    process.env.OPENCLAW_MAX_CONCURRENT_CODEX_RUNS = "1"
    const { store, company, project } = await setupBase()
    store.createAgent({
      companyRef: company.id,
      name: "codex-one",
      role: "Engineer",
      adapterType: "codex_local"
    })
    store.createAgent({
      companyRef: company.id,
      name: "codex-two",
      role: "Engineer",
      adapterType: "codex_local"
    })
    store.createAgent({
      companyRef: company.id,
      name: "foundry-text",
      role: "Planner",
      adapterType: "azure_foundry"
    })
    const first = store.createTask({
      projectRef: project.id,
      title: "First Codex task",
      kind: "implement"
    })
    const second = store.createTask({
      projectRef: project.id,
      title: "Second Codex task",
      kind: "implement"
    })

    let releaseFirst: ((result: AdapterExecutionResult) => void) | null = null
    const firstResult = new Promise<AdapterExecutionResult>((resolve) => {
      releaseFirst = resolve
    })
    let codexCalls = 0
    let foundryCalls = 0
    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async (context): Promise<AdapterExecutionResult> => {
        codexCalls += 1
        if (codexCalls === 1) {
          writeFileSync(join(context.project.repoPath, "first-codex.txt"), "first completed\n", "utf8")
          return firstResult
        }
        return { ok: true, response: "unexpected second run" }
      }),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" })),
      azure_foundry: fakeAdapter("azure_foundry", async () => {
        foundryCalls += 1
        return { ok: true, response: "should not run repo execution" }
      })
    })

    const tick = executor.tick()
    for (let attempts = 0; attempts < 50 && codexCalls === 0; attempts += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(codexCalls).toBe(1)
    releaseFirst?.({ ok: true, response: "first completed" })

    const summary = await tick

    expect(summary.executedRuns).toBe(1)
    expect(summary.skippedTasks).toBe(1)
    expect(codexCalls).toBe(1)
    expect(foundryCalls).toBe(0)
    expect(store.getTaskById(first.id).status).toBe("done")
    expect(store.getTaskById(second.id).status).toBe("queued")
    expect(store.getTaskEvents(second.id).some((event) => event.kind === "codex-quota-deferred")).toBe(true)

    store.close()
  })

  it("defers worktree-backed execution before checkout when disk headroom is too low", async () => {
    const { store, company, project } = await setupBase()
    if (!initGitRepo(project.repoPath)) {
      store.close()
      return
    }
    process.env.OPENCLAW_MIN_WORKTREE_FREE_BYTES = String(Number.MAX_SAFE_INTEGER)
    process.env.OPENCLAW_MIN_WORKTREE_FREE_PERCENT = "0"

    store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Implement disk-sensitive task",
      kind: "implement"
    })

    let codexCalls = 0
    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async (): Promise<AdapterExecutionResult> => {
        codexCalls += 1
        return { ok: true, response: "should not run" }
      }),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" })),
      azure_foundry: fakeAdapter("azure_foundry", async () => ({ ok: true, response: "unused" }))
    })

    const summary = await executor.tick()

    expect(summary.executedRuns).toBe(0)
    expect(summary.skippedTasks).toBe(1)
    expect(codexCalls).toBe(0)
    expect(store.listRuns()).toHaveLength(0)
    expect(store.getTaskById(task.id).status).toBe("queued")
    expect(store.getTaskEvents(task.id).some((event) => event.kind === "worktree-disk-deferred")).toBe(true)

    store.close()
  })

  it("refreshes shared worktree dependencies before verification", async () => {
    const { store, company, project } = await setupBase()
    installExecutionCompatibility(project.repoPath)
    if (!initGitRepo(project.repoPath)) {
      store.close()
      return
    }
    mkdirSync(join(project.repoPath, "apps", "reports-ui", "node_modules", ".bin"), { recursive: true })
    writeFileSync(
      join(project.repoPath, "apps", "reports-ui", "node_modules", ".bin", "vitest"),
      "#!/bin/sh\nexit 0\n",
      "utf8"
    )
    store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Verify with shared UI dependencies",
      kind: "implement",
      verificationCommands: ['sh -c "test -f apps/reports-ui/node_modules/.bin/vitest"']
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async (context): Promise<AdapterExecutionResult> => {
        rmSync(join(context.project.repoPath, "apps", "reports-ui", "node_modules"), {
          recursive: true,
          force: true
        })
        writeFileSync(join(context.project.repoPath, "README.md"), "# temp repo\nverified\n", "utf8")
        return { ok: true, response: "implemented after removing dependency link" }
      }),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" })),
      azure_foundry: fakeAdapter("azure_foundry", async () => ({ ok: true, response: "unused" }))
    })

    const summary = await executor.tick()
    const run = store.getLatestRunForTask(task.id)!

    expect(summary.executedRuns).toBe(1)
    expect(store.getTaskById(task.id).status).toBe("done")
    expect(run.status).toBe("succeeded")
    expect(run.verificationSummary).toBe('sh -c "test -f apps/reports-ui/node_modules/.bin/vitest"')
    expect(
      store
        .getRunEvents(run.id)
        .some((event) => event.message === "Shared execution dependencies refreshed before verification")
    ).toBe(true)
    expect(existsSync(join(project.repoPath, "apps", "reports-ui", "node_modules", ".bin", "vitest"))).toBe(true)

    store.close()
  })

  it("keeps backend virtualenvs isolated between execution worktrees", async () => {
    const { store, company, project } = await setupBase()
    installExecutionCompatibility(project.repoPath)
    if (!initGitRepo(project.repoPath)) {
      store.close()
      return
    }
    mkdirSync(join(project.repoPath, "apps", "backend", ".venv"), { recursive: true })
    writeFileSync(join(project.repoPath, "apps", "backend", ".venv", "shared-marker"), "shared\n", "utf8")
    store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Verify with an isolated backend virtualenv",
      kind: "implement",
      verificationCommands: ['sh -c "test ! -L apps/backend/.venv"']
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async (context): Promise<AdapterExecutionResult> => {
        expect(existsSync(join(context.project.repoPath, "apps", "backend", ".venv"))).toBe(false)
        mkdirSync(join(context.project.repoPath, "apps", "backend"), { recursive: true })
        symlinkSync(
          join(project.repoPath, "apps", "backend", ".venv"),
          join(context.project.repoPath, "apps", "backend", ".venv"),
          "dir"
        )
        writeFileSync(join(context.project.repoPath, "README.md"), "# temp repo\nisolated\n", "utf8")
        return { ok: true, response: "implemented with isolated backend dependencies" }
      }),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" })),
      azure_foundry: fakeAdapter("azure_foundry", async () => ({ ok: true, response: "unused" }))
    })

    const summary = await executor.tick()
    const run = store.getLatestRunForTask(task.id)!
    const runEvents = store.getRunEvents(run.id)

    expect(summary.executedRuns).toBe(1)
    expect(store.getTaskById(task.id).status, JSON.stringify(runEvents)).toBe("done")
    expect(run.status).toBe("succeeded")
    expect(run.verificationSummary).toBe('sh -c "test ! -L apps/backend/.venv"')

    store.close()
  })

  it("repairs incomplete shared UI dependencies before linking a worktree", async () => {
    // This credential-free fixture explicitly exercises its own local install script.
    vi.stubEnv("npm_config_ignore_scripts", "false")
    const { store, company, project } = await setupBase()
    installExecutionCompatibility(project.repoPath)
    if (!initGitRepo(project.repoPath)) {
      store.close()
      return
    }
    const reportsUiPath = join(project.repoPath, "apps", "reports-ui")
    mkdirSync(reportsUiPath, { recursive: true })
    writeFileSync(
      join(reportsUiPath, "package.json"),
      JSON.stringify({
        name: "reports-ui",
        version: "1.0.0",
        scripts: { postinstall: "node repair-deps.cjs" }
      }),
      "utf8"
    )
    writeFileSync(
      join(reportsUiPath, "package-lock.json"),
      JSON.stringify({
        name: "reports-ui",
        version: "1.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: { "": { name: "reports-ui", version: "1.0.0", hasInstallScript: true } }
      }),
      "utf8"
    )
    writeFileSync(
      join(reportsUiPath, "repair-deps.cjs"),
      'const { mkdirSync, writeFileSync } = require("node:fs"); mkdirSync("node_modules/.bin", { recursive: true }); writeFileSync("node_modules/.bin/vitest", "#!/bin/sh\\nexit 0\\n");\n',
      "utf8"
    )
    execFileSync("git", ["add", "apps/reports-ui"], { cwd: project.repoPath })
    execFileSync("git", ["commit", "-m", "add reports ui fixture"], { cwd: project.repoPath, stdio: "ignore" })

    store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Repair shared UI dependencies",
      kind: "implement",
      verificationCommands: ['sh -c "test -f apps/reports-ui/node_modules/.bin/vitest"']
    })
    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async (context): Promise<AdapterExecutionResult> => {
        writeFileSync(join(context.project.repoPath, "README.md"), "# temp repo\nrepaired\n", "utf8")
        return { ok: true, response: "implemented with repaired dependencies" }
      }),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" })),
      azure_foundry: fakeAdapter("azure_foundry", async () => ({ ok: true, response: "unused" }))
    })

    const summary = await executor.tick()
    const run = store.getLatestRunForTask(task.id)!

    expect(summary.executedRuns, JSON.stringify(store.getTaskById(task.id))).toBe(1)
    expect(run.status, run.errorText ?? "").toBe("succeeded")
    expect(existsSync(join(reportsUiPath, "node_modules", ".bin", "vitest"))).toBe(true)

    store.close()
  })

  it("installs isolated UI dependencies when a worktree changes dependency manifests", async () => {
    // This credential-free fixture explicitly exercises its own local install script.
    vi.stubEnv("npm_config_ignore_scripts", "false")
    const { store, company, project } = await setupBase()
    installExecutionCompatibility(project.repoPath)
    if (!initGitRepo(project.repoPath)) {
      store.close()
      return
    }
    const reportsUiPath = join(project.repoPath, "apps", "reports-ui")
    mkdirSync(join(reportsUiPath, "node_modules", ".bin"), { recursive: true })
    writeFileSync(
      join(reportsUiPath, "package.json"),
      JSON.stringify({
        name: "reports-ui",
        version: "1.0.0",
        scripts: { postinstall: "node prepare-deps.cjs" }
      }),
      "utf8"
    )
    writeFileSync(
      join(reportsUiPath, "package-lock.json"),
      JSON.stringify({
        name: "reports-ui",
        version: "1.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: { "": { name: "reports-ui", version: "1.0.0", hasInstallScript: true } }
      }),
      "utf8"
    )
    writeFileSync(
      join(reportsUiPath, "prepare-deps.cjs"),
      'const { mkdirSync, writeFileSync } = require("node:fs"); const pkg = require("./package.json"); mkdirSync("node_modules/.bin", { recursive: true }); writeFileSync("node_modules/.bin/vitest", "#!/bin/sh\\nexit 0\\n"); writeFileSync("node_modules/installed-version.txt", pkg.version + "\\n");\n',
      "utf8"
    )
    writeFileSync(join(reportsUiPath, "node_modules", "installed-version.txt"), "1.0.0\n", "utf8")
    writeFileSync(join(reportsUiPath, "node_modules", ".bin", "vitest"), "#!/bin/sh\nexit 0\n", "utf8")
    execFileSync(
      "git",
      ["add", "apps/reports-ui/package.json", "apps/reports-ui/package-lock.json", "apps/reports-ui/prepare-deps.cjs"],
      {
        cwd: project.repoPath
      }
    )
    execFileSync("git", ["commit", "-m", "add reports ui dependency fixture"], {
      cwd: project.repoPath,
      stdio: "ignore"
    })

    store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Upgrade reports UI dependencies",
      kind: "implement",
      verificationCommands: [
        'sh -c "test ! -L apps/reports-ui/node_modules && test \\"$(cat apps/reports-ui/node_modules/installed-version.txt)\\" = 2.0.0"'
      ]
    })
    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async (context): Promise<AdapterExecutionResult> => {
        const executionUiPath = join(context.project.repoPath, "apps", "reports-ui")
        const nextPackage = {
          name: "reports-ui",
          version: "2.0.0",
          scripts: { postinstall: "node prepare-deps.cjs" }
        }
        const nextLock = {
          name: "reports-ui",
          version: "2.0.0",
          lockfileVersion: 3,
          requires: true,
          packages: { "": { name: "reports-ui", version: "2.0.0", hasInstallScript: true } }
        }
        writeFileSync(join(executionUiPath, "package.json"), JSON.stringify(nextPackage), "utf8")
        writeFileSync(join(executionUiPath, "package-lock.json"), JSON.stringify(nextLock), "utf8")
        return { ok: true, response: "upgraded reports UI dependencies" }
      }),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" })),
      azure_foundry: fakeAdapter("azure_foundry", async () => ({ ok: true, response: "unused" }))
    })

    const summary = await executor.tick()
    const run = store.getLatestRunForTask(task.id)!

    expect(summary.executedRuns, JSON.stringify(store.getTaskById(task.id))).toBe(1)
    expect(run.status, run.errorText ?? "").toBe("succeeded")
    expect(readFileSync(join(reportsUiPath, "node_modules", "installed-version.txt"), "utf8")).toBe("1.0.0\n")

    store.close()
  })

  it("bases execution worktrees on the default branch instead of the current stale branch", async () => {
    const { store, company, project } = await setupBase()
    if (!initGitRepo(project.repoPath)) {
      store.close()
      return
    }
    execFileSync("git", ["branch", "-M", "main"], { cwd: project.repoPath })
    execFileSync("git", ["switch", "-c", "openclaw/run/stale-stack"], {
      cwd: project.repoPath,
      stdio: "ignore"
    })
    writeFileSync(join(project.repoPath, "stale-only.txt"), "stale branch content\n", "utf8")
    execFileSync("git", ["add", "stale-only.txt"], { cwd: project.repoPath })
    execFileSync("git", ["commit", "-m", "stale branch"], { cwd: project.repoPath, stdio: "ignore" })

    store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Implement from clean base",
      kind: "implement"
    })

    let sawCleanBase = false
    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async (context): Promise<AdapterExecutionResult> => {
        sawCleanBase = !existsSync(join(context.project.repoPath, "stale-only.txt"))
        writeFileSync(join(context.project.repoPath, "worker.txt"), "created from clean base\n", "utf8")
        return { ok: true, response: "implemented from clean base" }
      }),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" })),
      azure_foundry: fakeAdapter("azure_foundry", async () => ({ ok: true, response: "unused" }))
    })

    await executor.tick()
    const run = store.getLatestRunForTask(task.id)!
    const allocation = store.getRunEvents(run.id).find((event) => event.message === "Execution worktree allocated")

    expect(sawCleanBase).toBe(true)
    expect(store.getTaskById(task.id).status).toBe("done")
    expect(run.status).toBe("succeeded")
    expect(allocation?.data?.baseRef).toBe("main")

    store.close()
  })

  it("bases review repairs on the rejected implementation instead of the default branch", async () => {
    const { store, company, project } = await setupBase()
    if (!initGitRepo(project.repoPath)) {
      store.close()
      return
    }
    execFileSync("git", ["branch", "-M", "main"], { cwd: project.repoPath })
    execFileSync("git", ["switch", "-c", "openclaw/run/rejected-review"], {
      cwd: project.repoPath,
      stdio: "ignore"
    })
    writeFileSync(join(project.repoPath, "review-target.txt"), "rejected implementation\n", "utf8")
    execFileSync("git", ["add", "review-target.txt"], { cwd: project.repoPath })
    execFileSync("git", ["commit", "-m", "rejected implementation"], {
      cwd: project.repoPath,
      stdio: "ignore"
    })
    const rejectedHead = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: project.repoPath,
      encoding: "utf8"
    }).trim()
    execFileSync("git", ["switch", "main"], { cwd: project.repoPath, stdio: "ignore" })

    store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const implementation = store.createTask({
      projectRef: project.id,
      title: "Rejected implementation",
      kind: "implement",
      reviewRequired: true
    })
    const implementationRun = store.createRun({
      companyId: company.id,
      projectId: project.id,
      taskId: implementation.id,
      adapterType: "codex_local",
      kind: "implement"
    })
    store.completeRun(implementationRun.id, {
      status: "succeeded",
      branchName: "openclaw/run/rejected-review",
      headSha: rejectedHead,
      verificationSummary: "tests passed"
    })
    store.updateTaskStatus(implementation.id, "blocked", {
      blockedReason: "review_outcome:request_changes"
    })
    const repair = store.createTask({
      projectRef: project.id,
      parentTaskId: implementation.id,
      title: "Repair rejected implementation",
      kind: "fix_review_feedback",
      labels: ["deterministic-fallback"],
      requestedAdapterType: "codex_local",
      reviewRequired: false,
      verificationCommands: ['sh -c "test -f tests/review-target.test.ts"']
    })

    let inheritedRejectedChange = false
    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async (context): Promise<AdapterExecutionResult> => {
        const targetPath = join(context.project.repoPath, "review-target.txt")
        inheritedRejectedChange =
          existsSync(targetPath) && readFileSync(targetPath, "utf8") === "rejected implementation\n"
        const testDir = join(context.project.repoPath, "tests")
        mkdirSync(testDir, { recursive: true })
        writeFileSync(join(testDir, "review-target.test.ts"), "it('covers the rejected implementation')\n", "utf8")
        return { ok: true, response: "added the requested focused review evidence" }
      }),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" })),
      azure_foundry: fakeAdapter("azure_foundry", async () => ({ ok: true, response: "unused" }))
    })

    await executor.tick()
    const repairRun = store.getLatestRunForTask(repair.id)!
    const allocation = store
      .getRunEvents(repairRun.id)
      .find((event) => event.message === "Execution worktree allocated")

    expect(inheritedRejectedChange).toBe(true)
    expect(store.getTaskById(repair.id).status).toBe("done")
    expect(repairRun.status).toBe("succeeded")
    expect(allocation?.data).toMatchObject({
      baseRef: "openclaw/run/rejected-review",
      repairSourceTaskId: implementation.id,
      repairSourceRunId: implementationRun.id,
      repairSourceRefKind: "local_branch"
    })
    expect(
      execFileSync("git", ["merge-base", "--is-ancestor", rejectedHead, repairRun.headSha!], {
        cwd: project.repoPath
      })
    ).toBeDefined()

    store.close()
  })

  it("bases repair tasks on the exact preserved failed run", async () => {
    const { store, company, project } = await setupBase()
    if (!initGitRepo(project.repoPath)) {
      store.close()
      return
    }
    execFileSync("git", ["branch", "-M", "main"], { cwd: project.repoPath })
    execFileSync("git", ["switch", "-c", "openclaw/run/preserved-repair-source"], {
      cwd: project.repoPath,
      stdio: "ignore"
    })
    writeFileSync(join(project.repoPath, "repair-target.txt"), "failed implementation\n", "utf8")
    execFileSync("git", ["add", "repair-target.txt"], { cwd: project.repoPath })
    execFileSync("git", ["commit", "-m", "preserve failed implementation"], {
      cwd: project.repoPath,
      stdio: "ignore"
    })
    const preservedHead = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: project.repoPath,
      encoding: "utf8"
    }).trim()
    execFileSync("git", ["switch", "main"], { cwd: project.repoPath, stdio: "ignore" })

    store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const implementation = store.createTask({
      projectRef: project.id,
      title: "Implementation needing repair",
      kind: "implement",
      changedFiles: ["repair-target.txt"]
    })
    const failedRun = store.createRun({
      companyId: company.id,
      projectId: project.id,
      taskId: implementation.id,
      adapterType: "codex_local",
      kind: "implement"
    })
    store.completeRun(failedRun.id, {
      status: "failed",
      branchName: "openclaw/run/preserved-repair-source",
      headSha: preservedHead,
      errorText: "Verification command failed",
      retryClass: "verification"
    })
    store.updateTaskStatus(implementation.id, "failed", {
      lastError: "Verification command failed"
    })
    const repair = store.createTask({
      projectRef: project.id,
      parentTaskId: implementation.id,
      title: "Repair failed implementation",
      kind: "repair",
      labels: [`repair-for:${failedRun.id}`],
      changedFiles: ["repair-target.txt"],
      allowedPaths: ["repair-target.txt"],
      requestedAdapterType: "codex_local",
      reviewRequired: false
    })

    let inheritedFailedChange = false
    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async (context): Promise<AdapterExecutionResult> => {
        const targetPath = join(context.project.repoPath, "repair-target.txt")
        inheritedFailedChange = existsSync(targetPath) && readFileSync(targetPath, "utf8") === "failed implementation\n"
        writeFileSync(targetPath, "repaired implementation\n", "utf8")
        return { ok: true, response: "repaired the preserved implementation" }
      }),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" })),
      azure_foundry: fakeAdapter("azure_foundry", async () => ({ ok: true, response: "unused" }))
    })

    await executor.tick()
    const repairRun = store.getLatestRunForTask(repair.id)!
    const allocation = store
      .getRunEvents(repairRun.id)
      .find((event) => event.message === "Execution worktree allocated")

    expect(inheritedFailedChange).toBe(true)
    expect(repairRun.status).toBe("succeeded")
    expect(repairRun.metadata?.changedFiles).toEqual(["repair-target.txt"])
    expect(allocation?.data).toMatchObject({
      baseRef: "openclaw/run/preserved-repair-source",
      inheritedSourceReason: "repair_source",
      repairSourceTaskId: implementation.id,
      repairSourceRunId: failedRun.id,
      repairSourceRefKind: "local_branch"
    })
    expect(
      execFileSync("git", ["merge-base", "--is-ancestor", preservedHead, repairRun.headSha!], {
        cwd: project.repoPath
      })
    ).toBeDefined()

    store.close()
  })

  it("blocks a preserved review repair with no delta before verification", async () => {
    const { workspace, store, company, project } = await setupBase()
    if (!initGitRepo(project.repoPath)) {
      store.close()
      return
    }
    execFileSync("git", ["branch", "-M", "main"], { cwd: project.repoPath })
    execFileSync("git", ["switch", "-c", "openclaw/run/rejected-review-no-delta"], {
      cwd: project.repoPath,
      stdio: "ignore"
    })
    writeFileSync(join(project.repoPath, "review-target.txt"), "rejected implementation\n", "utf8")
    execFileSync("git", ["add", "review-target.txt"], { cwd: project.repoPath })
    execFileSync("git", ["commit", "-m", "rejected implementation without evidence"], {
      cwd: project.repoPath,
      stdio: "ignore"
    })
    const rejectedHead = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: project.repoPath,
      encoding: "utf8"
    }).trim()
    execFileSync("git", ["switch", "main"], { cwd: project.repoPath, stdio: "ignore" })

    const agent = store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const implementation = store.createTask({
      projectRef: project.id,
      title: "Rejected implementation without evidence",
      kind: "implement",
      reviewRequired: true
    })
    const implementationRun = store.createRun({
      companyId: company.id,
      projectId: project.id,
      taskId: implementation.id,
      adapterType: "codex_local",
      kind: "implement"
    })
    store.completeRun(implementationRun.id, {
      status: "succeeded",
      branchName: "openclaw/run/rejected-review-no-delta",
      headSha: rejectedHead,
      verificationSummary: "source checks passed"
    })
    store.updateTaskStatus(implementation.id, "blocked", {
      blockedReason: "review_outcome:needs_tests"
    })

    const verificationMarker = join(workspace.root, "review-repair-verification-ran.txt")
    const repair = store.createTask({
      projectRef: project.id,
      parentTaskId: implementation.id,
      title: "Repair rejected implementation without evidence",
      kind: "fix_review_feedback",
      labels: ["deterministic-fallback"],
      requestedAdapterType: "codex_local",
      reviewRequired: false,
      verificationCommands: [`sh -c "printf ran > ${verificationMarker}"`],
      maxRetries: 0
    })

    const preservedBranch = "openclaw/run/preserved-empty-review-repair"
    const preservedRoot = join(project.repoPath, ".openclaw")
    const preservedWorktree = join(preservedRoot, "preserved-empty-review-repair")
    const preservedManifest = `${preservedWorktree}.manifest.json`
    mkdirSync(preservedRoot, { recursive: true })
    execFileSync("git", ["worktree", "add", "-b", preservedBranch, preservedWorktree, rejectedHead], {
      cwd: project.repoPath,
      stdio: "ignore"
    })
    writeFileSync(preservedManifest, "{}\n", "utf8")
    const preservedRun = store.createRun({
      companyId: company.id,
      projectId: project.id,
      taskId: repair.id,
      agentId: agent.id,
      adapterType: "codex_local",
      kind: "fix_review_feedback",
      worktreePath: preservedWorktree,
      manifestPath: preservedManifest
    })
    store.completeRun(preservedRun.id, {
      status: "failed",
      branchName: preservedBranch,
      headSha: rejectedHead,
      errorText: [
        "Review repair produced no usable changes.",
        `Implementation worktree preserved for repair: ${preservedWorktree}`
      ].join("\n"),
      retryClass: "transient"
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async () => ({
        ok: true,
        response: "I inspected the review finding and prepared an implementation plan."
      }))
    })

    await executor.tick()

    const retryRun = store.getLatestRunForTask(repair.id)!
    expect(retryRun.id).not.toBe(preservedRun.id)
    expect(store.getTaskById(repair.id)).toMatchObject({
      status: "blocked",
      lastError: expect.stringContaining("no repository changes beyond the inherited implementation")
    })
    expect(store.getRunEvents(retryRun.id).map((event) => event.message)).toContain(
      "Skipped verification for zero-diff review repair"
    )
    expect(store.getRunEvents(retryRun.id).map((event) => event.message)).not.toContain("Running verification command")
    expect(existsSync(verificationMarker)).toBe(false)
    expect(store.getRunById(preservedRun.id).worktreePath).toBeNull()
    expect(existsSync(preservedWorktree)).toBe(false)

    store.close()
  })

  it("accepts implementation commits created directly by the coding adapter", async () => {
    const { store, company, project } = await setupBase()
    if (!initGitRepo(project.repoPath)) {
      store.close()
      return
    }
    store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Commit implementation directly",
      kind: "implement"
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async (context): Promise<AdapterExecutionResult> => {
        writeFileSync(join(context.project.repoPath, "adapter-commit.txt"), "committed by adapter\n", "utf8")
        execFileSync("git", ["add", "adapter-commit.txt"], { cwd: context.project.repoPath })
        execFileSync("git", ["commit", "-m", "adapter-authored implementation"], {
          cwd: context.project.repoPath,
          stdio: "ignore"
        })
        return { ok: true, response: "implemented and committed" }
      }),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" })),
      azure_foundry: fakeAdapter("azure_foundry", async () => ({ ok: true, response: "unused" }))
    })

    await executor.tick()
    const run = store.getLatestRunForTask(task.id)!

    expect(store.getTaskById(task.id).status).toBe("done")
    expect(run.status).toBe("succeeded")
    expect(run.headSha).toBeTruthy()

    store.close()
  })

  it("preserves runtime identity continuity across execution-sweep retries", async () => {
    const { store, company, project } = await setupBase()
    store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Retry under heartbeat",
      maxRetries: 2
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
      lastTriggeredAt: new Date(Date.now() - 60_000).toISOString()
    })

    const runtimeKeys: string[] = []
    const executionKeys: string[] = []
    const wakeReasons: string[] = []
    const continuationSessionIds: Array<string | null> = []

    let callCount = 0
    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async (context): Promise<AdapterExecutionResult> => {
        callCount += 1
        runtimeKeys.push(context.runtimeIdentity.runtimeKey)
        executionKeys.push(context.runtimeIdentity.executionKey)
        wakeReasons.push(context.runtimeIdentity.wake.reason)
        continuationSessionIds.push(context.runtimeIdentity.continuation.sessionDisplayId)

        return callCount === 1
          ? {
              ok: false,
              response: "first failure",
              error: "fail once",
              metadata: {
                adapterType: "codex_local",
                provider: "codex",
                model: null,
                capabilities: {
                  supportsSessionResume: true,
                  supportsCompaction: true,
                  compactionStrategy: "rotate",
                  preferredPlanningContextWindow: null,
                  planningPriority: 100,
                  planningCostClass: "high",
                  nativeContextManagement: "confirmed",
                  heartbeatIdentityMode: "prompt_and_env",
                  defaultSessionCompaction: {
                    enabled: true,
                    maxSessionRuns: 0,
                    maxRawInputTokens: 0,
                    maxSessionAgeHours: 0
                  }
                }
              },
              continuation: {
                sessionDisplayId: "session-1",
                state: { sessionId: "session-1" }
              },
              runtimeIdentity: context.runtimeIdentity
            }
          : {
              ok: true,
              response: "recovered",
              metadata: {
                adapterType: "codex_local",
                provider: "codex",
                model: null,
                capabilities: {
                  supportsSessionResume: true,
                  supportsCompaction: true,
                  compactionStrategy: "rotate",
                  preferredPlanningContextWindow: null,
                  planningPriority: 100,
                  planningCostClass: "high",
                  nativeContextManagement: "confirmed",
                  heartbeatIdentityMode: "prompt_and_env",
                  defaultSessionCompaction: {
                    enabled: true,
                    maxSessionRuns: 0,
                    maxRawInputTokens: 0,
                    maxSessionAgeHours: 0
                  }
                }
              },
              continuation: {
                sessionDisplayId: "session-1",
                state: { sessionId: "session-1" }
              },
              runtimeIdentity: context.runtimeIdentity
            }
      }),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" }))
    })

    await executor.tick()
    await executor.tick()

    expect(runtimeKeys.length).toBeGreaterThanOrEqual(1)
    expect(runtimeKeys[0]).toBeDefined()
    expect(wakeReasons[0]).toBe("execution_sweep")
    if (runtimeKeys.length >= 2) {
      expect(runtimeKeys[1]).toBe(runtimeKeys[0])
      expect(executionKeys[0]).not.toBe(executionKeys[1])
      expect(continuationSessionIds).toEqual([null, "session-1"])
    }
    expect(store.getTaskById(task.id).status).toBe(runtimeKeys.length >= 2 ? "done" : "queued")

    store.close()
  })

  it("stops retrying and creates a follow-up task after max retries", async () => {
    const { store, company, project } = await setupBase()
    store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Always fail",
      maxRetries: 1
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async () => ({
        ok: false,
        response: "still failing",
        error: "broken"
      })),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" }))
    })

    await executor.tick()
    expect(store.getTaskById(task.id).status).toBe("queued")

    const secondSummary = await executor.tick()
    expect(secondSummary.followUpTasks).toBe(1)
    expect(store.getTaskById(task.id).status).toBe("failed")
    expect(store.listTasks().some((entry) => entry.title.startsWith("Follow-up: Always fail"))).toBe(true)

    store.close()
  })

  it("blocks queued tasks whose dependency failed instead of silently skipping forever", async () => {
    const { store, company, project } = await setupBase()
    store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const parent = store.createTask({
      projectRef: project.id,
      title: "Failed prerequisite"
    })
    store.updateTaskStatus(parent.id, "failed", {
      lastError: "verification failed"
    })
    const child = store.createTask({
      projectRef: project.id,
      title: "Dependent child",
      dependsOnTaskIds: [parent.id]
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async () => ({ ok: true, response: "should not run" })),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" })),
      azure_foundry: fakeAdapter("azure_foundry", async () => ({ ok: true, response: "unused" }))
    })

    const summary = await executor.tick()
    const updated = store.getTaskById(child.id)

    expect(summary.executedRuns).toBe(0)
    expect(summary.blockedTasks).toBe(1)
    expect(updated.status).toBe("blocked")
    expect(updated.blockedReason).toBe(`dependency_failed:${parent.id}`)
    expect(store.getTaskEvents(child.id).some((event) => event.kind === "dependency-blocked")).toBe(true)

    store.close()
  })

  it("does not release downstream coding while prerequisite code is only awaiting review", async () => {
    const { store, company, project } = await setupBase()
    store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const parent = store.createTask({
      projectRef: project.id,
      title: "Unmerged prerequisite",
      kind: "implement",
      reviewRequired: true
    })
    store.updateTaskStatus(parent.id, "review_needed")
    const child = store.createTask({
      projectRef: project.id,
      title: "Dependent implementation",
      kind: "implement",
      dependsOnTaskIds: [parent.id]
    })

    let adapterCalls = 0
    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async () => {
        adapterCalls += 1
        return { ok: true, response: "should not run" }
      }),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" }))
    })

    const summary = await executor.tick()

    expect(summary.executedRuns).toBe(0)
    expect(adapterCalls).toBe(0)
    expect(store.getTaskById(child.id).status).toBe("queued")

    store.close()
  })

  it("blocks verification failures instead of rerunning AI inference", async () => {
    const { store, company, project } = await setupBase()
    store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Implementation with deterministic verification failure",
      kind: "implement",
      verificationCommands: ["npm run check"],
      maxRetries: 3
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async () => ({
        ok: false,
        response: "check failed",
        error: [
          "Verification command failed: npm run check",
          "Temporary failure in name resolution",
          "Component size guard failed"
        ].join("\n")
      })),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" }))
    })

    const summary = await executor.tick()
    const updated = store.getTaskById(task.id)

    expect(summary.executedRuns).toBe(1)
    expect(summary.followUpTasks).toBe(0)
    expect(updated.status).toBe("blocked")
    expect(updated.retryCount).toBe(1)
    expect(updated.blockedReason).toBe("verification_failure:verification")
    expect(store.getLatestRunForTask(task.id)?.retryClass).toBe("verification")
    expect(store.getTaskEvents(task.id).some((event) => event.kind === "human-action-required")).toBe(true)

    store.close()
  })

  it("does not run unrelated verification for no-code ideation tasks", async () => {
    const { store, company, project } = await setupBase({ verifyCommand: 'sh -c "exit 42"' })
    store.createAgent({
      companyRef: company.id,
      name: "planner",
      role: "Planner",
      adapterType: "codex_local"
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Ideation: release observability guardrail quick wins",
      kind: "user",
      description: "Produce 3 narrow implementation-ready ideas. Do not edit code in this task.",
      labels: ["ideation", "release"],
      verificationCommands: ['sh -c "exit 42"'],
      maxRetries: 0
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async () => ({
        ok: true,
        response: "No code was edited. Ideas produced."
      })),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" }))
    })

    const summary = await executor.tick()
    const updated = store.getTaskById(task.id)
    const run = store.getLatestRunForTask(task.id)

    expect(summary.executedRuns).toBe(1)
    expect(updated.status).toBe("done")
    expect(updated.blockedReason).toBeNull()
    expect(run?.status).toBe("succeeded")
    expect(run?.verificationSummary).toBeNull()

    store.close()
  })

  it("defers transient infrastructure failures without charging a retry or creating a repair task", async () => {
    const { store, company, project } = await setupBase()
    store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Implementation with transient adapter timeout",
      kind: "implement",
      maxRetries: 2
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async () => ({
        ok: false,
        response: "",
        error: "adapter timed out waiting for transport"
      })),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" }))
    })

    const summary = await executor.tick()
    const updated = store.getTaskById(task.id)

    expect(summary.executedRuns).toBe(1)
    expect(summary.followUpTasks).toBe(0)
    expect(updated.status).toBe("queued")
    expect(updated.retryCount).toBe(0)
    expect(updated.blockedReason).toBeNull()
    expect(updated.scheduledAt).not.toBeNull()
    expect(Date.parse(updated.scheduledAt ?? "")).toBeGreaterThan(Date.now())
    expect(store.getLatestRunForTask(task.id)?.retryClass).toBe("transient")
    expect(store.listChildTasks(task.id, "fix_review_feedback")).toHaveLength(0)
    expect(store.getTaskEvents(task.id).find((event) => event.kind === "adapter-failure-deferred")?.data).toMatchObject(
      {
        adapterType: "codex_local",
        retryCharged: false,
        transientFailureAttempt: 1,
        retryClass: "transient"
      }
    )

    store.close()
  })

  it("backs off consecutive transient adapter failures instead of redispatching every sweep", async () => {
    const { store, company, project } = await setupBase()
    store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Implementation with repeated transport timeouts",
      kind: "implement",
      maxRetries: 0
    })
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const priorRun = store.createRun({
        companyId: company.id,
        projectId: project.id,
        taskId: task.id,
        kind: "implement",
        adapterType: "codex_local"
      })
      store.completeRun(priorRun.id, {
        status: "failed",
        errorText: "adapter timed out waiting for transport",
        retryClass: "transient"
      })
    }

    const previousBaseDelay = process.env.OPENCLAW_TRANSIENT_RETRY_BASE_DELAY_MS
    const previousMaxDelay = process.env.OPENCLAW_TRANSIENT_RETRY_MAX_DELAY_MS
    process.env.OPENCLAW_TRANSIENT_RETRY_BASE_DELAY_MS = "60000"
    process.env.OPENCLAW_TRANSIENT_RETRY_MAX_DELAY_MS = "600000"
    try {
      const executor = new DispatcherExecutor!(store, {
        codex_local: fakeAdapter("codex_local", async () => ({
          ok: false,
          response: "",
          error: "adapter timed out waiting for transport"
        }))
      })

      const before = Date.now()
      const firstSummary = await executor.tick()
      const updated = store.getTaskById(task.id)
      const scheduledAt = Date.parse(updated.scheduledAt ?? "")
      const secondSummary = await executor.tick()

      expect(firstSummary.executedRuns).toBe(1)
      expect(updated.status).toBe("queued")
      expect(updated.retryCount).toBe(0)
      expect(scheduledAt - before).toBeGreaterThanOrEqual(7 * 60 * 1000)
      expect(scheduledAt - before).toBeLessThanOrEqual(9 * 60 * 1000)
      expect(secondSummary.executedRuns).toBe(0)
      expect(
        store.getTaskEvents(task.id).find((event) => event.kind === "adapter-failure-deferred")?.data
      ).toMatchObject({
        transientFailureAttempt: 4,
        retryDelayMs: 8 * 60 * 1000
      })
    } finally {
      if (previousBaseDelay === undefined) delete process.env.OPENCLAW_TRANSIENT_RETRY_BASE_DELAY_MS
      else process.env.OPENCLAW_TRANSIENT_RETRY_BASE_DELAY_MS = previousBaseDelay
      if (previousMaxDelay === undefined) delete process.env.OPENCLAW_TRANSIENT_RETRY_MAX_DELAY_MS
      else process.env.OPENCLAW_TRANSIENT_RETRY_MAX_DELAY_MS = previousMaxDelay
      store.close()
    }
  })

  it("does not mistake Azure make-sure guidance for a make verification command", async () => {
    const { store, company, project } = await setupBase()
    store.createAgent({
      companyRef: company.id,
      name: "foundry",
      role: "Foundry fallback",
      adapterType: "azure_foundry"
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Retry a capacity-constrained Foundry fallback",
      kind: "follow_up"
    })

    const executor = new DispatcherExecutor!(store, {
      azure_foundry: fakeAdapter("azure_foundry", async () => ({
        ok: false,
        response: "",
        failureCategory: "quota",
        error: "HTTP 401 invalid subscription key. Make sure to provide a valid key. | HTTP 429 RateLimitReached"
      }))
    })

    const summary = await executor.tick()
    const updated = store.getTaskById(task.id)

    expect(summary.executedRuns).toBe(1)
    expect(updated.status).toBe("queued")
    expect(updated.blockedReason).toBeNull()
    expect(store.getLatestRunForTask(task.id)?.retryClass).toBe("transient")

    store.close()
  })

  it("does not create a code fix task when implementation validation needs a human patch", async () => {
    const { store, company, project } = await setupBase()
    store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Implement feature that fails checks",
      kind: "implement",
      labels: ["frontend"],
      changedFiles: ["src/feature.tsx"],
      verificationCommands: ["npm run check"],
      maxRetries: 0
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async () => ({
        ok: false,
        response: "check failed",
        error: "Component size guard failed"
      })),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" }))
    })

    const summary = await executor.tick()
    const updated = store.getTaskById(task.id)
    const fixTasks = store.listChildTasks(task.id, "fix_review_feedback")

    expect(summary.followUpTasks).toBe(0)
    expect(updated.status).toBe("blocked")
    expect(updated.blockedReason).toBe("verification_failure:verification")
    expect(fixTasks).toHaveLength(0)
    expect(store.getTaskEvents(task.id).some((event) => event.kind === "human-action-required")).toBe(true)

    store.close()
  })

  it("does not create recursive validation fix tasks when a validation fix fails", async () => {
    const { store, company, project } = await setupBase()
    store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Fix validation failure: Existing recovery task",
      kind: "fix_review_feedback",
      labels: ["validation-fix", "review-feedback", "validation-signature:abc123"],
      changedFiles: ["src/feature.tsx"],
      verificationCommands: ["npm run check"],
      maxRetries: 0
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async () => ({
        ok: false,
        response: "check failed",
        error: "Component size guard failed"
      })),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" }))
    })

    const summary = await executor.tick()
    const fixTasks = store.listProjectTasks(project.id).filter((entry) => entry.kind === "fix_review_feedback")

    expect(summary.followUpTasks).toBe(0)
    expect(store.getTaskById(task.id).status).toBe("blocked")
    expect(store.getTaskById(task.id).blockedReason).toBe("verification_failure:verification")
    expect(fixTasks).toHaveLength(1)
    expect(fixTasks[0]!.id).toBe(task.id)

    store.close()
  })

  it("blocks repeated validation failures without creating validation fix tasks", async () => {
    const { store, company, project } = await setupBase()
    store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local"
    })

    const firstTask = store.createTask({
      projectRef: project.id,
      title: "Frontend task that fails the same way",
      kind: "implement",
      labels: ["frontend"],
      changedFiles: ["src/component.tsx"],
      verificationCommands: ["npm run check"],
      priority: 50,
      maxRetries: 0
    })
    const secondTask = store.createTask({
      projectRef: project.id,
      title: "Another frontend task that fails the same way",
      kind: "implement",
      labels: ["frontend"],
      changedFiles: ["src/other-component.tsx"],
      verificationCommands: ["npm run check"],
      priority: 40,
      maxRetries: 0
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async () => ({
        ok: false,
        response: "check failed",
        error: "Component size guard failed"
      })),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" }))
    })

    await executor.tick()
    console.log("firstTask status after tick 1:", store.getTaskById(firstTask.id).status)
    console.log("secondTask status after tick 1:", store.getTaskById(secondTask.id).status)
    console.log(
      "Runs after tick 1:",
      store.listRuns().map((r) => ({ id: r.id, adapter: r.adapterType, status: r.status, errorText: r.errorText }))
    )
    const secondSummary = await executor.tick()
    console.log("firstTask status after tick 2:", store.getTaskById(firstTask.id).status)
    console.log("secondTask status after tick 2:", store.getTaskById(secondTask.id).status)
    console.log(
      "Runs after tick 2:",
      store.listRuns().map((r) => ({ id: r.id, adapter: r.adapterType, status: r.status, errorText: r.errorText }))
    )
    const fixTasks = store.listProjectTasks(project.id).filter((task) => task.kind === "fix_review_feedback")

    expect(secondSummary.followUpTasks).toBe(0)
    expect(fixTasks).toHaveLength(0)
    expect(store.getTaskById(firstTask.id).status).toBe("blocked")
    expect(store.getTaskById(secondTask.id).status).toBe("blocked")
    expect(store.getTaskById(firstTask.id).blockedReason).toBe("verification_failure:verification")
    expect(store.getTaskById(secondTask.id).blockedReason).toBe("verification_failure:verification")

    store.close()
  })

  it("does not create recursive follow-up tasks when a follow-up fails", async () => {
    const { store, company, project } = await setupBase()
    store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Follow-up: Always fail",
      labels: ["follow-up"],
      kind: "follow_up",
      maxRetries: 0
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async () => ({
        ok: false,
        response: "still failing",
        error: "broken"
      })),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" }))
    })

    const summary = await executor.tick()
    expect(summary.followUpTasks).toBe(0)
    expect(store.getTaskById(task.id).status).toBe("failed")
    expect(store.listChildTasks(task.id)).toHaveLength(0)

    store.close()
  })

  it("suppresses duplicate repo health follow-up creation when an equivalent follow-up is already queued", async () => {
    const { store, company, project } = await setupBase({ verifyCommand: "bash -lc 'exit 1'" })
    store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Repo health 2026-05-01",
      labels: ["automation", "repo-health"],
      kind: "review",
      source: "repo_health",
      maxRetries: 0
    })
    store.createTask({
      projectRef: project.id,
      title: "Follow-up: Repo health 2026-05-01",
      labels: ["automation", "repo-health", "follow-up"],
      kind: "follow_up"
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async () => ({
        ok: false,
        response: "still failing",
        error: "broken"
      })),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" }))
    })

    const summary = await executor.tick()
    expect(summary.followUpTasks).toBe(0)
    expect(store.getTaskById(task.id).status).toBe("failed")
    expect(
      store.listProjectTasks(project.id).filter((entry) => entry.title === "Follow-up: Repo health 2026-05-01")
    ).toHaveLength(1)

    store.close()
  })

  it("suppresses duplicate repo health follow-up creation when an equivalent follow-up completed recently", async () => {
    const { store, company, project } = await setupBase({ verifyCommand: "bash -lc 'exit 1'" })
    store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Repo health 2026-05-01",
      labels: ["automation", "repo-health"],
      kind: "review",
      source: "repo_health",
      maxRetries: 0
    })
    const recentFollowUp = store.createTask({
      projectRef: project.id,
      title: "Follow-up: Repo health 2026-05-01",
      labels: ["automation", "repo-health", "follow-up"],
      kind: "follow_up"
    })
    store.updateTaskStatus(recentFollowUp.id, "done")

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async () => ({
        ok: false,
        response: "still failing",
        error: "broken"
      })),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" }))
    })

    const summary = await executor.tick()
    expect(summary.followUpTasks).toBe(0)
    expect(store.getTaskById(task.id).status).toBe("failed")
    expect(
      store.listProjectTasks(project.id).filter((entry) => entry.title === "Follow-up: Repo health 2026-05-01")
    ).toHaveLength(1)

    store.close()
  })

  it("suppresses automated repo health sweeps after repeated identical failures until cleared", async () => {
    const { store, company, project } = await setupBase({ verifyCommand: "bash -lc 'exit 1'" })
    store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local"
    })

    const failingExecutor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async () => ({
        ok: false,
        response: "still failing",
        error: "broken"
      })),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" })),
      azure_foundry: fakeAdapter("azure_foundry", async () => ({ ok: true, response: "unused" }))
    })

    const firstSweep = store.createTask({
      projectRef: project.id,
      title: "Repo health first",
      labels: ["automation", "repo-health"],
      kind: "review",
      source: "repo_health",
      maxRetries: 0
    })
    await failingExecutor.tick()
    const firstFollowUp = store
      .listProjectTasks(project.id)
      .find((task) => task.title === "Follow-up: Repo health first")
    if (firstFollowUp) {
      store.updateTaskStatus(firstFollowUp.id, "failed")
    }

    const secondSweep = store.createTask({
      projectRef: project.id,
      title: "Repo health second",
      labels: ["automation", "repo-health"],
      kind: "review",
      source: "repo_health",
      maxRetries: 0
    })
    await failingExecutor.tick()
    const secondGuardEvent = store
      .getTaskEvents(secondSweep.id)
      .find((event) => event.kind === "repo-health-guard-recorded")

    expect(secondGuardEvent?.data).toMatchObject({
      repeatedFailureCount: 2
    })

    const automation = store.createAutomation({
      companyRef: company.id,
      projectRef: project.id,
      name: "daily-health",
      kind: "repo_health",
      cron: "* * * * *",
      nextRunAt: new Date(Date.now() - 60_000).toISOString(),
      payload: {
        projectRef: project.id,
        title: "Repo health {{date}}",
        description: "Run daily sweep for {{ date }}."
      }
    })

    const automationExecutor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async () => ({ ok: true, response: "unused" })),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" })),
      azure_foundry: fakeAdapter("azure_foundry", async () => ({ ok: true, response: "unused" }))
    })

    const suppressedSummary = await automationExecutor.tick()
    expect(suppressedSummary.executedJobs).toBe(1)
    expect(store.listProjectTasks(project.id).filter((task) => task.source === "repo_health")).toHaveLength(2)

    const clearEvent = store.clearRepoHealthFailureGuard(project.id, {
      reason: "Operator confirmed the failure condition was addressed."
    })
    expect(clearEvent?.kind).toBe("repo-health-guard-cleared")

    store.updateAutomation(automation.id, {
      nextRunAt: new Date(Date.now() - 60_000).toISOString()
    })

    const resumedSummary = await automationExecutor.tick()
    expect(resumedSummary.executedJobs).toBe(1)
    expect(store.listProjectTasks(project.id).filter((task) => task.source === "repo_health")).toHaveLength(3)

    store.close()
  }, 15_000)

  it("skips paused agents", async () => {
    const { store, company, project } = await setupBase()
    store.createAgent({
      companyRef: company.id,
      name: "paused-agent",
      role: "Engineer",
      adapterType: "codex_local",
      status: "paused"
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Needs paused agent"
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async () => ({ ok: true, response: "unused" })),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" }))
    })

    const summary = await executor.tick()
    expect(summary.executedRuns).toBe(0)
    expect(store.getTaskById(task.id).status).toBe("queued")

    store.close()
  })

  it("allows concurrent Codex work when the local account pool can isolate runs", async () => {
    const { store, company, project } = await setupBase()
    const agent = store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const firstTask = store.createTask({
      projectRef: project.id,
      title: "Running task",
      assignedAgentRef: agent.id
    })
    const queuedTask = store.createTask({
      projectRef: project.id,
      title: "Queued task",
      assignedAgentRef: agent.id
    })

    store.claimTask(firstTask.id)
    store.createRun({
      companyId: company.id,
      projectId: project.id,
      taskId: firstTask.id,
      agentId: agent.id,
      adapterType: "codex_local",
      sessionKey: `${agent.id}:${project.id}:${firstTask.id}`
    })
    store.setAgentStatus(agent.id, "running")

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async () => ({ ok: true, response: "unused" })),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" }))
    })

    const summary = await executor.tick()
    expect(summary.executedRuns).toBe(1)
    expect(store.getTaskById(queuedTask.id).status).toBe("done")

    store.close()
  })

  it("refills a freed Codex slot before a longer sibling run finishes", async () => {
    const { store, company, project } = await setupBase()
    process.env.OPENCLAW_MAX_CONCURRENT_CODEX_RUNS = "2"
    for (const name of ["codex-a", "codex-b", "codex-c"]) {
      store.createAgent({
        companyRef: company.id,
        name,
        role: "Engineer",
        adapterType: "codex_local"
      })
    }
    for (const title of ["Long implementation", "Short implementation", "Refill implementation"]) {
      store.createTask({
        projectRef: project.id,
        title,
        kind: "implement",
        requestedAdapterType: "codex_local"
      })
    }

    let callCount = 0
    let releaseLongRun: (() => void) | null = null
    const longRun = new Promise<void>((resolve) => {
      releaseLongRun = resolve
    })
    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async (context) => {
        callCount += 1
        const call = callCount
        if (call === 1) {
          await longRun
        } else if (call === 2) {
          await new Promise((resolve) => setTimeout(resolve, 250))
        } else if (call === 3) {
          releaseLongRun?.()
        }
        writeFileSync(join(context.project.repoPath, `worker-${call}.txt`), `worker ${call}\n`, "utf8")
        return { ok: true, response: `completed worker ${call}` }
      }),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" }))
    })

    const summary = await executor.tick()

    expect(summary.executedRuns).toBe(3)
    expect(callCount).toBe(3)
    expect(store.listProjectTasks(project.id).every((task) => task.status === "done")).toBe(true)
    store.close()
  })

  it("defers overlapping artifact work until the durable assignment releases", async () => {
    const { store, company, project } = await setupBase()
    const agent = store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const activeTask = store.createTask({
      projectRef: project.id,
      title: "Active auth work",
      assignedAgentRef: agent.id,
      changedFiles: ["src/auth.ts"]
    })
    const active = store.startRunWithClaim({
      companyId: company.id,
      projectId: project.id,
      taskId: activeTask.id,
      agentId: agent.id,
      adapterType: agent.adapterType,
      teamAssignment: {
        artifactPaths: activeTask.changedFiles,
        routingReason: "active auth assignment"
      }
    })
    expect(active).not.toBeNull()
    store.setAgentStatus(agent.id, "running")

    const queuedTask = store.createTask({
      projectRef: project.id,
      title: "Queued auth work",
      assignedAgentRef: agent.id,
      changedFiles: ["src/auth.ts"]
    })
    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async () => ({ ok: true, response: "done" })),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" }))
    })

    const deferred = await executor.tick()
    expect(deferred.executedRuns).toBe(0)
    expect(store.getTaskById(queuedTask.id).status).toBe("queued")
    expect(store.getTaskEvents(queuedTask.id).at(-1)).toMatchObject({ kind: "artifact-conflict-deferred" })

    store.completeRun(active!.run.id, { status: "succeeded" })
    store.completeClaimedTask(activeTask.id, active!.lease.claimToken, "done", { assignedAgentId: agent.id })
    store.setAgentStatus(agent.id, "idle")

    expect(store.findTeamArtifactConflicts(project.id, queuedTask.changedFiles)).toHaveLength(0)
    expect(store.listTeamAssignments({ projectId: project.id, status: "completed" })).toHaveLength(1)
    expect(store.listTeamArtifactClaims({ projectId: project.id, status: "active" })).toHaveLength(0)

    store.close()
  })

  it("routes rejected work to an independent agent and delivers the reviewer handoff", async () => {
    const workspace = createTempWorkspace("dispatcher-reviewer-lockout")
    cleanups.push(workspace.cleanup)
    const store = new DispatcherStore!(workspace.dbPath)
    store.migrate()
    const company = store.createCompany({ name: "Review Team" })
    const project = store.createProject({
      companyRef: company.id,
      name: "repo",
      repoPath: workspace.repoPath
    })
    const author = store.createAgent({
      companyRef: company.id,
      name: "author",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const replacement = store.createAgent({
      companyRef: company.id,
      name: "replacement",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const sourceTask = store.createTask({
      projectRef: project.id,
      title: "Original auth implementation",
      changedFiles: ["src/auth.ts"]
    })
    const sourceRun = store.createRun({
      companyId: company.id,
      projectId: project.id,
      taskId: sourceTask.id,
      agentId: author.id,
      adapterType: author.adapterType
    })
    store.completeRun(sourceRun.id, { status: "succeeded" })
    store.updateTaskStatus(sourceTask.id, "done", { assignedAgentId: author.id })
    const repairTask = store.createTask({
      projectRef: project.id,
      title: "Independently repair auth",
      changedFiles: sourceTask.changedFiles,
      requestedAdapterType: "codex_local"
    })
    store.createTeamReviewerLockouts({
      companyId: company.id,
      projectId: project.id,
      taskId: repairTask.id,
      sourceTaskId: sourceTask.id,
      sourceRunId: sourceRun.id,
      lockedAgentId: author.id,
      reviewerActor: "security-reviewer",
      artifactPaths: repairTask.changedFiles,
      reason: "Use a fresh agent for the rejected auth change."
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async () => ({ ok: true, response: "independent repair complete" })),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" }))
    })
    const summary = await executor.tick()
    const repairRun = store.getLatestRunForTask(repairTask.id)!

    expect(summary.executedRuns).toBe(1)
    expect(repairRun.agentId).toBe(replacement.id)
    expect(store.getTaskById(repairTask.id).status).toBe("done")
    expect(store.getTaskEvents(repairTask.id).some((event) => event.kind === "reviewer-lockout-applied")).toBe(true)
    expect(store.listTeamMessages({ toAgentId: replacement.id })[0]).toMatchObject({
      kind: "handoff",
      fromActor: "security-reviewer",
      taskId: repairTask.id
    })
    expect(store.listTeamReviewerLockouts({ taskId: repairTask.id, status: "active" })).toHaveLength(0)
    store.close()
  })

  it("does not let a long persona-planning run starve independent implementation work", async () => {
    const { store, company, project } = await setupBase()
    process.env.OPENCLAW_MAX_CONCURRENT_CODEX_RUNS = "2"
    for (const name of ["planner", "coder"]) {
      store.createAgent({
        companyRef: company.id,
        name,
        role: name === "planner" ? "Planner" : "Engineer",
        adapterType: "codex_local"
      })
    }
    store.createTask({
      projectRef: project.id,
      title: "Long persona planning",
      kind: "plan",
      requestedAdapterType: "codex_local",
      priority: 100
    })
    store.createTask({
      projectRef: project.id,
      title: "Independent implementation",
      kind: "implement",
      requestedAdapterType: "codex_local",
      priority: 50
    })

    let releasePlanner = () => undefined
    const plannerGate = new Promise<void>((resolve) => {
      releasePlanner = resolve
    })
    let plannerFinished = false
    let implementationStartedDuringPlanning = false
    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async (context) => {
        if (context.task.kind === "plan") {
          await Promise.race([plannerGate, new Promise((resolve) => setTimeout(resolve, 300))])
          plannerFinished = true
        } else {
          implementationStartedDuringPlanning = !plannerFinished
          writeFileSync(join(context.project.repoPath, "implementation.txt"), "implemented\n", "utf8")
          releasePlanner()
        }
        return { ok: true, response: "done" }
      }),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" }))
    })

    const summary = await executor.tick()
    expect(summary.executedRuns).toBe(2)
    expect(implementationStartedDuringPlanning).toBe(true)
    expect(store.listProjectTasks(project.id).find((task) => task.title === "Independent implementation")?.status).toBe(
      "done"
    )
    store.close()
  })

  it("does not let a long queue-refresh automation starve existing implementation work", async () => {
    const { store, company, project } = await setupBase()
    process.env.OPENCLAW_MAX_CONCURRENT_CODEX_RUNS = "2"
    const planner = store.createAgent({
      companyRef: company.id,
      name: "planner",
      role: "Planner",
      adapterType: "codex_local"
    })
    store.createAgent({
      companyRef: company.id,
      name: "coder",
      role: "Engineer",
      adapterType: "codex_local"
    })
    store.createPersona({
      companyRef: company.id,
      name: planner.name,
      stage: "planner",
      preferredAdapterType: planner.adapterType
    })
    store.createAutomation({
      companyRef: company.id,
      projectRef: project.id,
      name: "queue-refresh",
      kind: "queue_refresh",
      cron: "* * * * *",
      nextRunAt: new Date(Date.now() - 60_000).toISOString(),
      payload: { projectRef: project.id }
    })
    store.createTask({
      projectRef: project.id,
      title: "Independent implementation one",
      kind: "implement",
      requestedAdapterType: "codex_local",
      laneId: "independent-one"
    })
    store.createTask({
      projectRef: project.id,
      title: "Independent implementation two",
      kind: "implement",
      requestedAdapterType: "codex_local",
      laneId: "independent-two"
    })

    let releasePlanner = () => undefined
    const plannerGate = new Promise<void>((resolve) => {
      releasePlanner = resolve
    })
    let plannerFinished = false
    let implementationStartedDuringPlanning = false
    let activeAdapterCalls = 0
    let peakAdapterCalls = 0
    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async (context) => {
        activeAdapterCalls += 1
        peakAdapterCalls = Math.max(peakAdapterCalls, activeAdapterCalls)
        try {
          if (context.task.kind === "plan") {
            await Promise.race([plannerGate, new Promise((resolve) => setTimeout(resolve, 300))])
            plannerFinished = true
            return {
              ok: true,
              response: JSON.stringify({
                version: 1,
                summary: "queue already contains independent work",
                candidates: []
              })
            }
          }
          implementationStartedDuringPlanning ||= !plannerFinished
          writeFileSync(join(context.project.repoPath, `${context.task.laneId}.txt`), "implemented\n", "utf8")
          releasePlanner()
          return { ok: true, response: "implementation complete" }
        } finally {
          activeAdapterCalls -= 1
        }
      }),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" }))
    })

    const summary = await executor.tick()
    expect(summary.executedRuns).toBe(2)
    expect(summary.executedJobs).toBe(1)
    expect(implementationStartedDuringPlanning).toBe(true)
    expect(peakAdapterCalls).toBe(2)
    expect(
      store
        .listProjectTasks(project.id)
        .filter((task) => task.title.startsWith("Independent implementation"))
        .map((task) => task.status)
    ).toEqual(["done", "done"])
    store.close()
  })

  it("serializes code-producing tasks in the same ownership lane", async () => {
    const { store, company, project } = await setupBase()
    process.env.OPENCLAW_MAX_CONCURRENT_CODEX_RUNS = "2"
    for (const name of ["coder-one", "coder-two"]) {
      store.createAgent({
        companyRef: company.id,
        name,
        role: "Engineer",
        adapterType: "codex_local"
      })
    }
    for (const title of ["Same lane one", "Same lane two"]) {
      store.createTask({
        projectRef: project.id,
        title,
        kind: "implement",
        requestedAdapterType: "codex_local",
        laneId: "shared-lane"
      })
    }

    let activeAdapterCalls = 0
    let peakAdapterCalls = 0
    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async (context) => {
        activeAdapterCalls += 1
        peakAdapterCalls = Math.max(peakAdapterCalls, activeAdapterCalls)
        try {
          await new Promise((resolve) => setTimeout(resolve, 40))
          writeFileSync(join(context.project.repoPath, `${context.task.id}.txt`), "implemented\n", "utf8")
          return { ok: true, response: "implementation complete" }
        } finally {
          activeAdapterCalls -= 1
        }
      }),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" }))
    })

    const summary = await executor.tick()
    expect(summary.executedRuns).toBe(2)
    expect(peakAdapterCalls).toBe(1)
    expect(
      store
        .listProjectTasks(project.id)
        .filter((task) => task.title.startsWith("Same lane"))
        .map((task) => task.status)
    ).toEqual(["done", "done"])
    expect(
      store
        .listProjectTasks(project.id)
        .filter((task) => task.title.startsWith("Same lane"))
        .some((task) => store.getTaskEvents(task.id).some((event) => event.kind === "lane-execution-serialized"))
    ).toBe(true)
    store.close()
  })

  it("does not execute scheduled project tasks until execution-sweep is due", async () => {
    const { store, company, project } = await setupBase()
    store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Wait for scheduler"
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

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async () => ({ ok: true, response: "done" })),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" }))
    })

    const summary = await executor.tick()
    expect(summary.executedRuns).toBe(0)
    expect(summary.executedJobs).toBe(0)
    expect(store.getTaskById(task.id).status).toBe("queued")

    store.close()
  })

  it("materializes promotion children before starting a due execution sweep", async () => {
    const { store, company, project } = await setupBase()
    const overdue = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const reviewedParent = store.createTask({
      projectRef: project.id,
      title: "Already reviewed implementation",
      kind: "implement",
      reviewRequired: true
    })
    store.updateTaskStatus(reviewedParent.id, "promotion_pending")
    const completedReview = store.createTask({
      projectRef: project.id,
      title: "Review: Already reviewed implementation",
      kind: "review",
      parentTaskId: reviewedParent.id,
      reviewRequired: false
    })
    store.updateTaskStatus(completedReview.id, "done")
    const implementationRun = store.createRun({
      companyId: company.id,
      projectId: project.id,
      taskId: reviewedParent.id,
      adapterType: "codex_local",
      kind: "implement"
    })
    store.completeRun(implementationRun.id, {
      status: "succeeded",
      responseText: "implementation complete",
      verificationSummary: "tests passed",
      branchName: "test-implementation"
    })
    const reviewerRun = store.createRun({
      companyId: company.id,
      projectId: project.id,
      taskId: completedReview.id,
      adapterType: "codex_local",
      kind: "review"
    })
    store.completeRun(reviewerRun.id, {
      status: "succeeded",
      responseText: "review complete",
      verificationSummary: "tests passed"
    })
    reviewCompletedRun!(store, implementationRun.id, { reviewerRunId: reviewerRun.id })
    const implementation = store.createTask({
      projectRef: project.id,
      title: "Independent queued implementation",
      kind: "implement",
      requestedAdapterType: "codex_local",
      priority: 90
    })
    const executionJob = store.upsertJobSpec({
      companyId: company.id,
      projectId: project.id,
      jobId: "execution-sweep",
      sourcePath: ".openclaw/jobs/execution-sweep.json",
      cron: "* * * * *",
      timezone: "UTC",
      entryAgent: "main"
    })
    store.updateJobSpecRuntime(executionJob.id, { lastTriggeredAt: overdue })

    let promotionChildPresentAtImplementationStart = false
    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async (context) => {
        if (context.task.id === implementation.id) {
          promotionChildPresentAtImplementationStart = store.listChildTasks(reviewedParent.id, "promote").length === 1
          writeFileSync(join(context.project.repoPath, "implementation.txt"), "implemented\n", "utf8")
        }
        return { ok: true, response: "done" }
      }),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" }))
    })

    await executor.tick()

    expect(promotionChildPresentAtImplementationStart).toBe(true)
    expect(store.listChildTasks(reviewedParent.id, "promote")).toHaveLength(1)
    expect(store.getTaskEvents(reviewedParent.id).some((event) => event.kind === "promote-task-created")).toBe(true)

    store.close()
  })

  it("creates review tasks and auto-promotes reviewed parents", async () => {
    const { store, company, project } = await setupBase()
    const overdue = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const parentTask = store.createTask({
      projectRef: project.id,
      title: "Needs review",
      kind: "implement",
      reviewRequired: true
    })
    store.updateTaskStatus(parentTask.id, "review_needed")
    const implementationRun = store.createRun({
      companyId: company.id,
      projectId: project.id,
      taskId: parentTask.id,
      adapterType: "codex_local",
      kind: "implement"
    })
    store.completeRun(implementationRun.id, {
      status: "succeeded",
      responseText: "implementation complete",
      verificationSummary: "tests passed",
      branchName: "test-implementation"
    })
    const independentImplementation = store.createTask({
      projectRef: project.id,
      title: "Wait for newly approved work to promote",
      kind: "implement",
      requestedAdapterType: "codex_local"
    })

    const reviewJob = store.upsertJobSpec({
      companyId: company.id,
      projectId: project.id,
      jobId: "review-sweep",
      sourcePath: ".openclaw/jobs/review-sweep.json",
      cron: "* * * * *",
      timezone: "UTC",
      entryAgent: "reviewer"
    })
    store.updateJobSpecRuntime(reviewJob.id, {
      lastTriggeredAt: overdue
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async (context) => {
        if (context.task.id === independentImplementation.id) {
          writeFileSync(join(context.project.repoPath, "independent-implementation.txt"), "implemented\n", "utf8")
        }
        return { ok: true, response: "reviewed" }
      }),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" }))
    })

    const firstSummary = await executor.tick()
    expect(firstSummary.executedJobs).toBe(1)
    expect(firstSummary.createdReviewTasks).toBe(1)

    const reviewTask = store.listChildTasks(parentTask.id, "review")[0]!
    expect(reviewTask.title).toBe("Review: Needs review")
    expect(reviewTask.status).toBe("queued")
    expect(reviewTask.priority).toBe(70)

    store.updateJobSpecRuntime(
      store.findJobSpec(project.id, "execution-sweep")?.id ??
        store.upsertJobSpec({
          companyId: company.id,
          projectId: project.id,
          jobId: "execution-sweep",
          sourcePath: ".openclaw/jobs/execution-sweep.json",
          cron: "* * * * *",
          timezone: "UTC",
          entryAgent: "main"
        }).id,
      { lastTriggeredAt: overdue }
    )
    const promotionJob = store.upsertJobSpec({
      companyId: company.id,
      projectId: project.id,
      jobId: "promotion-sweep",
      sourcePath: ".openclaw/jobs/promotion-sweep.json",
      cron: "* * * * *",
      timezone: "UTC",
      entryAgent: "promoter"
    })
    store.updateJobSpecRuntime(promotionJob.id, {
      lastTriggeredAt: overdue
    })

    const secondSummary = await executor.tick()
    expect(secondSummary.executedRuns).toBe(1)
    expect(secondSummary.executedJobs).toBe(2)
    expect(store.getTaskById(parentTask.id).status).toBe("promotion_pending")
    expect(store.getTaskById(reviewTask.id).status).toBe("done")
    const promoteTask = store.listChildTasks(parentTask.id, "promote")[0]!
    expect(promoteTask.title).toBe("Promote: Needs review")
    expect(promoteTask.status).toBe("queued")
    expect(promoteTask.priority).toBe(80)
    expect(promoteTask.dependsOnTaskIds).toEqual([reviewTask.id])
    expect(store.getTaskById(independentImplementation.id).status).toBe("queued")
    expect(store.getTaskEvents(parentTask.id).some((event) => event.kind === "review-passed")).toBe(true)
    expect(store.getTaskEvents(parentTask.id).some((event) => event.kind === "promote-task-created")).toBe(true)

    store.updateTaskStatus(promoteTask.id, "blocked", {
      blockedReason: "lane_busy_with_active_pr:active",
      lastError: null
    })
    store.updateJobSpecRuntime(promotionJob.id, {
      lastTriggeredAt: overdue
    })

    const thirdSummary = await executor.tick()
    expect(thirdSummary.executedJobs).toBe(1)
    expect(store.getTaskById(parentTask.id).status).toBe("promotion_pending")
    expect(store.listChildTasks(parentTask.id, "promote")).toHaveLength(1)

    store.updateTaskStatus(promoteTask.id, "blocked", {
      blockedReason: "human_action_required:promotion",
      lastError: "push failed"
    })
    store.updateJobSpecRuntime(promotionJob.id, {
      lastTriggeredAt: overdue
    })

    const fourthSummary = await executor.tick()
    expect(fourthSummary.executedJobs).toBe(1)
    expect(store.getTaskById(parentTask.id).status).toBe("blocked")
    expect(store.getTaskById(parentTask.id).blockedReason).toBe(`promotion_failed:${promoteTask.id}`)
    expect(store.listChildTasks(parentTask.id, "promote")).toHaveLength(1)
    expect(store.getTaskEvents(parentTask.id).some((event) => event.kind === "promote-child-blocked")).toBe(true)

    store.close()
  })

  it("persists deterministic review evidence during the scheduled review gate", async () => {
    const { workspace, store, company, project } = await setupBase()
    const implementationWorktree = join(workspace.root, "implementation-review-worktree")
    execFileSync("git", ["worktree", "add", "--detach", implementationWorktree, "HEAD"], {
      cwd: project.repoPath,
      stdio: "ignore"
    })
    writeFileSync(join(implementationWorktree, "review-evidence.txt"), "review this implementation\n", "utf8")
    execFileSync("git", ["add", "review-evidence.txt"], { cwd: implementationWorktree })
    execFileSync("git", ["commit", "-m", "Add review evidence"], {
      cwd: implementationWorktree,
      stdio: "ignore"
    })
    symlinkSync(project.repoPath, join(implementationWorktree, ".venv"), "dir")
    const parentTask = store.createTask({
      projectRef: project.id,
      title: "Persist scheduled review evidence",
      kind: "implement",
      reviewRequired: true
    })
    const implementationRun = store.createRun({
      companyId: company.id,
      projectId: project.id,
      taskId: parentTask.id,
      adapterType: "codex_local",
      kind: "implement",
      worktreePath: implementationWorktree
    })
    store.completeRun(implementationRun.id, {
      status: "succeeded",
      responseText: "Implementation complete; tests passed.",
      verificationSummary: "unit tests passed",
      branchName: execFileSync("git", ["branch", "--show-current"], {
        cwd: implementationWorktree,
        encoding: "utf8"
      }).trim(),
      headSha: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: implementationWorktree,
        encoding: "utf8"
      }).trim()
    })
    store.updateTaskStatus(parentTask.id, "review_needed")
    const reviewTask = store.createTask({
      projectRef: project.id,
      parentTaskId: parentTask.id,
      title: "Review: Persist scheduled review evidence",
      kind: "review",
      reviewRequired: false
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async () => ({ ok: true, response: "unused" })),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" }))
    })

    const summary = await executor.tick()

    expect(summary.executedRuns).toBe(1)
    expect(store.getTaskById(reviewTask.id).status).toBe("done")
    expect(store.getTaskById(parentTask.id).status).toBe("promotion_pending")
    const reviewRun = store.listRuns().find((run) => run.taskId === reviewTask.id)!
    const reviewResult = store.getLatestReviewResultForRun(implementationRun.id)
    const reviewEvents = store.getRunEvents(reviewRun.id)
    expect(reviewResult, JSON.stringify(reviewEvents)).toMatchObject({
      runId: implementationRun.id,
      taskId: parentTask.id,
      reviewerRunId: reviewRun.id,
      outcome: "approve"
    })
    expect(reviewResult?.changedFiles).toContain("review-evidence.txt")
    expect(reviewResult?.changedFiles).not.toContain(".venv")
    expect(reviewEvents).toContainEqual(
      expect.objectContaining({
        message: "Deterministic review evidence persisted",
        data: expect.objectContaining({ reviewResultId: reviewResult?.id, outcome: "approve" })
      })
    )
    expect(store.getTaskEvents(parentTask.id).map((event) => event.kind)).toContain("deterministic-review-recorded")

    store.close()
  })

  it("blocks promotion and queues repair work when deterministic review rejects architecture changes", async () => {
    const { workspace, store, company, project } = await setupBase()
    const implementationWorktree = join(workspace.root, "architecture-review-worktree")
    execFileSync("git", ["worktree", "add", "--detach", implementationWorktree, "HEAD"], {
      cwd: project.repoPath,
      stdio: "ignore"
    })
    mkdirSync(join(implementationWorktree, "src"), { recursive: true })
    writeFileSync(join(implementationWorktree, "src", "schema.ts"), "export const schemaVersion = 2\n", "utf8")
    execFileSync("git", ["add", "src/schema.ts"], { cwd: implementationWorktree })
    execFileSync("git", ["commit", "-m", "Change persistence schema"], {
      cwd: implementationWorktree,
      stdio: "ignore"
    })
    const parentTask = store.createTask({
      projectRef: project.id,
      title: "Change persistence schema",
      kind: "implement",
      reviewRequired: true
    })
    const implementationRun = store.createRun({
      companyId: company.id,
      projectId: project.id,
      taskId: parentTask.id,
      adapterType: "codex_local",
      kind: "implement",
      worktreePath: implementationWorktree
    })
    store.completeRun(implementationRun.id, {
      status: "succeeded",
      responseText: "Implementation complete; tests passed.",
      verificationSummary: "unit tests passed",
      branchName: "architecture-review",
      headSha: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: implementationWorktree,
        encoding: "utf8"
      }).trim()
    })
    store.updateTaskStatus(parentTask.id, "review_needed")
    const reviewTask = store.createTask({
      projectRef: project.id,
      parentTaskId: parentTask.id,
      title: "Review: Change persistence schema",
      kind: "review",
      reviewRequired: false
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async () => ({ ok: true, response: "unused" })),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" }))
    })

    const summary = await executor.tick()
    const reviewResult = store.getLatestReviewResultForTask(parentTask.id)
    const repairTasks = store.listChildTasks(parentTask.id, "fix_review_feedback")

    expect(summary.executedRuns).toBe(1)
    expect(summary.followUpTasks).toBe(1)
    expect(store.getTaskById(reviewTask.id).status).toBe("done")
    expect(store.getTaskById(parentTask.id)).toMatchObject({
      status: "blocked",
      blockedReason: "review_outcome:architecture_blocked"
    })
    expect(reviewResult?.outcome).toBe("architecture_blocked")
    expect(repairTasks).toHaveLength(1)
    expect(repairTasks[0]).toMatchObject({
      status: "queued",
      kind: "fix_review_feedback",
      parentTaskId: parentTask.id,
      approvalRequired: true
    })
    expect(store.listChildTasks(parentTask.id, "promote")).toHaveLength(0)
    expect(existsSync(implementationWorktree)).toBe(true)
    expect(store.getTaskEvents(parentTask.id).map((event) => event.kind)).toContain("review-outcome-blocked")

    store.close()
  })

  it("closes a review-blocked parent after its approved repair is promoted", async () => {
    const { store, project } = await setupBase()
    const originalTask = store.createTask({
      projectRef: project.id,
      title: "Implementation rejected in review",
      kind: "implement",
      reviewRequired: true
    })
    store.updateTaskStatus(originalTask.id, "blocked", {
      blockedReason: "review_outcome:request_changes",
      lastError: "Review requested a user-facing implementation."
    })
    const repairTask = store.createTask({
      projectRef: project.id,
      parentTaskId: originalTask.id,
      title: "Repair review findings",
      kind: "fix_review_feedback",
      labels: ["review-repair"],
      reviewRequired: true
    })
    store.updateTaskStatus(repairTask.id, "done")
    store.createPromotion({
      companyId: repairTask.companyId,
      projectId: project.id,
      taskId: repairTask.id,
      branchName: "openclaw/run/review-repair",
      promotionStatus: "merged"
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async () => ({ ok: true, response: "unused" })),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" }))
    })

    await executor.tick()

    expect(store.getTaskById(originalTask.id)).toMatchObject({
      status: "done",
      blockedReason: null,
      lastError: null
    })
    expect(store.getTaskEvents(originalTask.id).map((event) => event.kind)).toContain(
      "review-repair-promoted-parent-recovered"
    )

    store.close()
  })

  it("recovers completed review-required implementation tasks during review sweep", async () => {
    const { store, company, project } = await setupBase()
    const overdue = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const parentTask = store.createTask({
      projectRef: project.id,
      title: "Done but still needs review",
      kind: "implement",
      reviewRequired: true
    })
    store.updateTaskStatus(parentTask.id, "done")
    const run = store.createRun({
      companyId: company.id,
      projectId: project.id,
      taskId: parentTask.id,
      kind: "implement",
      adapterType: "codex_local"
    })
    store.completeRun(run.id, {
      status: "succeeded",
      branchName: "openclaw/run/done-but-unreviewed",
      headSha: "abc123",
      verificationSummary: "ok"
    })

    const reviewJob = store.upsertJobSpec({
      companyId: company.id,
      projectId: project.id,
      jobId: "review-sweep",
      sourcePath: ".openclaw/jobs/review-sweep.json",
      cron: "* * * * *",
      timezone: "UTC",
      entryAgent: "reviewer"
    })
    store.updateJobSpecRuntime(reviewJob.id, {
      lastTriggeredAt: overdue
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async () => ({ ok: true, response: "unused" })),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" }))
    })

    const summary = await executor.tick()
    expect(summary.createdReviewTasks).toBe(1)
    expect(store.getTaskById(parentTask.id).status).toBe("review_needed")
    const reviewTask = store.listChildTasks(parentTask.id, "review")[0]
    expect(reviewTask?.title).toBe("Review: Done but still needs review")
    expect(reviewTask?.priority).toBe(70)
    expect(store.getTaskEvents(parentTask.id).some((event) => event.kind === "review-needed-recovered")).toBe(true)

    store.close()
  })

  it("recovers review-needed parents when a child review already completed", async () => {
    const { store, company, project } = await setupBase()
    const overdue = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const parentTask = store.createTask({
      projectRef: project.id,
      title: "Reviewed but parent is stale",
      kind: "implement",
      reviewRequired: true
    })
    store.updateTaskStatus(parentTask.id, "review_needed", {
      lastError: "stale review state"
    })
    const reviewTask = store.createTask({
      projectRef: project.id,
      title: "Review: Reviewed but parent is stale",
      kind: "review",
      parentTaskId: parentTask.id
    })
    store.updateTaskStatus(reviewTask.id, "done")
    const implementationRun = store.createRun({
      companyId: company.id,
      projectId: project.id,
      taskId: parentTask.id,
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
    const reviewJob = store.upsertJobSpec({
      companyId: company.id,
      projectId: project.id,
      jobId: "review-sweep",
      sourcePath: ".openclaw/jobs/review-sweep.json",
      cron: "* * * * *",
      timezone: "UTC",
      entryAgent: "reviewer"
    })
    store.updateJobSpecRuntime(reviewJob.id, {
      lastTriggeredAt: overdue
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async () => ({ ok: true, response: "unused" })),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" }))
    })

    const summary = await executor.tick()

    expect(summary.createdReviewTasks).toBe(0)
    expect(store.listChildTasks(parentTask.id, "review")).toHaveLength(1)
    expect(store.getTaskById(parentTask.id)).toMatchObject({
      status: "promotion_pending",
      lastError: null
    })
    expect(store.getTaskEvents(parentTask.id).some((event) => event.kind === "review-passed-recovered")).toBe(true)
    expect(store.getTaskEvents(reviewTask.id).some((event) => event.kind === "review-passed-parent-recovered")).toBe(
      true
    )

    store.close()
  })

  it("recovers promotion-pending parents that lost their completed review handoff", async () => {
    const { store, company, project } = await setupBase()
    const overdue = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const parentTask = store.createTask({
      projectRef: project.id,
      title: "Promotion pending without review",
      kind: "implement",
      reviewRequired: true
    })
    store.updateTaskStatus(parentTask.id, "promotion_pending", {
      lastError: "stale promotion state"
    })
    const promotionJob = store.upsertJobSpec({
      companyId: company.id,
      projectId: project.id,
      jobId: "promotion-sweep",
      sourcePath: ".openclaw/jobs/promotion-sweep.json",
      cron: "* * * * *",
      timezone: "UTC",
      entryAgent: "promoter"
    })
    store.updateJobSpecRuntime(promotionJob.id, {
      lastTriggeredAt: overdue
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async () => ({ ok: true, response: "unused" })),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" }))
    })

    const promotionSummary = await executor.tick()

    expect(promotionSummary.executedJobs).toBe(1)
    expect(store.getTaskById(parentTask.id)).toMatchObject({
      status: "review_needed",
      lastError: null,
      lastRecoveryReason: "promotion_pending_without_completed_review"
    })
    expect(store.getTaskEvents(parentTask.id).some((event) => event.kind === "promotion-review-recovered")).toBe(true)

    const reviewJob = store.upsertJobSpec({
      companyId: company.id,
      projectId: project.id,
      jobId: "review-sweep",
      sourcePath: ".openclaw/jobs/review-sweep.json",
      cron: "* * * * *",
      timezone: "UTC",
      entryAgent: "reviewer"
    })
    store.updateJobSpecRuntime(reviewJob.id, {
      lastTriggeredAt: overdue
    })

    const reviewSummary = await executor.tick()

    expect(reviewSummary.createdReviewTasks).toBe(1)
    const reviewTask = store.listChildTasks(parentTask.id, "review")[0]
    expect(reviewTask?.title).toBe("Review: Promotion pending without review")
    expect(reviewTask?.status).toBe("queued")

    store.close()
  })

  it("blocks review-needed parents after terminal child review failures instead of duplicating reviews", async () => {
    const { store, company, project } = await setupBase()
    const overdue = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const parentTask = store.createTask({
      projectRef: project.id,
      title: "Needs one review failure",
      reviewRequired: true
    })
    store.updateTaskStatus(parentTask.id, "review_needed")
    const failedReview = store.createTask({
      projectRef: project.id,
      title: "Review: Needs one review failure",
      kind: "review",
      parentTaskId: parentTask.id
    })
    store.updateTaskStatus(failedReview.id, "blocked", {
      blockedReason: "human_action_required:verification",
      lastError: "verification failed"
    })
    const reviewJob = store.upsertJobSpec({
      companyId: company.id,
      projectId: project.id,
      jobId: "review-sweep",
      sourcePath: ".openclaw/jobs/review-sweep.json",
      cron: "* * * * *",
      timezone: "UTC",
      entryAgent: "reviewer"
    })
    store.updateJobSpecRuntime(reviewJob.id, {
      lastTriggeredAt: overdue
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async () => ({ ok: true, response: "unused" })),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" }))
    })

    const summary = await executor.tick()
    expect(summary.createdReviewTasks).toBe(0)
    expect(store.listChildTasks(parentTask.id, "review")).toHaveLength(1)
    expect(store.getTaskById(parentTask.id)).toMatchObject({
      status: "blocked",
      blockedReason: `review_failed:${failedReview.id}`,
      lastError: "verification failed"
    })
    expect(store.getTaskEvents(parentTask.id).some((event) => event.kind === "review-child-blocked")).toBe(true)

    store.close()
  })

  it("ignores retired review children when creating fresh review tasks", async () => {
    const { store, company, project } = await setupBase()
    const overdue = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const parentTask = store.createTask({
      projectRef: project.id,
      title: "Needs fresh review after retirement",
      reviewRequired: true
    })
    store.updateTaskStatus(parentTask.id, "review_needed")
    const retiredReview = store.createTask({
      projectRef: project.id,
      title: "Review: Needs fresh review after retirement",
      kind: "review",
      parentTaskId: parentTask.id
    })
    store.updateTaskStatus(retiredReview.id, "failed", {
      blockedReason: "retired:blocked_state_retired_for_persona_ideation:unknown",
      lastError: "retired:blocked_state_retired_for_persona_ideation:unknown"
    })
    const reviewJob = store.upsertJobSpec({
      companyId: company.id,
      projectId: project.id,
      jobId: "review-sweep",
      sourcePath: ".openclaw/jobs/review-sweep.json",
      cron: "* * * * *",
      timezone: "UTC",
      entryAgent: "reviewer"
    })
    store.updateJobSpecRuntime(reviewJob.id, {
      lastTriggeredAt: overdue
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async () => ({ ok: true, response: "unused" })),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" }))
    })

    const summary = await executor.tick()
    const reviewChildren = store.listChildTasks(parentTask.id, "review")

    expect(summary.createdReviewTasks).toBe(1)
    expect(store.getTaskById(parentTask.id).status).toBe("review_needed")
    expect(reviewChildren).toHaveLength(2)
    expect(reviewChildren.some((child) => child.id !== retiredReview.id && child.status === "queued")).toBe(true)

    store.close()
  })

  it("cleans retained implementation worktrees when review passes", async () => {
    const { store, company, project, workspace } = await setupBase()
    if (!initGitRepo(project.repoPath)) {
      store.close()
      return
    }
    store.createAgent({
      companyRef: company.id,
      name: "reviewer",
      role: "Reviewer",
      adapterType: "codex_local"
    })
    const parentTask = store.createTask({
      projectRef: project.id,
      title: "Reviewed worktree task",
      kind: "implement",
      reviewRequired: true
    })
    store.updateTaskStatus(parentTask.id, "review_needed")
    const reviewTask = store.createTask({
      projectRef: project.id,
      title: "Review retained worktree",
      kind: "review",
      parentTaskId: parentTask.id,
      verificationCommands: ["test -f worktree-only.txt"]
    })

    const branchName = `openclaw/run/stale-${parentTask.id.slice(0, 8)}`
    const worktreePath = join(workspace.root, "retained-worktree")
    const manifestPath = join(workspace.root, "retained-worktree.manifest.json")
    execFileSync("git", ["worktree", "add", "-b", branchName, worktreePath, "HEAD"], {
      cwd: project.repoPath,
      stdio: "ignore"
    })
    writeFileSync(join(worktreePath, "worktree-only.txt"), "review evidence\n", "utf8")
    writeFileSync(manifestPath, "{}", "utf8")

    const implementationRun = store.createRun({
      companyId: company.id,
      projectId: project.id,
      taskId: parentTask.id,
      kind: "implement",
      adapterType: "codex_local",
      worktreePath,
      manifestPath
    })
    store.completeRun(implementationRun.id, {
      status: "succeeded",
      branchName,
      headSha: "abc123",
      verificationSummary: "review required"
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async () => ({ ok: true, response: "unused" })),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" })),
      azure_foundry: fakeAdapter("azure_foundry", async () => ({ ok: true, response: "unused" }))
    })

    await executor.tick()

    expect(store.getTaskById(reviewTask.id).status).toBe("done")
    expect(store.getTaskById(parentTask.id).status).toBe("promotion_pending")
    const reviewRun = store.getLatestRunForTask(reviewTask.id)!
    expect(
      store
        .getRunEvents(reviewRun.id)
        .some((event) => event.message === "Review verification using implementation worktree")
    ).toBe(true)
    expect(existsSync(worktreePath)).toBe(false)
    expect(existsSync(manifestPath)).toBe(false)
    expect(store.getRunById(implementationRun.id).worktreePath).toBeNull()
    expect(
      store.getRunEvents(implementationRun.id).some((event) => event.message === "Execution worktree cleaned up")
    ).toBe(true)

    store.close()
  })

  it("restores a missing implementation worktree from its recorded branch before review", async () => {
    const { store, company, project, workspace } = await setupBase()
    if (!initGitRepo(project.repoPath)) {
      store.close()
      return
    }
    const baseBranch = execFileSync("git", ["branch", "--show-current"], {
      cwd: project.repoPath,
      encoding: "utf8"
    }).trim()
    const branchName = "openclaw/run/review-restore-source"
    execFileSync("git", ["switch", "-c", branchName], { cwd: project.repoPath, stdio: "ignore" })
    writeFileSync(join(project.repoPath, "review-only.txt"), "retained implementation evidence\n", "utf8")
    execFileSync("git", ["add", "review-only.txt"], { cwd: project.repoPath })
    execFileSync("git", ["commit", "-m", "implementation awaiting review"], {
      cwd: project.repoPath,
      stdio: "ignore"
    })
    const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: project.repoPath,
      encoding: "utf8"
    }).trim()
    execFileSync("git", ["switch", baseBranch], { cwd: project.repoPath, stdio: "ignore" })

    store.createAgent({
      companyRef: company.id,
      name: "reviewer",
      role: "Reviewer",
      adapterType: "codex_local"
    })
    const parentTask = store.createTask({
      projectRef: project.id,
      title: "Implementation with missing worktree",
      kind: "implement",
      reviewRequired: true
    })
    store.updateTaskStatus(parentTask.id, "review_needed")
    const staleWorktreePath = join(workspace.root, "stale-review-worktree-shell")
    mkdirSync(join(staleWorktreePath, "apps", "reports-ui"), { recursive: true })
    const implementationRun = store.createRun({
      companyId: company.id,
      projectId: project.id,
      taskId: parentTask.id,
      kind: "implement",
      adapterType: "codex_local",
      worktreePath: staleWorktreePath
    })
    store.completeRun(implementationRun.id, {
      status: "succeeded",
      branchName,
      headSha,
      verificationSummary: "implementation verified"
    })
    const reviewTask = store.createTask({
      projectRef: project.id,
      title: "Review restored implementation",
      kind: "review",
      parentTaskId: parentTask.id,
      verificationCommands: ["test -f review-only.txt"]
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async () => ({ ok: true, response: "unused" })),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" })),
      azure_foundry: fakeAdapter("azure_foundry", async () => ({ ok: true, response: "unused" }))
    })

    await executor.tick()

    const reviewRun = store.getLatestRunForTask(reviewTask.id)!
    const restoreEvent = store
      .getRunEvents(reviewRun.id)
      .find((event) => event.message === "Review verification worktree restored from implementation branch")

    expect(store.getTaskById(reviewTask.id).status).toBe("done")
    expect(store.getTaskById(parentTask.id).status).toBe("promotion_pending")
    expect(restoreEvent?.data?.branchName).toBe(branchName)
    expect(restoreEvent?.data?.headSha).toBe(headSha)
    expect(restoreEvent?.data?.worktreePath).toBe(staleWorktreePath)
    expect(typeof restoreEvent?.data?.worktreePath).toBe("string")
    expect((restoreEvent?.data?.worktreePath as string).startsWith(workspace.root)).toBe(true)
    expect(existsSync(restoreEvent?.data?.worktreePath as string)).toBe(false)
    expect(store.getRunById(implementationRun.id).worktreePath).toBeNull()

    store.close()
  })

  it("cleans execution worktrees when adapter execution fails", async () => {
    const { store, company, project } = await setupBase()
    if (!initGitRepo(project.repoPath)) {
      store.close()
      return
    }
    store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Failing worktree task",
      kind: "implement",
      maxRetries: 1
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async () => ({
        ok: false,
        response: "",
        error: "Adapter execution failed"
      })),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" }))
    })

    await executor.tick()

    const run = store.getLatestRunForTask(task.id)!
    const events = store.getRunEvents(run.id)
    const allocated = events.find((event) => event.message === "Execution worktree allocated")
    const worktreePath = allocated?.data?.worktreePath

    expect(typeof worktreePath).toBe("string")
    expect(existsSync(worktreePath as string)).toBe(false)
    expect(store.getRunById(run.id).worktreePath).toBeNull()
    expect(events.some((event) => event.message === "Execution worktree cleaned up")).toBe(true)

    store.close()
  })

  it("preserves implementation changes when adapter execution times out", async () => {
    const { store, company, project } = await setupBase()
    if (!initGitRepo(project.repoPath)) {
      store.close()
      return
    }
    store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Preserve timed out implementation",
      kind: "implement",
      changedFiles: ["partial-timeout-change.txt"],
      maxRetries: 1
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async (context): Promise<AdapterExecutionResult> => {
        writeFileSync(
          join(context.project.repoPath, "partial-timeout-change.txt"),
          "valuable implementation before timeout\n",
          "utf8"
        )
        return {
          ok: false,
          response: "",
          error: "Codex execution failed: ETIMEDOUT: Codex execution timed out",
          failureCategory: "timeout"
        }
      }),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" }))
    })

    await executor.tick()

    const run = store.getLatestRunForTask(task.id)!
    const refreshedRun = store.getRunById(run.id)
    const refreshedTask = store.getTaskById(task.id)
    const events = store.getRunEvents(run.id)

    expect(refreshedRun.status).toBe("failed")
    expect(refreshedRun.worktreePath).not.toBeNull()
    expect(refreshedRun.branchName).not.toBeNull()
    expect(refreshedRun.headSha).not.toBeNull()
    expect(refreshedRun.metadata?.changedFiles).toContain("partial-timeout-change.txt")
    expect(existsSync(refreshedRun.worktreePath as string)).toBe(true)
    expect(
      execFileSync("git", ["show", `${refreshedRun.headSha}:partial-timeout-change.txt`], {
        cwd: project.repoPath,
        encoding: "utf8"
      })
    ).toContain("valuable implementation before timeout")
    expect(events.some((event) => event.message === "Execution worktree preserved after failure")).toBe(true)
    expect(events.some((event) => event.message === "Execution worktree cleaned up")).toBe(false)
    expect(refreshedTask.lastError).toContain("Implementation worktree preserved for repair")
    expect(refreshedTask.lastError).toContain(refreshedRun.worktreePath as string)

    store.close()
  })

  it("verifies a preserved transient implementation without requiring another edit", async () => {
    const { store, company, project } = await setupBase()
    if (!initGitRepo(project.repoPath)) {
      store.close()
      return
    }
    execFileSync("git", ["branch", "-M", "main"], { cwd: project.repoPath })
    const agent = store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Resume preserved implementation",
      kind: "implement",
      changedFiles: ["partial-timeout-change.txt"],
      reviewRequired: false,
      verificationCommands: ['test "$(cat partial-timeout-change.txt)" = completed']
    })

    const preservedBranch = "openclaw/run/preserved-timeout"
    const preservedRoot = join(project.repoPath, ".openclaw")
    const preservedWorktree = join(preservedRoot, "preserved-retry-source")
    const preservedManifest = `${preservedWorktree}.manifest.json`
    mkdirSync(preservedRoot, { recursive: true })
    execFileSync("git", ["worktree", "add", "-b", preservedBranch, preservedWorktree, "main"], {
      cwd: project.repoPath,
      stdio: "ignore"
    })
    writeFileSync(join(preservedWorktree, "partial-timeout-change.txt"), "completed\n", "utf8")
    execFileSync("git", ["add", "partial-timeout-change.txt"], { cwd: preservedWorktree })
    execFileSync("git", ["commit", "-m", "capture partial timeout work"], {
      cwd: preservedWorktree,
      stdio: "ignore"
    })
    const preservedHead = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: preservedWorktree,
      encoding: "utf8"
    }).trim()
    writeFileSync(preservedManifest, "{}\n", "utf8")

    const preservedRun = store.createRun({
      companyId: company.id,
      projectId: project.id,
      taskId: task.id,
      agentId: agent.id,
      adapterType: "codex_local",
      kind: "implement",
      worktreePath: preservedWorktree,
      manifestPath: preservedManifest
    })
    store.completeRun(preservedRun.id, {
      status: "failed",
      branchName: preservedBranch,
      headSha: preservedHead,
      errorText: [
        "Codex execution failed: ETIMEDOUT",
        `Implementation worktree preserved for repair: ${preservedWorktree}`
      ].join("\n"),
      retryClass: "transient"
    })

    let inheritedCompletedChange = false
    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async (context): Promise<AdapterExecutionResult> => {
        const target = join(context.project.repoPath, "partial-timeout-change.txt")
        inheritedCompletedChange = existsSync(target) && readFileSync(target, "utf8") === "completed\n"
        return { ok: true, response: "the preserved implementation is ready for deterministic verification" }
      }),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" })),
      azure_foundry: fakeAdapter("azure_foundry", async () => ({ ok: true, response: "unused" }))
    })

    await executor.tick()

    const retryRun = store.getLatestRunForTask(task.id)!
    const allocation = store.getRunEvents(retryRun.id).find((event) => event.message === "Execution worktree allocated")
    expect(inheritedCompletedChange).toBe(true)
    expect(retryRun.id).not.toBe(preservedRun.id)
    expect(retryRun.status).toBe("succeeded")
    expect(store.getTaskById(task.id).status).toBe("done")
    expect(allocation?.data).toMatchObject({
      baseRef: preservedBranch,
      inheritedSourceReason: "preserved_retry",
      retrySourceTaskId: task.id,
      retrySourceRunId: preservedRun.id,
      retrySourceRefKind: "local_branch"
    })
    expect(
      execFileSync("git", ["merge-base", "--is-ancestor", preservedHead, retryRun.headSha!], {
        cwd: project.repoPath
      })
    ).toBeDefined()
    expect(store.getRunById(preservedRun.id).worktreePath).toBeNull()
    expect(existsSync(preservedWorktree)).toBe(false)
    expect(
      store.getRunEvents(retryRun.id).some((event) => event.message === "Inherited preserved worktree cleaned up")
    ).toBe(true)

    store.close()
  })

  it("preserves implementation changes and repair context when verification fails", async () => {
    const { store, company, project } = await setupBase()
    if (!initGitRepo(project.repoPath)) {
      store.close()
      return
    }
    store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Preserve failed implementation",
      kind: "implement",
      changedFiles: ["failed-change.txt"],
      verificationCommands: ['sh -c "exit 1"'],
      maxRetries: 0
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async (context): Promise<AdapterExecutionResult> => {
        writeFileSync(join(context.project.repoPath, "failed-change.txt"), "valuable partial implementation\n", "utf8")
        return { ok: true, response: "implemented before verification failed" }
      }),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" })),
      azure_foundry: fakeAdapter("azure_foundry", async () => ({ ok: true, response: "unused" }))
    })

    await executor.tick()

    const run = store.getLatestRunForTask(task.id)!
    const refreshedRun = store.getRunById(run.id)
    const refreshedTask = store.getTaskById(task.id)

    expect(refreshedRun.status).toBe("failed")
    expect(refreshedRun.worktreePath).not.toBeNull()
    expect(refreshedRun.branchName).not.toBeNull()
    expect(refreshedRun.headSha).not.toBeNull()
    expect(existsSync(refreshedRun.worktreePath as string)).toBe(true)
    expect(
      execFileSync("git", ["show", `${refreshedRun.headSha}:failed-change.txt`], {
        cwd: project.repoPath,
        encoding: "utf8"
      })
    ).toContain("valuable partial implementation")
    expect(
      store.getRunEvents(run.id).some((event) => event.message === "Execution worktree preserved after failure")
    ).toBe(true)
    expect(store.getRunEvents(run.id).some((event) => event.message === "Execution worktree cleaned up")).toBe(false)
    expect(refreshedTask.lastError).toContain("Implementation worktree preserved for repair")
    expect(refreshedTask.lastError).toContain(refreshedRun.worktreePath as string)

    store.close()
  })

  it("captures tracked runtime files under ignored openclaw directories", async () => {
    const { store, company, project } = await setupBase()
    if (!initGitRepo(project.repoPath)) {
      store.close()
      return
    }

    const plannerFile = join(project.repoPath, ".openclaw", "planner", "planner.prompt.md")
    mkdirSync(join(project.repoPath, ".openclaw", "planner"), { recursive: true })
    writeFileSync(plannerFile, "initial planner prompt\n", "utf8")
    execFileSync("git", ["add", "-f", ".openclaw/planner/planner.prompt.md"], { cwd: project.repoPath })
    execFileSync("git", ["commit", "-m", "track planner prompt"], { cwd: project.repoPath, stdio: "ignore" })
    writeFileSync(join(project.repoPath, ".gitignore"), ".openclaw/\n!.openclaw/\n.openclaw/*\n", "utf8")
    execFileSync("git", ["add", ".gitignore"], { cwd: project.repoPath })
    execFileSync("git", ["commit", "-m", "ignore runtime state"], { cwd: project.repoPath, stdio: "ignore" })

    store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Update planner prompt",
      kind: "implement"
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async (context): Promise<AdapterExecutionResult> => {
        writeFileSync(join(context.project.repoPath, ".openclaw", "planner", "planner.prompt.md"), "updated\n", "utf8")
        return { ok: true, response: "updated ignored tracked planner file" }
      }),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" })),
      azure_foundry: fakeAdapter("azure_foundry", async () => ({ ok: true, response: "unused" }))
    })

    await executor.tick()
    const run = store.getLatestRunForTask(task.id)!
    const committed = execFileSync("git", ["show", `${run.headSha}:.openclaw/planner/planner.prompt.md`], {
      cwd: project.repoPath,
      encoding: "utf8"
    })

    expect(store.getTaskById(task.id).status).toBe("done")
    expect(run.status).toBe("succeeded")
    expect(committed).toBe("updated\n")

    store.close()
  }, 15_000)

  it("reroutes AI adapter timeouts to a fallback adapter instead of retrying the same route", async () => {
    const { store, company, project } = await setupBase()
    store.createAgent({
      companyRef: company.id,
      name: "gemini",
      role: "UI Engineer",
      adapterType: "gemini_local"
    })
    store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Software Engineer",
      adapterType: "codex_local"
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Retry on fallback adapter",
      kind: "implement",
      requestedAdapterType: "gemini_local",
      maxRetries: 1
    })

    let geminiCalls = 0
    let codexCalls = 0
    const executor = new DispatcherExecutor!(store, {
      gemini_local: fakeAdapter("gemini_local", async () => {
        geminiCalls += 1
        return {
          ok: false,
          response: "",
          error: "Gemini execution failed: ETIMEDOUT: Gemini execution timed out",
          failureCategory: "timeout"
        }
      }),
      codex_local: fakeAdapter("codex_local", async (context) => {
        codexCalls += 1
        writeFileSync(join(context.project.repoPath, "codex-fallback.txt"), "fallback edited\n", "utf8")
        return { ok: true, response: "edited with fallback" }
      }),
      azure_foundry: fakeAdapter("azure_foundry", async () => ({ ok: true, response: "unused" }))
    })

    const summary = await executor.tick()
    const updatedTask = store.getTaskById(task.id)

    expect(summary.executedRuns).toBe(1)
    expect(updatedTask.status).toBe("queued")
    expect(updatedTask.retryCount).toBe(0)
    expect(updatedTask.requestedAdapterType).toBe("codex_local")
    expect(updatedTask.assignedAgentId).toBeNull()
    const rerouteEvent = store.getTaskEvents(task.id).find((event) => event.kind === "adapter-failure-rerouted")
    expect(rerouteEvent?.data).toMatchObject({ retryCharged: false })

    const fallbackSummary = await executor.tick()
    const runs = store.listRuns().filter((run) => run.taskId === task.id)

    expect(fallbackSummary.executedRuns).toBe(1)
    expect(geminiCalls).toBe(1)
    expect(codexCalls).toBe(1)
    expect(runs.map((run) => run.adapterType)).toEqual(expect.arrayContaining(["gemini_local", "codex_local"]))

    store.close()
  })

  it("reroutes Codex quota failures to a tool-capable ACP agent without charging a retry", async () => {
    const { store, company, project } = await setupBase()
    store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Software Engineer",
      adapterType: "codex_local"
    })
    store.createAgent({
      companyRef: company.id,
      name: "foundry",
      role: "Foundry Planner",
      adapterType: "azure_foundry"
    })
    store.createAgent({
      companyRef: company.id,
      name: "opencode",
      role: "ACP Software Engineer",
      adapterType: "gemini_local"
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Keep coding after Codex quota exhaustion",
      kind: "implement",
      requestedAdapterType: "codex_local",
      maxRetries: 1
    })

    let codexCalls = 0
    let geminiCalls = 0
    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async () => {
        codexCalls += 1
        return {
          ok: false,
          response: "",
          error: "Codex execution failed: Your workspace is out of credits.",
          failureCategory: "quota"
        }
      }),
      gemini_local: fakeAdapter("gemini_local", async (context) => {
        geminiCalls += 1
        writeFileSync(join(context.project.repoPath, "acp-fallback.txt"), "ACP fallback edited\n", "utf8")
        return { ok: true, response: "edited with ACP fallback" }
      }),
      azure_foundry: fakeAdapter("azure_foundry", async () => ({ ok: true, response: "planner only" }))
    })

    await executor.tick()
    const reroutedTask = store.getTaskById(task.id)
    const rerouteEvent = store.getTaskEvents(task.id).find((event) => event.kind === "adapter-failure-rerouted")

    expect(reroutedTask.status).toBe("queued")
    expect(reroutedTask.retryCount).toBe(0)
    expect(reroutedTask.requestedAdapterType).toBe("gemini_local")
    expect(rerouteEvent?.data).toMatchObject({
      fromAdapterType: "codex_local",
      toAdapterType: "gemini_local",
      retryCharged: false
    })

    await executor.tick()
    const runs = store.listRuns().filter((run) => run.taskId === task.id)

    expect(store.getTaskById(task.id).status).toBe("done")
    expect(codexCalls).toBe(1)
    expect(geminiCalls).toBe(1)
    expect(runs.map((run) => run.adapterType)).toEqual(["gemini_local", "codex_local"])

    store.close()
  })

  it("skips an exhausted cooperative rate-pool agent before allocating execution work", async () => {
    const { store, company, project } = await setupBase()
    store.createAgent({
      companyRef: company.id,
      name: "exhausted-opencode",
      role: "ACP Software Engineer",
      adapterType: "gemini_local"
    })
    store.createAgent({
      companyRef: company.id,
      name: "available-opencode",
      role: "ACP Software Engineer",
      adapterType: "gemini_local"
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Use an ACP agent with rate-pool headroom",
      kind: "implement",
      requestedAdapterType: "gemini_local",
      reviewRequired: false,
      changedFiles: ["rate-pool-fallback.txt"]
    })
    const stateDir = join(project.repoPath, ".openclaw", "state")
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(
      join(stateDir, "rate-pool.json"),
      JSON.stringify({
        totalLimit: 5000,
        resetAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        allocations: {
          "exhausted-opencode": {
            priority: task.priority,
            allocated: 1250,
            used: 40_000,
            leaseExpiry: new Date(Date.now() + 5 * 60 * 1000).toISOString()
          }
        }
      }),
      "utf8"
    )

    let selectedAgentName: string | null = null
    const executor = new DispatcherExecutor!(store, {
      gemini_local: fakeAdapter("gemini_local", async (context) => {
        selectedAgentName = context.agent.name
        writeFileSync(join(context.project.repoPath, "rate-pool-fallback.txt"), "continued coding\n", "utf8")
        return { ok: true, response: "continued with available ACP capacity" }
      })
    })

    await executor.tick()

    expect(selectedAgentName).toBe("available-opencode")
    expect(store.getTaskById(task.id).status).toBe("done")
    const skipEvent = store.getTaskEvents(task.id).find((event) => event.kind === "cooperative-rate-pool-agent-skipped")
    expect(skipEvent?.data).toMatchObject({
      adapterType: "gemini_local",
      candidates: [
        expect.objectContaining({
          agentName: "exhausted-opencode",
          allowed: false,
          allocated: 1250,
          used: 40_000
        })
      ]
    })
    expect(
      store
        .listRuns()
        .filter((run) => run.taskId === task.id)
        .some((run) => run.verificationSummary === "cooperative-rate-pool-deferred")
    ).toBe(false)

    store.close()
  })

  it("clears a failed assignee when the task already requests the fallback adapter", async () => {
    const { store, company, project } = await setupBase()
    const codex = store.createAgent({
      companyRef: company.id,
      name: "stale-codex-assignee",
      role: "Software Engineer",
      adapterType: "codex_local"
    })
    store.createAgent({
      companyRef: company.id,
      name: "available-opencode",
      role: "ACP Software Engineer",
      adapterType: "gemini_local"
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Release stale Codex assignment",
      kind: "implement",
      requestedAdapterType: "gemini_local",
      maxRetries: 1
    })
    store.updateTask(task.id, { assignedAgentId: codex.id })

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async () => ({
        ok: false,
        response: "",
        error: "Codex execution failed: Your workspace is out of credits.",
        failureCategory: "quota"
      })),
      gemini_local: fakeAdapter("gemini_local", async (context) => {
        writeFileSync(join(context.project.repoPath, "released-assignee.txt"), "edited\n", "utf8")
        return { ok: true, response: "edited after stale assignee release" }
      })
    })

    await executor.tick()
    const reroutedTask = store.getTaskById(task.id)
    const rerouteEvent = store.getTaskEvents(task.id).find((event) => event.kind === "adapter-failure-rerouted")

    expect(reroutedTask).toMatchObject({
      status: "queued",
      retryCount: 0,
      requestedAdapterType: "gemini_local",
      assignedAgentId: null
    })
    expect(rerouteEvent?.data).toMatchObject({ requestedAdapterAlreadyMatched: true, retryCharged: false })

    await executor.tick()
    expect(store.getTaskById(task.id).status).toBe("done")
    store.close()
  })

  it("defers transient adapter outages without exhausting task retries when no fallback is available", async () => {
    const { store, company, project } = await setupBase()
    store.createAgent({
      companyRef: company.id,
      name: "only-opencode-worker",
      role: "ACP Software Engineer",
      adapterType: "gemini_local"
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Wait for ACP capacity",
      kind: "fix_review_feedback",
      requestedAdapterType: "gemini_local",
      maxRetries: 1
    })

    const executor = new DispatcherExecutor!(store, {
      gemini_local: fakeAdapter("gemini_local", async () => ({
        ok: false,
        response: "",
        error: "ACPX model fallback budget exhausted after 1200000ms.",
        failureCategory: "timeout"
      }))
    })

    await executor.tick()
    const deferredTask = store.getTaskById(task.id)
    const deferredEvent = store.getTaskEvents(task.id).find((event) => event.kind === "adapter-failure-deferred")
    const run = store.getLatestRunForTask(task.id)!

    expect(deferredTask).toMatchObject({
      status: "queued",
      retryCount: 0,
      requestedAdapterType: "gemini_local",
      assignedAgentId: null
    })
    expect(deferredEvent?.data).toMatchObject({
      adapterType: "gemini_local",
      retryCharged: false,
      retryClass: "transient"
    })
    expect(run).toMatchObject({ status: "failed", retryClass: "transient" })

    store.close()
  })

  it("expands built-in variables in automation-generated repo health tasks", async () => {
    const { store, company, project } = await setupBase()
    store.createAutomation({
      companyRef: company.id,
      projectRef: project.id,
      name: "daily-health",
      kind: "repo_health",
      cron: "* * * * *",
      nextRunAt: new Date(Date.now() - 60_000).toISOString(),
      payload: {
        projectRef: project.id,
        title: "Repo health {{date}}",
        description: "Run daily sweep for {{ date }}."
      }
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async () => ({ ok: true, response: "unused" })),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" }))
    })

    const summary = await executor.tick()
    const createdTask = store.listProjectTasks(project.id).find((task) => task.source === "repo_health")

    expect(summary.executedJobs).toBe(1)
    expect(createdTask?.title).toMatch(/^Repo health \d{4}-\d{2}-\d{2}$/)
    expect(createdTask?.description).toMatch(/^Run daily sweep for \d{4}-\d{2}-\d{2}\.$/)

    store.close()
  })

  it("reaps stale running runs before scheduling new work", async () => {
    process.env.OPENCLAW_STALE_RUN_THRESHOLD_MS = "1"

    const { store, company, project } = await setupBase()
    const agent = store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const staleTask = store.createTask({
      projectRef: project.id,
      title: "Stale running task",
      assignedAgentRef: agent.id
    })

    store.claimTask(staleTask.id)
    const run = store.createRun({
      companyId: company.id,
      projectId: project.id,
      taskId: staleTask.id,
      agentId: agent.id,
      adapterType: "codex_local",
      sessionKey: `${agent.id}:${project.id}:${staleTask.id}`
    })
    store.setAgentStatus(agent.id, "running")
    ;(store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db
      .prepare("UPDATE runs SET started_at = ?, created_at = ?, updated_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z", run.id)

    const nextTask = store.createTask({
      projectRef: project.id,
      title: "Fresh queued task",
      assignedAgentRef: agent.id
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async () => ({ ok: true, response: "done" })),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" }))
    })

    const summary = await executor.tick()
    expect(summary.executedRuns).toBe(2)
    expect(store.getTaskById(staleTask.id).status).toBe("done")
    expect(["expired", "unclaimed"]).toContain(store.getTaskById(staleTask.id).claimStatus)
    expect(store.getTaskById(staleTask.id).lastRecoveryReason).toBe("stale_run_reaped")
    expect(store.getRunById(run.id).status).toBe("failed")
    expect(store.getTaskById(nextTask.id).status).toBe("done")

    store.close()
  })

  it("reaps a fresh run when its recorded dispatcher owner exited", async () => {
    const { store, company, project } = await setupBase()
    const agent = store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Interrupted promotion",
      assignedAgentRef: agent.id
    })

    store.claimTask(task.id)
    const run = store.createRun({
      companyId: company.id,
      projectId: project.id,
      taskId: task.id,
      agentId: agent.id,
      adapterType: "codex_local",
      sessionKey: `${agent.id}:${project.id}:${task.id}`
    })
    store.setAgentStatus(agent.id, "running")
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

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async () => ({ ok: true, response: "done" })),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" }))
    })

    await executor.tick()
    expect(store.getRunById(run.id)).toMatchObject({
      status: "failed",
      errorText: expect.stringContaining("owner process 9999999 exited")
    })
    expect(store.getTaskById(task.id).status).toBe("done")
    expect(store.getTaskById(task.id).lastRecoveryReason).toBe("stale_run_reaped")

    store.close()
  })

  it("keeps a long-running run alive while run events show recent activity", async () => {
    process.env.OPENCLAW_STALE_RUN_THRESHOLD_MS = "60000"

    const { store, company, project } = await setupBase()
    const agent = store.createAgent({
      companyRef: company.id,
      name: "active-codex",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Long-running active task",
      assignedAgentRef: agent.id
    })
    store.claimTask(task.id)
    const run = store.createRun({
      companyId: company.id,
      projectId: project.id,
      taskId: task.id,
      agentId: agent.id,
      adapterType: "codex_local",
      sessionKey: `${agent.id}:${project.id}:${task.id}`
    })
    store.setAgentStatus(agent.id, "running")
    ;(store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db
      .prepare("UPDATE runs SET started_at = ?, created_at = ?, updated_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z", run.id)
    store.appendRunEvent(run.id, "info", "Agent is still making progress")

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async () => ({ ok: true, response: "unused" })),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" }))
    })

    const summary = await executor.tick()
    expect(summary.executedRuns).toBe(0)
    expect(store.getRunById(run.id).status).toBe("running")
    expect(store.getTaskById(task.id).status).toBe("running")

    store.close()
  })

  it("emits periodic adapter heartbeats while a long coding process is still active", async () => {
    process.env.OPENCLAW_RUN_HEARTBEAT_INTERVAL_MS = "10"
    const { store, company, project } = await setupBase()
    const agent = store.createAgent({
      companyRef: company.id,
      name: "heartbeat-codex",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Long coding task with heartbeat",
      assignedAgentRef: agent.id
    })
    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async (context) => {
        context.log("info", "Launching ACPX agent", { model: "opencode/fallback-code" })
        await new Promise((resolve) => setTimeout(resolve, 45))
        writeFileSync(join(context.project.repoPath, "heartbeat.txt"), "alive\n", "utf8")
        return { ok: true, response: "done" }
      }),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" }))
    })

    await executor.tick()
    const run = store.getLatestRunForTask(task.id)
    expect(run?.status).toBe("succeeded")
    const heartbeat = store.getRunEvents(run!.id).find((event) => event.message === "Adapter execution heartbeat")
    expect(heartbeat?.data).toMatchObject({ model: "opencode/fallback-code" })
    store.close()
  })

  it("emits periodic verification heartbeats while a long check is still active", async () => {
    process.env.OPENCLAW_RUN_HEARTBEAT_INTERVAL_MS = "10"
    const { store, company, project } = await setupBase()
    const agent = store.createAgent({
      companyRef: company.id,
      name: "verification-heartbeat-codex",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Long verification task with heartbeat",
      assignedAgentRef: agent.id,
      verificationCommands: ['sh -c "sleep 0.08"']
    })
    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async (context) => {
        writeFileSync(join(context.project.repoPath, "verification-heartbeat.txt"), "alive\n", "utf8")
        return { ok: true, response: "done" }
      }),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" }))
    })

    await executor.tick()
    const run = store.getLatestRunForTask(task.id)
    expect(run?.status).toBe("succeeded")
    expect(store.getRunEvents(run!.id).some((event) => event.message === "Verification command heartbeat")).toBe(true)
    store.close()
  })

  it("reclaims expired leases before executing fresh work", async () => {
    const { store, company, project } = await setupBase()
    store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const expiredTask = store.createTask({
      projectRef: project.id,
      title: "Expired lease task"
    })
    const lease = store.claimTask(expiredTask.id)
    expect(lease).not.toBeNull()
    store.updateTask(expiredTask.id, {
      claimExpiresAt: "2000-01-01T00:00:00.000Z"
    })

    const freshTask = store.createTask({
      projectRef: project.id,
      title: "Fresh queued task"
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async () => ({ ok: true, response: "done" })),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" }))
    })

    const summary = await executor.tick()
    expect(summary.executedRuns).toBe(2)
    expect(store.getTaskById(expiredTask.id).status).toBe("done")
    expect(["expired", "unclaimed"]).toContain(store.getTaskById(expiredTask.id).claimStatus)
    expect(store.getTaskById(expiredTask.id).lastRecoveryReason).toBe("claim_timeout")
    expect(store.getTaskEvents(expiredTask.id).some((event) => event.kind === "lease-expired")).toBe(true)
    expect(store.getTaskById(freshTask.id).status).toBe("done")

    store.close()
  })

  it("caps planner runs and only scans the top queued task window", async () => {
    process.env.OPENCLAW_MAX_PLANNER_RUNS_PER_TICK = "1"
    process.env.OPENCLAW_QUEUED_TASK_WINDOW = "2"

    const { store, company, project } = await setupBase()
    store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local"
    })

    const firstPlanner = store.createTask({
      projectRef: project.id,
      title: "Plan A",
      kind: "plan",
      stage: "planner",
      priority: 100
    })
    const secondPlanner = store.createTask({
      projectRef: project.id,
      title: "Plan B",
      kind: "plan",
      stage: "planner",
      priority: 99
    })
    const outsideWindow = store.createTask({
      projectRef: project.id,
      title: "Plan C",
      kind: "plan",
      stage: "planner",
      priority: 1
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async () => ({ ok: true, response: "planned" })),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" }))
    })

    const summary = await executor.tick()
    expect(summary.executedRuns).toBe(1)
    expect(store.getTaskById(firstPlanner.id).status).toBe("done")
    expect(store.getTaskById(secondPlanner.id).status).toBe("queued")
    expect(store.getTaskById(outsideWindow.id).status).toBe("queued")

    store.close()
  })

  it("prioritizes blocking repair work over fresh implementations", async () => {
    process.env.OPENCLAW_QUEUED_TASK_WINDOW = "1"

    const { store, company, project } = await setupBase()
    store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local"
    })

    const freshImplementation = store.createTask({
      projectRef: project.id,
      title: "Fresh implementation",
      kind: "implement",
      priority: 1000,
      requestedAdapterType: "codex_local"
    })
    const blockingRepair = store.createTask({
      projectRef: project.id,
      title: "Address blocking review feedback",
      kind: "fix_review_feedback",
      priority: 1,
      requestedAdapterType: "codex_local"
    })

    const executedTaskIds: string[] = []
    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async (context) => {
        executedTaskIds.push(context.task.id)
        writeFileSync(join(context.project.repoPath, "review-fix.txt"), "fixed\n", "utf8")
        return { ok: true, response: "fixed" }
      }),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" }))
    })

    const summary = await executor.tick()
    expect(summary.executedRuns).toBe(1)
    expect(executedTaskIds).toEqual([blockingRepair.id])
    expect(store.getTaskById(blockingRepair.id).status).toBe("done")
    expect(store.getTaskById(freshImplementation.id).status).toBe("queued")

    store.close()
  })

  it("requeues a blocked promotion as soon as its review feedback fix succeeds", async () => {
    process.env.OPENCLAW_QUEUED_TASK_WINDOW = "1"

    const { store, company, project } = await setupBase()
    store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const implementation = store.createTask({
      projectRef: project.id,
      title: "Implementation awaiting review feedback",
      kind: "implement",
      priority: 60
    })
    store.updateTaskStatus(implementation.id, "promotion_pending")
    const promoteTask = store.createTask({
      projectRef: project.id,
      title: "Promote implementation awaiting review feedback",
      kind: "promote",
      parentTaskId: implementation.id,
      priority: 80
    })
    store.updateTaskStatus(promoteTask.id, "blocked", {
      blockedReason: "awaiting_review_feedback"
    })
    const feedbackTask = store.createTask({
      projectRef: project.id,
      title: "Address blocking review feedback",
      kind: "fix_review_feedback",
      parentTaskId: implementation.id,
      source: "promotion_feedback",
      priority: 70,
      requestedAdapterType: "codex_local"
    })
    store.createPromotion({
      companyId: company.id,
      projectId: project.id,
      taskId: implementation.id,
      branchName: "openclaw/run/review-feedback",
      promotionStatus: "awaiting_fixes"
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async (context) => {
        writeFileSync(join(context.project.repoPath, "review-fix.txt"), "fixed\n", "utf8")
        return { ok: true, response: "fixed" }
      }),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" }))
    })

    const summary = await executor.tick()

    expect(summary.executedRuns).toBe(1)
    expect(store.getTaskById(feedbackTask.id).status).toBe("done")
    expect(store.getTaskById(promoteTask.id).status).toBe("queued")
    expect(store.getTaskById(promoteTask.id).blockedReason).toBeNull()
    expect(store.getPromotionByTaskId(implementation.id)?.promotionStatus).toBe("waiting_for_review")
    expect(store.getTaskEvents(promoteTask.id).map((event) => event.kind)).toContain(
      "review-feedback-fixed-promotion-requeued"
    )

    store.close()
  })

  it("recovers a promotion when the dispatcher restarted after feedback completion", async () => {
    process.env.OPENCLAW_QUEUED_TASK_WINDOW = "1"

    const { store, company, project } = await setupBase()
    store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const implementation = store.createTask({
      projectRef: project.id,
      title: "Implementation awaiting recovered feedback",
      kind: "implement"
    })
    store.updateTaskStatus(implementation.id, "promotion_pending")
    const promoteTask = store.createTask({
      projectRef: project.id,
      title: "Promote implementation after restart",
      kind: "promote",
      parentTaskId: implementation.id
    })
    store.updateTaskStatus(promoteTask.id, "blocked", {
      blockedReason: "awaiting_review_feedback"
    })
    const feedbackTask = store.createTask({
      projectRef: project.id,
      title: "Completed feedback before restart",
      kind: "fix_review_feedback",
      parentTaskId: implementation.id,
      source: "promotion_feedback"
    })
    store.updateTaskStatus(feedbackTask.id, "done")
    const feedbackRun = store.createRun({
      companyId: company.id,
      projectId: project.id,
      taskId: feedbackTask.id,
      kind: "fix_review_feedback",
      adapterType: "codex_local"
    })
    store.completeRun(feedbackRun.id, { status: "succeeded" })
    store.createTask({
      projectRef: project.id,
      title: "Keep the recovered promotion queued for inspection",
      kind: "plan",
      priority: 100
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async () => ({ ok: true, response: "planned" })),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" }))
    })

    const summary = await executor.tick()

    expect(summary.executedRuns).toBe(1)
    expect(store.getTaskById(promoteTask.id).status).toBe("queued")
    expect(store.getTaskById(promoteTask.id).blockedReason).toBeNull()
    expect(store.getTaskEvents(promoteTask.id).map((event) => event.kind)).toContain(
      "review-feedback-fixed-promotion-requeued"
    )

    store.close()
  })

  it("scheduled promotion sync requeues retryable child promotion gates", async () => {
    process.env.OPENCLAW_QUEUED_TASK_WINDOW = "1"

    const { store, company, project } = await setupBase()
    store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const implementation = store.createTask({
      projectRef: project.id,
      title: "Implementation waiting for CI",
      kind: "implement"
    })
    store.updateTaskStatus(implementation.id, "promotion_pending")
    const promoteTask = store.createTask({
      projectRef: project.id,
      title: "Promote implementation waiting for CI",
      kind: "promote",
      parentTaskId: implementation.id
    })
    store.updateTaskStatus(promoteTask.id, "blocked", {
      blockedReason: "waiting_for_checks"
    })
    store.createPromotion({
      companyId: company.id,
      projectId: project.id,
      taskId: implementation.id,
      branchName: "openclaw/run/waiting-for-ci",
      promotionStatus: "waiting_for_checks"
    })
    store.createAutomation({
      companyRef: company.id,
      projectRef: project.id,
      name: "retry-promotions",
      kind: "blocked_promotion_retry",
      cron: "* * * * *",
      nextRunAt: new Date(Date.now() - 60_000).toISOString(),
      payload: { projectRef: project.id }
    })
    store.createTask({
      projectRef: project.id,
      title: "Keep the requeued promotion available for inspection",
      kind: "plan",
      priority: 100
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async () => ({ ok: true, response: "planned" })),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" }))
    })

    const summary = await executor.tick()

    expect(summary.executedJobs).toBe(1)
    expect(store.getTaskById(promoteTask.id).status).toBe("queued")
    expect(store.getTaskById(promoteTask.id).blockedReason).toBeNull()
    expect(store.getTaskEvents(promoteTask.id).map((event) => event.kind)).toContain(
      "scheduled-promotion-retry-requeued"
    )

    store.close()
  })

  it("prefers runnable planner tasks over blocked descendants inside the queue window", async () => {
    process.env.OPENCLAW_MAX_PLANNER_RUNS_PER_TICK = "1"
    process.env.OPENCLAW_QUEUED_TASK_WINDOW = "3"

    const { store, company, project } = await setupBase()
    const planner = store.createAgent({
      companyRef: company.id,
      name: "planner",
      role: "Planner",
      adapterType: "codex_local"
    })

    const failedParent = store.createTask({
      projectRef: project.id,
      title: "Failed plan",
      kind: "plan",
      stage: "planner",
      priority: 1000,
      assignedAgentRef: planner.id
    })
    store.updateTaskStatus(failedParent.id, "failed", { lastError: "old failure" })

    store.createTask({
      projectRef: project.id,
      title: "Blocked implement",
      kind: "implement",
      stage: "coder",
      priority: 1000,
      dependsOnTaskIds: [failedParent.id],
      requestedAdapterType: "codex_local"
    })
    store.createTask({
      projectRef: project.id,
      title: "Blocked review",
      kind: "review",
      stage: "reviewer",
      priority: 1000,
      dependsOnTaskIds: [failedParent.id],
      requestedAdapterType: "codex_local"
    })
    store.createTask({
      projectRef: project.id,
      title: "Blocked promote",
      kind: "promote",
      stage: "promoter",
      priority: 1000,
      dependsOnTaskIds: [failedParent.id],
      requestedAdapterType: "codex_local"
    })

    const runnablePlan = store.createTask({
      projectRef: project.id,
      title: "Runnable plan",
      kind: "plan",
      stage: "planner",
      priority: 1000,
      assignedAgentRef: planner.id
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async () => ({ ok: true, response: "planned" })),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" }))
    })

    const summary = await executor.tick()
    expect(summary.executedRuns).toBe(1)
    expect(store.getTaskById(runnablePlan.id).status).toBe("done")

    store.close()
  })

  it("defers AI follow-up work while promotion tasks are still queued", async () => {
    const { store, company, project } = await setupBase()
    const planner = store.createAgent({
      companyRef: company.id,
      name: "planner",
      role: "Planner",
      adapterType: "codex_local"
    })

    const failedParent = store.createTask({
      projectRef: project.id,
      title: "Failed prerequisite",
      kind: "plan",
      stage: "planner",
      priority: 1000,
      assignedAgentRef: planner.id
    })
    store.updateTaskStatus(failedParent.id, "failed", { lastError: "old failure" })

    store.createTask({
      projectRef: project.id,
      title: "Queued promotion",
      kind: "promote",
      stage: "promoter",
      priority: 1000,
      dependsOnTaskIds: [failedParent.id],
      requestedAdapterType: "codex_local"
    })
    const followUpTask = store.createTask({
      projectRef: project.id,
      title: "AI follow-up",
      kind: "follow_up",
      stage: "coder",
      priority: 1000,
      requestedAdapterType: "codex_local"
    })

    let adapterCalls = 0
    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async () => {
        adapterCalls += 1
        return { ok: true, response: "unused" }
      }),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" }))
    })

    const summary = await executor.tick()
    expect(summary.executedRuns).toBe(0)
    expect(adapterCalls).toBe(0)
    expect(store.getTaskById(followUpTask.id).status).toBe("queued")
    expect(store.getTaskEvents(followUpTask.id).map((event) => event.kind)).toContain("promotion-backlog-deferred")

    store.close()
  })

  it("keeps the preferred Codex planner first when configured accounts have stale quota data", async () => {
    const { store, company } = await setupBase()
    const codexPlanner = store.createAgent({
      companyRef: company.id,
      name: "planner",
      role: "Planner",
      adapterType: "codex_local",
      model: "gpt-5.6-sol"
    })
    const geminiFallback = store.createAgent({
      companyRef: company.id,
      name: "planner-opencode-fallback",
      role: "Planner OpenCode fallback",
      adapterType: "gemini_local",
      model: "gemini-3.1-pro",
      env: {
        OPENCLAW_GEMINI_ACPX_MODEL: "opencode/north-mini-code-free"
      }
    })
    const plannerPersona = store.createPersona({
      companyRef: company.id,
      name: "planner",
      stage: "planner",
      preferredAdapterType: "codex_local"
    })
    const profile = loadProjectProfile!("minimal-repo")
    const quota: CodexQuotaOverview = {
      generatedAt: new Date().toISOString(),
      activeAccount: "primary",
      bestAccount: null,
      assessment: "degraded",
      switcherConfigured: true,
      availableAccounts: 1,
      healthyAccounts: 0,
      warmAccounts: 0,
      blockedAccounts: 0,
      unknownAccounts: 1,
      recommendedMaxConcurrentCodexRuns: 1,
      accounts: []
    }

    const candidates = plannerAgentCandidates!({
      agents: store.listAgents(company.id),
      plannerPersona,
      profile,
      quota
    })

    expect(candidates.map((agent) => agent.id)).toEqual([codexPlanner.id, geminiFallback.id])
    expect(resolvePlannerExecutionAgent!(profile, geminiFallback).model).toBe("opencode/north-mini-code-free")
    store.close()
  })

  it("keeps an Azure planner fallback on its configured deployed model", async () => {
    const { store, company } = await setupBase()
    const azureFallback = store.createAgent({
      companyRef: company.id,
      name: "planner-azure-fallback",
      role: "Planner Azure fallback",
      adapterType: "azure_foundry",
      model: "Kimi-K2.6"
    })
    const profile = loadProjectProfile!("lawyerrag")

    expect(profile.planner.costPolicy.preferredPlannerModel).toBe("auto")
    expect(resolvePlannerExecutionAgent!(profile, azureFallback).model).toBe("Kimi-K2.6")
    store.close()
  })

  it("retains a non-Codex planner fallback when the profile fallback is Codex", async () => {
    const { store, company } = await setupBase()
    const codexPlanner = store.createAgent({
      companyRef: company.id,
      name: "planner",
      role: "Planner",
      adapterType: "codex_local",
      model: "gpt-5.6-sol"
    })
    const geminiFallback = store.createAgent({
      companyRef: company.id,
      name: "planner-opencode-fallback",
      role: "Planner OpenCode fallback",
      adapterType: "gemini_local",
      model: "opencode/north-mini-code-free"
    })
    const plannerPersona = store.createPersona({
      companyRef: company.id,
      name: "planner",
      stage: "planner",
      preferredAdapterType: "codex_local"
    })
    const profile = loadProjectProfile!("lawyerrag")

    expect(profile.planner.costPolicy.fallbackPlannerAdapterType).toBe("gemini_local")
    profile.planner.costPolicy.fallbackPlannerAdapterType = "codex_local"
    const candidates = plannerAgentCandidates!({
      agents: store.listAgents(company.id),
      plannerPersona,
      profile,
      quota: null
    })

    expect(candidates.map((agent) => agent.id)).toEqual([codexPlanner.id, geminiFallback.id])
    store.close()
  })

  it("runs queue-refresh planner automation and creates deduped tasks", async () => {
    const tickStartedAt = new Date("2026-01-01T00:00:10.000Z")
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] })
    vi.setSystemTime(tickStartedAt)
    const { store, company, project } = await setupBase()
    const plannerAgent = store.createAgent({
      companyRef: company.id,
      name: "planner",
      role: "Planner",
      adapterType: "codex_local"
    })
    store.createPersona({
      companyRef: company.id,
      name: "planner",
      stage: "planner",
      preferredAdapterType: "codex_local"
    })
    store.createPersona({
      companyRef: company.id,
      name: "prompt-engineer",
      stage: "coder",
      ownedLanes: ["prompting", "planning", "app-core"],
      preferredAdapterType: "codex_local"
    })
    const queueRefresh = store.createAutomation({
      companyRef: company.id,
      projectRef: project.id,
      name: "queue-refresh",
      kind: "queue_refresh",
      cron: "* * * * *",
      nextRunAt: new Date(Date.now() - 60_000).toISOString(),
      payload: { projectRef: project.id }
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async (context): Promise<AdapterExecutionResult> => {
        if (context.task.title.startsWith("Planner run")) {
          expect(context.prompt).toContain('"candidates"')
          expect(context.prompt).toContain(
            "Do not include markdown fences, prose, queueActions, plannedTask, reviewTask"
          )
          expect(context.prompt).toContain("Each queue-refresh is an active persona-led repo-search pass")
          expect(context.prompt).toContain("fresh vertical feature-slice coding tasks")
          expect(context.prompt).toContain("Persona ideation roster:")
          expect(context.prompt).toContain("coding-phase execution contract")
          expect(context.prompt).toContain("Framework inspiration backlog:")
          expect(context.prompt).toContain("capability-witness")
          expect(context.prompt).toContain("release-witness")
          expect(context.prompt).toContain("laneInventory")
          await vi.advanceTimersByTimeAsync(2 * 60_000)
          return {
            ok: true,
            response: JSON.stringify({
              version: 1,
              summary: "planner generated one task",
              candidates: [
                {
                  title: "Harden repo task packaging",
                  description: "Keep planner-generated queue items verified.",
                  kind: "implement",
                  lane: "app-core",
                  personaId: null,
                  preferredAdapterType: "codex_local",
                  priority: 70,
                  requiredReading: ["README.md"],
                  verificationChecklist: ["printf 'planner-check\\n'"],
                  contractUpdateReminders: [],
                  repoNotes: [],
                  dependencies: [],
                  tags: ["planner"],
                  riskLevel: "medium",
                  governanceClass: "normal",
                  dedupeKey: "app-core:harden-task-packaging",
                  sourceSignals: ["changed:none"],
                  estimatedCost: 1,
                  createMode: "queue_now"
                }
              ]
            })
          }
        }
        return { ok: true, response: "unused" }
      }),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" }))
    })

    const summary = await executor.tick()
    expect(summary.executedJobs).toBeGreaterThanOrEqual(1)
    const plannerRuns = store.listRecentPlannerRuns(project.id, 5)
    expect(plannerRuns).toHaveLength(1)
    expect(plannerRuns[0]!.summaryJson?.createdTaskIds.length).toBe(1)
    const createdTasks = store.listProjectTasks(project.id).filter((task) => task.labels.includes("planner-generated"))
    expect(createdTasks).toHaveLength(1)
    expect(createdTasks[0]!.title).toBe("Harden repo task packaging")
    expect(createdTasks[0]!.labels).toContain("prompt-ideated")
    expect(createdTasks[0]!.labels).toContain("promptified")
    expect(createdTasks[0]!.description).toBe("Keep planner-generated queue items verified.")
    expect(createdTasks[0]!.taskPackage?.extraInstructions).toContain(
      "This task passed through the promptify persona stage before routing."
    )
    const extraInstructions = createdTasks[0]!.taskPackage?.extraInstructions ?? []
    expect(extraInstructions.join("\n")).toContain("# Persona execution contract")
    expect(extraInstructions.join("\n")).toContain("## Persona ideation synthesis")
    expect(extraInstructions.join("\n")).toContain("Skeptical maintainer")
    expect(extraInstructions.join("\n")).toContain("## Verification stance")
    expect(extraInstructions.join("\n")).not.toContain("## Acceptance contract")
    expect(extraInstructions.join("\n")).toContain("## Completion protocol")
    expect(createdTasks[0]!.taskPackage?.repoNotes.join("\n")).toContain("Prompt ideated by prompt-engineer")
    expect(createdTasks[0]!.taskPackage?.repoNotes.join("\n")).toContain("Persona must ground this feature slice")
    expect(createdTasks[0]!.taskPackage?.inferenceSignals.join("\n")).toContain("repo-search:required-reading")
    expect(store.getPlannerEvents(plannerRuns[0]!.id).map((event) => event.kind)).toEqual(
      expect.arrayContaining([
        "prompt-ideation-started",
        "prompt-ideation-completed",
        "promptify-started",
        "promptify-completed"
      ])
    )
    expect(
      store
        .listPlannerArtifacts(project.id, plannerRuns[0]!.id)
        .some((artifact) => artifact.path.endsWith("promptify-output.json"))
    ).toBe(true)
    expect(
      store
        .listPlannerArtifacts(project.id, plannerRuns[0]!.id)
        .some((artifact) => artifact.path.endsWith("prompt-ideation-output.json"))
    ).toBe(true)
    expect(store.listPlannerArtifacts(project.id, plannerRuns[0]!.id).length).toBeGreaterThan(0)
    expect(store.getPlannerEvents(plannerRuns[0]!.id).length).toBeGreaterThan(0)
    expect(plannerAgent.name).toBe("planner")
    expect(store.getAutomationById(queueRefresh.id).nextRunAt).toBe("2026-01-01T00:03:00.000Z")
    store.close()
  })

  it("skips planner inference when active work already fills planner capacity", async () => {
    process.env.OPENCLAW_MAX_CONCURRENT_CODEX_RUNS = "1"
    const { store, project } = await setupBase()
    store.createTask({
      projectRef: project.id,
      title: "Existing dispatchable work",
      kind: "implement",
      status: "queued"
    })
    store.createTask({
      projectRef: project.id,
      title: "Existing in-flight work",
      kind: "implement",
      status: "running"
    })

    let plannerCalls = 0
    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async (context): Promise<AdapterExecutionResult> => {
        if (context.task.title.startsWith("Planner run")) plannerCalls += 1
        return { ok: true, response: "unused" }
      }),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" }))
    })

    const result = await executor.runPlannerRefresh(project.id)
    expect(result).toMatchObject({
      plannerRunId: "skipped-active-work",
      createdTasks: 0,
      createdTaskIds: []
    })
    expect(plannerCalls).toBe(0)
    expect(store.listRecentPlannerRuns(project.id, 1)).toHaveLength(0)

    store.close()
  })

  it("keeps planner refresh filling coding queue despite promotion-pending backlog", async () => {
    process.env.OPENCLAW_MAX_CONCURRENT_CODEX_RUNS = "1"
    const { store, company, project } = await setupBase()
    mkdirSync(join(project.repoPath, ".openclaw"), { recursive: true })
    writeFileSync(
      join(project.repoPath, ".openclaw", "profile.json"),
      JSON.stringify(loadProjectProfile!("minimal-repo"), null, 2),
      "utf8"
    )
    store.createAgent({
      companyRef: company.id,
      name: "planner",
      role: "Planner",
      adapterType: "codex_local"
    })
    store.createPersona({
      companyRef: company.id,
      name: "planner",
      stage: "planner",
      preferredAdapterType: "codex_local"
    })
    store.createTask({
      projectRef: project.id,
      title: "Existing queued coding work",
      kind: "implement"
    })
    const promotionTask = store.createTask({
      projectRef: project.id,
      title: "Existing promotion work",
      kind: "promote"
    })
    store.updateTaskStatus(promotionTask.id, "promotion_pending", {
      blockedReason: null,
      lastError: null
    })
    const automation = store.createAutomation({
      companyRef: company.id,
      projectRef: project.id,
      name: "queue-refresh",
      kind: "queue_refresh",
      cron: "* * * * *",
      nextRunAt: new Date(Date.now() - 60_000).toISOString(),
      payload: { projectRef: project.id }
    })

    let plannerCalls = 0
    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async (context): Promise<AdapterExecutionResult> => {
        if (context.task.title.startsWith("Planner run")) plannerCalls += 1
        if (context.task.title.startsWith("Planner run")) {
          expect(context.prompt).toContain("active queued/running coding tasks: 1")
          expect(context.prompt).toContain("candidate limit for this planner run: 1")
          return {
            ok: true,
            response: JSON.stringify({
              version: 1,
              summary: "planner topped up queue despite promotion backlog",
              candidates: [
                {
                  title: "Top up coding queue while promotion waits",
                  description: "Keep coding work available while release cleanup remains pending.",
                  kind: "implement",
                  lane: "app-core",
                  personaId: null,
                  preferredAdapterType: "codex_local",
                  priority: 70,
                  requiredReading: ["README.md"],
                  verificationChecklist: ["printf 'queue-topup-check\\n'"],
                  contractUpdateReminders: [],
                  repoNotes: [],
                  dependencies: [],
                  tags: ["planner"],
                  riskLevel: "medium",
                  governanceClass: "normal",
                  dedupeKey: "app-core:queue-topup-while-promotion-waits",
                  sourceSignals: ["changed:none"],
                  estimatedCost: 1,
                  createMode: "queue_now"
                }
              ]
            })
          }
        }
        return { ok: true, response: "unused" }
      }),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" }))
    })

    await executor.tick()
    expect(plannerCalls).toBe(1)
    expect(store.listRecentPlannerRuns(project.id, 1)).toHaveLength(1)
    expect(store.listProjectTasks(project.id).filter((task) => task.labels.includes("planner-generated"))).toHaveLength(
      1
    )
    expect(store.getAutomationById(automation.id).lastRunAt).not.toBeNull()

    store.close()
  })

  it("rejects an installed profile missing required planner config before dispatch", async () => {
    const { store, company, project } = await setupBase()
    mkdirSync(join(project.repoPath, ".openclaw"), { recursive: true })
    const installedProfile = { ...loadProjectProfile!("minimal-repo") }
    delete (installedProfile as Record<string, unknown>).planner
    writeFileSync(join(project.repoPath, ".openclaw", "profile.json"), JSON.stringify(installedProfile), "utf8")

    store.createAgent({
      companyRef: company.id,
      name: "planner",
      role: "Planner",
      adapterType: "codex_local"
    })
    store.createPersona({
      companyRef: company.id,
      name: "planner",
      stage: "planner",
      preferredAdapterType: "codex_local"
    })
    const automation = store.createAutomation({
      companyRef: company.id,
      projectRef: project.id,
      name: "queue-refresh",
      kind: "queue_refresh",
      cron: "* * * * *",
      nextRunAt: new Date(Date.now() - 60_000).toISOString(),
      payload: { projectRef: project.id }
    })

    let plannerCalls = 0
    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async (context): Promise<AdapterExecutionResult> => {
        if (context.task.title.startsWith("Planner run")) plannerCalls += 1
        return { ok: true, response: "unused" }
      }),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" }))
    })

    await expect(executor.tick()).rejects.toThrow("planner must be an object")
    expect(plannerCalls).toBe(0)
    expect(store.listRecentPlannerRuns(project.id, 1)).toHaveLength(0)
    expect(store.getAutomationById(automation.id).lastRunAt).toBeNull()

    store.close()
  })

  it("tops up planner output from Codex capacity instead of a fixed one-task cap", async () => {
    process.env.OPENCLAW_MAX_CONCURRENT_CODEX_RUNS = "3"
    const { store, company, project } = await setupBase()
    store.createAgent({
      companyRef: company.id,
      name: "planner",
      role: "Planner",
      adapterType: "codex_local"
    })
    store.createPersona({
      companyRef: company.id,
      name: "planner",
      stage: "planner",
      preferredAdapterType: "codex_local"
    })
    store.createTask({
      projectRef: project.id,
      title: "Existing running implementation",
      kind: "implement",
      status: "running"
    })

    const candidates = Array.from({ length: 5 }, (_, index) => ({
      title: `Capacity planner task ${index + 1}`,
      description: "Keep the autonomous queue filled without duplicate planner retries.",
      kind: "implement",
      lane: "app-core",
      personaId: null,
      preferredAdapterType: "codex_local",
      priority: 70,
      requiredReading: ["README.md"],
      verificationChecklist: ["printf 'planner-capacity-check\\n'"],
      contractUpdateReminders: [],
      repoNotes: [],
      dependencies: [],
      tags: ["planner"],
      riskLevel: "medium",
      governanceClass: "normal",
      dedupeKey: `app-core:capacity-planner-task-${index + 1}`,
      sourceSignals: ["changed:none"],
      estimatedCost: 1,
      createMode: "queue_now"
    }))

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async (context): Promise<AdapterExecutionResult> => {
        if (context.task.title.startsWith("Planner run")) {
          expect(context.prompt).toContain("candidate limit for this planner run: 5")
          return {
            ok: true,
            response: JSON.stringify({
              version: 1,
              summary: "planner generated capacity batch",
              candidates
            })
          }
        }
        return { ok: true, response: "unused" }
      }),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" }))
    })

    const result = await executor.runPlannerRefresh(project.id)
    expect(result.createdTasks).toBe(5)
    expect(store.listProjectTasks(project.id).filter((task) => task.labels.includes("planner-generated"))).toHaveLength(
      5
    )

    store.close()
  })

  it("uses every available Codex account while respecting the configured ceiling", async () => {
    process.env.OPENCLAW_MAX_CONCURRENT_CODEX_RUNS = "5"
    const { store, company, project } = await setupBase()
    const accountsDir = process.env.OPENCLAW_CODEX_ACCOUNTS_DIR!
    const nowSeconds = Math.floor(Date.now() / 1000)
    for (const account of ["alpha", "beta", "gamma"]) {
      writeFileSync(join(accountsDir, `${account}.json`), JSON.stringify({ account }, null, 2), "utf8")
    }
    writeFileSync(
      join(accountsDir, ".alpha.quota.json"),
      JSON.stringify({
        cached_at: nowSeconds,
        rate_limits: {
          primary: { used_percent: 0, resets_at: nowSeconds + 3600 },
          secondary: { used_percent: 5, resets_at: nowSeconds + 7 * 24 * 3600 }
        }
      }),
      "utf8"
    )
    writeFileSync(
      join(accountsDir, ".beta.quota.json"),
      JSON.stringify({
        cached_at: nowSeconds,
        rate_limits: {
          primary: { used_percent: 0, resets_at: nowSeconds + 3600 },
          secondary: { used_percent: 10, resets_at: nowSeconds + 7 * 24 * 3600 }
        }
      }),
      "utf8"
    )
    writeFileSync(
      join(accountsDir, ".gamma.quota.json"),
      JSON.stringify({
        cached_at: nowSeconds,
        rate_limits: {
          primary: { used_percent: 100, resets_at: nowSeconds + 3600 },
          secondary: { used_percent: 100, resets_at: nowSeconds + 7 * 24 * 3600 }
        }
      }),
      "utf8"
    )
    store.createAgent({
      companyRef: company.id,
      name: "planner",
      role: "Planner",
      adapterType: "codex_local"
    })
    store.createPersona({
      companyRef: company.id,
      name: "planner",
      stage: "planner",
      preferredAdapterType: "codex_local"
    })

    const candidates = Array.from({ length: 3 }, (_, index) => ({
      title: `Quota bounded planner task ${index + 1}`,
      description: "Keep planner seeding bounded by actual Codex quota headroom.",
      kind: "implement",
      lane: "app-core",
      personaId: null,
      preferredAdapterType: "codex_local",
      priority: 70,
      requiredReading: ["README.md"],
      verificationChecklist: ["printf 'planner-quota-check\\n'"],
      contractUpdateReminders: [],
      repoNotes: [],
      dependencies: [],
      tags: ["planner"],
      riskLevel: "medium",
      governanceClass: "normal",
      dedupeKey: `app-core:quota-bounded-planner-task-${index + 1}`,
      sourceSignals: ["changed:none"],
      estimatedCost: 1,
      createMode: "queue_now"
    }))

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async (context): Promise<AdapterExecutionResult> => {
        if (context.task.title.startsWith("Planner run")) {
          expect(context.prompt).toContain("candidate limit for this planner run: 4")
          return {
            ok: true,
            response: JSON.stringify({
              version: 1,
              summary: "planner generated quota-bounded batch",
              candidates
            })
          }
        }
        return { ok: true, response: "unused" }
      }),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" }))
    })

    const result = await executor.runPlannerRefresh(project.id)
    expect(result.createdTasks).toBe(3)

    store.close()
  })

  it("accepts fenced planner JSON and creates planner tasks", async () => {
    const { store, company, project } = await setupBase()
    store.createAgent({
      companyRef: company.id,
      name: "planner",
      role: "Planner",
      adapterType: "codex_local"
    })
    store.createPersona({
      companyRef: company.id,
      name: "planner",
      stage: "planner",
      preferredAdapterType: "codex_local"
    })
    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter(
        "codex_local",
        async (): Promise<AdapterExecutionResult> => ({
          ok: true,
          response: `\`\`\`json
{
  "version": 1,
  "summary": "planner generated one fenced task",
  "candidates": [
    {
      "title": "Harden fenced planner parsing",
      "description": "Accept JSON fenced by the model without wedging the planner.",
      "kind": "implement",
      "lane": "app-core",
      "personaId": null,
      "preferredAdapterType": "codex_local",
      "priority": 70,
      "requiredReading": ["README.md"],
      "verificationChecklist": ["printf 'planner-check\\n'"],
      "contractUpdateReminders": [],
      "repoNotes": [],
      "dependencies": [],
      "tags": ["planner"],
      "riskLevel": "medium",
      "governanceClass": "normal",
      "dedupeKey": "app-core:harden-fenced-planner-parsing",
      "sourceSignals": ["changed:none"],
      "estimatedCost": 1,
      "createMode": "queue_now"
    }
  ]
}
\`\`\``
        })
      ),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" }))
    })

    const result = await executor.runPlannerRefresh(project.id)
    expect(result.createdTasks).toBe(1)
    expect(store.listProjectTasks(project.id).some((task) => task.title === "Harden fenced planner parsing")).toBe(true)
    expect(store.listRecentPlannerRuns(project.id, 1)[0]!.status).toBe("succeeded")

    store.close()
  })

  it("recovers invalid planner output with deterministic candidates instead of wedging the queue", async () => {
    const { store, company, project } = await setupBase()
    mkdirSync(join(project.repoPath, ".openclaw"), { recursive: true })
    writeFileSync(
      join(project.repoPath, ".openclaw", "profile.json"),
      JSON.stringify(loadProjectProfile!("lawyerrag")),
      "utf8"
    )
    store.createAgent({
      companyRef: company.id,
      name: "planner",
      role: "Planner",
      adapterType: "codex_local"
    })
    store.createPersona({
      companyRef: company.id,
      name: "planner",
      stage: "planner",
      preferredAdapterType: "codex_local"
    })
    const blockedOutcome = store.createTask({
      projectRef: project.id,
      title: "Preserve incident audit state across retries",
      kind: "implement",
      laneId: "ui-shell-system",
      verificationCommands: ["printf 'audit-state-check\\n'"]
    })
    store.updateTaskStatus(blockedOutcome.id, "blocked", {
      blockedReason: "verification_failed",
      lastError: "audit state was lost during retry"
    })
    const secondBlockedOutcome = store.createTask({
      projectRef: project.id,
      title: "Resume interrupted evidence reviews from the application shell",
      kind: "implement",
      laneId: "ui-shell-system",
      verificationCommands: ["printf 'review-resume-check\\n'"]
    })
    store.updateTaskStatus(secondBlockedOutcome.id, "blocked", {
      blockedReason: "verification_failed",
      lastError: "review position was not restored"
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter(
        "codex_local",
        async (): Promise<AdapterExecutionResult> => ({
          ok: true,
          response: "I found one useful task, but here is prose instead of JSON."
        })
      ),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" }))
    })

    const result = await executor.runPlannerRefresh(project.id)
    const plannerRun = store.listRecentPlannerRuns(project.id, 1)[0]!
    expect(result.createdTasks).toBeGreaterThan(0)
    expect(plannerRun.status).toBe("succeeded")
    expect(store.listRunningPlannerRuns(project.id)).toHaveLength(0)
    expect(store.getPlannerEvents(plannerRun.id).some((event) => event.kind === "planner-output-invalid")).toBe(true)
    expect(
      store.getPlannerEvents(plannerRun.id).some((event) => event.kind === "planner-invalid-output-recovered")
    ).toBe(true)
    const fallbackTasks = store
      .listProjectTasks(project.id)
      .filter((task) => task.labels.includes("deterministic-fallback"))
    expect(fallbackTasks.length).toBeGreaterThan(0)
    const titles = fallbackTasks.map((task) => task.title)
    expect(new Set(titles).size).toBe(titles.length)
    const auditStateTask = fallbackTasks.find((task) =>
      task.taskPackage?.inferenceSignals.includes(`stale_task:${blockedOutcome.id}:blocked`)
    )
    expect(auditStateTask?.title).toBe("Recover blocked outcome: Preserve incident audit state across retries")
    expect(auditStateTask?.description).toContain("Do not add or change production dependencies")
    expect(auditStateTask?.description).toContain("Do not submit formatting-only")
    expect(auditStateTask?.taskPackage?.acceptanceCriteria).toContain(
      "Focused tests must cover the concrete current-code gap and pass after the fix."
    )

    store.close()
  })

  it("refills a same-title recently completed planner response with fresh deterministic work", async () => {
    const { store, company, project } = await setupBase()
    mkdirSync(join(project.repoPath, ".openclaw"), { recursive: true })
    writeFileSync(
      join(project.repoPath, ".openclaw", "profile.json"),
      JSON.stringify(loadProjectProfile!("lawyerrag")),
      "utf8"
    )
    store.createAgent({
      companyRef: company.id,
      name: "planner",
      role: "Planner",
      adapterType: "codex_local"
    })
    store.createPersona({
      companyRef: company.id,
      name: "planner",
      stage: "planner",
      preferredAdapterType: "codex_local"
    })
    const duplicate = store.createTask({
      projectRef: project.id,
      title: "Harden duplicate planner recovery",
      kind: "implement",
      laneId: "ui-shell-system",
      labels: ["planner-dedupe:ui-shell-system:previous-planner-recovery"]
    })
    store.updateTaskStatus(duplicate.id, "done")

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter(
        "codex_local",
        async (): Promise<AdapterExecutionResult> => ({
          ok: true,
          response: JSON.stringify({
            version: 1,
            summary: "planner repeated an existing task",
            candidates: [
              {
                title: "Harden duplicate planner recovery",
                description: "Keep the autonomous planner queue moving when an idea already exists.",
                kind: "implement",
                lane: "ui-shell-system",
                personaId: null,
                preferredAdapterType: "codex_local",
                priority: 70,
                requiredReading: ["README.md"],
                verificationChecklist: ["printf 'planner-refill-check\\n'"],
                contractUpdateReminders: [],
                repoNotes: [],
                dependencies: [],
                tags: ["planner"],
                riskLevel: "medium",
                governanceClass: "normal",
                dedupeKey: "ui-shell-system:duplicate-planner-recovery",
                sourceSignals: ["changed:none"],
                estimatedCost: 1,
                createMode: "queue_now"
              }
            ]
          })
        })
      ),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" }))
    })

    const result = await executor.runPlannerRefresh(project.id)
    const plannerRun = store.listRecentPlannerRuns(project.id, 1)[0]!
    const plannerTasks = store.listProjectTasks(project.id).filter((task) => task.labels.includes("planner-generated"))

    expect(result.createdTasks).toBeGreaterThan(0)
    expect(plannerTasks).toHaveLength(result.createdTasks)
    expect(plannerTasks.every((task) => task.id !== duplicate.id)).toBe(true)
    expect(plannerTasks.some((task) => task.labels.includes("deterministic-fallback"))).toBe(true)
    expect(store.getPlannerEvents(plannerRun.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "planner-dedupe-refilled",
          data: expect.objectContaining({ creatableCandidates: expect.any(Number) })
        })
      ])
    )

    store.close()
  })

  it("assigns distinct stale evidence and serializes deterministic fallback tasks in the same lane", () => {
    const profile = loadProjectProfile!("lawyerrag")
    const staleTasks: RepoPlanningSnapshot["staleTasks"] = [
      {
        id: "stale-matter-switch",
        title: "Keep matter switches on a valid evidence workflow",
        kind: "implement",
        status: "blocked",
        laneId: "ui-shell-system",
        ageHours: 24
      },
      {
        id: "stale-review-resume",
        title: "Resume interrupted evidence reviews from the application shell",
        kind: "implement",
        status: "blocked",
        laneId: "ui-shell-system",
        ageHours: 23
      }
    ]
    const snapshot: RepoPlanningSnapshot = {
      version: 1,
      generatedAt: new Date().toISOString(),
      projectId: "planner-evidence-dedup",
      projectName: "LawyerRAG",
      repoPath: "/tmp/lawyerrag",
      profileId: profile.profileId,
      projectVerifyCommand: null,
      changedFiles: [],
      laneHotspots: [{ laneId: "ui-shell-system", fileCount: 0, files: [] }],
      laneInventory: [
        {
          laneId: "ui-shell-system",
          fileCount: 1,
          testFileCount: 0,
          publicFacades: [],
          sampleFiles: ["apps/reports-ui/src/App.tsx"]
        }
      ],
      verificationCommands: ["cd apps/reports-ui && npm test"],
      staleTasks,
      promotionBlockers: [],
      memoryHighlights: [],
      directives: [],
      todoFixmeHits: [
        {
          path: "apps/backend/lawyer_rag/data/eval_samples.jsonl",
          line: 1,
          text: '{"malformed_output_terms":["TODO"]}',
          laneId: null
        }
      ],
      sourceCollectors: []
    }
    const recentPersonaCounts = Object.fromEntries(
      profile.managerStateDefaults.managerPersonas.map((persona) => [persona.id, 100])
    )
    recentPersonaCounts["release-quality-reviewer"] = 0
    recentPersonaCounts["ui-designer"] = 0

    const candidates = deterministicFallbackPlannerCandidates!({
      profile,
      snapshot,
      maxTasks: 2,
      recentPersonaCounts
    })

    expect(candidates).toHaveLength(2)
    expect(new Set(candidates.map((candidate) => candidate.title)).size).toBe(2)
    expect(candidates.flatMap((candidate) => candidate.sourceSignals)).toEqual(
      expect.arrayContaining(["stale_task:stale-matter-switch:blocked", "stale_task:stale-review-resume:blocked"])
    )
    expect(candidates[0]!.dependencies).toEqual([])
    expect(candidates[1]!.dependencies).toEqual([candidates[0]!.dedupeKey])
    expect(
      candidates.every((candidate) =>
        candidate.acceptanceCriteria.includes(
          "Focused tests must cover the concrete current-code gap and pass after the fix."
        )
      )
    ).toBe(true)
  })

  it("rotates deterministic fallback evidence past a duplicate lane title", () => {
    const profile = loadProjectProfile!("lawyerrag")
    const recentPersonaCounts = Object.fromEntries(
      profile.managerStateDefaults.managerPersonas.map((persona) => [persona.id, 100])
    )
    recentPersonaCounts["frontend-shell-owner"] = 0
    const snapshot: RepoPlanningSnapshot = {
      version: 1,
      generatedAt: new Date().toISOString(),
      projectId: "2bdb9b73-a221-40ab-ac44-e3b5aedb7af7",
      projectName: "LawyerRAG",
      repoPath: "/tmp/lawyerrag",
      profileId: profile.profileId,
      projectVerifyCommand: null,
      changedFiles: [],
      laneHotspots: [],
      laneInventory: [
        {
          laneId: "ui-shell-system",
          fileCount: 3,
          testFileCount: 0,
          publicFacades: [],
          sampleFiles: [
            "apps/reports-ui/src/components/ui/ActionGroup.tsx",
            "apps/reports-ui/src/components/ui/Alert.tsx",
            "apps/reports-ui/src/components/ui/Button.tsx"
          ]
        }
      ],
      verificationCommands: ["cd apps/reports-ui && npm test"],
      staleTasks: [],
      promotionBlockers: [],
      memoryHighlights: [],
      directives: [],
      todoFixmeHits: [],
      sourceCollectors: []
    }

    const initialCandidates = deterministicFallbackPlannerCandidates!({
      profile,
      snapshot,
      maxTasks: 1,
      recentPersonaCounts
    })
    const candidates = deterministicFallbackPlannerCandidates!({
      profile,
      snapshot,
      maxTasks: 1,
      recentPersonaCounts,
      excludeCandidate: (candidate) => candidate.title.includes("ActionGroup")
    })

    expect(candidates).toHaveLength(1)
    expect(initialCandidates).toHaveLength(1)
    expect(candidates[0]!.dedupeKey).not.toBe(initialCandidates[0]!.dedupeKey)
    expect(candidates[0]).toMatchObject({
      title: "Prove and close one Alert boundary gap",
      sourceSignals: [
        "planner-fallback:no-candidates",
        "lane_inventory:ui-shell-system:apps/reports-ui/src/components/ui/Alert.tsx"
      ]
    })
  })

  it("does not recycle a successfully verified implementation as stale planner evidence", () => {
    const resolved = plannerSatisfiedTaskIdsFromRuns!([
      {
        taskId: "merged-task",
        status: "failed",
        verificationSummary: null,
        createdAt: "2026-07-13T08:17:09.377Z"
      },
      {
        taskId: "merged-task",
        status: "succeeded",
        verificationSummary: "cd apps/reports-ui && npm run test:critical",
        createdAt: "2026-07-13T08:34:30.864Z"
      },
      {
        taskId: "retried-task",
        status: "succeeded",
        verificationSummary: "recovered: implementation branch already merged into base",
        createdAt: "2026-07-13T08:34:30.864Z"
      },
      {
        taskId: "retried-task",
        status: "failed",
        verificationSummary: "new review failure",
        createdAt: "2026-07-13T09:34:30.864Z"
      }
    ])

    expect(resolved).toEqual(new Set(["merged-task"]))
  })

  it("rejects oversized deterministic fallback churn while allowing a narrow patch", () => {
    expect(
      deterministicFallbackDiffBudgetViolation!([
        { path: "apps/backend/lawyer_rag/routes/ingestion/_common.py", added: 236, deleted: 309 },
        { path: "apps/backend/lawyer_rag/services/ingestion_request_validation.py", added: 35, deleted: 6 }
      ])
    ).toContain("_common.py changes 545 lines")
    expect(
      deterministicFallbackDiffBudgetViolation!([
        { path: "apps/backend/lawyer_rag/services/ingestion_request_validation.py", added: 35, deleted: 6 },
        { path: "apps/backend/tests/test_ingestion_request_validation.py", added: 80, deleted: 4 }
      ])
    ).toBeNull()
  })

  it("rejects test-only deterministic fallback paths while allowing a source-and-test slice", () => {
    expect(
      deterministicFallbackTestOnlyViolation!([
        "apps/reports-ui/src/components/__tests__/Badge.test.tsx",
        "apps/backend/tests/test_ingestion.py",
        "apps/reports-ui/e2e/navigation.spec.ts"
      ])
    ).toContain("changes only test evidence")
    expect(
      deterministicFallbackTestOnlyViolation!([
        "apps/reports-ui/src/components/ui/Badge.tsx",
        "apps/reports-ui/src/components/__tests__/Badge.test.tsx"
      ])
    ).toBeNull()
    expect(deterministicFallbackTestOnlyViolation!(["apps/backend/.venv"])).toBeNull()
  })

  it("infers focused changed-test verification before broad checks", () => {
    expect(
      focusedChangedTestVerificationCommands!(
        [
          "apps/reports-ui/src/components/ui/AppPanel.tsx",
          "apps/reports-ui/src/components/ui/AppPanel.test.tsx",
          "apps/reports-ui/src/components/__tests__/Badge.test.tsx",
          "apps/reports-ui/e2e/navigation.spec.ts",
          "apps/backend/tests/test_incidents.py",
          "apps/backend/lawyer_rag/incidents/queries.py"
        ],
        loadProjectProfile!("lawyerrag").executionPolicy
      )
    ).toEqual([
      "cd apps/reports-ui && npm test -- src/components/__tests__/Badge.test.tsx src/components/ui/AppPanel.test.tsx",
      "cd apps/backend && uv run pytest --no-cov tests/test_incidents.py"
    ])
  })

  it("reuses an active planner run instead of creating a duplicate", async () => {
    const { store, company, project } = await setupBase()
    mkdirSync(join(project.repoPath, ".openclaw"), { recursive: true })
    writeFileSync(
      join(project.repoPath, ".openclaw", "profile.json"),
      JSON.stringify(loadProjectProfile!("lawyerrag")),
      "utf8"
    )
    const plannerAgent = store.createAgent({
      companyRef: company.id,
      name: "planner",
      role: "Planner",
      adapterType: "codex_local"
    })
    store.createPersona({
      companyRef: company.id,
      name: "planner",
      stage: "planner",
      preferredAdapterType: "codex_local"
    })

    const activePlannerRun = store.createPlannerRun({
      companyId: company.id,
      projectId: project.id,
      automationId: "queue-refresh",
      trigger: "automation",
      status: "running",
      plannerAgentId: plannerAgent.id,
      adapterType: "codex_local"
    })

    let plannerCalls = 0
    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async (context): Promise<AdapterExecutionResult> => {
        if (context.task.title.startsWith("Planner run")) {
          plannerCalls += 1
        }
        return { ok: true, response: "unused" }
      }),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" }))
    })

    const result = await executor.runPlannerRefresh(project.id)
    expect(result.plannerRunId).toBe(activePlannerRun.id)
    expect(result.createdTasks).toBe(0)
    expect(plannerCalls).toBe(0)
    expect(store.listRecentPlannerRuns(project.id, 5)).toHaveLength(1)

    store.close()
  })

  it("recovers a dead planner owner before the active-run fast path", async () => {
    const { store, company, project } = await setupBase()
    mkdirSync(join(project.repoPath, ".openclaw"), { recursive: true })
    writeFileSync(
      join(project.repoPath, ".openclaw", "profile.json"),
      JSON.stringify(loadProjectProfile!("lawyerrag")),
      "utf8"
    )
    const plannerAgent = store.createAgent({
      companyRef: company.id,
      name: "planner",
      role: "Planner",
      adapterType: "codex_local"
    })
    store.createPersona({
      companyRef: company.id,
      name: "planner",
      stage: "planner",
      preferredAdapterType: "codex_local"
    })
    const abandonedRun = store.createPlannerRun({
      companyId: company.id,
      projectId: project.id,
      automationId: "queue-refresh",
      trigger: "automation",
      status: "running",
      plannerAgentId: plannerAgent.id,
      adapterType: "codex_local"
    })
    store.appendPlannerEvent(abandonedRun.id, "planner-run-started", "abandoned owner", {
      ownerPid: 2_147_483_647
    })
    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async () => ({
        ok: true,
        response: JSON.stringify({ version: 1, summary: "empty", candidates: [] })
      })),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" }))
    })

    const result = await executor.runPlannerRefresh(project.id)

    expect(result.plannerRunId).not.toBe(abandonedRun.id)
    expect(store.getPlannerRunById(abandonedRun.id)).toMatchObject({ status: "failed" })
    expect(store.getPlannerEvents(abandonedRun.id).map((event) => event.kind)).toContain("planner-run-owner-recovered")
    expect(store.listRunningPlannerRuns(project.id)).toHaveLength(0)

    store.close()
  })

  it("prevents duplicate planner creation under repeated queue-refresh races", async () => {
    const { store, company, project } = await setupBase()
    mkdirSync(join(project.repoPath, ".openclaw"), { recursive: true })
    writeFileSync(
      join(project.repoPath, ".openclaw", "profile.json"),
      JSON.stringify(loadProjectProfile!("lawyerrag")),
      "utf8"
    )
    store.createAgent({
      companyRef: company.id,
      name: "planner",
      role: "Planner",
      adapterType: "codex_local"
    })
    store.createPersona({
      companyRef: company.id,
      name: "planner",
      stage: "planner",
      preferredAdapterType: "codex_local"
    })

    let releasePlanner = () => undefined
    const plannerGate = new Promise<void>((resolve) => {
      releasePlanner = resolve
    })
    let plannerCalls = 0

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async (context): Promise<AdapterExecutionResult> => {
        if (context.task.title.startsWith("Planner run")) {
          plannerCalls += 1
          await plannerGate
          return {
            ok: true,
            response: JSON.stringify({
              version: 1,
              summary: "planner generated one task",
              candidates: [
                {
                  title: "Add ingestion registry duplicate-refresh protection",
                  description:
                    "Prevent duplicate queue-refresh callers from creating conflicting ingestion registry work.",
                  kind: "implement",
                  lane: "backend-ingestion-and-aiops",
                  personaId: null,
                  preferredAdapterType: "codex_local",
                  priority: 50,
                  requiredReading: ["apps/backend/lawyer_rag/routes/ingestion/task_registry.py"],
                  verificationChecklist: ["echo planner-race-ok"],
                  contractUpdateReminders: [],
                  repoNotes: [
                    "laneInventory lists apps/backend/lawyer_rag/routes/ingestion/task_registry.py for ingestion work."
                  ],
                  dependencies: [],
                  tags: ["planner"],
                  riskLevel: "medium",
                  governanceClass: "normal",
                  dedupeKey: "backend-ingestion-and-aiops:duplicate-refresh-protection",
                  sourceSignals: [
                    "laneInventory:backend-ingestion-and-aiops:apps/backend/lawyer_rag/routes/ingestion/task_registry.py"
                  ],
                  estimatedCost: 1,
                  createMode: "queue_now"
                }
              ]
            })
          }
        }
        return { ok: true, response: "unused" }
      }),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" }))
    })

    const first = executor.runPlannerRefresh(project.id)
    const second = executor.runPlannerRefresh(project.id)
    releasePlanner()

    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(plannerCalls).toBe(1)
    expect(firstResult.plannerRunId).toBe(secondResult.plannerRunId)
    expect(firstResult.createdTasks + secondResult.createdTasks).toBe(1)
    expect(store.listRecentPlannerRuns(project.id, 5)).toHaveLength(1)
    expect(store.listProjectTasks(project.id).filter((task) => task.labels.includes("planner-generated"))).toHaveLength(
      1
    )

    store.close()
  })

  it("prefers stronger Codex agents for complex implementation work", async () => {
    const { store, company, project } = await setupBase()
    const strongCodex = store.createAgent({
      companyRef: company.id,
      name: "codex-advanced",
      role: "Engineer",
      adapterType: "codex_local",
      model: "gpt-5.5"
    })
    store.createAgent({
      companyRef: company.id,
      name: "codex-cheap",
      role: "Engineer",
      adapterType: "codex_local",
      model: "gpt-5.3-codex-spark"
    })

    const task = store.createTask({
      projectRef: project.id,
      title: "Refactor dispatcher orchestration and backend reliability",
      kind: "implement",
      labels: ["backend", "architecture", "dispatcher"],
      changedFiles: [
        "packages/executor/src/runner.ts",
        "packages/domain/src/routing.ts",
        "apps/dispatcher-cli/src/sync.ts"
      ],
      reviewRequired: true
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async (context) => {
        const targetDir = join(context.project.repoPath, "packages", "executor", "src")
        mkdirSync(targetDir, { recursive: true })
        writeFileSync(join(targetDir, "runner.ts"), "export const implemented = true\n", "utf8")
        return { ok: true, response: "implemented" }
      }),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" })),
      azure_foundry: fakeAdapter("azure_foundry", async () => ({ ok: true, response: "unused" }))
    })

    await executor.tick()
    const run = store.listRuns()[0]!
    expect(run.agentId).toBe(strongCodex.id)
    expect(store.getTaskById(task.id).status).toBe("review_needed")

    store.close()
  })

  it("closes a verified duplicate implementation when the adapter explicitly reports no patch is required", async () => {
    const { store, company, project } = await setupBase()
    store.createAgent({
      companyRef: company.id,
      name: "duplicate-checker",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Implement behavior already present on main",
      kind: "implement",
      reviewRequired: true,
      verificationCommands: ["git diff --quiet"],
      maxRetries: 0
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async () => ({
        ok: true,
        response:
          "Task is complete with no new patch required. HEAD already contains the merged fix and the focused verification passes."
      }))
    })

    await executor.tick()

    expect(store.getTaskById(task.id)).toMatchObject({ status: "done", lastError: null })
    expect(store.listChildTasks(task.id)).toHaveLength(0)
    expect(store.getLatestRunForTask(task.id)).toMatchObject({
      status: "succeeded",
      verificationSummary: "already satisfied; git diff --quiet"
    })
    expect(store.getTaskEvents(task.id).map((event) => event.kind)).toContain("implementation-already-satisfied")

    store.close()
  })

  it.each([
    [
      "no redundant code changes were made",
      "Task is already implemented on origin/main; no redundant code changes were made."
    ],
    [
      "no tracked changes were needed",
      "The requested guardrail is already implemented on main by an earlier commit. No tracked changes were needed."
    ],
    [
      "no source changes were needed",
      "The task is already implemented on HEAD by d8e465f08 (#2887). No source changes were needed."
    ],
    [
      "pre-existing baseline wording does not override an already-present result",
      "No code change was needed: this planner item duplicates behavior already present on the branch. Focused tests pass. Feature-boundary guard: blocked by 8 pre-existing unrelated cross-feature imports. No tracked files changed."
    ]
  ])("accepts verified duplicate wording that %s", async (_description, response) => {
    const { store, company, project } = await setupBase()
    store.createAgent({
      companyRef: company.id,
      name: "duplicate-checker",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Avoid a redundant implementation",
      kind: "implement",
      verificationCommands: ["git diff --quiet"],
      maxRetries: 0
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async () => ({
        ok: true,
        response
      }))
    })

    await executor.tick()

    expect(store.getTaskById(task.id)).toMatchObject({ status: "done", lastError: null })
    expect(store.getLatestRunForTask(task.id)).toMatchObject({
      status: "succeeded",
      verificationSummary: "already satisfied; git diff --quiet"
    })
    expect(store.getTaskEvents(task.id).map((event) => event.kind)).toContain("implementation-already-satisfied")

    store.close()
  })

  it("fails a zero-diff implementation before running verification when the adapter only returns a plan", async () => {
    const { store, company, project } = await setupBase()
    store.createAgent({
      companyRef: company.id,
      name: "plan-only-coder",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Implement a concrete repository change",
      kind: "implement",
      verificationCommands: ['sh -c "printf ran > verification-ran.txt"'],
      maxRetries: 0
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async () => ({
        ok: true,
        response: "I inspected the repository and prepared an implementation plan."
      }))
    })

    await executor.tick()

    expect(store.getTaskById(task.id)).toMatchObject({
      status: "blocked",
      lastError: expect.stringContaining("produced no repository changes")
    })
    expect(store.getTaskEvents(task.id).map((event) => event.kind)).not.toContain("implementation-already-satisfied")
    const run = store.getLatestRunForTask(task.id)!
    expect(store.getRunEvents(run.id).map((event) => event.message)).toContain(
      "Skipped verification for zero-diff implementation"
    )
    expect(store.getRunEvents(run.id).map((event) => event.message)).not.toContain("Running verification command")

    store.close()
  })

  it("treats an explicit provider refusal with no repository files changed as blocked", async () => {
    const { store, company, project } = await setupBase()
    store.createAgent({
      companyRef: company.id,
      name: "provider-gated-coder",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Implement through the available provider",
      kind: "implement",
      verificationCommands: ['sh -c "printf ran > verification-ran.txt"'],
      maxRetries: 0
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async () => ({
        ok: true,
        response:
          "Blocked: Gemini CLI availability is unset. No repository files were inspected or changed, and verification was not run."
      }))
    })

    await executor.tick()

    expect(store.getTaskById(task.id)).toMatchObject({
      status: "blocked",
      blockedReason: "autonomous_blocked"
    })
    const run = store.getLatestRunForTask(task.id)!
    expect(run).toMatchObject({ status: "succeeded", verificationSummary: "autonomous-blocked" })
    expect(store.getRunEvents(run.id).map((event) => event.message)).toContain(
      "Autonomous execution reported a blocker."
    )
    expect(store.getRunEvents(run.id).map((event) => event.message)).not.toContain("Running verification command")

    store.close()
  })

  it("fails a test-only deterministic fallback before running broad verification", async () => {
    const { store, company, project } = await setupBase()
    store.createAgent({
      companyRef: company.id,
      name: "test-only-coder",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Prove and close one component boundary gap",
      kind: "implement",
      labels: ["deterministic-fallback"],
      verificationCommands: ['sh -c "printf ran > verification-ran.txt"'],
      maxRetries: 0
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async (context) => {
        const testDir = join(context.project.repoPath, "src", "components", "__tests__")
        mkdirSync(testDir, { recursive: true })
        writeFileSync(join(testDir, "Badge.test.tsx"), "it('covers the badge')\n", "utf8")
        return { ok: true, response: "Added focused regression coverage." }
      })
    })

    await executor.tick()

    expect(store.getTaskById(task.id)).toMatchObject({
      status: "blocked",
      lastError: expect.stringContaining("test-only patch")
    })
    const run = store.getLatestRunForTask(task.id)!
    expect(store.getRunEvents(run.id).map((event) => event.message)).toContain(
      "Skipped verification for test-only deterministic fallback"
    )
    expect(store.getRunEvents(run.id).map((event) => event.message)).not.toContain("Running verification command")

    store.close()
  })

  it("fails oversized deterministic fallback churn before running broad verification", async () => {
    const { store, company, project } = await setupBase()
    store.createAgent({
      companyRef: company.id,
      name: "oversized-coder",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Prove and close one narrow boundary gap",
      kind: "implement",
      labels: ["deterministic-fallback"],
      verificationCommands: ['sh -c "printf ran > verification-ran.txt"'],
      maxRetries: 0
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async (context) => {
        writeFileSync(
          join(context.project.repoPath, "README.md"),
          `${Array.from({ length: 401 }, (_, index) => `line ${index}`).join("\n")}\n`,
          "utf8"
        )
        return { ok: true, response: "Reformatted the repository documentation." }
      })
    })

    await executor.tick()

    expect(store.getTaskById(task.id)).toMatchObject({
      status: "blocked",
      lastError: expect.stringContaining("exceeded its narrow change budget before verification")
    })
    const run = store.getLatestRunForTask(task.id)!
    expect(store.getRunEvents(run.id).map((event) => event.message)).toContain(
      "Skipped verification for oversized deterministic fallback"
    )
    expect(store.getRunEvents(run.id).map((event) => event.message)).not.toContain("Running verification command")

    store.close()
  })

  it("runs an inferred changed test before broad implementation verification", async () => {
    const { store, company, project } = await setupBase()
    installExecutionCompatibility(project.repoPath)
    store.createAgent({
      companyRef: company.id,
      name: "focused-test-coder",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Implement and prove an accessible badge",
      kind: "implement",
      verificationCommands: ['sh -c "printf ran > verification-ran.txt"'],
      maxRetries: 0
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async (context) => {
        const sourceDir = join(context.project.repoPath, "apps", "reports-ui", "src", "components", "ui")
        const testDir = join(context.project.repoPath, "apps", "reports-ui", "src", "components", "__tests__")
        mkdirSync(sourceDir, { recursive: true })
        mkdirSync(testDir, { recursive: true })
        writeFileSync(join(sourceDir, "Badge.tsx"), "export const Badge = () => null\n", "utf8")
        writeFileSync(join(testDir, "Badge.test.tsx"), "it('covers the badge')\n", "utf8")
        return { ok: true, response: "Implemented the badge and added focused regression coverage." }
      })
    })

    await executor.tick()

    expect(store.getTaskById(task.id)).toMatchObject({
      status: "blocked",
      lastError: expect.stringContaining("npm test -- src/components/__tests__/Badge.test.tsx")
    })
    const run = store.getLatestRunForTask(task.id)!
    const runEvents = store.getRunEvents(run.id)
    expect(runEvents.map((event) => event.message)).toContain("Focused verification inferred from changed test files")
    const verificationCommands = runEvents
      .filter((event) => event.message === "Running verification command")
      .map((event) => (event.data as { command?: string } | null)?.command)
    expect(verificationCommands).toEqual(["cd apps/reports-ui && npm test -- src/components/__tests__/Badge.test.tsx"])

    store.close()
  })

  it("keeps coder personas on implementation agents instead of planner agents", async () => {
    const { store, company, project } = await setupBase()
    store.createAgent({
      companyRef: company.id,
      name: "planner",
      role: "Task Planner",
      adapterType: "codex_local",
      model: "gpt-5.5"
    })
    const engineer = store.createAgent({
      companyRef: company.id,
      name: "backend-engineer",
      role: "Backend Engineer",
      adapterType: "codex_local",
      model: "gpt-5.3-codex-spark"
    })
    const coderPersona = store.createPersona({
      companyRef: company.id,
      name: "defendant-end-user-advocate",
      stage: "coder",
      preferredAdapterType: "codex_local"
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Show empty linked-evidence state on incident detail",
      kind: "implement",
      stage: "coder",
      personaRef: coderPersona.id,
      labels: ["frontend", "incidents"],
      changedFiles: ["apps/reports-ui/src/features/incidents/IncidentDetail.tsx"],
      reviewRequired: true
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async (context) => {
        const targetDir = join(context.project.repoPath, "apps", "reports-ui", "src", "features", "incidents")
        mkdirSync(targetDir, { recursive: true })
        writeFileSync(join(targetDir, "IncidentDetail.tsx"), "export const IncidentDetail = () => null\n", "utf8")
        return { ok: true, response: "implemented" }
      }),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" })),
      azure_foundry: fakeAdapter("azure_foundry", async () => ({ ok: true, response: "unused" }))
    })

    await executor.tick()
    const run = store.getLatestRunForTask(task.id)!
    expect(run.agentId).toBe(engineer.id)
    expect(store.getTaskById(task.id).status).toBe("review_needed")

    store.close()
  })

  it("routes planner, PM, and reviewer personas within Azure Foundry", async () => {
    const { store, company, project } = await setupBase()
    const kimiPlanner = store.createAgent({
      companyRef: company.id,
      name: "foundry-kimi-dispatcher",
      role: "Foundry planner",
      adapterType: "azure_foundry",
      model: "Kimi-K2.6"
    })
    const miniReviewer = store.createAgent({
      companyRef: company.id,
      name: "foundry-gpt-reviewer",
      role: "Foundry reviewer",
      adapterType: "azure_foundry",
      model: "gpt-5.4-mini"
    })
    const plannerPersona = store.createPersona({
      companyRef: company.id,
      name: "planner",
      stage: "planner",
      preferredAdapterType: "azure_foundry"
    })
    const reviewerPersona = store.createPersona({
      companyRef: company.id,
      name: "reviewer",
      stage: "reviewer",
      preferredAdapterType: "azure_foundry"
    })
    const pmPersona = store.createPersona({
      companyRef: company.id,
      name: "pm-backend-reliability",
      stage: "planner",
      preferredAdapterType: "azure_foundry"
    })

    const plannerTask = store.createTask({
      projectRef: project.id,
      title: "Plan backend reliability work",
      kind: "plan",
      stage: "planner",
      personaRef: plannerPersona.id,
      labels: ["backend", "architecture"]
    })
    const reviewTask = store.createTask({
      projectRef: project.id,
      title: "Review queue handoff summary",
      kind: "follow_up",
      stage: "reviewer",
      personaRef: reviewerPersona.id,
      labels: ["review", "queue", "summary"]
    })
    const pmTask = store.createTask({
      projectRef: project.id,
      title: "PM backend reliability planning brief",
      kind: "plan",
      stage: "planner",
      personaRef: pmPersona.id,
      labels: ["pm", "backend", "planning"]
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async () => ({ ok: true, response: "unused" })),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" })),
      azure_foundry: fakeAdapter("azure_foundry", async () => ({ ok: true, response: "handled" }))
    })

    await executor.tick()
    await executor.tick()
    await executor.tick()
    const runs = store.listRuns()
    const plannerRun = runs.find((run) => run.taskId === plannerTask.id)!
    const reviewRun = runs.find((run) => run.taskId === reviewTask.id)!
    const pmRun = runs.find((run) => run.taskId === pmTask.id)!
    const plannerAgent = store.getAgentById(plannerRun.agentId!)
    const reviewAgent = store.getAgentById(reviewRun.agentId!)
    const pmAgent = store.getAgentById(pmRun.agentId!)

    expect(plannerRun.agentId).toBe(kimiPlanner.id)
    expect(reviewRun.agentId).toBe(miniReviewer.id)
    expect(pmRun.agentId).toBe(kimiPlanner.id)
    expect(plannerAgent).toMatchObject({ adapterType: "azure_foundry", model: "Kimi-K2.6" })
    expect(reviewAgent).toMatchObject({ adapterType: "azure_foundry", model: "gpt-5.4-mini" })
    expect(pmAgent).toMatchObject({ adapterType: "azure_foundry", model: "Kimi-K2.6" })

    store.close()
  })

  it("prefers Codex mini for lightweight tool-driven follow-up tasks", async () => {
    const { store, company, project } = await setupBase()
    store.createAgent({
      companyRef: company.id,
      name: "codex-advanced",
      role: "Engineer",
      adapterType: "codex_local",
      model: "gpt-5.5"
    })
    const miniCodex = store.createAgent({
      companyRef: company.id,
      name: "codex-mini-orchestrator",
      role: "Orchestrator",
      adapterType: "codex_local",
      model: "gpt-5.4-mini"
    })

    const task = store.createTask({
      projectRef: project.id,
      title: "Follow up on queue sync summary",
      kind: "follow_up",
      labels: ["queue", "summary", "sync"]
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async () => ({ ok: true, response: "handled" })),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" })),
      azure_foundry: fakeAdapter("azure_foundry", async () => ({ ok: true, response: "unused" }))
    })

    await executor.tick()
    const run = store.listRuns()[0]!
    expect(run.agentId).toBe(miniCodex.id)

    store.close()
  })

  it("uses Gemini pro for heavier UI execution and Gemini flash for lightweight UI follow-up", async () => {
    const { store, company, project } = await setupBase()
    const proGemini = store.createAgent({
      companyRef: company.id,
      name: "gemini-ui-pro",
      role: "UI Engineer",
      adapterType: "gemini_local",
      model: "gemini-3.1-pro"
    })
    const flashGemini = store.createAgent({
      companyRef: company.id,
      name: "gemini-ui-flash",
      role: "UI Support",
      adapterType: "gemini_local",
      model: "gemini-3.1-flash"
    })

    const heavyUiTask = store.createTask({
      projectRef: project.id,
      title: "Refactor the reports UI shell and component layout",
      kind: "implement",
      labels: ["ui", "frontend", "layout"],
      changedFiles: ["apps/reports-ui/src/features/shell/AppShell.tsx", "apps/reports-ui/src/components/ui/Button.tsx"]
    })
    const lightUiTask = store.createTask({
      projectRef: project.id,
      title: "Follow up on UI copy polish",
      kind: "follow_up",
      labels: ["ui", "copy", "summary"]
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async () => ({ ok: true, response: "unused" })),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "handled" })),
      azure_foundry: fakeAdapter("azure_foundry", async () => ({ ok: true, response: "unused" }))
    })

    await executor.tick()
    await executor.tick()
    const runs = store.listRuns()
    expect(runs.find((run) => run.taskId === heavyUiTask.id)?.agentId).toBe(proGemini.id)
    expect(runs.find((run) => run.taskId === lightUiTask.id)?.agentId).toBe(flashGemini.id)

    store.close()
  })

  it("honors a pinned Gemini ACP model override during routing and execution", async () => {
    const { store, company, project } = await setupBase()
    store.createAgent({
      companyRef: company.id,
      name: "opencode-fallback",
      role: "OpenCode ACP Fallback Coder",
      adapterType: "gemini_local",
      model: "opencode/big-pickle",
      env: {
        OPENCLAW_GEMINI_ACPX_AGENT_COMMAND: "/opt/opencode/bin/opencode acp",
        OPENCLAW_GEMINI_ACPX_MODEL: "opencode/big-pickle"
      }
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Follow up on the UI contract summary",
      kind: "follow_up",
      requestedAdapterType: "gemini_local",
      labels: ["ui", "summary"]
    })
    let executedModel: string | null = null
    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async () => ({ ok: true, response: "unused" })),
      gemini_local: fakeAdapter("gemini_local", async (context) => {
        executedModel = context.agent.model
        return { ok: true, response: "handled" }
      }),
      azure_foundry: fakeAdapter("azure_foundry", async () => ({ ok: true, response: "unused" }))
    })

    await executor.tick()

    const run = store.getLatestRunForTask(task.id)!
    const startedEvent = store.getRunEvents(run.id).find((event) => event.message === "Run started")
    expect({ executedModel, started: startedEvent?.data }).toMatchObject({
      executedModel: "opencode/big-pickle",
      started: {
        selectedAgent: { model: "opencode/big-pickle" },
        modelRouting: {
          selectedModel: "opencode/big-pickle",
          modelRoutingReason: expect.stringContaining("honored configured Gemini ACP model override")
        }
      }
    })

    store.close()
  })

  it("persists routing scorecards and model selection reasons in run events", async () => {
    const { store, company, project } = await setupBase()
    store.createAgent({
      companyRef: company.id,
      name: "codex-primary",
      role: "Engineer",
      adapterType: "codex_local",
      model: "gpt-5.5"
    })
    store.createAgent({
      companyRef: company.id,
      name: "foundry-kimi",
      role: "PM Planner",
      adapterType: "azure_foundry",
      model: "Kimi-K2.6"
    })
    store.createAgent({
      companyRef: company.id,
      name: "foundry-mini",
      role: "Quality Reviewer",
      adapterType: "azure_foundry",
      model: "gpt-5.4-mini"
    })

    const task = store.createTask({
      projectRef: project.id,
      title: "Decompose routing strategy for the manager brief",
      kind: "plan",
      stage: "planner",
      requiredReading: [
        "packages/domain/src/routing.ts",
        "packages/executor/src/runner.ts",
        "profiles/lawyerrag/profile.json",
        "tests/routing.test.ts"
      ]
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async () => ({ ok: true, response: "unused" })),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" })),
      azure_foundry: fakeAdapter("azure_foundry", async () => ({ ok: true, response: "planned" }))
    })

    await executor.tick()

    const run = store.getLatestRunForTask(task.id)!
    const startedEvent = store.getRunEvents(run.id).find((event) => event.message === "Run started")

    expect(startedEvent?.data).toMatchObject({
      adapterType: "azure_foundry",
      routingShape: "planning",
      selectedAgent: {
        name: "foundry-kimi",
        model: "Kimi-K2.6"
      },
      modelRouting: {
        selectedModel: "Kimi-K2.6",
        reasoningEffort: "high",
        modelFamily: "kimi-2.6"
      }
    })
    expect(Array.isArray(startedEvent?.data?.routingScorecard)).toBe(true)
    expect(startedEvent?.data?.modelSelection).toMatchObject({
      reason: expect.stringContaining("planning"),
      candidates: expect.arrayContaining([
        expect.objectContaining({
          agentName: "foundry-kimi",
          model: "Kimi-K2.6"
        })
      ])
    })

    store.close()
  })

  it("fails over review-style work to Azure Foundry when Codex quota is exhausted", async () => {
    const { store, company, project, workspace } = await setupBase()
    store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const foundry = store.createAgent({
      companyRef: company.id,
      name: "foundry-reviewer",
      role: "Reviewer",
      adapterType: "azure_foundry",
      model: "Kimi-K2.6"
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Review the queue summary",
      kind: "follow_up",
      requestedAdapterType: "codex_local",
      labels: ["review", "summary"]
    })

    const accountsDir = join(workspace.root, "codex", "accounts")
    const authFile = join(workspace.root, "codex", "auth.json")
    mkdirSync(accountsDir, { recursive: true })
    const authSnapshot = JSON.stringify({ account: "alpha" }, null, 2)
    writeFileSync(join(accountsDir, "alpha.json"), authSnapshot, "utf8")
    writeFileSync(join(accountsDir, "beta.json"), JSON.stringify({ account: "beta" }, null, 2), "utf8")
    writeFileSync(authFile, authSnapshot, "utf8")
    writeFileSync(
      join(accountsDir, ".alpha.quota.json"),
      JSON.stringify({
        cached_at: Math.floor(Date.now() / 1000),
        rate_limits: {
          primary: { used_percent: 100, resets_at: Math.floor(Date.now() / 1000) + 3600 },
          secondary: { used_percent: 100, resets_at: Math.floor(Date.now() / 1000) + 86400 }
        }
      }),
      "utf8"
    )
    writeFileSync(
      join(accountsDir, ".beta.quota.json"),
      JSON.stringify({
        cached_at: Math.floor(Date.now() / 1000),
        rate_limits: {
          primary: { used_percent: 100, resets_at: Math.floor(Date.now() / 1000) + 3600 },
          secondary: { used_percent: 100, resets_at: Math.floor(Date.now() / 1000) + 86400 }
        }
      }),
      "utf8"
    )
    process.env.OPENCLAW_CODEX_ACCOUNTS_DIR = accountsDir
    process.env.OPENCLAW_CODEX_AUTH_FILE = authFile

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async () => ({ ok: true, response: "unused" })),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" })),
      azure_foundry: fakeAdapter("azure_foundry", async () => ({ ok: true, response: "handled by foundry" }))
    })

    const summary = await executor.tick()
    const run = store.listRuns()[0]!

    expect(summary.executedRuns).toBe(1)
    expect(run.agentId).toBe(foundry.id)
    expect(run.adapterType).toBe("azure_foundry")
    expect(store.getTaskById(task.id).status).toBe("done")

    store.close()
  })

  it("defers legacy user tasks with repo verification instead of failing over to Azure", async () => {
    const { store, company, project, workspace } = await setupBase()
    store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local"
    })
    store.createAgent({
      companyRef: company.id,
      name: "foundry-ui",
      role: "UI Engineer",
      adapterType: "azure_foundry",
      model: "Kimi-K2.6"
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Recover a verified UI commit",
      kind: "user",
      requestedAdapterType: "codex_local",
      verificationCommands: ["npm test"]
    })

    const accountsDir = join(workspace.root, "codex", "accounts")
    const authFile = join(workspace.root, "codex", "auth.json")
    mkdirSync(accountsDir, { recursive: true })
    const authSnapshot = JSON.stringify({ account: "alpha" }, null, 2)
    writeFileSync(join(accountsDir, "alpha.json"), authSnapshot, "utf8")
    writeFileSync(authFile, authSnapshot, "utf8")
    writeFileSync(
      join(accountsDir, ".alpha.quota.json"),
      JSON.stringify({
        cached_at: Math.floor(Date.now() / 1000),
        rate_limits: {
          primary: { used_percent: 100, resets_at: Math.floor(Date.now() / 1000) + 3600 },
          secondary: { used_percent: 100, resets_at: Math.floor(Date.now() / 1000) + 86400 }
        }
      }),
      "utf8"
    )
    process.env.OPENCLAW_CODEX_ACCOUNTS_DIR = accountsDir
    process.env.OPENCLAW_CODEX_AUTH_FILE = authFile

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async () => ({ ok: true, response: "unused" })),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" })),
      azure_foundry: fakeAdapter("azure_foundry", async () => ({ ok: true, response: "must not run" }))
    })

    const summary = await executor.tick()

    expect(summary.executedRuns).toBe(0)
    expect(store.getTaskById(task.id).status).toBe("queued")
    expect(store.listRuns().filter((run) => run.taskId === task.id)).toHaveLength(0)
    expect(store.getTaskEvents(task.id).some((event) => event.kind === "codex-quota-deferred")).toBe(true)
    expect(store.getTaskEvents(task.id).some((event) => event.kind === "adapter-failover-routed")).toBe(false)

    store.close()
  })

  it("allows concurrent frontend execution on a healthy local Gemini agent", async () => {
    const { store, company, project } = await setupBase()
    const gemini = store.createAgent({
      companyRef: company.id,
      name: "gemini-ui",
      role: "Frontend Engineer",
      adapterType: "gemini_local"
    })
    const codex = store.createAgent({
      companyRef: company.id,
      name: "codex-engineer",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const blocker = store.createTask({
      projectRef: project.id,
      title: "Active Gemini UI run",
      kind: "implement"
    })
    const started = store.startRunWithClaim({
      companyId: company.id,
      projectId: project.id,
      taskId: blocker.id,
      agentId: gemini.id,
      adapterType: "gemini_local",
      kind: "implement"
    })
    expect(started).not.toBeNull()

    const task = store.createTask({
      projectRef: project.id,
      title: "Build frontend React issue list",
      kind: "implement",
      changedFiles: ["apps/web/src/IssueList.tsx"],
      labels: ["frontend", "ui"]
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async () => ({ ok: true, response: "handled by codex" })),
      gemini_local: fakeAdapter("gemini_local", async (context) => {
        const targetDir = join(context.project.repoPath, "apps", "web", "src")
        mkdirSync(targetDir, { recursive: true })
        writeFileSync(join(targetDir, "IssueList.tsx"), "export const IssueList = () => null\n", "utf8")
        return { ok: true, response: "implemented frontend" }
      }),
      azure_foundry: fakeAdapter("azure_foundry", async () => ({ ok: true, response: "unused" }))
    })

    const summary = await executor.tick()
    const run = store.getLatestRunForTask(task.id)!

    expect(summary.executedRuns).toBe(1)
    expect(run.agentId).toBe(gemini.id)
    expect(run.adapterType).toBe("gemini_local")
    expect(store.getTaskById(task.id).status).toBe("done")
    expect(store.getTaskEvents(task.id).some((event) => event.kind === "adapter-failover-routed")).toBe(false)
    expect(store.listRuns().some((candidate) => candidate.agentId === codex.id)).toBe(false)

    store.close()
  })

  it("keeps tool-backed work on Codex while another isolated Codex run is active", async () => {
    const { store, company, project } = await setupBase()
    const codex = store.createAgent({
      companyRef: company.id,
      name: "codex-engineer",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const foundry = store.createAgent({
      companyRef: company.id,
      name: "foundry-engineer",
      role: "Engineer",
      adapterType: "azure_foundry",
      model: "Kimi-K2.6"
    })
    const blocker = store.createTask({
      projectRef: project.id,
      title: "Active Codex repo run",
      kind: "implement"
    })
    const started = store.startRunWithClaim({
      companyId: company.id,
      projectId: project.id,
      taskId: blocker.id,
      agentId: codex.id,
      adapterType: "codex_local",
      kind: "implement"
    })
    expect(started).not.toBeNull()

    const task = store.createTask({
      projectRef: project.id,
      title: "Patch backend queue dispatcher bug",
      kind: "implement",
      changedFiles: ["apps/backend/src/queue.ts"],
      verificationCommands: ["printf 'queue ok\\n'"]
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async (context) => {
        const targetDir = join(context.project.repoPath, "apps", "backend", "src")
        mkdirSync(targetDir, { recursive: true })
        writeFileSync(join(targetDir, "queue.ts"), "export const queuePatched = true\n", "utf8")
        return { ok: true, response: "patched queue" }
      }),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" })),
      azure_foundry: fakeAdapter("azure_foundry", async () => {
        throw new Error("Azure Foundry should not run tool-backed repo execution")
      })
    })

    const summary = await executor.tick()

    expect(summary.executedRuns).toBe(1)
    expect(store.getLatestRunForTask(task.id)?.adapterType).toBe("codex_local")
    expect(store.getTaskById(task.id).status).toBe("done")
    expect(store.getTaskEvents(task.id).some((event) => event.kind === "agent-selection-deferred")).toBe(false)
    expect(store.listRuns().some((run) => run.agentId === foundry.id)).toBe(false)

    store.close()
  })

  it("records prompt budget shaping metadata for oversized context", async () => {
    const { store, company, project, workspace } = await setupBase()
    writeFileSync(join(workspace.repoPath, "README.md"), "# Repo\n\n" + "Long prose ".repeat(800), "utf8")
    writeFileSync(join(workspace.repoPath, "src-a.ts"), "export const a = 1;\n".repeat(400), "utf8")
    writeFileSync(join(workspace.repoPath, "src-b.ts"), "export const b = 2;\n".repeat(400), "utf8")
    writeFileSync(join(workspace.repoPath, "src-c.ts"), "export const c = 3;\n".repeat(400), "utf8")
    writeFileSync(join(workspace.repoPath, "src-d.ts"), "export const d = 4;\n".repeat(400), "utf8")

    store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local",
      model: "gpt-5.5"
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Review oversized package",
      kind: "follow_up",
      changedFiles: ["src-a.ts", "src-b.ts", "src-c.ts", "src-d.ts"],
      taskPackage: {
        version: 1,
        generatedAt: new Date().toISOString(),
        repoProfile: "test-profile",
        likelyOwnershipLane: "backend",
        laneReason: "test",
        inferenceSignals: ["oversized"],
        requiredReading: ["README.md", "src-a.ts", "src-b.ts", "src-c.ts", "src-d.ts"],
        verificationChecklist: ["printf 'ok\\n'"],
        contractUpdateReminders: [],
        repoNotes: ["note"]
      }
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async () => ({ ok: true, response: "reviewed" })),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" })),
      azure_foundry: fakeAdapter("azure_foundry", async () => ({ ok: true, response: "unused" }))
    })

    await executor.tick()
    const run = store.listRuns()[0]!
    const runEvents = store.getRunEvents(run.id)

    expect(run.metadata).toMatchObject({
      promptBudget: {
        compactionApplied: true
      }
    })
    expect((run.metadata?.tooling as Record<string, unknown>)?.fileReads).toBeTypeOf("number")
    expect(runEvents.some((event) => event.message === "Prompt compaction applied")).toBe(true)
    expect(store.getTaskById(task.id).status).toBe("done")

    store.close()
  })

  it("routes around adapter cooldown windows instead of retrying the same lane", async () => {
    const { store, company, project, workspace } = await setupBase()
    store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const foundry = store.createAgent({
      companyRef: company.id,
      name: "foundry",
      role: "Reviewer",
      adapterType: "azure_foundry",
      model: "Kimi-K2.6"
    })
    store.upsertAdapterLaneHealth({
      companyId: company.id,
      adapterType: "codex_local",
      laneKey: "pool",
      laneLabel: "codex_local pool",
      status: "rate_limited",
      reason: "HTTP 429",
      cooldownUntil: new Date(Date.now() + 60_000).toISOString()
    })
    const accountsDir = join(workspace.root, "codex-accounts")
    const authFile = join(workspace.root, "codex-auth.json")
    const authSnapshot = JSON.stringify({ account: "alpha" }, null, 2)
    writeFileSync(join(accountsDir, "alpha.json"), authSnapshot, "utf8")
    writeFileSync(join(accountsDir, "beta.json"), JSON.stringify({ account: "beta" }, null, 2), "utf8")
    writeFileSync(authFile, authSnapshot, "utf8")
    const task = store.createTask({
      projectRef: project.id,
      title: "Summarize reviewer handoff",
      kind: "follow_up",
      requestedAdapterType: "codex_local",
      labels: ["summary", "review"]
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async () => ({ ok: true, response: "unused" })),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" })),
      azure_foundry: fakeAdapter("azure_foundry", async () => ({ ok: true, response: "handled" }))
    })

    await executor.tick()
    const run = store.listRuns()[0]!

    expect(run.agentId).toBe(foundry.id)
    expect(run.adapterType).toBe("azure_foundry")
    expect(store.getTaskById(task.id).status).toBe("done")
    expect(store.getAdapterLaneHealth(company.id, "codex_local", "pool")).toMatchObject({
      status: "rate_limited",
      reason: "HTTP 429"
    })

    store.close()
  })

  it("invalidates a stale adapter cooldown when the execution configuration changes", async () => {
    const { store, company, project } = await setupBase()
    const gemini = store.createAgent({
      companyRef: company.id,
      name: "opencode",
      role: "UI Engineer",
      adapterType: "gemini_local",
      command: "acpx",
      model: "opencode/deepseek-v4-flash-free",
      env: {
        OPENCLAW_GEMINI_ACPX_AGENT_COMMAND: "opencode acp",
        OPENCLAW_GEMINI_ACPX_MODEL: "opencode/deepseek-v4-flash-free"
      }
    })
    store.upsertAdapterLaneHealth({
      companyId: company.id,
      adapterType: "gemini_local",
      laneKey: "pool",
      laneLabel: "gemini_local pool",
      status: "auth_failed",
      reason: "old model authentication failed",
      cooldownUntil: new Date(Date.now() + 60_000).toISOString(),
      metadata: {
        source: "execution_pool_rollup",
        configurationFingerprint: "old-configuration"
      }
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Use reconfigured ACP model",
      kind: "follow_up",
      requestedAdapterType: "gemini_local"
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async () => ({ ok: true, response: "unused" })),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "handled" })),
      azure_foundry: fakeAdapter("azure_foundry", async () => ({ ok: true, response: "unused" }))
    })

    await executor.tick()

    expect(store.getLatestRunForTask(task.id)).toMatchObject({
      agentId: gemini.id,
      adapterType: "gemini_local",
      status: "succeeded"
    })
    expect(store.getAdapterLaneHealth(company.id, "gemini_local", "pool")).toMatchObject({
      status: "healthy",
      cooldownUntil: null
    })

    store.close()
  })
})
