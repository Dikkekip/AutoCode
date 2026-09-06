export type OpenClawWorkflowRole = "developer" | "tester" | "architect" | "reviewer"
export type OpenClawWorkflowState =
  | "planning"
  | "todo"
  | "doing"
  | "toReview"
  | "reviewing"
  | "toImprove"
  | "toTest"
  | "testing"
  | "toResearch"
  | "researching"
  | "refining"
  | "done"
  | "rejected"

export type OpenClawWorkflowEvent =
  | "APPROVE"
  | "PICKUP"
  | "COMPLETE"
  | "BLOCKED"
  | "APPROVED"
  | "CHANGES_REQUESTED"
  | "MERGE_CONFLICT"
  | "PASS"
  | "FAIL"
  | "REFINE"
  | "REJECT"

export type OpenClawWorkflowAction = "detect_pr" | "merge_pr" | "git_pull" | "close_issue" | "reopen_issue"

export interface OpenClawWorkflowTransition {
  target: OpenClawWorkflowState
  actions: OpenClawWorkflowAction[]
}

export interface OpenClawWorkflowStateDefinition {
  label: string
  role?: OpenClawWorkflowRole | undefined
  terminal?: boolean | undefined
  hold?: boolean | undefined
  on?: Partial<Record<OpenClawWorkflowEvent, OpenClawWorkflowState | OpenClawWorkflowTransition>> | undefined
}

export const DEFAULT_OPENCLAW_WORKFLOW: Record<OpenClawWorkflowState, OpenClawWorkflowStateDefinition> = {
  planning: { label: "Planning", hold: true, on: { APPROVE: "todo" } },
  todo: { label: "To Do", role: "developer", on: { PICKUP: "doing" } },
  doing: {
    label: "Doing",
    role: "developer",
    on: {
      COMPLETE: { target: "toReview", actions: ["detect_pr"] },
      BLOCKED: "refining"
    }
  },
  toReview: {
    label: "To Review",
    role: "reviewer",
    on: {
      PICKUP: "reviewing",
      APPROVED: { target: "toTest", actions: ["merge_pr", "git_pull"] },
      CHANGES_REQUESTED: "toImprove",
      MERGE_CONFLICT: "toImprove"
    }
  },
  reviewing: {
    label: "Reviewing",
    role: "reviewer",
    on: {
      APPROVE: { target: "toTest", actions: ["merge_pr", "git_pull"] },
      REJECT: "toImprove",
      BLOCKED: "refining"
    }
  },
  toImprove: { label: "To Improve", role: "developer", on: { PICKUP: "doing" } },
  toTest: {
    label: "To Test",
    role: "tester",
    on: { PICKUP: "testing", APPROVE: { target: "done", actions: ["close_issue"] } }
  },
  testing: {
    label: "Testing",
    role: "tester",
    on: {
      PASS: { target: "done", actions: ["close_issue"] },
      FAIL: { target: "toImprove", actions: ["reopen_issue"] },
      REFINE: "refining",
      BLOCKED: "refining"
    }
  },
  toResearch: { label: "To Research", role: "architect", on: { PICKUP: "researching" } },
  researching: {
    label: "Researching",
    role: "architect",
    on: {
      COMPLETE: { target: "done", actions: ["close_issue"] },
      BLOCKED: "refining"
    }
  },
  refining: { label: "Refining", hold: true, on: { APPROVE: "todo" } },
  done: { label: "Done", terminal: true },
  rejected: { label: "Rejected", terminal: true }
}

export function completionResultToWorkflowEvent(result: string): OpenClawWorkflowEvent | null {
  const normalized = result.trim().toLowerCase()
  if (normalized === "done") return "COMPLETE"
  if (normalized === "pass") return "PASS"
  if (normalized === "fail") return "FAIL"
  if (normalized === "refine") return "REFINE"
  if (normalized === "blocked") return "BLOCKED"
  if (normalized === "approve" || normalized === "approved") return "APPROVE"
  if (normalized === "reject" || normalized === "rejected") return "REJECT"
  return null
}

export function resolveWorkflowTransition(
  state: OpenClawWorkflowState,
  event: OpenClawWorkflowEvent,
  workflow: Record<OpenClawWorkflowState, OpenClawWorkflowStateDefinition> = DEFAULT_OPENCLAW_WORKFLOW
): OpenClawWorkflowTransition | null {
  const transition = workflow[state]?.on?.[event]
  if (!transition) return null
  if (typeof transition === "string") return { target: transition, actions: [] }
  return transition
}

export function completionRuleForRoleResult(
  role: OpenClawWorkflowRole,
  result: string,
  workflow: Record<OpenClawWorkflowState, OpenClawWorkflowStateDefinition> = DEFAULT_OPENCLAW_WORKFLOW
): { from: OpenClawWorkflowState; to: OpenClawWorkflowState; actions: OpenClawWorkflowAction[] } | null {
  const event = completionResultToWorkflowEvent(result)
  if (!event) return null
  const activeState = (
    Object.entries(workflow) as Array<[OpenClawWorkflowState, OpenClawWorkflowStateDefinition]>
  ).find(([, definition]) => definition.role === role && !definition.terminal && definition.on?.[event])?.[0]
  if (!activeState) return null
  const transition = resolveWorkflowTransition(activeState, event, workflow)
  return transition ? { from: activeState, to: transition.target, actions: transition.actions } : null
}
