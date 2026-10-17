import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

const git = (...args) => {
  const result = spawnSync("git", args, { encoding: "utf8" })
  if (result.status !== 0) throw new Error(result.stderr || "Git inspection failed")
  return result.stdout.trim()
}

// Run from the checkout root; receipts belong to this worktree, never to source.
process.chdir(git("rev-parse", "--show-toplevel"))
const headSha = git("rev-parse", "HEAD")
const directory = resolve(git("rev-parse", "--git-path", "agent-ci"))
mkdirSync(directory, { recursive: true })
const receiptPath = resolve(directory, `${headSha}.json`)
const receipt = {
  version: 1,
  headSha,
  node: process.version,
  startedAt: new Date().toISOString(),
  status: "failed",
  checks: []
}
let exitCode = 1
try {
  if (git("status", "--porcelain")) throw new Error("Agent CI requires a clean committed checkout")
  for (const command of ["deps:licenses", "deps:audit", "ci"]) {
    const startedAt = new Date().toISOString()
    const result = spawnSync("pnpm", ["run", command], { stdio: "inherit" })
    receipt.checks.push({
      command: ["pnpm", "run", command],
      startedAt,
      finishedAt: new Date().toISOString(),
      exitCode: result.status,
      signal: result.signal
    })
    if (result.error || result.status !== 0)
      throw new Error(`Agent CI failed: ${command}: ${result.error?.message ?? result.signal ?? result.status}`)
  }
  if (git("rev-parse", "HEAD") !== headSha || git("status", "--porcelain"))
    throw new Error("Checkout changed during agent CI; rerun against the final commit")
  receipt.status = "passed"
  exitCode = 0
} catch (error) {
  receipt.error = String(error)
  console.error(receipt.error)
} finally {
  receipt.finishedAt = new Date().toISOString()
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 })
  console.log(`Agent CI receipt: ${receiptPath}`)
}
process.exitCode = exitCode
