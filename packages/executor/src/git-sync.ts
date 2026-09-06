/**
 * git-sync.ts — Conservative repository maintenance before task dispatch.
 *
 * Keeps the main checkout and existing task worktrees reasonably fresh without
 * rewriting history or touching dirty worktrees.
 */
import path from "node:path"
import { executeCommand } from "@openclaw/os-adapters"

export type GitSyncResult = {
  repoPath: string
  root: SyncTargetResult
  worktrees: SyncTargetResult[]
  warnings: string[]
}

export type SyncTargetResult = {
  path: string
  branch?: string
  fetched?: boolean
  pulled?: boolean
  pushed?: boolean
  skipped?: string
}

type CommandResult = {
  stdout?: string
  stderr?: string
  exitCode?: number | null
  code?: number | null
  ok?: boolean
}

const DEFAULT_TIMEOUT_MS = 30_000

export async function syncRepoAndWorktrees(opts: { repoPath: string; timeoutMs?: number }): Promise<GitSyncResult> {
  const repoPath = path.resolve(opts.repoPath)
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const warnings: string[] = []

  const root = await syncCheckout(repoPath, timeoutMs, warnings, "root")
  await runGit(repoPath, ["worktree", "prune"], timeoutMs, warnings)

  const worktrees = await listWorktrees(repoPath, timeoutMs, warnings)
  const devclawWorktreeRoot = `${repoPath}.worktrees${path.sep}`
  const openclawWorktreeRoot = path.join(repoPath, ".openclaw", "worktrees") + path.sep
  const syncedWorktrees: SyncTargetResult[] = []

  for (const worktree of worktrees) {
    if (worktree.path === repoPath) continue
    if (!worktree.path.startsWith(devclawWorktreeRoot) && !worktree.path.startsWith(openclawWorktreeRoot)) continue
    syncedWorktrees.push(await syncCheckout(worktree.path, timeoutMs, warnings, "worktree"))
  }

  return { repoPath, root, worktrees: syncedWorktrees, warnings }
}

async function syncCheckout(
  cwd: string,
  timeoutMs: number,
  warnings: string[],
  kind: "root" | "worktree"
): Promise<SyncTargetResult> {
  const result: SyncTargetResult = { path: cwd }
  const branch = await currentBranch(cwd, timeoutMs, warnings)
  if (!branch) return { ...result, skipped: "detached HEAD or branch unavailable" }
  result.branch = branch

  const hasOrigin = await hasRemote(cwd, timeoutMs)
  if (!hasOrigin) return { ...result, skipped: "origin remote unavailable" }

  await runGit(cwd, ["fetch", "--prune", "origin"], timeoutMs, warnings)
  result.fetched = true

  const upstream = await upstreamBranch(cwd, timeoutMs)
  if (!upstream) return { ...result, skipped: "no upstream branch" }

  const dirty = await isDirty(cwd, timeoutMs)
  if (dirty) {
    return { ...result, skipped: `${kind} has local changes` }
  }

  const pull = await runGit(cwd, ["pull", "--ff-only"], timeoutMs, warnings, false)
  if (!succeeded(pull)) {
    warnings.push(`${kind} pull failed in ${cwd}: ${formatCommandError(pull)}`)
    return { ...result, skipped: "fast-forward pull failed" }
  }
  result.pulled = true

  const ahead = await aheadCount(cwd, timeoutMs)
  if (ahead > 0) {
    const push = await runGit(cwd, ["push"], timeoutMs, warnings, false)
    if (succeeded(push)) result.pushed = true
    else warnings.push(`${kind} push failed in ${cwd}: ${formatCommandError(push)}`)
  }

  return result
}

async function listWorktrees(
  repoPath: string,
  timeoutMs: number,
  warnings: string[]
): Promise<Array<{ path: string }>> {
  const res = await runGit(repoPath, ["worktree", "list", "--porcelain"], timeoutMs, warnings, false)
  if (!succeeded(res)) return [{ path: repoPath }]

  const worktrees: Array<{ path: string }> = []
  for (const line of (res.stdout ?? "").split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      worktrees.push({ path: line.slice("worktree ".length).trim() })
    }
  }
  return worktrees.length > 0 ? worktrees : [{ path: repoPath }]
}

async function currentBranch(cwd: string, timeoutMs: number, warnings: string[]): Promise<string | null> {
  const res = await runGit(cwd, ["branch", "--show-current"], timeoutMs, warnings, false)
  if (!succeeded(res)) return null
  const branch = (res.stdout ?? "").trim()
  return branch || null
}

async function hasRemote(cwd: string, timeoutMs: number): Promise<boolean> {
  const res = executeCommand("git", ["remote", "get-url", "origin"], { cwd, timeoutMs })
  return succeeded(res)
}

async function upstreamBranch(cwd: string, timeoutMs: number): Promise<string | null> {
  const res = executeCommand("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], { cwd, timeoutMs })
  if (!succeeded(res)) return null
  const upstream = (res.stdout ?? "").trim()
  return upstream || null
}

async function isDirty(cwd: string, timeoutMs: number): Promise<boolean> {
  const res = executeCommand("git", ["status", "--porcelain"], { cwd, timeoutMs })
  return !succeeded(res) || (res.stdout ?? "").trim().length > 0
}

async function aheadCount(cwd: string, timeoutMs: number): Promise<number> {
  const res = executeCommand("git", ["rev-list", "--left-right", "--count", "@{u}...HEAD"], { cwd, timeoutMs })
  if (!succeeded(res)) return 0
  const [, aheadRaw] = (res.stdout ?? "").trim().split(/\s+/)
  return Number(aheadRaw) || 0
}

async function runGit(
  cwd: string,
  args: string[],
  timeoutMs: number,
  warnings: string[],
  warn = true
): Promise<CommandResult> {
  const result = executeCommand("git", args, { cwd, timeoutMs })
  const commandResult: CommandResult = {
    ok: result.ok,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    code: result.exitCode
  }
  if (warn && !succeeded(commandResult)) {
    warnings.push(`git ${args.join(" ")} failed in ${cwd}: ${formatCommandError(commandResult)}`)
  }
  return commandResult
}

function succeeded(res: CommandResult): boolean {
  return (res.exitCode ?? res.code ?? 0) === 0
}

function formatCommandError(res: CommandResult): string {
  return (res.stderr || res.stdout || `exit ${res.exitCode ?? res.code ?? "unknown"}`).trim()
}
