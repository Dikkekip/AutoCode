import { setTimeout as sleep } from "node:timers/promises"

const STATE_LIFECYCLE_CONTENTION = "another OpenClaw process owns state-lifecycle"
const NATIVE_AUTONOMY_PAUSED = "Native autonomy is paused or authorization was revoked"
const HUMAN_PROMOTION_REQUIRED = "Skill or policy changed; evaluated human promotion required"
const DEFAULT_MAX_ATTEMPTS = 15
const DEFAULT_RETRY_DELAY_MS = 7_000

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = []
  const seen = new Set<unknown>()
  let current = error
  while (current !== undefined && current !== null && !seen.has(current)) {
    chain.push(current)
    seen.add(current)
    current = current instanceof Error ? current.cause : undefined
  }
  return chain
}

export function isStateLifecycleContention(error: unknown): boolean {
  return errorChain(error).some((entry) =>
    (entry instanceof Error ? entry.message : String(entry)).includes(STATE_LIFECYCLE_CONTENTION)
  )
}

export function isNativeAutonomyPaused(error: unknown): boolean {
  return errorChain(error).some((entry) =>
    [NATIVE_AUTONOMY_PAUSED, HUMAN_PROMOTION_REQUIRED].some((message) =>
      (entry instanceof Error ? entry.message : String(entry)).includes(message)
    )
  )
}

export type ScheduledNativeDeferral = {
  advanced: 0
  created?: []
  deferred?: true
  paused?: true
  reason: "state lifecycle contention" | "paused"
}

/**
 * Scheduled control-plane ticks must not be permanently disabled by a transient
 * shared-state owner. Interactive calls still bypass this helper and fail loudly.
 */
export async function runScheduledNativeCommand<T>(
  kind: "discover" | "dispatch" | "reconcile",
  request: () => Promise<T>,
  options: {
    wait?: (milliseconds: number) => Promise<unknown>
    maxAttempts?: number
    retryDelayMs?: number
  } = {}
): Promise<T | ScheduledNativeDeferral> {
  const wait = options.wait ?? sleep
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1)
    throw new Error("Scheduled retry attempts must be positive")
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0)
    throw new Error("Scheduled retry delay must be non-negative")

  for (let attempt = 1; ; attempt++) {
    try {
      const result = await request()
      const reconcileBusy =
        kind === "discover" &&
        typeof result === "object" &&
        result !== null &&
        "reason" in result &&
        result.reason === "reconciliation already running"
      if (!reconcileBusy || attempt >= maxAttempts) return result
      await wait(retryDelayMs)
    } catch (error) {
      if (isNativeAutonomyPaused(error)) {
        return {
          advanced: 0,
          ...(kind === "discover" ? { created: [] as [] } : {}),
          paused: true,
          reason: "paused"
        }
      }
      if (!isStateLifecycleContention(error)) throw error
      if (attempt >= maxAttempts) {
        return {
          advanced: 0,
          ...(kind === "discover" ? { created: [] as [] } : {}),
          deferred: true,
          reason: "state lifecycle contention"
        }
      }
      await wait(retryDelayMs)
    }
  }
}
