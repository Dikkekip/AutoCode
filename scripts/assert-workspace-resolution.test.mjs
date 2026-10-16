import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, test } from "node:test"
import { assertWorkspaceResolution } from "./assert-workspace-resolution.mjs"

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
