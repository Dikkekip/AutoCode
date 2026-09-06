import type { PlannerCandidateTask, PlannerDecision } from "@openclaw/domain"
import { afterEach, describe, expect, it } from "vitest"

import { materializePlannerTasks } from "../packages/executor/src/planner/materialize.js"
import { loadProjectProfile } from "../packages/project-profiles/src/index.js"
import { createTempWorkspace } from "./helpers.js"
import { HAS_NODE_SQLITE } from "./node-sqlite.js"

let DispatcherStore: typeof import("@openclaw/db").DispatcherStore | null = null
if (HAS_NODE_SQLITE) {
  ;({ DispatcherStore } = await import("@openclaw/db"))
}

const describeDb = HAS_NODE_SQLITE ? describe : describe.skip

function candidate(dedupeKey: string, dependencies: string[] = []): PlannerCandidateTask {
  return {
    title: dedupeKey,
    description: `Implement ${dedupeKey}`,
    kind: "implement",
    lane: "app-core",
    personaId: "developer",
    preferredAdapterType: "codex_local",
    priority: 60,
    requiredReading: ["README.md"],
    verificationChecklist: ["pnpm test"],
    contractUpdateReminders: [],
    repoNotes: [],
    dependencies,
    tags: ["planner-generated"],
    riskLevel: "medium",
    governanceClass: "normal",
    dedupeKey,
    sourceSignals: ["repo-search:README.md"],
    estimatedCost: 1,
    createMode: "queue_now",
    targetPaths: [`packages/${dedupeKey}/src/index.ts`]
  }
}

describeDb("planner task dependency materialization", () => {
  const cleanups: Array<() => void> = []

  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.()
  })

  it("persists dependency ids in topological order even when candidates arrive out of order", () => {
    const workspace = createTempWorkspace("planner-dependencies")
    cleanups.push(workspace.cleanup)
    const store = new DispatcherStore!(workspace.dbPath)
    store.migrate()

    try {
      const company = store.createCompany({ name: "OpenClaw Labs" })
      const project = store.createProject({
        companyRef: company.id,
        name: "repo",
        repoPath: workspace.repoPath,
        verifyCommand: "pnpm test"
      })
      const candidates = [candidate("consumer", ["foundation"]), candidate("foundation")]
      const decisions: PlannerDecision[] = candidates.map((entry, candidateIndex) => ({
        candidateIndex,
        title: entry.title,
        dedupeKey: entry.dedupeKey,
        action: "create",
        reason: "test"
      }))

      const createdTaskIds = materializePlannerTasks({
        store,
        projectId: project.id,
        profile: loadProjectProfile("minimal-repo"),
        candidates,
        decisions,
        personaByName: () => null
      })

      const tasks = store.listProjectTasks(project.id)
      const foundation = tasks.find((task) => task.title === "foundation")!
      const consumer = tasks.find((task) => task.title === "consumer")!
      expect(createdTaskIds).toEqual([foundation.id, consumer.id])
      expect(consumer.dependsOnTaskIds).toEqual([foundation.id])
      expect(foundation.changedFiles).toEqual(["packages/foundation/src/index.ts"])
      expect(foundation.allowedPaths).toEqual(["packages/foundation/src/index.ts"])
      expect(decisions.find((decision) => decision.dedupeKey === "consumer")?.createdTaskId).toBe(consumer.id)
    } finally {
      store.close()
    }
  })
})
