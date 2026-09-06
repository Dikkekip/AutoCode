import { randomUUID } from "node:crypto"

import type { AdapterUsage } from "@openclaw/domain"

export type TelemetryLevel = "info" | "warn" | "error"
export type TelemetrySpanKind = "run" | "stage" | "adapter" | "memory" | "verification" | "planner"
export type TelemetrySpanStatus = "running" | "ok" | "error"
export type TelemetryPathNodeKind = "workflow" | "task" | "persona" | "agent" | "adapter" | "run"

export interface TelemetryPathNode {
  kind: TelemetryPathNodeKind
  id: string
  label: string
  metadata?: Record<string, unknown>
}

export interface TelemetryEvent {
  id: string
  spanId: string
  name: string
  level: TelemetryLevel
  message?: string
  attributes: Record<string, unknown>
  at: string
  offsetMs: number
}

export interface TelemetrySpan {
  id: string
  parentId: string | null
  name: string
  kind: TelemetrySpanKind
  status: TelemetrySpanStatus
  startedAt: string
  finishedAt: string | null
  latencyMs: number | null
  attributes: Record<string, unknown>
  usage: AdapterUsage | null
  eventIds: string[]
}

export interface ExecutionTrace {
  traceId: string
  rootSpanId: string
  runId: string
  startedAt: string
  finishedAt: string | null
  latencyMs: number | null
  status: TelemetrySpanStatus
  executionPath: TelemetryPathNode[]
  spans: TelemetrySpan[]
  events: TelemetryEvent[]
  totals: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
  }
  attributes: Record<string, unknown>
}

export interface ExecutionTraceSummary {
  traceId: string
  runId: string
  status: TelemetrySpanStatus
  totalLatencyMs: number
  totalTokens: number
  inputTokens: number
  outputTokens: number
  spanCount: number
  eventCount: number
  executionPath: string[]
  criticalPath: string[]
}

export interface CreateExecutionTraceInput {
  runId: string
  name: string
  attributes?: Record<string, unknown>
  executionPath?: TelemetryPathNode[]
}

export interface StartSpanInput {
  name: string
  kind?: TelemetrySpanKind
  attributes?: Record<string, unknown>
  parentId?: string | null
}

export interface CompleteSpanInput {
  status?: Exclude<TelemetrySpanStatus, "running">
  attributes?: Record<string, unknown>
  usage?: AdapterUsage | null
}

function nowIso(): string {
  return new Date().toISOString()
}

function elapsedMs(start: number): number {
  return Math.max(0, Date.now() - start)
}

function normalizeUsage(usage: AdapterUsage | null | undefined): AdapterUsage | null {
  if (!usage) return null
  const normalized: AdapterUsage = {}
  if (typeof usage.inputTokens === "number" && Number.isFinite(usage.inputTokens))
    normalized.inputTokens = usage.inputTokens
  if (typeof usage.outputTokens === "number" && Number.isFinite(usage.outputTokens))
    normalized.outputTokens = usage.outputTokens
  if (typeof usage.totalTokens === "number" && Number.isFinite(usage.totalTokens))
    normalized.totalTokens = usage.totalTokens
  if (typeof usage.costUnits === "number" && Number.isFinite(usage.costUnits)) normalized.costUnits = usage.costUnits
  return Object.keys(normalized).length > 0 ? normalized : null
}

function mergeUsage(left: AdapterUsage | null, right: AdapterUsage | null): AdapterUsage | null {
  if (!left && !right) return null
  const merged: AdapterUsage = {}
  const inputTokens = (left?.inputTokens ?? 0) + (right?.inputTokens ?? 0)
  const outputTokens = (left?.outputTokens ?? 0) + (right?.outputTokens ?? 0)
  const totalTokens = (left?.totalTokens ?? 0) + (right?.totalTokens ?? 0)
  const costUnits = (left?.costUnits ?? 0) + (right?.costUnits ?? 0)
  if (inputTokens > 0) merged.inputTokens = inputTokens
  if (outputTokens > 0) merged.outputTokens = outputTokens
  if (totalTokens > 0) merged.totalTokens = totalTokens
  if (costUnits > 0) merged.costUnits = costUnits
  return Object.keys(merged).length > 0 ? merged : null
}

class SpanHandle {
  constructor(
    private readonly tracer: ExecutionTracer,
    readonly id: string
  ) {}

  event(
    name: string,
    input: { level?: TelemetryLevel; message?: string; attributes?: Record<string, unknown> } = {}
  ): TelemetryEvent {
    return this.tracer.addEvent(
      {
        spanId: this.id,
        name,
        level: input.level ?? "info",
        attributes: input.attributes ?? {}
      },
      input.message
    )
  }

  annotate(attributes: Record<string, unknown>): void {
    this.tracer.annotateSpan(this.id, attributes)
  }

  recordUsage(usage: AdapterUsage | null | undefined): void {
    this.tracer.recordUsage(this.id, usage)
  }

  succeed(input: Omit<CompleteSpanInput, "status"> = {}): void {
    this.tracer.completeSpan(this.id, {
      ...input,
      status: "ok"
    })
  }

  fail(
    error: unknown,
    input: Omit<CompleteSpanInput, "status" | "attributes"> & { attributes?: Record<string, unknown> } = {}
  ): void {
    const errorMessage = error instanceof Error ? error.message : String(error)
    this.tracer.completeSpan(this.id, {
      ...input,
      status: "error",
      attributes: {
        ...(input.attributes ?? {}),
        error: errorMessage
      }
    })
  }
}

export class ExecutionTracer {
  private readonly traceId = randomUUID()
  private readonly startedAt = nowIso()
  private readonly startedMs = Date.now()
  private readonly spans = new Map<string, TelemetrySpan>()
  private readonly spanStarts = new Map<string, number>()
  private readonly events: TelemetryEvent[] = []
  private readonly rootSpanId: string
  private status: TelemetrySpanStatus = "running"
  private attributes: Record<string, unknown>
  private executionPath: TelemetryPathNode[]

  constructor(input: CreateExecutionTraceInput) {
    this.attributes = { ...(input.attributes ?? {}) }
    this.executionPath = [...(input.executionPath ?? [])]
    this.rootSpanId = this.createSpan({
      name: input.name,
      kind: "run",
      parentId: null,
      attributes: input.attributes ?? {}
    }).id
    this.attributes.traceId = this.traceId
    this.attributes.runId = input.runId
  }

  get trace(): { traceId: string; rootSpanId: string } {
    return {
      traceId: this.traceId,
      rootSpanId: this.rootSpanId
    }
  }

  root(): SpanHandle {
    return new SpanHandle(this, this.rootSpanId)
  }

  startSpan(input: StartSpanInput): SpanHandle {
    const span = this.createSpan({
      name: input.name,
      kind: input.kind ?? "stage",
      parentId: input.parentId ?? this.rootSpanId,
      attributes: input.attributes ?? {}
    })
    return new SpanHandle(this, span.id)
  }

  addEvent(
    input: {
      spanId: string
      name: string
      level: TelemetryLevel
      attributes?: Record<string, unknown>
    },
    message?: string
  ): TelemetryEvent {
    const span = this.mustGetSpan(input.spanId)
    const eventBase = {
      id: randomUUID(),
      spanId: span.id,
      name: input.name,
      level: input.level,
      attributes: { ...(input.attributes ?? {}) },
      at: nowIso(),
      offsetMs: elapsedMs(this.startedMs)
    }
    const event: TelemetryEvent = message === undefined ? eventBase : { ...eventBase, message }
    span.eventIds.push(event.id)
    this.events.push(event)
    return event
  }

  annotateSpan(spanId: string, attributes: Record<string, unknown>): void {
    const span = this.mustGetSpan(spanId)
    span.attributes = {
      ...span.attributes,
      ...attributes
    }
  }

  recordUsage(spanId: string, usage: AdapterUsage | null | undefined): void {
    const span = this.mustGetSpan(spanId)
    span.usage = mergeUsage(span.usage, normalizeUsage(usage))
  }

  completeSpan(spanId: string, input: CompleteSpanInput = {}): void {
    const span = this.mustGetSpan(spanId)
    if (span.status !== "running") return
    if (input.attributes) {
      this.annotateSpan(spanId, input.attributes)
    }
    if (input.usage) {
      this.recordUsage(spanId, input.usage)
    }
    span.finishedAt = nowIso()
    span.latencyMs = elapsedMs(this.spanStarts.get(spanId) ?? this.startedMs)
    span.status = input.status ?? "ok"
  }

  setExecutionPath(path: TelemetryPathNode[]): void {
    this.executionPath = [...path]
  }

  annotate(attributes: Record<string, unknown>): void {
    this.attributes = {
      ...this.attributes,
      ...attributes
    }
  }

  finish(
    input: { status: Exclude<TelemetrySpanStatus, "running">; attributes?: Record<string, unknown> } = { status: "ok" }
  ): ExecutionTrace {
    if (input.attributes) {
      this.annotate(input.attributes)
    }
    this.status = input.status
    this.completeSpan(this.rootSpanId, {
      status: input.status,
      attributes: input.attributes ?? {}
    })

    for (const span of this.spans.values()) {
      if (span.status === "running") {
        this.completeSpan(span.id, {
          status: input.status === "error" ? "error" : "ok"
        })
      }
    }

    const spans = Array.from(this.spans.values())
    const totals = spans.reduce(
      (acc, span) => ({
        inputTokens: acc.inputTokens + (span.usage?.inputTokens ?? 0),
        outputTokens: acc.outputTokens + (span.usage?.outputTokens ?? 0),
        totalTokens: acc.totalTokens + (span.usage?.totalTokens ?? 0)
      }),
      { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
    )

    return {
      traceId: this.traceId,
      rootSpanId: this.rootSpanId,
      runId: String(this.attributes.runId ?? ""),
      startedAt: this.startedAt,
      finishedAt: nowIso(),
      latencyMs: elapsedMs(this.startedMs),
      status: this.status,
      executionPath: [...this.executionPath],
      spans,
      events: [...this.events],
      totals,
      attributes: { ...this.attributes }
    }
  }

  private createSpan(input: {
    name: string
    kind: TelemetrySpanKind
    parentId: string | null
    attributes: Record<string, unknown>
  }): TelemetrySpan {
    const span: TelemetrySpan = {
      id: randomUUID(),
      parentId: input.parentId,
      name: input.name,
      kind: input.kind,
      status: "running",
      startedAt: nowIso(),
      finishedAt: null,
      latencyMs: null,
      attributes: { ...input.attributes },
      usage: null,
      eventIds: []
    }
    this.spans.set(span.id, span)
    this.spanStarts.set(span.id, Date.now())
    return span
  }

  private mustGetSpan(spanId: string): TelemetrySpan {
    const span = this.spans.get(spanId)
    if (!span) {
      throw new Error(`Telemetry span not found: ${spanId}`)
    }
    return span
  }
}

export function createExecutionTracer(input: CreateExecutionTraceInput): ExecutionTracer {
  return new ExecutionTracer(input)
}

export function summarizeExecutionTrace(trace: ExecutionTrace): ExecutionTraceSummary {
  const sortedSpans = [...trace.spans].sort((left, right) => (right.latencyMs ?? 0) - (left.latencyMs ?? 0))
  return {
    traceId: trace.traceId,
    runId: trace.runId,
    status: trace.status,
    totalLatencyMs: trace.latencyMs ?? 0,
    totalTokens: trace.totals.totalTokens,
    inputTokens: trace.totals.inputTokens,
    outputTokens: trace.totals.outputTokens,
    spanCount: trace.spans.length,
    eventCount: trace.events.length,
    executionPath: trace.executionPath.map((node) => `${node.kind}:${node.label}`),
    criticalPath: sortedSpans.slice(0, 4).map((span) => `${span.name}:${span.latencyMs ?? 0}ms`)
  }
}
