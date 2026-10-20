// Read-only source overlay: exercise an upstream patch without editing its checkout.

import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const [sourceArg, outputArg] = process.argv.slice(2)
if (!sourceArg || !outputArg)
  throw new Error("Usage: check-native-board-payload-source.mjs CORE_SOURCE PROOF_DIRECTORY")
const source = resolve(sourceArg),
  output = resolve(outputArg)
if (output === source || output.startsWith(`${source}/`)) throw new Error("Proof directory must be outside core source")
const hash = (value) => createHash("sha256").update(value).digest("hex")
const patch = readFileSync(resolve(repository, "patches/openclaw/bounded-gateway-response.patch"), "utf8")
const manifest = JSON.parse(
  readFileSync(resolve(repository, "patches/openclaw/bounded-gateway-response-source.json"), "utf8")
)
const run = (command, args, options = {}) => {
  const result = spawnSync("rtk", ["proxy", command, ...args], { cwd: source, encoding: "utf8", ...options })
  if (result.error || result.status !== 0)
    throw new Error(result.error?.message ?? result.stderr ?? `Failed: ${command}`)
  return result.stdout?.trim()
}
if (run("git", ["rev-parse", "HEAD"]) !== manifest.upstreamBaseSha) throw new Error("Unexpected upstream source SHA")
run("git", ["apply", "--check", resolve(repository, "patches/openclaw/bounded-gateway-response.patch")])
const overlay = {}
for (const section of patch.split(/(?=^--- )/m).filter(Boolean)) {
  const lines = section.trimEnd().split("\n")
  const path = lines[1].slice("+++ b/".length)
  const binding = manifest.paths[path]
  if (!binding) throw new Error(`Unbound patch path ${path}`)
  const original = binding.beforeSha256 ? readFileSync(resolve(source, path), "utf8") : ""
  if (binding.beforeSha256 && hash(original) !== binding.beforeSha256) throw new Error(`Source drift: ${path}`)
  const before = original.split("\n")
  if (before.at(-1) === "") before.pop()
  const after = []
  let cursor = 0,
    index = 2
  while (index < lines.length) {
    const match = lines[index++].match(/^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/)
    if (!match) throw new Error(`Invalid patch hunk: ${path}`)
    const start = Math.max(0, Number(match[1]) - 1)
    after.push(...before.slice(cursor, start))
    cursor = start
    while (index < lines.length && !lines[index].startsWith("@@")) {
      const line = lines[index++]
      if (line[0] === " " || line[0] === "-") {
        if (before[cursor++] !== line.slice(1)) throw new Error(`Patch context mismatch: ${path}`)
      }
      if (line[0] === " " || line[0] === "+") after.push(line.slice(1))
    }
  }
  after.push(...before.slice(cursor))
  const updated = `${after.join("\n")}\n`
  if (hash(updated) !== binding.afterSha256) throw new Error(`Output hash mismatch: ${path}`)
  overlay[resolve(source, path)] = updated
}
mkdirSync(output, { recursive: true })
const testFile = resolve(output, "native-board-payload-source.test.ts")
writeFileSync(
  testFile,
  readFileSync(resolve(repository, "patches/openclaw/bounded-gateway-response.test-source.ts"), "utf8").replaceAll(
    "__CORE__",
    source
  )
)
const configFile = resolve(output, "vitest.payload.config.mjs")
writeFileSync(
  configFile,
  `import tsconfigPaths from ${JSON.stringify(resolve(repository, "node_modules/vite-tsconfig-paths/dist/index.js"))};\nimport {resolve,dirname} from 'node:path';\nconst overlay=${JSON.stringify(overlay)};\nexport default {
  root: ${JSON.stringify(source)},
  resolve: {alias: {vitest: ${JSON.stringify(resolve(repository, "node_modules/vitest/dist/index.js"))}}},
  plugins: [tsconfigPaths({projects: [${JSON.stringify(resolve(source, "tsconfig.json"))}]}), {name: 'read-only-payload-source-overlay', enforce: 'pre',
    resolveId(id, importer) {
      if (importer && id.endsWith('/response-limit.js')) {
        const path=resolve(dirname(importer),id).replace(/\\.js$/,'.ts');
        if (overlay[path]) return path;
      }
    },
    load(id) { return overlay[id]; }
  }],
  test: {include: [${JSON.stringify(testFile)}], maxWorkers: 1, fileParallelism: false, testTimeout: 20000}
};\n`
)
const startedAt = new Date().toISOString()
run(process.execPath, [resolve(repository, "node_modules/vitest/vitest.mjs"), "run", "--config", configFile], {
  stdio: "inherit",
  timeout: 60000
})
writeFileSync(
  resolve(output, "source-test-receipt.json"),
  `${JSON.stringify(
    {
      status: "passed",
      upstreamBaseSha: manifest.upstreamBaseSha,
      patchSha256: hash(patch),
      startedAt,
      finishedAt: new Date().toISOString(),
      sourceModified: false,
      scope:
        "Read-only overlay of hash-bound upstream source: SDK facade/runtime forwarding and actual GatewayClient WebSocket receive boundary. Full core build/API export and authenticated operational integration remain parent gates."
    },
    null,
    2
  )}\n`
)
