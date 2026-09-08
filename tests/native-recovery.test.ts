/** Operator recovery is planned, revision-bound and never a second scheduler. */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { NativeAutonomyRuntime, type NativeWorkflow } from "../packages/core-runtime/src/native/runtime.js"
import { NativeEvidenceStore } from "../packages/core-runtime/src/native/store.js"
import { upgradeNativeLifecycle } from "../packages/domain/src/native-lifecycle.js"

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})
function setup() {
  const root = mkdtempSync(join(tmpdir(), "native-recovery-"))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const store = new NativeEvidenceStore(join(root, "evidence.db"))
  cleanups.push(() => store.close())
  const cards: any[] = [
    { id: "root", title: "Task", status: "blocked" },
    { id: "implementation", title: "Implement", status: "blocked" }
  ]
  const requests: string[] = []
  const runtime = new NativeAutonomyRuntime(
    { enabled: false, boardId: "board", repository: root, baseBranch: "main", coderAgentId: "coder" } as any,
    {
      request: async (method, params) => {
        requests.push(method)
        if (method === "workboard.cards.list") return { cards } as any
        if (method === "workboard.cards.create") {
          let card = cards.find((card) => card.key === params.idempotencyKey)
          if (!card) {
            card = {
              id: `card-${cards.length}`,
              title: params.title,
              status: params.status,
              key: params.idempotencyKey
            }
            cards.push(card)
          }
          return { card } as any
        }
        throw new Error(`Unexpected effect ${method}`)
      }
    },
    store
  )
  const workflow: NativeWorkflow = {
    proposal: {
      title: "Task",
      allowedPaths: ["src"],
      acceptance: ["works"],
      implementationPrompt: "Fix the issue"
    } as any,
    rootCardId: "root",
    implementationCardId: "implementation",
    stageCards: {},
    blocker: "Verification infrastructure unavailable",
    lifecycle: upgradeNativeLifecycle("workflow", { blocker: "Verification infrastructure unavailable" })
  }
  store.put("workflow", "workflow", workflow)
  return { store, runtime, cards, workflow, requests }
}
it("explains state and produces a deterministic plan without writing records or events", async () => {
  const s = setup()
  const before = s.store.db.prepare("SELECT count(*) AS n FROM native_events").get()?.n
  const first = await s.runtime.planWorkflowRecovery("workflow", "retry", "Retry repaired verifier")
  expect(await s.runtime.planWorkflowRecovery("workflow", "retry", "Retry repaired verifier")).toEqual(first)
  expect((await s.runtime.explainWorkflow("workflow")).lifecycle.state).toBe("blocked")
  expect(s.store.db.prepare("SELECT count(*) AS n FROM native_events").get()?.n).toBe(before)
  expect(s.requests.every((request) => request === "workboard.cards.list")).toBe(true)
})
it.each(["running", "ready", "scheduled", "review"])("refuses recovery while owned card is %s", async (status) => {
  const s = setup()
  s.cards[1].status = status
  const plan = await s.runtime.planWorkflowRecovery("workflow", "cancel", "Stop work")
  expect(plan.allowed).toBe(false)
  await expect(s.runtime.applyWorkflowRecovery(plan, "operator")).rejects.toThrow(/owned Workboard/)
  expect(s.store.get<any>("workflow", "workflow").lifecycle.state).toBe("blocked")
})
it("refuses unknown remote outcomes without deleting or replaying the operation", async () => {
  const s = setup()
  s.store.put("operation", "workflow:deploy", { state: "started" })
  const plan = await s.runtime.planWorkflowRecovery("workflow", "retry", "Retry deployment")
  expect(plan.allowed).toBe(false)
  await expect(s.runtime.applyWorkflowRecovery(plan, "operator")).rejects.toThrow(/uncertain/)
  expect(s.store.get<any>("operation", "workflow:deploy").state).toBe("started")
  expect(s.requests.every((request) => request === "workboard.cards.list")).toBe(true)
})
it.each(["workflow", "control", "card", "plan"])("rejects a stale or edited %s", async (change) => {
  const s = setup(),
    plan = await s.runtime.planWorkflowRecovery("workflow", "cancel", "Cancel obsolete task")
  if (change === "workflow") {
    const w = s.store.get<any>("workflow", "workflow")
    w.blocker = "Changed"
    s.store.put("workflow", "workflow", w)
  }
  if (change === "control") s.runtime.control.change(true)
  if (change === "card") s.cards[1].updatedAt = 1
  if (change === "plan") plan.reason = "Edited"
  await expect(s.runtime.applyWorkflowRecovery(plan, "operator")).rejects.toThrow(/stale|edited/)
})
it("safely cancels, releases scope, archives and preserves the full original evidence", async () => {
  const s = setup(),
    plan = await s.runtime.planWorkflowRecovery("workflow", "cancel", "No longer needed")
  const result = await s.runtime.applyWorkflowRecovery(plan, "operator-a")
  expect(await s.runtime.applyWorkflowRecovery(plan, "operator-a")).toEqual(result)
  const cancelled = s.store.get<NativeWorkflow>("workflow", "workflow")!
  expect(cancelled.lifecycle?.state).toBe("cancelled")
  expect(cancelled.recovery?.operator).toBe("operator-a")
  expect(s.runtime.reservesScope(cancelled)).toBe(false)
  expect(s.store.list("attempt-history")).toHaveLength(1)
  const archive = await s.runtime.planWorkflowRecovery("workflow", "archive", "Archive cancelled task")
  await s.runtime.applyWorkflowRecovery(archive, "operator-a")
  expect(s.store.get<any>("workflow", "workflow").archivedAt).toEqual(expect.any(String))
  expect(s.requests.some((request) => request !== "workboard.cards.list")).toBe(false)
})
it("retries with a new blocked card and attempt while retaining history and requiring fresh authority", async () => {
  const s = setup(),
    plan = await s.runtime.planWorkflowRecovery("workflow", "retry", "Infrastructure repaired")
  await s.runtime.applyWorkflowRecovery(plan, "operator-a")
  const retried = s.store.get<NativeWorkflow>("workflow", "workflow")!
  expect(retried.lifecycle?.attemptId).toBe("workflow:attempt:1")
  expect(retried.lifecycle?.state).toBe("implementation")
  expect(retried.blocker).toBeUndefined()
  expect(retried.candidate).toBeUndefined()
  expect(retried.review).toBeUndefined()
  expect(s.cards.find((card) => card.id === retried.implementationCardId).status).toBe("blocked")
  expect(s.store.get<any>("admission", "workflow").phase).toBe("prepared")
  expect(s.requests).not.toContain("workboard.cards.dispatchWithOptions")
  await s.runtime.applyWorkflowRecovery(plan, "operator-a")
  expect(s.cards).toHaveLength(3)
})
it("records explicit supersession and binds the successor revision", async () => {
  const s = setup()
  const successor = {
    ...s.workflow,
    rootCardId: "next-root",
    implementationCardId: "next-implementation",
    lifecycle: upgradeNativeLifecycle("next", { blocker: "pending" })
  }
  s.store.put("workflow", "next", successor)
  const plan = await s.runtime.planWorkflowRecovery("workflow", "supersede", "Replaced by next", "next")
  expect(plan.allowed).toBe(true)
  await s.runtime.applyWorkflowRecovery(plan, "operator")
  expect(s.store.get<any>("workflow", "workflow").recovery.supersededBy).toBe("next")
})
it("rejects recovery after the control changes during blocked-card creation", async () => {
  const s = setup(),
    plan = await s.runtime.planWorkflowRecovery("workflow", "retry", "Repair infrastructure")
  const original = s.runtime.createCard.bind(s.runtime)
  s.runtime.createCard = async (...args) => {
    const card = await original(...args)
    s.runtime.control.change(true)
    return card
  }
  await expect(s.runtime.applyWorkflowRecovery(plan, "operator")).rejects.toThrow(/changed/)
  expect(s.store.get<any>("workflow", "workflow").lifecycle.state).toBe("blocked")
  expect(s.store.get<any>("recovery", plan.digest).state).toBe("prepared")
  expect(s.cards[2].status).toBe("blocked")
})

it("freezes only exact owned running sessions without pretending accepted abort is termination", async () => {
  const s = setup()
  s.cards[1] = { ...s.cards[1], status: "running", agentId: "coder", sessionKey: "owned-session", runId: "owned-run" }
  s.cards.push({ id: "unrelated", title: "Other", status: "running", agentId: "coder", sessionKey: "other-session" })
  const aborts: unknown[] = []
  const request = s.runtime.gateway.request.bind(s.runtime.gateway)
  s.runtime.gateway.request = async (method, params) => {
    if (method === "sessions.abort") {
      aborts.push(params)
      return {} as any
    }
    return request(method, params)
  }
  const result = await s.runtime.freeze()
  expect(aborts).toEqual([{ key: "owned-session", agentId: "coder", runId: "owned-run" }])
  expect(result.requested).toEqual(["implementation"])
  expect(result.frozen).toBe(true)
  expect(s.cards[1].status).toBe("running")
  expect(s.store.get<any>("workflow", "workflow").blocker).toBeTruthy()
})

it.each([
  "blocked",
  "done"
])("recovers an operator-disposed %s card while preserving its ended review association", async (status) => {
  const s = setup()
  s.cards[1].status = status
  s.cards[1].execution = { status: "review", sessionKey: "ended-session", runId: "ended-run" }
  const original = structuredClone(s.cards[1])
  const plan = await s.runtime.planWorkflowRecovery("workflow", "retry", "Operator disposed the ended attempt")
  expect(plan.allowed).toBe(true)
  await s.runtime.applyWorkflowRecovery(plan, "operator")
  expect(s.cards[1]).toEqual(original)
  expect(s.store.list("attempt-history")).toHaveLength(1)
  expect(s.runtime.requireWorkflow("workflow").implementationCardId).not.toBe(original.id)
})
it.each(["pending", "running"])("refuses recovery with a %s execution even if the card is blocked", async (status) => {
  const s = setup()
  s.cards[1].execution = { status }
  const plan = await s.runtime.planWorkflowRecovery("workflow", "retry", "Must wait for the owner")
  expect(plan.allowed).toBe(false)
  await expect(s.runtime.applyWorkflowRecovery(plan, "operator")).rejects.toThrow(/owned Workboard/)
})
