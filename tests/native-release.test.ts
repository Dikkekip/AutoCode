import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { nativeCanaryScopeDigest, nativePromotionDigest } from "../packages/core-runtime/src/native/promotion-mode.js"
import {
  assertNativeProvenance,
  nativeContentDigest,
  nativeRepositoryIdentity,
  nativeVerificationDigest
} from "../packages/core-runtime/src/native/provenance.js"
import * as releaseModule from "../packages/core-runtime/src/native/release.js"
import {
  type NativeReleaseIO,
  NativeReleasePending,
  releaseNativeWorkflow
} from "../packages/core-runtime/src/native/release.js"
import { NativeAutonomyRuntime, type NativeWorkflow } from "../packages/core-runtime/src/native/runtime.js"
import { NativeEvidenceStore } from "../packages/core-runtime/src/native/store.js"
import * as verificationModule from "../packages/core-runtime/src/native/verification.js"
import { planNativeVerification } from "../packages/core-runtime/src/native/verification.js"
import { nativeVerificationRuleId, validateNativeAutonomyPolicy } from "../packages/domain/src/native-autonomy.js"

const cleanup: Array<() => void> = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const fn of cleanup.splice(0)) fn()
})
function setup(mode: "release" | "verification" | "implementation" = "release") {
  const root = mkdtempSync(join(tmpdir(), "native-release-"))
  const store = new NativeEvidenceStore(join(root, "evidence.db"))
  cleanup.push(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  const policy = validateNativeAutonomyPolicy({
    version: 1,
    mode: mode === "release" ? "staging-canary" : "implement-human-review",
    budgets: {
      version: 1,
      limits: {
        project: { actions: 1000 },
        day: { actions: 1000 },
        workflow: { actions: 100 },
        attempt: { actions: 100 }
      },
      safetyReserve: { actions: 5 },
      unknownUsage: "hold",
      estimates: {
        release: { actions: 1 },
        deployment: { actions: 1 },
        rollback: { actions: 1 },
        verify: { actions: 1 },
        implement: { actions: 1 },
        review: { actions: 1 }
      }
    },
    enabled: true,
    boardId: "app",
    repository: root,
    repositoryKind: "application",
    baseBranch: "main",
    plannerAgentId: "planner",
    coderAgentId: "coder",
    reviewerAgentId: "reviewer",
    personas: [
      { personaId: "legal", goals: ["goal"], successObservations: ["outcome"], allowedPaths: ["src"], weight: 1 }
    ],
    verification: [{ id: "check", argv: ["/opt/openclaw/checks/test"], cwd: "." }],
    verificationAuthority: {
      reviewedRevision: "d".repeat(40),
      acceptance: [{ criterion: "outcome", ruleIds: ["check"] }]
    },
    requiredCi: { checks: [{ name: "CI", appId: 1 }], maxAgeSeconds: 86400 },
    deployment: {
      environment: "staging",
      targetId: "test-target",
      artifactSha256: "e".repeat(64),
      previousKnownGood: { revision: "b".repeat(40), artifactSha256: "f".repeat(64) },
      observationSeconds: 1,
      reconciliationSeconds: 600,
      authorized: true,
      command: { argv: ["deploy"], cwd: "." },
      check: { argv: ["check"], cwd: "." }
    }
  })
  const cards: Record<string, any> = { root: { id: "root", title: "Root", status: "blocked" } }
  const gateway = {
    request: vi.fn(async (method: string, params: Record<string, any>): Promise<any> => {
      if (method === "workboard.cards.list") return { cards: Object.values(cards) }
      if (method === "workboard.cards.create") {
        const id = params.idempotencyKey
        cards[id] ??= { ...params, id }
        return { card: cards[id] }
      }
      if (method === "workboard.cards.move") cards[params.id].status = params.status
      return {}
    })
  }
  const runtime = new NativeAutonomyRuntime(policy, gateway, store)
  const headSha = "a".repeat(40),
    baseSha = "b".repeat(40),
    mergedSha = "c".repeat(40)
  const artifact = join(root, "check.json")
  writeFileSync(artifact, JSON.stringify({ exitCode: 0, startedAt: "start", finishedAt: "end" }))
  const artifactSha256 = createHash("sha256")
    .update(JSON.stringify({ exitCode: 0, startedAt: "start", finishedAt: "end" }))
    .digest("hex")
  const workflow: NativeWorkflow = {
    submission: { agentId: "coder", sessionKey: "coder-session", executionId: "coder-execution" },
    proposal: {
      personaId: "legal",
      goal: "goal",
      title: "Change",
      evidence: [],
      allowedPaths: ["src"],
      acceptance: ["outcome"],
      alternatives: [],
      implementationPrompt: "code"
    },
    rootCardId: "root",
    implementationCardId: "implementation",
    stageCards: {},
    prNumber: 12,
    candidate: { cwd: root, headSha, baseSha, branch: "candidate", files: ["src/a"] },
    verification: {
      headSha,
      baseSha,
      plan: planNativeVerification(policy, ["src/a"]),
      acceptance: [{ criterion: "outcome", ruleIds: ["check"] }],
      checks: [
        {
          ruleId: nativeVerificationRuleId(policy.verification[0]!),
          argv: ["test"],
          cwd: root,
          exitCode: 0,
          startedAt: "start",
          finishedAt: "end",
          artifact,
          artifactSha256
        }
      ]
    },
    review: {
      headSha,
      agentId: "reviewer",
      sessionKey: "review-session",
      verdict: "approved",
      rationale: "Independent inspection"
    }
  }
  let clock = Date.now()
  const advanceClock = () => (clock += 1100)
  let merged = false,
    published = false,
    remoteHead = ""
  const io: NativeReleaseIO = {
    now: advanceClock,
    git: vi.fn(async (_cwd, ...args) => {
      if (args[0] === "push") {
        remoteHead = headSha
        return ""
      }
      if (args[0] === "ls-remote") return remoteHead ? `${remoteHead}\trefs/heads/candidate` : ""
      if (args[0] === "diff") return args.includes("--raw") ? `:100644 100644 ${baseSha} ${headSha} M\0src/a\0` : ""
      return args[0] === "status" ? "" : args[1] === "HEAD" ? headSha : baseSha
    }),
    github: vi.fn(async (_cwd, args) => {
      if (args[0] === "api")
        return args.some((arg) => arg.includes("check-runs"))
          ? JSON.stringify([
              {
                check_runs: [
                  {
                    name: "CI",
                    app: { id: 1 },
                    head_sha: headSha,
                    status: "completed",
                    conclusion: "success",
                    started_at: new Date(Date.now() - 1000).toISOString(),
                    completed_at: new Date(Date.now() - 100).toISOString()
                  }
                ]
              }
            ])
          : JSON.stringify({ checks: [{ context: "CI", app_id: 1 }], contexts: ["CI"] })
      if (args[1] === "list") return JSON.stringify(published ? [{ number: 12, headRefOid: headSha }] : [])
      if (args[1] === "create") {
        published = true
        return ""
      }
      if (args[1] === "merge") {
        merged = true
        return ""
      }
      return JSON.stringify({
        number: 12,
        state: merged ? "MERGED" : "OPEN",
        headRefOid: headSha,
        mergeCommit: merged ? { oid: mergedSha } : null,
        statusCheckRollup: [{ conclusion: "SUCCESS" }]
      })
    }),
    command: vi.fn(async (command, _root, artifact, env) => {
      artifact = `${artifact}-${Math.random()}.json`
      const result = {
        argv: command.argv,
        cwd: root,
        artifact,
        startedAt: "start",
        finishedAt: "end",
        exitCode: 0,
        stdout:
          command.argv[0] === "check"
            ? JSON.stringify({
                targetId: "test-target",
                deployedSha: env.AUTOCODE_SHA,
                artifactSha256: env.AUTOCODE_ARTIFACT_SHA256,
                healthy: true,
                workflowPassed: true,
                rolloutState: "settled",
                observedAt: clock
              })
            : ""
      }
      mkdirSync(dirname(artifact), { recursive: true })
      writeFileSync(artifact, JSON.stringify(result))
      return result
    })
  }
  reseal({ runtime, workflow })
  if (mode !== "release") {
    delete workflow.verification
    delete workflow.review
    workflow.lifecycle!.state = mode
    if (mode === "implementation") {
      delete workflow.candidate
      delete workflow.lifecycle!.headSha
    }
  }
  store.put("workflow", "workflow", workflow)
  return { runtime, store, workflow, io, cards, mergedSha }
}
function reseal(s: { runtime: NativeAutonomyRuntime; workflow: NativeWorkflow }) {
  const { policy } = s.runtime,
    w = s.workflow
  w.lifecycle ??= {
    version: 1,
    state: "release",
    attempt: 0,
    attemptId: "workflow:attempt:0",
    headSha: w.candidate!.headSha
  }
  const canaryPath = join(policy.repository, "canary-fixture.json"),
    recordedAt = Date.now()
  const canary = {
    version: 1,
    kind: "native-canary",
    evidenceKind: "controlled-fixture",
    environment: "disposable",
    passed: true,
    scopeDigest: nativeCanaryScopeDigest(policy),
    metadata: {
      benchmarkVersion: "release-fixture-v1",
      datasetDigest: nativeContentDigest("release-fixture-v1"),
      policyDigest: nativePromotionDigest(policy),
      skillDigest: nativeContentDigest(w.proposal.implementationPrompt),
      model: "deterministic-fixture",
      toolchain: { node: process.version },
      budgets: { maxAttempts: 1, maxCommands: 10, timeoutSeconds: 60 },
      costCents: null
    },
    scenarios: [
      {
        id: "controlled-prerequisite",
        passed: true,
        actual: ["native release gates"],
        mocked: ["operator-approved canary prerequisite"]
      }
    ],
    observations: { windowSeconds: 1, regressions: 0, rollbacks: 0, interventions: 1 },
    recordedAt
  }
  const canaryRaw = JSON.stringify(canary)
  writeFileSync(canaryPath, canaryRaw)
  policy.promotion = {
    approvedBy: "fixture-operator",
    approvedAt: recordedAt,
    policyDigest: nativePromotionDigest(policy),
    canaryArtifact: { path: canaryPath, sha256: nativeContentDigest(canaryRaw) }
  }
  w.verification!.plan = planNativeVerification(policy, w.candidate!.files)
  w.verification!.provenance = {
    version: 1,
    workflowId: "workflow",
    attemptId: w.lifecycle.attemptId,
    skillDigest: w.proposal.quality?.skillHash ?? nativeContentDigest(w.proposal.implementationPrompt),
    executionId: "verifier-execution",
    agentId: "verifier",
    sessionKey: "verifier-session",
    repositoryId: nativeRepositoryIdentity(policy),
    baseSha: w.candidate!.baseSha,
    headSha: w.candidate!.headSha,
    diffDigest: nativeContentDigest(`:100644 100644 ${w.candidate!.baseSha} ${w.candidate!.headSha} M\0src/a\0`),
    policyDigest: w.verification!.plan.policyDigest,
    policySnapshot: structuredClone(policy),
    checkIds: w.verification!.plan.ruleIds,
    toolchain: {
      node: process.version,
      git: "git test fixture",
      platform: process.platform,
      arch: process.arch,
      sandbox: "fixture"
    },
    artifacts: w.verification!.checks.map((c) => ({ ruleId: c.ruleId, path: c.artifact, sha256: c.artifactSha256! }))
  }
  const path = join(policy.repository, "provenance.json"),
    raw = JSON.stringify(w.verification!.provenance)
  writeFileSync(path, raw)
  w.verification!.provenanceArtifact = { path, sha256: nativeContentDigest(raw) }
  w.review!.receiptVersion = 1
  w.review!.attemptId = w.lifecycle.attemptId
  w.review!.verificationDigest = nativeVerificationDigest(w.verification!)
}
describe("native release reconciliation", () => {
  it.each(["push", "pr"])("reconciles an accepted %s after a lost response instead of replaying it", async (effect) => {
    const s = setup()
    delete s.workflow.prNumber
    const git = s.io.git,
      github = s.io.github
    s.io.git = vi.fn(async (...args) => {
      const result = await git(...args)
      if (effect === "push" && args[1] === "push") {
        s.runtime.control.change(true)
        throw new Error("response lost")
      }
      return result
    })
    s.io.github = vi.fn(async (...args) => {
      const result = await github(...args)
      if (effect === "pr" && args[1][1] === "create") {
        s.runtime.control.change(true)
        throw new Error("response lost")
      }
      return result
    })
    await expect(releaseNativeWorkflow(s.runtime, "workflow", s.workflow, s.io)).rejects.toBeInstanceOf(
      NativeReleasePending
    )
    expect(s.store.get<any>("operation", `workflow:${effect}`).state).toBe("started")
    s.runtime.control.change(false)
    await releaseNativeWorkflow(s.runtime, "workflow", s.workflow, s.io)
    expect(s.store.get<any>("operation", `workflow:${effect}`).state).toBe("confirmed")
    expect(vi.mocked(s.io.git).mock.calls.filter(([, cmd]) => cmd === "push")).toHaveLength(1)
    expect(vi.mocked(s.io.github).mock.calls.filter(([, args]) => args[1] === "create")).toHaveLength(1)
  })
  it("revokes a release before push, including when explicitly resumed before the await returns", async () => {
    const s = setup()
    delete s.workflow.prNumber
    const git = s.io.git
    s.io.git = vi.fn(async (...args) => {
      const result = await git(...args)
      if (args[1] === "fetch") {
        s.runtime.control.change(true)
        s.runtime.control.change(false)
      }
      return result
    })
    await expect(releaseNativeWorkflow(s.runtime, "workflow", s.workflow, s.io)).rejects.toThrow(/revoked/)
    expect(vi.mocked(s.io.git).mock.calls.some(([, cmd]) => cmd === "push")).toBe(false)
    expect(s.io.github).not.toHaveBeenCalled()
  })
  it("pauses between push and PR creation, then resumes without a second push", async () => {
    const s = setup()
    delete s.workflow.prNumber
    const github = s.io.github
    let pause = true
    s.io.github = vi.fn(async (...args) => {
      const result = await github(...args)
      if (args[1][1] === "list" && pause) {
        pause = false
        s.runtime.control.change(true)
      }
      return result
    })
    await expect(releaseNativeWorkflow(s.runtime, "workflow", s.workflow, s.io)).rejects.toThrow(/paused/)
    expect(vi.mocked(s.io.github).mock.calls.some(([, args]) => args[1] === "create")).toBe(false)
    s.runtime.control.change(false)
    await releaseNativeWorkflow(s.runtime, "workflow", s.workflow, s.io)
    await releaseNativeWorkflow(s.runtime, "workflow", s.workflow, s.io)
    expect(vi.mocked(s.io.git).mock.calls.filter(([, cmd]) => cmd === "push")).toHaveLength(1)
    expect(vi.mocked(s.io.github).mock.calls.filter(([, args]) => args[1] === "create")).toHaveLength(1)
    expect(s.workflow.deployedSha).toBe(s.mergedSha)
  })
  it("records a merge accepted before pause but does not start deployment until explicit resume", async () => {
    const s = setup()
    const github = s.io.github
    s.io.github = vi.fn(async (...args) => {
      const result = await github(...args)
      // The remote already accepted this operation: pause cannot cancel it.
      if (args[1][1] === "merge") s.runtime.control.change(true)
      return result
    })
    await expect(releaseNativeWorkflow(s.runtime, "workflow", s.workflow, s.io)).rejects.toThrow(/paused/)
    expect(s.store.get<any>("operation", "workflow:merge").state).toBe("confirmed")
    expect(s.io.command).not.toHaveBeenCalled()
    await expect(releaseNativeWorkflow(s.runtime, "workflow", s.workflow, s.io)).rejects.toThrow(/paused/)
    s.runtime.control.change(false)
    await releaseNativeWorkflow(s.runtime, "workflow", s.workflow, s.io)
    await releaseNativeWorkflow(s.runtime, "workflow", s.workflow, s.io)
    expect(vi.mocked(s.io.github).mock.calls.filter(([, args]) => args[1] === "merge")).toHaveLength(1)
    expect(vi.mocked(s.io.command).mock.calls.filter(([c]) => c.argv[0] === "deploy")).toHaveLength(1)
  })
  it("reconciles an accepted deployment while paused without claiming cancellation", async () => {
    const s = setup()
    const command = s.io.command
    s.io.command = vi.fn(async (...args) => {
      const result = await command(...args)
      if (args[0].argv[0] === "deploy") s.runtime.control.change(true)
      return result
    })
    await releaseNativeWorkflow(s.runtime, "workflow", s.workflow, s.io)
    expect(s.runtime.isPaused()).toBe(true)
    expect(s.workflow.deployedSha).toBe(s.mergedSha)
    s.runtime.control.change(false)
    await releaseNativeWorkflow(s.runtime, "workflow", s.workflow, s.io)
    expect(vi.mocked(s.io.command).mock.calls.filter(([c]) => c.argv[0] === "deploy")).toHaveLength(1)
  })
  it("does not initiate rollback when pause arrives during the deployment verification read", async () => {
    const s = setup()
    s.runtime.policy.deployment!.rollback = { argv: ["rollback"], cwd: ".", timeoutSeconds: 60 }
    reseal(s)
    const command = s.io.command
    s.io.command = vi.fn(async (...args) => {
      const result = await command(...args)
      if (args[0].argv[0] === "check" && args[3].AUTOCODE_SHA === s.mergedSha) {
        s.runtime.control.change(true)
        return { ...result, stdout: JSON.stringify({ ...JSON.parse(result.stdout), healthy: false }) }
      }
      return result
    })
    await expect(releaseNativeWorkflow(s.runtime, "workflow", s.workflow, s.io)).rejects.toThrow(/paused/)
    expect(vi.mocked(s.io.command).mock.calls.some(([c]) => c.argv[0] === "rollback")).toBe(false)
    expect(s.store.get<any>("operation", "workflow:deploy").state).toBe("started")
  })
  it("keeps a lost merge response visible and never replays it on resume", async () => {
    const s = setup()
    const github = s.io.github
    s.io.github = vi.fn(async (...args) => {
      if (args[1][1] === "merge") {
        s.runtime.control.change(true)
        throw new NativeReleasePending("Lost response; remote outcome unresolved")
      }
      return github(...args)
    })
    await expect(releaseNativeWorkflow(s.runtime, "workflow", s.workflow, s.io)).rejects.toThrow(/unresolved/)
    s.runtime.control.change(false)
    await expect(releaseNativeWorkflow(s.runtime, "workflow", s.workflow, s.io)).rejects.toThrow(/unresolved/)
    expect(s.store.get<any>("operation", "workflow:merge").state).toBe("started")
    expect(vi.mocked(s.io.github).mock.calls.filter(([, args]) => args[1] === "merge")).toHaveLength(1)
    expect((await s.runtime.status()).operations.some((op) => op.id === "workflow:merge")).toBe(true)
  })
  it("stops new merge and deployment effects when paused during a PR read", async () => {
    const s = setup()
    const github = s.io.github
    s.io.github = vi.fn(async (...args) => {
      const result = await github(...args)
      s.store.put("control", "pause", { paused: true })
      return result
    })
    await expect(releaseNativeWorkflow(s.runtime, "workflow", s.workflow, s.io)).rejects.toThrow(/paused|revoked/)
    expect(vi.mocked(s.io.github).mock.calls.some(([, args]) => args[1] === "merge")).toBe(false)
    expect(s.io.command).not.toHaveBeenCalled()
  })
  it("keeps an uncertain deployment visible while paused and after resume without replay", async () => {
    const s = setup()
    const command = s.io.command
    s.io.command = vi.fn(async (...args) => {
      const result = await command(...args)
      if (args[0].argv[0] === "deploy") s.runtime.control.change(true)
      if (args[3].AUTOCODE_SHA !== s.mergedSha) return result
      return { ...result, exitCode: args[0].argv[0] === "deploy" ? null : 0, stdout: "{}" }
    })
    await expect(releaseNativeWorkflow(s.runtime, "workflow", s.workflow, s.io)).rejects.toThrow(/unresolved/)
    await expect(releaseNativeWorkflow(s.runtime, "workflow", s.workflow, s.io)).rejects.toThrow(/unresolved/)
    s.runtime.control.change(false)
    await expect(releaseNativeWorkflow(s.runtime, "workflow", s.workflow, s.io)).rejects.toThrow(/unresolved/)
    expect(s.store.get<any>("operation", "workflow:deploy").state).toBe("started")
    expect(s.workflow.deployedSha).toBeUndefined()
    expect(vi.mocked(s.io.command).mock.calls.filter(([c]) => c.argv[0] === "deploy")).toHaveLength(1)
  })
  it("rechecks structured acceptance and high-risk design before any release effect", async () => {
    const s = setup()
    s.workflow.proposal.quality = {
      problem: "Missing capability",
      userWorkflow: "Review evidence",
      expectedBenefit: "Complete workflow",
      approach: "Bounded change",
      nonGoals: ["Unrelated changes"],
      risk: "high",
      riskReasons: ["Contract change"],
      verification: [{ criterion: "outcome", method: "Behavior test" }],
      revision: "b".repeat(40),
      skillHash: "d".repeat(64),
      sessionKey: "research-session",
      evidenceHashes: { "src/a": "hash" }
    }
    await expect(releaseNativeWorkflow(s.runtime, "workflow", s.workflow, s.io)).rejects.toThrow(/Structured/)
    const assessment = {
      criteria: [{ criterion: "outcome", satisfied: true, evidence: "Observed behavior" }],
      findings: []
    }
    s.workflow.review!.assessment = assessment
    reseal(s)
    await expect(releaseNativeWorkflow(s.runtime, "workflow", s.workflow, s.io)).rejects.toThrow(/design/)
    expect(s.io.command).not.toHaveBeenCalled()
    s.workflow.designReview = {
      verdict: "approved",
      rationale: "Contract checked",
      sessionKey: "design-session",
      digest: s.runtime.quality.designDigest(s.workflow),
      assessment
    }
    await releaseNativeWorkflow(s.runtime, "workflow", s.workflow, s.io)
    expect(s.workflow.deployedSha).toBe(s.mergedSha)
  })
  it("reclassifies actual protected additions before release even without proposal quality", async () => {
    const s = setup()
    const git = vi.mocked(s.io.git).getMockImplementation()!
    vi.mocked(s.io.git).mockImplementation(async (cwd, ...args) =>
      args.includes("--raw")
        ? `:000000 100644 ${"0".repeat(40)} ${s.workflow.candidate!.headSha} A\0src/auth/new.ts\0`
        : git(cwd, ...args)
    )
    await expect(releaseNativeWorkflow(s.runtime, "workflow", s.workflow, s.io)).rejects.toThrow(/design review/)
    expect(s.workflow.riskAssessment!.risk).toBe("high")
    expect(s.io.github).not.toHaveBeenCalled()
    expect(s.io.command).not.toHaveBeenCalled()
    expect(s.workflow.designCardId).toBeTruthy()
  })
  it("records verified deployment and does not repeat external deploy effects", async () => {
    const s = setup()
    await releaseNativeWorkflow(s.runtime, "workflow", s.workflow, s.io)
    await releaseNativeWorkflow(s.runtime, "workflow", s.workflow, s.io)
    expect(s.cards.root.status).toBe("done")
    expect(s.store.get<any>("workflow", "workflow").deployedSha).toBe(s.mergedSha)
    expect(vi.mocked(s.io.command).mock.calls.filter(([c]) => c.argv[0] === "deploy")).toHaveLength(1)
    expect(vi.mocked(s.io.github).mock.calls.filter(([, args]) => args[1] === "merge")).toHaveLength(1)
  })
  it("waits for CI without treating pending checks as failed", async () => {
    const s = setup()
    const github = s.io.github
    s.io.github = vi.fn(async (cwd, args) =>
      args.some((arg) => arg.includes("check-runs"))
        ? JSON.stringify([
            {
              check_runs: [
                { name: "CI", app: { id: 1 }, head_sha: s.workflow.candidate!.headSha, status: "in_progress" }
              ]
            }
          ])
        : github(cwd, args)
    )
    await expect(releaseNativeWorkflow(s.runtime, "workflow", s.workflow, s.io)).rejects.toBeInstanceOf(
      NativeReleasePending
    )
    expect(s.io.command).not.toHaveBeenCalled()
  })
  it("recovers an accepted merge from remote truth after a lost response", async () => {
    const s = setup()
    s.store.put("operation", "workflow:merge", { state: "started" })
    const git = vi.mocked(s.io.git).getMockImplementation()!
    vi.mocked(s.io.git).mockImplementation(async (cwd, ...args) =>
      args[0] === "rev-parse" && args[1] !== "HEAD" ? s.mergedSha : git(cwd, ...args)
    )
    vi.mocked(s.io.github).mockResolvedValue(
      JSON.stringify({ state: "MERGED", headRefOid: s.workflow.candidate!.headSha, mergeCommit: { oid: s.mergedSha } })
    )
    await releaseNativeWorkflow(s.runtime, "workflow", s.workflow, s.io)
    expect(s.workflow.deployedSha).toBe(s.mergedSha)
    expect(vi.mocked(s.io.github).mock.calls.some(([, args]) => args[1] === "merge")).toBe(false)
  })
  it("does not replay an uncertain deployment with the wrong deployed revision", async () => {
    const s = setup()
    s.store.put("operation", "workflow:deploy", {
      receiptVersion: 1,
      verificationDigest: nativeVerificationDigest(s.workflow.verification!),
      attemptId: s.workflow.lifecycle!.attemptId,
      targetId: "test-target",
      revision: s.mergedSha,
      artifactSha256: "e".repeat(64),
      startedAt: Date.now(),
      state: "started"
    })
    vi.mocked(s.io.command).mockResolvedValue({
      argv: ["check"],
      cwd: "worktree",
      artifact: "check",
      startedAt: "start",
      finishedAt: "end",
      exitCode: 0,
      stdout: JSON.stringify({ deployedSha: "wrong", workflowPassed: true })
    })
    await expect(releaseNativeWorkflow(s.runtime, "workflow", s.workflow, s.io)).rejects.toThrow(/unresolved/)
    expect(vi.mocked(s.io.command).mock.calls.some(([c]) => c.argv[0] === "deploy")).toBe(false)
    expect(s.cards.root.status).toBe("blocked")
  })
  it("accepts an independently confirmed deployment after its command response is interrupted", async () => {
    const s = setup()
    const command = s.io.command
    s.io.command = vi.fn(async (...args) => {
      const result = await command(...args)
      return args[0].argv[0] === "deploy" ? { ...result, exitCode: null } : result
    })
    await releaseNativeWorkflow(s.runtime, "workflow", s.workflow, s.io)
    expect(s.workflow.deployedSha).toBe(s.mergedSha)
    expect(s.cards.root.status).toBe("done")
  })
  it("blocks self-release and stale review before external actions", async () => {
    const s = setup()
    s.runtime.policy.repositoryKind = "framework"
    await expect(releaseNativeWorkflow(s.runtime, "workflow", s.workflow, s.io)).rejects.toThrow(/human/)
    s.runtime.policy.repositoryKind = "application"
    s.workflow.review!.headSha = "d".repeat(40)
    await expect(releaseNativeWorkflow(s.runtime, "workflow", s.workflow, s.io)).rejects.toThrow(/independent/)
    expect(s.io.github).not.toHaveBeenCalled()
  })
})

describe("native pause control", () => {
  it("allows evidence from accepted verification but revokes the next command authorization", async () => {
    const s = setup("verification")
    delete s.workflow.verification
    delete s.workflow.review
    s.store.put("workflow", "workflow", s.workflow)
    let acceptedEvidence = false
    vi.spyOn(verificationModule, "verifyNativeCandidate").mockImplementation(
      async (_policy, _candidate, _root, _signal, authority) => {
        authority!.authorize()
        await Promise.resolve()
        s.runtime.control.change(true)
        authority!.mutate(() => {
          acceptedEvidence = true
        })
        authority!.authorize()
        throw new Error("Must not start another verification command")
      }
    )
    expect(await s.runtime.reconcile()).toEqual({ advanced: 0, paused: true })
    expect(acceptedEvidence).toBe(true)
    expect(s.store.get<any>("workflow", "workflow").blocker).toBeUndefined()
    expect(s.store.get<any>("workflow", "workflow").reviewCardId).toBeUndefined()
  })
  it("routes paused reconciliation to remote observation of an already-started release", async () => {
    const s = setup()
    s.store.put("operation", "workflow:merge", { state: "started" })
    vi.mocked(s.io.github).mockResolvedValue(
      JSON.stringify({
        state: "MERGED",
        headRefOid: s.workflow.candidate!.headSha,
        mergeCommit: { oid: s.mergedSha }
      })
    )
    const release = releaseModule.releaseNativeWorkflow
    vi.spyOn(releaseModule, "releaseNativeWorkflow").mockImplementation((runtime, id, workflow) =>
      release(runtime, id, workflow, s.io)
    )
    s.runtime.control.change(true)
    expect(await s.runtime.reconcile()).toEqual({ advanced: 0, paused: true })
    expect(s.store.get<any>("operation", "workflow:merge").state).toBe("confirmed")
    expect(s.store.get<any>("workflow", "workflow").mergedSha).toBe(s.mergedSha)
    expect(s.store.get<any>("workflow", "workflow").blocker).toBeUndefined()
    expect(s.io.command).not.toHaveBeenCalled()
  })
  it("observes revocation from another journal connection, including pause followed by resume", async () => {
    const s = setup()
    const otherStore = new NativeEvidenceStore(join(s.runtime.policy.repository, "evidence.db"))
    const other = new NativeAutonomyRuntime(s.runtime.policy, s.runtime.gateway, otherStore)
    try {
      await expect(
        s.runtime.control.run(async () => {
          await Promise.resolve()
          other.control.change(true)
          other.control.change(false)
          s.runtime.control.assert()
        })
      ).rejects.toThrow(/revoked/)
      await s.runtime.control.run(async () => {
        s.runtime.control.assert()
      })
    } finally {
      otherStore.close()
    }
  })
  it("audits explicit control changes and rejects a resume overtaken by a newer pause", () => {
    const s = setup()
    const paused = s.runtime.control.change(true)
    s.runtime.control.change(true)
    expect(() => s.runtime.control.change(false, paused.revision)).toThrow(/Control changed/)
    expect(s.runtime.isPaused()).toBe(true)
    const current = s.runtime.control.state.revision
    const resumed = s.runtime.control.change(false, current)
    expect(resumed.revision).not.toBe(current)
    expect(
      s.store.db
        .prepare("SELECT kind FROM native_events WHERE kind LIKE 'control.%' ORDER BY id")
        .all()
        .map((row) => row.kind)
    ).toEqual(["control.paused", "control.paused", "control.resumed"])
    s.runtime.policy.enabled = false
    expect(() => s.runtime.control.change(false)).toThrow(/disabled/)
  })
  it("prevents ready promotion and dispatch after pause during a native card read", async () => {
    const s = setup("implementation")
    delete s.workflow.candidate
    delete s.workflow.verification
    delete s.workflow.review
    s.store.put("workflow", "workflow", s.workflow)
    s.store.put("admission", "workflow", { phase: "prepared" })
    s.cards.implementation = { id: "implementation", title: "Implement", status: "scheduled", agentId: "coder" }
    const request = s.runtime.gateway.request
    s.runtime.gateway.request = vi.fn(async (method, params) => {
      const result = await request(method, params)
      if (method === "workboard.cards.list") {
        s.runtime.control.change(true)
        s.runtime.control.change(false)
      }
      return result
    })
    expect(await s.runtime.reconcile()).toEqual({ advanced: 0, paused: true })
    expect(s.cards.implementation.status).toBe("scheduled")
    expect(
      vi
        .mocked(s.runtime.gateway.request)
        .mock.calls.some(([method]) => method === "workboard.cards.dispatchWithOptions")
    ).toBe(false)
    expect(s.store.get<any>("workflow", "workflow").blocker).toBeUndefined()
  })
  it("records an accepted ready move but prevents subsequent dispatch until resume", async () => {
    const s = setup("implementation")
    delete s.workflow.candidate
    delete s.workflow.verification
    delete s.workflow.review
    s.store.put("workflow", "workflow", s.workflow)
    s.store.put("admission", "workflow", { phase: "prepared" })
    s.cards.implementation = { id: "implementation", title: "Implement", status: "scheduled", agentId: "coder" }
    const request = s.runtime.gateway.request
    s.runtime.gateway.request = vi.fn(async (method, params) => {
      const result = await request(method, params)
      if (method === "workboard.cards.move" && params.status === "ready") s.runtime.control.change(true)
      return result
    })
    expect(await s.runtime.reconcile()).toEqual({ advanced: 0, paused: true })
    expect(s.cards.implementation.status).toBe("ready")
    expect(
      vi
        .mocked(s.runtime.gateway.request)
        .mock.calls.some(([method]) => method === "workboard.cards.dispatchWithOptions")
    ).toBe(false)
    s.runtime.control.change(false)
    await s.runtime.reconcile()
    expect(
      vi.mocked(s.runtime.gateway.request).mock.calls.filter(([method]) => method === "workboard.cards.move")
    ).toHaveLength(1)
    expect(
      vi
        .mocked(s.runtime.gateway.request)
        .mock.calls.filter(([method]) => method === "workboard.cards.dispatchWithOptions")
    ).toHaveLength(1)
  })
  it("stops discovery after an accepted card and resumes the same native idempotency keys", async () => {
    const s = setup()
    const request = s.runtime.gateway.request
    let pause = true
    s.runtime.gateway.request = vi.fn(async (method, params) => {
      const result = await request(method, params)
      if (method === "workboard.cards.create" && pause) {
        pause = false
        s.runtime.control.change(true)
      }
      return result
    })
    await expect(s.runtime.discover()).rejects.toThrow(/paused/)
    expect(s.store.list<any>("round")[0]!.value.phase).toBe("building")
    s.runtime.control.change(false)
    await s.runtime.discover()
    expect(s.store.list("round")).toHaveLength(1)
    expect(Object.values(s.cards).filter((card) => card.title?.startsWith("Investigate:"))).toHaveLength(1)
    expect(Object.values(s.cards).filter((card) => card.title?.startsWith("Select persona ideas:"))).toHaveLength(1)
  })
})

describe("protected release provenance and deployment health", () => {
  it("rejects same-SHA evidence from another attempt and replaced provenance artifacts", async () => {
    const s = setup()
    s.workflow.review!.attemptId = "workflow:attempt:1"
    await expect(releaseNativeWorkflow(s.runtime, "workflow", s.workflow, s.io)).rejects.toThrow(
      "another verification attempt"
    )
    s.workflow.review!.attemptId = s.workflow.lifecycle!.attemptId
    writeFileSync(s.workflow.verification!.provenanceArtifact!.path, "{}")
    await expect(releaseNativeWorkflow(s.runtime, "workflow", s.workflow, s.io)).rejects.toThrow("replaced")
    expect(s.io.github).not.toHaveBeenCalled()
  })
  it("keeps legacy receipts readable but refuses release authority", async () => {
    const s = setup()
    delete s.workflow.verification!.provenance
    await expect(releaseNativeWorkflow(s.runtime, "workflow", s.workflow, s.io)).rejects.toThrow("Legacy verification")
    expect(s.io.github).not.toHaveBeenCalled()
  })
  it("requires two bounded health observations and never repeats deployment", async () => {
    const s = setup()
    let time = Date.now() + 100
    s.io.now = () => time
    const command = s.io.command
    s.io.command = vi.fn(async (...args) => {
      const result = await command(...args)
      return args[0] === s.runtime.policy.deployment!.check
        ? { ...result, stdout: JSON.stringify({ ...JSON.parse(result.stdout), observedAt: time }) }
        : result
    })
    await expect(releaseNativeWorkflow(s.runtime, "workflow", s.workflow, s.io)).rejects.toThrow("window")
    expect(s.workflow.deployedSha).toBeUndefined()
    time += 1000
    await releaseNativeWorkflow(s.runtime, "workflow", s.workflow, s.io)
    expect(s.workflow.deployedSha).toBe(s.mergedSha)
    expect(vi.mocked(s.io.command).mock.calls.filter(([c]) => c.argv[0] === "deploy")).toHaveLength(1)
  })
  it("does not treat a command success or wrong target as healthy deployment", async () => {
    const s = setup(),
      command = s.io.command
    s.io.command = vi.fn(async (...args) => {
      const result = await command(...args)
      return args[0] === s.runtime.policy.deployment!.check && args[3].AUTOCODE_SHA === s.mergedSha
        ? { ...result, stdout: JSON.stringify({ ...JSON.parse(result.stdout), targetId: "other-target" }) }
        : result
    })
    await expect(releaseNativeWorkflow(s.runtime, "workflow", s.workflow, s.io)).rejects.toThrow("unresolved")
    await expect(releaseNativeWorkflow(s.runtime, "workflow", s.workflow, s.io)).rejects.toThrow("unresolved")
    expect(s.workflow.deployedSha).toBeUndefined()
    expect(vi.mocked(s.io.command).mock.calls.filter(([c]) => c.argv[0] === "deploy")).toHaveLength(1)
  })
  it("journals a lost rollback response and independently verifies restoration without replay", async () => {
    const s = setup()
    s.runtime.policy.deployment!.rollback = { argv: ["rollback"], cwd: ".", timeoutSeconds: 10 }
    reseal(s)
    const command = s.io.command
    s.io.command = vi.fn(async (...args) => {
      const result = await command(...args)
      if (args[0].argv[0] === "rollback") throw new Error("lost rollback response")
      if (args[0] === s.runtime.policy.deployment!.check && args[3].AUTOCODE_SHA === s.mergedSha)
        return { ...result, stdout: JSON.stringify({ ...JSON.parse(result.stdout), healthy: false }) }
      return result
    })
    await expect(releaseNativeWorkflow(s.runtime, "workflow", s.workflow, s.io)).rejects.toThrow("unresolved")
    await expect(releaseNativeWorkflow(s.runtime, "workflow", s.workflow, s.io)).rejects.toThrow("rolled back")
    expect(s.store.get<any>("operation", "workflow:rollback").state).toBe("confirmed")
    expect(vi.mocked(s.io.command).mock.calls.filter(([c]) => c.argv[0] === "rollback")).toHaveLength(1)
    expect(s.workflow.deployedSha).toBeUndefined()
  })
  it("holds target ownership for an unresolved workflow", async () => {
    const s = setup()
    s.store.put("deployment-target", nativeContentDigest("test-target"), {
      workflowId: "other",
      attemptId: "other:0",
      state: "held"
    })
    await expect(releaseNativeWorkflow(s.runtime, "workflow", s.workflow, s.io)).rejects.toThrow(
      "another unresolved workflow"
    )
    expect(s.io.command).not.toHaveBeenCalled()
  })
  it("rejects generic rollback for forward-only schema changes", async () => {
    const s = setup()
    s.runtime.policy.deployment!.forwardOnly = true
    s.runtime.policy.deployment!.rollback = { argv: ["rollback"], cwd: ".", timeoutSeconds: 10 }
    reseal(s)
    await expect(releaseNativeWorkflow(s.runtime, "workflow", s.workflow, s.io)).rejects.toThrow("Forward-only")
    expect(s.io.github).not.toHaveBeenCalled()
  })
})

it("keeps archived evidence inspectable without the candidate worktree and rejects policy snapshot tampering", () => {
  const s = setup()
  s.workflow.candidate!.cwd = "/removed-candidate-worktree"
  const expected = {
    workflowId: "workflow",
    attemptId: s.workflow.lifecycle!.attemptId,
    skillDigest: nativeContentDigest(s.workflow.proposal.implementationPrompt)
  }
  expect(() => assertNativeProvenance(s.runtime.policy, s.workflow.verification!, expected)).not.toThrow()
  s.workflow.verification!.provenance!.policySnapshot.enabled = false
  expect(() => assertNativeProvenance(s.runtime.policy, s.workflow.verification!, expected)).toThrow("policy snapshot")
})

it("keeps failed rollback unresolved through its deadline without replay", async () => {
  const s = setup()
  s.runtime.policy.deployment!.rollback = { argv: ["rollback"], cwd: ".", timeoutSeconds: 10 }
  reseal(s)
  const command = s.io.command
  s.io.command = vi.fn(async (...args) => {
    const result = await command(...args)
    if (
      args[0] === s.runtime.policy.deployment!.check &&
      (args[3].AUTOCODE_SHA === s.mergedSha || s.store.get("operation", "workflow:rollback"))
    )
      return { ...result, stdout: JSON.stringify({ ...JSON.parse(result.stdout), healthy: false }) }
    return result
  })
  await expect(releaseNativeWorkflow(s.runtime, "workflow", s.workflow, s.io)).rejects.toThrow("Rollback initiated")
  await expect(releaseNativeWorkflow(s.runtime, "workflow", s.workflow, s.io)).rejects.toThrow("unresolved")
  s.io.now = () => Date.now() + 700000
  await expect(releaseNativeWorkflow(s.runtime, "workflow", s.workflow, s.io)).rejects.toThrow("deadline")
  expect(s.store.get<any>("operation", "workflow:rollback").state).toBe("unresolved")
  expect(s.store.get<any>("deployment-target", nativeContentDigest("test-target")).state).toBe("held")
  expect(vi.mocked(s.io.command).mock.calls.filter(([c]) => c.argv[0] === "rollback")).toHaveLength(1)
})

describe("seeded accepted-effect fault replay", () => {
  it.each([7, 19, 43, 97])("retains accepted effects through replay seed %s", async (seed) => {
    const s = setup()
    let state = seed,
      faulted = false
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      return state
    }
    const boundary = ["fetch", "merge", "deploy", "api"][random() % 4]!,
      kind = random() % 2 === 0 ? "pause" : "lost-response"
    const git = s.io.git,
      github = s.io.github,
      command = s.io.command
    const inject = (name: string) => {
      if (!faulted && name === boundary) {
        faulted = true
        if (kind === "pause") s.runtime.control.change(true)
        else throw new Error(`seed ${seed} lost response after ${name}`)
      }
    }
    s.io.git = vi.fn(async (...args) => {
      const result = await git(...args)
      inject(args[1])
      return result
    })
    s.io.github = vi.fn(async (...args) => {
      const result = await github(...args)
      inject(args[1][0] === "api" ? "api" : args[1][1]!)
      return result
    })
    s.io.command = vi.fn(async (...args) => {
      const result = await command(...args)
      inject(args[0].argv[0]!)
      return result
    })
    for (let attempt = 0; attempt < 4 && !s.workflow.deployedSha; attempt++) {
      try {
        await releaseNativeWorkflow(s.runtime, "workflow", s.workflow, s.io)
      } catch (error) {
        expect(String(error)).toMatch(/paused|revoked|unresolved|lost response/)
      }
      if (s.runtime.isPaused()) s.runtime.control.change(false)
    }
    expect(faulted).toBe(true)
    expect(s.workflow.deployedSha).toBe(s.mergedSha)
    expect(vi.mocked(s.io.github).mock.calls.filter(([, args]) => args[1] === "merge")).toHaveLength(1)
    expect(vi.mocked(s.io.command).mock.calls.filter(([c]) => c.argv[0] === "deploy")).toHaveLength(1)
  })
})
