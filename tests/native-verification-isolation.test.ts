import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { runNativeCommand, runNativeDeploymentCommand } from "../packages/core-runtime/src/native/verification.js"
import { validateNativeVerificationSandbox } from "../packages/domain/src/native-autonomy.js"
import {
  allowlistedEnvironment,
  BUILD_ENVIRONMENT_ALLOWLIST,
  executeSandboxedCommand
} from "../packages/os-adapters/src/shell.js"

const dirs: string[] = []
function temp() {
  const dir = mkdtempSync(join(tmpdir(), "verification-test-"))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const command = { argv: ["/bin/sh", "-c", "exit 0"], cwd: ".", timeoutSeconds: 5 }
it("inherits only allowlisted build variables", () => {
  expect(
    allowlistedEnvironment(BUILD_ENVIRONMENT_ALLOWLIST, {
      CI: "true",
      NODE_ENV: "test",
      SYNTHETIC_SECRET: "secret",
      NODE_OPTIONS: "--require evil",
      HOME: "/credentials"
    })
  ).toEqual({ CI: "true", NODE_ENV: "test" })
})
it("fails closed without sandbox configuration and deployment authorization", async () => {
  await expect(runNativeCommand(command, temp(), join(temp(), "receipt"))).rejects.toThrow(/sandbox/)
  await expect(runNativeDeploymentCommand(command, temp(), join(temp(), "receipt"), {}, {})).rejects.toThrow(
    /authorized/
  )
})
it("scopes deployment credentials and creates distinct receipts for repeated checks", async () => {
  const root = temp(),
    artifact = join(temp(), "check.json")
  const oldSecret = process.env.SYNTHETIC_SECRET,
    oldCredential = process.env.TEST_DEPLOY_CREDENTIAL
  process.env.SYNTHETIC_SECRET = "excluded"
  process.env.TEST_DEPLOY_CREDENTIAL = "explicitly-authorized"
  try {
    const deploy = {
      ...command,
      argv: [
        process.execPath,
        "-e",
        "console.log(JSON.stringify({secret:process.env.SYNTHETIC_SECRET,credential:process.env.TEST_DEPLOY_CREDENTIAL,sha:process.env.AUTOCODE_SHA}))"
      ]
    }
    const authorization = { authorized: true, environmentAllowlist: ["TEST_DEPLOY_CREDENTIAL"] }
    const first = await runNativeDeploymentCommand(deploy, root, artifact, { AUTOCODE_SHA: "reviewed" }, authorization)
    const second = await runNativeDeploymentCommand(deploy, root, artifact, { AUTOCODE_SHA: "reviewed" }, authorization)
    expect(first.exitCode).toBe(0)
    expect(JSON.parse(first.stdout)).toEqual({ credential: "explicitly-authorized", sha: "reviewed" })
    expect(first.artifact).not.toBe(second.artifact)
    expect(existsSync(first.artifact)).toBe(true)
  } finally {
    if (oldSecret === undefined) delete process.env.SYNTHETIC_SECRET
    else process.env.SYNTHETIC_SECRET = oldSecret
    if (oldCredential === undefined) delete process.env.TEST_DEPLOY_CREDENTIAL
    else process.env.TEST_DEPLOY_CREDENTIAL = oldCredential
  }
})
it("rejects host roots, secret inputs, policies, directories and wildcard inputs", () => {
  for (const input of [".", "src/*", ".env", ".openclaw/native-artifacts/receipt", "config/policy.json", "../escape"])
    expect(() =>
      validateNativeVerificationSandbox({
        backend: "bubblewrap",
        rootFilesystem: "/opt/build-root",
        inputFiles: [input]
      })
    ).toThrow()
  expect(() =>
    validateNativeVerificationSandbox({ backend: "bubblewrap", rootFilesystem: "/", inputFiles: ["a"] })
  ).toThrow()
})
it.runIf(process.platform !== "linux" || !existsSync("/usr/bin/bwrap"))(
  "never falls back on unsupported hosts",
  async () => {
    const marker = join(temp(), "escaped")
    await expect(
      executeSandboxedCommand(
        [process.execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`],
        {
          rootFilesystem: "/",
          workspace: temp(),
          cwd: "/work",
          timeoutMs: 1000
        }
      )
    ).rejects.toThrow(/unavailable/)
    expect(existsSync(marker)).toBe(false)
  }
)

// CI provisions a minimal, root-owned BusyBox root. Explicit configuration makes
// unavailable namespaces a test FAILURE, not a skip or an unrestricted fallback.
const rootFilesystem = process.env.NATIVE_TEST_ROOTFS
const integration = rootFilesystem ? describe : describe.skip
integration("Bubblewrap kernel isolation", () => {
  it("hides secrets, blocks host writes and receipt tampering, preserves build variables", async () => {
    const repo = temp(),
      evidence = temp(),
      outside = join(temp(), "outside")
    const receipt = join(evidence, "existing.json")
    writeFileSync(receipt, "original")
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" })
    git("init")
    git("config", "commit.gpgsign", "false")
    git("config", "user.email", "test@example.invalid")
    git("config", "user.name", "Test")
    writeFileSync(join(repo, "source.txt"), "source")
    writeFileSync(join(repo, ".env"), "GATEWAY_TOKEN=secret")
    git("add", "source.txt")
    git("commit", "-m", "source")
    const oldSecret = process.env.SYNTHETIC_SECRET,
      oldCI = process.env.CI
    process.env.SYNTHETIC_SECRET = "must-not-leak"
    process.env.CI = "required-build-value"
    try {
      const script = `test -z "$SYNTHETIC_SECRET" && test "$CI" = required-build-value && test ! -e /work/.env && test ! -e /work/.git && test ! -e '${receipt}' && ! echo corrupt > '${receipt}' && ! echo escape > '${outside}' && ! echo bad > /bin/forbidden && echo ok > /work/build.txt && echo scratch > /tmp/build.txt && cat /work/source.txt`
      const result = await runNativeCommand(
        { ...command, argv: ["/bin/sh", "-c", script] },
        repo,
        join(evidence, "new.json"),
        {
          backend: "bubblewrap",
          rootFilesystem: rootFilesystem!,
          inputFiles: ["source.txt"]
        }
      )
      expect(result.exitCode, result.stderr).toBe(0)
      expect(result.stdout).toContain("source")
      expect(readFileSync(receipt, "utf8")).toBe("original")
      expect(existsSync(outside)).toBe(false)
      expect(existsSync(join(repo, "build.txt"))).toBe(false)
      expect(JSON.parse(readFileSync(result.artifact, "utf8")).exitCode).toBe(0)
    } finally {
      if (oldSecret === undefined) delete process.env.SYNTHETIC_SECRET
      else process.env.SYNTHETIC_SECRET = oldSecret
      if (oldCI === undefined) delete process.env.CI
      else process.env.CI = oldCI
    }
  })
  it("enforces cancellation, timeout and output bounds", async () => {
    const options = { rootFilesystem: rootFilesystem!, workspace: temp(), cwd: "/work", timeoutMs: 5000 }
    const controller = new AbortController()
    const running = executeSandboxedCommand(["/bin/sh", "-c", "(sleep 1; echo survived > /work/survived) & wait"], {
      ...options,
      signal: controller.signal
    })
    setTimeout(() => controller.abort(), 100)
    await expect(running).rejects.toThrow(/abort/i)
    await new Promise((resolve) => setTimeout(resolve, 1200))
    expect(existsSync(join(options.workspace, "survived"))).toBe(false)
    await expect(
      executeSandboxedCommand(["/bin/sh", "-c", "sleep 30"], { ...options, timeoutMs: 100 })
    ).rejects.toThrow()
    await expect(
      executeSandboxedCommand(["/bin/sh", "-c", "yes flood"], { ...options, maxBufferBytes: 1024 })
    ).rejects.toThrow(/maxBuffer/)
  })
})
