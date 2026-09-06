import { createExecutionTracer, summarizeExecutionTrace } from "@openclaw/telemetry"
import { describe, expect, it } from "vitest"

describe("telemetry runtime", () => {
  it("captures spans, execution path, usage, and summary metrics", () => {
    const tracer = createExecutionTracer({
      runId: "run-123",
      name: "openclaw.run.implement",
      executionPath: [
        { kind: "workflow", id: "wf-1", label: "wf-1" },
        { kind: "task", id: "task-1", label: "Implement telemetry" },
        { kind: "agent", id: "agent-1", label: "codex" },
        { kind: "adapter", id: "codex_local", label: "codex_local" },
        { kind: "run", id: "run-123", label: "run-123" }
      ],
      attributes: {
        taskId: "task-1",
        adapterType: "codex_local"
      }
    })

    const promptSpan = tracer.startSpan({
      name: "prompt.build",
      kind: "stage"
    })
    promptSpan.event("prompt.compacted", {
      attributes: {
        selectedFiles: 3
      }
    })
    promptSpan.succeed({
      attributes: {
        compactionApplied: true
      }
    })

    const adapterSpan = tracer.startSpan({
      name: "adapter.execute",
      kind: "adapter"
    })
    adapterSpan.recordUsage({
      inputTokens: 11,
      outputTokens: 7,
      totalTokens: 18
    })
    adapterSpan.succeed()

    const trace = tracer.finish({
      status: "ok",
      attributes: {
        verificationSummary: "pnpm test"
      }
    })
    const summary = summarizeExecutionTrace(trace)

    expect(trace.status).toBe("ok")
    expect(trace.executionPath).toHaveLength(5)
    expect(trace.totals.totalTokens).toBe(18)
    expect(trace.spans.some((span) => span.name === "adapter.execute")).toBe(true)
    expect(summary).toMatchObject({
      status: "ok",
      totalTokens: 18
    })
    expect(summary.executionPath).toContain("agent:codex")
  })
})
