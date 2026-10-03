import { realpathSync } from "node:fs"
import type { NativeAutonomyPolicy } from "@openclaw/domain"
import { nativeCoderAgentIds } from "@openclaw/domain"
import { type NativeGateway, nativeCards, type OwnedInvestigationAbort } from "./gateway.js"

/** Preserve native admission, dependency and owner serialization while Workboard owns checkout preparation. */
export class NativeWorkspaceGateway implements NativeGateway {
  constructor(
    readonly gateway: NativeGateway,
    readonly policy: NativeAutonomyPolicy,
    readonly authorize: () => void
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
      hasMore?: boolean
      nextCursor?: unknown
      cards: Array<{
        id?: string
        agentId?: string
        status: string
        metadata?: { claim?: { ownerId?: string; expiresAt?: number }; automation?: { workspace?: { path?: string } } }
      }>
    }>("workboard.cards.list", {})
    if (!Array.isArray(all.cards) || all.hasMore || all.nextCursor)
      throw new Error("Workboard card listing unavailable")
    const busy = new Set(all.cards.filter((c) => c.status === "running").map((c) => c.agentId))
    for (const card of all.cards) {
      const claim = card.metadata?.claim
      if (claim?.ownerId && !(typeof claim.expiresAt === "number" && claim.expiresAt <= Date.now())) {
        busy.add(claim.ownerId)
        if (card.agentId) busy.add(card.agentId)
      }
    }
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
        !all.cards.some(
          (other) =>
            other.id !== card.id &&
            ((other.agentId === ownerId && other.status === "running") ||
              ((other.metadata?.claim?.ownerId === ownerId || other.agentId === ownerId) &&
                other.metadata?.claim?.ownerId &&
                !(typeof other.metadata.claim.expiresAt === "number" && other.metadata.claim.expiresAt <= Date.now())))
        ) &&
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
      let legacyPath: string | undefined
      if (workspace.kind === "worktree") {
        if (
          realpathSync(workspace.sourcePath ?? "") !== realpathSync(this.policy.repository) ||
          workspace.sourceBranch !== `origin/${this.policy.baseBranch}`
        )
          throw new Error("Managed worktree source does not match native policy")
      } else {
        if (!workspace.path) throw new Error("Native workspace path unavailable")
        // Existing directory cards retain their native Workboard confinement checks.
        // Never rewrite role configuration to make a preserved candidate writable.
        legacyPath = realpathSync(workspace.path)
        if (busyPaths.has(legacyPath)) continue
      }
      this.authorize()
      started.push(await this.gateway.request("workboard.cards.start", { id: card.id }))
      startedCardIds.push(card.id)
      busy.add(card.agentId)
      if (legacyPath) busyPaths.add(legacyPath)
    }
    return {
      started,
      ...(startedCardIds.length ? { startedCardIds } : {})
    } as T
  }
}
