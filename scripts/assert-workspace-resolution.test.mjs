import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, test } from "node:test"
import { assertPluginWorkspaceResolution, assertWorkspaceResolution } from "./assert-workspace-resolution.mjs"

const temporary = []
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})
function directory() {
  const path = mkdtempSync(join(tmpdir(), "workspace-bindings-"))
  temporary.push(path)
  return path
}
function manifest(path, name, dependencies = {}) {
  mkdirSync(join(path, "dist"), { recursive: true })
  writeFileSync(
    join(path, "package.json"),
    JSON.stringify({ name, type: "module", exports: "./dist/index.mjs", dependencies })
  )
  writeFileSync(join(path, "dist/index.mjs"), "export const value = true")
}
function fixture() {
  const root = directory(),
    consumer = join(root, "packages/consumer"),
    dependency = join(root, "packages/domain")
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n  - packages/adapters/*\n")
  manifest(consumer, "@test/consumer", { "@test/domain": "workspace:*" })
  manifest(dependency, "@test/domain")
  const link = join(consumer, "node_modules/@test/domain")
  mkdirSync(dirname(link), { recursive: true })
  symlinkSync(dependency, link)
  return { root, consumer, dependency, link }
}
test("accepts checkout-local workspace exports including nested adapter packages", () => {
  const f = fixture()
  manifest(join(f.root, "packages/adapters/local"), "@test/adapter")
  assert.deepEqual(assertWorkspaceResolution(f.root), { workspaces: 3, bindings: 1 })
})
test("rejects a borrowed consumer node_modules graph resolving a foreign package", () => {
  const f = fixture(),
    foreign = directory()
  manifest(foreign, "@test/domain")
  unlinkSync(f.link)
  symlinkSync(foreign, f.link)
  assert.throws(() => assertWorkspaceResolution(f.root), /Foreign workspace dependency/)
})
test("rejects a different package inside the same checkout", () => {
  const f = fixture(),
    shadow = join(f.root, "shadow")
  manifest(shadow, "@test/domain")
  unlinkSync(f.link)
  symlinkSync(shadow, f.link)
  assert.throws(() => assertWorkspaceResolution(f.root), /Foreign workspace dependency/)
})
test("rejects workspace directories and manifests that escape through symlinks", () => {
  const f = fixture(),
    foreign = directory()
  manifest(foreign, "@test/domain")
  rmSync(f.dependency, { recursive: true })
  symlinkSync(foreign, f.dependency)
  assert.throws(() => assertWorkspaceResolution(f.root), /Foreign workspace manifest|Unknown workspace/)
})
test("rejects an unconfigured workspace dependency", () => {
  const f = fixture()
  manifest(f.consumer, "@test/consumer", { "@test/missing": "workspace:*" })
  assert.throws(() => assertWorkspaceResolution(f.root), /Unknown workspace dependency/)
})
test("rejects missing compiled workspace exports", () => {
  const f = fixture()
  unlinkSync(join(f.dependency, "dist/index.mjs"))
  assert.throws(() => assertWorkspaceResolution(f.root), /Cannot find module/)
})

test("does not hide workspace declarations behind a later dependency section", () => {
  const f = fixture(),
    foreign = directory()
  manifest(foreign, "@test/domain")
  writeFileSync(
    join(f.consumer, "package.json"),
    JSON.stringify({
      name: "@test/consumer",
      dependencies: { "@test/domain": "workspace:*" },
      devDependencies: { "@test/domain": "1.0.0" }
    })
  )
  unlinkSync(f.link)
  symlinkSync(foreign, f.link)
  assert.throws(() => assertWorkspaceResolution(f.root), /Foreign workspace dependency/)
})
test("rejects a symlinked workspace manifest even when its directory is local", () => {
  const f = fixture(),
    foreign = directory()
  manifest(foreign, "@test/domain")
  unlinkSync(join(f.dependency, "package.json"))
  symlinkSync(join(foreign, "package.json"), join(f.dependency, "package.json"))
  assert.throws(() => assertWorkspaceResolution(f.root), /Foreign workspace manifest/)
})
test("rejects duplicate workspace identities", () => {
  const f = fixture()
  manifest(join(f.root, "packages/duplicate"), "@test/domain")
  assert.throws(() => assertWorkspaceResolution(f.root), /Unique named workspaces/)
})

test("refuses conditional exports whose import and require ownership could differ", () => {
  const f = fixture()
  writeFileSync(
    join(f.dependency, "package.json"),
    JSON.stringify({ name: "@test/domain", exports: { import: "./foreign.mjs", require: "./dist/index.mjs" } })
  )
  assert.throws(() => assertWorkspaceResolution(f.root), /Unsupported conditional workspace exports/)
})

test("validates the original host source while the runtime executes from a captured copy", () => {
  const f = fixture(),
    capture = directory(),
    source = join(f.root, "plugins/autocode/index.mjs")
  mkdirSync(dirname(source), { recursive: true })
  writeFileSync(source, "// original plugin")
  const runtimeSource = join(capture, "plugin.mjs")
  writeFileSync(runtimeSource, "// captured plugin without workspace manifest")
  assert.deepEqual(assertPluginWorkspaceResolution({ source, runtimeSource }), { workspaces: 2, bindings: 1 })
})
test("requires a trusted absolute original source even when a runtime source exists", () => {
  assert.throws(
    () => assertPluginWorkspaceResolution({ runtimeSource: import.meta.url }),
    /Trusted original plugin source/
  )
  assert.throws(
    () => assertPluginWorkspaceResolution({ source: "plugins/autocode/index.mjs" }),
    /Trusted original plugin source/
  )
})
test("still rejects borrowed source dependencies when a captured runtime path is supplied", () => {
  const f = fixture(),
    foreign = directory(),
    source = join(f.root, "plugins/autocode/index.mjs")
  mkdirSync(dirname(source), { recursive: true })
  writeFileSync(source, "// original plugin")
  manifest(foreign, "@test/domain")
  unlinkSync(f.link)
  symlinkSync(foreign, f.link)
  assert.throws(
    () => assertPluginWorkspaceResolution({ source, runtimeSource: join(f.root, "captured.mjs") }),
    /Foreign workspace dependency/
  )
})

function exportMap(f, change = {}) {
  for (const file of ["index.d.ts", "required-ci.mjs", "required-ci.d.ts"])
    writeFileSync(
      join(f.dependency, "dist", file),
      file.endsWith(".mjs") ? "export const ci = true" : "export declare const ci: boolean"
    )
  const value = {
    name: "@test/domain",
    type: "module",
    types: "./dist/index.d.ts",
    exports: {
      ".": { types: "./dist/index.d.ts", default: "./dist/index.mjs" },
      "./required-ci": { types: "./dist/required-ci.d.ts", default: "./dist/required-ci.mjs" }
    },
    ...change
  }
  writeFileSync(join(f.dependency, "package.json"), JSON.stringify(value))
  return value
}
test("validates explicit public root/subpath targets and actual ESM and require resolution for root consumers", () => {
  const f = fixture()
  exportMap(f)
  writeFileSync(
    join(f.root, "package.json"),
    JSON.stringify({ type: "module", devDependencies: { "@test/domain": "workspace:*" } })
  )
  const link = join(f.root, "node_modules/@test/domain")
  mkdirSync(dirname(link), { recursive: true })
  symlinkSync(f.dependency, link)
  assert.deepEqual(assertWorkspaceResolution(f.root), { workspaces: 2, bindings: 2 })
  for (const cwd of [f.root, f.consumer]) {
    const require = createRequire(join(cwd, "package.json"))
    assert.equal(require.resolve("@test/domain/required-ci"), join(f.dependency, "dist/required-ci.mjs"))
    const result = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "import { value } from '@test/domain'; import { ci } from '@test/domain/required-ci'; console.log(value && ci)"
      ],
      { cwd, encoding: "utf8" }
    )
    assert.equal(result.trim(), "true")
  }
})
for (const [label, exports] of Object.entries({
  conditional: { import: "./dist/index.mjs", require: "./dist/required-ci.mjs" },
  divergent: { ".": { import: "./foreign.mjs", require: "./dist/index.mjs" } },
  pattern: { ".": "./dist/index.mjs", "./*": "./dist/*.mjs" },
  nested: { ".": { types: "./dist/index.d.ts", default: { node: "./dist/index.mjs" } } },
  array: ["./dist/index.mjs"],
  null: null,
  mixed: { ".": "./dist/index.mjs", default: "./dist/index.mjs" },
  missingRoot: { "./required-ci": "./dist/index.mjs" },
  missingRuntime: { ".": { types: "./dist/index.d.ts" } },
  reversed: { ".": { default: "./dist/index.mjs", types: "./dist/index.d.ts" } },
  nullTarget: { ".": null },
  arrayTarget: { ".": ["./dist/index.mjs"] }
}))
  test(`rejects unsupported export grammar: ${label}`, () => {
    const f = fixture()
    exportMap(f, { exports })
    assert.throws(() => assertWorkspaceResolution(f.root), /Unsupported conditional/)
  })
for (const target of [
  "../escape.mjs",
  "node:fs",
  "/tmp/foreign.mjs",
  "./dist/../index.mjs",
  "./dist/*.mjs",
  "./dist/index.mjs?x",
  "./dist/%2e%2e/x",
  "./node_modules/foreign/index.mjs"
])
  test(`rejects unsafe public target ${target}`, () => {
    const f = fixture()
    exportMap(f, { exports: { ".": target } })
    assert.throws(() => assertWorkspaceResolution(f.root), /Unsafe|Escaping/)
  })
for (const target of ["dist/index.mjs", "dist/index.d.ts", "dist/required-ci.mjs", "dist/required-ci.d.ts"]) {
  test(`validates presence of every runtime/declaration target: ${target}`, () => {
    const f = fixture()
    exportMap(f)
    unlinkSync(join(f.dependency, target))
    assert.throws(() => assertWorkspaceResolution(f.root), /Cannot find module or declaration/)
  })
  test(`rejects within-workspace symlink redirection: ${target}`, () => {
    const f = fixture()
    exportMap(f)
    writeFileSync(join(f.dependency, "other"), "export const value = true")
    unlinkSync(join(f.dependency, target))
    symlinkSync(join(f.dependency, "other"), join(f.dependency, target))
    assert.throws(() => assertWorkspaceResolution(f.root), /Symlinked workspace target/)
  })
}
test("validates applicable top-level types independently of export-map declarations", () => {
  const f = fixture()
  exportMap(f, { types: "./dist/missing.d.ts" })
  assert.throws(() => assertWorkspaceResolution(f.root), /Cannot find module or declaration/)
})
test("rejects a root consumer's borrowed dependency graph even when package consumers are healthy", () => {
  const f = fixture(),
    foreign = directory()
  exportMap(f)
  manifest(foreign, "@test/domain")
  writeFileSync(join(f.root, "package.json"), JSON.stringify({ dependencies: { "@test/domain": "workspace:*" } }))
  const link = join(f.root, "node_modules/@test/domain")
  mkdirSync(dirname(link), { recursive: true })
  symlinkSync(foreign, link)
  assert.throws(() => assertWorkspaceResolution(f.root), /Foreign workspace dependency/)
})
