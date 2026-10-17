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

// Prove only simple basename-prefix disjointness. Other glob intersections stay conservative.
function disjointTerminalPrefix(pattern: string, plain: string): boolean {
  const canonical = (value: string) =>
    Boolean(value) &&
    value.trim() === value &&
    !/[\\\0]/.test(value) &&
    !pathPosix.isAbsolute(value) &&
    pathPosix.normalize(value) === value &&
    value.split("/").every((part) => part && part !== "." && part !== "..")
  if (!canonical(pattern) || !canonical(plain) || GLOB_MARKER.test(plain) || !pattern.endsWith("*")) return false
  const prefix = pattern.slice(0, -1)
  if (!prefix || prefix.endsWith("/") || !/^[A-Za-z0-9._/-]+$/.test(prefix)) return false
  // A plain directory ancestor and any matching literal prefix can still intersect.
  return !plain.startsWith(prefix) && !prefix.startsWith(`${plain}/`)
}

export function artifactScopesOverlap(leftValue: string, rightValue: string): boolean {
  if (disjointTerminalPrefix(leftValue, rightValue) || disjointTerminalPrefix(rightValue, leftValue)) return false
  const left = normalizeArtifactScope(leftValue)
  const right = normalizeArtifactScope(rightValue)
  if (!left || !right) return false
  if (left === "." || right === ".") return true
  if (left === right) return true
  return left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}
