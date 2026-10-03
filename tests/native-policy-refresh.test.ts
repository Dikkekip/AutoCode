import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import {
  nativeCustodyLocalEvidence,
  nativeCustodyLocalIdentity
} from "../packages/core-runtime/src/native/custody-local-evidence.js"
import { nativeDoctor } from "../packages/core-runtime/src/native/doctor.js"
import { nativeEffectCustodyHeld } from "../packages/core-runtime/src/native/effect-custody.js"
import { NativeSdkGateway } from "../packages/core-runtime/src/native/gateway.js"
import { registerNativeAutonomyPlugin } from "../packages/core-runtime/src/native/plugin.js"
import { nativeLoadedPolicyDigest } from "../packages/core-runtime/src/native/policy-refresh.js"
import type { NativeAutonomyRuntime } from "../packages/core-runtime/src/native/runtime.js"
import { withNativeRuntimeCall } from "../packages/core-runtime/src/native/runtime-lifetime.js"
import { upgradeNativeLifecycle } from "../packages/domain/src/native-lifecycle.js"

vi.mock("../packages/core-runtime/src/native/doctor.js", async (original) => ({
  ...(await original<typeof import("../packages/core-runtime/src/native/doctor.js")>()),
  nativeDoctor: vi.fn()
}))
vi.mock("../packages/core-runtime/src/native/custody-local-evidence.js", () => ({
  nativeCustodyLocalEvidence: vi.fn(),
  nativeCustodyLocalIdentity: vi.fn()
}))
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})
const admin = { connect: { device: { id: "reviewed-operator" }, scopes: ["operator.admin"] } }
async function setup(configure?: (policy: any) => void) {
  const root = mkdtempSync(join(tmpdir(), "native-refresh-")),
    repo = join(root, "repo"),
    file = join(root, "policy.json")
  mkdirSync(repo)
  vi.stubEnv("OPENCLAW_CONTROL_ROOT", join(root, "control"))
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      enabled: true,
      boardId: "refresh-app",
      repository: repo,
      repositoryKind: "application",
      baseBranch: "main",
      plannerAgentId: "planner",
      coderAgentId: "coder",
      reviewerAgentId: "reviewer",
      personas: [
        { personaId: "research", goals: ["navigation"], successObservations: ["page opens"], allowedPaths: ["src"] }
      ],
      verification: [{ argv: ["true"], cwd: "." }],
      deployment: { command: { argv: ["true"], cwd: "." }, check: { argv: ["true"], cwd: "." } }
    })
  )
  if (configure) {
    const policy = JSON.parse(readFileSync(file, "utf8"))
    configure(policy)
    writeFileSync(file, JSON.stringify(policy))
  }
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
  vi.mocked(nativeDoctor).mockResolvedValue({ ok: true, enabled: true, boardId: "refresh-app", checks: [] })
  const request = vi.spyOn(NativeSdkGateway.prototype, "request").mockImplementation(async (method) => {
    if (method === "workboard.cards.list") return { cards: [] } as any
    if (method === "sessions.list") return { sessions: [], totalCount: 0, hasMore: false, nextOffset: null } as any
    throw new Error("Unexpected gateway method " + method)
  })
  const get = () =>
    (globalThis as any)[Symbol.for("autocode.native.service-runtimes.v1")].get("refresh-app") as NativeAutonomyRuntime
  const call = async (method: string, params: any = {}, client: any = admin) => {
    let response: any
    const handler = methods.get(method)
    if (!handler) return [false, undefined, { code: "unknown_method" }]
    await handler({
      params: { boardId: "refresh-app", ...params },
      client,
      respond: (...args: any[]) => {
        response = args
      }
    })
    return response
  }
  await service.start()
  await call("autocode.pause")
  cleanups.push(async () => {
    await service.stop()
    rmSync(root, { recursive: true, force: true })
  })
  const edit = (mutate: (value: any) => void) => {
    const value = JSON.parse(readFileSync(file, "utf8"))
    mutate(value)
    writeFileSync(file, JSON.stringify(value))
  }
  const plan = async () => {
    const result = await call("autocode.policy.refresh.plan")
    expect(result[0]).toBe(true)
    return result[1]
  }
  const apply = (p: any, extra: any = {}, client: any = admin) =>
    call("autocode.policy.refresh.apply", { plan: p, reason: "Reviewed policy-only change", ...extra }, client)
  return { root, repo, file, call, get, request, edit, plan, apply, service }
}
it("refreshes exactly reviewed policy while retaining pause, store, and archived evidence", async () => {
  const s = await setup(),
    previous = s.get(),
    control = previous.control.state
  previous.store.put("attempt-history", "preserved", { candidate: "unchanged" })
  s.edit((p) => {
    p.verification[0].argv = ["true", "reviewed-change"]
  })
  const plan = await s.plan()
  expect(plan.loadedDigest).not.toBe(plan.candidateDigest)
  expect((await s.apply(plan))[0]).toBe(true)
  const current = s.get()
  expect(current).not.toBe(previous)
  expect(current.store).toBe(previous.store)
  expect(current.control.state).toEqual(control)
  expect(current.store.get("attempt-history", "preserved")).toEqual({ candidate: "unchanged" })
  expect(nativeLoadedPolicyDigest(current.policy)).toBe(plan.candidateDigest)
  await expect(
    withNativeRuntimeCall(
      previous,
      () => true,
      async () => 1
    )
  ).rejects.toThrow(/generation/)
  expect((await s.call("autocode.doctor"))[1].loadedPolicyDigest).toBe(plan.candidateDigest)
})
it.each([
  null,
  { connect: { scopes: ["operator.read"] } },
  { connect: { scopes: ["operator.admin"] } }
])("requires verified administrator identity: %j", async (client) => {
  const s = await setup(),
    before = s.get()
  expect((await s.apply(await s.plan(), {}, client))[0]).toBe(false)
  expect(s.get()).toBe(before)
})
it("rejects unknown arguments and forged plan fields", async () => {
  const s = await setup(),
    plan = await s.plan()
  expect((await s.apply(plan, { operatorId: "forged" }))[0]).toBe(false)
  expect((await s.apply({ ...plan, arbitraryPath: "/tmp/other" }))[0]).toBe(false)
})
it.each(["loadedDigest", "candidateDigest", "controlRevision"])("rejects stale %s", async (field) => {
  const s = await setup(),
    before = s.get(),
    plan = await s.plan()
  expect((await s.apply({ ...plan, [field]: field.includes("Digest") ? "0".repeat(64) : "stale" }))[0]).toBe(false)
  expect(s.get()).toBe(before)
})
it("requires an explicit persisted pause even for a disabled policy", async () => {
  const s = await setup()
  s.get().control.change(false)
  expect((await s.call("autocode.policy.refresh.plan"))[0]).toBe(false)
})
it.each(["repository", "boardId", "baseBranch", "coderAgentId"])("rejects topology change %s", async (field) => {
  const s = await setup()
  s.edit((p) => {
    p[field] = field === "repository" ? s.root : "different"
  })
  expect((await s.call("autocode.policy.refresh.plan"))[0]).toBe(false)
})
it("keeps previous runtime on failed doctor and on control changes during doctor", async () => {
  const s = await setup(),
    before = s.get(),
    plan = await s.plan()
  vi.mocked(nativeDoctor).mockResolvedValueOnce({ ok: false, enabled: true, boardId: "refresh-app", checks: [] })
  expect((await s.apply(plan))[0]).toBe(false)
  expect(s.get()).toBe(before)
  vi.mocked(nativeDoctor).mockImplementationOnce(async () => {
    before.control.change(true)
    return { ok: true, enabled: true, boardId: "refresh-app", checks: [] }
  })
  expect((await s.apply(plan))[0]).toBe(false)
  expect(s.get()).toBe(before)
})
it("blocks refresh while a normal native RPC awaits and blocks new RPCs during refresh", async () => {
  const s = await setup(),
    plan = await s.plan(),
    before = s.get()
  let release!: () => void
  vi.mocked(nativeDoctor).mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      release = resolve
    })
    return { ok: true, enabled: true, boardId: "refresh-app", checks: [] }
  })
  const normal = s.call("autocode.doctor")
  expect((await s.apply(plan))[0]).toBe(false)
  release()
  await normal
  let doctorEntered!: () => void
  const entered = new Promise<void>((resolve) => {
    doctorEntered = resolve
  })
  vi.mocked(nativeDoctor).mockImplementationOnce(async () => {
    doctorEntered()
    await new Promise<void>((resolve) => {
      release = resolve
    })
    return { ok: true, enabled: true, boardId: "refresh-app", checks: [] }
  })
  const refresh = s.apply(plan)
  await entered
  expect((await s.call("autocode.resume"))[0]).toBe(false)
  expect(s.get()).toBe(before)
  release()
  expect((await refresh)[0]).toBe(true)
})
it.each(["operation", "effect-intent", "lease"])("rejects unresolved local %s", async (kind) => {
  const s = await setup(),
    plan = await s.plan()
  if (kind === "lease") s.get().store.acquire("verification", 60000)
  else s.get().store.put(kind, "uncertain", { state: "pending" })
  expect((await s.apply(plan))[0]).toBe(false)
})
it.each([
  "running-card",
  "active-session",
  "unknown-session",
  "partial-pages",
  "missing-session"
])("rejects incomplete remote drain: %s", async (kind) => {
  const s = await setup(),
    plan = await s.plan()
  s.request.mockImplementation(async (method) => {
    if (method === "workboard.cards.list")
      return {
        cards:
          kind === "running-card"
            ? [{ id: "card", title: "Owned", status: "running", agentId: "coder" }]
            : kind === "missing-session"
              ? [{ id: "card", title: "Owned", status: "done", sessionKey: "missing" }]
              : []
      } as any
    return {
      sessions:
        kind.endsWith("session") && kind !== "missing-session"
          ? [
              {
                key: "s",
                agentId: "coder",
                hasActiveRun: kind === "active-session",
                hasActiveSubagentRun: false,
                activeRunIds: kind === "unknown-session" ? undefined : ["run"]
              }
            ]
          : [],
      totalCount: kind.endsWith("session") && kind !== "missing-session" ? 1 : 0,
      hasMore: kind === "partial-pages",
      nextOffset: null
    } as any
  })
  expect((await s.apply(plan))[0]).toBe(false)
})
it.each([
  { label: "omitted", fields: {}, accepted: true },
  { label: "false", fields: { hasActiveSubagentRun: false }, accepted: true },
  ...[true, null, 0, "false", [], {}].map((value) => ({
    label: `invalid ${JSON.stringify(value)}`,
    fields: { hasActiveSubagentRun: value },
    accepted: false
  })),
  { label: "omitted with active run", fields: { hasActiveRun: true }, accepted: false },
  { label: "omitted with missing run flag", fields: { hasActiveRun: undefined }, accepted: false },
  { label: "omitted with active run IDs", fields: { activeRunIds: ["live"] }, accepted: false },
  { label: "omitted with running status", fields: { status: "running" }, accepted: false }
])("honors the optional subagent flag contract: $label", async ({ fields, accepted }) => {
  const s = await setup(),
    plan = await s.plan()
  s.request.mockImplementation(async (method) => {
    if (method === "workboard.cards.list") return { cards: [] } as any
    return {
      sessions: [
        { key: "historical", agentId: "coder", hasActiveRun: false, activeRunIds: [], status: "done", ...fields }
      ],
      totalCount: 1,
      hasMore: false,
      nextOffset: null
    } as any
  })
  const result = await s.apply(plan)
  expect(result[0]).toBe(accepted)
  if (!accepted) expect(result[2].message).toMatch(/active or ambiguous/)
})
it("requires promoted exact skill binding before resume after policy refresh", async () => {
  const s = await setup(),
    skillPath = join(s.root, "SKILL.md")
  writeFileSync(skillPath, "Reviewed investigation rules")
  s.edit((p) => {
    p.quality = { skillPath }
  })
  const result = await s.apply(await s.plan())
  expect(result[0]).toBe(true)
  expect(result[1].requiresPromotion).toBe(true)
  expect((await s.call("autocode.resume"))[2].message).toMatch(/promotion/)
  expect((await s.call("autocode.doctor"))[1].ok).toBe(false)
  expect(s.get().control.state.paused).toBe(true)
})

it("binds successful refresh to one generation and rejects replay", async () => {
  const s = await setup(),
    plan = await s.plan()
  expect((await s.apply(plan))[0]).toBe(true)
  expect((await s.apply(plan))[0]).toBe(false)
})
it("fails closed when disk changes after planning", async () => {
  const s = await setup(),
    plan = await s.plan(),
    previous = s.get()
  s.edit((p) => {
    p.enabled = false
  })
  expect((await s.apply(plan))[0]).toBe(false)
  expect(s.get()).toBe(previous)
})
it("refuses a legacy execution owner", async () => {
  const s = await setup(),
    plan = await s.plan()
  const { ExecutionOwnerStore } = await import("../packages/os-adapters/src/execution-owner.js")
  const owner = new ExecutionOwnerStore()
  const lease = owner.acquire(s.repo, "legacy")
  owner.release(lease.id)
  owner.close()
  expect((await s.apply(plan))[0]).toBe(false)
})
it("validates all session pages and exact accepted-run terminal proof", async () => {
  const s = await setup(),
    plan = await s.plan()
  const card = {
    id: "owned",
    title: "Complete",
    status: "done",
    agentId: "coder",
    sessionKey: "owned-session",
    runId: "run",
    startedAt: 100,
    metadata: {
      automation: { launch: { phase: "accepted", acceptedSessionKey: "owned-session", acceptedRunId: "run" } }
    }
  }
  let endedAt: number | undefined = 200
  s.request.mockImplementation(async (method, params) => {
    if (method === "workboard.cards.list") return { cards: [card] } as any
    const sessions =
      params.offset === 0
        ? [{ key: "unrelated", agentId: "other", hasActiveRun: true }]
        : [
            {
              key: "owned-session",
              agentId: "coder",
              hasActiveRun: false,
              hasActiveSubagentRun: false,
              activeRunIds: [],
              status: "completed",
              endedAt
            }
          ]
    return { sessions, totalCount: 2, hasMore: params.offset === 0, nextOffset: params.offset === 0 ? 1 : null } as any
  })
  endedAt = undefined
  expect((await s.apply(plan))[0]).toBe(false)
  endedAt = 99
  expect((await s.apply(plan))[0]).toBe(false)
  endedAt = 200
  expect((await s.apply(plan))[0]).toBe(true)
  expect(s.request).toHaveBeenCalledWith("sessions.list", expect.objectContaining({ offset: 1, archived: "all" }))
})
it("service shutdown waits for in-flight reads before closing the shared store", async () => {
  const s = await setup(),
    previous = s.get()
  let release!: () => void
  vi.mocked(nativeDoctor).mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      release = resolve
    })
    return { ok: true, enabled: true, boardId: "refresh-app", checks: [] }
  })
  const call = s.call("autocode.doctor")
  let stopped = false
  const stop = s.service.stop().then(() => {
    stopped = true
  })
  await Promise.resolve()
  expect(stopped).toBe(false)
  expect(previous.store.db.isOpen).toBe(true)
  release()
  await call
  await stop
  expect(previous.store.db.isOpen).toBe(false)
})

it("rejects planner/reviewer role swaps even with the same agent multiset", async () => {
  const s = await setup()
  s.edit((p) => {
    ;[p.plannerAgentId, p.reviewerAgentId] = [p.reviewerAgentId, p.plannerAgentId]
  })
  expect((await s.call("autocode.policy.refresh.plan"))[0]).toBe(false)
})
it("allows a terminal human-review card but rejects an active review session", async () => {
  const s = await setup(),
    plan = await s.plan()
  let active = true
  s.request.mockImplementation(async (method) => {
    if (method === "workboard.cards.list")
      return {
        cards: [
          {
            id: "review",
            title: "Review",
            status: "review",
            agentId: "reviewer",
            sessionKey: "review-session",
            runId: "review-run",
            startedAt: 100,
            execution: { status: "review" }
          }
        ]
      } as any
    return {
      sessions: [
        {
          key: "review-session",
          agentId: "reviewer",
          hasActiveRun: active,
          hasActiveSubagentRun: false,
          activeRunIds: active ? ["review-run"] : [],
          endedAt: 200,
          status: "completed"
        }
      ],
      totalCount: 1,
      hasMore: false,
      nextOffset: null
    } as any
  })
  expect((await s.apply(plan))[0]).toBe(false)
  active = false
  expect((await s.apply(plan))[0]).toBe(true)
})

it("shutdown during refresh prevents publication and drains before store close", async () => {
  const s = await setup(),
    plan = await s.plan(),
    previous = s.get()
  const commit = vi.spyOn(previous.store, "commit")
  let release!: () => void, entered!: () => void
  const ready = new Promise<void>((resolve) => {
    entered = resolve
  })
  vi.mocked(nativeDoctor).mockImplementationOnce(async () => {
    entered()
    await new Promise<void>((resolve) => {
      release = resolve
    })
    return { ok: true, enabled: true, boardId: "refresh-app", checks: [] }
  })
  const apply = s.apply(plan)
  await ready
  const stop = s.service.stop()
  expect(previous.store.db.isOpen).toBe(true)
  release()
  expect((await apply)[0]).toBe(false)
  expect(commit.mock.calls.some((call) => call[1].kind === "policy.refreshed")).toBe(false)
  await stop
  expect(s.get()).toBeUndefined()
  expect(previous.store.db.isOpen).toBe(false)
})

it("rejects persona investigator remapping with the same agent multiset", async () => {
  const s = await setup((p) => {
    p.personas = ["one", "two"].map((id) => ({
      personaId: id,
      investigationAgentId: `inspect-${id}`,
      goals: ["navigation"],
      successObservations: ["page opens"],
      allowedPaths: ["src"]
    }))
  })
  s.edit((p) => {
    ;[p.personas[0].investigationAgentId, p.personas[1].investigationAgentId] = [
      p.personas[1].investigationAgentId,
      p.personas[0].investigationAgentId
    ]
  })
  expect((await s.call("autocode.policy.refresh.plan"))[0]).toBe(false)
})
it("CLI submits exact saved plan through the native admin RPC", async () => {
  const s = await setup(),
    plan = await s.plan(),
    file = join(s.root, "reviewed-plan.json")
  writeFileSync(file, JSON.stringify(plan))
  const { Command } = createRequire(resolve("apps/dispatcher-cli/package.json"))("commander")
  const { registerNativeAutonomyCommands } = await import("../apps/dispatcher-cli/src/native-autonomy.js")
  const program = new Command()
  registerNativeAutonomyCommands(program, { stdout: vi.fn() })
  const cliRequest = vi.spyOn(NativeSdkGateway.prototype, "request").mockResolvedValue({ accepted: true })
  await program.parseAsync(
    [
      "native",
      "--policy",
      s.file,
      "--openclaw",
      "/usr/bin/openclaw",
      "policy-refresh",
      "apply",
      "--plan",
      file,
      "--reason",
      "Reviewed exact candidate"
    ],
    { from: "user" }
  )
  expect(cliRequest).toHaveBeenLastCalledWith("autocode.policy.refresh.apply", {
    boardId: "refresh-app",
    plan,
    reason: "Reviewed exact candidate"
  })
})

it.each([
  "wrong-agent",
  "session-conflict",
  "run-conflict",
  "execution-agent-conflict"
])("rejects contradictory terminal ownership: %s", async (kind) => {
  const s = await setup(),
    plan = await s.plan()
  const execution =
    kind === "session-conflict"
      ? { sessionKey: "other-session" }
      : kind === "run-conflict"
        ? { runId: "other-run" }
        : kind === "execution-agent-conflict"
          ? { agentId: "other-agent" }
          : {}
  s.request.mockImplementation(async (method) => {
    if (method === "workboard.cards.list")
      return {
        cards: [
          {
            id: "owned",
            title: "Complete",
            status: "done",
            agentId: "coder",
            sessionKey: "owned-session",
            runId: "run",
            startedAt: 100,
            execution
          }
        ]
      } as any
    return {
      sessions: ["owned-session", "other-session"].map((key) => ({
        key,
        agentId: kind === "wrong-agent" ? "other-agent" : "coder",
        hasActiveRun: false,
        hasActiveSubagentRun: false,
        activeRunIds: [],
        endedAt: 200,
        status: "completed"
      })),
      totalCount: 2,
      hasMore: false,
      nextOffset: null
    } as any
  })
  expect((await s.apply(plan))[0]).toBe(false)
})

it("refreshes an explicit verification limit under the existing pause and digest guards", async () => {
  const s = await setup()
  const before = await s.plan()
  s.edit((p) => {
    p.verificationConcurrency = 1
  })
  const plan = await s.plan()
  expect(plan.loadedDigest).toBe(before.loadedDigest)
  expect(plan.candidateDigest).not.toBe(before.candidateDigest)
  const lease = s.get().store.acquire("capacity:verification:0", 60000)!
  expect((await s.apply(plan))[0]).toBe(false)
  s.get().store.release(lease)
  expect((await s.apply(plan))[0]).toBe(true)
  expect(s.get().policy.verificationConcurrency).toBe(1)
  expect(s.get().control.state.paused).toBe(true)
})

it.each([
  "preserved",
  "late-bookkeeping-end",
  "explicit-null",
  "partial-key",
  "partial-run",
  "partial-execution",
  "partial-start",
  "invalid-start",
  "missing-launch-time",
  "mismatched-request",
  "mismatched-provisional",
  "missing-attempt",
  "duplicate-attempt",
  "nonterminal-attempt",
  "wrong-attempt-key",
  "wrong-attempt-id",
  "missing-attempt-start",
  "bad-attempt-end",
  "attempt-after-acceptance",
  "active-session",
  "wrong-agent",
  "wrong-session",
  "missing-session",
  "session-before-acceptance"
])("checks preserved accepted launch after supported association clearing: %s", async (kind) => {
  const s = await setup(),
    plan = await s.plan()
  const launch: any = {
    phase: "accepted",
    requestedSessionKey: "historical",
    acceptedSessionKey: "historical",
    provisionalRunId: "run",
    acceptedRunId: "run",
    preparedAt: 100,
    acceptedAt: 110
  }
  const attempt: any = {
    id: "run",
    runId: "run",
    sessionKey: "historical",
    status: "succeeded",
    startedAt: 90,
    endedAt: kind === "late-bookkeeping-end" ? 900 : 150
  }
  const card: any = {
    id: "historical-card",
    title: "Archived",
    status: "blocked",
    agentId: "coder",
    metadata: { automation: { launch }, attempts: [attempt] }
  }
  const session: any = {
    key: "historical",
    agentId: "coder",
    status: "done",
    hasActiveRun: false,
    activeRunIds: [],
    endedAt: 200
  }
  if (kind === "explicit-null") Object.assign(card, { execution: null, sessionKey: null, runId: null, startedAt: null })
  if (kind === "partial-key") card.sessionKey = "historical"
  if (kind === "partial-run") card.runId = "run"
  if (kind === "partial-execution") card.execution = {}
  if (kind === "partial-start") card.startedAt = 90
  if (kind === "invalid-start") card.startedAt = "invalid"
  if (kind === "missing-launch-time") delete launch.acceptedAt
  if (kind === "mismatched-request") launch.requestedSessionKey = "other"
  if (kind === "mismatched-provisional") launch.provisionalRunId = "other"
  if (kind === "missing-attempt") card.metadata.attempts = []
  if (kind === "duplicate-attempt") card.metadata.attempts.push({ ...attempt })
  if (kind === "nonterminal-attempt") attempt.status = "running"
  if (kind === "wrong-attempt-key") attempt.sessionKey = "other"
  if (kind === "wrong-attempt-id") attempt.id = "other"
  if (kind === "missing-attempt-start") delete attempt.startedAt
  if (kind === "bad-attempt-end") attempt.endedAt = 80
  if (kind === "attempt-after-acceptance") attempt.startedAt = 120
  if (kind === "active-session") session.hasActiveRun = true
  if (kind === "wrong-agent") session.agentId = "unrelated"
  if (kind === "wrong-session") session.key = "other"
  if (kind === "session-before-acceptance") session.endedAt = 105
  s.request.mockImplementation(async (method) =>
    method === "workboard.cards.list"
      ? ({ cards: [card] } as any)
      : ({
          sessions: kind === "missing-session" ? [] : [session],
          totalCount: kind === "missing-session" ? 0 : 1,
          hasMore: false,
          nextOffset: null
        } as any)
  )
  expect((await s.apply(plan))[0]).toBe(["preserved", "late-bookkeeping-end", "explicit-null"].includes(kind))
})

it.each([1434, 10000])("reads %i sessions with bounded larger pages in both idle proofs", async (total) => {
  const s = await setup(),
    plan = await s.plan()
  const offsets: number[] = []
  s.request.mockImplementation(async (method, params) => {
    if (method === "workboard.cards.list") return { cards: [] } as any
    expect(method).toBe("sessions.list")
    expect(params.limit).toBe(1000)
    offsets.push(params.offset)
    const count = Math.min(params.limit, total - params.offset)
    return {
      sessions: Array.from({ length: count }, (_, i) => ({ key: `unrelated-${params.offset + i}`, agentId: "other" })),
      totalCount: total,
      hasMore: params.offset + count < total,
      nextOffset: params.offset + count < total ? params.offset + count : null
    } as any
  })
  expect((await s.apply(plan))[0]).toBe(true)
  const proofOffsets = Array.from({ length: Math.ceil(total / 1000) }, (_, i) => i * 1000)
  expect(offsets).toEqual([...proofOffsets, ...proofOffsets])
})

it.each([
  "total cap",
  "page cap",
  "duplicate",
  "changed total",
  "cursor skip",
  "premature terminal",
  "terminal cursor",
  "cumulative cap"
])("rejects invalid larger-page inventory: %s", async (kind) => {
  const s = await setup(),
    plan = await s.plan()
  const before = s.get()
  s.request.mockImplementation(async (method, params) => {
    if (method === "workboard.cards.list") return { cards: [] } as any
    const offset = params.offset as number
    let totalCount = kind === "cumulative cap" ? 10000 : 1434
    let count = Math.min(1000, totalCount - offset)
    let nextOffset: number | null = offset + count < totalCount ? offset + count : null
    let hasMore = nextOffset !== null
    if (kind === "total cap") totalCount = 10001
    if (kind === "page cap") count = 1001
    if (kind === "changed total" && offset) totalCount++
    if (kind === "cursor skip") nextOffset = offset + count + 1
    if (kind === "premature terminal") {
      hasMore = false
      nextOffset = null
    }
    if (kind === "terminal cursor" && offset) nextOffset = offset + count
    if (kind === "cumulative cap") {
      count = offset >= 10000 ? 1 : 1000
      hasMore = true
      nextOffset = offset + count
    }
    return {
      sessions: Array.from({ length: count }, (_, i) => ({
        key: kind === "duplicate" && offset && i === 0 ? "row-0" : `row-${offset + i}`,
        agentId: "other"
      })),
      totalCount,
      hasMore,
      nextOffset
    } as any
  })
  expect((await s.apply(plan))[0]).toBe(false)
  expect(s.get()).toBe(before)
})

it.each([50, 51])("retains the 50-request bound for %i legal short pages", async (total) => {
  const s = await setup(),
    plan = await s.plan()
  let calls = 0
  s.request.mockImplementation(async (method, params) => {
    if (method === "workboard.cards.list") return { cards: [] } as any
    expect(params.limit).toBe(1000)
    calls++
    return {
      sessions: [{ key: `short-${params.offset}`, agentId: "other" }],
      totalCount: total,
      hasMore: params.offset + 1 < total,
      nextOffset: params.offset + 1 < total ? params.offset + 1 : null
    } as any
  })
  expect((await s.apply(plan))[0]).toBe(total === 50)
  expect(calls).toBe(total === 50 ? 100 : 50)
})

it("rejects an owned active session appearing on the second page of the second proof", async () => {
  const s = await setup(),
    plan = await s.plan()
  const before = s.get()
  let proof = 0
  s.request.mockImplementation(async (method, params) => {
    if (method === "workboard.cards.list") return { cards: [] } as any
    if (params.offset === 0) proof++
    const count = params.offset === 0 ? 1000 : 1
    return {
      sessions: Array.from({ length: count }, (_, i) =>
        proof === 2 && params.offset === 1000
          ? { key: "owned", agentId: "coder", hasActiveRun: true, activeRunIds: ["run"] }
          : { key: `row-${params.offset + i}`, agentId: "other" }
      ),
      totalCount: 1001,
      hasMore: params.offset === 0,
      nextOffset: params.offset === 0 ? 1000 : null
    } as any
  })
  expect((await s.apply(plan))[0]).toBe(false)
  expect(proof).toBe(2)
  expect(s.get()).toBe(before)
})

it.each([
  "closed",
  "pending-foreign",
  "unconfirmed-replacement",
  "changed-replacement",
  "changed-old-version",
  "forged-operation"
])("refresh recognizes only exact closed repair supersession: %s", async (scenario) => {
  const s = await setup(),
    before = s.get(),
    store = before.store
  const id = "card:workflow:preserved:repair:8"
  const input = { idempotencyKey: "workflow:preserved:repair:8", workspace: { kind: "dir", path: s.repo } }
  const replacementInput = {
    idempotencyKey: "workflow:preserved:repair:8:managed-source-v1",
    workspace: { kind: "worktree", sourcePath: s.repo, sourceBranch: "origin/main" }
  }
  store.put("effect-intent", id, { state: "pending", input })
  const priorVersion = store.version("effect-intent", id)
  store.put("effect-intent", id, {
    state: "superseded",
    input,
    replacementId: `${id}:managed-source-v1`,
    replacementInput,
    supersession: { workflowId: "preserved", completeAllCardAbsence: true, priorVersion }
  })
  store.put("effect-intent", `${id}:managed-source-v1`, {
    state: scenario === "unconfirmed-replacement" ? "pending" : "confirmed",
    input: scenario === "changed-replacement" ? { ...replacementInput, unexpected: true } : replacementInput,
    card: { id: "actual-confirmed-replacement" }
  })
  if (scenario === "changed-old-version") store.put("effect-intent", id, store.get("effect-intent", id))
  if (scenario === "pending-foreign")
    store.put("effect-intent", "card:foreign", { state: "pending", input: { idempotencyKey: "foreign" } })
  if (scenario === "forged-operation") store.put("operation", id, store.get("effect-intent", id))
  const preserved = store.get("effect-intent", id),
    version = store.version("effect-intent", id)
  s.edit((p) => {
    p.verification[0].argv = ["true", "reviewed-change"]
  })
  const result = await s.apply(await s.plan())
  expect(result[0]).toBe(scenario === "closed")
  expect(store.get("effect-intent", id)).toEqual(preserved)
  expect(store.version("effect-intent", id)).toBe(version)
  if (scenario !== "closed") expect(s.get()).toBe(before)
  if (scenario === "pending-foreign")
    expect(store.get("effect-intent", "card:foreign")).toEqual({
      state: "pending",
      input: { idempotencyKey: "foreign" }
    })
})

async function custodyFixture() {
  const s = await setup(),
    store = s.get().store,
    id = `card:workflow:${"a".repeat(64)}:implement`
  const input = {
    boardId: "refresh-app",
    title: "Preserved original",
    idempotencyKey: id.slice(5),
    status: "blocked",
    workspace: { kind: "worktree", sourcePath: s.repo, sourceBranch: "origin/main" },
    notes: "Preserve original uncertain input"
  }
  store.commit([{ kind: "effect-intent", id, value: { input, state: "pending" }, expectedVersion: 0 }], {
    kind: "effect.prepared",
    subject: id,
    value: { correlationKey: input.idempotencyKey }
  })
  vi.mocked(nativeCustodyLocalEvidence).mockReturnValue({
    configPath: "/fixture/local/openclaw.json",
    configSha256: "c".repeat(64),
    gatewayMode: "local",
    port: 18789,
    currentPid: 100,
    processStartTicks: 100,
    ticksPerSecond: 100,
    bootId: "b".repeat(32),
    oldPid: 99,
    unit: "fixture.service",
    rejectedAtUs: 1000,
    rejectionMessageSha256: "d".repeat(64),
    rejectedMonotonicUs: 1,
    journalRejectionSha256: "e".repeat(64),
    uncertainty: "fixture local observation; original wire key unavailable"
  })
  const {
    oldPid: _oldPid,
    rejectedAtUs: _at,
    rejectedMonotonicUs: _mono,
    rejectionMessageSha256: _message,
    journalRejectionSha256: _journal,
    uncertainty: _uncertainty,
    ...identity
  } = vi.mocked(nativeCustodyLocalEvidence)(1)
  vi.mocked(nativeCustodyLocalIdentity).mockReturnValue(identity)
  return {
    ...s,
    store,
    id,
    input,
    holdPlan: () =>
      s.call("autocode.effects.hold.plan", {
        intentIds: [id],
        reason: "Hold unresolved original create; no replay or success assertion"
      }),
    holdApply: (plan: any, client: any = admin) => s.call("autocode.effects.hold.apply", { plan }, client)
  }
}
it("native custody API preserves uncertain input and prevents replay while permitting exact idle refresh", async () => {
  const s = await custodyFixture(),
    original = s.store.get("effect-intent", s.id),
    version = s.store.version("effect-intent", s.id)
  const planned = await s.holdPlan()
  expect(planned[0]).toBe(true)
  const applied = await s.holdApply(planned[1])
  expect(applied[0]).toBe(true)
  expect(applied[1].externalSuccessConfirmed).toBe(false)
  expect(s.store.get("effect-intent", s.id)).toEqual(original)
  expect(s.store.version("effect-intent", s.id)).toBe(version)
  expect(nativeEffectCustodyHeld(s.store, s.id)).toBe(true)
  await expect(s.get().createCard(s.input)).rejects.toThrow(/held intent/)
  expect((await s.apply(await s.plan()))[0]).toBe(true)
  expect(s.store.get("effect-intent", s.id)).toEqual(original)
})
it.each([
  "forged-plan",
  "changed-input",
  "wrong-owner",
  "active-card",
  "incomplete-cards",
  "late-card",
  "manual-card",
  "archived-card",
  "operation",
  "unselected-pending",
  "generation",
  "missing-local-proof",
  "no-admin"
])("native custody refuses %s", async (scenario) => {
  const s = await custodyFixture(),
    planned = await s.holdPlan()
  expect(planned[0]).toBe(true)
  const plan = planned[1],
    before = s.get()
  if (scenario === "forged-plan") plan.reason = "Forged"
  if (scenario === "changed-input")
    s.store.put("effect-intent", s.id, { input: { ...s.input, notes: "Changed" }, state: "pending" })
  if (scenario === "wrong-owner") s.store.put("workflow", "a".repeat(64), { unexpected: true })
  if (
    scenario === "active-card" ||
    scenario === "incomplete-cards" ||
    scenario === "late-card" ||
    scenario === "manual-card" ||
    scenario === "archived-card"
  )
    s.request.mockImplementation(async (method) => {
      if (method === "workboard.cards.list")
        return scenario === "incomplete-cards"
          ? ({ cards: [], hasMore: true } as any)
          : ({
              cards: [
                {
                  id: "remote",
                  boardId: "refresh-app",
                  title: "Remote",
                  status: scenario === "active-card" ? "running" : "done",
                  metadata: {
                    automation: {
                      boardId: "refresh-app",
                      idempotencyKey:
                        scenario === "manual-card" ? `manual:${s.input.idempotencyKey}` : s.input.idempotencyKey
                    },
                    ...(scenario === "archived-card" ? { archivedAt: "retained" } : {})
                  }
                }
              ]
            } as any)
      if (method === "sessions.list") return { sessions: [], totalCount: 0, hasMore: false, nextOffset: null } as any
      throw new Error("Unexpected method")
    })
  if (scenario === "operation") s.store.put("operation", "uncertain", { state: "pending" })
  if (scenario === "unselected-pending") s.store.put("effect-intent", "card:unselected", { state: "pending" })
  if (scenario === "generation") plan.generation = "stale"
  if (scenario === "missing-local-proof")
    vi.mocked(nativeCustodyLocalEvidence).mockImplementation(() => {
      throw new Error("Original local create rejection is missing or ambiguous")
    })
  const result = await s.holdApply(plan, scenario === "no-admin" ? { connect: { scopes: ["operator.read"] } } : admin)
  expect(result[0]).toBe(false)
  expect(s.store.get("effect-custody", s.id)).toBeNull()
  expect(s.get()).toBe(before)
})
it("forged hold without native audit cannot admit refresh; late card invalidates genuine hold", async () => {
  const s = await custodyFixture(),
    p = (await s.holdPlan())[1]
  const entry = p.entries[0]
  s.store.put("effect-custody", s.id, {
    state: "unresolved-held-no-replay",
    entry,
    operatorId: "forged",
    reason: "Forged",
    boardId: "refresh-app",
    planDigest: p.digest
  })
  expect(nativeEffectCustodyHeld(s.store, s.id)).toBe(false)
  expect((await s.apply(await s.plan()))[0]).toBe(false)
})

it.each([
  "raw",
  "manual",
  "archived",
  "unknown-title"
])("published hold stops native refresh when %s matching card later appears", async (variant) => {
  const s = await custodyFixture(),
    p = (await s.holdPlan())[1]
  expect((await s.holdApply(p))[0]).toBe(true)
  const rawBefore = s.store.db
    .prepare("SELECT data FROM native_records WHERE kind='effect-intent' AND id=?")
    .get(s.id)?.data
  s.request.mockImplementation(async (method) => {
    if (method === "workboard.cards.list")
      return {
        cards: [
          {
            id: "late",
            boardId: "refresh-app",
            title: s.input.title,
            status: "done",
            metadata: {
              ...(variant === "archived" ? { archivedAt: "retained" } : {}),
              automation:
                variant === "unknown-title"
                  ? {}
                  : {
                      idempotencyKey: variant === "manual" ? `manual:${s.input.idempotencyKey}` : s.input.idempotencyKey
                    }
            }
          }
        ]
      } as any
    if (method === "sessions.list") return { sessions: [], totalCount: 0, hasMore: false, nextOffset: null } as any
    throw new Error("Unexpected method")
  })
  expect((await s.apply(await s.plan()))[0]).toBe(false)
  await expect((s.get() as any).authorizeDispatch({ request: s.request })).rejects.toThrow(/matching remote card/)
  expect(
    s.store.db.prepare("SELECT data FROM native_records WHERE kind='effect-intent' AND id=?").get(s.id)?.data
  ).toBe(rawBefore)
})
it("holds cannot be planned with an active lease or active session, and caller proof fields are rejected", async () => {
  const s = await custodyFixture()
  const lease = s.store.acquire("foreign-operation", 60_000)!
  expect((await s.holdPlan())[0]).toBe(false)
  s.store.release(lease)
  expect(
    (await s.call("autocode.effects.hold.plan", { intentIds: [s.id], reason: "Hold", journalProof: true }))[0]
  ).toBe(false)
  s.request.mockImplementation(async (method) => {
    if (method === "workboard.cards.list") return { cards: [] } as any
    if (method === "sessions.list")
      return {
        sessions: [
          {
            key: "agent:coder:active",
            agentId: "coder",
            status: "running",
            hasActiveRun: true,
            activeRunIds: ["actual"]
          }
        ],
        totalCount: 1,
        hasMore: false,
        nextOffset: null
      } as any
    throw new Error("Unexpected method")
  })
  expect((await s.holdPlan())[0]).toBe(false)
})

async function blockedCustodyFixture(activeOwner = false) {
  const s = await custodyFixture(),
    workflowId = "a".repeat(64)
  s.store.db.prepare("DELETE FROM native_records WHERE kind='effect-intent' AND id=?").run(s.id)
  s.store.db.prepare("DELETE FROM native_versions WHERE kind='effect-intent' AND id=?").run(s.id)
  const id = `card:workflow:${workflowId}:repair:1`
  const input = {
    ...s.input,
    idempotencyKey: id.slice(5),
    workspace: { kind: "dir", path: "/previous/owned/candidate" }
  }
  const workflow = {
    proposal: { title: "Preserved", allowedPaths: ["src"], acceptance: ["works"], implementationPrompt: "Preserve" },
    rootCardId: "root",
    implementationCardId: "implementation",
    stageCards: {},
    repairCount: 0,
    blocker: "workspace path is outside the caller allowed workspaces",
    lifecycle: upgradeNativeLifecycle(workflowId, { blocker: "workspace path is outside" }),
    candidate: {
      headSha: "1".repeat(40),
      baseSha: "2".repeat(40),
      files: ["src/fix.ts"],
      cwd: "/previous/owned/candidate"
    },
    designReview: { verdict: "changes" },
    riskAssessment: { level: "low" },
    submission: { headSha: "1".repeat(40) }
  }
  workflow.lifecycle = upgradeNativeLifecycle(workflowId, workflow)
  if (activeOwner) workflow.lifecycle = { ...workflow.lifecycle, state: "verification" }
  s.store.put("workflow", workflowId, workflow)
  s.store.put("admission", workflowId, { phase: "prepared", original: true })
  s.store.put("attempt-evidence", `${workflowId}:1`, {
    ...workflow,
    lifecycle: { ...workflow.lifecycle, state: "design_wait" },
    reason: "design changes",
    observation: "Original reviewer reason"
  })
  s.store.commit([{ kind: "effect-intent", id, value: { state: "pending", input }, expectedVersion: 0 }], {
    kind: "effect.prepared",
    subject: id,
    value: { correlationKey: input.idempotencyKey }
  })
  s.request.mockImplementation(async (method) => {
    if (method === "workboard.cards.list")
      return {
        cards: [
          { id: "root", title: "Task", status: "blocked" },
          { id: "implementation", title: "Implement", status: "blocked" }
        ]
      } as any
    if (method === "sessions.list") return { sessions: [], totalCount: 0, hasMore: false, nextOffset: null } as any
    throw new Error(`Unexpected method ${method}`)
  })
  return {
    ...s,
    id,
    input,
    workflowId,
    workflow,
    holdPlan: () =>
      s.call("autocode.effects.hold.plan", {
        intentIds: [id],
        reason: "Preserve unresolved rejected repair without replay"
      })
  }
}
it("blocked-owner custody survives genuine native cancellation without changing original pending bytes or budgets", async () => {
  const s = await blockedCustodyFixture()
  const raw = s.store.db.prepare("SELECT data FROM native_records WHERE kind='effect-intent' AND id=?").get(s.id)?.data
  const version = s.store.version("effect-intent", s.id)
  const p = await s.holdPlan()
  expect(p[0]).toBe(true)
  expect((await s.holdApply(p[1]))[0]).toBe(true)
  expect(nativeEffectCustodyHeld(s.store, s.id)).toBe(true)
  const retry = await s.get().planWorkflowRecovery(s.workflowId, "retry", "Never replay held input")
  expect(retry.allowed).toBe(false)
  const cancel = await s.get().planWorkflowRecovery(s.workflowId, "cancel", "Abandon unresolved rejected repair")
  expect(cancel.blockers).toEqual([])
  expect((await s.get().applyWorkflowRecovery(cancel, "reviewed-operator")).applied).toBe(true)
  expect(nativeEffectCustodyHeld(s.store, s.id)).toBe(true)
  const current = s.store.get<any>("workflow", s.workflowId)
  expect(current.lifecycle.attempt).toBe(s.workflow.lifecycle.attempt)
  expect(current.repairCount).toBe(0)
  expect(current.candidate).toEqual(s.workflow.candidate)
  const archive = await s
    .get()
    .planWorkflowRecovery(s.workflowId, "archive", "Archive safely cancelled original while retaining uncertainty")
  expect(archive.blockers).toEqual([])
  expect((await s.get().applyWorkflowRecovery(archive, "reviewed-operator")).applied).toBe(true)
  expect(nativeEffectCustodyHeld(s.store, s.id)).toBe(true)
  expect(s.store.get<any>("workflow", s.workflowId).archivedAt).toBeTruthy()
  expect(s.store.version("effect-intent", s.id)).toBe(version)
  expect(
    s.store.db.prepare("SELECT data FROM native_records WHERE kind='effect-intent' AND id=?").get(s.id)?.data
  ).toBe(raw)
  expect((await s.apply(await s.plan()))[0]).toBe(true)
})
it.each([
  "archive-attempt",
  "archive-state",
  "admission",
  "active-owner",
  "existing-pr",
  "existing-merge"
])("blocked-owner custody rejects changed %s", async (scenario) => {
  const s = await blockedCustodyFixture(scenario === "active-owner")
  if (scenario.startsWith("archive")) {
    const archive = s.store.get<any>("attempt-evidence", `${s.workflowId}:1`)
    archive.lifecycle = {
      ...archive.lifecycle,
      ...(scenario === "archive-attempt" ? { attempt: 99 } : { state: "blocked" })
    }
    s.store.put("attempt-evidence", `${s.workflowId}:1`, archive)
  }
  if (scenario === "admission")
    s.store.db.prepare("DELETE FROM native_records WHERE kind='admission' AND id=?").run(s.workflowId)
  if (scenario === "existing-pr" || scenario === "existing-merge") {
    const current = s.store.get<any>("workflow", s.workflowId)
    if (scenario === "existing-pr") current.prNumber = 7
    else current.mergedSha = "3".repeat(40)
    s.store.put("workflow", s.workflowId, current)
  }
  expect((await s.holdPlan())[0]).toBe(false)
  expect(s.store.get("effect-custody", s.id)).toBeNull()
})
it.each([
  "pause-revision",
  "original-input",
  "owner-created",
  "transport",
  "process-birth"
])("custody closes %s change during awaited remote proof", async (scenario) => {
  const s = await custodyFixture(),
    p = await s.holdPlan()
  expect(p[0]).toBe(true)
  let changed = false
  const original = s.request.getMockImplementation()!
  s.request.mockImplementation(async (method, params) => {
    const response = await original(method, params)
    if (!changed) {
      changed = true
      if (scenario === "pause-revision") s.get().control.change(true)
      if (scenario === "original-input")
        s.store.put("effect-intent", s.id, { state: "pending", input: { ...s.input, notes: "Concurrent mutation" } })
      if (scenario === "owner-created") s.store.put("workflow", "a".repeat(64), { unexpected: true })
      if (scenario === "transport" || scenario === "process-birth") {
        const identity = vi.mocked(nativeCustodyLocalIdentity)()
        vi.mocked(nativeCustodyLocalIdentity).mockReturnValue({
          ...identity,
          ...(scenario === "transport"
            ? { configSha256: "f".repeat(64) }
            : { processStartTicks: identity.processStartTicks + 1 })
        })
      }
    }
    return response
  })
  expect((await s.holdApply(p[1]))[0]).toBe(false)
  expect(changed).toBe(true)
  expect(s.store.get("effect-custody", s.id)).toBeNull()
})

it.each([
  "raw",
  "manual",
  "normalized",
  "manual-normalized"
])("native create refuses held %s alias before journal preparation or gateway call", async (variant) => {
  const s = await custodyFixture(),
    planned = await s.holdPlan()
  expect((await s.holdApply(planned[1]))[0]).toBe(true)
  const { nativeCardIdempotencyKey } = await import("../packages/core-runtime/src/native/gateway.js")
  const normalized = nativeCardIdempotencyKey(s.input.idempotencyKey)
  const key =
    variant === "raw"
      ? s.input.idempotencyKey
      : variant === "manual"
        ? `manual:${s.input.idempotencyKey}`
        : variant === "normalized"
          ? normalized
          : `manual:${normalized}`
  s.request.mockClear()
  const before = s.store.list("effect-intent")
  await expect(s.get().createCard({ ...s.input, idempotencyKey: key })).rejects.toThrow(/held intent/)
  expect(s.request).not.toHaveBeenCalled()
  expect(s.store.list("effect-intent")).toEqual(before)
})

it.each(["plan-entry", "plan-reason"])("version-one forged audit %s cannot authenticate custody", async (scenario) => {
  const s = await custodyFixture(),
    p = (await s.holdPlan())[1],
    entry = p.entries[0]
  const { digest: _oldDigest, ...body } = p
  const forgedBody = {
    ...body,
    ...(scenario === "plan-entry"
      ? { entries: [{ ...entry, intent: { ...entry.intent, id: "unrelated" } }] }
      : { reason: "Unrelated plan reason" })
  }
  const digest = createHash("sha256").update(JSON.stringify(forgedBody)).digest("hex")
  const forgedPlan = { ...forgedBody, digest }
  const before = s.store.db
    .prepare("SELECT data FROM native_records WHERE kind='effect-intent' AND id=?")
    .get(s.id)?.data
  s.store.commit(
    [
      {
        kind: "effect-custody",
        id: s.id,
        expectedVersion: 0,
        value: {
          state: "unresolved-held-no-replay",
          boardId: "refresh-app",
          entry,
          planDigest: digest,
          operatorId: "reviewed-operator",
          reason: p.reason
        }
      }
    ],
    {
      kind: "effect.custody-held",
      subject: "refresh-app",
      value: {
        plan: forgedPlan,
        entries: [entry],
        planDigest: digest,
        operatorId: "reviewed-operator",
        reason: p.reason
      }
    }
  )
  expect(s.store.version("effect-custody", s.id)).toBe(1)
  expect(nativeEffectCustodyHeld(s.store, s.id)).toBe(false)
  expect((await s.apply(await s.plan()))[0]).toBe(false)
  expect(
    s.store.db.prepare("SELECT data FROM native_records WHERE kind='effect-intent' AND id=?").get(s.id)?.data
  ).toBe(before)
})

it("unrelated native create requires fresh absence of held aliases and never prepares after late matching card", async () => {
  const s = await custodyFixture(),
    p = (await s.holdPlan())[1]
  expect((await s.holdApply(p))[0]).toBe(true)
  const unrelated = { ...s.input, title: "Unrelated authorized task", idempotencyKey: "unrelated-authorized" }
  s.request.mockImplementation(async (method) => {
    if (method === "workboard.cards.list") return { cards: [] } as any
    if (method === "workboard.cards.create")
      return { card: { id: "unrelated", title: unrelated.title, status: "blocked" } } as any
    throw new Error(`Unexpected method ${method}`)
  })
  expect((await s.get().createCard(unrelated)).id).toBe("unrelated")
  s.request.mockImplementation(async (method) => {
    if (method === "workboard.cards.list")
      return {
        cards: [
          {
            id: "late",
            title: s.input.title,
            status: "done",
            metadata: { automation: { idempotencyKey: `manual:${s.input.idempotencyKey}` } }
          }
        ]
      } as any
    throw new Error("Must not create or replay after matching held card appears")
  })
  const original = s.store.list("effect-intent")
  await expect(s.get().createCard({ ...unrelated, idempotencyKey: "new-unrelated" })).rejects.toThrow(
    /matching remote card/
  )
  expect(s.store.list("effect-intent")).toEqual(original)
})

it("custody commit rejects changed pause authority after regenerated plan settles", async () => {
  const s = await custodyFixture(),
    plan = (await s.holdPlan())[1]
  const commit = s.store.commit.bind(s.store)
  const spy = vi.spyOn(s.store, "commit").mockImplementation((...args) => {
    if (args[0].some((write) => write.kind === "effect-custody")) s.get().control.change(true)
    return commit(...args)
  })
  expect((await s.holdApply(plan))[0]).toBe(false)
  expect(s.store.get("effect-custody", s.id)).toBeNull()
  spy.mockRestore()
})
