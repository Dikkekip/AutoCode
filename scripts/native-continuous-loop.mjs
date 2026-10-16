#!/usr/bin/env node
import { execFile, execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"

function invoke(program, args, timeout) {
  return execFileSync(program, args, { encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024 })
}

// One tick uses the existing native execution owner; it never creates a second
// dispatcher, rewrites evidence, resumes operator pauses, or restarts workers.
export function run({
  openclaw,
  board,
  statePath,
  apply = false,
  discoveryIntervalMs = 30 * 60_000,
  dispatchOnly = false,
  clock = Date.now,
  command = invoke
}) {
  if (!Number.isSafeInteger(discoveryIntervalMs) || discoveryIntervalMs < 60_000 || discoveryIntervalMs > 86_400_000)
    throw new Error("Loop discovery interval must be between one minute and one day")
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
  const blocksTick = (value) =>
    value.activeLeases.some(
      ({ id }) => !dispatchOnly || !/^(workflow:[a-f0-9]{64}|capacity:verification:\d+)$/.test(id)
    )
  if (blocksTick(status)) return { action: "wait-for-native-operation" }
  const doctor = call("autocode.doctor")
  if (doctor.ok !== true || doctor.skillBinding?.ok !== true) return { action: "readiness-blocked" }
  if (!apply) return { action: "tick-preview" }
  const discoveryDue = () => !previous.lastDiscoveryAt || clock() - previous.lastDiscoveryAt >= discoveryIntervalMs
  const discover = () => {
    // Journal before acceptance, including operator requests, to avoid duplicate rounds after a lost response.
    const now = clock()
    mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 })
    const temporary = `${statePath}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify({ version: 1, board, lastDiscoveryAt: now }) + "\n", {
      mode: 0o600,
      flag: "wx"
    })
    renameSync(temporary, statePath)
    previous.lastDiscoveryAt = now
    return call("autocode.discover", 7_200_000)
  }
  // Admit explicit operator work before reconciliation can enter a long verifier.
  // The native discovery owner retains scope, daily-budget and downstream backpressure checks.
  let requestedDiscovery
  if (discoveryDue() && status.resourcePressure?.allowed === true) {
    const requests = call("autocode.requests.list")
    if (!Array.isArray(requests.requests)) throw new Error("Loop requests response incomplete")
    if (requests.requests.some((request) => request.state === "queued")) requestedDiscovery = discover()
  }
  // Reconcile includes bounded dispatch and advances verification/review/repair.
  // A timeout has unknown acceptance: do not issue another mutation in this tick.
  const reconciled = call(dispatchOnly ? "autocode.dispatch" : "autocode.reconcile", dispatchOnly ? 180_000 : 7_200_000)
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
  if (blocksTick(after)) return { action: "wait-for-native-operation", ...evidence }
  if (dispatch?.resourcePressure?.allowed === false || after.resourcePressure?.allowed === false)
    return { action: "resource-deferred", advanced: reconciled.advanced ?? 0, ...evidence }
  if (
    !after.counts ||
    ["ready", "running"].some((key) => !Number.isSafeInteger(after.counts[key] ?? 0) || (after.counts[key] ?? 0) < 0)
  )
    throw new Error("Loop capacity evidence incomplete")
  const busy = (after.counts.ready ?? 0) > 0 || (after.counts.running ?? 0) > 0
  if (busy || !discoveryDue())
    return {
      action: "reconciled",
      advanced: reconciled.advanced ?? 0,
      ...(requestedDiscovery
        ? {
            requestedDiscovery: { created: requestedDiscovery.created?.length ?? 0, reason: requestedDiscovery.reason }
          }
        : {}),
      ...evidence
    }
  const discovery = discover()
  return {
    action: "discovered",
    advanced: reconciled.advanced ?? 0,
    created: discovery.created?.length ?? 0,
    ...evidence
  }
}

// One process owns the long reconciliation and its lightweight pulses. The native
// owner still arbitrates each RPC with persisted control revisions and leases.
// A failed/uncertain mutation stops new pulses; it is never retried in this process.
export async function coordinate(
  options,
  {
    intervalMs = 60_000,
    tick = run,
    reconcile = (openclaw, board) =>
      new Promise((resolve, reject) => {
        execFile(
          openclaw,
          [
            "gateway",
            "call",
            "autocode.reconcile",
            "--json",
            "--timeout",
            "7200000",
            "--params",
            JSON.stringify({ boardId: board })
          ],
          { encoding: "utf8", timeout: 7_210_000, maxBuffer: 16 * 1024 * 1024 },
          (error, stdout) => {
            if (error) return reject(new Error("Loop reconciliation acceptance uncertain"))
            try {
              const result = JSON.parse(stdout)
              if (!result || result.ok === false || result.error) throw new Error("RPC failed")
              resolve(result)
            } catch {
              reject(new Error("Loop reconciliation response invalid"))
            }
          }
        )
      }),
    wait = (ms, signal) =>
      new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer)
          signal.removeEventListener("abort", done)
          resolve()
        }
        const timer = setTimeout(done, ms)
        signal.addEventListener("abort", done, { once: true })
        if (signal.aborted) done()
      })
  } = {}
) {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 60_000) throw new Error("Loop pulse interval invalid")
  const initial = tick({ ...options, dispatchOnly: true })
  if (
    !options.apply ||
    ["preserve-operator-control", "wait-for-native-operation", "readiness-blocked"].includes(initial.action)
  )
    return initial
  // Do not start a second long advancement around an existing native operation.
  const status = JSON.parse(
    (options.command ?? invoke)(
      options.openclaw,
      [
        "gateway",
        "call",
        "autocode.status",
        "--json",
        "--timeout",
        "180000",
        "--params",
        JSON.stringify({ boardId: options.board })
      ],
      190_000
    )
  )
  if (
    status.boardId !== options.board ||
    status.ok === false ||
    status.error ||
    !Array.isArray(status.activeLeases) ||
    typeof status.enabled !== "boolean" ||
    typeof status.control?.paused !== "boolean" ||
    typeof status.control?.frozen !== "boolean"
  )
    throw new Error("Loop status incomplete")
  if (!status.enabled || status.control.paused || status.control.frozen) return { action: "preserve-operator-control" }
  if (status.activeLeases.length) return { ...initial, advancement: "native-operation-active" }
  const settled = new AbortController()
  let result
  let failure
  const pending = Promise.resolve()
    .then(() => reconcile(options.openclaw, options.board))
    .then(
      (value) => {
        result = value
      },
      (error) => {
        failure = error
      }
    )
    .finally(() => settled.abort())
  let pulses = 0
  try {
    while (!settled.signal.aborted) {
      await wait(intervalMs, settled.signal)
      if (settled.signal.aborted) break
      const pulse = tick({ ...options, dispatchOnly: true })
      pulses++
      if (["preserve-operator-control", "readiness-blocked"].includes(pulse.action)) break
    }
  } finally {
    // The accepted reconciliation retains custody until its result is known.
    // Never abandon it and launch a replacement mutation after a pulse failure.
    await pending
  }
  if (failure) throw failure
  return { action: "coordinated", advanced: result.advanced ?? 0, pulses, initial }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const options = { apply: false }
    let coordinated = false
    const args = process.argv.slice(2)
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--coordinate") coordinated = true
      else if (args[i] === "--apply") options.apply = true
      else if (args[i] === "--discovery-interval-seconds" && args[i + 1])
        options.discoveryIntervalMs = Number(args[++i]) * 1000
      else if (["--openclaw", "--board", "--state"].includes(args[i]) && args[i + 1])
        options[args[i].slice(2) === "state" ? "statePath" : args[i].slice(2)] = args[++i]
      else throw new Error("Unknown or incomplete loop argument")
    }
    if (!options.openclaw || !options.board || !options.statePath)
      throw new Error("--openclaw, --board and --state required")
    process.stdout.write(JSON.stringify(coordinated ? await coordinate(options) : run(options)) + "\n")
  } catch {
    // Keep credentials and private RPC output out of timer logs.
    process.stderr.write("Native loop tick failed; inspect Gateway readiness and native evidence before retrying.\n")
    process.exitCode = 1
  }
}
