/** Optional legacy execution compatibility; native verification remains fail-closed. */
export interface ExecutionPolicy {
  nodeTestRoot?: string
  pythonTestRoot?: string
  pythonTestFallback?: string
  baselineChecks?: Array<{ commandIncludes: string; kind: "component-size" | "feature-boundary" }>
  baselinePathRoots: string[]
}

export function validateExecutionPolicy(value: unknown): ExecutionPolicy {
  if (value === undefined) return { baselinePathRoots: [] }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("executionPolicy must be an object")
  const record = value as Record<string, unknown>
  const allowed = new Set([
    "nodeTestRoot",
    "pythonTestRoot",
    "pythonTestFallback",
    "baselinePathRoots",
    "baselineChecks"
  ])
  for (const key of Object.keys(record)) if (!allowed.has(key)) throw new Error(`Unknown executionPolicy field: ${key}`)
  const path = (value: unknown): string => {
    if (
      typeof value !== "string" ||
      !/^[a-zA-Z0-9_./-]+$/.test(value) ||
      value.startsWith("/") ||
      value.startsWith("-") ||
      value.split("/").some((part) => !part || part === ".." || part === ".")
    ) {
      throw new Error("executionPolicy paths must be safe repository-relative paths")
    }
    return value
  }
  const result: ExecutionPolicy = { baselinePathRoots: [] }
  for (const key of ["nodeTestRoot", "pythonTestRoot", "pythonTestFallback"] as const) {
    if (record[key] !== undefined) result[key] = path(record[key])
  }
  if (record.baselinePathRoots !== undefined) {
    if (!Array.isArray(record.baselinePathRoots)) throw new Error("executionPolicy.baselinePathRoots must be an array")
    result.baselinePathRoots = record.baselinePathRoots.map(path)
  }
  if (record.baselineChecks !== undefined) {
    if (!Array.isArray(record.baselineChecks)) throw new Error("executionPolicy.baselineChecks must be an array")
    result.baselineChecks = record.baselineChecks.map((entry: unknown) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry))
        throw new Error("baseline check must be an object")
      const check = entry as Record<string, unknown>
      if (
        Object.keys(check).some((key) => key !== "commandIncludes" && key !== "kind") ||
        typeof check.commandIncludes !== "string" ||
        !check.commandIncludes.trim() ||
        (check.kind !== "component-size" && check.kind !== "feature-boundary")
      )
        throw new Error("Invalid executionPolicy baseline check")
      return { commandIncludes: check.commandIncludes, kind: check.kind }
    })
  }
  if (result.pythonTestFallback && !result.pythonTestRoot) throw new Error("pythonTestFallback requires pythonTestRoot")
  return result
}
