import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { DispatcherStore } from "@openclaw/db"
import type {
  AdapterDefinition,
  Agent,
  Automation,
  CodexQuotaOverview,
  Company,
  ModelReasoningEffort,
  PlannerCandidateTask,
  PlannerDecision,
  PlannerOutputEnvelope,
  PlannerRunSummary,
  Project,
  RepoPlanningSnapshot,
  Task,
  TaskPortfolioBucket
} from "@openclaw/domain"
import { readCodexQuotaOverview } from "@openclaw/domain"
import type { ProjectProfile } from "@openclaw/project-profiles"

import { dedupePlannerCandidates } from "./dedupe.js"
import { materializePlannerTasks } from "./materialize.js"
import { ideatePlannerCandidatePrompts } from "./promptify.js"
import { filterPlannerCandidatesForFeaturePolicy, parsePlannerOutput, validatePlannerCandidates } from "./validate.js"

function defaultOwnerProcessIsAlive(pid: number): boolean {
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function recoverDeadPlannerOwnerRuns(input: {
  store: DispatcherStore
  projectId: string
  ownerProcessIsAlive?: (pid: number) => boolean
}): string[] {
  const ownerProcessIsAlive = input.ownerProcessIsAlive ?? defaultOwnerProcessIsAlive
  const recovered: string[] = []

  for (const run of input.store.listRunningPlannerRuns(input.projectId)) {
    const started = input.store
      .getPlannerEvents(run.id)
      .find((event) => event.kind === "planner-run-started" && Number.isInteger(event.data?.ownerPid))
    const ownerPid = started?.data?.ownerPid
    if (typeof ownerPid !== "number" || ownerProcessIsAlive(ownerPid)) continue

    const finishedAt = new Date().toISOString()
    input.store.updatePlannerRun(run.id, {
      status: "failed",
      errorText: `Recovered planner run after owner process ${ownerPid} exited without completing it.`,
      finishedAt
    })
    input.store.appendPlannerEvent(
      run.id,
      "planner-run-owner-recovered",
      "Recovered planner run whose owning dispatcher process no longer exists.",
      {
        ownerPid,
        recoveredByPid: process.pid,
        finishedAt
      }
    )
    recovered.push(run.id)
  }

  return recovered
}

function plannerLaneIds(profile: ProjectProfile): string[] {
  return Array.from(new Set([...profile.planner.allowedLanes, ...profile.laneDefinitions.map((lane) => lane.laneId)]))
}

function plannerPromptPath(project: Project): string {
  return join(project.repoPath, ".openclaw", "planner", "planner.prompt.md")
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true })
}

function artifactPath(project: Project, profile: ProjectProfile, plannerRunId: string, name: string): string {
  const root =
    profile.planner.artifactPolicy.plannerRunsDir ?? join(profile.artifactPolicy.runtimeStateDir, "planner-runs")
  return join(project.repoPath, root, plannerRunId, name)
}

function writeArtifact(
  store: DispatcherStore,
  plannerRunId: string,
  project: Project,
  profile: ProjectProfile,
  kind: "snapshot" | "brief" | "output" | "orchestration_log" | "events",
  name: string,
  content: string
): string {
  const path = artifactPath(project, profile, plannerRunId, name)
  ensureDir(dirname(path))
  writeFileSync(path, content, "utf8")
  store.addPlannerArtifact({ plannerRunId, projectId: project.id, kind, path })
  return path
}

function defaultPlannerDirective(profile: ProjectProfile): string {
  return [
    "# OpenClaw Planner Prompt",
    "",
    "Emit valid planner JSON only. Do not include markdown fences, prose, queueActions, plannedTask, reviewTask, or policy-only documents.",
    "The top-level object must contain `version: 1` and a `candidates` array. Use an empty candidates array when no safe new work should be created.",
    "",
    "Allowed lanes:",
    ...plannerLaneIds(profile).map((lane) => `- ${lane}`),
    "",
    "Expected shape:",
    "{",
    '  "version": 1,',
    '  "summary": "short planner summary",',
    '  "candidates": [',
    "    {",
    '      "title": "Task title",',
    '      "description": "Why this work matters now",',
    '      "kind": "implement",',
    '      "lane": "lane-id",',
    '      "personaId": "backend-engineer",',
    '      "portfolioBucket": "backend_api",',
    '      "userOutcome": "short user or operator outcome",',
    '      "acceptanceCriteria": ["observable done criterion"],',
    '      "taskSourceIntent": "persona_ideation",',
    '      "preferredAdapterType": "codex_local",',
    '      "priority": 60,',
    '      "requiredReading": ["README.md"],',
    '      "verificationChecklist": ["pnpm test"],',
    '      "contractUpdateReminders": [],',
    '      "repoNotes": [],',
    '      "dependencies": [],',
    '      "tags": ["planner-generated"],',
    '      "riskLevel": "medium",',
    '      "governanceClass": "normal",',
    '      "dedupeKey": "stable-dedupe-key",',
    '      "sourceSignals": ["changed:src/app.ts"],',
    '      "estimatedCost": 1,',
    '      "createMode": "queue_now"',
    "    }",
    "  ]",
    "}"
  ].join("\n")
}

function plannerPrompt(input: {
  project: Project
  profile: ProjectProfile
  snapshot: RepoPlanningSnapshot
  queueSummary: string[]
  budgetSummary: string[]
  quota: CodexQuotaOverview | null
  capacity: PlannerCapacityPlan
  personaHistorySummary: string[]
}): string {
  const promptFile = plannerPromptPath(input.project)
  const plannerDirective = existsSync(promptFile)
    ? readFileSync(promptFile, "utf8")
    : defaultPlannerDirective(input.profile)
  const laneStats = input.snapshot.laneOutcomeStats ?? []
  const laneProposals = input.snapshot.laneProposals ?? []
  return [
    plannerDirective.trim(),
    "",
    "Queue summary:",
    ...input.queueSummary.map((line) => `- ${line}`),
    "",
    "Persona ideation roster:",
    ...personaIdeationSummary(input.profile).map((line) => `- ${line}`),
    "",
    "Portfolio mix:",
    ...portfolioMixSummary(input.profile).map((line) => `- ${line}`),
    "",
    "Recent persona coverage (lowest normalized utilization should be preferred):",
    ...input.personaHistorySummary.map((line) => `- ${line}`),
    "",
    "Framework inspiration backlog:",
    ...orchestrationInspirationSummary().map((line) => `- ${line}`),
    "",
    "Dependency graph rules:",
    "- Keep independent candidates dependency-free so the executor can run them in parallel.",
    "- When one candidate requires another candidate's merged code, list the prerequisite candidate's dedupeKey in dependencies.",
    "- Dependency keys must reference candidates in this output and must form an acyclic graph.",
    `- Cross-lane dependencies are ${input.profile.planner.governance.allowCrossLaneDependencies ? "allowed" : "disabled"} by profile policy.`,
    "",
    "Persona ideation rules:",
    "- Each queue-refresh is an active persona-led repo-search pass for features, improvements, bugs, missing tests, UX gaps, domain workflow gaps, and operational reliability issues.",
    "- Every persona must search or inspect its owned repository surfaces before proposing work. Use laneInventory, laneHotspots, todoFixmeHits, staleTasks, promotionBlockers, directives, and verificationCommands as evidence.",
    "- Every candidate must cite repo-search evidence in `sourceSignals`, `requiredReading`, or `repoNotes`; do not invent work without a concrete repository signal.",
    "- Rotate coverage across the persona roster over time so legal/domain personas and engineering/design personas all contribute dispatchable ideas.",
    "- Prefer the lowest-utilization compatible personas from the recent coverage list. Do not assign two candidates in one run to the same persona while another compatible persona is underrepresented.",
    "- Respect the portfolio mix. If recent work is dominated by regression tests, create more product/domain/UX/backend feature slices with concrete repo evidence.",
    "- When the queue has no runnable queued tasks or only blocked/failed baseline work, use the persona roster to ideate fresh vertical feature-slice coding tasks instead of requeueing blocked tasks.",
    "- Assign each candidate to the personaId best suited to the lane and user value. Prefer domain personas for legal/user-facing workflows and engineering personas for implementation/runtime work.",
    "- Create real user-facing or operator-facing feature slices, not cosmetic patchlets. A good candidate includes implementation, tests, and contract/docs updates when the slice needs them.",
    "- Do not emit test-only, witness-only, or cosmetic titles such as `Add ... unit tests`, `Add ... regression`, `Add contract witness ...`, `Cover ... encoding`, `Add helper text ...`, or `Show ... labels`.",
    "- Tests, contract checks, and docs are acceptance evidence for the feature slice; they are not the feature by themselves.",
    "- Keep each feature slice independently reviewable with explicit scope, required reading, and verification. Avoid broad repo-health sweeps.",
    "- Prefer inspiration backlog ideas only when they map to concrete repository evidence and can be validated by a targeted command or artifact.",
    "- Do not create candidates that retry a blocked task title unless the candidate directly fixes the concrete verification failure named in that blocker.",
    "- Populate `implementationPrompt` as a coding-phase execution contract: persona lens, verified repo evidence, required reading, target boundaries, invariants/non-goals, acceptance criteria, verification, and completion cleanup.",
    "- The promptify stage will enrich that contract with the selected persona's mission and success signals; keep model-proposed implementation details concrete and repo-grounded.",
    "- Use a three-lens ideation pass before proposing each candidate: a domain advocate for user/legal value, a skeptical maintainer for coupling and recovery risks, and a verification architect for focused evidence.",
    "- First develop distinct alternatives from underrepresented persona perspectives; then compare user value, repository evidence, implementation complexity, dependencies, and recovery risk. Select the strongest bounded slice, not a concatenation of every idea.",
    "- Record the rejected alternative and the decisive repository evidence in repoNotes. Distinguish observed behavior from hypotheses; unsupported hypotheses become research questions, not implementation claims.",
    "- Have the skeptical maintainer challenge duplicate or already-shipped behavior and identify an invariant that must survive. Have the verification architect specify a before/after acceptance observation and a focused verification command.",
    "- Estimate implementation complexity separately from importance: a valuable one-file fix can be simple; cross-layer state, ambiguous ownership, migrations, and unresolved evidence make a task complex. Do not inflate scores because the prompt or acceptance checklist is long.",
    "- Stop after the best candidates within capacity are supported. Return fewer candidates when evidence is weak; do not manufacture work to fill the quota.",
    "- Verification must be proportional: propose focused tests first and add broad builds, browser suites, OpenAPI, or contract sweeps only when the candidate changes those surfaces. Do not use unrelated baseline suites as acceptance criteria.",
    "",
    "Budget summary:",
    ...input.budgetSummary.map((line) => `- ${line}`),
    "",
    "",
    "Planner capacity:",
    `- quota assessment: ${input.capacity.quotaAssessment}`,
    `- active queued/running coding tasks: ${input.capacity.activeTaskCount}`,
    `- codex parallelism target: ${input.capacity.codexParallelism}`,
    `- queue depth multiplier: ${input.capacity.queueDepthMultiplier}`,
    `- target active queue depth: ${input.capacity.targetQueueDepth}`,
    `- open task slots: ${input.capacity.availableTaskSlots}`,
    `- candidate limit for this planner run: ${input.capacity.maxTasks}`,
    `- reason: ${input.capacity.reason}`,
    `- Create at most ${input.capacity.maxTasks} candidate${input.capacity.maxTasks === 1 ? "" : "s"} in this response; return an empty candidates array when the candidate limit is 0.`,
    "",
    "Lane track record (from the outcome ledger — prefer healthy lanes, fix or avoid failing ones):",
    ...(laneStats.length > 0
      ? laneStats.map(
          (stat) =>
            `- ${stat.laneId}: ${Math.round(stat.successRate * 100)}% success over ${stat.total} outcomes ` +
            `(rejected=${stat.rejected}, blocked=${stat.blocked}, avgRetries=${stat.avgRetries})`
        )
      : ["- No outcome history yet."]),
    "",
    "Lane proposals (advisory — surface as tasks for review, never auto-apply):",
    ...(laneProposals.length > 0
      ? laneProposals.map((proposal) => `- [${proposal.recommendedAction}] ${proposal.laneId}: ${proposal.reason}`)
      : ["- None."]),
    "",
    "Codex quota:",
    JSON.stringify(
      input.quota
        ? {
            assessment: input.quota.assessment,
            availableAccounts: input.quota.availableAccounts,
            recommendedMaxConcurrentCodexRuns: input.quota.recommendedMaxConcurrentCodexRuns,
            bestAccount: input.quota.bestAccount
          }
        : null,
      null,
      2
    ),
    "",
    "Planning snapshot JSON:",
    JSON.stringify(input.snapshot, null, 2)
  ].join("\n")
}

function plannerBudgetSummary(store: DispatcherStore, company: Company): string[] {
  return store.getBudgetStatuses(company.id).map((status) => {
    const remaining = status.remainingUnits === null ? "unlimited" : String(status.remainingUnits)
    return `${status.agent.name}: used=${status.usageUnits}, remaining=${remaining}, blocked=${status.blocked}`
  })
}

function plannerQueueSummary(store: DispatcherStore, project: Project): string[] {
  return store
    .listProjectTasks(project.id)
    .slice(-20)
    .map((task) => `${task.status} | ${task.kind} | ${task.laneId ?? "none"} | ${task.title}`)
}

function personaIdeationSummary(profile: ProjectProfile): string[] {
  return profile.managerStateDefaults.managerPersonas.map((persona) => {
    const lanes = persona.ownedLaneIds.length > 0 ? persona.ownedLaneIds.join(", ") : "any allowed lane"
    return `${persona.id}: role=${persona.roleClass ?? "unspecified"}; weight=${persona.taskQuotaWeight ?? 1}; focus=${persona.focus}; lanes=${lanes}; adapter=${persona.preferredAdapterType ?? "profile default"}; search=inspect owned lane files, hotspots, TODOs, contracts, tests, and workflow screens before proposing work; prompt=${persona.ideationPrompt ?? "use focus"}`
  })
}

function plannerPersonaHistory(
  store: DispatcherStore,
  project: Project,
  profile: ProjectProfile,
  limit = 60
): { counts: Record<string, number>; summary: string[] } {
  const counts: Record<string, number> = {}
  const tasks = store
    .listProjectTasks(project.id)
    .filter((task) => task.labels.includes("planner-generated"))
    .slice(-Math.max(1, limit))
  for (const task of tasks) {
    const personaId = task.taskPackage?.personaProvenance?.personaId
    if (personaId) counts[personaId] = (counts[personaId] ?? 0) + 1
  }
  const summary = profile.managerStateDefaults.managerPersonas
    .map((persona) => {
      const count = counts[persona.id] ?? 0
      const weight = Math.max(1, persona.taskQuotaWeight ?? 1)
      return { id: persona.id, count, weight, utilization: count / weight }
    })
    .sort(
      (left, right) =>
        left.utilization - right.utilization || right.weight - left.weight || left.id.localeCompare(right.id)
    )
    .map(
      (entry) =>
        `${entry.id}: recent=${entry.count}; weight=${entry.weight}; normalized=${entry.utilization.toFixed(2)}`
    )
  return { counts, summary }
}

function portfolioMixSummary(profile: ProjectProfile): string[] {
  if (!profile.planner.portfolioMix?.length) {
    return ["no portfolio mix configured; use lane defaults and keep persona distribution balanced"]
  }
  return profile.planner.portfolioMix.map((bucket) => {
    const min = bucket.minPerRun === undefined ? "" : `; minPerRun=${bucket.minPerRun}`
    return `${bucket.bucket}: weight=${bucket.weight}${min}; personas=${bucket.personas.join(", ")}; lanes=${bucket.lanes.join(", ")}`
  })
}

function orchestrationInspirationSummary(): string[] {
  return [
    "capability-witness: maintain machine-readable capability or fix manifests with semantic markers so drift can be verified without rerunning ideation.",
    "checkpoint-hooks: prefer pre-task and post-task checkpoints that record input, outcome, verification, and reusable learning signals.",
    "topology-aware-dispatch: model larger work as hierarchical, pipeline, or mesh coordination with explicit dependency levels instead of broad one-agent tasks.",
    "adaptive-routing: route deterministic or low-risk edits to cheap/local automation and reserve scarce LLM lanes for high-uncertainty work.",
    "release-witness: publish releases with target commit, verification commands, queue state, and rollback evidence rather than only a tag."
  ]
}

function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function plannerModelIsCompatible(agent: Agent, model: string): boolean {
  const normalized = model.trim().toLowerCase()
  if (!normalized) return true
  if (agent.adapterType === "codex_local") return /^(gpt-|o[0-9]|codex)/.test(normalized)
  if (agent.adapterType === "gemini_local") return normalized.includes("gemini") || normalized.startsWith("opencode/")
  if (agent.adapterType === "azure_foundry") return normalized === agent.model?.trim().toLowerCase()
  return true
}

export function plannerComplexity(snapshot: RepoPlanningSnapshot): number {
  // Repository breadth and unresolved decisions drive planning effort, not prompt length.
  return Math.min(
    100,
    40 +
      Math.min(25, snapshot.changedFiles.length * 2) +
      Math.min(15, snapshot.laneHotspots.length * 3) +
      Math.min(10, snapshot.staleTasks.length * 2) +
      Math.min(10, snapshot.directives.length * 2)
  )
}

export function resolvePlannerExecutionAgent(profile: ProjectProfile, plannerAgent: Agent, complexity = 80): Agent {
  const pinnedGeminiModel =
    plannerAgent.adapterType === "gemini_local" ? plannerAgent.env.OPENCLAW_GEMINI_ACPX_MODEL?.trim() || null : null
  if (pinnedGeminiModel) {
    return { ...plannerAgent, model: pinnedGeminiModel }
  }

  const preferredPlannerModel = profile.planner.costPolicy.preferredPlannerModel?.trim() || null
  if (preferredPlannerModel === "auto" && plannerAgent.adapterType === "codex_local") {
    return {
      ...plannerAgent,
      model: complexity >= 90 ? "gpt-6-astra" : complexity >= 70 ? "gpt-5.6-sol" : "gpt-5.6-terra"
    }
  }
  if (preferredPlannerModel && plannerModelIsCompatible(plannerAgent, preferredPlannerModel)) {
    return { ...plannerAgent, model: preferredPlannerModel }
  }
  return plannerAgent
}

function isPlannerCodingTask(task: Task): boolean {
  return task.kind === "implement" || task.kind === "repair" || task.kind === "fix_review_feedback"
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 96) || "task"
  )
}

function fallbackDedupeKey(input: {
  projectId: string
  personaId: string
  lane: string
  evidenceSignal: string
}): string {
  const evidenceHash = createHash("sha256")
    .update(`${input.projectId}:${input.personaId}:${input.lane}:${input.evidenceSignal}`)
    .digest("hex")
    .slice(0, 12)
  const owner = slug(`${input.personaId}:${input.lane}`).slice(0, 64)
  return `fallback:${owner}:${evidenceHash}`
}

function defaultPortfolioBucketForPersona(profile: ProjectProfile, personaId: string): TaskPortfolioBucket {
  for (const bucket of profile.planner.portfolioMix ?? []) {
    if (bucket.personas.includes(personaId)) return bucket.bucket
  }
  return "backend_api"
}

type FallbackEvidence = {
  signal: string
  reading: string[]
  title: string
  objective: string
  userOutcome: string
  repoNotes: string[]
}

function readableSurface(path: string): string {
  const fileName = path.split("/").at(-1) ?? path
  const stem = fileName.replace(/\.[^.]+$/, "").replace(/^_+|_+$/g, "")
  return (stem || fileName).replace(/[-_]+/g, " ")
}

function readableLane(laneId: string): string {
  return laneId.replace(/[-_]+/g, " ")
}

function fallbackInventoryPaths(snapshot: RepoPlanningSnapshot, laneId: string): string[] {
  const inventory = snapshot.laneInventory.find((lane) => lane.laneId === laneId)
  if (!inventory) return []
  const preferred = inventory.sampleFiles.filter(
    (path) => !/(?:^|\/)(?:__init__\.py|README\.md)$/i.test(path) && !/\.(?:test|spec)\.[^.]+$/i.test(path)
  )
  return preferred.length > 0 ? preferred : inventory.sampleFiles
}

function fallbackInventoryReading(snapshot: RepoPlanningSnapshot, laneId: string): string[] {
  return fallbackInventoryPaths(snapshot, laneId).slice(0, 3)
}

function fallbackSignal(
  snapshot: RepoPlanningSnapshot,
  laneId: string,
  excludedSignals: ReadonlySet<string>
): FallbackEvidence | null {
  const isAvailable = (signal: string): boolean => !excludedSignals.has(signal)
  const todo = snapshot.todoFixmeHits.find(
    (hit) => hit.path && hit.laneId === laneId && isAvailable(`todo_fixme:${hit.path}:${hit.line}`)
  )
  if (todo) {
    const surface = readableSurface(todo.path)
    return {
      signal: `todo_fixme:${todo.path}:${todo.line}`,
      reading: [todo.path],
      title: `Resolve the ${surface} implementation gap`,
      objective: `Reproduce and resolve the TODO/FIXME at ${todo.path}:${todo.line} as one observable ${readableLane(laneId)} behavior improvement.`,
      userOutcome: `The ${surface} workflow no longer depends on an acknowledged incomplete implementation.`,
      repoNotes: [
        `The fallback objective is anchored to ${todo.path}:${todo.line}; do not expand into an unrelated sweep.`
      ]
    }
  }
  const staleCandidates = snapshot.staleTasks.filter(
    (task) => task.laneId === laneId && isAvailable(`stale_task:${task.id}:${task.status}`)
  )
  const stale = staleCandidates.find((task) => task.kind === "implement") ?? staleCandidates[0]
  if (stale) {
    return {
      signal: `stale_task:${stale.id}:${stale.status}`,
      reading: fallbackInventoryReading(snapshot, laneId),
      title: `Recover blocked outcome: ${stale.title}`,
      objective: [
        `Treat the ${stale.status} task "${stale.title}" (${stale.id}) as a user-outcome signal, not as permission to repeat its previous patch.`,
        "Inspect the current implementation and nearest focused tests, identify one concrete unresolved blocker, and implement the narrowest vertical fix that advances that outcome."
      ].join(" "),
      userOutcome: `The previously blocked outcome "${stale.title}" advances through a fresh, verified implementation rather than an unchanged retry.`,
      repoNotes: [
        `Derived from stale task ${stale.id}, which has remained ${stale.status}${stale.ageHours === null ? "" : ` for ${Math.round(stale.ageHours)} hours`}.`,
        "Check whether newer main-branch work already satisfies the outcome before editing."
      ]
    }
  }
  const hotspot = snapshot.laneHotspots.find((lane) => lane.laneId === laneId && lane.files.length > 0)
  if (hotspot && isAvailable(`lane_hotspot:${laneId}`)) {
    const reading = hotspot.files.slice(0, 3)
    const surface = readableSurface(reading[0]!)
    return {
      signal: `lane_hotspot:${laneId}`,
      reading,
      title: `Harden ${surface} after recent lane changes`,
      objective: `Use the recent ${laneId} hotspot at ${reading[0]} to reproduce and close one concrete behavior, recovery, or contract gap in that changed surface.`,
      userOutcome: `The recently changed ${surface} path has a demonstrated failure boundary covered by implementation and focused verification.`,
      repoNotes: [`The fallback objective is grounded in a recent lane hotspot; start at ${reading[0]}.`]
    }
  }
  const inventoryPaths = fallbackInventoryPaths(snapshot, laneId)
  for (let index = 0; index < inventoryPaths.length; index += 1) {
    const anchor = inventoryPaths[index]!
    const signal = `lane_inventory:${laneId}:${anchor}`
    if (!isAvailable(signal)) continue
    const reading = [anchor, ...inventoryPaths.slice(index + 1), ...inventoryPaths.slice(0, index)].slice(0, 3)
    const surface = readableSurface(anchor)
    return {
      signal,
      reading,
      title: `Prove and close one ${surface} boundary gap`,
      objective: `Inspect ${reading.join(", ")} and their nearest focused tests to demonstrate one currently unhandled ${readableLane(laneId)} input, state-transition, recovery, or contract boundary, then implement only that verified gap.`,
      userOutcome: `A demonstrated ${surface} boundary now fails safely or completes predictably for users and operators.`,
      repoNotes: [
        "Lane inventory is passive evidence, so a reproducible failing case is required before implementation.",
        `Keep the first inspection pass anchored to ${reading.join(", ")}.`
      ]
    }
  }
  const profileSignal = `profile_lane:${laneId}`
  if (!isAvailable(profileSignal)) return null
  return {
    signal: profileSignal,
    reading: [],
    title: `Prove and close one ${readableLane(laneId)} boundary gap`,
    objective: `Inspect the ${readableLane(laneId)} implementation and nearest focused tests to demonstrate one currently unhandled input, state-transition, recovery, or contract boundary, then implement only that verified gap.`,
    userOutcome: `One demonstrated ${readableLane(laneId)} failure boundary now behaves predictably for users or operators.`,
    repoNotes: ["No file-level signal was available; do not edit until a reproducible current-code gap is identified."]
  }
}

export function deterministicFallbackPlannerCandidates(input: {
  profile: ProjectProfile
  snapshot: RepoPlanningSnapshot
  maxTasks: number
  recentPersonaCounts?: Record<string, number>
  excludeCandidate?: (candidate: PlannerCandidateTask) => boolean
}): PlannerCandidateTask[] {
  if (input.maxTasks <= 0) return []
  const buckets = [...(input.profile.planner.portfolioMix ?? [])].sort((left, right) => {
    const leftMin = left.minPerRun ?? 0
    const rightMin = right.minPerRun ?? 0
    return rightMin - leftMin || right.weight - left.weight
  })
  const personas = input.profile.managerStateDefaults.managerPersonas
  const fallbackBucket = input.profile.planner.portfolioMix?.[0]
  const fallbackPersonaId = fallbackBucket?.personas[0] ?? personas[0]?.id ?? null
  const fallbackLane =
    fallbackBucket?.lanes[0] ?? input.profile.planner.allowedLanes[0] ?? input.profile.laneDefinitions[0]?.laneId
  const candidateSeeds: Array<{
    personaId: string
    lane: string
    bucket?: TaskPortfolioBucket
    weight: number
    recentCount: number
  }> = []
  const seenPersonas = new Set<string>()
  for (const bucket of buckets) {
    for (const personaId of bucket.personas) {
      if (seenPersonas.has(personaId)) continue
      const persona = personas.find((entry) => entry.id === personaId)
      const lane =
        bucket.lanes.find((candidate) => persona?.ownedLaneIds.includes(candidate)) ??
        persona?.ownedLaneIds.find((candidate) => input.profile.planner.allowedLanes.includes(candidate)) ??
        bucket.lanes[0]
      if (!lane) continue
      seenPersonas.add(personaId)
      candidateSeeds.push({
        personaId,
        lane,
        bucket: bucket.bucket,
        weight: Math.max(1, persona?.taskQuotaWeight ?? bucket.weight),
        recentCount: input.recentPersonaCounts?.[personaId] ?? 0
      })
    }
  }
  const seeds = candidateSeeds.sort(
    (left, right) =>
      left.recentCount / left.weight - right.recentCount / right.weight ||
      right.weight - left.weight ||
      left.personaId.localeCompare(right.personaId)
  )
  if (seeds.length === 0 && fallbackPersonaId && fallbackLane) {
    seeds.push({
      personaId: fallbackPersonaId,
      lane: fallbackLane,
      weight: 1,
      recentCount: input.recentPersonaCounts?.[fallbackPersonaId] ?? 0,
      ...(fallbackBucket ? { bucket: fallbackBucket.bucket } : {})
    })
  }
  const claimedEvidenceSignals = new Set<string>()
  const claimedTitles = new Set<string>()
  const candidates: PlannerCandidateTask[] = []
  for (const { personaId, lane, bucket } of seeds) {
    if (candidates.length >= input.maxTasks) break
    const persona = personas.find((entry) => entry.id === personaId)
    const laneDefinition = input.profile.laneDefinitions.find((entry) => entry.laneId === lane)
    const verificationRule = input.profile.verificationRules.find(
      (entry) => entry.ruleId === laneDefinition?.verificationRuleId
    )
    const readingRule = input.profile.requiredReadingRules.find(
      (entry) => entry.ruleId === laneDefinition?.requiredReadingRuleId
    )
    while (candidates.length < input.maxTasks) {
      const evidence = fallbackSignal(input.snapshot, lane, claimedEvidenceSignals)
      if (!evidence) break
      const title = evidence.title
      const candidate: PlannerCandidateTask = {
        title,
        description: [
          `Deterministic planner fallback for ${personaId}.`,
          evidence.objective,
          persona?.focus ? `Persona focus: ${persona.focus}` : null,
          persona?.ideationPrompt ? `Persona repo-search brief: ${persona.ideationPrompt}` : null,
          "Do not add or change production dependencies merely to make verification run; use the repository's existing tooling.",
          "Do not submit formatting-only, generated-directory, environment-directory, lockfile-only, or dependency-only changes.",
          "If current main already satisfies the outcome, record the exact implementation and focused verification evidence instead of making speculative edits."
        ]
          .filter(Boolean)
          .join("\n"),
        kind: "implement",
        lane,
        personaId,
        portfolioBucket: bucket ?? defaultPortfolioBucketForPersona(input.profile, personaId),
        userOutcome: evidence.userOutcome,
        acceptanceCriteria: [
          "Focused tests must cover the concrete current-code gap and pass after the fix.",
          "The implementation resolves the selected user or operator boundary and stays scoped to the evidence signal.",
          "Tracked changes include meaningful source behavior and focused verification; they exclude generated environments and unrelated dependency or formatting churn."
        ],
        taskSourceIntent: "planner_fallback",
        preferredAdapterType: persona?.preferredAdapterType ?? laneDefinition?.preferredAdapterType ?? null,
        priority: 58,
        requiredReading: Array.from(new Set([...(readingRule?.paths ?? []), ...evidence.reading])).slice(0, 8),
        verificationChecklist: verificationRule?.commands ?? input.snapshot.verificationCommands.slice(0, 1),
        contractUpdateReminders: lane.includes("contract")
          ? ["Update API/contract fixtures when behavior changes."]
          : [],
        repoNotes: [
          "Created without rerunning ideation because the planner returned no dispatchable candidates.",
          ...evidence.repoNotes
        ],
        dependencies: [],
        tags: ["planner-generated", "persona-ideated", "deterministic-fallback"],
        riskLevel: "medium",
        governanceClass: "normal",
        dedupeKey: fallbackDedupeKey({
          projectId: input.snapshot.projectId,
          personaId,
          lane,
          evidenceSignal: evidence.signal
        }),
        sourceSignals: ["planner-fallback:no-candidates", evidence.signal],
        estimatedCost: 0,
        createMode: "queue_now"
      }
      claimedEvidenceSignals.add(evidence.signal)
      if (claimedTitles.has(title) || input.excludeCandidate?.(candidate)) {
        claimedTitles.add(title)
        continue
      }
      claimedTitles.add(title)
      candidates.push(candidate)
      break
    }
  }
  const previousCandidateByLane = new Map<string, string>()
  return candidates.map((candidate) => {
    const previousDedupeKey = previousCandidateByLane.get(candidate.lane)
    previousCandidateByLane.set(candidate.lane, candidate.dedupeKey)
    if (!previousDedupeKey) return candidate
    return {
      ...candidate,
      dependencies: Array.from(new Set([...candidate.dependencies, previousDedupeKey]))
    }
  })
}

export interface PlannerCapacityPlan {
  quotaAssessment: CodexQuotaOverview["assessment"] | "unavailable"
  activeTaskCount: number
  codexParallelism: number
  queueDepthMultiplier: number
  targetQueueDepth: number
  availableTaskSlots: number
  maxTasks: number
  candidateCap: number
  reason: string
}

export function buildPlannerCapacityPlan(input: {
  profile: ProjectProfile
  quota: CodexQuotaOverview | null
  activeTaskCount?: number | null
}): PlannerCapacityPlan {
  const activeTaskCount = Math.max(0, Math.floor(input.activeTaskCount ?? 0))
  const profileMaxTasks = Math.max(0, Math.floor(input.profile.planner.maxTasksPerRun))
  const quotaAssessment = input.quota?.assessment ?? "unavailable"

  if (profileMaxTasks === 0) {
    return {
      quotaAssessment,
      activeTaskCount,
      codexParallelism: 0,
      queueDepthMultiplier: 1,
      targetQueueDepth: 0,
      availableTaskSlots: 0,
      maxTasks: 0,
      candidateCap: 0,
      reason: "planner profile maxTasksPerRun is zero"
    }
  }

  if (input.quota?.assessment === "blocked" || input.quota?.recommendedMaxConcurrentCodexRuns === 0) {
    const fallbackPlannerAdapter = input.profile.planner.costPolicy.fallbackPlannerAdapterType
    if (fallbackPlannerAdapter && fallbackPlannerAdapter !== "codex_local") {
      const candidateCap = Math.min(profileMaxTasks, 2)
      const targetQueueDepth = Math.max(1, candidateCap)
      const availableTaskSlots = Math.max(0, targetQueueDepth - activeTaskCount)
      const maxTasks = Math.min(candidateCap, availableTaskSlots)
      return {
        quotaAssessment,
        activeTaskCount,
        codexParallelism: 0,
        queueDepthMultiplier: 1,
        targetQueueDepth,
        availableTaskSlots,
        maxTasks,
        candidateCap,
        reason: `Codex quota is blocked; planner may still seed ${fallbackPlannerAdapter} or non-Codex-routable work`
      }
    }
    return {
      quotaAssessment,
      activeTaskCount,
      codexParallelism: 0,
      queueDepthMultiplier: 1,
      targetQueueDepth: 0,
      availableTaskSlots: 0,
      maxTasks: 0,
      candidateCap: 0,
      reason: "Codex quota has no available account headroom"
    }
  }

  const configuredCodexCap = envPositiveInt("OPENCLAW_MAX_CONCURRENT_CODEX_RUNS", 0)
  const quotaRecommendedCodexCap =
    typeof input.quota?.recommendedMaxConcurrentCodexRuns === "number"
      ? input.quota.recommendedMaxConcurrentCodexRuns
      : null
  const recommendedCodexCap =
    configuredCodexCap > 0 && quotaRecommendedCodexCap !== null
      ? Math.min(configuredCodexCap, quotaRecommendedCodexCap)
      : configuredCodexCap > 0
        ? configuredCodexCap
        : quotaRecommendedCodexCap
  const codexParallelism = Math.max(1, recommendedCodexCap ?? 1)
  const queueDepthMultiplier = envPositiveInt("OPENCLAW_PLANNER_QUEUE_DEPTH_MULTIPLIER", 2)
  const candidateCap =
    input.profile.planner.costPolicy.reduceMaxTasksWhenCodexWarm && input.quota?.assessment === "degraded"
      ? Math.max(1, Math.min(profileMaxTasks, 2))
      : profileMaxTasks
  const targetQueueDepth = envPositiveInt(
    "OPENCLAW_PLANNER_TARGET_QUEUE_DEPTH",
    Math.max(1, codexParallelism * queueDepthMultiplier)
  )
  const availableTaskSlots = Math.max(0, targetQueueDepth - activeTaskCount)
  const maxTasks = Math.min(candidateCap, availableTaskSlots)

  return {
    quotaAssessment,
    activeTaskCount,
    codexParallelism,
    queueDepthMultiplier,
    targetQueueDepth,
    availableTaskSlots,
    maxTasks,
    candidateCap,
    reason:
      maxTasks > 0
        ? `queue below capacity by ${maxTasks} task${maxTasks === 1 ? "" : "s"}`
        : "active queue already meets planner capacity"
  }
}

export async function runPlannerAutomation(input: {
  store: DispatcherStore
  adapter: AdapterDefinition
  company: Company
  project: Project
  profile: ProjectProfile
  automation: Automation
  plannerAgent: Agent
  plannerPersonaId: string | null
  snapshot: RepoPlanningSnapshot
  quota?: CodexQuotaOverview | null
  activeTaskCount?: number | null
  logEvent?: (kind: string, message: string, data?: Record<string, unknown>) => void
}): Promise<{
  plannerRunId: string
  createdTaskIds: string[]
  output: PlannerOutputEnvelope | null
  summary: PlannerRunSummary
}> {
  const quota = input.quota === undefined ? readCodexQuotaOverview() : input.quota
  const capacity = buildPlannerCapacityPlan({
    profile: input.profile,
    quota,
    activeTaskCount:
      input.activeTaskCount ??
      input.store
        .listProjectTasks(input.project.id)
        .filter((task) => (task.status === "queued" || task.status === "running") && isPlannerCodingTask(task)).length
  })
  const personaHistory = plannerPersonaHistory(input.store, input.project, input.profile)
  const complexity = plannerComplexity(input.snapshot)
  const autoModel =
    input.profile.planner.costPolicy.preferredPlannerModel === "auto" &&
    input.plannerAgent.adapterType === "codex_local"
  const plannerReasoningEffort: ModelReasoningEffort = autoModel
    ? complexity >= 70
      ? "high"
      : "medium"
    : (input.profile.planner.costPolicy.plannerReasoningEffort ?? "high")
  const executionAgent = resolvePlannerExecutionAgent(input.profile, input.plannerAgent, complexity)
  recoverDeadPlannerOwnerRuns({
    store: input.store,
    projectId: input.project.id
  })
  const slot = input.store.acquirePlannerRunSlot({
    companyId: input.company.id,
    projectId: input.project.id,
    automationId: input.automation.id,
    trigger: "automation",
    plannerPersonaId: input.plannerPersonaId,
    plannerAgentId: input.plannerAgent.id,
    adapterType: input.plannerAgent.adapterType,
    snapshotJson: input.snapshot,
    activeThresholdMs: Number.parseInt(process.env.OPENCLAW_STALE_PLANNER_RUN_THRESHOLD_MS ?? "", 10) || 30 * 60 * 1000,
    repairReasonPrefix: "Recovered planner run before starting a new planner lineage"
  })
  const plannerRun = slot.plannerRun
  for (const recovered of slot.recovered) {
    input.store.appendPlannerEvent(
      recovered.plannerRunId,
      "planner-run-recovered",
      "Recovered planner run before acquiring a new planner slot.",
      {
        reason: recovered.reason,
        canonicalPlannerRunId: recovered.canonicalPlannerRunId
      }
    )
  }
  if (!slot.created) {
    input.store.appendPlannerEvent(
      plannerRun.id,
      "planner-run-reused",
      "Skipped duplicate planner creation because a planner run is already active.",
      {
        automationId: input.automation.id
      }
    )
    return {
      plannerRunId: plannerRun.id,
      createdTaskIds: [],
      output: plannerRun.outputJson,
      summary: plannerRun.summaryJson ?? {
        createdTaskIds: [],
        skippedCandidates: 0,
        blockedCandidates: 0,
        deferred: true
      }
    }
  }
  input.store.appendPlannerEvent(plannerRun.id, "planner-run-started", "Planner automation started.", {
    ownerPid: process.pid,
    automationId: input.automation.id,
    adapterType: input.plannerAgent.adapterType,
    activeTaskCount: capacity.activeTaskCount,
    targetQueueDepth: capacity.targetQueueDepth,
    availableTaskSlots: capacity.availableTaskSlots,
    maxTasks: capacity.maxTasks,
    quotaAssessment: capacity.quotaAssessment,
    model: executionAgent.model,
    reasoningEffort: plannerReasoningEffort
  })

  writeArtifact(
    input.store,
    plannerRun.id,
    input.project,
    input.profile,
    "snapshot",
    "planning-snapshot.json",
    JSON.stringify(input.snapshot, null, 2)
  )
  writeArtifact(
    input.store,
    plannerRun.id,
    input.project,
    input.profile,
    "brief",
    "planning-brief.md",
    [
      `# Planning Brief`,
      "",
      `Project: ${input.project.name}`,
      `Profile: ${input.profile.profileId}`,
      `Changed files: ${input.snapshot.changedFiles.length}`,
      `Stale tasks: ${input.snapshot.staleTasks.length}`,
      `Active task count: ${capacity.activeTaskCount}`,
      `Target queue depth: ${capacity.targetQueueDepth}`,
      `Planner candidate limit: ${capacity.maxTasks}`
    ].join("\n")
  )

  const prompt = plannerPrompt({
    project: input.project,
    profile: input.profile,
    snapshot: input.snapshot,
    queueSummary: plannerQueueSummary(input.store, input.project),
    budgetSummary: plannerBudgetSummary(input.store, input.company),
    quota,
    capacity,
    personaHistorySummary: personaHistory.summary
  })

  const fakeTask: Task = {
    id: `planner-task:${plannerRun.id}`,
    companyId: input.company.id,
    projectId: input.project.id,
    workflowId: null,
    goalId: null,
    milestoneId: null,
    parentTaskId: null,
    dependsOnTaskIds: [],
    personaId: input.plannerPersonaId,
    stage: "planner",
    title: `Planner run ${plannerRun.id}`,
    description: "Ephemeral planner execution context.",
    labels: ["planner-internal"],
    changedFiles: input.snapshot.changedFiles,
    taskPackage: null,
    kind: "plan",
    priority: capacity.maxTasks,
    scheduledAt: null,
    source: "automation",
    status: "running",
    assignedAgentId: input.plannerAgent.id,
    requestedAdapterType: input.plannerAgent.adapterType,
    laneId: null,
    allowedPaths: [],
    requiredReading: [],
    verificationCommands: [],
    claimStatus: "claimed",
    claimToken: null,
    claimExpiresAt: null,
    claimOwnerRunId: plannerRun.id,
    claimOwnerAgentId: input.plannerAgent.id,
    claimedAt: new Date().toISOString(),
    lineageRootId: null,
    lineageParentId: null,
    taskPackagePath: null,
    reviewHandoffPath: null,
    artifactDir: null,
    reviewRequired: false,
    approvalRequired: false,
    retryCount: 0,
    maxRetries: 0,
    lastError: null,
    blockedReason: null,
    lastRecoveryAt: null,
    lastRecoveryReason: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: null
  }

  const result = await input.adapter.execute({
    company: input.company,
    project: input.project,
    task: fakeTask,
    agent: executionAgent,
    prompt,
    runId: plannerRun.id,
    wakeReason: "queue_refresh",
    heartbeatJobId: "queue-refresh",
    triggeredAt: new Date().toISOString(),
    sessionKey: `planner:${plannerRun.id}`,
    sessionState: null,
    runtimeIdentity: {
      version: 1,
      runtimeKey: `planner:${plannerRun.id}`,
      executionKey: plannerRun.id,
      companyId: input.company.id,
      projectId: input.project.id,
      projectName: input.project.name,
      repoPath: input.project.repoPath,
      taskId: fakeTask.id,
      taskKind: "plan",
      taskTitle: fakeTask.title,
      workflowId: null,
      laneId: null,
      agentId: input.plannerAgent.id,
      agentName: input.plannerAgent.name,
      adapterType: input.plannerAgent.adapterType,
      model: executionAgent.model,
      routing: {
        selectedModel: executionAgent.model,
        reasoningEffort: plannerReasoningEffort,
        modelFamily: executionAgent.model ?? "planner-default",
        modelRoutingReason: autoModel
          ? `persona ideation scope complexity ${complexity}/100 selected model and effort`
          : "planner profile selected the persona ideation model and reasoning effort",
        complexityScore: 4,
        complexityScore100: complexity,
        importanceScore: 4,
        valueScore100: 85,
        complexityBand: complexity >= 90 ? "critical" : complexity >= 70 ? "high" : "medium",
        importanceBand: "high",
        domains: ["persona-ideation", "planning"],
        complexitySignals: ["multi-persona repository synthesis"],
        importanceSignals: ["autonomous queue quality"]
      },
      wake: {
        reason: "queue_refresh",
        heartbeatJobId: "queue-refresh",
        triggeredAt: new Date().toISOString()
      },
      continuation: {
        sessionKey: `planner:${plannerRun.id}`,
        sessionDisplayId: null,
        retryCount: 0,
        attempt: 1,
        heartbeatEnabled: input.plannerAgent.heartbeatEnabled,
        heartbeatIntervalSec: input.plannerAgent.heartbeatIntervalSec,
        supportsSessionResume: input.adapter.capabilities.supportsSessionResume,
        nativeContextManagement: input.adapter.capabilities.nativeContextManagement
      },
      scope: {
        allowedPaths: [],
        requiredReading: [],
        verificationCommands: []
      }
    },
    log: (level, message, data) => {
      input.store.appendPlannerEvent(plannerRun.id, `adapter:${level}`, message, data ?? null)
    }
  })
  if (!result.ok) {
    input.store.updatePlannerRun(plannerRun.id, {
      status: "failed",
      errorText: result.error ?? "Planner adapter failed",
      finishedAt: new Date().toISOString()
    })
    writeArtifact(
      input.store,
      plannerRun.id,
      input.project,
      input.profile,
      "events",
      "planning-events.ndjson",
      JSON.stringify(input.store.getPlannerEvents(plannerRun.id), null, 2)
    )
    throw new Error(result.error ?? "Planner adapter failed")
  }

  let parsed: PlannerOutputEnvelope
  let validated: ReturnType<typeof validatePlannerCandidates>
  try {
    parsed = parsePlannerOutput(result.response)
    validated = validatePlannerCandidates({
      profile: input.profile,
      candidates: parsed.candidates.slice(0, capacity.maxTasks)
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    input.store.appendPlannerEvent(plannerRun.id, "planner-output-invalid", "Planner output failed validation.", {
      error: message
    })
    writeArtifact(
      input.store,
      plannerRun.id,
      input.project,
      input.profile,
      "output",
      "planning-output.raw.txt",
      result.response
    )
    const fallbackCandidates = deterministicFallbackPlannerCandidates({
      profile: input.profile,
      snapshot: input.snapshot,
      maxTasks: capacity.maxTasks,
      recentPersonaCounts: personaHistory.counts
    })
    try {
      validated = validatePlannerCandidates({
        profile: input.profile,
        candidates: fallbackCandidates
      })
      parsed = {
        version: 1,
        summary: "Planner output was invalid; deterministic repo-evidenced candidates were substituted.",
        candidates: fallbackCandidates
      }
      input.store.appendPlannerEvent(
        plannerRun.id,
        "planner-invalid-output-recovered",
        "Planner output was invalid; deterministic repo-evidenced candidates kept the coding queue moving.",
        {
          error: message,
          candidates: validated.length
        }
      )
    } catch (fallbackError) {
      const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
      input.store.updatePlannerRun(plannerRun.id, {
        status: "failed",
        errorText: fallbackMessage,
        finishedAt: new Date().toISOString()
      })
      writeArtifact(
        input.store,
        plannerRun.id,
        input.project,
        input.profile,
        "events",
        "planning-events.ndjson",
        JSON.stringify(input.store.getPlannerEvents(plannerRun.id), null, 2)
      )
      throw new Error(fallbackMessage)
    }
  }
  if (validated.length === 0 && capacity.maxTasks > 0) {
    validated = validatePlannerCandidates({
      profile: input.profile,
      candidates: deterministicFallbackPlannerCandidates({
        profile: input.profile,
        snapshot: input.snapshot,
        maxTasks: capacity.maxTasks,
        recentPersonaCounts: personaHistory.counts
      })
    })
    input.store.appendPlannerEvent(
      plannerRun.id,
      "planner-fallback-candidates",
      "Planner returned no dispatchable candidates; deterministic persona fallback seeded a repo-evidenced feature slice.",
      {
        candidates: validated.length
      }
    )
  }
  input.store.appendPlannerEvent(plannerRun.id, "planner-output-received", "Planner output parsed and validated.", {
    candidates: validated.length
  })
  const promptEngineerPersona =
    input.store.listPersonas(input.company.id).find((persona) => persona.name === "prompt-engineer") ??
    input.store.listPersonas(input.company.id).find((persona) => persona.name.toLowerCase().includes("prompt")) ??
    null
  input.store.appendPlannerEvent(
    plannerRun.id,
    "prompt-ideation-started",
    "Framework prompt ideation is refining planner candidates.",
    {
      personaId: promptEngineerPersona?.id ?? null,
      personaName: promptEngineerPersona?.name ?? "prompt-engineer",
      candidates: validated.length
    }
  )
  const promptIdeation = ideatePlannerCandidatePrompts({
    candidates: validated,
    snapshot: input.snapshot,
    promptEngineerPersonaName: promptEngineerPersona?.name ?? "prompt-engineer",
    personas: input.profile.managerStateDefaults.managerPersonas
  })
  input.store.appendPlannerEvent(
    plannerRun.id,
    "prompt-ideation-completed",
    "Framework prompt ideation refined task prompts.",
    {
      personaId: promptEngineerPersona?.id ?? null,
      personaName: promptIdeation.personaName,
      candidates: promptIdeation.candidates.length
    }
  )
  writeArtifact(
    input.store,
    plannerRun.id,
    input.project,
    input.profile,
    "output",
    "prompt-ideation-output.json",
    JSON.stringify({ version: 1, persona: promptIdeation.personaName, candidates: promptIdeation.candidates }, null, 2)
  )

  input.store.appendPlannerEvent(
    plannerRun.id,
    "promptify-started",
    "Promptify compatibility stage recorded prompt ideation output.",
    {
      personaId: promptEngineerPersona?.id ?? null,
      personaName: promptIdeation.personaName,
      candidates: validated.length
    }
  )
  let promptified = promptIdeation.candidates
  const featurePolicy = filterPlannerCandidatesForFeaturePolicy(promptified)
  if (featurePolicy.rejected.length > 0) {
    input.store.appendPlannerEvent(
      plannerRun.id,
      "planner-feature-policy-rejected",
      "Planner rejected candidates that were not repo-evidenced vertical feature slices.",
      {
        rejected: featurePolicy.rejected
      }
    )
  }
  promptified = featurePolicy.accepted
  const fallbackSlots = Math.max(0, capacity.maxTasks - promptified.length)
  if (fallbackSlots > 0 && featurePolicy.rejected.length > 0) {
    const fallbackValidated = validatePlannerCandidates({
      profile: input.profile,
      candidates: deterministicFallbackPlannerCandidates({
        profile: input.profile,
        snapshot: input.snapshot,
        maxTasks: fallbackSlots,
        recentPersonaCounts: personaHistory.counts
      })
    })
    const fallbackIdeation = ideatePlannerCandidatePrompts({
      candidates: fallbackValidated,
      snapshot: input.snapshot,
      promptEngineerPersonaName: promptEngineerPersona?.name ?? "prompt-engineer",
      personas: input.profile.managerStateDefaults.managerPersonas
    })
    const fallbackPolicy = filterPlannerCandidatesForFeaturePolicy(fallbackIdeation.candidates)
    promptified = [...promptified, ...fallbackPolicy.accepted].slice(0, capacity.maxTasks)
    input.store.appendPlannerEvent(
      plannerRun.id,
      "planner-feature-policy-backfilled",
      "Planner backfilled rejected candidates with deterministic repo-evidenced feature slices.",
      {
        requestedSlots: fallbackSlots,
        accepted: fallbackPolicy.accepted.length,
        rejected: fallbackPolicy.rejected
      }
    )
  }
  input.store.appendPlannerEvent(plannerRun.id, "promptify-completed", "Promptify persona refined task prompts.", {
    personaId: promptEngineerPersona?.id ?? null,
    personaName: promptIdeation.personaName,
    candidates: promptified.length
  })
  writeArtifact(
    input.store,
    plannerRun.id,
    input.project,
    input.profile,
    "output",
    "promptify-output.json",
    JSON.stringify({ version: 1, persona: promptIdeation.personaName, candidates: promptified }, null, 2)
  )

  const dedupeWindowStart = new Date(
    Date.now() - input.profile.planner.dedupeWindowHours * 60 * 60 * 1000
  ).toISOString()
  const existingTasks = input.store.listProjectTasks(input.project.id)
  const findExactTask = (dedupeKey: string) =>
    input.store.findTaskByDedupeKey(input.project.id, dedupeKey, dedupeWindowStart)
  let decisions = dedupePlannerCandidates({
    candidates: promptified,
    existingTasks,
    findExact: findExactTask,
    dedupeWindowStartIso: dedupeWindowStart
  })
  const hasCreatableCandidate = () =>
    decisions.some((decision) => decision.action === "create" || decision.action === "supersede_previous")
  if (capacity.maxTasks > 0 && !hasCreatableCandidate()) {
    const initialDuplicateCount = decisions.length
    const refillCandidates = deterministicFallbackPlannerCandidates({
      profile: input.profile,
      snapshot: input.snapshot,
      maxTasks: capacity.maxTasks,
      recentPersonaCounts: personaHistory.counts,
      excludeCandidate: (candidate) => {
        const [decision] = dedupePlannerCandidates({
          candidates: [candidate],
          existingTasks,
          findExact: findExactTask,
          dedupeWindowStartIso: dedupeWindowStart
        })
        return decision?.action !== "create" && decision?.action !== "supersede_previous"
      }
    })
    const refillValidated = validatePlannerCandidates({
      profile: input.profile,
      candidates: refillCandidates
    })
    const refillIdeation = ideatePlannerCandidatePrompts({
      candidates: refillValidated,
      snapshot: input.snapshot,
      promptEngineerPersonaName: promptEngineerPersona?.name ?? "prompt-engineer",
      personas: input.profile.managerStateDefaults.managerPersonas
    })
    const refillPolicy = filterPlannerCandidatesForFeaturePolicy(refillIdeation.candidates)
    if (refillPolicy.accepted.length > 0) {
      promptified = refillPolicy.accepted.slice(0, capacity.maxTasks)
      decisions = dedupePlannerCandidates({
        candidates: promptified,
        existingTasks,
        findExact: findExactTask,
        dedupeWindowStartIso: dedupeWindowStart
      })
    }
    input.store.appendPlannerEvent(
      plannerRun.id,
      "planner-dedupe-refilled",
      "Planner replaced an all-duplicate candidate set with fresh deterministic evidence slices.",
      {
        initialDuplicateCount,
        generatedCandidates: refillCandidates.length,
        acceptedCandidates: refillPolicy.accepted.length,
        creatableCandidates: decisions.filter(
          (decision) => decision.action === "create" || decision.action === "supersede_previous"
        ).length
      }
    )
  }
  const createdTaskIds = materializePlannerTasks({
    store: input.store,
    projectId: input.project.id,
    profile: input.profile,
    candidates: promptified,
    decisions,
    personaByName: (name) => {
      if (!name) return null
      return input.store.listPersonas(input.company.id).find((entry) => entry.name === name)?.id ?? null
    }
  })

  for (const decision of decisions) {
    input.store.appendPlannerEvent(
      plannerRun.id,
      decision.action === "create" ? "planner-task-created" : "planner-task-skipped",
      decision.reason,
      decision as unknown as Record<string, unknown>
    )
  }

  const summary: PlannerRunSummary = {
    createdTaskIds,
    skippedCandidates: decisions.filter(
      (decision) => decision.action !== "create" && decision.action !== "supersede_previous"
    ).length,
    blockedCandidates: promptified.filter((candidate) => candidate.governanceClass === "manual_only").length,
    deferred: false
  }

  writeArtifact(
    input.store,
    plannerRun.id,
    input.project,
    input.profile,
    "output",
    "planning-output.json",
    JSON.stringify({ ...parsed, candidates: promptified }, null, 2)
  )
  writeArtifact(
    input.store,
    plannerRun.id,
    input.project,
    input.profile,
    "orchestration_log",
    "orchestration-log.md",
    [
      "# Planner Orchestration Log",
      "",
      parsed.summary ? `Summary: ${parsed.summary}` : null,
      `Created tasks: ${createdTaskIds.length}`,
      "",
      `Prompt ideation persona: ${promptIdeation.personaName}`,
      "",
      "Decisions:",
      ...decisions.map((decision: PlannerDecision) => `- ${decision.action}: ${decision.title} (${decision.reason})`)
    ]
      .filter(Boolean)
      .join("\n")
  )
  writeArtifact(
    input.store,
    plannerRun.id,
    input.project,
    input.profile,
    "events",
    "planning-events.ndjson",
    JSON.stringify(input.store.getPlannerEvents(plannerRun.id), null, 2)
  )

  input.store.updatePlannerRun(plannerRun.id, {
    status: "succeeded",
    outputJson: { ...parsed, candidates: promptified },
    summaryJson: summary,
    finishedAt: new Date().toISOString()
  })

  return {
    plannerRunId: plannerRun.id,
    createdTaskIds,
    output: { ...parsed, candidates: promptified },
    summary
  }
}
