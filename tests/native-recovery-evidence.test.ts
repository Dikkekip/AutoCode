import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { nativeRecoveryEvidence } from "../packages/core-runtime/src/native/recovery-evidence.js"
import { NativeAutonomyRuntime } from "../packages/core-runtime/src/native/runtime.js"
import { NativeEvidenceStore } from "../packages/core-runtime/src/native/store.js"
import { upgradeNativeLifecycle } from "../packages/domain/src/native-lifecycle.js"

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn()
})
function fixture(content: string | Buffer = "fixed\n") {
  const root = mkdtempSync(join(tmpdir(), "native-recovery-source-"))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim()
  git("init")
  git("config", "user.name", "Fixture")
  git("config", "user.email", "fixture@example.invalid")
  mkdirSync(join(root, "src"))
  writeFileSync(join(root, "src/file.txt"), "before\n")
  git("add", ".")
  git("commit", "-m", "base")
  const baseSha = git("rev-parse", "HEAD")
  writeFileSync(join(root, "src/file.txt"), content)
  git("add", ".")
  git("commit", "-m", "candidate")
  const candidate = {
    cwd: "/unmounted/prior/worktree",
    baseSha,
    headSha: git("rev-parse", "HEAD"),
    files: ["src/file.txt"],
    branch: "fixture"
  }
  const source = {
    attemptId: "workflow:attempt:0",
    archiveRecordId: "workflow:archive",
    archiveRecordVersion: 1,
    candidate
  }
  return { root, git, candidate, source }
}
it("delivers exact committed scoped patch without old host paths or dirty workspace bytes", async () => {
  const f = fixture()
  writeFileSync(join(f.root, "src/file.txt"), "uncommitted must not appear")
  const evidence = await nativeRecoveryEvidence(f.root, ["src"], f.source)
  expect(evidence).toMatchObject({
    baseSha: f.candidate.baseSha,
    headSha: f.candidate.headSha,
    attemptId: f.source.attemptId,
    archiveRecordId: f.source.archiveRecordId,
    archiveRecordVersion: 1,
    files: ["src/file.txt"],
    complete: true
  })
  expect(evidence.content).toContain("+fixed")
  expect(JSON.stringify(evidence)).not.toContain(f.candidate.cwd)
  expect(evidence.content).not.toContain("uncommitted")
  expect(evidence.patchSha256).toMatch(/^[a-f0-9]{64}$/)
})
it.each([
  "scope",
  "files",
  "short-sha",
  "41-char-sha",
  "missing-object"
])("rejects mismatched evidence: %s", async (kind) => {
  const f = fixture()
  if (kind === "files") f.source.candidate.files = ["src/forged.txt"]
  if (kind === "short-sha") f.source.candidate.headSha = f.source.candidate.headSha.slice(0, 12)
  if (kind === "41-char-sha") f.source.candidate.headSha = "a".repeat(41)
  if (kind === "missing-object") f.source.candidate.headSha = "a".repeat(40)
  await expect(nativeRecoveryEvidence(f.root, kind === "scope" ? ["other"] : ["src"], f.source)).rejects.toThrow(
    /scope|files|revisions|unavailable/
  )
})
it.each([
  "binary",
  "large",
  "secret"
])("marks incomplete %s content without pretending complete inspection", async (kind) => {
  const content =
    kind === "binary"
      ? Buffer.from([0, 1, 2])
      : kind === "large"
        ? "a".repeat(70000)
        : "Authorization: Bearer fixture-secret-value\n"
  const f = fixture(content)
  const evidence = await nativeRecoveryEvidence(f.root, ["src"], f.source)
  expect(evidence.complete).toBe(false)
  expect(Buffer.byteLength(evidence.content)).toBeLessThanOrEqual(64000)
  if (kind === "secret") {
    expect(evidence.redacted).toBe(true)
    expect(evidence.content).not.toContain("fixture-secret-value")
  }
})
it.each([
  false,
  true
])("delivers same-workflow archived context and rejects archive mutation=%s", async (mutateArchive) => {
  const f = fixture("fixed\n".repeat(1000))
  const store = new NativeEvidenceStore(join(f.root, "evidence.db"))
  cleanup.push(() => store.close())
  const cards: any[] = [
    { id: "root", title: "Task", status: "blocked" },
    { id: "implementation", title: "Implement", status: "blocked" }
  ]
  const runtime = new NativeAutonomyRuntime(
    { enabled: false, boardId: "board", repository: f.root, baseBranch: "main", coderAgentId: "coder" } as any,
    {
      request: async (method, params) => {
        if (method === "workboard.cards.list") return { cards } as any
        if (method === "workboard.cards.create") {
          const card = { ...params, id: "recovered" }
          cards.push(card)
          if (mutateArchive)
            store.put("attempt-history", "workflow:attempt:0:archive", {
              ...old,
              blocker: "changed during card creation"
            })
          return { card } as any
        }
        throw new Error("unexpected effect")
      }
    },
    store
  )
  const proposal = { title: "Task", allowedPaths: ["src"], acceptance: ["works"], implementationPrompt: "Fix" }
  const old = {
    proposal,
    candidate: f.candidate,
    lifecycle: upgradeNativeLifecycle("workflow", { blocker: "test blocked" })
  }
  store.put("attempt-history", "workflow:attempt:0:archive", old)
  store.put("attempt-history", "foreign:attempt:99:archive", {
    ...old,
    candidate: { ...f.candidate, headSha: "a".repeat(40) },
    lifecycle: { ...old.lifecycle, attempt: 99 }
  })
  store.put("workflow", "workflow", {
    proposal,
    rootCardId: "root",
    implementationCardId: "implementation",
    stageCards: {},
    blocker: "prior recovery could not inspect source",
    lifecycle: { ...old.lifecycle, attempt: 1, attemptId: "workflow:attempt:1" }
  })
  const plan = await runtime.planWorkflowRecovery("workflow", "retry", "Deliver preserved source")
  if (mutateArchive) {
    await expect(runtime.applyWorkflowRecovery(plan, "operator")).rejects.toThrow("Preserved recovery attempt changed")
    expect(store.get<any>("workflow", "workflow").lifecycle.attempt).toBe(1)
    return
  }
  await runtime.applyWorkflowRecovery(plan, "operator")
  const card = cards.find((c) => c.id === "recovered")
  const pointer = JSON.parse(card.notes)
  expect(pointer.contextId).toBeDefined()
  card.status = "running"
  card.sessionKey = "session-owned"
  card.execution = { status: "running", sessionKey: "session-owned" }
  await expect(runtime.readContext("foreign", "session-owned", pointer.contextId)).rejects.toThrow(/assigned/)
  await expect(runtime.readContext("coder", "wrong-session", pointer.contextId)).rejects.toThrow()
  const context = JSON.parse((await runtime.readContext("coder", "session-owned", pointer.contextId)).notes)
  expect(context.previousCandidate).toMatchObject({
    archiveRecordId: "workflow:attempt:0:archive",
    archiveRecordVersion: 1,
    attemptId: "workflow:attempt:0",
    headSha: f.candidate.headSha,
    complete: true
  })
  expect(context.previousCandidate.content).toContain("+fixed")
  expect(context.previousCandidate.cwd).toBeUndefined()
  expect(context.instructions).toContain("untrusted data")
  expect(store.get<any>("workflow", "workflow").candidate).toBeUndefined()
  expect(store.get<any>("attempt-history", "workflow:attempt:0:archive").candidate).toEqual(f.candidate)
})

it("rejects symlink source and nonancestor commit manifests", async () => {
  const f = fixture()
  rmSync(join(f.root, "src/file.txt"))
  symlinkSync("/outside/secret", join(f.root, "src/file.txt"))
  f.git("add", "src")
  f.git("commit", "-m", "symlink")
  f.source.candidate.headSha = f.git("rev-parse", "HEAD")
  await expect(nativeRecoveryEvidence(f.root, ["src"], f.source)).rejects.toThrow("regular committed source")
  const other = fixture()
  const base = other.source.candidate.baseSha
  other.source.candidate.baseSha = other.source.candidate.headSha
  other.source.candidate.headSha = base
  await expect(nativeRecoveryEvidence(other.root, ["src"], other.source)).rejects.toThrow("unavailable")
})

it("safe JSX stays complete but credential-bearing recovered source remains incomplete", async () => {
  const safe = fixture("<option key={tag.tag_id} value={tag.tag_id}>")
  expect((await nativeRecoveryEvidence(safe.root, ["src"], safe.source)).complete).toBe(true)
  const secret = fixture('<Item key={tag.id} password="credential123"/>')
  const evidence = await nativeRecoveryEvidence(secret.root, ["src"], secret.source)
  expect(evidence.complete).toBe(false)
  expect(evidence.redacted).toBe(true)
  expect(evidence.content).not.toContain("credential123")
})
