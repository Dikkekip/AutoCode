import { mkdtempSync, rmSync } from "node:fs"
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
    { repository: root, baseBranch: "main", boardId: "board", workerConcurrency: 1 } as any,
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
