import { tmpdir } from "node:os"
import { join } from "node:path"

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
