import type { BudgetWindowKind } from "./types.js"

export type BudgetPressure = "ok" | "warning" | "blocked" | "unlimited"

export interface BudgetPressureInput {
  limit: number | null
  usage: number
  runCount?: number | undefined
  window: BudgetWindowKind
  warningRatio?: number | undefined
  hardStopRatio?: number | undefined
}

export interface BudgetPressureResult {
  pressure: BudgetPressure
  limit: number | null
  usage: number
  remaining: number | null
  ratio: number | null
  blocked: boolean
  reason: string
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

export function evaluateBudgetPressure(input: BudgetPressureInput): BudgetPressureResult {
  const usage = finiteNonNegative(input.usage)
  const limit = input.limit != null && Number.isFinite(input.limit) ? Math.max(0, input.limit) : null
  if (limit == null) {
    return {
      pressure: "unlimited",
      limit,
      usage,
      remaining: null,
      ratio: null,
      blocked: false,
      reason: `No ${input.window} budget limit is configured.`
    }
  }

  const ratio = limit === 0 ? 1 : usage / limit
  const remaining = Math.max(0, limit - usage)
  const warningRatio = input.warningRatio ?? 0.8
  const hardStopRatio = input.hardStopRatio ?? 1

  if (ratio >= hardStopRatio) {
    return {
      pressure: "blocked",
      limit,
      usage,
      remaining,
      ratio,
      blocked: true,
      reason: `${input.window} budget exhausted (${usage}/${limit}).`
    }
  }

  if (ratio >= warningRatio) {
    return {
      pressure: "warning",
      limit,
      usage,
      remaining,
      ratio,
      blocked: false,
      reason: `${input.window} budget is under pressure (${usage}/${limit}).`
    }
  }

  return {
    pressure: "ok",
    limit,
    usage,
    remaining,
    ratio,
    blocked: false,
    reason: `${input.window} budget has ${remaining} units remaining.`
  }
}

function readEnv(env: Record<string, string | undefined>, key: string): string | null {
  const value = env[key]
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null
}

export function inferOpenAiCompatibleBiller(
  env: Record<string, string | undefined>,
  fallback: string | null = "openai"
): string | null {
  if (readEnv(env, "OPENROUTER_API_KEY")) return "openrouter"

  const baseUrl =
    readEnv(env, "OPENAI_BASE_URL") ?? readEnv(env, "OPENAI_API_BASE") ?? readEnv(env, "OPENAI_API_BASE_URL")
  if (baseUrl && /openrouter\.ai/i.test(baseUrl)) return "openrouter"

  return fallback
}
