import { describe, expect, it } from "vitest"

import {
  formatDailyTelegramDigest,
  formatIncidentTelegramDigest,
  type OperationalDigestSummary
} from "../packages/core-runtime/src/telegram-digest.js"

function sampleSummary(): OperationalDigestSummary {
  return {
    projectId: "project-1",
    projectName: "lawyerrag-repo",
    repoPath: "/tmp/lawyerrag",
    generatedAt: "2026-04-11T07:00:00.000Z",
    windowHours: 24,
    tasksCompleted: 4,
    tasksFailed: 2,
    recentCompletedTasks: [
      { id: "t1", title: "Ship queue refresh improvements", completedAt: "2026-04-11T06:50:00.000Z" },
      { id: "t2", title: "Tighten runtime budget reporting", completedAt: "2026-04-11T06:10:00.000Z" }
    ],
    recentFailedTasks: [
      { id: "t3", title: "Repair Telegram notification flow", completedAt: "2026-04-11T05:20:00.000Z" },
      { id: "t4", title: "Patch stale queue detector", completedAt: "2026-04-11T04:10:00.000Z" }
    ],
    topFailureReasons: [
      { reason: "Verification failed", count: 1 },
      { reason: "Telegram HTTP 401", count: 1 }
    ],
    activeQueuesByStatus: {
      queued: 3,
      running: 1,
      blocked: 1
    },
    stuckQueuesByStatus: {
      queued: 2,
      blocked: 1
    },
    modelUsage: [
      {
        adapterType: "gemini_local",
        model: "gemini-2.5-pro",
        runs: 5,
        succeeded: 4,
        failed: 1,
        totalTokens: 43_500,
        totalCostCents: 0
      },
      {
        adapterType: "codex_local",
        model: "gpt-5.5",
        runs: 2,
        succeeded: 2,
        failed: 0,
        totalTokens: 11_200,
        totalCostCents: 0
      }
    ],
    pressureSignals: [
      { severity: "warn", summary: "gemini-ui budget 8/10 daily" },
      { severity: "critical", summary: "Codex quota degraded (1/2 healthy, recommended parallel 1)" }
    ],
    notableRecoveries: [
      { label: "stale runs reaped", count: 2 },
      { label: "expired claims reclaimed", count: 1 }
    ]
  }
}

describe("Telegram digest formatting", () => {
  it("formats a concise daily digest with the required operator signals", () => {
    const message = formatDailyTelegramDigest(sampleSummary())

    expect(message).toContain("OpenClaw daily digest | lawyerrag-repo | 2026-04-11")
    expect(message).toContain("Done 4")
    expect(message).toContain("Failed 2")
    expect(message).toContain("Failure reasons: Verification failed x1; Telegram HTTP 401 x1")
    expect(message).toContain("Queue: queued 3, running 1, blocked 1")
    expect(message).toContain("Usage: gemini_local/gemini-2.5-pro 5r 44k tok, 1 failed")
    expect(message).toContain("Pressure: gemini-ui budget 8/10 daily; Codex quota degraded")
    expect(message).toContain("Recoveries: stale runs reaped x2; expired claims reclaimed x1")
    expect(message.length).toBeLessThan(800)
  })

  it("formats an incident digest that emphasizes active pressure and recent failures", () => {
    const message = formatIncidentTelegramDigest(sampleSummary(), {
      title: "delivery failing softly"
    })

    expect(message).toContain("OpenClaw incident summary | lawyerrag-repo | delivery failing softly")
    expect(message).toContain("Queue pressure: queued 3, running 1, blocked 1")
    expect(message).toContain("Stuck queues: queued 2, blocked 1")
    expect(message).toContain("Failed in last 24h: 2")
    expect(message).toContain("Budget/quota: gemini-ui budget 8/10 daily; Codex quota degraded")
    expect(message).toContain("Recent completions: Ship queue refresh improvements")
    expect(message.length).toBeLessThan(900)
  })
})
