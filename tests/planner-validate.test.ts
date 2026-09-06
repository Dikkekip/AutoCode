import type { PlannerCandidateTask } from "@openclaw/domain"
import { describe, expect, it } from "vitest"

import {
  filterPlannerCandidatesForFeaturePolicy,
  validatePlannerCandidates
} from "../packages/executor/src/planner/validate.js"
import { loadProjectProfile } from "../packages/project-profiles/src/index.js"

describe("validatePlannerCandidates", () => {
  const featureCandidate = (patch: Partial<PlannerCandidateTask> = {}): PlannerCandidateTask => ({
    title: "Add route shell offline banner with retry affordance",
    description: "Show users a recoverable route-level network failure state instead of leaving stale route content.",
    kind: "implement",
    lane: "ui-shell-system",
    personaId: "frontend-shell-owner",
    portfolioBucket: "frontend_product_ux",
    userOutcome: "Legal reviewers can retry a failed route load without losing context.",
    acceptanceCriteria: ["The shell renders an accessible offline banner with a retry action."],
    taskSourceIntent: "persona_ideation",
    preferredAdapterType: "codex_local",
    priority: 70,
    requiredReading: ["apps/reports-ui/src/components/ui/Alert.tsx"],
    verificationChecklist: ["cd apps/reports-ui && npm run test:critical"],
    contractUpdateReminders: [],
    repoNotes: ["laneInventory lists shell navigation and Alert components."],
    dependencies: [],
    tags: ["planner-generated"],
    riskLevel: "medium",
    governanceClass: "normal",
    dedupeKey: "ui-shell-system:offline-banner",
    sourceSignals: ["laneInventory:ui-shell-system:apps/reports-ui/src/components/ui/Alert.tsx"],
    estimatedCost: 1,
    createMode: "queue_now",
    ...patch
  })

  it("keeps repo-evidenced vertical feature slices", () => {
    const result = filterPlannerCandidatesForFeaturePolicy([featureCandidate()])

    expect(result.accepted).toHaveLength(1)
    expect(result.rejected).toHaveLength(0)
  })

  it("accepts acyclic same-lane candidate dependency graphs", () => {
    const candidates = validatePlannerCandidates({
      profile: loadProjectProfile("lawyerrag"),
      candidates: [
        featureCandidate({ dedupeKey: "shell:foundation" }),
        featureCandidate({
          title: "Add route retry telemetry",
          dedupeKey: "shell:telemetry",
          dependencies: ["shell:foundation"]
        })
      ]
    })

    expect(candidates[1]?.dependencies).toEqual(["shell:foundation"])
  })

  it("rejects unknown, cyclic, and policy-forbidden cross-lane dependencies", () => {
    const profile = loadProjectProfile("lawyerrag")

    expect(() =>
      validatePlannerCandidates({
        profile,
        candidates: [featureCandidate({ dependencies: ["missing"] })]
      })
    ).toThrow("unknown dependency: missing")

    expect(() =>
      validatePlannerCandidates({
        profile,
        candidates: [
          featureCandidate({ dedupeKey: "shell:a", dependencies: ["shell:b"] }),
          featureCandidate({ dedupeKey: "shell:b", dependencies: ["shell:a"] })
        ]
      })
    ).toThrow("contains a cycle")

    expect(() =>
      validatePlannerCandidates({
        profile,
        candidates: [
          featureCandidate({ dedupeKey: "shell:foundation" }),
          featureCandidate({
            lane: "ui-primary-routes",
            dedupeKey: "routes:consumer",
            dependencies: ["shell:foundation"]
          })
        ]
      })
    ).toThrow("cross-lane dependencies are disabled")
  })

  it("rejects test-only and witness-only planner candidates", () => {
    const result = filterPlannerCandidatesForFeaturePolicy([
      featureCandidate({
        title: "Add incident date precision unit tests",
        description: "Add tests for incident date precision.",
        acceptanceCriteria: ["Unit tests cover unknown dates."],
        dedupeKey: "backend-incidents-and-timeline:date-tests"
      }),
      featureCandidate({
        title: "Add contract witness for API client nested query object rejection",
        description: "Create a contract witness for query encoding.",
        acceptanceCriteria: ["Contract tests cover nested objects."],
        dedupeKey: "ui-contracts-and-api:query-witness"
      })
    ])

    expect(result.accepted).toHaveLength(0)
    expect(result.rejected.map((entry) => entry.reason)).toEqual([
      "candidate looks like test-only or witness-only work",
      "candidate looks like test-only or witness-only work"
    ])
  })

  it("rejects cosmetic patchlets and candidates without repo evidence", () => {
    const result = filterPlannerCandidatesForFeaturePolicy([
      featureCandidate({
        title: "Add matter-context helper text to bundle export actions",
        description: "Add helper text near export actions.",
        dedupeKey: "ui-primary-routes:helper-text"
      }),
      featureCandidate({
        title: "Add bundle source coverage summary",
        requiredReading: [],
        sourceSignals: [],
        repoNotes: [],
        dedupeKey: "ui-primary-routes:no-evidence"
      })
    ])

    expect(result.accepted).toHaveLength(0)
    expect(result.rejected.map((entry) => entry.reason)).toEqual([
      "candidate looks like a cosmetic patchlet instead of a vertical feature slice",
      "candidate does not cite repo-search evidence"
    ])
  })

  it("rejects dependents when feature policy rejects their prerequisite", () => {
    const result = filterPlannerCandidatesForFeaturePolicy([
      featureCandidate({
        title: "Add route retry unit tests",
        dedupeKey: "shell:tests"
      }),
      featureCandidate({
        title: "Add route retry telemetry",
        dedupeKey: "shell:telemetry",
        dependencies: ["shell:tests"]
      }),
      featureCandidate({
        title: "Add independent offline recovery action",
        dedupeKey: "shell:recovery"
      })
    ])

    expect(result.accepted.map((candidate) => candidate.dedupeKey)).toEqual(["shell:recovery"])
    expect(result.rejected.map((entry) => entry.reason)).toEqual([
      "candidate looks like test-only or witness-only work",
      "candidate depends on rejected prerequisite shell:tests"
    ])
  })

  it("accepts Azure Foundry as a planner-selected adapter", () => {
    const [candidate] = validatePlannerCandidates({
      profile: loadProjectProfile("lawyerrag"),
      candidates: [
        {
          title: "Plan backend reliability work",
          description: "Use Kimi on Foundry for a text-first planning pass.",
          kind: "plan",
          lane: "backend-ingestion-and-aiops",
          personaId: "backend-engineer",
          portfolioBucket: "backend_api",
          userOutcome: "Backend reliability work is scoped from persona evidence.",
          acceptanceCriteria: ["Planner emits a bounded backend task."],
          taskSourceIntent: "persona_ideation",
          preferredAdapterType: "azure_foundry",
          priority: 90,
          requiredReading: ["docs/openclaw/autonomous-improvement-loop.md"],
          verificationChecklist: [],
          contractUpdateReminders: [],
          repoNotes: [],
          dependencies: [],
          tags: ["planner-generated"],
          riskLevel: "medium",
          governanceClass: "normal",
          dedupeKey: "foundry-planning-pass",
          sourceSignals: ["manager-persona:pm-backend-reliability"],
          estimatedCost: 1,
          createMode: "queue_now"
        }
      ]
    })

    expect(candidate?.preferredAdapterType).toBe("azure_foundry")
    expect(candidate?.personaId).toBe("backend-engineer")
    expect(candidate?.portfolioBucket).toBe("backend_api")
  })

  it("defaults missing persona provenance from lane policy", () => {
    const [candidate] = validatePlannerCandidates({
      profile: loadProjectProfile("lawyerrag"),
      candidates: [
        {
          title: "Improve Vedlegg empty state",
          description: "Make the Vedlegg workspace easier to understand when no evidence exists.",
          kind: "implement",
          lane: "ui-workspaces-and-viewer",
          personaId: null,
          preferredAdapterType: null,
          priority: 70,
          requiredReading: ["apps/reports-ui/src"],
          verificationChecklist: ["pnpm test -- vedlegg"],
          contractUpdateReminders: [],
          repoNotes: [],
          dependencies: [],
          tags: ["planner-generated"],
          riskLevel: "medium",
          governanceClass: "normal",
          dedupeKey: "vedlegg-empty-state",
          sourceSignals: ["persona-ideation:vedlegg"],
          estimatedCost: 1,
          createMode: "queue_now"
        }
      ]
    })

    expect(candidate?.personaId).toBe("vedlegg-workspace-owner")
    expect(candidate?.portfolioBucket).toBe("frontend_product_ux")
    expect(candidate?.taskSourceIntent).toBe("persona_ideation")
  })

  it("keeps persona portfolio authoritative when planner emits a conflicting bucket", () => {
    const [candidate] = validatePlannerCandidates({
      profile: loadProjectProfile("lawyerrag"),
      candidates: [
        {
          title: "Add date precision labels to incident chronology",
          description: "Expose legal chronology certainty without implying exact dates.",
          kind: "implement",
          lane: "backend-incidents-and-timeline",
          personaId: "lawyer-legal-strategy",
          portfolioBucket: "backend_api",
          userOutcome: "Legal reviewers can distinguish exact, month-only, year-only, and unknown dates.",
          acceptanceCriteria: ["Contract output includes precision labels."],
          taskSourceIntent: "persona_ideation",
          preferredAdapterType: null,
          priority: 80,
          requiredReading: ["apps/backend"],
          verificationChecklist: ["make test-openapi"],
          contractUpdateReminders: [],
          repoNotes: [],
          dependencies: [],
          tags: ["planner-generated"],
          riskLevel: "medium",
          governanceClass: "normal",
          dedupeKey: "date-precision-labels",
          sourceSignals: ["persona-ideation:lawyer"],
          estimatedCost: 1,
          createMode: "queue_now"
        }
      ]
    })

    expect(candidate?.portfolioBucket).toBe("legal_domain")
  })
})
