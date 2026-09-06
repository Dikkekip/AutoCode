// Trusted receipt and verifier-authority regression fixtures. Artifacts are created by the test parent.
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import {
  assertNativeVerificationAuthority,
  assertNativeVerificationEvidence,
  planNativeVerification,
  runNativeDeploymentCommand
} from "../packages/core-runtime/src/native/verification.js"
import { validateNativeAutonomyPolicy } from "../packages/domain/src/native-autonomy.js"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "native-authority-"))
  roots.push(root)
  const policy = validateNativeAutonomyPolicy({
    version: 1,
    enabled: false,
    boardId: "board",
    repository: root,
    repositoryKind: "application",
    baseBranch: "main",
    plannerAgentId: "planner",
    coderAgentId: "coder",
    reviewerAgentId: "reviewer",
    personas: [{ personaId: "p", goals: ["g"], successObservations: ["s"], allowedPaths: ["."], weight: 1 }],
    verification: [{ id: "trusted", argv: ["/opt/openclaw/checks/acceptance"], cwd: "." }],
    verificationAuthority: {
      reviewedRevision: "d".repeat(40),
      acceptance: [{ criterion: "Works", ruleIds: ["trusted"] }]
    }
  })
  const candidate = { cwd: root, headSha: "a".repeat(40), baseSha: "b".repeat(40), files: ["src/index.ts"] }
  const artifact = join(root, "check.json"),
    contents = JSON.stringify({ exitCode: 0, startedAt: "start", finishedAt: "end" })
  writeFileSync(artifact, contents)
  const evidence = {
    headSha: candidate.headSha,
    baseSha: candidate.baseSha,
    plan: planNativeVerification(policy, candidate.files),
    acceptance: [{ criterion: "Works", ruleIds: ["trusted"] }],
    checks: [
      {
        ruleId: "trusted",
        argv: ["/opt/openclaw/checks/acceptance"],
        cwd: root,
        artifact,
        artifactSha256: createHash("sha256").update(contents).digest("hex"),
        startedAt: "start",
        finishedAt: "end",
        exitCode: 0
      }
    ]
  }
  return { policy, candidate, evidence, artifact }
}
it("validates exact reviewed policy, acceptance and parent receipt; rejects stale policy and tampering", () => {
  const s = fixture()
  expect(() => assertNativeVerificationEvidence(s.policy, s.candidate, s.evidence, ["Works"])).not.toThrow()
  s.policy.verification[0]!.timeoutSeconds += 1
  expect(() => assertNativeVerificationEvidence(s.policy, s.candidate, s.evidence, ["Works"])).toThrow("current policy")
  s.policy.verification[0]!.timeoutSeconds -= 1
  writeFileSync(s.artifact, '{"exitCode":0}')
  expect(() => assertNativeVerificationEvidence(s.policy, s.candidate, s.evidence, ["Works"])).toThrow("integrity")
})
it("rejects missing acceptance checks and mismatched candidate revisions", () => {
  const s = fixture()
  expect(() => assertNativeVerificationEvidence(s.policy, s.candidate, s.evidence, ["Unbound"])).toThrow("binding")
  s.candidate.headSha = "e".repeat(40)
  expect(() => assertNativeVerificationEvidence(s.policy, s.candidate, s.evidence, ["Works"])).toThrow("current policy")
})
it("rejects candidate scripts, and requires independent blob approval for legitimate test maintenance", async () => {
  const s = fixture()
  s.policy.verification[0]!.argv = ["npm", "test"]
  await expect(assertNativeVerificationAuthority(s.policy, s.candidate)).rejects.toThrow("administrator-owned")
  s.policy.verification[0]!.argv = ["/opt/openclaw/checks/acceptance"]
  s.candidate.files = ["tests/auth.test.ts"]
  const blob = "f".repeat(40),
    git = async () => `100644 blob ${blob}\ttests/auth.test.ts`
  await expect(assertNativeVerificationAuthority(s.policy, s.candidate, git)).rejects.toThrow("independent")
  s.policy.verificationAuthority!.approvedChanges = [
    { path: "tests/auth.test.ts", blobSha: blob, reviewedBy: "reviewer" }
  ]
  await expect(assertNativeVerificationAuthority(s.policy, s.candidate, git)).resolves.toBeUndefined()
  s.policy.verificationAuthority!.approvedChanges[0]!.reviewedBy = "coder"
  await expect(assertNativeVerificationAuthority(s.policy, s.candidate, git)).rejects.toThrow("independent")
})

it("binds explicitly reviewed manual evidence to the exact revision and artifact", () => {
  const s = fixture()
  const manual = join(s.candidate.cwd, "manual.txt"),
    content = "Observed representative workflow with independent review"
  writeFileSync(manual, content)
  const binding = {
    criterion: "Works",
    ruleIds: [] as string[],
    manualEvidence: {
      artifact: manual,
      sha256: createHash("sha256").update(content).digest("hex"),
      reviewedBy: "reviewer",
      headSha: s.candidate.headSha
    }
  }
  s.policy.verificationAuthority!.acceptance = [binding]
  s.evidence.plan = planNativeVerification(s.policy, s.candidate.files)
  s.evidence.acceptance = [binding]
  expect(() => assertNativeVerificationEvidence(s.policy, s.candidate, s.evidence, ["Works"])).not.toThrow()
  writeFileSync(manual, "changed")
  expect(() => assertNativeVerificationEvidence(s.policy, s.candidate, s.evidence, ["Works"])).toThrow("integrity")
})

it("redacts command arguments in both persisted and returned command metadata", async () => {
  const s = fixture()
  const secret = "synthetic-unrecognized-password"
  const result = await runNativeDeploymentCommand(
    { argv: [process.execPath, "-e", "process.exit(0)", secret], cwd: ".", timeoutSeconds: 5 },
    s.candidate.cwd,
    join(s.candidate.cwd, "deployment.json"),
    {},
    { authorized: true }
  )
  expect(JSON.stringify(result.argv)).not.toContain(secret)
  expect(readFileSync(result.artifact, "utf8")).not.toContain(secret)
})

it("records cancellation as an unknown external outcome without launching deployment", async () => {
  const s = fixture(),
    controller = new AbortController()
  controller.abort()
  const result = await runNativeDeploymentCommand(
    { argv: [process.execPath, "-e", "throw new Error('must not launch')"], cwd: ".", timeoutSeconds: 5 },
    s.candidate.cwd,
    join(s.candidate.cwd, "cancelled.json"),
    {},
    { authorized: true },
    controller.signal
  )
  expect(result.exitCode).toBeNull()
  expect(result.outcome).toBe("cancelled")
  expect(JSON.parse(readFileSync(result.artifact, "utf8")).outcome).toBe("cancelled")
})
