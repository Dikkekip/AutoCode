import { existsSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { type OrchestraAdapter, type OrchestraExecutionContext, OrchestraRunner } from "./index.js"

describe("OrchestraRunner", () => {
  const mockAdapter: OrchestraAdapter = {
    execute: vi.fn(async (stage, prompt) => {
      if (stage === "promptify") {
        return {
          ok: true,
          response: JSON.stringify({
            normalizedPrompt: "Do X",
            intent: "feature",
            scope: ["src/"],
            constraints: [],
            assumptions: [],
            acceptanceCriteria: ["X is done"],
            risks: [],
            paths: [],
            slug: "do-x"
          })
        }
      }
      if (stage === "plan") {
        return {
          ok: true,
          response: JSON.stringify({
            summary: "Plan for X",
            implementationPlan: ["Step 1", "Step 2"],
            subtasks: [
              {
                id: "A1",
                label: "T1",
                goal: "G1",
                prompt: "P1",
                files: ["f1"],
                dependsOn: [],
                deliverables: [],
                validation: []
              },
              {
                id: "A2",
                label: "T2",
                goal: "G2",
                prompt: "P2",
                files: ["f2"],
                dependsOn: ["A1"],
                deliverables: [],
                validation: []
              },
              {
                id: "A3",
                label: "T3",
                goal: "G3",
                prompt: "P3",
                files: ["f3"],
                dependsOn: [],
                deliverables: [],
                validation: []
              }
            ],
            integrationNotes: [],
            finalValidation: ["Tests pass"],
            branchHint: "feat/x"
          })
        }
      }
      if (stage === "execute") {
        return { ok: true, response: "Success" }
      }
      return { ok: false, error: "Unknown stage", response: "" }
    })
  }

  const context: OrchestraExecutionContext = {
    taskId: "task-1",
    lane: "lane-1",
    userPrompt: "Please do X",
    outputDir: "/tmp/orchestra-test",
    taskPackage: null,
    subagentCount: 3,
    lineage: null,
    maxParallelSubtasks: 2
  }

  it("should run the full orchestration pipeline", async () => {
    // Cleanup
    if (existsSync(context.outputDir)) {
      rmSync(context.outputDir, { recursive: true })
    }

    const runner = new OrchestraRunner(mockAdapter, context)
    const result = await runner.run()

    expect(result.promptify.normalizedPrompt).toBe("Do X")
    expect(result.plan.subtasks).toHaveLength(3)
    expect(existsSync(join(context.outputDir, "run-manifest.json"))).toBe(true)
    expect(existsSync(join(context.outputDir, "integration_prompt.md"))).toBe(true)

    const manifest = JSON.parse(readFileSync(join(context.outputDir, "run-manifest.json"), "utf8"))
    expect(manifest.taskId).toBe("task-1")
  })

  it("should run subtasks with bounded parallelism and respect dependencies", async () => {
    const runner = new OrchestraRunner(mockAdapter, context)
    const plan = {
      summary: "X",
      implementationPlan: [],
      subtasks: [
        { id: "A1", label: "T1", goal: "G1", prompt: "P1", files: [], dependsOn: [], deliverables: [], validation: [] },
        {
          id: "A2",
          label: "T2",
          goal: "G2",
          prompt: "P2",
          files: [],
          dependsOn: ["A1"],
          deliverables: [],
          validation: []
        },
        { id: "A3", label: "T3", goal: "G3", prompt: "P3", files: [], dependsOn: [], deliverables: [], validation: [] }
      ],
      integrationNotes: [],
      finalValidation: [],
      branchHint: "x"
    }

    const results = await runner.runSubtasks(plan)

    expect(results["A1"]?.ok).toBe(true)
    expect(results["A2"]?.ok).toBe(true)
    expect(results["A3"]?.ok).toBe(true)

    // Verify A1 ran before A2
    const calls = (mockAdapter.execute as any).mock.calls
    const a1Index = calls.findIndex((c: any) => c[1] === "P1")
    const a2Index = calls.findIndex((c: any) => c[1] === "P2")
    expect(a1Index).toBeLessThan(a2Index)
  })
})
