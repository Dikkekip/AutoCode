import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { buildNativeContextPack, readNativeExcerpt } from "../packages/core-runtime/dist/native/context-pack.js"

const frameworkRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
if (args.length && (args.length !== 2 || args[0] !== "--out")) {
  throw new Error("Usage: node scripts/benchmark-context-selection.mjs [--out report.json]")
}
const budgets = { maxFiles: 4, maxBytes: 2048 }
const filler = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`src/a${i}.ts`, "// unrelated module\n"]))
const cases = [
  {
    id: "dependency-and-test",
    files: {
      ...filler,
      "src/z-entry.ts": 'import { value } from "./z-dep.js";\n' + "// entry detail\n".repeat(250),
      "src/z-dep.ts": "export const value = 42;\n",
      "src/z-entry.test.ts": 'import "./z-entry.js";\n'
    },
    seeds: ["src/z-entry.ts"],
    expected: ["src/z-entry.ts", "src/z-dep.ts", "src/z-entry.test.ts"]
  },
  {
    id: "two-hop-imports",
    files: {
      ...filler,
      "src/z-entry.ts": 'export { value } from "./z-middle.js";\n',
      "src/z-middle.ts": 'export { value } from "./z-leaf.js";\n',
      "src/z-leaf.ts": "export const value = 42;\n"
    },
    seeds: ["src/z-entry.ts"],
    expected: ["src/z-entry.ts", "src/z-middle.ts", "src/z-leaf.ts"]
  },
  {
    id: "separate-test-directory",
    files: {
      ...filler,
      "src/z-entry.ts": "export const value = 42;\n",
      "src/tests/z-entry.spec.ts": 'import "../z-entry.js";\n'
    },
    seeds: ["src/z-entry.ts"],
    expected: ["src/z-entry.ts", "src/tests/z-entry.spec.ts"]
  },
  {
    id: "explicit-seeds",
    files: { ...filler, "src/z-one.ts": "// first requested\n", "src/z-two.ts": "// second requested\n" },
    seeds: ["src/z-one.ts", "src/z-two.ts"],
    expected: ["src/z-one.ts", "src/z-two.ts"]
  },
  {
    id: "out-of-scope-import",
    files: { ...filler, "src/z-entry.ts": 'import "../private.js";\n', "private.ts": "// outside assigned scope\n" },
    seeds: ["src/z-entry.ts"],
    expected: ["src/z-entry.ts"]
  }
]

// Reproduce the pre-change packing policy: requested paths, then Git tree order,
// allowing each excerpt to consume the remaining budget (up to 16,000 bytes).
// It uses the same committed-source reader as the candidate, keeping I/O and
// trust boundaries constant while comparing only the selection policy.
async function alphabeticalBaseline(source, seeds) {
  const all = execFileSync("git", ["ls-tree", "-r", "--name-only", "-z", source.revision], {
    cwd: source.root,
    encoding: "utf8"
  })
    .split("\0")
    .filter((path) => path.startsWith("src/"))
  const selected = [...new Set([...seeds, ...all])].slice(0, budgets.maxFiles)
  const excerpts = []
  let remaining = budgets.maxBytes
  for (const path of selected) {
    if (remaining < 1) break
    const excerpt = await readNativeExcerpt(source, path, { maxBytes: Math.min(remaining, 16_000) })
    excerpts.push(excerpt)
    remaining -= Buffer.byteLength(excerpt.content)
  }
  return { excerpts, budget: { usedBytes: budgets.maxBytes - remaining } }
}
function measure(pack, expected) {
  const paths = pack.excerpts.filter((excerpt) => excerpt.content.length > 0).map((excerpt) => excerpt.path)
  const found = expected.filter((path) => paths.includes(path)).length
  return {
    expectedFiles: expected.length,
    relevantFiles: found,
    irrelevantFiles: paths.filter((path) => !expected.includes(path)).length,
    passed: found === expected.length && paths.every((path) => path.startsWith("src/")),
    usedBytes: pack.budget.usedBytes,
    selectedPaths: paths
  }
}
const results = []
for (const scenario of cases) {
  const root = mkdtempSync(join(tmpdir(), "autocode-context-benchmark-"))
  const git = (...command) => execFileSync("git", command, { cwd: root, encoding: "utf8", timeout: 10_000 }).trim()
  try {
    git("init", "-q", "-b", "main")
    git("config", "user.name", "AutoCode fixture")
    git("config", "user.email", "fixture@example.invalid")
    git("config", "commit.gpgsign", "false")
    git("config", "core.hooksPath", "/dev/null")
    for (const [path, text] of Object.entries(scenario.files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), text)
    }
    git("add", ".")
    git("commit", "-qm", "controlled fixture")
    const source = { root, revision: git("rev-parse", "HEAD"), allowedPaths: ["src"] }
    const baseline = measure(await alphabeticalBaseline(source, scenario.seeds), scenario.expected)
    const candidate = measure(await buildNativeContextPack(source, scenario.seeds, budgets), scenario.expected)
    results.push({ id: scenario.id, baseline, candidate })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
const report = {
  version: 1,
  mode: "controlled",
  benchmark: "native-context-selection-v1",
  datasetDigest: createHash("sha256").update(JSON.stringify(cases)).digest("hex"),
  candidateArtifactSha256: createHash("sha256")
    .update(readFileSync(join(frameworkRoot, "packages/core-runtime/dist/native/context-pack.js")))
    .digest("hex"),
  budgets,
  baselinePassed: results.filter((result) => result.baseline.passed).length,
  candidatePassed: results.filter((result) => result.candidate.passed).length,
  regressions: results
    .filter((result) => result.baseline.passed && !result.candidate.passed)
    .map((result) => result.id),
  results,
  limitations: [
    "Synthetic retrieval cases measure relevant excerpt availability, not code correctness or live model effectiveness",
    "Baseline reproduces the previous alphabetical selection policy; this is not a provider benchmark or a skill promotion receipt",
    "No wall-clock, token-cost, or 10x improvement claim follows from this report"
  ]
}
if (args[1]) {
  const path = resolve(args[1])
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(report, null, 2) + "\n")
}
process.stdout.write(JSON.stringify(report, null, 2) + "\n")
if (report.regressions.length || report.candidatePassed !== cases.length) process.exitCode = 1
