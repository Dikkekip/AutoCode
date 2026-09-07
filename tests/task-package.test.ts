import { afterEach, describe, expect, it } from "vitest"
import type { DispatchableTaskPackage } from "../apps/dispatcher-cli/src/task-factory.js"
import { createFakeCodexScript, createTempWorkspace, seedLawyerRagRepo } from "./helpers.js"
import { HAS_NODE_SQLITE } from "./node-sqlite.js"

let DispatcherStore: typeof import("@openclaw/db").DispatcherStore | null = null
let runCli: typeof import("../apps/dispatcher-cli/src/index.js").runCli | null = null
if (HAS_NODE_SQLITE) {
  ;({ DispatcherStore } = await import("@openclaw/db"))
  ;({ runCli } = await import("../apps/dispatcher-cli/src/index.js"))
}

const describeDb = HAS_NODE_SQLITE ? describe : describe.skip

describeDb("task package generation", () => {
  const cleanups: Array<() => void> = []

  afterEach(() => {
    while (cleanups.length > 0) {
      cleanups.pop()?.()
    }
  })

  async function setup(ioOutput: string[]) {
    const workspace = createTempWorkspace("lawyerrag-task-package")
    cleanups.push(workspace.cleanup)
    seedLawyerRagRepo(workspace.repoPath)

    const io = {
      stdout: (message: string) => ioOutput.push(message),
      stderr: (message: string) => ioOutput.push(message)
    }

    await runCli!(["--db", workspace.dbPath, "init"], io)
    await runCli!(["--db", workspace.dbPath, "company", "create", "OpenClaw Labs"], io)
    await runCli!(["--db", workspace.dbPath, "project", "add", "repo", "--repo-path", workspace.repoPath], io)

    return { workspace, io }
  }

  it("creates a backend package with backend reading, verification, and log visibility", async () => {
    const output: string[] = []
    const { workspace, io } = await setup(output)
    const codexScript = createFakeCodexScript(workspace.root)

    await runCli!(
      [
        "--db",
        workspace.dbPath,
        "agent",
        "add",
        "codex",
        "--role",
        "Engineer",
        "--adapter",
        "codex_local",
        "--command",
        codexScript
      ],
      io
    )

    await runCli!(
      [
        "--db",
        workspace.dbPath,
        "task",
        "create",
        "Implement backend endpoint",
        "--project",
        "repo",
        "--label",
        "backend",
        "--changed-file",
        "apps/backend/app.py"
      ],
      io
    )

    const store = new DispatcherStore!(workspace.dbPath)
    try {
      const task = store.listTasks()[0]!
      expect(task.taskPackage?.likelyOwnershipLane).toBe("backend")
      expect(task.taskPackage?.requiredReading).toContain("agent/rules/development-workflow.md")
      expect(task.taskPackage?.requiredReading).toContain("specs/043-backend-implementation-index/spec.md")
      expect(task.taskPackage?.verificationChecklist).toContain("make test-openapi")
      expect(task.taskPackage?.verificationChecklist).toContain(
        'cd apps/backend && uv run pytest --no-cov tests/contracts/ -v -m "contract or openapi or backward_compat"'
      )
      expect(task.taskPackage?.contractUpdateReminders.length).toBeGreaterThan(0)

      await runCli!(["--db", workspace.dbPath, "tick"], io)
      const run = store.listRuns()[0]!
      await runCli!(["--db", workspace.dbPath, "run", "logs", run.id], io)
    } finally {
      store.close()
    }

    const fullOutput = output.join("\n")
    expect(fullOutput).toContain("Generated task package:")
    expect(fullOutput).toContain("likely ownership lane: backend")
    expect(fullOutput).toContain("Task package attached")
    expect(fullOutput).toContain("agent/rules/development-workflow.md")
  }, 15_000)

  it("creates a UI package with UI docs and audit checks", async () => {
    const output: string[] = []
    const { workspace, io } = await setup(output)

    await runCli!(
      [
        "--db",
        workspace.dbPath,
        "task",
        "create",
        "Polish reports UI",
        "--project",
        "repo",
        "--label",
        "ui",
        "--changed-file",
        "apps/reports-ui/src/pages/home.tsx"
      ],
      io
    )

    const store = new DispatcherStore!(workspace.dbPath)
    try {
      const task = store.listTasks()[0]!
      expect(task.taskPackage?.likelyOwnershipLane).toBe("ui")
      expect(task.taskPackage?.requiredReading).toContain("apps/reports-ui/APPLICATION_DESIGN_PRINCIPLES.md")
      expect(task.taskPackage?.requiredReading).toContain("apps/reports-ui/STYLE_RECIPE.md")
      expect(task.taskPackage?.verificationChecklist).toContain("cd apps/reports-ui && npm run check")
      expect(task.taskPackage?.verificationChecklist).toContain("cd apps/reports-ui && npm run ui:audit")
    } finally {
      store.close()
    }

    const fullOutput = output.join("\n")
    expect(fullOutput).toContain("likely ownership lane: ui")
    expect(fullOutput).toContain("apps/reports-ui/APPLICATION_DESIGN_PRINCIPLES.md")
    expect(fullOutput).toContain("cd apps/reports-ui && npm run ui:audit")
  })

  it("supports preview mode without persisting a task", async () => {
    const output: string[] = []
    const { workspace, io } = await setup(output)

    await runCli!(
      [
        "--db",
        workspace.dbPath,
        "task",
        "create",
        "Preview UI package",
        "--project",
        "repo",
        "--label",
        "ui",
        "--preview"
      ],
      io
    )

    const store = new DispatcherStore!(workspace.dbPath)
    try {
      expect(store.listTasks()).toHaveLength(0)
    } finally {
      store.close()
    }

    const fullOutput = output.join("\n")
    expect(fullOutput).toContain("Preview for task Preview UI package")
    expect(fullOutput).toContain("task creation: skipped")
    expect(fullOutput).toContain("likely ownership lane: ui")
  })

  it("generates validated dispatchable tasks, dedupes reruns, and persists dependencies", async () => {
    const output: string[] = []
    const { workspace, io } = await setup(output)
    const goal = [
      "Build a task factory that turns high-level goals into small, dispatchable coding tasks.",
      "",
      "CLI:",
      '- dispatcher task generate --project <project> --goal "..."',
      "- dispatcher task generate --dry-run",
      "",
      "Acceptance criteria:",
      "- Generated tasks pass schema validation.",
      "- Duplicate detection works.",
      "- Task dependencies are persisted. [depends-on: 1]"
    ].join("\n")

    await runCli!(
      ["--db", workspace.dbPath, "task", "generate", "--project", "repo", "--profile", "minimal-repo", "--goal", goal],
      io
    )

    const store = new DispatcherStore!(workspace.dbPath)
    try {
      const project = store.resolveProject("repo")
      const tasks = store.listProjectTasks(project.id)
      const firstPackage = tasks[0]?.taskPackage as DispatchableTaskPackage | undefined
      expect(tasks.length).toBeGreaterThanOrEqual(3)
      expect(tasks.every((task) => task.labels.some((label) => label.startsWith("task-factory-dedupe:")))).toBe(true)
      expect(firstPackage?.title).toBeTruthy()
      expect(firstPackage?.problemStatement).toBeTruthy()
      expect(firstPackage?.relevantFiles).toEqual(expect.arrayContaining(["packages/domain/src/index.ts"]))
      expect(firstPackage?.repoNotes).toEqual(
        expect.arrayContaining([expect.stringContaining("Lane public facades to keep stable or update deliberately")])
      )
      expect(firstPackage?.extraInstructions).toEqual(
        expect.arrayContaining([expect.stringContaining("Audit the lane public facades before editing internals")])
      )
      expect(firstPackage?.verificationCommands.length).toBeGreaterThan(0)
      expect(firstPackage?.rollbackGuidance).toContain("Revert")
      const generatedPackages = tasks.map((task) => task.taskPackage as DispatchableTaskPackage)
      const dependentPackage = generatedPackages.find((taskPackage) => taskPackage.dependencies.length > 0)
      const dependentTask = tasks.find((task) => task.taskPackage === dependentPackage)
      const prerequisiteTask = tasks.find((task) =>
        dependentPackage?.dependencies.includes((task.taskPackage as DispatchableTaskPackage).dedupeKey)
      )
      expect(dependentTask?.dependsOnTaskIds).toContain(prerequisiteTask?.id)
      expect(
        tasks.filter((task) => task.id !== dependentTask?.id).some((task) => task.dependsOnTaskIds.length === 0)
      ).toBe(true)

      await runCli!(
        [
          "--db",
          workspace.dbPath,
          "task",
          "generate",
          "--project",
          "repo",
          "--profile",
          "minimal-repo",
          "--goal",
          goal
        ],
        io
      )

      expect(store.listProjectTasks(project.id)).toHaveLength(tasks.length)
    } finally {
      store.close()
    }

    const fullOutput = output.join("\n")
    expect(fullOutput).toContain("task_factory.generated=")
    expect(fullOutput).toContain("task_factory.skipped_duplicates=")
    expect(fullOutput).toContain('"dependencies"')
  })

  it("supports task factory dry-run without persisting generated tasks", async () => {
    const output: string[] = []
    const { workspace, io } = await setup(output)

    await runCli!(
      [
        "--db",
        workspace.dbPath,
        "task",
        "generate",
        "--profile",
        "minimal-repo",
        "--goal",
        "Add duplicate detection and persist dependencies.",
        "--dry-run"
      ],
      io
    )

    const store = new DispatcherStore!(workspace.dbPath)
    try {
      expect(store.listTasks()).toHaveLength(0)
    } finally {
      store.close()
    }

    expect(output.join("\n")).toContain("task_factory.dry_run=true")
  })

  it("routes domain goals through LawyerRAG persona metadata", async () => {
    const output: string[] = []
    const { workspace, io } = await setup(output)

    await runCli!(
      [
        "--db",
        workspace.dbPath,
        "task",
        "generate",
        "--project",
        "repo",
        "--profile",
        "lawyerrag",
        "--goal",
        "Improve evidence chronology for Barnevern case review without changing production behavior.",
        "--dry-run"
      ],
      io
    )

    const rendered = output.join("\n")
    expect(rendered).toContain('"personaId": "barnevern-domain-specialist"')
    expect(rendered).toContain('"portfolioBucket": "legal_domain"')
    expect(rendered).toContain('"adapterPreference": "azure_foundry"')
  })

  it("renders an existing task package into a Codex-ready prompt", async () => {
    const output: string[] = []
    const { workspace, io } = await setup(output)

    await runCli!(
      [
        "--db",
        workspace.dbPath,
        "persona",
        "add",
        "prompt-engineer",
        "--stage",
        "coder",
        "--adapter",
        "codex_local",
        "--owned-lane",
        "backend"
      ],
      io
    )
    await runCli!(
      [
        "--db",
        workspace.dbPath,
        "task",
        "create",
        "Render task package prompt",
        "--project",
        "repo",
        "--label",
        "backend",
        "--changed-file",
        "apps/backend/app.py"
      ],
      io
    )

    const store = new DispatcherStore!(workspace.dbPath)
    const task = store.listTasks()[0]!
    store.close()

    output.length = 0
    await runCli!(["--db", workspace.dbPath, "prompt", "render", "--task", task.id, "--persona", "prompt-engineer"], io)

    const fullOutput = output.join("\n")
    expect(fullOutput).toContain("# Codex Task Prompt")
    expect(fullOutput).toContain("## 1. Persona Identity")
    expect(fullOutput).toContain("You are prompt-engineer")
    expect(fullOutput).toContain("## 7. Verification Commands")
    expect(fullOutput).toContain("make test-openapi")
    expect(fullOutput).toContain("## 10. Failure Or Blocked Reporting Format")
  })

  it("renders an ad hoc Codex prompt from title, persona, and project", async () => {
    const output: string[] = []
    const { workspace, io } = await setup(output)

    await runCli!(
      [
        "--db",
        workspace.dbPath,
        "persona",
        "add",
        "security-reviewer",
        "--stage",
        "reviewer",
        "--adapter",
        "codex_local",
        "--owned-lane",
        "backend"
      ],
      io
    )

    output.length = 0
    await runCli!(
      [
        "--db",
        workspace.dbPath,
        "prompt",
        "render",
        "--title",
        "Review backend auth boundaries",
        "--project",
        "repo",
        "--persona",
        "security-reviewer",
        "--template",
        "security-review",
        "--label",
        "backend"
      ],
      io
    )

    const fullOutput = output.join("\n")
    expect(fullOutput).toContain("You are security-reviewer")
    expect(fullOutput).toContain("Prompt template: security-review")
    expect(fullOutput).toContain("## 7. Verification Commands")
    expect(fullOutput).toContain("make test-openapi")
  })
})
