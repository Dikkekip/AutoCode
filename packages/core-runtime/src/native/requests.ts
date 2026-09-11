import { createHash } from "node:crypto"
import { nativePathAllowed } from "@openclaw/domain"
import type { NativeAutonomyRuntime } from "./runtime.js"
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
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const text = (value: unknown, name: string, max: number) => {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`Invalid request ${name}`)
  return value.trim()
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
