import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { nativeDoctor } from "../packages/core-runtime/src/native/doctor.js"
import { NativeCliGateway } from "../packages/core-runtime/src/native/gateway.js"
import { registerNativeAutonomyPlugin } from "../packages/core-runtime/src/native/plugin.js"
import { NativeAutonomyRuntime } from "../packages/core-runtime/src/native/runtime.js"
import { NativeEvidenceStore } from "../packages/core-runtime/src/native/store.js"

vi.mock("../packages/core-runtime/src/native/doctor.js", async (original) => ({
  ...(await original<typeof import("../packages/core-runtime/src/native/doctor.js")>()),
  nativeDoctor: vi.fn()
}))
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  vi.restoreAllMocks()
  vi.mocked(nativeDoctor).mockReset()
})
function setup(root = mkdtempSync(join(tmpdir(), "native-startup-"))) {
  const path = join(root, "policy.json")
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      enabled: true,
      boardId: "app",
      repository: root,
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
  let service: any
  const methods = new Map<string, any>(),
    factories: any[] = []
  registerNativeAutonomyPlugin({
    pluginConfig: { projects: [path], openclawCommand: "/usr/bin/openclaw" },
    registerService: (s: any) => {
      service = s
    },
    registerGatewayMethod: (name: string, handler: any) => methods.set(name, handler),
    registerTool: (factory: any) => factories.push(factory),
    on: () => {},
    logger: { warn: vi.fn() }
  })
  cleanups.push(async () => {
    await service.stop()
    rmSync(root, { recursive: true, force: true })
  })
  return {
    root,
    methods,
    service,
    factories,
    call: async (name: string) => {
      let response: any
      await methods.get(name)({
        params: { boardId: "app" },
        respond: (...args: any[]) => {
          response = args
        }
      })
      return response
    }
  }
}
function report(ok: boolean) {
  return {
    ok,
    enabled: true,
    boardId: "app",
    checks: [{ name: "workboard", ok, detail: ok ? "ready" : "unavailable" }]
  }
}
it("returns from service startup before requesting the Gateway it is starting", async () => {
  const s = setup()
  let resolve!: (value: ReturnType<typeof report>) => void
  vi.mocked(nativeDoctor).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done
      })
  )
  const result = await Promise.race([
    s.service.start().then(() => "started"),
    new Promise((done) => setImmediate(() => done("blocked")))
  ])
  expect(result).toBe("started")
  expect(nativeDoctor).not.toHaveBeenCalled()
  const discover = vi.spyOn(NativeAutonomyRuntime.prototype, "discover").mockResolvedValue({ created: [] })
  const call = s.call("autocode.discover")
  expect(discover).not.toHaveBeenCalled()
  resolve(report(true))
  expect((await call)[0]).toBe(true)
  expect(discover).toHaveBeenCalledOnce()
})
it("blocks execution when readiness fails and retries readiness on a later request", async () => {
  const s = setup()
  await s.service.start()
  const discover = vi.spyOn(NativeAutonomyRuntime.prototype, "discover").mockResolvedValue({ created: [] })
  vi.mocked(nativeDoctor).mockResolvedValueOnce(report(false)).mockResolvedValueOnce(report(true))
  expect((await s.call("autocode.discover"))[0]).toBe(false)
  expect(discover).not.toHaveBeenCalled()
  expect((await s.call("autocode.discover"))[0]).toBe(true)
  expect(discover).toHaveBeenCalledOnce()
})
it("gates agent tools as well as administrative RPCs", async () => {
  const s = setup()
  await s.service.start()
  vi.mocked(nativeDoctor).mockResolvedValue(report(false))
  const tool = s.factories[0]({ agentId: "research", sessionKey: "session" }).find(
    (t: any) => t.name === "autocode_proposals"
  )
  await expect(tool.execute("call", { boardId: "app", roundId: "round" })).rejects.toThrow(/activation blocked/)
})

it("uses trusted local factory authority, allows confined sessions and refuses RPC impersonation", async () => {
  const server = setup()
  await server.service.start()
  const client = setup(server.root)
  vi.mocked(nativeDoctor).mockResolvedValue(report(true))
  vi.spyOn(NativeCliGateway.prototype, "request").mockImplementation(async (method, params) => {
    if (method === "workboard.cards.list")
      return {
        cards: [
          {
            id: "card",
            title: "Investigation",
            agentId: "research",
            status: "running",
            sessionKey: "assigned-session"
          }
        ]
      } as any
    expect(method).toBe("autocode.tool")
    return await new Promise((resolve, reject) => {
      server.methods.get(method)({
        params,
        respond: (ok: boolean, value: any, error: any) => {
          if (ok) resolve(value)
          else reject(new Error(error.message))
        }
      })
    })
  })
  const store = new NativeEvidenceStore(join(server.root, ".openclaw/native-evidence.db"))
  try {
    store.put("card-context", "context", {
      notes: "Complete investigation context",
      agentId: "research",
      cardId: "card"
    })
    expect(store.acquire("active-work", 60_000)).not.toBeNull()
    const tool = (agentId: string, sessionKey: string, sandboxed = false) =>
      server.factories[0]({ agentId, sessionKey, sandboxed }).find((t: any) => t.name === "autocode_context")
    const args = { boardId: "app", contextId: "context" }
    const result = await tool("research", "assigned-session").execute("call", args)
    expect(result.details.notes).toBe("Complete investigation context")
    expect(store.acquire("active-work", 60_000)).toBeNull()
    await expect(tool("research", "unassigned-session").execute("call", args)).rejects.toThrow(/session/)
    await expect(tool("other-agent", "assigned-session").execute("call", args)).rejects.toThrow(/assigned/)
    expect((await tool("research", "assigned-session", true).execute("call", args)).details.notes).toBe(
      "Complete investigation context"
    )
    const duplicate = client.factories[0]({ agentId: "research", sessionKey: "assigned-session" }).find(
      (t: any) => t.name === "autocode_context"
    )
    expect((await duplicate.execute("call", args)).details.notes).toBe("Complete investigation context")
    const unassigned = client.factories[0]({ agentId: "research", sessionKey: "unassigned-session" }).find(
      (t: any) => t.name === "autocode_context"
    )
    await expect(unassigned.execute("call", args)).rejects.toThrow(/session/)
    const respond = vi.fn()
    await server.methods.get("autocode.tool")({
      params: {
        name: "autocode_context",
        arguments: args,
        context: { agentId: "research", sessionKey: "assigned-session" }
      },
      respond
    })
    expect(respond.mock.calls[0][0]).toBe(false)
    expect(respond.mock.calls[0][2].message).toMatch(/trusted local plugin factory/)
    await server.service.stop()
    await expect(duplicate.execute("call", args)).rejects.toThrow(/remote tool broker unavailable/)
  } finally {
    store.close()
  }
})

it("binds skill bootstrap to an authenticated administrator and exact reviewed digests", async () => {
  const s = setup()
  const path = join(s.root, "policy.json"),
    skillPath = join(s.root, "SKILL.md")
  writeFileSync(skillPath, "Use bounded source evidence and independent review.")
  const policy = JSON.parse(readFileSync(path, "utf8"))
  policy.quality = { skillPath }
  writeFileSync(path, JSON.stringify(policy))
  await s.service.start()
  await s.call("autocode.pause")
  const { loadNativePolicy } = await import("../packages/core-runtime/src/native/doctor.js")
  const { nativeSkillPolicyDigest } = await import("../packages/core-runtime/src/native/skills.js")
  const { nativeGovernanceDigest } = await import("../packages/core-runtime/src/native/governance.js")
  const params = {
    boardId: "app",
    digest: nativeGovernanceDigest(readFileSync(skillPath, "utf8")),
    policyDigest: nativeSkillPolicyDigest(loadNativePolicy(path)),
    reason: "Reviewed initial bounded evidence skill"
  }
  const invoke = async (client: unknown, overrides = {}) => {
    let response: any
    await s.methods.get("autocode.skill.bootstrap")({
      params: { ...params, ...overrides },
      client,
      respond: (...args: any[]) => {
        response = args
      }
    })
    return response
  }
  expect((await invoke(undefined))[0]).toBe(false)
  const client = { connect: { client: { id: "operator-cli" }, scopes: ["operator.admin"] } }
  expect((await invoke(client, { digest: "incorrect" }))[0]).toBe(false)
  expect((await invoke(client))[0]).toBe(true)
  expect((await invoke(client))[0]).toBe(false)
})
