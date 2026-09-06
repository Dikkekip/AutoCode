import type { Persona, Project, RepoContext } from "@openclaw/domain"
import { describe, expect, it } from "vitest"
import {
  defaultPersonaImprovementPaths,
  renderPersonaImprovementPrompt
} from "../apps/dispatcher-cli/src/persona-improve.js"

describe("persona improvement prompt", () => {
  it("renders repo-specific context and installed persona state", () => {
    const project: Project = {
      id: "project-1",
      companyId: "company-1",
      name: "demo",
      repoPath: "/tmp/demo",
      verifyCommand: "pnpm test",
      createdAt: "2026-05-03T00:00:00.000Z"
    }
    const repoContext: RepoContext = {
      profileName: "node workspace",
      sharedReads: ["README.md"],
      codexReads: ["AGENTS.md"],
      geminiReads: ["apps/web/STYLE_RECIPE.md"],
      repoMap: [],
      codexVerify: ["pnpm test"],
      geminiVerify: ["pnpm test -- --ui"],
      repoNotes: ["Project-level verify command: `pnpm test`."],
      uiRoots: ["apps/web"],
      backendRoots: ["packages/api"],
      contractPaths: ["contracts/openapi.yaml"],
      sharedReadItems: [{ path: "README.md", reason: "project overview" }],
      codexReadItems: [{ path: "AGENTS.md", reason: "agent rules" }],
      geminiReadItems: [{ path: "apps/web/STYLE_RECIPE.md", reason: "UI style" }],
      stackProfiles: [{ kind: "frontend", path: "apps/web", label: "frontend application", stack: ["React"] }],
      contractProfiles: [{ path: "contracts/openapi.yaml", label: "OpenAPI contract" }],
      laneDocProfiles: [{ path: "docs/backend.md", label: "backend lane" }],
      controlPlaneSignals: [],
      codexVerifyCommands: [{ command: "pnpm test", reason: "workspace tests" }],
      geminiVerifyCommands: [{ command: "pnpm test -- --ui", reason: "UI tests" }],
      projectVerifyCommand: "pnpm test"
    }
    const runtimePersonas: Persona[] = [
      {
        id: "persona-1",
        companyId: "company-1",
        name: "planner",
        stage: "planner",
        ownedLanes: ["planning"],
        preferredAdapterType: "codex_local",
        instructionsPath: "/tmp/demo/.openclaw/agents/planner.md",
        status: "active",
        budgetLimit: null,
        budgetWindow: "monthly",
        createdAt: "2026-05-03T00:00:00.000Z",
        updatedAt: "2026-05-03T00:00:00.000Z"
      }
    ]

    const prompt = renderPersonaImprovementPrompt({
      project,
      profileId: "minimal-repo",
      repoContext,
      runtimePersonas,
      profilePersonas: [],
      generatedAt: "2026-05-03T00:00:00.000Z"
    })

    expect(prompt).toContain("Project: demo")
    expect(prompt).toContain("Selected profile: minimal-repo")
    expect(prompt).toContain("apps/web: frontend application (React)")
    expect(prompt).toContain("contracts/openapi.yaml: OpenAPI contract")
    expect(prompt).toContain("planner")
    expect(prompt).toContain("Do not apply the changes yourself.")
  })

  it("uses stable proposal file names from the generation timestamp", () => {
    const paths = defaultPersonaImprovementPaths("/repo", "2026-05-03T10:20:30.000Z")

    expect(paths.promptPath).toBe("/repo/.openclaw/proposals/persona-improvement-20260503T102030Z.prompt.md")
    expect(paths.proposalPath).toBe("/repo/.openclaw/proposals/persona-improvement-20260503T102030Z.proposal.md")
  })
})
