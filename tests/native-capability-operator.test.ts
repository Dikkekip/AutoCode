import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { nativePolicyDigest } from "@openclaw/domain"
import { afterEach, describe, expect, it } from "vitest"
import { registerNativeCapabilityOperatorMethods } from "../packages/core-runtime/src/native/capability-operator.js"
import { NativeEvidenceStore } from "../packages/core-runtime/src/native/store.js"

const stores: NativeEvidenceStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})
function fixture() {
  const repository = mkdtempSync(join(tmpdir(), "native-capability-operator-"))
  const store = new NativeEvidenceStore(join(repository, "evidence.db"))
  stores.push(store)
  const policy = {
    repository,
    boardId: "board",
    plannerAgentId: "planner",
    coderAgentId: "coder",
    reviewerAgentId: "reviewer",
    personas: []
  } as any
  const requirements = {
    contextTokens: 16384,
    structuredOutput: false,
    tools: ["read"],
    cancellation: false,
    sessionResume: false,
    requireKnownCost: false
  }
  const roles = Object.fromEntries(
    ["planner", "coder", "reviewer"].map((id) => [id, { evidenceId: "old", requirements }])
  )
  store.commit(
    [
      { kind: "control", id: "pause", value: { paused: true, revision: "pause" } },
      { kind: "capability-requirements", id: "board", value: { policyDigest: nativePolicyDigest(policy), roles } }
    ],
    { kind: "fixture", subject: "board", value: {} }
  )
  const runtime = {
    policy,
    store,
    control: {
      get state() {
        return store.get("control", "pause")
      }
    }
  } as any
  const handlers = new Map<string, any>()
  const models = { planner: "sol", coder: "sol", reviewer: "sol" }
  const deps = {
    registerMethod: (name: string, handler: any, options: any) => {
      expect(options.scope).toBe("operator.admin")
      handlers.set(name, handler)
    },
    runtime: () => runtime,
    candidatePolicy: () => policy,
    configuredModels: async () => models
  }
  registerNativeCapabilityOperatorMethods(deps)
  const params = {
    boardId: "board",
    controlRevision: "pause",
    policyDigest: nativePolicyDigest(policy),
    requirementsPolicyDigest: nativePolicyDigest(policy),
    reason: "Reviewed authentic results"
  }
  const client = { connect: { scopes: ["operator.admin"], device: { id: "operator" } } }
  const call = async (action: string, extra: any, connection = client) => {
    let result: any
    await handlers.get(`autocode.capabilities.${action}`)({
      params: { ...params, ...extra },
      client: connection,
      respond: (...args: any[]) => {
        result = args
      }
    })
    return result
  }
  const root = join(repository, ".openclaw/native-artifacts/capabilities")
  mkdirSync(root, { recursive: true })
  const evidence = (agentId: string, mode = "live") => {
    const body = {
      version: 1,
      agentId,
      model: "sol",
      benchmarkId: "actual-test-fixture",
      datasetDigest: "a".repeat(64),
      policyDigest: params.policyDigest,
      mode,
      capabilities: {
        contextTokens: 16384,
        structuredOutput: null,
        tools: ["read"],
        cancellation: null,
        sessionResume: null,
        costPerVerifiedOutcome: null
      },
      measuredAt: Date.now() - 1000,
      expiresAt: Date.now() + 60000
    }
    const raw = JSON.stringify(body),
      path = join(root, `${agentId}.json`)
    writeFileSync(path, raw)
    return { ...body, artifact: { path, sha256: createHash("sha256").update(raw).digest("hex") } }
  }
  return { store, policy, deps, params, call, client, roles, evidence }
}
describe("native capability operator gateway", () => {
  it("registers exact protected evidence and approves the whole unchanged requirement set", async () => {
    const f = fixture()
    const roles = structuredClone(f.roles)
    for (const id of Object.keys(roles)) {
      const result = await f.call("register", { evidence: f.evidence(id) })
      expect(result[0]).toBe(true)
      roles[id]!.evidenceId = result[1].evidenceId
    }
    expect((await f.call("approve", { roles }))[0]).toBe(true)
    expect(f.store.get<any>("capability-requirements", "board")?.policyDigest).toBe(f.params.policyDigest)
  })
  it.each([
    "unauthorized",
    "agent",
    "extra",
    "revision",
    "digest",
    "controlled",
    "wrong-model"
  ])("rejects %s evidence without a write", async (fault) => {
    const f = fixture(),
      evidence = f.evidence("coder", fault === "controlled" ? "controlled-fixture" : "live")
    const extra: any = { evidence }
    let client = f.client
    if (fault === "unauthorized") client = { ...client, connect: { ...client.connect, scopes: [] } }
    if (fault === "agent") client = { ...client, connect: { ...client.connect, device: { id: "coder" } } }
    if (fault === "extra") extra.models = { coder: "invented" }
    if (fault === "revision") extra.controlRevision = "stale"
    if (fault === "digest") extra.policyDigest = "b".repeat(64)
    if (fault === "wrong-model") evidence.model = "wrong"
    expect((await f.call("register", extra, client))[0]).toBe(false)
    expect(f.store.list("capability-evidence")).toHaveLength(0)
  })
  it("rejects weakening requirements and topology changes", async () => {
    const f = fixture(),
      roles = structuredClone(f.roles)
    roles.coder!.requirements.contextTokens = 1
    expect((await f.call("approve", { roles }))[2].message).toMatch(/Preserve/)
    f.policy.coderAgentId = "other"
    expect((await f.call("register", { evidence: f.evidence("coder") }))[0]).toBe(false)
  })
  it("rechecks paused control after asynchronous configuration reads", async () => {
    const f = fixture()
    f.deps.configuredModels = async () => {
      f.store.commit([{ kind: "control", id: "pause", value: { paused: false, revision: "resumed" } }], {
        kind: "fixture",
        subject: "board",
        value: {}
      })
      return { planner: "sol", coder: "sol", reviewer: "sol" }
    }
    expect((await f.call("register", { evidence: f.evidence("coder") }))[2].message).toMatch(/paused/)
    expect(f.store.list("capability-evidence")).toHaveLength(0)
  })
  it("explicitly preserves the older reviewed requirements across a nonrelease measurement phase", async () => {
    const f = fixture()
    const candidate = { ...f.policy, mode: "application-release" }
    f.deps.candidatePolicy = () => candidate
    f.params.policyDigest = nativePolicyDigest(candidate)
    expect((await f.call("register", { evidence: f.evidence("coder") }))[0]).toBe(true)
    expect((await f.call("register", { evidence: f.evidence("planner"), requirementsPolicyDigest: "stale" }))[0]).toBe(
      false
    )
  })
})
