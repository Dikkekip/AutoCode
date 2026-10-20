import { createHash } from "node:crypto"
import { once } from "node:events"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { stripTypeScriptTypes } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { WebSocket, WebSocketServer } from "ws"
import {
  loadNativeGatewaySdkCall,
  NATIVE_BOARD_MAX_PAYLOAD_BYTES,
  NATIVE_CARD_STATUSES,
  NativeSdkGateway,
  nativeCards
} from "../packages/core-runtime/src/native/gateway.js"

const patch = await readFile(new URL("../patches/openclaw/bounded-gateway-response.patch", import.meta.url), "utf8")
// Execute the actual new upstream source from the tracked patch, not a second
// implementation of its limit validation. Upstream integration CI remains a gate.
const limitSource = patch
  .split("+++ b/packages/gateway-client/src/response-limit.ts\n")[1]
  ?.split("--- a/")[0]
  ?.split("\n")
  .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
  .map((line) => line.slice(1))
  .join("\n")
if (!limitSource) throw new Error("Missing upstream response-limit source")
const limitJs = stripTypeScriptTypes(limitSource, { mode: "strip" })
const limits = (await import(`data:text/javascript;base64,${Buffer.from(limitJs).toString("base64")}`)) as {
  resolveGatewayMaxPayloadBytes: (value?: number) => number
}

async function fixtureSdk(source: string, action: (command: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "native-board-sdk-"))
  try {
    const command = join(root, "openclaw.mjs")
    await writeFile(command, "#!/usr/bin/env node\n", { mode: 0o700 })
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "openclaw",
        type: "module",
        exports: { "./plugin-sdk/gateway-runtime": "./sdk.mjs" }
      })
    )
    await writeFile(join(root, "sdk.mjs"), source)
    await action(command)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

it("requires explicit SDK support before a board poll, preserving other methods", async () => {
  await fixtureSdk(
    `export async function callGatewayFromCli(method) {
    if (method === 'workboard.cards.list') throw new Error('legacy board call must not occur');
    return { method };
  }`,
    async (command) => {
      const gateway = new NativeSdkGateway(command)
      await expect(nativeCards(gateway, "board")).rejects.toThrow("public bounded Gateway response SDK extension")
      expect(await gateway.request("workboard.cards.runs", { id: "one" })).toEqual({ method: "workboard.cards.runs" })
    }
  )
})

it("uses the explicit capability only for full lists with unchanged scope, params and deadline", async () => {
  await fixtureSdk(
    `export async function callGatewayFromCli(...args) { return { kind: 'default', args }; }
    export async function callGatewayFromCliWithResponseLimit(...args) { return { kind: 'bounded', args }; }`,
    async (command) => {
      const call = await loadNativeGatewaySdkCall(command)
      const args = [
        { json: true as const, timeout: "180000" },
        { boardId: "board" },
        { scopes: ["operator.read"] as ["operator.read"], progress: false as const }
      ] as const
      expect(await call("workboard.cards.list", ...args)).toEqual({
        kind: "bounded",
        args: [
          "workboard.cards.list",
          args[0],
          args[1],
          { ...args[2], maxPayloadBytes: NATIVE_BOARD_MAX_PAYLOAD_BYTES }
        ]
      })
      expect(await call("workboard.cards.runs", ...args)).toEqual({
        kind: "default",
        args: ["workboard.cards.runs", ...args]
      })
    }
  )
})

it("rejects zero, nonfinite, fractional and over-ceiling bounds while preserving the default", () => {
  expect(limits.resolveGatewayMaxPayloadBytes()).toBe(26_214_400)
  expect(limits.resolveGatewayMaxPayloadBytes(NATIVE_BOARD_MAX_PAYLOAD_BYTES)).toBe(67_108_864)
  for (const value of [0, -1, NaN, Infinity, 1.5, 67_108_865])
    expect(() => limits.resolveGatewayMaxPayloadBytes(value)).toThrow(/maxPayloadBytes/)
})

async function receive(payload: string, maxPayloadBytes?: number) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, perMessageDeflate: false })
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing synthetic listener")
  server.on("connection", (socket) => {
    socket.on("error", () => {})
    socket.send(payload, () => {})
  })
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}`, {
    maxPayload: limits.resolveGatewayMaxPayloadBytes(maxPayloadBytes),
    perMessageDeflate: false
  })
  try {
    return await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.terminate()
        reject(new Error("Synthetic receive deadline"))
      }, 10_000)
      socket.once("message", (data) => {
        clearTimeout(timeout)
        resolve(data.toString())
      })
      socket.once("error", (error) => {
        clearTimeout(timeout)
        reject(error)
      })
      socket.once("close", () => {
        clearTimeout(timeout)
        reject(new Error("Closed before complete response"))
      })
    })
  } finally {
    socket.terminate()
    for (const client of server.clients) client.terminate()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

it("reproduces a >25 MiB message rejection and retains every card, status and evidence byte at the opt-in bound", async () => {
  const cards = NATIVE_CARD_STATUSES.map((status, i) => ({
    id: `card-${i}`,
    boardId: "board",
    title: status,
    status,
    metadata: { comments: [{ body: `${i}:` + "historical-evidence-ø".repeat(170_000), createdAt: i }] }
  }))
  const payload = JSON.stringify({ cards, statuses: [...NATIVE_CARD_STATUSES], boards: [{ id: "board" }] })
  expect(Buffer.byteLength(payload)).toBeGreaterThan(26_214_400)
  expect(Buffer.byteLength(payload)).toBeLessThan(NATIVE_BOARD_MAX_PAYLOAD_BYTES)
  await expect(receive(payload)).rejects.toThrow(/Max payload size exceeded/)
  const received = await receive(payload, NATIVE_BOARD_MAX_PAYLOAD_BYTES)
  expect(createHash("sha256").update(received).digest("hex")).toBe(createHash("sha256").update(payload).digest("hex"))
  const result = JSON.parse(received)
  expect(result.statuses).toEqual(NATIVE_CARD_STATUSES)
  expect(result.boards).toEqual([{ id: "board" }])
  expect(await nativeCards({ request: async () => result }, "board")).toEqual(cards)
}, 30_000)

it("propagates receive-limit failures without returning a partial board or retrying", async () => {
  await expect(receive("x".repeat(67_108_865), NATIVE_BOARD_MAX_PAYLOAD_BYTES)).rejects.toThrow(
    /Max payload size exceeded/
  )
  await fixtureSdk(
    `export async function callGatewayFromCli() { throw new Error('wrong call'); }
    let calls = 0;
    export async function callGatewayFromCliWithResponseLimit() { calls++; throw new Error('receive failed, calls=' + calls); }`,
    async (command) => {
      await expect(nativeCards(new NativeSdkGateway(command), "board")).rejects.toThrow("receive failed, calls=1")
    }
  )
}, 30_000)
