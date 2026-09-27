import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { formatNativeIdea, NativeHumanInput } from "../packages/core-runtime/src/native/human-input.js"
import { NativeEvidenceStore } from "../packages/core-runtime/src/native/store.js"
import { deliverNativeIdeas, handleNativeIdeaCommand } from "../packages/core-runtime/src/native/telegram-ideas.js"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn()
})
function setup() {
  const root = mkdtempSync(join(tmpdir(), "native-ideas-")),
    store = new NativeEvidenceStore(join(root, "evidence.db"))
  cleanups.push(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  const cards: any[] = []
  const runtime: any = {
    store,
    policy: { boardId: "board", repository: root, plannerAgentId: "planner", quality: { highRiskPaths: [] } },
    withOwnership: async (fn: any) => fn(),
    createCard: async (input: any) => {
      let card = cards.find((c) => c.idempotencyKey === input.idempotencyKey)
      if (!card) {
        card = { ...input, id: `card-${cards.length}` }
        cards.push(card)
      }
      return card
    }
  }
  const input = new NativeHumanInput(runtime, {
    boardId: "board",
    telegramTarget: "12345",
    ownerIds: ["12345"],
    accountId: "default",
    maxRoutineHours: 8,
    maxRoutineCostCents: 5000
  })
  runtime.humanInput = input
  const proposal: any = {
    title: "Fix confusing empty state",
    goal: "Trustworthy results",
    allowedPaths: ["src/view.tsx"],
    quality: {
      risk: "routine",
      riskReasons: [],
      expectedBenefit: "Show incomplete searches accurately",
      hypothesis: { effortHours: 2, costCents: 0 }
    }
  }
  store.put("proposal", "p1", { proposal, roundId: "round" })
  store.put("round", "round", { cards: ["original-planner"], phase: "dispatched" })
  return { runtime, store, input, proposal, cards }
}
const context = {
  channel: "telegram",
  senderId: "12345",
  from: "telegram:12345",
  accountId: "default",
  isAuthorizedSender: true
}
const invoke = async (_r: any, action: any) => action()
it("continues routine work without treating silence as approval", () => {
  const s = setup(),
    result = s.input.gate("p1", s.proposal, "round")
  expect(result.allowed).toBe(true)
  expect(result.idea.state).toBe("routine")
  expect(result.idea.decidedBy).toBeUndefined()
})
it.each(["risk", "path", "effort", "cost", "broad"])("holds %s decisions until the exact owner reply", (kind) => {
  const s = setup()
  if (kind === "risk") s.proposal.quality.risk = "high"
  if (kind === "path") s.proposal.allowedPaths = ["src/auth/access.ts"]
  if (kind === "effort") s.proposal.quality.hypothesis.effortHours = 9
  if (kind === "cost") s.proposal.quality.hypothesis.costCents = 5001
  if (kind === "broad") s.proposal.allowedPaths = ["src/**"]
  s.store.put("proposal", "p1", { proposal: s.proposal, roundId: "round" })
  const first = s.input.gate("p1", s.proposal, "round")
  expect(first.allowed).toBe(false)
  expect(s.input.gate("p1", s.proposal, "round").allowed).toBe(false)
  s.input.decide(first.idea.id, "approve", "12345", () => {})
  expect(s.input.gate("p1", s.proposal, "round").allowed).toBe(true)
})
it("invalidates approval when the proposal or operator configuration changes", () => {
  const s = setup()
  s.proposal.quality.risk = "high"
  s.store.put("proposal", "p1", { proposal: s.proposal, roundId: "round" })
  const first = s.input.gate("p1", s.proposal, "round").idea
  s.input.decide(first.id, "approve", "12345", () => {})
  s.proposal.title = "Different scope"
  s.store.put("proposal", "p1", { proposal: s.proposal, roundId: "round" })
  expect(s.input.gate("p1", s.proposal, "round").allowed).toBe(false)
  expect(() => s.input.decide(first.id, "approve", "12345", () => {})).toThrow(/stale/)
})
it("queues one new planner card, preserves the old one, and never directly admits code", async () => {
  const s = setup()
  s.proposal.quality.risk = "high"
  s.store.put("proposal", "p1", { proposal: s.proposal, roundId: "round" })
  const idea = s.input.gate("p1", s.proposal, "round").idea
  s.input.decide(idea.id, "approve", "12345", () => {})
  await s.input.queueApproved()
  await s.input.queueApproved()
  expect(s.cards).toHaveLength(1)
  expect(s.store.get<any>("round", "round").cards).toEqual(["original-planner", "card-0"])
  expect(s.store.list("workflow")).toHaveLength(0)
})
it("keeps skipped work held and does not reverse an existing decision", () => {
  const s = setup()
  s.proposal.quality.risk = "high"
  s.store.put("proposal", "p1", { proposal: s.proposal, roundId: "round" })
  const idea = s.input.gate("p1", s.proposal, "round").idea
  s.input.decide(idea.id, "skip", "12345", () => {})
  expect(s.input.gate("p1", s.proposal, "round").allowed).toBe(false)
  expect(() => s.input.decide(idea.id, "approve", "12345", () => {})).toThrow(/already decided/)
})
it.each([
  { senderId: "999" },
  { isAuthorizedSender: false },
  { from: "telegram:group:-100123" },
  { channel: "msteams" },
  { accountId: "other" }
])("rejects an unauthorized command context %j", async (patch) => {
  const s = setup()
  const reply = await handleNativeIdeaCommand([s.runtime], { ...context, ...patch }, false, invoke)
  expect(reply.text).toMatch(/private Telegram owner/)
})
it("honors host authority revocation", async () => {
  const s = setup()
  const reply = await handleNativeIdeaCommand(
    [s.runtime],
    {
      ...context,
      assertOwnerCurrent: () => {
        throw new Error("owner revoked")
      }
    },
    false,
    invoke
  )
  expect(reply.text).toBe("owner revoked")
})
it("leaves uncertain message delivery visible without duplicating outbound messages", async () => {
  const s = setup()
  s.proposal.quality.risk = "high"
  s.store.put("proposal", "p1", { proposal: s.proposal, roundId: "round" })
  const idea = s.input.gate("p1", s.proposal, "round").idea
  const send = vi.fn(async () => {
    throw new Error("reply lost")
  })
  await deliverNativeIdeas(s.runtime, send)
  await deliverNativeIdeas(s.runtime, send)
  expect(send).toHaveBeenCalledTimes(1)
  expect(s.input.list()[0]?.delivery).toBe("uncertain")
  const reply = await handleNativeIdeaCommand([s.runtime], context, false, invoke)
  expect(reply.text).toContain(idea.id)
})
it("accepts only explicit owner commands, never prose or elapsed time", async () => {
  const s = setup()
  s.proposal.quality.risk = "high"
  s.store.put("proposal", "p1", { proposal: s.proposal, roundId: "round" })
  const idea = s.input.gate("p1", s.proposal, "round").idea
  const prose = await handleNativeIdeaCommand([s.runtime], { ...context, args: "looks good" }, true, invoke)
  expect(prose.text).toContain("/idea approve ID")
  expect(s.input.list()[0]?.state).toBe("pending")
  const reply = await handleNativeIdeaCommand([s.runtime], { ...context, args: `approve ${idea.id}` }, true, invoke)
  expect(reply.text).toContain("Approved direction")
  expect(s.input.list()[0]?.decidedBy).toBe("telegram:12345")
  expect(formatNativeIdea(idea).length).toBeLessThan(1600)
})
