import { afterEach, describe, expect, it } from "vitest"

import { interpretAskCommand } from "../apps/dispatcher-cli/src/ask.js"
import { createTempWorkspace } from "./helpers.js"
import { HAS_NODE_SQLITE } from "./node-sqlite.js"

let DispatcherStore: typeof import("@openclaw/db").DispatcherStore | null = null
let runCli: typeof import("../apps/dispatcher-cli/src/index.js").runCli | null = null
if (HAS_NODE_SQLITE) {
  ;({ DispatcherStore } = await import("@openclaw/db"))
  ;({ runCli } = await import("../apps/dispatcher-cli/src/index.js"))
}

const describeDb = HAS_NODE_SQLITE ? describe : describe.skip

describe("natural-language command interpretation", () => {
  it.each([
    ["Improve this repo for production readiness.", "production_readiness", "create_workflow"],
    ["Find the riskiest architecture problems.", "architecture_risk_scan", "create_task"],
    ["Generate 10 small UI polish tasks.", "ui_polish_tasks", "create_many_tasks"],
    ["Let Codex fix failing tests.", "codex_fix_tests", "create_task"],
    ["Review all completed runs.", "review_completed_runs", "read_completed_runs"],
    ["Create PRs for safe approved changes.", "create_safe_prs", "run_job"],
    ["Explain why the director stopped.", "explain_director_stop", "explain_director_stop"]
  ])("maps %s", (utterance, intent, actionType) => {
    const interpreted = interpretAskCommand(utterance)

    expect(interpreted.intent).toBe(intent)
    expect(interpreted.action.type).toBe(actionType)
  })

  it("blocks production or deployment actions from natural language", () => {
    const interpreted = interpretAskCommand("Deploy this to production now")

    expect(interpreted.intent).toBe("deployment_or_production_action")
    expect(interpreted.action.type).toBe("block")
    expect(interpreted.dangerous).toBe(true)
  })

  it("turns ambiguous commands into a clarification with a dry-run proposal", () => {
    const interpreted = interpretAskCommand("Make it better")

    expect(interpreted.intent).toBe("ambiguous")
    expect(interpreted.action.type).toBe("clarify")
    if (interpreted.action.type === "clarify") {
      expect(interpreted.action.proposal).toContain("Dry-run proposal")
    }
  })
})

describeDb("dispatcher ask command", () => {
  const cleanups: Array<() => void> = []

  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.()
  })

  it("persists dry-run interpretations without creating tasks", async () => {
    const workspace = createTempWorkspace("dispatcher-ask-dry-run")
    cleanups.push(workspace.cleanup)
    const output: string[] = []
    const io = {
      stdout: (message: string) => output.push(message),
      stderr: (message: string) => output.push(message)
    }

    const store = new DispatcherStore!(workspace.dbPath)
    store.migrate()
    const company = store.createCompany({ name: "OpenClaw Labs" })
    const project = store.createProject({ companyRef: company.id, name: "repo", repoPath: workspace.repoPath })
    store.close()

    await runCli!(
      ["--db", workspace.dbPath, "ask", "Generate 10 small UI polish tasks.", "--project", project.id, "--dry-run"],
      io
    )

    const reopened = new DispatcherStore!(workspace.dbPath)
    reopened.migrate()
    const commands = reopened.listInterpretedCommands()
    const tasks = reopened.listProjectTasks(project.id)
    reopened.close()

    expect(output.join("\n")).toContain("execution: skipped (dry-run)")
    expect(commands).toHaveLength(1)
    expect(commands[0]?.intent).toBe("ui_polish_tasks")
    expect(commands[0]?.status).toBe("dry_run")
    expect(tasks).toHaveLength(0)
  })

  it("creates interpreted tasks only when --yes is passed", async () => {
    const workspace = createTempWorkspace("dispatcher-ask-yes")
    cleanups.push(workspace.cleanup)
    const output: string[] = []
    const io = {
      stdout: (message: string) => output.push(message),
      stderr: (message: string) => output.push(message)
    }

    const store = new DispatcherStore!(workspace.dbPath)
    store.migrate()
    const company = store.createCompany({ name: "OpenClaw Labs" })
    const project = store.createProject({ companyRef: company.id, name: "repo", repoPath: workspace.repoPath })
    store.close()

    await runCli!(
      ["--db", workspace.dbPath, "ask", "Generate 3 small UI polish tasks.", "--project", project.id, "--yes"],
      io
    )

    const reopened = new DispatcherStore!(workspace.dbPath)
    reopened.migrate()
    const commands = reopened.listInterpretedCommands()
    const tasks = reopened.listProjectTasks(project.id)
    reopened.close()

    expect(output.join("\n")).toContain("status: executed")
    expect(commands[0]?.intent).toBe("ui_polish_tasks")
    expect(commands[0]?.status).toBe("executed")
    expect(tasks).toHaveLength(3)
  })
})
