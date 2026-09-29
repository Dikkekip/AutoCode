import { createHash } from "node:crypto"
import { redactLogText } from "@openclaw/domain"
import type { NativeWorkflow } from "./runtime.js"

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
export interface NativeRepairObservation {
  version: 1
  attemptId: string
  headSha: string
  baseSha: string
  failureDigest: string
  evidenceDigest: string
  failedChecks: string[]
  unsatisfiedCriteria: string[]
  reason: string
}

/** Describe evidence, not an inferred root cause or a model's claimed progress. */
export function nativeRepairObservation(workflow: NativeWorkflow, reason: string): NativeRepairObservation {
  if (!workflow.candidate) throw new Error("Repair requires a preserved candidate")
  const checks = (workflow.verification?.checks ?? [])
    .filter((check) => check.exitCode !== 0)
    .map((check) => ({ ruleId: check.ruleId, argv: check.argv, cwd: check.cwd, exitCode: check.exitCode }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  const criteria = (workflow.review?.assessment?.criteria ?? [])
    .filter((criterion) => !criterion.satisfied)
    .map((criterion) => criterion.criterion)
    .sort()
  const failureDigest = digest({
    checks,
    criteria,
    review: workflow.review?.verdict,
    // Free-form failure text is used only when structured evidence is absent.
    reason: !checks.length && !criteria.length ? reason.trim() : undefined
  })
  return {
    version: 1,
    attemptId: workflow.lifecycle?.attemptId ?? "legacy",
    headSha: workflow.candidate.headSha,
    baseSha: workflow.candidate.baseSha,
    failureDigest,
    evidenceDigest: digest({
      failureDigest,
      policy: workflow.verification?.provenance?.policyDigest,
      artifacts: (workflow.verification?.checks ?? [])
        .filter((check) => check.exitCode !== 0)
        .map((check) => [check.ruleId, check.artifactSha256 ?? null])
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      assessment: workflow.review?.assessment,
      reason: reason.trim()
    }),
    failedChecks: [...new Set(checks.map((check) => check.ruleId))].slice(0, 32),
    unsatisfiedCriteria: criteria.slice(0, 32).map((criterion) => redactLogText(criterion).slice(0, 1000)),
    reason: redactLogText(reason).slice(0, 2000)
  }
}

export function planNativeRepair(
  current: NativeRepairObservation,
  history: NativeRepairObservation[],
  repairsUsed: number
) {
  if (!Number.isSafeInteger(repairsUsed) || repairsUsed < 0) throw new Error("Invalid repair attempt count")
  const recent = history.slice(-2)
  const unchanged = recent.some(
    (previous) =>
      previous.headSha === current.headSha &&
      previous.baseSha === current.baseSha &&
      previous.evidenceDigest === current.evidenceDigest
  )
  const repeatedFailure = recent.some((previous) => previous.failureDigest === current.failureDigest)
  const outcome = repairsUsed >= 2 ? "exhausted" : unchanged ? "stalled" : "repair"
  return {
    version: 1 as const,
    outcome,
    attempt: repairsUsed + 1,
    remainingAttempts: Math.max(0, 2 - repairsUsed),
    repeatedFailure,
    current,
    history: recent,
    nextAction:
      outcome === "exhausted"
        ? "Repair budget exhausted. Preserve evidence for scoped workflow recovery."
        : outcome === "stalled"
          ? "Candidate and failure evidence repeat a previous attempt. Preserve the work and diagnose the blocker before scoped workflow recovery."
          : repeatedFailure
            ? "The same checks or criteria still fail after a changed candidate or new evidence. Compare previous attempts, test a different causal hypothesis, and correct only the remaining failure."
            : "Use the failed checks and unsatisfied criteria to reproduce the failure, then make a scoped correction and report its proof.",
    limitations: ["Changed revisions or artifacts are evidence deltas, not proof of an improved implementation"]
  }
}
