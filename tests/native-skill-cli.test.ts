import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { registerNativeAutonomyCommands } from "../apps/dispatcher-cli/src/native-autonomy.js"
import { NativeCliGateway } from "../packages/core-runtime/src/native/gateway.js"
import { nativeGovernanceDigest } from "../packages/core-runtime/src/native/governance.js"
import { loadNativeSkillText } from "../packages/core-runtime/src/native/skill-bundle.js"

const { Command } = createRequire(resolve("apps/dispatcher-cli/package.json"))("commander")
const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
it("inspects the exact composed bootstrap digest without a gateway call or state mutation", async () => {
  const root = mkdtempSync(join(tmpdir(), "native-skill-cli-"))
  roots.push(root)
  const skillPath = join(root, "SKILL.md")
  writeFileSync(skillPath, "Use source evidence.")
  writeFileSync(join(root, "repair.md"), "Preserve failed attempts.")
  writeFileSync(`${skillPath}.bundle.json`, JSON.stringify({ version: 1, resources: ["repair.md"] }))
  const policyPath = join(root, "policy.json")
  writeFileSync(
    policyPath,
    JSON.stringify({
      version: 1,
      enabled: false,
      boardId: "board",
      repository: root,
      repositoryKind: "application",
      baseBranch: "main",
      plannerAgentId: "planner",
      coderAgentId: "coder",
      reviewerAgentId: "reviewer",
      quality: { skillPath },
      personas: [
        { personaId: "research", goals: ["navigation"], successObservations: ["page opens"], allowedPaths: ["src"] }
      ],
      verification: [{ argv: ["true"], cwd: "." }]
    })
  )
  const request = vi.spyOn(NativeCliGateway.prototype, "request").mockRejectedValue(new Error("Must stay offline"))
  const before = readdirSync(root).sort()
  const inspect = async (...options: string[]) => {
    const output: string[] = []
    const program = new Command().exitOverride()
    registerNativeAutonomyCommands(program, { stdout: (message) => output.push(message) })
    await program.parseAsync(["native", "--policy", policyPath, "skill", "inspect", ...options], { from: "user" })
    return JSON.parse(output.join(""))
  }
  const first = await inspect()
  expect(first.digest).toBe(nativeGovernanceDigest(loadNativeSkillText(skillPath)))
  expect(first.text).toBeUndefined()
  const full = await inspect("--include-text")
  expect(full.text).toContain("Preserve failed attempts.")
  expect(full.digest).toBe(first.digest)
  writeFileSync(join(root, "repair.md"), "Changed supporting instructions.")
  expect((await inspect()).digest).not.toBe(first.digest)
  expect(request).not.toHaveBeenCalled()
  expect(readdirSync(root).sort()).toEqual(before)
})
