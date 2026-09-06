// New: schema upgrade, bounded reads and authority-preserving retention fixtures.
import { mkdtempSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import { NativeEvidenceStore } from "../packages/core-runtime/src/native/store.js"

const location = () => join(mkdtempSync(join(tmpdir(), "native-maintenance-")), "evidence.db")
describe("native evidence maintenance", () => {
  it("upgrades version zero without losing evidence or live locks and rejects future schemas", () => {
    const path = location()
    const old = new DatabaseSync(path)
    old.exec(
      "CREATE TABLE native_locks(id TEXT PRIMARY KEY,owner TEXT NOT NULL,expires_at INTEGER NOT NULL); INSERT INTO native_locks VALUES ('live','owner',9999999999999)"
    )
    old.close()
    const store = new NativeEvidenceStore(path)
    expect(store.integrity()).toEqual({ ok: true, schemaVersion: 1 })
    expect(store.acquire("live", 1000)).toBeNull()
    expect(statSync(path).mode & 0o777).toBe(0o600)
    store.db.exec("PRAGMA user_version=99")
    store.close()
    expect(() => new NativeEvidenceStore(path)).toThrow(/Unsupported native evidence schema 99/)
  })
  it("rolls back an interrupted version-zero migration and permits a clean retry", () => {
    const path = location()
    const old = new DatabaseSync(path)
    old.exec(
      "CREATE TABLE native_records(kind TEXT,id TEXT,data TEXT,updated_at INTEGER,PRIMARY KEY(kind,id)); CREATE VIEW native_locks AS SELECT 'id' AS id, 'owner' AS owner, 1 AS expires_at"
    )
    old.close()
    expect(() => new NativeEvidenceStore(path)).toThrow()
    const repair = new DatabaseSync(path)
    expect(repair.prepare("PRAGMA user_version").get()?.user_version).toBe(0)
    expect(repair.prepare("SELECT name FROM sqlite_master WHERE name='native_versions'").get()).toBeUndefined()
    repair.exec("DROP VIEW native_locks")
    repair.close()
    const recovered = new NativeEvidenceStore(path)
    expect(recovered.integrity().schemaVersion).toBe(1)
    recovered.close()
  })
  it("backs up a consistent WAL journal and preserves unknown operations through cache retention", async () => {
    let now = 10
    const store = new NativeEvidenceStore(location(), () => now)
    store.put("operation", "deploy", { state: "started", idempotencyKey: "exact-key" })
    store.put("receipt", "release", { sha: "a".repeat(40) })
    store.put("context-cache", "old", { text: "disposable" })
    now = 20
    expect(store.pruneCaches(15).removed).toBe(1)
    expect(store.get("operation", "deploy")).toEqual({ state: "started", idempotencyKey: "exact-key" })
    const path = location()
    await store.backupTo(path)
    const restored = new NativeEvidenceStore(path)
    expect(restored.integrity().ok).toBe(true)
    expect(restored.get("operation", "deploy")).toEqual(store.get("operation", "deploy"))
    expect(restored.get("receipt", "release")).toEqual(store.get("receipt", "release"))
    expect(restored.db.prepare("SELECT count(*) n FROM native_events").get()?.n).toBe(4)
    await expect(store.backupTo(path)).rejects.toThrow(/already exists/)
    restored.close()
    store.close()
  })
  it("bounds pagination with same-time rows and diagnoses malformed evidence", () => {
    const store = new NativeEvidenceStore(location(), () => 10)
    for (let n = 0; n < 7; n++) store.put("history", String(n), { n })
    const first = store.page("history", { limit: 3 })
    const second = store.page("history", { limit: 3, after: first.next! })
    expect(first.items.map((x) => x.id)).toEqual(["0", "1", "2"])
    expect(second.items.map((x) => x.id)).toEqual(["3", "4", "5"])
    expect(() => store.page("other", { after: first.next! })).toThrow(/cursor/)
    expect(() => store.page("history", { limit: 1001 })).toThrow(/limit/)
    store.db.prepare("UPDATE native_records SET data='{' WHERE kind='history' AND id='0'").run()
    expect(() => store.get("history", "0")).toThrow(/Invalid native evidence record history:0/)
    expect(() => store.integrity()).toThrow(/history:0/)
    store.close()
  })
})
