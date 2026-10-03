import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { monitor, validateMonitorConfig } from "./native-quota-monitor.mjs"

const config = {
  guardConfigPath: "/operator/guard.json",
  snapshotPath: "/operator/status.json",
  openclawPath: "/opt/bin/openclaw",
  boardId: "example-board"
}
function harness(result, previous, response = { paused: true, revision: "pause-revision" }) {
  const calls = [],
    saves = []
  return {
    calls,
    saves,
    dependencies: {
      read: () => {
        if (previous === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" })
        return JSON.stringify(previous)
      },
      exec: (...args) => {
        calls.push(args)
        return JSON.stringify(calls.length === 1 ? result : response)
      },
      save: async (...args) => {
        saves.push(args)
      },
      now: () => "2030-01-01T00:00:00.000Z"
    }
  }
}
for (const resetOutcome of ["reset", "alreadyRedeemed"]) {
  test(`pauses only after exhausted proven redemption: ${resetOutcome}`, async () => {
    const h = harness({ action: "exhausted", resetOutcome })
    const result = await monitor(config, h.dependencies)
    assert.equal(h.calls.length, 2)
    assert.equal(h.calls[0][0], process.execPath)
    assert.deepEqual(h.calls[0][1].slice(1), ["--config", config.guardConfigPath])
    assert.equal(h.calls[0][2].timeout, 210000)
    assert.equal(h.calls[1][0], config.openclawPath)
    assert.deepEqual(h.calls[1][1], [
      "gateway",
      "call",
      "autocode.pause",
      "--json",
      "--timeout",
      "30000",
      "--params",
      JSON.stringify({ boardId: config.boardId })
    ])
    assert.equal(h.calls[1][2].timeout, 40000)
    assert.deepEqual(result.pause, { at: "2030-01-01T00:00:00.000Z", revision: "pause-revision" })
    assert.deepEqual(h.saves, [[config.snapshotPath, result]])
  })
}
for (const result of [
  { action: "continue", resetOutcome: "reset" },
  { action: "blocked" },
  { action: "exhausted", resetOutcome: "noCredit" },
  { action: "exhausted" }
]) {
  test(`no control mutation for ${JSON.stringify(result)}`, async () => {
    const h = harness(result)
    assert.equal((await monitor(config, h.dependencies)).pause, null)
    assert.equal(h.calls.length, 1)
  })
}
test("preserves an existing pause without pause or resume calls", async () => {
  const pause = { revision: "existing", at: "earlier" }
  const h = harness({ action: "exhausted", resetOutcome: "reset" }, { pause })
  assert.deepEqual((await monitor(config, h.dependencies)).pause, pause)
  assert.equal(h.calls.length, 1)
})
for (const response of [{ paused: false, revision: "wrong" }, { paused: true }]) {
  test(`unconfirmed pause does not overwrite snapshot: ${JSON.stringify(response)}`, async () => {
    const h = harness({ action: "exhausted", resetOutcome: "reset" }, undefined, response)
    await assert.rejects(monitor(config, h.dependencies), /not confirmed/)
    assert.equal(h.saves.length, 0)
  })
}
test("malformed or unreadable snapshot fails before reset guard", async () => {
  for (const read of [
    () => "{bad",
    () => {
      throw Object.assign(new Error("denied"), { code: "EACCES" })
    }
  ]) {
    const h = harness({ action: "continue" })
    await assert.rejects(monitor(config, { ...h.dependencies, read }))
    assert.equal(h.calls.length, 0)
    assert.equal(h.saves.length, 0)
  }
})
test("guard transport failure preserves previous snapshot", async () => {
  const h = harness({ action: "continue" })
  await assert.rejects(
    monitor(config, {
      ...h.dependencies,
      exec: () => {
        throw new Error("transport")
      }
    }),
    /transport/
  )
  assert.equal(h.saves.length, 0)
})
test("requires explicit paths and board, and rejects configuration overwrite", () => {
  for (const key of Object.keys(config)) assert.throws(() => validateMonitorConfig({ ...config, [key]: "" }), /Missing/)
  assert.throws(() => validateMonitorConfig({ ...config, openclawPath: "openclaw" }), /absolute/)
  assert.throws(() => validateMonitorConfig({ ...config, snapshotPath: config.guardConfigPath }), /overwrite/)
})
test("persists a private snapshot using real atomic storage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-quota-monitor-"))
  try {
    const snapshotPath = join(directory, "status.json")
    const result = await monitor({ ...config, snapshotPath }, { exec: () => JSON.stringify({ action: "continue" }) })
    assert.deepEqual(JSON.parse(await readFile(snapshotPath, "utf8")), result)
    assert.equal((await stat(snapshotPath)).mode & 0o777, 0o600)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
