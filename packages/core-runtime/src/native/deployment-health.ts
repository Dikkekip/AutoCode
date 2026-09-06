// Structured deployment health contracts; host time controls observation windows and deadlines.
import { readFileSync } from "node:fs"
import { isAbsolute } from "node:path"
import type { NativeAutonomyPolicy } from "@openclaw/domain"
import { redactLogText } from "@openclaw/domain"
import { nativeContentDigest } from "./provenance.js"

export interface NativeHealthReceipt {
  benefitObservation?: unknown
  targetId: string
  deployedSha: string
  artifactSha256: string
  healthy: boolean
  workflowPassed: boolean
  observedAt: number
  rolloutState: "settled" | "in_progress"
}
export function assertNativeDeploymentPolicy(policy: NativeAutonomyPolicy) {
  const p = policy.deployment
  if (
    !p?.targetId ||
    !/^[a-f0-9]{64}$/.test(p.artifactSha256 ?? "") ||
    !/^[a-f0-9]{40,64}$/.test(p.previousKnownGood?.revision ?? "") ||
    !/^[a-f0-9]{64}$/.test(p.previousKnownGood?.artifactSha256 ?? "") ||
    !p.observationSeconds ||
    !p.reconciliationSeconds ||
    p.reconciliationSeconds < p.observationSeconds
  )
    throw new Error("Deployment requires target, artifact, known-good identity and bounded health observation policy")
  if (p.forwardOnly) {
    const plan = p.compatibilityPlan
    if (
      p.rollback ||
      !plan ||
      plan.reviewedBy === policy.coderAgentId ||
      !isAbsolute(plan.artifact) ||
      nativeContentDigest(readFileSync(plan.artifact)) !== plan.sha256
    )
      throw new Error("Forward-only changes require independent compatibility evidence and prohibit generic rollback")
  }
  return p as typeof p & {
    targetId: string
    artifactSha256: string
    previousKnownGood: { revision: string; artifactSha256: string }
    observationSeconds: number
    reconciliationSeconds: number
  }
}
export function decodeNativeHealth(
  raw: string,
  expected: { targetId: string; revision: string; artifactSha256: string },
  now: number
): NativeHealthReceipt | null {
  try {
    const r = JSON.parse(raw)
    if (
      r.targetId !== expected.targetId ||
      r.deployedSha !== expected.revision ||
      r.artifactSha256 !== expected.artifactSha256 ||
      !["settled", "in_progress"].includes(r.rolloutState) ||
      typeof r.healthy !== "boolean" ||
      typeof r.workflowPassed !== "boolean" ||
      !Number.isFinite(r.observedAt) ||
      r.observedAt > now ||
      now - r.observedAt > 60_000
    )
      return null
    return {
      targetId: r.targetId,
      deployedSha: r.deployedSha,
      artifactSha256: r.artifactSha256,
      healthy: r.healthy,
      workflowPassed: r.workflowPassed,
      observedAt: r.observedAt,
      rolloutState: r.rolloutState,
      ...(r.benefitObservation
        ? {
            benefitObservation: {
              metric: r.benefitObservation.metric,
              unit: r.benefitObservation.unit,
              value: r.benefitObservation.value,
              evidence:
                typeof r.benefitObservation.evidence === "string" ? redactLogText(r.benefitObservation.evidence) : ""
            }
          }
        : {})
    }
  } catch {
    return null
  }
}
