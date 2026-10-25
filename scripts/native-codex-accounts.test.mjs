import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import {
  mergeAccounts,
  planOrders,
  readAccounts,
  reloadPendingAccounts,
  synchronize
} from "./native-codex-accounts.mjs"

const now = 1_800_000_000_000
const token = (claims) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.x`
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
      sdk: {
        async updateAuthProfileStoreWithLock() {
          return null
        }
      }
    }),
    /shared/
  )
})

test("CLI uses the selected Gateway SDK after apply and never prints credentials", (t) => {
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
  writeFileSync(command, "#!/usr/bin/env node\nthrow Error('CLI reload must not execute')\n", { mode: 0o700 })
  writeFileSync(
    join(sdkDir, "gateway-runtime.js"),
    `
    import {writeFileSync} from 'node:fs';
    export async function callGatewayFromCli(...args) {
      writeFileSync(process.env.POOL_RELOAD_LOG, JSON.stringify(args));
      if (process.env.POOL_RELOAD_FAILURE) throw Error('fixture-refresh secret failure');
      return {ok:true,warningCount:0};
    }
  `
  )
  const invoke = (failure = false) =>
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
          POOL_RELOAD_LOG: log,
          POOL_RELOAD_FAILURE: failure ? "yes" : ""
        }
      }
    )
  const output = invoke()
  assert.deepEqual(JSON.parse(readFileSync(log, "utf8")), [
    "secrets.reload",
    { timeout: "120000" },
    {},
    { progress: false, scopes: ["operator.admin"] }
  ])
  assert.equal(JSON.parse(output).reloaded, true)
  assert.equal(JSON.parse(output).accounts.length, 3)
  assert.doesNotMatch(output, /fixture-refresh|access_token|refresh_token/)
  rmSync(log)
  assert.equal(JSON.parse(invoke()).reloaded, false)
  assert.equal(existsSync(log), false)
  // A failed reload leaves durable debt, even if the next sync changes nothing.
  const pending = join(dir, "codex-account-pool.reload-pending")
  writeFileSync(pending, "pending\n")
  assert.throws(
    () => invoke(true),
    (error) => {
      assert.match(error.stderr.toString(), /Codex account synchronization failed/)
      assert.doesNotMatch(error.stderr.toString(), /fixture-refresh|secret failure/)
      return true
    }
  )
  assert.equal(existsSync(pending), true)
  assert.equal(JSON.parse(invoke()).reloaded, true)
  assert.equal(existsSync(pending), false)
})

test("reload debt remains until deferred SDK success acknowledges it", async (t) => {
  const { dir } = fixture(t)
  const pending = join(dir, "codex-account-pool.reload-pending")
  writeFileSync(pending, "pending\n")
  let resolveReload
  const response = new Promise((resolve) => {
    resolveReload = resolve
  })
  let calls = 0
  const reload = reloadPendingAccounts({
    stateDir: dir,
    sdk: {
      callGatewayFromCli(...args) {
        calls++
        assert.deepEqual(args, [
          "secrets.reload",
          { timeout: "120000" },
          {},
          { progress: false, scopes: ["operator.admin"] }
        ])
        return response
      }
    }
  })
  assert.equal(existsSync(pending), true)
  await Promise.resolve()
  assert.equal(existsSync(pending), true)
  resolveReload({ ok: true, warningCount: 2 })
  assert.equal(await reload, true)
  assert.equal(existsSync(pending), false)
  assert.equal(
    await reloadPendingAccounts({
      stateDir: dir,
      sdk: {
        callGatewayFromCli() {
          calls++
          throw Error("unexpected")
        }
      }
    }),
    false
  )
  assert.equal(calls, 1)
})

for (const [name, response] of [
  ["rejection", new Error("fixture failure")],
  ["RPC timeout", new Error("Gateway call timed out")],
  ["absent ack", undefined],
  ["negative ack", { ok: false, warningCount: 0 }],
  ["missing warnings", { ok: true }],
  ["negative warnings", { ok: true, warningCount: -1 }],
  ["fractional warnings", { ok: true, warningCount: 0.5 }],
  ["unsafe warnings", { ok: true, warningCount: Number.MAX_SAFE_INTEGER + 1 }]
])
  test(`retains reload debt after ${name} and permits an unchanged retry`, async (t) => {
    const { dir } = fixture(t)
    const pending = join(dir, "codex-account-pool.reload-pending")
    writeFileSync(pending, "pending\n")
    const sdk = {
      async callGatewayFromCli() {
        if (response instanceof Error) throw response
        return response
      }
    }
    await assert.rejects(reloadPendingAccounts({ stateDir: dir, sdk }))
    assert.equal(readFileSync(pending, "utf8"), "pending\n")
    assert.equal(
      await reloadPendingAccounts({
        stateDir: dir,
        sdk: {
          async callGatewayFromCli() {
            return { ok: true, warningCount: 0 }
          }
        }
      }),
      true
    )
    assert.equal(existsSync(pending), false)
  })
