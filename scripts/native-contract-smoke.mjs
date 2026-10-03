// Exercise the installed native Workboard implementation using an isolated disposable SQLite store.
// Generated bundle discovery is test-only; the plugin uses public Gateway APIs exclusively.

import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
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
const runtimeEntry = resolve(entry, "..", match[2])
const runtimeText = readFileSync(runtimeEntry, "utf8")
const sqliteImport = runtimeText.match(/import \{([^}]*\bcreateWorkboardSqliteStores\b[^}]*)\} from "([^"]+)"/)
if (!sqliteImport) throw new Error("Installed Workboard SQLite factory export not found")
const sqliteAlias = sqliteImport[1].match(/(\w+) as createWorkboardSqliteStores/)[1]
const sqliteModule = await import(pathToFileURL(resolve(runtimeEntry, "..", sqliteImport[2])).href)
const scratch = mkdtempSync(resolve(tmpdir(), "native-workboard-contract-"))
const stores = sqliteModule[sqliteAlias]({
  dbPath: resolve(scratch, "workboard.sqlite"),
  workerModuleUrl: pathToFileURL(resolve(entry, "..", "src/sqlite-store.worker.js"))
})
const store = new module[alias](stores.cards, stores)
try {
  await stores.ready
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
  // A stale writer must not overwrite a newer card revision.
  const latest = (await call("workboard.cards.list", { boardId: "autocode-contract" })).cards.find(
    (card) => card.id === first.id
  )
  await call("workboard.cards.update", {
    id: first.id,
    expectedUpdatedAt: latest.updatedAt,
    patch: { notes: "newer evidence" }
  })
  await assert.rejects(
    call("workboard.cards.update", {
      id: first.id,
      expectedUpdatedAt: latest.updatedAt,
      patch: { notes: "stale evidence" }
    }),
    /conflict/i
  )
  const preserved = (await call("workboard.cards.list", { boardId: "autocode-contract" })).cards.find(
    (card) => card.id === first.id
  )
  assert.equal(preserved.notes, "newer evidence")
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
      execution: {
        id: "old-attempt",
        kind: "agent-session",
        status: "review",
        sessionKey: "agent:research:old-attempt"
      }
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
} finally {
  await store.close()
  rmSync(scratch, { recursive: true, force: true })
}
