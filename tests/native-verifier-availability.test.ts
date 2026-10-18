import { beforeEach, expect, it, vi } from "vitest"

const execute = vi.hoisted(() => vi.fn())
vi.mock("node:child_process", () => ({
  execFile: Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: execute })
}))

import { nativeDoctor } from "../packages/core-runtime/src/native/doctor.js"
import {
  assertNativeVerifierImageAvailable,
  NativeVerifierUnavailableError,
  nativeVerificationCommandContext,
  readNativeVerifierDefinition
} from "../packages/core-runtime/src/native/verification-context.js"

const image = `sha256:${"b".repeat(64)}`
const sandbox = { backend: "docker" as const, image, inputFiles: ["src"] }
beforeEach(() => {
  execute.mockReset()
})

it("checks the exact local image identity with bounded output and time, without pulling or running it", async () => {
  execute.mockResolvedValue({ stdout: `${image}\n` })
  await assertNativeVerifierImageAvailable(image)
  expect(execute.mock.calls).toEqual([
    ["docker", ["image", "inspect", "--format", "{{.Id}}", image], { timeout: 5000, maxBuffer: 1024, encoding: "utf8" }]
  ])
})
it.each([
  "moving:latest",
  "sha256:bad",
  "--help"
])("rejects mutable or malformed image %s before Docker", async (value) => {
  await expect(assertNativeVerifierImageAvailable(value)).rejects.toBeInstanceOf(NativeVerifierUnavailableError)
  expect(execute).not.toHaveBeenCalled()
})
it.each([
  "",
  `sha256:${"c".repeat(64)}`,
  `${image}\nprivate extra output`
])("rejects wrong or ambiguous local image identity", async (stdout) => {
  execute.mockResolvedValue({ stdout })
  await expect(assertNativeVerifierImageAvailable(image)).rejects.toThrow("unavailable locally")
})
it.each([
  new Error("private daemon /secret/token"),
  Object.assign(new Error("private stderr"), { killed: true, code: "ETIMEDOUT" })
])("sanitizes daemon failures and timeouts", async (error) => {
  execute.mockImplementation(() => {
    throw error
  })
  await expect(assertNativeVerifierImageAvailable(image)).rejects.toThrow(
    /^Pinned verifier image is unavailable locally;/
  )
})
it("detects image removal after caching exact definition bytes and never falls back to a pull", async () => {
  const source = "#!/bin/sh\nexec npm test\n"
  execute.mockImplementation(async (_bin, args) => ({ stdout: args[0] === "image" ? image : source }))
  expect(await readNativeVerifierDefinition(sandbox, "/opt/openclaw/checks/cache-removal")).toBe(source)
  const run = execute.mock.calls.find(([, args]) => args[0] === "run")!
  expect(run[1]).toContain("--pull=never")
  expect(run[1]).toContain("--read-only")
  expect(run[1]).not.toContain("--volume")
  execute.mockReset().mockImplementation(() => {
    throw new Error("No such image; private transport details")
  })
  await expect(readNativeVerifierDefinition(sandbox, "/opt/openclaw/checks/cache-removal")).rejects.toThrow(
    "unavailable locally"
  )
  expect(execute.mock.calls).toHaveLength(1)
  expect(execute.mock.calls[0]![1][0]).toBe("image")
})
it("keeps unavailable definitions incomplete with fixed diagnostics and no private stderr", async () => {
  execute.mockImplementation(() => {
    throw new Error("private stderr")
  })
  const policy = {
    verificationSandbox: sandbox,
    verification: [
      { argv: ["/opt/openclaw/checks/ui"], cwd: ".", timeoutSeconds: 10, paths: ["src/**"] },
      { argv: ["/opt/openclaw/checks/backend"], cwd: ".", timeoutSeconds: 10, paths: ["backend/**"] }
    ],
    version: 1,
    enabled: true,
    mode: "implement-human-review",
    repositoryKind: "framework",
    repository: "/tmp/verifier-context",
    boardId: "board",
    baseBranch: "main",
    plannerAgentId: "planner",
    coderAgentId: "coder",
    reviewerAgentId: "reviewer",
    deployment: null,
    personas: [
      { personaId: "engineer", goals: ["Improve"], successObservations: ["Observed"], allowedPaths: ["src"], weight: 1 }
    ]
  } as any
  const commands = await nativeVerificationCommandContext(policy, null)
  expect(commands).toHaveLength(2)
  expect(commands.every(({ definition }) => !definition.complete)).toBe(true)
  expect(execute).toHaveBeenCalledTimes(1)
  expect(execute.mock.calls[0]![1][0]).toBe("image")
  expect(commands[0]!.definition).toEqual({
    path: "/opt/openclaw/checks/ui",
    complete: false,
    reason: expect.stringContaining("unavailable locally")
  })
  expect(JSON.stringify(commands)).not.toContain("private")
})
it.each([
  true,
  false
])("Doctor reports exact local verifier availability: %s, without mutating Gateway", async (available) => {
  if (available) execute.mockResolvedValue({ stdout: image })
  else
    execute.mockImplementation(() => {
      throw new Error("private Docker error")
    })
  const calls: string[] = []
  const report = await nativeDoctor(
    { repository: "/tmp", personas: [], verification: [], verificationSandbox: sandbox } as any,
    {
      request: async (method: string) => {
        calls.push(method)
        return {} as any
      }
    },
    { platform: "darwin" }
  )
  const check = report.checks.find((c) => c.name === "verification-toolchain")!
  expect(check.ok).toBe(available)
  expect(check.detail).not.toContain("private")
  if (!available) expect(report.ok).toBe(false)
  expect(
    calls.every((method) => ["config.get", "agents.list", "cron.list", "workboard.boards.list"].includes(method))
  ).toBe(true)
})
