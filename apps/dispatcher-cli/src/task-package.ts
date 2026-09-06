import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import {
  type AdapterType,
  applyOpenClawTaskRecipe,
  buildContextHintBundle,
  type HandoffArtifact,
  type OpenClawTaskRecipe,
  parseContextFileNames,
  type TaskLane,
  type TaskPackage
} from "@openclaw/domain"

import type { RepoContext } from "./repo-context.js"

type BuildTaskPackageInput = {
  title: string
  description?: string | null
  labels: string[]
  changedFiles: string[]
  requestedAdapterType?: AdapterType | null
  assignedAgentAdapterType?: AdapterType | null
  repoContext: RepoContext
  repoPath?: string | null
  verifyCommand?: string | null
}

type LaneInference = {
  lane: TaskLane
  score: number
  reasons: string[]
}

type SupportedLane = "backend" | "ui" | "api-contracts" | "general"

const UI_HINTS = [
  "ui",
  "ux",
  "frontend",
  "front-end",
  "design",
  "visual",
  "copy",
  "css",
  "tailwind",
  "tsx",
  "component",
  "layout"
]

const BACKEND_HINTS = [
  "backend",
  "server",
  "service",
  "endpoint",
  "handler",
  "database",
  "migration",
  "python",
  "pytest"
]

const API_HINTS = ["api", "openapi", "contract", "schema", "swagger", "__contracts__"]

function uniq(values: string[]): string[] {
  return Array.from(new Set(values))
}

function normalize(value: string): string {
  return value.trim().toLowerCase()
}

function hintsFrom(input: BuildTaskPackageInput): string[] {
  return [input.title, input.description ?? "", ...input.labels, ...input.changedFiles].map(normalize).filter(Boolean)
}

function matchesAny(hints: string[], patterns: string[]): string[] {
  const normalizedPatterns = patterns.map(normalize).filter(Boolean)
  return normalizedPatterns.filter((pattern) => hints.some((hint) => hint.includes(pattern)))
}

function filesUnder(changedFiles: string[], roots: string[]): string[] {
  return changedFiles.filter((file) => roots.some((root) => file.startsWith(root)))
}

function inferLane(input: BuildTaskPackageInput): LaneInference {
  const hints = hintsFrom(input)
  const uiMatches = matchesAny(hints, UI_HINTS)
  const backendMatches = matchesAny(hints, BACKEND_HINTS)
  const apiMatches = matchesAny(hints, API_HINTS)
  const uiFiles = filesUnder(input.changedFiles, input.repoContext.uiRoots)
  const backendFiles = filesUnder(input.changedFiles, input.repoContext.backendRoots)
  const contractFiles = filesUnder(input.changedFiles, input.repoContext.contractPaths)

  const candidates: LaneInference[] = [
    { lane: "backend", score: 0, reasons: [] },
    { lane: "ui", score: 0, reasons: [] },
    { lane: "api-contracts", score: 0, reasons: [] },
    { lane: "general", score: 0, reasons: [] }
  ]

  const byLane: Record<SupportedLane, LaneInference> = {
    backend: candidates[0]!,
    ui: candidates[1]!,
    "api-contracts": candidates[2]!,
    general: candidates[3]!
  }

  if (input.requestedAdapterType === "gemini_local" || input.assignedAgentAdapterType === "gemini_local") {
    byLane.ui.score += 4
    byLane.ui.reasons.push("adapter choice points at the UI lane")
  }

  if (input.requestedAdapterType === "azure_foundry" || input.assignedAgentAdapterType === "azure_foundry") {
    byLane.general.score += 4
    byLane.general.reasons.push("adapter choice points at dispatcher/persona analysis")
  }

  if (input.requestedAdapterType === "codex_local" || input.assignedAgentAdapterType === "codex_local") {
    byLane.backend.score += 2
    byLane.backend.reasons.push("adapter choice points at the backend lane")
  }

  if (uiMatches.length > 0) {
    byLane.ui.score += 3
    byLane.ui.reasons.push(`matched UI hints: ${uiMatches.join(", ")}`)
  }

  if (backendMatches.length > 0) {
    byLane.backend.score += 3
    byLane.backend.reasons.push(`matched backend hints: ${backendMatches.join(", ")}`)
  }

  if (apiMatches.length > 0) {
    byLane["api-contracts"].score += 4
    byLane["api-contracts"].reasons.push(`matched API/contract hints: ${apiMatches.join(", ")}`)
    byLane.backend.score += 1
  }

  if (uiFiles.length > 0) {
    byLane.ui.score += 4
    byLane.ui.reasons.push(`changed files fall under UI ownership: ${uiFiles.join(", ")}`)
  }

  if (backendFiles.length > 0) {
    byLane.backend.score += 4
    byLane.backend.reasons.push(`changed files fall under backend ownership: ${backendFiles.join(", ")}`)
  }

  if (contractFiles.length > 0) {
    byLane["api-contracts"].score += 5
    byLane["api-contracts"].reasons.push(`changed files touch API contracts: ${contractFiles.join(", ")}`)
  }

  if (input.changedFiles.some((file) => file.endsWith(".tsx") || file.endsWith(".css"))) {
    byLane.ui.score += 2
    byLane.ui.reasons.push("frontend file extensions were provided")
  }

  if (input.changedFiles.some((file) => file.endsWith(".py"))) {
    byLane.backend.score += 2
    byLane.backend.reasons.push("backend file extensions were provided")
  }

  byLane.general.score = 1
  byLane.general.reasons.push("no strong lane-specific signal was found")

  const ordered = [...candidates].sort((left, right) => right.score - left.score)
  return ordered[0] ?? byLane.general
}

function contractReminders(input: BuildTaskPackageInput, lane: TaskLane): string[] {
  const hints = hintsFrom(input)
  const touchesContracts =
    lane === "backend" ||
    lane === "api-contracts" ||
    matchesAny(hints, API_HINTS).length > 0 ||
    filesUnder(input.changedFiles, input.repoContext.contractPaths).length > 0

  if (!touchesContracts) {
    return []
  }

  const reminders: string[] = [
    "If request or response shapes changed, update the canonical API contract before closing the task.",
    "Refresh contract-focused tests and any dependent client fixtures together with the backend change."
  ]

  if (input.repoContext.contractPaths.length > 0) {
    reminders.unshift(`Check whether ${input.repoContext.contractPaths.join(", ")} needs to change.`)
  }

  return reminders
}

export function verificationCommandsFromDescription(description: string | null | undefined): string[] {
  if (!description) return []
  const match = description.match(/verification\s*:\s*([^\n]+)/i)
  if (!match?.[1]) return []
  return match[1]
    .split(/\s+(?:and|&&)\s+|;\s*/)
    .map((entry) => entry.trim().replace(/[.。]\s*$/, ""))
    .filter((entry) => /^(git|pytest|pnpm|npm|make|uv|ruff|cd)\b/.test(entry))
}

function readJsonFile<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T
  } catch {
    return null
  }
}

function recipeFiles(repoPath: string): string[] {
  const recipesDir = join(repoPath, ".openclaw", "recipes")
  try {
    return readdirSync(recipesDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => join(recipesDir, entry.name))
      .sort()
  } catch {
    return []
  }
}

function recipeLooksValid(value: unknown): value is OpenClawTaskRecipe {
  if (!value || typeof value !== "object") return false
  const record = value as Record<string, unknown>
  return typeof record.id === "string" && typeof record.title === "string" && typeof record.description === "string"
}

function loadMatchingRecipes(input: BuildTaskPackageInput, taskPackage: TaskPackage): OpenClawTaskRecipe[] {
  if (!input.repoPath) return []
  const labelMatches = new Set(input.labels.map((label) => normalize(label).replace(/^recipe:/, "")))
  const title = normalize(input.title)
  return recipeFiles(input.repoPath)
    .map((path) => readJsonFile<unknown>(path))
    .filter(recipeLooksValid)
    .filter((recipe) => {
      const id = normalize(recipe.id)
      return (
        labelMatches.has(id) ||
        title.includes(id) ||
        recipe.lane === taskPackage.likelyOwnershipLane ||
        input.labels.includes(`recipe:${recipe.id}`)
      )
    })
}

function contextHintDocuments(input: BuildTaskPackageInput): Array<{ source: "local"; path: string; content: string }> {
  if (!input.repoPath) return []
  const fileNames = parseContextFileNames(process.env.CONTEXT_FILE_NAMES)
  const dirs = new Set(["."])
  for (const file of input.changedFiles) {
    let current = dirname(file)
    while (current && current !== "." && current !== "/") {
      dirs.add(current)
      const next = dirname(current)
      if (next === current) break
      current = next
    }
  }

  const documents: Array<{ source: "local"; path: string; content: string }> = []
  for (const dir of Array.from(dirs).sort((left, right) => left.length - right.length || left.localeCompare(right))) {
    for (const name of fileNames) {
      const relativePath = dir === "." ? name : `${dir}/${name}`
      const absolutePath = join(input.repoPath, relativePath)
      if (!existsSync(absolutePath)) continue
      documents.push({
        source: "local",
        path: relativePath,
        content: readFileSync(absolutePath, "utf8")
      })
    }
  }
  return documents
}

function enrichWithRepoOwnedContext(input: BuildTaskPackageInput, taskPackage: TaskPackage): TaskPackage {
  let enriched = taskPackage

  for (const recipe of loadMatchingRecipes(input, enriched)) {
    enriched = applyOpenClawTaskRecipe({
      taskPackage: enriched,
      recipe,
      values: {
        title: input.title,
        description: input.description ?? "",
        lane: enriched.likelyOwnershipLane
      }
    })
  }

  const hintDocs = contextHintDocuments(input)
  if (hintDocs.length === 0) return enriched
  const bundle = buildContextHintBundle(hintDocs)
  return {
    ...enriched,
    requiredReading: uniq([...enriched.requiredReading, ...bundle.entries.map((entry) => entry.path)]),
    repoNotes: uniq([
      ...enriched.repoNotes,
      `Context hints loaded from ${bundle.entries.map((entry) => entry.path).join(", ")}.`,
      ...(bundle.immediateReferencePaths.length > 0
        ? [`Immediate context references: ${bundle.immediateReferencePaths.join(", ")}`]
        : []),
      ...(bundle.optionalReferencePaths.length > 0
        ? [`Optional context references: ${bundle.optionalReferencePaths.join(", ")}`]
        : [])
    ]),
    extraInstructions: uniq([...(enriched.extraInstructions ?? []), "Respect repo-owned context hints before editing."])
  }
}

export function buildTaskPackage(input: BuildTaskPackageInput): TaskPackage {
  const lane = inferLane(input)
  const requiredReading = uniq([
    ...input.repoContext.sharedReads,
    ...(lane.lane === "ui" ? input.repoContext.geminiReads : input.repoContext.codexReads)
  ])
  const laneVerification =
    lane.lane === "ui"
      ? input.repoContext.geminiVerify
      : lane.lane === "backend" || lane.lane === "api-contracts"
        ? input.repoContext.codexVerify
        : []
  const explicitVerification = verificationCommandsFromDescription(input.description)
  const verificationChecklist = uniq([
    ...(explicitVerification.length > 0
      ? explicitVerification
      : [...laneVerification, ...(laneVerification.length === 0 && input.verifyCommand ? [input.verifyCommand] : [])])
  ])

  return enrichWithRepoOwnedContext(input, {
    version: 1,
    generatedAt: new Date().toISOString(),
    repoProfile: input.repoContext.profileName,
    likelyOwnershipLane: lane.lane,
    laneReason: lane.reasons[0] ?? "defaulted to a general task package",
    inferenceSignals: uniq(lane.reasons),
    requiredReading,
    verificationChecklist,
    contractUpdateReminders: contractReminders(input, lane.lane),
    repoNotes: input.repoContext.repoNotes
  })
}

function addSection(lines: string[], title: string, items: string[]): void {
  if (items.length === 0) {
    return
  }

  lines.push("", `${title}:`)
  for (const item of items) {
    lines.push(`- ${item}`)
  }
}

export function renderTaskPackage(taskPackage: TaskPackage): string[] {
  const lines = [
    `repo profile: ${taskPackage.repoProfile}`,
    `likely ownership lane: ${taskPackage.likelyOwnershipLane}`,
    `lane reason: ${taskPackage.laneReason}`,
    `persona: ${taskPackage.personaProvenance?.personaId ?? "unassigned"}`,
    `portfolio bucket: ${taskPackage.portfolioBucket ?? "n/a"}`,
    `task source intent: ${taskPackage.taskSourceIntent ?? "n/a"}`,
    `user outcome: ${taskPackage.userOutcome ?? "n/a"}`
  ]

  addSection(lines, "Inference signals", taskPackage.inferenceSignals)
  addSection(lines, "Required reading", taskPackage.requiredReading)
  addSection(lines, "Verification checklist", taskPackage.verificationChecklist)
  addSection(lines, "Acceptance criteria", taskPackage.acceptanceCriteria ?? [])
  addSection(lines, "Contract update reminders", taskPackage.contractUpdateReminders)
  addSection(lines, "Repo notes", taskPackage.repoNotes)

  return lines
}

export function taskPackageFromHandoff(
  handoff: HandoffArtifact,
  basePackage: TaskPackage,
  options: { sourceTaskId?: string | null } = {}
): TaskPackage {
  return {
    ...basePackage,
    requiredReading: uniq([...basePackage.requiredReading, ...handoff.requiredFiles]),
    verificationChecklist: uniq([...basePackage.verificationChecklist, ...handoff.allowedScope.commands]),
    repoNotes: uniq([
      ...basePackage.repoNotes,
      `Handoff ${handoff.id}: ${handoff.sourcePersona} -> ${handoff.targetPersona}`,
      `Verification ${handoff.verificationStatus.status}: ${handoff.verificationStatus.summary}`
    ]),
    extraInstructions: uniq([
      ...(basePackage.extraInstructions ?? []),
      `Context summary: ${handoff.contextSummary}`,
      ...handoff.completedWork.map((item) => `Completed work: ${item}`),
      ...handoff.openQuestions.map((item) => `Open question: ${item}`),
      ...handoff.risks.map((item) => `Risk: ${item}`),
      `Next recommended action: ${handoff.nextRecommendedAction}`,
      `Allowed scope: ${handoff.allowedScope.summary}`,
      ...handoff.allowedScope.constraints.map((item) => `Scope constraint: ${item}`)
    ]),
    taskLineage: {
      taskId: options.sourceTaskId ?? handoff.sourceTaskId ?? handoff.id
    }
  }
}
