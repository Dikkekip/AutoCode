import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, realpathSync } from "node:fs"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { nativeCustodyLocalEvidence } from "../packages/core-runtime/src/native/custody-local-evidence.js"

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }))
vi.mock("node:fs", () => ({ existsSync: vi.fn(), readFileSync: vi.fn(), realpathSync: vi.fn() }))
const argv = process.argv
beforeEach(() => {
  process.argv = [...argv, "gateway"]
  vi.stubEnv("OPENCLAW_SERVICE_KIND", "gateway")
  vi.stubEnv("OPENCLAW_SYSTEMD_UNIT", "fixture.service")
  vi.stubEnv("OPENCLAW_CONFIG_PATH", "/fixture/openclaw.json")
  for (const key of ["OPENCLAW_GATEWAY_URL", "OPENCLAW_PROFILE", "OPENCLAW_HOME", "OPENCLAW_GATEWAY_PORT"])
    vi.stubEnv(key, "")
  vi.spyOn(Date, "now").mockReturnValue(10_000_000)
  vi.spyOn(process, "uptime").mockReturnValue(3600)
  vi.mocked(realpathSync).mockImplementation((path) => String(path))
  vi.mocked(existsSync).mockReturnValue(false)
  vi.mocked(readFileSync).mockImplementation((path) => {
    if (String(path) === "/proc/self/stat") return `100 (node) ${Array(19).fill("0").join(" ")} 100000`
    if (String(path) === "/proc/sys/kernel/random/boot_id") return "b".repeat(32)
    return Buffer.from(JSON.stringify({ gateway: { mode: "local", port: 18789 } }))
  })
  vi.mocked(execFileSync).mockImplementation((command) =>
    command === "getconf"
      ? Buffer.from("100")
      : command === "systemctl"
        ? Buffer.from(`MainPID=${process.pid}\nExecMainStartTimestampMonotonic=1000000\n`)
        : Buffer.from(
            JSON.stringify({
              _PID: "99",
              __REALTIME_TIMESTAMP: "1000200000",
              _BOOT_ID: "b".repeat(32),
              _SYSTEMD_USER_UNIT: "fixture.service",
              _UID: String(process.getuid?.()),
              __MONOTONIC_TIMESTAMP: "1000",
              MESSAGE:
                "workboard.cards.create errorCode=workboard_error workspace path is outside caller allowed workspaces"
            }) + "\n"
          )
  )
})
afterEach(() => {
  process.argv = argv
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})
it("derives local rejection and ended process from server observations, without caller assertions", () => {
  const value = nativeCustodyLocalEvidence(1_000_000)
  expect(value.oldPid).toBe(99)
  expect(value.currentPid).toBe(process.pid)
  expect(value.uncertainty).toContain("not external outcome confirmation")
  expect(execFileSync).toHaveBeenCalledWith(
    "journalctl",
    expect.arrayContaining(["--user", "fixture.service"]),
    expect.objectContaining({ timeout: 10000, maxBuffer: 1048576 })
  )
})
it.each([
  "url",
  "remote",
  "ambiguous",
  "missing",
  "live-old-process",
  "same-process",
  "symlink-config",
  "wrong-port",
  "alternate-profile",
  "outside-gateway",
  "wrong-service-pid",
  "journal-after-service-start"
])("refuses %s", (scenario) => {
  let prepared = 1_000_000
  if (scenario === "url") vi.stubEnv("OPENCLAW_GATEWAY_URL", "wss://fixture.invalid")
  if (scenario === "remote")
    vi.mocked(readFileSync).mockReturnValue(Buffer.from(JSON.stringify({ gateway: { mode: "remote" } })))
  if (scenario === "ambiguous") {
    vi.mocked(execFileSync).mockImplementation((command) =>
      command === "getconf"
        ? Buffer.from("100")
        : command === "systemctl"
          ? Buffer.from(`MainPID=${process.pid}\nExecMainStartTimestampMonotonic=1000000\n`)
          : Buffer.from(
              Array(2)
                .fill(
                  JSON.stringify({
                    _PID: "99",
                    __REALTIME_TIMESTAMP: "1000200000",
                    _BOOT_ID: "b".repeat(32),
                    _SYSTEMD_USER_UNIT: "fixture.service",
                    _UID: String(process.getuid?.()),
                    __MONOTONIC_TIMESTAMP: "1000",
                    MESSAGE: "workboard.cards.create errorCode=workboard_error workspace path is outside"
                  })
                )
                .join("\n")
            )
    )
  }
  if (scenario === "missing")
    vi.mocked(execFileSync).mockImplementation((command) =>
      command === "getconf"
        ? Buffer.from("100")
        : command === "systemctl"
          ? Buffer.from(`MainPID=${process.pid}\nExecMainStartTimestampMonotonic=1000000\n`)
          : Buffer.from("")
    )
  if (scenario === "live-old-process") vi.mocked(existsSync).mockReturnValue(true)
  if (scenario === "same-process") prepared = 10_000_001
  if (scenario === "symlink-config") vi.mocked(realpathSync).mockReturnValue("/elsewhere/config.json")
  if (scenario === "wrong-port") vi.stubEnv("OPENCLAW_GATEWAY_PORT", "9999")
  if (scenario === "alternate-profile") vi.stubEnv("OPENCLAW_PROFILE", "other")
  if (scenario === "outside-gateway") vi.stubEnv("OPENCLAW_SERVICE_KIND", "worker")
  if (scenario === "wrong-service-pid") {
    const original = vi.mocked(execFileSync).getMockImplementation()!
    vi.mocked(execFileSync).mockImplementation((command, ...args) =>
      command === "systemctl"
        ? Buffer.from("MainPID=999999\nExecMainStartTimestampMonotonic=1000000\n")
        : original(command, ...args)
    )
  }
  if (scenario === "journal-after-service-start") {
    const original = vi.mocked(execFileSync).getMockImplementation()!
    vi.mocked(execFileSync).mockImplementation((command, ...args) =>
      command === "journalctl"
        ? Buffer.from(String(original(command, ...args)).replace('"1000"', '"1000001"'))
        : original(command, ...args)
    )
  }
  expect(() => nativeCustodyLocalEvidence(prepared)).toThrow()
})
