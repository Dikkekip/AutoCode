import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { loadEnvFiles } from "../apps/dispatcher-cli/src/env.js"

describe("env loading", () => {
  const originalBaseUrl = process.env.OPENAI_BASE_URL
  const originalModel = process.env.OPENAI_EMBEDDING_MODEL
  const originalAzureKey = process.env.AZURE_OPENAI_API_KEY
  const originalOpenAiKey = process.env.OPENAI_API_KEY
  const tempDirs: string[] = []

  afterEach(() => {
    if (originalBaseUrl === undefined) delete process.env.OPENAI_BASE_URL
    else process.env.OPENAI_BASE_URL = originalBaseUrl

    if (originalModel === undefined) delete process.env.OPENAI_EMBEDDING_MODEL
    else process.env.OPENAI_EMBEDDING_MODEL = originalModel

    if (originalAzureKey === undefined) delete process.env.AZURE_OPENAI_API_KEY
    else process.env.AZURE_OPENAI_API_KEY = originalAzureKey

    if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = originalOpenAiKey

    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })

  it("loads .env and lets .env.local override it without clobbering real env vars", () => {
    const cwd = mkdtempSync(join(tmpdir(), "dispatcher-env-"))
    tempDirs.push(cwd)

    writeFileSync(
      join(cwd, ".env"),
      [
        "OPENAI_BASE_URL=https://example.invalid/openai/v1/",
        "OPENAI_EMBEDDING_MODEL=text-embedding-3-large",
        "AZURE_OPENAI_API_KEY=env-file-key"
      ].join("\n"),
      "utf8"
    )
    writeFileSync(
      join(cwd, ".env.local"),
      ["OPENAI_EMBEDDING_MODEL=text-embedding-3-small", "AZURE_OPENAI_API_KEY=env-local-key"].join("\n"),
      "utf8"
    )

    process.env.OPENAI_API_KEY = "shell-wins"
    delete process.env.OPENAI_BASE_URL
    delete process.env.OPENAI_EMBEDDING_MODEL
    delete process.env.AZURE_OPENAI_API_KEY

    loadEnvFiles(cwd)

    expect(process.env.OPENAI_BASE_URL).toBe("https://example.invalid/openai/v1/")
    expect(process.env.OPENAI_EMBEDDING_MODEL).toBe("text-embedding-3-small")
    expect(process.env.AZURE_OPENAI_API_KEY).toBe("env-local-key")
    expect(process.env.OPENAI_API_KEY).toBe("shell-wins")
  })
})
