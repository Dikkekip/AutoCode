import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { classifyProbe, decide, run } from "./native-gateway-recovery.mjs"

const cleanupError = JSON.stringify({ ok: false, error: { message: "Agent database cleanup failed" } })

test("classifies only a successful card listing as healthy", () => {
  assert.equal(classifyProbe(0, JSON.stringify({ cards: [] })), "healthy")
  assert.equal(classifyProbe(1, cleanupError), "cleanup_failed")
  assert.equal(classifyProbe(1, JSON.stringify({ error: { message: "gateway timeout" } })), "other_error")
  assert.equal(classifyProbe(0, "not json"), "other_error")
})

test("three persistent cleanup failures restart once and a healthy response resets the counter", () => {
  const dir = mkdtempSync(join(tmpdir(), "native-gateway-recovery-"))
  const statePath = join(dir, "recovery.json")
  let pid = 123
  let response = cleanupError
  let restarts = 0
  const invoke = (program, args) => {
    if (program === "systemctl" && args.includes("show")) {
      return { exitCode: 0, stdout: `ActiveState=active\nMainPID=${pid}\n` }
    }
    if (program === "systemctl" && args.includes("restart")) {
      restarts++
      return { exitCode: 0, stdout: "" }
    }
    return { exitCode: response === cleanupError ? 1 : 0, stdout: response }
  }
  const check = (now, apply = true) => run({ openclaw: "/bin/openclaw", board: "demo", statePath, apply, now, invoke })
  try {
    assert.equal(check(1_000_000).restartAttempted, false)
    assert.equal(check(1_300_000).restartAttempted, false)
    assert.equal(check(1_600_000).restartAttempted, true)
    assert.equal(restarts, 1)
    assert.equal(check(1_900_000).restartAttempted, false)
    assert.equal(restarts, 1)
    response = JSON.stringify({ cards: [] })
    assert.equal(check(2_000_000).consecutiveFailures, 0)
    assert.equal(JSON.parse(readFileSync(statePath, "utf8")).lastRestartAtMs, 1_600_000)
    response = cleanupError
    pid = 456
    assert.equal(check(2_100_000).consecutiveFailures, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("dry run and unrelated failures never restart the Gateway", () => {
  const dir = mkdtempSync(join(tmpdir(), "native-gateway-recovery-"))
  const statePath = join(dir, "recovery.json")
  let response = cleanupError
  let restarts = 0
  const invoke = (program, args) => {
    if (program === "systemctl" && args.includes("show"))
      return { exitCode: 0, stdout: "ActiveState=active\nMainPID=123\n" }
    if (program === "systemctl" && args.includes("restart")) {
      restarts++
      return { exitCode: 0, stdout: "" }
    }
    return { exitCode: 1, stdout: response }
  }
  const check = (now, apply) => run({ openclaw: "/bin/openclaw", board: "demo", statePath, apply, now, invoke })
  try {
    check(1_000_000, false)
    check(1_300_000, false)
    assert.equal(check(1_600_000, false).restartEligible, true)
    assert.equal(restarts, 0)
    response = JSON.stringify({ ok: false, error: { message: "gateway timeout" } })
    assert.equal(check(1_900_000, true).consecutiveFailures, 0)
    assert.equal(restarts, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("process replacement, inactive service and cooldown prevent repeat restarts", () => {
  const previous = { version: 1, pid: 123, failures: 3, firstFailedAtMs: 1_000_000, lastRestartAtMs: 1_600_000 }
  const observation = { pid: 123, active: true, probe: "cleanup_failed", now: 1_900_000 }
  assert.equal(decide(previous, observation).restart, false)
  assert.equal(decide(previous, { ...observation, pid: 456 }).state.failures, 1)
  assert.equal(decide(previous, { ...observation, active: false }).state.failures, 0)
  assert.equal(decide(previous, { ...observation, now: 5_200_000 }).restart, true)
})
