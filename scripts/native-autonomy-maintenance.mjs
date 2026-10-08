#!/usr/bin/env node
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"

const SERVICE = "openclaw-gateway.service"
export function idle(status, cards) {
  // Missing or uncertain execution evidence blocks maintenance.
  return (
    Array.isArray(cards) &&
    Array.isArray(status.activeLeases) &&
    status.activeLeases.length === 0 &&
    Array.isArray(status.operations) &&
    status.operations.length === 0 &&
    status.resourcePressure?.reservedBytes === 0 &&
    !cards.some(
      (c) =>
        !["todo", "ready", "review", "blocked", "scheduled", "done", "cancelled"].includes(c.status) ||
        c.status === "running" ||
        ["running", "pending"].includes(c.execution?.status) ||
        c.metadata?.automation?.launch?.phase === "pending"
    )
  )
}
export function decide(previous, status, now) {
  const pressure = status.resourcePressure?.reasons?.includes("gateway-memory") === true
  const observations = pressure ? (previous.observations ?? 0) + 1 : 0
  const firstPressureAt = pressure ? (previous.firstPressureAt ?? now) : null
  return {
    ...previous,
    observations,
    firstPressureAt,
    eligible:
      pressure &&
      observations >= 3 &&
      now - firstPressureAt >= 600_000 &&
      now - (previous.lastRestartAt ?? 0) >= 3_600_000
  }
}
function invoke(program, args, timeout = 60_000) {
  return execFileSync(program, args, { encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024 })
}
export function run({ openclaw, board, statePath, apply = false, now = Date.now(), command = invoke }) {
  let state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { version: 1 }
  if (state.version !== 1) throw new Error("Unsupported maintenance state")
  const save = () => {
    if (!apply) return
    mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 })
    const temporary = `${statePath}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify(state) + "\n", { mode: 0o600, flag: "wx" })
    renameSync(temporary, statePath)
  }
  const call = (method, params = {}) => {
    const result = JSON.parse(
      command(
        openclaw,
        [
          "gateway",
          "call",
          method,
          "--json",
          "--timeout",
          "180000",
          "--params",
          JSON.stringify({ boardId: board, ...params })
        ],
        190_000
      )
    )
    if (result?.ok === false) throw new Error(`Maintenance RPC ${method} failed`)
    return result
  }
  const status = call("autocode.status")
  if (status.boardId !== board || typeof status.control?.revision !== "string")
    throw new Error("Maintenance status unavailable")
  if (state.ownedRevision) {
    if (!status.control.paused || status.control.revision !== state.ownedRevision) {
      delete state.ownedRevision
      save()
      return { action: "preserve-operator-control" }
    }
    if (!apply) return { action: "resume-owned-pause-preview" }
    const doctor = call("autocode.doctor")
    if (!doctor.ok) throw new Error("Maintenance resume blocked by Doctor")
    call("autocode.resume", { expectedRevision: state.ownedRevision })
    delete state.ownedRevision
    save()
    return { action: "resumed-owned-pause" }
  }
  state = decide(state, status, now)
  save()
  if (status.control.paused || status.control.frozen) return { action: "preserve-operator-pause" }
  if (!state.eligible) return { action: "observe", observations: state.observations }
  const cards = call("workboard.cards.list").cards
  if (!idle(status, cards)) return { action: "wait-for-accepted-work" }
  if (!apply) return { action: "restart-preview" }
  const paused = call("autocode.pause", { expectedRevision: status.control.revision })
  if (typeof paused.revision !== "string" || paused.paused !== true)
    throw new Error("Maintenance pause was not acknowledged")
  state.ownedRevision = paused.revision
  save()
  // Recheck after closing admission. A racing accepted run must never be killed.
  const drained = call("autocode.status")
  if (drained.control?.revision !== state.ownedRevision || !drained.control.paused) {
    delete state.ownedRevision
    save()
    return { action: "preserve-operator-control" }
  }
  if (!idle(drained, call("workboard.cards.list").cards)) {
    call("autocode.resume", { expectedRevision: state.ownedRevision })
    delete state.ownedRevision
    save()
    return { action: "accepted-work-raced-maintenance" }
  }
  state.lastRestartAt = now
  save()
  command("systemctl", ["--user", "restart", SERVICE], 390_000)
  // The next timer tick checks readiness and resumes this exact owned revision.
  return { action: "restarted-idle-gateway", pausedRevision: state.ownedRevision }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const options = { apply: false }
  try {
    for (let i = 2; i < process.argv.length; i++) {
      const arg = process.argv[i]
      if (arg === "--apply") options.apply = true
      else if (["--openclaw", "--board", "--state"].includes(arg)) options[arg.slice(2)] = process.argv[++i]
      else throw new Error("Unknown maintenance argument")
    }
    if (!options.openclaw || !options.board || !options.state)
      throw new Error("--openclaw, --board and --state required")
    console.log(JSON.stringify(run({ ...options, statePath: options.state })))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
