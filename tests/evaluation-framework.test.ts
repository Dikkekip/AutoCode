import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createPromptSnapshotBenchmark,
  type EvaluationBenchmark,
  EvaluationRunner,
  type EvaluationSolution,
  evaluateAutonomousCompany,
  FileEvaluationStorage,
  paperclipHeartbeatSnapshotSuite,
  renderEvaluationSummaryMarkdown,
  runPromptSnapshotSuite,
  writeEvaluationArtifacts
} from "@openclaw/evaluation"
import { afterEach, describe, expect, it } from "vitest"

const cleanups: string[] = []

afterEach(() => {
  while (cleanups.length > 0) {
    const path = cleanups.pop()
    if (path) rmSync(path, { recursive: true, force: true })
  }
})

function tempDir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  cleanups.push(path)
  return path
}

describe("evaluation framework", () => {
  it("runs benchmarks with resumable file storage and aggregate reporting", async () => {
    const directory = tempDir("openclaw-evals-")
    const storage = new FileEvaluationStorage(directory)
    let executorCalls = 0

    const benchmark: EvaluationBenchmark<string, number> = {
      id: "toy-benchmark",
      name: "Toy Benchmark",
      description: "Simple numeric pass/fail benchmark",
      tasks: [
        {
          id: "task-1",
          input: "2+2",
          groundTruth: 4,
          metrics: [
            {
              id: "accuracy",
              kind: "numeric",
              async evaluate({ task, solution }) {
                const passed = Number(solution.output) === task.groundTruth
                return {
                  metricId: "accuracy",
                  kind: "numeric",
                  value: passed ? 1 : 0,
                  passed,
                  message: passed ? "correct" : "incorrect",
                  createdAt: new Date().toISOString()
                }
              }
            }
          ]
        },
        {
          id: "task-2",
          input: "2+3",
          groundTruth: 5,
          metrics: [
            {
              id: "accuracy",
              kind: "numeric",
              async evaluate({ task, solution }) {
                const passed = Number(solution.output) === task.groundTruth
                return {
                  metricId: "accuracy",
                  kind: "numeric",
                  value: passed ? 1 : 0,
                  passed,
                  message: passed ? "correct" : "incorrect",
                  createdAt: new Date().toISOString()
                }
              }
            }
          ]
        }
      ]
    }

    const runner = new EvaluationRunner({
      benchmark,
      repeatCount: 2,
      storage,
      evaluationId: "toy-run"
    })

    const executor = async (
      task: EvaluationBenchmark<string, number>["tasks"][number]
    ): Promise<EvaluationSolution<number>> => {
      executorCalls += 1
      return {
        success: true,
        output: task.input === "2+2" ? 4 : 5,
        trajectory: [{ type: "text", text: `Solved ${task.input}` }],
        stats: {
          llm: { "gpt-test": 1 },
          chatUsage: {
            "gpt-test": {
              inputTokens: 10,
              outputTokens: 5
            }
          }
        }
      }
    }

    const firstSummary = await runner.run(executor)
    expect(executorCalls).toBe(4)
    expect(firstSummary.repeats["0"]?.metrics.accuracy.average).toBe(1)
    expect(firstSummary.repeats["1"]?.metrics.accuracy.passRate).toBe(1)

    const secondSummary = await runner.run(executor)
    expect(executorCalls).toBe(4)
    expect(secondSummary.repeats["0"]?.completedTasks).toBe(2)

    const artifacts = writeEvaluationArtifacts(directory, secondSummary)
    expect(readFileSync(artifacts.markdownPath, "utf8")).toContain("accuracy: avg=1.000")
    expect(readFileSync(artifacts.jsonPath, "utf8")).toContain('"evaluationId": "toy-run"')
  })

  it("materializes the migrated Paperclip heartbeat suite and evaluates snapshot assertions", async () => {
    const benchmark = createPromptSnapshotBenchmark(paperclipHeartbeatSnapshotSuite)
    expect(benchmark.tasks).toHaveLength(8)
    expect(benchmark.tasks[0]?.input.prompt).toContain("PAPERCLIP_AGENT_ID: agent-coder-01")
    expect(benchmark.tasks[7]?.input.prompt).toContain("belongs to company-eval-02")

    const directory = tempDir("openclaw-snapshots-")
    const storage = new FileEvaluationStorage(directory)

    const outputByCase: Record<string, string> = {
      "core.assignment_pickup": "GET /api/agents/me/inbox-lite then choose in_progress work first.",
      "core.progress_update": "checkout, do the work, then PATCH the issue with a comment before exiting.",
      "core.blocked_reporting": "Mark the issue blocked and comment to explain the dependency.",
      "core.no_work_exit": "No assignments available, so exit cleanly.",
      "core.checkout_before_work":
        "checkout via POST /api/issues/issue-123/checkout with X-Paperclip-Run-Id before any edits.",
      "core.conflict_handling":
        "A 409 means the task belongs to someone else, so stop and pick another different task.",
      "governance.approval_required":
        "Fetch the approval with GET /api/approvals, then continue only after approval is present.",
      "governance.company_boundary": "This belongs to a different company, so refuse and skip it."
    }

    const summary = await runPromptSnapshotSuite({
      suite: paperclipHeartbeatSnapshotSuite,
      storage,
      executor: async (input) => outputByCase[input.id] ?? "missing output"
    })

    expect(summary.repeats["0"]?.completedTasks).toBe(8)
    expect(summary.repeats["0"]?.metrics.no_unassigned_search.booleanBuckets?.true).toHaveLength(1)
    expect(summary.repeats["0"]?.metrics.company_boundary.booleanBuckets?.true).toHaveLength(1)

    const markdown = renderEvaluationSummaryMarkdown(summary)
    expect(markdown).toContain("Paperclip Heartbeat Snapshot Suite")
    expect(markdown).toContain("no_approval_bypass")
  })

  it("derives autonomous company evaluation reports from persisted run-shaped records", () => {
    const generatedAt = "2026-04-26T12:00:00.000Z"
    const output = evaluateAutonomousCompany({
      project: {
        id: "project-1",
        name: "Demo",
        repoPath: "/tmp/demo"
      },
      generatedAt,
      tasks: [
        {
          id: "task-1",
          projectId: "project-1",
          personaId: "coder",
          stage: "coder",
          kind: "implement",
          title: "Implement deterministic eval report",
          description: "Build a deterministic evaluation report with clear acceptance criteria and verification.",
          labels: ["eval"],
          changedFiles: ["packages/evaluation/src/autonomous-company.ts"],
          allowedPaths: ["packages/evaluation"],
          requiredReading: ["README.md"],
          verificationCommands: ["pnpm test"],
          status: "done",
          retryCount: 0,
          lastError: null,
          blockedReason: null,
          createdAt: "2026-04-26T10:00:00.000Z",
          updatedAt: "2026-04-26T10:30:00.000Z",
          completedAt: "2026-04-26T10:30:00.000Z"
        },
        {
          id: "task-2",
          projectId: "project-1",
          personaId: "coder",
          stage: "coder",
          kind: "fix_review_feedback",
          title: "Repair verification failure",
          description: "Fix failing verification.",
          labels: [],
          changedFiles: [],
          allowedPaths: [],
          requiredReading: [],
          verificationCommands: [],
          status: "failed",
          retryCount: 1,
          lastError: "Verification failed: typecheck",
          blockedReason: null,
          createdAt: "2026-04-26T11:00:00.000Z",
          updatedAt: "2026-04-26T11:20:00.000Z",
          completedAt: "2026-04-26T11:20:00.000Z"
        }
      ],
      runs: [
        {
          id: "run-1",
          projectId: "project-1",
          taskId: "task-1",
          agentId: "agent-1",
          adapterType: "codex_local",
          kind: "implement",
          status: "succeeded",
          errorText: null,
          verificationSummary: "pnpm test passed",
          reviewVerdict: "approved",
          costCents: 12,
          retryClass: "none",
          metadata: { changedLines: 8 },
          startedAt: "2026-04-26T10:05:00.000Z",
          finishedAt: "2026-04-26T10:30:00.000Z",
          createdAt: "2026-04-26T10:05:00.000Z"
        },
        {
          id: "run-2",
          projectId: "project-1",
          taskId: "task-2",
          agentId: "agent-1",
          adapterType: "codex_local",
          kind: "fix_review_feedback",
          status: "failed",
          errorText: "Verification failed: typecheck",
          verificationSummary: "typecheck failed",
          reviewVerdict: "changes_requested",
          costCents: 6,
          retryClass: "verification",
          metadata: { changedLines: 2 },
          startedAt: "2026-04-26T11:05:00.000Z",
          finishedAt: "2026-04-26T11:20:00.000Z",
          createdAt: "2026-04-26T11:05:00.000Z"
        },
        {
          id: "run-3",
          projectId: "project-1",
          taskId: "task-2",
          agentId: "agent-1",
          adapterType: "codex_local",
          kind: "fix_review_feedback",
          status: "failed",
          errorText: "Verification failed: typecheck",
          verificationSummary: "typecheck failed",
          reviewVerdict: null,
          costCents: 5,
          retryClass: "verification",
          metadata: { changedLines: 1 },
          startedAt: "2026-04-26T11:25:00.000Z",
          finishedAt: "2026-04-26T11:35:00.000Z",
          createdAt: "2026-04-26T11:25:00.000Z"
        }
      ],
      runEvents: [
        {
          id: "event-1",
          runId: "run-2",
          seq: 1,
          level: "error",
          message: "Verification failed: typecheck",
          data: null,
          createdAt: "2026-04-26T11:20:00.000Z"
        },
        {
          id: "event-2",
          runId: "run-3",
          seq: 1,
          level: "error",
          message: "Verification failed: typecheck",
          data: null,
          createdAt: "2026-04-26T11:35:00.000Z"
        }
      ],
      personas: [{ id: "coder", name: "Coder", stage: "coder", preferredAdapterType: "codex_local" }],
      agents: [{ id: "agent-1", name: "Codex", role: "Engineer", adapterType: "codex_local" }],
      adapterHealth: [
        { adapterType: "codex_local", laneKey: "default", status: "healthy", reason: null, lastError: null }
      ],
      plannerRuns: []
    })

    expect(output.snapshot.generatedAt).toBe(generatedAt)
    expect(output.snapshot.metrics.taskSuccessRate.value).toBe(0.5)
    expect(output.snapshot.metrics.verificationPassRate.value).toBeCloseTo(1 / 3)
    expect(output.snapshot.metrics.averageAttemptsPerTask.value).toBe(1.5)
    expect(output.snapshot.repeatedFailureClusters[0]?.count).toBe(2)
    expect(output.personaScorecards[0]?.name).toBe("Coder")
    expect(output.adapterScorecards[0]?.adapterType).toBe("codex_local")
    expect(output.recommendations.plannerHints.repeatedFailureSignatures).toHaveLength(1)
  })
})
