#!/usr/bin/env node
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"

const FAILURE = "Agent database cleanup failed"
const MIN_FAILURE_SPAN_MS = 10 * 60_000
const RESTART_COOLDOWN_MS = 60 * 60_000
const SERVICE = "openclaw-gateway.service"

export function classifyProbe(exitCode, stdout) {
  let response
  try {
    response = JSON.parse(stdout)
  } catch {
    return "other_error"
  }
  if (exitCode === 0 && Array.isArray(response?.cards)) return "healthy"
  return typeof response?.error?.message === "string" && response.error.message.includes(FAILURE)
    ? "cleanup_failed"
    : "other_error"
}

export function decide(previous, { pid, active, probe, now }) {
  const lastRestartAtMs = Number(previous?.lastRestartAtMs) || 0
  const fresh = { version: 1, pid, failures: 0, firstFailedAtMs: null, lastRestartAtMs }
  if (!active || !Number.isSafeInteger(pid) || pid < 1 || probe !== "cleanup_failed") {
    return { state: fresh, restart: false }
  }
  const sameProcess = previous?.pid === pid && previous?.failures > 0
  const failures = sameProcess ? previous.failures + 1 : 1
  const firstFailedAtMs = sameProcess ? previous.firstFailedAtMs : now
  const restart =
    failures >= 3 &&
    now - firstFailedAtMs >= MIN_FAILURE_SPAN_MS &&
    (!lastRestartAtMs || now - lastRestartAtMs >= RESTART_COOLDOWN_MS)
  return {
    state: { ...fresh, failures, firstFailedAtMs, lastRestartAtMs: restart ? now : lastRestartAtMs },
    restart
  }
}

function command(program, args, timeout = 30_000) {
  try {
    return {
      exitCode: 0,
      stdout: execFileSync(program, args, { encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024 })
    }
  } catch (error) {
    return { exitCode: error.status ?? 1, stdout: String(error.stdout ?? "") }
  }
}

function atomicWrite(path, state) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600, flag: "wx" })
  renameSync(temporary, path)
}

export function run({ openclaw, board, statePath, apply, now = Date.now(), invoke = command }) {
  let previous = {}
  if (existsSync(statePath)) {
    previous = JSON.parse(readFileSync(statePath, "utf8"))
    if (previous?.version !== 1) throw new Error("Recovery state version is unsupported")
  }
  const service = invoke("systemctl", ["--user", "show", SERVICE, "-p", "ActiveState", "-p", "MainPID"])
  if (service.exitCode !== 0) throw new Error("Cannot inspect Gateway service")
  const fields = Object.fromEntries(
    service.stdout
      .trim()
      .split("\n")
      .map((line) => line.split("=", 2))
  )
  const active = fields.ActiveState === "active"
  const pid = Number(fields.MainPID)
  const result = invoke(
    openclaw,
    [
      "gateway",
      "call",
      "workboard.cards.list",
      "--json",
      "--timeout",
      "30000",
      "--params",
      JSON.stringify({ boardId: board })
    ],
    45_000
  )
  const probe = classifyProbe(result.exitCode, result.stdout)
  const decision = decide(previous, { pid, active, probe, now })
  if (!apply && decision.restart) decision.state.lastRestartAtMs = previous.lastRestartAtMs ?? 0
  atomicWrite(statePath, decision.state)
  const restart = apply && decision.restart
  if (restart) {
    const outcome = invoke("systemctl", ["--user", "restart", SERVICE], 390_000)
    if (outcome.exitCode !== 0) throw new Error("Gateway restart failed; cooldown retained for inspection")
  }
  return {
    probe,
    active,
    pid,
    consecutiveFailures: decision.state.failures,
    restartEligible: decision.restart,
    restartAttempted: restart
  }
}

function parseArgs(args) {
  const options = { apply: false }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--apply") options.apply = true
    else if (["--openclaw", "--board", "--state"].includes(args[i])) options[args[i].slice(2)] = args[++i]
    else throw new Error("Unknown recovery argument")
  }
  if (!options.openclaw || !options.board || !options.state)
    throw new Error("--openclaw, --board and --state are required")
  return options
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const options = parseArgs(process.argv.slice(2))
    process.stdout.write(
      `${JSON.stringify(
        run({
          openclaw: options.openclaw,
          board: options.board,
          statePath: options.state,
          apply: options.apply
        })
      )}\n`
    )
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}
