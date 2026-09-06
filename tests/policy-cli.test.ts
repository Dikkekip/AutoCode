import { describe, expect, it } from "vitest"
import { createTempWorkspace } from "./helpers.js"
import { HAS_NODE_SQLITE } from "./node-sqlite.js"

let runCli: typeof import("../apps/dispatcher-cli/src/index.js").runCli | null = null
if (HAS_NODE_SQLITE) {
  ;({ runCli } = await import("../apps/dispatcher-cli/src/index.js"))
}

const describeDb = HAS_NODE_SQLITE ? describe : describe.skip

describeDb("dispatcher policy CLI", () => {
  it("checks task policy and validates project policy defaults", async () => {
    const workspace = createTempWorkspace("dispatcher-policy-cli")
    const stdout: string[] = []
    const stderr: string[] = []
    const io = {
      stdout: (message: string) => stdout.push(message),
      stderr: (message: string) => stderr.push(message)
    }

    try {
      await runCli!(["--db", workspace.dbPath, "company", "create", "Acme"], io)
      await runCli!(
        ["--db", workspace.dbPath, "project", "add", "repo", "--repo-path", workspace.repoPath, "--company", "Acme"],
        io
      )
      await runCli!(
        [
          "--db",
          workspace.dbPath,
          "task",
          "create",
          "Run production database migration",
          "--project",
          "repo",
          "--label",
          "risk:high",
          "--changed-file",
          "migrations/001.sql"
        ],
        io
      )
      const ids = Array.from(stdout.join("\n").matchAll(/id: ([0-9a-f-]+)/g)).map((match) => match[1])
      const taskId = ids.at(-1)
      expect(taskId).toBeTruthy()

      await runCli!(["--db", workspace.dbPath, "policy", "check", "--task", taskId!], io)
      await runCli!(["--db", workspace.dbPath, "policy", "validate", "--project", "repo"], io)

      const output = stdout.join("\n")
      expect(output).toContain("allowed: false")
      expect(output).toContain("blocked: database.migrate")
      expect(output).toContain("policy_file: not found; framework defaults apply")
      expect(stderr).toHaveLength(0)
    } finally {
      workspace.cleanup()
    }
  })
})
