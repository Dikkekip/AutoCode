import { createHash } from "node:crypto"
import { nativeCoderAgentIds, nativePathAllowed } from "@openclaw/domain"
import { type NativeHumanAuthority, requireNativeHuman } from "./governance.js"
import { nativeLoadedPolicyDigest } from "./policy-refresh.js"
import type { NativeAutonomyRuntime } from "./runtime.js"
import { nativeRuntimeGeneration } from "./runtime-lifetime.js"
import { nativeGit } from "./verification.js"

export interface NativeOperatorRequest {
  id: string
  digest: string
  operator: string
  createdAt: number
  state: "queued" | "building" | "dispatched" | "deferred"
  roundId: string
  reason?: string
  brief: {
    idempotencyKey: string
    personaId: string
    title: string
    brief: string
    expectedBaseSha: string
    evidence: Array<{ path: string; observation: string; blobSha: string }>
  }
}

export interface NativeRequestDeferralPlan {
  version: 1
  boardId: string
  requestId: string
  requestDigest: string
  requestSnapshotDigest: string
  expectedVersion: number
  policyDigest: string
  controlRevision: string
  freezeRevision: string
  runtimeGeneration: string
  reason: string
  digest: string
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const text = (value: unknown, name: string, max: number) => {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`Invalid request ${name}`)
  return value.trim()
}

/** Only an unstarted local request can be withdrawn through this operation. */
export function planNativeRequestDeferral(
  runtime: NativeAutonomyRuntime,
  requestId: string,
  reason: string
): NativeRequestDeferralPlan {
  if (!runtime.control.state.paused || runtime.control.state.frozen)
    throw new Error("Queued request deferral requires paused, unfrozen execution")
  if (!/^[a-f0-9]{64}$/.test(requestId)) throw new Error("Exact request identity required")
  const request = runtime.store.get<NativeOperatorRequest>("operator-request", requestId)
  if (!request || request.id !== requestId || request.state !== "queued")
    throw new Error("Only an existing queued request can be deferred")
  if (request.id !== digest({ boardId: runtime.policy.boardId, key: request.brief.idempotencyKey }))
    throw new Error("Request belongs to a different native board")
  if (runtime.store.version("round", request.roundId) > 0) throw new Error("Request investigation has already started")
  for (const kind of ["investigation", "inspection", "proposal", "effect-intent", "workflow"]) {
    if (
      runtime.store
        .list(kind)
        .some((item) => item.id.includes(request.roundId) || JSON.stringify(item.value).includes(request.roundId))
    )
      throw new Error("Request has native investigation or execution evidence")
  }
  const binding = {
    version: 1 as const,
    boardId: runtime.policy.boardId,
    requestId,
    requestDigest: request.digest,
    requestSnapshotDigest: digest(request),
    expectedVersion: runtime.store.version("operator-request", requestId),
    policyDigest: nativeLoadedPolicyDigest(runtime.policy),
    controlRevision: runtime.control.state.revision,
    freezeRevision: runtime.control.state.freezeRevision,
    runtimeGeneration: nativeRuntimeGeneration(runtime),
    reason: text(reason, "deferral reason", 4000)
  }
  return { ...binding, digest: digest(binding) }
}

export function applyNativeRequestDeferral(
  runtime: NativeAutonomyRuntime,
  plan: NativeRequestDeferralPlan,
  authority: NativeHumanAuthority
) {
  requireNativeHuman(authority, [
    runtime.policy.plannerAgentId,
    ...nativeCoderAgentIds(runtime.policy),
    runtime.policy.reviewerAgentId,
    ...runtime.policy.personas.flatMap((persona) => [
      persona.personaId,
      persona.investigationAgentId ?? persona.personaId
    ])
  ])
  const current = planNativeRequestDeferral(runtime, plan.requestId, plan.reason)
  if (JSON.stringify(current) !== JSON.stringify(plan)) throw new Error("Queued request deferral plan changed")
  if (authority.rationale !== plan.reason) throw new Error("Reviewed deferral reason changed")
  const original = runtime.store.get<NativeOperatorRequest>("operator-request", plan.requestId)!
  const request = { ...original, state: "deferred" as const, reason: plan.reason }
  const historyId = `${original.id}:deferred:${plan.expectedVersion}:${plan.requestSnapshotDigest}`
  runtime.store.commit(
    [
      { kind: "operator-request-history", id: historyId, value: original, expectedVersion: 0 },
      { kind: "operator-request", id: original.id, value: request, expectedVersion: plan.expectedVersion }
    ],
    {
      kind: "operator-request.deferred",
      subject: original.id,
      value: { plan, historyId, operatorId: authority.operatorId, rationale: authority.rationale }
    }
  )
  return { request, historyId }
}
export async function createNativeOperatorRequest(runtime: NativeAutonomyRuntime, raw: any, operator: string) {
  if (!runtime.policy.quality) throw new Error("Operator requests require native quality investigations")
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Request object required")
  const keys = ["idempotencyKey", "personaId", "title", "brief", "expectedBaseSha", "evidence"]
  if (Object.keys(raw).some((key) => !keys.includes(key))) throw new Error("Unknown operator request field")
  const input = {
    idempotencyKey: text(raw.idempotencyKey, "idempotencyKey", 160),
    personaId: text(raw.personaId, "personaId", 160),
    title: text(raw.title, "title", 240),
    brief: text(raw.brief, "brief", 8000),
    expectedBaseSha: text(raw.expectedBaseSha, "expectedBaseSha", 64),
    evidence: [] as Array<{ path: string; observation: string }>
  }
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(input.expectedBaseSha)) throw new Error("Request requires full base SHA")
  const persona = runtime.policy.personas.find((p) => p.personaId === input.personaId)
  if (!persona) throw new Error("Request persona is not configured")
  if (!Array.isArray(raw.evidence) || !raw.evidence.length || raw.evidence.length > 20)
    throw new Error("Request needs 1-20 evidence files")
  input.evidence = raw.evidence.map((entry: any) => {
    if (!entry || Object.keys(entry).some((key) => !["path", "observation"].includes(key)))
      throw new Error("Invalid evidence entry")
    const path = text(entry.path, "evidence path", 500)
    if (
      path.startsWith("/") ||
      path.includes("\\") ||
      path.split("/").some((p) => !p || p === "." || p === "..") ||
      !persona.allowedPaths.some((root) => nativePathAllowed(path, root))
    )
      throw new Error("Request evidence outside persona scope")
    return { path, observation: text(entry.observation, "observation", 2000) }
  })
  if (new Set(input.evidence.map((e) => e.path)).size !== input.evidence.length)
    throw new Error("Duplicate evidence path")
  const id = digest({ boardId: runtime.policy.boardId, key: input.idempotencyKey })
  const payloadDigest = digest(input)
  const lease = runtime.store.acquire(`operator-request:${id}`, 120_000)
  if (!lease) throw new Error("Request intake is active; retry same key")
  return runtime.store.withLease(lease, 120_000, async () => {
    const existing = runtime.store.get<NativeOperatorRequest>("operator-request", id)
    if (existing) {
      if (existing.digest !== payloadDigest) throw new Error("Request idempotency key content mismatch")
      return existing
    }
    const revision = await nativeGit(runtime.policy.repository, "rev-parse", `origin/${runtime.policy.baseBranch}`)
    if (revision !== input.expectedBaseSha) throw new Error("Request base changed; inspect current committed evidence")
    const evidence = []
    for (const entry of input.evidence) {
      const object = await nativeGit(runtime.policy.repository, "ls-tree", revision, "--", entry.path)
      const match = /^(100644|100755) blob ([a-f0-9]+)\t(.+)$/.exec(object)
      if (!match || match[3] !== entry.path) throw new Error("Request evidence must be an exact tracked regular file")
      evidence.push({ ...entry, blobSha: match[2]! })
    }
    const request: NativeOperatorRequest = {
      id,
      digest: payloadDigest,
      operator,
      createdAt: Date.now(),
      state: "queued",
      roundId: `operator-${id}`,
      brief: { ...input, evidence }
    }
    runtime.store.put("operator-request", id, request)
    runtime.store.event("operator-request.queued", id, { operator, digest: payloadDigest, revision })
    return request
  })
}
