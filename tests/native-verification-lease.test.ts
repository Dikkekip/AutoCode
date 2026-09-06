import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { NativeEvidenceStore } from "../packages/core-runtime/src/native/store.js"
import { runNativeCommand, verifyNativeCandidate } from "../packages/core-runtime/src/native/verification.js"
import { validateNativeAutonomyPolicy } from "../packages/domain/src/native-autonomy.js"
import * as osAdapters from "../packages/os-adapters/src/index.js"

const cleanups: Array<() => void> = []
afterEach(() => {
  vi.restoreAllMocks()
  while (cleanups.length) cleanups.pop()?.()
})
function setup() {
  const root = mkdtempSync(join(tmpdir(), "verification-lease-"))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim()
  git("init", "-b", "main")
  git("config", "user.email", "test@example.com")
  git("config", "user.name", "Test")
  git("config", "commit.gpgsign", "false")
  writeFileSync(join(root, "src.ts"), "export const value = 1\n")
  git("add", "src.ts")
  git("commit", "-m", "fixture")
  let now = 1_000
  const first = new NativeEvidenceStore(join(root, "evidence.db"), () => now)
  const second = new NativeEvidenceStore(join(root, "evidence.db"), () => now)
  cleanups.push(
    () => first.close(),
    () => second.close()
  )
  const lease = first.acquire("reconcile", 120_000)!
  const authority = {
    authorize: () => first.authorizeEffect(),
    mutate: (action: () => void) => first.fencedMutation(action)
  }
  const takeover = () => {
    now += 120_000
    expect(second.acquire("reconcile", 120_000)).not.toBeNull()
  }
  const command = { argv: ["/usr/bin/true"], cwd: ".", timeoutSeconds: 10 }
  const sandbox = { backend: "bubblewrap" as const, rootFilesystem: "/usr", inputFiles: ["src.ts"] }
  return { root, first, lease, authority, takeover, command, sandbox, headSha: git("rev-parse", "HEAD") }
}

it("does not launch verification after losing ownership during async input preparation", async () => {
  const s = setup()
  const execute = vi.spyOn(osAdapters, "executeSandboxedCommand").mockResolvedValue({ stdout: "", stderr: "" })
  const artifact = join(s.root, "command.json")
  const pending = s.first.withLease(s.lease, 120_000, () =>
    runNativeCommand(s.command, s.root, artifact, s.sandbox, undefined, s.authority)
  )
  // runNativeCommand is suspended reading committed inputs from Git.
  s.takeover()
  await expect(pending).rejects.toThrow(/lease/i)
  expect(execute).not.toHaveBeenCalled()
  expect(existsSync(artifact)).toBe(false)
})

it("preserves the successor receipt when an already-started verification finishes after takeover", async () => {
  const s = setup()
  let started!: () => void
  const running = new Promise<void>((resolve) => {
    started = resolve
  })
  let finish!: (value: { stdout: string; stderr: string }) => void
  const result = new Promise<{ stdout: string; stderr: string }>((resolve) => {
    finish = resolve
  })
  const execute = vi.spyOn(osAdapters, "executeSandboxedCommand").mockImplementation(() => {
    started()
    return result
  })
  const policy = validateNativeAutonomyPolicy({
    version: 1,
    enabled: true,
    boardId: "board",
    repository: s.root,
    repositoryKind: "application",
    baseBranch: "main",
    plannerAgentId: "planner",
    coderAgentId: "coder",
    reviewerAgentId: "reviewer",
    personas: [
      { personaId: "persona", goals: ["Goal"], successObservations: ["Works"], allowedPaths: ["src.ts"], weight: 1 }
    ],
    verification: [{ ...s.command, argv: ["/opt/openclaw/checks/test"] }],
    verificationAuthority: { reviewedRevision: "d".repeat(40), acceptance: [] },
    verificationSandbox: s.sandbox,
    deployment: null
  })
  const artifactRoot = join(s.root, "artifacts")
  const pending = s.first.withLease(s.lease, 120_000, () =>
    verifyNativeCandidate(
      policy,
      { cwd: s.root, headSha: s.headSha, baseSha: s.headSha, files: ["src.ts"] },
      artifactRoot,
      undefined,
      s.authority
    )
  )
  await running
  s.takeover()
  const receipt = join(artifactRoot, "receipt.json")
  writeFileSync(receipt, "successor evidence")
  finish({ stdout: "old result", stderr: "" })
  await expect(pending).rejects.toThrow(/lease/i)
  expect(execute).toHaveBeenCalledTimes(1)
  expect(readFileSync(receipt, "utf8")).toBe("successor evidence")
})
