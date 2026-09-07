import type { LaneOutcomeStats, LaneProposal } from "./feedback.js"
import type {
  AdapterType,
  ModelReasoningEffort,
  TaskKind,
  TaskLane,
  TaskPackage,
  TaskPortfolioBucket,
  TaskSourceIntent
} from "./types.js"

export type PlannerGovernanceClass = "normal" | "major_change" | "sensitive" | "manual_only"
export type PlannerRiskLevel = "low" | "medium" | "high"
export type PlannerCreateMode = "queue_now" | "artifacts_only"
export type PlannerDecisionAction = "create" | "skip_duplicate" | "update_existing_metadata" | "supersede_previous"
export type PlannerSignalCollectorKind =
  | "repo_paths_churn"
  | "queue_state"
  | "review_promotion_state"
  | "repo_memory"
  | "verification_rules"
  | "repo_directives"
  | "todo_fixme"

export interface RepoPlanningSnapshot {
  version: 1
  generatedAt: string
  projectId: string
  projectName: string
  repoPath: string
  profileId: string | null
  projectVerifyCommand: string | null
  changedFiles: string[]
  laneHotspots: Array<{
    laneId: string
    fileCount: number
    files: string[]
  }>
  laneInventory: Array<{
    laneId: string
    fileCount: number
    testFileCount: number
    publicFacades: string[]
    sampleFiles: string[]
  }>
  verificationCommands: string[]
  staleTasks: Array<{
    id: string
    title: string
    kind: TaskKind
    status: string
    laneId: string | null
    ageHours: number | null
  }>
  promotionBlockers: Array<{
    taskId: string
    title: string
    status: string
    laneId: string | null
  }>
  memoryHighlights: string[]
  directives: string[]
  todoFixmeHits: Array<{
    path: string
    line: number
    text: string
    laneId?: string | null
  }>
  sourceCollectors: PlannerSignalCollectorKind[]
  /** Per-lane track record from the outcome ledger, the planner's feedback signal. */
  laneOutcomeStats?: LaneOutcomeStats[]
  /** Advisory lane create/adjust proposals derived from churn vs. outcomes. */
  laneProposals?: LaneProposal[]
}

export interface PlannerCandidateTask {
  title: string
  description: string
  implementationPrompt?: string | undefined
  kind: TaskKind
  lane: TaskLane
  personaId: string | null
  portfolioBucket?: TaskPortfolioBucket | undefined
  userOutcome?: string | undefined
  acceptanceCriteria?: string[] | undefined
  taskSourceIntent?: TaskSourceIntent | undefined
  preferredAdapterType: AdapterType | null
  priority: number
  targetPaths?: string[] | undefined
  requiredReading: string[]
  verificationChecklist: string[]
  contractUpdateReminders: string[]
  repoNotes: string[]
  dependencies: string[]
  tags: string[]
  riskLevel: PlannerRiskLevel
  governanceClass: PlannerGovernanceClass
  dedupeKey: string
  sourceSignals: string[]
  estimatedCost: number | null
  createMode: PlannerCreateMode
}

export interface PlannerRunArtifact {
  plannerRunId: string
  projectId: string
  kind: "snapshot" | "brief" | "output" | "orchestration_log" | "events"
  path: string
  createdAt: string
}

export interface PlannerDecision {
  candidateIndex: number
  title: string
  dedupeKey: string
  action: PlannerDecisionAction
  reason: string
  existingTaskId?: string | null
  createdTaskId?: string | null
}

export interface PlannerGovernanceFlag {
  blocked: boolean
  class: PlannerGovernanceClass
  reason: string
}

export interface PlannerRunSummary {
  createdTaskIds: string[]
  skippedCandidates: number
  blockedCandidates: number
  deferred: boolean
}

export interface PlannerCostPolicy {
  plannerDailyBudgetLimit: number | null
  plannerConcurrencyCap: number | null
  reduceMaxTasksWhenCodexWarm: boolean
  fallbackPlannerAdapterType?: AdapterType | null | undefined
  preferredPlannerModel?: string | null | undefined
  plannerReasoningEffort?: ModelReasoningEffort | undefined
}

export interface PlannerGovernancePolicy {
  allowAutonomousMajorChanges: boolean
  manualOnlyLanes: string[]
  maxTasksPerRun: number
  maxMajorTasksPerDay: number
  allowCrossLaneDependencies: boolean
}

export interface PlannerArtifactPolicy {
  plannerRunsDir?: string
  retentionDays?: number | null
}

export interface PlannerPolicy {
  enabled: boolean
  schedule?: string | null
  maxTasksPerRun: number
  maxMajorTasksPerRun: number
  dedupeWindowHours: number
  allowedLanes: string[]
  defaultPersonaByLane: Record<string, string>
  defaultAdapterByLane: Record<string, AdapterType>
  signalCollectors: PlannerSignalCollectorKind[]
  governance: PlannerGovernancePolicy
  costPolicy: PlannerCostPolicy
  artifactPolicy: PlannerArtifactPolicy
}

export interface PlannerOutputEnvelope {
  version: 1
  summary?: string
  candidates: PlannerCandidateTask[]
}

export interface AdapterSessionPolicy {
  supportsResume: boolean
  supportsCompaction: boolean
  compactionStrategy: "none" | "summarize" | "rotate" | "native"
  preferredPlanningContextWindow: number | null
}

export interface PlannerRunRecord {
  id: string
  companyId: string
  projectId: string
  automationId: string | null
  trigger: "automation" | "manual" | "job"
  status: "running" | "succeeded" | "failed" | "deferred"
  plannerPersonaId: string | null
  plannerAgentId: string | null
  adapterType: AdapterType | null
  snapshotJson: RepoPlanningSnapshot | null
  outputJson: PlannerOutputEnvelope | null
  summaryJson: PlannerRunSummary | null
  errorText: string | null
  startedAt: string
  finishedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface PlannerEvent {
  id: string
  plannerRunId: string
  seq: number
  kind: string
  message: string
  data: Record<string, unknown> | null
  createdAt: string
}

export function plannerCandidateToTaskPackage(input: {
  candidate: PlannerCandidateTask
  profileId: string
  taskId: string
  generatedAt?: string
}): TaskPackage {
  const extraInstructions = [
    ...(input.candidate.sourceSignals.some((signal) => signal.startsWith("promptify:"))
      ? [
          "This task passed through the promptify persona stage before routing.",
          "Use the promptified execution brief and persona execution contract as the authoritative scope, boundaries, acceptance criteria, and verification plan."
        ]
      : []),
    input.candidate.implementationPrompt
      ? `Planner implementation prompt:\n${input.candidate.implementationPrompt}`
      : null,
    input.candidate.targetPaths?.length
      ? `Target paths:\n${input.candidate.targetPaths.map((path) => `- ${path}`).join("\n")}`
      : null
  ].filter((value): value is string => Boolean(value?.trim()))

  return {
    version: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    repoProfile: input.profileId,
    likelyOwnershipLane: input.candidate.lane,
    laneReason: `Planner selected lane ${input.candidate.lane}`,
    inferenceSignals: input.candidate.sourceSignals,
    requiredReading: input.candidate.requiredReading,
    verificationChecklist: input.candidate.verificationChecklist,
    contractUpdateReminders: input.candidate.contractUpdateReminders,
    repoNotes: input.candidate.repoNotes,
    adapterPreference: input.candidate.preferredAdapterType,
    personaProvenance: input.candidate.personaId
      ? {
          personaId: input.candidate.personaId,
          personaName: input.candidate.personaId,
          source: input.candidate.taskSourceIntent ?? "persona_ideation",
          portfolioBucket: input.candidate.portfolioBucket,
          rationale: `Planner assigned ${input.candidate.personaId} to ${input.candidate.lane}.`
        }
      : undefined,
    userOutcome: input.candidate.userOutcome ?? input.candidate.description,
    acceptanceCriteria: input.candidate.acceptanceCriteria,
    taskSourceIntent: input.candidate.taskSourceIntent ?? "persona_ideation",
    portfolioBucket: input.candidate.portfolioBucket,
    ...(extraInstructions.length > 0 ? { extraInstructions } : {}),
    promptRouteRank: {
      pipeline: ["ideation", "promptify", "complexity_estimate", "model_router"],
      intent: input.candidate.kind === "plan" ? "ideation" : "promptify",
      ideationScore: Math.max(
        0,
        Math.min(100, Math.round(input.candidate.priority + input.candidate.sourceSignals.length * 6))
      ),
      promptQualityScore: Math.max(
        0,
        Math.min(
          100,
          20 +
            (input.candidate.description.trim() ? 20 : 0) +
            (input.candidate.requiredReading.length ? 20 : 0) +
            (input.candidate.verificationChecklist.length ? 20 : 0) +
            (input.candidate.personaId ? 10 : 0)
        )
      ),
      complexityScore100: input.candidate.riskLevel === "high" ? 80 : input.candidate.riskLevel === "medium" ? 55 : 25,
      valueScore100:
        input.candidate.governanceClass === "sensitive" || input.candidate.governanceClass === "major_change"
          ? 85
          : input.candidate.riskLevel === "high"
            ? 70
            : 35,
      recommendedPersonaStage: input.candidate.personaId
        ? null
        : input.candidate.kind === "review"
          ? "reviewer"
          : input.candidate.kind === "plan"
            ? "planner"
            : "coder",
      promptSignals: [
        `planner-risk:${input.candidate.riskLevel}`,
        `planner-governance:${input.candidate.governanceClass}`,
        `planner-priority:${input.candidate.priority}`,
        ...input.candidate.tags.map((tag) => `tag:${tag}`)
      ],
      rankingReasons: [
        "planner candidate entered ideation stage",
        "prompt quality estimated from description, reading, verification, and persona metadata",
        `planner risk ${input.candidate.riskLevel} mapped into complexity estimate`,
        `governance class ${input.candidate.governanceClass} mapped into value estimate`
      ]
    },
    taskLineage: {
      taskId: input.taskId
    }
  }
}
