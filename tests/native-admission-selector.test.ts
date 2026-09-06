import { describe, expect, it } from "vitest"
import {
  assessNativeBenefit,
  type NativeSelectionCandidate,
  selectNativeImprovements,
  validateNativeBenefitHypothesis
} from "../packages/domain/src/native-quality.js"
import { evaluateNativeAdmission } from "../packages/evaluation/src/autonomous-company.js"

function candidate(
  id: string,
  patch: Partial<NativeSelectionCandidate["hypothesis"]> = {},
  risk: "routine" | "high" = "routine"
): NativeSelectionCandidate {
  return {
    id,
    goal: "Reduce navigation time",
    weight: 1,
    risk,
    hypothesis: {
      metric: "navigation duration",
      unit: "seconds",
      baseline: 100,
      target: 50,
      direction: "decrease",
      baselineEvidence: ["src/navigation.ts"],
      evidenceStrength: "observed",
      confidence: 0.7,
      uncertainty: "Small sample; traffic mix may differ",
      effortHours: 2,
      costCents: 100,
      measurementPlan: "Compare median duration over seven days with matched traffic",
      alternatives: [
        { kind: "no_op", description: "Keep current flow", rationale: "Zero implementation cost" },
        { kind: "change", description: "Shorten flow", rationale: "Remove repeated navigation" }
      ],
      ...patch
    }
  }
}
const budget = { effortHours: 8, costCents: 1000 }
describe("native value admission", () => {
  it("rejects satisfied and negligible hypotheses and compares a fixed capacity baseline", () => {
    const result = evaluateNativeAdmission({
      candidates: [candidate("satisfied", { baseline: 40 }), candidate("tiny", { target: 99 }), candidate("useful")],
      budget,
      slots: 2,
      realizedUtility: { satisfied: -1, tiny: -1, useful: 5 },
      investigations: ["completed", "no_op"]
    })
    expect(result.baseline.ids).toEqual(["satisfied", "tiny"])
    expect(result.selector.ids).toEqual(["useful"])
    expect(result.selector.realizedUtility).toBeGreaterThan(result.baseline.realizedUtility)
    expect(result.successfulInvestigations).toBe(2)
    expect(result.decisions.every((d) => d.rationale && d.uncertainty)).toBe(true)
  })
  it("increases evidence requirements with cost and risk", () => {
    const candidates = [
      candidate("cheap"),
      candidate("expensive", { effortHours: 10 }),
      candidate("risky", {}, "high"),
      candidate("supported", { confidence: 0.95, evidenceStrength: "measured" }, "high")
    ]
    const result = selectNativeImprovements(candidates, { effortHours: 30, costCents: 10000 }, 4)
    expect(result.filter((d) => d.outcome === "selected").map((d) => d.id)).toEqual(["cheap", "supported"])
    expect(result.find((d) => d.id === "risky")?.requiredConfidence).toBe(0.9)
  })
  it("ranks operator priorities independent of arrival order and stays within budget", () => {
    const low = candidate("low")
    const high = { ...candidate("high"), weight: 10 }
    const scenario = {
      candidates: [low, high],
      budget: { effortHours: 2, costCents: 100 },
      slots: 2,
      realizedUtility: { low: 1, high: 10 },
      investigations: ["completed" as const]
    }
    const report = evaluateNativeAdmission(scenario)
    expect(report.selector.ids).toEqual(["high"])
    expect(report.selector.effortHours).toBe(2)
    expect(selectNativeImprovements([high, low], scenario.budget, 2)).toEqual(report.decisions)
    expect(report.decisions.find((d) => d.id === "low")?.outcome).toBe("deferred")
  })
  it("records a useful no-op without rewarding backlog growth", () => {
    const report = evaluateNativeAdmission({
      candidates: [],
      budget,
      slots: 2,
      realizedUtility: {},
      investigations: ["no_op"]
    })
    expect(report.successfulInvestigations).toBe(1)
    expect(report.selector.ids).toEqual([])
  })
  it("requires finite estimates, baseline evidence, and a no-op comparison", () => {
    for (const patch of [{ confidence: NaN }, { effortHours: -1 }, { baselineEvidence: [] }, { alternatives: [] }])
      expect(() => validateNativeBenefitHypothesis(candidate("invalid", patch).hypothesis)).toThrow()
  })
  it("links observations to the frozen hypothesis without treating deployment as benefit", () => {
    const h = candidate("value").hypothesis
    expect(assessNativeBenefit(h, undefined).status).toBe("unmeasured")
    expect(assessNativeBenefit(h, { metric: h.metric, unit: "ms", value: 20 }).status).toBe("unmeasured")
    const result = assessNativeBenefit(h, {
      metric: h.metric,
      unit: h.unit,
      value: 40,
      evidence: "Seven-day matched sample"
    })
    expect(result.status).toBe("supported")
    expect(result.hypothesis).toEqual(h)
    expect(assessNativeBenefit(h, { metric: h.metric, unit: h.unit, value: 80, evidence: "Same cohort" }).status).toBe(
      "not_supported"
    )
  })
})

it("reserves reviewed exploration across goals without relaxing value or budget gates", () => {
  const familiar = candidate("familiar", { effortHours: 1 })
  const exploration = { ...candidate("new-goal"), goal: "Improve keyboard navigation" }
  const empty = { ...candidate("empty", { baseline: 40 }), goal: "Speculative cleanup" }
  const options = { slots: 1, goalAdmissions: { [familiar.goal]: 2 } }
  const result = selectNativeImprovements([familiar, exploration, empty], budget, 1, options)
  expect(result.find((d) => d.outcome === "selected")).toMatchObject({ id: "new-goal", exploration: true })
  expect(result.find((d) => d.id === "empty")?.outcome).toBe("rejected")
  const capped = selectNativeImprovements([exploration], { effortHours: 1, costCents: 0 }, 1, options)
  expect(capped[0]?.outcome).toBe("deferred")
  expect(selectNativeImprovements([familiar, exploration], budget, 1)[0]?.id).toBe("familiar")
})
