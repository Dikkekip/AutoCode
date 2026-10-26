import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, expect, it } from "vitest"
import { loadNativeSkillText } from "../packages/core-runtime/src/native/skill-bundle.js"
import {
  bootstrapNativeSkill,
  nativeSkillPolicyDigest,
  promoteNativeSkill,
  registerNativeSkill,
  registerNativeSkillEvaluation
} from "../packages/core-runtime/src/native/skills.js"
import { NativeEvidenceStore } from "../packages/core-runtime/src/native/store.js"
import { validateNativeAutonomyPolicy } from "../packages/domain/src/native-autonomy.js"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture(bundled = true) {
  const root = mkdtempSync(join(tmpdir(), "native-review-evaluator-"))
  roots.push(root)
  const skillPath = join(root, "SKILL.md")
  writeFileSync(skillPath, "Investigate with evidence.")
  if (bundled) {
    writeFileSync(join(root, "review.md"), "Preserve independent review and exact evidence.")
    writeFileSync(`${skillPath}.bundle.json`, JSON.stringify({ version: 1, resources: ["review.md"] }))
  }
  const baseline = validateNativeAutonomyPolicy({
    version: 1,
    enabled: false,
    boardId: "evaluator",
    repository: root,
    repositoryKind: "application",
    baseBranch: "main",
    plannerAgentId: "planner",
    coderAgentId: "coder",
    reviewerAgentId: "reviewer",
    quality: { skillPath },
    personas: [{ personaId: "research", goals: ["g"], successObservations: ["s"], allowedPaths: ["src"] }],
    verification: [{ id: "trusted", argv: ["/opt/openclaw/checks/trusted"], cwd: ".", timeoutSeconds: 10 }],
    verificationAuthority: {
      reviewedRevision: "d".repeat(40),
      independentCandidateReview: true,
      acceptance: [{ criterion: "Works", ruleIds: ["trusted"] }]
    }
  })
  const candidate = structuredClone(baseline)
  candidate.verification[0]!.timeoutSeconds++
  const run = () => {
    const before = join(root, "baseline.json"),
      after = join(root, "candidate.json")
    writeFileSync(before, JSON.stringify(baseline))
    writeFileSync(after, JSON.stringify(candidate))
    execFileSync(
      process.execPath,
      [
        fileURLToPath(new URL("../scripts/evaluate-native-review-policy.mjs", import.meta.url)),
        before,
        after,
        join(root, "reports")
      ],
      { stdio: "pipe", timeout: 30_000 }
    )
    return JSON.parse(readFileSync(join(root, "reports/evaluations.json"), "utf8"))
  }
  return { root, skillPath, baseline, candidate, run }
}

it.each([true, false])("promotes CLI evidence for the registered production skill snapshot (bundle=%s)", (bundled) => {
  const f = fixture(bundled),
    reports = f.run()
  const store = new NativeEvidenceStore(join(f.root, "evidence.db"))
  const human = { operatorId: "operator", rationale: "Controlled unchanged-skill policy evaluation" }
  try {
    const snapshot = registerNativeSkill(store, loadNativeSkillText(f.skillPath))
    bootstrapNativeSkill(store, f.baseline.boardId, snapshot.digest, nativeSkillPolicyDigest(f.baseline), human, [
      "coder"
    ])
    expect(reports.map((r: any) => [r.kind, r.cases, r.candidateSafetyFailures])).toEqual([
      ["benchmark", 4, 0],
      ["injection", 8, 0]
    ])
    const evaluationIds = reports.map((report: any) =>
      registerNativeSkillEvaluation(store, report, f.root, human, ["coder"])
    )
    expect(
      promoteNativeSkill(
        store,
        {
          boardId: f.candidate.boardId,
          candidateDigest: snapshot.digest,
          policyDigest: nativeSkillPolicyDigest(f.candidate),
          evaluationIds
        },
        human,
        ["coder"]
      )
    ).toMatchObject({ digest: snapshot.digest, policyDigest: nativeSkillPolicyDigest(f.candidate) })
  } finally {
    store.close()
  }
})

it("refuses changed bundle resources even when both entry files match", () => {
  const f = fixture()
  const other = join(f.root, "other")
  mkdirSync(other)
  writeFileSync(join(other, "SKILL.md"), readFileSync(f.skillPath))
  writeFileSync(join(other, "SKILL.md.bundle.json"), JSON.stringify({ version: 1, resources: ["review.md"] }))
  writeFileSync(join(other, "review.md"), "Changed review instructions.")
  f.candidate.quality!.skillPath = join(other, "SKILL.md")
  expect(f.run).toThrow(/unchanged skill/)
})
