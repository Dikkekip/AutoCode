import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { NativeCliGateway } from "../packages/core-runtime/src/native/gateway.js"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function cli(stdout: string, code: number, stderr = "") {
  const root = mkdtempSync(join(tmpdir(), "native-rpc-error-"))
  roots.push(root)
  const command = join(root, "openclaw")
  writeFileSync(
    command,
    `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(stdout)});process.stderr.write(${JSON.stringify(stderr)});process.exit(${code});\n`
  )
  chmodSync(command, 0o700)
  return new NativeCliGateway(command)
}
it("preserves validation errors from CLI JSON so the model can repair its proposal", async () => {
  const gateway = cli(
    JSON.stringify({
      ok: false,
      error: { code: "autocode_error", message: "Proposal must name a configured persona goal" }
    }),
    1
  )
  await expect(gateway.request("autocode.tool", { proposal: "PRIVATE_PROPOSAL" })).rejects.toThrow(
    "Native RPC autocode.tool failed: Proposal must name a configured persona goal"
  )
})
it("does not echo private arguments when a failed CLI supplies no diagnostic", async () => {
  const gateway = cli("", 1)
  const error = await gateway.request("autocode.tool", { proposal: "PRIVATE_PROPOSAL" }).catch((error: Error) => error)
  expect(error.message).toBe("Native RPC autocode.tool failed: CLI exited with 1")
  expect(error.message).not.toContain("PRIVATE_PROPOSAL")
})
it("rejects structured transport failures even when the CLI exits zero", async () => {
  await expect(
    cli(JSON.stringify({ ok: false, error: { message: "Gateway unavailable" } }), 0).request("health", {})
  ).rejects.toThrow("Gateway unavailable")
})
it("preserves a successful doctor report with failed readiness checks", async () => {
  const report = { ok: false, checks: [{ name: "agents", ok: false }] }
  await expect(cli(JSON.stringify(report), 0).request("autocode.doctor", {})).resolves.toEqual(report)
})
