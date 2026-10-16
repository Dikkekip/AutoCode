import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type NativeAutonomyPolicy, type NativeVerificationEvidence, nativePolicyDigest } from "@openclaw/domain"
import { afterEach, expect, it } from "vitest"
import { nativeContentDigest, nativeRepositoryIdentity } from "../packages/core-runtime/src/native/provenance.js"
import { nativeResearchFailureEvidence } from "../packages/core-runtime/src/native/research-failure-evidence.js"
import type { NativeWorkflow } from "../packages/core-runtime/src/native/runtime.js"

const repositories: string[] = []
afterEach(() => {
  for (const path of repositories.splice(0)) rmSync(path, { recursive: true, force: true })
})
function fixture() {
  const repository = mkdtempSync(join(tmpdir(), "native-research-failures-"))
  repositories.push(repository)
  const git = (...args: string[]) => execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" }).trim()
  git("init", "-q")
  git("config", "user.name", "Fixture")
  git("config", "user.email", "fixture@example.test")
  mkdirSync(join(repository, "src"))
  writeFileSync(join(repository, "src/view.ts"), "export const view = 'baseline'\n")
  writeFileSync(join(repository, "src/navigation.ts"), "export const navigation = 'unchanged'\n")
  git("add", ".")
  git("commit", "-qm", "baseline")
  const baseSha = git("rev-parse", "HEAD")
  writeFileSync(join(repository, "src/view.ts"), "export const view = 'candidate'\n")
  git("commit", "-qam", "candidate")
  const headSha = git("rev-parse", "HEAD")
  const policy = {
    repository,
    mode: "implement-human-review",
    personas: [{ personaId: "ui", allowedPaths: ["src/**"] }]
  } as NativeAutonomyPolicy
  const skillHash = nativeContentDigest("skill"),
    attemptId = "workflow:attempt:2",
    policyDigest = nativePolicyDigest(policy)
  const root = join(
    repository,
    ".openclaw/native-artifacts/workflow",
    headSha,
    nativeContentDigest(attemptId),
    policyDigest
  )
  mkdirSync(root, { recursive: true })
  const artifact = join(root, "browser.json")
  const receipt = {
    argv: ["required-browser"],
    cwd: repository,
    startedAt: "2026-10-01T00:00:00Z",
    finishedAt: "2026-10-01T00:00:01Z",
    exitCode: 1,
    stdout: "navigation assertion failed",
    stderr: ""
  }
  writeFileSync(artifact, JSON.stringify(receipt))
  const check = { ruleId: "browser", ...receipt, artifact, artifactSha256: nativeContentDigest(readFileSync(artifact)) }
  const evidence: NativeVerificationEvidence = {
    baseSha,
    headSha,
    plan: { policyDigest, ruleIds: ["browser"], coverage: [], exemptions: [], uncoveredPaths: [] },
    checks: [check],
    provenance: {
      version: 1,
      workflowId: "workflow",
      attemptId,
      skillDigest: skillHash,
      repositoryId: nativeRepositoryIdentity(policy),
      baseSha,
      headSha,
      diffDigest: "c".repeat(64),
      policyDigest,
      policySnapshot: policy,
      executionId: "verification-run",
      agentId: "verifier",
      sessionKey: "assigned",
      checkIds: ["browser"],
      toolchain: { node: "24", git: "2", platform: "linux", arch: "x64", sandbox: "docker" },
      artifacts: [{ ruleId: "browser", path: artifact, sha256: check.artifactSha256 }]
    }
  }
  const seal = () => {
    const path = join(root, "receipt-provenance.json")
    writeFileSync(path, JSON.stringify(evidence.provenance))
    evidence.provenanceArtifact = { path, sha256: nativeContentDigest(readFileSync(path)) }
  }
  seal()
  const workflow = {
    proposal: { personaId: "ui", allowedPaths: ["src/view.ts"], implementationPrompt: "fix", quality: { skillHash } },
    lifecycle: { state: "blocked", attemptId },
    candidate: { baseSha, headSha, files: ["src/view.ts"] },
    verification: evidence
  } as NativeWorkflow
  const records = [{ id: "workflow", value: workflow, updatedAt: 10 }]
  const read = (paths?: string[]) => nativeResearchFailureEvidence(policy, "ui", baseSha, records, paths)
  return { repository, git, baseSha, headSha, policy, artifact, evidence, workflow, records, read, seal }
}

it("projects only validated historical candidate failures and exact changed/unchanged source bindings", async () => {
  const f = fixture(),
    results = await f.read(["src/view.ts", "src/navigation.ts"])
  expect(results).toHaveLength(1)
  expect(results[0]).toMatchObject({
    status: "available",
    headSha: f.headSha,
    baseSha: f.baseSha,
    investigationRevision: f.baseSha,
    applicability: "historical-candidate-only",
    changedCandidatePaths: ["src/view.ts"],
    failures: [{ exitCode: 1, stdout: { content: "navigation assertion failed" } }]
  })
  if (results[0]?.status !== "available") throw new Error("Expected protected historical evidence")
  expect(results[0].sourceBindings).toEqual([
    {
      path: "src/view.ts",
      candidateBlob: f.git("rev-parse", `${f.headSha}:src/view.ts`),
      investigationBlob: f.git("rev-parse", `${f.baseSha}:src/view.ts`),
      unchanged: false
    },
    {
      path: "src/navigation.ts",
      candidateBlob: f.git("rev-parse", `${f.headSha}:src/navigation.ts`),
      investigationBlob: f.git("rev-parse", `${f.baseSha}:src/navigation.ts`),
      unchanged: true
    }
  ])
  expect(results[0].instruction).toContain("other candidate changes may affect behavior")
  expect(JSON.stringify(results)).not.toContain(f.repository)
})

it("does not read a different persona's artifacts", async () => {
  const f = fixture()
  f.workflow.proposal.personaId = "other"
  rmSync(f.artifact)
  expect(await f.read()).toEqual([])
})

it("does not expose candidates with any changed file outside persona scope", async () => {
  const f = fixture()
  f.workflow.candidate!.files.push("private/other.ts")
  expect(await f.read()).toEqual([])
})

it("leaves in-progress verification unavailable even if partial failures exist", async () => {
  const f = fixture()
  f.workflow.lifecycle!.state = "verification"
  expect(await f.read()).toEqual([])
})

it.each([
  "missing-provenance",
  "wrong-head",
  "wrong-base",
  "wrong-attempt",
  "changed-artifact",
  "stale-policy"
])("fails closed without stopping discovery: %s", async (scenario) => {
  const f = fixture()
  if (scenario === "missing-provenance") delete f.evidence.provenanceArtifact
  if (scenario === "wrong-head") f.workflow.candidate!.headSha = f.baseSha
  if (scenario === "wrong-base") f.workflow.candidate!.baseSha = f.headSha
  if (scenario === "wrong-attempt") f.workflow.lifecycle!.attemptId = "another-attempt"
  if (scenario === "changed-artifact") writeFileSync(f.artifact, "replacement")
  if (scenario === "stale-policy") f.policy.mode = "application-release"
  expect(await f.read()).toEqual([
    { status: "unavailable", workflowId: "workflow", reason: "Canonical failure evidence could not be validated" }
  ])
})

it.each([
  ["private/secret.ts"],
  ["src/../private/secret.ts"],
  ["src"],
  ["src/missing.ts"],
  Array.from({ length: 21 }, (_, i) => `src/file${i}.ts`)
])("refuses unsafe, untracked or excessive requested source paths: %j", async (...args) => {
  const f = fixture(),
    paths = args as string[]
  expect((await f.read(paths))[0]?.status).toBe("unavailable")
})

it("caps projection at one recent failed candidate and never includes successful artifacts", async () => {
  const f = fixture()
  f.records.push({ ...f.records[0]!, updatedAt: 9 })
  expect(await f.read()).toHaveLength(1)
  f.evidence.checks[0]!.exitCode = 0
  expect(await f.read()).toEqual([])
})
