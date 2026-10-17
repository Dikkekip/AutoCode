import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, expect, it } from "vitest"

const script = resolve("scripts/agent-ci.mjs")
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agent-ci-"))
  roots.push(root)
  const cwd = join(root, "repo")
  const bin = join(root, "bin")
  mkdirSync(cwd)
  mkdirSync(bin)
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
  git("init", "-b", "main")
  git("config", "user.name", "Test")
  git("config", "user.email", "test@example.invalid")
  writeFileSync(join(cwd, "source.txt"), "initial")
  git("add", ".")
  git("-c", "commit.gpgsign=false", "commit", "-m", "fixture")
  writeFileSync(
    join(bin, "pnpm"),
    '#!/bin/sh\nif [ "$2" = "$FAIL_AGENT_COMMAND" ]; then exit 7; fi\nif [ "$MUTATE_AGENT_CHECKOUT" = "yes" ]; then echo changed > source.txt; fi\nexit 0\n',
    { mode: 0o755 }
  )
  const head = git("rev-parse", "HEAD")
  return {
    cwd,
    head,
    run: (env: Record<string, string> = {}) =>
      spawnSync(process.execPath, [script], {
        cwd,
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env }
      }),
    receipt: () => JSON.parse(readFileSync(join(cwd, ".git", "agent-ci", `${head}.json`), "utf8"))
  }
}
it("records the exact committed SHA after every agent check succeeds", () => {
  const s = fixture()
  expect(s.run().status).toBe(0)
  expect(s.receipt()).toMatchObject({ headSha: s.head, status: "passed" })
  expect(s.receipt().checks.map((check: { command: string[] }) => check.command.at(-1))).toEqual([
    "deps:licenses",
    "deps:audit",
    "ci"
  ])
})
it("stops at a failed command and replaces a prior passing receipt", () => {
  const s = fixture()
  expect(s.run().status).toBe(0)
  expect(s.run({ FAIL_AGENT_COMMAND: "deps:audit" }).status).toBe(1)
  expect(s.receipt()).toMatchObject({ status: "failed" })
  expect(s.receipt().checks).toHaveLength(2)
  expect(s.receipt().checks.at(-1).exitCode).toBe(7)
})
it("rejects uncommitted work before running checks", () => {
  const s = fixture()
  writeFileSync(join(s.cwd, "untracked.txt"), "pending")
  expect(s.run().status).toBe(1)
  expect(s.receipt()).toMatchObject({ status: "failed", checks: [] })
})
it("rejects checkout changes made while checks run", () => {
  const s = fixture()
  expect(s.run({ MUTATE_AGENT_CHECKOUT: "yes" }).status).toBe(1)
  expect(s.receipt().status).toBe("failed")
  expect(s.receipt().error).toContain("Checkout changed")
})
