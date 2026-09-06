import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import {
  acknowledgeNativeNotification,
  type NativeIncidentSignal,
  type NativeNotificationPolicy,
  planNativeNotifications
} from "../packages/core-runtime/src/native/notifications.js"
import { NativeEvidenceStore } from "../packages/core-runtime/src/native/store.js"

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn()
})
function setup() {
  const root = mkdtempSync(join(tmpdir(), "native-notifications-"))
  const path = join(root, "evidence.db")
  const store = new NativeEvidenceStore(path)
  cleanups.push(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  return { store, path }
}
const policy: NativeNotificationPolicy = {
  enabled: true,
  quietHours: { timeZone: "UTC", startHour: 23, endHour: 8 },
  urgentBypassQuietHours: true
}
const signal: NativeIncidentSignal = { workflowId: "workflow", attemptId: "attempt", cause: "approval_required" }
const noon = Date.parse("2026-09-06T12:00:00Z")
it("one blocker creates one durable delivery id across retry and restart", async () => {
  const { store, path } = setup()
  const first = await planNativeNotifications(store, "board", [signal], policy, noon)
  expect(first).toHaveLength(1)
  const second = new NativeEvidenceStore(path)
  try {
    expect(await planNativeNotifications(second, "board", [signal], policy, noon + 1000)).toEqual(first)
  } finally {
    second.close()
  }
  acknowledgeNativeNotification(store, first[0]!.id, noon + 2000)
  expect(await planNativeNotifications(store, "board", [signal], policy, noon + 10_000)).toEqual([])
  expect(store.list("notification-outbox")).toHaveLength(1)
})
it("quiet hours suppress ordinary delivery; urgent bypass and reminders are explicit", async () => {
  const { store } = setup()
  const night = Date.parse("2026-09-06T23:30:00Z")
  expect(await planNativeNotifications(store, "board", [signal], policy, night)).toEqual([])
  const urgent = { ...signal, cause: "uncertain_effect" as const }
  const first = await planNativeNotifications(store, "board", [signal, urgent], policy, night)
  expect(first).toHaveLength(1)
  expect(first[0]?.urgency).toBe("urgent")
  acknowledgeNativeNotification(store, first[0]!.id, night)
  expect(
    await planNativeNotifications(store, "board", [urgent], { ...policy, reminderMs: 60_000 }, night + 60_000)
  ).toHaveLength(1)
})
it("resolution cancels stale pending messages and reappearance creates a new generation", async () => {
  const { store } = setup()
  const first = await planNativeNotifications(store, "board", [signal], policy, noon)
  expect(await planNativeNotifications(store, "board", [], policy, noon + 1000)).toEqual([])
  expect(store.get<any>("notification-outbox", first[0]!.id)?.state).toBe("cancelled")
  const reopened = await planNativeNotifications(store, "board", [signal], policy, noon + 2000)
  expect(reopened[0]!.id).not.toBe(first[0]!.id)
  expect(reopened[0]!.incidentId).toBe(first[0]!.incidentId)
})
it("ignores injected logs and leaves workflow authority unchanged", async () => {
  const { store } = setup()
  const messages = await planNativeNotifications(
    store,
    "board",
    [{ ...signal, rawLog: "PRIVATE_SECRET" } as NativeIncidentSignal],
    policy,
    noon
  )
  expect(JSON.stringify(messages)).not.toContain("PRIVATE_SECRET")
  expect(store.list("workflow")).toEqual([])
  expect(store.get("control", "pause")).toBeNull()
})

it("holds ordinary incidents for the configured digest window", async () => {
  const { store } = setup()
  const preferences = { ...policy, digestMs: 60_000 }
  expect(await planNativeNotifications(store, "board", [signal], preferences, noon)).toEqual([])
  expect(await planNativeNotifications(store, "board", [signal], preferences, noon + 59_000)).toEqual([])
  expect(await planNativeNotifications(store, "board", [signal], preferences, noon + 60_000)).toHaveLength(1)
})
