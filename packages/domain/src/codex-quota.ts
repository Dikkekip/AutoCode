import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export interface CodexQuotaAccountStatus {
  name: string
  active: boolean
  cachePath: string
  cacheAgeSeconds: number | null
  cacheStale: boolean
  weeklyUsed: number | null
  effectiveWeeklyUsed: number | null
  weeklyResetsAt: number | null
  dailyUsed: number | null
  effectiveDailyUsed: number | null
  dailyResetsAt: number | null
  availableWeeklyPercent: number | null
  score: number | null
  quotaSource: "primary" | "secondary" | null
  status: "healthy" | "warm" | "blocked" | "unknown"
}

export interface CodexQuotaOverview {
  generatedAt: string
  activeAccount: string | null
  bestAccount: string | null
  assessment: "ok" | "degraded" | "blocked" | "unknown"
  switcherConfigured: boolean
  availableAccounts: number
  healthyAccounts: number
  warmAccounts: number
  blockedAccounts: number
  unknownAccounts: number
  recommendedMaxConcurrentCodexRuns: number | null
  accounts: CodexQuotaAccountStatus[]
}

type RateLimitBucket = {
  used_percent?: number
  resets_at?: number
}

type RateLimitPayload = {
  primary?: RateLimitBucket
  secondary?: RateLimitBucket
}

type CodexAuthIdentity = {
  normalizedMaterial: string | null
  accountId: string | null
  userId: string | null
  email: string | null
}

type CodexAuthRegistryAccount = {
  account_key?: unknown
  email?: unknown
  alias?: unknown
  account_name?: unknown
  plan?: unknown
  last_usage?: unknown
  last_usage_at?: unknown
}

type CodexAuthRegistry = {
  active_account_key?: unknown
  accounts?: unknown
}

function codexDir(): string {
  return process.env.OPENCLAW_CODEX_DIR ?? join(homedir(), ".codex")
}

function authFilePath(): string {
  return process.env.OPENCLAW_CODEX_AUTH_FILE ?? join(codexDir(), "auth.json")
}

function accountsDirPath(): string {
  return process.env.OPENCLAW_CODEX_ACCOUNTS_DIR ?? join(codexDir(), "accounts")
}

function registryPath(): string {
  return join(accountsDirPath(), "registry.json")
}

function commandExists(command: string): boolean {
  const path = process.env.PATH ?? ""
  for (const dir of path.split(":")) {
    if (!dir) continue
    try {
      accessSync(join(dir, command), constants.X_OK)
      return true
    } catch {
      // Keep searching.
    }
  }
  return false
}

function switcherScriptPaths(): string[] {
  const explicitPath = process.env.CODEX_ACCOUNT_SWITCHER_SCRIPT
  const frameworkDir = process.env.OPENCLAW_DISPATCHER_FRAMEWORK_DIR
  const openclawHome = process.env.OPENCLAW_HOME
  return [
    explicitPath,
    join(process.cwd(), "skills", "codex-account-switcher", "scripts", "codex-accounts.py"),
    frameworkDir ? join(frameworkDir, "skills", "codex-account-switcher", "scripts", "codex-accounts.py") : null,
    openclawHome
      ? join(openclawHome, "workspace", "skills", "codex-account-switcher", "scripts", "codex-accounts.py")
      : null,
    join(homedir(), ".openclaw", "workspace", "skills", "codex-account-switcher", "scripts", "codex-accounts.py"),
    join(homedir(), ".codex", "skills", "codex-account-switcher", "scripts", "codex-accounts.py"),
    commandExists("codex-auth") ? "codex-auth" : null
  ].filter((path): path is string => Boolean(path))
}

function switcherConfigured(): boolean {
  return switcherScriptPaths().some((path) => path === "codex-auth" || existsSync(path))
}

function quotaCacheMaxAgeHours(): number {
  const raw = process.env.OPENCLAW_CODEX_QUOTA_CACHE_MAX_AGE_HOURS
  const parsed = raw ? Number(raw) : 24
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 24
}

function quotaCachePathForAccount(name: string): string {
  return join(accountsDirPath(), `.${name}.quota.json`)
}

function normalizeBucket(bucket: unknown): RateLimitBucket | null {
  return bucket && typeof bucket === "object" ? (bucket as RateLimitBucket) : null
}

function quotaSummary(limits: unknown): {
  weeklyUsed: number
  dailyUsed: number | null
  weeklyResetsAt: number
  dailyResetsAt: number | null
  quotaSource: "primary" | "secondary"
} | null {
  if (!limits || typeof limits !== "object") return null
  const payload = limits as RateLimitPayload
  const primary = normalizeBucket(payload.primary)
  const secondary = normalizeBucket(payload.secondary)
  const weeklyBucket = secondary ?? primary
  if (!weeklyBucket || typeof weeklyBucket.used_percent !== "number") {
    return null
  }

  const dailyUsed = primary?.used_percent
  return {
    weeklyUsed: weeklyBucket.used_percent,
    dailyUsed: typeof dailyUsed === "number" ? dailyUsed : null,
    weeklyResetsAt: typeof weeklyBucket.resets_at === "number" ? weeklyBucket.resets_at : 0,
    dailyResetsAt: typeof primary?.resets_at === "number" ? primary.resets_at : null,
    quotaSource: secondary ? "secondary" : "primary"
  }
}

function scoreAccount(input: {
  effectiveWeeklyUsed: number
  effectiveDailyUsed: number
  weeklyResetsAt: number
  nowSeconds: number
}): number {
  const { effectiveWeeklyUsed, effectiveDailyUsed, weeklyResetsAt, nowSeconds } = input

  const weeklyPenalty = effectiveWeeklyUsed >= 100 ? 500 : 0
  const weeklyWindowSeconds = 168 * 3600
  const weeklyElapsed = weeklyWindowSeconds - Math.max(0, weeklyResetsAt - nowSeconds)
  const weeklyBudget = (weeklyElapsed / weeklyWindowSeconds) * 100
  const weeklyScore = effectiveWeeklyUsed - weeklyBudget

  const dailyPenalty =
    effectiveDailyUsed >= 100 ? 200 : effectiveDailyUsed >= 90 ? 50 : effectiveDailyUsed >= 75 ? 10 : 0

  return weeklyPenalty + weeklyScore + dailyPenalty
}

function accountStatusFromUsage(
  weeklyUsed: number | null,
  dailyUsed: number | null
): CodexQuotaAccountStatus["status"] {
  if (weeklyUsed === null) {
    return "unknown"
  }
  if (weeklyUsed >= 100 || (dailyUsed !== null && dailyUsed >= 100)) {
    return "blocked"
  }
  if (weeklyUsed >= 90 || (dailyUsed !== null && dailyUsed >= 75)) {
    return "warm"
  }
  return "healthy"
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T
  } catch {
    return null
  }
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function accountDisplayName(account: CodexAuthRegistryAccount): string | null {
  return (
    normalizeString(account.alias) ??
    normalizeString(account.account_name) ??
    normalizeString(account.email) ??
    normalizeString(account.account_key)
  )
}

function decodeJwtPayload(token: unknown): Record<string, unknown> | null {
  if (typeof token !== "string") return null
  const parts = token.split(".")
  if (parts.length !== 3 || !parts[1]) return null
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>
  } catch {
    return null
  }
}

function readCodexAuthIdentity(path: string): CodexAuthIdentity | null {
  const payload = readJson<Record<string, unknown>>(path)
  if (!payload) return null

  const material = { ...payload }
  delete material.decoded_tokens
  const tokens = payload.tokens && typeof payload.tokens === "object" ? (payload.tokens as Record<string, unknown>) : {}
  const accessPayload = decodeJwtPayload(tokens.access_token)
  const idPayload = decodeJwtPayload(tokens.id_token)
  const authClaims =
    accessPayload?.["https://api.openai.com/auth"] && typeof accessPayload["https://api.openai.com/auth"] === "object"
      ? (accessPayload["https://api.openai.com/auth"] as Record<string, unknown>)
      : {}
  const profileClaims =
    accessPayload?.["https://api.openai.com/profile"] &&
    typeof accessPayload["https://api.openai.com/profile"] === "object"
      ? (accessPayload["https://api.openai.com/profile"] as Record<string, unknown>)
      : {}

  return {
    normalizedMaterial: JSON.stringify(material),
    accountId: normalizeString(authClaims.chatgpt_account_id) ?? normalizeString(payload.account_id),
    userId:
      normalizeString(authClaims.user_id) ??
      normalizeString(authClaims.chatgpt_user_id) ??
      normalizeString(authClaims.chatgpt_account_user_id),
    email: normalizeString(idPayload?.email) ?? normalizeString(profileClaims.email)
  }
}

function sameCodexAuthIdentity(active: CodexAuthIdentity, snapshot: CodexAuthIdentity): boolean {
  if (active.userId && snapshot.userId) return active.userId === snapshot.userId
  if (active.email && snapshot.email) return active.email.toLowerCase() === snapshot.email.toLowerCase()
  if (active.accountId && snapshot.accountId) return active.accountId === snapshot.accountId
  return Boolean(active.normalizedMaterial && active.normalizedMaterial === snapshot.normalizedMaterial)
}

function listAccountNames(): string[] {
  const registry = readJson<CodexAuthRegistry>(registryPath())
  if (Array.isArray(registry?.accounts)) {
    return registry.accounts
      .flatMap((account) => {
        if (!account || typeof account !== "object") return []
        const name = accountDisplayName(account as CodexAuthRegistryAccount)
        return name ? [name] : []
      })
      .sort()
  }

  const dir = accountsDirPath()
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json") && !name.startsWith(".") && !name.endsWith(".debug.json"))
    .map((name) => name.slice(0, -".json".length))
    .sort()
}

function detectActiveAccount(accountNames: string[]): string | null {
  const registry = readJson<CodexAuthRegistry>(registryPath())
  if (Array.isArray(registry?.accounts)) {
    const activeKey = normalizeString(registry.active_account_key)
    if (!activeKey) return null
    const active = registry.accounts.find(
      (account) =>
        account &&
        typeof account === "object" &&
        normalizeString((account as CodexAuthRegistryAccount).account_key) === activeKey
    )
    return active && typeof active === "object" ? accountDisplayName(active as CodexAuthRegistryAccount) : null
  }

  const authPath = authFilePath()
  if (!existsSync(authPath)) return null

  const activeIdentity = readCodexAuthIdentity(authPath)
  if (!activeIdentity) return null

  for (const name of accountNames) {
    const snapshotPath = join(accountsDirPath(), `${name}.json`)
    const snapshotIdentity = readCodexAuthIdentity(snapshotPath)
    if (snapshotIdentity && sameCodexAuthIdentity(activeIdentity, snapshotIdentity)) return name
  }

  return null
}

function registryAccountByName(name: string): CodexAuthRegistryAccount | null {
  const registry = readJson<CodexAuthRegistry>(registryPath())
  if (!Array.isArray(registry?.accounts)) return null
  for (const account of registry.accounts) {
    if (!account || typeof account !== "object") continue
    const registryAccount = account as CodexAuthRegistryAccount
    if (accountDisplayName(registryAccount) === name) return registryAccount
  }
  return null
}

export function readCodexQuotaOverview(): CodexQuotaOverview {
  const nowSeconds = Math.floor(Date.now() / 1000)
  const maxAgeSeconds = quotaCacheMaxAgeHours() * 3600
  const accountNames = listAccountNames()
  const activeAccount = detectActiveAccount(accountNames)

  const accounts = accountNames.map((name): CodexQuotaAccountStatus => {
    const registryAccount = registryAccountByName(name)
    const cachePath = quotaCachePathForAccount(name)
    const cache = readJson<{ rate_limits?: unknown; cached_at?: number; collected_at?: number }>(cachePath)
    const registryUsageAt = typeof registryAccount?.last_usage_at === "number" ? registryAccount.last_usage_at : null
    const cacheTimestamp =
      registryUsageAt ??
      (typeof cache?.cached_at === "number"
        ? cache.cached_at
        : typeof cache?.collected_at === "number"
          ? cache.collected_at
          : existsSync(cachePath)
            ? statSync(cachePath).mtimeMs / 1000
            : null)
    const cacheAgeSeconds = cacheTimestamp === null ? null : Math.max(nowSeconds - Math.floor(cacheTimestamp), 0)
    const cacheStale = cacheAgeSeconds === null ? true : cacheAgeSeconds > maxAgeSeconds
    const summary = cacheStale ? null : quotaSummary(registryAccount?.last_usage ?? cache?.rate_limits)

    const weeklyResetsAt = summary?.weeklyResetsAt ?? null
    const dailyResetsAt = summary?.dailyResetsAt ?? null
    const effectiveWeeklyUsed =
      summary === null
        ? null
        : weeklyResetsAt !== null && weeklyResetsAt > 0 && nowSeconds >= weeklyResetsAt
          ? 0
          : summary.weeklyUsed
    const effectiveDailyUsed =
      summary === null
        ? null
        : dailyResetsAt !== null && dailyResetsAt > 0 && nowSeconds >= dailyResetsAt
          ? 0
          : (summary.dailyUsed ?? 0)
    const score =
      effectiveWeeklyUsed === null || effectiveDailyUsed === null || weeklyResetsAt === null
        ? null
        : scoreAccount({
            effectiveWeeklyUsed,
            effectiveDailyUsed,
            weeklyResetsAt,
            nowSeconds
          })

    return {
      name,
      active: activeAccount === name,
      cachePath,
      cacheAgeSeconds,
      cacheStale,
      weeklyUsed: summary?.weeklyUsed ?? null,
      effectiveWeeklyUsed,
      weeklyResetsAt,
      dailyUsed: summary?.dailyUsed ?? null,
      effectiveDailyUsed,
      dailyResetsAt,
      availableWeeklyPercent: effectiveWeeklyUsed === null ? null : Math.max(100 - effectiveWeeklyUsed, 0),
      score,
      quotaSource: summary?.quotaSource ?? null,
      status: accountStatusFromUsage(effectiveWeeklyUsed, effectiveDailyUsed)
    }
  })

  const knownAccounts = accounts.filter((account) => !account.cacheStale && account.score !== null)
  const unknownRunnableAccounts = accounts.filter((account) => account.status === "unknown")
  const availableAccounts =
    knownAccounts.length > 0 ? knownAccounts.filter((account) => account.status !== "blocked") : unknownRunnableAccounts
  const healthyAccounts = availableAccounts.filter((account) => account.status === "healthy")
  const warmAccounts = availableAccounts.filter((account) => account.status === "warm")
  const blockedAccounts = accounts.filter((account) => account.status === "blocked")
  const unknownAccounts = accounts.filter((account) => account.status === "unknown")
  const bestAccount =
    availableAccounts.sort((left, right) => (left.score ?? 9999) - (right.score ?? 9999))[0]?.name ?? null

  const assessment =
    knownAccounts.length === 0
      ? availableAccounts.length > 0
        ? "degraded"
        : "unknown"
      : availableAccounts.length === 0
        ? "blocked"
        : healthyAccounts.length === 0
          ? "degraded"
          : "ok"

  const recommendedMaxConcurrentCodexRuns =
    availableAccounts.length === 0 ? (knownAccounts.length === 0 ? null : 0) : availableAccounts.length

  return {
    generatedAt: new Date().toISOString(),
    activeAccount,
    bestAccount,
    assessment,
    switcherConfigured: switcherConfigured(),
    availableAccounts: availableAccounts.length,
    healthyAccounts: healthyAccounts.length,
    warmAccounts: warmAccounts.length,
    blockedAccounts: blockedAccounts.length,
    unknownAccounts: unknownAccounts.length,
    recommendedMaxConcurrentCodexRuns,
    accounts
  }
}
