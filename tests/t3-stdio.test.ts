import { PassThrough } from "node:stream"
import { T3StdioTransport } from "@autocode/t3-runtime"
import { describe, expect, it } from "vitest"

function fixture(timeoutMs = 1000, maxBytes = 4096) {
  const input = new PassThrough()
  const output = new PassThrough()
  const requests: Record<string, unknown>[] = []
  output.on("data", (chunk) => requests.push(JSON.parse(chunk.toString().replace("AUTOCODE_T3_REQUEST ", ""))))
  return { input, output, requests, transport: new T3StdioTransport(input, output, timeoutMs, maxBytes) }
}

describe("authenticated agent T3 relay", () => {
  it("correlates chunked replies without needing an HTTP credential", async () => {
    const f = fixture()
    const pending = f.transport.callTool("t3_project_read", { projectId: "bound-project" })
    expect(f.requests).toEqual([
      { type: "t3.tool.request", id: 1, name: "t3_project_read", arguments: { projectId: "bound-project" } }
    ])
    f.input.write('{"type":"t3.tool.response","id":1,')
    f.input.write('"result":{"workspaceRoot":"/fixture"}}\n')
    expect(await pending).toEqual({ workspaceRoot: "/fixture" })
    const second = f.transport.callTool("task_status", { taskId: "fixture-task" })
    f.input.write('{"type":"t3.tool.response","id":2,"result":{"status":"completed"}}\n')
    expect(await second).toEqual({ status: "completed" })
  })

  it("refuses unknown tools and parallel requests without sending them", async () => {
    const f = fixture()
    await expect(f.transport.callTool("private_rpc", {})).rejects.toThrow("outside")
    const first = f.transport.callTool("delegate_task", {})
    await expect(f.transport.callTool("delegate_task", {})).rejects.toThrow("already awaiting")
    f.input.write('{"type":"t3.tool.response","id":1,"result":{"taskId":"one"}}\n')
    await first
    expect(f.requests).toHaveLength(1)
  })

  it.each([
    "wrong-id",
    "malformed",
    "oversize",
    "tool-error",
    "closed",
    "timeout"
  ])("fails closed on %s and never sends a replay", async (failure) => {
    const f = fixture(failure === "timeout" ? 10 : 1000, 1024)
    const pending = f.transport.callTool("delegate_task", {})
    const rejected = expect(pending).rejects.toThrow(/T3/)
    if (failure === "wrong-id") f.input.write('{"type":"t3.tool.response","id":99,"result":{}}\n')
    if (failure === "malformed") f.input.write("broken-json\n")
    if (failure === "oversize") f.input.write("x".repeat(1025))
    if (failure === "tool-error") f.input.write('{"type":"t3.tool.response","id":1,"error":"never log payload"}\n')
    if (failure === "closed") f.input.end()
    await rejected
    await expect(f.transport.callTool("delegate_task", {})).rejects.toThrow("unavailable")
    expect(f.requests).toHaveLength(1)
  })
})
