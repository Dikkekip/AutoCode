import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  bestProfileMatch,
  installProjectProfile,
  listBuiltInProfileIds,
  loadProjectProfile,
  validateProjectProfile
} from "@openclaw/project-profiles"
import { afterEach, describe, expect, it } from "vitest"

import { createLawyerRagControlPlane, createTempWorkspace } from "./helpers.js"

describe("project profiles", () => {
  const cleanups: Array<() => void> = []

  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.()
  })

  it("lists built-in profiles and detects the LawyerRAG profile from repo signals", () => {
    const workspace = createTempWorkspace("project-profiles-detect")
    cleanups.push(workspace.cleanup)
    createLawyerRagControlPlane(workspace.repoPath)
    mkdirSync(join(workspace.repoPath, "apps", "backend", "lawyer_rag"), { recursive: true })
    mkdirSync(join(workspace.repoPath, "docs", "openclaw"), { recursive: true })
    writeFileSync(
      join(workspace.repoPath, "docs", "openclaw", "autonomous-improvement-loop.md"),
      "# autonomous improvement loop\n",
      "utf8"
    )

    const profileIds = listBuiltInProfileIds()
    expect(profileIds).toContain("lawyerrag")
    expect(profileIds).toContain("minimal-repo")

    const match = bestProfileMatch(workspace.repoPath)
    expect(match?.profileId).toBe("lawyerrag")
    expect(match?.score).toBeGreaterThan(0)

    const profile = loadProjectProfile("lawyerrag")
    expect(profile.framework.coreRuntime.inheritedFromLawyerRag).toContain(
      "Queue refresh, stale run recovery, and promotion sweep behavior from scripts/openclaw_director.py."
    )
    expect(profile.framework.memoryEval.borrowedFromSiblingRepos.some((source) => source.repoId === "agentscope")).toBe(
      true
    )
    expect(profile.personas?.map((persona) => persona.id)).toContain("lawyer-legal-strategy")
    expect(profile.personas?.map((persona) => persona.id)).toContain("barnevern-domain-specialist")
    expect(profile.planner.portfolioMix?.map((bucket) => bucket.bucket)).toContain("legal_domain")
    expect(profile.planner.portfolioMix?.map((bucket) => bucket.bucket)).toContain("frontend_product_ux")
    expect(profile.planner.costPolicy.preferredPlannerModel).toBe("auto")
    expect(profile.planner.costPolicy.plannerReasoningEffort).toBe("high")
    expect(profile.responsePolicy?.compressionMode).toBe("lite")
    expect(
      profile.verificationRules
        .filter((rule) => rule.ruleId.startsWith("ui-"))
        .map((rule) => [rule.ruleId, rule.commands[0]])
    ).toEqual([
      ["ui-shell-verify", "cd apps/reports-ui && npm run build"],
      ["ui-route-verify", "cd apps/reports-ui && npm run build"],
      ["ui-workspace-verify", "cd apps/reports-ui && npm run build"],
      ["ui-contracts-verify", "cd apps/reports-ui && npm run build"]
    ])
  })

  it("installs a profile into repo-local OpenClaw state", () => {
    const workspace = createTempWorkspace("project-profiles-install")
    cleanups.push(workspace.cleanup)

    const profile = loadProjectProfile("minimal-repo")
    expect(profile.responsePolicy?.compressionMode).toBe("full")
    const result = installProjectProfile(workspace.repoPath, profile)

    expect(result.written.length).toBeGreaterThan(0)
    expect(existsSync(join(workspace.repoPath, ".openclaw", "profile.json"))).toBe(true)
    expect(existsSync(join(workspace.repoPath, ".openclaw", "state", "bootstrap", "framework-map.json"))).toBe(true)
    expect(existsSync(join(workspace.repoPath, ".openclaw", "state", "bootstrap", "runtime.json"))).toBe(true)
    expect(existsSync(join(workspace.repoPath, ".openclaw", "jobs", "queue-refresh.json"))).toBe(true)

    const runtime = JSON.parse(
      readFileSync(join(workspace.repoPath, ".openclaw", "state", "bootstrap", "runtime.json"), "utf8")
    ) as { sourceProfileId: string; frameworkVersion: number; requiredJobIds: string[] }

    expect(runtime.sourceProfileId).toBe("minimal-repo")
    expect(runtime.frameworkVersion).toBe(1)
    expect(runtime.requiredJobIds).toContain("queue-refresh")
  })

  it("rejects unsupported response compression modes", () => {
    const profile = loadProjectProfile("minimal-repo")
    expect(() =>
      validateProjectProfile({
        ...profile,
        responsePolicy: { compressionMode: "verbose" }
      })
    ).toThrow("responsePolicy.compressionMode must be one of off, lite, full, or ultra")
  })
})
