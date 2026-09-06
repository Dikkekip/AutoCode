export interface TextDiffOptions {
  oldLabel?: string
  newLabel?: string
  contextLines?: number
}

export interface TextDiffResult {
  changed: boolean
  oldText: string | null
  newText: string
  unifiedDiff: string
}

type DiffOp = { type: "equal"; line: string } | { type: "remove"; line: string } | { type: "add"; line: string }

type DiffHunk = {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  lines: string[]
}

const DEFAULT_CONTEXT_LINES = 3
const MAX_LCS_CELLS = 200_000

export function createTextDiff(
  oldText: string | null | undefined,
  newText: string,
  options: TextDiffOptions = {}
): TextDiffResult {
  const normalizedOld = oldText ?? null
  const changed = normalizedOld !== newText
  return {
    changed,
    oldText: normalizedOld,
    newText,
    unifiedDiff: createUnifiedDiff(normalizedOld, newText, options)
  }
}

export function createUnifiedDiff(
  oldText: string | null | undefined,
  newText: string,
  options: TextDiffOptions = {}
): string {
  const oldLabel = options.oldLabel ?? "a/file"
  const newLabel = options.newLabel ?? "b/file"
  const contextLines = Math.max(0, options.contextLines ?? DEFAULT_CONTEXT_LINES)
  const normalizedOld = oldText ?? ""

  if (normalizedOld === newText) {
    return `--- ${oldLabel}\n+++ ${newLabel}\n`
  }

  const oldLines = splitLines(normalizedOld)
  const newLines = splitLines(newText)
  const ops = diffLines(oldLines, newLines)
  const hunks = buildHunks(ops, contextLines)

  const body = hunks.map(formatHunk).join("")
  return `--- ${oldLabel}\n+++ ${newLabel}\n${body}`
}

function splitLines(value: string): string[] {
  return value.split("\n")
}

function diffLines(oldLines: string[], newLines: string[]): DiffOp[] {
  const cellCount = oldLines.length * newLines.length
  if (cellCount > MAX_LCS_CELLS) {
    return diffLinesByPrefixSuffix(oldLines, newLines)
  }

  const table = Array.from({ length: oldLines.length + 1 }, () => Array<number>(newLines.length + 1).fill(0))
  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      table[i]![j] =
        oldLines[i] === newLines[j]
          ? (table[i + 1]![j + 1] ?? 0) + 1
          : Math.max(table[i + 1]![j] ?? 0, table[i]![j + 1] ?? 0)
    }
  }

  const ops: DiffOp[] = []
  let i = 0
  let j = 0
  while (i < oldLines.length && j < newLines.length) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ type: "equal", line: oldLines[i]! })
      i += 1
      j += 1
      continue
    }

    const down = table[i + 1]![j] ?? 0
    const right = table[i]![j + 1] ?? 0
    if (down >= right) {
      ops.push({ type: "remove", line: oldLines[i]! })
      i += 1
    } else {
      ops.push({ type: "add", line: newLines[j]! })
      j += 1
    }
  }

  while (i < oldLines.length) {
    ops.push({ type: "remove", line: oldLines[i]! })
    i += 1
  }
  while (j < newLines.length) {
    ops.push({ type: "add", line: newLines[j]! })
    j += 1
  }

  return ops
}

function diffLinesByPrefixSuffix(oldLines: string[], newLines: string[]): DiffOp[] {
  let prefix = 0
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix += 1
  }

  let oldSuffix = oldLines.length - 1
  let newSuffix = newLines.length - 1
  while (oldSuffix >= prefix && newSuffix >= prefix && oldLines[oldSuffix] === newLines[newSuffix]) {
    oldSuffix -= 1
    newSuffix -= 1
  }

  const ops: DiffOp[] = []
  for (let index = 0; index < prefix; index += 1) {
    ops.push({ type: "equal", line: oldLines[index]! })
  }
  for (let index = prefix; index <= oldSuffix; index += 1) {
    ops.push({ type: "remove", line: oldLines[index]! })
  }
  for (let index = prefix; index <= newSuffix; index += 1) {
    ops.push({ type: "add", line: newLines[index]! })
  }
  for (let index = oldSuffix + 1; index < oldLines.length; index += 1) {
    ops.push({ type: "equal", line: oldLines[index]! })
  }
  return ops
}

function buildHunks(ops: DiffOp[], contextLines: number): DiffHunk[] {
  const hunks: DiffHunk[] = []
  let oldLine = 1
  let newLine = 1
  let index = 0

  while (index < ops.length) {
    while (index < ops.length && ops[index]?.type === "equal") {
      oldLine += 1
      newLine += 1
      index += 1
    }

    if (index >= ops.length) {
      break
    }

    const hunkStart = Math.max(0, index - contextLines)
    let hunkEnd = index
    let trailingContext = 0
    while (hunkEnd < ops.length) {
      const op = ops[hunkEnd]!
      if (op.type === "equal") {
        trailingContext += 1
        if (trailingContext > contextLines) {
          hunkEnd -= trailingContext
          break
        }
      } else {
        trailingContext = 0
      }
      hunkEnd += 1
    }
    if (hunkEnd >= ops.length) {
      hunkEnd = ops.length - 1
    }

    const startPositions = lineNumbersAtIndex(ops, hunkStart)
    const hunkOps = ops.slice(hunkStart, hunkEnd + 1)
    const oldCount = hunkOps.filter((op) => op.type !== "add").length
    const newCount = hunkOps.filter((op) => op.type !== "remove").length

    hunks.push({
      oldStart: startPositions.oldLine,
      oldCount,
      newStart: startPositions.newLine,
      newCount,
      lines: hunkOps.map((op) => `${prefixForOp(op.type)}${op.line}`)
    })

    index = hunkEnd + 1
    oldLine = startPositions.oldLine + oldCount
    newLine = startPositions.newLine + newCount
  }

  return hunks
}

function lineNumbersAtIndex(ops: DiffOp[], index: number): { oldLine: number; newLine: number } {
  let oldLine = 1
  let newLine = 1
  for (let cursor = 0; cursor < index; cursor += 1) {
    const op = ops[cursor]!
    if (op.type !== "add") oldLine += 1
    if (op.type !== "remove") newLine += 1
  }
  return { oldLine, newLine }
}

function prefixForOp(type: DiffOp["type"]): string {
  switch (type) {
    case "equal":
      return " "
    case "remove":
      return "-"
    case "add":
      return "+"
  }
}

function formatHunk(hunk: DiffHunk): string {
  const oldRange = formatRange(hunk.oldStart, hunk.oldCount)
  const newRange = formatRange(hunk.newStart, hunk.newCount)
  return `@@ -${oldRange} +${newRange} @@\n${hunk.lines.join("\n")}\n`
}

function formatRange(start: number, count: number): string {
  if (count === 1) return String(start)
  if (count === 0) return `${start},0`
  return `${start},${count}`
}
