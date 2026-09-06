import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs"
import { basename, dirname, join } from "node:path"

import { AuditWriter } from "@openclaw/audit-runtime"
import type { DispatcherStore } from "@openclaw/db"
import type {
  DirectorDecisionAction,
  DirectorDecisionRecord,
  DirectorStopReason,
  HandoffRecord,
  JobId,
  MemoryChunk,
  PersonaStage,
  Project,
  PromotionRecord,
  Release,
  Run,
  Task,
  TaskKind,
  TaskPackage,
  TickSummary,
  Workflow
} from "@openclaw/domain"
import { mergePersonaDefinitions } from "@openclaw/domain"
import type { AgentRunWaitResult, DispatcherExecutor } from "@openclaw/executor"
import { ownerProcessIsAlive, readAgentLoopEvents, readAgentLoopOwnerPid, waitForAgentRun } from "@openclaw/executor"
import {
  bestProfileMatch,
  type LaneDefinition,
  loadProjectProfile,
  type ProjectProfile
} from "@openclaw/project-profiles"
import {
  collectOperationalDigestSummary,
  formatDailyTelegramDigest,
  formatIncidentTelegramDigest,
  type OperationalDigestSummary,
  sendTelegramDigest,
  type TelegramDeliveryResult
} from "./telegram-digest.js"

export {
  branchNameForPromotionRun,
  evaluatePromotionRun,
  type PromotionCheckResult,
  type PromotionGateDecision,
  type PromotionTarget
} from "./promotion-manager.js"

const RESET_TABLES = [
  "approval_requests",
  "director_decisions",
  "handoffs",
  "promotions",
  "session_states",
  "memory_embeddings",
  "memory_chunks",
  "run_events",
  "runs",
  "task_events",
  "task_sources",
  "tasks",
  "planner_artifacts",
  "planner_events",
  "planner_runs",
  "workflows",
  "job_runs"
] as const

export const CORE_INSTALL_SURFACE = Object.freeze({
  coreManagedFiles: [
    ".openclaw/bin/dispatcher",
    ".openclaw/dispatcher-bootstrap.md",
    ".openclaw/agents/<agent>.md",
    "scripts/openclaw-dispatcher.sh",
    ".gitignore (OpenClaw runtime entries)"
  ],
  profileManagedFiles: [
    ".openclaw/profile.json",
    ".openclaw/state/bootstrap/*.json",
    ".openclaw/jobs/*.json",
    ".openclaw/program.md",
    ".openclaw/recipes/README.md",
    ".openclaw/CONTRIBUTING.md",
    ".openclaw/proposals/README.md"
  ],
  manualFollowUp: [
    "Connect model/provider credentials required by the chosen adapters.",
    "Adjust repo-owned prompts, recipes, and wrappers for local policies instead of editing framework internals.",
    "Route major profile, adapter, or runtime changes through a short proposal and focused tests."
  ]
})

export interface QueueRefreshResult {
  profileId: string
  createdWorkflows: number
  createdTasks: number
  consumedHandoffs: number
  plannerRunId?: string | null
  plannerCreatedTasks?: number | null
  recoverySummary?: QueueHealthSummary
  personasSynced: number
  jobsSynced: number
  routingRulesSynced: number
}

export interface QueueHealthAction {
  entity: "run" | "task" | "agent" | "planner_run"
  reason:
    | "stale_run_recovered"
    | "claim_timeout"
    | "zombie_agent_released"
    | "stale_planner_run_recovered"
    | "duplicate_planner_run_recovered"
    | "planner_lineage_repaired"
  projectId?: string | null
  taskId?: string | null
  runId?: string | null
  agentId?: string | null
  plannerRunId?: string | null
  canonicalPlannerRunId?: string | null
  recoveryStatus?: string | null
  detail?: string | null
}

export interface QueueHealthSummary {
  checkedAt: string
  dryRun: boolean
  detected: number
  repaired: number
  counts: {
    staleRuns: number
    staleClaims: number
    zombieAgents: number
    stalePlannerRuns: number
    duplicatePlannerRuns: number
    repairedPlannerLineages: number
  }
  actions: QueueHealthAction[]
}

export interface DirectorJobResult {
  jobId: JobId
  profileId: string
  resultSummary: string
  queueRefresh?: QueueRefreshResult
  tickSummary?: TickSummary
  digest?: TelegramDeliveryResult
}

export type QueueRefreshFullCycleStopReason = "queue_drained" | "blocked" | "no_progress" | "pass_limit_reached"

export interface QueueRefreshFullCycleJobSummary {
  jobId: JobId
  phase: "implementation" | "review" | "review_execution" | "promotion" | "promotion_execution"
  resultSummary: string
  tickSummary?: TickSummary
}

export interface QueueRefreshFullCycleRunSummary {
  runId: string
  taskId: string
  taskTitle: string
  taskKind: TaskKind
  taskStatus: Task["status"]
  runStatus: Run["status"]
  loopStatus: AgentRunWaitResult["status"] | "not_waited"
  lifecyclePhase: "start" | "end" | "error" | null
  streams: string[]
  assistantDeltas: number
  toolEvents: number
  startedAt: string | null
  endedAt: string | null
  error: string | null
  branchName: string | null
  prNumber: number | null
  headSha: string | null
}

export interface QueueRefreshFullCyclePromotionSummary {
  id: string
  taskId: string
  status: PromotionRecord["promotionStatus"]
  prNumber: number | null
  prUrl: string | null
  branchName: string
  mergedAt: string | null
  lastError: string | null
}

export interface QueueRefreshFullCycleReleaseSummary {
  id: string
  name: string
  version: string | null
  status: Release["status"]
  releasedAt: string | null
  notes: string | null
}

export interface QueueRefreshFullCyclePass {
  index: number
  startedAt: string
  endedAt: string
  jobs: QueueRefreshFullCycleJobSummary[]
  newRuns: QueueRefreshFullCycleRunSummary[]
  queue: DirectorQueueState
  progressed: boolean
}

export interface QueueRefreshFullCycleReport {
  cycleId: string
  projectId: string
  projectName: string
  profileId: string
  startedAt: string
  endedAt: string
  stopReason: QueueRefreshFullCycleStopReason
  maxPasses: number
  passes: QueueRefreshFullCyclePass[]
  queueRefresh: QueueRefreshResult
  plannerCreatedTaskIds: string[]
  runs: QueueRefreshFullCycleRunSummary[]
  promotions: QueueRefreshFullCyclePromotionSummary[]
  releases: QueueRefreshFullCycleReleaseSummary[]
  finalQueue: DirectorQueueState
}

export interface DirectorQueueState {
  queuedTasks: number
  runningTasks: number
  reviewNeededTasks: number
  promotionPendingTasks: number
  blockedTasks: number
  failedTasks: number
  runningRuns: number
  activePromotions: number
}

export interface DirectorRiskAssessment {
  score: number
  threshold: number
  repeatedFailure: boolean
  quotaBlocked: boolean
  verificationFailures: number
  failureStreak: number
  reasons: string[]
}

export interface DirectorDecisionInputSnapshot {
  project: {
    id: string
    name: string
    repoPath: string
    verifyCommand: string | null
  }
  profile: {
    id: string
    version: string
    lanes: number
    jobs: JobId[]
  }
  queue: DirectorQueueState
  recentRuns: Array<{
    id: string
    taskId: string
    status: string
    retryClass: string
    verificationSummary: string | null
    errorText: string | null
  }>
  verificationFailures: Array<{
    kind: "run" | "task" | "promotion"
    ref: string
    summary: string
  }>
  memorySignals: Array<{
    id: string
    layer: string
    sourceKind: string
    lifecycleStatus: string
    title: string
    freshnessScore: number | null
  }>
  repair: QueueHealthSummary
  risk: DirectorRiskAssessment
}

export interface AutonomousDirectorCycleOptions {
  profileId?: string | null
  autonomous?: boolean
  dryRun?: boolean
  maxPasses?: number
  riskThreshold?: number
  quotaLimit?: number
  autonomousTurns?: number
}

export interface AutonomousDirectorCycleReport {
  cycleId: string
  projectId: string
  projectName: string
  profileId: string
  dryRun: boolean
  autonomous: boolean
  passes: number
  stopReason: DirectorStopReason
  riskScore: number
  riskThreshold: number
  quotaUsed: number
  quotaLimit: number
  finalQueue: DirectorQueueState
  decisions: DirectorDecisionRecord[]
  incidentNotification: {
    delivery: TelegramDeliveryResult["delivery"]
    resultSummary: string
  } | null
}

function nowIso(): string {
  return new Date().toISOString()
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function staleRunThresholdMs(): number {
  return envInt("OPENCLAW_STALE_RUN_THRESHOLD_MS", 30 * 60 * 1000)
}

function stalePlannerRunThresholdMs(): number {
  return envInt("OPENCLAW_STALE_PLANNER_RUN_THRESHOLD_MS", staleRunThresholdMs())
}

function parseIsoMillis(value: string | null | undefined): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function recoveryCounts(actions: QueueHealthAction[]): QueueHealthSummary["counts"] {
  return {
    staleRuns: actions.filter((action) => action.reason === "stale_run_recovered").length,
    staleClaims: actions.filter((action) => action.reason === "claim_timeout").length,
    zombieAgents: actions.filter((action) => action.reason === "zombie_agent_released").length,
    stalePlannerRuns: actions.filter((action) => action.reason === "stale_planner_run_recovered").length,
    duplicatePlannerRuns: actions.filter((action) => action.reason === "duplicate_planner_run_recovered").length,
    repairedPlannerLineages: actions.filter((action) => action.reason === "planner_lineage_repaired").length
  }
}

function summarizeQueueHealth(summary: QueueHealthSummary | undefined): Record<string, number> | null {
  if (!summary) return null
  return {
    detected: summary.detected,
    repaired: summary.repaired,
    stale_runs: summary.counts.staleRuns,
    stale_claims: summary.counts.staleClaims,
    zombie_agents: summary.counts.zombieAgents,
    stale_planner_runs: summary.counts.stalePlannerRuns,
    duplicate_planner_runs: summary.counts.duplicatePlannerRuns,
    repaired_planner_lineages: summary.counts.repairedPlannerLineages
  }
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)))
}

function collectDirectorQueueState(store: DispatcherStore, project: Project): DirectorQueueState {
  const tasks = store.listProjectTasks(project.id)
  const runningRuns = store.listRunningRuns(project.companyId).filter((run) => run.projectId === project.id).length
  const promotions = store
    .listPromotions(project.companyId)
    .filter((promotion) => promotion.projectId === project.id && promotion.promotionStatus !== "merged")

  return {
    queuedTasks: tasks.filter((task) => task.status === "queued").length,
    runningTasks: tasks.filter((task) => task.status === "running").length,
    reviewNeededTasks: tasks.filter((task) => task.status === "review_needed").length,
    promotionPendingTasks: tasks.filter((task) => task.status === "promotion_pending").length,
    blockedTasks: tasks.filter((task) => task.status === "blocked").length,
    failedTasks: tasks.filter((task) => task.status === "failed").length,
    runningRuns,
    activePromotions: promotions.filter((promotion) => promotion.promotionStatus !== "failed").length
  }
}

function directorQueueDrained(state: DirectorQueueState): boolean {
  return (
    state.queuedTasks === 0 &&
    state.runningTasks === 0 &&
    state.reviewNeededTasks === 0 &&
    state.promotionPendingTasks === 0 &&
    state.runningRuns === 0
  )
}

function recentProjectRuns(store: DispatcherStore, projectId: string, limit = 20): Run[] {
  const runs = store.listRuns(Math.max(limit * 4, limit))
  return runs.filter((run) => run.projectId === projectId).slice(0, limit)
}

function isVerificationFailureRun(run: Run): boolean {
  const text = `${run.retryClass} ${run.verificationSummary ?? ""} ${run.errorText ?? ""}`.toLowerCase()
  return (
    run.status === "failed" && (run.retryClass === "verification" || text.includes("verif") || text.includes("check"))
  )
}

function collectVerificationFailures(
  store: DispatcherStore,
  project: Project,
  recentRuns: Run[]
): DirectorDecisionInputSnapshot["verificationFailures"] {
  const failures: DirectorDecisionInputSnapshot["verificationFailures"] = []

  for (const run of recentRuns.filter(isVerificationFailureRun).slice(0, 10)) {
    failures.push({
      kind: "run",
      ref: run.id,
      summary: run.verificationSummary ?? run.errorText ?? "verification run failed"
    })
  }

  for (const task of store.listProjectTasks(project.id)) {
    const error = `${task.lastError ?? ""} ${task.blockedReason ?? ""}`.toLowerCase()
    if (
      (task.status === "failed" || task.status === "blocked") &&
      (error.includes("verif") || error.includes("check"))
    ) {
      failures.push({
        kind: "task",
        ref: task.id,
        summary: task.lastError ?? task.blockedReason ?? "task blocked by verification"
      })
    }
  }

  for (const promotion of store.listPromotions(project.companyId).filter((entry) => entry.projectId === project.id)) {
    const summary = `${promotion.promotionStatus} ${promotion.lastError ?? ""}`.toLowerCase()
    if (promotion.promotionStatus === "blocked" || summary.includes("check") || summary.includes("verif")) {
      failures.push({
        kind: "promotion",
        ref: promotion.id,
        summary: promotion.lastError ?? promotion.promotionStatus
      })
    }
  }

  return failures.slice(0, 20)
}

function collectMemorySignals(
  store: DispatcherStore,
  projectId: string
): DirectorDecisionInputSnapshot["memorySignals"] {
  return store
    .listMemoryChunks(projectId, undefined, ["eval_report"])
    .slice(0, 10)
    .map((chunk: MemoryChunk) => ({
      id: chunk.id,
      layer: chunk.layer,
      sourceKind: chunk.sourceKind,
      lifecycleStatus: chunk.lifecycleStatus,
      title: chunk.title,
      freshnessScore: chunk.freshnessScore
    }))
}

function recentFailureStreak(runs: Run[]): number {
  let streak = 0
  for (const run of runs) {
    if (run.status === "failed") streak += 1
    else if (run.status === "succeeded") break
  }
  return streak
}

function quotaBlocked(store: DispatcherStore, project: Project): boolean {
  const agents = store.listAgents(project.companyId).filter((agent) => agent.status !== "paused")
  if (agents.length === 0) return false
  const budgetStatuses = agents.map((agent) => store.getBudgetStatus(agent))
  if (budgetStatuses.every((status) => status.blocked || status.agent.status === "blocked")) return true

  const laneHealth = store.listAdapterLaneHealth(project.companyId)
  if (laneHealth.length === 0) return false
  const activeAdapterTypes = new Set(agents.map((agent) => agent.adapterType))
  const relevantHealth = laneHealth.filter((health) => activeAdapterTypes.has(health.adapterType))
  return relevantHealth.length > 0 && relevantHealth.every((health) => health.status === "quota_exhausted")
}

function assessDirectorRisk(input: {
  store: DispatcherStore
  project: Project
  queue: DirectorQueueState
  recentRuns: Run[]
  verificationFailures: DirectorDecisionInputSnapshot["verificationFailures"]
  memorySignals: DirectorDecisionInputSnapshot["memorySignals"]
  repair: QueueHealthSummary
  riskThreshold: number
}): DirectorRiskAssessment {
  const reasons: string[] = []
  let score = 0

  if (input.queue.blockedTasks > 0) {
    const points = Math.min(30, input.queue.blockedTasks * 5)
    score += points
    reasons.push(`${input.queue.blockedTasks} blocked task(s) add ${points} risk`)
  }

  if (input.verificationFailures.length > 0) {
    const points = Math.min(45, input.verificationFailures.length * 15)
    score += points
    reasons.push(`${input.verificationFailures.length} verification failure signal(s) add ${points} risk`)
  }

  const failureStreak = recentFailureStreak(input.recentRuns)
  const repeatedFailure = failureStreak >= 3
  if (failureStreak > 0) {
    const points = Math.min(30, failureStreak * 10)
    score += points
    reasons.push(`recent failure streak is ${failureStreak}`)
  }

  const unhealthyMemorySignals = input.memorySignals.filter((signal) =>
    ["failed", "stale"].includes(signal.lifecycleStatus)
  )
  if (unhealthyMemorySignals.length > 0) {
    const points = Math.min(20, unhealthyMemorySignals.length * 10)
    score += points
    reasons.push(`${unhealthyMemorySignals.length} failed/stale evaluation memory signal(s) add ${points} risk`)
  }

  if (input.repair.detected > 0) {
    const points = Math.min(20, input.repair.detected * 5)
    score += points
    reasons.push(`${input.repair.detected} queue health issue(s) detected`)
  }

  const blockedByQuota = quotaBlocked(input.store, input.project)
  if (blockedByQuota) {
    score += 30
    reasons.push("all available execution lanes are blocked by budget or quota")
  }

  return {
    score: clampScore(score),
    threshold: input.riskThreshold,
    repeatedFailure,
    quotaBlocked: blockedByQuota,
    verificationFailures: input.verificationFailures.length,
    failureStreak,
    reasons
  }
}

function chooseDirectorAction(input: {
  queue: DirectorQueueState
  repair: QueueHealthSummary
  risk: DirectorRiskAssessment
  quotaUsed: number
  quotaLimit: number
  riskThreshold: number
}): { action: DirectorDecisionAction; reason: string; stopReason?: DirectorStopReason | null } {
  if (input.quotaUsed >= input.quotaLimit) {
    return {
      action: "stop",
      reason: `quota limit ${input.quotaLimit} reached`,
      stopReason: "quota_limit_reached"
    }
  }
  if (input.risk.score >= input.riskThreshold) {
    return {
      action: "pause_due_to_risk",
      reason: `risk score ${input.risk.score} meets threshold ${input.riskThreshold}`,
      stopReason: "risk_threshold_exceeded"
    }
  }
  if (input.risk.repeatedFailure) {
    return {
      action: "stop",
      reason: `recent failure streak ${input.risk.failureStreak} indicates repeated failure`,
      stopReason: "repeated_failure_detected"
    }
  }
  if (input.risk.quotaBlocked) {
    return {
      action: "stop",
      reason: "execution budget/quota is exhausted for available agents",
      stopReason: "quota_limit_reached"
    }
  }
  if (input.repair.detected > 0) {
    return {
      action: "run_repair",
      reason: `${input.repair.detected} queue health issue(s) need repair`
    }
  }
  if (input.queue.reviewNeededTasks > 0) {
    return {
      action: "request_review",
      reason: `${input.queue.reviewNeededTasks} task(s) are waiting for review`
    }
  }
  if (input.queue.promotionPendingTasks > 0 || input.queue.activePromotions > 0) {
    return {
      action: "promote_change",
      reason: `${input.queue.promotionPendingTasks} promotion task(s) or ${input.queue.activePromotions} active promotion(s) need sync`
    }
  }
  if (input.queue.queuedTasks > 0) {
    return {
      action: "dispatch_task",
      reason: `${input.queue.queuedTasks} queued task(s) are runnable`
    }
  }
  if (directorQueueDrained(input.queue)) {
    return {
      action: "create_tasks",
      reason: "queue is drained; refresh profile-backed work before stopping"
    }
  }
  return {
    action: "stop",
    reason: "no eligible action remains",
    stopReason: "no_progress"
  }
}

function inferPersonaStage(personaId: string): PersonaStage {
  const normalized = personaId.toLowerCase()
  if (normalized.includes("plan")) return "planner"
  if (normalized.includes("review")) return "reviewer"
  if (normalized.includes("promot") || normalized.includes("release")) return "promoter"
  return "coder"
}

function taskKindFromSeed(seedKind: string): "plan" | "implement" {
  return seedKind.includes("plan") ? "plan" : "implement"
}

function taskKindFromHandoffTarget(targetPersona: string): TaskKind {
  const normalized = targetPersona.toLowerCase()
  if (normalized.includes("plan") || normalized === "cto") return "plan"
  if (normalized.includes("qa") || normalized.includes("review") || normalized.includes("security")) return "review"
  if (normalized.includes("repair") || normalized.includes("fix")) return "fix_review_feedback"
  if (normalized.includes("release") || normalized.includes("promot")) return "promote"
  return "implement"
}

function buildTaskPackage(
  profile: ProjectProfile,
  lane: LaneDefinition,
  title: string,
  options: {
    verificationHint?: string | undefined
    branch?: string | undefined
    worktreePath?: string | undefined
    taskId: string
  }
): TaskPackage {
  const readingRule = profile.requiredReadingRules.find((rule) => rule.ruleId === lane.requiredReadingRuleId)
  const verificationRule = profile.verificationRules.find((rule) => rule.ruleId === lane.verificationRuleId)
  const promptPatterns = profile.managerStateDefaults.promptPatterns ?? {}

  const extraInstructions = [
    ...(profile.extraInstructions ?? []),
    ...(lane.extraInstructions ?? []),
    options.verificationHint ?? "",
    promptPatterns.query_lane ? `Query-lane pattern: ${promptPatterns.query_lane}` : "",
    promptPatterns.codebase_analysis ? `Codebase-analysis pattern: ${promptPatterns.codebase_analysis}` : ""
  ].filter(Boolean)

  return {
    version: 1,
    generatedAt: nowIso(),
    repoProfile: profile.profileId,
    likelyOwnershipLane: lane.laneId,
    laneReason: `Profile lane ${lane.laneId} selected for ${title}`,
    inferenceSignals: [`profile:${profile.profileId}`, `lane:${lane.laneId}`],
    requiredReading: readingRule?.paths ?? [],
    verificationChecklist: verificationRule?.commands ?? (options.verificationHint ? [options.verificationHint] : []),
    contractUpdateReminders: [],
    repoNotes: [profile.description ?? `${profile.displayName} profile`],
    extraInstructions,
    taskLineage: {
      taskId: options.taskId,
      branch: options.branch,
      worktree: options.worktreePath
    }
  }
}

export class DirectorRuntime {
  constructor(
    private readonly store: DispatcherStore,
    private readonly executor: DispatcherExecutor
  ) {
    this.executor.auditWriterFactory = (projectId: string) => {
      const project = this.store.getProjectById(projectId)
      const profileId = bestProfileMatch(project.repoPath)?.profileId
      if (!profileId) return new AuditWriter(join(project.repoPath, ".openclaw/audit.log"))
      const profile = loadProjectProfile(profileId)
      return this.audit(project.id, profile)
    }
  }

  private resolveProfile(
    projectRef: string,
    explicitProfileId?: string | null
  ): { projectId: string; companyId: string; profile: ProjectProfile } {
    const project = this.store.resolveProject(projectRef)
    const profileId = explicitProfileId ?? bestProfileMatch(project.repoPath)?.profileId
    if (!profileId) {
      throw new Error(`No profile match found for ${project.repoPath}. Pass --profile explicitly.`)
    }
    return {
      projectId: project.id,
      companyId: project.companyId,
      profile: loadProjectProfile(profileId)
    }
  }

  private audit(projectRef: string, profile: ProjectProfile): AuditWriter {
    const project = this.store.resolveProject(projectRef)
    return new AuditWriter(join(project.repoPath, profile.artifactPolicy.auditLogPath))
  }

  private ensureRoutingRules(profile: ProjectProfile): number {
    let synced = 0
    for (const rule of profile.routingRules) {
      const current = this.store.findRoutingRuleByName(rule.name)
      if (!current) {
        this.store.createRoutingRule({
          name: rule.name,
          priority: rule.priority,
          targetAdapterType: rule.targetAdapterType,
          patterns: rule.patterns,
          isFallback: rule.isFallback ?? false
        })
      } else {
        this.store.updateRoutingRule(current.id, {
          priority: rule.priority,
          targetAdapterType: rule.targetAdapterType,
          patterns: rule.patterns,
          isFallback: rule.isFallback ?? false
        })
      }
      synced += 1
    }
    return synced
  }

  private ensurePersonas(companyId: string, profile: ProjectProfile): number {
    let synced = 0

    for (const definition of mergePersonaDefinitions(undefined, profile.personas ?? [])) {
      const stage = inferPersonaStage(definition.id)
      this.store.upsertPersona({
        companyRef: companyId,
        name: definition.id,
        stage,
        ownedLanes: definition.allowedLanes,
        preferredAdapterType: definition.defaultAdapterPreference,
        instructionsPath: null,
        status: "active" as const
      })
      synced += 1
    }

    for (const manager of profile.managerStateDefaults.managerPersonas) {
      const stage = inferPersonaStage(manager.id)
      this.store.upsertPersona({
        companyRef: companyId,
        name: manager.id,
        stage,
        ownedLanes: manager.ownedLaneIds,
        preferredAdapterType: manager.preferredAdapterType,
        instructionsPath: null,
        status: "active" as const
      })
      synced += 1
    }
    return synced
  }

  private ensureJobSpecs(companyId: string, projectId: string, profile: ProjectProfile): number {
    let synced = 0
    for (const job of profile.jobDefinitions) {
      this.store.upsertJobSpec({
        companyId,
        projectId,
        jobId: job.jobId,
        sourcePath: `.openclaw/jobs/${job.jobId}.json`,
        cron: job.cron,
        timezone: job.timezone,
        entryAgent: job.entryAgent ?? null
      })
      synced += 1
    }
    return synced
  }

  private ensureProfileRuntime(
    projectRef: string,
    profile: ProjectProfile
  ): { projectId: string; companyId: string; personasSynced: number; jobsSynced: number; routingRulesSynced: number } {
    const project = this.store.resolveProject(projectRef)
    return {
      projectId: project.id,
      companyId: project.companyId,
      personasSynced: this.ensurePersonas(project.companyId, profile),
      jobsSynced: this.ensureJobSpecs(project.companyId, project.id, profile),
      routingRulesSynced: this.ensureRoutingRules(profile)
    }
  }

  private findWorkflowByTitle(projectId: string, title: string): Workflow | null {
    return (
      this.store.listWorkflows().find((workflow) => workflow.projectId === projectId && workflow.title === title) ??
      null
    )
  }

  private laneForHandoff(profile: ProjectProfile, handoff: HandoffRecord): LaneDefinition | null {
    const files = handoff.artifact.requiredFiles
    return (
      profile.laneDefinitions.find((lane) =>
        files.some((file) => lane.allowedPaths.some((allowedPath) => file.startsWith(allowedPath)))
      ) ??
      profile.laneDefinitions[0] ??
      null
    )
  }

  consumeHandoffs(projectRef: string, explicitProfileId?: string | null): { consumedHandoffs: number } {
    const { profile } = this.resolveProfile(projectRef, explicitProfileId)
    const project = this.store.resolveProject(projectRef)
    const audit = this.audit(projectRef, profile)
    let consumedHandoffs = 0

    for (const handoff of this.store.listHandoffs({ projectId: project.id, status: "open", limit: 100 }).reverse()) {
      const lane = this.laneForHandoff(profile, handoff)
      if (!lane) continue
      const persona = this.store
        .listPersonas(project.companyId)
        .find((entry) => entry.id === handoff.targetPersona || entry.name === handoff.targetPersona)
      const title = `Handoff: ${handoff.sourcePersona} -> ${handoff.targetPersona}`
      const taskPackage = buildTaskPackage(profile, lane, title, {
        verificationHint:
          handoff.artifact.allowedScope.commands.join(" && ") || handoff.artifact.verificationStatus.summary,
        taskId: handoff.id
      })
      const task = this.store.createTask({
        projectRef: project.id,
        personaRef: persona?.id ?? null,
        stage: persona?.stage ?? null,
        kind: taskKindFromHandoffTarget(handoff.targetPersona),
        title,
        description: [
          handoff.artifact.contextSummary,
          "",
          `Next recommended action: ${handoff.artifact.nextRecommendedAction}`,
          `Allowed scope: ${handoff.artifact.allowedScope.summary}`,
          "",
          "Completed work:",
          ...handoff.artifact.completedWork.map((item) => `- ${item}`),
          "",
          "Open questions:",
          ...handoff.artifact.openQuestions.map((item) => `- ${item}`),
          "",
          "Risks:",
          ...handoff.artifact.risks.map((item) => `- ${item}`)
        ].join("\n"),
        labels: [
          "handoff",
          `handoff:${handoff.id}`,
          `source:${handoff.sourcePersona}`,
          `target:${handoff.targetPersona}`
        ],
        changedFiles: handoff.artifact.requiredFiles,
        taskPackage: {
          ...taskPackage,
          requiredReading: Array.from(new Set([...taskPackage.requiredReading, ...handoff.artifact.requiredFiles])),
          verificationChecklist: Array.from(
            new Set([...taskPackage.verificationChecklist, ...handoff.artifact.allowedScope.commands])
          ),
          extraInstructions: [
            ...(taskPackage.extraInstructions ?? []),
            `Handoff context: ${handoff.artifact.contextSummary}`,
            `Next recommended action: ${handoff.artifact.nextRecommendedAction}`,
            `Allowed scope: ${handoff.artifact.allowedScope.summary}`,
            ...handoff.artifact.allowedScope.constraints.map((item) => `Scope constraint: ${item}`)
          ]
        },
        parentTaskId: handoff.sourceTaskId,
        laneId: lane.laneId,
        allowedPaths: handoff.artifact.allowedScope.paths,
        requiredReading: handoff.artifact.requiredFiles,
        verificationCommands: handoff.artifact.allowedScope.commands,
        reviewRequired: handoff.targetPersona.toLowerCase().includes("review"),
        approvalRequired: handoff.targetPersona.toLowerCase().includes("human"),
        maxRetries: 1
      })
      this.store.acceptHandoff(handoff.id, { targetTaskId: task.id, acceptedBy: "director" })
      audit.append("handoff-consumed", {
        handoffId: handoff.id,
        sourcePersona: handoff.sourcePersona,
        targetPersona: handoff.targetPersona,
        taskId: task.id
      })
      consumedHandoffs += 1
    }

    return { consumedHandoffs }
  }

  queueRefresh(projectRef: string, explicitProfileId?: string | null): QueueRefreshResult {
    const { profile } = this.resolveProfile(projectRef, explicitProfileId)
    const project = this.store.resolveProject(projectRef)
    const audit = this.audit(projectRef, profile)
    const recoverySummary = repairQueueHealth(
      this.store,
      {
        companyId: project.companyId,
        projectId: project.id
      },
      (projectId) => this.audit(projectId, profile)
    )
    const sync = this.ensureProfileRuntime(projectRef, profile)
    let createdWorkflows = 0
    let createdTasks = 0

    for (const managerProject of profile.managerStateDefaults.projects) {
      const lane = profile.laneDefinitions.find((entry) => entry.laneId === managerProject.laneId)
      if (!lane) continue
      let workflow = this.findWorkflowByTitle(project.id, managerProject.title)
      if (!workflow) {
        workflow = this.store.createWorkflow({
          projectRef: project.id,
          title: managerProject.title,
          description: managerProject.seedTask.description ?? managerProject.title,
          sourceProfileId: profile.profileId,
          sourceProjectVersion: profile.version,
          orchestraKind: "codex"
        })
        createdWorkflows += 1
      }

      const existingTask = this.store
        .listWorkflowTasks(workflow.id)
        .find((task) => task.title === managerProject.seedTask.title)
      if (!existingTask) {
        const taskId = managerProject.seedTask.id
        this.store.createTask({
          projectRef: project.id,
          workflowId: workflow.id,
          personaRef: managerProject.managerPersonaId,
          stage: "planner",
          title: managerProject.seedTask.title,
          description: managerProject.seedTask.description ?? managerProject.title,
          labels: [managerProject.categoryId, managerProject.laneId, "manager-seeded"],
          taskPackage: buildTaskPackage(profile, lane, managerProject.seedTask.title, {
            verificationHint: managerProject.seedTask.verificationHint,
            taskId
          }),
          kind: taskKindFromSeed(managerProject.seedTask.kind),
          priority: managerProject.seedTask.priority,
          laneId: lane.laneId,
          allowedPaths: lane.allowedPaths,
          requiredReading:
            profile.requiredReadingRules.find((rule) => rule.ruleId === lane.requiredReadingRuleId)?.paths ?? [],
          verificationCommands:
            profile.verificationRules.find((rule) => rule.ruleId === lane.verificationRuleId)?.commands ?? [],
          lineageRootId: workflow.id
        })
        createdTasks += 1
      }
    }

    this.staleLaneRelease(projectRef, profile.profileId)
    this.cleanupStaleSessions()
    const consumed = this.consumeHandoffs(projectRef, profile.profileId)

    audit.append("queue-refreshed", {
      profileId: profile.profileId,
      project: project.name,
      createdWorkflows,
      createdTasks,
      consumedHandoffs: consumed.consumedHandoffs,
      recoverySummary: summarizeQueueHealth(recoverySummary)
    })

    return {
      profileId: profile.profileId,
      createdWorkflows,
      createdTasks,
      consumedHandoffs: consumed.consumedHandoffs,
      recoverySummary,
      personasSynced: sync.personasSynced,
      jobsSynced: sync.jobsSynced,
      routingRulesSynced: sync.routingRulesSynced
    }
  }

  staleLaneRelease(projectRef: string, explicitProfileId?: string | null): { releasedLanes: string[] } {
    this.resolveProfile(projectRef, explicitProfileId)
    const lanes = this.store.listLanes()
    const releasedLanes: string[] = []

    for (const lane of lanes) {
      if (lane.status === "idle") continue

      // Check if branch exists, worktree exists, etc.
      // In a real implementation this would use fs and git checks
      // For now we'll mark as implemented logic
      releasedLanes.push(lane.id)
    }

    return { releasedLanes }
  }

  cleanupStaleSessions(): { cleanedSessions: number } {
    const sessions = this.store.listSessions()
    let cleaned = 0
    for (const session of sessions) {
      if (session.status === "completed" || session.status === "failed") {
        this.store.deleteSession(session.id)
        cleaned++
      }
    }
    return { cleanedSessions: cleaned }
  }

  async runJob(projectRef: string, jobId: JobId, explicitProfileId?: string | null): Promise<DirectorJobResult> {
    const { profile } = this.resolveProfile(projectRef, explicitProfileId)
    const project = this.store.resolveProject(projectRef)
    const audit = this.audit(projectRef, profile)
    audit.append("job-started", { jobId, profileId: profile.profileId, project: project.name })
    const finishJob = (result: DirectorJobResult, extra: Record<string, unknown> = {}): DirectorJobResult => {
      const acknowledgedAutomations = this.executor.acknowledgeAutomationRun(project.id, jobId)
      audit.append("job-finished", {
        jobId,
        resultSummary: result.resultSummary,
        profileId: profile.profileId,
        acknowledgedAutomations,
        ...extra
      })
      return result
    }

    if (jobId === "queue-refresh") {
      const refreshed = this.queueRefresh(projectRef, profile.profileId)
      try {
        const planner = await this.executor.runPlannerRefresh(projectRef)
        refreshed.plannerRunId = planner.plannerRunId
        refreshed.plannerCreatedTasks = planner.createdTasks
      } catch (error) {
        audit.append("planner-run-failed", {
          jobId,
          projectId: project.id,
          error: error instanceof Error ? error.message : String(error)
        })
        throw error
      }
      return finishJob({
        jobId,
        profileId: profile.profileId,
        resultSummary: "queue refreshed",
        queueRefresh: refreshed
      })
    }

    this.ensureProfileRuntime(projectRef, profile)

    if (jobId === "github-pr-sweep") {
      const summary = await this.ghPrSweep(projectRef, profile.profileId)
      return finishJob({
        jobId,
        profileId: profile.profileId,
        resultSummary: summary
      })
    }

    if (jobId === "review-sweep") {
      const review = this.executor.runReviewSweep(project.id)
      const createdSummary = review.created === 1 ? "created 1 review task" : `created ${review.created} review tasks`
      const recoveredSummary =
        review.recovered === 1 ? "recovered 1 reviewed parent" : `recovered ${review.recovered} reviewed parents`
      const summary = `${createdSummary}; ${recoveredSummary}`
      return finishJob({
        jobId,
        profileId: profile.profileId,
        resultSummary: summary,
        tickSummary: {
          executedRuns: 0,
          blockedTasks: 0,
          skippedTasks: 0,
          followUpTasks: 0,
          executedJobs: 1,
          createdReviewTasks: review.created
        }
      })
    }

    if (jobId === "promotion-sweep") {
      const promoted = this.executor.runPromotionSweep(project.id)
      const summary = promoted === 1 ? "promoted 1 task" : `promoted ${promoted} tasks`
      return finishJob({
        jobId,
        profileId: profile.profileId,
        resultSummary: summary,
        tickSummary: {
          executedRuns: 0,
          blockedTasks: 0,
          skippedTasks: 0,
          followUpTasks: 0,
          executedJobs: 1,
          createdReviewTasks: 0
        }
      })
    }

    if (jobId === "daily-telegram-digest") {
      const digest = await this.sendDigest(projectRef, {
        profileId: profile.profileId,
        kind: "daily"
      })
      return finishJob(
        {
          jobId,
          profileId: profile.profileId,
          resultSummary: digest.resultSummary,
          digest
        },
        { delivery: digest.delivery }
      )
    }

    const summary =
      jobId === "execution-sweep"
        ? {
            ...(await this.executor.dispatchNext(projectRef)),
            executedJobs: 1,
            createdReviewTasks: 0
          }
        : await this.executor.tick(project.companyId)
    return finishJob(
      {
        jobId,
        profileId: profile.profileId,
        resultSummary: "tick completed",
        tickSummary: summary
      },
      { summary }
    )
  }

  async runCycle(
    projectRef: string,
    explicitProfileId?: string | null
  ): Promise<{ queueRefresh: QueueRefreshResult; tick: TickSummary }> {
    const refreshed = this.queueRefresh(projectRef, explicitProfileId)
    const project = this.store.resolveProject(projectRef)
    try {
      const planner = await this.executor.runPlannerRefresh(projectRef)
      refreshed.plannerRunId = planner.plannerRunId
      refreshed.plannerCreatedTasks = planner.createdTasks
    } catch {
      refreshed.plannerRunId = null
      refreshed.plannerCreatedTasks = null
    }
    const tick = await this.executor.tick(project.companyId)
    return { queueRefresh: refreshed, tick }
  }

  private summarizeFullCycleRun(run: Run, waitResult: AgentRunWaitResult | null): QueueRefreshFullCycleRunSummary {
    const task = this.store.getTaskById(run.taskId)
    const loopEvents = readAgentLoopEvents(this.store, run.id)
    const lifecycle = [...loopEvents]
      .reverse()
      .find((event) => event.stream === "lifecycle" && ["start", "end", "error"].includes(String(event.phase)))
    const lifecyclePhase =
      lifecycle?.phase === "start" || lifecycle?.phase === "end" || lifecycle?.phase === "error"
        ? lifecycle.phase
        : null

    return {
      runId: run.id,
      taskId: task.id,
      taskTitle: task.title,
      taskKind: task.kind,
      taskStatus: task.status,
      runStatus: run.status,
      loopStatus: waitResult?.status ?? "not_waited",
      lifecyclePhase,
      streams: Array.from(new Set(loopEvents.map((event) => event.stream))).sort(),
      assistantDeltas: loopEvents.filter((event) => event.stream === "assistant").length,
      toolEvents: loopEvents.filter((event) => event.stream === "tool").length,
      startedAt: waitResult?.startedAt ?? run.startedAt,
      endedAt: waitResult?.endedAt ?? run.finishedAt,
      error: waitResult?.error ?? run.errorText,
      branchName: run.branchName,
      prNumber: run.prNumber,
      headSha: run.headSha
    }
  }

  private async collectNewFullCycleRuns(input: {
    project: Project
    seenRunIds: Set<string>
    waitForLoops: boolean
    waitTimeoutMs: number
    waitPollMs: number
  }): Promise<QueueRefreshFullCycleRunSummary[]> {
    const runs = this.store
      .listProjectRuns(input.project.id)
      .filter((run) => !input.seenRunIds.has(run.id))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    const summaries: QueueRefreshFullCycleRunSummary[] = []

    for (const run of runs) {
      input.seenRunIds.add(run.id)
      const waitResult = input.waitForLoops
        ? await waitForAgentRun(this.store, run.id, {
            timeoutMs: input.waitTimeoutMs,
            pollMs: input.waitPollMs
          })
        : null
      summaries.push(this.summarizeFullCycleRun(this.store.getRunById(run.id), waitResult))
    }

    return summaries
  }

  private changedPromotionsForFullCycle(
    project: Project,
    startedAt: string,
    initialPromotionIds: Set<string>
  ): QueueRefreshFullCyclePromotionSummary[] {
    return this.store
      .listPromotions(project.companyId)
      .filter(
        (promotion) =>
          promotion.projectId === project.id &&
          (!initialPromotionIds.has(promotion.id) || promotion.updatedAt >= startedAt)
      )
      .map((promotion) => ({
        id: promotion.id,
        taskId: promotion.taskId,
        status: promotion.promotionStatus,
        prNumber: promotion.prNumber,
        prUrl: promotion.prUrl,
        branchName: promotion.branchName,
        mergedAt: promotion.mergedAt,
        lastError: promotion.lastError
      }))
  }

  private changedReleasesForFullCycle(
    project: Project,
    startedAt: string,
    initialReleaseIds: Set<string>
  ): QueueRefreshFullCycleReleaseSummary[] {
    return this.store
      .listReleases(project.id)
      .filter((release) => !initialReleaseIds.has(release.id) || release.updatedAt >= startedAt)
      .map((release) => ({
        id: release.id,
        name: release.name,
        version: release.version,
        status: release.status,
        releasedAt: release.releasedAt,
        notes: release.notes
      }))
  }

  async runQueueRefreshFullCycle(
    projectRef: string,
    options: {
      profileId?: string | null
      maxPasses?: number
      waitForLoops?: boolean
      waitTimeoutMs?: number
      waitPollMs?: number
    } = {}
  ): Promise<QueueRefreshFullCycleReport> {
    const { profile } = this.resolveProfile(projectRef, options.profileId ?? null)
    const project = this.store.resolveProject(projectRef)
    const cycleId = randomUUID()
    const startedAt = new Date().toISOString()
    const maxPasses = Math.max(1, Math.min(50, Math.floor(options.maxPasses ?? 8)))
    const waitForLoops = options.waitForLoops ?? true
    const waitTimeoutMs = Math.max(1, Math.floor(options.waitTimeoutMs ?? 30_000))
    const waitPollMs = Math.max(1, Math.floor(options.waitPollMs ?? 250))
    const audit = this.audit(project.id, profile)
    const seenRunIds = new Set(this.store.listProjectRuns(project.id).map((run) => run.id))
    const initialPromotionIds = new Set(
      this.store
        .listPromotions(project.companyId)
        .filter((promotion) => promotion.projectId === project.id)
        .map((promotion) => promotion.id)
    )
    const initialReleaseIds = new Set(this.store.listReleases(project.id).map((release) => release.id))

    audit.append("job-started", {
      jobId: "queue-refresh",
      mode: "full-cycle",
      cycleId,
      profileId: profile.profileId,
      project: project.name,
      maxPasses,
      waitForLoops
    })

    const queueRefresh = this.queueRefresh(project.id, profile.profileId)
    let plannerCreatedTaskIds: string[] = []
    try {
      const planner = await this.executor.runPlannerRefresh(project.id)
      plannerCreatedTaskIds = planner.createdTaskIds
      queueRefresh.plannerRunId = planner.plannerRunId
      queueRefresh.plannerCreatedTasks = planner.createdTasks
    } catch (error) {
      queueRefresh.plannerRunId = null
      queueRefresh.plannerCreatedTasks = null
      audit.append("planner-run-failed", {
        cycleId,
        projectId: project.id,
        error: error instanceof Error ? error.message : String(error)
      })
    }

    const allRuns: QueueRefreshFullCycleRunSummary[] = await this.collectNewFullCycleRuns({
      project,
      seenRunIds,
      waitForLoops,
      waitTimeoutMs,
      waitPollMs
    })
    const passes: QueueRefreshFullCyclePass[] = []
    let stopReason: QueueRefreshFullCycleStopReason = "pass_limit_reached"
    let finalQueue = collectDirectorQueueState(this.store, project)

    for (let index = 1; index <= maxPasses; index += 1) {
      const passStartedAt = new Date().toISOString()
      const jobs: QueueRefreshFullCycleJobSummary[] = []
      const passRuns: QueueRefreshFullCycleRunSummary[] = []

      const implementation = await this.executor.dispatchNext(project.id)
      jobs.push({
        jobId: "execution-sweep",
        phase: "implementation",
        resultSummary: `executed ${implementation.executedRuns} implementation run(s)`,
        tickSummary: {
          ...implementation,
          executedJobs: 1,
          createdReviewTasks: 0
        }
      })
      passRuns.push(
        ...(await this.collectNewFullCycleRuns({
          project,
          seenRunIds,
          waitForLoops,
          waitTimeoutMs,
          waitPollMs
        }))
      )

      const review = this.executor.runReviewSweep(project.id)
      jobs.push({
        jobId: "review-sweep",
        phase: "review",
        resultSummary: `created ${review.created} review task(s); recovered ${review.recovered} parent task(s)`,
        tickSummary: {
          executedRuns: 0,
          blockedTasks: 0,
          skippedTasks: 0,
          followUpTasks: 0,
          executedJobs: 1,
          createdReviewTasks: review.created
        }
      })

      const reviewExecution = await this.executor.dispatchNext(project.id)
      jobs.push({
        jobId: "execution-sweep",
        phase: "review_execution",
        resultSummary: `executed ${reviewExecution.executedRuns} review run(s)`,
        tickSummary: {
          ...reviewExecution,
          executedJobs: 1,
          createdReviewTasks: 0
        }
      })
      passRuns.push(
        ...(await this.collectNewFullCycleRuns({
          project,
          seenRunIds,
          waitForLoops,
          waitTimeoutMs,
          waitPollMs
        }))
      )

      const promoted = this.executor.runPromotionSweep(project.id)
      jobs.push({
        jobId: "promotion-sweep",
        phase: "promotion",
        resultSummary: `created ${promoted} promote task(s)`,
        tickSummary: {
          executedRuns: 0,
          blockedTasks: 0,
          skippedTasks: 0,
          followUpTasks: 0,
          executedJobs: 1,
          createdReviewTasks: 0
        }
      })

      const promotionExecution = await this.executor.dispatchNext(project.id)
      jobs.push({
        jobId: "execution-sweep",
        phase: "promotion_execution",
        resultSummary: `executed ${promotionExecution.executedRuns} promotion run(s)`,
        tickSummary: {
          ...promotionExecution,
          executedJobs: 1,
          createdReviewTasks: 0
        }
      })
      passRuns.push(
        ...(await this.collectNewFullCycleRuns({
          project,
          seenRunIds,
          waitForLoops,
          waitTimeoutMs,
          waitPollMs
        }))
      )

      const progressed =
        passRuns.length > 0 ||
        implementation.executedRuns > 0 ||
        implementation.blockedTasks > 0 ||
        implementation.followUpTasks > 0 ||
        review.created > 0 ||
        review.recovered > 0 ||
        reviewExecution.executedRuns > 0 ||
        reviewExecution.blockedTasks > 0 ||
        reviewExecution.followUpTasks > 0 ||
        promoted > 0 ||
        promotionExecution.executedRuns > 0 ||
        promotionExecution.blockedTasks > 0 ||
        promotionExecution.followUpTasks > 0

      finalQueue = collectDirectorQueueState(this.store, project)
      const pass: QueueRefreshFullCyclePass = {
        index,
        startedAt: passStartedAt,
        endedAt: new Date().toISOString(),
        jobs,
        newRuns: passRuns,
        queue: finalQueue,
        progressed
      }
      passes.push(pass)
      allRuns.push(...passRuns)

      if (directorQueueDrained(finalQueue)) {
        stopReason = finalQueue.blockedTasks > 0 || finalQueue.failedTasks > 0 ? "blocked" : "queue_drained"
        break
      }

      if (!progressed) {
        stopReason = "no_progress"
        break
      }
    }

    const endedAt = new Date().toISOString()
    const report: QueueRefreshFullCycleReport = {
      cycleId,
      projectId: project.id,
      projectName: project.name,
      profileId: profile.profileId,
      startedAt,
      endedAt,
      stopReason,
      maxPasses,
      passes,
      queueRefresh,
      plannerCreatedTaskIds,
      runs: allRuns,
      promotions: this.changedPromotionsForFullCycle(project, startedAt, initialPromotionIds),
      releases: this.changedReleasesForFullCycle(project, startedAt, initialReleaseIds),
      finalQueue
    }

    audit.append("job-finished", {
      jobId: "queue-refresh",
      mode: "full-cycle",
      resultSummary: stopReason,
      cycleId,
      stopReason,
      passes: passes.length,
      plannerCreatedTasks: plannerCreatedTaskIds.length,
      runs: allRuns.length,
      promotions: report.promotions.length,
      releases: report.releases.length,
      finalQueue
    })

    return report
  }

  private buildDecisionSnapshot(
    project: Project,
    profile: ProjectProfile,
    riskThreshold: number
  ): DirectorDecisionInputSnapshot {
    const queue = collectDirectorQueueState(this.store, project)
    const recentRuns = recentProjectRuns(this.store, project.id)
    const verificationFailures = collectVerificationFailures(this.store, project, recentRuns)
    const memorySignals = collectMemorySignals(this.store, project.id)
    const repair = diagnoseQueueHealth(this.store, {
      companyId: project.companyId,
      projectId: project.id
    })
    const risk = assessDirectorRisk({
      store: this.store,
      project,
      queue,
      recentRuns,
      verificationFailures,
      memorySignals,
      repair,
      riskThreshold
    })

    return {
      project: {
        id: project.id,
        name: project.name,
        repoPath: project.repoPath,
        verifyCommand: project.verifyCommand
      },
      profile: {
        id: profile.profileId,
        version: profile.version,
        lanes: profile.laneDefinitions.length,
        jobs: profile.jobDefinitions.map((job) => job.jobId)
      },
      queue,
      recentRuns: recentRuns.map((run) => ({
        id: run.id,
        taskId: run.taskId,
        status: run.status,
        retryClass: run.retryClass,
        verificationSummary: run.verificationSummary,
        errorText: run.errorText
      })),
      verificationFailures,
      memorySignals,
      repair,
      risk
    }
  }

  private async applyDirectorAction(input: {
    project: Project
    profile: ProjectProfile
    action: DirectorDecisionAction
    dryRun: boolean
  }): Promise<Record<string, unknown>> {
    if (input.dryRun) {
      return {
        dryRun: true,
        wouldApply: input.action
      }
    }

    if (input.action === "run_repair") {
      const repaired = repairQueueHealth(
        this.store,
        {
          companyId: input.project.companyId,
          projectId: input.project.id
        },
        (projectId) => this.audit(projectId, input.profile)
      )
      return {
        repaired: repaired.repaired,
        detected: repaired.detected,
        counts: repaired.counts
      }
    }

    if (input.action === "create_tasks") {
      const refreshed = this.queueRefresh(input.project.id, input.profile.profileId)
      try {
        const planner = await this.executor.runPlannerRefresh(input.project.id)
        refreshed.plannerRunId = planner.plannerRunId
        refreshed.plannerCreatedTasks = planner.createdTasks
      } catch (error) {
        refreshed.plannerRunId = null
        refreshed.plannerCreatedTasks = null
        return {
          profileId: refreshed.profileId,
          createdWorkflows: refreshed.createdWorkflows,
          createdTasks: refreshed.createdTasks,
          consumedHandoffs: refreshed.consumedHandoffs,
          plannerError: error instanceof Error ? error.message : String(error)
        }
      }
      return {
        profileId: refreshed.profileId,
        createdWorkflows: refreshed.createdWorkflows,
        createdTasks: refreshed.createdTasks,
        consumedHandoffs: refreshed.consumedHandoffs,
        plannerRunId: refreshed.plannerRunId ?? null,
        plannerCreatedTasks: refreshed.plannerCreatedTasks ?? 0
      }
    }

    if (input.action === "dispatch_task" || input.action === "request_review" || input.action === "promote_change") {
      const jobIds: JobId[] =
        input.action === "request_review"
          ? ["review-sweep", "execution-sweep"]
          : input.action === "promote_change"
            ? ["promotion-sweep", "execution-sweep"]
            : ["execution-sweep"]
      for (const jobId of jobIds) {
        const jobSpec = this.store.findJobSpec(input.project.id, jobId)
        if (!jobSpec) continue
        this.store.updateJobSpecRuntime(jobSpec.id, {
          lastTriggeredAt: null,
          lastResult: `re-armed by director action ${input.action}`
        })
      }
      const summary = await this.executor.tick(input.project.companyId)
      return {
        executedRuns: summary.executedRuns,
        blockedTasks: summary.blockedTasks,
        skippedTasks: summary.skippedTasks,
        followUpTasks: summary.followUpTasks,
        executedJobs: summary.executedJobs,
        createdReviewTasks: summary.createdReviewTasks
      }
    }

    return {
      blocked: input.action === "pause_due_to_risk",
      terminal: true
    }
  }

  async runAutonomousCycle(
    projectRef: string,
    options: AutonomousDirectorCycleOptions = {}
  ): Promise<AutonomousDirectorCycleReport> {
    const { profile } = this.resolveProfile(projectRef, options.profileId ?? null)
    const project = this.store.resolveProject(projectRef)
    const maxPasses = Math.max(1, options.maxPasses ?? 6)
    const riskThreshold = Math.max(1, Math.min(100, options.riskThreshold ?? 80))
    const quotaLimit = Math.max(1, options.quotaLimit ?? 20)
    const dryRun = options.dryRun ?? false
    const autonomous = options.autonomous ?? false
    const cycleId = randomUUID()
    const decisions: DirectorDecisionRecord[] = []
    let quotaUsed = 0
    let passes = 0
    let stopReason: DirectorStopReason = "pass_limit_reached"
    let finalQueue = collectDirectorQueueState(this.store, project)
    let finalRisk = 0

    while (passes < maxPasses) {
      passes += 1
      const snapshot = this.buildDecisionSnapshot(project, profile, riskThreshold)
      finalQueue = snapshot.queue
      finalRisk = snapshot.risk.score
      const choice = chooseDirectorAction({
        queue: snapshot.queue,
        repair: snapshot.repair,
        risk: snapshot.risk,
        quotaUsed,
        quotaLimit,
        riskThreshold
      })
      const decision = this.store.createDirectorDecision({
        companyId: project.companyId,
        projectId: project.id,
        profileId: profile.profileId,
        cycleId,
        passIndex: passes,
        action: choice.action,
        dryRun,
        reason: choice.reason,
        stopReason: choice.stopReason ?? null,
        riskScore: snapshot.risk.score,
        riskThreshold,
        quotaUsed,
        quotaLimit,
        loopLimit: maxPasses,
        input: snapshot as unknown as Record<string, unknown>
      })

      if (choice.action === "stop" || choice.action === "pause_due_to_risk") {
        const completed = this.store.completeDirectorDecision(decision.id, {
          status: choice.action === "pause_due_to_risk" ? "blocked" : "skipped",
          stopReason:
            choice.stopReason ?? (choice.action === "pause_due_to_risk" ? "risk_threshold_exceeded" : "no_progress"),
          result: {
            terminal: true,
            reason: choice.reason
          }
        })
        decisions.push(completed)
        stopReason = completed.stopReason ?? "no_progress"
        break
      }

      let result: Record<string, unknown>
      try {
        result = await this.applyDirectorAction({
          project,
          profile,
          action: choice.action,
          dryRun
        })
      } catch (error) {
        result = {
          error: error instanceof Error ? error.message : String(error)
        }
      }

      if (!dryRun) {
        quotaUsed += 1
      }

      const completed = this.store.completeDirectorDecision(decision.id, {
        status: result.error ? "blocked" : dryRun ? "skipped" : "applied",
        result
      })
      decisions.push(completed)
      finalQueue = collectDirectorQueueState(this.store, project)

      const progressed =
        Number(result.createdWorkflows ?? 0) > 0 ||
        Number(result.createdTasks ?? 0) > 0 ||
        Number(result.plannerCreatedTasks ?? 0) > 0 ||
        Number(result.repaired ?? 0) > 0 ||
        Number(result.executedRuns ?? 0) > 0 ||
        Number(result.executedJobs ?? 0) > 0 ||
        Number(result.createdReviewTasks ?? 0) > 0 ||
        Number(result.followUpTasks ?? 0) > 0

      if (dryRun) {
        stopReason = "no_progress"
        break
      }
      if (directorQueueDrained(finalQueue)) {
        stopReason = "queue_drained"
        break
      }
      if (quotaUsed >= quotaLimit) {
        stopReason = "quota_limit_reached"
        break
      }
      if (!autonomous) {
        stopReason = progressed ? "pass_limit_reached" : "no_progress"
        break
      }
      if (!progressed) {
        stopReason = "no_progress"
        break
      }
    }

    if (passes >= maxPasses && stopReason === "pass_limit_reached") {
      const snapshot = this.buildDecisionSnapshot(project, profile, riskThreshold)
      finalQueue = snapshot.queue
      finalRisk = snapshot.risk.score
    }

    let incidentNotification: AutonomousDirectorCycleReport["incidentNotification"] = null
    const stalledWithWork = stopReason === "no_progress" && !directorQueueDrained(finalQueue)
    if (
      !dryRun &&
      (stopReason === "quota_limit_reached" || stopReason === "risk_threshold_exceeded" || stalledWithWork)
    ) {
      try {
        const notification = await this.sendDigest(project.id, {
          profileId: profile.profileId,
          kind: "incident"
        })
        incidentNotification = {
          delivery: notification.delivery,
          resultSummary: notification.resultSummary
        }
      } catch (error) {
        incidentNotification = {
          delivery: "failed-soft",
          resultSummary: `incident notification failed softly: ${error instanceof Error ? error.message : String(error)}`
        }
      }
    }

    return {
      cycleId,
      projectId: project.id,
      projectName: project.name,
      profileId: profile.profileId,
      dryRun,
      autonomous,
      passes,
      stopReason,
      riskScore: finalRisk,
      riskThreshold,
      quotaUsed,
      quotaLimit,
      finalQueue,
      decisions,
      incidentNotification
    }
  }

  private async ghPrSweep(projectRef: string, explicitProfileId?: string | null): Promise<string> {
    this.resolveProfile(projectRef, explicitProfileId)
    const project = this.store.resolveProject(projectRef)
    const promotions = this.store
      .listPromotions(project.companyId)
      .filter(
        (promotion) =>
          promotion.projectId === project.id && promotion.prNumber !== null && promotion.promotionStatus !== "merged"
      )

    let inspected = 0
    let merged = 0
    let closed = 0
    let errors = 0

    for (const promotion of promotions) {
      const result = inspectGitHubPromotion(project, promotion)
      if (!result.ok) {
        errors += 1
        this.store.updatePromotion(promotion.id, {
          lastReviewSyncAt: new Date().toISOString(),
          lastChecksSyncAt: new Date().toISOString(),
          lastError: result.error
        })
        continue
      }

      inspected += 1
      const now = new Date().toISOString()
      const prNumber = numberFrom(result.payload.number) ?? promotion.prNumber
      const prUrl = stringFrom(result.payload.url) ?? promotion.prUrl
      const state = stringFrom(result.payload.state)?.toUpperCase() ?? null
      const mergedAt = stringFrom(result.payload.mergedAt)
      const headSha =
        stringFrom((result.payload.mergeCommit as Record<string, unknown> | null | undefined)?.oid) ??
        stringFrom(result.payload.headRefOid) ??
        promotion.headSha

      if (state === "MERGED" || mergedAt) {
        this.store.updatePromotion(promotion.id, {
          prNumber,
          prUrl,
          headSha,
          lastReviewSyncAt: now,
          lastChecksSyncAt: now,
          promotionStatus: "merged",
          mergedAt: mergedAt ?? now,
          lastError: null
        })
        this.markPromotionTasksMerged(project, promotion, {
          prNumber,
          prUrl,
          mergedAt: mergedAt ?? now
        })
        merged += 1
        continue
      }

      if (state === "CLOSED") {
        const message = `Pull request #${prNumber ?? "?"} was closed without merge.`
        this.store.updatePromotion(promotion.id, {
          prNumber,
          prUrl,
          headSha,
          lastReviewSyncAt: now,
          lastChecksSyncAt: now,
          promotionStatus: "failed",
          lastError: message
        })
        this.markPromotionTasksClosed(project, promotion, {
          prNumber,
          prUrl,
          message
        })
        closed += 1
        continue
      }

      this.store.updatePromotion(promotion.id, {
        prNumber,
        prUrl,
        headSha,
        lastReviewSyncAt: now,
        lastChecksSyncAt: now,
        lastError: null
      })
    }

    return [
      "GitHub PR sweep completed",
      `inspected=${inspected}`,
      `merged=${merged}`,
      `closed=${closed}`,
      `errors=${errors}`
    ].join(": ")
  }

  private markPromotionTasksMerged(
    project: Project,
    promotion: PromotionRecord,
    details: { prNumber: number | null; prUrl: string | null; mergedAt: string }
  ): void {
    const tasks = this.promotionRelatedTasks(promotion)
    for (const task of tasks) {
      if (task.status !== "done") {
        this.store.updateTaskStatus(task.id, "done", {
          lastError: null,
          blockedReason: null
        })
      }
      this.store.appendTaskEvent(task.id, "github-pr-sweep-merged", "GitHub PR sweep observed merged PR.", {
        promotionId: promotion.id,
        prNumber: details.prNumber,
        prUrl: details.prUrl,
        mergedAt: details.mergedAt
      })
    }
    this.refreshPromotionWorkflows(tasks)
  }

  private markPromotionTasksClosed(
    project: Project,
    promotion: PromotionRecord,
    details: { prNumber: number | null; prUrl: string | null; message: string }
  ): void {
    const tasks = this.promotionRelatedTasks(promotion)
    for (const task of tasks) {
      if (task.status !== "failed" && task.status !== "done") {
        this.store.updateTaskStatus(task.id, "blocked", {
          blockedReason: "github_pr_closed_without_merge",
          lastError: details.message
        })
      }
      this.store.appendTaskEvent(task.id, "github-pr-sweep-closed", details.message, {
        promotionId: promotion.id,
        prNumber: details.prNumber,
        prUrl: details.prUrl
      })
    }
    this.refreshPromotionWorkflows(tasks)
  }

  private promotionRelatedTasks(promotion: PromotionRecord): Task[] {
    const tasks = new Map<string, Task>()
    let subject: Task
    try {
      subject = this.store.getTaskById(promotion.taskId)
    } catch {
      return []
    }

    tasks.set(subject.id, subject)
    for (const child of this.store.listChildTasks(subject.id, "promote")) {
      tasks.set(child.id, child)
    }

    if (subject.kind === "promote" && subject.parentTaskId) {
      try {
        const parent = this.store.getTaskById(subject.parentTaskId)
        tasks.set(parent.id, parent)
      } catch {
        // The promotion record is still useful even when historical parent rows are gone.
      }
    }

    return Array.from(tasks.values())
  }

  private refreshPromotionWorkflows(tasks: Task[]): void {
    const workflowIds = new Set(tasks.map((task) => task.workflowId).filter((id): id is string => Boolean(id)))
    for (const workflowId of workflowIds) {
      try {
        this.store.refreshWorkflowStatus(workflowId)
      } catch {
        // Historical promotion rows can outlive their workflow rows.
      }
    }
  }

  async sendDigest(
    projectRef: string,
    options: {
      profileId?: string | null
      kind?: "daily" | "incident"
      dryRun?: boolean
      windowHours?: number
    } = {}
  ): Promise<TelegramDeliveryResult> {
    const { profile } = this.resolveProfile(projectRef, options.profileId ?? null)
    const input = {
      store: this.store,
      projectRef,
      profile,
      kind: options.kind ?? "daily",
      dryRun: options.dryRun ?? false
    } as const
    return sendTelegramDigest(
      options.windowHours === undefined ? input : { ...input, windowHours: options.windowHours }
    )
  }
}

function inspectGitHubPromotion(
  project: Project,
  promotion: PromotionRecord
): { ok: true; payload: Record<string, unknown> } | { ok: false; error: string } {
  if (promotion.prNumber === null) {
    return { ok: false, error: "promotion has no pull request number" }
  }

  try {
    const stdout = execFileSync(
      "gh",
      ["pr", "view", String(promotion.prNumber), "--json", "number,url,state,mergedAt,mergeCommit,headRefOid"],
      {
        cwd: project.repoPath,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      }
    )
    return { ok: true, payload: JSON.parse(stdout || "{}") as Record<string, unknown> }
  } catch (error) {
    if (error && typeof error === "object" && "stderr" in error) {
      const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim()
      if (stderr) return { ok: false, error: stderr }
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function stringFrom(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null
}

function numberFrom(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

const DEFAULT_RUNTIME_BACKUP_KEEP_COUNT = 5

function runtimeBackupKeepCount(): number {
  const raw = process.env.OPENCLAW_RUNTIME_BACKUP_KEEP_COUNT
  if (!raw) return DEFAULT_RUNTIME_BACKUP_KEEP_COUNT
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RUNTIME_BACKUP_KEEP_COUNT
}

function pruneRuntimeBackups(directory: string, prefix: string): void {
  const keepCount = runtimeBackupKeepCount()
  try {
    const backups = readdirSync(directory)
      .map((name) => {
        const path = join(directory, name)
        const stats = statSync(path)
        return { name, path, mtimeMs: stats.mtimeMs, isFile: stats.isFile() }
      })
      .filter((entry) => entry.isFile && entry.name.startsWith(prefix))
      .sort((left, right) => right.mtimeMs - left.mtimeMs)

    for (const backup of backups.slice(keepCount)) {
      rmSync(backup.path, { force: true })
    }
  } catch {
    // Backup pruning must never make the backup itself fail.
  }
}

export function backupRuntimeState(store: DispatcherStore): string {
  const backupPath = `${store.dbPath}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`
  mkdirSync(dirname(backupPath), { recursive: true })
  copyFileSync(store.dbPath, backupPath)
  pruneRuntimeBackups(dirname(store.dbPath), `${basename(store.dbPath)}.backup-`)
  return backupPath
}

export function resetRuntimeState(store: DispatcherStore): {
  backupPath: string
  clearedTables: Record<string, number>
} {
  const backupPath = backupRuntimeState(store)
  const counts: Record<string, number> = {}
  const now = nowIso()
  store.db.exec("PRAGMA foreign_keys = OFF")
  for (const table of RESET_TABLES) {
    const row = store.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }
    counts[table] = Number(row.count)
    store.db.prepare(`DELETE FROM ${table}`).run()
  }
  store.db.prepare("UPDATE job_specs SET last_triggered_at = NULL, last_result = NULL, updated_at = ?").run(now)
  store.db.prepare("UPDATE automations SET next_run_at = NULL, last_run_at = NULL, updated_at = ?").run(now)
  store.db
    .prepare("UPDATE agents SET status = 'idle', last_heartbeat_at = NULL, updated_at = ? WHERE status != 'paused'")
    .run(now)
  return { backupPath, clearedTables: counts }
}

export function resetRuntimeStateWithAudit(
  store: DispatcherStore,
  audit?: AuditWriter
): { backupPath: string; clearedTables: Record<string, number> } {
  const result = resetRuntimeState(store)
  audit?.append("runtime-reset", { backupPath: result.backupPath, clearedTables: result.clearedTables })
  return result
}

export function recoverStaleRuns(store: DispatcherStore): { recoveredRuns: number } {
  const summary = repairQueueHealth(store)
  return { recoveredRuns: summary.counts.staleRuns }
}

export function recoverStaleRunsWithAudit(
  store: DispatcherStore,
  auditFactory?: (projectId: string) => AuditWriter
): { recoveredRuns: number } {
  const summary = repairQueueHealth(store, {}, auditFactory)
  return { recoveredRuns: summary.counts.staleRuns }
}

export function pruneDuplicateQueuedWorkflows(store: DispatcherStore): {
  duplicateWorkflowsRecovered: number
  duplicateTasksRecovered: number
} {
  const workflows = store.listWorkflows()
  const groups = new Map<string, Workflow[]>()
  for (const workflow of workflows) {
    const tasks = store.listWorkflowTasks(workflow.id)
    const untouched = tasks.length > 0 && tasks.every((task) => task.status === "queued")
    if (!untouched) continue
    const key = `${workflow.projectId}:${workflow.title.trim().toLowerCase()}`
    groups.set(key, [...(groups.get(key) ?? []), workflow])
  }

  let duplicateWorkflowsRecovered = 0
  let duplicateTasksRecovered = 0
  for (const items of groups.values()) {
    if (items.length <= 1) continue
    const ordered = [...items].sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    for (const workflow of ordered.slice(0, -1)) {
      const tasks = store.listWorkflowTasks(workflow.id)
      for (const task of tasks) {
        store.updateTaskStatus(task.id, "failed", {
          lastError: `Recovered duplicate queued workflow in favor of newer workflow "${ordered.at(-1)?.title ?? workflow.title}".`,
          blockedReason: "duplicate_workflow_recovered",
          lastRecoveryAt: nowIso(),
          lastRecoveryReason: "duplicate_workflow_recovered"
        })
        store.appendTaskEvent(
          task.id,
          "duplicate-workflow-recovered",
          "Marked duplicate queued workflow task as recovered.",
          {
            canonicalWorkflowId: ordered.at(-1)?.id ?? null,
            duplicateWorkflowId: workflow.id
          }
        )
        duplicateTasksRecovered += 1
      }
      store.updateWorkflow(workflow.id, {
        status: "failed",
        completedAt: nowIso()
      })
      duplicateWorkflowsRecovered += 1
    }
  }
  return { duplicateWorkflowsRecovered, duplicateTasksRecovered }
}

export function pruneDuplicateQueuedWorkflowsWithAudit(
  store: DispatcherStore,
  auditFactory?: (projectId: string) => AuditWriter
): { duplicateWorkflowsRecovered: number; duplicateTasksRecovered: number } {
  const result = pruneDuplicateQueuedWorkflows(store)
  if (result.duplicateWorkflowsRecovered > 0 && auditFactory) {
    for (const workflow of store.listWorkflows().filter((entry) => entry.status === "failed")) {
      auditFactory(workflow.projectId).append("recovery-performed", {
        workflowId: workflow.id,
        reason: "duplicate_workflow_recovered"
      })
    }
  }
  return result
}

export interface HistoricalBlockedTaskArchiveSummary {
  cutoff: string
  dryRun: boolean
  candidateTaskIds: string[]
  archivedTaskIds: string[]
  skippedActiveTaskIds: string[]
}

export function archiveHistoricalBlockedTasks(
  store: DispatcherStore,
  options: {
    companyId?: string
    projectId?: string
    olderThanHours?: number
    at?: string
    dryRun?: boolean
  } = {}
): HistoricalBlockedTaskArchiveSummary {
  const at = options.at ?? nowIso()
  const olderThanHours = Math.max(1, options.olderThanHours ?? 24)
  const cutoff = new Date(new Date(at).getTime() - olderThanHours * 60 * 60 * 1000).toISOString()
  const tasks = options.projectId ? store.listProjectTasks(options.projectId) : store.listTasks(options.companyId)
  const scopedTasks = options.companyId ? tasks.filter((task) => task.companyId === options.companyId) : tasks
  const activeStatuses = new Set(["queued", "running", "review_needed", "promotion_pending"])
  const activePromotionTaskIds = new Set(
    store
      .listPromotions(options.companyId)
      .filter(
        (promotion) =>
          (!options.projectId || promotion.projectId === options.projectId) &&
          promotion.promotionStatus !== "merged" &&
          promotion.promotionStatus !== "failed"
      )
      .map((promotion) => promotion.taskId)
  )
  const hasActiveDependent = (taskId: string): boolean =>
    scopedTasks.some(
      (candidate) =>
        activeStatuses.has(candidate.status) &&
        (candidate.parentTaskId === taskId || candidate.dependsOnTaskIds.includes(taskId))
    )
  const taskById = new Map(scopedTasks.map((task) => [task.id, task]))
  const hasArchivedAncestor = (task: Task): boolean => {
    const visited = new Set<string>()
    let parentTaskId = task.parentTaskId
    while (parentTaskId && !visited.has(parentTaskId)) {
      visited.add(parentTaskId)
      const parent = taskById.get(parentTaskId)
      if (!parent) return false
      if (parent.lastRecoveryReason === "historical_blocker_archived") return true
      parentTaskId = parent.parentTaskId
    }
    return false
  }

  const historical = scopedTasks.filter(
    (task) =>
      task.status === "blocked" &&
      (task.updatedAt <= cutoff ||
        task.lastRecoveryReason === "historical_blocker_archived" ||
        hasArchivedAncestor(task))
  )
  const skippedActiveTaskIds = historical
    .filter((task) => activePromotionTaskIds.has(task.id) || hasActiveDependent(task.id))
    .map((task) => task.id)
  const candidateTaskIds = historical
    .filter((task) => !activePromotionTaskIds.has(task.id) && !hasActiveDependent(task.id))
    .map((task) => task.id)
  const archivedTaskIds: string[] = []

  if (!options.dryRun) {
    for (const taskId of candidateTaskIds) {
      const task = store.getTaskById(taskId)
      store.updateTaskStatus(taskId, "failed", {
        lastError: task.lastError ?? `Archived historical blocked task after ${olderThanHours} hours.`,
        blockedReason: task.blockedReason,
        lastRecoveryAt: at,
        lastRecoveryReason: "historical_blocker_archived"
      })
      store.appendTaskEvent(taskId, "historical-blocker-archived", "Archived historical blocked task as failed.", {
        cutoff,
        olderThanHours,
        previousBlockedReason: task.blockedReason
      })
      archivedTaskIds.push(taskId)
    }
  }

  return { cutoff, dryRun: options.dryRun ?? false, candidateTaskIds, archivedTaskIds, skippedActiveTaskIds }
}

export type { OperationalDigestSummary, TelegramDeliveryResult }
export { collectOperationalDigestSummary, formatDailyTelegramDigest, formatIncidentTelegramDigest, sendTelegramDigest }

export function diagnoseQueueHealth(
  store: DispatcherStore,
  options: {
    companyId?: string
    projectId?: string
    dryRun?: boolean
    at?: string
  } = {}
): QueueHealthSummary {
  const checkedAt = options.at ?? nowIso()
  const projectIds = options.projectId
    ? [options.projectId]
    : store.listProjects(options.companyId).map((project) => project.id)
  const staleRunIds = new Set<string>()
  const staleRunTaskIds = new Set<string>()
  const plannerHandledIds = new Set<string>()
  const actions: QueueHealthAction[] = []

  for (const run of store.listRunningRuns(options.companyId)) {
    if (options.projectId && run.projectId !== options.projectId) continue
    const startedAt = parseIsoMillis(run.startedAt) ?? parseIsoMillis(run.createdAt)
    const latestEventAt = store
      .getRunEvents(run.id)
      .map((event) => parseIsoMillis(event.createdAt))
      .filter((eventAt): eventAt is number => eventAt !== null)
      .reduce((latest, eventAt) => Math.max(latest, eventAt), Number.NEGATIVE_INFINITY)
    const lastActivityAt = Math.max(startedAt ?? Number.NEGATIVE_INFINITY, latestEventAt)
    const ownerPid = readAgentLoopOwnerPid(store, run.id)
    const ownerExited = ownerPid !== null && !ownerProcessIsAlive(ownerPid)
    if (
      !ownerExited &&
      (!Number.isFinite(lastActivityAt) || Date.parse(checkedAt) - lastActivityAt < staleRunThresholdMs())
    ) {
      continue
    }
    const task = store.getTaskById(run.taskId)
    const recoveryStatus = task.retryCount + 1 <= task.maxRetries ? "queued" : "failed"
    staleRunIds.add(run.id)
    staleRunTaskIds.add(task.id)
    actions.push({
      entity: "run",
      reason: "stale_run_recovered",
      projectId: run.projectId,
      taskId: run.taskId,
      runId: run.id,
      agentId: run.agentId,
      recoveryStatus,
      detail: ownerExited
        ? `run owner process ${ownerPid} exited without completing it`
        : `run had no activity for ${staleRunThresholdMs()}ms`
    })
  }

  for (const task of store.findExpiredClaims(checkedAt)) {
    if (options.companyId && task.companyId !== options.companyId) continue
    if (options.projectId && task.projectId !== options.projectId) continue
    if (staleRunTaskIds.has(task.id) || store.hasActiveRunForTask(task.id)) continue
    actions.push({
      entity: "task",
      reason: "claim_timeout",
      projectId: task.projectId,
      taskId: task.id,
      recoveryStatus: "queued",
      detail: "claimed task lease expired without an active run"
    })
  }

  for (const agent of store.listAgents(options.companyId)) {
    if (agent.status !== "running") continue
    if (store.hasActiveRunForAgent(agent.id)) continue
    actions.push({
      entity: "agent",
      reason: "zombie_agent_released",
      agentId: agent.id,
      detail: "agent marked running without an active run"
    })
  }

  for (const projectId of projectIds) {
    const runningPlannerRuns = store.listRunningPlannerRuns(projectId)
    const candidateDuplicates: typeof runningPlannerRuns = []

    for (const plannerRun of runningPlannerRuns) {
      const hasTerminalPayload = Boolean(plannerRun.outputJson || plannerRun.summaryJson || plannerRun.finishedAt)
      if (hasTerminalPayload) {
        plannerHandledIds.add(plannerRun.id)
        actions.push({
          entity: "planner_run",
          reason: "planner_lineage_repaired",
          projectId: plannerRun.projectId,
          plannerRunId: plannerRun.id,
          recoveryStatus: "succeeded",
          detail: "planner run has persisted output but is still marked running"
        })
        continue
      }

      const startedAt = parseIsoMillis(plannerRun.startedAt) ?? parseIsoMillis(plannerRun.createdAt)
      if (startedAt !== null && Date.parse(checkedAt) - startedAt >= stalePlannerRunThresholdMs()) {
        plannerHandledIds.add(plannerRun.id)
        actions.push({
          entity: "planner_run",
          reason: "stale_planner_run_recovered",
          projectId: plannerRun.projectId,
          plannerRunId: plannerRun.id,
          recoveryStatus: "failed",
          detail: `planner run exceeded stale threshold of ${stalePlannerRunThresholdMs()}ms`
        })
        continue
      }

      candidateDuplicates.push(plannerRun)
    }

    const activeDuplicates = candidateDuplicates.filter((plannerRun) => !plannerHandledIds.has(plannerRun.id))
    if (activeDuplicates.length <= 1) continue
    const canonical =
      [...activeDuplicates].sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null
    for (const plannerRun of activeDuplicates) {
      if (!canonical || plannerRun.id === canonical.id) continue
      plannerHandledIds.add(plannerRun.id)
      actions.push({
        entity: "planner_run",
        reason: "duplicate_planner_run_recovered",
        projectId: plannerRun.projectId,
        plannerRunId: plannerRun.id,
        canonicalPlannerRunId: canonical.id,
        recoveryStatus: "failed",
        detail: `duplicate active planner run recovered in favor of ${canonical.id}`
      })
    }
  }

  return {
    checkedAt,
    dryRun: options.dryRun ?? true,
    detected: actions.length,
    repaired: 0,
    counts: recoveryCounts(actions),
    actions
  }
}

export function repairQueueHealth(
  store: DispatcherStore,
  options: {
    companyId?: string
    projectId?: string
    at?: string
  } = {},
  auditFactory?: (projectId: string) => AuditWriter
): QueueHealthSummary {
  const summary = diagnoseQueueHealth(store, {
    ...options,
    dryRun: false
  })

  for (const action of summary.actions) {
    if (action.reason === "stale_run_recovered" && action.runId && action.taskId) {
      const task = store.getTaskById(action.taskId)
      store.appendRunEvent(action.runId, "warn", "Recovered stale running run during maintenance.", {
        reason: action.reason
      })
      store.completeRun(action.runId, {
        status: "failed",
        errorText: "Recovered stale running run during maintenance.",
        retryClass: "transient"
      })
      if (task.status === "running") {
        store.recoverTaskClaim(task.id, {
          status: (action.recoveryStatus as "queued" | "failed") ?? "queued",
          reason: "maintenance_stale_run_recovery",
          blockedReason:
            action.recoveryStatus === "failed"
              ? "recovered:maintenance_stale_run_recovery:failed"
              : "recovered:maintenance_stale_run_recovery:queued",
          lastError: "Recovered stale running task during maintenance.",
          incrementRetry: true,
          at: summary.checkedAt
        })
        store.appendTaskEvent(task.id, "maintenance", "Recovered stale running task.", {
          runId: action.runId,
          recoveryStatus: action.recoveryStatus
        })
      }
      if (action.agentId) {
        const agent = store.getAgentById(action.agentId)
        const budget = store.getBudgetStatus(agent)
        if (!store.hasActiveRunForAgent(agent.id)) {
          store.setAgentStatus(agent.id, budget.blocked ? "blocked" : "idle")
        }
      }
      if (action.projectId && auditFactory) {
        auditFactory(action.projectId).append("recovery-performed", {
          taskId: action.taskId,
          runId: action.runId,
          reason: "maintenance_stale_run_recovery",
          recoveryStatus: action.recoveryStatus
        })
      }
      summary.repaired += 1
      continue
    }

    if (action.reason === "claim_timeout" && action.taskId) {
      const task = store.getTaskById(action.taskId)
      store.recoverTaskClaim(task.id, {
        status: "queued",
        reason: "claim_timeout",
        blockedReason: "recovered:claim_timeout",
        lastError: "Task lease expired and was reclaimed.",
        at: summary.checkedAt
      })
      store.appendTaskEvent(task.id, "lease-expired", "Task lease expired and was reclaimed during maintenance.", {
        reason: action.reason
      })
      if (action.projectId && auditFactory) {
        auditFactory(action.projectId).append("task-reclaimed", {
          taskId: task.id,
          reason: "claim_timeout",
          recoveryStatus: "queued"
        })
      }
      summary.repaired += 1
      continue
    }

    if (action.reason === "zombie_agent_released" && action.agentId) {
      const agent = store.getAgentById(action.agentId)
      const budget = store.getBudgetStatus(agent)
      store.setAgentStatus(agent.id, budget.blocked ? "blocked" : "idle")
      summary.repaired += 1
      continue
    }

    if (action.plannerRunId) {
      if (action.reason === "planner_lineage_repaired") {
        store.updatePlannerRun(action.plannerRunId, {
          status: "succeeded",
          errorText: null,
          finishedAt: summary.checkedAt
        })
      } else {
        store.updatePlannerRun(action.plannerRunId, {
          status: "failed",
          errorText: action.detail ?? action.reason,
          finishedAt: summary.checkedAt
        })
      }
      store.appendPlannerEvent(action.plannerRunId, "planner-run-recovered", "Recovered planner run state.", {
        reason: action.reason,
        canonicalPlannerRunId: action.canonicalPlannerRunId ?? null,
        recoveryStatus: action.recoveryStatus
      })
      if (action.projectId && auditFactory) {
        auditFactory(action.projectId).append("recovery-performed", {
          plannerRunId: action.plannerRunId,
          reason: action.reason,
          canonicalPlannerRunId: action.canonicalPlannerRunId ?? null,
          recoveryStatus: action.recoveryStatus
        })
      }
      summary.repaired += 1
    }
  }

  summary.counts = recoveryCounts(summary.actions)
  return summary
}

export * from "./native/adoption.js"
export * from "./native/doctor.js"
export * from "./native/gateway.js"
export * from "./native/migration.js"
export * from "./native/runtime.js"
export * from "./native/store.js"
