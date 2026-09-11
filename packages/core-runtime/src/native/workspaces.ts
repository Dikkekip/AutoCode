import { realpathSync } from "node:fs"
import type { NativeAutonomyPolicy } from "@openclaw/domain"
import { nativeCoderAgentIds } from "@openclaw/domain"
import { type NativeGateway, nativeCards, type OwnedInvestigationAbort } from "./gateway.js"

interface ManagedWorktrees {
  create(input: {
    repoRoot: string
    name: string
    baseRef: string
    ownerKind: string
    ownerId: string
  }): Promise<{ path: string }>
}

// The supported allocator currently returns a plain Error rather than a typed
// capacity code. Match only its complete disk-preflight diagnostic at the create
// boundary; unknown errors must continue to fail closed.
function isWorktreeCapacityError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    error.name === "Error" &&
    /^Insufficient disk space near [^\r\n]+ for worktree allocation: \d+(?:\.\d+)? (?:MiB|GiB) available; approximately \d+(?:\.\d+)? (?:MiB|GiB) required including safety reserve\. Free caches or archive\/remove unused worktrees, then retry\.$/.test(
      error.message
    )
  )
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
  async abortOwnedInvestigation(input: OwnedInvestigationAbort) {
    if (input.boardId !== this.policy.boardId) throw new Error("Investigation cancellation board mismatch")
    if (!this.gateway.abortOwnedInvestigation) throw new Error("Owned investigation cancellation unavailable")
    return this.gateway.abortOwnedInvestigation(input)
  }
  async request<T = any>(method: string, params: Record<string, unknown>): Promise<T> {
    if (method !== "workboard.cards.dispatchWithOptions") return this.gateway.request<T>(method, params)
    if (params.boardId !== this.policy.boardId) throw new Error("Workspace dispatch board mismatch")
    const all = await this.gateway.request<{
      cards: Array<{ agentId?: string; status: string; metadata?: { automation?: { workspace?: { path?: string } } } }>
    }>("workboard.cards.list", {})
    if (!Array.isArray(all.cards)) throw new Error("Workboard card listing unavailable")
    const busy = new Set(all.cards.filter((c) => c.status === "running").map((c) => c.agentId))
    const busyPaths = new Set(
      all.cards
        .filter((c) => c.status === "running")
        .map((c) => c.metadata?.automation?.workspace?.path)
        .filter((path): path is string => Boolean(path))
        .map((path) => realpathSync(path))
    )
    const pending = await nativeCards(this.gateway, this.policy.boardId)
    const heldClaims = new Map(
      pending
        .filter(
          (card) =>
            card.metadata?.claim?.ownerId &&
            !(typeof card.metadata.claim.expiresAt === "number" && card.metadata.claim.expiresAt <= Date.now())
        )
        .map((card) => [card.id, card.metadata!.claim!.ownerId!])
    )
    // Workboard can retain a claim after its session finishes. Release only our
    // coder's terminal claim with explicit live-session evidence; uncertainty
    // keeps the owner busy and never stops a potentially active session.
    for (const card of pending) {
      const ownerId = card.metadata?.claim?.ownerId
      if (!heldClaims.has(card.id)) continue
      if (!ownerId || !nativeCoderAgentIds(this.policy).includes(ownerId) || ownerId !== card.agentId) continue
      if (!["blocked", "done", "cancelled", "review"].includes(card.status)) continue
      busy.add(ownerId)
      if (!card.sessionKey) continue
      const result = await this.gateway.request<any>("sessions.list", { agentId: ownerId, limit: 100 })
      const session = result.sessions?.find((s: any) => s.key === card.sessionKey)
      if (
        !session ||
        !["done", "completed", "failed", "cancelled", "timed_out"].includes(session.status) ||
        session.hasActiveRun !== false ||
        session.hasActiveSubagentRun !== false ||
        !Array.isArray(session.activeRunIds) ||
        session.activeRunIds.length !== 0 ||
        !Number.isFinite(session.endedAt)
      )
        continue
      this.authorize()
      await this.gateway.request("workboard.cards.release", { id: card.id, ownerId })
      heldClaims.delete(card.id)
      if (
        !all.cards.some((other) => other.agentId === ownerId && other.status === "running") &&
        ![...heldClaims.values()].includes(ownerId)
      )
        busy.delete(ownerId)
    }
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
    const startedCardIds: string[] = []
    const deferred: Array<{ cardId: string; reason: "worktree-capacity" }> = []
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
        startedCardIds.push(card.id)
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
        try {
          path = (
            await this.worktrees.create({
              repoRoot: this.policy.repository,
              name: `wb-${card.id}`,
              baseRef: `origin/${this.policy.baseBranch}`,
              ownerKind: "workboard",
              ownerId: card.id
            })
          ).path
        } catch (error) {
          if (!isWorktreeCapacityError(error)) throw error
          this.authorize()
          deferred.push({ cardId: card.id, reason: "worktree-capacity" })
          continue
        }
      }
      if (!path) throw new Error("Native workspace path unavailable")
      path = realpathSync(path)
      // A repair may reuse another coder's preserved candidate; never share a live workspace.
      if (busyPaths.has(path)) continue
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
      startedCardIds.push(card.id)
      busy.add(card.agentId)
      busyPaths.add(path)
    }
    return {
      started,
      ...(startedCardIds.length ? { startedCardIds } : {}),
      ...(deferred.length ? { deferred } : {})
    } as T
  }
}
