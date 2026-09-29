import { describe, expect, it, vi } from "vitest"
import { retryContendedDiscovery } from "../apps/dispatcher-cli/src/native-discovery-retry.js"

describe("native discovery lease retry", () => {
  it("retries a reconcile overlap and returns the native discovery result", async () => {
    const discover = vi
      .fn()
      .mockResolvedValueOnce({ created: [], reason: "reconciliation already running" })
      .mockResolvedValueOnce({ created: ["investigation-card"] })
    const wait = vi.fn().mockResolvedValue(undefined)

    expect(await retryContendedDiscovery(discover, wait)).toEqual({ created: ["investigation-card"] })
    expect(discover).toHaveBeenCalledTimes(2)
    expect(wait).toHaveBeenCalledOnce()
    expect(wait).toHaveBeenCalledWith(7_000)
  })

  it("does not retry a substantive native backpressure result", async () => {
    const discover = vi.fn().mockResolvedValue({ created: [], reason: "persona round still active" })
    const wait = vi.fn()

    expect(await retryContendedDiscovery(discover, wait)).toEqual({
      created: [],
      reason: "persona round still active"
    })
    expect(wait).not.toHaveBeenCalled()
  })

  it("bounds a persistent reconcile overlap", async () => {
    const result = { created: [], reason: "reconciliation already running" }
    const discover = vi.fn().mockResolvedValue(result)
    const wait = vi.fn().mockResolvedValue(undefined)

    expect(await retryContendedDiscovery(discover, wait, 3)).toEqual(result)
    expect(discover).toHaveBeenCalledTimes(3)
    expect(wait).toHaveBeenCalledTimes(2)
  })

  it("propagates a native gateway error", async () => {
    const discover = vi.fn().mockRejectedValue(new Error("gateway unavailable"))
    const wait = vi.fn()

    await expect(retryContendedDiscovery(discover, wait)).rejects.toThrow("gateway unavailable")
    expect(wait).not.toHaveBeenCalled()
  })
})
