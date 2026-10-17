// New credential-free smoke of compiled native runtime; Gateway effects are controlled doubles.
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NativeAutonomyRuntime } from "../packages/core-runtime/dist/native/runtime.js"
import { NativeEvidenceStore } from "../packages/core-runtime/dist/native/store.js"
import { validateNativeAutonomyPolicy } from "../packages/domain/dist/native-autonomy.js"

const temporary = mkdtempSync(join(tmpdir(), "autocode-native-smoke-"))
const root = join(temporary, "repository")
mkdirSync(root)
process.env.OPENCLAW_CONTROL_ROOT = join(temporary, "control")
let store
try {
  mkdirSync(join(root, "src"))
  const policy = validateNativeAutonomyPolicy({
    version: 1,
    enabled: true,
    mode: "implement-human-review",
    boardId: "smoke",
    repository: root,
    repositoryKind: "framework",
    baseBranch: "main",
    plannerAgentId: "planner",
    coderAgentId: "coder",
    reviewerAgentId: "reviewer",
    personas: [
      {
        personaId: "research",
        goals: ["navigation"],
        successObservations: ["opens source"],
        allowedPaths: ["src"],
        weight: 1
      }
    ],
    verification: [{ argv: ["false"], cwd: "." }]
  })
  const cards = []
  const calls = []
  const gateway = {
    async request(method, params) {
      calls.push(method)
      if (method === "workboard.cards.list") return { cards }
      if (method === "workboard.cards.create") {
        let card = cards.find((c) => c.key === params.idempotencyKey)
        if (!card) {
          card = { ...params, id: `card-${cards.length}`, key: params.idempotencyKey }
          cards.push(card)
        }
        return { card }
      }
      if (method === "workboard.cards.move" || method === "workboard.cards.update") {
        const card = cards.find((c) => c.id === params.id)
        assert.ok(card, "unknown card")
        Object.assign(card, params.patch ?? { status: params.status })
        return { card }
      }
      if (method === "workboard.cards.linkDependency") return {}
      throw new Error(`Unexpected smoke RPC: ${method}`)
    }
  }
  const path = join(root, "evidence.db")
  store = new NativeEvidenceStore(path)
  const runtime = new NativeAutonomyRuntime(policy, gateway, store)
  // Exercise the compiled runtime's transitive domain import, not a direct source alias.
  const scopeStore = new NativeEvidenceStore(join(temporary, "scope.sqlite"))
  try {
    const scoped = new NativeAutonomyRuntime(policy, gateway, scopeStore)
    scopeStore.put("workflow", "retained-audit", {
      proposal: { allowedPaths: ["apps/reports-ui/e2e/ui-audit*"] },
      lifecycle: { version: 1, state: "blocked", attempt: 0, attemptId: "retained-audit:attempt:0" },
      blocker: "Retained independent review"
    })
    assert.equal(
      scoped.proposalScope({
        allowedPaths: ["apps/reports-ui/e2e/navigation.spec.ts", "apps/reports-ui/e2e/utils/auth.ts"]
      }).conflicts.length,
      0
    )
    assert.equal(
      scoped.proposalScope({ allowedPaths: ["apps/reports-ui/e2e/ui-audit-scan.spec.ts"] }).conflicts[0].workflowId,
      "retained-audit"
    )
    assert.equal(
      scoped.proposalScope({ allowedPaths: ["apps/reports-ui/e2e"] }).conflicts[0].workflowId,
      "retained-audit"
    )
  } finally {
    scopeStore.close()
  }
  await runtime.discover()
  const round = store.list("round")[0]
  assert.ok(round)
  const { proposalId } = runtime.propose("research", round.id, {
    personaId: "research",
    goal: "navigation",
    title: "Open cited source",
    evidence: [{ path: "src", observation: "navigation missing" }],
    allowedPaths: ["src"],
    acceptance: ["opens source"],
    alternatives: ["no change retains missing navigation"],
    implementationPrompt: "Add source navigation"
  })
  for (const card of cards) card.status = "done"
  const { workflowId } = await runtime.admit("planner", proposalId, "Controlled smoke selection")
  assert.equal((await runtime.admit("planner", proposalId, "Replay")).duplicate, true)
  const workflow = runtime.requireWorkflow(workflowId)
  assert.ok(workflow.implementationCardId)
  runtime.control.change(true)
  const count = cards.length
  assert.equal((await runtime.reconcile()).paused, true)
  assert.equal(cards.length, count)
  store.close()
  store = new NativeEvidenceStore(path)
  assert.ok(store.get("workflow", workflowId), "workflow must survive restart")
  assert.equal(store.get("control", "pause").paused, true)
  console.log(
    JSON.stringify({
      ok: true,
      evidence: "synthetic Gateway; compiled runtime and real SQLite",
      stages: ["discovery", "proposal", "admission", "idempotent replay", "pause", "restart"],
      rpcCalls: calls.length
    })
  )
} finally {
  store?.close()
  rmSync(temporary, { recursive: true, force: true })
}
