import { existsSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { createLawyerRagControlPlane, createTempWorkspace } from "./helpers.js"
import { HAS_NODE_SQLITE } from "./node-sqlite.js"

let runCli: typeof import("../apps/dispatcher-cli/src/index.js").runCli | null = null
if (HAS_NODE_SQLITE) {
  ;({ runCli } = await import("../apps/dispatcher-cli/src/index.js"))
}

const describeDb = HAS_NODE_SQLITE ? describe : describe.skip

describeDb("profile CLI", () => {
  const cleanups: Array<() => void> = []

  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.()
  })

  it("lists, detects, inspects, and installs built-in profiles", async () => {
    const workspace = createTempWorkspace("profile-cli")
    cleanups.push(workspace.cleanup)
    createLawyerRagControlPlane(workspace.repoPath)

    const output: string[] = []
    const io = {
      stdout: (message: string) => output.push(message),
      stderr: (message: string) => output.push(message)
    }

    await runCli!(["profile", "list"], io)
    await runCli!(["profile", "inspect", "lawyerrag"], io)
    await runCli!(["profile", "detect", workspace.repoPath], io)
    await runCli!(["profile", "install", "minimal-repo", workspace.repoPath, "--force"], io)
    await runCli!(["persona", "list", "--profile", "minimal-repo"], io)
    await runCli!(["persona", "show", "minimal-runtime-engineer", "--profile", "minimal-repo"], io)
    await runCli!(["persona", "validate", "--all-profiles"], io)

    const text = output.join("\n")
    expect(text).toContain("lawyerrag")
    expect(text).toContain("minimal-repo")
    expect(text).toContain("display_name: LawyerRAG")
    expect(text).toContain("response_compression: lite")
    expect(text).toContain("best_profile:")
    expect(text).toContain("Installed profile minimal-repo")
    expect(text).toContain("minimal-runtime-engineer | Minimal Runtime Engineer")
    expect(text).toContain("role: Backend Engineer")
    expect(text).toContain("persona_validation: ok")
    expect(existsSync(join(workspace.repoPath, ".openclaw", "profile.json"))).toBe(true)
  })
})
