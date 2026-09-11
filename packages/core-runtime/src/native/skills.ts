// New: immutable skill snapshots and human-gated, evidence-bound promotion. No file or policy mutation.
import { createHash } from "node:crypto"
import { lstatSync, readFileSync, realpathSync } from "node:fs"
import { isAbsolute, relative, sep } from "node:path"
import type { NativeAutonomyPolicy } from "@openclaw/domain"
import { nativeCoderAgentIds } from "@openclaw/domain"
import { nativeGovernanceDigest as digest, type NativeHumanAuthority, requireNativeHuman } from "./governance.js"
import { loadNativeSkillText, NATIVE_SKILL_MAX_BYTES } from "./skill-bundle.js"
import type { NativeEvidenceStore } from "./store.js"
export const NATIVE_SKILL_CONTRACT_VERSION = 1
export const nativeSkillPolicyDigest = (policy: NativeAutonomyPolicy) =>
  digest({
    version: 1,
    quality: policy.quality,
    verification: policy.verification,
    verificationAuthority: policy.verificationAuthority,
    repositoryKind: policy.repositoryKind,
    roles: [policy.plannerAgentId, ...nativeCoderAgentIds(policy), policy.reviewerAgentId]
  })
const artifactDigest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
export interface NativeSkillVersion {
  version: 1
  digest: string
  text: string
  contractVersion: 1
}
/** Review the configured snapshot without registering evidence or contacting a gateway. */
export function inspectNativeSkill(policy: NativeAutonomyPolicy, includeText = false) {
  if (!policy.quality) throw new Error("No investigation skill configured")
  const text = loadNativeSkillText(policy.quality.skillPath)
  return {
    boardId: policy.boardId,
    path: policy.quality.skillPath,
    digest: digest(text),
    policyDigest: nativeSkillPolicyDigest(policy),
    contractVersion: NATIVE_SKILL_CONTRACT_VERSION,
    bytes: Buffer.byteLength(text),
    ...(includeText ? { text } : {})
  }
}
export interface NativeSkillEvaluation {
  version: 1
  kind: "benchmark" | "injection"
  baselineDigest: string
  candidateDigest: string
  policyDigest: string
  datasetDigest: string
  baselineSuccesses: number
  candidateSuccesses: number
  cases: number
  baselineSafetyFailures: number
  candidateSafetyFailures: number
  artifact: { path: string; sha256: string }
  mode: "controlled" | "live"
  recordedAt: number
}
export function registerNativeSkill(store: NativeEvidenceStore, text: string): NativeSkillVersion {
  if (!text.trim() || Buffer.byteLength(text) > NATIVE_SKILL_MAX_BYTES)
    throw new Error("Skill text outside bounded contract")
  const value: NativeSkillVersion = {
    version: 1,
    digest: digest(text),
    text,
    contractVersion: NATIVE_SKILL_CONTRACT_VERSION
  }
  const old = store.get<NativeSkillVersion>("skill-version", value.digest)
  if (old && JSON.stringify(old) !== JSON.stringify(value)) throw new Error("Immutable skill snapshot changed")
  if (!old)
    store.commit([{ kind: "skill-version", id: value.digest, value, expectedVersion: 0 }], {
      kind: "skill.registered",
      subject: value.digest,
      value: { contractVersion: value.contractVersion }
    })
  return value
}
/** The caller is an authenticated operator handler, never an agent-facing tool. */
export function bootstrapNativeSkill(
  store: NativeEvidenceStore,
  boardId: string,
  skillDigest: string,
  policyDigest: string,
  authority: NativeHumanAuthority,
  agentIds: readonly string[]
) {
  requireNativeHuman(authority, agentIds)
  if (store.get("active-skill", boardId)) throw new Error("Existing skill requires evaluated promotion")
  if (!store.get<NativeSkillVersion>("skill-version", skillDigest)) throw new Error("Unknown immutable skill")
  store.commit(
    [
      {
        kind: "active-skill",
        id: boardId,
        value: { digest: skillDigest, policyDigest, contractVersion: 1 },
        expectedVersion: 0
      }
    ],
    {
      kind: "skill.bootstrapped",
      subject: boardId,
      value: { digest: skillDigest, policyDigest, operatorId: authority.operatorId, rationale: authority.rationale }
    }
  )
}
export function resolveNativeSkill(
  store: NativeEvidenceStore,
  boardId: string,
  path: string,
  policyDigest: string
): NativeSkillVersion {
  const text = loadNativeSkillText(path)
  const snapshot = registerNativeSkill(store, text)
  const active = store.get<{ digest: string; policyDigest: string; contractVersion: number }>("active-skill", boardId)
  if (!active) throw new Error("Skill requires human bootstrap of its exact immutable digest")
  if (
    active.digest !== snapshot.digest ||
    active.policyDigest !== policyDigest ||
    active.contractVersion !== NATIVE_SKILL_CONTRACT_VERSION
  )
    throw new Error("Skill or policy changed; evaluated human promotion required")
  return snapshot
}
function validateEvaluation(value: NativeSkillEvaluation) {
  if (
    value.version !== 1 ||
    !["benchmark", "injection"].includes(value.kind) ||
    !["controlled", "live"].includes(value.mode) ||
    ![
      value.baselineDigest,
      value.candidateDigest,
      value.policyDigest,
      value.datasetDigest,
      value.artifact.sha256
    ].every((v) => /^[a-f0-9]{64}$/.test(v)) ||
    ![
      value.baselineSuccesses,
      value.candidateSuccesses,
      value.cases,
      value.baselineSafetyFailures,
      value.candidateSafetyFailures
    ].every((n) => Number.isSafeInteger(n) && n >= 0) ||
    value.cases < 1 ||
    value.baselineSuccesses > value.cases ||
    value.candidateSuccesses > value.cases
  )
    throw new Error("Invalid skill evaluation contract")
  if (
    !isAbsolute(value.artifact.path) ||
    !lstatSync(value.artifact.path).isFile() ||
    lstatSync(value.artifact.path).isSymbolicLink()
  )
    throw new Error("Skill evaluation requires a protected regular artifact")
  const bytes = readFileSync(value.artifact.path)
  if (artifactDigest(bytes) !== value.artifact.sha256) throw new Error("Skill evaluation artifact changed")
  const report = JSON.parse(bytes.toString("utf8"))
  for (const key of [
    "version",
    "kind",
    "baselineDigest",
    "candidateDigest",
    "policyDigest",
    "datasetDigest",
    "baselineSuccesses",
    "candidateSuccesses",
    "cases",
    "baselineSafetyFailures",
    "candidateSafetyFailures",
    "mode"
  ] as const)
    if (report[key] !== value[key]) throw new Error("Skill evaluation does not match protected artifact results")
}
export function registerNativeSkillEvaluation(
  store: NativeEvidenceStore,
  value: NativeSkillEvaluation,
  artifactRoot: string,
  authority: NativeHumanAuthority,
  agentIds: readonly string[]
) {
  requireNativeHuman(authority, agentIds)
  const path = relative(realpathSync(artifactRoot), realpathSync(value.artifact.path))
  if (!isAbsolute(artifactRoot) || path.startsWith(`..${sep}`) || path === ".." || isAbsolute(path))
    throw new Error("Evaluation artifact outside protected evaluator root")
  validateEvaluation(value)
  const id = digest(value)
  if (!store.get("skill-evaluation", id))
    store.commit([{ kind: "skill-evaluation", id, value, expectedVersion: 0 }], {
      kind: "skill.evaluated",
      subject: id,
      value: {
        kind: value.kind,
        mode: value.mode,
        candidateDigest: value.candidateDigest,
        operatorId: authority.operatorId,
        rationale: authority.rationale
      }
    })
  return id
}
export function promoteNativeSkill(
  store: NativeEvidenceStore,
  input: { boardId: string; candidateDigest: string; policyDigest: string; evaluationIds: string[] },
  authority: NativeHumanAuthority,
  agentIds: readonly string[]
) {
  requireNativeHuman(authority, agentIds)
  const activeVersion = store.version("active-skill", input.boardId)
  const active = store.get<{ digest: string; policyDigest: string }>("active-skill", input.boardId)
  if (!active || !store.get<NativeSkillVersion>("skill-version", input.candidateDigest))
    throw new Error("Skill baseline/candidate missing")
  const evaluations = input.evaluationIds.map((id) => {
    const value = store.get<NativeSkillEvaluation>("skill-evaluation", id)
    if (!value || digest(value) !== id) throw new Error("Protected skill evaluation missing")
    validateEvaluation(value)
    if (
      value.baselineDigest !== active.digest ||
      value.candidateDigest !== input.candidateDigest ||
      value.policyDigest !== input.policyDigest ||
      value.candidateSafetyFailures !== 0 ||
      value.candidateSuccesses < value.baselineSuccesses
    )
      throw new Error("Skill evaluation identity mismatch or regression")
    return value
  })
  if (!["benchmark", "injection"].every((kind) => evaluations.some((e) => e.kind === kind)))
    throw new Error("Benchmark and injection evaluation required")
  const value = { digest: input.candidateDigest, policyDigest: input.policyDigest, contractVersion: 1 }
  store.commit([{ kind: "active-skill", id: input.boardId, value, expectedVersion: activeVersion }], {
    kind: "skill.promoted",
    subject: input.boardId,
    value: {
      ...value,
      previousDigest: active.digest,
      evaluationIds: input.evaluationIds,
      operatorId: authority.operatorId,
      rationale: authority.rationale
    }
  })
  return value
}
/** Rollback is a fresh operator decision to a previously activated snapshot; original attempts retain their own snapshots. */
export function rollbackNativeSkill(
  store: NativeEvidenceStore,
  boardId: string,
  targetDigest: string,
  authority: NativeHumanAuthority,
  agentIds: readonly string[]
) {
  requireNativeHuman(authority, agentIds)
  const activeVersion = store.version("active-skill", boardId)
  const rows = store.db
    .prepare(
      "SELECT data FROM native_events WHERE subject=? AND kind IN ('skill.bootstrapped','skill.promoted') ORDER BY id"
    )
    .all(boardId)
  const prior = rows.map((row) => JSON.parse(String(row.data))).find((value) => value.digest === targetDigest)
  if (!prior || !store.get("skill-version", targetDigest)) throw new Error("No previously approved skill version")
  store.commit(
    [
      {
        kind: "active-skill",
        id: boardId,
        value: { digest: targetDigest, policyDigest: prior.policyDigest, contractVersion: 1 },
        expectedVersion: activeVersion
      }
    ],
    {
      kind: "skill.rolled-back",
      subject: boardId,
      value: { digest: targetDigest, operatorId: authority.operatorId, rationale: authority.rationale }
    }
  )
}
