import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { nativeCoderAgentIds } from "@openclaw/domain"
import { assertExecutionOwnership } from "@openclaw/os-adapters"
import { assertNativeDeploymentPolicy, decodeNativeHealth } from "./deployment-health.js"
import type { NativeGateway } from "./gateway.js"
import { nativeGovernanceDigest, requireNativeHuman } from "./governance.js"
import {
  assertNativePolicyLocalIdle,
  assertNativePolicyRemoteIdle,
  nativeLoadedPolicyDigest
} from "./policy-refresh.js"
import { nativeContentDigest } from "./provenance.js"
import { registeredNativeRetainedSession } from "./retained-session-proof.js"
import type { NativeAutonomyRuntime, NativeWorkflow } from "./runtime.js"
import { nativeRuntimeGeneration } from "./runtime-lifetime.js"
import { runNativeDeploymentCommand } from "./verification.js"

interface BaselineSelection {
  workflowId: string
  revision: string
  artifactSha256: string
  reason: string
}
interface PreparedArtifact {
  targetId: string
  revision: string
  artifactSha256: string
  staged: boolean
  previousKnownGood: { revision: string; artifactSha256: string }
  evidence: { path: string; sha256: string }
}
interface HealthyTarget {
  workflowId: string
  attemptId: string
  state: string
  revision: string
  artifactSha256: string
}
/** Only exact, already merged releases with no deployment effect can adopt an external baseline. */
function snapshot(runtime: NativeAutonomyRuntime, input: BaselineSelection) {
  if (
    !input ||
    typeof input.workflowId !== "string" ||
    typeof input.revision !== "string" ||
    typeof input.artifactSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.workflowId) ||
    !/^[a-f0-9]{40,64}$/.test(input.revision) ||
    !/^[a-f0-9]{64}$/.test(input.artifactSha256) ||
    typeof input.reason !== "string" ||
    !input.reason.trim() ||
    input.reason.length > 2000
  )
    throw new Error("Exact workflow, baseline identity and bounded operator reason required")
  const { policy, store } = runtime,
    control = runtime.control.state,
    deployment = assertNativeDeploymentPolicy(policy)
  if (
    policy.repositoryKind !== "application" ||
    deployment.authorized !== true ||
    !deployment.prepare ||
    !control.paused ||
    control.frozen ||
    store.get<{ paused: boolean }>("control", "pause")?.paused !== true
  )
    throw new Error("Baseline adoption requires an authorized preparation policy and explicit, unfrozen pause")
  const workflow = store.get<NativeWorkflow>("workflow", input.workflowId)
  if (
    !workflow ||
    workflow.archivedAt ||
    workflow.deployedSha ||
    workflow.lifecycle?.state !== "deployment" ||
    !workflow.lifecycle.attemptId ||
    workflow.review?.verdict !== "approved" ||
    !/^[a-f0-9]{40,64}$/.test(workflow.mergedSha ?? "") ||
    workflow.mergedSha === input.revision
  )
    throw new Error("An approved merged workflow awaiting its first deployment is required")
  if (["deploy", "rollback"].some((effect) => store.get("operation", `${input.workflowId}:${effect}`)))
    throw new Error("Deployment effects already began; baseline adoption cannot reconcile them")
  const targetKey = nativeContentDigest(deployment.targetId),
    preparedKey = `${input.workflowId}:${workflow.lifecycle.attemptId}:artifact`,
    target = store.get<HealthyTarget>("deployment-target", targetKey),
    prepared = store.get<PreparedArtifact>("deployment-artifact", preparedKey)
  if (
    !target ||
    target.state !== "healthy" ||
    !target.workflowId ||
    !target.attemptId ||
    target.workflowId === input.workflowId ||
    !/^[a-f0-9]{40,64}$/.test(target.revision) ||
    !/^[a-f0-9]{64}$/.test(target.artifactSha256) ||
    (target.revision === input.revision && target.artifactSha256 === input.artifactSha256)
  )
    throw new Error("Only a drifted, previously healthy target owned by another release can be reconciled")
  if (
    !prepared ||
    prepared.targetId !== deployment.targetId ||
    prepared.revision !== workflow.mergedSha ||
    prepared.staged !== true ||
    !/^[a-f0-9]{64}$/.test(prepared.artifactSha256) ||
    prepared.previousKnownGood?.revision !== target.revision ||
    prepared.previousKnownGood?.artifactSha256 !== target.artifactSha256 ||
    !prepared.evidence?.path ||
    nativeContentDigest(readFileSync(prepared.evidence.path)) !== prepared.evidence.sha256
  )
    throw new Error("Exact staged artifact and its original known-good binding must remain intact")
  const pin = (kind: string, id: string, value: unknown) => ({
    kind,
    id,
    version: store.version(kind, id),
    digest: nativeGovernanceDigest(value)
  })
  return {
    version: 1 as const,
    boardId: policy.boardId,
    workflowId: input.workflowId,
    revision: input.revision,
    artifactSha256: input.artifactSha256,
    reason: input.reason,
    controlRevision: control.revision,
    freezeRevision: control.freezeRevision,
    runtimeGeneration: nativeRuntimeGeneration(runtime),
    policyDigest: nativeLoadedPolicyDigest(policy),
    workflow: pin("workflow", input.workflowId, workflow),
    target: pin("deployment-target", targetKey, target),
    prepared: pin("deployment-artifact", preparedKey, prepared)
  }
}
export function planNativeDeploymentBaseline(runtime: NativeAutonomyRuntime, input: BaselineSelection) {
  return snapshot(runtime, input)
}

/** Called inside the host exclusive barrier and native execution ownership. No deploy/rollback command runs here. */
export async function applyNativeDeploymentBaseline(
  runtime: NativeAutonomyRuntime,
  rawPlan: unknown,
  operatorId: string,
  gateway: NativeGateway,
  assertGeneration: () => void,
  command = runNativeDeploymentCommand
) {
  const selection = rawPlan as ReturnType<typeof snapshot>,
    plan = snapshot(runtime, selection)
  if (!isDeepStrictEqual(plan, rawPlan)) throw new Error("Invalid or stale exact deployment baseline plan")
  requireNativeHuman({ operatorId, rationale: plan.reason }, [
    runtime.policy.plannerAgentId,
    ...nativeCoderAgentIds(runtime.policy),
    runtime.policy.reviewerAgentId,
    ...runtime.policy.personas.flatMap((p) => [p.personaId, p.investigationAgentId ?? p.personaId])
  ])
  const { store, policy } = runtime,
    planDigest = nativeGovernanceDigest(plan),
    auditKind = "deployment-baseline-adoption"
  const assertPlan = () => {
    assertGeneration()
    assertExecutionOwnership()
    if (!isDeepStrictEqual(snapshot(runtime, plan), plan))
      throw new Error("Deployment baseline authority changed; generate a fresh plan")
    if (store.version(auditKind, planDigest)) throw new Error("Deployment baseline plan was already applied")
  }
  assertPlan()
  assertNativePolicyLocalIdle(runtime)
  const lease = store.acquire("deployment-baseline-adoption", 120_000)
  if (!lease) throw new Error("Deployment baseline adoption is already running")
  return store.withLease(lease, 120_000, async () => {
    const assertLocal = () => {
      assertPlan()
      assertNativePolicyLocalIdle(runtime, lease.id)
    }
    assertLocal()
    await assertNativePolicyRemoteIdle(runtime, gateway)
    assertLocal()
    const configured = assertNativeDeploymentPolicy(policy),
      workflow = store.get<NativeWorkflow>("workflow", plan.workflowId)!,
      previousTarget = store.get<HealthyTarget>(plan.target.kind, plan.target.id)!,
      previousPrepared = store.get<PreparedArtifact>(plan.prepared.kind, plan.prepared.id)!,
      result = await command(
        configured.check,
        policy.repository,
        resolve(
          policy.repository,
          ".openclaw/native-artifacts/deployment-baseline-adoptions",
          planDigest,
          "check.json"
        ),
        {
          AUTOCODE_SHA: plan.revision,
          AUTOCODE_ARTIFACT_SHA256: plan.artifactSha256,
          AUTOCODE_TARGET_ID: configured.targetId,
          AUTOCODE_WORKFLOW_ID: plan.workflowId,
          AUTOCODE_ATTEMPT_ID: workflow.lifecycle!.attemptId,
          AUTOCODE_REPOSITORY: policy.repository
        },
        configured
      )
    const health = () => {
      const receipt =
        result.outcome === "success" && result.exitCode === 0
          ? decodeNativeHealth(
              result.stdout,
              { targetId: configured.targetId, revision: plan.revision, artifactSha256: plan.artifactSha256 },
              Date.now()
            )
          : null
      if (!receipt?.healthy || !receipt.workflowPassed || receipt.rolloutState !== "settled")
        throw new Error("Current baseline identity and settled health are not independently confirmed")
      return receipt
    }
    health()
    const evidence = { path: result.artifact, sha256: nativeContentDigest(readFileSync(result.artifact)) }
    const { retainedCards, ...idleEvidence } = await assertNativePolicyRemoteIdle(runtime, gateway)
    assertLocal()
    const receipt = health(),
      identity = { revision: plan.revision, artifactSha256: plan.artifactSha256 },
      audit = { plan, operatorId, previousTarget, previousPrepared, receipt, evidence, idleEvidence }
    store.commit(
      [
        { kind: auditKind, id: planDigest, value: audit, expectedVersion: 0 },
        {
          kind: plan.target.kind,
          id: plan.target.id,
          expectedVersion: plan.target.version,
          value: {
            workflowId: `operator-baseline:${planDigest}`,
            attemptId: `operator-baseline:${planDigest}`,
            state: "healthy",
            ...identity,
            adoptionDigest: planDigest
          }
        },
        {
          kind: plan.prepared.kind,
          id: plan.prepared.id,
          expectedVersion: plan.prepared.version,
          value: { ...previousPrepared, previousKnownGood: identity }
        }
      ],
      { kind: "deployment.baseline-adopted", subject: plan.workflowId, value: { planDigest, operatorId, evidence } },
      lease,
      () => {
        assertLocal()
        health()
        for (const card of retainedCards)
          if (!registeredNativeRetainedSession(runtime, card))
            throw new Error("Retained session proof disappeared before baseline adoption")
        if (nativeContentDigest(readFileSync(evidence.path)) !== evidence.sha256)
          throw new Error("Baseline health evidence changed before commit")
      }
    )
    return { planDigest, targetId: configured.targetId, ...identity, evidence, paused: true }
  })
}
