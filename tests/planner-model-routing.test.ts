import type { Agent, RepoPlanningSnapshot } from "@openclaw/domain"
import { loadProjectProfile } from "@openclaw/project-profiles"
import { describe, expect, it } from "vitest"
import { plannerComplexity, resolvePlannerExecutionAgent } from "../packages/executor/src/planner/run-planner.js"

describe("adaptive persona planning", () => {
  const agent = { adapterType: "codex_local", model: "gpt-5.5", env: {} } as Agent

  it.each([
    [40, "gpt-5.6-terra"],
    [69, "gpt-5.6-terra"],
    [70, "gpt-5.6-sol"],
    [89, "gpt-5.6-sol"],
    [90, "gpt-6-astra"],
    [100, "gpt-6-astra"]
  ])("routes planning complexity %s to %s", (score, model) => {
    expect(resolvePlannerExecutionAgent(loadProjectProfile("lawyerrag"), agent, Number(score)).model).toBe(model)
  })

  it("preserves explicit model pins and provider compatibility", () => {
    const profile = loadProjectProfile("lawyerrag")
    profile.planner.costPolicy.preferredPlannerModel = "gpt-5.6-terra"
    expect(resolvePlannerExecutionAgent(profile, agent, 100).model).toBe("gpt-5.6-terra")
    profile.planner.costPolicy.preferredPlannerModel = "auto"
    const foundry = { ...agent, adapterType: "azure_foundry", model: "Kimi-K2.6" } as Agent
    expect(resolvePlannerExecutionAgent(profile, foundry, 100).model).toBe("Kimi-K2.6")
  })

  it("scores repository breadth and unresolved decisions independently of prose length", () => {
    const snapshot = {
      changedFiles: [],
      laneHotspots: [],
      staleTasks: [],
      directives: []
    } as unknown as RepoPlanningSnapshot
    expect(plannerComplexity(snapshot)).toBe(40)
    const broad = {
      ...snapshot,
      changedFiles: Array(20).fill("file"),
      laneHotspots: Array(5).fill({}),
      staleTasks: Array(5).fill({}),
      directives: Array(5).fill("decision")
    }
    expect(plannerComplexity(broad)).toBe(100)
    expect(plannerComplexity({ ...snapshot, directives: ["long directive ".repeat(1000)] })).toBe(42)
  })
})
