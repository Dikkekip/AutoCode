import type { Project, TaskPackage } from "@openclaw/domain"
import { loadProjectProfile } from "@openclaw/project-profiles"
import { describe, expect, it } from "vitest"

import {
  type PromptPersonaInput,
  type PromptTemplateId,
  renderCodexPrompt
} from "../apps/dispatcher-cli/src/prompt-renderer.js"

const project: Project = {
  id: "project-1",
  companyId: "company-1",
  name: "Fixture Repo",
  repoPath: "/workspace/repo",
  verifyCommand: "pnpm check",
  profileId: null,
  profilePath: null,
  profile: {},
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
}

const taskPackage: TaskPackage = {
  version: 1,
  generatedAt: "2026-01-01T00:00:00.000Z",
  repoProfile: "minimal-repo",
  likelyOwnershipLane: "app-core",
  laneReason: "matched app-core fixture",
  inferenceSignals: ["matched app-core fixture"],
  requiredReading: ["README.md", "AGENTS.md"],
  verificationChecklist: ["pnpm test -- prompt-renderer"],
  contractUpdateReminders: ["Keep the public CLI contract stable."],
  repoNotes: ["Use the dispatcher CLI conventions."]
}

const personas: Array<{
  persona: PromptPersonaInput
  template: PromptTemplateId
}> = [
  {
    persona: {
      id: "prompt-engineer",
      name: "Prompt Engineer",
      stage: "coder",
      ownedLanes: ["app-core"]
    },
    template: "implementation"
  },
  {
    persona: {
      id: "reviewer",
      name: "Reviewer",
      stage: "reviewer",
      ownedLanes: ["app-core"]
    },
    template: "review"
  },
  {
    persona: {
      id: "repair-specialist",
      name: "Repair Specialist",
      stage: "coder",
      ownedLanes: ["app-core"]
    },
    template: "repair"
  },
  {
    persona: {
      id: "security-reviewer",
      name: "Security Reviewer",
      stage: "reviewer",
      ownedLanes: ["app-core"]
    },
    template: "security-review"
  },
  {
    persona: {
      id: "architect",
      name: "Architect",
      stage: "planner",
      ownedLanes: ["app-core"]
    },
    template: "architecture-analysis"
  }
]

describe("prompt renderer", () => {
  it.each(personas)("renders deterministic Codex prompts for $persona.id", ({ persona, template }) => {
    const prompt = renderCodexPrompt({
      title: "Build prompt rendering",
      description: "Convert task packages into Codex-ready prompts.",
      labels: ["prompt", "dispatcher"],
      changedFiles: ["apps/dispatcher-cli/src/prompt-renderer.ts"],
      taskPackage,
      taskId: "task-1",
      taskKind: "implement",
      laneId: "app-core",
      project,
      persona,
      profile: loadProjectProfile("minimal-repo"),
      template
    })

    expect(prompt).toMatchSnapshot()
    expect(prompt).toContain("## 7. Verification Commands")
    expect(prompt).toContain("`pnpm test -- prompt-renderer`")
  })

  it("falls back to a verification command when task and profile commands are empty", () => {
    const prompt = renderCodexPrompt({
      title: "Render prompt",
      labels: [],
      changedFiles: [],
      taskPackage: {
        ...taskPackage,
        verificationChecklist: [],
        likelyOwnershipLane: "unknown-lane"
      },
      taskId: "task-2",
      taskKind: "implement",
      laneId: "unknown-lane",
      project: { ...project, verifyCommand: null },
      persona: personas[0]!.persona,
      profile: null,
      template: "implementation"
    })

    expect(prompt).toContain("## 7. Verification Commands")
    expect(prompt).toContain("`pnpm test`")
  })

  it("keeps implement tasks on the implementation template when titles contain document words", () => {
    const prompt = renderCodexPrompt({
      title: "Add vedlegg document-date confidence badges",
      description: "Show confidence badges for document dates in the vedlegg workspace.",
      labels: ["planner-generated"],
      changedFiles: [],
      taskPackage,
      taskId: "task-3",
      taskKind: "implement",
      laneId: "app-core",
      project,
      persona: personas[0]!.persona,
      profile: loadProjectProfile("minimal-repo")
    })

    expect(prompt).toContain("Prompt template: implementation.")
    expect(prompt).toContain("Do not return only a plan, task package, or implementation brief")
  })
})
