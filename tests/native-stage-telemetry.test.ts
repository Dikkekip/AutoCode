import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { NativeEvidenceStore } from "../packages/core-runtime/src/native/store.js"
import { nativeTraceReport, withNativeStageTrace } from "../packages/core-runtime/src/native/telemetry.js"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
it("stitches redacted stage segments across restart and preserves failed attempts", async () => {
  const root = mkdtempSync(join(tmpdir(), "native-trace-"))
  roots.push(root)
  const path = join(root, "evidence.db")
  const context = {
    boardId: "board",
    workflowId: "workflow",
    attemptId: "attempt-0",
    stage: "verification" as const,
    policyDigest: "digest",
    sessionId: "PRIVATE_SESSION"
  }
  let store = new NativeEvidenceStore(path)
  try {
    await expect(
      withNativeStageTrace(store, context, async () => {
        throw new Error("PRIVATE_COMMAND_OUTPUT")
      })
    ).rejects.toThrow("PRIVATE_COMMAND_OUTPUT")
  } finally {
    store.close()
  }
  store = new NativeEvidenceStore(path)
  try {
    await withNativeStageTrace(store, { ...context, attemptId: "attempt-1", stage: "review" }, async () => true)
    const traces = store.db
      .prepare("SELECT data FROM native_events WHERE kind='native.trace' ORDER BY id")
      .all()
      .map((row) => JSON.parse(String(row.data)))
    expect(traces).toHaveLength(4)
    expect(new Set(traces.map((t) => t.workflowTraceId)).size).toBe(1)
    expect(new Set(traces.map((t) => t.attemptTraceId)).size).toBe(2)
    expect(traces.filter((t) => t.phase === "completed").map((t) => t.outcome)).toEqual(["error", "ok"])
    expect(traces[1].trace.spans[0].parentId).toBeNull()
    expect(JSON.stringify(traces)).not.toMatch(/PRIVATE_SESSION|PRIVATE_COMMAND_OUTPUT/)
    const report = nativeTraceReport(store, "board", "workflow")
    expect(report.segments).toHaveLength(2)
    expect(report.segments.every((s) => s.attemptParentId === report.workflowTraceId)).toBe(true)
  } finally {
    store.close()
  }
})
it("telemetry storage failure never retries, swallows, or changes the owned action", async () => {
  const action = vi.fn(async () => 42)
  const broken = {
    event: () => {
      throw new Error("storage unavailable")
    }
  } as unknown as NativeEvidenceStore
  expect(
    await withNativeStageTrace(
      broken,
      { boardId: "b", workflowId: "w", attemptId: "a", stage: "merge", policyDigest: "p" },
      action
    )
  ).toBe(42)
  expect(action).toHaveBeenCalledOnce()
})
