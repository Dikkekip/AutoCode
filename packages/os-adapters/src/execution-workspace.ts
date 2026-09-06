import { existsSync, realpathSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"

export type ExecutionWorkspaceGuardResult = {
  repoRoot: string
  targetPath: string
  insideRepo: boolean
}

function canonicalPath(path: string): string {
  const absolute = resolve(path)
  if (existsSync(absolute)) return realpathSync(absolute)

  let ancestor = dirname(absolute)
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor)
    if (parent === ancestor) return absolute
    ancestor = parent
  }
  return resolve(realpathSync(ancestor), relative(ancestor, absolute))
}

export function assertInsideExecutionWorkspace(repoRoot: string, targetPath: string): ExecutionWorkspaceGuardResult {
  const canonicalRepo = canonicalPath(repoRoot)
  const canonicalTarget = canonicalPath(targetPath)
  const rel = relative(canonicalRepo, canonicalTarget)
  const insideRepo = rel === "" || (!rel.startsWith("..") && rel !== "..")

  if (!insideRepo) {
    throw new Error(`Execution target is outside repository workspace: ${canonicalTarget}`)
  }

  return {
    repoRoot: canonicalRepo,
    targetPath: canonicalTarget,
    insideRepo
  }
}
