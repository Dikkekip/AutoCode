import { AsyncLocalStorage } from "node:async_hooks"
import { randomUUID } from "node:crypto"
import { chmodSync, existsSync, mkdirSync } from "node:fs"
import { dirname, isAbsolute } from "node:path"
import { backup, DatabaseSync } from "node:sqlite"
import {
  type NativeLifecycle,
  type NativeLifecycleEvidence,
  nextNativeAttempt,
  recoverNativeLifecycle,
  transitionNativeLifecycle,
  validateNativeLifecycle
} from "@openclaw/domain"
export interface NativeLease {
  readonly id: string
  readonly owner: string
  readonly token: number
  /** Acquisition expiry snapshot; ownership always checks the current persisted expiry. */
  readonly expiresAt: number
}
export class NativeLeaseLost extends Error {
  constructor(id: string) {
    super(`Native lease lost: ${id}`)
  }
}
export class NativeRevisionConflict extends Error {}
export interface NativeRecordWrite {
  kind: string
  id: string
  value: unknown
  expectedVersion?: number
}
interface NativeLeaseScope {
  lease: NativeLease
  finished: boolean
  parent: NativeLeaseScope | undefined
}
/** Evidence and reconciliation journal only. Workboard remains the task queue. */
export class NativeEvidenceStore {
  readonly db: DatabaseSync
  readonly owner = randomUUID()
  private readonly versions = new WeakMap<object, number>()
  private readonly context = new AsyncLocalStorage<NativeLeaseScope>()
  constructor(
    readonly path: string,
    private readonly clock: () => number = Date.now
  ) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    const version = Number(this.db.prepare("PRAGMA user_version").get()?.user_version)
    if (version < 0 || version > 1) {
      this.db.close()
      throw new Error(`Unsupported native evidence schema ${version}; use a compatible runtime or verified backup`)
    }
    this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; BEGIN IMMEDIATE")
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS native_records (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
          updated_at INTEGER NOT NULL, PRIMARY KEY(kind,id));
        CREATE TABLE IF NOT EXISTS native_events (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL,
          subject TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS native_versions (kind TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY(kind,id));
        CREATE TABLE IF NOT EXISTS native_locks (id TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS native_records_history ON native_records(kind,updated_at,id);
        CREATE INDEX IF NOT EXISTS native_events_subject ON native_events(subject,id);
        CREATE INDEX IF NOT EXISTS native_events_history ON native_events(created_at,id);
      `)
      if (
        !this.db
          .prepare("PRAGMA table_info(native_locks)")
          .all()
          .some((r) => r.name === "token")
      )
        this.db.exec("ALTER TABLE native_locks ADD COLUMN token INTEGER NOT NULL DEFAULT 0")
      this.db.exec("PRAGMA user_version=1; COMMIT")
      for (const file of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(file)) chmodSync(file, 0o600)
    } catch (error) {
      this.db.exec("ROLLBACK")
      this.db.close()
      throw error
    }
  }
  private decode<T>(kind: string, id: string, raw: unknown): T {
    try {
      const value = JSON.parse(String(raw))
      if (value === null || typeof value !== "object" || Array.isArray(value))
        throw new Error("expected a JSON record object")
      if (kind === "workflow" && value.lifecycle) validateNativeLifecycle(value.lifecycle, value)
      return value as T
    } catch (error) {
      throw new Error(
        `Invalid native evidence record ${kind}:${id}; restore verified evidence or perform reviewed recovery (${String(error)})`
      )
    }
  }
  /** Stable bounded history query; cursor is scoped to the requested record kind. */
  page<T>(kind: string, options: { limit?: number; after?: { kind: string; updatedAt: number; id: string } } = {}) {
    const limit = options.limit ?? 100
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("Native page limit must be 1..1000")
    const after = options.after
    if (after && (after.kind !== kind || !Number.isFinite(after.updatedAt) || typeof after.id !== "string"))
      throw new Error("Invalid native history cursor")
    const rows = this.db
      .prepare(`SELECT r.id,r.data,r.updated_at,COALESCE(v.version,0) AS version
      FROM native_records r LEFT JOIN native_versions v ON v.kind=r.kind AND v.id=r.id
      WHERE r.kind=? AND (r.updated_at>? OR (r.updated_at=? AND r.id>?)) ORDER BY r.updated_at,r.id LIMIT ?`)
      .all(kind, after?.updatedAt ?? -1, after?.updatedAt ?? -1, after?.id ?? "", limit + 1)
    const items = rows.slice(0, limit).map((row) => {
      const value = this.decode<T>(kind, String(row.id), row.data)
      if (value && typeof value === "object") this.versions.set(value, Number(row.version))
      return { id: String(row.id), value, updatedAt: Number(row.updated_at) }
    })
    const last = items.at(-1)
    return { items, next: rows.length > limit && last ? { kind, updatedAt: last.updatedAt, id: last.id } : null }
  }
  integrity() {
    const rows = this.db.prepare("PRAGMA integrity_check").all()
    if (rows.length !== 1 || rows[0]?.integrity_check !== "ok") throw new Error("Native SQLite integrity check failed")
    for (const row of this.db.prepare("SELECT kind,id,data FROM native_records").iterate())
      this.decode(String(row.kind), String(row.id), row.data)
    for (const row of this.db.prepare("SELECT id,data FROM native_events").iterate()) {
      try {
        JSON.parse(String(row.data))
      } catch {
        throw new Error(`Invalid native audit event ${row.id}; restore verified evidence`)
      }
    }
    return { ok: true, schemaVersion: Number(this.db.prepare("PRAGMA user_version").get()?.user_version) }
  }
  async backupTo(destination: string) {
    if (!isAbsolute(destination)) throw new Error("Native backup destination must be absolute")
    if (existsSync(destination)) throw new Error("Native backup destination already exists")
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
    this.integrity()
    await backup(this.db, destination)
    chmodSync(destination, 0o600)
    const copy = new NativeEvidenceStore(destination)
    try {
      return { ...copy.integrity(), destination }
    } finally {
      copy.close()
    }
  }
  /** Only explicitly disposable cache records are collectible; authority and operation history are never deleted. */
  pruneCaches(before: number, limit = 100) {
    if (!Number.isFinite(before) || before > this.clock() || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new Error("Invalid native retention boundary")
    let removed = 0
    this.mutate(undefined, () => {
      const rows = this.db
        .prepare(
          "SELECT kind,id FROM native_records WHERE kind='context-cache' AND updated_at<? ORDER BY updated_at,id LIMIT ?"
        )
        .all(before, limit)
      for (const row of rows) {
        this.db.prepare("DELETE FROM native_records WHERE kind=? AND id=?").run(row.kind!, row.id!)
        // Preserve revision tombstones so a stale writer cannot reuse an old version.
        this.db.prepare("UPDATE native_versions SET version=version+1 WHERE kind=? AND id=?").run(row.kind!, row.id!)
        removed++
      }
      this.db
        .prepare("INSERT INTO native_events(kind,subject,data,created_at) VALUES (?,?,?,?)")
        .run("retention.completed", "context-cache", JSON.stringify({ before, removed }), this.clock())
    })
    return { removed, preserved: "workflows, attempts, receipts, operations, events and artifact references" }
  }

  close(): void {
    this.db.close()
  }
  get<T>(kind: string, id: string): T | null {
    const row = this.db
      .prepare(
        "SELECT r.data,COALESCE(v.version,0) AS version FROM native_records r LEFT JOIN native_versions v ON v.kind=r.kind AND v.id=r.id WHERE r.kind=? AND r.id=?"
      )
      .get(kind, id)
    if (!row) return null
    const value = this.decode<T>(kind, id, row.data)
    if (value && typeof value === "object") this.versions.set(value, Number(row.version))
    return value
  }
  version(kind: string, id: string): number {
    return Number(
      this.db.prepare("SELECT version FROM native_versions WHERE kind=? AND id=?").get(kind, id)?.version ?? 0
    )
  }
  /** Atomically persist a state change, its audit event and optional effect intents. */
  commit(
    writes: NativeRecordWrite[],
    event: { kind: string; subject: string; value: unknown },
    lease?: NativeLease,
    guard?: () => void
  ): void {
    const committed: Array<[object, number]> = []
    this.mutate(lease, () => {
      guard?.()
      for (const write of writes) {
        const version = this.version(write.kind, write.id)
        const tracked = write.value && typeof write.value === "object" ? this.versions.get(write.value) : undefined
        const expected = write.expectedVersion ?? (write.kind === "workflow" ? (tracked ?? 0) : undefined)
        if (expected !== undefined && version !== expected)
          throw new NativeRevisionConflict(`Stale native record ${write.kind}:${write.id}`)
        if (write.kind === "workflow" && write.value && typeof write.value === "object") {
          const value = write.value as NativeLifecycleEvidence & { lifecycle?: NativeLifecycle }
          const previous = this.get<NativeLifecycleEvidence & { lifecycle?: NativeLifecycle }>(write.kind, write.id)
          if (previous?.lifecycle && !value.lifecycle) throw new Error("Cannot remove native lifecycle")
          if (value.lifecycle) {
            validateNativeLifecycle(value.lifecycle, value)
            if (previous?.lifecycle) {
              const expectedLifecycle =
                value.recovery?.planDigest && value.recovery.planDigest !== previous.recovery?.planDigest
                  ? recoverNativeLifecycle(previous.lifecycle, value)
                  : value.lifecycle.attemptId === previous.lifecycle.attemptId
                    ? transitionNativeLifecycle(previous.lifecycle, value.lifecycle.state, value)
                    : nextNativeAttempt(previous.lifecycle, value)
              if (JSON.stringify(expectedLifecycle) !== JSON.stringify(value.lifecycle))
                throw new Error("Invalid native attempt transition")
            }
          }
        }
        this.db
          .prepare(
            "INSERT INTO native_records VALUES (?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at"
          )
          .run(write.kind, write.id, JSON.stringify(write.value), this.clock())
        this.db
          .prepare(
            "INSERT INTO native_versions VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET version=excluded.version"
          )
          .run(write.kind, write.id, version + 1)
        if (write.value && typeof write.value === "object") committed.push([write.value, version + 1])
      }
      this.db
        .prepare("INSERT INTO native_events(kind,subject,data,created_at) VALUES (?,?,?,?)")
        .run(event.kind, event.subject, JSON.stringify(event.value), this.clock())
    })
    for (const [value, version] of committed) this.versions.set(value, version)
  }
  put(kind: string, id: string, value: unknown, lease?: NativeLease): void {
    this.commit([{ kind, id, value }], { kind: `${kind}.updated`, subject: id, value: { kind } }, lease)
  }
  list<T>(kind: string): Array<{ id: string; value: T; updatedAt: number }> {
    return this.db
      .prepare(
        "SELECT r.id,r.data,r.updated_at,COALESCE(v.version,0) AS version FROM native_records r LEFT JOIN native_versions v ON v.kind=r.kind AND v.id=r.id WHERE r.kind=? ORDER BY r.updated_at,r.id"
      )
      .all(kind)
      .map((r) => {
        const value = this.decode<T>(kind, String(r.id), r.data)
        if (value && typeof value === "object") this.versions.set(value, Number(r.version))
        return { id: String(r.id), value, updatedAt: Number(r.updated_at) }
      })
  }
  event(kind: string, subject: string, value: unknown, lease?: NativeLease): void {
    this.mutate(lease, () => {
      this.db
        .prepare("INSERT INTO native_events(kind,subject,data,created_at) VALUES (?,?,?,?)")
        .run(kind, subject, JSON.stringify(value), this.clock())
    })
  }
  acquire(id: string, ttlMs: number): NativeLease | null {
    this.validateTtl(ttlMs)
    const now = this.clock()
    const row = this.db
      .prepare(`INSERT INTO native_locks(id,owner,expires_at,token) VALUES (?,?,?,1)
      ON CONFLICT(id) DO UPDATE SET owner=excluded.owner, expires_at=excluded.expires_at,
      token=native_locks.token+1 WHERE native_locks.expires_at <= ? RETURNING token`)
      .get(id, this.owner, now + ttlMs, now)
    return row ? Object.freeze({ id, owner: this.owner, token: Number(row.token), expiresAt: now + ttlMs }) : null
  }
  renew(lease: NativeLease, ttlMs: number): boolean {
    this.validateTtl(ttlMs)
    if (lease.owner !== this.owner) return false
    const now = this.clock()
    return (
      this.db
        .prepare(`UPDATE native_locks SET expires_at=?
      WHERE id=? AND owner=? AND token=? AND expires_at>?`)
        .run(now + ttlMs, lease.id, lease.owner, lease.token, now).changes === 1
    )
  }
  release(lease: NativeLease): void {
    if (lease.owner !== this.owner) return
    // Keep the row: deleting it would allow fencing tokens to be reused (ABA).
    this.db
      .prepare("UPDATE native_locks SET expires_at=0 WHERE id=? AND owner=? AND token=?")
      .run(lease.id, lease.owner, lease.token)
  }
  assertOwnership(lease: NativeLease): void {
    if (
      lease.owner !== this.owner ||
      !this.db
        .prepare("SELECT 1 FROM native_locks WHERE id=? AND owner=? AND token=? AND expires_at>?")
        .get(lease.id, lease.owner, lease.token, this.clock())
    )
      throw new NativeLeaseLost(lease.id)
  }
  holdsLease(id: string): boolean {
    let scope = this.context.getStore()
    while (scope) {
      if (scope.lease.id === id) {
        this.authorizeEffect()
        return true
      }
      scope = scope.parent
    }
    return false
  }
  get activeLease(): NativeLease | undefined {
    return this.context.getStore()?.lease
  }
  /** Check immediately before initiating an effect; in-flight remote work cannot be revoked. */
  authorizeEffect(): void {
    let scope = this.context.getStore()
    while (scope) {
      if (scope.finished) throw new NativeLeaseLost(scope.lease.id)
      this.assertOwnership(scope.lease)
      scope = scope.parent
    }
  }
  /** Async descendants inherit fencing, including helpers that write evidence or initiate effects. */
  async withLease<T>(lease: NativeLease, ttlMs: number, action: () => Promise<T>): Promise<T> {
    this.validateTtl(ttlMs)
    this.authorizeEffect()
    this.assertOwnership(lease)
    const scope: NativeLeaseScope = { lease, finished: false, parent: this.context.getStore() }
    const timer = setInterval(
      () => {
        try {
          if (!this.renew(lease, ttlMs)) scope.finished = true
        } catch {
          scope.finished = true
        }
        if (scope.finished) clearInterval(timer)
      },
      Math.max(1, Math.floor(ttlMs / 3))
    )
    timer.unref()
    try {
      return await this.context.run(scope, async () => {
        const result = await action()
        this.authorizeEffect()
        return result
      })
    } finally {
      scope.finished = true
      clearInterval(timer)
      this.release(lease)
    }
  }
  private validateTtl(ttlMs: number): void {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error("Lease TTL must be a positive integer")
  }
  /** Fence synchronous artifact writes with the same transaction used for evidence. */
  fencedMutation(action: () => void): void {
    this.mutate(undefined, action)
  }
  // A write lock makes ownership validation and the protected mutation indivisible
  // with respect to takeover from other connections and processes.
  private mutate(lease: NativeLease | undefined, action: () => void): void {
    this.db.exec("BEGIN IMMEDIATE")
    try {
      this.authorizeEffect()
      if (lease) this.assertOwnership(lease)
      action()
      this.db.exec("COMMIT")
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }
}
