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
