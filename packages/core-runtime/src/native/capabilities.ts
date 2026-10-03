// New: provider-neutral eligibility from protected measured evidence, never account/cooldown ownership.
import { createHash } from "node:crypto"
import { lstatSync, readFileSync, realpathSync } from "node:fs"
import { isAbsolute, relative, sep } from "node:path"
import type { NativeAutonomyPolicy } from "@openclaw/domain"
import { nativeCoderAgentIds, nativePolicyDigest } from "@openclaw/domain"
import { type NativeHumanAuthority, requireNativeHuman } from "./governance.js"
import type { NativeEvidenceStore } from "./store.js"
export interface NativeCapabilities {
  contextTokens: number | null
  structuredOutput: boolean | null
  tools: string[] | null
  cancellation: boolean | null
  sessionResume: boolean | null
  costPerVerifiedOutcome: number | null
}
export interface NativeCapabilityEvidence {
  version: 1
  agentId: string
  model: string
  benchmarkId: string
  datasetDigest: string
  policyDigest: string
  mode: "controlled-fixture" | "live"
  capabilities: NativeCapabilities
  measuredAt: number
  expiresAt: number
  artifact: { path: string; sha256: string }
}
export interface NativeCapabilityRequirement {
  contextTokens: number
  structuredOutput: boolean
  tools: string[]
  cancellation: boolean
  sessionResume: boolean
  requireKnownCost: boolean
}
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
function validateEvidence(value: NativeCapabilityEvidence) {
  if (
    value?.version !== 1 ||
    !value.agentId ||
    !value.model ||
    !value.benchmarkId ||
    !["live", "controlled-fixture"].includes(value.mode) ||
    ![value.datasetDigest, value.policyDigest, value.artifact?.sha256].every(
      (x) => typeof x === "string" && /^[a-f0-9]{64}$/.test(x)
    ) ||
    !Number.isFinite(value.measuredAt) ||
    !Number.isFinite(value.expiresAt) ||
    value.expiresAt <= value.measuredAt
  )
    throw new Error("Invalid capability evidence identity")
  const c = value.capabilities
  if (
    !c ||
    ![c.structuredOutput, c.cancellation, c.sessionResume].every((x) => x === null || typeof x === "boolean") ||
    (c.contextTokens !== null && (!Number.isSafeInteger(c.contextTokens) || c.contextTokens < 1)) ||
    (c.tools !== null && (!Array.isArray(c.tools) || c.tools.some((x) => typeof x !== "string"))) ||
    (c.costPerVerifiedOutcome !== null && (!Number.isFinite(c.costPerVerifiedOutcome) || c.costPerVerifiedOutcome < 0))
  )
    throw new Error("Invalid capability measurements")
}
function verifyArtifact(value: NativeCapabilityEvidence) {
  validateEvidence(value)
  if (
    !isAbsolute(value.artifact.path) ||
    !lstatSync(value.artifact.path).isFile() ||
    lstatSync(value.artifact.path).isSymbolicLink()
  )
    throw new Error("Capability artifact must be protected regular file")
  const raw = readFileSync(value.artifact.path)
  if (digest(raw) !== value.artifact.sha256) throw new Error("Capability artifact changed")
  const { artifact: _, ...expected } = value
  if (JSON.stringify(JSON.parse(raw.toString("utf8"))) !== JSON.stringify(expected))
    throw new Error("Capability artifact does not substantiate measurements")
}
export function registerNativeCapabilityEvidence(
  store: NativeEvidenceStore,
  value: NativeCapabilityEvidence,
  artifactRoot: string,
  authority: NativeHumanAuthority,
  agentIds: readonly string[]
) {
  requireNativeHuman(authority, agentIds)
  const path = relative(realpathSync(artifactRoot), realpathSync(value.artifact.path))
  if (!isAbsolute(artifactRoot) || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path))
    throw new Error("Capability artifact outside protected root")
  verifyArtifact(value)
  const id = digest(JSON.stringify(value))
  if (!store.get("capability-evidence", id))
    store.commit([{ kind: "capability-evidence", id, value, expectedVersion: 0 }], {
      kind: "capability.reviewed",
      subject: id,
      value: {
        agentId: value.agentId,
        model: value.model,
        benchmarkId: value.benchmarkId,
        operatorId: authority.operatorId
      }
    })
  return id
}
export function nativeCapabilityEligibility(
  value: NativeCapabilityEvidence,
  required: NativeCapabilityRequirement,
  expected: { agentId: string; model: string; policyDigest: string; allowControlled?: boolean },
  now = Date.now()
) {
  validateEvidence(value)
  if (
    !required ||
    !Number.isSafeInteger(required.contextTokens) ||
    required.contextTokens < 1 ||
    !Array.isArray(required.tools) ||
    required.tools.some((t) => typeof t !== "string") ||
    ![required.structuredOutput, required.cancellation, required.sessionResume, required.requireKnownCost].every(
      (v) => typeof v === "boolean"
    )
  )
    throw new Error("Invalid reviewed role requirements")
  const reasons: string[] = []
  const c = value.capabilities
  if (
    value.agentId !== expected.agentId ||
    value.model !== expected.model ||
    value.policyDigest !== expected.policyDigest
  )
    reasons.push("agent/model/policy identity mismatch")
  if (value.measuredAt > now || value.expiresAt <= now) reasons.push("capability evidence expired or future-dated")
  if (value.mode !== "live" && !expected.allowControlled)
    reasons.push("controlled fixture does not measure live model capability")
  if (c.contextTokens === null || c.contextTokens < required.contextTokens)
    reasons.push("context budget unsupported or unknown")
  for (const key of ["structuredOutput", "cancellation", "sessionResume"] as const)
    if (required[key] && c[key] !== true) reasons.push(`${key} unsupported or unknown`)
  if (required.tools.some((tool) => !c.tools?.includes(tool)))
    reasons.push("required tool capability unsupported or unknown")
  if (required.requireKnownCost && c.costPerVerifiedOutcome === null) reasons.push("cost is unknown")
  return {
    eligible: reasons.length === 0,
    reasons,
    benchmarkId: value.benchmarkId,
    model: value.model,
    measuredCost: c.costPerVerifiedOutcome,
    toolsRemainUnchanged: true
  }
}
/** Fixed reviewed role assignments remain the only allowed route; upstream owns model/provider fallback. */
export function assertConfiguredNativeCapabilities(
  store: Pick<NativeEvidenceStore, "get">,
  policy: NativeAutonomyPolicy,
  models: Record<string, string>,
  now = Date.now()
) {
  const requirements = store.get<{
    policyDigest: string
    roles: Record<string, { evidenceId: string; requirements: NativeCapabilityRequirement }>
  }>("capability-requirements", policy.boardId)
  const policyDigest = nativePolicyDigest(policy)
  if (!requirements || requirements.policyDigest !== policyDigest)
    throw new Error("Reviewed role capability requirements missing or stale")
  const decisions = []
  for (const agentId of new Set([
    policy.plannerAgentId,
    ...nativeCoderAgentIds(policy),
    policy.reviewerAgentId,
    ...policy.personas.map((p) => p.investigationAgentId ?? p.personaId)
  ])) {
    const role = requirements.roles[agentId],
      value = role && store.get<NativeCapabilityEvidence>("capability-evidence", role.evidenceId)
    if (!value || digest(JSON.stringify(value)) !== role.evidenceId || !models[agentId])
      throw new Error(`Live model evidence missing for configured role ${agentId}`)
    verifyArtifact(value)
    const result = nativeCapabilityEligibility(
      value,
      role.requirements,
      { agentId, model: models[agentId]!, policyDigest },
      now
    )
    if (!result.eligible) throw new Error(`Configured role ${agentId} is ineligible: ${result.reasons.join("; ")}`)
    decisions.push(result)
  }
  return decisions
}

/** Operator-owned requirements; this API must never be exposed as an agent tool. */
export function approveNativeCapabilityRequirements(
  store: NativeEvidenceStore,
  policy: NativeAutonomyPolicy,
  roles: Record<string, { evidenceId: string; requirements: NativeCapabilityRequirement }>,
  models: Record<string, string>,
  authority: NativeHumanAuthority
) {
  requireNativeHuman(authority, [
    policy.plannerAgentId,
    ...nativeCoderAgentIds(policy),
    policy.reviewerAgentId,
    ...policy.personas.flatMap((p) => [p.personaId, p.investigationAgentId ?? p.personaId])
  ])
  const value = { policyDigest: nativePolicyDigest(policy), roles }
  const reader: Pick<NativeEvidenceStore, "get"> = {
    get: <T>(kind: string, id: string) =>
      kind === "capability-requirements" && id === policy.boardId ? (value as T) : store.get<T>(kind, id)
  }
  const decisions = assertConfiguredNativeCapabilities(reader, policy, models)
  store.commit([{ kind: "capability-requirements", id: policy.boardId, value }], {
    kind: "capability.requirements-approved",
    subject: policy.boardId,
    value: { operatorId: authority.operatorId, rationale: authority.rationale, policyDigest: value.policyDigest }
  })
  return decisions
}

export function configuredNativeModels(config: any, policy: NativeAutonomyPolicy): Record<string, string> {
  const models: Record<string, string> = {}
  for (const id of new Set([
    policy.plannerAgentId,
    ...nativeCoderAgentIds(policy),
    policy.reviewerAgentId,
    ...policy.personas.map((p) => p.investigationAgentId ?? p.personaId)
  ])) {
    const agent = config?.agents?.entries?.[id] ?? config?.agents?.list?.find((a: any) => a.id === id)
    const model = agent?.model ?? config?.agents?.defaults?.model
    const primary = typeof model === "string" ? model : model?.primary
    if (typeof primary !== "string" || !primary.trim()) throw new Error(`Configured model unknown for role ${id}`)
    // Unmeasured automatic model fallback cannot inherit the primary model's evidence.
    if (typeof model === "object" && model?.fallbacks?.length)
      throw new Error(`Unmeasured model fallbacks for role ${id}`)
    models[id] = primary
  }
  return models
}
