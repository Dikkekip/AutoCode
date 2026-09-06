import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { scaffoldCodexOrchestra } from "@openclaw/orchestra-codex"
import { afterEach, describe, expect, it } from "vitest"

import { createTempWorkspace } from "./helpers.js"

describe("orchestra codex", () => {
  const cleanups: Array<() => void> = []

  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.()
  })

  it("emits machine-readable task, plan, manifest, and reviewer handoff artifacts", () => {
    const workspace = createTempWorkspace("orchestra-codex")
    cleanups.push(workspace.cleanup)
    const outputDir = join(workspace.repoPath, ".codex", "orchestra-runs", "test-run")

    const result = scaffoldCodexOrchestra({
      prompt: "Extract the conductor runtime into a repo-agnostic package",
      taskId: "task-123",
      lane: "backend-ingestion-and-aiops",
      outputDir,
      subagents: 2,
      taskPackage: {
        version: 1,
        generatedAt: new Date().toISOString(),
        repoProfile: "lawyerrag",
        likelyOwnershipLane: "backend-ingestion-and-aiops",
        laneReason: "backend extraction task",
        inferenceSignals: ["profile:lawyerrag"],
        requiredReading: ["scripts/openclaw_director.py", "scripts/codex_orchestra.py"],
        verificationChecklist: ["pnpm build", "pnpm test"],
        contractUpdateReminders: ["Preserve reviewer handoff compatibility."],
        repoNotes: ["Keep the core repo-agnostic."]
      }
    })

    expect(result.plan.subtasks).toHaveLength(2)
    expect(result.manifest.status).toBe("planned")
    expect(result.reviewerHandoff.status).toBe("needs_review")

    expect(existsSync(join(outputDir, "promptify.json"))).toBe(true)
    expect(existsSync(join(outputDir, "plan.json"))).toBe(true)
    expect(existsSync(join(outputDir, "run-manifest.json"))).toBe(true)
    expect(existsSync(join(outputDir, "reviewer-handoff.json"))).toBe(true)
    expect(existsSync(join(outputDir, "runbook.md"))).toBe(true)

    const manifest = JSON.parse(readFileSync(join(outputDir, "run-manifest.json"), "utf8")) as {
      taskId: string
      lane: string
      testsRun: string[]
    }
    expect(manifest.taskId).toBe("task-123")
    expect(manifest.lane).toBe("backend-ingestion-and-aiops")
    expect(manifest.testsRun).toContain("pnpm build")
  })
})
