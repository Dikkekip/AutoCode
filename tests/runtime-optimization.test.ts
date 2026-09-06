import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Agent, Company, Project, RuntimeIdentityPayload, Task } from "@openclaw/domain"
import { describe, expect, it } from "vitest"
import {
  attachSessionContextWindowState,
  buildSessionContextWindowState,
  classifyLaneStatusFromMessage,
  evaluateSessionRotation,
  RunToolingCache,
  shapeExecutionPrompt
} from "../packages/executor/src/runtime-optimization.js"
import { createTempWorkspace } from "./helpers.js"

function buildFixture(root: string): {
  company: Company
  project: Project
  task: Task
  agent: Agent
  runtimeIdentity: RuntimeIdentityPayload
} {
  const company: Company = {
    id: "company-1",
    name: "OpenClaw",
    description: null,
    createdAt: "2026-04-03T08:00:00Z"
  }
  const project: Project = {
    id: "project-1",
    companyId: company.id,
    name: "demo",
    repoPath: root,
    verifyCommand: null,
    createdAt: "2026-04-03T08:00:00Z"
  }
  const task: Task = {
    id: "task-1",
    companyId: company.id,
    projectId: project.id,
    workflowId: null,
    parentTaskId: null,
    dependsOnTaskIds: [],
    personaId: null,
    stage: "reviewer",
    title: "Review queue handoff",
    description: "Summarize only the important facts.",
    labels: ["review", "summary"],
    changedFiles: ["README.md", "src/a.ts", "src/b.ts"],
    taskPackage: {
      version: 1,
      generatedAt: "2026-04-10T00:00:00Z",
      repoProfile: "demo",
      likelyOwnershipLane: "backend",
      laneReason: "test",
      inferenceSignals: ["review"],
      requiredReading: ["README.md", "src/a.ts", "src/b.ts"],
      verificationChecklist: ["printf 'ok\\n'"],
      contractUpdateReminders: [],
      repoNotes: []
    },
    kind: "follow_up",
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
    maxRetries: 0,
    lastError: null,
    blockedReason: null,
    lastRecoveryAt: null,
    lastRecoveryReason: null,
    createdAt: "2026-04-03T08:00:00Z",
    updatedAt: "2026-04-03T08:00:00Z",
    completedAt: null
  }
  const agent: Agent = {
    id: "agent-1",
    companyId: company.id,
    name: "foundry-reviewer",
    role: "Reviewer",
    adapterType: "azure_foundry",
    status: "idle",
    model: "Kimi-2.6",
    instructionsPath: null,
    command: null,
    env: {},
    heartbeatEnabled: true,
    heartbeatIntervalSec: 300,
    budgetLimit: null,
    budgetWindow: "monthly",
    lastHeartbeatAt: null,
    createdAt: "2026-04-03T08:00:00Z",
    updatedAt: "2026-04-03T08:00:00Z"
  }
  const runtimeIdentity: RuntimeIdentityPayload = {
    version: 1,
    runtimeKey: "runtime-key",
    executionKey: "run-1",
    companyId: company.id,
    projectId: project.id,
    projectName: project.name,
    repoPath: project.repoPath,
    taskId: task.id,
    taskKind: task.kind,
    taskTitle: task.title,
    workflowId: null,
    laneId: null,
    agentId: agent.id,
    agentName: agent.name,
    adapterType: agent.adapterType,
    model: agent.model,
    wake: {
      reason: "manual",
      heartbeatJobId: null,
      triggeredAt: "2026-04-10T00:00:00Z"
    },
    continuation: {
      sessionKey: "runtime-key",
      sessionDisplayId: null,
      retryCount: 0,
      attempt: 1,
      heartbeatEnabled: true,
      heartbeatIntervalSec: 300,
      supportsSessionResume: false,
      nativeContextManagement: "none"
    },
    scope: {
      allowedPaths: [],
      requiredReading: [],
      verificationCommands: ["printf 'ok\\n'"]
    }
  }

  return { company, project, task, agent, runtimeIdentity }
}

describe("runtime optimization helpers", () => {
  it("classifies Codex credit exhaustion as quota exhaustion", () => {
    expect(classifyLaneStatusFromMessage("Your workspace is out of credits. Add credits to continue.")).toBe(
      "quota_exhausted"
    )
  })

  it("does not mistake ACP authentication metadata for an authentication failure", () => {
    const acpModelError =
      '{"authMethods":[{"description":"Run opencode auth login"}],"error":{"message":"Cannot apply --model gemini-3.1-pro"}}'

    expect(classifyLaneStatusFromMessage(acpModelError)).toBe("degraded")
    expect(classifyLaneStatusFromMessage("Authentication failed: OAuth token expired")).toBe("auth_failed")
  })

  it("caches repeated file and command work within a run", () => {
    const workspace = createTempWorkspace("runtime-tool-cache")
    try {
      writeFileSync(join(workspace.repoPath, "README.md"), "# Demo\n\n" + "hello ".repeat(50), "utf8")
      const cache = new RunToolingCache("run-1")

      const firstRead = cache.readFileArtifact(workspace.repoPath, "README.md", 200)
      const secondRead = cache.readFileArtifact(workspace.repoPath, "README.md", 200)
      const firstMissing = cache.readFileArtifact(workspace.repoPath, "missing.md", 200)
      const secondMissing = cache.readFileArtifact(workspace.repoPath, "missing.md", 200)
      const firstCommand = cache.runCommand("printf fail", () => ({
        ok: false,
        stdout: "",
        stderr: "boom",
        status: 1
      }))
      const secondCommand = cache.runCommand("printf fail", () => ({
        ok: true,
        stdout: "unexpected",
        stderr: "",
        status: 0
      }))

      expect(firstRead.cacheHit).toBe(false)
      expect(secondRead.cacheHit).toBe(true)
      expect(firstMissing.kind).toBe("missing")
      expect(secondMissing.cacheHit).toBe(true)
      expect(firstCommand.cacheHit).toBe(false)
      expect(secondCommand.cacheHit).toBe(true)
      expect(cache.snapshot()).toMatchObject({
        repeatedReadsAvoided: 1,
        repeatedFailureLoopsPrevented: 2
      })
    } finally {
      workspace.cleanup()
    }
  })

  it("assembles layered prompt context and compacts oversized review payloads", () => {
    const workspace = createTempWorkspace("runtime-prompt-shaping")
    try {
      writeFileSync(join(workspace.repoPath, "README.md"), "# Overview\n\n" + "Long prose ".repeat(400), "utf8")
      mkdirSync(join(workspace.repoPath, "src"), { recursive: true })
      writeFileSync(join(workspace.repoPath, "src", "a.ts"), "export const a = 1;\n".repeat(200), "utf8")
      writeFileSync(join(workspace.repoPath, "src", "b.ts"), "export const b = 2;\n".repeat(200), "utf8")
      const fixture = buildFixture(workspace.repoPath)
      const cache = new RunToolingCache("run-2")
      const shaped = shapeExecutionPrompt({
        ...fixture,
        instructions: "Be brief.",
        previousSession: null,
        sessionHandoffMarkdown: null,
        relevantMemory: "Historical note.\n".repeat(400),
        recentTaskEvents: [
          {
            id: "evt-1",
            taskId: fixture.task.id,
            kind: "handoff",
            message: "Parent task handed off.",
            data: null,
            createdAt: "2026-04-10T00:00:00Z"
          }
        ],
        recentRun: null,
        recentRunEvents: [],
        parentTask: null,
        toolingCache: cache
      })

      expect(shaped.prompt).toContain("Task summary:")
      expect(shaped.prompt).toContain("Required facts:")
      expect(shaped.prompt).toContain("Relevant file context:")
      expect(shaped.prompt).toContain("Recent decisions:")
      expect(shaped.budgetMetadata).toMatchObject({
        compactionApplied: true
      })
      expect((shaped.budgetMetadata.selectedFiles as string[]).length).toBeLessThan(
        fixture.task.taskPackage?.requiredReading.length ?? 0
      )
      expect(shaped.budgetMetadata.attachments.some((attachment) => attachment.oversized)).toBe(true)
      expect(shaped.prompt).toContain("too large to attach safely")
    } finally {
      workspace.cleanup()
    }
  })

  it("dispatches structured acceptance and deduplicated persona guidance", () => {
    const workspace = createTempWorkspace("runtime-prompt-deduplication")
    try {
      const fixture = buildFixture(workspace.repoPath)
      fixture.task.kind = "implement"
      fixture.task.description = [
        "Keep the selected source visible after refresh.",
        "",
        "Framework prompt ideation brief:",
        "Acceptance criteria:",
        "- Keep the selected source visible after refresh."
      ].join("\n")
      fixture.task.taskPackage = {
        ...fixture.task.taskPackage!,
        userOutcome: "Reviewers retain source context.",
        acceptanceCriteria: ["The selected source remains visible."],
        inferenceSignals: ["repo-search: selected source state is owned by BundleDetail"],
        repoNotes: ["Reuse the existing selection state."],
        extraInstructions: [
          [
            "Planner implementation prompt:",
            "# Persona execution contract",
            "Execution persona: defendant-end-user-advocate",
            "## User outcome",
            "Reviewers retain source context.",
            "## Persona ideation synthesis",
            "- Skeptical maintainer: preserve refresh concurrency semantics.",
            "## Read before editing",
            "- duplicate/path.ts",
            "## Verification ladder",
            "- duplicate command",
            "## Completion protocol",
            "- Report exact verification evidence."
          ].join("\n")
        ]
      }
      const shaped = shapeExecutionPrompt({
        ...fixture,
        instructions: null,
        previousSession: null,
        sessionHandoffMarkdown: null,
        relevantMemory: null,
        recentTaskEvents: [],
        recentRun: null,
        recentRunEvents: [],
        parentTask: null,
        toolingCache: new RunToolingCache("run-prompt-deduplication")
      })

      expect(shaped.prompt).toContain("- User outcome: Reviewers retain source context.")
      expect(shaped.prompt).toContain("- Acceptance criteria:")
      expect(shaped.prompt).toContain("The selected source remains visible.")
      expect(shaped.prompt).toContain("Skeptical maintainer: preserve refresh concurrency semantics.")
      expect(shaped.prompt).toContain("Report exact verification evidence.")
      expect(shaped.prompt).not.toContain("Framework prompt ideation brief")
      expect(shaped.prompt).not.toContain("duplicate/path.ts")
      expect(shaped.prompt).not.toContain("duplicate command")
      expect(shaped.prompt.match(/Reviewers retain source context\./g)).toHaveLength(1)
    } finally {
      workspace.cleanup()
    }
  })

  it("ranks task-specific feature files ahead of unrelated profile defaults", () => {
    const workspace = createTempWorkspace("runtime-prompt-relevance")
    try {
      const timelinePaths = [
        "apps/reports-ui/src/features/timeline/TimelineHeader.tsx",
        "apps/reports-ui/src/features/timeline/TimelineView.tsx",
        "apps/reports-ui/src/features/timeline/TimelineView.test.tsx",
        "apps/reports-ui/src/features/timeline/timelineInvestigation.ts",
        "apps/reports-ui/src/features/timeline/timelineInvestigation.test.ts",
        "apps/reports-ui/src/features/timeline/TimelineChronologyReadiness.tsx"
      ]
      const unrelatedPaths = [
        "apps/reports-ui/src/features/pdf/PdfWorkspace.tsx",
        "apps/reports-ui/src/features/pdf/PdfWorkspaceSections.tsx",
        "apps/reports-ui/src/features/pdf/VedleggViewer.tsx",
        "apps/reports-ui/src/features/pdf/SmartScanPanel.tsx",
        "apps/reports-ui/src/features/bundles/BundleDetail.tsx",
        "apps/reports-ui/src/features/chat/ChatSidebar.tsx"
      ]
      mkdirSync(join(workspace.repoPath, "apps", "reports-ui", "src", "features", "timeline"), {
        recursive: true
      })
      mkdirSync(join(workspace.repoPath, "apps", "reports-ui", "src", "features", "pdf"), { recursive: true })
      mkdirSync(join(workspace.repoPath, "apps", "reports-ui", "src", "features", "bundles"), { recursive: true })
      mkdirSync(join(workspace.repoPath, "apps", "reports-ui", "src", "features", "chat"), { recursive: true })
      for (const path of [...timelinePaths, ...unrelatedPaths]) {
        writeFileSync(join(workspace.repoPath, path), `export const fixture = ${JSON.stringify(path)};\n`, "utf8")
      }

      const fixture = buildFixture(workspace.repoPath)
      fixture.task.kind = "implement"
      fixture.task.title = "Review matter chronology readiness before printing"
      fixture.task.description = "Add a Timeline chronology readiness preflight with incident navigation."
      fixture.task.labels = ["timeline", "chronology", "court-preparation"]
      fixture.task.laneId = "ui-primary-routes"
      fixture.task.changedFiles = []
      fixture.task.requiredReading = [...unrelatedPaths, ...timelinePaths]
      fixture.task.taskPackage = {
        ...fixture.task.taskPackage!,
        likelyOwnershipLane: "ui-primary-routes",
        userOutcome: "Reviewers inspect chronology uncertainty from the Timeline before printing.",
        requiredReading: [...unrelatedPaths, ...timelinePaths]
      }
      const shaped = shapeExecutionPrompt({
        ...fixture,
        instructions: null,
        previousSession: null,
        sessionHandoffMarkdown: null,
        relevantMemory: null,
        recentTaskEvents: [],
        recentRun: null,
        recentRunEvents: [],
        parentTask: null,
        toolingCache: new RunToolingCache("run-relevance")
      })

      expect(shaped.budgetMetadata.selectedFiles).toEqual(timelinePaths.sort())
      expect(shaped.budgetMetadata.selectedFiles).not.toContain(unrelatedPaths[0])
    } finally {
      workspace.cleanup()
    }
  })

  it("bounds deterministic fallback exploration and delegates broad verification to the dispatcher", () => {
    const workspace = createTempWorkspace("runtime-deterministic-fallback-budget")
    try {
      mkdirSync(join(workspace.repoPath, "src"), { recursive: true })
      writeFileSync(
        join(workspace.repoPath, "src", "a.ts"),
        "export const primaryBoundary = true;\n".repeat(220),
        "utf8"
      )
      writeFileSync(
        join(workspace.repoPath, "src", "b.ts"),
        "export const secondaryBoundary = true;\n".repeat(220),
        "utf8"
      )
      const fixture = buildFixture(workspace.repoPath)
      fixture.task.kind = "implement"
      fixture.task.labels = ["deterministic-fallback"]
      fixture.task.taskPackage = {
        ...fixture.task.taskPackage!,
        taskSourceIntent: "planner_fallback"
      }
      const shaped = shapeExecutionPrompt({
        ...fixture,
        instructions: null,
        previousSession: null,
        sessionHandoffMarkdown: null,
        relevantMemory: null,
        recentTaskEvents: [],
        recentRun: null,
        recentRunEvents: [],
        parentTask: null,
        toolingCache: new RunToolingCache("run-deterministic-fallback")
      })

      expect(shaped.prompt).toContain("at most 12 read or search tool calls")
      expect(shaped.prompt).toContain(
        "Begin with src/a.ts and its nearest existing focused tests; decide one concrete source-behavior gap there"
      )
      expect(shaped.prompt).toContain("Never read an oversized file wholesale")
      expect(shaped.prompt).toContain("A test-only patch is invalid")
      expect(shaped.prompt).toContain("Do not run repository-wide suites")
      expect(shaped.budgetMetadata.attachments.find((attachment) => attachment.path === "src/a.ts")).toMatchObject({
        kind: "code_excerpt",
        oversized: false,
        truncated: true
      })
    } finally {
      workspace.cleanup()
    }
  })

  it("bounds oversized historical task-event payloads before adapter execution", () => {
    const workspace = createTempWorkspace("runtime-prompt-event-budget")
    try {
      const fixture = buildFixture(workspace.repoPath)
      const shaped = shapeExecutionPrompt({
        ...fixture,
        instructions: null,
        previousSession: null,
        sessionHandoffMarkdown: null,
        relevantMemory: null,
        recentTaskEvents: [
          {
            id: "evt-oversized",
            taskId: fixture.task.id,
            kind: "agent-selection-deferred",
            message: "Deferred after an adapter failure.",
            data: { reason: `${"echoed protocol ".repeat(130_000)}diagnostic-tail` },
            createdAt: "2026-04-10T00:00:00Z"
          }
        ],
        recentRun: null,
        recentRunEvents: [],
        parentTask: null,
        toolingCache: new RunToolingCache("run-oversized-event")
      })

      expect(shaped.prompt).toContain("characters omitted for prompt budget")
      expect(shaped.prompt).toContain("diagnostic-tail")
      expect(shaped.prompt.length).toBeLessThan(100_000)
      expect(shaped.budgetMetadata.estimatedAfterTokens).toBeLessThan(shaped.budgetMetadata.budgetTokens)
    } finally {
      workspace.cleanup()
    }
  })

  it("rotates sessions after raw input budgets are exceeded and emits a handoff summary", () => {
    const workspace = createTempWorkspace("runtime-session-rotation")
    try {
      const fixture = buildFixture(workspace.repoPath)
      const budget = {
        band: "large" as const,
        budgetTokens: 8_000,
        estimatedBeforeTokens: 12_000,
        estimatedAfterTokens: 7_200,
        compactionApplied: true,
        reasons: ["replaced oversized file inclusions with orientation-only attachment summaries"],
        selectedFiles: ["src/a.ts"],
        summarizedFiles: ["src/b.ts"],
        rawArtifactTokens: 11_000,
        attachments: [
          {
            path: "src/a.ts",
            kind: "reference" as const,
            inclusion: "reference" as const,
            estimatedTokens: 180,
            rawEstimatedTokens: 9_500,
            oversized: true,
            truncated: true,
            byteSize: 38_000
          }
        ]
      }
      const sessionState = {
        sessionKey: "session-key",
        id: "session-key",
        status: "active",
        companyId: fixture.company.id,
        projectId: fixture.project.id,
        taskId: fixture.task.id,
        agentId: fixture.agent.id,
        adapterType: "gemini_local" as const,
        sessionDisplayId: "gemini-session-1",
        state: attachSessionContextWindowState(
          { sessionId: "gemini-session-1" },
          buildSessionContextWindowState({
            previous: null,
            budget,
            response: "Investigated the queue overflow and narrowed the failure to the parser entrypoint.",
            recordedAt: "2026-04-10T00:00:00Z",
            rawInputTokens: 7_200
          })
        ),
        updatedAt: "2026-04-10T00:00:00Z"
      }
      fixture.agent = {
        ...fixture.agent,
        adapterType: "gemini_local",
        env: {
          OPENCLAW_SESSION_COMPACTION_MAX_RAW_INPUT_TOKENS: "5000"
        }
      }

      const rotation = evaluateSessionRotation({
        agent: fixture.agent,
        capabilities: {
          supportsSessionResume: true,
          supportsCompaction: true,
          compactionStrategy: "summarize",
          preferredPlanningContextWindow: 1000000,
          planningPriority: 80,
          planningCostClass: "medium",
          nativeContextManagement: "unknown",
          heartbeatIdentityMode: "prompt_and_env",
          defaultSessionCompaction: {
            enabled: true,
            maxSessionRuns: 200,
            maxRawInputTokens: 2_000_000,
            maxSessionAgeHours: 72
          }
        },
        sessionState,
        now: "2026-04-11T00:00:00Z"
      })

      expect(rotation.rotate).toBe(true)
      expect(rotation.reason).toContain("session raw input reached")
      expect(rotation.handoffMarkdown).toContain("OpenClaw session handoff:")
      expect(rotation.handoffMarkdown).toContain("src/a.ts")
    } finally {
      workspace.cleanup()
    }
  })
})
