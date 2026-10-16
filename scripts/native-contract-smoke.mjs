// Exercise the installed native Workboard implementation using an isolated disposable SQLite store.
// Generated bundle discovery is test-only; the plugin uses public Gateway APIs exclusively.

import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { assertWorkspaceResolution } from "./assert-workspace-resolution.mjs"

assertWorkspaceResolution()

const root = process.argv[2]
if (!root) throw new Error("Pass the installed OpenClaw package root")
const scratch = mkdtempSync(resolve(tmpdir(), "native-workboard-contract-"))
const originalStateDirectory = process.env.OPENCLAW_STATE_DIR
process.env.OPENCLAW_STATE_DIR = scratch
const entry = resolve(root, "dist/extensions/workboard/index.js")
const text = readFileSync(entry, "utf8")
async function installedExport(name) {
  for (const match of text.matchAll(/import \{([^}]+)\} from "([^"]+)"/g)) {
    const binding = match[1]
      .split(",")
      .map((value) => value.trim())
      .find((value) => value === name || value.endsWith(` as ${name}`))
    if (!binding) continue
    const alias = binding.split(/\s+as\s+/)[0]
    const module = await import(pathToFileURL(resolve(entry, "..", match[2])).href)
    assert.equal(typeof module[alias], "function", `Installed ${name} export unavailable`)
    return module[alias]
  }
  throw new Error(`Installed ${name} export not found`)
}
const WorkboardStore = await installedExport("WorkboardStore")
const registerGatewayMethods = await installedExport("registerWorkboardGatewayMethods")
const store = WorkboardStore.openSqlite(pathToFileURL(resolve(entry, "..", "src/sqlite-store.worker.js")))
try {
  const methods = new Map()
  const config = { agents: { defaults: { workspace: scratch } } }
  registerGatewayMethods({
    api: {
      runtime: { config: { current: () => config } },
      registerGatewayMethod: (name, handler, options) => methods.set(name, { handler, options })
    },
    store
  })
  async function call(method, params) {
    return await new Promise((resolve, reject) => {
      Promise.resolve(
        methods.get(method).handler({
          params,
          client: { connect: { role: "operator", scopes: ["operator.admin", "operator.read", "operator.write"] } },
          context: { getRuntimeConfig: () => config },
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
  const targeted = await call("workboard.cards.runs", { id: first.id })
  assert.equal(targeted.card.id, first.id)
  assert.equal(targeted.card.metadata.automation.boardId, "autocode-contract")
  assert.equal(targeted.card.status, "blocked")
  assert.equal(targeted.card.metadata?.claim?.token, undefined)
  assert.ok(Array.isArray(targeted.attempts))
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
  if (originalStateDirectory === undefined) delete process.env.OPENCLAW_STATE_DIR
  else process.env.OPENCLAW_STATE_DIR = originalStateDirectory
  rmSync(scratch, { recursive: true, force: true })
}
