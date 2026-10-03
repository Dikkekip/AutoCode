import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, test } from "node:test"
import { selectApiTests } from "../profiles/lawyerrag/native-changed-api-tests.mjs"

const roots = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const prefix = "apps/reports-ui/src/lib/api/"
function setup() {
  const root = mkdtempSync(join(tmpdir(), "native-api-selector-"))
  roots.push(root)
  const write = (path) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), "// committed fixture\n")
  }
  write(prefix + "client.test.ts")
  return { root, write }
}
const manifest = (paths) => ({ version: 1, headSha: "a".repeat(40), changedFiles: paths })

test("selects the changed API regression and deduplicates its source companion", () => {
  const { root } = setup()
  assert.deepEqual(selectApiTests(manifest([prefix + "client.ts", prefix + "client.test.ts"]), root), [
    "src/lib/api/client.test.ts"
  ])
})
test("selects an existing companion when only API source changes", () => {
  const { root } = setup()
  assert.deepEqual(selectApiTests(manifest([prefix + "client.ts"]), root), ["src/lib/api/client.test.ts"])
})
test("selects nested API tests in deterministic order without selecting feature tests", () => {
  const { root, write } = setup()
  write(prefix + "nested/a.test.tsx")
  assert.deepEqual(
    selectApiTests(
      manifest([
        prefix + "nested/a.test.tsx",
        "apps/reports-ui/src/features/unselected.test.tsx",
        prefix + "client.test.ts"
      ]),
      root
    ),
    ["src/lib/api/client.test.ts", "src/lib/api/nested/a.test.tsx"]
  )
})
for (const value of [
  null,
  { version: 2 },
  manifest([]),
  { ...manifest([prefix + "client.test.ts"]), headSha: "not-a-head" },
  manifest([42])
]) {
  test("rejects malformed or unbound changed-file manifests", () =>
    assert.throws(() => selectApiTests(value), /Invalid trusted/))
}
test("rejects traversal and command-like paths in the API scope", () => {
  const { root } = setup()
  for (const path of [
    prefix + "../../secret.test.ts",
    prefix + "client.test.ts;echo injected",
    prefix + "client.test.ts\n"
  ]) {
    assert.throws(() => selectApiTests(manifest([path]), root), /Invalid API candidate path/)
  }
})
test("fails closed when no API test is selected or a changed test is missing", () => {
  const { root } = setup()
  assert.throws(
    () => selectApiTests(manifest(["apps/reports-ui/src/features/other.test.ts"]), root),
    /no committed test/
  )
  assert.throws(() => selectApiTests(manifest([prefix + "missing.test.ts"]), root), /ENOENT/)
})
test("rejects a symlink test and a directory symlink escaping the API root", () => {
  const { root, write } = setup()
  write("elsewhere/outside.test.ts")
  symlinkSync(join(root, "elsewhere/outside.test.ts"), join(root, prefix + "link.test.ts"))
  assert.throws(() => selectApiTests(manifest([prefix + "link.test.ts"]), root), /regular file inside/)
  symlinkSync(join(root, "elsewhere"), join(root, prefix + "nested"))
  assert.throws(() => selectApiTests(manifest([prefix + "nested/outside.test.ts"]), root), /regular file inside/)
})
test("rejects replacement of the entire API root with a symlink", () => {
  const { root, write } = setup()
  write("outside-api/client.test.ts")
  rmSync(join(root, prefix), { recursive: true })
  symlinkSync(join(root, "outside-api"), join(root, prefix.slice(0, -1)))
  assert.throws(() => selectApiTests(manifest([prefix + "client.test.ts"]), root), /API root/)
})
