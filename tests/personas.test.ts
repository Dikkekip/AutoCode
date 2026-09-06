import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  builtInPersonas,
  mergePersonaDefinitions,
  validatePersonaDefinition,
  validatePersonaSet
} from "@openclaw/domain"
import {
  listBuiltInProfileIds,
  loadProjectProfile,
  loadProjectProfilePersonas,
  validateProjectProfile
} from "@openclaw/project-profiles"
import { describe, expect, it } from "vitest"

function loadMinimalProfileFixture(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(process.cwd(), "profiles/minimal-repo/profile.json"), "utf8")) as Record<
    string,
    unknown
  >
}

describe("persona framework", () => {
  it("loads the required built-in virtual company personas", () => {
    const ids = builtInPersonas.map((persona) => persona.id)

    expect(ids).toEqual([
      "ceo-product-owner",
      "cto-system-architect",
      "engineering-manager",
      "planner",
      "backend-engineer",
      "frontend-engineer",
      "devops-engineer",
      "security-engineer",
      "qa-engineer",
      "code-reviewer",
      "release-manager",
      "documentation-engineer",
      "memory-curator",
      "incident-commander",
      "prompt-engineer"
    ])
    expect(validatePersonaSet(builtInPersonas).valid).toBe(true)
  })

  it("fails invalid persona definitions with useful field errors", () => {
    const result = validatePersonaDefinition({
      id: "",
      name: "Broken",
      role: "Broken",
      responsibilities: [],
      decisionAuthority: [],
      allowedLanes: "backend",
      forbiddenActions: [],
      defaultAdapterPreference: "unknown",
      promptStyle: { voice: "", format: [], interactionRules: [] },
      requiredReading: [],
      verificationRules: []
    })

    expect(result.valid).toBe(false)
    expect(result.errors).toContain("persona.id must be a non-empty string")
    expect(result.errors).toContain("persona.allowedLanes must be an array of non-empty strings")
    expect(result.errors).toContain(
      "persona.defaultAdapterPreference must be one of codex_local, gemini_local, azure_foundry"
    )
    expect(result.errors).toContain("persona.promptStyle.voice must be a non-empty string")
  })

  it("applies project profile overrides and extensions", () => {
    const personas = loadProjectProfilePersonas("minimal-repo")
    const planner = personas.find((persona) => persona.id === "planner")
    const minimalEngineer = personas.find((persona) => persona.id === "minimal-runtime-engineer")

    expect(personas.length).toBe(16)
    expect(planner?.allowedLanes).toEqual(["app-core", "planning"])
    expect(minimalEngineer?.role).toBe("Backend Engineer")
    expect(minimalEngineer?.defaultAdapterPreference).toBe("codex_local")
    expect(minimalEngineer?.allowedLanes).toEqual(["app-core"])
  })

  it("validates every built-in profile persona setup", () => {
    expect(listBuiltInProfileIds()).toEqual(["lawyerrag", "minimal-repo"])

    for (const profileId of listBuiltInProfileIds()) {
      expect(() => loadProjectProfile(profileId)).not.toThrow()
    }
  })

  it("rejects profile persona extensions with unknown bases", () => {
    expect(() =>
      mergePersonaDefinitions(undefined, [
        {
          id: "unknown-extension",
          extends: "missing-persona"
        }
      ])
    ).toThrow("personas[0] extends unknown persona missing-persona")
  })

  it("rejects profile persona setup with broken lane ownership references", () => {
    const profile = loadMinimalProfileFixture()
    const planner = profile.planner as Record<string, unknown>
    planner.defaultPersonaByLane = {
      "app-core": "missing-persona"
    }

    expect(() => validateProjectProfile(profile)).toThrow(
      "planner.defaultPersonaByLane.app-core references unknown manager persona missing-persona"
    )
  })

  it("rejects profile persona overrides that reference unknown lanes", () => {
    const profile = loadMinimalProfileFixture()
    profile.personas = [
      {
        id: "minimal-runtime-engineer",
        extends: "backend-engineer",
        name: "Minimal Runtime Engineer",
        role: "Backend Engineer",
        allowedLanes: ["ghost-lane"],
        requiredReading: ["README.md"],
        verificationRules: ["Run tests."]
      }
    ]

    expect(() => validateProjectProfile(profile)).toThrow("personas[0].allowedLanes references unknown lane ghost-lane")
  })
})
