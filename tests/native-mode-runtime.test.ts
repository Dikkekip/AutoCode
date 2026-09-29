import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { NativeAutonomyRuntime } from "../packages/core-runtime/src/native/runtime.js"
import { NativeEvidenceStore } from "../packages/core-runtime/src/native/store.js"

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn()
})
function setup(mode = "observe") {
  const root = mkdtempSync(join(tmpdir(), "native-mode-runtime-"))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const store = new NativeEvidenceStore(join(root, "evidence.db"))
  cleanup.push(() => store.close())
  const cards: any[] = []
  const gateway = { request: vi.fn(async () => ({ cards }) as any) }
  const policy: any = {
    enabled: true,
    mode,
    repository: root,
    boardId: "board",
    workerConcurrency: 1,
    coderAgentId: "coder",
    reviewerAgentId: "reviewer",
    plannerAgentId: "planner",
    personas: []
  }
  const runtime = new NativeAutonomyRuntime(policy, gateway, store)
  return { runtime, policy, cards, gateway, store }
}
it("observe can reconcile empty evidence but cannot discover or activate workers", async () => {
  const s = setup()
  await expect(s.runtime.discover()).rejects.toThrow(/does not authorize/)
  await expect(s.runtime.reconcile()).resolves.toEqual({ advanced: 0 })
  expect(s.gateway.request.mock.calls).toHaveLength(0)
})
it("propose refuses board dispatch containing implementation work", async () => {
  const s = setup("propose")
  s.cards.push({ id: "coder-card", title: "Implement", status: "ready", agentId: "coder" })
  await expect(s.runtime.reconcile()).rejects.toThrow(/does not authorize implement/)
  expect(s.gateway.request.mock.calls.some((call: any) => call[0] === "workboard.cards.dispatchWithOptions")).toBe(
    false
  )
})
it("unknown capped worker cost denies dispatch before execution; stable reservations do not double charge", async () => {
  const s = setup("implement-human-review")
  s.policy.budgets = {
    version: 1,
    limits: { project: { actions: 2 }, day: { actions: 2 }, workflow: { actions: 2 }, attempt: { actions: 2 } },
    safetyReserve: {},
    unknownUsage: "hold",
    estimates: {}
  }
  s.cards.push({ id: "coder-card", title: "Implement", status: "ready", agentId: "coder" })
  await expect(s.runtime.reconcile()).rejects.toThrow(/Unknown actions/)
  expect(s.gateway.request.mock.calls.some((call: any) => call[0] === "workboard.cards.dispatchWithOptions")).toBe(
    false
  )
  s.policy.budgets.estimates.implement = { actions: 1 }
  await s.runtime.reconcile()
  await s.runtime.reconcile()
  expect(s.store.list("budget-reservation")).toHaveLength(1)
  expect(s.store.list<any>("budget-window").every((row) => row.value.reserved.actions === 1)).toBe(true)
})

it("reports native Workboard startup failures instead of hiding allocation errors", async () => {
  const s = setup("implement-human-review")
  s.gateway.request.mockImplementation(async (...args: any[]) =>
    args[0] === "workboard.cards.dispatchWithOptions"
      ? {
          started: [],
          startFailures: [{ cardId: "worker-card", error: "Insufficient disk space for worktree allocation" }]
        }
      : ({ cards: s.cards } as any)
  )
  await expect(s.runtime.reconcile({ dispatchOnly: true })).resolves.toEqual({
    advanced: 0,
    dispatch: {
      startedCount: 0,
      startedCardIds: [],
      deferredCount: 0,
      deferred: [],
      failedCount: 1,
      failures: [{ cardId: "worker-card", error: "Insufficient disk space for worktree allocation" }]
    }
  })
})

it("validates startup failure attribution and redacts private error details", async () => {
  const s = setup("implement-human-review")
  s.gateway.request.mockImplementation(async (...args: any[]) =>
    args[0] === "workboard.cards.dispatchWithOptions"
      ? {
          started: [],
          startFailures: [
            { cardId: "worker-card", error: "Authorization: Bearer private-start-token" },
            { cardId: "invalid/card", error: "invalid attribution" },
            { cardId: "other-card", error: { message: "unsupported payload" } }
          ]
        }
      : ({ cards: s.cards } as any)
  )
  const result = await s.runtime.reconcile({ dispatchOnly: true })
  expect(result.dispatch?.failedCount).toBe(1)
  expect(result.dispatch?.failures?.[0]?.cardId).toBe("worker-card")
  expect(JSON.stringify(result)).not.toContain("private-start-token")
})
