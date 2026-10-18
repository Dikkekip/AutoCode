import { statfsSync } from "node:fs"

export const NATIVE_STORAGE_RESERVE_BYTES = 10 * 1024 ** 3
export class NativeStoragePending extends Error {}

/** Admission only: arbitrary scripts and other host writers cannot be disk-quota controlled here. */
export function inspectNativeStorage(path: string, allocationBytes = 0, readSpace = statfsSync) {
  try {
    if (!Number.isSafeInteger(allocationBytes) || allocationBytes < 0) throw new Error("Invalid allocation")
    const space = readSpace(path)
    const availableBytes = Number(space.bavail) * Number(space.bsize)
    const requiredBytes = NATIVE_STORAGE_RESERVE_BYTES + allocationBytes
    if (!Number.isSafeInteger(availableBytes) || availableBytes < 0 || !Number.isSafeInteger(requiredBytes))
      throw new Error("Invalid storage telemetry")
    return { allowed: availableBytes >= requiredBytes, availableBytes, requiredBytes }
  } catch {
    return { allowed: false, availableBytes: null, requiredBytes: null }
  }
}

export function requireNativeStorage(path: string, allocationBytes = 0) {
  if (!inspectNativeStorage(path, allocationBytes).allowed)
    throw new NativeStoragePending(
      "Native storage capacity unavailable; reclaim space above the 10 GiB reserve and retry"
    )
}
