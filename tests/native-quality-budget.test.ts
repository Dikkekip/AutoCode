import { describe, expect, it } from "vitest"
import { nativeHighRiskPaths, validateNativeQualityPolicy } from "../packages/domain/src/native-quality.js"

const quality = { skillPath: "/skills/native-investigation/SKILL.md" }

describe("finite native investigation session budget", () => {
  it("retains the 300-second default when no budget is supplied", () => {
    expect(validateNativeQualityPolicy(quality).sessionSeconds).toBe(300)
  })

  it.each([30, 300, 301, 599, 600])("accepts an explicit %i-second budget", (sessionSeconds) => {
    expect(validateNativeQualityPolicy({ ...quality, sessionSeconds }).sessionSeconds).toBe(sessionSeconds)
  })

  it.each([
    29,
    601,
    0,
    -1,
    30.5,
    599.5,
    NaN,
    Infinity,
    -Infinity,
    "600",
    true
  ])("rejects an invalid budget %s", (sessionSeconds) => {
    expect(() => validateNativeQualityPolicy({ ...quality, sessionSeconds })).toThrow(
      "Investigation budget must be between 30 and 600 seconds"
    )
  })

  it("preserves admission, exploration, and mandatory risk defaults at the extended ceiling", () => {
    const result = validateNativeQualityPolicy({ ...quality, sessionSeconds: 600, highRiskPaths: [] })
    expect(result.admissionBudget).toEqual({ effortHours: 24, costCents: 10000 })
    expect(result.explorationSlots).toBe(0)
    expect(result.highRiskPaths).toEqual(nativeHighRiskPaths)
  })

  it.each([
    { skillPath: "relative/skill.md" },
    { highRiskPaths: [""] },
    { admissionBudget: { effortHours: -1, costCents: 0 } },
    { explorationSlots: 101 }
  ])("retains other quality validation guards with the extended budget", (invalid) => {
    expect(() => validateNativeQualityPolicy({ ...quality, sessionSeconds: 600, ...invalid })).toThrow()
  })
})
