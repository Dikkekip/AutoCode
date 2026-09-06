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
  return { store, other, runtime, second, seed }
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
