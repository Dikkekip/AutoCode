import { randomUUID } from "node:crypto"
import { chmodSync, mkdirSync } from "node:fs"
import { dirname, isAbsolute } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { digest } from "./personas.js"

export interface T3Lease {
  projectId: string
  owner: string
  fence: number
}

export interface T3Record<T> {
  version: number
  value: T
}

export interface T3Effect {
  id: string
  projectId: string
  tool: string
  arguments: Record<string, unknown>
  status: "prepared" | "uncertain" | "confirmed" | "reconciled-absent"
  result: Record<string, unknown> | null
}

export class T3OwnershipLost extends Error {}
export class T3RevisionConflict extends Error {}

/** AutoCode policy/evidence journal; never open or modify T3's own state database. */
export class T3Journal {
  readonly db: DatabaseSync
  readonly owner = randomUUID()
  private transactionLease: T3Lease | undefined

  constructor(
    readonly path: string,
    private readonly clock: () => number = Date.now
  ) {
    if (!isAbsolute(path)) throw new Error("T3 journal requires an absolute private state path")
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    const applicationId = Number(this.db.prepare("PRAGMA application_id").get()?.application_id)
    const version = Number(this.db.prepare("PRAGMA user_version").get()?.user_version)
    const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
    if ((applicationId !== 0x41543331 && (applicationId !== 0 || tables.length > 0)) || version > 1) {
      this.db.close()
      throw new Error("Not a supported AutoCode T3 journal; refusing another application's database")
    }
    chmodSync(path, 0o600)
    this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; BEGIN IMMEDIATE")
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS leases(project TEXT PRIMARY KEY, owner TEXT NOT NULL,
          fence INTEGER NOT NULL, expires INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS records(project TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL,
          version INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(project,kind,id));
        CREATE TABLE IF NOT EXISTS events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          project TEXT NOT NULL, kind TEXT NOT NULL, subject TEXT NOT NULL, data TEXT NOT NULL, created INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS effects(id TEXT PRIMARY KEY, project TEXT NOT NULL,
          payload_hash TEXT NOT NULL, data TEXT NOT NULL);
        PRAGMA application_id=1096037169;
        PRAGMA user_version=1;
        COMMIT;
      `)
    } catch (error) {
      this.db.exec("ROLLBACK")
      this.db.close()
      throw error
    }
  }

  close(): void {
    this.db.close()
  }

  acquire(projectId: string, ttlMs = 60_000): T3Lease | null {
    if (!projectId.trim() || !Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new Error("Invalid project lease")
    const now = this.clock()
    const row = this.db
      .prepare(`INSERT INTO leases(project,owner,fence,expires) VALUES(?,?,1,?)
        ON CONFLICT(project) DO UPDATE SET owner=excluded.owner,fence=leases.fence+1,expires=excluded.expires
        WHERE leases.expires<=? RETURNING fence`)
      .get(projectId, this.owner, now + ttlMs, now)
    return row ? { projectId, owner: this.owner, fence: Number(row.fence) } : null
  }

  assertOwner(lease: T3Lease, reserveMs = 0): void {
    if (!Number.isSafeInteger(reserveMs) || reserveMs < 0) throw new Error("Invalid lease time reservation")
    const current = this.db.prepare("SELECT owner,fence,expires FROM leases WHERE project=?").get(lease.projectId)
    if (
      lease.owner !== this.owner ||
      !current ||
      current.owner !== lease.owner ||
      Number(current.fence) !== lease.fence ||
      Number(current.expires) <= this.clock() + reserveMs
    )
      throw new T3OwnershipLost(`Project ownership lost: ${lease.projectId}`)
  }

  renew(lease: T3Lease, ttlMs = 60_000): void {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new Error("Invalid lease duration")
    this.transaction(lease, () => {
      this.db.prepare("UPDATE leases SET expires=? WHERE project=?").run(this.clock() + ttlMs, lease.projectId)
    })
  }

  release(lease: T3Lease): void {
    if (lease.owner !== this.owner) throw new T3OwnershipLost("Cannot release another owner's lease")
    const result = this.db
      .prepare("UPDATE leases SET expires=0 WHERE project=? AND owner=? AND fence=? AND expires>?")
      .run(lease.projectId, lease.owner, lease.fence, this.clock())
    if (result.changes !== 1) throw new T3OwnershipLost("Cannot release an expired or replaced lease")
  }

  transaction<T>(lease: T3Lease, action: () => T): T {
    if (this.transactionLease) throw new Error("Nested journal transaction is not supported")
    this.db.exec("BEGIN IMMEDIATE")
    try {
      this.assertOwner(lease)
      this.transactionLease = lease
      const result = action()
      if (result && typeof (result as { then?: unknown }).then === "function")
        throw new Error("Journal transaction must be synchronous")
      // An action may exhaust the lease while computing; never commit with stale authority.
      this.assertOwner(lease)
      this.db.exec("COMMIT")
      return result
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    } finally {
      this.transactionLease = undefined
    }
  }

  read<T>(projectId: string, kind: string, id: string): T3Record<T> | null {
    const row = this.db
      .prepare("SELECT version,data FROM records WHERE project=? AND kind=? AND id=?")
      .get(projectId, kind, id)
    return row ? { version: Number(row.version), value: JSON.parse(String(row.data)) as T } : null
  }

  list<T>(projectId: string, kind: string): Array<{ id: string } & T3Record<T>> {
    return this.db
      .prepare("SELECT id,version,data FROM records WHERE project=? AND kind=? ORDER BY id")
      .all(projectId, kind)
      .map((row) => ({ id: String(row.id), version: Number(row.version), value: JSON.parse(String(row.data)) as T }))
  }

  write<T>(kind: string, id: string, value: T, expectedVersion: number): number {
    const lease = this.requireTransaction()
    const previous = this.read(lease.projectId, kind, id)
    if ((previous?.version ?? 0) !== expectedVersion) throw new T3RevisionConflict(`${kind}/${id} changed`)
    const version = expectedVersion + 1
    this.db
      .prepare(`INSERT INTO records(project,kind,id,version,data) VALUES(?,?,?,?,?)
        ON CONFLICT(project,kind,id) DO UPDATE SET version=excluded.version,data=excluded.data`)
      .run(lease.projectId, kind, id, version, JSON.stringify(value))
    this.event(kind, id, { version, value })
    return version
  }

  event(kind: string, subject: string, data: unknown): void {
    const lease = this.requireTransaction()
    this.db
      .prepare("INSERT INTO events(project,kind,subject,data,created) VALUES(?,?,?,?,?)")
      .run(lease.projectId, kind, subject, JSON.stringify(data), this.clock())
  }

  reserveEffect(lease: T3Lease, id: string, tool: string, arguments_: Record<string, unknown>): T3Effect {
    return this.transaction(lease, () => {
      const payloadHash = digest({ projectId: lease.projectId, tool, arguments: arguments_ })
      const row = this.db.prepare("SELECT payload_hash,data FROM effects WHERE id=?").get(id)
      if (row) {
        if (row.payload_hash !== payloadHash) throw new Error("Effect identity reused with different payload")
        return JSON.parse(String(row.data)) as T3Effect
      }
      const effect: T3Effect = {
        id,
        projectId: lease.projectId,
        tool,
        arguments: arguments_,
        status: "prepared",
        result: null
      }
      this.db
        .prepare("INSERT INTO effects(id,project,payload_hash,data) VALUES(?,?,?,?)")
        .run(id, lease.projectId, payloadHash, JSON.stringify(effect))
      this.event("effect.prepared", id, { tool, payloadHash })
      return effect
    })
  }

  effect(id: string): T3Effect | null {
    const row = this.db.prepare("SELECT data FROM effects WHERE id=?").get(id)
    return row ? (JSON.parse(String(row.data)) as T3Effect) : null
  }

  effects(projectId: string): T3Effect[] {
    return this.db
      .prepare("SELECT data FROM effects WHERE project=? ORDER BY id")
      .all(projectId)
      .map((row) => JSON.parse(String(row.data)) as T3Effect)
  }

  /** Persist uncertainty BEFORE sending. A lost reply must be reconciled, never blindly replayed. */
  markEffect(
    lease: T3Lease,
    id: string,
    expected: T3Effect["status"],
    status: T3Effect["status"],
    result: Record<string, unknown> | null = null
  ): void {
    this.transaction(lease, () => {
      const effect = this.effect(id)
      if (!effect || effect.projectId !== lease.projectId || effect.status !== expected)
        throw new T3RevisionConflict("Effect changed or belongs to another project")
      const allowed =
        (expected === "prepared" && status === "uncertain") ||
        (expected === "uncertain" && (status === "confirmed" || status === "reconciled-absent"))
      if (!allowed || (status === "confirmed" && result === null)) throw new Error("Invalid effect transition")
      this.db.prepare("UPDATE effects SET data=? WHERE id=?").run(JSON.stringify({ ...effect, status, result }), id)
      this.event(`effect.${status}`, id, { result })
    })
  }

  private requireTransaction(): T3Lease {
    if (!this.transactionLease) throw new Error("Journal writes require a fenced ownership transaction")
    this.assertOwner(this.transactionLease)
    return this.transactionLease
  }
}
