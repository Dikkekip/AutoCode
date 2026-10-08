import { readFileSync } from "node:fs"
import { availableParallelism, freemem, loadavg, totalmem } from "node:os"
import type { NativeAutonomyPolicy } from "@openclaw/domain"

const MiB = 1024 * 1024
// All boards hosted by one Gateway share the same pre-allocation budget.
let reservedBytes = 0

export interface NativeResourceSample {
  totalBytes: number
  availableBytes: number
  gatewayRssBytes: number
  memoryFullAvg10: number
  cpuCount: number
  loadAverage1m: number
}

/** MemAvailable includes reclaimable cache; free RAM alone is not a pressure signal. */
export function readNativeResourceSample(): NativeResourceSample {
  let totalBytes = totalmem()
  let availableBytes = freemem()
  let memoryFullAvg10 = 0
  if (process.platform === "linux") {
    const memory = readFileSync("/proc/meminfo", "utf8")
    const field = (name: string) => {
      const value = Number(new RegExp(`^${name}:\\s+(\\d+) kB$`, "m").exec(memory)?.[1]) * 1024
      if (!Number.isFinite(value) || value <= 0) throw new Error("Unavailable host memory telemetry")
      return value
    }
    totalBytes = field("MemTotal")
    availableBytes = field("MemAvailable")
    try {
      const pressure = readFileSync("/proc/pressure/memory", "utf8")
      const value = Number(/^full avg10=([\d.]+)/m.exec(pressure)?.[1])
      if (!Number.isFinite(value)) throw new Error("Invalid memory pressure telemetry")
      memoryFullAvg10 = value
    } catch (error) {
      // PSI is optional on kernels that do not expose it; malformed readable data is not.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
  return {
    totalBytes,
    availableBytes,
    gatewayRssBytes: process.memoryUsage().rss,
    memoryFullAvg10,
    cpuCount: availableParallelism(),
    loadAverage1m: loadavg()[0] ?? 0
  }
}

export class NativeResourceGuard {
  private heldUntil = 0
  constructor(
    private readonly config: NativeAutonomyPolicy["resourceControls"],
    private readonly sample = readNativeResourceSample,
    private readonly now = Date.now
  ) {}

  reserve(bytes: number): () => void {
    if (!Number.isFinite(bytes) || bytes <= 0) throw new Error("Invalid memory reservation")
    reservedBytes += bytes
    let released = false
    return () => {
      if (!released) reservedBytes -= bytes
      released = true
    }
  }

  inspect() {
    const now = this.now()
    const config = this.config
    try {
      const sample = this.sample()
      if (
        !Number.isFinite(sample.totalBytes) ||
        sample.totalBytes <= 0 ||
        !Number.isFinite(sample.availableBytes) ||
        sample.availableBytes < 0 ||
        sample.availableBytes > sample.totalBytes ||
        !Number.isFinite(sample.gatewayRssBytes) ||
        sample.gatewayRssBytes < 0 ||
        !Number.isFinite(sample.memoryFullAvg10) ||
        sample.memoryFullAvg10 < 0 ||
        sample.memoryFullAvg10 > 100 ||
        !Number.isInteger(sample.cpuCount) ||
        sample.cpuCount < 1 ||
        !Number.isFinite(sample.loadAverage1m) ||
        sample.loadAverage1m < 0
      )
        throw new Error("Invalid resource sample")
      const reserveBytes = (config?.minAvailableMiB ?? Math.max(512, (sample.totalBytes / MiB) * 0.15)) * MiB
      const maxRssBytes = (config?.maxGatewayRssMiB ?? Math.min(3072, (sample.totalBytes / MiB) * 0.25)) * MiB
      const workerBytes = (config?.workerReserveMiB ?? 2048) * MiB
      const loadPercent = (sample.loadAverage1m / sample.cpuCount) * 100
      const reasons: string[] = []
      if (sample.availableBytes - reservedBytes < reserveBytes + workerBytes) reasons.push("host-memory")
      if (sample.gatewayRssBytes >= maxRssBytes) reasons.push("gateway-memory")
      if (sample.memoryFullAvg10 >= (config?.maxMemoryPressurePercent ?? 5)) reasons.push("memory-stall")
      if (loadPercent >= (config?.maxCpuLoadPercent ?? 125)) reasons.push("cpu-load")
      if (reasons.length) this.heldUntil = now + (config?.recoveryHoldSeconds ?? 60) * 1000
      else if (now < this.heldUntil) reasons.push("recovery-hold")
      return {
        allowed: reasons.length === 0,
        reasons,
        startCapacity: reasons.length
          ? 0
          : Math.max(0, Math.floor((sample.availableBytes - reservedBytes - reserveBytes) / workerBytes)),
        heldUntil: this.heldUntil,
        reserveBytes,
        maxRssBytes,
        workerBytes,
        reservedBytes,
        loadPercent,
        sample
      }
    } catch {
      this.heldUntil = now + (config?.recoveryHoldSeconds ?? 60) * 1000
      return { allowed: false, reasons: ["telemetry-unavailable"], startCapacity: 0, heldUntil: this.heldUntil }
    }
  }
}
