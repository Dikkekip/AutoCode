import { execFileSync } from "node:child_process"
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  loadProjectProfile,
  projectProfileInstallFiles,
  resolveProjectProfile,
  validateExecutionPolicy,
  validateProjectProfile
} from "@openclaw/project-profiles"
import { afterEach, describe, expect, it } from "vitest"
import { nativePolicyFromProfile } from "../packages/core-runtime/src/native/adoption.js"
import {
  linkSharedExecutionDependencies,
  nodeTestDependencyManifestsDiffer,
  unlinkSharedExecutionDependencies
} from "../packages/executor/src/execution-dependencies.js"
import { executionPolicyForRepo } from "../packages/executor/src/execution-policy.js"
import {
  focusedChangedTestVerificationCommands,
  normalizeVerificationCommand,
  repairBackendPytestPaths
} from "../packages/executor/src/verification-commands.js"
import { createTempWorkspace } from "./helpers.js"

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.()
})
function fixture() {
  const workspace = createTempWorkspace("execution-profile")
  cleanups.push(workspace.cleanup)
  cpSync(join(import.meta.dirname, "fixtures/profile-repositories/split-services"), workspace.repoPath, {
    recursive: true
  })
  mkdirSync(join(workspace.repoPath, ".openclaw"))
  cpSync(join(workspace.repoPath, "profile.json"), join(workspace.repoPath, ".openclaw/profile.json"))
  return workspace
}

describe("profile execution boundaries", () => {
  it("executes focused verification in a structurally different repository", () => {
    const { repoPath } = fixture()
    const policy = executionPolicyForRepo(repoPath)
    const commands = focusedChangedTestVerificationCommands(
      ["ui/console/src/item.test.js", "ui/console/src/item.test.js", "ui/console/src/../../escape.test.js"],
      policy
    )
    expect(commands).toEqual(["cd ui/console && npm test -- src/item.test.js"])
    expect(execFileSync("sh", ["-c", commands[0]!], { cwd: repoPath, encoding: "utf8" })).toContain("pass 1")
    expect(
      repairBackendPytestPaths("cd services/catalog && uv run pytest tests/test_item.py::test_item", repoPath)
    ).toContain("catalog/tests/test_item.py::test_item")
    mkdirSync(join(repoPath, "services/catalog/tests"))
    writeFileSync(join(repoPath, "services/catalog/tests/test_item.py"), "")
    expect(repairBackendPytestPaths("cd services/catalog && uv run pytest tests/test_item.py", repoPath)).toBe(
      "cd services/catalog && uv run pytest tests/test_item.py"
    )
    expect(normalizeVerificationCommand("cd services/catalog && uv run pytest tests/", {}, policy)).toMatch(/--no-cov$/)
    expect(focusedChangedTestVerificationCommands(["services/catalog/catalog/tests/test_item.py"], policy)).toEqual([
      "cd services/catalog && uv run pytest --no-cov catalog/tests/test_item.py"
    ])
  })

  it("generates planner persona suggestions from the installed profile roster", () => {
    const { repoPath } = fixture()
    const profile = resolveProjectProfile(repoPath)!
    const planner = projectProfileInstallFiles(repoPath, profile).find((file) =>
      file.relativePath.endsWith("planner.prompt.md")
    )!.content
    expect(planner).toContain(profile.managerStateDefaults.managerPersonas[0]!.focus)
    expect(planner).toContain("pm-general")
    expect(planner).not.toContain("barnevern-domain-specialist")
    const compatibility = loadProjectProfile("lawyerrag")
    const legacyPlanner = projectProfileInstallFiles(repoPath, compatibility).find((file) =>
      file.relativePath.endsWith("planner.prompt.md")
    )!.content
    expect(legacyPlanner).toContain("barnevern-domain-specialist")
  })

  it("converts the alternate layout into native scopes and executable verification", () => {
    const { repoPath } = fixture()
    const profile = resolveProjectProfile(repoPath)!
    const policy = nativePolicyFromProfile(profile, repoPath, "main")
    expect(policy.personas[0]?.allowedPaths).toEqual(["ui/console/**", "services/catalog/**"])
    const verification = policy.verification[0]!
    expect(verification.paths).toEqual(["ui/console/**", "services/catalog/**"])
    expect(
      execFileSync(verification.argv[0]!, verification.argv.slice(1), { cwd: repoPath, encoding: "utf8" })
    ).toContain("pass 1")
    expect(policy.deployment).toBeNull()
    expect(policy.enabled).toBe(false)
  })

  it("carries installed policy into linked worktrees and isolates Python dependencies", () => {
    const { repoPath, root } = fixture()
    const git = (args: string[]) =>
      execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: repoPath, stdio: "pipe" })
    git(["init"])
    git(["config", "user.name", "Fixture"])
    git(["config", "user.email", "fixture@example.test"])
    git(["add", "ui", "services", "README.md"])
    git(["commit", "-m", "fixture"])
    const worktree = join(root, "candidate")
    git(["worktree", "add", "--detach", worktree])
    expect(resolveProjectProfile(worktree)?.profileId).toBe("split-services-fixture")
    mkdirSync(join(repoPath, "ui/console/node_modules"), { recursive: true })
    mkdirSync(join(repoPath, "services/catalog/.venv"), { recursive: true })
    symlinkSync(join(repoPath, "services/catalog/.venv"), join(worktree, "services/catalog/.venv"), "dir")
    linkSharedExecutionDependencies(repoPath, worktree)
    expect(lstatSync(join(worktree, "ui/console/node_modules")).isSymbolicLink()).toBe(true)
    expect(existsSync(join(worktree, "services/catalog/.venv"))).toBe(false)
    mkdirSync(join(worktree, "services/catalog/.venv"))
    expect(unlinkSharedExecutionDependencies(worktree)).toEqual([join(worktree, "ui/console/node_modules")])
    expect(existsSync(join(worktree, "services/catalog/.venv"))).toBe(true)
    writeFileSync(join(worktree, "ui/console/package.json"), "{}")
    expect(nodeTestDependencyManifestsDiffer(repoPath, worktree)).toBe(true)
  })

  it("keeps compatibility opt-in and rejects malformed installed profiles without fallback", () => {
    const { repoPath } = fixture()
    expect(loadProjectProfile("lawyerrag").promotionPolicy.importPersonaNames).toEqual([
      "promoter-lawyerrag",
      "promoter"
    ])
    const legacy = loadProjectProfile("lawyerrag").executionPolicy!
    expect(focusedChangedTestVerificationCommands(["apps/backend/tests/test_item.py"], legacy)).toEqual([
      "cd apps/backend && uv run pytest --no-cov tests/test_item.py"
    ])
    expect(focusedChangedTestVerificationCommands(["apps/backend/tests/test_item.py"])).toEqual([])
    expect(normalizeVerificationCommand("cd apps/backend && uv run pytest tests/")).not.toContain("--no-cov")
    const profile = loadProjectProfile("minimal-repo")
    writeFileSync(join(repoPath, ".openclaw/profile.json"), JSON.stringify(profile))
    expect(executionPolicyForRepo(repoPath)).toEqual({ baselinePathRoots: [] })
    writeFileSync(
      join(repoPath, ".openclaw/profile.json"),
      JSON.stringify({ ...profile, executionPolicy: { nodeTestRoot: "../escape" } })
    )
    expect(() => executionPolicyForRepo(repoPath)).toThrow(/repository-relative/)
    expect(() => validateProjectProfile({ ...profile, executionPolicy: { unexpected: true } })).toThrow(/Unknown/)
    for (const value of [
      null,
      [],
      "bad",
      { baselinePathRoots: "src" },
      { nodeTestRoot: "/tmp" },
      { nodeTestRoot: "-" },
      { baselineChecks: [{ commandIncludes: "", kind: "component-size" }] },
      { baselineChecks: [{ commandIncludes: "check", kind: "unknown" }] },
      { pythonTestFallback: "nested" },
      { nodeTestRoot: "src;touch" }
    ]) {
      expect(() => validateExecutionPolicy(value)).toThrow()
    }
    expect(
      validateProjectProfile(JSON.parse(readFileSync(join(repoPath, "profile.json"), "utf8"))).executionPolicy
        ?.nodeTestRoot
    ).toBe("ui/console")
  })
})
