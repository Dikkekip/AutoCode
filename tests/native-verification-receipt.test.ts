import { execFileSync } from "node:child_process"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import * as snapshot from "../packages/core-runtime/src/native/snapshot.js"
import { runNativeCommand } from "../packages/core-runtime/src/native/verification.js"
import * as osAdapters from "../packages/os-adapters/src/index.js"

const roots: string[] = []
function temp() {
  const root = mkdtempSync(join(tmpdir(), "native-receipt-test-"))
  roots.push(root)
  return root
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const command = { argv: ["/usr/bin/true"], cwd: ".", timeoutSeconds: 5 }
const sandbox = { backend: "docker" as const, image: `sha256:${"a".repeat(64)}`, inputFiles: ["source.txt"] }
function repository() {
  const root = temp()
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" })
  git("init")
  git("config", "user.name", "Receipt Test")
  git("config", "user.email", "receipt@example.invalid")
  git("config", "commit.gpgsign", "false")
  writeFileSync(join(root, "source.txt"), "committed input")
  git("add", "source.txt")
  git("commit", "-m", "fixture")
  return root
}

it.each([
  "file",
  "directory",
  "symlink",
  "dangling symlink"
])("rejects an existing %s receipt before Git, snapshots, or execution", async (kind) => {
  // Deliberately not a Git repository: reaching input preparation would fail
  // for a different reason instead of reporting the existing receipt.
  const root = temp(),
    artifact = join(root, "receipt.json"),
    target = join(root, "target.json")
  if (kind === "file") writeFileSync(artifact, "original receipt")
  else if (kind === "directory") mkdirSync(artifact)
  else {
    if (kind === "symlink") writeFileSync(target, "original target")
    symlinkSync(target, artifact)
  }
  const prepare = vi.spyOn(snapshot, "snapshotNativeInputs")
  const execute = vi.spyOn(osAdapters, "executeDockerSandboxedCommand")
  await expect(runNativeCommand(command, root, artifact, sandbox)).rejects.toMatchObject({ code: "EEXIST" })
  expect(prepare).not.toHaveBeenCalled()
  expect(execute).not.toHaveBeenCalled()
  if (kind === "file") expect(readFileSync(artifact, "utf8")).toBe("original receipt")
  if (kind === "directory") expect(lstatSync(artifact).isDirectory()).toBe(true)
  if (kind.includes("symlink")) expect(lstatSync(artifact).isSymbolicLink()).toBe(true)
  if (kind === "symlink") expect(readFileSync(target, "utf8")).toBe("original target")
  if (kind === "dangling symlink") expect(existsSync(target)).toBe(false)
})

it("refuses a receipt created during input preparation before launching the command", async () => {
  const root = repository(),
    artifact = join(root, "receipt.json")
  vi.spyOn(snapshot, "snapshotNativeInputs").mockImplementation(async () => {
    writeFileSync(artifact, "receipt from another writer", { flag: "wx" })
  })
  const execute = vi.spyOn(osAdapters, "executeDockerSandboxedCommand")
  await expect(runNativeCommand(command, root, artifact, sandbox)).rejects.toMatchObject({ code: "EEXIST" })
  expect(execute).not.toHaveBeenCalled()
  expect(readFileSync(artifact, "utf8")).toBe("receipt from another writer")
})

it("retains the final exclusive write when a receipt appears after execution begins", async () => {
  const root = repository(),
    artifact = join(root, "receipt.json")
  const execute = vi.spyOn(osAdapters, "executeDockerSandboxedCommand").mockImplementation(async () => {
    writeFileSync(artifact, "concurrent receipt", { flag: "wx" })
    return { stdout: "completed work", stderr: "" }
  })
  await expect(runNativeCommand(command, root, artifact, sandbox)).rejects.toMatchObject({ code: "EEXIST" })
  expect(execute).toHaveBeenCalledTimes(1)
  expect(readFileSync(artifact, "utf8")).toBe("concurrent receipt")
})

it("still executes committed input and creates a fresh receipt in a new parent directory", async () => {
  const root = repository(),
    artifact = join(root, "new", "receipt.json")
  vi.spyOn(osAdapters, "executeDockerSandboxedCommand").mockImplementation(async (_argv, options) => ({
    stdout: readFileSync(join(options.workspace, "source.txt"), "utf8"),
    stderr: ""
  }))
  const result = await runNativeCommand(command, root, artifact, sandbox)
  expect(result.exitCode).toBe(0)
  expect(JSON.parse(readFileSync(artifact, "utf8"))).toMatchObject({ exitCode: 0, stdout: "committed input" })
  expect(lstatSync(artifact).mode & 0o777).toBe(0o600)
})
