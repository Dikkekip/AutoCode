// Versioned parent-owned receipt envelopes. No signature is claimed without a protected signing service.
import { createHash } from "node:crypto"
import { readFileSync, realpathSync } from "node:fs"
import type { NativeAutonomyPolicy, NativeReceiptProvenance, NativeVerificationEvidence } from "@openclaw/domain"
import { nativePolicyDigest } from "@openclaw/domain"

export function nativeContentDigest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}
export function nativeRepositoryIdentity(policy: NativeAutonomyPolicy): string {
  return nativeContentDigest(realpathSync(policy.repository))
}
export function nativeVerificationDigest(evidence: NativeVerificationEvidence): string {
  return nativeContentDigest(JSON.stringify(evidence.provenance))
}
export function assertNativeProvenance(
  policy: NativeAutonomyPolicy,
  evidence: NativeVerificationEvidence,
  expected: { workflowId: string; attemptId: string; skillDigest: string }
): NativeReceiptProvenance {
  const p = evidence.provenance
  if (!p || p.version !== 1 || !evidence.provenanceArtifact)
    throw new Error("Legacy verification receipt is unverified; regenerate evidence")
  if (
    p.workflowId !== expected.workflowId ||
    p.attemptId !== expected.attemptId ||
    p.skillDigest !== expected.skillDigest ||
    p.repositoryId !== nativeRepositoryIdentity(policy) ||
    p.headSha !== evidence.headSha ||
    p.baseSha !== evidence.baseSha
  )
    throw new Error("Verification provenance belongs to another repository, revision or attempt")
  if (
    !p.executionId ||
    !p.agentId ||
    !p.sessionKey ||
    !/^[a-f0-9]{64}$/.test(p.diffDigest) ||
    !p.toolchain.node ||
    !p.toolchain.git ||
    !p.toolchain.sandbox
  )
    throw new Error("Verification execution provenance incomplete")
  if (
    nativePolicyDigest(p.policySnapshot) !== p.policyDigest ||
    p.policyDigest !== nativePolicyDigest(policy) ||
    p.policyDigest !== evidence.plan.policyDigest
  )
    throw new Error("Verification policy snapshot changed or became stale")
  if (
    JSON.stringify(p.checkIds) !== JSON.stringify(evidence.plan.ruleIds) ||
    JSON.stringify(p.artifacts) !==
      JSON.stringify(
        evidence.checks.map((check) => ({ ruleId: check.ruleId, path: check.artifact, sha256: check.artifactSha256 }))
      )
  )
    throw new Error("Verification check and artifact provenance mismatch")
  const raw = readFileSync(evidence.provenanceArtifact.path)
  if (
    nativeContentDigest(raw) !== evidence.provenanceArtifact.sha256 ||
    JSON.stringify(JSON.parse(raw.toString())) !== JSON.stringify(p)
  )
    throw new Error("Protected provenance artifact was replaced")
  return p
}

/** Public metadata intentionally omits policy commands, execution sessions and raw artifact contents. */
export function nativeProvenanceSummary(evidence: NativeVerificationEvidence) {
  const p = evidence.provenance
  return p
    ? {
        version: p.version,
        headSha: p.headSha,
        baseSha: p.baseSha,
        attemptId: p.attemptId,
        policyDigest: p.policyDigest,
        skillDigest: p.skillDigest,
        checkIds: p.checkIds,
        receiptDigest: nativeVerificationDigest(evidence),
        artifactHashes: p.artifacts.map((a) => a.sha256)
      }
    : { version: 0, status: "legacy-unverified" }
}
