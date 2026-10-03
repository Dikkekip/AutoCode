/** Operator recovery is planned, revision-bound and never a second scheduler. */
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { NativeAutonomyRuntime, type NativeWorkflow } from "../packages/core-runtime/src/native/runtime.js"
import { NativeEvidenceStore } from "../packages/core-runtime/src/native/store.js"
import { transitionNativeLifecycle, upgradeNativeLifecycle } from "../packages/domain/src/native-lifecycle.js"

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})
function setup(candidate?: NativeWorkflow["candidate"], initialAttempt = 0) {
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
              key: params.idempotencyKey,
              metadata: { automation: { idempotencyKey: params.idempotencyKey } }
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
    ...(candidate ? { candidate } : {}),
    rootCardId: "root",
    implementationCardId: "implementation",
    stageCards: {},
    blocker: "Verification infrastructure unavailable",
    lifecycle: upgradeNativeLifecycle("workflow", {
      blocker: "Verification infrastructure unavailable",
      repairCount: initialAttempt
    })
  }
  store.put("workflow", "workflow", workflow)
  return { store, runtime, cards, workflow, requests }
}
async function pendingRecovery() {
  const s = setup(undefined, 5)
  s.runtime.policy.enabled = true
  s.runtime.control.change(true)
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: s.runtime.policy.repository,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"]
    }).trim()
  git("init")
  git("config", "user.name", "Fixture")
  git("config", "user.email", "fixture@example.invalid")
  mkdirSync(join(s.runtime.policy.repository, "src"))
  writeFileSync(join(s.runtime.policy.repository, "src/fix.ts"), "before")
  git("add", "src")
  git("commit", "-m", "base")
  const baseSha = git("rev-parse", "HEAD")
  writeFileSync(join(s.runtime.policy.repository, "src/fix.ts"), "after")
  git("add", "src")
  git("commit", "-m", "candidate")
  s.workflow.candidate = {
    cwd: "/retired/candidate",
    baseSha,
    headSha: git("rev-parse", "HEAD"),
    files: ["src/fix.ts"],
    branch: "preserved"
  }
  s.workflow.lifecycle = transitionNativeLifecycle(s.workflow.lifecycle!, "blocked", s.workflow)
  s.store.put("workflow", "workflow", s.workflow)
  const request = s.runtime.gateway.request.bind(s.runtime.gateway)
  s.runtime.gateway.request = async (method, params) => {
    if (method === "workboard.cards.create") throw new Error("Workspace source outside caller grant")
    return request(method, params)
  }
  const reason = "Recover preserved candidate after repairing admission"
  const original = await s.runtime.planWorkflowRecovery("workflow", "retry", reason)
  await expect(s.runtime.applyWorkflowRecovery(original, "operator")).rejects.toThrow(/outside caller/)
  s.runtime.gateway.request = request
  s.runtime.control.change(false)
  s.runtime.control.change(true)
  const plan = await s.runtime.planWorkflowRecovery("workflow", "retry", reason)
  const intentId = "card:recovery:workflow:attempt:6"
  const pending = s.store.get<any>("effect-intent", intentId)
  const archiveId = JSON.parse(pending.input.notes).previousCandidate.archiveRecordId as string
  return { ...s, request, original, plan, intentId, pending, archiveId }
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
it("replays a long card key after a lost response without changing its journal or duplicating the remote card", async () => {
  const s = setup()
  const input = {
    boardId: "board",
    title: "Verify",
    status: "blocked",
    notes: "Independent verification",
    idempotencyKey: `workflow:${"a".repeat(64)}:Verify:${"b".repeat(40)}:${"a".repeat(64)}:attempt:4:${"c".repeat(64)}`
  }
  const request = s.runtime.gateway.request.bind(s.runtime.gateway)
  let loseResponse = true
  s.runtime.gateway.request = async (method, params) => {
    if (method === "workboard.cards.create" && String(params.idempotencyKey).length > 160)
      throw new Error("Workboard key exceeds 160 characters")
    const result = await request(method, params)
    if (method === "workboard.cards.create" && loseResponse) {
      loseResponse = false
      throw new Error("Response lost after remote creation")
    }
    return result
  }
  await expect(s.runtime.createCard(input)).rejects.toThrow(/Response lost/)
  const journalId = `card:${input.idempotencyKey}`
  expect(s.store.get<any>("effect-intent", journalId)).toMatchObject({ input, state: "pending" })
  const created = await s.runtime.createCard(input)
  expect(s.store.get<any>("effect-intent", journalId)).toMatchObject({ input, card: created, state: "confirmed" })
  expect(await s.runtime.createCard(input)).toEqual(created)
  expect(s.cards).toHaveLength(3)
  expect(s.cards[2].key.length).toBeLessThanOrEqual(160)
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
it("gives an operator retry two repairs without reusing historical cards or evidence", async () => {
  const s = setup(undefined, 5)
  s.workflow.repairCount = 2
  s.store.put("workflow", "workflow", s.workflow)
  const oldEvidence = { reason: "Prior interrupted repair without a candidate" }
  s.store.put("attempt-evidence", "workflow:1", oldEvidence)
  s.cards.push({ id: "old-repair", title: "Prior repair", status: "done", key: "workflow:workflow:repair:1" })
  const plan = await s.runtime.planWorkflowRecovery("workflow", "retry", "Operator repaired the infrastructure")
  await s.runtime.applyWorkflowRecovery(plan, "operator")
  const retried = s.runtime.requireWorkflow("workflow")
  expect(retried.lifecycle?.attempt).toBe(6)
  expect(retried.repairCount).toBe(0)
  expect(s.store.list<any>("attempt-history")[0]!.value.repairCount).toBe(2)
  s.runtime.policy.enabled = true
  s.runtime.policy.mode = "implement-human-review"
  s.runtime.control.change(false)
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: s.runtime.policy.repository, encoding: "utf8" }).trim()
  git("init", "-b", "main")
  git("config", "user.name", "Fixture")
  git("config", "user.email", "fixture@example.invalid")
  mkdirSync(join(s.runtime.policy.repository, "src"), { recursive: true })
  writeFileSync(join(s.runtime.policy.repository, "src/fix.ts"), "baseline\n")
  git("add", "src/fix.ts")
  git("commit", "-m", "baseline")
  const baseSha = git("rev-parse", "HEAD")
  const heads: string[] = []
  for (const value of ["first", "second"]) {
    writeFileSync(join(s.runtime.policy.repository, "src/fix.ts"), value + "\n")
    git("add", "src/fix.ts")
    git("commit", "-m", value)
    heads.push(git("rev-parse", "HEAD"))
  }
  const candidate = {
    cwd: s.runtime.policy.repository,
    headSha: heads[0]!,
    baseSha,
    files: ["src/fix.ts"],
    branch: "candidate"
  }
  for (const attempt of [7, 8]) {
    const repairedCandidate = { ...candidate, headSha: heads[attempt - 7]! }
    retried.candidate = repairedCandidate
    await s.runtime.requestRepair("workflow", retried, "Add the missing acceptance assertion")
    expect(retried.lifecycle?.attempt).toBe(attempt)
    expect(retried.repairCount).toBe(attempt - 6)
    expect(s.cards.find((card) => card.id === retried.implementationCardId).key).toBe(
      `workflow:workflow:repair:${attempt}:managed-source-v1`
    )
    expect(s.store.get<any>("attempt-evidence", `workflow:${attempt}`).candidate).toEqual(repairedCandidate)
  }
  retried.candidate = candidate
  await expect(s.runtime.requestRepair("workflow", retried, "Still failing")).rejects.toThrow(/budget exhausted/)
  expect(s.store.get("attempt-evidence", "workflow:1")).toEqual(oldEvidence)
  expect(s.cards.find((card) => card.id === "old-repair").status).toBe("done")
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

it("reconciles an unaccepted recovery card intent after a fresh plan without rewriting its candidate evidence", async () => {
  const s = setup(undefined, 5)
  s.runtime.policy.enabled = true
  s.runtime.control.change(true)
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: s.runtime.policy.repository,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"]
    }).trim()
  git("init")
  git("config", "user.name", "Fixture")
  git("config", "user.email", "fixture@example.invalid")
  mkdirSync(join(s.runtime.policy.repository, "src"))
  writeFileSync(join(s.runtime.policy.repository, "src/fix.ts"), "before")
  git("add", "src")
  git("commit", "-m", "base")
  const baseSha = git("rev-parse", "HEAD")
  writeFileSync(join(s.runtime.policy.repository, "src/fix.ts"), "after")
  git("add", "src")
  git("commit", "-m", "candidate")
  s.workflow.candidate = {
    cwd: "/retired/candidate",
    baseSha,
    headSha: git("rev-parse", "HEAD"),
    files: ["src/fix.ts"],
    branch: "preserved-candidate"
  }
  s.workflow.lifecycle = transitionNativeLifecycle(s.workflow.lifecycle!, "blocked", s.workflow)
  s.store.put("workflow", "workflow", s.workflow)
  const originalWorkflow = s.store.get<NativeWorkflow>("workflow", "workflow")!
  const request = s.runtime.gateway.request.bind(s.runtime.gateway)
  s.runtime.gateway.request = async (method, params) => {
    if (method === "workboard.cards.create") throw new Error("Workspace source outside caller grant")
    return request(method, params)
  }
  const reason = "Recover the preserved commit after workspace admission is repaired"
  const firstPlan = await s.runtime.planWorkflowRecovery("workflow", "retry", reason)
  expect(firstPlan.allowed).toBe(true)
  await expect(s.runtime.applyWorkflowRecovery(firstPlan, "operator")).rejects.toThrow(/outside caller/)
  const intentId = "card:recovery:workflow:attempt:6"
  const pending = s.store.get<any>("effect-intent", intentId)
  const prepared = s.store.get<any>("recovery", firstPlan.digest)
  const notes = JSON.parse(pending.input.notes)
  expect(pending.state).toBe("pending")
  expect(pending.card).toBeUndefined()
  expect(notes.previousCandidate.complete).toBe(true)
  expect(notes.previousCandidate.content).toContain("+after")
  expect(s.store.get("attempt-history", notes.previousCandidate.archiveRecordId)).toBeNull()
  expect(s.store.get("workflow", "workflow")).toEqual(originalWorkflow)
  expect(s.cards).toHaveLength(2)

  s.runtime.control.change(false)
  s.runtime.control.change(true)
  const freshPlan = await s.runtime.planWorkflowRecovery("workflow", "retry", reason)
  expect(freshPlan.allowed).toBe(true)
  expect(freshPlan.digest).not.toBe(firstPlan.digest)
  await expect(s.runtime.applyWorkflowRecovery(firstPlan, "operator")).rejects.toThrow(/stale|edited/)
  s.runtime.gateway.request = request
  await expect(s.runtime.applyWorkflowRecovery(freshPlan, "operator")).resolves.toMatchObject({ applied: true })

  const confirmed = s.store.get<any>("effect-intent", intentId)
  expect(confirmed.state).toBe("confirmed")
  expect(confirmed.input).toEqual(pending.input)
  expect(s.store.get("recovery", firstPlan.digest)).toEqual(prepared)
  expect(s.store.get("attempt-history", notes.previousCandidate.archiveRecordId)).toEqual(originalWorkflow)
  const recovered = s.runtime.requireWorkflow("workflow")
  expect(recovered.lifecycle?.attempt).toBe(6)
  expect(recovered.recovery).toMatchObject({ planDigest: freshPlan.digest, fromAttemptId: "workflow:attempt:5" })
  expect(recovered.recovery?.reconciledIntent).toEqual({ id: intentId, preparedPlanDigest: firstPlan.digest })
  expect(s.cards).toHaveLength(3)
  expect(s.cards.find((card) => card.id === recovered.implementationCardId).status).toBe("blocked")
  expect(s.requests).not.toContain("workboard.cards.dispatchWithOptions")
  await expect(s.runtime.applyWorkflowRecovery(freshPlan, "operator")).resolves.toMatchObject({ applied: true })
  expect(s.cards).toHaveLength(3)
})

it.each([
  "source",
  "agent",
  "reason",
  "candidate",
  "receipt",
  "archive"
])("preserves a pending recovery and rejects changed %s evidence", async (change) => {
  const s = await pendingRecovery()
  if (change === "source") s.pending.input.workspace.sourcePath = "/different/repository"
  if (change === "agent") s.pending.input.agentId = "different-coder"
  if (change === "reason" || change === "candidate") {
    const notes = JSON.parse(s.pending.input.notes)
    if (change === "reason") notes.recoveryReason = "Different task"
    else notes.previousCandidate.content += "\nChanged patch"
    s.pending.input.notes = JSON.stringify(notes)
  }
  if (["source", "agent", "reason", "candidate"].includes(change)) s.store.put("effect-intent", s.intentId, s.pending)
  if (change === "receipt") s.store.put("recovery", s.original.digest, { state: "applied" })
  if (change === "archive") s.store.put("attempt-history", s.archiveId, { unrelated: true })
  const before = s.store.get("effect-intent", s.intentId)
  await expect(s.runtime.applyWorkflowRecovery(s.plan, "operator")).rejects.toThrow(/cannot be reconciled/)
  expect(s.store.get("effect-intent", s.intentId)).toEqual(before)
  expect(s.store.get("workflow", "workflow")).toEqual(s.workflow)
  expect(s.cards).toHaveLength(2)
})

it.each([
  "accepted",
  "uncertain",
  "partial"
])("rejects %s remote custody before pending recovery replay", async (state) => {
  const s = await pendingRecovery()
  s.runtime.gateway.request = async (method, params) => {
    if (method === "workboard.cards.list" && !params.boardId) {
      if (state === "partial") return { cards: [], hasMore: true } as any
      return {
        cards: [
          ...s.cards,
          {
            id: "accepted-elsewhere",
            boardId: "other-board",
            title: s.pending.input.title,
            status: "blocked",
            ...(state === "accepted"
              ? { metadata: { automation: { idempotencyKey: s.pending.input.idempotencyKey } } }
              : {})
          }
        ]
      } as any
    }
    return s.request(method, params)
  }
  await expect(s.runtime.applyWorkflowRecovery(s.plan, "operator")).rejects.toThrow(
    /acceptance is uncertain|complete all-card/
  )
  expect(s.store.get("effect-intent", s.intentId)).toEqual(s.pending)
  expect(s.cards).toHaveLength(2)
})

it.each([
  { hasMore: "false" },
  { hasMore: null },
  { nextOffset: 0 },
  { nextOffset: 2 },
  { totalCount: 3 },
  { totalCount: -1 },
  { totalCount: 2.5 },
  { totalCount: "2" },
  { totalCount: null }
])("rejects an incomplete or invalid advertised card inventory %j", async (advertised) => {
  const s = await pendingRecovery()
  s.runtime.gateway.request = async (method, params) => {
    if (method === "workboard.cards.list" && !params.boardId) return { cards: s.cards, ...advertised } as any
    return s.request(method, params)
  }
  await expect(s.runtime.applyWorkflowRecovery(s.plan, "operator")).rejects.toThrow(/complete all-card/)
  expect(s.store.get("effect-intent", s.intentId)).toEqual(s.pending)
  expect(s.cards).toHaveLength(2)
})

it("accepts a complete advertised all-card inventory", async () => {
  const s = await pendingRecovery()
  s.runtime.gateway.request = async (method, params) => {
    if (method === "workboard.cards.list" && !params.boardId)
      return { cards: s.cards, hasMore: false, nextCursor: null, nextOffset: null, totalCount: s.cards.length } as any
    return s.request(method, params)
  }
  await expect(s.runtime.applyWorkflowRecovery(s.plan, "operator")).resolves.toMatchObject({ applied: true })
  expect(s.cards).toHaveLength(3)
})

it.each([
  "control",
  "intent",
  "receipt",
  "archive",
  "host"
])("rechecks %s authority after the remote absence read yields", async (change) => {
  const s = await pendingRecovery()
  let hostCurrent = true
  s.runtime.gateway.request = async (method, params) => {
    const result = await s.request(method, params)
    if (method === "workboard.cards.list" && !params.boardId) {
      if (change === "control") s.runtime.control.change(true)
      if (change === "intent") s.store.put("effect-intent", s.intentId, s.pending)
      if (change === "receipt") s.store.put("recovery", s.original.digest, s.store.get("recovery", s.original.digest))
      if (change === "archive") s.store.put("attempt-history", s.archiveId, s.workflow)
      if (change === "host") hostCurrent = false
    }
    return result
  }
  await expect(
    s.store.withEffectAuthority(
      () => {
        if (!hostCurrent) throw new Error("Host authority revoked")
      },
      () => s.runtime.applyWorkflowRecovery(s.plan, "operator")
    )
  ).rejects.toThrow(/changed|revoked/)
  expect(s.cards).toHaveLength(2)
  expect(s.store.get("workflow", "workflow")).toEqual(s.workflow)
  expect(s.store.get<any>("effect-intent", s.intentId).state).toBe("pending")
})

it("retains strict generic card intent equality", async () => {
  const s = setup()
  const input = { boardId: "board", title: "Original", status: "blocked", idempotencyKey: "generic-key" }
  s.store.put("effect-intent", "card:generic-key", { state: "pending", input })
  await expect(s.runtime.createCard({ ...input, title: "Changed" })).rejects.toThrow(/Card intent changed/)
  expect(s.cards).toHaveLength(2)
})

it("preserves a remotely accepted recovery whose creation response was lost", async () => {
  const s = await pendingRecovery()
  s.runtime.gateway.request = async (method, params) => {
    const result = await s.request(method, params)
    if (method === "workboard.cards.create") throw new Error("Accepted response lost")
    return result
  }
  await expect(s.runtime.createCard(s.pending.input)).rejects.toThrow(/Accepted response lost/)
  expect(s.cards).toHaveLength(3)
  s.runtime.gateway.request = s.request
  await expect(s.runtime.applyWorkflowRecovery(s.plan, "operator")).rejects.toThrow(/acceptance is uncertain/)
  expect(s.cards).toHaveLength(3)
  expect(s.store.get("effect-intent", s.intentId)).toEqual(s.pending)
  expect(s.store.get("workflow", "workflow")).toEqual(s.workflow)
})

it("rechecks preserved intent evidence at the final recovery commit after card acceptance", async () => {
  const s = await pendingRecovery()
  let accepted = false
  s.runtime.gateway.request = async (method, params) => {
    const result = await s.request(method, params)
    if (method === "workboard.cards.create") accepted = true
    if (accepted && method === "workboard.cards.list")
      s.store.put("recovery", s.original.digest, s.store.get("recovery", s.original.digest))
    return result
  }
  await expect(s.runtime.applyWorkflowRecovery(s.plan, "operator")).rejects.toThrow(/evidence changed/)
  expect(s.cards).toHaveLength(3)
  expect(s.store.get<any>("effect-intent", s.intentId)).toMatchObject({ state: "confirmed", input: s.pending.input })
  expect(s.store.get("workflow", "workflow")).toEqual(s.workflow)
  expect(s.store.get("attempt-history", s.archiveId)).toBeNull()
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

it.each([
  "workflow",
  "attempt-evidence",
  "legacy-attempt-evidence"
])("carries the operator diagnosis and preserved %s commit into the fresh recovery context", async (source) => {
  const candidate = {
    cwd: "/preserved/candidate",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    files: ["src/fix.ts"]
  }
  const s = setup(candidate as any)
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: s.runtime.policy.repository,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"]
    }).trim()
  git("init")
  git("config", "user.name", "Fixture")
  git("config", "user.email", "fixture@example.invalid")
  mkdirSync(join(s.runtime.policy.repository, "src"))
  writeFileSync(join(s.runtime.policy.repository, "src/fix.ts"), "before")
  git("add", "src")
  git("commit", "-m", "base")
  candidate.baseSha = git("rev-parse", "HEAD")
  writeFileSync(join(s.runtime.policy.repository, "src/fix.ts"), "after")
  git("add", "src")
  git("commit", "-m", "candidate")
  candidate.headSha = git("rev-parse", "HEAD")
  s.workflow.candidate = candidate as any
  s.workflow.lifecycle = transitionNativeLifecycle(s.workflow.lifecycle!, "blocked", s.workflow)
  if (source !== "workflow") {
    s.store.put("attempt-evidence", "workflow:1", {
      candidate,
      ...(source === "attempt-evidence" ? { lifecycle: s.workflow.lifecycle } : {})
    })
    delete s.workflow.candidate
    s.workflow.lifecycle = upgradeNativeLifecycle("workflow", { blocker: "Repair ended without submission" })
  }
  s.store.put("workflow", "workflow", s.workflow)
  const reason = "Rebase preserved fix; previous verification failed because the baseline fixture was stale."
  const plan = await s.runtime.planWorkflowRecovery("workflow", "retry", reason)
  await s.runtime.applyWorkflowRecovery(plan, "operator")
  const intent = s.store.get<any>("effect-intent", "card:recovery:workflow:attempt:1")
  const notes = JSON.parse(intent.input.notes)
  expect(notes.recoveryReason).toBe(reason)
  expect(notes.previousCandidate).toMatchObject({
    baseSha: candidate.baseSha,
    headSha: candidate.headSha,
    files: candidate.files,
    attemptId: "workflow:attempt:0",
    complete: true
  })
  expect(notes.previousCandidate.cwd).toBeUndefined()
  expect(notes.previousCandidate.content).toContain("+after")
  expect(intent.input.workspace.sourceBranch).toBe("origin/main")
  expect(s.store.get<any>("workflow", "workflow").candidate).toBeUndefined()
  if (source === "workflow") expect(s.store.list<any>("attempt-history")[0]!.value.candidate).toEqual(candidate)
  else expect(s.store.get<any>("attempt-evidence", "workflow:1").candidate).toEqual(candidate)
})
