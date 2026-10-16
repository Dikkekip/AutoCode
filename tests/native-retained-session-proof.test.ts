import { createHash } from "node:crypto"
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { afterEach, expect, it, vi } from "vitest"
import { NativeControl } from "../packages/core-runtime/src/native/control.js"
import { assertNativePolicyRemoteIdle } from "../packages/core-runtime/src/native/policy-refresh.js"
import {
  configureNativeRetainedSessionRoot,
  readNativeRetainedSessionProof,
  registeredNativeRetainedSession,
  registerNativeRetainedSession
} from "../packages/core-runtime/src/native/retained-session-proof.js"
import { NativeEvidenceStore } from "../packages/core-runtime/src/native/store.js"

const hooks = vi.hoisted(() => ({
  onOpen: undefined as undefined | ((path: string) => void),
  onPrepare: undefined as undefined | ((sql: string) => void)
}))
vi.mock("node:sqlite", async (original) => {
  const actual = await original<typeof import("node:sqlite")>()
  return {
    ...actual,
    DatabaseSync: class extends actual.DatabaseSync {
      constructor(...args: ConstructorParameters<typeof actual.DatabaseSync>) {
        super(...args)
        hooks.onOpen?.(String(args[0]).startsWith("file:") ? fileURLToPath(String(args[0])) : String(args[0]))
      }
    }
  }
})
const cleanups: Array<() => void> = []
afterEach(() => {
  hooks.onOpen = undefined
  hooks.onPrepare = undefined
  for (const cleanup of cleanups.splice(0)) cleanup()
})
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex")
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "retained-proof-"))
  const agent = join(root, "agents", "research"),
    directory = join(agent, "agent")
  mkdirSync(directory, { recursive: true })
  mkdirSync(join(agent, "sessions"))
  mkdirSync(join(root, "session-sqlite-migration-runs"))
  const manifestId = "startup-migration-724daefb-bdde-8f4c-8f97-0686947b4d30"
  const sessionId = "18238e42-9faa-47ca-8172-192a3ed09405",
    sessionKey = "agent:research:subagent:workboard-board-card",
    runId = "workboard:card:1000"
  const current = join(directory, "openclaw-agent.sqlite"),
    backup = `${current}.pre-${manifestId}.bak`
  const manifestPath = join(root, "session-sqlite-migration-runs", `${manifestId}.json`)
  const nodeSchema =
    "CREATE TABLE session_nodes(session_key TEXT,current_session_id TEXT,entry_json TEXT,entry_valid INTEGER,status TEXT DEFAULT 'failed')"
  const windowSchema =
    "CREATE TABLE session_windows(session_key TEXT,session_id TEXT,plugin_owner_id TEXT,status TEXT,started_at INTEGER,ended_at INTEGER)"
  const original = new DatabaseSync(backup)
  original.exec(nodeSchema + ";" + windowSchema)
  const entry = {
    sessionId,
    pluginOwnerId: "workboard",
    status: "failed",
    lastRunId: runId,
    activeWriterRunId: runId,
    startedAt: 1100,
    endedAt: 2000
  }
  original
    .prepare("INSERT INTO session_nodes(session_key,current_session_id,entry_json,entry_valid) VALUES(?,?,?,1)")
    .run(sessionKey, sessionId, JSON.stringify(entry))
  original
    .prepare("INSERT INTO session_windows VALUES(?,?,?,?,?,?)")
    .run(sessionKey, sessionId, "workboard", "failed", 1100, 2000)
  original.close()
  const archive = Buffer.from("retained immutable compressed transcript fixture")
  const generation = "a".repeat(32),
    archiveName = `${sessionId}.jsonl.deleted.2026-10-15T23-25-30.869Z.${generation}.zst`
  const archivePath = join(agent, "sessions", archiveName)
  writeFileSync(archivePath, archive)
  const live = new DatabaseSync(current)
  live.exec(
    nodeSchema +
      ";" +
      windowSchema +
      ";CREATE TABLE session_transcript_archives(session_id TEXT,session_key TEXT,generation TEXT,reason TEXT,encoding TEXT,archive_sha256 TEXT,archive_name TEXT,archive_blob BLOB,created_at INTEGER,published_at INTEGER)"
  )
  live
    .prepare("INSERT INTO session_transcript_archives VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run(sessionId, sessionKey, generation, "deleted", "zstd", hash(archive), archiveName, archive, 3000, 3100)
  const source = { manifestId, manifestSha256: "", backupSha256: "", sessionId }
  const manifest = { manifestVersion: 3, runId: manifestId, targets: [{ completedMoves: [] as any[] }] }
  const bindOriginal = () => {
    const stat = statSync(backup, { bigint: true })
    source.backupSha256 = hash(readFileSync(backup))
    manifest.targets[0]!.completedMoves = [
      {
        sourcePath: current,
        archivePath: backup,
        kind: "database-backup",
        artifact: {
          classification: "repair-original",
          reason: "pre-startup-migration-backup",
          disposal: { state: "retained" },
          identity: {
            dev: String(stat.dev),
            ino: String(stat.ino),
            mtimeNs: String(stat.mtimeNs),
            size: Number(stat.size),
            sha256: source.backupSha256
          }
        }
      }
    ]
    writeFileSync(manifestPath, JSON.stringify(manifest))
    source.manifestSha256 = hash(readFileSync(manifestPath))
  }
  bindOriginal()
  const card = {
    id: "card",
    boardId: "board",
    title: "Old research",
    status: "blocked",
    agentId: "research",
    sessionKey,
    runId,
    startedAt: 1000,
    execution: { sessionKey, runId, agentId: "research", startedAt: 1000, status: "blocked" },
    metadata: {
      automation: {
        boardId: "board",
        launch: {
          phase: "accepted",
          requestedSessionKey: sessionKey,
          acceptedSessionKey: sessionKey,
          provisionalRunId: runId,
          acceptedRunId: runId,
          preparedAt: 1000,
          acceptedAt: 1050
        }
      },
      attempts: [{ id: runId, runId, sessionKey, status: "blocked", startedAt: 1000, endedAt: 2100 }]
    }
  } as any
  const store = new NativeEvidenceStore(join(root, "native.db"))
  store.put("control", "pause", { paused: true, frozen: false, revision: "owned" })
  const runtime = {
    policy: {
      boardId: "board",
      plannerAgentId: "planner",
      coderAgentId: "coder",
      reviewerAgentId: "reviewer",
      personas: [{ personaId: "research" }]
    },
    store,
    control: new NativeControl(store, () => true),
    withOwnership: async (action: any) => action()
  } as any
  configureNativeRetainedSessionRoot(runtime, root)
  let sessions: any[] = []
  const gateway = {
    request: async (method: string) =>
      method === "workboard.cards.list"
        ? { cards: [card] }
        : { sessions, totalCount: sessions.length, hasMore: false, nextOffset: null }
  } as any
  cleanups.push(() => {
    if (live.isOpen) live.close()
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  return {
    root,
    source,
    runtime,
    card,
    gateway,
    live,
    backup,
    manifestPath,
    manifest,
    bindOriginal,
    archivePath,
    entry,
    sessionKey,
    sessionId,
    runId,
    setSessions: (value: any[]) => {
      sessions = value
    }
  }
}
it("registers verified original terminal closure without resurrecting core rows and uses it only for missing identity", async () => {
  const f = fixture()
  await expect(assertNativePolicyRemoteIdle(f.runtime, f.gateway)).rejects.toThrow(/terminal session proof|missing/)
  const registered = await registerNativeRetainedSession(
    f.runtime,
    f.gateway,
    { cardId: f.card.id, controlRevision: "owned", source: f.source },
    { operatorId: "operator", rationale: "Reviewed immutable original failure and core archive" }
  )
  expect(registered.runId).toBe(f.runId)
  expect(registeredNativeRetainedSession(f.runtime, f.card)?.terminal).toEqual({
    status: "failed",
    startedAt: 1100,
    endedAt: 2000
  })
  expect((await assertNativePolicyRemoteIdle(f.runtime, f.gateway)).retainedCards).toHaveLength(1)
  expect(f.live.prepare("SELECT COUNT(*) AS count FROM session_nodes").get()).toEqual({ count: 0 })
  expect(
    f.runtime.store.db
      .prepare("SELECT COUNT(*) AS count FROM native_events WHERE kind='retained-session.registered'")
      .get()
  ).toEqual({ count: 1 })
})
it.each([
  "manifest",
  "backup",
  "published-archive",
  "no-archive",
  "unpublished",
  "current-node",
  "current-window",
  "backup-sidecar"
])("rejects changed or unavailable trusted source: %s", (kind) => {
  const f = fixture()
  if (kind === "manifest") appendFileSync(f.manifestPath, " ")
  if (kind === "backup") appendFileSync(f.backup, "changed")
  if (kind === "published-archive") appendFileSync(f.archivePath, "changed")
  if (kind === "no-archive") f.live.exec("DELETE FROM session_transcript_archives")
  if (kind === "backup-sidecar") writeFileSync(f.backup + "-wal", "unbound")
  if (kind === "unpublished") f.live.exec("UPDATE session_transcript_archives SET published_at=NULL")
  if (kind === "current-node")
    f.live
      .prepare("INSERT INTO session_nodes(session_key,current_session_id,entry_json,entry_valid) VALUES(?,?,?,1)")
      .run(f.sessionKey, f.sessionId, "{}")
  if (kind === "current-window")
    f.live
      .prepare("INSERT INTO session_windows VALUES(?,?,?,?,?,?)")
      .run(f.sessionKey, f.sessionId, "workboard", "failed", 1100, 2000)
  expect(() => readNativeRetainedSessionProof(f.runtime, f.card, f.source)).toThrow()
})
it.each([
  "run",
  "session",
  "agent",
  "window",
  "nonterminal",
  "missing-ended"
])("rejects source identity or terminal mismatch even if original bytes are reviewed: %s", (kind) => {
  const f = fixture(),
    db = new DatabaseSync(f.backup)
  if (kind === "run") f.entry.lastRunId = "another-run"
  if (kind === "session") f.entry.sessionId = "another-session"
  if (kind === "agent") f.entry.pluginOwnerId = "another-plugin"
  if (kind === "nonterminal") f.entry.status = "running"
  if (kind === "missing-ended") delete (f.entry as any).endedAt
  db.prepare("UPDATE session_nodes SET entry_json=?").run(JSON.stringify(f.entry))
  if (kind === "window") db.exec("UPDATE session_windows SET ended_at=9999")
  db.close()
  f.bindOriginal()
  expect(() => readNativeRetainedSessionProof(f.runtime, f.card, f.source)).toThrow()
})
it("rejects arbitrary source paths, claims and card-only terminal proof", () => {
  const f = fixture()
  expect(() =>
    readNativeRetainedSessionProof(f.runtime, f.card, { ...f.source, manifestId: "../../outside" })
  ).toThrow()
  expect(() =>
    readNativeRetainedSessionProof(f.runtime, f.card, { ...f.source, arbitraryPath: f.backup } as any)
  ).toThrow()
  f.manifest.targets[0]!.completedMoves = []
  writeFileSync(f.manifestPath, JSON.stringify(f.manifest))
  f.source.manifestSha256 = hash(readFileSync(f.manifestPath))
  expect(() => readNativeRetainedSessionProof(f.runtime, f.card, f.source)).toThrow(/completed retained/)
})
it.each([
  "stale-control",
  "resumed",
  "frozen",
  "agent-operator",
  "active-lease",
  "uncertain-effect"
])("registration rejects missing authority/drain: %s", async (kind) => {
  const f = fixture(),
    authority = { operatorId: "operator", rationale: "Reviewed original" }
  if (kind === "stale-control")
    f.runtime.store.put("control", "pause", { paused: true, frozen: false, revision: "new" })
  if (kind === "resumed") f.runtime.store.put("control", "pause", { paused: false, frozen: false, revision: "owned" })
  if (kind === "frozen") f.runtime.store.put("control", "pause", { paused: true, frozen: true, revision: "owned" })
  if (kind === "agent-operator") authority.operatorId = "research"
  if (kind === "active-lease") f.runtime.store.acquire("verification", 60000)
  if (kind === "uncertain-effect") f.runtime.store.put("operation", "effect", { state: "uncertain" })
  await expect(
    registerNativeRetainedSession(
      f.runtime,
      f.gateway,
      { cardId: f.card.id, controlRevision: "owned", source: f.source },
      authority
    )
  ).rejects.toThrow()
  expect(f.runtime.store.get("retained-session-proof", "board:card")).toBeNull()
})
it.each([
  "other-active-agent",
  "active-subagent",
  "present-invalid",
  "missing-pagination"
])("retained proof never masks current activity or incomplete public proof: %s", async (kind) => {
  const f = fixture()
  f.runtime.store.put(
    "retained-session-proof",
    "board:card",
    readNativeRetainedSessionProof(f.runtime, f.card, f.source)
  )
  if (kind === "missing-pagination")
    f.gateway.request = async (method: string) =>
      method === "workboard.cards.list" ? { cards: [f.card] } : { sessions: [], hasMore: false }
  else
    f.setSessions([
      {
        key: kind === "present-invalid" ? f.sessionKey : "other",
        agentId: kind === "present-invalid" ? "research" : "coder",
        status: "failed",
        endedAt: 2000,
        hasActiveRun: kind === "other-active-agent",
        hasActiveSubagentRun: kind === "active-subagent",
        activeRunIds: [],
        ...(kind === "present-invalid" ? { endedAt: undefined } : {})
      }
    ])
  await expect(assertNativePolicyRemoteIdle(f.runtime, f.gateway)).rejects.toThrow()
})
it("revalidates revived current state and changed originals after registration", () => {
  const f = fixture()
  f.runtime.store.put(
    "retained-session-proof",
    "board:card",
    readNativeRetainedSessionProof(f.runtime, f.card, f.source)
  )
  f.live
    .prepare("INSERT INTO session_nodes(session_key,current_session_id,entry_json,entry_valid) VALUES(?,?,?,1)")
    .run(f.sessionKey, f.sessionId, "{}")
  expect(() => registeredNativeRetainedSession(f.runtime, f.card)).toThrow(/revived/)
  f.live.exec("DELETE FROM session_nodes")
  appendFileSync(f.backup, "changed")
  expect(() => registeredNativeRetainedSession(f.runtime, f.card)).toThrow(/identity or hash changed/)
})

it("rejects unbound backup WAL even when the base backup hash is unchanged", () => {
  const f = fixture()
  writeFileSync(f.backup + "-wal", "unbound journal")
  expect(() => readNativeRetainedSessionProof(f.runtime, f.card, f.source)).toThrow(/sidecars/)
})
it("registration rechecks complete owned activity after the first remote snapshot", async () => {
  const f = fixture()
  let listings = 0
  f.gateway.request = async (method: string) => {
    if (method === "workboard.cards.list") return { cards: [f.card] }
    listings++
    const sessions =
      listings > 1
        ? [{ key: "other", agentId: "coder", hasActiveRun: true, activeRunIds: ["live"], status: "running" }]
        : []
    return { sessions, totalCount: sessions.length, hasMore: false, nextOffset: null }
  }
  await expect(
    registerNativeRetainedSession(
      f.runtime,
      f.gateway,
      { cardId: f.card.id, controlRevision: "owned", source: f.source },
      { operatorId: "operator", rationale: "Reviewed original" }
    )
  ).rejects.toThrow(/active or ambiguous/)
  expect(f.runtime.store.get("retained-session-proof", "board:card")).toBeNull()
})
it("registration refuses a control revision change during public drain proof", async () => {
  const f = fixture(),
    request = f.gateway.request
  f.gateway.request = async (method: string) => {
    const value = await request(method)
    if (method === "sessions.list") f.runtime.control.change(true)
    return value
  }
  await expect(
    registerNativeRetainedSession(
      f.runtime,
      f.gateway,
      { cardId: f.card.id, controlRevision: "owned", source: f.source },
      { operatorId: "operator", rationale: "Reviewed original" }
    )
  ).rejects.toThrow(/control revision/)
  expect(f.runtime.store.get("retained-session-proof", "board:card")).toBeNull()
})

it.each([
  "sidecar",
  "backup",
  "manifest"
])("rejects immutable source mutation between its hash and SQL read: %s", (kind) => {
  const f = fixture()
  hooks.onOpen = (path) => {
    if (path !== f.backup) return
    hooks.onOpen = undefined
    if (kind === "sidecar") writeFileSync(f.backup + "-wal", "unbound")
    if (kind === "backup") appendFileSync(f.backup, "changed after hash")
    if (kind === "manifest") appendFileSync(f.manifestPath, " ")
  }
  expect(() => readNativeRetainedSessionProof(f.runtime, f.card, f.source)).toThrow(
    /changed during terminal proof read/
  )
})
it("rejects symlinked published archives even when target bytes have the same hash", () => {
  const f = fixture(),
    target = join(f.root, "same-bytes")
  writeFileSync(target, readFileSync(f.archivePath))
  unlinkSync(f.archivePath)
  symlinkSync(target, f.archivePath)
  expect(() => readNativeRetainedSessionProof(f.runtime, f.card, f.source)).toThrow(/trusted regular paths/)
})
it("bounds archive blob size before materializing transcript bytes", () => {
  const f = fixture()
  f.live.exec("UPDATE session_transcript_archives SET archive_blob=zeroblob(16777217)")
  let materialized = 0
  hooks.onPrepare = (sql) => {
    if (sql.includes("SELECT * FROM session_transcript_archives")) materialized++
  }
  expect(() => readNativeRetainedSessionProof(f.runtime, f.card, f.source)).toThrow(/bounded blob reader/)
  expect(materialized).toBe(0)
})

it("cannot borrow an otherwise valid retained run for another card identity", () => {
  const f = fixture()
  expect(() => readNativeRetainedSessionProof(f.runtime, { ...f.card, id: "other-card" }, f.source)).toThrow(
    /exact terminal accepted card identity/
  )
})

it("reads a clean WAL-header original through immutable URI without creating original sidecars", () => {
  const f = fixture(),
    db = new DatabaseSync(f.backup)
  db.exec("PRAGMA journal_mode=WAL")
  db.close()
  f.bindOriginal()
  expect(readFileSync(f.backup)[18]).toBe(2)
  const before = readdirSync(join(f.root, "agents/research/agent")).sort()
  expect(readNativeRetainedSessionProof(f.runtime, f.card, f.source).terminal.status).toBe("failed")
  expect(readdirSync(join(f.root, "agents/research/agent")).sort()).toEqual(before)
  expect(existsSync(f.backup + "-wal")).toBe(false)
  expect(existsSync(f.backup + "-shm")).toBe(false)
})
it("observes a revived node committed only in the current catalog WAL", () => {
  const f = fixture()
  f.live.exec("PRAGMA journal_mode=WAL; PRAGMA wal_checkpoint(TRUNCATE)")
  f.live
    .prepare("INSERT INTO session_nodes(session_key,current_session_id,entry_json,entry_valid) VALUES(?,?,?,1)")
    .run(f.sessionKey, f.sessionId, "{}")
  expect(existsSync(join(f.root, "agents/research/agent/openclaw-agent.sqlite-wal"))).toBe(true)
  expect(() => readNativeRetainedSessionProof(f.runtime, f.card, f.source)).toThrow(/revived/)
})
it("refuses a clean WAL-mode current catalog without creating missing source sidecars", () => {
  const f = fixture()
  f.live.exec("PRAGMA journal_mode=WAL")
  f.live.close()
  const before = readdirSync(join(f.root, "agents/research/agent")).sort()
  expect(() => readNativeRetainedSessionProof(f.runtime, f.card, f.source)).toThrow(/existing safe WAL/)
  expect(readdirSync(join(f.root, "agents/research/agent")).sort()).toEqual(before)
})
