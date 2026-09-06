// New: read-only adapter from the privileged native journal to shared evaluation metrics.
import { type NativeOutcomeEvent, type NativeOutcomeWindow, nativeOutcomeMetrics } from "@openclaw/evaluation"
import type { NativeEvidenceStore } from "./store.js"
export function nativeOutcomeReport(store: NativeEvidenceStore, window?: NativeOutcomeWindow) {
  const events = store.db
    .prepare(
      "SELECT id,kind,subject,data,created_at FROM native_events WHERE kind LIKE 'workflow.%' OR kind IN ('persona.proposed','proposal.decided','migration.adopted') ORDER BY id"
    )
    .all()
    .map((row) => ({
      id: Number(row.id),
      kind: String(row.kind),
      subject: String(row.subject),
      data: JSON.parse(String(row.data)),
      createdAt: Number(row.created_at)
    })) as NativeOutcomeEvent[]
  const now = Date.now()
  return nativeOutcomeMetrics(events, window ?? { from: 0, to: now, asOf: now, retentionMs: 86400000 })
}
