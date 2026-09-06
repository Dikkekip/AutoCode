import type {
  AgentConversationLane,
  AgentTimelineEntry,
  PaperclipTranscriptEntryLike,
  PaperclipTranscriptMeta,
  ToolTimelineEntry
} from "./types.js"
import { compactWhitespace, formatUnknown, summarizeToolInput, toneForStatus, truncate } from "./utils.js"

function getToolUseId(entry: PaperclipTranscriptEntryLike, index: number): string {
  return entry.toolUseId ?? entry.tool_use_id ?? `tool-${index}`
}

function appendContent(entries: AgentTimelineEntry[], next: AgentTimelineEntry) {
  const last = entries[entries.length - 1]
  if (!last) {
    entries.push(next)
    return
  }

  if (
    last.kind === "message" &&
    next.kind === "message" &&
    last.role === next.role &&
    last.agentId === next.agentId &&
    last.streaming &&
    next.streaming
  ) {
    last.content += next.content
    last.ts = next.ts ?? last.ts
    return
  }

  if (
    last.kind === "thinking" &&
    next.kind === "thinking" &&
    last.agentId === next.agentId &&
    last.streaming &&
    next.streaming
  ) {
    last.content += next.content
    last.ts = next.ts ?? last.ts
    return
  }

  entries.push(next)
}

export function normalizePaperclipTranscript(
  entries: readonly PaperclipTranscriptEntryLike[],
  meta: PaperclipTranscriptMeta
): AgentConversationLane {
  const timeline: AgentTimelineEntry[] = []
  const toolEntries = new Map<string, ToolTimelineEntry>()

  entries.forEach((entry, index) => {
    const idBase = `${meta.agentId}-${index}`
    const ts = entry.ts

    switch (entry.kind) {
      case "assistant":
      case "user":
      case "system":
      case "stderr":
      case "stdout":
      case "result": {
        const role =
          entry.kind === "assistant" || entry.kind === "user" || entry.kind === "system" ? entry.kind : "system"
        const content = entry.text ?? ""
        if (!content.trim()) return
        appendContent(timeline, {
          kind: "message",
          id: idBase,
          ts,
          role,
          content,
          streaming: Boolean(entry.delta),
          agentId: meta.agentId,
          agentName: meta.agentName
        })
        return
      }
      case "thinking": {
        const content = entry.text ?? ""
        if (!content.trim()) return
        appendContent(timeline, {
          kind: "thinking",
          id: idBase,
          ts,
          content,
          streaming: Boolean(entry.delta),
          agentId: meta.agentId,
          agentName: meta.agentName
        })
        return
      }
      case "tool_call": {
        const toolId = getToolUseId(entry, index)
        const toolEntry: ToolTimelineEntry = {
          kind: "tool",
          id: toolId,
          ts,
          name: entry.name ?? "tool",
          summary: summarizeToolInput(entry.input),
          input: formatUnknown(entry.input),
          status: "running",
          agentId: meta.agentId,
          agentName: meta.agentName
        }
        toolEntries.set(toolId, toolEntry)
        timeline.push(toolEntry)
        return
      }
      case "tool_result": {
        const toolId = getToolUseId(entry, index)
        const target = toolEntries.get(toolId)
        const status = entry.isError ? "error" : "completed"
        if (target) {
          target.result = entry.content ?? ""
          target.endTs = ts
          target.status = status
          return
        }
        timeline.push({
          kind: "tool",
          id: toolId,
          ts,
          endTs: ts,
          name: "tool",
          result: entry.content ?? "",
          status,
          agentId: meta.agentId,
          agentName: meta.agentName
        })
        return
      }
      case "activity": {
        timeline.push({
          kind: "transition",
          id: idBase,
          ts,
          label: entry.name ?? "Activity",
          toState: entry.status ?? "running",
          tone: toneForStatus(entry.status),
          agentId: meta.agentId,
          agentName: meta.agentName
        })
        return
      }
      default: {
        const text = entry.text ?? ""
        if (!text.trim()) return
        timeline.push({
          kind: "transition",
          id: idBase,
          ts,
          label: truncate(compactWhitespace(text), 72),
          detail: formatUnknown(entry),
          tone: toneForStatus(entry.status ?? entry.subtype),
          agentId: meta.agentId,
          agentName: meta.agentName
        })
      }
    }
  })

  const lastTimestamp = [...timeline].reverse().find((entry) => entry.ts)?.ts
  return {
    id: meta.agentId,
    name: meta.agentName,
    role: meta.role,
    model: meta.model,
    issueLabel: meta.issueLabel,
    status: meta.status ?? "running",
    startedAt: meta.startedAt,
    updatedAt: meta.updatedAt ?? lastTimestamp,
    entries: timeline
  }
}
