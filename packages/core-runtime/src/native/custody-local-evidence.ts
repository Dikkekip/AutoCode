import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readFileSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex")
/** Server-owned local observations, never caller supplied transport or absence assertions. */
export function nativeCustodyLocalIdentity() {
  if (process.env.OPENCLAW_SERVICE_KIND !== "gateway" || !process.argv.includes("gateway"))
    throw new Error("Custody requires the owning local Gateway process")
  if (process.env.OPENCLAW_PROFILE?.trim() || process.env.OPENCLAW_HOME?.trim())
    throw new Error("Custody rejects alternate Gateway profiles")
  if (process.env.OPENCLAW_GATEWAY_URL?.trim()) throw new Error("Custody rejects Gateway URL overrides")
  const path =
    process.env.OPENCLAW_CONFIG_PATH ||
    join(process.env.OPENCLAW_STATE_DIR || join(homedir(), ".openclaw"), "openclaw.json")
  if (realpathSync(path) !== path) throw new Error("Custody config must be an exact physical file")
  const raw = readFileSync(path),
    config = JSON.parse(raw.toString())
  if (config.gateway?.mode !== "local" || config.gateway?.remote?.url)
    throw new Error("Custody requires configured local Gateway without remote URL")
  if (process.env.OPENCLAW_GATEWAY_PORT && Number(process.env.OPENCLAW_GATEWAY_PORT) !== (config.gateway.port ?? 18789))
    throw new Error("Gateway port override differs from config")
  const stat = readFileSync("/proc/self/stat", "utf8")
  const processStartTicks = Number(stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19])
  const ticksPerSecond = Number(
    execFileSync("getconf", ["CLK_TCK"], { timeout: 1000, maxBuffer: 32 }).toString().trim()
  )
  const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim().replaceAll("-", "")
  if (
    !Number.isSafeInteger(processStartTicks) ||
    processStartTicks <= 0 ||
    !Number.isSafeInteger(ticksPerSecond) ||
    ticksPerSecond <= 0 ||
    !/^[a-f0-9]{32}$/.test(bootId)
  )
    throw new Error("Native process birth identity unavailable")
  const unit = process.env.OPENCLAW_SYSTEMD_UNIT
  if (!unit || !/^[a-zA-Z0-9_.@-]+\.service$/.test(unit)) throw new Error("Owning Gateway service unavailable")
  const service = execFileSync(
    "systemctl",
    ["--user", "show", unit, "--property=MainPID,ExecMainStartTimestampMonotonic", "--no-pager"],
    { timeout: 1000, maxBuffer: 4096 }
  ).toString()
  const properties = Object.fromEntries(
    service
      .trim()
      .split("\n")
      .map((line) => {
        const at = line.indexOf("=")
        return [line.slice(0, at), line.slice(at + 1)]
      })
  )
  const serviceStartMonotonicUs = Number(properties.ExecMainStartTimestampMonotonic)
  if (
    Number(properties.MainPID) !== process.pid ||
    !Number.isSafeInteger(serviceStartMonotonicUs) ||
    serviceStartMonotonicUs <= 0
  )
    throw new Error("Exact owning service monotonic process boundary unavailable")
  return {
    serviceStartMonotonicUs,
    configPath: path,
    configSha256: hash(raw),
    gatewayMode: "local",
    port: config.gateway.port ?? 18789,
    currentPid: process.pid,
    processStartTicks,
    ticksPerSecond,
    bootId,
    unit
  }
}
export function nativeCustodyLocalEvidence(preparedAt: number) {
  const identity = nativeCustodyLocalIdentity()
  if (!Number.isSafeInteger(preparedAt) || preparedAt <= 0 || preparedAt >= Date.now())
    throw new Error("Invalid original preparation time")
  const { unit, serviceStartMonotonicUs, bootId } = identity
  const since = new Date(preparedAt - 1000).toISOString().slice(0, 19).replace("T", " ") + " UTC",
    until = new Date(preparedAt + 2000).toISOString().slice(0, 19).replace("T", " ") + " UTC"
  const rawJournal = execFileSync(
    "journalctl",
    ["--user", "-u", unit, "--since", since, "--until", until, "--output=json", "--no-pager"],
    { timeout: 10_000, maxBuffer: 1024 * 1024 }
  )
  const matches = rawJournal
    .toString()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => {
      const message = String(entry.MESSAGE ?? ""),
        time = Number(entry.__REALTIME_TIMESTAMP) / 1000
      return (
        time >= preparedAt &&
        time <= preparedAt + 1000 &&
        message.includes("workboard.cards.create") &&
        message.includes("workspace path is outside") &&
        message.includes("errorCode=workboard_error")
      )
    })
  if (matches.length !== 1) throw new Error("Original local create rejection is missing or ambiguous")
  const rejection = matches[0],
    oldPid = Number(rejection._PID)
  const rejectedAtUs = Number(rejection.__REALTIME_TIMESTAMP),
    rejectedMonotonicUs = Number(rejection.__MONOTONIC_TIMESTAMP)
  if (
    !Number.isSafeInteger(rejectedAtUs) ||
    rejectedAtUs <= 0 ||
    !Number.isSafeInteger(rejectedMonotonicUs) ||
    rejectedMonotonicUs <= 0 ||
    rejection._BOOT_ID !== bootId ||
    rejection._SYSTEMD_USER_UNIT !== unit ||
    Number(rejection._UID) !== process.getuid?.() ||
    rejectedMonotonicUs >= serviceStartMonotonicUs
  )
    throw new Error("Original rejection is not before the current native local process")
  if (!Number.isSafeInteger(oldPid) || oldPid <= 0 || existsSync(`/proc/${oldPid}`))
    throw new Error("Original local Gateway process has not demonstrably ended")
  const witness = {
    oldPid,
    rejectedAtUs,
    rejectedMonotonicUs,
    bootId,
    unit,
    uid: Number(rejection._UID),
    messageSha256: hash(String(rejection.MESSAGE))
  }
  return {
    ...identity,
    oldPid,
    rejectedAtUs,
    rejectedMonotonicUs,
    rejectionMessageSha256: witness.messageSha256,
    journalRejectionSha256: hash(JSON.stringify(witness)),
    uncertainty: "Full original wire key is not logged; hold preserves uncertainty, not external outcome confirmation"
  }
}
