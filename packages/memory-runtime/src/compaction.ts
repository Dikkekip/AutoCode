import type { MemoryChunk } from "@openclaw/domain"

import type { MemoryCompactionPolicy } from "./index.js"

export function defaultCompactionPolicy(): MemoryCompactionPolicy {
  return {
    enabled: true,
    maxChunks: 200,
    maxContentChars: 20_000,
    keepRecent: 5,
    minimumAgeHours: 24
  }
}

export function isExpired(chunk: MemoryChunk, nowIso = new Date().toISOString()): boolean {
  return Boolean(chunk.expiresAt && chunk.expiresAt <= nowIso)
}

function hoursOld(iso: string): number {
  return (Date.now() - Date.parse(iso)) / (1000 * 60 * 60)
}

export function selectCompactionCandidates(
  chunks: MemoryChunk[],
  policy: MemoryCompactionPolicy
): { candidates: MemoryChunk[]; skipped: MemoryChunk[] } {
  const ordered = [...chunks].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  const totalChars = ordered.reduce((sum, chunk) => sum + chunk.content.length, 0)
  if (!policy.enabled || (ordered.length <= policy.maxChunks && totalChars <= policy.maxContentChars)) {
    return { candidates: [], skipped: ordered }
  }

  const recentIds = new Set(ordered.slice(0, policy.keepRecent).map((chunk) => chunk.id))
  const candidates = ordered.filter((chunk) => {
    if (recentIds.has(chunk.id)) return false
    if (isExpired(chunk)) return false
    if (
      chunk.layer === "shared_decisions" ||
      chunk.layer === "portable_skills" ||
      chunk.layer === "retrieval_eval_reports"
    ) {
      return false
    }
    if (chunk.retention.pinned || chunk.retention.preserveDecisionTrace) return false
    if (chunk.retention.importance === "critical" || chunk.retention.importance === "high") return false
    if (chunk.supersededByChunkId) return false
    return hoursOld(chunk.updatedAt) >= policy.minimumAgeHours
  })

  return {
    candidates,
    skipped: ordered.filter((chunk) => !candidates.some((candidate) => candidate.id === chunk.id))
  }
}

export function buildCompactionSummary(chunks: MemoryChunk[]): { title: string; content: string } {
  const body = chunks
    .map((chunk) => {
      const sources = chunk.provenance.sources.map((source) => source.ref).join(", ") || chunk.sourceRef
      return [
        `## ${chunk.title}`,
        `Layer: ${chunk.layer}`,
        `Source refs: ${sources}`,
        chunk.content.length <= 400 ? chunk.content : `${chunk.content.slice(0, 399).trimEnd()}…`
      ].join("\n")
    })
    .join("\n\n")

  return {
    title: `Compacted memory summary (${chunks.length} items)`,
    content: [
      "This summary preserves older memory that exceeded the retention threshold.",
      "Keep this summary as the resumable trace for the compacted items.",
      body
    ]
      .join("\n\n")
      .trim()
  }
}
