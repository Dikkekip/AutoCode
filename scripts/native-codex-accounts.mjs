#!/usr/bin/env node
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { isDeepStrictEqual } from "node:util"

const prefix = "openai:codex-auth:"
const claimsKey = "https://api.openai.com/auth"

function payload(token) {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString())
  } catch {
    return {}
  }
}

// Keep distinct users in the same Business workspace as distinct quota accounts.
export function readAccounts(accountsDir, now = Date.now()) {
  const registry = JSON.parse(readFileSync(join(accountsDir, "registry.json"), "utf8"))
  if (registry.schema_version !== 4 || !Array.isArray(registry.accounts))
    throw new Error("Unsupported codex-auth registry")
  const seen = new Set()
  return registry.accounts
    .filter((account) => account.auth_mode === "chatgpt")
    .map((account) => {
      const key = account.account_key
      if (typeof key !== "string" || seen.has(key)) throw new Error("Invalid or duplicate codex-auth identity")
      seen.add(key)
      const encoded = Buffer.from(key).toString("base64url")
      const auth = JSON.parse(readFileSync(join(accountsDir, `${encoded}.auth.json`), "utf8"))
      const tokens = auth.tokens ?? {}
      const jwt = payload(tokens.access_token)
      const identity = jwt[claimsKey] ?? {}
      if (
        !account.chatgpt_user_id ||
        !account.chatgpt_account_id ||
        key !== `${account.chatgpt_user_id}::${account.chatgpt_account_id}` ||
        identity.chatgpt_user_id !== account.chatgpt_user_id ||
        identity.chatgpt_account_id !== account.chatgpt_account_id ||
        tokens.account_id !== account.chatgpt_account_id ||
        typeof tokens.refresh_token !== "string" ||
        !tokens.refresh_token ||
        !Number.isFinite(jwt.exp)
      )
        throw new Error(`Invalid codex-auth credential for ${encoded}; refresh login with codex-auth`)
      const fresh =
        Number.isFinite(account.last_usage_at) &&
        now - account.last_usage_at * 1000 >= 0 &&
        now - account.last_usage_at * 1000 < 10 * 60_000
      const windows = [account.last_usage?.primary, account.last_usage?.secondary].filter(Boolean)
      const remaining =
        fresh && windows.length > 0
          ? Math.min(
              ...windows.map((window) => {
                if (!Number.isFinite(window.used_percent)) return 100
                if (Number.isFinite(window.resets_at) && window.resets_at * 1000 <= now) return 100
                return Math.max(0, Math.min(100, 100 - window.used_percent))
              })
            )
          : 100
      // An expired CLI credential cannot be a native fallback until codex-auth
      // refreshes it. Keep it out of every worker order, including the tail.
      if (jwt.exp * 1000 <= now + 5 * 60_000) return null
      return {
        profileId: `${prefix}${encoded}`,
        remaining,
        usageFresh: fresh,
        credential: {
          type: "oauth",
          provider: "openai",
          access: tokens.access_token,
          refresh: tokens.refresh_token,
          expires: jwt.exp * 1000,
          accountId: account.chatgpt_account_id,
          chatgptPlanType: identity.chatgpt_plan_type ?? account.plan,
          email: account.email,
          ...(tokens.id_token ? { idToken: tokens.id_token } : {})
        }
      }
    })
    .filter(Boolean)
}

// Weighted allocation is stable between probes; native cooldown handling still
// decides eligibility and retries. Never treat stale observations as exhaustion.
export function planOrders(accounts, agentIds) {
  if (!accounts.length) throw new Error("No Codex accounts available")
  const ranked = [...accounts].sort((a, b) => b.remaining - a.remaining || a.profileId.localeCompare(b.profileId))
  const available = ranked.filter((a) => a.remaining > 0)
  const pool = available.length ? available : ranked
  const assigned = new Map(pool.map((a) => [a.profileId, 0]))
  return [...new Set(agentIds)].sort().map((agentId) => {
    const first = [...pool].sort(
      (a, b) =>
        assigned.get(a.profileId) / Math.max(1, a.remaining) - assigned.get(b.profileId) / Math.max(1, b.remaining) ||
        b.remaining - a.remaining ||
        a.profileId.localeCompare(b.profileId)
    )[0]
    assigned.set(first.profileId, assigned.get(first.profileId) + 1)
    return { agentId, order: [first.profileId, ...ranked.filter((a) => a !== first).map((a) => a.profileId)] }
  })
}

export function mergeAccounts(store, accounts, order) {
  let changed = false
  for (const account of accounts) {
    const current = store.profiles[account.profileId]
    // OpenClaw may already have refreshed this credential. Never roll it back.
    if (current && (payload(current.access).iat ?? 0) > (payload(account.credential.access).iat ?? 0)) continue
    if (
      !isDeepStrictEqual(JSON.parse(JSON.stringify(current ?? null)), JSON.parse(JSON.stringify(account.credential)))
    ) {
      store.profiles[account.profileId] = account.credential
      changed = true
    }
  }
  if (JSON.stringify(store.order?.openai) !== JSON.stringify(order)) {
    store.order = { ...store.order, openai: order }
    changed = true
  }
  // Preserve usageStats, failures, cooldowns, other providers, and session pins.
  return changed
}

// OpenClaw owns OAuth refresh. Expired CLI copies must not displace newer
// native credentials or make a healthy native pool look unavailable.
export function inspectNativePool({ agentIds, entries, stateDir, config, sdk, now = Date.now() }) {
  const profiles = new Set()
  for (const agentId of agentIds) {
    const agentDir = entries[agentId]?.agentDir ?? join(stateDir, "agents", agentId, "agent")
    const store = sdk.ensureAuthProfileStore(agentDir, {
      readOnly: true,
      syncExternalCli: false,
      externalCli: { mode: "none" },
      config
    })
    const order = sdk.resolveAuthProfileOrder({ cfg: config, store, provider: "openai" })
    const usable = order.filter((id) => {
      const credential = store.profiles[id]
      return (
        id.startsWith(prefix) &&
        credential?.provider === "openai" &&
        credential.type === "oauth" &&
        typeof credential.access === "string" &&
        credential.access.length > 0 &&
        credential.expires > now + 5 * 60_000
      )
    })
    if (!usable.length) throw new Error("No usable native Codex account for a configured agent")
    for (const id of usable) profiles.add(id)
  }
  if (!agentIds.length) throw new Error("No configured OpenAI agents")
  return { agents: agentIds.length, profiles: profiles.size }
}

export async function synchronize({
  accounts,
  orders,
  stateDir,
  entries,
  sdk,
  onChange = () => {},
  retryDelay = () => new Promise((resolve) => setTimeout(resolve, 2000))
}) {
  let changed = false
  const update = (store, credentials, order) => {
    const updated = mergeAccounts(store, credentials, order)
    if (updated) {
      // Record reload debt before the SDK commits, including partial failures.
      onChange()
      changed = true
    }
    return updated
  }
  // Credentials live in the shared store; per-agent stores carry order only.
  // The public compatibility SDK returns null when another OpenClaw process
  // temporarily owns state-lifecycle. A retry is safe: every updater is
  // idempotent and any committed write is read again on the second attempt.
  const updateWithRetry = async (params) => {
    let result = await sdk.updateAuthProfileStoreWithLock(params)
    if (result) return result
    await retryDelay()
    result = await sdk.updateAuthProfileStoreWithLock(params)
    return result
  }
  const shared = await updateWithRetry({
    sharedStoreWrite: true,
    stateDir,
    saveOptions: { filterExternalAuthProfiles: false, syncExternalCli: false },
    updater: (store) => update(store, accounts, orders.find((o) => o.agentId === "main")?.order ?? orders[0].order)
  })
  if (!shared) throw new Error("Unable to update shared Codex account pool")
  for (const { agentId, order } of orders) {
    const agentDir = entries[agentId]?.agentDir ?? join(stateDir, "agents", agentId, "agent")
    const updated = await updateWithRetry({
      agentDir,
      stateDir,
      saveOptions: { filterExternalAuthProfiles: false, syncExternalCli: false, preserveOrderProfileIds: order },
      updater: (store) => update(store, [], order)
    })
    if (!updated) throw new Error(`Unable to update Codex account order for ${agentId}`)
  }
  return { changed }
}

async function main() {
  const args = process.argv.slice(2)
  if (
    args.some((a) => !["--apply", "--refresh", "--reload"].includes(a)) ||
    (args.includes("--reload") && !args.includes("--apply"))
  )
    throw new Error("Usage: native-codex-accounts.mjs [--refresh] [--apply [--reload]]")
  const stateDir = resolve(process.env.OPENCLAW_STATE_DIR ?? join(homedir(), ".openclaw"))
  const accountsDir =
    process.env.OPENCLAW_CODEX_ACCOUNTS_DIR ?? join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "accounts")
  if (args.includes("--refresh")) {
    execFileSync(process.env.CODEX_AUTH_COMMAND ?? "codex-auth", ["list", "--api"], {
      timeout: 60_000,
      stdio: ["ignore", "ignore", "pipe"],
      maxBuffer: 1024 * 1024
    })
  }
  const accounts = readAccounts(accountsDir)
  const config = JSON.parse(readFileSync(process.env.OPENCLAW_CONFIG_PATH ?? join(stateDir, "openclaw.json"), "utf8"))
  const entries = config.agents?.entries ?? Object.fromEntries((config.agents?.list ?? []).map((a) => [a.id, a]))
  const agentIds = Object.keys(entries).filter((id) => {
    const model = entries[id].model ?? config.agents?.defaults?.model
    return (typeof model === "string" ? model : model?.primary)?.startsWith("openai/")
  })
  if (!agentIds.length) throw new Error("No configured OpenAI agents")
  if (!accounts.length) {
    const binary = process.env.OPENCLAW_COMMAND ?? execFileSync("which", ["openclaw"], { encoding: "utf8" }).trim()
    const root = process.env.OPENCLAW_PACKAGE_ROOT ?? dirname(realpathSync(binary))
    const sdk = await import(pathToFileURL(join(root, "dist/plugin-sdk/provider-auth.js")).href)
    const nativePool = inspectNativePool({ agentIds, entries, stateDir, config, sdk })
    if (existsSync(join(stateDir, "codex-account-pool.reload-pending")))
      throw new Error("Native account reload is still pending")
    console.log(
      JSON.stringify({ applied: false, reloaded: false, skipped: "native-pool-current-cli-expired", nativePool })
    )
    return
  }
  const orders = planOrders(accounts, agentIds)
  let reloaded = false
  if (args.includes("--apply")) {
    const binary = process.env.OPENCLAW_COMMAND ?? execFileSync("which", ["openclaw"], { encoding: "utf8" }).trim()
    const root = process.env.OPENCLAW_PACKAGE_ROOT ?? dirname(realpathSync(binary))
    const sdk = await import(pathToFileURL(join(root, "dist/plugin-sdk/provider-auth.js")).href)
    const pendingReload = join(stateDir, "codex-account-pool.reload-pending")
    await synchronize({
      accounts,
      orders,
      stateDir,
      entries,
      sdk,
      onChange: () => writeFileSync(pendingReload, "pending\n", { mode: 0o600 })
    })
    if (args.includes("--reload") && existsSync(pendingReload)) {
      // Disk writes alone leave the gateway using its previous auth snapshot.
      execFileSync(binary, ["secrets", "reload", "--timeout", "120000"], {
        timeout: 150_000,
        stdio: ["ignore", "ignore", "pipe"],
        maxBuffer: 1024 * 1024
      })
      rmSync(pendingReload)
      reloaded = true
    }
  }
  console.log(
    JSON.stringify(
      {
        applied: args.includes("--apply"),
        reloaded,
        accounts: accounts.map(({ profileId, remaining, usageFresh }) => ({ profileId, remaining, usageFresh })),
        orders
      },
      null,
      2
    )
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    // Provider failures can contain credentials; never echo arbitrary SDK errors.
    console.error(
      "Codex account synchronization failed; check registry credentials, paths, and auth-store availability."
    )
    process.exitCode = 1
  })
}
