import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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
test("restart closes admission, preserves ownership through restart, resumes only its exact pause", () => {
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
    const method = args[2],
      params = JSON.parse(args.at(-1))
    if (method === "config.get")
      return JSON.stringify({
        config: { plugins: { entries: { autocode: { config: { projects: ["/test/native.json"] } } } } }
      })
    if (method === "autocode.status") return JSON.stringify(live)
    if (method === "workboard.cards.list") return JSON.stringify({ cards })
    if (method === "autocode.pause") {
      assert.equal(params.expectedRevision, "initial")
      live.control = { paused: true, revision: "owned" }
      return JSON.stringify(live.control)
    }
    if (method === "autocode.doctor") return JSON.stringify({ ok: true })
    if (method === "autocode.resume") {
      assert.equal(params.expectedRevision, "owned")
      resumed++
      live.control = { paused: false, revision: "resumed" }
      return JSON.stringify(live.control)
    }
    throw new Error(method)
  }
  const check = (now) => run({ openclaw: "openclaw", board: "test", statePath, apply: true, now, command })
  try {
    check(10_000_000)
    check(10_300_000)
    cards = [{ status: "running" }]
    assert.equal(check(10_600_000).action, "wait-for-accepted-work")
    cards = []
    assert.equal(check(10_700_000).action, "restarted-idle-gateway")
    assert.equal(restarted, 1)
    assert.equal(JSON.parse(readFileSync(statePath)).ownedRevision, "owned")
    assert.equal(check(10_800_000).action, "resumed-owned-pause")
    assert.equal(resumed, 1)
    writeFileSync(statePath, JSON.stringify({ version: 1, ownedRevision: "owned" }))
    live.control = { paused: true, revision: "human" }
    assert.equal(check(10_900_000).action, "preserve-operator-control")
    assert.equal(resumed, 1)
    assert.equal(check(11_000_000).action, "preserve-operator-pause")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
