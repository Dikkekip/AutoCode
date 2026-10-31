import { randomUUID } from "node:crypto"
import { type T3ToolTransport, t3Object } from "./transport.js"

export interface T3McpHttpOptions {
  endpoint: string
  /** Explicit credential supplier; never discovered from another session or included in logs. */
  bearerToken: () => Promise<string>
  timeoutMs?: number
  maxResponseBytes?: number
  fetch?: typeof fetch
}

/** Bounded MCP Streamable HTTP client for an explicitly authorized, thread-scoped endpoint.
 * Mutations are never retried, including after an HTTP/session error. */
export class T3McpHttpTransport implements T3ToolTransport {
  private session: string | null = null
  private protocol: string | null = null
  private ready: Promise<Set<string>> | undefined
  private readonly endpoint: string
  private readonly timeoutMs: number
  private readonly maximum: number
  private readonly fetch: typeof fetch

  constructor(private readonly options: T3McpHttpOptions) {
    const endpoint = new URL(options.endpoint)
    if (
      (endpoint.protocol !== "https:" &&
        !(endpoint.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname))) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    )
      throw new Error("MCP endpoint requires HTTPS or loopback HTTP, without embedded credentials, query or fragment")
    this.endpoint = endpoint.toString()
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.maximum = options.maxResponseBytes ?? 4 * 1024 * 1024
    if (
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > 600_000 ||
      !Number.isSafeInteger(this.maximum) ||
      this.maximum < 1 ||
      this.maximum > 16 * 1024 * 1024
    )
      throw new Error("Invalid MCP request bounds")
    this.fetch = options.fetch ?? fetch
  }

  async callTool(name: string, arguments_: Record<string, unknown>): Promise<unknown> {
    this.ready ??= this.initialize()
    const names = await this.ready
    if (!names.has(name)) throw new Error(`T3 MCP tool not advertised: ${name}`)
    return this.request("tools/call", { name, arguments: arguments_ })
  }

  private async initialize(): Promise<Set<string>> {
    const result = t3Object(
      await this.request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "autocode-t3", version: "0.1.0" }
      }),
      "MCP initialize result"
    )
    if (
      !["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25", "2026-07-28"].includes(String(result.protocolVersion))
    )
      throw new Error("Unsupported negotiated MCP protocol")
    this.protocol = String(result.protocolVersion)
    await this.request("notifications/initialized", {}, true)
    const tools = new Set<string>()
    let cursor: string | undefined
    for (let page = 0; page < 8; page++) {
      const result = t3Object(await this.request("tools/list", cursor ? { cursor } : {}), "MCP tools/list result")
      if (!Array.isArray(result.tools)) throw new Error("MCP tool catalogue missing")
      for (const entry of result.tools) {
        const tool = t3Object(entry, "MCP tool")
        if (typeof tool.name !== "string" || !tool.name) throw new Error("Invalid MCP tool name")
        tools.add(tool.name)
      }
      if (result.nextCursor === undefined || result.nextCursor === null) return tools
      if (typeof result.nextCursor !== "string" || !result.nextCursor || result.nextCursor === cursor)
        throw new Error("Invalid MCP catalogue cursor")
      cursor = result.nextCursor
    }
    throw new Error("MCP tool catalogue exceeds pagination budget")
  }

  private async request(method: string, params: Record<string, unknown>, notification = false): Promise<unknown> {
    let token: string
    try {
      token = await this.options.bearerToken()
    } catch {
      throw new Error("MCP explicit credential supplier failed")
    }
    if (!token.trim() || /[\r\n]/.test(token)) throw new Error("Explicit MCP bearer credential unavailable")
    const id = randomUUID()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      const response = await this.fetch(this.endpoint, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(this.session ? { "mcp-session-id": this.session } : {}),
          ...(this.protocol ? { "mcp-protocol-version": this.protocol } : {})
        },
        body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id }), method, params })
      })
      if (!response.ok) throw new Error(`MCP HTTP ${response.status}; reconcile mutating calls before retry`)
      const session = response.headers.get("mcp-session-id")
      if (session && this.session && session !== this.session)
        throw new Error("MCP session changed; no automatic replay")
      if (session) this.session = session
      if (notification && (response.status === 202 || response.status === 204)) return null
      const type = response.headers.get("content-type") ?? ""
      if (!type.includes("application/json") && !type.includes("text/event-stream"))
        throw new Error("Unsupported MCP response content type")
      if (!response.body) throw new Error("MCP response body missing")
      reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = "",
        bytes = 0
      const decode = (raw: string): unknown => {
        const envelope = t3Object(JSON.parse(raw), "MCP response")
        if (envelope.jsonrpc !== "2.0" || envelope.id !== id) throw new Error("MCP response identity mismatch")
        if (envelope.error !== undefined)
          throw new Error("MCP method returned an error; reconcile mutating calls before retry")
        if (!("result" in envelope)) throw new Error("MCP response result missing")
        return envelope.result
      }
      for (;;) {
        const chunk = await reader.read()
        if (chunk.value) {
          bytes += chunk.value.byteLength
          if (bytes > this.maximum) throw new Error("MCP response exceeds byte budget")
          buffer += decoder.decode(chunk.value, { stream: true })
        }
        if (type.includes("text/event-stream")) {
          buffer = buffer.replace(/\r\n/g, "\n")
          let boundary = buffer.indexOf("\n\n")
          while (boundary >= 0) {
            const event = buffer.slice(0, boundary)
            buffer = buffer.slice(boundary + 2)
            const data = event
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart())
              .join("\n")
            if (data) {
              const value = t3Object(JSON.parse(data), "MCP SSE message")
              if (value.id === id) return decode(data)
              if (value.method && value.id !== undefined)
                throw new Error("MCP server requested an unsupported client interaction")
            }
            boundary = buffer.indexOf("\n\n")
          }
          if (chunk.done) throw new Error("MCP event stream ended without the matching result")
        } else if (chunk.done) return notification && !buffer.trim() ? null : decode(buffer + decoder.decode())
      }
    } catch (error) {
      // Never echo fetch errors, response bodies or credential supplier values.
      if (error instanceof Error && error.message.startsWith("MCP")) throw error
      throw new Error("MCP transport failed; outcome may be uncertain and no request was retried")
    } finally {
      clearTimeout(timeout)
      await reader?.cancel().catch(() => undefined)
      controller.abort()
    }
  }
}
