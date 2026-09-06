// Separate-process SQLite lease regression; requires the normal typecheck/build prerequisite.
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { expect, it } from "vitest"
import { NativeEvidenceStore } from "../packages/core-runtime/src/native/store.js"

it("preserves live ownership across another process startup and fences the next owner", () => {
  const root = mkdtempSync(join(tmpdir(), "native-process-lease-")),
    path = join(root, "evidence.db"),
    store = new NativeEvidenceStore(path)
  try {
    const lease = store.acquire("process-shared", 30000)!
    const module = pathToFileURL(join(process.cwd(), "packages/core-runtime/dist/native/store.js")).href
    const code = `const {NativeEvidenceStore}=await import(${JSON.stringify(module)});const store=new NativeEvidenceStore(process.argv[1]);const lease=store.acquire('process-shared',30000);process.stdout.write(JSON.stringify(lease));store.close()`
    const child = () =>
      JSON.parse(
        execFileSync(process.execPath, ["--input-type=module", "-e", code, path], { encoding: "utf8", timeout: 10000 })
      )
    expect(child()).toBeNull()
    store.release(lease)
    const successor = child()
    expect(successor.token).toBeGreaterThan(lease.token)
    expect(store.acquire("process-shared", 30000)).toBeNull()
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})
