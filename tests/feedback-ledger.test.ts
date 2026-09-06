import { afterEach, describe, expect, it } from "vitest"

import { createTempWorkspace } from "./helpers.js"
import { HAS_NODE_SQLITE } from "./node-sqlite.js"

let DispatcherStore: typeof import("@openclaw/db").DispatcherStore | null = null
if (HAS_NODE_SQLITE) {
  ;({ DispatcherStore } = await import("@openclaw/db"))
}

const describeDb = HAS_NODE_SQLITE ? describe : describe.skip

describeDb("outcome ledger", () => {
  const cleanups: Array<() => void> = []

  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.()
  })

  function setup() {
    const workspace = createTempWorkspace("outcome-ledger")
    cleanups.push(workspace.cleanup)
    const store = new DispatcherStore!(workspace.dbPath)
    store.migrate()
    const company = store.createCompany({ name: "OpenClaw Labs" })
    const project = store.createProject({
      companyRef: company.id,
      name: "repo",
      repoPath: workspace.repoPath
    })
    return { store, company, project }
  }

  it("records outcomes and aggregates per-lane stats", () => {
    const { store, company, project } = setup()
    const task = store.createTask({ projectRef: project.id, title: "Task", laneId: "lane-a" })

    store.recordTaskOutcome({
      companyId: company.id,
      projectId: project.id,
      taskId: task.id,
      laneId: "lane-a",
      stage: "execution",
      result: "success",
      verificationPassed: true
    })
    store.recordTaskOutcome({
      companyId: company.id,
      projectId: project.id,
      taskId: task.id,
      laneId: "lane-a",
      stage: "execution",
      result: "failure",
      retryCount: 1
    })

    const outcomes = store.listTaskOutcomes(project.id)
    expect(outcomes).toHaveLength(2)

    const stats = store.getLaneOutcomeStats(project.id)
    const laneA = stats.find((entry) => entry.laneId === "lane-a")
    expect(laneA?.total).toBe(2)
    expect(laneA?.success).toBe(1)
    expect(laneA?.failure).toBe(1)
    expect(laneA?.successRate).toBeCloseTo(0.5, 5)
  })

  it("upserts prompt variants and records trial results", () => {
    const { store, project } = setup()

    const created = store.upsertPromptVariant({
      projectId: project.id,
      scope: "planner",
      label: "baseline",
      promptHash: "hash-1"
    })
    expect(created.trials).toBe(0)

    store.recordPromptVariantTrial(created.id, true)
    store.recordPromptVariantTrial(created.id, false)

    const reloaded = store.getPromptVariantById(created.id)
    expect(reloaded.trials).toBe(2)
    expect(reloaded.successes).toBe(1)

    // Upserting the same scope+hash should not create a duplicate row.
    const again = store.upsertPromptVariant({
      projectId: project.id,
      scope: "planner",
      label: "baseline-renamed",
      promptHash: "hash-1"
    })
    expect(again.id).toBe(created.id)
    expect(store.listPromptVariants(project.id, "planner")).toHaveLength(1)
  })
})
