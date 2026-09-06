// New: bounded deterministic problem/evidence decisions, with privileged reversible overrides.
import type { NativeProposal } from "@openclaw/domain"
import { nativeGovernanceDigest as digest, type NativeHumanAuthority, requireNativeHuman } from "./governance.js"
import type { NativeEvidenceStore } from "./store.js"

const words = (value: string) =>
  value
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu)
    ?.filter((word) => !["a", "an", "the", "in", "on", "to", "of", "for", "is", "are"].includes(word))
    .sort()
    .join(" ") ?? ""
const scope = (proposal: NativeProposal) => [...proposal.allowedPaths].sort()
export function nativeDuplicateIdentity(proposal: NativeProposal) {
  if (!proposal.quality) return null
  return digest({
    problem: words(proposal.quality.problem),
    workflow: words(proposal.quality.userWorkflow),
    scope: scope(proposal)
  })
}
export function allowNativeDuplicateOverride(
  store: NativeEvidenceStore,
  proposalId: string,
  proposal: NativeProposal,
  expiresAt: number,
  authority: NativeHumanAuthority,
  agentIds: readonly string[],
  now = Date.now()
) {
  requireNativeHuman(authority, agentIds)
  if (!Number.isFinite(expiresAt) || expiresAt <= now || expiresAt > now + 7 * 86400000)
    throw new Error("Dedupe override must expire within seven days")
  store.put("dedupe-override", proposalId, {
    proposalDigest: digest(proposal),
    expiresAt,
    operatorId: authority.operatorId,
    rationale: authority.rationale
  })
}
export function decideNativeDuplicate(
  store: NativeEvidenceStore,
  proposalId: string,
  proposal: NativeProposal,
  windowHours: number,
  now = Date.now()
) {
  if (!Number.isFinite(windowHours) || windowHours < 0) throw new Error("Invalid duplicate search window")
  const identity = nativeDuplicateIdentity(proposal)
  const override = store.get<{ proposalDigest: string; expiresAt: number }>("dedupe-override", proposalId)
  if (override && override.expiresAt > now && override.proposalDigest === digest(proposal)) {
    const result = { version: 1, suppress: false, reason: "operator_override", compared: 0 }
    store.put("dedupe-decision", proposalId, result)
    return result
  }
  const rows = store.db
    .prepare(
      "SELECT id,data FROM native_records WHERE kind='proposal' AND updated_at>=? ORDER BY updated_at DESC,id LIMIT 129"
    )
    .all(now - windowHours * 3600000)
  let compared = 0,
    reopened = false
  for (const row of rows.slice(0, 128)) {
    if (String(row.id) === proposalId) continue
    const other = JSON.parse(String(row.data)) as { proposal: NativeProposal }
    if (!other.proposal?.quality) continue
    compared++
    if (!identity || nativeDuplicateIdentity(other.proposal) !== identity) continue
    if (
      digest(Object.entries(other.proposal.quality.evidenceHashes).sort()) !==
      digest(Object.entries(proposal.quality!.evidenceHashes).sort())
    ) {
      reopened = true
      continue
    }
    const decision = store.get<{ outcome: string; workflowId?: string }>("decision", String(row.id))
    if (!decision) continue
    const workflowId = decision.workflowId
    const workflow = workflowId ? store.get<{ lifecycle?: { state: string } }>("workflow", workflowId) : null
    const reversal =
      workflowId &&
      store.db
        .prepare(
          "SELECT 1 FROM native_events WHERE subject=? AND kind IN ('workflow.regression','workflow.rolled-back') LIMIT 1"
        )
        .get(workflowId)
    if (reversal || workflow?.lifecycle?.state === "cancelled") {
      reopened = true
      continue
    }
    const result = {
      version: 1,
      suppress: true,
      reason: "same_problem_scope_and_evidence",
      matchingProposalId: String(row.id),
      compared,
      truncated: rows.length > 128
    }
    store.put("dedupe-decision", proposalId, result)
    return result
  }
  const result = {
    version: 1,
    suppress: false,
    reason: reopened ? "changed_evidence_or_reversed_resolution" : "no_proven_duplicate",
    compared,
    truncated: rows.length > 128
  }
  store.put("dedupe-decision", proposalId, result)
  return result
}
