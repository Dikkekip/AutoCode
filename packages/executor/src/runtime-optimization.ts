import { existsSync, readFileSync, statSync } from "node:fs"
import { dirname, join } from "node:path"

import {
  type AdapterCapabilityProfile,
  type AdapterLaneHealth,
  type AdapterLaneStatus,
  type AdapterType,
  type Agent,
  buildContextHintBundle,
  type Company,
  type ContextBudgetBand,
  type Project,
  parseContextFileNames,
  type ResponseCompressionMode,
  type Run,
  type RunEvent,
  type RuntimeIdentityPayload,
  type SessionCompactionPolicy,
  type SessionState,
  type Task,
  type TaskEvent,
  taskLooksLikeUi
} from "@openclaw/domain"

export interface ResolvedSessionCompactionPolicy {
  policy: SessionCompactionPolicy
  source: "adapter_default" | "env_override"
}

const PROSE_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".rst"])
const CODE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".sql",
  ".css",
  ".scss",
  ".html",
  ".sh"
])

type FileArtifact = {
  path: string
  content: string
  kind: "code_excerpt" | "prose_summary" | "missing" | "reference"
  inclusion: "inline" | "summary" | "reference"
  cacheHit: boolean
  estimatedTokens: number
  rawEstimatedTokens: number
  truncated: boolean
  oversized: boolean
  byteSize: number
}

export interface SessionAttachmentSnapshot {
  path: string
  kind: FileArtifact["kind"]
  inclusion: FileArtifact["inclusion"]
  estimatedTokens: number
  rawEstimatedTokens: number
  oversized: boolean
  truncated: boolean
  byteSize: number
}

export interface SessionPromptBudgetSnapshot {
  band: ContextBudgetBand
  budgetTokens: number
  estimatedBeforeTokens: number
  estimatedAfterTokens: number
  compactionApplied: boolean
  reasons: string[]
  selectedFiles: string[]
  summarizedFiles: string[]
  rawArtifactTokens: number
  attachments: SessionAttachmentSnapshot[]
}

export interface SessionContextWindowState {
  version: 1
  createdAt: string
  updatedAt: string
  runCount: number
  accumulatedRawInputTokens: number
  lastPromptTokens: number
  lastBudget: SessionPromptBudgetSnapshot | null
  lastAttachments: SessionAttachmentSnapshot[]
  lastCompactionReasons: string[]
  lastResponseSummary: string | null
}

export interface SessionRotationDecision {
  rotate: boolean
  reason: string | null
  handoffMarkdown: string | null
}

const OPENCLAW_SESSION_STATE_KEY = "__openclaw_session_v1"

export type CommandCacheResult = {
  ok: boolean
  stdout: string
  stderr: string
  status: number | null
  cacheHit: boolean
}

export type CostValueDecision = {
  valueTier: "low" | "medium" | "high"
  uncertainty: "low" | "medium" | "high"
  preferredAdapters: AdapterType[]
  escalationReasons: string[]
}

export type PromptAssemblyResult = {
  prompt: string
  budgetMetadata: SessionPromptBudgetSnapshot
  responseCompression: ResolvedResponseCompression
  telemetry: Record<string, unknown>
}

export type ResponseCompressionSource =
  | "task_label"
  | "cli_override"
  | "agent_env"
  | "process_env"
  | "legacy_env"
  | "profile"
  | "default"

export interface ResolvedResponseCompression {
  mode: ResponseCompressionMode
  source: ResponseCompressionSource
}

export class RunToolingCache {
  private readonly fileCache = new Map<string, FileArtifact>()
  private readonly fileFailures = new Set<string>()
  private readonly commandCache = new Map<string, CommandCacheResult>()
  private estimatedContextTokensSaved = 0
  private fileReads = 0
  private fileCacheHits = 0
  private repeatedReadsAvoided = 0
  private missingFileSuppressions = 0
  private commandsExecuted = 0
  private commandCacheHits = 0
  private repeatedFailureLoopsPrevented = 0

  constructor(private readonly runId: string) {}

  readFileArtifact(repoPath: string, relativePath: string, maxChars: number): FileArtifact {
    const absolutePath = join(repoPath, relativePath)
    const failureKey = `${this.runId}:missing:${relativePath}`
    const seenFailure = this.fileFailures.has(failureKey)

    if (!existsSync(absolutePath)) {
      if (seenFailure) {
        this.missingFileSuppressions += 1
        this.repeatedFailureLoopsPrevented += 1
      } else {
        this.fileFailures.add(failureKey)
      }
      return {
        path: relativePath,
        content: "File could not be read from the repository at prompt assembly time.",
        kind: "missing",
        inclusion: "reference",
        cacheHit: seenFailure,
        estimatedTokens: 0,
        rawEstimatedTokens: 0,
        truncated: false,
        oversized: false,
        byteSize: 0
      }
    }

    const stats = statSync(absolutePath)
    if (!stats.isFile()) {
      return {
        path: relativePath,
        content: "",
        kind: "reference",
        inclusion: "reference",
        truncated: false,
        oversized: false,
        cacheHit: false,
        estimatedTokens: 0,
        rawEstimatedTokens: 0,
        byteSize: 0
      }
    }
    const cacheKey = `${this.runId}:${relativePath}:${stats.mtimeMs}:${stats.size}:${maxChars}`
    const cached = this.fileCache.get(cacheKey)
    if (cached) {
      this.fileCacheHits += 1
      this.repeatedReadsAvoided += 1
      this.estimatedContextTokensSaved += cached.estimatedTokens
      return { ...cached, cacheHit: true }
    }

    this.fileReads += 1
    const content = readFileSync(absolutePath, "utf8")
    const rawEstimatedTokens = estimateTokensFromText(content)
    const inlineBudgetTokens = Math.max(estimateTokensFromText("x".repeat(maxChars)), 150)
    const oversized = rawEstimatedTokens > inlineBudgetTokens * 5
    const artifact = oversized
      ? summarizeOversizedArtifact(relativePath, content, maxChars, stats.size, rawEstimatedTokens)
      : isProsePath(relativePath)
        ? summarizeProseArtifact(relativePath, content, maxChars, stats.size, rawEstimatedTokens)
        : excerptCodeArtifact(relativePath, content, maxChars, stats.size, rawEstimatedTokens)
    this.fileCache.set(cacheKey, artifact)
    return artifact
  }

  runCommand(command: string, runner: () => Omit<CommandCacheResult, "cacheHit">): CommandCacheResult {
    const cacheKey = `${this.runId}:${command}`
    const cached = this.commandCache.get(cacheKey)
    if (cached) {
      this.commandCacheHits += 1
      if (!cached.ok) {
        this.repeatedFailureLoopsPrevented += 1
      }
      return { ...cached, cacheHit: true }
    }

    this.commandsExecuted += 1
    const result = { ...runner(), cacheHit: false }
    this.commandCache.set(cacheKey, result)
    return result
  }

  async runCommandAsync(
    command: string,
    runner: () => Promise<Omit<CommandCacheResult, "cacheHit">>
  ): Promise<CommandCacheResult> {
    const cacheKey = `${this.runId}:${command}`
    const cached = this.commandCache.get(cacheKey)
    if (cached) {
      this.commandCacheHits += 1
      if (!cached.ok) {
        this.repeatedFailureLoopsPrevented += 1
      }
      return { ...cached, cacheHit: true }
    }

    this.commandsExecuted += 1
    const result = { ...(await runner()), cacheHit: false }
    this.commandCache.set(cacheKey, result)
    return result
  }

  addContextSavings(tokens: number): void {
    if (Number.isFinite(tokens) && tokens > 0) {
      this.estimatedContextTokensSaved += Math.round(tokens)
    }
  }

  snapshot(): Record<string, number> {
    return {
      fileReads: this.fileReads,
      fileCacheHits: this.fileCacheHits,
      repeatedReadsAvoided: this.repeatedReadsAvoided,
      missingFileSuppressions: this.missingFileSuppressions,
      commandsExecuted: this.commandsExecuted,
      commandCacheHits: this.commandCacheHits,
      repeatedFailureLoopsPrevented: this.repeatedFailureLoopsPrevented,
      estimatedContextTokensSaved: this.estimatedContextTokensSaved
    }
  }
}

function extensionOf(path: string): string {
  const dot = path.lastIndexOf(".")
  return dot >= 0 ? path.slice(dot).toLowerCase() : ""
}

function isProsePath(path: string): boolean {
  return PROSE_EXTENSIONS.has(extensionOf(path))
}

function estimateTokensFromText(value: string): number {
  return Math.ceil(value.length / 4)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value
  if (typeof value === "number") {
    if (value === 1) return true
    if (value === 0) return false
    return undefined
  }
  if (typeof value !== "string") return undefined
  const normalized = value.trim().toLowerCase()
  if (["true", "1", "yes", "on"].includes(normalized)) return true
  if (["false", "0", "no", "off"].includes(normalized)) return false
  return undefined
}

export function parseResponseCompressionMode(value: unknown): ResponseCompressionMode | null {
  if (typeof value !== "string") return null
  const normalized = value.trim().toLowerCase()
  return normalized === "off" || normalized === "lite" || normalized === "full" || normalized === "ultra"
    ? normalized
    : null
}

function taskResponseCompressionMode(task: Task): ResponseCompressionMode | null {
  for (const label of task.labels) {
    const normalized = label.trim().toLowerCase()
    if (normalized === "caveman") return "full"
    if (normalized === "no-caveman" || normalized === "response:off" || normalized === "response-compression:off") {
      return "off"
    }
    const match = /^(?:caveman|response|response-compression):(lite|full|ultra)$/.exec(normalized)
    if (match) return match[1] as ResponseCompressionMode
  }
  return null
}

export function resolveResponseCompression(input: {
  task: Task
  agent: Agent
  profileMode?: ResponseCompressionMode | null | undefined
}): ResolvedResponseCompression {
  const taskMode = taskResponseCompressionMode(input.task)
  if (taskMode) return { mode: taskMode, source: "task_label" }

  const cliMode = parseResponseCompressionMode(process.env.OPENCLAW_RESPONSE_COMPRESSION_OVERRIDE)
  if (cliMode) return { mode: cliMode, source: "cli_override" }

  const agentMode = parseResponseCompressionMode(input.agent.env.OPENCLAW_RESPONSE_COMPRESSION)
  if (agentMode) return { mode: agentMode, source: "agent_env" }

  const processMode = parseResponseCompressionMode(process.env.OPENCLAW_RESPONSE_COMPRESSION)
  if (processMode) return { mode: processMode, source: "process_env" }

  const legacyAgentMode = readBoolean(input.agent.env.OPENCLAW_CAVEMAN_MODE)
  if (legacyAgentMode !== undefined) return { mode: legacyAgentMode ? "full" : "off", source: "legacy_env" }
  const legacyProcessMode = readBoolean(process.env.OPENCLAW_CAVEMAN_MODE)
  if (legacyProcessMode !== undefined) return { mode: legacyProcessMode ? "full" : "off", source: "legacy_env" }

  if (input.profileMode) return { mode: input.profileMode, source: "profile" }
  return { mode: "off", source: "default" }
}

function responseCompressionInstructions(mode: ResponseCompressionMode): string[] {
  if (mode === "off") return []

  const safeguards = [
    "- Preserve exact requirements, identifiers, commands, paths, errors, numbers, and technical terms.",
    "- Use normal clear prose for security warnings, approval requests, irreversible actions, user-facing copy, code, commits, PR text, and required structured output."
  ]
  if (mode === "lite") {
    return [
      "- Response compression: lite. Use concise complete sentences; remove repetition, filler, and ceremonial framing.",
      "- Lead with result, blocker, or next concrete action. Keep explanations only when they change a decision.",
      ...safeguards
    ]
  }
  if (mode === "ultra") {
    return [
      "- Response compression: ultra. Respond terse like smart caveman. All technical substance stay. Only fluff die.",
      "- Use fragments, symbols, compact lists, and implied subjects where meaning stays unambiguous.",
      "- No introductions, conclusions, pleasantries, repeated summaries, or speculative padding.",
      ...safeguards
    ]
  }
  return [
    "- Response compression: full. Respond terse like smart caveman. All technical substance stay. Only fluff die.",
    "- Drop: articles (a/an/the), filler (just/really/basically), pleasantries, hedging.",
    "- Fragments OK. Short synonyms. Technical terms exact. Code/commit messages/PR descriptions stay normal prose.",
    ...safeguards
  ]
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value))
  }
  if (typeof value !== "string") return undefined
  const parsed = Number.parseInt(value.trim(), 10)
  return Number.isFinite(parsed) ? Math.max(0, parsed) : undefined
}

function formatCount(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "0"
  return value.toLocaleString("en-US")
}

function readSessionCompactionOverride(agent: Agent): Partial<SessionCompactionPolicy> {
  const env = {
    enabled:
      agent.env.OPENCLAW_SESSION_COMPACTION_ENABLED ??
      agent.env.OPENCLAW_SESSION_ROTATION_ENABLED ??
      process.env.OPENCLAW_SESSION_COMPACTION_ENABLED ??
      process.env.OPENCLAW_SESSION_ROTATION_ENABLED,
    maxSessionRuns:
      agent.env.OPENCLAW_SESSION_COMPACTION_MAX_RUNS ??
      agent.env.OPENCLAW_SESSION_ROTATION_MAX_RUNS ??
      process.env.OPENCLAW_SESSION_COMPACTION_MAX_RUNS ??
      process.env.OPENCLAW_SESSION_ROTATION_MAX_RUNS,
    maxRawInputTokens:
      agent.env.OPENCLAW_SESSION_COMPACTION_MAX_RAW_INPUT_TOKENS ??
      agent.env.OPENCLAW_SESSION_ROTATION_MAX_RAW_INPUT_TOKENS ??
      process.env.OPENCLAW_SESSION_COMPACTION_MAX_RAW_INPUT_TOKENS ??
      process.env.OPENCLAW_SESSION_ROTATION_MAX_RAW_INPUT_TOKENS,
    maxSessionAgeHours:
      agent.env.OPENCLAW_SESSION_COMPACTION_MAX_AGE_HOURS ??
      agent.env.OPENCLAW_SESSION_ROTATION_MAX_AGE_HOURS ??
      process.env.OPENCLAW_SESSION_COMPACTION_MAX_AGE_HOURS ??
      process.env.OPENCLAW_SESSION_ROTATION_MAX_AGE_HOURS
  }

  const override: Partial<SessionCompactionPolicy> = {}
  const enabled = readBoolean(env.enabled)
  const maxSessionRuns = readNumber(env.maxSessionRuns)
  const maxRawInputTokens = readNumber(env.maxRawInputTokens)
  const maxSessionAgeHours = readNumber(env.maxSessionAgeHours)

  if (enabled !== undefined) override.enabled = enabled
  if (maxSessionRuns !== undefined) override.maxSessionRuns = maxSessionRuns
  if (maxRawInputTokens !== undefined) override.maxRawInputTokens = maxRawInputTokens
  if (maxSessionAgeHours !== undefined) override.maxSessionAgeHours = maxSessionAgeHours
  return override
}

export function resolveSessionCompactionPolicy(
  agent: Agent,
  capabilities: AdapterCapabilityProfile
): ResolvedSessionCompactionPolicy {
  const explicitOverride = readSessionCompactionOverride(agent)
  const basePolicy = capabilities.defaultSessionCompaction
  const hasExplicitOverride = Object.keys(explicitOverride).length > 0

  return {
    policy: {
      enabled: explicitOverride.enabled ?? basePolicy.enabled,
      maxSessionRuns: explicitOverride.maxSessionRuns ?? basePolicy.maxSessionRuns,
      maxRawInputTokens: explicitOverride.maxRawInputTokens ?? basePolicy.maxRawInputTokens,
      maxSessionAgeHours: explicitOverride.maxSessionAgeHours ?? basePolicy.maxSessionAgeHours
    },
    source: hasExplicitOverride ? "env_override" : "adapter_default"
  }
}

export function hasSessionCompactionThresholds(
  policy: Pick<SessionCompactionPolicy, "maxSessionRuns" | "maxRawInputTokens" | "maxSessionAgeHours">
): boolean {
  return policy.maxSessionRuns > 0 || policy.maxRawInputTokens > 0 || policy.maxSessionAgeHours > 0
}

export function readSessionContextWindowState(sessionState: SessionState | null): SessionContextWindowState | null {
  const state = isRecord(sessionState?.state) ? sessionState.state : {}
  const parsed = state[OPENCLAW_SESSION_STATE_KEY]
  if (!isRecord(parsed)) return null

  const lastBudgetRecord = isRecord(parsed.lastBudget) ? parsed.lastBudget : null
  const attachments = Array.isArray(parsed.lastAttachments)
    ? parsed.lastAttachments.flatMap((entry) => {
        if (!isRecord(entry) || typeof entry.path !== "string" || typeof entry.kind !== "string") return []
        return [
          {
            path: entry.path,
            kind: entry.kind as SessionAttachmentSnapshot["kind"],
            inclusion: (typeof entry.inclusion === "string"
              ? entry.inclusion
              : "reference") as SessionAttachmentSnapshot["inclusion"],
            estimatedTokens: readNumber(entry.estimatedTokens) ?? 0,
            rawEstimatedTokens: readNumber(entry.rawEstimatedTokens) ?? 0,
            oversized: readBoolean(entry.oversized) ?? false,
            truncated: readBoolean(entry.truncated) ?? false,
            byteSize: readNumber(entry.byteSize) ?? 0
          }
        ]
      })
    : []

  return {
    version: 1,
    createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date(0).toISOString(),
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
    runCount: readNumber(parsed.runCount) ?? 0,
    accumulatedRawInputTokens: readNumber(parsed.accumulatedRawInputTokens) ?? 0,
    lastPromptTokens: readNumber(parsed.lastPromptTokens) ?? 0,
    lastBudget: lastBudgetRecord
      ? {
          band: (typeof lastBudgetRecord.band === "string" ? lastBudgetRecord.band : "small") as ContextBudgetBand,
          budgetTokens: readNumber(lastBudgetRecord.budgetTokens) ?? 0,
          estimatedBeforeTokens: readNumber(lastBudgetRecord.estimatedBeforeTokens) ?? 0,
          estimatedAfterTokens: readNumber(lastBudgetRecord.estimatedAfterTokens) ?? 0,
          compactionApplied: readBoolean(lastBudgetRecord.compactionApplied) ?? false,
          reasons: Array.isArray(lastBudgetRecord.reasons)
            ? lastBudgetRecord.reasons.filter((value): value is string => typeof value === "string")
            : [],
          selectedFiles: Array.isArray(lastBudgetRecord.selectedFiles)
            ? lastBudgetRecord.selectedFiles.filter((value): value is string => typeof value === "string")
            : [],
          summarizedFiles: Array.isArray(lastBudgetRecord.summarizedFiles)
            ? lastBudgetRecord.summarizedFiles.filter((value): value is string => typeof value === "string")
            : [],
          rawArtifactTokens: readNumber(lastBudgetRecord.rawArtifactTokens) ?? 0,
          attachments
        }
      : null,
    lastAttachments: attachments,
    lastCompactionReasons: Array.isArray(parsed.lastCompactionReasons)
      ? parsed.lastCompactionReasons.filter((value): value is string => typeof value === "string")
      : [],
    lastResponseSummary: typeof parsed.lastResponseSummary === "string" ? parsed.lastResponseSummary : null
  }
}

export function attachSessionContextWindowState(
  state: Record<string, unknown> | null | undefined,
  sessionContext: SessionContextWindowState
): Record<string, unknown> {
  const nextState = isRecord(state) ? { ...state } : {}
  nextState[OPENCLAW_SESSION_STATE_KEY] = sessionContext
  return nextState
}

function summarizeResponseForHandoff(response: string | null | undefined): string | null {
  if (typeof response !== "string") return null
  const normalized = response.replace(/\s+/g, " ").trim()
  return normalized ? normalized.slice(0, 280) : null
}

export function buildSessionContextWindowState(input: {
  previous: SessionContextWindowState | null
  budget: SessionPromptBudgetSnapshot
  response: string | null
  recordedAt: string
  rawInputTokens?: number | null
}): SessionContextWindowState {
  const rawInputTokens =
    typeof input.rawInputTokens === "number" && Number.isFinite(input.rawInputTokens) && input.rawInputTokens > 0
      ? Math.max(0, Math.floor(input.rawInputTokens))
      : input.budget.estimatedAfterTokens

  return {
    version: 1,
    createdAt: input.previous?.createdAt ?? input.recordedAt,
    updatedAt: input.recordedAt,
    runCount: (input.previous?.runCount ?? 0) + 1,
    accumulatedRawInputTokens: (input.previous?.accumulatedRawInputTokens ?? 0) + rawInputTokens,
    lastPromptTokens: input.budget.estimatedAfterTokens,
    lastBudget: input.budget,
    lastAttachments: input.budget.attachments,
    lastCompactionReasons: input.budget.reasons,
    lastResponseSummary: summarizeResponseForHandoff(input.response)
  }
}

export function evaluateSessionRotation(input: {
  agent: Agent
  capabilities: AdapterCapabilityProfile
  sessionState: SessionState | null
  now?: string
}): SessionRotationDecision {
  const previousContext = readSessionContextWindowState(input.sessionState)
  const sessionId = input.sessionState?.sessionDisplayId
  if (!sessionId || !previousContext) {
    return { rotate: false, reason: null, handoffMarkdown: null }
  }

  const { policy } = resolveSessionCompactionPolicy(input.agent, input.capabilities)
  if (!policy.enabled || !hasSessionCompactionThresholds(policy)) {
    return { rotate: false, reason: null, handoffMarkdown: null }
  }

  const nowIso = input.now ?? new Date().toISOString()
  const sessionAgeHours = Math.max(
    0,
    (new Date(nowIso).getTime() - new Date(previousContext.createdAt).getTime()) / (1000 * 60 * 60)
  )

  let reason: string | null = null
  if (policy.maxSessionRuns > 0 && previousContext.runCount > policy.maxSessionRuns) {
    reason = `session exceeded ${policy.maxSessionRuns} runs`
  } else if (policy.maxRawInputTokens > 0 && previousContext.accumulatedRawInputTokens >= policy.maxRawInputTokens) {
    reason =
      `session raw input reached ${formatCount(previousContext.accumulatedRawInputTokens)} tokens ` +
      `(threshold ${formatCount(policy.maxRawInputTokens)})`
  } else if (policy.maxSessionAgeHours > 0 && sessionAgeHours >= policy.maxSessionAgeHours) {
    reason = `session age reached ${Math.floor(sessionAgeHours)} hours`
  }

  if (!reason) {
    return { rotate: false, reason: null, handoffMarkdown: null }
  }

  const oversized = previousContext.lastAttachments.filter((entry) => entry.oversized).slice(0, 3)
  const handoffMarkdown = [
    "OpenClaw session handoff:",
    `- Previous session: ${sessionId}`,
    `- Rotation reason: ${reason}`,
    previousContext.lastResponseSummary ? `- Last run summary: ${previousContext.lastResponseSummary}` : "",
    oversized.length > 0
      ? `- Oversized file inclusions: ${oversized.map((entry) => `${entry.path} (~${formatCount(entry.rawEstimatedTokens)} tokens)`).join(", ")}`
      : "",
    "Continue from the current task state. Rebuild only the minimum context you need."
  ]
    .filter(Boolean)
    .join("\n")

  return {
    rotate: true,
    reason,
    handoffMarkdown
  }
}

export function classifyContextBand(tokens: number): ContextBudgetBand {
  if (tokens <= 4_000) return "small"
  if (tokens <= 12_000) return "medium"
  if (tokens <= 32_000) return "large"
  return "huge"
}

export function classifyLaneStatusFromMessage(message: string): AdapterLaneStatus {
  const normalized = message.toLowerCase()
  if (
    /(unauthori|forbidden|invalid api key|missing api key|\b(?:auth|authentication|oauth)\b.{0,40}\b(?:failed|required|expired|invalid)\b|\b(?:login|credentials?)\b.{0,40}\b(?:required|failed|expired|invalid|missing)\b|please (?:log in|login|authenticate))/.test(
      normalized
    )
  ) {
    return "auth_failed"
  }
  if (/(429|rate limit|too many requests)/.test(normalized)) {
    return "rate_limited"
  }
  if (
    /(quota|out of tokens|usage limit|out of credits|credits? (?:exhausted|depleted)|resource exhausted)/.test(
      normalized
    )
  ) {
    return "quota_exhausted"
  }
  return "degraded"
}

export function defaultCooldownUntil(status: AdapterLaneStatus, now = Date.now()): string | null {
  const minutes =
    status === "quota_exhausted" ? 30 : status === "rate_limited" ? 10 : status === "auth_failed" ? 120 : 5
  return new Date(now + minutes * 60_000).toISOString()
}

export function laneIsCoolingDown(lane: AdapterLaneHealth | null, nowIso = new Date().toISOString()): boolean {
  return Boolean(lane?.cooldownUntil && lane.cooldownUntil > nowIso)
}

export function buildCostValueDecision(task: Task, stage: Task["stage"]): CostValueDecision {
  const uiTask = taskLooksLikeUi(task)
  const fileCount = task.changedFiles.length
  const reviewish = task.kind === "review" || stage === "reviewer" || task.kind === "promote" || stage === "promoter"
  const plannerish = task.kind === "plan" || stage === "planner"
  const lightweight = task.kind === "follow_up" || (reviewish && fileCount <= 2)
  const complexCode =
    task.kind === "implement" &&
    (fileCount >= 3 ||
      task.reviewRequired ||
      task.labels.some((label) => /backend|refactor|arch|contract/i.test(label)))

  if (uiTask && task.kind === "implement") {
    return {
      valueTier: complexCode ? "high" : "medium",
      uncertainty: complexCode ? "high" : "medium",
      preferredAdapters: ["gemini_local", "codex_local", "azure_foundry"],
      escalationReasons: complexCode
        ? ["UI implementation touches multiple files and should avoid low-depth review models."]
        : []
    }
  }

  if (complexCode) {
    return {
      valueTier: "high",
      uncertainty: "high",
      preferredAdapters: ["codex_local", "azure_foundry", "gemini_local"],
      escalationReasons: [
        "Cross-cutting code execution outweighs cheap-first routing.",
        "Task requires deeper code reasoning before lower-cost fallback."
      ]
    }
  }

  if (plannerish) {
    return {
      valueTier: "medium",
      uncertainty: task.labels.some((label) => /architecture|backend|migration/i.test(label)) ? "high" : "medium",
      preferredAdapters: ["azure_foundry", "codex_local", "gemini_local"],
      escalationReasons: []
    }
  }

  if (reviewish || lightweight) {
    return {
      valueTier: "low",
      uncertainty: task.reviewRequired ? "medium" : "low",
      preferredAdapters: uiTask
        ? ["gemini_local", "azure_foundry", "codex_local"]
        : ["azure_foundry", "codex_local", "gemini_local"],
      escalationReasons: []
    }
  }

  return {
    valueTier: "medium",
    uncertainty: fileCount >= 2 ? "medium" : "low",
    preferredAdapters: uiTask
      ? ["gemini_local", "codex_local", "azure_foundry"]
      : ["codex_local", "azure_foundry", "gemini_local"],
    escalationReasons: []
  }
}

function contextBudgetForTask(task: Task, agent: Agent): number {
  const base =
    task.kind === "implement"
      ? 24_000
      : task.kind === "plan"
        ? 16_000
        : task.kind === "review"
          ? 8_000
          : task.kind === "promote"
            ? 7_000
            : task.kind === "follow_up"
              ? 6_000
              : 10_000
  const complexityBonus = task.changedFiles.length >= 6 ? 8_000 : task.changedFiles.length >= 3 ? 4_000 : 0
  const coderBonus = task.stage === "coder" || task.kind === "implement" ? 4_000 : 0
  const reviewerPenalty = task.stage === "reviewer" || task.kind === "review" || task.kind === "promote" ? -1_500 : 0
  const highWindowBonus =
    agent.adapterType === "gemini_local" ? 4_000 : agent.adapterType === "azure_foundry" ? 2_000 : 0
  return Math.max(4_000, base + complexityBonus + coderBonus + reviewerPenalty + highWindowBonus)
}

function compactList(items: string[], maxItems: number): { items: string[]; omitted: number } {
  const deduped = Array.from(new Set(items.filter(Boolean)))
  if (deduped.length <= maxItems) {
    return { items: deduped, omitted: 0 }
  }
  return {
    items: deduped.slice(0, maxItems),
    omitted: deduped.length - maxItems
  }
}

function summarizeProseArtifact(
  path: string,
  content: string,
  maxChars: number,
  byteSize: number,
  rawEstimatedTokens: number
): FileArtifact {
  const lines = content
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  const picked: string[] = []
  for (const line of lines) {
    picked.push(line)
    if (picked.join("\n").length >= maxChars) break
  }
  const body = picked.join("\n").slice(0, maxChars).trimEnd()
  return {
    path,
    content: body.length > 0 ? body : "No readable prose content found.",
    kind: "prose_summary",
    inclusion: "summary",
    cacheHit: false,
    estimatedTokens: estimateTokensFromText(body),
    rawEstimatedTokens,
    truncated: body.length < content.length,
    oversized: false,
    byteSize
  }
}

function excerptCodeArtifact(
  path: string,
  content: string,
  maxChars: number,
  byteSize: number,
  rawEstimatedTokens: number
): FileArtifact {
  const lines = content.replace(/\r/g, "").split("\n")
  const picked: string[] = []
  let total = 0
  for (const line of lines) {
    const nextLength = total + line.length + 1
    if (nextLength > maxChars && picked.length > 0) break
    picked.push(line)
    total = nextLength
    if (total >= maxChars) break
  }
  const body = picked.join("\n").slice(0, maxChars).trimEnd()
  return {
    path,
    content: body.length > 0 ? body : "No readable code content found.",
    kind: "code_excerpt",
    inclusion: "inline",
    cacheHit: false,
    estimatedTokens: estimateTokensFromText(body),
    rawEstimatedTokens,
    truncated: body.length < content.length,
    oversized: false,
    byteSize
  }
}

function summarizeOversizedArtifact(
  path: string,
  content: string,
  maxChars: number,
  byteSize: number,
  rawEstimatedTokens: number
): FileArtifact {
  const previewBudget = Math.max(Math.min(maxChars, 480), 180)
  const preview = isProsePath(path)
    ? summarizeProseArtifact(path, content, previewBudget, byteSize, rawEstimatedTokens).content
    : excerptCodeArtifact(path, content, previewBudget, byteSize, rawEstimatedTokens).content
  const body = [
    "File omitted from inline prompt context because it is too large to attach safely.",
    `Approx size: ${formatCount(byteSize)} bytes (~${formatCount(rawEstimatedTokens)} tokens).`,
    "Orientation preview:",
    preview
  ].join("\n")

  return {
    path,
    content: body,
    kind: "reference",
    inclusion: "reference",
    cacheHit: false,
    estimatedTokens: estimateTokensFromText(body),
    rawEstimatedTokens,
    truncated: true,
    oversized: true,
    byteSize
  }
}

const GENERIC_CONTEXT_TERMS = new Set([
  "apps",
  "backend",
  "component",
  "components",
  "contract",
  "contracts",
  "feature",
  "features",
  "frontend",
  "index",
  "report",
  "reports",
  "route",
  "routes",
  "service",
  "services",
  "source",
  "src",
  "test",
  "tests",
  "typescript"
])

function contextTerms(value: string): Set<string> {
  return new Set(
    value
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((term) => term.length >= 3 && !GENERIC_CONTEXT_TERMS.has(term))
  )
}

function taskContextTerms(task: Task): Set<string> {
  return contextTerms(
    [
      task.title,
      task.description ?? "",
      task.laneId ?? "",
      task.labels.join(" "),
      task.taskPackage?.likelyOwnershipLane ?? "",
      task.taskPackage?.userOutcome ?? ""
    ].join(" ")
  )
}

function scoreFileForContext(task: Task, path: string, relevantTerms: ReadonlySet<string>): number {
  let score = 0
  if (task.changedFiles.includes(path)) score += 5
  if (task.requiredReading.includes(path)) score += 4
  if (task.taskPackage?.requiredReading?.includes(path)) score += 3
  if (taskLooksLikeUi(task) && /\.(tsx|jsx|css|scss|html)$/i.test(path)) score += 2
  if (!taskLooksLikeUi(task) && /\.(ts|tsx|js|jsx|py|go|rs|java|kt|sql)$/i.test(path)) score += 2
  if (isProsePath(path)) score += task.kind === "review" || task.kind === "follow_up" ? 2 : 1
  if (CODE_EXTENSIONS.has(extensionOf(path))) score += task.kind === "implement" ? 2 : 1
  const overlap = Array.from(contextTerms(path)).filter((term) => relevantTerms.has(term)).length
  score += Math.min(overlap * 3, 12)
  return score
}

function compactPromptText(value: string, maxChars: number): string {
  const normalized = value.trim()
  if (normalized.length <= maxChars) return normalized

  const marker = `\n...[${normalized.length - maxChars} characters omitted for prompt budget]...\n`
  const available = Math.max(0, maxChars - marker.length)
  const headChars = Math.ceil(available / 2)
  const tailChars = Math.floor(available / 2)
  return `${normalized.slice(0, headChars)}${marker}${normalized.slice(-tailChars)}`
}

function formatTaskEvents(events: TaskEvent[]): string | null {
  const picked = events.slice(-4)
  if (picked.length === 0) return null
  return [
    "Recent decisions:",
    ...picked.map((event) => {
      const suffix = event.data ? ` | data: ${compactPromptText(JSON.stringify(event.data), 1_500)}` : ""
      return `- ${event.kind}: ${compactPromptText(event.message, 500)}${suffix}`
    })
  ].join("\n")
}

function formatRunHistory(run: Run | null, events: RunEvent[]): string | null {
  if (!run) return null
  const lines = [
    "Recent execution state:",
    `- Last run status: ${run.status}`,
    `- Last run error: ${run.errorText ? compactPromptText(run.errorText, 4_000) : "none"}`,
    `- Last verification summary: ${
      run.verificationSummary ? compactPromptText(run.verificationSummary, 1_000) : "none"
    }`
  ]
  for (const event of events.slice(-3)) {
    lines.push(`- [${event.level}] ${compactPromptText(event.message, 500)}`)
  }
  return lines.join("\n")
}

const STRUCTURED_GUIDANCE_SECTIONS = new Set([
  "acceptance contract",
  "contract and compatibility reminders",
  "read before editing",
  "repository evidence to verify before editing",
  "user outcome",
  "verification ladder"
])

function stripStructuredGuidanceSections(value: string): string {
  const kept: string[] = []
  let include = true
  for (const line of value.trim().split("\n")) {
    const heading = line.match(/^##\s+(.+?)\s*$/)
    if (heading) {
      include = !STRUCTURED_GUIDANCE_SECTIONS.has(heading[1]!.trim().toLowerCase())
    }
    if (include) kept.push(line)
  }
  return kept.join("\n").trim()
}

function executionTaskDescription(value: string | null): string {
  if (!value) return "No description provided."
  const marker = "\nFramework prompt ideation brief:"
  const markerIndex = value.indexOf(marker)
  const core = markerIndex >= 0 ? value.slice(0, markerIndex) : value
  return compactPromptText(core, 8_000)
}

function formatTaskPackage(task: Task, compact: boolean): string | null {
  if (!task.taskPackage) return null

  const reading = compactList(task.taskPackage.requiredReading ?? [], compact ? 4 : 8)
  const verification = compactList(task.taskPackage.verificationChecklist ?? [], compact ? 3 : 6)
  const reminders = compactList(task.taskPackage.contractUpdateReminders ?? [], compact ? 2 : 4)
  const acceptance = compactList(task.taskPackage.acceptanceCriteria ?? [], compact ? 4 : 7)
  const evidence = compactList(task.taskPackage.inferenceSignals ?? [], compact ? 3 : 6)
  const repoNotes = compactList(task.taskPackage.repoNotes ?? [], compact ? 2 : 4)
  const guidance = (task.taskPackage.extraInstructions ?? [])
    .slice(0, compact ? 1 : 3)
    .map(stripStructuredGuidanceSections)
    .filter(Boolean)
    .map((value) => compactPromptText(value, compact ? 1_600 : 3_200))

  const lines = [
    "Required facts:",
    `- Repo profile: ${task.taskPackage.repoProfile}`,
    `- Ownership lane: ${task.taskPackage.likelyOwnershipLane}`,
    `- Lane reason: ${task.taskPackage.laneReason}`
  ]

  if (task.taskPackage.userOutcome?.trim()) {
    lines.push(`- User outcome: ${task.taskPackage.userOutcome.trim()}`)
  }

  if (acceptance.items.length > 0) {
    lines.push("- Acceptance criteria:")
    for (const item of acceptance.items) lines.push(`  - ${item}`)
    if (acceptance.omitted > 0) lines.push(`  - ... ${acceptance.omitted} more criterion/criteria omitted`)
  }

  if (reading.items.length > 0) {
    lines.push("- Required reading:")
    for (const item of reading.items) lines.push(`  - ${item}`)
    if (reading.omitted > 0) lines.push(`  - ... ${reading.omitted} more path(s) omitted to stay within budget`)
  }

  if (verification.items.length > 0) {
    lines.push("- Verification commands:")
    for (const item of verification.items) lines.push(`  - ${item}`)
    if (verification.omitted > 0) lines.push(`  - ... ${verification.omitted} more command(s) omitted`)
  }

  if (reminders.items.length > 0) {
    lines.push("- Contract reminders:")
    for (const item of reminders.items) lines.push(`  - ${item}`)
  }

  if (evidence.items.length > 0) {
    lines.push("- Repository evidence:")
    for (const item of evidence.items) lines.push(`  - ${item}`)
    if (evidence.omitted > 0) lines.push(`  - ... ${evidence.omitted} more signal(s) omitted`)
  }

  if (repoNotes.items.length > 0) {
    lines.push("- Repository notes:")
    for (const item of repoNotes.items) lines.push(`  - ${item}`)
  }

  if (guidance.length > 0) {
    lines.push("- Persona execution guidance:")
    for (const item of guidance) {
      for (const line of item.split("\n")) lines.push(`  ${line}`)
    }
  }

  return lines.join("\n")
}

function formatFileArtifacts(artifacts: FileArtifact[], omittedPaths: string[]): string | null {
  if (artifacts.length === 0 && omittedPaths.length === 0) return null
  const lines = ["Relevant file context:"]
  for (const artifact of artifacts) {
    lines.push(`- Path: ${artifact.path}`)
    lines.push(`  Kind: ${artifact.kind}`)
    lines.push(`  Inclusion: ${artifact.inclusion}`)
    lines.push(`  Approx raw tokens: ${formatCount(artifact.rawEstimatedTokens)}`)
    if (artifact.oversized) {
      lines.push("  Note: file exceeded the inline attachment budget and was reduced to an orientation summary.")
    }
    lines.push("  Content:")
    for (const line of artifact.content.split("\n")) {
      lines.push(`    ${line}`)
    }
  }
  if (omittedPaths.length > 0) {
    lines.push("- Additional paths summarized only:")
    for (const path of omittedPaths) lines.push(`  - ${path}`)
  }
  return lines.join("\n")
}

function rawArtifactTokenEstimate(project: Project, paths: string[]): number {
  let total = 0
  for (const path of paths) {
    const absolutePath = join(project.repoPath, path)
    if (!existsSync(absolutePath)) continue
    total += Math.ceil(statSync(absolutePath).size / 4)
  }
  return total
}

export function shapeExecutionPrompt(input: {
  company: Company
  project: Project
  task: Task
  agent: Agent
  instructions: string | null
  previousSession: SessionState | null
  sessionHandoffMarkdown: string | null
  relevantMemory: string | null
  runtimeIdentity: RuntimeIdentityPayload
  recentTaskEvents: TaskEvent[]
  recentRun: Run | null
  recentRunEvents: RunEvent[]
  parentTask: Task | null
  toolingCache: RunToolingCache
  responseCompressionMode?: ResponseCompressionMode | null
}): PromptAssemblyResult {
  const budgetTokens = contextBudgetForTask(input.task, input.agent)
  const deterministicFallback = input.task.labels.includes("deterministic-fallback")
  const relevantTerms = taskContextTerms(input.task)
  const rawPaths = Array.from(
    new Set([
      ...input.task.changedFiles,
      ...input.task.requiredReading,
      ...(input.task.taskPackage?.requiredReading ?? [])
    ])
  ).sort(
    (left, right) =>
      scoreFileForContext(input.task, right, relevantTerms) - scoreFileForContext(input.task, left, relevantTerms) ||
      left.localeCompare(right)
  )
  const rawArtifactTokens = rawArtifactTokenEstimate(input.project, rawPaths)

  const compact = input.task.kind === "review" || input.task.kind === "promote" || input.task.kind === "follow_up"
  const maxFiles =
    input.task.kind === "implement" ? (rawPaths.length >= 8 ? 6 : 4) : input.task.kind === "plan" ? 4 : compact ? 2 : 3
  const fileCharBudget = compact ? 700 : deterministicFallback && input.task.kind === "implement" ? 3_200 : 1_400
  const selectedPaths = rawPaths.slice(0, maxFiles)
  const omittedPaths = rawPaths.slice(maxFiles)
  const artifacts = selectedPaths.map((path) =>
    input.toolingCache.readFileArtifact(input.project.repoPath, path, fileCharBudget)
  )
  const deterministicFallbackPrimaryPath = deterministicFallback
    ? (artifacts.find(
        (artifact) =>
          CODE_EXTENSIONS.has(extensionOf(artifact.path)) &&
          !/(^|\/)(?:__tests__|tests?|e2e|fixtures?|snapshots?)(\/|$)/i.test(artifact.path) &&
          !/\.(?:test|spec)\.[^/]+$/i.test(artifact.path)
      )?.path ?? null)
    : null

  const memoryBudgetChars = compact ? 1_000 : 2_000
  const trimmedMemory = input.relevantMemory
    ? input.relevantMemory.slice(0, memoryBudgetChars).trimEnd() +
      (input.relevantMemory.length > memoryBudgetChars ? "\n\n[Memory trimmed for budget.]" : "")
    : null
  const memoryTrimmed = Boolean(input.relevantMemory && trimmedMemory && trimmedMemory !== input.relevantMemory)

  const responseCompression = resolveResponseCompression({
    task: input.task,
    agent: input.agent,
    profileMode: input.responseCompressionMode
  })

  const fileNames = parseContextFileNames(input.agent.env.CONTEXT_FILE_NAMES ?? process.env.CONTEXT_FILE_NAMES)
  const dirs = new Set(["."])
  for (const file of input.task.changedFiles) {
    let current = dirname(file)
    while (current && current !== "." && current !== "/") {
      dirs.add(current)
      const next = dirname(current)
      if (next === current) break
      current = next
    }
  }

  const hintDocs: Array<{ source: "local"; path: string; content: string }> = []
  for (const dir of Array.from(dirs).sort((left, right) => left.length - right.length || left.localeCompare(right))) {
    for (const name of fileNames) {
      const relativePath = dir === "." ? name : `${dir}/${name}`
      const absolutePath = join(input.project.repoPath, relativePath)
      if (!existsSync(absolutePath)) continue
      try {
        hintDocs.push({
          source: "local",
          path: relativePath,
          content: readFileSync(absolutePath, "utf8")
        })
      } catch {
        // ignore
      }
    }
  }

  let contextHintsPrompt: string | null = null
  if (hintDocs.length > 0) {
    const bundle = buildContextHintBundle(hintDocs)
    contextHintsPrompt = compactPromptText(bundle.systemPrompt, 16_000)
  }

  const expectations = [
    "Execution expectations:",
    "- Work only on this task.",
    "- Prefer direct progress over repeated repo inspection.",
    "- End with a concise summary of what changed or why you are blocked."
  ]
  if (deterministicFallback) {
    expectations.push(
      "- Deterministic fallback exploration budget: use at most 12 read or search tool calls before choosing a concrete gap or reporting exact no-change evidence.",
      deterministicFallbackPrimaryPath
        ? `- Begin with ${deterministicFallbackPrimaryPath} and its nearest existing focused tests; decide one concrete source-behavior gap there before inspecting another production module.`
        : "- Begin with the first named production file and its nearest existing focused tests; decide one concrete source-behavior gap there before inspecting another production module.",
      "- Never read an oversized file wholesale. Locate relevant symbols with rg, then read only narrow line ranges around those symbols.",
      "- A test-only patch is invalid; change meaningful source behavior and add only the focused evidence needed for that behavior.",
      "- During agent execution, run only the narrowest focused test. Do not run repository-wide suites, builds, or the full verification checklist; the dispatcher runs configured verification after you return."
    )
  }
  expectations.push(...responseCompressionInstructions(responseCompression.mode))

  const taskPackageSection = formatTaskPackage(input.task, compact)
  const decisionsSection = formatTaskEvents(input.recentTaskEvents)
  const runHistorySection = formatRunHistory(input.recentRun, input.recentRunEvents)
  const fileSection = formatFileArtifacts(artifacts, omittedPaths)
  const parentSection = input.parentTask
    ? [
        "Handoff context:",
        `- Parent task: ${input.parentTask.title}`,
        `- Parent kind: ${input.parentTask.kind}`,
        `- Parent description: ${
          input.parentTask.description ? compactPromptText(input.parentTask.description, 4_000) : "none"
        }`
      ].join("\n")
    : null

  const sections = [
    `You are ${input.agent.name}, acting as ${input.agent.role} for ${input.company.name}.`,
    input.instructions ? `Additional instructions:\n${compactPromptText(input.instructions, 12_000)}` : null,
    [
      "Task summary:",
      `- Project: ${input.project.name}`,
      `- Repository: ${input.project.repoPath}`,
      `- Title: ${input.task.title}`,
      `- Description: ${executionTaskDescription(input.task.description)}`,
      `- Labels: ${input.task.labels.join(", ") || "none"}`,
      `- Changed file hints: ${input.task.changedFiles.join(", ") || "none"}`,
      `- Review required: ${input.task.reviewRequired ? "yes" : "no"}`
    ].join("\n"),
    [
      "Runtime identity:",
      `- Runtime key: ${input.runtimeIdentity.runtimeKey}`,
      `- Execution key: ${input.runtimeIdentity.executionKey}`,
      `- Wake reason: ${input.runtimeIdentity.wake.reason}`,
      `- Continuation session: ${input.runtimeIdentity.continuation.sessionDisplayId ?? "new session"}`,
      `- Resume supported: ${input.runtimeIdentity.continuation.supportsSessionResume ? "yes" : "no"}`,
      `- Context management: ${input.runtimeIdentity.continuation.nativeContextManagement}`
    ].join("\n"),
    taskPackageSection,
    parentSection,
    contextHintsPrompt,
    input.sessionHandoffMarkdown ? compactPromptText(input.sessionHandoffMarkdown, 8_000) : null,
    fileSection,
    decisionsSection,
    runHistorySection,
    input.previousSession?.sessionDisplayId
      ? `Resume context: previous session ${input.previousSession.sessionDisplayId}`
      : null,
    trimmedMemory ? `Relevant memory:\n${trimmedMemory}` : null,
    expectations.join("\n")
  ].filter((value): value is string => Boolean(value && value.trim()))

  const prompt = sections.join("\n\n")
  const shapedTokens = estimateTokensFromText(prompt)
  const baselinePrompt = [
    input.instructions ?? "",
    input.task.description ?? "",
    JSON.stringify(input.task.taskPackage ?? {}),
    input.relevantMemory ?? ""
  ].join("\n\n")
  const estimatedBeforeTokens = estimateTokensFromText(baselinePrompt) + rawArtifactTokens
  const compactionApplied =
    rawPaths.length > selectedPaths.length || memoryTrimmed || estimatedBeforeTokens > budgetTokens

  if (compactionApplied) {
    input.toolingCache.addContextSavings(Math.max(estimatedBeforeTokens - shapedTokens, 0))
  }

  return {
    prompt,
    responseCompression,
    budgetMetadata: {
      band: classifyContextBand(estimatedBeforeTokens),
      budgetTokens,
      estimatedBeforeTokens,
      estimatedAfterTokens: shapedTokens,
      compactionApplied,
      reasons: [
        rawPaths.length > selectedPaths.length
          ? "selected only the highest-signal files and summarized the rest"
          : null,
        memoryTrimmed ? "trimmed retrieved memory to the task-specific memory budget" : null,
        artifacts.some((artifact) => artifact.oversized)
          ? "replaced oversized file inclusions with orientation-only attachment summaries"
          : null,
        compact ? "aggressively compacted review/promotion style task context" : null
      ].filter((value): value is string => Boolean(value)),
      selectedFiles: selectedPaths,
      summarizedFiles: omittedPaths,
      rawArtifactTokens,
      attachments: artifacts.map((artifact) => ({
        path: artifact.path,
        kind: artifact.kind,
        inclusion: artifact.inclusion,
        estimatedTokens: artifact.estimatedTokens,
        rawEstimatedTokens: artifact.rawEstimatedTokens,
        oversized: artifact.oversized,
        truncated: artifact.truncated,
        byteSize: artifact.byteSize
      }))
    },
    telemetry: input.toolingCache.snapshot()
  }
}
