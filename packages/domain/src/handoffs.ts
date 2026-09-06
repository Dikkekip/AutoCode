import type { HandoffAllowedScope, HandoffArtifact, HandoffVerification, HandoffVerificationStatus } from "./types.js"

const VERIFICATION_STATUSES: ReadonlySet<HandoffVerificationStatus> = new Set([
  "not_run",
  "passed",
  "failed",
  "partial",
  "blocked"
])

export type HandoffDraft = {
  id?: string
  createdAt?: string
  sourcePersona: string
  targetPersona: string
  contextSummary: string
  completedWork: string[]
  openQuestions: string[]
  risks: string[]
  requiredFiles: string[]
  verificationStatus: HandoffVerification
  nextRecommendedAction: string
  allowedScope: HandoffAllowedScope
  sourceTaskId?: string | null
  targetTaskId?: string | null
  metadata?: Record<string, unknown>
}

function cleanString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid handoff: ${field} must be a non-empty string.`)
  }
  return value.trim()
}

function cleanStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid handoff: ${field} must be an array of strings.`)
  }
  return Array.from(
    new Set(value.map((entry, index) => cleanString(entry, `${field}[${index}]`)).filter((entry) => entry.length > 0))
  )
}

function cleanOptionalId(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null
  return cleanString(value, field)
}

function cleanRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined || value === null) return {}
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid handoff: ${field} must be an object.`)
  }
  return value as Record<string, unknown>
}

function validateVerification(value: unknown): HandoffVerification {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid handoff: verificationStatus must be an object.")
  }
  const input = value as Record<string, unknown>
  const status = cleanString(input.status, "verificationStatus.status") as HandoffVerificationStatus
  if (!VERIFICATION_STATUSES.has(status)) {
    throw new Error(`Invalid handoff: verificationStatus.status is not supported: ${status}.`)
  }
  return {
    status,
    summary: cleanString(input.summary, "verificationStatus.summary"),
    evidence: cleanStringArray(input.evidence ?? [], "verificationStatus.evidence")
  }
}

function validateAllowedScope(value: unknown): HandoffAllowedScope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid handoff: allowedScope must be an object.")
  }
  const input = value as Record<string, unknown>
  return {
    summary: cleanString(input.summary, "allowedScope.summary"),
    paths: cleanStringArray(input.paths ?? [], "allowedScope.paths"),
    commands: cleanStringArray(input.commands ?? [], "allowedScope.commands"),
    constraints: cleanStringArray(input.constraints ?? [], "allowedScope.constraints")
  }
}

export function validateHandoffArtifact(value: unknown): HandoffArtifact {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid handoff: artifact must be an object.")
  }
  const input = value as Record<string, unknown>
  const version = Number(input.version ?? 1)
  if (version !== 1) {
    throw new Error(`Invalid handoff: unsupported version ${version}.`)
  }
  return {
    version: 1,
    id: cleanString(input.id, "id"),
    createdAt: cleanString(input.createdAt, "createdAt"),
    sourcePersona: cleanString(input.sourcePersona, "sourcePersona"),
    targetPersona: cleanString(input.targetPersona, "targetPersona"),
    contextSummary: cleanString(input.contextSummary, "contextSummary"),
    completedWork: cleanStringArray(input.completedWork, "completedWork"),
    openQuestions: cleanStringArray(input.openQuestions, "openQuestions"),
    risks: cleanStringArray(input.risks, "risks"),
    requiredFiles: cleanStringArray(input.requiredFiles, "requiredFiles"),
    verificationStatus: validateVerification(input.verificationStatus),
    nextRecommendedAction: cleanString(input.nextRecommendedAction, "nextRecommendedAction"),
    allowedScope: validateAllowedScope(input.allowedScope),
    sourceTaskId: cleanOptionalId(input.sourceTaskId, "sourceTaskId"),
    targetTaskId: cleanOptionalId(input.targetTaskId, "targetTaskId"),
    metadata: cleanRecord(input.metadata, "metadata")
  }
}

export function buildHandoffArtifact(draft: HandoffDraft, id: string, createdAt: string): HandoffArtifact {
  return validateHandoffArtifact({
    version: 1,
    id: draft.id ?? id,
    createdAt: draft.createdAt ?? createdAt,
    sourcePersona: draft.sourcePersona,
    targetPersona: draft.targetPersona,
    contextSummary: draft.contextSummary,
    completedWork: draft.completedWork,
    openQuestions: draft.openQuestions,
    risks: draft.risks,
    requiredFiles: draft.requiredFiles,
    verificationStatus: draft.verificationStatus,
    nextRecommendedAction: draft.nextRecommendedAction,
    allowedScope: draft.allowedScope,
    sourceTaskId: draft.sourceTaskId ?? null,
    targetTaskId: draft.targetTaskId ?? null,
    metadata: draft.metadata ?? {}
  })
}

export function renderHandoffArtifact(handoff: HandoffArtifact): string[] {
  const section = (title: string, values: string[]) =>
    values.length > 0 ? ["", `${title}:`, ...values.map((value) => `- ${value}`)] : []

  return [
    `handoff: ${handoff.id}`,
    `source: ${handoff.sourcePersona}`,
    `target: ${handoff.targetPersona}`,
    `created_at: ${handoff.createdAt}`,
    "",
    `Context: ${handoff.contextSummary}`,
    ...section("Completed work", handoff.completedWork),
    ...section("Open questions", handoff.openQuestions),
    ...section("Risks", handoff.risks),
    ...section("Required files", handoff.requiredFiles),
    "",
    `Verification: ${handoff.verificationStatus.status} - ${handoff.verificationStatus.summary}`,
    ...section("Verification evidence", handoff.verificationStatus.evidence),
    "",
    `Next action: ${handoff.nextRecommendedAction}`,
    `Allowed scope: ${handoff.allowedScope.summary}`,
    ...section("Allowed paths", handoff.allowedScope.paths),
    ...section("Allowed commands", handoff.allowedScope.commands),
    ...section("Scope constraints", handoff.allowedScope.constraints)
  ]
}
