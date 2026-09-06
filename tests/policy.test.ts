import type { Project, Task } from "@openclaw/domain"
import { evaluatePolicy, redactLogText } from "@openclaw/domain"
import { describe, expect, it } from "vitest"

function project(): Project {
  return {
    id: "project-1",
    companyId: "company-1",
    name: "repo",
    repoPath: "/tmp/repo",
    verifyCommand: null,
    profileId: null,
    profilePath: null,
    profile: {},
    createdAt: "2026-04-26T00:00:00.000Z",
    updatedAt: "2026-04-26T00:00:00.000Z"
  }
}

function task(patch: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    companyId: "company-1",
    projectId: "project-1",
    workflowId: null,
    goalId: null,
    milestoneId: null,
    parentTaskId: null,
    dependsOnTaskIds: [],
    personaId: null,
    stage: "coder",
    title: "Update docs",
    description: null,
    labels: [],
    changedFiles: [],
    taskPackage: null,
    kind: "implement",
    priority: 0,
    scheduledAt: null,
    source: "manual",
    status: "queued",
    assignedAgentId: null,
    requestedAdapterType: null,
    laneId: null,
    allowedPaths: [],
    requiredReading: [],
    verificationCommands: [],
    claimStatus: "unclaimed",
    claimToken: null,
    claimExpiresAt: null,
    claimOwnerRunId: null,
    claimOwnerAgentId: null,
    claimedAt: null,
    lineageRootId: null,
    lineageParentId: null,
    taskPackagePath: null,
    reviewHandoffPath: null,
    artifactDir: null,
    reviewRequired: false,
    approvalRequired: false,
    retryCount: 0,
    maxRetries: 1,
    lastError: null,
    blockedReason: null,
    lastRecoveryAt: null,
    lastRecoveryReason: null,
    createdAt: "2026-04-26T00:00:00.000Z",
    updatedAt: "2026-04-26T00:00:00.000Z",
    completedAt: null,
    ...patch
  }
}

describe("policy engine", () => {
  it("blocks high-risk production database work unless explicitly allowed", () => {
    const decision = evaluatePolicy({
      phase: "dispatch",
      project: project(),
      task: task({
        title: "Run database migration",
        labels: ["risk:high"],
        changedFiles: ["migrations/001.sql"]
      }),
      runtimeFlags: {}
    })

    expect(decision.allowed).toBe(false)
    expect(decision.blockedActions).toContain("database.migrate")
  })

  it("allows high-risk work when the project policy explicitly allows the action", () => {
    const decision = evaluatePolicy({
      phase: "dispatch",
      project: project(),
      task: task({
        title: "Run database migration",
        labels: ["risk:high"],
        changedFiles: ["migrations/001.sql"]
      }),
      projectPolicy: {
        allowedActions: ["database.migrate"]
      },
      runtimeFlags: {}
    })

    expect(decision.allowed).toBe(true)
  })

  it("never permits secret handling delegation", () => {
    const decision = evaluatePolicy({
      phase: "dispatch",
      project: project(),
      task: task({
        title: "Use API token from .env",
        description: "Read SECRET_TOKEN and put it in the prompt"
      }),
      projectPolicy: {
        allowedActions: ["secret.handle"]
      },
      runtimeFlags: {
        allowHighRiskActions: true
      }
    })

    expect(decision.allowed).toBe(false)
    expect(decision.blockedActions).toContain("secret.handle")
  })

  it("redacts secret-looking values before prompt or artifact persistence", () => {
    expect(redactLogText("token=ghp_1234567890abcdefghijklmnop")).toContain("token=[REDACTED]")
  })
})
