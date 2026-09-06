export type RateLimitTrafficLight = "green" | "amber" | "red" | "unknown"

export interface RateLimitSnapshot {
  remaining: number | null
  limit: number | null
}

export interface RateLimitSample {
  timestamp: number
  remaining: number
}

export interface PriorityRetryDelayInput {
  priority: number
  attempt: number
  random?: () => number
}

const RETRY_WINDOWS_MS: Record<number, [number, number]> = {
  0: [500, 5_000],
  1: [2_000, 30_000],
  2: [5_000, 60_000]
}

export function rateLimitTrafficLight(snapshot: RateLimitSnapshot): RateLimitTrafficLight {
  const { limit, remaining } = snapshot
  if (remaining === null || limit === null || limit <= 0 || remaining < 0) return "unknown"

  const remainingRatio = remaining / limit
  if (remainingRatio > 0.2) return "green"
  if (remainingRatio > 0.05) return "amber"
  return "red"
}

export function shouldProceedForRateLimit(input: {
  trafficLight: RateLimitTrafficLight
  priority: number
  emergency?: boolean
}): boolean {
  if (input.emergency) return true
  if (input.trafficLight === "unknown" || input.trafficLight === "green") return true
  if (input.trafficLight === "amber") return input.priority <= 0
  return false
}

export function priorityRetryDelayMs(input: PriorityRetryDelayInput): number {
  const priority = Number.isFinite(input.priority) ? Math.max(0, Math.floor(input.priority)) : 2
  const attempt = Number.isFinite(input.attempt) ? Math.max(0, Math.floor(input.attempt)) : 0
  const [minDelay, maxDelay] = RETRY_WINDOWS_MS[priority] ?? [5_000, 60_000]
  const baseDelay = Math.min(minDelay * 2 ** attempt, maxDelay)
  const jitter = (input.random ?? Math.random)() * baseDelay * 0.5
  return Math.round(baseDelay + jitter)
}

export function predictQuotaExhaustionSeconds(samples: RateLimitSample[]): number | null {
  const validSamples = samples
    .filter((sample) => Number.isFinite(sample.timestamp) && Number.isFinite(sample.remaining))
    .sort((left, right) => left.timestamp - right.timestamp)

  if (validSamples.length < 3) return null

  const first = validSamples[0]
  const last = validSamples[validSamples.length - 1]
  if (!first || !last) return null

  const elapsedMs = last.timestamp - first.timestamp
  if (elapsedMs <= 0) return null

  const consumed = first.remaining - last.remaining
  if (consumed <= 0 || last.remaining <= 0) return null

  const consumedPerMs = consumed / elapsedMs
  return Math.round(last.remaining / consumedPerMs / 1000)
}

export function shouldOpenPredictiveCircuit(input: {
  samples: RateLimitSample[]
  warningThresholdSeconds?: number
}): boolean {
  const threshold = input.warningThresholdSeconds ?? 120
  const secondsUntilExhaustion = predictQuotaExhaustionSeconds(input.samples)
  return secondsUntilExhaustion !== null && secondsUntilExhaustion < threshold
}

export interface RatePoolAllocation {
  priority: number
  allocated: number
  used: number
  leaseExpiry: string // ISO date string
}

export interface RatePool {
  totalLimit: number
  resetAt: string // ISO date string
  allocations: Record<string, RatePoolAllocation>
}

function allocationForPriority(totalLimit: number, priority: number): number {
  if (priority === 0) return Math.floor(totalLimit * 0.4)
  if (priority === 1) return Math.floor(totalLimit * 0.35)
  return Math.floor(totalLimit * 0.25)
}

export function coordinateRatePool(input: {
  pool: RatePool | null | undefined
  agentName: string
  priority: number
  now: Date
  leaseDurationMs?: number
  totalLimit?: number
}): {
  pool: RatePool
  allowed: boolean
} {
  const duration = input.leaseDurationMs ?? 5 * 60 * 1000 // 5 minutes
  const totalLimit = input.totalLimit ?? 5000

  let pool: RatePool
  if (!input.pool) {
    pool = {
      totalLimit,
      resetAt: new Date(input.now.getTime() + 60 * 60 * 1000).toISOString(), // 1 hour default
      allocations: {}
    }
  } else {
    pool = JSON.parse(JSON.stringify(input.pool)) // deep copy
  }

  // Handle reset
  const resetTime = new Date(pool.resetAt)
  if (input.now >= resetTime) {
    pool.resetAt = new Date(input.now.getTime() + 60 * 60 * 1000).toISOString()
    for (const alloc of Object.values(pool.allocations)) {
      alloc.used = 0
    }
  }

  // Clean up stale leases from other agents
  for (const [name, alloc] of Object.entries(pool.allocations)) {
    if (name !== input.agentName && new Date(alloc.leaseExpiry) < input.now) {
      alloc.allocated = 0 // reclaim allocation
    }
  }

  // Ensure input.agentName has allocation
  let alloc = pool.allocations[input.agentName]
  if (!alloc) {
    alloc = {
      priority: input.priority,
      allocated: allocationForPriority(pool.totalLimit, input.priority),
      used: 0,
      leaseExpiry: new Date(input.now.getTime() + duration).toISOString()
    }
    pool.allocations[input.agentName] = alloc
  } else {
    // A stale lease may have been reclaimed by another agent, or it may be the
    // first lease checked after becoming stale. In either case, renew the
    // allocation with a fresh usage window instead of carrying an exhausted
    // counter until the unrelated hourly pool reset.
    if (alloc.allocated <= 0 || new Date(alloc.leaseExpiry) < input.now) {
      alloc.allocated = allocationForPriority(pool.totalLimit, input.priority)
      alloc.used = 0
    }
    alloc.leaseExpiry = new Date(input.now.getTime() + duration).toISOString()
    alloc.priority = input.priority
  }

  const allowed = alloc.used < alloc.allocated
  return { pool, allowed }
}

export function recordRatePoolUsage(pool: RatePool, agentName: string, tokensUsed: number): RatePool {
  const copy: RatePool = JSON.parse(JSON.stringify(pool))
  const alloc = copy.allocations[agentName]
  if (alloc) {
    alloc.used += tokensUsed
  }
  return copy
}
