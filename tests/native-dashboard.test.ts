import { describe, expect, it } from "vitest"
import {
  decodeNativeEvidence,
  type NativeEvidenceSnapshot,
  NativeEvidenceView
} from "../packages/ui-components/src/native-evidence.js"

const snapshot: NativeEvidenceSnapshot = {
  version: 1,
  source: "live",
  observedAt: "2026-09-06T12:00:00Z",
  boardId: "board",
  workflows: [
    {
      version: 1,
      boardId: "board",
      workflowId: "workflow",
      lifecycle: { state: "review", attemptId: "attempt:1" },
      candidate: { headSha: "a".repeat(40) },
      review: null,
      blocker: null,
      nextActions: ["Await independent review"]
    }
  ],
  metrics: { admitted: 1, verifiedDeployments: 0, totalKnownCost: null }
}
describe("native evidence dashboard", () => {
  it("preserves source metrics and unknown cost without demo fallback", () => {
    expect(decodeNativeEvidence(snapshot)).toEqual(snapshot)
    expect(() => decodeNativeEvidence({ ...snapshot, source: undefined })).toThrow()
    expect(() =>
      decodeNativeEvidence({ ...snapshot, workflows: [{ ...snapshot.workflows[0], boardId: "other" }] })
    ).toThrow()
    expect(() =>
      decodeNativeEvidence({
        ...snapshot,
        workflows: [{ ...snapshot.workflows[0], review: { verdict: "approved", headSha: "b".repeat(40) } }]
      })
    ).toThrow()
  })
  it("uses accessible loading/offline/error states with no implicit fixture", () => {
    expect(NativeEvidenceView({ state: "loading" }).props.role).toBe("status")
    expect(NativeEvidenceView({ state: "offline" }).props.role).toBe("status")
    expect(NativeEvidenceView({ state: "ready" }).props.role).toBe("alert")
  })
  it("labels demonstration data and stale observations explicitly", () => {
    const view = NativeEvidenceView({
      state: "ready",
      snapshot: { ...snapshot, source: "demo" },
      now: Date.parse(snapshot.observedAt) + 120000
    })
    const serialized = JSON.stringify(view)
    expect(serialized).toContain("Demonstration data")
    expect(serialized).toContain("Stale snapshot")
    expect(serialized).toContain("Read-only")
  })
})
