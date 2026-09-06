import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import {
  bootstrapNativeSkill,
  type NativeSkillEvaluation,
  promoteNativeSkill,
  registerNativeSkill,
  registerNativeSkillEvaluation,
  resolveNativeSkill,
  rollbackNativeSkill
} from "../packages/core-runtime/src/native/skills.js"
import { NativeEvidenceStore } from "../packages/core-runtime/src/native/store.js"

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn()
})
const operator = { operatorId: "human", rationale: "Reviewed exact instructions and evaluation results" }
const policy = "a".repeat(64)
function setup() {
  const root = mkdtempSync(join(tmpdir(), "native-skills-"))
  const store = new NativeEvidenceStore(join(root, "evidence.db"))
  cleanups.push(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  const base = registerNativeSkill(store, "Keep independent evidence and human approval.")
  const candidate = registerNativeSkill(store, "Keep independent evidence and human approval. Use bounded excerpts.")
  const path = join(root, "SKILL.md")
  writeFileSync(path, base.text)
  return { store, root, path, base, candidate }
}
function evaluations(s: ReturnType<typeof setup>, failure = 0) {
  return (["benchmark", "injection"] as const).map((kind) => {
    const report = {
      version: 1 as const,
      kind,
      baselineDigest: s.base.digest,
      candidateDigest: s.candidate.digest,
      policyDigest: policy,
      datasetDigest: "b".repeat(64),
      baselineSuccesses: 1,
      candidateSuccesses: 1,
      cases: 1,
      baselineSafetyFailures: 0,
      candidateSafetyFailures: failure,
      mode: "controlled" as const
    }
    const path = join(s.root, `${kind}.json`)
    writeFileSync(path, JSON.stringify(report))
    const value: NativeSkillEvaluation = {
      ...report,
      artifact: { path, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") },
      recordedAt: 1
    }
    return registerNativeSkillEvaluation(s.store, value, s.root, operator, ["coder"])
  })
}
it("requires independent bootstrap and pins immutable content against edits", () => {
  const s = setup()
  expect(() => resolveNativeSkill(s.store, "board", s.path, policy)).toThrow(/bootstrap/)
  expect(() =>
    bootstrapNativeSkill(s.store, "board", s.base.digest, policy, { ...operator, operatorId: "coder" }, ["coder"])
  ).toThrow(/Independent/)
  bootstrapNativeSkill(s.store, "board", s.base.digest, policy, operator, ["coder"])
  expect(resolveNativeSkill(s.store, "board", s.path, policy)).toEqual(s.base)
  writeFileSync(s.path, s.candidate.text)
  expect(() => resolveNativeSkill(s.store, "board", s.path, policy)).toThrow(/promotion/)
  expect(s.store.get("skill-version", s.base.digest)).toEqual(s.base)
})
it("promotes only exact benchmark+injection receipts, keeps old snapshots and permits reviewed rollback", () => {
  const s = setup()
  bootstrapNativeSkill(s.store, "board", s.base.digest, policy, operator, ["coder"])
  const ids = evaluations(s)
  expect(() =>
    promoteNativeSkill(
      s.store,
      { boardId: "board", candidateDigest: s.candidate.digest, policyDigest: policy, evaluationIds: ids.slice(0, 1) },
      operator,
      ["coder"]
    )
  ).toThrow(/Benchmark and injection/)
  promoteNativeSkill(
    s.store,
    { boardId: "board", candidateDigest: s.candidate.digest, policyDigest: policy, evaluationIds: ids },
    operator,
    ["coder"]
  )
  writeFileSync(s.path, s.candidate.text)
  expect(resolveNativeSkill(s.store, "board", s.path, policy).digest).toBe(s.candidate.digest)
  rollbackNativeSkill(s.store, "board", s.base.digest, operator, ["coder"])
  writeFileSync(s.path, s.base.text)
  expect(resolveNativeSkill(s.store, "board", s.path, policy).digest).toBe(s.base.digest)
})
it("rejects regression and artifact replacement without promoting instructions", () => {
  const s = setup()
  bootstrapNativeSkill(s.store, "board", s.base.digest, policy, operator, ["coder"])
  const ids = evaluations(s, 1)
  expect(() =>
    promoteNativeSkill(
      s.store,
      { boardId: "board", candidateDigest: s.candidate.digest, policyDigest: policy, evaluationIds: ids },
      operator,
      ["coder"]
    )
  ).toThrow(/regression/)
  const clean = evaluations(s)
  writeFileSync(join(s.root, "injection.json"), "{}")
  expect(() =>
    promoteNativeSkill(
      s.store,
      { boardId: "board", candidateDigest: s.candidate.digest, policyDigest: policy, evaluationIds: clean },
      operator,
      ["coder"]
    )
  ).toThrow(/artifact changed/)
  expect(s.store.get<any>("active-skill", "board").digest).toBe(s.base.digest)
})
