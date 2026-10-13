import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { run } from "./native-continuous-loop.mjs"

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "native-loop-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const status = {
    boardId: "demo",
    enabled: true,
    control: { paused: false, frozen: false },
    activeLeases: [],
    operations: [],
    counts: {}
  }
  const calls = []
  const responses = {
    "autocode.status": status,
    "autocode.doctor": { ok: true, skillBinding: { ok: true } },
    "autocode.reconcile": { advanced: 1 },
    "autocode.discover": { created: ["card"] }
  }
  const options = {
    openclaw: "/bin/openclaw",
    board: "demo",
    statePath: join(directory, "loop.json"),
    apply: true,
    now: 1_000_000,
    command: (_program, args) => {
      const method = args[2]
      calls.push(method)
      const response = responses[method]
      if (response instanceof Error) throw response
      return JSON.stringify(typeof response === "function" ? response() : response)
    }
  }
  return { status, calls, responses, options }
}

test("preserves paused, frozen, disabled and busy native control without mutation", (t) => {
  for (const patch of [
    { control: { paused: true, frozen: false } },
    { control: { paused: false, frozen: true } },
    { enabled: false },
    { activeLeases: [{ id: "verify" }] }
  ]) {
    const f = fixture(t)
    Object.assign(f.status, patch)
    assert.match(run(f.options).action, /preserve-operator-control|wait-for-native-operation/)
    assert.deepEqual(f.calls, ["autocode.status"])
  }
})

test("incomplete status and failed readiness cannot reach reconcile", (t) => {
  const f = fixture(t)
  delete f.status.control.frozen
  assert.throws(() => run(f.options), /status incomplete/)
  f.status.control.frozen = false
  f.responses["autocode.doctor"].skillBinding.ok = false
  assert.equal(run(f.options).action, "readiness-blocked")
  assert.equal(f.calls.includes("autocode.reconcile"), false)
})

test("preview checks readiness without invoking any mutation", (t) => {
  const f = fixture(t)
  assert.equal(run({ ...f.options, apply: false }).action, "tick-preview")
  assert.deepEqual(f.calls, ["autocode.status", "autocode.doctor"])
})

test("advances work every tick and bounds idle discovery cadence", (t) => {
  const f = fixture(t)
  assert.deepEqual(run(f.options), { action: "discovered", advanced: 1, created: 1 })
  assert.deepEqual(run({ ...f.options, now: 1_060_000 }), { action: "reconciled", advanced: 1 })
  assert.equal(f.calls.filter((m) => m === "autocode.discover").length, 1)
  assert.equal(run({ ...f.options, now: 2_800_000 }).action, "discovered")
})

test("lost discovery response preserves admission time and does not repeat the round", (t) => {
  const f = fixture(t)
  f.responses["autocode.discover"] = new Error("timeout after acceptance")
  assert.throws(() => run(f.options), /timeout after acceptance/)
  assert.equal(JSON.parse(readFileSync(f.options.statePath, "utf8")).lastDiscoveryAt, 1_000_000)
  assert.equal(run({ ...f.options, now: 1_060_000 }).action, "reconciled")
  assert.equal(f.calls.filter((m) => m === "autocode.discover").length, 1)
})

test("uncertain reconciliation does not issue follow-on discovery", (t) => {
  const f = fixture(t)
  f.responses["autocode.reconcile"] = new Error("timeout after acceptance")
  assert.throws(() => run(f.options), /timeout after acceptance/)
  assert.equal(f.calls.includes("autocode.discover"), false)
})

test("persisted effect records do not starve reconciliation of unrelated work", (t) => {
  const f = fixture(t)
  f.status.operations = [
    { id: "old:push", value: { state: "confirmed" } },
    { id: "blocked:merge", value: { state: "uncertain" } }
  ]
  f.status.counts = { running: 1 }
  assert.equal(run(f.options).action, "reconciled")
  assert.equal(f.calls.filter((m) => m === "autocode.reconcile").length, 1)
  assert.equal(f.calls.includes("autocode.discover"), false)
})

test("reports actual dispatch deferral while keeping private diagnostics out of tick logs", (t) => {
  const f = fixture(t)
  f.status.counts = { ready: 1 }
  f.responses["autocode.reconcile"] = {
    advanced: 0,
    dispatch: {
      startedCount: 0,
      deferredCount: 1,
      deferred: [{ cardId: "card", reason: "worktree-capacity", error: "/private/path" }],
      resourcePressure: { reasons: ["gateway-memory", "/private/telemetry"] }
    }
  }
  assert.deepEqual(run(f.options), {
    action: "reconciled",
    advanced: 0,
    dispatch: {
      startedCount: 0,
      deferredCount: 1,
      resourceReasons: ["gateway-memory"],
      deferred: [{ cardId: "card", reason: "worktree-capacity" }]
    }
  })
})

test("a pause or new accepted work during reconciliation blocks discovery", (t) => {
  for (const change of [
    () => ({ control: { paused: true, frozen: false } }),
    () => ({ counts: { running: 1 } }),
    () => ({ counts: { ready: 1 } }),
    () => ({ activeLeases: [{ id: "new" }] })
  ]) {
    const f = fixture(t)
    f.responses["autocode.reconcile"] = () => {
      Object.assign(f.status, change())
      return { advanced: 1 }
    }
    run(f.options)
    assert.equal(f.calls.includes("autocode.discover"), false)
  }
})
