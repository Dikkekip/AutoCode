#!/usr/bin/env node
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"

function invoke(program, args, timeout) {
  return execFileSync(program, args, { encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024 })
}

// One tick uses the existing native execution owner; it never creates a second
// dispatcher, rewrites evidence, resumes operator pauses, or restarts workers.
export function run({ openclaw, board, statePath, apply = false, now = Date.now(), command = invoke }) {
  const previous = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { version: 1, board }
  if (previous.version !== 1 || previous.board !== board) throw new Error("Loop state binding mismatch")
  if (
    previous.lastDiscoveryAt !== undefined &&
    (!Number.isSafeInteger(previous.lastDiscoveryAt) || previous.lastDiscoveryAt < 0)
  )
    throw new Error("Loop discovery checkpoint invalid")
  const call = (method, timeout = 180_000) => {
    const response = JSON.parse(
      command(
        openclaw,
        [
          "gateway",
          "call",
          method,
          "--json",
          "--timeout",
          String(timeout),
          "--params",
          JSON.stringify({ boardId: board })
        ],
        timeout + 10_000
      )
    )
    if (!response || response.ok === false || response.error) throw new Error(`Loop RPC ${method} failed`)
    return response
  }
  const status = call("autocode.status")
  const validate = (value) => {
    if (
      value.boardId !== board ||
      typeof value.enabled !== "boolean" ||
      typeof value.control?.paused !== "boolean" ||
      typeof value.control?.frozen !== "boolean" ||
      !Array.isArray(value.activeLeases) ||
      !Array.isArray(value.operations)
    )
      throw new Error("Loop status incomplete")
    return value.enabled && !value.control.paused && !value.control.frozen
  }
  if (!validate(status)) return { action: "preserve-operator-control" }
  if (status.activeLeases.length) return { action: "wait-for-native-operation" }
  const doctor = call("autocode.doctor")
  if (doctor.ok !== true || doctor.skillBinding?.ok !== true) return { action: "readiness-blocked" }
  if (!apply) return { action: "tick-preview" }
  // Reconcile includes bounded dispatch and advances verification/review/repair.
  // A timeout has unknown acceptance: do not issue another mutation in this tick.
  const reconciled = call("autocode.reconcile", 7_200_000)
  const dispatch = reconciled.dispatch
  const evidence = dispatch
    ? {
        dispatch: {
          startedCount: Number.isSafeInteger(dispatch.startedCount) ? dispatch.startedCount : 0,
          deferredCount: Number.isSafeInteger(dispatch.deferredCount) ? dispatch.deferredCount : 0,
          resourceReasons: Array.isArray(dispatch.resourcePressure?.reasons)
            ? dispatch.resourcePressure.reasons.filter((reason) =>
                [
                  "host-memory",
                  "gateway-memory",
                  "memory-stall",
                  "cpu-load",
                  "recovery-hold",
                  "telemetry-unavailable"
                ].includes(reason)
              )
            : [],
          deferred: Array.isArray(dispatch.deferred)
            ? dispatch.deferred
                .slice(0, 32)
                .filter(
                  (item) =>
                    /^[A-Za-z0-9:_-]{1,200}$/.test(item?.cardId ?? "") &&
                    ["worktree-capacity", "workspace-unavailable"].includes(item?.reason)
                )
                .map(({ cardId, reason }) => ({ cardId, reason }))
            : []
        }
      }
    : {}
  const after = call("autocode.status")
  if (!validate(after)) return { action: "preserve-operator-control", advanced: reconciled.advanced ?? 0, ...evidence }
  if (after.activeLeases.length) return { action: "wait-for-native-operation", ...evidence }
  if (dispatch?.resourcePressure?.allowed === false || after.resourcePressure?.allowed === false)
    return { action: "resource-deferred", advanced: reconciled.advanced ?? 0, ...evidence }
  if (
    !after.counts ||
    ["ready", "running"].some((key) => !Number.isSafeInteger(after.counts[key] ?? 0) || (after.counts[key] ?? 0) < 0)
  )
    throw new Error("Loop capacity evidence incomplete")
  const busy = (after.counts.ready ?? 0) > 0 || (after.counts.running ?? 0) > 0
  const discoveryDue = !previous.lastDiscoveryAt || now - previous.lastDiscoveryAt >= 30 * 60_000
  if (busy || !discoveryDue) return { action: "reconciled", advanced: reconciled.advanced ?? 0, ...evidence }
  // Persist before discovery so a lost response does not generate another round.
  mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 })
  const temporary = `${statePath}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify({ version: 1, board, lastDiscoveryAt: now }) + "\n", {
    mode: 0o600,
    flag: "wx"
  })
  renameSync(temporary, statePath)
  const discovery = call("autocode.discover", 7_200_000)
  return {
    action: "discovered",
    advanced: reconciled.advanced ?? 0,
    created: discovery.created?.length ?? 0,
    ...evidence
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const options = { apply: false }
    const args = process.argv.slice(2)
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--apply") options.apply = true
      else if (["--openclaw", "--board", "--state"].includes(args[i]) && args[i + 1])
        options[args[i].slice(2) === "state" ? "statePath" : args[i].slice(2)] = args[++i]
      else throw new Error("Unknown or incomplete loop argument")
    }
    if (!options.openclaw || !options.board || !options.statePath)
      throw new Error("--openclaw, --board and --state required")
    process.stdout.write(JSON.stringify(run(options)) + "\n")
  } catch {
    // Keep credentials and private RPC output out of timer logs.
    process.stderr.write("Native loop tick failed; inspect Gateway readiness and native evidence before retrying.\n")
    process.exitCode = 1
  }
}
