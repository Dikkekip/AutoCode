import { createHash } from "node:crypto"
import { isAbsolute, matchesGlob, normalize } from "node:path"
import { type NativeBudgetPolicy, validateNativeBudgetPolicy } from "./native-budget.js"
import { type NativeQualityPolicy, validateNativeQualityPolicy } from "./native-quality.js"

export interface NativePersonaGoal {
  personaId: string
  goals: string[]
  successObservations: string[]
  allowedPaths: string[]
  weight: number
  ideationPrompt?: string
  investigationAgentId?: string
}

export interface NativeCommand {
  /** Stable verification rule ID; omitted IDs are derived from the command definition. */
  id?: string
  /** Verification rules are required for matching paths; omission means a global check. */
  paths?: string[]
  argv: string[]
  cwd: string
  timeoutSeconds: number
  idleTimeoutSeconds?: number
  outputLimitBytes?: number
}

export type NativeVerificationSandbox = {
  /** Exact committed regular files made available to the build. No directories or globs. */
  inputFiles: string[]
  /** Operator-reviewed source exceptions pinned to immutable Git blobs. */
  reviewedSourceFiles?: Array<{ path: string; blobSha: string; reviewedBy: string }>
} & ({ backend: "bubblewrap"; rootFilesystem: string } | { backend: "docker"; image: string })

export interface NativeAcceptanceBinding {
  criterion: string
  ruleIds: string[]
  manualEvidence?: { artifact: string; sha256: string; reviewedBy: string; headSha: string }
}

export type NativePromotionMode =
  | "observe"
  | "propose"
  | "implement-human-review"
  | "staging-canary"
  | "application-release"
export interface NativeAutonomyPolicy {
  version: 1
  budgets?: NativeBudgetPolicy | null
  mode?: NativePromotionMode
  promotion?: {
    approvedBy: string
    approvedAt: number
    policyDigest: string
    canaryArtifact: { path: string; sha256: string }
  }
  quality?: NativeQualityPolicy
  enabled: boolean
  boardId: string
  repository: string
  repositoryKind: "application" | "framework"
  baseBranch: string
  plannerAgentId: string
  coderAgentId: string
  reviewerAgentId: string
  workerConcurrency: number
  personasPerRound: number
  maxTasksPerRound: number
  dedupeWindowHours: number
  discoveryDailyRoundLimit: number
  personas: NativePersonaGoal[]
  requiredCi?: { checks: Array<{ name: string; appId: number }>; maxAgeSeconds: number }
  verificationAuthority?: {
    reviewedRevision: string
    approvedChanges?: Array<{ path: string; blobSha: string; reviewedBy: string }>
    acceptance: NativeAcceptanceBinding[]
  }
  verificationSandbox?: NativeVerificationSandbox
  verification: NativeCommand[]
  verificationExemptions?: NativeVerificationExemption[]
  deployment: {
    environment?: "staging" | "production"
    targetId?: string
    artifactSha256?: string
    previousKnownGood?: { revision: string; artifactSha256: string }
    observationSeconds?: number
    reconciliationSeconds?: number
    forwardOnly?: boolean
    compatibilityPlan?: { reviewedBy: string; artifact: string; sha256: string }
    authorized?: boolean
    environmentAllowlist?: string[]
    command: NativeCommand
    check: NativeCommand
    rollback?: NativeCommand
  } | null
}

function record(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected native autonomy object")
  return value as Record<string, any>
}
function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be non-empty`)
  return value.trim()
}
function integer(value: unknown, fallback: number, max: number): number {
  const n = value ?? fallback
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > max)
    throw new Error(`Expected integer between 1 and ${max}`)
  return n
}
function strings(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.length) throw new Error(`${name} must be a non-empty array`)
  return value.map((entry) => text(entry, name))
}
export function nativeRelativePath(value: string): string {
  const path = normalize(value).replaceAll("\\", "/")
  if (isAbsolute(value) || path === ".." || path.startsWith("../") || value.includes("\0")) {
    throw new Error(`Path must remain inside repository: ${value}`)
  }
  return path.replace(/\/$/, "")
}
export function nativePathAllowed(path: string, root: string): boolean {
  if (root === "." || path === root) return true
  const glob = /[*?[\]{}]/
  if (!glob.test(root)) return path.startsWith(`${root}/`)
  if (glob.test(path)) return false
  return matchesGlob(path, root)
}
function command(value: unknown): NativeCommand {
  const r = record(value)
  return {
    ...(r.id === undefined ? {} : { id: text(r.id, "rule id") }),
    argv: strings(r.argv, "command argv"),
    cwd: nativeRelativePath(text(r.cwd ?? ".", "command cwd")),
    timeoutSeconds: integer(r.timeoutSeconds, 900, 7200),
    ...(r.idleTimeoutSeconds === undefined ? {} : { idleTimeoutSeconds: integer(r.idleTimeoutSeconds, 60, 7200) }),
    ...(r.outputLimitBytes === undefined ? {} : { outputLimitBytes: integer(r.outputLimitBytes, 16777216, 67108864) }),
    ...(r.paths === undefined ? {} : { paths: strings(r.paths, "command paths").map(nativeRelativePath) })
  }
}
export function validateNativeAutonomyPolicy(value: unknown): NativeAutonomyPolicy {
  const r = record(value)
  if (r.version !== 1) throw new Error("Unsupported native autonomy policy version")
  if (typeof r.enabled !== "boolean") throw new Error("native autonomy enabled must be boolean")
  if (!["application", "framework"].includes(r.repositoryKind)) throw new Error("Invalid repositoryKind")
  const mode = r.mode ?? "observe"
  if (!["observe", "propose", "implement-human-review", "staging-canary", "application-release"].includes(mode))
    throw new Error("Unsupported native promotion mode")
  const repository = text(r.repository, "repository")
  if (!isAbsolute(repository)) throw new Error("repository must be absolute")
  const personas = (Array.isArray(r.personas) ? r.personas : []).map((value: unknown): NativePersonaGoal => {
    const p = record(value)
    return {
      personaId: text(p.personaId, "personaId"),
      goals: strings(p.goals, "goals"),
      successObservations: strings(p.successObservations, "successObservations"),
      allowedPaths: strings(p.allowedPaths, "allowedPaths").map(nativeRelativePath),
      ...(p.ideationPrompt ? { ideationPrompt: text(p.ideationPrompt, "ideationPrompt") } : {}),
      ...(p.investigationAgentId ? { investigationAgentId: text(p.investigationAgentId, "investigationAgentId") } : {}),
      weight: integer(p.weight, 1, 100)
    }
  })
  if (!personas.length || new Set(personas.map((p) => p.personaId)).size !== personas.length) {
    throw new Error("Native personas must be non-empty and unique")
  }
  const coderAgentId = text(r.coderAgentId, "coderAgentId")
  const reviewerAgentId = text(r.reviewerAgentId, "reviewerAgentId")
  if (coderAgentId === reviewerAgentId) throw new Error("Reviewer must be independent of coder")
  const verification = (Array.isArray(r.verification) ? r.verification : []).map(command)
  if (!verification.length) throw new Error("Native autonomy requires verification commands")
  const ids = verification.map(nativeVerificationRuleId)
  if (new Set(ids).size !== ids.length) throw new Error("Verification rule IDs must be unique")
  if (r.verificationExemptions !== undefined && !Array.isArray(r.verificationExemptions))
    throw new Error("verificationExemptions must be an array")
  const verificationExemptions = (r.verificationExemptions ?? []).map((value: unknown): NativeVerificationExemption => {
    const e = record(value)
    const paths = strings(e.paths, "exemption paths").map(nativeRelativePath)
    if (paths.some((path) => path === "." || /[*?[\]{}]/.test(path)))
      throw new Error("Verification exemptions require exact file paths, not directories or globs")
    return {
      id: text(e.id, "exemption id"),
      paths,
      reason: text(e.reason, "exemption reason"),
      reviewedBy: text(e.reviewedBy, "exemption reviewer")
    }
  })
  if (
    new Set(verificationExemptions.map((e: NativeVerificationExemption) => e.id)).size !== verificationExemptions.length
  )
    throw new Error("Verification exemption IDs must be unique")
  return {
    version: 1,
    mode,
    budgets: r.budgets == null ? null : validateNativeBudgetPolicy(r.budgets),
    ...(r.promotion === undefined
      ? {}
      : {
          promotion: {
            approvedBy: text(r.promotion.approvedBy, "promotion approver"),
            approvedAt: integer(r.promotion.approvedAt, 0, Number.MAX_SAFE_INTEGER),
            policyDigest: text(r.promotion.policyDigest, "promotion policy digest"),
            canaryArtifact: {
              path: text(r.promotion.canaryArtifact.path, "canary artifact"),
              sha256: text(r.promotion.canaryArtifact.sha256, "canary artifact digest")
            }
          }
        }),
    ...(r.quality === undefined ? {} : { quality: validateNativeQualityPolicy(r.quality) }),
    enabled: r.enabled,
    boardId: text(r.boardId, "boardId"),
    repository,
    repositoryKind: r.repositoryKind,
    baseBranch: text(r.baseBranch, "baseBranch"),
    plannerAgentId: text(r.plannerAgentId, "plannerAgentId"),
    coderAgentId,
    reviewerAgentId,
    workerConcurrency: integer(r.workerConcurrency, 1, 2),
    personasPerRound: integer(r.personasPerRound, 3, 10),
    maxTasksPerRound: integer(r.maxTasksPerRound, 6, 6),
    dedupeWindowHours: integer(r.dedupeWindowHours, 72, 720),
    discoveryDailyRoundLimit: integer(r.discoveryDailyRoundLimit, 12, 288),
    personas,
    verification,
    ...(r.requiredCi === undefined ? {} : { requiredCi: validateNativeRequiredCi(r.requiredCi) }),
    ...(r.verificationAuthority === undefined
      ? {}
      : {
          verificationAuthority: {
            reviewedRevision: text(r.verificationAuthority.reviewedRevision, "reviewed policy revision"),
            approvedChanges: (r.verificationAuthority.approvedChanges ?? []).map((a: any) => ({
              path: nativeRelativePath(text(a.path, "approved authority path")),
              blobSha: text(a.blobSha, "approved authority blob"),
              reviewedBy: text(a.reviewedBy, "authority reviewer")
            })),
            acceptance: (Array.isArray(r.verificationAuthority.acceptance)
              ? r.verificationAuthority.acceptance
              : []
            ).map((a: any) => ({
              criterion: text(a.criterion, "acceptance criterion"),
              ruleIds:
                a.manualEvidence && Array.isArray(a.ruleIds) && !a.ruleIds.length
                  ? []
                  : strings(a.ruleIds, "acceptance rule IDs"),
              ...(a.manualEvidence
                ? {
                    manualEvidence: {
                      artifact: text(a.manualEvidence.artifact, "manual evidence artifact"),
                      sha256: text(a.manualEvidence.sha256, "manual evidence digest"),
                      reviewedBy: text(a.manualEvidence.reviewedBy, "manual evidence reviewer"),
                      headSha: text(a.manualEvidence.headSha, "manual evidence revision")
                    }
                  }
                : {})
            }))
          }
        }),
    ...(r.verificationSandbox === undefined
      ? {}
      : { verificationSandbox: validateNativeVerificationSandbox(r.verificationSandbox) }),
    verificationExemptions,
    deployment: r.deployment
      ? {
          ...(r.deployment.environment === undefined
            ? {}
            : {
                environment: (() => {
                  if (!["staging", "production"].includes(r.deployment.environment))
                    throw new Error("Unsupported deployment environment")
                  return r.deployment.environment
                })()
              }),
          ...(r.deployment.targetId === undefined
            ? {}
            : { targetId: text(r.deployment.targetId, "deployment target") }),
          ...(r.deployment.artifactSha256 === undefined
            ? {}
            : { artifactSha256: text(r.deployment.artifactSha256, "deployment artifact digest") }),
          ...(r.deployment.previousKnownGood === undefined
            ? {}
            : {
                previousKnownGood: {
                  revision: text(r.deployment.previousKnownGood.revision, "known-good revision"),
                  artifactSha256: text(r.deployment.previousKnownGood.artifactSha256, "known-good artifact digest")
                }
              }),
          observationSeconds: integer(r.deployment.observationSeconds, 60, 86400),
          reconciliationSeconds: integer(r.deployment.reconciliationSeconds, 600, 604800),
          forwardOnly: r.deployment.forwardOnly === true,
          ...(r.deployment.compatibilityPlan === undefined
            ? {}
            : {
                compatibilityPlan: {
                  reviewedBy: text(r.deployment.compatibilityPlan.reviewedBy, "compatibility reviewer"),
                  artifact: text(r.deployment.compatibilityPlan.artifact, "compatibility artifact"),
                  sha256: text(r.deployment.compatibilityPlan.sha256, "compatibility digest")
                }
              }),
          authorized: r.deployment.authorized === true,
          environmentAllowlist: validateEnvironmentNames(r.deployment.environmentAllowlist ?? []),
          command: command(r.deployment.command),
          check: command(r.deployment.check),
          ...(r.deployment.rollback ? { rollback: command(r.deployment.rollback) } : {})
        }
      : null
  }
}

export function validateNativeRequiredCi(value: unknown): NonNullable<NativeAutonomyPolicy["requiredCi"]> {
  const r = record(value)
  if (!Array.isArray(r.checks) || !r.checks.length) throw new Error("Required CI checks must be non-empty")
  const checks = r.checks.map((entry: unknown) => {
    const c = record(entry)
    return { name: text(c.name, "CI check name"), appId: integer(c.appId, 0, Number.MAX_SAFE_INTEGER) }
  })
  if (new Set(checks.map((c) => `${c.appId}:${c.name}`)).size !== checks.length)
    throw new Error("Duplicate required CI check")
  return { checks, maxAgeSeconds: integer(r.maxAgeSeconds, 86400, 604800) }
}

export interface NativeProposal {
  personaId: string
  goal: string
  title: string
  evidence: Array<{ path: string; observation: string }>
  allowedPaths: string[]
  acceptance: string[]
  alternatives: string[]
  implementationPrompt: string
  quality?: import("./native-quality.js").NativeProposalQuality
}
export function validateNativeProposal(value: unknown, policy: NativeAutonomyPolicy): NativeProposal {
  const r = record(value)
  const persona = policy.personas.find((p) => p.personaId === r.personaId)
  if (!persona?.goals.includes(r.goal)) throw new Error("Proposal must name a configured persona goal")
  const allowedPaths = strings(r.allowedPaths, "allowedPaths").map(nativeRelativePath)
  if (allowedPaths.some((p) => !persona.allowedPaths.some((root) => nativePathAllowed(p, root)))) {
    throw new Error("Proposal exceeds persona path authority")
  }
  if (!Array.isArray(r.evidence) || !r.evidence.length) throw new Error("Proposal needs repository evidence")
  return {
    personaId: persona.personaId,
    goal: r.goal,
    title: text(r.title, "title"),
    evidence: r.evidence.map((e: unknown) => {
      const item = record(e)
      return {
        path: nativeRelativePath(text(item.path, "evidence path")),
        observation: text(item.observation, "observation")
      }
    }),
    allowedPaths,
    acceptance: strings(r.acceptance, "acceptance"),
    alternatives: strings(r.alternatives, "alternatives"),
    implementationPrompt: text(r.implementationPrompt, "implementationPrompt")
  }
}
export function nativeProposalKey(proposal: NativeProposal): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        goal: proposal.goal.toLowerCase().trim(),
        title: proposal.title.toLowerCase().replace(/\W+/g, " ").trim(),
        paths: [...proposal.allowedPaths].sort()
      })
    )
    .digest("hex")
}
export function selectNativePersonas(
  policy: NativeAutonomyPolicy,
  counts: Record<string, number>
): NativePersonaGoal[] {
  return [...policy.personas]
    .sort(
      (a, b) =>
        (counts[a.personaId] ?? 0) / a.weight - (counts[b.personaId] ?? 0) / b.weight ||
        a.personaId.localeCompare(b.personaId)
    )
    .slice(0, policy.personasPerRound)
}

/** Reviewed policy exceptions match exact files only, never directories or globs. */
export interface NativeVerificationExemption {
  id: string
  paths: string[]
  reason: string
  reviewedBy: string
}
export interface NativeVerificationCoveragePlan {
  policyDigest: string
  ruleIds: string[]
  exemptions: NativeVerificationExemption[]
  coverage: Array<{ path: string; ruleIds: string[]; exemptionIds: string[] }>
  uncoveredPaths: string[]
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)])
    )
  return value
}
export function nativePolicyDigest(policy: NativeAutonomyPolicy): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(policy)))
    .digest("hex")
}
export function nativeVerificationRuleId(command: NativeCommand): string {
  return (
    command.id ??
    `sha256:${createHash("sha256")
      .update(JSON.stringify(canonical(command)))
      .digest("hex")}`
  )
}

export interface NativeVerificationContext {
  workflowId: string
  attemptId: string
  skillDigest: string
  executionId: string
  agentId: string
  sessionKey: string
}
export interface NativeReceiptProvenance extends NativeVerificationContext {
  version: 1
  repositoryId: string
  baseSha: string
  headSha: string
  diffDigest: string
  policyDigest: string
  policySnapshot: NativeAutonomyPolicy
  checkIds: string[]
  toolchain: { node: string; git: string; platform: string; arch: string; sandbox: string }
  artifacts: Array<{ ruleId: string; path: string; sha256: string }>
}
export interface NativeVerificationEvidence {
  headSha: string
  baseSha: string
  provenance?: NativeReceiptProvenance
  provenanceArtifact?: { path: string; sha256: string }
  plan: NativeVerificationCoveragePlan
  acceptance?: NativeAcceptanceBinding[]
  checks: Array<{
    ruleId: string
    argv: string[]
    cwd: string
    exitCode: number | null
    startedAt: string
    finishedAt: string
    artifact: string
    artifactSha256?: string
  }>
}
export interface NativeReviewEvidence {
  receiptVersion?: 1
  attemptId?: string
  verificationDigest?: string
  headSha: string
  agentId: string
  sessionKey: string
  verdict: "approved" | "changes_requested"
  rationale: string
  assessment?: import("./native-quality.js").NativeAssessment
}
export function assertNativeReleaseGate(input: {
  headSha: string
  authorAgentId: string
  reviewerAgentId: string
  verification: NativeVerificationEvidence | null
  review: NativeReviewEvidence | null
}): void {
  const { verification, review } = input
  if (!/^[a-f0-9]{40,64}$/.test(input.headSha)) throw new Error("Invalid commit SHA")
  if (
    !verification ||
    verification.headSha !== input.headSha ||
    !verification.plan ||
    !verification.plan.policyDigest ||
    !verification.plan.coverage.length ||
    verification.plan.uncoveredPaths.length > 0 ||
    verification.plan.coverage.some(
      (entry) =>
        !entry.ruleIds.length &&
        !entry.exemptionIds.some((id) =>
          verification.plan.exemptions.some(
            (e) => e.id === id && e.paths.includes(entry.path) && e.reviewedBy.trim() && e.reason.trim()
          )
        )
    ) ||
    [...verification.plan.ruleIds, ...verification.plan.coverage.flatMap((entry) => entry.ruleIds)].some(
      (id) => !verification.checks.some((check) => check.ruleId === id && check.exitCode === 0)
    ) ||
    verification.checks.some((c) => c.exitCode !== 0 || !c.artifact || !c.startedAt || !c.finishedAt)
  ) {
    throw new Error("Release requires passing verification for the current commit")
  }
  if (
    !review ||
    review.headSha !== input.headSha ||
    review.verdict !== "approved" ||
    !review.sessionKey ||
    !review.rationale.trim() ||
    review.agentId !== input.reviewerAgentId ||
    review.agentId === input.authorAgentId
  ) {
    throw new Error("Release requires independent review of the current commit")
  }
}

export function validateEnvironmentNames(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((name) => typeof name !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(name)))
    throw new Error("Invalid environment allowlist")
  return value
}

export function validateNativeVerificationSandbox(value: unknown): NativeVerificationSandbox {
  const r = record(value)
  if (r.backend !== "bubblewrap" && r.backend !== "docker") throw new Error("Unsupported verification sandbox")
  const image = r.backend === "docker" ? text(r.image, "sandbox image") : ""
  if (r.backend === "docker" && !/^sha256:[a-f0-9]{64}$/.test(image))
    throw new Error("Docker verification requires an immutable local image ID")
  const rootFilesystem = r.backend === "bubblewrap" ? text(r.rootFilesystem, "sandbox rootFilesystem") : ""
  if (r.backend === "bubblewrap" && (!isAbsolute(rootFilesystem) || normalize(rootFilesystem) === "/"))
    throw new Error("Sandbox needs a dedicated root filesystem")
  const inputFiles = strings(r.inputFiles, "sandbox inputFiles").map(nativeRelativePath)
  const reviewedSourceFiles: NonNullable<NativeVerificationSandbox["reviewedSourceFiles"]> = []
  if (r.reviewedSourceFiles !== undefined) {
    if (!Array.isArray(r.reviewedSourceFiles)) throw new Error("Invalid reviewed sandbox source files")
    for (const value of r.reviewedSourceFiles) {
      const entry = record(value)
      const path = nativeRelativePath(text(entry.path, "reviewed source path"))
      const blobSha = text(entry.blobSha, "reviewed source blob")
      const reviewedBy = text(entry.reviewedBy, "reviewed source reviewer")
      if (
        !inputFiles.includes(path) ||
        reviewedSourceFiles.some((entry) => entry.path === path) ||
        !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(blobSha) ||
        !/\.(?:py|ts|tsx|js|jsx|mjs|cjs|go|rs|java|c|h|cpp|hpp)$/.test(path) ||
        path.split("/").some((part) => part.startsWith(".") || /[*?[\]{}]/.test(part))
      )
        throw new Error("Reviewed sandbox exceptions require an explicit source path and exact Git blob")
      reviewedSourceFiles.push({ path, blobSha, reviewedBy })
    }
  }
  if (
    inputFiles.some(
      (p) =>
        p === "." ||
        /[*?[\]{}]/.test(p) ||
        p.split("/").some((part) => /^(\.git|\.openclaw|\.codex|\.ssh|\.aws|\.env(?:\..*)?|.*\.pem)$/i.test(part)) ||
        (p.split("/").some((part) => /(?:policy|policies|credentials|secrets)/i.test(part)) &&
          !reviewedSourceFiles.some((entry) => entry.path === p))
    )
  )
    throw new Error("Sandbox inputs must be explicit source files, excluding credentials and policy files")
  const reviewed = reviewedSourceFiles.length ? { reviewedSourceFiles } : {}
  return r.backend === "docker"
    ? { backend: "docker", image, inputFiles, ...reviewed }
    : { backend: "bubblewrap", rootFilesystem, inputFiles, ...reviewed }
}
