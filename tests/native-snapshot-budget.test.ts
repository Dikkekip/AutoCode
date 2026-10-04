import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"

const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }))
vi.mock("node:child_process", () => ({ execFile }))

import { snapshotNativeInputs } from "../packages/core-runtime/src/native/snapshot.js"

const roots: string[] = []
afterEach(() => {
  execFile.mockReset()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it("rejects excessive file counts before starting Git", async () => {
  await expect(
    snapshotNativeInputs(
      "/repo",
      "/snapshot",
      "a".repeat(40),
      Array.from({ length: 10_001 }, (_, i) => `${i}.ts`)
    )
  ).rejects.toThrow(/file count limit/)
  expect(execFile).not.toHaveBeenCalled()
})

it("rejects excessive aggregate bytes before reading blobs or writing selected files", async () => {
  const root = mkdtempSync(join(tmpdir(), "native-snapshot-budget-"))
  roots.push(root)
  const files = Array.from({ length: 5 }, (_, i) => `${i}.ts`)
  const tree = files.map((file) => `100644 blob ${"b".repeat(40)} ${64 * 1024 * 1024}\t${file}\0`).join("")
  execFile.mockImplementation((_command, _args, _options, callback) => {
    queueMicrotask(() => callback(null, Buffer.from(tree)))
    return { stdin: { on: vi.fn(), end: vi.fn() } }
  })
  await expect(snapshotNativeInputs("/repo", root, "a".repeat(40), files)).rejects.toThrow(/total byte limit/)
  expect(execFile).toHaveBeenCalledTimes(1)
  expect(execFile.mock.calls[0]?.[1]?.[0]).toBe("ls-tree")
  for (const file of files) expect(existsSync(join(root, file))).toBe(false)
})
