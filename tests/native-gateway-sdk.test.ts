import { expect, it, vi } from "vitest"
import { type NativeGatewaySdkCall, NativeSdkGateway } from "../packages/core-runtime/src/native/gateway.js"

it("uses the public in-process Gateway call with the existing method deadlines", async () => {
  const call = vi.fn<NativeGatewaySdkCall>(async () => ({ cards: [] }))
  const gateway = new NativeSdkGateway("/usr/bin/openclaw", async () => call)
  expect(await gateway.request("workboard.cards.list", { boardId: "test-board" })).toEqual({ cards: [] })
  expect(call).toHaveBeenCalledWith(
    "workboard.cards.list",
    { json: true, timeout: "180000" },
    { boardId: "test-board" },
    { progress: false }
  )
  await gateway.request("workboard.cards.create", { boardId: "test-board" })
  expect(call.mock.calls[1]?.[1]).toEqual({ json: true, timeout: "30000" })
})

it("reports SDK failures without exposing the executable path", async () => {
  const gateway = new NativeSdkGateway("/private/bin/openclaw", async () => async () => {
    throw new Error("Gateway unavailable")
  })
  const error = await gateway.request("workboard.cards.list", { boardId: "test-board" }).catch((value) => value)
  expect(error.message).toBe("Native RPC workboard.cards.list failed: Gateway unavailable")
  expect(error.message).not.toContain("/private/bin/openclaw")
})
