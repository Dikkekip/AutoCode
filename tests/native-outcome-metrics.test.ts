import { expect, it } from "vitest"
import { type NativeOutcomeEvent, nativeOutcomeMetrics } from "../packages/evaluation/src/native-outcomes.js"

const window = { from: 0, to: 100, asOf: 300, retentionMs: 50 }
function events() {
  let id = 0
  const result: NativeOutcomeEvent[] = []
  const add = (subject: string, kind: string, createdAt: number, data: Record<string, unknown> = {}) =>
    result.push({ id: ++id, subject, kind, createdAt, data })
  for (const subject of ["first", "repair", "pending", "cancelled", "rollback"])
    add(subject, "workflow.admitted", 10, { attemptId: `${subject}:attempt:0` })
  add("first", "workflow.transitioned", 20, {
    state: "release",
    attempt: 0,
    attemptId: "first:attempt:0",
    reviewVerdict: "approved"
  })
  add("first", "workflow.transitioned", 30, { state: "completed", deployedSha: "sha-first" })
  add("first", "workflow.retention-observed", 100, { deployedSha: "sha-first", healthy: true, observedUntil: 90 })
  add("first", "workflow.usage", 100, { complete: true, costCents: 17 })
  add("repair", "workflow.transitioned", 20, {
    state: "review",
    attempt: 0,
    attemptId: "repair:attempt:0",
    reviewVerdict: "changes_requested"
  })
  add("repair", "workflow.repair-requested", 30, { attempt: 1, attemptId: "repair:attempt:1" })
  add("repair", "workflow.transitioned", 40, {
    state: "completed",
    attempt: 1,
    attemptId: "repair:attempt:1",
    deployedSha: "sha-repair"
  })
  add("cancelled", "workflow.transitioned", 20, { state: "cancelled" })
  add("rollback", "workflow.transitioned", 30, { state: "completed", deployedSha: "sha-rollback" })
  add("rollback", "workflow.rolled-back", 45, { restoredSha: "old-sha" })
  add("repair", "workflow.operator-action", 35, {})
  add("legacy", "workflow.transitioned", 5, { state: "review" })
  return result
}
it("uses explicit admission cohorts and distinguishes deployed, retained, pending, failed and unknown cost", () => {
  const report = nativeOutcomeMetrics(events(), window)
  expect(report.denominators).toEqual({ admitted: 5, reviewed: 3, deployed: 3, retentionObserved: 2, costKnown: 1 })
  expect(report.firstPassVerifiedSuccess).toEqual({ numerator: 2, denominator: 5, value: 0.4 })
  expect(report.eventualVerifiedSuccess.value).toBe(0.6)
  expect(report.retainedSuccess).toEqual({ numerator: 1, denominator: 2, value: 0.5 })
  expect(report.cost).toEqual({ knownCents: 17, unknownWorkflows: 4, centsPerRetainedImprovement: null })
  expect(report.timeToVerifiedDeploymentMs.censored).toBe(1)
  expect(report.missingAdmissionHistory).toBe(1)
  expect(report.workflows.find((w) => w.workflowId === "repair")).toMatchObject({
    attempts: 2,
    firstPassReview: false,
    retained: null,
    repairs: 1,
    interventions: 1
  })
})
it("repair and replay cannot remove failed review history or improve denominators", () => {
  const source = events()
  const report = nativeOutcomeMetrics(source, window)
  expect(nativeOutcomeMetrics([...source, ...source].reverse(), window)).toEqual(report)
  const repaired = report.workflows.find((w) => w.workflowId === "repair")!
  expect(repaired.reviewed).toBe(true)
  expect(repaired.firstPassSuccess).toBe(false)
  const before = nativeOutcomeMetrics(source, { ...window, to: 25, asOf: 25 })
  expect(before.denominators.admitted).toBe(5)
  expect(before.workflows.find((w) => w.workflowId === "repair")?.reviewed).toBe(true)
})
it("does not infer retention from elapsed time, wrong revision, future evidence or card completion", () => {
  const source = events().filter((e) => e.kind !== "workflow.retention-observed")
  source.push({
    id: 100,
    subject: "first",
    kind: "workflow.retention-observed",
    createdAt: 100,
    data: { deployedSha: "wrong", healthy: true, observedUntil: 90 }
  })
  source.push({
    id: 101,
    subject: "first",
    kind: "workflow.retention-observed",
    createdAt: 100,
    data: { deployedSha: "sha-first", healthy: true, observedUntil: 999 }
  })
  source.push({ id: 102, subject: "pending", kind: "card.completed", createdAt: 100, data: {} })
  const report = nativeOutcomeMetrics(source, window)
  expect(report.workflows.find((w) => w.workflowId === "first")?.retained).toBeNull()
  expect(report.workflows.find((w) => w.workflowId === "pending")?.deployed).toBe(false)
})
it("reports empty rates as unknown and rejects conflicting replay identities", () => {
  expect(nativeOutcomeMetrics([], window).eventualVerifiedSuccess.value).toBeNull()
  const source = events()
  expect(() => nativeOutcomeMetrics([...source, { ...source[0]!, subject: "forged" }], window)).toThrow(/Conflicting/)
})
