import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import type {
  EvaluationMetricResult,
  EvaluationRunMeta,
  EvaluationRunSummary,
  EvaluationSolution,
  StoredTaskMeta
} from "./types.js"

export interface EvaluationStorage {
  saveRunMeta(meta: EvaluationRunMeta): void | Promise<void>
  getRunMeta(): EvaluationRunMeta | null | Promise<EvaluationRunMeta | null>
  saveTaskMeta(taskId: string, meta: StoredTaskMeta): void | Promise<void>
  getTaskMeta(taskId: string): StoredTaskMeta | null | Promise<StoredTaskMeta | null>
  saveSolution(taskId: string, repeatId: string, solution: EvaluationSolution): void | Promise<void>
  getSolution(taskId: string, repeatId: string): EvaluationSolution | null | Promise<EvaluationSolution | null>
  hasSolution(taskId: string, repeatId: string): boolean | Promise<boolean>
  saveMetricResult(taskId: string, repeatId: string, result: EvaluationMetricResult): void | Promise<void>
  getMetricResult(
    taskId: string,
    repeatId: string,
    metricId: string
  ): EvaluationMetricResult | null | Promise<EvaluationMetricResult | null>
  hasMetricResult(taskId: string, repeatId: string, metricId: string): boolean | Promise<boolean>
  saveRunSummary(summary: EvaluationRunSummary): void | Promise<void>
  getRunSummary(): EvaluationRunSummary | null | Promise<EvaluationRunSummary | null>
}

function readJsonFile<T>(filePath: string): T | null {
  if (!existsSync(filePath)) return null
  return JSON.parse(readFileSync(filePath, "utf8")) as T
}

function writeJsonFile(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

export class FileEvaluationStorage implements EvaluationStorage {
  static readonly RUN_META_FILE = "evaluation-meta.json"
  static readonly RUN_SUMMARY_FILE = "evaluation-summary.json"
  static readonly TASK_META_FILE = "task-meta.json"
  static readonly SOLUTION_FILE = "solution.json"
  static readonly METRICS_DIR = "metrics"

  constructor(private readonly baseDir: string) {
    mkdirSync(this.baseDir, { recursive: true })
  }

  private runMetaPath(): string {
    return join(this.baseDir, FileEvaluationStorage.RUN_META_FILE)
  }

  private runSummaryPath(): string {
    return join(this.baseDir, FileEvaluationStorage.RUN_SUMMARY_FILE)
  }

  private taskDir(taskId: string): string {
    return join(this.baseDir, taskId)
  }

  private taskMetaPath(taskId: string): string {
    return join(this.taskDir(taskId), FileEvaluationStorage.TASK_META_FILE)
  }

  private repeatDir(taskId: string, repeatId: string): string {
    return join(this.taskDir(taskId), repeatId)
  }

  private solutionPath(taskId: string, repeatId: string): string {
    return join(this.repeatDir(taskId, repeatId), FileEvaluationStorage.SOLUTION_FILE)
  }

  private metricPath(taskId: string, repeatId: string, metricId: string): string {
    return join(this.repeatDir(taskId, repeatId), FileEvaluationStorage.METRICS_DIR, `${metricId}.json`)
  }

  saveRunMeta(meta: EvaluationRunMeta): void {
    writeJsonFile(this.runMetaPath(), meta)
  }

  getRunMeta(): EvaluationRunMeta | null {
    return readJsonFile<EvaluationRunMeta>(this.runMetaPath())
  }

  saveTaskMeta(taskId: string, meta: StoredTaskMeta): void {
    writeJsonFile(this.taskMetaPath(taskId), meta)
  }

  getTaskMeta(taskId: string): StoredTaskMeta | null {
    return readJsonFile<StoredTaskMeta>(this.taskMetaPath(taskId))
  }

  saveSolution(taskId: string, repeatId: string, solution: EvaluationSolution): void {
    writeJsonFile(this.solutionPath(taskId, repeatId), solution)
  }

  getSolution(taskId: string, repeatId: string): EvaluationSolution | null {
    return readJsonFile<EvaluationSolution>(this.solutionPath(taskId, repeatId))
  }

  hasSolution(taskId: string, repeatId: string): boolean {
    return existsSync(this.solutionPath(taskId, repeatId))
  }

  saveMetricResult(taskId: string, repeatId: string, result: EvaluationMetricResult): void {
    writeJsonFile(this.metricPath(taskId, repeatId, result.metricId), result)
  }

  getMetricResult(taskId: string, repeatId: string, metricId: string): EvaluationMetricResult | null {
    return readJsonFile<EvaluationMetricResult>(this.metricPath(taskId, repeatId, metricId))
  }

  hasMetricResult(taskId: string, repeatId: string, metricId: string): boolean {
    return existsSync(this.metricPath(taskId, repeatId, metricId))
  }

  saveRunSummary(summary: EvaluationRunSummary): void {
    writeJsonFile(this.runSummaryPath(), summary)
  }

  getRunSummary(): EvaluationRunSummary | null {
    return readJsonFile<EvaluationRunSummary>(this.runSummaryPath())
  }
}
