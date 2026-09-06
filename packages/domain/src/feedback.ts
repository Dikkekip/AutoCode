import type { AdapterType, PersonaStage, ReviewVerdict } from "./types.js"

/**
 * Feedback engine: the closed loop that lets the dispatcher learn from its own
 * outcomes. Everything in this module is pure and deterministic so it can be
 * unit-tested in isolation and reused from the store, executor and planner.
 */

export type TaskOutcomeResult = "success" | "failure" | "rejected" | "blocked" | "abandoned"

export type OutcomeStage = PersonaStage | "execution" | "promotion"

/** A single recorded result for a task attempt, the atom of the outcome ledger. */
export interface TaskOutcome {
  id: string
  companyId: string
  projectId: string
  taskId: string
  runId: string | null
  laneId: string | null
  stage: OutcomeStage
  adapterType: AdapterType | null
  result: TaskOutcomeResult
  reason: string | null
  verificationPassed: boolean | null
  reviewVerdict: ReviewVerdict | null
  retryCount: number
  turns: number | null
  costCents: number | null
  tokensTotal: number | null
  durationMs: number | null
  reflection: string | null
  metadata: Record<string, unknown>
  createdAt: string
}

/** Aggregated, per-lane track record used as a planner signal. */
export interface LaneOutcomeStats {
  laneId: string
  total: number
  success: number
  failure: number
  rejected: number
  blocked: number
  successRate: number
  rejectionRate: number
  avgRetries: number
  avgTurns: number | null
  lastOutcomeAt: string | null
}

export type LaneProposalAction = "create_lane" | "increase_capacity" | "investigate_failures"

/** A planner-facing suggestion to add/adjust a lane based on churn vs. outcomes. */
export interface LaneProposal {
  laneId: string
  recommendedAction: LaneProposalAction
  reason: string
  evidence: string[]
  churnFileCount: number
  matchedExistingLane: boolean
  priority: number
}

export interface LaneHotspot {
  laneId: string
  fileCount: number
  files: string[]
}

/**
 * Aggregate a flat list of outcomes into per-lane statistics. Outcomes without
 * a lane are grouped under the synthetic "(unassigned)" lane so they remain
 * visible rather than silently dropped.
 */
export function aggregateLaneOutcomeStats(outcomes: readonly TaskOutcome[]): LaneOutcomeStats[] {
  const byLane = new Map<string, TaskOutcome[]>()
  for (const outcome of outcomes) {
    const laneId = outcome.laneId ?? "(unassigned)"
    const bucket = byLane.get(laneId)
    if (bucket) {
      bucket.push(outcome)
    } else {
      byLane.set(laneId, [outcome])
    }
  }

  const stats: LaneOutcomeStats[] = []
  for (const [laneId, laneOutcomes] of byLane) {
    const total = laneOutcomes.length
    const success = laneOutcomes.filter((entry) => entry.result === "success").length
    const failure = laneOutcomes.filter((entry) => entry.result === "failure").length
    const rejected = laneOutcomes.filter((entry) => entry.result === "rejected").length
    const blocked = laneOutcomes.filter((entry) => entry.result === "blocked").length
    const retrySum = laneOutcomes.reduce((sum, entry) => sum + entry.retryCount, 0)
    const turnValues = laneOutcomes
      .map((entry) => entry.turns)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    const turnSum = turnValues.reduce((sum, value) => sum + value, 0)
    const lastOutcomeAt =
      laneOutcomes
        .map((entry) => entry.createdAt)
        .filter((value): value is string => Boolean(value))
        .sort()
        .at(-1) ?? null

    stats.push({
      laneId,
      total,
      success,
      failure,
      rejected,
      blocked,
      successRate: total > 0 ? round(success / total) : 0,
      rejectionRate: total > 0 ? round(rejected / total) : 0,
      avgRetries: total > 0 ? round(retrySum / total) : 0,
      avgTurns: turnValues.length > 0 ? round(turnSum / turnValues.length) : null,
      lastOutcomeAt
    })
  }

  return stats.sort((left, right) => right.total - left.total)
}

export interface LaneProposalInput {
  hotspots: readonly LaneHotspot[]
  stats: readonly LaneOutcomeStats[]
  existingLaneIds: readonly string[]
  /** Minimum number of changed files in an unmatched area before proposing a lane. */
  minChurnFiles?: number
  /** Success rate at/below which an existing lane is flagged for investigation. */
  maxHealthyFailureRate?: number
  /** Minimum outcomes before failure-rate based proposals are trusted. */
  minOutcomesForFailureSignal?: number
}

/**
 * Derive lane proposals by combining churn hotspots (where work is happening)
 * with outcome statistics (how well that work goes). Proposals are advisory:
 * the planner surfaces them and a reviewer/human decides. We never mutate lanes
 * directly from this function.
 */
export function proposeLanesFromSignals(input: LaneProposalInput): LaneProposal[] {
  const minChurnFiles = input.minChurnFiles ?? 8
  const maxHealthyFailureRate = input.maxHealthyFailureRate ?? 0.5
  const minOutcomes = input.minOutcomesForFailureSignal ?? 4
  const existing = new Set(input.existingLaneIds)
  const statsByLane = new Map(input.stats.map((entry) => [entry.laneId, entry]))
  const proposals: LaneProposal[] = []

  for (const hotspot of input.hotspots) {
    const matched = existing.has(hotspot.laneId)
    const stats = statsByLane.get(hotspot.laneId) ?? null

    // Unmatched high-churn area with no owning lane -> propose a new lane.
    if (!matched && hotspot.fileCount >= minChurnFiles) {
      proposals.push({
        laneId: hotspot.laneId,
        recommendedAction: "create_lane",
        reason: `High churn (${hotspot.fileCount} files) in an area without a dedicated lane.`,
        evidence: hotspot.files.slice(0, 10),
        churnFileCount: hotspot.fileCount,
        matchedExistingLane: false,
        priority: scoreProposal(hotspot.fileCount, null)
      })
      continue
    }

    // Existing lane with churn but a poor track record -> investigate.
    if (matched && stats && stats.total >= minOutcomes) {
      const failureRate = round(1 - stats.successRate)
      if (failureRate >= maxHealthyFailureRate) {
        proposals.push({
          laneId: hotspot.laneId,
          recommendedAction: "investigate_failures",
          reason: `Lane succeeds only ${Math.round(stats.successRate * 100)}% of the time over ${stats.total} outcomes.`,
          evidence: [
            `success=${stats.success}`,
            `failure=${stats.failure}`,
            `rejected=${stats.rejected}`,
            `blocked=${stats.blocked}`,
            `avgRetries=${stats.avgRetries}`
          ],
          churnFileCount: hotspot.fileCount,
          matchedExistingLane: true,
          priority: scoreProposal(hotspot.fileCount, failureRate)
        })
      }
    }
  }

  return proposals.sort((left, right) => right.priority - left.priority)
}

function scoreProposal(churnFileCount: number, failureRate: number | null): number {
  const churnScore = Math.min(churnFileCount, 50)
  const failureScore = failureRate === null ? 0 : Math.round(failureRate * 50)
  return churnScore + failureScore
}

/** Status of a prompt variant used by the planner-prompt evolution experiment. */
export type PromptVariantStatus = "active" | "candidate" | "retired"

export interface PromptVariant {
  id: string
  projectId: string
  scope: string
  label: string
  promptHash: string
  status: PromptVariantStatus
  trials: number
  successes: number
  createdAt: string
  updatedAt: string
}

export interface PromptVariantSelection {
  variant: PromptVariant
  exploration: boolean
  reason: string
}

/**
 * Epsilon-greedy selection over prompt variants. With probability `epsilon` we
 * explore a random non-retired variant; otherwise we exploit the variant with
 * the highest Laplace-smoothed success rate. `random` is injectable for
 * deterministic tests.
 */
export function selectPromptVariant(
  variants: readonly PromptVariant[],
  options: { epsilon?: number; random?: () => number } = {}
): PromptVariantSelection | null {
  const candidates = variants.filter((variant) => variant.status !== "retired")
  if (candidates.length === 0) {
    return null
  }

  const epsilon = clamp(options.epsilon ?? 0.2, 0, 1)
  const random = options.random ?? Math.random

  if (candidates.length > 1 && random() < epsilon) {
    const index = Math.min(candidates.length - 1, Math.floor(random() * candidates.length))
    const variant = candidates[index]!
    return {
      variant,
      exploration: true,
      reason: `Exploring variant "${variant.label}" (epsilon=${epsilon}).`
    }
  }

  let best = candidates[0]!
  let bestScore = smoothedSuccessRate(best)
  for (const candidate of candidates.slice(1)) {
    const score = smoothedSuccessRate(candidate)
    if (score > bestScore) {
      best = candidate
      bestScore = score
    }
  }

  return {
    variant: best,
    exploration: false,
    reason: `Exploiting best variant "${best.label}" (smoothed success ${round(bestScore)}).`
  }
}

export function smoothedSuccessRate(variant: PromptVariant): number {
  // Laplace smoothing keeps unproven variants comparable without overcommitting.
  return (variant.successes + 1) / (variant.trials + 2)
}

/** Result of a single verification command execution. */
export interface VerificationCheckResult {
  command: string
  passed: boolean
  summary?: string | null
  durationMs?: number | null
}

export interface VerificationGateInput {
  checks: readonly VerificationCheckResult[]
  /** When true (default) every check must pass; when false at least one must pass. */
  requireAll?: boolean
  /** Optional review verdict that can independently block promotion. */
  reviewVerdict?: ReviewVerdict | null
  /** When true, an empty check list blocks promotion instead of allowing it. */
  requireAtLeastOneCheck?: boolean
}

export interface VerificationGateDecision {
  allowed: boolean
  reason: string
  failedCommands: string[]
}

/**
 * Decide whether a change may be promoted. This is the non-negotiable gate the
 * promoter sweep consults before merging: confidently-wrong code is the biggest
 * risk in autonomous development, so a failed verify or a non-approving review
 * blocks the merge.
 */
export function evaluateVerificationGate(input: VerificationGateInput): VerificationGateDecision {
  const requireAll = input.requireAll ?? true
  const failedCommands = input.checks.filter((check) => !check.passed).map((check) => check.command)

  if (input.reviewVerdict === "changes_requested" || input.reviewVerdict === "blocked") {
    return {
      allowed: false,
      reason: `Review verdict "${input.reviewVerdict}" blocks promotion.`,
      failedCommands
    }
  }

  if (input.checks.length === 0) {
    if (input.requireAtLeastOneCheck) {
      return {
        allowed: false,
        reason: "No verification checks were run but at least one is required before promotion.",
        failedCommands: []
      }
    }
    return { allowed: true, reason: "No verification checks configured.", failedCommands: [] }
  }

  if (requireAll && failedCommands.length > 0) {
    return {
      allowed: false,
      reason: `${failedCommands.length} verification command(s) failed: ${failedCommands.join(", ")}.`,
      failedCommands
    }
  }

  if (!requireAll && failedCommands.length === input.checks.length) {
    return {
      allowed: false,
      reason: "All verification commands failed.",
      failedCommands
    }
  }

  return { allowed: true, reason: "All required verification checks passed.", failedCommands }
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
