// Exercise the installed native Workboard implementation using isolated in-memory stores.
// Generated bundle discovery is test-only; the plugin uses public Gateway APIs exclusively.

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

const root = process.argv[2]
if (!root) throw new Error("Pass the installed OpenClaw package root")
const entry = resolve(root, "dist/extensions/workboard/index.js")
const text = readFileSync(entry, "utf8")
const match = text.match(/import \{([^}]*\bWorkboardStore\b[^}]*)\} from "([^"]+)"/)
if (!match) throw new Error("Installed Workboard store export not found")
const alias = match[1].match(/(\w+) as WorkboardStore/)[1]
const module = await import(pathToFileURL(resolve(entry, "..", match[2])).href)
class MemoryStore {
  values = new Map()
  async lookup(key) {
    return this.values.has(key) ? structuredClone(this.values.get(key)) : undefined
  }
  async register(key, value) {
    this.values.set(key, structuredClone(value))
  }
  async delete(key) {
    return this.values.delete(key)
  }
  async entries() {
    return [...this.values].map(([key, value]) => ({ key, value: structuredClone(value) }))
  }
}
const store = new module[alias](new MemoryStore(), {
  boards: new MemoryStore(),
  subscriptions: new MemoryStore(),
  attachments: new MemoryStore()
})
const methods = new Map()
module.t({ api: { registerGatewayMethod: (name, handler) => methods.set(name, handler) }, store })
async function call(method, params) {
  return await new Promise((resolve, reject) => {
    Promise.resolve(
      methods.get(method)({
        params,
        context: {},
        respond: (ok, value, error) => (ok ? resolve(value) : reject(new Error(JSON.stringify(error))))
      })
    ).catch(reject)
  })
}
await call("workboard.boards.upsert", { id: "autocode-contract", name: "Autocode contract" })
const input = {
  boardId: "autocode-contract",
  title: "Preserved import",
  status: "scheduled",
  idempotencyKey: "legacy:one",
  notes: "evidence",
  maxRuntimeSeconds: 300,
  maxRetries: 1,
  workspace: { kind: "worktree", sourcePath: "/tmp", sourceBranch: "main" }
}
const first = (await call("workboard.cards.create", input)).card
assert.equal((await call("workboard.cards.create", input)).card.id, first.id)
const second = (await call("workboard.cards.create", { ...input, title: "Dependent", idempotencyKey: "legacy:two" }))
  .card
await call("workboard.cards.linkDependency", { parentId: first.id, childId: second.id })
await call("workboard.cards.move", { id: first.id, status: "blocked" })
await call("workboard.cards.move", { id: second.id, status: "blocked" })
const listing = await call("workboard.cards.list", { boardId: "autocode-contract" })
assert.equal(listing.cards.length, 2)
assert.ok(listing.cards.every((c) => c.status === "blocked"))
assert.equal(first.metadata.automation.workspace.sourcePath, "/tmp")
assert.ok(methods.has("workboard.cards.dispatchWithOptions"))
assert.equal(first.metadata.automation.maxRuntimeSeconds, 300)
assert.equal(first.metadata.automation.maxRetries, 1)
// Recovery must clear current associations while preserving the card and retry budget.
const retry = (
  await call("workboard.cards.create", {
    boardId: "autocode-contract",
    title: "Uninspected infrastructure failure",
    status: "ready",
    agentId: "research",
    maxRuntimeSeconds: 300,
    maxRetries: 1,
    workspace: { kind: "scratch" }
  })
).card
await call("workboard.cards.claim", { id: retry.id, ownerId: "research" })
await call("workboard.cards.update", {
  id: retry.id,
  patch: {
    status: "review",
    startedAt: Date.now() - 600000,
    sessionKey: "agent:research:old-attempt",
    execution: { id: "old-attempt", kind: "agent-session", status: "review", sessionKey: "agent:research:old-attempt" }
  }
})
const blockedRetry = (await call("workboard.cards.block", { id: retry.id, reason: "Tool bridge repaired" })).card
const resetRetry = (
  await call("workboard.cards.update", {
    id: retry.id,
    expectedUpdatedAt: blockedRetry.updatedAt,
    patch: { status: "ready", execution: null, sessionKey: null, runId: null, startedAt: null }
  })
).card
assert.equal(resetRetry.id, retry.id)
assert.equal(resetRetry.status, "ready")
assert.ok(!resetRetry.execution && !resetRetry.sessionKey && !resetRetry.startedAt && !resetRetry.metadata.claim)
assert.equal(resetRetry.metadata.automation.maxRetries, 1)
const { default: plugin } = await import(pathToFileURL(resolve("plugins/autocode/index.mjs")).href)
const registered = { services: [], methods: [], tools: [], hooks: [] }
plugin.register({
  pluginConfig: { projects: [] },
  runtime: { gateway: { request: async () => ({}) } },
  registerService: (s) => registered.services.push(s),
  registerGatewayMethod: (name) => registered.methods.push(name),
  registerTool: (_factory, options) => registered.tools.push(...options.names),
  on: (event) => registered.hooks.push(event)
})
assert.ok(registered.methods.includes("autocode.reconcile"))
assert.ok(registered.tools.includes("autocode_review"))
for (const service of registered.services) {
  await service.start()
  await service.stop()
}
console.log(
  JSON.stringify(
    {
      ok: true,
      workboardCards: listing.cards.length,
      duplicateImport: "idempotent",
      dependencyHold: "preserved",
      plugin: registered.methods
    },
    null,
    2
  )
)
