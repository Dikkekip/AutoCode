import { deriveMemoryLifecycleStatus } from "@openclaw/domain"
import { afterEach, describe, expect, it } from "vitest"

import { createTempWorkspace } from "./helpers.js"
import { HAS_NODE_SQLITE } from "./node-sqlite.js"

let DispatcherStore: typeof import("@openclaw/db").DispatcherStore | null = null
let MemoryRuntime: typeof import("@openclaw/memory-runtime").MemoryRuntime | null = null
if (HAS_NODE_SQLITE) {
  ;({ DispatcherStore } = await import("@openclaw/db"))
  ;({ MemoryRuntime } = await import("@openclaw/memory-runtime"))
}

const describeDb = HAS_NODE_SQLITE ? describe : describe.skip

describeDb("memory runtime", () => {
  const cleanups: Array<() => void> = []

  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.()
  })

  function setup() {
    const workspace = createTempWorkspace("memory-runtime")
    cleanups.push(workspace.cleanup)
    const store = new DispatcherStore!(workspace.dbPath)
    store.migrate()
    const company = store.createCompany({ name: "Memory Co" })
    const project = store.createProject({
      companyRef: company.id,
      name: "repo",
      repoPath: workspace.repoPath,
      verifyCommand: null
    })
    const runtime = new MemoryRuntime!(store)
    return { workspace, store, company, project, runtime }
  }

  it("derives lifecycle state from chunk and embedding coverage", () => {
    expect(
      deriveMemoryLifecycleStatus({
        chunkCount: 0,
        missingEmbeddingCount: 0,
        persistedStatus: null
      })
    ).toBe("not_started")

    expect(
      deriveMemoryLifecycleStatus({
        chunkCount: 3,
        missingEmbeddingCount: 2,
        persistedStatus: null
      })
    ).toBe("stale")

    expect(
      deriveMemoryLifecycleStatus({
        chunkCount: 3,
        missingEmbeddingCount: 0,
        persistedStatus: "processing"
      })
    ).toBe("processing")
  })

  it("preserves important decision traces while compacting low-importance memory", async () => {
    const { store, project, runtime } = setup()
    const now = new Date().toISOString()

    const decision = await runtime.recordMemory({
      projectId: project.id,
      layer: "shared_decisions",
      sourceKind: "shared_decision",
      sourceRef: "decision:auth-boundary",
      audience: "shared",
      title: "Auth boundary decision",
      content: "Never bypass the auth boundary when reusing session state.",
      provenance: {
        sources: [{ kind: "decision-log", ref: "decision:auth-boundary", capturedAt: now }],
        freshness: { recordedAt: now, score: 1 },
        derivation: null,
        tags: ["decision"]
      },
      retention: {
        preserveDecisionTrace: true,
        preserveRaw: true,
        pinned: true,
        importance: "critical",
        retainUntil: null
      }
    })

    const oldRun = await runtime.recordMemory({
      projectId: project.id,
      layer: "run_summaries",
      sourceKind: "run_summary",
      sourceRef: "run:old-1",
      audience: "project",
      title: "Old run 1",
      content: "First old run detail that can be summarized later.",
      provenance: {
        sources: [{ kind: "run", ref: "old-1", capturedAt: now }],
        freshness: { recordedAt: now, score: 0.4 },
        derivation: null,
        tags: ["run"]
      },
      retention: {
        preserveDecisionTrace: false,
        preserveRaw: true,
        pinned: false,
        importance: "low",
        retainUntil: null
      }
    })

    await runtime.recordMemory({
      projectId: project.id,
      layer: "run_summaries",
      sourceKind: "run_summary",
      sourceRef: "run:old-2",
      audience: "project",
      title: "Old run 2",
      content: "Second old run detail that can be summarized later.",
      provenance: {
        sources: [{ kind: "run", ref: "old-2", capturedAt: now }],
        freshness: { recordedAt: now, score: 0.4 },
        derivation: null,
        tags: ["run"]
      },
      retention: {
        preserveDecisionTrace: false,
        preserveRaw: true,
        pinned: false,
        importance: "low",
        retainUntil: null
      }
    })

    const result = await runtime.compactProjectMemory(project.id, {
      maxChunks: 1,
      maxContentChars: 10,
      keepRecent: 0,
      minimumAgeHours: 0
    })

    expect(result.summaryChunk).toBeTruthy()
    expect(result.compactedChunkIds).toContain(oldRun.id)

    const reloadedDecision = store.findMemoryChunk(project.id, "shared_decision", "decision:auth-boundary")
    expect(reloadedDecision?.lifecycleStatus).toBe("ready")
    expect(reloadedDecision?.supersededByChunkId).toBeNull()

    const compactedRun = store.findMemoryChunk(project.id, "run_summary", "run:old-1")
    expect(compactedRun?.lifecycleStatus).toBe("compacted")
    expect(compactedRun?.supersededByChunkId).toBe(result.summaryChunk?.id)
    expect(compactedRun?.retention.preserveRaw).toBe(false)

    store.close()
    void decision
  })

  it("round-trips provenance and derivation metadata", async () => {
    const { store, project, runtime } = setup()
    const now = new Date().toISOString()

    await runtime.recordMemory({
      projectId: project.id,
      layer: "portable_skills",
      sourceKind: "portable_skill",
      sourceRef: "skill:review-checklist",
      sourcePath: "skills/review.md",
      audience: "shared",
      title: "Review checklist",
      content: "Keep focused review findings and preserve failing evidence.",
      provenance: {
        sources: [{ kind: "file", ref: "skills/review.md", path: "skills/review.md", capturedAt: now }],
        freshness: { recordedAt: now, observedAt: now, score: 0.9 },
        derivation: {
          kind: "manual",
          sourceChunkIds: [],
          summaryOfSourceRefs: ["skills/review.md"],
          notes: "Imported from repo fixture."
        },
        tags: ["portable-skill", "review"]
      },
      retention: {
        preserveDecisionTrace: true,
        preserveRaw: true,
        pinned: false,
        importance: "high",
        retainUntil: null
      },
      metadata: {
        owner: "framework"
      }
    })

    const chunk = store.findMemoryChunk(project.id, "portable_skill", "skill:review-checklist")
    expect(chunk?.layer).toBe("portable_skills")
    expect(chunk?.provenance.sources[0]?.path).toBe("skills/review.md")
    expect(chunk?.provenance.derivation?.kind).toBe("manual")
    expect(chunk?.retention.importance).toBe("high")

    store.close()
  })

  it("evaluates retrieval datasets with explicit pass and fail thresholds", async () => {
    const { store, project, runtime } = setup()

    const dataset = {
      manifest: {
        datasetVersion: "retrieval-v1",
        createdAt: "2026-04-06",
        status: "active" as const,
        description: "Test retrieval set",
        sourceCorpusFingerprint: "sha256:test",
        queryCount: 2,
        slices: { intent: { regression: 2 } },
        annotationGuidelinesVersion: "v1",
        notes: []
      },
      cases: [
        {
          id: "q1",
          query: "auth boundary",
          expectedSourceRefs: ["decision:auth-boundary"],
          metadata: {}
        },
        {
          id: "q2",
          query: "queue sweep",
          expectedSourceRefs: ["run:queue-sweep"],
          metadata: {}
        }
      ]
    }

    const passing = await runtime.evaluateRetrieval(
      dataset,
      {
        minimumCaseCount: 2,
        minimumExpectationCoverage: 1,
        metrics: [
          { metric: "recall_at_k", min: 1 },
          { metric: "mrr", min: 1 }
        ]
      },
      async ({ query }) =>
        query === "auth boundary" ? [{ sourceRef: "decision:auth-boundary" }] : [{ sourceRef: "run:queue-sweep" }],
      { projectId: project.id }
    )

    expect(passing.summary.pass).toBe(true)

    const failing = await runtime.evaluateRetrieval(
      dataset,
      {
        minimumCaseCount: 2,
        minimumExpectationCoverage: 1,
        metrics: [
          { metric: "recall_at_k", min: 1 },
          { metric: "mrr", min: 1 }
        ]
      },
      async () => [{ sourceRef: "wrong-ref" }]
    )

    expect(failing.summary.pass).toBe(false)
    expect(failing.summary.failures.some((item) => item.includes("recall_at_k"))).toBe(true)

    const reports = store.listMemoryChunks(project.id, ["shared"], ["eval_report"])
    expect(reports).toHaveLength(1)
    expect(reports[0]?.layer).toBe("retrieval_eval_reports")

    store.close()
  })

  it("enforces memory safety rules and audits writes, rejections, and deletions", async () => {
    const { store, project, runtime } = setup()
    const now = new Date().toISOString()
    const fs = await import("node:fs")
    const path = await import("node:path")
    const { AuditWriter } = await import("@openclaw/audit-runtime")

    const auditPath = path.join(project.repoPath, ".openclaw/audit.log")

    // 1. Record a safe memory chunk and verify audit trail
    await runtime.recordMemory({
      projectId: project.id,
      layer: "shared_decisions",
      sourceKind: "shared_decision",
      sourceRef: "decision:safe-one",
      audience: "shared",
      title: "Safe Memory Title",
      content: "This is completely safe memory content.",
      provenance: {
        sources: [{ kind: "decision-log", ref: "decision:safe-one", capturedAt: now }],
        freshness: { recordedAt: now, score: 1 },
        derivation: null,
        tags: ["safe"]
      },
      retention: {
        preserveDecisionTrace: true,
        preserveRaw: true,
        pinned: true,
        importance: "normal",
        retainUntil: null
      }
    })

    expect(fs.existsSync(auditPath)).toBe(true)
    const auditWriter = new AuditWriter(auditPath)
    const events = auditWriter.readRecent()
    const writeEvent = events.find((e) => e.event === "memory-governed-write")
    expect(writeEvent).toBeDefined()
    expect(writeEvent?.data.sourceRef).toBe("decision:safe-one")

    // 2. Attempt to record forbidden memory (e.g. private key) and expect rejection + audit trail
    await expect(
      runtime.recordMemory({
        projectId: project.id,
        layer: "shared_decisions",
        sourceKind: "shared_decision",
        sourceRef: "decision:forbidden-key",
        audience: "shared",
        title: "Forbidden Key",
        content: "Here is my secret private key: -----BEGIN RSA PRIVATE KEY-----",
        provenance: {
          sources: [{ kind: "decision-log", ref: "decision:forbidden-key", capturedAt: now }],
          freshness: { recordedAt: now, score: 1 },
          derivation: null,
          tags: ["unsafe"]
        },
        retention: {
          preserveDecisionTrace: true,
          preserveRaw: true,
          pinned: true,
          importance: "normal",
          retainUntil: null
        }
      })
    ).rejects.toThrow(/forbidden memory/i)

    const eventsAfterReject = auditWriter.readRecent()
    const rejectEvent = eventsAfterReject.find((e) => e.event === "memory-governed-reject")
    expect(rejectEvent).toBeDefined()
    expect(rejectEvent?.data.sourceRef).toBe("decision:forbidden-key")
    expect(rejectEvent?.data.reason).toContain("private key material")

    // 3. Test deletion audit when syncing project memory (by deleting a repo_doc chunk)
    // First, record a repo doc memory chunk
    await runtime.recordMemory({
      projectId: project.id,
      layer: "repo_docs",
      sourceKind: "repo_doc",
      sourceRef: "repo:shared:old-file.md#0",
      audience: "shared",
      title: "Old Doc",
      content: "Document content that is now stale.",
      provenance: {
        sources: [{ kind: "file", ref: "repo:shared:old-file.md#0", path: "old-file.md", capturedAt: now }],
        freshness: { recordedAt: now, score: 1 },
        derivation: null,
        tags: ["stale"]
      },
      retention: {
        preserveDecisionTrace: false,
        preserveRaw: true,
        pinned: false,
        importance: "normal",
        retainUntil: null
      }
    })

    // Now, run syncProjectMemory.
    const agent = {
      id: "test-agent",
      projectId: project.id,
      name: "test-agent",
      role: "Software Engineer",
      adapterType: "codex_local" as const,
      model: "gpt-4",
      instructionsPath: null,
      budgetLimit: null,
      budgetWindow: null,
      env: {},
      createdAt: now,
      updatedAt: now
    }

    await runtime.syncProjectMemory(project, agent)

    const eventsAfterSync = auditWriter.readRecent()
    const deleteEvent = eventsAfterSync.find((e) => e.event === "memory-governed-delete")
    expect(deleteEvent).toBeDefined()
    expect(deleteEvent?.data.sourceRef).toBe("repo:shared:old-file.md#0")

    store.close()
  })
})

describe("memory safety rules (independent of sqlite)", () => {
  it("allows safe content and rejects forbidden patterns", async () => {
    const { checkMemorySafety } = await import("../packages/memory-runtime/src/safety.js")

    // 1. Safe content
    expect(checkMemorySafety("This is completely safe memory.")).toEqual({ allowed: true })

    // 2. Forbidden patterns
    // Private keys
    expect(checkMemorySafety("My key: -----BEGIN RSA PRIVATE KEY-----")).toEqual({
      allowed: false,
      reason: "Rejected as forbidden memory: private key material"
    })

    // Access token
    expect(checkMemorySafety("token is ghp_abcdefghijklmnopqr")).toEqual({
      allowed: false,
      reason: "Rejected as forbidden memory: access token"
    })

    // PII
    expect(checkMemorySafety("SSN: 123-45-6789")).toEqual({
      allowed: false,
      reason: "Rejected as forbidden memory: PII-like identifier (SSN)"
    })

    // Network topology
    expect(checkMemorySafety("IP is 192.168.1.1")).toEqual({
      allowed: false,
      reason: "Rejected as forbidden memory: internal network topology"
    })

    // Logs/traces
    expect(checkMemorySafety("Application stack trace at error line 5")).toEqual({
      allowed: false,
      reason: "Rejected as forbidden memory: raw diagnostic payload"
    })

    // CI/PR status
    expect(checkMemorySafety("PR build failed on node 20")).toEqual({
      allowed: false,
      reason: "Rejected as forbidden memory: transient CI/PR status"
    })
  })
})
