import { expect, it, vi } from "vitest"
import { type NativeGateway, nativeCardById } from "../packages/core-runtime/src/native/gateway.js"

const card = {
  id: "assigned",
  boardId: "board",
  title: "Assigned work",
  status: "running",
  agentId: "coder",
  sessionKey: "session",
  metadata: { automation: { boardId: "board" } }
}

it("reads a complete known card fresh without listing the board or caching execution authority", async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce({ card, attempts: [] })
    .mockResolvedValueOnce({ card: { ...card, status: "blocked", sessionKey: "replacement" }, attempts: [] })
  const gateway = { request } as NativeGateway
  expect(await nativeCardById(gateway, "board", "assigned")).toMatchObject({ status: "running", sessionKey: "session" })
  expect(await nativeCardById(gateway, "board", "assigned")).toMatchObject({
    status: "blocked",
    sessionKey: "replacement"
  })
  expect(request.mock.calls).toEqual([
    ["workboard.cards.runs", { id: "assigned" }],
    ["workboard.cards.runs", { id: "assigned" }]
  ])
})

it.each([
  undefined,
  {},
  { card: null },
  { card: { ...card, id: "foreign" } },
  { card: { ...card, boardId: "foreign" } },
  { card: { ...card, metadata: undefined } },
  { card: { ...card, metadata: { automation: { boardId: "foreign" } } } },
  { card: { ...card, status: "unknown" } },
  { card: { ...card, execution: { status: "unknown" } } }
])("refuses malformed or unbound targeted card responses: %j", async (response) => {
  const gateway = { request: vi.fn().mockResolvedValue(response) } as NativeGateway
  await expect(nativeCardById(gateway, "board", "assigned")).rejects.toThrow()
})

it("rejects missing caller identities before issuing any read", async () => {
  const request = vi.fn()
  const gateway = { request } as NativeGateway
  await expect(nativeCardById(gateway, "", "assigned")).rejects.toThrow()
  await expect(nativeCardById(gateway, "board", undefined)).rejects.toThrow()
  expect(request).not.toHaveBeenCalled()
})

it("binds the canonical Workboard metadata board without requiring an unsupported top-level field", async () => {
  const gateway = {
    request: vi.fn().mockResolvedValue({
      card: { ...card, boardId: undefined, metadata: { automation: { boardId: "board" } } },
      attempts: []
    })
  } as NativeGateway
  expect(await nativeCardById(gateway, "board", "assigned")).toMatchObject({
    metadata: { automation: { boardId: "board" } }
  })
})
