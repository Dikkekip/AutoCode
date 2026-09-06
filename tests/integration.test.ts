import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { codexLocalAdapter } from "@openclaw/adapter-codex-local"
import { geminiLocalAdapter } from "@openclaw/adapter-gemini-local"
import { afterEach, describe, expect, it } from "vitest"

import { createFakeCodexScript, createFakeGeminiScript, createTempWorkspace } from "./helpers.js"
import { HAS_NODE_SQLITE } from "./node-sqlite.js"

let DispatcherStore: typeof import("@openclaw/db").DispatcherStore | null = null
let DispatcherExecutor: typeof import("@openclaw/executor").DispatcherExecutor | null = null
if (HAS_NODE_SQLITE) {
  ;({ DispatcherStore } = await import("@openclaw/db"))
  ;({ DispatcherExecutor } = await import("@openclaw/executor"))
}

const describeDb = HAS_NODE_SQLITE ? describe : describe.skip

describeDb("dispatcher integration", () => {
  const cleanups: Array<() => void> = []

  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.()
  })

  function setup(options: { verifyCommand?: string | null } = {}) {
    const workspace = createTempWorkspace("dispatcher-integration")
    execFileSync("git", ["init", "-b", "main"], { cwd: workspace.repoPath })
    execFileSync("git", ["config", "user.email", "test@example.test"], { cwd: workspace.repoPath })
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: workspace.repoPath })
    execFileSync("git", ["add", "README.md"], { cwd: workspace.repoPath })
    execFileSync("git", ["commit", "-m", "initial"], { cwd: workspace.repoPath })
    cleanups.push(workspace.cleanup)
    const store = new DispatcherStore!(workspace.dbPath)
    store.migrate()
    const company = store.createCompany({ name: "OpenClaw Labs" })
    const project = store.createProject({
      companyRef: company.id,
      name: "repo",
      repoPath: workspace.repoPath,
      verifyCommand: options.verifyCommand ?? null
    })
    return { workspace, store, company, project }
  }

  it("writes runs and events for a Codex task", async () => {
    const { workspace, store, company, project } = setup()
    const codexScript = createFakeCodexScript(workspace.root)
    store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local",
      command: codexScript
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Implement backend task"
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: codexLocalAdapter,
      gemini_local: geminiLocalAdapter
    })

    const summary = await executor.tick()
    expect(summary.executedRuns).toBe(1)
    expect(store.getTaskById(task.id).status).toBe("done")
    const runs = store.listRuns()
    expect(runs).toHaveLength(1)
    expect(store.getRunEvents(runs[0]!.id).length).toBeGreaterThan(0)
    expect(runs[0]!.metadata?.telemetrySummary).toMatchObject({
      status: "ok"
    })
    expect(
      Array.isArray((runs[0]!.metadata?.telemetry as { executionPath?: unknown[] } | undefined)?.executionPath)
    ).toBe(true)
    expect(runs[0]!.metadata?.telemetry).toMatchObject({ compacted: true })
    expect(runs[0]!.metadata?.telemetry).not.toHaveProperty("spans")
    expect(runs[0]!.metadata?.telemetry).not.toHaveProperty("attributes")
    expect((runs[0]!.metadata?.telemetrySummary as { spanCount?: number } | undefined)?.spanCount).toBeGreaterThan(0)

    store.close()
  })

  it("keeps a complex Codex task moving end-to-end when Astra quota forces model fallback", async () => {
    const { workspace, store, company, project } = setup({ verifyCommand: "sh -c \"printf 'verified\\n'\"" })
    const modelLogPath = join(workspace.root, "codex-model-fallback.log")
    const codexScript = join(workspace.root, "fake-codex-model-fallback.py")
    writeFileSync(
      codexScript,
      [
        "#!/usr/bin/env python3",
        "from pathlib import Path",
        "import json",
        "import sys",
        `log_path = Path(${JSON.stringify(modelLogPath)})`,
        "argv = sys.argv[1:]",
        "model = 'unknown'",
        "if '-m' in argv:",
        "    model = argv[argv.index('-m') + 1]",
        "with log_path.open('a', encoding='utf8') as f:",
        "    f.write(model + '\\n')",
        "if model in {'gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra'}:",
        "    msg = f'OpenAI usage limit reached for model {model}'",
        "    print(json.dumps({'jsonrpc': '2.0', 'id': None, 'error': {'message': msg}}))",
        "    print(msg, file=sys.stderr)",
        "    raise SystemExit(1)",
        "print(json.dumps({'sessionId': 'codex-session-luna', 'response': 'implemented via GPT-5.6 Luna fallback', 'usage': {'totalTokens': 19}}))",
        "raise SystemExit(0)"
      ].join("\n"),
      { mode: 0o755 }
    )

    store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Senior Engineer",
      adapterType: "codex_local",
      command: codexScript,
      model: "gpt-5.5"
    })
    const task = store.createTask({
      projectRef: project.id,
      title:
        "Diagnose and implement a critical production autonomous-runtime quota fallback with broad codebase analysis",
      labels: ["backend", "runtime", "quota", "critical", "production", "ci blocker"],
      allowedPaths: ["packages/adapters/codex-local/src/index.ts", "packages/executor/src/runner.ts"],
      requiredReading: [
        "packages/adapters/codex-local/src/index.ts",
        "packages/executor/src/runner.ts",
        "packages/domain/src/routing.ts",
        "tests/codex-local-adapter.test.ts"
      ],
      verificationCommands: ["sh -c \"printf 'task-verified\\n'\""]
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: codexLocalAdapter,
      gemini_local: geminiLocalAdapter
    })

    const summary = await executor.tick()
    expect(summary.executedRuns).toBe(1)
    expect(store.getTaskById(task.id).status).toBe("done")

    const run = store.listRuns()[0]!
    expect(run.status).toBe("succeeded")
    expect(run.responseText).toContain("GPT-5.6 Luna fallback")
    expect(run.usage?.totalTokens).toBe(19)
    expect(run.verificationSummary).toBe("sh -c \"printf 'task-verified\\n'\"")
    expect(readFileSync(modelLogPath, "utf8").trim().split("\n")).toEqual([
      "gpt-6-astra",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna"
    ])

    const completedEvent = store.getRunEvents(run.id).find((event) => event.message === "Run completed successfully")
    expect(completedEvent?.data?.adapterMetadata).toMatchObject({ model: "gpt-5.6-luna" })
    expect(completedEvent?.data?.runtimeIdentity).toMatchObject({ model: "gpt-5.6-luna" })

    store.close()
  })

  it("routes UI tasks to Gemini and records usage", async () => {
    const { workspace, store, company, project } = setup()
    const codexScript = createFakeCodexScript(workspace.root)
    const geminiScript = createFakeGeminiScript(workspace.root)
    store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local",
      command: codexScript
    })
    const geminiAgent = store.createAgent({
      companyRef: company.id,
      name: "gemini-ui",
      role: "UI Engineer",
      adapterType: "gemini_local",
      command: geminiScript,
      budgetLimit: 10
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Polish the settings UI",
      labels: ["ui"]
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: codexLocalAdapter,
      gemini_local: geminiLocalAdapter
    })

    await executor.tick()

    const run = store.listRuns()[0]!
    expect(run.adapterType).toBe("gemini_local")
    expect(store.getTaskById(task.id).status).toBe("done")
    const budgetStatus = store.getBudgetStatus(geminiAgent)
    expect(budgetStatus.usageUnits).toBe(7)
    expect(run.metadata?.telemetrySummary).toMatchObject({
      status: "ok",
      totalTokens: 7
    })

    store.close()
  })

  it("blocks approval-required tasks until approved", async () => {
    const { workspace, store, company, project } = setup()
    const codexScript = createFakeCodexScript(workspace.root)
    store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local",
      command: codexScript
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Risky change",
      approvalRequired: true
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: codexLocalAdapter,
      gemini_local: geminiLocalAdapter
    })

    const blockedSummary = await executor.tick()
    expect(blockedSummary.blockedTasks).toBe(1)
    expect(store.getTaskById(task.id).status).toBe("blocked")
    expect(store.getLatestApprovalRequest(task.id)?.status).toBe("pending")

    store.approveTask(task.id, "tester")
    await executor.tick()
    expect(store.getTaskById(task.id).status).toBe("done")

    store.close()
  })

  it("blocks deterministic verification failures instead of rerunning inference", async () => {
    const { workspace, store, company, project } = setup({ verifyCommand: "sh -c 'exit 1'" })
    const codexScript = createFakeCodexScript(workspace.root)
    store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local",
      command: codexScript
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Break verification",
      maxRetries: 0
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: codexLocalAdapter,
      gemini_local: geminiLocalAdapter
    })

    const summary = await executor.tick()
    expect(summary.followUpTasks).toBe(0)
    expect(store.getTaskById(task.id).status).toBe("blocked")
    expect(store.getTaskById(task.id).blockedReason).toBe("verification_failure:verification")

    store.close()
  })

  it("prefers task package verification over the project-level verifier", async () => {
    const { workspace, store, company, project } = setup({ verifyCommand: "sh -c 'exit 1'" })
    const codexScript = createFakeCodexScript(workspace.root)
    store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local",
      command: codexScript
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Polish vedlegg UI",
      labels: ["ui"],
      taskPackage: {
        version: 1,
        generatedAt: new Date().toISOString(),
        repoProfile: "mixed-frontend-backend",
        likelyOwnershipLane: "ui",
        laneReason: "ui task",
        inferenceSignals: ["ui task"],
        requiredReading: [],
        verificationChecklist: ["sh -c \"printf 'ui-verification\\n'\""],
        contractUpdateReminders: [],
        repoNotes: []
      }
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: codexLocalAdapter,
      gemini_local: geminiLocalAdapter
    })

    const summary = await executor.tick()
    expect(summary.executedRuns).toBe(1)
    expect(store.getTaskById(task.id).status).toBe("done")
    const run = store.listRuns()[0]!
    expect(run.status).toBe("succeeded")
    expect(run.verificationSummary).toBe("sh -c \"printf 'ui-verification\\n'\"")

    store.close()
  })

  it("prefers task-level verification commands over the project-level verifier", async () => {
    const { workspace, store, company, project } = setup({ verifyCommand: "sh -c 'exit 1'" })
    const codexScript = createFakeCodexScript(workspace.root)
    store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local",
      command: codexScript
    })
    const task = store.createTask({
      projectRef: project.id,
      title: "Run queued verification",
      verificationCommands: ["sh -c \"printf 'task-verification\\n'\""]
    })

    const executor = new DispatcherExecutor!(store, {
      codex_local: codexLocalAdapter,
      gemini_local: geminiLocalAdapter
    })

    const summary = await executor.tick()
    expect(summary.executedRuns).toBe(1)
    expect(store.getTaskById(task.id).status).toBe("done")
    const run = store.listRuns()[0]!
    expect(run.status).toBe("succeeded")
    expect(run.verificationSummary).toBe("sh -c \"printf 'task-verification\\n'\"")

    store.close()
  })
})
