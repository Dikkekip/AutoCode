export type AdapterType = "codex_local" | "gemini_local" | "azure_foundry"

export type TaskStatus =
  | "queued"
  | "running"
  | "review_needed"
  | "promotion_pending"
  | "blocked"
  | "done"
  | "failed"
  | "needs_human_review"

export type AgentStatus = "idle" | "running" | "paused" | "blocked"

export type RunStatus = "running" | "succeeded" | "failed" | "cancelled"

export type TeamAssignmentStatus = "active" | "completed" | "failed" | "cancelled" | "released"

export type TeamArtifactClaimStatus = "active" | "released"

export type TeamReviewerLockoutStatus = "active" | "cleared"

export type TeamMailboxMessageKind = "decision" | "question" | "handoff" | "blocker" | "status"

export type ApprovalStatus = "pending" | "approved" | "rejected"

export type BacklogCandidateStatus = "candidate" | "accepted" | "duplicate" | "dismissed"

export type BacklogEffortEstimate = "S" | "M" | "L" | "small" | "medium" | "large"

export type RepositoryRole = "primary" | "secondary" | "docs" | "infra"

export type ProductAreaStatus = "active" | "paused" | "completed"

export type MilestoneStatus = "planned" | "active" | "completed" | "cancelled"

export type GoalStatus = "planned" | "active" | "completed" | "cancelled"

export type ReleaseStatus = "planned" | "in_progress" | "released" | "cancelled"

export type BudgetWindowKind = "daily" | "monthly"

export type RoutingMatchType = "keyword" | "default"

export type TaskLane = string

export type PersonaStage = "planner" | "coder" | "reviewer" | "promoter"

export type PersonaStatus = "active" | "paused"

export type WorkflowStatus = "queued" | "running" | "blocked" | "done" | "failed"

export type TaskKind =
  | "user"
  | "plan"
  | "implement"
  | "review"
  | "promote"
  | "fix_review_feedback"
  | "follow_up"
  | "repair"

export type TaskSourceKind =
  | "manual"
  | "automation"
  | "maintenance"
  | "repo_health"
  | "stale_pr_followup"
  | "pending_review_sync"
  | "blocked_promotion_retry"
  | "promotion_feedback"

export type TaskSourceStatus = "active" | "paused"

export type JobId =
  | "queue-refresh"
  | "execution-sweep"
  | "review-sweep"
  | "promotion-sweep"
  | "github-pr-sweep"
  | "daily-telegram-digest"

export type JobRunStatus = "succeeded" | "failed"

export type PromotionStatus =
  | "pending_branch"
  | "pending_pr"
  | "waiting_for_review"
  | "waiting_for_checks"
  | "awaiting_fixes"
  | "ready_to_merge"
  | "merged"
  | "blocked"
  | "failed"

export type MergeMethod = "squash" | "merge" | "rebase"

export type AutomationStatus = "active" | "paused"

export type AutomationKind =
  | "queue_refresh"
  | "repo_health"
  | "memory_maintenance"
  | "db_backup"
  | "db_compact"
  | "stale_pr_followup"
  | "pending_review_sync"
  | "blocked_promotion_retry"

export type MemorySourceKind =
  | "repo_doc"
  | "run_summary"
  | "shared_decision"
  | "portable_skill"
  | "memory_summary"
  | "eval_report"

export type MemoryAudience = "shared" | "codex" | "gemini" | "project"

export type MemoryLayer =
  | "shared_decisions"
  | "run_history"
  | "portable_skills"
  | "run_summaries"
  | "repo_docs"
  | "retrieval_eval_reports"

export type MemoryLifecycleStatus = "not_started" | "queued" | "processing" | "ready" | "failed" | "stale" | "compacted"

export type MemoryImportance = "critical" | "high" | "normal" | "low"

export type MemoryDerivationKind = "import" | "summary" | "compaction" | "evaluation" | "manual"

export type TaskClaimStatus = "unclaimed" | "claimed" | "expired"

export interface TaskClaimLease {
  claimToken: string
  claimedAt: string
  claimExpiresAt: string
}

export type WakeReason =
  | "manual"
  | "execution_sweep"
  | "review_sweep"
  | "promotion_sweep"
  | "queue_refresh"
  | "github_pr_sweep"
  | "daily_digest"

export type ReviewVerdict = "approved" | "changes_requested" | "blocked"

export type HandoffStatus = "open" | "accepted" | "closed"

export type DirectorDecisionAction =
  | "continue"
  | "run_repair"
  | "pause"
  | "stop"
  | "pause_due_to_risk"
  | "request_review"
  | "promote_change"
  | "dispatch_task"
  | "create_tasks"

export type DirectorDecisionStatus =
  | "planned"
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | "blocked"
  | "applied"

export type DirectorStopReason =
  | "loop_limit"
  | "risk_threshold"
  | "quota_limit"
  | "operator_pause"
  | "complete"
  | "quota_limit_reached"
  | "risk_threshold_exceeded"
  | "repeated_failure_detected"
  | "no_progress"
  | "pass_limit_reached"
  | "queue_drained"

export type ReviewSeverity = "info" | "low" | "medium" | "high" | "critical"

export type ReviewRiskLevel = "low" | "medium" | "high" | "critical"

export type ReviewOutcome =
  | "approve"
  | "request_changes"
  | "needs_tests"
  | "needs_human_review"
  | "architecture_blocked"
  | "security_blocked"

export interface ReviewFinding {
  severity: ReviewSeverity
  summary: string
  requiredFixes: string[]
  files: string[]
  areas: string[]
}

export type RunRetryClass = "none" | "transient" | "policy" | "verification" | "unknown"

export type OrchestraKind = "generic" | "codex"

export type ContextBudgetBand = "small" | "medium" | "large" | "huge"

export type ResponseCompressionMode = "off" | "lite" | "full" | "ultra"

export type AdapterLaneStatus = "healthy" | "degraded" | "quota_exhausted" | "auth_failed" | "rate_limited"

export type PromptRouteIntent =
  | "ideation"
  | "promptify"
  | "repo_execution"
  | "frontend_execution"
  | "planning"
  | "review"
  | "coordination"
  | "retrieval"

export type TaskPortfolioBucket =
  | "legal_domain"
  | "frontend_product_ux"
  | "backend_api"
  | "dapr_async_runtime"
  | "architecture_maintainability"
  | "validation_repair"
  | "release_promotion"

export type TaskSourceIntent =
  | "persona_ideation"
  | "planner_fallback"
  | "repair"
  | "manual"
  | "handoff"
  | "backlog"
  | "maintenance"

export type BlockedClassification =
  | "transient"
  | "quota"
  | "adapter_capability"
  | "verification_failure"
  | "merge_conflict"
  | "missing_dependency"
  | "scope_invalid"
  | "needs_human"
  | "unknown"

export interface TaskPersonaProvenance {
  personaId: string
  personaName?: string | undefined
  roleClass?: string | undefined
  source: TaskSourceIntent
  portfolioBucket?: TaskPortfolioBucket | undefined
  rationale?: string | undefined
}

export interface PromptRouteRank {
  pipeline: ["ideation", "promptify", "complexity_estimate", "model_router"]
  intent: PromptRouteIntent
  ideationScore: number
  promptQualityScore: number
  complexityScore100: number
  valueScore100: number
  recommendedPersonaStage: PersonaStage | null
  promptSignals: string[]
  rankingReasons: string[]
}

export interface TaskPackage {
  version: 1
  generatedAt: string
  repoProfile: string
  likelyOwnershipLane: TaskLane
  laneReason: string
  inferenceSignals: string[]
  requiredReading: string[]
  verificationChecklist: string[]
  contractUpdateReminders: string[]
  repoNotes: string[]
  extraInstructions?: string[] | undefined
  adapterPreference?: AdapterType | null | undefined
  personaProvenance?: TaskPersonaProvenance | undefined
  userOutcome?: string | undefined
  acceptanceCriteria?: string[] | undefined
  taskSourceIntent?: TaskSourceIntent | undefined
  portfolioBucket?: TaskPortfolioBucket | undefined
  blockedClassification?: BlockedClassification | undefined
  promptRouteRank?: PromptRouteRank | undefined
  taskLineage?:
    | {
        taskId: string
        branch?: string | undefined
        worktree?: string | undefined
      }
    | undefined
}

export type HandoffVerificationStatus = "not_run" | "passed" | "failed" | "partial" | "blocked"

export interface HandoffVerification {
  status: HandoffVerificationStatus
  summary: string
  evidence: string[]
}

export interface HandoffAllowedScope {
  summary: string
  paths: string[]
  commands: string[]
  constraints: string[]
}

export interface HandoffArtifact {
  version: 1
  id: string
  createdAt: string
  sourcePersona: string
  targetPersona: string
  contextSummary: string
  completedWork: string[]
  openQuestions: string[]
  risks: string[]
  requiredFiles: string[]
  verificationStatus: HandoffVerification
  nextRecommendedAction: string
  allowedScope: HandoffAllowedScope
  sourceTaskId: string | null
  targetTaskId: string | null
  metadata: Record<string, unknown>
}

export interface PlanSubtask {
  id: string
  label: string
  goal: string
  prompt: string
  files: string[]
  dependsOn: string[]
  deliverables: string[]
  validation: string[]
}

export interface WorktreeLineage {
  rootTaskId: string
  parentTaskId: string
  ancestorTaskIds: string[]
  branchName: string
  worktreePath: string | null
}

export interface PromotionReadyState {
  status: "awaiting_reviewer_decision" | "promotable" | "blocked"
  verdict: ReviewVerdict | null
  evidencePaths: string[]
  releaseFlow?: string
}

export interface OrchestraRunManifest {
  taskId: string
  lane: string
  branch: string | null
  lineage: WorktreeLineage | null
  subtasks: PlanSubtask[]
  filesTouched: string[]
  testsRun: string[]
  status: "planned" | "awaiting_review" | "done"
  risks: string[]
  nextActions: string[]
  promotionReadyState?: PromotionReadyState
}

export interface ReviewerHandoff {
  taskId: string
  tasksIncluded: string[]
  lane: string
  branch: string | null
  prTitle: string
  prBody: string
  reviewEvidence: string
  knownGlobalBlockers: string[]
  status: "needs_review" | "approved" | "changes_requested"
  promotionReadyState: PromotionReadyState
}

export interface Company {
  id: string
  name: string
  description: string | null
  createdAt: string
}

export interface Project {
  id: string
  companyId: string
  name: string
  repoPath: string
  verifyCommand: string | null
  profileId: string | null
  profilePath: string | null
  profile: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface Repository {
  id: string
  companyId: string
  projectId: string
  name: string
  path: string
  remoteUrl: string | null
  defaultBranch: string
  role: RepositoryRole
  profilePath: string | null
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface ProductArea {
  id: string
  companyId: string
  projectId: string
  name: string
  description: string | null
  ownerPersonaId: string | null
  status: ProductAreaStatus
  createdAt: string
  updatedAt: string
}

export interface Milestone {
  id: string
  companyId: string
  projectId: string
  name: string
  description: string | null
  status: MilestoneStatus
  targetDate: string | null
  progress: number
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export interface Goal {
  id: string
  companyId: string
  projectId: string
  milestoneId: string | null
  productAreaId: string | null
  title: string
  description: string | null
  status: GoalStatus
  priority: number
  rootTaskId: string | null
  taskTree: Record<string, unknown>
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export interface Release {
  id: string
  companyId: string
  projectId: string
  milestoneId: string | null
  name: string
  version: string | null
  status: ReleaseStatus
  releasedAt: string | null
  notes: string | null
  createdAt: string
  updatedAt: string
}

export interface Agent {
  id: string
  companyId: string
  name: string
  role: string
  adapterType: AdapterType
  status: AgentStatus
  model: string | null
  instructionsPath: string | null
  command: string | null
  env: Record<string, string>
  heartbeatEnabled: boolean
  heartbeatIntervalSec: number
  budgetLimit: number | null
  budgetWindow: BudgetWindowKind
  lastHeartbeatAt: string | null
  createdAt: string
  updatedAt: string
}

export interface Persona {
  id: string
  companyId: string
  name: string
  stage: PersonaStage
  ownedLanes: string[]
  preferredAdapterType: AdapterType
  instructionsPath: string | null
  status: PersonaStatus
  budgetLimit: number | null
  budgetWindow: BudgetWindowKind
  createdAt: string
  updatedAt: string
}

export interface Workflow {
  id: string
  companyId: string
  projectId: string
  title: string
  description: string | null
  status: WorkflowStatus
  rootTaskId: string | null
  sourceProfileId: string | null
  sourceProjectVersion: string | null
  orchestraKind: OrchestraKind
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export interface TaskSource {
  id: string
  companyId: string
  projectId: string | null
  name: string
  kind: TaskSourceKind
  status: TaskSourceStatus
  config: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface Task {
  id: string
  companyId: string
  projectId: string
  workflowId: string | null
  goalId: string | null
  milestoneId: string | null
  parentTaskId: string | null
  dependsOnTaskIds: string[]
  personaId: string | null
  stage: PersonaStage | null
  title: string
  description: string | null
  labels: string[]
  changedFiles: string[]
  taskPackage: TaskPackage | null
  kind: TaskKind
  priority: number
  scheduledAt: string | null
  source: TaskSourceKind
  status: TaskStatus
  assignedAgentId: string | null
  requestedAdapterType: AdapterType | null
  laneId: string | null
  allowedPaths: string[]
  requiredReading: string[]
  verificationCommands: string[]
  claimStatus: TaskClaimStatus
  claimToken: string | null
  claimExpiresAt: string | null
  claimOwnerRunId: string | null
  claimOwnerAgentId: string | null
  claimedAt: string | null
  lineageRootId: string | null
  lineageParentId: string | null
  taskPackagePath: string | null
  reviewHandoffPath: string | null
  artifactDir: string | null
  reviewRequired: boolean
  approvalRequired: boolean
  retryCount: number
  maxRetries: number
  lastError: string | null
  blockedReason: string | null
  lastRecoveryAt: string | null
  lastRecoveryReason: string | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export interface BacklogCandidate {
  id: string
  companyId: string
  projectId: string
  status: BacklogCandidateStatus
  title: string
  description: string
  valueScore: number
  riskScore: number
  effortEstimate: BacklogEffortEstimate
  recommendedPersona: string | null
  suggestedAdapter: AdapterType | null
  verificationCommand: string | null
  dependencies: string[]
  reason: string
  dedupeKey: string
  sourceSignals: string[]
  labels: string[]
  changedFiles: string[]
  acceptedTaskId: string | null
  duplicateOf: string | null
  createdAt: string
  updatedAt: string
}

export interface HandoffRecord {
  id: string
  companyId: string
  projectId: string
  sourcePersona: string
  targetPersona: string
  sourceTaskId: string | null
  targetTaskId: string | null
  artifactPath: string
  status: HandoffStatus
  artifact: HandoffArtifact
  acceptedAt: string | null
  acceptedBy: string | null
  createdAt: string
  updatedAt: string
}

export interface DirectorDecisionRecord {
  id: string
  companyId: string
  projectId: string
  profileId: string | null
  cycleId: string
  passIndex: number
  action: DirectorDecisionAction
  status: DirectorDecisionStatus
  dryRun: boolean
  reason: string
  stopReason: DirectorStopReason | null
  riskScore: number
  riskThreshold: number
  quotaUsed: number
  quotaLimit: number
  loopLimit: number
  input: Record<string, unknown>
  result: Record<string, unknown> | null
  createdAt: string
  completedAt: string | null
}

export interface Run {
  id: string
  companyId: string
  projectId: string
  taskId: string
  agentId: string | null
  adapterType: AdapterType | null
  kind: TaskKind
  status: RunStatus
  sessionKey: string | null
  sessionDisplayId: string | null
  responseText: string | null
  errorText: string | null
  usage: AdapterUsage | null
  branchName: string | null
  prNumber: number | null
  headSha: string | null
  verificationSummary: string | null
  wakeReason: WakeReason
  heartbeatJobId: JobId | null
  worktreePath: string | null
  manifestPath: string | null
  reviewVerdict: ReviewVerdict | null
  promotionRecordId: string | null
  costCents: number | null
  retryClass: RunRetryClass
  metadata: Record<string, unknown> | null
  startedAt: string
  finishedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface TeamAssignment {
  id: string
  companyId: string
  projectId: string
  taskId: string
  runId: string
  agentId: string
  status: TeamAssignmentStatus
  routingReason: string
  routingDecision: Record<string, unknown>
  artifactPaths: string[]
  releaseReason: string | null
  startedAt: string
  finishedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface TeamArtifactClaim {
  id: string
  assignmentId: string
  companyId: string
  projectId: string
  taskId: string
  runId: string
  agentId: string
  artifactPath: string
  status: TeamArtifactClaimStatus
  claimedAt: string
  releasedAt: string | null
  releaseReason: string | null
}

export interface TeamReviewerLockout {
  id: string
  threadId: string
  companyId: string
  projectId: string
  taskId: string
  sourceTaskId: string
  sourceRunId: string | null
  sourceAssignmentId: string | null
  lockedAgentId: string
  reviewerAgentId: string | null
  reviewerActor: string
  artifactPath: string
  reason: string
  status: TeamReviewerLockoutStatus
  createdAt: string
  clearedAt: string | null
  clearedReason: string | null
}

export interface TeamMailboxMessage {
  id: string
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
  acknowledgedAt: string | null
}

export interface ReviewResult {
  id: string
  companyId: string
  projectId: string
  runId: string
  taskId: string
  reviewerRunId: string | null
  outcome: ReviewOutcome
  summary: string
  findings: ReviewFinding[]
  severity: ReviewSeverity
  changedFiles: string[]
  riskLevel: ReviewRiskLevel
  requiredFixes: string[]
  suggestedRepairPrompt: string
  promotionRecommendation: string
  inspectedDiff: string | null
  inspectedTaskPrompt: string | null
  inspectedAcceptanceCriteria: string | null
  inspectedVerificationOutput: string | null
  inspectedArchitectureRules: string | null
  repairTaskId: string | null
  approvedBy: string | null
  approvedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface AdapterLaneHealth {
  id: string
  companyId: string
  adapterType: AdapterType
  laneKey: string
  laneLabel: string
  status: AdapterLaneStatus
  reason: string | null
  cooldownUntil: string | null
  lastError: string | null
  lastSuccessAt: string | null
  lastCheckedAt: string
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface RuntimeLease {
  id: string
  companyId: string
  scope: string
  holder: string
  leaseKind: string
  acquiredAt: string
  expiresAt: string
  metadata: Record<string, unknown>
}

export interface RunEvent {
  id: string
  runId: string
  seq: number
  level: "info" | "warn" | "error"
  message: string
  data: Record<string, unknown> | null
  createdAt: string
}

export interface TaskEvent {
  id: string
  taskId: string
  kind: string
  message: string
  data: Record<string, unknown> | null
  createdAt: string
}

export interface SessionState {
  sessionKey: string
  id: string // Alias for sessionKey
  status: string // Inferred from task/run
  companyId: string
  projectId: string
  taskId: string
  agentId: string
  adapterType: AdapterType
  sessionDisplayId: string | null
  state: Record<string, unknown>
  updatedAt: string
}

export interface BudgetWindow {
  id: string
  companyId: string
  agentId: string
  periodKind: BudgetWindowKind
  periodKey: string
  usageUnits: number
  runCount: number
  updatedAt: string
}

export interface ApprovalRequest {
  id: string
  companyId: string
  taskId: string
  status: ApprovalStatus
  reason: string
  createdAt: string
  decidedAt: string | null
  decidedBy: string | null
  notes: string | null
}

export interface JobSpec {
  id: string
  companyId: string
  projectId: string
  jobId: JobId
  sourcePath: string
  cron: string
  timezone: string
  entryAgent: string | null
  lastTriggeredAt: string | null
  lastResult: string | null
  createdAt: string
  updatedAt: string
}

export interface JobRun {
  id: string
  jobSpecId: string
  status: JobRunStatus
  triggeredAt: string
  completedAt: string | null
  resultSummary: string | null
  data: Record<string, unknown> | null
  createdAt: string
}

export interface RoutingRule {
  id: string
  name: string
  priority: number
  targetAdapterType: AdapterType
  matchType: RoutingMatchType
  patterns: string[]
  isFallback: boolean
  createdAt: string
}

export interface PromotionRecord {
  id: string
  companyId: string
  projectId: string
  workflowId: string | null
  taskId: string
  branchName: string
  prNumber: number | null
  prUrl: string | null
  headSha: string | null
  baseBranch: string
  promotionStatus: PromotionStatus
  mergeMethod: MergeMethod
  lastReviewSyncAt: string | null
  lastChecksSyncAt: string | null
  retryCount: number
  lastError: string | null
  createdAt: string
  updatedAt: string
  mergedAt: string | null
}

export interface Automation {
  id: string
  companyId: string
  projectId: string | null
  name: string
  kind: AutomationKind
  status: AutomationStatus
  cron: string
  nextRunAt: string | null
  payload: Record<string, unknown>
  lastRunAt: string | null
  createdAt: string
  updatedAt: string
}

export interface MemoryChunk {
  id: string
  projectId: string
  layer: MemoryLayer
  sourceKind: MemorySourceKind
  sourceRef: string
  sourcePath: string | null
  audience: MemoryAudience
  lifecycleStatus: MemoryLifecycleStatus
  title: string
  content: string
  contentHash: string
  freshnessScore: number | null
  expiresAt: string | null
  compactedAt: string | null
  supersededByChunkId: string | null
  provenance: MemoryProvenance
  retention: MemoryRetentionPolicy
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface MemoryEmbedding {
  id: string
  chunkId: string
  provider: string
  model: string
  dimensions: number
  vector: number[]
  createdAt: string
  updatedAt: string
}

export interface RetrievedMemoryChunk {
  chunk: MemoryChunk
  similarity: number | null
  keywordScore: number
  freshnessScore: number | null
}

export interface MemorySourceReference {
  kind: string
  ref: string
  path?: string | null
  capturedAt?: string | null
}

export interface MemoryDerivation {
  kind: MemoryDerivationKind
  sourceChunkIds: string[]
  summaryOfSourceRefs?: string[]
  notes?: string | null
}

export interface MemoryFreshness {
  recordedAt: string
  observedAt?: string | null
  staleAfter?: string | null
  expiresAt?: string | null
  score?: number | null
}

export interface MemoryRetentionPolicy {
  preserveDecisionTrace: boolean
  preserveRaw: boolean
  pinned: boolean
  importance: MemoryImportance
  retainUntil?: string | null
}

export interface MemoryProvenance {
  sources: MemorySourceReference[]
  freshness: MemoryFreshness
  derivation?: MemoryDerivation | null
  tags?: string[]
}

export interface AdapterUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  costUnits?: number
}

export interface AdapterHealthcheckResult {
  ok: boolean
  message: string
}

export interface SessionCompactionPolicy {
  enabled: boolean
  maxSessionRuns: number
  maxRawInputTokens: number
  maxSessionAgeHours: number
}

export type NativeContextManagement = "confirmed" | "likely" | "unknown" | "none"

export interface AdapterCapabilityProfile {
  supportsSessionResume: boolean
  supportsCompaction: boolean
  compactionStrategy: "none" | "summarize" | "rotate" | "native"
  preferredPlanningContextWindow: number | null
  planningPriority: number
  planningCostClass: "low" | "medium" | "high"
  nativeContextManagement: NativeContextManagement
  heartbeatIdentityMode: "prompt" | "env" | "prompt_and_env"
  defaultSessionCompaction: SessionCompactionPolicy
}

export interface RuntimeIdentityPayload {
  version: 1
  runtimeKey: string
  executionKey: string
  companyId: string
  projectId: string
  projectName: string
  repoPath: string
  taskId: string
  taskKind: TaskKind
  taskTitle: string
  workflowId: string | null
  laneId: string | null
  agentId: string
  agentName: string
  adapterType: AdapterType
  model: string | null
  routing?: {
    selectedModel: string | null
    reasoningEffort: ModelReasoningEffort
    modelFamily: string
    modelRoutingReason: string
    complexityScore: number
    complexityScore100?: number
    importanceScore: number
    valueScore100?: number
    complexityBand?: "low" | "medium" | "high" | "critical"
    importanceBand?: "low" | "medium" | "high" | "critical"
    domains?: string[]
    complexitySignals: string[]
    importanceSignals: string[]
    promptRouteRank?: PromptRouteRank
    costEstimate?: RouteCostEstimate
  }
  wake: {
    reason: WakeReason
    heartbeatJobId: JobId | null
    triggeredAt: string
  }
  continuation: {
    sessionKey: string
    sessionDisplayId: string | null
    retryCount: number
    attempt: number
    heartbeatEnabled: boolean
    heartbeatIntervalSec: number
    supportsSessionResume: boolean
    nativeContextManagement: NativeContextManagement
  }
  scope: {
    allowedPaths: string[]
    requiredReading: string[]
    verificationCommands: string[]
  }
}

export interface AdapterContinuationState {
  sessionDisplayId: string | null
  state: Record<string, unknown>
}

export interface AdapterResultMetadata {
  adapterType: AdapterType
  provider: string
  model: string | null
  capabilities: AdapterCapabilityProfile
  transport?: string
}

export type AdapterFailureCategory =
  | "auth"
  | "quota"
  | "model-not-found"
  | "transport"
  | "session-corruption"
  | "timeout"

export interface AdapterExecutionContext {
  company: Company
  project: Project
  task: Task
  agent: Agent
  prompt: string
  runId: string
  wakeReason: WakeReason
  heartbeatJobId: JobId | null
  triggeredAt: string
  sessionKey: string
  sessionState: SessionState | null
  runtimeIdentity: RuntimeIdentityPayload
  log: (level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>) => void
}

export interface AdapterExecutionResult {
  ok: boolean
  response: string
  metadata?: AdapterResultMetadata
  continuation?: AdapterContinuationState | null
  runtimeIdentity?: RuntimeIdentityPayload
  sessionDisplayId?: string | null
  sessionState?: Record<string, unknown>
  usage?: AdapterUsage
  stdout?: string
  stderr?: string
  error?: string
  failureCategory?: AdapterFailureCategory
}

export interface AdapterDefinition {
  type: AdapterType
  label: string
  capabilities: AdapterCapabilityProfile
  prepare: (context: AdapterExecutionContext) => Promise<{
    argv: string[]
    cwd: string
    env: NodeJS.ProcessEnv
    stdin?: string
  }>
  execute: (context: AdapterExecutionContext) => Promise<AdapterExecutionResult>
  resume: (sessionState: SessionState | null) => Promise<Record<string, unknown> | null>
  parseResult: (stdout: string, stderr: string, fallbackResponse?: string) => AdapterExecutionResult
  healthcheck: (agent: Agent) => Promise<AdapterHealthcheckResult>
}

export type TaskRouteShape =
  | "repo_execution"
  | "frontend_execution"
  | "planning"
  | "review"
  | "coordination"
  | "general"

export type ModelReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra"

export interface TaskRiskAssessment {
  complexityScore: number
  complexityScore100: number
  importanceScore: number
  valueScore100: number
  complexityBand: "low" | "medium" | "high" | "critical"
  importanceBand: "low" | "medium" | "high" | "critical"
  domains: string[]
  complexitySignals: string[]
  importanceSignals: string[]
  promptRouteRank: PromptRouteRank
}

export interface AgentSelectionCandidate {
  agentId: string
  agentName: string
  adapterType: AdapterType
  model: string | null
  modelFamily: string
  score: number
  estimatedCostUsd: number | null
  reasons: string[]
}

export interface AgentSelectionDecision {
  agent: Agent | null
  reason: string | null
  candidates: AgentSelectionCandidate[]
}

export interface RouteScorecardEntry {
  adapterType: AdapterType
  score: number
  ladderRank: number
  available: boolean
  healthOk: boolean
  reasons: string[]
  healthMessage: string | null
}

export interface RouteCostEstimate {
  model: string | null
  modelFamily: string
  pricingSource: string | null
  inputTokens: number
  outputTokens: number
  inputUsdPerMillionTokens: number | null
  outputUsdPerMillionTokens: number | null
  estimatedUsd: number | null
  valueBand: "low" | "medium" | "high" | "critical"
}

export interface RouteDecision {
  adapterType: AdapterType
  reason: string
  rule: RoutingRule | null
  agent: Agent | null
  selectedModel: string | null
  reasoningEffort: ModelReasoningEffort
  modelFamily: string
  modelRoutingReason: string
  risk: TaskRiskAssessment
  taskShape: TaskRouteShape
  fallbackLadder: AdapterType[]
  selectionReasons: string[]
  scorecard: RouteScorecardEntry[]
  agentSelection: AgentSelectionDecision | null
  costEstimate: RouteCostEstimate
}

export interface BudgetStatus {
  agent: Agent
  periodKey: string
  usageUnits: number
  runCount: number
  remainingUnits: number | null
  blocked: boolean
}

export interface TickSummary {
  executedRuns: number
  blockedTasks: number
  skippedTasks: number
  followUpTasks: number
  executedJobs: number
  createdReviewTasks: number
}
