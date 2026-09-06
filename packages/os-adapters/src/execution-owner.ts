/** Cooperative single-host execution ownership, outside candidate repositories. */
import { AsyncLocalStorage } from "node:async_hooks"
import { createHash, randomUUID } from "node:crypto"
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join, relative, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
export type ExecutionOwner = "legacy" | "native" | "paused"
export interface ExecutionOwnership {
  repository: string
  owner: ExecutionOwner
  generation: number
  planDigest: string | null
}
export class ExecutionOwnershipError extends Error {}
function canonical(repository: string): string {
  return existsSync(repository) ? realpathSync(repository) : resolve(repository)
}
export function executionControlRoot(): string {
  const root = process.env.OPENCLAW_CONTROL_ROOT ?? join(homedir(), ".openclaw", "control")
  if (!isAbsolute(root)) throw new ExecutionOwnershipError("Execution control root must be absolute")
  return resolve(root)
}
export class ExecutionOwnerStore {
  readonly db: DatabaseSync
  constructor(
    readonly root = executionControlRoot(),
    private readonly clock: () => number = Date.now
  ) {
    if (!isAbsolute(root)) throw new ExecutionOwnershipError("Execution control root must be absolute")
    mkdirSync(root, { recursive: true, mode: 0o700 })
    const stat = lstatSync(root)
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.mode & 0o077 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new ExecutionOwnershipError("Execution control root must be a private operator-owned directory")
    const path = join(root, "execution-owners.db")
    if (!existsSync(path)) {
      try {
        writeFileSync(path, "", { flag: "wx", mode: 0o600 })
      } catch (error) {
        if (!existsSync(path)) throw error
      }
    }
    const file = lstatSync(path)
    if (
      !file.isFile() ||
      file.isSymbolicLink() ||
      file.mode & 0o077 ||
      (process.getuid && file.uid !== process.getuid())
    )
      throw new ExecutionOwnershipError("Execution ownership database must be a private operator-owned file")
    this.db = new DatabaseSync(path)
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS execution_owners(repository TEXT PRIMARY KEY,owner TEXT NOT NULL,generation INTEGER NOT NULL,plan_digest TEXT);
      CREATE TABLE IF NOT EXISTS execution_owner_leases(id TEXT PRIMARY KEY,repository TEXT NOT NULL,owner TEXT NOT NULL,generation INTEGER NOT NULL,expires_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS execution_owner_active ON execution_owner_leases(repository,expires_at);
      CREATE TABLE IF NOT EXISTS execution_owner_events(id INTEGER PRIMARY KEY AUTOINCREMENT,repository TEXT NOT NULL,generation INTEGER NOT NULL,owner TEXT NOT NULL,reason TEXT NOT NULL,created_at INTEGER NOT NULL);`)
    for (const suffix of ["", "-wal", "-shm"]) if (existsSync(path + suffix)) chmodSync(path + suffix, 0o600)
  }
  close(): void {
    this.db.close()
  }
  private repository(repository: string): string {
    const repo = canonical(repository),
      root = realpathSync(this.root),
      path = relative(repo, root)
    if (!path || (!path.startsWith("..") && !isAbsolute(path)))
      throw new ExecutionOwnershipError("Execution ownership must be outside the candidate repository")
    return repo
  }
  read(repository: string): ExecutionOwnership | null {
    const repo = this.repository(repository),
      row = this.db.prepare("SELECT * FROM execution_owners WHERE repository=?").get(repo)
    if (!row) return null
    if (
      !["legacy", "native", "paused"].includes(String(row.owner)) ||
      !Number.isSafeInteger(Number(row.generation)) ||
      Number(row.generation) < 1
    )
      throw new ExecutionOwnershipError("Corrupt execution ownership record; operator recovery required")
    return {
      repository: repo,
      owner: String(row.owner) as ExecutionOwner,
      generation: Number(row.generation),
      planDigest: row.plan_digest === null ? null : String(row.plan_digest)
    }
  }
  claim(repository: string, owner: "legacy" | "native", bootstrapOwner = owner): ExecutionOwnership {
    const repo = this.repository(repository)
    this.db
      .prepare("INSERT INTO execution_owners VALUES (?,?,1,NULL) ON CONFLICT(repository) DO NOTHING")
      .run(repo, bootstrapOwner)
    const state = this.read(repo)!
    if (state.owner !== owner)
      throw new ExecutionOwnershipError(`Project execution belongs to ${state.owner}; generation ${state.generation}`)
    return state
  }
  acquire(repository: string, owner: "legacy" | "native", ttlMs = 120_000): { id: string; state: ExecutionOwnership } {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new ExecutionOwnershipError("Invalid owner lease TTL")
    this.db.exec("BEGIN IMMEDIATE")
    try {
      const bootstrap =
        owner === "native" && existsSync(join(repository, ".openclaw", "dispatcher.db")) ? "legacy" : owner
      const state = this.claim(repository, owner, bootstrap),
        id = randomUUID()
      this.db
        .prepare("INSERT INTO execution_owner_leases VALUES (?,?,?,?,?)")
        .run(id, state.repository, owner, state.generation, this.clock() + ttlMs)
      this.db.exec("COMMIT")
      return { id, state }
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }
  assert(lease: { id: string; state: ExecutionOwnership }): void {
    const state = this.read(lease.state.repository)
    if (
      !state ||
      state.owner !== lease.state.owner ||
      state.generation !== lease.state.generation ||
      !this.db.prepare("SELECT 1 FROM execution_owner_leases WHERE id=? AND expires_at>?").get(lease.id, this.clock())
    )
      throw new ExecutionOwnershipError("Execution ownership generation or lease was revoked")
  }
  renew(lease: { id: string; state: ExecutionOwnership }, ttlMs: number): void {
    this.assert(lease)
    this.db.prepare("UPDATE execution_owner_leases SET expires_at=? WHERE id=?").run(this.clock() + ttlMs, lease.id)
  }
  release(id: string): void {
    this.db.prepare("DELETE FROM execution_owner_leases WHERE id=?").run(id)
  }
  transfer(
    repository: string,
    expectedGeneration: number,
    owner: ExecutionOwner,
    planDigest: string,
    reason: string
  ): ExecutionOwnership {
    if (!/^[a-f0-9]{64}$/.test(planDigest) || !reason.trim())
      throw new ExecutionOwnershipError("Exact reviewed ownership plan and reason required")
    const repo = this.repository(repository)
    this.db.exec("BEGIN IMMEDIATE")
    try {
      const previous = this.read(repo)
      if (
        previous?.owner === owner &&
        previous.planDigest === planDigest &&
        previous.generation === expectedGeneration + 1
      ) {
        this.db.exec("COMMIT")
        return previous
      }
      if ((previous?.generation ?? 0) !== expectedGeneration)
        throw new ExecutionOwnershipError("Ownership plan is stale")
      if (owner !== "paused" && previous?.owner !== "paused")
        throw new ExecutionOwnershipError("Ownership changes must drain through paused state")
      if (owner !== "paused" && previous?.planDigest !== planDigest)
        throw new ExecutionOwnershipError("Ownership handoff plan changed")
      if (
        this.db
          .prepare("SELECT 1 FROM execution_owner_leases WHERE repository=? AND expires_at>? LIMIT 1")
          .get(repo, this.clock())
      )
        throw new ExecutionOwnershipError("Execution owner still has live work; pause and drain it before cutover")
      this.db
        .prepare(
          "INSERT INTO execution_owners VALUES (?,?,?,?) ON CONFLICT(repository) DO UPDATE SET owner=excluded.owner,generation=excluded.generation,plan_digest=excluded.plan_digest"
        )
        .run(repo, owner, expectedGeneration + 1, planDigest)
      this.db
        .prepare("INSERT INTO execution_owner_events(repository,generation,owner,reason,created_at) VALUES (?,?,?,?,?)")
        .run(repo, expectedGeneration + 1, owner, reason, this.clock())
      this.db.exec("COMMIT")
      return this.read(repo)!
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }
}
interface OwnerScope {
  store: ExecutionOwnerStore
  lease: { id: string; state: ExecutionOwnership }
  finished: boolean
  parent: OwnerScope | undefined
}
const context = new AsyncLocalStorage<OwnerScope>()
export function assertExecutionOwnership(): void {
  let scope = context.getStore()
  while (scope) {
    if (scope.finished) throw new ExecutionOwnershipError("Execution owner scope finished")
    scope.store.assert(scope.lease)
    scope = scope.parent
  }
}
export function holdsExecutionOwner(repository: string, owner: "legacy" | "native"): boolean {
  let scope = context.getStore()
  const repo = canonical(repository)
  while (scope) {
    if (scope.lease.state.repository === repo && scope.lease.state.owner === owner) {
      assertExecutionOwnership()
      return true
    }
    scope = scope.parent
  }
  return false
}
export async function withExecutionOwner<T>(
  repository: string,
  owner: "legacy" | "native",
  action: () => Promise<T>
): Promise<T> {
  if (holdsExecutionOwner(repository, owner)) return action()
  assertExecutionOwnership()
  const store = new ExecutionOwnerStore()
  let lease: ReturnType<ExecutionOwnerStore["acquire"]>
  try {
    lease = store.acquire(repository, owner)
  } catch (error) {
    store.close()
    throw error
  }
  const scope: OwnerScope = { store, lease, finished: false, parent: context.getStore() }
  const timer = setInterval(() => {
    try {
      store.renew(lease, 120_000)
    } catch {
      scope.finished = true
    }
  }, 30_000)
  timer.unref()
  try {
    return await context.run(scope, async () => {
      assertExecutionOwnership()
      const result = await action()
      assertExecutionOwnership()
      return result
    })
  } finally {
    scope.finished = true
    clearInterval(timer)
    store.release(lease.id)
    store.close()
  }
}
/** Read-only plan lookup never initializes the operator control root. */
export function readExecutionOwnership(repository: string): ExecutionOwnership | null {
  const path = join(executionControlRoot(), "execution-owners.db")
  if (!existsSync(path)) return null
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const row = db.prepare("SELECT * FROM execution_owners WHERE repository=?").get(canonical(repository))
    return row
      ? {
          repository: canonical(repository),
          owner: String(row.owner) as ExecutionOwner,
          generation: Number(row.generation),
          planDigest: row.plan_digest === null ? null : String(row.plan_digest)
        }
      : null
  } finally {
    db.close()
  }
}
export function executionOwnershipPlanDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}
