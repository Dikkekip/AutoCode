import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { Agent, Company, Project, Task } from "@openclaw/domain"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { __internal, geminiLocalAdapter } from "../packages/adapters/gemini-local/src/index.js"
import { createTempWorkspace } from "./helpers.js"

function buildContext(
  root: string,
  command: string,
  options?: {
    extraEnv?: Record<string, string>
    sessionId?: string | null
    model?: string | null
    taskKind?: Task["kind"]
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
    description: "Run gemini",
    labels: [],
    changedFiles: [],
    taskPackage: null,
    kind: options?.taskKind ?? "user",
    priority: 0,
    scheduledAt: null,
    source: "manual",
    status: "queued",
    assignedAgentId: null,
    requestedAdapterType: "gemini_local",
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
  const sessionId = options?.sessionId ?? null
  const agent: Agent = {
    id: "agent-1",
    companyId: company.id,
    name: "gemini-ui",
    role: "UI Engineer",
    adapterType: "gemini_local",
    status: "idle",
    model: options?.model ?? "gemini-3.1-flash",
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
    prompt: "Reply ok",
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
          adapterType: "gemini_local" as const,
          sessionDisplayId: sessionId,
          state: { sessionId },
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
  }
}

describe("geminiLocalAdapter", () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it("runs a tool-capable OpenCode ACP agent through acpx", async () => {
    const workspace = createTempWorkspace("gemini-opencode-acpx-bridge")
    try {
      const fakeAcpxPath = join(workspace.root, "fake-acpx.py")
      const invocationDumpPath = join(workspace.root, "opencode-acpx-invocation.json")
      const fakeOpenCodePath = join(workspace.root, "opencode")
      writeFileSync(fakeOpenCodePath, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
      writeFileSync(
        fakeAcpxPath,
        [
          "#!/usr/bin/env python3",
          "from pathlib import Path",
          "import json, os, sys",
          `Path(${JSON.stringify(invocationDumpPath)}).write_text(json.dumps({`,
          "  'argv': sys.argv[1:],",
          "  'cwd': os.getcwd(),",
          "  'stdin': sys.stdin.read(),",
          "}), encoding='utf8')",
          "print(json.dumps({'jsonrpc': '2.0', 'method': 'session/update', 'params': {",
          "  'sessionId': 'opencode-session-1',",
          "  'update': {'sessionUpdate': 'agent_message_chunk', 'content': {'type': 'text', 'text': 'implemented'}}",
          "}}))"
        ].join("\n"),
        { mode: 0o755 }
      )

      const context = buildContext(workspace.repoPath, fakeAcpxPath, {
        model: "gemini-3.1-pro",
        extraEnv: {
          OPENCLAW_GEMINI_ACPX_AGENT_COMMAND: `${fakeOpenCodePath} acp`,
          OPENCLAW_GEMINI_ACPX_MODEL: "opencode/big-pickle",
          OPENCLAW_GEMINI_TIMEOUT_MS: "120000"
        }
      })
      const result = await geminiLocalAdapter.execute(context)

      expect(result.ok).toBe(true)
      expect(result.response).toBe("implemented")
      expect(result.metadata).toMatchObject({
        adapterType: "gemini_local",
        provider: "acpx",
        model: "opencode/big-pickle",
        transport: "acpx"
      })
      const invocation = JSON.parse(readFileSync(invocationDumpPath, "utf8")) as {
        argv: string[]
        cwd: string
        stdin: string
      }
      expect(invocation.cwd).toBe(realpathSync(workspace.repoPath))
      expect(invocation.stdin).toBe("Reply ok")
      expect(invocation.argv).toEqual([
        "--cwd",
        workspace.repoPath,
        "--approve-all",
        "--format",
        "json",
        "--suppress-reads",
        "--timeout",
        "120",
        "--model",
        "opencode/big-pickle",
        "--agent",
        `${fakeOpenCodePath} acp --log-level WARN`,
        "exec"
      ])
    } finally {
      workspace.cleanup()
    }
  })

  it("fails a tool-only ACP protocol transcript so another model can finish the turn", () => {
    const protocol = [
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { sessionId: "opencode-session-tool-only" } }),
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "opencode-session-tool-only",
          update: { sessionUpdate: "tool_call", toolCallId: "tool-1", title: "Inspect repository" }
        }
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        result: { stopReason: "end_turn", usage: { totalTokens: 321 } }
      })
    ].join("\n")

    const result = geminiLocalAdapter.parseResult(protocol, "")

    expect(result.ok).toBe(false)
    expect(result.failureCategory).toBe("transport")
    expect(result.error).toContain("without a final assistant message after tool activity")
    expect(result.response).toBe("")
    expect(result.continuation).toEqual({
      sessionDisplayId: "opencode-session-tool-only",
      state: { sessionId: "opencode-session-tool-only" }
    })
  })

  it("surfaces ACPX JSON-RPC errors as fallback-eligible transport failures", () => {
    const protocol = [
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { sessionId: "opencode-session-error" } }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32603,
          message: "Upstream request failed: [400] Provider returned error",
          data: { acpxCode: "RUNTIME", retryable: false }
        }
      })
    ].join("\n")

    const result = geminiLocalAdapter.parseResult(protocol, "")

    expect(result.ok).toBe(false)
    expect(result.failureCategory).toBe("transport")
    expect(result.error).toContain("Upstream request failed: [400] Provider returned error")
    expect(result.response).toBe("")
  })

  it("restores the execution workspace before rotating to an ACP model fallback", async () => {
    const workspace = createTempWorkspace("gemini-opencode-acpx-model-fallback")
    try {
      const fakeAcpxPath = join(workspace.root, "fake-acpx.py")
      const invocationDumpPath = join(workspace.root, "opencode-acpx-fallback-invocations.jsonl")
      const fakeOpenCodePath = join(workspace.root, "opencode")
      writeFileSync(fakeOpenCodePath, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
      execFileSync("git", ["init"], { cwd: workspace.repoPath, stdio: "ignore" })
      execFileSync("git", ["add", "README.md"], { cwd: workspace.repoPath, stdio: "ignore" })
      execFileSync(
        "git",
        ["-c", "user.name=OpenClaw", "-c", "user.email=openclaw@example.test", "commit", "-m", "init"],
        {
          cwd: workspace.repoPath,
          stdio: "ignore"
        }
      )
      writeFileSync(join(workspace.repoPath, "README.md"), "pre-existing tracked edit\n", "utf8")
      writeFileSync(join(workspace.repoPath, "pending.ts"), "pre-existing untracked edit\n", "utf8")
      writeFileSync(
        fakeAcpxPath,
        [
          "#!/usr/bin/env python3",
          "from pathlib import Path",
          "import json, sys",
          "argv = sys.argv[1:]",
          "model = argv[argv.index('--model') + 1]",
          "repo = Path.cwd()",
          `dump = Path(${JSON.stringify(invocationDumpPath)})`,
          "with dump.open('a', encoding='utf8') as handle:",
          "  handle.write(json.dumps({'model': model}) + '\\n')",
          "print(json.dumps({'jsonrpc': '2.0', 'id': 1, 'result': {'sessionId': 'fallback-session'}}))",
          "if model == 'opencode/primary':",
          "  (repo / 'README.md').write_text('contaminated tracked edit\\n', encoding='utf8')",
          "  (repo / 'pending.ts').write_text('contaminated untracked edit\\n', encoding='utf8')",
          "  (repo / 'primary-only.ts').write_text('partial failed-model output\\n', encoding='utf8')",
          "  print(json.dumps({'jsonrpc': '2.0', 'method': 'session/update', 'params': {",
          "    'sessionId': 'fallback-session',",
          "    'update': {'sessionUpdate': 'tool_call', 'toolCallId': 'tool-1', 'title': 'Inspect repository'}",
          "  }}))",
          "if model == 'opencode/fallback':",
          "  (repo / 'fallback-only.ts').write_text('successful fallback output\\n', encoding='utf8')",
          "  print(json.dumps({'jsonrpc': '2.0', 'method': 'session/update', 'params': {",
          "    'sessionId': 'fallback-session',",
          "    'update': {'sessionUpdate': 'agent_message_chunk', 'content': {'type': 'text', 'text': 'recovered'}}",
          "  }}))"
        ].join("\n"),
        { mode: 0o755 }
      )

      const context = buildContext(workspace.repoPath, fakeAcpxPath, {
        extraEnv: {
          OPENCLAW_GEMINI_ACPX_AGENT_COMMAND: `${fakeOpenCodePath} acp`,
          OPENCLAW_GEMINI_ACPX_MODEL: "opencode/primary",
          OPENCLAW_GEMINI_ACPX_MODEL_FALLBACKS: "opencode/fallback, opencode/primary",
          OPENCLAW_GEMINI_ACPX_FALLBACK_JITTER_MS: "30"
        }
      })
      const fallbackEvents: Array<Record<string, unknown>> = []
      const restorationEvents: Array<Record<string, unknown>> = []
      context.log = (_level, message, data) => {
        if (message === "Retrying ACPX agent with fallback model") fallbackEvents.push(data ?? {})
        if (message === "Restored execution workspace before ACPX model fallback") restorationEvents.push(data ?? {})
      }
      const result = await geminiLocalAdapter.execute(context)

      expect(result.ok).toBe(true)
      expect(result.response).toBe("recovered")
      expect(result.metadata?.model).toBe("opencode/fallback")
      expect(result.runtimeIdentity?.model).toBe("opencode/fallback")
      expect(readFileSync(join(workspace.repoPath, "README.md"), "utf8")).toBe("pre-existing tracked edit\n")
      expect(readFileSync(join(workspace.repoPath, "pending.ts"), "utf8")).toBe("pre-existing untracked edit\n")
      expect(existsSync(join(workspace.repoPath, "primary-only.ts"))).toBe(false)
      expect(readFileSync(join(workspace.repoPath, "fallback-only.ts"), "utf8")).toBe("successful fallback output\n")
      expect(
        readFileSync(invocationDumpPath, "utf8")
          .trim()
          .split("\n")
          .map((line) => (JSON.parse(line) as { model: string }).model)
      ).toEqual(["opencode/primary", "opencode/fallback"])
      expect(fallbackEvents).toEqual([
        expect.objectContaining({
          failedModel: "opencode/primary",
          fallbackModel: "opencode/fallback",
          fallbackDelayMs: __internal.geminiAcpxFallbackDelayMs("run-1", 1, context.agent.env)
        })
      ])
      expect(restorationEvents).toEqual([
        expect.objectContaining({
          failedModel: "opencode/primary",
          fallbackModel: "opencode/fallback",
          restoredTrackedChanges: true,
          removedUntrackedPaths: ["primary-only.ts"]
        })
      ])
    } finally {
      workspace.cleanup()
    }
  })

  it("prunes unsupported ACP fallback models using the runtime-advertised model list", async () => {
    const workspace = createTempWorkspace("gemini-opencode-acpx-advertised-model-filter")
    try {
      const fakeAcpxPath = join(workspace.root, "fake-acpx.py")
      const invocationDumpPath = join(workspace.root, "opencode-acpx-advertised-invocations.jsonl")
      const fakeOpenCodePath = join(workspace.root, "opencode")
      writeFileSync(fakeOpenCodePath, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
      execFileSync("git", ["init"], { cwd: workspace.repoPath, stdio: "ignore" })
      execFileSync("git", ["add", "README.md"], { cwd: workspace.repoPath, stdio: "ignore" })
      execFileSync(
        "git",
        ["-c", "user.name=OpenClaw", "-c", "user.email=openclaw@example.test", "commit", "-m", "init"],
        { cwd: workspace.repoPath, stdio: "ignore" }
      )
      writeFileSync(
        fakeAcpxPath,
        [
          "#!/usr/bin/env python3",
          "from pathlib import Path",
          "import json, sys",
          "argv = sys.argv[1:]",
          "model = argv[argv.index('--model') + 1]",
          `dump = Path(${JSON.stringify(invocationDumpPath)})`,
          "with dump.open('a', encoding='utf8') as handle:",
          "  handle.write(json.dumps({'model': model}) + '\\n')",
          "print(json.dumps({'jsonrpc': '2.0', 'id': 1, 'result': {'sessionId': 'advertised-session'}}))",
          "if model == 'opencode/primary-missing':",
          "  print(json.dumps({'jsonrpc': '2.0', 'id': None, 'error': {",
          "    'code': -32603,",
          "    'message': 'Cannot apply --model \"opencode/primary-missing\": the ACP agent did not advertise that model. Available models: opencode/fallback-valid, opencode/another-valid.',",
          "    'data': {'acpxCode': 'RUNTIME'}",
          "  }}))",
          "else:",
          "  print(json.dumps({'jsonrpc': '2.0', 'method': 'session/update', 'params': {",
          "    'sessionId': 'advertised-session',",
          "    'update': {'sessionUpdate': 'agent_message_chunk', 'content': {'type': 'text', 'text': 'recovered'}}",
          "  }}))"
        ].join("\n"),
        { mode: 0o755 }
      )

      const context = buildContext(workspace.repoPath, fakeAcpxPath, {
        extraEnv: {
          OPENCLAW_GEMINI_ACPX_AGENT_COMMAND: `${fakeOpenCodePath} acp`,
          OPENCLAW_GEMINI_ACPX_MODEL: "opencode/primary-missing",
          OPENCLAW_GEMINI_ACPX_MODEL_FALLBACKS:
            "opencode/fallback-valid,opencode/secondary-missing,opencode/another-valid",
          OPENCLAW_GEMINI_ACPX_FALLBACK_JITTER_MS: "0"
        }
      })
      const pruningEvents: Array<Record<string, unknown>> = []
      context.log = (_level, message, data) => {
        if (message === "Pruned unsupported ACPX fallback models using advertised runtime capabilities") {
          pruningEvents.push(data ?? {})
        }
      }

      const result = await geminiLocalAdapter.execute(context)

      expect(result.ok).toBe(true)
      expect(result.response).toBe("recovered")
      expect(
        readFileSync(invocationDumpPath, "utf8")
          .trim()
          .split("\n")
          .map((line) => (JSON.parse(line) as { model: string }).model)
      ).toEqual(["opencode/primary-missing", "opencode/fallback-valid"])
      expect(pruningEvents).toEqual([
        expect.objectContaining({
          failedModel: "opencode/primary-missing",
          advertisedModels: ["opencode/fallback-valid", "opencode/another-valid"],
          keptModels: ["opencode/fallback-valid", "opencode/another-valid"],
          skippedModels: ["opencode/primary-missing", "opencode/secondary-missing"]
        })
      ])
    } finally {
      workspace.cleanup()
    }
  })

  it("fails an ACP turn that returns neither an assistant message nor tool activity", () => {
    const protocol = [
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { sessionId: "opencode-session-empty" } }),
      JSON.stringify({ jsonrpc: "2.0", id: 3, result: { stopReason: "end_turn" } })
    ].join("\n")

    const result = geminiLocalAdapter.parseResult(protocol, "")

    expect(result.ok).toBe(false)
    expect(result.failureCategory).toBe("transport")
    expect(result.error).toContain("without a final assistant message or tool activity")
    expect(result.response).toBe("")
  })

  it("terminates an ACP agent that stops producing protocol output", async () => {
    const workspace = createTempWorkspace("gemini-opencode-acpx-idle-timeout")
    try {
      const fakeAcpxPath = join(workspace.root, "fake-acpx.sh")
      const fakeOpenCodePath = join(workspace.root, "opencode")
      writeFileSync(fakeOpenCodePath, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
      writeFileSync(fakeAcpxPath, "#!/bin/sh\nsleep 5\n", { mode: 0o755 })

      const context = buildContext(workspace.repoPath, fakeAcpxPath, {
        extraEnv: {
          OPENCLAW_GEMINI_ACPX_AGENT_COMMAND: `${fakeOpenCodePath} acp`,
          OPENCLAW_GEMINI_ACPX_IDLE_TIMEOUT_MS: "50",
          OPENCLAW_GEMINI_TIMEOUT_MS: "5000"
        }
      })
      const startedAt = Date.now()
      const result = await geminiLocalAdapter.execute(context)

      expect(result.ok).toBe(false)
      expect(result.failureCategory).toBe("timeout")
      expect(result.error).toContain("ETIMEDOUT")
      expect(Date.now() - startedAt).toBeLessThan(2_000)
    } finally {
      workspace.cleanup()
    }
  })

  it("terminates an ACP agent that emits protocol chatter without completing", async () => {
    const workspace = createTempWorkspace("gemini-opencode-acpx-wall-timeout")
    try {
      const fakeAcpxPath = join(workspace.root, "fake-acpx.sh")
      const fakeOpenCodePath = join(workspace.root, "opencode")
      writeFileSync(fakeOpenCodePath, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
      writeFileSync(
        fakeAcpxPath,
        '#!/bin/sh\nwhile true; do printf \'{"jsonrpc":"2.0","method":"session/update"}\\n\'; sleep 0.02; done\n',
        { mode: 0o755 }
      )

      const context = buildContext(workspace.repoPath, fakeAcpxPath, {
        extraEnv: {
          OPENCLAW_GEMINI_ACPX_AGENT_COMMAND: `${fakeOpenCodePath} acp`,
          OPENCLAW_GEMINI_ACPX_IDLE_TIMEOUT_MS: "1000",
          OPENCLAW_GEMINI_ACPX_WALL_TIMEOUT_MS: "100",
          OPENCLAW_GEMINI_TIMEOUT_MS: "5000"
        }
      })
      const startedAt = Date.now()
      const result = await geminiLocalAdapter.execute(context)

      expect(result.ok).toBe(false)
      expect(result.failureCategory).toBe("timeout")
      expect(result.error).toContain("ETIMEDOUT")
      expect(Date.now() - startedAt).toBeLessThan(2_000)
    } finally {
      workspace.cleanup()
    }
  })

  it("continues a timed-out code handoff into deterministic verification when an assistant response exists", async () => {
    const workspace = createTempWorkspace("gemini-opencode-acpx-timeout-handoff")
    try {
      const fakeAcpxPath = join(workspace.root, "fake-acpx.py")
      const fakeOpenCodePath = join(workspace.root, "opencode")
      writeFileSync(fakeOpenCodePath, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
      writeFileSync(
        fakeAcpxPath,
        [
          "#!/bin/sh",
          "printf 'verified = True\\n' > implemented.py",
          `printf '%s\\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"timeout-handoff-session","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"implemented; run verification"}}}}'`,
          "while :; do sleep 0.02; done"
        ].join("\n"),
        { mode: 0o755 }
      )

      const context = buildContext(workspace.repoPath, fakeAcpxPath, {
        taskKind: "implement",
        extraEnv: {
          OPENCLAW_GEMINI_ACPX_AGENT_COMMAND: `${fakeOpenCodePath} acp`,
          OPENCLAW_GEMINI_ACPX_MODEL: "opencode/primary",
          OPENCLAW_GEMINI_ACPX_MODEL_FALLBACKS: "opencode/fallback",
          OPENCLAW_GEMINI_ACPX_IDLE_TIMEOUT_MS: "1000",
          OPENCLAW_GEMINI_ACPX_WALL_TIMEOUT_MS: "500",
          OPENCLAW_GEMINI_ACPX_TOTAL_TIMEOUT_MS: "1500",
          OPENCLAW_GEMINI_TIMEOUT_MS: "5000"
        }
      })
      const handoffEvents: Array<Record<string, unknown>> = []
      context.log = (_level, message, data) => {
        if (message === "Continuing timed-out ACPX code handoff into deterministic verification") {
          handoffEvents.push(data ?? {})
        }
      }

      const result = await geminiLocalAdapter.execute(context)

      expect(result.ok, JSON.stringify(result)).toBe(true)
      expect(result.failureCategory).toBeUndefined()
      expect(result.error).toBeUndefined()
      expect(result.response).toContain("run verification")
      expect(readFileSync(join(workspace.repoPath, "implemented.py"), "utf8")).toBe("verified = True\n")
      expect(handoffEvents).toEqual([
        expect.objectContaining({ model: "opencode/primary", responseLength: expect.any(Number) })
      ])
    } finally {
      workspace.cleanup()
    }
  })

  it("shares one wall-clock budget across ACP model fallbacks", async () => {
    const workspace = createTempWorkspace("gemini-opencode-acpx-total-timeout")
    try {
      const fakeAcpxPath = join(workspace.root, "fake-acpx.py")
      const invocationDumpPath = join(workspace.root, "acpx-total-timeout-models.jsonl")
      const fakeOpenCodePath = join(workspace.root, "opencode")
      writeFileSync(fakeOpenCodePath, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
      writeFileSync(
        fakeAcpxPath,
        [
          "#!/bin/sh",
          'while [ "$#" -gt 0 ]; do if [ "$1" = "--model" ]; then shift; model="$1"; break; fi; shift; done',
          `printf '{"model":"%s"}\\n' "$model" >> '${invocationDumpPath}'`,
          `while :; do printf '%s\\n' '{"jsonrpc":"2.0","method":"session/update"}'; sleep 0.02; done`
        ].join("\n"),
        { mode: 0o755 }
      )

      const context = buildContext(workspace.repoPath, fakeAcpxPath, {
        extraEnv: {
          OPENCLAW_GEMINI_ACPX_AGENT_COMMAND: `${fakeOpenCodePath} acp`,
          OPENCLAW_GEMINI_ACPX_MODEL: "opencode/primary",
          OPENCLAW_GEMINI_ACPX_MODEL_FALLBACKS: "opencode/fallback",
          OPENCLAW_GEMINI_ACPX_IDLE_TIMEOUT_MS: "1000",
          OPENCLAW_GEMINI_ACPX_WALL_TIMEOUT_MS: "1500",
          OPENCLAW_GEMINI_ACPX_TOTAL_TIMEOUT_MS: "2000",
          OPENCLAW_GEMINI_TIMEOUT_MS: "5000"
        }
      })
      const startedAt = Date.now()
      const result = await geminiLocalAdapter.execute(context)

      expect(result.ok).toBe(false)
      expect(result.failureCategory).toBe("timeout")
      expect(Date.now() - startedAt).toBeLessThan(3_000)
      expect(
        readFileSync(invocationDumpPath, "utf8")
          .trim()
          .split("\n")
          .map((line) => (JSON.parse(line) as { model: string }).model)
      ).toEqual(["opencode/primary", "opencode/fallback"])
    } finally {
      workspace.cleanup()
    }
  })

  it("scrubs ambient Google Cloud env so Gemini can use local OAuth state through acpx", async () => {
    const workspace = createTempWorkspace("gemini-acpx-env-scrub")
    try {
      const fakeAcpxPath = join(workspace.root, "fake-acpx.py")
      const envDumpPath = join(workspace.root, "gemini-env.json")

      writeFileSync(
        fakeAcpxPath,
        [
          "#!/usr/bin/env python3",
          "from pathlib import Path",
          "import json, os, sys",
          `env_path = Path(${JSON.stringify(envDumpPath)})`,
          "argv = sys.argv[1:]",
          "if 'sessions' in argv and 'ensure' in argv:",
          "    print(json.dumps({'action': 'session_ensured', 'created': True, 'acpxSessionId': 'gemini-session-0'}))",
          "    raise SystemExit(0)",
          "else:",
          "    # Treating anything else as execution (prompt in stdin)",
          "    keys = [",
          "      'GOOGLE_APPLICATION_CREDENTIALS',",
          "      'GOOGLE_CREDENTIALS',",
          "      'GOOGLE_SERVICE_ACCOUNT_AUTH',",
          "      'GOOGLE_CLOUD_ACCESS_TOKEN',",
          "      'GOOGLE_CLOUD_ACCOUNT',",
          "      'GOOGLE_CLOUD_PROJECT',",
          "      'GOOGLE_CLOUD_PROJECT_ID',",
          "      'GOOGLE_CLOUD_QUOTA_PROJECT',",
          "      'GOOGLE_CLOUD_LOCATION',",
          "      'GOOGLE_CLOUD_REGION',",
          "      'GOOGLE_API_KEY',",
          "      'GOOGLE_GENAI_API_KEY',",
          "      'GEMINI_API_KEY',",
          "      'GCLOUD_PROJECT',",
          "      'CLOUDSDK_CONFIG',",
          "      'CLOUDSDK_CONFIG_DIRECTORY',",
          "      'CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE',",
          "      'CLOUDSDK_CORE_ACCOUNT',",
          "      'CLOUDSDK_CORE_PROJECT',",
          "      'VERTEX_PROJECT',",
          "      'VERTEX_LOCATION',",
          "      'GOOGLE_GENAI_USE_GCA',",
          "      'GOOGLE_GENAI_USE_VERTEXAI',",
          "      'OPENCLAW_RUNTIME_KEY',",
          "      'OPENCLAW_EXECUTION_KEY',",
          "      'OPENCLAW_WAKE_REASON',",
          "      'OPENCLAW_ACPX_REPO_ROOT',",
          "      'OPENCLAW_ACPX_SESSION_CWD'",
          "    ]",
          "    env_path.write_text(json.dumps({k: os.environ.get(k) for k in keys}), encoding='utf8')",
          "    print(json.dumps({'session_id': 'gemini-session-1', 'response': 'ok'}))",
          "    raise SystemExit(0)"
        ].join("\n"),

        { mode: 0o755 }
      )

      process.env.GOOGLE_APPLICATION_CREDENTIALS = "/tmp/translate-creds.json"
      process.env.GOOGLE_CREDENTIALS = "translate-inline-creds"
      process.env.GOOGLE_SERVICE_ACCOUNT_AUTH = "true"
      process.env.GOOGLE_CLOUD_ACCESS_TOKEN = "translate-access-token"
      process.env.GOOGLE_CLOUD_ACCOUNT = "translate@example.invalid"
      process.env.GOOGLE_CLOUD_PROJECT = "translate-483308"
      process.env.GOOGLE_CLOUD_PROJECT_ID = "translate-483308"
      process.env.GOOGLE_CLOUD_QUOTA_PROJECT = "translate-483308"
      process.env.GOOGLE_CLOUD_LOCATION = "europe-west1"
      process.env.GOOGLE_CLOUD_REGION = "europe-west1"
      process.env.GOOGLE_API_KEY = "translate-key"
      process.env.GOOGLE_GENAI_API_KEY = "translate-genai-key"
      process.env.GEMINI_API_KEY = "translate-gemini-key"
      process.env.GCLOUD_PROJECT = "translate-483308"
      process.env.CLOUDSDK_CONFIG = "/tmp/translate-gcloud"
      process.env.CLOUDSDK_CONFIG_DIRECTORY = "/tmp/translate-gcloud"
      process.env.CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE = "/tmp/translate-creds.json"
      process.env.CLOUDSDK_CORE_ACCOUNT = "translate@example.invalid"
      process.env.CLOUDSDK_CORE_PROJECT = "translate-483308"
      process.env.VERTEX_PROJECT = "translate-483308"
      process.env.VERTEX_LOCATION = "europe-west1"
      process.env.GOOGLE_GENAI_USE_GCA = "true"
      process.env.GOOGLE_GENAI_USE_VERTEXAI = "true"

      const result = await geminiLocalAdapter.execute(buildContext(workspace.repoPath, fakeAcpxPath))

      expect(result.ok).toBe(true)
      expect(result.metadata?.adapterType).toBe("gemini_local")
      expect(result.metadata?.transport).toBe("acpx")
      expect(result.continuation?.sessionDisplayId).toBe("gemini-session-1")
      expect(result.sessionState).toMatchObject({
        sessionName: "agent-1:project-1:task-1",
        sessionId: "gemini-session-1"
      })

      const dumped = JSON.parse(readFileSync(envDumpPath, "utf8")) as Record<string, string | null>
      expect(dumped.GOOGLE_APPLICATION_CREDENTIALS).toBeNull()
      for (const key of [
        "GOOGLE_CREDENTIALS",
        "GOOGLE_SERVICE_ACCOUNT_AUTH",
        "GOOGLE_CLOUD_ACCESS_TOKEN",
        "GOOGLE_CLOUD_ACCOUNT",
        "GOOGLE_CLOUD_PROJECT",
        "GOOGLE_CLOUD_PROJECT_ID",
        "GOOGLE_CLOUD_QUOTA_PROJECT",
        "GOOGLE_CLOUD_LOCATION",
        "GOOGLE_CLOUD_REGION",
        "GOOGLE_API_KEY",
        "GOOGLE_GENAI_API_KEY",
        "GEMINI_API_KEY",
        "GCLOUD_PROJECT",
        "CLOUDSDK_CONFIG",
        "CLOUDSDK_CONFIG_DIRECTORY",
        "CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE",
        "CLOUDSDK_CORE_ACCOUNT",
        "CLOUDSDK_CORE_PROJECT",
        "VERTEX_PROJECT",
        "VERTEX_LOCATION",
        "GOOGLE_GENAI_USE_GCA",
        "GOOGLE_GENAI_USE_VERTEXAI"
      ]) {
        expect(dumped[key], key).toBeNull()
      }
      expect(dumped.OPENCLAW_RUNTIME_KEY).toBe("agent-1:project-1:task-1")
      expect(dumped.OPENCLAW_EXECUTION_KEY).toBe("run-1")
      expect(dumped.OPENCLAW_WAKE_REASON).toBe("manual")
      expect(dumped.OPENCLAW_ACPX_REPO_ROOT).toBe(workspace.repoPath)
      expect(dumped.OPENCLAW_ACPX_SESSION_CWD).toBe(workspace.repoPath)
    } finally {
      workspace.cleanup()
    }
  })

  it("retries with a fresh session after quota exhaustion on resume", async () => {
    const workspace = createTempWorkspace("gemini-quota-retry")
    try {
      const fakeGeminiPath = join(workspace.root, "fake-gemini.py")
      const argvLogPath = join(workspace.root, "gemini-argv.log")
      const callCountPath = join(workspace.root, "gemini-count.txt")

      writeFileSync(
        fakeGeminiPath,
        [
          "#!/usr/bin/env python3",
          "from pathlib import Path",
          "import json",
          "import sys",
          `count_path = Path(${JSON.stringify(callCountPath)})`,
          "count = int(count_path.read_text() or '0') if count_path.exists() else 0",
          "count += 1",
          "count_path.write_text(str(count), encoding='utf8')",
          `Path(${JSON.stringify(argvLogPath)}).open('a', encoding='utf8').write(' '.join(sys.argv[1:]) + '\\n')`,
          "if count == 1:",
          "    print('Quota exceeded for this Gemini account', file=sys.stderr)",
          "    raise SystemExit(1)",
          "print(json.dumps({'session_id': 'gemini-session-fresh', 'response': 'ok after retry', 'stats': {'totalTokenCount': 9}}))"
        ].join("\n"),
        { mode: 0o755 }
      )

      const result = await geminiLocalAdapter.execute(
        buildContext(workspace.repoPath, fakeGeminiPath, {
          sessionId: "gemini-session-old"
        })
      )

      expect(result.ok).toBe(true)
      expect(result.response).toContain("after retry")

      const invocations = readFileSync(argvLogPath, "utf8").trim().split("\n")
      expect(invocations).toHaveLength(2)
      expect(invocations[0]).toContain("--resume")
      expect(invocations[1]).not.toContain("--resume")
    } finally {
      workspace.cleanup()
    }
  })

  it("honors a session cwd override and includes the repo explicitly", async () => {
    const workspace = createTempWorkspace("gemini-cwd")
    try {
      const externalCwd = join(workspace.root, "auth-home")
      mkdirSync(externalCwd, { recursive: true })
      const fakeGeminiPath = join(workspace.root, "fake-gemini.sh")
      const pwdPath = join(workspace.root, "gemini-pwd.txt")
      const argvPath = join(workspace.root, "gemini-argv.txt")
      const envPath = join(workspace.root, "gemini-env.json")

      writeFileSync(
        fakeGeminiPath,
        [
          "#!/bin/sh",
          `pwd > "${pwdPath}"`,
          `printf '%s\\n' "$*" > "${argvPath}"`,
          `python3 - <<'PY' > '${envPath}'`,
          "import json, os",
          "print(json.dumps({",
          "  'repo_root': os.environ.get('OPENCLAW_ACPX_REPO_ROOT'),",
          "  'session_cwd': os.environ.get('OPENCLAW_ACPX_SESSION_CWD')",
          "}));",
          "PY",
          'printf \'{"session_id":"gemini-session-cwd","response":"ok"}\\n\''
        ].join("\n"),
        { mode: 0o755 }
      )

      const result = await geminiLocalAdapter.execute(
        buildContext(workspace.repoPath, fakeGeminiPath, {
          extraEnv: { OPENCLAW_SESSION_CWD: externalCwd }
        })
      )

      expect(result.ok).toBe(true)
      expect(readFileSync(pwdPath, "utf8").trim()).toBe(realpathSync(externalCwd))
      expect(readFileSync(argvPath, "utf8")).toContain(`--include-directories ${workspace.repoPath}`)
      expect(JSON.parse(readFileSync(envPath, "utf8"))).toMatchObject({
        repo_root: workspace.repoPath,
        session_cwd: externalCwd
      })
    } finally {
      workspace.cleanup()
    }
  })

  it("can honor a session cwd override without including the repo directory", async () => {
    const workspace = createTempWorkspace("gemini-external-cwd-no-include")
    try {
      const externalCwd = join(workspace.root, "auth-home")
      mkdirSync(externalCwd, { recursive: true })
      const fakeGeminiPath = join(workspace.root, "fake-gemini.sh")
      const pwdPath = join(workspace.root, "gemini-pwd-no-include.txt")
      const argvPath = join(workspace.root, "gemini-argv-no-include.txt")

      writeFileSync(
        fakeGeminiPath,
        [
          "#!/bin/sh",
          `pwd > "${pwdPath}"`,
          `printf '%s\\n' "$*" > "${argvPath}"`,
          'printf \'{"session_id":"gemini-session-cwd-no-include","response":"ok"}\\n\''
        ].join("\n"),
        { mode: 0o755 }
      )

      const result = await geminiLocalAdapter.execute(
        buildContext(workspace.repoPath, fakeGeminiPath, {
          extraEnv: { OPENCLAW_SESSION_CWD: externalCwd, OPENCLAW_GEMINI_INCLUDE_REPO: "0" }
        })
      )

      expect(result.ok).toBe(true)
      expect(realpathSync(readFileSync(pwdPath, "utf8").trim())).toBe(realpathSync(externalCwd))
      expect(readFileSync(argvPath, "utf8")).not.toContain("--include-directories")
    } finally {
      workspace.cleanup()
    }
  })

  it("forces Gemini execution worktrees to run from the worktree cwd", async () => {
    const workspace = createTempWorkspace("gemini-worktree-cwd")
    try {
      const worktreePath = join(workspace.repoPath, ".openclaw", "state", "current", "worktrees", "run-1")
      const externalCwd = join(workspace.root, "auth-home")
      mkdirSync(worktreePath, { recursive: true })
      mkdirSync(externalCwd, { recursive: true })
      const fakeGeminiPath = join(workspace.root, "fake-gemini.sh")
      const pwdPath = join(workspace.root, "gemini-worktree-pwd.txt")
      const argvPath = join(workspace.root, "gemini-worktree-argv.txt")
      const envPath = join(workspace.root, "gemini-worktree-env.json")

      writeFileSync(
        fakeGeminiPath,
        [
          "#!/bin/sh",
          `pwd > "${pwdPath}"`,
          `printf '%s\\n' "$*" > "${argvPath}"`,
          `python3 - <<'PY' > '${envPath}'`,
          "import json, os",
          "print(json.dumps({",
          "  'repo_root': os.environ.get('OPENCLAW_ACPX_REPO_ROOT'),",
          "  'session_cwd': os.environ.get('OPENCLAW_ACPX_SESSION_CWD')",
          "}));",
          "PY",
          'printf \'{"session_id":"gemini-session-worktree","response":"ok"}\\n\''
        ].join("\n"),
        { mode: 0o755 }
      )

      const result = await geminiLocalAdapter.execute(
        buildContext(worktreePath, fakeGeminiPath, {
          extraEnv: { OPENCLAW_SESSION_CWD: externalCwd }
        })
      )

      expect(result.ok).toBe(true)
      expect(readFileSync(pwdPath, "utf8").trim()).toBe(realpathSync(worktreePath))
      expect(readFileSync(argvPath, "utf8")).not.toContain("--include-directories")
      expect(JSON.parse(readFileSync(envPath, "utf8"))).toMatchObject({
        repo_root: worktreePath,
        session_cwd: worktreePath
      })
    } finally {
      workspace.cleanup()
    }
  })

  it("classifies invalid model aliases as model-not-found", async () => {
    const workspace = createTempWorkspace("gemini-invalid-model")
    try {
      const fakeGeminiPath = join(workspace.root, "fake-gemini.sh")

      writeFileSync(fakeGeminiPath, ["#!/bin/sh", "echo 'unknown model alias: gemini-typo' >&2", "exit 1"].join("\n"), {
        mode: 0o755
      })

      const result = await geminiLocalAdapter.execute(
        buildContext(workspace.repoPath, fakeGeminiPath, {
          model: "gemini-typo"
        })
      )

      expect(result.ok).toBe(false)
      expect(result.failureCategory).toBe("model-not-found")
      expect(result.error).toContain("unknown model alias")
    } finally {
      workspace.cleanup()
    }
  })

  it("classifies Google's retired personal OAuth client as an auth failure", async () => {
    const workspace = createTempWorkspace("gemini-retired-oauth")
    try {
      const fakeGeminiPath = join(workspace.root, "fake-gemini.sh")

      writeFileSync(
        fakeGeminiPath,
        [
          "#!/bin/sh",
          "echo 'Error authenticating: IneligibleTierError: This client is no longer supported (UNSUPPORTED_CLIENT)' >&2",
          "exit 1"
        ].join("\n"),
        { mode: 0o755 }
      )

      const result = await geminiLocalAdapter.execute(buildContext(workspace.repoPath, fakeGeminiPath))

      expect(result.ok).toBe(false)
      expect(result.failureCategory).toBe("auth")
      expect(result.error).toContain("UNSUPPORTED_CLIENT")
    } finally {
      workspace.cleanup()
    }
  })

  it("cleans up child processes left behind by the Gemini CLI wrapper", async () => {
    const workspace = createTempWorkspace("gemini-child-cleanup")
    try {
      const markerPath = join(workspace.root, "orphan-marker.txt")
      const fakeGeminiPath = join(workspace.root, "fake-gemini.sh")

      writeFileSync(
        fakeGeminiPath,
        [
          "#!/bin/sh",
          `node -e "setTimeout(() => require('fs').writeFileSync(process.argv[1], 'alive'), 250); setInterval(() => {}, 1000)" ${JSON.stringify(markerPath)} &`,
          'printf \'{"session_id":"gemini-session-clean","response":"ok"}\\n\'',
          "exit 0"
        ].join("\n"),
        { mode: 0o755 }
      )

      const result = await geminiLocalAdapter.execute(
        buildContext(workspace.repoPath, fakeGeminiPath, {
          extraEnv: { OPENCLAW_GEMINI_TIMEOUT_MS: "1000" }
        })
      )
      await new Promise((resolve) => setTimeout(resolve, 500))

      expect(result.ok).toBe(true)
      expect(result.response).toBe("ok")
      expect(existsSync(markerPath)).toBe(false)
    } finally {
      workspace.cleanup()
    }
  })

  it("maps Gemini 3 aliases to CLI-supported model ids", () => {
    expect(__internal.resolveGeminiModel("gemini-3.1-pro")).toBe("gemini-3.1-pro-preview")
    expect(__internal.resolveGeminiModel("gemini-3.1-flash")).toBe("gemini-3-flash-preview")
    expect(__internal.resolveGeminiModel("gemini-2.5-pro")).toBe("gemini-2.5-pro")
  })

  it("uses a bounded ACP protocol inactivity timeout", () => {
    expect(__internal.geminiAcpxIdleTimeoutMs({})).toBe(15 * 60 * 1000)
    expect(__internal.geminiAcpxIdleTimeoutMs({ OPENCLAW_GEMINI_ACPX_IDLE_TIMEOUT_MS: "45000" })).toBe(45_000)
    expect(__internal.geminiAcpxIdleTimeoutMs({ OPENCLAW_GEMINI_ACPX_IDLE_TIMEOUT_MS: "invalid" })).toBe(15 * 60 * 1000)
  })

  it("caps ACP wall time even when the generic Gemini timeout is extended", () => {
    expect(__internal.geminiAcpxWallTimeoutMs({ OPENCLAW_GEMINI_TIMEOUT_MS: "21600000" })).toBe(20 * 60 * 1000)
    expect(
      __internal.geminiAcpxWallTimeoutMs({
        OPENCLAW_GEMINI_TIMEOUT_MS: "21600000",
        OPENCLAW_GEMINI_ACPX_WALL_TIMEOUT_MS: "900000"
      })
    ).toBe(900_000)
    expect(
      __internal.geminiAcpxWallTimeoutMs({
        OPENCLAW_GEMINI_TIMEOUT_MS: "120000",
        OPENCLAW_GEMINI_ACPX_WALL_TIMEOUT_MS: "900000"
      })
    ).toBe(120_000)
  })

  it("caps the total ACP fallback ladder when the generic timeout is extended", () => {
    expect(__internal.geminiAcpxTotalTimeoutMs({ OPENCLAW_GEMINI_TIMEOUT_MS: "21600000" })).toBe(30 * 60 * 1000)
    expect(
      __internal.geminiAcpxTotalTimeoutMs({
        OPENCLAW_GEMINI_TIMEOUT_MS: "21600000",
        OPENCLAW_GEMINI_ACPX_TOTAL_TIMEOUT_MS: "1200000"
      })
    ).toBe(1_200_000)
    expect(
      __internal.geminiAcpxTotalTimeoutMs({
        OPENCLAW_GEMINI_TIMEOUT_MS: "120000",
        OPENCLAW_GEMINI_ACPX_TOTAL_TIMEOUT_MS: "1200000"
      })
    ).toBe(120_000)
  })

  it("reserves a fair wall-clock share for every remaining ACP fallback model", () => {
    expect(
      __internal.geminiAcpxAttemptTimeoutMs({
        remainingTotalTimeoutMs: 1_200_000,
        remainingModels: 6,
        configuredWallTimeoutMs: 900_000
      })
    ).toBe(200_000)
    expect(
      __internal.geminiAcpxAttemptTimeoutMs({
        remainingTotalTimeoutMs: 180_000,
        remainingModels: 1,
        configuredWallTimeoutMs: 900_000
      })
    ).toBe(180_000)
    expect(
      __internal.geminiAcpxAttemptTimeoutMs({
        remainingTotalTimeoutMs: 1_200_000,
        remainingModels: 6,
        configuredWallTimeoutMs: 50_000
      })
    ).toBe(50_000)
  })

  it("stably staggers concurrent ACP fallback ladders within a configured bound", () => {
    const env = { OPENCLAW_GEMINI_ACPX_FALLBACK_JITTER_MS: "30000" }
    const delays = ["run-a", "run-b", "run-c"].map((executionKey) =>
      __internal.geminiAcpxFallbackDelayMs(executionKey, 2, env)
    )

    expect(__internal.geminiAcpxFallbackJitterMs({})).toBe(0)
    expect(__internal.geminiAcpxFallbackJitterMs(env)).toBe(30_000)
    expect(__internal.geminiAcpxFallbackJitterMs({ OPENCLAW_GEMINI_ACPX_FALLBACK_JITTER_MS: "invalid" })).toBe(0)
    expect(delays.every((delayMs) => delayMs >= 0 && delayMs <= 30_000)).toBe(true)
    expect(new Set(delays).size).toBeGreaterThan(1)
    expect(__internal.geminiAcpxFallbackDelayMs("run-a", 2, env)).toBe(delays[0])
  })

  it("deduplicates configured ACP model fallbacks", () => {
    const agent = {
      model: "opencode/primary",
      env: {
        OPENCLAW_GEMINI_ACPX_MODEL: "opencode/primary",
        OPENCLAW_GEMINI_ACPX_MODEL_FALLBACKS: " opencode/fallback,opencode/primary,opencode/fallback "
      }
    } as Agent

    expect(__internal.configuredAcpxModels(agent)).toEqual(["opencode/primary", "opencode/fallback"])
  })

  it("runs Gemini ACPX sessions outside the repo root and prefixes repo-root guidance", async () => {
    const workspace = createTempWorkspace("gemini-acpx-cwd")
    try {
      const fakeAcpxPath = join(workspace.root, "fake-acpx.py")
      const invocationDumpPath = join(workspace.root, "gemini-invocations.json")

      writeFileSync(
        fakeAcpxPath,
        [
          "#!/usr/bin/env python3",
          "from pathlib import Path",
          "import json, os, sys",
          `dump_path = Path(${JSON.stringify(invocationDumpPath)})`,
          "argv = sys.argv[1:]",
          "payload = []",
          "if dump_path.exists():",
          "    payload = json.loads(dump_path.read_text(encoding='utf8'))",
          "payload.append({'argv': argv, 'cwd': os.getcwd(), 'stdin': sys.stdin.read()})",
          "dump_path.write_text(json.dumps(payload), encoding='utf8')",
          "if 'sessions' in argv and 'ensure' in argv:",
          "    print(json.dumps({'action': 'session_ensured', 'created': True, 'acpxSessionId': 'gemini-session-0'}))",
          "    raise SystemExit(0)",
          "if 'prompt' in argv:",
          "    print(json.dumps({'jsonrpc': '2.0', 'method': 'session/update', 'params': {'sessionId': 'gemini-session-1', 'update': {'sessionUpdate': 'agent_message_chunk', 'content': {'type': 'text', 'text': 'ok'}}}}))",
          "    raise SystemExit(0)",
          "print(json.dumps({'action': 'noop'}))"
        ].join("\n"),
        { mode: 0o755 }
      )

      const context = buildContext(workspace.repoPath, fakeAcpxPath, {
        extraEnv: { OPENCLAW_SESSION_CWD: dirname(workspace.repoPath) }
      })
      const result = await geminiLocalAdapter.execute(context)

      expect(result.ok).toBe(true)
      const invocations = JSON.parse(readFileSync(invocationDumpPath, "utf8")) as Array<{
        argv: string[]
        cwd: string
        stdin: string
      }>
      expect(invocations).toHaveLength(1)

      expect(invocations[0]?.cwd).toBe(realpathSync(dirname(workspace.repoPath)))
      expect(invocations[0]?.argv).toContain("gemini-3-flash-preview")
      expect(invocations[0]?.argv).toContain("--include-directories")
      expect(invocations[0]?.argv).toContain(workspace.repoPath)
      expect(invocations[0]?.stdin).toBe("Reply ok")
    } finally {
      workspace.cleanup()
    }
  })
})
