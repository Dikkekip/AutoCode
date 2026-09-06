import { describe, expect, it } from "vitest"
import {
  aggregateLaneOutcomeStats,
  evaluateVerificationGate,
  type LaneHotspot,
  type LaneOutcomeStats,
  type PromptVariant,
  proposeLanesFromSignals,
  selectPromptVariant,
  smoothedSuccessRate,
  type TaskOutcome
} from "./feedback.js"

function outcome(overrides: Partial<TaskOutcome> = {}): TaskOutcome {
  return {
    id: overrides.id ?? "outcome-1",
    companyId: "company-1",
    projectId: "project-1",
    taskId: "task-1",
    runId: null,
    laneId: overrides.laneId ?? "lane-a",
    stage: "execution",
    adapterType: null,
    result: overrides.result ?? "success",
    reason: null,
    verificationPassed: null,
    reviewVerdict: null,
    retryCount: overrides.retryCount ?? 0,
    turns: overrides.turns ?? null,
    costCents: null,
    tokensTotal: null,
    durationMs: null,
    reflection: null,
    metadata: {},
    createdAt: overrides.createdAt ?? "2024-01-01T00:00:00.000Z",
    ...overrides
  }
}

describe("aggregateLaneOutcomeStats", () => {
  it("computes per-lane success and rejection rates", () => {
    const stats = aggregateLaneOutcomeStats([
      outcome({ id: "1", laneId: "lane-a", result: "success" }),
      outcome({ id: "2", laneId: "lane-a", result: "failure", retryCount: 2 }),
      outcome({ id: "3", laneId: "lane-a", result: "rejected" }),
      outcome({ id: "4", laneId: "lane-b", result: "success" })
    ])

    const laneA = stats.find((entry) => entry.laneId === "lane-a")
    expect(laneA).toBeDefined()
    expect(laneA?.total).toBe(3)
    expect(laneA?.success).toBe(1)
    expect(laneA?.successRate).toBeCloseTo(0.333, 2)
    expect(laneA?.rejectionRate).toBeCloseTo(0.333, 2)
    expect(laneA?.avgRetries).toBeCloseTo(0.667, 2)
  })

  it("buckets lane-less outcomes under (unassigned)", () => {
    const stats = aggregateLaneOutcomeStats([outcome({ laneId: null })])
    expect(stats[0]?.laneId).toBe("(unassigned)")
  })
})

describe("proposeLanesFromSignals", () => {
  it("proposes a new lane for unmatched high-churn hotspots", () => {
    const hotspots: LaneHotspot[] = [{ laneId: "payments", fileCount: 12, files: ["a.ts", "b.ts"] }]
    const proposals = proposeLanesFromSignals({ hotspots, stats: [], existingLaneIds: [] })
    expect(proposals).toHaveLength(1)
    expect(proposals[0]?.recommendedAction).toBe("create_lane")
    expect(proposals[0]?.matchedExistingLane).toBe(false)
  })

  it("flags an existing lane with a poor track record for investigation", () => {
    const hotspots: LaneHotspot[] = [{ laneId: "lane-a", fileCount: 3, files: ["x.ts"] }]
    const stats: LaneOutcomeStats[] = [
      {
        laneId: "lane-a",
        total: 5,
        success: 1,
        failure: 4,
        rejected: 0,
        blocked: 0,
        successRate: 0.2,
        rejectionRate: 0,
        avgRetries: 1,
        avgTurns: null,
        lastOutcomeAt: null
      }
    ]
    const proposals = proposeLanesFromSignals({ hotspots, stats, existingLaneIds: ["lane-a"] })
    expect(proposals).toHaveLength(1)
    expect(proposals[0]?.recommendedAction).toBe("investigate_failures")
  })

  it("does not propose for low-churn unmatched areas", () => {
    const hotspots: LaneHotspot[] = [{ laneId: "tiny", fileCount: 2, files: ["x.ts"] }]
    expect(proposeLanesFromSignals({ hotspots, stats: [], existingLaneIds: [] })).toHaveLength(0)
  })
})

describe("selectPromptVariant", () => {
  function variant(overrides: Partial<PromptVariant>): PromptVariant {
    return {
      id: overrides.id ?? "v",
      projectId: "p",
      scope: "planner",
      label: overrides.label ?? "v",
      promptHash: overrides.promptHash ?? "hash",
      status: overrides.status ?? "active",
      trials: overrides.trials ?? 0,
      successes: overrides.successes ?? 0,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      ...overrides
    }
  }

  it("returns null when there are no eligible variants", () => {
    expect(selectPromptVariant([])).toBeNull()
    expect(selectPromptVariant([variant({ status: "retired" })])).toBeNull()
  })

  it("exploits the highest smoothed success rate when not exploring", () => {
    const best = variant({ id: "best", label: "best", trials: 10, successes: 9 })
    const worst = variant({ id: "worst", label: "worst", trials: 10, successes: 1 })
    const selection = selectPromptVariant([worst, best], { epsilon: 0, random: () => 0.99 })
    expect(selection?.variant.id).toBe("best")
    expect(selection?.exploration).toBe(false)
  })

  it("explores when the random draw is below epsilon", () => {
    const a = variant({ id: "a", label: "a", trials: 10, successes: 9 })
    const b = variant({ id: "b", label: "b", trials: 10, successes: 1 })
    const selection = selectPromptVariant([a, b], { epsilon: 1, random: () => 0 })
    expect(selection?.exploration).toBe(true)
    expect(selection?.variant.id).toBe("a")
  })

  it("smooths success rate with Laplace smoothing", () => {
    expect(smoothedSuccessRate(variant({ trials: 0, successes: 0 }))).toBeCloseTo(0.5, 5)
    expect(smoothedSuccessRate(variant({ trials: 8, successes: 8 }))).toBeCloseTo(0.9, 5)
  })
})

describe("evaluateVerificationGate", () => {
  it("blocks when a required check fails", () => {
    const decision = evaluateVerificationGate({
      checks: [
        { command: "build", passed: true },
        { command: "test", passed: false }
      ]
    })
    expect(decision.allowed).toBe(false)
    expect(decision.failedCommands).toEqual(["test"])
  })

  it("blocks when the review requested changes", () => {
    const decision = evaluateVerificationGate({
      checks: [{ command: "build", passed: true }],
      reviewVerdict: "changes_requested"
    })
    expect(decision.allowed).toBe(false)
  })

  it("blocks when at least one check is required but none ran", () => {
    const decision = evaluateVerificationGate({ checks: [], requireAtLeastOneCheck: true })
    expect(decision.allowed).toBe(false)
  })

  it("allows when all checks pass and review approves", () => {
    const decision = evaluateVerificationGate({
      checks: [{ command: "build", passed: true }],
      reviewVerdict: "approved"
    })
    expect(decision.allowed).toBe(true)
  })
})
