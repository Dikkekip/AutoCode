import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createFakeGhScript, createTempWorkspace } from "./helpers.js"
import { HAS_NODE_SQLITE } from "./node-sqlite.js"

let NativeEvidenceStore: typeof import("../packages/core-runtime/src/native/store.js").NativeEvidenceStore
let DispatcherStore: typeof import("@openclaw/db").DispatcherStore | null = null
let DispatcherExecutor: typeof import("@openclaw/executor").DispatcherExecutor | null = null
let AuditWriter: typeof import("@openclaw/audit-runtime").AuditWriter | null = null

if (HAS_NODE_SQLITE) {
  ;({ NativeEvidenceStore } = await import("../packages/core-runtime/src/native/store.js"))
  ;({ DispatcherStore } = await import("@openclaw/db"))
  ;({ DispatcherExecutor } = await import("@openclaw/executor"))
  ;({ AuditWriter } = await import("@openclaw/audit-runtime"))
}

const describeDb = HAS_NODE_SQLITE ? describe : describe.skip

describeDb("Concurrency and Recovery", () => {
  const cleanups: Array<() => void> = []
  const originalPath = process.env.PATH

  afterEach(() => {
    process.env.PATH = originalPath
    while (cleanups.length > 0) {
      cleanups.pop()?.()
    }
    vi.useRealTimers()
  })

  async function setup() {
    const workspace = createTempWorkspace("concurrency-recovery")
    cleanups.push(workspace.cleanup)
    const store = new DispatcherStore!(workspace.dbPath)
    store.migrate()
    const company = store.createCompany({ name: "Concurrent Co" })
    const project = store.createProject({
      companyRef: company.id,
      name: "repo",
      repoPath: workspace.repoPath
    })
    const auditPath = join(workspace.repoPath, ".openclaw/audit.log")
    const auditWriter = new AuditWriter!(auditPath)

    const executor = new DispatcherExecutor!(
      store,
      {
        codex_local: {
          type: "codex_local",
          label: "Codex Local",
          capabilities: {
            supportsSessionResume: true,
            supportsCompaction: true,
            compactionStrategy: "rotate",
            preferredPlanningContextWindow: 128000,
            planningPriority: 100,
            planningCostClass: "high",
            nativeContextManagement: "confirmed",
            heartbeatIdentityMode: "prompt_and_env",
            defaultSessionCompaction: {
              enabled: true,
              maxSessionRuns: 0,
              maxRawInputTokens: 0,
              maxSessionAgeHours: 0
            }
          },
          prepare: async () => ({ argv: [], cwd: process.cwd(), env: {} }),
          execute: async () => ({ ok: true, response: "done" }),
          resume: async (s) => s?.state ?? null,
          parseResult: (s) => ({ ok: true, response: s, stdout: s, stderr: "" }),
          healthcheck: async () => ({ ok: true, message: "ok" })
        },
        gemini_local: {
          type: "gemini_local",
          label: "Gemini Local",
          capabilities: {
            supportsSessionResume: true,
            supportsCompaction: true,
            compactionStrategy: "summarize",
            preferredPlanningContextWindow: 1000000,
            planningPriority: 80,
            planningCostClass: "medium",
            nativeContextManagement: "unknown",
            heartbeatIdentityMode: "prompt_and_env",
            defaultSessionCompaction: {
              enabled: true,
              maxSessionRuns: 200,
              maxRawInputTokens: 2_000_000,
              maxSessionAgeHours: 72
            }
          },
          prepare: async () => ({ argv: [], cwd: process.cwd(), env: {} }),
          execute: async () => ({ ok: true, response: "done" }),
          resume: async (s) => s?.state ?? null,
          parseResult: (s) => ({ ok: true, response: s, stdout: s, stderr: "" }),
          healthcheck: async () => ({ ok: true, message: "ok" })
        }
      },
      () => auditWriter
    )

    return { workspace, store, company, project, executor, auditPath }
  }

  it("enforces lane-level PR concurrency (lane-blocking)", async () => {
    const { store, company, project, executor, auditPath } = await setup()

    store.createAgent({
      companyRef: company.id,
      name: "agent-1",
      role: "Coder",
      adapterType: "codex_local"
    })

    const task1 = store.createTask({
      projectRef: project.id,
      title: "Task 1",
      laneId: "lane-A",
      kind: "implement"
    })
    const task2 = store.createTask({
      projectRef: project.id,
      title: "Task 2",
      laneId: "lane-A",
      kind: "implement"
    })

    // 1. Manually create a promotion for Task 1 to simulate an open PR in lane-A
    const promotion = store.createPromotion({
      companyId: company.id,
      projectId: project.id,
      taskId: task1.id,
      branchName: "feature/task-1",
      promotionStatus: "waiting_for_review"
    })

    // 2. Tick. Task 2 should be blocked because lane-A is busy.
    const summary = await executor.tick()
    expect(summary.executedRuns).toBe(1)
    expect(summary.blockedTasks).toBe(1)

    const updatedTask2 = store.getTaskById(task2.id)
    expect(updatedTask2.status).toBe("blocked")
    expect(updatedTask2.blockedReason).toContain("lane_busy_with_active_pr")

    // 3. Verify audit log
    const auditContent = readFileSync(auditPath, "utf8")
    expect(auditContent).toContain("lane-blocked")
    expect(auditContent).toContain("lane-A")

    // 4. Once the blocking PR is merged, the next tick should recover the
    // stale lane block and execute the task instead of leaving it stranded.
    store.updatePromotion(promotion.id, {
      promotionStatus: "merged",
      mergedAt: new Date().toISOString()
    })

    const recoverySummary = await executor.tick()
    expect(recoverySummary.executedRuns).toBe(1)
    const recoveredTask2 = store.getTaskById(task2.id)
    expect(recoveredTask2.status).toBe("done")
    expect(recoveredTask2.blockedReason).toBeNull()
    expect(store.getTaskEvents(task2.id).some((event) => event.kind === "stale-lane-block-requeued")).toBe(true)
  })

  it("reconciles remotely merged PRs before recovering lane-blocked work", async () => {
    const { workspace, store, company, project, executor } = await setup()
    createFakeGhScript(workspace.root, "merged")
    process.env.PATH = `${workspace.root}:${originalPath ?? ""}`

    store.createAgent({
      companyRef: company.id,
      name: "agent-1",
      role: "Coder",
      adapterType: "codex_local"
    })

    const mergedTask = store.createTask({
      projectRef: project.id,
      title: "Merged elsewhere",
      laneId: "lane-A",
      kind: "implement"
    })
    store.updateTaskStatus(mergedTask.id, "failed", {
      blockedReason: "retired:stale-state"
    })
    const promoteTask = store.createTask({
      projectRef: project.id,
      title: "Promote: Merged elsewhere",
      laneId: "lane-A",
      kind: "promote",
      parentTaskId: mergedTask.id
    })
    store.updateTaskStatus(promoteTask.id, "blocked", {
      blockedReason: "awaiting_review_feedback"
    })
    const promotion = store.createPromotion({
      companyId: company.id,
      projectId: project.id,
      taskId: mergedTask.id,
      branchName: "feature/merged-elsewhere",
      promotionStatus: "waiting_for_review"
    })

    const waitingTask = store.createTask({
      projectRef: project.id,
      title: "Waiting on stale lane",
      laneId: "lane-A",
      kind: "implement"
    })
    store.updateTaskStatus(waitingTask.id, "blocked", {
      blockedReason: `lane_busy_with_active_pr:${promotion.id}`
    })

    const summary = await executor.tick()

    expect(summary.executedRuns).toBe(1)
    expect(store.getPromotionByTaskId(mergedTask.id)).toMatchObject({
      promotionStatus: "merged",
      mergedAt: "2026-05-08T20:00:00Z",
      headSha: "deadbeef",
      prNumber: 17
    })
    expect(store.getTaskById(mergedTask.id)).toMatchObject({ status: "done", blockedReason: null })
    expect(store.getTaskById(promoteTask.id)).toMatchObject({ status: "done", blockedReason: null })
    expect(store.getTaskById(waitingTask.id)).toMatchObject({ status: "done", blockedReason: null })
    expect(store.getTaskEvents(mergedTask.id).some((event) => event.kind === "promotion-remote-merge-reconciled")).toBe(
      true
    )
    expect(store.getTaskEvents(waitingTask.id).some((event) => event.kind === "stale-lane-block-requeued")).toBe(true)
  })

  it("reconciles a failed promotion after its pull request is repaired and merged remotely", async () => {
    const { workspace, store, company, project, executor } = await setup()
    createFakeGhScript(workspace.root, "merged")
    process.env.PATH = `${workspace.root}:${originalPath ?? ""}`

    const mergedTask = store.createTask({
      projectRef: project.id,
      title: "Draft PR repaired elsewhere",
      laneId: "lane-A",
      kind: "implement"
    })
    const promoteTask = store.createTask({
      projectRef: project.id,
      title: "Promote: Draft PR repaired elsewhere",
      laneId: "lane-A",
      kind: "promote",
      parentTaskId: mergedTask.id
    })
    store.updateTaskStatus(mergedTask.id, "blocked", {
      blockedReason: `promotion_failed:${promoteTask.id}`,
      lastError: "GraphQL: Pull Request is still a draft (mergePullRequest)"
    })
    store.updateTaskStatus(promoteTask.id, "blocked", {
      blockedReason: "unknown:unknown",
      lastError: "GraphQL: Pull Request is still a draft (mergePullRequest)"
    })
    const promotion = store.createPromotion({
      companyId: company.id,
      projectId: project.id,
      taskId: mergedTask.id,
      branchName: "feature/repaired-draft",
      prNumber: 17,
      promotionStatus: "failed"
    })
    store.updatePromotion(promotion.id, {
      lastError: "GraphQL: Pull Request is still a draft (mergePullRequest)"
    })

    await executor.tick()

    expect(store.getPromotionByTaskId(mergedTask.id)).toMatchObject({
      promotionStatus: "merged",
      mergedAt: "2026-05-08T20:00:00Z",
      lastError: null
    })
    expect(store.getTaskById(mergedTask.id)).toMatchObject({ status: "done", blockedReason: null, lastError: null })
    expect(store.getTaskById(promoteTask.id)).toMatchObject({ status: "done", blockedReason: null, lastError: null })
    expect(store.getTaskEvents(mergedTask.id).some((event) => event.kind === "promotion-remote-merge-reconciled")).toBe(
      true
    )
  })

  it("recovers tasks with expired claims (leases)", async () => {
    const { store, company, project, executor, auditPath } = await setup()

    const task = store.createTask({
      projectRef: project.id,
      title: "Expiring task",
      status: "queued"
    })

    // Simulate an expired claim
    const claimToken = "stale-token"
    const expiredAt = new Date(Date.now() - 1000).toISOString() // 1 second ago

    // We need to manually set these fields since claimTask uses current time + 30m
    ;(store as any).db
      .prepare(
        "UPDATE tasks SET status = 'running', claim_status = 'claimed', claim_token = ?, claim_expires_at = ? WHERE id = ?"
      )
      .run(claimToken, expiredAt, task.id)

    // Tick. Executor should reap the expired claim.
    const summary = await executor.tick()
    // One reaped run doesn't count as "executed run" in summary usually, but it counts in reaped runs internally.

    const updatedTask = store.getTaskById(task.id)
    expect(updatedTask.status).toBe("blocked")
    expect(updatedTask.claimStatus).toBe("expired")
    expect(updatedTask.lastError).toBeNull()

    // Verify audit log
    const auditContent = readFileSync(auditPath, "utf8")
    expect(auditContent).toContain("task-reclaimed")
    expect(auditContent).toContain("claim_timeout")
  })

  it("drains the queue after a simulated crash and restart", async () => {
    const { store, company, project, auditPath } = await setup()

    const agent = store.createAgent({
      companyRef: company.id,
      name: "planner-coder",
      role: "Engineer",
      adapterType: "codex_local"
    })
    const zombieAgent = store.createAgent({
      companyRef: company.id,
      name: "zombie-agent",
      role: "Engineer",
      adapterType: "codex_local"
    })
    store.setAgentStatus(zombieAgent.id, "running")

    const staleTask = store.createTask({
      projectRef: project.id,
      title: "Stale running task"
    })
    store.claimTask(staleTask.id)
    const staleRun = store.createRun({
      companyId: company.id,
      projectId: project.id,
      taskId: staleTask.id,
      agentId: agent.id,
      adapterType: "codex_local",
      sessionKey: `${agent.id}:${project.id}:${staleTask.id}`,
      wakeReason: "execution-sweep"
    })
    store.setAgentStatus(agent.id, "running")
    ;(store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db
      .prepare("UPDATE runs SET started_at = ?, created_at = ?, updated_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z", staleRun.id)

    const expiredTask = store.createTask({
      projectRef: project.id,
      title: "Expired lease task"
    })
    store.claimTask(expiredTask.id)
    store.updateTask(expiredTask.id, {
      claimExpiresAt: "2000-01-01T00:00:00.000Z"
    })

    const freshTask = store.createTask({
      projectRef: project.id,
      title: "Fresh queued task"
    })

    const restartedExecutor = new DispatcherExecutor!(
      store,
      {
        codex_local: {
          type: "codex_local",
          label: "Codex Local",
          capabilities: {
            supportsSessionResume: true,
            supportsCompaction: true,
            compactionStrategy: "rotate",
            preferredPlanningContextWindow: 128000,
            planningPriority: 100,
            planningCostClass: "high",
            nativeContextManagement: "confirmed",
            heartbeatIdentityMode: "prompt_and_env",
            defaultSessionCompaction: {
              enabled: true,
              maxSessionRuns: 0,
              maxRawInputTokens: 0,
              maxSessionAgeHours: 0
            }
          },
          prepare: async () => ({ argv: [], cwd: process.cwd(), env: {} }),
          execute: async () => ({ ok: true, response: "done" }),
          resume: async (s) => s?.state ?? null,
          parseResult: (s) => ({ ok: true, response: s, stdout: s, stderr: "" }),
          healthcheck: async () => ({ ok: true, message: "ok" })
        }
      },
      () => new AuditWriter!(auditPath)
    )

    const summary = await restartedExecutor.tick()
    expect(summary.executedRuns).toBe(3)
    expect(store.getTaskById(staleTask.id).status).toBe("done")
    expect(store.getTaskById(expiredTask.id).status).toBe("done")
    expect(store.getTaskById(freshTask.id).status).toBe("done")
    expect(store.getAgentById(agent.id).status).toBe("idle")
    expect(store.getAgentById(zombieAgent.id).status).toBe("idle")

    const auditContent = readFileSync(auditPath, "utf8")
    expect(auditContent).toContain("task-reclaimed")
    expect(auditContent).toContain("recovery-performed")
  })
})

describeDb("Native fenced lease recovery", () => {
  const cleanups: Array<() => void> = []
  afterEach(() => {
    vi.useRealTimers()
    while (cleanups.length) cleanups.pop()?.()
  })
  function setup() {
    const workspace = createTempWorkspace("native-lease-recovery")
    cleanups.push(workspace.cleanup)
    let now = 1_000
    const clock = () => now
    const first = new NativeEvidenceStore(workspace.dbPath, clock)
    const second = new NativeEvidenceStore(workspace.dbPath, clock)
    cleanups.push(
      () => second.close(),
      () => first.close()
    )
    return {
      workspace,
      first,
      second,
      advance: (ms: number) => {
        now += ms
      }
    }
  }

  it("opening another owner preserves a live reconciliation lease and operation evidence", () => {
    const { first, second, workspace } = setup()
    const lease = first.acquire("reconcile", 120_000)!
    first.put("operation", "deploy", { state: "started", receipt: "preserve me" }, lease)
    const restarted = new NativeEvidenceStore(workspace.dbPath, () => 1_000)
    try {
      expect(second.acquire("reconcile", 120_000)).toBeNull()
      expect(restarted.acquire("reconcile", 120_000)).toBeNull()
      expect(() => first.assertOwnership(lease)).not.toThrow()
      expect(restarted.get("operation", "deploy")).toEqual({ state: "started", receipt: "preserve me" })
    } finally {
      restarted.close()
    }
  })

  it("migrates legacy locks without clearing live ownership or operation evidence", async () => {
    const { DatabaseSync } = await import("node:sqlite")
    const workspace = createTempWorkspace("native-lease-migration")
    cleanups.push(workspace.cleanup)
    const db = new DatabaseSync(workspace.dbPath)
    db.exec(`CREATE TABLE native_locks(id TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL);
      INSERT INTO native_locks VALUES ('reconcile','legacy-live-owner',2000);
      CREATE TABLE native_records(kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(kind,id));
      INSERT INTO native_records VALUES ('operation','deploy','{"state":"started"}',1000);`)
    db.close()
    let now = 1_000
    const store = new NativeEvidenceStore(workspace.dbPath, () => now)
    try {
      expect(store.acquire("reconcile", 100)).toBeNull()
      expect(store.db.prepare("SELECT owner,expires_at,token FROM native_locks").get()).toMatchObject({
        owner: "legacy-live-owner",
        expires_at: 2000,
        token: 0
      })
      now = 2_000
      expect(store.acquire("reconcile", 100)?.token).toBe(1)
      expect(store.get("operation", "deploy")).toEqual({ state: "started" })
    } finally {
      store.close()
    }
  })

  it("uses injected time for renewal, exact expiry, and monotonically fenced takeover", () => {
    const { first, second, advance } = setup()
    const old = first.acquire("reconcile", 100)!
    first.put("operation", "merge", { state: "started" }, old)
    expect(second.renew(old, 100)).toBe(false)
    second.release(old)
    expect(() => first.assertOwnership(old)).not.toThrow()
    advance(90)
    expect(first.renew(old, 100)).toBe(true)
    advance(10)
    expect(second.acquire("reconcile", 100)).toBeNull()
    advance(90)
    expect(first.renew(old, 100)).toBe(false)
    const next = second.acquire("reconcile", 100)!
    expect(next.token).toBeGreaterThan(old.token)
    expect(first.renew(old, 100)).toBe(false)
    expect(() => first.put("operation", "merge", { state: "confirmed" }, old)).toThrow(/lease/i)
    expect(() => first.event("stale", "merge", {}, old)).toThrow(/lease/i)
    first.release(old)
    expect(() => second.assertOwnership(next)).not.toThrow()
    expect(second.get("operation", "merge")).toEqual({ state: "started" })
    second.release(next)
    const later = first.acquire("reconcile", 100)!
    expect(later.token).toBeGreaterThan(next.token)
    first.release(old)
    expect(() => first.assertOwnership(later)).not.toThrow()
  })

  it("renews while awaiting work and rejects detached work after the scope finishes", async () => {
    vi.useFakeTimers()
    const { first, second, advance } = setup()
    const lease = first.acquire("reconcile", 90)!
    let detached: () => Promise<void> = async () => {}
    await first.withLease(lease, 90, async () => {
      let resume!: () => void
      const pending = new Promise<void>((r) => {
        resume = r
      }).then(() => first.put("workflow", "detached", {}))
      // Attach a handler before releasing the deferred promise.
      detached = async () => {
        resume()
        await expect(pending).rejects.toThrow(/lease/i)
      }
      advance(30)
      await vi.advanceTimersByTimeAsync(30)
      advance(60)
      expect(second.acquire("reconcile", 90)).toBeNull()
      first.authorizeEffect()
    })
    await detached()
    expect(first.get("workflow", "detached")).toBeNull()
    expect(second.acquire("reconcile", 90)).not.toBeNull()
  })

  it("rejects stale runtime gateway effects after a deferred response resumes", async () => {
    const { first, second, advance } = setup()
    const { NativeAutonomyRuntime } = await import("../packages/core-runtime/src/native/runtime.js")
    const policy = {
      enabled: true,
      boardId: "board",
      workerConcurrency: 1
    } as import("@openclaw/domain").NativeAutonomyPolicy
    let resume!: () => void
    const waiting = new Promise<void>((r) => {
      resume = r
    })
    const effects: string[] = []
    const runtime = new NativeAutonomyRuntime(
      policy,
      {
        request: async (method) => {
          effects.push(method)
          await waiting
          return { card: { id: "card", title: "first", status: "blocked" } } as any
        }
      },
      first
    )
    const lease = first.acquire("reconcile", 100)!
    const run = first.withLease(lease, 100, async () => {
      await runtime.createCard({ title: "first", status: "blocked", idempotencyKey: "first" })
      await runtime.createCard({ title: "stale", status: "blocked", idempotencyKey: "stale" })
    })
    advance(100)
    const next = second.acquire("reconcile", 100)!
    expect(next.token).toBeGreaterThan(lease.token)
    resume()
    await expect(run).rejects.toThrow(/lease/i)
    expect(effects).toEqual(["workboard.cards.create"])
  })

  it("fences a suspended owner after takeover in a separate Node process", async () => {
    const { first, workspace } = setup()
    // Compile the actual store in isolation, so the child has no Vitest module mocks
    // and links the built domain dependency used by the real runtime.
    const require = createRequire(import.meta.url)
    const compiler = join(dirname(require.resolve("typescript/package.json")), "bin/tsc")
    const output = join(workspace.root, "child-store")
    execFileSync(
      process.execPath,
      [
        compiler,
        "--ignoreConfig",
        resolve("packages/core-runtime/src/native/store.ts"),
        "--outDir",
        output,
        "--target",
        "es2022",
        "--module",
        "nodenext",
        "--types",
        "node",
        "--skipLibCheck"
      ],
      { timeout: 30_000 }
    )
    writeFileSync(join(output, "package.json"), JSON.stringify({ type: "module" }))
    symlinkSync(resolve("packages/core-runtime/node_modules"), join(output, "node_modules"), "dir")
    const moduleUrl = pathToFileURL(join(output, "store.js")).href
    const child = (now: number) =>
      JSON.parse(
        execFileSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `
      import { NativeEvidenceStore } from ${JSON.stringify(moduleUrl)};
      const store = new NativeEvidenceStore(${JSON.stringify(workspace.dbPath)}, () => ${now});
      const lease = store.acquire("reconcile", 100);
      if (lease) store.put("workflow", "child", { committed: true }, lease);
      console.log(JSON.stringify({ lease, evidence: store.get("operation", "deploy") }));
      store.close();
    `
          ],
          { encoding: "utf8", timeout: 10_000 }
        )
      )
    const lease = first.acquire("reconcile", 100)!
    await expect(
      first.withLease(lease, 100, async () => {
        first.put("operation", "deploy", { state: "started", receipt: "unknown outcome" })
        expect(child(1_050).lease).toBeNull()
        const takeover = child(1_100)
        expect(takeover.lease.token).toBeGreaterThan(lease.token)
        expect(takeover.evidence).toEqual({ state: "started", receipt: "unknown outcome" })
        expect(() => first.authorizeEffect()).toThrow(/lease/i)
        const receipt = join(workspace.root, "receipt.json")
        writeFileSync(receipt, "preserved receipt")
        expect(() => first.fencedMutation(() => writeFileSync(receipt, "stale receipt"))).toThrow(/lease/i)
        expect(readFileSync(receipt, "utf8")).toBe("preserved receipt")
        expect(() => first.put("workflow", "child", { committed: false })).toThrow(/lease/i)
        expect(() => first.event("stale", "deploy", {})).toThrow(/lease/i)
      })
    ).rejects.toThrow(/lease/i)
    expect(first.get("workflow", "child")).toEqual({ committed: true })
    expect(first.get("operation", "deploy")).toEqual({ state: "started", receipt: "unknown outcome" })
  })
})
