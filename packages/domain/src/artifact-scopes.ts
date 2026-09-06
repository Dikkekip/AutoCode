import { posix as pathPosix } from "node:path"

const GLOB_MARKER = /[*?[\]{}]/

export function normalizeArtifactScope(value: string): string {
  const trimmed = value.replace(/\\/g, "/").replace(/^\.\//, "").trim()
  if (!trimmed) return ""

  const markerIndex = trimmed.search(GLOB_MARKER)
  let scope = markerIndex >= 0 ? trimmed.slice(0, markerIndex) : trimmed
  if (markerIndex >= 0) {
    const separatorIndex = scope.lastIndexOf("/")
    scope = separatorIndex >= 0 ? scope.slice(0, separatorIndex) : "."
  }

  const normalized = pathPosix
    .normalize(scope || ".")
    .replace(/^\/+/, "")
    .replace(/\/$/, "")
  if (!normalized || normalized === ".") return "."
  if (normalized === ".." || normalized.startsWith("../")) return "."
  return normalized
}

export function normalizeArtifactScopes(values: readonly string[]): string[] {
  const scopes = Array.from(new Set(values.map(normalizeArtifactScope).filter(Boolean)))
  return scopes.includes(".") ? ["."] : scopes.sort()
}

export function artifactScopesOverlap(leftValue: string, rightValue: string): boolean {
  const left = normalizeArtifactScope(leftValue)
  const right = normalizeArtifactScope(rightValue)
  if (!left || !right) return false
  if (left === "." || right === ".") return true
  if (left === right) return true
  return left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}
