import { describe, expect, it } from "vitest"
import { collectNativeOperationalDigestSummary } from "../packages/core-runtime/src/native/operational-digest.js"
import { formatDailyTelegramDigest } from "../packages/core-runtime/src/telegram-digest.js"

const now = new Date("2026-10-08T20:00:00Z")
const input = { boardId: "native", repository: "/repo", projectName: "App", now }
describe("native operational digest", () => {
  it("uses native counts and deployment receipts, distinguishing worker completion and unknown usage", async () => {
    const gateway = {
      request: async (method: string) =>
        method === "autocode.status"
          ? {
              boardId: "native",
              control: { paused: false },
              workflows: [
                {
                  id: "shipped",
                  title: "Deployed",
                  lifecycle: { state: "completed" },
                  deployedSha: "abc",
                  updatedAt: now.getTime()
                },
                {
                  id: "candidate",
                  title: "Candidate",
                  lifecycle: { state: "review_wait" },
                  candidateSha: "def",
                  updatedAt: now.getTime()
                },
                {
                  id: "old",
                  title: "Old",
                  lifecycle: { state: "completed" },
                  deployedSha: "old",
                  updatedAt: now.getTime() - 48 * 3600_000
                }
              ]
            }
          : {
              cards: [
                { status: "running" },
                { status: "review" },
                { status: "blocked" },
                { status: "done", completedAt: now.getTime() }
              ]
            }
    }
    const summary = await collectNativeOperationalDigestSummary(gateway as any, input)
    expect(summary.tasksCompleted).toBe(1)
    expect(summary.workerCompletions).toBe(1)
    expect(summary.activeQueuesByStatus).toEqual({ running: 1, review: 1, blocked: 1 })
    const message = formatDailyTelegramDigest(summary)
    expect(message).toContain("Deployed workflows 1")
    expect(message).toContain("not measured")
    expect(message).toContain("running 1")
    expect(message).toContain("review 1")
    expect(message).not.toContain("Codex quota degraded")
  })
  it("fails visibly for unavailable or partial native state", async () => {
    await expect(
      collectNativeOperationalDigestSummary(
        {
          request: async () => {
            throw new Error("unreachable")
          }
        },
        input
      )
    ).rejects.toThrow("unreachable")
    await expect(
      collectNativeOperationalDigestSummary(
        {
          request: async (method: string) =>
            method === "autocode.status" ? { boardId: "native", workflows: [] } : { cards: [], hasMore: true }
        } as any,
        input
      )
    ).rejects.toThrow("partial")
  })
})
