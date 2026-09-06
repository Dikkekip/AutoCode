import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import {
  assertInsideExecutionWorkspace,
  commandExists,
  createUnifiedDiff,
  editTextFile,
  executeCommandAsync,
  executeShell,
  executeShellAsync,
  preferredShell,
  resolvePath,
  stringReplace,
  writeTextFile
} from "./index.js"

describe("@openclaw/os-adapters", () => {
  const originalOpenclawShell = process.env.OPENCLAW_SHELL

  afterEach(() => {
    if (originalOpenclawShell === undefined) delete process.env.OPENCLAW_SHELL
    else process.env.OPENCLAW_SHELL = originalOpenclawShell
  })

  it("creates a unified diff with context", () => {
    const diff = createUnifiedDiff("alpha\nbeta\ngamma", "alpha\nbeta changed\ngamma", {
      oldLabel: "demo.txt",
      newLabel: "demo.txt"
    })

    expect(diff).toContain("--- demo.txt")
    expect(diff).toContain("+++ demo.txt")
    expect(diff).toContain("@@ -1,3 +1,3 @@")
    expect(diff).toContain("-beta")
    expect(diff).toContain("+beta changed")
  })

  it("matches Goose-style edit errors for missing snippets", () => {
    expect(() => stringReplace("one\ntwo\nthree", "missing", "updated")).toThrowError(/No match found/)
  })

  it("writes and edits files with diff metadata", () => {
    const dir = mkdtempSync(join(tmpdir(), "os-adapters-"))
    try {
      const file = join(dir, "demo.txt")
      const created = writeTextFile(file, "hello\nworld", { allowedRoots: [dir] })
      expect(created.created).toBe(true)
      expect(created.diff.unifiedDiff).toContain("+++")

      const edited = editTextFile({ path: file, before: "world", after: "openclaw" }, { allowedRoots: [dir] })
      expect(edited.summary).toContain("Edited")
      expect(readFileSync(file, "utf8")).toContain("openclaw")
      expect(edited.diff.unifiedDiff).toContain("+openclaw")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("enforces allowed roots", () => {
    const dir = mkdtempSync(join(tmpdir(), "os-adapters-access-"))
    try {
      const inside = resolvePath("demo.txt", { cwd: dir, allowedRoots: [dir] })
      expect(inside.startsWith(dir)).toBe(true)
      expect(() => resolvePath("/tmp/outside-demo.txt", { cwd: dir, allowedRoots: [dir] })).toThrowError(
        /Access denied/
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("guards execution workspaces against outside targets", () => {
    const dir = mkdtempSync(join(tmpdir(), "os-adapters-workspace-"))
    try {
      expect(assertInsideExecutionWorkspace(dir, join(dir, "child")).insideRepo).toBe(true)
      expect(() => assertInsideExecutionWorkspace(dir, "/tmp/outside-autocode")).toThrowError(
        /outside repository workspace/
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("executes shell commands", () => {
    const result = executeShell("printf 'hello'")
    expect(result.ok).toBe(true)
    expect(result.interleaved).toContain("hello")
  })

  it("cleans up process-group children when an async wrapper exits", async () => {
    const dir = mkdtempSync(join(tmpdir(), "os-adapters-process-group-"))
    try {
      const markerPath = join(dir, "orphan-marker.txt")
      const scriptPath = join(dir, "wrapper.sh")
      writeFileSync(
        scriptPath,
        [
          "#!/bin/sh",
          `node -e "setTimeout(() => require('fs').writeFileSync(process.argv[1], 'alive'), 250); setInterval(() => {}, 1000)" ${JSON.stringify(markerPath)} &`,
          "printf 'done\\n'",
          "exit 0"
        ].join("\n"),
        { mode: 0o755 }
      )

      const result = await executeCommandAsync(scriptPath, [], {
        terminateProcessGroup: true,
        timeoutKillGraceMs: 50,
        timeoutMs: 1_000
      })
      await new Promise((resolve) => setTimeout(resolve, 500))

      expect(result.ok).toBe(true)
      expect(result.stdout).toContain("done")
      expect(existsSync(markerPath)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("cleans up process-group children for async shell commands", async () => {
    const dir = mkdtempSync(join(tmpdir(), "os-adapters-shell-process-group-"))
    try {
      const markerPath = join(dir, "orphan-marker.txt")
      const result = await executeShellAsync(
        `node -e "setTimeout(() => require('fs').writeFileSync(process.argv[1], 'alive'), 250); setInterval(() => {}, 1000)" ${JSON.stringify(markerPath)} & printf 'done\\n'`,
        {
          terminateProcessGroup: true,
          timeoutKillGraceMs: 50,
          timeoutMs: 1_000
        }
      )
      await new Promise((resolve) => setTimeout(resolve, 500))

      expect(result.ok).toBe(true)
      expect(result.stdout).toContain("done")
      expect(existsSync(markerPath)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("settles and cleans up when an escaped descendant retains stdio", async () => {
    if (!commandExists("setsid")) return

    const dir = mkdtempSync(join(tmpdir(), "os-adapters-escaped-descendant-"))
    try {
      const markerPath = join(dir, "escaped-marker.txt")
      const startedAt = Date.now()
      const result = await executeShellAsync(
        `setsid node -e "setTimeout(() => require('fs').writeFileSync(process.argv[1], 'alive'), 250); setInterval(() => {}, 1000)" ${JSON.stringify(markerPath)} & printf 'done\\n'`,
        {
          cwd: dir,
          preferLoginPath: false,
          terminateProcessGroup: true,
          timeoutKillGraceMs: 50,
          timeoutMs: 2_000
        }
      )
      await new Promise((resolve) => setTimeout(resolve, 500))

      expect(result.ok).toBe(true)
      expect(result.stdout).toContain("done")
      expect(Date.now() - startedAt).toBeLessThan(1_500)
      expect(existsSync(markerPath)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("retains the newest async output when the command buffer overflows", async () => {
    const result = await executeCommandAsync(
      process.execPath,
      [
        "-e",
        "process.stdout.write('HEAD\\n'); process.stdout.write('x'.repeat(4096)); process.stdout.write('\\nTAIL\\n')"
      ],
      { maxBufferBytes: 512, timeoutMs: 1_000 }
    )

    expect(result.ok).toBe(true)
    expect(result.outputTruncated).toBe(true)
    expect(result.truncationReason).toContain("Output exceeded 512 byte buffer")
    expect(result.stdout).toContain("TAIL")
    expect(result.stdout).not.toContain("HEAD")
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(512)
  })

  it("detects commands in PATH", () => {
    expect(commandExists("sh") || commandExists("bash")).toBe(true)
  })

  it("ignores invalid OPENCLAW_SHELL values when probing PATH commands", () => {
    process.env.OPENCLAW_SHELL = "exec"

    expect(preferredShell()).not.toBe("exec")
    expect(commandExists("git")).toBe(true)
  })
})
