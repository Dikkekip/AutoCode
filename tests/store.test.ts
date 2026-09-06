import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { createTempWorkspace } from "./helpers.js"
import { HAS_NODE_SQLITE } from "./node-sqlite.js"

let DispatcherStore: typeof import("@openclaw/db").DispatcherStore | null = null
if (HAS_NODE_SQLITE) {
  ;({ DispatcherStore } = await import("@openclaw/db"))
}

const describeDb = HAS_NODE_SQLITE ? describe : describe.skip

describeDb("dispatcher store sqlite pragmas", () => {
  it("enables WAL mode and a busy timeout for concurrent reads and writes", () => {
    const workspace = createTempWorkspace("dispatcher-store")
    const store = new DispatcherStore!(join(workspace.repoPath, ".openclaw", "dispatcher.db"))

    try {
      const journalModeRow = store.db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }
      const busyTimeoutRow = store.db.prepare("PRAGMA busy_timeout").get() as { timeout: number }

      expect(journalModeRow.journal_mode).toBe("wal")
      expect(busyTimeoutRow.timeout).toBe(5000)
    } finally {
      store.close()
      workspace.cleanup()
    }
  })
})

describeDb("dispatcher persona upsert", () => {
  it("atomically updates an existing company persona instead of violating its unique key", () => {
    const workspace = createTempWorkspace("dispatcher-persona-upsert")
    const dbPath = join(workspace.root, "persona-upsert.db")
    const firstStore = new DispatcherStore!(dbPath)
    firstStore.migrate()

    try {
      const company = firstStore.createCompany({ name: "Persona Upsert Co" })
      const created = firstStore.upsertPersona({
        companyRef: company.id,
        name: "backend-engineer",
        stage: "coder",
        ownedLanes: ["backend"],
        preferredAdapterType: "codex_local"
      })

      const secondStore = new DispatcherStore!(dbPath)
      try {
        const updated = secondStore.upsertPersona({
          companyRef: company.id,
          name: "backend-engineer",
          stage: "coder",
          ownedLanes: ["backend", "contracts"],
          preferredAdapterType: "azure_foundry"
        })

        expect(updated.id).toBe(created.id)
        expect(updated.ownedLanes).toEqual(["backend", "contracts"])
        expect(updated.preferredAdapterType).toBe("azure_foundry")
        expect(
          secondStore.listPersonas(company.id).filter((persona) => persona.name === "backend-engineer")
        ).toHaveLength(1)
      } finally {
        secondStore.close()
      }
    } finally {
      firstStore.close()
      workspace.cleanup()
    }
  })
})

describeDb("dispatcher planner dedupe lookup", () => {
  it("returns the newest matching task so a superseding decision controls future planning", () => {
    const workspace = createTempWorkspace("dispatcher-planner-dedupe")
    const store = new DispatcherStore!(join(workspace.root, "planner-dedupe.db"))
    store.migrate()

    try {
      const company = store.createCompany({ name: "Planner Dedupe Co" })
      const project = store.createProject({
        companyRef: company.id,
        name: "repo",
        repoPath: workspace.repoPath
      })
      const label = "planner-dedupe:fallback:ui-shell-system-action-group"
      const older = store.createTask({ projectRef: project.id, title: "Older candidate", labels: [label] })
      const newer = store.createTask({ projectRef: project.id, title: "Newer candidate", labels: [label] })
      store.db.prepare("UPDATE tasks SET created_at = ? WHERE id = ?").run("2026-07-01T00:00:00.000Z", older.id)
      store.db.prepare("UPDATE tasks SET created_at = ? WHERE id = ?").run("2026-07-02T00:00:00.000Z", newer.id)

      expect(store.findTaskByDedupeKey(project.id, "fallback:ui-shell-system-action-group")?.id).toBe(newer.id)
    } finally {
      store.close()
      workspace.cleanup()
    }
  })
})

describeDb("dispatcher automation lookup", () => {
  it("resolves a unique automation by name so operators can re-arm it without copying an id", () => {
    const workspace = createTempWorkspace("dispatcher-automation-lookup")
    const store = new DispatcherStore!(join(workspace.root, "automation-lookup.db"))
    store.migrate()

    try {
      const company = store.createCompany({ name: "Automation Co" })
      const project = store.createProject({
        companyRef: company.id,
        name: "repo",
        repoPath: workspace.repoPath
      })
      const automation = store.createAutomation({
        companyRef: company.id,
        projectRef: project.id,
        name: "queue-refresh",
        kind: "queue_refresh",
        cron: "*/5 * * * *",
        payload: { projectRef: project.id }
      })

      expect(store.resolveAutomation("queue-refresh", company.id).id).toBe(automation.id)
      expect(store.resolveAutomation(automation.id).name).toBe("queue-refresh")
    } finally {
      store.close()
      workspace.cleanup()
    }
  })
})

describeDb("dispatcher store claims", () => {
  it("atomically grants only one lease for a queued task", () => {
    const workspace = createTempWorkspace("dispatcher-claims")
    const store = new DispatcherStore!(join(workspace.root, "claims.db"))
    store.migrate()

    try {
      const company = store.createCompany({ name: "Claims Co" })
      const project = store.createProject({
        companyRef: company.id,
        name: "repo",
        repoPath: workspace.repoPath
      })
      const task = store.createTask({
        projectRef: project.id,
        title: "Contended task"
      })

      const firstLease = store.claimTask(task.id, { ownerAgentId: "agent-a" })
      const secondLease = store.claimTask(task.id, { ownerAgentId: "agent-b" })
      const claimedTask = store.getTaskById(task.id)

      expect(firstLease).not.toBeNull()
      expect(secondLease).toBeNull()
      expect(claimedTask.claimOwnerAgentId).toBe("agent-a")
      expect(claimedTask.claimToken).toBe(firstLease?.claimToken ?? null)
      expect(claimedTask.claimedAt).toBe(firstLease?.claimedAt ?? null)
    } finally {
      store.close()
      workspace.cleanup()
    }
  })

  it("atomically persists team ownership and releases artifact claims with the run", () => {
    const workspace = createTempWorkspace("dispatcher-team-claims")
    const store = new DispatcherStore!(join(workspace.root, "team-claims.db"))
    store.migrate()

    try {
      const company = store.createCompany({ name: "Team Claims Co" })
      const project = store.createProject({
        companyRef: company.id,
        name: "repo",
        repoPath: workspace.repoPath
      })
      const firstAgent = store.createAgent({
        companyRef: company.id,
        name: "backend-a",
        role: "Engineer",
        adapterType: "codex_local"
      })
      const secondAgent = store.createAgent({
        companyRef: company.id,
        name: "backend-b",
        role: "Engineer",
        adapterType: "codex_local"
      })
      const firstTask = store.createTask({ projectRef: project.id, title: "Own backend", changedFiles: ["src/**"] })
      const secondTask = store.createTask({
        projectRef: project.id,
        title: "Patch auth",
        changedFiles: ["src/auth.ts"]
      })

      const first = store.startRunWithClaim({
        companyId: company.id,
        projectId: project.id,
        taskId: firstTask.id,
        agentId: firstAgent.id,
        adapterType: firstAgent.adapterType,
        teamAssignment: {
          artifactPaths: firstTask.changedFiles,
          routingReason: "backend lane",
          routingDecision: { selectedAgentId: firstAgent.id }
        }
      })
      const overlapping = store.startRunWithClaim({
        companyId: company.id,
        projectId: project.id,
        taskId: secondTask.id,
        agentId: secondAgent.id,
        adapterType: secondAgent.adapterType,
        teamAssignment: {
          artifactPaths: secondTask.changedFiles,
          routingReason: "auth lane"
        }
      })

      expect(first?.assignment).toMatchObject({
        status: "active",
        agentId: firstAgent.id,
        artifactPaths: ["src"]
      })
      expect(overlapping).toBeNull()
      expect(store.getTaskById(secondTask.id).status).toBe("queued")
      expect(store.listTeamArtifactClaims({ projectId: project.id, status: "active" })).toHaveLength(1)

      store.completeRun(first!.run.id, { status: "succeeded" })
      expect(store.getTeamAssignmentByRunId(first!.run.id)).toMatchObject({
        status: "completed",
        releaseReason: "run_succeeded"
      })
      expect(store.listTeamArtifactClaims({ projectId: project.id, status: "active" })).toHaveLength(0)
      expect(store.listTeamArtifactClaims({ projectId: project.id, status: "released" })[0]).toMatchObject({
        artifactPath: "src",
        releaseReason: "run_succeeded"
      })

      const second = store.startRunWithClaim({
        companyId: company.id,
        projectId: project.id,
        taskId: secondTask.id,
        agentId: secondAgent.id,
        adapterType: secondAgent.adapterType,
        teamAssignment: {
          artifactPaths: secondTask.changedFiles,
          routingReason: "auth lane"
        }
      })
      expect(second?.assignment?.status).toBe("active")
      store.completeRun(second!.run.id, { status: "cancelled" })

      const recoveredTask = store.createTask({
        projectRef: project.id,
        title: "Recover abandoned ownership",
        changedFiles: ["packages/api/src/routes.ts"]
      })
      const recovered = store.startRunWithClaim({
        companyId: company.id,
        projectId: project.id,
        taskId: recoveredTask.id,
        agentId: firstAgent.id,
        adapterType: firstAgent.adapterType,
        teamAssignment: {
          artifactPaths: recoveredTask.changedFiles,
          routingReason: "api lane"
        }
      })
      store.recoverTaskClaim(recoveredTask.id, {
        status: "queued",
        reason: "claim_timeout"
      })
      expect(store.getRunById(recovered!.run.id).status).toBe("cancelled")
      expect(store.getTeamAssignmentByRunId(recovered!.run.id)).toMatchObject({
        status: "cancelled",
        releaseReason: "claim_timeout"
      })
      expect(store.findTeamArtifactConflicts(project.id, recoveredTask.changedFiles)).toHaveLength(0)
    } finally {
      store.close()
      workspace.cleanup()
    }
  })
})

describeDb("dispatcher store runtime metadata", () => {
  it("persists review results and can generate repair tasks from findings", () => {
    const workspace = createTempWorkspace("dispatcher-review-results")
    const store = new DispatcherStore!(join(workspace.root, "reviews.db"))
    store.migrate()

    try {
      const company = store.createCompany({ name: "Review Co" })
      const project = store.createProject({
        companyRef: company.id,
        name: "repo",
        repoPath: workspace.repoPath
      })
      const task = store.createTask({
        projectRef: project.id,
        title: "Change persistence",
        changedFiles: ["packages/db/src/schema.ts"]
      })
      const run = store.createRun({
        companyId: company.id,
        projectId: project.id,
        taskId: task.id,
        adapterType: "codex_local"
      })
      store.completeRun(run.id, {
        status: "succeeded",
        verificationSummary: "pnpm test"
      })

      const review = store.createReviewResult({
        companyId: company.id,
        projectId: project.id,
        runId: run.id,
        taskId: task.id,
        outcome: "architecture_blocked",
        summary: "Schema changed without migration coverage.",
        findings: [
          {
            severity: "high",
            summary: "Architecture or persistence rules may be affected.",
            files: ["packages/db/src/schema.ts"],
            areas: ["architecture/profile rules"],
            requiredFixes: ["Add migration coverage."]
          }
        ],
        severity: "high",
        changedFiles: ["packages/db/src/schema.ts"],
        riskLevel: "high",
        requiredFixes: ["Add migration coverage."],
        suggestedRepairPrompt: "Add migration coverage and rerun tests.",
        promotionRecommendation: "Do not promote until fixed."
      })
      const repairTask = store.createRepairTaskFromReview(review.id)
      const updatedReview = store.getReviewResultById(review.id)

      expect(updatedReview.outcome).toBe("architecture_blocked")
      expect(updatedReview.repairTaskId).toBe(repairTask.id)
      expect(repairTask.kind).toBe("fix_review_feedback")
      expect(repairTask.approvalRequired).toBe(true)
      expect(repairTask.description).toContain("Add migration coverage")
      const repairRun = store.createRun({
        companyId: company.id,
        projectId: project.id,
        taskId: repairTask.id,
        adapterType: "codex_local",
        kind: repairTask.kind
      })
      store.completeRun(repairRun.id, {
        status: "succeeded",
        verificationSummary: "pnpm test passed",
        branchName: "review-repair"
      })
      expect(store.getLatestSuccessfulImplementationRunForTask(repairTask.id)?.id).toBe(repairRun.id)
    } finally {
      store.close()
      workspace.cleanup()
    }
  })

  it("locks rejected authors out and persists the replacement handoff", () => {
    const workspace = createTempWorkspace("dispatcher-review-lockout")
    const store = new DispatcherStore!(join(workspace.root, "review-lockout.db"))
    store.migrate()

    try {
      const company = store.createCompany({ name: "Review Lockout Co" })
      const project = store.createProject({
        companyRef: company.id,
        name: "repo",
        repoPath: workspace.repoPath
      })
      const author = store.createAgent({
        companyRef: company.id,
        name: "author",
        role: "Engineer",
        adapterType: "codex_local"
      })
      const replacement = store.createAgent({
        companyRef: company.id,
        name: "replacement",
        role: "Engineer",
        adapterType: "codex_local"
      })
      const reviewer = store.createAgent({
        companyRef: company.id,
        name: "reviewer",
        role: "Reviewer",
        adapterType: "codex_local"
      })
      const originalTask = store.createTask({
        projectRef: project.id,
        title: "Implement auth",
        changedFiles: ["src/auth.ts"]
      })
      const implementation = store.startRunWithClaim({
        companyId: company.id,
        projectId: project.id,
        taskId: originalTask.id,
        agentId: author.id,
        adapterType: author.adapterType,
        teamAssignment: {
          artifactPaths: originalTask.changedFiles,
          routingReason: "author implementation"
        }
      })
      store.completeRun(implementation!.run.id, { status: "succeeded" })
      store.completeClaimedTask(originalTask.id, implementation!.lease.claimToken, "done", {
        assignedAgentId: author.id
      })

      const reviewTask = store.createTask({ projectRef: project.id, title: "Review auth", kind: "review" })
      const reviewerRun = store.createRun({
        companyId: company.id,
        projectId: project.id,
        taskId: reviewTask.id,
        agentId: reviewer.id,
        adapterType: reviewer.adapterType,
        kind: "review"
      })
      store.completeRun(reviewerRun.id, { status: "succeeded", reviewVerdict: "changes_requested" })
      const review = store.createReviewResult({
        companyId: company.id,
        projectId: project.id,
        runId: implementation!.run.id,
        taskId: originalTask.id,
        reviewerRunId: reviewerRun.id,
        outcome: "changes_requested",
        summary: "Auth validation must be independently revised.",
        findings: [],
        severity: "medium",
        changedFiles: originalTask.changedFiles,
        riskLevel: "medium",
        requiredFixes: ["Fix auth validation."],
        suggestedRepairPrompt: "Fix auth validation without broadening scope.",
        promotionRecommendation: "Re-review after repair."
      })
      const repairTask = store.createRepairTaskFromReview(review.id)
      const lockouts = store.listTeamReviewerLockouts({ taskId: repairTask.id, status: "active" })

      expect(repairTask.assignedAgentId).toBeNull()
      expect(lockouts).toHaveLength(1)
      expect(lockouts[0]).toMatchObject({
        lockedAgentId: author.id,
        reviewerAgentId: reviewer.id,
        reviewerActor: "reviewer",
        artifactPath: "src/auth.ts"
      })
      expect(store.listTeamMessages({ toAgentId: author.id })[0]).toMatchObject({
        kind: "blocker",
        fromAgentId: reviewer.id,
        taskId: repairTask.id
      })

      const rejectedAuthor = store.startRunWithClaim({
        companyId: company.id,
        projectId: project.id,
        taskId: repairTask.id,
        agentId: author.id,
        adapterType: author.adapterType,
        teamAssignment: {
          artifactPaths: [],
          routingReason: "author retry"
        }
      })
      expect(rejectedAuthor).toBeNull()

      const acceptedReplacement = store.startRunWithClaim({
        companyId: company.id,
        projectId: project.id,
        taskId: repairTask.id,
        agentId: replacement.id,
        adapterType: replacement.adapterType,
        teamAssignment: {
          artifactPaths: repairTask.changedFiles,
          routingReason: "independent replacement"
        }
      })
      expect(acceptedReplacement?.assignment?.agentId).toBe(replacement.id)
      expect(store.listTeamMessages({ toAgentId: replacement.id })[0]).toMatchObject({
        kind: "handoff",
        fromAgentId: reviewer.id,
        taskId: repairTask.id
      })

      const blockerMessage = store.listTeamMessages({ toAgentId: author.id })[0]!
      expect(store.acknowledgeTeamMessage(blockerMessage.id, author.id).acknowledgedAt).not.toBeNull()
      store.completeRun(acceptedReplacement!.run.id, { status: "succeeded" })
      expect(store.listTeamReviewerLockouts({ taskId: repairTask.id, status: "active" })).toHaveLength(0)
      expect(store.listTeamReviewerLockouts({ taskId: repairTask.id, status: "cleared" })[0]).toMatchObject({
        clearedReason: "independent_revision_completed"
      })
    } finally {
      store.close()
      workspace.cleanup()
    }
  })

  it("labels tasks with extracted references from title and description", () => {
    const workspace = createTempWorkspace("dispatcher-reference-labels")
    const store = new DispatcherStore!(join(workspace.root, "references.db"))
    store.migrate()

    try {
      const company = store.createCompany({ name: "Reference Co" })
      const project = store.createProject({
        companyRef: company.id,
        name: "repo",
        repoPath: workspace.repoPath
      })
      const task = store.createTask({
        projectRef: project.id,
        title: "Fix APP-123",
        description: "Follow up on /tasks/OPS-9.",
        labels: ["bug"]
      })

      expect(task.labels).toEqual(["bug", "ref:APP-123", "ref:OPS-9"])
    } finally {
      store.close()
      workspace.cleanup()
    }
  })

  it("backs up runtime state and quarantines running workspace execution", () => {
    const workspace = createTempWorkspace("dispatcher-quarantine")
    const store = new DispatcherStore!(join(workspace.root, "quarantine.db"))
    store.migrate()

    try {
      const company = store.createCompany({ name: "Quarantine Co" })
      const project = store.createProject({
        companyRef: company.id,
        name: "repo",
        repoPath: workspace.repoPath
      })
      const agent = store.createAgent({
        companyRef: company.id,
        name: "codex",
        role: "Engineer",
        adapterType: "codex_local"
      })
      store.createAutomation({
        companyRef: company.id,
        projectRef: project.id,
        name: "repo-health",
        kind: "repo_health",
        cron: "* * * * *",
        nextRunAt: new Date().toISOString(),
        payload: { projectRef: project.id }
      })
      const task = store.createTask({
        projectRef: project.id,
        title: "Running"
      })
      store.updateTaskStatus(task.id, "running", { assignedAgentId: agent.id })
      const run = store.createRun({
        companyId: company.id,
        projectId: project.id,
        taskId: task.id,
        agentId: agent.id,
        adapterType: "codex_local",
        worktreePath: workspace.repoPath
      })

      const backup = store.backupRuntimeState(join(workspace.root, "backup.db"))
      const quarantine = store.quarantineExecutionWorkspace({
        projectRef: project.id,
        worktreePath: workspace.repoPath
      })

      expect(backup.backupPath).toBe(join(workspace.root, "backup.db"))
      expect(quarantine).toMatchObject({
        pausedAutomations: 1,
        cancelledRuns: 1,
        requeuedTasks: 1
      })
      expect(store.getRunById(run.id).status).toBe("cancelled")
      expect(store.getTaskById(task.id).status).toBe("queued")
      expect(store.listAutomations(company.id)[0]?.status).toBe("paused")
    } finally {
      store.close()
      workspace.cleanup()
    }
  })

  it("redacts home path users before persisting run events", () => {
    const workspace = createTempWorkspace("dispatcher-run-redaction")
    const store = new DispatcherStore!(join(workspace.root, "redaction.db"))
    store.migrate()

    try {
      const company = store.createCompany({ name: "Redaction Co" })
      const project = store.createProject({
        companyRef: company.id,
        name: "repo",
        repoPath: workspace.repoPath
      })
      const task = store.createTask({
        projectRef: project.id,
        title: "Persist event"
      })
      const run = store.createRun({
        companyId: company.id,
        projectId: project.id,
        taskId: task.id
      })

      store.appendRunEvent(run.id, "info", "Read /home/example/Documents/autocode", {
        cwd: "/home/example/Documents/autocode",
        windows: "C:\\Users\\alice\\repo"
      })

      const event = store.getRunEvents(run.id)[0]!
      expect(event.message).toBe("Read /home/e******/Documents/autocode")
      expect(event.data).toEqual({
        cwd: "/home/e******/Documents/autocode",
        windows: "C:\\Users\\a****\\repo"
      })
    } finally {
      store.close()
      workspace.cleanup()
    }
  })

  it("bounds oversized run event payloads while preserving an audit preview", () => {
    const workspace = createTempWorkspace("dispatcher-run-event-bounds")
    const store = new DispatcherStore!(join(workspace.root, "bounded-events.db"))
    store.migrate()

    try {
      const company = store.createCompany({ name: "Bounded Events Co" })
      const project = store.createProject({ companyRef: company.id, name: "repo", repoPath: workspace.repoPath })
      const task = store.createTask({ projectRef: project.id, title: "Emit noisy verification" })
      const run = store.createRun({ companyId: company.id, projectId: project.id, taskId: task.id })

      store.appendRunEvent(run.id, "info", "Verification stdout", {
        command: "pnpm test",
        output: "x".repeat(100_000)
      })

      const event = store.getRunEvents(run.id)[0]!
      expect(event.data).toMatchObject({ truncated: true, maxBytes: 32_768 })
      expect(String(event.data?.preview)).toContain('{"command":"pnpm test","output":"xxx')
      const row = store.db.prepare("SELECT data_json FROM run_events WHERE id = ?").get(event.id) as {
        data_json: string
      }
      expect(Buffer.byteLength(row.data_json)).toBeLessThanOrEqual(32_768)
      store.completeRun(run.id, { status: "failed", errorText: "failure".repeat(100_000) })
      const completedRun = store.getRunById(run.id)
      expect(Buffer.byteLength(completedRun.errorText ?? "")).toBeLessThanOrEqual(65_536)
      expect(completedRun.errorText).toContain("...[truncated middle;")
      expect(completedRun.errorText).toMatch(/failure$/)
    } finally {
      store.close()
      workspace.cleanup()
    }
  })

  it("redacts and bounds oversized task event payloads", () => {
    const workspace = createTempWorkspace("dispatcher-task-event-bounds")
    const store = new DispatcherStore!(join(workspace.root, "bounded-task-events.db"))
    store.migrate()

    try {
      const company = store.createCompany({ name: "Bounded Task Events Co" })
      const project = store.createProject({ companyRef: company.id, name: "repo", repoPath: workspace.repoPath })
      const task = store.createTask({ projectRef: project.id, title: "Emit noisy routing context" })

      const event = store.appendTaskEvent(task.id, "routing", "Inspected /home/example/Documents/autocode", {
        cwd: "/home/example/Documents/autocode",
        output: "x".repeat(100_000)
      })

      expect(event.message).toBe("Inspected /home/e******/Documents/autocode")
      expect(event.data).toMatchObject({ truncated: true, maxBytes: 32_768 })
      expect(String(event.data?.preview)).toContain('{"cwd":"/home/e******/Documents/autocode","output":"xxx')
      const row = store.db.prepare("SELECT data_json FROM task_events WHERE id = ?").get(event.id) as {
        data_json: string
      }
      expect(Buffer.byteLength(row.data_json)).toBeLessThanOrEqual(32_768)
    } finally {
      store.close()
      workspace.cleanup()
    }
  })

  it("compacts consecutive duplicate runtime activity", () => {
    const workspace = createTempWorkspace("dispatcher-activity-compact")
    const store = new DispatcherStore!(join(workspace.root, "activity.db"))
    store.migrate()

    try {
      const company = store.createCompany({ name: "Activity Co" })
      const project = store.createProject({
        companyRef: company.id,
        name: "repo",
        repoPath: workspace.repoPath
      })
      const task = store.createTask({
        projectRef: project.id,
        title: "Noisy task"
      })
      const run = store.createRun({
        companyId: company.id,
        projectId: project.id,
        taskId: task.id
      })
      const plannerRun = store.createPlannerRun({
        companyId: company.id,
        projectId: project.id,
        trigger: "manual"
      })

      store.appendRunEvent(run.id, "warn", "Retrying", { attempt: 1 })
      store.appendRunEvent(run.id, "warn", "Retrying", { attempt: 1 })
      store.appendRunEvent(run.id, "info", "Recovered")
      store.appendRunEvent(run.id, "warn", "Retrying", { attempt: 1 })
      store.appendTaskEvent(task.id, "maintenance", "Lease expired")
      store.appendTaskEvent(task.id, "maintenance", "Lease expired")
      const retainedTaskEvent = store.appendTaskEvent(task.id, "routing", "Retain bounded routing context", {
        attempt: 1
      })
      store.appendPlannerEvent(plannerRun.id, "snapshot", "Collected repo snapshot", { files: 3 })
      store.appendPlannerEvent(plannerRun.id, "snapshot", "Collected repo snapshot", { files: 3 })
      store.db
        .prepare("UPDATE run_events SET data_json = ? WHERE id = ?")
        .run(JSON.stringify({ output: "legacy".repeat(20_000) }), store.getRunEvents(run.id)[2]!.id)
      store.db
        .prepare("UPDATE task_events SET data_json = ? WHERE id = ?")
        .run(JSON.stringify({ output: "legacy".repeat(20_000) }), retainedTaskEvent.id)
      store.db.prepare("UPDATE runs SET error_text = ?, metadata_json = ? WHERE id = ?").run(
        "failure".repeat(20_000),
        JSON.stringify({
          promptVariantId: "variant-1",
          telemetry: {
            traceId: "trace-1",
            runId: run.id,
            status: "error",
            executionPath: [{ kind: "run", id: run.id, label: "Noisy task" }],
            spans: [{ id: "span-1", attributes: { output: "legacy".repeat(20_000) } }],
            events: [{ id: "event-1" }],
            attributes: { error: "failure".repeat(20_000) }
          }
        }),
        run.id
      )

      const dryRun = store.compactRuntimeActivity({
        dryRun: true,
        backup: false,
        maxRunEventBytes: 8_192,
        maxRunTextBytes: 8_192
      })
      expect(dryRun.removed).toEqual({
        runEvents: 1,
        taskEvents: 1,
        plannerEvents: 1
      })
      expect(dryRun.boundedRunEvents).toBe(1)
      expect(dryRun.boundedTaskEvents).toBe(1)
      expect(dryRun.boundedRunTextFields).toBe(1)
      expect(dryRun.compactedRunMetadata).toBe(1)
      expect(store.getRunEvents(run.id)).toHaveLength(4)

      const compacted = store.compactRuntimeActivity({
        backup: false,
        vacuum: false,
        maxRunEventBytes: 8_192,
        maxRunTextBytes: 8_192
      })

      expect(compacted.removed).toEqual({
        runEvents: 1,
        taskEvents: 1,
        plannerEvents: 1
      })
      expect(compacted.boundedRunEvents).toBe(1)
      expect(compacted.boundedTaskEvents).toBe(1)
      expect(compacted.boundedRunTextFields).toBe(1)
      expect(compacted.compactedRunMetadata).toBe(1)
      expect(store.getRunEvents(run.id).map((event) => event.message)).toEqual(["Retrying", "Recovered", "Retrying"])
      expect(store.getRunEvents(run.id)[1]!.data).toMatchObject({ truncated: true, maxBytes: 8_192 })
      const compactedRun = store.getRunById(run.id)
      expect(Buffer.byteLength(compactedRun.errorText ?? "")).toBeLessThanOrEqual(8_192)
      expect(compactedRun.errorText).toContain("...[truncated middle;")
      expect(compactedRun.errorText).toMatch(/failure$/)
      expect(compactedRun.metadata?.promptVariantId).toBe("variant-1")
      expect(compactedRun.metadata?.telemetry).toMatchObject({
        traceId: "trace-1",
        spanCount: 1,
        eventCount: 1,
        compacted: true
      })
      expect(compactedRun.metadata?.telemetry).not.toHaveProperty("spans")
      expect(store.getTaskEvents(task.id)).toHaveLength(2)
      expect(store.getTaskEvents(task.id)[1]!.data).toMatchObject({ truncated: true, maxBytes: 8_192 })
      expect(store.getPlannerEvents(plannerRun.id)).toHaveLength(1)
    } finally {
      store.close()
      workspace.cleanup()
    }
  })

  it("persists run metadata and adapter lane health rows", () => {
    const workspace = createTempWorkspace("dispatcher-metadata")
    const store = new DispatcherStore!(join(workspace.root, "runtime.db"))
    store.migrate()

    try {
      const company = store.createCompany({ name: "Runtime Co" })
      const project = store.createProject({
        companyRef: company.id,
        name: "repo",
        repoPath: workspace.repoPath
      })
      const agent = store.createAgent({
        companyRef: company.id,
        name: "codex",
        role: "Engineer",
        adapterType: "codex_local"
      })
      const task = store.createTask({
        projectRef: project.id,
        title: "Attach metadata"
      })
      const run = store.createRun({
        companyId: company.id,
        projectId: project.id,
        taskId: task.id,
        agentId: agent.id,
        adapterType: "codex_local"
      })

      store.updateRunMetadata(run.id, {
        promptBudget: { compactionApplied: true, estimatedAfterTokens: 1200 },
        tooling: { repeatedReadsAvoided: 2 }
      })
      store.upsertAdapterLaneHealth({
        companyId: company.id,
        adapterType: "codex_local",
        laneKey: "account:alpha",
        laneLabel: "alpha",
        status: "quota_exhausted",
        reason: "cached quota exhausted",
        cooldownUntil: "2030-01-01T00:00:00.000Z",
        metadata: { source: "test" }
      })

      const refreshedRun = store.getRunById(run.id)
      const lane = store.getAdapterLaneHealth(company.id, "codex_local", "account:alpha")

      expect(refreshedRun.metadata).toMatchObject({
        promptBudget: { compactionApplied: true, estimatedAfterTokens: 1200 },
        tooling: { repeatedReadsAvoided: 2 }
      })
      expect(lane).toMatchObject({
        adapterType: "codex_local",
        laneKey: "account:alpha",
        status: "quota_exhausted",
        reason: "cached quota exhausted"
      })
    } finally {
      store.close()
      workspace.cleanup()
    }
  })
})
