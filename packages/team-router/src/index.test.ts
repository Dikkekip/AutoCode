import { describe, expect, it } from "vitest"

import {
  ConflictTracker,
  type DelegationTask,
  delegationTaskFromPlanSubtask,
  PeerMessageBus,
  SwarmOrchestrator,
  type TeamAgentProfile,
  TeamEventBus,
  TeamRouter
} from "./index.js"

function agent(id: string, patch: Partial<TeamAgentProfile> = {}): TeamAgentProfile {
  return {
    id,
    name: id,
    role: "Engineer",
    status: "idle",
    capabilities: [],
    lanes: [],
    ...patch
  }
}

function task(id: string, patch: Partial<DelegationTask> = {}): DelegationTask {
  return {
    id,
    title: id,
    summary: `${id} summary`,
    kind: "implement",
    priority: 0,
    requiredCapabilities: [],
    preferredLanes: [],
    dependsOn: [],
    artifactPaths: [],
    ...patch
  }
}

describe("PeerMessageBus", () => {
  it("posts mailbox messages and emits lifecycle events", async () => {
    const events = new TeamEventBus()
    const seen: string[] = []
    events.subscribe("message:posted", (event) => {
      seen.push(`posted:${event.payload.id}`)
    })
    events.subscribe("message:acknowledged", (event) => {
      seen.push(`ack:${event.payload.id}`)
    })

    const bus = new PeerMessageBus(events, () => new Date("2026-04-12T08:00:00.000Z"))
    const message = await bus.postMessage({
      fromAgentId: "planner",
      toAgentId: "backend",
      kind: "handoff",
      subject: "Need API help",
      body: "Take over the auth route",
      taskId: "task-1",
      artifactPaths: ["src/auth.ts"]
    })

    expect(bus.listInbox("backend")).toHaveLength(1)
    expect(message.threadId).toBeTruthy()

    const acknowledged = await bus.acknowledgeMessage(message.id, "backend")
    expect(acknowledged.acknowledgedAt).toBe("2026-04-12T08:00:00.000Z")
    expect(seen).toEqual([`posted:${message.id}`, `ack:${message.id}`])
  })
})

describe("ConflictTracker + TeamRouter", () => {
  it("normalizes glob roots and blocks overlapping claims from the same agent", () => {
    const conflicts = new ConflictTracker()
    conflicts.claimArtifacts({
      assignmentId: "assignment-1",
      taskId: "task-1",
      agentId: "backend",
      artifactPaths: ["packages/db/**"]
    })

    const decision = new TeamRouter(conflicts).routeTask(
      task("task-2", {
        artifactPaths: ["packages/db/src/store.ts"],
        preferredAssigneeId: "backend"
      }),
      [agent("backend", { maxParallelAssignments: 2 })]
    )

    expect(conflicts.listClaims()[0]?.artifactPath).toBe("packages/db")
    expect(decision.blocked).toBe(true)
    expect(decision.blockKind).toBe("conflict")
    expect(decision.candidates[0]?.conflictingAssignmentIds).toEqual(["assignment-1"])
  })

  it("detects reviewer deadlocks when all eligible agents are locked out", () => {
    const conflicts = new ConflictTracker()
    conflicts.applyReviewerLock({
      artifactPaths: ["src/auth.ts"],
      lockedAgentId: "backend",
      reviewerAgentId: "lead",
      reason: "revise ownership"
    })
    conflicts.applyReviewerLock({
      artifactPaths: ["src/auth.ts"],
      lockedAgentId: "generalist",
      reviewerAgentId: "lead",
      reason: "second rejection"
    })

    const router = new TeamRouter(conflicts)
    const decision = router.routeTask(
      task("task-auth", {
        artifactPaths: ["src/auth.ts"],
        requiredCapabilities: ["backend"]
      }),
      [
        agent("backend", { capabilities: ["backend"], lanes: ["backend"] }),
        agent("generalist", { capabilities: ["backend"], lanes: ["backend"] })
      ]
    )

    expect(decision.blocked).toBe(true)
    expect(decision.blockKind).toBe("deadlock")
    expect(decision.deadlock?.blockedAgentIds).toEqual(["backend", "generalist"])
  })
})

describe("SwarmOrchestrator", () => {
  it("dispatches dependency-aware work with bounded parallelism", async () => {
    const orchestrator = new SwarmOrchestrator({
      agents: [
        agent("backend", { capabilities: ["backend"], lanes: ["backend"], maxParallelAssignments: 1 }),
        agent("frontend", { capabilities: ["frontend"], lanes: ["frontend"], maxParallelAssignments: 1 })
      ],
      maxParallelAssignments: 2
    })

    await orchestrator.enqueue([
      task("A1", {
        requiredCapabilities: ["backend"],
        preferredLanes: ["backend"],
        artifactPaths: ["src/api.ts"],
        priority: 20
      }),
      task("A2", {
        requiredCapabilities: ["frontend"],
        preferredLanes: ["frontend"],
        artifactPaths: ["src/app.tsx"],
        priority: 10
      }),
      task("A3", {
        requiredCapabilities: ["backend"],
        preferredLanes: ["backend"],
        dependsOn: ["A1"],
        artifactPaths: ["src/api.test.ts"],
        priority: 30
      })
    ])

    const firstWave = await orchestrator.dispatchReady()
    expect(firstWave.assignments).toHaveLength(2)
    expect(firstWave.assignments.map((assignment) => assignment.taskId).sort()).toEqual(["A1", "A2"])

    await orchestrator.completeAssignment(
      firstWave.assignments.find((assignment) => assignment.taskId === "A1")!.assignmentId
    )
    const secondWave = await orchestrator.dispatchReady()
    expect(secondWave.assignments).toHaveLength(1)
    expect(secondWave.assignments[0]?.taskId).toBe("A3")
  })

  it("requeues rejected work and routes it away from the locked-out author", async () => {
    const orchestrator = new SwarmOrchestrator({
      agents: [
        agent("backend", { capabilities: ["backend", "auth"], lanes: ["backend"], maxParallelAssignments: 1 }),
        agent("backup", { capabilities: ["backend"], lanes: ["backend"], maxParallelAssignments: 1 })
      ],
      maxParallelAssignments: 1
    })

    await orchestrator.enqueue([
      task("task-review", {
        requiredCapabilities: ["backend"],
        preferredAssigneeId: "backend",
        artifactPaths: ["src/auth.ts"],
        priority: 100
      })
    ])

    const firstWave = await orchestrator.dispatchReady()
    expect(firstWave.assignments[0]?.agentId).toBe("backend")

    await orchestrator.rejectAssignment({
      assignmentId: firstWave.assignments[0]!.assignmentId,
      reviewerAgentId: "lead",
      reason: "Need an independent revision"
    })

    const secondWave = await orchestrator.dispatchReady()
    expect(secondWave.assignments).toHaveLength(1)
    expect(secondWave.assignments[0]?.agentId).toBe("backup")
  })
})

describe("delegationTaskFromPlanSubtask", () => {
  it("adapts orchestra subtasks into team-router tasks", () => {
    const delegationTask = delegationTaskFromPlanSubtask(
      {
        id: "A1",
        label: "Patch auth flow",
        goal: "Fix the auth edge case",
        prompt: "Do the work",
        files: ["src/auth.ts"],
        dependsOn: ["A0"],
        deliverables: ["updated auth.ts"],
        validation: ["pnpm test"]
      },
      {
        preferredLanes: ["backend"],
        requiredCapabilities: ["backend"],
        priority: 42
      }
    )

    expect(delegationTask.id).toBe("A1")
    expect(delegationTask.kind).toBe("implement")
    expect(delegationTask.preferredLanes).toEqual(["backend"])
    expect(delegationTask.artifactPaths).toEqual(["src/auth.ts"])
    expect(delegationTask.priority).toBe(42)
  })
})
