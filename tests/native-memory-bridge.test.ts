import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import {
  approveNativeLesson,
  deleteNativeLesson,
  exportNativeLessons,
  type NativeLessonProposal,
  proposeNativeLesson,
  verifiedNativeLessons
} from "../packages/core-runtime/src/native/memory.js"
import { NativeEvidenceStore } from "../packages/core-runtime/src/native/store.js"

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn()
})
const human = { operatorId: "human", rationale: "Reviewed retained source and privacy-safe lesson" }
function setup() {
  const root = mkdtempSync(join(tmpdir(), "native-memory-"))
  const repo = join(root, "repo"),
    workspace = join(root, "research")
  mkdirSync(repo)
  mkdirSync(workspace)
  const store = new NativeEvidenceStore(join(root, "evidence.db"))
  cleanups.push(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  const head = "a".repeat(40)
  const receipt = join(root, "receipt.json")
  writeFileSync(
    receipt,
    JSON.stringify({
      version: 1,
      attemptId: "workflow:attempt:0",
      headSha: head,
      agentId: "coder",
      repositoryId: createHash("sha256").update(realpathSync(repo)).digest("hex")
    })
  )
  const receiptDigest = createHash("sha256").update(readFileSync(receipt)).digest("hex")
  store.put("workflow", "workflow", {
    lifecycle: { version: 1, state: "completed", attemptId: "workflow:attempt:0", attempt: 0, headSha: head },
    candidate: { headSha: head },
    verification: {
      headSha: head,
      checks: [{ exitCode: 0 }],
      provenanceArtifact: { path: receipt, sha256: receiptDigest }
    },
    review: {
      headSha: head,
      verdict: "approved",
      receiptVersion: 1,
      attemptId: "workflow:attempt:0",
      verificationDigest: receiptDigest,
      agentId: "reviewer"
    },
    mergedSha: head,
    deployedSha: head
  })
  store.event("workflow.transitioned", "workflow", { state: "completed", deployedSha: head })
  store.db.prepare("UPDATE native_events SET created_at=0 WHERE kind='workflow.transitioned'").run()
  store.event("workflow.retention-observed", "workflow", {
    deployedSha: head,
    healthy: true,
    observedFrom: 0,
    observedUntil: 100
  })
  const event = store.db.prepare("SELECT max(id) AS id FROM native_events").get()
  const proposal: NativeLessonProposal = {
    projectId: "project",
    role: "research",
    title: "Verify navigation",
    content: "Use an independent source navigation check before accepting a changed interface.",
    workflowId: "workflow",
    attemptId: "workflow:attempt:0",
    headSha: head,
    receiptDigest,
    retentionEventId: Number(event!.id),
    expiresAt: 10_000
  }
  const config = { retentionMs: 100, projectId: "project", roleWorkspaces: { research: workspace }, repository: repo }
  store.put("native-memory-config", "board", config)
  return { store, proposal, config, workspace }
}
it("exports only reviewed retained lessons within project and role", () => {
  const s = setup()
  const id = proposeNativeLesson(s.store, s.proposal, 200)
  expect(verifiedNativeLessons(s.store, "project", "research", 200)).toEqual([])
  approveNativeLesson(s.store, id, id, human, ["coder"], 200)
  expect(verifiedNativeLessons(s.store, "other", "research", 200)).toEqual([])
  expect(verifiedNativeLessons(s.store, "project", "reviewer", 200)).toEqual([])
  expect(exportNativeLessons(s.store, s.config, 200)[0]).toMatchObject({ status: "exported", lessons: 1 })
  expect(readFileSync(join(s.workspace, "memory/autocode-verified-lessons.md"), "utf8")).toContain(
    s.proposal.receiptDigest
  )
})
it("revocation and deletion propagate without erasing workflow evidence", () => {
  const s = setup()
  const id = proposeNativeLesson(s.store, s.proposal, 200)
  approveNativeLesson(s.store, id, id, human, ["coder"], 200)
  exportNativeLessons(s.store, s.config, 200)
  s.store.event("workflow.rolled-back", "workflow", {})
  expect(exportNativeLessons(s.store, s.config, 300)[0]).toMatchObject({ lessons: 0 })
  expect(readFileSync(join(s.workspace, "memory/autocode-verified-lessons.md"), "utf8")).not.toContain(
    s.proposal.content
  )
  deleteNativeLesson(s.store, id, human, ["coder"], s.config, 300)
  expect(s.store.get("workflow", "workflow")).not.toBeNull()
})
it("rejects secret/PII fixtures and candidate self-approval; unavailable native memory preserves evidence", () => {
  const s = setup()
  for (const content of ["api_key=PRIVATE_FIXTURE", "Contact private@example.invalid"]) {
    expect(() => proposeNativeLesson(s.store, { ...s.proposal, content }, 200)).toThrow(/privacy/)
  }
  const id = proposeNativeLesson(s.store, s.proposal, 200)
  expect(() => approveNativeLesson(s.store, id, id, { ...human, operatorId: "coder" }, ["coder"], 200)).toThrow(
    /Independent/
  )
  approveNativeLesson(s.store, id, id, human, ["coder"], 200)
  expect(
    exportNativeLessons(
      s.store,
      { ...s.config, roleWorkspaces: { research: "/unavailable-native-memory-fixture" } },
      200
    )[0]?.status
  ).toBe("unavailable")
  expect(s.store.get("approved-lesson", id)).not.toBeNull()
})
it("supersession and expiry remove old lessons from native retrieval", () => {
  const s = setup()
  const first = proposeNativeLesson(s.store, s.proposal, 200)
  approveNativeLesson(s.store, first, first, human, ["coder"], 200)
  const next = proposeNativeLesson(
    s.store,
    { ...s.proposal, title: "Revised navigation lesson", supersedes: first },
    200
  )
  approveNativeLesson(s.store, next, next, human, ["coder"], 200)
  expect(verifiedNativeLessons(s.store, "project", "research", 200).map((row) => row.id)).toEqual([next])
  expect(verifiedNativeLessons(s.store, "project", "research", 20_000)).toEqual([])
})

it("rejects retention that predates completion or lacks the reviewed observation duration", () => {
  const s = setup()
  s.store.db.prepare("UPDATE native_events SET created_at=50 WHERE kind='workflow.transitioned'").run()
  expect(() => proposeNativeLesson(s.store, s.proposal, 200)).toThrow()
  s.store.db.prepare("UPDATE native_events SET created_at=0 WHERE kind='workflow.transitioned'").run()
  s.store.put("native-memory-config", "board", { ...s.config, retentionMs: 101 })
  expect(() => proposeNativeLesson(s.store, s.proposal, 200)).toThrow()
})
