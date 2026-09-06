import type { PlannerCandidateTask, RepoPlanningSnapshot } from "@openclaw/domain"
import { describe, expect, it } from "vitest"

import { ideatePlannerCandidatePrompts } from "../packages/executor/src/planner/promptify.js"

describe("planner promptification", () => {
  it("keeps the UI compile gate with focused evidence and removes other unjustified broad gates", () => {
    const candidate = {
      title: "Keep a reviewer on the selected source",
      description: "Preserve the selected source while a bundle refreshes.",
      kind: "implement",
      lane: "ui-primary-routes",
      personaId: "frontend-engineer",
      portfolioBucket: "frontend_ux",
      userOutcome: "Reviewers do not lose their place.",
      acceptanceCriteria: ["The selected source remains active after a refresh."],
      taskSourceIntent: "persona_ideation",
      preferredAdapterType: "codex_local",
      priority: 70,
      requiredReading: ["apps/reports-ui/src/features/bundles/BundleDetail.tsx"],
      verificationChecklist: [
        "cd apps/reports-ui && npm test -- src/features/bundles/BundleDetail.test.tsx",
        "cd apps/reports-ui && npm run test:critical",
        "cd apps/reports-ui && npm run build",
        "cd apps/reports-ui && npx playwright test --project=chromium e2e/navigation.spec.ts",
        "make test-contracts-backend"
      ],
      contractUpdateReminders: [],
      repoNotes: [],
      dependencies: [],
      tags: ["planner-generated"],
      riskLevel: "medium",
      governanceClass: "normal",
      dedupeKey: "ui-primary-routes:preserve-source",
      sourceSignals: ["changed:apps/reports-ui/src/features/bundles/BundleDetail.tsx"],
      estimatedCost: 1,
      createMode: "queue_now"
    } as PlannerCandidateTask
    const snapshot = {
      verificationCommands: ["pnpm test"],
      directives: [],
      laneHotspots: []
    } as unknown as RepoPlanningSnapshot

    const result = ideatePlannerCandidatePrompts({
      candidates: [candidate],
      snapshot,
      promptEngineerPersonaName: "prompt-engineer"
    }).candidates[0]!

    expect(result.verificationChecklist).toEqual([
      "cd apps/reports-ui && npm run build",
      "cd apps/reports-ui && npm test -- src/features/bundles/BundleDetail.test.tsx"
    ])
    expect(result.implementationPrompt).toContain("## Persona ideation synthesis")
    expect(result.implementationPrompt).toContain("Skeptical maintainer")
    expect(result.implementationPrompt).toContain("## Verification stance")
    expect(result.implementationPrompt).not.toContain("## Acceptance contract")
    expect(result.implementationPrompt).not.toContain("## Read before editing")
    expect(result.description).toBe(candidate.description)
  })

  it("keeps focused API evidence out of unrelated full contract sweeps", () => {
    const candidate = {
      title: "Expose unreadable ingestion pages",
      description: "Add a bounded API field for unreadable document pages.",
      kind: "implement",
      lane: "backend-api",
      personaId: "backend-engineer",
      portfolioBucket: "backend_reliability",
      userOutcome: "Reviewers can locate pages that need attention.",
      acceptanceCriteria: ["Unreadable pages are returned in the ingestion status response."],
      taskSourceIntent: "persona_ideation",
      preferredAdapterType: "codex_local",
      priority: 80,
      requiredReading: ["apps/backend/lawyer_rag/ingestion_app/handlers/document.py"],
      verificationChecklist: [
        "cd apps/backend && uv run pytest lawyer_rag/tests/test_ingestion_handlers.py -q",
        "cd apps/backend && uv run ruff check lawyer_rag/ingestion_app/handlers/document.py",
        "make test-contracts-backend && make test-openapi"
      ],
      contractUpdateReminders: ["Update the ingestion OpenAPI schema."],
      repoNotes: [],
      dependencies: [],
      tags: ["api", "openapi"],
      riskLevel: "medium",
      governanceClass: "normal",
      dedupeKey: "backend-api:unreadable-pages",
      sourceSignals: ["changed:contracts/openapi.yaml"],
      estimatedCost: 2,
      createMode: "queue_now"
    } as PlannerCandidateTask
    const snapshot = {
      verificationCommands: ["make test-contracts-backend"],
      directives: [],
      laneHotspots: []
    } as unknown as RepoPlanningSnapshot

    const result = ideatePlannerCandidatePrompts({
      candidates: [candidate],
      snapshot,
      promptEngineerPersonaName: "prompt-engineer"
    }).candidates[0]!

    expect(result.verificationChecklist).toEqual([
      "cd apps/backend && uv run pytest lawyer_rag/tests/test_ingestion_handlers.py -q",
      "cd apps/backend && uv run ruff check lawyer_rag/ingestion_app/handlers/document.py"
    ])
  })
})
