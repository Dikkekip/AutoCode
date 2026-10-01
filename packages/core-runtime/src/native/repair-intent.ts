import type { NativeLifecycle } from "@openclaw/domain"
/** Retire only an unaccepted legacy HOST-dir repair intent; preserve all original custody. */
import { decodeNativeCard, type NativeGateway, nativeCardIdempotencyKey, nativeObject } from "./gateway.js"
import { nativeContentDigest } from "./provenance.js"
import type { NativeEvidenceStore, NativeRecordWrite } from "./store.js"

export async function supersedeLegacyNativeRepairIntent(
  store: NativeEvidenceStore,
  gateway: NativeGateway,
  workflowId: string,
  legacyInput: Record<string, unknown>,
  input: Record<string, unknown>,
  assertCurrent: () => void
): Promise<NativeRecordWrite[]> {
  const id = `card:${String(legacyInput.idempotencyKey)}`
  const pending = store.get<{
    state: string
    input: Record<string, unknown>
    card?: unknown
    replacementId?: string
    replacementInput?: unknown
  }>("effect-intent", id)
  if (!pending) return []
  const replacementId = `card:${String(input.idempotencyKey)}`
  if (
    !store.holdsLease(`workflow:${workflowId}`) ||
    pending.card ||
    JSON.stringify(pending.input) !== JSON.stringify(legacyInput) ||
    !["pending", "superseded"].includes(pending.state) ||
    (pending.state === "superseded" &&
      (pending.replacementId !== replacementId || JSON.stringify(pending.replacementInput) !== JSON.stringify(input)))
  )
    throw new Error("Legacy repair custody cannot be superseded")
  const version = store.version("effect-intent", id)
  const assertPending = () => {
    assertCurrent()
    store.authorizeEffect()
    if (!store.holdsLease(`workflow:${workflowId}`) || store.version("effect-intent", id) !== version)
      throw new Error("Legacy repair intent changed during absence check")
  }
  assertPending()
  // Native cards.list({}) includes every board and archived cards; no archive filter is supported.
  const result = nativeObject(await gateway.request("workboard.cards.list", {}), "Legacy repair cards.list")
  assertPending()
  if (
    !Array.isArray(result.cards) ||
    (result.hasMore !== undefined && result.hasMore !== false) ||
    result.nextCursor != null ||
    result.nextOffset != null ||
    (result.totalCount !== undefined &&
      (!Number.isSafeInteger(result.totalCount) || result.totalCount !== result.cards.length))
  )
    throw new Error("Legacy repair requires complete all-card custody")
  const cards = result.cards.map((value: unknown) => decodeNativeCard(value))
  if (new Set(cards.map((card) => card.id)).size !== cards.length)
    throw new Error("Legacy repair custody contains duplicate card identities")
  const key = nativeCardIdempotencyKey(String(legacyInput.idempotencyKey))
  if (
    cards.some(
      (card) =>
        card.metadata?.automation?.idempotencyKey === key ||
        (card.title === legacyInput.title && !card.metadata?.automation?.idempotencyKey)
    )
  )
    throw new Error("Legacy repair card accepted or uncertain; preserve remote custody")
  assertPending()
  return pending.state === "superseded"
    ? []
    : [
        {
          kind: "effect-intent",
          id,
          expectedVersion: version,
          value: {
            ...pending,
            state: "superseded",
            replacementId,
            replacementInput: input,
            supersession: { workflowId, completeAllCardAbsence: true, cardCount: cards.length, priorVersion: version }
          }
        }
      ]
}

/** A superseded journal remains superseded; recovery may proceed only after its exact linked replacement confirms. */
export function nativeRepairSupersessionClosed(store: NativeEvidenceStore, id: string): boolean {
  const old = store.get<{
    state: string
    input?: Record<string, unknown>
    replacementId?: string
    replacementInput?: unknown
    supersession?: { workflowId?: string; completeAllCardAbsence?: boolean; priorVersion?: number }
  }>("effect-intent", id)
  if (
    old?.state !== "superseded" ||
    old.replacementId !== `${id}:managed-source-v1` ||
    !old.input ||
    !old.supersession?.completeAllCardAbsence ||
    !old.supersession.workflowId ||
    !Number.isSafeInteger(old.supersession.priorVersion) ||
    store.version("effect-intent", id) !== old.supersession.priorVersion! + 1
  )
    return false
  const next = store.get<{ state: string; input: unknown; card?: unknown }>("effect-intent", old.replacementId)
  return (
    next?.state === "confirmed" &&
    Boolean(next.card) &&
    JSON.stringify(next.input) === JSON.stringify(old.replacementInput)
  )
}

/** Canonical store proof for completing an interrupted repair, not an operator recovery or budget reset. */
export function preservedNativeRepairLifecycle(
  store: NativeEvidenceStore,
  id: string,
  previous: unknown,
  next: unknown,
  event: { kind: string; subject: string; value: unknown }
): NativeLifecycle | undefined {
  const before = nativeObject(previous, "Previous repair workflow"),
    after = nativeObject(next, "Next repair workflow")
  if (before.lifecycle?.state !== "blocked" || event.kind !== "workflow.repair-requested" || event.subject !== id)
    return undefined
  const audit = nativeObject(event.value, "Repair event")
  const proof = nativeObject(audit.preservedRepair, "Preserved repair transition")
  const attempt = before.lifecycle.attempt + 1,
    archiveId = `${id}:${attempt}`,
    legacyId = `card:workflow:${id}:repair:${attempt}`
  if (
    proof.archiveId !== archiveId ||
    proof.archiveVersion !== store.version("attempt-evidence", archiveId) ||
    proof.legacyIntentId !== legacyId ||
    proof.replacementId !== `${legacyId}:managed-source-v1` ||
    audit.attempt !== attempt ||
    audit.repairCount !== (before.repairCount ?? 0) + 1 ||
    after.repairCount !== audit.repairCount ||
    after.lifecycle?.attempt !== attempt ||
    audit.attemptId !== after.lifecycle?.attemptId ||
    !store.holdsLease(`workflow:${id}`) ||
    !nativeRepairSupersessionClosed(store, legacyId)
  )
    throw new Error("Interrupted repair transition lacks exact journal custody")
  const archived = store.get<
    { lifecycle: NativeLifecycle; reason: string; signature: string } & Record<string, unknown>
  >("attempt-evidence", archiveId)
  if (
    !archived ||
    archived.lifecycle.state !== "verification" ||
    archived.lifecycle.attempt !== before.lifecycle.attempt ||
    archived.lifecycle.attemptId !== before.lifecycle.attemptId ||
    archived.reason !== audit.reason ||
    archived.signature !== nativeContentDigest(archived.reason)
  )
    throw new Error("Interrupted repair transition changed original lifecycle or reason")
  for (const field of ["candidate", "verification", "review", "designReview", "riskAssessment", "submission"])
    if (JSON.stringify(archived[field]) !== JSON.stringify(before[field]))
      throw new Error("Interrupted repair transition changed preserved evidence")
  const old = nativeObject(store.get("effect-intent", legacyId), "Superseded repair")
  const replacement = nativeObject(store.get("effect-intent", proof.replacementId), "Confirmed repair")
  const notes = nativeObject(JSON.parse(String(replacement.input.notes)), "Repair replacement context")
  if (
    notes.previousCandidate?.archiveRecordId !== archiveId ||
    notes.previousCandidate.archiveRecordVersion !== proof.archiveVersion ||
    notes.previousCandidate.headSha !== before.candidate?.headSha ||
    notes.previousCandidate.baseSha !== before.candidate?.baseSha ||
    notes.previousCandidate.complete !== true ||
    replacement.card.id !== after.implementationCardId ||
    old.input.workspace?.kind !== "dir" ||
    old.input.workspace.path !== before.candidate?.cwd ||
    replacement.input.workspace?.kind !== "worktree"
  )
    throw new Error("Interrupted repair transition changed candidate or assigned replacement")
  return archived.lifecycle
}
