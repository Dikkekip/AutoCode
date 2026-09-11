import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import {
  type NativeAdminAbortCall,
  NativeCliGateway,
  type OwnedInvestigationAbort,
  resolveNativeGatewaySdkPath
} from "../packages/core-runtime/src/native/gateway.js"
import { NativeQualityRuntime } from "../packages/core-runtime/src/native/quality.js"

const owned: OwnedInvestigationAbort = {
  boardId: "board",
  roundId: "round",
  personaId: "ux",
  cardId: "card",
  agentId: "research",
  sessionKey: "agent:research:subagent:owned",
  runId: "run-owned"
}
function fixture() {
  const card = {
    id: owned.cardId,
    title: "Investigate",
    boardId: "board",
    agentId: "research",
    status: "running",
    sessionKey: owned.sessionKey,
    runId: owned.runId,
    updatedAt: 12,
    startedAt: 1,
    execution: { status: "running", sessionKey: owned.sessionKey, runId: owned.runId },
    metadata: {
      automation: {
        boardId: "board",
        idempotencyKey: "round:round:ux",
        launch: { phase: "accepted", acceptedSessionKey: owned.sessionKey, acceptedRunId: owned.runId }
      }
    }
  }
  const session = {
    key: owned.sessionKey,
    agentId: owned.agentId,
    status: "running",
    hasActiveRun: true,
    hasActiveSubagentRun: true,
    activeRunIds: [] as string[],
    endedAt: 2
  }
  const abort = vi.fn<NativeAdminAbortCall>(async () => {
    session.status = "done"
    session.hasActiveRun = false
    session.hasActiveSubagentRun = false
    return { ok: true, status: "aborted", abortedRunId: owned.runId }
  })
  const loader = vi.fn(async () => abort)
  class Gateway extends NativeCliGateway {
    calls: string[] = []
    override async request<T = any>(method: string, _params: Record<string, unknown>): Promise<T> {
      this.calls.push(method)
      if (method === "workboard.cards.list") return { cards: [card] } as T
      if (method === "sessions.list") return { sessions: [session] } as T
      throw new Error("unexpected RPC")
    }
  }
  return { card, session, abort, loader, gateway: new Gateway("/configured/openclaw", loader) }
}
describe("owned investigation administrative abort", () => {
  it("ordinary RPC retains CLI argv and never loads admin transport", async () => {
    const directory = mkdtempSync(join(tmpdir(), "native-ordinary-rpc-"))
    try {
      const command = join(directory, "openclaw")
      writeFileSync(command, `#!${process.execPath}\nconsole.log(JSON.stringify({argv:process.argv.slice(2)}))\n`)
      chmodSync(command, 0o700)
      const loader = vi.fn(async () => {
        throw new Error("must not load")
      })
      const gateway = new NativeCliGateway(command, loader)
      const result = await gateway.request<{ argv: string[] }>("workboard.cards.list", { boardId: "board" })
      expect(result.argv).toEqual([
        "gateway",
        "call",
        "workboard.cards.list",
        "--json",
        "--timeout",
        "30000",
        "--params",
        JSON.stringify({ boardId: "board" })
      ])
      expect(loader).not.toHaveBeenCalled()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it("uses the public transport with only exact run parameters and explicit admin scope", async () => {
    const f = fixture()
    await expect(f.gateway.abortOwnedInvestigation(owned)).resolves.toEqual({ status: "terminal" })
    expect(f.abort).toHaveBeenCalledExactlyOnceWith(
      "sessions.abort",
      { json: true, timeout: "30000" },
      { key: owned.sessionKey, agentId: owned.agentId, runId: owned.runId },
      { scopes: ["operator.admin"], progress: false }
    )
    expect(f.loader).toHaveBeenCalledWith("/configured/openclaw")
  })
  it.each([
    "board",
    "agent",
    "session",
    "run",
    "provenance",
    "launch"
  ])("rejects mismatched %s without loading administrative transport", async (field) => {
    const f = fixture()
    if (field === "board") f.card.metadata.automation.boardId = "foreign"
    if (field === "agent") f.card.agentId = "foreign"
    if (field === "session") f.card.sessionKey = "foreign"
    if (field === "run") f.card.runId = "foreign"
    if (field === "provenance") f.card.metadata.automation.idempotencyKey = "foreign"
    if (field === "launch") f.card.metadata.automation.launch.acceptedRunId = "foreign"
    await expect(f.gateway.abortOwnedInvestigation(owned)).rejects.toThrow(/ownership mismatch/)
    expect(f.loader).not.toHaveBeenCalled()
  })
  it("rechecks replacement during SDK loading", async () => {
    const f = fixture()
    f.loader.mockImplementation(async () => {
      f.card.runId = "replacement"
      return f.abort
    })
    await expect(f.gateway.abortOwnedInvestigation(owned)).rejects.toThrow(/ownership mismatch/)
    expect(f.abort).not.toHaveBeenCalled()
  })
  it("retains unauthorized failure and never reports terminal", async () => {
    const f = fixture()
    f.abort.mockRejectedValue(new Error("unauthorized"))
    await expect(f.gateway.abortOwnedInvestigation(owned)).rejects.toThrow("unauthorized")
    expect(f.session.hasActiveRun).toBe(true)
  })
  it.each(["active IDs", "missing end", "older end"])("rejects contradictory terminal evidence: %s", async (kind) => {
    const f = fixture()
    f.session.status = "done"
    f.session.hasActiveRun = false
    f.session.hasActiveSubagentRun = false
    if (kind === "active IDs") f.session.activeRunIds = ["another-live-run"]
    if (kind === "missing end") f.session.endedAt = Number.NaN
    if (kind === "older end") f.session.endedAt = 0
    f.abort.mockResolvedValue({ ok: true, status: "no-active-run", abortedRunId: null })
    await expect(f.gateway.abortOwnedInvestigation(owned)).resolves.toEqual({ status: "pending" })
  })
  it.each(["unrelated", "missing"])("does not infer terminal from %s session search response", async (kind) => {
    const f = fixture(),
      request = f.gateway.request.bind(f.gateway)
    f.gateway.request = async (method, params) => {
      if (method === "sessions.list") {
        expect(params).toEqual({ search: owned.sessionKey, limit: 10 })
        return {
          sessions:
            kind === "unrelated"
              ? [{ ...f.session, key: "foreign", status: "done", hasActiveRun: false, hasActiveSubagentRun: false }]
              : [],
          hasMore: true
        } as any
      }
      return request(method, params)
    }
    await expect(f.gateway.abortOwnedInvestigation(owned)).resolves.toEqual({ status: "pending" })
  })
  it("requires terminal readback even after acknowledged abort", async () => {
    const f = fixture()
    f.abort.mockResolvedValue({ ok: true, status: "aborted", abortedRunId: owned.runId })
    await expect(f.gateway.abortOwnedInvestigation(owned)).resolves.toEqual({ status: "pending" })
  })
  it("natural completion and repeated terminal calls do not send another abort", async () => {
    const f = fixture()
    await f.gateway.abortOwnedInvestigation(owned)
    f.card.status = "done"
    await expect(f.gateway.abortOwnedInvestigation(owned)).resolves.toEqual({ status: "terminal" })
    expect(f.abort).toHaveBeenCalledTimes(1)
  })
  it("rejects an acknowledgement for a different run", async () => {
    const f = fixture()
    f.abort.mockResolvedValue({ ok: true, status: "aborted", abortedRunId: "foreign" })
    await expect(f.gateway.abortOwnedInvestigation(owned)).rejects.toThrow(/not acknowledged/)
  })
})
function budgetFixture() {
  const f = fixture()
  const entry: any = { ...owned, state: "pending", startedAt: Date.now() - 301000 }
  const store = {
    list: () => [{ id: "round:ux", value: entry }],
    put: (_kind: string, _id: string, value: any) => Object.assign(entry, value),
    event: vi.fn()
  }
  const update = vi.fn()
  const request = f.gateway.request.bind(f.gateway)
  f.gateway.request = async (method, params) => {
    if (method === "workboard.cards.update") {
      update(params)
      f.card.status = "blocked"
      return {} as any
    }
    return request(method, params)
  }
  const runtime = new NativeQualityRuntime({
    policy: { boardId: "board", quality: { sessionSeconds: 300 } },
    gateway: f.gateway,
    store
  } as any)
  return { ...f, entry, update, runtime }
}
describe("budget cancellation evidence", () => {
  it("revokes expired proposal authority but keeps failed cancellation open for retry", async () => {
    const f = budgetFixture()
    f.abort.mockRejectedValueOnce(new Error("unauthorized"))
    await expect(f.runtime.enforceBudgets()).rejects.toThrow("unauthorized")
    expect(f.entry).toMatchObject({ state: "timed_out", cancellation: { status: "failed", error: "unauthorized" } })
    expect(f.entry.closed).not.toBe(true)
    expect(f.update).not.toHaveBeenCalled()
    await f.runtime.enforceBudgets()
    expect(f.entry).toMatchObject({ closed: true, cancellation: { status: "terminal" } })
    expect(f.update).toHaveBeenCalledWith({ id: "card", expectedUpdatedAt: 12, patch: { status: "blocked" } })
  })
  it("does not overwrite natural completion while abort drains", async () => {
    const f = budgetFixture()
    f.abort.mockImplementation(async () => {
      f.card.status = "done"
      f.session.status = "done"
      f.session.hasActiveRun = false
      f.session.hasActiveSubagentRun = false
      return { ok: true, status: "no-active-run", abortedRunId: null }
    })
    await f.runtime.enforceBudgets()
    expect(f.update).not.toHaveBeenCalled()
    expect(f.entry.closed).toBe(true)
  })
  it("does not abort a replacement run or mark it terminal", async () => {
    const f = budgetFixture()
    f.card.runId = "replacement"
    await expect(f.runtime.enforceBudgets()).rejects.toThrow(/ownership mismatch/)
    expect(f.abort).not.toHaveBeenCalled()
    expect(f.update).not.toHaveBeenCalled()
    expect(f.entry.closed).not.toBe(true)
  })
})

describe("public gateway SDK executable resolution", () => {
  it("resolves bare PATH name and absolute symlink to the same public package export", () => {
    const root = mkdtempSync(join(tmpdir(), "native-sdk-path-"))
    try {
      const pkg = join(root, "package"),
        bin = join(root, "bin"),
        shadow = join(root, "shadow")
      mkdirSync(pkg)
      mkdirSync(bin)
      mkdirSync(join(shadow, "openclaw"), { recursive: true })
      writeFileSync(
        join(pkg, "package.json"),
        JSON.stringify({ name: "openclaw", type: "module", exports: { "./plugin-sdk/gateway-runtime": "./sdk.js" } })
      )
      writeFileSync(join(pkg, "sdk.js"), "export function callGatewayFromCli() {}")
      const cli = join(pkg, "openclaw.mjs")
      writeFileSync(cli, "#!/bin/sh\nexit 0\n")
      chmodSync(cli, 0o700)
      const linked = join(bin, "openclaw")
      symlinkSync(cli, linked)
      expect(resolveNativeGatewaySdkPath("openclaw", [shadow, bin].join(":"))).toBe(join(pkg, "sdk.js"))
      expect(resolveNativeGatewaySdkPath(linked)).toBe(join(pkg, "sdk.js"))
      expect(resolveNativeGatewaySdkPath(cli)).toBe(join(pkg, "sdk.js"))
      expect(() => resolveNativeGatewaySdkPath("missing", bin)).toThrow(/executable unavailable/)
      writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "openclaw", type: "module", exports: {} }))
      // A separate installation avoids Node package-resolution cache effects.
      const absent = join(root, "absent")
      mkdirSync(absent)
      writeFileSync(join(absent, "package.json"), JSON.stringify({ name: "openclaw", exports: {} }))
      const absentCli = join(absent, "openclaw")
      writeFileSync(absentCli, "#!/bin/sh\nexit 0\n")
      chmodSync(absentCli, 0o700)
      expect(() => resolveNativeGatewaySdkPath(absentCli)).toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

it("continues independent cancellations before reporting an aggregate failure", async () => {
  const first = budgetFixture(),
    second = budgetFixture()
  second.card.id = "second-card"
  second.card.runId = "second-run"
  second.card.sessionKey = "second-session"
  second.entry.cardId = "second-card"
  second.entry.runId = "second-run"
  second.entry.sessionKey = "second-session"
  const entries = new Map([
    ["first", first.entry],
    ["second", second.entry]
  ])
  const abort = vi.fn(async (input: OwnedInvestigationAbort) => {
    if (input.cardId === first.card.id) throw new Error("unauthorized")
    // Exercise the actual owned transport and terminal readback for the later investigation.
    return second.gateway.abortOwnedInvestigation({
      ...owned,
      cardId: second.card.id,
      runId: second.card.runId,
      sessionKey: second.card.sessionKey
    })
  })
  second.card.execution.runId = second.card.runId
  second.card.execution.sessionKey = second.card.sessionKey
  second.card.metadata.automation.launch.acceptedRunId = second.card.runId
  second.card.metadata.automation.launch.acceptedSessionKey = second.card.sessionKey
  second.session.key = second.card.sessionKey
  second.abort.mockImplementation(async () => {
    second.session.status = "done"
    second.session.hasActiveRun = false
    second.session.hasActiveSubagentRun = false
    return { ok: true, status: "aborted", abortedRunId: second.card.runId }
  })
  const update = vi.fn()
  const runtime = new NativeQualityRuntime({
    policy: { boardId: "board", quality: { sessionSeconds: 300 } },
    store: {
      list: () => Array.from(entries, ([id, value]) => ({ id, value })),
      put: (_kind: string, id: string, value: any) => entries.set(id, value),
      event: vi.fn()
    },
    gateway: {
      abortOwnedInvestigation: abort,
      request: async (method: string, params: any) => {
        if (method === "workboard.cards.list") return { cards: [first.card, second.card] }
        if (method === "workboard.cards.update") {
          update(params)
          second.card.status = "blocked"
          return {}
        }
        throw new Error("unexpected RPC")
      }
    }
  } as any)
  await expect(runtime.enforceBudgets()).rejects.toThrow(AggregateError)
  expect(abort.mock.calls.map(([input]) => input.cardId)).toEqual(["card", "second-card"])
  expect(entries.get("first")).toMatchObject({
    state: "timed_out",
    cancellation: { status: "failed", error: "unauthorized" }
  })
  expect(entries.get("first").closed).not.toBe(true)
  expect(entries.get("second")).toMatchObject({ closed: true, cancellation: { status: "terminal" } })
  expect(second.abort).toHaveBeenCalledTimes(1)
  expect(update).toHaveBeenCalledExactlyOnceWith({
    id: "second-card",
    expectedUpdatedAt: 12,
    patch: { status: "blocked" }
  })
})
