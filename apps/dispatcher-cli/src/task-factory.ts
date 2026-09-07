import { existsSync, readFileSync } from "node:fs"
import { basename, join } from "node:path"
import type { DispatcherStore } from "@openclaw/db"
import {
  type AdapterType,
  type Project,
  type Task,
  type TaskKind,
  type TaskPackage,
  topologicalDependencyOrder,
  validateDependencyGraph
} from "@openclaw/domain"
import type {
  LaneDefinition,
  ManagerPersonaDefinition,
  ProjectProfile,
  VerificationRule
} from "@openclaw/project-profiles"

export type GeneratedRiskLevel = "low" | "medium" | "high"
export type ExpectedChangeSize = "small" | "medium" | "large"

export interface DispatchableTaskPackage extends TaskPackage {
  title: string
  problemStatement: string
  lane: string
  recommendedPersona: string | null
  adapterPreference: AdapterType | null
  relevantFiles: string[]
  outOfScopeFiles: string[]
  acceptanceCriteria: string[]
  verificationCommands: string[]
  riskLevel: GeneratedRiskLevel
  dependencies: string[]
  expectedChangeSize: ExpectedChangeSize
  rollbackGuidance: string
  dedupeKey: string
}

export interface TaskFactoryResult {
  packages: DispatchableTaskPackage[]
  decisions: Array<{
    title: string
    dedupeKey: string
    action: "create" | "skip_duplicate"
    reason: string
    existingTaskId?: string
    createdTaskId?: string
  }>
}

type GoalSection = {
  heading: string
  items: string[]
}

type ParsedGoalItem = {
  text: string
  dependencySelectors: string[]
}

function uniq(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)))
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90)
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

function readGoal(goal?: string, goalFile?: string): string {
  if (goalFile) return readFileSync(goalFile, "utf8").trim()
  if (goal?.trim()) return goal.trim()
  return "Review the repository snapshot and create small, dispatchable follow-up coding tasks."
}

function splitGoalSections(goal: string): GoalSection[] {
  const sections: GoalSection[] = []
  let current: GoalSection = { heading: "Goal", items: [] }

  for (const rawLine of goal.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const heading = /^([A-Za-z][A-Za-z ]+):\s*$/.exec(line)
    if (heading) {
      if (current.items.length > 0) sections.push(current)
      current = { heading: heading[1] ?? "Goal", items: [] }
      continue
    }

    const item = line.replace(/^[-*]\s+/, "").trim()
    current.items.push(item)
  }

  if (current.items.length > 0) sections.push(current)
  return sections
}

function goalItems(goal: string): string[] {
  const sections = splitGoalSections(goal)
  const acceptance = sections.find((section) => normalize(section.heading) === "acceptance criteria")
  const cli = sections.find((section) => normalize(section.heading) === "cli")
  const explicit = uniq([...(cli?.items ?? []), ...(acceptance?.items ?? [])])
  if (explicit.length >= 2) return explicit

  const firstSectionItems = sections[0]?.items ?? [goal]
  const split = firstSectionItems.flatMap((item) =>
    item
      .split(/(?:\.\s+|;\s+|\s+and\s+)/i)
      .map((part) => part.trim())
      .filter((part) => part.length > 12)
  )
  return uniq(split).slice(0, 6)
}

function parseGoalItem(raw: string): ParsedGoalItem {
  const dependencySelectors: string[] = []
  const text = raw
    .replace(/\[\s*(?:depends[- ]on|after)\s*:\s*([^\]]+)\]/gi, (_match, selectors: string) => {
      dependencySelectors.push(
        ...selectors
          .split(",")
          .map((selector) => selector.trim())
          .filter(Boolean)
      )
      return ""
    })
    .replace(/\s{2,}/g, " ")
    .trim()

  if (!text) throw new Error(`Task factory goal item contains only a dependency directive: ${raw}`)
  return { text, dependencySelectors }
}

function resolveGoalItemDependencies(input: {
  item: ParsedGoalItem
  itemIndex: number
  packages: DispatchableTaskPackage[]
}): string[] {
  return uniq(
    input.item.dependencySelectors.map((selector) => {
      const numeric = /^#?(\d+)$/.exec(selector)
      if (numeric) {
        const dependencyIndex = Number.parseInt(numeric[1]!, 10) - 1
        const dependency = input.packages[dependencyIndex]
        if (!dependency) {
          throw new Error(`Task factory item ${input.itemIndex + 1} references missing dependency item ${selector}.`)
        }
        if (dependencyIndex === input.itemIndex) {
          throw new Error(`Task factory item ${input.itemIndex + 1} cannot depend on itself.`)
        }
        return dependency.dedupeKey
      }

      const normalizedSelector = normalize(selector)
      const matches = input.packages.filter((taskPackage, index) => {
        if (index === input.itemIndex) return false
        return [taskPackage.title, taskPackage.problemStatement, taskPackage.dedupeKey].some(
          (value) => normalize(value) === normalizedSelector
        )
      })
      if (matches.length !== 1) {
        throw new Error(
          `Task factory item ${input.itemIndex + 1} dependency selector "${selector}" matched ${matches.length} tasks.`
        )
      }
      return matches[0]!.dedupeKey
    })
  )
}

function inferRisk(text: string): GeneratedRiskLevel {
  const value = normalize(text)
  if (
    /\b(auth|security|permission|migration|schema|database|delete|payment|secret|credential|destructive)\b/.test(value)
  ) {
    return "high"
  }
  if (/\b(cli|persist|dependency|queue|adapter|validation|contract|api|runtime|executor)\b/.test(value)) {
    return "medium"
  }
  return "low"
}

function expectedSize(itemCount: number, risk: GeneratedRiskLevel): ExpectedChangeSize {
  if (risk === "high" || itemCount > 4) return "large"
  if (risk === "medium" || itemCount > 2) return "medium"
  return "small"
}

type PersonaPick = {
  id: string
  preferredAdapterType: AdapterType
  portfolioBucket: DispatchableTaskPackage["portfolioBucket"]
  ownedLaneIds: string[]
  score: number
}

function laneScore(lane: LaneDefinition, text: string, repoFiles: string[]): number {
  const haystack = normalize([text, lane.displayName, ...(lane.categoryHints ?? [])].join(" "))
  let score = 0
  for (const hint of lane.categoryHints ?? []) {
    if (haystack.includes(normalize(hint))) score += 3
  }
  if (haystack.includes(normalize(lane.laneId))) score += 4
  if (haystack.includes("ui") || haystack.includes("frontend")) {
    if (/ui|front|react|component|ux/i.test(lane.displayName)) score += 4
  }
  if (haystack.includes("cli") || haystack.includes("command")) {
    if (/runtime|backend|api|general|cli|tool/i.test(lane.displayName)) score += 3
  }
  if (haystack.includes("schema") || haystack.includes("validation")) {
    if (/api|contract|backend|runtime|general/i.test(lane.displayName)) score += 3
  }
  if (/\b(timeline|chronology|chronological|incident|evidence|event)\b/.test(haystack)) {
    if (/timeline|incident/i.test(`${lane.laneId} ${lane.displayName}`)) score += 7
    if (/primary routes/i.test(lane.displayName)) score += 3
  }
  if (/\b(vedlegg|attachment|document|pdf|casefile|case file|saksinnsyn|disclosure|metadata)\b/.test(haystack)) {
    if (/workspace|viewer|ingestion/i.test(`${lane.laneId} ${lane.displayName}`)) score += 7
  }
  if (/\b(barnevern|child welfare|child-welfare)\b/.test(haystack)) {
    if (/workspace|viewer|ingestion|timeline|incident/i.test(`${lane.laneId} ${lane.displayName}`)) score += 4
  }
  if (/\b(dapr|queue|pubsub|pub sub|worker|workflow|retry|dead letter|dead-letter|idempotency)\b/.test(haystack)) {
    if (/ingestion|aiops|timeline|incident|backend/i.test(`${lane.laneId} ${lane.displayName}`)) score += 7
  }
  for (const pattern of lane.allowedPaths) {
    const prefix = pattern.replace(/[*{].*$/, "").replace(/\/+$/, "")
    if (prefix && repoFiles.some((file) => file.startsWith(prefix))) score += 1
  }
  return score
}

function personaText(persona: ManagerPersonaDefinition): string {
  return [
    persona.id,
    persona.focus,
    persona.roleClass,
    persona.ideationPrompt,
    persona.blockedEscalation,
    ...(persona.successSignals ?? [])
  ]
    .filter((value): value is string => Boolean(value?.trim()))
    .join(" ")
}

function explicitPersonaScore(personaId: string, text: string): number {
  const value = normalize(text)
  const rules: Array<[RegExp, string, number]> = [
    [/\b(barnevern|child welfare|child-welfare)\b/, "barnevern-domain-specialist", 40],
    [
      /\b(saksinnsyn|casefile|case file|disclosure|metadata|source of record|source-of-record)\b/,
      "saksinnsyn-casefile-specialist",
      36
    ],
    [
      /\b(defendant|end user|end-user|self represented|self-represented|plain language|trust)\b/,
      "defendant-end-user-advocate",
      36
    ],
    [
      /\b(dapr|queue|pubsub|pub sub|dead letter|dead-letter|idempotency|retry|workflow)\b/,
      "dapr-message-queue-specialist",
      36
    ],
    [/\b(architect|architecture|boundary|module|contract|deployment|ownership)\b/, "system-architect", 24],
    [/\b(lawyer|legal|court|citation|provenance|evidence|chronology|matter)\b/, "lawyer-legal-strategy", 28],
    [/\b(backend|api|migration|database|model|worker|service)\b/, "backend-engineer", 22],
    [/\b(frontend|react|route|component|typescript|client)\b/, "frontend-engineer", 22],
    [/\b(ux|journey|accessibility|ergonomic|workflow|empty state|error state|loading state)\b/, "ux-designer", 20],
    [/\b(ui|visual|layout|spacing|responsive|design system|component state)\b/, "ui-designer", 20]
  ]

  return rules.reduce(
    (score, [pattern, id, weight]) => score + (personaId === id && pattern.test(value) ? weight : 0),
    0
  )
}

function tokenOverlapScore(persona: ManagerPersonaDefinition, text: string): number {
  const words = normalize(text)
    .split(/\s+/)
    .filter((word) => word.length >= 5)
  if (words.length === 0) return 0
  const haystack = normalize(personaText(persona))
  return words.reduce((score, word) => score + (haystack.includes(word) ? 2 : 0), 0)
}

function portfolioBucketForPersona(
  profile: ProjectProfile,
  personaId: string | null
): DispatchableTaskPackage["portfolioBucket"] {
  if (!personaId) return undefined
  return profile.planner.portfolioMix?.find((bucket) => bucket.personas.includes(personaId))?.bucket
}

function selectPersona(profile: ProjectProfile, text: string, lane?: LaneDefinition | undefined): PersonaPick | null {
  const candidates = profile.managerStateDefaults.managerPersonas
    .map((persona) => {
      const portfolio = portfolioBucketForPersona(profile, persona.id)
      const ownsLane = lane ? persona.ownedLaneIds.includes(lane.laneId) : false
      const lanePenalty = lane && !ownsLane ? -6 : 0
      const score =
        explicitPersonaScore(persona.id, text) +
        tokenOverlapScore(persona, text) +
        (persona.taskQuotaWeight ?? 0) +
        (portfolio ? 4 : 0) +
        (ownsLane ? 8 : 0) +
        lanePenalty
      return {
        id: persona.id,
        preferredAdapterType: persona.preferredAdapterType,
        portfolioBucket: portfolio,
        ownedLaneIds: persona.ownedLaneIds,
        score
      }
    })
    .sort((left, right) => right.score - left.score)

  const best = candidates[0]
  return best && best.score >= 12 ? best : null
}

function selectLane(
  profile: ProjectProfile,
  text: string,
  repoFiles: string[],
  persona?: PersonaPick | null
): LaneDefinition {
  const allowed = new Set(profile.planner.allowedLanes)
  const personaLaneIds = new Set(persona?.ownedLaneIds ?? [])
  const preferred =
    personaLaneIds.size > 0 ? profile.laneDefinitions.filter((lane) => personaLaneIds.has(lane.laneId)) : []
  const lanes = (preferred.length > 0 ? preferred : profile.laneDefinitions).filter((lane) => allowed.has(lane.laneId))
  const ordered = [...lanes].sort((left, right) => {
    const leftScore = laneScore(left, text, repoFiles) + (personaLaneIds.has(left.laneId) ? 6 : 0)
    const rightScore = laneScore(right, text, repoFiles) + (personaLaneIds.has(right.laneId) ? 6 : 0)
    return rightScore - leftScore
  })
  return ordered[0] ?? profile.laneDefinitions[0]!
}

function verificationFor(profile: ProjectProfile, lane: LaneDefinition, project: Project): string[] {
  const ruleById = new Map<string, VerificationRule>(profile.verificationRules.map((rule) => [rule.ruleId, rule]))
  return uniq([...(ruleById.get(lane.verificationRuleId)?.commands ?? []), project.verifyCommand ?? ""])
}

function readingFor(profile: ProjectProfile, lane: LaneDefinition): string[] {
  const rule = profile.requiredReadingRules.find((entry) => entry.ruleId === lane.requiredReadingRuleId)
  return uniq(rule?.paths ?? [])
}

function repoFiles(project: Project): string[] {
  const roots = ["apps", "packages", "src", "tests", "docs", ".openclaw"]
  return roots.flatMap((root) => {
    const path = join(project.repoPath, root)
    if (!existsSync(path)) return []
    return [root]
  })
}

function relevantFiles(lane: LaneDefinition, item: string): string[] {
  const publicFacades = lane.publicFacades ?? []
  const files = [...publicFacades, ...lane.allowedPaths].slice(0, 8)
  const literalFiles = item.match(/[A-Za-z0-9_.\-/]+\.(?:ts|tsx|js|json|md|py|yml|yaml)/g) ?? []
  return uniq([...literalFiles, ...files])
}

function laneRepoNotes(lane: LaneDefinition): string[] {
  if (!lane.publicFacades?.length) return []
  return [`Lane public facades to keep stable or update deliberately: ${lane.publicFacades.join(", ")}`]
}

function laneExtraInstructions(lane: LaneDefinition): string[] | undefined {
  const instructions = uniq([
    ...(lane.extraInstructions ?? []),
    ...(lane.publicFacades?.length
      ? [
          "Audit the lane public facades before editing internals, and keep facade exports stable unless the task explicitly changes the contract."
        ]
      : [])
  ])
  return instructions.length > 0 ? instructions : undefined
}

function outOfScopeFiles(profile: ProjectProfile, lane: LaneDefinition): string[] {
  return uniq(
    profile.laneDefinitions
      .filter((entry) => entry.laneId !== lane.laneId)
      .flatMap((entry) => entry.allowedPaths.slice(0, 2))
  ).slice(0, 8)
}

function titleFor(item: string, goal: string): string {
  const clean = item.replace(/[.]+$/, "")
  if (/^dispatcher\s+task\s+generate.*--dry-run/.test(clean)) return "Support task factory dry-run preview"
  if (/^dispatcher\s+task\s+generate/.test(clean)) return "Wire task factory CLI command"
  if (/schema|validation/i.test(clean)) return "Add task package schema validation"
  if (/duplicate/i.test(clean)) return "Add task duplicate detection"
  if (/dependenc/i.test(clean)) return "Persist generated task dependencies"
  if (/review/i.test(clean)) return `Review ${clean.replace(/^review\s+/i, "")}`
  if (/^(add|build|create|implement|persist|wire|validate|split|include)\b/i.test(clean)) return clean

  const goalNoun = goal
    .split(/\r?\n/)
    .find((line) => line.trim().length > 0)
    ?.replace(/^build\s+/i, "")
    .replace(/[.]+$/, "")
  return `Implement ${clean.length < 70 ? clean : (goalNoun ?? clean.slice(0, 70))}`
}

function criteriaFor(item: string): string[] {
  if (/^dispatcher\s+task\s+generate/.test(item)) {
    return [
      '`dispatcher task generate --project <project> --goal "..."` creates validated task packages.',
      "`dispatcher task generate --project <project> --goal-file goal.md` reads the goal from disk.",
      "`dispatcher task generate --dry-run` previews without creating queued tasks."
    ]
  }
  if (/schema|validation/i.test(item)) return ["Invalid generated packages are rejected before persistence."]
  if (/duplicate/i.test(item))
    return ["Existing queued, active, or recent completed tasks are skipped by stable dedupe key."]
  if (/dependenc/i.test(item)) return ["Generated task dependencies are stored on queued tasks as task ids."]
  return [item]
}

function rollbackGuidance(title: string, files: string[]): string {
  const scope = files.length > 0 ? ` Revert changes under ${files.slice(0, 3).join(", ")}.` : ""
  return `Revert the task branch for "${title}" and remove any queued dependent tasks before retrying.${scope}`
}

function isReviewPackage(taskPackage: DispatchableTaskPackage): boolean {
  return taskPackage.title.toLowerCase().startsWith("review ")
}

function validatePackage(taskPackage: DispatchableTaskPackage, index: number): void {
  const requiredStrings: Array<[keyof DispatchableTaskPackage, unknown]> = [
    ["title", taskPackage.title],
    ["problemStatement", taskPackage.problemStatement],
    ["lane", taskPackage.lane],
    ["rollbackGuidance", taskPackage.rollbackGuidance],
    ["dedupeKey", taskPackage.dedupeKey]
  ]
  for (const [field, value] of requiredStrings) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`Generated task package ${index} is missing ${String(field)}.`)
    }
  }

  const arrays: Array<[keyof DispatchableTaskPackage, unknown]> = [
    ["relevantFiles", taskPackage.relevantFiles],
    ["outOfScopeFiles", taskPackage.outOfScopeFiles],
    ["acceptanceCriteria", taskPackage.acceptanceCriteria],
    ["verificationCommands", taskPackage.verificationCommands],
    ["dependencies", taskPackage.dependencies]
  ]
  for (const [field, value] of arrays) {
    if (!Array.isArray(value)) throw new Error(`Generated task package ${index} has invalid ${String(field)}.`)
  }
  if (!["low", "medium", "high"].includes(taskPackage.riskLevel)) {
    throw new Error(`Generated task package ${index} has invalid riskLevel.`)
  }
}

export function validateGeneratedTaskPackages(packages: DispatchableTaskPackage[]): DispatchableTaskPackage[] {
  if (!Array.isArray(packages)) throw new Error("Generated task packages must be an array.")
  packages.forEach(validatePackage)
  const seen = new Set<string>()
  for (const taskPackage of packages) {
    if (seen.has(taskPackage.dedupeKey)) {
      throw new Error(`Duplicate generated package dedupe key: ${taskPackage.dedupeKey}`)
    }
    seen.add(taskPackage.dedupeKey)
  }
  validateDependencyGraph(
    packages.map((taskPackage) => ({ id: taskPackage.dedupeKey, dependsOn: taskPackage.dependencies }))
  )
  return packages
}

export function generateDispatchableTaskPackages(input: {
  project: Project
  profile: ProjectProfile
  goal?: string
  goalFile?: string
  currentQueue: Task[]
  recentCompletedTasks: Task[]
  knownFailures: Task[]
}): DispatchableTaskPackage[] {
  const goal = readGoal(input.goal, input.goalFile)
  const items = goalItems(goal).slice(0, Math.max(1, input.profile.planner.maxTasksPerRun)).map(parseGoalItem)
  const files = repoFiles(input.project)
  const packages: DispatchableTaskPackage[] = []

  for (const item of items) {
    const itemContext = `${goal}\n${item.text}`
    const textPersona = selectPersona(input.profile, itemContext)
    const lane = selectLane(input.profile, itemContext, files, textPersona)
    const selectedPersona = textPersona?.ownedLaneIds.includes(lane.laneId)
      ? textPersona
      : selectPersona(input.profile, itemContext, lane)
    const defaultPersonaId = input.profile.planner.defaultPersonaByLane[lane.laneId] ?? null
    const personaId = selectedPersona?.id ?? defaultPersonaId
    const personaBucket = selectedPersona?.portfolioBucket ?? portfolioBucketForPersona(input.profile, personaId)
    const title = titleFor(item.text, goal)
    const riskLevel = inferRisk(itemContext)
    const taskFiles = relevantFiles(lane, item.text)
    const verificationCommands = verificationFor(input.profile, lane, input.project)
    const requiredReading = readingFor(input.profile, lane)
    const dedupeKey = slug(`${input.project.id}:${lane.laneId}:${title}`)

    packages.push({
      version: 1,
      generatedAt: new Date().toISOString(),
      repoProfile: input.profile.profileId,
      likelyOwnershipLane: lane.laneId,
      laneReason: `Task factory matched ${lane.displayName} from the goal and repository profile.`,
      inferenceSignals: uniq([
        `goal:${goal.slice(0, 120)}`,
        `item:${item.text}`,
        ...input.currentQueue.slice(0, 3).map((task) => `queued:${task.title}`),
        ...input.knownFailures.slice(0, 3).map((task) => `failure:${task.title}`)
      ]),
      requiredReading,
      verificationChecklist: verificationCommands,
      contractUpdateReminders: /api|contract|schema/i.test(`${lane.laneId} ${item.text}`)
        ? ["Update API contracts and dependent fixtures when request or response shapes change."]
        : [],
      repoNotes: uniq([
        `Recent completed tasks considered: ${input.recentCompletedTasks.length}`,
        `Known failures considered: ${input.knownFailures.length}`,
        ...laneRepoNotes(lane)
      ]),
      extraInstructions: laneExtraInstructions(lane),
      personaProvenance: personaId
        ? {
            personaId,
            personaName: personaId,
            source: "manual",
            portfolioBucket: personaBucket,
            rationale: selectedPersona
              ? `Task factory selected persona ${selectedPersona.id} from goal text and lane ${lane.laneId}.`
              : `Task factory selected default persona for lane ${lane.laneId}.`
          }
        : undefined,
      userOutcome: item.text,
      acceptanceCriteria: criteriaFor(item.text),
      taskSourceIntent: "manual",
      portfolioBucket: personaBucket,
      title,
      problemStatement: item.text,
      lane: lane.laneId,
      recommendedPersona: personaId,
      adapterPreference:
        selectedPersona?.preferredAdapterType ??
        input.profile.planner.defaultAdapterByLane[lane.laneId] ??
        lane.preferredAdapterType,
      relevantFiles: taskFiles,
      outOfScopeFiles: outOfScopeFiles(input.profile, lane),
      verificationCommands,
      riskLevel,
      dependencies: [],
      expectedChangeSize: expectedSize(items.length, riskLevel),
      rollbackGuidance: rollbackGuidance(title, taskFiles),
      dedupeKey
    })
  }

  for (const [index, item] of items.entries()) {
    packages[index]!.dependencies = resolveGoalItemDependencies({ item, itemIndex: index, packages })
  }

  const riskyImplementationPackages = packages.filter((taskPackage) => taskPackage.riskLevel === "high")
  for (const risky of riskyImplementationPackages) {
    if (isReviewPackage(risky)) continue
    const lane = input.profile.laneDefinitions.find((entry) => entry.laneId === risky.lane)
    const reviewTitle = `Review ${risky.title}`
    packages.push({
      ...risky,
      generatedAt: new Date().toISOString(),
      title: reviewTitle,
      problemStatement: `Review the high-risk implementation task "${risky.title}" before promotion.`,
      recommendedPersona: input.profile.planner.defaultPersonaByLane[risky.lane] ?? "reviewer",
      acceptanceCriteria: [
        "Review verifies the implementation scope, rollback guidance, and command output.",
        "Review records approval or concrete change requests before promotion."
      ],
      riskLevel: "low",
      dependencies: [risky.dedupeKey],
      expectedChangeSize: "small",
      rollbackGuidance: `Block promotion for "${risky.title}" and requeue fixes if review fails.`,
      dedupeKey: slug(`${input.project.id}:${risky.lane}:${reviewTitle}`),
      relevantFiles: risky.relevantFiles,
      outOfScopeFiles: lane ? outOfScopeFiles(input.profile, lane) : risky.outOfScopeFiles
    })
  }

  return validateGeneratedTaskPackages(packages)
}

function duplicateTask(existingTasks: Task[], taskPackage: DispatchableTaskPackage): Task | null {
  const label = `task-factory-dedupe:${taskPackage.dedupeKey}`
  const normalizedTitle = normalize(taskPackage.title)
  return (
    existingTasks.find((task) => task.labels.includes(label)) ??
    existingTasks.find((task) => task.laneId === taskPackage.lane && normalize(task.title) === normalizedTitle) ??
    null
  )
}

function taskKind(taskPackage: DispatchableTaskPackage): TaskKind {
  return taskPackage.title.toLowerCase().startsWith("review ") ? "review" : "implement"
}

export function materializeGeneratedTaskPackages(input: {
  store: DispatcherStore
  project: Project
  packages: DispatchableTaskPackage[]
  dryRun: boolean
}): TaskFactoryResult {
  validateGeneratedTaskPackages(input.packages)
  const decisions: TaskFactoryResult["decisions"] = []
  const existing = input.store.listProjectTasks(input.project.id)
  const createdOrExistingByDedupeKey = new Map<string, string>()
  const packageByDedupeKey = new Map(input.packages.map((taskPackage) => [taskPackage.dedupeKey, taskPackage]))
  const orderedPackages = topologicalDependencyOrder(
    input.packages.map((taskPackage) => ({ id: taskPackage.dedupeKey, dependsOn: taskPackage.dependencies }))
  ).map((dedupeKey) => packageByDedupeKey.get(dedupeKey)!)

  for (const taskPackage of orderedPackages) {
    const duplicate = duplicateTask([...existing], taskPackage)
    if (duplicate) {
      createdOrExistingByDedupeKey.set(taskPackage.dedupeKey, duplicate.id)
      decisions.push({
        title: taskPackage.title,
        dedupeKey: taskPackage.dedupeKey,
        action: "skip_duplicate",
        reason: "matched existing task by factory dedupe key or lane/title",
        existingTaskId: duplicate.id
      })
      continue
    }

    const dependencyIds = taskPackage.dependencies
      .map((dedupeKey) => createdOrExistingByDedupeKey.get(dedupeKey))
      .filter((id): id is string => Boolean(id))

    if (input.dryRun) {
      decisions.push({
        title: taskPackage.title,
        dedupeKey: taskPackage.dedupeKey,
        action: "create",
        reason: "dry-run preview"
      })
      continue
    }

    const created = input.store.createTask({
      projectRef: input.project.id,
      title: taskPackage.title,
      description: taskPackage.problemStatement,
      labels: [
        "task-factory-generated",
        `task-factory-dedupe:${taskPackage.dedupeKey}`,
        `task-risk:${taskPackage.riskLevel}`,
        taskPackage.recommendedPersona ? `persona:${taskPackage.recommendedPersona}` : null,
        taskPackage.portfolioBucket ? `bucket:${taskPackage.portfolioBucket}` : null,
        taskPackage.taskSourceIntent ? `source:${taskPackage.taskSourceIntent}` : null
      ].filter((label): label is string => Boolean(label)),
      changedFiles: taskPackage.relevantFiles,
      taskPackage,
      kind: taskKind(taskPackage),
      priority: taskPackage.riskLevel === "high" ? 80 : taskPackage.riskLevel === "medium" ? 60 : 40,
      dependsOnTaskIds: dependencyIds,
      requestedAdapterType: taskPackage.adapterPreference,
      laneId: taskPackage.lane,
      allowedPaths: taskPackage.relevantFiles,
      requiredReading: taskPackage.requiredReading,
      verificationCommands: taskPackage.verificationCommands,
      reviewRequired: taskPackage.riskLevel === "high",
      maxRetries: taskPackage.riskLevel === "low" ? 1 : 2
    })
    existing.push(created)
    createdOrExistingByDedupeKey.set(taskPackage.dedupeKey, created.id)
    decisions.push({
      title: taskPackage.title,
      dedupeKey: taskPackage.dedupeKey,
      action: "create",
      reason: "created queued task",
      createdTaskId: created.id
    })
  }

  return { packages: input.packages, decisions }
}

export function defaultGoalFileName(path: string): string {
  return basename(path)
}
