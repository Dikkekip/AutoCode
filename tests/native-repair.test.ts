import { describe, expect, it } from "vitest"
import { nativeRepairObservation, planNativeRepair } from "../packages/core-runtime/src/native/repair.js"
import type { NativeWorkflow } from "../packages/core-runtime/src/native/runtime.js"

function workflow(): NativeWorkflow {
  return {
    proposal: {
      personaId: "backend",
      goal: "recover a job",
      title: "Fix resume",
      evidence: [],
      allowedPaths: ["src"],
      acceptance: ["Job resumes"],
      alternatives: [],
      implementationPrompt: "Fix resume"
    },
    rootCardId: "root",
    implementationCardId: "implement",
    stageCards: {},
    candidate: {
      cwd: "/fixture",
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      branch: "candidate",
      files: ["src/job.ts"]
    }
  }
}
describe("evidence-based repair planning", () => {
  it("stops a repeated candidate but gives a changed candidate a bounded delta handoff", () => {
    const w = workflow()
    const previous = nativeRepairObservation(w, "job still fails")
    expect(planNativeRepair(previous, [previous], 1).outcome).toBe("stalled")
    w.candidate!.headSha = "c".repeat(40)
    const current = nativeRepairObservation(w, "job still fails")
    expect(planNativeRepair(current, [previous], 1)).toMatchObject({
      outcome: "repair",
      repeatedFailure: true,
      remainingAttempts: 1,
      current,
      history: [previous]
    })
    expect(planNativeRepair(current, [previous], 2).outcome).toBe("exhausted")
  })
  it("permits genuinely new failure evidence on the same candidate without pretending it is progress", () => {
    const w = workflow()
    const first = nativeRepairObservation(w, "network unavailable")
    const second = nativeRepairObservation(w, "network restored; missing job record")
    expect(planNativeRepair(second, [first], 1)).toMatchObject({ outcome: "repair", repeatedFailure: false })
  })
  it("supports pre-upgrade attempts without inventing missing history", () => {
    const current = nativeRepairObservation(workflow(), "failure")
    expect(planNativeRepair(current, [], 1)).toMatchObject({ outcome: "repair", history: [], remainingAttempts: 1 })
    expect(() => planNativeRepair(current, [], Number.NaN)).toThrow(/attempt count/)
  })
  it("includes changed reviewer evidence while identifying recurring unsatisfied criteria", () => {
    const w = workflow()
    w.review = {
      headSha: w.candidate!.headSha,
      agentId: "reviewer",
      sessionKey: "review-session",
      verdict: "changes_requested",
      rationale: "Job cannot resume",
      assessment: { criteria: [{ criterion: "Job resumes", satisfied: false, evidence: "Missing job" }], findings: [] }
    }
    const previous = nativeRepairObservation(w, w.review.rationale)
    w.review.assessment!.criteria[0]!.evidence = "Job exists but cursor was lost"
    const current = nativeRepairObservation(w, w.review.rationale)
    expect(current.unsatisfiedCriteria).toEqual(["Job resumes"])
    expect(planNativeRepair(current, [previous], 1)).toMatchObject({ outcome: "repair", repeatedFailure: true })
  })
})
