import { type NativeSelectionBudget, type NativeSelectionCandidate, selectNativeImprovements } from "@openclaw/domain"

type Nullable<T> = T | null

export type EvalTaskStatus =
  | "queued"
  | "running"
  | "review_needed"
  | "promotion_pending"
  | "needs_human_review"
  | "blocked"
  | "done"
  | "failed"
export type EvalRunStatus = "running" | "succeeded" | "failed" | "cancelled"
export type EvalReviewVerdict = "approved" | "changes_requested" | "blocked"

export interface AutonomousCompanyTaskRecord {
  id: string
  projectId: string
  personaId: Nullable<string>
  stage: Nullable<string>
  kind: string
  title: string
  description: Nullable<string>
  labels: string[]
  changedFiles: string[]
  allowedPaths: string[]
  requiredReading: string[]
  verificationCommands: string[]
  status: EvalTaskStatus
  retryCount: number
  lastError: Nullable<string>
  blockedReason: Nullable<string>
  lastRecoveryAt?: Nullable<string>
  createdAt: string
  updatedAt: string
  completedAt: Nullable<string>
}

export interface AutonomousCompanyRunRecord {
  id: string
  projectId: string
  taskId: string
  agentId: Nullable<string>
  adapterType: Nullable<string>
  kind: string
  status: EvalRunStatus
  errorText: Nullable<string>
  verificationSummary: Nullable<string>
  reviewVerdict: Nullable<EvalReviewVerdict>
  costCents: Nullable<number>
  retryClass: string
  metadata: Nullable<Record<string, unknown>>
  startedAt: string
  finishedAt: Nullable<string>
  createdAt: string
}

export interface AutonomousCompanyRunEventRecord {
  id: string
  runId: string
  seq: number
  level: "info" | "warn" | "error"
  message: string
  data: Nullable<Record<string, unknown>>
  createdAt: string
}

export interface AutonomousCompanyPersonaRecord {
  id: string
  name: string
  stage: string
  preferredAdapterType: string
}

export interface AutonomousCompanyAgentRecord {
  id: string
  name: string
  role: string
  adapterType: string
}

export interface AutonomousCompanyAdapterHealthRecord {
  adapterType: string
  laneKey: string
  status: string
  reason: Nullable<string>
  lastError: Nullable<string>
}

export interface AutonomousCompanyPlannerRunRecord {
  id: string
  status: string
  plannerPersonaId: Nullable<string>
  plannerAgentId: Nullable<string>
  adapterType: Nullable<string>
  startedAt: string
  finishedAt: Nullable<string>
  summaryJson: unknown
}

export interface AutonomousCompanyEvaluationInput {
  project: {
    id: string
    name: string
    repoPath: string
  }
  generatedAt?: string
  tasks: AutonomousCompanyTaskRecord[]
  runs: AutonomousCompanyRunRecord[]
  runEvents: AutonomousCompanyRunEventRecord[]
  personas: AutonomousCompanyPersonaRecord[]
  agents: AutonomousCompanyAgentRecord[]
  adapterHealth: AutonomousCompanyAdapterHealthRecord[]
  plannerRuns: AutonomousCompanyPlannerRunRecord[]
}

export interface MetricValue {
  value: number | null
  numerator?: number
  denominator?: number
}

export interface EvaluationSnapshot {
  schemaVersion: 1
  project: AutonomousCompanyEvaluationInput["project"]
  generatedAt: string
  sourceCounts: {
    tasks: number
    runs: number
    runEvents: number
    plannerRuns: number
  }
  metrics: {
    taskSuccessRate: MetricValue
    verificationPassRate: MetricValue
    repairSuccessRate: MetricValue
    reviewRejectionRate: MetricValue
    averageAttemptsPerTask: MetricValue
    unsafeActionBlocks: MetricValue
    promptQualityScore: MetricValue
    timeToApprovedRunHours: MetricValue
  }
  diffSizeDistribution: DistributionSummary
  repeatedFailureClusters: FailureCluster[]
}

export interface DistributionSummary {
  count: number
  buckets: Record<"none" | "small" | "medium" | "large" | "unknown", number>
  p50: number | null
  p90: number | null
  max: number | null
}

export interface FailureCluster {
  signature: string
  count: number
  taskIds: string[]
  runIds: string[]
  sample: string
}

export interface ScorecardMetric {
  value: number | null
  numerator: number
  denominator: number
}

export interface PersonaScorecard {
  personaId: string
  name: string
  stage: string
  taskCount: number
  runCount: number
  taskSuccessRate: ScorecardMetric
  verificationPassRate: ScorecardMetric
  reviewRejectionRate: ScorecardMetric
  repairSuccessRate: ScorecardMetric
  averageAttemptsPerTask: number | null
  promptQualityScore: number | null
  unsafeActionBlocks: number
}

export interface AdapterScorecard {
  adapterType: string
  runCount: number
  successRate: ScorecardMetric
  verificationPassRate: ScorecardMetric
  averageDurationSeconds: number | null
  averageCostCents: number | null
  unsafeActionBlocks: number
  laneHealth: Record<string, string>
}

export interface TrendReport {
  schemaVersion: 1
  projectId: string
  generatedAt: string
  windows: TrendWindow[]
  deltas: Record<string, number | null>
}

export interface TrendWindow {
  id: "previous" | "current"
  startedAt: string | null
  endedAt: string | null
  taskCount: number
  runCount: number
  metrics: EvaluationSnapshot["metrics"]
}

export interface ProjectHealthReport {
  schemaVersion: 1
  projectId: string
  generatedAt: string
  status: "healthy" | "watch" | "degraded"
  blockers: string[]
  risks: string[]
  strengths: string[]
}

export interface PlannerRecommendation {
  priority: "high" | "medium" | "low"
  area: string
  recommendation: string
  evidence: string
}

export interface PlannerCycleRecommendations {
  schemaVersion: 1
  projectId: string
  generatedAt: string
  recommendations: PlannerRecommendation[]
  plannerHints: {
    focusPersonaIds: string[]
    focusAdapters: string[]
    repeatedFailureSignatures: string[]
    suggestedTaskLabels: string[]
  }
}

export interface AutonomousCompanyEvaluationOutput {
  snapshot: EvaluationSnapshot
  trendReport: TrendReport
  personaScorecards: PersonaScorecard[]
  adapterScorecards: AdapterScorecard[]
  projectHealthReport: ProjectHealthReport
  recommendations: PlannerCycleRecommendations
}

const FAILURE_WORDS = ["failed", "error", "exception", "timeout", "verification", "review", "blocked"]
const UNSAFE_WORDS = [
  "unsafe",
  "policy",
  "forbidden",
  "blocked action",
  "outside allowed",
  "destructive",
  "approval required"
]

function ratio(numerator: number, denominator: number): MetricValue {
  return { value: denominator > 0 ? numerator / denominator : null, numerator, denominator }
}

function average(values: number[]): number | null {
  if (values.length === 0) return null
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null
  const ordered = [...values].sort((left, right) => left - right)
  const index = Math.min(ordered.length - 1, Math.max(0, Math.ceil((p / 100) * ordered.length) - 1))
  return ordered[index] ?? null
}

function parseTime(value: string | null): number | null {
  if (!value) return null
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? null : timestamp
}

function hoursBetween(start: string | null, end: string | null): number | null {
  const startMs = parseTime(start)
  const endMs = parseTime(end)
  if (startMs === null || endMs === null || endMs < startMs) return null
  return (endMs - startMs) / 3_600_000
}

function includesAny(text: string | null | undefined, words: string[]): boolean {
  if (!text) return false
  const lower = text.toLowerCase()
  return words.some((word) => lower.includes(word))
}

function verificationPassed(run: AutonomousCompanyRunRecord): boolean | null {
  if (!run.verificationSummary) return null
  if (run.status === "failed" || includesAny(run.verificationSummary, ["failed", "failing", "error", "exit 1"]))
    return false
  return true
}

function promptQuality(task: AutonomousCompanyTaskRecord): number {
  let score = 0
  const descriptionLength = task.description?.trim().length ?? 0
  if (descriptionLength >= 80) score += 0.2
  else if (descriptionLength >= 30) score += 0.1
  if (task.changedFiles.length > 0 || task.allowedPaths.length > 0) score += 0.2
  if (task.requiredReading.length > 0) score += 0.2
  if (task.verificationCommands.length > 0) score += 0.2
  if (task.labels.length > 0) score += 0.1
  if (task.title.trim().length >= 12) score += 0.1
  return Math.min(1, score)
}

function diffSize(run: AutonomousCompanyRunRecord, task?: AutonomousCompanyTaskRecord): number | null {
  const metadata = run.metadata ?? {}
  const candidates = [
    metadata.diffLines,
    metadata.changedLines,
    metadata.linesChanged,
    metadata.insertions,
    metadata.deletions,
    metadata.diffSize
  ]
  const numeric = candidates
    .map((value) => (typeof value === "number" ? value : null))
    .filter((value) => value !== null)
  if (numeric.length > 0) return numeric.reduce((sum, value) => sum + value, 0)
  if (task && task.changedFiles.length > 0) return task.changedFiles.length
  return null
}

function diffDistribution(
  runs: AutonomousCompanyRunRecord[],
  tasksById: Map<string, AutonomousCompanyTaskRecord>
): DistributionSummary {
  const buckets: DistributionSummary["buckets"] = { none: 0, small: 0, medium: 0, large: 0, unknown: 0 }
  const values: number[] = []
  for (const run of runs) {
    const size = diffSize(run, tasksById.get(run.taskId))
    if (size === null) {
      buckets.unknown += 1
      continue
    }
    values.push(size)
    if (size === 0) buckets.none += 1
    else if (size <= 5) buckets.small += 1
    else if (size <= 25) buckets.medium += 1
    else buckets.large += 1
  }
  return {
    count: values.length,
    buckets,
    p50: percentile(values, 50),
    p90: percentile(values, 90),
    max: values.length > 0 ? Math.max(...values) : null
  }
}

function failureSignature(text: string): string {
  return text
    .toLowerCase()
    .replace(/[0-9a-f]{7,}/g, "<sha>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
}

function buildFailureClusters(
  runs: AutonomousCompanyRunRecord[],
  eventsByRunId: Map<string, AutonomousCompanyRunEventRecord[]>
): FailureCluster[] {
  const clusters = new Map<string, FailureCluster>()
  for (const run of runs) {
    const runEvents = eventsByRunId.get(run.id) ?? []
    const eventText = runEvents
      .filter((event) => event.level === "error" || includesAny(event.message, FAILURE_WORDS))
      .map((event) => event.message)
      .join(" ")
    const source = run.errorText || eventText || (run.status === "failed" ? run.retryClass : "")
    if (!source || (run.status !== "failed" && !includesAny(source, FAILURE_WORDS))) continue
    const signature = failureSignature(source)
    const current = clusters.get(signature) ?? {
      signature,
      count: 0,
      taskIds: [],
      runIds: [],
      sample: source.slice(0, 240)
    }
    current.count += 1
    if (!current.taskIds.includes(run.taskId)) current.taskIds.push(run.taskId)
    current.runIds.push(run.id)
    clusters.set(signature, current)
  }
  return [...clusters.values()]
    .filter((cluster) => cluster.count > 1)
    .sort((left, right) => right.count - left.count || left.signature.localeCompare(right.signature))
}

function unsafeBlocks(
  runs: AutonomousCompanyRunRecord[],
  eventsByRunId: Map<string, AutonomousCompanyRunEventRecord[]>
): number {
  let count = 0
  for (const run of runs) {
    if (run.retryClass === "policy" || includesAny(run.errorText, UNSAFE_WORDS)) {
      count += 1
      continue
    }
    if (
      (eventsByRunId.get(run.id) ?? []).some((event) =>
        includesAny(`${event.message} ${JSON.stringify(event.data ?? {})}`, UNSAFE_WORDS)
      )
    ) {
      count += 1
    }
  }
  return count
}

function buildSnapshot(
  input: AutonomousCompanyEvaluationInput,
  tasks: AutonomousCompanyTaskRecord[],
  runs: AutonomousCompanyRunRecord[],
  eventsByRunId: Map<string, AutonomousCompanyRunEventRecord[]>
): EvaluationSnapshot {
  const terminalTasks = tasks.filter((task) => task.status === "done" || task.status === "failed")
  const successfulTasks = terminalTasks.filter((task) => task.status === "done")
  const verificationResults = runs.map(verificationPassed).filter((value) => value !== null)
  const repairTasks = tasks.filter(
    (task) => task.kind === "fix_review_feedback" || task.retryCount > 0 || task.lastRecoveryAt !== undefined
  )
  const reviewRuns = runs.filter((run) => run.reviewVerdict !== null)
  const rejectedReviewRuns = reviewRuns.filter(
    (run) => run.reviewVerdict === "changes_requested" || run.reviewVerdict === "blocked"
  )
  const runsByTask = new Map<string, number>()
  for (const run of runs) runsByTask.set(run.taskId, (runsByTask.get(run.taskId) ?? 0) + 1)
  const approvedDurations = tasks
    .map((task) => {
      const approvedRun = runs
        .filter((run) => run.taskId === task.id && run.reviewVerdict === "approved")
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0]
      return hoursBetween(task.createdAt, approvedRun?.finishedAt ?? task.completedAt)
    })
    .filter((value) => value !== null)
  const tasksById = new Map(tasks.map((task) => [task.id, task]))

  return {
    schemaVersion: 1,
    project: input.project,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    sourceCounts: {
      tasks: tasks.length,
      runs: runs.length,
      runEvents: input.runEvents.length,
      plannerRuns: input.plannerRuns.length
    },
    metrics: {
      taskSuccessRate: ratio(successfulTasks.length, terminalTasks.length),
      verificationPassRate: ratio(verificationResults.filter(Boolean).length, verificationResults.length),
      repairSuccessRate: ratio(
        repairTasks.filter((task) => task.status === "done").length,
        repairTasks.filter((task) => task.status === "done" || task.status === "failed").length
      ),
      reviewRejectionRate: ratio(rejectedReviewRuns.length, reviewRuns.length),
      averageAttemptsPerTask: { value: average([...runsByTask.values()]) },
      unsafeActionBlocks: {
        value: unsafeBlocks(runs, eventsByRunId),
        numerator: unsafeBlocks(runs, eventsByRunId),
        denominator: runs.length
      },
      promptQualityScore: { value: average(tasks.map(promptQuality)) },
      timeToApprovedRunHours: { value: average(approvedDurations) }
    },
    diffSizeDistribution: diffDistribution(runs, tasksById),
    repeatedFailureClusters: buildFailureClusters(runs, eventsByRunId)
  }
}

function buildPersonaScorecards(
  input: AutonomousCompanyEvaluationInput,
  tasks: AutonomousCompanyTaskRecord[],
  runs: AutonomousCompanyRunRecord[],
  eventsByRunId: Map<string, AutonomousCompanyRunEventRecord[]>
): PersonaScorecard[] {
  const personaById = new Map(input.personas.map((persona) => [persona.id, persona]))
  const ids = [...new Set(tasks.map((task) => task.personaId ?? "unassigned"))].sort()
  return ids.map((personaId) => {
    const scopedTasks = tasks.filter((task) => (task.personaId ?? "unassigned") === personaId)
    const taskIds = new Set(scopedTasks.map((task) => task.id))
    const scopedRuns = runs.filter((run) => taskIds.has(run.taskId))
    const terminalTasks = scopedTasks.filter((task) => task.status === "done" || task.status === "failed")
    const verificationResults = scopedRuns.map(verificationPassed).filter((value) => value !== null)
    const reviewRuns = scopedRuns.filter((run) => run.reviewVerdict !== null)
    const rejectedReviews = reviewRuns.filter(
      (run) => run.reviewVerdict === "changes_requested" || run.reviewVerdict === "blocked"
    )
    const repairTasks = scopedTasks.filter((task) => task.kind === "fix_review_feedback" || task.retryCount > 0)
    const persona = personaById.get(personaId)
    return {
      personaId,
      name: persona?.name ?? "Unassigned",
      stage: persona?.stage ?? "unassigned",
      taskCount: scopedTasks.length,
      runCount: scopedRuns.length,
      taskSuccessRate: ratio(
        terminalTasks.filter((task) => task.status === "done").length,
        terminalTasks.length
      ) as ScorecardMetric,
      verificationPassRate: ratio(
        verificationResults.filter(Boolean).length,
        verificationResults.length
      ) as ScorecardMetric,
      reviewRejectionRate: ratio(rejectedReviews.length, reviewRuns.length) as ScorecardMetric,
      repairSuccessRate: ratio(
        repairTasks.filter((task) => task.status === "done").length,
        repairTasks.filter((task) => task.status === "done" || task.status === "failed").length
      ) as ScorecardMetric,
      averageAttemptsPerTask: average(
        scopedTasks.map((task) => scopedRuns.filter((run) => run.taskId === task.id).length)
      ),
      promptQualityScore: average(scopedTasks.map(promptQuality)),
      unsafeActionBlocks: unsafeBlocks(scopedRuns, eventsByRunId)
    }
  })
}

function buildAdapterScorecards(
  input: AutonomousCompanyEvaluationInput,
  runs: AutonomousCompanyRunRecord[],
  eventsByRunId: Map<string, AutonomousCompanyRunEventRecord[]>
): AdapterScorecard[] {
  const adapterTypes = [...new Set(runs.map((run) => run.adapterType ?? "unknown"))].sort()
  return adapterTypes.map((adapterType) => {
    const scopedRuns = runs.filter((run) => (run.adapterType ?? "unknown") === adapterType)
    const verificationResults = scopedRuns.map(verificationPassed).filter((value) => value !== null)
    const durations = scopedRuns
      .map((run) => hoursBetween(run.startedAt, run.finishedAt))
      .filter((value) => value !== null)
    const costs = scopedRuns.map((run) => run.costCents).filter((value) => value !== null)
    const laneHealth = Object.fromEntries(
      input.adapterHealth
        .filter((entry) => entry.adapterType === adapterType)
        .sort((left, right) => left.laneKey.localeCompare(right.laneKey))
        .map((entry) => [entry.laneKey, entry.status])
    )
    return {
      adapterType,
      runCount: scopedRuns.length,
      successRate: ratio(
        scopedRuns.filter((run) => run.status === "succeeded").length,
        scopedRuns.filter((run) => run.status !== "running").length
      ) as ScorecardMetric,
      verificationPassRate: ratio(
        verificationResults.filter(Boolean).length,
        verificationResults.length
      ) as ScorecardMetric,
      averageDurationSeconds: average(durations.map((value) => value * 3600)),
      averageCostCents: average(costs),
      unsafeActionBlocks: unsafeBlocks(scopedRuns, eventsByRunId),
      laneHealth
    }
  })
}

function buildTrendReport(input: AutonomousCompanyEvaluationInput): TrendReport {
  const sortedRuns = [...input.runs].sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  const midpoint = Math.floor(sortedRuns.length / 2)
  const windows: TrendWindow[] = [
    buildTrendWindow("previous", input, sortedRuns.slice(0, midpoint)),
    buildTrendWindow("current", input, sortedRuns.slice(midpoint))
  ]
  const previous = windows[0]!
  const current = windows[1]!
  return {
    schemaVersion: 1,
    projectId: input.project.id,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    windows,
    deltas: Object.fromEntries(
      Object.keys(current.metrics).map((key) => {
        const currentValue = current.metrics[key as keyof EvaluationSnapshot["metrics"]].value
        const previousValue = previous.metrics[key as keyof EvaluationSnapshot["metrics"]].value
        return [key, currentValue === null || previousValue === null ? null : currentValue - previousValue]
      })
    )
  }
}

function buildTrendWindow(
  id: TrendWindow["id"],
  input: AutonomousCompanyEvaluationInput,
  runs: AutonomousCompanyRunRecord[]
): TrendWindow {
  const taskIds = new Set(runs.map((run) => run.taskId))
  const tasks = input.tasks.filter((task) => taskIds.has(task.id))
  const eventsByRunId = groupEvents(input.runEvents.filter((event) => runs.some((run) => run.id === event.runId)))
  const snapshot = buildSnapshot(input, tasks, runs, eventsByRunId)
  return {
    id,
    startedAt: runs[0]?.createdAt ?? null,
    endedAt: runs.at(-1)?.createdAt ?? null,
    taskCount: tasks.length,
    runCount: runs.length,
    metrics: snapshot.metrics
  }
}

function buildProjectHealthReport(snapshot: EvaluationSnapshot, adapters: AdapterScorecard[]): ProjectHealthReport {
  const blockers: string[] = []
  const risks: string[] = []
  const strengths: string[] = []
  if ((snapshot.metrics.taskSuccessRate.value ?? 1) < 0.7) blockers.push("Task success rate is below 70%.")
  if ((snapshot.metrics.verificationPassRate.value ?? 1) < 0.8) risks.push("Verification pass rate is below 80%.")
  if ((snapshot.metrics.reviewRejectionRate.value ?? 0) > 0.25) risks.push("Review rejection rate is above 25%.")
  if ((snapshot.metrics.unsafeActionBlocks.value ?? 0) > 0)
    blockers.push("Unsafe or policy-blocked actions were recorded.")
  if (snapshot.repeatedFailureClusters.length > 0) risks.push("Repeated failure clusters are present.")
  for (const adapter of adapters) {
    if (Object.values(adapter.laneHealth).some((status) => status !== "healthy")) {
      risks.push(`${adapter.adapterType} has unhealthy lanes.`)
    }
  }
  if ((snapshot.metrics.taskSuccessRate.value ?? 0) >= 0.8) strengths.push("Task success rate is healthy.")
  if ((snapshot.metrics.promptQualityScore.value ?? 0) >= 0.75) strengths.push("Prompt quality is strong.")
  const status = blockers.length > 0 ? "degraded" : risks.length > 0 ? "watch" : "healthy"
  return {
    schemaVersion: 1,
    projectId: snapshot.project.id,
    generatedAt: snapshot.generatedAt,
    status,
    blockers,
    risks,
    strengths
  }
}

function buildRecommendations(
  snapshot: EvaluationSnapshot,
  personas: PersonaScorecard[],
  adapters: AdapterScorecard[]
): PlannerCycleRecommendations {
  const recommendations: PlannerRecommendation[] = []
  if ((snapshot.metrics.verificationPassRate.value ?? 1) < 0.8) {
    recommendations.push({
      priority: "high",
      area: "verification",
      recommendation:
        "Create follow-up work that improves task-level verification commands and requires agents to record verification output.",
      evidence: `verificationPassRate=${formatMetric(snapshot.metrics.verificationPassRate.value)}`
    })
  }
  if (snapshot.repeatedFailureClusters.length > 0) {
    recommendations.push({
      priority: "high",
      area: "failure-clusters",
      recommendation: "Prioritize fixes for repeated failure signatures before expanding new feature work.",
      evidence: snapshot.repeatedFailureClusters[0]!.signature
    })
  }
  if ((snapshot.metrics.reviewRejectionRate.value ?? 0) > 0.25) {
    recommendations.push({
      priority: "medium",
      area: "review",
      recommendation:
        "Route more implementation tasks through smaller scopes and add reviewer findings to coder prompts.",
      evidence: `reviewRejectionRate=${formatMetric(snapshot.metrics.reviewRejectionRate.value)}`
    })
  }
  if ((snapshot.metrics.promptQualityScore.value ?? 1) < 0.75) {
    recommendations.push({
      priority: "medium",
      area: "prompt-quality",
      recommendation:
        "Have the planner include changed files, required reading, verification commands, and acceptance criteria in every task package.",
      evidence: `promptQualityScore=${formatMetric(snapshot.metrics.promptQualityScore.value)}`
    })
  }
  if (recommendations.length === 0) {
    recommendations.push({
      priority: "low",
      area: "throughput",
      recommendation:
        "Retain current behavior; investigate only evidence-backed gaps in operator goals. A useful no-op is a successful investigation.",
      evidence: "No degraded evaluation metric crossed a recommendation threshold."
    })
  }
  return {
    schemaVersion: 1,
    projectId: snapshot.project.id,
    generatedAt: snapshot.generatedAt,
    recommendations,
    plannerHints: {
      focusPersonaIds: personas
        .filter((persona) => (persona.taskSuccessRate.value ?? 1) < 0.75 || (persona.promptQualityScore ?? 1) < 0.7)
        .map((persona) => persona.personaId)
        .sort(),
      focusAdapters: adapters
        .filter((adapter) => (adapter.successRate.value ?? 1) < 0.8 || adapter.unsafeActionBlocks > 0)
        .map((adapter) => adapter.adapterType)
        .sort(),
      repeatedFailureSignatures: snapshot.repeatedFailureClusters.map((cluster) => cluster.signature).slice(0, 5),
      suggestedTaskLabels: recommendations.map((recommendation) => `eval:${recommendation.area}`)
    }
  }
}

function groupEvents(events: AutonomousCompanyRunEventRecord[]): Map<string, AutonomousCompanyRunEventRecord[]> {
  const grouped = new Map<string, AutonomousCompanyRunEventRecord[]>()
  for (const event of events) {
    const entries = grouped.get(event.runId) ?? []
    entries.push(event)
    grouped.set(event.runId, entries)
  }
  for (const entries of grouped.values()) entries.sort((left, right) => left.seq - right.seq)
  return grouped
}

function formatMetric(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(3)
}

export function evaluateAutonomousCompany(input: AutonomousCompanyEvaluationInput): AutonomousCompanyEvaluationOutput {
  const tasks = [...input.tasks].sort(
    (left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
  )
  const runs = [...input.runs].sort(
    (left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
  )
  const runIds = new Set(runs.map((run) => run.id))
  const eventsByRunId = groupEvents(input.runEvents.filter((event) => runIds.has(event.runId)))
  const snapshot = buildSnapshot(input, tasks, runs, eventsByRunId)
  const personaScorecards = buildPersonaScorecards(input, tasks, runs, eventsByRunId)
  const adapterScorecards = buildAdapterScorecards(input, runs, eventsByRunId)
  return {
    snapshot,
    trendReport: buildTrendReport({ ...input, tasks, runs }),
    personaScorecards,
    adapterScorecards,
    projectHealthReport: buildProjectHealthReport(snapshot, adapterScorecards),
    recommendations: buildRecommendations(snapshot, personaScorecards, adapterScorecards)
  }
}

export function renderAutonomousCompanyEvaluationText(output: AutonomousCompanyEvaluationOutput): string {
  const lines = [
    `Evaluation snapshot for ${output.snapshot.project.name}`,
    `status=${output.projectHealthReport.status}`,
    `task_success_rate=${formatMetric(output.snapshot.metrics.taskSuccessRate.value)}`,
    `verification_pass_rate=${formatMetric(output.snapshot.metrics.verificationPassRate.value)}`,
    `repair_success_rate=${formatMetric(output.snapshot.metrics.repairSuccessRate.value)}`,
    `review_rejection_rate=${formatMetric(output.snapshot.metrics.reviewRejectionRate.value)}`,
    `average_attempts_per_task=${formatMetric(output.snapshot.metrics.averageAttemptsPerTask.value)}`,
    `unsafe_action_blocks=${output.snapshot.metrics.unsafeActionBlocks.value ?? 0}`,
    `prompt_quality_score=${formatMetric(output.snapshot.metrics.promptQualityScore.value)}`,
    `time_to_approved_run_hours=${formatMetric(output.snapshot.metrics.timeToApprovedRunHours.value)}`,
    `repeated_failure_clusters=${output.snapshot.repeatedFailureClusters.length}`,
    `diff_size_distribution=${JSON.stringify(output.snapshot.diffSizeDistribution.buckets)}`
  ]
  if (output.recommendations.recommendations.length > 0) {
    lines.push("", "Recommendations:")
    for (const recommendation of output.recommendations.recommendations) {
      lines.push(`- ${recommendation.priority} | ${recommendation.area} | ${recommendation.recommendation}`)
    }
  }
  return lines.join("\n")
}

/** Replay identical ordered inputs against the previous capacity-only baseline and the value selector.
 * Utility labels are held-out scenario outcomes, not selector scores or proposal counts.
 */
export function evaluateNativeAdmission(scenario: {
  candidates: NativeSelectionCandidate[]
  budget: NativeSelectionBudget
  slots: number
  realizedUtility: Record<string, number>
  investigations: Array<"completed" | "no_op" | "failed" | "timed_out">
}) {
  const decisions = selectNativeImprovements(scenario.candidates, scenario.budget, scenario.slots)
  const baseline = scenario.candidates.slice(0, scenario.slots).map((c) => c.id)
  const selected = decisions.filter((d) => d.outcome === "selected").map((d) => d.id)
  const summarize = (ids: string[]) => ({
    ids,
    realizedUtility: ids.reduce((sum, id) => sum + (scenario.realizedUtility[id] ?? 0), 0),
    effortHours: scenario.candidates
      .filter((c) => ids.includes(c.id))
      .reduce((sum, c) => sum + c.hypothesis.effortHours, 0),
    costCents: scenario.candidates.filter((c) => ids.includes(c.id)).reduce((sum, c) => sum + c.hypothesis.costCents, 0)
  })
  return {
    baseline: summarize(baseline),
    selector: summarize(selected),
    decisions,
    successfulInvestigations: scenario.investigations.filter((s) => s === "completed" || s === "no_op").length,
    investigationCount: scenario.investigations.length
  }
}
