import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { atomicState, guard } from "./native-quota-reset.mjs"

const config = {
  email: "operator@example.test",
  accountId: "account-1",
  creditId: "approved-credit",
  statePath: "/tmp/test-state",
  codexPath: "/opt/codex",
  allowReset: true
}
function fixture() {
  const env = {
    state: null,
    calls: [],
    allowedAfter: true,
    usage: {
      accountId: config.accountId,
      ordinaryUsageAllowed: false,
      rateLimits: { limitId: "codex", primary: { usedPercent: 100 }, spendControlReached: false },
      rateLimitResetCredits: {
        availableCount: 1,
        credits: [{ id: config.creditId, status: "available", resetType: "codexRateLimits", expiresAt: null }]
      }
    }
  }
  env.storage = {
    read: async () => structuredClone(env.state),
    write: async (state) => {
      env.state = structuredClone(state)
    }
  }
  env.rpc = async (method, params) => {
    env.calls.push({ method, params })
    if (method === "account/read") return { account: { type: "chatgpt", email: config.email } }
    if (method === "account/rateLimits/read") return structuredClone(env.usage)
    assert.equal(method, "account/rateLimitResetCredit/consume")
    assert.equal(env.state.attempt.status, "pending", "attempt persisted before consume")
    assert.equal(params.idempotencyKey, env.state.attempt.idempotencyKey)
    env.usage.ordinaryUsageAllowed = env.allowedAfter
    return { outcome: "reset" }
  }
  env.run = (overrides = {}) => guard({ ...config, ...overrides }, env.rpc, env.storage)
  env.consumes = () => env.calls.filter((call) => call.method.endsWith("/consume"))
  return env
}

test("included usage retains the authorized reset even at a stale 100 percent", async () => {
  const env = fixture()
  env.usage.ordinaryUsageAllowed = true
  assert.equal((await env.run()).action, "continue")
  assert.equal(env.consumes().length, 0)
  assert.equal(env.state, null)
})
test("unknown backend permission cannot be inferred from percentages", async () => {
  const env = fixture()
  delete env.usage.ordinaryUsageAllowed
  assert.equal((await env.run()).action, "blocked")
  assert.equal(env.consumes().length, 0)
})
test("denied usage without exhausted windows does not reset", async () => {
  const env = fixture()
  env.usage.rateLimits.primary.usedPercent = 40
  assert.equal((await env.run()).action, "blocked")
  assert.equal(env.consumes().length, 0)
})
test("spend controls and unknown spend state block consumption", async () => {
  for (const value of [true, null, undefined]) {
    const env = fixture()
    env.usage.rateLimits.spendControlReached = value
    assert.equal((await env.run()).action, "blocked")
    assert.equal(env.consumes().length, 0)
  }
})
test("wrong account or wrong persisted binding cannot mutate", async () => {
  const env = fixture()
  env.usage.accountId = "wrong"
  await assert.rejects(env.run(), /account mismatch/)
  assert.equal(env.state, null)
  env.usage.accountId = config.accountId
  env.state = { version: 1, binding: { ...config, creditId: "different" } }
  await assert.rejects(env.run(), /binding mismatch/)
  assert.equal(env.consumes().length, 0)
})
test("authorization and exact available unexpired credit are required", async () => {
  for (const edit of [
    (e) => (e.usage.rateLimitResetCredits.credits = []),
    (e) => (e.usage.rateLimitResetCredits.credits[0].expiresAt = 1),
    (e) => (e.usage.rateLimitResetCredits.credits[0].id = "other")
  ]) {
    const env = fixture()
    edit(env)
    assert.equal((await env.run()).action, "blocked")
    assert.equal(env.consumes().length, 0)
  }
  const env = fixture()
  assert.equal((await env.run({ allowReset: false })).action, "blocked")
  assert.equal(env.consumes().length, 0)
})
test("reset is persisted before consume, read back, and never spent twice", async () => {
  const env = fixture()
  assert.equal((await env.run()).action, "continue")
  assert.equal(env.state.attempt.outcome, "reset")
  assert.equal(env.state.after.ordinaryUsageAllowed, true)
  env.usage.ordinaryUsageAllowed = false
  assert.equal((await env.run()).action, "exhausted")
  assert.equal(env.consumes().length, 1)
})
test("ambiguous transport failure replays identical key even without a remaining credit", async () => {
  const env = fixture()
  const rpc = env.rpc
  env.rpc = async (method, params) => {
    if (method.endsWith("/consume")) {
      await rpc(method, params)
      throw new Error("transport timeout")
    }
    return rpc(method, params)
  }
  await assert.rejects(env.run(), /timeout/)
  const key = env.state.attempt.idempotencyKey
  env.usage.rateLimitResetCredits = { availableCount: 0, credits: [] }
  env.rpc = async (method, params) => {
    const response = await rpc(method, params)
    return method.endsWith("/consume") ? { outcome: "alreadyRedeemed" } : response
  }
  assert.equal((await env.run()).resetOutcome, "alreadyRedeemed")
  assert.equal(env.consumes().length, 2)
  assert.ok(env.consumes().every((c) => c.params.idempotencyKey === key))
})
test("failed durable write prevents consumption", async () => {
  const env = fixture()
  env.storage.write = async () => {
    throw new Error("disk full")
  }
  await assert.rejects(env.run(), /disk full/)
  assert.equal(env.consumes().length, 0)
})
test("reset response alone is not recovery evidence", async () => {
  const env = fixture()
  env.allowedAfter = null
  const result = await env.run()
  assert.equal(result.action, "blocked")
  assert.equal(result.ordinaryUsageAllowed, null)
})
test("state replacement is private and survives readback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-quota-test-"))
  try {
    const path = join(directory, "state.json")
    await atomicState(path, { key: 1 })
    await atomicState(path, { key: 2 })
    assert.equal((await stat(path)).mode & 0o777, 0o600)
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { key: 2 })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("non-success responses never claim the reset was spent", async () => {
  for (const outcome of ["nothingToReset", "noCredit"]) {
    const env = fixture()
    const rpc = env.rpc
    env.allowedAfter = false
    env.rpc = async (method, params) => {
      const result = await rpc(method, params)
      return method.endsWith("/consume") ? { outcome } : result
    }
    assert.equal((await env.run()).action, "blocked")
    assert.equal((await env.run()).action, "blocked")
    assert.equal(env.state.attempt.outcome, outcome)
    assert.equal(env.consumes().length, 1)
  }
})
test("pending replay blocks unknown permission without dropping the original key", async () => {
  const env = fixture()
  const rpc = env.rpc
  env.rpc = async (method, params) => {
    const result = await rpc(method, params)
    if (method.endsWith("/consume")) throw new Error("timeout")
    return result
  }
  await assert.rejects(env.run(), /timeout/)
  const key = env.state.attempt.idempotencyKey
  env.usage.ordinaryUsageAllowed = null
  assert.equal((await env.run()).action, "blocked")
  assert.equal(env.consumes().length, 1)
  assert.equal(env.state.attempt.idempotencyKey, key)
})
