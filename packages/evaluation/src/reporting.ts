import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { EvaluationStorage } from "./storage.js"
import type {
  EvaluationBenchmark,
  EvaluationMetric,
  EvaluationMetricKind,
  EvaluationMetricResult,
  EvaluationRepeatMetricSummary,
  EvaluationRepeatSummary,
  EvaluationRunMeta,
  EvaluationRunSummary,
  EvaluationSolutionStats
} from "./types.js"

function emptyStats(): EvaluationSolutionStats {
  return {}
}

function addCounterMap(target: Record<string, number>, source: Record<string, number> | undefined): void {
  if (!source) return
  for (const [key, value] of Object.entries(source)) {
    target[key] = (target[key] ?? 0) + value
  }
}

export function mergeSolutionStats(
  target: EvaluationSolutionStats,
  source: EvaluationSolutionStats | undefined
): EvaluationSolutionStats {
  if (!source) return target

  if (source.llm) {
    target.llm ??= {}
    addCounterMap(target.llm, source.llm)
  }
  if (source.tool) {
    target.tool ??= {}
    addCounterMap(target.tool, source.tool)
  }
  if (source.embedding) {
    target.embedding ??= {}
    addCounterMap(target.embedding, source.embedding)
  }
  if (typeof source.agent === "number") {
    target.agent = (target.agent ?? 0) + source.agent
  }
  if (source.chatUsage) {
    target.chatUsage ??= {}
    for (const [model, usage] of Object.entries(source.chatUsage)) {
      const current = target.chatUsage[model] ?? {}
      current.inputTokens = (current.inputTokens ?? 0) + (usage.inputTokens ?? 0)
      current.outputTokens = (current.outputTokens ?? 0) + (usage.outputTokens ?? 0)
      current.totalTokens = (current.totalTokens ?? 0) + (usage.totalTokens ?? 0)
      current.costUnits = (current.costUnits ?? 0) + (usage.costUnits ?? 0)
      target.chatUsage[model] = current
    }
  }

  return target
}

function initMetricSummary(metric: EvaluationMetric): EvaluationRepeatMetricSummary {
  return {
    metricId: metric.id,
    kind: metric.kind,
    involvedTasks: 0,
    completedTasks: 0,
    incompleteTasks: 0,
    passedTasks: 0,
    failedTasks: 0,
    passRate: null
  }
}

function initRepeatSummary(repeatId: string): EvaluationRepeatSummary {
  return {
    repeatId,
    completedTasks: 0,
    incompleteTasks: 0,
    completedIds: [],
    incompleteIds: [],
    metrics: {},
    stats: emptyStats()
  }
}

function recordMetricResult(
  summary: EvaluationRepeatMetricSummary,
  taskId: string,
  result: EvaluationMetricResult
): void {
  summary.completedTasks += 1
  if (result.passed === true) summary.passedTasks += 1
  if (result.passed === false) summary.failedTasks += 1

  if (summary.kind === "numeric") {
    summary.numericValues ??= {}
    summary.numericValues[taskId] = Number(result.value)
    return
  }

  if (summary.kind === "boolean") {
    summary.booleanBuckets ??= { true: [], false: [] }
    summary.booleanBuckets[result.value === true ? "true" : "false"].push(taskId)
    return
  }

  summary.categoricalBuckets ??= {}
  const bucket = String(result.value)
  summary.categoricalBuckets[bucket] ??= []
  summary.categoricalBuckets[bucket].push(taskId)
}

function finalizeMetricSummary(summary: EvaluationRepeatMetricSummary): void {
  const passDenominator = summary.passedTasks + summary.failedTasks
  summary.passRate = passDenominator > 0 ? summary.passedTasks / passDenominator : null

  if (!summary.numericValues) return
  const values = Object.values(summary.numericValues)
  if (values.length === 0) return
  summary.average = values.reduce((sum, value) => sum + value, 0) / values.length
  summary.minimum = Math.min(...values)
  summary.maximum = Math.max(...values)
}

export async function aggregateEvaluationRun(
  benchmark: EvaluationBenchmark,
  repeatCount: number,
  storage: EvaluationStorage,
  meta?: EvaluationRunMeta | null
): Promise<EvaluationRunSummary> {
  const runMeta = meta ?? (await storage.getRunMeta())
  const createdAt = runMeta?.createdAt ?? new Date().toISOString()
  const summary: EvaluationRunSummary = {
    evaluationId: runMeta?.evaluationId ?? benchmark.id,
    benchmarkId: benchmark.id,
    benchmarkName: benchmark.name,
    totalTasks: benchmark.tasks.length,
    repeatCount,
    createdAt,
    repeats: {},
    stats: emptyStats(),
    schemaVersion: 1
  }

  for (let repeatIndex = 0; repeatIndex < repeatCount; repeatIndex += 1) {
    const repeatId = String(repeatIndex)
    const repeatSummary = initRepeatSummary(repeatId)

    for (const task of benchmark.tasks) {
      const solution = await storage.getSolution(task.id, repeatId)
      mergeSolutionStats(repeatSummary.stats, solution?.stats)

      let taskComplete = true
      for (const metric of task.metrics) {
        const metricSummary = repeatSummary.metrics[metric.id] ?? initMetricSummary(metric)
        repeatSummary.metrics[metric.id] = metricSummary
        metricSummary.involvedTasks += 1

        const result = await storage.getMetricResult(task.id, repeatId, metric.id)
        if (!result) {
          metricSummary.incompleteTasks += 1
          taskComplete = false
          continue
        }

        recordMetricResult(metricSummary, task.id, result)
      }

      if (taskComplete) {
        repeatSummary.completedTasks += 1
        repeatSummary.completedIds.push(task.id)
      } else {
        repeatSummary.incompleteTasks += 1
        repeatSummary.incompleteIds.push(task.id)
      }
    }

    for (const metricSummary of Object.values(repeatSummary.metrics)) {
      finalizeMetricSummary(metricSummary)
    }

    mergeSolutionStats(summary.stats, repeatSummary.stats)
    summary.repeats[repeatId] = repeatSummary
  }

  return summary
}

function formatMetricSummary(metric: EvaluationRepeatMetricSummary): string {
  const passRate = metric.passRate === null ? "n/a" : `${(metric.passRate * 100).toFixed(1)}%`
  if (metric.kind === "numeric") {
    return `${metric.metricId}: avg=${metric.average?.toFixed(3) ?? "n/a"} min=${metric.minimum?.toFixed(3) ?? "n/a"} max=${metric.maximum?.toFixed(3) ?? "n/a"} passRate=${passRate}`
  }

  if (metric.kind === "boolean") {
    const passBucket = metric.booleanBuckets?.true.length ?? 0
    const failBucket = metric.booleanBuckets?.false.length ?? 0
    return `${metric.metricId}: true=${passBucket} false=${failBucket} passRate=${passRate}`
  }

  const buckets = Object.entries(metric.categoricalBuckets ?? {})
    .map(([name, taskIds]) => `${name}=${taskIds.length}`)
    .join(", ")
  return `${metric.metricId}: ${buckets || "no buckets"} passRate=${passRate}`
}

export function renderEvaluationSummaryMarkdown(summary: EvaluationRunSummary): string {
  const lines: string[] = [
    `# Evaluation Report: ${summary.benchmarkName}`,
    "",
    `- Evaluation ID: \`${summary.evaluationId}\``,
    `- Benchmark ID: \`${summary.benchmarkId}\``,
    `- Generated At: \`${summary.createdAt}\``,
    `- Tasks: ${summary.totalTasks}`,
    `- Repeats: ${summary.repeatCount}`,
    ""
  ]

  for (const repeatId of Object.keys(summary.repeats).sort()) {
    const repeat = summary.repeats[repeatId]!
    lines.push(`## Repeat ${repeatId}`)
    lines.push("")
    lines.push(`- Completed: ${repeat.completedTasks}/${summary.totalTasks}`)
    lines.push(`- Incomplete: ${repeat.incompleteTasks}/${summary.totalTasks}`)
    lines.push("")
    for (const metric of Object.values(repeat.metrics)) {
      lines.push(`- ${formatMetricSummary(metric)}`)
    }
    lines.push("")
  }

  return lines.join("\n").trimEnd()
}

export function renderEvaluationSummaryText(summary: EvaluationRunSummary): string {
  const lines = [
    `${summary.benchmarkName} (${summary.evaluationId})`,
    `tasks=${summary.totalTasks} repeats=${summary.repeatCount}`
  ]

  for (const repeatId of Object.keys(summary.repeats).sort()) {
    const repeat = summary.repeats[repeatId]!
    lines.push(`repeat ${repeatId}: completed=${repeat.completedTasks} incomplete=${repeat.incompleteTasks}`)
    for (const metric of Object.values(repeat.metrics)) {
      lines.push(`  ${formatMetricSummary(metric)}`)
    }
  }

  return lines.join("\n")
}

export function writeEvaluationArtifacts(
  directory: string,
  summary: EvaluationRunSummary
): { jsonPath: string; markdownPath: string } {
  mkdirSync(directory, { recursive: true })
  const jsonPath = join(directory, "evaluation-summary.json")
  const markdownPath = join(directory, "evaluation-summary.md")
  writeFileSync(jsonPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8")
  writeFileSync(markdownPath, `${renderEvaluationSummaryMarkdown(summary)}\n`, "utf8")
  return { jsonPath, markdownPath }
}
