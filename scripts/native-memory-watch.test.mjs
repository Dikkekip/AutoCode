import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { decideMemoryRecovery, runMemoryWatch } from "./native-memory-watch.mjs"

const observation = { pid: 123, rssBytes: 3500 * 1024 * 1024, idle: true, now: 1_000_000 }
test("requires sustained pressure and idle work; process replacement and recovery reset samples", () => {
  const first = decideMemoryRecovery({}, observation)
  const second = decideMemoryRecovery(first.state, { ...observation, now: 1_060_000 })
  assert.equal(second.restartEligible, false)
  const third = decideMemoryRecovery(second.state, { ...observation, now: 1_120_000 })
  assert.equal(third.restartEligible, true)
  assert.equal(
    decideMemoryRecovery(second.state, { ...observation, now: 1_120_000, idle: false }).restartEligible,
    false
  )
  assert.equal(decideMemoryRecovery(second.state, { ...observation, now: 1_120_000, pid: 124 }).restartEligible, false)
  assert.equal(decideMemoryRecovery(second.state, { ...observation, now: 1_600_000 }).state.samples, 1)
  assert.equal(decideMemoryRecovery(third.state, { ...observation, rssBytes: 1024 }).state.samples, 0)
  assert.equal(
    decideMemoryRecovery({ ...third.state, lastRestartAt: 1_100_000 }, { ...observation, now: 1_120_000 })
      .restartEligible,
    false
  )
})

test("rejects corrupted state or telemetry rather than restarting", () => {
  for (const patch of [{ rssBytes: NaN }, { rssBytes: -1 }, { maxRssMiB: 0 }, { now: NaN }])
    assert.throws(() => decideMemoryRecovery({}, { ...observation, ...patch }))
  assert.throws(() => decideMemoryRecovery({ version: 1, pid: 123, samples: "3" }, observation))
})

for (const change of ["pid", "work"]) {
  test(`rechecks ${change} before restart and retains cooldown when it changes`, () => {
    const root = mkdtempSync(join(tmpdir(), "native-memory-watch-"))
    const statePath = join(root, "state.json")
    let cardsCalls = 0
    let last = false
    const read = (path, encoding) => (path.startsWith("/proc/") ? "VmRSS: 3584000 kB\n" : readFileSync(path, encoding))
    const command = (program, args) => {
      assert.equal(args.includes("restart"), false)
      if (program === "systemctl")
        return args.includes("ActiveState")
          ? "ActiveState=active\nMainPID=123\n"
          : `MainPID=${change === "pid" ? 124 : 123}\n`
      cardsCalls++
      return JSON.stringify({ cards: last && cardsCalls === 2 ? [{ status: "running" }] : [] })
    }
    try {
      for (const now of [1_000_000, 1_060_000]) runMemoryWatch({ statePath, now, apply: true, read, command })
      last = true
      cardsCalls = 0
      assert.throws(
        () => runMemoryWatch({ statePath, now: 1_120_000, apply: true, read, command }),
        change === "pid" ? /changed before/ : /active or uncertain/
      )
      assert.equal(JSON.parse(readFileSync(statePath)).lastRestartAt, 1_120_000)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
}

test("observation mode preserves eligibility without restarting; apply rechecks idle and PID", () => {
  const root = mkdtempSync(join(tmpdir(), "native-memory-watch-"))
  const statePath = join(root, "state.json")
  let restarts = 0
  const command = (program, args) => {
    if (program === "systemctl" && args.includes("restart")) {
      restarts++
      return ""
    }
    if (program === "systemctl")
      return args.includes("ActiveState") ? "ActiveState=active\nMainPID=123\n" : "MainPID=123\n"
    return JSON.stringify({ cards: [] })
  }
  const read = (path, encoding) => (path.startsWith("/proc/") ? "VmRSS: 3584000 kB\n" : readFileSync(path, encoding))
  const run = (now, apply) => runMemoryWatch({ statePath, now, apply, command, read })
  try {
    run(1_000_000, false)
    run(1_060_000, false)
    assert.equal(run(1_120_000, false).restartEligible, true)
    assert.equal(restarts, 0)
    assert.equal(JSON.parse(readFileSync(statePath)).lastRestartAt, null)
    assert.equal(run(1_180_000, true).restartAttempted, true)
    assert.equal(restarts, 1)
    assert.equal(run(1_240_000, true).restartAttempted, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

for (const inventory of [
  { cards: [{ status: "running" }] },
  { cards: [], hasMore: true },
  { cards: [{ status: "ready", metadata: { claim: { ownerId: "worker" } } }] },
  { cards: [{ status: "review", execution: { status: "running" } }] },
  { cards: [{}] },
  {}
]) {
  test(`uncertain or active inventory prevents memory recovery: ${JSON.stringify(inventory)}`, () => {
    const root = mkdtempSync(join(tmpdir(), "native-memory-watch-"))
    try {
      const statePath = join(root, "state.json")
      const read = (path, encoding) =>
        path.startsWith("/proc/") ? "VmRSS: 3584000 kB\n" : readFileSync(path, encoding)
      const command = (program, args) => {
        assert.equal(args.includes("restart"), false)
        return program === "systemctl" ? "ActiveState=active\nMainPID=123\n" : JSON.stringify(inventory)
      }
      for (const now of [1_000_000, 1_060_000, 1_120_000])
        assert.equal(runMemoryWatch({ statePath, now, apply: true, command, read }).restartAttempted, false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
}
