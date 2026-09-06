import {
  type AdapterType,
  type PlannerCandidateTask,
  type PlannerOutputEnvelope,
  validateDependencyGraph
} from "@openclaw/domain"
import type { ProjectProfile } from "@openclaw/project-profiles"

const VALID_ADAPTERS = new Set<AdapterType>(["codex_local", "gemini_local", "azure_foundry"])
const VALID_PORTFOLIO_BUCKETS = new Set([
  "legal_domain",
  "frontend_product_ux",
  "backend_api",
  "dapr_async_runtime",
  "architecture_maintainability",
  "validation_repair",
  "release_promotion"
])

export type PlannerFeaturePolicyRejection = {
  index: number
  title: string
  reason: string
}

export type PlannerFeaturePolicyResult = {
  accepted: PlannerCandidateTask[]
  rejected: PlannerFeaturePolicyRejection[]
}

const TEST_ONLY_TITLE_PATTERN =
  /\b(?:unit tests?|regression tests?|contract witness|witness tests?|test witness|snapshot tests?|fixture-only|readme-only)\b/i
const TEST_ONLY_PREFIX_PATTERN = /^(?:add|cover|write|create)\s+.*\btests?\b/i
const COSMETIC_PATCHLET_PATTERN = /\b(?:helper text|copy tweak|label text|labels?|tooltip|placeholder)\b/i
const REPO_EVIDENCE_PATTERN =
  /(?:repo-search|laneInventory|laneHotspots|todoFixmeHits|stale_task|promotionBlockers|directives:|queueSummary|changed:|apps\/|packages\/|contracts\/|specs\/|AGENTS\.md|README\.md)/i
const FEATURE_CAPABILITY_PATTERN =
  /\b(?:accepts?|adds?|calculates?|derives?|displays?|emits?|exposes?|exports?|filters?|hardens?|keeps?|persists?|prevents?|recovers?|renders?|reports?|returns?|routes?|shows?|summari[sz]es?|supports?|surfaces?|validates?|workflows?|operators?|reviewers?|users?)\b/i

function plannerLaneIds(profile: ProjectProfile): string[] {
  return Array.from(new Set([...profile.planner.allowedLanes, ...profile.laneDefinitions.map((lane) => lane.laneId)]))
}

export function parsePlannerOutput(raw: string): PlannerOutputEnvelope {
  const trimmed = raw.trim()
  const fencedJson = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]?.trim()
  const candidate = fencedJson ?? extractJsonObject(trimmed)
  let parsed: PlannerOutputEnvelope
  try {
    parsed = JSON.parse(candidate) as PlannerOutputEnvelope
  } catch {
    throw new Error("Planner output must be a JSON object with a candidates array.")
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.candidates)) {
    throw new Error("Planner output must be a JSON object with a candidates array.")
  }
  return {
    version: 1,
    ...(typeof parsed.summary === "string" ? { summary: parsed.summary } : {}),
    candidates: parsed.candidates
  }
}

function extractJsonObject(raw: string): string {
  if (raw.startsWith("{") && raw.endsWith("}")) return raw

  const start = raw.indexOf("{")
  const end = raw.lastIndexOf("}")
  if (start === -1 || end === -1 || end <= start) return raw
  return raw.slice(start, end + 1)
}

function candidatePolicyText(candidate: PlannerCandidateTask): string {
  return [
    candidate.title,
    candidate.description,
    candidate.userOutcome ?? "",
    ...(candidate.acceptanceCriteria ?? []),
    ...(candidate.repoNotes ?? [])
  ].join("\n")
}

function hasRepoEvidence(candidate: PlannerCandidateTask): boolean {
  return [
    ...(candidate.requiredReading ?? []),
    ...(candidate.sourceSignals ?? []),
    ...(candidate.repoNotes ?? [])
  ].some((value) => REPO_EVIDENCE_PATTERN.test(value))
}

export function plannerFeaturePolicyRejection(candidate: PlannerCandidateTask): string | null {
  if (candidate.kind !== "implement") return null
  const title = candidate.title.trim()
  const policyText = candidatePolicyText(candidate)
  if (TEST_ONLY_TITLE_PATTERN.test(title) || TEST_ONLY_PREFIX_PATTERN.test(title)) {
    return "candidate looks like test-only or witness-only work"
  }
  if (COSMETIC_PATCHLET_PATTERN.test(title)) {
    return "candidate looks like a cosmetic patchlet instead of a vertical feature slice"
  }
  if (!hasRepoEvidence(candidate)) {
    return "candidate does not cite repo-search evidence"
  }
  if (!FEATURE_CAPABILITY_PATTERN.test(policyText)) {
    return "candidate does not describe a shippable user or operator capability"
  }
  return null
}

export function filterPlannerCandidatesForFeaturePolicy(
  candidates: PlannerCandidateTask[]
): PlannerFeaturePolicyResult {
  const acceptedByIndex = new Map<number, PlannerCandidateTask>()
  const rejected: PlannerFeaturePolicyRejection[] = []
  candidates.forEach((candidate, index) => {
    const reason = plannerFeaturePolicyRejection(candidate)
    if (reason) {
      rejected.push({ index, title: candidate.title, reason })
    } else {
      acceptedByIndex.set(index, candidate)
    }
  })

  let changed = true
  while (changed) {
    changed = false
    const acceptedKeys = new Set(Array.from(acceptedByIndex.values()).map((candidate) => candidate.dedupeKey))
    for (const [index, candidate] of acceptedByIndex) {
      const rejectedDependency = candidate.dependencies.find((dependency) => !acceptedKeys.has(dependency))
      if (!rejectedDependency) continue
      acceptedByIndex.delete(index)
      rejected.push({
        index,
        title: candidate.title,
        reason: `candidate depends on rejected prerequisite ${rejectedDependency}`
      })
      changed = true
    }
  }

  return {
    accepted: Array.from(acceptedByIndex.values()),
    rejected: rejected.sort((left, right) => left.index - right.index)
  }
}

export function validatePlannerCandidates(input: {
  profile: ProjectProfile
  candidates: PlannerCandidateTask[]
}): PlannerCandidateTask[] {
  const laneIds = new Set(plannerLaneIds(input.profile))
  const manualOnlyLanes = new Set(input.profile.planner.governance.manualOnlyLanes)
  const personaIds = new Set(input.profile.managerStateDefaults.managerPersonas.map((persona) => persona.id))
  const bucketByPersona = new Map<string, PlannerCandidateTask["portfolioBucket"]>()
  for (const bucket of input.profile.planner.portfolioMix ?? []) {
    for (const persona of bucket.personas) {
      bucketByPersona.set(persona, bucket.bucket)
    }
  }
  const validated = input.candidates.map((candidate, index) => {
    if (!candidate.title?.trim()) throw new Error(`Planner candidate ${index} is missing title.`)
    if (!candidate.description?.trim()) throw new Error(`Planner candidate ${index} is missing description.`)
    if (!laneIds.has(candidate.lane))
      throw new Error(`Planner candidate ${index} uses unsupported lane ${candidate.lane}.`)
    if (!candidate.dedupeKey?.trim()) throw new Error(`Planner candidate ${index} is missing dedupeKey.`)
    if (!Array.isArray(candidate.dependencies) || candidate.dependencies.some((entry) => typeof entry !== "string")) {
      throw new Error(`Planner candidate ${index} has invalid dependencies.`)
    }
    const dedupeKey = candidate.dedupeKey.trim()
    const dependencies = Array.from(
      new Set(candidate.dependencies.map((dependency) => dependency.trim()).filter(Boolean))
    )
    const defaultPersonaId = input.profile.planner.defaultPersonaByLane[candidate.lane] ?? null
    const personaId = candidate.personaId?.trim() || defaultPersonaId
    if (!personaId) throw new Error(`Planner candidate ${index} is missing personaId.`)
    if (!personaIds.has(personaId)) {
      throw new Error(`Planner candidate ${index} uses unknown personaId ${personaId}.`)
    }
    if (candidate.preferredAdapterType && !VALID_ADAPTERS.has(candidate.preferredAdapterType)) {
      throw new Error(`Planner candidate ${index} requested unknown adapter ${candidate.preferredAdapterType}.`)
    }
    const personaBucket = bucketByPersona.get(personaId)
    const candidateBucket = candidate.portfolioBucket
    const portfolioBucket = personaBucket ?? candidateBucket ?? "backend_api"
    if (!VALID_PORTFOLIO_BUCKETS.has(portfolioBucket)) {
      throw new Error(`Planner candidate ${index} uses unknown portfolioBucket ${portfolioBucket}.`)
    }
    if (
      candidate.kind !== "implement" &&
      candidate.kind !== "plan" &&
      candidate.kind !== "review" &&
      candidate.kind !== "follow_up"
    ) {
      throw new Error(`Planner candidate ${index} has unsupported kind ${candidate.kind}.`)
    }
    if (
      (candidate.kind === "implement" || candidate.kind === "review") &&
      candidate.verificationChecklist.length === 0
    ) {
      throw new Error(`Planner candidate ${index} must include verificationChecklist.`)
    }
    return {
      ...candidate,
      dedupeKey,
      dependencies,
      personaId,
      portfolioBucket,
      userOutcome: candidate.userOutcome?.trim() || candidate.description,
      acceptanceCriteria:
        candidate.acceptanceCriteria && candidate.acceptanceCriteria.length > 0
          ? candidate.acceptanceCriteria
          : candidate.verificationChecklist,
      taskSourceIntent: candidate.taskSourceIntent ?? "persona_ideation",
      governanceClass: manualOnlyLanes.has(candidate.lane) ? "manual_only" : candidate.governanceClass,
      createMode: candidate.createMode ?? "queue_now",
      riskLevel: candidate.riskLevel ?? "medium",
      preferredAdapterType:
        candidate.preferredAdapterType ?? input.profile.planner.defaultAdapterByLane[candidate.lane] ?? null
    }
  })

  validateDependencyGraph(
    validated.map((candidate) => ({ id: candidate.dedupeKey, dependsOn: candidate.dependencies }))
  )

  if (!input.profile.planner.governance.allowCrossLaneDependencies) {
    const laneByDedupeKey = new Map(validated.map((candidate) => [candidate.dedupeKey, candidate.lane]))
    for (const candidate of validated) {
      for (const dependency of candidate.dependencies) {
        const dependencyLane = laneByDedupeKey.get(dependency)
        if (dependencyLane && dependencyLane !== candidate.lane) {
          throw new Error(
            `Planner candidate ${candidate.dedupeKey} depends on ${dependency} across lanes ` +
              `(${candidate.lane} -> ${dependencyLane}), but cross-lane dependencies are disabled.`
          )
        }
      }
    }
  }

  return validated
}
