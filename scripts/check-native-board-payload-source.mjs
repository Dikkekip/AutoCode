// Verify an integrated, clean core candidate; never overlay or mock the call owner.
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
const manifest = JSON.parse(
  readFileSync(resolve(repository, "patches/openclaw/bounded-gateway-response-source.json"), "utf8")
)
const run = (command, args, options = {}) => {
  const result = spawnSync("rtk", ["proxy", command, ...args], { cwd: source, encoding: "utf8", ...options })
  if (result.error || result.status !== 0)
    throw new Error(result.error?.message ?? result.stderr ?? `Failed: ${command}`)
  return result.stdout?.trim()
}
const sourceSha = run("git", ["rev-parse", "HEAD"])
run("git", ["merge-base", "--is-ancestor", manifest.upstreamBaseSha, sourceSha])
if (run("git", ["status", "--porcelain"])) throw new Error("Integrated core candidate must be clean")
for (const [path, binding] of Object.entries(manifest.paths))
  if (hash(readFileSync(resolve(source, path))) !== binding.afterSha256)
    throw new Error(`Integrated source drift: ${path}`)
mkdirSync(output, { recursive: true })
const configFile = resolve(output, "vitest.payload.config.mjs")
writeFileSync(
  configFile,
  `import tsconfigPaths from ${JSON.stringify(resolve(repository, "node_modules/vite-tsconfig-paths/dist/index.js"))};
export default {root:${JSON.stringify(source)},
resolve:{alias:{vitest:${JSON.stringify(resolve(repository, "node_modules/vitest/dist/index.js"))}}},
plugins:[tsconfigPaths({projects:[${JSON.stringify(resolve(source, "tsconfig.json"))}]})],
test:{include:['src/cli/gateway-rpc.response-limit.test.ts'],maxWorkers:1,fileParallelism:false,testTimeout:10000,hookTimeout:20000}};`
)
const startedAt = new Date().toISOString()
run(process.execPath, [resolve(repository, "node_modules/vitest/vitest.mjs"), "run", "--config", configFile], {
  stdio: "inherit",
  timeout: 60000,
  env: {
    ...process.env,
    NODE_OPTIONS: "--max-old-space-size=2048",
    OPENCLAW_VITEST_MAX_WORKERS: "1",
    OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: resolve(output, "vitest-cache")
  }
})
writeFileSync(
  resolve(output, "source-test-receipt.json"),
  JSON.stringify(
    {
      status: "passed",
      sourceSha,
      upstreamBaseSha: manifest.upstreamBaseSha,
      startedAt,
      finishedAt: new Date().toISOString(),
      sourceModified: false,
      scope:
        "Integrated public SDK -> runtime -> actual call owner -> authenticated ephemeral loopback -> real WebSocket. Tiny finite-cap rejection and uncapped completeness; framework suite separately exercises >25MiB default rejection. No build or packaged-capability claim."
    },
    null,
    2
  ) + "\n"
)
