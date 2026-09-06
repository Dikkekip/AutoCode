import type {
  AgentConversationLane,
  AgentTimelineEntry,
  NormalizeSquadStateInput,
  ParallelAgentConsoleData,
  SquadAgentSessionLike,
  TransitionTimelineEntry
} from "./types.js"
import { toIsoString, toneForStatus, truncate } from "./utils.js"

function ensureLane(
  lanes: Map<string, AgentConversationLane>,
  session: Pick<AgentConversationLane, "id" | "name" | "status"> & Partial<AgentConversationLane>
) {
  const existing = lanes.get(session.id)
  if (existing) {
    existing.role = session.role ?? existing.role
    existing.model = session.model ?? existing.model
    existing.activityHint = session.activityHint ?? existing.activityHint
    existing.startedAt = session.startedAt ?? existing.startedAt
    existing.updatedAt = session.updatedAt ?? existing.updatedAt
    existing.status = session.status ?? existing.status
    return existing
  }

  const created: AgentConversationLane = {
    id: session.id,
    name: session.name,
    role: session.role,
    model: session.model,
    activityHint: session.activityHint,
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    status: session.status,
    entries: []
  }
  lanes.set(session.id, created)
  return created
}

function laneIdForAgent(name: string | undefined): string {
  if (!name) return "__session__"
  return name.toLowerCase().replace(/\s+/g, "-")
}

function mapSessionStatus(status: SquadAgentSessionLike["status"]): AgentConversationLane["status"] {
  switch (status) {
    case "working":
      return "running"
    case "streaming":
      return "streaming"
    case "error":
      return "error"
    default:
      return "idle"
  }
}

function summarizePayload(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined
  const record = payload as Record<string, unknown>
  const interesting = [record.reason, record.error, record.strategy, record.resultType, record.toolName]
  for (const candidate of interesting) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate
    }
  }
  return undefined
}

export function normalizeSquadState(input: NormalizeSquadStateInput): ParallelAgentConsoleData {
  const lanes = new Map<string, AgentConversationLane>()
  const transitions: TransitionTimelineEntry[] = []

  ensureLane(lanes, {
    id: "__session__",
    name: "Session",
    status: "idle",
    role: "Coordinator"
  })

  for (const session of input.sessions ?? []) {
    ensureLane(lanes, {
      id: laneIdForAgent(session.name),
      name: session.name,
      role: session.role,
      model: session.model,
      activityHint: session.activityHint,
      status: mapSessionStatus(session.status),
      startedAt: toIsoString(session.startedAt),
      updatedAt: toIsoString(session.startedAt)
    })
  }

  ;(input.messages ?? []).forEach((message, index) => {
    const lane = ensureLane(lanes, {
      id: laneIdForAgent(message.agentName),
      name: message.agentName ?? "Session",
      status: message.agentName ? "running" : "idle",
      role: message.agentName ? undefined : "Coordinator"
    })

    const entry: AgentTimelineEntry = {
      kind: "message",
      id: `message-${index}`,
      ts: toIsoString(message.timestamp),
      role: message.role === "agent" ? "assistant" : message.role,
      content: message.content,
      agentId: lane.id,
      agentName: lane.name
    }
    lane.entries.push(entry)
    lane.updatedAt = entry.ts ?? lane.updatedAt
  })

  ;(input.reasoning ?? []).forEach((delta, index) => {
    const lane = ensureLane(lanes, {
      id: laneIdForAgent(delta.agentName),
      name: delta.agentName ?? "Session",
      status: "streaming"
    })
    const last = lane.entries[lane.entries.length - 1]
    if (last?.kind === "thinking") {
      last.content += delta.content
      last.streaming = true
      last.ts = toIsoString(delta.timestamp) ?? last.ts
    } else {
      lane.entries.push({
        kind: "thinking",
        id: `reasoning-${index}`,
        ts: toIsoString(delta.timestamp),
        content: delta.content,
        streaming: true,
        agentId: lane.id,
        agentName: lane.name
      })
    }
    lane.updatedAt = toIsoString(delta.timestamp) ?? lane.updatedAt
  })

  ;(input.events ?? []).forEach((event, index) => {
    const lane = ensureLane(lanes, {
      id: laneIdForAgent(event.agentName),
      name: event.agentName ?? "Session",
      status: event.agentName ? "running" : "idle"
    })

    const payload = event.payload as Record<string, unknown> | undefined
    const transition: TransitionTimelineEntry = {
      kind: "transition",
      id: `transition-${index}`,
      ts: toIsoString(event.timestamp),
      label: event.type.replace(/[:.]/g, " "),
      detail: summarizePayload(event.payload),
      tone: toneForStatus(
        typeof payload?.["resultType"] === "string"
          ? payload["resultType"]
          : typeof payload?.["phase"] === "string"
            ? payload["phase"]
            : event.type.includes("error")
              ? "error"
              : undefined
      ),
      agentId: lane.id,
      agentName: lane.name
    }

    if (event.type === "session:created") {
      transition.fromState = "pending"
      transition.toState = "created"
    } else if (event.type === "session:idle") {
      transition.fromState = "running"
      transition.toState = "idle"
    } else if (event.type === "session:error") {
      transition.fromState = "running"
      transition.toState = "error"
    } else if (event.type === "session:destroyed") {
      transition.fromState = "idle"
      transition.toState = "destroyed"
    } else if (event.type === "coordinator:routing" && typeof payload?.["phase"] === "string") {
      transition.toState = String(payload["phase"])
      transition.label = `Routing ${payload["phase"]}`
    } else if (event.type === "session:tool_call") {
      transition.label = `Tool ${typeof payload?.["toolName"] === "string" ? payload["toolName"] : "call"}`
      transition.toState = typeof payload?.["resultType"] === "string" ? String(payload["resultType"]) : "running"
    } else if (event.type === "pool:health") {
      const activeSessions = typeof payload?.["activeSessions"] === "number" ? payload["activeSessions"] : undefined
      const availableSlots = typeof payload?.["availableSlots"] === "number" ? payload["availableSlots"] : undefined
      transition.label = "Pool health"
      transition.detail = truncate(
        `active=${activeSessions ?? "unknown"} available=${availableSlots ?? "unknown"}`,
        120
      )
    }

    lane.entries.push(transition)
    lane.updatedAt = transition.ts ?? lane.updatedAt
    transitions.push(transition)
  })

  return {
    agents: [...lanes.values()].sort((left, right) => {
      const leftTime = left.updatedAt ? new Date(left.updatedAt).getTime() : 0
      const rightTime = right.updatedAt ? new Date(right.updatedAt).getTime() : 0
      return rightTime - leftTime
    }),
    transitions: transitions.sort((left, right) => {
      const leftTime = left.ts ? new Date(left.ts).getTime() : 0
      const rightTime = right.ts ? new Date(right.ts).getTime() : 0
      return leftTime - rightTime
    })
  }
}
