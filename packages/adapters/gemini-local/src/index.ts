import { execFileSync } from "node:child_process"
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { dirname, relative, resolve, sep } from "node:path"
import {
  buildAcpxEnv,
  commandExists,
  type PreparedAcpxInvocation,
  resolveSessionCwd,
  runPreparedAcpxInvocationAsync
} from "@openclaw/acpx"
import type {
  AdapterContinuationState,
  AdapterDefinition,
  AdapterExecutionContext,
  AdapterExecutionResult,
  AdapterHealthcheckResult,
  AdapterResultMetadata,
  Agent,
  SessionState
} from "@openclaw/domain"

const BLOCKED_GEMINI_ENV_KEYS = [
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CREDENTIALS",
  "GOOGLE_SERVICE_ACCOUNT_AUTH",
  "GOOGLE_CLOUD_ACCESS_TOKEN",
  "GOOGLE_CLOUD_ACCOUNT",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_PROJECT_ID",
  "GOOGLE_CLOUD_QUOTA_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_CLOUD_REGION",
  "GCLOUD_PROJECT",
  "CLOUDSDK_CONFIG",
  "CLOUDSDK_CONFIG_DIRECTORY",
  "CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE",
  "CLOUDSDK_CORE_ACCOUNT",
  "CLOUDSDK_CORE_PROJECT",
  "GOOGLE_API_KEY",
  "GOOGLE_GENAI_API_KEY",
  "GEMINI_API_KEY",
  "VERTEX_PROJECT",
  "VERTEX_LOCATION",
  "GOOGLE_GENAI_USE_GCA",
  "GOOGLE_GENAI_USE_VERTEXAI"
] as const
const DEFAULT_GEMINI_TIMEOUT_MS = 300_000
const DEFAULT_GEMINI_ACPX_IDLE_TIMEOUT_MS = 15 * 60 * 1000
const DEFAULT_GEMINI_ACPX_WALL_TIMEOUT_MS = 20 * 60 * 1000
const DEFAULT_GEMINI_ACPX_TOTAL_TIMEOUT_MS = 30 * 60 * 1000
const DEFAULT_GEMINI_ACPX_FALLBACK_JITTER_MS = 0
const ACPX_AGENT_COMMAND_ENV = "OPENCLAW_GEMINI_ACPX_AGENT_COMMAND"
const ACPX_AGENT_LOG_LEVEL_ENV = "OPENCLAW_GEMINI_ACPX_AGENT_LOG_LEVEL"
const ACPX_MODEL_ENV = "OPENCLAW_GEMINI_ACPX_MODEL"
const ACPX_MODEL_FALLBACKS_ENV = "OPENCLAW_GEMINI_ACPX_MODEL_FALLBACKS"
const ACPX_MODEL_FALLBACK_FAILURES = new Set(["auth", "quota", "model-not-found", "transport", "timeout"])
const GEMINI_CAPABILITIES = {
  supportsSessionResume: true,
  supportsCompaction: true,
  compactionStrategy: "summarize",
  preferredPlanningContextWindow: 1000000,
  planningPriority: 80,
  planningCostClass: "medium",
  nativeContextManagement: "unknown",
  heartbeatIdentityMode: "prompt_and_env",
  defaultSessionCompaction: {
    enabled: true,
    maxSessionRuns: 200,
    maxRawInputTokens: 2_000_000,
    maxSessionAgeHours: 72
  }
} as const

const GEMINI_MODEL_ALIASES: Record<string, string> = {
  "gemini-3.1-pro": "gemini-3.1-pro-preview",
  "gemini-3.1-pro-preview": "gemini-3.1-pro-preview",
  "gemini-3.1-flash": "gemini-3-flash-preview",
  "gemini-3-flash": "gemini-3-flash-preview",
  "gemini-3-flash-preview": "gemini-3-flash-preview"
}

type UntrackedWorkspaceEntry = { kind: "file"; content: Buffer; mode: number } | { kind: "symlink"; target: string }

type AcpxWorkspaceCheckpoint = {
  repoPath: string
  headSha: string
  trackedStashRef: string | null
  untrackedEntries: Map<string, UntrackedWorkspaceEntry>
}

function gitOutput(repoPath: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repoPath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim()
}

function untrackedWorkspacePaths(repoPath: string): string[] {
  return gitOutput(repoPath, ["ls-files", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .map((path) => path.trim())
    .filter(Boolean)
}

function safeWorkspacePath(repoPath: string, path: string): string {
  const absolutePath = resolve(repoPath, path)
  const relativePath = relative(repoPath, absolutePath)
  if (!relativePath || relativePath.startsWith(`..${sep}`) || relativePath === "..") {
    throw new Error(`Refusing to restore unsafe workspace path: ${path}`)
  }
  return absolutePath
}

function isGitWorkspace(repoPath: string): boolean {
  try {
    return gitOutput(repoPath, ["rev-parse", "--is-inside-work-tree"]) === "true"
  } catch {
    return false
  }
}

function captureAcpxWorkspaceCheckpoint(repoPath: string): AcpxWorkspaceCheckpoint | null {
  try {
    if (!isGitWorkspace(repoPath)) return null
    const headSha = gitOutput(repoPath, ["rev-parse", "HEAD"])
    const trackedStashRef = gitOutput(repoPath, ["stash", "create", "openclaw-acpx-fallback-checkpoint"]) || null
    const untrackedEntries = new Map<string, UntrackedWorkspaceEntry>()
    for (const path of untrackedWorkspacePaths(repoPath)) {
      const absolutePath = safeWorkspacePath(repoPath, path)
      const stat = lstatSync(absolutePath)
      if (stat.isSymbolicLink()) {
        untrackedEntries.set(path, { kind: "symlink", target: readlinkSync(absolutePath) })
      } else if (stat.isFile()) {
        untrackedEntries.set(path, { kind: "file", content: readFileSync(absolutePath), mode: stat.mode })
      }
    }
    return { repoPath, headSha, trackedStashRef, untrackedEntries }
  } catch {
    return null
  }
}

function restoreAcpxWorkspaceCheckpoint(checkpoint: AcpxWorkspaceCheckpoint): {
  restored: boolean
  removedUntrackedPaths: string[]
  error: string | null
} {
  try {
    const currentUntrackedPaths = untrackedWorkspacePaths(checkpoint.repoPath)
    const removedUntrackedPaths = currentUntrackedPaths.filter((path) => !checkpoint.untrackedEntries.has(path))
    gitOutput(checkpoint.repoPath, ["reset", "--hard", checkpoint.headSha])
    for (const path of removedUntrackedPaths) {
      rmSync(safeWorkspacePath(checkpoint.repoPath, path), { recursive: true, force: true })
    }
    if (checkpoint.trackedStashRef) {
      gitOutput(checkpoint.repoPath, ["stash", "apply", "--index", checkpoint.trackedStashRef])
    }
    for (const [path, entry] of checkpoint.untrackedEntries) {
      const absolutePath = safeWorkspacePath(checkpoint.repoPath, path)
      rmSync(absolutePath, { recursive: true, force: true })
      mkdirSync(dirname(absolutePath), { recursive: true })
      if (entry.kind === "symlink") {
        symlinkSync(entry.target, absolutePath)
      } else {
        writeFileSync(absolutePath, entry.content)
        chmodSync(absolutePath, entry.mode)
      }
    }
    return { restored: true, removedUntrackedPaths, error: null }
  } catch (error) {
    return {
      restored: false,
      removedUntrackedPaths: [],
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

function resolveGeminiModel(model: string | null | undefined): string | null {
  if (!model) return null
  return GEMINI_MODEL_ALIASES[model] ?? model
}

function geminiTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OPENCLAW_GEMINI_TIMEOUT_MS?.trim()
  if (!raw) return DEFAULT_GEMINI_TIMEOUT_MS
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_GEMINI_TIMEOUT_MS
}

function geminiAcpxIdleTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OPENCLAW_GEMINI_ACPX_IDLE_TIMEOUT_MS?.trim()
  if (!raw) return DEFAULT_GEMINI_ACPX_IDLE_TIMEOUT_MS
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_GEMINI_ACPX_IDLE_TIMEOUT_MS
}

function geminiAcpxWallTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OPENCLAW_GEMINI_ACPX_WALL_TIMEOUT_MS?.trim()
  const parsed = raw ? Number.parseInt(raw, 10) : DEFAULT_GEMINI_ACPX_WALL_TIMEOUT_MS
  const configured = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_GEMINI_ACPX_WALL_TIMEOUT_MS
  return Math.min(geminiTimeoutMs(env), configured)
}

function geminiAcpxTotalTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OPENCLAW_GEMINI_ACPX_TOTAL_TIMEOUT_MS?.trim()
  const parsed = raw ? Number.parseInt(raw, 10) : DEFAULT_GEMINI_ACPX_TOTAL_TIMEOUT_MS
  const configured = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_GEMINI_ACPX_TOTAL_TIMEOUT_MS
  return Math.min(geminiTimeoutMs(env), configured)
}

function geminiAcpxAttemptTimeoutMs(input: {
  remainingTotalTimeoutMs: number
  remainingModels: number
  configuredWallTimeoutMs: number
}): number {
  const remainingModels = Math.max(1, Math.floor(input.remainingModels))
  const fairShareMs = Math.max(1, Math.floor(input.remainingTotalTimeoutMs / remainingModels))
  return Math.max(1, Math.min(input.configuredWallTimeoutMs, fairShareMs))
}

function geminiAcpxFallbackJitterMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OPENCLAW_GEMINI_ACPX_FALLBACK_JITTER_MS?.trim()
  if (!raw) return DEFAULT_GEMINI_ACPX_FALLBACK_JITTER_MS
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_GEMINI_ACPX_FALLBACK_JITTER_MS
}

function stableHash(value: string): number {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function geminiAcpxFallbackDelayMs(
  executionKey: string,
  fallbackIndex: number,
  env: NodeJS.ProcessEnv = process.env
): number {
  const maxDelayMs = geminiAcpxFallbackJitterMs(env)
  if (maxDelayMs <= 0) return 0
  return stableHash(`${executionKey}:${fallbackIndex}`) % (maxDelayMs + 1)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function shouldIncludeRepoDirectory(context: AdapterExecutionContext): boolean {
  const raw = context.agent.env.OPENCLAW_GEMINI_INCLUDE_REPO ?? process.env.OPENCLAW_GEMINI_INCLUDE_REPO
  if (typeof raw !== "string") return true
  const normalized = raw.trim().toLowerCase()
  return !["0", "false", "no", "off"].includes(normalized)
}

function isOpenClawExecutionWorktree(repoPath: string): boolean {
  return (
    repoPath.includes("/.openclaw/state/current/worktrees/") ||
    repoPath.includes("\\.openclaw\\state\\current\\worktrees\\")
  )
}

function isCodeProducingTask(context: AdapterExecutionContext): boolean {
  return (
    context.task.kind === "implement" || context.task.kind === "repair" || context.task.kind === "fix_review_feedback"
  )
}

function resolveGeminiSessionCwd(context: AdapterExecutionContext): string {
  const configuredCwd = resolveSessionCwd(context)
  return isOpenClawExecutionWorktree(context.project.repoPath) ? context.project.repoPath : configuredCwd
}

function buildContinuationState(sessionId: string | null): AdapterContinuationState | null {
  if (!sessionId) return null
  return {
    sessionDisplayId: sessionId,
    state: { sessionId }
  }
}

function configuredAcpxAgentCommand(agent: Agent): string | null {
  const command = agent.env[ACPX_AGENT_COMMAND_ENV]?.trim()
  if (!command) return null
  if (!/(?:^|[\\/\s])opencode(?:\.exe)?\s+acp(?:\s|$)/i.test(command) || /--log-level(?:=|\s)/i.test(command)) {
    return command
  }
  const configuredLevel =
    agent.env[ACPX_AGENT_LOG_LEVEL_ENV]?.trim().toUpperCase() ||
    process.env[ACPX_AGENT_LOG_LEVEL_ENV]?.trim().toUpperCase() ||
    "WARN"
  const logLevel = ["DEBUG", "INFO", "WARN", "ERROR"].includes(configuredLevel) ? configuredLevel : "WARN"
  return `${command} --log-level ${logLevel}`
}

function configuredAcpxModel(agent: Agent): string | null {
  const model = agent.env[ACPX_MODEL_ENV]?.trim() || agent.model?.trim()
  return model || null
}

function configuredAcpxModels(agent: Agent): string[] {
  const primary = configuredAcpxModel(agent)
  const fallbacks = (agent.env[ACPX_MODEL_FALLBACKS_ENV] ?? "")
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean)
  return Array.from(new Set([primary, ...fallbacks].filter((model): model is string => Boolean(model))))
}

function contextForAcpxModel(context: AdapterExecutionContext, model: string): AdapterExecutionContext {
  const routing = context.runtimeIdentity.routing
  return {
    ...context,
    agent: {
      ...context.agent,
      model,
      env: {
        ...context.agent.env,
        [ACPX_MODEL_ENV]: model
      }
    },
    runtimeIdentity: {
      ...context.runtimeIdentity,
      model,
      ...(routing
        ? {
            routing: {
              ...routing,
              selectedModel: model,
              modelFamily: model,
              modelRoutingReason: `${routing.modelRoutingReason}; ACP fallback selected ${model}`
            }
          }
        : {})
    }
  }
}

function buildMetadata(context: AdapterExecutionContext): AdapterResultMetadata {
  const acpxAgentCommand = configuredAcpxAgentCommand(context.agent)
  return {
    adapterType: "gemini_local",
    provider: acpxAgentCommand ? "acpx" : "gemini",
    model: acpxAgentCommand ? configuredAcpxModel(context.agent) : context.agent.model,
    capabilities: GEMINI_CAPABILITIES,
    transport: "acpx"
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function valueAtPath(value: unknown, path: readonly string[]): unknown {
  let current: unknown = value
  for (const segment of path) {
    const record = asRecord(current)
    if (!record) return null
    current = record[segment]
  }
  return current
}

function stringAtPath(value: unknown, path: readonly string[]): string | null {
  const current = valueAtPath(value, path)
  return typeof current === "string" && current.trim() ? current : null
}

function findStringByKey(value: unknown, keys: readonly string[], depth = 0): string | null {
  if (depth > 6) return null
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findStringByKey(entry, keys, depth + 1)
      if (found) return found
    }
    return null
  }

  const record = asRecord(value)
  if (!record) return null

  for (const key of keys) {
    const direct = record[key]
    if (typeof direct === "string" && direct.trim()) return direct
  }

  for (const nested of Object.values(record)) {
    if (typeof nested !== "object" || nested === null) continue
    const found = findStringByKey(nested, keys, depth + 1)
    if (found) return found
  }

  return null
}

function extractSessionId(payload: Record<string, unknown>): string | null {
  const paths = [
    ["session_id"],
    ["sessionId"],
    ["conversation_id"],
    ["conversationId"],
    ["session", "id"],
    ["session", "session_id"],
    ["session", "sessionId"],
    ["conversation", "id"],
    ["params", "sessionId"],
    ["params", "session_id"],
    ["params", "session", "id"],
    ["params", "conversation", "id"],
    ["params", "update", "sessionId"],
    ["params", "update", "session_id"],
    ["metadata", "sessionId"],
    ["metadata", "session_id"]
  ] as const

  for (const path of paths) {
    const found = stringAtPath(payload, path)
    if (found) return found
  }

  return findStringByKey(payload, ["session_id", "sessionId", "conversation_id", "conversationId"])
}

function coerceText(value: unknown): string | null {
  if (typeof value === "string") return value
  if (Array.isArray(value)) {
    const parts = value.map((entry) => coerceText(entry)).filter((entry): entry is string => Boolean(entry))
    return parts.length > 0 ? parts.join("") : null
  }

  const record = asRecord(value)
  if (!record) return null
  return (
    coerceText(record.text) ??
    coerceText(record.content) ??
    coerceText(record.message) ??
    coerceText(record.delta) ??
    coerceText(record.parts) ??
    null
  )
}

function parseAdvertisedAcpxModels(message: string | null | undefined): string[] {
  const text = message?.trim()
  if (!text) return []
  const match = text.match(/Available models:\s*([\s\S]+)$/i)
  if (!match) return []
  return Array.from(
    new Set(
      (match[1] ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => entry.replace(/\.$/, ""))
        .filter((entry) => entry.includes("/"))
    )
  )
}

function parseJsonObjects(stdout: string): Record<string, any>[] {
  const parsed: Record<string, any>[] = []
  const seen = new Set<string>()

  const tryParse = (candidate: string): void => {
    const trimmed = candidate.trim()
    if (!trimmed || seen.has(trimmed)) return
    seen.add(trimmed)

    try {
      const value = JSON.parse(trimmed)
      const record = asRecord(value)
      if (record) parsed.push(record)
    } catch {}
  }

  for (const line of stdout.split(/\r?\n/)) {
    tryParse(line)
  }

  tryParse(stdout)

  let start = -1
  let depth = 0
  let inString = false
  let escaping = false

  for (let index = 0; index < stdout.length; index += 1) {
    const char = stdout[index]

    if (inString) {
      if (escaping) {
        escaping = false
      } else if (char === "\\") {
        escaping = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      continue
    }

    if (char === "{") {
      if (depth === 0) start = index
      depth += 1
      continue
    }

    if (char !== "}" || depth === 0) continue

    depth -= 1
    if (depth === 0 && start >= 0) {
      tryParse(stdout.slice(start, index + 1))
      start = -1
    }
  }

  return parsed
}

function parseGeminiPayload(stdout: string): {
  sessionId: string | null
  response: string | null
  totalTokens: number | null
  sawProtocol: boolean
  sawToolActivity: boolean
  protocolError: string | null
} | null {
  let sessionId: string | null = null
  let response: string | null = null
  let totalTokenCount: number | null = null
  let sawProtocol = false
  let sawToolActivity = false
  let protocolError: string | null = null

  for (const parsed of parseJsonObjects(stdout)) {
    const possibleSessionId = extractSessionId(parsed)
    if (possibleSessionId) sessionId = possibleSessionId

    const simpleResponse = coerceText(parsed.response)
    if (simpleResponse) response = (response ?? "") + simpleResponse
    if (typeof parsed.stats?.totalTokenCount === "number") totalTokenCount = parsed.stats.totalTokenCount

    if (parsed.jsonrpc === "2.0") {
      sawProtocol = true
      const error = asRecord(parsed.error)
      if (error) {
        protocolError =
          coerceText(error.message) ??
          coerceText(asRecord(error.data)?.message) ??
          "ACPX agent returned a JSON-RPC error."
      }
      const params = parsed.params || {}
      const update = params.update || {}
      if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
        sawToolActivity = true
      }
      if (update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_message") {
        const content = coerceText(update.content) ?? coerceText(update.message) ?? coerceText(update.delta)
        if (content) response = (response ?? "") + content
      }
      const resultUsage = asRecord(asRecord(parsed.result)?.usage)
      if (typeof resultUsage?.totalTokens === "number") {
        totalTokenCount = resultUsage.totalTokens
      }
    }
  }

  if (sessionId || response || totalTokenCount !== null || sawProtocol) {
    return {
      sessionId,
      response,
      totalTokens: totalTokenCount,
      sawProtocol,
      sawToolActivity,
      protocolError
    }
  }

  return null
}

function parseGeminiOutput(context: AdapterExecutionContext, stdout: string): AdapterExecutionResult {
  const payload = parseGeminiPayload(stdout)
  if (!payload) {
    return {
      ok: true,
      metadata: buildMetadata(context),
      continuation: null,
      runtimeIdentity: context.runtimeIdentity,
      response: stdout.trim(),
      stdout,
      stderr: ""
    }
  }

  if (payload.protocolError) {
    return {
      ok: false,
      error: `ACPX agent protocol error: ${payload.protocolError}`,
      failureCategory: "transport",
      metadata: buildMetadata(context),
      continuation: buildContinuationState(payload.sessionId),
      runtimeIdentity: context.runtimeIdentity,
      response: "",
      stdout,
      stderr: ""
    }
  }

  if (payload.sawProtocol && !payload.response) {
    const missingOutput = payload.sawToolActivity
      ? "without a final assistant message after tool activity"
      : "without a final assistant message or tool activity"
    return {
      ok: false,
      error: `ACPX agent completed ${missingOutput}.`,
      failureCategory: "transport",
      metadata: buildMetadata(context),
      continuation: buildContinuationState(payload.sessionId),
      runtimeIdentity: context.runtimeIdentity,
      response: "",
      stdout,
      stderr: ""
    }
  }

  const response = payload.response ?? stdout.trim()

  return {
    ok: true,
    metadata: buildMetadata(context),
    continuation: buildContinuationState(payload.sessionId),
    runtimeIdentity: context.runtimeIdentity,
    response,
    ...(payload.sessionId
      ? {
          sessionDisplayId: payload.sessionId,
          sessionState: {
            sessionId: payload.sessionId,
            sessionName: context.runtimeIdentity?.continuation?.sessionKey ?? null
          }
        }
      : {}),

    ...(payload.totalTokens ? { usage: { totalTokens: payload.totalTokens } } : {}),
    stdout,
    stderr: ""
  }
}

async function prepare(
  context: AdapterExecutionContext,
  options?: { skipResume?: boolean; acpxModelOverride?: string | null; acpxTimeoutMs?: number | null }
): Promise<PreparedAcpxInvocation> {
  const binary = context.agent.command ?? "gemini"
  const sessionCwd = resolveGeminiSessionCwd(context)
  const acpxAgentCommand = configuredAcpxAgentCommand(context.agent)
  if (acpxAgentCommand) {
    const timeoutSeconds = Math.max(
      1,
      Math.ceil((options?.acpxTimeoutMs ?? geminiAcpxWallTimeoutMs({ ...process.env, ...context.agent.env })) / 1000)
    )
    const argv = [
      "--cwd",
      sessionCwd,
      "--approve-all",
      "--format",
      "json",
      "--suppress-reads",
      "--timeout",
      String(timeoutSeconds)
    ]
    const acpxModel = options?.acpxModelOverride ?? configuredAcpxModel(context.agent)
    if (acpxModel) {
      argv.push("--model", acpxModel)
    }
    argv.push("--agent", acpxAgentCommand, "exec")

    return {
      argv: [binary, ...argv],
      cwd: sessionCwd,
      env: buildAcpxEnv(context, {
        sessionCwd,
        blockedKeys: BLOCKED_GEMINI_ENV_KEYS,
        preserveBlockedKeysEnvVar: "OPENCLAW_GEMINI_PRESERVE_GOOGLE_ENV"
      }),
      stdin: context.prompt,
      sessionCwd,
      repoPath: context.project.repoPath
    }
  }
  const shouldResume =
    !options?.skipResume &&
    Boolean(context.sessionState?.state.sessionId) &&
    typeof context.sessionState?.state.sessionId === "string"

  const argv = ["--output-format", "json", "--approval-mode", "yolo"]

  const model = resolveGeminiModel(context.agent.model)
  if (model) {
    argv.push("--model", model)
  }

  if (shouldResume) {
    argv.push("--resume")
  }

  if (sessionCwd !== context.project.repoPath && shouldIncludeRepoDirectory(context)) {
    argv.push("--include-directories", context.project.repoPath)
  }

  return {
    argv: [binary, ...argv],
    cwd: sessionCwd,
    env: buildAcpxEnv(context, {
      sessionCwd,
      blockedKeys: BLOCKED_GEMINI_ENV_KEYS,
      preserveBlockedKeysEnvVar: "OPENCLAW_GEMINI_PRESERVE_GOOGLE_ENV"
    }),
    stdin: context.prompt,
    sessionCwd,
    repoPath: context.project.repoPath
  }
}

function runGeminiInvocation(
  context: AdapterExecutionContext,
  prepared: PreparedAcpxInvocation,
  options: { timeoutMs?: number | undefined } = {}
): Promise<AdapterExecutionResult> {
  const isAcpxAgent = Boolean(configuredAcpxAgentCommand(context.agent))
  const configuredTimeoutMs = isAcpxAgent ? geminiAcpxWallTimeoutMs(prepared.env) : geminiTimeoutMs(prepared.env)
  return runPreparedAcpxInvocationAsync(context, prepared, {
    commandLabel: isAcpxAgent ? "ACPX agent" : "Gemini",
    timeoutMs: Math.min(configuredTimeoutMs, options.timeoutMs ?? configuredTimeoutMs),
    idleTimeoutMs: isAcpxAgent ? geminiAcpxIdleTimeoutMs(prepared.env) : undefined,
    parseOutput: (stdout) => parseGeminiOutput(context, stdout),
    failurePatterns: {
      auth: [
        /\bgoogle\b.*\blogin\b/i,
        /\bError authenticating\b/i,
        /\bIneligibleTierError\b/i,
        /\bUNSUPPORTED_CLIENT\b/i,
        /\bclient is no longer supported\b/i
      ],
      modelNotFound: [/\bunknown model alias\b/i]
    }
  })
}

async function retryWithFreshSession(
  context: AdapterExecutionContext,
  reason: "quota" | "session-corruption"
): Promise<AdapterExecutionResult> {
  const retryPrepared = await prepare(context, { skipResume: true })
  context.log("info", "Retrying Gemini with a fresh ACPX session", { reason })
  return runGeminiInvocation(context, retryPrepared)
}

async function execute(context: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  if (configuredAcpxAgentCommand(context.agent)) {
    let models = configuredAcpxModels(context.agent)
    const gitWorkspace = isGitWorkspace(context.project.repoPath)
    const workspaceCheckpoint = captureAcpxWorkspaceCheckpoint(context.project.repoPath)
    const startedAt = Date.now()
    const acpxEnv = { ...process.env, ...context.agent.env }
    const totalTimeoutMs = geminiAcpxTotalTimeoutMs(acpxEnv)
    const configuredWallTimeoutMs = geminiAcpxWallTimeoutMs(acpxEnv)
    let lastAttempt: AdapterExecutionResult | null = null
    for (let index = 0; index < models.length; index += 1) {
      const model = models[index]!
      const elapsedMs = Date.now() - startedAt
      const remainingMs = totalTimeoutMs - elapsedMs
      if (remainingMs <= 0) {
        return {
          ...(lastAttempt ?? { ok: false, response: "" }),
          ok: false,
          response: "",
          error: `ACPX model fallback budget exhausted after ${totalTimeoutMs}ms.`,
          failureCategory: "timeout"
        }
      }
      const attemptTimeoutMs = geminiAcpxAttemptTimeoutMs({
        remainingTotalTimeoutMs: remainingMs,
        remainingModels: models.length - index,
        configuredWallTimeoutMs
      })
      const attemptContext = contextForAcpxModel(context, model)
      const prepared = await prepare(attemptContext, { acpxModelOverride: model, acpxTimeoutMs: attemptTimeoutMs })
      const attempt = await runGeminiInvocation(attemptContext, prepared, { timeoutMs: attemptTimeoutMs })
      if (attempt.ok) return attempt
      if (attempt.failureCategory === "timeout" && attempt.response.trim() && isCodeProducingTask(context)) {
        context.log("warn", "Continuing timed-out ACPX code handoff into deterministic verification", {
          model,
          responseLength: attempt.response.length,
          attemptTimeoutMs
        })
        const { error: _error, failureCategory: _failureCategory, ...handoff } = attempt
        return {
          ...handoff,
          ok: true
        }
      }
      lastAttempt = attempt

      const advertisedModels = parseAdvertisedAcpxModels(attempt.error)
      if (advertisedModels.length > 0) {
        const supportedConfiguredModels = models.filter((candidate) => advertisedModels.includes(candidate))
        if (supportedConfiguredModels.length > 0 && supportedConfiguredModels.length !== models.length) {
          const skippedModels = models.filter((candidate) => !advertisedModels.includes(candidate))
          context.log("warn", "Pruned unsupported ACPX fallback models using advertised runtime capabilities", {
            failedModel: model,
            advertisedModels,
            keptModels: supportedConfiguredModels,
            skippedModels
          })
          models = supportedConfiguredModels
          index = Math.max(-1, models.indexOf(model))
        }
      }

      const fallbackModel = models[index + 1]
      if (!fallbackModel || !attempt.failureCategory || !ACPX_MODEL_FALLBACK_FAILURES.has(attempt.failureCategory)) {
        return attempt
      }
      if (gitWorkspace && !workspaceCheckpoint) {
        return {
          ...attempt,
          ok: false,
          response: "",
          error: `${attempt.error ?? `ACPX model ${model} failed`}; refusing contaminated fallback because the Git execution workspace could not be checkpointed.`,
          failureCategory: "transport"
        }
      }
      if (workspaceCheckpoint) {
        const restoration = restoreAcpxWorkspaceCheckpoint(workspaceCheckpoint)
        if (!restoration.restored) {
          return {
            ...attempt,
            ok: false,
            response: "",
            error: `${attempt.error ?? `ACPX model ${model} failed`}; refusing contaminated fallback because the execution workspace could not be restored: ${restoration.error}`,
            failureCategory: "transport"
          }
        }
        context.log("info", "Restored execution workspace before ACPX model fallback", {
          failedModel: model,
          fallbackModel,
          restoredHeadSha: workspaceCheckpoint.headSha,
          restoredTrackedChanges: Boolean(workspaceCheckpoint.trackedStashRef),
          removedUntrackedPaths: restoration.removedUntrackedPaths
        })
      }
      const remainingBeforeDelayMs = Math.max(0, totalTimeoutMs - (Date.now() - startedAt))
      const fallbackDelayMs = Math.min(
        geminiAcpxFallbackDelayMs(context.runtimeIdentity.executionKey, index + 1, {
          ...process.env,
          ...context.agent.env
        }),
        remainingBeforeDelayMs
      )
      context.log("warn", "Retrying ACPX agent with fallback model", {
        failedModel: model,
        fallbackModel,
        failureCategory: attempt.failureCategory,
        fallbackDelayMs,
        attemptTimeoutMs,
        remainingTotalTimeoutMs: remainingBeforeDelayMs,
        error: attempt.error ?? null
      })
      if (fallbackDelayMs > 0) {
        await delay(fallbackDelayMs)
      }
    }

    return (
      lastAttempt ?? {
        ok: false,
        response: "",
        error: "No ACPX model candidates were configured.",
        failureCategory: "model-not-found"
      }
    )
  }

  const prepared = await prepare(context)
  let attempt = await runGeminiInvocation(context, prepared)
  if (attempt.ok) {
    return attempt
  }

  const hadResumeSession =
    !configuredAcpxAgentCommand(context.agent) &&
    Boolean(context.sessionState?.state.sessionId) &&
    typeof context.sessionState?.state.sessionId === "string"
  if (!hadResumeSession) {
    return attempt
  }

  if (attempt.failureCategory === "session-corruption" || attempt.failureCategory === "quota") {
    attempt = await retryWithFreshSession(context, attempt.failureCategory)
  }

  return attempt
}

async function resume(sessionState: SessionState | null): Promise<Record<string, unknown> | null> {
  return sessionState?.state ?? null
}

async function healthcheck(agent: Agent): Promise<AdapterHealthcheckResult> {
  const command = agent.command ?? "gemini"
  if (!commandExists(command)) {
    return { ok: false, message: `${command} not found` }
  }

  const acpxAgentCommand = configuredAcpxAgentCommand(agent)
  if (acpxAgentCommand) {
    const agentExecutable = acpxAgentCommand.split(/\s+/)[0]
    if (!agentExecutable || !commandExists(agentExecutable)) {
      return { ok: false, message: `${agentExecutable || "ACPX agent command"} not found` }
    }
    return { ok: true, message: "acpx tool-capable agent available" }
  }

  return { ok: true, message: "gemini available" }
}

export const geminiLocalAdapter: AdapterDefinition = {
  type: "gemini_local",
  label: "Gemini Local",
  capabilities: GEMINI_CAPABILITIES,
  prepare,
  execute,
  resume,
  parseResult: (stdout, stderr) => {
    const context = {
      company: {} as AdapterExecutionContext["company"],
      project: {} as AdapterExecutionContext["project"],
      task: {} as AdapterExecutionContext["task"],
      agent: { model: null, env: {}, command: null } as AdapterExecutionContext["agent"],
      prompt: "",
      runId: "",
      wakeReason: "manual" as const,
      heartbeatJobId: null,
      triggeredAt: new Date(0).toISOString(),
      sessionKey: "",
      sessionState: null,
      runtimeIdentity: {
        version: 1,
        runtimeKey: "",
        executionKey: "",
        companyId: "",
        projectId: "",
        projectName: "",
        repoPath: "",
        taskId: "",
        taskKind: "user",
        taskTitle: "",
        workflowId: null,
        laneId: null,
        agentId: "",
        agentName: "",
        adapterType: "gemini_local",
        model: null,
        wake: { reason: "manual", heartbeatJobId: null, triggeredAt: new Date(0).toISOString() },
        continuation: {
          sessionKey: "",
          sessionDisplayId: null,
          retryCount: 0,
          attempt: 1,
          heartbeatEnabled: true,
          heartbeatIntervalSec: 0,
          supportsSessionResume: true,
          nativeContextManagement: "unknown"
        },
        scope: { allowedPaths: [], requiredReading: [], verificationCommands: [] }
      },
      log: () => undefined
    } satisfies AdapterExecutionContext

    return { ...parseGeminiOutput(context, stdout), stderr }
  },
  healthcheck
}

export const __internal = {
  parseAdvertisedAcpxModels,
  resolveGeminiModel,
  geminiTimeoutMs,
  geminiAcpxIdleTimeoutMs,
  geminiAcpxWallTimeoutMs,
  geminiAcpxTotalTimeoutMs,
  geminiAcpxAttemptTimeoutMs,
  geminiAcpxFallbackJitterMs,
  geminiAcpxFallbackDelayMs,
  configuredAcpxAgentCommand,
  configuredAcpxModel,
  configuredAcpxModels
}
