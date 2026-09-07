import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Task } from "@openclaw/domain"

import { loadProjectProfile } from "@openclaw/project-profiles"
import { afterEach, describe, expect, it } from "vitest"

import { collectRepoPlanningSnapshot } from "../packages/executor/src/planner/collect-signals.js"
import { createTempWorkspace } from "./helpers.js"

describe("planner signal collection", () => {
  const cleanups: Array<() => void> = []

  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.()
  })

  it("keeps repo-relative directory prefixes when collecting changed files", () => {
    const workspace = createTempWorkspace("planner-collect-signals")
    cleanups.push(workspace.cleanup)

    mkdirSync(join(workspace.repoPath, "apps", "backend", "lawyer_rag"), { recursive: true })
    mkdirSync(join(workspace.repoPath, "apps", "backend", "lawyer_rag", "incidents"), { recursive: true })
    mkdirSync(join(workspace.repoPath, "apps", "backend", "tests"), { recursive: true })
    mkdirSync(join(workspace.repoPath, "apps", "reports-ui", "src", "features", "timeline"), { recursive: true })
    mkdirSync(join(workspace.repoPath, "scripts"), { recursive: true })
    mkdirSync(join(workspace.repoPath, "docs"), { recursive: true })

    writeFileSync(join(workspace.repoPath, "apps", "backend", "lawyer_rag", "service.py"), "value = 1\n", "utf8")
    writeFileSync(
      join(workspace.repoPath, "apps", "backend", "lawyer_rag", "incidents", "todo_service.py"),
      "# TODO: reject invalid incident state\n",
      "utf8"
    )
    writeFileSync(
      join(workspace.repoPath, "apps", "backend", "lawyer_rag", "incidents", "eval_samples.jsonl"),
      '{"malformed_output_terms":["TODO"],"forbidden_output_terms":["FIXME"]}\n',
      "utf8"
    )
    writeFileSync(
      join(workspace.repoPath, "apps", "backend", "tests", "test_service.py"),
      "def test_ok():\n    assert True\n",
      "utf8"
    )
    writeFileSync(
      join(workspace.repoPath, "apps", "reports-ui", "src", "features", "timeline", "TimelineView.tsx"),
      "export const TimelineView = () => null\n",
      "utf8"
    )
    writeFileSync(
      join(workspace.repoPath, "apps", "reports-ui", "src", "features", "timeline", "TimelineView.test.tsx"),
      "test('ok', () => {})\n",
      "utf8"
    )
    writeFileSync(join(workspace.repoPath, "scripts", "collector.py"), "print('ok')\n", "utf8")
    writeFileSync(join(workspace.repoPath, "docs", "guide.md"), "# Guide\n", "utf8")

    execFileSync("git", ["init"], { cwd: workspace.repoPath })
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: workspace.repoPath })
    execFileSync("git", ["config", "user.name", "Planner Test"], { cwd: workspace.repoPath })
    execFileSync("git", ["add", "."], { cwd: workspace.repoPath })
    execFileSync("git", ["commit", "-m", "initial"], { cwd: workspace.repoPath })

    writeFileSync(join(workspace.repoPath, "apps", "backend", "lawyer_rag", "service.py"), "value = 2\n", "utf8")
    writeFileSync(
      join(workspace.repoPath, "apps", "reports-ui", "src", "features", "timeline", "TimelineView.tsx"),
      "export const TimelineView = () => 'updated'\n",
      "utf8"
    )
    writeFileSync(join(workspace.repoPath, "scripts", "collector.py"), "print('updated')\n", "utf8")
    writeFileSync(join(workspace.repoPath, "docs", "guide.md"), "# Updated Guide\n", "utf8")
    writeFileSync(join(workspace.repoPath, ".env.example"), "EXAMPLE=true\n", "utf8")

    const profile = loadProjectProfile("lawyerrag")
    profile.laneDefinitions.find((lane) => lane.laneId === "ui-primary-routes")!.publicFacades = [
      "apps/reports-ui/src/index.ts",
      "apps/reports-ui/src/index.ts"
    ]
    const snapshot = collectRepoPlanningSnapshot({
      project: {
        id: "project-1",
        companyId: "company-1",
        name: "LawyerRAG",
        repoPath: workspace.repoPath,
        verifyCommand: "pytest -q",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      profile,
      tasks: [
        {
          id: "fallback-task",
          title: "Recover blocked outcome: already recovered",
          kind: "implement",
          status: "blocked",
          laneId: "backend-incidents-and-timeline",
          labels: ["deterministic-fallback"],
          createdAt: "2026-07-13T08:00:00.000Z"
        } as Task,
        {
          id: "already-merged-task",
          title: "Already merged implementation",
          kind: "implement",
          status: "blocked",
          laneId: "backend-incidents-and-timeline",
          labels: [],
          createdAt: "2026-07-13T08:00:00.000Z"
        } as Task
      ],
      memoryHighlights: [],
      excludedStaleTaskIds: new Set(["already-merged-task"])
    })

    expect(snapshot.changedFiles).toEqual(
      expect.arrayContaining([
        ".env.example",
        "apps/backend/lawyer_rag/service.py",
        "apps/reports-ui/src/features/timeline/TimelineView.tsx",
        "docs/guide.md",
        "scripts/collector.py"
      ])
    )
    expect(snapshot.changedFiles).not.toEqual(
      expect.arrayContaining(["pps/backend/service.py", "cripts/collector.py", "ocs/guide.md"])
    )
    const timelineInventory = snapshot.laneInventory.find((entry) => entry.laneId === "ui-primary-routes")
    expect(timelineInventory?.publicFacades).toEqual(["apps/reports-ui/src/index.ts"])
    expect(timelineInventory?.fileCount).toBeGreaterThan(0)
    expect(timelineInventory?.testFileCount).toBeGreaterThan(0)
    expect(timelineInventory?.sampleFiles).toEqual(
      expect.arrayContaining(["apps/reports-ui/src/features/timeline/TimelineView.tsx"])
    )
    const contractInventory = snapshot.laneInventory.find((entry) => entry.laneId === "ui-contracts-and-api")
    expect(contractInventory?.publicFacades).toEqual(
      expect.arrayContaining(["contracts/openapi.yaml", "apps/reports-ui/src/lib/api.ts"])
    )
    expect(snapshot.todoFixmeHits).toContainEqual({
      path: "apps/backend/lawyer_rag/incidents/todo_service.py",
      line: 1,
      text: "# TODO: reject invalid incident state",
      laneId: "backend-incidents-and-timeline"
    })
    expect(snapshot.todoFixmeHits.map((hit) => hit.path)).not.toContain(
      "apps/backend/lawyer_rag/incidents/eval_samples.jsonl"
    )
    expect(snapshot.staleTasks).toEqual([])
  })

  it("filters bracketed template placeholders without suppressing actionable TODOs", () => {
    const workspace = createTempWorkspace("planner-template-todos")
    cleanups.push(workspace.cleanup)

    mkdirSync(join(workspace.repoPath, "src"), { recursive: true })
    mkdirSync(join(workspace.repoPath, "tests"), { recursive: true })
    mkdirSync(join(workspace.repoPath, "skills", "self-improving-agent", "scripts"), { recursive: true })

    writeFileSync(join(workspace.repoPath, "src", "service.ts"), "// TODO: retry transient failures\n", "utf8")
    writeFileSync(join(workspace.repoPath, "tests", "service.test.ts"), "// FIXME: cover timeout handling\n", "utf8")
    writeFileSync(
      join(workspace.repoPath, "skills", "self-improving-agent", "scripts", "extract-skill.sh"),
      [
        'description: "[TODO: Add a concise description of what this skill does and when to use it]"',
        "[TODO: Brief introduction explaining the skill's purpose]",
        "- Learning ID: [TODO: Add original learning ID]"
      ].join("\n"),
      "utf8"
    )

    writeFileSync(join(workspace.repoPath, "src", "mixed.ts"), "// [TODO: example] FIXME: handle real failure\n")
    execFileSync("git", ["init"], { cwd: workspace.repoPath })
    execFileSync("git", ["add", "."], { cwd: workspace.repoPath })

    const snapshot = collectRepoPlanningSnapshot({
      project: {
        id: "project-1",
        companyId: "company-1",
        name: "Template TODO filtering",
        repoPath: workspace.repoPath,
        verifyCommand: "pnpm test",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      profile: loadProjectProfile("lawyerrag"),
      tasks: [],
      memoryHighlights: []
    })

    expect(snapshot.todoFixmeHits).toHaveLength(3)
    expect(snapshot.todoFixmeHits.map(({ path, text }) => ({ path, text }))).toEqual(
      expect.arrayContaining([
        { path: "src/service.ts", text: "// TODO: retry transient failures" },
        { path: "src/mixed.ts", text: "// [TODO: example] FIXME: handle real failure" },
        { path: "tests/service.test.ts", text: "// FIXME: cover timeout handling" }
      ])
    )
  })
})
