import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { zipStoredEntries } from "../apps/dispatcher-cli/src/archive.js"
import { pruneRuntimeBackups } from "../packages/db/src/backup-retention.js"
import { createTempWorkspace } from "./helpers.js"

const cleanups: Array<() => void> = []
afterEach(() => {
  vi.unstubAllEnvs()
  while (cleanups.length) cleanups.pop()?.()
})

describe("durable archive utilities", () => {
  it("produces an independently readable ZIP with preserved UTF-8 evidence", () => {
    const workspace = createTempWorkspace("archive-export")
    cleanups.push(workspace.cleanup)
    const archive = join(workspace.root, "evidence.zip")
    writeFileSync(
      archive,
      zipStoredEntries(
        [
          { name: "evidence/summary.txt", content: "Review: blåbær\n" },
          { name: "empty.txt", content: "" }
        ],
        new Date(2026, 0, 2)
      )
    )
    expect(execFileSync("unzip", ["-p", archive, "evidence/summary.txt"], { encoding: "utf8" })).toBe(
      "Review: blåbær\n"
    )
    expect(execFileSync("unzip", ["-t", archive], { encoding: "utf8" })).toContain("No errors detected")
  })
  it("retains newest matching backup files and leaves unrelated evidence intact", () => {
    const workspace = createTempWorkspace("backup-retention")
    cleanups.push(workspace.cleanup)
    vi.stubEnv("OPENCLAW_RUNTIME_BACKUP_KEEP_COUNT", "2")
    for (let index = 0; index < 4; index++) {
      const file = join(workspace.root, `dispatcher-${index}.db`)
      writeFileSync(file, "backup")
      utimesSync(file, index + 1, index + 1)
    }
    writeFileSync(join(workspace.root, "dispatcher-evidence.json"), "{}")
    mkdirSync(join(workspace.root, "dispatcher-directory.db"))
    pruneRuntimeBackups(workspace.root, "dispatcher-", ".db")
    expect(readdirSync(workspace.root).filter((name) => /^dispatcher-\d/.test(name))).toEqual([
      "dispatcher-2.db",
      "dispatcher-3.db"
    ])
    expect(existsSync(join(workspace.root, "dispatcher-evidence.json"))).toBe(true)
    expect(existsSync(join(workspace.root, "dispatcher-directory.db"))).toBe(true)
    expect(() => pruneRuntimeBackups(join(workspace.root, "absent"), "dispatcher-")).not.toThrow()
  })
})
