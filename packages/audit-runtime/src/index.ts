import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname } from "node:path"

export type AuditEventType =
  | "profile-installed"
  | "queue-refreshed"
  | "job-started"
  | "job-finished"
  | "run-started"
  | "run-finished"
  | "runtime-reset"
  | "duplicates-pruned"
  | "stale-runs-recovered"
  | "orchestra-planned"
  | "task-claimed"
  | "task-reclaimed"
  | "team-route-deferred"
  | "lane-blocked"
  | "lease-expired"
  | "recovery-performed"
  | "review-transition"
  | "promotion-transition"
  | "handoff-consumed"
  | "planner-run-finished"
  | "planner-run-failed"
  | "planner-capacity-skipped"
  | "repo-health-guard-suppressed"
  | "db-backup-created"
  | "db-compaction-finished"
  | "memory-governed-write"
  | "memory-governed-reject"
  | "memory-governed-delete"

export interface AuditEventRecord {
  ts: string
  event: AuditEventType
  data: Record<string, unknown>
}

export class AuditWriter {
  constructor(private readonly path: string) {}

  append(event: AuditEventType, data: Record<string, unknown>): AuditEventRecord {
    mkdirSync(dirname(this.path), { recursive: true })
    const record: AuditEventRecord = {
      ts: new Date().toISOString(),
      event,
      data
    }
    appendFileSync(this.path, JSON.stringify(record) + "\n", "utf8")
    return record
  }

  readRecent(limit = 50): AuditEventRecord[] {
    if (!existsSync(this.path)) return []
    return readFileSync(this.path, "utf8")
      .split("\n")
      .filter(Boolean)
      .slice(-limit)
      .map((line) => JSON.parse(line) as AuditEventRecord)
  }
}
