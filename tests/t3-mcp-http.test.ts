import { T3McpHttpTransport } from "@autocode/t3-runtime"
import { describe, expect, it } from "vitest"

function fixture(behavior?: (request: Record<string, unknown>, init: RequestInit) => Response) {
  const calls: Array<{ method: string; headers: Headers }> = []
  const transport = new T3McpHttpTransport({
    endpoint: "http://127.0.0.1:12345/mcp",
    bearerToken: async () => "fixture-secret-never-log",
    timeoutMs: 500,
    fetch: (async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>
      calls.push({ method: String(request.method), headers: new Headers(init?.headers) })
      if (request.method === "notifications/initialized") return new Response(null, { status: 202 })
      if (request.method === "tools/call" && behavior) return behavior(request, init!)
      const result =
        request.method === "initialize"
          ? { protocolVersion: "2025-06-18", capabilities: {} }
          : request.method === "tools/list"
            ? { tools: [{ name: "delegate_task" }] }
            : { structuredContent: { taskId: "fixture-task" } }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), {
        headers: { "content-type": "application/json", "mcp-session-id": "fixture-session" }
      })
    }) as typeof fetch
  })
  return { transport, calls }
}

describe("explicitly configured T3 MCP HTTP transport", () => {
  it("negotiates a scoped session and advertised tools once, with no credentials in arguments", async () => {
    const f = fixture()
    expect(await f.transport.callTool("delegate_task", { task: "fixture" })).toEqual({
      structuredContent: { taskId: "fixture-task" }
    })
    await f.transport.callTool("delegate_task", { task: "second" })
    expect(f.calls.map((call) => call.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
      "tools/call"
    ])
    expect(f.calls.at(-1)!.headers.get("mcp-session-id")).toBe("fixture-session")
    expect(f.calls.at(-1)!.headers.get("mcp-protocol-version")).toBe("2025-06-18")
    await expect(f.transport.callTool("private_rpc", {})).rejects.toThrow("not advertised")
    expect(f.calls).toHaveLength(5)
  })

  it("decodes a bounded chunked SSE response and ignores heartbeat notifications", async () => {
    const f = fixture((request) => {
      const wire = `: heartbeat\r\n\r\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\r\n\r\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { taskId: "from-stream" } })}\r\n\r\n`
      return new Response(
        new ReadableStream({
          start(controller) {
            for (let i = 0; i < wire.length; i += 3) controller.enqueue(new TextEncoder().encode(wire.slice(i, i + 3)))
            controller.close()
          }
        }),
        { headers: { "content-type": "text/event-stream" } }
      )
    })
    expect(await f.transport.callTool("delegate_task", {})).toEqual({ taskId: "from-stream" })
  })

  it("never retries authorization failures, mismatched replies or a changed session", async () => {
    for (const response of [
      () => new Response("do not expose body", { status: 401 }),
      () =>
        new Response('{"jsonrpc":"2.0","id":"different","result":{}}', {
          headers: { "content-type": "application/json" }
        }),
      (request: Record<string, unknown>) =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }), {
          headers: { "content-type": "application/json", "mcp-session-id": "other-session" }
        })
    ]) {
      const f = fixture(response)
      await expect(f.transport.callTool("delegate_task", {})).rejects.toThrow(/MCP/)
      expect(f.calls.filter((call) => call.method === "tools/call")).toHaveLength(1)
    }
  })

  it("bounds response bytes and refuses credentials embedded in an insecure endpoint", async () => {
    expect(
      () => new T3McpHttpTransport({ endpoint: "http://example.invalid/mcp", bearerToken: async () => "secret" })
    ).toThrow("HTTPS or loopback")
    expect(
      () =>
        new T3McpHttpTransport({ endpoint: "https://secret@example.invalid/mcp", bearerToken: async () => "secret" })
    ).toThrow("embedded credentials")
    const f = fixture(
      () => new Response("x".repeat(4 * 1024 * 1024 + 1), { headers: { "content-type": "application/json" } })
    )
    await expect(f.transport.callTool("delegate_task", {})).rejects.toThrow("byte budget")
    expect(f.calls.filter((call) => call.method === "tools/call")).toHaveLength(1)
  })
})
