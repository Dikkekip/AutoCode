/** Native evidence lifecycle. Workboard remains the execution owner. */
export type NativeWorkflowState =
  | "design_wait"
  | "implementation"
  | "verification"
  | "review"
  | "release"
  | "deployment"
  | "blocked"
  | "cancelled"
  | "completed"
export interface NativeLifecycle {
  version: 1
  state: NativeWorkflowState
  attemptId: string
  attempt: number
  headSha?: string
}
export interface NativeLifecycleEvidence {
  recovery?: { action: string; planDigest: string; operator: string; fromAttemptId: string }
  repairCount?: number
  candidate?: { headSha: string }
  verification?: { headSha: string; provenance?: { attemptId: string }; checks: Array<{ exitCode: number | null }> }
  review?: { headSha: string; verdict: string; attemptId?: string }
  mergedSha?: string
  deployedSha?: string
  blocker?: string
  designCardId?: string
  designReview?: { verdict: string }
}
const allowed: Record<NativeWorkflowState, readonly NativeWorkflowState[]> = {
  design_wait: ["implementation", "verification", "review", "release", "blocked", "cancelled"],
  implementation: ["design_wait", "verification", "blocked", "cancelled"],
  verification: ["review", "implementation", "design_wait", "blocked", "cancelled"],
  review: ["release", "implementation", "design_wait", "blocked", "cancelled"],
  release: ["deployment", "design_wait", "blocked"],
  deployment: ["completed", "blocked"],
  blocked: [],
  cancelled: [],
  completed: []
}
export function validateNativeLifecycle(lifecycle: NativeLifecycle, evidence: NativeLifecycleEvidence): void {
  if (
    lifecycle.version !== 1 ||
    !Object.hasOwn(allowed, lifecycle.state) ||
    !lifecycle.attemptId ||
    !Number.isSafeInteger(lifecycle.attempt) ||
    lifecycle.attempt < 0
  )
    throw new Error("Invalid native lifecycle")
  if (lifecycle.headSha && lifecycle.headSha !== evidence.candidate?.headSha)
    throw new Error("Candidate changed within immutable native attempt")
  if (evidence.verification && evidence.verification.headSha !== evidence.candidate?.headSha)
    throw new Error("Verification belongs to another attempt")
  if (evidence.verification?.provenance && evidence.verification.provenance.attemptId !== lifecycle.attemptId)
    throw new Error("Verification belongs to another attempt")
  if (evidence.review?.attemptId && evidence.review.attemptId !== lifecycle.attemptId)
    throw new Error("Review belongs to another attempt")
  if (evidence.review && evidence.review.headSha !== evidence.verification?.headSha)
    throw new Error("Review belongs to another attempt")
  if (["verification", "review", "release", "deployment", "completed"].includes(lifecycle.state) && !evidence.candidate)
    throw new Error("Lifecycle requires committed candidate")
  if (
    ["review", "release", "deployment", "completed"].includes(lifecycle.state) &&
    (!evidence.verification?.checks.length || evidence.verification.checks.some((c) => c.exitCode !== 0))
  )
    throw new Error("Lifecycle requires successful verification")
  if (["release", "deployment", "completed"].includes(lifecycle.state) && evidence.review?.verdict !== "approved")
    throw new Error("Lifecycle requires independent approval")
  if (["deployment", "completed"].includes(lifecycle.state) && !evidence.mergedSha)
    throw new Error("Lifecycle requires confirmed merge")
  if (lifecycle.state === "completed" && (!evidence.deployedSha || evidence.deployedSha !== evidence.mergedSha))
    throw new Error("Lifecycle requires exact deployed revision")
  if (lifecycle.state === "blocked" && !evidence.blocker) throw new Error("Blocked lifecycle requires reason")
}
/** Deterministic compatibility reader; used once for records predating the lifecycle schema. */
export function upgradeNativeLifecycle(id: string, evidence: NativeLifecycleEvidence): NativeLifecycle {
  const state: NativeWorkflowState = evidence.blocker
    ? "blocked"
    : evidence.deployedSha
      ? "completed"
      : evidence.mergedSha
        ? "deployment"
        : evidence.review?.verdict === "approved"
          ? "release"
          : evidence.verification?.checks.length && evidence.verification.checks.every((c) => c.exitCode === 0)
            ? "review"
            : evidence.candidate
              ? "verification"
              : evidence.designCardId && evidence.designReview?.verdict !== "approved"
                ? "design_wait"
                : "implementation"
  const attempt = evidence.repairCount ?? 0
  const lifecycle: NativeLifecycle = {
    version: 1,
    state,
    attempt,
    attemptId: `${id}:attempt:${attempt}`,
    ...(evidence.candidate ? { headSha: evidence.candidate.headSha } : {})
  }
  validateNativeLifecycle(lifecycle, evidence)
  return lifecycle
}
export function transitionNativeLifecycle(
  previous: NativeLifecycle,
  state: NativeWorkflowState,
  evidence: NativeLifecycleEvidence
): NativeLifecycle {
  if (state !== previous.state && !allowed[previous.state].includes(state))
    throw new Error(`Illegal native transition ${previous.state} -> ${state}`)
  const next = { ...previous, state, ...(evidence.candidate ? { headSha: evidence.candidate.headSha } : {}) }
  // Compare against the previous bound SHA before accepting new evidence.
  if (previous.headSha && evidence.candidate?.headSha !== previous.headSha)
    throw new Error("Candidate changed within immutable native attempt")
  validateNativeLifecycle(next, evidence)
  return next
}
export function nextNativeAttempt(previous: NativeLifecycle, evidence: NativeLifecycleEvidence): NativeLifecycle {
  if (!["verification", "review", "implementation", "design_wait"].includes(previous.state))
    throw new Error("Current lifecycle cannot start repair")
  if (evidence.candidate || evidence.verification || evidence.review)
    throw new Error("New attempt cannot inherit candidate authority")
  const attempt = previous.attempt + 1
  return {
    version: 1,
    state: "implementation",
    attempt,
    attemptId: previous.attemptId.replace(/:attempt:\d+$/, `:attempt:${attempt}`)
  }
}

/** Exceptional operator transition; caller must atomically journal the approved plan. */
export function recoverNativeLifecycle(previous: NativeLifecycle, evidence: NativeLifecycleEvidence): NativeLifecycle {
  const recovery = evidence.recovery
  if (
    !recovery ||
    !/^[a-f0-9]{64}$/.test(recovery.planDigest) ||
    !recovery.operator.trim() ||
    recovery.fromAttemptId !== previous.attemptId
  )
    throw new Error("Recovery requires an attributed exact-attempt plan")
  if (["completed", "cancelled"].includes(previous.state)) throw new Error("Terminal workflows cannot be recovered")
  if (recovery.action === "retry") {
    if (
      previous.state !== "blocked" ||
      evidence.candidate ||
      evidence.verification ||
      evidence.review ||
      evidence.mergedSha ||
      evidence.deployedSha
    )
      throw new Error("Retry requires a blocked attempt without inherited release authority")
    const attempt = previous.attempt + 1
    return {
      version: 1,
      state: "implementation",
      attempt,
      attemptId: previous.attemptId.replace(/:attempt:\d+$/, `:attempt:${attempt}`)
    }
  }
  if (!["cancel", "supersede", "abandon"].includes(recovery.action) || evidence.mergedSha || evidence.deployedSha)
    throw new Error("Unsupported terminal recovery")
  const next = { ...previous, state: "cancelled" as const }
  validateNativeLifecycle(next, evidence)
  return next
}
