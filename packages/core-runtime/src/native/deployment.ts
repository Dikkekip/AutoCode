// Journaled target ownership, observed deployment health and independently confirmed rollback.
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { assessNativeBenefit } from "@openclaw/domain"
import { assertNativeDeploymentPolicy, decodeNativeHealth } from "./deployment-health.js"
import { nativeContentDigest, nativeVerificationDigest } from "./provenance.js"
import type { NativeReleaseIO } from "./release.js"
import { NativeReleasePending } from "./release.js"
import type { NativeAutonomyRuntime, NativeWorkflow } from "./runtime.js"

interface DeploymentOperation {
  receiptVersion: 1
  evidenceArtifacts?: Array<{ path: string; sha256: string }>
  verificationDigest: string
  state: string
  startedAt: number
  healthySince?: number
  lastObservedAt?: number
  attemptId: string
  targetId: string
  revision: string
  artifactSha256: string
}
export async function reconcileNativeDeployment(
  runtime: NativeAutonomyRuntime,
  id: string,
  w: NativeWorkflow,
  io: NativeReleaseIO
): Promise<void> {
  const { store, policy } = runtime,
    p = assertNativeDeploymentPolicy(policy),
    now = io.now ?? Date.now
  const attemptId = w.lifecycle!.attemptId,
    targetKey = nativeContentDigest(p.targetId),
    key = `${id}:deploy`,
    rollbackKey = `${id}:rollback`
  const target = store.get<{
    workflowId: string
    attemptId: string
    state: string
    revision?: string
    artifactSha256?: string
  }>("deployment-target", targetKey)
  if (target && target.state !== "healthy" && (target.workflowId !== id || target.attemptId !== attemptId))
    throw new NativeReleasePending("Deployment target is owned by another unresolved workflow")
  if (
    target?.state === "healthy" &&
    target.workflowId !== id &&
    (target.revision !== p.previousKnownGood.revision || target.artifactSha256 !== p.previousKnownGood.artifactSha256)
  )
    throw new Error("Known-good policy is stale for deployment target")
  const artifacts = resolve(
    policy.repository,
    ".openclaw/native-artifacts",
    id,
    attemptId.replaceAll(/[^a-zA-Z0-9_-]/g, "_"),
    "deployment"
  )
  const env = (revision: string, artifactSha256: string) => ({
    AUTOCODE_SHA: revision,
    AUTOCODE_ARTIFACT_SHA256: artifactSha256,
    AUTOCODE_TARGET_ID: p.targetId,
    AUTOCODE_WORKFLOW_ID: id,
    AUTOCODE_ATTEMPT_ID: attemptId,
    AUTOCODE_REPOSITORY: policy.repository
  })
  const observe = async (revision: string, artifactSha256: string, kind: string) => {
    const result = await io.command(
      p.check,
      policy.repository,
      resolve(artifacts, `${kind}-check.json`),
      env(revision, artifactSha256)
    )
    const receipt =
      result.exitCode === 0
        ? decodeNativeHealth(result.stdout, { targetId: p.targetId, revision, artifactSha256 }, now())
        : null
    store.event("deployment.health-observed", id, {
      attemptId,
      targetId: p.targetId,
      kind,
      valid: !!receipt,
      receipt,
      artifact: result.artifact,
      verificationDigest: nativeVerificationDigest(w.verification!)
    })
    return receipt
      ? { ...receipt, artifact: { path: result.artifact, sha256: nativeContentDigest(readFileSync(result.artifact)) } }
      : null
  }
  const confirm = async (op: DeploymentOperation, kind: "deploy" | "rollback") => {
    if (
      op.receiptVersion !== 1 ||
      op.verificationDigest !== nativeVerificationDigest(w.verification!) ||
      op.attemptId !== attemptId ||
      op.targetId !== p.targetId ||
      op.revision !== (kind === "deploy" ? w.mergedSha : p.previousKnownGood.revision) ||
      op.artifactSha256 !== (kind === "deploy" ? p.artifactSha256 : p.previousKnownGood.artifactSha256)
    )
      throw new Error("Deployment receipt belongs to another target or attempt")
    for (const artifact of op.evidenceArtifacts ?? [])
      if (nativeContentDigest(readFileSync(artifact.path)) !== artifact.sha256)
        throw new Error("Deployment evidence artifact replaced")
    const receipt = await observe(op.revision, op.artifactSha256, kind)
    if (receipt) {
      op.evidenceArtifacts ??= []
      op.evidenceArtifacts.push(receipt.artifact)
    }
    if (receipt?.rolloutState === "settled" && receipt.healthy && receipt.workflowPassed) {
      op.healthySince ??= now()
      op.lastObservedAt = now()
      store.put("operation", kind === "deploy" ? key : rollbackKey, op)
      if (now() - op.healthySince < p.observationSeconds * 1000)
        throw new NativeReleasePending(`${kind} health observation window is incomplete`)
      op.state = "confirmed"
      store.put("operation", kind === "deploy" ? key : rollbackKey, op)
      store.put("deployment-target", targetKey, {
        workflowId: id,
        attemptId,
        state: "healthy",
        revision: op.revision,
        artifactSha256: op.artifactSha256
      })
      store.event("deployment.health-window-confirmed", id, {
        attemptId,
        deployedSha: op.revision,
        healthy: true,
        observedUntil: now(),
        targetId: p.targetId
      })
      if (kind === "rollback") {
        store.event("workflow.rolled-back", id, {
          attemptId,
          deployedSha: w.mergedSha,
          restoredSha: op.revision,
          targetId: p.targetId
        })
        throw new Error("Deployment rolled back to independently verified known-good revision")
      }
      if (w.proposal.quality?.hypothesis) {
        w.benefitEvidence = assessNativeBenefit(w.proposal.quality.hypothesis, receipt.benefitObservation)
        store.put("benefit-evidence", id, { deployedSha: w.mergedSha, recordedAt: now(), ...w.benefitEvidence })
      }
      return
    }
    delete op.healthySince
    store.put("operation", kind === "deploy" ? key : rollbackKey, op)
    if (now() - op.startedAt >= p.reconciliationSeconds * 1000) {
      op.state = "unresolved"
      store.put("operation", kind === "deploy" ? key : rollbackKey, op)
      throw new NativeReleasePending(
        `${kind} reconciliation deadline exceeded; operator recovery required, target remains held`
      )
    }
    if (kind === "deploy" && receipt?.rolloutState === "settled" && (!receipt.healthy || !receipt.workflowPassed)) {
      store.event("workflow.regression", id, { attemptId, deployedSha: op.revision, targetId: p.targetId })
      if (p.rollback && !p.forwardOnly) {
        runtime.control.assert()
        runtime.reserveBudget(id, attemptId, "rollback", rollbackKey, true)
        const rollback: DeploymentOperation = {
          receiptVersion: 1,
          verificationDigest: nativeVerificationDigest(w.verification!),
          state: "started",
          startedAt: now(),
          attemptId,
          targetId: p.targetId,
          revision: p.previousKnownGood.revision,
          artifactSha256: p.previousKnownGood.artifactSha256
        }
        store.put("operation", rollbackKey, rollback)
        await io.command(
          p.rollback,
          policy.repository,
          resolve(artifacts, "rollback.json"),
          env(rollback.revision, rollback.artifactSha256)
        )
        throw new NativeReleasePending("Rollback initiated; independent restoration observation required")
      }
    }
    throw new NativeReleasePending(`${kind} outcome unresolved; waiting for target revision and settled health`)
  }
  const rollback = store.get<DeploymentOperation>("operation", rollbackKey)
  if (rollback) {
    if (rollback.state === "confirmed") throw new Error("Deployment was rolled back; fresh reviewed workflow required")
    return confirm(rollback, "rollback")
  }
  let previous = store.get<DeploymentOperation>("operation", key)
  if (previous?.state === "confirmed") {
    for (const artifact of previous.evidenceArtifacts ?? [])
      if (nativeContentDigest(readFileSync(artifact.path)) !== artifact.sha256)
        throw new Error("Deployment evidence artifact replaced")
    if (
      previous.receiptVersion !== 1 ||
      previous.attemptId !== attemptId ||
      previous.targetId !== p.targetId ||
      previous.verificationDigest !== nativeVerificationDigest(w.verification!) ||
      previous.revision !== w.mergedSha ||
      previous.artifactSha256 !== p.artifactSha256
    )
      throw new Error("Confirmed deployment receipt identity changed")
    return
  }
  if (!previous) {
    runtime.control.assert()
    const baseline = await observe(p.previousKnownGood.revision, p.previousKnownGood.artifactSha256, "baseline")
    if (!baseline?.healthy || !baseline.workflowPassed || baseline.rolloutState !== "settled")
      throw new NativeReleasePending("Previous known-good target revision and health are not independently confirmed")
    runtime.control.assert()
    runtime.reserveBudget(id, attemptId, "deployment", key)
    store.put("deployment-target", targetKey, { workflowId: id, attemptId, state: "held" })
    previous = {
      evidenceArtifacts: [baseline.artifact],
      receiptVersion: 1,
      verificationDigest: nativeVerificationDigest(w.verification!),
      state: "started",
      startedAt: now(),
      attemptId,
      targetId: p.targetId,
      revision: w.mergedSha!,
      artifactSha256: p.artifactSha256
    }
    store.put("operation", key, previous)
    await io.command(
      p.command,
      policy.repository,
      resolve(artifacts, "deploy.json"),
      env(previous.revision, previous.artifactSha256)
    )
  }
  return confirm(previous, "deploy")
}
