// Explicit evidence schema: controlled fixtures never count as live rollout proof.
export interface NativeCanaryReport {
  version: 1
  kind: "native-canary"
  evidenceKind: "controlled-fixture" | "live"
  environment: "disposable" | "staging"
  passed: boolean
  scopeDigest: string
  metadata: {
    benchmarkVersion: string
    datasetDigest: string
    skillPolicyDigest?: string
    policyDigest: string
    skillDigest: string
    model: string
    toolchain: Record<string, string>
    budgets: { maxAttempts: number; maxCommands: number; timeoutSeconds: number }
    costCents: number | null
  }
  scenarios: Array<{ id: string; passed: boolean; actual: string[]; mocked: string[]; failure?: string }>
  observations: { windowSeconds: number; regressions: number; rollbacks: number; interventions: number }
  recordedAt: number
}
export function validateNativeCanaryReport(value: unknown): NativeCanaryReport {
  const r = value as NativeCanaryReport
  if (
    !r ||
    r.version !== 1 ||
    r.kind !== "native-canary" ||
    !["controlled-fixture", "live"].includes(r.evidenceKind) ||
    !["disposable", "staging"].includes(r.environment) ||
    typeof r.passed !== "boolean" ||
    !/^[a-f0-9]{64}$/.test(r.scopeDigest) ||
    !r.metadata?.benchmarkVersion ||
    !/^[a-f0-9]{64}$/.test(r.metadata.datasetDigest) ||
    !/^[a-f0-9]{64}$/.test(r.metadata.policyDigest) ||
    !/^[a-f0-9]{64}$/.test(r.metadata.skillDigest) ||
    !r.metadata.model ||
    !r.metadata.toolchain?.node ||
    Object.values(r.metadata.toolchain).some((v) => typeof v !== "string" || !v) ||
    !r.metadata.budgets ||
    !Number.isSafeInteger(r.metadata.budgets.maxAttempts) ||
    r.metadata.budgets.maxAttempts < 1 ||
    !Number.isSafeInteger(r.metadata.budgets.maxCommands) ||
    r.metadata.budgets.maxCommands < 1 ||
    !Number.isSafeInteger(r.metadata.budgets.timeoutSeconds) ||
    r.metadata.budgets.timeoutSeconds < 1 ||
    (r.metadata.costCents !== null && (!Number.isFinite(r.metadata.costCents) || r.metadata.costCents < 0)) ||
    !Array.isArray(r.scenarios) ||
    !r.scenarios.length ||
    r.scenarios.some(
      (s) =>
        !s?.id ||
        typeof s.passed !== "boolean" ||
        !Array.isArray(s.actual) ||
        !Array.isArray(s.mocked) ||
        [...s.actual, ...s.mocked].some((v) => typeof v !== "string")
    ) ||
    !r.observations ||
    [
      r.observations.windowSeconds,
      r.observations.regressions,
      r.observations.rollbacks,
      r.observations.interventions
    ].some((n) => !Number.isFinite(n) || n < 0) ||
    !Number.isFinite(r.recordedAt)
  )
    throw new Error("Invalid native canary evidence")
  if (r.passed && (r.scenarios.some((s) => !s.passed) || r.observations.regressions > 0))
    throw new Error("Canary success contradicts recorded outcomes")
  if (r.evidenceKind === "live" && (r.environment !== "staging" || r.scenarios.some((s) => s.mocked.length > 0)))
    throw new Error("Mocked evidence cannot claim live canary success")
  return r
}
