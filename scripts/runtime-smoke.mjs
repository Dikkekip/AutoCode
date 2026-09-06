import { spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const dispatcherPath = join(repoRoot, "apps", "dispatcher-cli", "dist", "index.js")
const result = spawnSync(process.execPath, [dispatcherPath, "--help"], {
  cwd: repoRoot,
  encoding: "utf8"
})

if (result.status !== 0 || !result.stdout.includes("Usage: dispatcher")) {
  process.stderr.write(result.stderr || result.stdout || "Dispatcher runtime smoke failed without output.\n")
  process.exit(result.status || 1)
}

process.stdout.write("Dispatcher runtime smoke passed.\n")
