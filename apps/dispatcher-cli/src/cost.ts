import { LOOP_PATTERNS, type LoopPattern, type LoopPatternCost } from "@openclaw/domain"

export type ReadinessLevel = "L1" | "L2" | "L3"

export interface EstimateResult {
  patternId: string
  patternName: string
  cadence: string
  level: ReadinessLevel
  runsPerDay: number
  tokenCostTier: string
  suggestedDailyCap: number
  earlyExitRequired: boolean
  scenarios: {
    noop: { tokensPerRun: number; tokensPerDay: number }
    report: { tokensPerRun: number; tokensPerDay: number }
    action: { tokensPerRun: number; tokensPerDay: number }
    realistic: { tokensPerRun: number; tokensPerDay: number; assumptions: string }
  }
  warnings: string[]
}

const INTERVAL_MS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000
}

export function parseInterval(token: string): number {
  const m = token.match(/^(\d+)([mhd])$/)
  if (!m) throw new Error(`Invalid cadence interval: ${token}`)
  const unit = m[2]
  if (!unit) throw new Error(`Invalid cadence interval format: ${token}`)
  const multiplier = INTERVAL_MS[unit]
  if (multiplier === undefined) throw new Error(`Invalid cadence unit: ${unit}`)
  return Number(m[1]) * multiplier
}

export function runsPerDayForInterval(interval: string): number {
  const ms = parseInterval(interval)
  return Math.floor(86_400_000 / ms)
}

export function cadenceToRunsPerDay(cadence: string, conservative = false): number {
  const parts = cadence.split("-").map((p) => p.trim())
  const firstPart = parts[0]
  if (!firstPart) throw new Error("Empty cadence")
  if (parts.length === 1) return runsPerDayForInterval(firstPart)

  const runs = parts.map(runsPerDayForInterval)
  return conservative ? Math.min(...runs) : Math.max(...runs)
}

function realisticMix(
  level: ReadinessLevel,
  earlyExitRequired: boolean
): {
  noop: number
  report: number
  action: number
  assumptions: string
} {
  if (level === "L1") {
    return {
      noop: earlyExitRequired ? 0.9 : 0.6,
      report: earlyExitRequired ? 0.1 : 0.4,
      action: 0,
      assumptions: earlyExitRequired ? "L1: 90% early-exit, 10% full triage" : "L1: 60% no-op, 40% full triage"
    }
  }
  if (level === "L2") {
    return {
      noop: earlyExitRequired ? 0.85 : 0.5,
      report: earlyExitRequired ? 0.1 : 0.3,
      action: earlyExitRequired ? 0.05 : 0.2,
      assumptions: earlyExitRequired
        ? "L2: 85% early-exit, 10% triage, 5% implementer+verifier"
        : "L2: 50% no-op, 30% triage, 20% action"
    }
  }
  return {
    noop: 0.4,
    report: 0.35,
    action: 0.25,
    assumptions: "L3: 40% no-op, 35% triage, 25% action (unattended — monitor closely)"
  }
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

export function estimateCost(pattern: LoopPattern, level: ReadinessLevel, overrideCadence?: string): EstimateResult {
  const cadence = overrideCadence ?? pattern.cadence
  const runsPerDay = cadenceToRunsPerDay(cadence)
  const { cost, token_cost: tokenCostTier } = pattern
  const mix = realisticMix(level, cost.early_exit_required)

  const noopDay = cost.tokens_noop * runsPerDay
  const reportDay = cost.tokens_report * runsPerDay
  const actionDay = cost.tokens_action * runsPerDay

  const realisticPerRun =
    cost.tokens_noop * mix.noop + cost.tokens_report * mix.report + cost.tokens_action * mix.action
  const realisticDay = Math.round(realisticPerRun * runsPerDay)

  const warnings: string[] = []
  if (cost.early_exit_required) {
    warnings.push("Early-exit triage is required — empty watchlist should exit in <5k tokens.")
  }
  if (actionDay > cost.suggested_daily_cap) {
    warnings.push(
      `Worst case (action every run) exceeds suggested cap (${formatTokens(cost.suggested_daily_cap)}/day).`
    )
  }
  if (realisticDay > cost.suggested_daily_cap) {
    warnings.push("Realistic estimate exceeds suggested daily cap — slow cadence or tighten scope.")
  }
  if (runsPerDay >= 96) {
    warnings.push(`High cadence (${runsPerDay} runs/day) — verify early-exit is working.`)
  }

  return {
    patternId: pattern.id,
    patternName: pattern.name,
    cadence,
    level,
    runsPerDay,
    tokenCostTier,
    suggestedDailyCap: cost.suggested_daily_cap,
    earlyExitRequired: cost.early_exit_required,
    scenarios: {
      noop: { tokensPerRun: cost.tokens_noop, tokensPerDay: noopDay },
      report: { tokensPerRun: cost.tokens_report, tokensPerDay: reportDay },
      action: { tokensPerRun: cost.tokens_action, tokensPerDay: actionDay },
      realistic: {
        tokensPerRun: Math.round(realisticPerRun),
        tokensPerDay: realisticDay,
        assumptions: mix.assumptions
      }
    },
    warnings
  }
}

export function renderCostReport(r: EstimateResult): string[] {
  const lines: string[] = [
    `Loop Cost Estimate — ${r.patternName} (${r.patternId})`,
    "==================================================",
    `Cadence: ${r.cadence}  ->  ${r.runsPerDay} runs/day`,
    `Level: ${r.level}  .  Registry tier: ${r.tokenCostTier}`,
    `Suggested daily cap: ${formatTokens(r.suggestedDailyCap)} tokens`,
    "",
    "Daily token estimates:",
    `  Early-exit / no-op:  ${formatTokens(r.scenarios.noop.tokensPerDay)}  (${formatTokens(r.scenarios.noop.tokensPerRun)}/run)`,
    `  Full triage:         ${formatTokens(r.scenarios.report.tokensPerDay)}  (${formatTokens(r.scenarios.report.tokensPerRun)}/run)`,
    `  Action every run:    ${formatTokens(r.scenarios.action.tokensPerDay)}  (${formatTokens(r.scenarios.action.tokensPerRun)}/run)`,
    `  Realistic blend:     ${formatTokens(r.scenarios.realistic.tokensPerDay)}  (${r.scenarios.realistic.assumptions})`,
    ""
  ]

  if (r.warnings.length > 0) {
    lines.push("Warnings:")
    for (const w of r.warnings) {
      lines.push(`  ! ${w}`)
    }
    lines.push("")
  }

  lines.push("Docs: docs/loop-ideas-import.md")
  return lines
}
