// Mode authorization is policy, never a prompt convention or a task-count threshold.
import { readFileSync } from "node:fs"
import { isAbsolute } from "node:path"
import {
  type NativeAutonomyPolicy,
  type NativePromotionMode,
  nativeCoderAgentIds,
  nativePolicyDigest
} from "@openclaw/domain"
import { validateNativeCanaryReport } from "./canary-evidence.js"
import { nativeContentDigest } from "./provenance.js"
export type NativeModeAction =
  | "inspect"
  | "investigate"
  | "propose"
  | "implement"
  | "verify"
  | "review"
  | "release"
  | "deploy"
  | "rollback"
const rank: Record<NativePromotionMode, number> = {
  observe: 0,
  propose: 1,
  "implement-human-review": 2,
  "staging-canary": 3,
  "application-release": 4
}
const required: Record<NativeModeAction, number> = {
  inspect: 0,
  investigate: 1,
  propose: 1,
  implement: 2,
  verify: 2,
  review: 2,
  release: 3,
  deploy: 3,
  rollback: 3
}
export function nativeModeAllows(policy: NativeAutonomyPolicy, action: NativeModeAction): boolean {
  return rank[policy.mode ?? "observe"] >= required[action]
}
export function assertNativeMode(policy: NativeAutonomyPolicy, action: NativeModeAction): void {
  if (!nativeModeAllows(policy, action))
    throw new Error(`Native mode ${policy.mode ?? "observe"} does not authorize ${action}`)
}
export function nativePromotionDigest(policy: NativeAutonomyPolicy): string {
  const copy = { ...policy }
  delete copy.promotion
  return nativePolicyDigest(copy)
}
export function nativeCanaryScopeDigest(policy: NativeAutonomyPolicy): string {
  return nativeContentDigest(
    JSON.stringify({
      repository: policy.repository,
      boardId: policy.boardId,
      personas: policy.personas,
      verification: policy.verification,
      exemptions: policy.verificationExemptions,
      authority: policy.verificationAuthority,
      requiredCi: policy.requiredCi,
      artifactSha256: policy.deployment?.artifactSha256
    })
  )
}
export function assertNativePromotion(policy: NativeAutonomyPolicy): void {
  assertNativeMode(policy, "release")
  if (!policy.budgets) throw new Error("Release modes require a reviewed workflow budget policy")
  const approval = policy.promotion
  if (
    !approval ||
    [
      ...nativeCoderAgentIds(policy),
      policy.reviewerAgentId,
      policy.plannerAgentId,
      ...policy.personas.map((p) => p.investigationAgentId)
    ].includes(approval.approvedBy) ||
    approval.policyDigest !== nativePromotionDigest(policy) ||
    !isAbsolute(approval.canaryArtifact.path) ||
    approval.approvedAt > Date.now()
  )
    throw new Error("Release mode requires current independent operator promotion approval")
  const raw = readFileSync(approval.canaryArtifact.path)
  if (nativeContentDigest(raw) !== approval.canaryArtifact.sha256) throw new Error("Canary evidence artifact changed")
  const report = validateNativeCanaryReport(JSON.parse(raw.toString()))
  if (
    !report.passed ||
    report.scopeDigest !== nativeCanaryScopeDigest(policy) ||
    report.recordedAt > approval.approvedAt
  )
    throw new Error("Promotion lacks successful scoped canary evidence")
  if (policy.mode === "staging-canary" && policy.deployment?.environment !== "staging")
    throw new Error("Canary mode only authorizes a staging target")
  if (
    policy.mode === "application-release" &&
    (policy.deployment?.environment !== "production" ||
      report.evidenceKind !== "live" ||
      report.environment !== "staging" ||
      report.observations.windowSeconds < 1)
  )
    throw new Error("Application release requires live staging evidence and an explicit production target")
}
