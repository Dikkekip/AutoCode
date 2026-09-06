/** Native lifecycle, transaction and replay regression fixtures. */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { NativeAutonomyRuntime } from "../packages/core-runtime/src/native/runtime.js"
import { NativeEvidenceStore, NativeRevisionConflict } from "../packages/core-runtime/src/native/store.js"
import {
  type NativeLifecycleEvidence,
  type NativeWorkflowState,
  nextNativeAttempt,
  transitionNativeLifecycle,
  upgradeNativeLifecycle
} from "../packages/domain/src/native-lifecycle.js"

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn()
})
function stores() {
  const root = mkdtempSync(join(tmpdir(), "native-lifecycle-"))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, "evidence.db")
  const a = new NativeEvidenceStore(path),
    b = new NativeEvidenceStore(path)
  cleanup.push(
    () => a.close(),
    () => b.close()
  )
  return { a, b }
}
const evidence: NativeLifecycleEvidence = {
  candidate: { headSha: "head" },
  verification: { headSha: "head", checks: [{ exitCode: 0 }] },
  review: { headSha: "head", verdict: "approved" },
  mergedSha: "merged",
  deployedSha: "merged"
}
it("governs the full lifecycle and preserves immutable attempt identity", () => {
  let state = upgradeNativeLifecycle("workflow", {})
  const attemptId = state.attemptId
  for (const target of [
    "design_wait",
    "implementation",
    "verification",
    "review",
    "release",
    "deployment",
    "completed"
  ] as const)
    state = transitionNativeLifecycle(state, target, evidence)
  expect(state.attemptId).toBe(attemptId)
  expect(() => transitionNativeLifecycle(state, "implementation", evidence)).toThrow(/Illegal/)
})
it("rejects missing prerequisites and cross-attempt evidence", () => {
  const state = upgradeNativeLifecycle("workflow", {})
  expect(() => transitionNativeLifecycle(state, "release", {})).toThrow(/Illegal/)
  expect(() => transitionNativeLifecycle(state, "verification", {})).toThrow(/candidate/)
  expect(() =>
    upgradeNativeLifecycle("workflow", { ...evidence, verification: { headSha: "other", checks: [{ exitCode: 0 }] } })
  ).toThrow(/another attempt/)
  const bound = upgradeNativeLifecycle("workflow", { candidate: evidence.candidate! })
  expect(() => transitionNativeLifecycle(bound, "review", { ...evidence, candidate: { headSha: "changed" } })).toThrow(
    /immutable/
  )
  expect(() => transitionNativeLifecycle(bound, "review", { candidate: evidence.candidate! })).toThrow(/verification/)
})
it("creates a new repair attempt without carrying authority and deterministically upgrades old records", () => {
  const previous = upgradeNativeLifecycle("workflow", { candidate: evidence.candidate! })
  expect(upgradeNativeLifecycle("workflow", { candidate: evidence.candidate! })).toEqual(previous)
  expect(() => nextNativeAttempt(previous, evidence)).toThrow(/inherit/)
  const repaired = nextNativeAttempt(previous, {})
  expect(repaired.attemptId).toBe("workflow:attempt:1")
  expect(repaired.headSha).toBeUndefined()
})
it.each([
  "blocked",
  "cancelled",
  "completed"
] as const)("keeps %s terminal until an explicit recovery contract exists", (state) => {
  const terminal = { version: 1 as const, state, attempt: 0, attemptId: "w:attempt:0" }
  expect(() => transitionNativeLifecycle(terminal, "implementation", evidence)).toThrow(/Illegal/)
})
it("tests every pair in the transition matrix", () => {
  const allowed: Record<NativeWorkflowState, string[]> = {
    design_wait: ["implementation", "verification", "review", "release", "blocked", "cancelled"],
    implementation: ["design_wait", "verification", "blocked", "cancelled"],
    verification: ["review", "implementation", "design_wait", "blocked", "cancelled"],
    review: ["release", "implementation", "design_wait", "blocked", "cancelled"],
    release: ["deployment", "design_wait", "blocked"],
    deployment: ["completed", "blocked"],
    blocked: [],
    cancelled: [],
    completed: []
  }
  for (const from of Object.keys(allowed) as NativeWorkflowState[])
    for (const to of Object.keys(allowed) as NativeWorkflowState[]) {
      const change = () =>
        transitionNativeLifecycle({ version: 1, state: from, attempt: 0, attemptId: "w:attempt:0" }, to, {
          ...evidence,
          blocker: "failure"
        })
      if (from === to || allowed[from].includes(to)) expect(change).not.toThrow()
      else expect(change).toThrow(/Illegal/)
    }
})
it("rejects a stale writer across SQLite connections without losing the winner or appending its event", () => {
  const { a, b } = stores()
  a.put("workflow", "w", { count: 0 })
  const first = a.get<any>("workflow", "w"),
    stale = b.get<any>("workflow", "w")
  first.count = 1
  a.put("workflow", "w", first)
  stale.count = 2
  expect(() => b.put("workflow", "w", stale)).toThrow(NativeRevisionConflict)
  expect(a.get<any>("workflow", "w").count).toBe(1)
  expect(a.db.prepare("SELECT count(*) AS n FROM native_events").get()?.n).toBe(2)
})
it("rolls back state, revision and intent if the audit event cannot commit", () => {
  const { a } = stores()
  a.db.exec("CREATE TRIGGER fail_event BEFORE INSERT ON native_events BEGIN SELECT RAISE(ABORT,'injected crash'); END")
  expect(() =>
    a.commit(
      [
        { kind: "workflow", id: "w", value: {}, expectedVersion: 0 },
        { kind: "effect-intent", id: "card:w", value: { state: "pending" }, expectedVersion: 0 }
      ],
      { kind: "created", subject: "w", value: {} }
    )
  ).toThrow(/injected/)
  expect(a.get("workflow", "w")).toBeNull()
  expect(a.get("effect-intent", "card:w")).toBeNull()
  expect(a.version("workflow", "w")).toBe(0)
})
it("rejects lifecycle removal and forged attempt identifiers at the persistence boundary", () => {
  const { a } = stores()
  const value: any = { lifecycle: upgradeNativeLifecycle("w", {}) }
  a.put("workflow", "w", value)
  delete value.lifecycle
  expect(() => a.put("workflow", "w", value)).toThrow(/remove/)
  value.lifecycle = { ...upgradeNativeLifecycle("w", {}), attemptId: "forged" }
  expect(() => a.put("workflow", "w", value)).toThrow(/attempt transition/)
})
it("replays an accepted card with a lost response using its durable correlation key", async () => {
  const { a } = stores()
  const cards = new Map<string, any>()
  let lost = true
  const runtime = new NativeAutonomyRuntime(
    { enabled: true } as any,
    {
      request: async (_method, input) => {
        const key = String(input.idempotencyKey)
        if (!cards.has(key)) cards.set(key, { id: "remote-card", title: "work", status: "blocked" })
        if (lost) {
          lost = false
          throw new Error("response lost")
        }
        return { card: cards.get(key) } as any
      }
    },
    a
  )
  const input = { title: "work", status: "blocked", idempotencyKey: "stable" }
  await expect(runtime.createCard(input)).rejects.toThrow(/lost/)
  expect(a.get<any>("effect-intent", "card:stable").state).toBe("pending")
  expect((await runtime.createCard(input)).id).toBe("remote-card")
  expect(cards.size).toBe(1)
  expect(a.get<any>("effect-intent", "card:stable").state).toBe("confirmed")
})

it("fences mutations against every enclosing lease during nested recovery", async () => {
  const { a, b } = stores()
  const outer = a.acquire("reconcile", 120_000)!,
    inner = a.acquire("admission", 120_000)!
  await expect(
    a.withLease(outer, 120_000, () =>
      a.withLease(inner, 120_000, async () => {
        a.db.prepare("UPDATE native_locks SET expires_at=0 WHERE id='reconcile'").run()
        expect(b.acquire("reconcile", 120_000)).not.toBeNull()
        expect(() => a.put("operation", "forbidden", {})).toThrow(/lease/)
      })
    )
  ).rejects.toThrow(/lease/)
  expect(a.get("operation", "forbidden")).toBeNull()
})
it("rejects receipts from another attempt even when the commit is identical", () => {
  const lifecycle = upgradeNativeLifecycle("w", { candidate: evidence.candidate! })
  expect(() =>
    transitionNativeLifecycle(lifecycle, "review", {
      ...evidence,
      verification: { ...evidence.verification!, provenance: { attemptId: "w:attempt:9" } }
    })
  ).toThrow(/another attempt/)
  expect(() =>
    transitionNativeLifecycle(lifecycle, "review", {
      ...evidence,
      review: { ...evidence.review!, attemptId: "w:attempt:9" }
    })
  ).toThrow(/another attempt/)
})
