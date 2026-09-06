import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { AdapterDefinition, AdapterExecutionResult } from "@openclaw/domain"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createTempWorkspace } from "./helpers.js"
import { HAS_NODE_SQLITE } from "./node-sqlite.js"

let DispatcherStore: typeof import("@openclaw/db").DispatcherStore | null = null
let DispatcherExecutor: typeof import("@openclaw/executor").DispatcherExecutor | null = null
let MemoryService: typeof import("@openclaw/executor").MemoryService | null = null
if (HAS_NODE_SQLITE) {
  ;({ DispatcherStore } = await import("@openclaw/db"))
  ;({ DispatcherExecutor, MemoryService } = await import("@openclaw/executor"))
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

const describeDb = HAS_NODE_SQLITE ? describe : describe.skip

describeDb("memory service", () => {
  const cleanups: Array<() => void> = []
  const originalApiKey = process.env.OPENAI_API_KEY
  const originalModel = process.env.OPENAI_EMBEDDING_MODEL
  const originalBaseUrl = process.env.OPENAI_BASE_URL
  const originalAzureApiKey = process.env.AZURE_OPENAI_API_KEY

  afterEach(() => {
    vi.restoreAllMocks()
    if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = originalApiKey
    if (originalModel === undefined) delete process.env.OPENAI_EMBEDDING_MODEL
    else process.env.OPENAI_EMBEDDING_MODEL = originalModel
    if (originalBaseUrl === undefined) delete process.env.OPENAI_BASE_URL
    else process.env.OPENAI_BASE_URL = originalBaseUrl
    if (originalAzureApiKey === undefined) delete process.env.AZURE_OPENAI_API_KEY
    else process.env.AZURE_OPENAI_API_KEY = originalAzureApiKey
    while (cleanups.length > 0) cleanups.pop()?.()
  })

  function setup() {
    const workspace = createTempWorkspace("dispatcher-memory")
    cleanups.push(workspace.cleanup)
    const store = new DispatcherStore!(workspace.dbPath)
    store.migrate()
    const company = store.createCompany({ name: "Memory Co" })
    const project = store.createProject({
      companyRef: company.id,
      name: "repo",
      repoPath: workspace.repoPath,
      verifyCommand: null
    })
    return { workspace, store, company, project }
  }

  it("indexes repo-context docs and only rewrites chunks when content changes", async () => {
    const { workspace, store, company, project } = setup()
    writeFileSync(
      join(workspace.repoPath, "AGENTS.md"),
      "# Rules\n\nUse tests.\n\n## Memory\n\nPrefer durable notes over recollection.\n",
      "utf8"
    )
    mkdirSync(join(workspace.repoPath, "agent", "rules"), { recursive: true })
    writeFileSync(
      join(workspace.repoPath, "agent", "rules", "development-workflow.md"),
      "# Workflow\n\nAlways verify changes before finishing.\n",
      "utf8"
    )
    writeFileSync(join(workspace.repoPath, "PRIVATE.md"), "should never be indexed\n", "utf8")

    const agent = store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const memory = new MemoryService!(store)

    await memory.upsertRepoMemory(project, agent)
    const indexed = store.listMemoryChunks(project.id, ["shared", "codex"], ["repo_doc"])
    expect(indexed.some((chunk) => chunk.sourcePath === "AGENTS.md")).toBe(true)
    expect(indexed.some((chunk) => chunk.sourcePath === "agent/rules/development-workflow.md")).toBe(true)
    expect(indexed.some((chunk) => chunk.sourcePath === "PRIVATE.md")).toBe(false)

    const agentsChunk = indexed.find((chunk) => chunk.sourcePath === "AGENTS.md")
    expect(agentsChunk).toBeTruthy()
    const firstUpdatedAt = agentsChunk?.updatedAt
    const firstHash = agentsChunk?.contentHash

    await memory.upsertRepoMemory(project, agent)
    const unchangedChunk = store
      .listMemoryChunks(project.id, ["shared"], ["repo_doc"])
      .find((chunk) => chunk.sourcePath === "AGENTS.md")
    expect(unchangedChunk?.updatedAt).toBe(firstUpdatedAt)
    expect(unchangedChunk?.contentHash).toBe(firstHash)

    writeFileSync(
      join(workspace.repoPath, "AGENTS.md"),
      "# Rules\n\nUse tests.\n\n## Memory\n\nPrefer durable notes and semantic recall.\n",
      "utf8"
    )
    await memory.upsertRepoMemory(project, agent)
    const changedChunk = store
      .listMemoryChunks(project.id, ["shared"], ["repo_doc"])
      .find((chunk) => chunk.sourcePath === "AGENTS.md")
    expect(changedChunk?.contentHash).not.toBe(firstHash)

    store.close()
  })

  it("retrieves same-project episodic memory and respects audience-specific repo docs", async () => {
    const { workspace, store, company, project } = setup()
    writeFileSync(join(workspace.repoPath, "AGENTS.md"), "# Shared\n\nAlways check migrations.\n", "utf8")
    mkdirSync(join(workspace.repoPath, "agent", "rules"), { recursive: true })
    writeFileSync(
      join(workspace.repoPath, "agent", "rules", "development-workflow.md"),
      "# Backend\n\nFix checkout token refresh regressions carefully.\n",
      "utf8"
    )
    mkdirSync(join(workspace.repoPath, "apps", "web"), { recursive: true })
    writeFileSync(
      join(workspace.repoPath, "apps", "web", "package.json"),
      JSON.stringify({ dependencies: { react: "^19.0.0", vite: "^6.0.0" } }, null, 2),
      "utf8"
    )
    writeFileSync(
      join(workspace.repoPath, "apps", "web", "STYLE_RECIPE.md"),
      "# UI\n\nUse coral accents in settings surfaces.\n",
      "utf8"
    )

    process.env.OPENAI_API_KEY = "test-key"
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string }
        const input = body.input ?? ""
        const vector = input.includes("checkout") ? [1, 0, 0] : input.includes("coral") ? [0, 1, 0] : [0, 0, 1]
        return new Response(JSON.stringify({ data: [{ embedding: vector }] }), { status: 200 })
      })
    )

    const codexAgent = store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const geminiAgent = store.createAgent({
      companyRef: company.id,
      name: "gemini",
      role: "UI Engineer",
      adapterType: "gemini_local"
    })
    const memory = new MemoryService!(store)
    await memory.upsertRepoMemory(project, codexAgent)
    await memory.upsertRepoMemory(project, geminiAgent)

    const task = store.createTask({
      projectRef: project.id,
      title: "Fix checkout refresh flow",
      description: "Users lose their session during checkout.",
      labels: ["backend"],
      changedFiles: ["src/auth.ts"]
    })
    const run = store.createRun({
      companyId: company.id,
      projectId: project.id,
      taskId: task.id,
      agentId: codexAgent.id,
      adapterType: "codex_local"
    })
    store.completeRun(run.id, {
      status: "succeeded",
      responseText: "Adjusted checkout token refresh handling."
    })
    await memory.recordRunMemory(task, store.getRunById(run.id))

    const otherProject = store.createProject({
      companyRef: company.id,
      name: "other",
      repoPath: workspace.repoPath,
      verifyCommand: null
    })
    const otherTask = store.createTask({
      projectRef: otherProject.id,
      title: "Coral settings polish"
    })
    const otherRun = store.createRun({
      companyId: company.id,
      projectId: otherProject.id,
      taskId: otherTask.id,
      agentId: geminiAgent.id,
      adapterType: "gemini_local"
    })
    store.completeRun(otherRun.id, {
      status: "succeeded",
      responseText: "Tweaked coral accents."
    })
    await memory.recordRunMemory(otherTask, store.getRunById(otherRun.id))

    const retrieved = await memory.retrieveRelevantMemory(
      store.createTask({
        projectRef: project.id,
        title: "Checkout session fails after refresh",
        labels: ["backend"]
      }),
      codexAgent,
      project
    )
    expect(retrieved.some((entry) => entry.chunk.sourceKind === "run_summary")).toBe(true)
    expect(retrieved.some((entry) => entry.chunk.sourcePath === "agent/rules/development-workflow.md")).toBe(true)
    expect(retrieved.some((entry) => entry.chunk.sourcePath === "apps/web/STYLE_RECIPE.md")).toBe(false)
    expect(retrieved.some((entry) => entry.chunk.projectId === otherProject.id)).toBe(false)

    store.close()
  })

  it("uses OPENAI_BASE_URL for Azure OpenAI-compatible embedding requests", async () => {
    const { workspace, store, company, project } = setup()
    writeFileSync(join(workspace.repoPath, "AGENTS.md"), "# Shared\n\nAzure-backed memory.\n", "utf8")

    process.env.OPENAI_BASE_URL = "https://example-resource.cognitiveservices.azure.com/openai/v1/"
    process.env.AZURE_OPENAI_API_KEY = "azure-test-key"
    process.env.OPENAI_EMBEDDING_MODEL = "text-embedding-3-small"

    let requestedUrl = ""
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        requestedUrl = String(url)
        return new Response(JSON.stringify({ data: [{ embedding: [1, 0, 0] }] }), { status: 200 })
      })
    )

    const agent = store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const memory = new MemoryService!(store)
    await memory.upsertRepoMemory(project, agent)

    expect(requestedUrl).toBe("https://example-resource.cognitiveservices.azure.com/openai/v1/embeddings")
    const embeddings = store.listMemoryEmbeddings(
      store.listMemoryChunks(project.id, ["shared"], ["repo_doc"]).map((chunk) => chunk.id),
      "azure-openai",
      "text-embedding-3-small"
    )
    expect(embeddings.length).toBeGreaterThan(0)

    store.close()
  })

  it("writes run summaries and injects relevant memory into prompts", async () => {
    const { workspace, store, company, project } = setup()
    writeFileSync(join(workspace.repoPath, "AGENTS.md"), "# Shared\n\nRemember prior migration fixes.\n", "utf8")

    process.env.OPENAI_API_KEY = "test-key"
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string }
        const vector = String(body.input ?? "").includes("migration") ? [1, 0] : [0, 1]
        return new Response(JSON.stringify({ data: [{ embedding: vector }] }), { status: 200 })
      })
    )

    const agent = store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local"
    })

    const pastTask = store.createTask({
      projectRef: project.id,
      title: "Fix migration ordering",
      description: "Migrations apply out of order.",
      labels: ["backend"]
    })
    const pastRun = store.createRun({
      companyId: company.id,
      projectId: project.id,
      taskId: pastTask.id,
      agentId: agent.id,
      adapterType: "codex_local"
    })
    store.completeRun(pastRun.id, {
      status: "succeeded",
      responseText: "Reordered migration execution."
    })
    store.updateTaskStatus(pastTask.id, "done", { assignedAgentId: agent.id, lastError: null })
    const memory = new MemoryService!(store)
    await memory.recordRunMemory(pastTask, store.getRunById(pastRun.id))

    let capturedPrompt = ""
    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async (context): Promise<AdapterExecutionResult> => {
        capturedPrompt = context.prompt
        return { ok: true, response: "done" }
      }),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" }))
    })

    const task = store.createTask({
      projectRef: project.id,
      title: "Migration rollback keeps failing",
      description: "Need the prior migration context.",
      labels: ["backend"]
    })

    const summary = await executor.tick()
    expect(summary.executedRuns).toBe(1)
    expect(capturedPrompt).toContain("Relevant memory:")
    expect(capturedPrompt).toContain("[run_summary]")
    expect(capturedPrompt).toContain("Reordered migration execution.")

    const runSummaries = store.listMemoryChunks(project.id, ["project"], ["run_summary"])
    expect(runSummaries.length).toBeGreaterThanOrEqual(2)
    expect(runSummaries.some((chunk) => chunk.content.includes("Task: Migration rollback keeps failing"))).toBe(true)
    expect(store.getTaskById(task.id).status).toBe("done")

    store.close()
  })

  it("falls back cleanly when embeddings fail and still completes execution", async () => {
    const { workspace, store, company, project } = setup()
    writeFileSync(join(workspace.repoPath, "AGENTS.md"), "# Shared\n\nKeep auth stable.\n", "utf8")
    process.env.OPENAI_API_KEY = "broken-key"
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 }))
    )

    const agent = store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local"
    })
    let capturedPrompt = ""
    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async (context) => {
        capturedPrompt = context.prompt
        return { ok: true, response: "completed without embeddings" }
      }),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" }))
    })

    const task = store.createTask({
      projectRef: project.id,
      title: "Stabilize auth"
    })

    const summary = await executor.tick()
    expect(summary.executedRuns).toBe(1)
    expect(store.getTaskById(task.id).status).toBe("done")
    expect(capturedPrompt).toContain("Task summary:")

    store.close()
  })

  it("still executes first-run tasks when no memory exists yet", async () => {
    const { store, company, project } = setup()
    const agent = store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local"
    })
    let capturedPrompt = ""
    const executor = new DispatcherExecutor!(store, {
      codex_local: fakeAdapter("codex_local", async (context) => {
        capturedPrompt = context.prompt
        return { ok: true, response: "first run ok" }
      }),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" }))
    })

    const task = store.createTask({
      projectRef: project.id,
      title: "Brand new task"
    })

    const summary = await executor.tick()
    expect(summary.executedRuns).toBe(1)
    expect(store.getTaskById(task.id).status).toBe("done")
    expect(capturedPrompt).not.toContain("Relevant memory:")

    store.close()
  })
})
