import { describe, expect, it } from "vitest"
import { nextReleaseTag } from "../packages/executor/src/runner.js"

describe("promotion release versions", () => {
  it.each([
    [["v0.1.0.1952", "v3"], "v3.0.1"],
    [["v3", "v3.0.1", "v0.1.0.1953"], "v3.0.2"],
    [["v3.0.9", "v3.0.10", "v3"], "v3.0.11"],
    [["3", "v2.9.9"], "v3.0.1"],
    [["v3", "v4-rc.1", "release-20260905"], "v3.0.1"],
    [["v0.1.0.1952"], "v0.1.0.1953"],
    [["v9.35"], "v9.36"],
    [[], "v0.1.0.1"]
  ])("continues published versions %j as %s", (tags, expected) => {
    expect(nextReleaseTag(tags as string[], null)).toBe(expected)
  })

  it("preserves explicit release base overrides", () => {
    expect(nextReleaseTag(["v1.2.3.4", "v3"], "v1.2.3")).toBe("v1.2.3.5")
  })
})
