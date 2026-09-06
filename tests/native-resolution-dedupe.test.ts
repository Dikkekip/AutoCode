import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { allowNativeDuplicateOverride, decideNativeDuplicate } from "../packages/core-runtime/src/native/dedupe.js"
import { NativeEvidenceStore } from "../packages/core-runtime/src/native/store.js"
import type { NativeProposal } from "../packages/domain/src/native-autonomy.js"

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn()
})
function setup() {
  const root = mkdtempSync(join(tmpdir(), "native-dedupe-"))
  const store = new NativeEvidenceStore(join(root, "evidence.db"), () => 1000)
  cleanups.push(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  const proposal = {
    title: "Navigation",
    allowedPaths: ["src/view.ts"],
    quality: {
      problem: "Source navigation is missing",
      userWorkflow: "Open source citation",
      evidenceHashes: { "src/view.ts": "old" }
    }
  } as unknown as NativeProposal
  store.put("proposal", "old", { proposal })
  store.put("decision", "old", { outcome: "admitted", workflowId: "workflow" })
  return { store, proposal }
}
it("suppresses reordered paraphrases only with matching problem, workflow, scope and evidence", () => {
  const s = setup()
  const next = { ...s.proposal, quality: { ...s.proposal.quality!, problem: "Missing source navigation" } }
  expect(decideNativeDuplicate(s.store, "next", next, 72, 1000)).toMatchObject({
    suppress: true,
    matchingProposalId: "old"
  })
  expect(
    decideNativeDuplicate(
      s.store,
      "different",
      { ...next, quality: { ...next.quality, problem: "Source navigation exposes credentials" } },
      72,
      1000
    ).suppress
  ).toBe(false)
})
it("allows changed evidence and a proven reverted resolution", () => {
  const s = setup()
  expect(
    decideNativeDuplicate(
      s.store,
      "next",
      { ...s.proposal, quality: { ...s.proposal.quality!, evidenceHashes: { "src/view.ts": "changed" } } },
      72,
      1000
    ).suppress
  ).toBe(false)
  s.store.event("workflow.regression", "workflow", {})
  expect(decideNativeDuplicate(s.store, "regression", s.proposal, 72, 1000)).toMatchObject({
    suppress: false,
    reason: "changed_evidence_or_reversed_resolution"
  })
})
it("binds human override to exact proposal and expiry without accepting agent approval", () => {
  const s = setup()
  const authority = { operatorId: "human", rationale: "Different observed problem despite same normalized signature" }
  expect(() =>
    allowNativeDuplicateOverride(
      s.store,
      "next",
      s.proposal,
      2000,
      { ...authority, operatorId: "planner" },
      ["planner"],
      1000
    )
  ).toThrow(/Independent/)
  allowNativeDuplicateOverride(s.store, "next", s.proposal, 2000, authority, ["planner"], 1000)
  expect(decideNativeDuplicate(s.store, "next", s.proposal, 72, 1500).reason).toBe("operator_override")
  expect(decideNativeDuplicate(s.store, "next", s.proposal, 72, 2500).suppress).toBe(true)
})
it("bounds candidate work and expires old history", () => {
  const s = setup()
  expect(decideNativeDuplicate(s.store, "next", s.proposal, 1, 4_000_000).suppress).toBe(false)
  for (let i = 0; i < 150; i++)
    s.store.put("proposal", `unrelated-${i}`, {
      proposal: { ...s.proposal, quality: { ...s.proposal.quality!, problem: `unrelated ${i}` } }
    })
  expect(
    decideNativeDuplicate(
      s.store,
      "next",
      { ...s.proposal, quality: { ...s.proposal.quality!, problem: "Entirely distinct issue" } },
      72,
      1000
    )
  ).toMatchObject({ compared: 128, truncated: true })
})
