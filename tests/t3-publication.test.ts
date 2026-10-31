import { execFileSync, spawnSync } from "node:child_process"
import { generateKeyPairSync, randomUUID, sign } from "node:crypto"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  captureT3Source,
  digest,
  expectedPublicationCycle,
  T3_PUBLICATION_LIMITS as L,
  publicationEffectId,
  publicationHash,
  publicationMetadata,
  publicationOperations,
  publicationReservations,
  resolveT3Personas,
  T3_PORT_POLICY,
  T3Journal,
  type T3Policy,
  T3Publication,
  type T3PublicationObservation,
  T3WorkflowEngine,
  validatePublicationCustody
} from "@autocode/t3-runtime"
import { loadProjectProfile } from "@openclaw/project-profiles"
import { afterEach, describe, expect, it } from "vitest"

// Exercise the actual built package and owner adapter. These tests are local fixtures, not qualification.
const adapter = await import("../scripts/t3-port-release.mjs")
const cleanups: Array<() => void> = []
afterEach(() => {
  for (const f of cleanups.splice(0).reverse()) f()
})

function fixture(notesSuffix = "") {
  const dir = mkdtempSync(join(tmpdir(), "t3-publication-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const repository = join(dir, "repo")
  execFileSync("git", ["init", "-q", repository])
  const git = (...args: string[]) => execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" }).trim()
  writeFileSync(join(repository, "package.json"), '{"private":true}\n')
  writeFileSync(join(repository, "code.ts"), "export const n = 1\n")
  const commit = () => {
    git("add", ".")
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture")
  }
  commit()
  const source = captureT3Source(repository)
  writeFileSync(join(repository, "code.ts"), "export const n = 2\n")
  commit()
  git("branch", "-m", T3_PORT_POLICY.branch)
  const candidateSource = captureT3Source(repository)
  const metadata = publicationMetadata(candidateSource.revision, "v0.2.0-t3.1")
  metadata.notes += notesSuffix
  let now = Date.now()
  const j = new T3Journal(join(dir, "state", "journal.sqlite"), () => now)
  cleanups.push(() => j.close())
  const lease = j.acquire("fixture", 3600_000)!
  const policy: T3Policy = {
    goal: "bounded publication",
    lanes: ["backend"],
    maxAdmitted: 1,
    maxDispatches: 20,
    estimatedTokenBudget: 100_000,
    maxRepairs: 1,
    deadline: now + 3600_000,
    rolePersonas: {
      research: ["security-engineer"],
      planner: ["planner"],
      design: ["cto-system-architect"],
      implementation: ["backend-engineer"],
      verification: ["qa-engineer"],
      review: ["code-reviewer"],
      release: ["release-manager"]
    }
  }
  const personas = resolveT3Personas(loadProjectProfile("minimal-repo"))
  const engine = new T3WorkflowEngine(j, policy, personas, () => now)
  const candidate = {
    revision: candidateSource.revision,
    treeDigest: digest({ revision: candidateSource.revision, files: candidateSource.files }),
    changedPaths: ["code.ts"],
    implementationTaskId: "task-implementation"
  }
  const verifierPolicy = {
    image: `sha256:${"a".repeat(64)}`,
    argv: ["/opt/autocode/verifier/check"],
    timeoutMs: 1000,
    maxSourceBytes: 4096,
    maxFileBytes: 1024
  }
  const receipt = {
    identity: { id: "cid", image: verifierPolicy.image },
    cid: "cid",
    cleanup: { status: "VERIFIED_ABSENT" },
    containerExitCode: 0,
    failure: null
  }
  const evidence = {
    revision: candidate.revision,
    treeDigest: candidate.treeDigest,
    policyDigest: digest(verifierPolicy),
    receiptDigest: digest(receipt),
    passed: true,
    isolation: "protected"
  }
  const review = {
    revision: candidate.revision,
    accepted: true,
    findings: [],
    criteria: [{ criterion: "all publication boundaries", passed: true, evidence: "fixture acceptance" }]
  }
  const assignments = (["implementation", "verification", "review", "release"] as const).map((role) => ({
    id: `assignment-${role}`,
    role,
    personaId: policy.rolePersonas[role][0]!,
    personaDigest: personas.find((p) => p.definition.id === policy.rolePersonas[role][0])!.digest,
    promptDigest: digest(role),
    providerInstanceId: "codex",
    revision: role === "implementation" ? source.revision : candidate.revision,
    taskId: `task-${role}`,
    runId: `run-${role}`,
    status: "completed",
    resultApplied: true
  }))
  const w: any = {
    id: "workflow",
    policyDigest: engine.policyDigest,
    source,
    phase: "ready",
    board: "PR approved",
    admitted: true,
    proposal: { scope: ["code.ts"], estimatedTokens: 1000, acceptance: ["all publication boundaries"] },
    candidate,
    verification: evidence,
    review: { ...review, taskId: "task-review" },
    assignments,
    designApproved: true
  }
  j.transaction(lease, () => {
    j.write("workflow", "workflow", w, 0)
    for (const a of assignments) {
      const result =
        a.role === "implementation"
          ? { revision: candidate.revision }
          : a.role === "review"
            ? review
            : a.role === "release"
              ? { ready: true }
              : { analysis: "fixture" }
      const envelope = {
        assignmentId: a.id,
        role: a.role,
        revision: a.revision,
        personaDigest: a.personaDigest,
        promptDigest: a.promptDigest,
        sourceManifestDigest: source.digest,
        result
      }
      j.write("completion", a.id, envelope, 0)
      j.event("completion.observed", a.id, {
        status: "completed",
        runId: a.runId,
        wakeId: a.id,
        receipt: {
          taskId: a.taskId,
          latestTerminalRunId: a.runId,
          latestTerminalStatus: "completed",
          providerInstanceId: "codex",
          hasPendingChildRuns: false,
          hasPendingQuestion: false,
          workState: "result_available",
          summary: JSON.stringify(envelope)
        }
      })
    }
    j.write("verification-receipt", "assignment-verification", { candidate, policy: verifierPolicy, receipt }, 0)
  })
  j.reserveEffect(lease, "verify:assignment-verification", "protected_verification", {
    source: source.digest,
    candidate,
    policy: verifierPolicy
  })
  j.markEffect(lease, "verify:assignment-verification", "prepared", "uncertain")
  j.markEffect(lease, "verify:assignment-verification", "uncertain", "confirmed", { evidence, receipt })
  const exportPolicy = {
    revision: candidate.revision,
    treeDigest: candidate.treeDigest,
    files: candidateSource.files.map((f) => f.path)
  }
  const built = adapter.buildPortAssets(candidateSource, exportPolicy)
  const { privateKey, publicKey } = generateKeyPairSync("ed25519")
  const ci = {
    version: 1,
    headSha: candidate.revision,
    status: "passed",
    startedAt: new Date(now - 3000).toISOString(),
    finishedAt: new Date(now - 1000).toISOString(),
    checks: ["deps:licenses", "deps:audit", "ci"].map((name) => ({
      command: ["pnpm", "run", name],
      exitCode: 0,
      signal: null,
      startedAt: new Date(now - 2500).toISOString(),
      finishedAt: new Date(now - 1500).toISOString()
    }))
  }
  const body = {
    workflowId: "workflow",
    revision: candidate.revision,
    treeDigest: candidate.treeDigest,
    issuedAt: now - 1000,
    expiresAt: now + 1800_000,
    publicationPolicyDigest: digest(T3_PORT_POLICY),
    exportPolicyDigest: digest(exportPolicy),
    archiveDigest: publicationHash(built.assets[0].bytes),
    release: { title: metadata.title, notesSha256: publicationHash(metadata.notes) },
    authorization: {
      repository: T3_PORT_POLICY.repository,
      branch: T3_PORT_POLICY.branch,
      tags: ["v0.2.0-t3.1"],
      deadline: now + 1800_000
    },
    ci: {
      receipt: ci,
      execution: {
        headBefore: candidate.revision,
        headAfter: candidate.revision,
        cleanBefore: true,
        cleanAfter: true,
        receiptDigest: digest(ci),
        terminalId: "ci-terminal",
        exitCode: 0,
        argv: ["pnpm", "ci:agent"]
      }
    },
    qualification: {
      image: verifierPolicy.image,
      policyDigest: digest(verifierPolicy),
      changedPaths: candidate.changedPaths,
      criteria: w.proposal.acceptance,
      terminalId: "qualification",
      cleanup: "VERIFIED_ABSENT",
      negativeControls: ["broken-publication", "hidden-stream"]
    },
    archiveCheck: {
      archiveDigest: publicationHash(built.assets[0].bytes),
      inventoryDigest: built.inventoryDigest,
      checkerImage: verifierPolicy.image,
      terminalId: "archive-terminal",
      cleanup: "VERIFIED_ABSENT"
    }
  }
  const attest = (b = body) => ({
    body: b,
    signature: sign(null, Buffer.from(digest(b)), privateKey).toString("base64")
  })
  const attestation = attest()
  const owner = {
    engine,
    lease,
    source: candidateSource,
    attestation,
    trustedPublicKey: publicKey.export({ type: "spki", format: "pem" }).toString()
  }
  const base = {
    projectId: "fixture",
    workflowId: "workflow",
    revision: candidate.revision,
    treeDigest: candidate.treeDigest,
    scope: w.proposal.scope,
    estimatedTokens: 1000,
    workflowPolicyDigest: engine.policyDigest,
    publicationPolicyDigest: digest(T3_PORT_POLICY),
    exportPolicyDigest: digest(exportPolicy),
    evidenceDigest: digest(attestation),
    repository: T3_PORT_POLICY.repository,
    branch: T3_PORT_POLICY.branch,
    tag: "v0.2.0-t3.1",
    ...metadata,
    assets: built.assets.map((a: any) => ({ name: a.name, size: a.bytes.length, sha256: publicationHash(a.bytes) }))
  }
  const identity = { ...base, operations: publicationOperations(base) }
  const publication = new T3Publication(engine, () => now)
  const observation = (index: number): T3PublicationObservation => ({
    repository: identity.repository,
    tag: identity.tag,
    revision: identity.revision,
    stableLatest: { ...T3_PORT_POLICY.stableLatest },
    release:
      index >= 1
        ? {
            id: 123,
            tag: identity.tag,
            target: identity.revision,
            prerelease: true,
            draft: false,
            title: identity.title,
            body: identity.notes
          }
        : null,
    assets: identity.assets.slice(0, Math.max(0, index - 1)).map((a: any, n: number) => ({ ...a, id: n + 1 })),
    observedAt: now
  })
  return {
    signers: new Map<string, any>(),
    dir,
    j,
    lease,
    engine,
    publication,
    identity,
    observation,
    owner,
    exportPolicy,
    built,
    body,
    attest,
    git,
    candidateSource,
    time: () => now,
    advance: (ms: number) => {
      now += ms
    }
  }
}

// Domain-only signing fixture; actual adapter tests below use a real gh child process.
function invocation(f: ReturnType<typeof fixture>, plan: string, index: number) {
  if (f.signers.has(`${plan}:${index}`)) return f.signers.get(`${plan}:${index}`).value
  const keys = generateKeyPairSync("ed25519")
  const value = {
    id: randomUUID(),
    planDigest: plan,
    effectId: publicationEffectId(plan, index),
    index,
    payloadDigest: digest(f.identity.operations[index]!.payload),
    argvDigest: digest(["fixture", index]),
    owner: f.lease.owner,
    fence: f.lease.fence,
    publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString()
  }
  f.signers.set(`${plan}:${index}`, { value, privateKey: keys.privateKey })
  return value
}
function begin(f: ReturnType<typeof fixture>, lease: any, plan: string, index: number) {
  return f.publication.begin(lease, plan, index, invocation(f, plan, index))
}
function termination(f: ReturnType<typeof fixture>, plan: string, index: number, exitCode = 0) {
  const sender = f.signers.get(`${plan}:${index}`)
  const body = {
    invocation: sender.value,
    pid: 123,
    exitCode,
    signal: null,
    timedOut: false,
    outputLimited: false,
    processGroupAbsent: true,
    startedAt: f.time(),
    endedAt: f.time()
  }
  return { body, signature: sign(null, Buffer.from(digest(body)), sender.privateKey).toString("base64") } as any
}
function terminal(f: ReturnType<typeof fixture>, lease: any, plan: string, index: number) {
  f.publication.terminalSender(lease, plan, index, termination(f, plan, index))
}

function remoteFixture(f: ReturnType<typeof fixture>) {
  const calls: string[][] = []
  const statePath = join(f.dir, "remote.json"),
    bin = join(f.dir, "bin")
  mkdirSync(bin)
  writeFileSync(statePath, JSON.stringify({ tag: false, release: false, uploaded: [], count: 0 }))
  writeFileSync(
    join(bin, "gh"),
    `#!${process.execPath}
const fs = require('node:fs'); const cp = require('node:child_process'); const p=${JSON.stringify(statePath)};
const s=JSON.parse(fs.readFileSync(p)); const a=process.argv.slice(2);
if(a.includes('POST'))s.tag=true;
else if(a[0]==='release' && a[1]==='create'){s.release=true;s.title=a[a.indexOf('--title')+1];s.body=a[a.indexOf('--notes')+1];}
else if(a[0]==='release' && a[1]==='upload')s.uploaded.push(a[3].split('/').at(-1));
else process.exit(99);
const current=s.count++; fs.writeFileSync(p,JSON.stringify(s));
if(s.failAt===current){
 if(s.mode==='nonzero')process.exit(2);
 if(s.mode==='signal')process.kill(process.pid,'SIGTERM');
 if(s.mode==='timeout')setInterval(()=>{},1000);
 if(s.mode==='descendant'){cp.spawn(process.execPath,['-e','setTimeout(()=>{},300)'],{stdio:'ignore'});process.exit(0);}
}
`
  )
  chmodSync(join(bin, "gh"), 0o700)
  const previousPath = process.env.PATH
  process.env.PATH = `${bin}:${previousPath}`
  cleanups.push(() => {
    process.env.PATH = previousPath
  })
  const run = async (_cwd: string, args: string[]) => {
    calls.push(args)
    const state = JSON.parse(readFileSync(statePath, "utf8"))
    const tag = state.tag,
      release = state.release,
      uploaded = state.uploaded.map((name: string, n: number) => ({
        ...f.built.assets.find((a: any) => a.name === name),
        id: n + 1
      }))
    if (args.includes("--include"))
      return Buffer.from('HTTP/2.0 404 Not Found\r\n\r\n{"message":"Branch not protected"}')
    const p = args.at(-1)!
    let value: any
    if (p.endsWith("/")) value = { full_name: T3_PORT_POLICY.repository, default_branch: "master" }
    else if (p.includes("/check-runs?"))
      value = {
        check_runs: [
          {
            name: "AutoCode CI",
            app: { id: 15368 },
            head_sha: f.identity.revision,
            status: "completed",
            conclusion: "success",
            started_at: f.body.ci.receipt.startedAt,
            completed_at: f.body.ci.receipt.finishedAt
          }
        ]
      }
    else if (p.includes("/rules/branches/") || p.includes("/rulesets?")) value = []
    else if (p.includes("/branches/"))
      value = { name: T3_PORT_POLICY.branch, commit: { sha: f.identity.revision }, protected: false }
    else if (p.endsWith("/releases/latest"))
      value = {
        id: T3_PORT_POLICY.stableLatest.id,
        tag_name: T3_PORT_POLICY.stableLatest.tag,
        prerelease: false,
        draft: false
      }
    else if (p.includes("/matching-refs/"))
      value = tag ? [{ ref: `refs/tags/${f.identity.tag}`, object: { type: "commit", sha: f.identity.revision } }] : []
    else if (p.includes("/releases/123/assets"))
      value = uploaded.map((a) => ({ id: a.id, name: a.name, size: a.bytes.length }))
    else if (p.includes("/releases/assets/")) return uploaded.find((a) => a.id === Number(p.split("/").at(-1))).bytes
    else if (p.includes("/releases?"))
      value = release
        ? [
            {
              id: 123,
              tag_name: f.identity.tag,
              target_commitish: f.identity.revision,
              prerelease: true,
              draft: false,
              name: state.title,
              body: state.body
            }
          ]
        : []
    else throw new Error(`Unexpected read ${p}`)
    return Buffer.from(JSON.stringify(value))
  }
  return {
    run,
    calls,
    statePath,
    fail(operation: number, mode: string) {
      const s = JSON.parse(readFileSync(statePath, "utf8"))
      writeFileSync(statePath, JSON.stringify({ ...s, failAt: operation, mode }))
    },
    mutations() {
      return JSON.parse(readFileSync(statePath, "utf8")).count
    }
  }
}

describe("fenced publication domain", () => {
  it("persists complete intent inventory before effects and never settles from a command response", () => {
    const f = fixture(),
      plan = f.publication.prepare(f.lease, f.identity)
    expect(f.j.effects("fixture").filter((e) => e.id.startsWith("publication:"))).toHaveLength(0)
    expect(f.publication.get("fixture", plan).identity.operations).toHaveLength(5)
    begin(f, f.lease, plan, 0)
    expect(f.j.effect(publicationEffectId(plan, 0))?.status).toBe("uncertain")
    expect(() => begin(f, f.lease, plan, 0)).toThrow("never retry")
    expect(() => f.publication.observe(f.lease, plan, 0, f.observation(0))).toThrow("Delayed sender")
    f.publication.settle(f.lease, plan)
    expect(f.publication.get("fixture", plan)).toMatchObject({ state: "open", sendsDisabled: true })
  })
  for (let crashIndex = 0; crashIndex < 5; crashIndex++) {
    it(`retains uncertainty after a lost response at operation ${crashIndex} and settles only after terminal sender observation`, () => {
      const f = fixture(),
        plan = f.publication.prepare(f.lease, f.identity)
      for (let n = 0; n <= crashIndex; n++) {
        begin(f, f.lease, plan, n)
        if (n < crashIndex) {
          terminal(f, f.lease, plan, n)
          f.publication.observe(f.lease, plan, n, f.observation(n))
        }
      }
      const restart = new T3Publication(f.engine)
      expect(() => restart.begin(f.lease, plan, crashIndex, invocation(f, plan, crashIndex))).toThrow("never retry")
      expect(() => restart.observe(f.lease, plan, crashIndex, f.observation(crashIndex))).toThrow("Delayed sender")
      terminal(f, f.lease, plan, crashIndex)
      const bad = f.observation(crashIndex)
      bad.revision = "a".repeat(40)
      expect(() => f.publication.observe(f.lease, plan, crashIndex, bad)).toThrow("conflicts")
      f.publication.observe(f.lease, plan, crashIndex, f.observation(crashIndex))
      f.publication.settle(f.lease, plan, f.observation(crashIndex))
      expect(f.publication.get("fixture", plan).state).toBe("settled")
      expect(f.engine.get("fixture", "workflow").value.phase).toBe("ready")
    })
  }
  it("blocks pause, freeze, expiry and owner replacement between operations", () => {
    for (const mode of ["paused", "frozen"] as const) {
      const f = fixture(),
        plan = f.publication.prepare(f.lease, f.identity)
      f.engine.setControl(f.lease, mode, "fixture")
      expect(() => begin(f, f.lease, plan, 0)).toThrow("paused")
      expect(publicationReservations(f.j, "fixture")).toHaveLength(1)
    }
    const f = fixture(),
      plan = f.publication.prepare(f.lease, f.identity)
    begin(f, f.lease, plan, 0)
    f.advance(3601_000)
    const successor = new T3Journal(f.j.path, f.time)
    cleanups.push(() => successor.close())
    const lease = successor.acquire("fixture", 3600_000)!
    expect(() => terminal(f, f.lease, plan, 0)).toThrow("ownership")
    const engine = new T3WorkflowEngine(successor, f.engine.policy, [...f.engine.personas.values()])
    const p = new T3Publication(engine)
    expect(() => p.terminalSender(lease, plan, 0, undefined as any)).toThrow("termination custody")
    expect(() => p.begin(lease, plan, 0, invocation(f, plan, 0))).toThrow("Invalid original sender")
    p.settle(lease, plan)
    expect(p.get("fixture", plan).state).toBe("open")
  })
  it("rejects payload tampering and conflicting stable/release/assets observations", () => {
    const f = fixture(),
      plan = f.publication.prepare(f.lease, f.identity)
    begin(f, f.lease, plan, 0)
    terminal(f, f.lease, plan, 0)
    const o = f.observation(0)
    o.stableLatest.id++
    expect(() => f.publication.observe(f.lease, plan, 0, o)).toThrow("conflicts")
    f.j.transaction(f.lease, () => {
      const r = f.j.read<any>("fixture", "publication", plan)!
      r.value.identity.operations[0].payload.sha = "bad"
      f.j.write("publication", plan, r.value, r.version)
    })
    expect(() => f.publication.get("fixture", plan)).toThrow("Malformed")
  })
})

describe("retained owner custody", () => {
  it("validates signatures and independently retained completions, terminal observations and protected receipts", () => {
    const f = fixture()
    expect(
      validatePublicationCustody(f.engine, "fixture", "workflow", f.owner.attestation, f.owner.trustedPublicKey)
    ).toBe(digest(f.owner.attestation))
    const bad = structuredClone(f.owner.attestation)
    bad.body.ci.receipt.status = "failed"
    expect(() => validatePublicationCustody(f.engine, "fixture", "workflow", bad, f.owner.trustedPublicKey)).toThrow(
      "signature"
    )
    f.j.transaction(f.lease, () => {
      const r = f.j.read<any>("fixture", "completion", "assignment-release")!
      r.value.result.ready = false
      f.j.write("completion", "assignment-release", r.value, r.version)
    })
    expect(() =>
      validatePublicationCustody(f.engine, "fixture", "workflow", f.owner.attestation, f.owner.trustedPublicKey)
    ).toThrow("terminal custody")
  })
  for (const kind of ["ci-skipped", "ci-execution", "stale", "qualification", "archive", "candidate", "policy"]) {
    it(`rejects signed but insufficient ${kind} custody`, () => {
      const f = fixture(),
        b = structuredClone(f.body)
      if (kind === "ci-skipped") b.ci.receipt.checks[1]!.exitCode = 1
      if (kind === "ci-execution") b.ci.execution.cleanAfter = false
      if (kind === "stale") b.expiresAt = Date.now() - 1
      if (kind === "qualification") b.qualification.changedPaths = []
      if (kind === "archive") b.archiveCheck.cleanup = "unknown"
      if (kind === "candidate") b.treeDigest = "e".repeat(64)
      if (kind === "policy") b.publicationPolicyDigest = "f".repeat(64)
      expect(() =>
        validatePublicationCustody(f.engine, "fixture", "workflow", f.attest(b), f.owner.trustedPublicKey)
      ).toThrow()
    })
  }
})

describe("owner adapter and bounded source archives", () => {
  it("executes all separately journaled operations with exact arguments and downloaded-byte reconciliation", async () => {
    const f = fixture(),
      host = remoteFixture(f)
    const prepared = await adapter.preparePortPublication(f.owner, "workflow", f.identity.tag, f.exportPolicy, host.run)
    const files = join(f.dir, "assets")
    mkdirSync(files)
    for (const a of prepared.assets) writeFileSync(join(files, a.name), a.bytes)
    for (let n = 0; n < f.identity.operations.length; n++)
      await adapter.sendPortOperation(
        f.owner,
        prepared.plan,
        n,
        n >= 2 ? join(files, f.identity.assets[n - 2]!.name) : undefined,
        host.run
      )
    const r = await adapter.reconcilePortPublication(f.owner, prepared.plan, host.run)
    expect(r.state).toBe("settled")
    const args = adapter.operationArguments(f.identity, 1)
    for (const value of [
      "--repo",
      T3_PORT_POLICY.repository,
      "--target",
      f.identity.revision,
      "--verify-tag",
      "--prerelease",
      "--latest=false"
    ])
      expect(args).toContain(value)
    expect(host.mutations()).toBe(5)
    expect(host.calls.flat()).not.toContain("--clobber")
    await expect(
      adapter.preparePortPublication(f.owner, "workflow", f.identity.tag, f.exportPolicy, host.run)
    ).rejects.toThrow("collides")
  })
  it("blocks sends when an already observed release is replaced", async () => {
    const f = fixture(),
      host = remoteFixture(f)
    const prepared = await adapter.preparePortPublication(f.owner, "workflow", f.identity.tag, f.exportPolicy, host.run)
    await adapter.sendPortOperation(f.owner, prepared.plan, 0, undefined, host.run)
    await adapter.sendPortOperation(f.owner, prepared.plan, 1, undefined, host.run)
    const run = async (cwd: string, args: string[]) => {
      if (args.at(-1)?.includes("/releases/124/assets?")) return Buffer.from("[]")
      const result = await host.run(cwd, args)
      if (args.at(-1)?.includes("/releases?")) {
        const releases = JSON.parse(result.toString())
        for (const release of releases) release.id++
        return Buffer.from(JSON.stringify(releases))
      }
      return result
    }
    await expect(adapter.sendPortOperation(f.owner, prepared.plan, 2, "/unused", run)).rejects.toThrow(
      "identity changed before send"
    )
    expect(host.calls.some((args) => args[0] === "release" && args[1] === "upload")).toBe(false)
  })
  it("blocks mismatched repository/branch/candidate, dirty source and unauthorized tags before mutation", async () => {
    const f = fixture(),
      host = remoteFixture(f)
    await expect(
      adapter.requiredPortCi("wrong/repo", f.candidateSource.repository, f.identity.revision, host.run)
    ).rejects.toThrow("repository")
    await expect(
      adapter.preparePortPublication(f.owner, "workflow", "v0.1.0.8", f.exportPolicy, host.run)
    ).rejects.toThrow("tag")
    f.git("branch", "-m", "wrong")
    await expect(
      adapter.preparePortPublication(f.owner, "workflow", f.identity.tag, f.exportPolicy, host.run)
    ).rejects.toThrow("wrong-branch")
    f.git("branch", "-m", T3_PORT_POLICY.branch)
    writeFileSync(join(f.candidateSource.repository, "code.ts"), "dirty")
    await expect(
      adapter.preparePortPublication(f.owner, "workflow", f.identity.tag, f.exportPolicy, host.run)
    ).rejects.toThrow("uncommitted")
    expect(host.calls).toHaveLength(0)
  })
  it("fails closed on new branch protections and inaccessible policy", async () => {
    const f = fixture(),
      host = remoteFixture(f)
    const run = async (cwd: string, args: string[]) =>
      args.at(-1)?.includes("/rulesets?") ? Buffer.from('[{"id":1}]') : host.run(cwd, args)
    await expect(
      adapter.discoverPortPolicy(f.identity.repository, f.candidateSource.repository, f.identity.revision, run)
    ).rejects.toThrow("protection")
    await expect(
      adapter.discoverPortPolicy(f.identity.repository, f.candidateSource.repository, f.identity.revision, async () => {
        throw new Error("inaccessible")
      })
    ).rejects.toThrow("inaccessible")
  })
  it("rejects hidden trailing streams, mutations, duplicate inventory and oversized expansion", () => {
    const f = fixture(),
      tar = f.built.assets[0].bytes
    const manifest = JSON.parse(f.built.assets[1].bytes.toString())
    expect(adapter.inspectPortArchive(tar, manifest.inventory)).toBe(f.built.inventoryDigest)
    expect(() => adapter.inspectPortArchive(Buffer.concat([tar, tar]), manifest.inventory)).toThrow("trailing")
    const changed = Buffer.from(tar)
    changed[512] ^= 1
    expect(() => adapter.inspectPortArchive(changed, manifest.inventory)).toThrow("bytes mismatch")
    expect(() => adapter.inspectPortArchive(tar, [...manifest.inventory, manifest.inventory[0]])).toThrow("Duplicate")
    expect(() => adapter.inspectPortArchive(Buffer.alloc(L.archiveBytes + 512), [])).toThrow("bound")
    expect(() => adapter.buildPortAssets(f.candidateSource, { ...f.exportPolicy, files: ["code.ts"] })).toThrow(
      "build inputs"
    )
  })
  for (const path of [
    "../escape",
    "/absolute",
    ".git/config",
    ".env",
    "private/key",
    "briefs/input",
    "journal.sqlite",
    "receipts/raw",
    "dist/index.js",
    "a\\b",
    "a\0b",
    "a/./b"
  ]) {
    it(`rejects unsafe export ${JSON.stringify(path)}`, () => {
      const f = fixture()
      expect(() =>
        adapter.buildPortAssets(f.candidateSource, { ...f.exportPolicy, files: [...f.exportPolicy.files, path] })
      ).toThrow()
    })
  }
  it("bounds subprocess time and output", () => {
    expect(() =>
      adapter.boundedCommand(process.execPath, ["-e", 'process.stdout.write("x".repeat(2048))'], process.cwd(), 32)
    ).toThrow("Bounded")
    expect(() => adapter.boundedCommand(process.execPath, ["-e", "process.exit(2)"], process.cwd())).toThrow(
      "known local termination"
    )
  })
})

describe("public required-CI package boundary and executable", () => {
  it("loads the built public export and runs the actual read-only CLI against an exact repository-bound fixture", async () => {
    const cwd = process.cwd(),
      dir = mkdtempSync(join(tmpdir(), "t3-ci-cli-"))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const script = join(dir, "gh")
    writeFileSync(
      script,
      `#!${process.execPath}\nconst p=process.argv.at(-1);if(!p.startsWith('repos/Dikkekip/AutoCode/commits/${"a".repeat(40)}/check-runs?'))process.exit(9);console.log(JSON.stringify({check_runs:[{name:'AutoCode CI',app:{id:15368},head_sha:'${"a".repeat(40)}',status:'completed',conclusion:'success',started_at:new Date(Date.now()-2000).toISOString(),completed_at:new Date(Date.now()-1000).toISOString()}]}));\n`
    )
    chmodSync(script, 0o700)
    const result = spawnSync(
      process.execPath,
      [
        resolve("scripts/t3-port-release.mjs"),
        "check-ci",
        "--repository",
        T3_PORT_POLICY.repository,
        "--candidate",
        "a".repeat(40)
      ],
      { cwd, encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } }
    )
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain("not publication authority")
    const entry = await import("@openclaw/core-runtime/required-ci")
    expect(typeof entry.assertNativeRequiredCi).toBe("function")
    const mutation = spawnSync(process.execPath, [resolve("scripts/t3-port-release.mjs"), "publish"], {
      cwd,
      encoding: "utf8"
    })
    expect(mutation.status).toBe(1)
    expect(mutation.stderr).toContain("existing in-process owner")
  })
  it("rejects duplicate, stale, failed, skipped, wrong-SHA and missing checks and bounds API pages/bytes", async () => {
    const f = fixture(),
      host = remoteFixture(f)
    const good = JSON.parse((await host.run("", ["api", "repos/Dikkekip/AutoCode/commits/sha/check-runs?"])).toString())
      .check_runs[0]
    for (const runs of [
      [],
      [good, good],
      [{ ...good, conclusion: "skipped" }],
      [{ ...good, status: "queued" }],
      [{ ...good, conclusion: "failure" }],
      [{ ...good, head_sha: "b".repeat(40) }],
      [{ ...good, completed_at: "2020-01-01T00:00:00Z" }]
    ]) {
      await expect(
        adapter.requiredPortCi(f.identity.repository, process.cwd(), f.identity.revision, async () =>
          Buffer.from(JSON.stringify({ check_runs: runs }))
        )
      ).rejects.toThrow()
    }
    await expect(
      adapter.requiredPortCi(f.identity.repository, process.cwd(), f.identity.revision, async () =>
        Buffer.alloc(L.outputBytes + 1)
      )
    ).rejects.toThrow("response bound")
    await expect(
      adapter.requiredPortCi(f.identity.repository, process.cwd(), f.identity.revision, async () =>
        Buffer.from(JSON.stringify({ check_runs: Array(100).fill(good) }))
      )
    ).rejects.toThrow("pagination bound")
  })
  it("has distinct hosted job names and dedicated delivery-branch pushes", () => {
    const ci = readFileSync(".github/workflows/ci.yml", "utf8"),
      readiness = readFileSync(".github/workflows/release-readiness.yml", "utf8")
    expect(ci).toContain(`      - ${T3_PORT_POLICY.branch}`)
    expect(ci).toContain("    name: AutoCode CI")
    expect(readiness).toContain("    name: AutoCode Release Readiness")
    expect(readiness).toContain("types: [published]")
  })
})

describe("publication interruption and resource negative controls", () => {
  for (let operation = 0; operation < 5; operation++) {
    it(`does not retry after actual adapter loses response to mutation ${operation}`, async () => {
      const f = fixture(),
        host = remoteFixture(f)
      const prepared = await adapter.preparePortPublication(
        f.owner,
        "workflow",
        f.identity.tag,
        f.exportPolicy,
        host.run
      )
      const dir = join(f.dir, "assets")
      mkdirSync(dir)
      for (const a of prepared.assets) writeFileSync(join(dir, a.name), a.bytes)
      for (let n = 0; n < operation; n++)
        await adapter.sendPortOperation(
          f.owner,
          prepared.plan,
          n,
          n >= 2 ? join(dir, f.identity.assets[n - 2]!.name) : undefined,
          host.run
        )
      host.fail(operation, "signal")
      await expect(
        adapter.sendPortOperation(
          f.owner,
          prepared.plan,
          operation,
          operation >= 2 ? join(dir, f.identity.assets[operation - 2]!.name) : undefined,
          host.run
        )
      ).rejects.toThrow("uncertain")
      const r = await adapter.reconcilePortPublication(f.owner, prepared.plan, host.run)
      expect(r.state).toBe("open")
      expect(r.sendsDisabled).toBe(true)
      expect(f.j.effect(publicationEffectId(prepared.plan, operation))?.status).toBe("uncertain")
      expect(host.mutations()).toBe(operation + 1)
      expect(publicationReservations(f.j, "fixture")).toHaveLength(1)
    })
  }
  it("retains reservation through effect preparation and uncertainty crashes", () => {
    const f = fixture(),
      plan = f.publication.prepare(f.lease, f.identity)
    const op = f.identity.operations[0]!
    // Crash after immutable inventory, before reserveEffect.
    expect(publicationReservations(f.j, "fixture")).toHaveLength(1)
    f.j.reserveEffect(f.lease, publicationEffectId(plan, 0), "publication.tag", op.payload)
    // Crash after effect preparation, before uncertain/sender record. Restart may safely disable this unsent inventory.
    expect(f.j.effect(publicationEffectId(plan, 0))?.status).toBe("prepared")
    f.publication.settle(f.lease, plan)
    expect(f.publication.get("fixture", plan).dispositions["0"]).toBe("disabled-unsent")
    expect(() => begin(f, f.lease, plan, 0)).toThrow("disabled")
  })
  it("never accepts missing or conflicting release or downloaded assets", () => {
    const f = fixture(),
      plan = f.publication.prepare(f.lease, f.identity)
    for (let n = 0; n < 2; n++) {
      begin(f, f.lease, plan, n)
      terminal(f, f.lease, plan, n)
      if (n === 1) {
        for (const release of [
          null,
          { ...f.observation(1).release!, prerelease: false },
          { ...f.observation(1).release!, target: "a".repeat(40) }
        ])
          expect(() => f.publication.observe(f.lease, plan, 1, { ...f.observation(1), release })).toThrow("conflicts")
      }
      f.publication.observe(f.lease, plan, n, f.observation(n))
    }
    begin(f, f.lease, plan, 2)
    terminal(f, f.lease, plan, 2)
    expect(() => f.publication.observe(f.lease, plan, 2, { ...f.observation(2), assets: [] })).toThrow("asset")
    const bad = f.observation(2)
    bad.assets[0]!.sha256 = "f".repeat(64)
    expect(() => f.publication.observe(f.lease, plan, 2, bad)).toThrow("asset")
    const changed = f.observation(2)
    changed.release!.id++
    expect(() => f.publication.observe(f.lease, plan, 2, changed)).toThrow("identity changed")
    f.publication.observe(f.lease, plan, 2, f.observation(2))
    const replaced = f.observation(2)
    replaced.assets[0]!.id++
    expect(() => f.publication.observe(f.lease, plan, 2, replaced)).toThrow("asset changed")
    expect(() => f.publication.observe(f.lease, plan, 2, { ...f.observation(2), assets: [] })).toThrow("asset changed")
  })
  it("exceeds file count, individual blob and aggregate source bounds", () => {
    const f = fixture()
    const files = Array.from({ length: L.files + 1 }, (_, n) => `file-${n}`)
    expect(() => adapter.buildPortAssets(f.candidateSource, { ...f.exportPolicy, files })).toThrow("allowlist")
    writeFileSync(join(f.candidateSource.repository, "large"), Buffer.alloc(L.fileBytes + 1))
    f.git("add", ".")
    f.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "large")
    let source = captureT3Source(f.candidateSource.repository)
    const policy = () => ({
      revision: source.revision,
      treeDigest: digest({ revision: source.revision, files: source.files }),
      files: source.files.map((x) => x.path)
    })
    expect(() => adapter.buildPortAssets(source, policy())).toThrow("byte bound")
    rmSync(join(source.repository, "large"))
    for (let n = 0; n < 9; n++) writeFileSync(join(source.repository, `blob-${n}`), Buffer.alloc(L.fileBytes, n))
    f.git("add", ".")
    f.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "aggregate")
    source = captureT3Source(source.repository)
    expect(() => adapter.buildPortAssets(source, policy())).toThrow("byte bound")
  })
  it("rejects symlink/gitlink exports and unreviewed generated paths", () => {
    const f = fixture()
    f.git("update-index", "--add", "--cacheinfo", "120000", f.candidateSource.files[0]!.objectId, "link")
    f.git("update-index", "--add", "--cacheinfo", "160000", f.identity.revision, "submodule")
    f.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "unsafe")
    // Source-current checks reject missing working tree entries as well as unsafe modes.
    const source = captureT3Source(f.candidateSource.repository)
    expect(() =>
      adapter.buildPortAssets(source, {
        revision: source.revision,
        treeDigest: digest({ revision: source.revision, files: source.files }),
        files: source.files.map((x) => x.path)
      })
    ).toThrow()
  })
  it("bounds operation time, asset count/size, aggregate assets and policy API pagination", async () => {
    const f = fixture()
    expect(() =>
      adapter.boundedCommand(process.execPath, ["-e", "setInterval(()=>{},1000)"], process.cwd(), 1024, 20)
    ).toThrow("uncertain")
    for (const assets of [
      Array.from({ length: L.assets + 1 }, (_, n) => ({ name: `asset-${n}`, size: 1, sha256: "a".repeat(64) })),
      [{ name: "large", size: L.assetBytes + 1, sha256: "a".repeat(64) }, ...f.identity.assets],
      f.identity.assets.map((a) => ({ ...a, size: L.assetBytes }))
    ]) {
      const base = { ...f.identity, assets },
        identity = { ...base, operations: publicationOperations(base) }
      expect(() => f.publication.prepare(f.lease, identity)).toThrow()
    }
    const host = remoteFixture(f)
    await expect(
      adapter.discoverPortPolicy(
        f.identity.repository,
        f.candidateSource.repository,
        f.identity.revision,
        async (cwd: string, args: string[]) =>
          args.at(-1)?.includes("rulesets?")
            ? Buffer.from(JSON.stringify(Array(100).fill({ id: 1 })))
            : host.run(cwd, args)
      )
    ).rejects.toThrow("pagination bound")
  })
})

describe("original sender termination and exact release metadata", () => {
  for (let operation = 0; operation < 5; operation++) {
    it(`settles remote acceptance followed by original nonzero process exit at operation ${operation}`, async () => {
      const f = fixture(),
        host = remoteFixture(f)
      const prepared = await adapter.preparePortPublication(
        f.owner,
        "workflow",
        f.identity.tag,
        f.exportPolicy,
        host.run
      )
      const dir = join(f.dir, "assets")
      mkdirSync(dir)
      for (const a of prepared.assets) writeFileSync(join(dir, a.name), a.bytes)
      const assetPath = (n: number) => (n >= 2 ? join(dir, f.identity.assets[n - 2]!.name) : undefined)
      for (let n = 0; n < operation; n++)
        await adapter.sendPortOperation(f.owner, prepared.plan, n, assetPath(n), host.run)
      host.fail(operation, "nonzero")
      await expect(
        adapter.sendPortOperation(f.owner, prepared.plan, operation, assetPath(operation), host.run)
      ).rejects.toMatchObject({ outcome: { terminal: true, exitCode: 2 } })
      const retained = new T3Publication(f.engine).get("fixture", prepared.plan)
      expect(retained.senders[String(operation)]!.termination!.body).toMatchObject({
        exitCode: 2,
        processGroupAbsent: true
      })
      expect(f.j.effect(publicationEffectId(prepared.plan, operation))?.status).toBe("uncertain")
      // A replacement domain object recovers retained ORIGINAL invocation evidence; it never sends.
      const settled = await adapter.reconcilePortPublication(f.owner, prepared.plan, host.run)
      expect(settled).toMatchObject({ state: "settled", sendsDisabled: true })
      expect(f.j.effect(publicationEffectId(prepared.plan, operation))?.status).toBe("confirmed")
      expect(host.mutations()).toBe(operation + 1)
      expect(f.engine.get("fixture", "workflow").value.phase).toBe("ready")
    })
    it(`retains uncertainty without original runner custody at boundary ${operation}`, () => {
      const f = fixture(),
        plan = f.publication.prepare(f.lease, f.identity)
      for (let n = 0; n <= operation; n++) {
        begin(f, f.lease, plan, n)
        if (n < operation) {
          terminal(f, f.lease, plan, n)
          f.publication.observe(f.lease, plan, n, f.observation(n))
        }
      }
      // Actual remote presence alone cannot prove the original process or descendants stopped.
      expect(() => f.publication.observe(f.lease, plan, operation, f.observation(operation))).toThrow("Delayed sender")
      f.publication.settle(f.lease, plan, f.observation(operation))
      expect(publicationReservations(f.j, "fixture")).toHaveLength(1)
    })
  }
  for (let operation = 0; operation < 5; operation++) {
    it(`retains original timeout and descendant uncertainty after remote acceptance at operation ${operation}`, async () => {
      for (const mode of ["timeout", "descendant"]) {
        const f = fixture(),
          host = remoteFixture(f)
        const prepared = await adapter.preparePortPublication(
          f.owner,
          "workflow",
          f.identity.tag,
          f.exportPolicy,
          host.run
        )
        const dir = join(f.dir, "assets")
        mkdirSync(dir)
        for (const a of prepared.assets) writeFileSync(join(dir, a.name), a.bytes)
        const assetPath = (n: number) => (n >= 2 ? join(dir, f.identity.assets[n - 2]!.name) : undefined)
        for (let n = 0; n < operation; n++)
          await adapter.sendPortOperation(f.owner, prepared.plan, n, assetPath(n), host.run)
        host.fail(operation, mode)
        ;(f.owner as any).senderTimeoutMs = 100
        await expect(
          adapter.sendPortOperation(f.owner, prepared.plan, operation, assetPath(operation), host.run)
        ).rejects.toMatchObject({ outcome: { terminal: false } })
        const r = await adapter.reconcilePortPublication(f.owner, prepared.plan, host.run)
        expect(r).toMatchObject({ state: "open", sendsDisabled: true })
        expect(r.senders[String(operation)]!.termination).toBeNull()
        expect(f.j.effect(publicationEffectId(prepared.plan, operation))?.status).toBe("uncertain")
        expect(host.mutations()).toBe(operation + 1)
      }
    })
  }
  it("rejects forged, wrong-identity, signaled and timeout termination proofs, and supports original signed recovery under a successor", () => {
    const f = fixture(),
      plan = f.publication.prepare(f.lease, f.identity)
    begin(f, f.lease, plan, 0)
    const valid = termination(f, plan, 0, 2)
    for (const change of [
      (p: any) => {
        p.body.invocation.index++
      },
      (p: any) => {
        p.body.invocation.owner = "replacement"
      },
      (p: any) => {
        p.body.invocation.argvDigest = "a".repeat(64)
      },
      (p: any) => {
        p.signature = "forged"
      },
      (p: any) => {
        p.body.signal = "SIGTERM"
      },
      (p: any) => {
        p.body.timedOut = true
      },
      (p: any) => {
        p.body.processGroupAbsent = false
      }
    ]) {
      const bad = structuredClone(valid)
      change(bad)
      expect(() => f.publication.terminalSender(f.lease, plan, 0, bad)).toThrow("termination custody")
    }
    f.j.release(f.lease)
    const j = new T3Journal(f.j.path, f.time)
    cleanups.push(() => j.close())
    const lease = j.acquire("fixture", 3600_000)!,
      engine = new T3WorkflowEngine(j, f.engine.policy, [...f.engine.personas.values()], f.time)
    const p = new T3Publication(engine, f.time)
    p.terminalSender(lease, plan, 0, valid)
    p.observe(lease, plan, 0, f.observation(0))
    p.settle(lease, plan, f.observation(0))
    expect(p.get("fixture", plan).state).toBe("settled")
  })
  for (const field of ["title", "body"] as const) {
    for (const variation of ["missing", "empty", "altered", "newline", "unicode"]) {
      it(`blocks ${variation} remote ${field} at release, asset and settlement boundaries`, async () => {
        const f = fixture("Cafe\u0301\n"),
          host = remoteFixture(f)
        const prepared = await adapter.preparePortPublication(
          f.owner,
          "workflow",
          f.identity.tag,
          f.exportPolicy,
          host.run,
          { title: f.identity.title, notes: f.identity.notes }
        )
        await adapter.sendPortOperation(f.owner, prepared.plan, 0, undefined, host.run)
        await adapter.sendPortOperation(f.owner, prepared.plan, 1, undefined, host.run)
        const run = async (cwd: string, args: string[]) => {
          const result = await host.run(cwd, args)
          if (!args.at(-1)?.includes("/releases?")) return result
          const releases = JSON.parse(result.toString())
          for (const release of releases) {
            const key = field === "title" ? "name" : "body"
            if (variation === "missing") delete release[key]
            if (variation === "empty") release[key] = ""
            if (variation === "altered") release[key] += "changed"
            if (variation === "newline")
              release[key] = release[key].replaceAll("\n", "\r\n") + (field === "title" ? "\n" : "")
            if (variation === "unicode")
              release[key] = field === "body" ? release[key].normalize("NFC") : release[key] + "é"
          }
          return Buffer.from(JSON.stringify(releases))
        }
        await expect(adapter.sendPortOperation(f.owner, prepared.plan, 2, "/unused", run)).rejects.toThrow("metadata")
        const r = await adapter.reconcilePortPublication(f.owner, prepared.plan, run)
        expect(r).toMatchObject({ state: "open", sendsDisabled: true })
        expect(publicationReservations(f.j, "fixture")).toHaveLength(1)
        expect(host.mutations()).toBe(2)
      })
    }
  }
  it("binds approved exact UTF-8 metadata in arguments and expected cycle hashes, rejecting lossy and tampered plans", async () => {
    const f = fixture("Cafe\u0301\n"),
      host = remoteFixture(f)
    const prepared = await adapter.preparePortPublication(
      f.owner,
      "workflow",
      f.identity.tag,
      f.exportPolicy,
      host.run,
      { title: f.identity.title, notes: f.identity.notes }
    )
    const r = new T3Publication(f.engine).get("fixture", prepared.plan)
    const args = adapter.operationArguments(r.identity, 1)
    expect(args[args.indexOf("--title") + 1]).toBe(f.identity.title)
    expect(args[args.indexOf("--notes") + 1]).toBe(f.identity.notes)
    expect(expectedPublicationCycle(r.identity)).toEqual({
      commit: f.identity.revision,
      title: f.identity.title,
      notesSha256: publicationHash(f.identity.notes),
      assets: Object.fromEntries(f.identity.assets.map((a) => [a.name, a.sha256]))
    })
    expect(publicationHash(f.identity.notes)).not.toBe(publicationHash(f.identity.notes.normalize("NFC")))
    for (const notes of [f.identity.notes + "\ud800", f.identity.notes.trim(), f.identity.notes.normalize("NFC")]) {
      const identity = { ...f.identity, notes }
      expect(() => f.publication.prepare(f.lease, { ...identity, operations: f.identity.operations })).toThrow()
    }
  })
})
