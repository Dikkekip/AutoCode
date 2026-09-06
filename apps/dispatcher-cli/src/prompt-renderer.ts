import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { Persona, Project, Task, TaskPackage } from "@openclaw/domain"
import {
  bestProfileMatch,
  type LaneDefinition,
  loadProjectProfile,
  type ProjectProfile,
  type VerificationRule,
  validateProjectProfile
} from "@openclaw/project-profiles"

export type PromptTemplateId =
  | "implementation"
  | "review"
  | "repair"
  | "refactor"
  | "test-generation"
  | "documentation"
  | "architecture-analysis"
  | "security-review"

export type PromptPersonaInput = {
  id: string
  name: string
  stage?: string | null
  ownedLanes?: string[]
  instructionsPath?: string | null
  instructions?: string | null
}

export type RenderPromptInput = {
  title: string
  description?: string | null
  labels?: string[]
  changedFiles?: string[]
  taskPackage?: TaskPackage | null
  taskId?: string | null
  taskKind?: string | null
  laneId?: string | null
  project: Project
  persona: PromptPersonaInput
  profile: ProjectProfile | null
  template?: PromptTemplateId | null | undefined
}

type TemplateRule = {
  missionLead: string
  styleRules: string[]
  steps: string[]
  expectedArtifacts: string[]
  done: string[]
}

const TEMPLATE_RULES: Record<PromptTemplateId, TemplateRule> = {
  implementation: {
    missionLead: "Implement the requested change end to end inside the repository.",
    styleRules: [
      "Deliver a complete, production-ready vertical slice for the assigned feature.",
      "Verify behavior before summarizing completion.",
      "Do not return only a plan, task package, or implementation brief; make the repository edits unless a concrete blocker prevents coding.",
      "Treat this prompt and its Current Task Package section as authoritative; ignore stale repository planning files such as task_plan.md, plan.md, or specs/*/tasks.md unless they are explicitly listed as relevant files for this task."
    ],
    steps: [
      "Read the repository context, task package, and relevant files before editing.",
      "Identify the coherent implementation path that completes the assigned feature without unrelated expansion.",
      "Make focused code and test changes within scope.",
      "Run every verification command listed below.",
      "Report changed artifacts and any residual risk."
    ],
    expectedArtifacts: [
      "Committed repository changes in the execution worktree",
      "Focused tests or updated existing tests",
      "Verification output summary"
    ],
    done: [
      "Requested behavior is implemented in code.",
      "At least one in-scope repository file changed for implement/repair work.",
      "Verification commands have been run or explicitly reported blocked."
    ]
  },
  review: {
    missionLead: "Review the change for correctness, regressions, and missing verification.",
    styleRules: [
      "Lead with findings ordered by severity.",
      "Avoid broad rewrite suggestions unless they block correctness."
    ],
    steps: [
      "Inspect the task package, changed files, and relevant context.",
      "Check behavioral correctness, scope control, tests, and rollout risk.",
      "Run or inspect the verification commands where feasible.",
      "Return findings with file and line references when applicable."
    ],
    expectedArtifacts: ["Review findings", "Verification evidence", "Open questions or approval decision"],
    done: ["All material risks found during review are reported.", "Verification commands are covered."]
  },
  repair: {
    missionLead: "Repair the failing or blocked task with the smallest reliable change.",
    styleRules: ["Treat prior failure evidence as authoritative.", "Fix root causes before symptoms."],
    steps: [
      "Reproduce or inspect the reported failure.",
      "Trace the failure to the smallest owned component.",
      "Patch the root cause within strict scope.",
      "Run the verification commands and any focused regression check.",
      "Report the failure cause and fix."
    ],
    expectedArtifacts: ["Repair patch", "Regression test or focused verification", "Failure cause summary"],
    done: [
      "The reported failure no longer reproduces.",
      "Verification commands have been run or blocked reasons are explicit."
    ]
  },
  refactor: {
    missionLead: "Refactor the target area without changing user-visible behavior.",
    styleRules: ["Preserve public contracts.", "Keep mechanical cleanup separate from behavior changes."],
    steps: [
      "Map current behavior and dependencies before editing.",
      "Define the behavior-preserving refactor boundary.",
      "Apply the refactor in focused commits or file groups.",
      "Run verification commands plus any contract checks.",
      "Document behavior-preservation evidence."
    ],
    expectedArtifacts: ["Refactored code", "Updated tests only where needed", "Behavior-preservation notes"],
    done: ["Behavior is preserved.", "Verification commands and relevant contract checks pass or are reported blocked."]
  },
  "test-generation": {
    missionLead: "Add meaningful tests for the requested behavior or risk area.",
    styleRules: ["Test observable behavior over implementation details.", "Keep fixtures deterministic."],
    steps: [
      "Identify the behavior, edge cases, and existing test patterns.",
      "Add focused tests using existing helpers and conventions.",
      "Avoid unrelated implementation changes unless required to make tests pass.",
      "Run the verification commands and the focused test target.",
      "Report coverage added and remaining gaps."
    ],
    expectedArtifacts: ["New or updated tests", "Minimal supporting fixtures", "Verification summary"],
    done: [
      "Tests fail for the relevant bug or gap before the fix when applicable.",
      "Verification commands are covered."
    ]
  },
  documentation: {
    missionLead: "Document the requested behavior, workflow, or architecture accurately.",
    styleRules: ["Prefer concrete instructions over marketing copy.", "Keep docs aligned with runnable commands."],
    steps: [
      "Read the source files or workflows being documented.",
      "Update the smallest relevant documentation surface.",
      "Include accurate commands, paths, and constraints.",
      "Run verification commands or doc-specific checks.",
      "Report docs changed and any assumptions."
    ],
    expectedArtifacts: ["Documentation update", "Command or workflow examples", "Verification summary"],
    done: ["Documentation matches the current repository behavior.", "Verification commands are covered."]
  },
  "architecture-analysis": {
    missionLead: "Analyze the architecture and produce actionable findings without making broad changes.",
    styleRules: [
      "Separate observed facts from recommendations.",
      "Prioritize boundary, coupling, and lifecycle risks."
    ],
    steps: [
      "Read the repository context, profile rules, and relevant modules.",
      "Map key components, data flow, and ownership boundaries.",
      "Identify risks, tradeoffs, and options.",
      "Run verification or inspection commands that support the analysis.",
      "Return concise recommendations with affected files."
    ],
    expectedArtifacts: ["Architecture findings", "Recommended next steps", "Verification or inspection evidence"],
    done: ["Findings are grounded in repository files.", "Verification commands are covered."]
  },
  "security-review": {
    missionLead: "Review the task area for security, privacy, and abuse risks.",
    styleRules: [
      "Prioritize exploitable issues over generic hardening.",
      "Call out data exposure and auth boundary risks."
    ],
    steps: [
      "Identify trust boundaries, inputs, outputs, and secrets handling.",
      "Inspect relevant files for concrete security issues.",
      "Run verification commands and security-focused checks where available.",
      "Report findings by severity with evidence.",
      "Recommend scoped mitigations."
    ],
    expectedArtifacts: ["Security findings", "Mitigation recommendations", "Verification evidence"],
    done: ["Concrete risks are reported or explicitly ruled out.", "Verification commands are covered."]
  }
}

const PERSONA_RULES: Record<string, string[]> = {
  "prompt-engineer": [
    "Optimize the prompt for precise Codex execution, not broad brainstorming.",
    "Make constraints, artifacts, and blocked reporting unambiguous."
  ],
  reviewer: ["Use a code-review stance and lead with defects.", "Require file/line evidence for concrete findings."],
  "security-reviewer": [
    "Think in terms of trust boundaries, data exposure, injection, authorization, and secret handling.",
    "Avoid generic security advice without repository evidence."
  ],
  architect: [
    "Preserve architectural boundaries and identify coupling before proposing changes.",
    "Distinguish short-term tactical fixes from structural recommendations."
  ],
  "repair-specialist": [
    "Start from the observed failure and work backward to the root cause.",
    "Keep fixes narrow and prove the regression path."
  ],
  "test-engineer": [
    "Use existing test utilities and deterministic fixtures.",
    "Prefer behavior-level assertions over fragile implementation assertions."
  ],
  "docs-writer": ["Write task-focused documentation.", "Keep examples and commands executable."]
}

function uniqueSorted(values: readonly string[] | undefined): string[] {
  return Array.from(new Set((values ?? []).map((value) => value.trim()).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b)
  )
}

function sentenceList(values: readonly string[]): string[] {
  return values.length > 0 ? values.map((value) => `- ${value}`) : ["- none"]
}

function taskPackageLines(taskPackage: TaskPackage | null): string[] {
  if (!taskPackage) return ["- none"]

  const lines = [
    `- Repo profile: ${taskPackage.repoProfile}`,
    `- Likely ownership lane: ${taskPackage.likelyOwnershipLane}`,
    `- Lane reason: ${taskPackage.laneReason}`,
    `- Persona: ${taskPackage.personaProvenance?.personaId ?? "unassigned"}`,
    `- Portfolio bucket: ${taskPackage.portfolioBucket ?? "n/a"}`,
    `- Task source intent: ${taskPackage.taskSourceIntent ?? "n/a"}`,
    `- User outcome: ${taskPackage.userOutcome ?? "n/a"}`
  ]

  const addSection = (title: string, values: readonly string[] | undefined) => {
    const normalized = uniqueSorted(values)
    if (normalized.length === 0) return
    lines.push(`- ${title}:`)
    lines.push(...normalized.map((value) => `  - ${value}`))
  }

  addSection("Inference signals", taskPackage.inferenceSignals)
  addSection("Acceptance criteria", taskPackage.acceptanceCriteria)
  addSection("Repo notes", taskPackage.repoNotes)
  addSection("Extra instructions", taskPackage.extraInstructions)

  return lines
}

function normalizePersonaKey(persona: PromptPersonaInput): string {
  return [persona.id, persona.name, persona.stage ?? ""].join(" ").toLowerCase()
}

function rulesForPersona(persona: PromptPersonaInput): string[] {
  const normalized = normalizePersonaKey(persona)
  const matched = Object.entries(PERSONA_RULES)
    .filter(([key]) => normalized.includes(key))
    .flatMap(([, rules]) => rules)

  const stageRules =
    persona.stage === "reviewer"
      ? (PERSONA_RULES.reviewer ?? [])
      : persona.stage === "planner"
        ? (PERSONA_RULES.architect ?? [])
        : persona.stage === "promoter"
          ? ["Check promotion readiness and do not skip review or CI gates."]
          : ["Act as a hands-on Codex engineer responsible for completing the task."]

  return uniqueSorted([...stageRules, ...matched])
}

function inferTemplate(input: RenderPromptInput): PromptTemplateId {
  if (input.template) return input.template
  if (input.taskKind === "repair" || input.taskKind === "fix_review_feedback") return "repair"
  if (input.taskKind === "implement") return "implementation"
  if (input.taskKind === "review") return "review"
  const text = [input.taskKind, input.title, ...(input.labels ?? [])].join(" ").toLowerCase()
  if (text.includes("security")) return "security-review"
  if (text.includes("architecture") || text.includes("architect")) return "architecture-analysis"
  if (text.includes("document") || text.includes("docs")) return "documentation"
  if (text.includes("test")) return "test-generation"
  if (text.includes("refactor")) return "refactor"
  if (text.includes("repair") || text.includes("fix_review_feedback") || text.includes("fix")) return "repair"
  if (text.includes("review")) return "review"
  return "implementation"
}

function laneDefinition(profile: ProjectProfile | null, laneId: string | null): LaneDefinition | null {
  if (!profile || !laneId) return null
  return profile.laneDefinitions.find((lane) => lane.laneId === laneId) ?? null
}

function verificationRule(profile: ProjectProfile | null, lane: LaneDefinition | null): VerificationRule | null {
  if (!profile || !lane) return null
  return profile.verificationRules.find((rule) => rule.ruleId === lane.verificationRuleId) ?? null
}

function readPersonaInstructions(persona: PromptPersonaInput): string | null {
  if (persona.instructions !== undefined) return persona.instructions
  if (!persona.instructionsPath || !existsSync(persona.instructionsPath)) return null
  return readFileSync(persona.instructionsPath, "utf8").trim()
}

function profileRules(profile: ProjectProfile | null, lane: LaneDefinition | null): string[] {
  if (!profile) return []
  return uniqueSorted([
    ...profile.adoptionPolicy.operatorDirective,
    ...(profile.extraInstructions ?? []),
    ...(lane?.extraInstructions ?? []),
    `Promotion mode: ${profile.promotionPolicy.mode}; merge method: ${profile.promotionPolicy.mergeMethod}; require CI: ${profile.promotionPolicy.requireCi}.`,
    `Artifact root: ${profile.artifactPolicy.artifactRootDir}; audit log: ${profile.artifactPolicy.auditLogPath}.`
  ])
}

function frameworkOutOfScope(profile: ProjectProfile): string[] {
  return Object.values(profile.framework).flatMap((bucket) => {
    if (!bucket || typeof bucket !== "object" || !("outOfScope" in bucket) || !Array.isArray(bucket.outOfScope)) {
      return []
    }
    return bucket.outOfScope
  })
}

function strictScope(
  profile: ProjectProfile | null,
  lane: LaneDefinition | null,
  taskPackage: TaskPackage | null
): string[] {
  const outOfScopeRules = profile ? frameworkOutOfScope(profile) : []

  return uniqueSorted([
    ...(lane ? [`Stay inside lane ${lane.laneId} (${lane.displayName}).`] : []),
    ...(lane?.allowedPaths ?? []).map((path) => `Allowed path pattern: ${path}`),
    ...(taskPackage?.contractUpdateReminders ?? []),
    ...outOfScopeRules.map((item) => `Out of scope: ${item}`)
  ])
}

function verificationCommands(input: RenderPromptInput, lane: LaneDefinition | null): string[] {
  const rule = verificationRule(input.profile, lane)
  return uniqueSorted([
    ...(input.taskPackage?.verificationChecklist ?? []),
    ...(rule?.commands ?? []),
    ...(input.project.verifyCommand ? [input.project.verifyCommand] : []),
    "pnpm test"
  ])
}

function relevantFiles(input: RenderPromptInput, lane: LaneDefinition | null): string[] {
  return uniqueSorted([
    ...(input.changedFiles ?? []),
    ...(input.taskPackage?.requiredReading ?? []),
    ...(lane?.allowedPaths ?? [])
  ])
}

function repositoryContext(input: RenderPromptInput, lane: LaneDefinition | null): string[] {
  return [
    `- Project: ${input.project.name}`,
    `- Repository path: ${input.project.repoPath}`,
    `- Project profile: ${input.profile ? `${input.profile.displayName} (${input.profile.profileId})` : "not configured"}`,
    `- Task lane: ${input.laneId ?? input.taskPackage?.likelyOwnershipLane ?? lane?.laneId ?? "general"}`,
    `- Lane reason: ${input.taskPackage?.laneReason ?? "not provided"}`,
    `- Labels: ${uniqueSorted(input.labels).join(", ") || "none"}`
  ]
}

function section(title: string, lines: string[]): string {
  return [`## ${title}`, ...lines].join("\n")
}

export function renderCodexPrompt(input: RenderPromptInput): string {
  const templateId = inferTemplate(input)
  const template = TEMPLATE_RULES[templateId]
  const laneId = input.laneId ?? input.taskPackage?.likelyOwnershipLane ?? null
  const lane = laneDefinition(input.profile, laneId)
  const personaRules = rulesForPersona(input.persona)
  const instructions = readPersonaInstructions(input.persona)
  const commands = verificationCommands(input, lane)

  const lines = [
    "# Codex Task Prompt",
    "",
    section("1. Persona Identity", [
      `You are ${input.persona.name} (${input.persona.id}).`,
      `Persona stage: ${input.persona.stage ?? "unspecified"}.`,
      `Owned lanes: ${uniqueSorted(input.persona.ownedLanes).join(", ") || "none"}.`,
      "",
      "Persona rules:",
      ...sentenceList(personaRules),
      ...(instructions ? ["", "Persona instructions:", instructions] : [])
    ]),
    "",
    section("2. Mission", [
      template.missionLead,
      "",
      `Task: ${input.title}`,
      ...(input.taskId ? [`Task id: ${input.taskId}`] : []),
      ...(input.description ? ["", input.description] : []),
      "",
      `Prompt template: ${templateId}.`
    ]),
    "",
    section("3. Repository Context", repositoryContext(input, lane)),
    "",
    section("Current Task Package", taskPackageLines(input.taskPackage ?? null)),
    "",
    section("4. Relevant Files", sentenceList(relevantFiles(input, lane))),
    "",
    section("5. Strict Scope Boundaries", sentenceList(strictScope(input.profile, lane, input.taskPackage ?? null))),
    "",
    section("6. Implementation Steps", sentenceList(template.steps)),
    "",
    section(
      "7. Verification Commands",
      commands.map((command) => `- \`${command}\``)
    ),
    "",
    section("8. Expected Artifacts", sentenceList(template.expectedArtifacts)),
    "",
    section("9. Definition Of Done", sentenceList(template.done)),
    "",
    section("10. Failure Or Blocked Reporting Format", [
      "If blocked, return exactly this shape:",
      "",
      "```text",
      "STATUS: blocked",
      "BLOCKER: <one sentence>",
      "ATTEMPTED: <commands or files inspected>",
      "NEEDED: <specific input, access, or decision required>",
      "NEXT_SAFE_STEP: <what should happen next without guessing>",
      "```"
    ]),
    "",
    section("Project Profile Rules", sentenceList(profileRules(input.profile, lane))),
    "",
    section("Task Lane Style", [
      ...sentenceList([
        `Lane ${laneId ?? "general"} should use ${lane?.preferredAdapterType ?? "the assigned adapter"} style.`,
        ...template.styleRules
      ])
    ])
  ]

  return `${lines.join("\n")}\n`
}

export function promptPersonaFromPersona(persona: Persona): PromptPersonaInput {
  return {
    id: persona.id,
    name: persona.name,
    stage: persona.stage,
    ownedLanes: persona.ownedLanes,
    instructionsPath: persona.instructionsPath
  }
}

export function promptInputFromTask(input: {
  task: Task
  project: Project
  persona: PromptPersonaInput
  profile: ProjectProfile | null
  template?: PromptTemplateId | null | undefined
}): RenderPromptInput {
  return {
    title: input.task.title,
    description: input.task.description,
    labels: input.task.labels,
    changedFiles: input.task.changedFiles,
    taskPackage: input.task.taskPackage,
    taskId: input.task.id,
    taskKind: input.task.kind,
    laneId: input.task.laneId,
    project: input.project,
    persona: input.persona,
    profile: input.profile,
    template: input.template
  }
}

export function loadPromptProjectProfile(project: Project, profileId?: string | null): ProjectProfile | null {
  if (profileId) return loadProjectProfile(profileId)

  const repoLocalProfilePath = join(project.repoPath, ".openclaw", "profile.json")
  if (existsSync(repoLocalProfilePath)) {
    return validateProjectProfile(JSON.parse(readFileSync(repoLocalProfilePath, "utf8")) as unknown)
  }

  const match = bestProfileMatch(project.repoPath)
  return match ? loadProjectProfile(match.profileId) : null
}
