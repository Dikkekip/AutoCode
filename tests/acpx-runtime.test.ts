import { describe, expect, it } from "vitest"

import { compactAcpxFailureOutput } from "../packages/acpx/src/index.js"

describe("ACPX runtime", () => {
  it("keeps the diagnostic tail while bounding failed protocol output", () => {
    const output = `${"echoed task prompt ".repeat(2_000)}Account.Unauthorized: Invalid API key`
    const compacted = compactAcpxFailureOutput(output, 128)

    expect(compacted).toContain("characters omitted")
    expect(compacted).toContain("Account.Unauthorized: Invalid API key")
    expect(compacted.length).toBeLessThan(200)
  })

  it("preserves short failure output exactly", () => {
    expect(compactAcpxFailureOutput("  concise failure  ")).toBe("concise failure")
  })
})
