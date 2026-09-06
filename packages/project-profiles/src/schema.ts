import type { AdapterType, PersonaProfileOverride, ResponseCompressionMode } from "@openclaw/domain"
import {
  assertPersonaDefinition,
  builtInPersonas,
  mergePersonaDefinitions,
  validateNativeAutonomyPolicy
} from "@openclaw/domain"
import { validateExecutionPolicy } from "./execution-policy.js"
import type {
  AdoptionPolicy,
  ArtifactPolicy,
  CategoryDefinition,
  FrameworkBucket,
  FrameworkMap,
  FrameworkSourceIdea,
  JobDefinition,
  LaneDefinition,
  ManagerGoalDefinition,
  ManagerPersonaDefinition,
  ManagerProjectDefinition,
  NotificationPolicy,
  PlannerPortfolioBucketPolicy,
  PlannerProfilePolicy,
  ProfileExtensionPoint,
  ProfileRecipeSeed,
  ProfileRoutingRule,
  ProjectProfile,
  PromotionPolicy,
  RepoDetectionSignal,
  RequiredReadingRule,
  ResponsePolicy,
  VerificationRule
} from "./types.js"

function ensureRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function ensureString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`)
  }
  return value.trim()
}

function ensureNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`)
  }
  return value
}

function ensureResponseCompressionMode(value: unknown, label: string): ResponseCompressionMode {
  const mode = ensureString(value, label)
  if (mode !== "off" && mode !== "lite" && mode !== "full" && mode !== "ultra") {
    throw new Error(`${label} must be one of off, lite, full, or ultra`)
  }
  return mode
}

function ensureStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`)
  }
  return value.map((entry, index) => ensureString(entry, `${label}[${index}]`))
}

function ensureObjectArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`)
  }
  return value
}

function mapFrameworkSourceIdea(value: unknown, label: string): FrameworkSourceIdea {
  const record = ensureRecord(value, label)
  return {
    repoId: ensureString(record.repoId, `${label}.repoId`),
    sourcePaths: ensureStringArray(record.sourcePaths, `${label}.sourcePaths`),
    adoptedIdeas: ensureStringArray(record.adoptedIdeas, `${label}.adoptedIdeas`)
  }
}

function mapFrameworkBucket(value: unknown, label: string): FrameworkBucket {
  const record = ensureRecord(value, label)
  return {
    summary: ensureString(record.summary, `${label}.summary`),
    targetPackages: ensureStringArray(record.targetPackages, `${label}.targetPackages`),
    inheritedFromLawyerRag: ensureStringArray(record.inheritedFromLawyerRag, `${label}.inheritedFromLawyerRag`),
    borrowedFromSiblingRepos: ensureObjectArray(
      record.borrowedFromSiblingRepos,
      `${label}.borrowedFromSiblingRepos`
    ).map((entry, index) => mapFrameworkSourceIdea(entry, `${label}.borrowedFromSiblingRepos[${index}]`)),
    outOfScope: ensureStringArray(record.outOfScope, `${label}.outOfScope`)
  }
}

function mapFramework(value: unknown): FrameworkMap {
  const record = ensureRecord(value, "framework")
  return {
    version: ensureNumber(record.version, "framework.version"),
    coreRuntime: mapFrameworkBucket(record.coreRuntime, "framework.coreRuntime"),
    orchestraRuntimePlanning: mapFrameworkBucket(record.orchestraRuntimePlanning, "framework.orchestraRuntimePlanning"),
    projectProfileSchema: mapFrameworkBucket(record.projectProfileSchema, "framework.projectProfileSchema"),
    memoryEval: mapFrameworkBucket(record.memoryEval, "framework.memoryEval"),
    auditOps: mapFrameworkBucket(record.auditOps, "framework.auditOps"),
    adapters: mapFrameworkBucket(record.adapters, "framework.adapters"),
    installerAdoption: mapFrameworkBucket(record.installerAdoption, "framework.installerAdoption")
  }
}

function mapRecipeSeed(value: unknown, index: number): ProfileRecipeSeed {
  const record = ensureRecord(value, `adoptionPolicy.recipeSeeds[${index}]`)
  return {
    recipeId: ensureString(record.recipeId, `adoptionPolicy.recipeSeeds[${index}].recipeId`),
    title: ensureString(record.title, `adoptionPolicy.recipeSeeds[${index}].title`),
    whenToUse: ensureString(record.whenToUse, `adoptionPolicy.recipeSeeds[${index}].whenToUse`),
    steps: ensureStringArray(record.steps, `adoptionPolicy.recipeSeeds[${index}].steps`)
  }
}

function mapExtensionPoint(value: unknown, index: number): ProfileExtensionPoint {
  const record = ensureRecord(value, `adoptionPolicy.extensionPoints[${index}]`)
  return {
    extensionId: ensureString(record.extensionId, `adoptionPolicy.extensionPoints[${index}].extensionId`),
    kind: ensureString(record.kind, `adoptionPolicy.extensionPoints[${index}].kind`) as ProfileExtensionPoint["kind"],
    summary: ensureString(record.summary, `adoptionPolicy.extensionPoints[${index}].summary`),
    delivery: ensureString(record.delivery, `adoptionPolicy.extensionPoints[${index}].delivery`)
  }
}

function mapAdoptionPolicy(value: unknown): AdoptionPolicy {
  const record = ensureRecord(value, "adoptionPolicy")
  return {
    operatorDirective: ensureStringArray(record.operatorDirective, "adoptionPolicy.operatorDirective"),
    recipeSeeds: ensureObjectArray(record.recipeSeeds, "adoptionPolicy.recipeSeeds").map(mapRecipeSeed),
    extensionPoints: ensureObjectArray(record.extensionPoints, "adoptionPolicy.extensionPoints").map(mapExtensionPoint),
    manualSteps: ensureStringArray(record.manualSteps, "adoptionPolicy.manualSteps")
  }
}

export function validateResponsePolicy(value: unknown): ResponsePolicy {
  const record = ensureRecord(value, "responsePolicy")
  return {
    compressionMode: ensureResponseCompressionMode(record.compressionMode, "responsePolicy.compressionMode")
  }
}

function mapRequiredReadingRule(value: unknown, index: number): RequiredReadingRule {
  const record = ensureRecord(value, `requiredReadingRules[${index}]`)
  return {
    ruleId: ensureString(record.ruleId, `requiredReadingRules[${index}].ruleId`),
    displayName: ensureString(record.displayName, `requiredReadingRules[${index}].displayName`),
    paths: ensureStringArray(record.paths, `requiredReadingRules[${index}].paths`)
  }
}

function mapVerificationRule(value: unknown, index: number): VerificationRule {
  const record = ensureRecord(value, `verificationRules[${index}]`)
  return {
    ruleId: ensureString(record.ruleId, `verificationRules[${index}].ruleId`),
    displayName: ensureString(record.displayName, `verificationRules[${index}].displayName`),
    commands: ensureStringArray(record.commands, `verificationRules[${index}].commands`)
  }
}

function mapLaneDefinition(value: unknown, index: number): LaneDefinition {
  const record = ensureRecord(value, `laneDefinitions[${index}]`)
  return {
    laneId: ensureString(record.laneId, `laneDefinitions[${index}].laneId`),
    displayName: ensureString(record.displayName, `laneDefinitions[${index}].displayName`),
    preferredAdapterType: ensureString(
      record.preferredAdapterType,
      `laneDefinitions[${index}].preferredAdapterType`
    ) as LaneDefinition["preferredAdapterType"],
    allowedPaths: ensureStringArray(record.allowedPaths, `laneDefinitions[${index}].allowedPaths`),
    requiredReadingRuleId: ensureString(
      record.requiredReadingRuleId,
      `laneDefinitions[${index}].requiredReadingRuleId`
    ),
    verificationRuleId: ensureString(record.verificationRuleId, `laneDefinitions[${index}].verificationRuleId`),
    categoryHints: Array.isArray(record.categoryHints)
      ? ensureStringArray(record.categoryHints, `laneDefinitions[${index}].categoryHints`)
      : undefined,
    extraInstructions: Array.isArray(record.extraInstructions)
      ? ensureStringArray(record.extraInstructions, `laneDefinitions[${index}].extraInstructions`)
      : undefined
  }
}

function mapCategoryDefinition(value: unknown, index: number): CategoryDefinition {
  const record = ensureRecord(value, `categoryDefinitions[${index}]`)
  return {
    categoryId: ensureString(record.categoryId, `categoryDefinitions[${index}].categoryId`),
    displayName: ensureString(record.displayName, `categoryDefinitions[${index}].displayName`),
    laneIds: ensureStringArray(record.laneIds, `categoryDefinitions[${index}].laneIds`),
    priority: ensureNumber(record.priority, `categoryDefinitions[${index}].priority`)
  }
}

function mapRoutingRule(value: unknown, index: number): ProfileRoutingRule {
  const record = ensureRecord(value, `routingRules[${index}]`)
  return {
    name: ensureString(record.name, `routingRules[${index}].name`),
    targetAdapterType: ensureString(
      record.targetAdapterType,
      `routingRules[${index}].targetAdapterType`
    ) as ProfileRoutingRule["targetAdapterType"],
    priority: ensureNumber(record.priority, `routingRules[${index}].priority`),
    patterns: ensureStringArray(record.patterns, `routingRules[${index}].patterns`),
    isFallback: record.isFallback === true
  }
}

function mapRepoDetectionSignal(value: unknown, index: number): RepoDetectionSignal {
  const record = ensureRecord(value, `repoDetectionSignals[${index}]`)
  return {
    kind: ensureString(record.kind, `repoDetectionSignals[${index}].kind`) as RepoDetectionSignal["kind"],
    path: ensureString(record.path, `repoDetectionSignals[${index}].path`),
    weight: ensureNumber(record.weight, `repoDetectionSignals[${index}].weight`)
  }
}

function mapManagerPersona(value: unknown, index: number): ManagerPersonaDefinition {
  const record = ensureRecord(value, `managerStateDefaults.managerPersonas[${index}]`)
  const persona: ManagerPersonaDefinition = {
    id: ensureString(record.id, `managerStateDefaults.managerPersonas[${index}].id`),
    focus: ensureString(record.focus, `managerStateDefaults.managerPersonas[${index}].focus`),
    ownedLaneIds: ensureStringArray(record.ownedLaneIds, `managerStateDefaults.managerPersonas[${index}].ownedLaneIds`),
    preferredAdapterType: ensureString(
      record.preferredAdapterType,
      `managerStateDefaults.managerPersonas[${index}].preferredAdapterType`
    ) as ManagerPersonaDefinition["preferredAdapterType"]
  }
  if (record.roleClass) {
    persona.roleClass = ensureString(
      record.roleClass,
      `managerStateDefaults.managerPersonas[${index}].roleClass`
    ) as ManagerPersonaDefinition["roleClass"]
  }
  if (record.taskQuotaWeight !== undefined) {
    persona.taskQuotaWeight = ensureNumber(
      record.taskQuotaWeight,
      `managerStateDefaults.managerPersonas[${index}].taskQuotaWeight`
    )
  }
  if (record.ideationPrompt) {
    persona.ideationPrompt = ensureString(
      record.ideationPrompt,
      `managerStateDefaults.managerPersonas[${index}].ideationPrompt`
    )
  }
  if (Array.isArray(record.successSignals)) {
    persona.successSignals = ensureStringArray(
      record.successSignals,
      `managerStateDefaults.managerPersonas[${index}].successSignals`
    )
  }
  if (record.blockedEscalation) {
    persona.blockedEscalation = ensureString(
      record.blockedEscalation,
      `managerStateDefaults.managerPersonas[${index}].blockedEscalation`
    )
  }
  return persona
}

function mapManagerGoal(value: unknown, index: number): ManagerGoalDefinition {
  const record = ensureRecord(value, `managerStateDefaults.goals[${index}]`)
  return {
    id: ensureString(record.id, `managerStateDefaults.goals[${index}].id`),
    title: ensureString(record.title, `managerStateDefaults.goals[${index}].title`),
    status: ensureString(record.status, `managerStateDefaults.goals[${index}].status`),
    projectIds: ensureStringArray(record.projectIds, `managerStateDefaults.goals[${index}].projectIds`)
  }
}

function mapManagerProject(value: unknown, index: number): ManagerProjectDefinition {
  const record = ensureRecord(value, `managerStateDefaults.projects[${index}]`)
  const seedTask = ensureRecord(record.seedTask, `managerStateDefaults.projects[${index}].seedTask`)
  return {
    id: ensureString(record.id, `managerStateDefaults.projects[${index}].id`),
    title: ensureString(record.title, `managerStateDefaults.projects[${index}].title`),
    status: ensureString(record.status, `managerStateDefaults.projects[${index}].status`),
    laneId: ensureString(record.laneId, `managerStateDefaults.projects[${index}].laneId`),
    categoryId: ensureString(record.categoryId, `managerStateDefaults.projects[${index}].categoryId`),
    managerPersonaId: ensureString(record.managerPersonaId, `managerStateDefaults.projects[${index}].managerPersonaId`),
    seedTask: {
      id: ensureString(seedTask.id, `managerStateDefaults.projects[${index}].seedTask.id`),
      title: ensureString(seedTask.title, `managerStateDefaults.projects[${index}].seedTask.title`),
      kind: ensureString(seedTask.kind, `managerStateDefaults.projects[${index}].seedTask.kind`),
      priority: ensureNumber(seedTask.priority, `managerStateDefaults.projects[${index}].seedTask.priority`),
      verificationHint: seedTask.verificationHint
        ? ensureString(seedTask.verificationHint, `managerStateDefaults.projects[${index}].seedTask.verificationHint`)
        : undefined,
      description: seedTask.description
        ? ensureString(seedTask.description, `managerStateDefaults.projects[${index}].seedTask.description`)
        : undefined
    }
  }
}

function mapPromotionPolicy(value: unknown): PromotionPolicy {
  const record = ensureRecord(value, "promotionPolicy")
  return {
    importPersonaNames:
      record.importPersonaNames === undefined
        ? undefined
        : ensureStringArray(record.importPersonaNames, "promotionPolicy.importPersonaNames"),
    mode: ensureString(record.mode, "promotionPolicy.mode") as PromotionPolicy["mode"],
    maxOpenPrsPerLane: ensureNumber(record.maxOpenPrsPerLane, "promotionPolicy.maxOpenPrsPerLane"),
    allowParallelLanes: record.allowParallelLanes === true,
    autoMerge: record.autoMerge === true,
    autoRelease: record.autoRelease === true,
    releaseTagBase:
      typeof record.releaseTagBase === "string" && record.releaseTagBase.trim()
        ? record.releaseTagBase.trim()
        : undefined,
    mergeMethod: ensureString(record.mergeMethod, "promotionPolicy.mergeMethod") as PromotionPolicy["mergeMethod"],
    requireCi: record.requireCi === true,
    requireReviewDecision: ensureString(
      record.requireReviewDecision,
      "promotionPolicy.requireReviewDecision"
    ) as PromotionPolicy["requireReviewDecision"]
  }
}

function mapNotificationPolicy(value: unknown): NotificationPolicy {
  const record = ensureRecord(value, "notificationPolicy")
  return {
    channel: ensureString(record.channel, "notificationPolicy.channel") as NotificationPolicy["channel"],
    target: record.target ? ensureString(record.target, "notificationPolicy.target") : undefined,
    targetEnv: record.targetEnv ? ensureString(record.targetEnv, "notificationPolicy.targetEnv") : undefined
  }
}

function mapArtifactPolicy(value: unknown): ArtifactPolicy {
  const record = ensureRecord(value, "artifactPolicy")
  return {
    runtimeStateDir: ensureString(record.runtimeStateDir, "artifactPolicy.runtimeStateDir"),
    artifactRootDir: ensureString(record.artifactRootDir, "artifactPolicy.artifactRootDir"),
    worktreeRootDir: ensureString(record.worktreeRootDir, "artifactPolicy.worktreeRootDir"),
    auditLogPath: ensureString(record.auditLogPath, "artifactPolicy.auditLogPath")
  }
}

function ensureBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`)
  }
  return value
}

function mapPlannerPolicy(value: unknown): PlannerProfilePolicy {
  const record = ensureRecord(value, "planner")
  const governance = ensureRecord(record.governance, "planner.governance")
  const costPolicy = ensureRecord(record.costPolicy, "planner.costPolicy")
  const artifactPolicy = record.artifactPolicy ? ensureRecord(record.artifactPolicy, "planner.artifactPolicy") : {}
  const defaultPersonaByLane = record.defaultPersonaByLane
    ? ensureRecord(record.defaultPersonaByLane, "planner.defaultPersonaByLane")
    : {}
  const defaultAdapterByLane = record.defaultAdapterByLane
    ? ensureRecord(record.defaultAdapterByLane, "planner.defaultAdapterByLane")
    : {}

  const policy: PlannerProfilePolicy = {
    enabled: ensureBoolean(record.enabled, "planner.enabled"),
    schedule: record.schedule ? ensureString(record.schedule, "planner.schedule") : undefined,
    maxTasksPerRun: ensureNumber(record.maxTasksPerRun, "planner.maxTasksPerRun"),
    maxMajorTasksPerRun: ensureNumber(record.maxMajorTasksPerRun, "planner.maxMajorTasksPerRun"),
    dedupeWindowHours: ensureNumber(record.dedupeWindowHours, "planner.dedupeWindowHours"),
    allowedLanes: ensureStringArray(record.allowedLanes, "planner.allowedLanes"),
    defaultPersonaByLane: Object.fromEntries(
      Object.entries(defaultPersonaByLane).map(([key, entry]) => [
        key,
        ensureString(entry, `planner.defaultPersonaByLane.${key}`)
      ])
    ),
    defaultAdapterByLane: Object.fromEntries(
      Object.entries(defaultAdapterByLane).map(([key, entry]) => [
        key,
        ensureString(
          entry,
          `planner.defaultAdapterByLane.${key}`
        ) as PlannerProfilePolicy["defaultAdapterByLane"][string]
      ])
    ),
    signalCollectors: ensureStringArray(
      record.signalCollectors,
      "planner.signalCollectors"
    ) as PlannerProfilePolicy["signalCollectors"],
    governance: {
      allowAutonomousMajorChanges: ensureBoolean(
        governance.allowAutonomousMajorChanges,
        "planner.governance.allowAutonomousMajorChanges"
      ),
      manualOnlyLanes: ensureStringArray(governance.manualOnlyLanes, "planner.governance.manualOnlyLanes"),
      maxTasksPerRun: ensureNumber(governance.maxTasksPerRun, "planner.governance.maxTasksPerRun"),
      maxMajorTasksPerDay: ensureNumber(governance.maxMajorTasksPerDay, "planner.governance.maxMajorTasksPerDay"),
      allowCrossLaneDependencies: ensureBoolean(
        governance.allowCrossLaneDependencies,
        "planner.governance.allowCrossLaneDependencies"
      )
    },
    costPolicy: {
      plannerDailyBudgetLimit:
        costPolicy.plannerDailyBudgetLimit === null || costPolicy.plannerDailyBudgetLimit === undefined
          ? null
          : ensureNumber(costPolicy.plannerDailyBudgetLimit, "planner.costPolicy.plannerDailyBudgetLimit"),
      plannerConcurrencyCap:
        costPolicy.plannerConcurrencyCap === null || costPolicy.plannerConcurrencyCap === undefined
          ? null
          : ensureNumber(costPolicy.plannerConcurrencyCap, "planner.costPolicy.plannerConcurrencyCap"),
      reduceMaxTasksWhenCodexWarm: ensureBoolean(
        costPolicy.reduceMaxTasksWhenCodexWarm,
        "planner.costPolicy.reduceMaxTasksWhenCodexWarm"
      ),
      ...(costPolicy.fallbackPlannerAdapterType !== undefined
        ? {
            fallbackPlannerAdapterType: costPolicy.fallbackPlannerAdapterType
              ? (ensureString(
                  costPolicy.fallbackPlannerAdapterType,
                  "planner.costPolicy.fallbackPlannerAdapterType"
                ) as PlannerProfilePolicy["costPolicy"]["fallbackPlannerAdapterType"])
              : null
          }
        : {}),
      ...(costPolicy.preferredPlannerModel !== undefined
        ? {
            preferredPlannerModel: costPolicy.preferredPlannerModel
              ? ensureString(costPolicy.preferredPlannerModel, "planner.costPolicy.preferredPlannerModel")
              : null
          }
        : {}),
      ...(costPolicy.plannerReasoningEffort !== undefined
        ? {
            plannerReasoningEffort: ensureString(
              costPolicy.plannerReasoningEffort,
              "planner.costPolicy.plannerReasoningEffort"
            ) as PlannerProfilePolicy["costPolicy"]["plannerReasoningEffort"]
          }
        : {})
    },
    artifactPolicy: {
      ...(artifactPolicy.plannerRunsDir
        ? {
            plannerRunsDir: ensureString(artifactPolicy.plannerRunsDir, "planner.artifactPolicy.plannerRunsDir")
          }
        : {}),
      retentionDays:
        artifactPolicy.retentionDays === null || artifactPolicy.retentionDays === undefined
          ? null
          : ensureNumber(artifactPolicy.retentionDays, "planner.artifactPolicy.retentionDays")
    }
  }
  if (Array.isArray(record.portfolioMix)) {
    policy.portfolioMix = ensureObjectArray(record.portfolioMix, "planner.portfolioMix").map(
      (entry, index): PlannerPortfolioBucketPolicy => {
        const bucket = ensureRecord(entry, `planner.portfolioMix[${index}]`)
        return {
          bucket: ensureString(
            bucket.bucket,
            `planner.portfolioMix[${index}].bucket`
          ) as PlannerPortfolioBucketPolicy["bucket"],
          weight: ensureNumber(bucket.weight, `planner.portfolioMix[${index}].weight`),
          personas: ensureStringArray(bucket.personas, `planner.portfolioMix[${index}].personas`),
          lanes: ensureStringArray(bucket.lanes, `planner.portfolioMix[${index}].lanes`),
          ...(bucket.minPerRun === undefined
            ? {}
            : { minPerRun: ensureNumber(bucket.minPerRun, `planner.portfolioMix[${index}].minPerRun`) })
        }
      }
    )
  }
  return policy
}

function mapJobDefinition(value: unknown, index: number): JobDefinition {
  const record = ensureRecord(value, `jobDefinitions[${index}]`)
  return {
    jobId: ensureString(record.jobId, `jobDefinitions[${index}].jobId`) as JobDefinition["jobId"],
    cron: ensureString(record.cron, `jobDefinitions[${index}].cron`),
    timezone: ensureString(record.timezone, `jobDefinitions[${index}].timezone`),
    entryAgent: record.entryAgent ? ensureString(record.entryAgent, `jobDefinitions[${index}].entryAgent`) : undefined
  }
}

function mapOptionalStringArray(record: Record<string, unknown>, key: string, label: string): string[] | undefined {
  return Array.isArray(record[key]) ? ensureStringArray(record[key], `${label}.${key}`) : undefined
}

function mapPersonaOverride(value: unknown, index: number): PersonaProfileOverride {
  const label = `personas[${index}]`
  const record = ensureRecord(value, label)
  const promptStyle = record.promptStyle ? ensureRecord(record.promptStyle, `${label}.promptStyle`) : null
  const promptStyleOverride: Partial<NonNullable<PersonaProfileOverride["promptStyle"]>> = {}
  if (promptStyle?.voice) {
    promptStyleOverride.voice = ensureString(promptStyle.voice, `${label}.promptStyle.voice`)
  }
  if (Array.isArray(promptStyle?.format)) {
    promptStyleOverride.format = ensureStringArray(promptStyle.format, `${label}.promptStyle.format`)
  }
  if (Array.isArray(promptStyle?.interactionRules)) {
    promptStyleOverride.interactionRules = ensureStringArray(
      promptStyle.interactionRules,
      `${label}.promptStyle.interactionRules`
    )
  }

  const override: PersonaProfileOverride = {
    id: ensureString(record.id, `${label}.id`)
  }
  if (record.extends) override.extends = ensureString(record.extends, `${label}.extends`)
  if (record.name) override.name = ensureString(record.name, `${label}.name`)
  if (record.role) override.role = ensureString(record.role, `${label}.role`)
  const responsibilities = mapOptionalStringArray(record, "responsibilities", label)
  if (responsibilities) override.responsibilities = responsibilities
  const decisionAuthority = mapOptionalStringArray(record, "decisionAuthority", label)
  if (decisionAuthority) override.decisionAuthority = decisionAuthority
  const allowedLanes = mapOptionalStringArray(record, "allowedLanes", label)
  if (allowedLanes) override.allowedLanes = allowedLanes
  const forbiddenActions = mapOptionalStringArray(record, "forbiddenActions", label)
  if (forbiddenActions) override.forbiddenActions = forbiddenActions
  if (record.defaultAdapterPreference) {
    override.defaultAdapterPreference = ensureString(
      record.defaultAdapterPreference,
      `${label}.defaultAdapterPreference`
    ) as AdapterType
  }
  if (Object.keys(promptStyleOverride).length > 0) override.promptStyle = promptStyleOverride
  const requiredReading = mapOptionalStringArray(record, "requiredReading", label)
  if (requiredReading) override.requiredReading = requiredReading
  const verificationRules = mapOptionalStringArray(record, "verificationRules", label)
  if (verificationRules) override.verificationRules = verificationRules

  return override
}

function findDuplicateIds(values: string[]): string[] {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value)
    seen.add(value)
  }
  return Array.from(duplicates).sort()
}

function validateProfileReferences(profile: ProjectProfile): void {
  const errors: string[] = []
  const laneIds = new Set(profile.laneDefinitions.map((lane) => lane.laneId))
  const categoryIds = new Set(profile.categoryDefinitions.map((category) => category.categoryId))
  const managerPersonaIds = new Set(profile.managerStateDefaults.managerPersonas.map((persona) => persona.id))
  const projectIds = new Set(profile.managerStateDefaults.projects.map((project) => project.id))
  const builtInLaneIds = new Set(builtInPersonas.flatMap((persona) => persona.allowedLanes))

  for (const duplicate of findDuplicateIds(profile.laneDefinitions.map((lane) => lane.laneId))) {
    errors.push(`laneDefinitions duplicate laneId ${duplicate}`)
  }
  for (const duplicate of findDuplicateIds(profile.categoryDefinitions.map((category) => category.categoryId))) {
    errors.push(`categoryDefinitions duplicate categoryId ${duplicate}`)
  }
  for (const duplicate of findDuplicateIds(profile.managerStateDefaults.managerPersonas.map((persona) => persona.id))) {
    errors.push(`managerStateDefaults.managerPersonas duplicate id ${duplicate}`)
  }
  for (const duplicate of findDuplicateIds(profile.managerStateDefaults.projects.map((project) => project.id))) {
    errors.push(`managerStateDefaults.projects duplicate id ${duplicate}`)
  }

  for (const category of profile.categoryDefinitions) {
    for (const laneId of category.laneIds) {
      if (!laneIds.has(laneId)) {
        errors.push(`Category ${category.categoryId} references unknown lane ${laneId}`)
      }
    }
  }

  for (const persona of profile.managerStateDefaults.managerPersonas) {
    for (const laneId of persona.ownedLaneIds) {
      if (!laneIds.has(laneId)) {
        errors.push(`Manager persona ${persona.id} references unknown owned lane ${laneId}`)
      }
    }
  }

  for (const project of profile.managerStateDefaults.projects) {
    if (!laneIds.has(project.laneId)) {
      errors.push(`Manager project ${project.id} references unknown lane ${project.laneId}`)
    }
    if (!categoryIds.has(project.categoryId)) {
      errors.push(`Manager project ${project.id} references unknown category ${project.categoryId}`)
    }
    if (!managerPersonaIds.has(project.managerPersonaId)) {
      errors.push(`Manager project ${project.id} references unknown manager persona ${project.managerPersonaId}`)
    }
  }

  for (const goal of profile.managerStateDefaults.goals) {
    for (const projectId of goal.projectIds) {
      if (!projectIds.has(projectId)) {
        errors.push(`Manager goal ${goal.id} references unknown project ${projectId}`)
      }
    }
  }

  for (const laneId of profile.planner.allowedLanes) {
    if (!laneIds.has(laneId)) {
      errors.push(`planner.allowedLanes references unknown lane ${laneId}`)
    }
  }

  for (const [laneId, personaId] of Object.entries(profile.planner.defaultPersonaByLane)) {
    if (!laneIds.has(laneId)) {
      errors.push(`planner.defaultPersonaByLane references unknown lane ${laneId}`)
    }
    if (!managerPersonaIds.has(personaId)) {
      errors.push(`planner.defaultPersonaByLane.${laneId} references unknown manager persona ${personaId}`)
      continue
    }
    const managerPersona = profile.managerStateDefaults.managerPersonas.find((persona) => persona.id === personaId)
    if (managerPersona && !managerPersona.ownedLaneIds.includes(laneId)) {
      errors.push(
        `planner.defaultPersonaByLane.${laneId} uses manager persona ${personaId} that does not own lane ${laneId}`
      )
    }
  }

  for (const laneId of Object.keys(profile.planner.defaultAdapterByLane)) {
    if (!laneIds.has(laneId)) {
      errors.push(`planner.defaultAdapterByLane references unknown lane ${laneId}`)
    }
  }

  for (const laneId of profile.planner.governance.manualOnlyLanes) {
    if (!laneIds.has(laneId)) {
      errors.push(`planner.governance.manualOnlyLanes references unknown lane ${laneId}`)
    }
  }

  for (const [index, bucket] of (profile.planner.portfolioMix ?? []).entries()) {
    for (const laneId of bucket.lanes) {
      if (!laneIds.has(laneId)) {
        errors.push(`planner.portfolioMix[${index}].lanes references unknown lane ${laneId}`)
      }
    }
    for (const personaId of bucket.personas) {
      if (!managerPersonaIds.has(personaId)) {
        errors.push(`planner.portfolioMix[${index}].personas references unknown manager persona ${personaId}`)
      }
    }
  }

  for (const [index, persona] of (profile.personas ?? []).entries()) {
    for (const laneId of persona.allowedLanes ?? []) {
      if (!laneIds.has(laneId) && !builtInLaneIds.has(laneId)) {
        errors.push(`personas[${index}].allowedLanes references unknown lane ${laneId}`)
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.join("; "))
  }
}

export function validateProjectProfile(value: unknown): ProjectProfile {
  const record = ensureRecord(value, "profile")
  const profile: ProjectProfile = {
    executionPolicy: validateExecutionPolicy(record.executionPolicy),
    profileId: ensureString(record.profileId, "profileId"),
    version: ensureString(record.version, "version"),
    displayName: ensureString(record.displayName, "displayName"),
    description: record.description ? ensureString(record.description, "description") : undefined,
    adoptionPolicy: mapAdoptionPolicy(record.adoptionPolicy),
    framework: mapFramework(record.framework),
    laneDefinitions: [],
    categoryDefinitions: [],
    requiredReadingRules: [],
    verificationRules: [],
    routingRules: [],
    managerStateDefaults: {
      version: 1,
      managerPersonas: [],
      goals: [],
      projects: []
    },
    promotionPolicy: mapPromotionPolicy(record.promotionPolicy),
    notificationPolicy: mapNotificationPolicy(record.notificationPolicy),
    artifactPolicy: mapArtifactPolicy(record.artifactPolicy),
    planner: mapPlannerPolicy(record.planner),
    responsePolicy: record.responsePolicy === undefined ? undefined : validateResponsePolicy(record.responsePolicy),
    personas: undefined,
    repoDetectionSignals: [],
    jobDefinitions: []
  }

  if (record.nativeAutonomy !== undefined) profile.nativeAutonomy = validateNativeAutonomyPolicy(record.nativeAutonomy)

  if (record.stateBackend !== undefined) {
    const backend = ensureRecord(record.stateBackend, "stateBackend")
    profile.stateBackend = {
      mode: backend.mode !== undefined ? (ensureString(backend.mode, "stateBackend.mode") as any) : undefined,
      rootDir: backend.rootDir !== undefined ? ensureString(backend.rootDir, "stateBackend.rootDir") : undefined,
      runtimeDir:
        backend.runtimeDir !== undefined ? ensureString(backend.runtimeDir, "stateBackend.runtimeDir") : undefined,
      bootstrapDir:
        backend.bootstrapDir !== undefined
          ? ensureString(backend.bootstrapDir, "stateBackend.bootstrapDir")
          : undefined,
      branch: backend.branch !== undefined ? ensureString(backend.branch, "stateBackend.branch") : undefined,
      remote: backend.remote !== undefined ? ensureString(backend.remote, "stateBackend.remote") : undefined,
      syncHooks:
        backend.syncHooks !== undefined ? ensureBoolean(backend.syncHooks, "stateBackend.syncHooks") : undefined
    }
  }

  profile.requiredReadingRules = ensureObjectArray(record.requiredReadingRules, "requiredReadingRules").map(
    mapRequiredReadingRule
  )
  profile.verificationRules = ensureObjectArray(record.verificationRules, "verificationRules").map(mapVerificationRule)
  profile.laneDefinitions = ensureObjectArray(record.laneDefinitions, "laneDefinitions").map(mapLaneDefinition)
  profile.categoryDefinitions = ensureObjectArray(record.categoryDefinitions, "categoryDefinitions").map(
    mapCategoryDefinition
  )
  profile.routingRules = ensureObjectArray(record.routingRules, "routingRules").map(mapRoutingRule)
  profile.repoDetectionSignals = ensureObjectArray(record.repoDetectionSignals, "repoDetectionSignals").map(
    mapRepoDetectionSignal
  )

  const managerState = ensureRecord(record.managerStateDefaults, "managerStateDefaults")
  profile.managerStateDefaults = {
    version: ensureNumber(managerState.version, "managerStateDefaults.version"),
    managerPersonas: ensureObjectArray(managerState.managerPersonas, "managerStateDefaults.managerPersonas").map(
      mapManagerPersona
    ),
    goals: ensureObjectArray(managerState.goals, "managerStateDefaults.goals").map(mapManagerGoal),
    projects: ensureObjectArray(managerState.projects, "managerStateDefaults.projects").map(mapManagerProject),
    promptPatterns: managerState.promptPatterns
      ? (ensureRecord(managerState.promptPatterns, "managerStateDefaults.promptPatterns") as Record<string, string>)
      : undefined
  }
  profile.jobDefinitions = ensureObjectArray(record.jobDefinitions, "jobDefinitions").map(mapJobDefinition)
  profile.personas = Array.isArray(record.personas)
    ? ensureObjectArray(record.personas, "personas").map(mapPersonaOverride)
    : undefined
  profile.extraInstructions = Array.isArray(record.extraInstructions)
    ? ensureStringArray(record.extraInstructions, "extraInstructions")
    : undefined

  const readingRuleIds = new Set(profile.requiredReadingRules.map((rule) => rule.ruleId))
  const verificationRuleIds = new Set(profile.verificationRules.map((rule) => rule.ruleId))
  for (const lane of profile.laneDefinitions) {
    if (!readingRuleIds.has(lane.requiredReadingRuleId)) {
      throw new Error(`Lane ${lane.laneId} references unknown required reading rule ${lane.requiredReadingRuleId}`)
    }
    if (!verificationRuleIds.has(lane.verificationRuleId)) {
      throw new Error(`Lane ${lane.laneId} references unknown verification rule ${lane.verificationRuleId}`)
    }
  }

  for (const persona of mergePersonaDefinitions(undefined, profile.personas ?? [])) {
    assertPersonaDefinition(persona, `personas.${persona.id}`)
  }
  validateProfileReferences(profile)

  return profile
}
