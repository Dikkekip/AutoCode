import { realpathSync } from "node:fs"
import type { NativeAutonomyPolicy } from "@openclaw/domain"
import { type NativeGateway, nativeCards } from "./gateway.js"

interface ManagedWorktrees {
  create(input: {
    repoRoot: string
    name: string
    baseRef: string
    ownerKind: string
    ownerId: string
  }): Promise<{ path: string }>
}

/** Bind sandbox roots through supported APIs before Workboard launches a scoped run.
 * OpenClaw 2026.9 rejects a sandboxed cwd override that differs from the agent workspace.
 * Never rebind an agent with an active card, and dispatch only the card we prepared.
 */
export class NativeWorkspaceGateway implements NativeGateway {
  constructor(
    readonly gateway: NativeGateway,
    readonly policy: NativeAutonomyPolicy,
    readonly authorize: () => void,
    readonly worktrees?: ManagedWorktrees
  ) {}
  async request<T = any>(method: string, params: Record<string, unknown>): Promise<T> {
    if (method !== "workboard.cards.dispatchWithOptions") return this.gateway.request<T>(method, params)
    if (params.boardId !== this.policy.boardId) throw new Error("Workspace dispatch board mismatch")
    const all = await this.gateway.request<{ cards: Array<{ agentId?: string; status: string }> }>(
      "workboard.cards.list",
      {}
    )
    if (!Array.isArray(all.cards)) throw new Error("Workboard card listing unavailable")
    const busy = new Set(all.cards.filter((c) => c.status === "running").map((c) => c.agentId))
    const pending = await nativeCards(this.gateway, this.policy.boardId)
    for (const card of pending) {
      if (card.status !== "todo") continue
      const parents = (card.metadata?.links ?? []).filter((link) => link.type === "parent")
      if (
        !parents.length ||
        !parents.every((link) => pending.some((p) => p.id === link.targetCardId && p.status === "done"))
      )
        continue
      this.authorize()
      // Preserve Workboard dependency/schedule holds; never force operator-blocked work.
      await this.gateway.request("workboard.cards.promote", { id: card.id })
    }
    const cards = (await nativeCards(this.gateway, this.policy.boardId)).filter(
      (c) => c.status === "ready" && c.agentId && !busy.has(c.agentId)
    )
    const started: unknown[] = []
    const maximum = Math.min(this.policy.workerConcurrency, Number(params.maxStarts) || 1)
    for (const card of cards) {
      if (started.length >= maximum) break
      if (busy.has(card.agentId)) continue
      const workspace = card.metadata?.automation?.workspace as
        | { kind?: string; path?: string; sourcePath?: string; sourceBranch?: string }
        | undefined
      if (workspace?.kind === "scratch") {
        this.authorize()
        started.push(await this.gateway.request("workboard.cards.start", { id: card.id }))
        busy.add(card.agentId)
        continue
      }
      if (!workspace || !["dir", "worktree"].includes(workspace.kind ?? ""))
        throw new Error("Native dispatch requires an explicit managed workspace")
      let path = workspace.path
      if (workspace.kind === "worktree") {
        if (
          !this.worktrees ||
          realpathSync(workspace.sourcePath ?? "") !== realpathSync(this.policy.repository) ||
          workspace.sourceBranch !== `origin/${this.policy.baseBranch}`
        )
          throw new Error("Managed worktree source does not match native policy")
        this.authorize()
        path = (
          await this.worktrees.create({
            repoRoot: this.policy.repository,
            name: `wb-${card.id}`,
            baseRef: `origin/${this.policy.baseBranch}`,
            ownerKind: "workboard",
            ownerId: card.id
          })
        ).path
      }
      if (!path) throw new Error("Native workspace path unavailable")
      path = realpathSync(path)
      const snapshot = await this.gateway.request<any>("config.get", {})
      const agent = (snapshot.config ?? snapshot.parsed)?.agents?.entries?.[card.agentId!]
      if (!agent) throw new Error("Assigned native agent configuration unavailable")
      if (agent.sandbox?.mode === "all" && agent.workspace !== path) {
        if (!snapshot.hash) throw new Error("Configuration revision unavailable for workspace binding")
        this.authorize()
        await this.gateway.request("config.patch", {
          baseHash: snapshot.hash,
          raw: JSON.stringify({ agents: { entries: { [card.agentId!]: { workspace: path } } } })
        })
      }
      this.authorize()
      await this.gateway.request("workboard.cards.update", {
        id: card.id,
        expectedUpdatedAt: card.updatedAt,
        patch: { workspace: { kind: "dir", path } }
      })
      this.authorize()
      started.push(await this.gateway.request("workboard.cards.start", { id: card.id }))
      busy.add(card.agentId)
    }
    return { started } as T
  }
}
