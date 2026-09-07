import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { loadProjectProfile } from "@openclaw/project-profiles"
import { afterEach, describe, expect, it } from "vitest"
import { createLawyerRagControlPlane, createTempWorkspace } from "./helpers.js"
import { HAS_NODE_SQLITE } from "./node-sqlite.js"

let DispatcherStore: typeof import("@openclaw/db").DispatcherStore | null = null
let runCli: typeof import("../apps/dispatcher-cli/src/index.js").runCli | null = null
let syncRepoOwnedOpenclaw: typeof import("../apps/dispatcher-cli/src/sync.js").syncRepoOwnedOpenclaw | null = null
if (HAS_NODE_SQLITE) {
  ;({ DispatcherStore } = await import("@openclaw/db"))
  ;({ runCli } = await import("../apps/dispatcher-cli/src/index.js"))
  ;({ syncRepoOwnedOpenclaw } = await import("../apps/dispatcher-cli/src/sync.js"))
}

const describeDb = HAS_NODE_SQLITE ? describe : describe.skip

describeDb("repo-owned .openclaw sync", () => {
  const cleanups: Array<() => void> = []

  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.()
  })

  it("imports LawyerRAG-style control-plane metadata into dispatcher records", async () => {
    const workspace = createTempWorkspace("dispatcher-sync")
    cleanups.push(workspace.cleanup)
    createLawyerRagControlPlane(workspace.repoPath)

    const output: string[] = []
    await runCli!(["sync", workspace.repoPath], {
      stdout: (message) => output.push(message),
      stderr: (message) => output.push(message)
    })
    await runCli!(["--db", join(workspace.repoPath, ".openclaw", "dispatcher.db"), "jobs", "list"], {
      stdout: (message) => output.push(message),
      stderr: (message) => output.push(message)
    })

    const store = new DispatcherStore!(join(workspace.repoPath, ".openclaw", "dispatcher.db"))
    try {
      const company = store.resolveCompany("Lawyer Labs")
      const project = store.resolveProject("LawyerRAG", company.id)
      const agents = store.listAgents(company.id)
      const personas = store.listPersonas(company.id)
      const jobs = store.listJobSpecs(company.id)
      const automations = store.listAutomations(company.id)
      const routingRules = store.listRoutingRules()
      const workflows = store.listWorkflows(company.id)
      const projectTasks = store.listProjectTasks(project.id)

      expect(project.verifyCommand).toBe("pytest -q")
      expect(agents.map((agent) => agent.name)).toEqual(["main", "planner", "promoter", "reviewer"])
      expect(personas.map((entry) => entry.name)).toContain("coder")
      expect(personas.map((entry) => entry.name)).toContain("planner")
      expect(jobs.map((job) => job.jobId)).toEqual(["execution-sweep", "promotion-sweep", "review-sweep"])
      expect(automations.map((entry) => entry.name)).toEqual(["execution-sweep", "promotion-sweep", "review-sweep"])

      const main = store.resolveAgent("main", company.id)
      expect(main.adapterType).toBe("codex_local")
      expect(main.budgetLimit).toBe(4000)
      expect(main.budgetWindow).toBe("monthly")
      expect(main.instructionsPath).toBe(join(workspace.repoPath, ".openclaw", "agents", "main.md"))

      const planner = store.resolveAgent("planner", company.id)
      expect(planner.adapterType).toBe("codex_local")
      expect(planner.budgetLimit).toBe(1200)
      expect(planner.budgetWindow).toBe("daily")

      expect(routingRules.map((rule) => rule.name)).toContain("openclaw-hint:citations-ui")
      expect(routingRules.map((rule) => rule.name)).toContain("openclaw-category:frontend")
      expect(routingRules.map((rule) => rule.name)).toContain("openclaw-lane:frontend-shell")
      expect(workflows.length).toBeGreaterThanOrEqual(1)
      expect(projectTasks.length).toBeGreaterThanOrEqual(4)
      expect(projectTasks.some((task) => task.labels.includes("openclaw-source:queue-item-1"))).toBe(true)
    } finally {
      store.close()
    }

    const fullOutput = output.join("")
    expect(fullOutput).toContain("Synchronized repo-owned .openclaw metadata")
    expect(fullOutput).toContain("Agents:")
    expect(fullOutput).toContain("Personas:")
    expect(fullOutput).toContain("Jobs:")
    expect(fullOutput).toContain("Automations:")
    expect(fullOutput).toContain("created: execution-sweep")
    expect(fullOutput).toContain("LawyerRAG | execution-sweep")
    expect(fullOutput).toContain("created: main")
    expect(fullOutput).toContain("Workflows:")
    expect(fullOutput).toContain("created: Improve citation explorer UX")
    expect(fullOutput).toContain("Could Not Map:")
    expect(fullOutput).toContain("- none")
  })

  it("merges into existing dispatcher records without destructive overwrites", () => {
    const workspace = createTempWorkspace("dispatcher-sync-merge")
    cleanups.push(workspace.cleanup)
    createLawyerRagControlPlane(workspace.repoPath)
    writeFileSync(
      join(workspace.repoPath, ".openclaw", "profile.json"),
      JSON.stringify({ ...loadProjectProfile("lawyerrag"), version: "test-profile" }),
      "utf8"
    )

    const store = new DispatcherStore!(join(workspace.repoPath, ".openclaw", "dispatcher.db"))
    store.migrate()

    try {
      const company = store.createCompany({ name: "Lawyer Labs" })
      store.createProject({
        companyRef: company.id,
        name: "LawyerRAG",
        repoPath: workspace.repoPath,
        verifyCommand: null
      })
      store.createAgent({
        companyRef: company.id,
        name: "main",
        role: "Custom Director",
        adapterType: "codex_local",
        model: "codex-max",
        instructionsPath: null,
        budgetLimit: 900,
        budgetWindow: "monthly"
      })
      store.createRoutingRule({
        name: "openclaw-category:frontend",
        priority: 50,
        targetAdapterType: "codex_local",
        patterns: ["ui"]
      })

      const summary = syncRepoOwnedOpenclaw!({
        targetPath: workspace.repoPath,
        store
      })

      const project = store.resolveProject("LawyerRAG", company.id)
      expect(project.verifyCommand).toBe("pytest -q")
      expect(project.profileId).toBe("lawyerrag")
      expect(project.profilePath).toBe(join(workspace.repoPath, ".openclaw", "profile.json"))
      expect(project.profile.version).toBe("test-profile")

      const main = store.resolveAgent("main", company.id)
      expect(main.role).toBe("Custom Director")
      expect(main.model).toBe("codex-max")
      expect(main.budgetLimit).toBe(900)
      expect(main.instructionsPath).toBe(join(workspace.repoPath, ".openclaw", "agents", "main.md"))

      const rule = store.findRoutingRuleByName("openclaw-category:frontend")
      expect(rule?.patterns).toContain("ui")
      expect(rule?.patterns).toContain("frontend")
      expect(rule?.priority).toBe(70)

      const jobs = store.listJobSpecs(company.id)
      expect(jobs).toHaveLength(3)

      expect(summary.skipped).toContain(
        "Agent main: kept existing role Custom Director instead of imported Autonomous Director"
      )
      expect(summary.skipped).toContain("Agent main: kept existing model codex-max instead of imported codex")
      expect(summary.skipped).toContain("Agent main: kept existing budget 900/monthly instead of imported 4000/monthly")
    } finally {
      store.close()
    }
  })

  it("re-arms active automations whose persisted schedule was cleared", () => {
    const workspace = createTempWorkspace("dispatcher-sync-rearm")
    cleanups.push(workspace.cleanup)
    createLawyerRagControlPlane(workspace.repoPath)

    const store = new DispatcherStore!(join(workspace.repoPath, ".openclaw", "dispatcher.db"))
    store.migrate()

    try {
      syncRepoOwnedOpenclaw!({ targetPath: workspace.repoPath, store })
      const company = store.resolveCompany("Lawyer Labs")
      const automation = store.listAutomations(company.id).find((entry) => entry.name === "execution-sweep")!
      store.updateAutomation(automation.id, { nextRunAt: null })

      const summary = syncRepoOwnedOpenclaw!({ targetPath: workspace.repoPath, store })
      const rearmed = store.getAutomationById(automation.id)

      expect(rearmed.nextRunAt).not.toBeNull()
      expect(summary.automations.find((entry) => entry.name === "execution-sweep")).toMatchObject({
        status: "updated",
        details: expect.arrayContaining(["re-armed stalled active schedule"])
      })
    } finally {
      store.close()
    }
  })

  it("assigns seeded workflows to lane-specific personas when manager state provides them", () => {
    const workspace = createTempWorkspace("dispatcher-sync-personas")
    cleanups.push(workspace.cleanup)
    createLawyerRagControlPlane(workspace.repoPath)

    writeFileSync(
      join(workspace.repoPath, ".openclaw", "state", "current", "manager_state.json"),
      JSON.stringify(
        {
          version: 1,
          manager_personas: [
            {
              id: "contracts-api-owner",
              focus: "Own API facade and contract-safe verification",
              owned_lanes: ["frontend-shell"],
              preferredModel: "codex"
            },
            {
              id: "release-quality-reviewer",
              focus: "Own review evidence quality",
              owned_lanes: ["frontend-shell"],
              preferredModel: "codex"
            },
            {
              id: "promoter-lawyerrag",
              focus: "Own promotion continuity",
              owned_lanes: [],
              preferredModel: "codex"
            }
          ],
          projects: [
            {
              id: "contracts-hardening",
              title: "Contract-safe lane ownership",
              status: "active",
              lane: "frontend-shell",
              category: "frontend",
              managerPersona: "contracts-api-owner",
              seedTask: {
                id: "seed-contracts-hardening",
                title: "Keep the frontend-shell lane scoped to the contract owner",
                kind: "manager-seeded-project",
                priority: 91,
                verificationHint: "Confirm the contract owner is selected."
              }
            }
          ]
        },
        null,
        2
      ),
      "utf8"
    )
    writeFileSync(
      join(workspace.repoPath, ".openclaw", "state", "bootstrap", "manager_state.json"),
      JSON.stringify(
        {
          version: 1,
          manager_personas: [],
          projects: []
        },
        null,
        2
      ),
      "utf8"
    )

    for (const name of ["contracts-api-owner", "release-quality-reviewer", "promoter-lawyerrag"]) {
      writeFileSync(
        join(workspace.repoPath, ".openclaw", "agents", `${name}.md`),
        `# ${name}\n\n${name} prompt\n`,
        "utf8"
      )
    }

    const store = new DispatcherStore!(join(workspace.repoPath, ".openclaw", "dispatcher.db"))
    store.migrate()

    try {
      syncRepoOwnedOpenclaw!({
        targetPath: workspace.repoPath,
        store
      })

      const company = store.resolveCompany("Lawyer Labs")
      const project = store.resolveProject("LawyerRAG", company.id)
      const tasks = store
        .listProjectTasks(project.id)
        .filter((task) => task.labels.includes("openclaw-manager-project:contracts-hardening"))

      const plannerPersona = store.resolvePersona("planner", company.id)
      const coderPersona = store.resolvePersona("contracts-api-owner", company.id)
      const reviewerPersona = store.resolvePersona("release-quality-reviewer", company.id)
      const promoterPersona = store.resolvePersona("promoter-lawyerrag", company.id)

      expect(tasks).toHaveLength(4)
      expect(tasks.find((task) => task.stage === "planner")?.personaId).toBe(plannerPersona.id)
      expect(tasks.find((task) => task.stage === "coder")?.personaId).toBe(coderPersona.id)
      expect(tasks.find((task) => task.stage === "reviewer")?.personaId).toBe(reviewerPersona.id)
      expect(tasks.find((task) => task.stage === "promoter")?.personaId).toBe(promoterPersona.id)
    } finally {
      store.close()
    }
  })

  it("imports profile-style camelCase manager personas during repo-owned sync", () => {
    const workspace = createTempWorkspace("dispatcher-sync-camelcase-personas")
    cleanups.push(workspace.cleanup)
    createLawyerRagControlPlane(workspace.repoPath)

    writeFileSync(
      join(workspace.repoPath, ".openclaw", "state", "bootstrap", "manager_state.json"),
      JSON.stringify(
        {
          version: 1,
          managerPersonas: [
            {
              id: "backend-engineer",
              focus: "Own backend task execution and reliability fixes",
              ownedLaneIds: ["backend-ingestion-and-aiops"],
              preferredAdapterType: "codex_local"
            }
          ],
          projects: []
        },
        null,
        2
      ),
      "utf8"
    )
    writeFileSync(
      join(workspace.repoPath, ".openclaw", "agents", "backend-engineer.md"),
      "# Backend Engineer\n\nBackend prompt\n",
      "utf8"
    )

    const store = new DispatcherStore!(join(workspace.repoPath, ".openclaw", "dispatcher.db"))
    store.migrate()

    try {
      syncRepoOwnedOpenclaw!({
        targetPath: workspace.repoPath,
        store
      })

      const company = store.resolveCompany("Lawyer Labs")
      const persona = store.resolvePersona("backend-engineer", company.id)
      const routingRule = store.findRoutingRuleByName("openclaw-persona:backend-engineer")

      expect(persona.preferredAdapterType).toBe("codex_local")
      expect(persona.ownedLanes).toContain("backend-ingestion-and-aiops")
      expect(routingRule?.patterns).toContain("backend-ingestion-and-aiops")
    } finally {
      store.close()
    }
  })

  it("is idempotent on rerun", () => {
    const workspace = createTempWorkspace("dispatcher-sync-idempotent")
    cleanups.push(workspace.cleanup)
    createLawyerRagControlPlane(workspace.repoPath)

    const store = new DispatcherStore!(join(workspace.repoPath, ".openclaw", "dispatcher.db"))
    store.migrate()

    try {
      syncRepoOwnedOpenclaw!({
        targetPath: workspace.repoPath,
        store
      })

      const firstAgentCount = store.listAgents().length
      const firstRuleCount = store.listRoutingRules().length

      const summary = syncRepoOwnedOpenclaw!({
        targetPath: workspace.repoPath,
        store
      })

      expect(store.listAgents()).toHaveLength(firstAgentCount)
      expect(store.listJobSpecs()).toHaveLength(3)
      expect(store.listRoutingRules()).toHaveLength(firstRuleCount)
      expect(summary.company.status).toBe("kept")
      expect(summary.project.status).toBe("kept")
      expect(summary.agents.every((agent) => agent.status === "kept")).toBe(true)
      expect(summary.jobs.every((job) => job.status === "kept")).toBe(true)
      expect(summary.routingRules.every((rule) => rule.status === "kept")).toBe(true)
    } finally {
      store.close()
    }
  })

  it("warns and skips unsupported or invalid job specs", () => {
    const workspace = createTempWorkspace("dispatcher-sync-jobs")
    cleanups.push(workspace.cleanup)
    createLawyerRagControlPlane(workspace.repoPath)

    writeFileSync(
      join(workspace.repoPath, ".openclaw", "jobs", "unsupported.json"),
      JSON.stringify(
        {
          id: "queue-refresh",
          schedule: {
            cron: "*/5 * * * *",
            timezone: "UTC"
          }
        },
        null,
        2
      ),
      "utf8"
    )
    writeFileSync(join(workspace.repoPath, ".openclaw", "jobs", "broken.json"), "{not-json", "utf8")

    const store = new DispatcherStore!(join(workspace.repoPath, ".openclaw", "dispatcher.db"))
    store.migrate()

    try {
      const summary = syncRepoOwnedOpenclaw!({
        targetPath: workspace.repoPath,
        store
      })

      expect(store.listJobSpecs()).toHaveLength(4)
      expect(
        summary.warnings.some((warning) => warning.startsWith("Failed to parse .openclaw/jobs/broken.json:"))
      ).toBe(true)
    } finally {
      store.close()
    }
  })

  it("does not duplicate manager-seeded projects that also appear in fresh queue state", () => {
    const workspace = createTempWorkspace("dispatcher-sync-manager-dedupe")
    cleanups.push(workspace.cleanup)
    createLawyerRagControlPlane(workspace.repoPath)

    writeFileSync(
      join(workspace.repoPath, ".openclaw", "state", "current", "queue.json"),
      JSON.stringify(
        {
          version: 1,
          mode: "fresh-queue",
          items: [
            {
              id: "manager-contracts-hardening",
              lane: "frontend-shell",
              category: "frontend",
              priority: 91,
              kind: "manager-seeded-project",
              title: "Keep the frontend-shell lane scoped to the contract owner",
              status: "queued",
              source: "manager-project"
            }
          ]
        },
        null,
        2
      ),
      "utf8"
    )

    writeFileSync(
      join(workspace.repoPath, ".openclaw", "state", "current", "manager_state.json"),
      JSON.stringify(
        {
          version: 1,
          manager_personas: [
            {
              id: "contracts-api-owner",
              focus: "Own API facade and contract-safe verification",
              owned_lanes: ["frontend-shell"],
              preferredModel: "codex"
            }
          ],
          projects: [
            {
              id: "contracts-hardening",
              title: "Contract-safe lane ownership",
              status: "active",
              lane: "frontend-shell",
              category: "frontend",
              managerPersona: "contracts-api-owner",
              seedTask: {
                id: "manager-contracts-hardening",
                title: "Keep the frontend-shell lane scoped to the contract owner",
                kind: "manager-seeded-project",
                priority: 91
              }
            }
          ]
        },
        null,
        2
      ),
      "utf8"
    )

    writeFileSync(
      join(workspace.repoPath, ".openclaw", "state", "bootstrap", "manager_state.json"),
      JSON.stringify({ version: 1, manager_personas: [], projects: [] }, null, 2),
      "utf8"
    )

    writeFileSync(
      join(workspace.repoPath, ".openclaw", "agents", "contracts-api-owner.md"),
      "# contracts-api-owner\n",
      "utf8"
    )

    const store = new DispatcherStore!(join(workspace.repoPath, ".openclaw", "dispatcher.db"))
    store.migrate()

    try {
      syncRepoOwnedOpenclaw!({
        targetPath: workspace.repoPath,
        store
      })

      const company = store.resolveCompany("Lawyer Labs")
      const project = store.resolveProject("LawyerRAG", company.id)
      const tasks = store
        .listProjectTasks(project.id)
        .filter((task) => task.labels.includes("openclaw-manager-project:contracts-hardening"))
      const workflows = store
        .listWorkflows(company.id)
        .filter((workflow) => workflow.title === "Keep the frontend-shell lane scoped to the contract owner")

      expect(tasks).toHaveLength(4)
      expect(workflows).toHaveLength(1)
    } finally {
      store.close()
    }
  })
})
