import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  assertT3CurrentSource,
  captureT3Source,
  digest,
  publicationMetadata,
  publicationOperations,
  readT3SourceFile,
  resolveT3Personas,
  T3_PORT_POLICY,
  T3Journal,
  type T3Policy,
  type T3Proposal,
  T3Publication,
  type T3Role,
  T3WorkflowEngine
} from "@autocode/t3-runtime"
import { loadProjectProfile } from "@openclaw/project-profiles"
import { afterEach, describe, expect, it } from "vitest"

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

function fixture(overrides: Partial<T3Policy> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "autocode-t3-workflow-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const repository = join(dir, "repo")
  execFileSync("git", ["init", "--quiet", repository])
  const git = (...args: string[]) => execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" }).trim()
  writeFileSync(join(repository, "code.ts"), "export const n = 1\n")
  writeFileSync(join(repository, "SKILL.md"), "Read committed source and retain evidence.\n")
  symlinkSync("/etc/passwd", join(repository, "external"))
  git("add", ".")
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture")
  const source = captureT3Source(repository)
  const policy: T3Policy = {
    goal: "Fix bounded backend behavior",
    lanes: ["backend"],
    maxAdmitted: 2,
    maxDispatches: 100,
    estimatedTokenBudget: 100_000,
    maxRepairs: 1,
    deadline: Date.now() + 60_000,
    rolePersonas: {
      research: ["backend-engineer", "security-engineer"],
      planner: ["planner"],
      design: ["cto-system-architect"],
      implementation: ["backend-engineer"],
      verification: ["qa-engineer"],
      review: ["code-reviewer"],
      release: ["release-manager"]
    },
    ...overrides
  }
  const personas = resolveT3Personas(loadProjectProfile("minimal-repo"))
  const path = join(dir, "journal.sqlite")
  const journal = new T3Journal(path)
  cleanups.push(() => journal.close())
  const lease = journal.acquire("fixture")!
  const engine = new T3WorkflowEngine(journal, policy, personas)
  let sequence = 0
  function completed(id: string, role: T3Role, personaId = policy.rolePersonas[role][0]!) {
    const workflow = engine.get(lease.projectId, id).value
    const assignment = {
      id: `assignment-${++sequence}`,
      role,
      personaId,
      personaDigest: personas.find((p) => p.definition.id === personaId)!.digest,
      promptDigest: digest({ id, role, sequence }),
      providerInstanceId: "fixture-provider",
      revision: workflow.candidate?.revision ?? source.revision
    }
    engine.prepareAssignment(lease, id, assignment, 100)
    const taskId = `task-${sequence}`
    engine.attachTask(lease, id, assignment.id, taskId)
    engine.settleTask(lease, id, assignment.id, {
      taskId,
      runId: `run-${sequence}`,
      status: "completed",
      hasPendingChildRuns: false
    })
    return assignment.id
  }
  function proposal(id: string, fields: Partial<T3Proposal> = {}) {
    engine.startResearch(lease, id, "backend-engineer", source)
    engine.completeResearch(lease, id, completed(id, "research"), {
      proposal: {
        title: `Fix ${id}`,
        problem: `Problem ${id}`,
        goal: policy.goal,
        lane: "backend",
        scope: ["code.ts"],
        inspectedPaths: ["code.ts", "SKILL.md"],
        acceptance: ["Expected behavior is verified"],
        dependencies: [],
        risk: "low",
        estimatedTokens: 1000,
        ...fields
      }
    })
    return completed(id, "planner")
  }
  function admit(id: string, fields: Partial<T3Proposal> = {}) {
    const planner = proposal(id, fields)
    engine.plan(lease, id, planner, "admit", "Source-backed and within policy", source.digest)
  }
  function candidate(id: string, revision = "b".repeat(40)) {
    const assignment = completed(id, "implementation")
    const taskId = engine.get(lease.projectId, id).value.assignments.at(-1)!.taskId!
    engine.recordCandidate(lease, id, assignment, {
      revision,
      treeDigest: "c".repeat(64),
      changedPaths: ["code.ts"],
      implementationTaskId: taskId
    })
  }
  function verify(id: string, passed = true) {
    const item = engine.get(lease.projectId, id).value
    engine.recordVerification(lease, id, completed(id, "verification"), {
      revision: item.candidate!.revision,
      treeDigest: item.candidate!.treeDigest,
      passed,
      isolation: "protected",
      policyDigest: "d".repeat(64),
      receiptDigest: "e".repeat(64)
    })
  }
  return {
    dir,
    repository,
    source,
    git,
    policy,
    personas,
    path,
    journal,
    lease,
    engine,
    completed,
    proposal,
    admit,
    candidate,
    verify
  }
}

describe("T3 committed-source custody", () => {
  it("rejects invalid UTF-8 source blobs and partial-length object IDs", () => {
    const f = fixture()
    writeFileSync(join(f.repository, "binary"), Buffer.from([0xff, 0xfe]))
    f.git("add", ".")
    f.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "binary")
    const source = captureT3Source(f.repository)
    expect(() => readT3SourceFile(source, "binary")).toThrow()
    expect(() => captureT3Source(f.repository, "a".repeat(41))).toThrow("full commit ID")
  })

  it("reads only captured regular blobs and detects dirty or moved source", () => {
    const f = fixture()
    expect(readT3SourceFile(f.source, "code.ts").content).toContain("n = 1")
    expect(() => readT3SourceFile(f.source, "external")).toThrow("regular file")
    expect(() => readT3SourceFile(f.source, "../code.ts")).toThrow("repository-relative")
    expect(() => readT3SourceFile(f.source, "code.ts", 2)).toThrow("read budget")
    assertT3CurrentSource(f.source)
    writeFileSync(join(f.repository, "code.ts"), "changed")
    expect(() => assertT3CurrentSource(f.source)).toThrow("uncommitted")
    expect(readT3SourceFile(f.source, "code.ts").content).toContain("n = 1")
    f.git("add", ".")
    f.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "changed")
    expect(() => assertT3CurrentSource(f.source)).toThrow("head moved")
  })

  it("uses canonical hashes and rejects manifest or persona tampering", () => {
    const f = fixture()
    expect(digest({ b: 1, a: [2] })).toBe(digest({ a: [2], b: 1 }))
    expect(() => digest({ n: Number.NaN })).toThrow("finite JSON")
    expect(() => readT3SourceFile({ ...f.source, revision: "a".repeat(40) }, "code.ts")).toThrow("digest mismatch")
    f.personas[0]!.definition.responsibilities.push("Altered after hashing")
    expect(() => new T3WorkflowEngine(f.journal, f.policy, f.personas)).toThrow("Persona digest mismatch")
  })
})

describe("T3 persona policy workflow", () => {
  it("preserves the research loop, deduplicates delivery IDs and retains explicit no-ops", () => {
    const f = fixture()
    const item = f.engine.startResearch(f.lease, "one", "backend-engineer", f.source)
    expect(item.board).toBe("To Research")
    expect(f.engine.startResearch(f.lease, "one", "backend-engineer", f.source)).toEqual(item)
    expect(() => f.engine.startResearch(f.lease, "one", "security-engineer", f.source)).toThrow("identity collision")
    const assignment = f.completed("one", "research")
    expect(f.engine.get("fixture", "one").value.board).toBe("Researching")
    expect(() =>
      f.engine.completeResearch(f.lease, "one", assignment, { noOp: "No issue", inspectedPaths: ["missing.ts"] })
    ).toThrow("captured inspected")
    f.engine.completeResearch(f.lease, "one", assignment, {
      noOp: "Inspected source already meets the goal",
      inspectedPaths: ["code.ts"]
    })
    expect(f.engine.get("fixture", "one").value).toMatchObject({
      board: "Planning",
      phase: "no-op",
      reason: "Inspected source already meets the goal"
    })
  })

  it("requires high-risk design, protected verification, independent review and closure before Done", () => {
    const f = fixture()
    f.admit("one", { risk: "high" })
    expect(f.engine.get("fixture", "one").value.phase).toBe("design")
    expect(() => f.completed("one", "implementation")).toThrow("not dispatchable")
    f.engine.design(f.lease, "one", f.completed("one", "design"), true, "Risk mitigations accepted")
    f.candidate("one")
    const verification = f.completed("one", "verification")
    expect(() =>
      f.engine.recordVerification(f.lease, "one", verification, {
        revision: "f".repeat(40),
        treeDigest: "c".repeat(64),
        passed: true,
        isolation: "protected",
        policyDigest: "d".repeat(64),
        receiptDigest: "e".repeat(64)
      })
    ).toThrow("exact candidate")
    f.engine.recordVerification(f.lease, "one", verification, {
      revision: "b".repeat(40),
      treeDigest: "c".repeat(64),
      passed: true,
      isolation: "protected",
      policyDigest: "d".repeat(64),
      receiptDigest: "e".repeat(64)
    })
    f.engine.recordReview(f.lease, "one", f.completed("one", "review"), {
      revision: "b".repeat(40),
      accepted: true,
      findings: [],
      criteria: [{ criterion: "Expected behavior is verified", passed: true, evidence: "Fixture assertion" }]
    })
    f.engine.releaseReady(f.lease, "one", f.completed("one", "release"), "b".repeat(40))
    expect(f.engine.get("fixture", "one").value).toMatchObject({
      phase: "ready",
      board: "PR approved",
      mergedRevision: null
    })
    expect(() =>
      f.engine.recordClosure(f.lease, "one", {
        candidateRevision: "b".repeat(40),
        mergedRevision: "f".repeat(40),
        closed: false,
        evidence: "fixture observation"
      })
    ).toThrow("Actual merge and closure")
    f.engine.recordClosure(f.lease, "one", {
      candidateRevision: "b".repeat(40),
      mergedRevision: "f".repeat(40),
      closed: true,
      evidence: "fixture observation only"
    })
    expect(f.engine.get("fixture", "one").value.board).toBe("Done")
  })

  it("rejects duplicates, source drift, goal mismatch, unmet dependencies and reserved scopes", () => {
    const f = fixture()
    const first = f.proposal("one")
    expect(() => f.engine.plan(f.lease, "one", first, "admit", "Ready", "stale")).toThrow("source is stale")
    f.engine.plan(f.lease, "one", first, "admit", "Ready", f.source.digest)
    const cases: Array<[string, Partial<T3Proposal>, string]> = [
      ["duplicate", { problem: "Problem one" }, "Duplicate"],
      ["scope", {}, "Scope is reserved"],
      ["dependency", { dependencies: ["one"], scope: ["other.ts"] }, "Unclosed dependency"],
      ["goal", { goal: "Unrelated goal", scope: ["other.ts"] }, "current project goal"]
    ]
    for (const [id, fields, expected] of cases) {
      const planner = f.proposal(id, fields)
      expect(() => f.engine.plan(f.lease, id, planner, "admit", "Admit", f.source.digest)).toThrow(expected)
      expect(f.engine.get("fixture", id).value.phase).toBe("planner")
    }
  })

  it("retains structured blocking findings without approving them or changing their shape", () => {
    const f = fixture()
    f.admit("one")
    f.candidate("one")
    f.verify("one")
    const reviewer = f.completed("one", "review")
    const finding = {
      severity: "P1" as const,
      path: "src/journal.ts",
      lines: [104, 146] as [number, number],
      title: "Rejected admission releases another connection's lock",
      description: "A separate writer enters while the original transaction remains active.",
      requestedChange: "Preserve locks and add a cross-process regression."
    }
    const result = {
      revision: "b".repeat(40),
      accepted: false,
      findings: [finding],
      criteria: [{ criterion: "Expected behavior is verified", passed: false, evidence: "Cross-process lock probe" }]
    }
    const before = f.engine.get("fixture", "one")
    for (const invalid of [
      null,
      {},
      "",
      { ...finding, path: "../escape" },
      { ...finding, path: "src/\0file.ts" },
      { ...finding, lines: [146, 104] },
      { ...finding, severity: "unknown" }
    ]) {
      expect(() =>
        f.engine.recordReview(f.lease, "one", reviewer, { ...result, findings: [invalid] } as never)
      ).toThrow("cannot be approved")
      expect(f.engine.get("fixture", "one")).toEqual(before)
    }
    expect(() => f.engine.recordReview(f.lease, "one", reviewer, { ...result, accepted: true })).toThrow(
      "cannot be approved"
    )
    f.engine.recordReview(f.lease, "one", reviewer, result)
    const item = f.engine.get("fixture", "one").value
    expect(item.phase).toBe("implementation")
    expect(item.repairs).toBe(1)
    expect(item.repairFrom?.review?.findings).toEqual([finding])
    expect(item.reason).toContain("P1 src/journal.ts:104-146")
    expect(item.reason).not.toContain("[object Object]")
  })

  it("bounds repairs and revokes verification and review on head movement", () => {
    const f = fixture()
    f.admit("one")
    f.candidate("one")
    f.verify("one")
    const reviewer = f.completed("one", "review")
    expect(() =>
      f.engine.recordReview(f.lease, "one", reviewer, {
        revision: "b".repeat(40),
        accepted: true,
        findings: ["Blocking issue"],
        criteria: []
      })
    ).toThrow("cannot be approved")
    f.engine.recordReview(f.lease, "one", reviewer, {
      revision: "b".repeat(40),
      accepted: false,
      findings: ["Blocking issue"],
      criteria: [{ criterion: "Expected behavior is verified", passed: false, evidence: "Fixture blocking issue" }]
    })
    expect(f.engine.get("fixture", "one").value).toMatchObject({
      phase: "implementation",
      repairs: 1,
      candidate: null,
      verification: null,
      review: null
    })
    f.candidate("one", "f".repeat(40))
    f.verify("one")
    f.engine.recordReview(f.lease, "one", f.completed("one", "review"), {
      revision: "f".repeat(40),
      accepted: true,
      findings: [],
      criteria: [{ criterion: "Expected behavior is verified", passed: true, evidence: "Fixture assertion" }]
    })
    f.engine.invalidateHead(f.lease, "one", "a".repeat(40))
    expect(f.engine.get("fixture", "one").value).toMatchObject({
      phase: "rejected",
      repairs: 2,
      candidate: null,
      verification: null,
      review: null
    })
  })

  it("persists control and evidence across restart and disallows new work while paused", () => {
    const f = fixture()
    f.admit("one")
    f.engine.setControl(f.lease, "frozen", "Operator stop")
    expect(() => f.completed("one", "implementation")).toThrow("paused or frozen")
    expect(() => f.engine.startResearch(f.lease, "two", "backend-engineer", f.source)).toThrow("paused or frozen")
    f.journal.release(f.lease)
    const restarted = new T3Journal(f.path)
    cleanups.push(() => restarted.close())
    const engine = new T3WorkflowEngine(restarted, f.policy, f.personas)
    const lease = restarted.acquire("fixture")!
    expect(engine.control("fixture")).toMatchObject({ mode: "frozen", reason: "Operator stop" })
    expect(engine.get("fixture", "one").value.phase).toBe("implementation")
    engine.setControl(lease, "running", "Explicit operator resume")
    engine.cancel(lease, "one", "Retain evidence and release reservation")
    expect(engine.get("fixture", "one").value.phase).toBe("cancelled")
  })

  it("charges dispatch reservations durably and enforces capacity and time limits", () => {
    const f = fixture({ maxDispatches: 2, maxAdmitted: 1 })
    f.admit("one")
    expect(f.engine.usage("fixture")).toMatchObject({ dispatches: 2, estimatedTokens: 200 })
    expect(() => f.completed("one", "implementation")).toThrow("budget exhausted")
    const expired = new T3WorkflowEngine(f.journal, { ...f.policy, deadline: 1 }, f.personas)
    expect(() => expired.startResearch(f.lease, "two", "backend-engineer", f.source)).toThrow("time budget")
    expect(f.engine.usage("fixture").dispatches).toBe(2)
  })

  it("rejects worker success without settled host identity or with pending descendants", () => {
    const f = fixture()
    f.engine.startResearch(f.lease, "one", "backend-engineer", f.source)
    expect(() =>
      f.engine.completeResearch(f.lease, "one", "forged", { noOp: "Done", inspectedPaths: ["code.ts"] })
    ).toThrow("Observed completed")
    const persona = f.personas.find((p) => p.definition.id === "backend-engineer")!
    f.engine.prepareAssignment(
      f.lease,
      "one",
      {
        id: "pending",
        role: "research",
        personaId: persona.definition.id,
        personaDigest: persona.digest,
        promptDigest: "a".repeat(64),
        providerInstanceId: "fixture",
        revision: f.source.revision
      },
      100
    )
    f.engine.attachTask(f.lease, "one", "pending", "task")
    expect(() =>
      f.engine.settleTask(f.lease, "one", "pending", {
        taskId: "task",
        runId: "run",
        status: "completed",
        hasPendingChildRuns: true
      })
    ).toThrow("not terminal")
    expect(() => f.engine.cancel(f.lease, "one", "Stop")).toThrow("reconcile descendants")
    f.engine.settleTask(f.lease, "one", "pending", {
      taskId: "task",
      runId: "run",
      status: "cancelled",
      hasPendingChildRuns: false
    })
    f.engine.cancel(f.lease, "one", "Stop")
    expect(f.engine.get("fixture", "one").value.phase).toBe("cancelled")
  })
})

describe("publication reservations in ordinary lifecycle", () => {
  function ready(f: ReturnType<typeof fixture>) {
    f.admit("one")
    f.candidate("one")
    f.verify("one")
    f.engine.recordReview(f.lease, "one", f.completed("one", "review"), {
      revision: "b".repeat(40),
      accepted: true,
      findings: [],
      criteria: [{ criterion: "Expected behavior is verified", passed: true, evidence: "fixture" }]
    })
    f.engine.releaseReady(f.lease, "one", f.completed("one", "release"), "b".repeat(40))
    const w = f.engine.get("fixture", "one").value
    const base = {
      projectId: "fixture",
      workflowId: "one",
      revision: w.candidate!.revision,
      treeDigest: w.candidate!.treeDigest,
      scope: w.proposal!.scope,
      estimatedTokens: w.proposal!.estimatedTokens,
      workflowPolicyDigest: w.policyDigest,
      publicationPolicyDigest: digest(T3_PORT_POLICY),
      exportPolicyDigest: digest("exports"),
      evidenceDigest: digest("custody"),
      repository: T3_PORT_POLICY.repository,
      branch: T3_PORT_POLICY.branch,
      tag: "v0.2.0-t3.1",
      ...publicationMetadata(w.candidate!.revision, "v0.2.0-t3.1"),
      assets: ["source.tar", "manifest.json", "SHA256SUMS"].map((name) => ({ name, size: 1, sha256: digest(name) }))
    }
    const publication = new T3Publication(f.engine)
    const plan = publication.prepare(f.lease, { ...base, operations: publicationOperations(base) })
    return { publication, plan }
  }
  it("blocks cancellation, closure and invalidation until sends are disabled and all operations settled", () => {
    const f = fixture(),
      { publication, plan } = ready(f)
    expect(() => f.engine.cancel(f.lease, "one", "cancel")).toThrow("Unsettled publication")
    expect(() => f.engine.invalidateHead(f.lease, "one", "f".repeat(40))).toThrow("Unsettled publication")
    expect(() =>
      f.engine.recordClosure(f.lease, "one", {
        candidateRevision: "b".repeat(40),
        mergedRevision: "f".repeat(40),
        closed: true,
        evidence: "fixture"
      })
    ).toThrow("Unsettled publication")
    publication.settle(f.lease, plan)
    expect(publication.get("fixture", plan).state).toBe("settled")
    expect(() =>
      publication.begin(f.lease, plan, 0, {
        id: "a".repeat(36),
        planDigest: plan,
        effectId: `publication:${plan}:0`,
        index: 0,
        payloadDigest: digest(publication.get("fixture", plan).identity.operations[0]!.payload),
        argvDigest: digest("fixture"),
        owner: f.lease.owner,
        fence: f.lease.fence,
        publicKey: "PUBLIC KEY fixture"
      })
    ).toThrow("disabled")
    f.engine.cancel(f.lease, "one", "disabled before sending")
  })
  it("survives restart and stale terminal workflow flags, preserving scope, capacity and estimated budget", () => {
    const f = fixture({ maxAdmitted: 1 }),
      { plan } = ready(f)
    f.journal.transaction(f.lease, () => {
      const row = f.engine.get("fixture", "one")
      row.value.phase = "cancelled"
      row.value.admitted = false
      f.journal.write("workflow", "one", row.value, row.version)
    })
    f.journal.release(f.lease)
    const j = new T3Journal(f.path)
    cleanups.push(() => j.close())
    const lease = j.acquire("fixture")!,
      engine = new T3WorkflowEngine(j, f.policy, f.personas)
    expect(new T3Publication(engine).get("fixture", plan).state).toBe("open")
    // Use fixture helpers after releasing restarted owner; admission must count terminal reservation.
    j.release(lease)
    const own = f.journal.acquire("fixture")!
    Object.assign(f.lease, own)
    const planner = f.proposal("two", { scope: ["other.ts"] })
    expect(() => f.engine.plan(f.lease, "two", planner, "admit", "fixture", f.source.digest)).toThrow("capacity")
  })
  it("does not double count active workflows and rejects orphan/conflicting reservations", () => {
    const f = fixture(),
      { plan } = ready(f)
    f.admit("two", { scope: ["other.ts"] })
    const third = f.proposal("three", { scope: ["third.ts"] })
    expect(() => f.engine.plan(f.lease, "three", third, "admit", "fixture", f.source.digest)).toThrow("capacity")
    f.journal.transaction(f.lease, () => {
      const row = f.journal.read<any>("fixture", "publication", plan)!
      row.value.identity.workflowId = "missing"
      row.value.planDigest = digest(row.value.identity)
      f.journal.write("publication", row.value.planDigest, row.value, 0)
    })
    expect(() => f.engine.cancel(f.lease, "two", "cancel")).toThrow("Orphan")
  })
  it("retains scope and remaining estimate even for a terminal workflow", () => {
    const f = fixture(),
      { plan } = ready(f)
    f.journal.transaction(f.lease, () => {
      const row = f.engine.get("fixture", "one")
      row.value.phase = "cancelled"
      row.value.admitted = false
      f.journal.write("workflow", "one", row.value, row.version)
    })
    const overlap = f.proposal("scope")
    expect(() => f.engine.plan(f.lease, "scope", overlap, "admit", "fixture", f.source.digest)).toThrow(
      "Scope is reserved"
    )
    const estimate = f.proposal("budget", { scope: ["other.ts"], estimatedTokens: 99_000 })
    expect(() => f.engine.plan(f.lease, "budget", estimate, "admit", "fixture", f.source.digest)).toThrow(
      "estimated token"
    )
    expect(f.journal.read<any>("fixture", "publication", plan)!.value.state).toBe("open")
  })
})
