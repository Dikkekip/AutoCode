import type {
  RetrievalCandidate,
  RetrievalEvaluationCase,
  RetrievalEvaluationCaseResult,
  RetrievalEvaluationDataset,
  RetrievalEvaluationReport,
  RetrievalEvaluationSummary,
  RetrievalEvaluationThresholds
} from "./types.js"

function expectationCoverage(cases: RetrievalEvaluationCase[]): number {
  if (cases.length === 0) return 0
  const withExpectations = cases.filter((item) => item.expectedSourceRefs.length > 0).length
  return withExpectations / cases.length
}

function evaluateRetrievalCase(
  item: RetrievalEvaluationCase,
  retrieved: RetrievalCandidate[]
): RetrievalEvaluationCaseResult {
  const retrievedSourceRefs = retrieved.map((candidate) => candidate.sourceRef)
  const expected = new Set(item.expectedSourceRefs)
  const matches = retrievedSourceRefs.filter((sourceRef) => expected.has(sourceRef))
  const topHitRank = retrievedSourceRefs.findIndex((sourceRef) => expected.has(sourceRef))

  const recallAtK = expected.size === 0 ? 1 : matches.length / expected.size
  const mrr = topHitRank === -1 ? 0 : 1 / (topHitRank + 1)

  return {
    caseId: item.id,
    query: item.query,
    expectedSourceRefs: item.expectedSourceRefs,
    retrievedSourceRefs,
    topHitRank: topHitRank === -1 ? null : topHitRank + 1,
    recallAtK,
    mrr,
    passed: expected.size === 0 ? true : matches.length > 0
  }
}

function aggregateRetrievalResults(
  dataset: RetrievalEvaluationDataset,
  thresholds: RetrievalEvaluationThresholds,
  results: RetrievalEvaluationCaseResult[]
): RetrievalEvaluationSummary {
  const caseCount = results.length
  const coverage = expectationCoverage(dataset.cases)
  const recallAtK = caseCount === 0 ? 0 : results.reduce((sum, item) => sum + item.recallAtK, 0) / caseCount
  const mrr = caseCount === 0 ? 0 : results.reduce((sum, item) => sum + item.mrr, 0) / caseCount
  const failures: string[] = []

  if ((thresholds.minimumCaseCount ?? 0) > caseCount) {
    failures.push(`case_count=${caseCount} below minimum ${thresholds.minimumCaseCount}`)
  }

  const minimumExpectationCoverage = thresholds.minimumExpectationCoverage ?? 0
  if (coverage < minimumExpectationCoverage) {
    failures.push(`expectation_coverage=${coverage.toFixed(3)} below minimum ${minimumExpectationCoverage}`)
  }

  for (const metric of thresholds.metrics) {
    const value = metric.metric === "recall_at_k" ? recallAtK : metric.metric === "mrr" ? mrr : coverage
    if (value < metric.min) {
      failures.push(`${metric.metric}=${value.toFixed(3)} below minimum ${metric.min}`)
    }
  }

  return {
    caseCount,
    expectationCoverage: coverage,
    recallAtK,
    mrr,
    pass: failures.length === 0,
    failures
  }
}

export async function runRetrievalEvaluation(
  dataset: RetrievalEvaluationDataset,
  thresholds: RetrievalEvaluationThresholds,
  retrieve: (item: RetrievalEvaluationCase) => Promise<RetrievalCandidate[]>
): Promise<RetrievalEvaluationReport> {
  const results: RetrievalEvaluationCaseResult[] = []
  for (const item of dataset.cases) {
    const retrieved = await retrieve(item)
    results.push(evaluateRetrievalCase(item, retrieved))
  }

  return {
    manifest: dataset.manifest,
    generatedAt: new Date().toISOString(),
    thresholds,
    summary: aggregateRetrievalResults(dataset, thresholds, results),
    results
  }
}
