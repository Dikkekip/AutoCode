import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, test } from "node:test"
import { selectFeatureTests } from "../profiles/lawyerrag/native-changed-feature-tests.mjs"

const roots = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function setup() {
  const root = mkdtempSync(join(tmpdir(), "native-ui-selector-"))
  roots.push(root)
  const write = (path) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), "// committed fixture\n")
  }
  return { root, write }
}
const prefix = "apps/reports-ui/src/"
const manifest = (paths) => ({ version: 1, headSha: "a".repeat(40), changedFiles: paths })

test("selects PDF component regressions alongside feature tests and source companions", () => {
  const { root, write } = setup()
  const pdf = prefix + "components/pdf/Handoff.test.tsx"
  const thread = prefix + "features/whatsapp/Thread.test.tsx"
  write(pdf)
  write(thread)
  assert.deepEqual(selectFeatureTests(manifest([thread, pdf, pdf.replace(".test", "")]), root), [
    "src/components/pdf/Handoff.test.tsx",
    "src/features/whatsapp/Thread.test.tsx"
  ])
})

test("fails closed on absent tests, unbound manifests and unsafe paths", () => {
  const { root } = setup()
  assert.throws(() => selectFeatureTests(manifest([prefix + "features/View.tsx"]), root), /no committed/)
  assert.throws(() => selectFeatureTests(manifest([prefix + "components/Missing.test.ts"]), root), /ENOENT/)
  assert.throws(() => selectFeatureTests({ ...manifest([]), headSha: "HEAD" }, root), /Invalid trusted/)
  for (const suffix of ["../private.test.ts", "bad.test.ts;echo x", "bad.test.ts\n"])
    assert.throws(() => selectFeatureTests(manifest([prefix + "components/" + suffix]), root), /Invalid UI/)
})

test("rejects test and ancestor symlinks even when targets are inside the snapshot", () => {
  const { root, write } = setup()
  write(prefix + "components/View.test.tsx")
  write("outside/Private.test.tsx")
  symlinkSync(join(root, "outside/Private.test.tsx"), join(root, prefix + "components/Link.test.tsx"))
  assert.throws(() => selectFeatureTests(manifest([prefix + "components/Link.test.tsx"]), root), /regular file/)
  symlinkSync(join(root, "outside"), join(root, prefix + "components/nested"))
  assert.throws(
    () => selectFeatureTests(manifest([prefix + "components/nested/Private.test.tsx"]), root),
    /regular file/
  )
})
