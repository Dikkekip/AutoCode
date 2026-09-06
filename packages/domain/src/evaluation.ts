import type { MemoryLifecycleStatus, Task, TaskStatus } from "./types.js"
import { completionRuleForRoleResult, type OpenClawWorkflowRole } from "./workflow-transitions.js"

function workflowRoleForTask(task: Task): OpenClawWorkflowRole | null {
  if (task.kind === "review" || task.stage === "reviewer" || task.stage === "promoter") return "reviewer"
  if (task.stage === "planner" && /research|rfc|architecture|architect/i.test([task.title, ...task.labels].join(" "))) {
    return "architect"
  }
  if (task.kind === "implement" || task.kind === "fix_review_feedback" || task.kind === "repair") return "developer"
  if (/test|qa|verify|verification/i.test([task.stage ?? "", task.title, ...task.labels].join(" "))) {
    return "tester"
  }
  return null
}

export function successfulWorkflowTaskStatus(task: Task): TaskStatus | null {
  const role = workflowRoleForTask(task)
  if (!role) return null
  const result = role === "reviewer" ? "approve" : role === "tester" ? "pass" : "done"
  const transition = completionRuleForRoleResult(role, result)
  if (!transition) return null
  if (transition.to === "toReview") return task.reviewRequired ? "review_needed" : "done"
  if (transition.to === "toTest" || transition.to === "done") return "done"
  if (transition.to === "toImprove" || transition.to === "refining") return "blocked"
  return null
}

export function getSuccessfulTaskStatus(task: Task): TaskStatus {
  const workflowStatus = successfulWorkflowTaskStatus(task)
  if (workflowStatus) return workflowStatus
  return task.reviewRequired ? "review_needed" : "done"
}

export function shouldRetryTask(task: Task): boolean {
  return task.retryCount < task.maxRetries
}

export function deriveMemoryLifecycleStatus(input: {
  chunkCount: number
  missingEmbeddingCount: number
  persistedStatus?: MemoryLifecycleStatus | null
}): MemoryLifecycleStatus {
  if (input.persistedStatus) return input.persistedStatus
  if (input.chunkCount <= 0) return "not_started"
  if (input.missingEmbeddingCount > 0) return "stale"
  return "ready"
}
