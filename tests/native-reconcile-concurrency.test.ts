/** Reconciliation fairness and cross-process capacity do not own Workboard execution. */
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
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "native-reconcile-concurrency-"))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, "evidence.db"),
    store = new NativeEvidenceStore(path),
    other = new NativeEvidenceStore(path)
  cleanup.push(
    () => store.close(),
    () => other.close()
  )
  const policy = {
    enabled: true,
    mode: "implement-human-review",
    workerConcurrency: 1,
    boardId: "board",
    repository: root,
    repositoryKind: "framework"
  } as any
  const gateway = { request: async () => ({ cards: [] }) as any }
  const runtime = new NativeAutonomyRuntime(policy, gateway, store),
    second = new NativeAutonomyRuntime(policy, gateway, other)
  const seed = (id: string) =>
    store.put("workflow", id, {
      proposal: { title: id, allowedPaths: [id] },
      rootCardId: `${id}:root`,
      implementationCardId: `${id}:implementation`,
      stageCards: {},
      candidate: { headSha: id }
    })
  return { store, other, runtime, second, seed, gateway }
}
it("lets an independent workflow progress while the first step remains pending and releases the board lease", async () => {
  const s = fixture()
  s.seed("a")
  s.seed("b")
  let resume!: () => void
  const gate = new Promise<void>((done) => {
    resume = done
  })
  const completed: string[] = []
  s.runtime.advanceWorkflowStep = vi.fn(async (id) => {
    if (id === "a") await gate
    completed.push(id)
    return 1
  })
  const first = s.runtime.reconcile()
  await vi.waitFor(() => expect(completed).toContain("b"))
  const board = s.other.acquire("reconcile", 120_000)
  expect(board).not.toBeNull()
  s.other.release(board!)
  expect(s.other.acquire("workflow:a", 120_000)).toBeNull()
  resume()
  expect(await first).toEqual({ advanced: 2 })
  expect(completed).toEqual(["b", "a"])
})
it("rotates a bounded decision set so later workflows are not starved", async () => {
  const s = fixture()
  for (const id of ["a", "b", "c", "d", "e"]) s.seed(id)
  const progressed: string[] = []
  s.runtime.advanceWorkflowStep = async (id) => {
    progressed.push(id)
    return 0
  }
  await s.runtime.reconcile()
  expect(progressed).toEqual(["a", "b"])
  await s.runtime.reconcile()
  expect(progressed).toEqual(["a", "b", "c", "d"])
  await s.runtime.reconcile()
  expect(progressed).toContain("e")
})
it("enforces renewable verification capacity across two connections without blocking release capacity", async () => {
  const s = fixture()
  let resume!: () => void
  const gate = new Promise<void>((done) => {
    resume = done
  })
  const first = s.runtime.withCapacity("verification", 1, async () => {
    await gate
    return "verified"
  })
  expect(await s.second.withCapacity("verification", 1, async () => "duplicate")).toBeNull()
  expect(await s.second.withCapacity("release", 1, async () => "independent")).toBe("independent")
  resume()
  expect(await first).toBe("verified")
  expect(await s.second.withCapacity("verification", 1, async () => "next")).toBe("next")
})
it("refuses concurrent submit/review/recovery ownership of a workflow", async () => {
  const s = fixture()
  await s.runtime.withWorkflowLease("a", async () => {
    await expect(s.second.withWorkflowLease("a", async () => "stale")).rejects.toThrow(/advancing/)
    expect(await s.runtime.withWorkflowLease("a", async () => "nested")).toBe("nested")
  })
  expect(await s.second.withWorkflowLease("a", async () => "fresh")).toBe("fresh")
})

it.each([
  "review",
  "failed",
  "blocked",
  "done",
  "running"
])("observes %s implementation without a submission while paused", async (status) => {
  const s = fixture()
  s.seed("ended")
  const workflow = s.store.get<any>("workflow", "ended")
  delete workflow.candidate
  s.store.put("workflow", "ended", workflow)
  s.runtime.control.change(true)
  s.gateway.request = async () =>
    ({
      cards: [
        {
          id: "ended:implementation",
          title: "Ended implementation",
          status: status === "running" ? "running" : "blocked",
          execution: { id: "execution", status }
        }
      ]
    }) as any
  await s.runtime.reconcile()
  const observed = s.store.get<any>("workflow", "ended")
  expect(Boolean(observed.blocker)).toBe(status !== "running")
  if (status !== "running") expect(observed.lifecycle.state).toBe("blocked")
  expect(observed.candidate).toBeUndefined()
})

it("dispatches from a second connection while verification owns its workflow without advancing gates or cursor", async () => {
  const s = fixture()
  s.seed("a")
  const request = vi.spyOn(s.gateway, "request")
  let resume!: () => void
  const gate = new Promise<void>((done) => {
    resume = done
  })
  const firstStep = vi.spyOn(s.runtime, "advanceWorkflowStep").mockImplementation(async () => {
    await gate
    return 1
  })
  const duplicateStep = vi.spyOn(s.second, "advanceWorkflowStep")
  const first = s.runtime.reconcile()
  try {
    await vi.waitFor(() => expect(firstStep).toHaveBeenCalledTimes(1))
    const cursor = s.store.get("reconcile-cursor", "board")
    request.mockClear()
    expect(await s.second.reconcile({ dispatchOnly: true })).toEqual({ advanced: 0 })
    expect(request).toHaveBeenCalledWith("workboard.cards.dispatchWithOptions", { boardId: "board", maxStarts: 1 })
    expect(duplicateStep).not.toHaveBeenCalled()
    expect(s.other.acquire("workflow:a", 120_000)).toBeNull()
    expect(s.store.get("reconcile-cursor", "board")).toEqual(cursor)
  } finally {
    resume()
    await first
  }
})

it("keeps dispatch-only reconciliation paused and never advances candidate gates", async () => {
  const s = fixture()
  s.seed("a")
  s.runtime.control.change(true)
  const request = vi.spyOn(s.gateway, "request")
  const advance = vi.spyOn(s.runtime, "advanceWorkflowStep")
  expect(await s.runtime.reconcile({ dispatchOnly: true })).toEqual({ advanced: 0, paused: true })
  expect(request).not.toHaveBeenCalledWith("workboard.cards.dispatchWithOptions", expect.anything())
  expect(advance).not.toHaveBeenCalled()
  expect(s.store.get("reconcile-cursor", "board")).toBeNull()
})

it.each([
  false,
  true
])("reports native dispatch starts and capacity deferrals without advancing workflows: %s", async (deferred) => {
  const s = fixture()
  s.gateway.request = (async (method: string) =>
    method === "workboard.cards.dispatchWithOptions"
      ? {
          started: [{ privatePath: "/host/private" }],
          startedCardIds: ["research"],
          deferred: deferred ? [{ cardId: "coder-card", reason: "worktree-capacity", message: "/host/private" }] : []
        }
      : { cards: [] }) as any
  expect(await s.runtime.reconcile({ dispatchOnly: true })).toEqual({
    advanced: 0,
    dispatch: {
      startedCount: 1,
      startedCardIds: ["research"],
      deferredCount: deferred ? 1 : 0,
      deferred: deferred ? [{ cardId: "coder-card", reason: "worktree-capacity" }] : []
    }
  })
})
it("never exposes unrecognized dispatch diagnostics or unsafe identifiers", async () => {
  const s = fixture()
  s.gateway.request = (async (method: string) =>
    method === "workboard.cards.dispatchWithOptions"
      ? {
          started: [{}],
          startedCardIds: ["/host/private"],
          deferred: [
            { cardId: "valid", reason: "secret diagnostic" },
            { cardId: "/host/private", reason: "worktree-capacity" },
            null
          ]
        }
      : { cards: [] }) as any
  expect(await s.runtime.reconcile({ dispatchOnly: true })).toEqual({
    advanced: 0,
    dispatch: {
      startedCount: 1,
      startedCardIds: [],
      deferredCount: 0,
      deferred: []
    }
  })
})
it("does not dispatch or invent observability while the decision lease is held", async () => {
  const s = fixture(),
    lease = s.other.acquire("reconcile", 120000)!
  const request = vi.spyOn(s.gateway, "request")
  try {
    expect(await s.runtime.reconcile({ dispatchOnly: true })).toEqual({ advanced: 0 })
    expect(request).not.toHaveBeenCalled()
  } finally {
    s.other.release(lease)
  }
})
