import type { Readable, Writable } from "node:stream"
import type { T3ToolTransport } from "./transport.js"

const permitted = new Set([
  "orchestrator_capabilities",
  "t3_thread_read",
  "t3_project_read",
  "delegate_task",
  "task_status",
  "task_cancel",
  "schedule_task"
])

/** Agent-owned relay to its existing authenticated T3 tools. No credential discovery or direct RPC. */
export class T3StdioTransport implements T3ToolTransport {
  private sequence = 0
  private active = false
  private failed = false

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly timeoutMs = 60_000,
    private readonly maxBytes = 4 * 1024 * 1024
  ) {
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 60_000 ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > 16 * 1024 * 1024
    )
      throw new Error("Invalid T3 relay bounds")
  }

  async callTool(name: string, arguments_: Record<string, unknown>): Promise<unknown> {
    if (!permitted.has(name)) throw new Error("Tool is outside the T3 coordinator relay contract")
    if (this.failed || this.active) throw new Error("T3 relay unavailable or already awaiting a response")
    const id = ++this.sequence
    const request = `AUTOCODE_T3_REQUEST ${JSON.stringify({ type: "t3.tool.request", id, name, arguments: arguments_ })}\n`
    if (Buffer.byteLength(request) > this.maxBytes) throw new Error("T3 relay request exceeds byte budget")
    this.active = true
    return new Promise((resolve, reject) => {
      let bytes = Buffer.alloc(0)
      const cleanup = () => {
        clearTimeout(timer)
        this.active = false
        this.input.off("data", data)
        this.input.off("end", ended)
        this.input.off("error", ended)
        this.input.pause()
      }
      const fail = (message: string) => {
        cleanup()
        this.failed = true
        reject(new Error(message))
      }
      const ended = () => fail("T3 relay closed; reconcile any sent mutation before retry")
      const data = (chunk: Buffer | string) => {
        bytes = Buffer.concat([bytes, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)])
        if (bytes.length > this.maxBytes) return fail("T3 relay response exceeds byte budget")
        const newline = bytes.indexOf(10)
        if (newline === -1) return
        try {
          const line = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, newline))
          const response = JSON.parse(line)
          if (
            bytes
              .subarray(newline + 1)
              .toString()
              .trim() ||
            response.type !== "t3.tool.response" ||
            response.id !== id
          )
            return fail("T3 relay response identity mismatch")
          if (response.error !== undefined) return fail("Authenticated T3 tool failed; reconcile before retry")
          if (!Object.hasOwn(response, "result")) return fail("T3 relay response has no result")
          cleanup()
          resolve(response.result)
        } catch {
          fail("Malformed T3 relay response")
        }
      }
      const timer = setTimeout(
        () => fail("T3 relay timed out; reconcile any sent mutation before retry"),
        this.timeoutMs
      )
      this.input.on("data", data)
      this.input.once("end", ended)
      this.input.once("error", ended)
      this.input.resume()
      this.output.write(request, (error) => {
        if (error) fail("T3 relay send failed; reconcile before retry")
      })
    })
  }
}
