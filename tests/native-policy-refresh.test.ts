import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { nativeDoctor } from "../packages/core-runtime/src/native/doctor.js"
import { NativeCliGateway } from "../packages/core-runtime/src/native/gateway.js"
import { registerNativeAutonomyPlugin } from "../packages/core-runtime/src/native/plugin.js"
import { nativeLoadedPolicyDigest } from "../packages/core-runtime/src/native/policy-refresh.js"
import type { NativeAutonomyRuntime } from "../packages/core-runtime/src/native/runtime.js"
import { withNativeRuntimeCall } from "../packages/core-runtime/src/native/runtime-lifetime.js"

vi.mock("../packages/core-runtime/src/native/doctor.js", async (original) => ({
  ...(await original<typeof import("../packages/core-runtime/src/native/doctor.js")>()),
  nativeDoctor: vi.fn()
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
  const request = vi.spyOn(NativeCliGateway.prototype, "request").mockImplementation(async (method) => {
    if (method === "workboard.cards.list") return { cards: [] } as any
    if (method === "sessions.list") return { sessions: [], totalCount: 0, hasMore: false, nextOffset: null } as any
    throw new Error("Unexpected gateway method " + method)
  })
  const get = () =>
    (globalThis as any)[Symbol.for("autocode.native.service-runtimes.v1")].get("refresh-app") as NativeAutonomyRuntime
  const call = async (method: string, params: any = {}, client: any = admin) => {
    let response: any
    await methods.get(method)({
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
  s.request.mockResolvedValue({ accepted: true })
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
  expect(s.request).toHaveBeenLastCalledWith("autocode.policy.refresh.apply", {
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
