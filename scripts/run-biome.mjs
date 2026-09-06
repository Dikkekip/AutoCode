import { execFileSync, spawnSync } from "node:child_process"
import { existsSync } from "node:fs"

const [command, ...rest] = process.argv.slice(2)

if (!command) {
  console.error("Usage: node scripts/run-biome.mjs <check|format> [args...]")
  process.exit(1)
}

const tracked = execFileSync(
  "git",
  ["ls-files", "apps", "packages", "scripts", "tests", ".github", "package.json", "tsconfig*.json", "vitest.config.ts"],
  { encoding: "utf8" }
)
  .split("\n")
  .filter(Boolean)

const extraFiles = ["biome.jsonc", "scripts/run-biome.mjs"].filter((file) => existsSync(file))

const files = [...new Set([...tracked, ...extraFiles])].filter((file) => {
  if (file.startsWith("tests/fixtures/")) return false
  if (file.endsWith(".d.ts") || file.endsWith(".map")) return false
  return /\.(?:jsonc?|[cm]?[jt]s|tsx)$/.test(file)
})

if (files.length === 0) process.exit(0)

let result = spawnSync("corepack", ["pnpm", "exec", "biome", command, ...rest, ...files], {
  stdio: "inherit"
})

if (result.error?.code === "ENOENT") {
  result = spawnSync("pnpm", ["exec", "biome", command, ...rest, ...files], { stdio: "inherit" })
}

if (result.error) {
  console.error(result.error.message)
  process.exit(1)
}

process.exit(result.status ?? 1)
