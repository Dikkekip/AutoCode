// Synthetic mode-policy fixtures. They do not establish a live canary or operator approval.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import {
  assertNativeMode,
  assertNativePromotion,
  type NativeModeAction,
  nativeCanaryScopeDigest,
  nativePromotionDigest
} from "../packages/core-runtime/src/native/promotion-mode.js"
import { nativeContentDigest } from "../packages/core-runtime/src/native/provenance.js"
import { type NativePromotionMode, validateNativeAutonomyPolicy } from "../packages/domain/src/native-autonomy.js"

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function fixture(mode?: NativePromotionMode) {
  const root = mkdtempSync(join(tmpdir(), "native-mode-"))
  dirs.push(root)
  return validateNativeAutonomyPolicy({
    version: 1,
    ...(mode ? { mode } : {}),
    enabled: true,
    repository: root,
    repositoryKind: "application",
    boardId: "b",
    baseBranch: "main",
    plannerAgentId: "planner",
    coderAgentId: "coder",
    reviewerAgentId: "reviewer",
    personas: [{ personaId: "research", goals: ["g"], successObservations: ["s"], allowedPaths: ["src"], weight: 1 }],
    verification: [{ id: "check", argv: ["/opt/openclaw/checks/test"], cwd: "." }],
    budgets: {
      version: 1,
      limits: { project: { actions: 10 }, day: { actions: 10 }, workflow: { actions: 10 }, attempt: { actions: 10 } },
      safetyReserve: { actions: 1 },
      unknownUsage: "hold"
    },
    deployment: {
      environment: "staging",
      command: { argv: ["deploy"], cwd: "." },
      check: { argv: ["health"], cwd: "." }
    }
  })
}
it.each([
  "observe",
  "propose",
  "implement-human-review",
  "staging-canary",
  "application-release"
] as const)("enforces the complete %s action boundary", (mode) => {
  const p = fixture(mode),
    level = ["observe", "propose", "implement-human-review", "staging-canary", "application-release"].indexOf(mode)
  const actions: Record<NativeModeAction, number> = {
    inspect: 0,
    investigate: 1,
    propose: 1,
    implement: 2,
    verify: 2,
    review: 2,
    release: 3,
    deploy: 3,
    rollback: 3
  }
  for (const [action, required] of Object.entries(actions)) {
    if (level >= required) expect(() => assertNativeMode(p, action as NativeModeAction)).not.toThrow()
    else expect(() => assertNativeMode(p, action as NativeModeAction)).toThrow("does not authorize")
  }
})
it("defaults legacy policy to observe and never infers promotion from task count", () => {
  const p = fixture()
  expect(p.mode).toBe("observe")
  expect(() => assertNativeMode(p, "investigate")).toThrow()
  p.mode = "staging-canary"
  expect(() => assertNativePromotion(p)).toThrow("operator")
})
it("binds scoped operator approval and refuses controlled evidence for production", () => {
  const p = fixture("staging-canary"),
    path = join(p.repository, "canary.json"),
    time = Date.now()
  const report = {
    version: 1,
    kind: "native-canary",
    evidenceKind: "controlled-fixture",
    environment: "disposable",
    passed: true,
    scopeDigest: nativeCanaryScopeDigest(p),
    metadata: {
      benchmarkVersion: "synthetic-contract-v1",
      datasetDigest: "a".repeat(64),
      policyDigest: nativePromotionDigest(p),
      skillDigest: "b".repeat(64),
      model: "deterministic-fixture",
      toolchain: { node: process.version },
      budgets: { maxAttempts: 1, maxCommands: 1, timeoutSeconds: 30 },
      costCents: null
    },
    scenarios: [{ id: "synthetic-prerequisite", passed: true, actual: ["policy validation"], mocked: ["rollout"] }],
    observations: { windowSeconds: 0, regressions: 0, rollbacks: 0, interventions: 0 },
    recordedAt: time
  }
  const raw = JSON.stringify(report)
  writeFileSync(path, raw)
  p.promotion = {
    approvedBy: "fixture-operator",
    approvedAt: time,
    policyDigest: nativePromotionDigest(p),
    canaryArtifact: { path, sha256: nativeContentDigest(raw) }
  }
  expect(() => assertNativePromotion(p)).not.toThrow()
  p.workerConcurrency = 2
  expect(() => assertNativePromotion(p)).toThrow("current independent")
  p.workerConcurrency = 1
  p.mode = "application-release"
  p.deployment!.environment = "production"
  p.promotion.policyDigest = nativePromotionDigest(p)
  expect(() => assertNativePromotion(p)).toThrow("live staging evidence")
})
