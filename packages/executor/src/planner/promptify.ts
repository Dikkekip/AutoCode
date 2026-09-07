import type { PlannerCandidateTask, RepoPlanningSnapshot } from "@openclaw/domain"

type PersonaPromptContext = {
  id: string
  focus: string
  ideationPrompt?: string | null | undefined
  successSignals?: string[] | undefined
  ownedLaneIds: string[]
}

export type PromptIdeationResult = {
  personaName: string
  candidates: PlannerCandidateTask[]
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort((left, right) =>
    left.localeCompare(right)
  )
}

function isSlowBroadVerification(command: string): boolean {
  return /(?:playwright\s+test|npm\s+run\s+(?:test:critical|build|ui:audit)|npm\s+test\s+--\s+__contracts__|make\s+test-(?:openapi|contracts-backend)|pytest\s+tests\/?(?:\s|$))/i.test(
    command
  )
}

function candidateNeedsBroadVerification(candidate: PlannerCandidateTask, command: string): boolean {
  const scope = [
    candidate.title,
    candidate.description,
    candidate.lane,
    ...candidate.tags,
    ...(candidate.targetPaths ?? []),
    ...candidate.sourceSignals
  ]
    .join(" ")
    .toLowerCase()
  if (/playwright\s+test/i.test(command)) return /(?:playwright|e2e|browser|navigation|visual)/.test(scope)
  if (/test-(?:openapi|contracts-backend)|__contracts__/i.test(command))
    return /(?:contract|openapi|schema|api)/.test(scope)
  if (/npm\s+run\s+build/i.test(command))
    return /(?:build|vite|typescript|tsconfig|package\.json|dependency)/.test(scope)
  return false
}

function candidateNeedsUiCompile(candidate: PlannerCandidateTask): boolean {
  const scope = [
    candidate.title,
    candidate.description,
    candidate.lane,
    ...candidate.tags,
    ...(candidate.targetPaths ?? []),
    ...candidate.requiredReading,
    ...candidate.sourceSignals
  ]
    .join(" ")
    .toLowerCase()
  return /(?:frontend|(?:^|[-_/])ui(?:$|[-_/])|\.tsx?\b)/.test(scope)
}

function verificationPlan(candidate: PlannerCandidateTask, fallback: string | null): string[] {
  const proposed = uniqueSorted(
    candidate.verificationChecklist.length > 0 ? candidate.verificationChecklist : fallback ? [fallback] : []
  )
  const focused = proposed.filter((command) => !isSlowBroadVerification(command)).slice(0, 3)
  const justifiedBroad = proposed.find(
    (command) => isSlowBroadVerification(command) && candidateNeedsBroadVerification(candidate, command)
  )
  const requiredUiCompile = candidateNeedsUiCompile(candidate)
    ? proposed.find((command) => /npm\s+run\s+build/i.test(command))
    : null
  if (requiredUiCompile) {
    return Array.from(new Set([requiredUiCompile, ...focused])).slice(0, 3)
  }
  if (focused.length > 0) return focused
  return justifiedBroad ? [justifiedBroad] : proposed.slice(0, 1)
}

function ideatedDescription(candidate: PlannerCandidateTask): string {
  return candidate.description.trim()
}

function implementationPrompt(
  candidate: PlannerCandidateTask,
  persona: PersonaPromptContext | null,
  promptEngineer: string
): string {
  const personaId = persona?.id ?? candidate.personaId ?? "lane owner"
  const focus = persona?.focus?.trim() || candidate.userOutcome?.trim() || `Deliver the ${candidate.lane} outcome.`
  const personaDirective = persona?.ideationPrompt?.trim()
  const successSignals = uniqueSorted(persona?.successSignals ?? [])
  const targetPaths = uniqueSorted(candidate.targetPaths ?? [])
  const plannerApproach = candidate.implementationPrompt?.trim()
  const highRisk = candidate.riskLevel === "high" || candidate.governanceClass !== "normal"

  return [
    "# Persona execution contract",
    "",
    `Prompt engineer: ${promptEngineer}`,
    `Execution persona: ${personaId}`,
    `Owned lane: ${candidate.lane}`,
    `Persona mission: ${focus}`,
    personaDirective ? `Persona research directive: ${personaDirective}` : null,
    "",
    "## Persona ideation synthesis",
    `- Domain advocate: validate that the slice improves the ${personaId} workflow and preserves legal/user meaning.`,
    "- Skeptical maintainer: challenge hidden coupling, duplicated state, concurrency races, backwards compatibility, and scope creep before editing.",
    "- Verification architect: map each acceptance criterion to the narrowest deterministic test and identify any pre-existing baseline failure separately.",
    ...(highRisk
      ? [
          "- Safety reviewer: test permission boundaries, provenance, auditability, reversibility, and failure recovery explicitly."
        ]
      : []),
    "",
    "## Implementation boundaries",
    `- Keep the change inside ${candidate.lane} and preserve unrelated user or agent edits.`,
    ...(targetPaths.length > 0 ? targetPaths.map((item) => `- Target: ${item}`) : []),
    `- Risk: ${candidate.riskLevel}; governance: ${candidate.governanceClass}.`,
    "- Build one coherent vertical slice; tests, contracts, and docs are evidence for the behavior, not substitutes for it.",
    plannerApproach ? `- Planner-proposed approach: ${plannerApproach}` : null,
    "",
    "## Invariants and non-goals",
    "- Preserve public contracts and existing behavior outside the stated user outcome unless an acceptance criterion explicitly changes them.",
    "- Do not turn the slice into a repo-wide cleanup, dependency upgrade, or unrelated baseline repair.",
    "- Keep state transitions idempotent and recovery-safe; retries must not duplicate legal records, notifications, or artifacts.",
    "",
    ...(successSignals.length > 0
      ? ["", "## Persona success signals", ...successSignals.map((item) => `- ${item}`)]
      : []),
    "",
    "## Verification stance",
    "- Map each acceptance criterion to the narrowest deterministic test.",
    "- Run focused tests first. Treat broad suites, builds, browser tests, and contract sweeps as required only when the changed surface justifies them.",
    "- If a broad check fails outside the changed surface, capture it as baseline evidence; do not silently absorb unrelated repairs into this task.",
    "",
    "## Completion protocol",
    "- Continue through implementation and targeted verification unless a concrete external blocker prevents progress.",
    "- Record exact verification evidence and remaining risk in the handoff.",
    "- Do not leave generated dependency directories, temporary artifacts, or an inactive clean worktree behind after completion."
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n")
}

export function ideatePlannerCandidatePrompts(input: {
  candidates: PlannerCandidateTask[]
  snapshot: RepoPlanningSnapshot
  promptEngineerPersonaName?: string | null
  personas?: PersonaPromptContext[] | undefined
}): PromptIdeationResult {
  const promptEngineer = input.promptEngineerPersonaName?.trim() || "prompt-engineer"
  const fallbackVerification = input.snapshot.verificationCommands[0] ?? null

  const candidates = input.candidates.map((candidate) => {
    const laneInventory = input.snapshot.laneInventory?.find((lane) => lane.laneId === candidate.lane)
    const verificationChecklist = verificationPlan(candidate, fallbackVerification)
    const requiredReading = uniqueSorted([
      ...candidate.requiredReading,
      ...input.snapshot.directives.slice(0, 2),
      ...(laneInventory?.publicFacades ?? []),
      ...(candidate.lane
        ? (input.snapshot.laneHotspots.find((lane) => lane.laneId === candidate.lane)?.files.slice(0, 3) ?? [])
        : [])
    ])
    const contractUpdateReminders = uniqueSorted([
      ...candidate.contractUpdateReminders,
      ...(candidate.lane.includes("contract") || candidate.tags.some((tag) => /contract|api|openapi/i.test(tag))
        ? ["Update API/contract fixtures when behavior changes."]
        : [])
    ])
    const repoSearchSignal =
      requiredReading.length > 0
        ? `repo-search:required-reading:${requiredReading.slice(0, 3).join("|")}`
        : `repo-search:lane:${candidate.lane}`
    const persona =
      input.personas?.find((entry) => entry.id === candidate.personaId) ??
      input.personas?.find((entry) => entry.ownedLaneIds.includes(candidate.lane)) ??
      null

    const enrichedCandidate = {
      ...candidate,
      requiredReading,
      verificationChecklist,
      contractUpdateReminders
    }

    return {
      ...enrichedCandidate,
      description: ideatedDescription(enrichedCandidate),
      implementationPrompt: implementationPrompt(enrichedCandidate, persona, promptEngineer),
      requiredReading,
      verificationChecklist,
      contractUpdateReminders,
      repoNotes: uniqueSorted([
        ...candidate.repoNotes,
        "Persona must ground this feature slice in repo-search evidence from required reading, lane hotspots, or source signals.",
        ...(laneInventory?.publicFacades?.length
          ? [`Lane public facades: ${laneInventory.publicFacades.join(", ")}`]
          : []),
        `Prompt ideated by ${promptEngineer}: clarified intent, scope, acceptance criteria, and verification.`
      ]),
      sourceSignals: uniqueSorted([
        ...candidate.sourceSignals,
        repoSearchSignal,
        `prompt-ideation:persona:${promptEngineer}`,
        `prompt-ideation:intent:${candidate.kind}`,
        `prompt-ideation:lane:${candidate.lane}`,
        `promptify:persona:${promptEngineer}`,
        `promptify:intent:${candidate.kind}`,
        `promptify:lane:${candidate.lane}`
      ]),
      tags: uniqueSorted([...candidate.tags, "prompt-ideated", "promptified"])
    }
  })

  return {
    personaName: promptEngineer,
    candidates
  }
}

export function promptifyPlannerCandidates(input: {
  candidates: PlannerCandidateTask[]
  snapshot: RepoPlanningSnapshot
  promptEngineerPersonaName?: string | null
}): PlannerCandidateTask[] {
  return ideatePlannerCandidatePrompts(input).candidates
}
