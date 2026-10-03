import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { NativeEvidenceStore } from "../packages/core-runtime/src/native/store.js"

it("rechecks host authority at evidence writes after awaited work, preserving unrelated calls", async () => {
  const root = mkdtempSync(join(tmpdir(), "native-host-authority-"))
  const store = new NativeEvidenceStore(join(root, "evidence.db"))
  let revoked = false
  const assertCurrent = () => {
    if (revoked) throw new Error("Host invocation revoked")
  }
  try {
    await expect(
      store.withEffectAuthority(assertCurrent, async () => {
        store.put("probe", "before", { accepted: true })
        await Promise.resolve()
        revoked = true
        store.put("probe", "after", { accepted: false })
      })
    ).rejects.toThrow("Host invocation revoked")
    expect(store.get("probe", "before")).toEqual({ accepted: true })
    expect(store.get("probe", "after")).toBeNull()
    store.put("probe", "unrelated", { accepted: true })
    expect(store.get("probe", "unrelated")).toEqual({ accepted: true })
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

it("rejects async descendants after the owning host call closes", async () => {
  const root = mkdtempSync(join(tmpdir(), "native-host-closed-"))
  const store = new NativeEvidenceStore(join(root, "evidence.db"))
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let descendant!: Promise<void>
  try {
    await store.withEffectAuthority(
      () => {},
      async () => {
        descendant = gate.then(() => {
          store.put("probe", "late", {})
        })
      }
    )
    const rejected = expect(descendant).rejects.toThrow("Native host invocation has closed")
    release()
    await rejected
    expect(store.get("probe", "late")).toBeNull()
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})
