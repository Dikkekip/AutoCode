import type { DispatcherStore } from "@openclaw/db"
import type { PlannerCandidateTask, PlannerDecision } from "@openclaw/domain"
import { plannerCandidateToTaskPackage, topologicalDependencyOrder } from "@openclaw/domain"
import type { ProjectProfile } from "@openclaw/project-profiles"

function cleanReadingPath(path: string): string | null {
  const trimmed = path.trim()
  if (!trimmed || trimmed.startsWith("#") || /^This is\b/i.test(trimmed)) return null
  return trimmed
}

function executableReadingPaths(profile: ProjectProfile, laneId: string): string[] {
  const lane = profile.laneDefinitions.find((entry) => entry.laneId === laneId)
  if (!lane) return []
  const readingRule = profile.requiredReadingRules.find((entry) => entry.ruleId === lane.requiredReadingRuleId)
  return Array.from(
    new Set(
      [...(readingRule?.paths ?? []), ...lane.allowedPaths]
        .map(cleanReadingPath)
        .filter((path): path is string => Boolean(path))
    )
  )
}

export function materializePlannerTasks(input: {
  store: DispatcherStore
  projectId: string
  profile: ProjectProfile
  candidates: PlannerCandidateTask[]
  decisions: PlannerDecision[]
  personaByName: (name: string | null) => string | null
}): string[] {
  const createdTaskIds: string[] = []
  const order = topologicalDependencyOrder(
    input.candidates.map((candidate) => ({ id: candidate.dedupeKey, dependsOn: candidate.dependencies }))
  )
  const candidateByDedupeKey = new Map(input.candidates.map((candidate) => [candidate.dedupeKey, candidate]))
  const indexByDedupeKey = new Map(input.candidates.map((candidate, index) => [candidate.dedupeKey, index]))
  const decisionByIndex = new Map(input.decisions.map((decision) => [decision.candidateIndex, decision]))
  const taskIdByDedupeKey = new Map<string, string>()

  for (const decision of input.decisions) {
    if (decision.action === "skip_duplicate" && decision.existingTaskId) {
      taskIdByDedupeKey.set(decision.dedupeKey, decision.existingTaskId)
    }
  }

  for (const candidate of input.candidates) {
    const candidateIndex = indexByDedupeKey.get(candidate.dedupeKey)!
    const decision = decisionByIndex.get(candidateIndex)
    if (!decision || (decision.action !== "create" && decision.action !== "supersede_previous")) continue
    if (candidate.createMode === "artifacts_only" || candidate.governanceClass === "manual_only") continue

    for (const dependency of candidate.dependencies) {
      if (taskIdByDedupeKey.has(dependency)) continue
      const dependencyCandidate = candidateByDedupeKey.get(dependency)!
      const dependencyIndex = indexByDedupeKey.get(dependency)!
      const dependencyDecision = decisionByIndex.get(dependencyIndex)
      const willPersist =
        dependencyDecision &&
        (dependencyDecision.action === "create" || dependencyDecision.action === "supersede_previous") &&
        dependencyCandidate.createMode !== "artifacts_only" &&
        dependencyCandidate.governanceClass !== "manual_only"
      if (!willPersist) {
        throw new Error(
          `Planner candidate ${candidate.dedupeKey} depends on ${dependency}, which has no persistable task decision.`
        )
      }
    }
  }

  for (const dedupeKey of order) {
    const candidate = candidateByDedupeKey.get(dedupeKey)!
    const candidateIndex = indexByDedupeKey.get(dedupeKey)!
    const decision = decisionByIndex.get(candidateIndex)
    if (!decision) throw new Error(`Planner candidate ${dedupeKey} has no materialization decision.`)
    if (decision.action !== "create" && decision.action !== "supersede_previous") continue
    if (candidate.createMode === "artifacts_only" || candidate.governanceClass === "manual_only") continue
    const dependencyTaskIds = candidate.dependencies.map((dependency) => {
      const taskId = taskIdByDedupeKey.get(dependency)
      if (!taskId) {
        throw new Error(
          `Planner candidate ${candidate.dedupeKey} depends on ${dependency}, which was not persisted or matched to an existing task.`
        )
      }
      return taskId
    })
    const augmentedCandidate: PlannerCandidateTask = {
      ...candidate,
      requiredReading: Array.from(
        new Set([
          ...candidate.requiredReading.map(cleanReadingPath).filter((path): path is string => Boolean(path)),
          ...executableReadingPaths(input.profile, candidate.lane)
        ])
      )
    }

    const labels = Array.from(
      new Set(
        [
          "planner-generated",
          `planner-dedupe:${augmentedCandidate.dedupeKey}`,
          `planner-risk:${augmentedCandidate.riskLevel}`,
          `planner-governance:${augmentedCandidate.governanceClass}`,
          augmentedCandidate.personaId ? `persona:${augmentedCandidate.personaId}` : null,
          augmentedCandidate.portfolioBucket ? `bucket:${augmentedCandidate.portfolioBucket}` : null,
          augmentedCandidate.taskSourceIntent ? `source:${augmentedCandidate.taskSourceIntent}` : null,
          ...augmentedCandidate.tags
        ].filter((value): value is string => Boolean(value))
      )
    )
    const created = input.store.createTask({
      projectRef: input.projectId,
      title: augmentedCandidate.title,
      description: augmentedCandidate.description,
      labels,
      changedFiles: augmentedCandidate.targetPaths ?? [],
      allowedPaths: augmentedCandidate.targetPaths ?? [],
      taskPackage: plannerCandidateToTaskPackage({
        candidate: augmentedCandidate,
        profileId: input.profile.profileId,
        taskId: `planner:${augmentedCandidate.dedupeKey}`
      }),
      kind: augmentedCandidate.kind,
      dependsOnTaskIds: dependencyTaskIds,
      personaRef: input.personaByName(augmentedCandidate.personaId),
      priority: augmentedCandidate.priority,
      source: "automation",
      requestedAdapterType: augmentedCandidate.preferredAdapterType,
      laneId: augmentedCandidate.lane,
      requiredReading: augmentedCandidate.requiredReading,
      verificationCommands: augmentedCandidate.verificationChecklist,
      reviewRequired:
        augmentedCandidate.kind === "implement" ||
        augmentedCandidate.kind === "repair" ||
        augmentedCandidate.governanceClass === "sensitive",
      approvalRequired: augmentedCandidate.governanceClass === "major_change",
      maxRetries: 1
    })
    createdTaskIds.push(created.id)
    taskIdByDedupeKey.set(augmentedCandidate.dedupeKey, created.id)
    decision.createdTaskId = created.id
  }
  return createdTaskIds
}
