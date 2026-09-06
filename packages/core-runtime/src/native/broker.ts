// New: narrow authorization for host-supplied OpenClaw plugin tool factory context.
// Public context source: openclaw/openclaw v2026.9.1 src/plugins/tool-types.ts.
import { nativeCards } from "./gateway.js"
import type { NativeAutonomyRuntime } from "./runtime.js"

export interface NativeTrustedToolContext {
  agentId?: string
  sessionKey?: string
  sessionId?: string
  sandboxed?: boolean
}
const research = new Set(["autocode_inspect", "autocode_propose", "autocode_investigation_finish"])
const planning = new Set(["autocode_proposals", "autocode_admit", "autocode_defer"])
/** Call only with the factory closure's context, never deserialized RPC parameters. */
export async function authorizeNativeTool(
  runtime: NativeAutonomyRuntime,
  name: string,
  args: Record<string, any>,
  context: NativeTrustedToolContext
): Promise<void> {
  const deny = (reason: string): never => {
    runtime.store.event("tool.denied", runtime.policy.boardId, { tool: name, reason })
    throw new Error(`Native tool denied: ${reason}`)
  }
  if (
    !context ||
    typeof context.agentId !== "string" ||
    !context.agentId ||
    typeof context.sessionKey !== "string" ||
    !context.sessionKey
  )
    deny("trusted agent and session identity required")
  if (args.boardId !== runtime.policy.boardId) deny("board does not match assigned authority")
  const agentId = context.agentId!
  const policy = runtime.policy
  if (planning.has(name) && agentId !== policy.plannerAgentId) deny("assigned planner required")
  if (name === "autocode_submit" && agentId !== policy.coderAgentId) deny("assigned coder required")
  if (
    ["autocode_review", "autocode_design_review"].includes(name) &&
    (agentId !== policy.reviewerAgentId || agentId === policy.coderAgentId)
  )
    deny("independent reviewer required")
  if (research.has(name) && !policy.personas.some((p) => (p.investigationAgentId ?? p.personaId) === agentId))
    deny("assigned research agent required")
  if (
    ![
      ...research,
      ...planning,
      "autocode_context",
      "autocode_submit",
      "autocode_review",
      "autocode_design_review"
    ].includes(name)
  )
    deny("tool is outside agent authority")
  const cards = await nativeCards(runtime.gateway, policy.boardId)
  const assigned = cards.filter(
    (card) =>
      card.agentId === agentId &&
      card.status === "running" &&
      (card.sessionKey ?? card.execution?.sessionKey) === context.sessionKey &&
      (!card.execution?.status || card.execution.status === "running") &&
      (!card.sessionKey || !card.execution?.sessionKey || card.sessionKey === card.execution.sessionKey)
  )
  if (assigned.length !== 1) deny("one active assigned card and current execution session required")
  const card = assigned[0]!
  let targetCardId: string | undefined
  if (name === "autocode_context") {
    const record = runtime.store.get<{ cardId: string; agentId: string }>("card-context", args.contextId)
    if (record?.agentId === agentId) targetCardId = record.cardId
  } else if (research.has(name)) {
    const personaId = name === "autocode_propose" ? args.proposal?.personaId : args.personaId
    const entry = runtime.store.get<{ cardId: string; agentId: string }>(
      "investigation",
      `${args.roundId}:${personaId}`
    )
    if (entry?.agentId === agentId) targetCardId = entry.cardId
    // Legacy rounds also journal their owned card IDs; never authorize by caller identity alone.
    if (!entry && !policy.quality) {
      const round = runtime.store.get<{ cards: string[] }>("round", args.roundId)
      if (round?.cards.includes(card.id)) targetCardId = card.id
    }
  } else if (planning.has(name)) {
    const roundId =
      name === "autocode_proposals"
        ? args.roundId
        : runtime.store.get<{ roundId: string }>("proposal", args.proposalId)?.roundId
    if (roundId) {
      const round = runtime.store.get<{ cards: string[] }>("round", roundId)
      if (round?.cards.includes(card.id)) targetCardId = card.id
    }
  } else {
    const workflow = runtime.store.get<{ implementationCardId: string; reviewCardId?: string; designCardId?: string }>(
      "workflow",
      args.workflowId
    )
    targetCardId =
      name === "autocode_submit"
        ? workflow?.implementationCardId
        : name === "autocode_review"
          ? workflow?.reviewCardId
          : workflow?.designCardId
  }
  if (!targetCardId || targetCardId !== card.id) deny("requested evidence or workflow is not assigned to this card")
}

/** Resolve the board from live assignment before considering a caller's board selector. */
export async function resolveNativeToolRuntime(
  runtimes: Iterable<NativeAutonomyRuntime>,
  context: NativeTrustedToolContext
): Promise<NativeAutonomyRuntime> {
  const candidates = [...runtimes]
  const denied = () => {
    for (const runtime of candidates)
      runtime.store.event("tool.denied", runtime.policy.boardId, {
        reason: "missing or ambiguous live board assignment"
      })
    throw new Error("Native tool denied: one active assigned board and trusted session required")
  }
  if (!context?.agentId || !context.sessionKey) return denied()
  const matches: NativeAutonomyRuntime[] = []
  for (const runtime of candidates) {
    const cards = await nativeCards(runtime.gateway, runtime.policy.boardId)
    if (
      cards.some(
        (card) =>
          card.status === "running" &&
          card.agentId === context.agentId &&
          (card.sessionKey ?? card.execution?.sessionKey) === context.sessionKey
      )
    )
      matches.push(runtime)
  }
  return matches.length === 1 ? matches[0]! : denied()
}
