import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import type {
  OrchestraRunManifest,
  PlanSubtask,
  PromotionReadyState,
  ReviewerHandoff,
  TaskPackage,
  WorktreeLineage
} from "@openclaw/domain"

export type OrchestraStage = "promptify" | "plan" | "execute" | "review" | "promote"

export interface OrchestraExecutionContext {
  taskId: string
  lane: string
  userPrompt: string
  outputDir: string
  taskPackage: TaskPackage | null
  subagentCount: number
  lineage: WorktreeLineage | null
  maxParallelSubtasks: number
}

export interface OrchestraRunResult {
  outputDir: string
  promptify: PromptifyContract
  plan: PlanContract
  manifest: OrchestraRunManifest
  reviewerHandoff: ReviewerHandoff
}

export interface PromptifyContract {
  normalizedPrompt: string
  intent: string
  scope: string[]
  constraints: string[]
  assumptions: string[]
  acceptanceCriteria: string[]
  risks: string[]
  paths: string[]
  slug: string
}

export interface PlanContract {
  summary: string
  implementationPlan: string[]
  subtasks: PlanSubtask[]
  integrationNotes: string[]
  finalValidation: string[]
  branchHint: string
}

/**
 * Ported from codex_orchestra.py
 */
export function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .split("-")
      .slice(0, 10)
      .join("-") || "codex-orchestra"
  )
}

export function buildPromptifyPrompt(userPrompt: string): string {
  const contract = {
    normalized_prompt: "string",
    intent: "string",
    scope: ["string"],
    constraints: ["string"],
    assumptions: ["string"],
    acceptance_criteria: ["string"],
    risks: ["string"],
    paths: ["string"],
    slug: "kebab-case-string"
  }

  return `
You are the promptify stage for a codex orchestra pipeline.

Rewrite and structure the user request into machine-readable planning input.

USER_REQUEST:
${userPrompt}

Output only one JSON object with this exact contract:
${JSON.stringify(contract, null, 2)}

Rules:
- Return raw JSON, no markdown.
- Keep keys exactly as shown.
- 'slug' must be lowercase kebab-case.
- Do not include explanatory text.
`.trim()
}

export function buildPlanPrompt(promptifyPayload: PromptifyContract, subagents: number): string {
  const contract = {
    summary: "string",
    implementation_plan: ["string"],
    subtasks: [
      {
        id: "A1",
        label: "string",
        goal: "string",
        prompt: "string",
        files: ["string"],
        depends_on: ["string"],
        deliverables: ["string"],
        validation: ["string"]
      }
    ],
    integration_notes: ["string"],
    final_validation: ["string"],
    branch_hint: "string"
  }

  const condensedInput = {
    normalized_prompt: promptifyPayload.normalizedPrompt,
    intent: promptifyPayload.intent,
    scope: promptifyPayload.scope,
    constraints: promptifyPayload.constraints,
    acceptance_criteria: promptifyPayload.acceptanceCriteria,
    paths: promptifyPayload.paths,
    slug: promptifyPayload.slug
  }

  return `
You are the planning stage for a codex orchestra pipeline.

Create an execution plan with exactly ${subagents} subtasks suitable for codex subagents.
Subtasks should be as independent as possible.

PROMPTIFIED_INPUT:
${JSON.stringify(condensedInput, null, 2)}

Return one JSON object with this contract:
${JSON.stringify(contract, null, 2)}

Rules:
- Return raw JSON only.
- 'subtasks' must contain exactly ${subagents} entries.
- Each subtask must include a complete standalone 'prompt'.
- 'depends_on' references subtask ids like A1, A2.
- Keep 'files' focused on paths relevant to this repository.
`.trim()
}

export function parseJsonFromMixedText(text: string): any {
  const stripped = text.trim()
  if (!stripped) throw new Error("Empty assistant output")

  // Try parsing pure JSON
  try {
    return JSON.parse(stripped)
  } catch {
    // Try finding JSON in fence blocks
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
    if (match?.[1]) {
      try {
        return JSON.parse(match[1].trim())
      } catch {
        // Fall through
      }
    }

    // Try finding the first { and the last }
    const start = text.indexOf("{")
    const end = text.lastIndexOf("}")
    if (start !== -1 && end !== -1 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1))
      } catch {
        // Fall through
      }
    }
  }

  throw new Error("Could not locate a valid JSON object in output")
}

export function generateRunManifest(params: {
  taskId: string
  lane: string
  branch?: string | null
  lineage: WorktreeLineage | null
  plan: PlanContract
  taskPackage?: TaskPackage | null
}): OrchestraRunManifest {
  const testsRun =
    params.plan.finalValidation.length > 0
      ? params.plan.finalValidation
      : (params.taskPackage?.verificationChecklist ?? [])

  return {
    taskId: params.taskId,
    lane: params.lane,
    branch: params.branch ?? params.plan.branchHint,
    lineage: params.lineage,
    subtasks: params.plan.subtasks,
    filesTouched: Array.from(new Set(params.plan.subtasks.flatMap((s) => s.files))),
    testsRun,
    status: "planned",
    risks: params.plan.integrationNotes,
    nextActions: ["Execute subtasks", "Review evidence"],
    promotionReadyState: {
      status: "awaiting_reviewer_decision",
      verdict: null,
      evidencePaths: [],
      ...(params.taskPackage?.contractUpdateReminders?.length
        ? { releaseFlow: params.taskPackage.contractUpdateReminders.join(", ") }
        : {})
    }
  }
}

export function generateReviewerHandoff(params: {
  taskId: string
  lane: string
  manifest: OrchestraRunManifest
  plan: PlanContract
}): ReviewerHandoff {
  return {
    taskId: params.taskId,
    tasksIncluded: [params.taskId],
    lane: params.lane,
    branch: params.manifest.branch,
    prTitle: `Codex: ${params.plan.summary}`,
    prBody: `## Implementation Plan
${params.plan.implementationPlan.map((s) => `- ${s}`).join("\n")}

## Integration Notes
${params.plan.integrationNotes.map((s) => `- ${s}`).join("\n")}
`,
    reviewEvidence: "See run-manifest.json for detailed subtask execution ledger.",
    knownGlobalBlockers: [],
    status: "needs_review",
    promotionReadyState: params.manifest.promotionReadyState!
  }
}

export function buildIntegrationPrompt(params: {
  userPrompt: string
  promptify: PromptifyContract
  plan: PlanContract
  manifest: OrchestraRunManifest
}): string {
  const sections = [
    `# Integration Directive: ${params.manifest.taskId}`,
    "",
    `Goal: ${params.promptify.normalizedPrompt}`,
    `Lane: ${params.manifest.lane}`,
    `Branch hint: ${params.manifest.branch}`,
    "",
    "## Implementation Plan",
    ...params.plan.implementationPlan.map((s) => `- ${s}`),
    "",
    "## Subtasks",
    ...params.plan.subtasks.map(
      (s) => `### ${s.id}: ${s.label}\nGoal: ${s.goal}\nFiles: ${s.files.join(", ")}\nPrompt: ${s.prompt}\n`
    ),
    "",
    "## Acceptance Criteria",
    ...params.promptify.acceptanceCriteria.map((s) => `- ${s}`),
    "",
    "## Final Validation",
    ...params.plan.finalValidation.map((s) => `- ${s}`)
  ]

  return sections.join("\n")
}

export function buildRunbook(params: {
  promptify: PromptifyContract
  plan: PlanContract
  manifest: OrchestraRunManifest
  handoff: ReviewerHandoff
}): string {
  return [
    `# Codex Orchestra Runbook: ${params.manifest.taskId}`,
    "",
    `Lane: ${params.manifest.lane}`,
    `Branch: ${params.manifest.branch}`,
    `Status: ${params.manifest.status}`,
    "",
    "## Goal",
    params.promptify.normalizedPrompt,
    "",
    "## Subtasks",
    ...params.plan.subtasks.map((subtask) => `- ${subtask.id}: ${subtask.label} (${subtask.goal})`),
    "",
    "## Validation",
    ...(params.manifest.testsRun.length > 0
      ? params.manifest.testsRun.map((item) => `- ${item}`)
      : ["- No validation commands were planned."]),
    "",
    "## Reviewer Handoff",
    `- PR title: ${params.handoff.prTitle}`,
    `- Evidence: ${params.handoff.reviewEvidence}`
  ].join("\n")
}

export interface OrchestraAdapter {
  execute: (stage: OrchestraStage, prompt: string) => Promise<{ response: string; ok: boolean; error?: string }>
}

export class OrchestraRunner {
  constructor(
    private readonly adapter: OrchestraAdapter,
    private readonly context: OrchestraExecutionContext
  ) {}

  async run(): Promise<OrchestraRunResult> {
    const { outputDir, taskId, lane, userPrompt, taskPackage, subagentCount, lineage } = this.context
    mkdirSync(outputDir, { recursive: true })

    // 1. Promptify
    const promptifyPrompt = buildPromptifyPrompt(userPrompt)
    const promptifyRaw = await this.adapter.execute("promptify", promptifyPrompt)
    if (!promptifyRaw.ok) throw new Error(`Promptify failed: ${promptifyRaw.error}`)
    const promptify = parseJsonFromMixedText(promptifyRaw.response) as PromptifyContract
    writeFileSync(join(outputDir, "promptify.json"), JSON.stringify(promptify, null, 2), "utf8")

    // 2. Plan
    const planPrompt = buildPlanPrompt(promptify, subagentCount)
    const planRaw = await this.adapter.execute("plan", planPrompt)
    if (!planRaw.ok) throw new Error(`Planning failed: ${planRaw.error}`)
    const plan = parseJsonFromMixedText(planRaw.response) as PlanContract
    writeFileSync(join(outputDir, "plan.json"), JSON.stringify(plan, null, 2), "utf8")

    // 3. Manifest & Handoff
    const manifest = generateRunManifest({
      taskId,
      lane,
      lineage,
      plan,
      taskPackage
    })
    const handoff = generateReviewerHandoff({
      taskId,
      lane,
      manifest,
      plan
    })
    writeFileSync(join(outputDir, "run-manifest.json"), JSON.stringify(manifest, null, 2), "utf8")
    writeFileSync(join(outputDir, "reviewer-handoff.json"), JSON.stringify(handoff, null, 2), "utf8")
    writeFileSync(join(outputDir, "runbook.md"), buildRunbook({ promptify, plan, manifest, handoff }), "utf8")

    // 4. Integration Prompt
    const integrationPrompt = buildIntegrationPrompt({
      userPrompt,
      promptify,
      plan,
      manifest
    })
    writeFileSync(join(outputDir, "integration_prompt.md"), integrationPrompt, "utf8")

    return {
      outputDir,
      promptify,
      plan,
      manifest,
      reviewerHandoff: handoff
    }
  }

  async runSubtasks(plan: PlanContract): Promise<Record<string, { ok: boolean; response: string }>> {
    const results: Record<string, { ok: boolean; response: string }> = {}
    const completed = new Set<string>()
    const inProgress = new Set<string>()

    const remaining = [...plan.subtasks]

    while (completed.size < plan.subtasks.length) {
      const ready = remaining.filter((s) => {
        if (completed.has(s.id) || inProgress.has(s.id)) return false
        return s.dependsOn.every((dep) => completed.has(dep))
      })

      if (ready.length === 0 && inProgress.size === 0) {
        throw new Error("Deadlock in subtask dependency graph")
      }

      const toRun = ready.slice(0, this.context.maxParallelSubtasks - inProgress.size)

      const promises = toRun.map(async (s) => {
        inProgress.add(s.id)
        try {
          const result = await this.adapter.execute("execute", s.prompt)
          results[s.id] = result
          if (result.ok) {
            completed.add(s.id)
          } else {
            throw new Error(`Subtask ${s.id} failed: ${result.error}`)
          }
        } finally {
          inProgress.delete(s.id)
        }
      })

      await Promise.race([
        ...promises,
        new Promise((resolve) => setTimeout(resolve, 100)) // Fallback to avoid tight loop
      ])
    }

    return results
  }
}

export function scaffoldCodexOrchestra(params: {
  prompt: string
  taskId: string
  lane: string
  outputDir: string
  taskPackage: TaskPackage | null
  subagents: number
}): OrchestraRunResult {
  mkdirSync(params.outputDir, { recursive: true })

  const promptify: PromptifyContract = {
    normalizedPrompt: params.prompt,
    intent: "Manual scaffold",
    scope: [],
    constraints: [],
    assumptions: [],
    acceptanceCriteria: [],
    risks: [],
    paths: [],
    slug: slugify(params.prompt)
  }

  const plan: PlanContract = {
    summary: params.prompt,
    implementationPlan: [],
    subtasks: Array.from({ length: params.subagents }).map((_, i) => ({
      id: `A${i + 1}`,
      label: `Subtask ${i + 1}`,
      goal: "TBD",
      prompt: "TBD",
      files: [],
      dependsOn: [],
      deliverables: [],
      validation: []
    })),
    integrationNotes: [],
    finalValidation: [],
    branchHint: `orch-${promptify.slug}`
  }

  const manifest = generateRunManifest({
    taskId: params.taskId,
    lane: params.lane,
    plan,
    taskPackage: params.taskPackage,
    lineage: null
  })

  const handoff = generateReviewerHandoff({
    taskId: params.taskId,
    lane: params.lane,
    manifest,
    plan
  })

  writeFileSync(join(params.outputDir, "promptify.json"), JSON.stringify(promptify, null, 2), "utf8")
  writeFileSync(join(params.outputDir, "plan.json"), JSON.stringify(plan, null, 2), "utf8")
  writeFileSync(join(params.outputDir, "run-manifest.json"), JSON.stringify(manifest, null, 2), "utf8")
  writeFileSync(join(params.outputDir, "reviewer-handoff.json"), JSON.stringify(handoff, null, 2), "utf8")
  writeFileSync(join(params.outputDir, "runbook.md"), buildRunbook({ promptify, plan, manifest, handoff }), "utf8")

  return {
    outputDir: params.outputDir,
    promptify,
    plan,
    manifest,
    reviewerHandoff: handoff
  }
}
