import { existsSync } from "node:fs"
import { join } from "node:path"
import { commandExists } from "@openclaw/os-adapters"
import type { ExecutionPolicy } from "@openclaw/project-profiles"
import { executionPolicyForRepo } from "./execution-policy.js"

export function normalizeVerificationCommand(
  command: string,
  availability: { pnpm?: boolean; corepack?: boolean } = {},
  policy: ExecutionPolicy = { baselinePathRoots: [] }
): string {
  const trimmed = command.trim()
  const pnpmAvailable = availability.pnpm ?? commandExists("pnpm")
  const corepackAvailable = availability.corepack ?? commandExists("corepack")
  const normalized =
    /^pnpm(?:\s|$)/.test(trimmed) && !pnpmAvailable && corepackAvailable ? `corepack ${trimmed}` : trimmed
  if (
    !policy.pythonTestRoot ||
    !/\bpytest\b/.test(normalized) ||
    !normalized.startsWith(`cd ${policy.pythonTestRoot} &&`)
  )
    return normalized
  if (/(^|\s)--(?:no-)?cov(?:\s|=|$)/.test(normalized)) {
    return normalized
  }
  return `${normalized} --no-cov`
}

export function repairBackendPytestPaths(
  command: string,
  repoPath: string,
  policy = executionPolicyForRepo(repoPath)
): string {
  if (
    !policy.pythonTestRoot ||
    !policy.pythonTestFallback ||
    !/\bpytest\b/.test(command) ||
    !command.startsWith(`cd ${policy.pythonTestRoot} &&`)
  )
    return command
  const backendPath = join(repoPath, policy.pythonTestRoot)
  return command.replace(/(^|\s)(tests\/[A-Za-z0-9_./-]+\.py(?:::[^\s]+)?)/g, (match, prefix, testTarget) => {
    const [relativePath, ...selectors] = String(testTarget).split("::")
    if (!relativePath) {
      return match
    }
    if (existsSync(join(backendPath, relativePath))) {
      return match
    }

    const nestedPath = join(policy.pythonTestFallback!, relativePath)
    if (!existsSync(join(backendPath, nestedPath))) {
      return match
    }

    const repairedTarget = [nestedPath, ...selectors].join("::")
    return `${prefix}${repairedTarget}`
  })
}

export function focusedChangedTestVerificationCommands(
  paths: string[],
  policy: ExecutionPolicy = { baselinePathRoots: [] }
): string[] {
  const normalizedPaths = Array.from(new Set(paths.map((path) => path.replace(/\\/g, "/").trim()))).filter(
    (path) => path && /^[a-zA-Z0-9_./-]+$/.test(path) && !path.split("/").includes("..")
  )
  const nodeTests = normalizedPaths
    .filter(
      (path) =>
        policy.nodeTestRoot &&
        path.startsWith(`${policy.nodeTestRoot}/src/`) &&
        /\.(?:test|spec)\.[jt]sx?$/.test(path.split("/").at(-1) ?? "")
    )
    .map((path) => path.slice(policy.nodeTestRoot!.length + 1))
    .sort()
  const pythonTests = normalizedPaths
    .filter(
      (path) =>
        policy.pythonTestRoot &&
        path.startsWith(`${policy.pythonTestRoot}/`) &&
        /(?:^|\/)(?:test_[^/]+|[^/]+_test)\.py$/.test(path)
    )
    .map((path) => path.slice(policy.pythonTestRoot!.length + 1))
    .sort()
  const commands: string[] = []
  if (nodeTests.length > 0) {
    commands.push(`cd ${policy.nodeTestRoot} && npm test -- ${nodeTests.join(" ")}`)
  }
  if (pythonTests.length > 0) {
    commands.push(`cd ${policy.pythonTestRoot} && uv run pytest --no-cov ${pythonTests.join(" ")}`)
  }
  return commands
}
