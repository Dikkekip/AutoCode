// New: best-effort stage telemetry. This module never authorizes, retries, or schedules work.
import { createHash, randomUUID } from "node:crypto"
import { createExecutionTracer } from "@openclaw/telemetry"
import type { NativeEvidenceStore } from "./store.js"
export type NativeTraceStage =
  | "discovery"
  | "admission"
  | "implementation"
  | "verification"
  | "review"
  | "repair"
  | "merge"
  | "deployment"
  | "reconciliation"
  | "rollback"
  | "design"
export interface NativeTraceContext {
  boardId: string
  workflowId: string
  attemptId: string
  stage: NativeTraceStage
  policyDigest: string
  cardId?: string
  sessionId?: string
  runId?: string
  operationId?: string
}
export const nativeTraceIdentity = (value: string) => createHash("sha256").update(value).digest("hex")
export function nativePolicyTraceDigest(policy: unknown): string {
  return nativeTraceIdentity(JSON.stringify(policy))
}
export async function withNativeStageTrace<T>(
  store: NativeEvidenceStore,
  context: NativeTraceContext,
  action: () => Promise<T>
): Promise<T> {
  const correlation = Object.fromEntries(
    ["boardId", "workflowId", "attemptId", "cardId", "sessionId", "runId", "operationId"].flatMap((key) => {
      const value = context[key as keyof NativeTraceContext]
      return value ? [[key, nativeTraceIdentity(value)]] : []
    })
  )
  const workflowTraceId = nativeTraceIdentity(`${context.boardId}:${context.workflowId}`)
  const attemptTraceId = nativeTraceIdentity(`${workflowTraceId}:${context.attemptId}`)
  const segmentId = randomUUID()
  const startedAt = Date.now()
  const metadata = {
    version: 1,
    workflowTraceId,
    attemptTraceId,
    segmentId,
    stage: context.stage,
    policyDigest: context.policyDigest,
    usageStatus: "unknown",
    correlation
  }
  let tracer: ReturnType<typeof createExecutionTracer> | undefined
  const write = (value: Record<string, unknown>) => {
    try {
      store.event("native.trace", workflowTraceId, { ...metadata, ...value })
    } catch {
      /* Workflow authority is independent of telemetry availability. */
    }
  }
  try {
    tracer = createExecutionTracer({ runId: segmentId, name: `native.${context.stage}`, attributes: metadata })
  } catch {
    /* Optional telemetry backend. */
  }
  const finish = (status: "ok" | "error") => {
    try {
      return tracer?.finish({ status })
    } catch {
      return undefined
    }
  }
  write({ phase: "started", startedAt })
  try {
    const result = await action()
    write({
      phase: "completed",
      startedAt,
      finishedAt: Date.now(),
      durationMs: Math.max(0, Date.now() - startedAt),
      outcome: "ok",
      trace: finish("ok")
    })
    return result
  } catch (error) {
    // Never include exception messages: command output and repository text may contain secrets.
    write({
      phase: "completed",
      startedAt,
      finishedAt: Date.now(),
      durationMs: Math.max(0, Date.now() - startedAt),
      outcome: "error",
      trace: finish("error")
    })
    throw error
  }
}

/** Read-only reconstruction. Started segments without confirmation remain unknown after a crash. */
export function nativeTraceReport(store: NativeEvidenceStore, boardId: string, workflowId: string) {
  const workflowTraceId = nativeTraceIdentity(`${boardId}:${workflowId}`)
  const rows = store.db
    .prepare("SELECT id,data FROM native_events WHERE kind='native.trace' AND subject=? ORDER BY id")
    .all(workflowTraceId)
  const segments = new Map<string, Record<string, any>>()
  for (const row of rows) {
    const event = JSON.parse(String(row.data))
    if (event.version !== 1 || typeof event.segmentId !== "string") throw new Error("Unsupported native trace record")
    segments.set(event.segmentId, { ...segments.get(event.segmentId), ...event, lastEventId: Number(row.id) })
  }
  return {
    version: 1,
    workflowTraceId,
    segments: [...segments.values()].map((segment) => ({
      ...segment,
      parentId: segment.attemptTraceId,
      attemptParentId: workflowTraceId,
      outcome: segment.phase === "completed" ? segment.outcome : "unknown"
    }))
  }
}
