import { createHash } from "node:crypto"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import type { Agent, Company, Project, RuntimeIdentityPayload, Task } from "@openclaw/domain"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { RunToolingCache, shapeExecutionPrompt } from "../packages/executor/src/runtime-optimization.ts"
import { HAS_NODE_SQLITE } from "./node-sqlite.js"

const TEMP_TEST_DIR = resolve("./temp-autonomous-ports-tests")
const describeDb = HAS_NODE_SQLITE ? describe : describe.skip

let DispatcherStore: typeof import("@openclaw/db").DispatcherStore | null = null
let runCli: typeof import("../apps/dispatcher-cli/src/index.js").runCli | null = null
let healthByAdapterForRouting: typeof import("../apps/dispatcher-cli/src/index.js").healthByAdapterForRouting | null =
  null

if (HAS_NODE_SQLITE) {
  ;({ DispatcherStore } = await import("@openclaw/db"))
  ;({ runCli, healthByAdapterForRouting } = await import("../apps/dispatcher-cli/src/index.js"))
}

describe("autonomous ported features - stateless tests", () => {
  beforeAll(() => {
    mkdirSync(TEMP_TEST_DIR, { recursive: true })
  })

  afterAll(() => {
    rmSync(TEMP_TEST_DIR, { recursive: true, force: true })
  })

  const mockCompany: Company = {
    id: "c1",
    name: "Acme",
    createdAt: "2026-06-17T00:00:00.000Z"
  }

  const mockProject: Project = {
    id: "p1",
    companyId: "c1",
    name: "openclaw",
    repoPath: TEMP_TEST_DIR,
    profileId: "minimal",
    profileJson: "{}",
    createdAt: "2026-06-17T00:00:00.000Z",
    updatedAt: "2026-06-17T00:00:00.000Z"
  }

  const mockAgent: Agent = {
    id: "a1",
    companyId: "c1",
    name: "DeveloperAgent",
    role: "Senior Developer",
    adapterType: "codex_local",
    status: "active",
    env: {},
    heartbeatEnabled: true,
    heartbeatIntervalSec: 300,
    budgetWindow: "monthly",
    createdAt: "2026-06-17T00:00:00.000Z",
    updatedAt: "2026-06-17T00:00:00.000Z"
  }

  const mockRuntimeIdentity: RuntimeIdentityPayload = {
    runtimeKey: "rtk-1",
    executionKey: "exk-1",
    wake: { reason: "manual" },
    continuation: {
      sessionDisplayId: null,
      supportsSessionResume: true,
      nativeContextManagement: "confirmed"
    }
  }

  it("appends caveman instructions in shapeExecutionPrompt when task has caveman label", () => {
    const task: Task = {
      id: "t1",
      companyId: "c1",
      projectId: "p1",
      title: "Fix bug",
      description: "Fix a tiny bug",
      labels: ["caveman"],
      changedFiles: [],
      allowedPaths: [],
      requiredReading: [],
      verificationCommands: [],
      status: "queued",
      claimStatus: "unclaimed",
      retryCount: 0,
      maxRetries: 1,
      createdAt: "2026-06-17T00:00:00.000Z",
      updatedAt: "2026-06-17T00:00:00.000Z"
    }

    const toolingCache = new RunToolingCache("r1")
    const assembly = shapeExecutionPrompt({
      company: mockCompany,
      project: mockProject,
      task,
      agent: mockAgent,
      instructions: null,
      previousSession: null,
      sessionHandoffMarkdown: null,
      relevantMemory: null,
      runtimeIdentity: mockRuntimeIdentity,
      recentTaskEvents: [],
      recentRun: null,
      recentRunEvents: [],
      parentTask: null,
      toolingCache
    })

    expect(assembly.prompt).toContain("Respond terse like smart caveman")
    expect(assembly.prompt).toContain("Drop: articles")
    expect(assembly.responseCompression).toEqual({ mode: "full", source: "task_label" })
  })

  it("applies profile compression levels without weakening safety-sensitive prose", () => {
    const task: Task = {
      id: "t-profile-compression",
      companyId: "c1",
      projectId: "p1",
      title: "Summarize implementation",
      description: "Report the completed work",
      labels: [],
      changedFiles: [],
      allowedPaths: [],
      requiredReading: [],
      verificationCommands: [],
      status: "queued",
      claimStatus: "unclaimed",
      retryCount: 0,
      maxRetries: 1,
      createdAt: "2026-06-17T00:00:00.000Z",
      updatedAt: "2026-06-17T00:00:00.000Z"
    }

    const assembly = shapeExecutionPrompt({
      company: mockCompany,
      project: mockProject,
      task,
      agent: mockAgent,
      instructions: null,
      previousSession: null,
      sessionHandoffMarkdown: null,
      relevantMemory: null,
      runtimeIdentity: mockRuntimeIdentity,
      recentTaskEvents: [],
      recentRun: null,
      recentRunEvents: [],
      parentTask: null,
      toolingCache: new RunToolingCache("r-profile-compression"),
      responseCompressionMode: "ultra"
    })

    expect(assembly.responseCompression).toEqual({ mode: "ultra", source: "profile" })
    expect(assembly.prompt).toContain("Response compression: ultra")
    expect(assembly.prompt).toContain("security warnings, approval requests, irreversible actions")
  })

  it("loads and appends context hints in shapeExecutionPrompt", () => {
    const subDir = join(TEMP_TEST_DIR, "frontend", "components")
    mkdirSync(subDir, { recursive: true })
    writeFileSync(join(TEMP_TEST_DIR, "AGENTS.md"), "Global instruction")
    writeFileSync(join(subDir, ".goosehints"), "Local design component rule")

    const task: Task = {
      id: "t2",
      companyId: "c1",
      projectId: "p1",
      title: "Fix component design",
      description: "Align component layout",
      labels: [],
      changedFiles: ["frontend/components/button.tsx"],
      allowedPaths: [],
      requiredReading: [],
      verificationCommands: [],
      status: "queued",
      claimStatus: "unclaimed",
      retryCount: 0,
      maxRetries: 1,
      createdAt: "2026-06-17T00:00:00.000Z",
      updatedAt: "2026-06-17T00:00:00.000Z"
    }

    const toolingCache = new RunToolingCache("r2")
    const assembly = shapeExecutionPrompt({
      company: mockCompany,
      project: mockProject,
      task,
      agent: mockAgent,
      instructions: null,
      previousSession: null,
      sessionHandoffMarkdown: null,
      relevantMemory: null,
      runtimeIdentity: mockRuntimeIdentity,
      recentTaskEvents: [],
      recentRun: null,
      recentRunEvents: [],
      parentTask: null,
      toolingCache
    })

    expect(assembly.prompt).toContain("# Context Hints: AGENTS.md")
    expect(assembly.prompt).toContain("Global instruction")
    expect(assembly.prompt).toContain("# Context Hints: frontend/components/.goosehints")
    expect(assembly.prompt).toContain("Local design component rule")
  })
})

describeDb("autonomous ported features - database dependent tests", () => {
  beforeAll(() => {
    mkdirSync(TEMP_TEST_DIR, { recursive: true })
  })

  afterAll(() => {
    rmSync(TEMP_TEST_DIR, { recursive: true, force: true })
  })

  it("tracks prompt variants and registers trials during completeRun", () => {
    const dbPath = join(TEMP_TEST_DIR, "test-dispatcher.db")
    if (existsSync(dbPath)) rmSync(dbPath)

    const store = new DispatcherStore!(dbPath)
    store.migrate()
    try {
      const company = store.createCompany({ name: "ACME Corp" })
      const project = store.createProject({
        companyRef: company.id,
        name: "AcmeApp",
        repoPath: "/tmp"
      })
      const task = store.createTask({
        projectRef: project.id,
        title: "Build app",
        labels: []
      })
      const agent = store.createAgent({
        companyRef: company.id,
        name: "TestAgent",
        role: "Builder",
        adapterType: "gemini_local",
        status: "active",
        env: {}
      })

      const prompt = "System instructions for builder. Do task now."
      const promptHash = createHash("sha256").update(prompt).digest("hex")
      const variant = store.upsertPromptVariant({
        projectId: project.id,
        scope: "builder",
        label: "builder-baseline",
        promptHash
      })

      expect(variant.trials).toBe(0)
      expect(variant.successes).toBe(0)

      const run = store.createRun({
        companyId: company.id,
        projectId: project.id,
        taskId: task.id,
        agentId: agent.id,
        adapterType: "gemini_local"
      })
      store.updateRunMetadata(run.id, {
        promptVariantId: variant.id
      })

      store.completeRun(run.id, {
        status: "succeeded"
      })

      const variantAfterSuccess = store.getPromptVariantById(variant.id)
      expect(variantAfterSuccess.trials).toBe(1)
      expect(variantAfterSuccess.successes).toBe(1)

      const run2 = store.createRun({
        companyId: company.id,
        projectId: project.id,
        taskId: task.id,
        agentId: agent.id,
        adapterType: "gemini_local"
      })
      store.updateRunMetadata(run2.id, {
        promptVariantId: variant.id
      })
      store.completeRun(run2.id, {
        status: "failed"
      })

      const variantAfterFailure = store.getPromptVariantById(variant.id)
      expect(variantAfterFailure.trials).toBe(2)
      expect(variantAfterFailure.successes).toBe(1)
    } finally {
      store.close()
      if (existsSync(dbPath)) rmSync(dbPath)
    }
  })

  it("generates a redacted diagnostics bundle using openclaw diagnostics [targetId] CLI", async () => {
    const projectFilePath = join(TEMP_TEST_DIR, "package.json")
    writeFileSync(projectFilePath, '{\n  "name": "openclaw",\n  "api_key": "sk-12345678901234567890"\n}\n')

    const dbPath = join(TEMP_TEST_DIR, "test-diagnostics-cli.db")
    if (existsSync(dbPath)) rmSync(dbPath)

    const output: string[] = []
    const io = {
      stdout: (message: string) => output.push(message),
      stderr: (message: string) => output.push(message)
    }

    await runCli!(["--db", dbPath, "init"], io)
    await runCli!(["--db", dbPath, "company", "create", "Acme Corp"], io)
    await runCli!(["--db", dbPath, "project", "add", "openclaw", "--repo-path", TEMP_TEST_DIR], io)

    const zipPath = join(TEMP_TEST_DIR, "custom-diagnostics.zip")
    await runCli!(["--db", dbPath, "diagnostics", "openclaw", "--output", zipPath], io)

    expect(existsSync(zipPath)).toBe(true)

    if (existsSync(dbPath)) rmSync(dbPath)
  })

  it("triggers predictive rate limit routing circuit breaker", async () => {
    const dbPath = join(TEMP_TEST_DIR, "test-predictive.db")
    if (existsSync(dbPath)) rmSync(dbPath)

    const store = new DispatcherStore!(dbPath)
    store.migrate()
    try {
      const company = store.createCompany({ name: "Acme" })

      const samples = [
        { timestamp: Date.now() - 20000, remaining: 100 },
        { timestamp: Date.now() - 10000, remaining: 80 },
        { timestamp: Date.now(), remaining: 60 }
      ]
      store.upsertAdapterLaneHealth({
        companyId: company.id,
        adapterType: "gemini_local",
        laneKey: "pool",
        laneLabel: "gemini pool",
        status: "healthy",
        reason: "none",
        cooldownUntil: null,
        lastError: null,
        lastSuccessAt: new Date().toISOString(),
        lastCheckedAt: new Date().toISOString(),
        metadata: { samples }
      })

      const health = healthByAdapterForRouting!(store, company.id)

      expect(health.gemini_local.ok).toBe(false)
      expect(health.gemini_local.message).toContain("predictive rate limit circuit open")
    } finally {
      store.close()
      if (existsSync(dbPath)) rmSync(dbPath)
    }
  })
})
