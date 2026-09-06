import { mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import { HAS_NODE_SQLITE } from "./node-sqlite.js"

let aggregateDoctorReport: typeof import("../apps/dispatcher-cli/src/doctor.js").aggregateDoctorReport | null = null
let classifyDoctorFailure: typeof import("../apps/dispatcher-cli/src/doctor.js").classifyDoctorFailure | null = null
let renderDoctorSummary: typeof import("../apps/dispatcher-cli/src/doctor.js").renderDoctorSummary | null = null
type DoctorReport = import("../apps/dispatcher-cli/src/doctor.js").DoctorReport
let runCli: typeof import("../apps/dispatcher-cli/src/index.js").runCli | null = null
if (HAS_NODE_SQLITE) {
  ;({ aggregateDoctorReport, classifyDoctorFailure, renderDoctorSummary } = await import(
    "../apps/dispatcher-cli/src/doctor.js"
  ))
  ;({ runCli } = await import("../apps/dispatcher-cli/src/index.js"))
}

function createFakeCodexBinary(root: string): string {
  const scriptPath = join(root, "codex")
  writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const args = process.argv.slice(2);",
      "const prompt = fs.readFileSync(0, 'utf8');",
      "const outputIndex = args.indexOf('-o');",
      "const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : null;",
      "const sessionId = args.includes('resume') ? (args[args.length - 2] || 'codex-session-1') : 'codex-session-1';",
      "const stateFile = process.env.DOCTOR_FAKE_CODEX_STATE_FILE;",
      "let response = 'unexpected';",
      "const exactMatch = prompt.match(/Reply with exactly: (.+)$/m);",
      "if (prompt.includes('DOCTOR_OK') && exactMatch) response = exactMatch[1];",
      "else if (prompt.includes('READY') && exactMatch) {",
      "  response = exactMatch[1];",
      "  fs.writeFileSync(stateFile, response.replace(/^READY\\s+/, '') + '\\n', 'utf8');",
      "} else if (prompt.includes('What token were you asked to remember')) {",
      "  response = fs.existsSync(stateFile) ? fs.readFileSync(stateFile, 'utf8').trim() : 'MISSING';",
      "}",
      "if (outputPath) fs.writeFileSync(outputPath, response, 'utf8');",
      "process.stdout.write(JSON.stringify({ session_id: sessionId, response }) + '\\n');"
    ].join("\n"),
    { mode: 0o755 }
  )
  return scriptPath
}

function createFakeGeminiBinary(root: string): string {
  const scriptPath = join(root, "gemini")
  writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const args = process.argv.slice(2);",
      "const prompt = fs.readFileSync(0, 'utf8');",
      "const sessionId = args.includes('--resume') ? 'gemini-session-1' : 'gemini-session-1';",
      "const stateFile = process.env.DOCTOR_FAKE_GEMINI_STATE_FILE;",
      "let response = 'unexpected';",
      "const exactMatch = prompt.match(/Reply with exactly: (.+)$/m);",
      "if (prompt.includes('DOCTOR_OK') && exactMatch) response = exactMatch[1];",
      "else if (prompt.includes('READY') && exactMatch) {",
      "  response = exactMatch[1];",
      "  fs.writeFileSync(stateFile, response.replace(/^READY\\s+/, '') + '\\n', 'utf8');",
      "} else if (prompt.includes('What token were you asked to remember')) {",
      "  response = fs.existsSync(stateFile) ? fs.readFileSync(stateFile, 'utf8').trim() : 'MISSING';",
      "}",
      "process.stdout.write(JSON.stringify({ session_id: sessionId, response, stats: { totalTokenCount: 7 } }));"
    ].join("\n"),
    { mode: 0o755 }
  )
  return scriptPath
}

function buildBaselineReport(): Omit<DoctorReport, "exitCode" | "summary"> {
  return {
    version: 1,
    startedAt: "2026-04-11T00:00:00.000Z",
    finishedAt: "2026-04-11T00:00:01.000Z",
    repoPath: "/tmp/openclaw",
    syntheticRepo: true,
    lanes: [
      {
        id: "lane-1",
        label: "codex_local GPT-5.5",
        adapterType: "codex_local",
        requestedModel: "gpt-5.5",
        modelUsed: "gpt-5.5",
        provider: "codex",
        transportUsed: "cli/codex-exec",
        status: "pass",
        healthcheckOk: true,
        healthcheckMessage: "ok",
        healthcheckLatencyMs: 1,
        executionOk: true,
        sessionOk: true,
        latencyMs: 10,
        responsePreview: "ok",
        sessionDisplayId: "session-1",
        failure: null
      }
    ],
    syntheticChecks: [],
    moduleChecks: [],
    loopReadiness: null,
    wrapper: {
      repo: null,
      db: null,
      framework: null
    }
  }
}

const describeHelpers = HAS_NODE_SQLITE ? describe : describe.skip

describeHelpers("doctor helpers", () => {
  it("classifies auth, session, and transport failures", () => {
    expect(classifyDoctorFailure!({ stage: "healthcheck", message: "codex not found" })).toBe("binary_missing")
    expect(classifyDoctorFailure!({ stage: "execution", message: "No Azure Foundry API key configured." })).toBe(
      "auth_missing"
    )
    expect(classifyDoctorFailure!({ stage: "session", message: "no continuation state returned by adapter" })).toBe(
      "session_unavailable"
    )
    expect(classifyDoctorFailure!({ stage: "execution", message: "HTTP 502 upstream failure" })).toBe("transport_error")
    expect(
      classifyDoctorFailure!({
        stage: "execution",
        message: "Your workspace is out of credits. Add credits to continue."
      })
    ).toBe("quota_exhausted")
  })

  it("aggregates exit codes when a lane fails", () => {
    const report = aggregateDoctorReport!({
      ...buildBaselineReport(),
      lanes: [
        buildBaselineReport().lanes[0]!,
        {
          ...buildBaselineReport().lanes[0]!,
          id: "lane-2",
          status: "fail",
          failure: {
            class: "execution_failed",
            stage: "execution",
            message: "execution failed"
          }
        }
      ]
    })

    expect(report.summary).toEqual({
      passed: 1,
      failed: 1,
      total: 2
    })
    expect(report.exitCode).toBe(1)
  })

  it("renders wrapper metadata in the human summary", () => {
    const report = aggregateDoctorReport!({
      ...buildBaselineReport(),
      wrapper: {
        repo: "/repo",
        db: "/repo/.openclaw/dispatcher.db",
        framework: "embedded default"
      }
    })

    expect(renderDoctorSummary!(report).join("\n")).toContain("dispatcher wrapper: ok")
    expect(renderDoctorSummary!(report).join("\n")).toContain("/repo/.openclaw/dispatcher.db")
  })

  it("renders loop readiness audit in the human summary", () => {
    const report = aggregateDoctorReport!({
      ...buildBaselineReport(),
      loopReadiness: {
        repoPath: "/tmp/openclaw",
        score: 45,
        level: "L1",
        levelDescription: "Assisted Reporting (Read-Only triage, no unattended edits)",
        checks: [
          {
            name: "Loop Cadence Documentation (LOOP.md)",
            passed: true,
            pointsEarned: 15,
            pointsPossible: 15,
            notes: "LOOP.md file found."
          },
          {
            name: "Dispatcher Cron Jobs Configured",
            passed: false,
            pointsEarned: 0,
            pointsPossible: 10,
            notes: "No scheduled cron jobs found in the runtime store."
          }
        ],
        recommendations: ["- Configure dispatcher cron jobs to run automations periodically."]
      }
    })

    const output = renderDoctorSummary!(report).join("\n")
    expect(output).toContain("Loop Readiness:")
    expect(output).toContain("score: 45/100")
    expect(output).toContain("level: L1")
    expect(output).toContain("[PASS]  Loop Cadence Documentation")
    expect(output).toContain("[FAIL]  Dispatcher Cron Jobs")
    expect(output).toContain("Recommendations:")
    expect(output).toContain("Configure dispatcher cron jobs")
  })
})

const describeCli = HAS_NODE_SQLITE ? describe : describe.skip

describeCli("doctor CLI", () => {
  const envBackup = { ...process.env }

  afterEach(() => {
    vi.restoreAllMocks()
    for (const key of Object.keys(process.env)) {
      if (!(key in envBackup)) {
        delete process.env[key]
      }
    }
    Object.assign(process.env, envBackup)
  })

  it("produces a passing JSON report with fake local adapters and a mocked Foundry endpoint", async () => {
    const root = mkdtempSync(join(tmpdir(), "doctor-cli-"))
    createFakeCodexBinary(root)
    createFakeGeminiBinary(root)

    process.env.PATH = `${root}:${envBackup.PATH ?? ""}`
    process.env.OPENCLAW_DOCTOR_FAKE_LOCAL_ADAPTERS = "1"
    process.env.DOCTOR_FAKE_CODEX_STATE_FILE = join(root, "codex-state.txt")
    process.env.DOCTOR_FAKE_GEMINI_STATE_FILE = join(root, "gemini-state.txt")
    process.env.OPENCLAW_AZURE_FOUNDRY_ENDPOINTS = JSON.stringify([
      {
        name: "primary",
        projectUrl: "https://example.services.ai.azure.com/api/projects/demo",
        apiKeyEnv: "PRIMARY_KEY",
        models: ["Kimi-2.6", "gpt-5.4-mini"]
      }
    ])
    process.env.PRIMARY_KEY = "test-key"

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          messages?: Array<{ role?: string; content?: string }>
        }
        const userPrompt = body.messages?.find((message) => message.role === "user")?.content ?? ""
        const match = userPrompt.match(/Reply with exactly: (.+)$/m)
        const content = match ? match[1] : "unexpected"
        return new Response(
          JSON.stringify({
            choices: [{ message: { content } }],
            usage: { total_tokens: 3 }
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        )
      })
    )

    const output: string[] = []
    await runCli!(["doctor", "--json"], {
      stdout: (message: string) => output.push(message),
      stderr: (message: string) => output.push(message)
    })

    const report = JSON.parse(output.join("")) as DoctorReport
    expect(report.exitCode).toBe(0)
    expect(report.summary.failed).toBe(0)
    expect(report.summary.total).toBe(10)
    expect(report.lanes).toHaveLength(10)
    expect(report.lanes.every((lane) => lane.status === "pass")).toBe(true)
  }, 60_000)

  it("persists lane health checks and heals failing lanes using fallbacks", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "doctor-healing-")))
    createFakeCodexBinary(root)
    createFakeGeminiBinary(root)

    process.env.PATH = `${root}:${envBackup.PATH ?? ""}`
    process.env.OPENCLAW_DOCTOR_FAKE_LOCAL_ADAPTERS = "1"
    process.env.DOCTOR_FAKE_CODEX_STATE_FILE = join(root, "codex-state.txt")
    process.env.DOCTOR_FAKE_GEMINI_STATE_FILE = join(root, "gemini-state.txt")
    process.env.OPENCLAW_AZURE_FOUNDRY_ENDPOINTS = JSON.stringify([
      {
        name: "primary",
        projectUrl: "https://example.services.ai.azure.com/api/projects/demo",
        apiKeyEnv: "PRIMARY_KEY",
        models: ["Kimi-2.6", "gpt-5.4-mini"]
      }
    ])
    process.env.PRIMARY_KEY = "test-key"

    const dbPath = join(root, "doctor-test.db")
    const { DispatcherStore } = await import("@openclaw/db")
    const store = new DispatcherStore(dbPath)
    store.migrate()

    const company = store.createCompany({ name: "Doctor Healing Co" })
    const project = store.createProject({
      companyRef: company.id,
      name: "doctor-project",
      repoPath: root,
      verifyCommand: null
    })

    const agent = store.createAgent({
      companyRef: company.id,
      name: "foundry-agent",
      role: "Engineer",
      adapterType: "azure_foundry",
      model: "Kimi-K2.6"
    })

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          messages?: Array<{ role?: string; content?: string }>
          model?: string
        }
        if (body.model === "Kimi-K2.6") {
          return new Response(
            JSON.stringify({
              error: { message: "Model Kimi-K2.6 is temporarily down" }
            }),
            {
              status: 503,
              headers: { "content-type": "application/json" }
            }
          )
        }

        const userPrompt = body.messages?.find((message) => message.role === "user")?.content ?? ""
        const match = userPrompt.match(/Reply with exactly: (.+)$/m)
        const content = match ? match[1] : "unexpected"
        return new Response(
          JSON.stringify({
            choices: [{ message: { content } }],
            usage: { total_tokens: 3 }
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        )
      })
    )

    const output: string[] = []
    await runCli!(["--db", dbPath, "doctor", "--project", root, "--json"], {
      stdout: (message: string) => output.push(message),
      stderr: (message: string) => output.push(message)
    })

    const report = JSON.parse(output.join("")) as DoctorReport
    expect(report.exitCode).toBe(0)
    expect(report.summary.failed).toBe(0)

    const kimiLane = report.lanes.find((l) => l.id === "foundry-kimi")
    expect(kimiLane).toBeDefined()
    expect(kimiLane?.status).toBe("pass")
    expect(kimiLane?.healed).toBeDefined()
    expect(kimiLane?.healed?.workingModel).toBe("Kimi-2.6")

    const updatedAgent = store.getAgentById(agent.id)
    expect(updatedAgent.model).toBe("Kimi-2.6")

    const laneHealth = store.getAdapterLaneHealth(company.id, "azure_foundry", "doctor-lane-foundry-kimi")
    expect(laneHealth).toBeDefined()
    expect(laneHealth?.status).toBe("healthy")
    expect(laneHealth?.metadata).toMatchObject({
      model: "Kimi-2.6",
      healed: {
        originalModel: "Kimi-K2.6",
        workingModel: "Kimi-2.6"
      }
    })

    store.close()
  }, 60_000)
})
