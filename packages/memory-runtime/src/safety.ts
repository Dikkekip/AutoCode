export interface MemorySafetyResult {
  allowed: boolean
  reason?: string
}

export const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/i, reason: "private key material" },
  { pattern: /\b(ghp|github_pat|glpat|xox[baprs])-?[A-Za-z0-9_=-]{12,}\b/i, reason: "access token" },
  { pattern: /\b(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S+/i, reason: "credential-like assignment" },
  { pattern: /\b(AccountKey|SharedAccessKey|DefaultEndpointsProtocol)=/i, reason: "connection string secret" },
  { pattern: /\b\d{3}-\d{2}-\d{4}\b/, reason: "PII-like identifier (SSN)" },
  { pattern: /\b(?:10|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}\b/, reason: "internal network topology" },
  { pattern: /\b(raw logs?|stack trace|telemetry payload|dump file)\b/i, reason: "raw diagnostic payload" },
  { pattern: /\b(CI|PR|build)\s+(status|failed|passed|output|log)\b/i, reason: "transient CI/PR status" },
  {
    pattern: /\b(private|confidential|restricted)\s+customer\s+(data|record|records|details|information|info)\b/i,
    reason: "private customer data"
  },
  { pattern: /\bcustomer\s+(pii|personal data|tenant secret|production data)\b/i, reason: "private customer data" },
  { pattern: /\bunreviewed\s+(security\s+)?vulnerabilit(?:y|ies)\b/i, reason: "unreviewed vulnerability disclosure" },
  { pattern: /\b(?:0-day|zero-day)\b/i, reason: "unreviewed vulnerability disclosure" }
]

export function checkMemorySafety(content: string, title?: string): MemorySafetyResult {
  const normalizedContent = content.trim()
  const normalizedTitle = title?.trim() ?? ""

  for (const { pattern, reason } of FORBIDDEN_PATTERNS) {
    if (pattern.test(normalizedContent) || (normalizedTitle && pattern.test(normalizedTitle))) {
      return {
        allowed: false,
        reason: `Rejected as forbidden memory: ${reason}`
      }
    }
  }

  return { allowed: true }
}
