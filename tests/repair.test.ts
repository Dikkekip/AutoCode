import { classifyBlockedReason } from "@openclaw/domain"
import { describe, expect, it } from "vitest"

import { createTempWorkspace } from "./helpers.js"
import { HAS_NODE_SQLITE } from "./node-sqlite.js"

let DispatcherStore: typeof import("@openclaw/db").DispatcherStore | null = null
let runCli: typeof import("../apps/dispatcher-cli/src/index.js").runCli | null = null
if (HAS_NODE_SQLITE) {
  ;({ DispatcherStore } = await import("@openclaw/db"))
  ;({ runCli } = await import("../apps/dispatcher-cli/src/index.js"))
}

const describeDb = HAS_NODE_SQLITE ? describe : describe.skip

describe("blocked reason classification", () => {
  it("classifies quota, verification, scope, and human blockers", () => {
    expect(classifyBlockedReason("Codex quota limit reached", "transient")).toBe("quota")
    expect(classifyBlockedReason("Verification command failed: pnpm test", "verification")).toBe("verification_failure")
    expect(classifyBlockedReason("Working tree has changes outside run scope", "policy")).toBe("scope_invalid")
    expect(classifyBlockedReason("Manual approval required before merge", "policy")).toBe("needs_human")
    expect(classifyBlockedReason("Verification command failed: pnpm test", "adapter_capability")).toBe(
      "verification_failure"
    )
  })

  it("classifies provider usage-limit and disabled-service messages as quota blockers", () => {
    expect(classifyBlockedReason("You've hit your usage limit. Upgrade to Pro", "transient")).toBe("quota")
    expect(classifyBlockedReason("Your workspace is out of credits. Add credits to continue.", "transient")).toBe(
      "quota"
    )
    expect(classifyBlockedReason("reason: SERVICE_DISABLED accessNotConfigured", "transient")).toBe("quota")
    expect(classifyBlockedReason("Gemini for Google Cloud API is disabled", "transient")).toBe("quota")
  })
})

describeDb("repair tasks", () => {
  function setupFailedRun() {
    const workspace = createTempWorkspace("dispatcher-repair")
    const store = new DispatcherStore!(workspace.dbPath)
    store.migrate()
    const company = store.createCompany({ name: "Repair Co" })
    const project = store.createProject({
      companyRef: company.id,
      name: "repo",
      repoPath: workspace.repoPath,
      verifyCommand: "pnpm test"
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Add repair system",
      description: "Build self-repair support.",
      changedFiles: ["packages/domain/src/repair.ts", "apps/dispatcher-cli/src/index.ts"],
      allowedPaths: ["packages/domain/src/repair.ts", "apps/dispatcher-cli/src/index.ts"],
      verificationCommands: ["Run the focused repair regression checks", "pnpm test -- repair"],
      maxRetries: 0
    })
    const run = store.createRun({
      companyId: company.id,
      projectId: project.id,
      taskId: task.id,
      adapterType: "codex_local",
      kind: "implement",
      retryClass: "verification"
    })
    store.appendRunEvent(run.id, "warn", "Verification stderr", {
      command: "pnpm test -- repair",
      output: "expected true to be false"
    })
    store.completeRun(run.id, {
      status: "failed",
      errorText: "Verification failed",
      verificationSummary: "pnpm test -- repair",
      retryClass: "verification"
    })
    store.updateTaskStatus(task.id, "failed", {
      lastError: "Verification failed"
    })

    return { workspace, store, company, project, task, run: store.getRunById(run.id) }
  }

  it("creates a scoped repair task from a failed run", () => {
    const { workspace, store, task, run } = setupFailedRun()

    try {
      const result = store.createRepairTaskForRun(run.id)

      expect(result.status).toBe("created")
      expect(result.task?.kind).toBe("repair")
      expect(result.task?.parentTaskId).toBe(task.id)
      expect(result.task?.requestedAdapterType).toBe("codex_local")
      expect(result.task?.maxRetries).toBe(0)
      expect(result.task?.allowedPaths).toEqual(task.changedFiles)
      expect(result.task?.description).toContain("Original objective:")
      expect(result.task?.description).toContain("Exact error output:")
      expect(result.task?.description).toContain("expected true to be false")
      expect(result.task?.description).toContain("Max attempts: 2; this is attempt 1.")
      expect(result.task?.verificationCommands).toEqual(expect.arrayContaining(["pnpm test -- repair"]))
      expect(result.task?.verificationCommands).not.toContain("pnpm test")
      expect(result.task?.verificationCommands).not.toContain("Run the focused repair regression checks")
      expect(result.task?.description).not.toContain("Run the focused repair regression checks")
    } finally {
      store.close()
      workspace.cleanup()
    }
  })

  it("includes actual run changes in a repair task's strict scope", () => {
    const { workspace, store, task, run } = setupFailedRun()

    try {
      store.updateRunMetadata(run.id, {
        changedFiles: ["packages/domain/src/repair.ts", "packages/domain/src/new-repair-helper.ts"]
      })

      const result = store.createRepairTaskForRun(run.id)

      expect(result.status).toBe("created")
      expect(result.task?.allowedPaths).toEqual([...task.changedFiles, "packages/domain/src/new-repair-helper.ts"])
      expect(result.task?.requiredReading).toContain("packages/domain/src/new-repair-helper.ts")
    } finally {
      store.close()
      workspace.cleanup()
    }
  })

  it("bounds oversized adapter transcripts in repair descriptions", () => {
    const { workspace, store, run } = setupFailedRun()

    try {
      store.completeRun(run.id, {
        status: "failed",
        errorText: `${"echoed prompt ".repeat(150_000)}Account.Unauthorized: diagnostic-tail`,
        retryClass: "transient"
      })

      const result = store.createRepairTaskForRun(run.id)

      expect(result.status).toBe("created")
      expect(result.task?.description).toContain("characters omitted from repair evidence")
      expect(result.task?.description).toContain("diagnostic-tail")
      expect(result.task?.description.length).toBeLessThan(25_000)
    } finally {
      store.close()
      workspace.cleanup()
    }
  })

  it("tracks failed repair attempts and escalates after two failures", () => {
    const { workspace, store, company, project, task, run } = setupFailedRun()

    try {
      const firstRepair = store.createRepairTaskForRun(run.id)
      expect(firstRepair.status).toBe("created")
      store.updateTaskStatus(firstRepair.task!.id, "blocked", {
        lastError: "first repair blocked"
      })

      const firstRepairRun = store.createRun({
        companyId: company.id,
        projectId: project.id,
        taskId: firstRepair.task!.id,
        adapterType: "codex_local",
        kind: "repair",
        retryClass: "verification"
      })
      store.completeRun(firstRepairRun.id, {
        status: "failed",
        errorText: "first repair failed",
        retryClass: "verification"
      })

      const secondRepair = store.createRepairTaskForRun(firstRepairRun.id)
      expect(secondRepair.status).toBe("created")
      expect(secondRepair.attempt).toBe(2)
      store.updateTaskStatus(secondRepair.task!.id, "failed", {
        lastError: "second repair failed"
      })

      const secondRepairRun = store.createRun({
        companyId: company.id,
        projectId: project.id,
        taskId: secondRepair.task!.id,
        adapterType: "codex_local",
        kind: "repair",
        retryClass: "verification"
      })
      store.completeRun(secondRepairRun.id, {
        status: "failed",
        errorText: "second repair failed",
        retryClass: "verification"
      })

      const escalated = store.createRepairTaskForRun(secondRepairRun.id)

      expect(escalated.status).toBe("needs_human_review")
      expect(store.countFailedRepairAttempts(task.id)).toBe(2)
      expect(store.getTaskById(task.id).status).toBe("needs_human_review")
      expect(store.getTaskById(task.id).blockedReason).toBe("repair_attempt_limit_exceeded")
    } finally {
      store.close()
      workspace.cleanup()
    }
  })

  it("exposes repair creation through the dispatcher CLI", async () => {
    const { workspace, store, run } = setupFailedRun()
    const output: string[] = []
    const io = {
      stdout: (message: string) => output.push(message),
      stderr: (message: string) => output.push(message)
    }
    store.close()

    try {
      await runCli!(["--db", workspace.dbPath, "repair", "create", "--run", run.id], io)
      await runCli!(["--db", workspace.dbPath, "repair", "status"], io)

      const fullOutput = output.join("\n")
      expect(fullOutput).toContain("Repair task created.")
      expect(fullOutput).toContain("attempt: 1")
      expect(fullOutput).toContain("Repair tasks:")
    } finally {
      workspace.cleanup()
    }
  })
})
