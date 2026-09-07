import { execFile } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { promisify } from "node:util"

import type { DispatcherStore } from "@openclaw/db"
import {
  type AdapterType,
  type Agent,
  type BudgetStatus,
  readCodexQuotaOverview,
  type TaskStatus
} from "@openclaw/domain"
import type { ProjectProfile } from "@openclaw/project-profiles"

type DigestKind = "daily" | "incident"

type RecentTaskSummary = {
  id: string
  title: string
  completedAt: string
}

type FailureReasonSummary = {
  reason: string
  count: number
}

type QueueStatusSummary = Partial<Record<TaskStatus, number>>

type UsageSummary = {
  adapterType: AdapterType | "unknown"
  model: string
  runs: number
  succeeded: number
  failed: number
  totalTokens: number
  totalCostCents: number
}

type RecoverySummary = {
  label: string
  count: number
}

type PressureSignal = {
  severity: "warn" | "critical"
  summary: string
}

export interface OperationalDigestSummary {
  projectId: string
  projectName: string
  repoPath: string
  generatedAt: string
  windowHours: number
  tasksCompleted: number
  tasksFailed: number
  recentCompletedTasks: RecentTaskSummary[]
  recentFailedTasks: RecentTaskSummary[]
  topFailureReasons: FailureReasonSummary[]
  activeQueuesByStatus: QueueStatusSummary
  stuckQueuesByStatus: QueueStatusSummary
  modelUsage: UsageSummary[]
  pressureSignals: PressureSignal[]
  notableRecoveries: RecoverySummary[]
}

type NotificationConfig = {
  enabled: boolean
  channel: "telegram" | "stdout" | "none"
  target: string | null
  disableNotification: boolean
}

export interface DigestPreview {
  kind: DigestKind
  message: string
  summary: OperationalDigestSummary
}

export interface TelegramDeliveryResult extends DigestPreview {
  delivery: "sent" | "dry-run" | "skipped" | "failed-soft"
  resultSummary: string
}

type TelegramTransport = typeof fetch
type OpenClawMessageTransport = (
  command: string,
  args: string[],
  options: { encoding: "utf8"; timeout: number; maxBuffer: number }
) => Promise<{ stdout?: string; stderr?: string }>

const execFileAsync = promisify(execFile) as OpenClawMessageTransport

type SendDigestInput = {
  store: DispatcherStore
  projectRef: string
  profile: ProjectProfile
  kind: DigestKind
  dryRun?: boolean
  windowHours?: number
  fetchImpl?: TelegramTransport
  openClawExecImpl?: OpenClawMessageTransport
}

type IncidentFormatterOptions = {
  title?: string
}

const ACTIVE_QUEUE_STATUSES: TaskStatus[] = ["queued", "running", "review_needed", "promotion_pending", "blocked"]

const RECOVERY_LABELS: Record<string, string> = {
  "stale-run-reaped": "stale runs reaped",
  "lease-expired": "expired claims reclaimed",
  maintenance: "stale runs recovered",
  "duplicate-workflow-recovered": "duplicate workflows pruned"
}

function safeJsonParse<T>(value: unknown): T | null {
  if (typeof value !== "string" || value.trim() === "") return null
  try {
    return JSON.parse(value) as T
  } catch {
    return null
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0] ?? value
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

function ellipsize(value: string, max = 96): string {
  if (value.length <= max) return value
  return `${value.slice(0, Math.max(0, max - 3)).trimEnd()}...`
}

function sanitizeReason(value: string | null | undefined): string {
  const base = compactWhitespace(firstLine(value ?? "unknown failure"))
  return ellipsize(base.replace(/https?:\/\/\S+/gi, "[url]"), 88) || "unknown failure"
}

function formatTaskList(tasks: RecentTaskSummary[], total: number): string {
  if (tasks.length === 0) {
    return total === 0 ? "none" : `${total}`
  }
  const titles = tasks.map((task) => ellipsize(task.title, 44))
  if (total > tasks.length) {
    titles.push(`+${total - tasks.length} more`)
  }
  return titles.join("; ")
}

function formatReasonList(reasons: FailureReasonSummary[]): string {
  if (reasons.length === 0) return "none"
  return reasons.map((entry) => `${entry.reason} x${entry.count}`).join("; ")
}

function formatQueueStatus(counts: QueueStatusSummary): string {
  const parts = ACTIVE_QUEUE_STATUSES.map((status) => {
    const count = counts[status] ?? 0
    return count > 0 ? `${status} ${count}` : null
  }).filter((value): value is string => Boolean(value))
  return parts.length > 0 ? parts.join(", ") : "idle"
}

function formatUsageRows(rows: UsageSummary[]): string {
  if (rows.length === 0) return "none"
  return rows
    .map((row) => {
      const tokenSummary = row.totalTokens > 0 ? ` ${Math.round(row.totalTokens / 1000)}k tok` : ""
      const failSuffix = row.failed > 0 ? `, ${row.failed} failed` : ""
      return `${row.adapterType}/${row.model} ${row.runs}r${tokenSummary}${failSuffix}`
    })
    .join("; ")
}

function formatPressureSignals(signals: PressureSignal[]): string {
  if (signals.length === 0) return "nominal"
  return signals.map((signal) => signal.summary).join("; ")
}

function formatRecoveries(recoveries: RecoverySummary[]): string {
  if (recoveries.length === 0) return "none"
  return recoveries.map((entry) => `${entry.label} x${entry.count}`).join("; ")
}

function defaultModelForAdapter(adapterType: AdapterType | "unknown"): string {
  switch (adapterType) {
    case "codex_local":
      return "codex-default"
    case "gemini_local":
      return "gemini-default"
    case "azure_foundry":
      return "azure-default"
    default:
      return "unknown"
  }
}

function hoursSince(iso: string | null | undefined, now = new Date()): number {
  if (!iso) return 0
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return 0
  return (now.getTime() - parsed.getTime()) / (60 * 60 * 1000)
}

function summarizeBudgetPressure(statuses: BudgetStatus[]): PressureSignal[] {
  const signals: PressureSignal[] = []

  for (const status of statuses) {
    if (status.agent.budgetLimit === null) continue
    const ratio = status.agent.budgetLimit <= 0 ? 1 : status.usageUnits / status.agent.budgetLimit
    if (status.blocked) {
      signals.push({
        severity: "critical",
        summary: `${status.agent.name} budget blocked (${status.usageUnits}/${status.agent.budgetLimit} ${status.agent.budgetWindow})`
      })
      continue
    }
    if (ratio >= 0.8) {
      signals.push({
        severity: "warn",
        summary: `${status.agent.name} budget ${status.usageUnits}/${status.agent.budgetLimit} ${status.agent.budgetWindow}`
      })
    }
  }

  return signals
}

function summarizeCodexQuotaPressure(): PressureSignal[] {
  const quota = readCodexQuotaOverview()
  if (quota.accounts.length === 0) return []
  if (quota.assessment === "ok" && (quota.recommendedMaxConcurrentCodexRuns ?? 2) > 1) {
    return []
  }

  const severity = quota.assessment === "blocked" ? "critical" : "warn"
  return [
    {
      severity,
      summary: `Codex quota ${quota.assessment} (${quota.healthyAccounts}/${quota.availableAccounts} healthy, recommended parallel ${quota.recommendedMaxConcurrentCodexRuns ?? "unknown"})`
    }
  ]
}

function notificationConfigPathCandidates(repoPath: string): string[] {
  return [
    join(repoPath, ".openclaw", "state", "current", "notification_config.json"),
    join(repoPath, ".openclaw", "state", "bootstrap", "notification_config.json")
  ]
}

function resolveNotificationConfig(repoPath: string, profile: ProjectProfile, kind: DigestKind): NotificationConfig {
  let fileConfig: Record<string, unknown> | null = null

  for (const path of notificationConfigPathCandidates(repoPath)) {
    if (!existsSync(path)) continue
    fileConfig = safeJsonParse<Record<string, unknown>>(readFileSync(path, "utf8"))
    if (fileConfig) break
  }

  const enabled = fileConfig?.enabled === false ? false : true
  const channelValue = typeof fileConfig?.channel === "string" ? fileConfig.channel : profile.notificationPolicy.channel
  const channel =
    channelValue === "telegram" || channelValue === "stdout" || channelValue === "none" ? channelValue : "none"
  const explicitTarget =
    typeof fileConfig?.target === "string" && fileConfig.target !== "SET_ME"
      ? fileConfig.target
      : (profile.notificationPolicy.target ?? null)
  const targetEnv =
    typeof fileConfig?.target_env === "string"
      ? fileConfig.target_env
      : typeof fileConfig?.targetEnv === "string"
        ? fileConfig.targetEnv
        : (profile.notificationPolicy.targetEnv ?? null)
  const target = explicitTarget ?? (targetEnv ? (process.env[targetEnv] ?? null) : null)
  const defaultDelivery = typeof fileConfig?.defaultDelivery === "string" ? fileConfig.defaultDelivery : null

  return {
    enabled,
    channel,
    target,
    disableNotification: kind === "daily" ? defaultDelivery === "silent" : false
  }
}

function selectRecentTasks(
  rows: Array<{ id: string; title: string; completedAt: string }>,
  limit = 3
): RecentTaskSummary[] {
  return rows.sort((left, right) => right.completedAt.localeCompare(left.completedAt)).slice(0, limit)
}

function collectRunModelHints(store: DispatcherStore, runIds: string[]): Map<string, string> {
  const modelByRunId = new Map<string, string>()
  if (runIds.length === 0) return modelByRunId

  const placeholders = runIds.map(() => "?").join(", ")
  const rows = store.db
    .prepare(
      `SELECT run_id, data_json, created_at FROM run_events WHERE run_id IN (${placeholders}) ORDER BY created_at DESC`
    )
    .all(...runIds) as Array<Record<string, unknown>>

  for (const row of rows) {
    const runId = typeof row.run_id === "string" ? row.run_id : null
    if (!runId || modelByRunId.has(runId)) continue
    const data = safeJsonParse<Record<string, unknown>>(row.data_json)
    if (!data || typeof data !== "object") continue
    const adapterMetadata =
      data.adapterMetadata && typeof data.adapterMetadata === "object"
        ? (data.adapterMetadata as Record<string, unknown>)
        : null
    const runtimeIdentity =
      data.runtimeIdentity && typeof data.runtimeIdentity === "object"
        ? (data.runtimeIdentity as Record<string, unknown>)
        : null
    const model =
      (typeof adapterMetadata?.model === "string" && adapterMetadata.model) ||
      (typeof runtimeIdentity?.model === "string" && runtimeIdentity.model) ||
      null
    if (model) {
      modelByRunId.set(runId, model)
    }
  }

  return modelByRunId
}

export function collectOperationalDigestSummary(
  store: DispatcherStore,
  projectRef: string,
  options: { windowHours?: number; now?: Date } = {}
): OperationalDigestSummary {
  const project = store.resolveProject(projectRef)
  const company = store.resolveCompany(project.companyId)
  const now = options.now ?? new Date()
  const windowHours = clamp(options.windowHours ?? 24, 1, 7 * 24)
  const sinceIso = new Date(now.getTime() - windowHours * 60 * 60 * 1000).toISOString()

  const tasks = store.listTasks(company.id).filter((task) => task.projectId === project.id)
  const completedTasks = tasks
    .filter((task) => task.status === "done" && task.completedAt && task.completedAt >= sinceIso)
    .map((task) => ({ id: task.id, title: task.title, completedAt: task.completedAt! }))
  const failedTasks = tasks
    .filter((task) => task.status === "failed" && task.completedAt && task.completedAt >= sinceIso)
    .map((task) => ({ id: task.id, title: task.title, completedAt: task.completedAt! }))

  const topFailureReasons = Array.from(
    tasks
      .filter((task) => task.status === "failed" && task.completedAt && task.completedAt >= sinceIso)
      .reduce((acc, task) => {
        const reason = sanitizeReason(task.lastError ?? task.blockedReason)
        acc.set(reason, (acc.get(reason) ?? 0) + 1)
        return acc
      }, new Map<string, number>())
      .entries()
  )
    .map(([reason, count]) => ({ reason, count }))
    .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason))
    .slice(0, 3)

  const activeQueuesByStatus = ACTIVE_QUEUE_STATUSES.reduce<QueueStatusSummary>((acc, status) => {
    const count = tasks.filter((task) => task.status === status).length
    if (count > 0) acc[status] = count
    return acc
  }, {})

  const stuckQueuesByStatus = ACTIVE_QUEUE_STATUSES.reduce<QueueStatusSummary>((acc, status) => {
    const count = tasks.filter((task) => {
      if (task.status !== status) return false
      const ageHours =
        status === "running"
          ? hoursSince(task.claimedAt ?? task.updatedAt, now)
          : hoursSince(task.updatedAt ?? task.createdAt, now)
      const threshold = status === "running" ? 2 : status === "queued" ? 6 : 4
      return ageHours >= threshold
    }).length
    if (count > 0) acc[status] = count
    return acc
  }, {})

  const runRows = store.db
    .prepare(
      `
      SELECT id, agent_id, adapter_type, status, usage_json, cost_cents
      FROM runs
      WHERE project_id = ? AND created_at >= ?
      ORDER BY created_at DESC
      `
    )
    .all(project.id, sinceIso) as Array<Record<string, unknown>>

  const agentsById = new Map<string, Agent>(store.listAgents(company.id).map((agent) => [agent.id, agent]))
  const runModelHints = collectRunModelHints(
    store,
    runRows.map((row) => String(row.id))
  )

  const usageMap = new Map<string, UsageSummary>()
  for (const row of runRows) {
    const runId = String(row.id)
    const agentId = typeof row.agent_id === "string" ? row.agent_id : null
    const agent = agentId ? (agentsById.get(agentId) ?? null) : null
    const adapterTypeRaw = typeof row.adapter_type === "string" ? row.adapter_type : (agent?.adapterType ?? "unknown")
    const adapterType =
      adapterTypeRaw === "codex_local" || adapterTypeRaw === "gemini_local" || adapterTypeRaw === "azure_foundry"
        ? adapterTypeRaw
        : "unknown"
    const model = runModelHints.get(runId) ?? agent?.model ?? defaultModelForAdapter(adapterType)
    const key = `${adapterType}:${model}`
    const current = usageMap.get(key) ?? {
      adapterType,
      model,
      runs: 0,
      succeeded: 0,
      failed: 0,
      totalTokens: 0,
      totalCostCents: 0
    }
    current.runs += 1
    if (row.status === "succeeded") current.succeeded += 1
    if (row.status === "failed") current.failed += 1
    const usage = safeJsonParse<{ totalTokens?: number }>(row.usage_json)
    if (typeof usage?.totalTokens === "number" && Number.isFinite(usage.totalTokens)) {
      current.totalTokens += usage.totalTokens
    }
    if (typeof row.cost_cents === "number" && Number.isFinite(row.cost_cents)) {
      current.totalCostCents += row.cost_cents
    }
    usageMap.set(key, current)
  }

  const recoveryRows = store.db
    .prepare(
      `
      SELECT task_events.kind
      FROM task_events
      JOIN tasks ON tasks.id = task_events.task_id
      WHERE tasks.project_id = ? AND task_events.created_at >= ?
      ORDER BY task_events.created_at DESC
      `
    )
    .all(project.id, sinceIso) as Array<Record<string, unknown>>

  const recoveryCounts = new Map<string, number>()
  for (const row of recoveryRows) {
    const kind = typeof row.kind === "string" ? row.kind : null
    const label = kind ? RECOVERY_LABELS[kind] : null
    if (!label) continue
    recoveryCounts.set(label, (recoveryCounts.get(label) ?? 0) + 1)
  }

  const recoverySignals = Array.from(recoveryCounts.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label))
    .slice(0, 3)

  const relevantAgentIds = new Set<string>([
    ...tasks.map((task) => task.assignedAgentId).filter((value): value is string => Boolean(value)),
    ...runRows
      .map((row) => (typeof row.agent_id === "string" ? row.agent_id : null))
      .filter((value): value is string => Boolean(value))
  ])
  const budgetSignals = summarizeBudgetPressure(
    store
      .getBudgetStatuses(company.id)
      .filter((status) => relevantAgentIds.has(status.agent.id) || status.blocked || status.usageUnits > 0)
  )
  const quotaSignals = summarizeCodexQuotaPressure()
  const queuePressureSignals: PressureSignal[] = []
  if (
    (stuckQueuesByStatus.queued ?? 0) > 0 ||
    (stuckQueuesByStatus.blocked ?? 0) > 0 ||
    (stuckQueuesByStatus.running ?? 0) > 0
  ) {
    queuePressureSignals.push({
      severity: "warn",
      summary: `stuck queues ${formatQueueStatus(stuckQueuesByStatus)}`
    })
  }

  const pressureSignals = [...budgetSignals, ...quotaSignals, ...queuePressureSignals]
    .sort((left, right) => left.severity.localeCompare(right.severity))
    .slice(0, 3)

  return {
    projectId: project.id,
    projectName: project.name,
    repoPath: project.repoPath,
    generatedAt: now.toISOString(),
    windowHours,
    tasksCompleted: completedTasks.length,
    tasksFailed: failedTasks.length,
    recentCompletedTasks: selectRecentTasks(completedTasks),
    recentFailedTasks: selectRecentTasks(failedTasks),
    topFailureReasons,
    activeQueuesByStatus,
    stuckQueuesByStatus,
    modelUsage: Array.from(usageMap.values())
      .sort(
        (left, right) =>
          right.totalTokens - left.totalTokens || right.runs - left.runs || left.model.localeCompare(right.model)
      )
      .slice(0, 3),
    pressureSignals,
    notableRecoveries: recoverySignals
  }
}

function trimTelegramMessage(message: string, maxChars = 3500): string {
  const normalized = message.trim()
  if (normalized.length <= maxChars) return normalized

  const lines = normalized.split("\n")
  const kept: string[] = []
  let currentLength = 0
  for (const line of lines) {
    const nextLength = currentLength + line.length + (kept.length > 0 ? 1 : 0)
    if (nextLength > maxChars - 14) break
    kept.push(line)
    currentLength = nextLength
  }

  return `${kept.join("\n")}\n- truncated`
}

export function formatDailyTelegramDigest(summary: OperationalDigestSummary): string {
  const day = summary.generatedAt.slice(0, 10)
  const lines = [
    `OpenClaw daily digest | ${summary.projectName} | ${day}`,
    `- Done ${summary.tasksCompleted}: ${formatTaskList(summary.recentCompletedTasks, summary.tasksCompleted)}`,
    `- Failed ${summary.tasksFailed}: ${formatTaskList(summary.recentFailedTasks, summary.tasksFailed)}`,
    `- Failure reasons: ${formatReasonList(summary.topFailureReasons)}`,
    `- Queue: ${formatQueueStatus(summary.activeQueuesByStatus)}`,
    `- Usage: ${formatUsageRows(summary.modelUsage)}`,
    `- Pressure: ${formatPressureSignals(summary.pressureSignals)}`,
    `- Recoveries: ${formatRecoveries(summary.notableRecoveries)}`
  ]
  return trimTelegramMessage(lines.join("\n"))
}

export function formatIncidentTelegramDigest(
  summary: OperationalDigestSummary,
  options: IncidentFormatterOptions = {}
): string {
  const headline = options.title
    ? `OpenClaw incident summary | ${summary.projectName} | ${options.title}`
    : `OpenClaw incident summary | ${summary.projectName}`
  const lines = [
    headline,
    `- Queue pressure: ${formatQueueStatus(summary.activeQueuesByStatus)}`,
    `- Stuck queues: ${formatQueueStatus(summary.stuckQueuesByStatus)}`,
    `- Failed in last ${summary.windowHours}h: ${summary.tasksFailed} (${formatTaskList(summary.recentFailedTasks, summary.tasksFailed)})`,
    `- Top failure reasons: ${formatReasonList(summary.topFailureReasons)}`,
    `- Budget/quota: ${formatPressureSignals(summary.pressureSignals)}`,
    `- Recoveries: ${formatRecoveries(summary.notableRecoveries)}`,
    `- Recent completions: ${formatTaskList(summary.recentCompletedTasks, summary.tasksCompleted)}`
  ]
  return trimTelegramMessage(lines.join("\n"))
}

async function sendTelegramMessage(input: {
  target: string
  text: string
  disableNotification: boolean
  fetchImpl?: TelegramTransport
  openClawExecImpl?: OpenClawMessageTransport
}): Promise<{ ok: boolean; error?: string }> {
  const token =
    process.env.OPENCLAW_TELEGRAM_BOT_TOKEN ?? process.env.OPENCLAW_TELEGRAM_TOKEN ?? process.env.TELEGRAM_BOT_TOKEN
  if (!token) {
    const command = process.env.OPENCLAW_COMMAND?.trim() || "openclaw"
    const args = [
      "message",
      "send",
      "--channel",
      "telegram",
      "--target",
      input.target,
      "--message",
      input.text,
      "--json"
    ]
    if (input.disableNotification) args.push("--silent")

    try {
      await (input.openClawExecImpl ?? execFileAsync)(command, args, {
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 1024 * 1024
      })
      return { ok: true }
    } catch (error) {
      const detail =
        error && typeof error === "object" && "stderr" in error && typeof error.stderr === "string"
          ? error.stderr
          : error instanceof Error
            ? error.message
            : String(error)
      return { ok: false, error: `OpenClaw delivery failed: ${sanitizeReason(detail)}` }
    }
  }

  const fetchImpl = input.fetchImpl ?? fetch
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)

  try {
    const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        chat_id: input.target,
        text: input.text,
        disable_notification: input.disableNotification,
        disable_web_page_preview: true
      }),
      signal: controller.signal
    })
    if (!response.ok) {
      return { ok: false, error: `Telegram HTTP ${response.status}` }
    }
    const payload = (await response.json()) as { ok?: boolean; description?: string }
    if (!payload.ok) {
      return { ok: false, error: sanitizeReason(payload.description ?? "Telegram rejected the message") }
    }
    return { ok: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: sanitizeReason(message) }
  } finally {
    clearTimeout(timeout)
  }
}

export async function sendTelegramDigest(input: SendDigestInput): Promise<TelegramDeliveryResult> {
  const summary = collectOperationalDigestSummary(input.store, input.projectRef, {
    windowHours: input.windowHours ?? (input.kind === "incident" ? 6 : 24)
  })
  const message = input.kind === "incident" ? formatIncidentTelegramDigest(summary) : formatDailyTelegramDigest(summary)
  const notification = resolveNotificationConfig(summary.repoPath, input.profile, input.kind)

  if (!notification.enabled || notification.channel === "none") {
    return {
      kind: input.kind,
      message,
      summary,
      delivery: "skipped",
      resultSummary: "digest skipped: notifications disabled"
    }
  }

  if (input.dryRun || notification.channel === "stdout") {
    return {
      kind: input.kind,
      message,
      summary,
      delivery: "dry-run",
      resultSummary: input.kind === "incident" ? "incident digest preview generated" : "daily digest preview generated"
    }
  }

  if (!notification.target) {
    return {
      kind: input.kind,
      message,
      summary,
      delivery: "failed-soft",
      resultSummary: "digest failed softly: Telegram target is not configured"
    }
  }

  const delivery = await sendTelegramMessage({
    target: notification.target,
    text: message,
    disableNotification: notification.disableNotification,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    ...(input.openClawExecImpl ? { openClawExecImpl: input.openClawExecImpl } : {})
  })

  if (!delivery.ok) {
    return {
      kind: input.kind,
      message,
      summary,
      delivery: "failed-soft",
      resultSummary: `digest failed softly: ${delivery.error ?? "telegram unavailable"}`
    }
  }

  return {
    kind: input.kind,
    message,
    summary,
    delivery: "sent",
    resultSummary: input.kind === "incident" ? "incident digest sent to Telegram" : "daily digest sent to Telegram"
  }
}
