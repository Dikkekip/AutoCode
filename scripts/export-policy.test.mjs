// New regression: inspect the actual source archive without reading private file contents.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { test } from "node:test"

test("release source archive excludes private operator state and application backups", () => {
  const archive = execFileSync("git", ["archive", "--worktree-attributes", "HEAD"], { maxBuffer: 64 * 1024 * 1024 })
  const paths = execFileSync("tar", ["-tf", "-"], { input: archive, encoding: "utf8" }).trim().split("\n")
  const forbidden =
    /^(?:USER\.md|SOUL\.md|MEMORY\.md|IDENTITY\.md|TOOLS\.md|HEARTBEAT\.md|memory\/|backups\/|reviewer\/|install_tailscale_root\.sh|ip-static-|secure-webhost-hostspecific\.sh|\.local-cleanup\/|\.openclaw\/|\.env)/
  assert.deepEqual(
    paths.filter((path) => forbidden.test(path)),
    []
  )
  assert.ok(paths.includes("package.json"))
  assert.ok(paths.includes("packages/core-runtime/src/native/runtime.ts"))
})
