import { tmpdir } from "node:os"
import { join } from "node:path"
import { vi } from "vitest"

// Scheduler tests must not depend on the developer/CI host's current pressure.
// Resource safeguard tests supply their own sampler and still exercise the real guard.
vi.mock("../packages/core-runtime/src/native/resource-pressure.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../packages/core-runtime/src/native/resource-pressure.js")>()
  class DeterministicResourceGuard extends actual.NativeResourceGuard {
    constructor(
      config?: ConstructorParameters<typeof actual.NativeResourceGuard>[0],
      sample = () => ({
        totalBytes: 64 * 1024 ** 3,
        availableBytes: 48 * 1024 ** 3,
        gatewayRssBytes: 256 * 1024 ** 2,
        memoryFullAvg10: 0,
        cpuCount: 8,
        loadAverage1m: 0
      }),
      now = Date.now
    ) {
      super(config, sample, now)
    }
  }
  return { ...actual, NativeResourceGuard: DeterministicResourceGuard }
})

const isolatedCodexRoot = join(tmpdir(), `openclaw-vitest-codex-${process.pid}`)

// Dispatcher tests must be deterministic when the developer host has real
// codex-auth accounts whose quota or quarantine state changes over time.
process.env.OPENCLAW_CODEX_ACCOUNTS_DIR = join(isolatedCodexRoot, "accounts")
process.env.OPENCLAW_CODEX_AUTH_FILE = join(isolatedCodexRoot, "auth.json")
// Existing adapter fixtures emulate the standalone Codex protocol. Native
// OpenClaw transport tests opt in explicitly with per-agent environment.
process.env.OPENCLAW_CODEX_TRANSPORT = "direct"

// Disposable Git repositories must not invoke the developer's signing agent.
// Append a process-only override and preserve any other injected Git settings.
const gitConfigCount = Number(process.env.GIT_CONFIG_COUNT ?? 0)
if (!Number.isSafeInteger(gitConfigCount) || gitConfigCount < 0 || gitConfigCount > 100)
  throw new Error("Invalid test Git configuration count")
process.env[`GIT_CONFIG_KEY_${gitConfigCount}`] = "commit.gpgsign"
process.env[`GIT_CONFIG_VALUE_${gitConfigCount}`] = "false"
process.env.GIT_CONFIG_COUNT = String(gitConfigCount + 1)

// Cooperative ownership fixtures never read or write the operator control directory.
process.env.OPENCLAW_CONTROL_ROOT = join(isolatedCodexRoot, "control")
