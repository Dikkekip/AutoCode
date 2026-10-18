import { readFileSync, realpathSync } from "node:fs"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { assertNativeReleaseGate } from "@openclaw/domain"
import { assertNativeProvenance, nativeContentDigest, nativeVerificationDigest } from "./provenance.js"
import type { NativeAutonomyRuntime, NativeWorkflow } from "./runtime.js"
import { assertNativeVerificationEvidence } from "./verification.js"

interface Retirement {
  state: "retained" | "removed"
  attemptedAt: number
  headSha: string
  reason?: string
}

/** Release acceptance owns retirement; terminal coder sessions never authorize it. */
export async function retireNativeAcceptedWorkspace(runtime: NativeAutonomyRuntime, id: string, w: NativeWorkflow) {
  const { store, policy, gateway } = runtime
  const previous = store.get<Retirement>("workspace-retirement", id)
  if (previous?.state === "removed" || (previous && Date.now() - previous.attemptedAt < 6 * 3600_000)) return
  if (!w.candidate || !w.deployedSha || w.deployedSha !== w.mergedSha || w.lifecycle?.state !== "completed") return
  const candidate = w.candidate
  const retain = (reason: string) => {
    store.put("workspace-retirement", id, {
      state: "retained",
      attemptedAt: Date.now(),
      headSha: candidate.headSha,
      reason
    })
    store.event("workspace.retained", id, { reason })
  }
  try {
    assertNativeReleaseGate({
      headSha: candidate.headSha,
      authorAgentId: w.submission?.agentId ?? policy.coderAgentId,
      reviewerAgentId: policy.reviewerAgentId,
      verification: w.verification ?? null,
      review: w.review ?? null
    })
    assertNativeVerificationEvidence(
      policy,
      candidate,
      w.verification!,
      w.proposal.acceptance,
      runtime.quality.designApproved(w) ? { headSha: candidate.headSha, reviewedBy: policy.reviewerAgentId } : undefined
    )
    assertNativeProvenance(policy, w.verification!, {
      workflowId: id,
      attemptId: w.lifecycle.attemptId,
      skillDigest: w.proposal.quality?.skillHash ?? nativeContentDigest(w.proposal.implementationPrompt)
    })
    const deployment = store.get<{
      state: string
      attemptId: string
      revision: string
      verificationDigest: string
      evidenceArtifacts?: Array<{ path: string; sha256: string }>
    }>("operation", `${id}:deploy`)
    if (
      deployment?.state !== "confirmed" ||
      deployment.attemptId !== w.lifecycle.attemptId ||
      deployment.revision !== w.deployedSha ||
      deployment.verificationDigest !== nativeVerificationDigest(w.verification!) ||
      !deployment.evidenceArtifacts?.length
    )
      throw new Error("Accepted deployment evidence unavailable")
    const cwd = realpathSync(candidate.cwd)
    if (cwd === realpathSync(policy.repository)) throw new Error("Primary repository is retained")
    const inside = (file: string) => {
      const rel = relative(cwd, realpathSync(file))
      return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
    }
    for (const artifact of deployment.evidenceArtifacts) {
      if (inside(artifact.path) || nativeContentDigest(readFileSync(artifact.path)) !== artifact.sha256)
        throw new Error("Deployment evidence must remain intact outside the retired workspace")
    }
    for (const check of w.verification!.checks) {
      if (inside(check.artifact)) throw new Error("Verification evidence is inside the workspace")
    }
    if (!w.verification!.provenanceArtifact || inside(w.verification!.provenanceArtifact.path))
      throw new Error("Verification provenance must remain outside the retired workspace")
    const listed = await gateway.request<{
      worktrees: Array<{
        id: string
        path: string
        ownerKind: string
        ownerId?: string
        removedAt?: number
      }>
    }>("worktrees.list", {})
    const records = listed.worktrees.filter(
      (record) =>
        !record.removedAt &&
        resolve(record.path) === cwd &&
        record.ownerKind === "workboard" &&
        record.ownerId === w.implementationCardId
    )
    if (records.length !== 1) throw new Error("Exact managed implementation workspace unavailable")
    // The core owner revalidates exact HEAD under its exclusive removal claim,
    // retains dirty/nested/busy/mounted trees, and pins a lossless recovery ref.
    const result = await gateway.request<{ removed: boolean }>("worktrees.remove", {
      id: records[0]!.id,
      ifLossless: true,
      expectedHead: candidate.headSha
    })
    if (!result.removed) return retain("Canonical owner retained workspace")
    store.put("workspace-retirement", id, { state: "removed", attemptedAt: Date.now(), headSha: candidate.headSha })
    store.event("workspace.retired", id, { worktreeId: records[0]!.id, headSha: candidate.headSha })
  } catch (error) {
    // Cleanup failure cannot reverse accepted release or authorize a fallback delete.
    retain(error instanceof Error ? error.message.slice(0, 500) : "Workspace retirement unavailable")
  }
}
