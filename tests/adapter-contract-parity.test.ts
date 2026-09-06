import { describe, expect, it } from "vitest"

import { azureFoundryAdapter } from "../packages/adapters/azure-foundry/src/index.js"
import { codexLocalAdapter } from "../packages/adapters/codex-local/src/index.js"
import { geminiLocalAdapter } from "../packages/adapters/gemini-local/src/index.js"

describe("adapter contract parity", () => {
  it("exposes aligned operator metadata and continuation contracts", () => {
    const codexParsed = codexLocalAdapter.parseResult(
      '{"session_id":"codex-session","response":"ok","usage":{"totalTokens":11}}\n',
      ""
    )
    const geminiParsed = geminiLocalAdapter.parseResult(
      '{"session_id":"gemini-session","response":"ok","stats":{"totalTokenCount":7}}',
      ""
    )

    expect(codexLocalAdapter.capabilities.supportsSessionResume).toBe(true)
    expect(geminiLocalAdapter.capabilities.supportsSessionResume).toBe(true)
    expect(azureFoundryAdapter.capabilities.supportsSessionResume).toBe(false)
    expect(codexLocalAdapter.capabilities.heartbeatIdentityMode).toBe("prompt_and_env")
    expect(geminiLocalAdapter.capabilities.heartbeatIdentityMode).toBe("prompt_and_env")
    expect(azureFoundryAdapter.capabilities.heartbeatIdentityMode).toBe("prompt_and_env")

    expect(codexParsed.metadata).toMatchObject({
      adapterType: "codex_local",
      provider: "codex"
    })
    expect(geminiParsed.metadata).toMatchObject({
      adapterType: "gemini_local",
      provider: "gemini"
    })
    expect(azureFoundryAdapter.parseResult('{"choices":[{"message":{"content":"ok"}}]}', "").metadata).toMatchObject({
      adapterType: "azure_foundry",
      provider: "azure_foundry"
    })

    expect(codexParsed.continuation).toEqual({
      sessionDisplayId: "codex-session",
      state: { sessionId: "codex-session" }
    })
    expect(geminiParsed.continuation).toEqual({
      sessionDisplayId: "gemini-session",
      state: { sessionId: "gemini-session" }
    })
  })

  it("extracts Codex continuation state from nested session and conversation ids", () => {
    const nestedSession = codexLocalAdapter.parseResult(
      JSON.stringify({
        type: "session.created",
        session: { id: "codex-session-nested" },
        message: { content: [{ type: "text", text: "started" }] }
      }),
      ""
    )
    const nestedConversation = codexLocalAdapter.parseResult(
      JSON.stringify({
        type: "response.completed",
        response: {
          conversation: { id: "codex-conversation-nested" },
          output: [{ content: [{ type: "output_text", text: "done" }] }]
        }
      }),
      ""
    )

    expect(nestedSession.continuation).toEqual({
      sessionDisplayId: "codex-session-nested",
      state: { sessionId: "codex-session-nested" }
    })
    expect(nestedConversation.continuation).toEqual({
      sessionDisplayId: "codex-conversation-nested",
      state: { sessionId: "codex-conversation-nested" }
    })
    expect(nestedConversation.response).toBe("done")
  })

  it("extracts Gemini continuation state from JSON-RPC session updates", () => {
    const parsed = geminiLocalAdapter.parseResult(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          session: { id: "gemini-session-rpc" },
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "ok" }
          }
        }
      }),
      ""
    )

    expect(parsed.response).toBe("ok")
    expect(parsed.continuation).toEqual({
      sessionDisplayId: "gemini-session-rpc",
      state: { sessionId: "gemini-session-rpc" }
    })
  })

  it("extracts Gemini continuation state from pretty JSON after CLI warnings", () => {
    const parsed = geminiLocalAdapter.parseResult(
      [
        "YOLO mode is enabled. All tool calls will be automatically approved.",
        "Loaded cached credentials.",
        JSON.stringify(
          {
            session_id: "gemini-session-pretty",
            response: "ok",
            stats: {
              totalTokenCount: 17
            }
          },
          null,
          2
        )
      ].join("\n"),
      ""
    )

    expect(parsed.response).toBe("ok")
    expect(parsed.continuation).toEqual({
      sessionDisplayId: "gemini-session-pretty",
      state: { sessionId: "gemini-session-pretty" }
    })
    expect(parsed.usage?.totalTokens).toBe(17)
  })

  it("extracts Gemini response chunks from multiple pretty JSON events after CLI warnings", () => {
    const parsed = geminiLocalAdapter.parseResult(
      [
        "YOLO mode is enabled. All tool calls will be automatically approved.",
        JSON.stringify(
          {
            jsonrpc: "2.0",
            params: {
              sessionId: "gemini-session-stream",
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { text: "hel" }
              }
            }
          },
          null,
          2
        ),
        JSON.stringify(
          {
            jsonrpc: "2.0",
            params: {
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { text: "lo" }
              }
            }
          },
          null,
          2
        )
      ].join("\n"),
      ""
    )

    expect(parsed.response).toBe("hello")
    expect(parsed.continuation).toEqual({
      sessionDisplayId: "gemini-session-stream",
      state: { sessionId: "gemini-session-stream" }
    })
  })
})
