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
    { scopes: ["operator.read"], progress: false }
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

it("requests the exact declared scope for every current Workboard method", async () => {
  const call = vi.fn<NativeGatewaySdkCall>(async () => ({}))
  const gateway = new NativeSdkGateway("/usr/bin/openclaw", async () => call)
  for (const method of [
    "workboard.cards.list",
    "workboard.cards.diagnostics",
    "workboard.boards.list",
    "workboard.cards.stats",
    "workboard.cards.runs",
    "workboard.notifications.list",
    "workboard.notifications.events",
    "workboard.cards.attachments.list",
    "workboard.cards.attachments.get",
    "workboard.cards.export"
  ]) {
    await gateway.request(method, {})
    expect(call.mock.calls.at(-1)?.[3]).toEqual({ scopes: ["operator.read"], progress: false })
  }
  for (const method of [
    "workboard.cards.start",
    "workboard.cards.move",
    "workboard.cards.delete",
    "workboard.cards.comment",
    "workboard.cards.link",
    "workboard.cards.linkDependency",
    "workboard.cards.proof",
    "workboard.cards.artifact",
    "workboard.cards.claim",
    "workboard.cards.heartbeat",
    "workboard.cards.release",
    "workboard.cards.promote",
    "workboard.cards.reassign",
    "workboard.cards.reclaim",
    "workboard.cards.complete",
    "workboard.cards.block",
    "workboard.cards.unblock",
    "workboard.cards.diagnostics.refresh",
    "workboard.cards.dispatch",
    "workboard.cards.dispatchWithOptions",
    "workboard.boards.archive",
    "workboard.boards.delete",
    "workboard.notifications.subscribe",
    "workboard.notifications.delete",
    "workboard.notifications.advance",
    "workboard.cards.attachments.add",
    "workboard.cards.attachments.delete",
    "workboard.cards.workerLog",
    "workboard.cards.protocolViolation",
    "workboard.cards.archive",
    "workboard.cards.create",
    "workboard.cards.captureSession",
    "workboard.cards.update",
    "workboard.cards.bulk",
    "workboard.boards.upsert",
    "workboard.cards.specify",
    "workboard.cards.decompose"
  ]) {
    await gateway.request(method, {})
    expect(call.mock.calls.at(-1)?.[3]).toEqual({ scopes: ["operator.write"], progress: false })
  }
})
it("rejects unknown Workboard methods before loading or invoking SDK authority", async () => {
  const call = vi.fn<NativeGatewaySdkCall>(async () => ({}))
  const load = vi.fn(async () => call)
  const gateway = new NativeSdkGateway("/usr/bin/openclaw", load)
  await expect(gateway.request("workboard.cards.futureMutation", {})).rejects.toThrow(
    "Unclassified native Workboard method"
  )
  expect(load).not.toHaveBeenCalled()
  expect(call).not.toHaveBeenCalled()
})
it("preserves administrative scope for operator contracts", async () => {
  const call = vi.fn<NativeGatewaySdkCall>(async () => ({}))
  const gateway = new NativeSdkGateway("/usr/bin/openclaw", async () => call)
  for (const method of ["autocode.dispatch", "config.patch", "cron.update", "sessions.abort"]) {
    await gateway.request(method, {})
    expect(call.mock.calls.at(-1)?.[3]).toEqual({ scopes: ["operator.admin"], progress: false })
  }
})
