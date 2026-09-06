import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Persona } from "@openclaw/domain"
import { afterEach, describe, expect, it } from "vitest"
import { syncOpenClawNativePersonas } from "../apps/dispatcher-cli/src/openclaw-native.js"
import { createTempWorkspace } from "./helpers.js"

describe("native OpenClaw persona synchronization", () => {
  const cleanups: Array<() => void> = []

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup()
  })

  it("creates missing agents, writes persona workspaces, and enables native handoffs", () => {
    const workspace = createTempWorkspace("openclaw-native-personas")
    cleanups.push(workspace.cleanup)
    const logPath = join(workspace.root, "calls.jsonl")
    const command = join(workspace.root, "openclaw")
    writeFileSync(
      command,
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs")',
        "const argv = process.argv.slice(2)",
        'const event = { argv, patch: argv[0] === "config" && argv[1] === "patch" ? JSON.parse(fs.readFileSync(argv[3], "utf8")) : null }',
        'fs.appendFileSync(process.env.OPENCLAW_NATIVE_TEST_LOG, JSON.stringify(event) + "\\n")',
        'if (argv[0] === "agents" && argv[1] === "list") {',
        '  process.stdout.write(JSON.stringify([{ id: "main", workspace: "/configured/main" }, { id: "planner", workspace: "/configured/planner" }, { id: "reviewer", workspace: "/configured/reviewer" }, { id: "promoter", workspace: "/configured/promoter" }]))',
        '} else if (argv[0] === "config" && argv[1] === "get") {',
        '  process.stdout.write(JSON.stringify({ primary: "openai/gpt-5.4", fallbacks: ["openai/gpt-5.4-mini", "openai/gpt-5.5"] }))',
        "} else {",
        "  process.stdout.write(JSON.stringify({ ok: true }))",
        "}"
      ].join("\n"),
      { mode: 0o755 }
    )
    const instructionsPath = join(workspace.root, "backend.md")
    writeFileSync(instructionsPath, "Own backend reliability and tests.\n", "utf8")
    const base = {
      companyId: "company-1",
      preferredAdapterType: "codex_local" as const,
      status: "active" as const,
      budgetLimit: null,
      budgetWindow: "monthly" as const,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z"
    }
    const personas: Persona[] = [
      {
        ...base,
        id: "persona-planner-uuid",
        name: "Planner",
        stage: "planner",
        ownedLanes: ["planning"],
        instructionsPath: null
      },
      {
        ...base,
        id: "backend-engineer",
        name: "Backend Engineer",
        stage: "coder",
        ownedLanes: ["backend"],
        instructionsPath
      }
    ]

    const previousLog = process.env.OPENCLAW_NATIVE_TEST_LOG
    process.env.OPENCLAW_NATIVE_TEST_LOG = logPath
    try {
      const result = syncOpenClawNativePersonas({
        personas,
        projectName: "OpenClaw Framework",
        openclawCommand: command,
        workspaceRoot: join(workspace.root, "native-workspaces"),
        enableHandoffs: true
      })

      expect(result.createdAgentIds).toEqual(["backend-engineer"])
      expect(result.workspaceMismatches).toEqual([
        {
          agentId: "planner",
          configured: "/configured/planner",
          expected: join(workspace.root, "native-workspaces", "planner")
        }
      ])
      const agentInstructions = readFileSync(
        join(workspace.root, "native-workspaces", "backend-engineer", "AGENTS.md"),
        "utf8"
      )
      expect(agentInstructions).toContain("Own backend reliability and tests.")
      expect(agentInstructions).toContain("sessions_spawn")
      expect(agentInstructions).toContain("never invoke standalone account-switching helpers")

      const calls = readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      expect(calls.some((entry) => entry.argv.slice(0, 3).join(" ") === "agents add backend-engineer")).toBe(true)
      const patches = calls
        .filter((entry) => entry.argv.slice(0, 2).join(" ") === "config patch")
        .map((entry) => entry.patch)
      const modelPolicy = patches.find((patch) => patch.agents.entries["backend-engineer"]?.model)
      expect(modelPolicy.agents.entries["backend-engineer"].model).toEqual({
        primary: "openai/gpt-5.4",
        fallbacks: ["openai/gpt-5.4-mini", "openai/gpt-5.5"]
      })
      const policy = patches.find((patch) => patch.agents.entries.main?.subagents)
      expect(policy.agents.entries.main.subagents.allowAgents).toEqual([
        "planner",
        "reviewer",
        "promoter",
        "backend-engineer"
      ])
      expect(policy.agents.entries.planner.subagents.allowAgents).toEqual([
        "main",
        "reviewer",
        "promoter",
        "backend-engineer"
      ])
      expect(policy.agents.entries.reviewer.subagents.allowAgents).toEqual([])
      expect(policy.agents.entries.promoter.subagents.allowAgents).toEqual(["reviewer"])
      expect(policy.agents.entries["backend-engineer"].subagents.allowAgents).toEqual(["reviewer"])
    } finally {
      if (previousLog === undefined) delete process.env.OPENCLAW_NATIVE_TEST_LOG
      else process.env.OPENCLAW_NATIVE_TEST_LOG = previousLog
    }
  })

  it("bounds a hung OpenClaw CLI during persona synchronization", () => {
    const workspace = createTempWorkspace("openclaw-native-timeout")
    cleanups.push(workspace.cleanup)
    const command = join(workspace.root, "openclaw")
    writeFileSync(
      command,
      [
        "#!/usr/bin/env node",
        "const argv = process.argv.slice(2)",
        'if (argv[0] === "config" && argv[1] === "get") {',
        '  process.stdout.write(JSON.stringify({ primary: "openai/gpt-5.4", fallbacks: [] }))',
        '} else if (argv[0] === "agents" && argv[1] === "list") {',
        "  setTimeout(() => process.stdout.write('[]'), 5000)",
        "}"
      ].join("\n"),
      { mode: 0o755 }
    )
    const previousTimeout = process.env.OPENCLAW_NATIVE_SYNC_COMMAND_TIMEOUT_MS
    process.env.OPENCLAW_NATIVE_SYNC_COMMAND_TIMEOUT_MS = "100"
    try {
      expect(() =>
        syncOpenClawNativePersonas({
          personas: [],
          projectName: "timeout-test",
          openclawCommand: command,
          workspaceRoot: join(workspace.root, "native-workspaces"),
          apply: false
        })
      ).toThrow()
    } finally {
      if (previousTimeout === undefined) delete process.env.OPENCLAW_NATIVE_SYNC_COMMAND_TIMEOUT_MS
      else process.env.OPENCLAW_NATIVE_SYNC_COMMAND_TIMEOUT_MS = previousTimeout
    }
  })

  it("accepts a timed-out config patch only after verifying its persisted state", () => {
    const workspace = createTempWorkspace("openclaw-native-persisted-timeout")
    cleanups.push(workspace.cleanup)
    const command = join(workspace.root, "openclaw")
    const statePath = join(workspace.root, "config-state.json")
    writeFileSync(
      command,
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs")',
        "const argv = process.argv.slice(2)",
        'if (argv[0] === "config" && argv[1] === "get") {',
        '  if (argv[2] === "agents.defaults.model") {',
        '    process.stdout.write(JSON.stringify({ primary: "openai/gpt-5.4", fallbacks: ["openai/gpt-5.5"] }))',
        "  } else {",
        '    const state = fs.existsSync(process.env.OPENCLAW_NATIVE_TEST_STATE) ? JSON.parse(fs.readFileSync(process.env.OPENCLAW_NATIVE_TEST_STATE, "utf8")) : {}',
        '    const value = argv[2] === "agents.entries" ? state.agents?.entries : state.agents?.defaults',
        "    process.stdout.write(JSON.stringify(value || {}))",
        "  }",
        '} else if (argv[0] === "agents" && argv[1] === "list") {',
        '  process.stdout.write(JSON.stringify([{ id: "backend-engineer", workspace: process.env.OPENCLAW_NATIVE_TEST_WORKSPACE }]))',
        '} else if (argv[0] === "config" && argv[1] === "patch") {',
        '  fs.writeFileSync(process.env.OPENCLAW_NATIVE_TEST_STATE, fs.readFileSync(argv[3], "utf8"))',
        "  setTimeout(() => {}, 5000)",
        "}"
      ].join("\n"),
      { mode: 0o755 }
    )
    const base = {
      companyId: "company-1",
      preferredAdapterType: "codex_local" as const,
      status: "active" as const,
      budgetLimit: null,
      budgetWindow: "monthly" as const,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z"
    }
    const personas: Persona[] = [
      {
        ...base,
        id: "backend-engineer",
        name: "Backend Engineer",
        stage: "coder",
        ownedLanes: ["backend"],
        instructionsPath: null
      }
    ]
    const nativeWorkspace = join(workspace.root, "native-workspaces", "backend-engineer")
    const previousTimeout = process.env.OPENCLAW_NATIVE_SYNC_COMMAND_TIMEOUT_MS
    const previousState = process.env.OPENCLAW_NATIVE_TEST_STATE
    const previousWorkspace = process.env.OPENCLAW_NATIVE_TEST_WORKSPACE
    process.env.OPENCLAW_NATIVE_SYNC_COMMAND_TIMEOUT_MS = "1000"
    process.env.OPENCLAW_NATIVE_TEST_STATE = statePath
    process.env.OPENCLAW_NATIVE_TEST_WORKSPACE = nativeWorkspace
    try {
      const result = syncOpenClawNativePersonas({
        personas,
        projectName: "persisted-timeout-test",
        openclawCommand: command,
        workspaceRoot: join(workspace.root, "native-workspaces"),
        enableHandoffs: true
      })
      expect(result.createdAgentIds).toEqual([])
      expect(result.subagentPolicyUpdated).toBe(true)
      const state = JSON.parse(readFileSync(statePath, "utf8"))
      expect(state.agents.defaults.subagents.maxSpawnDepth).toBe(2)
      expect(state.agents.entries["backend-engineer"].subagents.allowAgents).toEqual([])
    } finally {
      if (previousTimeout === undefined) delete process.env.OPENCLAW_NATIVE_SYNC_COMMAND_TIMEOUT_MS
      else process.env.OPENCLAW_NATIVE_SYNC_COMMAND_TIMEOUT_MS = previousTimeout
      if (previousState === undefined) delete process.env.OPENCLAW_NATIVE_TEST_STATE
      else process.env.OPENCLAW_NATIVE_TEST_STATE = previousState
      if (previousWorkspace === undefined) delete process.env.OPENCLAW_NATIVE_TEST_WORKSPACE
      else process.env.OPENCLAW_NATIVE_TEST_WORKSPACE = previousWorkspace
    }
  })
})
