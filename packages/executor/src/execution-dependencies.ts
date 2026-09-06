import { createHash } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { executeCommand } from "@openclaw/os-adapters"
import { executionDependencyPaths, executionPolicyForRepo } from "./execution-policy.js"

function runCommand(command: string, args: string[], cwd: string) {
  return executeCommand(command, args, {
    cwd,
    env: {
      ...process.env,
      PATH: process.env.PATH?.trim() || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
    }
  })
}

function pathExistsOrSymlink(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

const isolatedNodeTestMarker = ".openclaw-dependency-manifest.sha256"

function ensureSharedExecutionDependencySources(repoPath: string): void {
  const testRoot = executionPolicyForRepo(repoPath).nodeTestRoot
  if (!testRoot) return
  const nodeTestPath = join(repoPath, testRoot)
  const packageLockPath = join(nodeTestPath, "package-lock.json")
  const vitestPath = join(nodeTestPath, "node_modules", ".bin", "vitest")

  if (!existsSync(packageLockPath) || existsSync(vitestPath)) {
    return
  }

  const install = runCommand("npm", ["ci"], nodeTestPath)
  if (!install.ok || !existsSync(vitestPath)) {
    const detail = install.stderr.trim() || install.stdout.trim() || "vitest remained unavailable after npm ci"
    throw new Error(`Failed to repair shared node test dependencies: ${detail}`)
  }
}

export function nodeTestDependencyManifestsDiffer(repoPath: string, worktreePath: string): boolean {
  const testRoot = executionPolicyForRepo(repoPath).nodeTestRoot
  if (!testRoot) return false
  return [join(testRoot, "package.json"), join(testRoot, "package-lock.json")].some((relativePath) => {
    const sourcePath = join(repoPath, relativePath)
    const worktreeManifestPath = join(worktreePath, relativePath)
    if (existsSync(sourcePath) !== existsSync(worktreeManifestPath)) return true
    return existsSync(sourcePath) && readFileSync(sourcePath, "utf8") !== readFileSync(worktreeManifestPath, "utf8")
  })
}

function ensureIsolatedNodeTestDependencies(worktreePath: string): void {
  const testRoot = executionPolicyForRepo(worktreePath).nodeTestRoot
  if (!testRoot) return
  const nodeTestPath = join(worktreePath, testRoot)
  const packageJsonPath = join(nodeTestPath, "package.json")
  const packageLockPath = join(nodeTestPath, "package-lock.json")
  if (!existsSync(packageJsonPath) || !existsSync(packageLockPath)) {
    return
  }

  const nodeModulesPath = join(nodeTestPath, "node_modules")
  const markerPath = join(nodeModulesPath, isolatedNodeTestMarker)
  const manifestFingerprint = createHash("sha256")
    .update(readFileSync(packageJsonPath))
    .update("\0")
    .update(readFileSync(packageLockPath))
    .digest("hex")

  try {
    if (
      !lstatSync(nodeModulesPath).isSymbolicLink() &&
      readFileSync(markerPath, "utf8").trim() === manifestFingerprint
    ) {
      return
    }
  } catch {
    // Missing, linked, or stale dependencies are replaced below.
  }

  rmSync(nodeModulesPath, { recursive: true, force: true })
  const install = runCommand("npm", ["ci"], nodeTestPath)
  if (!install.ok) {
    const detail = install.stderr.trim() || install.stdout.trim() || "npm ci failed without output"
    throw new Error(`Failed to prepare isolated node test dependencies: ${detail}`)
  }
  writeFileSync(join(nodeModulesPath, isolatedNodeTestMarker), `${manifestFingerprint}\n`, "utf8")
}

export function unlinkSharedExecutionDependencies(worktreePath: string): string[] {
  const unlinked: string[] = []
  for (const relativePath of Object.values(executionDependencyPaths(worktreePath)).flat()) {
    const target = join(worktreePath, relativePath)
    try {
      if (!lstatSync(target).isSymbolicLink()) {
        continue
      }
      rmSync(target, { force: true })
      unlinked.push(target)
    } catch {
      // Missing dependency links are expected for repositories that do not use these toolchains.
    }
  }
  return unlinked
}

export function linkSharedExecutionDependencies(repoPath: string, worktreePath: string): string[] {
  ensureSharedExecutionDependencySources(repoPath)

  // A preserved or review worktree created by an older framework release may
  // still point at the root backend virtualenv. Remove only that legacy link;
  // a real per-worktree virtualenv must be preserved and reused.
  for (const relativePath of executionDependencyPaths(repoPath).isolated) {
    const target = join(worktreePath, relativePath)
    try {
      if (lstatSync(target).isSymbolicLink()) {
        rmSync(target, { force: true })
      }
    } catch {
      // Missing isolated dependencies are created lazily by their toolchain.
    }
  }

  const linked: string[] = []
  for (const relativePath of executionDependencyPaths(repoPath).shared) {
    const source = join(repoPath, relativePath)
    const target = join(worktreePath, relativePath)
    if (nodeTestDependencyManifestsDiffer(repoPath, worktreePath)) {
      ensureIsolatedNodeTestDependencies(worktreePath)
      linked.push(target)
      continue
    }
    if (!existsSync(source)) {
      continue
    }

    if (pathExistsOrSymlink(target)) {
      if (existsSync(target)) {
        continue
      }
      rmSync(target, { recursive: true, force: true })
    }

    mkdirSync(dirname(target), { recursive: true })
    symlinkSync(source, target, "dir")
    linked.push(target)
  }
  return linked
}
