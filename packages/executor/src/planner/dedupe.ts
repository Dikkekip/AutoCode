import type { PlannerCandidateTask, PlannerDecision, Task } from "@openclaw/domain"

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

function blocksPlannerCandidate(task: Task): boolean {
  return !(task.status === "failed" && task.blockedReason?.startsWith("superseded:"))
}

function blocksSoftPlannerCandidate(task: Task, dedupeWindowStartIso?: string): boolean {
  if (task.status === "done") {
    if (!dedupeWindowStartIso || !task.completedAt) return false
    return task.completedAt >= dedupeWindowStartIso
  }
  return blocksPlannerCandidate(task)
}

export function dedupePlannerCandidates(input: {
  candidates: PlannerCandidateTask[]
  existingTasks: Task[]
  findExact: (dedupeKey: string) => Task | null
  dedupeWindowStartIso?: string
}): PlannerDecision[] {
  return input.candidates.map((candidate, index) => {
    const exact = input.findExact(candidate.dedupeKey)
    if (exact && blocksPlannerCandidate(exact)) {
      return {
        candidateIndex: index,
        title: candidate.title,
        dedupeKey: candidate.dedupeKey,
        action: "skip_duplicate",
        reason: "matched existing planner dedupe key",
        existingTaskId: exact.id
      }
    }

    const soft = input.existingTasks.find(
      (task) =>
        blocksSoftPlannerCandidate(task, input.dedupeWindowStartIso) &&
        task.laneId === candidate.lane &&
        normalize(task.title) === normalize(candidate.title)
    )
    if (soft) {
      return {
        candidateIndex: index,
        title: candidate.title,
        dedupeKey: candidate.dedupeKey,
        action: "skip_duplicate",
        reason: "matched similar queued or historical task title in same lane",
        existingTaskId: soft.id
      }
    }

    return {
      candidateIndex: index,
      title: candidate.title,
      dedupeKey: candidate.dedupeKey,
      action: "create",
      reason: "no duplicate found"
    }
  })
}
