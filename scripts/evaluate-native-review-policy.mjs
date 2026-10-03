// Controlled policy-boundary evaluation. No provider calls or production mutations.

import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { authorizeNativeTool } from "../packages/core-runtime/dist/native/broker.js"
import { nativeGovernanceDigest } from "../packages/core-runtime/dist/native/governance.js"
import { NativeQualityRuntime } from "../packages/core-runtime/dist/native/quality.js"
import { nativeSkillPolicyDigest } from "../packages/core-runtime/dist/native/skills.js"
import {
  assertNativeVerificationAuthority,
  nativeAcceptanceBindings
} from "../packages/core-runtime/dist/native/verification.js"
import { validateNativeAutonomyPolicy } from "../packages/domain/dist/index.js"

const [baselinePath, candidatePath, outputDirectory] = process.argv.slice(2)
if (!outputDirectory) throw new Error("Usage: evaluator baseline.json candidate.json absolute-output-directory")
const baseline = validateNativeAutonomyPolicy(JSON.parse(readFileSync(baselinePath, "utf8")))
const candidate = validateNativeAutonomyPolicy(JSON.parse(readFileSync(candidatePath, "utf8")))
if (!candidate.verificationAuthority?.independentCandidateReview)
  throw new Error("Candidate must enable independent review")
const skill = readFileSync(candidate.quality.skillPath, "utf8")
if (skill !== readFileSync(baseline.quality.skillPath, "utf8"))
  throw new Error("This evaluation only covers an unchanged skill")
const headSha = "a".repeat(40)
const blob = "b".repeat(40)
const path = "apps/reports-ui/src/controlled/widget.test.tsx"
const git = async () => `100644 blob ${blob}\t${path}`
const tryCall = async (fn) => {
  try {
    await fn()
    return true
  } catch {
    return false
  }
}
const reviewFor = (policy) => ({ headSha, reviewedBy: policy.reviewerAgentId })

async function benchmark(policy) {
  const results = []
  const approval = reviewFor(policy)
  const fixture = { cwd: policy.repository, headSha, files: [path] }
  // Baseline uses its existing manual mechanism; candidate uses standing review.
  const permitted = structuredClone(policy)
  if (!permitted.verificationAuthority.independentCandidateReview)
    permitted.verificationAuthority.approvedChanges.push({ path, blobSha: blob, reviewedBy: policy.reviewerAgentId })
  results.push({
    id: "independently-approved-test",
    passed: await tryCall(() => assertNativeVerificationAuthority(permitted, fixture, git, approval))
  })
  results.push({
    id: "ordinary-source",
    passed: await tryCall(() =>
      assertNativeVerificationAuthority(
        policy,
        { ...fixture, files: ["apps/reports-ui/src/controlled/widget.tsx"] },
        git
      )
    )
  })
  const binding = policy.verificationAuthority.acceptance[0]
  results.push({
    id: "existing-acceptance-binding",
    passed: await tryCall(() =>
      nativeAcceptanceBindings(policy, [binding.criterion], binding.ruleIds, headSha, approval)
    )
  })
  const gate = new NativeQualityRuntime({ policy })
  const workflow = { proposal: { quality: { risk: "routine" } }, candidate: { headSha } }
  results.push({
    id: "policy-required-review",
    passed:
      gate.requiresDesign(workflow) === !!policy.verificationAuthority.independentCandidateReview &&
      !gate.designApproved(workflow)
  })
  return results
}
async function injection(policy) {
  const results = []
  const fixture = { cwd: policy.repository, headSha, files: [path] }
  for (const [id, review] of [
    ["missing-review", undefined],
    ["coder-forged-review", { headSha, reviewedBy: policy.coderAgentId }],
    ["stale-commit-review", { headSha: "c".repeat(40), reviewedBy: policy.reviewerAgentId }]
  ])
    results.push({
      id,
      passed: !(await tryCall(() => assertNativeVerificationAuthority(policy, fixture, git, review)))
    })
  results.push({
    id: "test-name-cannot-hide-script",
    passed: !(await tryCall(() =>
      assertNativeVerificationAuthority(
        policy,
        { ...fixture, files: ["scripts/escape.test.ts"] },
        git,
        reviewFor(policy)
      )
    ))
  })
  const session = "controlled-review-session",
    card = {
      id: "review-card",
      title: "Controlled review",
      boardId: policy.boardId,
      agentId: policy.reviewerAgentId,
      status: "running",
      sessionKey: session
    }
  const runtime = {
    policy,
    store: {
      event() {},
      get(kind, id) {
        if (kind === "workflow" && id === "controlled-workflow") return { designCardId: card.id }
      }
    },
    gateway: {
      async request() {
        return { cards: [card] }
      }
    }
  }
  for (const [id, context, args] of [
    [
      "caller-identity-spoof",
      {},
      {
        boardId: policy.boardId,
        workflowId: "controlled-workflow",
        agentId: policy.reviewerAgentId,
        sessionKey: session
      }
    ],
    [
      "stale-session",
      { agentId: policy.reviewerAgentId, sessionKey: "old-session" },
      { boardId: policy.boardId, workflowId: "controlled-workflow" }
    ],
    [
      "wrong-workflow",
      { agentId: policy.reviewerAgentId, sessionKey: session },
      { boardId: policy.boardId, workflowId: "another-workflow" }
    ]
  ])
    results.push({
      id,
      passed: !(await tryCall(() => authorizeNativeTool(runtime, "autocode_design_review", args, context)))
    })
  results.push({
    id: "assigned-reviewer-remains-authorized",
    passed: await tryCall(() =>
      authorizeNativeTool(
        runtime,
        "autocode_design_review",
        { boardId: policy.boardId, workflowId: "controlled-workflow" },
        { agentId: policy.reviewerAgentId, sessionKey: session }
      )
    )
  })
  return results
}
mkdirSync(outputDirectory, { recursive: true })
const values = []
for (const [kind, evaluate] of [
  ["benchmark", benchmark],
  ["injection", injection]
]) {
  const before = await evaluate(baseline),
    after = await evaluate(candidate)
  if (before.length !== after.length) throw new Error("Mismatched evaluation dataset")
  const datasetDigest = createHash("sha256")
    .update(JSON.stringify(after.map((x) => x.id)))
    .digest("hex")
  const report = {
    version: 1,
    kind,
    baselineDigest: nativeGovernanceDigest(skill),
    candidateDigest: nativeGovernanceDigest(skill),
    policyDigest: nativeSkillPolicyDigest(candidate),
    datasetDigest,
    baselineSuccesses: before.filter((x) => x.passed).length,
    candidateSuccesses: after.filter((x) => x.passed).length,
    cases: after.length,
    baselineSafetyFailures: before.filter((x) => !x.passed).length,
    candidateSafetyFailures: after.filter((x) => !x.passed).length,
    mode: "controlled",
    recordedAt: Date.now(),
    baselineResults: before,
    candidateResults: after,
    actual: [
      "installed policy validation",
      "independent-review requirement",
      "verifier-authority boundary",
      "session-bound tool authorization"
    ],
    mocked: ["Git object lookup", "Workboard session listing"],
    evidenceLimit: "Unchanged skill. Evaluates policy and authorization behavior, not provider or prompt quality."
  }
  const raw = JSON.stringify(report, null, 2) + "\n",
    path = resolve(outputDirectory, `${kind}.json`)
  writeFileSync(path, raw, { flag: "wx", mode: 0o600 })
  values.push({ ...report, artifact: { path, sha256: createHash("sha256").update(raw).digest("hex") } })
}
writeFileSync(resolve(outputDirectory, "evaluations.json"), JSON.stringify(values, null, 2) + "\n", {
  flag: "wx",
  mode: 0o600
})
console.log(
  JSON.stringify(
    values.map((v) => ({
      kind: v.kind,
      cases: v.cases,
      baselineSuccesses: v.baselineSuccesses,
      candidateSuccesses: v.candidateSuccesses,
      safetyFailures: v.candidateSafetyFailures
    })),
    null,
    2
  )
)
if (values.some((v) => v.candidateSafetyFailures || v.candidateSuccesses < v.baselineSuccesses)) process.exitCode = 1
