export const REDACTED_HOME_PATH_USER = "*"
export const REDACTED_COMMAND_TEXT_VALUE = "***REDACTED***"

type HomePathRedactionOptions = {
  enabled?: boolean
}

function maskHomePathUserSegment(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return REDACTED_HOME_PATH_USER
  return `${trimmed[0]}${"*".repeat(Math.max(1, Array.from(trimmed).length - 1))}`
}

const HOME_PATH_PATTERNS = [
  {
    regex: /\/Users\/([^/\\\s]+)/g,
    replace: (_match: string, user: string) => `/Users/${maskHomePathUserSegment(user)}`
  },
  {
    regex: /\/home\/([^/\\\s]+)/g,
    replace: (_match: string, user: string) => `/home/${maskHomePathUserSegment(user)}`
  },
  {
    regex: /([A-Za-z]:\\Users\\)([^\\/\s]+)/g,
    replace: (_match: string, prefix: string, user: string) => `${prefix}${maskHomePathUserSegment(user)}`
  }
] as const

const SECRET_VALUE_PATTERNS = [
  /\b(?:sk|pk|rk|ghp|github_pat|glpat|xox[baprs])-[-_A-Za-z0-9]{12,}\b/g,
  /\b[A-Za-z0-9._%+-]+:[A-Za-z0-9._%+-]{12,}@/g
] as const

const SECRET_ASSIGNMENT_PATTERN =
  /\b((?:api[_-]?key|token|secret|password|passwd|credential|authorization|auth[_-]?token)\b\s*[:=]\s*)(["']?)([^"'\s,;]{4,})(\2)/gi

const COMMAND_CLI_SECRET_OPTION_RE =
  /(\B-{1,2}(?:api[-_]?key|(?:access[-_]?|auth[-_]?)?token|token|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)(?:\s+|=)(["']?))[^\s"'`]+(\2)/gi
const COMMAND_ENV_SECRET_ASSIGNMENT_RE =
  /(\b[A-Za-z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD|AUTHORIZATION|JWT)[A-Za-z0-9_]*\s*=\s*)[^\s"'`]+/gi
const COMMAND_AUTHORIZATION_BEARER_RE = /(\bAuthorization\s*:\s*Bearer\s+)[^\s"'`]+/gi
const COMMAND_OPENAI_KEY_RE = /\bsk-[A-Za-z0-9_-]{12,}\b/g
const COMMAND_GITHUB_TOKEN_RE = /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g
const COMMAND_JWT_RE = /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})?\b/g

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

export function redactHomePathUserSegments(text: string, opts?: HomePathRedactionOptions): string {
  if (opts?.enabled === false) return text
  let result = text
  for (const pattern of HOME_PATH_PATTERNS) {
    result = result.replace(pattern.regex, pattern.replace)
  }
  return result
}

export function redactSecrets(text: string): string {
  let result = text.replace(SECRET_ASSIGNMENT_PATTERN, "$1$2[REDACTED]$4")
  for (const pattern of SECRET_VALUE_PATTERNS) {
    result = result.replace(pattern, (match) => {
      if (match.includes(":") && match.endsWith("@")) {
        return "[REDACTED]@"
      }
      return "[REDACTED]"
    })
  }
  return result
}

export function redactLogText(text: string, opts?: HomePathRedactionOptions): string {
  return redactSecrets(redactHomePathUserSegments(text, opts))
}

export function redactCommandText(command: string, redactedValue = REDACTED_COMMAND_TEXT_VALUE): string {
  return command
    .replace(COMMAND_AUTHORIZATION_BEARER_RE, `$1${redactedValue}`)
    .replace(COMMAND_CLI_SECRET_OPTION_RE, `$1${redactedValue}$3`)
    .replace(COMMAND_ENV_SECRET_ASSIGNMENT_RE, `$1${redactedValue}`)
    .replace(COMMAND_OPENAI_KEY_RE, redactedValue)
    .replace(COMMAND_GITHUB_TOKEN_RE, redactedValue)
    .replace(COMMAND_JWT_RE, redactedValue)
}

export function redactHomePathUserSegmentsInValue<T>(value: T, opts?: HomePathRedactionOptions): T {
  if (typeof value === "string") {
    return redactLogText(value, opts) as T
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactHomePathUserSegmentsInValue(entry, opts)) as T
  }
  if (!isPlainObject(value)) {
    return value
  }

  const redacted: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    redacted[key] = redactHomePathUserSegmentsInValue(entry, opts)
  }
  return redacted as T
}

export function redactLogValue<T>(value: T, opts?: HomePathRedactionOptions): T {
  return redactHomePathUserSegmentsInValue(value, opts)
}
