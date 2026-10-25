import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { historicalBa7Definitions } from "../packages/core-runtime/src/native/historical-ba7-definitions.js"
import { nativeContentDigest } from "../packages/core-runtime/src/native/provenance.js"
import {
  nativeVerificationCommandContext,
  readNativeVerifierDefinition
} from "../packages/core-runtime/src/native/verification-context.js"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const sandbox = { backend: "docker" as const, image: `sha256:${"a".repeat(64)}`, inputFiles: ["src"] }
const policy = {
  verificationSandbox: sandbox,
  verification: [
    { argv: ["/opt/openclaw/checks/ui"], cwd: ".", timeoutSeconds: 10, paths: ["src/**"] },
    { argv: ["/opt/openclaw/checks/backend"], cwd: ".", timeoutSeconds: 10, paths: ["backend/**"] }
  ],
  version: 1,
  enabled: true,
  mode: "implement-human-review",
  repositoryKind: "framework",
  repository: "/tmp/verifier-context",
  boardId: "board",
  baseBranch: "main",
  plannerAgentId: "planner",
  coderAgentId: "coder",
  reviewerAgentId: "reviewer",
  deployment: null,
  personas: [
    { personaId: "engineer", goals: ["Improve"], successObservations: ["Observed"], allowedPaths: ["src"], weight: 1 }
  ]
} as any

it("supplies exact path-selected verifier contents and image identity, without claiming execution", async () => {
  const source = "#!/bin/sh\nexec npm test -- --run src/components\n"
  const read = vi.fn().mockResolvedValue(source)
  const commands = await nativeVerificationCommandContext(policy, ["src/component.tsx"], read)
  expect(commands).toHaveLength(1)
  expect(read).toHaveBeenCalledWith(sandbox, "/opt/openclaw/checks/ui")
  expect(commands[0]).toMatchObject({
    toolchain: { image: sandbox.image },
    definition: {
      path: "/opt/openclaw/checks/ui",
      content: source,
      sha256: nativeContentDigest(source),
      complete: true
    }
  })
})
it("reports missing, binary, oversized or redacted definitions as incomplete", async () => {
  for (const source of ["\x00binary", "x".repeat(32769), 'API_KEY="credential123"']) {
    const commands = await nativeVerificationCommandContext(policy, ["src/file.ts"], async () => source)
    expect(commands[0]!.definition.complete).toBe(false)
    expect(commands[0]!.definition.content ?? "").not.toContain("credential123")
  }
  const commands = await nativeVerificationCommandContext(policy, ["src/file.ts"], async () => {
    throw new Error("private path")
  })
  expect(commands[0]!.definition).toMatchObject({ complete: false, reason: expect.stringContaining("do not infer") })
  expect(JSON.stringify(commands)).not.toContain("private path")
})
it("supplies all standing commands and their path conditions before a candidate exists", async () => {
  const read = vi.fn().mockResolvedValue("#!/bin/sh\nexit 0\n")
  const commands = await nativeVerificationCommandContext(policy, null, read)
  expect(commands.map(({ argv, paths }) => ({ argv, paths }))).toEqual(
    policy.verification.map(({ argv, paths }: any) => ({ argv, paths }))
  )
  expect(read.mock.calls.map(([, path]) => path)).toEqual(["/opt/openclaw/checks/ui", "/opt/openclaw/checks/backend"])
  expect(commands.every(({ definition }) => definition.complete)).toBe(true)
  // Empty changed files still means no selected commands, not all standing rules.
  expect(await nativeVerificationCommandContext(policy, [], read)).toEqual([])
})
it("reads only bounded text under a toolchain root and rejects escaping symlinks", async () => {
  const root = mkdtempSync(join(tmpdir(), "native-verifier-definition-"))
  roots.push(root)
  mkdirSync(join(root, "toolchain/checks"), { recursive: true })
  writeFileSync(join(root, "toolchain/checks/check"), "#!/bin/sh\nexit 0\n")
  writeFileSync(join(root, "outside"), "private content")
  symlinkSync(join(root, "outside"), join(root, "toolchain/checks/escape"))
  const config = { backend: "bubblewrap" as const, rootFilesystem: join(root, "toolchain"), inputFiles: [] }
  expect(await readNativeVerifierDefinition(config, "/checks/check")).toContain("exit 0")
  await expect(readNativeVerifierDefinition(config, "/checks/escape")).rejects.toThrow(/escapes/)
  await expect(readNativeVerifierDefinition(config, "/../outside")).rejects.toThrow(/absolute/)
})

// R104: tests are prepared for independent review; not run in the source-only packet task.
const historical = JSON.parse(historicalBa7Definitions)
const historicalPolicy = () => ({
  ...policy,
  verificationSandbox: { ...sandbox, image: historical.image },
  verification: historical.definitions.map((entry: any) => structuredClone(entry.command))
})
const unavailable = async () => {
  throw new Error("private unavailable-image diagnostic")
}

it("recovers all50 exact historical bodies as source coverage with explicit limited provenance", async () => {
  const read = vi.fn(unavailable)
  const p = historicalPolicy()
  const commands = await nativeVerificationCommandContext(p, null, read)
  expect(read).toHaveBeenCalledTimes(50)
  expect(commands).toHaveLength(50)
  expect(new Set(commands.map((entry) => entry.ruleId)).size).toBe(50)
  commands.forEach((entry, index) => {
    const original = historical.definitions[index]
    expect(entry.definition).toMatchObject({
      path: original.path,
      content: original.content,
      sha256: original.sha256,
      complete: true,
      provenance: {
        kind: "historical-operator-capture",
        image: historical.image,
        sourceContextId: historical.sourceContextId,
        provenanceSha256: historical.provenanceSha256,
        auditSha256: historical.auditSha256,
        scope: "top-level-definition-source-only",
        imagePresenceAttested: false,
        executionAttested: false
      }
    })
    expect(entry.argv).toEqual(original.command.argv)
    expect(entry.paths).toEqual(original.command.paths)
    expect(entry).not.toHaveProperty("exitCode")
    expect(entry).not.toHaveProperty("artifact")
  })
  expect(JSON.stringify(commands)).not.toContain("private unavailable-image diagnostic")
})

it("prefers available image bytes and does not use history to replace malformed or redacted reads", async () => {
  const p = historicalPolicy()
  p.verification = [p.verification[0]]
  const valid = "#!/bin/sh\nexit 17\n"
  const [current] = await nativeVerificationCommandContext(p, null, async () => valid)
  expect(current!.definition).toMatchObject({ content: valid, complete: true })
  expect(current!.definition).not.toHaveProperty("provenance")
  for (const source of ["\x00binary", "\ufffd", "x".repeat(32769), 'API_KEY="credential123"']) {
    const [entry] = await nativeVerificationCommandContext(p, null, async () => source)
    expect(entry!.definition.complete).toBe(false)
    expect(entry!.definition).not.toHaveProperty("provenance")
    expect(entry!.definition.content ?? "").not.toContain("credential123")
  }
})

it("fails closed on each binding mismatch, unknown commands and non-docker sandboxes", async () => {
  const mutations = [
    (p: any) => {
      p.verificationSandbox.image = `sha256:${"8".repeat(64)}`
    },
    (p: any) => {
      p.verification[0].id += "-changed"
    },
    (p: any) => {
      p.verification[0].argv.push("--candidate-override")
    },
    (p: any) => {
      p.verification[0].argv[0] = "/candidate/definition"
    },
    (p: any) => {
      p.verification[0].cwd = "src"
    },
    (p: any) => {
      p.verification[0].paths = ["src/**"]
    },
    (p: any) => {
      p.verification[0].timeoutSeconds += 1
    },
    (p: any) => {
      p.verification[0].idleTimeoutSeconds = 60
    },
    (p: any) => {
      p.verification[0].outputLimitBytes = 4096
    },
    (p: any) => {
      p.verificationSandbox = { backend: "bubblewrap", rootFilesystem: "/candidate", inputFiles: ["src/file.ts"] }
    },
    (p: any) => {
      delete p.verificationSandbox
    }
  ]
  for (const mutate of mutations) {
    const p = historicalPolicy()
    p.verification = [p.verification[0]]
    mutate(p)
    const [entry] = await nativeVerificationCommandContext(p, null, unavailable)
    expect(entry!.definition.complete).toBe(false)
    expect(entry!.definition).not.toHaveProperty("content")
    expect(entry!.definition).not.toHaveProperty("provenance")
  }
})

it("preserves actual path selection and empty selection with historical fallback", async () => {
  const p = historicalPolicy()
  const files = [
    "apps/reports-ui/src/features/bundles/detail/components/BundleEvidenceInventoryReview.tsx",
    "apps/reports-ui/src/features/bundles/detail/components/BundleEvidenceInventoryReview.test.tsx"
  ]
  const selected = await nativeVerificationCommandContext(p, files, unavailable)
  expect(selected.map((entry) => entry.ruleId)).toEqual([
    "legacy-006",
    "legacy-007",
    "legacy-008",
    "legacy-009",
    "legacy-010",
    "changed-feature-tests",
    "ui-types"
  ])
  expect(selected.every((entry) => entry.definition.complete)).toBe(true)
  expect(await nativeVerificationCommandContext(p, [], unavailable)).toEqual([])
})

it("rejects changed asset bytes even when their internal body digest is updated", async () => {
  const altered = JSON.parse(historicalBa7Definitions)
  altered.definitions[0].content = "#!/bin/sh\nexit 0\n"
  altered.definitions[0].sha256 = nativeContentDigest(altered.definitions[0].content)
  vi.resetModules()
  vi.doMock("../packages/core-runtime/src/native/historical-ba7-definitions.js", () => ({
    historicalBa7Definitions: JSON.stringify(altered)
  }))
  try {
    const { nativeVerificationCommandContext: context } = await import(
      "../packages/core-runtime/src/native/verification-context.js"
    )
    const p = historicalPolicy()
    p.verification = [p.verification[0]]
    const [entry] = await context(p, null, unavailable)
    expect(entry!.definition.complete).toBe(false)
    expect(entry!.definition).not.toHaveProperty("content")
  } finally {
    vi.doUnmock("../packages/core-runtime/src/native/historical-ba7-definitions.js")
    vi.resetModules()
  }
})
