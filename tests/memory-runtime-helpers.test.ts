import type { MemoryChunk } from "@openclaw/domain"
import { describe, expect, it } from "vitest"

import {
  buildCompactionSummary,
  defaultCompactionPolicy,
  selectCompactionCandidates
} from "../packages/memory-runtime/src/compaction.js"
import { normalizeMemoryRecord } from "../packages/memory-runtime/src/record.js"

function memoryChunk(overrides: Partial<MemoryChunk> = {}): MemoryChunk {
  const now = "2026-04-07T10:00:00.000Z"
  return {
    id: "chunk-1",
    projectId: "project-1",
    layer: "run_summaries",
    sourceKind: "run_summary",
    sourceRef: "run:1",
    sourcePath: null,
    audience: "project",
    lifecycleStatus: "ready",
    title: "Chunk",
    content: "Chunk content",
    contentHash: "hash",
    freshnessScore: 0.5,
    expiresAt: null,
    compactedAt: null,
    supersededByChunkId: null,
    provenance: {
      sources: [{ kind: "run", ref: "run:1", capturedAt: now }],
      freshness: { recordedAt: now, score: 0.5 },
      derivation: null,
      tags: []
    },
    retention: {
      preserveDecisionTrace: false,
      preserveRaw: true,
      pinned: false,
      importance: "low",
      retainUntil: null
    },
    metadata: {},
    createdAt: now,
    updatedAt: now,
    ...overrides
  }
}

describe("memory runtime helpers", () => {
  it("keeps decision traces out of compaction candidates", () => {
    const policy = {
      ...defaultCompactionPolicy(),
      maxChunks: 1,
      maxContentChars: 1,
      keepRecent: 0,
      minimumAgeHours: 0
    }

    const decision = memoryChunk({
      id: "decision-1",
      layer: "shared_decisions",
      sourceKind: "shared_decision",
      sourceRef: "decision:boundary",
      audience: "shared",
      retention: {
        preserveDecisionTrace: true,
        preserveRaw: true,
        pinned: true,
        importance: "critical",
        retainUntil: null
      }
    })
    const runA = memoryChunk({ id: "run-a", sourceRef: "run:a", updatedAt: "2026-04-01T10:00:00.000Z" })
    const runB = memoryChunk({ id: "run-b", sourceRef: "run:b", updatedAt: "2026-04-01T09:00:00.000Z" })

    const { candidates, skipped } = selectCompactionCandidates([decision, runA, runB], policy)

    expect(candidates.map((chunk) => chunk.id)).toEqual(["run-a", "run-b"])
    expect(skipped.map((chunk) => chunk.id)).toContain("decision-1")
  })

  it("builds summaries with source refs and preserves provenance during normalization", () => {
    const chunk = memoryChunk({
      title: "Queue sweep fix",
      sourceRef: "run:queue-sweep",
      content: "Detailed fix notes for the queue sweep issue."
    })

    const summary = buildCompactionSummary([chunk])
    expect(summary.title).toContain("1 items")
    expect(summary.content).toContain("Source refs: run:1")

    const record = normalizeMemoryRecord({
      projectId: "project-1",
      layer: "portable_skills",
      sourceKind: "portable_skill",
      sourceRef: "skill:review-checklist",
      sourcePath: "skills/review.md",
      audience: "shared",
      title: "Review checklist",
      content: "Keep failing evidence.\n\n\nDo not overwrite user changes.",
      provenance: {
        sources: [
          { kind: "file", ref: "skills/review.md", path: "skills/review.md", capturedAt: "2026-04-07T10:00:00.000Z" }
        ],
        freshness: { recordedAt: "2026-04-07T10:00:00.000Z", score: 0.9 },
        derivation: {
          kind: "manual",
          sourceChunkIds: [],
          summaryOfSourceRefs: ["skills/review.md"],
          notes: "Imported from fixture."
        },
        tags: ["portable-skill"]
      },
      retention: {
        preserveDecisionTrace: true,
        preserveRaw: true,
        pinned: false,
        importance: "high",
        retainUntil: null
      }
    })

    expect(record.content).toBe("Keep failing evidence.\n\nDo not overwrite user changes.")
    expect(record.provenance.sources[0]?.path).toBe("skills/review.md")
    expect(record.retention.importance).toBe("high")
    expect(record.contentHash).toHaveLength(64)
  })
})
