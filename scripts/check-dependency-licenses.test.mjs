import assert from "node:assert/strict"
import { test } from "node:test"
import { validateLicenseInventory } from "./check-dependency-licenses.mjs"

const policy = { version: 1, allowedExpressions: ["MIT"], exceptions: [] }
const inventory = { MIT: [{ name: "fixture", versions: ["1.0.0"] }] }
test("license policy refuses outage and unknown expressions", () => {
  assert.equal(validateLicenseInventory(inventory, policy).ok, true)
  for (const bad of [{}, { error: "registry unavailable" }, { UNKNOWN: inventory.MIT }])
    assert.throws(() => validateLicenseInventory(bad, policy))
})
test("license exceptions bind exact package, version, expression and expiry", () => {
  const inventory = { CUSTOM: [{ name: "fixture", versions: ["1.0.0"] }] }
  const p = {
    ...policy,
    exceptions: [
      {
        name: "fixture",
        version: "1.0.0",
        license: "CUSTOM",
        reason: "Reviewed fixture",
        approvedBy: "fixture-review",
        expiresAt: "2030-01-01"
      }
    ]
  }
  assert.equal(validateLicenseInventory(inventory, p, 0).ok, true)
  assert.throws(() => validateLicenseInventory(inventory, p, Date.parse("2031-01-01")))
  assert.throws(() => validateLicenseInventory({ CUSTOM: [{ name: "fixture", versions: ["2.0.0"] }] }, p, 0))
})
