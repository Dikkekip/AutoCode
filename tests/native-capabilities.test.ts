import { createHash } from "node:crypto"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  configuredNativeModels,
  type NativeCapabilityEvidence,
  type NativeCapabilityRequirement,
  nativeCapabilityEligibility,
  registerNativeCapabilityEvidence
} from "../packages/core-runtime/src/native/capabilities.js"
import { NativeEvidenceStore } from "../packages/core-runtime/src/native/store.js"

const value: NativeCapabilityEvidence = {
  version: 1,
  agentId: "coder",
  model: "fixture-model",
  benchmarkId: "benchmark",
  datasetDigest: "a".repeat(64),
  policyDigest: "b".repeat(64),
  mode: "live",
  measuredAt: 100,
  expiresAt: 1000,
  capabilities: {
    contextTokens: 32000,
    structuredOutput: true,
    tools: ["read"],
    cancellation: true,
    sessionResume: false,
    costPerVerifiedOutcome: null
  },
  artifact: { path: "/fixture", sha256: "c".repeat(64) }
}
const required: NativeCapabilityRequirement = {
  contextTokens: 8000,
  structuredOutput: true,
  tools: ["read"],
  cancellation: true,
  sessionResume: false,
  requireKnownCost: false
}
const expected = { agentId: "coder", model: "fixture-model", policyDigest: value.policyDigest }
describe("native measured capability routing", () => {
  it("registers only exact protected artifacts with independent operator approval", () => {
    const root = mkdtempSync(join(tmpdir(), "native-capabilities-"))
    const store = new NativeEvidenceStore(join(root, "evidence.db"))
    const { artifact: _, ...body } = value
    const raw = JSON.stringify(body)
    const path = join(root, "benchmark.json")
    writeFileSync(path, raw)
    const fixture = { ...value, artifact: { path, sha256: createHash("sha256").update(raw).digest("hex") } }
    const authority = { operatorId: "operator", rationale: "Reviewed controlled fixture" }
    expect(() =>
      registerNativeCapabilityEvidence(store, fixture, root, { ...authority, operatorId: "coder" }, ["coder"])
    ).toThrow(/operator/)
    const id = registerNativeCapabilityEvidence(store, fixture, root, authority, ["coder"])
    expect(store.get("capability-evidence", id)).toEqual(fixture)
    writeFileSync(path, JSON.stringify({ ...body, model: "replacement" }))
    expect(() => registerNativeCapabilityEvidence(store, fixture, root, authority, ["coder"])).toThrow(/changed/)
    store.close()
  })
  it("rejects unmeasured fallback configuration instead of inheriting primary evidence", () => {
    const policy = {
      plannerAgentId: "planner",
      coderAgentId: "coder",
      reviewerAgentId: "reviewer",
      personas: []
    } as any
    expect(configuredNativeModels({ agents: { defaults: { model: "measured" } } }, policy)).toEqual({
      planner: "measured",
      coder: "measured",
      reviewer: "measured"
    })
    expect(() =>
      configuredNativeModels(
        { agents: { defaults: { model: { primary: "measured", fallbacks: ["unknown"] } } } },
        policy
      )
    ).toThrow(/fallbacks/)
  })
  it("keeps unknown cost unknown without expanding tools", () => {
    const d = nativeCapabilityEligibility(value, required, expected, 200)
    expect(d.eligible).toBe(true)
    expect(d.measuredCost).toBeNull()
    expect(d.toolsRemainUnchanged).toBe(true)
  })
  it("rejects unknown capabilities, stale evidence, wrong model and controlled-only proof", () => {
    expect(
      nativeCapabilityEligibility(value, { ...required, sessionResume: true, requireKnownCost: true }, expected, 200)
        .eligible
    ).toBe(false)
    expect(nativeCapabilityEligibility(value, required, expected, 1001).eligible).toBe(false)
    expect(nativeCapabilityEligibility(value, required, { ...expected, model: "cheap-model" }, 200).eligible).toBe(
      false
    )
    expect(
      nativeCapabilityEligibility({ ...value, mode: "controlled-fixture" }, required, expected, 200).eligible
    ).toBe(false)
    expect(
      nativeCapabilityEligibility(
        { ...value, capabilities: { ...value.capabilities, cancellation: null } },
        required,
        expected,
        200
      ).eligible
    ).toBe(false)
  })
})
