import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { NativeBudgetLedger, type NativeBudgetPolicy } from "../packages/core-runtime/src/native/budget-ledger.js"
import { NativeEvidenceStore } from "../packages/core-runtime/src/native/store.js"

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn()
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "native-budget-"))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, "db")
  const a = new NativeEvidenceStore(path),
    b = new NativeEvidenceStore(path)
  cleanup.push(
    () => a.close(),
    () => b.close()
  )
  const cap = { tokens: 100, actions: 5 }
  const policy: NativeBudgetPolicy = {
    version: 1,
    limits: { project: cap, day: cap, workflow: cap, attempt: cap },
    safetyReserve: { tokens: 10, actions: 1 },
    unknownUsage: "hold"
  }
  return { a: new NativeBudgetLedger(a, policy), b: new NativeBudgetLedger(b, policy) }
}
const input = {
  id: "one",
  projectId: "project",
  workflowId: "workflow",
  attemptId: "attempt",
  purpose: "verification",
  amount: { tokens: 60, actions: 1 }
}
describe("native complete-workflow budgets", () => {
  it("reserves atomically across connections and retains safety capacity", () => {
    const { a, b } = fixture()
    a.reserve(input)
    expect(() => b.reserve({ ...input, id: "two" })).toThrow(/exhausted/)
    b.reserve({ ...input, id: "cleanup", amount: { tokens: 40, actions: 1 }, safety: true })
    expect(() => a.reserve({ ...input, id: "three", amount: { tokens: 1, actions: 1 } })).toThrow(/exhausted/)
  })
  it("replays reservations once and holds unknown usage across restart", () => {
    const { a, b } = fixture()
    a.reserve(input)
    expect(b.reserve(input).id).toBe("one")
    a.settle("one", null)
    expect(b.explain("project").unknown).toBe(1)
    expect(() => b.reserve({ ...input, id: "retry" })).toThrow(/exhausted/)
    b.settle("one", { tokens: 20, actions: 1 })
    a.reserve({ ...input, id: "retry" })
    expect(() => a.settle("one", { tokens: 0, actions: 0 })).toThrow(/cannot change/)
  })
  it("rejects unknown and partial capped estimates rather than treating them free", () => {
    const { a } = fixture()
    expect(() => a.reserve({ ...input, amount: { actions: 1 } })).toThrow(/Unknown tokens/)
    a.reserve(input)
    expect(() => a.settle("one", { actions: 1 })).toThrow(/Partial usage/)
    expect(() => a.reserve({ ...input, attemptId: "other" })).toThrow(/changed context/)
  })
})
