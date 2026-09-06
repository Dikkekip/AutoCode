import type { DispatcherStore } from "@openclaw/db"
import type { AdapterExecutionResult, Run, RunEvent } from "@openclaw/domain"

export type AgentLoopStream = "lifecycle" | "assistant" | "tool"
export type AgentLoopLifecyclePhase = "start" | "end" | "error"
export type AgentLoopToolPhase = "start" | "update" | "end" | "error"

export type AgentLoopEvent = {
  version: 1
  runId: string
  stream: AgentLoopStream
  emittedAt: string
  phase?: AgentLoopLifecyclePhase | AgentLoopToolPhase
  payload: Record<string, unknown>
}

export type AgentRunWaitStatus = "ok" | "error" | "timeout"

export type AgentRunWaitResult = {
  status: AgentRunWaitStatus
  runId: string
  startedAt: string | null
  endedAt: string | null
  error?: string
}

const DEFAULT_AGENT_WAIT_TIMEOUT_MS = 30_000
const DEFAULT_AGENT_WAIT_POLL_MS = 250
const STREAM_TEXT_LIMIT = 16_000

function nowIso(): string {
  return new Date().toISOString()
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function boundedPositiveInt(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

function sanitizeStreamText(text: string): { text: string; truncated: boolean; originalLength: number } {
  if (text.length <= STREAM_TEXT_LIMIT) {
    return { text, truncated: false, originalLength: text.length }
  }

  return {
    text: text.slice(0, STREAM_TEXT_LIMIT),
    truncated: true,
    originalLength: text.length
  }
}

function appendAgentLoopEvent(
  store: DispatcherStore,
  runId: string,
  level: RunEvent["level"],
  message: string,
  stream: AgentLoopStream,
  payload: Record<string, unknown>,
  phase?: AgentLoopLifecyclePhase | AgentLoopToolPhase
): RunEvent {
  const event: AgentLoopEvent = {
    version: 1,
    runId,
    stream,
    emittedAt: nowIso(),
    payload
  }
  if (phase) event.phase = phase
  return store.appendRunEvent(runId, level, message, { agentLoop: event })
}

export function emitAgentLoopLifecycle(
  store: DispatcherStore,
  runId: string,
  phase: AgentLoopLifecyclePhase,
  payload: Record<string, unknown> = {}
): RunEvent {
  const level: RunEvent["level"] = phase === "error" ? "error" : "info"
  return appendAgentLoopEvent(store, runId, level, `agent.loop.lifecycle.${phase}`, "lifecycle", payload, phase)
}

export function emitAgentLoopTool(
  store: DispatcherStore,
  runId: string,
  phase: AgentLoopToolPhase,
  payload: Record<string, unknown> = {}
): RunEvent {
  const level: RunEvent["level"] = phase === "error" ? "error" : phase === "update" ? "info" : "info"
  return appendAgentLoopEvent(store, runId, level, `agent.loop.tool.${phase}`, "tool", payload, phase)
}

export function emitAgentLoopAssistantDelta(
  store: DispatcherStore,
  runId: string,
  text: string,
  payload: Record<string, unknown> = {}
): RunEvent {
  const sanitized = sanitizeStreamText(text)
  return appendAgentLoopEvent(store, runId, "info", "agent.loop.assistant.delta", "assistant", {
    ...payload,
    delta: sanitized.text,
    truncated: sanitized.truncated,
    originalLength: sanitized.originalLength
  })
}

export function emitAgentLoopTerminalFromRun(
  store: DispatcherStore,
  run: Run,
  payload: Record<string, unknown> = {}
): RunEvent | null {
  if (run.status === "running") return null

  const phase: AgentLoopLifecyclePhase = run.status === "succeeded" ? "end" : "error"
  return emitAgentLoopLifecycle(store, run.id, phase, {
    status: run.status,
    startedAt: run.startedAt,
    endedAt: run.finishedAt,
    error: run.errorText,
    sessionDisplayId: run.sessionDisplayId,
    usage: run.usage,
    ...payload
  })
}

export function summarizeAdapterResult(result: AdapterExecutionResult): Record<string, unknown> {
  return {
    ok: result.ok,
    provider: result.metadata?.provider ?? null,
    model: result.metadata?.model ?? null,
    transport: result.metadata?.transport ?? null,
    sessionDisplayId: result.sessionDisplayId ?? null,
    failureCategory: result.failureCategory ?? null,
    error: result.error ?? null,
    usage: result.usage ?? null,
    responseLength: result.response.length
  }
}

export function readAgentLoopEvents(store: DispatcherStore, runId: string): AgentLoopEvent[] {
  return store.getRunEvents(runId).flatMap((event) => {
    const envelope = event.data?.agentLoop
    if (!envelope || typeof envelope !== "object") return []
    const candidate = envelope as Partial<AgentLoopEvent>
    if (candidate.version !== 1 || candidate.runId !== runId || typeof candidate.stream !== "string") return []
    return [candidate as AgentLoopEvent]
  })
}

export function readAgentLoopOwnerPid(store: DispatcherStore, runId: string): number | null {
  const ownerPid = readAgentLoopEvents(store, runId).find(
    (event) => event.stream === "lifecycle" && event.phase === "start" && Number.isInteger(event.payload.ownerPid)
  )?.payload.ownerPid
  return typeof ownerPid === "number" && ownerPid > 0 ? ownerPid : null
}

export function ownerProcessIsAlive(pid: number): boolean {
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function waitForAgentRun(
  store: DispatcherStore,
  runId: string,
  options: { timeoutMs?: number; pollMs?: number } = {}
): Promise<AgentRunWaitResult> {
  const timeoutMs = boundedPositiveInt(options.timeoutMs, DEFAULT_AGENT_WAIT_TIMEOUT_MS)
  const pollMs = boundedPositiveInt(options.pollMs, DEFAULT_AGENT_WAIT_POLL_MS)
  const deadline = Date.now() + timeoutMs
  let lastRun: Run | null = null

  while (Date.now() <= deadline) {
    try {
      lastRun = store.getRunById(runId)
    } catch (error) {
      return {
        status: "error",
        runId,
        startedAt: null,
        endedAt: null,
        error: error instanceof Error ? error.message : String(error)
      }
    }

    if (lastRun.status !== "running") {
      return {
        status: lastRun.status === "succeeded" ? "ok" : "error",
        runId,
        startedAt: lastRun.startedAt,
        endedAt: lastRun.finishedAt,
        ...(lastRun.errorText ? { error: lastRun.errorText } : {})
      }
    }

    await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())))
  }

  return {
    status: "timeout",
    runId,
    startedAt: lastRun?.startedAt ?? null,
    endedAt: lastRun?.finishedAt ?? null
  }
}
