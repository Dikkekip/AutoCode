import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, relative, resolve } from "node:path"

import { createTextDiff, type TextDiffResult } from "./diff.js"

const NO_MATCH_PREVIEW_LINES = 20

export interface PathAccessOptions {
  cwd?: string
  allowedRoots?: string[]
}

export interface FileReadOptions extends PathAccessOptions {
  line?: number
  limit?: number
}

export interface FileWriteOptions extends PathAccessOptions {
  createParents?: boolean
}

export interface FileReadResult {
  path: string
  absolutePath: string
  content: string
}

export interface FileWriteResult {
  path: string
  absolutePath: string
  created: boolean
  content: string
  lineCount: number
  summary: string
  diff: TextDiffResult
}

export interface FileEditRequest {
  path: string
  before: string
  after: string
}

export function resolvePath(path: string, options: PathAccessOptions = {}): string {
  const cwd = options.cwd ? resolve(options.cwd) : process.cwd()
  const absolutePath = isAbsolute(path) ? resolve(path) : resolve(cwd, path)
  assertPathAccess(absolutePath, options.allowedRoots)
  return absolutePath
}

export function readTextFile(path: string, options: FileReadOptions = {}): FileReadResult {
  const absolutePath = resolvePath(path, options)
  const content = readFileSync(absolutePath, "utf8")
  return {
    path,
    absolutePath,
    content: applyLineLimit(content, options.line, options.limit)
  }
}

export function writeTextFile(path: string, content: string, options: FileWriteOptions = {}): FileWriteResult {
  const absolutePath = resolvePath(path, options)
  const parent = dirname(absolutePath)
  if (options.createParents !== false && parent && !existsSync(parent)) {
    mkdirSync(parent, { recursive: true })
  }

  const created = !existsSync(absolutePath)
  const previous = created ? null : readFileSync(absolutePath, "utf8")
  writeFileSync(absolutePath, content, "utf8")

  return {
    path,
    absolutePath,
    created,
    content,
    lineCount: content.split(/\r?\n/).length,
    summary: `${created ? "Created" : "Wrote"} ${path} (${content.split(/\r?\n/).length} lines)`,
    diff: createTextDiff(previous, content, { oldLabel: path, newLabel: path })
  }
}

export function editTextFile(request: FileEditRequest, options: FileWriteOptions = {}): FileWriteResult {
  const absolutePath = resolvePath(request.path, options)
  const current = readFileSync(absolutePath, "utf8")
  const next = stringReplace(current, request.before, request.after)
  writeFileSync(absolutePath, next, "utf8")

  return {
    path: request.path,
    absolutePath,
    created: false,
    content: next,
    lineCount: next.split(/\r?\n/).length,
    summary: `Edited ${request.path} (${request.before.split(/\r?\n/).length} lines -> ${request.after.split(/\r?\n/).length} lines)`,
    diff: createTextDiff(current, next, { oldLabel: request.path, newLabel: request.path })
  }
}

export function stringReplace(content: string, before: string, after: string): string {
  const matches = Array.from(content.matchAll(escapeRegExp(before) ? new RegExp(escapeRegExp(before), "g") : /$^/g))
  switch (matches.length) {
    case 0: {
      const suggestion = findSimilarContext(content, before)
      const preview = buildFilePreview(content, NO_MATCH_PREVIEW_LINES)
      const parts = ["No match found for the specified text."]
      if (suggestion) {
        parts.push(`Did you mean:\n\`\`\`\n${suggestion}\n\`\`\``)
      }
      parts.push(`File preview:\n\`\`\`\n${preview}\n\`\`\``)
      throw new Error(parts.join("\n\n"))
    }
    case 1:
      return content.replace(before, after)
    default: {
      const previews = matches.slice(0, 2).map((match, index) => {
        const lineNumber = countLinesBefore(content, match.index ?? 0)
        return `Match ${index + 1} (line ${lineNumber}):\n\`\`\`\n${getLineContext(content, lineNumber, 1)}\n\`\`\``
      })
      const suffix = matches.length > 2 ? `\n\n...and ${matches.length - 2} more` : ""
      throw new Error(
        `Found ${matches.length} matches. Please provide more context to identify a unique match:\n\n${previews.join("\n\n")}${suffix}`
      )
    }
  }
}

export function applyLineLimit(content: string, line?: number, limit?: number): string {
  if (!line && !limit) {
    return content
  }

  const lines = content.split("\n")
  const start = Math.max(0, (line ?? 1) - 1)
  const end = limit ? Math.min(lines.length, start + limit) : lines.length
  return lines.slice(start, end).join("\n")
}

function assertPathAccess(targetPath: string, allowedRoots: string[] = []): void {
  if (allowedRoots.length === 0) {
    return
  }

  const normalizedTarget = canonicalizeForAccess(targetPath)
  for (const root of allowedRoots) {
    const normalizedRoot = canonicalizeForAccess(root)
    const rel = relative(normalizedRoot, normalizedTarget)
    if (rel === "" || (!rel.startsWith("..") && rel !== "..")) {
      return
    }
  }

  throw new Error(`Access denied for path outside allowed roots: ${targetPath}`)
}

function canonicalizeForAccess(targetPath: string): string {
  if (existsSync(targetPath)) {
    return realpathSync(targetPath)
  }

  let current = resolve(targetPath)
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) {
      return current
    }
    current = parent
  }

  const resolvedParent = realpathSync(current)
  const rel = relative(current, resolve(targetPath))
  return rel ? resolve(resolvedParent, rel) : resolvedParent
}

function countLinesBefore(content: string, bytePos: number): number {
  return content.slice(0, bytePos).split("\n").length
}

function getLineContext(content: string, targetLine: number, context: number): string {
  const lines = content.split(/\r?\n/)
  const start = Math.max(0, targetLine - context - 1)
  const end = Math.min(lines.length, targetLine + context)
  return lines.slice(start, end).join("\n")
}

function findSimilarContext(content: string, search: string): string | null {
  const firstLine = search.split(/\r?\n/)[0]?.trim()
  if (!firstLine) {
    return null
  }

  const lines = content.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    if (line.includes(firstLine) || firstLine.includes(line.trim())) {
      return getLineContext(content, index + 1, 2)
    }
  }

  return null
}

function buildFilePreview(content: string, maxLines: number): string {
  if (!content) {
    return "(file is empty)"
  }

  const lines = content.split(/\r?\n/)
  const visible = lines
    .slice(0, maxLines)
    .map((line, index) => `${String(index + 1).padStart(4, " ")}: ${line}`)
    .join("\n")

  return lines.length > maxLines ? `${visible}\n... (${lines.length - maxLines} more lines)` : visible
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
