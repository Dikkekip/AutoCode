import { aggregateEvaluationRun } from "./reporting.js"
import type { EvaluationStorage } from "./storage.js"
import type {
  EvaluationBenchmark,
  EvaluationExecutionContext,
  EvaluationExecutor,
  EvaluationMetric,
  EvaluationMetricResult,
  EvaluationRunMeta,
  EvaluationRunSummary,
  EvaluationSolution,
  StoredTaskMeta
} from "./types.js"

function createRunMeta(benchmark: EvaluationBenchmark, repeatCount: number, evaluationId?: string): EvaluationRunMeta {
  return {
    evaluationId: evaluationId ?? `${benchmark.id}-${Date.now()}`,
    benchmarkId: benchmark.id,
    benchmarkName: benchmark.name,
    benchmarkDescription: benchmark.description,
    createdAt: new Date().toISOString(),
    repeatCount,
    totalTasks: benchmark.tasks.length,
    schemaVersion: 1,
    ...(benchmark.version ? { benchmarkVersion: benchmark.version } : {})
  }
}

function toTaskMeta(task: EvaluationBenchmark["tasks"][number]): StoredTaskMeta {
  return {
    taskId: task.id,
    tags: task.tags ?? {},
    metadata: task.metadata ?? {},
    metricIds: task.metrics.map((metric) => metric.id)
  }
}

function normalizeMetricResult(metric: EvaluationMetric, result: EvaluationMetricResult): EvaluationMetricResult {
  return {
    metricId: result.metricId || metric.id,
    kind: result.kind || metric.kind,
    value: result.value,
    createdAt: result.createdAt || new Date().toISOString(),
    message: result.message ?? null,
    ...(result.passed === undefined ? {} : { passed: result.passed }),
    ...(result.metadata ? { metadata: result.metadata } : {})
  }
}

export interface EvaluationRunnerOptions {
  benchmark: EvaluationBenchmark
  repeatCount: number
  storage: EvaluationStorage
  evaluationId?: string
}

export class EvaluationRunner {
  private readonly benchmark: EvaluationBenchmark
  private readonly repeatCount: number
  private readonly storage: EvaluationStorage
  private readonly evaluationId: string | undefined

  constructor(options: EvaluationRunnerOptions) {
    this.benchmark = options.benchmark
    this.repeatCount = options.repeatCount
    this.storage = options.storage
    this.evaluationId = options.evaluationId
  }

  private buildContext(task: EvaluationBenchmark["tasks"][number], repeatIndex: number): EvaluationExecutionContext {
    const repeatId = String(repeatIndex)
    return {
      benchmark: this.benchmark,
      task,
      repeatId,
      repeatIndex,
      attemptKey: `${task.id}:${repeatId}`
    }
  }

  private async loadOrExecuteSolution(
    task: EvaluationBenchmark["tasks"][number],
    context: EvaluationExecutionContext,
    executor: EvaluationExecutor
  ): Promise<EvaluationSolution> {
    const existing = await this.storage.getSolution(task.id, context.repeatId)
    if (existing) return existing
    const solution = await executor(task, context)
    await this.storage.saveSolution(task.id, context.repeatId, solution)
    return solution
  }

  async run(executor: EvaluationExecutor): Promise<EvaluationRunSummary> {
    const meta = (await this.storage.getRunMeta()) ?? createRunMeta(this.benchmark, this.repeatCount, this.evaluationId)
    await this.storage.saveRunMeta(meta)

    for (const task of this.benchmark.tasks) {
      await this.storage.saveTaskMeta(task.id, toTaskMeta(task))

      for (let repeatIndex = 0; repeatIndex < this.repeatCount; repeatIndex += 1) {
        const context = this.buildContext(task, repeatIndex)
        const solution = await this.loadOrExecuteSolution(task, context, executor)

        for (const metric of task.metrics) {
          if (await this.storage.hasMetricResult(task.id, context.repeatId, metric.id)) continue
          const result = await metric.evaluate({
            benchmark: this.benchmark,
            task,
            solution,
            repeatId: context.repeatId,
            repeatIndex
          })
          await this.storage.saveMetricResult(task.id, context.repeatId, normalizeMetricResult(metric, result))
        }
      }
    }

    const summary = await aggregateEvaluationRun(this.benchmark, this.repeatCount, this.storage, meta)
    await this.storage.saveRunSummary(summary)
    return summary
  }
}
