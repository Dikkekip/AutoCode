import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { nativeDoctor } from "../packages/core-runtime/src/native/doctor.js"
import { NativeSdkGateway } from "../packages/core-runtime/src/native/gateway.js"
import { registerNativeAutonomyPlugin } from "../packages/core-runtime/src/native/plugin.js"
import { nativeContentDigest } from "../packages/core-runtime/src/native/provenance.js"
import type { NativeAutonomyRuntime } from "../packages/core-runtime/src/native/runtime.js"
import { withNativeRuntimeCall } from "../packages/core-runtime/src/native/runtime-lifetime.js"
import * as commands from "../packages/core-runtime/src/native/verification.js"

vi.mock("../packages/core-runtime/src/native/doctor.js", async (original) => ({
  ...(await original<typeof import("../packages/core-runtime/src/native/doctor.js")>()),
  nativeDoctor: vi.fn()
}))
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})
const workflowId = "1".repeat(64),
  oldRevision = "2".repeat(40),
  oldArtifact = "3".repeat(64),
  revision = "4".repeat(40),
  artifactSha256 = "5".repeat(64),
  mergedSha = "6".repeat(40),
  admin = { connect: { scopes: ["operator.admin"], device: { id: "independent-operator" } } }
const healthProgram = `console.log(JSON.stringify({targetId:process.env.AUTOCODE_TARGET_ID,deployedSha:process.env.AUTOCODE_SHA,artifactSha256:process.env.AUTOCODE_ARTIFACT_SHA256,healthy:true,workflowPassed:true,rolloutState:"settled",observedAt:Date.now()}))`
async function setup() {
  const root = mkdtempSync(join(tmpdir(), "native-baseline-")),
    repo = join(root, "repo"),
    file = join(root, "policy.json")
  mkdirSync(repo)
  vi.stubEnv("OPENCLAW_CONTROL_ROOT", join(root, "control"))
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      enabled: true,
      boardId: "baseline-test",
      repository: repo,
      repositoryKind: "application",
      baseBranch: "main",
      plannerAgentId: "planner",
      coderAgentId: "coder",
      reviewerAgentId: "reviewer",
      personas: [
        {
          personaId: "research",
          investigationAgentId: "research-agent",
          goals: ["goal"],
          successObservations: ["outcome"],
          allowedPaths: ["src"]
        }
      ],
      verification: [{ argv: ["true"], cwd: "." }],
      deployment: {
        authorized: true,
        targetId: "production-test",
        prepare: { argv: ["never-prepare"], cwd: "." },
        command: { argv: ["never-deploy"], cwd: "." },
        rollback: { argv: ["never-rollback"], cwd: "." },
        check: { argv: [process.execPath, "-e", healthProgram], cwd: ".", timeoutSeconds: 10 },
        previousKnownGood: { revision: oldRevision, artifactSha256: oldArtifact },
        observationSeconds: 1,
        reconciliationSeconds: 60
      }
    })
  )
  let service: any
  const methods = new Map<string, any>()
  registerNativeAutonomyPlugin({
    pluginConfig: { projects: [file], openclawCommand: "/usr/bin/openclaw" },
    registerService: (s: any) => {
      service = s
    },
    registerGatewayMethod: (name: string, handler: any) => methods.set(name, handler),
    registerTool: () => {},
    on: () => {},
    logger: { warn: vi.fn() }
  })
  vi.mocked(nativeDoctor).mockResolvedValue({ ok: true, enabled: true, boardId: "baseline-test", checks: [] })
  const request = vi.spyOn(NativeSdkGateway.prototype, "request").mockImplementation(async (method) => {
    if (method === "workboard.cards.list") return { cards: [] } as any
    if (method === "sessions.list") return { sessions: [], totalCount: 0, hasMore: false, nextOffset: null } as any
    throw new Error(`Unexpected Gateway call: ${method}`)
  })
  await service.start()
  cleanup.push(async () => {
    await service.stop()
    rmSync(root, { recursive: true, force: true })
  })
  const runtime = (globalThis as any)[Symbol.for("autocode.native.service-runtimes.v1")].get(
      "baseline-test"
    ) as NativeAutonomyRuntime,
    store = runtime.store,
    targetKey = nativeContentDigest("production-test"),
    preparedKey = `${workflowId}:${workflowId}:attempt:0:artifact`,
    proof = join(root, "staged-evidence.json")
  writeFileSync(proof, "original staged evidence")
  const candidate = {
    headSha: "7".repeat(40),
    baseSha: oldRevision,
    cwd: root,
    branch: "candidate",
    files: ["src/a.ts"]
  }
  store.put("workflow", workflowId, {
    lifecycle: {
      version: 1,
      state: "deployment",
      attempt: 0,
      attemptId: `${workflowId}:attempt:0`,
      headSha: candidate.headSha
    },
    proposal: {
      personaId: "research",
      title: "Verified change",
      goal: "goal",
      evidence: [],
      allowedPaths: ["src"],
      acceptance: ["outcome"],
      alternatives: [],
      implementationPrompt: "implement"
    },
    rootCardId: "root",
    implementationCardId: "implementation",
    stageCards: {},
    candidate,
    verification: { headSha: candidate.headSha, checks: [{ outcome: "success", exitCode: 0 }] },
    review: { verdict: "approved", headSha: candidate.headSha, agentId: "reviewer", sessionKey: "review" },
    mergedSha,
    prNumber: 12
  })
  store.put("deployment-target", targetKey, {
    workflowId: "old-release",
    attemptId: "old-release:attempt:0",
    state: "healthy",
    revision: oldRevision,
    artifactSha256: oldArtifact
  })
  store.put("deployment-artifact", preparedKey, {
    targetId: "production-test",
    revision: mergedSha,
    artifactSha256: "8".repeat(64),
    staged: true,
    previousKnownGood: { revision: oldRevision, artifactSha256: oldArtifact },
    evidence: { path: proof, sha256: nativeContentDigest(readFileSync(proof)) }
  })
  const call = async (method: string, params: any = {}, client: any = admin) => {
    let response: any
    await methods.get(method)({
      params: { boardId: "baseline-test", ...params },
      client,
      respond: (...args: any[]) => {
        response = args
      }
    })
    return response
  }
  await call("autocode.pause")
  const input = { workflowId, revision, artifactSha256, reason: "Reconcile independently confirmed production drift" },
    plan = async () => {
      const r = await call("autocode.deployment.baseline.plan", input)
      expect(r[0]).toBe(true)
      return r[1]
    },
    apply = (p: any, client: any = admin, extra: any = {}) =>
      call("autocode.deployment.baseline.apply", { plan: p, ...extra }, client),
    records = () => store.db.prepare("SELECT kind,id,data FROM native_records ORDER BY kind,id").all()
  const mockCheck = (mutate: (receipt: any) => void = () => {}, during: () => void = () => {}) =>
    vi.spyOn(commands, "runNativeDeploymentCommand").mockImplementation(async (command, _root, artifact, env) => {
      expect(command).toBe(runtime.policy.deployment!.check)
      expect(env.AUTOCODE_SHA).toBe(revision)
      const receipt = {
        targetId: "production-test",
        deployedSha: revision,
        artifactSha256,
        healthy: true,
        workflowPassed: true,
        rolloutState: "settled",
        observedAt: Date.now()
      }
      mutate(receipt)
      during()
      mkdirSync(dirname(artifact), { recursive: true })
      writeFileSync(artifact, JSON.stringify(receipt))
      return { outcome: "success", exitCode: 0, stdout: JSON.stringify(receipt), stderr: "", artifact } as any
    })
  return { root, runtime, store, targetKey, preparedKey, proof, call, request, plan, apply, records, mockCheck, input }
}
it("adopts through public RPC using the configured real check, preserving original records and release evidence", async () => {
  const s = await setup(),
    p = await s.plan(),
    before = s.records(),
    result = await s.apply(p)
  expect(result[0], JSON.stringify(result)).toBe(true)
  const audit = s.store.get<any>("deployment-baseline-adoption", result[1].planDigest)!
  expect(audit.previousTarget.revision).toBe(oldRevision)
  expect(audit.previousPrepared.previousKnownGood.artifactSha256).toBe(oldArtifact)
  expect(audit.operatorId).toBe("independent-operator")
  expect(audit.evidence.sha256).toBe(nativeContentDigest(readFileSync(audit.evidence.path)))
  expect(s.store.get<any>("deployment-target", s.targetKey)).toMatchObject({
    workflowId: `operator-baseline:${result[1].planDigest}`,
    state: "healthy",
    revision,
    artifactSha256
  })
  expect(s.store.get<any>("deployment-artifact", s.preparedKey).previousKnownGood).toEqual({ revision, artifactSha256 })
  expect(s.store.get<any>("workflow", workflowId)).toEqual(
    JSON.parse(String(before.find((r: any) => r.kind === "workflow")!.data))
  )
  expect(s.runtime.control.state.paused).toBe(true)
  expect(s.store.list("operation")).toEqual([])
  const after = s.records()
  expect((await s.apply(p))[0]).toBe(false)
  expect(s.records()).toEqual(after)
})
it.each([
  [
    "wrong revision",
    (r: any) => {
      r.deployedSha = oldRevision
    }
  ],
  [
    "wrong artifact",
    (r: any) => {
      r.artifactSha256 = oldArtifact
    }
  ],
  [
    "wrong target",
    (r: any) => {
      r.targetId = "other-target"
    }
  ],
  [
    "unhealthy",
    (r: any) => {
      r.healthy = false
    }
  ],
  [
    "workflow failure",
    (r: any) => {
      r.workflowPassed = false
    }
  ],
  [
    "unsettled",
    (r: any) => {
      r.rolloutState = "in_progress"
    }
  ],
  [
    "stale",
    (r: any) => {
      r.observedAt -= 61000
    }
  ],
  [
    "future",
    (r: any) => {
      r.observedAt += 61000
    }
  ]
])("refuses %s health without changing native records", async (_name, mutate) => {
  const s = await setup(),
    p = await s.plan(),
    before = s.records()
  const check = s.mockCheck(mutate)
  expect((await s.apply(p))[0]).toBe(false)
  expect(check).toHaveBeenCalledOnce()
  expect(s.records()).toEqual(before)
})
it.each([
  null,
  { connect: { scopes: ["operator.read"] } },
  { connect: { scopes: ["operator.admin"] } },
  { connect: { scopes: ["operator.admin"], device: { id: "research-agent" } } }
])("requires independent authenticated operator authority: %j", async (client) => {
  const s = await setup(),
    p = await s.plan(),
    before = s.records(),
    check = s.mockCheck()
  expect((await s.apply(p, client))[0]).toBe(false)
  expect(check).not.toHaveBeenCalled()
  expect(s.records()).toEqual(before)
})
it.each([
  "policyDigest",
  "runtimeGeneration",
  "controlRevision",
  "freezeRevision",
  "arbitraryCommand"
])("refuses forged or stale %s", async (field) => {
  const s = await setup(),
    p = await s.plan(),
    before = s.records(),
    check = s.mockCheck()
  expect((await s.apply({ ...p, [field]: "forged" }))[0]).toBe(false)
  expect(check).not.toHaveBeenCalled()
  expect(s.records()).toEqual(before)
})
it("refuses active leases, uncertain operations and any prior deployment effect", async () => {
  const s = await setup(),
    p = await s.plan(),
    check = s.mockCheck(),
    lease = s.store.acquire("reconcile", 10000)!
  expect((await s.apply(p))[0]).toBe(false)
  s.store.release(lease)
  s.store.put("operation", "other:push", { state: "started" })
  expect((await s.apply(p))[0]).toBe(false)
  s.store.put("operation", "other:push", { state: "confirmed" })
  s.store.put("operation", `${workflowId}:deploy`, { state: "confirmed" })
  expect((await s.apply(p))[0]).toBe(false)
  expect(check).not.toHaveBeenCalled()
})
it("refuses remote work before checking and work appearing after checking", async () => {
  const s = await setup(),
    p = await s.plan(),
    before = s.records(),
    check = s.mockCheck()
  s.request.mockResolvedValue({ cards: [{ id: "active", status: "running" }] } as any)
  expect((await s.apply(p))[0]).toBe(false)
  expect(check).not.toHaveBeenCalled()
  s.request.mockImplementation(async (method) =>
    method === "workboard.cards.list"
      ? ({ cards: check.mock.calls.length ? [{ id: "new", status: "ready" }] : [] } as any)
      : ({ sessions: [], totalCount: 0, hasMore: false, nextOffset: null } as any)
  )
  expect((await s.apply(p))[0]).toBe(false)
  expect(check).toHaveBeenCalledOnce()
  expect(s.records()).toEqual(before)
})
it.each([
  "target",
  "prepared",
  "workflow",
  "pause",
  "evidence"
])("refuses %s drift during the trusted check", async (field) => {
  const s = await setup(),
    p = await s.plan()
  s.mockCheck(
    () => {},
    () => {
      if (field === "pause") s.runtime.control.change(true)
      else if (field === "evidence") writeFileSync(s.proof, "changed")
      else {
        const kind =
            field === "target" ? "deployment-target" : field === "prepared" ? "deployment-artifact" : "workflow",
          id = field === "target" ? s.targetKey : field === "prepared" ? s.preparedKey : workflowId
        s.store.put(kind, id, { ...s.store.get<any>(kind, id), observation: "changed" })
      }
    }
  )
  expect((await s.apply(p))[0]).toBe(false)
  expect(s.store.list("deployment-baseline-adoption")).toEqual([])
  expect(s.store.get<any>("deployment-target", s.targetKey).revision).toBe(oldRevision)
  expect(s.store.get<any>("deployment-artifact", s.preparedKey).previousKnownGood.revision).toBe(oldRevision)
})
it("refuses an active host call and unknown operator parameters", async () => {
  const s = await setup(),
    p = await s.plan(),
    check = s.mockCheck()
  await withNativeRuntimeCall(
    s.runtime,
    () => true,
    async () => {
      expect((await s.apply(p))[0]).toBe(false)
    }
  )
  expect((await s.apply(p, admin, { command: ["caller-command"] }))[0]).toBe(false)
  expect((await s.call("autocode.deployment.baseline.plan", { ...s.input, arbitraryPath: "/tmp" }))[0]).toBe(false)
  expect(check).not.toHaveBeenCalled()
})
it.each([
  "unpaused",
  "frozen",
  "held target",
  "bad staged evidence",
  "baseline is candidate",
  "numeric identity"
])("refuses invalid planning state: %s", async (state) => {
  const s = await setup(),
    input: any = { ...s.input },
    check = s.mockCheck()
  if (state === "unpaused") s.runtime.control.change(false)
  if (state === "frozen") s.runtime.control.freeze()
  if (state === "held target")
    s.store.put("deployment-target", s.targetKey, {
      ...s.store.get<any>("deployment-target", s.targetKey),
      state: "held"
    })
  if (state === "bad staged evidence") writeFileSync(s.proof, "changed")
  if (state === "baseline is candidate") input.revision = mergedSha
  if (state === "numeric identity") input.workflowId = Number("1".repeat(64))
  expect((await s.call("autocode.deployment.baseline.plan", input))[0]).toBe(false)
  expect(check).not.toHaveBeenCalled()
})
it("rechecks health freshness after the final public idle proof", async () => {
  const s = await setup(),
    p = await s.plan(),
    before = s.records(),
    check = s.mockCheck(),
    realNow = Date.now
  s.request.mockImplementation(async (method) => {
    if (check.mock.calls.length) vi.spyOn(Date, "now").mockImplementation(() => realNow() + 61000)
    return method === "workboard.cards.list"
      ? ({ cards: [] } as any)
      : ({ sessions: [], totalCount: 0, hasMore: false, nextOffset: null } as any)
  })
  expect((await s.apply(p))[0]).toBe(false)
  expect(check).toHaveBeenCalledOnce()
  expect(s.records()).toEqual(before)
})
it("refuses health artifact replacement during the last public idle proof", async () => {
  const s = await setup(),
    p = await s.plan(),
    before = s.records(),
    check = s.mockCheck()
  s.request.mockImplementation(async (method) => {
    if (check.mock.calls.length) writeFileSync(check.mock.calls[0]![2], "replaced health evidence")
    return method === "workboard.cards.list"
      ? ({ cards: [] } as any)
      : ({ sessions: [], totalCount: 0, hasMore: false, nextOffset: null } as any)
  })
  expect((await s.apply(p))[0]).toBe(false)
  expect(check).toHaveBeenCalledOnce()
  expect(s.records()).toEqual(before)
})
