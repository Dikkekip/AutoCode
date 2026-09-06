import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import type { Persona } from "@openclaw/domain"

type NativeAgentRecord = {
  id?: unknown
  workspace?: unknown
  model?: unknown
}

type NativeModelPolicy = {
  primary: string
  fallbacks: string[]
}

const DEFAULT_NATIVE_SYNC_COMMAND_TIMEOUT_MS = 60_000

function nativeSyncCommandTimeoutMs(): number {
  const configured = Number.parseInt(process.env.OPENCLAW_NATIVE_SYNC_COMMAND_TIMEOUT_MS ?? "", 10)
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_NATIVE_SYNC_COMMAND_TIMEOUT_MS
}

export type NativePersonaSyncResult = {
  requestedAgentIds: string[]
  existingAgentIds: string[]
  createdAgentIds: string[]
  updatedWorkspaceIds: string[]
  workspaceMismatches: Array<{ agentId: string; configured: string; expected: string }>
  subagentPolicyUpdated: boolean
}

export type NativePersonaSyncInput = {
  personas: Persona[]
  projectName: string
  openclawCommand?: string | undefined
  workspaceRoot?: string | undefined
  model?: string | undefined
  apply?: boolean | undefined
  enableHandoffs?: boolean | undefined
}

function defaultOpenClawCommand(): string {
  const configured = process.env.OPENCLAW_COMMAND?.trim()
  if (configured) return configured
  const local = join(process.env.HOME ?? "", ".local", "npm", "bin", "openclaw")
  return existsSync(local) ? local : "openclaw"
}

function defaultNativeWorkspaceRoot(): string {
  return join(process.env.HOME ?? "", ".openclaw", "native-agent-workspaces")
}

function safeAgentId(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
  if (!normalized || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalized)) {
    throw new Error(`Cannot map persona id "${value}" to a valid OpenClaw agent id`)
  }
  return normalized
}

function personaAgentId(persona: Persona): string {
  return safeAgentId(persona.name)
}

function runJson(command: string, args: string[]): any {
  const stdout = execFileSync(command, args, {
    env: process.env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: nativeSyncCommandTimeoutMs(),
    killSignal: "SIGTERM"
  })
  return JSON.parse(stdout)
}

function readNativeModelPolicy(command: string, primary: string): NativeModelPolicy {
  try {
    const configured = runJson(command, ["config", "get", "agents.defaults.model", "--json"])
    const fallbacks = Array.isArray(configured?.fallbacks)
      ? configured.fallbacks.filter((entry: unknown): entry is string => typeof entry === "string" && entry !== primary)
      : []
    return { primary, fallbacks }
  } catch {
    return { primary, fallbacks: [] }
  }
}

function applyPersonaModelPolicy(command: string, personas: Persona[], modelPolicy: NativeModelPolicy): void {
  const patch = {
    agents: {
      entries: Object.fromEntries(personas.map((persona) => [personaAgentId(persona), { model: modelPolicy }]))
    }
  }
  applyConfigPatch(command, "openclaw-native-models-", patch)
}

function applyConfigPatch(command: string, prefix: string, patch: Record<string, unknown>): void {
  const tempDir = mkdtempSync(join(tmpdir(), prefix))
  const patchPath = join(tempDir, "openclaw.patch.json")
  try {
    writeFileSync(patchPath, JSON.stringify(patch, null, 2), "utf8")
    const result = spawnSync(command, ["config", "patch", "--file", patchPath], {
      env: process.env,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: nativeSyncCommandTimeoutMs(),
      killSignal: "SIGTERM"
    })
    if (result.status === 0) return
    if (configPatchApplied(command, patch)) return
    const detail =
      result.error?.message || result.stderr?.trim() || result.stdout?.trim() || `exit status ${String(result.status)}`
    throw new Error(`OpenClaw config patch failed: ${detail}`)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

function deeplyContains(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((entry, index) => deeplyContains(actual[index], entry))
    )
  }
  if (expected && typeof expected === "object") {
    if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false
    return Object.entries(expected).every(([key, value]) =>
      deeplyContains((actual as Record<string, unknown>)[key], value)
    )
  }
  return Object.is(actual, expected)
}

function configPatchApplied(command: string, patch: Record<string, unknown>): boolean {
  const expectedAgents = patch.agents
  if (!expectedAgents || typeof expectedAgents !== "object" || Array.isArray(expectedAgents)) return false
  try {
    const expected = expectedAgents as Record<string, unknown>
    const actual: Record<string, unknown> = {}
    if (Object.hasOwn(expected, "entries")) {
      actual.entries = runJson(command, ["config", "get", "agents.entries", "--json"])
    }
    if (Object.hasOwn(expected, "defaults")) {
      actual.defaults = runJson(command, ["config", "get", "agents.defaults", "--json"])
    }
    return deeplyContains(actual, expected)
  } catch {
    return false
  }
}

function nativeAgentExists(command: string, agentId: string): boolean {
  try {
    const listed = runJson(command, ["agents", "list", "--json"])
    return Array.isArray(listed) && listed.some((record) => record?.id === agentId)
  } catch {
    return false
  }
}

function readPersonaInstructions(persona: Persona): string | null {
  if (!persona.instructionsPath || !existsSync(persona.instructionsPath)) return null
  try {
    return readFileSync(persona.instructionsPath, "utf8").trim()
  } catch {
    return null
  }
}

function renderNativeAgentInstructions(persona: Persona, projectName: string): string {
  const sourceInstructions = readPersonaInstructions(persona)
  return [
    `# Native OpenClaw Persona: ${persona.name}`,
    "",
    `You are the ${persona.name} persona for ${projectName}.`,
    "",
    "## Ownership",
    "",
    `- Persona id: ${persona.id}`,
    `- Stage: ${persona.stage}`,
    `- Owned lanes: ${persona.ownedLanes.join(", ") || "general"}`,
    `- Dispatcher adapter compatibility id: ${persona.preferredAdapterType}`,
    "",
    "## Native execution",
    "",
    "- Work only in the cwd supplied by the OpenClaw session.",
    "- Use native sessions_spawn/subagent tools for independent parallel work only when the configured allow-list authorizes it.",
    "- Use configured OpenClaw provider accounts and model fallback; never invoke standalone account-switching helpers.",
    "- Preserve task scope, required reading, acceptance criteria, and verification instructions from the dispatch prompt.",
    "- Return concrete evidence and handoff details to the owning OpenClaw session.",
    ...(sourceInstructions
      ? ["", "## Repository persona instructions", "", sourceInstructions]
      : ["", "## Repository persona instructions", "", "- No additional persona file was configured."])
  ].join("\n")
}

function renderIdentity(persona: Persona): string {
  return [
    "# IDENTITY.md",
    "",
    `- **Name:** ${persona.name}`,
    `- **Theme:** ${persona.stage} persona`,
    "- **Emoji:** 🦞",
    ""
  ].join("\n")
}

function ensureNativeWorkspace(persona: Persona, root: string, projectName: string, apply: boolean): string {
  const agentId = personaAgentId(persona)
  const workspace = join(root, agentId)
  if (!apply) return workspace
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(workspace, "AGENTS.md"), `${renderNativeAgentInstructions(persona, projectName)}\n`, "utf8")
  writeFileSync(join(workspace, "IDENTITY.md"), renderIdentity(persona), "utf8")
  if (!existsSync(join(workspace, "SOUL.md"))) {
    writeFileSync(
      join(workspace, "SOUL.md"),
      `# SOUL.md\n\nBe a decisive, evidence-driven ${persona.name}. Collaborate through OpenClaw native sessions.\n`,
      "utf8"
    )
  }
  return workspace
}

function applySubagentPolicy(command: string, personas: Persona[], existingAgentIds: string[]): void {
  const personaIds = personas.map(personaAgentId)
  const allAgentIds = Array.from(new Set([...existingAgentIds, ...personaIds]))
  const reviewerIds = allAgentIds.includes("reviewer") ? ["reviewer"] : []
  const entries: Record<string, { subagents: { allowAgents: string[] } }> = {
    main: { subagents: { allowAgents: allAgentIds.filter((agentId) => agentId !== "main") } },
    planner: { subagents: { allowAgents: allAgentIds.filter((agentId) => agentId !== "planner") } }
  }
  if (allAgentIds.includes("reviewer")) {
    entries.reviewer = { subagents: { allowAgents: [] } }
  }
  if (allAgentIds.includes("promoter")) {
    entries.promoter = { subagents: { allowAgents: reviewerIds } }
  }
  for (const persona of personas) {
    const agentId = personaAgentId(persona)
    if (agentId === "planner") continue
    entries[agentId] = {
      subagents: {
        allowAgents: persona.stage === "coder" || persona.stage === "promoter" ? reviewerIds : []
      }
    }
  }
  const patch = {
    agents: {
      defaults: {
        subagents: {
          maxConcurrent: Math.max(8, allAgentIds.length),
          maxSpawnDepth: 2,
          maxChildrenPerAgent: Math.max(5, Math.min(allAgentIds.length, 12))
        }
      },
      entries
    }
  }
  applyConfigPatch(command, "openclaw-native-personas-", patch)
}

export function syncOpenClawNativePersonas(input: NativePersonaSyncInput): NativePersonaSyncResult {
  const command = input.openclawCommand?.trim() || defaultOpenClawCommand()
  const workspaceRoot = input.workspaceRoot ?? defaultNativeWorkspaceRoot()
  const model = input.model?.trim() || "openai/gpt-5.4"
  const modelPolicy = readNativeModelPolicy(command, model)
  const apply = input.apply !== false
  const personas = [...input.personas].sort((left, right) => left.id.localeCompare(right.id))
  const requestedAgentIds = personas.map(personaAgentId)
  if (new Set(requestedAgentIds).size !== requestedAgentIds.length) {
    throw new Error("Runtime persona names must map to unique native OpenClaw agent ids")
  }
  const listed = runJson(command, ["agents", "list", "--json"])
  const records = Array.isArray(listed) ? (listed as NativeAgentRecord[]) : []
  const existing = new Map(
    records
      .filter((record): record is NativeAgentRecord & { id: string } => typeof record.id === "string")
      .map((record) => [record.id, record])
  )
  const createdAgentIds: string[] = []
  const updatedWorkspaceIds: string[] = []
  const workspaceMismatches: NativePersonaSyncResult["workspaceMismatches"] = []

  for (const persona of personas) {
    const agentId = personaAgentId(persona)
    const workspace = ensureNativeWorkspace(persona, workspaceRoot, input.projectName, apply)
    updatedWorkspaceIds.push(agentId)
    const current = existing.get(agentId)
    if (current) {
      const configured = typeof current.workspace === "string" ? current.workspace : ""
      if (configured && configured !== workspace) workspaceMismatches.push({ agentId, configured, expected: workspace })
      continue
    }
    if (apply) {
      try {
        runJson(command, [
          "agents",
          "add",
          agentId,
          "--non-interactive",
          "--workspace",
          workspace,
          "--model",
          model,
          "--json"
        ])
      } catch (error) {
        if (!nativeAgentExists(command, agentId)) throw error
      }
    }
    createdAgentIds.push(agentId)
  }

  const existingAgentIds = records.map((record) => String(record.id ?? "")).filter(Boolean)
  if (apply) applyPersonaModelPolicy(command, personas, modelPolicy)
  if (apply && input.enableHandoffs === true) applySubagentPolicy(command, personas, existingAgentIds)
  return {
    requestedAgentIds,
    existingAgentIds,
    createdAgentIds,
    updatedWorkspaceIds,
    workspaceMismatches,
    subagentPolicyUpdated: apply && input.enableHandoffs === true
  }
}

export function nativeWorkspaceLabel(path: string): string {
  return basename(dirname(path)) === "native-agent-workspaces" ? basename(path) : path
}
