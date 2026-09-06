// Health receipt decoding admits only the expected target and explicitly modeled public fields.
import { expect, it } from "vitest"
import { decodeNativeHealth } from "../packages/core-runtime/src/native/deployment-health.js"

it("rejects stale and mismatched health and strips unrelated raw output", () => {
  const expected = { targetId: "staging", revision: "a".repeat(40), artifactSha256: "b".repeat(64) },
    now = 100000
  const receipt = {
    targetId: expected.targetId,
    deployedSha: expected.revision,
    artifactSha256: expected.artifactSha256,
    healthy: true,
    workflowPassed: true,
    rolloutState: "settled",
    observedAt: now,
    privateDebug: "do not publish"
  }
  expect(decodeNativeHealth(JSON.stringify(receipt), expected, now)).not.toHaveProperty("privateDebug")
  expect(decodeNativeHealth(JSON.stringify({ ...receipt, targetId: "production" }), expected, now)).toBeNull()
  expect(decodeNativeHealth(JSON.stringify({ ...receipt, observedAt: now - 60001 }), expected, now)).toBeNull()
  expect(decodeNativeHealth(JSON.stringify({ ...receipt, observedAt: now + 1 }), expected, now)).toBeNull()
})
