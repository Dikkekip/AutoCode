import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { snapshotNativeInputs } from "../packages/core-runtime/src/native/snapshot.js"
import { nativeCandidateSandbox } from "../packages/core-runtime/src/native/verification.js"

const roots: string[] = []
function temp() {
  const root = mkdtempSync(join(tmpdir(), "native-snapshot-test-"))
  roots.push(root)
  return root
}
function fixture() {
  const root = temp()
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim()
  git("init")
  git("config", "user.name", "Snapshot Test")
  git("config", "user.email", "snapshot@example.invalid")
  git("config", "commit.gpgsign", "false")
  return {
    root,
    git,
    commit: () => {
      git("add", ".")
      git("commit", "-m", "fixture")
      return git("rev-parse", "HEAD")
    }
  }
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it("includes admitted new tests and removes admitted deletions without exposing other files", async () => {
  const f = fixture(),
    destination = temp()
  writeFileSync(join(f.root, "existing.ts"), "export const value = 1")
  writeFileSync(join(f.root, "removed.ts"), "old source")
  f.commit()
  rmSync(join(f.root, "removed.ts"))
  writeFileSync(join(f.root, "new.test.ts"), "real regression test")
  writeFileSync(join(f.root, "private.txt"), "not admitted")
  const sha = f.commit()
  const policy = {
    verificationSandbox: {
      backend: "docker",
      image: `sha256:${"a".repeat(64)}`,
      inputFiles: ["existing.ts", "removed.ts"]
    }
  } as any
  const sandbox = await nativeCandidateSandbox(policy, {
    cwd: f.root,
    headSha: sha,
    files: ["removed.ts", "new.test.ts"]
  })
  await snapshotNativeInputs(f.root, destination, sha, sandbox!.inputFiles)
  expect(readFileSync(join(destination, "new.test.ts"), "utf8")).toBe("real regression test")
  expect(existsSync(join(destination, "removed.ts"))).toBe(false)
  expect(existsSync(join(destination, "private.txt"))).toBe(false)
  expect(policy.verificationSandbox.inputFiles).toEqual(["existing.ts", "removed.ts"])
})

it("keeps secret paths and unreviewed policy source out of candidate additions", async () => {
  const f = fixture()
  writeFileSync(join(f.root, ".env"), "TOKEN=private")
  writeFileSync(join(f.root, "policy.py"), "sensitive source")
  const sha = f.commit()
  const policy = {
    verificationSandbox: { backend: "docker", image: `sha256:${"a".repeat(64)}`, inputFiles: [] }
  } as any
  for (const file of [".env", "policy.py"])
    await expect(nativeCandidateSandbox(policy, { cwd: f.root, headSha: sha, files: [file] })).rejects.toThrow(
      /excluding credentials/
    )
})

it("snapshots thousands of explicitly selected committed files without per-file processes", async () => {
  const f = fixture(),
    destination = temp()
  const files = Array.from({ length: 2000 }, (_, index) => `source-${index}.txt`)
  for (const file of files) writeFileSync(join(f.root, file), `committed ${file}\n`)
  const sha = f.commit()
  for (const file of files) writeFileSync(join(f.root, file), "uncommitted")
  writeFileSync(join(f.root, ".env"), "private")
  await snapshotNativeInputs(f.root, destination, sha, files)
  for (const file of files) expect(readFileSync(join(destination, file), "utf8")).toBe(`committed ${file}\n`)
  expect(existsSync(join(destination, ".env"))).toBe(false)
  expect(existsSync(join(destination, ".git"))).toBe(false)
}, 15_000)

it("preserves binary bytes, empty files, unusual names and executable modes without filters", async () => {
  const f = fixture(),
    destination = temp()
  const binary = Buffer.from([0, 10, 255, 128, 13, 0])
  writeFileSync(join(f.root, "binary data.bin"), binary)
  writeFileSync(join(f.root, "empty"), "")
  writeFileSync(join(f.root, "run.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o700 })
  writeFileSync(join(f.root, ".gitattributes"), "*.bin filter=untrusted\n")
  const sha = f.commit()
  f.git("config", "filter.untrusted.smudge", "false")
  f.git("config", "filter.untrusted.required", "true")
  await snapshotNativeInputs(f.root, destination, sha, ["binary data.bin", "empty", "run.sh"])
  expect(readFileSync(join(destination, "binary data.bin"))).toEqual(binary)
  expect(statSync(join(destination, "empty")).size).toBe(0)
  expect(statSync(join(destination, "run.sh")).mode & 0o777).toBe(0o700)
  expect(existsSync(join(destination, ".gitattributes"))).toBe(false)
})

it("rejects symbolic links, missing files and directory selections before copying", async () => {
  const f = fixture()
  writeFileSync(join(f.root, "safe"), "source")
  symlinkSync("safe", join(f.root, "link"))
  const sha = f.commit()
  for (const file of ["link", "missing", ".", "../safe"])
    await expect(snapshotNativeInputs(f.root, temp(), sha, ["safe", file])).rejects.toThrow(/regular file|escapes/)
})

it("honors cancellation and authority revocation during input preparation", async () => {
  const f = fixture(),
    destination = temp(),
    controller = new AbortController()
  writeFileSync(join(f.root, "safe"), "source")
  const sha = f.commit()
  controller.abort()
  await expect(snapshotNativeInputs(f.root, destination, sha, ["safe"], controller.signal)).rejects.toThrow()
  let checks = 0
  await expect(
    snapshotNativeInputs(f.root, destination, sha, ["safe"], undefined, () => {
      if (++checks === 2) throw new Error("ownership revoked")
    })
  ).rejects.toThrow(/ownership revoked/)
  expect(existsSync(join(destination, "safe"))).toBe(false)
})

it("pins reviewed source modules to their approved blob before copying any input", async () => {
  const f = fixture(),
    destination = temp()
  writeFileSync(join(f.root, "secrets.py"), "class SecretProvider: pass\n")
  writeFileSync(join(f.root, "safe.py"), "pass\n")
  const sha = f.commit()
  const reviewed = [{ path: "secrets.py", blobSha: f.git("rev-parse", `${sha}:secrets.py`) }]
  await snapshotNativeInputs(f.root, destination, sha, ["safe.py", "secrets.py"], undefined, undefined, reviewed)
  expect(readFileSync(join(destination, "secrets.py"), "utf8")).toContain("SecretProvider")
  writeFileSync(join(f.root, "secrets.py"), "changed source\n")
  const changed = f.commit(),
    rejected = temp()
  await expect(
    snapshotNativeInputs(f.root, rejected, changed, ["safe.py", "secrets.py"], undefined, undefined, reviewed)
  ).rejects.toThrow(/blob changed/)
  expect(existsSync(join(rejected, "safe.py"))).toBe(false)
  await expect(snapshotNativeInputs(f.root, temp(), sha, ["safe.py"], undefined, undefined, reviewed)).rejects.toThrow(
    /blob changed/
  )
})
