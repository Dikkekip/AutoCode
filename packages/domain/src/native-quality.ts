import { createHash } from "node:crypto"
import { isAbsolute } from "node:path"

export interface NativeQualityPolicy {
  skillPath: string
  sessionSeconds: number
  admissionBudget?: NativeSelectionBudget
  explorationSlots?: number
  highRiskPaths: string[]
}
export interface NativeProposalQuality {
  hypothesis: NativeBenefitHypothesis
  problem: string
  userWorkflow: string
  expectedBenefit: string
  approach: string
  nonGoals: string[]
  risk: "routine" | "high"
  riskReasons: string[]
  verification: Array<{ criterion: string; method: string }>
  revision: string
  skillHash: string
  skillContractVersion?: 1
  skillPolicyDigest?: string
  sessionKey: string
  evidenceHashes: Record<string, string>
}
/** Persisted deterministic evidence; proposal text can only raise this classification. */
export interface NativeRiskAssessment {
  risk: "routine" | "high"
  reasons: string[]
  changesDigest: string
  baseSha: string
  headSha: string
}
export interface NativeAssessment {
  criteria: Array<{ criterion: string; satisfied: boolean; evidence: string }>
  findings: Array<{ blocking: boolean; description: string }>
}
export const nativeHighRiskPaths = [
  "**/auth/**",
  "**/permissions/**",
  "**/migrations/**",
  "**/contracts/**",
  "**/openapi*",
  "**/scripts/**",
  "**/*.sh",
  "**/package.json",
  "**/package-lock.json",
  "**/pnpm-lock.yaml",
  "**/yarn.lock",
  "**/Cargo.lock",
  "**/poetry.lock",
  "**/uv.lock",
  "**/go.sum",
  "**/Gemfile*",
  "**/composer.*",
  ".gitlab-ci.yml",
  "**/Jenkinsfile",
  "**/requirements*.txt",
  "**/pyproject.toml",
  "**/Cargo.toml",
  "**/go.mod",
  "**/*.proto",
  "**/*.graphql",
  "**/*.d.ts",
  "scripts/deploy*",
  "scripts/k3s/**",
  ".github/workflows/**"
]
export function qualityText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`)
  return value.trim()
}
export function validateNativeQualityPolicy(value: any): NativeQualityPolicy {
  const skillPath = qualityText(value?.skillPath, "quality.skillPath")
  if (!isAbsolute(skillPath)) throw new Error("quality.skillPath must be absolute")
  const sessionSeconds = value.sessionSeconds ?? 300
  if (!Number.isInteger(sessionSeconds) || sessionSeconds < 30 || sessionSeconds > 600)
    throw new Error("Investigation budget must be between 30 and 600 seconds")
  const highRiskPaths = value.highRiskPaths ?? nativeHighRiskPaths
  if (!Array.isArray(highRiskPaths) || highRiskPaths.some((p: unknown) => typeof p !== "string" || !p.trim()))
    throw new Error("Invalid high-risk paths")
  const admissionBudget = value.admissionBudget ?? { effortHours: 24, costCents: 10000 }
  if (
    ![admissionBudget.effortHours, admissionBudget.costCents].every(
      (n) => typeof n === "number" && Number.isFinite(n) && n >= 0
    )
  )
    throw new Error("Invalid admission budget")
  const explorationSlots = value.explorationSlots ?? 0
  if (!Number.isSafeInteger(explorationSlots) || explorationSlots < 0 || explorationSlots > 100)
    throw new Error("Invalid exploration slots")
  return {
    explorationSlots,
    skillPath,
    sessionSeconds,
    admissionBudget,
    highRiskPaths: [...new Set([...nativeHighRiskPaths, ...highRiskPaths])]
  }
}
export function nativeProblemKey(problem: string, workflow: string): string {
  const words = (text: string) =>
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim()
  return createHash("sha256")
    .update(`${words(problem)}\n${words(workflow)}`)
    .digest("hex")
}
export function validateNativeAssessment(raw: any, acceptance: string[], approved: boolean): NativeAssessment {
  if (!raw || !Array.isArray(raw.criteria) || !Array.isArray(raw.findings))
    throw new Error("Structured acceptance evidence and findings required")
  const criteria = raw.criteria.map((c: any) => {
    if (typeof c.satisfied !== "boolean") throw new Error("Criterion requires a boolean result")
    return {
      criterion: qualityText(c.criterion, "criterion"),
      satisfied: c.satisfied,
      evidence: qualityText(c.evidence, "evidence")
    }
  })
  if (
    criteria.length !== acceptance.length ||
    new Set(criteria.map((c: any) => c.criterion)).size !== acceptance.length ||
    acceptance.some((a) => !criteria.some((c: any) => c.criterion === a))
  )
    throw new Error("Review must address every acceptance criterion exactly once")
  const findings = raw.findings.map((f: any) => {
    if (typeof f.blocking !== "boolean") throw new Error("Finding requires blocking classification")
    return { blocking: f.blocking, description: qualityText(f.description, "finding") }
  })
  if (approved && (criteria.some((c: any) => !c.satisfied) || findings.some((f: any) => f.blocking)))
    throw new Error("Approval requires satisfied acceptance and no blocking findings")
  return { criteria, findings }
}

/** Benefits are compared as fractions of their own baseline, never as unlike raw units. */
export interface NativeBenefitHypothesis {
  metric: string
  unit: string
  baseline: number
  target: number
  direction: "increase" | "decrease"
  baselineEvidence: string[]
  evidenceStrength: "observed" | "reproduced" | "measured"
  confidence: number
  uncertainty: string
  effortHours: number
  costCents: number
  measurementPlan: string
  alternatives: Array<{ kind: "no_op" | "change"; description: string; rationale: string }>
}
export interface NativeSelectionBudget {
  effortHours: number
  costCents: number
}
export interface NativeSelectionCandidate {
  id: string
  goal: string
  weight: number
  risk: "routine" | "high"
  hypothesis: NativeBenefitHypothesis
}
export interface NativeSelectionDecision {
  id: string
  outcome: "selected" | "rejected" | "deferred"
  rationale: string
  uncertainty: string
  score: number
  rank: number
  requiredConfidence: number
  exploration?: boolean
}
export function validateNativeBenefitHypothesis(raw: any): NativeBenefitHypothesis {
  if (!raw) throw new Error("Benefit hypothesis required")
  const result = { ...raw } as NativeBenefitHypothesis
  for (const key of ["metric", "unit", "uncertainty", "measurementPlan"] as const)
    result[key] = qualityText(raw[key], key)
  for (const key of ["baseline", "target", "confidence", "effortHours", "costCents"] as const)
    if (typeof raw[key] !== "number" || !Number.isFinite(raw[key])) throw new Error(`Invalid ${key}`)
  if (raw.confidence < 0 || raw.confidence > 1 || raw.effortHours <= 0 || raw.costCents < 0)
    throw new Error("Invalid confidence or estimated effort/cost")
  if (!["increase", "decrease"].includes(raw.direction)) throw new Error("Benefit direction required")
  if (!["observed", "reproduced", "measured"].includes(raw.evidenceStrength))
    throw new Error("Evidence strength required")
  if (!Array.isArray(raw.baselineEvidence) || !raw.baselineEvidence.length)
    throw new Error("Baseline evidence required")
  result.baselineEvidence = raw.baselineEvidence.map((e: unknown) => qualityText(e, "baseline evidence"))
  if (
    !Array.isArray(raw.alternatives) ||
    !raw.alternatives.some((a: any) => a.kind === "no_op") ||
    !raw.alternatives.some((a: any) => a.kind === "change")
  )
    throw new Error("Compare change and no-op alternatives")
  result.alternatives = raw.alternatives.map((a: any) => {
    if (!["no_op", "change"].includes(a.kind)) throw new Error("Invalid alternative kind")
    return {
      kind: a.kind,
      description: qualityText(a.description, "alternative"),
      rationale: qualityText(a.rationale, "alternative rationale")
    }
  })
  return result
}
export function selectNativeImprovements(
  candidates: NativeSelectionCandidate[],
  budget: NativeSelectionBudget,
  slots: number,
  exploration: { slots: number; goalAdmissions: Record<string, number> } = { slots: 0, goalAdmissions: {} }
): NativeSelectionDecision[] {
  if (![budget.effortHours, budget.costCents, slots].every((n) => Number.isFinite(n) && n >= 0))
    throw new Error("Invalid remaining budget")
  if (
    !Number.isSafeInteger(exploration.slots) ||
    exploration.slots < 0 ||
    Object.values(exploration.goalAdmissions).some((n) => !Number.isSafeInteger(n) || n < 0)
  )
    throw new Error("Invalid exploration capacity")
  const ranked = candidates
    .map((candidate) => {
      const h = validateNativeBenefitHypothesis(candidate.hypothesis)
      const delta = (h.target - h.baseline) * (h.direction === "increase" ? 1 : -1)
      const benefit = Math.min(1, delta / Math.max(Math.abs(h.baseline), Math.abs(h.target), 1))
      const expensive = h.effortHours > 8 || h.costCents > 5000
      const requiredConfidence = candidate.risk === "high" ? 0.9 : expensive ? 0.8 : 0.6
      const strength = { observed: 0, reproduced: 1, measured: 2 }[h.evidenceStrength]
      const requiredStrength = candidate.risk === "high" ? 2 : expensive ? 1 : 0
      const score =
        (benefit * h.confidence * candidate.weight) /
        (h.effortHours + h.costCents / 1000) /
        (candidate.risk === "high" ? 2 : 1)
      const reason =
        delta <= 0
          ? "Baseline already satisfies the target; retain no-op"
          : benefit * h.confidence < 0.05
            ? "Expected measurable benefit is too small; retain no-op"
            : h.confidence < requiredConfidence || strength < requiredStrength
              ? "Cost/risk requires stronger evidence and confidence"
              : ""
      return { candidate, h, score, requiredConfidence, reason }
    })
    .sort((a, b) => b.score - a.score || a.candidate.id.localeCompare(b.candidate.id))
  // Reviewed exploration allocates capacity across operator goals, never weaker evidence.
  const explored = new Set<string>()
  const represented = new Set<string>()
  let explorationHours = budget.effortHours,
    explorationCents = budget.costCents
  for (const item of [...ranked].sort(
    (a, b) =>
      (exploration.goalAdmissions[a.candidate.goal] ?? 0) - (exploration.goalAdmissions[b.candidate.goal] ?? 0) ||
      b.candidate.weight - a.candidate.weight ||
      b.score - a.score ||
      a.candidate.id.localeCompare(b.candidate.id)
  )) {
    if (explored.size >= Math.min(slots, exploration.slots)) break
    if (
      item.reason ||
      represented.has(item.candidate.goal) ||
      item.h.effortHours > explorationHours ||
      item.h.costCents > explorationCents
    )
      continue
    explored.add(item.candidate.id)
    represented.add(item.candidate.goal)
    explorationHours -= item.h.effortHours
    explorationCents -= item.h.costCents
  }
  ranked.sort((a, b) => Number(explored.has(b.candidate.id)) - Number(explored.has(a.candidate.id)))
  let { effortHours, costCents } = budget
  return ranked.map(({ candidate, h, score, requiredConfidence, reason }, index) => {
    let outcome: NativeSelectionDecision["outcome"] = reason ? "rejected" : "selected"
    let rationale = reason
    if (!reason && (slots < 1 || h.effortHours > effortHours || h.costCents > costCents)) {
      outcome = "deferred"
      rationale = "Higher-ranked proposals or remaining budget exhaust capacity"
    }
    if (outcome === "selected") {
      slots--
      effortHours -= h.effortHours
      costCents -= h.costCents
      rationale = `Goal ${candidate.goal}, priority ${candidate.weight}: confidence-adjusted benefit per effort/cost; remaining ${effortHours} hours, ${costCents} cents`
    }
    return {
      id: candidate.id,
      ...(explored.has(candidate.id) ? { exploration: true } : {}),
      outcome,
      rationale: explored.has(candidate.id)
        ? `Reviewed exploration capacity across operator goals. ${rationale}`
        : rationale,
      uncertainty: h.uncertainty,
      score,
      rank: index + 1,
      requiredConfidence
    }
  })
}

export function assessNativeBenefit(hypothesis: NativeBenefitHypothesis, observation: any) {
  const h = validateNativeBenefitHypothesis(hypothesis)
  if (
    !observation ||
    observation.metric !== h.metric ||
    observation.unit !== h.unit ||
    typeof observation.value !== "number" ||
    !Number.isFinite(observation.value)
  )
    return { hypothesis: h, status: "unmeasured" as const, uncertainty: "No comparable post-deployment measurement" }
  const evidence = qualityText(observation.evidence, "post-deployment evidence")
  const delta = (observation.value - h.baseline) * (h.direction === "increase" ? 1 : -1)
  return {
    hypothesis: h,
    observation: { metric: h.metric, unit: h.unit, value: observation.value, evidence },
    delta,
    status: (h.direction === "increase" ? observation.value >= h.target : observation.value <= h.target)
      ? ("supported" as const)
      : ("not_supported" as const),
    uncertainty: "Observed change does not establish causality; review the measurement plan and confounders"
  }
}
