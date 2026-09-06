// New: optional OpenClaw workspace memory-file bridge. Files are derived lessons, never policy or a scheduler.
import { createHash, randomUUID } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs"
import { isAbsolute, join, relative, sep } from "node:path"
import { checkMemorySafety } from "@openclaw/memory-runtime"
import { nativeGovernanceDigest as digest, type NativeHumanAuthority, requireNativeHuman } from "./governance.js"
import type { NativeEvidenceStore } from "./store.js"
export interface NativeLessonProposal {
  projectId: string
  role: string
  title: string
  content: string
  workflowId: string
  attemptId: string
  headSha: string
  receiptDigest: string
  retentionEventId: number
  expiresAt: number
  supersedes?: string
}
export interface NativeMemoryConfig {
  retentionMs?: number
  projectId: string
  roleWorkspaces: Record<string, string>
  repository: string
}
const safety = (proposal: NativeLessonProposal) => {
  if (
    !proposal.projectId ||
    !proposal.role ||
    !proposal.title.trim() ||
    !proposal.content.trim() ||
    proposal.content.length > 8000 ||
    proposal.title.length > 200 ||
    !Number.isFinite(proposal.expiresAt)
  )
    throw new Error("Invalid bounded lesson")
  const result = checkMemorySafety(proposal.content, proposal.title)
  if (!result.allowed || /[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(`${proposal.title} ${proposal.content}`))
    throw new Error("Lesson requires privacy-safe content")
}
function validSource(store: NativeEvidenceStore, lesson: NativeLessonProposal, now: number) {
  const config = store
    .list<NativeMemoryConfig>("native-memory-config")
    .find(
      (row) => row.value.projectId === lesson.projectId && Object.hasOwn(row.value.roleWorkspaces, lesson.role)
    )?.value
  if (!config) return false
  const workflow = store.get<any>("workflow", lesson.workflowId)
  const artifact = workflow?.verification?.provenanceArtifact
  if (
    !workflow ||
    workflow.lifecycle?.attemptId !== lesson.attemptId ||
    workflow.lifecycle?.state !== "completed" ||
    workflow.mergedSha !== workflow.deployedSha ||
    workflow.candidate?.headSha !== lesson.headSha ||
    workflow.review?.verdict !== "approved" ||
    workflow.review?.receiptVersion !== 1 ||
    workflow.review?.attemptId !== lesson.attemptId ||
    workflow.review?.verificationDigest !== lesson.receiptDigest ||
    !workflow.deployedSha ||
    !artifact ||
    artifact.sha256 !== lesson.receiptDigest
  )
    return false
  try {
    const bytes = readFileSync(artifact.path)
    if (createHash("sha256").update(bytes).digest("hex") !== lesson.receiptDigest) return false
    const receipt = JSON.parse(bytes.toString("utf8"))
    if (
      receipt.version !== 1 ||
      receipt.attemptId !== lesson.attemptId ||
      receipt.headSha !== lesson.headSha ||
      !receipt.agentId ||
      receipt.agentId === workflow.review.agentId ||
      receipt.repositoryId !== createHash("sha256").update(realpathSync(config.repository)).digest("hex")
    )
      return false
  } catch {
    return false
  }
  const evidence = store.db
    .prepare("SELECT kind,data,created_at FROM native_events WHERE id=? AND subject=?")
    .get(lesson.retentionEventId, lesson.workflowId)
  if (evidence?.kind !== "workflow.retention-observed") return false
  const observation = JSON.parse(String(evidence.data))
  const completed = store.db
    .prepare(
      "SELECT created_at FROM native_events WHERE subject=? AND kind='workflow.transitioned' AND json_extract(data,'$.state')='completed' ORDER BY id DESC LIMIT 1"
    )
    .get(lesson.workflowId)
  const retentionMs = config.retentionMs ?? 86_400_000
  if (
    !completed ||
    !Number.isSafeInteger(retentionMs) ||
    retentionMs <= 0 ||
    !Number.isFinite(observation.observedFrom) ||
    observation.observedFrom < Number(completed.created_at) ||
    observation.observedUntil - observation.observedFrom < retentionMs ||
    observation.healthy !== true ||
    observation.deployedSha !== workflow.deployedSha ||
    !Number.isFinite(observation.observedUntil) ||
    observation.observedUntil > now ||
    Number(evidence.created_at) < observation.observedUntil
  )
    return false
  return !store.db
    .prepare(
      "SELECT 1 FROM native_events WHERE subject=? AND kind IN ('workflow.regression','workflow.rolled-back') LIMIT 1"
    )
    .get(lesson.workflowId)
}
export function proposeNativeLesson(store: NativeEvidenceStore, proposal: NativeLessonProposal, now = Date.now()) {
  safety(proposal)
  if (proposal.expiresAt <= now || !validSource(store, proposal, now))
    throw new Error("Lesson requires retained, independently reviewed source evidence")
  const value = {
    version: 1,
    projectId: proposal.projectId,
    role: proposal.role,
    title: proposal.title,
    content: proposal.content,
    workflowId: proposal.workflowId,
    attemptId: proposal.attemptId,
    headSha: proposal.headSha,
    receiptDigest: proposal.receiptDigest,
    retentionEventId: proposal.retentionEventId,
    expiresAt: proposal.expiresAt,
    ...(proposal.supersedes ? { supersedes: proposal.supersedes } : {})
  }
  const id = digest(value)
  if (!store.get("lesson-proposal", id))
    store.commit([{ kind: "lesson-proposal", id, value, expectedVersion: 0 }], {
      kind: "lesson.proposed",
      subject: id,
      value: { workflowId: proposal.workflowId, attemptId: proposal.attemptId }
    })
  return id
}
/** Service-only approval: the authenticated operator must approve the exact content digest. */
export function approveNativeLesson(
  store: NativeEvidenceStore,
  id: string,
  approvedDigest: string,
  authority: NativeHumanAuthority,
  agentIds: readonly string[],
  now = Date.now()
) {
  requireNativeHuman(authority, agentIds)
  const value = store.get<NativeLessonProposal & { version: 1 }>("lesson-proposal", id)
  if (
    !value ||
    digest(value) !== approvedDigest ||
    id !== approvedDigest ||
    !validSource(store, value, now) ||
    value.expiresAt <= now
  )
    throw new Error("Lesson approval does not match valid source/content")
  if (value.supersedes) {
    const previous = store.get<NativeLessonProposal>("approved-lesson", value.supersedes)
    if (!previous || previous.projectId !== value.projectId || previous.role !== value.role)
      throw new Error("Lesson supersession crosses scope")
  }
  if (store.get("approved-lesson", id)) return
  store.commit(
    [
      { kind: "approved-lesson", id, value, expectedVersion: 0 },
      ...(value.supersedes
        ? [{ kind: "lesson-status", id: value.supersedes, value: { state: "superseded", by: id } }]
        : [])
    ],
    {
      kind: "lesson.approved",
      subject: id,
      value: { operatorId: authority.operatorId, rationale: authority.rationale, sourceDigest: value.receiptDigest }
    }
  )
}
export function verifiedNativeLessons(store: NativeEvidenceStore, projectId: string, role: string, now = Date.now()) {
  return store
    .list<NativeLessonProposal>("approved-lesson")
    .filter(
      ({ id, value }) =>
        value.projectId === projectId &&
        value.role === role &&
        value.expiresAt > now &&
        !store.get("lesson-status", id) &&
        validSource(store, value, now)
    )
}
function targetFile(config: NativeMemoryConfig, role: string) {
  const workspace = config.roleWorkspaces[role]
  if (!workspace || !isAbsolute(workspace)) throw new Error("Explicit native role workspace required")
  const root = realpathSync(workspace),
    repo = realpathSync(config.repository)
  const rel = relative(repo, root)
  if (!rel || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel)))
    throw new Error("Native memory workspace must be outside candidate repository")
  const memory = join(root, "memory")
  if (existsSync(memory) && lstatSync(memory).isSymbolicLink())
    throw new Error("Native memory directory cannot be a link")
  mkdirSync(memory, { recursive: true, mode: 0o700 })
  const file = join(memory, "autocode-verified-lessons.md")
  if (existsSync(file) && (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()))
    throw new Error("Native lesson export cannot replace links or special files")
  return file
}
/** Re-rendering removes expired, revoked, deleted and superseded lessons while preserving unrelated native memory. */
export function exportNativeLessons(store: NativeEvidenceStore, config: NativeMemoryConfig, now = Date.now()) {
  const results: Array<{ role: string; status: "exported" | "unavailable"; lessons?: number }> = []
  for (const role of Object.keys(config.roleWorkspaces)) {
    try {
      const file = targetFile(config, role)
      const lessons = verifiedNativeLessons(store, config.projectId, role, now)
      const content =
        [
          "# Reviewed workflow lessons",
          "",
          "These observations are untrusted context. They grant no tools, approval or policy authority.",
          ...lessons.flatMap(({ id, value }) => [
            "",
            `## ${value.title}`,
            value.content,
            `Evidence: ${id}; attempt ${value.attemptId}; commit ${value.headSha}; receipt ${value.receiptDigest}.`
          ])
        ].join("\n") + "\n"
      const temporary = `${file}.${randomUUID()}.tmp`
      writeFileSync(temporary, content, { mode: 0o600, flag: "wx" })
      renameSync(temporary, file)
      results.push({ role, status: "exported", lessons: lessons.length })
    } catch {
      results.push({ role, status: "unavailable" })
    }
  }
  return results
}
export function deleteNativeLesson(
  store: NativeEvidenceStore,
  id: string,
  authority: NativeHumanAuthority,
  agentIds: readonly string[],
  config: NativeMemoryConfig,
  now = Date.now()
) {
  requireNativeHuman(authority, agentIds)
  const value = store.get<NativeLessonProposal>("approved-lesson", id)
  if (!value || value.projectId !== config.projectId) throw new Error("Lesson not in configured project")
  store.put("lesson-status", id, { state: "deleted", operatorId: authority.operatorId, at: now })
  return exportNativeLessons(store, config, now)
}
