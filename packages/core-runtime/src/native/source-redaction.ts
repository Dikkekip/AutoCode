import { redactCommandText, redactLogText } from "@openclaw/domain"

// Protect only complete, bounded opening tags with attribute-level references.
const REFERENCE_EXPRESSION = /^\{\s*[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*\}$/
// Equality against a browser keyboard name is not a credential assignment.
// Keep this source-only and narrow; literals, comments and arbitrary key values
// still go through the normal credential filters.
const KEYBOARD_COMPARISON =
  /^\.key[ \t]*==={0,1}[ \t]*(["'])(?:Escape|Enter|Tab| |ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|Backspace|Delete)\1/
// The numeric 229 browser keyCode marks IME composition. Protect only that
// fixed comparison; other keyCode values still pass through credential filters.
const IME_KEYCODE_COMPARISON = /^\.keyCode[ \t]*===[ \t]*229\b/
const KEYBOARD_HANDLER = /^onKeyDown[ \t]*=[ \t]*\{[ \t]*\([ \t]*[A-Za-z_$][\w$]*[ \t]*\)[ \t]*=>/
const KEYBOARD_CALLBACK =
  /^(?:onKeyDown|handleKeyDown)[ \t]*=[ \t]*\([ \t]*[A-Za-z_$][\w$]*[ \t]*:[ \t]*KeyboardEvent[ \t]*\)[ \t]*=>/
// A strict comparison with another variable has no literal credential value.
// The broad command filter otherwise mistakes `key === SOME_IDENTIFIER` for
// an assignment and hides part of a reviewable committed patch.
const KEY_IDENTIFIER_COMPARISON = /^key[ \t]*===[ \t]*[A-Za-z_$][\w$]*/
const KEY_IDENTIFIER_KEYBOARD_COMPARISON =
  /^key[ \t]*===[ \t]*(["'])(?:Escape|Enter|Tab| |ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|Backspace|Delete)\1/

function quotedEnd(source: string, start: number, limit: number): number {
  const quote = source[start]
  let cursor = start + 1
  while (cursor < limit) {
    if (source[cursor] === "\\") cursor += 2
    else if (source[cursor++] === quote) return cursor
  }
  return limit
}

// JSX opening-tag parsing skips nested handler bodies. Shield only known
// keyboard callback names and literal keyboard comparisons before that scan.
function protectKeyboardSyntax(source: string, keyMarker: string, handlerMarker: string): string {
  const chunks: string[] = []
  let copied = 0
  let cursor = 0
  while (cursor < source.length) {
    const char = source[cursor]
    if (char === '"' || char === "'" || char === "`") {
      // Diff hunks can juxtapose removed and added lines, leaving a quote
      // unmatched in the patch even when each committed file is valid.
      const newline = source.indexOf("\n", cursor)
      cursor = quotedEnd(source, cursor, char === "`" || newline < 0 ? source.length : newline)
    } else if (source.slice(cursor, cursor + 2) === "//") {
      const end = source.indexOf("\n", cursor + 2)
      cursor = end < 0 ? source.length : end + 1
    } else if (source.slice(cursor, cursor + 2) === "/*") {
      const end = source.indexOf("*/", cursor + 2)
      cursor = end < 0 ? source.length : end + 2
    } else if (
      (source.startsWith("onKeyDown", cursor) || source.startsWith("handleKeyDown", cursor)) &&
      /[\s<]/.test(source[cursor - 1] ?? "") &&
      (KEYBOARD_HANDLER.test(source.slice(cursor, cursor + 160)) ||
        (/\bconst[ \t]+$/.test(source.slice(Math.max(0, cursor - 16), cursor)) &&
          KEYBOARD_CALLBACK.test(source.slice(cursor, cursor + 160))))
    ) {
      const prefixLength = source.startsWith("handleKeyDown", cursor) ? 6 : 2
      chunks.push(source.slice(copied, cursor + prefixLength), handlerMarker)
      copied = cursor + prefixLength + 3
      cursor += prefixLength + 7
    } else if (
      char === "." &&
      (KEYBOARD_COMPARISON.test(source.slice(cursor, cursor + 80)) ||
        IME_KEYCODE_COMPARISON.test(source.slice(cursor, cursor + 80)))
    ) {
      chunks.push(source.slice(copied, cursor + 1), keyMarker)
      copied = cursor + 4
      cursor += 4
    } else cursor++
  }
  chunks.push(source.slice(copied))
  return chunks.join("")
}

function openingTag(source: string, start: number): { end: number; keys: number[] } {
  const limit = Math.min(source.length, start + 4096)
  let cursor = start + 1
  const keys: number[] = []
  while (cursor < limit && /[\w.:-]/.test(source[cursor]!)) cursor++
  while (cursor < limit) {
    const beforeSpace = cursor
    while (cursor < limit && /\s/.test(source[cursor]!)) cursor++
    if (source[cursor] === ">") return { end: cursor + 1, keys }
    if (source.slice(cursor, cursor + 2) === "/>") return { end: cursor + 2, keys }
    if (cursor === beforeSpace || !/[A-Za-z_:]/.test(source[cursor] ?? "")) break
    const nameStart = cursor++
    while (cursor < limit && /[\w.:-]/.test(source[cursor]!)) cursor++
    const name = source.slice(nameStart, cursor)
    const nameEnd = cursor
    while (cursor < limit && /\s/.test(source[cursor]!)) cursor++
    if (source[cursor] !== "=") {
      cursor = nameEnd // Boolean attribute; whitespace belongs to the next attribute.
      continue
    }
    cursor++
    while (cursor < limit && /\s/.test(source[cursor]!)) cursor++
    if (source[cursor] === '"' || source[cursor] === "'") {
      cursor = quotedEnd(source, cursor, limit)
      continue
    }
    if (source[cursor] !== "{") break
    const valueStart = cursor++
    let depth = 1
    while (cursor < limit && depth > 0) {
      const char = source[cursor]
      if (char === '"' || char === "'" || char === "`") {
        cursor = quotedEnd(source, cursor, limit)
      } else if (source.slice(cursor, cursor + 2) === "/*") {
        const end = source.slice(cursor + 2, limit).indexOf("*/")
        cursor = end < 0 ? limit : cursor + end + 4
      } else if (source.slice(cursor, cursor + 2) === "//") {
        const end = source.slice(cursor + 2, limit).indexOf("\n")
        cursor = end < 0 ? limit : cursor + end + 3
      } else {
        cursor++
        if (char === "{") depth++
        if (char === "}") depth--
      }
    }
    if (depth !== 0) break
    if (name === "key" && REFERENCE_EXPRESSION.test(source.slice(valueStart, cursor))) {
      keys.push(nameStart)
    }
  }
  return { end: Math.max(start + 1, cursor), keys: [] }
}

// A cache-key factory reference carries no literal value. Recognize only this
// complete narrow grammar, and protect only the declaration name's Key suffix.
function queryReference(source: string, start: number): { key: number; end: number } | undefined {
  const limit = Math.min(source.length, start + 4096)
  let cursor = start + 5 // const
  const space = () => {
    while (cursor < limit && /[ \t]/.test(source[cursor]!)) cursor++
  }
  const identifier = () => {
    const begin = cursor
    if (cursor >= limit || !/[A-Za-z_$]/.test(source[cursor]!)) return ""
    cursor++
    while (cursor < limit && /[\w$]/.test(source[cursor]!)) cursor++
    return source.slice(begin, cursor)
  }
  const take = (value: string) => {
    space()
    if (cursor >= limit || source[cursor] !== value) return false
    cursor++
    return true
  }
  if (!/[ \t]/.test(source[cursor] ?? "")) return undefined
  space()
  const name = identifier(),
    key = cursor - 3
  if (!name.endsWith("Key") || !take("=")) return undefined
  space()
  if (!identifier().endsWith("QueryKeys") || !take(".")) return undefined
  space()
  if (!identifier() || !take("(") || !take("{")) return undefined
  while (cursor < limit) {
    space()
    if (!identifier()) return undefined
    space()
    if (source[cursor] === "}") break
    if (!take(",")) return undefined
    space()
    if (source[cursor] === "}") break
  }
  if (!take("}") || !take(")") || !take(";")) return undefined
  return { key, end: cursor }
}

// A dotted JavaScript member reference can resemble the command filter's broad
// JWT pattern. Protect its separators only in source code, never in strings or
// comments. A base64url JSON header remains credential-shaped even when bare.
function memberReference(source: string, start: number): string | undefined {
  const spread = source.slice(start - 3, start) === "..." && !/[\w$.]/.test(source[start - 4] ?? "")
  if (!spread && /[\w$.-]/.test(source[start - 1] ?? "")) return undefined
  const reference = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*){2,}/.exec(source.slice(start, start + 4096))?.[0]
  if (!reference || /[\w$.-]/.test(source[start + reference.length] ?? "")) return undefined
  const header = reference.slice(0, reference.indexOf("."))
  if (/^eyJ/.test(header)) return undefined
  try {
    const decoded = JSON.parse(Buffer.from(header, "base64url").toString("utf8"))
    if (decoded && typeof decoded === "object") return undefined
  } catch {
    // Ordinary identifiers are not JWT headers.
  }
  return reference
}

function protectReferenceNames(source: string, marker: string, queryMarker: string, dotMarker: string): string {
  const chunks: string[] = []
  let copied = 0
  let cursor = 0
  while (cursor < source.length) {
    const char = source[cursor]
    if (char === '"' || char === "'" || char === "`") {
      cursor = quotedEnd(source, cursor, source.length)
    } else if (source.slice(cursor, cursor + 2) === "//") {
      const end = source.indexOf("\n", cursor + 2)
      cursor = end < 0 ? source.length : end + 1
    } else if (source.slice(cursor, cursor + 2) === "/*") {
      const end = source.indexOf("*/", cursor + 2)
      cursor = end < 0 ? source.length : end + 2
    } else if (
      char === "." &&
      (KEYBOARD_COMPARISON.test(source.slice(cursor, cursor + 80)) ||
        IME_KEYCODE_COMPARISON.test(source.slice(cursor, cursor + 80)))
    ) {
      chunks.push(source.slice(copied, cursor + 1), marker)
      copied = cursor + 4
      cursor += 4
    } else if (source.startsWith("const", cursor) && !/[\w$]/.test(source[cursor - 1] ?? "")) {
      const query = queryReference(source, cursor)
      if (query) {
        chunks.push(source.slice(copied, query.key), queryMarker)
        copied = query.key + 3
        cursor = query.end
      } else cursor++
    } else if (char === "<" && /[A-Za-z]/.test(source[cursor + 1] ?? "")) {
      const tag = openingTag(source, cursor)
      for (const key of tag.keys) {
        chunks.push(source.slice(copied, key), marker)
        copied = key + 3
      }
      cursor = tag.end
    } else if (
      source.startsWith("key", cursor) &&
      !/[\w$]/.test(source[cursor - 1] ?? "") &&
      (KEY_IDENTIFIER_COMPARISON.test(source.slice(cursor, cursor + 160)) ||
        KEY_IDENTIFIER_KEYBOARD_COMPARISON.test(source.slice(cursor, cursor + 160)))
    ) {
      chunks.push(source.slice(copied, cursor), marker)
      copied = cursor + 3
      cursor += 3
    } else if (/[A-Za-z_$]/.test(char ?? "")) {
      const reference = memberReference(source, cursor)
      if (reference) {
        chunks.push(source.slice(copied, cursor), reference.split(".").join(dotMarker))
        copied = cursor + reference.length
        cursor = copied
      } else cursor++
    } else cursor++
  }
  chunks.push(source.slice(copied))
  return chunks.join("")
}

const QUOTED_ASSIGNMENT_START =
  /(\b[A-Za-z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD|AUTHORIZATION|JWT)[A-Za-z0-9_]*\s*=+\s*(?:\{\s*)?)(["'])/gi

function redactQuotedAssignments(source: string): string {
  const pattern = new RegExp(QUOTED_ASSIGNMENT_START)
  let cursor = 0
  let output = ""
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    const start = pattern.lastIndex
    let end = start
    while (end < source.length && source[end] !== match[2]) {
      end += source[end] === "\\" ? 2 : 1
    }
    output += source.slice(cursor, start) + "***REDACTED***"
    if (end >= source.length) return output // Malformed literal: redact its entire remaining value.
    output += match[2]
    cursor = end + 1
    pattern.lastIndex = cursor
  }
  return output + source.slice(cursor)
}
const PRIVATE_KEY_BLOCK =
  /(-----BEGIN ((?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY)-----)[\s\S]*?(-----END \2-----|$)/g

/** Source-only handling; command and log redaction policies remain unchanged. */
export function redactNativeSourceText(source: string): string {
  // Choose one absent marker per reference kind. Restoration has a constant
  // number of linear scans, independent of the number of protected references.
  const occupied = new Set(Array.from(source.matchAll(/__SOURCE_ATTRIBUTE_(\d+)__/g), (match) => match[1]))
  let serial = 0
  while (occupied.has(String(serial))) serial++
  const marker = `__SOURCE_ATTRIBUTE_${serial}__`
  const occupiedQueries = new Set(Array.from(source.matchAll(/__SOURCE_QUERY_REFERENCE_(\d+)__/g), (match) => match[1]))
  let querySerial = 0
  while (occupiedQueries.has(String(querySerial))) querySerial++
  const queryMarker = `__SOURCE_QUERY_REFERENCE_${querySerial}__`
  const occupiedDots = new Set(Array.from(source.matchAll(/__SOURCE_MEMBER_DOT_(\d+)__/g), (match) => match[1]))
  let dotSerial = 0
  while (occupiedDots.has(String(dotSerial))) dotSerial++
  // Non-identifier punctuation keeps adjacent credential-token scanning intact.
  const dotMarker = `:__SOURCE_MEMBER_DOT_${dotSerial}__:`
  const prepared = protectReferenceNames(
    protectKeyboardSyntax(source, marker, queryMarker),
    marker,
    queryMarker,
    dotMarker
  )
  const literals = redactQuotedAssignments(prepared)
  const pem = literals.replace(PRIVATE_KEY_BLOCK, "$1\n***REDACTED***\n$3")
  const redacted = redactLogText(redactCommandText(pem))
  return redacted.split(marker).join("key").split(queryMarker).join("Key").split(dotMarker).join(".")
}
