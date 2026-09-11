import { execFile } from "node:child_process"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { NativeCliGateway } from "../packages/core-runtime/src/native/gateway.js"

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>()
  return { ...actual, execFile: vi.fn(actual.execFile) }
})

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
it.each([
  ["autocode.policy.refresh.apply", 180000],
  ["autocode.discover", 180000],
  ["autocode.dispatch", 180000],
  ["autocode.policy.refresh.plan", 30000],
  ["autocode.doctor", 180000],
  ["autocode.status", 30000],
  ["autocode.reconcile", 7200000]
])("passes the bounded public CLI deadline for %s", async (method, timeout) => {
  const root = mkdtempSync(join(tmpdir(), "native-timeout-cli-")),
    command = join(root, "openclaw")
  roots.push(root)
  writeFileSync(
    command,
    '#!/usr/bin/env node\nconst args=process.argv.slice(2);process.stdout.write(JSON.stringify({method:args[2],timeout:Number(args[args.indexOf("--timeout")+1]),params:JSON.parse(args[args.indexOf("--params")+1])}));\n'
  )
  chmodSync(command, 0o700)
  const result = await new NativeCliGateway(command).request(String(method), { boardId: "test-board" })
  expect(result).toEqual({ method, timeout, params: { boardId: "test-board" } })
  expect(execFile).toHaveBeenLastCalledWith(
    command,
    expect.any(Array),
    expect.objectContaining({ timeout: Number(timeout) + 10000 }),
    expect.any(Function)
  )
})

it("preserves the complete structured dispatch observation returned by the public CLI", async () => {
  const root = mkdtempSync(join(tmpdir(), "native-dispatch-result-")),
    command = join(root, "openclaw")
  roots.push(root)
  const result = {
    advanced: 0,
    dispatch: {
      startedCount: 1,
      startedCardIds: ["started-card"],
      deferredCount: 1,
      deferred: [{ cardId: "waiting-card", reason: "worktree-capacity" }]
    }
  }
  writeFileSync(command, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(result))})\n`)
  chmodSync(command, 0o700)
  expect(await new NativeCliGateway(command).request("autocode.dispatch", { boardId: "test-board" })).toEqual(result)
})
