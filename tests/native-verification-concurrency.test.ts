import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { NativeAutonomyRuntime } from "../packages/core-runtime/src/native/runtime.js"
import { NativeEvidenceStore } from "../packages/core-runtime/src/native/store.js"
import { verifyNativeCandidate } from "../packages/core-runtime/src/native/verification.js"
import { validateNativeAutonomyPolicy } from "../packages/domain/src/native-autonomy.js"

vi.mock("../packages/core-runtime/src/native/verification.js", async (original) => ({
  ...(await original<typeof import("../packages/core-runtime/src/native/verification.js")>()),
  verifyNativeCandidate: vi.fn()
}))
const cleanup: Array<() => void> = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const fn of cleanup.splice(0).reverse()) fn()
})
function fixture(limit?: number) {
  const root = mkdtempSync(join(tmpdir(), "native-verification-capacity-"))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const stores = [
    new NativeEvidenceStore(join(root, "evidence.db")),
    new NativeEvidenceStore(join(root, "evidence.db"))
  ]
  stores.forEach((store) => {
    cleanup.push(() => store.close())
  })
  const policy = validateNativeAutonomyPolicy({
    version: 1,
    baseBranch: "main",
    plannerAgentId: "planner",
    personas: ["legal", "design", "backend"].map((personaId) => ({
      personaId,
      goals: ["Improve"],
      successObservations: ["Observed"],
      allowedPaths: ["src"],
      weight: 1
    })),
    deployment: null,
    enabled: true,
    boardId: "board",
    repository: root,
    repositoryKind: "framework",
    mode: "implement-human-review",
    workerConcurrency: 3,
    ...(limit === undefined ? {} : { verificationConcurrency: limit }),
    coderAgentId: "coder",
    reviewerAgentId: "reviewer",
    verification: [{ argv: ["true"], cwd: ".", timeoutSeconds: 10 }]
  })
  const runtimes = stores.map((store) => {
    const runtime = new NativeAutonomyRuntime(policy, { request: async () => ({ cards: [] }) as any }, store)
    vi.spyOn(runtime.quality, "ensureDesign").mockResolvedValue(true)
    vi.spyOn(runtime, "stage").mockResolvedValue("verify-card")
    return runtime
  })
  for (const id of ["first", "second"])
    stores[0]!.put("workflow", id, {
      proposal: { title: id, allowedPaths: ["src"], acceptance: [], implementationPrompt: "Reviewed task" },
      rootCardId: id,
      implementationCardId: id,
      reviewCardId: "existing-review",
      stageCards: {},
      lifecycle: { version: 1, attempt: 0, attemptId: id, state: "verification", headSha: "a".repeat(40) },
      candidate: { headSha: "a".repeat(40), baseSha: "b".repeat(40), files: ["src/file.ts"] },
      submission: { executionId: id, agentId: "coder", sessionKey: id }
    })
  return { stores, runtimes }
}
it.each([1, undefined])("uses the independent verification ceiling across store connections: %s", async (limit) => {
  const s = fixture(limit)
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const verify = vi.mocked(verifyNativeCandidate)
  verify.mockReset()
  verify.mockImplementation(async (_policy, candidate) => {
    await gate
    return { headSha: candidate.headSha, checks: [{ exitCode: 0 }] } as any
  })
  const first = s.runtimes[0]!.advanceWorkflow("first")
  await vi.waitFor(() => {
    expect(s.stores[0]!.get<any>("workflow", "first").blocker).toBeUndefined()
    expect(verify).toHaveBeenCalledTimes(1)
  })
  expect(await s.runtimes[1]!.withCapacity("release", 1, async () => "independent")).toBe("independent")
  const second = s.runtimes[1]!.advanceWorkflow("second")
  if (limit === 1) {
    expect(await second).toBe(0)
    expect(verify).toHaveBeenCalledTimes(1)
    expect(s.stores[1]!.get<any>("workflow", "second").verification).toBeUndefined()
  } else await vi.waitFor(() => expect(verify).toHaveBeenCalledTimes(2))
  release()
  const advanced = await first
  expect(s.stores[0]!.get<any>("workflow", "first").blocker).toBeUndefined()
  expect(advanced).toBe(1)
  expect(await (limit === 1 ? s.runtimes[1]!.advanceWorkflow("second") : second)).toBe(1)
  expect(verify).toHaveBeenCalledTimes(2)
  expect(s.stores[0]!.acquire("capacity:verification:0", 1000)).not.toBeNull()
})
