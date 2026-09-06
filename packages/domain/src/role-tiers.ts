import type { PersonaStage, TaskKind } from "./types.js"

export type WorkerRoleSpecialty = "developer" | "tester" | "architect" | "reviewer"
export type WorkerRoleTier = "junior" | "medior" | "senior"

export interface WorkerRoleTierDecision {
  role: WorkerRoleSpecialty
  tier: WorkerRoleTier
  sessionKey: string
  reasons: string[]
}

export interface WorkerRoleTierInput {
  projectId?: string | null | undefined
  kind: TaskKind
  stage?: PersonaStage | null | undefined
  title: string
  description?: string | null | undefined
  labels?: string[] | undefined
  changedFiles?: string[] | undefined
  allowedPaths?: string[] | undefined
  requiredReading?: string[] | undefined
  verificationCommands?: string[] | undefined
}

const JUNIOR_HINTS = ["typo", "copy", "css", "style", "label", "rename", "small", "docs"]
const SENIOR_HINTS = [
  "architecture",
  "architect",
  "migration",
  "security",
  "auth",
  "permission",
  "refactor",
  "cross-package",
  "schema",
  "database",
  "incident",
  "critical"
]
const TEST_HINTS = ["test", "qa", "verify", "verification", "smoke", "e2e", "regression"]
const REVIEW_HINTS = ["review", "promotion", "approve", "pr", "pull request", "audit"]
const ARCHITECT_HINTS = ["architecture", "architect", "rfc", "technical design", "system design", "research"]

function normalize(value: string): string {
  return value.trim().toLowerCase()
}

function slug(value: string): string {
  const normalized = normalize(value)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return normalized || "default"
}

function taskText(input: WorkerRoleTierInput): string {
  return [
    input.kind,
    input.stage ?? "",
    input.title,
    input.description ?? "",
    ...(input.labels ?? []),
    ...(input.changedFiles ?? []),
    ...(input.allowedPaths ?? []),
    ...(input.requiredReading ?? []),
    ...(input.verificationCommands ?? [])
  ]
    .map(normalize)
    .filter(Boolean)
    .join(" ")
}

function hasAny(text: string, hints: readonly string[]): boolean {
  return hints.some((hint) => text.includes(hint))
}

function inferRole(input: WorkerRoleTierInput, text: string): { role: WorkerRoleSpecialty; reason: string } {
  if (input.kind === "review" || input.kind === "promote" || input.stage === "reviewer" || input.stage === "promoter") {
    return { role: "reviewer", reason: "task is in a review or promotion stage" }
  }
  if (input.kind === "plan" || input.stage === "planner" || hasAny(text, ARCHITECT_HINTS)) {
    return { role: hasAny(text, ARCHITECT_HINTS) ? "architect" : "developer", reason: "task is planning oriented" }
  }
  if (hasAny(text, TEST_HINTS) && !hasAny(text, ["fix", "implement", "build"])) {
    return { role: "tester", reason: "task is verification oriented" }
  }
  if (hasAny(text, REVIEW_HINTS) && !hasAny(text, ["fix", "implement", "build"])) {
    return { role: "reviewer", reason: "task asks for review or audit" }
  }
  return { role: "developer", reason: "task requires implementation or repository execution" }
}

function inferTier(
  input: WorkerRoleTierInput,
  role: WorkerRoleSpecialty,
  text: string
): { tier: WorkerRoleTier; reasons: string[] } {
  const reasons: string[] = []
  const changedFileCount = input.changedFiles?.length ?? 0
  const pathCount = input.allowedPaths?.length ?? 0
  const verificationCount = input.verificationCommands?.length ?? 0
  const readingCount = input.requiredReading?.length ?? 0

  if (hasAny(text, SENIOR_HINTS) || changedFileCount >= 8 || pathCount >= 6 || readingCount >= 5) {
    reasons.push("senior signal from risk, breadth, architecture, security, or migration scope")
    return { tier: "senior", reasons }
  }

  if (role === "reviewer" && (changedFileCount >= 4 || verificationCount >= 2)) {
    reasons.push("review covers enough files or checks to need senior attention")
    return { tier: "senior", reasons }
  }

  if (role === "tester" && hasAny(text, ["e2e", "regression", "contract", "integration"])) {
    reasons.push("verification includes integration, contract, regression, or e2e work")
    return { tier: "medior", reasons }
  }

  if (
    changedFileCount <= 1 &&
    pathCount <= 1 &&
    verificationCount <= 1 &&
    (hasAny(text, JUNIOR_HINTS) || role === "tester")
  ) {
    reasons.push("small bounded change with low-risk hints")
    return { tier: "junior", reasons }
  }

  reasons.push("default tier for normal multi-file feature or bug-fix work")
  return { tier: "medior", reasons }
}

export function buildWorkerRoleSessionKey(input: {
  projectId?: string | null | undefined
  role: WorkerRoleSpecialty
  tier: WorkerRoleTier
  laneId?: string | null | undefined
}): string {
  return [slug(input.projectId ?? "project"), input.role, input.tier, slug(input.laneId ?? "general")].join(":")
}

export function selectWorkerRoleTier(
  input: WorkerRoleTierInput & { laneId?: string | null | undefined }
): WorkerRoleTierDecision {
  const text = taskText(input)
  const role = inferRole(input, text)
  const tier = inferTier(input, role.role, text)

  return {
    role: role.role,
    tier: tier.tier,
    sessionKey: buildWorkerRoleSessionKey({
      projectId: input.projectId,
      role: role.role,
      tier: tier.tier,
      laneId: input.laneId
    }),
    reasons: [role.reason, ...tier.reasons]
  }
}
