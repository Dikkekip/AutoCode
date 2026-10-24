import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { registerHooks } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { decide, idle, run } from "./native-autonomy-maintenance.mjs"

const status = () => ({
  boardId: "test",
  gatewayPid: 123,
  control: { paused: false, revision: "initial" },
  activeLeases: [],
  operations: [],
  resourcePressure: { reservedBytes: 0, reasons: ["gateway-memory"] }
})
test("memory pressure requires sustained observations and cooldown; CPU pressure never restarts", () => {
  let s = decide({}, status(), 10_000_000)
  s = decide(s, status(), 10_300_000)
  assert.equal(s.eligible, false)
  s = decide(s, status(), 10_600_000)
  assert.equal(s.eligible, true)
  assert.equal(decide(s, { ...status(), gatewayPid: 456 }, 10_900_000).eligible, false)
  assert.equal(decide({ ...s, lastRestartAt: 10_600_000 }, status(), 10_900_000).eligible, false)
  assert.equal(decide(s, { resourcePressure: { reasons: ["cpu-load"] } }, 11_000_000).eligible, false)
})
test("active cards, reservations, leases and missing evidence block maintenance", () => {
  assert.equal(idle(status(), []), true)
  assert.equal(idle(status(), [{ status: "running" }]), false)
  assert.equal(idle(status(), [{ status: "blocked", execution: { status: "pending" } }]), false)
  assert.equal(idle({ ...status(), activeLeases: [{}] }, []), false)
  assert.equal(idle({ ...status(), resourcePressure: { reservedBytes: 1 } }, []), false)
  assert.equal(idle({ control: {} }, []), false)
  assert.equal(idle(status(), [{ status: "ready", metadata: { claim: { expiresAt: Date.now() + 60000 } } }]), false)
})
test("restart closes admission, preserves ownership through restart, resumes only its exact pause", async () => {
  const dir = mkdtempSync(join(tmpdir(), "native-maintenance-"))
  const statePath = join(dir, "state.json")
  let live = status(),
    cards = [],
    restarted = 0,
    resumed = 0
  const command = (program, args) => {
    if (program === "systemctl" && args.includes("show")) return "123\n"
    if (program === "systemctl") {
      restarted++
      return ""
    }
    throw new Error(`Unexpected command: ${program}`)
  }
  const gateway = {
    async request(method, params) {
      if (method === "config.get")
        return {
          config: { plugins: { entries: { autocode: { config: { projects: ["/test/native.json"] } } } } }
        }
      if (method === "autocode.status") return live
      if (method === "workboard.cards.list") return { cards }
      if (method === "autocode.pause") {
        assert.equal(params.expectedRevision, "initial")
        live.control = { paused: true, revision: "owned" }
        return live.control
      }
      if (method === "autocode.doctor") return { ok: true }
      if (method === "autocode.resume") {
        assert.equal(params.expectedRevision, "owned")
        resumed++
        live.control = { paused: false, revision: "resumed" }
        return live.control
      }
      throw new Error(method)
    }
  }
  const check = (now) => run({ openclaw: "openclaw", board: "test", statePath, apply: true, now, command, gateway })
  try {
    await check(10_000_000)
    await check(10_300_000)
    cards = [{ status: "running" }]
    assert.equal((await check(10_600_000)).action, "wait-for-accepted-work")
    cards = []
    assert.equal((await check(10_700_000)).action, "restarted-idle-gateway")
    assert.equal(restarted, 1)
    assert.equal(JSON.parse(readFileSync(statePath)).ownedRevision, "owned")
    assert.equal((await check(10_800_000)).action, "resumed-owned-pause")
    assert.equal(resumed, 1)
    writeFileSync(statePath, JSON.stringify({ version: 1, ownedRevision: "owned" }))
    live.control = { paused: true, revision: "human" }
    assert.equal((await check(10_900_000)).action, "preserve-operator-control")
    assert.equal(resumed, 1)
    assert.equal((await check(11_000_000)).action, "preserve-operator-pause")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// All effects are injected. State is synthetic; the runner supplies a private TMPDIR.
function fixture(t, { apply = true, previous, reply, pid = 123 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "native-maintenance-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const statePath = join(dir, "state.json")
  writeFileSync(
    statePath,
    JSON.stringify(
      previous ?? {
        version: 1,
        gatewayPid: 123,
        observations: 2,
        firstPressureAt: 10_000_000
      }
    )
  )
  const calls = [],
    commands = []
  const live = status()
  const gateway = {
    async request(method, params) {
      calls.push({ method, params: structuredClone(params) })
      const override = await reply?.(method, params, calls)
      if (override !== undefined) return override
      if (method === "config.get")
        return {
          config: { plugins: { entries: { autocode: { config: { projects: ["/synthetic/native.json"] } } } } }
        }
      if (method === "autocode.status") return structuredClone(live)
      if (method === "workboard.cards.list") return { cards: [] }
      if (method === "autocode.pause") {
        live.control = { paused: true, revision: "owned" }
        return live.control
      }
      if (method === "autocode.doctor") return { ok: true }
      if (method === "autocode.resume") return { ok: true }
      throw new Error(`Unexpected RPC ${method}`)
    }
  }
  const command = (program, args, timeout) => {
    assert.equal(program, "systemctl", "RPCs must never use CLI subprocesses")
    commands.push({ program, args, timeout })
    return args.includes("show") ? `${pid}\n` : ""
  }
  return {
    calls,
    commands,
    statePath,
    gateway,
    command,
    check: (options = {}) =>
      run({
        openclaw: "/synthetic/bound-openclaw",
        board: "test",
        statePath,
        apply,
        now: 10_600_000,
        gateway,
        command,
        ...options
      })
  }
}

test("all RPCs use async gateway requests with board and CAS parameters; commands only manage systemd", async (t) => {
  const f = fixture(t)
  assert.equal((await f.check()).action, "restarted-idle-gateway")
  assert.deepEqual(f.calls, [
    { method: "config.get", params: {} },
    { method: "autocode.status", params: { boardId: "test" } },
    { method: "workboard.cards.list", params: { boardId: "test" } },
    { method: "autocode.pause", params: { boardId: "test", expectedRevision: "initial" } },
    { method: "autocode.status", params: { boardId: "test" } },
    { method: "workboard.cards.list", params: { boardId: "test" } }
  ])
  assert.equal(f.commands.length, 2)
  assert.equal(f.commands[1].timeout, 390_000)
})

test("no-apply previews neither persist state nor pause, resume or invoke systemctl", async (t) => {
  const f = fixture(t, { apply: false })
  const before = readFileSync(f.statePath, "utf8")
  assert.equal((await f.check()).action, "restart-preview")
  assert.equal(readFileSync(f.statePath, "utf8"), before)
  assert.equal(f.commands.length, 0)
  assert.equal(
    f.calls.some((c) => /pause|resume/.test(c.method)),
    false
  )
  const owned = fixture(t, {
    apply: false,
    previous: { version: 1, ownedRevision: "owned" },
    reply: async (method) =>
      method === "autocode.status" ? { ...status(), control: { paused: true, revision: "owned" } } : undefined
  })
  assert.equal((await owned.check()).action, "resume-owned-pause-preview")
  assert.equal(
    owned.calls.some((c) => /doctor|resume/.test(c.method)),
    false
  )
})

test("partial or missing boards fail closed before pause", async (t) => {
  for (const board of [{ cards: [], hasMore: true }, { cards: [], nextCursor: "next" }, {}]) {
    const f = fixture(t, { reply: async (method) => (method === "workboard.cards.list" ? board : undefined) })
    if (board.cards) await assert.rejects(f.check(), /partial board/)
    else assert.equal((await f.check()).action, "wait-for-accepted-work")
    assert.equal(
      f.calls.some((c) => c.method === "autocode.pause"),
      false
    )
    assert.equal(f.commands.length, 0)
  }
})

test("SDK rejection is propagated with cause but private payload is absent from displayed error", async (t) => {
  const cause = new Error("synthetic private response")
  const f = fixture(t, {
    reply: async (method) => {
      if (method === "workboard.cards.list") throw cause
    }
  })
  await assert.rejects(f.check(), (error) => {
    assert.equal(error.cause, cause)
    assert.match(error.message, /Maintenance RPC workboard.cards.list failed/)
    assert.equal(error.message.includes(cause.message), false)
    return true
  })
  assert.equal(f.commands.length, 0)
  assert.equal(
    f.calls.some((c) => c.method === "autocode.pause"),
    false
  )
})

test("pause CAS rejection or unacknowledged pause cannot restart", async (t) => {
  for (const rejected of [true, false]) {
    const f = fixture(t, {
      reply: async (method, params) => {
        if (method !== "autocode.pause") return
        assert.equal(params.expectedRevision, "initial")
        if (rejected) throw new Error("CAS conflict")
        return { paused: false, revision: "other" }
      }
    })
    await assert.rejects(f.check(), rejected ? /autocode.pause failed/ : /not acknowledged/)
    assert.equal(f.commands.length, 0)
    assert.equal(JSON.parse(readFileSync(f.statePath)).ownedRevision, undefined)
  }
})

test("accepted work racing pause resumes only owned revision without restart", async (t) => {
  let boards = 0
  const f = fixture(t, {
    reply: async (method) =>
      method === "workboard.cards.list" ? { cards: ++boards === 2 ? [{ status: "running" }] : [] } : undefined
  })
  assert.equal((await f.check()).action, "accepted-work-raced-maintenance")
  assert.deepEqual(f.calls.at(-1), {
    method: "autocode.resume",
    params: { boardId: "test", expectedRevision: "owned" }
  })
  assert.equal(f.commands.length, 0)
  assert.equal(JSON.parse(readFileSync(f.statePath)).ownedRevision, undefined)
})

test("operator revision change during drain preserves control without resume or restart", async (t) => {
  let statuses = 0
  const f = fixture(t, {
    reply: async (method) =>
      method === "autocode.status" && ++statuses === 2
        ? { ...status(), control: { paused: true, revision: "operator" } }
        : undefined
  })
  assert.equal((await f.check()).action, "preserve-operator-control")
  assert.equal(f.commands.length, 0)
  assert.equal(
    f.calls.some((c) => c.method === "autocode.resume"),
    false
  )
})

test("changed systemd or drained gateway PID withholds restart and retains owned pause", async (t) => {
  for (const changedSystemd of [true, false]) {
    let statuses = 0
    const f = fixture(t, {
      pid: changedSystemd ? 456 : 123,
      reply: async (method) =>
        !changedSystemd && method === "autocode.status" && ++statuses === 2
          ? { ...status(), gatewayPid: 456, control: { paused: true, revision: "owned" } }
          : undefined
    })
    await assert.rejects(f.check(), /process changed/)
    assert.equal(
      f.commands.some((c) => c.args.includes("restart")),
      false
    )
    assert.equal(JSON.parse(readFileSync(f.statePath)).ownedRevision, "owned")
  }
})

test("Doctor failure and resume CAS conflict retain exact owned pause", async (t) => {
  for (const doctorFails of [true, false]) {
    const f = fixture(t, {
      previous: { version: 1, ownedRevision: "owned" },
      reply: async (method, params) => {
        if (method === "autocode.status") return { ...status(), control: { paused: true, revision: "owned" } }
        if (method === "autocode.doctor" && doctorFails) return { ok: false }
        if (method === "autocode.resume") {
          assert.equal(params.expectedRevision, "owned")
          throw new Error("CAS conflict")
        }
      }
    })
    await assert.rejects(f.check(), doctorFails ? /autocode.doctor failed/ : /autocode.resume failed/)
    assert.equal(JSON.parse(readFileSync(f.statePath)).ownedRevision, "owned")
    assert.equal(f.commands.length, 0)
  }
})

test("multiple projects and wrong-board status refuse maintenance", async (t) => {
  for (const multiple of [true, false]) {
    const f = fixture(t, {
      reply: async (method) => {
        if (multiple && method === "config.get")
          return {
            parsed: { plugins: { entries: { autocode: { config: { projects: ["a", "b"] } } } } }
          }
        if (!multiple && method === "autocode.status") return { ...status(), boardId: "other" }
      }
    })
    await assert.rejects(f.check(), multiple ? /one registered/ : /status unavailable/)
    assert.equal(f.commands.length, 0)
  }
})

test("default gateway lazily loads public framework dist export with the configured CLI binding", async (t) => {
  const f = fixture(t, { apply: false })
  const bindings = []
  // Stub the public module boundary before any built runtime, SDK or RPC executes.
  globalThis.__maintenanceGatewayFixture = { bindings, gateway: f.gateway }
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "../packages/core-runtime/dist/index.js")
        return {
          url:
            "data:text/javascript," +
            encodeURIComponent(`
        export class NativeSdkGateway {
          constructor(command) {
            globalThis.__maintenanceGatewayFixture.bindings.push(command)
          }
          request(method, params) {
            return globalThis.__maintenanceGatewayFixture.gateway.request(method, params)
          }
        }
      `),
          shortCircuit: true
        }
      return nextResolve(specifier, context)
    }
  })
  try {
    assert.equal((await f.check({ gateway: undefined })).action, "restart-preview")
    assert.deepEqual(bindings, ["/synthetic/bound-openclaw"])
    assert.equal(f.calls.filter((c) => c.method === "workboard.cards.list").length, 1)
    assert.equal(f.commands.length, 0)
  } finally {
    hooks.deregister()
    delete globalThis.__maintenanceGatewayFixture
  }
})
