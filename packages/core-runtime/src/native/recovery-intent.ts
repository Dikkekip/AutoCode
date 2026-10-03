/** Reconcile only an unaccepted recovery intent whose immutable archive link predates a fresh plan. */
import {
  decodeNativeCard,
  type NativeCard,
  type NativeGateway,
  nativeCardIdempotencyKey,
  nativeObject
} from "./gateway.js"
import { type NativeRecoveryPlan, nativeRecoveryDigest } from "./recovery.js"
import type { NativeWorkflow } from "./runtime.js"
import type { NativeEvidenceStore, NativeRecordWrite } from "./store.js"

export function prepareNativeRecoveryIntent(
  store: NativeEvidenceStore,
  plan: NativeRecoveryPlan,
  before: NativeWorkflow,
  input: Record<string, unknown>
) {
  const id = `card:${String(input.idempotencyKey)}`
  const pending = store.get<{ state: string; input: Record<string, unknown>; card?: NativeCard }>("effect-intent", id)
  if (!pending || JSON.stringify(pending.input) === JSON.stringify(input)) return undefined
  const fail = () => new Error("Pending recovery intent cannot be reconciled with this fresh plan")
  if (pending.state !== "pending" || pending.card || plan.action !== "retry" || !plan.allowed) throw fail()
  const parseNotes = (value: unknown) => {
    if (typeof value !== "string") throw fail()
    return nativeObject(JSON.parse(value), "Recovery intent notes")
  }
  const oldNotes = parseNotes(pending.input.notes)
  const newNotes = parseNotes(input.notes)
  const oldCandidate = nativeObject(oldNotes.previousCandidate, "Recovery intent candidate")
  const newCandidate = nativeObject(newNotes.previousCandidate, "Recovery candidate")
  const prefix = `${plan.snapshot.workflowId}:${plan.snapshot.lifecycle.attemptId}:`
  const archiveId = oldCandidate.archiveRecordId
  if (
    !before.candidate ||
    oldCandidate.complete !== true ||
    newCandidate.complete !== true ||
    typeof archiveId !== "string" ||
    !archiveId.startsWith(prefix) ||
    !/^[a-f0-9]{64}$/.test(archiveId.slice(prefix.length)) ||
    oldCandidate.archiveRecordVersion !== 1 ||
    newCandidate.archiveRecordId !== `${prefix}${plan.digest}` ||
    newCandidate.archiveRecordVersion !== 1
  )
    throw fail()
  const preparedPlanDigest = archiveId.slice(prefix.length)
  const prepared = store.get<{ state: string; plan: NativeRecoveryPlan; operator: string }>(
    "recovery",
    preparedPlanDigest
  )
  if (
    !prepared ||
    prepared.state !== "prepared" ||
    !prepared.operator?.trim() ||
    prepared.plan.digest !== preparedPlanDigest ||
    nativeRecoveryDigest({ ...prepared.plan, digest: undefined }) !== preparedPlanDigest ||
    prepared.plan.action !== "retry" ||
    !prepared.plan.allowed ||
    prepared.plan.reason !== plan.reason ||
    nativeRecoveryDigest({ ...prepared.plan.snapshot, control: undefined }) !==
      nativeRecoveryDigest({ ...plan.snapshot, control: undefined })
  )
    throw fail()
  // Only the newly generated archive reference may differ. Candidate bytes,
  // source, agent, proposal, instructions and the operator reason remain exact.
  const normalized = {
    ...input,
    notes: JSON.stringify({
      ...newNotes,
      previousCandidate: {
        ...newCandidate,
        archiveRecordId: archiveId,
        archiveRecordVersion: oldCandidate.archiveRecordVersion
      }
    })
  }
  if (JSON.stringify(normalized) !== JSON.stringify(pending.input)) throw fail()
  const archive = store.get<NativeWorkflow>("attempt-history", archiveId)
  const archiveVersion = store.version("attempt-history", archiveId)
  if (archive && (archiveVersion !== 1 || nativeRecoveryDigest(archive) !== nativeRecoveryDigest(before))) throw fail()
  if (!archive && archiveVersion !== 0) throw fail()
  const intentVersion = store.version("effect-intent", id)
  const preparedVersion = store.version("recovery", preparedPlanDigest)
  const assertEvidence = () => {
    store.authorizeEffect()
    if (
      store.version("recovery", preparedPlanDigest) !== preparedVersion ||
      store.version("attempt-history", archiveId) !== archiveVersion
    )
      throw new Error("Preserved recovery intent evidence changed during preparation")
  }
  const assertPending = () => {
    assertEvidence()
    if (store.version("effect-intent", id) !== intentVersion)
      throw new Error("Pending recovery intent changed during preparation")
  }
  const writes: NativeRecordWrite[] = archive
    ? []
    : [{ kind: "attempt-history", id: archiveId, value: before, expectedVersion: 0 }]
  return {
    input: pending.input,
    writes,
    reference: { id, preparedPlanDigest },
    assertPending,
    assertConfirmed(card: NativeCard) {
      assertEvidence()
      const confirmed = store.get<{ state: string; input: unknown; card?: NativeCard }>("effect-intent", id)
      if (
        store.version("effect-intent", id) !== intentVersion + 1 ||
        confirmed?.state !== "confirmed" ||
        JSON.stringify(confirmed.input) !== JSON.stringify(pending.input) ||
        JSON.stringify(confirmed.card) !== JSON.stringify(card)
      )
        throw new Error("Recovery intent confirmation changed during preparation")
    },
    async assertAbsent(gateway: NativeGateway, assertCurrent: () => void) {
      assertCurrent()
      assertPending()
      // Query all boards: an accepted card under this key must never be treated
      // as an unaccepted effect merely because its board assignment changed.
      const result = nativeObject(await gateway.request("workboard.cards.list", {}), "Recovery cards.list")
      assertCurrent()
      assertPending()
      if (
        !Array.isArray(result.cards) ||
        (result.hasMore !== undefined && result.hasMore !== false) ||
        result.nextCursor != null ||
        result.nextOffset != null ||
        (result.totalCount !== undefined &&
          (!Number.isSafeInteger(result.totalCount) || result.totalCount !== result.cards.length))
      )
        throw new Error("Recovery requires a complete all-card absence check")
      const cards = result.cards.map((value: unknown) => decodeNativeCard(value))
      if (new Set(cards.map((card) => card.id)).size !== cards.length)
        throw new Error("Recovery card absence check contains duplicate identities")
      const externalKey = nativeCardIdempotencyKey(String(input.idempotencyKey))
      if (
        cards.some((card) => {
          const key = card.metadata?.automation?.idempotencyKey
          return key === externalKey || (card.title === input.title && (typeof key !== "string" || !key))
        })
      )
        throw new Error("Recovery card already exists or its acceptance is uncertain; reconcile remote custody")
    }
  }
}
