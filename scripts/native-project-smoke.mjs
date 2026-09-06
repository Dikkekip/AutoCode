// Read-only project integration smoke: real Git/profile inputs, isolated Workboard stores, no inference.
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { pathToFileURL } from "node:url"
import { loadNativePolicy } from "../packages/core-runtime/dist/native/doctor.js"
import { applyNativeMigration, planNativeMigration } from "../packages/core-runtime/dist/native/migration.js"
import { NativeAutonomyRuntime } from "../packages/core-runtime/dist/native/runtime.js"
import { NativeEvidenceStore } from "../packages/core-runtime/dist/native/store.js"

const policyFile = process.argv[2]
const packageRoot = process.argv[3]
if (!policyFile || !packageRoot)
  throw new Error(
    "Usage: node scripts/native-project-smoke.mjs <native-policy.json> <installed-openclaw-package> [migration-preview.json]"
  )
const entry = resolve(packageRoot, "dist/extensions/workboard/index.js")
const text = readFileSync(entry, "utf8")
const match = text.match(/import \{([^}]*\bWorkboardStore\b[^}]*)\} from "([^"]+)"/)
assert.ok(match, "Installed Workboard store export")
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
    this.values.delete(key)
  }
  async entries() {
    return [...this.values].map(([key, value]) => ({ key, value: structuredClone(value) }))
  }
}
const workboard = new module[alias](new MemoryStore(), {
  boards: new MemoryStore(),
  subscriptions: new MemoryStore(),
  attachments: new MemoryStore()
})
const methods = new Map()
module.t({ api: { registerGatewayMethod: (name, handler) => methods.set(name, handler) }, store: workboard })
const calls = []
const gateway = {
  request: async (method, params) => {
    calls.push(method)
    assert.ok(
      !/dispatch|sessions\.|cron\.|autocode\./.test(method),
      "No inference, scheduling or live execution in this contract test"
    )
    return new Promise((resolve, reject) => {
      const handler = methods.get(method)
      if (!handler) return reject(new Error("Unknown test RPC " + method))
      Promise.resolve(
        handler({
          params,
          context: {},
          respond: (ok, value, error) => (ok ? resolve(value) : reject(new Error(JSON.stringify(error))))
        })
      ).catch(reject)
    })
  }
}
const scratch = mkdtempSync(join(tmpdir(), "lawyerrag-native-contract-"))
const store = new NativeEvidenceStore(join(scratch, "evidence.db"))
try {
  const policy = { ...loadNativePolicy(policyFile), enabled: true }
  assert.ok(policy.personas.length > 0)
  await gateway.request("workboard.boards.upsert", { id: policy.boardId, name: "Isolated LawyerRAG contract test" })
  const runtime = new NativeAutonomyRuntime(policy, gateway, store)
  const result = await runtime.discover()
  const listing = await gateway.request("workboard.cards.list", { boardId: policy.boardId })
  assert.equal(result.created.length, Math.min(policy.personasPerRound, policy.personas.length) + 1)
  assert.equal(listing.cards.length, result.created.length)
  const investigations = store.list("investigation")
  assert.equal(investigations.length, result.created.length - 1)
  const summaries = []
  for (const record of investigations) {
    const v = record.value
    const card = listing.cards.find((c) => c.id === v.cardId)
    assert.equal(card.metadata.automation.maxRuntimeSeconds, 300)
    assert.equal(card.agentId, v.agentId)
    assert.ok(card.notes.length <= 4000)
    const envelope = JSON.parse(card.notes)
    const context = envelope.contextId ? JSON.parse(store.get("card-context", envelope.contextId).notes) : envelope
    assert.equal(context.promptSkill, v.skillText)
    assert.equal(context.persona.personaId, v.personaId)
    assert.match(v.skillHash, /^[a-f0-9]{64}$/)
    const files = await runtime.quality.files(v.revision)
    assert.ok(files.length > 0)
    summaries.push({
      persona: v.personaId,
      agent: v.agentId,
      revision: v.revision,
      skillHash: v.skillHash,
      budgetSeconds: card.metadata.automation.maxRuntimeSeconds
    })
  }
  assert.match((await runtime.discover()).reason, /active/)
  runtime.policy.enabled = false
  assert.equal((await runtime.reconcile()).paused, true)
  let migration
  if (process.argv[4]) {
    // Reconstruct only exported unfinished tasks in a temporary fixture. Never mutate/copy the live DB.
    const preview = JSON.parse(readFileSync(process.argv[4], "utf8"))
    assert.equal(preview.paused, true)
    assert.deepEqual(preview.running, [])
    assert.deepEqual(preview.blockers, [])
    const migrationPolicy = {
      ...policy,
      enabled: false,
      repository: scratch,
      boardId: policy.boardId + "-migration-smoke"
    }
    const fixture = join(scratch, "legacy-fixture.db")
    const db = new DatabaseSync(fixture)
    db.exec(`
      CREATE TABLE projects(id TEXT,repo_path TEXT);
      CREATE TABLE automations(project_id TEXT,status TEXT);
      CREATE TABLE tasks(id TEXT,project_id TEXT,title TEXT,status TEXT,depends_on_task_ids_json TEXT,
        description TEXT,task_package_json TEXT,blocked_reason TEXT,last_error TEXT,created_at TEXT,allowed_paths_json TEXT,persona_id TEXT);
      CREATE TABLE runs(id TEXT,project_id TEXT,task_id TEXT,status TEXT,head_sha TEXT,branch_name TEXT,worktree_path TEXT,
        review_verdict TEXT,verification_summary TEXT,started_at TEXT);`)
    db.prepare("INSERT INTO projects VALUES (?,?)").run(preview.projectId, scratch)
    db.prepare("INSERT INTO automations VALUES (?,?)").run(preview.projectId, "paused")
    for (const [i, task] of preview.tasks.entries()) {
      const original = JSON.parse(task.notes)
      db.prepare("INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(
        task.id,
        preview.projectId,
        task.title,
        task.status,
        JSON.stringify(task.dependencies),
        original.description ?? null,
        JSON.stringify(original.package),
        original.blockedReason ?? null,
        original.lastError ?? null,
        String(i).padStart(8, "0"),
        JSON.stringify(original.allowedPaths),
        original.personaId ?? null
      )
      for (const [j, run] of (original.evidence ?? []).entries())
        db.prepare("INSERT INTO runs VALUES (?,?,?,?,?,?,?,?,?,?)").run(
          run.id,
          preview.projectId,
          task.id,
          run.status,
          run.head_sha ?? null,
          run.branch_name ?? null,
          run.worktree_path ?? null,
          run.review_verdict ?? null,
          run.verification_summary ?? null,
          String(100 - j).padStart(8, "0")
        )
    }
    db.close()
    const plan = planNativeMigration(fixture, migrationPolicy)
    for (let attempt = 0; attempt < 2; attempt++)
      await applyNativeMigration({
        plan,
        policy: migrationPolicy,
        gateway,
        store,
        backupPath: join(scratch, `backup-${attempt}.db`)
      })
    const imported = await gateway.request("workboard.cards.list", { boardId: migrationPolicy.boardId })
    assert.equal(imported.cards.length, preview.tasks.length)
    assert.ok(imported.cards.every((card) => card.status === "blocked" && card.notes.length <= 4000))
    for (const task of preview.tasks) {
      const original = JSON.parse(task.notes)
      const preserved = JSON.parse(store.get("migration-task", `${preview.projectId}:${task.id}`).notes)
      assert.equal(preserved.description, original.description)
      assert.deepEqual(preserved.package, original.package)
      assert.deepEqual(preserved.evidence, original.evidence)
    }
    migration = {
      tasks: imported.cards.length,
      allHeld: true,
      repeatedImportIdempotent: true,
      fullEvidencePreserved: true
    }
  }
  const report = {
    ok: true,
    mode: "isolated Workboard contract with actual project policy and committed Git tree",
    personas: policy.personas.length,
    investigations: summaries,
    createdCards: listing.cards.length,
    duplicateRoundPrevented: true,
    pausedReconcile: true,
    liveAgentsStarted: 0,
    applicationEdits: 0,
    deployments: 0,
    ...(migration ? { migration } : {})
  }

  console.log(JSON.stringify(report, null, 2))
} finally {
  store.close()
  rmSync(scratch, { recursive: true, force: true })
}
