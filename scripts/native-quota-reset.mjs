#!/usr/bin/env node
// Operator-only guard. No account switching, purchases, or native control mutations.
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { chmod, mkdir, open, readFile, rename } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"

export async function atomicState(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`
  const file = await open(temporary, "wx", 0o600)
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`)
    await file.sync()
  } finally {
    await file.close()
  }
  await rename(temporary, path)
  const directory = await open(dirname(path), "r")
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

export function validateConfig(config) {
  for (const key of ["email", "accountId", "creditId", "statePath", "codexPath"]) {
    if (typeof config[key] !== "string" || !config[key].trim()) throw new Error(`Missing ${key}`)
  }
  if (!config.statePath.startsWith("/") || !config.codexPath.startsWith("/")) throw new Error("Paths must be absolute")
  if (typeof config.allowReset !== "boolean") throw new Error("allowReset must be explicit")
}

export async function guard(config, rpc, storage, now = () => Date.now()) {
  validateConfig(config)
  const binding = { email: config.email, accountId: config.accountId, creditId: config.creditId }
  let state = await storage.read()
  if (state && (state.version !== 1 || JSON.stringify(state.binding) !== JSON.stringify(binding))) {
    throw new Error("State account or credit binding mismatch")
  }
  if (state?.attempt && (!state.attempt.idempotencyKey || !["pending", "complete"].includes(state.attempt.status))) {
    throw new Error("Invalid persisted reset attempt")
  }
  const account = await rpc("account/read", { refreshToken: false })
  if (account.account?.type !== "chatgpt" || account.account.email !== config.email)
    throw new Error("Active account mismatch")
  const readUsage = async () => {
    const usage = await rpc("account/rateLimits/read", { excludeResetCreditDetails: false })
    if (usage.accountId !== config.accountId) throw new Error("Usage account mismatch")
    return usage
  }
  const usage = await readUsage()
  const bucket = usage.rateLimitsByLimitId?.codex ?? usage.rateLimits
  if (bucket?.limitId !== "codex") return { action: "blocked", reason: "codex bucket unavailable" }
  if (bucket.spendControlReached !== false) return { action: "blocked", reason: "spend control reached or unknown" }
  if (bucket.rateLimitReachedType && bucket.rateLimitReachedType !== "rate_limit_reached") {
    return { action: "blocked", reason: "non-quota usage restriction" }
  }
  if (typeof usage.ordinaryUsageAllowed !== "boolean")
    return { action: "blocked", reason: "backend permission unavailable" }
  const summary = {
    ordinaryUsageAllowed: usage.ordinaryUsageAllowed,
    usedPercent: bucket.primary?.usedPercent ?? null,
    availableResetCount: usage.rateLimitResetCredits?.availableCount ?? null
  }
  const pending = state?.attempt?.status === "pending"
  if (!pending) {
    if (usage.ordinaryUsageAllowed === true)
      return { action: "continue", ...summary, resetOutcome: state?.attempt?.outcome ?? null }
    if (usage.ordinaryUsageAllowed !== false) return { action: "blocked", reason: "backend permission unavailable" }
    const exhausted =
      bucket.rateLimitReachedType === "rate_limit_reached" ||
      [bucket.primary, bucket.secondary].some(
        (window) => Number.isFinite(window?.usedPercent) && window.usedPercent >= 100
      )
    if (!exhausted) return { action: "blocked", reason: "quota exhaustion not confirmed" }
    if (state?.attempt?.status === "complete")
      return {
        action: ["reset", "alreadyRedeemed"].includes(state.attempt.outcome) ? "exhausted" : "blocked",
        reason: "recorded reset attempt completed",
        ...summary,
        resetOutcome: state.attempt.outcome
      }
    if (!config.allowReset) return { action: "blocked", reason: "reset not authorized" }
    const credit = usage.rateLimitResetCredits?.credits?.find((entry) => entry.id === config.creditId)
    if (
      !credit ||
      credit.status !== "available" ||
      credit.resetType !== "codexRateLimits" ||
      (credit.expiresAt !== null && (!Number.isFinite(credit.expiresAt) || credit.expiresAt * 1000 <= now()))
    ) {
      return { action: "blocked", reason: "authorized credit unavailable or expired" }
    }
    state = {
      version: 1,
      binding,
      attempt: { status: "pending", idempotencyKey: randomUUID(), startedAt: new Date(now()).toISOString() }
    }
    // Must complete durably before the irreversible remote operation.
    await storage.write(state)
  }
  if (!config.allowReset) return { action: "blocked", reason: "reset authorization withdrawn" }
  // Pending requests must replay even when the first request consumed the only credit.
  const response = await rpc("account/rateLimitResetCredit/consume", {
    idempotencyKey: state.attempt.idempotencyKey,
    creditId: config.creditId
  })
  if (!["reset", "alreadyRedeemed", "nothingToReset", "noCredit"].includes(response.outcome))
    throw new Error("Unknown reset outcome; attempt remains pending")
  state = {
    ...state,
    attempt: {
      ...state.attempt,
      status: "complete",
      outcome: response.outcome,
      completedAt: new Date(now()).toISOString()
    }
  }
  await storage.write(state)
  const after = await readUsage()
  state = {
    ...state,
    after: { at: new Date(now()).toISOString(), ordinaryUsageAllowed: after.ordinaryUsageAllowed ?? null }
  }
  await storage.write(state)
  return {
    action: after.ordinaryUsageAllowed === true ? "continue" : "blocked",
    resetOutcome: response.outcome,
    ordinaryUsageAllowed: after.ordinaryUsageAllowed ?? null,
    usedPercent: (after.rateLimitsByLimitId?.codex ?? after.rateLimits)?.primary?.usedPercent ?? null,
    availableResetCount: after.rateLimitResetCredits?.availableCount ?? null
  }
}

function client(binary) {
  const child = spawn(binary, ["app-server"], { stdio: ["pipe", "pipe", "pipe"] })
  const pending = new Map()
  let id = 0
  const fail = (error) => {
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    pending.clear()
  }
  child.on("error", fail)
  child.on("exit", () => fail(new Error("Codex app-server exited")))
  child.stdin.on("error", fail)
  child.stderr.on("data", () => {})
  createInterface({ input: child.stdout }).on("line", (line) => {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    const request = pending.get(message.id)
    if (!request) return
    clearTimeout(request.timer)
    pending.delete(message.id)
    if (message.error) request.reject(new Error(`RPC failed (${message.error.code ?? "unknown"})`))
    else request.resolve(message.result)
  })
  const rpc = (method, params) =>
    new Promise((resolveRequest, reject) => {
      const requestId = ++id
      const timer = setTimeout(() => {
        pending.delete(requestId)
        reject(new Error(`RPC timeout: ${method}`))
      }, 45000)
      pending.set(requestId, { resolve: resolveRequest, reject, timer })
      child.stdin.write(`${JSON.stringify({ id: requestId, method, params })}\n`)
    })
  return { rpc, child }
}

async function main() {
  const args = process.argv.slice(2)
  const locked = args[0] === "--locked"
  if (locked) args.shift()
  if (args.length !== 2 || args[0] !== "--config")
    throw new Error("Usage: native-quota-reset.mjs --config /absolute/config.json")
  const configPath = resolve(args[1])
  const config = JSON.parse(await readFile(configPath, "utf8"))
  validateConfig(config)
  await mkdir(dirname(config.statePath), { recursive: true, mode: 0o700 })
  if (!locked) {
    const lockPath = `${config.statePath}.lock`
    const lock = await open(lockPath, "a", 0o600)
    await lock.close()
    await chmod(lockPath, 0o600)
    const child = spawn(
      "flock",
      [
        "-n",
        "-E",
        "75",
        lockPath,
        process.execPath,
        fileURLToPath(import.meta.url),
        "--locked",
        "--config",
        configPath
      ],
      { stdio: "inherit" }
    )
    child.on("error", (error) => {
      console.error(error.message)
      process.exitCode = 1
    })
    child.on("exit", (code) => {
      process.exitCode = code ?? 1
    })
    return
  }
  const { rpc, child } = client(config.codexPath)
  try {
    await rpc("initialize", {
      clientInfo: { name: "native-quota-guard", version: "1.0" },
      capabilities: { experimentalApi: true }
    })
    child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`)
    const result = await guard(config, rpc, {
      read: async () => {
        try {
          return JSON.parse(await readFile(config.statePath, "utf8"))
        } catch (error) {
          if (error.code === "ENOENT") return null
          throw error
        }
      },
      write: (state) => atomicState(config.statePath, state)
    })
    console.log(JSON.stringify({ at: new Date().toISOString(), ...result }))
  } finally {
    child.stdin.end()
    child.kill("SIGTERM")
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(JSON.stringify({ action: "error", reason: error.message }))
    process.exitCode = 1
  })
}
