#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const prefix = "apps/reports-ui/src/lib/api/"

export function selectApiTests(manifest, snapshotRoot = "/work") {
  if (
    manifest?.version !== 1 ||
    !/^[a-f0-9]{40,64}$/.test(manifest.headSha ?? "") ||
    !Array.isArray(manifest.changedFiles) ||
    !manifest.changedFiles.length ||
    manifest.changedFiles.some((path) => typeof path !== "string")
  ) throw new Error("Invalid trusted changed-file manifest")
  const selected = new Set()
  for (const path of manifest.changedFiles) {
    if (!path.startsWith(prefix)) continue
    if (!/^apps\/reports-ui\/src\/lib\/api\/[A-Za-z0-9_./-]+$/.test(path) || path.includes(".."))
      throw new Error("Invalid API candidate path")
    if (/\.test\.tsx?$/.test(path)) selected.add(path)
    else if (/\.tsx?$/.test(path)) {
      const companion = path.replace(/\.tsx?$/, (extension) => `.test${extension}`)
      if (existsSync(resolve(snapshotRoot, companion))) selected.add(companion)
    }
  }
  if (!selected.size) throw new Error("API candidate has no committed test in the protected snapshot")
  const apiRoot = realpathSync(resolve(snapshotRoot, prefix))
  return [...selected].sort().map((path) => {
    const file = resolve(snapshotRoot, path)
    if (!lstatSync(file).isFile() || !realpathSync(file).startsWith(`${apiRoot}/`))
      throw new Error("Selected API test is not a regular file inside the protected API snapshot")
    return path.slice("apps/reports-ui/".length)
  })
}

function main() {
  const root = "/work/apps/reports-ui"
  const manifest = JSON.parse(readFileSync("/work/.openclaw-verification/changed-files.json", "utf8"))
  const tests = selectApiTests(manifest)
  const run = (file, args) => {
    const result = spawnSync(file, args, { cwd: root, stdio: "inherit" })
    if (result.error) throw result.error
    if (result.status !== 0) process.exit(result.status || 1)
  }
  run("cmp", ["package-lock.json", "/opt/openclaw/reports-ui.package-lock.json"])
  run("/opt/openclaw/checks/setup-ui-dependencies", [])
  process.stdout.write(`Protected candidate API tests: ${tests.join(", ")}\n`)
  run("/opt/ui-node_modules/.bin/vitest", ["run", ...tests, "--maxWorkers=1"])
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main()
