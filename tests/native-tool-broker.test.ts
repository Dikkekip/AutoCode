import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { authorizeNativeTool, resolveNativeToolRuntime } from "../packages/core-runtime/src/native/broker.js"
import type { NativeAutonomyRuntime } from "../packages/core-runtime/src/native/runtime.js"
import { NativeEvidenceStore } from "../packages/core-runtime/src/native/store.js"

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn()
})
function setup() {
  const root = mkdtempSync(join(tmpdir(), "native-broker-"))
  const store = new NativeEvidenceStore(join(root, "evidence.db"))
  cleanups.push(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  const cards: any[] = [
    {
      id: "planner-card",
      title: "Select",
      agentId: "planner",
      status: "running",
      sessionKey: "session",
      execution: { status: "running", sessionKey: "session" }
    }
  ]
  const runtime = {
    store,
    policy: {
      boardId: "board",
      plannerAgentId: "planner",
      coderAgentId: "coder",
      reviewerAgentId: "reviewer",
      personas: [{ personaId: "research" }]
    },
    gateway: { request: async () => ({ cards }) }
  } as unknown as NativeAutonomyRuntime
  store.put("round", "round", { cards: ["planner-card"] })
  store.put("proposal", "proposal", { roundId: "round" })
  const args = { boardId: "board", proposalId: "proposal" }
  const context = { agentId: "planner", sessionKey: "session", sandboxed: true }
  return { runtime, store, cards, args, context }
}
it("allows a sandboxed host-supplied planner only on its current assigned round", async () => {
  const s = setup()
  await expect(authorizeNativeTool(s.runtime, "autocode_admit", s.args, s.context)).resolves.toBeUndefined()
})
it.each([
  "agent",
  "session",
  "board",
  "proposal",
  "execution",
  "missing",
  "operator"
])("rejects substituted %s authority and records a redacted denial", async (kind) => {
  const s = setup()
  if (kind === "agent") s.context.agentId = "other"
  if (kind === "session") s.context.sessionKey = "stale"
  if (kind === "board") s.args.boardId = "other"
  if (kind === "proposal") s.args.proposalId = "PRIVATE_FAKE_RECEIPT"
  if (kind === "execution") s.cards[0].execution.sessionKey = "replacement"
  const name = kind === "operator" ? "autocode.reconcile" : "autocode_admit"
  await expect(authorizeNativeTool(s.runtime, name, s.args, kind === "missing" ? {} : s.context)).rejects.toThrow(
    /denied/
  )
  const events = s.store.db.prepare("SELECT data FROM native_events WHERE kind='tool.denied'").all()
  expect(events).toHaveLength(1)
  expect(JSON.stringify(events)).not.toContain("PRIVATE_FAKE_RECEIPT")
})
it("cannot read another card's context or submit/review another workflow", async () => {
  const s = setup()
  s.store.put("card-context", "context", { cardId: "other", agentId: "planner", notes: "secret" })
  await expect(
    authorizeNativeTool(s.runtime, "autocode_context", { boardId: "board", contextId: "context" }, s.context)
  ).rejects.toThrow(/not assigned/)
  s.store.put("workflow", "workflow", { implementationCardId: "other", reviewCardId: "other" })
  for (const [name, agentId] of [
    ["autocode_submit", "coder"],
    ["autocode_review", "reviewer"]
  ]) {
    s.cards[0].agentId = agentId
    await expect(
      authorizeNativeTool(s.runtime, name!, { boardId: "board", workflowId: "workflow" }, { ...s.context, agentId })
    ).rejects.toThrow(/not assigned/)
  }
})
it("rejects ambiguous simultaneous assignment and terminal execution", async () => {
  const s = setup()
  s.cards.push({ ...s.cards[0], id: "duplicate" })
  await expect(authorizeNativeTool(s.runtime, "autocode_admit", s.args, s.context)).rejects.toThrow(/one active/)
  s.cards.pop()
  s.cards[0].execution.status = "completed"
  await expect(authorizeNativeTool(s.runtime, "autocode_admit", s.args, s.context)).rejects.toThrow(/one active/)
})

it("resolves the board from assignment and refuses ambiguous cross-board session reuse", async () => {
  const first = setup()
  const other = setup()
  other.runtime.policy.boardId = "other"
  other.cards[0].sessionKey = "other-session"
  expect(await resolveNativeToolRuntime([first.runtime, other.runtime], first.context)).toBe(first.runtime)
  other.cards[0].sessionKey = "session"
  await expect(resolveNativeToolRuntime([first.runtime, other.runtime], first.context)).rejects.toThrow(
    /one active assigned board/
  )
})

it("authorizes each pooled coder only for its own active workflow and preserves independent review", async () => {
  const s = setup()
  s.runtime.policy.coderAgentIds = ["coder", "coder-2"]
  s.cards[0].agentId = "coder-2"
  s.store.put("workflow", "owned", { implementationCardId: s.cards[0].id })
  s.store.put("workflow", "other", { implementationCardId: "another-card" })
  const context = { ...s.context, agentId: "coder-2" }
  await expect(
    authorizeNativeTool(s.runtime, "autocode_submit", { boardId: "board", workflowId: "owned" }, context)
  ).resolves.toBeUndefined()
  await expect(
    authorizeNativeTool(s.runtime, "autocode_submit", { boardId: "board", workflowId: "other" }, context)
  ).rejects.toThrow(/not assigned/)
  await expect(
    authorizeNativeTool(s.runtime, "autocode_review", { boardId: "board", workflowId: "owned" }, context)
  ).rejects.toThrow(/independent reviewer/)
})

it("separates inline planner round IDs from issued card-bound context IDs", async () => {
  const s = setup()
  await expect(
    authorizeNativeTool(s.runtime, "autocode_proposals", { boardId: "board", roundId: "round" }, s.context)
  ).resolves.toBeUndefined()
  for (const contextId of ["round", "planner-card"]) {
    await expect(
      authorizeNativeTool(s.runtime, "autocode_context", { boardId: "board", contextId }, s.context)
    ).rejects.toThrow(/not assigned/)
  }
  s.store.put("card-context", "issued-context", { cardId: "planner-card", agentId: "planner", notes: "assigned" })
  await expect(
    authorizeNativeTool(s.runtime, "autocode_context", { boardId: "board", contextId: "issued-context" }, s.context)
  ).resolves.toBeUndefined()
})
