import { describe, expect, it, vi } from "vitest"
import {
  isNativeAutonomyPaused,
  isStateLifecycleContention,
  runScheduledNativeCommand
} from "../apps/dispatcher-cli/src/native-scheduled-contention.js"

describe("scheduled native state-lifecycle contention", () => {
  it("retries the exact transient ownership failure and preserves a successful result", async () => {
    const request = vi
      .fn<() => Promise<{ advanced: number }>>()
      .mockRejectedValueOnce(new Error("Native RPC failed: another OpenClaw process owns state-lifecycle"))
      .mockResolvedValueOnce({ advanced: 2 })
    const wait = vi.fn(async () => undefined)

    await expect(runScheduledNativeCommand("reconcile", request, { wait })).resolves.toEqual({ advanced: 2 })
    expect(request).toHaveBeenCalledTimes(2)
    expect(wait).toHaveBeenCalledWith(7_000)
  })

  it("returns a successful deferred tick after bounded contention", async () => {
    const request = vi.fn(async () => {
      throw new Error("another OpenClaw process owns state-lifecycle")
    })
    const wait = vi.fn(async () => undefined)

    await expect(
      runScheduledNativeCommand("discover", request, { wait, maxAttempts: 3, retryDelayMs: 5 })
    ).resolves.toEqual({
      advanced: 0,
      created: [],
      deferred: true,
      reason: "state lifecycle contention"
    })
    expect(request).toHaveBeenCalledTimes(3)
    expect(wait).toHaveBeenCalledTimes(2)
    expect(wait).toHaveBeenCalledWith(5)
  })

  it("does not hide unrelated RPC failures", async () => {
    const failure = new Error("Gateway authorization unavailable")
    const request = vi.fn(async () => {
      throw failure
    })
    const wait = vi.fn(async () => undefined)

    await expect(runScheduledNativeCommand("dispatch", request, { wait })).rejects.toBe(failure)
    expect(request).toHaveBeenCalledTimes(1)
    expect(wait).not.toHaveBeenCalled()
  })

  it("treats a paused scheduled discovery tick as a successful no-op", async () => {
    const request = vi.fn(async () => {
      throw new Error("Native RPC autocode.discover failed: Native autonomy is paused or authorization was revoked")
    })
    const wait = vi.fn(async () => undefined)

    await expect(runScheduledNativeCommand("discover", request, { wait })).resolves.toEqual({
      advanced: 0,
      created: [],
      paused: true,
      reason: "paused"
    })
    expect(request).toHaveBeenCalledTimes(1)
    expect(wait).not.toHaveBeenCalled()
  })

  it("treats a human-promotion policy pause as a successful no-op", async () => {
    const request = vi.fn(async () => {
      throw new Error("Skill or policy changed; evaluated human promotion required before resume or execution")
    })

    await expect(runScheduledNativeCommand("discover", request)).resolves.toEqual({
      advanced: 0,
      created: [],
      paused: true,
      reason: "paused"
    })
  })

  it("recognizes wrapped SDK errors without matching adjacent lifecycle states", () => {
    expect(
      isStateLifecycleContention(
        new Error("Native SDK failed", { cause: new Error("another OpenClaw process owns state-lifecycle") })
      )
    ).toBe(true)
    expect(isStateLifecycleContention(new Error("another OpenClaw process owns gateway-lifecycle"))).toBe(false)
    expect(
      isNativeAutonomyPaused(
        new Error("Native SDK failed", { cause: new Error("Native autonomy is paused or authorization was revoked") })
      )
    ).toBe(true)
    expect(isNativeAutonomyPaused(new Error("Native autonomy is running"))).toBe(false)
  })
})
