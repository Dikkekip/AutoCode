#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { closeSync, existsSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

// Host repair for OpenClaw 2026.9.6 Workboard's early agent_end lifecycle event.
// Workboard subagents have a separate subagent_ended hook and session sweep.

const [mode, packageRoot] = process.argv.slice(2)
if (!["--check", "--apply"].includes(mode) || !packageRoot || process.argv.length !== 4)
  throw new Error("Usage: patch-openclaw-workboard-agent-end.mjs --check|--apply <installed-openclaw-root>")
const packageJson = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"))
if (packageJson.version !== "2026.9.6") throw new Error("Installed OpenClaw version is not the reviewed 2026.9.6")
const target = resolve(packageRoot, "dist/extensions/workboard/index.js")
const source = readFileSync(target, "utf8")
const sha256 = (value) => createHash("sha256").update(value).digest("hex")
const originalDigest = "b7fcfa540fff10995a9da51ed172385e4446a5c61a62575c7408a93bff8e90d4"
const before = "async function syncWorkboardAgentEnded(params) {\n\tconst now = params.now ?? Date.now();"
const after =
  "async function syncWorkboardAgentEnded(params) {\n" +
  '\tif (params.context.sessionKey?.includes(":subagent:workboard-")) return 0;\n' +
  "\tconst now = params.now ?? Date.now();"
if (!source.includes('api.on("subagent_ended"')) throw new Error("Separate subagent completion hook is absent")
if (source.includes(after)) {
  console.log(JSON.stringify({ status: "already-applied", target, sha256: sha256(source) }))
  process.exit(0)
}
if (sha256(source) !== originalDigest || source.split(before).length !== 2)
  throw new Error("Installed Workboard bundle differs from the reviewed source; refuse patch")
const patched = source.replace(before, after)
if (mode === "--check") {
  console.log(JSON.stringify({ status: "ready", target, originalDigest, patchedDigest: sha256(patched) }))
  process.exit(0)
}
const backup = `${target}.pre-native-agent-end-20260928`
if (existsSync(backup)) {
  if (sha256(readFileSync(backup)) !== originalDigest)
    throw new Error("Existing Workboard backup differs from the reviewed source; refuse patch")
} else {
  const fd = openSync(backup, "wx", 0o600)
  try {
    writeFileSync(fd, source)
  } finally {
    closeSync(fd)
  }
}
const temporary = `${target}.native-agent-end-tmp.js`
const modeBits = statSync(target).mode & 0o777
const tmpFd = openSync(temporary, "wx", modeBits)
try {
  writeFileSync(tmpFd, patched)
} finally {
  closeSync(tmpFd)
}
const syntax = spawnSync(process.execPath, ["--check", temporary], { encoding: "utf8" })
if (syntax.status !== 0) {
  rmSync(temporary, { force: true })
  throw new Error(`Patched Workboard bundle failed syntax validation: ${syntax.stderr.slice(0, 500)}`)
}
renameSync(temporary, target)
console.log(JSON.stringify({ status: "applied", target, backup, originalDigest, patchedDigest: sha256(patched) }))
