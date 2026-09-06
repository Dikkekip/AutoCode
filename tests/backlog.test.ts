import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createTempWorkspace } from "./helpers.js"
import { HAS_NODE_SQLITE } from "./node-sqlite.js"

let DispatcherStore: typeof import("@openclaw/db").DispatcherStore | null = null
let runCli: typeof import("../apps/dispatcher-cli/src/index.js").runCli | null = null
if (HAS_NODE_SQLITE) {
  ;({ DispatcherStore } = await import("@openclaw/db"))
  ;({ runCli } = await import("../apps/dispatcher-cli/src/index.js"))
}

const describeDb = HAS_NODE_SQLITE ? describe : describe.skip

describeDb("autonomous backlog generator", () => {
  const cleanups: Array<() => void> = []

  afterEach(() => {
    while (cleanups.length > 0) {
      cleanups.pop()?.()
    }
  })

  async function setup(output: string[]) {
    const workspace = createTempWorkspace("backlog-generator")
    cleanups.push(workspace.cleanup)
    mkdirSync(join(workspace.repoPath, "src"), { recursive: true })
    writeFileSync(
      join(workspace.repoPath, "src", "index.ts"),
      [
        "export function work() {",
        "  // TODO: add regression coverage before changing this path",
        "  return 1",
        "}"
      ].join("\n"),
      "utf8"
    )
    writeFileSync(
      join(workspace.repoPath, "package.json"),
      JSON.stringify({ name: "fixture", scripts: { test: 'node -e "process.exit(0)"' } }, null, 2),
      "utf8"
    )

    const io = {
      stdout: (message: string) => output.push(message),
      stderr: (message: string) => output.push(message)
    }

    await runCli!(["--db", workspace.dbPath, "init"], io)
    await runCli!(["--db", workspace.dbPath, "company", "create", "OpenClaw Labs"], io)
    await runCli!(["--db", workspace.dbPath, "project", "add", "repo", "--repo-path", workspace.repoPath], io)
    return { workspace, io }
  }

  it("persists candidates and accepts one into a task package", async () => {
    const output: string[] = []
    const { workspace, io } = await setup(output)

    await runCli!(["--db", workspace.dbPath, "backlog", "generate", "--project", "repo", "--skip-commands"], io)

    const store = new DispatcherStore!(workspace.dbPath)
    try {
      const project = store.resolveProject("repo")
      const candidates = store.listBacklogCandidates(project.id, "candidate")
      expect(candidates.length).toBeGreaterThan(0)
      expect(candidates[0]!.valueScore).toBeGreaterThan(0)
      expect(candidates[0]!.riskScore).toBeGreaterThan(0)
      expect(candidates[0]!.reason.length).toBeGreaterThan(0)

      await runCli!(["--db", workspace.dbPath, "backlog", "accept", candidates[0]!.id], io)

      const accepted = store.getBacklogCandidateById(candidates[0]!.id)
      expect(accepted.status).toBe("accepted")
      expect(accepted.acceptedTaskId).toBeTruthy()
      const task = store.getTaskById(accepted.acceptedTaskId!)
      expect(task.labels).toContain("backlog-accepted")
      expect(task.taskPackage?.repoProfile).toBe("backlog-generator")
      expect(task.taskPackage?.inferenceSignals.length).toBeGreaterThan(0)
    } finally {
      store.close()
    }

    const fullOutput = output.join("\n")
    expect(fullOutput).toContain("Prioritized backlog:")
    expect(fullOutput).toContain("Generated task package:")
  })

  it("does not create duplicate queued work for an accepted candidate", async () => {
    const output: string[] = []
    const { workspace, io } = await setup(output)

    await runCli!(["--db", workspace.dbPath, "backlog", "generate", "--project", "repo", "--skip-commands"], io)
    const store = new DispatcherStore!(workspace.dbPath)
    try {
      const project = store.resolveProject("repo")
      const candidate = store.listBacklogCandidates(project.id, "candidate")[0]!
      await runCli!(["--db", workspace.dbPath, "backlog", "accept", candidate.id], io)
      const beforeTasks = store.listProjectTasks(project.id).length

      await runCli!(["--db", workspace.dbPath, "backlog", "generate", "--project", "repo", "--skip-commands"], io)

      expect(store.listProjectTasks(project.id)).toHaveLength(beforeTasks)
      expect(store.getBacklogCandidateById(candidate.id).status).toBe("accepted")
    } finally {
      store.close()
    }

    expect(output.join("\n")).toContain("duplicates=")
  })
})
