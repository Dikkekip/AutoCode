import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { AdapterExecutionContext, Agent, Company, Project, Task } from "@openclaw/domain"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { codexLocalAdapter, isPristineOpenClawBootstrapFile } from "../packages/adapters/codex-local/src/index.js"
import { createTempWorkspace } from "./helpers.js"

function buildContext(
  root: string,
  command: string,
  options?: {
    extraEnv?: Record<string, string>
    sessionId?: string | null
    model?: string | null
    reasoningEffort?: "low" | "medium" | "high" | "xhigh"
  }
) {
  const company: Company = {
    id: "company-1",
    name: "OpenClaw",
    description: null,
    createdAt: "2026-04-03T08:00:00Z"
  }
  const project: Project = {
    id: "project-1",
    companyId: company.id,
    name: "demo",
    repoPath: root,
    verifyCommand: null,
    createdAt: "2026-04-03T08:00:00Z"
  }
  const task: Task = {
    id: "task-1",
    companyId: company.id,
    projectId: project.id,
    workflowId: null,
    parentTaskId: null,
    dependsOnTaskIds: [],
    personaId: null,
    stage: null,
    title: "Test task",
    description: "Run codex",
    labels: [],
    changedFiles: [],
    taskPackage: null,
    kind: "user",
    priority: 0,
    scheduledAt: null,
    source: "manual",
    status: "queued",
    assignedAgentId: null,
    requestedAdapterType: "codex_local",
    laneId: null,
    allowedPaths: [],
    requiredReading: [],
    verificationCommands: [],
    claimStatus: "unclaimed",
    claimToken: null,
    claimExpiresAt: null,
    claimOwnerRunId: null,
    claimOwnerAgentId: null,
    claimedAt: null,
    lineageRootId: null,
    lineageParentId: null,
    taskPackagePath: null,
    reviewHandoffPath: null,
    artifactDir: null,
    reviewRequired: false,
    approvalRequired: false,
    retryCount: 0,
    maxRetries: 0,
    lastError: null,
    blockedReason: null,
    lastRecoveryAt: null,
    lastRecoveryReason: null,
    createdAt: "2026-04-03T08:00:00Z",
    updatedAt: "2026-04-03T08:00:00Z",
    completedAt: null
  }
  const sessionId = options?.sessionId ?? "019f5b39-d9be-7491-bffd-611ef3845f58"
  const agent: Agent = {
    id: "agent-1",
    companyId: company.id,
    name: "codex-coder",
    role: "Software Engineer",
    adapterType: "codex_local",
    status: "idle",
    model: options?.model ?? "gpt-5.4-mini",
    instructionsPath: null,
    command,
    env: options?.extraEnv ?? {},
    heartbeatEnabled: true,
    heartbeatIntervalSec: 60,
    budgetLimit: null,
    budgetWindow: "monthly",
    lastHeartbeatAt: null,
    createdAt: "2026-04-03T08:00:00Z",
    updatedAt: "2026-04-03T08:00:00Z"
  }

  return {
    company,
    project,
    task,
    agent,
    prompt: "Fix the thing",
    runId: "run-1",
    wakeReason: "manual" as const,
    heartbeatJobId: null,
    triggeredAt: "2026-04-03T08:00:00Z",
    sessionKey: "agent-1:project-1:task-1",
    sessionState: sessionId
      ? {
          sessionKey: "agent-1:project-1:task-1",
          id: "agent-1:project-1:task-1",
          status: "active",
          companyId: company.id,
          projectId: project.id,
          taskId: task.id,
          agentId: agent.id,
          adapterType: "codex_local" as const,
          sessionDisplayId: sessionId,
          state: { sessionId, sessionName: "agent-1:project-1:task-1" },
          updatedAt: "2026-04-03T08:00:00Z"
        }
      : null,
    runtimeIdentity: {
      version: 1 as const,
      runtimeKey: "agent-1:project-1:task-1",
      executionKey: "run-1",
      companyId: company.id,
      projectId: project.id,
      projectName: project.name,
      repoPath: project.repoPath,
      taskId: task.id,
      taskKind: task.kind,
      taskTitle: task.title,
      workflowId: task.workflowId,
      laneId: task.laneId,
      agentId: agent.id,
      agentName: agent.name,
      adapterType: agent.adapterType,
      model: agent.model,
      routing: options?.reasoningEffort
        ? {
            selectedModel: agent.model,
            reasoningEffort: options.reasoningEffort,
            modelFamily: agent.model ?? "unknown",
            modelRoutingReason: "test routing policy",
            complexityScore: 0,
            importanceScore: 0,
            complexitySignals: [],
            importanceSignals: []
          }
        : undefined,
      wake: {
        reason: "manual" as const,
        heartbeatJobId: null,
        triggeredAt: "2026-04-03T08:00:00Z"
      },
      continuation: {
        sessionKey: "agent-1:project-1:task-1",
        sessionDisplayId: sessionId,
        retryCount: 0,
        attempt: 1,
        heartbeatEnabled: true,
        heartbeatIntervalSec: 60,
        supportsSessionResume: true,
        nativeContextManagement: "unknown" as const
      },
      scope: {
        allowedPaths: [],
        requiredReading: [],
        verificationCommands: []
      }
    },
    log: () => undefined
  } as AdapterExecutionContext
}

describe("codexLocalAdapter", () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    process.env = { ...originalEnv }
    process.env.OPENCLAW_CODEX_ACCOUNT_POOL_ENABLED = "false"
    process.env.OPENCLAW_CODEX_TRANSPORT = "direct"
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it("preserves customized OpenClaw bootstrap files", () => {
    const pristine = "# IDENTITY.md - Who Am I?\nFill this in during your first conversation\n"
    expect(isPristineOpenClawBootstrapFile("IDENTITY.md", pristine)).toBe(true)
    expect(isPristineOpenClawBootstrapFile("IDENTITY.md", `${pristine}- **Name:** LawyerRAG\n`)).toBe(false)
  })

  it.each([
    false,
    true
  ])("dispatches Astra persona work through a native session (fallback=%s)", async (unavailable) => {
    const workspace = createTempWorkspace("codex-openclaw-native-session")
    try {
      writeFileSync(
        join(workspace.repoPath, "IDENTITY.md"),
        "# IDENTITY.md - Who Am I?\nFill this in during your first conversation\n"
      )
      writeFileSync(
        join(workspace.repoPath, "SOUL.md"),
        [
          "# SOUL.md - Who You Are",
          "You're not a chatbot. You're becoming someone.",
          "Be genuinely helpful, not performatively helpful",
          "Have opinions",
          "Be resourceful before asking",
          "Earn trust through competence",
          "Remember you're a guest",
          "Private things stay private. Period.",
          "Each session, you wake up fresh"
        ].join("\n")
      )
      writeFileSync(
        join(workspace.repoPath, "USER.md"),
        "# USER.md - User Model\nStore stable user preferences and profile facts\n- Prefer ...\n"
      )
      const fakeOpenClawPath = join(workspace.root, "fake-openclaw.mjs")
      const invocationDumpPath = join(workspace.root, "openclaw-invocations.jsonl")
      writeFileSync(
        fakeOpenClawPath,
        [
          "#!/usr/bin/env node",
          'import { appendFileSync, readFileSync, writeFileSync } from "node:fs"',
          "const args = process.argv.slice(2)",
          `appendFileSync(${JSON.stringify(invocationDumpPath)}, JSON.stringify(args) + "\\n")`,
          'if (args[0] === "gateway") {',
          `  if (${unavailable} && JSON.parse(args.at(-1)).model === "openai/gpt-6-astra") { process.stderr.write("model not found"); process.exit(1) }`,
          '  writeFileSync("IDENTITY.md", "# IDENTITY.md - Who Am I?\\nFill this in during your first conversation\\n")',
          '  writeFileSync("SOUL.md", "# SOUL.md - Who You Are\\nYou\'re not a chatbot. You\'re becoming someone\\n")',
          '  writeFileSync("USER.md", "# USER.md - User Model\\nStore stable user preferences and profile facts\\n")',
          "  process.stdout.write(JSON.stringify({",
          "    ok: true,",
          '    key: "agent:prompt-engineer:dashboard:native-test",',
          '    sessionId: "019f5b39-d9be-7491-bffd-611ef3845f58",',
          "    runStarted: false",
          "  }))",
          "} else {",
          '  const promptIndex = args.indexOf("--message-file")',
          '  const prompt = promptIndex >= 0 ? readFileSync(args[promptIndex + 1], "utf8") : ""',
          '  const response = prompt.includes("Provider-availability preconditions for Gemini CLI") ? "native-result" : "Blocked: Gemini CLI unavailable"',
          "  process.stdout.write(JSON.stringify({",
          '    runId: "native-run-1",',
          '    status: "ok",',
          "    result: {",
          "      payloads: [{ text: response }],",
          "      meta: {",
          "        aborted: false,",
          `        agentMeta: { sessionId: "019f5b39-d9be-7491-bffd-611ef3845f58", provider: "openai", model: "${unavailable ? "gpt-5.6-sol" : "gpt-6-astra"}", usage: { input: 10, output: 2, total: 12 } }`,
          "      }",
          "    }",
          "  }))",
          "}"
        ].join("\n"),
        { mode: 0o755 }
      )
      const context = buildContext(workspace.repoPath, "unused", {
        model: "gpt-6-astra",
        reasoningEffort: "high",
        sessionId: null,
        extraEnv: {
          OPENCLAW_CODEX_TRANSPORT: "native",
          OPENCLAW_COMMAND: fakeOpenClawPath,
          OPENCLAW_NATIVE_RUN_TIMEOUT_MS: "1234"
        }
      })
      context.task.personaId = "f3846503-bac4-4ab1-9884-69097116c7d2"
      context.task.taskPackage = {
        personaProvenance: { personaId: "prompt-engineer" }
      } as NonNullable<typeof context.task.taskPackage>
      context.task.stage = "planner"

      const result = await codexLocalAdapter.execute(context)

      expect(result.ok).toBe(true)
      expect(result.response).toBe("native-result")
      expect(result.metadata).toMatchObject({
        adapterType: "codex_local",
        provider: "openai",
        model: unavailable ? "gpt-5.6-sol" : "gpt-6-astra",
        transport: "openclaw-native-session"
      })
      expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 2, totalTokens: 12 })
      expect(result.sessionState).toMatchObject({
        openclawSessionKey: "agent:prompt-engineer:dashboard:native-test",
        openclawAgentId: "prompt-engineer",
        openclawCwd: workspace.repoPath,
        openclawRunId: "native-run-1"
      })
      expect(existsSync(join(workspace.repoPath, "IDENTITY.md"))).toBe(false)
      expect(existsSync(join(workspace.repoPath, "SOUL.md"))).toBe(false)
      expect(existsSync(join(workspace.repoPath, "USER.md"))).toBe(false)
      const invocations = readFileSync(invocationDumpPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[])
      expect(invocations).toHaveLength(unavailable ? 3 : 2)
      if (unavailable) {
        expect(JSON.parse(invocations.shift()?.at(-1) ?? "{}").model).toBe("openai/gpt-6-astra")
        expect(result.runtimeIdentity?.model).toBe("gpt-5.6-sol")
      }
      expect(invocations[0]?.slice(0, 3)).toEqual(["gateway", "call", "sessions.create"])
      const createParams = JSON.parse(invocations[0]?.at(-1) ?? "{}")
      expect(createParams.model).toBe(unavailable ? "openai/gpt-5.6-sol" : "openai/gpt-6-astra")
      expect(createParams.thinkingLevel).toBe("high")
      expect(createParams.label).toMatch(/^dispatcher-task-1-prompt-engineer-[a-f0-9]{8}$/)
      expect(invocations[1]).toEqual(
        expect.arrayContaining([
          "agent",
          "--agent",
          "prompt-engineer",
          "--session-key",
          "agent:prompt-engineer:dashboard:native-test",
          "--message-file"
        ])
      )
      expect(invocations[1]).toEqual(expect.arrayContaining(["--timeout", "2"]))
      expect(invocations[1]).toEqual(expect.arrayContaining(["--model", createParams.model, "--thinking", "high"]))
      expect(invocations[1]).not.toContain("codex")
    } finally {
      workspace.cleanup()
    }
  })

  it("reports Codex unhealthy while every eligible isolated account slot is quarantined", async () => {
    const workspace = createTempWorkspace("codex-healthcheck-quarantined-pool")
    try {
      const codexDir = join(workspace.root, "codex")
      const accountsDir = join(codexDir, "accounts")
      const poolRoot = join(codexDir, "openclaw-account-homes")
      const fakeCodexPath = join(workspace.root, "fake-codex")
      const accountKey = "healthy-account"
      const encodedKey = Buffer.from(accountKey, "utf8").toString("base64url")
      const accountAuthPath = join(accountsDir, `${encodedKey}.auth.json`)
      const accountSlot = createHash("sha256").update(accountKey).digest("hex").slice(0, 16)
      const quarantineDir = join(poolRoot, `slot-${accountSlot}`)

      mkdirSync(accountsDir, { recursive: true })
      mkdirSync(quarantineDir, { recursive: true })
      writeFileSync(fakeCodexPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
      writeFileSync(
        join(accountsDir, "registry.json"),
        JSON.stringify({
          active_account_key: accountKey,
          accounts: [{ account_key: accountKey, last_usage: { primary: { used_percent: 10 } } }]
        }),
        "utf8"
      )
      writeFileSync(accountAuthPath, JSON.stringify({ marker: "healthy" }), "utf8")
      const authStat = statSync(accountAuthPath)
      writeFileSync(
        join(quarantineDir, ".openclaw-auth-quarantine.json"),
        JSON.stringify({
          failureCategory: "quota",
          quarantinedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          sourceFingerprint: `${authStat.size}:${authStat.mtimeMs}`
        }),
        "utf8"
      )

      const context = buildContext(workspace.repoPath, fakeCodexPath, {
        extraEnv: {
          OPENCLAW_CODEX_ACCOUNT_POOL_ENABLED: "true",
          OPENCLAW_CODEX_DIR: codexDir,
          OPENCLAW_CODEX_ACCOUNTS_DIR: accountsDir,
          OPENCLAW_CODEX_ACCOUNT_HOMES_DIR: poolRoot
        }
      })

      const result = await codexLocalAdapter.healthcheck(context.agent)

      expect(result).toEqual({
        ok: false,
        message: "all 1 eligible isolated Codex account slots are quarantined"
      })
    } finally {
      workspace.cleanup()
    }
  })

  it("does not leak the host account pool into a custom Codex-compatible command", async () => {
    const workspace = createTempWorkspace("codex-custom-command-isolation")
    try {
      const codexDir = join(workspace.root, "codex")
      const accountsDir = join(codexDir, "accounts")
      const observedPath = join(workspace.root, "observed-slot.txt")
      const fakeCodexPath = join(workspace.root, "fake-codex.py")
      const accountKey = "host-account"
      const encodedKey = Buffer.from(accountKey, "utf8").toString("base64url")
      mkdirSync(accountsDir, { recursive: true })
      writeFileSync(
        join(accountsDir, "registry.json"),
        JSON.stringify({
          active_account_key: accountKey,
          accounts: [{ account_key: accountKey, last_usage: { primary: { used_percent: 1 } } }]
        }),
        "utf8"
      )
      writeFileSync(join(accountsDir, `${encodedKey}.auth.json`), JSON.stringify({ marker: "host" }), "utf8")
      writeFileSync(
        fakeCodexPath,
        [
          "#!/usr/bin/env python3",
          "from pathlib import Path",
          "import json",
          "import os",
          `Path(${JSON.stringify(observedPath)}).write_text(os.environ.get('OPENCLAW_CODEX_ACCOUNT_SLOT', ''), encoding='utf8')`,
          "print(json.dumps({'sessionId': 'custom-session', 'response': 'custom command completed'}))"
        ].join("\n"),
        { mode: 0o755 }
      )
      process.env.OPENCLAW_CODEX_ACCOUNT_POOL_ENABLED = "true"
      process.env.OPENCLAW_CODEX_DIR = codexDir
      process.env.OPENCLAW_CODEX_ACCOUNTS_DIR = accountsDir

      const result = await codexLocalAdapter.execute(buildContext(workspace.repoPath, fakeCodexPath))

      expect(result.ok).toBe(true)
      expect(readFileSync(observedPath, "utf8")).toBe("")
    } finally {
      workspace.cleanup()
    }
  })

  it.each([
    ["quota exhaustion", "Your workspace is out of credits. Add credits to continue.", "quota"],
    [
      "refresh-token failure",
      "Failed to refresh token: refresh_token_reused. Your access token could not be refreshed. Please log in again.",
      "auth"
    ]
  ])("isolates healthy Codex accounts and advances slots after %s", async (_label, failureMessage, quarantineCategory) => {
    const workspace = createTempWorkspace("codex-isolated-account-pool")
    try {
      const codexDir = join(workspace.root, "codex")
      const accountsDir = join(codexDir, "accounts")
      const observedPath = join(workspace.root, "observed-accounts.ndjson")
      const fakeCodexPath = join(workspace.root, "fake-codex.py")
      mkdirSync(accountsDir, { recursive: true })
      writeFileSync(join(codexDir, "config.toml"), 'model = "gpt-5.6-sol"\n', "utf8")

      const accounts = [
        { key: "blocked-key", marker: "blocked", weekly: 100 },
        { key: "healthy-key-a", marker: "healthy-a", weekly: 10 },
        { key: "healthy-key-b", marker: "healthy-b", weekly: 20 }
      ]
      writeFileSync(
        join(accountsDir, "registry.json"),
        JSON.stringify({
          active_account_key: "blocked-key",
          accounts: accounts.map((account) => ({
            account_key: account.key,
            account_name: account.marker,
            last_usage: {
              primary: { used_percent: 1 },
              secondary: { used_percent: account.weekly }
            }
          }))
        }),
        "utf8"
      )
      for (const account of accounts) {
        const encodedKey = Buffer.from(account.key, "utf8").toString("base64url")
        writeFileSync(join(accountsDir, `${encodedKey}.auth.json`), JSON.stringify({ marker: account.marker }), "utf8")
      }

      writeFileSync(
        fakeCodexPath,
        [
          "#!/usr/bin/env python3",
          "from pathlib import Path",
          "import json",
          "import os",
          `observed = Path(${JSON.stringify(observedPath)})`,
          "codex_home = Path(os.environ['CODEX_HOME'])",
          "auth = json.loads((codex_home / 'auth.json').read_text(encoding='utf8'))",
          "prior = observed.read_text(encoding='utf8').splitlines() if observed.exists() else []",
          "with observed.open('a', encoding='utf8') as handle:",
          "    handle.write(json.dumps({'home': str(codex_home), 'marker': auth['marker'], 'slot': os.environ.get('OPENCLAW_CODEX_ACCOUNT_SLOT')}) + '\\n')",
          "if not prior:",
          `    print(${JSON.stringify(failureMessage)})`,
          "    raise SystemExit(1)",
          "print(json.dumps({'sessionId': 'isolated-session', 'response': 'isolated account completed'}))"
        ].join("\n"),
        { mode: 0o755 }
      )

      const result = await codexLocalAdapter.execute(
        buildContext(workspace.repoPath, fakeCodexPath, {
          sessionId: null,
          extraEnv: {
            OPENCLAW_CODEX_DIR: codexDir,
            OPENCLAW_CODEX_ACCOUNTS_DIR: accountsDir,
            OPENCLAW_CODEX_ACCOUNT_POOL_ENABLED: "true"
          }
        })
      )

      expect(result.ok).toBe(true)
      const observed = readFileSync(observedPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)) as Array<{
        home: string
        marker: string
        slot: string
      }>
      expect(observed).toHaveLength(2)
      expect(new Set(observed.map((entry) => entry.marker))).toEqual(new Set(["healthy-a", "healthy-b"]))
      expect(observed.every((entry) => entry.home.includes("openclaw-account-homes/slot-"))).toBe(true)
      expect(observed.every((entry) => /^[a-f0-9]{16}$/.test(entry.slot))).toBe(true)
      expect(observed.every((entry) => existsSync(join(entry.home, "config.toml")))).toBe(true)

      const quarantineFilename = ".openclaw-auth-quarantine.json"
      const quarantinePath = join(observed[0]!.home, quarantineFilename)
      expect(existsSync(quarantinePath)).toBe(true)
      expect(JSON.parse(readFileSync(quarantinePath, "utf8"))).toMatchObject({
        failureCategory: quarantineCategory
      })
      expect(existsSync(join(observed[1]!.home, quarantineFilename))).toBe(false)

      if (quarantineCategory) {
        const repeatedResult = await codexLocalAdapter.execute(
          buildContext(workspace.repoPath, fakeCodexPath, {
            sessionId: null,
            extraEnv: {
              OPENCLAW_CODEX_DIR: codexDir,
              OPENCLAW_CODEX_ACCOUNTS_DIR: accountsDir,
              OPENCLAW_CODEX_ACCOUNT_POOL_ENABLED: "true"
            }
          })
        )
        expect(repeatedResult.ok).toBe(true)

        const repeatedObserved = readFileSync(observedPath, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)) as Array<{ home: string; marker: string; slot: string }>
        expect(repeatedObserved.map((entry) => entry.marker)).toEqual([
          observed[0]!.marker,
          observed[1]!.marker,
          observed[1]!.marker
        ])

        const quarantinedAccount = accounts.find((account) => account.marker === observed[0]!.marker)!
        const encodedKey = Buffer.from(quarantinedAccount.key, "utf8").toString("base64url")
        const refreshedAuthPath = join(accountsDir, `${encodedKey}.auth.json`)
        const refreshedMarker = `${quarantinedAccount.marker}-refreshed`
        writeFileSync(refreshedAuthPath, JSON.stringify({ marker: refreshedMarker }), "utf8")
        const refreshedAt = new Date(Date.now() + 1_000)
        utimesSync(refreshedAuthPath, refreshedAt, refreshedAt)

        const refreshedResult = await codexLocalAdapter.execute(
          buildContext(workspace.repoPath, fakeCodexPath, {
            sessionId: null,
            extraEnv: {
              OPENCLAW_CODEX_DIR: codexDir,
              OPENCLAW_CODEX_ACCOUNTS_DIR: accountsDir,
              OPENCLAW_CODEX_ACCOUNT_POOL_ENABLED: "true"
            }
          })
        )
        expect(refreshedResult.ok).toBe(true)
        const refreshedObserved = readFileSync(observedPath, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)) as Array<{ home: string; marker: string; slot: string }>
        expect(refreshedObserved.at(-1)?.marker).toBe(refreshedMarker)
        expect(existsSync(join(observed[0]!.home, quarantineFilename))).toBe(false)
      }
    } finally {
      workspace.cleanup()
    }
  })

  it("does not fall back to the legacy switcher after a configured isolated pool is exhausted", async () => {
    const workspace = createTempWorkspace("codex-isolated-pool-exhausted")
    try {
      const codexDir = join(workspace.root, "codex")
      const accountsDir = join(codexDir, "accounts")
      const fakeCodexPath = join(workspace.root, "fake-codex.py")
      const fakeSwitcherPath = join(workspace.root, "fake-switcher.py")
      const switchLogPath = join(workspace.root, "legacy-switcher.log")
      const accountKey = "only-account"
      const encodedKey = Buffer.from(accountKey, "utf8").toString("base64url")
      mkdirSync(accountsDir, { recursive: true })
      writeFileSync(
        join(accountsDir, "registry.json"),
        JSON.stringify({
          active_account_key: accountKey,
          accounts: [
            {
              account_key: accountKey,
              account_name: "only",
              last_usage: {
                primary: { used_percent: 1 },
                secondary: { used_percent: 10 }
              }
            }
          ]
        }),
        "utf8"
      )
      writeFileSync(join(accountsDir, `${encodedKey}.auth.json`), JSON.stringify({ marker: "only" }), "utf8")
      writeFileSync(
        fakeCodexPath,
        [
          "#!/usr/bin/env python3",
          "print('Failed to refresh token: refresh_token_reused. Your access token could not be refreshed. Please log in again.')",
          "raise SystemExit(1)"
        ].join("\n"),
        { mode: 0o755 }
      )
      writeFileSync(
        fakeSwitcherPath,
        [
          "#!/usr/bin/env python3",
          "from pathlib import Path",
          `Path(${JSON.stringify(switchLogPath)}).write_text('invoked', encoding='utf8')`,
          'print(\'{"active": "only", "accounts": ["only"]}\')'
        ].join("\n"),
        { mode: 0o755 }
      )

      const context = buildContext(workspace.repoPath, fakeCodexPath, {
        sessionId: null,
        extraEnv: {
          CODEX_ACCOUNT_SWITCHER_SCRIPT: fakeSwitcherPath,
          OPENCLAW_CODEX_DIR: codexDir,
          OPENCLAW_CODEX_ACCOUNTS_DIR: accountsDir,
          OPENCLAW_CODEX_ACCOUNT_POOL_ENABLED: "true"
        }
      })
      const messages: string[] = []
      context.log = (_level, message) => messages.push(message)
      const result = await codexLocalAdapter.execute(context)

      expect(result.ok).toBe(false)
      expect(
        messages,
        JSON.stringify({ messages, error: result.error, failureCategory: result.failureCategory })
      ).toContain("Skipped legacy account switch after the isolated Codex pool was exhausted")
      expect(existsSync(switchLogPath)).toBe(false)

      const repeatedResult = await codexLocalAdapter.execute(context)
      expect(repeatedResult.ok).toBe(false)
      expect(repeatedResult.failureCategory).toBe("quota")
      expect(repeatedResult.error).toContain("isolated Codex account slots are temporarily quarantined")
      expect(messages).toContain("All isolated Codex account slots are quarantined")
      expect(existsSync(switchLogPath)).toBe(false)
    } finally {
      workspace.cleanup()
    }
  })

  it("refreshes account auth snapshots without multiplying pooled homes", async () => {
    const workspace = createTempWorkspace("codex-refreshed-account-pool")
    try {
      const codexDir = join(workspace.root, "codex")
      const accountsDir = join(codexDir, "accounts")
      const observedPath = join(workspace.root, "observed-task-accounts.ndjson")
      const fakeCodexPath = join(workspace.root, "fake-codex.py")
      const accountKey = "healthy-key"
      const encodedKey = Buffer.from(accountKey, "utf8").toString("base64url")
      const accountAuthPath = join(accountsDir, `${encodedKey}.auth.json`)
      mkdirSync(accountsDir, { recursive: true })
      writeFileSync(
        join(accountsDir, "registry.json"),
        JSON.stringify({
          active_account_key: accountKey,
          accounts: [
            {
              account_key: accountKey,
              account_name: "healthy",
              last_usage: {
                primary: { used_percent: 1 },
                secondary: { used_percent: 10 }
              }
            }
          ]
        }),
        "utf8"
      )
      writeFileSync(accountAuthPath, JSON.stringify({ marker: "first" }), "utf8")
      writeFileSync(
        fakeCodexPath,
        [
          "#!/usr/bin/env python3",
          "from pathlib import Path",
          "import json",
          "import os",
          `observed = Path(${JSON.stringify(observedPath)})`,
          "codex_home = Path(os.environ['CODEX_HOME'])",
          "auth = json.loads((codex_home / 'auth.json').read_text(encoding='utf8'))",
          "with observed.open('a', encoding='utf8') as handle:",
          "    handle.write(json.dumps({'home': str(codex_home), 'marker': auth['marker']}) + '\\n')",
          "print(json.dumps({'sessionId': 'isolated-session', 'response': 'ok'}))"
        ].join("\n"),
        { mode: 0o755 }
      )

      const firstContext = buildContext(workspace.repoPath, fakeCodexPath, {
        sessionId: null,
        extraEnv: {
          OPENCLAW_CODEX_DIR: codexDir,
          OPENCLAW_CODEX_ACCOUNTS_DIR: accountsDir,
          OPENCLAW_CODEX_ACCOUNT_POOL_ENABLED: "true"
        }
      })
      expect((await codexLocalAdapter.execute(firstContext)).ok).toBe(true)

      writeFileSync(accountAuthPath, JSON.stringify({ marker: "second" }), "utf8")
      const refreshedAt = new Date(Date.now() + 1_000)
      utimesSync(accountAuthPath, refreshedAt, refreshedAt)
      expect((await codexLocalAdapter.execute(firstContext)).ok).toBe(true)

      const secondContext = buildContext(workspace.repoPath, fakeCodexPath, {
        sessionId: null,
        extraEnv: {
          OPENCLAW_CODEX_DIR: codexDir,
          OPENCLAW_CODEX_ACCOUNTS_DIR: accountsDir,
          OPENCLAW_CODEX_ACCOUNT_POOL_ENABLED: "true"
        }
      })
      secondContext.task.id = "task-2"
      secondContext.runtimeIdentity.taskId = "task-2"
      expect((await codexLocalAdapter.execute(secondContext)).ok).toBe(true)

      const observed = readFileSync(observedPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)) as Array<{ home: string; marker: string }>
      expect(observed.map((entry) => entry.marker)).toEqual(["first", "second", "second"])
      expect(new Set(observed.map((entry) => entry.home))).toHaveLength(1)
      expect(observed[0]?.home).toBe(observed[1]?.home)
      expect(observed[1]?.home).toBe(observed[2]?.home)
      expect(observed.every((entry) => /slot-[a-f0-9]{16}$/.test(entry.home))).toBe(true)
    } finally {
      workspace.cleanup()
    }
  })

  it("serializes concurrent invocations assigned to the same isolated account slot", async () => {
    const workspace = createTempWorkspace("codex-account-slot-lease")
    try {
      const codexDir = join(workspace.root, "codex")
      const accountsDir = join(codexDir, "accounts")
      const overlapPath = join(workspace.root, "overlap.txt")
      const lockPath = join(workspace.root, "active-slot.lock")
      const fakeCodexPath = join(workspace.root, "fake-codex.py")
      const accountKey = "only-healthy-account"
      const encodedKey = Buffer.from(accountKey, "utf8").toString("base64url")
      mkdirSync(accountsDir, { recursive: true })
      writeFileSync(
        join(accountsDir, "registry.json"),
        JSON.stringify({
          active_account_key: accountKey,
          accounts: [
            {
              account_key: accountKey,
              account_name: "healthy",
              last_usage: {
                primary: { used_percent: 1 },
                secondary: { used_percent: 10 }
              }
            }
          ]
        }),
        "utf8"
      )
      writeFileSync(join(accountsDir, `${encodedKey}.auth.json`), JSON.stringify({ marker: "healthy" }), "utf8")
      writeFileSync(
        fakeCodexPath,
        [
          "#!/usr/bin/env python3",
          "from pathlib import Path",
          "import json",
          "import os",
          "import time",
          `lock = Path(${JSON.stringify(lockPath)})`,
          `overlap = Path(${JSON.stringify(overlapPath)})`,
          "try:",
          "    descriptor = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)",
          "except FileExistsError:",
          "    overlap.write_text('overlap', encoding='utf8')",
          "    raise SystemExit(2)",
          "os.close(descriptor)",
          "try:",
          "    time.sleep(0.2)",
          "    print(json.dumps({'sessionId': 'isolated-session', 'response': 'ok'}))",
          "finally:",
          "    lock.unlink(missing_ok=True)"
        ].join("\n"),
        { mode: 0o755 }
      )

      const extraEnv = {
        OPENCLAW_CODEX_DIR: codexDir,
        OPENCLAW_CODEX_ACCOUNTS_DIR: accountsDir,
        OPENCLAW_CODEX_ACCOUNT_POOL_ENABLED: "true"
      }
      const firstContext = buildContext(workspace.repoPath, fakeCodexPath, {
        sessionId: null,
        extraEnv
      })
      const secondContext = buildContext(workspace.repoPath, fakeCodexPath, {
        sessionId: null,
        extraEnv
      })
      secondContext.task.id = "task-2"
      secondContext.runtimeIdentity.taskId = "task-2"
      secondContext.runId = "run-2"
      secondContext.runtimeIdentity.executionKey = "run-2"

      const [firstResult, secondResult] = await Promise.all([
        codexLocalAdapter.execute(firstContext),
        codexLocalAdapter.execute(secondContext)
      ])

      expect(firstResult.ok).toBe(true)
      expect(secondResult.ok).toBe(true)
      expect(existsSync(overlapPath)).toBe(false)
    } finally {
      workspace.cleanup()
    }
  })

  it("handles automatic account switching when quota is exhausted via ACPX", async () => {
    const workspace = createTempWorkspace("codex-account-auto-switch")
    try {
      const callCountPath = join(workspace.root, "codex-count.txt")
      const switchLogPath = join(workspace.root, "codex-switch.log")
      const fakeAcpxPath = join(workspace.root, "fake-acpx.py")
      const fakeSwitcherPath = join(workspace.root, "fake-switcher.py")

      writeFileSync(
        fakeAcpxPath,
        [
          "#!/usr/bin/env python3",
          "from pathlib import Path",
          "import json",
          "import sys",
          `count_path = Path(${JSON.stringify(callCountPath)})`,
          "count = int(count_path.read_text() or '0') if count_path.exists() else 0",
          "argv = sys.argv[1:]",
          "if 'sessions' in argv and 'ensure' in argv:",
          "    print(json.dumps({'action': 'session_ensured', 'created': True, 'acpxSessionId': 'codex-session-ensured'}))",
          "    raise SystemExit(0)",
          "elif 'sessions' in argv and 'close' in argv:",
          "    print(json.dumps({'action': 'session_closed'}))",
          "    raise SystemExit(0)",
          "elif 'set-mode' in argv:",
          "    print(json.dumps({'action': 'mode_set'}))",
          "    raise SystemExit(0)",
          "else:",
          "    # Treat anything else as execution (prompt in stdin)",
          "    count += 1",
          "    count_path.write_text(str(count), encoding='utf8')",
          "    if count < 3:",
          "        msg = 'OpenAI usage limit reached for this account'",
          "        print(json.dumps({'jsonrpc': '2.0', 'id': None, 'error': {'message': msg}}))",
          "        print(msg, file=sys.stderr)",
          "        raise SystemExit(1)",
          "    print(json.dumps({'sessionId': 'codex-session-3', 'response': 'codex completed on account three'}))",
          "    raise SystemExit(0)"
        ].join("\n"),

        { mode: 0o755 }
      )

      writeFileSync(
        fakeSwitcherPath,
        [
          "#!/usr/bin/env python3",
          "from pathlib import Path",
          "import json",
          "import sys",
          `log_path = Path(${JSON.stringify(switchLogPath)})`,
          "with log_path.open('a', encoding='utf8') as f:",
          "    f.write(' '.join(sys.argv[1:]) + '\\n')",
          "if 'list' in sys.argv:",
          "    print(json.dumps({'active': 'primary', 'accounts': ['primary', 'backup-1', 'backup-2']}))",
          "elif 'auto' in sys.argv:",
          "    print(json.dumps({'switched_to': 'new-account'}))"
        ].join("\n"),
        { mode: 0o755 }
      )

      const result = await codexLocalAdapter.execute(
        buildContext(workspace.repoPath, fakeAcpxPath, {
          extraEnv: { CODEX_ACCOUNT_SWITCHER_SCRIPT: fakeSwitcherPath }
        })
      )

      expect(result.ok).toBe(true)
      expect(result.response).toContain("account three")

      const switchInvocations = readFileSync(switchLogPath, "utf8").trim().split("\n")
      expect(switchInvocations[0]).toBe("list --json")
      expect(switchInvocations[1]).toContain("auto --json --exclude primary")
      expect(switchInvocations[2]).toContain("auto --json --exclude primary --exclude new-account")
    } finally {
      workspace.cleanup()
    }
  })

  it("uses codex-auth registry and switch command for quota fallback", async () => {
    const workspace = createTempWorkspace("codex-auth-account-switch")
    try {
      const callCountPath = join(workspace.root, "codex-count.txt")
      const switchLogPath = join(workspace.root, "codex-auth.log")
      const accountsDir = join(workspace.root, "codex", "accounts")
      const fakeAcpxPath = join(workspace.root, "fake-acpx.py")
      const fakeCodexAuthPath = join(workspace.root, "codex-auth")
      const registryPath = join(accountsDir, "registry.json")
      mkdirSync(accountsDir, { recursive: true })
      process.env.OPENCLAW_CODEX_ACCOUNTS_DIR = accountsDir

      writeFileSync(
        registryPath,
        JSON.stringify(
          {
            active_account_key: "primary-key",
            accounts: [
              {
                account_key: "primary-key",
                email: "primary@example.test",
                last_usage: {
                  primary: { used_percent: 100, resets_at: 9999999999 },
                  secondary: { used_percent: 100, resets_at: 9999999999 }
                },
                last_usage_at: Math.floor(Date.now() / 1000)
              },
              {
                account_key: "backup-key",
                account_name: "backup",
                last_usage: {
                  primary: { used_percent: 12, resets_at: 9999999999 },
                  secondary: { used_percent: 20, resets_at: 9999999999 }
                },
                last_usage_at: Math.floor(Date.now() / 1000)
              }
            ]
          },
          null,
          2
        ),
        "utf8"
      )

      writeFileSync(
        fakeAcpxPath,
        [
          "#!/usr/bin/env python3",
          "from pathlib import Path",
          "import json",
          "import sys",
          `count_path = Path(${JSON.stringify(callCountPath)})`,
          "count = int(count_path.read_text() or '0') if count_path.exists() else 0",
          "argv = sys.argv[1:]",
          "if 'sessions' in argv and 'ensure' in argv:",
          "    print(json.dumps({'action': 'session_ensured', 'created': True, 'acpxSessionId': 'codex-session-ensured'}))",
          "    raise SystemExit(0)",
          "elif 'sessions' in argv and 'close' in argv:",
          "    print(json.dumps({'action': 'session_closed'}))",
          "    raise SystemExit(0)",
          "elif 'set-mode' in argv:",
          "    print(json.dumps({'action': 'mode_set'}))",
          "    raise SystemExit(0)",
          "count += 1",
          "count_path.write_text(str(count), encoding='utf8')",
          "if count == 1:",
          "    msg = 'OpenAI usage limit reached for this account'",
          "    print(json.dumps({'jsonrpc': '2.0', 'id': None, 'error': {'message': msg}}))",
          "    print(msg, file=sys.stderr)",
          "    raise SystemExit(1)",
          "print(json.dumps({'sessionId': 'codex-session-2', 'response': 'codex completed on backup'}))"
        ].join("\n"),
        { mode: 0o755 }
      )

      writeFileSync(
        fakeCodexAuthPath,
        [
          "#!/usr/bin/env python3",
          "from pathlib import Path",
          "import json",
          "import os",
          "import sys",
          `log_path = Path(${JSON.stringify(switchLogPath)})`,
          "accounts_dir = Path(os.environ['OPENCLAW_CODEX_ACCOUNTS_DIR'])",
          "registry_path = accounts_dir / 'registry.json'",
          "with log_path.open('a', encoding='utf8') as f:",
          "    f.write(' '.join(sys.argv[1:]) + '\\n')",
          "if sys.argv[1:2] == ['switch']:",
          "    registry = json.loads(registry_path.read_text(encoding='utf8'))",
          "    registry['active_account_key'] = sys.argv[2]",
          "    registry_path.write_text(json.dumps(registry), encoding='utf8')",
          "elif sys.argv[1:2] == ['list']:",
          "    print('fake list')"
        ].join("\n"),
        { mode: 0o755 }
      )

      const result = await codexLocalAdapter.execute(
        buildContext(workspace.repoPath, fakeAcpxPath, {
          extraEnv: { CODEX_ACCOUNT_SWITCHER_SCRIPT: fakeCodexAuthPath }
        })
      )

      expect(result.ok).toBe(true)
      expect(result.response).toContain("backup")
      const switchInvocations = readFileSync(switchLogPath, "utf8").trim().split("\n")
      expect(switchInvocations[0]).toBe("list --skip-api")
      expect(switchInvocations[1]).toBe("switch backup-key")
    } finally {
      workspace.cleanup()
    }
  })

  it("falls back from Codex GPT-5.5 to lower-tier models when model quota is exhausted", async () => {
    const workspace = createTempWorkspace("codex-model-fallback")
    try {
      const codexLogPath = join(workspace.root, "codex-models.log")
      const fakeAcpxPath = join(workspace.root, "fake-acpx.py")

      writeFileSync(
        fakeAcpxPath,
        [
          "#!/usr/bin/env python3",
          "from pathlib import Path",
          "import json",
          "import sys",
          `log_path = Path(${JSON.stringify(codexLogPath)})`,
          "argv = sys.argv[1:]",
          "if 'sessions' in argv and 'ensure' in argv:",
          "    print(json.dumps({'action': 'session_ensured', 'created': True, 'acpxSessionId': 'codex-session-ensured'}))",
          "    raise SystemExit(0)",
          "elif 'sessions' in argv and 'close' in argv:",
          "    print(json.dumps({'action': 'session_closed'}))",
          "    raise SystemExit(0)",
          "elif 'set-mode' in argv:",
          "    print(json.dumps({'action': 'mode_set'}))",
          "    raise SystemExit(0)",
          "model = 'unknown'",
          "if '-m' in argv:",
          "    model = argv[argv.index('-m') + 1]",
          "with log_path.open('a', encoding='utf8') as f:",
          "    f.write(model + '\\n')",
          "if model in {'gpt-5.5', 'gpt-5.4'}:",
          "    msg = f'OpenAI usage limit reached for model {model}'",
          "    print(json.dumps({'jsonrpc': '2.0', 'id': None, 'error': {'message': msg}}))",
          "    print(msg, file=sys.stderr)",
          "    raise SystemExit(1)",
          "print(json.dumps({'sessionId': 'codex-session-mini', 'response': 'completed on mini fallback'}))",
          "raise SystemExit(0)"
        ].join("\n"),
        { mode: 0o755 }
      )

      const result = await codexLocalAdapter.execute(
        buildContext(workspace.repoPath, fakeAcpxPath, {
          model: "gpt-5.5",
          reasoningEffort: "high"
        })
      )

      expect(result.ok).toBe(true)
      expect(result.response).toContain("mini fallback")
      expect(result.metadata?.model).toBe("gpt-5.4-mini")
      expect(result.runtimeIdentity?.model).toBe("gpt-5.4-mini")
      expect(readFileSync(codexLogPath, "utf8").trim().split("\n")).toEqual(["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"])
    } finally {
      workspace.cleanup()
    }
  })

  it("does not invoke account switching for non-quota failures", async () => {
    const workspace = createTempWorkspace("codex-acpx-no-switch")
    try {
      const switchFlagPath = join(workspace.root, "account-switched")
      const fakeAcpxPath = join(workspace.root, "fake-acpx.py")
      const fakeSwitcherPath = join(workspace.root, "fake-switcher.py")

      writeFileSync(
        fakeAcpxPath,
        [
          "#!/usr/bin/env python3",
          "import json, sys",
          "argv = sys.argv[1:]",
          "if 'sessions' in argv and 'ensure' in argv:",
          "    print(json.dumps({'action': 'session_ensured', 'created': True, 'acpxSessionId': 'codex-session-ensured'}))",
          "    raise SystemExit(0)",
          "elif 'set-mode' in argv:",
          "    print(json.dumps({'action': 'mode_set'}))",
          "    raise SystemExit(0)",
          "else:",
          "    # Treat anything else as execution (prompt in stdin)",
          "    print(json.dumps({'jsonrpc': '2.0', 'id': None, 'error': {'message': 'syntax error in generated patch'}}))",
          "    print('syntax error in generated patch', file=sys.stderr)",
          "    raise SystemExit(1)"
        ].join("\n"),

        { mode: 0o755 }
      )

      writeFileSync(
        fakeSwitcherPath,
        [
          "#!/usr/bin/env python3",
          "from pathlib import Path",
          "import json, os, sys",
          `Path(${JSON.stringify(switchFlagPath)}).write_text('ok', encoding='utf8')`
        ].join("\n"),
        { mode: 0o755 }
      )

      const result = await codexLocalAdapter.execute(
        buildContext(workspace.repoPath, fakeAcpxPath, {
          extraEnv: { CODEX_ACCOUNT_SWITCHER_SCRIPT: fakeSwitcherPath }
        })
      )

      expect(result.ok).toBe(false)
      expect(result.failureCategory).toBe("transport")
      expect(result.error).toContain("syntax error")
      expect(existsSync(switchFlagPath)).toBe(false)
    } finally {
      workspace.cleanup()
    }
  })

  it("surfaces a timeout error when acpx hangs", async () => {
    const workspace = createTempWorkspace("codex-acpx-timeout")
    const originalTimeout = process.env.OPENCLAW_CODEX_TIMEOUT_MS
    try {
      const fakeAcpxPath = join(workspace.root, "fake-acpx-timeout.sh")

      writeFileSync(
        fakeAcpxPath,
        [
          "#!/bin/sh",
          'case "$*" in',
          '  *"sessions ensure"*) echo \'{"action":"session_ensured","created":true,"acpxSessionId":"codex-session-timeout"}\'; exit 0 ;;',
          '  *"set-mode"*) echo \'{"action":"mode_set"}\'; exit 0 ;;',
          "esac",
          "sleep 2",
          'echo \'{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"codex-session-timeout","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"too late"}}}}\''
        ].join("\n"),
        { mode: 0o755 }
      )

      process.env.OPENCLAW_CODEX_TIMEOUT_MS = "100"

      const result = await codexLocalAdapter.execute(buildContext(workspace.repoPath, fakeAcpxPath))

      expect(result.ok).toBe(false)
      expect(result.failureCategory).toBe("timeout")
      expect(result.error).toContain("Codex execution failed")
      expect(result.error).toContain("ETIMEDOUT")
    } finally {
      if (originalTimeout === undefined) delete process.env.OPENCLAW_CODEX_TIMEOUT_MS
      else process.env.OPENCLAW_CODEX_TIMEOUT_MS = originalTimeout
      workspace.cleanup()
    }
  })

  it("surfaces an idle timeout when codex stops producing progress", async () => {
    const workspace = createTempWorkspace("codex-acpx-idle-timeout")
    const originalTimeout = process.env.OPENCLAW_CODEX_TIMEOUT_MS
    const originalIdleTimeout = process.env.OPENCLAW_CODEX_IDLE_TIMEOUT_MS
    try {
      const fakeAcpxPath = join(workspace.root, "fake-acpx-idle-timeout.sh")

      writeFileSync(
        fakeAcpxPath,
        [
          "#!/bin/sh",
          'case "$*" in',
          '  *"sessions ensure"*) echo \'{"action":"session_ensured","created":true,"acpxSessionId":"codex-session-idle-timeout"}\'; exit 0 ;;',
          '  *"set-mode"*) echo \'{"action":"mode_set"}\'; exit 0 ;;',
          "esac",
          "sleep 10",
          'echo \'{"sessionId":"codex-session-idle-timeout","response":"too late"}\''
        ].join("\n"),
        { mode: 0o755 }
      )

      process.env.OPENCLAW_CODEX_TIMEOUT_MS = "5000"
      process.env.OPENCLAW_CODEX_IDLE_TIMEOUT_MS = "100"

      const startedAt = Date.now()
      const result = await codexLocalAdapter.execute(
        buildContext(workspace.repoPath, fakeAcpxPath, {
          extraEnv: {
            OPENCLAW_CODEX_TIMEOUT_MS: "5000",
            OPENCLAW_CODEX_IDLE_TIMEOUT_MS: "100"
          }
        })
      )

      expect(Date.now() - startedAt).toBeLessThan(3000)
      expect(result.ok).toBe(false)
      expect(result.failureCategory).toBe("timeout")
      expect(result.error).toContain("Codex execution failed")
      expect(result.error).toContain("ETIMEDOUT")
    } finally {
      if (originalTimeout === undefined) delete process.env.OPENCLAW_CODEX_TIMEOUT_MS
      else process.env.OPENCLAW_CODEX_TIMEOUT_MS = originalTimeout
      if (originalIdleTimeout === undefined) delete process.env.OPENCLAW_CODEX_IDLE_TIMEOUT_MS
      else process.env.OPENCLAW_CODEX_IDLE_TIMEOUT_MS = originalIdleTimeout
      workspace.cleanup()
    }
  }, 15_000)

  it("retries with a fresh session after resume corruption", async () => {
    const workspace = createTempWorkspace("codex-session-recovery")
    try {
      const codexLogPath = join(workspace.root, "codex-argv.log")
      const callCountPath = join(workspace.root, "codex-count.txt")
      const fakeCodexPath = join(workspace.root, "fake-codex.py")

      writeFileSync(
        fakeCodexPath,
        [
          "#!/usr/bin/env python3",
          "from pathlib import Path",
          "import json",
          "import sys",
          `count_path = Path(${JSON.stringify(callCountPath)})`,
          "count = int(count_path.read_text() or '0') if count_path.exists() else 0",
          "count += 1",
          "count_path.write_text(str(count), encoding='utf8')",
          `Path(${JSON.stringify(codexLogPath)}).open('a', encoding='utf8').write(' '.join(sys.argv[1:]) + '\\n')`,
          "if count == 1:",
          "    print('session corrupted while trying to resume', file=sys.stderr)",
          "    raise SystemExit(1)",
          "print(json.dumps({'session_id': 'codex-session-fresh', 'response': 'recovered after interruption'}))"
        ].join("\n"),
        { mode: 0o755 }
      )

      const result = await codexLocalAdapter.execute(buildContext(workspace.repoPath, fakeCodexPath))

      expect(result.ok).toBe(true)
      expect(result.response).toContain("recovered")

      const invocations = readFileSync(codexLogPath, "utf8").trim().split("\n")
      expect(invocations).toHaveLength(2)
      expect(invocations[0]).toContain("resume")
      expect(invocations[1]).not.toContain("resume")
    } finally {
      workspace.cleanup()
    }
  })

  it("starts fresh when persisted state contains an OpenClaw session key", async () => {
    const workspace = createTempWorkspace("codex-invalid-resume-key")
    try {
      const codexLogPath = join(workspace.root, "codex-argv.log")
      const fakeCodexPath = join(workspace.root, "fake-codex.py")

      writeFileSync(
        fakeCodexPath,
        [
          "#!/usr/bin/env python3",
          "from pathlib import Path",
          "import json",
          "import sys",
          `Path(${JSON.stringify(codexLogPath)}).write_text(' '.join(sys.argv[1:]), encoding='utf8')`,
          "print(json.dumps({'session_id': '019f5b39-d9be-7491-bffd-611ef3845f58', 'response': 'started fresh'}))"
        ].join("\n"),
        { mode: 0o755 }
      )

      const result = await codexLocalAdapter.execute(
        buildContext(workspace.repoPath, fakeCodexPath, {
          sessionId: "agent-1:project-1:task-1"
        })
      )

      expect(result.ok).toBe(true)
      expect(readFileSync(codexLogPath, "utf8").split(/\s+/)).not.toContain("resume")
    } finally {
      workspace.cleanup()
    }
  })

  it("passes routing reasoning effort to Codex", async () => {
    const workspace = createTempWorkspace("codex-reasoning-effort")
    try {
      const codexLogPath = join(workspace.root, "codex-argv.log")
      const fakeCodexPath = join(workspace.root, "fake-codex.py")

      writeFileSync(
        fakeCodexPath,
        [
          "#!/usr/bin/env python3",
          "from pathlib import Path",
          "import json",
          "import sys",
          `Path(${JSON.stringify(codexLogPath)}).write_text(' '.join(sys.argv[1:]), encoding='utf8')`,
          "print(json.dumps({'session_id': 'codex-session', 'response': 'ok'}))"
        ].join("\n"),
        { mode: 0o755 }
      )

      const result = await codexLocalAdapter.execute(
        buildContext(workspace.repoPath, fakeCodexPath, {
          model: "gpt-5.5",
          reasoningEffort: "high",
          sessionId: null
        })
      )

      expect(result.ok).toBe(true)
      expect(readFileSync(codexLogPath, "utf8")).toContain('model_reasoning_effort="high"')
    } finally {
      workspace.cleanup()
    }
  })

  it("honors a session cwd override while keeping repo targeting stable", async () => {
    const workspace = createTempWorkspace("codex-cwd")
    try {
      const externalCwd = join(workspace.repoPath, "auth-home")
      mkdirSync(externalCwd, { recursive: true })
      const fakeCodexPath = join(workspace.root, "fake-codex.sh")
      const pwdPath = join(workspace.root, "codex-pwd.txt")
      const envPath = join(workspace.root, "codex-env.json")

      writeFileSync(
        fakeCodexPath,
        [
          "#!/bin/sh",
          `pwd > "${pwdPath}"`,
          `python3 - <<'PY' > '${envPath}'`,
          "import json, os",
          "print(json.dumps({",
          "  'repo_root': os.environ.get('OPENCLAW_ACPX_REPO_ROOT'),",
          "  'session_cwd': os.environ.get('OPENCLAW_ACPX_SESSION_CWD')",
          "}));",
          "PY",
          'printf \'{"session_id":"codex-session-cwd","response":"ok"}\\n\''
        ].join("\n"),
        { mode: 0o755 }
      )

      await codexLocalAdapter.execute(
        buildContext(workspace.repoPath, fakeCodexPath, {
          extraEnv: { OPENCLAW_SESSION_CWD: externalCwd },
          sessionId: null
        })
      )

      expect(readFileSync(pwdPath, "utf8").trim()).toBe(realpathSync(externalCwd))
      expect(JSON.parse(readFileSync(envPath, "utf8"))).toMatchObject({
        repo_root: workspace.repoPath,
        session_cwd: externalCwd
      })
    } finally {
      workspace.cleanup()
    }
  })

  it("classifies invalid model aliases as model-not-found", async () => {
    const workspace = createTempWorkspace("codex-invalid-model")
    try {
      const fakeCodexPath = join(workspace.root, "fake-codex.sh")
      writeFileSync(fakeCodexPath, ["#!/bin/sh", 'echo "unknown model alias: gpt-5.5-typo" >&2', "exit 1"].join("\n"), {
        mode: 0o755
      })

      const result = await codexLocalAdapter.execute(
        buildContext(workspace.repoPath, fakeCodexPath, {
          model: "gpt-5.5-typo",
          sessionId: null
        })
      )

      expect(result.ok).toBe(false)
      expect(result.failureCategory).toBe("model-not-found")
      expect(result.error).toContain("unknown model alias")
    } finally {
      workspace.cleanup()
    }
  })
})
