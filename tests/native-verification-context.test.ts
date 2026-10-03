import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
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
