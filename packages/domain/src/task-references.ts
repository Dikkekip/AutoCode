export const TASK_REFERENCE_IDENTIFIER_RE = /^[A-Z]+-\d+$/

export interface TaskReferenceMatch {
  index: number
  length: number
  identifier: string
  matchedText: string
}

const TASK_REFERENCE_TOKEN_RE = /https?:\/\/[^\s<>()]+|\/[^\s<>()]+|[A-Z]+-\d+/gi

function preserveNewlinesAsWhitespace(value: string): string {
  return value.replace(/[^\n]/g, " ")
}

function stripMarkdownCode(markdown: string): string {
  if (!markdown) return ""

  let output = ""
  let index = 0

  while (index < markdown.length) {
    const remaining = markdown.slice(index)
    const fenceMatch = /^(?:```+|~~~+)/.exec(remaining)
    const atLineStart = index === 0 || markdown[index - 1] === "\n"

    if (atLineStart && fenceMatch) {
      const fence = fenceMatch[0]!
      const blockStart = index
      index += fence.length
      while (index < markdown.length && markdown[index] !== "\n") index += 1
      if (index < markdown.length) index += 1

      while (index < markdown.length) {
        const lineStart = index === 0 || markdown[index - 1] === "\n"
        if (lineStart && markdown.startsWith(fence, index)) {
          index += fence.length
          while (index < markdown.length && markdown[index] !== "\n") index += 1
          if (index < markdown.length) index += 1
          break
        }
        index += 1
      }

      output += preserveNewlinesAsWhitespace(markdown.slice(blockStart, index))
      continue
    }

    if (markdown[index] === "`") {
      let tickCount = 1
      while (index + tickCount < markdown.length && markdown[index + tickCount] === "`") {
        tickCount += 1
      }
      const fence = "`".repeat(tickCount)
      const inlineStart = index
      index += tickCount
      const closeIndex = markdown.indexOf(fence, index)
      if (closeIndex === -1) {
        output += markdown.slice(inlineStart, inlineStart + tickCount)
        index = inlineStart + tickCount
        continue
      }
      index = closeIndex + tickCount
      output += preserveNewlinesAsWhitespace(markdown.slice(inlineStart, index))
      continue
    }

    output += markdown[index]!
    index += 1
  }

  return output
}

function trimTrailingPunctuation(token: string): string {
  let trimmed = token
  while (trimmed.length > 0) {
    const last = trimmed[trimmed.length - 1]!
    if (!".,!?;:".includes(last) && last !== ")" && last !== "]") break

    if (
      (last === ")" && (trimmed.match(/\(/g)?.length ?? 0) >= (trimmed.match(/\)/g)?.length ?? 0)) ||
      (last === "]" && (trimmed.match(/\[/g)?.length ?? 0) >= (trimmed.match(/\]/g)?.length ?? 0))
    ) {
      break
    }
    trimmed = trimmed.slice(0, -1)
  }
  return trimmed
}

export function normalizeTaskReferenceIdentifier(value: string): string | null {
  const trimmed = value.trim().toUpperCase()
  return TASK_REFERENCE_IDENTIFIER_RE.test(trimmed) ? trimmed : null
}

export function buildTaskReferenceHref(identifier: string): string {
  const normalized = normalizeTaskReferenceIdentifier(identifier)
  return `/tasks/${normalized ?? identifier.trim()}`
}

export function parseTaskReferenceHref(href: string): { identifier: string } | null {
  const raw = href.trim()
  if (!raw) return null

  let url: URL
  try {
    url = raw.startsWith("/") ? new URL(raw, "https://openclaw.invalid") : new URL(raw)
  } catch {
    return null
  }

  const segments = url.pathname
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean)

  for (let index = 0; index < segments.length - 1; index += 1) {
    if (segments[index]?.toLowerCase() !== "tasks" && segments[index]?.toLowerCase() !== "issues") continue
    const identifier = normalizeTaskReferenceIdentifier(segments[index + 1] ?? "")
    if (identifier) {
      return { identifier }
    }
  }

  return null
}

export function findTaskReferenceMatches(text: string): TaskReferenceMatch[] {
  if (!text) return []

  const matches: TaskReferenceMatch[] = []
  const re = new RegExp(TASK_REFERENCE_TOKEN_RE)

  for (let match = re.exec(text); match !== null; match = re.exec(text)) {
    const rawToken = match[0]
    const cleanedToken = trimTrailingPunctuation(rawToken)
    if (!cleanedToken) continue

    const identifier =
      normalizeTaskReferenceIdentifier(cleanedToken) ?? parseTaskReferenceHref(cleanedToken)?.identifier ?? null

    if (!identifier) continue

    matches.push({
      index: match.index,
      length: cleanedToken.length,
      identifier,
      matchedText: cleanedToken
    })
  }

  return matches
}

export function extractTaskReferenceIdentifiers(markdown: string): string[] {
  const scrubbed = stripMarkdownCode(markdown)
  const seen = new Set<string>()
  const ordered: string[] = []

  for (const match of findTaskReferenceMatches(scrubbed)) {
    if (seen.has(match.identifier)) continue
    seen.add(match.identifier)
    ordered.push(match.identifier)
  }

  return ordered
}
