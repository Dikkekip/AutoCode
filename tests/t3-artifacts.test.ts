import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureT3Source, collectT3Candidate, T3Journal, verifyT3Candidate } from "@autocode/t3-runtime"
import { afterEach, describe, expect, it } from "vitest"

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

function fixture(withSymlink = false) {
  const dir = mkdtempSync(join(tmpdir(), "autocode-t3-artifact-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const repository = join(dir, "repository"),
    worktree = join(dir, "fixture-worktree")
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim()
  execFileSync("git", ["init", "--quiet", repository])
  writeFileSync(join(repository, "value.json"), '{"value":1}\n')
  if (withSymlink) symlinkSync("/etc/passwd", join(repository, "external"))
  git(repository, "add", ".")
  git(
    repository,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture"
  )
  const source = captureT3Source(repository)
  // A simulated host fixture, not a real T3 delegate or operational child checkout.
  git(repository, "worktree", "add", "--quiet", "--detach", worktree, source.revision)
  writeFileSync(join(worktree, "value.json"), '{"value":2}\n')
  git(worktree, "add", ".")
  git(worktree, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fix")
  const revision = git(worktree, "rev-parse", "HEAD")
  const candidate = collectT3Candidate(source, worktree, revision, "fixture-task")
  const journal = new T3Journal(join(dir, "evidence.sqlite"))
  cleanups.push(() => journal.close())
  const lease = journal.acquire("fixture", 120_000)!
  return { dir, repository, worktree, source, revision, candidate, journal, lease }
}

describe("independent T3 candidate collection and protected verifier admission", () => {
  it("collects the actual clean committed candidate and rejects a claimed SHA, dirty tree or shared checkout", () => {
    const f = fixture()
    expect(f.candidate).toMatchObject({
      revision: f.revision,
      changedPaths: ["value.json"],
      implementationTaskId: "fixture-task"
    })
    expect(() => collectT3Candidate(f.source, f.repository, f.revision, "fixture-task")).toThrow("separate worktree")
    expect(() => collectT3Candidate(f.source, f.worktree, f.source.revision, "fixture-task")).toThrow("head moved")
    writeFileSync(join(f.worktree, "value.json"), "dirty")
    expect(() => collectT3Candidate(f.source, f.worktree, f.revision, "fixture-task")).toThrow("uncommitted")
  })

  it("refuses mutable images, candidate-controlled verifier programs and unsafe source exports before execution", async () => {
    const f = fixture(true)
    const policy = {
      image: "sha256:" + "a".repeat(64),
      argv: ["/opt/autocode/verifier/check"],
      timeoutMs: 1000,
      maxSourceBytes: 100_000,
      maxFileBytes: 10_000
    }
    const input = {
      journal: f.journal,
      lease: f.lease,
      assignmentId: "verify-fixture",
      source: f.source,
      candidate: f.candidate,
      privateRoot: f.dir
    }
    await expect(verifyT3Candidate({ ...input, policy: { ...policy, image: "node:latest" } })).rejects.toThrow(
      "Immutable image"
    )
    await expect(verifyT3Candidate({ ...input, policy: { ...policy, argv: ["/work/check"] } })).rejects.toThrow(
      "protected verifier"
    )
    await expect(verifyT3Candidate({ ...input, policy })).rejects.toThrow("symlinks or submodules")
    expect(f.journal.effect("verify:verify-fixture")).toBeNull()
  })
})
