export type AgentVisualStatus =
  | "idle"
  | "queued"
  | "running"
  | "streaming"
  | "completed"
  | "error"
  | "paused"
  | "offline"

export type TimelineTone = "neutral" | "info" | "success" | "warn" | "error"

export interface AgentIdentity {
  id: string
  name: string
  role?: string | undefined
  model?: string | undefined
}

export interface MessageTimelineEntry {
  kind: "message"
  id: string
  ts?: string | undefined
  role: "user" | "assistant" | "system"
  content: string
  streaming?: boolean | undefined
  agentId?: string | undefined
  agentName?: string | undefined
}

export interface ThinkingTimelineEntry {
  kind: "thinking"
  id: string
  ts?: string | undefined
  content: string
  streaming?: boolean | undefined
  agentId?: string | undefined
  agentName?: string | undefined
}

export interface ToolTimelineEntry {
  kind: "tool"
  id: string
  ts?: string | undefined
  endTs?: string | undefined
  name: string
  summary?: string | undefined
  input?: string | undefined
  result?: string | undefined
  status: "running" | "completed" | "error"
  agentId?: string | undefined
  agentName?: string | undefined
}

export interface TransitionTimelineEntry {
  kind: "transition"
  id: string
  ts?: string | undefined
  label: string
  detail?: string | undefined
  fromState?: string | undefined
  toState?: string | undefined
  tone?: TimelineTone | undefined
  agentId?: string | undefined
  agentName?: string | undefined
}

export type AgentTimelineEntry =
  | MessageTimelineEntry
  | ThinkingTimelineEntry
  | ToolTimelineEntry
  | TransitionTimelineEntry

export interface AgentConversationLane extends AgentIdentity {
  status: AgentVisualStatus
  activityHint?: string | undefined
  issueLabel?: string | undefined
  startedAt?: string | undefined
  updatedAt?: string | undefined
  entries: AgentTimelineEntry[]
}

export interface ParallelAgentConsoleData {
  agents: AgentConversationLane[]
  transitions: TransitionTimelineEntry[]
}

export interface PaperclipTranscriptEntryLike {
  kind: string
  ts?: string | undefined
  text?: string | undefined
  delta?: boolean | undefined
  name?: string | undefined
  toolUseId?: string | undefined
  tool_use_id?: string | undefined
  input?: unknown
  content?: string | undefined
  isError?: boolean | undefined
  status?: string | undefined
  subtype?: string | undefined
}

export interface PaperclipTranscriptMeta {
  agentId: string
  agentName: string
  role?: string | undefined
  model?: string | undefined
  issueLabel?: string | undefined
  status?: AgentVisualStatus | undefined
  startedAt?: string | undefined
  updatedAt?: string | undefined
}

export interface SquadShellMessageLike {
  role: "user" | "agent" | "system"
  content: string
  agentName?: string | undefined
  timestamp: Date | string
}

export interface SquadAgentSessionLike {
  name: string
  role?: string | undefined
  status: "idle" | "working" | "streaming" | "error"
  startedAt: Date | string
  activityHint?: string | undefined
  model?: string | undefined
}

export interface SquadRuntimeEventLike {
  type: string
  sessionId?: string | undefined
  agentName?: string | undefined
  timestamp: Date | string
  payload?: unknown
}

export interface SquadReasoningDeltaLike {
  content: string
  sessionId?: string | undefined
  agentName?: string | undefined
  timestamp: Date | string
  index?: number | undefined
}

export interface NormalizeSquadStateInput {
  sessions?: readonly SquadAgentSessionLike[]
  messages?: readonly SquadShellMessageLike[]
  reasoning?: readonly SquadReasoningDeltaLike[]
  events?: readonly SquadRuntimeEventLike[]
}

export type DashboardTone = "neutral" | "info" | "success" | "warn" | "error"

export type HealthState = "healthy" | "watch" | "degraded" | "blocked"

export type QueueStatus = "queued" | "running" | "review_needed" | "blocked" | "promotion_pending" | "done"

export type CodexJobStatus = "queued" | "running" | "review_needed" | "blocked" | "succeeded" | "failed"

export type AdapterQuotaState = "green" | "amber" | "red" | "unknown"

export interface DashboardMetric {
  id: string
  label: string
  value: string | number
  detail?: string | undefined
  tone?: DashboardTone | undefined
}

export interface CompanyOverview {
  companyName: string
  operatingMode: string
  mission: string
  activeProjects: number
  activePersonas: number
  autonomyLevel: string
  lastDirectorPassAt: string
  decisionPolicy: string
  metrics: readonly DashboardMetric[]
}

export interface ProjectHealthItem {
  id: string
  name: string
  repo: string
  ownerLane: string
  health: HealthState
  score: number
  summary: string
  lastVerifiedAt?: string | undefined
  nextAction: string
}

export interface AutonomousLoopItem {
  id: string
  name: string
  status: AgentVisualStatus
  ownerPersona: string
  currentStep: string
  decision: string
  nextCheckpoint: string
}

export interface QueueStatusItem {
  id: string
  status: QueueStatus
  count: number
  oldestAge: string
  policy: string
}

export interface CodexJobItem {
  id: string
  taskId: string
  title: string
  persona: string
  model: string
  status: CodexJobStatus
  branch?: string | undefined
  startedAt?: string | undefined
  decisionSummary: string
}

export interface ActionTaskItem {
  id: string
  title: string
  project: string
  ownerPersona: string
  priority: "low" | "medium" | "high" | "critical"
  reason: string
  nextAction: string
}

export interface BlockedTaskItem extends ActionTaskItem {
  blocker: string
  escalationOwner: string
}

export interface PersonaScorecard {
  id: string
  persona: string
  role: string
  status: AgentVisualStatus
  score: number
  throughput: number
  reviewPassRate: number
  decisionQuality: number
  currentFocus: string
}

export interface AdapterQuotaItem {
  id: string
  adapter: string
  lane: string
  state: AdapterQuotaState
  remaining: number | null
  limit: number | null
  resetAt?: string | undefined
  policy: string
}

export interface DecisionRecord {
  id: string
  madeAt: string
  actor: string
  action: string
  rationale: string
  outcome: string
  evidence: readonly string[]
}

export interface RiskAlert {
  id: string
  severity: "low" | "medium" | "high" | "critical"
  title: string
  project: string
  signal: string
  mitigation: string
}

export interface PromotionCandidate {
  id: string
  taskId: string
  title: string
  branch: string
  readiness: number
  checks: "passing" | "pending" | "failing"
  reviewState: "approved" | "waiting" | "changes_requested"
  mergePolicy: string
}

export interface PullRequestRecord {
  id: string
  title: string
  repo: string
  url: string
  authorPersona: string
  state: "open" | "ready_for_review" | "merged" | "blocked"
  createdAt: string
  decisionSummary: string
}

export interface EvaluationTrendPoint {
  label: string
  passRate: number
  regressions: number
  coverage: number
}

export interface AuditTimelineEntry {
  id: string
  at: string
  actor: string
  event: string
  tone: TimelineTone
  detail: string
}

export interface AutonomousCompanyDashboardData {
  overview: CompanyOverview
  projectHealth: readonly ProjectHealthItem[]
  activeLoops: readonly AutonomousLoopItem[]
  queueStatus: readonly QueueStatusItem[]
  runningCodexJobs: readonly CodexJobItem[]
  reviewNeededTasks: readonly ActionTaskItem[]
  blockedTasks: readonly BlockedTaskItem[]
  personaScorecards: readonly PersonaScorecard[]
  adapterQuotas: readonly AdapterQuotaItem[]
  recentDecisions: readonly DecisionRecord[]
  riskAlerts: readonly RiskAlert[]
  promotionCandidates: readonly PromotionCandidate[]
  pullRequests: readonly PullRequestRecord[]
  evaluationTrends: readonly EvaluationTrendPoint[]
  auditTimeline: readonly AuditTimelineEntry[]
}
