import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { type NativeGateway, nativeCardIdempotencyKey } from "../packages/core-runtime/src/native/gateway.js"
import {
  nativeRepairSupersessionClosed,
  supersedeLegacyNativeRepairIntent
} from "../packages/core-runtime/src/native/repair-intent.js"
import { NativeEvidenceStore } from "../packages/core-runtime/src/native/store.js"

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn()
})
function setup() {
  const root = mkdtempSync(join(tmpdir(), "native-repair-intent-"))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const store = new NativeEvidenceStore(join(root, "evidence.db"))
  cleanup.push(() => store.close())
  const legacy = {
    idempotencyKey: "workflow:w:repair:8",
    title: "Repair 1: Task",
    workspace: { kind: "dir", path: "/old-host" },
    notes: "original"
  }
  const input = {
    ...legacy,
    idempotencyKey: "workflow:w:repair:8:managed-source-v1",
    workspace: { kind: "worktree", sourcePath: "/repo", sourceBranch: "origin/main" },
    notes: "immutable evidence"
  }
  const id = `card:${legacy.idempotencyKey}`
  store.put("effect-intent", id, { state: "pending", input: legacy })
  const run = (gateway: NativeGateway, guard = () => {}) =>
    store.withLease(store.acquire("workflow:w", 30000)!, 30000, () =>
      supersedeLegacyNativeRepairIntent(store, gateway, "w", legacy, input, guard)
    )
  return { store, legacy, input, id, run }
}
it("preserves exact legacy custody and atomically links a replacement without fabricated acceptance", async () => {
  const s = setup()
  const before = s.store.get("effect-intent", s.id)
  const writes = await s.run({
    request: async (method, params) => {
      expect(method).toBe("workboard.cards.list")
      expect(params).toEqual({})
      return { cards: [] } as any
    }
  })
  expect(s.store.get("effect-intent", s.id)).toEqual(before)
  s.store.commit(writes, { kind: "fixture.superseded", subject: s.id, value: {} })
  expect(s.store.get<any>("effect-intent", s.id)).toMatchObject({
    state: "superseded",
    input: s.legacy,
    replacementInput: s.input
  })
  expect(s.store.get<any>("effect-intent", s.id).card).toBeUndefined()
  expect(nativeRepairSupersessionClosed(s.store, s.id)).toBe(false)
  s.store.put("effect-intent", `card:${s.input.idempotencyKey}`, { state: "pending", input: s.input })
  expect(nativeRepairSupersessionClosed(s.store, s.id)).toBe(false)
  s.store.put("effect-intent", `card:${s.input.idempotencyKey}`, {
    state: "confirmed",
    input: s.input,
    card: { id: "replacement", title: s.input.title, status: "blocked" }
  })
  expect(nativeRepairSupersessionClosed(s.store, s.id)).toBe(true)
  expect(s.store.get<any>("effect-intent", s.id).state).toBe("superseded")
  s.store.put("effect-intent", `card:${s.input.idempotencyKey}`, {
    state: "confirmed",
    input: { ...s.input, notes: "changed" },
    card: { id: "replacement" }
  })
  expect(nativeRepairSupersessionClosed(s.store, s.id)).toBe(false)
})
it.each([
  "blocked",
  "running",
  "done"
])("refuses an accepted old card including archived %s custody", async (status) => {
  const s = setup()
  const before = s.store.get("effect-intent", s.id)
  await expect(
    s.run({
      request: async () =>
        ({
          cards: [
            {
              id: "accepted",
              title: s.legacy.title,
              status,
              metadata: {
                archivedAt: 1,
                automation: { idempotencyKey: nativeCardIdempotencyKey(s.legacy.idempotencyKey) }
              }
            }
          ]
        }) as any
    })
  ).rejects.toThrow("accepted or uncertain")
  expect(s.store.get("effect-intent", s.id)).toEqual(before)
})
it.each([
  { cards: [], hasMore: true },
  { cards: [], nextCursor: "more" },
  { cards: [], totalCount: 1 },
  {}
])("refuses incomplete or unknown remote lookup %j", async (result) => {
  const s = setup()
  await expect(s.run({ request: async () => result as any })).rejects.toThrow("complete all-card")
  expect(s.store.get<any>("effect-intent", s.id).state).toBe("pending")
})
it("refuses changed pending custody across the awaited absence check", async () => {
  const s = setup()
  await expect(
    s.run({
      request: async () => {
        s.store.put("effect-intent", s.id, { state: "pending", input: { ...s.legacy, notes: "changed" } })
        return { cards: [] } as any
      }
    })
  ).rejects.toThrow("changed during absence")
})
it("refuses revoked admission before any supersession", async () => {
  const s = setup()
  let current = true
  await expect(
    s.run(
      {
        request: async () => {
          current = false
          return { cards: [] } as any
        }
      },
      () => {
        if (!current) throw new Error("admission closed")
      }
    )
  ).rejects.toThrow("admission closed")
  expect(s.store.get<any>("effect-intent", s.id).state).toBe("pending")
})
