import {
  coordinateRatePool,
  predictQuotaExhaustionSeconds,
  priorityRetryDelayMs,
  rateLimitTrafficLight,
  recordRatePoolUsage,
  shouldOpenPredictiveCircuit,
  shouldProceedForRateLimit
} from "@openclaw/domain"
import { describe, expect, it } from "vitest"

describe("rate limit scheduling helpers", () => {
  it("maps quota remaining into traffic-light scheduling states", () => {
    expect(rateLimitTrafficLight({ remaining: 81, limit: 100 })).toBe("green")
    expect(rateLimitTrafficLight({ remaining: 20, limit: 100 })).toBe("amber")
    expect(rateLimitTrafficLight({ remaining: 5, limit: 100 })).toBe("red")
    expect(rateLimitTrafficLight({ remaining: null, limit: 100 })).toBe("unknown")
  })

  it("allows only priority zero work through amber and blocks ordinary red traffic", () => {
    expect(shouldProceedForRateLimit({ trafficLight: "green", priority: 2 })).toBe(true)
    expect(shouldProceedForRateLimit({ trafficLight: "unknown", priority: 2 })).toBe(true)
    expect(shouldProceedForRateLimit({ trafficLight: "amber", priority: 0 })).toBe(true)
    expect(shouldProceedForRateLimit({ trafficLight: "amber", priority: 1 })).toBe(false)
    expect(shouldProceedForRateLimit({ trafficLight: "red", priority: 0 })).toBe(false)
    expect(shouldProceedForRateLimit({ trafficLight: "red", priority: 2, emergency: true })).toBe(true)
  })

  it("uses priority-specific retry windows with deterministic jitter support", () => {
    expect(priorityRetryDelayMs({ priority: 0, attempt: 0, random: () => 0 })).toBe(500)
    expect(priorityRetryDelayMs({ priority: 1, attempt: 2, random: () => 0.5 })).toBe(10_000)
    expect(priorityRetryDelayMs({ priority: 2, attempt: 8, random: () => 0 })).toBe(60_000)
  })

  it("predicts quota exhaustion from recent samples", () => {
    const samples = [
      { timestamp: 0, remaining: 100 },
      { timestamp: 10_000, remaining: 80 },
      { timestamp: 20_000, remaining: 60 }
    ]

    expect(predictQuotaExhaustionSeconds(samples)).toBe(30)
    expect(shouldOpenPredictiveCircuit({ samples, warningThresholdSeconds: 60 })).toBe(true)
    expect(shouldOpenPredictiveCircuit({ samples, warningThresholdSeconds: 10 })).toBe(false)
  })

  describe("cooperative rate pool leases (CMARP/RET)", () => {
    it("initializes a new pool if none is passed", () => {
      const now = new Date("2026-06-25T12:00:00.000Z")
      const result = coordinateRatePool({
        pool: null,
        agentName: "codex-coder",
        priority: 0,
        now,
        totalLimit: 1000
      })

      expect(result.allowed).toBe(true)
      expect(result.pool.totalLimit).toBe(1000)
      expect(result.pool.allocations["codex-coder"]).toBeDefined()
      // P0 gets 40%
      expect(result.pool.allocations["codex-coder"]?.allocated).toBe(400)
      expect(result.pool.allocations["codex-coder"]?.used).toBe(0)
    })

    it("enforces limits and handles resets", () => {
      const now = new Date("2026-06-25T12:00:00.000Z")
      const poolState = {
        totalLimit: 1000,
        resetAt: new Date(now.getTime() + 1000).toISOString(),
        allocations: {
          "codex-coder": {
            priority: 0,
            allocated: 400,
            used: 400,
            leaseExpiry: new Date(now.getTime() + 1000).toISOString()
          }
        }
      }

      // Should be blocked because used >= allocated
      const checkBlocked = coordinateRatePool({
        pool: poolState,
        agentName: "codex-coder",
        priority: 0,
        now
      })
      expect(checkBlocked.allowed).toBe(false)

      // Advance time past reset time
      const later = new Date(now.getTime() + 5000)
      const checkReset = coordinateRatePool({
        pool: poolState,
        agentName: "codex-coder",
        priority: 0,
        now: later
      })
      expect(checkReset.allowed).toBe(true)
      expect(checkReset.pool.allocations["codex-coder"]?.used).toBe(0)
    })

    it("prunes/reclaims stale leases from other agents", () => {
      const now = new Date("2026-06-25T12:00:00.000Z")
      const poolState = {
        totalLimit: 1000,
        resetAt: new Date(now.getTime() + 3600000).toISOString(),
        allocations: {
          "gemini-ui": {
            priority: 1,
            allocated: 350,
            used: 100,
            leaseExpiry: new Date(now.getTime() - 1000).toISOString() // Expired lease!
          }
        }
      }

      const result = coordinateRatePool({
        pool: poolState,
        agentName: "codex-coder",
        priority: 0,
        now
      })

      // The stale lease of gemini-ui should be set to 0 allocated
      expect(result.pool.allocations["gemini-ui"]?.allocated).toBe(0)
    })

    it("restores a reclaimed lease when the same agent returns", () => {
      const now = new Date("2026-06-25T12:00:00.000Z")
      const result = coordinateRatePool({
        pool: {
          totalLimit: 1000,
          resetAt: new Date(now.getTime() + 3_600_000).toISOString(),
          allocations: {
            "codex-coder": {
              priority: 2,
              allocated: 0,
              used: 0,
              leaseExpiry: new Date(now.getTime() - 1000).toISOString()
            }
          }
        },
        agentName: "codex-coder",
        priority: 2,
        now
      })

      expect(result.allowed).toBe(true)
      expect(result.pool.allocations["codex-coder"]?.allocated).toBe(250)
      expect(result.pool.allocations["codex-coder"]?.used).toBe(0)
    })

    it("renews an exhausted lease when the same agent is checked after expiry", () => {
      const now = new Date("2026-06-25T12:00:00.000Z")
      const result = coordinateRatePool({
        pool: {
          totalLimit: 1000,
          resetAt: new Date(now.getTime() + 3_600_000).toISOString(),
          allocations: {
            "codex-coder": {
              priority: 2,
              allocated: 250,
              used: 500,
              leaseExpiry: new Date(now.getTime() - 1000).toISOString()
            }
          }
        },
        agentName: "codex-coder",
        priority: 2,
        now
      })

      expect(result.allowed).toBe(true)
      expect(result.pool.allocations["codex-coder"]?.allocated).toBe(250)
      expect(result.pool.allocations["codex-coder"]?.used).toBe(0)
    })

    it("records token usage correctly", () => {
      const poolState = {
        totalLimit: 1000,
        resetAt: new Date().toISOString(),
        allocations: {
          "codex-coder": {
            priority: 0,
            allocated: 400,
            used: 50,
            leaseExpiry: new Date().toISOString()
          }
        }
      }

      const updated = recordRatePoolUsage(poolState, "codex-coder", 150)
      expect(updated.allocations["codex-coder"]?.used).toBe(200)
    })
  })
})
