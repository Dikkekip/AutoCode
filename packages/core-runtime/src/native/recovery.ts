/** Read-only recovery plans; this module never owns task dispatch. */
import { createHash } from "node:crypto"
import type { NativeLifecycle } from "@openclaw/domain"
export type NativeRecoveryAction = "retry" | "cancel" | "supersede" | "abandon" | "archive"
export interface NativeRecoverySnapshot {
  boardId: string
  workflowId: string
  workflowVersion: number
  workflowDigest: string
  policyDigest: string
  lifecycle: NativeLifecycle
  control: { paused: boolean; revision: string }
  cards: Array<{ id: string; status: string; executionStatus?: string; runId?: string; updatedAt?: number }>
  missingCards: string[]
  operations: Array<{ id: string; value: unknown; version: number }>
  successor?: { id: string; version: number; terminal: boolean }
  hasPullRequest: boolean
  hasMerge: boolean
  archived: boolean
}
export interface NativeRecoveryPlan {
  version: 1
  action: NativeRecoveryAction
  reason: string
  snapshot: NativeRecoverySnapshot
  allowed: boolean
  blockers: string[]
  effects: string[]
  digest: string
}
export function nativeRecoveryDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}
export function planNativeRecovery(
  snapshot: NativeRecoverySnapshot,
  action: NativeRecoveryAction,
  reason: string
): NativeRecoveryPlan {
  if (!["retry", "cancel", "supersede", "abandon", "archive"].includes(action))
    throw new Error("Unsupported recovery action")
  if (typeof reason !== "string" || !reason.trim() || reason.length > 2000)
    throw new Error("Recovery requires a bounded operator reason")
  const blockers: string[] = []
  const terminal = ["completed", "cancelled"].includes(snapshot.lifecycle.state)
  if (!snapshot.control.paused) blockers.push("Pause native execution, then generate a fresh recovery plan")
  if (snapshot.missingCards.length) blockers.push(`Resolve missing owned cards: ${snapshot.missingCards.join(", ")}`)
  if (
    snapshot.cards.some(
      (c) =>
        ["ready", "running", "scheduled", "review"].includes(c.status) ||
        ["pending", "running", "review"].includes(c.executionStatus ?? "")
    )
  )
    blockers.push("Stop or finish owned Workboard execution and return runnable cards to blocked before replanning")
  if (snapshot.operations.some((op) => (op.value as { state?: string })?.state !== "confirmed"))
    blockers.push(
      "Reconcile uncertain external effects against remote truth before recovery; never delete or replay the journal"
    )
  if (action === "archive") {
    if (!terminal) blockers.push("Only completed or safely cancelled workflows can be archived")
  } else {
    if (terminal || snapshot.archived)
      blockers.push("Terminal or archived workflows cannot be reopened; admit new evidence as new work")
    if (snapshot.hasPullRequest || snapshot.hasMerge)
      blockers.push(
        "An existing PR or merge requires remote release reconciliation; local recovery cannot assert its outcome"
      )
  }
  if (action === "retry" && snapshot.lifecycle.state !== "blocked") blockers.push("Retry requires a blocked workflow")
  if (
    action === "supersede" &&
    (!snapshot.successor || snapshot.successor.id === snapshot.workflowId || snapshot.successor.terminal)
  )
    blockers.push("Supersession requires a distinct existing nonterminal successor workflow")
  const effects =
    action === "retry"
      ? [
          "Preserve the original attempt and all receipts",
          "Create a blocked Workboard implementation card with a new immutable attempt",
          "Require fresh candidate verification and independent review after explicit resume"
        ]
      : action === "archive"
        ? ["Hide terminal work from active status while retaining its evidence"]
        : [
            "Mark the workflow cancelled with the operator disposition",
            "Release local scope reservations only after owned work and effects are quiescent",
            "Preserve Workboard cards and the entire operation history"
          ]
  const body = {
    version: 1 as const,
    action,
    reason: reason.trim(),
    snapshot,
    allowed: blockers.length === 0,
    blockers,
    effects
  }
  return { ...body, digest: nativeRecoveryDigest(body) }
}
