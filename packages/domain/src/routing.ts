import { selectWorkerRoleTier } from "./role-tiers.js"
import type {
  AdapterHealthcheckResult,
  AdapterType,
  Agent,
  AgentSelectionCandidate,
  AgentSelectionDecision,
  ModelReasoningEffort,
  Persona,
  PersonaStage,
  PromptRouteIntent,
  PromptRouteRank,
  RouteDecision,
  RouteScorecardEntry,
  RoutingRule,
  Task,
  TaskRiskAssessment,
  TaskRouteShape
} from "./types.js"

const UI_HINTS = [
  "ui",
  "ux",
  "frontend",
  "front-end",
  "design",
  "visual",
  "copy",
  "css",
  "tailwind",
  "react component",
  "layout",
  "landing page",
  "polish"
] as const

const TOOL_HINTS = [
  "tool",
  "shell",
  "bash",
  "terminal",
  "cli",
  "command",
  "repo",
  "repository",
  "bugfix",
  "bug fix",
  "fix",
  "refactor",
  "migration",
  "test",
  "verify",
  "verification"
] as const

const PLANNING_HINTS = [
  "plan",
  "planning",
  "decompose",
  "breakdown",
  "analysis",
  "analyze",
  "manager",
  "pm",
  "proposal",
  "strategy",
  "roadmap",
  "synthesis"
] as const

const REVIEW_HINTS = [
  "review",
  "qa",
  "quality",
  "summary",
  "summarize",
  "coordination",
  "follow-up",
  "follow up",
  "promotion",
  "triage"
] as const

const CODE_HINTS = [
  "backend",
  "orchestr",
  "dispatcher",
  "framework",
  "contract",
  "incident",
  "ingestion",
  "reliability"
] as const

const CODE_FILE_PATTERN = /\.(c|cc|cpp|cs|go|h|hpp|java|js|jsx|kt|mjs|php|py|rb|rs|sh|sql|swift|ts|tsx)$/i
const DB_OR_SCHEMA_PATTERN = /(alembic|migration|schema|models?\.py|prisma|sql)$/i
const BACKEND_CONTRACT_PATTERN = /(contracts?|openapi|routes?|api|schemas?|contract)/i
const FRONTEND_STATE_PATTERN = /(state|workflow|tsx|react|component|workspace|viewer|panel)/i
const LEGAL_DOMAIN_PATTERN =
  /(legal|lawyer|court|evidence|citation|incident|timeline|bundle|barnevern|child[-\s]?welfare|provenance|matter|case preparation|witness)/i
const SECURITY_DOMAIN_PATTERN = /(auth|rbac|tenant|security|permission|entra|identity|isolation|privacy|redact|scope)/i
const RAG_DOMAIN_PATTERN = /(rag|retrieval|citation confidence|rerank|vector|keyword|graphrag|source|grounding)/i
const PROMPT_SAFETY_DOMAIN_PATTERN =
  /(prompt|guardrail|safety|injection|unsafe|medical|diagnos|allegation|unsupported claim|quality)/i

function riskBand(score: number): "low" | "medium" | "high" | "critical" {
  if (score >= 6) return "critical"
  if (score >= 4) return "high"
  if (score >= 2) return "medium"
  return "low"
}

function maxRiskBand(
  left: "low" | "medium" | "high" | "critical",
  right: "low" | "medium" | "high" | "critical"
): "low" | "medium" | "high" | "critical" {
  const rank = { low: 0, medium: 1, high: 2, critical: 3 } as const
  return rank[left] >= rank[right] ? left : right
}

const ROUTE_LADDERS: Record<TaskRouteShape, AdapterType[]> = {
  repo_execution: ["codex_local", "azure_foundry", "gemini_local"],
  frontend_execution: ["codex_local", "gemini_local", "azure_foundry"],
  planning: ["codex_local", "azure_foundry", "gemini_local"],
  review: ["codex_local", "azure_foundry", "gemini_local"],
  coordination: ["codex_local", "azure_foundry", "gemini_local"],
  general: ["codex_local", "azure_foundry", "gemini_local"]
}

type ModelPricing = {
  inputUsdPerMillionTokens: number
  outputUsdPerMillionTokens: number
  source: string
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  "gpt-6-astra": {
    inputUsdPerMillionTokens: 10,
    outputUsdPerMillionTokens: 50,
    source: "https://developers.openai.com/api/docs/models/gpt-6-astra (2026-09-05)"
  },
  "gpt-5.6-sol": {
    inputUsdPerMillionTokens: 5,
    outputUsdPerMillionTokens: 30,
    source: "OpenAI API pricing, checked 2026-07-12"
  },
  "gpt-5.6-terra": {
    inputUsdPerMillionTokens: 2.5,
    outputUsdPerMillionTokens: 15,
    source: "OpenAI API pricing, checked 2026-07-12"
  },
  "gpt-5.6-luna": {
    inputUsdPerMillionTokens: 1,
    outputUsdPerMillionTokens: 6,
    source: "OpenAI API pricing, checked 2026-07-12"
  },
  "gpt-5.5": {
    inputUsdPerMillionTokens: 5,
    outputUsdPerMillionTokens: 30,
    source: "OpenAI API pricing, checked 2026-05-03"
  },
  "gpt-5.4": {
    inputUsdPerMillionTokens: 2.5,
    outputUsdPerMillionTokens: 15,
    source: "OpenAI API pricing, checked 2026-05-03"
  },
  "gpt-5.4-mini": {
    inputUsdPerMillionTokens: 0.75,
    outputUsdPerMillionTokens: 4.5,
    source: "OpenAI API pricing, checked 2026-05-03"
  },
  "gemini-pro": {
    inputUsdPerMillionTokens: 2,
    outputUsdPerMillionTokens: 12,
    source: "Google Agent Platform Gemini 3.1 Pro standard pricing, checked 2026-05-03"
  },
  "gemini-flash": {
    inputUsdPerMillionTokens: 0.5,
    outputUsdPerMillionTokens: 3,
    source: "Google Agent Platform Gemini 3 Flash standard pricing, checked 2026-05-03"
  },
  "gemini-flash-lite": {
    inputUsdPerMillionTokens: 0.25,
    outputUsdPerMillionTokens: 1.5,
    source: "Google Agent Platform Gemini 3.1 Flash-Lite standard pricing, checked 2026-05-03"
  }
}

function normalize(value: string): string {
  return value.trim().toLowerCase()
}

function collectTaskHints(task: Task, persona: Persona | null = null): string[] {
  const hints = [
    task.kind,
    task.stage ?? "",
    task.laneId ?? "",
    task.title,
    task.description ?? "",
    persona?.name ?? "",
    persona?.stage ?? "",
    ...task.labels,
    ...task.changedFiles,
    ...task.allowedPaths,
    ...task.requiredReading,
    ...task.verificationCommands,
    ...(task.taskPackage?.inferenceSignals ?? []),
    ...(task.taskPackage?.requiredReading ?? []),
    ...(task.taskPackage?.verificationChecklist ?? []),
    ...(task.taskPackage?.contractUpdateReminders ?? [])
  ]

  return hints.map(normalize).filter(Boolean)
}

function collectTaskTextHints(task: Task, persona: Persona | null = null): string[] {
  return [
    task.kind,
    task.stage ?? "",
    task.laneId ?? "",
    task.title,
    task.description ?? "",
    persona?.name ?? "",
    persona?.stage ?? "",
    ...task.labels,
    ...(task.taskPackage?.inferenceSignals ?? []),
    ...(task.taskPackage?.contractUpdateReminders ?? [])
  ]
    .map(normalize)
    .filter(Boolean)
}

function matchesPatterns(hints: string[], patterns: readonly string[]): boolean {
  const normalizedPatterns = patterns.map(normalize).filter(Boolean)
  return normalizedPatterns.some((pattern) =>
    hints.some((hint) => {
      if (/^[a-z0-9]+$/.test(pattern) && pattern.length <= 2) {
        const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`).test(hint)
      }
      return hint.includes(pattern)
    })
  )
}

function preferredRule(task: Task, rules: RoutingRule[]): RoutingRule | null {
  const hints = collectTaskHints(task)
  const sortedRules = [...rules].sort((left, right) => right.priority - left.priority)

  for (const rule of sortedRules) {
    if (rule.matchType === "default") continue
    if (matchesPatterns(hints, rule.patterns)) return rule
  }

  return sortedRules.find((rule) => rule.isFallback) ?? null
}

function ladderWeight(ladderRank: number): number {
  if (ladderRank <= 0) return 90
  if (ladderRank === 1) return 55
  if (ladderRank === 2) return 20
  return 0
}

function isAgentActive(agent: Agent): boolean {
  return agent.status !== "paused" && agent.status !== "blocked"
}

function isHealthQuotaBlocked(health: AdapterHealthcheckResult | null | undefined): boolean {
  return Boolean(
    health &&
      !health.ok &&
      /quota|rate[\s-]?limit|429|resource exhausted|limit reached|predictive|circuit/i.test(health.message)
  )
}

export function activeAgentsForAdapter(agents: Agent[], adapterType: AdapterType): Agent[] {
  return agents.filter((candidate) => candidate.adapterType === adapterType && isAgentActive(candidate))
}

export function taskLooksLikeUi(task: Task): boolean {
  return matchesPatterns(collectTaskHints(task), UI_HINTS)
}

function taskHasBackendOwnershipLane(task: Task): boolean {
  return /(?:^|[-_])backend(?:[-_]|$)/i.test(task.laneId ?? "")
}

export function taskNeedsLargeContextPlanning(task: Task): boolean {
  const hints = collectTaskHints(task)
  const readingCount = task.requiredReading.length + (task.taskPackage?.requiredReading?.length ?? 0)
  const signalCount = task.taskPackage?.inferenceSignals?.length ?? 0
  return (
    readingCount >= 4 || signalCount >= 5 || matchesPatterns(hints, ["large context", "codebase", "broad analysis"])
  )
}

export function taskHasHardExecutionSignals(task: Task): boolean {
  const verificationCount = task.verificationCommands.length + (task.taskPackage?.verificationChecklist?.length ?? 0)
  return (
    task.kind === "implement" ||
    task.kind === "fix_review_feedback" ||
    task.allowedPaths.length > 0 ||
    verificationCount > 0 ||
    task.changedFiles.some((file) => CODE_FILE_PATTERN.test(file))
  )
}

export function taskRequiresTools(task: Task): boolean {
  const hints = collectTaskTextHints(task)
  return taskHasHardExecutionSignals(task) || matchesPatterns(hints, TOOL_HINTS) || matchesPatterns(hints, CODE_HINTS)
}

export function taskLooksPlanningOnly(task: Task): boolean {
  const hints = collectTaskHints(task)
  return (
    (task.kind === "plan" || task.stage === "planner" || matchesPatterns(hints, PLANNING_HINTS)) &&
    !taskHasHardExecutionSignals(task)
  )
}

export function taskLooksReviewOnly(task: Task): boolean {
  const hints = collectTaskHints(task)
  const isReviewKind =
    task.kind === "review" ||
    task.kind === "promote" ||
    task.kind === "follow_up" ||
    task.stage === "reviewer" ||
    task.stage === "promoter" ||
    matchesPatterns(hints, REVIEW_HINTS)
  const verificationCount = task.verificationCommands.length + (task.taskPackage?.verificationChecklist?.length ?? 0)
  return isReviewKind && task.allowedPaths.length === 0 && verificationCount === 0
}

function classifyTaskShape(task: Task): { shape: TaskRouteShape; reasons: string[] } {
  const reasons: string[] = []
  const ui = taskLooksLikeUi(task)
  const planning = taskLooksPlanningOnly(task)
  const reviewOnly = taskLooksReviewOnly(task)
  const tools = taskRequiresTools(task)
  const largeContext = taskNeedsLargeContextPlanning(task)

  if (planning) {
    reasons.push("task is planning/decomposition focused")
    if (largeContext) reasons.push("task needs broad context or synthesis")
    return { shape: "planning", reasons }
  }

  if (reviewOnly) {
    reasons.push("task is review/summary/coordination oriented")
    return { shape: task.kind === "follow_up" || task.kind === "promote" ? "coordination" : "review", reasons }
  }

  if (tools && taskHasBackendOwnershipLane(task)) {
    reasons.push("backend ownership lane requires repo execution")
    return { shape: "repo_execution", reasons }
  }

  if (ui) {
    reasons.push("task hints point to frontend or UI execution")
    return { shape: "frontend_execution", reasons }
  }

  if (tools) {
    reasons.push("task requires tools, code edits, or repo verification")
    return { shape: "repo_execution", reasons }
  }

  if (largeContext) {
    reasons.push("task needs large-context analysis")
    return { shape: "planning", reasons }
  }

  reasons.push("task falls back to general-purpose execution")
  return { shape: "general", reasons }
}

function hasAnyPattern(values: readonly string[], patterns: readonly RegExp[]): boolean {
  return values.some((value) => patterns.some((pattern) => pattern.test(value)))
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)))
}

function scoreBand100(score: number): "low" | "medium" | "high" | "critical" {
  if (score >= 85) return "critical"
  if (score >= 65) return "high"
  if (score >= 35) return "medium"
  return "low"
}

function blendPlannerRouteScore(plannedScore: number | undefined, heuristicScore: number): number {
  if (plannedScore === undefined) return heuristicScore
  return clampScore(plannedScore * 0.75 + heuristicScore * 0.25)
}

function inferPromptIntent(task: Task, shape: TaskRouteShape, domains: string[]): PromptRouteIntent {
  const hints = collectTaskHints(task)
  if (domains.includes("retrieval-rag")) return "retrieval"
  if (hints.some((hint) => /idea|ideat|brainstorm|candidate|backlog/.test(hint))) return "ideation"
  if (hints.some((hint) => /prompt|instruction|system message|agent prompt/.test(hint))) return "promptify"
  return shape === "general" ? "repo_execution" : shape
}

function recommendedPersonaStageForIntent(intent: PromptRouteIntent, shape: TaskRouteShape): PersonaStage | null {
  if (intent === "ideation" || shape === "planning") return "planner"
  if (intent === "promptify") return "coder"
  if (shape === "review" || shape === "coordination") return "reviewer"
  if (shape === "repo_execution" || shape === "frontend_execution") return "coder"
  return null
}

function buildPromptRouteRank(input: {
  task: Task
  shape: TaskRouteShape
  domains: string[]
  complexitySignals: string[]
  importanceSignals: string[]
  persona: Persona | null
}): PromptRouteRank {
  const { complexitySignals, domains, importanceSignals, persona, shape, task } = input
  const hints = collectTaskHints(task, persona)
  const intent = inferPromptIntent(task, shape, domains)
  const fileCount = new Set([...task.changedFiles, ...task.allowedPaths]).size
  const readingCount = new Set([...task.requiredReading, ...(task.taskPackage?.requiredReading ?? [])]).size
  const verificationCount = new Set([...task.verificationCommands, ...(task.taskPackage?.verificationChecklist ?? [])])
    .size
  const sourceSignalCount = task.taskPackage?.inferenceSignals.length ?? 0
  const hasPrompt = Boolean(task.description?.trim()) || Boolean(task.taskPackage?.extraInstructions?.length)
  const hasScope = fileCount > 0 || readingCount > 0 || Boolean(task.laneId ?? task.taskPackage?.likelyOwnershipLane)
  const hasAcceptance = verificationCount > 0 || hints.some((hint) => /acceptance|done when|verify|test/.test(hint))
  const hasPersona = Boolean(persona ?? task.personaId ?? task.stage)
  const ambiguity = hints.some((hint) => /maybe|somehow|make better|unclear|unknown|investigate|diagnose/.test(hint))

  const ideationScore = clampScore(
    task.priority +
      sourceSignalCount * 6 +
      (task.labels.some((label) => /planner|idea|backlog|candidate/.test(label)) ? 15 : 0) +
      (task.taskPackage?.taskLineage ? 10 : 0) +
      (task.dependsOnTaskIds.length > 0 ? 6 : 0)
  )
  const promptQualityScore = clampScore(
    20 +
      (hasPrompt ? 20 : 0) +
      (hasScope ? 20 : 0) +
      (hasAcceptance ? 20 : 0) +
      (hasPersona ? 10 : 0) +
      (task.taskPackage?.contractUpdateReminders.length ? 5 : 0) -
      (ambiguity ? 15 : 0)
  )
  const heuristicComplexityScore100 = clampScore(
    {
      coordination: 14,
      review: 28,
      planning: 42,
      general: 35,
      frontend_execution: 35,
      repo_execution: 38
    }[shape] +
      complexitySignals.length * 8 +
      domains.length * 8 +
      fileCount * 4 +
      readingCount * 4 +
      verificationCount * 4 +
      (ambiguity ? 12 : 0)
  )
  const heuristicValueScore100 = clampScore(
    20 +
      importanceSignals.length * 15 +
      (domains.includes("legal-evidence") || domains.includes("security-scope") ? 20 : 0) +
      (task.reviewRequired ? 8 : 0) +
      (task.approvalRequired ? 12 : 0) +
      Math.min(15, Math.max(0, task.priority) / 5)
  )
  const plannedRank = task.taskPackage?.promptRouteRank
  const complexityScore100 = blendPlannerRouteScore(plannedRank?.complexityScore100, heuristicComplexityScore100)
  const valueScore100 = blendPlannerRouteScore(plannedRank?.valueScore100, heuristicValueScore100)
  const promptSignals = [
    `intent:${intent}`,
    `shape:${shape}`,
    `prompt_quality:${promptQualityScore}`,
    `complexity_100:${complexityScore100}`,
    `value_100:${valueScore100}`,
    ...domains.map((domain) => `domain:${domain}`),
    ...(plannedRank
      ? [`planner_complexity_100:${plannedRank.complexityScore100}`, `planner_value_100:${plannedRank.valueScore100}`]
      : [])
  ]
  const rankingReasons = [
    `ideation score ${ideationScore} from priority/source-signal/lineage hints`,
    `prompt quality ${promptQualityScore} from prompt, scope, persona, and verification detail`,
    `complexity estimate ${complexityScore100}/100 from shape, files, reading, domains, and ambiguity`,
    `value estimate ${valueScore100}/100 from importance, governance, and domain sensitivity`,
    ...(plannedRank
      ? [
          `planner route estimate anchored complexity at ${plannedRank.complexityScore100}/100 and value at ${plannedRank.valueScore100}/100`
        ]
      : [])
  ]

  return {
    pipeline: ["ideation", "promptify", "complexity_estimate", "model_router"],
    intent,
    ideationScore,
    promptQualityScore,
    complexityScore100,
    valueScore100,
    recommendedPersonaStage: recommendedPersonaStageForIntent(intent, shape),
    promptSignals,
    rankingReasons
  }
}

export function assessTaskRisk(task: Task, shape: TaskRouteShape, persona: Persona | null = null): TaskRiskAssessment {
  const complexitySignals: string[] = []
  const importanceSignals: string[] = []
  const domains: string[] = []
  const textHints = collectTaskHints(task, persona)
  const filesAndPaths = [...task.changedFiles, ...task.allowedPaths, ...task.requiredReading]
  const verificationCount = task.verificationCommands.length + (task.taskPackage?.verificationChecklist?.length ?? 0)
  const allHints = [...filesAndPaths, ...textHints]

  const addDomain = (domain: string): void => {
    if (!domains.includes(domain)) domains.push(domain)
  }

  if (hasAnyPattern(allHints, [LEGAL_DOMAIN_PATTERN])) addDomain("legal-evidence")
  if (hasAnyPattern(allHints, [SECURITY_DOMAIN_PATTERN])) addDomain("security-scope")
  if (hasAnyPattern(allHints, [RAG_DOMAIN_PATTERN])) addDomain("retrieval-rag")
  if (hasAnyPattern(allHints, [PROMPT_SAFETY_DOMAIN_PATTERN])) addDomain("prompt-safety")
  if (taskLooksLikeUi(task)) addDomain("frontend-ui")
  if (shape === "repo_execution") addDomain("repo-code")

  if (new Set([...task.changedFiles, ...task.allowedPaths]).size > 1)
    complexitySignals.push("multi-file or multi-path scope")
  if (hasAnyPattern(allHints, [BACKEND_CONTRACT_PATTERN])) {
    complexitySignals.push("backend/API/contract surface")
  }
  if (hasAnyPattern(allHints, [FRONTEND_STATE_PATTERN]) && taskLooksLikeUi(task)) {
    complexitySignals.push("frontend stateful workflow")
  }
  if (hasAnyPattern(allHints, [DB_OR_SCHEMA_PATTERN])) {
    complexitySignals.push("DB/schema/migration surface")
  }
  if (verificationCount > 0 || textHints.some((hint) => /test|ci|check|verify|lint|typecheck/.test(hint))) {
    complexitySignals.push("tests or verification required")
  }
  if (textHints.some((hint) => /merge conflict|rebase|not mergeable|red ci|failed ci|promotion repair/.test(hint))) {
    complexitySignals.push("merge or CI repair")
  }
  if (textHints.some((hint) => /unclear|ambiguous|investigate|unknown|root cause|diagnose/.test(hint))) {
    complexitySignals.push("unclear acceptance or diagnosis required")
  }
  if (taskNeedsLargeContextPlanning(task)) complexitySignals.push("large-context planning")
  if (shape === "repo_execution" || shape === "frontend_execution") complexitySignals.push("tool-using implementation")

  if (domains.includes("legal-evidence") || textHints.some((hint) => /compliance|audit|non-repudiation/.test(hint))) {
    importanceSignals.push("legal/compliance/audit domain")
  }
  if (domains.includes("security-scope")) {
    importanceSignals.push("auth/security/tenant isolation")
  }
  if (textHints.some((hint) => /production|deploy|release|promote|rollback|outage|incident recovery/.test(hint))) {
    importanceSignals.push("production release or deployment")
  }
  if (taskLooksLikeUi(task) || textHints.some((hint) => /user-facing|workflow|\bui\b|workspace/.test(hint))) {
    importanceSignals.push("user-facing workflow")
  }
  if (textHints.some((hint) => /data integrity|migration|schema|persistence|storage|database/.test(hint))) {
    importanceSignals.push("data integrity")
  }
  if (textHints.some((hint) => /ci blocker|failed ci|red ci|blocking check|release blocker/.test(hint))) {
    importanceSignals.push("CI or release blocker")
  }

  const complexityScore = complexitySignals.length
  const importanceScore = importanceSignals.reduce((score, signal) => {
    if (signal === "legal/compliance/audit domain") return score + 2
    if (signal === "auth/security/tenant isolation") return score + 2
    if (signal === "production release or deployment") return score + 2
    return score + 1
  }, 0)
  const promptRouteRank = buildPromptRouteRank({
    task,
    shape,
    domains,
    complexitySignals,
    importanceSignals,
    persona
  })

  return {
    complexityScore,
    complexityScore100: promptRouteRank.complexityScore100,
    importanceScore,
    valueScore100: promptRouteRank.valueScore100,
    complexityBand: scoreBand100(promptRouteRank.complexityScore100),
    importanceBand: scoreBand100(promptRouteRank.valueScore100),
    domains,
    complexitySignals,
    importanceSignals,
    promptRouteRank
  }
}

function targetModelFamily(input: {
  adapterType: AdapterType
  shape: TaskRouteShape
  risk: TaskRiskAssessment
  task: Task
}): { model: string | null; family: string; reasoningEffort: ModelReasoningEffort; reason: string } {
  const { adapterType, risk, shape, task } = input
  const textHints = collectTaskHints(task)
  const isTextFirst = shape === "planning" || shape === "review" || shape === "coordination"
  const isCritical = risk.valueScore100 >= 92 && risk.complexityScore100 >= 92
  const isSensitiveHighValue =
    risk.domains.some((domain) => ["legal-evidence", "security-scope", "prompt-safety"].includes(domain)) &&
    (risk.complexityScore100 >= 75 || risk.valueScore100 >= 75)
  const isHard = risk.complexityScore100 >= 70 || risk.valueScore100 >= 85 || isSensitiveHighValue
  const isLow = risk.complexityScore100 < 35 && risk.valueScore100 < 35
  const isCoding = shape === "repo_execution" || shape === "frontend_execution" || taskRequiresTools(task)
  const wantsBudgetModel = textHints.some((hint) =>
    /\b(?:budget(?:-first)?|cost[- ]sensitive|economy|economical|low[- ]cost|save tokens?)\b/.test(hint)
  )
  const recoveryReason = task.lastRecoveryReason?.toLowerCase() ?? ""
  const isPreservedCommitRecovery =
    Boolean(recoveryReason) &&
    textHints.some((hint) => /recover(?:y|ed)?[^.\n]{0,80}commit|cherry-pick|preserved commit/.test(hint))
  const recoveryNeedsDiagnosis = /verification|failed-review|conflict/.test(recoveryReason)
  const wantsKimiReasoning = risk.domains.some((domain) =>
    ["legal-evidence", "security-scope", "retrieval-rag", "prompt-safety"].includes(domain)
  )

  if (adapterType === "azure_foundry") {
    if (isLow && (shape === "review" || shape === "coordination") && !wantsKimiReasoning) {
      return {
        model: "gpt-5.4-mini",
        family: "gpt-5.4-mini",
        reasoningEffort: "medium",
        reason: "low-risk text-only review or coordination can use GPT-5.4-Mini on Foundry"
      }
    }
    if (wantsKimiReasoning) {
      return {
        model: "Kimi-K2.6",
        family: "kimi-2.6",
        reasoningEffort: "high",
        reason: "Kimi-K2.6 is selected for legal, security, retrieval, prompt-safety, or evidence synthesis"
      }
    }
    if ((isCritical || risk.valueScore100 >= 85 || risk.complexityScore100 >= 75) && isTextFirst) {
      return {
        model: "gpt-5.4",
        family: "gpt-5.4",
        reasoningEffort: "high",
        reason: "high-risk text-first planning or review uses GPT-5.4 on Foundry"
      }
    }
    if (isTextFirst || !isCoding) {
      return {
        model: "Kimi-K2.6",
        family: "kimi-2.6",
        reasoningEffort: "medium",
        reason: "Kimi-K2.6 handles text-first planning, review, synthesis, and task packaging"
      }
    }
    return {
      model: "Kimi-K2.6",
      family: "kimi-2.6",
      reasoningEffort: "medium",
      reason: "Azure Foundry is acting as a fallback, so use the broad-reasoning Kimi-K2.6 endpoint"
    }
  }

  if (adapterType === "codex_local") {
    if (wantsBudgetModel) {
      const reasoningEffort = isCritical || isHard ? "high" : isLow ? "low" : "medium"
      return {
        model: "gpt-5.6-terra",
        family: "gpt-5.6-terra",
        reasoningEffort,
        reason: `explicit budget or cost-sensitive work uses GPT-5.6 Terra ${reasoningEffort} reasoning`
      }
    }
    if (isCoding && isPreservedCommitRecovery) {
      const reasoningEffort = recoveryNeedsDiagnosis ? "high" : "medium"
      return {
        model: "gpt-5.6-sol",
        family: "gpt-5.6-sol",
        reasoningEffort,
        reason: `preserved commit recovery uses GPT-5.6 Sol ${reasoningEffort} reasoning instead of recomputing the original task at max effort`
      }
    }
    if (isCritical || risk.complexityScore100 >= 90) {
      return {
        model: "gpt-6-astra",
        family: "gpt-6-astra",
        reasoningEffort: isCritical ? "max" : "high",
        reason: "critical or exceptionally complex work requires GPT-6 Astra"
      }
    }
    if (isHard) {
      return {
        model: "gpt-5.6-sol",
        family: "gpt-5.6-sol",
        reasoningEffort: "high",
        reason: "high complexity or importance requires GPT-5.6 Sol high reasoning"
      }
    }
    if (isCoding) {
      return {
        model: isLow ? "gpt-5.6-luna" : "gpt-5.6-terra",
        family: isLow ? "gpt-5.6-luna" : "gpt-5.6-terra",
        reasoningEffort: isLow ? "low" : "medium",
        reason: isLow
          ? "small low-risk implementation uses GPT-5.6 Luna"
          : "routine implementation uses GPT-5.6 Terra medium reasoning"
      }
    }
    if (isLow || textHints.some((hint) => /status|summary|queue|bookkeeping|clean merge/.test(hint))) {
      return {
        model: "gpt-5.6-luna",
        family: "gpt-5.6-luna",
        reasoningEffort: "low",
        reason: "low-risk orchestration and bookkeeping fit GPT-5.6 Luna low reasoning"
      }
    }
    return {
      model: "gpt-5.6-sol",
      family: "gpt-5.6-sol",
      reasoningEffort: "medium",
      reason: "default Codex execution target is GPT-5.6 Sol medium reasoning"
    }
  }

  return {
    model: null,
    family: "gemini",
    reasoningEffort: "medium",
    reason: "Gemini adapter keeps its configured model while routing policy records medium reasoning"
  }
}

export function normalizedModelFamily(agent: Agent): string {
  const model = (agent.model ?? "").toLowerCase()
  if (model === "gpt-6" || model.includes("gpt-6-astra")) return "gpt-6-astra"
  if (model === "gpt-5.6" || model.includes("gpt-5.6-sol")) return "gpt-5.6-sol"
  if (model.includes("gpt-5.6-terra")) return "gpt-5.6-terra"
  if (model.includes("gpt-5.6-luna")) return "gpt-5.6-luna"
  if (model.includes("gpt-5.5")) return "gpt-5.5"
  if (model.includes("gpt-5.4-mini")) return "gpt-5.4-mini"
  if (model.includes("gpt-5.4")) return "gpt-5.4"
  if (model.includes("gpt-5.2")) return "gpt-5.2"
  if (model.includes("gpt-5.3-codex-spark")) return "gpt-5.3-codex-spark"
  if (model.includes("kimi-k2.6")) return "kimi-k2.6"
  if (model.includes("kimi-2.6")) return "kimi-2.6"
  if (model.includes("gemini") && model.includes("flash") && model.includes("lite")) return "gemini-flash-lite"
  if (model.includes("gemini") && model.includes("flash")) return "gemini-flash"
  if (model.includes("gemini") && model.includes("pro")) return "gemini-pro"
  if (model.includes("gemini")) return "gemini"
  if (!model && agent.adapterType === "codex_local") return "codex-default"
  if (!model && agent.adapterType === "gemini_local") return "gemini-default"
  return model || "unknown"
}

function pricingForFamily(family: string): ModelPricing | null {
  return MODEL_PRICING[family] ?? null
}

function estimateRouteTokens(input: {
  task: Task
  shape: TaskRouteShape
  risk: TaskRiskAssessment
  reasoningEffort: ModelReasoningEffort
}): { inputTokens: number; outputTokens: number; valueBand: "low" | "medium" | "high" | "critical" } {
  const { reasoningEffort, risk, shape, task } = input
  const valueBand = maxRiskBand(risk.complexityBand, risk.importanceBand)
  const shapeInputBase: Record<TaskRouteShape, number> = {
    coordination: 3_000,
    review: 8_000,
    planning: 14_000,
    frontend_execution: 18_000,
    repo_execution: 22_000,
    general: 6_000
  }
  const shapeOutputBase: Record<TaskRouteShape, number> = {
    coordination: 700,
    review: 1_200,
    planning: 2_000,
    frontend_execution: 1_800,
    repo_execution: 2_200,
    general: 1_000
  }
  const riskMultiplier = {
    low: 0.6,
    medium: 1,
    high: 1.6,
    critical: 2.4
  }[valueBand]
  const effortMultiplier = {
    none: 0.65,
    low: 0.8,
    medium: 1,
    high: 1.25,
    xhigh: 1.6,
    max: 2,
    ultra: 2.4
  }[reasoningEffort]
  const fileInput = new Set([...task.changedFiles, ...task.allowedPaths]).size * 1_200
  const readingInput = (task.requiredReading.length + (task.taskPackage?.requiredReading?.length ?? 0)) * 1_800
  const signalInput = (task.taskPackage?.inferenceSignals?.length ?? 0) * 300
  const verificationInput =
    (task.verificationCommands.length + (task.taskPackage?.verificationChecklist?.length ?? 0)) * 500
  const largeContextInput = taskNeedsLargeContextPlanning(task) ? 12_000 : 0
  const inputTokens = Math.round(
    (shapeInputBase[shape] + fileInput + readingInput + signalInput + verificationInput + largeContextInput) *
      riskMultiplier *
      effortMultiplier
  )
  const outputTokens = Math.round(shapeOutputBase[shape] * riskMultiplier * effortMultiplier)
  return { inputTokens, outputTokens, valueBand }
}

export function estimateRouteCost(input: {
  task: Task
  shape: TaskRouteShape
  risk: TaskRiskAssessment
  model: string | null
  modelFamily: string
  reasoningEffort: ModelReasoningEffort
}) {
  const pricing = pricingForFamily(input.modelFamily)
  const tokenEstimate = estimateRouteTokens(input)
  const estimatedUsd = pricing
    ? (tokenEstimate.inputTokens * pricing.inputUsdPerMillionTokens +
        tokenEstimate.outputTokens * pricing.outputUsdPerMillionTokens) /
      1_000_000
    : null

  return {
    model: input.model,
    modelFamily: input.modelFamily,
    pricingSource: pricing?.source ?? null,
    inputTokens: tokenEstimate.inputTokens,
    outputTokens: tokenEstimate.outputTokens,
    inputUsdPerMillionTokens: pricing?.inputUsdPerMillionTokens ?? null,
    outputUsdPerMillionTokens: pricing?.outputUsdPerMillionTokens ?? null,
    estimatedUsd: estimatedUsd === null ? null : Number(estimatedUsd.toFixed(4)),
    valueBand: tokenEstimate.valueBand
  }
}

function costScoreAdjustment(cost: ReturnType<typeof estimateRouteCost>): { delta: number; reason: string | null } {
  if (cost.estimatedUsd === null) {
    return {
      delta: 0,
      reason: "model pricing is unknown; cost did not affect routing"
    }
  }

  if (cost.valueBand === "low") {
    if (cost.estimatedUsd <= 0.02)
      return { delta: 10, reason: `low-value work favors low estimated cost $${cost.estimatedUsd}` }
    if (cost.estimatedUsd >= 0.08)
      return { delta: -18, reason: `low-value work avoids high estimated cost $${cost.estimatedUsd}` }
  }
  if (cost.valueBand === "medium") {
    if (cost.estimatedUsd <= 0.04)
      return { delta: 5, reason: `medium-value work gets a small efficiency bonus at $${cost.estimatedUsd}` }
    if (cost.estimatedUsd >= 0.18)
      return { delta: -8, reason: `medium-value work avoids oversized estimated cost $${cost.estimatedUsd}` }
  }
  if ((cost.valueBand === "high" || cost.valueBand === "critical") && cost.estimatedUsd <= 0.03) {
    return {
      delta: -6,
      reason: `high-value work avoids underpowered cheap routing despite low cost $${cost.estimatedUsd}`
    }
  }

  return { delta: 0, reason: `estimated route cost $${cost.estimatedUsd}` }
}

function nameOrRole(agent: Agent): string {
  return `${agent.name} ${agent.role}`.toLowerCase()
}

function agentScopeHintScore(task: Task, agent: Agent, persona: Persona | null, reasons: string[]): number {
  const name = agent.name.toLowerCase()
  const role = agent.role.toLowerCase()
  let score = 0

  if (persona) {
    if (name.includes(persona.name.toLowerCase())) {
      score += 30
      reasons.push(`agent name matches persona ${persona.name}`)
    }
    if (name.includes(persona.stage.toLowerCase()) || role.includes(persona.stage.toLowerCase())) {
      score += 16
      reasons.push(`agent role aligns with persona stage ${persona.stage}`)
    }
  }

  if (task.laneId?.startsWith("ui-") && (name.includes("ui") || name.includes("frontend") || role.includes("ui"))) {
    score += 12
    reasons.push("agent is lane-aligned with UI work")
  }
  if (task.laneId?.startsWith("backend-") && (name.includes("backend") || role.includes("backend"))) {
    score += 12
    reasons.push("agent is lane-aligned with backend work")
  }
  if (task.kind === "review" && (name.includes("review") || role.includes("review") || role.includes("quality"))) {
    score += 12
    reasons.push("agent role matches review work")
  }
  if (task.kind === "promote" && (name.includes("promot") || role.includes("promot") || role.includes("release"))) {
    score += 10
    reasons.push("agent role matches promotion work")
  }

  return score
}

function scoreAgentCandidate(task: Task, agent: Agent, persona: Persona | null = null): AgentSelectionCandidate {
  const reasons: string[] = []
  const family = normalizedModelFamily(agent)
  const uiTask = taskLooksLikeUi(task)
  const repoExecution = taskRequiresTools(task)
  const planning = taskLooksPlanningOnly(task) || persona?.stage === "planner"
  const reviewish = task.kind === "review" || persona?.stage === "reviewer" || task.reviewRequired
  const coordination = task.kind === "promote" || task.kind === "follow_up" || persona?.stage === "promoter"
  const largeContext = taskNeedsLargeContextPlanning(task)
  const shape = classifyTaskShape(task).shape
  const risk = assessTaskRisk(task, shape, persona)
  const target = targetModelFamily({ adapterType: agent.adapterType, shape, risk, task })
  const costEstimate = estimateRouteCost({
    task,
    shape,
    risk,
    model: agent.model,
    modelFamily: family,
    reasoningEffort: target.reasoningEffort
  })

  let score = agentScopeHintScore(task, agent, persona, reasons)
  const tierDecision = selectWorkerRoleTier(task)
  const agentIdentity = `${nameOrRole(agent)} ${family}`

  if (tierDecision.tier === "senior") {
    if (
      agentIdentity.includes("gpt-6-astra") ||
      agentIdentity.includes("gpt-5.6-sol") ||
      agentIdentity.includes("gpt-5.6-terra") ||
      agentIdentity.includes("gpt-5.5") ||
      agentIdentity.includes("gpt-5.4") ||
      agentIdentity.includes("kimi") ||
      agentIdentity.includes("pro") ||
      agentIdentity.includes("senior")
    ) {
      score += 12
      reasons.push(`worker tier ${tierDecision.role}/senior favors stronger model profile`)
    }
    if (agentIdentity.includes("mini") || agentIdentity.includes("flash") || agentIdentity.includes("spark")) {
      score -= 8
      reasons.push(`worker tier ${tierDecision.role}/senior deprioritizes lightweight model profile`)
    }
  } else if (tierDecision.tier === "junior") {
    if (
      agentIdentity.includes("gpt-5.6-luna") ||
      agentIdentity.includes("mini") ||
      agentIdentity.includes("flash") ||
      agentIdentity.includes("spark")
    ) {
      score += 8
      reasons.push(`worker tier ${tierDecision.role}/junior favors efficient model profile`)
    }
    if (agentIdentity.includes("gpt-5.5") || agentIdentity.includes("kimi") || agentIdentity.includes("pro")) {
      score -= 4
      reasons.push(`worker tier ${tierDecision.role}/junior avoids oversized model profile`)
    }
  }

  if (tierDecision.role === "tester" && /test|qa|verify|quality/.test(agentIdentity)) {
    score += 6
    reasons.push("worker role tier signal matches tester agent profile")
  }
  if (
    tierDecision.role === "architect" &&
    (agent.adapterType === "azure_foundry" || /architect|planner|kimi/.test(agentIdentity))
  ) {
    score += 6
    reasons.push("worker role tier signal matches architect/planner profile")
  }

  if (family === target.family) {
    score += 34
    reasons.push(`model family matches policy target ${target.family}`)
  } else if (agent.adapterType === "codex_local" && target.family === "gpt-5.4" && family === "gpt-5.5") {
    score -= 10
    reasons.push("GPT-5.5 is available but oversized for GPT-5.4-targeted work")
  } else if (agent.adapterType === "codex_local" && target.family === "gpt-5.5" && family === "gpt-5.4") {
    score -= 18
    reasons.push("GPT-5.4 is weaker than the policy target GPT-5.5")
  }

  const costAdjustment = costScoreAdjustment(costEstimate)
  score += costAdjustment.delta
  if (costAdjustment.reason) {
    reasons.push(costAdjustment.reason)
  }

  switch (agent.adapterType) {
    case "codex_local":
      if (repoExecution) {
        score += 70
        reasons.push("Codex owns tool-using repo execution")
      }
      if (!uiTask) {
        score += 10
        reasons.push("task is not UI-first")
      }
      if (family === "gpt-6-astra") {
        score += target.family === "gpt-6-astra" ? 30 : -20
        reasons.push(
          target.family === "gpt-6-astra"
            ? "Astra matches exceptional task complexity"
            : "Astra exceeds this task's required capability"
        )
      } else if (family === "gpt-5.6-sol") {
        if (target.family === "gpt-5.6-sol" || risk.complexityScore100 >= 80 || risk.valueScore100 >= 75) {
          score += 24
          reasons.push("GPT-5.6 Sol is favored for substantive Codex work with effort scaled to complexity")
        } else {
          score -= 8
          reasons.push("GPT-5.6 Sol is not needed for this explicitly budget-routed or lightweight task")
        }
      } else if (family === "gpt-5.6-terra") {
        if (target.family === "gpt-5.6-terra") {
          score += 22
          reasons.push("GPT-5.6 Terra is favored when the task explicitly requests budget-sensitive execution")
        } else {
          score -= 6
          reasons.push("GPT-5.6 Terra is reserved for explicit budget-sensitive execution")
        }
      } else if (family === "gpt-5.6-luna") {
        if ((reviewish || coordination) && !repoExecution) {
          score += 28
          reasons.push("GPT-5.6 Luna is preferred for low-cost coordination")
        } else {
          score -= 12
          reasons.push("GPT-5.6 Luna is deprioritized for deep repo execution")
        }
      } else if (family === "gpt-5.5") {
        if (target.family === "gpt-5.5" || risk.complexityScore100 >= 80 || risk.valueScore100 >= 75) {
          score += 20
          reasons.push("GPT-5.5 is favored for deep code edits and refactors")
        } else {
          score -= 5
          reasons.push("GPT-5.5 is reserved for higher complexity or higher value Codex work")
        }
      } else if (family === "gpt-5.4") {
        score += 20
        reasons.push("gpt-5.4 is favored for deep code edits and refactors")
        if ((reviewish || coordination) && !repoExecution && !uiTask) {
          score -= 12
          reasons.push("gpt-5.4 is reserved for heavier repo work when coordination is lightweight")
        }
      } else if (family === "gpt-5.4-mini") {
        if ((reviewish || coordination) && !repoExecution) {
          score += 26
          reasons.push("gpt-5.4-mini is preferred for lightweight Codex coordination")
        } else if (reviewish || coordination) {
          score += 14
          reasons.push("gpt-5.4-mini is acceptable for lightweight Codex coordination")
        } else {
          score -= 10
          reasons.push("gpt-5.4-mini is deprioritized for deep repo work")
        }
      } else if (family === "gpt-5.3-codex-spark") {
        score += 10
        reasons.push("gpt-5.3-codex-spark remains a fast Codex fallback")
        if (repoExecution && !coordination) {
          score -= 18
          reasons.push("gpt-5.3-codex-spark is deprioritized for complex repo implementation")
        }
      } else if (family === "codex-default") {
        score += 12
        reasons.push("default Codex model is preferred over unknown variants")
      }
      break
    case "gemini_local":
      if (uiTask) {
        score += 70
        reasons.push("Gemini owns UI-heavy execution")
      }
      if (repoExecution) {
        score += 12
        reasons.push("Gemini can act as a repo-capable fallback")
      }
      if (family === "gemini-pro") {
        if (uiTask && !(coordination && !repoExecution)) {
          score += 22
          reasons.push("Gemini Pro is preferred for frontend iteration")
        } else if (uiTask) {
          score += 8
          reasons.push("Gemini Pro remains viable but is oversized for lightweight UI follow-up")
        }
        if (repoExecution) {
          score += 14
          reasons.push("Gemini Pro handles larger implementation tasks better than Flash")
        }
      } else if (family === "gemini-flash") {
        if (coordination && !repoExecution) {
          score += uiTask ? 32 : 18
          reasons.push("Gemini Flash fits lightweight frontend follow-up")
        } else {
          score -= 6
          reasons.push("Gemini Flash is deprioritized for deep implementation")
        }
      } else if (family === "gemini" || family === "gemini-default") {
        score += 10
        reasons.push("default Gemini remains viable for UI work")
      }
      break
    case "azure_foundry":
      if (planning) {
        score += 32
        reasons.push("Azure Foundry owns planning and decomposition work")
      }
      if (reviewish || coordination || !repoExecution) {
        score += 18
        reasons.push("Azure Foundry fits text-first review and synthesis")
      }
      if (repoExecution) {
        score -= 35
        reasons.push("Azure Foundry is weak for shell/file execution")
      }
      if (family === "kimi-k2.6" || family === "kimi-2.6") {
        if ((planning || largeContext) && target.family === "kimi-2.6") {
          score += 36
          reasons.push("Kimi-K2.6 is preferred for broad analysis and manager planning")
        }
        if ((reviewish || coordination) && target.family === "kimi-2.6") {
          score += 24
          reasons.push("Kimi-K2.6 is preferred for Foundry review and synthesis")
        }
        if (persona?.stage === "reviewer" || persona?.stage === "planner") {
          score += 100
          reasons.push("Kimi-K2.6 is preferred for explicit Foundry reviewer and planner personas")
        }
        if (
          uiTask &&
          target.family === "kimi-2.6" &&
          (nameOrRole(agent).includes("ui") || nameOrRole(agent).includes("contract"))
        ) {
          score += 8
          reasons.push("Kimi agent role hints match UI/contract analysis")
        }
      } else if (family === "gpt-5.4-mini" && target.family === "gpt-5.4-mini") {
        score += 20
        reasons.push("Foundry GPT-5.4-Mini fits low-risk text-only review or coordination")
      } else if (family === "gpt-5.4" && target.family === "gpt-5.4") {
        score += 30
        reasons.push("Foundry GPT-5.4 fits high-risk planning and review")
      }
      break
  }

  return {
    agentId: agent.id,
    agentName: agent.name,
    adapterType: agent.adapterType,
    model: agent.model,
    modelFamily: family,
    score,
    estimatedCostUsd: costEstimate.estimatedUsd,
    reasons
  }
}

export function selectBestAgentForTask(
  task: Task,
  agents: Agent[],
  adapterType: AdapterType,
  persona: Persona | null = null
): AgentSelectionDecision {
  const candidates = activeAgentsForAdapter(agents, adapterType)
    .map((agent) => scoreAgentCandidate(task, agent, persona))
    .sort((left, right) => {
      const scoreDelta = right.score - left.score
      if (scoreDelta !== 0) return scoreDelta
      const leftAgent = agents.find((candidate) => candidate.id === left.agentId)
      const rightAgent = agents.find((candidate) => candidate.id === right.agentId)
      return (leftAgent?.createdAt ?? "").localeCompare(rightAgent?.createdAt ?? "")
    })

  const selected = candidates[0] ?? null
  return {
    agent: selected ? (agents.find((candidate) => candidate.id === selected.agentId) ?? null) : null,
    reason: selected ? selected.reasons.slice(0, 3).join("; ") : null,
    candidates
  }
}

function scoreAdapterCandidate(input: {
  adapterType: AdapterType
  task: Task
  shape: TaskRouteShape
  fallbackLadder: AdapterType[]
  preferredRule: RoutingRule | null
  health: AdapterHealthcheckResult | null
  hasAvailableAgent: boolean
}): RouteScorecardEntry {
  const { adapterType, fallbackLadder, hasAvailableAgent, health, preferredRule, shape, task } = input
  const reasons: string[] = []
  const fallbackIndex = fallbackLadder.indexOf(adapterType)
  const ladderRank = fallbackIndex >= 0 ? fallbackIndex : fallbackLadder.length + 1
  let score = ladderWeight(ladderRank)

  reasons.push(
    fallbackIndex >= 0
      ? `fallback ladder rank ${ladderRank + 1} for ${shape}`
      : `adapter sits outside the primary fallback ladder for ${shape}`
  )

  if (task.requestedAdapterType === adapterType) {
    score += 220
    reasons.push(`task explicitly requested ${adapterType}`)
  }

  if (preferredRule?.targetAdapterType === adapterType) {
    score += preferredRule.matchType === "default" ? 8 : 28
    reasons.push(`matched routing rule ${preferredRule.name}`)
  }

  if (shape === "repo_execution") {
    if (adapterType === "codex_local") {
      score += 48
      reasons.push("Codex is the primary owner for tool-using repo work")
    } else if (adapterType === "gemini_local") {
      score += 20
      reasons.push("Gemini remains a tool-capable fallback")
    } else {
      score -= 40
      reasons.push("Azure Foundry is text-first for repo execution")
    }
  } else if (shape === "frontend_execution") {
    if (adapterType === "gemini_local") {
      score += 48
      reasons.push("Gemini is the primary owner for frontend execution")
    } else if (adapterType === "codex_local") {
      score += 16
      reasons.push("Codex is the repo-capable frontend fallback")
    } else {
      score -= 20
      reasons.push("Azure Foundry is a text-first frontend fallback")
    }
  } else if (shape === "planning") {
    if (adapterType === "azure_foundry") {
      score += 48
      reasons.push("Azure Foundry is the primary owner for planning and synthesis")
    } else if (adapterType === "codex_local") {
      score += 18
      reasons.push("Codex is the planning fallback when tools may still matter")
    } else {
      score += 6
      reasons.push("Gemini is a secondary planning fallback")
    }
  } else if (shape === "review") {
    if (adapterType === "azure_foundry") {
      score += 42
      reasons.push("Azure Foundry is the primary owner for review and quality work")
    } else if (adapterType === "codex_local") {
      score += 12
      reasons.push("Codex is the review fallback")
    }
  } else if (shape === "coordination") {
    if (adapterType === "azure_foundry") {
      score += 34
      reasons.push("Azure Foundry is the primary owner for summaries and lightweight coordination")
    } else if (adapterType === "codex_local") {
      score += 8
      reasons.push("Codex is the coordination fallback")
    }
  } else if (adapterType === "codex_local") {
    score += 18
    reasons.push("Codex remains the general default")
  }

  if (taskLooksLikeUi(task) && adapterType === "gemini_local") {
    score += 16
    reasons.push("task carries frontend/UI hints")
  }

  if (taskNeedsLargeContextPlanning(task) && adapterType === "azure_foundry") {
    score += 18
    reasons.push("task needs larger-context planning or synthesis")
  }

  if (taskLooksReviewOnly(task) && adapterType === "azure_foundry") {
    score += 10
    reasons.push("task is low-cost text work that fits Foundry")
  }

  if (!hasAvailableAgent) {
    score -= 800
    reasons.push(`no active ${adapterType} agent available`)
  }

  if (health && !health.ok) {
    score -= isHealthQuotaBlocked(health) ? 1_200 : 1_000
    reasons.push(`${adapterType} unavailable: ${health.message}`)
  }

  return {
    adapterType,
    score,
    ladderRank,
    available: hasAvailableAgent,
    healthOk: health?.ok ?? true,
    reasons,
    healthMessage: health?.message ?? null
  }
}

export function routeTask(input: {
  task: Task
  rules: RoutingRule[]
  agents: Agent[]
  healthByAdapter: Record<string, AdapterHealthcheckResult>
}): RouteDecision {
  const { agents, healthByAdapter, rules, task } = input
  const pinnedAgent = task.assignedAgentId
    ? (agents.find((candidate) => candidate.id === task.assignedAgentId) ?? null)
    : null
  const assignedAgent =
    pinnedAgent && (!task.requestedAdapterType || pinnedAgent.adapterType === task.requestedAdapterType)
      ? pinnedAgent
      : null
  const matchedRule = preferredRule(task, rules)
  const classified = classifyTaskShape(task)
  const risk = assessTaskRisk(task, classified.shape)
  const fallbackLadder = assignedAgent ? [assignedAgent.adapterType] : ROUTE_LADDERS[classified.shape]

  const scorecard = (["codex_local", "gemini_local", "azure_foundry"] as const)
    .map((adapterType) =>
      scoreAdapterCandidate({
        adapterType,
        task,
        shape: classified.shape,
        fallbackLadder,
        preferredRule: matchedRule,
        health: healthByAdapter[adapterType] ?? null,
        hasAvailableAgent: assignedAgent
          ? assignedAgent.adapterType === adapterType && isAgentActive(assignedAgent)
          : activeAgentsForAdapter(agents, adapterType).length > 0
      })
    )
    .sort((left, right) => {
      const scoreDelta = right.score - left.score
      if (scoreDelta !== 0) return scoreDelta
      return left.ladderRank - right.ladderRank
    })

  const selectedEntry = scorecard.find((entry) => entry.available && entry.healthOk) ??
    scorecard.find((entry) => entry.available) ??
    scorecard[0] ?? {
      adapterType: "codex_local" as const,
      score: 0,
      ladderRank: 0,
      available: false,
      healthOk: false,
      reasons: ["no adapter candidates were available"],
      healthMessage: null
    }

  const adapterType = assignedAgent?.adapterType ?? selectedEntry.adapterType
  const agentSelection = assignedAgent
    ? {
        agent: isAgentActive(assignedAgent) ? assignedAgent : null,
        reason: `task is pinned to assigned agent ${assignedAgent.name}`,
        candidates: [
          {
            agentId: assignedAgent.id,
            agentName: assignedAgent.name,
            adapterType: assignedAgent.adapterType,
            model: assignedAgent.model,
            modelFamily: normalizedModelFamily(assignedAgent),
            score: 1_000,
            estimatedCostUsd: estimateRouteCost({
              task,
              shape: classified.shape,
              risk,
              model: assignedAgent.model,
              modelFamily: normalizedModelFamily(assignedAgent),
              reasoningEffort: targetModelFamily({
                adapterType: assignedAgent.adapterType,
                shape: classified.shape,
                risk,
                task
              }).reasoningEffort
            }).estimatedUsd,
            reasons: ["task is pinned to the assigned agent"]
          }
        ] satisfies AgentSelectionCandidate[]
      }
    : selectBestAgentForTask(task, agents, adapterType)

  const selectionReasons = [
    ...classified.reasons,
    ...selectedEntry.reasons.slice(0, 4),
    ...(agentSelection.reason ? [`selected model reason: ${agentSelection.reason}`] : [])
  ]
  const modelPolicy = targetModelFamily({ adapterType, shape: classified.shape, risk, task })
  const selectedFamily = agentSelection.agent
    ? normalizedModelFamily({ ...agentSelection.agent, model: modelPolicy.model ?? agentSelection.agent.model })
    : modelPolicy.family
  const costEstimate = estimateRouteCost({
    task,
    shape: classified.shape,
    risk,
    model: modelPolicy.model ?? agentSelection.agent?.model ?? null,
    modelFamily: selectedFamily,
    reasoningEffort: modelPolicy.reasoningEffort
  })

  const reason = task.requestedAdapterType
    ? `${task.requestedAdapterType} requested; selected ${adapterType} after capability and health scoring`
    : matchedRule && matchedRule.targetAdapterType === adapterType
      ? `matched routing rule ${matchedRule.name}`
      : (selectionReasons[0] ?? `selected ${adapterType}`)

  return {
    adapterType,
    reason,
    rule: matchedRule,
    agent: agentSelection.agent,
    selectedModel: modelPolicy.model ?? agentSelection.agent?.model ?? null,
    reasoningEffort: modelPolicy.reasoningEffort,
    modelFamily: modelPolicy.family,
    modelRoutingReason: modelPolicy.reason,
    risk,
    taskShape: classified.shape,
    fallbackLadder,
    selectionReasons,
    scorecard,
    agentSelection,
    costEstimate
  }
}
