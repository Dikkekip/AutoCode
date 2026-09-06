import {
  type AdapterHealthcheckResult,
  type Agent,
  type Persona,
  type RoutingRule,
  routeTask,
  selectBestAgentForTask,
  type Task
} from "@openclaw/domain"
import { describe, expect, it } from "vitest"

const now = new Date("2026-04-11T09:00:00.000Z").toISOString()

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
    title: "General task",
    description: "General repository work",
    labels: [],
    changedFiles: [],
    taskPackage: null,
    kind: "user",
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
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    ...patch
  }
}

function makePlannerTaskPackage(
  complexityScore100: number,
  valueScore100: number,
  requiredReading: string[]
): NonNullable<Task["taskPackage"]> {
  return {
    version: 1,
    generatedAt: now,
    repoProfile: "lawyerrag",
    likelyOwnershipLane: "backend-incidents-and-timeline",
    laneReason: "Planner selected the lane",
    inferenceSignals: ["repo-search:grounded"],
    requiredReading,
    verificationChecklist: ["pnpm test"],
    contractUpdateReminders: [],
    repoNotes: [],
    taskSourceIntent: "persona_ideation",
    promptRouteRank: {
      pipeline: ["ideation", "promptify", "complexity_estimate", "model_router"],
      intent: "promptify",
      ideationScore: 80,
      promptQualityScore: 90,
      complexityScore100,
      valueScore100,
      recommendedPersonaStage: null,
      promptSignals: [`planner-complexity:${complexityScore100}`, `planner-value:${valueScore100}`],
      rankingReasons: ["planner supplied structured risk estimates"]
    }
  }
}

function makeAgent(
  id: string,
  adapterType: Agent["adapterType"],
  model: string | null,
  patch: Partial<Agent> = {}
): Agent {
  return {
    id,
    companyId: "company-1",
    name: id,
    role: "Engineer",
    adapterType,
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

function makePersona(patch: Partial<Persona> = {}): Persona {
  return {
    id: "persona-1",
    companyId: "company-1",
    name: "pm-backend-reliability",
    stage: "planner",
    ownedLanes: ["backend-reliability"],
    preferredAdapterType: "azure_foundry",
    instructionsPath: null,
    status: "active",
    budgetLimit: null,
    budgetWindow: "monthly",
    createdAt: now,
    updatedAt: now,
    ...patch
  }
}

const rules: RoutingRule[] = [
  {
    id: "rule-ui",
    name: "ui-surface",
    priority: 100,
    targetAdapterType: "gemini_local",
    matchType: "keyword",
    patterns: ["ui", "frontend", "design", ".tsx"],
    isFallback: false,
    createdAt: now
  },
  {
    id: "rule-default",
    name: "default-codex",
    priority: 0,
    targetAdapterType: "codex_local",
    matchType: "default",
    patterns: [],
    isFallback: true,
    createdAt: now
  }
]

const agents: Agent[] = [
  makeAgent("codex-gpt55", "codex_local", "gpt-5.5", { name: "codex-coder", role: "Backend Engineer" }),
  makeAgent("codex-gpt54", "codex_local", "gpt-5.4", { name: "codex-standard", role: "Backend Engineer" }),
  makeAgent("gemini-pro", "gemini_local", "gemini-2.5-pro", { name: "gemini-ui", role: "Frontend Engineer" }),
  makeAgent("gemini-flash", "gemini_local", "gemini-2.5-flash", { name: "gemini-fast", role: "UI Iteration" }),
  makeAgent("foundry-kimi", "azure_foundry", "Kimi-K2.6", { name: "planner-kimi", role: "PM Planner Reviewer" }),
  makeAgent("codex-mini", "codex_local", "gpt-5.4-mini", { name: "codex-mini", role: "Quality Reviewer" }),
  makeAgent("codex-spark", "codex_local", "gpt-5.3-codex-spark", { name: "codex-spark", role: "Fast Engineer" }),
  makeAgent("foundry-mini", "azure_foundry", "gpt-5.4-mini", { name: "review-mini", role: "Quality Reviewer" })
]

function healthyAdapters(
  overrides: Partial<Record<Agent["adapterType"], AdapterHealthcheckResult>> = {}
): Record<string, AdapterHealthcheckResult> {
  return {
    codex_local: { ok: true, message: "ok" },
    gemini_local: { ok: true, message: "ok" },
    azure_foundry: { ok: true, message: "ok" },
    ...overrides
  }
}

describe("routeTask", () => {
  it("routes tool-required repo work to Codex", () => {
    const decision = routeTask({
      task: makeTask({
        kind: "implement",
        title: "Refactor the execution runner",
        changedFiles: ["packages/executor/src/runner.ts"],
        allowedPaths: ["packages/executor/**"],
        verificationCommands: ["pnpm test --filter executor"]
      }),
      rules,
      agents,
      healthByAdapter: healthyAdapters()
    })

    expect(decision.taskShape).toBe("repo_execution")
    expect(decision.adapterType).toBe("codex_local")
    expect(decision.agent?.id).toBe("codex-gpt55")
    expect(decision.selectedModel).toBe("gpt-5.6-sol")
    expect(decision.reasoningEffort).toBe("high")
    expect(decision.risk.promptRouteRank.pipeline).toEqual([
      "ideation",
      "promptify",
      "complexity_estimate",
      "model_router"
    ])
    expect(decision.risk.complexityScore100).toBeGreaterThanOrEqual(80)
    expect(decision.selectionReasons.join(" ")).toContain("repo")
  })

  it("scales coding models by complexity while preserving budget and recovery overrides", () => {
    const gpt56Agents: Agent[] = [
      makeAgent("codex-sol", "codex_local", "gpt-5.6-sol", { name: "codex-sol", role: "Senior Engineer" }),
      makeAgent("codex-terra", "codex_local", "gpt-5.6-terra", {
        name: "codex-terra",
        role: "Software Engineer"
      }),
      makeAgent("codex-luna", "codex_local", "gpt-5.6-luna", { name: "codex-luna", role: "Coordinator" })
    ]

    const hard = routeTask({
      task: makeTask({
        kind: "implement",
        title: "Harden legal evidence authorization and provenance validation",
        labels: ["legal", "security", "evidence", "high-risk"],
        changedFiles: [
          "apps/backend/lawyer_rag/auth/policy.py",
          "apps/backend/lawyer_rag/evidence/provenance.py",
          "apps/backend/lawyer_rag/tests/test_evidence_policy.py"
        ],
        allowedPaths: ["apps/backend/lawyer_rag/**"],
        verificationCommands: ["pytest apps/backend/lawyer_rag/tests/test_evidence_policy.py"]
      }),
      rules,
      agents: gpt56Agents,
      healthByAdapter: healthyAdapters()
    })
    expect(hard.selectedModel).toBe("gpt-6-astra")
    expect(hard.reasoningEffort).toBe("high")

    const criticalReading = Array.from(
      { length: 12 },
      (_, index) => `apps/backend/lawyer_rag/security/critical-${index}.py`
    )
    const criticalPackage = makePlannerTaskPackage(100, 100, criticalReading)
    const critical = routeTask({
      task: makeTask({
        kind: "implement",
        title: "Repair critical legal evidence authorization boundary",
        labels: ["legal", "security", "evidence", "critical"],
        changedFiles: [
          "apps/backend/lawyer_rag/auth/policy.py",
          "apps/backend/lawyer_rag/evidence/provenance.py",
          "apps/backend/lawyer_rag/tests/test_evidence_policy.py"
        ],
        requiredReading: criticalReading,
        verificationCommands: criticalPackage.verificationChecklist,
        taskPackage: criticalPackage
      }),
      rules,
      agents: gpt56Agents,
      healthByAdapter: healthyAdapters()
    })
    expect(critical.selectedModel).toBe("gpt-6-astra")
    expect(critical.reasoningEffort).toBe("max")

    const recovery = routeTask({
      task: makeTask({
        kind: "implement",
        title: "Recover independently reviewed Vedlegg mobile handoff",
        description:
          "Recover independently reviewed commit ae5bf33d58c8f55e93e4a636a67bfad4d622d3cc and cherry-pick it onto fresh origin/main.",
        labels: ["legal", "frontend", "critical"],
        changedFiles: criticalReading,
        requiredReading: criticalReading,
        verificationCommands: criticalPackage.verificationChecklist,
        taskPackage: criticalPackage,
        lastRecoveryReason: "tool-routing-fix-870bff1"
      }),
      rules,
      agents: gpt56Agents,
      healthByAdapter: healthyAdapters()
    })
    expect(recovery.selectedModel).toBe("gpt-5.6-sol")
    expect(recovery.reasoningEffort).toBe("medium")

    const failedReviewRecovery = routeTask({
      task: makeTask({
        kind: "implement",
        title: "Repair preserved shell review",
        description: "Recover implementation commit 13fc216 and investigate the failed review checks.",
        labels: ["legal", "frontend", "critical"],
        changedFiles: criticalReading,
        requiredReading: criticalReading,
        verificationCommands: criticalPackage.verificationChecklist,
        taskPackage: criticalPackage,
        lastRecoveryReason: "failed-review-repair"
      }),
      rules,
      agents: gpt56Agents,
      healthByAdapter: healthyAdapters()
    })
    expect(failedReviewRecovery.selectedModel).toBe("gpt-5.6-sol")
    expect(failedReviewRecovery.reasoningEffort).toBe("high")

    const normal = routeTask({
      task: makeTask({
        kind: "implement",
        title: "Refactor the execution runner",
        changedFiles: ["packages/executor/src/runner.ts"],
        allowedPaths: ["packages/executor/**"],
        verificationCommands: ["pnpm test --filter executor"]
      }),
      rules,
      agents: gpt56Agents,
      healthByAdapter: healthyAdapters()
    })
    expect(normal.selectedModel).toBe("gpt-5.6-sol")
    expect(normal.reasoningEffort).toBe("high")

    const budget = routeTask({
      task: makeTask({
        kind: "implement",
        title: "Apply a cost-sensitive documentation link fix",
        labels: ["budget-first"],
        changedFiles: ["docs/runtime.md"],
        allowedPaths: ["docs/**"],
        verificationCommands: ["pnpm lint"]
      }),
      rules,
      agents: gpt56Agents,
      healthByAdapter: healthyAdapters()
    })
    expect(budget.selectedModel).toBe("gpt-5.6-terra")
    expect(budget.reasoningEffort).toBe("high")

    const criticalBudget = routeTask({
      task: makeTask({
        kind: "implement",
        title: "Apply a budget-first critical contract migration",
        labels: ["budget-first", "legal", "security", "critical"],
        changedFiles: criticalReading,
        requiredReading: criticalReading,
        verificationCommands: criticalPackage.verificationChecklist,
        taskPackage: criticalPackage
      }),
      rules,
      agents: gpt56Agents,
      healthByAdapter: healthyAdapters()
    })
    expect(criticalBudget.selectedModel).toBe("gpt-5.6-terra")
    expect(criticalBudget.reasoningEffort).toBe("high")

    const light = routeTask({
      task: makeTask({ kind: "follow_up", title: "Summarize queue status" }),
      rules,
      agents: gpt56Agents,
      healthByAdapter: healthyAdapters()
    })
    expect(light.selectedModel).toBe("gpt-5.6-luna")
    expect(light.reasoningEffort).toBe("low")
  })

  it("does not let rich planner task packages saturate ordinary coding work at Sol max", () => {
    const gpt56Agents: Agent[] = [
      makeAgent("codex-sol", "codex_local", "gpt-5.6-sol"),
      makeAgent("codex-terra", "codex_local", "gpt-5.6-terra"),
      makeAgent("codex-luna", "codex_local", "gpt-5.6-luna")
    ]
    const reading = Array.from({ length: 18 }, (_, index) => `apps/reports-ui/src/feature-${index}.tsx`)
    const taskPackage = makePlannerTaskPackage(55, 35, reading)
    const decision = routeTask({
      task: makeTask({
        kind: "implement",
        title: "Keep matter switches on a valid evidence workflow",
        description: "Add a focused route guard for a court evidence workflow.",
        labels: ["planner-generated", "legal", "frontend"],
        changedFiles: ["apps/reports-ui/src/features/shell/RootLayout.tsx"],
        requiredReading: reading,
        verificationCommands: taskPackage.verificationChecklist,
        taskPackage
      }),
      rules,
      agents: gpt56Agents,
      healthByAdapter: healthyAdapters()
    })

    expect(decision.selectedModel).toBe("gpt-5.6-terra")
    expect(decision.reasoningEffort).toBe("medium")
    expect(decision.risk.complexityScore100).toBeLessThan(75)
    expect(decision.risk.promptRouteRank.rankingReasons.join(" ")).toContain("planner route estimate anchored")
  })

  it("routes planner-rated high work to Sol high without escalating it to max", () => {
    const gpt56Agents: Agent[] = [
      makeAgent("codex-sol", "codex_local", "gpt-5.6-sol"),
      makeAgent("codex-terra", "codex_local", "gpt-5.6-terra"),
      makeAgent("codex-luna", "codex_local", "gpt-5.6-luna")
    ]
    const reading = Array.from({ length: 14 }, (_, index) => `apps/backend/lawyer_rag/module-${index}.py`)
    const taskPackage = makePlannerTaskPackage(80, 70, reading)
    const decision = routeTask({
      task: makeTask({
        kind: "implement",
        title: "Persist verifiable receipts for court-bundle exports",
        description: "Persist auditable legal export receipts with contract tests.",
        labels: ["planner-generated", "legal", "auditability"],
        changedFiles: ["apps/backend/lawyer_rag/incidents/bundle_repository.py"],
        requiredReading: reading,
        verificationCommands: taskPackage.verificationChecklist,
        taskPackage
      }),
      rules,
      agents: gpt56Agents,
      healthByAdapter: healthyAdapters()
    })

    expect(decision.selectedModel).toBe("gpt-5.6-sol")
    expect(decision.reasoningEffort).toBe("high")
    expect(decision.risk.complexityScore100).toBeGreaterThanOrEqual(75)
    expect(decision.risk.complexityScore100).toBeLessThan(92)
  })

  it("escalates complex legally important incident work to GPT-6 Astra", () => {
    const decision = routeTask({
      task: makeTask({
        kind: "implement",
        title: "Add Entra ID-linked participant mentions and lawyer notes to the incident timeline",
        labels: ["backend", "incident", "timeline", "legal"],
        changedFiles: ["apps/backend/lawyer_rag/incidents/timeline.py"],
        allowedPaths: ["apps/backend/lawyer_rag/incidents/**"],
        verificationCommands: ["make test-contracts-backend"]
      }),
      rules,
      agents,
      healthByAdapter: healthyAdapters()
    })

    expect(decision.adapterType).toBe("codex_local")
    expect(decision.agent?.id).toBe("codex-gpt55")
    expect(decision.selectedModel).toBe("gpt-6-astra")
    expect(decision.reasoningEffort).toBe("high")
    expect(decision.risk.importanceScore).toBeGreaterThanOrEqual(3)
    expect(decision.modelRoutingReason).toContain("GPT-6 Astra")
  })

  it("routes frontend execution to Gemini", () => {
    const decision = routeTask({
      task: makeTask({
        kind: "implement",
        title: "Polish the dashboard UI",
        labels: ["frontend", "ui"],
        changedFiles: ["apps/web/src/dashboard.tsx"]
      }),
      rules,
      agents,
      healthByAdapter: healthyAdapters()
    })

    expect(decision.taskShape).toBe("frontend_execution")
    expect(decision.adapterType).toBe("gemini_local")
    expect(decision.agent?.id).toBe("gemini-pro")
    expect(decision.costEstimate.pricingSource).toContain("Google")
    expect(decision.costEstimate.estimatedUsd).toBeGreaterThan(0)
  })

  it("does not treat ui inside required backend wording as a frontend signal", () => {
    const decision = routeTask({
      task: makeTask({
        kind: "implement",
        title: "Stop cross-matter ingestion when case-file identities conflict",
        description:
          "Inspect the required reading and build the narrowest verified backend fix while preserving provenance-safe UX.",
        laneId: "backend-ingestion-and-aiops",
        labels: ["backend", "ingestion"],
        changedFiles: ["apps/backend/lawyer_rag/routes/ingestion/api.py"],
        requiredReading: ["apps/backend/lawyer_rag/routes/ingestion/_common.py"],
        verificationCommands: ["make reviewer-backend-contracts-targeted"]
      }),
      rules,
      agents,
      healthByAdapter: healthyAdapters()
    })

    expect(decision.taskShape).toBe("repo_execution")
    expect(decision.adapterType).toBe("codex_local")
    expect(decision.selectionReasons).toContain("backend ownership lane requires repo execution")
  })

  it("selects deterministic fallback ladders and agent routes", () => {
    const task = makeTask({
      kind: "implement",
      title: "Fix failing checkout tests",
      labels: ["qa"],
      changedFiles: ["packages/domain/src/routing.ts"],
      laneId: "qa"
    })

    const first = routeTask({
      task,
      rules,
      agents,
      healthByAdapter: healthyAdapters()
    })
    const second = routeTask({
      task,
      rules,
      agents,
      healthByAdapter: healthyAdapters()
    })

    expect(first).toMatchObject({
      adapterType: "codex_local",
      taskShape: "review"
    })
    expect(first.fallbackLadder).toEqual(["codex_local", "azure_foundry", "gemini_local"])
    expect(first.agent?.id).toBe("codex-gpt54")
    expect(second.adapterType).toBe(first.adapterType)
    expect(second.agent?.id).toBe(first.agent?.id)
    expect(second.scorecard).toEqual(first.scorecard)
  })

  it("falls back deterministically when no healthy agents are available", () => {
    const decision = routeTask({
      task: makeTask({ title: "Ambiguous one-off request" }),
      rules,
      agents: [],
      healthByAdapter: healthyAdapters()
    })

    expect(decision.adapterType).toBe("codex_local")
    expect(decision.agent).toBeNull()
    expect(decision.scorecard.every((entry) => entry.available === false)).toBe(true)
  })

  it("routes planning-only tasks to Azure Foundry Kimi", () => {
    const decision = routeTask({
      task: makeTask({
        kind: "plan",
        stage: "planner",
        title: "Decompose router policy upgrade",
        requiredReading: [
          "packages/domain/src/routing.ts",
          "packages/executor/src/runner.ts",
          "profiles/lawyerrag/profile.json",
          "tests/routing.test.ts"
        ]
      }),
      rules,
      agents,
      healthByAdapter: healthyAdapters()
    })

    expect(decision.taskShape).toBe("planning")
    expect(decision.adapterType).toBe("azure_foundry")
    expect(decision.agent?.id).toBe("foundry-kimi")
    expect(decision.agent?.model).toBe("Kimi-K2.6")
  })

  it("selects Kimi-K2.6 for PM planner personas inside Azure Foundry", () => {
    const decision = selectBestAgentForTask(
      makeTask({
        kind: "plan",
        stage: "planner",
        title: "PM backend reliability planning brief",
        labels: ["pm", "backend", "planning"]
      }),
      agents,
      "azure_foundry",
      makePersona()
    )

    expect(decision.agent?.id).toBe("foundry-kimi")
    expect(decision.agent?.adapterType).toBe("azure_foundry")
    expect(decision.agent?.model).toBe("Kimi-K2.6")
  })

  it("routes substantive evidence review tasks to the native Codex lane", () => {
    const decision = routeTask({
      task: makeTask({
        kind: "review",
        stage: "reviewer",
        title: "Review legal evidence citation findings for the PR",
        labels: ["legal", "evidence", "citation"]
      }),
      rules,
      agents,
      healthByAdapter: healthyAdapters()
    })

    expect(decision.taskShape).toBe("review")
    expect(decision.adapterType).toBe("codex_local")
    expect(decision.agent?.id).toBe("codex-mini")
  })

  it("uses the native Codex lane for low-risk text-only coordination", () => {
    const decision = routeTask({
      task: makeTask({
        kind: "follow_up",
        title: "Summarize queue status",
        description: "Write a short status note."
      }),
      rules,
      agents,
      healthByAdapter: healthyAdapters()
    })

    expect(decision.taskShape).toBe("coordination")
    expect(decision.adapterType).toBe("codex_local")
    expect(decision.agent?.id).toBe("codex-mini")
    expect(decision.selectedModel).toBe("gpt-5.6-luna")
    expect(decision.modelRoutingReason).toContain("low-risk")
    expect(decision.costEstimate.estimatedUsd).not.toBeNull()
    expect(decision.agentSelection?.candidates[0]?.reasons.join(" ")).toContain("cost")
  })

  it("uses the native Codex lane for legal safety and evidence synthesis", () => {
    const decision = routeTask({
      task: makeTask({
        kind: "review",
        stage: "reviewer",
        title: "Review legal evidence report prompt-injection safety",
        description: "Check citations, unsupported allegations, privacy, and source-backed legal evidence wording.",
        labels: ["legal", "evidence", "prompt-safety", "privacy"]
      }),
      rules,
      agents,
      healthByAdapter: healthyAdapters()
    })

    expect(decision.taskShape).toBe("review")
    expect(decision.adapterType).toBe("codex_local")
    expect(decision.agent?.id).toBe("codex-gpt54")
    expect(decision.selectedModel).toBe("gpt-5.6-terra")
    expect(decision.reasoningEffort).toBe("medium")
    expect(decision.risk.domains).toEqual(expect.arrayContaining(["legal-evidence", "prompt-safety"]))
    expect(decision.modelRoutingReason).toContain("GPT-5.6 Terra")
  })

  it("keeps tool-heavy legal implementation on Codex despite Kimi being good for review", () => {
    const decision = routeTask({
      task: makeTask({
        kind: "implement",
        title: "Implement court mode verified-only chat guard",
        description: "Restrict retrieval to verified matter-scoped evidence and add citation tests.",
        labels: ["legal", "court", "security"],
        changedFiles: ["apps/backend/lawyer_rag/services/chat_completion_service.py"],
        allowedPaths: ["apps/backend/lawyer_rag/services/**"],
        verificationCommands: [
          "cd apps/backend && uv run pytest --no-cov lawyer_rag/tests/test_citation_confidence.py -q"
        ]
      }),
      rules,
      agents,
      healthByAdapter: healthyAdapters()
    })

    expect(decision.taskShape).toBe("repo_execution")
    expect(decision.adapterType).toBe("codex_local")
    expect(decision.selectedModel).toBe("gpt-6-astra")
    expect(decision.risk.domains).toEqual(expect.arrayContaining(["legal-evidence", "security-scope", "repo-code"]))
  })

  it("falls back from unhealthy Gemini frontend routing to Codex", () => {
    const decision = routeTask({
      task: makeTask({
        kind: "implement",
        title: "Refine responsive UI behavior",
        labels: ["frontend"]
      }),
      rules,
      agents,
      healthByAdapter: healthyAdapters({
        gemini_local: { ok: false, message: "gemini unavailable" }
      })
    })

    expect(decision.adapterType).toBe("codex_local")
    expect(decision.scorecard.find((entry) => entry.adapterType === "gemini_local")?.healthOk).toBe(false)
  })

  it("falls back from quota-blocked Codex repo work to Gemini", () => {
    const decision = routeTask({
      task: makeTask({
        kind: "implement",
        title: "Fix a backend bug in the dispatcher",
        changedFiles: ["packages/executor/src/runner.ts"],
        allowedPaths: ["packages/executor/**"],
        verificationCommands: ["pnpm test --filter executor"]
      }),
      rules,
      agents,
      healthByAdapter: healthyAdapters({
        codex_local: { ok: false, message: "Codex quota constrained: all accounts warm" }
      })
    })

    expect(decision.adapterType).toBe("gemini_local")
    expect(decision.selectionReasons.join(" ")).toContain("repo")
    expect(decision.scorecard.find((entry) => entry.adapterType === "codex_local")?.healthMessage).toContain("quota")
  })

  it("smoke-simulates ten representative task shapes", () => {
    const scenarios = [
      {
        label: "repo bugfix",
        task: makeTask({
          kind: "implement",
          title: "Fix failing queue worker",
          changedFiles: ["packages/executor/src/runner.ts"],
          allowedPaths: ["packages/executor/**"],
          verificationCommands: ["pnpm test"]
        }),
        adapter: "codex_local",
        agent: "codex-gpt55"
      },
      {
        label: "deep refactor",
        task: makeTask({
          kind: "implement",
          title: "Refactor routing architecture",
          changedFiles: ["packages/domain/src/routing.ts"],
          allowedPaths: ["packages/domain/**"],
          verificationCommands: ["pnpm test"]
        }),
        adapter: "codex_local",
        agent: "codex-gpt55"
      },
      {
        label: "frontend polish",
        task: makeTask({
          kind: "implement",
          title: "Polish landing page UI",
          labels: ["frontend"],
          changedFiles: ["apps/web/src/landing.tsx"]
        }),
        adapter: "gemini_local",
        agent: "gemini-pro"
      },
      {
        label: "frontend component",
        task: makeTask({
          kind: "implement",
          title: "Iterate on React component styling",
          labels: ["ui"],
          changedFiles: ["apps/web/src/Button.tsx"]
        }),
        adapter: "gemini_local",
        agent: "gemini-pro"
      },
      {
        label: "broad planning",
        task: makeTask({
          kind: "plan",
          stage: "planner",
          title: "Analyze release risks",
          requiredReading: ["a", "b", "c", "d"]
        }),
        adapter: "azure_foundry",
        agent: "foundry-kimi"
      },
      {
        label: "manager synthesis",
        task: makeTask({
          kind: "user",
          title: "Manager analysis and decomposition brief",
          description: "Need broad analysis and synthesis",
          requiredReading: ["a", "b", "c", "d"]
        }),
        adapter: "azure_foundry",
        agent: "foundry-kimi"
      },
      {
        label: "review summary",
        task: makeTask({ kind: "review", title: "Review and summarize findings" }),
        adapter: "codex_local",
        agent: "codex-mini"
      },
      {
        label: "coordination note",
        task: makeTask({ kind: "follow_up", title: "Write a short coordination summary" }),
        adapter: "codex_local",
        agent: "codex-gpt54"
      },
      {
        label: "promotion summary",
        task: makeTask({ kind: "promote", title: "Prepare promotion summary" }),
        adapter: "codex_local",
        agent: "codex-gpt54"
      },
      {
        label: "general backend",
        task: makeTask({
          kind: "user",
          title: "Investigate backend drift",
          description: "repo bugfix and verification"
        }),
        adapter: "codex_local",
        agent: "codex-gpt54"
      }
    ] as const

    const outcomes = scenarios.map((scenario) => {
      const decision = routeTask({
        task: scenario.task,
        rules,
        agents,
        healthByAdapter: healthyAdapters()
      })
      return {
        label: scenario.label,
        adapter: decision.adapterType,
        agent: decision.agent?.id ?? null
      }
    })

    expect(outcomes).toEqual(
      scenarios.map((scenario) => ({
        label: scenario.label,
        adapter: scenario.adapter,
        agent: scenario.agent
      }))
    )
  })
})
