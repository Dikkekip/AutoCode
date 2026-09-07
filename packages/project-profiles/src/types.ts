import type {
  AdapterType,
  JobId,
  MergeMethod,
  OpenClawStateBackendConfig,
  PersonaProfileOverride,
  PlannerArtifactPolicy,
  PlannerCostPolicy,
  PlannerGovernancePolicy,
  PlannerSignalCollectorKind,
  ResponseCompressionMode,
  TaskPortfolioBucket
} from "@openclaw/domain"

export type RepoDetectionSignalKind = "file" | "directory"

export interface RepoDetectionSignal {
  kind: RepoDetectionSignalKind
  path: string
  weight: number
}

export interface RequiredReadingRule {
  ruleId: string
  displayName: string
  paths: string[]
}

export interface VerificationRule {
  ruleId: string
  displayName: string
  commands: string[]
}

export interface LaneDefinition {
  laneId: string
  displayName: string
  preferredAdapterType: AdapterType
  allowedPaths: string[]
  publicFacades?: string[] | undefined
  requiredReadingRuleId: string
  verificationRuleId: string
  categoryHints?: string[] | undefined
  extraInstructions?: string[] | undefined
}

export interface CategoryDefinition {
  categoryId: string
  displayName: string
  laneIds: string[]
  priority: number
}

export interface ProfileRoutingRule {
  name: string
  targetAdapterType: AdapterType
  priority: number
  patterns: string[]
  isFallback?: boolean
}

export interface ManagerPersonaDefinition {
  id: string
  focus: string
  ownedLaneIds: string[]
  preferredAdapterType: AdapterType
  roleClass?: string | undefined
  taskQuotaWeight?: number | undefined
  ideationPrompt?: string | undefined
  successSignals?: string[] | undefined
  blockedEscalation?: string | undefined
}

export interface ManagerSeedTaskDefinition {
  id: string
  title: string
  kind: string
  priority: number
  verificationHint?: string | undefined
  description?: string | undefined
}

export interface ManagerProjectDefinition {
  id: string
  title: string
  status: string
  laneId: string
  categoryId: string
  managerPersonaId: string
  seedTask: ManagerSeedTaskDefinition
}

export interface ManagerGoalDefinition {
  id: string
  title: string
  status: string
  projectIds: string[]
}

export interface ManagerStateDefaults {
  version: number
  managerPersonas: ManagerPersonaDefinition[]
  goals: ManagerGoalDefinition[]
  projects: ManagerProjectDefinition[]
  promptPatterns?: Record<string, string> | undefined
}

export interface PromotionPolicy {
  importPersonaNames?: string[] | undefined
  mode: "ready_pr" | "manual"
  maxOpenPrsPerLane: number
  allowParallelLanes: boolean
  autoMerge?: boolean | undefined
  autoRelease?: boolean | undefined
  releaseTagBase?: string | undefined
  mergeMethod: MergeMethod
  requireCi: boolean
  requireReviewDecision: "approved" | "manual" | "none"
}

export interface NotificationPolicy {
  channel: "telegram" | "stdout" | "none"
  target?: string | null | undefined
  targetEnv?: string | null | undefined
}

export interface ArtifactPolicy {
  runtimeStateDir: string
  artifactRootDir: string
  worktreeRootDir: string
  auditLogPath: string
}

export interface PlannerProfilePolicy {
  enabled: boolean
  schedule?: string | null | undefined
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
  portfolioMix?: PlannerPortfolioBucketPolicy[] | undefined
}

export interface PlannerPortfolioBucketPolicy {
  bucket: TaskPortfolioBucket
  weight: number
  personas: string[]
  lanes: string[]
  minPerRun?: number | undefined
}

export interface JobDefinition {
  jobId: JobId
  cron: string
  timezone: string
  entryAgent?: string | null | undefined
}

export interface FrameworkSourceIdea {
  repoId: string
  sourcePaths: string[]
  adoptedIdeas: string[]
}

export interface FrameworkBucket {
  summary: string
  targetPackages: string[]
  inheritedFromLawyerRag: string[]
  borrowedFromSiblingRepos: FrameworkSourceIdea[]
  outOfScope: string[]
}

export interface ProfileRecipeSeed {
  recipeId: string
  title: string
  whenToUse: string
  steps: string[]
}

export interface ProfileExtensionPoint {
  extensionId: string
  kind: "profile" | "adapter" | "runtime-idea"
  summary: string
  delivery: string
}

export interface AdoptionPolicy {
  operatorDirective: string[]
  recipeSeeds: ProfileRecipeSeed[]
  extensionPoints: ProfileExtensionPoint[]
  manualSteps: string[]
}

export interface ResponsePolicy {
  compressionMode: ResponseCompressionMode
}

export interface FrameworkMap {
  version: number
  coreRuntime: FrameworkBucket
  orchestraRuntimePlanning: FrameworkBucket
  projectProfileSchema: FrameworkBucket
  memoryEval: FrameworkBucket
  auditOps: FrameworkBucket
  adapters: FrameworkBucket
  installerAdoption: FrameworkBucket
}

export interface ProjectProfile {
  executionPolicy?: import("./execution-policy.js").ExecutionPolicy
  nativeAutonomy?: import("@openclaw/domain").NativeAutonomyPolicy | undefined
  profileId: string
  version: string
  displayName: string
  description?: string | undefined
  adoptionPolicy: AdoptionPolicy
  framework: FrameworkMap
  laneDefinitions: LaneDefinition[]
  categoryDefinitions: CategoryDefinition[]
  requiredReadingRules: RequiredReadingRule[]
  verificationRules: VerificationRule[]
  routingRules: ProfileRoutingRule[]
  managerStateDefaults: ManagerStateDefaults
  promotionPolicy: PromotionPolicy
  notificationPolicy: NotificationPolicy
  artifactPolicy: ArtifactPolicy
  planner: PlannerProfilePolicy
  responsePolicy?: ResponsePolicy | undefined
  personas?: PersonaProfileOverride[] | undefined
  repoDetectionSignals: RepoDetectionSignal[]
  jobDefinitions: JobDefinition[]
  extraInstructions?: string[] | undefined
  stateBackend?: OpenClawStateBackendConfig | undefined
}

export interface ProfileDetectionMatch {
  profileId: string
  score: number
  matches: RepoDetectionSignal[]
}

export interface ProjectProfileInstallFile {
  absolutePath: string
  relativePath: string
  content: string
  reason: string
}
