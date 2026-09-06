import { execFile, spawnSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"

import {
  buildAcpxEnv,
  buildOutputPath,
  commandExists,
  discoverCodexAccountSwitcher,
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

type AccountSwitchResult = {
  attempted: boolean
  switched: boolean
  switchedTo: string | null
  alreadyActive: boolean | null
  availableAccounts: string[]
  blockedAccounts: string[]
  excludedAccounts: string[]
  switcherPath: string | null
  error: string | null
  stdout: string
  stderr: string
}

function defaultCodexCommand(): string {
  const configured = process.env.OPENCLAW_CODEX_COMMAND?.trim()
  if (configured) {
    return configured
  }

  const localCodex = join(process.env.HOME ?? "", ".local", "npm", "bin", "codex")
  if (existsSync(localCodex)) {
    return localCodex
  }

  return "codex"
}

function resolveCodexCommand(agent: Agent): string {
  return agent.command ?? defaultCodexCommand()
}

function shouldUseIsolatedAccountPool(context: AdapterExecutionContext, binary: string): boolean {
  const explicit = context.agent.env.OPENCLAW_CODEX_ACCOUNT_POOL_ENABLED?.trim().toLowerCase()
  if (explicit) return explicit === "true"
  return basename(binary).replace(/\.exe$/i, "") === "codex"
}

type AccountListResult = {
  attempted: boolean
  active: string | null
  accounts: string[]
  switcherPath: string | null
  error: string | null
  stdout: string
  stderr: string
}

type CodexAuthRegistryAccount = {
  account_key?: unknown
  email?: unknown
  alias?: unknown
  account_name?: unknown
  plan?: unknown
  last_usage?: unknown
  last_usage_at?: unknown
}

type CodexAuthRegistry = {
  active_account_key?: unknown
  accounts?: unknown
}

type CodexAuthAccountCandidate = {
  accountKey: string
  authPath: string
  name: string
  query: string
  active: boolean
  status: "healthy" | "warm" | "blocked" | "unknown"
  score: number
}

type CodexAuthQuarantineRecord = {
  failureCategory: "auth" | "quota"
  quarantinedAt: string
  sourceFingerprint: string
  expiresAt?: string
}

const DEFAULT_CODEX_TIMEOUT_MS = 7_200_000
const DEFAULT_OPENCLAW_GATEWAY_TIMEOUT_MS = 30_000
const DEFAULT_OPENCLAW_NATIVE_RUN_TIMEOUT_MS = 30 * 60 * 1000
const OPENCLAW_NATIVE_TRANSPORT = "openclaw-native-session"
const OPENCLAW_BOOTSTRAP_FILES = {
  "IDENTITY.md": ["# IDENTITY.md", "Fill this in during your first conversation"],
  "SOUL.md": ["# SOUL.md", "You're not a chatbot. You're becoming someone"],
  "USER.md": ["# USER.md", "Store stable user preferences and profile facts"]
} as const
const PRISTINE_OPENCLAW_BOOTSTRAP_HASHES: Record<keyof typeof OPENCLAW_BOOTSTRAP_FILES, ReadonlySet<string>> = {
  "IDENTITY.md": new Set([
    "2f6da67d69bd362f7aaa13c1214dcbba9f0f7cb51ff42ec5313e24d6bf6f9e55",
    "81be974bd634b96d725d75be7d4527ddbee2b8c7bf81f342a01990712364cbfb"
  ]),
  "SOUL.md": new Set([
    "29c66a31acce424ed6cf9b1c9e77dcdc5ae79d5fe2a035765c302a34b9025e0e",
    "b1907ecb6f2906bb071008b24cc5856761906dcffbed9972269908535b6983ed"
  ]),
  "USER.md": new Set([
    "5f8e1a04861b95b659a907e3ad9ae449c45713246d2168a26ec92c8f1e89ff40",
    "68b9bda7598a238af25acc862de0526d7e74e41563cb84bf50e53ccb184ad887",
    "cb05906455b94e100819987a89161edb23dcf07ebd04a6f459bd96ef476699dc"
  ])
}
const CODEX_AUTH_QUARANTINE_FILENAME = ".openclaw-auth-quarantine.json"
const DEFAULT_CODEX_QUOTA_QUARANTINE_MS = 30 * 60 * 1000
const codexAccountSlotLeaseTails = new Map<string, Promise<void>>()
// Codex can be quiet while a delegated build, browser suite, or backend test
// remains productive. Three minutes was shorter than normal application
// verification, so reserve idle recovery for genuinely abandoned executions.
const DEFAULT_CODEX_IDLE_TIMEOUT_MS = 900_000
const CODEX_MODEL_FALLBACKS: Record<string, string[]> = {
  "gpt-6-astra": ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4"],
  "gpt-5.6-sol": ["gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4"],
  "gpt-5.6-terra": ["gpt-5.6-luna", "gpt-5.4"],
  "gpt-5.6-luna": ["gpt-5.4-mini"],
  "gpt-5.5": ["gpt-5.4", "gpt-5.4-mini"],
  "gpt-5.4": ["gpt-5.4-mini"]
}
const CODEX_CAPABILITIES = {
  supportsSessionResume: true,
  supportsCompaction: true,
  compactionStrategy: "native",
  preferredPlanningContextWindow: 128000,
  planningPriority: 100,
  planningCostClass: "high",
  nativeContextManagement: "confirmed",
  heartbeatIdentityMode: "prompt_and_env",
  defaultSessionCompaction: {
    enabled: true,
    maxSessionRuns: 0,
    maxRawInputTokens: 0,
    maxSessionAgeHours: 0
  }
} as const

type OpenClawNativeCommandResult = {
  error: Error | null
  stdout: string
  stderr: string
}

export type OpenClawNativeSession = {
  key: string
  sessionId: string | null
  agentId: string
  cwd: string
}

type OpenClawNativeAgentEnvelope = {
  runId?: unknown
  status?: unknown
  result?: {
    payloads?: Array<{ text?: unknown; isError?: unknown; isReasoning?: unknown; isCommentary?: unknown }>
    meta?: {
      aborted?: unknown
      error?: unknown
      finalAssistantVisibleText?: unknown
      agentMeta?: {
        sessionId?: unknown
        provider?: unknown
        model?: unknown
        usage?: { input?: unknown; output?: unknown; total?: unknown; totalTokens?: unknown }
      }
    }
  }
}

export type OpenClawNativeTurnInput = {
  cwd: string
  prompt: string
  agentId: string
  fallbackAgentIds?: string[] | undefined
  model?: string | null | undefined
  thinking?: string | null | undefined
  label?: string | null | undefined
  session?: OpenClawNativeSession | null | undefined
  timeoutMs?: number | undefined
  command?: string | undefined
  env?: NodeJS.ProcessEnv | undefined
  log?: ((level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>) => void) | undefined
}

export type OpenClawNativeTurnResult = {
  ok: boolean
  response: string
  session: OpenClawNativeSession | null
  runId: string | null
  provider: string | null
  model: string | null
  usage?: AdapterExecutionResult["usage"]
  stdout: string
  stderr: string
  error?: string
  failureCategory?: AdapterExecutionResult["failureCategory"]
}

function normalizeOpenClawModel(model: string | null | undefined): string | null {
  const value = model?.trim()
  if (!value) return null
  return value.includes("/") ? value : `openai/${value}`
}

function normalizeOpenClawThinking(thinking: string | null | undefined): string | null {
  const value = thinking?.trim().toLowerCase()
  if (!value || value === "none") return value === "none" ? "off" : null
  return value
}

function defaultOpenClawCommand(): string {
  const configured = process.env.OPENCLAW_COMMAND?.trim()
  if (configured) return configured
  const localOpenClaw = join(process.env.HOME ?? "", ".local", "npm", "bin", "openclaw")
  return existsSync(localOpenClaw) ? localOpenClaw : "openclaw"
}

function useNativeOpenClawTransport(agent: Agent): boolean {
  const configured = agent.env.OPENCLAW_CODEX_TRANSPORT ?? process.env.OPENCLAW_CODEX_TRANSPORT
  return configured?.trim().toLowerCase() !== "direct"
}

function openClawNativeRunTimeoutMs(env: NodeJS.ProcessEnv, requestedTimeoutMs: number): number {
  const configured = Number.parseInt(env.OPENCLAW_NATIVE_RUN_TIMEOUT_MS ?? "", 10)
  const ceiling = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_OPENCLAW_NATIVE_RUN_TIMEOUT_MS
  return Math.min(requestedTimeoutMs, ceiling)
}

function safeNativeAgentId(value: string | null | undefined): string | null {
  const normalized = value
    ?.trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return normalized && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalized) ? normalized : null
}

function nativeAgentCandidates(context: AdapterExecutionContext): string[] {
  const explicit = safeNativeAgentId(context.agent.env.OPENCLAW_NATIVE_AGENT_ID)
  const provenance = safeNativeAgentId(context.task.taskPackage?.personaProvenance?.personaId)
  const persona = safeNativeAgentId(context.task.personaId)
  const stage = context.task.stage
  const stageAgent =
    stage === "planner" ? "planner" : stage === "reviewer" ? "reviewer" : stage === "promoter" ? "promoter" : null
  return Array.from(
    new Set([explicit, provenance, persona, stageAgent, "main"].filter((value): value is string => Boolean(value)))
  )
}

export function isPristineOpenClawBootstrapFile(file: keyof typeof OPENCLAW_BOOTSTRAP_FILES, content: string): boolean {
  const normalized = `${content.replace(/\r\n/g, "\n").trimEnd()}\n`
  const fingerprint = createHash("sha256").update(normalized).digest("hex")
  return PRISTINE_OPENCLAW_BOOTSTRAP_HASHES[file].has(fingerprint)
}

function existingOpenClawBootstrapFiles(cwd: string): Set<string> {
  return new Set(Object.keys(OPENCLAW_BOOTSTRAP_FILES).filter((file) => existsSync(join(cwd, file))))
}

function cleanupOpenClawBootstrapFiles(cwd: string, existing: Set<string>): void {
  for (const [file, markers] of Object.entries(OPENCLAW_BOOTSTRAP_FILES)) {
    const path = join(cwd, file)
    if (!existsSync(path)) continue
    try {
      const content = readFileSync(path, "utf8")
      const generatedDuringRun = !existing.has(file) && markers.every((marker) => content.includes(marker))
      const inheritedPristineTemplate = isPristineOpenClawBootstrapFile(
        file as keyof typeof OPENCLAW_BOOTSTRAP_FILES,
        content
      )
      if (generatedDuringRun || inheritedPristineTemplate) rmSync(path, { force: true })
    } catch {
      // Cleanup is best-effort; executor scope and zero-diff checks remain authoritative.
    }
  }
}

function parseJsonObject(text: string): Record<string, any> | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, any>) : null
  } catch {
    const start = trimmed.indexOf("{")
    const end = trimmed.lastIndexOf("}")
    if (start < 0 || end <= start) return null
    try {
      const parsed = JSON.parse(trimmed.slice(start, end + 1)) as unknown
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, any>) : null
    } catch {
      return null
    }
  }
}

function executeOpenClawCommand(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }
): Promise<OpenClawNativeCommandResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        env: options.env,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        timeout: options.timeoutMs
      },
      (error, stdout, stderr) => {
        resolve({
          error: error instanceof Error ? error : null,
          stdout,
          stderr
        })
      }
    )
  })
}

function nativeFailureCategory(message: string): AdapterExecutionResult["failureCategory"] {
  if (/auth|credential|login|oauth|unauthorized|forbidden/i.test(message)) return "auth"
  if (/quota|rate.?limit|usage limit|out of credits|billing/i.test(message)) return "quota"
  if (/model.+(?:not found|unavailable|unsupported)|unknown model/i.test(message)) return "model-not-found"
  if (/timeout|timed out/i.test(message)) return "timeout"
  if (/session.+(?:missing|invalid|corrupt|archived)|unknown session/i.test(message)) return "session-corruption"
  return "transport"
}

function shouldRetryNativeAgentCandidate(message: string): boolean {
  return /unknown agent|agent.+not (?:configured|found)|invalid agent/i.test(message)
}

async function createOpenClawNativeSession(
  input: OpenClawNativeTurnInput,
  agentId: string,
  command: string,
  env: NodeJS.ProcessEnv
): Promise<{ session: OpenClawNativeSession | null; result: OpenClawNativeCommandResult }> {
  const model = normalizeOpenClawModel(input.model)
  const thinking = normalizeOpenClawThinking(input.thinking)
  const params = {
    agentId,
    cwd: input.cwd,
    label: `${(input.label?.trim() || `dispatcher-${agentId}`).slice(0, 107)}-${randomUUID().slice(0, 8)}`,
    ...(model ? { model } : {}),
    ...(thinking ? { thinkingLevel: thinking } : {})
  }
  const result = await executeOpenClawCommand(
    command,
    [
      "gateway",
      "call",
      "sessions.create",
      "--json",
      "--timeout",
      String(DEFAULT_OPENCLAW_GATEWAY_TIMEOUT_MS),
      "--params",
      JSON.stringify(params)
    ],
    { cwd: input.cwd, env, timeoutMs: DEFAULT_OPENCLAW_GATEWAY_TIMEOUT_MS + 10_000 }
  )
  const parsed = parseJsonObject(result.stdout)
  const key = typeof parsed?.key === "string" ? parsed.key.trim() : ""
  if (result.error || parsed?.ok !== true || !key) return { session: null, result }
  return {
    session: {
      key,
      sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : null,
      agentId,
      cwd: input.cwd
    },
    result
  }
}

function nativeEnvelopeText(envelope: OpenClawNativeAgentEnvelope): string {
  const payloads = Array.isArray(envelope.result?.payloads) ? envelope.result.payloads : []
  const visible = payloads
    .filter((payload) => payload.isError !== true && payload.isReasoning !== true && payload.isCommentary !== true)
    .map((payload) => (typeof payload.text === "string" ? payload.text.trimEnd() : ""))
    .filter(Boolean)
  if (visible.length > 0) return visible.join("\n")
  return typeof envelope.result?.meta?.finalAssistantVisibleText === "string"
    ? envelope.result.meta.finalAssistantVisibleText.trimEnd()
    : ""
}

export async function runOpenClawNativeTurn(input: OpenClawNativeTurnInput): Promise<OpenClawNativeTurnResult> {
  const command = input.command?.trim() || defaultOpenClawCommand()
  const env = { ...process.env, ...input.env }
  const timeoutMs = input.timeoutMs ?? DEFAULT_CODEX_TIMEOUT_MS
  const existingBootstrapFiles = existingOpenClawBootstrapFiles(input.cwd)
  const candidates = Array.from(
    new Set(
      [safeNativeAgentId(input.agentId), ...(input.fallbackAgentIds ?? []).map(safeNativeAgentId), "main"].filter(
        (value): value is string => Boolean(value)
      )
    )
  )
  let session = input.session?.cwd === input.cwd && candidates.includes(input.session.agentId) ? input.session : null
  let createFailure: OpenClawNativeCommandResult | null = null

  if (!session) {
    for (const agentId of candidates) {
      const created = await createOpenClawNativeSession(input, agentId, command, env)
      if (created.session) {
        session = created.session
        if (agentId !== input.agentId) {
          input.log?.("warn", "OpenClaw native persona agent was unavailable; using main", {
            requestedAgentId: input.agentId,
            selectedAgentId: agentId
          })
        }
        break
      }
      createFailure = created.result
      const message = `${created.result.stderr}\n${created.result.stdout}\n${created.result.error?.message ?? ""}`
      if (!shouldRetryNativeAgentCandidate(message)) break
    }
  }

  cleanupOpenClawBootstrapFiles(input.cwd, existingBootstrapFiles)

  if (!session) {
    const message =
      createFailure?.stderr.trim() ||
      createFailure?.stdout.trim() ||
      createFailure?.error?.message ||
      "OpenClaw session creation failed"
    return {
      ok: false,
      response: "",
      session: null,
      runId: null,
      provider: null,
      model: normalizeOpenClawModel(input.model),
      stdout: createFailure?.stdout ?? "",
      stderr: createFailure?.stderr ?? "",
      error: message,
      failureCategory: nativeFailureCategory(message)
    }
  }

  const promptPath = `${buildOutputPath("dispatcher-openclaw-native", randomUUID())}.prompt.md`
  mkdirSync(dirname(promptPath), { recursive: true })
  writeFileSync(promptPath, input.prompt, "utf8")
  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000))
  const heartbeatStartedAt = Date.now()
  const heartbeatIntervalMs = Math.max(
    30_000,
    Number.parseInt(env.OPENCLAW_RUN_HEARTBEAT_INTERVAL_MS ?? "120000", 10) || 120_000
  )
  const heartbeat = setInterval(() => {
    input.log?.("info", "OpenClaw native execution heartbeat", {
      agentId: session?.agentId ?? input.agentId,
      sessionKey: session?.key ?? null,
      elapsedMs: Date.now() - heartbeatStartedAt
    })
  }, heartbeatIntervalMs)

  let commandResult: OpenClawNativeCommandResult
  try {
    const args = [
      "agent",
      "--agent",
      session.agentId,
      "--session-key",
      session.key,
      "--message-file",
      promptPath,
      "--json",
      "--timeout",
      String(timeoutSeconds)
    ]
    const model = normalizeOpenClawModel(input.model)
    const thinking = normalizeOpenClawThinking(input.thinking)
    if (model) args.push("--model", model)
    if (thinking) args.push("--thinking", thinking)
    commandResult = await executeOpenClawCommand(command, args, {
      cwd: input.cwd,
      env,
      timeoutMs: timeoutMs + 45_000
    })
  } finally {
    clearInterval(heartbeat)
    rmSync(promptPath, { force: true })
    cleanupOpenClawBootstrapFiles(input.cwd, existingBootstrapFiles)
  }

  const envelope = parseJsonObject(commandResult.stdout) as OpenClawNativeAgentEnvelope | null
  const response = envelope ? nativeEnvelopeText(envelope) : ""
  const agentMeta = envelope?.result?.meta?.agentMeta
  const rawUsage = agentMeta?.usage
  const usage = rawUsage
    ? {
        ...(typeof rawUsage.input === "number" ? { inputTokens: rawUsage.input } : {}),
        ...(typeof rawUsage.output === "number" ? { outputTokens: rawUsage.output } : {}),
        ...(typeof rawUsage.total === "number"
          ? { totalTokens: rawUsage.total }
          : typeof rawUsage.totalTokens === "number"
            ? { totalTokens: rawUsage.totalTokens }
            : {})
      }
    : undefined
  const aborted = envelope?.result?.meta?.aborted === true
  const ok = !commandResult.error && envelope?.status === "ok" && !aborted
  const errorMessage =
    commandResult.stderr.trim() ||
    (typeof envelope?.result?.meta?.error === "string" ? envelope.result.meta.error : "") ||
    commandResult.error?.message ||
    (ok ? "" : "OpenClaw native agent run failed")
  const sessionId = typeof agentMeta?.sessionId === "string" ? agentMeta.sessionId : session.sessionId
  const finalSession = { ...session, sessionId }

  return {
    ok,
    response,
    session: finalSession,
    runId: typeof envelope?.runId === "string" ? envelope.runId : null,
    provider: typeof agentMeta?.provider === "string" ? agentMeta.provider : null,
    model: typeof agentMeta?.model === "string" ? agentMeta.model : normalizeOpenClawModel(input.model),
    ...(usage && Object.keys(usage).length > 0 ? { usage } : {}),
    stdout: commandResult.stdout,
    stderr: commandResult.stderr,
    ...(!ok
      ? {
          error: errorMessage,
          failureCategory: nativeFailureCategory(errorMessage)
        }
      : {})
  }
}

function codexTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OPENCLAW_CODEX_TIMEOUT_MS?.trim()
  if (!raw) return DEFAULT_CODEX_TIMEOUT_MS
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CODEX_TIMEOUT_MS
}

function codexIdleTimeoutMs(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env.OPENCLAW_CODEX_IDLE_TIMEOUT_MS?.trim()
  if (!raw) return DEFAULT_CODEX_IDLE_TIMEOUT_MS
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return DEFAULT_CODEX_IDLE_TIMEOUT_MS
  return parsed > 0 ? parsed : undefined
}

function codexAccountRetryLimit(accountCount: number): number {
  const raw = process.env.OPENCLAW_CODEX_ACCOUNT_RETRY_LIMIT?.trim()
  const parsed = raw ? Number.parseInt(raw, 10) : accountCount || 3
  return Number.isFinite(parsed) && parsed > 0 ? parsed : Math.max(accountCount, 1)
}

function normalizedCodexModel(model: string | null | undefined): string | null {
  const normalized = model?.trim().toLowerCase()
  if (!normalized) return null
  if (normalized === "gpt-6" || normalized.includes("gpt-6-astra")) return "gpt-6-astra"
  if (normalized === "gpt-5.6" || normalized.includes("gpt-5.6-sol")) return "gpt-5.6-sol"
  if (normalized.includes("gpt-5.6-terra")) return "gpt-5.6-terra"
  if (normalized.includes("gpt-5.6-luna")) return "gpt-5.6-luna"
  if (normalized.includes("gpt-5.5")) return "gpt-5.5"
  if (normalized.includes("gpt-5.4-mini")) return "gpt-5.4-mini"
  if (normalized.includes("gpt-5.4")) return "gpt-5.4"
  return normalized
}

function codexModelFallbacks(model: string | null | undefined): string[] {
  const normalized = normalizedCodexModel(model)
  return normalized ? (CODEX_MODEL_FALLBACKS[normalized] ?? []) : []
}

function contextWithCodexModel(context: AdapterExecutionContext, model: string): AdapterExecutionContext {
  const runtimeIdentity = {
    ...context.runtimeIdentity,
    model
  }
  if (context.runtimeIdentity.routing) {
    runtimeIdentity.routing = {
      ...context.runtimeIdentity.routing,
      selectedModel: model,
      modelFamily: normalizedCodexModel(model) ?? model,
      modelRoutingReason: `${context.runtimeIdentity.routing.modelRoutingReason}; downgraded to ${model} after Codex quota/model fallback`
    }
  }

  return {
    ...context,
    agent: {
      ...context.agent,
      model
    },
    runtimeIdentity
  }
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
}

function discoverAccountSwitcherScript(context: AdapterExecutionContext): string | null {
  return discoverCodexAccountSwitcher(
    context.project.repoPath,
    process.env.CODEX_ACCOUNT_SWITCHER_SCRIPT ?? context.agent.env.CODEX_ACCOUNT_SWITCHER_SCRIPT ?? null
  )
}

function isCodexAuthSwitcher(switcherPath: string): boolean {
  return switcherPath === "codex-auth" || basename(switcherPath) === "codex-auth"
}

function switcherInvocation(switcherPath: string, args: string[]): { command: string; args: string[] } {
  if (isCodexAuthSwitcher(switcherPath)) {
    return { command: switcherPath, args }
  }
  if (switcherPath.endsWith(".py")) {
    return { command: "python3", args: [switcherPath, ...args] }
  }
  return { command: switcherPath, args }
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function codexAccountsRegistryPath(env: NodeJS.ProcessEnv = process.env): string {
  const codexDir = env.OPENCLAW_CODEX_DIR ?? join(env.HOME ?? "", ".codex")
  const accountsDir = env.OPENCLAW_CODEX_ACCOUNTS_DIR ?? join(codexDir, "accounts")
  return join(accountsDir, "registry.json")
}

function readJsonFile<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T
  } catch {
    return null
  }
}

function accountName(account: CodexAuthRegistryAccount): string | null {
  return (
    normalizeString(account.alias) ??
    normalizeString(account.account_name) ??
    normalizeString(account.email) ??
    normalizeString(account.account_key)
  )
}

function usageBucket(value: unknown): { used_percent?: number; resets_at?: number } | null {
  return value && typeof value === "object" ? (value as { used_percent?: number; resets_at?: number }) : null
}

function codexAuthAccountStatus(account: CodexAuthRegistryAccount): CodexAuthAccountCandidate["status"] {
  const usage =
    account.last_usage && typeof account.last_usage === "object" ? (account.last_usage as Record<string, unknown>) : {}
  const primary = usageBucket(usage.primary)
  const secondary = usageBucket(usage.secondary)
  const dailyUsed = typeof primary?.used_percent === "number" ? primary.used_percent : null
  const weeklyUsed = typeof secondary?.used_percent === "number" ? secondary.used_percent : dailyUsed
  if (weeklyUsed === null) return "unknown"
  if (weeklyUsed >= 100 || (dailyUsed !== null && dailyUsed >= 100)) return "blocked"
  if (weeklyUsed >= 90 || (dailyUsed !== null && dailyUsed >= 75)) return "warm"
  return "healthy"
}

function codexAuthAccountScore(account: CodexAuthRegistryAccount): number {
  const usage =
    account.last_usage && typeof account.last_usage === "object" ? (account.last_usage as Record<string, unknown>) : {}
  const primary = usageBucket(usage.primary)
  const secondary = usageBucket(usage.secondary)
  const dailyUsed = typeof primary?.used_percent === "number" ? primary.used_percent : 100
  const weeklyUsed =
    typeof secondary?.used_percent === "number"
      ? secondary.used_percent
      : typeof primary?.used_percent === "number"
        ? primary.used_percent
        : 100
  const blockedPenalty = weeklyUsed >= 100 || dailyUsed >= 100 ? 10_000 : 0
  const warmPenalty = weeklyUsed >= 90 || dailyUsed >= 75 ? 1_000 : 0
  return blockedPenalty + warmPenalty + weeklyUsed * 2 + dailyUsed
}

function codexAuthAccounts(env: NodeJS.ProcessEnv = process.env): CodexAuthAccountCandidate[] {
  const registry = readJsonFile<CodexAuthRegistry>(codexAccountsRegistryPath(env))
  if (!Array.isArray(registry?.accounts)) return []
  const accountsDir =
    env.OPENCLAW_CODEX_ACCOUNTS_DIR ?? join(env.OPENCLAW_CODEX_DIR ?? join(env.HOME ?? "", ".codex"), "accounts")
  const activeKey = normalizeString(registry.active_account_key)
  return registry.accounts.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return []
    const account = entry as CodexAuthRegistryAccount
    const accountKey = normalizeString(account.account_key)
    const query = accountKey ?? accountName(account)
    const name = accountName(account)
    if (!accountKey || !query || !name) return []
    const encodedKey = Buffer.from(accountKey, "utf8").toString("base64url")
    const authPath = join(accountsDir, `${encodedKey}.auth.json`)
    return [
      {
        accountKey,
        authPath,
        name,
        query,
        active: activeKey !== null && normalizeString(account.account_key) === activeKey,
        status: codexAuthAccountStatus(account),
        score: codexAuthAccountScore(account)
      }
    ]
  })
}

function refreshFileSnapshot(sourcePath: string, targetPath: string): void {
  if (existsSync(targetPath) && statSync(sourcePath).mtimeMs <= statSync(targetPath).mtimeMs) return

  const temporaryPath = `${targetPath}.tmp-${process.pid}-${randomUUID()}`
  try {
    copyFileSync(sourcePath, temporaryPath)
    renameSync(temporaryPath, targetPath)
  } finally {
    rmSync(temporaryPath, { force: true })
  }
}

function codexAccountSlot(accountKey: string): string {
  return createHash("sha256").update(accountKey).digest("hex").slice(0, 16)
}

function codexAccountPoolRoot(env: NodeJS.ProcessEnv): string {
  const baseCodexDir = env.OPENCLAW_CODEX_DIR ?? join(env.HOME ?? "", ".codex")
  return env.OPENCLAW_CODEX_ACCOUNT_HOMES_DIR ?? join(baseCodexDir, "openclaw-account-homes")
}

function authSnapshotFingerprint(path: string): string | null {
  try {
    const stat = statSync(path)
    return `${stat.size}:${stat.mtimeMs}`
  } catch {
    return null
  }
}

function accountQuarantinePath(poolRoot: string, accountKey: string): string {
  return join(poolRoot, `slot-${codexAccountSlot(accountKey)}`, CODEX_AUTH_QUARANTINE_FILENAME)
}

function codexQuotaQuarantineMs(env: NodeJS.ProcessEnv): number {
  const raw = env.OPENCLAW_CODEX_QUOTA_QUARANTINE_MS?.trim()
  if (!raw) return DEFAULT_CODEX_QUOTA_QUARANTINE_MS
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CODEX_QUOTA_QUARANTINE_MS
}

function hasCurrentAccountQuarantine(account: CodexAuthAccountCandidate, poolRoot: string): boolean {
  const quarantinePath = accountQuarantinePath(poolRoot, account.accountKey)
  const quarantine = readJsonFile<CodexAuthQuarantineRecord>(quarantinePath)
  if (!quarantine || (quarantine.failureCategory !== "auth" && quarantine.failureCategory !== "quota")) return false

  const currentFingerprint = authSnapshotFingerprint(account.authPath)
  if (!currentFingerprint || quarantine.sourceFingerprint !== currentFingerprint) {
    rmSync(quarantinePath, { force: true })
    return false
  }

  if (quarantine.failureCategory === "auth") return true

  const expiresAt = Date.parse(quarantine.expiresAt ?? "")
  if (Number.isFinite(expiresAt) && expiresAt > Date.now()) return true

  rmSync(quarantinePath, { force: true })
  return false
}

function quarantinePreparedAccountSlot(
  context: AdapterExecutionContext,
  prepared: PreparedAcpxInvocation,
  failureCategory: "auth" | "quota"
): void {
  const accountHome = normalizeString(prepared.env.CODEX_HOME)
  const accountSlot = normalizeString(prepared.env.OPENCLAW_CODEX_ACCOUNT_SLOT)
  const sourceFingerprint = normalizeString(prepared.env.OPENCLAW_CODEX_ACCOUNT_SOURCE_FINGERPRINT)
  if (!accountHome || !accountSlot || !sourceFingerprint) return

  const quarantinePath = join(accountHome, CODEX_AUTH_QUARANTINE_FILENAME)
  const temporaryPath = `${quarantinePath}.tmp-${process.pid}-${randomUUID()}`
  const quarantinedAt = new Date()
  const expiresAt =
    failureCategory === "quota"
      ? new Date(quarantinedAt.getTime() + codexQuotaQuarantineMs(prepared.env)).toISOString()
      : undefined
  try {
    writeFileSync(
      temporaryPath,
      `${JSON.stringify({
        failureCategory,
        quarantinedAt: quarantinedAt.toISOString(),
        sourceFingerprint,
        ...(expiresAt ? { expiresAt } : {})
      } satisfies CodexAuthQuarantineRecord)}\n`,
      { encoding: "utf8", mode: 0o600 }
    )
    renameSync(temporaryPath, quarantinePath)
    context.log("warn", "Quarantined unavailable Codex account slot", {
      accountSlot,
      failureCategory,
      expiresAt: expiresAt ?? null
    })
  } finally {
    rmSync(temporaryPath, { force: true })
  }
}

function isolatedCodexAccountEnv(
  context: AdapterExecutionContext,
  baseEnv: NodeJS.ProcessEnv,
  accountOffset = 0
): NodeJS.ProcessEnv {
  if (baseEnv.OPENCLAW_CODEX_ACCOUNT_POOL_ENABLED?.trim().toLowerCase() === "false") return baseEnv

  const baseCodexDir = baseEnv.OPENCLAW_CODEX_DIR ?? join(baseEnv.HOME ?? "", ".codex")
  const poolRoot = codexAccountPoolRoot(baseEnv)
  const eligibleCandidates = codexAuthAccounts(baseEnv)
    .filter((account) => account.status !== "blocked" && existsSync(account.authPath))
    .sort((left, right) => left.score - right.score || left.accountKey.localeCompare(right.accountKey))
  const candidates = eligibleCandidates.filter((account) => !hasCurrentAccountQuarantine(account, poolRoot))
  if (eligibleCandidates.length > candidates.length) {
    context.log("info", "Skipped quarantined Codex account slots", {
      skippedAccountSlots: eligibleCandidates.length - candidates.length,
      availableAccountSlots: candidates.length
    })
  }
  if (candidates.length === 0) {
    if (eligibleCandidates.length > 0) {
      context.log("warn", "All isolated Codex account slots are quarantined", {
        configuredAccountSlots: eligibleCandidates.length
      })
      return {
        ...baseEnv,
        OPENCLAW_CODEX_ACCOUNT_POOL_EXHAUSTED: "true",
        OPENCLAW_CODEX_ACCOUNT_POOL_SIZE: "0",
        OPENCLAW_CODEX_ACCOUNT_POOL_CONFIGURED_SIZE: String(eligibleCandidates.length)
      }
    }
    return baseEnv
  }

  const taskHash = createHash("sha256").update(context.task.id).digest()
  const account = candidates[(taskHash.readUInt32BE(0) + accountOffset) % candidates.length]!
  const slot = codexAccountSlot(account.accountKey)
  const accountHome = join(poolRoot, `slot-${slot}`)
  mkdirSync(accountHome, { recursive: true, mode: 0o700 })

  const isolatedAuthPath = join(accountHome, "auth.json")
  refreshFileSnapshot(account.authPath, isolatedAuthPath)
  const baseConfigPath = join(baseCodexDir, "config.toml")
  const isolatedConfigPath = join(accountHome, "config.toml")
  if (existsSync(baseConfigPath)) refreshFileSnapshot(baseConfigPath, isolatedConfigPath)

  context.log("info", "Assigned isolated Codex account slot", {
    accountSlot: slot,
    accountStatus: account.status,
    availableAccountSlots: candidates.length
  })
  return {
    ...baseEnv,
    CODEX_HOME: accountHome,
    OPENCLAW_CODEX_ACCOUNT_SLOT: slot,
    OPENCLAW_CODEX_ACCOUNT_POOL_SIZE: String(candidates.length),
    OPENCLAW_CODEX_ACCOUNT_SOURCE_FINGERPRINT: authSnapshotFingerprint(account.authPath) ?? "unknown"
  }
}

async function withCodexAccountSlotLease<T>(
  context: AdapterExecutionContext,
  prepared: PreparedAcpxInvocation,
  operation: () => Promise<T>
): Promise<T> {
  const accountSlot = normalizeString(prepared.env.OPENCLAW_CODEX_ACCOUNT_SLOT)
  const accountHome = normalizeString(prepared.env.CODEX_HOME)
  const leaseKey = accountSlot ?? accountHome ?? "default"
  const priorTail = codexAccountSlotLeaseTails.get(leaseKey)
  const prior = priorTail ?? Promise.resolve()
  let release!: () => void
  const lease = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = prior.then(() => lease)
  codexAccountSlotLeaseTails.set(leaseKey, tail)

  if (priorTail) {
    context.log("info", "Waiting for isolated Codex account slot lease", {
      accountSlot: accountSlot ?? "default"
    })
  }
  await prior
  context.log("info", "Acquired isolated Codex account slot lease", {
    accountSlot: accountSlot ?? "default"
  })

  try {
    return await operation()
  } finally {
    release()
    if (codexAccountSlotLeaseTails.get(leaseKey) === tail) {
      codexAccountSlotLeaseTails.delete(leaseKey)
    }
    context.log("info", "Released isolated Codex account slot lease", {
      accountSlot: accountSlot ?? "default"
    })
  }
}

function listCodexAccounts(context: AdapterExecutionContext): AccountListResult {
  const switcherPath = discoverAccountSwitcherScript(context)
  if (!switcherPath) {
    return {
      attempted: false,
      active: null,
      accounts: [],
      switcherPath: null,
      error: "account switcher script not found",
      stdout: "",
      stderr: ""
    }
  }

  const sessionCwd = resolveSessionCwd(context)
  const invocation = switcherInvocation(
    switcherPath,
    isCodexAuthSwitcher(switcherPath) ? ["list", "--skip-api"] : ["list", "--json"]
  )
  const env = buildAcpxEnv(context, { sessionCwd })
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: sessionCwd,
    env,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1024 * 1024 * 2
  })
  const stdout = result.stdout ?? ""
  const stderr = result.stderr ?? ""

  if (result.status !== 0) {
    return {
      attempted: true,
      active: null,
      accounts: [],
      switcherPath,
      error: stderr.trim() || stdout.trim() || `switcher list exited with status ${result.status ?? "unknown"}`,
      stdout,
      stderr
    }
  }

  if (isCodexAuthSwitcher(switcherPath)) {
    const accounts = codexAuthAccounts(env)
    return {
      attempted: true,
      active: accounts.find((account) => account.active)?.name ?? null,
      accounts: accounts.map((account) => account.name),
      switcherPath,
      error: null,
      stdout,
      stderr
    }
  }

  try {
    const parsed = JSON.parse(stdout) as { active?: unknown; accounts?: unknown }
    const accounts = Array.isArray(parsed.accounts)
      ? parsed.accounts.flatMap((account) => {
          if (typeof account === "string") return [account]
          if (account && typeof account === "object" && typeof (account as { name?: unknown }).name === "string") {
            return [(account as { name: string }).name]
          }
          return []
        })
      : []
    return {
      attempted: true,
      active: typeof parsed.active === "string" ? parsed.active : null,
      accounts,
      switcherPath,
      error: null,
      stdout,
      stderr
    }
  } catch (error) {
    return {
      attempted: true,
      active: null,
      accounts: [],
      switcherPath,
      error: error instanceof Error ? error.message : "failed to parse account list",
      stdout,
      stderr
    }
  }
}

function switchToBestAvailableAccount(
  context: AdapterExecutionContext,
  excludeAccounts: string[] = []
): AccountSwitchResult {
  const switcherPath = discoverAccountSwitcherScript(context)
  if (!switcherPath) {
    return {
      attempted: false,
      switched: false,
      switchedTo: null,
      alreadyActive: null,
      availableAccounts: [],
      blockedAccounts: [],
      excludedAccounts: excludeAccounts,
      switcherPath: null,
      error: "account switcher script not found",
      stdout: "",
      stderr: ""
    }
  }

  const sessionCwd = resolveSessionCwd(context)
  const env = buildAcpxEnv(context, { sessionCwd })
  const args = isCodexAuthSwitcher(switcherPath) ? ["switch"] : ["auto", "--json"]
  if (isCodexAuthSwitcher(switcherPath)) {
    const excluded = new Set(excludeAccounts)
    const accounts = codexAuthAccounts(env)
    const candidate = accounts
      .filter((account) => !account.active && !excluded.has(account.name) && account.status !== "blocked")
      .sort((left, right) => left.score - right.score)[0]
    if (!candidate) {
      return {
        attempted: true,
        switched: false,
        switchedTo: null,
        alreadyActive: null,
        availableAccounts: accounts.filter((account) => account.status !== "blocked").map((account) => account.name),
        blockedAccounts: accounts.filter((account) => account.status === "blocked").map((account) => account.name),
        excludedAccounts: excludeAccounts,
        switcherPath,
        error: "no non-blocked codex-auth account available",
        stdout: "",
        stderr: ""
      }
    }
    args.push(candidate.query)
  } else {
    for (const account of excludeAccounts) {
      args.push("--exclude", account)
    }
  }

  const invocation = switcherInvocation(switcherPath, args)
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: sessionCwd,
    env,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 1024 * 1024 * 10
  })
  const stdout = result.stdout ?? ""
  const stderr = result.stderr ?? ""

  if (result.status !== 0) {
    return {
      attempted: true,
      switched: false,
      switchedTo: null,
      alreadyActive: null,
      availableAccounts: [],
      blockedAccounts: [],
      excludedAccounts: excludeAccounts,
      switcherPath,
      error: stderr.trim() || stdout.trim() || `switcher exited with status ${result.status ?? "unknown"}`,
      stdout,
      stderr
    }
  }

  if (isCodexAuthSwitcher(switcherPath)) {
    const accounts = codexAuthAccounts(env)
    const switchedTo = accounts.find((account) => account.active)?.name ?? null
    return {
      attempted: true,
      switched: true,
      switchedTo,
      alreadyActive: false,
      availableAccounts: accounts.filter((account) => account.status !== "blocked").map((account) => account.name),
      blockedAccounts: accounts.filter((account) => account.status === "blocked").map((account) => account.name),
      excludedAccounts: excludeAccounts,
      switcherPath,
      error: null,
      stdout,
      stderr
    }
  }

  try {
    const parsed = JSON.parse(stdout) as {
      switched_to?: unknown
      already_active?: unknown
      available_accounts?: unknown
      blocked_accounts?: unknown
      excluded_accounts?: unknown
      error?: unknown
    }
    if (parsed.error) {
      return {
        attempted: true,
        switched: false,
        switchedTo: null,
        alreadyActive: null,
        availableAccounts: parseStringArray(parsed.available_accounts),
        blockedAccounts: parseStringArray(parsed.blocked_accounts),
        excludedAccounts: parseStringArray(parsed.excluded_accounts),
        switcherPath,
        error: String(parsed.error),
        stdout,
        stderr
      }
    }

    const switchedTo = typeof parsed.switched_to === "string" && parsed.switched_to.trim() ? parsed.switched_to : null
    return {
      attempted: true,
      switched: Boolean(switchedTo),
      switchedTo,
      alreadyActive: typeof parsed.already_active === "boolean" ? parsed.already_active : null,
      availableAccounts: parseStringArray(parsed.available_accounts),
      blockedAccounts: parseStringArray(parsed.blocked_accounts),
      excludedAccounts: parseStringArray(parsed.excluded_accounts),
      switcherPath,
      error: null,
      stdout,
      stderr
    }
  } catch {
    return {
      attempted: true,
      switched: stdout.trim().length > 0,
      switchedTo: null,
      alreadyActive: null,
      availableAccounts: [],
      blockedAccounts: [],
      excludedAccounts: excludeAccounts,
      switcherPath,
      error: null,
      stdout,
      stderr
    }
  }
}

function coerceMessage(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim()

  if (Array.isArray(value)) {
    const texts = value.map((entry) => coerceMessage(entry)).filter(Boolean)
    return texts.length > 0 ? texts.join("\n").trim() : null
  }

  if (typeof value === "object" && value) {
    const record = value as Record<string, unknown>
    return (
      coerceMessage(record.content) ??
      coerceMessage(record.text) ??
      coerceMessage(record.message) ??
      coerceMessage(record.output) ??
      coerceMessage(record.delta) ??
      coerceMessage(record.parts) ??
      null
    )
  }

  return null
}

function parseJsonLines(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>]
      } catch {
        return []
      }
    })
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

function extractContinuationId(event: Record<string, unknown>): string | null {
  const paths = [
    ["session_id"],
    ["sessionId"],
    ["conversation_id"],
    ["conversationId"],
    ["session", "id"],
    ["session", "session_id"],
    ["session", "sessionId"],
    ["session", "conversation_id"],
    ["conversation", "id"],
    ["conversation", "conversation_id"],
    ["conversation", "conversationId"],
    ["params", "sessionId"],
    ["params", "session_id"],
    ["params", "session", "id"],
    ["params", "conversation", "id"],
    ["response", "session_id"],
    ["response", "sessionId"],
    ["response", "conversation_id"],
    ["response", "conversation", "id"],
    ["metadata", "session_id"],
    ["metadata", "sessionId"],
    ["response_id"]
  ] as const

  for (const path of paths) {
    const found = stringAtPath(event, path)
    if (found) return found
  }

  return findStringByKey(event, ["session_id", "sessionId", "conversation_id", "conversationId"])
}

function buildContinuationState(sessionId: string | null): AdapterContinuationState | null {
  if (!sessionId) return null
  return {
    sessionDisplayId: sessionId,
    state: { sessionId }
  }
}

function nativeCodexSessionId(value: unknown): string | null {
  if (typeof value !== "string") return null
  const candidate = value.trim()
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate) ? candidate : null
}

function buildMetadata(context: AdapterExecutionContext): AdapterResultMetadata {
  return {
    adapterType: "codex_local",
    provider: "codex",
    model: context.agent.model,
    capabilities: CODEX_CAPABILITIES,
    transport: "acpx"
  }
}

function openClawNativeSessionFromContext(
  context: AdapterExecutionContext,
  candidateAgentIds: string[]
): OpenClawNativeSession | null {
  const state = context.sessionState?.state
  const key = typeof state?.openclawSessionKey === "string" ? state.openclawSessionKey.trim() : ""
  const agentId = typeof state?.openclawAgentId === "string" ? state.openclawAgentId.trim() : ""
  const cwd = typeof state?.openclawCwd === "string" ? state.openclawCwd.trim() : ""
  if (!key || !agentId || cwd !== context.project.repoPath || !candidateAgentIds.includes(agentId)) return null
  return {
    key,
    agentId,
    cwd,
    sessionId: typeof state?.openclawSessionId === "string" ? state.openclawSessionId : null
  }
}

function openClawNativePrompt(context: AdapterExecutionContext, agentId: string): string {
  return [
    context.prompt.trimEnd(),
    "",
    "## OpenClaw native execution contract",
    "",
    `- This turn is owned by the native OpenClaw agent \`${agentId}\`.`,
    "- Use OpenClaw native session/subagent tools for independent parallel subtasks when they materially help and the configured allow-list authorizes them.",
    "- Keep work in the supplied workspace and preserve the dispatcher's task scope and verification contract.",
    "- Do not invoke a standalone codex CLI or an external account-switching helper; OpenClaw owns provider auth and fallback.",
    "- The active runtime is native OpenClaw Codex. Provider-availability preconditions for Gemini CLI or another standalone adapter are superseded for this turn; do not refuse or reroute work because those providers are unavailable."
  ].join("\n")
}

async function executeWithOpenClawNative(context: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const candidates = nativeAgentCandidates(context)
  const requestedAgentId = candidates[0] ?? "main"
  const session = openClawNativeSessionFromContext(context, candidates)
  context.log("info", "Dispatching task through OpenClaw native agent session", {
    requestedAgentId,
    sessionKey: session?.key ?? null,
    cwd: context.project.repoPath,
    accountRouting: "openclaw-auth-profile-order"
  })
  const nativeEnv = { ...process.env, ...context.agent.env }
  const result = await runOpenClawNativeTurn({
    cwd: context.project.repoPath,
    prompt: openClawNativePrompt(context, requestedAgentId),
    agentId: requestedAgentId,
    fallbackAgentIds: candidates.slice(1),
    model: context.agent.model,
    thinking: context.runtimeIdentity.routing?.reasoningEffort,
    label: `dispatcher-${context.task.id.slice(0, 8)}-${requestedAgentId}`,
    session,
    timeoutMs: openClawNativeRunTimeoutMs(nativeEnv, codexTimeoutMs(nativeEnv)),
    command: context.agent.env.OPENCLAW_COMMAND,
    env: context.agent.env,
    log: context.log
  })
  const nativeSession = result.session
  const continuation = nativeSession
    ? {
        sessionDisplayId: nativeSession.sessionId ?? nativeSession.key,
        state: {
          openclawSessionKey: nativeSession.key,
          openclawSessionId: nativeSession.sessionId,
          openclawAgentId: nativeSession.agentId,
          openclawCwd: nativeSession.cwd,
          openclawRunId: result.runId
        }
      }
    : null
  return {
    ok: result.ok,
    response: result.response,
    metadata: {
      adapterType: "codex_local",
      provider: result.provider ?? "openai",
      model: result.model ?? context.agent.model,
      capabilities: CODEX_CAPABILITIES,
      transport: OPENCLAW_NATIVE_TRANSPORT
    },
    continuation,
    runtimeIdentity: context.runtimeIdentity,
    sessionDisplayId: continuation?.sessionDisplayId ?? null,
    ...(continuation ? { sessionState: continuation.state } : {}),
    ...(result.usage ? { usage: result.usage } : {}),
    stdout: result.stdout,
    stderr: result.stderr,
    ...(!result.ok
      ? {
          error: result.error ?? "OpenClaw native agent run failed",
          failureCategory: result.failureCategory ?? "transport"
        }
      : {})
  }
}

function parseCodexOutput(
  context: AdapterExecutionContext,
  stdout: string,
  fallbackResponse: string | null
): AdapterExecutionResult {
  const events = parseJsonLines(stdout)
  let sessionId: string | null = null
  let response: string | null = null
  let usage: Record<string, number> | undefined

  for (const event of events) {
    const possibleSessionId = extractContinuationId(event)
    if (possibleSessionId) {
      sessionId = possibleSessionId
    }

    const possibleUsage =
      (typeof event.usage === "object" && event.usage ? (event.usage as Record<string, number>) : null) ||
      (typeof event.stats === "object" && event.stats ? (event.stats as Record<string, number>) : null)
    if (possibleUsage) {
      usage = possibleUsage
    }

    const possibleMessage =
      coerceMessage(event.response) ??
      coerceMessage(event.message) ??
      coerceMessage(event.output) ??
      coerceMessage(event.content) ??
      coerceMessage(valueAtPath(event, ["params", "update", "content"])) ??
      coerceMessage(valueAtPath(event, ["params", "update", "message"])) ??
      coerceMessage(valueAtPath(event, ["params", "content"])) ??
      null
    if (possibleMessage) {
      response = possibleMessage
    }
  }

  sessionId =
    sessionId ??
    (typeof context.sessionState?.state.sessionId === "string" ? context.sessionState.state.sessionId : null) ??
    context.runtimeIdentity.continuation.sessionDisplayId ??
    context.runtimeIdentity.continuation.sessionKey

  return {
    ok: true,
    metadata: buildMetadata(context),
    continuation: buildContinuationState(sessionId),
    runtimeIdentity: context.runtimeIdentity,
    response: response ?? fallbackResponse ?? stdout.trim(),
    ...(sessionId ? { sessionDisplayId: sessionId, sessionState: { sessionId } } : {}),
    ...(usage ? { usage } : {}),
    stdout,
    stderr: ""
  }
}

async function prepare(
  context: AdapterExecutionContext,
  options?: { skipResume?: boolean; accountOffset?: number }
): Promise<PreparedAcpxInvocation> {
  const binary = resolveCodexCommand(context.agent)
  const sessionId = !options?.skipResume ? nativeCodexSessionId(context.sessionState?.state.sessionId) : null
  const sessionCwd = resolveSessionCwd(context)
  const outputPath = buildOutputPath("dispatcher-codex", context.task.id)
  const argv = ["-C", context.project.repoPath, "exec"]

  if (sessionId) {
    argv.push("resume")
  }

  argv.push("--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "-o", outputPath)

  if (context.agent.model) {
    argv.push("-m", context.agent.model)
  }

  const reasoningEffort = context.runtimeIdentity.routing?.reasoningEffort
  if (reasoningEffort) {
    argv.push("-c", `model_reasoning_effort="${reasoningEffort}"`)
  }

  if (sessionId) {
    argv.push(sessionId, "-")
  } else {
    argv.push("-")
  }

  const baseEnv = buildAcpxEnv(context, { sessionCwd })
  const env = shouldUseIsolatedAccountPool(context, binary)
    ? isolatedCodexAccountEnv(context, baseEnv, options?.accountOffset ?? 0)
    : { ...baseEnv, OPENCLAW_CODEX_ACCOUNT_POOL_ENABLED: "false" }
  return {
    argv: [binary, ...argv],
    cwd: sessionCwd,
    env,
    stdin: context.prompt,
    outputPath,
    sessionCwd,
    repoPath: context.project.repoPath
  }
}

async function runCodexInvocation(
  context: AdapterExecutionContext,
  prepared: PreparedAcpxInvocation
): Promise<AdapterExecutionResult> {
  return withCodexAccountSlotLease(context, prepared, () =>
    runPreparedAcpxInvocationAsync(context, prepared, {
      commandLabel: "Codex",
      timeoutMs: codexTimeoutMs(prepared.env),
      idleTimeoutMs: codexIdleTimeoutMs(prepared.env),
      parseOutput: (stdout, _stderr, fallbackResponse) => parseCodexOutput(context, stdout, fallbackResponse),
      failurePatterns: {
        quota: [
          /\bopenai\b.*\b(?:rate limit|usage limit|quota)\b/i,
          /\b(?:quota_exhausted|usage limit|out of credits|service_disabled|accessnotconfigured)\b/i,
          /\bcredits?\s+(?:exhausted|depleted)\b/i,
          /gemini for google cloud api/i
        ]
      }
    })
  )
}

async function retryWithFreshSession(
  context: AdapterExecutionContext,
  reason: string
): Promise<AdapterExecutionResult> {
  const retryPrepared = await prepare(context, { skipResume: true })
  context.log("info", "Retrying Codex with a fresh ACPX session", { reason })
  return runCodexInvocation(context, retryPrepared)
}

async function retryWithModelFallbacks(
  context: AdapterExecutionContext,
  attempt: AdapterExecutionResult,
  reason: "quota" | "model-not-found"
): Promise<AdapterExecutionResult> {
  const fallbackModels = codexModelFallbacks(context.agent.model)
  if (fallbackModels.length === 0) return attempt

  let lastAttempt = attempt
  for (const fallbackModel of fallbackModels) {
    const fallbackContext = contextWithCodexModel(context, fallbackModel)
    fallbackContext.log("warn", "Retrying Codex with lower-tier model fallback", {
      fromModel: context.agent.model ?? null,
      fallbackModel,
      reason
    })
    const fallbackPrepared = await prepare(fallbackContext, { skipResume: true })
    const fallbackAttempt = await runCodexInvocation(fallbackContext, fallbackPrepared)
    if (fallbackAttempt.ok) {
      const fallbackResult: AdapterExecutionResult = {
        ...fallbackAttempt,
        response: fallbackAttempt.response,
        runtimeIdentity: fallbackContext.runtimeIdentity
      }
      if (fallbackAttempt.metadata) {
        fallbackResult.metadata = {
          ...fallbackAttempt.metadata,
          model: fallbackModel
        }
      }
      return fallbackResult
    }

    lastAttempt = {
      ...fallbackAttempt,
      error:
        `${fallbackAttempt.error ?? `Codex ${fallbackModel} fallback failed`}; ` +
        `fallback was attempted after ${context.agent.model ?? "default"} ${reason}`
    }
    if (fallbackAttempt.failureCategory !== "quota" && fallbackAttempt.failureCategory !== "model-not-found") {
      return lastAttempt
    }
  }

  return {
    ...lastAttempt,
    error:
      `${lastAttempt.error ?? "Codex fallback failed"}; ` +
      `all configured Codex model fallbacks were exhausted: ${fallbackModels.join(" -> ")}`
  }
}

function isAccountAvailabilityFailure(category: AdapterExecutionResult["failureCategory"]): boolean {
  return category === "quota" || category === "auth"
}

async function execute(context: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  if (useNativeOpenClawTransport(context.agent)) {
    let result = await executeWithOpenClawNative(context)
    // Only retry a rejected model here: OpenClaw owns quota/auth fallback, and
    // replaying a partially executed native turn could duplicate tool effects.
    for (const model of codexModelFallbacks(context.agent.model)) {
      if (result.ok || result.failureCategory !== "model-not-found") break
      context.log("warn", "Native model unavailable; trying compatible fallback", { model })
      result = await executeWithOpenClawNative(contextWithCodexModel(context, model))
    }
    return result
  }

  const prepared = await prepare(context)
  if (prepared.env.OPENCLAW_CODEX_ACCOUNT_POOL_EXHAUSTED === "true") {
    const configuredPoolSize = Number.parseInt(prepared.env.OPENCLAW_CODEX_ACCOUNT_POOL_CONFIGURED_SIZE ?? "0", 10)
    return {
      ok: false,
      error: `all ${Math.max(configuredPoolSize, 1)} isolated Codex account slots are temporarily quarantined`,
      failureCategory: "quota",
      metadata: buildMetadata(context),
      continuation: null,
      runtimeIdentity: context.runtimeIdentity,
      response: "",
      stdout: "",
      stderr: ""
    }
  }
  let attempt = await runCodexInvocation(context, prepared)
  if (attempt.ok) {
    return attempt
  }

  const hadResumeSession =
    Boolean(context.sessionState?.state.sessionId) && typeof context.sessionState?.state.sessionId === "string"

  if (hadResumeSession && attempt.failureCategory === "session-corruption") {
    attempt = await retryWithFreshSession(context, "session-corruption")
    if (attempt.ok) {
      return attempt
    }
  }

  if (attempt.failureCategory === "model-not-found") {
    return retryWithModelFallbacks(context, attempt, "model-not-found")
  }

  if (!isAccountAvailabilityFailure(attempt.failureCategory)) {
    return attempt
  }

  if (attempt.failureCategory === "auth") {
    quarantinePreparedAccountSlot(context, prepared, "auth")
  }

  if (attempt.failureCategory === "quota") {
    const modelFallbackAttempt = await retryWithModelFallbacks(context, attempt, "quota")
    if (modelFallbackAttempt.ok || !isAccountAvailabilityFailure(modelFallbackAttempt.failureCategory)) {
      return modelFallbackAttempt
    }
    attempt = modelFallbackAttempt
    if (attempt.failureCategory === "quota") {
      quarantinePreparedAccountSlot(context, prepared, "quota")
    }
  }

  const isolatedPoolSize = Number.parseInt(prepared.env.OPENCLAW_CODEX_ACCOUNT_POOL_SIZE ?? "1", 10)
  if (Number.isFinite(isolatedPoolSize) && isolatedPoolSize > 1) {
    let pooledAttempt = attempt
    for (let accountOffset = 1; accountOffset < isolatedPoolSize; accountOffset += 1) {
      context.log("warn", "Retrying Codex on the next isolated account slot", {
        accountOffset,
        availableAccountSlots: isolatedPoolSize
      })
      const pooledPrepared = await prepare(context, { skipResume: true, accountOffset })
      pooledAttempt = await runCodexInvocation(context, pooledPrepared)
      if (pooledAttempt.failureCategory === "auth") {
        quarantinePreparedAccountSlot(context, pooledPrepared, "auth")
      } else if (pooledAttempt.failureCategory === "quota") {
        quarantinePreparedAccountSlot(context, pooledPrepared, "quota")
      }
      if (pooledAttempt.ok || !isAccountAvailabilityFailure(pooledAttempt.failureCategory)) return pooledAttempt
    }
    return {
      ...pooledAttempt,
      error: `${pooledAttempt.error ?? "Codex account unavailable"}; all ${isolatedPoolSize} isolated Codex account slots were unavailable`
    }
  }

  const configuredPoolSize = codexAuthAccounts(prepared.env).length
  const accountPoolEnabled = prepared.env.OPENCLAW_CODEX_ACCOUNT_POOL_ENABLED?.trim().toLowerCase() !== "false"
  if (accountPoolEnabled && configuredPoolSize > 0) {
    context.log("warn", "Skipped legacy account switch after the isolated Codex pool was exhausted", {
      configuredAccountSlots: configuredPoolSize,
      availableAccountSlots: Number.isFinite(isolatedPoolSize) ? isolatedPoolSize : 0
    })
    return {
      ...attempt,
      error:
        `${attempt.error ?? "Codex account unavailable"}; ` +
        `all ${Math.max(isolatedPoolSize, 1)} available isolated Codex account slots were unavailable`
    }
  }

  context.log("warn", "Codex account availability failure detected; attempting account switch", {
    error: attempt.error ?? null,
    failureCategory: attempt.failureCategory ?? null
  })

  const accountList = listCodexAccounts(context)
  const failedAccounts = new Set<string>()
  if (accountList.active) failedAccounts.add(accountList.active)

  context.log("info", "Codex account state before quota fallback", {
    attempted: accountList.attempted,
    active: accountList.active,
    accountCount: accountList.accounts.length,
    error: accountList.error
  })

  const retryLimit = codexAccountRetryLimit(accountList.accounts.length)
  let lastAttempt = attempt
  let lastSwitchResult: AccountSwitchResult | null = null

  for (let switchAttempt = 1; switchAttempt <= retryLimit; switchAttempt += 1) {
    const switchResult = switchToBestAvailableAccount(context, [...failedAccounts])
    lastSwitchResult = switchResult
    context.log(switchResult.switched ? "info" : "warn", "Codex account switch attempt completed", {
      attempted: switchResult.attempted,
      switched: switchResult.switched,
      switchedTo: switchResult.switchedTo,
      alreadyActive: switchResult.alreadyActive,
      excludedAccounts: switchResult.excludedAccounts,
      availableAccounts: switchResult.availableAccounts,
      blockedAccounts: switchResult.blockedAccounts,
      switcherPath: switchResult.switcherPath,
      error: switchResult.error
    })

    if (!switchResult.switched) {
      return {
        ...attempt,
        error:
          switchResult.error && switchResult.attempted
            ? `${attempt.error ?? "Codex account unavailable"}; auto-switch failed: ${switchResult.error}`
            : (attempt.error ?? "Codex account unavailable")
      }
    }

    if (switchResult.switchedTo) failedAccounts.add(switchResult.switchedTo)

    const retryPrepared = await prepare(context, { skipResume: true })
    context.log("info", "Retrying Codex after account switch with a fresh ACPX session", {
      attempt: switchAttempt,
      switchedTo: switchResult.switchedTo
    })
    const retryAttempt = await runCodexInvocation(context, retryPrepared)

    if (retryAttempt.ok) {
      return retryAttempt
    }

    lastAttempt = retryAttempt
    if (!isAccountAvailabilityFailure(retryAttempt.failureCategory)) {
      return {
        ...retryAttempt,
        error:
          `${retryAttempt.error ?? "Codex retry failed"}; ` + "initial failure triggered an account availability switch"
      }
    }
  }

  return {
    ...lastAttempt,
    error:
      `${lastAttempt.error ?? "Codex retry failed"}; ` +
      "all configured Codex account retries were exhausted after account availability failures" +
      (lastSwitchResult?.error ? `; last switch error: ${lastSwitchResult.error}` : "")
  }
}

async function resume(sessionState: SessionState | null): Promise<Record<string, unknown> | null> {
  return sessionState?.state ?? null
}

async function healthcheck(agent: Agent): Promise<AdapterHealthcheckResult> {
  if (useNativeOpenClawTransport(agent)) {
    const command = agent.env.OPENCLAW_COMMAND?.trim() || defaultOpenClawCommand()
    if (!commandExists(command)) return { ok: false, message: `${command} not found` }
    const result = spawnSync(command, ["gateway", "status", "--deep"], {
      env: { ...process.env, ...agent.env },
      encoding: "utf8",
      timeout: DEFAULT_OPENCLAW_GATEWAY_TIMEOUT_MS
    })
    if (result.status !== 0 || !/Connectivity probe:\s+ok/i.test(result.stdout)) {
      return {
        ok: false,
        message: result.stderr.trim() || result.stdout.trim() || "OpenClaw Gateway connectivity probe failed"
      }
    }
    return { ok: true, message: "OpenClaw native Gateway agent transport available" }
  }

  const command = resolveCodexCommand(agent)
  if (!commandExists(command)) {
    return { ok: false, message: `${command} not found` }
  }

  const poolSetting = agent.env.OPENCLAW_CODEX_ACCOUNT_POOL_ENABLED?.trim().toLowerCase()
  const shouldCheckPool = poolSetting ? poolSetting === "true" : basename(command).replace(/\.exe$/i, "") === "codex"
  if (shouldCheckPool) {
    const env = { ...process.env, ...agent.env }
    const configuredAccounts = codexAuthAccounts(env).filter((account) => existsSync(account.authPath))
    const eligibleAccounts = configuredAccounts.filter((account) => account.status !== "blocked")
    if (configuredAccounts.length > 0 && eligibleAccounts.length === 0) {
      return { ok: false, message: "no non-blocked codex-auth account available" }
    }

    const poolRoot = codexAccountPoolRoot(env)
    const availableAccounts = eligibleAccounts.filter((account) => !hasCurrentAccountQuarantine(account, poolRoot))
    if (eligibleAccounts.length > 0 && availableAccounts.length === 0) {
      return {
        ok: false,
        message: `all ${eligibleAccounts.length} eligible isolated Codex account slots are quarantined`
      }
    }
  }

  return { ok: true, message: "codex available" }
}

export const codexLocalAdapter: AdapterDefinition = {
  type: "codex_local",
  label: "Codex Local",
  capabilities: CODEX_CAPABILITIES,
  prepare,
  execute,
  resume,
  parseResult: (stdout, stderr, fallbackResponse) => ({
    ...parseCodexOutput(
      {
        company: {} as AdapterExecutionContext["company"],
        project: {} as AdapterExecutionContext["project"],
        task: {} as AdapterExecutionContext["task"],
        agent: { model: null } as AdapterExecutionContext["agent"],
        prompt: "",
        runId: "",
        wakeReason: "manual",
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
          adapterType: "codex_local",
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
            nativeContextManagement: "confirmed"
          },
          scope: { allowedPaths: [], requiredReading: [], verificationCommands: [] }
        },
        log: () => undefined
      },
      stdout,
      fallbackResponse ?? null
    ),
    stderr
  }),
  healthcheck
}

export const __internal = {
  discoverAccountSwitcherScript,
  listCodexAccounts,
  switchToBestAvailableAccount
}
