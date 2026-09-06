import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { afterEach, describe, expect, it } from "vitest"
import { NativeControl } from "../packages/core-runtime/src/native/control.js"
import { NativeEvidenceStore } from "../packages/core-runtime/src/native/store.js"
import { executeCommandAsync } from "../packages/os-adapters/src/shell.js"

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn()
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "native-freeze-"))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const store = new NativeEvidenceStore(join(root, "evidence.db"))
  cleanup.push(() => store.close())
  return { root, store, control: new NativeControl(store, () => true) }
}
describe("pause drain and emergency freeze", () => {
  it("drains on pause but aborts owned commands on freeze without clearing evidence", async () => {
    const { store, control } = fixture()
    store.put("operation", "deploy", { state: "started" })
    await control.run(async () => {
      const signal = control.signal!
      control.change(true)
      expect(signal.aborted).toBe(false)
      expect(() => control.assert()).toThrow(/revoked|paused/)
      control.freeze()
      expect(signal.aborted).toBe(true)
      expect(store.get("operation", "deploy")).toEqual({ state: "started" })
    })
  })
  it("observes a remote freeze even when resumed before the polling tick", async () => {
    const { root, control } = fixture()
    const otherStore = new NativeEvidenceStore(join(root, "evidence.db"))
    cleanup.push(() => otherStore.close())
    const other = new NativeControl(otherStore, () => true)
    await control.run(async () => {
      const signal = control.signal!
      other.freeze()
      other.change(false)
      await delay(150)
      expect(signal.aborted).toBe(true)
      expect(() => control.assert()).toThrow(/revoked/)
    })
  })
  it("does not initiate an already-cancelled command", async () => {
    const { root } = fixture()
    const controller = new AbortController()
    controller.abort()
    const result = await executeCommandAsync(
      process.execPath,
      ["-e", `require('node:fs').writeFileSync(${JSON.stringify(join(root, "effect"))},'bad')`],
      { abortSignal: controller.signal }
    )
    expect(result.ok).toBe(false)
    expect(result.error?.name).toBe("AbortError")
    expect(existsSync(join(root, "effect"))).toBe(false)
  })
  it.skipIf(process.platform === "win32")("cancels a running owned process tree", async () => {
    const { root } = fixture()
    const path = join(root, "child.pid")
    const controller = new AbortController()
    const command = executeCommandAsync("/bin/sh", ["-c", 'sleep 60 & echo $! > "$1"; wait', "fixture", path], {
      abortSignal: controller.signal,
      terminateProcessGroup: true,
      timeoutMs: 5000,
      timeoutKillGraceMs: 100
    })
    for (let i = 0; i < 100 && !existsSync(path); i++) await delay(10)
    expect(existsSync(path)).toBe(true)
    const pid = Number(readFileSync(path, "utf8"))
    controller.abort()
    const result = await command
    expect(result.ok).toBe(false)
    expect(result.error?.name).toBe("AbortError")
    let alive = true
    for (let i = 0; i < 100; i++) {
      try {
        process.kill(pid, 0)
      } catch {
        alive = false
        break
      }
      await delay(10)
    }
    expect(alive).toBe(false)
  })
  it("terminates overflowing output with a typed failure", async () => {
    const result = await executeCommandAsync(
      process.execPath,
      ["-e", "while(true) process.stdout.write('x'.repeat(10000))"],
      {
        maxBufferBytes: 1024,
        terminateOnOutputLimit: true,
        terminateProcessGroup: true,
        timeoutMs: 2000,
        timeoutKillGraceMs: 100
      }
    )
    expect(result.ok).toBe(false)
    expect(result.outputTruncated).toBe(true)
    expect(result.error?.name).toBe("OutputLimitError")
  })
})
