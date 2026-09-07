import { randomUUID } from "node:crypto"
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import type { SQLInputValue } from "node:sqlite"
import { DatabaseSync } from "node:sqlite"
import {
  type AdapterLaneHealth,
  type AdapterLaneStatus,
  type AdapterType,
  type AdapterUsage,
  type Agent,
  type AgentStatus,
  type ApprovalRequest,
  type ApprovalStatus,
  type Automation,
  type AutomationKind,
  type AutomationStatus,
  aggregateLaneOutcomeStats,
  artifactScopesOverlap,
  type BacklogCandidate,
  type BacklogCandidateStatus,
  type BacklogEffortEstimate,
  type BudgetStatus,
  type BudgetWindow,
  type BudgetWindowKind,
  buildHandoffArtifact,
  buildRepairTaskPlan,
  type Company,
  type DirectorDecisionAction,
  type DirectorDecisionRecord,
  type DirectorDecisionStatus,
  type DirectorStopReason,
  extractTaskReferenceIdentifiers,
  type Goal,
  type GoalStatus,
  type HandoffArtifact,
  type HandoffDraft,
  type HandoffRecord,
  type HandoffStatus,
  type JobId,
  type JobRun,
  type JobRunStatus,
  type JobSpec,
  type LaneOutcomeStats,
  MAX_REPAIR_ATTEMPTS,
  type MemoryAudience,
  type MemoryChunk,
  type MemoryEmbedding,
  type MemoryLayer,
  type MemoryLifecycleStatus,
  type MemoryProvenance,
  type MemoryRetentionPolicy,
  type MemorySourceKind,
  type MergeMethod,
  type Milestone,
  type MilestoneStatus,
  normalizeArtifactScopes,
  type OrchestraKind,
  type OutcomeStage,
  type Persona,
  type PersonaStage,
  type PersonaStatus,
  type PlannerEvent,
  type PlannerOutputEnvelope,
  type PlannerRunArtifact,
  type PlannerRunRecord,
  type PlannerRunSummary,
  type ProductArea,
  type ProductAreaStatus,
  type Project,
  type PromotionRecord,
  type PromotionStatus,
  type PromptVariant,
  type PromptVariantStatus,
  type Release,
  type ReleaseStatus,
  type RepairTaskPlan,
  type RepoPlanningSnapshot,
  type Repository,
  type RepositoryRole,
  type ReviewFinding,
  type ReviewOutcome,
  type ReviewResult,
  type ReviewRiskLevel,
  type ReviewSeverity,
  type ReviewVerdict,
  type RoutingMatchType,
  type RoutingRule,
  type Run,
  type RunEvent,
  type RunRetryClass,
  type RunStatus,
  type RuntimeLease,
  redactLogText,
  redactLogValue,
  type SessionState,
  type Task,
  type TaskClaimLease,
  type TaskClaimStatus,
  type TaskEvent,
  type TaskKind,
  type TaskOutcome,
  type TaskOutcomeResult,
  type TaskPackage,
  type TaskSource,
  type TaskSourceKind,
  type TaskSourceStatus,
  type TaskStatus,
  type TeamArtifactClaim,
  type TeamArtifactClaimStatus,
  type TeamAssignment,
  type TeamAssignmentStatus,
  type TeamMailboxMessage,
  type TeamMailboxMessageKind,
  type TeamReviewerLockout,
  type TeamReviewerLockoutStatus,
  type WakeReason,
  type Workflow,
  type WorkflowStatus
} from "@openclaw/domain"
import { pruneRuntimeBackups } from "./backup-retention.js"
import { SCHEMA_SQL } from "./schema.js"

type CreateCompanyInput = {
  name: string
  description?: string | null
}

type RecordTaskOutcomeInput = {
  companyId: string
  projectId: string
  taskId: string
  runId?: string | null
  laneId?: string | null
  stage: OutcomeStage
  adapterType?: AdapterType | null
  result: TaskOutcomeResult
  reason?: string | null
  verificationPassed?: boolean | null
  reviewVerdict?: ReviewVerdict | null
  retryCount?: number
  turns?: number | null
  costCents?: number | null
  tokensTotal?: number | null
  durationMs?: number | null
  reflection?: string | null
  metadata?: Record<string, unknown> | null
}

type UpsertPromptVariantInput = {
  projectId: string
  scope: string
  label: string
  promptHash: string
  status?: PromptVariantStatus
}

type CreateProjectInput = {
  companyRef?: string | null
  name: string
  repoPath: string
  verifyCommand?: string | null
  profileId?: string | null
  profilePath?: string | null
  profile?: Record<string, unknown>
}

type CreateRepositoryInput = {
  projectRef: string
  name: string
  path: string
  remoteUrl?: string | null
  defaultBranch?: string
  role?: RepositoryRole
  profilePath?: string | null
  metadata?: Record<string, unknown>
}

const DEFAULT_RUN_EVENT_DATA_MAX_BYTES = 32 * 1024
const MIN_RUN_EVENT_DATA_MAX_BYTES = 1024
const DEFAULT_RUN_TEXT_MAX_BYTES = 64 * 1024
const MIN_RUN_TEXT_MAX_BYTES = 1024

function runEventDataMaxBytes(override?: number): number {
  if (override !== undefined && Number.isFinite(override) && override >= MIN_RUN_EVENT_DATA_MAX_BYTES) {
    return Math.floor(override)
  }
  const raw = process.env.OPENCLAW_RUN_EVENT_DATA_MAX_BYTES
  if (!raw) return DEFAULT_RUN_EVENT_DATA_MAX_BYTES
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed >= MIN_RUN_EVENT_DATA_MAX_BYTES ? parsed : DEFAULT_RUN_EVENT_DATA_MAX_BYTES
}

function runTextMaxBytes(override?: number): number {
  if (override !== undefined && Number.isFinite(override) && override >= MIN_RUN_TEXT_MAX_BYTES) {
    return Math.floor(override)
  }
  const raw = process.env.OPENCLAW_RUN_TEXT_MAX_BYTES
  if (!raw) return DEFAULT_RUN_TEXT_MAX_BYTES
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed >= MIN_RUN_TEXT_MAX_BYTES ? parsed : DEFAULT_RUN_TEXT_MAX_BYTES
}

function boundRunText(value: string | null | undefined, maxBytes = runTextMaxBytes()): string | null {
  if (value === null || value === undefined) return null
  const originalBytes = Buffer.byteLength(value)
  if (originalBytes <= maxBytes) return value
  const marker = `\n...[truncated middle; originalBytes=${originalBytes}; maxBytes=${maxBytes}]...\n`
  const remainingBytes = Math.max(0, maxBytes - Buffer.byteLength(marker))
  const prefixBytes = Math.floor(remainingBytes / 2)
  const suffixBytes = remainingBytes - prefixBytes

  const sliceWithinBytes = (fromEnd: boolean, byteBudget: number): string => {
    let lower = 0
    let upper = value.length
    while (lower < upper) {
      const midpoint = Math.ceil((lower + upper) / 2)
      const candidate = fromEnd ? value.slice(value.length - midpoint) : value.slice(0, midpoint)
      if (Buffer.byteLength(candidate) <= byteBudget) {
        lower = midpoint
      } else {
        upper = midpoint - 1
      }
    }
    return fromEnd ? value.slice(value.length - lower) : value.slice(0, lower)
  }

  const prefix = sliceWithinBytes(false, prefixBytes)
  const suffix = sliceWithinBytes(true, suffixBytes)
  return prefix + marker + suffix
}

function compactStoredRunMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const telemetry = metadata.telemetry
  if (!telemetry || typeof telemetry !== "object" || Array.isArray(telemetry)) return metadata
  const trace = telemetry as Record<string, unknown>
  if (!("spans" in trace) && !("events" in trace) && !("attributes" in trace)) return metadata
  const originalBytes = Buffer.byteLength(JSON.stringify(trace))
  const compactTelemetry = {
    traceId: trace.traceId,
    rootSpanId: trace.rootSpanId,
    runId: trace.runId,
    startedAt: trace.startedAt,
    finishedAt: trace.finishedAt,
    latencyMs: trace.latencyMs,
    status: trace.status,
    executionPath: trace.executionPath,
    totals: trace.totals,
    spanCount: Array.isArray(trace.spans) ? trace.spans.length : 0,
    eventCount: Array.isArray(trace.events) ? trace.events.length : 0,
    compacted: true,
    originalBytes
  }
  return { ...metadata, telemetry: compactTelemetry }
}

function boundRunEventData(data: Record<string, unknown>, maxBytes = runEventDataMaxBytes()): Record<string, unknown> {
  const serialized = JSON.stringify(data)
  const originalBytes = Buffer.byteLength(serialized)
  if (originalBytes <= maxBytes) return data

  const envelope = {
    truncated: true,
    originalBytes,
    maxBytes,
    preview: ""
  }
  let lower = 0
  let upper = serialized.length
  while (lower < upper) {
    const midpoint = Math.ceil((lower + upper) / 2)
    const candidate = { ...envelope, preview: serialized.slice(0, midpoint) }
    if (Buffer.byteLength(JSON.stringify(candidate)) <= maxBytes) {
      lower = midpoint
    } else {
      upper = midpoint - 1
    }
  }
  return { ...envelope, preview: serialized.slice(0, lower) }
}

type CreateAgentInput = {
  companyRef?: string | null
  name: string
  role: string
  adapterType: AdapterType
  status?: AgentStatus
  model?: string | null
  instructionsPath?: string | null
  command?: string | null
  env?: Record<string, string>
  heartbeatEnabled?: boolean
  heartbeatIntervalSec?: number
  budgetLimit?: number | null
  budgetWindow?: BudgetWindowKind
}

type CreateTaskInput = {
  projectRef: string
  workflowId?: string | null
  goalId?: string | null
  milestoneId?: string | null
  personaRef?: string | null
  stage?: PersonaStage | null
  dependsOnTaskIds?: string[]
  priority?: number
  scheduledAt?: string | null
  source?: TaskSourceKind
  title: string
  description?: string | null
  labels?: string[]
  changedFiles?: string[]
  taskPackage?: TaskPackage | null
  kind?: TaskKind
  parentTaskId?: string | null
  assignedAgentRef?: string | null
  requestedAdapterType?: AdapterType | null
  laneId?: string | null
  allowedPaths?: string[]
  requiredReading?: string[]
  verificationCommands?: string[]
  claimStatus?: TaskClaimStatus
  claimToken?: string | null
  claimExpiresAt?: string | null
  claimOwnerRunId?: string | null
  claimOwnerAgentId?: string | null
  claimedAt?: string | null
  lineageRootId?: string | null
  lineageParentId?: string | null
  taskPackagePath?: string | null
  reviewHandoffPath?: string | null
  artifactDir?: string | null
  reviewRequired?: boolean
  approvalRequired?: boolean
  maxRetries?: number
}

type UpsertBacklogCandidateInput = {
  projectId: string
  status?: BacklogCandidateStatus
  title: string
  description: string
  valueScore: number
  riskScore: number
  effortEstimate: BacklogEffortEstimate
  recommendedPersona?: string | null
  suggestedAdapter?: AdapterType | null
  verificationCommand?: string | null
  dependencies?: string[]
  reason: string
  dedupeKey: string
  sourceSignals?: string[]
  labels?: string[]
  changedFiles?: string[]
  duplicateOf?: string | null
}

export type RuntimeStateBackupResult = {
  sourcePath: string
  backupPath: string
  createdAt: string
}

export type RuntimeActivityCompactionResult = {
  backup: RuntimeStateBackupResult | null
  dryRun: boolean
  vacuumed: boolean
  removed: {
    runEvents: number
    taskEvents: number
    plannerEvents: number
  }
  boundedRunEvents: number
  boundedTaskEvents: number
  maxRunEventBytes: number
  boundedRunTextFields: number
  maxRunTextBytes: number
  compactedRunMetadata: number
  before: {
    pageCount: number
    freelistCount: number
  }
  after: {
    pageCount: number
    freelistCount: number
  }
}

export type RuntimeActivityCompactionOptions = {
  dryRun?: boolean
  backup?: boolean
  vacuum?: boolean
  maxRunEventBytes?: number
  maxRunTextBytes?: number
}

export type ExecutionWorkspaceQuarantineResult = {
  projectId: string
  worktreePath: string | null
  pausedAutomations: number
  cancelledRuns: number
  requeuedTasks: number
}

type RunCompletionInput = {
  status: RunStatus
  sessionDisplayId?: string | null
  responseText?: string | null
  errorText?: string | null
  usage?: AdapterUsage | null
  branchName?: string | null
  prNumber?: number | null
  headSha?: string | null
  verificationSummary?: string | null
  reviewVerdict?: ReviewVerdict | null
  promotionRecordId?: string | null
  costCents?: number | null
  retryClass?: RunRetryClass
}

type StartTeamAssignmentInput = {
  artifactPaths: string[]
  routingReason: string
  routingDecision?: Record<string, unknown>
}

type CreateDirectorDecisionInput = {
  companyId: string
  projectId: string
  profileId?: string | null
  cycleId: string
  passIndex: number
  action: DirectorDecisionAction
  status?: DirectorDecisionStatus
  dryRun?: boolean
  reason: string
  stopReason?: DirectorStopReason | null
  riskScore: number
  riskThreshold: number
  quotaUsed: number
  quotaLimit: number
  loopLimit: number
  input: Record<string, unknown>
  result?: Record<string, unknown> | null
}

type CompleteDirectorDecisionInput = {
  status: DirectorDecisionStatus
  stopReason?: DirectorStopReason | null
  result?: Record<string, unknown> | null
}

export type InterpretedCommandStatus =
  | "planned"
  | "dry_run"
  | "executed"
  | "blocked"
  | "clarification_required"
  | "failed"

export type InterpretedCommandRecord = {
  id: string
  companyId: string | null
  projectId: string | null
  utterance: string
  intent: string
  status: InterpretedCommandStatus
  dryRun: boolean
  yes: boolean
  structured: Record<string, unknown>
  result: Record<string, unknown> | null
  createdAt: string
  updatedAt: string
}

type CreateInterpretedCommandInput = {
  companyId?: string | null
  projectId?: string | null
  utterance: string
  intent: string
  status: InterpretedCommandStatus
  dryRun?: boolean
  yes?: boolean
  structured: Record<string, unknown>
  result?: Record<string, unknown> | null
}

type UpdateInterpretedCommandInput = {
  status: InterpretedCommandStatus
  result?: Record<string, unknown> | null
}

type CreateHandoffInput = HandoffDraft & {
  projectRef: string
  artifactPath?: string | null
}

type AcceptHandoffInput = {
  targetTaskId?: string | null
  acceptedBy?: string | null
  status?: HandoffStatus
}

type CreatePersonaInput = {
  companyRef?: string | null
  name: string
  stage: PersonaStage
  ownedLanes?: string[]
  preferredAdapterType: AdapterType
  instructionsPath?: string | null
  status?: PersonaStatus
  budgetLimit?: number | null
  budgetWindow?: BudgetWindowKind
}

type UpdatePersonaInput = {
  name?: string
  stage?: PersonaStage
  ownedLanes?: string[]
  preferredAdapterType?: AdapterType
  instructionsPath?: string | null
  status?: PersonaStatus
  budgetLimit?: number | null
  budgetWindow?: BudgetWindowKind
}

type CreateWorkflowInput = {
  projectRef: string
  title: string
  description?: string | null
  status?: WorkflowStatus
  rootTaskId?: string | null
  sourceProfileId?: string | null
  sourceProjectVersion?: string | null
  orchestraKind?: OrchestraKind
}

type UpdateWorkflowInput = {
  title?: string
  description?: string | null
  status?: WorkflowStatus
  rootTaskId?: string | null
  sourceProfileId?: string | null
  sourceProjectVersion?: string | null
  orchestraKind?: OrchestraKind
  completedAt?: string | null
}

type CreateTaskSourceInput = {
  companyRef?: string | null
  projectRef?: string | null
  name: string
  kind: TaskSourceKind
  status?: TaskSourceStatus
  config?: Record<string, unknown>
}

type UpdateTaskInput = {
  workflowId?: string | null
  goalId?: string | null
  milestoneId?: string | null
  parentTaskId?: string | null
  dependsOnTaskIds?: string[]
  personaId?: string | null
  stage?: PersonaStage | null
  title?: string
  description?: string | null
  labels?: string[]
  changedFiles?: string[]
  taskPackage?: TaskPackage | null
  kind?: TaskKind
  priority?: number
  scheduledAt?: string | null
  source?: TaskSourceKind
  assignedAgentId?: string | null
  requestedAdapterType?: AdapterType | null
  laneId?: string | null
  allowedPaths?: string[]
  requiredReading?: string[]
  verificationCommands?: string[]
  claimStatus?: TaskClaimStatus
  claimToken?: string | null
  claimExpiresAt?: string | null
  claimOwnerRunId?: string | null
  claimOwnerAgentId?: string | null
  claimedAt?: string | null
  lineageRootId?: string | null
  lineageParentId?: string | null
  taskPackagePath?: string | null
  reviewHandoffPath?: string | null
  artifactDir?: string | null
  reviewRequired?: boolean
  approvalRequired?: boolean
  retryCount?: number
  maxRetries?: number
  lastError?: string | null
  blockedReason?: string | null
  lastRecoveryAt?: string | null
  lastRecoveryReason?: string | null
  completedAt?: string | null
}

type UpdateProjectInput = {
  name?: string
  repoPath?: string
  verifyCommand?: string | null
  profileId?: string | null
  profilePath?: string | null
  profile?: Record<string, unknown>
}

type CreateProductAreaInput = {
  projectRef: string
  name: string
  description?: string | null
  ownerPersonaRef?: string | null
  status?: ProductAreaStatus
}

type CreateMilestoneInput = {
  projectRef: string
  name: string
  description?: string | null
  status?: MilestoneStatus
  targetDate?: string | null
}

type CreateGoalInput = {
  projectRef: string
  milestoneRef?: string | null
  productAreaRef?: string | null
  title: string
  description?: string | null
  priority?: number
  taskTitles?: string[]
}

type CreateReleaseInput = {
  projectRef: string
  milestoneRef?: string | null
  name: string
  version?: string | null
  status?: ReleaseStatus
  releasedAt?: string | null
  notes?: string | null
}

type UpdateAgentInput = {
  role?: string
  adapterType?: AdapterType
  status?: AgentStatus
  model?: string | null
  instructionsPath?: string | null
  command?: string | null
  env?: Record<string, string>
  heartbeatEnabled?: boolean
  heartbeatIntervalSec?: number
  budgetLimit?: number | null
  budgetWindow?: BudgetWindowKind
  lastHeartbeatAt?: string | null
}

type CreateRoutingRuleInput = {
  name: string
  priority?: number
  targetAdapterType: AdapterType
  matchType?: RoutingMatchType
  patterns?: string[]
  isFallback?: boolean
}

type UpdateRoutingRuleInput = {
  name?: string
  priority?: number
  targetAdapterType?: AdapterType
  matchType?: RoutingMatchType
  patterns?: string[]
  isFallback?: boolean
}

type UpsertJobSpecInput = {
  companyId: string
  projectId: string
  jobId: JobId
  sourcePath: string
  cron: string
  timezone: string
  entryAgent?: string | null
}

type CreatePromotionInput = {
  companyId: string
  projectId: string
  workflowId?: string | null
  taskId: string
  branchName: string
  prNumber?: number | null
  prUrl?: string | null
  headSha?: string | null
  baseBranch?: string
  promotionStatus?: PromotionStatus
  mergeMethod?: MergeMethod
  lastReviewSyncAt?: string | null
  lastChecksSyncAt?: string | null
  retryCount?: number
  lastError?: string | null
  mergedAt?: string | null
}

export type RepairCreationResult =
  | {
      status: "created" | "already_exists"
      task: Task
      originalTask: Task
      failedRun: Run
      attempt: number
      plan: RepairTaskPlan
    }
  | {
      status: "needs_human_review"
      task: null
      originalTask: Task
      failedRun: Run
      attempt: number
      plan: null
    }

type UpdatePromotionInput = {
  branchName?: string
  prNumber?: number | null
  prUrl?: string | null
  headSha?: string | null
  baseBranch?: string
  promotionStatus?: PromotionStatus
  mergeMethod?: MergeMethod
  lastReviewSyncAt?: string | null
  lastChecksSyncAt?: string | null
  retryCount?: number
  lastError?: string | null
  mergedAt?: string | null
}

type CreateReviewResultInput = {
  companyId: string
  projectId: string
  runId: string
  taskId: string
  reviewerRunId?: string | null
  outcome: ReviewOutcome
  summary: string
  findings?: ReviewFinding[]
  severity: ReviewSeverity
  changedFiles?: string[]
  riskLevel: ReviewRiskLevel
  requiredFixes?: string[]
  suggestedRepairPrompt: string
  promotionRecommendation: string
  inspectedDiff?: string | null
  inspectedTaskPrompt?: string | null
  inspectedAcceptanceCriteria?: string | null
  inspectedVerificationOutput?: string | null
  inspectedArchitectureRules?: string | null
}

type UpdateReviewResultInput = {
  repairTaskId?: string | null
  approvedBy?: string | null
  approvedAt?: string | null
}

type CreateAutomationInput = {
  companyRef?: string | null
  projectRef?: string | null
  name: string
  kind: AutomationKind
  cron: string
  nextRunAt?: string | null
  payload?: Record<string, unknown>
  status?: AutomationStatus
}

type UpdateAutomationInput = {
  name?: string
  kind?: AutomationKind
  cron?: string
  nextRunAt?: string | null
  payload?: Record<string, unknown>
  status?: AutomationStatus
  lastRunAt?: string | null
}

type CreatePlannerRunInput = {
  companyId: string
  projectId: string
  automationId?: string | null
  trigger: PlannerRunRecord["trigger"]
  status?: PlannerRunRecord["status"]
  plannerPersonaId?: string | null
  plannerAgentId?: string | null
  adapterType?: AdapterType | null
  snapshotJson?: RepoPlanningSnapshot | null
  outputJson?: PlannerOutputEnvelope | null
  summaryJson?: PlannerRunSummary | null
  errorText?: string | null
  startedAt?: string
  finishedAt?: string | null
}

type UpdatePlannerRunInput = {
  status?: PlannerRunRecord["status"]
  plannerPersonaId?: string | null
  plannerAgentId?: string | null
  adapterType?: AdapterType | null
  snapshotJson?: RepoPlanningSnapshot | null
  outputJson?: PlannerOutputEnvelope | null
  summaryJson?: PlannerRunSummary | null
  errorText?: string | null
  finishedAt?: string | null
}

type UpsertMemoryChunkInput = {
  projectId: string
  layer: MemoryLayer
  sourceKind: MemorySourceKind
  sourceRef: string
  sourcePath?: string | null
  audience: MemoryAudience
  lifecycleStatus?: MemoryLifecycleStatus
  title: string
  content: string
  contentHash: string
  freshnessScore?: number | null
  expiresAt?: string | null
  compactedAt?: string | null
  supersededByChunkId?: string | null
  provenance?: MemoryProvenance
  retention?: MemoryRetentionPolicy
  metadata?: Record<string, unknown>
}

function nowIso(): string {
  return new Date().toISOString()
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback

  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function parseIsoTimestamp(value: string | null | undefined): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function asBoolean(value: number): boolean {
  return value === 1
}

function sqlNullable(value: string | number | null | undefined): SQLInputValue {
  return value ?? null
}

function defaultMemoryRetention(): MemoryRetentionPolicy {
  return {
    preserveDecisionTrace: true,
    preserveRaw: true,
    pinned: false,
    importance: "normal",
    retainUntil: null
  }
}

function defaultMemoryProvenance(recordedAt = ""): MemoryProvenance {
  return {
    sources: [],
    freshness: {
      recordedAt,
      score: null
    },
    derivation: null,
    tags: []
  }
}

function budgetPeriodKey(kind: BudgetWindowKind, at: string): string {
  const date = new Date(at)
  const year = date.getUTCFullYear()
  const month = `${date.getUTCMonth() + 1}`.padStart(2, "0")
  const day = `${date.getUTCDate()}`.padStart(2, "0")
  return kind === "daily" ? `${year}-${month}-${day}` : `${year}-${month}`
}

function normalizeEnv(env: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(env ?? {}).map(([key, value]) => [key.trim(), value]))
}

function normalizePatterns(patterns: string[] | undefined): string[] {
  return Array.from(new Set((patterns ?? []).map((pattern) => pattern.trim()).filter(Boolean)))
}

function normalizeStringArray(values: string[] | undefined): string[] {
  return Array.from(new Set((values ?? []).map((value) => value.trim()).filter(Boolean)))
}

function mapCompany(row: Record<string, unknown>): Company {
  return {
    id: String(row.id),
    name: String(row.name),
    description: row.description ? String(row.description) : null,
    createdAt: String(row.created_at)
  }
}

function mapProject(row: Record<string, unknown>): Project {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    name: String(row.name),
    repoPath: String(row.repo_path),
    verifyCommand: row.verify_command ? String(row.verify_command) : null,
    profileId: row.profile_id ? String(row.profile_id) : null,
    profilePath: row.profile_path ? String(row.profile_path) : null,
    profile: parseJson<Record<string, unknown>>(String(row.profile_json ?? "{}"), {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at || row.created_at)
  }
}

function mapRepository(row: Record<string, unknown>): Repository {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    projectId: String(row.project_id),
    name: String(row.name),
    path: String(row.path),
    remoteUrl: row.remote_url ? String(row.remote_url) : null,
    defaultBranch: String(row.default_branch ?? "main"),
    role: String(row.role ?? "primary") as RepositoryRole,
    profilePath: row.profile_path ? String(row.profile_path) : null,
    metadata: parseJson<Record<string, unknown>>(String(row.metadata_json ?? "{}"), {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  }
}

function mapProductArea(row: Record<string, unknown>): ProductArea {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    projectId: String(row.project_id),
    name: String(row.name),
    description: row.description ? String(row.description) : null,
    ownerPersonaId: row.owner_persona_id ? String(row.owner_persona_id) : null,
    status: String(row.status ?? "active") as ProductAreaStatus,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  }
}

function mapMilestone(row: Record<string, unknown>): Milestone {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    projectId: String(row.project_id),
    name: String(row.name),
    description: row.description ? String(row.description) : null,
    status: String(row.status ?? "planned") as MilestoneStatus,
    targetDate: row.target_date ? String(row.target_date) : null,
    progress: Number(row.progress ?? 0),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    completedAt: row.completed_at ? String(row.completed_at) : null
  }
}

function mapGoal(row: Record<string, unknown>): Goal {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    projectId: String(row.project_id),
    milestoneId: row.milestone_id ? String(row.milestone_id) : null,
    productAreaId: row.product_area_id ? String(row.product_area_id) : null,
    title: String(row.title),
    description: row.description ? String(row.description) : null,
    status: String(row.status ?? "planned") as GoalStatus,
    priority: Number(row.priority ?? 0),
    rootTaskId: row.root_task_id ? String(row.root_task_id) : null,
    taskTree: parseJson<Record<string, unknown>>(String(row.task_tree_json ?? "{}"), {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    completedAt: row.completed_at ? String(row.completed_at) : null
  }
}

function mapRelease(row: Record<string, unknown>): Release {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    projectId: String(row.project_id),
    milestoneId: row.milestone_id ? String(row.milestone_id) : null,
    name: String(row.name),
    version: row.version ? String(row.version) : null,
    status: String(row.status ?? "planned") as ReleaseStatus,
    releasedAt: row.released_at ? String(row.released_at) : null,
    notes: row.notes ? String(row.notes) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  }
}

function mapAgent(row: Record<string, unknown>): Agent {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    name: String(row.name),
    role: String(row.role),
    adapterType: String(row.adapter_type) as AdapterType,
    status: String(row.status) as AgentStatus,
    model: row.model ? String(row.model) : null,
    instructionsPath: row.instructions_path ? String(row.instructions_path) : null,
    command: row.command ? String(row.command) : null,
    env: parseJson<Record<string, string>>(String(row.env_json), {}),
    heartbeatEnabled: asBoolean(Number(row.heartbeat_enabled)),
    heartbeatIntervalSec: Number(row.heartbeat_interval_sec),
    budgetLimit: row.budget_limit === null ? null : Number(row.budget_limit),
    budgetWindow: String(row.budget_window) as BudgetWindowKind,
    lastHeartbeatAt: row.last_heartbeat_at ? String(row.last_heartbeat_at) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  }
}

function mapPersona(row: Record<string, unknown>): Persona {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    name: String(row.name),
    stage: String(row.stage) as PersonaStage,
    ownedLanes: parseJson<string[]>(String(row.owned_lanes_json), []),
    preferredAdapterType: String(row.preferred_adapter_type) as AdapterType,
    instructionsPath: row.instructions_path ? String(row.instructions_path) : null,
    status: String(row.status) as PersonaStatus,
    budgetLimit: row.budget_limit === null ? null : Number(row.budget_limit),
    budgetWindow: String(row.budget_window) as BudgetWindowKind,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  }
}

function mapWorkflow(row: Record<string, unknown>): Workflow {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    projectId: String(row.project_id),
    title: String(row.title),
    description: row.description ? String(row.description) : null,
    status: String(row.status) as WorkflowStatus,
    rootTaskId: row.root_task_id ? String(row.root_task_id) : null,
    sourceProfileId: row.source_profile_id ? String(row.source_profile_id) : null,
    sourceProjectVersion: row.source_project_version ? String(row.source_project_version) : null,
    orchestraKind: String(row.orchestra_kind ?? "generic") as OrchestraKind,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    completedAt: row.completed_at ? String(row.completed_at) : null
  }
}

function mapTaskSource(row: Record<string, unknown>): TaskSource {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    projectId: row.project_id ? String(row.project_id) : null,
    name: String(row.name),
    kind: String(row.kind) as TaskSourceKind,
    status: String(row.status) as TaskSourceStatus,
    config: parseJson<Record<string, unknown>>(String(row.config_json), {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  }
}

function mapTask(row: Record<string, unknown>): Task {
  const rawKind = String(row.kind ?? "user")
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    projectId: String(row.project_id),
    workflowId: row.workflow_id ? String(row.workflow_id) : null,
    goalId: row.goal_id ? String(row.goal_id) : null,
    milestoneId: row.milestone_id ? String(row.milestone_id) : null,
    parentTaskId: row.parent_task_id ? String(row.parent_task_id) : null,
    dependsOnTaskIds: parseJson<string[]>(String(row.depends_on_task_ids_json ?? "[]"), []),
    personaId: row.persona_id ? String(row.persona_id) : null,
    stage: row.stage ? (String(row.stage) as PersonaStage) : null,
    title: String(row.title),
    description: row.description ? String(row.description) : null,
    labels: parseJson<string[]>(String(row.labels_json), []),
    changedFiles: parseJson<string[]>(String(row.changed_files_json), []),
    taskPackage: parseJson<TaskPackage | null>(row.task_package_json ? String(row.task_package_json) : null, null),
    kind: rawKind as TaskKind,
    priority: Number(row.priority ?? 0),
    scheduledAt: row.scheduled_at ? String(row.scheduled_at) : null,
    source: row.source ? (String(row.source) as TaskSourceKind) : "manual",
    status: String(row.status) as TaskStatus,
    assignedAgentId: row.assigned_agent_id ? String(row.assigned_agent_id) : null,
    requestedAdapterType: row.requested_adapter_type ? (String(row.requested_adapter_type) as AdapterType) : null,
    laneId: row.lane_id ? String(row.lane_id) : null,
    allowedPaths: parseJson<string[]>(String(row.allowed_paths_json ?? "[]"), []),
    requiredReading: parseJson<string[]>(String(row.required_reading_json ?? "[]"), []),
    verificationCommands: parseJson<string[]>(String(row.verification_commands_json ?? "[]"), []),
    claimStatus: String(row.claim_status ?? "unclaimed") as TaskClaimStatus,
    claimToken: row.claim_token ? String(row.claim_token) : null,
    claimExpiresAt: row.claim_expires_at ? String(row.claim_expires_at) : null,
    claimOwnerRunId: row.claim_owner_run_id ? String(row.claim_owner_run_id) : null,
    claimOwnerAgentId: row.claim_owner_agent_id ? String(row.claim_owner_agent_id) : null,
    claimedAt: row.claimed_at ? String(row.claimed_at) : null,
    lineageRootId: row.lineage_root_id ? String(row.lineage_root_id) : null,
    lineageParentId: row.lineage_parent_id ? String(row.lineage_parent_id) : null,
    taskPackagePath: row.task_package_path ? String(row.task_package_path) : null,
    reviewHandoffPath: row.review_handoff_path ? String(row.review_handoff_path) : null,
    artifactDir: row.artifact_dir ? String(row.artifact_dir) : null,
    reviewRequired: asBoolean(Number(row.review_required)),
    approvalRequired: asBoolean(Number(row.approval_required)),
    retryCount: Number(row.retry_count),
    maxRetries: Number(row.max_retries),
    lastError: row.last_error ? String(row.last_error) : null,
    blockedReason: row.blocked_reason ? String(row.blocked_reason) : null,
    lastRecoveryAt: row.last_recovery_at ? String(row.last_recovery_at) : null,
    lastRecoveryReason: row.last_recovery_reason ? String(row.last_recovery_reason) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    completedAt: row.completed_at ? String(row.completed_at) : null
  }
}

function mapBacklogCandidate(row: Record<string, unknown>): BacklogCandidate {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    projectId: String(row.project_id),
    status: String(row.status) as BacklogCandidateStatus,
    title: String(row.title),
    description: String(row.description),
    valueScore: Number(row.value_score),
    riskScore: Number(row.risk_score),
    effortEstimate: String(row.effort_estimate) as BacklogEffortEstimate,
    recommendedPersona: row.recommended_persona ? String(row.recommended_persona) : null,
    suggestedAdapter: row.suggested_adapter ? (String(row.suggested_adapter) as AdapterType) : null,
    verificationCommand: row.verification_command ? String(row.verification_command) : null,
    dependencies: parseJson<string[]>(String(row.dependencies_json ?? "[]"), []),
    reason: String(row.reason),
    dedupeKey: String(row.dedupe_key),
    sourceSignals: parseJson<string[]>(String(row.source_signals_json ?? "[]"), []),
    labels: parseJson<string[]>(String(row.labels_json ?? "[]"), []),
    changedFiles: parseJson<string[]>(String(row.changed_files_json ?? "[]"), []),
    acceptedTaskId: row.accepted_task_id ? String(row.accepted_task_id) : null,
    duplicateOf: row.duplicate_of ? String(row.duplicate_of) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  }
}

function mapRun(row: Record<string, unknown>): Run {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    projectId: String(row.project_id),
    taskId: String(row.task_id),
    agentId: row.agent_id ? String(row.agent_id) : null,
    adapterType: row.adapter_type ? (String(row.adapter_type) as AdapterType) : null,
    kind: String(row.kind ?? "user") as TaskKind,
    status: String(row.status) as RunStatus,
    sessionKey: row.session_key ? String(row.session_key) : null,
    sessionDisplayId: row.session_display_id ? String(row.session_display_id) : null,
    responseText: row.response_text ? String(row.response_text) : null,
    errorText: row.error_text ? String(row.error_text) : null,
    usage: parseJson<Record<string, number> | null>(row.usage_json ? String(row.usage_json) : null, null),
    branchName: row.branch_name ? String(row.branch_name) : null,
    prNumber: row.pr_number === null || row.pr_number === undefined ? null : Number(row.pr_number),
    headSha: row.head_sha ? String(row.head_sha) : null,
    verificationSummary: row.verification_summary ? String(row.verification_summary) : null,
    wakeReason: String(row.wake_reason ?? "manual") as WakeReason,
    heartbeatJobId: row.heartbeat_job_id ? (String(row.heartbeat_job_id) as JobId) : null,
    worktreePath: row.worktree_path ? String(row.worktree_path) : null,
    manifestPath: row.manifest_path ? String(row.manifest_path) : null,
    reviewVerdict: row.review_verdict ? (String(row.review_verdict) as ReviewVerdict) : null,
    promotionRecordId: row.promotion_record_id ? String(row.promotion_record_id) : null,
    costCents: row.cost_cents === null || row.cost_cents === undefined ? null : Number(row.cost_cents),
    retryClass: String(row.retry_class ?? "none") as RunRetryClass,
    metadata: parseJson<Record<string, unknown> | null>(row.metadata_json ? String(row.metadata_json) : null, null),
    startedAt: String(row.started_at),
    finishedAt: row.finished_at ? String(row.finished_at) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  }
}

function mapTeamAssignment(row: Record<string, unknown>): TeamAssignment {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    projectId: String(row.project_id),
    taskId: String(row.task_id),
    runId: String(row.run_id),
    agentId: String(row.agent_id),
    status: String(row.status) as TeamAssignmentStatus,
    routingReason: String(row.routing_reason),
    routingDecision: parseJson<Record<string, unknown>>(String(row.routing_decision_json ?? "{}"), {}),
    artifactPaths: parseJson<string[]>(String(row.artifact_paths_json ?? "[]"), []),
    releaseReason: row.release_reason ? String(row.release_reason) : null,
    startedAt: String(row.started_at),
    finishedAt: row.finished_at ? String(row.finished_at) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  }
}

function mapTeamArtifactClaim(row: Record<string, unknown>): TeamArtifactClaim {
  return {
    id: String(row.id),
    assignmentId: String(row.assignment_id),
    companyId: String(row.company_id),
    projectId: String(row.project_id),
    taskId: String(row.task_id),
    runId: String(row.run_id),
    agentId: String(row.agent_id),
    artifactPath: String(row.artifact_path),
    status: String(row.status) as TeamArtifactClaimStatus,
    claimedAt: String(row.claimed_at),
    releasedAt: row.released_at ? String(row.released_at) : null,
    releaseReason: row.release_reason ? String(row.release_reason) : null
  }
}

function mapTeamReviewerLockout(row: Record<string, unknown>): TeamReviewerLockout {
  return {
    id: String(row.id),
    threadId: String(row.thread_id),
    companyId: String(row.company_id),
    projectId: String(row.project_id),
    taskId: String(row.task_id),
    sourceTaskId: String(row.source_task_id),
    sourceRunId: row.source_run_id ? String(row.source_run_id) : null,
    sourceAssignmentId: row.source_assignment_id ? String(row.source_assignment_id) : null,
    lockedAgentId: String(row.locked_agent_id),
    reviewerAgentId: row.reviewer_agent_id ? String(row.reviewer_agent_id) : null,
    reviewerActor: String(row.reviewer_actor),
    artifactPath: String(row.artifact_path),
    reason: String(row.reason),
    status: String(row.status) as TeamReviewerLockoutStatus,
    createdAt: String(row.created_at),
    clearedAt: row.cleared_at ? String(row.cleared_at) : null,
    clearedReason: row.cleared_reason ? String(row.cleared_reason) : null
  }
}

function mapTeamMailboxMessage(row: Record<string, unknown>): TeamMailboxMessage {
  return {
    id: String(row.id),
    threadId: String(row.thread_id),
    companyId: String(row.company_id),
    projectId: String(row.project_id),
    fromAgentId: row.from_agent_id ? String(row.from_agent_id) : null,
    fromActor: String(row.from_actor),
    toAgentId: String(row.to_agent_id),
    kind: String(row.kind) as TeamMailboxMessageKind,
    subject: String(row.subject),
    body: String(row.body),
    taskId: row.task_id ? String(row.task_id) : null,
    artifactPaths: parseJson<string[]>(String(row.artifact_paths_json ?? "[]"), []),
    dedupeKey: row.dedupe_key ? String(row.dedupe_key) : null,
    createdAt: String(row.created_at),
    acknowledgedAt: row.acknowledged_at ? String(row.acknowledged_at) : null
  }
}

function mapAdapterLaneHealth(row: Record<string, unknown>): AdapterLaneHealth {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    adapterType: String(row.adapter_type) as AdapterType,
    laneKey: String(row.lane_key),
    laneLabel: String(row.lane_label),
    status: String(row.status) as AdapterLaneStatus,
    reason: row.reason ? String(row.reason) : null,
    cooldownUntil: row.cooldown_until ? String(row.cooldown_until) : null,
    lastError: row.last_error ? String(row.last_error) : null,
    lastSuccessAt: row.last_success_at ? String(row.last_success_at) : null,
    lastCheckedAt: String(row.last_checked_at),
    metadata: parseJson<Record<string, unknown>>(row.metadata_json ? String(row.metadata_json) : null, {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  }
}

function mapRuntimeLease(row: Record<string, unknown>): RuntimeLease {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    scope: String(row.scope),
    holder: String(row.holder),
    leaseKind: String(row.lease_kind),
    acquiredAt: String(row.acquired_at),
    expiresAt: String(row.expires_at),
    metadata: parseJson<Record<string, unknown>>(row.metadata_json ? String(row.metadata_json) : null, {})
  }
}

function mapRunEvent(row: Record<string, unknown>): RunEvent {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    seq: Number(row.seq),
    level: String(row.level) as RunEvent["level"],
    message: String(row.message),
    data: parseJson<Record<string, unknown> | null>(row.data_json ? String(row.data_json) : null, null),
    createdAt: String(row.created_at)
  }
}

function mapDirectorDecision(row: Record<string, unknown>): DirectorDecisionRecord {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    projectId: String(row.project_id),
    profileId: row.profile_id ? String(row.profile_id) : null,
    cycleId: String(row.cycle_id),
    passIndex: Number(row.pass_index),
    action: String(row.action) as DirectorDecisionAction,
    status: String(row.status) as DirectorDecisionStatus,
    dryRun: asBoolean(Number(row.dry_run)),
    reason: String(row.reason),
    stopReason: row.stop_reason ? (String(row.stop_reason) as DirectorStopReason) : null,
    riskScore: Number(row.risk_score),
    riskThreshold: Number(row.risk_threshold),
    quotaUsed: Number(row.quota_used),
    quotaLimit: Number(row.quota_limit),
    loopLimit: Number(row.loop_limit),
    input: parseJson<Record<string, unknown>>(row.input_json ? String(row.input_json) : null, {}),
    result: parseJson<Record<string, unknown> | null>(row.result_json ? String(row.result_json) : null, null),
    createdAt: String(row.created_at),
    completedAt: row.completed_at ? String(row.completed_at) : null
  }
}

function mapInterpretedCommand(row: Record<string, unknown>): InterpretedCommandRecord {
  return {
    id: String(row.id),
    companyId: row.company_id ? String(row.company_id) : null,
    projectId: row.project_id ? String(row.project_id) : null,
    utterance: String(row.utterance),
    intent: String(row.intent),
    status: String(row.status) as InterpretedCommandStatus,
    dryRun: asBoolean(Number(row.dry_run)),
    yes: asBoolean(Number(row.yes)),
    structured: parseJson<Record<string, unknown>>(row.structured_json ? String(row.structured_json) : null, {}),
    result: parseJson<Record<string, unknown> | null>(row.result_json ? String(row.result_json) : null, null),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  }
}

function mapReviewResult(row: Record<string, unknown>): ReviewResult {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    projectId: String(row.project_id),
    runId: String(row.run_id),
    taskId: String(row.task_id),
    reviewerRunId: row.reviewer_run_id ? String(row.reviewer_run_id) : null,
    outcome: String(row.outcome) as ReviewOutcome,
    summary: String(row.summary),
    findings: parseJson<ReviewFinding[]>(String(row.findings_json ?? "[]"), []),
    severity: String(row.severity) as ReviewSeverity,
    changedFiles: parseJson<string[]>(String(row.changed_files_json ?? "[]"), []),
    riskLevel: String(row.risk_level) as ReviewRiskLevel,
    requiredFixes: parseJson<string[]>(String(row.required_fixes_json ?? "[]"), []),
    suggestedRepairPrompt: String(row.suggested_repair_prompt),
    promotionRecommendation: String(row.promotion_recommendation),
    inspectedDiff: row.inspected_diff ? String(row.inspected_diff) : null,
    inspectedTaskPrompt: row.inspected_task_prompt ? String(row.inspected_task_prompt) : null,
    inspectedAcceptanceCriteria: row.inspected_acceptance_criteria ? String(row.inspected_acceptance_criteria) : null,
    inspectedVerificationOutput: row.inspected_verification_output ? String(row.inspected_verification_output) : null,
    inspectedArchitectureRules: row.inspected_architecture_rules ? String(row.inspected_architecture_rules) : null,
    repairTaskId: row.repair_task_id ? String(row.repair_task_id) : null,
    approvedBy: row.approved_by ? String(row.approved_by) : null,
    approvedAt: row.approved_at ? String(row.approved_at) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  }
}

function mapHandoffRecord(row: Record<string, unknown>): HandoffRecord {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    projectId: String(row.project_id),
    sourcePersona: String(row.source_persona),
    targetPersona: String(row.target_persona),
    sourceTaskId: row.source_task_id ? String(row.source_task_id) : null,
    targetTaskId: row.target_task_id ? String(row.target_task_id) : null,
    artifactPath: String(row.artifact_path),
    status: String(row.status) as HandoffStatus,
    artifact: parseJson<HandoffArtifact>(String(row.artifact_json), {} as HandoffArtifact),
    acceptedAt: row.accepted_at ? String(row.accepted_at) : null,
    acceptedBy: row.accepted_by ? String(row.accepted_by) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  }
}

function mapTaskEvent(row: Record<string, unknown>): TaskEvent {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    kind: String(row.kind),
    message: String(row.message),
    data: parseJson<Record<string, unknown> | null>(row.data_json ? String(row.data_json) : null, null),
    createdAt: String(row.created_at)
  }
}

function mapTaskOutcome(row: Record<string, unknown>): TaskOutcome {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    projectId: String(row.project_id),
    taskId: String(row.task_id),
    runId: row.run_id ? String(row.run_id) : null,
    laneId: row.lane_id ? String(row.lane_id) : null,
    stage: String(row.stage) as OutcomeStage,
    adapterType: row.adapter_type ? (String(row.adapter_type) as AdapterType) : null,
    result: String(row.result) as TaskOutcomeResult,
    reason: row.reason ? String(row.reason) : null,
    verificationPassed:
      row.verification_passed === null || row.verification_passed === undefined
        ? null
        : asBoolean(Number(row.verification_passed)),
    reviewVerdict: row.review_verdict ? (String(row.review_verdict) as ReviewVerdict) : null,
    retryCount: Number(row.retry_count ?? 0),
    turns: row.turns === null || row.turns === undefined ? null : Number(row.turns),
    costCents: row.cost_cents === null || row.cost_cents === undefined ? null : Number(row.cost_cents),
    tokensTotal: row.tokens_total === null || row.tokens_total === undefined ? null : Number(row.tokens_total),
    durationMs: row.duration_ms === null || row.duration_ms === undefined ? null : Number(row.duration_ms),
    reflection: row.reflection ? String(row.reflection) : null,
    metadata: parseJson<Record<string, unknown>>(row.metadata_json ? String(row.metadata_json) : null, {}),
    createdAt: String(row.created_at)
  }
}

function mapPromptVariant(row: Record<string, unknown>): PromptVariant {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    scope: String(row.scope),
    label: String(row.label),
    promptHash: String(row.prompt_hash),
    status: String(row.status) as PromptVariantStatus,
    trials: Number(row.trials ?? 0),
    successes: Number(row.successes ?? 0),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  }
}

function mapSessionState(row: Record<string, unknown>): SessionState {
  return {
    sessionKey: String(row.session_key),
    id: String(row.session_key),
    status: "active", // Default status for current session states
    companyId: String(row.company_id),
    projectId: String(row.project_id),
    taskId: String(row.task_id),
    agentId: String(row.agent_id),
    adapterType: String(row.adapter_type) as AdapterType,
    sessionDisplayId: row.session_display_id ? String(row.session_display_id) : null,
    state: parseJson<Record<string, unknown>>(String(row.state_json), {}),
    updatedAt: String(row.updated_at)
  }
}

function mapMemoryChunk(row: Record<string, unknown>): MemoryChunk {
  const createdAt = String(row.created_at)
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    layer: String(row.layer ?? "run_summaries") as MemoryLayer,
    sourceKind: String(row.source_kind) as MemorySourceKind,
    sourceRef: String(row.source_ref),
    sourcePath: row.source_path ? String(row.source_path) : null,
    audience: String(row.audience) as MemoryAudience,
    lifecycleStatus: String(row.lifecycle_status ?? "ready") as MemoryLifecycleStatus,
    title: String(row.title),
    content: String(row.content),
    contentHash: String(row.content_hash),
    freshnessScore:
      row.freshness_score === null || row.freshness_score === undefined ? null : Number(row.freshness_score),
    expiresAt: row.expires_at ? String(row.expires_at) : null,
    compactedAt: row.compacted_at ? String(row.compacted_at) : null,
    supersededByChunkId: row.superseded_by_chunk_id ? String(row.superseded_by_chunk_id) : null,
    provenance: parseJson<MemoryProvenance>(
      row.provenance_json ? String(row.provenance_json) : null,
      defaultMemoryProvenance(createdAt)
    ),
    retention: parseJson<MemoryRetentionPolicy>(
      row.retention_json ? String(row.retention_json) : null,
      defaultMemoryRetention()
    ),
    metadata: parseJson<Record<string, unknown>>(row.metadata_json ? String(row.metadata_json) : null, {}),
    createdAt,
    updatedAt: String(row.updated_at)
  }
}

function mapMemoryEmbedding(row: Record<string, unknown>): MemoryEmbedding {
  return {
    id: String(row.id),
    chunkId: String(row.chunk_id),
    provider: String(row.provider),
    model: String(row.model),
    dimensions: Number(row.dimensions),
    vector: parseJson<number[]>(String(row.vector_json), []),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  }
}

function mapApprovalRequest(row: Record<string, unknown>): ApprovalRequest {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    taskId: String(row.task_id),
    status: String(row.status) as ApprovalStatus,
    reason: String(row.reason),
    createdAt: String(row.created_at),
    decidedAt: row.decided_at ? String(row.decided_at) : null,
    decidedBy: row.decided_by ? String(row.decided_by) : null,
    notes: row.notes ? String(row.notes) : null
  }
}

function mapJobSpec(row: Record<string, unknown>): JobSpec {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    projectId: String(row.project_id),
    jobId: String(row.job_id) as JobId,
    sourcePath: String(row.source_path),
    cron: String(row.cron),
    timezone: String(row.timezone),
    entryAgent: row.entry_agent ? String(row.entry_agent) : null,
    lastTriggeredAt: row.last_triggered_at ? String(row.last_triggered_at) : null,
    lastResult: row.last_result ? String(row.last_result) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  }
}

function mapJobRun(row: Record<string, unknown>): JobRun {
  return {
    id: String(row.id),
    jobSpecId: String(row.job_spec_id),
    status: String(row.status) as JobRunStatus,
    triggeredAt: String(row.triggered_at),
    completedAt: row.completed_at ? String(row.completed_at) : null,
    resultSummary: row.result_summary ? String(row.result_summary) : null,
    data: parseJson<Record<string, unknown> | null>(row.data_json ? String(row.data_json) : null, null),
    createdAt: String(row.created_at)
  }
}

function mapPromotionRecord(row: Record<string, unknown>): PromotionRecord {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    projectId: String(row.project_id),
    workflowId: row.workflow_id ? String(row.workflow_id) : null,
    taskId: String(row.task_id),
    branchName: String(row.branch_name),
    prNumber: row.pr_number === null || row.pr_number === undefined ? null : Number(row.pr_number),
    prUrl: row.pr_url ? String(row.pr_url) : null,
    headSha: row.head_sha ? String(row.head_sha) : null,
    baseBranch: String(row.base_branch),
    promotionStatus: String(row.promotion_status) as PromotionStatus,
    mergeMethod: String(row.merge_method) as MergeMethod,
    lastReviewSyncAt: row.last_review_sync_at ? String(row.last_review_sync_at) : null,
    lastChecksSyncAt: row.last_checks_sync_at ? String(row.last_checks_sync_at) : null,
    retryCount: Number(row.retry_count),
    lastError: row.last_error ? String(row.last_error) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    mergedAt: row.merged_at ? String(row.merged_at) : null
  }
}

function mapAutomation(row: Record<string, unknown>): Automation {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    projectId: row.project_id ? String(row.project_id) : null,
    name: String(row.name),
    kind: String(row.kind) as AutomationKind,
    status: String(row.status) as AutomationStatus,
    cron: String(row.cron),
    nextRunAt: row.next_run_at ? String(row.next_run_at) : null,
    payload: parseJson<Record<string, unknown>>(String(row.payload_json), {}),
    lastRunAt: row.last_run_at ? String(row.last_run_at) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  }
}

function mapPlannerRun(row: Record<string, unknown>): PlannerRunRecord {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    projectId: String(row.project_id),
    automationId: row.automation_id ? String(row.automation_id) : null,
    trigger: String(row.trigger_kind) as PlannerRunRecord["trigger"],
    status: String(row.status) as PlannerRunRecord["status"],
    plannerPersonaId: row.planner_persona_id ? String(row.planner_persona_id) : null,
    plannerAgentId: row.planner_agent_id ? String(row.planner_agent_id) : null,
    adapterType: row.adapter_type ? (String(row.adapter_type) as AdapterType) : null,
    snapshotJson: parseJson<RepoPlanningSnapshot | null>(row.snapshot_json ? String(row.snapshot_json) : null, null),
    outputJson: parseJson<PlannerOutputEnvelope | null>(row.output_json ? String(row.output_json) : null, null),
    summaryJson: parseJson<PlannerRunSummary | null>(row.summary_json ? String(row.summary_json) : null, null),
    errorText: row.error_text ? String(row.error_text) : null,
    startedAt: String(row.started_at),
    finishedAt: row.finished_at ? String(row.finished_at) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  }
}

function mapPlannerEvent(row: Record<string, unknown>): PlannerEvent {
  return {
    id: String(row.id),
    plannerRunId: String(row.planner_run_id),
    seq: Number(row.seq),
    kind: String(row.kind),
    message: String(row.message),
    data: parseJson<Record<string, unknown> | null>(row.data_json ? String(row.data_json) : null, null),
    createdAt: String(row.created_at)
  }
}

function mapPlannerArtifact(row: Record<string, unknown>): PlannerRunArtifact {
  return {
    plannerRunId: String(row.planner_run_id),
    projectId: String(row.project_id),
    kind: String(row.kind) as PlannerRunArtifact["kind"],
    path: String(row.path),
    createdAt: String(row.created_at)
  }
}

function mapRoutingRule(row: Record<string, unknown>): RoutingRule {
  return {
    id: String(row.id),
    name: String(row.name),
    priority: Number(row.priority),
    targetAdapterType: String(row.target_adapter_type) as AdapterType,
    matchType: String(row.match_type) as RoutingMatchType,
    patterns: parseJson<string[]>(String(row.patterns_json), []),
    isFallback: asBoolean(Number(row.is_fallback)),
    createdAt: String(row.created_at)
  }
}

function mapBudgetWindow(row: Record<string, unknown>): BudgetWindow {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    agentId: String(row.agent_id),
    periodKind: String(row.period_kind) as BudgetWindowKind,
    periodKey: String(row.period_key),
    usageUnits: Number(row.usage_units),
    runCount: Number(row.run_count),
    updatedAt: String(row.updated_at)
  }
}

export class DispatcherStore {
  readonly dbPath: string
  readonly db: DatabaseSync

  constructor(dbPath = DispatcherStore.defaultDbPath()) {
    mkdirSync(dirname(dbPath), { recursive: true })
    this.dbPath = dbPath
    this.db = new DatabaseSync(dbPath)
    this.db.exec("PRAGMA journal_mode = WAL")
    this.db.exec("PRAGMA synchronous = NORMAL")
    this.db.exec("PRAGMA foreign_keys = ON")
    this.db.exec("PRAGMA busy_timeout = 5000")
  }

  static defaultDbPath(cwd = process.cwd()): string {
    return join(cwd, ".openclaw", "dispatcher.db")
  }

  close(): void {
    this.db.close()
  }

  backupRuntimeState(outputPath?: string): RuntimeStateBackupResult {
    const createdAt = nowIso()
    const stamp = createdAt.replace(/[:.]/g, "-")
    const backupPath = outputPath ?? join(dirname(this.dbPath), "backups", `dispatcher-${stamp}.db`)
    mkdirSync(dirname(backupPath), { recursive: true })

    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
    copyFileSync(this.dbPath, backupPath)
    if (!outputPath) {
      pruneRuntimeBackups(dirname(backupPath), "dispatcher-", ".db")
      pruneRuntimeBackups(dirname(this.dbPath), `${basename(this.dbPath)}.backup-`)
    }

    return {
      sourcePath: this.dbPath,
      backupPath,
      createdAt
    }
  }

  compactRuntimeActivity(options: RuntimeActivityCompactionOptions = {}): RuntimeActivityCompactionResult {
    const dryRun = options.dryRun ?? false
    const shouldBackup = options.backup ?? !dryRun
    const shouldVacuum = options.vacuum ?? !dryRun
    const before = this.databasePageStats()
    const backup = shouldBackup ? this.backupRuntimeState() : null
    const maxRunEventBytes = runEventDataMaxBytes(options.maxRunEventBytes)
    const maxRunTextBytes = runTextMaxBytes(options.maxRunTextBytes)

    const candidates = this.findDuplicateActivityRows()
    const duplicateRunEventRows = new Set(candidates.runEvents)
    const oversizedRunEvents = this.findOversizedRunEventRows(maxRunEventBytes).filter(
      (row) => !duplicateRunEventRows.has(row.rowId)
    )
    const duplicateTaskEventRows = new Set(candidates.taskEvents)
    const oversizedTaskEvents = this.findOversizedTaskEventRows(maxRunEventBytes).filter(
      (row) => !duplicateTaskEventRows.has(row.rowId)
    )
    const oversizedRunTextFields = this.findOversizedRunTextFields(maxRunTextBytes)
    const compactableRunMetadata = this.findCompactableRunMetadataRows()
    const removed = {
      runEvents: candidates.runEvents.length,
      taskEvents: candidates.taskEvents.length,
      plannerEvents: candidates.plannerEvents.length
    }

    if (!dryRun) {
      this.transaction(() => {
        this.deleteRowsByRowId("run_events", candidates.runEvents)
        this.deleteRowsByRowId("task_events", candidates.taskEvents)
        this.deleteRowsByRowId("planner_events", candidates.plannerEvents)
        this.boundOversizedRunEventRows(oversizedRunEvents, maxRunEventBytes)
        this.boundOversizedTaskEventRows(oversizedTaskEvents, maxRunEventBytes)
        this.boundOversizedRunTextFields(oversizedRunTextFields, maxRunTextBytes)
        this.compactRunMetadataRows(compactableRunMetadata)
      })
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
      if (shouldVacuum) {
        this.db.exec("VACUUM")
      }
    }

    const after = dryRun ? before : this.databasePageStats()

    return {
      backup,
      dryRun,
      vacuumed: !dryRun && shouldVacuum,
      removed,
      boundedRunEvents: oversizedRunEvents.length,
      boundedTaskEvents: oversizedTaskEvents.length,
      maxRunEventBytes,
      boundedRunTextFields: oversizedRunTextFields.length,
      maxRunTextBytes,
      compactedRunMetadata: compactableRunMetadata.length,
      before,
      after
    }
  }

  quarantineExecutionWorkspace(input: {
    projectRef: string
    worktreePath?: string | null
  }): ExecutionWorkspaceQuarantineResult {
    const project = this.resolveProject(input.projectRef)
    const worktreePath = input.worktreePath ?? null
    const now = nowIso()

    return this.transaction(() => {
      const runningRunRows = (
        worktreePath
          ? this.db
              .prepare("SELECT id FROM runs WHERE project_id = ? AND status = 'running' AND worktree_path = ?")
              .all(project.id, worktreePath)
          : this.db.prepare("SELECT id FROM runs WHERE project_id = ? AND status = 'running'").all(project.id)
      ) as Array<{ id: string }>
      const pausedAutomations = this.db
        .prepare("UPDATE automations SET status = 'paused', updated_at = ? WHERE project_id = ? AND status = 'active'")
        .run(now, project.id).changes

      const runningRunsQuery = worktreePath
        ? this.db.prepare(
            "UPDATE runs SET status = 'cancelled', error_text = ?, finished_at = ?, updated_at = ? WHERE project_id = ? AND status = 'running' AND worktree_path = ?"
          )
        : this.db.prepare(
            "UPDATE runs SET status = 'cancelled', error_text = ?, finished_at = ?, updated_at = ? WHERE project_id = ? AND status = 'running'"
          )
      const cancelledRuns = worktreePath
        ? runningRunsQuery.run("execution workspace quarantined", now, now, project.id, worktreePath).changes
        : runningRunsQuery.run("execution workspace quarantined", now, now, project.id).changes

      for (const row of runningRunRows) {
        this.releaseTeamAssignmentForRunUnsafe(String(row.id), "cancelled", "workspace_quarantine", now)
      }

      const runningTasks = this.db
        .prepare(
          `
          UPDATE tasks
          SET
            status = 'queued',
            claim_status = 'expired',
            claim_token = NULL,
            claim_expires_at = NULL,
            claim_owner_run_id = NULL,
            claim_owner_agent_id = NULL,
            blocked_reason = NULL,
            last_error = NULL,
            last_recovery_at = ?,
            last_recovery_reason = 'workspace_quarantine',
            updated_at = ?
          WHERE project_id = ? AND status = 'running'
          `
        )
        .run(now, now, project.id).changes

      return {
        projectId: project.id,
        worktreePath,
        pausedAutomations: Number(pausedAutomations),
        cancelledRuns: Number(cancelledRuns),
        requeuedTasks: Number(runningTasks)
      }
    })
  }

  migrate(): void {
    this.db.exec(SCHEMA_SQL)
    this.ensureColumn("projects", "profile_id", "TEXT")
    this.ensureColumn("projects", "profile_path", "TEXT")
    this.ensureColumn("projects", "profile_json", "TEXT NOT NULL DEFAULT '{}'")
    this.ensureColumn("projects", "updated_at", "TEXT NOT NULL DEFAULT ''")
    this.ensureColumn("tasks", "task_package_json", "TEXT")
    this.ensureColumn("tasks", "kind", "TEXT NOT NULL DEFAULT 'user'")
    this.ensureColumn("tasks", "parent_task_id", "TEXT")
    this.ensureColumn("tasks", "workflow_id", "TEXT")
    this.ensureColumn("tasks", "goal_id", "TEXT")
    this.ensureColumn("tasks", "milestone_id", "TEXT")
    this.ensureColumn("tasks", "depends_on_task_ids_json", "TEXT NOT NULL DEFAULT '[]'")
    this.ensureColumn("tasks", "persona_id", "TEXT")
    this.ensureColumn("tasks", "stage", "TEXT")
    this.ensureColumn("tasks", "priority", "INTEGER NOT NULL DEFAULT 0")
    this.ensureColumn("tasks", "scheduled_at", "TEXT")
    this.ensureColumn("tasks", "source", "TEXT NOT NULL DEFAULT 'manual'")
    this.ensureColumn("tasks", "lane_id", "TEXT")
    this.ensureColumn("tasks", "allowed_paths_json", "TEXT NOT NULL DEFAULT '[]'")
    this.ensureColumn("tasks", "required_reading_json", "TEXT NOT NULL DEFAULT '[]'")
    this.ensureColumn("tasks", "verification_commands_json", "TEXT NOT NULL DEFAULT '[]'")
    this.ensureColumn("tasks", "claim_status", "TEXT NOT NULL DEFAULT 'unclaimed'")
    this.ensureColumn("tasks", "claim_token", "TEXT")
    this.ensureColumn("tasks", "claim_expires_at", "TEXT")
    this.ensureColumn("tasks", "claim_owner_run_id", "TEXT")
    this.ensureColumn("tasks", "claim_owner_agent_id", "TEXT")
    this.ensureColumn("tasks", "claimed_at", "TEXT")
    this.ensureColumn("tasks", "lineage_root_id", "TEXT")
    this.ensureColumn("tasks", "lineage_parent_id", "TEXT")
    this.ensureColumn("tasks", "task_package_path", "TEXT")
    this.ensureColumn("tasks", "review_handoff_path", "TEXT")
    this.ensureColumn("tasks", "artifact_dir", "TEXT")
    this.ensureColumn("tasks", "last_recovery_at", "TEXT")
    this.ensureColumn("tasks", "last_recovery_reason", "TEXT")
    this.ensureColumn("runs", "kind", "TEXT NOT NULL DEFAULT 'user'")
    this.ensureColumn("runs", "branch_name", "TEXT")
    this.ensureColumn("runs", "pr_number", "INTEGER")
    this.ensureColumn("runs", "head_sha", "TEXT")
    this.ensureColumn("runs", "verification_summary", "TEXT")
    this.ensureColumn("runs", "wake_reason", "TEXT NOT NULL DEFAULT 'manual'")
    this.ensureColumn("runs", "heartbeat_job_id", "TEXT")
    this.ensureColumn("runs", "worktree_path", "TEXT")
    this.ensureColumn("runs", "manifest_path", "TEXT")
    this.ensureColumn("runs", "review_verdict", "TEXT")
    this.ensureColumn("runs", "promotion_record_id", "TEXT")
    this.ensureColumn("runs", "cost_cents", "INTEGER")
    this.ensureColumn("runs", "retry_class", "TEXT NOT NULL DEFAULT 'none'")
    this.ensureColumn("runs", "metadata_json", "TEXT")
    this.ensureColumn("workflows", "source_profile_id", "TEXT")
    this.ensureColumn("workflows", "source_project_version", "TEXT")
    this.ensureColumn("workflows", "orchestra_kind", "TEXT NOT NULL DEFAULT 'generic'")
    this.ensureColumn("memory_chunks", "layer", "TEXT NOT NULL DEFAULT 'run_summaries'")
    this.ensureColumn("memory_chunks", "lifecycle_status", "TEXT NOT NULL DEFAULT 'ready'")
    this.ensureColumn("memory_chunks", "freshness_score", "REAL")
    this.ensureColumn("memory_chunks", "expires_at", "TEXT")
    this.ensureColumn("memory_chunks", "compacted_at", "TEXT")
    this.ensureColumn("memory_chunks", "superseded_by_chunk_id", "TEXT")
    this.ensureColumn(
      "memory_chunks",
      "provenance_json",
      `TEXT NOT NULL DEFAULT '{"sources":[],"freshness":{"recordedAt":"","score":null}}'`
    )
    this.ensureColumn(
      "memory_chunks",
      "retention_json",
      `TEXT NOT NULL DEFAULT '{"preserveDecisionTrace":true,"preserveRaw":true,"pinned":false,"importance":"normal"}'`
    )
    this.backfillProjectUpdatedAt()
    this.backfillPrimaryRepositories()
    this.seedDefaultRoutingRules()
  }

  private backfillProjectUpdatedAt(): void {
    this.db.prepare("UPDATE projects SET updated_at = created_at WHERE updated_at = '' OR updated_at IS NULL").run()
  }

  private backfillPrimaryRepositories(): void {
    const rows = this.db
      .prepare(
        `
        SELECT p.*
        FROM projects p
        WHERE NOT EXISTS (
          SELECT 1 FROM repositories r WHERE r.project_id = p.id AND r.role = 'primary'
        )
        `
      )
      .all() as Array<Record<string, unknown>>

    for (const row of rows) {
      const createdAt = String(row.created_at)
      this.db
        .prepare(
          `
          INSERT INTO repositories (
            id, company_id, project_id, name, path, remote_url, default_branch, role, profile_path, metadata_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
        )
        .run(
          randomUUID(),
          String(row.company_id),
          String(row.id),
          String(row.name),
          String(row.repo_path),
          null,
          "main",
          "primary",
          row.profile_path ? String(row.profile_path) : null,
          "{}",
          createdAt,
          String(row.updated_at || row.created_at)
        )
    }
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>
    const hasColumn = rows.some((row) => String(row.name) === column)
    if (!hasColumn) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
    }
  }

  private databasePageStats(): { pageCount: number; freelistCount: number } {
    const pageCount = this.db.prepare("PRAGMA page_count").get() as { page_count: number }
    const freelistCount = this.db.prepare("PRAGMA freelist_count").get() as { freelist_count: number }
    return {
      pageCount: Number(pageCount.page_count),
      freelistCount: Number(freelistCount.freelist_count)
    }
  }

  private findDuplicateActivityRows(): {
    runEvents: number[]
    taskEvents: number[]
    plannerEvents: number[]
  } {
    const runEvents = this.db
      .prepare(
        `
        SELECT rowid
        FROM (
          SELECT
            rowid,
            LAG(level) OVER (PARTITION BY run_id ORDER BY seq, created_at, rowid) AS previous_level,
            LAG(message) OVER (PARTITION BY run_id ORDER BY seq, created_at, rowid) AS previous_message,
            LAG(COALESCE(data_json, '')) OVER (PARTITION BY run_id ORDER BY seq, created_at, rowid) AS previous_data_json,
            level,
            message,
            COALESCE(data_json, '') AS data_json
          FROM run_events
        )
        WHERE level = previous_level
          AND message = previous_message
          AND data_json = previous_data_json
        `
      )
      .all()
      .map((row) => Number((row as { rowid: number }).rowid))
    const taskEvents = this.db
      .prepare(
        `
        SELECT rowid
        FROM (
          SELECT
            rowid,
            LAG(kind) OVER (PARTITION BY task_id ORDER BY created_at, rowid) AS previous_kind,
            LAG(message) OVER (PARTITION BY task_id ORDER BY created_at, rowid) AS previous_message,
            LAG(COALESCE(data_json, '')) OVER (PARTITION BY task_id ORDER BY created_at, rowid) AS previous_data_json,
            kind,
            message,
            COALESCE(data_json, '') AS data_json
          FROM task_events
        )
        WHERE kind = previous_kind
          AND message = previous_message
          AND data_json = previous_data_json
        `
      )
      .all()
      .map((row) => Number((row as { rowid: number }).rowid))
    const plannerEvents = this.db
      .prepare(
        `
        SELECT rowid
        FROM (
          SELECT
            rowid,
            LAG(kind) OVER (PARTITION BY planner_run_id ORDER BY seq, created_at, rowid) AS previous_kind,
            LAG(message) OVER (PARTITION BY planner_run_id ORDER BY seq, created_at, rowid) AS previous_message,
            LAG(COALESCE(data_json, '')) OVER (PARTITION BY planner_run_id ORDER BY seq, created_at, rowid) AS previous_data_json,
            kind,
            message,
            COALESCE(data_json, '') AS data_json
          FROM planner_events
        )
        WHERE kind = previous_kind
          AND message = previous_message
          AND data_json = previous_data_json
        `
      )
      .all()
      .map((row) => Number((row as { rowid: number }).rowid))

    return { runEvents, taskEvents, plannerEvents }
  }

  private deleteRowsByRowId(table: "run_events" | "task_events" | "planner_events", rowIds: number[]): void {
    if (rowIds.length === 0) return
    const statement = this.db.prepare(`DELETE FROM ${table} WHERE rowid = ?`)
    for (const rowId of rowIds) {
      statement.run(rowId)
    }
  }

  private findOversizedRunEventRows(maxBytes: number): Array<{ rowId: number; dataJson: string }> {
    return this.db
      .prepare(
        "SELECT rowid, data_json FROM run_events WHERE data_json IS NOT NULL AND LENGTH(CAST(data_json AS BLOB)) > ?"
      )
      .all(maxBytes)
      .map((row) => ({
        rowId: Number((row as { rowid: number }).rowid),
        dataJson: String((row as { data_json: string }).data_json)
      }))
  }

  private boundOversizedRunEventRows(rows: Array<{ rowId: number; dataJson: string }>, maxBytes: number): void {
    if (rows.length === 0) return
    const statement = this.db.prepare("UPDATE run_events SET data_json = ? WHERE rowid = ?")
    for (const row of rows) {
      const parsed = parseJson<Record<string, unknown>>(row.dataJson, { payload: row.dataJson })
      statement.run(JSON.stringify(boundRunEventData(parsed, maxBytes)), row.rowId)
    }
  }

  private findOversizedTaskEventRows(maxBytes: number): Array<{ rowId: number; dataJson: string }> {
    return this.db
      .prepare(
        "SELECT rowid, data_json FROM task_events WHERE data_json IS NOT NULL AND LENGTH(CAST(data_json AS BLOB)) > ?"
      )
      .all(maxBytes)
      .map((row) => ({
        rowId: Number((row as { rowid: number }).rowid),
        dataJson: String((row as { data_json: string }).data_json)
      }))
  }

  private boundOversizedTaskEventRows(rows: Array<{ rowId: number; dataJson: string }>, maxBytes: number): void {
    if (rows.length === 0) return
    const statement = this.db.prepare("UPDATE task_events SET data_json = ? WHERE rowid = ?")
    for (const row of rows) {
      const parsed = parseJson<Record<string, unknown>>(row.dataJson, { payload: row.dataJson })
      statement.run(JSON.stringify(boundRunEventData(parsed, maxBytes)), row.rowId)
    }
  }

  private findOversizedRunTextFields(
    maxBytes: number
  ): Array<{ rowId: number; column: "response_text" | "error_text" | "verification_summary"; value: string }> {
    const rows = this.db
      .prepare(
        `SELECT rowid, response_text, error_text, verification_summary
         FROM runs
         WHERE LENGTH(CAST(response_text AS BLOB)) > ?
            OR LENGTH(CAST(error_text AS BLOB)) > ?
            OR LENGTH(CAST(verification_summary AS BLOB)) > ?`
      )
      .all(maxBytes, maxBytes, maxBytes)
    const fields: Array<{
      rowId: number
      column: "response_text" | "error_text" | "verification_summary"
      value: string
    }> = []
    for (const row of rows) {
      const record = row as Record<string, unknown>
      for (const column of ["response_text", "error_text", "verification_summary"] as const) {
        const value = record[column]
        if (typeof value === "string" && Buffer.byteLength(value) > maxBytes) {
          fields.push({ rowId: Number(record.rowid), column, value })
        }
      }
    }
    return fields
  }

  private boundOversizedRunTextFields(
    fields: Array<{
      rowId: number
      column: "response_text" | "error_text" | "verification_summary"
      value: string
    }>,
    maxBytes: number
  ): void {
    const statements = {
      response_text: this.db.prepare("UPDATE runs SET response_text = ? WHERE rowid = ?"),
      error_text: this.db.prepare("UPDATE runs SET error_text = ? WHERE rowid = ?"),
      verification_summary: this.db.prepare("UPDATE runs SET verification_summary = ? WHERE rowid = ?")
    }
    for (const field of fields) {
      statements[field.column].run(boundRunText(field.value, maxBytes), field.rowId)
    }
  }

  private findCompactableRunMetadataRows(): Array<{ rowId: number; metadataJson: string }> {
    const rows = this.db.prepare("SELECT rowid, metadata_json FROM runs WHERE metadata_json IS NOT NULL").all()
    const compactable: Array<{ rowId: number; metadataJson: string }> = []
    for (const row of rows) {
      const record = row as Record<string, unknown>
      const metadataJson = String(record.metadata_json)
      const metadata = parseJson<Record<string, unknown>>(metadataJson, {})
      const compacted = JSON.stringify(compactStoredRunMetadata(metadata))
      if (compacted !== metadataJson && Buffer.byteLength(compacted) < Buffer.byteLength(metadataJson)) {
        compactable.push({ rowId: Number(record.rowid), metadataJson: compacted })
      }
    }
    return compactable
  }

  private compactRunMetadataRows(rows: Array<{ rowId: number; metadataJson: string }>): void {
    if (rows.length === 0) return
    const statement = this.db.prepare("UPDATE runs SET metadata_json = ? WHERE rowid = ?")
    for (const row of rows) {
      statement.run(row.metadataJson, row.rowId)
    }
  }

  private transaction<T>(callback: () => T): T {
    this.db.exec("BEGIN IMMEDIATE")
    try {
      const result = callback()
      this.db.exec("COMMIT")
      return result
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }

  listCompanies(): Company[] {
    return this.db
      .prepare("SELECT * FROM companies ORDER BY created_at ASC")
      .all()
      .map((row) => mapCompany(row as Record<string, unknown>))
  }

  createCompany(input: CreateCompanyInput): Company {
    const id = randomUUID()
    const createdAt = nowIso()

    this.db
      .prepare(
        `
      INSERT INTO companies (id, name, description, created_at)
      VALUES (?, ?, ?, ?)
      `
      )
      .run(id, input.name, input.description ?? null, createdAt)

    return this.getCompanyById(id)
  }

  getCompanyById(id: string): Company {
    const row = this.db.prepare("SELECT * FROM companies WHERE id = ?").get(id)
    if (!row) {
      throw new Error(`Company not found: ${id}`)
    }

    return mapCompany(row as Record<string, unknown>)
  }

  resolveCompany(ref?: string | null): Company {
    if (ref) {
      const row = this.db
        .prepare("SELECT * FROM companies WHERE id = ? OR name = ? ORDER BY created_at ASC LIMIT 1")
        .get(ref, ref)
      if (!row) throw new Error(`Company not found: ${ref}`)
      return mapCompany(row as Record<string, unknown>)
    }

    const companies = this.listCompanies()
    if (companies.length === 1) return companies[0]!
    if (companies.length === 0) throw new Error("No companies exist yet. Run `dispatcher company create` first.")
    throw new Error("Multiple companies exist. Pass --company to disambiguate.")
  }

  listProjects(companyId?: string): Project[] {
    const query = companyId
      ? this.db.prepare("SELECT * FROM projects WHERE company_id = ? ORDER BY created_at ASC")
      : this.db.prepare("SELECT * FROM projects ORDER BY created_at ASC")
    const rows = companyId ? query.all(companyId) : query.all()
    return rows.map((row) => mapProject(row as Record<string, unknown>))
  }

  createProject(input: CreateProjectInput): Project {
    const company = this.resolveCompany(input.companyRef)
    const id = randomUUID()
    const createdAt = nowIso()

    this.transaction(() => {
      this.db
        .prepare(
          `
        INSERT INTO projects (
          id, company_id, name, repo_path, verify_command, profile_id, profile_path, profile_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        )
        .run(
          id,
          company.id,
          input.name,
          input.repoPath,
          input.verifyCommand ?? null,
          input.profileId ?? null,
          input.profilePath ?? null,
          JSON.stringify(input.profile ?? {}),
          createdAt,
          createdAt
        )

      this.db
        .prepare(
          `
        INSERT INTO repositories (
          id, company_id, project_id, name, path, remote_url, default_branch, role, profile_path, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        )
        .run(
          randomUUID(),
          company.id,
          id,
          input.name,
          input.repoPath,
          null,
          "main",
          "primary",
          input.profilePath ?? null,
          "{}",
          createdAt,
          createdAt
        )
    })

    return this.getProjectById(id)
  }

  getProjectById(id: string): Project {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id)
    if (!row) throw new Error(`Project not found: ${id}`)
    return mapProject(row as Record<string, unknown>)
  }

  resolveProject(ref: string, companyRef?: string | null): Project {
    const company = companyRef ? this.resolveCompany(companyRef) : null
    const query = company
      ? this.db.prepare(
          "SELECT * FROM projects WHERE company_id = ? AND (id = ? OR name = ?) ORDER BY created_at ASC LIMIT 1"
        )
      : this.db.prepare("SELECT * FROM projects WHERE id = ? OR name = ? ORDER BY created_at ASC LIMIT 1")
    const row = company ? query.get(company.id, ref, ref) : query.get(ref, ref)
    if (!row) throw new Error(`Project not found: ${ref}`)
    return mapProject(row as Record<string, unknown>)
  }

  findProjectByRepoPath(repoPath: string, companyId?: string): Project | null {
    const query = companyId
      ? this.db.prepare("SELECT * FROM projects WHERE company_id = ? AND repo_path = ? ORDER BY created_at ASC LIMIT 1")
      : this.db.prepare("SELECT * FROM projects WHERE repo_path = ? ORDER BY created_at ASC LIMIT 1")
    const row = companyId ? query.get(companyId, repoPath) : query.get(repoPath)
    return row ? mapProject(row as Record<string, unknown>) : null
  }

  updateProject(projectId: string, patch: UpdateProjectInput): Project {
    const project = this.getProjectById(projectId)
    const updatedAt = nowIso()
    this.db
      .prepare(
        `
      UPDATE projects
      SET
        name = ?,
        repo_path = ?,
        verify_command = ?,
        profile_id = ?,
        profile_path = ?,
        profile_json = ?,
        updated_at = ?
      WHERE id = ?
      `
      )
      .run(
        patch.name ?? project.name,
        patch.repoPath ?? project.repoPath,
        sqlNullable(patch.verifyCommand === undefined ? project.verifyCommand : patch.verifyCommand),
        sqlNullable(patch.profileId === undefined ? project.profileId : patch.profileId),
        sqlNullable(patch.profilePath === undefined ? project.profilePath : patch.profilePath),
        JSON.stringify(patch.profile === undefined ? (project.profile ?? {}) : patch.profile),
        updatedAt,
        projectId
      )

    return this.getProjectById(projectId)
  }

  listRepositories(projectId?: string): Repository[] {
    const query = projectId
      ? this.db.prepare("SELECT * FROM repositories WHERE project_id = ? ORDER BY role ASC, created_at ASC")
      : this.db.prepare("SELECT * FROM repositories ORDER BY created_at ASC")
    const rows = projectId ? query.all(projectId) : query.all()
    return rows.map((row) => mapRepository(row as Record<string, unknown>))
  }

  createRepository(input: CreateRepositoryInput): Repository {
    const project = this.resolveProject(input.projectRef)
    const id = randomUUID()
    const createdAt = nowIso()
    this.db
      .prepare(
        `
        INSERT INTO repositories (
          id, company_id, project_id, name, path, remote_url, default_branch, role, profile_path, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        id,
        project.companyId,
        project.id,
        input.name,
        input.path,
        input.remoteUrl ?? null,
        input.defaultBranch ?? "main",
        input.role ?? "supporting",
        input.profilePath ?? null,
        JSON.stringify(input.metadata ?? {}),
        createdAt,
        createdAt
      )
    return this.getRepositoryById(id)
  }

  getRepositoryById(id: string): Repository {
    const row = this.db.prepare("SELECT * FROM repositories WHERE id = ?").get(id)
    if (!row) throw new Error(`Repository not found: ${id}`)
    return mapRepository(row as Record<string, unknown>)
  }

  listProductAreas(projectId?: string): ProductArea[] {
    const query = projectId
      ? this.db.prepare("SELECT * FROM product_areas WHERE project_id = ? ORDER BY created_at ASC")
      : this.db.prepare("SELECT * FROM product_areas ORDER BY created_at ASC")
    const rows = projectId ? query.all(projectId) : query.all()
    return rows.map((row) => mapProductArea(row as Record<string, unknown>))
  }

  createProductArea(input: CreateProductAreaInput): ProductArea {
    const project = this.resolveProject(input.projectRef)
    const ownerPersona = input.ownerPersonaRef ? this.resolvePersona(input.ownerPersonaRef, project.companyId) : null
    const id = randomUUID()
    const createdAt = nowIso()
    this.db
      .prepare(
        `
        INSERT INTO product_areas (
          id, company_id, project_id, name, description, owner_persona_id, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        id,
        project.companyId,
        project.id,
        input.name,
        input.description ?? null,
        ownerPersona?.id ?? null,
        input.status ?? "active",
        createdAt,
        createdAt
      )
    return this.getProductAreaById(id)
  }

  getProductAreaById(id: string): ProductArea {
    const row = this.db.prepare("SELECT * FROM product_areas WHERE id = ?").get(id)
    if (!row) throw new Error(`Product area not found: ${id}`)
    return mapProductArea(row as Record<string, unknown>)
  }

  resolveProductArea(ref: string, projectId: string): ProductArea {
    const row = this.db
      .prepare(
        "SELECT * FROM product_areas WHERE project_id = ? AND (id = ? OR name = ?) ORDER BY created_at ASC LIMIT 1"
      )
      .get(projectId, ref, ref)
    if (!row) throw new Error(`Product area not found: ${ref}`)
    return mapProductArea(row as Record<string, unknown>)
  }

  listMilestones(projectId?: string): Milestone[] {
    const query = projectId
      ? this.db.prepare("SELECT * FROM milestones WHERE project_id = ? ORDER BY created_at ASC")
      : this.db.prepare("SELECT * FROM milestones ORDER BY created_at ASC")
    const rows = projectId ? query.all(projectId) : query.all()
    return rows.map((row) => mapMilestone(row as Record<string, unknown>))
  }

  createMilestone(input: CreateMilestoneInput): Milestone {
    const project = this.resolveProject(input.projectRef)
    const id = randomUUID()
    const createdAt = nowIso()
    this.db
      .prepare(
        `
        INSERT INTO milestones (
          id, company_id, project_id, name, description, status, target_date, progress, created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        id,
        project.companyId,
        project.id,
        input.name,
        input.description ?? null,
        input.status ?? "planned",
        input.targetDate ?? null,
        0,
        createdAt,
        createdAt,
        null
      )
    return this.getMilestoneById(id)
  }

  getMilestoneById(id: string): Milestone {
    const row = this.db.prepare("SELECT * FROM milestones WHERE id = ?").get(id)
    if (!row) throw new Error(`Milestone not found: ${id}`)
    return mapMilestone(row as Record<string, unknown>)
  }

  resolveMilestone(ref: string, projectId: string): Milestone {
    const row = this.db
      .prepare("SELECT * FROM milestones WHERE project_id = ? AND (id = ? OR name = ?) ORDER BY created_at ASC LIMIT 1")
      .get(projectId, ref, ref)
    if (!row) throw new Error(`Milestone not found: ${ref}`)
    return mapMilestone(row as Record<string, unknown>)
  }

  listGoals(projectId?: string): Goal[] {
    const query = projectId
      ? this.db.prepare("SELECT * FROM goals WHERE project_id = ? ORDER BY created_at ASC")
      : this.db.prepare("SELECT * FROM goals ORDER BY created_at ASC")
    const rows = projectId ? query.all(projectId) : query.all()
    return rows.map((row) => mapGoal(row as Record<string, unknown>))
  }

  createGoal(input: CreateGoalInput): Goal {
    const project = this.resolveProject(input.projectRef)
    const milestone = input.milestoneRef ? this.resolveMilestone(input.milestoneRef, project.id) : null
    const productArea = input.productAreaRef ? this.resolveProductArea(input.productAreaRef, project.id) : null
    const id = randomUUID()
    const createdAt = nowIso()
    const taskTitles = normalizeStringArray(input.taskTitles)
    const generatedTaskTitles =
      taskTitles.length > 0
        ? taskTitles
        : ["Clarify scope and acceptance criteria", "Implement the goal", "Verify and prepare review"]

    this.transaction(() => {
      this.db
        .prepare(
          `
          INSERT INTO goals (
            id, company_id, project_id, milestone_id, product_area_id, title, description, status, priority, root_task_id, task_tree_json, created_at, updated_at, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
        )
        .run(
          id,
          project.companyId,
          project.id,
          milestone?.id ?? null,
          productArea?.id ?? null,
          input.title,
          input.description ?? null,
          "active",
          input.priority ?? 0,
          null,
          "{}",
          createdAt,
          createdAt,
          null
        )

      const workflow = this.createWorkflow({
        projectRef: project.id,
        title: input.title,
        description: input.description ?? null,
        status: "queued"
      })

      const rootTask = this.createTask({
        projectRef: project.id,
        workflowId: workflow.id,
        goalId: id,
        milestoneId: milestone?.id ?? null,
        title: input.title,
        description: input.description ?? null,
        labels: ["goal", `goal:${id}`],
        kind: "plan",
        priority: input.priority ?? 0
      })

      const childTaskIds: string[] = []
      let previousTaskId = rootTask.id
      for (const [index, taskTitle] of generatedTaskTitles.entries()) {
        const child = this.createTask({
          projectRef: project.id,
          workflowId: workflow.id,
          goalId: id,
          milestoneId: milestone?.id ?? null,
          parentTaskId: rootTask.id,
          dependsOnTaskIds: index === 0 ? [rootTask.id] : [previousTaskId],
          title: taskTitle,
          description: input.description ?? null,
          labels: ["goal-task", `goal:${id}`],
          kind: index === 0 ? "plan" : index === generatedTaskTitles.length - 1 ? "review" : "implement",
          priority: input.priority ?? 0
        })
        childTaskIds.push(child.id)
        previousTaskId = child.id
      }

      const taskTree = {
        rootTaskId: rootTask.id,
        childTaskIds,
        generatedAt: createdAt
      }
      this.db
        .prepare("UPDATE goals SET root_task_id = ?, task_tree_json = ?, updated_at = ? WHERE id = ?")
        .run(rootTask.id, JSON.stringify(taskTree), nowIso(), id)
      this.updateWorkflow(workflow.id, { rootTaskId: rootTask.id })
    })

    return this.getGoalById(id)
  }

  getGoalById(id: string): Goal {
    const row = this.db.prepare("SELECT * FROM goals WHERE id = ?").get(id)
    if (!row) throw new Error(`Goal not found: ${id}`)
    return mapGoal(row as Record<string, unknown>)
  }

  listReleases(projectId?: string): Release[] {
    const query = projectId
      ? this.db.prepare("SELECT * FROM releases WHERE project_id = ? ORDER BY created_at ASC")
      : this.db.prepare("SELECT * FROM releases ORDER BY created_at ASC")
    const rows = projectId ? query.all(projectId) : query.all()
    return rows.map((row) => mapRelease(row as Record<string, unknown>))
  }

  createRelease(input: CreateReleaseInput): Release {
    const project = this.resolveProject(input.projectRef)
    const milestone = input.milestoneRef ? this.resolveMilestone(input.milestoneRef, project.id) : null
    const id = randomUUID()
    const createdAt = nowIso()
    this.db
      .prepare(
        `
        INSERT INTO releases (
          id, company_id, project_id, milestone_id, name, version, status, released_at, notes, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        id,
        project.companyId,
        project.id,
        milestone?.id ?? null,
        input.name,
        input.version ?? null,
        input.status ?? "planned",
        input.releasedAt ?? null,
        input.notes ?? null,
        createdAt,
        createdAt
      )
    return this.getReleaseById(id)
  }

  getReleaseById(id: string): Release {
    const row = this.db.prepare("SELECT * FROM releases WHERE id = ?").get(id)
    if (!row) throw new Error(`Release not found: ${id}`)
    return mapRelease(row as Record<string, unknown>)
  }

  listAgents(companyId?: string): Agent[] {
    const query = companyId
      ? this.db.prepare("SELECT * FROM agents WHERE company_id = ? ORDER BY created_at ASC")
      : this.db.prepare("SELECT * FROM agents ORDER BY created_at ASC")
    const rows = companyId ? query.all(companyId) : query.all()
    return rows.map((row) => mapAgent(row as Record<string, unknown>))
  }

  createAgent(input: CreateAgentInput): Agent {
    const company = this.resolveCompany(input.companyRef)
    const id = randomUUID()
    const createdAt = nowIso()

    this.db
      .prepare(
        `
      INSERT INTO agents (
        id,
        company_id,
        name,
        role,
        adapter_type,
        status,
        model,
        instructions_path,
        command,
        env_json,
        heartbeat_enabled,
        heartbeat_interval_sec,
        budget_limit,
        budget_window,
        last_heartbeat_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        id,
        company.id,
        input.name,
        input.role,
        input.adapterType,
        input.status ?? "idle",
        input.model ?? null,
        input.instructionsPath ?? null,
        input.command ?? null,
        JSON.stringify(normalizeEnv(input.env)),
        (input.heartbeatEnabled ?? true) ? 1 : 0,
        input.heartbeatIntervalSec ?? 300,
        input.budgetLimit ?? null,
        input.budgetWindow ?? "monthly",
        null,
        createdAt,
        createdAt
      )

    return this.getAgentById(id)
  }

  getAgentById(id: string): Agent {
    const row = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(id)
    if (!row) throw new Error(`Agent not found: ${id}`)
    return mapAgent(row as Record<string, unknown>)
  }

  resolveAgent(ref: string, companyId?: string): Agent {
    const query = companyId
      ? this.db.prepare(
          "SELECT * FROM agents WHERE company_id = ? AND (id = ? OR name = ?) ORDER BY created_at ASC LIMIT 1"
        )
      : this.db.prepare("SELECT * FROM agents WHERE id = ? OR name = ? ORDER BY created_at ASC LIMIT 1")
    const row = companyId ? query.get(companyId, ref, ref) : query.get(ref, ref)
    if (!row) throw new Error(`Agent not found: ${ref}`)
    return mapAgent(row as Record<string, unknown>)
  }

  setAgentStatus(agentId: string, status: AgentStatus): void {
    this.db.prepare("UPDATE agents SET status = ?, updated_at = ? WHERE id = ?").run(status, nowIso(), agentId)
  }

  updateAgent(agentId: string, patch: UpdateAgentInput): Agent {
    const agent = this.getAgentById(agentId)
    const updatedAt = nowIso()

    this.db
      .prepare(
        `
      UPDATE agents
      SET
        role = ?,
        adapter_type = ?,
        status = ?,
        model = ?,
        instructions_path = ?,
        command = ?,
        env_json = ?,
        heartbeat_enabled = ?,
        heartbeat_interval_sec = ?,
        budget_limit = ?,
        budget_window = ?,
        last_heartbeat_at = ?,
        updated_at = ?
      WHERE id = ?
      `
      )
      .run(
        patch.role ?? agent.role,
        patch.adapterType ?? agent.adapterType,
        patch.status ?? agent.status,
        patch.model === undefined ? agent.model : patch.model,
        patch.instructionsPath === undefined ? agent.instructionsPath : patch.instructionsPath,
        patch.command === undefined ? agent.command : patch.command,
        JSON.stringify(patch.env === undefined ? agent.env : normalizeEnv(patch.env)),
        patch.heartbeatEnabled === undefined ? (agent.heartbeatEnabled ? 1 : 0) : patch.heartbeatEnabled ? 1 : 0,
        patch.heartbeatIntervalSec ?? agent.heartbeatIntervalSec,
        patch.budgetLimit === undefined ? agent.budgetLimit : patch.budgetLimit,
        patch.budgetWindow ?? agent.budgetWindow,
        patch.lastHeartbeatAt === undefined ? agent.lastHeartbeatAt : patch.lastHeartbeatAt,
        updatedAt,
        agentId
      )

    return this.getAgentById(agentId)
  }

  listPersonas(companyId?: string): Persona[] {
    const query = companyId
      ? this.db.prepare("SELECT * FROM personas WHERE company_id = ? ORDER BY created_at ASC")
      : this.db.prepare("SELECT * FROM personas ORDER BY created_at ASC")
    const rows = companyId ? query.all(companyId) : query.all()
    return rows.map((row) => mapPersona(row as Record<string, unknown>))
  }

  createPersona(input: CreatePersonaInput): Persona {
    const company = this.resolveCompany(input.companyRef)
    const id = randomUUID()
    const createdAt = nowIso()

    this.db
      .prepare(
        `
      INSERT INTO personas (
        id,
        company_id,
        name,
        stage,
        owned_lanes_json,
        preferred_adapter_type,
        instructions_path,
        status,
        budget_limit,
        budget_window,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        id,
        company.id,
        input.name,
        input.stage,
        JSON.stringify(normalizeStringArray(input.ownedLanes)),
        input.preferredAdapterType,
        input.instructionsPath ?? null,
        input.status ?? "active",
        input.budgetLimit ?? null,
        input.budgetWindow ?? "monthly",
        createdAt,
        createdAt
      )

    return this.getPersonaById(id)
  }

  upsertPersona(input: CreatePersonaInput): Persona {
    const company = this.resolveCompany(input.companyRef)
    const id = randomUUID()
    const updatedAt = nowIso()

    this.db
      .prepare(
        `
      INSERT INTO personas (
        id,
        company_id,
        name,
        stage,
        owned_lanes_json,
        preferred_adapter_type,
        instructions_path,
        status,
        budget_limit,
        budget_window,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(company_id, name) DO UPDATE SET
        stage = excluded.stage,
        owned_lanes_json = excluded.owned_lanes_json,
        preferred_adapter_type = excluded.preferred_adapter_type,
        instructions_path = excluded.instructions_path,
        status = excluded.status,
        budget_limit = excluded.budget_limit,
        budget_window = excluded.budget_window,
        updated_at = excluded.updated_at
      `
      )
      .run(
        id,
        company.id,
        input.name,
        input.stage,
        JSON.stringify(normalizeStringArray(input.ownedLanes)),
        input.preferredAdapterType,
        input.instructionsPath ?? null,
        input.status ?? "active",
        input.budgetLimit ?? null,
        input.budgetWindow ?? "monthly",
        updatedAt,
        updatedAt
      )

    return this.resolvePersona(input.name, company.id)
  }

  getPersonaById(id: string): Persona {
    const row = this.db.prepare("SELECT * FROM personas WHERE id = ?").get(id)
    if (!row) throw new Error(`Persona not found: ${id}`)
    return mapPersona(row as Record<string, unknown>)
  }

  resolvePersona(ref: string, companyId?: string): Persona {
    const query = companyId
      ? this.db.prepare(
          "SELECT * FROM personas WHERE company_id = ? AND (id = ? OR name = ?) ORDER BY created_at ASC LIMIT 1"
        )
      : this.db.prepare("SELECT * FROM personas WHERE id = ? OR name = ? ORDER BY created_at ASC LIMIT 1")
    const row = companyId ? query.get(companyId, ref, ref) : query.get(ref, ref)
    if (!row) throw new Error(`Persona not found: ${ref}`)
    return mapPersona(row as Record<string, unknown>)
  }

  findPersonaByStage(companyId: string, stage: PersonaStage): Persona | null {
    const row = this.db
      .prepare("SELECT * FROM personas WHERE company_id = ? AND stage = ? ORDER BY created_at ASC LIMIT 1")
      .get(companyId, stage)
    return row ? mapPersona(row as Record<string, unknown>) : null
  }

  updatePersona(personaId: string, patch: UpdatePersonaInput): Persona {
    const persona = this.getPersonaById(personaId)
    this.db
      .prepare(
        `
      UPDATE personas
      SET
        name = ?,
        stage = ?,
        owned_lanes_json = ?,
        preferred_adapter_type = ?,
        instructions_path = ?,
        status = ?,
        budget_limit = ?,
        budget_window = ?,
        updated_at = ?
      WHERE id = ?
      `
      )
      .run(
        patch.name ?? persona.name,
        patch.stage ?? persona.stage,
        JSON.stringify(patch.ownedLanes === undefined ? persona.ownedLanes : normalizeStringArray(patch.ownedLanes)),
        patch.preferredAdapterType ?? persona.preferredAdapterType,
        patch.instructionsPath === undefined ? persona.instructionsPath : patch.instructionsPath,
        patch.status ?? persona.status,
        patch.budgetLimit === undefined ? persona.budgetLimit : patch.budgetLimit,
        patch.budgetWindow ?? persona.budgetWindow,
        nowIso(),
        personaId
      )

    return this.getPersonaById(personaId)
  }

  listWorkflows(companyId?: string): Workflow[] {
    const rows = companyId
      ? this.db.prepare("SELECT * FROM workflows WHERE company_id = ? ORDER BY created_at ASC").all(companyId)
      : this.db.prepare("SELECT * FROM workflows ORDER BY created_at ASC").all()
    return rows.map((row) => mapWorkflow(row as Record<string, unknown>))
  }

  createWorkflow(input: CreateWorkflowInput): Workflow {
    const project = this.resolveProject(input.projectRef)
    const id = randomUUID()
    const createdAt = nowIso()
    this.db
      .prepare(
        `
      INSERT INTO workflows (
        id,
        company_id,
        project_id,
        title,
        description,
        status,
        root_task_id,
        source_profile_id,
        source_project_version,
        orchestra_kind,
        created_at,
        updated_at,
        completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      `
      )
      .run(
        id,
        project.companyId,
        project.id,
        input.title,
        input.description ?? null,
        input.status ?? "queued",
        input.rootTaskId ?? null,
        input.sourceProfileId ?? null,
        input.sourceProjectVersion ?? null,
        input.orchestraKind ?? "generic",
        createdAt,
        createdAt
      )
    return this.getWorkflowById(id)
  }

  getWorkflowById(id: string): Workflow {
    const row = this.db.prepare("SELECT * FROM workflows WHERE id = ?").get(id)
    if (!row) throw new Error(`Workflow not found: ${id}`)
    return mapWorkflow(row as Record<string, unknown>)
  }

  updateWorkflow(workflowId: string, patch: UpdateWorkflowInput): Workflow {
    const workflow = this.getWorkflowById(workflowId)
    const completedAt = patch.completedAt === undefined ? workflow.completedAt : patch.completedAt
    this.db
      .prepare(
        `
      UPDATE workflows
      SET
        title = ?,
        description = ?,
        status = ?,
        root_task_id = ?,
        source_profile_id = ?,
        source_project_version = ?,
        orchestra_kind = ?,
        completed_at = ?,
        updated_at = ?
      WHERE id = ?
      `
      )
      .run(
        patch.title ?? workflow.title,
        patch.description === undefined ? workflow.description : patch.description,
        patch.status ?? workflow.status,
        patch.rootTaskId === undefined ? workflow.rootTaskId : patch.rootTaskId,
        patch.sourceProfileId === undefined ? workflow.sourceProfileId : patch.sourceProfileId,
        patch.sourceProjectVersion === undefined ? workflow.sourceProjectVersion : patch.sourceProjectVersion,
        patch.orchestraKind ?? workflow.orchestraKind,
        completedAt,
        nowIso(),
        workflowId
      )
    return this.getWorkflowById(workflowId)
  }

  listTaskSources(companyId?: string): TaskSource[] {
    const rows = companyId
      ? this.db.prepare("SELECT * FROM task_sources WHERE company_id = ? ORDER BY created_at ASC").all(companyId)
      : this.db.prepare("SELECT * FROM task_sources ORDER BY created_at ASC").all()
    return rows.map((row) => mapTaskSource(row as Record<string, unknown>))
  }

  createTaskSource(input: CreateTaskSourceInput): TaskSource {
    const company = this.resolveCompany(input.companyRef)
    const project = input.projectRef ? this.resolveProject(input.projectRef, company.id) : null
    const id = randomUUID()
    const createdAt = nowIso()
    this.db
      .prepare(
        `
      INSERT INTO task_sources (
        id,
        company_id,
        project_id,
        name,
        kind,
        status,
        config_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        id,
        company.id,
        project?.id ?? null,
        input.name,
        input.kind,
        input.status ?? "active",
        JSON.stringify(input.config ?? {}),
        createdAt,
        createdAt
      )
    return this.getTaskSourceById(id)
  }

  getTaskSourceById(id: string): TaskSource {
    const row = this.db.prepare("SELECT * FROM task_sources WHERE id = ?").get(id)
    if (!row) throw new Error(`Task source not found: ${id}`)
    return mapTaskSource(row as Record<string, unknown>)
  }

  createTask(input: CreateTaskInput): Task {
    const project = this.resolveProject(input.projectRef)
    const assignedAgent = input.assignedAgentRef ? this.resolveAgent(input.assignedAgentRef, project.companyId) : null
    const persona = input.personaRef ? this.resolvePersona(input.personaRef, project.companyId) : null
    const id = randomUUID()
    const createdAt = nowIso()
    const referenceLabels = extractTaskReferenceIdentifiers([input.title, input.description ?? ""].join("\n")).map(
      (identifier) => `ref:${identifier}`
    )
    const labels = Array.from(new Set([...(input.labels ?? []), ...referenceLabels]))

    this.db
      .prepare(
        `
      INSERT INTO tasks (
        id,
        company_id,
        project_id,
        workflow_id,
        goal_id,
        milestone_id,
        parent_task_id,
        depends_on_task_ids_json,
        persona_id,
        stage,
        kind,
        priority,
        scheduled_at,
        source,
        title,
        description,
        labels_json,
        changed_files_json,
        task_package_json,
        status,
        assigned_agent_id,
        requested_adapter_type,
        lane_id,
        allowed_paths_json,
        required_reading_json,
        verification_commands_json,
        claim_status,
        claim_token,
        claim_expires_at,
        claim_owner_run_id,
        claim_owner_agent_id,
        claimed_at,
        lineage_root_id,
        lineage_parent_id,
        task_package_path,
        review_handoff_path,
        artifact_dir,
        review_required,
        approval_required,
        retry_count,
        max_retries,
        last_error,
        blocked_reason,
        last_recovery_at,
        last_recovery_reason,
        created_at,
        updated_at,
        completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        id,
        project.companyId,
        project.id,
        input.workflowId ?? null,
        input.goalId ?? null,
        input.milestoneId ?? null,
        input.parentTaskId ?? null,
        JSON.stringify(normalizeStringArray(input.dependsOnTaskIds)),
        persona?.id ?? null,
        input.stage ?? null,
        input.kind ?? "user",
        input.priority ?? 0,
        input.scheduledAt ?? null,
        input.source ?? "manual",
        input.title,
        input.description ?? null,
        JSON.stringify(labels),
        JSON.stringify(input.changedFiles ?? []),
        input.taskPackage ? JSON.stringify(input.taskPackage) : null,
        "queued",
        assignedAgent?.id ?? null,
        input.requestedAdapterType ?? null,
        input.laneId ?? input.taskPackage?.likelyOwnershipLane ?? null,
        JSON.stringify(normalizeStringArray(input.allowedPaths)),
        JSON.stringify(normalizeStringArray(input.requiredReading ?? input.taskPackage?.requiredReading)),
        JSON.stringify(normalizeStringArray(input.verificationCommands ?? input.taskPackage?.verificationChecklist)),
        input.claimStatus ?? "unclaimed",
        input.claimToken ?? null,
        input.claimExpiresAt ?? null,
        input.claimOwnerRunId ?? null,
        input.claimOwnerAgentId ?? assignedAgent?.id ?? null,
        input.claimedAt ?? null,
        input.lineageRootId ?? id,
        input.lineageParentId ?? input.parentTaskId ?? null,
        input.taskPackagePath ?? null,
        input.reviewHandoffPath ?? null,
        input.artifactDir ?? null,
        input.reviewRequired ? 1 : 0,
        input.approvalRequired ? 1 : 0,
        0,
        input.maxRetries ?? 1,
        null,
        null,
        null,
        null,
        createdAt,
        createdAt,
        null
      )

    return this.getTaskById(id)
  }

  createFollowUpTask(originalTask: Task, reason: string): Task {
    if (originalTask.kind === "follow_up" || originalTask.labels.includes("follow-up")) {
      throw new Error(`Refusing to create recursive follow-up task for ${originalTask.id}`)
    }
    return this.createTask({
      projectRef: originalTask.projectId,
      workflowId: originalTask.workflowId,
      personaRef: originalTask.personaId,
      stage: originalTask.stage,
      dependsOnTaskIds: [],
      priority: originalTask.priority,
      scheduledAt: null,
      source: "manual",
      title: `Follow-up: ${originalTask.title}`,
      description: [originalTask.description ?? "", "", `Follow-up reason: ${reason}`].join("\n").trim(),
      labels: Array.from(new Set([...originalTask.labels, "follow-up"])),
      changedFiles: originalTask.changedFiles,
      taskPackage: originalTask.taskPackage,
      kind: "follow_up",
      parentTaskId: originalTask.id,
      requestedAdapterType: originalTask.requestedAdapterType,
      laneId: originalTask.laneId,
      allowedPaths: originalTask.allowedPaths,
      requiredReading: originalTask.requiredReading,
      verificationCommands: originalTask.verificationCommands,
      lineageRootId: originalTask.lineageRootId ?? originalTask.id,
      lineageParentId: originalTask.id,
      taskPackagePath: originalTask.taskPackagePath,
      artifactDir: originalTask.artifactDir,
      reviewRequired: originalTask.reviewRequired,
      approvalRequired: false,
      maxRetries: 1
    })
  }

  private repairRootTaskForRun(run: Run): Task {
    const failedTask = this.getTaskById(run.taskId)
    if (failedTask.kind === "repair" && failedTask.parentTaskId) {
      return this.getTaskById(failedTask.parentTaskId)
    }
    return failedTask
  }

  listRepairTasks(originalTaskId?: string): Task[] {
    const rows = originalTaskId
      ? this.db
          .prepare("SELECT * FROM tasks WHERE parent_task_id = ? AND kind = 'repair' ORDER BY created_at ASC")
          .all(originalTaskId)
      : this.db.prepare("SELECT * FROM tasks WHERE kind = 'repair' ORDER BY created_at ASC").all()
    return rows.map((row) => mapTask(row as Record<string, unknown>))
  }

  countFailedRepairAttempts(originalTaskId: string): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM tasks WHERE parent_task_id = ? AND kind = 'repair' AND status IN ('failed', 'blocked')"
      )
      .get(originalTaskId) as Record<string, unknown>
    return Number(row.count)
  }

  createRepairTaskForRun(runId: string, input: { projectProfileId?: string | null } = {}): RepairCreationResult {
    const failedRun = this.getRunById(runId)
    if (failedRun.status !== "failed") {
      throw new Error(`Run ${runId} is ${failedRun.status}; repair tasks can only be created for failed runs.`)
    }

    const originalTask = this.repairRootTaskForRun(failedRun)
    const existing = this.listRepairTasks(originalTask.id).find(
      (task) =>
        task.labels.includes(`repair-for:${runId}`) &&
        task.status !== "failed" &&
        task.status !== "blocked" &&
        task.status !== "needs_human_review"
    )
    if (existing) {
      const plan = buildRepairTaskPlan({
        run: failedRun,
        task: originalTask,
        project: this.getProjectById(failedRun.projectId),
        runEvents: this.getRunEvents(runId),
        attempt: this.countFailedRepairAttempts(originalTask.id) + 1,
        projectProfileId: input.projectProfileId ?? null
      })
      return {
        status: "already_exists",
        task: existing,
        originalTask,
        failedRun,
        attempt: plan.attempt,
        plan
      }
    }

    const failedAttempts = this.countFailedRepairAttempts(originalTask.id)
    if (failedAttempts >= MAX_REPAIR_ATTEMPTS) {
      this.updateTaskStatus(originalTask.id, "needs_human_review", {
        blockedReason: "repair_attempt_limit_exceeded",
        lastError: `Repair failed ${failedAttempts} times. Human review required.`,
        lastRecoveryAt: nowIso(),
        lastRecoveryReason: "repair_attempt_limit_exceeded"
      })
      this.appendTaskEvent(originalTask.id, "needs-human-review", "Repair attempt limit exceeded.", {
        failedRunId: runId,
        failedRepairAttempts: failedAttempts,
        maxRepairAttempts: MAX_REPAIR_ATTEMPTS
      })
      return {
        status: "needs_human_review",
        task: null,
        originalTask: this.getTaskById(originalTask.id),
        failedRun,
        attempt: failedAttempts + 1,
        plan: null
      }
    }

    const project = this.getProjectById(failedRun.projectId)
    const attempt = failedAttempts + 1
    const plan = buildRepairTaskPlan({
      run: failedRun,
      task: originalTask,
      project,
      runEvents: this.getRunEvents(runId),
      attempt,
      projectProfileId: input.projectProfileId ?? null
    })
    const repairTask = this.createTask({
      projectRef: originalTask.projectId,
      workflowId: originalTask.workflowId,
      personaRef: originalTask.personaId,
      stage: originalTask.stage,
      priority: originalTask.priority + 20,
      source: "maintenance",
      title: plan.title,
      description: plan.description,
      labels: plan.labels,
      changedFiles: plan.changedFiles,
      taskPackage: plan.taskPackage,
      kind: "repair",
      parentTaskId: originalTask.id,
      requestedAdapterType: "codex_local",
      laneId: originalTask.laneId,
      allowedPaths: plan.allowedPaths,
      requiredReading: plan.filesToInspect,
      verificationCommands: plan.verificationCommands,
      lineageRootId: originalTask.lineageRootId ?? originalTask.id,
      lineageParentId: originalTask.id,
      taskPackagePath: originalTask.taskPackagePath,
      artifactDir: originalTask.artifactDir,
      reviewRequired: false,
      approvalRequired: false,
      maxRetries: 0
    })
    this.appendTaskEvent(originalTask.id, "repair-task-created", "Created scoped repair task from failed run.", {
      failedRunId: runId,
      repairTaskId: repairTask.id,
      attempt,
      maxRepairAttempts: MAX_REPAIR_ATTEMPTS
    })
    this.appendTaskEvent(repairTask.id, "repair-task-linked", "Linked repair task to failed run.", {
      failedRunId: runId,
      originalTaskId: originalTask.id,
      attempt,
      maxRepairAttempts: MAX_REPAIR_ATTEMPTS
    })

    return {
      status: "created",
      task: repairTask,
      originalTask,
      failedRun,
      attempt,
      plan
    }
  }

  listTasks(companyId?: string): Task[] {
    const query = companyId
      ? this.db.prepare("SELECT * FROM tasks WHERE company_id = ? ORDER BY created_at ASC")
      : this.db.prepare("SELECT * FROM tasks ORDER BY created_at ASC")
    const rows = companyId ? query.all(companyId) : query.all()
    return rows.map((row) => mapTask(row as Record<string, unknown>))
  }

  listProjectTasks(projectId: string): Task[] {
    return this.db
      .prepare("SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at ASC")
      .all(projectId)
      .map((row) => mapTask(row as Record<string, unknown>))
  }

  upsertBacklogCandidate(input: UpsertBacklogCandidateInput): BacklogCandidate {
    const project = this.getProjectById(input.projectId)
    const now = nowIso()
    const existing = this.findBacklogCandidateByDedupeKey(project.id, input.dedupeKey)
    if (existing) {
      this.db
        .prepare(
          `
          UPDATE backlog_candidates
          SET
            status = CASE WHEN status = 'accepted' THEN status ELSE ? END,
            title = ?,
            description = ?,
            value_score = ?,
            risk_score = ?,
            effort_estimate = ?,
            recommended_persona = ?,
            suggested_adapter = ?,
            verification_command = ?,
            dependencies_json = ?,
            reason = ?,
            source_signals_json = ?,
            labels_json = ?,
            changed_files_json = ?,
            duplicate_of = ?,
            updated_at = ?
          WHERE id = ?
          `
        )
        .run(
          input.status ?? "candidate",
          input.title,
          input.description,
          input.valueScore,
          input.riskScore,
          input.effortEstimate,
          input.recommendedPersona ?? null,
          input.suggestedAdapter ?? null,
          input.verificationCommand ?? null,
          JSON.stringify(normalizeStringArray(input.dependencies)),
          input.reason,
          JSON.stringify(normalizeStringArray(input.sourceSignals)),
          JSON.stringify(normalizeStringArray(input.labels)),
          JSON.stringify(normalizeStringArray(input.changedFiles)),
          input.duplicateOf ?? null,
          now,
          existing.id
        )
      return this.getBacklogCandidateById(existing.id)
    }

    const id = randomUUID()
    this.db
      .prepare(
        `
        INSERT INTO backlog_candidates (
          id,
          company_id,
          project_id,
          status,
          title,
          description,
          value_score,
          risk_score,
          effort_estimate,
          recommended_persona,
          suggested_adapter,
          verification_command,
          dependencies_json,
          reason,
          dedupe_key,
          source_signals_json,
          labels_json,
          changed_files_json,
          accepted_task_id,
          duplicate_of,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        id,
        project.companyId,
        project.id,
        input.status ?? "candidate",
        input.title,
        input.description,
        input.valueScore,
        input.riskScore,
        input.effortEstimate,
        input.recommendedPersona ?? null,
        input.suggestedAdapter ?? null,
        input.verificationCommand ?? null,
        JSON.stringify(normalizeStringArray(input.dependencies)),
        input.reason,
        input.dedupeKey,
        JSON.stringify(normalizeStringArray(input.sourceSignals)),
        JSON.stringify(normalizeStringArray(input.labels)),
        JSON.stringify(normalizeStringArray(input.changedFiles)),
        null,
        input.duplicateOf ?? null,
        now,
        now
      )
    return this.getBacklogCandidateById(id)
  }

  getBacklogCandidateById(id: string): BacklogCandidate {
    const row = this.db.prepare("SELECT * FROM backlog_candidates WHERE id = ?").get(id)
    if (!row) throw new Error(`Backlog candidate not found: ${id}`)
    return mapBacklogCandidate(row as Record<string, unknown>)
  }

  findBacklogCandidateByDedupeKey(projectId: string, dedupeKey: string): BacklogCandidate | null {
    const row = this.db
      .prepare("SELECT * FROM backlog_candidates WHERE project_id = ? AND dedupe_key = ? LIMIT 1")
      .get(projectId, dedupeKey)
    return row ? mapBacklogCandidate(row as Record<string, unknown>) : null
  }

  listBacklogCandidates(projectId: string, status?: BacklogCandidateStatus): BacklogCandidate[] {
    const rows = status
      ? this.db
          .prepare(
            "SELECT * FROM backlog_candidates WHERE project_id = ? AND status = ? ORDER BY value_score DESC, risk_score DESC, updated_at DESC"
          )
          .all(projectId, status)
      : this.db
          .prepare(
            "SELECT * FROM backlog_candidates WHERE project_id = ? ORDER BY status ASC, value_score DESC, risk_score DESC, updated_at DESC"
          )
          .all(projectId)
    return rows.map((row) => mapBacklogCandidate(row as Record<string, unknown>))
  }

  acceptBacklogCandidate(candidateId: string, taskId: string): BacklogCandidate {
    const now = nowIso()
    this.db
      .prepare("UPDATE backlog_candidates SET status = 'accepted', accepted_task_id = ?, updated_at = ? WHERE id = ?")
      .run(taskId, now, candidateId)
    return this.getBacklogCandidateById(candidateId)
  }

  listQueuedTasks(companyId?: string): Task[] {
    const query = companyId
      ? this.db.prepare(
          "SELECT * FROM tasks WHERE company_id = ? AND status = 'queued' AND (scheduled_at IS NULL OR scheduled_at <= ?) ORDER BY priority DESC, COALESCE(scheduled_at, created_at) ASC, created_at ASC"
        )
      : this.db.prepare(
          "SELECT * FROM tasks WHERE status = 'queued' AND (scheduled_at IS NULL OR scheduled_at <= ?) ORDER BY priority DESC, COALESCE(scheduled_at, created_at) ASC, created_at ASC"
        )
    const rows = companyId ? query.all(companyId, nowIso()) : query.all(nowIso())
    return rows.map((row) => mapTask(row as Record<string, unknown>))
  }

  listRunningTasks(companyId?: string): Task[] {
    const query = companyId
      ? this.db.prepare(
          "SELECT * FROM tasks WHERE company_id = ? AND status = 'running' ORDER BY updated_at ASC, created_at ASC"
        )
      : this.db.prepare("SELECT * FROM tasks WHERE status = 'running' ORDER BY updated_at ASC, created_at ASC")
    const rows = companyId ? query.all(companyId) : query.all()
    return rows.map((row) => mapTask(row as Record<string, unknown>))
  }

  getTaskById(id: string): Task {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id)
    if (!row) throw new Error(`Task not found: ${id}`)
    return mapTask(row as Record<string, unknown>)
  }

  listChildTasks(parentTaskId: string, kind?: TaskKind): Task[] {
    const rows = kind
      ? this.db
          .prepare("SELECT * FROM tasks WHERE parent_task_id = ? AND kind = ? ORDER BY created_at ASC")
          .all(parentTaskId, kind)
      : this.db.prepare("SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY created_at ASC").all(parentTaskId)
    return rows.map((row) => mapTask(row as Record<string, unknown>))
  }

  listWorkflowTasks(workflowId: string): Task[] {
    return this.db
      .prepare("SELECT * FROM tasks WHERE workflow_id = ? ORDER BY created_at ASC")
      .all(workflowId)
      .map((row) => mapTask(row as Record<string, unknown>))
  }

  updateTask(taskId: string, patch: UpdateTaskInput): Task {
    const task = this.getTaskById(taskId)
    const completedAt = patch.completedAt === undefined ? task.completedAt : patch.completedAt
    this.db
      .prepare(
        `
      UPDATE tasks
      SET
        workflow_id = ?,
        goal_id = ?,
        milestone_id = ?,
        parent_task_id = ?,
        depends_on_task_ids_json = ?,
        persona_id = ?,
        stage = ?,
        kind = ?,
        priority = ?,
        scheduled_at = ?,
        source = ?,
        title = ?,
        description = ?,
        labels_json = ?,
        changed_files_json = ?,
        task_package_json = ?,
        assigned_agent_id = ?,
        requested_adapter_type = ?,
        lane_id = ?,
        allowed_paths_json = ?,
        required_reading_json = ?,
        verification_commands_json = ?,
        claim_status = ?,
        claim_token = ?,
        claim_expires_at = ?,
        claim_owner_run_id = ?,
        claim_owner_agent_id = ?,
        claimed_at = ?,
        lineage_root_id = ?,
        lineage_parent_id = ?,
        task_package_path = ?,
        review_handoff_path = ?,
        artifact_dir = ?,
        review_required = ?,
        approval_required = ?,
        retry_count = ?,
        max_retries = ?,
        last_error = ?,
        blocked_reason = ?,
        last_recovery_at = ?,
        last_recovery_reason = ?,
        completed_at = ?,
        updated_at = ?
      WHERE id = ?
      `
      )
      .run(
        sqlNullable(patch.workflowId === undefined ? task.workflowId : patch.workflowId),
        sqlNullable(patch.goalId === undefined ? task.goalId : patch.goalId),
        sqlNullable(patch.milestoneId === undefined ? task.milestoneId : patch.milestoneId),
        sqlNullable(patch.parentTaskId === undefined ? task.parentTaskId : patch.parentTaskId),
        JSON.stringify(
          patch.dependsOnTaskIds === undefined ? task.dependsOnTaskIds : normalizeStringArray(patch.dependsOnTaskIds)
        ),
        sqlNullable(patch.personaId === undefined ? task.personaId : patch.personaId),
        sqlNullable(patch.stage === undefined ? task.stage : patch.stage),
        patch.kind ?? task.kind,
        patch.priority ?? task.priority,
        sqlNullable(patch.scheduledAt === undefined ? task.scheduledAt : patch.scheduledAt),
        patch.source ?? task.source,
        patch.title ?? task.title,
        sqlNullable(patch.description === undefined ? task.description : patch.description),
        JSON.stringify(patch.labels === undefined ? task.labels : normalizeStringArray(patch.labels)),
        JSON.stringify(patch.changedFiles === undefined ? task.changedFiles : normalizeStringArray(patch.changedFiles)),
        patch.taskPackage === undefined
          ? task.taskPackage
            ? JSON.stringify(task.taskPackage)
            : null
          : patch.taskPackage
            ? JSON.stringify(patch.taskPackage)
            : null,
        sqlNullable(patch.assignedAgentId === undefined ? task.assignedAgentId : patch.assignedAgentId),
        sqlNullable(patch.requestedAdapterType === undefined ? task.requestedAdapterType : patch.requestedAdapterType),
        sqlNullable(patch.laneId === undefined ? task.laneId : patch.laneId),
        JSON.stringify(patch.allowedPaths === undefined ? task.allowedPaths : normalizeStringArray(patch.allowedPaths)),
        JSON.stringify(
          patch.requiredReading === undefined ? task.requiredReading : normalizeStringArray(patch.requiredReading)
        ),
        JSON.stringify(
          patch.verificationCommands === undefined
            ? task.verificationCommands
            : normalizeStringArray(patch.verificationCommands)
        ),
        patch.claimStatus ?? task.claimStatus,
        sqlNullable(patch.claimToken === undefined ? task.claimToken : patch.claimToken),
        sqlNullable(patch.claimExpiresAt === undefined ? task.claimExpiresAt : patch.claimExpiresAt),
        sqlNullable(patch.claimOwnerRunId === undefined ? task.claimOwnerRunId : patch.claimOwnerRunId),
        sqlNullable(patch.claimOwnerAgentId === undefined ? task.claimOwnerAgentId : patch.claimOwnerAgentId),
        sqlNullable(patch.claimedAt === undefined ? task.claimedAt : patch.claimedAt),
        sqlNullable(patch.lineageRootId === undefined ? task.lineageRootId : patch.lineageRootId),
        sqlNullable(patch.lineageParentId === undefined ? task.lineageParentId : patch.lineageParentId),
        sqlNullable(patch.taskPackagePath === undefined ? task.taskPackagePath : patch.taskPackagePath),
        sqlNullable(patch.reviewHandoffPath === undefined ? task.reviewHandoffPath : patch.reviewHandoffPath),
        sqlNullable(patch.artifactDir === undefined ? task.artifactDir : patch.artifactDir),
        patch.reviewRequired === undefined ? (task.reviewRequired ? 1 : 0) : patch.reviewRequired ? 1 : 0,
        patch.approvalRequired === undefined ? (task.approvalRequired ? 1 : 0) : patch.approvalRequired ? 1 : 0,
        patch.retryCount ?? task.retryCount,
        patch.maxRetries ?? task.maxRetries,
        sqlNullable(patch.lastError === undefined ? task.lastError : patch.lastError),
        sqlNullable(patch.blockedReason === undefined ? task.blockedReason : patch.blockedReason),
        sqlNullable(patch.lastRecoveryAt === undefined ? task.lastRecoveryAt : patch.lastRecoveryAt),
        sqlNullable(patch.lastRecoveryReason === undefined ? task.lastRecoveryReason : patch.lastRecoveryReason),
        sqlNullable(completedAt),
        nowIso(),
        taskId
      )
    return this.getTaskById(taskId)
  }

  updateTaskStatus(
    taskId: string,
    status: TaskStatus,
    patch: {
      assignedAgentId?: string | null
      lastError?: string | null
      blockedReason?: string | null
      retryCount?: number
      claimStatus?: TaskClaimStatus
      claimToken?: string | null
      claimExpiresAt?: string | null
      claimOwnerRunId?: string | null
      claimOwnerAgentId?: string | null
      claimedAt?: string | null
      lastRecoveryAt?: string | null
      lastRecoveryReason?: string | null
    } = {}
  ): void {
    const completedAt = status === "done" || status === "failed" ? nowIso() : null
    const current = this.getTaskById(taskId)
    this.db
      .prepare(
        `
      UPDATE tasks
      SET
        status = ?,
        assigned_agent_id = ?,
        last_error = ?,
        blocked_reason = ?,
        retry_count = COALESCE(?, retry_count),
        claim_status = ?,
        claim_token = ?,
        claim_expires_at = ?,
        claim_owner_run_id = ?,
        claim_owner_agent_id = ?,
        claimed_at = ?,
        last_recovery_at = ?,
        last_recovery_reason = ?,
        completed_at = ?,
        updated_at = ?
      WHERE id = ?
      `
      )
      .run(
        status,
        patch.assignedAgentId ?? current.assignedAgentId,
        patch.lastError ?? null,
        patch.blockedReason ?? null,
        patch.retryCount ?? null,
        patch.claimStatus ?? (status === "running" ? "claimed" : current.claimStatus),
        patch.claimToken === undefined ? (status === "running" ? current.claimToken : null) : patch.claimToken,
        patch.claimExpiresAt === undefined
          ? status === "running"
            ? current.claimExpiresAt
            : null
          : patch.claimExpiresAt,
        patch.claimOwnerRunId === undefined
          ? status === "running"
            ? current.claimOwnerRunId
            : null
          : patch.claimOwnerRunId,
        patch.claimOwnerAgentId === undefined
          ? status === "running"
            ? current.claimOwnerAgentId
            : null
          : patch.claimOwnerAgentId,
        patch.claimedAt === undefined ? (status === "running" ? current.claimedAt : null) : patch.claimedAt,
        patch.lastRecoveryAt === undefined ? current.lastRecoveryAt : patch.lastRecoveryAt,
        patch.lastRecoveryReason === undefined ? current.lastRecoveryReason : patch.lastRecoveryReason,
        completedAt,
        nowIso(),
        taskId
      )
  }

  incrementTaskRetry(taskId: string, lastError: string): Task {
    const task = this.getTaskById(taskId)
    this.db
      .prepare(
        `
      UPDATE tasks
      SET retry_count = ?, last_error = ?, updated_at = ?
      WHERE id = ?
      `
      )
      .run(task.retryCount + 1, lastError, nowIso(), taskId)
    return this.getTaskById(taskId)
  }

  claimTask(
    taskId: string,
    options: {
      leaseMs?: number
      ownerRunId?: string | null
      ownerAgentId?: string | null
      expectedStatuses?: TaskStatus[]
    } = {}
  ): TaskClaimLease | null {
    return this.transaction(() => {
      const current = this.getTaskById(taskId)
      const expectedStatuses = options.expectedStatuses ?? ["queued"]
      const now = new Date()
      const nowValue = now.toISOString()
      const currentExpiry = current.claimExpiresAt ? Date.parse(current.claimExpiresAt) : null
      const claimAvailable =
        current.claimStatus !== "claimed" ||
        currentExpiry === null ||
        Number.isNaN(currentExpiry) ||
        currentExpiry <= now.getTime()
      if (!expectedStatuses.includes(current.status) || !claimAvailable) {
        return null
      }

      const claimToken = randomUUID()
      const claimExpiresAt = new Date(now.getTime() + (options.leaseMs ?? 30 * 60 * 1000)).toISOString()
      const result = this.db
        .prepare(
          `
          UPDATE tasks
          SET
            status = 'running',
            claim_status = 'claimed',
            claim_token = ?,
            claim_expires_at = ?,
            claim_owner_run_id = ?,
            claim_owner_agent_id = ?,
            claimed_at = ?,
            blocked_reason = NULL,
            updated_at = ?
          WHERE id = ?
          AND status = ?
          AND (
            claim_status != 'claimed'
            OR claim_expires_at IS NULL
            OR claim_expires_at <= ?
          )
          `
        )
        .run(
          claimToken,
          claimExpiresAt,
          options.ownerRunId ?? null,
          options.ownerAgentId ?? null,
          nowValue,
          nowValue,
          taskId,
          current.status,
          nowValue
        )
      return Number(result.changes) === 1
        ? {
            claimToken,
            claimExpiresAt,
            claimedAt: nowValue
          }
        : null
    })
  }

  startRunWithClaim(input: {
    companyId: string
    projectId: string
    taskId: string
    agentId?: string | null
    adapterType?: AdapterType | null
    kind?: TaskKind
    sessionKey?: string | null
    wakeReason?: WakeReason
    heartbeatJobId?: JobId | null
    worktreePath?: string | null
    manifestPath?: string | null
    reviewVerdict?: ReviewVerdict | null
    promotionRecordId?: string | null
    costCents?: number | null
    retryClass?: RunRetryClass
    leaseMs?: number
    expectedStatuses?: TaskStatus[]
    teamAssignment?: StartTeamAssignmentInput
  }): { run: Run; lease: TaskClaimLease; assignment?: TeamAssignment } | null {
    return this.transaction(() => {
      const task = this.getTaskById(input.taskId)
      const expectedStatuses = input.expectedStatuses ?? ["queued"]
      const now = new Date()
      const nowValue = now.toISOString()
      const currentExpiry = task.claimExpiresAt ? Date.parse(task.claimExpiresAt) : null
      const claimAvailable =
        task.claimStatus !== "claimed" ||
        currentExpiry === null ||
        Number.isNaN(currentExpiry) ||
        currentExpiry <= now.getTime()
      if (!expectedStatuses.includes(task.status) || !claimAvailable) {
        return null
      }

      const requestedArtifactPaths = input.teamAssignment?.artifactPaths ?? []
      const taskArtifactPaths = task.changedFiles.length > 0 ? task.changedFiles : task.allowedPaths
      const artifactPaths = normalizeArtifactScopes(
        input.teamAssignment && requestedArtifactPaths.length === 0 ? taskArtifactPaths : requestedArtifactPaths
      )
      if (input.teamAssignment && !input.agentId) {
        throw new Error("A durable team assignment requires an agent id.")
      }
      if (
        input.teamAssignment &&
        input.agentId &&
        this.findTeamReviewerLockoutsUnsafe(input.projectId, artifactPaths, {
          taskId: input.taskId,
          lockedAgentId: input.agentId
        }).length > 0
      ) {
        return null
      }
      if (artifactPaths.length > 0 && this.findTeamArtifactConflictsUnsafe(input.projectId, artifactPaths).length > 0) {
        return null
      }

      const lease: TaskClaimLease = {
        claimToken: randomUUID(),
        claimedAt: nowValue,
        claimExpiresAt: new Date(now.getTime() + (input.leaseMs ?? 30 * 60 * 1000)).toISOString()
      }
      const runId = randomUUID()
      const claimResult = this.db
        .prepare(
          `
        UPDATE tasks
        SET
          status = 'running',
          claim_status = 'claimed',
          claim_token = ?,
          claim_expires_at = ?,
          claim_owner_run_id = ?,
          claim_owner_agent_id = ?,
          claimed_at = ?,
          blocked_reason = NULL,
          updated_at = ?
        WHERE id = ?
        AND status = ?
        AND (
          claim_status != 'claimed'
          OR claim_expires_at IS NULL
          OR claim_expires_at <= ?
        )
        `
        )
        .run(
          lease.claimToken,
          lease.claimExpiresAt,
          runId,
          input.agentId ?? null,
          lease.claimedAt,
          nowValue,
          input.taskId,
          task.status,
          nowValue
        )
      if (Number(claimResult.changes) !== 1) {
        return null
      }

      this.db
        .prepare(
          `
        INSERT INTO runs (
          id,
          company_id,
          project_id,
          task_id,
          agent_id,
          adapter_type,
          kind,
          status,
          session_key,
          session_display_id,
          response_text,
          error_text,
          usage_json,
          branch_name,
          pr_number,
          head_sha,
          verification_summary,
          wake_reason,
          heartbeat_job_id,
          worktree_path,
          manifest_path,
          review_verdict,
          promotion_record_id,
          cost_cents,
          retry_class,
          started_at,
          finished_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
        `
        )
        .run(
          runId,
          input.companyId,
          input.projectId,
          input.taskId,
          input.agentId ?? null,
          input.adapterType ?? null,
          input.kind ?? "user",
          input.sessionKey ?? null,
          input.wakeReason ?? "manual",
          input.heartbeatJobId ?? null,
          input.worktreePath ?? null,
          input.manifestPath ?? null,
          input.reviewVerdict ?? null,
          input.promotionRecordId ?? null,
          input.costCents ?? null,
          input.retryClass ?? "none",
          nowValue,
          nowValue,
          nowValue
        )

      let assignment: TeamAssignment | undefined
      if (input.teamAssignment && input.agentId) {
        const assignmentId = randomUUID()
        this.db
          .prepare(
            `
            INSERT INTO team_assignments (
              id,
              company_id,
              project_id,
              task_id,
              run_id,
              agent_id,
              status,
              routing_reason,
              routing_decision_json,
              artifact_paths_json,
              release_reason,
              started_at,
              finished_at,
              created_at,
              updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, NULL, ?, NULL, ?, ?)
            `
          )
          .run(
            assignmentId,
            input.companyId,
            input.projectId,
            input.taskId,
            runId,
            input.agentId,
            input.teamAssignment.routingReason,
            JSON.stringify(input.teamAssignment.routingDecision ?? {}),
            JSON.stringify(artifactPaths),
            nowValue,
            nowValue,
            nowValue
          )

        const insertClaim = this.db.prepare(
          `
          INSERT INTO team_artifact_claims (
            id,
            assignment_id,
            company_id,
            project_id,
            task_id,
            run_id,
            agent_id,
            artifact_path,
            status,
            claimed_at,
            released_at,
            release_reason
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL, NULL)
          `
        )
        for (const artifactPath of artifactPaths) {
          insertClaim.run(
            randomUUID(),
            assignmentId,
            input.companyId,
            input.projectId,
            input.taskId,
            runId,
            input.agentId,
            artifactPath,
            nowValue
          )
        }
        assignment = this.getTeamAssignmentByRunId(runId) ?? undefined

        const handoffLocks = this.findTeamReviewerLockoutsUnsafe(input.projectId, artifactPaths, {
          taskId: input.taskId
        }).filter((lockout) => lockout.lockedAgentId !== input.agentId)
        const locksByThread = new Map<string, TeamReviewerLockout[]>()
        for (const lockout of handoffLocks) {
          const current = locksByThread.get(lockout.threadId) ?? []
          current.push(lockout)
          locksByThread.set(lockout.threadId, current)
        }
        for (const [threadId, lockouts] of locksByThread) {
          const first = lockouts[0]!
          this.postTeamMessageUnsafe({
            threadId,
            companyId: input.companyId,
            projectId: input.projectId,
            fromAgentId: first.reviewerAgentId,
            fromActor: first.reviewerActor,
            toAgentId: input.agentId,
            kind: "handoff",
            subject: `Independent revision assigned: ${task.title}`,
            body: first.reason,
            taskId: input.taskId,
            artifactPaths: lockouts.map((lockout) => lockout.artifactPath),
            dedupeKey: `review-lockout-handoff:${threadId}:${input.agentId}`,
            createdAt: nowValue
          })
        }
      }

      return {
        run: this.getRunById(runId),
        lease,
        ...(assignment ? { assignment } : {})
      }
    })
  }

  listTeamAssignments(
    input: {
      companyId?: string
      projectId?: string
      agentId?: string
      status?: TeamAssignmentStatus
      limit?: number
    } = {}
  ): TeamAssignment[] {
    const clauses: string[] = []
    const values: SQLInputValue[] = []
    if (input.companyId) {
      clauses.push("company_id = ?")
      values.push(input.companyId)
    }
    if (input.projectId) {
      clauses.push("project_id = ?")
      values.push(input.projectId)
    }
    if (input.agentId) {
      clauses.push("agent_id = ?")
      values.push(input.agentId)
    }
    if (input.status) {
      clauses.push("status = ?")
      values.push(input.status)
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""
    const requestedLimit = input.limit ?? 100
    const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 1_000)) : 100
    const rows = this.db
      .prepare(`SELECT * FROM team_assignments ${where} ORDER BY started_at DESC, created_at DESC LIMIT ?`)
      .all(...values, limit)
    return rows.map((row) => mapTeamAssignment(row as Record<string, unknown>))
  }

  getTeamAssignmentByRunId(runId: string): TeamAssignment | null {
    const row = this.db.prepare("SELECT * FROM team_assignments WHERE run_id = ?").get(runId)
    return row ? mapTeamAssignment(row as Record<string, unknown>) : null
  }

  listTeamArtifactClaims(
    input: { companyId?: string; projectId?: string; assignmentId?: string; status?: TeamArtifactClaimStatus } = {}
  ): TeamArtifactClaim[] {
    const clauses: string[] = []
    const values: SQLInputValue[] = []
    if (input.companyId) {
      clauses.push("company_id = ?")
      values.push(input.companyId)
    }
    if (input.projectId) {
      clauses.push("project_id = ?")
      values.push(input.projectId)
    }
    if (input.assignmentId) {
      clauses.push("assignment_id = ?")
      values.push(input.assignmentId)
    }
    if (input.status) {
      clauses.push("status = ?")
      values.push(input.status)
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""
    const rows = this.db
      .prepare(`SELECT * FROM team_artifact_claims ${where} ORDER BY claimed_at DESC, artifact_path ASC`)
      .all(...values)
    return rows.map((row) => mapTeamArtifactClaim(row as Record<string, unknown>))
  }

  findTeamArtifactConflicts(projectId: string, artifactPaths: string[]): TeamArtifactClaim[] {
    return this.findTeamArtifactConflictsUnsafe(projectId, normalizeArtifactScopes(artifactPaths))
  }

  private findTeamArtifactConflictsUnsafe(projectId: string, artifactPaths: string[]): TeamArtifactClaim[] {
    if (artifactPaths.length === 0) return []
    return this.listTeamArtifactClaims({ projectId, status: "active" }).filter((claim) =>
      artifactPaths.some((artifactPath) => artifactScopesOverlap(artifactPath, claim.artifactPath))
    )
  }

  createTeamReviewerLockouts(input: {
    companyId: string
    projectId: string
    taskId: string
    sourceTaskId: string
    sourceRunId?: string | null
    sourceAssignmentId?: string | null
    lockedAgentId: string
    reviewerAgentId?: string | null
    reviewerActor: string
    artifactPaths: string[]
    reason: string
  }): TeamReviewerLockout[] {
    const artifactPaths = normalizeArtifactScopes(input.artifactPaths)
    if (artifactPaths.length === 0) return []

    return this.transaction(() => {
      const threadId = randomUUID()
      const createdAt = nowIso()
      const insert = this.db.prepare(
        `
        INSERT INTO team_reviewer_lockouts (
          id,
          thread_id,
          company_id,
          project_id,
          task_id,
          source_task_id,
          source_run_id,
          source_assignment_id,
          locked_agent_id,
          reviewer_agent_id,
          reviewer_actor,
          artifact_path,
          reason,
          status,
          created_at,
          cleared_at,
          cleared_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL, NULL)
        `
      )
      const lockouts = artifactPaths.map((artifactPath) => {
        const id = randomUUID()
        insert.run(
          id,
          threadId,
          input.companyId,
          input.projectId,
          input.taskId,
          input.sourceTaskId,
          input.sourceRunId ?? null,
          input.sourceAssignmentId ?? null,
          input.lockedAgentId,
          input.reviewerAgentId ?? null,
          input.reviewerActor,
          artifactPath,
          input.reason,
          createdAt
        )
        const row = this.db.prepare("SELECT * FROM team_reviewer_lockouts WHERE id = ?").get(id)
        return mapTeamReviewerLockout(row as Record<string, unknown>)
      })

      const targetTask = this.getTaskById(input.taskId)
      this.postTeamMessageUnsafe({
        threadId,
        companyId: input.companyId,
        projectId: input.projectId,
        fromAgentId: input.reviewerAgentId ?? null,
        fromActor: input.reviewerActor,
        toAgentId: input.lockedAgentId,
        kind: "blocker",
        subject: `Reviewer lockout: ${targetTask.title}`,
        body: input.reason,
        taskId: input.taskId,
        artifactPaths,
        dedupeKey: `review-lockout-blocker:${threadId}:${input.lockedAgentId}`,
        createdAt
      })
      return lockouts
    })
  }

  listTeamReviewerLockouts(
    input: {
      companyId?: string
      projectId?: string
      taskId?: string
      lockedAgentId?: string
      status?: TeamReviewerLockoutStatus
    } = {}
  ): TeamReviewerLockout[] {
    const clauses: string[] = []
    const values: SQLInputValue[] = []
    if (input.companyId) {
      clauses.push("company_id = ?")
      values.push(input.companyId)
    }
    if (input.projectId) {
      clauses.push("project_id = ?")
      values.push(input.projectId)
    }
    if (input.taskId) {
      clauses.push("task_id = ?")
      values.push(input.taskId)
    }
    if (input.lockedAgentId) {
      clauses.push("locked_agent_id = ?")
      values.push(input.lockedAgentId)
    }
    if (input.status) {
      clauses.push("status = ?")
      values.push(input.status)
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""
    const rows = this.db
      .prepare(`SELECT * FROM team_reviewer_lockouts ${where} ORDER BY created_at DESC, artifact_path ASC`)
      .all(...values)
    return rows.map((row) => mapTeamReviewerLockout(row as Record<string, unknown>))
  }

  findTeamReviewerLockouts(
    projectId: string,
    artifactPaths: string[],
    input: { taskId?: string; lockedAgentId?: string } = {}
  ): TeamReviewerLockout[] {
    return this.findTeamReviewerLockoutsUnsafe(projectId, normalizeArtifactScopes(artifactPaths), input)
  }

  private findTeamReviewerLockoutsUnsafe(
    projectId: string,
    artifactPaths: string[],
    input: { taskId?: string; lockedAgentId?: string } = {}
  ): TeamReviewerLockout[] {
    if (artifactPaths.length === 0) return []
    return this.listTeamReviewerLockouts({
      projectId,
      status: "active",
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.lockedAgentId ? { lockedAgentId: input.lockedAgentId } : {})
    }).filter((lockout) =>
      artifactPaths.some((artifactPath) => artifactScopesOverlap(artifactPath, lockout.artifactPath))
    )
  }

  clearTeamReviewerLockoutsForTask(taskId: string, reason: string, clearedAt = nowIso()): number {
    return this.transaction(() => this.clearTeamReviewerLockoutsForTaskUnsafe(taskId, reason, clearedAt))
  }

  private clearTeamReviewerLockoutsForTaskUnsafe(taskId: string, reason: string, clearedAt: string): number {
    const result = this.db
      .prepare(
        `
        UPDATE team_reviewer_lockouts
        SET status = 'cleared', cleared_at = ?, cleared_reason = ?
        WHERE task_id = ? AND status = 'active'
        `
      )
      .run(clearedAt, reason, taskId)
    return Number(result.changes)
  }

  postTeamMessage(input: {
    threadId?: string | null
    companyId: string
    projectId: string
    fromAgentId?: string | null
    fromActor: string
    toAgentId: string
    kind: TeamMailboxMessageKind
    subject: string
    body: string
    taskId?: string | null
    artifactPaths?: string[]
    dedupeKey?: string | null
  }): TeamMailboxMessage {
    return this.transaction(() =>
      this.postTeamMessageUnsafe({
        ...input,
        threadId: input.threadId ?? randomUUID(),
        fromAgentId: input.fromAgentId ?? null,
        taskId: input.taskId ?? null,
        artifactPaths: input.artifactPaths ?? [],
        dedupeKey: input.dedupeKey ?? null,
        createdAt: nowIso()
      })
    )
  }

  private postTeamMessageUnsafe(input: {
    threadId: string
    companyId: string
    projectId: string
    fromAgentId: string | null
    fromActor: string
    toAgentId: string
    kind: TeamMailboxMessageKind
    subject: string
    body: string
    taskId: string | null
    artifactPaths: string[]
    dedupeKey: string | null
    createdAt: string
  }): TeamMailboxMessage {
    if (input.dedupeKey) {
      const existing = this.db.prepare("SELECT * FROM team_mailbox_messages WHERE dedupe_key = ?").get(input.dedupeKey)
      if (existing) return mapTeamMailboxMessage(existing as Record<string, unknown>)
    }
    const id = randomUUID()
    this.db
      .prepare(
        `
        INSERT INTO team_mailbox_messages (
          id,
          thread_id,
          company_id,
          project_id,
          from_agent_id,
          from_actor,
          to_agent_id,
          kind,
          subject,
          body,
          task_id,
          artifact_paths_json,
          dedupe_key,
          created_at,
          acknowledged_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
        `
      )
      .run(
        id,
        input.threadId,
        input.companyId,
        input.projectId,
        input.fromAgentId,
        input.fromActor,
        input.toAgentId,
        input.kind,
        input.subject,
        input.body,
        input.taskId,
        JSON.stringify(normalizeArtifactScopes(input.artifactPaths)),
        input.dedupeKey,
        input.createdAt
      )
    return this.getTeamMessageById(id)
  }

  getTeamMessageById(id: string): TeamMailboxMessage {
    const row = this.db.prepare("SELECT * FROM team_mailbox_messages WHERE id = ?").get(id)
    if (!row) throw new Error(`Team mailbox message not found: ${id}`)
    return mapTeamMailboxMessage(row as Record<string, unknown>)
  }

  listTeamMessages(
    input: {
      companyId?: string
      projectId?: string
      toAgentId?: string
      taskId?: string
      threadId?: string
      kind?: TeamMailboxMessageKind
      includeAcknowledged?: boolean
      limit?: number
    } = {}
  ): TeamMailboxMessage[] {
    const clauses: string[] = []
    const values: SQLInputValue[] = []
    if (input.companyId) {
      clauses.push("company_id = ?")
      values.push(input.companyId)
    }
    if (input.projectId) {
      clauses.push("project_id = ?")
      values.push(input.projectId)
    }
    if (input.toAgentId) {
      clauses.push("to_agent_id = ?")
      values.push(input.toAgentId)
    }
    if (input.taskId) {
      clauses.push("task_id = ?")
      values.push(input.taskId)
    }
    if (input.threadId) {
      clauses.push("thread_id = ?")
      values.push(input.threadId)
    }
    if (input.kind) {
      clauses.push("kind = ?")
      values.push(input.kind)
    }
    if (!input.includeAcknowledged) {
      clauses.push("acknowledged_at IS NULL")
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""
    const requestedLimit = input.limit ?? 100
    const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 1_000)) : 100
    const rows = this.db
      .prepare(`SELECT * FROM team_mailbox_messages ${where} ORDER BY created_at ASC LIMIT ?`)
      .all(...values, limit)
    return rows.map((row) => mapTeamMailboxMessage(row as Record<string, unknown>))
  }

  acknowledgeTeamMessage(messageId: string, agentId: string, acknowledgedAt = nowIso()): TeamMailboxMessage {
    const message = this.getTeamMessageById(messageId)
    if (message.toAgentId !== agentId) {
      throw new Error(`Agent ${agentId} cannot acknowledge team message ${messageId}.`)
    }
    this.db.prepare("UPDATE team_mailbox_messages SET acknowledged_at = ? WHERE id = ?").run(acknowledgedAt, messageId)
    return this.getTeamMessageById(messageId)
  }

  releaseTeamAssignmentForRun(
    runId: string,
    input: {
      status?: Exclude<TeamAssignmentStatus, "active">
      reason: string
      finishedAt?: string
    }
  ): TeamAssignment | null {
    return this.transaction(() =>
      this.releaseTeamAssignmentForRunUnsafe(
        runId,
        input.status ?? "released",
        input.reason,
        input.finishedAt ?? nowIso()
      )
    )
  }

  private releaseTeamAssignmentForRunUnsafe(
    runId: string,
    status: Exclude<TeamAssignmentStatus, "active">,
    reason: string,
    finishedAt: string
  ): TeamAssignment | null {
    const row = this.db.prepare("SELECT * FROM team_assignments WHERE run_id = ?").get(runId)
    if (!row) return null
    const current = mapTeamAssignment(row as Record<string, unknown>)
    if (current.status !== "active") return current

    this.db
      .prepare(
        `
        UPDATE team_artifact_claims
        SET status = 'released', released_at = ?, release_reason = ?
        WHERE assignment_id = ? AND status = 'active'
        `
      )
      .run(finishedAt, reason, current.id)
    this.db
      .prepare(
        `
        UPDATE team_assignments
        SET status = ?, release_reason = ?, finished_at = ?, updated_at = ?
        WHERE id = ? AND status = 'active'
        `
      )
      .run(status, reason, finishedAt, finishedAt, current.id)
    return this.getTeamAssignmentByRunId(runId)
  }

  completeClaimedTask(
    taskId: string,
    claimToken: string,
    status: TaskStatus,
    patch: {
      assignedAgentId?: string | null
      lastError?: string | null
      blockedReason?: string | null
    } = {}
  ): boolean {
    return this.transaction(() => {
      const completedAt = status === "done" || status === "failed" ? nowIso() : null
      const result = this.db
        .prepare(
          `
          UPDATE tasks
          SET
            status = ?,
            assigned_agent_id = ?,
            last_error = ?,
            blocked_reason = ?,
            claim_status = 'unclaimed',
            claim_token = NULL,
            claim_expires_at = NULL,
            claim_owner_run_id = NULL,
            claim_owner_agent_id = NULL,
            claimed_at = NULL,
            completed_at = ?,
            updated_at = ?
          WHERE id = ?
          AND claim_status = 'claimed'
          AND claim_token = ?
          `
        )
        .run(
          status,
          patch.assignedAgentId ?? null,
          patch.lastError ?? null,
          patch.blockedReason ?? null,
          completedAt,
          nowIso(),
          taskId,
          claimToken
        )
      return Number(result.changes) === 1
    })
  }

  failClaimedTask(
    taskId: string,
    claimToken: string,
    message: string,
    assignedAgentId: string | null,
    options: {
      retryAllowed?: boolean
      blockedReason?: string | null
      incrementRetry?: boolean
    } = {}
  ): { applied: boolean; task: Task; followUpRequired: boolean } {
    return this.transaction(() => {
      const current = this.getTaskById(taskId)
      if (current.claimStatus !== "claimed" || current.claimToken !== claimToken) {
        return { applied: false, task: current, followUpRequired: false }
      }

      const retryCount = current.retryCount + (options.incrementRetry === false ? 0 : 1)
      const retryAllowed = options.retryAllowed ?? true
      const followUpRequired = retryAllowed && retryCount > current.maxRetries
      const status: TaskStatus = retryAllowed ? (followUpRequired ? "failed" : "queued") : "blocked"
      const completedAt = status === "failed" ? nowIso() : null
      this.db
        .prepare(
          `
        UPDATE tasks
        SET
          status = ?,
          assigned_agent_id = ?,
          retry_count = ?,
          last_error = ?,
          blocked_reason = ?,
          claim_status = 'unclaimed',
          claim_token = NULL,
          claim_expires_at = NULL,
          claim_owner_run_id = NULL,
          claim_owner_agent_id = NULL,
          claimed_at = NULL,
          completed_at = ?,
          updated_at = ?
        WHERE id = ?
        AND claim_status = 'claimed'
        AND claim_token = ?
        `
        )
        .run(
          status,
          assignedAgentId,
          retryCount,
          message,
          status === "blocked" ? (options.blockedReason ?? "human_action_required") : null,
          completedAt,
          nowIso(),
          taskId,
          claimToken
        )

      return {
        applied: true,
        task: this.getTaskById(taskId),
        followUpRequired
      }
    })
  }

  recoverTaskClaim(
    taskId: string,
    input: {
      status: "queued" | "failed"
      reason: string
      at?: string
      blockedReason?: string | null
      lastError?: string | null
      incrementRetry?: boolean
    }
  ): Task {
    const at = input.at ?? nowIso()
    return this.transaction(() => {
      const current = this.getTaskById(taskId)
      const retryCount = input.incrementRetry ? current.retryCount + 1 : current.retryCount
      const runningRunRows = this.db
        .prepare("SELECT id FROM runs WHERE task_id = ? AND status = 'running'")
        .all(taskId) as Array<{ id: string }>
      this.db
        .prepare(
          `
          UPDATE runs
          SET status = 'cancelled', error_text = ?, retry_class = 'transient', finished_at = ?, updated_at = ?
          WHERE task_id = ? AND status = 'running'
          `
        )
        .run(`Task claim recovered: ${input.reason}`, at, at, taskId)
      for (const row of runningRunRows) {
        this.releaseTeamAssignmentForRunUnsafe(String(row.id), "cancelled", input.reason, at)
      }
      this.db
        .prepare(
          `
        UPDATE tasks
        SET
          status = ?,
          retry_count = ?,
          claim_status = 'expired',
          claim_token = NULL,
          claim_expires_at = ?,
          claim_owner_run_id = NULL,
          claim_owner_agent_id = NULL,
          claimed_at = NULL,
          blocked_reason = ?,
          last_error = ?,
          last_recovery_at = ?,
          last_recovery_reason = ?,
          completed_at = ?,
          updated_at = ?
        WHERE id = ?
        `
        )
        .run(
          input.status,
          retryCount,
          at,
          input.blockedReason ?? null,
          input.lastError ?? input.reason,
          at,
          input.reason,
          input.status === "failed" ? at : null,
          at,
          taskId
        )
      return this.getTaskById(taskId)
    })
  }

  hasActiveRunForTask(taskId: string): boolean {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM runs WHERE task_id = ? AND status = 'running'")
      .get(taskId) as Record<string, unknown>
    return Number(row.count) > 0
  }

  hasActiveRunForAgent(agentId: string): boolean {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM runs WHERE agent_id = ? AND status = 'running'")
      .get(agentId) as Record<string, unknown>
    return Number(row.count) > 0
  }

  createRun(input: {
    companyId: string
    projectId: string
    taskId: string
    agentId?: string | null
    adapterType?: AdapterType | null
    kind?: TaskKind
    sessionKey?: string | null
    wakeReason?: WakeReason
    heartbeatJobId?: JobId | null
    worktreePath?: string | null
    manifestPath?: string | null
    reviewVerdict?: ReviewVerdict | null
    promotionRecordId?: string | null
    costCents?: number | null
    retryClass?: RunRetryClass
  }): Run {
    const id = randomUUID()
    const createdAt = nowIso()

    this.db
      .prepare(
        `
      INSERT INTO runs (
        id,
        company_id,
        project_id,
        task_id,
        agent_id,
        adapter_type,
        kind,
        status,
        session_key,
        session_display_id,
        response_text,
        error_text,
        usage_json,
        branch_name,
        pr_number,
        head_sha,
        verification_summary,
        wake_reason,
        heartbeat_job_id,
        worktree_path,
        manifest_path,
        review_verdict,
        promotion_record_id,
        cost_cents,
        retry_class,
        metadata_json,
        started_at,
        finished_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?)
      `
      )
      .run(
        id,
        input.companyId,
        input.projectId,
        input.taskId,
        input.agentId ?? null,
        input.adapterType ?? null,
        input.kind ?? "user",
        input.sessionKey ?? null,
        input.wakeReason ?? "manual",
        input.heartbeatJobId ?? null,
        input.worktreePath ?? null,
        input.manifestPath ?? null,
        input.reviewVerdict ?? null,
        input.promotionRecordId ?? null,
        input.costCents ?? null,
        input.retryClass ?? "none",
        createdAt,
        createdAt,
        createdAt
      )

    return this.getRunById(id)
  }

  completeRun(runId: string, input: RunCompletionInput): void {
    const finishedAt = nowIso()
    const run = this.transaction(() => {
      this.db
        .prepare(
          `
      UPDATE runs
      SET
        status = ?,
        session_display_id = ?,
        response_text = ?,
        error_text = ?,
        usage_json = ?,
        branch_name = ?,
        pr_number = ?,
        head_sha = ?,
        verification_summary = ?,
        review_verdict = ?,
        promotion_record_id = ?,
        cost_cents = ?,
        retry_class = ?,
        metadata_json = COALESCE(metadata_json, NULL),
        finished_at = ?,
        updated_at = ?
      WHERE id = ?
      `
        )
        .run(
          input.status,
          input.sessionDisplayId ?? null,
          boundRunText(input.responseText),
          boundRunText(input.errorText),
          input.usage ? JSON.stringify(input.usage) : null,
          input.branchName ?? null,
          input.prNumber ?? null,
          input.headSha ?? null,
          boundRunText(input.verificationSummary),
          input.reviewVerdict ?? null,
          input.promotionRecordId ?? null,
          input.costCents ?? null,
          input.retryClass ?? "none",
          finishedAt,
          finishedAt,
          runId
        )

      const assignmentStatus: Exclude<TeamAssignmentStatus, "active"> =
        input.status === "succeeded" ? "completed" : input.status === "failed" ? "failed" : "cancelled"
      this.releaseTeamAssignmentForRunUnsafe(runId, assignmentStatus, `run_${input.status}`, finishedAt)
      const completedRun = this.getRunById(runId)
      if (input.status === "succeeded") {
        this.clearTeamReviewerLockoutsForTaskUnsafe(completedRun.taskId, "independent_revision_completed", finishedAt)
      }
      return completedRun
    })

    const promptVariantId = run.metadata?.promptVariantId
    if (promptVariantId && typeof promptVariantId === "string") {
      const succeeded = input.status === "succeeded"
      this.recordPromptVariantTrial(promptVariantId, succeeded)
    }
  }

  updateRunReviewVerdict(runId: string, verdict: ReviewVerdict | null): Run {
    this.db
      .prepare(
        `
      UPDATE runs
      SET review_verdict = ?, updated_at = ?
      WHERE id = ?
      `
      )
      .run(verdict, nowIso(), runId)
    return this.getRunById(runId)
  }

  updateRunMetadata(runId: string, patch: Record<string, unknown> | null): Run {
    const run = this.getRunById(runId)
    const nextMetadata =
      patch === null
        ? null
        : {
            ...(run.metadata ?? {}),
            ...patch
          }
    this.db
      .prepare("UPDATE runs SET metadata_json = ?, updated_at = ? WHERE id = ?")
      .run(nextMetadata ? JSON.stringify(nextMetadata) : null, nowIso(), runId)
    return this.getRunById(runId)
  }

  updateRunWorkspace(
    runId: string,
    patch: {
      branchName?: string | null
      headSha?: string | null
      worktreePath?: string | null
      manifestPath?: string | null
    }
  ): Run {
    const current = this.getRunById(runId)
    const updatedAt = nowIso()
    this.db
      .prepare(
        `
      UPDATE runs
      SET branch_name = ?, head_sha = ?, worktree_path = ?, manifest_path = ?, updated_at = ?
      WHERE id = ?
      `
      )
      .run(
        patch.branchName === undefined ? current.branchName : patch.branchName,
        patch.headSha === undefined ? current.headSha : patch.headSha,
        patch.worktreePath === undefined ? current.worktreePath : patch.worktreePath,
        patch.manifestPath === undefined ? current.manifestPath : patch.manifestPath,
        updatedAt,
        runId
      )
    return this.getRunById(runId)
  }

  getLatestSuccessfulImplementationRunForTask(taskId: string): Run | null {
    const row = this.db
      .prepare(
        `
      SELECT *
      FROM runs
      WHERE task_id = ?
        AND status = 'succeeded'
        AND kind IN ('implement', 'fix_review_feedback')
        AND branch_name IS NOT NULL
      ORDER BY finished_at DESC, created_at DESC
      LIMIT 1
      `
      )
      .get(taskId)
    return row ? mapRun(row as Record<string, unknown>) : null
  }

  getLatestPreservedExecutionRunForTask(taskId: string, excludeRunId?: string): Run | null {
    const row = this.db
      .prepare(
        `
      SELECT *
      FROM runs
      WHERE task_id = ?
        AND (? IS NULL OR id != ?)
        AND kind IN ('implement', 'repair', 'fix_review_feedback')
        AND branch_name IS NOT NULL
        AND head_sha IS NOT NULL
        AND worktree_path IS NOT NULL
        AND error_text LIKE '%Implementation worktree preserved for repair:%'
      ORDER BY finished_at DESC, created_at DESC
      LIMIT 1
      `
      )
      .get(taskId, excludeRunId ?? null, excludeRunId ?? null)
    return row ? mapRun(row as Record<string, unknown>) : null
  }

  listRuns(limit = 20): Run[] {
    const rows = this.db.prepare("SELECT * FROM runs ORDER BY created_at DESC LIMIT ?").all(limit)
    return rows.map((row) => mapRun(row as Record<string, unknown>))
  }

  listProjectRuns(projectId: string): Run[] {
    const rows = this.db.prepare("SELECT * FROM runs WHERE project_id = ? ORDER BY created_at ASC").all(projectId)
    return rows.map((row) => mapRun(row as Record<string, unknown>))
  }

  listRunningRuns(companyId?: string): Run[] {
    const query = companyId
      ? this.db.prepare(
          "SELECT * FROM runs WHERE company_id = ? AND status = 'running' ORDER BY started_at ASC, created_at ASC"
        )
      : this.db.prepare("SELECT * FROM runs WHERE status = 'running' ORDER BY started_at ASC, created_at ASC")
    const rows = companyId ? query.all(companyId) : query.all()
    return rows.map((row) => mapRun(row as Record<string, unknown>))
  }

  getLatestRunForTask(taskId: string): Run | null {
    const row = this.db.prepare("SELECT * FROM runs WHERE task_id = ? ORDER BY created_at DESC LIMIT 1").get(taskId)
    return row ? mapRun(row as Record<string, unknown>) : null
  }

  getRunById(id: string): Run {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id)
    if (!row) throw new Error(`Run not found: ${id}`)
    return mapRun(row as Record<string, unknown>)
  }

  appendRunEvent(
    runId: string,
    level: RunEvent["level"],
    message: string,
    data: Record<string, unknown> | null = null
  ): RunEvent {
    const seqRow = this.db
      .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM run_events WHERE run_id = ?")
      .get(runId) as Record<string, unknown>
    const id = randomUUID()
    const createdAt = nowIso()
    const safeMessage = redactLogText(message)
    const safeData = data ? boundRunEventData(redactLogValue(data)) : null

    this.db
      .prepare(
        `
      INSERT INTO run_events (id, run_id, seq, level, message, data_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        id,
        runId,
        Number(seqRow.next_seq),
        level,
        safeMessage,
        safeData ? JSON.stringify(safeData) : null,
        createdAt
      )

    return {
      id,
      runId,
      seq: Number(seqRow.next_seq),
      level,
      message: safeMessage,
      data: safeData,
      createdAt
    }
  }

  getRunEvents(runId: string): RunEvent[] {
    const rows = this.db.prepare("SELECT * FROM run_events WHERE run_id = ? ORDER BY seq ASC").all(runId)
    return rows.map((row) => mapRunEvent(row as Record<string, unknown>))
  }

  createReviewResult(input: CreateReviewResultInput): ReviewResult {
    const id = randomUUID()
    const createdAt = nowIso()
    this.db
      .prepare(
        `
      INSERT INTO review_results (
        id,
        company_id,
        project_id,
        run_id,
        task_id,
        reviewer_run_id,
        outcome,
        summary,
        findings_json,
        severity,
        changed_files_json,
        risk_level,
        required_fixes_json,
        suggested_repair_prompt,
        promotion_recommendation,
        inspected_diff,
        inspected_task_prompt,
        inspected_acceptance_criteria,
        inspected_verification_output,
        inspected_architecture_rules,
        repair_task_id,
        approved_by,
        approved_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)
      `
      )
      .run(
        id,
        input.companyId,
        input.projectId,
        input.runId,
        input.taskId,
        input.reviewerRunId ?? null,
        input.outcome,
        input.summary,
        JSON.stringify(input.findings ?? []),
        input.severity,
        JSON.stringify(input.changedFiles ?? []),
        input.riskLevel,
        JSON.stringify(input.requiredFixes ?? []),
        input.suggestedRepairPrompt,
        input.promotionRecommendation,
        input.inspectedDiff ?? null,
        input.inspectedTaskPrompt ?? null,
        input.inspectedAcceptanceCriteria ?? null,
        input.inspectedVerificationOutput ?? null,
        input.inspectedArchitectureRules ?? null,
        createdAt,
        createdAt
      )
    return this.getReviewResultById(id)
  }

  updateReviewResult(reviewId: string, patch: UpdateReviewResultInput): ReviewResult {
    const review = this.getReviewResultById(reviewId)
    this.db
      .prepare(
        `
      UPDATE review_results
      SET repair_task_id = ?, approved_by = ?, approved_at = ?, updated_at = ?
      WHERE id = ?
      `
      )
      .run(
        patch.repairTaskId === undefined ? review.repairTaskId : patch.repairTaskId,
        patch.approvedBy === undefined ? review.approvedBy : patch.approvedBy,
        patch.approvedAt === undefined ? review.approvedAt : patch.approvedAt,
        nowIso(),
        reviewId
      )
    return this.getReviewResultById(reviewId)
  }

  getReviewResultById(id: string): ReviewResult {
    const row = this.db.prepare("SELECT * FROM review_results WHERE id = ?").get(id)
    if (!row) throw new Error(`Review result not found: ${id}`)
    return mapReviewResult(row as Record<string, unknown>)
  }

  getLatestReviewResultForRun(runId: string): ReviewResult | null {
    const row = this.db
      .prepare("SELECT * FROM review_results WHERE run_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(runId)
    return row ? mapReviewResult(row as Record<string, unknown>) : null
  }

  getLatestReviewResultForTask(taskId: string): ReviewResult | null {
    const row = this.db
      .prepare("SELECT * FROM review_results WHERE task_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(taskId)
    return row ? mapReviewResult(row as Record<string, unknown>) : null
  }

  listReviewResults(input: { companyId?: string; projectId?: string; outcome?: ReviewOutcome } = {}): ReviewResult[] {
    const clauses: string[] = []
    const values: SQLInputValue[] = []
    if (input.companyId) {
      clauses.push("company_id = ?")
      values.push(input.companyId)
    }
    if (input.projectId) {
      clauses.push("project_id = ?")
      values.push(input.projectId)
    }
    if (input.outcome) {
      clauses.push("outcome = ?")
      values.push(input.outcome)
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""
    const rows = this.db.prepare(`SELECT * FROM review_results ${where} ORDER BY created_at DESC`).all(...values)
    return rows.map((row) => mapReviewResult(row as Record<string, unknown>))
  }

  createRepairTaskFromReview(reviewId: string): Task {
    const review = this.getReviewResultById(reviewId)
    if (review.repairTaskId) {
      return this.getTaskById(review.repairTaskId)
    }
    const originalTask = this.getTaskById(review.taskId)
    const repairTask = this.createTask({
      projectRef: originalTask.projectId,
      workflowId: originalTask.workflowId,
      personaRef: originalTask.personaId,
      stage: originalTask.stage === "reviewer" ? "coder" : originalTask.stage,
      dependsOnTaskIds: [],
      priority: originalTask.priority + 10,
      source: "manual",
      title: `Repair review findings: ${originalTask.title}`,
      description: review.suggestedRepairPrompt,
      labels: Array.from(new Set([...originalTask.labels, "review-repair"])),
      changedFiles: review.changedFiles.length > 0 ? review.changedFiles : originalTask.changedFiles,
      taskPackage: originalTask.taskPackage,
      kind: "fix_review_feedback",
      parentTaskId: originalTask.id,
      requestedAdapterType: originalTask.requestedAdapterType,
      laneId: originalTask.laneId,
      allowedPaths: originalTask.allowedPaths,
      requiredReading: originalTask.requiredReading,
      verificationCommands: originalTask.verificationCommands,
      lineageRootId: originalTask.lineageRootId ?? originalTask.id,
      lineageParentId: originalTask.id,
      taskPackagePath: originalTask.taskPackagePath,
      artifactDir: originalTask.artifactDir,
      reviewRequired: true,
      approvalRequired: review.riskLevel === "high" || review.riskLevel === "critical",
      maxRetries: 1
    })
    const sourceRun = this.getRunById(review.runId)
    if (sourceRun.agentId && repairTask.changedFiles.length > 0) {
      const reviewerRun = review.reviewerRunId ? this.getRunById(review.reviewerRunId) : null
      const reviewerAgent = reviewerRun?.agentId ? this.getAgentById(reviewerRun.agentId) : null
      const sourceAssignment = this.getTeamAssignmentByRunId(sourceRun.id)
      this.createTeamReviewerLockouts({
        companyId: repairTask.companyId,
        projectId: repairTask.projectId,
        taskId: repairTask.id,
        sourceTaskId: originalTask.id,
        sourceRunId: sourceRun.id,
        sourceAssignmentId: sourceAssignment?.id ?? null,
        lockedAgentId: sourceRun.agentId,
        reviewerAgentId: reviewerAgent?.id ?? null,
        reviewerActor: reviewerAgent?.name ?? review.approvedBy ?? "reviewer",
        artifactPaths: repairTask.changedFiles,
        reason: review.summary
      })
    }
    this.updateReviewResult(review.id, { repairTaskId: repairTask.id })
    this.appendTaskEvent(originalTask.id, "review-repair-task-created", "Created repair task from review findings.", {
      reviewId: review.id,
      repairTaskId: repairTask.id,
      outcome: review.outcome
    })
    return repairTask
  }

  createDirectorDecision(input: CreateDirectorDecisionInput): DirectorDecisionRecord {
    const id = randomUUID()
    const createdAt = nowIso()
    this.db
      .prepare(
        `
      INSERT INTO director_decisions (
        id,
        company_id,
        project_id,
        profile_id,
        cycle_id,
        pass_index,
        action,
        status,
        dry_run,
        reason,
        stop_reason,
        risk_score,
        risk_threshold,
        quota_used,
        quota_limit,
        loop_limit,
        input_json,
        result_json,
        created_at,
        completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        id,
        input.companyId,
        input.projectId,
        input.profileId ?? null,
        input.cycleId,
        input.passIndex,
        input.action,
        input.status ?? "planned",
        input.dryRun ? 1 : 0,
        input.reason,
        input.stopReason ?? null,
        input.riskScore,
        input.riskThreshold,
        input.quotaUsed,
        input.quotaLimit,
        input.loopLimit,
        JSON.stringify(input.input),
        input.result ? JSON.stringify(input.result) : null,
        createdAt,
        input.status && input.status !== "planned" ? createdAt : null
      )
    return this.getDirectorDecisionById(id)
  }

  completeDirectorDecision(decisionId: string, input: CompleteDirectorDecisionInput): DirectorDecisionRecord {
    const completedAt = nowIso()
    this.db
      .prepare(
        `
      UPDATE director_decisions
      SET
        status = ?,
        stop_reason = ?,
        result_json = ?,
        completed_at = ?
      WHERE id = ?
      `
      )
      .run(
        input.status,
        input.stopReason ?? null,
        input.result ? JSON.stringify(input.result) : null,
        completedAt,
        decisionId
      )
    return this.getDirectorDecisionById(decisionId)
  }

  getDirectorDecisionById(id: string): DirectorDecisionRecord {
    const row = this.db.prepare("SELECT * FROM director_decisions WHERE id = ?").get(id)
    if (!row) throw new Error(`Director decision not found: ${id}`)
    return mapDirectorDecision(row as Record<string, unknown>)
  }

  getLatestDirectorDecision(projectId?: string | null): DirectorDecisionRecord | null {
    const row = projectId
      ? this.db
          .prepare("SELECT * FROM director_decisions WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
          .get(projectId)
      : this.db.prepare("SELECT * FROM director_decisions ORDER BY created_at DESC, rowid DESC LIMIT 1").get()
    return row ? mapDirectorDecision(row as Record<string, unknown>) : null
  }

  listDirectorDecisions(
    options: { projectId?: string | null; cycleId?: string | null; limit?: number } = {}
  ): DirectorDecisionRecord[] {
    const clauses: string[] = []
    const params: SQLInputValue[] = []
    if (options.projectId) {
      clauses.push("project_id = ?")
      params.push(options.projectId)
    }
    if (options.cycleId) {
      clauses.push("cycle_id = ?")
      params.push(options.cycleId)
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""
    const limit = options.limit ?? 20
    return this.db
      .prepare(`SELECT * FROM director_decisions ${where} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(...params, limit)
      .map((row) => mapDirectorDecision(row as Record<string, unknown>))
  }

  createInterpretedCommand(input: CreateInterpretedCommandInput): InterpretedCommandRecord {
    const id = randomUUID()
    const createdAt = nowIso()
    this.db
      .prepare(
        `
      INSERT INTO interpreted_commands (
        id,
        company_id,
        project_id,
        utterance,
        intent,
        status,
        dry_run,
        yes,
        structured_json,
        result_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        id,
        input.companyId ?? null,
        input.projectId ?? null,
        input.utterance,
        input.intent,
        input.status,
        input.dryRun ? 1 : 0,
        input.yes ? 1 : 0,
        JSON.stringify(input.structured),
        input.result ? JSON.stringify(input.result) : null,
        createdAt,
        createdAt
      )
    return this.getInterpretedCommandById(id)
  }

  updateInterpretedCommand(id: string, input: UpdateInterpretedCommandInput): InterpretedCommandRecord {
    const updatedAt = nowIso()
    this.db
      .prepare(
        `
      UPDATE interpreted_commands
      SET status = ?, result_json = ?, updated_at = ?
      WHERE id = ?
      `
      )
      .run(input.status, input.result ? JSON.stringify(input.result) : null, updatedAt, id)
    return this.getInterpretedCommandById(id)
  }

  getInterpretedCommandById(id: string): InterpretedCommandRecord {
    const row = this.db.prepare("SELECT * FROM interpreted_commands WHERE id = ?").get(id)
    if (!row) throw new Error(`Interpreted command not found: ${id}`)
    return mapInterpretedCommand(row as Record<string, unknown>)
  }

  listInterpretedCommands(limit = 20): InterpretedCommandRecord[] {
    return this.db
      .prepare("SELECT * FROM interpreted_commands ORDER BY created_at DESC, rowid DESC LIMIT ?")
      .all(limit)
      .map((row) => mapInterpretedCommand(row as Record<string, unknown>))
  }

  createHandoff(input: CreateHandoffInput): HandoffRecord {
    const project = this.resolveProject(input.projectRef)
    if (input.sourceTaskId) {
      const sourceTask = this.getTaskById(input.sourceTaskId)
      if (sourceTask.projectId !== project.id) {
        throw new Error(`Source task ${input.sourceTaskId} does not belong to project ${project.id}.`)
      }
    }
    const id = randomUUID()
    const createdAt = nowIso()
    const artifact = redactLogValue(buildHandoffArtifact(input, id, createdAt))
    const artifactPath = input.artifactPath ?? join(project.repoPath, ".openclaw", "handoffs", `${id}.json`)
    mkdirSync(dirname(artifactPath), { recursive: true })
    writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8")

    this.db
      .prepare(
        `
      INSERT INTO handoffs (
        id,
        company_id,
        project_id,
        source_persona,
        target_persona,
        source_task_id,
        target_task_id,
        artifact_path,
        status,
        artifact_json,
        accepted_at,
        accepted_by,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
      `
      )
      .run(
        id,
        project.companyId,
        project.id,
        artifact.sourcePersona,
        artifact.targetPersona,
        artifact.sourceTaskId,
        artifact.targetTaskId,
        artifactPath,
        "open",
        JSON.stringify(artifact),
        createdAt,
        createdAt
      )

    if (artifact.sourceTaskId) {
      this.appendTaskEvent(artifact.sourceTaskId, "handoff-created", "Created persona handoff.", {
        handoffId: id,
        sourcePersona: artifact.sourcePersona,
        targetPersona: artifact.targetPersona,
        artifactPath
      })
    }

    return this.getHandoffById(id)
  }

  getHandoffById(id: string): HandoffRecord {
    const row = this.db.prepare("SELECT * FROM handoffs WHERE id = ?").get(id)
    if (!row) throw new Error(`Handoff not found: ${id}`)
    return mapHandoffRecord(row as Record<string, unknown>)
  }

  listHandoffs(
    options: { projectId?: string | null; status?: HandoffStatus | null; limit?: number } = {}
  ): HandoffRecord[] {
    const clauses: string[] = []
    const params: SQLInputValue[] = []
    if (options.projectId) {
      clauses.push("project_id = ?")
      params.push(options.projectId)
    }
    if (options.status) {
      clauses.push("status = ?")
      params.push(options.status)
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""
    const limit = options.limit ?? 50
    return this.db
      .prepare(`SELECT * FROM handoffs ${where} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(...params, limit)
      .map((row) => mapHandoffRecord(row as Record<string, unknown>))
  }

  acceptHandoff(handoffId: string, input: AcceptHandoffInput = {}): HandoffRecord {
    const handoff = this.getHandoffById(handoffId)
    if (handoff.status !== "open") {
      throw new Error(`Handoff ${handoffId} is ${handoff.status}; only open handoffs can be accepted.`)
    }
    if (input.targetTaskId) {
      const targetTask = this.getTaskById(input.targetTaskId)
      if (targetTask.projectId !== handoff.projectId) {
        throw new Error(`Target task ${input.targetTaskId} does not belong to project ${handoff.projectId}.`)
      }
    }
    const updatedAt = nowIso()
    const status = input.status ?? "accepted"
    this.db
      .prepare(
        `
      UPDATE handoffs
      SET
        target_task_id = ?,
        status = ?,
        accepted_at = ?,
        accepted_by = ?,
        updated_at = ?
      WHERE id = ?
      `
      )
      .run(
        input.targetTaskId ?? handoff.targetTaskId,
        status,
        updatedAt,
        input.acceptedBy ?? null,
        updatedAt,
        handoffId
      )

    if (input.targetTaskId) {
      this.appendTaskEvent(input.targetTaskId, "handoff-accepted", "Accepted persona handoff.", {
        handoffId,
        sourcePersona: handoff.sourcePersona,
        targetPersona: handoff.targetPersona,
        artifactPath: handoff.artifactPath
      })
    }

    return this.getHandoffById(handoffId)
  }

  appendTaskEvent(
    taskId: string,
    kind: string,
    message: string,
    data: Record<string, unknown> | null = null
  ): TaskEvent {
    const id = randomUUID()
    const createdAt = nowIso()
    const safeMessage = redactLogText(message)
    const safeData = data ? boundRunEventData(redactLogValue(data)) : null
    this.db
      .prepare(
        `
      INSERT INTO task_events (id, task_id, kind, message, data_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      `
      )
      .run(id, taskId, kind, safeMessage, safeData ? JSON.stringify(safeData) : null, createdAt)

    return {
      id,
      taskId,
      kind,
      message: safeMessage,
      data: safeData,
      createdAt
    }
  }

  getTaskEvents(taskId: string): TaskEvent[] {
    return this.db
      .prepare("SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at ASC")
      .all(taskId)
      .map((row) => mapTaskEvent(row as Record<string, unknown>))
  }

  clearRepoHealthFailureGuard(
    projectId: string,
    input: { reason?: string | null; actor?: string | null } = {}
  ): TaskEvent | null {
    const repoHealthTasks = this.listProjectTasks(projectId).filter(
      (task) => task.source === "repo_health" || task.labels.includes("repo-health")
    )
    let latestRecord: { task: Task; event: TaskEvent } | null = null

    for (const task of repoHealthTasks) {
      for (const event of this.getTaskEvents(task.id)) {
        if (event.kind !== "repo-health-guard-recorded") continue
        if (!latestRecord || event.createdAt > latestRecord.event.createdAt) {
          latestRecord = { task, event }
        }
      }
    }

    if (!latestRecord) {
      return null
    }

    return this.appendTaskEvent(
      latestRecord.task.id,
      "repo-health-guard-cleared",
      input.reason?.trim() || "Operator cleared repo health sweep failure guard.",
      {
        actor: input.actor?.trim() || "operator",
        clearedGuardTaskId: latestRecord.task.id,
        clearedGuardEventId: latestRecord.event.id
      }
    )
  }

  recordTaskOutcome(input: RecordTaskOutcomeInput): TaskOutcome {
    const id = randomUUID()
    const createdAt = nowIso()
    this.db
      .prepare(
        `
      INSERT INTO task_outcomes (
        id, company_id, project_id, task_id, run_id, lane_id, stage, adapter_type,
        result, reason, verification_passed, review_verdict, retry_count, turns,
        cost_cents, tokens_total, duration_ms, reflection, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        id,
        input.companyId,
        input.projectId,
        input.taskId,
        input.runId ?? null,
        input.laneId ?? null,
        input.stage,
        input.adapterType ?? null,
        input.result,
        input.reason ?? null,
        input.verificationPassed === null || input.verificationPassed === undefined
          ? null
          : input.verificationPassed
            ? 1
            : 0,
        input.reviewVerdict ?? null,
        input.retryCount ?? 0,
        input.turns ?? null,
        input.costCents ?? null,
        input.tokensTotal ?? null,
        input.durationMs ?? null,
        input.reflection ?? null,
        input.metadata ? JSON.stringify(input.metadata) : null,
        createdAt
      )
    return this.getTaskOutcomeById(id)
  }

  getTaskOutcomeById(id: string): TaskOutcome {
    const row = this.db.prepare("SELECT * FROM task_outcomes WHERE id = ?").get(id)
    if (!row) {
      throw new Error(`Task outcome not found: ${id}`)
    }
    return mapTaskOutcome(row as Record<string, unknown>)
  }

  listTaskOutcomes(projectId: string, limit = 200): TaskOutcome[] {
    return this.db
      .prepare("SELECT * FROM task_outcomes WHERE project_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(projectId, limit)
      .map((row) => mapTaskOutcome(row as Record<string, unknown>))
  }

  /**
   * Aggregated per-lane track record over the most recent outcomes. This is the
   * feedback signal the planner consumes to become adaptive rather than merely
   * reactive.
   */
  getLaneOutcomeStats(projectId: string, sampleSize = 500): LaneOutcomeStats[] {
    const outcomes = this.listTaskOutcomes(projectId, sampleSize)
    return aggregateLaneOutcomeStats(outcomes)
  }

  upsertPromptVariant(input: UpsertPromptVariantInput): PromptVariant {
    const existing = this.db
      .prepare("SELECT * FROM prompt_variants WHERE project_id = ? AND scope = ? AND prompt_hash = ?")
      .get(input.projectId, input.scope, input.promptHash)
    const now = nowIso()
    if (existing) {
      const current = mapPromptVariant(existing as Record<string, unknown>)
      this.db
        .prepare("UPDATE prompt_variants SET label = ?, status = ?, updated_at = ? WHERE id = ?")
        .run(input.label ?? current.label, input.status ?? current.status, now, current.id)
      return this.getPromptVariantById(current.id)
    }
    const id = randomUUID()
    this.db
      .prepare(
        `
      INSERT INTO prompt_variants (id, project_id, scope, label, prompt_hash, status, trials, successes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
      `
      )
      .run(id, input.projectId, input.scope, input.label, input.promptHash, input.status ?? "candidate", now, now)
    return this.getPromptVariantById(id)
  }

  getPromptVariantById(id: string): PromptVariant {
    const row = this.db.prepare("SELECT * FROM prompt_variants WHERE id = ?").get(id)
    if (!row) {
      throw new Error(`Prompt variant not found: ${id}`)
    }
    return mapPromptVariant(row as Record<string, unknown>)
  }

  listPromptVariants(projectId: string, scope?: string): PromptVariant[] {
    const rows = scope
      ? this.db
          .prepare("SELECT * FROM prompt_variants WHERE project_id = ? AND scope = ? ORDER BY created_at ASC")
          .all(projectId, scope)
      : this.db.prepare("SELECT * FROM prompt_variants WHERE project_id = ? ORDER BY created_at ASC").all(projectId)
    return rows.map((row) => mapPromptVariant(row as Record<string, unknown>))
  }

  recordPromptVariantTrial(id: string, succeeded: boolean): PromptVariant {
    this.db
      .prepare("UPDATE prompt_variants SET trials = trials + 1, successes = successes + ?, updated_at = ? WHERE id = ?")
      .run(succeeded ? 1 : 0, nowIso(), id)
    return this.getPromptVariantById(id)
  }

  getSessionState(sessionKey: string): SessionState | null {
    const row = this.db.prepare("SELECT * FROM session_states WHERE session_key = ?").get(sessionKey)
    return row ? mapSessionState(row as Record<string, unknown>) : null
  }

  upsertSessionState(input: {
    sessionKey: string
    companyId: string
    projectId: string
    taskId: string
    agentId: string
    adapterType: AdapterType
    sessionDisplayId?: string | null
    state: Record<string, unknown>
  }): SessionState {
    const updatedAt = nowIso()
    this.db
      .prepare(
        `
      INSERT INTO session_states (
        session_key,
        company_id,
        project_id,
        task_id,
        agent_id,
        adapter_type,
        session_display_id,
        state_json,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_key) DO UPDATE SET
        company_id = excluded.company_id,
        project_id = excluded.project_id,
        task_id = excluded.task_id,
        agent_id = excluded.agent_id,
        adapter_type = excluded.adapter_type,
        session_display_id = excluded.session_display_id,
        state_json = excluded.state_json,
        updated_at = excluded.updated_at
      `
      )
      .run(
        input.sessionKey,
        input.companyId,
        input.projectId,
        input.taskId,
        input.agentId,
        input.adapterType,
        input.sessionDisplayId ?? null,
        JSON.stringify(input.state),
        updatedAt
      )

    return this.getSessionState(input.sessionKey)!
  }

  listMemoryChunks(projectId: string, audiences?: MemoryAudience[], sourceKinds?: MemorySourceKind[]): MemoryChunk[] {
    const clauses = ["project_id = ?"]
    const params: Array<string | number> = [projectId]

    if (audiences && audiences.length > 0) {
      clauses.push(`audience IN (${audiences.map(() => "?").join(", ")})`)
      params.push(...audiences)
    }

    if (sourceKinds && sourceKinds.length > 0) {
      clauses.push(`source_kind IN (${sourceKinds.map(() => "?").join(", ")})`)
      params.push(...sourceKinds)
    }

    const rows = this.db
      .prepare(`SELECT * FROM memory_chunks WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC, created_at DESC`)
      .all(...params)
    return rows.map((row) => mapMemoryChunk(row as Record<string, unknown>))
  }

  findMemoryChunk(projectId: string, sourceKind: MemorySourceKind, sourceRef: string): MemoryChunk | null {
    const row = this.db
      .prepare("SELECT * FROM memory_chunks WHERE project_id = ? AND source_kind = ? AND source_ref = ?")
      .get(projectId, sourceKind, sourceRef)
    return row ? mapMemoryChunk(row as Record<string, unknown>) : null
  }

  upsertMemoryChunk(input: UpsertMemoryChunkInput): { chunk: MemoryChunk; changed: boolean } {
    const existing = this.findMemoryChunk(input.projectId, input.sourceKind, input.sourceRef)
    if (existing) {
      const nextMetadata = input.metadata ?? {}
      const nextProvenance = input.provenance ?? existing.provenance
      const nextRetention = input.retention ?? existing.retention
      const metadataJson = JSON.stringify(nextMetadata)
      const provenanceJson = JSON.stringify(nextProvenance)
      const retentionJson = JSON.stringify(nextRetention)
      const metadataChanged = JSON.stringify(existing.metadata) !== metadataJson
      const provenanceChanged = JSON.stringify(existing.provenance) !== provenanceJson
      const retentionChanged = JSON.stringify(existing.retention) !== retentionJson
      const changed =
        existing.layer !== input.layer ||
        existing.sourcePath !== (input.sourcePath ?? null) ||
        existing.audience !== input.audience ||
        existing.lifecycleStatus !== (input.lifecycleStatus ?? existing.lifecycleStatus) ||
        existing.title !== input.title ||
        existing.contentHash !== input.contentHash ||
        existing.content !== input.content ||
        existing.freshnessScore !== (input.freshnessScore ?? existing.freshnessScore) ||
        existing.expiresAt !== (input.expiresAt ?? existing.expiresAt) ||
        existing.compactedAt !== (input.compactedAt ?? existing.compactedAt) ||
        existing.supersededByChunkId !== (input.supersededByChunkId ?? existing.supersededByChunkId) ||
        provenanceChanged ||
        retentionChanged ||
        metadataChanged

      if (!changed) {
        return { chunk: existing, changed: false }
      }

      this.db
        .prepare(
          `
        UPDATE memory_chunks
        SET
          layer = ?,
          source_path = ?,
          audience = ?,
          lifecycle_status = ?,
          title = ?,
          content = ?,
          content_hash = ?,
          freshness_score = ?,
          expires_at = ?,
          compacted_at = ?,
          superseded_by_chunk_id = ?,
          provenance_json = ?,
          retention_json = ?,
          metadata_json = ?,
          updated_at = ?
        WHERE id = ?
        `
        )
        .run(
          input.layer,
          input.sourcePath ?? null,
          input.audience,
          input.lifecycleStatus ?? existing.lifecycleStatus,
          input.title,
          input.content,
          input.contentHash,
          input.freshnessScore ?? existing.freshnessScore,
          input.expiresAt ?? existing.expiresAt,
          input.compactedAt ?? existing.compactedAt,
          input.supersededByChunkId ?? existing.supersededByChunkId,
          provenanceJson,
          retentionJson,
          metadataJson,
          nowIso(),
          existing.id
        )
      return {
        chunk: this.findMemoryChunk(input.projectId, input.sourceKind, input.sourceRef)!,
        changed: true
      }
    }

    const id = randomUUID()
    const createdAt = nowIso()
    this.db
      .prepare(
        `
      INSERT INTO memory_chunks (
        id,
        project_id,
        layer,
        source_kind,
        source_ref,
        source_path,
        audience,
        lifecycle_status,
        title,
        content,
        content_hash,
        freshness_score,
        expires_at,
        compacted_at,
        superseded_by_chunk_id,
        provenance_json,
        retention_json,
        metadata_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        id,
        input.projectId,
        input.layer,
        input.sourceKind,
        input.sourceRef,
        input.sourcePath ?? null,
        input.audience,
        input.lifecycleStatus ?? "ready",
        input.title,
        input.content,
        input.contentHash,
        input.freshnessScore ?? null,
        input.expiresAt ?? null,
        input.compactedAt ?? null,
        input.supersededByChunkId ?? null,
        JSON.stringify(input.provenance ?? defaultMemoryProvenance(createdAt)),
        JSON.stringify(input.retention ?? defaultMemoryRetention()),
        JSON.stringify(input.metadata ?? {}),
        createdAt,
        createdAt
      )

    return {
      chunk: this.findMemoryChunk(input.projectId, input.sourceKind, input.sourceRef)!,
      changed: true
    }
  }

  deleteMemoryChunksForSource(projectId: string, sourceKind: MemorySourceKind, sourceRefs: string[]): number {
    if (sourceRefs.length === 0) return 0
    const placeholders = sourceRefs.map(() => "?").join(", ")
    const result = this.db
      .prepare(`DELETE FROM memory_chunks WHERE project_id = ? AND source_kind = ? AND source_ref IN (${placeholders})`)
      .run(projectId, sourceKind, ...sourceRefs)
    return Number(result.changes)
  }

  listMemoryEmbeddings(chunkIds: string[], provider: string, model: string): MemoryEmbedding[] {
    if (chunkIds.length === 0) return []
    const placeholders = chunkIds.map(() => "?").join(", ")
    const rows = this.db
      .prepare(`SELECT * FROM memory_embeddings WHERE provider = ? AND model = ? AND chunk_id IN (${placeholders})`)
      .all(provider, model, ...chunkIds)
    return rows.map((row) => mapMemoryEmbedding(row as Record<string, unknown>))
  }

  upsertMemoryEmbedding(input: {
    chunkId: string
    provider: string
    model: string
    dimensions: number
    vector: number[]
  }): MemoryEmbedding {
    const current = this.db
      .prepare("SELECT * FROM memory_embeddings WHERE chunk_id = ? AND provider = ? AND model = ?")
      .get(input.chunkId, input.provider, input.model)
    const updatedAt = nowIso()
    if (current) {
      this.db
        .prepare(
          `
        UPDATE memory_embeddings
        SET
          dimensions = ?,
          vector_json = ?,
          updated_at = ?
        WHERE chunk_id = ? AND provider = ? AND model = ?
        `
        )
        .run(input.dimensions, JSON.stringify(input.vector), updatedAt, input.chunkId, input.provider, input.model)
    } else {
      this.db
        .prepare(
          `
        INSERT INTO memory_embeddings (
          id,
          chunk_id,
          provider,
          model,
          dimensions,
          vector_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `
        )
        .run(
          randomUUID(),
          input.chunkId,
          input.provider,
          input.model,
          input.dimensions,
          JSON.stringify(input.vector),
          updatedAt,
          updatedAt
        )
    }

    const row = this.db
      .prepare("SELECT * FROM memory_embeddings WHERE chunk_id = ? AND provider = ? AND model = ?")
      .get(input.chunkId, input.provider, input.model)
    return mapMemoryEmbedding(row as Record<string, unknown>)
  }

  deleteMemoryEmbedding(chunkId: string, provider: string, model: string): void {
    this.db
      .prepare("DELETE FROM memory_embeddings WHERE chunk_id = ? AND provider = ? AND model = ?")
      .run(chunkId, provider, model)
  }

  ensureApprovalRequest(taskId: string, reason: string): ApprovalRequest {
    const task = this.getTaskById(taskId)
    const existing = this.db
      .prepare(
        "SELECT * FROM approval_requests WHERE task_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1"
      )
      .get(taskId)
    if (existing) return mapApprovalRequest(existing as Record<string, unknown>)

    const id = randomUUID()
    const createdAt = nowIso()
    this.db
      .prepare(
        `
      INSERT INTO approval_requests (id, company_id, task_id, status, reason, created_at, decided_at, decided_by, notes)
      VALUES (?, ?, ?, 'pending', ?, ?, NULL, NULL, NULL)
      `
      )
      .run(id, task.companyId, taskId, reason, createdAt)

    return this.getLatestApprovalRequest(taskId)!
  }

  getLatestApprovalRequest(taskId: string): ApprovalRequest | null {
    const row = this.db
      .prepare("SELECT * FROM approval_requests WHERE task_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(taskId)
    return row ? mapApprovalRequest(row as Record<string, unknown>) : null
  }

  approveTask(taskId: string, decidedBy: string, notes: string | null = null): ApprovalRequest {
    const approval = this.getLatestApprovalRequest(taskId)
    if (!approval || approval.status !== "pending") {
      throw new Error(`Task ${taskId} does not have a pending approval request.`)
    }

    const decidedAt = nowIso()
    this.db
      .prepare(
        `
      UPDATE approval_requests
      SET status = 'approved', decided_at = ?, decided_by = ?, notes = ?
      WHERE id = ?
      `
      )
      .run(decidedAt, decidedBy, notes, approval.id)

    this.updateTaskStatus(taskId, "queued", { blockedReason: null })
    return this.getLatestApprovalRequest(taskId)!
  }

  listJobSpecs(companyId?: string): JobSpec[] {
    const rows = companyId
      ? this.db
          .prepare(
            "SELECT job_specs.* FROM job_specs JOIN projects ON projects.id = job_specs.project_id WHERE projects.company_id = ? ORDER BY project_id ASC, job_id ASC"
          )
          .all(companyId)
      : this.db.prepare("SELECT * FROM job_specs ORDER BY project_id ASC, job_id ASC").all()
    return rows.map((row) => mapJobSpec(row as Record<string, unknown>))
  }

  findJobSpec(projectId: string, jobId: JobId): JobSpec | null {
    const row = this.db
      .prepare("SELECT * FROM job_specs WHERE project_id = ? AND job_id = ? ORDER BY created_at ASC LIMIT 1")
      .get(projectId, jobId)
    return row ? mapJobSpec(row as Record<string, unknown>) : null
  }

  upsertJobSpec(input: UpsertJobSpecInput): JobSpec {
    const current = this.findJobSpec(input.projectId, input.jobId)
    const timestamp = nowIso()
    if (current) {
      this.db
        .prepare(
          `
        UPDATE job_specs
        SET
          source_path = ?,
          cron = ?,
          timezone = ?,
          entry_agent = ?,
          updated_at = ?
        WHERE id = ?
        `
        )
        .run(input.sourcePath, input.cron, input.timezone, input.entryAgent ?? null, timestamp, current.id)
      return this.findJobSpec(input.projectId, input.jobId)!
    }

    const id = randomUUID()
    this.db
      .prepare(
        `
      INSERT INTO job_specs (
        id,
        company_id,
        project_id,
        job_id,
        source_path,
        cron,
        timezone,
        entry_agent,
        last_triggered_at,
        last_result,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
      `
      )
      .run(
        id,
        input.companyId,
        input.projectId,
        input.jobId,
        input.sourcePath,
        input.cron,
        input.timezone,
        input.entryAgent ?? null,
        timestamp,
        timestamp
      )
    return this.findJobSpec(input.projectId, input.jobId)!
  }

  updateJobSpecRuntime(
    jobSpecId: string,
    patch: { lastTriggeredAt?: string | null; lastResult?: string | null }
  ): JobSpec {
    const current = this.db.prepare("SELECT * FROM job_specs WHERE id = ?").get(jobSpecId)
    if (!current) throw new Error(`Job spec not found: ${jobSpecId}`)
    const mapped = mapJobSpec(current as Record<string, unknown>)
    this.db
      .prepare(
        `
      UPDATE job_specs
      SET
        last_triggered_at = ?,
        last_result = ?,
        updated_at = ?
      WHERE id = ?
      `
      )
      .run(
        patch.lastTriggeredAt === undefined ? mapped.lastTriggeredAt : patch.lastTriggeredAt,
        patch.lastResult === undefined ? mapped.lastResult : patch.lastResult,
        nowIso(),
        jobSpecId
      )
    return mapJobSpec(this.db.prepare("SELECT * FROM job_specs WHERE id = ?").get(jobSpecId) as Record<string, unknown>)
  }

  createJobRun(input: {
    jobSpecId: string
    status?: JobRunStatus
    resultSummary?: string | null
    data?: Record<string, unknown> | null
    triggeredAt?: string
  }): JobRun {
    const id = randomUUID()
    const triggeredAt = input.triggeredAt ?? nowIso()
    this.db
      .prepare(
        `
      INSERT INTO job_runs (id, job_spec_id, status, triggered_at, completed_at, result_summary, data_json, created_at)
      VALUES (?, ?, ?, ?, NULL, ?, ?, ?)
      `
      )
      .run(
        id,
        input.jobSpecId,
        input.status ?? "succeeded",
        triggeredAt,
        input.resultSummary ?? null,
        input.data ? JSON.stringify(input.data) : null,
        triggeredAt
      )
    return mapJobRun(this.db.prepare("SELECT * FROM job_runs WHERE id = ?").get(id) as Record<string, unknown>)
  }

  completeJobRun(
    jobRunId: string,
    input: {
      status: JobRunStatus
      resultSummary?: string | null
      data?: Record<string, unknown> | null
      completedAt?: string
    }
  ): JobRun {
    const completedAt = input.completedAt ?? nowIso()
    this.db
      .prepare(
        `
      UPDATE job_runs
      SET
        status = ?,
        completed_at = ?,
        result_summary = ?,
        data_json = ?
      WHERE id = ?
      `
      )
      .run(
        input.status,
        completedAt,
        input.resultSummary ?? null,
        input.data ? JSON.stringify(input.data) : null,
        jobRunId
      )
    return mapJobRun(this.db.prepare("SELECT * FROM job_runs WHERE id = ?").get(jobRunId) as Record<string, unknown>)
  }

  listJobRuns(jobSpecId?: string): JobRun[] {
    const rows = jobSpecId
      ? this.db.prepare("SELECT * FROM job_runs WHERE job_spec_id = ? ORDER BY created_at DESC").all(jobSpecId)
      : this.db.prepare("SELECT * FROM job_runs ORDER BY created_at DESC").all()
    return rows.map((row) => mapJobRun(row as Record<string, unknown>))
  }

  listSessions(): SessionState[] {
    return this.db
      .prepare("SELECT * FROM session_states")
      .all()
      .map((row) => mapSessionState(row as Record<string, unknown>))
  }

  deleteSession(sessionKey: string): void {
    this.db.prepare("DELETE FROM session_states WHERE session_key = ?").run(sessionKey)
  }

  listLanes(projectId?: string): Array<{ id: string; status: "idle" | "running" | "review_needed"; taskId?: string }> {
    const tasks = projectId
      ? (this.db
          .prepare("SELECT id, lane_id, status FROM tasks WHERE project_id = ? AND lane_id IS NOT NULL")
          .all(projectId) as Array<{ id: string; lane_id: string; status: string }>)
      : (this.db.prepare("SELECT id, lane_id, status FROM tasks WHERE lane_id IS NOT NULL").all() as Array<{
          id: string
          lane_id: string
          status: string
        }>)

    const laneMap = new Map<string, { id: string; status: "idle" | "running" | "review_needed"; taskId?: string }>()

    for (const task of tasks) {
      const laneId = task.lane_id
      const current = laneMap.get(laneId)

      let status: "idle" | "running" | "review_needed" = "idle"
      if (task.status === "running") status = "running"
      else if (task.status === "review_needed" || task.status === "promotion_pending") status = "review_needed"

      if (!current || status === "running" || (status === "review_needed" && current.status === "idle")) {
        laneMap.set(laneId, { id: laneId, status, taskId: task.id })
      }
    }

    return Array.from(laneMap.values())
  }

  getPromotionByTaskId(taskId: string): PromotionRecord | null {
    const row = this.db
      .prepare("SELECT * FROM promotions WHERE task_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(taskId)
    return row ? mapPromotionRecord(row as Record<string, unknown>) : null
  }

  listPromotions(companyId?: string): PromotionRecord[] {
    const rows = companyId
      ? this.db.prepare("SELECT * FROM promotions WHERE company_id = ? ORDER BY created_at ASC").all(companyId)
      : this.db.prepare("SELECT * FROM promotions ORDER BY created_at ASC").all()
    return rows.map((row) => mapPromotionRecord(row as Record<string, unknown>))
  }

  createPromotion(input: CreatePromotionInput): PromotionRecord {
    const id = randomUUID()
    const createdAt = nowIso()
    this.db
      .prepare(
        `
      INSERT INTO promotions (
        id,
        company_id,
        project_id,
        workflow_id,
        task_id,
        branch_name,
        pr_number,
        pr_url,
        head_sha,
        base_branch,
        promotion_status,
        merge_method,
        last_review_sync_at,
        last_checks_sync_at,
        retry_count,
        last_error,
        created_at,
        updated_at,
        merged_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        id,
        input.companyId,
        input.projectId,
        input.workflowId ?? null,
        input.taskId,
        input.branchName,
        input.prNumber ?? null,
        input.prUrl ?? null,
        input.headSha ?? null,
        input.baseBranch ?? "main",
        input.promotionStatus ?? "pending_branch",
        input.mergeMethod ?? "squash",
        input.lastReviewSyncAt ?? null,
        input.lastChecksSyncAt ?? null,
        input.retryCount ?? 0,
        input.lastError ?? null,
        createdAt,
        createdAt,
        input.mergedAt ?? null
      )
    return this.getPromotionByTaskId(input.taskId)!
  }

  updatePromotion(promotionId: string, patch: UpdatePromotionInput): PromotionRecord {
    const current = this.db.prepare("SELECT * FROM promotions WHERE id = ?").get(promotionId)
    if (!current) throw new Error(`Promotion not found: ${promotionId}`)
    const promotion = mapPromotionRecord(current as Record<string, unknown>)
    this.db
      .prepare(
        `
      UPDATE promotions
      SET
        branch_name = ?,
        pr_number = ?,
        pr_url = ?,
        head_sha = ?,
        base_branch = ?,
        promotion_status = ?,
        merge_method = ?,
        last_review_sync_at = ?,
        last_checks_sync_at = ?,
        retry_count = ?,
        last_error = ?,
        merged_at = ?,
        updated_at = ?
      WHERE id = ?
      `
      )
      .run(
        patch.branchName ?? promotion.branchName,
        patch.prNumber === undefined ? promotion.prNumber : patch.prNumber,
        patch.prUrl === undefined ? promotion.prUrl : patch.prUrl,
        patch.headSha === undefined ? promotion.headSha : patch.headSha,
        patch.baseBranch ?? promotion.baseBranch,
        patch.promotionStatus ?? promotion.promotionStatus,
        patch.mergeMethod ?? promotion.mergeMethod,
        patch.lastReviewSyncAt === undefined ? promotion.lastReviewSyncAt : patch.lastReviewSyncAt,
        patch.lastChecksSyncAt === undefined ? promotion.lastChecksSyncAt : patch.lastChecksSyncAt,
        patch.retryCount ?? promotion.retryCount,
        patch.lastError === undefined ? promotion.lastError : patch.lastError,
        patch.mergedAt === undefined ? promotion.mergedAt : patch.mergedAt,
        nowIso(),
        promotionId
      )
    return mapPromotionRecord(
      this.db.prepare("SELECT * FROM promotions WHERE id = ?").get(promotionId) as Record<string, unknown>
    )
  }

  listAutomations(companyId?: string): Automation[] {
    const rows = companyId
      ? this.db.prepare("SELECT * FROM automations WHERE company_id = ? ORDER BY created_at ASC").all(companyId)
      : this.db.prepare("SELECT * FROM automations ORDER BY created_at ASC").all()
    return rows.map((row) => mapAutomation(row as Record<string, unknown>))
  }

  listDueAutomations(companyId?: string, at = nowIso()): Automation[] {
    const rows = companyId
      ? this.db
          .prepare(
            "SELECT * FROM automations WHERE company_id = ? AND status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC"
          )
          .all(companyId, at)
      : this.db
          .prepare(
            "SELECT * FROM automations WHERE status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC"
          )
          .all(at)
    return rows.map((row) => mapAutomation(row as Record<string, unknown>))
  }

  createAutomation(input: CreateAutomationInput): Automation {
    const company = this.resolveCompany(input.companyRef)
    const project = input.projectRef ? this.resolveProject(input.projectRef, company.id) : null
    const id = randomUUID()
    const createdAt = nowIso()
    this.db
      .prepare(
        `
      INSERT INTO automations (
        id,
        company_id,
        project_id,
        name,
        kind,
        status,
        cron,
        next_run_at,
        payload_json,
        last_run_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
      `
      )
      .run(
        id,
        company.id,
        project?.id ?? null,
        input.name,
        input.kind,
        input.status ?? "active",
        input.cron,
        input.nextRunAt ?? null,
        JSON.stringify(input.payload ?? {}),
        createdAt,
        createdAt
      )
    return this.getAutomationById(id)
  }

  getAutomationById(id: string): Automation {
    const row = this.db.prepare("SELECT * FROM automations WHERE id = ?").get(id)
    if (!row) throw new Error(`Automation not found: ${id}`)
    return mapAutomation(row as Record<string, unknown>)
  }

  resolveAutomation(ref: string, companyId?: string | null): Automation {
    const byId = this.db.prepare("SELECT * FROM automations WHERE id = ?").get(ref)
    if (byId) return mapAutomation(byId as Record<string, unknown>)

    const rows = companyId
      ? this.db
          .prepare("SELECT * FROM automations WHERE company_id = ? AND name = ? ORDER BY created_at ASC")
          .all(companyId, ref)
      : this.db.prepare("SELECT * FROM automations WHERE name = ? ORDER BY created_at ASC").all(ref)
    if (rows.length === 0) throw new Error(`Automation not found: ${ref}`)
    if (rows.length > 1) {
      throw new Error(`Automation name is ambiguous: ${ref}; pass --company or use the automation id`)
    }
    return mapAutomation(rows[0] as Record<string, unknown>)
  }

  updateAutomation(automationId: string, patch: UpdateAutomationInput): Automation {
    const automation = this.getAutomationById(automationId)
    this.db
      .prepare(
        `
      UPDATE automations
      SET
        name = ?,
        kind = ?,
        status = ?,
        cron = ?,
        next_run_at = ?,
        payload_json = ?,
        last_run_at = ?,
        updated_at = ?
      WHERE id = ?
      `
      )
      .run(
        patch.name ?? automation.name,
        patch.kind ?? automation.kind,
        patch.status ?? automation.status,
        patch.cron ?? automation.cron,
        patch.nextRunAt === undefined ? automation.nextRunAt : patch.nextRunAt,
        JSON.stringify(patch.payload === undefined ? automation.payload : patch.payload),
        patch.lastRunAt === undefined ? automation.lastRunAt : patch.lastRunAt,
        nowIso(),
        automationId
      )
    return this.getAutomationById(automationId)
  }

  createPlannerRun(input: CreatePlannerRunInput): PlannerRunRecord {
    const id = randomUUID()
    const createdAt = nowIso()
    const automationId =
      input.automationId && this.db.prepare("SELECT 1 FROM automations WHERE id = ?").get(input.automationId)
        ? input.automationId
        : null
    this.db
      .prepare(
        `
      INSERT INTO planner_runs (
        id,
        company_id,
        project_id,
        automation_id,
        trigger_kind,
        status,
        planner_persona_id,
        planner_agent_id,
        adapter_type,
        snapshot_json,
        output_json,
        summary_json,
        error_text,
        started_at,
        finished_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        id,
        input.companyId,
        input.projectId,
        automationId,
        input.trigger,
        input.status ?? "running",
        input.plannerPersonaId ?? null,
        input.plannerAgentId ?? null,
        input.adapterType ?? null,
        input.snapshotJson ? JSON.stringify(input.snapshotJson) : null,
        input.outputJson ? JSON.stringify(input.outputJson) : null,
        input.summaryJson ? JSON.stringify(input.summaryJson) : null,
        input.errorText ?? null,
        input.startedAt ?? createdAt,
        input.finishedAt ?? null,
        createdAt,
        createdAt
      )
    return this.getPlannerRunById(id)
  }

  acquirePlannerRunSlot(
    input: CreatePlannerRunInput & {
      activeThresholdMs?: number
      repairReasonPrefix?: string
    }
  ): {
    plannerRun: PlannerRunRecord
    created: boolean
    reusedExisting: boolean
    recovered: Array<{
      plannerRunId: string
      reason: "stale_planner_run_recovered" | "duplicate_planner_run_recovered"
      canonicalPlannerRunId: string | null
    }>
  } {
    return this.transaction(() => {
      const createdAt = nowIso()
      const staleThresholdMs = input.activeThresholdMs ?? 30 * 60 * 1000
      const staleBefore = new Date(Date.parse(createdAt) - staleThresholdMs).getTime()
      const automationId =
        input.automationId && this.db.prepare("SELECT 1 FROM automations WHERE id = ?").get(input.automationId)
          ? input.automationId
          : null
      const activeRuns = this.db
        .prepare(
          "SELECT * FROM planner_runs WHERE project_id = ? AND status = 'running' ORDER BY started_at DESC, created_at DESC"
        )
        .all(input.projectId)
        .map((row) => mapPlannerRun(row as Record<string, unknown>))

      const freshRuns = activeRuns.filter((run) => {
        const startedAt = parseIsoTimestamp(run.startedAt) ?? parseIsoTimestamp(run.createdAt)
        return startedAt === null || startedAt > staleBefore
      })
      const canonicalFresh = freshRuns[0] ?? null
      const recovered: Array<{
        plannerRunId: string
        reason: "stale_planner_run_recovered" | "duplicate_planner_run_recovered"
        canonicalPlannerRunId: string | null
      }> = []

      for (const run of activeRuns) {
        const isCanonicalFresh = canonicalFresh?.id === run.id
        if (isCanonicalFresh) {
          continue
        }

        const startedAt = parseIsoTimestamp(run.startedAt) ?? parseIsoTimestamp(run.createdAt)
        const stale = startedAt !== null && startedAt <= staleBefore
        const reason = stale ? "stale_planner_run_recovered" : "duplicate_planner_run_recovered"
        const canonicalPlannerRunId = stale ? null : (canonicalFresh?.id ?? null)
        const detail =
          reason === "stale_planner_run_recovered"
            ? `${input.repairReasonPrefix ?? "Recovered stale planner run"} after ${staleThresholdMs}ms without completion.`
            : `${input.repairReasonPrefix ?? "Recovered duplicate planner run"} in favor of ${canonicalPlannerRunId ?? "new planner run"}.`

        this.db
          .prepare(
            `
          UPDATE planner_runs
          SET
            status = 'failed',
            error_text = ?,
            finished_at = ?,
            updated_at = ?
          WHERE id = ?
          `
          )
          .run(detail, createdAt, createdAt, run.id)

        recovered.push({
          plannerRunId: run.id,
          reason,
          canonicalPlannerRunId
        })
      }

      if (canonicalFresh) {
        return {
          plannerRun: this.getPlannerRunById(canonicalFresh.id),
          created: false,
          reusedExisting: true,
          recovered
        }
      }

      const id = randomUUID()
      this.db
        .prepare(
          `
        INSERT INTO planner_runs (
          id,
          company_id,
          project_id,
          automation_id,
          trigger_kind,
          status,
          planner_persona_id,
          planner_agent_id,
          adapter_type,
          snapshot_json,
          output_json,
          summary_json,
          error_text,
          started_at,
          finished_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        )
        .run(
          id,
          input.companyId,
          input.projectId,
          automationId,
          input.trigger,
          input.status ?? "running",
          input.plannerPersonaId ?? null,
          input.plannerAgentId ?? null,
          input.adapterType ?? null,
          input.snapshotJson ? JSON.stringify(input.snapshotJson) : null,
          input.outputJson ? JSON.stringify(input.outputJson) : null,
          input.summaryJson ? JSON.stringify(input.summaryJson) : null,
          input.errorText ?? null,
          input.startedAt ?? createdAt,
          input.finishedAt ?? null,
          createdAt,
          createdAt
        )

      return {
        plannerRun: this.getPlannerRunById(id),
        created: true,
        reusedExisting: false,
        recovered
      }
    })
  }

  getPlannerRunById(id: string): PlannerRunRecord {
    const row = this.db.prepare("SELECT * FROM planner_runs WHERE id = ?").get(id)
    if (!row) throw new Error(`Planner run not found: ${id}`)
    return mapPlannerRun(row as Record<string, unknown>)
  }

  updatePlannerRun(plannerRunId: string, patch: UpdatePlannerRunInput): PlannerRunRecord {
    const current = this.getPlannerRunById(plannerRunId)
    this.db
      .prepare(
        `
      UPDATE planner_runs
      SET
        status = ?,
        planner_persona_id = ?,
        planner_agent_id = ?,
        adapter_type = ?,
        snapshot_json = ?,
        output_json = ?,
        summary_json = ?,
        error_text = ?,
        finished_at = ?,
        updated_at = ?
      WHERE id = ?
      `
      )
      .run(
        patch.status ?? current.status,
        patch.plannerPersonaId === undefined ? current.plannerPersonaId : patch.plannerPersonaId,
        patch.plannerAgentId === undefined ? current.plannerAgentId : patch.plannerAgentId,
        patch.adapterType === undefined ? current.adapterType : patch.adapterType,
        patch.snapshotJson === undefined
          ? current.snapshotJson
            ? JSON.stringify(current.snapshotJson)
            : null
          : patch.snapshotJson
            ? JSON.stringify(patch.snapshotJson)
            : null,
        patch.outputJson === undefined
          ? current.outputJson
            ? JSON.stringify(current.outputJson)
            : null
          : patch.outputJson
            ? JSON.stringify(patch.outputJson)
            : null,
        patch.summaryJson === undefined
          ? current.summaryJson
            ? JSON.stringify(current.summaryJson)
            : null
          : patch.summaryJson
            ? JSON.stringify(patch.summaryJson)
            : null,
        patch.errorText === undefined ? current.errorText : patch.errorText,
        patch.finishedAt === undefined ? current.finishedAt : patch.finishedAt,
        nowIso(),
        plannerRunId
      )
    return this.getPlannerRunById(plannerRunId)
  }

  listRecentPlannerRuns(projectId: string, limit = 10): PlannerRunRecord[] {
    return this.db
      .prepare("SELECT * FROM planner_runs WHERE project_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(projectId, limit)
      .map((row) => mapPlannerRun(row as Record<string, unknown>))
  }

  listPlannerRuns(projectId?: string): PlannerRunRecord[] {
    const rows = projectId
      ? this.db.prepare("SELECT * FROM planner_runs WHERE project_id = ? ORDER BY created_at DESC").all(projectId)
      : this.db.prepare("SELECT * FROM planner_runs ORDER BY created_at DESC").all()
    return rows.map((row) => mapPlannerRun(row as Record<string, unknown>))
  }

  listRunningPlannerRuns(projectId?: string): PlannerRunRecord[] {
    const rows = projectId
      ? this.db
          .prepare(
            "SELECT * FROM planner_runs WHERE project_id = ? AND status = 'running' ORDER BY started_at ASC, created_at ASC"
          )
          .all(projectId)
      : this.db
          .prepare("SELECT * FROM planner_runs WHERE status = 'running' ORDER BY started_at ASC, created_at ASC")
          .all()
    return rows.map((row) => mapPlannerRun(row as Record<string, unknown>))
  }

  appendPlannerEvent(
    plannerRunId: string,
    kind: string,
    message: string,
    data?: Record<string, unknown> | null
  ): PlannerEvent {
    const seq =
      Number(
        (
          this.db
            .prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM planner_events WHERE planner_run_id = ?")
            .get(plannerRunId) as { seq?: number } | undefined
        )?.seq ?? 0
      ) + 1
    const id = randomUUID()
    const createdAt = nowIso()
    this.db
      .prepare(
        "INSERT INTO planner_events (id, planner_run_id, seq, kind, message, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .run(id, plannerRunId, seq, kind, message, data ? JSON.stringify(data) : null, createdAt)
    return { id, plannerRunId, seq, kind, message, data: data ?? null, createdAt }
  }

  getPlannerEvents(plannerRunId: string): PlannerEvent[] {
    return this.db
      .prepare("SELECT * FROM planner_events WHERE planner_run_id = ? ORDER BY seq ASC")
      .all(plannerRunId)
      .map((row) => mapPlannerEvent(row as Record<string, unknown>))
  }

  addPlannerArtifact(input: {
    plannerRunId: string
    projectId: string
    kind: PlannerRunArtifact["kind"]
    path: string
  }): PlannerRunArtifact {
    const id = randomUUID()
    const createdAt = nowIso()
    this.db
      .prepare(
        "INSERT INTO planner_artifacts (id, planner_run_id, project_id, kind, path, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(id, input.plannerRunId, input.projectId, input.kind, input.path, createdAt)
    return {
      plannerRunId: input.plannerRunId,
      projectId: input.projectId,
      kind: input.kind,
      path: input.path,
      createdAt
    }
  }

  listPlannerArtifacts(projectId: string, plannerRunId?: string): PlannerRunArtifact[] {
    const rows = plannerRunId
      ? this.db
          .prepare(
            "SELECT * FROM planner_artifacts WHERE project_id = ? AND planner_run_id = ? ORDER BY created_at ASC"
          )
          .all(projectId, plannerRunId)
      : this.db.prepare("SELECT * FROM planner_artifacts WHERE project_id = ? ORDER BY created_at DESC").all(projectId)
    return rows.map((row) => mapPlannerArtifact(row as Record<string, unknown>))
  }

  findTaskByDedupeKey(projectId: string, dedupeKey: string, windowStartIso?: string): Task | null {
    const label = `planner-dedupe:${dedupeKey}`
    const matches = this.listProjectTasks(projectId).filter((task) => {
      if (!task.labels.includes(label)) return false
      if (!windowStartIso) return true
      return task.createdAt >= windowStartIso || (task.completedAt !== null && task.completedAt >= windowStartIso)
    })
    return matches[matches.length - 1] ?? null
  }

  refreshWorkflowStatus(workflowId: string): Workflow {
    const workflow = this.getWorkflowById(workflowId)
    const tasks = this.listWorkflowTasks(workflowId)
    const childrenByParent = new Map<string, Task[]>()
    for (const task of tasks) {
      if (!task.parentTaskId) continue
      const siblings = childrenByParent.get(task.parentTaskId) ?? []
      siblings.push(task)
      childrenByParent.set(task.parentTaskId, siblings)
    }
    const hasSuccessfulRecovery = (taskId: string, seen = new Set<string>()): boolean => {
      if (seen.has(taskId)) return false
      seen.add(taskId)
      const children = childrenByParent.get(taskId) ?? []
      return children.some(
        (child) =>
          (child.kind === "fix_review_feedback" && child.status === "done") ||
          hasSuccessfulRecovery(child.id, new Set(seen))
      )
    }
    const isRecoveredFailure = (task: Task): boolean => task.status === "failed" && hasSuccessfulRecovery(task.id)
    const hasFailed = tasks.some((task) => task.status === "failed" && !isRecoveredFailure(task))
    const hasBlocked = tasks.some((task) => task.status === "blocked")
    const hasRunning = tasks.some((task) => task.status === "running")
    const allComplete = tasks.length > 0 && tasks.every((task) => task.status === "done" || isRecoveredFailure(task))
    const nextStatus: WorkflowStatus = hasFailed
      ? "failed"
      : hasBlocked
        ? "blocked"
        : allComplete
          ? "done"
          : hasRunning
            ? "running"
            : "queued"
    return this.updateWorkflow(workflowId, {
      status: nextStatus,
      completedAt: nextStatus === "done" || nextStatus === "failed" ? nowIso() : null,
      rootTaskId: workflow.rootTaskId
    })
  }

  listRoutingRules(): RoutingRule[] {
    const rows = this.db.prepare("SELECT * FROM routing_rules ORDER BY priority DESC, created_at ASC").all()
    return rows.map((row) => mapRoutingRule(row as Record<string, unknown>))
  }

  findRoutingRuleByName(name: string): RoutingRule | null {
    const row = this.db.prepare("SELECT * FROM routing_rules WHERE name = ? ORDER BY created_at ASC LIMIT 1").get(name)
    return row ? mapRoutingRule(row as Record<string, unknown>) : null
  }

  createRoutingRule(input: CreateRoutingRuleInput): RoutingRule {
    const id = randomUUID()
    const createdAt = nowIso()
    this.db
      .prepare(
        `
      INSERT INTO routing_rules (
        id,
        name,
        priority,
        target_adapter_type,
        match_type,
        patterns_json,
        is_fallback,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        id,
        input.name,
        input.priority ?? 0,
        input.targetAdapterType,
        input.matchType ?? "keyword",
        JSON.stringify(normalizePatterns(input.patterns)),
        input.isFallback ? 1 : 0,
        createdAt
      )

    return this.findRoutingRuleByName(input.name)!
  }

  updateRoutingRule(ruleId: string, patch: UpdateRoutingRuleInput): RoutingRule {
    const rule = this.db.prepare("SELECT * FROM routing_rules WHERE id = ?").get(ruleId)
    if (!rule) throw new Error(`Routing rule not found: ${ruleId}`)
    const current = mapRoutingRule(rule as Record<string, unknown>)

    this.db
      .prepare(
        `
      UPDATE routing_rules
      SET
        name = ?,
        priority = ?,
        target_adapter_type = ?,
        match_type = ?,
        patterns_json = ?,
        is_fallback = ?
      WHERE id = ?
      `
      )
      .run(
        patch.name ?? current.name,
        patch.priority ?? current.priority,
        patch.targetAdapterType ?? current.targetAdapterType,
        patch.matchType ?? current.matchType,
        JSON.stringify(patch.patterns === undefined ? current.patterns : normalizePatterns(patch.patterns)),
        patch.isFallback === undefined ? (current.isFallback ? 1 : 0) : patch.isFallback ? 1 : 0,
        ruleId
      )

    return mapRoutingRule(
      this.db.prepare("SELECT * FROM routing_rules WHERE id = ?").get(ruleId) as Record<string, unknown>
    )
  }

  private seedDefaultRoutingRules(): void {
    const countRow = this.db.prepare("SELECT COUNT(*) AS count FROM routing_rules").get() as Record<string, unknown>
    if (Number(countRow.count) > 0) {
      return
    }

    const createdAt = nowIso()
    const insert = this.db.prepare(
      `
      INSERT INTO routing_rules (
        id,
        name,
        priority,
        target_adapter_type,
        match_type,
        patterns_json,
        is_fallback,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `
    )

    insert.run(
      randomUUID(),
      "ui-surface",
      100,
      "gemini_local",
      "keyword",
      JSON.stringify(["ui", "frontend", "design", "ux", "copy", "visual", ".tsx", ".css"]),
      0,
      createdAt
    )
    insert.run(randomUUID(), "default-codex", 0, "codex_local", "default", JSON.stringify([]), 1, createdAt)
  }

  recordBudgetUsage(
    companyId: string,
    agentId: string,
    periodKind: BudgetWindowKind,
    usageUnits: number,
    recordedAt = nowIso()
  ): BudgetWindow {
    const periodKey = budgetPeriodKey(periodKind, recordedAt)
    const existing = this.db
      .prepare(
        `
        SELECT * FROM budget_windows
        WHERE agent_id = ? AND period_kind = ? AND period_key = ?
        `
      )
      .get(agentId, periodKind, periodKey)

    if (existing) {
      this.db
        .prepare(
          `
        UPDATE budget_windows
        SET usage_units = usage_units + ?, run_count = run_count + 1, updated_at = ?
        WHERE agent_id = ? AND period_kind = ? AND period_key = ?
        `
        )
        .run(usageUnits, recordedAt, agentId, periodKind, periodKey)
    } else {
      this.db
        .prepare(
          `
        INSERT INTO budget_windows (
          id,
          company_id,
          agent_id,
          period_kind,
          period_key,
          usage_units,
          run_count,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 1, ?)
        `
        )
        .run(randomUUID(), companyId, agentId, periodKind, periodKey, usageUnits, recordedAt)
    }

    return this.getBudgetWindow(agentId, periodKind, periodKey)!
  }

  getBudgetWindow(agentId: string, periodKind: BudgetWindowKind, periodKey: string): BudgetWindow | null {
    const row = this.db
      .prepare("SELECT * FROM budget_windows WHERE agent_id = ? AND period_kind = ? AND period_key = ?")
      .get(agentId, periodKind, periodKey)
    return row ? mapBudgetWindow(row as Record<string, unknown>) : null
  }

  getBudgetStatus(agent: Agent, at = nowIso()): BudgetStatus {
    const periodKey = budgetPeriodKey(agent.budgetWindow, at)
    const window = this.getBudgetWindow(agent.id, agent.budgetWindow, periodKey)
    const usageUnits = window?.usageUnits ?? 0
    const runCount = window?.runCount ?? 0
    const remainingUnits = agent.budgetLimit === null ? null : Math.max(agent.budgetLimit - usageUnits, 0)
    const blocked = agent.budgetLimit !== null && usageUnits >= agent.budgetLimit

    return {
      agent,
      periodKey,
      usageUnits,
      runCount,
      remainingUnits,
      blocked
    }
  }

  getBudgetStatuses(companyRef?: string | null): BudgetStatus[] {
    const company = companyRef ? this.resolveCompany(companyRef) : null
    return this.listAgents(company?.id).map((agent) => this.getBudgetStatus(agent))
  }

  upsertAdapterLaneHealth(input: {
    companyId: string
    adapterType: AdapterType
    laneKey: string
    laneLabel: string
    status: AdapterLaneStatus
    reason?: string | null
    cooldownUntil?: string | null
    lastError?: string | null
    lastSuccessAt?: string | null
    lastCheckedAt?: string
    metadata?: Record<string, unknown>
  }): AdapterLaneHealth {
    const existing = this.db
      .prepare("SELECT * FROM adapter_lane_health WHERE company_id = ? AND adapter_type = ? AND lane_key = ?")
      .get(input.companyId, input.adapterType, input.laneKey) as Record<string, unknown> | undefined
    const now = nowIso()

    if (existing) {
      this.db
        .prepare(
          `
        UPDATE adapter_lane_health
        SET
          lane_label = ?,
          status = ?,
          reason = ?,
          cooldown_until = ?,
          last_error = ?,
          last_success_at = ?,
          last_checked_at = ?,
          metadata_json = ?,
          updated_at = ?
        WHERE id = ?
        `
        )
        .run(
          input.laneLabel,
          input.status,
          input.reason ?? null,
          input.cooldownUntil ?? null,
          input.lastError ?? null,
          input.lastSuccessAt ?? null,
          input.lastCheckedAt ?? now,
          JSON.stringify(input.metadata ?? {}),
          now,
          String(existing.id)
        )
      return this.getAdapterLaneHealth(input.companyId, input.adapterType, input.laneKey)!
    }

    const id = randomUUID()
    this.db
      .prepare(
        `
      INSERT INTO adapter_lane_health (
        id,
        company_id,
        adapter_type,
        lane_key,
        lane_label,
        status,
        reason,
        cooldown_until,
        last_error,
        last_success_at,
        last_checked_at,
        metadata_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        id,
        input.companyId,
        input.adapterType,
        input.laneKey,
        input.laneLabel,
        input.status,
        input.reason ?? null,
        input.cooldownUntil ?? null,
        input.lastError ?? null,
        input.lastSuccessAt ?? null,
        input.lastCheckedAt ?? now,
        JSON.stringify(input.metadata ?? {}),
        now,
        now
      )

    return this.getAdapterLaneHealth(input.companyId, input.adapterType, input.laneKey)!
  }

  getAdapterLaneHealth(companyId: string, adapterType: AdapterType, laneKey: string): AdapterLaneHealth | null {
    const row = this.db
      .prepare("SELECT * FROM adapter_lane_health WHERE company_id = ? AND adapter_type = ? AND lane_key = ?")
      .get(companyId, adapterType, laneKey)
    return row ? mapAdapterLaneHealth(row as Record<string, unknown>) : null
  }

  listAdapterLaneHealth(companyId?: string, adapterType?: AdapterType): AdapterLaneHealth[] {
    let query = "SELECT * FROM adapter_lane_health"
    const params: SQLInputValue[] = []

    if (companyId && adapterType) {
      query += " WHERE company_id = ? AND adapter_type = ?"
      params.push(companyId, adapterType)
    } else if (companyId) {
      query += " WHERE company_id = ?"
      params.push(companyId)
    } else if (adapterType) {
      query += " WHERE adapter_type = ?"
      params.push(adapterType)
    }

    query += " ORDER BY adapter_type ASC, lane_key ASC"
    return this.db
      .prepare(query)
      .all(...params)
      .map((row) => mapAdapterLaneHealth(row as Record<string, unknown>))
  }

  acquireRuntimeLease(input: {
    companyId: string
    scope: string
    holder: string
    leaseKind: string
    ttlMs: number
    metadata?: Record<string, unknown>
    now?: string
  }): RuntimeLease | null {
    return this.transaction(() => {
      const now = input.now ?? nowIso()
      const existing = this.db
        .prepare("SELECT * FROM runtime_leases WHERE company_id = ? AND scope = ?")
        .get(input.companyId, input.scope) as Record<string, unknown> | undefined
      if (existing && String(existing.expires_at) > now && String(existing.holder) !== input.holder) {
        return null
      }

      const id = existing ? String(existing.id) : randomUUID()
      const expiresAt = new Date(new Date(now).getTime() + Math.max(1, input.ttlMs)).toISOString()
      this.db
        .prepare(
          `
          INSERT INTO runtime_leases (id, company_id, scope, holder, lease_kind, acquired_at, expires_at, metadata_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(company_id, scope) DO UPDATE SET
            holder = excluded.holder,
            lease_kind = excluded.lease_kind,
            acquired_at = excluded.acquired_at,
            expires_at = excluded.expires_at,
            metadata_json = excluded.metadata_json
          `
        )
        .run(
          id,
          input.companyId,
          input.scope,
          input.holder,
          input.leaseKind,
          now,
          expiresAt,
          JSON.stringify(input.metadata ?? {})
        )

      return this.getRuntimeLease(input.companyId, input.scope)
    })
  }

  getRuntimeLease(companyId: string, scope: string): RuntimeLease | null {
    const row = this.db.prepare("SELECT * FROM runtime_leases WHERE company_id = ? AND scope = ?").get(companyId, scope)
    return row ? mapRuntimeLease(row as Record<string, unknown>) : null
  }

  listRuntimeLeases(companyId?: string, now = nowIso()): RuntimeLease[] {
    const rows = companyId
      ? this.db
          .prepare("SELECT * FROM runtime_leases WHERE company_id = ? AND expires_at > ? ORDER BY scope ASC")
          .all(companyId, now)
      : this.db.prepare("SELECT * FROM runtime_leases WHERE expires_at > ? ORDER BY company_id ASC, scope ASC").all(now)
    return rows.map((row) => mapRuntimeLease(row as Record<string, unknown>))
  }

  releaseRuntimeLease(companyId: string, scope: string, holder?: string): boolean {
    const result = holder
      ? this.db
          .prepare("DELETE FROM runtime_leases WHERE company_id = ? AND scope = ? AND holder = ?")
          .run(companyId, scope, holder)
      : this.db.prepare("DELETE FROM runtime_leases WHERE company_id = ? AND scope = ?").run(companyId, scope)
    return result.changes > 0
  }

  renewTaskLease(taskId: string, claimToken: string, durationMs = 30 * 60 * 1000): boolean {
    return this.transaction(() => {
      const claimExpiresAt = new Date(Date.now() + durationMs).toISOString()
      const result = this.db
        .prepare(
          `
          UPDATE tasks
          SET claim_expires_at = ?, updated_at = ?
          WHERE id = ?
          AND status = 'running'
          AND claim_status = 'claimed'
          AND claim_token = ?
          `
        )
        .run(claimExpiresAt, nowIso(), taskId, claimToken)
      return Number(result.changes) === 1
    })
  }

  isLaneBusy(projectId: string, laneId: string, excludeTaskId?: string | null): boolean {
    const row = this.db
      .prepare(
        `
        SELECT COUNT(*) AS count
        FROM promotions p
        JOIN tasks t ON t.id = p.task_id
        WHERE p.project_id = ? AND t.lane_id = ?
        AND p.promotion_status NOT IN ('merged', 'failed')
        AND (? IS NULL OR p.task_id != ?)
        `
      )
      .get(projectId, laneId, excludeTaskId ?? null, excludeTaskId ?? null) as Record<string, unknown>
    return Number(row.count) > 0
  }

  getPromotionByLane(projectId: string, laneId: string, excludeTaskId?: string | null): PromotionRecord | null {
    const row = this.db
      .prepare(
        `
        SELECT p.*
        FROM promotions p
        JOIN tasks t ON t.id = p.task_id
        WHERE p.project_id = ? AND t.lane_id = ?
        AND p.promotion_status NOT IN ('merged', 'failed')
        AND (? IS NULL OR p.task_id != ?)
        ORDER BY p.created_at DESC LIMIT 1
        `
      )
      .get(projectId, laneId, excludeTaskId ?? null, excludeTaskId ?? null)
    return row ? mapPromotionRecord(row as Record<string, unknown>) : null
  }

  findExpiredClaims(now = nowIso()): Task[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM tasks WHERE claim_status = 'claimed' AND claim_expires_at IS NOT NULL AND claim_expires_at < ?"
      )
      .all(now)
    return rows.map((row) => mapTask(row as Record<string, unknown>))
  }
}
