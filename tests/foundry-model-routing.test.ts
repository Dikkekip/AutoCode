import { type AdapterHealthcheckResult, type Agent, type RoutingRule, routeTask, type Task } from "@openclaw/domain"
import { describe, expect, it } from "vitest"

const now = new Date("2026-05-03T00:00:00.000Z").toISOString()

function makeTask(patch: Partial<Task> = {}): Task {
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
    stage: null,
    title: "Planning task",
    description: "Plan the next reliability sweep",
    labels: [],
    changedFiles: [],
    taskPackage: null,
    kind: "plan",
    priority: 0,
    scheduledAt: null,
    source: "manual",
    status: "queued",
    assignedAgentId: null,
    requestedAdapterType: "azure_foundry",
    laneId: "backend-ingestion-and-aiops",
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
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    ...patch
  }
}

function makeAgent(id: string, model: string, patch: Partial<Agent> = {}): Agent {
  return {
    id,
    companyId: "company-1",
    name: id,
    role: "Foundry Planner",
    adapterType: "azure_foundry",
    status: "idle",
    model,
    instructionsPath: null,
    command: null,
    env: {},
    heartbeatEnabled: true,
    heartbeatIntervalSec: 300,
    budgetLimit: null,
    budgetWindow: "monthly",
    lastHeartbeatAt: null,
    createdAt: now,
    updatedAt: now,
    ...patch
  }
}

const rules: RoutingRule[] = [
  {
    id: "foundry-requested",
    name: "foundry-requested",
    priority: 100,
    targetAdapterType: "azure_foundry",
    matchType: "keyword",
    patterns: ["foundry"],
    isFallback: false,
    createdAt: now
  }
]

const agents: Agent[] = [
  makeAgent("foundry-gpt54", "gpt-5.4", { role: "Foundry GPT-5.4 reasoning" }),
  makeAgent("foundry-kimi", "Kimi-K2.6", { role: "Foundry Kimi legal evidence planner" }),
  makeAgent("foundry-mini", "gpt-5.4-mini", { role: "Foundry lightweight reviewer" })
]

const healthByAdapter: Record<string, AdapterHealthcheckResult> = {
  azure_foundry: { ok: true, message: "ok" },
  codex_local: { ok: false, message: "not under test" },
  gemini_local: { ok: false, message: "not under test" }
}

describe("Foundry model routing", () => {
  it("selects GPT-5.4 for high-risk text-first planning", () => {
    const decision = routeTask({
      task: makeTask({
        title: "Foundry critical autonomous-runtime reliability review",
        description:
          "Plan a critical multi-provider model router validation for autonomous-runtime, including production rollout, data integrity, CI blocker recovery, user-facing workflow impact, and broad analysis.",
        labels: [
          "planning",
          "review",
          "critical",
          "reliability",
          "production",
          "data integrity",
          "ci blocker",
          "user-facing"
        ],
        requiredReading: ["docs/runtime.md", "docs/routing.md", "docs/queue.md", "docs/rollout.md"]
      }),
      rules,
      agents,
      healthByAdapter
    })

    expect(decision.adapterType).toBe("azure_foundry")
    expect(decision.selectedModel).toBe("gpt-5.4")
    expect(decision.agent?.id).toBe("foundry-gpt54")
    expect(decision.modelRoutingReason).toContain("GPT-5.4")
    expect(decision.costEstimate).toMatchObject({
      model: "gpt-5.4",
      modelFamily: "gpt-5.4",
      inputUsdPerMillionTokens: 2.5,
      outputUsdPerMillionTokens: 15,
      valueBand: "high"
    })
    expect(decision.costEstimate.estimatedUsd).toBeGreaterThan(0)
  })

  it("keeps legal evidence and retrieval work on Kimi-K2.6", () => {
    const decision = routeTask({
      task: makeTask({
        title: "Foundry legal evidence synthesis",
        description: "Review legal evidence retrieval quality, prompt-safety, and RAG citations for the case bundle.",
        labels: ["legal", "evidence", "retrieval", "review"]
      }),
      rules,
      agents,
      healthByAdapter
    })

    expect(decision.selectedModel).toBe("Kimi-K2.6")
    expect(decision.agent?.id).toBe("foundry-kimi")
    expect(decision.costEstimate.estimatedUsd).toBeNull()
    expect(decision.costEstimate.pricingSource).toBeNull()
  })

  it("uses GPT-5.4-Mini for low-risk Foundry coordination", () => {
    const decision = routeTask({
      task: makeTask({
        kind: "follow_up",
        title: "Foundry status summary",
        description: "Summarize queue status.",
        labels: ["coordination"]
      }),
      rules,
      agents,
      healthByAdapter
    })

    expect(decision.selectedModel).toBe("gpt-5.4-mini")
    expect(decision.agent?.id).toBe("foundry-mini")
  })
})
