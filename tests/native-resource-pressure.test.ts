import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import {
  NativeResourceGuard,
  type NativeResourceSample
} from "../packages/core-runtime/src/native/resource-pressure.js"
import { NativeAutonomyRuntime } from "../packages/core-runtime/src/native/runtime.js"
import { NativeEvidenceStore } from "../packages/core-runtime/src/native/store.js"
import { validateNativeResourceControls } from "../packages/domain/src/native-autonomy.js"

const MiB = 1024 * 1024
const healthy = (): NativeResourceSample => ({
  totalBytes: 16 * 1024 * MiB,
  availableBytes: 8 * 1024 * MiB,
  gatewayRssBytes: 1024 * MiB,
  memoryFullAvg10: 0,
  cpuCount: 8,
  loadAverage1m: 2
})
const cleanup: Array<() => void> = []
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn()
})

it.each([
  ["host-memory", { availableBytes: 3000 * MiB }],
  ["gateway-memory", { gatewayRssBytes: 3072 * MiB }],
  ["memory-stall", { memoryFullAvg10: 5 }],
  ["cpu-load", { loadAverage1m: 10 }]
])("holds new work for %s and recovers only after stable headroom", (reason, patch) => {
  let now = 0
  let sample = { ...healthy(), ...patch }
  const guard = new NativeResourceGuard(
    undefined,
    () => sample,
    () => now
  )
  expect(guard.inspect()).toMatchObject({ allowed: false, reasons: [reason], startCapacity: 0 })
  sample = healthy()
  now = 59_999
  expect(guard.inspect().reasons).toEqual(["recovery-hold"])
  now = 60_000
  expect(guard.inspect()).toMatchObject({ allowed: true, reasons: [], startCapacity: 2 })
})

it("reserves room for the next worker rather than checking only current free memory", () => {
  const guard = new NativeResourceGuard({ minAvailableMiB: 2048, workerReserveMiB: 1536 }, () => ({
    ...healthy(),
    availableBytes: 3500 * MiB
  }))
  expect(guard.inspect().allowed).toBe(false)
})

it.each([NaN, -1, Infinity])("fails closed on invalid memory telemetry: %s", (availableBytes) => {
  expect(new NativeResourceGuard(undefined, () => ({ ...healthy(), availableBytes })).inspect()).toMatchObject({
    allowed: false,
    reasons: ["telemetry-unavailable"]
  })
})

it("fails closed when the sampler cannot read required telemetry", () => {
  expect(
    new NativeResourceGuard(undefined, () => {
      throw new Error("unreadable")
    }).inspect().allowed
  ).toBe(false)
})

it("validates bounded operator settings", () => {
  expect(validateNativeResourceControls({ minAvailableMiB: 2048, maxCpuLoadPercent: 100 })).toEqual({
    minAvailableMiB: 2048,
    maxCpuLoadPercent: 100
  })
  for (const value of [
    null,
    [],
    { workerReserveMiB: 0 },
    { maxGatewayRssMiB: Number.NaN },
    { recoveryHoldSeconds: 0 },
    { maxMemoryPressurePercent: 101 },
    { maxCpuLoadPercent: 401 }
  ])
    expect(() => validateNativeResourceControls(value)).toThrow()
})

it("shares reserved headroom across boards and releases it exactly once", () => {
  const sample = () => ({ ...healthy(), availableBytes: 5 * 1024 * MiB })
  const first = new NativeResourceGuard(undefined, sample)
  const second = new NativeResourceGuard(undefined, sample)
  expect(first.inspect().startCapacity).toBe(1)
  const release = first.reserve(2 * 1024 * MiB)
  try {
    expect(second.inspect()).toMatchObject({ allowed: false, reasons: ["host-memory"] })
  } finally {
    release()
    release()
  }
  expect(new NativeResourceGuard(undefined, sample).inspect().startCapacity).toBe(1)
})

it("defers dispatch and verification without losing queued work, then retries after recovery", async () => {
  const root = mkdtempSync(join(tmpdir(), "native-resource-test-"))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const store = new NativeEvidenceStore(join(root, "evidence.db"))
  cleanup.push(() => store.close())
  let sample = { ...healthy(), availableBytes: 512 * MiB }
  let now = 0
  const guard = new NativeResourceGuard(
    undefined,
    () => sample,
    () => now
  )
  const request = vi.fn(async (method: string) =>
    method === "workboard.cards.list" ? { cards: [] } : { started: [{}], startedCardIds: ["queued"], deferred: [] }
  )
  const policy = {
    enabled: true,
    mode: "implement-human-review",
    workerConcurrency: 8,
    repository: root,
    boardId: "board",
    repositoryKind: "framework"
  } as any
  const runtime = new NativeAutonomyRuntime(policy, { request: request as any }, store, undefined, guard)
  const action = vi.fn(async () => "verified")
  expect(await runtime.withCapacity("verification", 1, action)).toBeNull()
  expect(action).not.toHaveBeenCalled()
  const deferred = await runtime.reconcile({ dispatchOnly: true })
  expect(deferred.dispatch).toMatchObject({ startedCount: 0, resourcePressure: { allowed: false } })
  expect(request).not.toHaveBeenCalledWith("workboard.cards.dispatchWithOptions", expect.anything())
  sample = healthy()
  now = 60_000
  expect(await runtime.withCapacity("verification", 1, action)).toBe("verified")
  expect((await runtime.reconcile({ dispatchOnly: true })).dispatch?.startedCardIds).toEqual(["queued"])
  expect(request).toHaveBeenCalledWith("workboard.cards.dispatchWithOptions", { boardId: "board", maxStarts: 2 })
})

it("reserves the configured verifier limit when it exceeds the worker estimate", () => {
  const guard = new NativeResourceGuard({ minAvailableMiB: 3072 }, () => ({ ...healthy(), availableBytes: 6000 * MiB }))
  expect(guard.inspect()).toMatchObject({ allowed: true, workerBytes: 2048 * MiB })
  expect(guard.inspect(4096 * MiB)).toMatchObject({ allowed: false, reasons: ["host-memory"], workerBytes: 4096 * MiB })
})
