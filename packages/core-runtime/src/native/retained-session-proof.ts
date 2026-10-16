// Operator-only proof for a core-retained, deleted, terminal Workboard session.
import { createHash } from "node:crypto"
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync
} from "node:fs"
import { basename, isAbsolute, join, relative, sep } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { pathToFileURL } from "node:url"
import { nativeCoderAgentIds } from "@openclaw/domain"
import { type NativeCard, type NativeGateway, nativeCards } from "./gateway.js"
import { nativeGovernanceDigest, requireNativeHuman } from "./governance.js"
import { assertNativePolicyLocalIdle, assertNativePolicyRemoteIdle } from "./policy-refresh.js"
import type { NativeAutonomyRuntime } from "./runtime.js"

const roots = new WeakMap<NativeAutonomyRuntime, string>()
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex")
export interface RetainedSessionSource {
  manifestId: string
  manifestSha256: string
  backupSha256: string
  sessionId: string
}
export interface RetainedSessionProof {
  version: 1
  boardId: string
  cardId: string
  agentId: string
  sessionKey: string
  runId: string
  source: RetainedSessionSource
  terminal: { status: "failed"; startedAt: number; endedAt: number }
  archive: { generation: string; sha256: string; createdAt: number; publishedAt: number }
}
export function configureNativeRetainedSessionRoot(runtime: NativeAutonomyRuntime, stateRoot: string) {
  if (!isAbsolute(stateRoot)) throw new Error("Trusted core state directory must be absolute")
  roots.set(runtime, realpathSync(stateRoot))
}
function regular(root: string, path: string) {
  const canonical = realpathSync(path)
  const rel = relative(root, canonical)
  if (
    path !== canonical ||
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel) ||
    lstatSync(path).isSymbolicLink()
  )
    throw new Error("Retained session source outside trusted regular paths")
  if (!lstatSync(path).isFile()) throw new Error("Retained session source must be a regular file")
}
function file(root: string, path: string, collect = true, maxBytes = 256 * 1024 * 1024) {
  regular(root, path)
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd, { bigint: true })
    if (!stat.isFile()) throw new Error("Retained session source must be a regular file")
    if (stat.size > BigInt(maxBytes)) throw new Error("Retained source exceeds bounded reader size")
    const digest = createHash("sha256")
    let bytes = Buffer.alloc(0)
    if (collect) {
      bytes = readFileSync(fd)
      digest.update(bytes)
    } else {
      const chunk = Buffer.allocUnsafe(64 * 1024)
      while (true) {
        const size = readSync(fd, chunk, 0, chunk.length, null)
        if (!size) break
        digest.update(chunk.subarray(0, size))
      }
    }
    const after = fstatSync(fd, { bigint: true })
    if (stat.size !== after.size || stat.mtimeNs !== after.mtimeNs)
      throw new Error("Retained source changed during read")
    return {
      bytes,
      identity: {
        dev: String(stat.dev),
        ino: String(stat.ino),
        mtimeNs: String(stat.mtimeNs),
        size: Number(stat.size),
        sha256: digest.digest("hex")
      }
    }
  } finally {
    closeSync(fd)
  }
}
function identity(card: NativeCard, boardId: string) {
  const launch = (card.metadata?.automation as Record<string, unknown> | undefined)?.launch as
    | Record<string, any>
    | undefined
  const execution = card.execution as Record<string, any> | undefined
  const attempts = (card.metadata as Record<string, any> | undefined)?.attempts
  const key = card.sessionKey ?? execution?.sessionKey
  const run = card.runId ?? execution?.runId
  if (
    !/^[a-z0-9][a-z0-9_-]{0,100}$/.test(card.agentId ?? "") ||
    typeof key !== "string" ||
    typeof run !== "string" ||
    key !== `agent:${card.agentId}:subagent:workboard-${boardId}-${card.id}` ||
    !run.startsWith(`workboard:${card.id}:`) ||
    !/^\d+$/.test(run.slice(`workboard:${card.id}:`.length)) ||
    !["blocked", "done", "review"].includes(card.status) ||
    !execution ||
    !["failed", "blocked", "completed", "done", "cancelled", "timed_out", "timeout", "stopped"].includes(
      execution.status
    ) ||
    execution.sessionKey !== key ||
    execution.runId !== run ||
    (card.sessionKey != null && card.sessionKey !== key) ||
    (card.runId != null && card.runId !== run) ||
    launch?.phase !== "accepted" ||
    launch.acceptedSessionKey !== key ||
    launch.requestedSessionKey !== key ||
    launch.acceptedRunId !== run ||
    launch.provisionalRunId !== run ||
    !Number.isFinite(launch.preparedAt) ||
    !Number.isFinite(launch.acceptedAt) ||
    launch.acceptedAt < launch.preparedAt ||
    !Array.isArray(attempts)
  )
    throw new Error("Retained session requires exact terminal accepted card identity")
  const matching = attempts.filter((value: any) => value?.id === run || value?.runId === run)
  const attempt = matching[0]
  if (
    matching.length !== 1 ||
    attempt.id !== run ||
    attempt.runId !== run ||
    attempt.sessionKey !== key ||
    !["failed", "blocked", "completed", "done", "cancelled", "timed_out", "timeout", "stopped"].includes(
      attempt.status
    ) ||
    !Number.isFinite(attempt.startedAt) ||
    !Number.isFinite(attempt.endedAt) ||
    attempt.startedAt < 0 ||
    attempt.endedAt < attempt.startedAt ||
    attempt.startedAt > launch.acceptedAt
  )
    throw new Error("Retained session requires unique original terminal attempt")
  return { agentId: card.agentId!, sessionKey: key, runId: run, acceptedAt: launch.acceptedAt as number, attempt }
}
function schema(db: DatabaseSync, table: string, required: string[]) {
  if (
    (db.prepare("SELECT type FROM sqlite_schema WHERE name=?").get(table) as { type?: string } | undefined)?.type !==
    "table"
  )
    throw new Error("Unsupported retained session source schema")
  const columns = db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((row: any) => row.name)
  if (required.some((name) => !columns.includes(name))) throw new Error("Unsupported retained session source schema")
}
/** All paths derive from trusted core state and server-owned card identity, never artifact SQL/paths. */
export function readNativeRetainedSessionProof(
  runtime: NativeAutonomyRuntime,
  card: NativeCard,
  source: RetainedSessionSource
): RetainedSessionProof {
  const root = roots.get(runtime)
  if (!root) throw new Error("Public core state-directory capability unavailable")
  if (
    !source ||
    Object.keys(source).sort().join(",") !== "backupSha256,manifestId,manifestSha256,sessionId" ||
    !/^startup-migration-[a-f0-9-]{36}$/.test(source.manifestId) ||
    !/^[a-f0-9-]{36}$/.test(source.sessionId) ||
    ![source.manifestSha256, source.backupSha256].every((value) => /^[a-f0-9]{64}$/.test(value))
  )
    throw new Error("Invalid reviewed retained source identity")
  const expected = identity(card, runtime.policy.boardId)
  const agent = join(root, "agents", expected.agentId)
  const current = join(agent, "agent", "openclaw-agent.sqlite")
  const backup = `${current}.pre-${source.manifestId}.bak`
  const manifestPath = join(root, "session-sqlite-migration-runs", `${source.manifestId}.json`)
  const manifestFile = file(root, manifestPath, true, 4 * 1024 * 1024)
  if (manifestFile.identity.sha256 !== source.manifestSha256) throw new Error("Original migration manifest changed")
  const manifest = JSON.parse(manifestFile.bytes.toString("utf8"))
  if (manifest.manifestVersion !== 3 || manifest.runId !== source.manifestId || !Array.isArray(manifest.targets))
    throw new Error("Unsupported retained migration manifest")
  const moves = manifest.targets
    .flatMap((target: any) => target.completedMoves ?? [])
    .filter((move: any) => move.archivePath === backup && move.sourcePath === current)
  if (
    moves.length !== 1 ||
    moves[0].kind !== "database-backup" ||
    moves[0].artifact?.classification !== "repair-original" ||
    moves[0].artifact?.reason !== "pre-startup-migration-backup" ||
    moves[0].artifact?.disposal?.state !== "retained"
  )
    throw new Error("Original backup lacks completed retained core manifest proof")
  if (["-wal", "-shm", "-journal"].some((suffix) => existsSync(backup + suffix)))
    throw new Error("Original backup has unbound SQLite sidecars")
  const snapshot = file(root, backup, false)
  if (
    snapshot.identity.sha256 !== source.backupSha256 ||
    nativeGovernanceDigest(snapshot.identity) !== nativeGovernanceDigest(moves[0].artifact.identity)
  )
    throw new Error("Original backup identity or hash changed")
  const immutableBackup = pathToFileURL(backup)
  immutableBackup.searchParams.set("immutable", "1")
  const db = new DatabaseSync(immutableBackup.href, { readOnly: true })
  let startedAt: number, endedAt: number
  try {
    schema(db, "session_nodes", ["session_key", "current_session_id", "entry_json", "entry_valid", "status"])
    schema(db, "session_windows", ["session_key", "session_id", "plugin_owner_id", "status", "started_at", "ended_at"])
    const node = db
      .prepare("SELECT current_session_id,entry_json,entry_valid,status FROM session_nodes WHERE session_key=?")
      .get(expected.sessionKey) as any
    const windows = db.prepare("SELECT * FROM session_windows WHERE session_key=?").all(expected.sessionKey) as any[]
    if (!node || node.entry_valid !== 1 || node.status !== "failed" || node.current_session_id !== source.sessionId)
      throw new Error("Original session node identity missing")
    const entry = JSON.parse(node.entry_json)
    const window = windows.find((value) => value.session_id === source.sessionId)
    if (
      windows.length !== 1 ||
      !window ||
      entry.sessionId !== source.sessionId ||
      entry.pluginOwnerId !== "workboard" ||
      window.plugin_owner_id !== "workboard" ||
      entry.status !== "failed" ||
      window.status !== "failed" ||
      entry.lastRunId !== expected.runId ||
      entry.activeWriterRunId !== expected.runId
    )
      throw new Error("Original terminal session/run/window ownership mismatch")
    startedAt = entry.startedAt
    endedAt = entry.endedAt
    if (
      !Number.isFinite(startedAt) ||
      !Number.isFinite(endedAt) ||
      startedAt < 0 ||
      endedAt < startedAt ||
      startedAt < expected.attempt.startedAt ||
      endedAt < expected.acceptedAt ||
      endedAt > expected.attempt.endedAt ||
      window.started_at !== startedAt ||
      window.ended_at !== endedAt
    )
      throw new Error("Original terminal session timing missing or inconsistent")
  } finally {
    db.close()
  }
  // SQLite may consult sibling journals or a replaced pathname after the first hash.
  // Bind the actual SQL read back to the reviewed immutable bytes before trusting it.
  if (
    ["-wal", "-shm", "-journal"].some((suffix) => existsSync(backup + suffix)) ||
    nativeGovernanceDigest(file(root, backup, false).identity) !== nativeGovernanceDigest(snapshot.identity) ||
    file(root, manifestPath, true, 4 * 1024 * 1024).identity.sha256 !== source.manifestSha256
  )
    throw new Error("Original backup/manifest changed during terminal proof read")
  // The current database is opened read-only; no entry or transcript is resurrected.
  regular(root, current)
  const headerFd = openSync(current, constants.O_RDONLY | constants.O_NOFOLLOW)
  const header = Buffer.alloc(20)
  try {
    if (
      readSync(headerFd, header, 0, header.length, 0) !== header.length ||
      header.toString("binary", 0, 16) !== "SQLite format 3\0"
    )
      throw new Error("Current core catalog SQLite header unavailable")
  } finally {
    closeSync(headerFd)
  }
  if (header[18] === 2 && header[19] === 2) {
    // A read-only WAL connection may otherwise create source sidecars itself.
    // Never use immutable=1 here: current uncheckpointed revival must remain visible.
    if (!existsSync(current + "-wal") || !existsSync(current + "-shm"))
      throw new Error("Current WAL catalog lacks existing safe WAL/SHM read state")
    regular(root, current + "-wal")
    regular(root, current + "-shm")
  } else if (header[18] !== 1 || header[19] !== 1 || existsSync(current + "-journal")) {
    throw new Error("Current core catalog journal state is unsafe for read-only inspection")
  }
  const live = new DatabaseSync(current, { readOnly: true })
  let archive: RetainedSessionProof["archive"]
  try {
    live.exec("BEGIN")
    schema(live, "session_nodes", ["session_key", "current_session_id"])
    schema(live, "session_windows", ["session_key", "session_id"])
    schema(live, "session_transcript_archives", [
      "session_id",
      "session_key",
      "generation",
      "reason",
      "encoding",
      "archive_sha256",
      "archive_name",
      "archive_blob",
      "created_at",
      "published_at"
    ])
    if (
      live
        .prepare("SELECT 1 FROM session_nodes WHERE session_key=? OR current_session_id=?")
        .get(expected.sessionKey, source.sessionId) ||
      live
        .prepare("SELECT 1 FROM session_windows WHERE session_key=? OR session_id=?")
        .get(expected.sessionKey, source.sessionId)
    )
      throw new Error("Retained session has current/revived node or window")
    const sizes = live
      .prepare(
        "SELECT length(archive_blob) AS bytes FROM session_transcript_archives WHERE session_key=? AND session_id=?"
      )
      .all(expected.sessionKey, source.sessionId) as Array<{ bytes: number | null }>
    if (
      sizes.length !== 1 ||
      !Number.isSafeInteger(sizes[0]?.bytes) ||
      sizes[0]!.bytes! < 1 ||
      sizes[0]!.bytes! > 16 * 1024 * 1024
    )
      throw new Error("Retained archive missing, ambiguous or exceeds bounded blob reader size")
    const rows = live
      .prepare("SELECT * FROM session_transcript_archives WHERE session_key=? AND session_id=?")
      .all(expected.sessionKey, source.sessionId) as any[]
    if (rows.length !== 1) throw new Error("Exact retained deleted archive is missing or ambiguous")
    const row = rows[0]
    if (
      row.reason !== "deleted" ||
      row.encoding !== "zstd" ||
      typeof row.generation !== "string" ||
      !/^[a-f0-9]{32}$/.test(row.generation) ||
      !Number.isFinite(row.created_at) ||
      row.created_at < endedAt ||
      !Number.isFinite(row.published_at) ||
      row.published_at < row.created_at ||
      !/^[a-f0-9]{64}$/.test(row.archive_sha256) ||
      !(row.archive_blob instanceof Uint8Array) ||
      hash(row.archive_blob) !== row.archive_sha256 ||
      typeof row.archive_name !== "string" ||
      basename(row.archive_name) !== row.archive_name ||
      !row.archive_name.startsWith(`${source.sessionId}.jsonl.deleted.`) ||
      !row.archive_name.endsWith(`.${row.generation}.zst`)
    )
      throw new Error("Core deleted archive lacks exact verified publication")
    const published = file(root, join(agent, "sessions", row.archive_name), false)
    if (published.identity.sha256 !== row.archive_sha256) throw new Error("Published deleted archive changed")
    archive = {
      generation: row.generation,
      sha256: row.archive_sha256,
      createdAt: row.created_at,
      publishedAt: row.published_at
    }
  } finally {
    live.close()
  }
  return {
    version: 1,
    boardId: runtime.policy.boardId,
    cardId: card.id,
    agentId: expected.agentId,
    sessionKey: expected.sessionKey,
    runId: expected.runId,
    source,
    terminal: { status: "failed", startedAt, endedAt },
    archive
  }
}
export function registeredNativeRetainedSession(runtime: NativeAutonomyRuntime, card: NativeCard) {
  const proof = runtime.store.get<RetainedSessionProof>(
    "retained-session-proof",
    `${runtime.policy.boardId}:${card.id}`
  )
  if (!proof) return undefined
  const verified = readNativeRetainedSessionProof(runtime, card, proof.source)
  if (nativeGovernanceDigest(verified) !== nativeGovernanceDigest(proof))
    throw new Error("Registered retained session proof changed")
  return verified
}
export async function registerNativeRetainedSession(
  runtime: NativeAutonomyRuntime,
  gateway: NativeGateway,
  input: { cardId: string; controlRevision: string; source: RetainedSessionSource },
  authority: { operatorId: string; rationale: string }
) {
  requireNativeHuman(authority, [
    runtime.policy.plannerAgentId,
    ...nativeCoderAgentIds(runtime.policy),
    runtime.policy.reviewerAgentId,
    ...runtime.policy.personas.flatMap((p) => [p.personaId, p.investigationAgentId ?? p.personaId])
  ])
  const assertControl = () => {
    if (
      !runtime.control.state.paused ||
      runtime.control.state.frozen ||
      runtime.control.state.revision !== input.controlRevision ||
      runtime.store.get<{ paused: boolean }>("control", "pause")?.paused !== true
    )
      throw new Error("Exact owned paused/unfrozen control revision required")
  }
  if (typeof authority.rationale !== "string" || authority.rationale.length > 2000)
    throw new Error("Bounded retained proof rationale required")
  assertControl()
  assertNativePolicyLocalIdle(runtime)
  return runtime.withOwnership(async () => {
    const lease = runtime.store.acquire("retained-session-registration", 120_000)
    if (!lease) throw new Error("Retained session registration already active")
    return runtime.store.withLease(lease, 120_000, async () => {
      const cards = await nativeCards(gateway, runtime.policy.boardId)
      const card = cards.find((value) => value.id === input.cardId)
      if (!card) throw new Error("Exact retained card missing")
      const proof = readNativeRetainedSessionProof(runtime, card, input.source)
      const pending = (value: NativeCard) =>
        value.id === card.id
          ? readNativeRetainedSessionProof(runtime, value, input.source)
          : registeredNativeRetainedSession(runtime, value)
      await assertNativePolicyRemoteIdle(runtime, gateway, pending)
      await assertNativePolicyRemoteIdle(runtime, gateway, pending)
      assertControl()
      assertNativePolicyLocalIdle(runtime, lease.id)
      const id = `${runtime.policy.boardId}:${card.id}`
      const prior = runtime.store.get<RetainedSessionProof>("retained-session-proof", id)
      if (prior && nativeGovernanceDigest(prior) !== nativeGovernanceDigest(proof))
        throw new Error("Retained session proof is immutable")
      runtime.store.commit(
        prior ? [] : [{ kind: "retained-session-proof", id, value: proof, expectedVersion: 0 }],
        {
          kind: "retained-session.registered",
          subject: id,
          value: {
            operatorId: authority.operatorId,
            reason: authority.rationale,
            controlRevision: input.controlRevision,
            proofDigest: nativeGovernanceDigest(proof)
          }
        },
        undefined,
        () => {
          assertControl()
          assertNativePolicyLocalIdle(runtime, lease.id)
          if (
            nativeGovernanceDigest(readNativeRetainedSessionProof(runtime, card, input.source)) !==
            nativeGovernanceDigest(proof)
          )
            throw new Error("Retained session source changed before registration")
        }
      )
      return {
        proofDigest: nativeGovernanceDigest(proof),
        cardId: card.id,
        sessionKey: proof.sessionKey,
        runId: proof.runId
      }
    })
  })
}
