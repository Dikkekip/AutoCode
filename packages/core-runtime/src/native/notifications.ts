// New: channel-neutral incident/outbox policy. Produces local delivery intents only; never sends messages.
import { createHash } from "node:crypto"
import type { NativeEvidenceStore } from "./store.js"
export type NativeIncidentCause =
  | "approval_required"
  | "uncertain_effect"
  | "repair_repeated"
  | "budget_exhausted"
  | "rollback"
  | "verified_completion"
export interface NativeIncidentSignal {
  workflowId: string
  attemptId: string
  cause: NativeIncidentCause
}
export interface NativeNotificationPolicy {
  enabled: boolean
  quietHours: { timeZone: string; startHour: number; endHour: number }
  urgentBypassQuietHours: boolean
  reminderMs?: number
  digestMs?: number
}
export interface NativeNotification {
  id: string
  incidentId: string
  boardId: string
  workflowId: string
  attemptId: string
  cause: NativeIncidentCause
  urgency: "normal" | "urgent"
  summary: string
  nextAction: string
  evidencePointer: string
  state: "pending" | "delivered" | "cancelled"
  createdAt: number
  deliveredAt?: number
}
interface Incident extends NativeIncidentSignal {
  boardId: string
  active: boolean
  generation: number
  notificationCount: number
  openedAt: number
  lastPlannedAt?: number
  resolvedAt?: number
}
const descriptions: Record<NativeIncidentCause, { summary: string; nextAction: string; urgent: boolean }> = {
  approval_required: {
    summary: "Independent operator decision required",
    nextAction: "Inspect workflow evidence and its permitted recovery plan",
    urgent: false
  },
  uncertain_effect: {
    summary: "An external effect has an unresolved outcome",
    nextAction: "Inspect the external operation before any retry",
    urgent: true
  },
  repair_repeated: {
    summary: "The workflow has required repeated repair",
    nextAction: "Inspect prior attempt evidence and decide whether to continue",
    urgent: false
  },
  budget_exhausted: {
    summary: "The workflow budget is exhausted",
    nextAction: "Inspect usage and the reviewed budget before admitting more work",
    urgent: false
  },
  rollback: {
    summary: "Deployment rollback was observed",
    nextAction: "Inspect restored revision and health evidence",
    urgent: true
  },
  verified_completion: {
    summary: "Exact-revision deployment was verified",
    nextAction: "Inspect deployment and retention observation evidence",
    urgent: false
  }
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
function quiet(policy: NativeNotificationPolicy, now: number) {
  const { startHour, endHour, timeZone } = policy.quietHours
  if (![startHour, endHour].every((hour) => Number.isInteger(hour) && hour >= 0 && hour < 24))
    throw new Error("Invalid notification quiet hours")
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", { timeZone, hour: "numeric", hourCycle: "h23" }).format(new Date(now))
  )
  return startHour === endHour
    ? false
    : startHour < endHour
      ? hour >= startHour && hour < endHour
      : hour >= startHour || hour < endHour
}
/** Signals describe the complete currently actionable set for this board. Resolution never grants workflow authority. */
export async function planNativeNotifications(
  store: NativeEvidenceStore,
  boardId: string,
  signals: NativeIncidentSignal[],
  policy: NativeNotificationPolicy,
  now = Date.now()
): Promise<NativeNotification[]> {
  if (!Number.isFinite(now) || !boardId) throw new Error("Invalid native notification context")
  const inQuiet = quiet(policy, now)
  if (policy.digestMs !== undefined && (!Number.isSafeInteger(policy.digestMs) || policy.digestMs < 0))
    throw new Error("Invalid notification digest window")
  if (policy.reminderMs !== undefined && (!Number.isSafeInteger(policy.reminderMs) || policy.reminderMs < 60_000))
    throw new Error("Notification reminders must be at least one minute")
  for (const signal of signals)
    if (!signal.workflowId || !signal.attemptId || !Object.hasOwn(descriptions, signal.cause))
      throw new Error("Invalid native incident signal")
  const lease = store.acquire(`notification:${boardId}`, 30_000)
  if (!lease) return []
  return store.withLease(lease, 30_000, async () => {
    const active = new Map(
      signals.map(({ workflowId, attemptId, cause }) => [
        hash([boardId, workflowId, attemptId, cause]),
        { workflowId, attemptId, cause }
      ])
    )
    for (const row of store
      .list<Incident>("notification-incident")
      .filter((r) => r.value.boardId === boardId && r.value.active && !active.has(r.id))) {
      store.put("notification-incident", row.id, { ...row.value, active: false, resolvedAt: now })
      for (const pending of store
        .list<NativeNotification>("notification-outbox")
        .filter((n) => n.value.incidentId === row.id && n.value.state === "pending"))
        store.put("notification-outbox", pending.id, { ...pending.value, state: "cancelled" })
      store.event("notification.resolved", row.id, { boardId })
    }
    for (const [id, signal] of active) {
      const prior = store.get<Incident>("notification-incident", id)
      const incident: Incident = prior?.active
        ? prior
        : {
            ...signal,
            boardId,
            active: true,
            generation: (prior?.generation ?? 0) + 1,
            notificationCount: 0,
            openedAt: now
          }
      const description = descriptions[signal.cause]
      const pending = store
        .list<NativeNotification>("notification-outbox")
        .some((n) => n.value.incidentId === id && n.value.state === "pending")
      const due =
        incident.lastPlannedAt === undefined ||
        (policy.reminderMs !== undefined && now - incident.lastPlannedAt >= policy.reminderMs)
      if (
        policy.enabled &&
        !pending &&
        due &&
        (description.urgent || now - incident.openedAt >= (policy.digestMs ?? 0)) &&
        (!inQuiet || (description.urgent && policy.urgentBypassQuietHours))
      ) {
        const notificationId = `${id}:${incident.generation}:${incident.notificationCount}`
        const notification: NativeNotification = {
          id: notificationId,
          incidentId: id,
          boardId,
          ...signal,
          urgency: description.urgent ? "urgent" : "normal",
          summary: description.summary,
          nextAction: description.nextAction,
          evidencePointer: `native:${encodeURIComponent(boardId)}/workflow/${encodeURIComponent(signal.workflowId)}`,
          state: "pending",
          createdAt: now
        }
        incident.notificationCount++
        incident.lastPlannedAt = now
        store.commit(
          [
            { kind: "notification-incident", id, value: incident },
            { kind: "notification-outbox", id: notificationId, value: notification, expectedVersion: 0 }
          ],
          { kind: "notification.planned", subject: id, value: { notificationId, cause: signal.cause } }
        )
      } else store.put("notification-incident", id, incident)
    }
    return store
      .list<NativeNotification>("notification-outbox")
      .filter(
        (n) =>
          n.value.boardId === boardId &&
          n.value.state === "pending" &&
          policy.enabled &&
          (!inQuiet || (n.value.urgency === "urgent" && policy.urgentBypassQuietHours))
      )
      .map((n) => n.value)
  })
}
/** Delivery adapter calls only after confirmed acceptance; failures leave the same idempotency key pending. */
export function acknowledgeNativeNotification(store: NativeEvidenceStore, id: string, now = Date.now()): void {
  const version = store.version("notification-outbox", id)
  const notification = store.get<NativeNotification>("notification-outbox", id)
  if (!notification || notification.state !== "pending") return
  store.commit(
    [
      {
        kind: "notification-outbox",
        id,
        value: { ...notification, state: "delivered", deliveredAt: now },
        expectedVersion: version
      }
    ],
    { kind: "notification.delivered", subject: notification.incidentId, value: { notificationId: id } }
  )
}

/** Optional reconciliation hook; absent local operator preferences keep delivery planning disabled. */
export async function reconcileNativeNotifications(store: NativeEvidenceStore, boardId: string, now = Date.now()) {
  const policy = store.get<NativeNotificationPolicy>("notification-policy", boardId)
  if (!policy) return []
  const signals: NativeIncidentSignal[] = []
  const operations = store.list<{ state?: string }>("operation")
  for (const { id, value: w } of store.list<{
    lifecycle?: { state: string; attemptId: string }
    repairCount?: number
    deployedSha?: string
  }>("workflow")) {
    if (!w.lifecycle) continue
    const add = (cause: NativeIncidentCause) =>
      signals.push({ workflowId: id, attemptId: w.lifecycle!.attemptId, cause })
    if (["design_wait", "blocked"].includes(w.lifecycle.state)) add("approval_required")
    if ((w.repairCount ?? 0) >= 2) add("repair_repeated")
    if (w.deployedSha) add("verified_completion")
    if (operations.some((op) => op.id.startsWith(`${id}:`) && ["started", "uncertain"].includes(op.value.state ?? "")))
      add("uncertain_effect")
  }
  return planNativeNotifications(store, boardId, signals, policy, now)
}
