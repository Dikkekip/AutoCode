import { chmodSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { nativePolicyDigest, nativeVerificationRuleId, validateNativeAutonomyPolicy } from "@openclaw/domain"
import { afterEach, expect, it, vi } from "vitest"

const execute = vi.hoisted(() => vi.fn())
vi.mock("node:child_process", () => ({
  execFile: Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: execute })
}))

import { nativeDoctor } from "../packages/core-runtime/src/native/doctor.js"
import { nativeContentDigest } from "../packages/core-runtime/src/native/provenance.js"
import { nativeVerificationCommandContext } from "../packages/core-runtime/src/native/verification-context.js"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "operator-definition-archive-"))
  roots.push(root)
  const repository = join(root, "repo")
  mkdirSync(repository)
  const path = join(root, "archive.json")
  const policy = validateNativeAutonomyPolicy({
    version: 1,
    enabled: true,
    repositoryKind: "framework",
    repository,
    boardId: "board",
    baseBranch: "main",
    plannerAgentId: "planner",
    coderAgentId: "coder",
    reviewerAgentId: "reviewer",
    deployment: null,
    personas: [
      { personaId: "engineer", goals: ["Improve"], successObservations: ["Observed"], allowedPaths: ["src"], weight: 1 }
    ],
    verificationSandbox: { backend: "docker", image: `sha256:${"a".repeat(64)}`, inputFiles: ["src/a.ts"] },
    verification: [
      {
        id: "ui",
        argv: ["/checks/ui", "--strict"],
        cwd: ".",
        timeoutSeconds: 20,
        idleTimeoutSeconds: 10,
        outputLimitBytes: 4096,
        paths: ["src/**", "ui/**"]
      },
      { argv: ["/checks/backend"], cwd: ".", timeoutSeconds: 30, paths: ["backend/**"] }
    ]
  })
  const manifest = {
    schemaVersion: 1,
    image: (policy.verificationSandbox as { image: string }).image,
    executionAvailable: false,
    coverage: "top-level-only",
    helperClosure: "unverified",
    sourceContextId: "c".repeat(64),
    commands: policy.verification.map((command) => {
      const content = `#!/bin/sh\nexec npm test -- ${command.argv[0]}\n`
      return {
        ruleId: nativeVerificationRuleId(command),
        command: structuredClone(command),
        definition: { path: command.argv[0], content, sha256: nativeContentDigest(content) }
      }
    })
  }
  function install(value: unknown = manifest) {
    const raw = JSON.stringify(value)
    writeFileSync(path, raw, { mode: 0o600 })
    chmodSync(path, 0o600)
    return { ...policy, verificationDefinitionArchive: { path, sha256: nativeContentDigest(raw) } }
  }
  return { root, repository, path, policy, manifest, install }
}

it("retains explicit archive authority in policy validation and changes policy-bound capability identity", () => {
  const f = fixture()
  const policy = f.install()
  expect(validateNativeAutonomyPolicy(policy).verificationDefinitionArchive).toEqual(
    policy.verificationDefinitionArchive
  )
  expect(nativePolicyDigest(policy)).not.toBe(nativePolicyDigest(f.policy))
  expect(nativePolicyDigest(policy)).not.toBe(
    nativePolicyDigest({
      ...policy,
      verificationDefinitionArchive: { ...policy.verificationDefinitionArchive, sha256: "b".repeat(64) }
    })
  )
})

it("supplies exact archived top-level text with qualifications and never calls the execution reader", async () => {
  const f = fixture()
  const read = vi.fn().mockRejectedValue(new Error("Docker must not run"))
  const result = await nativeVerificationCommandContext(f.install(), null, read)
  expect(result.map(({ ruleId }) => ruleId)).toEqual(f.manifest.commands.map(({ ruleId }) => ruleId))
  expect(result[0]!.definition).toMatchObject({
    complete: true,
    content: f.manifest.commands[0]!.definition.content,
    provenance: {
      kind: "operator-pinned-historical-archive",
      coverage: "top-level-only",
      helperClosure: "unverified",
      executionAvailable: false
    }
  })
  expect(read).not.toHaveBeenCalled()
})

it("keeps Doctor blocked on the missing image even when archived context is complete", async () => {
  const f = fixture()
  const policy = f.install()
  const commands = await nativeVerificationCommandContext(policy, null)
  expect(commands.every(({ definition }) => definition.complete)).toBe(true)
  execute.mockReset().mockRejectedValue(new Error("private daemon error"))
  const report = await nativeDoctor(policy, { request: async () => ({}) } as any, { platform: "darwin" })
  expect(report.checks.find(({ name }) => name === "verification-toolchain")).toMatchObject({ ok: false })
  expect(report.ok).toBe(false)
  expect(execute.mock.calls.some(([, args]) => args[0] === "image")).toBe(true)
  expect(JSON.stringify(report)).not.toContain("private daemon error")
})

it.each([
  "relative",
  "traversal",
  "digest",
  "extra",
  "non-docker"
])("rejects invalid archive policy authority: %s", (mutation) => {
  const f = fixture()
  const policy = f.install() as any
  if (mutation === "relative") policy.verificationDefinitionArchive.path = "archive.json"
  if (mutation === "traversal") policy.verificationDefinitionArchive.path = `${f.root}/unused/../archive.json`
  if (mutation === "digest") policy.verificationDefinitionArchive.sha256 = "moving:latest"
  if (mutation === "extra") policy.verificationDefinitionArchive.fallback = true
  if (mutation === "non-docker")
    policy.verificationSandbox = { backend: "bubblewrap", rootFilesystem: "/toolchain", inputFiles: ["src/a.ts"] }
  expect(() => validateNativeAutonomyPolicy(policy)).toThrow()
})

it("validates unselected rules too, then applies normal candidate path selection", async () => {
  const f = fixture()
  const read = vi.fn()
  expect(await nativeVerificationCommandContext(f.install(), [], read)).toEqual([])
  expect(await nativeVerificationCommandContext(f.install(), ["src/a.ts"], read)).toHaveLength(1)
  f.manifest.commands[1]!.command.timeoutSeconds++
  const result = await nativeVerificationCommandContext(f.install(), ["src/a.ts"], read)
  expect(result[0]!.definition.complete).toBe(false)
  expect(read).not.toHaveBeenCalled()
})

it.each([
  "wrong-image",
  "missing-rule",
  "extra-rule",
  "duplicate-rule",
  "argv",
  "paths",
  "paths-order",
  "rule-id",
  "cwd",
  "timeout",
  "idle",
  "output",
  "definition-path",
  "definition-hash",
  "binary",
  "oversized",
  "redacted",
  "surrogate",
  "execution-claim",
  "coverage-claim",
  "helper-claim",
  "extra-definition-field"
])("refuses the entire pinned archive for %s without falling back", async (mutation) => {
  const f = fixture()
  const m = f.manifest as any
  const entry = m.commands[0]
  switch (mutation) {
    case "wrong-image":
      m.image = `sha256:${"b".repeat(64)}`
      break
    case "missing-rule":
      m.commands.pop()
      break
    case "extra-rule":
      m.commands.push(structuredClone(entry))
      break
    case "duplicate-rule":
      m.commands[1] = structuredClone(entry)
      break
    case "argv":
      entry.command.argv.reverse()
      break
    case "paths":
      entry.command.paths = ["different/**"]
      break
    case "paths-order":
      entry.command.paths.reverse()
      break
    case "rule-id":
      entry.ruleId = "other"
      break
    case "cwd":
      entry.command.cwd = "src"
      break
    case "timeout":
      entry.command.timeoutSeconds++
      break
    case "idle":
      delete entry.command.idleTimeoutSeconds
      break
    case "output":
      entry.command.outputLimitBytes++
      break
    case "definition-path":
      entry.definition.path = "/checks/other"
      break
    case "definition-hash":
      entry.definition.sha256 = "b".repeat(64)
      break
    case "binary":
      entry.definition.content = "\0binary"
      break
    case "oversized":
      entry.definition.content = "x".repeat(32769)
      break
    case "redacted":
      entry.definition.content = 'API_KEY="credential123"'
      break
    case "surrogate":
      entry.definition.content = "\ud800"
      break
    case "execution-claim":
      m.executionAvailable = true
      break
    case "coverage-claim":
      m.coverage = "complete"
      break
    case "helper-claim":
      m.helperClosure = "verified"
      break
    case "extra-definition-field":
      entry.definition.redacted = true
      break
  }
  if (["binary", "oversized", "redacted", "surrogate"].includes(mutation))
    entry.definition.sha256 = nativeContentDigest(entry.definition.content)
  const read = vi.fn().mockResolvedValue("this fallback must not be used")
  const result = await nativeVerificationCommandContext(f.install(m), null, read)
  expect(result.every(({ definition }) => !definition.complete && !definition.content)).toBe(true)
  expect(JSON.stringify(result)).not.toContain("credential123")
  expect(result[0]!.definition.reason).toBe(
    "Configured verifier definition archive is invalid or unavailable; no fallback or execution authority."
  )
  expect(read).not.toHaveBeenCalled()
})

it.each([
  "digest",
  "symlink",
  "hardlink",
  "writable",
  "oversized-file",
  "malformed-json"
])("refuses unsafe archive storage: %s", async (mutation) => {
  const f = fixture()
  const policy = f.install()
  if (mutation === "digest") policy.verificationDefinitionArchive.sha256 = "b".repeat(64)
  if (mutation === "symlink") {
    const target = join(f.root, "target.json")
    linkSync(f.path, target)
    rmSync(f.path)
    symlinkSync(target, f.path)
  }
  if (mutation === "hardlink") linkSync(f.path, join(f.root, "alias.json"))
  if (mutation === "writable") chmodSync(f.path, 0o660)
  if (mutation === "oversized-file" || mutation === "malformed-json") {
    const raw = mutation === "oversized-file" ? "x".repeat(2 * 1024 * 1024 + 1) : "{broken private-token"
    writeFileSync(f.path, raw)
    policy.verificationDefinitionArchive.sha256 = nativeContentDigest(raw)
  }
  const read = vi.fn()
  const result = await nativeVerificationCommandContext(policy, null, read)
  expect(result.every(({ definition }) => !definition.complete)).toBe(true)
  expect(JSON.stringify(result)).not.toContain("private-token")
  expect(read).not.toHaveBeenCalled()
})

it("rejects lexical and resolved archive paths within the candidate repository", async () => {
  const f = fixture()
  const policy = f.install()
  expect(() =>
    validateNativeAutonomyPolicy({
      ...policy,
      verificationDefinitionArchive: {
        ...policy.verificationDefinitionArchive,
        path: join(f.repository, "archive.json")
      }
    })
  ).toThrow(/outside/)
  const inside = join(f.repository, "inside.json")
  writeFileSync(inside, JSON.stringify(f.manifest), { mode: 0o600 })
  rmSync(f.path)
  symlinkSync(inside, f.path)
  const result = await nativeVerificationCommandContext(policy, null, vi.fn())
  expect(result.every(({ definition }) => !definition.complete)).toBe(true)
})
