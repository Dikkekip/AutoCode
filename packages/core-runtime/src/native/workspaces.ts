import { realpathSync, statfsSync } from "node:fs"
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
    const busyPaths = new Set<string>()
    let unknownBusyPath = false
    for (const card of all.cards.filter((c) => c.status === "running")) {
      const path = card.metadata?.automation?.workspace?.path
      if (!path) continue
      try {
        busyPaths.add(realpathSync(path))
      } catch {
        // Keep that agent busy, and fail closed for shared directory candidates.
        // Workboard-created isolated worktrees need not resolve another run's path.
        unknownBusyPath = true
      }
    }
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
      // An agent's historical session can fall outside the newest page. Search
      // for the exact owned key instead of letting unrelated sessions hide it.
      const result = await this.gateway.request<any>("sessions.list", {
        agentId: ownerId,
        search: card.sessionKey,
        limit: 10
      })
      const matches = Array.isArray(result.sessions)
        ? result.sessions.filter((s: any) => s.key === card.sessionKey && s.agentId === ownerId)
        : []
      const session = matches.length === 1 ? matches[0] : undefined
      if (
        !session ||
        !["done", "completed", "failed", "cancelled", "timed_out", "timeout", "killed"].includes(session.status) ||
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
    const deferred: Array<{ cardId: string; reason: "worktree-capacity" | "workspace-unavailable" }> = []
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
        if (unknownBusyPath) {
          deferred.push({ cardId: card.id, reason: "workspace-unavailable" })
          continue
        }
        // Existing directory cards retain their native Workboard confinement checks.
        // Never rewrite role configuration to make a preserved candidate writable.
        try {
          legacyPath = realpathSync(workspace.path)
        } catch {
          deferred.push({ cardId: card.id, reason: "workspace-unavailable" })
          continue
        }
        if (busyPaths.has(legacyPath)) continue
      }
      const previousComment = card.metadata?.comments?.at(-1)?.body ?? ""
      const diskHold =
        /^Dispatcher could not start worker: Insufficient disk space near (.+) for worktree allocation: .+; approximately ([\d.]+) (GiB|MiB) required including safety reserve\./.exec(
          previousComment
        )
      if (workspace.kind === "worktree" && diskHold && !card.runId && !card.sessionKey && !card.execution) {
        let available = 0
        try {
          const volume = statfsSync(diskHold[1]!)
          available = volume.bavail * volume.bsize
        } catch {
          /* Unavailable capacity stays deferred. */
        }
        const minimum = Number(diskHold[2]) * (diskHold[3] === "GiB" ? 1024 ** 3 : 1024 ** 2) + 1024 ** 3
        if (!Number.isFinite(minimum) || available < minimum) {
          deferred.push({ cardId: card.id, reason: "worktree-capacity" })
          continue
        }
      }
      const previousFailureCount = card.metadata?.failureCount ?? 0
      const previousRunId = card.runId,
        previousSessionKey = card.sessionKey
      this.authorize()
      try {
        started.push(await this.gateway.request("workboard.cards.start", { id: card.id }))
      } catch (error) {
        if (
          workspace.kind !== "worktree" ||
          !/Insufficient disk space near .+ for worktree allocation:/.test(String(error))
        )
          throw error
        const after = (await nativeCards(this.gateway, this.policy.boardId)).find((item) => item.id === card.id)
        // Allocation failure is retryable only when no run was accepted. Workboard
        // may have blocked the card before returning the pre-allocation failure.
        if (
          !after ||
          after.runId !== previousRunId ||
          after.sessionKey !== previousSessionKey ||
          after.runId ||
          after.sessionKey ||
          after.execution ||
          (after.metadata?.automation as any)?.launch
        )
          throw error
        if (after.status === "blocked") {
          const diagnostic = /Insufficient disk space near .+ for worktree allocation:.*$/.exec(String(error))?.[0]
          if (
            !diagnostic ||
            after.metadata?.comments?.at(-1)?.body !== `Dispatcher could not start worker: ${diagnostic}` ||
            after.metadata.failureCount !== previousFailureCount + 1 ||
            !Number.isFinite(after.updatedAt)
          )
            throw error
          this.authorize()
          await this.gateway.request("workboard.cards.update", {
            id: card.id,
            expectedUpdatedAt: after.updatedAt,
            patch: { status: "ready" }
          })
        } else if (after.status !== "ready") throw error
        deferred.push({ cardId: card.id, reason: "worktree-capacity" })
        continue
      }
      startedCardIds.push(card.id)
      busy.add(card.agentId)
      if (legacyPath) busyPaths.add(legacyPath)
    }
    return {
      started,
      ...(deferred.length ? { deferred } : {}),
      ...(startedCardIds.length ? { startedCardIds } : {})
    } as T
  }
}
