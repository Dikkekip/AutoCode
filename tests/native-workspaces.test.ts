import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { NativeWorkspaceGateway } from "../packages/core-runtime/src/native/workspaces.js"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function setup() {
  const root = mkdtempSync(join(tmpdir(), "native-workspaces-"))
  roots.push(root)
  const card = {
    id: "card",
    title: "Task",
    status: "ready",
    agentId: "coder",
    updatedAt: 1,
    metadata: { automation: { workspace: { kind: "worktree", sourcePath: root, sourceBranch: "origin/main" } } }
  }
  const calls: Array<[string, any]> = []
  let busy = false
  const gateway = {
    request: vi.fn(async (method: string, params: any) => {
      calls.push([method, params])
      if (method === "workboard.cards.list")
        return { cards: params.boardId ? [card] : busy ? [{ agentId: "coder", status: "running" }] : [] }
      if (method === "config.get")
        return {
          hash: "revision",
          config: { agents: { entries: { coder: { workspace: "/old", sandbox: { mode: "all" } } } } }
        }
      return { started: true }
    })
  }
  const worktrees = { create: vi.fn(async () => ({ path: root })) }
  const authorize = vi.fn()
  const adapter = new NativeWorkspaceGateway(
    gateway as any,
    { repository: root, baseBranch: "main", boardId: "board", workerConcurrency: 1, coderAgentId: "coder" } as any,
    authorize,
    worktrees
  )
  return {
    root,
    card,
    calls,
    gateway,
    worktrees,
    authorize,
    adapter,
    busy: () => {
      busy = true
    }
  }
}
it.each([
  [
    "terminal",
    { status: "done", hasActiveRun: false, hasActiveSubagentRun: false, activeRunIds: [], endedAt: 12 },
    true
  ],
  [
    "active",
    { status: "done", hasActiveRun: true, hasActiveSubagentRun: false, activeRunIds: ["live"], endedAt: 12 },
    false
  ],
  ["unknown", { status: "done", endedAt: 12 }, false],
  ["missing", null, false]
])("only releases a coder claim with explicit terminal session proof: %s", async (_name, session, released) => {
  const s = setup()
  const original = s.gateway.request.getMockImplementation()!
  s.gateway.request.mockImplementation(async (method: string, params: any) => {
    if (method === "workboard.cards.list") {
      const result = await original(method, params)
      return {
        cards: [
          ...result.cards!,
          {
            id: "old",
            title: "Prior work",
            status: "blocked",
            agentId: "coder",
            sessionKey: "agent:coder:old",
            metadata: { claim: { ownerId: "coder" } }
          }
        ]
      }
    }
    if (method === "sessions.list") return { sessions: session ? [{ key: "agent:coder:old", ...session }] : [] } as any
    return original(method, params)
  })
  await s.adapter.request("workboard.cards.dispatchWithOptions", { boardId: "board", maxStarts: 1 })
  const release = s.calls.find(([method]) => method === "workboard.cards.release")
  expect(Boolean(release)).toBe(released)
  expect(s.calls.some(([method]) => method === "workboard.cards.start")).toBe(released)
  if (released) expect(release![1]).toEqual({ id: "old", ownerId: "coder" })
})
it("does not let an expired historical claim block fresh work", async () => {
  const s = setup()
  const original = s.gateway.request.getMockImplementation()!
  s.gateway.request.mockImplementation(async (method: string, params: any) => {
    if (method === "workboard.cards.list") {
      const result = await original(method, params)
      return {
        cards: [
          ...result.cards!,
          {
            id: "expired",
            title: "Old work",
            status: "blocked",
            agentId: "coder",
            metadata: { claim: { ownerId: "coder", expiresAt: 1 } }
          }
        ]
      }
    }
    if (method === "sessions.list") throw new Error("Expired claims do not need session mutation")
    return original(method, params)
  })
  await s.adapter.request("workboard.cards.dispatchWithOptions", { boardId: "board", maxStarts: 1 })
  expect(s.calls.some(([method]) => method === "workboard.cards.release")).toBe(false)
  expect(s.calls.some(([method]) => method === "workboard.cards.start")).toBe(true)
})
it("binds the exact managed sandbox root and starts only the prepared card", async () => {
  const s = setup()
  await s.adapter.request("workboard.cards.dispatchWithOptions", { boardId: "board", maxStarts: 1 })
  expect(s.worktrees.create).toHaveBeenCalledWith({
    repoRoot: s.root,
    name: "wb-card",
    baseRef: "origin/main",
    ownerKind: "workboard",
    ownerId: "card"
  })
  const patch = s.calls.find(([method]) => method === "config.patch")![1]
  expect(patch.baseHash).toBe("revision")
  expect(JSON.parse(patch.raw)).toEqual({ agents: { entries: { coder: { workspace: s.root } } } })
  expect(s.calls.slice(-2)).toEqual([
    [
      "workboard.cards.update",
      { id: "card", expectedUpdatedAt: 1, patch: { workspace: { kind: "dir", path: s.root } } }
    ],
    ["workboard.cards.start", { id: "card" }]
  ])
})
it("does not rebind a coder with active work on any board", async () => {
  const s = setup()
  s.busy()
  expect(await s.adapter.request("workboard.cards.dispatchWithOptions", { boardId: "board", maxStarts: 1 })).toEqual({
    started: []
  })
  expect(s.worktrees.create).not.toHaveBeenCalled()
  expect(s.calls.some(([m]) => m === "config.patch" || m === "workboard.cards.start")).toBe(false)
})
it("leaves scratch investigation workspaces under Workboard ownership", async () => {
  const s = setup()
  s.card.metadata.automation.workspace.kind = "scratch"
  await s.adapter.request("workboard.cards.dispatchWithOptions", { boardId: "board", maxStarts: 1 })
  expect(s.worktrees.create).not.toHaveBeenCalled()
  expect(s.calls.some(([method]) => method === "config.patch" || method === "workboard.cards.update")).toBe(false)
  expect(s.calls.at(-1)).toEqual(["workboard.cards.start", { id: "card" }])
})
it("rechecks dispatch authority after asynchronous workspace preparation", async () => {
  const s = setup()
  s.authorize.mockImplementation(() => {
    if (s.calls.some(([method]) => method === "workboard.cards.update")) throw new Error("paused")
  })
  await expect(
    s.adapter.request("workboard.cards.dispatchWithOptions", { boardId: "board", maxStarts: 1 })
  ).rejects.toThrow("paused")
  expect(s.calls.some(([method]) => method === "workboard.cards.start")).toBe(false)
})
it("fails before changing configuration when a worktree source differs from policy", async () => {
  const s = setup()
  s.card.metadata.automation.workspace.sourceBranch = "unreviewed"
  await expect(
    s.adapter.request("workboard.cards.dispatchWithOptions", { boardId: "board", maxStarts: 1 })
  ).rejects.toThrow(/source/)
  expect(s.calls.some(([m]) => m === "config.patch" || m === "workboard.cards.start")).toBe(false)
})

it.each([
  "done",
  "running",
  "blocked"
])("promotes queued research only after its parent is done: %s", async (status) => {
  const s = setup()
  s.card.status = "todo"
  s.card.metadata.automation.workspace.kind = "scratch"
  const child = { ...s.card, metadata: { ...s.card.metadata, links: [{ type: "parent", targetCardId: "parent" }] } }
  s.gateway.request.mockImplementation(async (method: string, params: any) => {
    s.calls.push([method, params])
    if (method === "workboard.cards.list")
      return { cards: params.boardId ? [child, { id: "parent", title: "Parent", status }] : [] } as any
    if (method === "workboard.cards.promote") child.status = "ready"
    return {} as any
  })
  await s.adapter.request("workboard.cards.dispatchWithOptions", { boardId: "board", maxStarts: 1 })
  expect(s.calls.some(([m]) => m === "workboard.cards.start")).toBe(status === "done")
  expect(s.calls.filter(([m]) => m === "workboard.cards.promote")).toEqual(
    status === "done" ? [["workboard.cards.promote", { id: "card" }]] : []
  )
})

it("starts three distinct coders in isolated worktrees while keeping busy-agent serialization", async () => {
  const s = setup()
  const cards = ["coder", "coder-2", "coder-3"].map((agentId, index) => ({ ...s.card, id: `card-${index}`, agentId }))
  const calls: Array<[string, any]> = []
  const gateway = {
    request: vi.fn(async (method: string, params: any) => {
      calls.push([method, params])
      if (method === "workboard.cards.list") return { cards }
      if (method === "config.get")
        return {
          hash: "revision",
          config: {
            agents: {
              entries: Object.fromEntries(
                cards.map((c) => [c.agentId, { workspace: "/old", sandbox: { mode: "all" } }])
              )
            }
          }
        }
      if (method === "workboard.cards.start") cards.find((c) => c.id === params.id)!.status = "running"
      return { started: true }
    })
  }
  const worktrees = {
    create: vi.fn(async ({ name }: { name: string }) => {
      const path = join(s.root, name)
      mkdirSync(path)
      return { path }
    })
  }
  const adapter = new NativeWorkspaceGateway(
    gateway as any,
    { repository: s.root, baseBranch: "main", boardId: "board", workerConcurrency: 3 } as any,
    () => {},
    worktrees
  )
  expect(
    ((await adapter.request("workboard.cards.dispatchWithOptions", { boardId: "board", maxStarts: 3 })) as any).started
  ).toHaveLength(3)
  const patches = calls
    .filter(([method]) => method === "config.patch")
    .map(([, args]) => JSON.parse(args.raw).agents.entries)
  expect(patches).toEqual(cards.map((c) => ({ [c.agentId]: { workspace: join(s.root, `wb-${c.id}`) } })))
  expect(
    ((await adapter.request("workboard.cards.dispatchWithOptions", { boardId: "board", maxStarts: 3 })) as any).started
  ).toHaveLength(0)
})

it("does not dispatch a different coder into another active coder's preserved candidate", async () => {
  const s = setup()
  s.card.agentId = "coder-2"
  s.card.metadata.automation.workspace = { kind: "dir", path: s.root } as any
  s.gateway.request.mockImplementation(async (method: string, params: any) => {
    if (method === "workboard.cards.list")
      return {
        cards: params.boardId
          ? [s.card]
          : [
              {
                agentId: "coder",
                status: "running",
                metadata: { automation: { workspace: { kind: "dir", path: s.root } } }
              }
            ]
      } as any
    throw new Error(`Unexpected mutation: ${method}`)
  })
  expect(await s.adapter.request("workboard.cards.dispatchWithOptions", { boardId: "board", maxStarts: 1 })).toEqual({
    started: []
  })
})

const capacityError = () =>
  new Error(
    "Insufficient disk space near /managed/worktrees for worktree allocation: 11 GiB available; approximately 12 GiB required including safety reserve. Free caches or archive/remove unused worktrees, then retry."
  )
function withReadyResearch(s: ReturnType<typeof setup>) {
  const original = s.gateway.request.getMockImplementation()!
  s.gateway.request.mockImplementation(async (method, params) => {
    if (method === "workboard.cards.list" && params.boardId)
      return {
        cards: [
          s.card,
          {
            id: "research",
            title: "Investigate",
            status: "ready",
            agentId: "researcher",
            metadata: { automation: { workspace: { kind: "scratch" } } }
          }
        ]
      } as any
    return original(method, params)
  })
}
it("defers only the disk-constrained worktree while starting independent scratch work within the start limit", async () => {
  const s = setup()
  withReadyResearch(s)
  const originalCard = JSON.stringify(s.card)
  s.worktrees.create.mockRejectedValue(capacityError())
  const result = await s.adapter.request<any>("workboard.cards.dispatchWithOptions", { boardId: "board", maxStarts: 1 })
  expect(result.deferred).toEqual([{ cardId: "card", reason: "worktree-capacity" }])
  expect(result.started).toHaveLength(1)
  expect(result.startedCardIds).toEqual(["research"])
  expect(s.calls.filter(([method]) => method === "workboard.cards.start")).toEqual([
    ["workboard.cards.start", { id: "research" }]
  ])
  expect(s.calls.some(([method]) => ["config.patch", "workboard.cards.update"].includes(method))).toBe(false)
  expect(JSON.stringify(s.card)).toBe(originalCard)
})
it.each([
  new Error("allocator permission denied"),
  new Error("Insufficient disk space near unrecognized diagnostic"),
  new Error(capacityError().message.replace("11 GiB", "11 mystery-units")),
  new Error("prefix " + capacityError().message),
  Object.assign(capacityError(), { name: "NativeControlRevoked" })
])("does not suppress an unknown allocator failure: %s", async (error) => {
  const s = setup()
  withReadyResearch(s)
  s.worktrees.create.mockRejectedValue(error)
  await expect(
    s.adapter.request("workboard.cards.dispatchWithOptions", { boardId: "board", maxStarts: 1 })
  ).rejects.toBe(error)
  expect(s.calls.some(([method]) => method === "workboard.cards.start")).toBe(false)
})
it("honors revoked authorization after a capacity deferral before starting other work", async () => {
  const s = setup()
  withReadyResearch(s)
  s.worktrees.create.mockImplementation(async () => {
    s.authorize.mockImplementation(() => {
      throw new Error("paused")
    })
    throw capacityError()
  })
  await expect(
    s.adapter.request("workboard.cards.dispatchWithOptions", { boardId: "board", maxStarts: 1 })
  ).rejects.toThrow("paused")
  expect(s.calls.some(([method]) => method === "workboard.cards.start")).toBe(false)
})

it.each([
  "0 MiB",
  "512 MiB",
  "9.9 GiB"
])("continues scratch research for allocator available-space format %s", async (available) => {
  const s = setup()
  withReadyResearch(s)
  s.worktrees.create.mockRejectedValue(
    new Error(capacityError().message.replace("11 GiB available", `${available} available`))
  )
  const result = await s.adapter.request<any>("workboard.cards.dispatchWithOptions", { boardId: "board", maxStarts: 1 })
  expect(result.deferred).toEqual([{ cardId: "card", reason: "worktree-capacity" }])
  expect(result.started).toHaveLength(1)
  expect(result.startedCardIds).toEqual(["research"])
  expect(s.calls.filter(([method]) => method === "workboard.cards.start")).toEqual([
    ["workboard.cards.start", { id: "research" }]
  ])
})
