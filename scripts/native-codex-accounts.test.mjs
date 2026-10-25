import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { inspectNativePool, mergeAccounts, planOrders, readAccounts, synchronize } from "./native-codex-accounts.mjs"

const now = 1_800_000_000_000
const token = (claims) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.x`

test("expired CLI copies preserve a current native pool using read-only stores and native eligibility", () => {
  const id = "openai:codex-auth:fixture"
  const store = {
    profiles: { [id]: { provider: "openai", type: "oauth", access: "private", expires: now + 3600_000 } }
  }
  const before = JSON.stringify(store)
  const input = {
    agentIds: ["coder", "reviewer"],
    entries: { reviewer: { agentDir: "/custom/reviewer" } },
    stateDir: "/fixture",
    config: {},
    now,
    sdk: {
      ensureAuthProfileStore(dir, options) {
        assert.ok(["/fixture/agents/coder/agent", "/custom/reviewer"].includes(dir))
        assert.equal(options.readOnly, true)
        assert.equal(options.syncExternalCli, false)
        assert.deepEqual(options.externalCli, { mode: "none" })
        return store
      },
      resolveAuthProfileOrder() {
        return [id]
      }
    }
  }
  assert.deepEqual(inspectNativePool(input), { agents: 2, profiles: 1 })
  assert.equal(JSON.stringify(store), before)
  store.profiles[id].expires = now + 240_000
  assert.throws(() => inspectNativePool(input), /No usable native/)
  store.profiles[id].expires = now + 3600_000
  input.sdk.resolveAuthProfileOrder = () => []
  assert.throws(() => inspectNativePool(input), /No usable native/)
})
function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "codex-pool-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const accounts = ["a", "b", "c"].map((user, index) => {
    const workspace = index < 2 ? "business" : "personal"
    const key = `${user}::${workspace}`
    const auth = {
      tokens: {
        access_token: token({
          iat: now / 1000 - 100,
          exp: now / 1000 + 3600,
          "https://api.openai.com/auth": { chatgpt_user_id: user, chatgpt_account_id: workspace }
        }),
        refresh_token: "fixture-refresh",
        account_id: workspace
      }
    }
    writeFileSync(join(dir, `${Buffer.from(key).toString("base64url")}.auth.json`), JSON.stringify(auth))
    return {
      account_key: key,
      chatgpt_user_id: user,
      chatgpt_account_id: workspace,
      auth_mode: "chatgpt",
      last_usage_at: now / 1000,
      last_usage: {
        primary: { used_percent: 0, resets_at: now / 1000 + 300 },
        secondary: { used_percent: 0, resets_at: now / 1000 + 3600 }
      },
      ...options
    }
  })
  const save = () => writeFileSync(join(dir, "registry.json"), JSON.stringify({ schema_version: 4, accounts }))
  save()
  return { dir, accounts, save }
}

test("imports all three identities including two users in one Business workspace", (t) => {
  const { dir } = fixture(t)
  const accounts = readAccounts(dir, now)
  assert.equal(new Set(accounts.map((a) => a.profileId)).size, 3)
  const orders = planOrders(accounts, ["coder", "coder-2", "coder-3"])
  assert.equal(new Set(orders.map((o) => o.order[0])).size, 3)
  assert.ok(orders.every((o) => o.order.length === 3))
})

test("CLI succeeds without writes or reload when only native refreshed credentials remain", (t) => {
  const { dir, accounts } = fixture(t)
  for (const account of accounts) {
    const path = join(dir, `${Buffer.from(account.account_key).toString("base64url")}.auth.json`)
    const auth = JSON.parse(readFileSync(path, "utf8"))
    auth.tokens.access_token = token({
      exp: 1,
      "https://api.openai.com/auth": {
        chatgpt_user_id: account.chatgpt_user_id,
        chatgpt_account_id: account.chatgpt_account_id
      }
    })
    writeFileSync(path, JSON.stringify(auth))
  }
  const sdkDir = join(dir, "dist", "plugin-sdk")
  mkdirSync(sdkDir, { recursive: true })
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }))
  writeFileSync(
    join(sdkDir, "provider-auth.js"),
    `export function ensureAuthProfileStore(dir, options) {
       if (!options.readOnly || options.syncExternalCli !== false) throw new Error('write attempted');
       return { profiles: { 'openai:codex-auth:fixture': {
         type: 'oauth', provider: 'openai', access: 'never-print-this', expires: Date.now() + 3600000
       } } };
     }
     export function resolveAuthProfileOrder() { return ['openai:codex-auth:fixture']; }
     export function updateAuthProfileStoreWithLock() { throw new Error('write attempted'); }`
  )
  writeFileSync(
    join(dir, "openclaw.json"),
    JSON.stringify({ agents: { entries: { coder: { model: "openai/example" } } } })
  )
  const output = execFileSync(
    process.execPath,
    [fileURLToPath(new URL("./native-codex-accounts.mjs", import.meta.url)), "--apply", "--reload"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: dir,
        OPENCLAW_CONFIG_PATH: join(dir, "openclaw.json"),
        OPENCLAW_CODEX_ACCOUNTS_DIR: dir,
        OPENCLAW_PACKAGE_ROOT: dir,
        OPENCLAW_COMMAND: "/not-invoked"
      }
    }
  )
  assert.deepEqual(JSON.parse(output), {
    applied: false,
    reloaded: false,
    skipped: "native-pool-current-cli-expired",
    nativePool: { agents: 1, profiles: 1 }
  })
  assert.doesNotMatch(output, /never-print-this|fixture-refresh/)
})

test("deprioritizes exhausted short OR weekly windows, recovers after reset, ignores stale usage", (t) => {
  const f = fixture(t)
  f.accounts[0].last_usage.primary.used_percent = 100
  f.accounts[1].last_usage.secondary.used_percent = 100
  f.save()
  let accounts = readAccounts(f.dir, now)
  assert.deepEqual(
    accounts.map((a) => a.remaining),
    [0, 0, 100]
  )
  assert.ok(planOrders(accounts, ["a", "b", "c"]).every((o) => o.order[0] === accounts[2].profileId))
  assert.ok(planOrders(accounts, ["a"])[0].order.length === 3)
  f.accounts[0].last_usage.primary.resets_at = now / 1000 - 1
  f.accounts[1].last_usage_at = now / 1000 - 3600
  f.save()
  accounts = readAccounts(f.dir, now)
  assert.deepEqual(
    accounts.map((a) => a.remaining),
    [100, 100, 100]
  )
})

test("omits expired and near-expiry credentials from native worker orders", (t) => {
  const f = fixture(t)
  for (const [index, expiry] of [
    [0, now / 1000 - 1],
    [1, now / 1000 + 240]
  ]) {
    const key = f.accounts[index].account_key
    const path = join(f.dir, `${Buffer.from(key).toString("base64url")}.auth.json`)
    const auth = JSON.parse(readFileSync(path, "utf8"))
    auth.tokens.access_token = token({
      exp: expiry,
      "https://api.openai.com/auth": {
        chatgpt_user_id: f.accounts[index].chatgpt_user_id,
        chatgpt_account_id: f.accounts[index].chatgpt_account_id
      }
    })
    writeFileSync(path, JSON.stringify(auth))
  }
  const accounts = readAccounts(f.dir, now)
  assert.equal(accounts.length, 1)
  assert.equal(accounts[0].credential.accountId, "personal")
  assert.ok(planOrders(accounts, ["coder", "reviewer"]).every((entry) => entry.order.length === 1))
})

test("allocation is deterministic and weighted by remaining quota", () => {
  const accounts = [
    { profileId: "a", remaining: 100 },
    { profileId: "b", remaining: 25 }
  ]
  const agents = Array.from({ length: 10 }, (_, i) => `worker-${i}`)
  const orders = planOrders(accounts, agents)
  assert.equal(orders.filter((o) => o.order[0] === "a").length, 8)
  assert.deepEqual(planOrders(accounts, agents.reverse()), orders)
  assert.equal(
    planOrders(
      accounts.map((a) => ({ ...a, remaining: 0 })),
      agents
    ).length,
    10
  )
})

test("rejects mismatched token identity and malformed registry", (t) => {
  const f = fixture(t)
  f.accounts[0].chatgpt_user_id = "someone-else"
  f.save()
  assert.throws(() => readAccounts(f.dir, now), /credential/)
  writeFileSync(join(f.dir, "registry.json"), "{}")
  assert.throws(() => readAccounts(f.dir, now), /registry/)
})

test("sync preserves newer refreshes, cooldowns, and other providers and is idempotent", (t) => {
  const accounts = readAccounts(fixture(t).dir, now)
  const id = accounts[0].profileId
  const newer = { ...accounts[0].credential, access: token({ iat: now / 1000 }), refresh: "newer-refresh" }
  const store = {
    profiles: { [id]: newer, other: { provider: "other" } },
    order: { other: ["other"] },
    usageStats: { [id]: { cooldownUntil: now + 1000, errorCount: 2 } }
  }
  const stats = structuredClone(store.usageStats)
  const order = accounts.map((a) => a.profileId)
  assert.equal(mergeAccounts(store, accounts, order), true)
  assert.deepEqual(store.profiles[id], newer)
  assert.deepEqual(store.usageStats, stats)
  assert.deepEqual(store.order.other, ["other"])
  assert.equal(mergeAccounts(store, accounts, order), false)
  // SQLite decoding returns equivalent credentials with a different key order.
  for (const [profileId, credential] of Object.entries(store.profiles))
    store.profiles[profileId] = Object.fromEntries(Object.entries(credential).reverse())
  assert.equal(mergeAccounts(store, accounts, order), false)
})

test("writes credentials through shared SDK transaction and per-agent order without copying secrets", async (t) => {
  const accounts = readAccounts(fixture(t).dir, now)
  const orders = planOrders(accounts, ["coder", "coder-2", "coder-3"])
  const stores = new Map()
  const sdk = {
    async updateAuthProfileStoreWithLock(p) {
      const key = p.agentDir ?? "shared"
      const s = stores.get(key) ?? { profiles: {} }
      p.updater(s)
      if (p.agentDir) assert.deepEqual(p.saveOptions.preserveOrderProfileIds, s.order.openai)
      stores.set(key, s)
      return s
    }
  }
  let changes = 0
  const params = { accounts, orders, stateDir: "/fixture", entries: {}, sdk, onChange: () => changes++ }
  assert.deepEqual(await synchronize(params), { changed: true })
  assert.equal(changes, 4)
  assert.deepEqual(await synchronize(params), { changed: false })
  assert.equal(changes, 4)
  assert.equal(Object.keys(stores.get("shared").profiles).length, 3)
  for (const { agentId, order } of orders) {
    const s = stores.get(`/fixture/agents/${agentId}/agent`)
    assert.deepEqual(s.profiles, {})
    assert.deepEqual(s.order.openai, order)
  }
  await assert.rejects(
    synchronize({
      accounts,
      orders,
      stateDir: "/fixture",
      entries: {},
      retryDelay: async () => {},
      sdk: {
        async updateAuthProfileStoreWithLock() {
          return null
        }
      }
    }),
    /shared/
  )
})

test("retries transient shared and agent store contention without losing a committed write", async (t) => {
  const accounts = readAccounts(fixture(t).dir, now)
  const orders = planOrders(accounts, ["coder"])
  const stores = new Map()
  const attempts = new Map()
  let delays = 0
  const sdk = {
    async updateAuthProfileStoreWithLock(params) {
      const key = params.agentDir ?? "shared"
      const count = (attempts.get(key) ?? 0) + 1
      attempts.set(key, count)
      // Shared data was committed before the compatibility SDK lost its reply.
      // The agent store was never written on its first attempt.
      if (key !== "shared" && count === 1) return null
      const store = stores.get(key) ?? { profiles: {} }
      params.updater(store)
      stores.set(key, store)
      return count === 1 ? null : store
    }
  }
  const result = await synchronize({
    accounts,
    orders,
    stateDir: "/fixture",
    entries: {},
    sdk,
    retryDelay: async () => {
      delays++
    }
  })
  assert.deepEqual(result, { changed: true })
  assert.equal(delays, 2)
  assert.equal(attempts.get("shared"), 2)
  assert.equal(attempts.get("/fixture/agents/coder/agent"), 2)
  assert.equal(Object.keys(stores.get("shared").profiles).length, 3)
  assert.deepEqual(stores.get("/fixture/agents/coder/agent").order.openai, orders[0].order)
})

test("CLI reloads the gateway after apply and never prints credentials", (t) => {
  const { dir } = fixture(t)
  const sdkDir = join(dir, "dist", "plugin-sdk")
  mkdirSync(sdkDir, { recursive: true })
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }))
  writeFileSync(
    join(sdkDir, "provider-auth.js"),
    `import {existsSync, readFileSync, writeFileSync} from 'node:fs';
     export async function updateAuthProfileStoreWithLock(p) {
       const path = p.stateDir + '/fixture-stores.json';
       const stores = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
       const key = p.agentDir ?? 'shared'; const s = stores[key] ?? {profiles:{}};
       if (p.updater(s)) { stores[key] = s; writeFileSync(path, JSON.stringify(stores)); }
       return s;
     }`
  )
  writeFileSync(
    join(dir, "openclaw.json"),
    JSON.stringify({
      agents: {
        entries: {
          coder: { model: "openai/example" },
          "coder-2": { model: "openai/example" },
          "coder-3": { model: "openai/example" }
        }
      }
    })
  )
  const command = join(dir, "openclaw.cjs")
  const log = join(dir, "reload.json")
  writeFileSync(
    command,
    '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.POOL_RELOAD_LOG, JSON.stringify(process.argv.slice(2)))\n',
    { mode: 0o700 }
  )
  const invoke = () =>
    execFileSync(
      process.execPath,
      [fileURLToPath(new URL("./native-codex-accounts.mjs", import.meta.url)), "--apply", "--reload"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_STATE_DIR: dir,
          OPENCLAW_CONFIG_PATH: join(dir, "openclaw.json"),
          OPENCLAW_CODEX_ACCOUNTS_DIR: dir,
          OPENCLAW_PACKAGE_ROOT: dir,
          OPENCLAW_COMMAND: command,
          POOL_RELOAD_LOG: log
        }
      }
    )
  const output = invoke()
  assert.deepEqual(JSON.parse(readFileSync(log, "utf8")), ["secrets", "reload", "--timeout", "120000"])
  assert.equal(JSON.parse(output).reloaded, true)
  assert.equal(JSON.parse(output).accounts.length, 3)
  assert.doesNotMatch(output, /fixture-refresh|access_token|refresh_token/)
  rmSync(log)
  assert.equal(JSON.parse(invoke()).reloaded, false)
  assert.equal(existsSync(log), false)
  // A failed reload leaves durable debt, even if the next sync changes nothing.
  const pending = join(dir, "codex-account-pool.reload-pending")
  writeFileSync(pending, "pending\n")
  writeFileSync(command, "#!/usr/bin/env node\nprocess.exit(1)\n")
  assert.throws(invoke)
  assert.equal(existsSync(pending), true)
  writeFileSync(
    command,
    '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.POOL_RELOAD_LOG, JSON.stringify(process.argv.slice(2)))\n'
  )
  assert.equal(JSON.parse(invoke()).reloaded, true)
  assert.equal(existsSync(pending), false)
})
