import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { readCodexQuotaOverview } from "@openclaw/domain"
import { afterEach, describe, expect, it } from "vitest"

import { createTempWorkspace } from "./helpers.js"

describe("Codex quota overview", () => {
  const cleanups: Array<() => void> = []
  const originalAccountsDir = process.env.OPENCLAW_CODEX_ACCOUNTS_DIR
  const originalAuthFile = process.env.OPENCLAW_CODEX_AUTH_FILE

  afterEach(() => {
    if (originalAccountsDir === undefined) delete process.env.OPENCLAW_CODEX_ACCOUNTS_DIR
    else process.env.OPENCLAW_CODEX_ACCOUNTS_DIR = originalAccountsDir

    if (originalAuthFile === undefined) delete process.env.OPENCLAW_CODEX_AUTH_FILE
    else process.env.OPENCLAW_CODEX_AUTH_FILE = originalAuthFile

    while (cleanups.length > 0) cleanups.pop()?.()
  })

  it("scores cached accounts and recommends leaving one account in reserve", () => {
    const workspace = createTempWorkspace("codex-quota-domain")
    cleanups.push(workspace.cleanup)

    const accountsDir = join(workspace.root, "codex", "accounts")
    const authFile = join(workspace.root, "codex", "auth.json")
    mkdirSync(accountsDir, { recursive: true })

    const nowSeconds = Math.floor(Date.now() / 1000)
    const activeSnapshot = JSON.stringify({ account: "alpha" }, null, 2)
    writeFileSync(
      join(accountsDir, "alpha.json"),
      JSON.stringify({ account: "alpha", decoded_tokens: { access_token: { header: {}, payload: {} } } }, null, 2),
      "utf8"
    )
    writeFileSync(join(accountsDir, "beta.json"), JSON.stringify({ account: "beta" }, null, 2), "utf8")
    writeFileSync(join(accountsDir, "gamma.json"), JSON.stringify({ account: "gamma" }, null, 2), "utf8")
    writeFileSync(authFile, activeSnapshot, "utf8")

    writeFileSync(
      join(accountsDir, ".alpha.quota.json"),
      JSON.stringify({
        cached_at: nowSeconds,
        rate_limits: {
          primary: { used_percent: 12, resets_at: nowSeconds + 2 * 3600 },
          secondary: { used_percent: 28, resets_at: nowSeconds + 3 * 24 * 3600 }
        }
      }),
      "utf8"
    )
    writeFileSync(
      join(accountsDir, ".beta.quota.json"),
      JSON.stringify({
        cached_at: nowSeconds,
        rate_limits: {
          primary: { used_percent: 82, resets_at: nowSeconds + 90 * 60 },
          secondary: { used_percent: 61, resets_at: nowSeconds + 2 * 24 * 3600 }
        }
      }),
      "utf8"
    )
    writeFileSync(
      join(accountsDir, ".gamma.quota.json"),
      JSON.stringify({
        cached_at: nowSeconds,
        rate_limits: {
          primary: { used_percent: 100, resets_at: nowSeconds + 4 * 3600 },
          secondary: { used_percent: 100, resets_at: nowSeconds + 5 * 24 * 3600 }
        }
      }),
      "utf8"
    )

    process.env.OPENCLAW_CODEX_ACCOUNTS_DIR = accountsDir
    process.env.OPENCLAW_CODEX_AUTH_FILE = authFile

    const overview = readCodexQuotaOverview()
    expect(overview.activeAccount).toBe("alpha")
    expect(overview.bestAccount).toBe("alpha")
    expect(overview.assessment).toBe("ok")
    expect(overview.availableAccounts).toBe(2)
    expect(overview.healthyAccounts).toBe(1)
    expect(overview.warmAccounts).toBe(1)
    expect(overview.blockedAccounts).toBe(1)
    expect(overview.recommendedMaxConcurrentCodexRuns).toBe(2)
  })

  it("does not recommend a best account when every known account is blocked", () => {
    const workspace = createTempWorkspace("codex-quota-blocked-domain")
    cleanups.push(workspace.cleanup)

    const accountsDir = join(workspace.root, "codex", "accounts")
    const authFile = join(workspace.root, "codex", "auth.json")
    mkdirSync(accountsDir, { recursive: true })

    const nowSeconds = Math.floor(Date.now() / 1000)
    const activeSnapshot = JSON.stringify({ account: "alpha" }, null, 2)
    writeFileSync(join(accountsDir, "alpha.json"), activeSnapshot, "utf8")
    writeFileSync(authFile, activeSnapshot, "utf8")
    writeFileSync(
      join(accountsDir, ".alpha.quota.json"),
      JSON.stringify({
        cached_at: nowSeconds,
        rate_limits: {
          primary: { used_percent: 100, resets_at: nowSeconds + 3600 },
          secondary: { used_percent: 100, resets_at: nowSeconds + 24 * 3600 }
        }
      }),
      "utf8"
    )

    process.env.OPENCLAW_CODEX_ACCOUNTS_DIR = accountsDir
    process.env.OPENCLAW_CODEX_AUTH_FILE = authFile

    const overview = readCodexQuotaOverview()
    expect(overview.assessment).toBe("blocked")
    expect(overview.bestAccount).toBeNull()
    expect(overview.availableAccounts).toBe(0)
    expect(overview.recommendedMaxConcurrentCodexRuns).toBe(0)
  })

  it("keeps every unknown but configured account dispatchable", () => {
    const workspace = createTempWorkspace("codex-quota-unknown-domain")
    cleanups.push(workspace.cleanup)

    const accountsDir = join(workspace.root, "codex", "accounts")
    const authFile = join(workspace.root, "codex", "auth.json")
    mkdirSync(accountsDir, { recursive: true })

    writeFileSync(join(accountsDir, "alpha.json"), JSON.stringify({ account: "alpha" }, null, 2), "utf8")
    writeFileSync(join(accountsDir, "beta.json"), JSON.stringify({ account: "beta" }, null, 2), "utf8")
    writeFileSync(authFile, JSON.stringify({ account: "alpha" }, null, 2), "utf8")

    process.env.OPENCLAW_CODEX_ACCOUNTS_DIR = accountsDir
    process.env.OPENCLAW_CODEX_AUTH_FILE = authFile

    const overview = readCodexQuotaOverview()
    expect(overview.assessment).toBe("degraded")
    expect(overview.availableAccounts).toBe(2)
    expect(overview.unknownAccounts).toBe(2)
    expect(overview.recommendedMaxConcurrentCodexRuns).toBe(2)
  })

  it("reads codex-auth registry usage and active account", () => {
    const workspace = createTempWorkspace("codex-auth-quota-domain")
    cleanups.push(workspace.cleanup)

    const accountsDir = join(workspace.root, "codex", "accounts")
    const authFile = join(workspace.root, "codex", "auth.json")
    mkdirSync(accountsDir, { recursive: true })

    const nowSeconds = Math.floor(Date.now() / 1000)
    writeFileSync(authFile, JSON.stringify({ account: "unused" }), "utf8")
    writeFileSync(
      join(accountsDir, "registry.json"),
      JSON.stringify(
        {
          active_account_key: "backup-key",
          accounts: [
            {
              account_key: "primary-key",
              email: "primary@example.test",
              last_usage: {
                primary: { used_percent: 100, resets_at: nowSeconds + 3600 },
                secondary: { used_percent: 100, resets_at: nowSeconds + 24 * 3600 }
              },
              last_usage_at: nowSeconds
            },
            {
              account_key: "backup-key",
              account_name: "backup",
              last_usage: {
                primary: { used_percent: 15, resets_at: nowSeconds + 3600 },
                secondary: { used_percent: 25, resets_at: nowSeconds + 24 * 3600 }
              },
              last_usage_at: nowSeconds
            }
          ]
        },
        null,
        2
      ),
      "utf8"
    )

    process.env.OPENCLAW_CODEX_ACCOUNTS_DIR = accountsDir
    process.env.OPENCLAW_CODEX_AUTH_FILE = authFile

    const overview = readCodexQuotaOverview()
    expect(overview.activeAccount).toBe("backup")
    expect(overview.bestAccount).toBe("backup")
    expect(overview.assessment).toBe("ok")
    expect(overview.availableAccounts).toBe(1)
    expect(overview.blockedAccounts).toBe(1)
  })
})
