import { expect, it } from "vitest"
import {
  artifactScopesOverlap,
  normalizeArtifactScope,
  normalizeArtifactScopes
} from "../packages/domain/src/artifact-scopes.js"
import { nativePathAllowed } from "../packages/domain/src/native-autonomy.js"

const reserved = "apps/reports-ui/e2e/ui-audit*"
it.each([
  ["apps/reports-ui/e2e/navigation.spec.ts", false],
  ["apps/reports-ui/e2e/utils/auth.ts", false],
  ["apps/reports-ui/e2e/ui-audit.ts", true],
  ["apps/reports-ui/e2e/ui-audit-scan.spec.ts", true],
  ["apps/reports-ui/e2e/ui-audit", true],
  ["apps/reports-ui/e2e/ui-audit/nested.ts", true],
  ["apps/reports-ui/e2e", true],
  ["apps/reports-ui", true],
  [".", true],
  ["apps/reports-ui/e2e/navigation*", true]
])("compares the reserved prefix symmetrically against %s", (other, overlap) => {
  expect(artifactScopesOverlap(reserved, String(other))).toBe(overlap)
  expect(artifactScopesOverlap(String(other), reserved)).toBe(overlap)
})

it.each([
  "apps/reports-ui/e2e/*",
  "apps/reports-ui/e2e/**",
  "apps/reports-ui/e2e/ui-*audit",
  "apps/reports-ui/e2e/ui-audit?.ts",
  "apps/reports-ui/e2e/ui-audit[ab].ts",
  "apps/reports-ui/e2e/ui-audit{a,b}.ts",
  "../apps/reports-ui/e2e/ui-audit*",
  "/apps/reports-ui/e2e/ui-audit*",
  "apps/reports-ui/e2e/./ui-audit*",
  "apps/reports-ui/e2e//ui-audit*",
  "apps/reports-ui/e2e/folder/../ui-audit*",
  " apps/reports-ui/e2e/ui-audit*",
  String.raw`apps\reports-ui\e2e\ui-audit*`
])("preserves conservative treatment for unsupported or noncanonical pattern %s", (pattern) => {
  expect(artifactScopesOverlap(pattern, "apps/reports-ui/e2e/navigation.spec.ts")).toBe(true)
  expect(artifactScopesOverlap("apps/reports-ui/e2e/navigation.spec.ts", pattern)).toBe(true)
})

it("keeps every actually authorized file reserved and never renormalizes persisted locks", () => {
  for (const suffix of ["", ".ts", "-scan.spec.ts", "a", "123", ".hidden"]) {
    const path = `apps/reports-ui/e2e/ui-audit${suffix}`
    expect(nativePathAllowed(path, reserved)).toBe(true)
    expect(artifactScopesOverlap(path, reserved)).toBe(true)
  }
  expect(normalizeArtifactScope(reserved)).toBe("apps/reports-ui/e2e")
  expect(normalizeArtifactScopes([reserved])).toEqual(["apps/reports-ui/e2e"])
  expect(artifactScopesOverlap(normalizeArtifactScope(reserved), "apps/reports-ui/e2e/navigation.spec.ts")).toBe(true)
})

it.each([
  "src/@(ui-audit)*",
  "src/+(ui-audit)*",
  "src/!(other)*"
])("preserves actual extglob matches for %s", (pattern) => {
  const file = "src/ui-audit-scan.ts"
  expect(nativePathAllowed(file, pattern)).toBe(true)
  expect(artifactScopesOverlap(pattern, file)).toBe(true)
  expect(artifactScopesOverlap(file, pattern)).toBe(true)
})

it.each([
  " apps/reports-ui/e2e/ui-audit-scan.spec.ts",
  "apps/reports-ui/e2e/ui-audit-scan.spec.ts ",
  " . "
])("preserves normalized matching or global plain scope %s", (plain) => {
  expect(artifactScopesOverlap(reserved, plain)).toBe(true)
  expect(artifactScopesOverlap(plain, reserved)).toBe(true)
})
