import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { executeDockerSandboxedCommand } from "../packages/os-adapters/src/shell.js"

// Dedicated opt-in: this image must provide Python 3 on the sandbox PATH.
// The generic isolation suite also supports BusyBox and does not require Python.
const image = process.env.NATIVE_TEST_DOCKER_REAPER_IMAGE
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function options() {
  const workspace = mkdtempSync(join(tmpdir(), "native-reaper-test-"))
  dirs.push(workspace)
  return { image: image!, workspace, cwd: "/work", timeoutMs: 15_000 }
}
const orphanProbe = `
import json, os, time
orphans = []
for _ in range(16):
    read_fd, write_fd = os.pipe()
    child = os.fork()
    if child == 0:
        os.close(read_fd)
        grandchild = os.fork()
        if grandchild == 0:
            os.write(write_fd, str(os.getpid()).encode())
            os.close(write_fd)
            time.sleep(0.05)
            os._exit(0)
        os.close(write_fd)
        os._exit(0)
    os.close(write_fd)
    orphans.append(int(os.read(read_fd, 64)))
    os.close(read_fd)
    os.waitpid(child, 0)
def remaining():
    states = []
    for pid in orphans:
        try:
            with open('/proc/' + str(pid) + '/stat') as handle:
                fields = handle.read().rsplit(')', 1)[1].split()
            states.append({'pid': pid, 'state': fields[0], 'parent': int(fields[1])})
        except FileNotFoundError:
            pass
    return states
deadline = time.monotonic() + 3
while remaining() and time.monotonic() < deadline:
    time.sleep(0.02)
print(json.dumps({'spawned': len(orphans), 'remaining': remaining()}))
`

describe.runIf(Boolean(image))("Docker child reaping", () => {
  it("reaps orphaned grandchildren before the verifier command exits", async () => {
    const result = await executeDockerSandboxedCommand(["python3", "-c", orphanProbe], options())
    const report = JSON.parse(result.stdout)
    expect(report.spawned).toBe(16)
    expect(report.remaining).toEqual([])
  }, 20_000)

  it("preserves the verifier command's nonzero exit status and output", async () => {
    await expect(
      executeDockerSandboxedCommand(["/bin/sh", "-c", "printf 'expected exit marker'; exit 23"], options())
    ).rejects.toMatchObject({ code: 23, outcome: "nonzero", stdout: "expected exit marker" })
  }, 20_000)
})
