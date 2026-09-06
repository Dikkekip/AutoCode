import type { PlannerCandidateTask, Task } from "@openclaw/domain"
import { describe, expect, it } from "vitest"

import { dedupePlannerCandidates } from "../packages/executor/src/planner/dedupe.js"

function candidate(): PlannerCandidateTask {
  return {
    title: "Prove and close one ActionGroup boundary gap",
    description: "Implement a verified shell boundary gap.",
    kind: "implement",
    lane: "ui-shell-system",
    personaId: "frontend-shell-owner",
    preferredAdapterType: "codex_local",
    priority: 58,
    requiredReading: ["apps/reports-ui/src/components/ui/ActionGroup.tsx"],
    verificationChecklist: ["pnpm test"],
    contractUpdateReminders: [],
    repoNotes: [],
    dependencies: [],
    tags: ["deterministic-fallback"],
    riskLevel: "medium",
    governanceClass: "normal",
    dedupeKey: "fallback:ui-shell-system-action-group",
    sourceSignals: ["lane_inventory:ui-shell-system"],
    estimatedCost: 0,
    createMode: "queue_now"
  }
}

function task(input: Partial<Task> = {}): Task {
  return {
    id: "existing-task",
    title: "Prove and close one ActionGroup boundary gap",
    laneId: "ui-shell-system",
    status: "failed",
    blockedReason: "superseded:planner-v0.1.0.63",
    ...input
  } as Task
}

describe("planner candidate dedupe", () => {
  it("allows an exact candidate to replace an explicitly superseded terminal task", () => {
    const existing = task()
    const [decision] = dedupePlannerCandidates({
      candidates: [candidate()],
      existingTasks: [existing],
      findExact: () => existing
    })

    expect(decision).toMatchObject({ action: "create", reason: "no duplicate found" })
  })

  it("still skips exact and active soft duplicates that were not explicitly superseded", () => {
    const exact = task({ status: "blocked", blockedReason: "verification_failed" })
    const [exactDecision] = dedupePlannerCandidates({
      candidates: [candidate()],
      existingTasks: [exact],
      findExact: () => exact
    })
    expect(exactDecision).toMatchObject({ action: "skip_duplicate", existingTaskId: exact.id })

    const soft = task({ id: "soft-task", status: "queued", blockedReason: null })
    const [softDecision] = dedupePlannerCandidates({
      candidates: [candidate()],
      existingTasks: [soft],
      findExact: () => null
    })
    expect(softDecision).toMatchObject({ action: "skip_duplicate", existingTaskId: soft.id })
  })

  it("allows a new dedupe lineage after a same-title implementation completed", () => {
    const completed = task({ id: "completed-task", status: "done", blockedReason: null })
    const [decision] = dedupePlannerCandidates({
      candidates: [candidate()],
      existingTasks: [completed],
      findExact: () => null
    })

    expect(decision).toMatchObject({ action: "create", reason: "no duplicate found" })
  })

  it("skips a same-title implementation completed inside the planner dedupe window", () => {
    const completed = task({
      id: "recently-completed-task",
      status: "done",
      blockedReason: null,
      completedAt: "2026-08-02T06:00:00.000Z"
    })
    const [decision] = dedupePlannerCandidates({
      candidates: [candidate()],
      existingTasks: [completed],
      findExact: () => null,
      dedupeWindowStartIso: "2026-08-01T06:00:00.000Z"
    })

    expect(decision).toMatchObject({
      action: "skip_duplicate",
      reason: "matched similar queued or historical task title in same lane",
      existingTaskId: completed.id
    })
  })
})
