#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"

const root = "/work/apps/reports-ui"
const manifest = JSON.parse(readFileSync("/work/.openclaw-verification/changed-files.json", "utf8"))
if (
  manifest.version !== 1 ||
  !/^[a-f0-9]{40,64}$/.test(manifest.headSha) ||
  !Array.isArray(manifest.changedFiles) ||
  !manifest.changedFiles.length ||
  manifest.changedFiles.some((path) => typeof path !== "string")
) throw new Error("Invalid trusted changed-file manifest")

const selected = new Set()
for (const path of manifest.changedFiles) {
  if (!/^apps\/reports-ui\/src\/features\/[A-Za-z0-9_./-]+$/.test(path) || path.includes(".."))
    continue
  if (/\.test\.tsx?$/.test(path)) selected.add(path)
  else if (/\.tsx?$/.test(path)) {
    const companion = path.replace(/\.tsx?$/, (extension) => `.test${extension}`)
    if (existsSync(resolve("/work", companion))) selected.add(companion)
  }
}
const tests = [...selected].sort().map((path) => {
  const file = resolve("/work", path)
  if (!file.startsWith(`${root}/`) || !statSync(file).isFile())
    throw new Error(`Selected test is missing from the protected snapshot: ${path}`)
  return path.slice("apps/reports-ui/".length)
})
if (!tests.length) throw new Error("Feature candidate has no committed companion test in the protected snapshot")

const run = (file, args) => {
  const result = spawnSync(file, args, { cwd: root, stdio: "inherit" })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status || 1)
}
run("cmp", ["package-lock.json", "/opt/openclaw/reports-ui.package-lock.json"])
run("/opt/openclaw/checks/setup-ui-dependencies", [])
process.stdout.write(`Protected candidate tests: ${tests.join(", ")}\n`)
run("/opt/ui-node_modules/.bin/vitest", ["run", ...tests, "--maxWorkers=1"])
