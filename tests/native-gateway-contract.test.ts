import { expect, it } from "vitest"
import { type NativeGateway, nativeCard, nativeCards } from "../packages/core-runtime/src/native/gateway.js"

const gateway = (value: unknown): NativeGateway => ({ request: async () => value as any })
it("rejects malformed card identities before they enter workflow decisions", async () => {
  await expect(nativeCards(gateway({ cards: [{ id: 4, title: "bad", status: "running" }] }), "app")).rejects.toThrow(
    /contract/
  )
})
it("rejects unknown states and duplicate identities rather than silently hiding work", async () => {
  await expect(
    nativeCards(gateway({ cards: [{ id: "c", title: "x", status: "future-state" }] }), "app")
  ).rejects.toThrow(/contract/)
  const card = { id: "c", title: "x", status: "running" }
  await expect(nativeCards(gateway({ cards: [card, card] }), "app")).rejects.toThrow(/duplicate/)
})
it("validates created cards beyond a nonempty id", async () => {
  await expect(nativeCard(gateway({ card: { id: "c" } }), {})).rejects.toThrow(/contract/)
})
it("rejects malformed execution identity and cross-board cards", async () => {
  await expect(
    nativeCards(gateway({ cards: [{ id: "c", title: "x", status: "running", execution: { sessionKey: 7 } }] }), "app")
  ).rejects.toThrow(/contract/)
  await expect(
    nativeCards(gateway({ cards: [{ id: "c", title: "x", status: "running", boardId: "other" }] }), "app")
  ).rejects.toThrow(/board/)
})

it("accepts the installed Workboard idle execution state without marking it running", async () => {
  const card = { id: "c", title: "Ended", status: "blocked", execution: { status: "idle" } }
  expect(await nativeCards(gateway({ cards: [card] }), "app")).toEqual([card])
})

it("bounds production-length stage keys while retaining every identity binding", async () => {
  const sent: string[] = []
  const remote: NativeGateway = {
    request: async (_method, input) => {
      const key = String(input.idempotencyKey)
      if (key.length > 160) throw new Error("Workboard key exceeds 160 characters")
      sent.push(key)
      return { card: { id: key, title: "Stage", status: "blocked" } } as any
    }
  }
  const workflow = "a".repeat(64),
    head = "b".repeat(40),
    policy = "c".repeat(64)
  const verify = `workflow:${workflow}:Verify:${head}:${workflow}:attempt:4:${policy}`
  for (const key of [
    verify,
    verify,
    verify.replace("attempt:4", "attempt:5"),
    verify.replace(policy, "d".repeat(64)),
    `workflow:${workflow}:Review:${head}:${"e".repeat(64)}`,
    `workflow:${workflow}:Review:${head}:${"f".repeat(64)}`,
    "x".repeat(160)
  ]) {
    const input = { idempotencyKey: key }
    await nativeCard(remote, input)
    expect(input.idempotencyKey).toBe(key)
  }
  expect(sent[0]).toBe(sent[1])
  expect(new Set([sent[0], ...sent.slice(2)]).size).toBe(6)
  expect(sent.every((key) => key.length <= 160)).toBe(true)
  expect(sent.at(-1)).toBe("x".repeat(160))
})
