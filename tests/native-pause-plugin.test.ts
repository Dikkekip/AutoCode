import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { loadNativePolicy, nativeDoctor } from "../packages/core-runtime/src/native/doctor.js"
import { registerNativeAutonomyPlugin } from "../packages/core-runtime/src/native/plugin.js"
import { NativeEvidenceStore } from "../packages/core-runtime/src/native/store.js"
import { validateNativeAutonomyPolicy } from "../packages/domain/src/native-autonomy.js"

vi.mock("../packages/core-runtime/src/native/doctor.js", () => ({ loadNativePolicy: vi.fn(), nativeDoctor: vi.fn() }))
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn()
  vi.resetAllMocks()
})
async function setup(enabled = true) {
  const repository = mkdtempSync(join(tmpdir(), "native-pause-plugin-"))
  const policy = validateNativeAutonomyPolicy({
    version: 1,
    enabled,
    ...(enabled ? { mode: "implement-human-review" } : {}),
    boardId: "app",
    repository,
    repositoryKind: "application",
    baseBranch: "main",
    plannerAgentId: "planner",
    coderAgentId: "coder",
    reviewerAgentId: "reviewer",
    personas: [
      { personaId: "legal", goals: ["goal"], successObservations: ["outcome"], allowedPaths: ["src"], weight: 1 }
    ],
    verification: [{ argv: ["test"], cwd: "." }],
    deployment: null
  })
  vi.mocked(loadNativePolicy).mockReturnValue(policy)
  vi.mocked(nativeDoctor).mockResolvedValue({ ok: true, checks: [] })
  let service: { start(): Promise<void>; stop(): Promise<void> }
  const methods = new Map<string, { handler: (request: any) => Promise<void>; scope: string }>()
  registerNativeAutonomyPlugin({
    pluginConfig: { projects: ["fixture"], openclawCommand: "/fixture/openclaw" },
    registerService: (value: typeof service) => {
      service = value
    },
    registerGatewayMethod: (name: string, handler: any, options: { scope: string }) =>
      methods.set(name, { handler, scope: options.scope }),
    registerTool: vi.fn(),
    on: vi.fn(),
    logger: { warn: vi.fn() }
  })
  await service!.start()
  const store = new NativeEvidenceStore(join(repository, ".openclaw/native-evidence.db"))
  cleanup.push(async () => {
    await service.stop()
    store.close()
    rmSync(repository, { recursive: true, force: true })
  })
  const call = async (name: string) => {
    expect(methods.get(name)!.scope).toBe("operator.admin")
    const respond = vi.fn()
    await methods.get(name)!.handler({ params: { boardId: "app" }, respond })
    return respond.mock.calls[0]!
  }
  return { call, store }
}
it("audits pause and explicit resume through the admin gateway", async () => {
  const s = await setup()
  expect((await s.call("autocode.pause"))[0]).toBe(true)
  const paused = s.store.get<any>("control", "pause")
  expect(paused.paused).toBe(true)
  expect((await s.call("autocode.resume"))[0]).toBe(true)
  const resumed = s.store.get<any>("control", "pause")
  expect(resumed.paused).toBe(false)
  expect(resumed.revision).not.toBe(paused.revision)
  expect(
    s.store.db
      .prepare("SELECT kind FROM native_events ORDER BY id")
      .all()
      .map((row) => row.kind)
  ).toEqual(["control.paused", "control.resumed"])
})
it("does not undo a newer pause arriving during awaited resume readiness checks", async () => {
  const s = await setup()
  await s.call("autocode.pause")
  vi.mocked(nativeDoctor).mockImplementationOnce(async () => {
    await s.call("autocode.pause")
    return { ok: true, checks: [] }
  })
  const response = await s.call("autocode.resume")
  expect(response[0]).toBe(false)
  expect(response[2].message).toMatch(/Control changed/)
  expect(s.store.get<any>("control", "pause").paused).toBe(true)
  expect(s.store.db.prepare("SELECT * FROM native_events WHERE kind='control.resumed'").all()).toHaveLength(0)
})
it("preserves disabled defaults and failed readiness without granting a revision", async () => {
  const s = await setup(false)
  expect((await s.call("autocode.resume"))[0]).toBe(false)
  expect(s.store.get("control", "pause")).toBeNull()
  expect(nativeDoctor).not.toHaveBeenCalled()
})
it("leaves pause intact when readiness fails", async () => {
  const s = await setup()
  await s.call("autocode.pause")
  const before = s.store.get("control", "pause")
  vi.mocked(nativeDoctor).mockResolvedValueOnce({
    ok: false,
    checks: [{ name: "fixture", ok: false, detail: "unavailable" }]
  })
  expect((await s.call("autocode.resume"))[0]).toBe(false)
  expect(s.store.get("control", "pause")).toEqual(before)
})
