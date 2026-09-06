import { createHash } from "node:crypto"

import type { MemoryProvenance, MemoryRetentionPolicy } from "@openclaw/domain"

import type { MemoryRecordInput } from "./index.js"

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function normalizeWhitespace(value: string): string {
  return value
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

export interface NormalizedMemoryRecord {
  content: string
  contentHash: string
  freshnessScore: number | null
  expiresAt: string | null
  provenance: MemoryProvenance
  retention: MemoryRetentionPolicy
  metadata: Record<string, unknown>
}

export function normalizeMemoryRecord(input: MemoryRecordInput): NormalizedMemoryRecord {
  const content = normalizeWhitespace(input.content)
  return {
    content,
    contentHash: sha256(content),
    freshnessScore: input.freshnessScore ?? input.provenance.freshness.score ?? null,
    expiresAt: input.expiresAt ?? input.provenance.freshness.expiresAt ?? null,
    provenance: input.provenance,
    retention: input.retention,
    metadata: input.metadata ?? {}
  }
}
