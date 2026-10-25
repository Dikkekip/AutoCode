#!/usr/bin/env node
import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const service = "openclaw-gateway.service"
const MiB = 1024 * 1024

/** Only sustained pressure in the same process qualifies; never interrupt a known active card. */
export function decideMemoryRecovery(previous, { pid, rssBytes, idle, now, maxRssMiB = 3072 }) {
  if (!Number.isSafeInteger(pid) || pid < 1 || !Number.isFinite(rssBytes) || rssBytes < 0)
    throw new Error("Invalid gateway memory observation")
  if (!Number.isSafeInteger(maxRssMiB) || maxRssMiB < 64) throw new Error("Invalid memory threshold")
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid observation time")
  if (
    Object.keys(previous).length &&
    (previous.version !== 1 ||
      !Number.isSafeInteger(previous.pid) ||
      previous.pid < 1 ||
      !Number.isSafeInteger(previous.samples) ||
      previous.samples < 0 ||
      !Number.isSafeInteger(previous.lastObservedAt) ||
      previous.lastObservedAt < 0 ||
      (previous.samples > 0 && (!Number.isSafeInteger(previous.firstPressureAt) || previous.firstPressureAt < 0)) ||
      (previous.lastRestartAt !== null &&
        (!Number.isSafeInteger(previous.lastRestartAt) || previous.lastRestartAt < 0)))
  )
    throw new Error("Invalid memory watch state")
  const pressured = rssBytes >= maxRssMiB * MiB
  const sameProcess =
    previous.pid === pid &&
    previous.samples > 0 &&
    now >= previous.lastObservedAt &&
    now - previous.lastObservedAt <= 90_000
  const firstPressureAt = pressured ? (sameProcess ? previous.firstPressureAt : now) : null
  const samples = pressured ? (sameProcess ? previous.samples + 1 : 1) : 0
  const lastRestartAt = previous.lastRestartAt ?? null
  const restartEligible =
    pressured &&
    idle &&
    samples >= 3 &&
    now - firstPressureAt >= 120_000 &&
    (lastRestartAt === null || now - lastRestartAt >= 3_600_000)
  return {
    state: { version: 1, pid, samples, firstPressureAt, lastRestartAt, lastObservedAt: now },
    restartEligible,
    pressured
  }
}

function invoke(program, args) {
  return execFileSync(program, args, { encoding: "utf8", timeout: 35_000, maxBuffer: 1024 * 1024 })
}

export function runMemoryWatch({
  statePath,
  openclaw = "openclaw",
  apply = false,
  maxRssMiB = 3072,
  now = Date.now(),
  command = invoke,
  read = readFileSync
}) {
  const fields = Object.fromEntries(
    command("systemctl", ["--user", "show", service, "-p", "ActiveState", "-p", "MainPID"])
      .trim()
      .split("\n")
      .map((line) => line.split("=", 2))
  )
  if (fields.ActiveState !== "active") return { active: false, restartAttempted: false }
  const pid = Number(fields.MainPID)
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Invalid gateway PID")
  const status = read(`/proc/${pid}/status`, "utf8")
  const rssBytes = Number(/^VmRSS:\s+(\d+) kB$/m.exec(status)?.[1]) * 1024
  let previous = {}
  try {
    previous = JSON.parse(read(statePath, "utf8"))
    if (previous.version !== 1) throw new Error("Unsupported memory watch state")
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
  // Avoid loading a possibly large Workboard response while memory is healthy.
  let idle = false
  if (rssBytes >= maxRssMiB * MiB) {
    const cards = JSON.parse(
      command(openclaw, ["gateway", "call", "workboard.cards.list", "--json", "--timeout", "30000", "--params", "{}"])
    )
    idle =
      Array.isArray(cards.cards) &&
      !cards.hasMore &&
      !cards.nextCursor &&
      cards.cards.every(
        (card) =>
          typeof card?.status === "string" &&
          card.status !== "running" &&
          card.execution?.status !== "running" &&
          !card.metadata?.claim?.ownerId
      )
  }
  const decision = decideMemoryRecovery(previous, { pid, rssBytes, idle, now, maxRssMiB })
  const restartAttempted = apply && decision.restartEligible
  if (restartAttempted) decision.state.lastRestartAt = now
  mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 })
  const temp = `${statePath}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(decision.state)}\n`, { mode: 0o600, flag: "wx" })
  renameSync(temp, statePath)
  if (restartAttempted) {
    // Recheck process identity and idle state immediately before the restart.
    const current = command("systemctl", ["--user", "show", service, "-p", "MainPID"]).trim()
    if (current !== `MainPID=${pid}`) throw new Error("Gateway changed before recovery; cooldown retained")
    const currentCards = JSON.parse(
      command(openclaw, ["gateway", "call", "workboard.cards.list", "--json", "--timeout", "30000", "--params", "{}"])
    )
    if (
      !Array.isArray(currentCards.cards) ||
      currentCards.hasMore ||
      currentCards.nextCursor ||
      currentCards.cards.some(
        (card) =>
          typeof card?.status !== "string" ||
          card.status === "running" ||
          card.execution?.status === "running" ||
          card.metadata?.claim?.ownerId
      )
    )
      throw new Error("Gateway has active or uncertain work; cooldown retained")
    command("systemctl", ["--user", "restart", "--no-block", service])
  }
  return {
    active: true,
    pid,
    rssMiB: Math.round(rssBytes / MiB),
    idle,
    pressured: decision.pressured,
    restartEligible: decision.restartEligible,
    restartAttempted
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const option = (name) => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : undefined
  }
  const statePath = option("--state")
  if (!statePath) throw new Error("--state is required")
  console.log(
    JSON.stringify(
      runMemoryWatch({
        statePath,
        openclaw: option("--openclaw"),
        maxRssMiB: Number(option("--max-rss-mib") ?? 3072),
        apply: args.includes("--apply")
      })
    )
  )
}
