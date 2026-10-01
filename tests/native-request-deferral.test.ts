import { createHash } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { loadNativePolicy } from "../packages/core-runtime/src/native/doctor.js"
import {
  applyNativeRequestDeferral,
  type NativeOperatorRequest,
  planNativeRequestDeferral
} from "../packages/core-runtime/src/native/requests.js"
import type { NativeAutonomyRuntime } from "../packages/core-runtime/src/native/runtime.js"
import { NativeEvidenceStore } from "../packages/core-runtime/src/native/store.js"

const cleanups: Array<() => void> = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

function setup() {
  const root = mkdtempSync(join(tmpdir(), "native-request-deferral-"))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const file = join(root, "policy.json")
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      enabled: true,
      mode: "implement-human-review",
      boardId: "request-test",
      repository: root,
      repositoryKind: "application",
      baseBranch: "main",
      plannerAgentId: "planner",
      coderAgentId: "coder",
      reviewerAgentId: "reviewer",
      personas: [
        { personaId: "research", goals: ["navigation"], successObservations: ["page opens"], allowedPaths: ["src"] }
      ],
      verification: [{ argv: ["true"], cwd: "." }],
      deployment: { command: { argv: ["true"], cwd: "." }, check: { argv: ["true"], cwd: "." } }
    })
  )
  const store = new NativeEvidenceStore(join(root, "evidence.db"))
  cleanups.push(() => store.close())
  const requestId = createHash("sha256")
    .update(JSON.stringify({ boardId: "request-test", key: "reviewed-original-request" }))
    .digest("hex")
  const request: NativeOperatorRequest = {
    id: requestId,
    digest: "b".repeat(64),
    operator: "original-operator",
    createdAt: 100,
    state: "queued",
    roundId: `operator-${requestId}`,
    brief: {
      idempotencyKey: "reviewed-original-request",
      personaId: "research",
      title: "Original scoped repair",
      brief: "Inspect the committed source before proposing a repair.",
      expectedBaseSha: "c".repeat(40),
      evidence: [{ path: "src/example.ts", observation: "Source inspection required", blobSha: "d".repeat(40) }]
    }
  }
  store.put("operator-request", request.id, request)
  store.event("operator-request.queued", request.id, { operator: request.operator })
  const runtime = {
    policy: loadNativePolicy(file),
    store,
    control: { state: { paused: true, frozen: false, revision: "paused-revision", freezeRevision: "freeze-revision" } }
  } as unknown as NativeAutonomyRuntime
  const plan = () =>
    planNativeRequestDeferral(runtime, request.id, "Replace this unstarted brief after a newly verified source defect.")
  const apply = () => {
    const value = plan()
    return applyNativeRequestDeferral(runtime, value, { operatorId: "operator-device", rationale: value.reason })
  }
  return { root, store, request, runtime, plan, apply }
}

it("plans without writes and defers only the exact queued request while preserving its complete prior value and audits", () => {
  const { store, request, runtime, plan, apply } = setup()
  const before = store.db.prepare("SELECT * FROM native_events ORDER BY id").all()
  const control = structuredClone(runtime.control.state)
  const originalVersion = store.version("operator-request", request.id)
  const prepared = plan()
  expect(store.version("operator-request", request.id)).toBe(originalVersion)
  expect(store.db.prepare("SELECT * FROM native_events ORDER BY id").all()).toEqual(before)
  const result = apply()
  expect(result.request).toEqual({ ...request, state: "deferred", reason: prepared.reason })
  expect(store.get("operator-request-history", result.historyId)).toEqual(request)
  expect(store.version("operator-request", request.id)).toBe(originalVersion + 1)
  expect(runtime.control.state).toEqual(control)
  const after = store.db.prepare("SELECT * FROM native_events ORDER BY id").all()
  expect(after.slice(0, before.length)).toEqual(before)
  expect(after).toHaveLength(before.length + 1)
  const audit = JSON.parse(String(after.at(-1)?.data))
  expect(audit.operatorId).toBe("operator-device")
  expect(audit.plan).toEqual(prepared)
  expect(audit.historyId).toBe(result.historyId)
  expect(() => apply()).toThrow("queued")
  expect(store.db.prepare("SELECT * FROM native_events ORDER BY id").all()).toEqual(after)
})

it.each(["building", "dispatched", "deferred"] as const)("rejects an already %s request", (state) => {
  const { store, request, plan } = setup()
  store.put("operator-request", request.id, { ...request, state })
  expect(() => plan()).toThrow("queued")
})

it.each(["running", "frozen"])("rejects %s control state", (state) => {
  const { runtime, plan } = setup()
  if (state === "running") runtime.control.state.paused = false
  else runtime.control.state.frozen = true
  expect(() => plan()).toThrow("paused, unfrozen")
})

it.each([
  "round",
  "investigation",
  "inspection",
  "proposal",
  "effect-intent",
  "workflow"
])("rejects associated %s evidence regardless of a queued label", (kind) => {
  const { store, request, plan } = setup()
  store.put(kind, kind === "round" ? request.roundId : `associated-${kind}`, {
    roundId: request.roundId,
    state: "confirmed"
  })
  expect(() => plan()).toThrow(/already started|execution evidence/)
})

it.each([
  "control",
  "freeze",
  "policy",
  "record",
  "reason"
])("rejects stale or altered %s binding without an archive", (binding) => {
  const { runtime, store, request, plan } = setup()
  const prepared = plan()
  if (binding === "control") runtime.control.state.revision = "new-paused-revision"
  if (binding === "freeze") runtime.control.state.freezeRevision = "new-freeze-revision"
  if (binding === "policy") runtime.policy.mode = "application-release"
  if (binding === "record") store.put("operator-request", request.id, { ...request, reason: "Concurrent update" })
  if (binding === "reason") prepared.reason = "Unreviewed replacement reason"
  expect(() =>
    applyNativeRequestDeferral(runtime, prepared, {
      operatorId: "operator-device",
      rationale: prepared.reason
    })
  ).toThrow("plan changed")
  expect(store.list("operator-request-history")).toEqual([])
  expect(store.get<NativeOperatorRequest>("operator-request", request.id)?.state).toBe("queued")
})

it.each([
  "",
  "coder",
  "planner",
  "reviewer",
  "research"
])("rejects agent or missing operator identity %s", (operatorId) => {
  const { runtime, store, plan } = setup()
  const prepared = plan()
  expect(() => applyNativeRequestDeferral(runtime, prepared, { operatorId, rationale: prepared.reason })).toThrow(
    "authenticated operator"
  )
  expect(store.list("operator-request-history")).toEqual([])
})

it("rejects a request from a different board even when its store and pause state are shared", () => {
  const { runtime, store, plan } = setup()
  runtime.policy.boardId = "different-board"
  expect(() => plan()).toThrow("different native board")
  expect(store.list("operator-request-history")).toEqual([])
})

it("rejects a plan after runtime replacement with the same policy, control, and request", () => {
  const { runtime, store, plan } = setup()
  const prepared = plan()
  const replacement = { ...runtime } as NativeAutonomyRuntime
  expect(() =>
    applyNativeRequestDeferral(replacement, prepared, {
      operatorId: "operator-device",
      rationale: prepared.reason
    })
  ).toThrow("plan changed")
  expect(store.list("operator-request-history")).toEqual([])
})

it("rolls back the archive and audit when a concurrent writer wins the request revision", () => {
  const { runtime, root, store, request, plan } = setup()
  const prepared = plan()
  const parallel = new NativeEvidenceStore(join(root, "evidence.db"))
  cleanups.push(() => parallel.close())
  const commit = store.commit.bind(store)
  vi.spyOn(store, "commit").mockImplementationOnce((writes, event) => {
    parallel.put("operator-request", request.id, { ...request, reason: "Concurrent update" })
    return commit(writes, event)
  })
  expect(() =>
    applyNativeRequestDeferral(runtime, prepared, { operatorId: "operator-device", rationale: prepared.reason })
  ).toThrow()
  expect(store.list("operator-request-history")).toEqual([])
  expect(
    store.db.prepare("SELECT COUNT(*) AS count FROM native_events WHERE kind='operator-request.deferred'").get()?.count
  ).toBe(0)
  expect(store.get<NativeOperatorRequest>("operator-request", request.id)?.state).toBe("queued")
})
