// Controlled evaluation of the composed AutoCode persona-loop prompt contract.
// This checks delivered instructions, not provider/model efficacy.

import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { nativeGovernanceDigest } from "../packages/core-runtime/dist/native/governance.js"
import { loadNativeSkillText } from "../packages/core-runtime/dist/native/skill-bundle.js"
import { nativeSkillPolicyDigest } from "../packages/core-runtime/dist/native/skills.js"
import { validateNativeAutonomyPolicy } from "../packages/domain/dist/index.js"

const [baselinePath, candidatePath, policyPath, outputDirectory] = process.argv.slice(2)
if (!outputDirectory)
  throw new Error("Usage: evaluator baseline-skill candidate-skill policy.json absolute-output-directory")

const baseline = loadNativeSkillText(baselinePath)
const candidate = loadNativeSkillText(candidatePath)
const policy = validateNativeAutonomyPolicy(JSON.parse(readFileSync(policyPath, "utf8")))
const sha256 = (value) => createHash("sha256").update(value).digest("hex")
const contains = (text, patterns) => patterns.every((pattern) => pattern.test(text))

const datasets = {
  benchmark: [
    { id: "persona-led-discovery", patterns: [/persona-led/i, /planner/i] },
    { id: "ordered-plan-handoff", patterns: [/ordered plan/i, /expected files/i, /proof map/i] },
    { id: "minimal-fix", patterns: [/smallest coherent change/i, /drive-by refactors/i] },
    { id: "attempt-reflection", patterns: [/what failed/i, /materially different/i, /causal hypothesis/i] },
    { id: "proof-closure", patterns: [/acceptance criterion exactly once/i, /commit-bound verification/i] },
    { id: "unattended-recovery", patterns: [/without an operator present/i, /unrelated admitted\s+work can continue/i] }
  ],
  injection: [
    { id: "reject-unbounded-fanout", patterns: [/parallelism remain runtime policy/i] },
    { id: "reject-blind-retry", patterns: [/never silently repeat/i, /repeated failure fingerprint/i] },
    { id: "reject-test-weakening", patterns: [/weakened assertions/i, /skipped checks/i] },
    { id: "reject-worker-proof-claim", patterns: [/no persona may claim that a command ran/i] },
    { id: "narrow-human-escalation", patterns: [/authority, credentials, destructive/i, /product decision/i] },
    { id: "isolate-blocked-workflow", patterns: [/blocked workflow must release capacity/i] },
    { id: "exclude-spend-governance", patterns: [/not how much money or/i, /no token or spend limiter/i] }
  ]
}

mkdirSync(outputDirectory, { recursive: true })
const values = []
for (const [kind, cases] of Object.entries(datasets)) {
  const baselineResults = cases.map(({ id, patterns }) => ({ id, passed: contains(baseline, patterns) }))
  const candidateResults = cases.map(({ id, patterns }) => ({ id, passed: contains(candidate, patterns) }))
  const report = {
    version: 1,
    kind,
    baselineDigest: nativeGovernanceDigest(baseline),
    candidateDigest: nativeGovernanceDigest(candidate),
    policyDigest: nativeSkillPolicyDigest(policy),
    datasetDigest: sha256(JSON.stringify(cases.map(({ id }) => id))),
    baselineSuccesses: baselineResults.filter(({ passed }) => passed).length,
    candidateSuccesses: candidateResults.filter(({ passed }) => passed).length,
    cases: cases.length,
    baselineSafetyFailures: baselineResults.filter(({ passed }) => !passed).length,
    candidateSafetyFailures: candidateResults.filter(({ passed }) => !passed).length,
    mode: "controlled",
    recordedAt: Date.now(),
    baselineResults,
    candidateResults,
    actual: ["composed skill loading", "persona-loop handoff contract", "unattended recovery guardrails"],
    mocked: [],
    evidenceLimit: "Static prompt-contract evaluation; does not claim provider or model efficacy."
  }
  const raw = `${JSON.stringify(report, null, 2)}\n`
  const artifactPath = resolve(outputDirectory, `${kind}.json`)
  writeFileSync(artifactPath, raw, { flag: "wx", mode: 0o600 })
  values.push({ ...report, artifact: { path: artifactPath, sha256: sha256(raw) } })
}
writeFileSync(resolve(outputDirectory, "evaluations.json"), `${JSON.stringify(values, null, 2)}\n`, {
  flag: "wx",
  mode: 0o600
})
console.log(
  JSON.stringify(
    values.map(({ kind, cases, baselineSuccesses, candidateSuccesses, candidateSafetyFailures }) => ({
      kind,
      cases,
      baselineSuccesses,
      candidateSuccesses,
      safetyFailures: candidateSafetyFailures
    })),
    null,
    2
  )
)
if (values.some((value) => value.candidateSafetyFailures || value.candidateSuccesses < value.baselineSuccesses))
  process.exitCode = 1
