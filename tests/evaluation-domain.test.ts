import { deriveMemoryLifecycleStatus } from "@openclaw/domain"
import { runRetrievalEvaluation } from "@openclaw/evaluation"
import { describe, expect, it } from "vitest"

describe("domain evaluation helpers", () => {
  it("derives generic memory lifecycle status", () => {
    expect(
      deriveMemoryLifecycleStatus({
        chunkCount: 0,
        missingEmbeddingCount: 0,
        persistedStatus: null
      })
    ).toBe("not_started")

    expect(
      deriveMemoryLifecycleStatus({
        chunkCount: 4,
        missingEmbeddingCount: 2,
        persistedStatus: null
      })
    ).toBe("stale")

    expect(
      deriveMemoryLifecycleStatus({
        chunkCount: 4,
        missingEmbeddingCount: 0,
        persistedStatus: "processing"
      })
    ).toBe("processing")
  })

  it("passes and fails retrieval thresholds explicitly", async () => {
    const dataset = {
      manifest: {
        datasetVersion: "retrieval-v1",
        createdAt: "2026-04-06",
        status: "active" as const,
        description: "Synthetic retrieval set",
        sourceCorpusFingerprint: "sha256:test",
        queryCount: 2,
        slices: { intent: { regression: 2 } },
        annotationGuidelinesVersion: "v1",
        notes: []
      },
      cases: [
        {
          id: "q1",
          query: "auth boundary",
          expectedSourceRefs: ["decision:auth-boundary"],
          metadata: {}
        },
        {
          id: "q2",
          query: "queue sweep",
          expectedSourceRefs: ["run:queue-sweep"],
          metadata: {}
        }
      ]
    }

    const passing = await runRetrievalEvaluation(
      dataset,
      {
        minimumCaseCount: 2,
        minimumExpectationCoverage: 1,
        metrics: [
          { metric: "recall_at_k", min: 1 },
          { metric: "mrr", min: 1 }
        ]
      },
      async (item) => [{ sourceRef: item.expectedSourceRefs[0]! }]
    )

    expect(passing.summary.pass).toBe(true)

    const failing = await runRetrievalEvaluation(
      dataset,
      {
        minimumCaseCount: 2,
        minimumExpectationCoverage: 1,
        metrics: [
          { metric: "recall_at_k", min: 1 },
          { metric: "mrr", min: 1 }
        ]
      },
      async () => [{ sourceRef: "wrong-ref" }]
    )

    expect(failing.summary.pass).toBe(false)
    expect(failing.summary.failures.some((failure) => failure.includes("recall_at_k"))).toBe(true)
  })
})
