import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { NativeCard, NativeGateway } from "../packages/core-runtime/src/native/gateway.js"
import { applyNativeMigration, planNativeMigration } from "../packages/core-runtime/src/native/migration.js"
import { assertNativeProvenance } from "../packages/core-runtime/src/native/provenance.js"
import { NativeAutonomyRuntime } from "../packages/core-runtime/src/native/runtime.js"
import { NativeEvidenceStore } from "../packages/core-runtime/src/native/store.js"
import {
  inspectNativeCandidate,
  planNativeVerification,
  verifyNativeCandidate
} from "../packages/core-runtime/src/native/verification.js"
import {
  assertNativeReleaseGate,
  selectNativePersonas,
  validateNativeAutonomyPolicy,
  validateNativeProposal
} from "../packages/domain/src/native-autonomy.js"
import * as osAdapters from "../packages/os-adapters/src/index.js"

const cleanups: string[] = []
function temp() {
  const path = mkdtempSync(join(tmpdir(), "native-autocode-"))
  cleanups.push(path)
  return path
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const path of cleanups.splice(0)) rmSync(path, { force: true, recursive: true })
})
function policy(repository = temp()) {
  return validateNativeAutonomyPolicy({
    version: 1,
    enabled: true,
    mode: "implement-human-review",
    boardId: "app",
    repository,
    repositoryKind: "application",
    baseBranch: "main",
    plannerAgentId: "planner",
    coderAgentId: "coder",
    reviewerAgentId: "reviewer",
    personas: ["legal", "design", "backend", "ux"].map((id) => ({
      personaId: id,
      goals: [id + " outcome"],
      successObservations: ["user completes workflow"],
      allowedPaths: ["src"],
      weight: id === "legal" ? 2 : 1
    })),
    verification: [{ argv: [process.execPath, "-e", "process.exit(0)"], cwd: ".", timeoutSeconds: 10 }],
    deployment: null
  })
}
function proposal() {
  return {
    personaId: "legal",
    goal: "legal outcome",
    title: "Find source evidence",
    evidence: [{ path: "src", observation: "Missing navigation" }],
    allowedPaths: ["src"],
    acceptance: ["User opens the cited page"],
    alternatives: ["Separate modal: deferred because navigation already exists"],
    implementationPrompt: "Implement citation navigation"
  }
}
class Gateway implements NativeGateway {
  cards: Array<NativeCard & Record<string, any>> = []
  calls: Array<{ method: string; params: Record<string, any> }> = []
  failCreateAt = 0
  async request<T = any>(method: string, params: Record<string, any>): Promise<T> {
    this.calls.push({ method, params })
    let result: any = {}
    if (method === "workboard.cards.list") result = { cards: this.cards }
    if (method === "workboard.cards.create") {
      if (String(params.notes ?? "").length > 4000) throw new Error("notes must be 4000 characters or fewer")
      if (this.failCreateAt && this.cards.length === this.failCreateAt) {
        this.failCreateAt = 0
        throw new Error("connection lost")
      }
      let card = this.cards.find((c) => c.key === params.idempotencyKey)
      if (!card) {
        card = {
          ...params,
          id: `card-${this.cards.length}`,
          title: params.title,
          status: params.status,
          key: params.idempotencyKey
        }
        this.cards.push(card)
      }
      result = { card }
    }
    if (method === "workboard.cards.update") {
      const card = this.cards.find((c) => c.id === params.id)!
      Object.assign(card, params.patch)
      result = { card }
    }
    if (method === "workboard.cards.move") {
      const card = this.cards.find((c) => c.id === params.id)!
      if (params.status === "ready" && card.status === "scheduled" && !card.metadata?.automation?.scheduledAt)
        throw new Error("card is scheduled for later.")
      card.status = params.status
      result = { card }
    }
    return result
  }
}
function legacy(root: string) {
  const path = join(root, "legacy.db")
  const db = new DatabaseSync(path)
  db.exec(`CREATE TABLE projects(id TEXT,repo_path TEXT); CREATE TABLE automations(project_id TEXT,status TEXT);
    CREATE TABLE tasks(id TEXT,project_id TEXT,title TEXT,status TEXT,depends_on_task_ids_json TEXT,description TEXT,
      task_package_json TEXT,blocked_reason TEXT,last_error TEXT,created_at TEXT);
    CREATE TABLE runs(id TEXT,project_id TEXT,task_id TEXT,status TEXT,head_sha TEXT,branch_name TEXT,worktree_path TEXT,
      review_verdict TEXT,verification_summary TEXT,started_at TEXT);`)
  db.prepare("INSERT INTO projects VALUES (?,?)").run("project", root)
  db.exec("INSERT INTO automations VALUES ('project','paused')")
  const add = (id: string, status: string, deps: string[]) =>
    db
      .prepare("INSERT INTO tasks VALUES (?,'project',?,?,?,'description','{}',NULL,NULL,'2026-09-05')")
      .run(id, id, status, JSON.stringify(deps))
  add("done", "done", [])
  add("first", "queued", ["done"])
  add("second", "blocked", ["first"])
  add("failed", "failed", [])
  db.close()
  return path
}
describe("native autonomy policy and creative provenance", () => {
  it("requires independent review, verification, bounded paths and explicit goals", () => {
    const p = policy()
    expect(() => validateNativeAutonomyPolicy({ ...p, reviewerAgentId: p.coderAgentId })).toThrow(/independent/)
    expect(() => validateNativeAutonomyPolicy({ ...p, verification: [] })).toThrow(/verification/)
    expect(() => validateNativeProposal({ ...proposal(), goal: "invented" }, p)).toThrow(/goal/)
    expect(() => validateNativeProposal({ ...proposal(), allowedPaths: ["../other"] }, p)).toThrow(/inside/)
    expect(() => validateNativeProposal({ ...proposal(), allowedPaths: ["scripts"] }, p)).toThrow(/authority/)
    expect(selectNativePersonas(p, { legal: 8, backend: 4, design: 0, ux: 0 }).map((x) => x.personaId)).toEqual([
      "design",
      "ux",
      "backend"
    ])
  })
  it("rotates real persona cards, preserves goal provenance and dedupes admission", async () => {
    const p = policy()
    mkdirSync(join(p.repository, "src"))
    const gateway = new Gateway(),
      store = new NativeEvidenceStore(join(p.repository, "evidence.db"))
    try {
      const runtime = new NativeAutonomyRuntime(p, gateway, store)
      await runtime.discover()
      const round = store.list<{ personas: string[] }>("round")[0]!
      expect(gateway.cards.slice(0, 3).map((c) => c.agentId)).toEqual(["backend", "design", "legal"])
      expect(gateway.cards[1]!.parents).toEqual([gateway.cards[0]!.id])
      expect((await runtime.discover()).reason).toMatch(/active/)
      const { proposalId } = runtime.propose("legal", round.id, proposal())
      expect(() => runtime.propose("design", round.id, proposal())).toThrow(/persona/)
      gateway.cards.forEach((c) => {
        c.status = "done"
      })
      const first = await runtime.admit("planner", proposalId, "Best evidence-backed user outcome")
      expect((await runtime.admit("planner", proposalId, "Already selected")).duplicate).toBe(true)
      const workflow = runtime.requireWorkflow(first.workflowId)
      expect(workflow.proposal.goal).toBe("legal outcome")
      expect(gateway.cards.find((c) => c.id === workflow.rootCardId)!.status).toBe("blocked")
      await expect(runtime.submit("coder", "unrelated", first.workflowId, p.repository)).rejects.toThrow(/session/)
    } finally {
      store.close()
    }
  })
  it("materializes admitted work from remote main while preserving a stale dirty local main", async () => {
    const repo = temp(),
      worktree = join(temp(), "candidate")
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
    git("init", "-b", "main")
    git("config", "commit.gpgsign", "false")
    git("config", "user.name", "Native Test")
    git("config", "user.email", "native@example.invalid")
    mkdirSync(join(repo, "src"))
    writeFileSync(join(repo, "src/a.txt"), "old main")
    git("add", ".")
    git("commit", "-m", "old base")
    const localHead = git("rev-parse", "HEAD")
    git("checkout", "-b", "upstream")
    writeFileSync(join(repo, "src/a.txt"), "current upstream")
    git("commit", "-am", "upstream change")
    git("update-ref", "refs/remotes/origin/main", "HEAD")
    const remoteHead = git("rev-parse", "HEAD")
    git("checkout", "main")
    writeFileSync(join(repo, "src/a.txt"), "uncommitted user draft")
    const p = policy(repo),
      gateway = new Gateway(),
      store = new NativeEvidenceStore(join(temp(), "evidence.db"))
    try {
      const runtime = new NativeAutonomyRuntime(p, gateway, store)
      await runtime.discover()
      const round = store.list<{ personas: string[] }>("round")[0]!
      const { proposalId } = runtime.propose("legal", round.id, proposal())
      gateway.cards.forEach((card) => {
        card.status = "done"
      })
      const { workflowId } = await runtime.admit("planner", proposalId, "Current upstream evidence")
      const card = gateway.cards.find((c) => c.id === runtime.requireWorkflow(workflowId).implementationCardId)!
      git("worktree", "add", "-b", "candidate", worktree, card.workspace.sourceBranch)
      expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktree, encoding: "utf8" }).trim()).toBe(remoteHead)
      expect(readFileSync(join(worktree, "src/a.txt"), "utf8")).toBe("current upstream")
      expect(git("rev-parse", "HEAD")).toBe(localHead)
      expect(readFileSync(join(repo, "src/a.txt"), "utf8")).toBe("uncommitted user draft")
    } finally {
      store.close()
    }
  })
  it("dispatches only the configured number of prepared implementation cards", async () => {
    const p = policy(),
      gateway = new Gateway(),
      store = new NativeEvidenceStore(join(p.repository, "slots.db"))
    try {
      const runtime = new NativeAutonomyRuntime(p, gateway, store)
      for (const id of ["one", "two"]) {
        gateway.cards.push({ id, title: id, agentId: p.coderAgentId, status: "scheduled" })
        store.put("workflow", id, {
          proposal: proposal(),
          rootCardId: `root-${id}`,
          implementationCardId: id,
          stageCards: {}
        })
        store.put("admission", id, { phase: "prepared" })
      }
      await runtime.reconcile()
      expect(gateway.cards.map((card) => card.status).sort()).toEqual(["ready", "scheduled"])
      gateway.cards.find((card) => card.status === "ready")!.status = "done"
      await runtime.reconcile()
      expect(gateway.cards.map((card) => card.status).sort()).toEqual(["done", "ready"])
    } finally {
      store.close()
    }
  })
  it("retains evidence and caps repairs at two attempts", async () => {
    const p = policy(),
      gateway = new Gateway(),
      store = new NativeEvidenceStore(join(p.repository, "evidence.db"))
    try {
      const runtime = new NativeAutonomyRuntime(p, gateway, store)
      const workflow = {
        proposal: proposal(),
        rootCardId: "root",
        implementationCardId: "original",
        stageCards: {},
        candidate: {
          cwd: p.repository,
          headSha: "a".repeat(40),
          baseSha: "b".repeat(40),
          files: ["src/a"],
          branch: "candidate"
        }
      }
      const original = { ...workflow.candidate }
      await runtime.requestRepair("repair-workflow", workflow, "test failed")
      expect(store.list("attempt-evidence")).toHaveLength(1)
      expect(runtime.requireWorkflow("repair-workflow").candidate).toBeUndefined()
      workflow.candidate = original
      await runtime.requestRepair("repair-workflow", workflow, "test failed")
      workflow.candidate = original
      await expect(runtime.requestRepair("repair-workflow", workflow, "test failed")).rejects.toThrow(/budget/)
      expect(gateway.cards).toHaveLength(2)
    } finally {
      store.close()
    }
  })
  it("resumes an interrupted discovery round instead of creating orphan rounds", async () => {
    const p = policy(),
      gateway = new Gateway(),
      store = new NativeEvidenceStore(join(p.repository, "evidence.db"))
    try {
      const runtime = new NativeAutonomyRuntime(p, gateway, store)
      gateway.failCreateAt = 1
      await expect(runtime.discover()).rejects.toThrow(/connection/)
      const firstRound = store.list("round")[0]!.id
      const result = await runtime.discover()
      expect(result.created).toHaveLength(4)
      expect(gateway.cards).toHaveLength(4)
      expect(gateway.cards[0]!.status).toBe("ready")
      expect(store.list("round").map((r) => r.id)).toEqual([firstRound])
    } finally {
      store.close()
    }
  })
  it("paused reconciliation does not start workers or investigations", async () => {
    const p = { ...policy(), enabled: false },
      gateway = new Gateway(),
      store = new NativeEvidenceStore(join(p.repository, "evidence.db"))
    try {
      const runtime = new NativeAutonomyRuntime(p, gateway, store)
      expect(await runtime.reconcile()).toEqual({ advanced: 0, paused: true })
      await expect(runtime.discover()).rejects.toThrow(/paused/)
      expect(gateway.calls).toEqual([])
    } finally {
      store.close()
    }
  })
})
describe("legacy native migration", () => {
  it("retries an interrupted import without duplicates or losing dependency holds", async () => {
    const p = { ...policy(), enabled: false },
      source = legacy(p.repository)
    const plan = planNativeMigration(source, p)
    expect(plan.tasks.map((t) => t.id)).toEqual(["first", "second"])
    expect(plan.tasks[0]!.dependencies).toEqual([])
    const gateway = new Gateway(),
      store = new NativeEvidenceStore(join(p.repository, "evidence.db"))
    try {
      gateway.failCreateAt = 1
      await expect(
        applyNativeMigration({ plan, policy: p, gateway, store, backupPath: join(p.repository, "backup1.db") })
      ).rejects.toThrow(/connection/)
      const result = await applyNativeMigration({
        plan,
        policy: p,
        gateway,
        store,
        backupPath: join(p.repository, "backup2.db")
      })
      expect(result.imported).toBe(2)
      expect(gateway.cards).toHaveLength(2)
      expect(gateway.cards.every((c) => c.status === "blocked")).toBe(true)
      expect(
        gateway.calls.some(
          (c) =>
            c.method === "workboard.cards.linkDependency" &&
            c.params.parentId === "card-0" &&
            c.params.childId === "card-1"
        )
      ).toBe(true)
      const db = new DatabaseSync(source, { readOnly: true })
      expect(db.prepare("SELECT status FROM tasks WHERE id='first'").get()!.status).toBe("queued")
      db.close()
    } finally {
      store.close()
    }
  })
  it("preserves large legacy evidence without exceeding Workboard card notes", async () => {
    const p = { ...policy(), enabled: false },
      source = legacy(p.repository)
    const large = "Original accepted implementation evidence. ".repeat(300)
    const db = new DatabaseSync(source)
    db.prepare("UPDATE tasks SET description=? WHERE id='first'").run(large)
    db.close()
    const plan = planNativeMigration(source, p)
    const store = new NativeEvidenceStore(join(p.repository, "evidence.db")),
      gateway = new Gateway()
    try {
      await applyNativeMigration({ plan, policy: p, gateway, store, backupPath: join(p.repository, "backup.db") })
      expect(gateway.cards.every((card) => String(card.notes).length <= 4000)).toBe(true)
      expect(store.get<any>("migration-task", "project:first").notes).toContain(large)
    } finally {
      store.close()
    }
  })
  it("rejects an edited preview even when its original fingerprint is retained", async () => {
    const p = { ...policy(), enabled: false },
      source = legacy(p.repository),
      plan = planNativeMigration(source, p)
    plan.tasks[0]!.notes = "tampered task instructions"
    const store = new NativeEvidenceStore(join(p.repository, "evidence.db")),
      gateway = new Gateway()
    try {
      await expect(
        applyNativeMigration({ plan, policy: p, gateway, store, backupPath: join(p.repository, "backup.db") })
      ).rejects.toThrow(/modified/)
      expect(gateway.calls).toHaveLength(0)
    } finally {
      store.close()
    }
  })
  it("rejects changed previews and running legacy owners before native writes", async () => {
    const p = { ...policy(), enabled: false },
      source = legacy(p.repository),
      plan = planNativeMigration(source, p)
    const db = new DatabaseSync(source)
    db.exec("UPDATE automations SET status='active'")
    db.close()
    const store = new NativeEvidenceStore(join(p.repository, "evidence.db")),
      gateway = new Gateway()
    try {
      await expect(
        applyNativeMigration({ plan, policy: p, gateway, store, backupPath: join(p.repository, "backup.db") })
      ).rejects.toThrow(/stale/)
      expect(gateway.calls).toHaveLength(0)
    } finally {
      store.close()
    }
  })
})
describe("legacy workflow adoption", () => {
  it("keeps adopted work paused and waits for dependencies before dispatch", async () => {
    const p = policy(),
      gateway = new Gateway(),
      store = new NativeEvidenceStore(join(p.repository, "adoption.db"))
    const runtime = new NativeAutonomyRuntime(p, gateway, store)
    gateway.cards.push({ id: "parent", title: "Dependency", status: "blocked" })
    store.put("migration-map", "project:parent", { cardId: "parent" })
    store.put("migration-task", "project:task", {
      id: "task",
      cardId: "legacy-root",
      title: "Resume citation navigation",
      status: "queued",
      dependencies: ["parent"],
      notes: JSON.stringify({
        personaId: "legal",
        allowedPaths: ["src"],
        description: "Implement citation navigation",
        package: { acceptanceCriteria: ["User opens the cited page"] },
        evidence: []
      })
    })
    try {
      store.put("control", "pause", { paused: true })
      const adopted = await runtime.adoptLegacy("project:task")
      expect(await runtime.adoptLegacy("project:task")).toEqual(adopted)
      expect(gateway.cards).toHaveLength(2)
      expect(gateway.cards[1]!.status).toBe("blocked")
      await runtime.reconcile()
      expect(gateway.cards[1]!.status).toBe("blocked")
      store.put("control", "pause", { paused: false })
      await runtime.reconcile()
      expect(gateway.cards[1]!.status).toBe("blocked")
      gateway.cards[0]!.status = "done"
      await runtime.reconcile()
      expect(gateway.cards[1]!.status).toBe("ready")
    } finally {
      store.close()
    }
  })
})
describe("independent commit-bound verification", () => {
  it("rejects missing, failed, stale and author-approved evidence", () => {
    const headSha = "a".repeat(40)
    const verification = {
      headSha,
      baseSha: "b".repeat(40),
      plan: {
        policyDigest: "digest",
        ruleIds: ["test"],
        exemptions: [],
        coverage: [{ path: "src/a", ruleIds: ["test"], exemptionIds: [] }],
        uncoveredPaths: []
      },
      checks: [
        {
          ruleId: "test",
          argv: ["test"],
          cwd: "/worktree",
          exitCode: 0,
          startedAt: "now",
          finishedAt: "later",
          artifact: "evidence.json"
        }
      ]
    }
    const review = {
      headSha,
      agentId: "reviewer",
      sessionKey: "session",
      verdict: "approved" as const,
      rationale: "Inspected acceptance criteria"
    }
    const input = { headSha, authorAgentId: "coder", reviewerAgentId: "reviewer", verification, review }
    expect(() => assertNativeReleaseGate(input)).not.toThrow()
    expect(() =>
      assertNativeReleaseGate({
        ...input,
        verification: { ...verification, plan: { ...verification.plan, uncoveredPaths: ["infra/deploy.txt"] } }
      })
    ).toThrow(/verification/)
    expect(() =>
      assertNativeReleaseGate({
        ...input,
        verification: { ...verification, plan: { ...verification.plan, ruleIds: ["test", "infra"] } }
      })
    ).toThrow(/verification/)

    expect(() => assertNativeReleaseGate({ ...input, verification: null })).toThrow(/verification/)
    expect(() => assertNativeReleaseGate({ ...input, headSha: "c".repeat(40) })).toThrow(/verification/)
    expect(() => assertNativeReleaseGate({ ...input, review: { ...review, agentId: "coder" } })).toThrow(/independent/)
    expect(() =>
      assertNativeReleaseGate({
        ...input,
        verification: { ...verification, checks: [{ ...verification.checks[0]!, exitCode: 1 }] }
      })
    ).toThrow(/verification/)
  })
  it("plans all change kinds before execution and retains precise coverage blockers", async () => {
    const repo = temp(),
      worktree = join(temp(), "candidate")
    const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" })
    git(repo, "init", "-b", "main")
    git(repo, "config", "commit.gpgsign", "false")
    git(repo, "config", "user.name", "Native Test")
    git(repo, "config", "user.email", "native@example.invalid")
    mkdirSync(join(repo, "src"))
    mkdirSync(join(repo, "infra"))
    for (const file of ["src/a.ts", "src/deleted.ts", "infra/old.txt"]) writeFileSync(join(repo, file), "before")
    git(repo, "add", ".")
    git(repo, "commit", "-m", "base")
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD")
    git(repo, "worktree", "add", "-b", "candidate", worktree)
    writeFileSync(join(worktree, "src/a.ts"), "after")
    writeFileSync(join(worktree, "infra/deploy.txt"), "deploy")
    git(worktree, "add", ".")
    git(worktree, "commit", "-m", "mixed coverage")
    const p = policy(repo),
      marker = join(temp(), "ran")
    p.verification = [
      {
        id: "src-check",
        paths: ["src"],
        argv: [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`],
        cwd: ".",
        timeoutSeconds: 10
      }
    ]
    let candidate = await inspectNativeCandidate(p, worktree, ["."])
    const artifacts = temp()
    await expect(verifyNativeCandidate(p, candidate, artifacts)).rejects.toThrow('"infra/deploy.txt"')
    expect(existsSync(marker)).toBe(false)
    const store = new NativeEvidenceStore(join(temp(), "coverage.db"))
    try {
      const runtime = new NativeAutonomyRuntime(p, new Gateway(), store)
      store.put("workflow", "coverage", {
        submission: { agentId: "coder", sessionKey: "coder-session", executionId: "coder-run" },
        proposal: proposal(),
        rootCardId: "root",
        implementationCardId: "implementation",
        stageCards: {},
        candidate
      })
      await runtime.reconcile()
      expect((await runtime.status()).workflows[0]!.blocker).toContain('"infra/deploy.txt"')
      expect(existsSync(marker)).toBe(false)
    } finally {
      store.close()
    }
    expect(JSON.parse(readFileSync(join(artifacts, "receipt.json"), "utf8"))).toMatchObject({
      checks: [],
      plan: { uncoveredPaths: ["infra/deploy.txt"] }
    })

    const exemptPolicy = {
      ...p,
      verification: [{ ...p.verification[0]!, argv: ["/opt/openclaw/checks/test"], paths: ["docs"] }],
      verificationAuthority: { reviewedRevision: "d".repeat(40), acceptance: [] },
      verificationExemptions: [
        { id: "manual", paths: candidate.files, reason: "Exact changes reviewed manually", reviewedBy: "maintainer" }
      ]
    }
    const exemptReceipt = await verifyNativeCandidate(exemptPolicy, candidate, temp())
    expect(exemptReceipt.checks).toEqual([])
    expect(exemptReceipt.plan.uncoveredPaths).toEqual([])
    expect(exemptReceipt.plan.exemptions[0]!.reviewedBy).toBe("maintainer")
    expect(existsSync(marker)).toBe(false)

    rmSync(join(worktree, "src/deleted.ts"))
    renameSync(join(worktree, "infra/old.txt"), join(worktree, "src/renamed.ts"))
    writeFileSync(join(worktree, "package.json"), "{}")
    writeFileSync(join(worktree, "infra/binary.bin"), Buffer.from([0, 255, 0]))
    writeFileSync(join(worktree, "infra/odd\nname.txt"), "unusual path")
    git(worktree, "add", ".")
    git(worktree, "commit", "-m", "all change kinds")
    candidate = await inspectNativeCandidate(p, worktree, ["."])
    expect(candidate.files).toEqual(
      expect.arrayContaining([
        "src/deleted.ts",
        "infra/old.txt",
        "src/renamed.ts",
        "package.json",
        "infra/binary.bin",
        "infra/odd\nname.txt"
      ])
    )
    await expect(
      inspectNativeCandidate(p, worktree, [
        "src",
        "infra/deploy.txt",
        "infra/binary.bin",
        "infra/odd\nname.txt",
        "package.json"
      ])
    ).rejects.toThrow(/outside/)
    const plan = planNativeVerification(p, candidate.files)
    expect(plan.uncoveredPaths).toEqual([
      "infra/binary.bin",
      "infra/deploy.txt",
      "infra/odd\nname.txt",
      "infra/old.txt",
      "package.json"
    ])
    await expect(verifyNativeCandidate(p, candidate, temp())).rejects.toThrow(/package.json/)
    expect(existsSync(marker)).toBe(false)
    p.verification.push({
      id: "global",
      argv: [process.execPath, "-e", "process.exit(0)"],
      cwd: ".",
      timeoutSeconds: 10
    })
    p.verification = p.verification.map((check) => ({ ...check, argv: ["/opt/openclaw/checks/test"] }))
    p.verificationAuthority = {
      reviewedRevision: "d".repeat(40),
      acceptance: [],
      approvedChanges: [
        {
          path: "package.json",
          blobSha: git(worktree, "rev-parse", "HEAD:package.json").toString().trim(),
          reviewedBy: "reviewer"
        }
      ]
    }
    p.verificationSandbox = { backend: "bubblewrap", rootFilesystem: "/usr", inputFiles: ["src/a.ts"] }
    const execute = vi.spyOn(osAdapters, "executeSandboxedCommand").mockResolvedValue({ stdout: "", stderr: "" })
    const context = {
      workflowId: "coverage",
      attemptId: "coverage:attempt:0",
      skillDigest: "d".repeat(64),
      executionId: "verifier-run",
      agentId: "verifier",
      sessionKey: "verifier-session"
    }
    const result = await verifyNativeCandidate(p, candidate, temp(), undefined, undefined, [], context)
    expect(() => assertNativeProvenance(p, result, context)).not.toThrow()
    expect(result.plan.uncoveredPaths).toEqual([])
    expect(result.checks.map((check) => check.ruleId)).toEqual(["src-check", "global"])
    expect(execute).toHaveBeenCalledTimes(2)
    expect(existsSync(marker)).toBe(false)
  })
  it("allows only reviewed exact-file exemptions and binds receipts to policy", () => {
    const p = policy()
    p.verification[0]!.paths = ["src"]
    const exemption = {
      id: "deploy-doc",
      paths: ["infra/deploy.txt"],
      reason: "Manually reviewed deployment notes",
      reviewedBy: "maintainer"
    }
    p.verificationExemptions = [exemption]
    const plan = planNativeVerification(p, ["src/a.ts", "infra/deploy.txt", "infra/other.txt"])
    expect(plan.uncoveredPaths).toEqual(["infra/other.txt"])
    expect(plan.exemptions).toEqual([exemption])
    expect(plan.coverage[0]).toEqual({ path: "infra/deploy.txt", ruleIds: [], exemptionIds: ["deploy-doc"] })
    expect(plan.policyDigest).toMatch(/^[a-f0-9]{64}$/)
    p.verificationExemptions[0]!.reason = "Updated review"
    expect(planNativeVerification(p, ["src/a.ts"]).policyDigest).not.toBe(plan.policyDigest)
    for (const paths of [["."], ["infra/**"]])
      expect(() => validateNativeAutonomyPolicy({ ...p, verificationExemptions: [{ ...exemption, paths }] })).toThrow(
        /exact/
      )
    expect(() =>
      validateNativeAutonomyPolicy({ ...p, verificationExemptions: [{ ...exemption, reviewedBy: "" }] })
    ).toThrow(/reviewer/)
    expect(() =>
      validateNativeAutonomyPolicy({
        ...p,
        verification: [
          { ...p.verification[0], id: "same" },
          { ...p.verification[0], id: "same" }
        ]
      })
    ).toThrow(/unique/)
    expect(planNativeVerification(p, ["infra/deploy.txt/child"]).uncoveredPaths).toEqual(["infra/deploy.txt/child"])
  })
  it("inspects an isolated committed worktree and refuses verification without a sandbox", async () => {
    const repo = temp(),
      worktree = join(temp(), "candidate")
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
    git("init", "-b", "main")
    git("config", "commit.gpgsign", "false")
    git("config", "user.name", "Native Test")
    git("config", "user.email", "native@example.invalid")
    mkdirSync(join(repo, "src"))
    writeFileSync(join(repo, "src/a.txt"), "before")
    git("add", ".")
    git("commit", "-m", "base")
    git("update-ref", "refs/remotes/origin/main", "HEAD")
    git("worktree", "add", "-b", "candidate", worktree)
    writeFileSync(join(worktree, "src/a.txt"), "after")
    execFileSync("git", ["commit", "-am", "change"], { cwd: worktree, stdio: "pipe" })
    const p = policy(repo)
    const candidate = await inspectNativeCandidate(p, worktree, ["src"])
    await expect(verifyNativeCandidate(p, candidate, join(temp(), "artifacts"))).rejects.toThrow(/sandbox/)
    await expect(inspectNativeCandidate(p, worktree, ["docs"])).rejects.toThrow(/outside/)
    p.verification[0]!.argv = [process.execPath, "-e", "process.exit(2)"]
    await expect(verifyNativeCandidate(p, candidate, join(temp(), "fail"))).rejects.toThrow(/sandbox/)
    await expect(inspectNativeCandidate(p, repo, ["src"])).rejects.toThrow(/isolated/)
  })
})

it("preserves an explicit future implementation schedule while repairing undated holds", async () => {
  const p = policy(),
    gateway = new Gateway(),
    store = new NativeEvidenceStore(join(p.repository, "future.db"))
  try {
    const runtime = new NativeAutonomyRuntime(p, gateway, store)
    gateway.cards.push({
      id: "future",
      agentId: p.coderAgentId,
      title: "future",
      status: "scheduled",
      metadata: { automation: { scheduledAt: Date.now() + 60000 } }
    })
    store.put("workflow", "future", {
      proposal: proposal(),
      rootCardId: "root",
      implementationCardId: "future",
      stageCards: {}
    })
    store.put("admission", "future", { phase: "prepared" })
    await runtime.reconcile()
    expect(gateway.cards[0]!.status).toBe("scheduled")
    expect(gateway.calls.filter((c) => ["workboard.cards.update", "workboard.cards.move"].includes(c.method))).toEqual(
      []
    )
    gateway.cards[0]!.metadata!.automation!.scheduledAt = Date.now() - 1000
    await runtime.reconcile()
    expect(gateway.cards[0]!.status).toBe("ready")
  } finally {
    store.close()
  }
})
