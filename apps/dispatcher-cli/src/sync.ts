import { existsSync, readdirSync, readFileSync } from "node:fs"
import { basename, join, resolve } from "node:path"
import type { DispatcherStore } from "@openclaw/db"
import type { AdapterType, AutomationKind, JobId, Persona, PersonaStage, TaskPackage } from "@openclaw/domain"
import { resolveProjectProfile } from "@openclaw/project-profiles"

import { detectRepoContext } from "./repo-context.js"
import { buildTaskPackage } from "./task-package.js"

type BudgetWindowKind = "daily" | "monthly"

type SyncEntryStatus = "created" | "updated" | "kept" | "skipped"

type SyncEntry = {
  name: string
  status: SyncEntryStatus
  details: string[]
}

type AgentCandidate = {
  name: string
  role: string | null
  adapterType: AdapterType | null
  model: string | null
  instructionsPath: string | null
  budgetLimit: number | null
  budgetWindow: BudgetWindowKind | null
  sources: string[]
}

type PersonaCandidate = {
  name: string
  stage: PersonaStage
  ownedLanes: string[]
  preferredAdapterType: AdapterType
  instructionsPath: string | null
  budgetLimit: number | null
  budgetWindow: BudgetWindowKind | null
}

type RoutingRuleCandidate = {
  name: string
  adapterType: AdapterType
  priority: number
  patterns: string[]
  sources: string[]
}

type JobSpecCandidate = {
  jobId: JobId
  sourcePath: string
  cron: string
  timezone: string
  entryAgent: string | null
}

type AutomationCandidate = {
  name: string
  kind: AutomationKind
  cron: string
  sourceProjectRef: string | null
  payload: Record<string, unknown>
}

type SyncOptions = {
  targetPath: string
  store: DispatcherStore
  companyName?: string | null
  projectName?: string | null
  verifyCommand?: string | null
}

export type SyncSummary = {
  targetPath: string
  dbPath: string
  company: SyncEntry
  project: SyncEntry
  agents: SyncEntry[]
  personas: SyncEntry[]
  jobs: SyncEntry[]
  automations: SyncEntry[]
  routingRules: SyncEntry[]
  workflows: SyncEntry[]
  sources: string[]
  skipped: string[]
  unmapped: string[]
  warnings: string[]
}

const ROLE_TITLES: Record<string, string> = {
  main: "Autonomous Director",
  planner: "Task Planner",
  reviewer: "Reviewer",
  promoter: "Promoter"
}

function inferPersonaStage(name: string): PersonaStage {
  const normalized = name.toLowerCase()
  if (normalized.includes("plan")) return "planner"
  if (normalized.includes("review")) return "reviewer"
  if (normalized.includes("promot")) return "promoter"
  return "coder"
}

function automationKindForJob(jobId: JobId): AutomationKind {
  switch (jobId) {
    case "queue-refresh":
      return "queue_refresh"
    case "execution-sweep":
      return "repo_health"
    case "review-sweep":
      return "pending_review_sync"
    case "promotion-sweep":
      return "blocked_promotion_retry"
    case "github-pr-sweep":
      return "blocked_promotion_retry"
    case "daily-telegram-digest":
      return "repo_health"
  }
}

const SUPPORTED_JOB_IDS = new Set<JobId>([
  "queue-refresh",
  "execution-sweep",
  "review-sweep",
  "promotion-sweep",
  "github-pr-sweep",
  "daily-telegram-digest"
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => asString(item)).filter((item): item is string => item !== null)
}

function managerPersonaEntries(value: unknown): unknown[] {
  if (!isRecord(value)) return []
  if (Array.isArray(value.manager_personas)) return value.manager_personas
  if (Array.isArray(value.managerPersonas)) return value.managerPersonas
  return []
}

function managerPersonaOwnedLanes(persona: Record<string, unknown>): string[] {
  const snakeCase = asStringArray(persona.owned_lanes)
  return snakeCase.length > 0 ? snakeCase : asStringArray(persona.ownedLaneIds)
}

function managerPersonaAdapter(persona: Record<string, unknown>, fallbackName?: string): AdapterType | null {
  return detectAdapter(persona.preferredModel ?? persona.preferredAdapterType, fallbackName)
}

function repoHealthLaneFromProfile(profileValue: unknown): string | null {
  if (!isRecord(profileValue)) return null

  const managerDefaults = isRecord(profileValue.managerStateDefaults) ? profileValue.managerStateDefaults : null
  const projects = managerDefaults && Array.isArray(managerDefaults.projects) ? managerDefaults.projects : []
  for (const project of projects) {
    if (!isRecord(project)) continue
    if (asString(project.id) !== "dispatch-continuity") continue
    const laneId = asString(project.laneId)
    if (laneId) return laneId
  }

  const laneDefinitions = Array.isArray(profileValue.laneDefinitions) ? profileValue.laneDefinitions : []
  for (const lane of laneDefinitions) {
    if (!isRecord(lane)) continue
    const laneId = asString(lane.laneId)
    if (laneId === "backend-ingestion-and-aiops") {
      return laneId
    }
  }

  return null
}

function filePath(root: string, relativePath: string): string {
  return join(root, relativePath)
}

function readJson(root: string, relativePath: string, warnings: string[]): unknown | null {
  const path = filePath(root, relativePath)
  if (!existsSync(path)) return null

  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown
  } catch (error) {
    warnings.push(`Failed to parse ${relativePath}: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

function readPreferredJson(root: string, paths: string[], warnings: string[]): { path: string; value: unknown } | null {
  for (const relativePath of paths) {
    const value = readJson(root, relativePath, warnings)
    if (value !== null) {
      return { path: relativePath, value }
    }
  }

  return null
}

function detectAdapter(value: unknown, fallbackName?: string): AdapterType | null {
  const normalized = asString(value)?.toLowerCase()
  if (normalized?.includes("foundry") || normalized?.includes("azure") || normalized?.includes("kimi")) {
    return "azure_foundry"
  }
  if (normalized?.includes("gemini")) return "gemini_local"
  if (normalized?.includes("codex") || normalized?.startsWith("gpt-5.")) return "codex_local"

  const fromName = fallbackName?.toLowerCase()
  if (fromName?.includes("foundry") || fromName?.includes("azure") || fromName?.includes("kimi")) {
    return "azure_foundry"
  }
  if (fromName?.includes("ui") || fromName?.includes("front") || fromName?.includes("design")) {
    return "gemini_local"
  }

  if (fromName) return "codex_local"
  return null
}

function parseBudget(value: unknown): { limit: number | null; window: BudgetWindowKind | null } {
  if (typeof value === "number" && Number.isFinite(value)) {
    return { limit: value, window: "monthly" }
  }

  if (!isRecord(value)) {
    return { limit: null, window: null }
  }

  const rawLimit = value.limit ?? value.max ?? value.units ?? value.total
  const rawWindow = asString(value.window ?? value.period)?.toLowerCase()
  const limit = typeof rawLimit === "number" && Number.isFinite(rawLimit) ? rawLimit : null
  const window = rawWindow === "daily" || rawWindow === "monthly" ? rawWindow : null
  return { limit, window }
}

function isSupportedJobId(value: unknown): value is JobId {
  return typeof value === "string" && SUPPORTED_JOB_IDS.has(value as JobId)
}

function splitPatterns(...inputs: Array<string | null | undefined>): string[] {
  const patterns = new Set<string>()

  for (const input of inputs) {
    const value = asString(input)
    if (!value) continue

    patterns.add(value)

    const slashParts = value
      .split(/[\\/]/)
      .map((part) => part.trim())
      .filter(Boolean)
    for (const part of slashParts) {
      patterns.add(part)
    }

    if (value.includes("-")) {
      patterns.add(value.replaceAll("-", " "))
    }
  }

  return Array.from(patterns)
}

function firstHeading(markdown: string): string | null {
  for (const line of markdown.split("\n")) {
    if (line.startsWith("#")) {
      return line.replace(/^#+\s*/, "").trim() || null
    }
  }

  return null
}

function inferRole(name: string, heading: string | null): string {
  return ROLE_TITLES[name] ?? heading ?? name
}

function getPromptCandidates(root: string): AgentCandidate[] {
  const agentsDir = filePath(root, ".openclaw/agents")
  if (!existsSync(agentsDir)) return []

  return readdirSync(agentsDir)
    .filter((entry) => entry.endsWith(".md"))
    .sort()
    .map((entry) => {
      const path = join(agentsDir, entry)
      const name = basename(entry, ".md")
      const heading = firstHeading(readFileSync(path, "utf8"))
      return {
        name,
        role: inferRole(name, heading),
        adapterType: detectAdapter(null, name),
        model: null,
        instructionsPath: path,
        budgetLimit: null,
        budgetWindow: null,
        sources: [".openclaw/agents/"]
      }
    })
}

function mergeAgentCandidate(
  candidates: Map<string, AgentCandidate>,
  name: string,
  patch: Partial<AgentCandidate>,
  source: string
): void {
  const current = candidates.get(name) ?? {
    name,
    role: null,
    adapterType: null,
    model: null,
    instructionsPath: null,
    budgetLimit: null,
    budgetWindow: null,
    sources: []
  }

  const next: AgentCandidate = {
    name,
    role: patch.role ?? current.role,
    adapterType: patch.adapterType ?? current.adapterType,
    model: patch.model ?? current.model,
    instructionsPath: patch.instructionsPath ?? current.instructionsPath,
    budgetLimit: patch.budgetLimit ?? current.budgetLimit,
    budgetWindow: patch.budgetWindow ?? current.budgetWindow,
    sources: Array.from(new Set([...current.sources, source]))
  }

  if (next.role === null) {
    next.role = inferRole(name, null)
  }

  if (next.adapterType === null) {
    next.adapterType = detectAdapter(next.model, name)
  }

  candidates.set(name, next)
}

function extractControlPlaneAgents(
  controlPlane: unknown,
  candidates: Map<string, AgentCandidate>,
  ruleCandidates: Map<string, RoutingRuleCandidate>
): string[] {
  if (!isRecord(controlPlane)) return []

  const sources: string[] = []
  const agents = controlPlane.agents
  if (Array.isArray(agents)) {
    sources.push(".openclaw/control-plane.json")
    for (const agent of agents) {
      if (!isRecord(agent)) continue
      const name = asString(agent.id ?? agent.name)
      if (!name) continue

      const model = asString(agent.preferredModel ?? agent.model)
      const budget = parseBudget(agent.budget ?? agent.budgets)
      mergeAgentCandidate(
        candidates,
        name,
        {
          role: asString(agent.role ?? agent.title) ?? inferRole(name, null),
          adapterType: detectAdapter(agent.adapter ?? model, name),
          model,
          budgetLimit: budget.limit,
          budgetWindow: budget.window
        },
        ".openclaw/control-plane.json"
      )

      const routingHints = isRecord(agent.routingHints) ? agent.routingHints : null
      const patterns = routingHints
        ? Array.from(
            new Set(
              [
                ...asStringArray(routingHints.patterns),
                ...asStringArray(routingHints.keywords),
                ...asStringArray(routingHints.lanes),
                ...asStringArray(routingHints.categories),
                ...asStringArray(routingHints.priorities)
              ].flatMap((value) => splitPatterns(value))
            )
          )
        : []
      const adapterType = detectAdapter(agent.adapter ?? model, name)
      if (patterns.length > 0 && adapterType) {
        ruleCandidates.set(`openclaw-agent:${name}`, {
          name: `openclaw-agent:${name}`,
          adapterType,
          priority: 85,
          patterns,
          sources: [".openclaw/control-plane.json"]
        })
      }
    }
  }

  const routingHints = controlPlane.routingHints
  if (Array.isArray(routingHints)) {
    sources.push(".openclaw/control-plane.json")
    for (const hint of routingHints) {
      if (!isRecord(hint)) continue
      const name = asString(hint.name ?? hint.id)
      const adapterType = detectAdapter(hint.preferredModel ?? hint.model ?? hint.adapter, name ?? undefined)
      if (!name || !adapterType) continue
      const patterns = Array.from(
        new Set(
          [
            ...asStringArray(hint.patterns),
            ...asStringArray(hint.keywords),
            ...asStringArray(hint.lanes),
            ...asStringArray(hint.categories),
            ...asStringArray(hint.priorities)
          ].flatMap((value) => splitPatterns(value))
        )
      )
      if (patterns.length === 0) continue

      ruleCandidates.set(`openclaw-hint:${name}`, {
        name: `openclaw-hint:${name}`,
        adapterType,
        priority: typeof hint.priority === "number" ? hint.priority : 80,
        patterns,
        sources: [".openclaw/control-plane.json"]
      })
    }
  }

  return Array.from(new Set(sources))
}

function extractRuntimeAgents(runtime: unknown, candidates: Map<string, AgentCandidate>, sourcePath: string): void {
  if (!isRecord(runtime)) return
  for (const role of asStringArray(runtime.roles)) {
    mergeAgentCandidate(candidates, role, {}, sourcePath)
  }

  const entryAgent = asString(runtime.entry_agent)
  if (entryAgent) {
    mergeAgentCandidate(candidates, entryAgent, {}, sourcePath)
  }
}

function extractCategoryRules(
  value: unknown,
  sourcePath: string,
  ruleCandidates: Map<string, RoutingRuleCandidate>
): void {
  if (!isRecord(value)) return
  const categories = value.categories
  if (!Array.isArray(categories)) return

  for (const category of categories) {
    if (!isRecord(category)) continue
    const id = asString(category.id)
    const adapterType = detectAdapter(category.preferredModel, id ?? undefined)
    if (!id || !adapterType) continue

    const label = asString(category.label)
    const lanes = asStringArray(category.lanes)
    const priorities = asStringArray(category.priorities)
    const patterns = Array.from(
      new Set([
        ...splitPatterns(id, label),
        ...lanes.flatMap((lane) => splitPatterns(lane)),
        ...priorities.flatMap((priority) => splitPatterns(priority))
      ])
    )

    ruleCandidates.set(`openclaw-category:${id}`, {
      name: `openclaw-category:${id}`,
      adapterType,
      priority: 70,
      patterns,
      sources: [sourcePath]
    })
  }
}

function extractQueueRules(
  value: unknown,
  sourcePath: string,
  ruleCandidates: Map<string, RoutingRuleCandidate>
): void {
  if (!isRecord(value)) return

  if (isRecord(value.laneModelPreferences)) {
    for (const [lane, preferredModel] of Object.entries(value.laneModelPreferences)) {
      const adapterType = detectAdapter(preferredModel, lane)
      if (!adapterType) continue
      ruleCandidates.set(`openclaw-lane:${lane}`, {
        name: `openclaw-lane:${lane}`,
        adapterType,
        priority: 90,
        patterns: splitPatterns(lane),
        sources: [sourcePath]
      })
    }
  }
}

function extractManagerRules(
  value: unknown,
  sourcePath: string,
  ruleCandidates: Map<string, RoutingRuleCandidate>
): void {
  for (const persona of managerPersonaEntries(value)) {
    if (!isRecord(persona)) continue
    const id = asString(persona.id)
    const adapterType = managerPersonaAdapter(persona, id ?? undefined)
    if (!id || !adapterType) continue

    const patterns = Array.from(
      new Set([...splitPatterns(id), ...managerPersonaOwnedLanes(persona).flatMap((lane) => splitPatterns(lane))])
    )
    if (patterns.length === 0) continue

    ruleCandidates.set(`openclaw-persona:${id}`, {
      name: `openclaw-persona:${id}`,
      adapterType,
      priority: 65,
      patterns,
      sources: [sourcePath]
    })
  }
}

function buildPersonaCandidates(
  agentCandidates: Map<string, AgentCandidate>,
  managerState: unknown
): PersonaCandidate[] {
  const personas = new Map<string, PersonaCandidate>()

  const seedPersona = (candidate: PersonaCandidate) => {
    personas.set(candidate.name, candidate)
  }

  for (const [name, agent] of agentCandidates.entries()) {
    const normalized = name.toLowerCase()
    if (!["planner", "reviewer", "promoter", "coder", "main"].includes(normalized)) {
      continue
    }
    const personaName = normalized === "main" ? "coder" : name
    if (personas.has(personaName)) continue
    seedPersona({
      name: personaName,
      stage: inferPersonaStage(personaName),
      ownedLanes: [],
      preferredAdapterType: agent.adapterType ?? "codex_local",
      instructionsPath: agent.instructionsPath,
      budgetLimit: agent.budgetLimit,
      budgetWindow: agent.budgetWindow
    })
  }

  for (const rawPersona of managerPersonaEntries(managerState)) {
    if (!isRecord(rawPersona)) continue
    const name = asString(rawPersona.id)
    const adapterType = managerPersonaAdapter(rawPersona, name ?? undefined)
    if (!name || !adapterType) continue
    const linkedAgent = agentCandidates.get(name)
    personas.set(name, {
      name,
      stage: inferPersonaStage(name),
      ownedLanes: managerPersonaOwnedLanes(rawPersona),
      preferredAdapterType: adapterType,
      instructionsPath: linkedAgent?.instructionsPath ?? null,
      budgetLimit: linkedAgent?.budgetLimit ?? null,
      budgetWindow: linkedAgent?.budgetWindow ?? null
    })
  }

  return Array.from(personas.values()).sort((left, right) => left.name.localeCompare(right.name))
}

function mergeCompany(store: DispatcherStore, name: string): SyncEntry & { id: string } {
  try {
    const existing = store.resolveCompany(name)
    return { id: existing.id, name, status: "kept", details: ["matched existing company"] }
  } catch {
    const created = store.createCompany({ name })
    return { id: created.id, name, status: "created", details: ["created from repo-owned control plane"] }
  }
}

function mergeProject(
  store: DispatcherStore,
  companyId: string,
  repoPath: string,
  name: string,
  verifyCommand: string | null
): SyncEntry & { id: string } {
  const existingByRepo = store.findProjectByRepoPath(repoPath, companyId)
  const existing =
    existingByRepo ??
    (() => {
      try {
        return store.resolveProject(name, companyId)
      } catch {
        return null
      }
    })()

  if (!existing) {
    const created = store.createProject({
      companyRef: companyId,
      name,
      repoPath,
      verifyCommand
    })
    return {
      id: created.id,
      name: created.name,
      status: "created",
      details: ["created project row for repo-owned control plane"]
    }
  }

  const updates: string[] = []
  if (verifyCommand && existing.verifyCommand !== verifyCommand) {
    store.updateProject(existing.id, { verifyCommand })
    updates.push(`${existing.verifyCommand ? "updated" : "set"} verify command to ${verifyCommand}`)
  }

  if (existing.name !== name) {
    updates.push(`kept existing project name ${existing.name}`)
  }

  return {
    id: existing.id,
    name: existing.name,
    status: updates.some((entry) => entry.startsWith("set ") || entry.startsWith("updated ")) ? "updated" : "kept",
    details: updates.length > 0 ? updates : ["matched existing project"]
  }
}

function isGenericRole(role: string): boolean {
  const normalized = role.trim().toLowerCase()
  return (
    normalized === "software engineer" ||
    normalized === "ui engineer" ||
    normalized === "agent" ||
    normalized === "autonomous agent"
  )
}

function isRepoOwnedAgentInstructionsPath(path: string): boolean {
  return path.includes("/.openclaw/agents/") && path.endsWith(".md")
}

function shouldRefreshAgentInstructionsPath(existingPath: string, candidatePath: string): boolean {
  return (
    isRepoOwnedAgentInstructionsPath(existingPath) &&
    isRepoOwnedAgentInstructionsPath(candidatePath) &&
    basename(existingPath) === basename(candidatePath)
  )
}

function mergeAgent(
  store: DispatcherStore,
  companyId: string,
  candidate: AgentCandidate,
  skipped: string[]
): SyncEntry {
  try {
    const existing = store.resolveAgent(candidate.name, companyId)
    const patch: Parameters<typeof store.updateAgent>[1] = {}
    const details: string[] = []

    if ((!existing.instructionsPath || existing.instructionsPath.trim().length === 0) && candidate.instructionsPath) {
      patch.instructionsPath = candidate.instructionsPath
      details.push("set instructions path from repo-owned prompt")
    } else if (
      existing.instructionsPath &&
      candidate.instructionsPath &&
      existing.instructionsPath !== candidate.instructionsPath
    ) {
      if (shouldRefreshAgentInstructionsPath(existing.instructionsPath, candidate.instructionsPath)) {
        patch.instructionsPath = candidate.instructionsPath
        details.push("refreshed repo-owned instructions path")
      } else {
        skipped.push(
          `Agent ${candidate.name}: kept existing instructions path ${existing.instructionsPath} instead of ${candidate.instructionsPath}`
        )
      }
    }

    if (candidate.role && isGenericRole(existing.role) && existing.role !== candidate.role) {
      patch.role = candidate.role
      details.push(`refined role to ${candidate.role}`)
    } else if (candidate.role && existing.role !== candidate.role && !isGenericRole(existing.role)) {
      skipped.push(`Agent ${candidate.name}: kept existing role ${existing.role} instead of imported ${candidate.role}`)
    }

    if (!existing.model && candidate.model) {
      patch.model = candidate.model
      details.push(`set preferred model to ${candidate.model}`)
    } else if (existing.model && candidate.model && existing.model !== candidate.model) {
      skipped.push(
        `Agent ${candidate.name}: kept existing model ${existing.model} instead of imported ${candidate.model}`
      )
    }

    if (existing.budgetLimit === null && candidate.budgetLimit !== null) {
      patch.budgetLimit = candidate.budgetLimit
      patch.budgetWindow = candidate.budgetWindow ?? "monthly"
      details.push(`set budget to ${candidate.budgetLimit}/${candidate.budgetWindow ?? "monthly"}`)
    } else if (
      existing.budgetLimit !== null &&
      candidate.budgetLimit !== null &&
      existing.budgetLimit !== candidate.budgetLimit
    ) {
      skipped.push(
        `Agent ${candidate.name}: kept existing budget ${existing.budgetLimit}/${existing.budgetWindow} instead of imported ${candidate.budgetLimit}/${candidate.budgetWindow ?? "monthly"}`
      )
    }

    if (existing.adapterType !== candidate.adapterType && candidate.adapterType) {
      skipped.push(
        `Agent ${candidate.name}: kept existing adapter ${existing.adapterType} instead of imported ${candidate.adapterType}`
      )
    }

    if (details.length > 0) {
      store.updateAgent(existing.id, patch)
      return { name: candidate.name, status: "updated", details }
    }

    return { name: candidate.name, status: "kept", details: ["matched existing agent"] }
  } catch {
    const created = store.createAgent({
      companyRef: companyId,
      name: candidate.name,
      role: candidate.role ?? inferRole(candidate.name, null),
      adapterType: candidate.adapterType ?? "codex_local",
      model: candidate.model,
      instructionsPath: candidate.instructionsPath,
      budgetLimit: candidate.budgetLimit,
      budgetWindow: candidate.budgetWindow ?? "monthly"
    })
    const details = [`created ${created.adapterType} agent from repo-owned role prompt`]
    if (created.instructionsPath) {
      details.push("linked repo-owned instructions")
    }
    if (created.budgetLimit !== null) {
      details.push(`budget ${created.budgetLimit}/${created.budgetWindow}`)
    }
    return { name: candidate.name, status: "created", details }
  }
}

function mergePersona(
  store: DispatcherStore,
  companyId: string,
  candidate: PersonaCandidate,
  skipped: string[]
): SyncEntry {
  let existing: Persona | null
  try {
    existing = store.resolvePersona(candidate.name, companyId)
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith("Persona not found:")) {
      throw error
    }
    existing = null
  }

  if (existing) {
    const details: string[] = []
    const patch: Parameters<typeof store.updatePersona>[1] = {}

    if (existing.stage !== candidate.stage) {
      skipped.push(
        `Persona ${candidate.name}: kept existing stage ${existing.stage} instead of imported ${candidate.stage}`
      )
    }

    if (existing.preferredAdapterType !== candidate.preferredAdapterType) {
      patch.preferredAdapterType = candidate.preferredAdapterType
      details.push(`adapter ${candidate.preferredAdapterType}`)
    }

    if (!existing.instructionsPath && candidate.instructionsPath) {
      patch.instructionsPath = candidate.instructionsPath
      details.push("linked instructions")
    }

    const mergedLanes = Array.from(new Set([...existing.ownedLanes, ...candidate.ownedLanes]))
    if (mergedLanes.length !== existing.ownedLanes.length) {
      patch.ownedLanes = mergedLanes
      details.push(`merged ${mergedLanes.length - existing.ownedLanes.length} lane(s)`)
    }

    if (existing.budgetLimit === null && candidate.budgetLimit !== null) {
      patch.budgetLimit = candidate.budgetLimit
      patch.budgetWindow = candidate.budgetWindow ?? "monthly"
      details.push(`budget ${candidate.budgetLimit}/${candidate.budgetWindow ?? "monthly"}`)
    }

    if (details.length > 0) {
      store.updatePersona(existing.id, patch)
      return { name: candidate.name, status: "updated", details }
    }

    return { name: candidate.name, status: "kept", details: ["matched existing persona"] }
  }

  store.upsertPersona({
    companyRef: companyId,
    name: candidate.name,
    stage: candidate.stage,
    ownedLanes: candidate.ownedLanes,
    preferredAdapterType: candidate.preferredAdapterType,
    instructionsPath: candidate.instructionsPath,
    budgetLimit: candidate.budgetLimit,
    budgetWindow: candidate.budgetWindow ?? "monthly"
  })
  return {
    name: candidate.name,
    status: "created",
    details: [`stage ${candidate.stage}`, `adapter ${candidate.preferredAdapterType}`]
  }
}

function mergeAutomation(
  store: DispatcherStore,
  companyId: string,
  projectId: string,
  candidate: AutomationCandidate
): SyncEntry {
  const existing = store
    .listAutomations(companyId)
    .find((entry) => entry.name === candidate.name && entry.projectId === projectId)
  if (!existing) {
    store.createAutomation({
      companyRef: companyId,
      projectRef: projectId,
      name: candidate.name,
      kind: candidate.kind,
      cron: candidate.cron,
      nextRunAt: new Date().toISOString(),
      payload: candidate.payload
    })
    return {
      name: candidate.name,
      status: "created",
      details: [`kind ${candidate.kind}`, `cron ${candidate.cron}`]
    }
  }

  const payloadChanged = JSON.stringify(existing.payload ?? {}) !== JSON.stringify(candidate.payload)
  if (existing.kind !== candidate.kind || existing.cron !== candidate.cron || payloadChanged) {
    store.updateAutomation(existing.id, {
      kind: candidate.kind,
      cron: candidate.cron,
      payload: candidate.payload
    })
    return {
      name: candidate.name,
      status: "updated",
      details: [`kind ${candidate.kind}`, `cron ${candidate.cron}`]
    }
  }

  return {
    name: candidate.name,
    status: "kept",
    details: [`kind ${candidate.kind}`, `cron ${candidate.cron}`]
  }
}

function mergeRoutingRule(store: DispatcherStore, candidate: RoutingRuleCandidate, skipped: string[]): SyncEntry {
  const existing = store.findRoutingRuleByName(candidate.name)
  if (!existing) {
    store.createRoutingRule({
      name: candidate.name,
      priority: candidate.priority,
      targetAdapterType: candidate.adapterType,
      matchType: "keyword",
      patterns: candidate.patterns
    })
    return {
      name: candidate.name,
      status: "created",
      details: [`created keyword rule for ${candidate.adapterType}`, `${candidate.patterns.length} pattern(s)`]
    }
  }

  if (existing.targetAdapterType !== candidate.adapterType) {
    skipped.push(
      `Routing rule ${candidate.name}: kept existing adapter ${existing.targetAdapterType} instead of imported ${candidate.adapterType}`
    )
    return {
      name: candidate.name,
      status: "skipped",
      details: ["adapter conflict with existing routing rule"]
    }
  }

  const mergedPatterns = Array.from(new Set([...existing.patterns, ...candidate.patterns]))
  const updatedPriority = Math.max(existing.priority, candidate.priority)
  const patternsAdded = mergedPatterns.length - existing.patterns.length
  const priorityChanged = updatedPriority !== existing.priority

  if (patternsAdded > 0 || priorityChanged) {
    store.updateRoutingRule(existing.id, {
      priority: updatedPriority,
      patterns: mergedPatterns
    })
    const details: string[] = []
    if (patternsAdded > 0) {
      details.push(`merged ${patternsAdded} new pattern(s)`)
    }
    if (priorityChanged) {
      details.push(`raised priority to ${updatedPriority}`)
    }
    return { name: candidate.name, status: "updated", details }
  }

  return { name: candidate.name, status: "kept", details: ["matched existing routing rule"] }
}

type QueueWorkflowSeed = {
  sourceLabel: string
  title: string
  description: string
  labels: string[]
  requestedAdapterType: AdapterType
  priority: number
  taskPackage: TaskPackage
  lane: string | null
  managerPersona: string | null
}

function preferredAdapterForLane(lane: string | null): AdapterType {
  if (lane?.startsWith("pm-") || lane?.includes("review") || lane?.includes("promot")) {
    return "azure_foundry"
  }
  return "codex_local"
}

function surfaceLabelForLane(lane: string | null): "ui" | "backend" {
  return lane?.startsWith("ui-") ? "ui" : "backend"
}

function taskPackageForSeed(
  targetPath: string,
  verifyCommand: string | null,
  seed: {
    title: string
    description: string
    labels: string[]
    requestedAdapterType: AdapterType
  }
): TaskPackage {
  const repoContext = detectRepoContext(targetPath, verifyCommand)
  return buildTaskPackage({
    title: seed.title,
    description: seed.description,
    labels: seed.labels,
    changedFiles: [],
    requestedAdapterType: seed.requestedAdapterType,
    assignedAgentAdapterType: null,
    repoContext,
    verifyCommand
  })
}

function findPersonaForSeed(
  store: DispatcherStore,
  companyId: string,
  stage: PersonaStage,
  lane: string | null,
  preferredNames: Array<string | null | undefined> = []
) {
  const personas = store.listPersonas(companyId)

  for (const preferredName of preferredNames) {
    if (!preferredName) continue
    const match = personas.find((persona) => persona.name === preferredName && persona.stage === stage)
    if (match) return match
  }

  if (lane) {
    const laneOwner = personas.find((persona) => persona.ownedLanes.includes(lane) && persona.stage === stage)
    if (laneOwner) return laneOwner
  }

  return store.findPersonaByStage(companyId, stage)
}

function queueWorkflowSeeds(
  targetPath: string,
  verifyCommand: string | null,
  queueValue: unknown
): QueueWorkflowSeed[] {
  if (!isRecord(queueValue) || !Array.isArray(queueValue.items)) {
    return []
  }

  const seeds: QueueWorkflowSeed[] = []
  for (const entry of queueValue.items) {
    if (!isRecord(entry)) continue

    const id = asString(entry.id)
    const title = asString(entry.title)
    const lane = asString(entry.lane)
    if (!id || !title) continue

    const status = asString(entry.status) ?? "queued"
    const category = asString(entry.category)
    const kind = asString(entry.kind)
    const source = asString(entry.source)
    if (source === "manager-project" || kind === "manager-seeded-project" || id.startsWith("manager-")) {
      continue
    }
    const priority = typeof entry.priority === "number" ? entry.priority : 0
    const requestedAdapterType = preferredAdapterForLane(lane)
    const sourceLabel = `openclaw-source:${id}`
    const labels = [
      "openclaw-import",
      "openclaw-queue",
      sourceLabel,
      lane ? `lane:${lane}` : null,
      category ? `category:${category}` : null,
      kind ? `openclaw-kind:${kind}` : null,
      surfaceLabelForLane(lane)
    ].filter((value): value is string => Boolean(value))

    const description = [
      `Imported from repo-owned OpenClaw queue item ${id}.`,
      `Legacy status: ${status}.`,
      lane ? `Lane: ${lane}.` : null,
      category ? `Category: ${category}.` : null,
      kind ? `Kind: ${kind}.` : null,
      asString(entry.progressNote),
      isRecord(entry.resumeFrom) ? `Resume task: ${asString(entry.resumeFrom.taskId) ?? "n/a"}.` : null,
      asString(entry.reviewHandoff) ? `Review handoff: ${asString(entry.reviewHandoff)}.` : null,
      asString(entry.activeBranch) ? `Branch: ${asString(entry.activeBranch)}.` : null,
      asString(entry.activeWorktree) ? `Worktree: ${asString(entry.activeWorktree)}.` : null
    ]
      .filter((value): value is string => Boolean(value))
      .join("\n")

    seeds.push({
      sourceLabel,
      title,
      description,
      labels,
      requestedAdapterType,
      priority,
      lane,
      managerPersona: null,
      taskPackage: taskPackageForSeed(targetPath, verifyCommand, {
        title,
        description,
        labels,
        requestedAdapterType
      })
    })
  }

  return seeds
}

function managerWorkflowSeeds(
  targetPath: string,
  verifyCommand: string | null,
  managerStateValue: unknown
): QueueWorkflowSeed[] {
  if (!isRecord(managerStateValue) || !Array.isArray(managerStateValue.projects)) {
    return []
  }

  const seeds: QueueWorkflowSeed[] = []
  for (const entry of managerStateValue.projects) {
    if (!isRecord(entry)) continue

    const id = asString(entry.id)
    const projectTitle = asString(entry.title)
    const seedTask = isRecord(entry.seedTask) ? entry.seedTask : null
    const seedTitle = seedTask ? asString(seedTask.title) : null
    const lane = asString(entry.lane)
    if (!id || !projectTitle || !seedTitle) continue

    const category = asString(entry.category)
    const managerPersona = asString(entry.managerPersona)
    const priority = seedTask && typeof seedTask.priority === "number" ? seedTask.priority : 0
    const requestedAdapterType = preferredAdapterForLane(lane)
    const sourceLabel = `openclaw-manager-project:${id}`
    const labels = [
      "openclaw-import",
      "openclaw-manager-project",
      sourceLabel,
      lane ? `lane:${lane}` : null,
      category ? `category:${category}` : null,
      managerPersona ? `manager:${managerPersona}` : null,
      surfaceLabelForLane(lane)
    ].filter((value): value is string => Boolean(value))

    const description = [
      `Imported from repo-owned OpenClaw manager project ${id}.`,
      `Project: ${projectTitle}.`,
      lane ? `Lane: ${lane}.` : null,
      category ? `Category: ${category}.` : null,
      managerPersona ? `Manager persona: ${managerPersona}.` : null,
      seedTask ? asString(seedTask.verificationHint) : null
    ]
      .filter((value): value is string => Boolean(value))
      .join("\n")

    seeds.push({
      sourceLabel,
      title: seedTitle,
      description,
      labels,
      requestedAdapterType,
      priority,
      lane,
      managerPersona,
      taskPackage: taskPackageForSeed(targetPath, verifyCommand, {
        title: seedTitle,
        description,
        labels,
        requestedAdapterType
      })
    })
  }

  return seeds
}

function mergeImportedWorkflow(
  store: DispatcherStore,
  projectId: string,
  companyId: string,
  seed: QueueWorkflowSeed
): SyncEntry {
  const existing = store.listProjectTasks(projectId).find((task) => task.labels.includes(seed.sourceLabel))
  if (existing) {
    return {
      name: seed.title,
      status: "kept",
      details: [`source ${seed.sourceLabel}`, `task ${existing.id}`]
    }
  }

  const plannerPersona = findPersonaForSeed(store, companyId, "planner", seed.lane, ["planner"])
  const coderPersona = findPersonaForSeed(store, companyId, "coder", seed.lane, [seed.managerPersona])
  const reviewerPersona = findPersonaForSeed(store, companyId, "reviewer", seed.lane, [
    "release-quality-reviewer",
    "reviewer"
  ])
  const profile = resolveProjectProfile(store.getProjectById(projectId).repoPath)
  const promoterPersona = findPersonaForSeed(
    store,
    companyId,
    "promoter",
    seed.lane,
    profile?.promotionPolicy.importPersonaNames ?? ["promoter"]
  )

  const workflow = store.createWorkflow({
    projectRef: projectId,
    title: seed.title,
    description: seed.description
  })

  const planTask = store.createTask({
    projectRef: projectId,
    workflowId: workflow.id,
    personaRef: plannerPersona?.id ?? null,
    stage: "planner",
    kind: "plan",
    priority: seed.priority,
    title: `Plan: ${seed.title}`,
    description: seed.description,
    labels: seed.labels,
    taskPackage: seed.taskPackage,
    source: "automation",
    maxRetries: 1
  })
  store.updateWorkflow(workflow.id, { rootTaskId: planTask.id })

  const implementTask = store.createTask({
    projectRef: projectId,
    workflowId: workflow.id,
    personaRef: coderPersona?.id ?? null,
    stage: "coder",
    kind: "implement",
    priority: seed.priority,
    dependsOnTaskIds: [planTask.id],
    title: `Implement: ${seed.title}`,
    description: seed.description,
    labels: seed.labels,
    taskPackage: seed.taskPackage,
    source: "automation",
    requestedAdapterType: seed.requestedAdapterType,
    maxRetries: 1
  })

  const reviewTask = store.createTask({
    projectRef: projectId,
    workflowId: workflow.id,
    personaRef: reviewerPersona?.id ?? null,
    stage: "reviewer",
    kind: "review",
    priority: seed.priority,
    dependsOnTaskIds: [implementTask.id],
    title: `Review: ${seed.title}`,
    description: seed.description,
    labels: Array.from(new Set([...seed.labels, "review"])),
    taskPackage: seed.taskPackage,
    source: "automation",
    requestedAdapterType: "codex_local",
    maxRetries: 0
  })

  store.createTask({
    projectRef: projectId,
    workflowId: workflow.id,
    personaRef: promoterPersona?.id ?? null,
    stage: "promoter",
    kind: "promote",
    priority: seed.priority,
    dependsOnTaskIds: [reviewTask.id],
    title: `Promote: ${seed.title}`,
    description: seed.description,
    labels: Array.from(new Set([...seed.labels, "promotion"])),
    taskPackage: seed.taskPackage,
    source: "automation",
    requestedAdapterType: "codex_local",
    maxRetries: 2
  })

  return {
    name: seed.title,
    status: "created",
    details: [`source ${seed.sourceLabel}`, `workflow ${workflow.id}`]
  }
}

function readJobCandidates(targetPath: string, warnings: string[], sources: Set<string>): JobSpecCandidate[] {
  const jobsDir = filePath(targetPath, ".openclaw/jobs")
  if (!existsSync(jobsDir)) return []

  const candidates: JobSpecCandidate[] = []
  for (const entry of readdirSync(jobsDir)
    .filter((name) => name.endsWith(".json"))
    .sort()) {
    const sourcePath = `.openclaw/jobs/${entry}`
    const value = readJson(targetPath, sourcePath, warnings)
    if (!value || !isRecord(value)) continue

    sources.add(sourcePath)

    if (!isSupportedJobId(value.id)) {
      warnings.push(`${sourcePath}: unsupported job id ${String(value.id ?? "unknown")}`)
      continue
    }

    const schedule = isRecord(value.schedule) ? value.schedule : null
    const cron = asString(schedule?.cron) ?? asString(value.cron)
    const timezone = asString(schedule?.timezone) ?? asString(value.timezone)
    if (!cron || !timezone) {
      warnings.push(`${sourcePath}: expected schedule.cron and schedule.timezone`)
      continue
    }

    candidates.push({
      jobId: value.id,
      sourcePath,
      cron,
      timezone,
      entryAgent: asString(value.entry_agent) ?? asString(value.entryAgent)
    })
  }

  return candidates
}

function mergeJobSpec(
  store: DispatcherStore,
  companyId: string,
  projectId: string,
  candidate: JobSpecCandidate
): SyncEntry {
  const existing = store.findJobSpec(projectId, candidate.jobId)
  if (!existing) {
    store.upsertJobSpec({
      companyId,
      projectId,
      jobId: candidate.jobId,
      sourcePath: candidate.sourcePath,
      cron: candidate.cron,
      timezone: candidate.timezone,
      entryAgent: candidate.entryAgent
    })
    return {
      name: candidate.jobId,
      status: "created",
      details: [`schedule ${candidate.cron} (${candidate.timezone})`]
    }
  }

  const details: string[] = []
  const changed =
    existing.sourcePath !== candidate.sourcePath ||
    existing.cron !== candidate.cron ||
    existing.timezone !== candidate.timezone ||
    existing.entryAgent !== candidate.entryAgent

  if (changed) {
    store.upsertJobSpec({
      companyId,
      projectId,
      jobId: candidate.jobId,
      sourcePath: candidate.sourcePath,
      cron: candidate.cron,
      timezone: candidate.timezone,
      entryAgent: candidate.entryAgent
    })

    if (existing.cron !== candidate.cron || existing.timezone !== candidate.timezone) {
      details.push(`updated schedule to ${candidate.cron} (${candidate.timezone})`)
    }
    if (existing.entryAgent !== candidate.entryAgent) {
      details.push(`entry agent ${candidate.entryAgent ?? "unset"}`)
    }
    if (existing.sourcePath !== candidate.sourcePath) {
      details.push(`source ${candidate.sourcePath}`)
    }
    return {
      name: candidate.jobId,
      status: "updated",
      details
    }
  }

  return {
    name: candidate.jobId,
    status: "kept",
    details: [`schedule ${candidate.cron} (${candidate.timezone})`]
  }
}

export function syncRepoOwnedOpenclaw(options: SyncOptions): SyncSummary {
  const targetPath = resolve(options.targetPath)
  const openclawDir = filePath(targetPath, ".openclaw")
  if (!existsSync(openclawDir)) {
    throw new Error(`No repo-owned .openclaw directory found at ${openclawDir}`)
  }

  const warnings: string[] = []
  const skipped: string[] = []
  const unmapped: string[] = []
  const workflowImports: SyncEntry[] = []
  const sources = new Set<string>()
  const agentCandidates = new Map<string, AgentCandidate>()
  const routingRuleCandidates = new Map<string, RoutingRuleCandidate>()
  const jobCandidates = readJobCandidates(targetPath, warnings, sources)
  let managerStateValue: unknown = null

  for (const candidate of getPromptCandidates(targetPath)) {
    mergeAgentCandidate(agentCandidates, candidate.name, candidate, ".openclaw/agents/")
    sources.add(".openclaw/agents/")
  }

  const controlPlane = readJson(targetPath, ".openclaw/control-plane.json", warnings)
  if (controlPlane !== null) {
    sources.add(".openclaw/control-plane.json")
    for (const source of extractControlPlaneAgents(controlPlane, agentCandidates, routingRuleCandidates)) {
      sources.add(source)
    }
  }

  const runtime = readPreferredJson(
    targetPath,
    [".openclaw/state/current/runtime.json", ".openclaw/state/bootstrap/runtime.json"],
    warnings
  )
  if (runtime) {
    sources.add(runtime.path)
    extractRuntimeAgents(runtime.value, agentCandidates, runtime.path)
  }

  const categories = readPreferredJson(
    targetPath,
    [".openclaw/state/current/categories.json", ".openclaw/state/bootstrap/categories.json"],
    warnings
  )
  if (categories) {
    sources.add(categories.path)
    extractCategoryRules(categories.value, categories.path, routingRuleCandidates)
  }

  const queue = readPreferredJson(
    targetPath,
    [".openclaw/state/current/queue.json", ".openclaw/state/bootstrap/queue.json"],
    warnings
  )
  if (queue) {
    sources.add(queue.path)
    extractQueueRules(queue.value, queue.path, routingRuleCandidates)
  }

  const managerState = readPreferredJson(
    targetPath,
    [".openclaw/state/current/manager_state.json", ".openclaw/state/bootstrap/manager_state.json"],
    warnings
  )
  if (managerState) {
    sources.add(managerState.path)
    extractManagerRules(managerState.value, managerState.path, routingRuleCandidates)
    managerStateValue = managerState.value
  }

  const profile = readPreferredJson(targetPath, [".openclaw/profile.json"], warnings)
  if (profile) {
    sources.add(profile.path)
  }
  const repoHealthLane = profile ? repoHealthLaneFromProfile(profile.value) : null

  const projectName =
    options.projectName?.trim() ||
    (isRecord(controlPlane)
      ? asString(controlPlane.projectName ?? (isRecord(controlPlane.project) ? controlPlane.project.name : null))
      : null) ||
    (runtime && isRecord(runtime.value) ? asString(runtime.value.project) : null) ||
    basename(targetPath)

  const companyName =
    options.companyName?.trim() ||
    (isRecord(controlPlane)
      ? asString(controlPlane.companyName ?? (isRecord(controlPlane.company) ? controlPlane.company.name : null))
      : null) ||
    `${projectName} Company`

  const verifyCommand =
    options.verifyCommand ??
    (isRecord(controlPlane)
      ? asString(
          controlPlane.verifyCommand ??
            (isRecord(controlPlane.project) ? controlPlane.project.verifyCommand : null) ??
            (isRecord(controlPlane.verification) ? controlPlane.verification.command : null)
        )
      : null)

  const company = mergeCompany(options.store, companyName)
  const project = mergeProject(options.store, company.id, targetPath, projectName, verifyCommand)

  const agents = Array.from(agentCandidates.values())
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((candidate) => mergeAgent(options.store, company.id, candidate, skipped))

  const personas = buildPersonaCandidates(agentCandidates, managerStateValue).map((candidate) =>
    mergePersona(options.store, company.id, candidate, skipped)
  )

  const jobs = jobCandidates
    .sort((left, right) => left.jobId.localeCompare(right.jobId))
    .map((candidate) => mergeJobSpec(options.store, company.id, project.id, candidate))

  const automations = jobCandidates
    .map((candidate) => ({
      name: candidate.jobId,
      kind: automationKindForJob(candidate.jobId),
      cron: candidate.cron,
      sourceProjectRef: project.id,
      payload: {
        projectRef: project.id,
        ...(automationKindForJob(candidate.jobId) === "repo_health" && repoHealthLane ? { laneId: repoHealthLane } : {})
      }
    }))
    .map((candidate) => mergeAutomation(options.store, company.id, project.id, candidate))

  const routingRules = Array.from(routingRuleCandidates.values())
    .sort((left, right) => right.priority - left.priority || left.name.localeCompare(right.name))
    .map((candidate) => mergeRoutingRule(options.store, candidate, skipped))

  if (queue) {
    for (const seed of queueWorkflowSeeds(targetPath, verifyCommand, queue.value)) {
      workflowImports.push(mergeImportedWorkflow(options.store, project.id, company.id, seed))
    }
  }

  if (managerStateValue !== null) {
    for (const seed of managerWorkflowSeeds(targetPath, verifyCommand, managerStateValue)) {
      workflowImports.push(mergeImportedWorkflow(options.store, project.id, company.id, seed))
    }
  }

  return {
    targetPath,
    dbPath: options.store.dbPath,
    company,
    project,
    agents,
    personas,
    jobs,
    automations,
    routingRules,
    workflows: workflowImports,
    sources: Array.from(sources).sort(),
    skipped,
    unmapped,
    warnings
  }
}
