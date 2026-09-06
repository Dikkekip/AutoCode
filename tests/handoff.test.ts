import { existsSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { createTempWorkspace } from "./helpers.js"
import { HAS_NODE_SQLITE } from "./node-sqlite.js"

let DispatcherStore: typeof import("@openclaw/db").DispatcherStore | null = null
let runCli: typeof import("../apps/dispatcher-cli/src/index.js").runCli | null = null
if (HAS_NODE_SQLITE) {
  ;({ DispatcherStore } = await import("@openclaw/db"))
  ;({ runCli } = await import("../apps/dispatcher-cli/src/index.js"))
}

const describeDb = HAS_NODE_SQLITE ? describe : describe.skip

describeDb("persona handoffs", () => {
  it("validates, persists, explains, and accepts a handoff into a task package", async () => {
    const workspace = createTempWorkspace("dispatcher-handoff")
    const output: string[] = []
    const io = {
      stdout: (message: string) => output.push(message),
      stderr: (message: string) => output.push(message)
    }

    try {
      await runCli!(["--db", workspace.dbPath, "init"], io)
      await runCli!(["--db", workspace.dbPath, "company", "create", "OpenClaw Labs"], io)
      await runCli!(["--db", workspace.dbPath, "project", "add", "repo", "--repo-path", workspace.repoPath], io)

      await runCli!(
        [
          "--db",
          workspace.dbPath,
          "handoff",
          "create",
          "--project",
          "repo",
          "--source",
          "Backend Engineer",
          "--target",
          "QA Engineer",
          "--context",
          "Backend implementation is ready for verification.",
          "--completed-work",
          "Added service handler",
          "--open-question",
          "Should the timeout be stricter?",
          "--risk",
          "Contract tests may need fixture updates",
          "--required-file",
          "packages/api/src/service.ts",
          "--verification-status",
          "partial",
          "--verification-summary",
          "Unit tests passed; contract suite not run.",
          "--verification-evidence",
          "pnpm test packages/api",
          "--next-action",
          "Run the QA verification checklist.",
          "--scope",
          "QA may inspect tests and fixtures only.",
          "--scope-path",
          "packages/api",
          "--scope-command",
          "pnpm test",
          "--scope-constraint",
          "Do not change production code."
        ],
        io
      )

      const store = new DispatcherStore!(workspace.dbPath)
      try {
        const handoff = store.listHandoffs()[0]!
        expect(handoff.artifact.sourcePersona).toBe("Backend Engineer")
        expect(handoff.artifact.targetPersona).toBe("QA Engineer")
        expect(handoff.artifact.verificationStatus.status).toBe("partial")
        expect(existsSync(handoff.artifactPath)).toBe(true)

        await runCli!(["--db", workspace.dbPath, "handoff", "explain", handoff.id], io)
        await runCli!(["--db", workspace.dbPath, "handoff", "accept", handoff.id], io)

        const accepted = store.getHandoffById(handoff.id)
        expect(accepted.status).toBe("accepted")
        expect(accepted.targetTaskId).toBeTruthy()
        const task = store.getTaskById(accepted.targetTaskId!)
        expect(task.labels).toContain(`handoff:${handoff.id}`)
        expect(task.taskPackage?.requiredReading).toContain("packages/api/src/service.ts")
        expect(task.taskPackage?.verificationChecklist).toContain("pnpm test")
        expect(task.description).toContain("Backend implementation is ready for verification.")
      } finally {
        store.close()
      }

      const fullOutput = output.join("\n")
      expect(fullOutput).toContain("Created handoff")
      expect(fullOutput).toContain("Context: Backend implementation is ready for verification.")
      expect(fullOutput).toContain("Generated task package:")
    } finally {
      workspace.cleanup()
    }
  })
})
