import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { commitNativeCandidate, inspectNativeCandidate } from "../packages/core-runtime/src/native/verification.js"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function setup() {
  const root = mkdtempSync(join(tmpdir(), "native-commit-test-"))
  roots.push(root)
  const repo = join(root, "repo"),
    worktree = join(root, "worktree")
  mkdirSync(repo)
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim()
  git("init", "-b", "main")
  git("config", "user.name", "Test")
  git("config", "user.email", "test@example.invalid")
  writeFileSync(join(repo, "code.ts"), "export const value = 1\n")
  writeFileSync(join(repo, ".gitattributes"), "code.ts filter=test\n")
  git("add", ".")
  git("commit", "-m", "baseline")
  git("update-ref", "refs/remotes/origin/main", "HEAD")
  git("worktree", "add", "-b", "candidate", worktree)
  return { root, repo, worktree, git, policy: { repository: repo, baseBranch: "main" } as any }
}
it("records scoped source edits without Git hooks, clean filters, or untracked agent notes", async () => {
  const s = setup()
  const marker = join(s.root, "executed")
  writeFileSync(join(s.repo, ".git/hooks/pre-commit"), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 })
  s.git("config", "filter.test.clean", `touch '${marker}'; cat`)
  writeFileSync(join(s.worktree, "code.ts"), "export const value = 2\n")
  writeFileSync(join(s.worktree, "USER.md"), "Private runtime context; never publish\n")
  writeFileSync(join(s.worktree, "DREAMS.md"), "Private dream notes")
  mkdirSync(join(s.worktree, "memory/dreaming"), { recursive: true })
  writeFileSync(join(s.worktree, "memory/dreaming/session.md"), "Private session notes")
  let authorized = 0
  const sha = await commitNativeCandidate(s.policy, s.worktree, ["code.ts"], "Fix value", () => {
    authorized++
  })
  expect(sha).toMatch(/^[a-f0-9]{40}$/)
  expect(authorized).toBeGreaterThan(0)
  expect(existsSync(marker)).toBe(false)
  expect(s.git("show", `${sha}:code.ts`)).toBe("export const value = 2")
  expect(s.git("ls-tree", "--name-only", sha!)).not.toContain("USER.md")
  expect(s.git("ls-tree", "-r", "--name-only", sha!)).not.toMatch(/DREAMS|dreaming/)
  expect(readFileSync(join(s.worktree, "memory/dreaming/session.md"), "utf8")).toBe("Private session notes")
  expect(readFileSync(join(s.worktree, "USER.md"), "utf8")).toContain("Private runtime context")
  expect((await inspectNativeCandidate(s.policy, s.worktree, ["code.ts"])).files).toEqual(["code.ts"])
  expect(existsSync(marker)).toBe(false)
})
it.each(["outside", "symlink", "notes"])("rejects %s changes before creating a candidate commit", async (kind) => {
  const s = setup(),
    head = s.git("rev-parse", "candidate")
  if (kind === "outside") writeFileSync(join(s.worktree, "other.ts"), "outside scope")
  if (kind === "symlink") {
    rmSync(join(s.worktree, "code.ts"))
    symlinkSync(join(s.root, "missing-private-file"), join(s.worktree, "code.ts"))
  }
  if (kind === "notes") {
    writeFileSync(join(s.worktree, "USER.md"), "private")
    execFileSync("git", ["add", "USER.md"], { cwd: s.worktree })
  }
  await expect(
    commitNativeCandidate(s.policy, s.worktree, kind === "notes" ? ["**"] : ["code.ts"], "Unsafe", () => {})
  ).rejects.toThrow(kind === "symlink" ? /regular/ : /scope/)
  expect(s.git("rev-parse", "candidate")).toBe(head)
})
it("refuses writes when execution authority was revoked", async () => {
  const s = setup(),
    head = s.git("rev-parse", "candidate")
  writeFileSync(join(s.worktree, "code.ts"), "changed")
  await expect(
    commitNativeCandidate(s.policy, s.worktree, ["code.ts"], "Change", () => {
      throw new Error("paused")
    })
  ).rejects.toThrow("paused")
  expect(s.git("rev-parse", "candidate")).toBe(head)
})

it("explains tracked generated-file deletions without committing or altering them", async () => {
  const s = setup()
  writeFileSync(join(s.repo, "generated.js"), "tracked generated asset")
  s.git("add", "generated.js")
  s.git("commit", "-m", "generated fixture")
  execFileSync("git", ["merge", "main"], { cwd: s.worktree, stdio: "pipe" })
  const head = s.git("rev-parse", "candidate")
  rmSync(join(s.worktree, "generated.js"))
  writeFileSync(join(s.worktree, "code.ts"), "export const value = 2\n")
  let message = ""
  try {
    await commitNativeCandidate(s.policy, s.worktree, ["code.ts"], "Fix", () => {})
  } catch (error) {
    message = String(error)
  }
  expect(message).toContain('outside admitted code scope (1): ["generated.js"]')
  expect(message).toContain("Moving or removing tracked files creates deletions")
  expect(message).not.toContain("tracked generated asset")
  expect(s.git("rev-parse", "candidate")).toBe(head)
  expect(existsSync(join(s.worktree, "generated.js"))).toBe(false)
  expect(readFileSync(join(s.worktree, "code.ts"), "utf8")).toContain("value = 2")
})

it("bounds rejected-path diagnostics while retaining the total count", async () => {
  const s = setup()
  for (let i = 0; i < 20; i++) writeFileSync(join(s.worktree, `outside-${i}.txt`), "private file contents")
  await expect(commitNativeCandidate(s.policy, s.worktree, ["code.ts"], "Fix", () => {})).rejects.toThrow(
    /outside admitted code scope \(20\)/
  )
  try {
    await commitNativeCandidate(s.policy, s.worktree, ["code.ts"], "Fix", () => {})
  } catch (error) {
    const message = String(error)
    expect(message).not.toContain("private file contents")
    expect(message.match(/outside-\d+\.txt/g)).toHaveLength(10)
    expect(message.length).toBeLessThan(3000)
  }
})

it.each(["DREAMS.md", "memory/dreaming/session.md"])("rejects staged runtime notes: %s", async (path) => {
  const s = setup()
  mkdirSync(join(s.worktree, "memory/dreaming"), { recursive: true })
  writeFileSync(join(s.worktree, path), "private")
  execFileSync("git", ["add", path], { cwd: s.worktree })
  await expect(commitNativeCandidate(s.policy, s.worktree, ["**"], "Unsafe", () => {})).rejects.toThrow(/scope/)
})
