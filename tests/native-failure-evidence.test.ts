import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { NativeAutonomyPolicy, NativeReceiptProvenance, NativeVerificationEvidence } from "@openclaw/domain"
import { nativePolicyDigest } from "@openclaw/domain"
import { afterEach, expect, it } from "vitest"
import { nativeFailureEvidence } from "../packages/core-runtime/src/native/failure-evidence.js"
import { nativeContentDigest, nativeRepositoryIdentity } from "../packages/core-runtime/src/native/provenance.js"

const cleanup: string[] = []
afterEach(() => {
  for (const p of cleanup.splice(0)) rmSync(p, { recursive: true, force: true })
})
function fixture(stdout = "actual hidden button locator failure", stderr = "") {
  const repository = mkdtempSync(join(tmpdir(), "native-failure-context-"))
  cleanup.push(repository)
  const policy = { repository, mode: "implement-human-review" } as NativeAutonomyPolicy
  const expected = { workflowId: "workflow", attemptId: "attempt:7", skillDigest: nativeContentDigest("skill") }
  const headSha = "a".repeat(40),
    baseSha = "b".repeat(40),
    policyDigest = nativePolicyDigest(policy)
  const root = join(
    repository,
    ".openclaw/native-artifacts",
    expected.workflowId,
    headSha,
    nativeContentDigest(expected.attemptId),
    policyDigest
  )
  mkdirSync(root, { recursive: true })
  const artifact = join(root, "0-command.json")
  const receipt = {
    argv: ["/opt/openclaw/checks/required-browser"],
    cwd: repository,
    startedAt: "2026-10-01T00:00:00Z",
    finishedAt: "2026-10-01T00:00:01Z",
    exitCode: 1,
    outcome: "nonzero",
    stdout,
    stderr
  }
  writeFileSync(artifact, JSON.stringify(receipt))
  const check = {
    ruleId: "required-browser",
    argv: receipt.argv,
    cwd: repository,
    startedAt: receipt.startedAt,
    finishedAt: receipt.finishedAt,
    exitCode: 1,
    artifact,
    artifactSha256: nativeContentDigest(readFileSync(artifact))
  }
  const provenance: NativeReceiptProvenance = {
    version: 1,
    ...expected,
    repositoryId: nativeRepositoryIdentity(policy),
    baseSha,
    headSha,
    diffDigest: "c".repeat(64),
    policyDigest,
    policySnapshot: policy,
    executionId: "run",
    agentId: "coder",
    sessionKey: "assigned",
    checkIds: [check.ruleId],
    toolchain: { node: "24", git: "2", platform: "linux", arch: "x64", sandbox: "docker" },
    artifacts: [{ ruleId: check.ruleId, path: artifact, sha256: check.artifactSha256 }]
  }
  const evidence: NativeVerificationEvidence = {
    baseSha,
    headSha,
    plan: { policyDigest, ruleIds: [check.ruleId], coverage: [], exemptions: [], uncoveredPaths: [] },
    checks: [check],
    provenance
  }
  const seal = () => {
    provenance.artifacts = evidence.checks.map((c) => ({
      ruleId: c.ruleId,
      path: c.artifact,
      sha256: c.artifactSha256!
    }))
    const path = join(root, "receipt-provenance.json")
    writeFileSync(path, JSON.stringify(provenance))
    evidence.provenanceArtifact = { path, sha256: nativeContentDigest(readFileSync(path)) }
  }
  seal()
  return { repository, policy, expected, root, artifact, receipt, evidence, seal }
}
it("projects actual failed logs with immutable provenance into context without a workspace grant", () => {
  const f = fixture()
  const result = nativeFailureEvidence(f.policy, f.evidence, f.expected) as any[]
  expect(result).toHaveLength(1)
  expect(result[0]).toMatchObject({
    ruleId: "required-browser",
    exitCode: 1,
    artifactSha256: f.evidence.checks[0]!.artifactSha256,
    stdout: { content: f.receipt.stdout, truncated: false },
    stderr: { content: "", truncated: false }
  })
  expect(result[0].trust).toContain("Untrusted")
  expect(result[0].headSha).toBe(f.evidence.headSha)
})
it("bounds large logs and keeps both beginning and end without claiming full output", () => {
  const f = fixture("FIRST" + "x".repeat(80000) + "LAST")
  const result = nativeFailureEvidence(f.policy, f.evidence, f.expected) as any[]
  expect(result[0].stdout.truncated).toBe(true)
  expect(result[0].stdout.content).toContain("FIRST")
  expect(result[0].stdout.content).toContain("LAST")
  expect(Buffer.byteLength(result[0].stdout.content) + Buffer.byteLength(result[0].stderr.content)).toBeLessThanOrEqual(
    32000
  )
})
it("refuses changed artifact bytes instead of delivering untrusted replacements", () => {
  const f = fixture()
  writeFileSync(f.artifact, JSON.stringify({ ...f.receipt, stdout: "replacement" }))
  expect(() => nativeFailureEvidence(f.policy, f.evidence, f.expected)).toThrow()
})
it("refuses a foreign attempt", () => {
  const f = fixture()
  expect(() => nativeFailureEvidence(f.policy, f.evidence, { ...f.expected, attemptId: "attempt:8" })).toThrow()
})
it("refuses a receipt from outside the canonical attempt artifact directory even with matching hashes", () => {
  const f = fixture(),
    outside = join(f.repository, "outside.json")
  writeFileSync(outside, JSON.stringify(f.receipt))
  f.evidence.checks[0]!.artifact = outside
  f.seal()
  expect(() => nativeFailureEvidence(f.policy, f.evidence, f.expected)).toThrow()
})
it("refuses a symlinked artifact", () => {
  const f = fixture(),
    original = join(f.root, "original.json")
  writeFileSync(original, readFileSync(f.artifact))
  rmSync(f.artifact)
  symlinkSync(original, f.artifact)
  expect(() => nativeFailureEvidence(f.policy, f.evidence, f.expected)).toThrow()
})
it("refuses inconsistent exit or command metadata even when its new bytes are resealed", () => {
  const f = fixture()
  writeFileSync(f.artifact, JSON.stringify({ ...f.receipt, exitCode: 0 }))
  f.evidence.checks[0]!.artifactSha256 = nativeContentDigest(readFileSync(f.artifact))
  f.seal()
  expect(() => nativeFailureEvidence(f.policy, f.evidence, f.expected)).toThrow()
})
it("redacts secrets before putting command output in model context", () => {
  const secret = "sk-abcdefghijklmnopqrstuv",
    f = fixture(`Locator failed; api_key=${secret}`)
  const result = nativeFailureEvidence(f.policy, f.evidence, f.expected) as any[]
  expect(result[0].stdout.redacted).toBe(true)
  expect(JSON.stringify(result)).not.toContain(secret)
  expect(result[0].stdout.content).toContain("Locator failed")
})
it("rejects a redirected artifact directory", () => {
  const f = fixture(),
    moved = f.root + "-original"
  const original = readFileSync(f.artifact),
    provenance = readFileSync(f.evidence.provenanceArtifact!.path)
  rmSync(f.root, { recursive: true })
  mkdirSync(moved)
  writeFileSync(join(moved, "0-command.json"), original)
  writeFileSync(join(moved, "receipt-provenance.json"), provenance)
  symlinkSync(moved, f.root)
  expect(() => nativeFailureEvidence(f.policy, f.evidence, f.expected)).toThrow()
})
it("does not read artifacts when a design repair has no failed command", () => {
  const f = fixture()
  f.evidence.checks[0]!.exitCode = 0
  expect(nativeFailureEvidence(f.policy, f.evidence, f.expected)).toEqual([])
  expect(nativeFailureEvidence(f.policy, undefined, f.expected)).toEqual([])
})
