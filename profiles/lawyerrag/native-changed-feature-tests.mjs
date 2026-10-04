#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

/** Select committed UI tests from the host-written exact-head manifest. */
export function selectFeatureTests(manifest, snapshotRoot = "/work") {
  if (
    manifest?.version !== 1 ||
    !/^[a-f0-9]{40,64}$/.test(manifest.headSha ?? "") ||
    !Array.isArray(manifest.changedFiles) ||
    !manifest.changedFiles.length ||
    manifest.changedFiles.some((path) => typeof path !== "string")
  ) throw new Error("Invalid trusted changed-file manifest")
  const selected = new Set()
  for (const path of manifest.changedFiles) {
    if (!/^apps\/reports-ui\/src\/(?:features|components)\//.test(path)) continue
    if (!/^apps\/reports-ui\/src\/(?:features|components)\/[A-Za-z0-9_./-]+$/.test(path) || path.includes(".."))
      throw new Error("Invalid UI candidate path")
    if (/\.test\.tsx?$/.test(path)) selected.add(path)
    else if (/\.tsx?$/.test(path)) {
      const companion = path.replace(/\.tsx?$/, (extension) => `.test${extension}`)
      if (existsSync(resolve(snapshotRoot, companion))) selected.add(companion)
    }
  }
  if (!selected.size) throw new Error("UI candidate has no committed companion test in the protected snapshot")
  return [...selected].sort().map((path) => {
    const file = resolve(snapshotRoot, path)
    if (!lstatSync(file).isFile() || realpathSync(file) !== resolve(realpathSync(snapshotRoot), path))
      throw new Error("Selected UI test is not a regular file inside the protected snapshot")
    return path.slice("apps/reports-ui/".length)
  })
}

function main() {
  const root = "/work/apps/reports-ui"
  const manifest = JSON.parse(readFileSync("/work/.openclaw-verification/changed-files.json", "utf8"))
  const tests = selectFeatureTests(manifest)
  const run = (file, args) => {
    const result = spawnSync(file, args, { cwd: root, stdio: "inherit", env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: "/opt/playwright" } })
    if (result.error) throw result.error
    if (result.status !== 0) process.exit(result.status || 1)
  }
  run("cmp", ["package-lock.json", "/opt/openclaw/reports-ui.package-lock.json"])
  run("/opt/openclaw/checks/setup-ui-dependencies", [])
  process.stdout.write(`Protected candidate UI tests: ${tests.join(", ")}\n`)
  run("/opt/ui-node_modules/.bin/vitest", ["run", ...tests, "--maxWorkers=1"])
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main()
