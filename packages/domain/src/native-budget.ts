/** Native budget policy; amounts remain unknown until measured or conservatively reserved. */
export type NativeBudgetUnit = "timeMs" | "tokens" | "currency" | "actions"
export type NativeBudgetAmount = Partial<Record<NativeBudgetUnit, number>>
export interface NativeBudgetPolicy {
  version: 1
  limits: {
    project: NativeBudgetAmount
    day: NativeBudgetAmount
    workflow: NativeBudgetAmount
    attempt: NativeBudgetAmount
  }
  safetyReserve: NativeBudgetAmount
  unknownUsage: "hold" | "deny"
  estimates?: Record<string, NativeBudgetAmount>
}
const units: NativeBudgetUnit[] = ["timeMs", "tokens", "currency", "actions"]
export function validateNativeBudgetAmount(value: NativeBudgetAmount) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !units.includes(key as NativeBudgetUnit))
  )
    throw new Error("Invalid native budget units")
  for (const unit of units)
    if (
      value[unit] !== undefined &&
      (!Number.isFinite(value[unit]) || value[unit]! < 0 || (unit !== "currency" && !Number.isSafeInteger(value[unit])))
    )
      throw new Error("Native budget amounts must be finite nonnegative limits")
}
export function validateNativeBudgetPolicy(policy: NativeBudgetPolicy) {
  if (policy?.version !== 1 || !["hold", "deny"].includes(policy.unknownUsage))
    throw new Error("Reviewed native budget policy required")
  for (const scope of ["project", "day", "workflow", "attempt"] as const) {
    validateNativeBudgetAmount(policy.limits?.[scope])
    if (!Object.keys(policy.limits[scope]).length) throw new Error("Every native budget scope requires a limit")
  }
  validateNativeBudgetAmount(policy.safetyReserve)
  for (const value of Object.values(policy.estimates ?? {})) validateNativeBudgetAmount(value)
  return structuredClone(policy)
}
