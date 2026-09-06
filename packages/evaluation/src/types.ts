export type EvaluationMetricKind = "numeric" | "categorical" | "boolean"

export type EvaluationMetricValue = number | string | boolean

export interface EvaluationTokenUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  costUnits?: number
}

export interface EvaluationSolutionStats {
  llm?: Record<string, number>
  agent?: number
  tool?: Record<string, number>
  embedding?: Record<string, number>
  chatUsage?: Record<string, EvaluationTokenUsage>
}

export type EvaluationTraceEntry =
  | { type: "text"; text: string }
  | { type: "tool_use"; toolName: string; input?: unknown }
  | { type: "tool_result"; toolName: string; output?: unknown; error?: string | null }
  | { type: "event"; name: string; payload?: unknown }

export interface EvaluationSolution<Output = unknown> {
  success: boolean
  output: Output
  trajectory: EvaluationTraceEntry[]
  meta?: Record<string, unknown>
  stats?: EvaluationSolutionStats
}

export interface EvaluationMetricResult {
  metricId: string
  kind: EvaluationMetricKind
  value: EvaluationMetricValue
  createdAt: string
  passed?: boolean
  message?: string | null
  metadata?: Record<string, unknown>
}

export interface EvaluationTask<Input = unknown, GroundTruth = unknown> {
  id: string
  input: Input
  groundTruth?: GroundTruth
  metrics: Array<EvaluationMetric<Input, GroundTruth>>
  tags?: Record<string, string>
  metadata?: Record<string, unknown>
}

export interface EvaluationBenchmark<Input = unknown, GroundTruth = unknown> {
  id: string
  name: string
  description: string
  version?: string
  tasks: Array<EvaluationTask<Input, GroundTruth>>
}

export interface EvaluationMetricContext<Input = unknown, GroundTruth = unknown, Output = unknown> {
  benchmark: EvaluationBenchmark<Input, GroundTruth>
  task: EvaluationTask<Input, GroundTruth>
  solution: EvaluationSolution<Output>
  repeatId: string
  repeatIndex: number
}

export interface EvaluationMetric<Input = unknown, GroundTruth = unknown, Output = unknown> {
  id: string
  kind: EvaluationMetricKind
  description?: string
  categories?: string[]
  evaluate(
    context: EvaluationMetricContext<Input, GroundTruth, Output>
  ): Promise<EvaluationMetricResult> | EvaluationMetricResult
}

export interface EvaluationRunMeta {
  evaluationId: string
  benchmarkId: string
  benchmarkName: string
  benchmarkDescription: string
  benchmarkVersion?: string
  createdAt: string
  repeatCount: number
  totalTasks: number
  schemaVersion: 1
}

export interface StoredTaskMeta {
  taskId: string
  tags: Record<string, string>
  metadata: Record<string, unknown>
  metricIds: string[]
}

export interface EvaluationExecutionContext<Input = unknown, GroundTruth = unknown> {
  benchmark: EvaluationBenchmark<Input, GroundTruth>
  task: EvaluationTask<Input, GroundTruth>
  repeatId: string
  repeatIndex: number
  attemptKey: string
}

export type EvaluationExecutor<Input = unknown, GroundTruth = unknown, Output = unknown> = (
  task: EvaluationTask<Input, GroundTruth>,
  context: EvaluationExecutionContext<Input, GroundTruth>
) => Promise<EvaluationSolution<Output>>

export interface EvaluationRepeatMetricSummary {
  metricId: string
  kind: EvaluationMetricKind
  involvedTasks: number
  completedTasks: number
  incompleteTasks: number
  passedTasks: number
  failedTasks: number
  passRate: number | null
  average?: number
  minimum?: number
  maximum?: number
  numericValues?: Record<string, number>
  categoricalBuckets?: Record<string, string[]>
  booleanBuckets?: {
    true: string[]
    false: string[]
  }
}

export interface EvaluationRepeatSummary {
  repeatId: string
  completedTasks: number
  incompleteTasks: number
  completedIds: string[]
  incompleteIds: string[]
  metrics: Record<string, EvaluationRepeatMetricSummary>
  stats: EvaluationSolutionStats
}

export interface EvaluationRunSummary {
  evaluationId: string
  benchmarkId: string
  benchmarkName: string
  totalTasks: number
  repeatCount: number
  createdAt: string
  repeats: Record<string, EvaluationRepeatSummary>
  stats: EvaluationSolutionStats
  schemaVersion: 1
}

export interface RetrievalEvaluationManifest {
  datasetVersion: string
  createdAt: string
  status: "draft" | "active" | "archived"
  description: string
  sourceCorpusFingerprint: string | null
  queryCount: number
  slices: Record<string, Record<string, number>>
  annotationGuidelinesVersion: string | null
  notes: string[]
}

export interface RetrievalEvaluationCase {
  id: string
  query: string
  expectedSourceRefs: string[]
  metadata: Record<string, unknown>
}

export interface RetrievalEvaluationDataset {
  manifest: RetrievalEvaluationManifest
  cases: RetrievalEvaluationCase[]
}

export interface RetrievalEvaluationMetricThreshold {
  metric: "recall_at_k" | "mrr" | "expectation_coverage"
  min: number
}

export interface RetrievalEvaluationThresholds {
  minimumCaseCount?: number
  minimumExpectationCoverage?: number
  metrics: RetrievalEvaluationMetricThreshold[]
}

export interface RetrievalCandidate {
  sourceRef: string
  score?: number | null
}

export interface RetrievalEvaluationCaseResult {
  caseId: string
  query: string
  expectedSourceRefs: string[]
  retrievedSourceRefs: string[]
  topHitRank: number | null
  recallAtK: number
  mrr: number
  passed: boolean
}

export interface RetrievalEvaluationSummary {
  caseCount: number
  expectationCoverage: number
  recallAtK: number
  mrr: number
  pass: boolean
  failures: string[]
}

export interface RetrievalEvaluationReport {
  manifest: RetrievalEvaluationManifest
  generatedAt: string
  thresholds: RetrievalEvaluationThresholds
  summary: RetrievalEvaluationSummary
  results: RetrievalEvaluationCaseResult[]
}

export type SnapshotVariableValue = string | number | boolean | null

export interface SnapshotAssertionContext<
  Vars extends Record<string, SnapshotVariableValue> = Record<string, SnapshotVariableValue>
> {
  output: string
  prompt: string
  vars: Vars
  solution: EvaluationSolution<string>
}

export type SnapshotAssertion<
  Vars extends Record<string, SnapshotVariableValue> = Record<string, SnapshotVariableValue>
> =
  | {
      type: "contains"
      value: string
      metricId?: string
      caseSensitive?: boolean
    }
  | {
      type: "not_contains"
      value: string
      metricId?: string
      caseSensitive?: boolean
    }
  | {
      type: "regex"
      pattern: string
      flags?: string
      metricId?: string
    }
  | {
      type: "predicate"
      metricId: string
      description?: string
      evaluate(context: SnapshotAssertionContext<Vars>): boolean | Promise<boolean>
    }

export interface PromptSnapshotCase<
  Vars extends Record<string, SnapshotVariableValue> = Record<string, SnapshotVariableValue>
> {
  id: string
  description?: string
  vars?: Partial<Vars>
  prompt?: string
  assertions: Array<SnapshotAssertion<Vars>>
  tags?: Record<string, string>
  metadata?: Record<string, unknown>
}

export interface PromptSnapshotSuite<
  Vars extends Record<string, SnapshotVariableValue> = Record<string, SnapshotVariableValue>
> {
  id: string
  name: string
  description: string
  promptTemplate: string
  defaultVars: Vars
  cases: Array<PromptSnapshotCase<Vars>>
}

export interface RenderedPromptSnapshotCase<
  Vars extends Record<string, SnapshotVariableValue> = Record<string, SnapshotVariableValue>
> {
  id: string
  description?: string
  prompt: string
  vars: Vars
  assertions: Array<SnapshotAssertion<Vars>>
  tags: Record<string, string>
  metadata: Record<string, unknown>
}

export type PromptSnapshotExecutor<
  Vars extends Record<string, SnapshotVariableValue> = Record<string, SnapshotVariableValue>
> = (
  input: RenderedPromptSnapshotCase<Vars>,
  context: EvaluationExecutionContext<RenderedPromptSnapshotCase<Vars>>
) => Promise<string | EvaluationSolution<string>>
