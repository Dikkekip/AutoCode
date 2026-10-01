import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { nativeCoderAgentIds } from "@openclaw/domain"
import { assertExecutionOwnership } from "@openclaw/os-adapters"
import { nativeCustodyLocalEvidence, nativeCustodyLocalIdentity } from "./custody-local-evidence.js"
import { type NativeCard, nativeCardIdempotencyKey, nativeCards } from "./gateway.js"
import { requireNativeHuman } from "./governance.js"
import { assertNativePolicyRemoteIdle, nativeLoadedPolicyDigest } from "./policy-refresh.js"
import { nativeRepairSupersessionClosed } from "./repair-intent.js"
import type { NativeAutonomyRuntime } from "./runtime.js"
import { nativeRuntimeGeneration } from "./runtime-lifetime.js"
import type { NativeEvidenceStore } from "./store.js"

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const kind = "effect-custody"
function intentSnapshot(store: NativeEvidenceStore, id: string) {
  const row = store.db.prepare("SELECT data FROM native_records WHERE kind='effect-intent' AND id=?").get(id)
  if (!row) throw new Error("Original intent missing")
  const value = JSON.parse(String(row.data))
  if (
    value.state !== "pending" ||
    value.card ||
    !value.input ||
    typeof value.input.idempotencyKey !== "string" ||
    id !== `card:${value.input.idempotencyKey}`
  )
    throw new Error("Only exact pending card-create intents can be held")
  return {
    id,
    version: store.version("effect-intent", id),
    rawSha256: createHash("sha256").update(String(row.data)).digest("hex"),
    inputSha256: digest(value.input),
    key: value.input.idempotencyKey,
    title: value.input.title,
    boardId: value.input.boardId
  }
}
function ownerSnapshot(store: NativeEvidenceStore, id: string) {
  const match = /^card:workflow:([a-f0-9]{64}):(implement|repair:\d+)$/.exec(id)
  if (!match) throw new Error("Unsupported pending intent owner")
  const workflowId = match[1]!,
    workflow = store.get<any>("workflow", workflowId),
    admission = store.get<any>("admission", workflowId)
  const records = {
    workflowId,
    workflowVersion: store.version("workflow", workflowId),
    admissionVersion: store.version("admission", workflowId),
    workflowSha256: digest(workflow ?? null),
    admissionSha256: digest(admission ?? null)
  }
  if (!workflow && !admission && match[2] === "implement")
    return { ...records, classification: "missing-workflow-and-admission" }
  if (
    !workflow ||
    !admission ||
    workflow.lifecycle?.state !== "blocked" ||
    !String(workflow.blocker).includes("workspace path is outside") ||
    workflow.reviewCardId ||
    workflow.deployedSha ||
    workflow.prNumber ||
    workflow.mergedSha
  )
    throw new Error("Owner is not an explicitly rejected blocked workflow")
  const repair = /^repair:(\d+)$/.exec(match[2]!)
  if (!repair || Number(repair[1]) !== workflow.lifecycle.attempt + 1) throw new Error("Blocked repair attempt differs")
  const archiveId = `${workflowId}:${repair[1]}`,
    archive = store.get<any>("attempt-evidence", archiveId)
  if (
    !archive ||
    archive.lifecycle?.attemptId !== workflow.lifecycle.attemptId ||
    archive.lifecycle?.attempt !== workflow.lifecycle.attempt ||
    !["design_wait", "verification", "review_wait"].includes(archive.lifecycle.state) ||
    !archive.reason ||
    !archive.observation ||
    ["candidate", "designReview", "riskAssessment", "submission"].some(
      (key) => !isDeepStrictEqual(archive[key], workflow[key])
    )
  )
    throw new Error("Blocked rejection lacks preserved exact attempt archive")
  return {
    ...records,
    classification: "blocked-local-create-rejection",
    archiveId,
    archiveVersion: store.version("attempt-evidence", archiveId),
    archiveSha256: digest(archive)
  }
}
function preparedEvent(store: NativeEvidenceStore, id: string) {
  const rows = store.db
    .prepare("SELECT id,data,created_at FROM native_events WHERE kind='effect.prepared' AND subject=? ORDER BY id")
    .all(id)
  if (rows.length !== 1) throw new Error("Original preparation history is ambiguous")
  const row = rows[0]!,
    value = JSON.parse(String(row.data))
  if (`card:${value.correlationKey}` !== id) throw new Error("Original preparation identity mismatch")
  return { id: Number(row.id), at: Number(row.created_at), dataSha256: digest(value) }
}
function heldKeyAliases(key: string) {
  const normalized = nativeCardIdempotencyKey(key)
  return new Set([key, normalized, `manual:${key}`, `manual:${normalized}`])
}
export function assertNativeHeldCreateDenied(store: NativeEvidenceStore, key: string) {
  for (const { id, value } of store.list<any>(kind)) {
    if (!nativeEffectCustodyHeld(store, id)) throw new Error("Native held custody changed")
    if (heldKeyAliases(value.entry.intent.key).has(key))
      throw new Error("Native held intent cannot be prepared or replayed")
  }
}
function matchingCard(cards: NativeCard[], entry: { key: string; boardId: string; title?: string }) {
  const aliases = heldKeyAliases(entry.key)
  return cards.some((card) => {
    const key = card.metadata?.automation?.idempotencyKey
    return (
      (card.boardId == null || card.boardId === entry.boardId) &&
      ((typeof key === "string" && aliases.has(key)) || (!key && card.title === entry.title))
    )
  })
}
function ownerRemainsHeld(store: NativeEvidenceStore, held: any): boolean {
  const old = held.entry.owner
  try {
    if (isDeepStrictEqual(ownerSnapshot(store, held.entry.intent.id), old)) return true
  } catch {
    /* Only exact native cancellation may follow. */
  }
  if (old.classification !== "blocked-local-create-rejection") return false
  const auditApplied = (planDigest: string, action: string) =>
    store.db
      .prepare("SELECT data FROM native_events WHERE kind='recovery.applied' AND subject=?")
      .all(old.workflowId)
      .some((row) => {
        const event = JSON.parse(String(row.data))
        return event.planDigest === planDigest && event.action === action
      })
  const validCancellation = (current: any, version: number) => {
    const recovery = current?.recovery
    if (
      current?.lifecycle?.state !== "cancelled" ||
      !["cancel", "abandon"].includes(recovery?.action) ||
      version !== old.workflowVersion + 1 ||
      store.version("admission", old.workflowId) !== old.admissionVersion ||
      digest(store.get("admission", old.workflowId) ?? null) !== old.admissionSha256 ||
      store.version("attempt-evidence", old.archiveId) !== old.archiveVersion ||
      digest(store.get("attempt-evidence", old.archiveId)) !== old.archiveSha256
    )
      return false
    const applied = store.get<any>("recovery", recovery.planDigest)
    if (
      applied?.state !== "applied" ||
      applied.result?.workflowId !== old.workflowId ||
      applied.plan?.action !== recovery.action ||
      applied.plan.snapshot?.workflowVersion !== old.workflowVersion ||
      applied.plan.snapshot?.workflowDigest !== old.workflowSha256 ||
      !applied.plan.allowed
    )
      return false
    const previous = store.get<any>(
      "attempt-history",
      `${old.workflowId}:${recovery.fromAttemptId}:${recovery.planDigest}`
    )
    if (
      !previous ||
      digest(previous) !== old.workflowSha256 ||
      previous.lifecycle?.attemptId !== current.lifecycle?.attemptId ||
      previous.lifecycle?.attempt !== current.lifecycle?.attempt
    )
      return false
    const stable = ({ lifecycle: _lifecycle, recovery: _recovery, ...value }: any) => value
    return isDeepStrictEqual(stable(previous), stable(current)) && auditApplied(recovery.planDigest, recovery.action)
  }
  const current = store.get<any>("workflow", old.workflowId),
    version = store.version("workflow", old.workflowId)
  if (validCancellation(current, version)) return true
  if (version !== old.workflowVersion + 2 || typeof current?.archivedAt !== "string" || !current.archivedAt)
    return false
  return store.list<any>("recovery").some(({ id, value }) => {
    const plan = value.plan
    if (
      value.state !== "applied" ||
      value.result?.workflowId !== old.workflowId ||
      plan?.action !== "archive" ||
      !plan.allowed ||
      plan.snapshot?.workflowVersion !== old.workflowVersion + 1
    )
      return false
    const previous = store.get<any>("attempt-history", `${old.workflowId}:${current.lifecycle?.attemptId}:${id}`)
    if (
      !previous ||
      digest(previous) !== plan.snapshot.workflowDigest ||
      !validCancellation(previous, plan.snapshot.workflowVersion)
    )
      return false
    const { archivedAt: _archivedAt, ...unarchived } = current
    return isDeepStrictEqual(unarchived, previous) && auditApplied(id, "archive")
  })
}
export function nativeEffectCustodyHeld(store: NativeEvidenceStore, id: string): boolean {
  const held = store.get<any>(kind, id)
  if (
    !held ||
    held.state !== "unresolved-held-no-replay" ||
    store.version(kind, id) !== 1 ||
    !held.operatorId ||
    !held.reason
  )
    return false
  try {
    if (
      !isDeepStrictEqual(intentSnapshot(store, id), held.entry.intent) ||
      !ownerRemainsHeld(store, held) ||
      !isDeepStrictEqual(preparedEvent(store, id), held.entry.prepared)
    )
      return false
    const audit = store.db
      .prepare("SELECT data FROM native_events WHERE kind='effect.custody-held' AND subject=?")
      .all(held.boardId)
    return audit.some((row) => {
      const value = JSON.parse(String(row.data))
      const { digest: planDigest, ...planBody } = value.plan ?? {}
      return (
        planDigest === held.planDigest &&
        digest(planBody) === planDigest &&
        value.plan?.outcome === "unresolved-held-no-replay" &&
        value.plan?.externalSuccessConfirmed === false &&
        value.plan?.fullWireCorrelationAvailable === false &&
        value.plan?.boardId === held.boardId &&
        value.plan?.reason === held.reason &&
        Array.isArray(value.plan?.entries) &&
        value.plan.entries.some((entry: unknown) => isDeepStrictEqual(entry, held.entry)) &&
        value.planDigest === held.planDigest &&
        value.operatorId === held.operatorId &&
        value.reason === held.reason &&
        Array.isArray(value.entries) &&
        value.entries.some((entry: unknown) => isDeepStrictEqual(entry, held.entry))
      )
    })
  } catch {
    return false
  }
}
export function assertNativeHeldCardAbsence(store: NativeEvidenceStore, cards: NativeCard[]) {
  for (const { id, value } of store.list<any>(kind)) {
    if (!nativeEffectCustodyHeld(store, id)) throw new Error("Native held custody changed")
    if (matchingCard(cards, value.entry.intent))
      throw new Error("Held intent has a matching remote card; native execution remains blocked")
  }
}
function localQuiescence(runtime: NativeAutonomyRuntime, ids: string[]) {
  if (!runtime.control.state.paused || runtime.store.get<any>("control", "pause")?.paused !== true)
    throw new Error("Pause native execution before custody disposition")
  if (runtime.store.db.prepare("SELECT 1 FROM native_locks WHERE expires_at>? LIMIT 1").get(Date.now()))
    throw new Error("Native operation remains active")
  if (runtime.store.list<any>("operation").some(({ value }) => value.state !== "confirmed"))
    throw new Error("Uncertain operations cannot be held")
  for (const { id, value } of runtime.store.list<any>("effect-intent")) {
    if (
      value.state !== "confirmed" &&
      !nativeRepairSupersessionClosed(runtime.store, id) &&
      !nativeEffectCustodyHeld(runtime.store, id) &&
      !ids.includes(id)
    )
      throw new Error("Unselected uncertain intent remains")
  }
}
export async function planNativeEffectCustody(runtime: NativeAutonomyRuntime, intentIds: unknown, reason: unknown) {
  if (
    !Array.isArray(intentIds) ||
    !intentIds.length ||
    intentIds.length > 20 ||
    intentIds.some((id) => typeof id !== "string") ||
    new Set(intentIds).size !== intentIds.length
  )
    throw new Error("Exact unique pending intent IDs required")
  if (typeof reason !== "string" || !reason.trim() || reason.length > 2000)
    throw new Error("Bounded operator custody reason required")
  const ids = [...intentIds].sort() as string[]
  localQuiescence(runtime, ids)
  const revision = runtime.control.state.revision,
    generation = nativeRuntimeGeneration(runtime),
    policyDigest = nativeLoadedPolicyDigest(runtime.policy)
  const entries = ids.map((id) => {
    if (runtime.store.get(kind, id)) throw new Error("Custody disposition already exists")
    const intent = intentSnapshot(runtime.store, id),
      owner = ownerSnapshot(runtime.store, id),
      prepared = preparedEvent(runtime.store, id)
    if (intent.boardId !== runtime.policy.boardId) throw new Error("Intent board differs from owning runtime")
    return { intent, owner, prepared, local: nativeCustodyLocalEvidence(prepared.at) }
  })
  await assertNativePolicyRemoteIdle(runtime, runtime.gateway)
  const cards = await nativeCards(runtime.gateway, runtime.policy.boardId)
  if (
    cards.some(
      (card) =>
        ["running", "ready", "scheduled"].includes(card.status) ||
        ["pending", "running"].includes(card.execution?.status ?? "") ||
        (card.metadata?.automation as Record<string, any> | undefined)?.launch?.phase === "prepared"
    )
  )
    throw new Error("Workboard work is active or runnable")
  assertNativeHeldCardAbsence(runtime.store, cards)
  if (entries.some((entry) => matchingCard(cards, entry.intent)))
    throw new Error("Pending intent already has a matching card")
  localQuiescence(runtime, ids)
  if (
    runtime.control.state.revision !== revision ||
    nativeRuntimeGeneration(runtime) !== generation ||
    nativeLoadedPolicyDigest(runtime.policy) !== policyDigest
  )
    throw new Error("Custody authority changed")
  for (const entry of entries) {
    if (
      !isDeepStrictEqual(intentSnapshot(runtime.store, entry.intent.id), entry.intent) ||
      !isDeepStrictEqual(ownerSnapshot(runtime.store, entry.intent.id), entry.owner) ||
      !isDeepStrictEqual(preparedEvent(runtime.store, entry.intent.id), entry.prepared)
    )
      throw new Error("Custody source changed")
  }
  const identity = nativeCustodyLocalIdentity()
  for (const entry of entries)
    for (const key of Object.keys(identity))
      if (!isDeepStrictEqual((entry.local as Record<string, unknown>)[key], (identity as Record<string, unknown>)[key]))
        throw new Error("Local transport or process identity changed")
  const body = {
    version: 1,
    policyDigest,
    boardId: runtime.policy.boardId,
    revision,
    generation,
    reason: reason.trim(),
    entries,
    observedCardCount: cards.length,
    outcome: "unresolved-held-no-replay",
    externalSuccessConfirmed: false,
    fullWireCorrelationAvailable: false
  }
  return { ...body, digest: digest(body) }
}
export async function applyNativeEffectCustody(
  runtime: NativeAutonomyRuntime,
  plan: any,
  operatorId: string,
  assertGeneration: () => void
) {
  requireNativeHuman({ operatorId, rationale: plan?.reason }, [
    runtime.policy.plannerAgentId,
    ...nativeCoderAgentIds(runtime.policy),
    runtime.policy.reviewerAgentId,
    ...runtime.policy.personas.flatMap((p) => [p.personaId, p.investigationAgentId ?? p.personaId])
  ])
  if (!plan || !Array.isArray(plan.entries) || typeof plan.digest !== "string")
    throw new Error("Exact custody plan required")
  const { digest: expectedDigest, ...body } = plan
  if (digest(body) !== expectedDigest) throw new Error("Forged custody plan")
  const fresh = await planNativeEffectCustody(
    runtime,
    plan?.entries?.map((entry: any) => entry.intent.id),
    plan?.reason
  )
  if (!isDeepStrictEqual(fresh, plan)) throw new Error("Custody plan changed; generate and review a fresh plan")
  assertGeneration()
  localQuiescence(
    runtime,
    fresh.entries.map((entry) => entry.intent.id)
  )
  runtime.store.commit(
    fresh.entries.map((entry) => ({
      kind,
      id: entry.intent.id,
      expectedVersion: 0,
      value: {
        state: "unresolved-held-no-replay",
        boardId: fresh.boardId,
        entry,
        planDigest: plan.digest,
        operatorId,
        reason: fresh.reason
      }
    })),
    {
      kind: "effect.custody-held",
      subject: fresh.boardId,
      value: {
        plan,
        entries: fresh.entries,
        planDigest: plan.digest,
        operatorId,
        reason: fresh.reason,
        uncertainty: fresh.outcome,
        externalSuccessConfirmed: false
      }
    },
    undefined,
    () => {
      assertGeneration()
      assertExecutionOwnership()
      localQuiescence(
        runtime,
        fresh.entries.map((entry) => entry.intent.id)
      )
      if (
        nativeLoadedPolicyDigest(runtime.policy) !== fresh.policyDigest ||
        runtime.control.state.revision !== fresh.revision
      )
        throw new Error("Loaded policy or pause authority changed before custody commit")
      const identity = nativeCustodyLocalIdentity()
      for (const entry of fresh.entries)
        for (const key of Object.keys(identity))
          if (
            !isDeepStrictEqual(
              (entry.local as Record<string, unknown>)[key],
              (identity as Record<string, unknown>)[key]
            )
          )
            throw new Error("Local owner changed before custody commit")
      for (const entry of fresh.entries)
        if (
          !isDeepStrictEqual(intentSnapshot(runtime.store, entry.intent.id), entry.intent) ||
          !isDeepStrictEqual(ownerSnapshot(runtime.store, entry.intent.id), entry.owner) ||
          !isDeepStrictEqual(preparedEvent(runtime.store, entry.intent.id), entry.prepared)
        )
          throw new Error("Custody changed before commit")
    }
  )
  for (const entry of fresh.entries)
    if (!isDeepStrictEqual(intentSnapshot(runtime.store, entry.intent.id), entry.intent))
      throw new Error("Original pending bytes unexpectedly changed")
  return {
    held: fresh.entries.map((entry) => entry.intent.id),
    originalIntentRecordsUnchanged: true,
    externalSuccessConfirmed: false,
    uncertainty: fresh.outcome
  }
}
