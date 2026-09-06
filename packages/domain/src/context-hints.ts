export interface ContextHintDocument {
  path: string
  content: string
  source: "global" | "local"
}

export interface ContextHintReference {
  path: string
  immediate: boolean
}

export interface ContextHintBundleEntry extends ContextHintDocument {
  depth: number
  references: ContextHintReference[]
}

export interface ContextHintBundle {
  entries: ContextHintBundleEntry[]
  immediateReferencePaths: string[]
  optionalReferencePaths: string[]
  systemPrompt: string
}

const DEFAULT_CONTEXT_FILE_NAMES = ["AGENTS.md", ".goosehints"]
const AT_REFERENCE = /(?:^|\s)@([^\s#]+)/g
const PLAIN_REFERENCE = /(?:^|\s)([A-Za-z0-9._/-]+\.(?:md|mdx|txt|json|yaml|yml))(?:\s|$)/gi

function pathDepth(path: string): number {
  return path.split(/[\\/]+/).filter(Boolean).length
}

function normalizePath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\//, "")
}

function unique(values: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const normalized = normalizePath(value)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
  }
  return result
}

export function parseContextFileNames(value: string | null | undefined): string[] {
  if (!value?.trim()) return DEFAULT_CONTEXT_FILE_NAMES
  try {
    const parsed = JSON.parse(value)
    if (Array.isArray(parsed)) {
      const names = unique(parsed.filter((entry): entry is string => typeof entry === "string"))
      return names.length > 0 ? names : DEFAULT_CONTEXT_FILE_NAMES
    }
  } catch {
    // Fall back to comma-separated values for operator convenience.
  }

  const names = unique(value.split(","))
  return names.length > 0 ? names : DEFAULT_CONTEXT_FILE_NAMES
}

export function extractContextHintReferences(content: string): ContextHintReference[] {
  const references: ContextHintReference[] = []
  for (const match of content.matchAll(AT_REFERENCE)) {
    if (match[1]) references.push({ path: normalizePath(match[1]), immediate: true })
  }
  for (const match of content.matchAll(PLAIN_REFERENCE)) {
    if (!match[1]) continue
    const path = normalizePath(match[1])
    if (references.some((reference) => reference.path === path)) continue
    references.push({ path, immediate: false })
  }
  return references
}

export function buildContextHintBundle(documents: ContextHintDocument[]): ContextHintBundle {
  const entries = documents
    .map((document) => ({
      ...document,
      path: normalizePath(document.path),
      depth: pathDepth(document.path),
      references: extractContextHintReferences(document.content)
    }))
    .sort((left, right) => {
      if (left.source !== right.source) return left.source === "global" ? -1 : 1
      if (left.depth !== right.depth) return left.depth - right.depth
      return left.path.localeCompare(right.path)
    })

  const immediateReferencePaths = unique(
    entries.flatMap((entry) =>
      entry.references.filter((reference) => reference.immediate).map((reference) => reference.path)
    )
  )
  const optionalReferencePaths = unique(
    entries.flatMap((entry) =>
      entry.references.filter((reference) => !reference.immediate).map((reference) => reference.path)
    )
  ).filter((path) => !immediateReferencePaths.includes(path))

  return {
    entries,
    immediateReferencePaths,
    optionalReferencePaths,
    systemPrompt: entries
      .map((entry) => [`# Context Hints: ${entry.path}`, entry.content.trim()].filter(Boolean).join("\n"))
      .join("\n\n")
  }
}
