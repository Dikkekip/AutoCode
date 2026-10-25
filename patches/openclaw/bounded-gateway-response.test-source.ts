import { once } from "node:events"
import { expect, it, vi } from "vitest"
import { GatewayClient } from "__CORE__/packages/gateway-client/src/client.ts"
import { WebSocketServer } from "__CORE__/packages/gateway-client/src/websocket.ts"
import { callGatewayFromCliWithResponseLimit } from "__CORE__/src/cli/gateway-rpc.ts"

const calls = vi.hoisted(() => ({ call: vi.fn(async () => ({ cards: [] })) }))
vi.mock("__CORE__/src/gateway/call.ts", () => ({
  callGateway: calls.call, isImplicitLocalGatewayTarget: vi.fn()
}))
vi.mock("__CORE__/src/cli/progress.ts", () => ({
  withProgress: async (_options: unknown, action: () => Promise<unknown>) => action()
}))

it("forwards the bounded public SDK request through the actual lazy facade and RPC runtime", async () => {
  await expect(callGatewayFromCliWithResponseLimit("workboard.cards.list", { json: true, timeout: "180000" },
    { boardId: "board" }, { scopes: ["operator.read"], progress: false, maxPayloadBytes: 67108864 }
  )).resolves.toEqual({ cards: [] })
  expect(calls.call).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    method: "workboard.cards.list", params: { boardId: "board" }, scopes: ["operator.read"],
    timeoutMs: 180000, maxPayloadBytes: 67108864
  }))
  calls.call.mockClear()
  await expect(callGatewayFromCliWithResponseLimit("workboard.cards.list", {}, {},
    { maxPayloadBytes: 0 })).rejects.toThrow(/maxPayloadBytes/)
  expect(calls.call).not.toHaveBeenCalled()
})

it("rejects invalid client bounds before opening any connection", () => {
  for (const maxPayloadBytes of [0, -1, NaN, Infinity, 1.5, 67108865])
    expect(() => new GatewayClient({ maxPayloadBytes })).toThrow(/maxPayloadBytes/)
})

it("receives complete >25MiB responses only with opt-in support through the real GatewayClient", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, perMessageDeflate: false })
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing fixture address")
  const evidence = "historical-evidence-ø".repeat(1300000)
  let listCalls = 0
  server.on("connection", socket => {
    socket.on("error", () => {})
    socket.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "synthetic", ts: Date.now() } }))
    socket.on("message", data => {
      const frame = JSON.parse(data.toString())
      if (frame.method === "connect") socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true,
        payload: { type: "hello-ok", protocol: 4, server: { version: "synthetic", connId: "synthetic" },
          features: { methods: ["workboard.cards.list"], events: [] },
          snapshot: { presence: [], health: {}, stateVersion: { presence: 1, health: 1 }, uptimeMs: 1 },
          auth: { role: "operator", scopes: ["operator.read"] },
          policy: { maxPayload: 524288, maxBufferedBytes: 1048576, tickIntervalMs: 30000 } } }))
      else {
        listCalls++
        socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true,
          payload: { cards: [{ id: "one", title: "Complete", status: "done", metadata: { evidence } }], statuses: ["done"] } }), () => {})
      }
    })
  })
  const receive = async (maxPayloadBytes?: number) => {
    let client: GatewayClient
    let ready!: () => void
    const hello = new Promise<void>(resolve => { ready = resolve })
    client = new GatewayClient({ url: `ws://127.0.0.1:${address.port}`, token: "synthetic", deviceIdentity: null,
      scopes: ["operator.read"], maxPayloadBytes, onHelloOk: ready, hostDeps: { logError: () => {} } })
    try {
      client.start()
      await hello
      return await client.request<any>("workboard.cards.list", { boardId: "board" }, { timeoutMs: 5000 })
    } finally { await client.stop() }
  }
  try {
    expect(Buffer.byteLength(evidence)).toBeGreaterThan(26214400)
    await expect(receive()).rejects.toThrow()
    const result = await receive(67108864)
    expect(result.cards[0].metadata.evidence).toBe(evidence)
    expect(result.statuses).toEqual(["done"])
    expect(listCalls).toBe(2)
  } finally {
    for (const socket of server.clients) socket.terminate()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}, 20000)
