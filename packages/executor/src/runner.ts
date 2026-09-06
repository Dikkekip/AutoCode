import {
  linkSharedExecutionDependencies,
  nodeTestDependencyManifestsDiffer,
  unlinkSharedExecutionDependencies
} from "./execution-dependencies.js"
import { executionDependencyPaths, executionPolicyForRepo } from "./execution-policy.js"
import {
  focusedChangedTestVerificationCommands,
  normalizeVerificationCommand,
  repairBackendPytestPaths
} from "./verification-commands.js"

export {
  focusedChangedTestVerificationCommands,
  normalizeVerificationCommand,
  repairBackendPytestPaths
} from "./verification-commands.js"

import { createHash } from "node:crypto"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import type { AuditWriter } from "@openclaw/audit-runtime"
import type { DispatcherStore } from "@openclaw/db"
import {
  type AdapterCapabilityProfile,
  type AdapterDefinition,
  type AdapterExecutionResult,
  type AdapterFailureCategory,
  type AdapterHealthcheckResult,
  type Agent,
  type AgentSelectionDecision,
  type Automation,
  activeAgentsForAdapter,
  type BudgetStatus,
  type CodexQuotaOverview,
  type Company,
  classifyBlockedReason,
  coordinateRatePool,
  evaluateVerificationGate,
  formatPullRequestFeedback,
  getBuiltinAutomationVariableValues,
  getSuccessfulTaskStatus,
  interpolateAutomationTemplate,
  type JobId,
  type JobSpec,
  type ModelReasoningEffort,
  normalizedModelFamily,
  normalizeOpenClawStateBackend,
  type OutcomeStage,
  openClawStatePath,
  type Persona,
  type Project,
  type PromotionRecord,
  type ReviewResult,
  type ReviewVerdict,
  type RouteDecision,
  type Run,
  type RunRetryClass,
  type RuntimeIdentityPayload,
  readCodexQuotaOverview,
  recordRatePoolUsage,
  routeTask,
  type SessionState,
  selectBestAgentForTask,
  type Task,
  type TaskOutcomeResult,
  type TickSummary,
  taskHasHardExecutionSignals,
  taskRequiresTools,
  type VerificationCheckResult,
  type WakeReason
} from "@openclaw/domain"
import {
  assertExecutionOwnership,
  commandExists,
  executeCommand,
  executeShellAsync,
  holdsExecutionOwner,
  preferredPosixShell,
  withExecutionOwner
} from "@openclaw/os-adapters"
import {
  bestProfileMatch,
  loadProjectProfile,
  type ProjectProfile,
  resolveProjectProfile
} from "@openclaw/project-profiles"
import {
  ConflictTracker,
  type DelegationAssignment,
  delegationTaskFromDispatcherTask,
  TeamRouter,
  type TeamRoutingDecision,
  taskArtifactPaths,
  teamAgentProfileFromDispatcherAgent
} from "@openclaw/team-router"
import { createExecutionTracer, summarizeExecutionTrace, type TelemetryPathNode } from "@openclaw/telemetry"
import { CronExpressionParser } from "cron-parser"
import {
  emitAgentLoopAssistantDelta,
  emitAgentLoopLifecycle,
  emitAgentLoopTerminalFromRun,
  emitAgentLoopTool,
  ownerProcessIsAlive,
  readAgentLoopOwnerPid,
  summarizeAdapterResult
} from "./agent-loop.js"
import { syncRepoAndWorktrees } from "./git-sync.js"
import { MemoryService } from "./memory.js"
import { collectRepoPlanningSnapshot } from "./planner/collect-signals.js"
import { buildPlannerCapacityPlan, recoverDeadPlannerOwnerRuns, runPlannerAutomation } from "./planner/run-planner.js"
import { reviewCompletedRun } from "./reviewer.js"
import {
  attachSessionContextWindowState,
  buildCostValueDecision,
  buildSessionContextWindowState,
  classifyLaneStatusFromMessage,
  defaultCooldownUntil,
  evaluateSessionRotation,
  laneIsCoolingDown,
  RunToolingCache,
  readSessionContextWindowState,
  shapeExecutionPrompt
} from "./runtime-optimization.js"

type AdapterRegistry = Record<string, AdapterDefinition>
type ReviewSweepResult = {
  created: number
  recovered: number
}
type AutonomousDirectiveAction = "continue" | "complete" | "blocked"

type AutonomousDirective = {
  action: AutonomousDirectiveAction
  summary: string | null
  selfReflection: string | null
  nextPrompt: string | null
}

type AutonomousExecutionOutcome = {
  result: AdapterExecutionResult
  responseText: string
  blocked: boolean
  blockedReason: string | null
  turns: number
  directives: AutonomousDirective[]
}

const AUTONOMOUS_DIRECTIVE_START = "<openclaw-autonomous>"
const AUTONOMOUS_DIRECTIVE_END = "</openclaw-autonomous>"

function computeSessionKey(agent: Agent, project: Project, task: Task): string {
  return `${agent.id}:${project.id}:${task.id}`
}

function evaluatePersistedTeamRoute(
  store: DispatcherStore,
  task: Task,
  agent: Agent
): {
  decision: TeamRoutingDecision
  artifactPaths: string[]
} {
  const delegationTask = delegationTaskFromDispatcherTask(task, {
    preferredAssigneeId: agent.id,
    metadata: {
      adapterType: agent.adapterType
    }
  })
  const activeAssignments = store.listTeamAssignments({ projectId: task.projectId, status: "active" })
  const conflicts = new ConflictTracker()
  for (const lockout of store.findTeamReviewerLockouts(task.projectId, delegationTask.artifactPaths, {
    taskId: task.id
  })) {
    conflicts.applyReviewerLock({
      artifactPaths: [lockout.artifactPath],
      lockedAgentId: lockout.lockedAgentId,
      reviewerAgentId: lockout.reviewerAgentId ?? lockout.reviewerActor,
      taskId: lockout.taskId,
      reason: lockout.reason,
      createdAt: lockout.createdAt
    })
  }
  const routerAssignments: DelegationAssignment[] = activeAssignments.map((assignment) => {
    conflicts.claimArtifacts({
      assignmentId: assignment.id,
      taskId: assignment.taskId,
      agentId: assignment.agentId,
      artifactPaths: assignment.artifactPaths,
      claimedAt: assignment.startedAt
    })
    return {
      assignmentId: assignment.id,
      taskId: assignment.taskId,
      agentId: assignment.agentId,
      agentName: store.getAgentById(assignment.agentId).name,
      artifactPaths: assignment.artifactPaths,
      startedAt: assignment.startedAt
    }
  })
  const profile = teamAgentProfileFromDispatcherAgent(agent, {
    capabilities: task.labels,
    lanes: task.laneId ? [task.laneId] : [],
    reviewer: task.stage === "reviewer" || /review|quality|\bqa\b/i.test(`${agent.name} ${agent.role}`),
    maxParallelAssignments: maxConcurrentExecutionRunsPerTick()
  })

  return {
    decision: new TeamRouter(conflicts).routeTask(delegationTask, [profile], {
      activeAssignments: routerAssignments
    }),
    artifactPaths: delegationTask.artifactPaths
  }
}

function agentMatchesPersonaStage(agent: Agent, persona: Persona): boolean {
  const identity = `${agent.name} ${agent.role}`.toLowerCase()
  const hasAny = (patterns: readonly RegExp[]) => patterns.some((pattern) => pattern.test(identity))

  if (persona.stage === "planner") {
    return hasAny([/\bplanner\b/, /\barchitect\b/, /\borchestrator\b/, /\bmanager\b/])
  }
  if (persona.stage === "reviewer") {
    return hasAny([/\breview/, /\bquality\b/, /\bqa\b/])
  }
  if (persona.stage === "promoter") {
    return hasAny([/\bpromot/, /\brelease\b/])
  }

  return !hasAny([/\bplanner\b/, /\breview/, /\bpromot/, /\brelease\b/, /\borchestrator\b/, /\bmanager\b/])
}

function plannerAgentIsAvailable(agent: Agent): boolean {
  return agent.heartbeatEnabled && agent.status !== "paused" && agent.status !== "blocked"
}

export function plannerAgentCandidates(input: {
  agents: Agent[]
  plannerPersona: Persona | null
  profile: ProjectProfile
  quota: CodexQuotaOverview | null
}): Agent[] {
  const available = input.agents.filter(plannerAgentIsAvailable)
  const primary = [
    input.plannerPersona
      ? (available.find(
          (candidate) =>
            candidate.name === input.plannerPersona?.name &&
            candidate.adapterType === input.plannerPersona.preferredAdapterType
        ) ?? null)
      : null,
    available.find((candidate) => candidate.name === "planner") ?? null
  ]
  const configuredFallbackAdapterType = input.profile.planner.costPolicy.fallbackPlannerAdapterType ?? "gemini_local"
  const configuredFallback =
    available.find((candidate) => candidate.adapterType === configuredFallbackAdapterType) ?? null
  const resilientNonCodexFallback =
    available.find((candidate) => candidate.adapterType === "gemini_local") ??
    available.find((candidate) => candidate.adapterType === "azure_foundry") ??
    null
  // A degraded overview means the configured accounts are runnable but their
  // quota cache is stale or incomplete. Treat only explicit exhaustion as a
  // reason to move the less reliable non-Codex planner ahead of the profile's
  // preferred planner. Adapter fallback still protects a genuinely failing
  // Codex invocation.
  const quotaConstrained = input.quota?.assessment === "blocked" || input.quota?.recommendedMaxConcurrentCodexRuns === 0
  const ordered = quotaConstrained
    ? [resilientNonCodexFallback, configuredFallback, ...primary]
    : [...primary, configuredFallback, resilientNonCodexFallback]
  const seenAdapters = new Set<Agent["adapterType"]>()
  return ordered.flatMap((candidate) => {
    if (!candidate || seenAdapters.has(candidate.adapterType)) return []
    seenAdapters.add(candidate.adapterType)
    return [candidate]
  })
}

function modelIsCompatibleWithAdapter(adapterType: Agent["adapterType"], model: string | null | undefined): boolean {
  const normalized = model?.trim().toLowerCase()
  if (!normalized) return true
  if (adapterType === "codex_local") return /^(gpt-|o[0-9]|codex)/.test(normalized)
  if (adapterType === "gemini_local") return normalized.includes("gemini")
  if (adapterType === "azure_foundry") return !normalized.includes("gemini")
  return true
}

function fallbackModelForAdapter(adapterType: Agent["adapterType"]): string | null {
  if (adapterType === "codex_local") return "gpt-5.6-sol"
  if (adapterType === "gemini_local") return "gemini-3.1-pro"
  if (adapterType === "azure_foundry") return "Kimi-K2.6"
  return null
}

function pinnedAdapterModel(agent: Agent): string | null {
  if (agent.adapterType !== "gemini_local") return null
  const model = agent.env.OPENCLAW_GEMINI_ACPX_MODEL?.trim()
  return model || null
}

function coerceRouteDecisionModelForAgent(decision: RouteDecision, agent: Agent): RouteDecision {
  const selectedModel = decision.selectedModel ?? agent.model ?? null
  const pinnedModel = pinnedAdapterModel(agent)
  if (pinnedModel) {
    return {
      ...decision,
      selectedModel: pinnedModel,
      modelFamily: normalizedModelFamily({ ...agent, model: pinnedModel }),
      modelRoutingReason: `${decision.modelRoutingReason}; honored configured Gemini ACP model override ${pinnedModel}`
    }
  }
  if (modelIsCompatibleWithAdapter(agent.adapterType, selectedModel)) {
    return decision
  }

  const fallbackModel = modelIsCompatibleWithAdapter(agent.adapterType, agent.model)
    ? agent.model
    : fallbackModelForAdapter(agent.adapterType)
  return {
    ...decision,
    selectedModel: fallbackModel,
    modelFamily: normalizedModelFamily({ ...agent, model: fallbackModel }),
    modelRoutingReason: `${decision.modelRoutingReason}; corrected incompatible ${selectedModel ?? "default"} model for ${agent.adapterType}`
  }
}

function autonomousExecutionEnabled(): boolean {
  const raw = process.env.OPENCLAW_AUTONOMOUS_EXECUTION_MODE?.trim().toLowerCase()
  return raw === "1" || raw === "true" || raw === "yes"
}

function maxAutonomousTurns(): number {
  return envInt("OPENCLAW_AUTONOMOUS_EXECUTION_MAX_TURNS", 4)
}

function autonomousPromptInstructions(): string {
  return [
    "Autonomous execution mode is enabled for this run.",
    "Do not stop at the first milestone if more task-local work remains.",
    "Before claiming progress, run only the narrowest focused check that proves your edit and rely on evidence, not assumption. Do not run repository-wide suites, builds, or the full verification checklist during agent execution; the dispatcher runs every configured verification command after you return.",
    "Prefer the smallest next verifiable step over large speculative changes.",
    "In `self_reflection`, state concrete evidence: what you verified, what passed or failed, and the single most valuable next step.",
    "At the end of every reply, append an autonomous control block using these exact markers:",
    AUTONOMOUS_DIRECTIVE_START,
    '{"action":"continue|complete|blocked","summary":"short status","self_reflection":"what you learned and verified","next_prompt":"next concrete verifiable step or null"}',
    AUTONOMOUS_DIRECTIVE_END,
    "Use `continue` only when more work should happen immediately in the same task.",
    "Use `complete` only when the task is ready for dispatcher verification and you have evidence it works.",
    "Use `blocked` only when an external dependency or missing input prevents further progress."
  ].join("\n")
}

function buildAutonomousPrompt(input: {
  basePrompt: string
  adapter: AdapterDefinition
  turn: number
  summary?: string | null
  selfReflection?: string | null
  nextPrompt?: string | null
}): string {
  if (input.turn === 0) {
    return [input.basePrompt, autonomousPromptInstructions()].join("\n\n")
  }

  const sections = [
    input.adapter.capabilities.supportsSessionResume ? null : input.basePrompt,
    `Autonomous continuation turn ${input.turn + 1}.`,
    input.summary ? `Last step summary:\n${input.summary}` : null,
    input.selfReflection ? `Self-reflection:\n${input.selfReflection}` : null,
    input.nextPrompt
      ? `Continue with this next prompt:\n${input.nextPrompt}`
      : "Continue the most valuable unfinished task-local work.",
    autonomousPromptInstructions()
  ]

  return sections.filter((value): value is string => Boolean(value && value.trim())).join("\n\n")
}

function parseAutonomousDirective(response: string): AutonomousDirective | null {
  const start = response.lastIndexOf(AUTONOMOUS_DIRECTIVE_START)
  const end = response.lastIndexOf(AUTONOMOUS_DIRECTIVE_END)
  if (start === -1 || end === -1 || end <= start) {
    return null
  }

  const raw = response.slice(start + AUTONOMOUS_DIRECTIVE_START.length, end).trim()
  const jsonText = raw
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim()

  try {
    const parsed = JSON.parse(jsonText) as Record<string, unknown>
    const action = typeof parsed.action === "string" ? parsed.action.trim().toLowerCase() : ""
    if (action !== "continue" && action !== "complete" && action !== "blocked") {
      return null
    }
    return {
      action,
      summary: typeof parsed.summary === "string" && parsed.summary.trim() ? parsed.summary.trim() : null,
      selfReflection:
        typeof parsed.self_reflection === "string" && parsed.self_reflection.trim()
          ? parsed.self_reflection.trim()
          : typeof parsed.selfReflection === "string" && parsed.selfReflection.trim()
            ? parsed.selfReflection.trim()
            : null,
      nextPrompt:
        typeof parsed.next_prompt === "string" && parsed.next_prompt.trim()
          ? parsed.next_prompt.trim()
          : typeof parsed.nextPrompt === "string" && parsed.nextPrompt.trim()
            ? parsed.nextPrompt.trim()
            : null
    }
  } catch {
    return null
  }
}

function stripAutonomousDirective(response: string): string {
  const start = response.lastIndexOf(AUTONOMOUS_DIRECTIVE_START)
  const end = response.lastIndexOf(AUTONOMOUS_DIRECTIVE_END)
  if (start === -1 || end === -1 || end <= start) {
    return response.trim()
  }

  const stripped = `${response.slice(0, start)}${response.slice(end + AUTONOMOUS_DIRECTIVE_END.length)}`
  return stripped.trim()
}

function inferTerminalBlockedReason(task: Task, response: string): string | null {
  const trimmed = response.trim()
  if (!trimmed) return null
  if (responseReportsVerifiedExistingImplementation(trimmed)) return null

  const blockedPackage =
    /\bdispatch_status\s*:\s*blocked\b/i.test(trimmed) ||
    /\bblocked\s+as\s+a\s+coding\s+dispatch\s+package\b/i.test(trimmed)
  const noChangeBlocked =
    /\bblocked\b/i.test(trimmed) &&
    /\bno\s+(?:(?:repository|source|tracked)\s+)?files?\s+(?:were\s+)?(?:inspected\s+or\s+)?changed\b/i.test(trimmed)
  const implementationWithoutChanges =
    task.kind === "implement" &&
    (/\bi\s+did\s+not\s+make\s+(?:any\s+)?(?:code\s+)?changes?\b/i.test(trimmed) ||
      /\bno\s+(?:code\s+)?changes?\s+(?:were\s+)?(?:made|changed)\b/i.test(trimmed) ||
      /\bno\s+(?:(?:repository|source|tracked)\s+)?files?\s+(?:were\s+)?(?:inspected\s+or\s+)?changed\b/i.test(trimmed))
  if (!blockedPackage && !noChangeBlocked && !implementationWithoutChanges) return null

  const reasonLine = trimmed
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*\s"`]+/, "").trim())
    .find((line) => /blocked|reason|missing|prevents|outside|no\s+(?:code\s+)?changes|did\s+not\s+make/i.test(line))

  return (reasonLine || "Adapter reported no implementation changes.").slice(0, 500)
}

function readOptionalFile(path: string | null): string | null {
  if (!path) return null
  if (!existsSync(path)) return null
  if (!statSync(path).isFile()) return null
  return readFileSync(path, "utf8")
}

function promptSections(parts: Array<string | null | undefined>): string {
  return parts.filter((value): value is string => Boolean(value && value.trim())).join("\n\n")
}

const DEFAULT_COMMAND_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
const SHELL_COMMAND_PREFIXES = [
  "./",
  "../",
  "/",
  "cd ",
  "npm ",
  "pnpm ",
  "yarn ",
  "corepack ",
  "uv ",
  "python ",
  "python3 ",
  "pytest ",
  "ruff ",
  "node ",
  "npx ",
  "playwright ",
  "make ",
  "git ",
  "gh ",
  "bash ",
  "sh ",
  "docker ",
  "docker-compose ",
  "go ",
  "cargo "
] as const

function commandEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: process.env.PATH?.trim() || DEFAULT_COMMAND_PATH
  }
}

function looksLikeExecutableCommand(command: string): boolean {
  const trimmed = command.trim()
  if (!trimmed) return false
  if (/^(run|ensure|confirm|verify|check|inspect)\b/i.test(trimmed) && !/^(ruff|pytest)\b/i.test(trimmed)) {
    return false
  }
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(trimmed)) {
    return true
  }
  return SHELL_COMMAND_PREFIXES.some((prefix) => trimmed.startsWith(prefix))
}

function isNoCodeIdeationTask(task: Task | null): boolean {
  if (!task) return false
  const haystack = [
    task.kind,
    task.title,
    task.description ?? "",
    ...task.labels,
    task.taskPackage?.repoProfile ?? "",
    task.taskPackage?.likelyOwnershipLane ?? "",
    ...(task.taskPackage?.repoNotes ?? [])
  ]
    .join(" ")
    .toLowerCase()

  const asksForIdeation = /\b(ideation|ideate|brainstorm|ideas?|planning-only|no-code)\b/.test(haystack)
  const forbidsCodeEdits = /\b(do not edit code|no code edits?|without editing code|planning-only)\b/.test(haystack)
  const hasEditScope = task.changedFiles.length > 0 || task.allowedPaths.length > 0

  return asksForIdeation && forbidsCodeEdits && !hasEditScope
}

function responseReportsVerifiedExistingImplementation(response: string): boolean {
  const noPatchRequired =
    /\bno (?:new )?(?:code |repository |source |tracked )?(?:changes?|patch(?:es)?) (?:(?:are|is|were|was) )?(?:needed|required|necessary)\b/i.test(
      response
    ) ||
    /\bno (?:redundant |additional |new )?(?:code |repository |tracked )?(?:changes?|patch(?:es)?) (?:were|was|have been|has been) made\b/i.test(
      response
    )
  const existingImplementation =
    /\b(?:already (?:contains?|includes?|implements?|implemented|merged|satisfies?|satisfied|present)|existing (?:merged )?(?:implementation|fix|behavior|code))\b/i.test(
      response
    ) || /\b(?:behavior|functionality|implementation|fix|code) (?:is )?already present\b/i.test(response)
  return noPatchRequired && existingImplementation
}

function verificationCommands(task: Task | null, project: Project): string[] {
  if (isNoCodeIdeationTask(task)) {
    return []
  }

  const checklist = task?.taskPackage?.verificationChecklist?.map((item) => item.trim()).filter(Boolean) ?? []
  const taskCommands = task?.verificationCommands.map((item) => item.trim()).filter(Boolean) ?? []
  const executableChecklist = checklist
    .filter(looksLikeExecutableCommand)
    .map((command) =>
      repairBackendPytestPaths(
        normalizeVerificationCommand(command, {}, executionPolicyForRepo(project.repoPath)),
        project.repoPath
      )
    )
  const executableTaskCommands = taskCommands
    .filter(looksLikeExecutableCommand)
    .map((command) =>
      repairBackendPytestPaths(
        normalizeVerificationCommand(command, {}, executionPolicyForRepo(project.repoPath)),
        project.repoPath
      )
    )

  if (executableChecklist.length > 0) {
    return Array.from(new Set(executableChecklist))
  }

  if (executableTaskCommands.length > 0) {
    return Array.from(new Set(executableTaskCommands))
  }

  return project.verifyCommand && looksLikeExecutableCommand(project.verifyCommand)
    ? Array.from(
        new Set([
          repairBackendPytestPaths(
            normalizeVerificationCommand(project.verifyCommand, {}, executionPolicyForRepo(project.repoPath)),
            project.repoPath
          )
        ])
      )
    : []
}

function verificationCommandsWithChangedTests(task: Task | null, project: Project, changedPaths: string[]): string[] {
  return Array.from(
    new Set([
      ...focusedChangedTestVerificationCommands(changedPaths, executionPolicyForRepo(project.repoPath)),
      ...verificationCommands(task, project)
    ])
  )
}

function renderTaskPackage(task: Task): string | null {
  if (!task.taskPackage) {
    return null
  }

  const sections = [
    `- Repo profile: ${task.taskPackage.repoProfile}`,
    `- Likely ownership lane: ${task.taskPackage.likelyOwnershipLane}`,
    `- Lane reason: ${task.taskPackage.laneReason}`
  ]

  const requiredReading = task.taskPackage.requiredReading ?? []
  const verificationChecklist = task.taskPackage.verificationChecklist ?? []
  const contractUpdateReminders = task.taskPackage.contractUpdateReminders ?? []

  if (requiredReading.length > 0) {
    sections.push("- Required reading:")
    for (const item of requiredReading) {
      sections.push(`  - ${item}`)
    }
  }

  if (verificationChecklist.length > 0) {
    sections.push("- Verification checklist:")
    for (const item of verificationChecklist) {
      sections.push(`  - ${item}`)
    }
  }

  if (contractUpdateReminders.length > 0) {
    sections.push("- Contract update reminders:")
    for (const item of contractUpdateReminders) {
      sections.push(`  - ${item}`)
    }
  }

  if (task.taskPackage.repoNotes.length > 0) {
    sections.push("- Repo notes:")
    for (const item of task.taskPackage.repoNotes) {
      sections.push(`  - ${item}`)
    }
  }

  if (task.taskPackage.extraInstructions?.length) {
    sections.push("- Extra implementation instructions:")
    for (const item of task.taskPackage.extraInstructions) {
      sections.push(`  - ${item.replace(/\n/g, "\n    ")}`)
    }
  }

  return ["Generated task package:", ...sections].join("\n")
}

function buildPrompt(input: {
  company: Company
  project: Project
  task: Task
  agent: Agent
  previousSession: SessionState | null
  relevantMemory: string | null
  runtimeIdentity: RuntimeIdentityPayload
}): string {
  const instructions = readOptionalFile(input.agent.instructionsPath)
  const retryContext =
    input.task.retryCount > 0
      ? `This task has already failed ${input.task.retryCount} time(s). Use that history to avoid repeating mistakes.`
      : null
  const previousSessionId = input.previousSession?.sessionDisplayId
    ? `Previous session: ${input.previousSession.sessionDisplayId}`
    : null
  const taskVerificationCommands = verificationCommands(input.task, input.project)

  return promptSections([
    `You are ${input.agent.name}, acting as ${input.agent.role} for ${input.company.name}.`,
    instructions ? `Additional instructions:\n${instructions}` : null,
    [
      "Task context:",
      `- Project: ${input.project.name}`,
      `- Repository: ${input.project.repoPath}`,
      `- Title: ${input.task.title}`,
      `- Description: ${input.task.description ?? "No description provided."}`,
      `- Labels: ${input.task.labels.join(", ") || "none"}`,
      `- Changed file hints: ${input.task.changedFiles.join(", ") || "none"}`,
      `- Review required: ${input.task.reviewRequired ? "yes" : "no"}`,
      `- Verification commands: ${taskVerificationCommands.join(" | ") || "none"}`
    ].join("\n"),
    [
      "Runtime identity:",
      `- Runtime key: ${input.runtimeIdentity.runtimeKey}`,
      `- Execution key: ${input.runtimeIdentity.executionKey}`,
      `- Wake reason: ${input.runtimeIdentity.wake.reason}`,
      `- Heartbeat job: ${input.runtimeIdentity.wake.heartbeatJobId ?? "none"}`,
      `- Continuation session: ${input.runtimeIdentity.continuation.sessionDisplayId ?? "new session"}`,
      `- Continuation attempt: ${input.runtimeIdentity.continuation.attempt}`,
      `- Adapter session resume: ${input.runtimeIdentity.continuation.supportsSessionResume ? "supported" : "not supported"}`,
      `- Adapter context management: ${input.runtimeIdentity.continuation.nativeContextManagement}`
    ].join("\n"),
    renderTaskPackage(input.task),
    retryContext,
    previousSessionId,
    input.relevantMemory,
    [
      "Execution expectations:",
      "- Work only on this task.",
      "- Make concrete progress in the target repository.",
      "- End with a concise summary of what changed or why you are blocked.",
      "- If you are blocked, say so explicitly in the final response."
    ].join("\n")
  ])
}

function resolveWakeContext(
  executionWake: Map<string, { wakeReason: WakeReason; heartbeatJobId: JobId | null; triggeredAt: string }>,
  projectId: string,
  fallbackTriggeredAt: string
): { wakeReason: WakeReason; heartbeatJobId: JobId | null; triggeredAt: string } {
  return (
    executionWake.get(projectId) ?? {
      wakeReason: "manual",
      heartbeatJobId: null,
      triggeredAt: fallbackTriggeredAt
    }
  )
}

function buildRuntimeIdentity(input: {
  runId: string
  task: Task
  project: Project
  company: Company
  agent: Agent
  adapter: AdapterDefinition
  sessionKey: string
  sessionState: SessionState | null
  routing: {
    selectedModel: string | null
    reasoningEffort: ModelReasoningEffort
    modelFamily: string
    modelRoutingReason: string
    complexityScore: number
    complexityScore100?: number
    importanceScore: number
    valueScore100?: number
    complexitySignals: string[]
    importanceSignals: string[]
    promptRouteRank?: Exclude<NonNullable<RuntimeIdentityPayload["routing"]>["promptRouteRank"], undefined>
    costEstimate?: Exclude<NonNullable<RuntimeIdentityPayload["routing"]>["costEstimate"], undefined>
  }
  wakeReason: WakeReason
  heartbeatJobId: JobId | null
  triggeredAt: string
}): RuntimeIdentityPayload {
  return {
    version: 1,
    runtimeKey: input.sessionKey,
    executionKey: input.runId,
    companyId: input.company.id,
    projectId: input.project.id,
    projectName: input.project.name,
    repoPath: input.project.repoPath,
    taskId: input.task.id,
    taskKind: input.task.kind,
    taskTitle: input.task.title,
    workflowId: input.task.workflowId,
    laneId: input.task.laneId,
    agentId: input.agent.id,
    agentName: input.agent.name,
    adapterType: input.agent.adapterType,
    model: input.agent.model,
    routing: input.routing,
    wake: {
      reason: input.wakeReason,
      heartbeatJobId: input.heartbeatJobId,
      triggeredAt: input.triggeredAt
    },
    continuation: {
      sessionKey: input.sessionKey,
      sessionDisplayId: input.sessionState?.sessionDisplayId ?? null,
      retryCount: input.task.retryCount,
      attempt: input.task.retryCount + 1,
      heartbeatEnabled: input.agent.heartbeatEnabled,
      heartbeatIntervalSec: input.agent.heartbeatIntervalSec,
      supportsSessionResume: input.adapter.capabilities.supportsSessionResume,
      nativeContextManagement: input.adapter.capabilities.nativeContextManagement
    },
    scope: {
      allowedPaths: input.task.allowedPaths,
      requiredReading: input.task.requiredReading,
      verificationCommands: verificationCommands(input.task, input.project)
    }
  }
}

async function verificationOk(
  task: Task | null,
  project: Project,
  log: (level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>) => void,
  toolingCache?: RunToolingCache,
  commandsOverride?: string[],
  baselineEligibleCommands: string[] = []
): Promise<{ ok: boolean; error: string | null; summary: string | null }> {
  const commands = commandsOverride ?? verificationCommands(task, project)
  if (commands.length === 0) {
    return { ok: true, error: null, summary: null }
  }

  const commandSummary = commands.join(" && ")
  const shell = preferredPosixShell()
  const timeoutMs = verificationTimeoutMs()

  for (const command of commands) {
    log("info", "Running verification command", { command, shell, timeoutMs })
    const verificationStartedAtMs = Date.now()
    let verificationHeartbeatCount = 0
    const verificationHeartbeat = setInterval(
      () => {
        verificationHeartbeatCount += 1
        log("info", "Verification command heartbeat", {
          command,
          elapsedMs: Date.now() - verificationStartedAtMs,
          heartbeatCount: verificationHeartbeatCount
        })
      },
      envInt("OPENCLAW_RUN_HEARTBEAT_INTERVAL_MS", 2 * 60 * 1000)
    )
    verificationHeartbeat.unref()
    const result = await (async () => {
      const commandResult = toolingCache
        ? await toolingCache.runCommandAsync(command, async () => {
            const invocation = await executeShellAsync(command, {
              cwd: project.repoPath,
              shell,
              timeoutMs,
              timeoutKillGraceMs: 5_000,
              maxBufferBytes: 1024 * 1024 * 10,
              terminateProcessGroup: true
            })
            return {
              ok: invocation.ok,
              stdout: invocation.stdout,
              stderr: invocation.stderr,
              status: invocation.exitCode
            }
          })
        : {
            ok: false,
            stdout: "",
            stderr: "",
            status: null,
            cacheHit: false
          }

      if (!toolingCache) {
        const direct = await executeShellAsync(command, {
          cwd: project.repoPath,
          shell,
          timeoutMs,
          timeoutKillGraceMs: 5_000,
          maxBufferBytes: 1024 * 1024 * 10,
          terminateProcessGroup: true
        })
        commandResult.ok = direct.ok
        commandResult.stdout = direct.stdout
        commandResult.stderr = direct.stderr
        commandResult.status = direct.exitCode
      }
      return commandResult
    })().finally(() => clearInterval(verificationHeartbeat))

    if (result.cacheHit) {
      log("info", "Reused cached verification result", {
        command,
        ok: result.ok
      })
    }

    if (result.stdout.trim()) {
      log("info", "Verification stdout", { command, output: result.stdout.trim() })
    }
    if (result.stderr.trim()) {
      log("warn", "Verification stderr", { command, output: result.stderr.trim() })
    }

    if (result.ok && result.status === 0) {
      continue
    }

    const componentSizeOutput = `${result.stdout}\n${result.stderr}`
    if (
      executionPolicyForRepo(project.repoPath).baselineChecks?.some(
        (check) => check.kind === "component-size" && command.includes(check.commandIncludes)
      ) &&
      componentSizeFailureIsNonWorsening(project.repoPath, componentSizeOutput)
    ) {
      log("warn", "Accepted non-worsening baseline component-size violations", {
        command,
        policy: "new_or_worsened_violations_fail"
      })
      continue
    }

    if (
      executionPolicyForRepo(project.repoPath).baselineChecks?.some(
        (check) => check.kind === "feature-boundary" && command.includes(check.commandIncludes)
      ) &&
      featureBoundaryFailureIsNonWorsening(project.repoPath, componentSizeOutput)
    ) {
      log("warn", "Accepted non-worsening baseline feature-boundary violations", {
        command,
        policy: "new_violations_fail"
      })
      continue
    }

    if (
      baselineEligibleCommands.includes(command) &&
      executionPolicyForRepo(project.repoPath).baselinePathRoots.some((root) => command.startsWith(`cd ${root} &&`))
    ) {
      const baselineComparison = await focusedVerificationFailureIsNonWorsening(
        project.repoPath,
        command,
        componentSizeOutput,
        timeoutMs
      )
      if (baselineComparison.nonWorsening) {
        log("warn", "Accepted non-worsening focused verification failures", {
          command,
          policy: "new_failing_tests_fail",
          baseSha: baselineComparison.baseSha,
          candidateFailureCount: baselineComparison.candidateFailures.length,
          baselineFailureCount: baselineComparison.baselineFailures.length
        })
        continue
      }
      log("info", "Focused verification baseline comparison did not permit the failure", {
        command,
        baseSha: baselineComparison.baseSha,
        candidateFailureCount: baselineComparison.candidateFailures.length,
        baselineFailureCount: baselineComparison.baselineFailures.length,
        comparisonError: baselineComparison.error
      })
    }

    const stdout = result.stdout.trim()
    const stderr = result.stderr.trim()
    const sections = [
      `Verification command failed: ${command}`,
      stdout ? `stdout:\n${stdout}` : null,
      stderr ? `stderr:\n${stderr}` : null
    ].filter((value): value is string => Boolean(value))
    const combined = sections.join("\n\n")
    const maxLength = 12000
    const errorText =
      combined.length <= maxLength ? combined : `${combined.slice(0, 4000)}\n\n...\n\n${combined.slice(-7000)}`

    return {
      ok: false,
      error: errorText || `Verification exited with status ${result.status ?? "unknown"}`,
      summary: commandSummary
    }
  }

  return { ok: true, error: null, summary: commandSummary }
}

export type FocusedVerificationBaselineComparison = {
  nonWorsening: boolean
  baseSha: string | null
  candidateFailures: string[]
  baselineFailures: string[]
  error: string | null
}

function stripTerminalFormatting(value: string): string {
  const ansiSequence = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g")
  return value.replace(ansiSequence, "")
}

export function focusedVerificationFailureIdentifiers(output: string): string[] {
  const identifiers: string[] = []
  for (const rawLine of stripTerminalFormatting(output).split(/\r?\n/)) {
    const line = rawLine.trim().replace(/\s+/g, " ")
    const vitest = line.match(/^FAIL\s+(.+\s>\s.+)$/)
    if (vitest?.[1]) {
      identifiers.push(vitest[1])
      continue
    }
    const pytest = line.match(/^FAILED\s+([^\s]+::[^\s]+)(?:\s+-\s+.*)?$/)
    if (pytest?.[1]) identifiers.push(pytest[1])
  }
  return Array.from(new Set(identifiers)).sort()
}

export async function focusedVerificationFailureIsNonWorsening(
  repoPath: string,
  command: string,
  candidateOutput: string,
  timeoutMs = verificationTimeoutMs()
): Promise<FocusedVerificationBaselineComparison> {
  const candidateFailures = focusedVerificationFailureIdentifiers(candidateOutput)
  const emptyResult = (error: string, baseSha: string | null = null): FocusedVerificationBaselineComparison => ({
    nonWorsening: false,
    baseSha,
    candidateFailures,
    baselineFailures: [],
    error
  })
  if (candidateFailures.length === 0) {
    return emptyResult("candidate failure identifiers could not be parsed")
  }

  const baseRef = resolveExecutionBaseRef(repoPath)
  if (!gitCommitRefExists(repoPath, baseRef)) {
    return emptyResult(`execution base ref does not exist: ${baseRef}`)
  }
  const mergeBase = runCommand("git", ["merge-base", baseRef, "HEAD"], repoPath)
  if (!mergeBase.ok || !mergeBase.stdout.trim()) {
    return emptyResult(mergeBase.stderr.trim() || `failed to resolve merge base from ${baseRef}`)
  }
  const baseSha = mergeBase.stdout.trim()
  const baselineParent = mkdtempSync(join(tmpdir(), "openclaw-verification-baseline-"))
  const baselineWorktree = join(baselineParent, "repo")
  let registered = false
  try {
    const added = runCommand("git", ["worktree", "add", "--detach", baselineWorktree, baseSha], repoPath)
    if (!added.ok) {
      return emptyResult(added.stderr.trim() || "failed to allocate baseline verification worktree", baseSha)
    }
    registered = true
    if (nodeTestDependencyManifestsDiffer(repoPath, baselineWorktree)) {
      return emptyResult("dependency manifests differ from the execution branch", baseSha)
    }
    linkSharedExecutionDependencies(repoPath, baselineWorktree)
    const baseline = await executeShellAsync(command, {
      cwd: baselineWorktree,
      shell: preferredPosixShell(),
      timeoutMs,
      timeoutKillGraceMs: 5_000,
      maxBufferBytes: 1024 * 1024 * 10,
      terminateProcessGroup: true
    })
    if (baseline.ok && baseline.exitCode === 0) {
      return emptyResult("verification passes on the execution baseline", baseSha)
    }
    const baselineFailures = focusedVerificationFailureIdentifiers(`${baseline.stdout}\n${baseline.stderr}`)
    const baselineSet = new Set(baselineFailures)
    return {
      nonWorsening: baselineFailures.length > 0 && candidateFailures.every((identifier) => baselineSet.has(identifier)),
      baseSha,
      candidateFailures,
      baselineFailures,
      error: baselineFailures.length > 0 ? null : "baseline failure identifiers could not be parsed"
    }
  } catch (error) {
    return emptyResult(error instanceof Error ? error.message : String(error), baseSha)
  } finally {
    if (registered) {
      unlinkSharedExecutionDependencies(baselineWorktree)
      runCommand("git", ["worktree", "remove", "--force", baselineWorktree], repoPath)
    }
    rmSync(baselineParent, { recursive: true, force: true })
  }
}

export function componentSizeFailureIsNonWorsening(repoPath: string, output: string): boolean {
  const violations = Array.from(output.matchAll(/^- (.+): (\d+) lines \(max (\d+)\)$/gm)).map((match) => ({
    path: match[1]!,
    lines: Number.parseInt(match[2]!, 10)
  }))
  if (violations.length === 0) {
    return false
  }

  const baseRef = resolveExecutionBaseRef(repoPath)
  if (!gitCommitRefExists(repoPath, baseRef)) {
    return false
  }

  for (const violation of violations) {
    const candidatePaths = [
      violation.path,
      ...executionPolicyForRepo(repoPath).baselinePathRoots.map((root) => `${root}/${violation.path}`)
    ]
    let baseContent: string | null = null
    for (const candidatePath of candidatePaths) {
      const shown = runCommand("git", ["show", `${baseRef}:${candidatePath}`], repoPath)
      if (shown.ok) {
        baseContent = shown.stdout
        break
      }
    }
    if (baseContent === null) {
      return false
    }

    const baseParts = baseContent.split(/\r\n|\n|\r/)
    if (baseParts.at(-1) === "") baseParts.pop()
    if (violation.lines > baseParts.length) {
      return false
    }
  }

  return true
}

export function featureBoundaryFailureIsNonWorsening(repoPath: string, output: string): boolean {
  const violations = Array.from(output.matchAll(/^- (.+) imports (.+) \(feature: .+ -> .+\)$/gm)).map((match) => ({
    path: match[1]!,
    importedPath: match[2]!
  }))
  if (violations.length === 0) return false

  const baseRef = resolveExecutionBaseRef(repoPath)
  if (!gitCommitRefExists(repoPath, baseRef)) return false

  for (const violation of violations) {
    const candidatePaths = [
      violation.path,
      ...executionPolicyForRepo(repoPath).baselinePathRoots.map((root) => `${root}/${violation.path}`)
    ]
    let baseContent: string | null = null
    for (const candidatePath of candidatePaths) {
      const shown = runCommand("git", ["show", `${baseRef}:${candidatePath}`], repoPath)
      if (shown.ok) {
        baseContent = shown.stdout
        break
      }
    }
    if (
      baseContent === null ||
      (!baseContent.includes(`"${violation.importedPath}"`) && !baseContent.includes(`'${violation.importedPath}'`))
    ) {
      return false
    }
  }

  return true
}

function usageUnits(status: BudgetStatus, totalTokens: number | undefined): number {
  if (typeof totalTokens === "number" && Number.isFinite(totalTokens) && totalTokens > 0) {
    return totalTokens
  }

  // A run still counts against budget even when token data is unavailable.
  return status.agent.budgetLimit === null ? 1 : 1
}

type CommandResult = {
  ok: boolean
  stdout: string
  stderr: string
  status: number | null
}

function nextCronRun(cron: string, after: Date, timezone?: string | null): Date | null {
  try {
    return CronExpressionParser.parse(cron, {
      currentDate: after,
      tz: timezone ?? "UTC"
    })
      .next()
      .toDate()
  } catch {
    return null
  }
}

function isJobDue(jobSpec: JobSpec, at: Date): boolean {
  if (!jobSpec.lastTriggeredAt) {
    return true
  }

  const nextRun = nextCronRun(jobSpec.cron, new Date(jobSpec.lastTriggeredAt), jobSpec.timezone)
  return nextRun ? nextRun.getTime() <= at.getTime() : false
}

function activeCodexRuns(store: DispatcherStore, companyId?: string): number {
  const implementationRuns = store.listRunningRuns(companyId).filter((run) => run.adapterType === "codex_local").length
  const plannerRuns = store
    .listRunningPlannerRuns()
    .filter((run) => run.adapterType === "codex_local" && (!companyId || run.companyId === companyId)).length
  return implementationRuns + plannerRuns
}

function agentUsesManagedCodexQuota(agent: Agent): boolean {
  if (agent.adapterType !== "codex_local") return false
  const transport = (agent.env.OPENCLAW_CODEX_TRANSPORT ?? process.env.OPENCLAW_CODEX_TRANSPORT ?? "native")
    .trim()
    .toLowerCase()
  if (transport !== "direct") return false
  const explicit = agent.env.OPENCLAW_CODEX_ACCOUNT_POOL_ENABLED?.trim().toLowerCase()
  if (explicit) return explicit === "true"
  const command = agent.command?.trim()
  if (!command) return true
  return basename(command).replace(/\.exe$/i, "") === "codex"
}

export function selectAdapterHealthcheckAgent(agents: Agent[], adapterType: Agent["adapterType"]): Agent | null {
  return (
    agents.find(
      (agent) => agent.adapterType === adapterType && (agent.status === "idle" || agent.status === "running")
    ) ?? null
  )
}

function adapterHealthConfigurationFingerprint(agent: Agent | null): string | null {
  if (!agent) return null
  const configuration = [
    agent.id,
    agent.adapterType,
    agent.command ?? "",
    agent.model ?? "",
    agent.env.OPENCLAW_GEMINI_ACPX_AGENT_COMMAND ?? "",
    agent.env.OPENCLAW_GEMINI_ACPX_MODEL ?? ""
  ].join("\u0000")
  return createHash("sha256").update(configuration).digest("hex").slice(0, 16)
}

function plannerActiveTasks(tasks: Task[]): Task[] {
  return tasks.filter((task) => (task.status === "queued" || task.status === "running") && isCodeProducingTask(task))
}

export function plannerSatisfiedTaskIdsFromRuns(
  runs: Array<Pick<Run, "taskId" | "status" | "createdAt">>
): ReadonlySet<string> {
  const latestByTask = new Map<string, (typeof runs)[number]>()
  for (const run of runs) {
    const current = latestByTask.get(run.taskId)
    if (!current || run.createdAt.localeCompare(current.createdAt) > 0) {
      latestByTask.set(run.taskId, run)
    }
  }

  return new Set(
    Array.from(latestByTask.values())
      // A succeeded latest run already passed the task's execution and
      // verification contract. Promotion and review recovery own any remaining
      // delivery work; the planner must not turn that task back into a fresh
      // implementation fallback merely because its task row stayed blocked.
      .filter((run) => run.status === "succeeded")
      .map((run) => run.taskId)
  )
}

function codexQuotaDeferralReason(
  overview: CodexQuotaOverview | null,
  runningCodexRuns: number,
  applyManagedAccountQuota = true
): string | null {
  const configuredCap = envInt("OPENCLAW_MAX_CONCURRENT_CODEX_RUNS", 0)
  if (configuredCap > 0 && runningCodexRuns >= configuredCap) {
    return `Codex concurrency capped at ${configuredCap} by OPENCLAW_MAX_CONCURRENT_CODEX_RUNS`
  }

  if (!applyManagedAccountQuota || !overview || overview.accounts.length === 0 || overview.assessment === "unknown") {
    return null
  }

  if (overview.availableAccounts === 0) {
    return "all cached Codex accounts are exhausted"
  }

  const recommendedCap = overview.recommendedMaxConcurrentCodexRuns
  if (typeof recommendedCap === "number" && runningCodexRuns >= recommendedCap) {
    return `Codex concurrency capped at ${recommendedCap} based on available account headroom`
  }

  return null
}

function effectiveCodexConcurrencyLimit(overview: CodexQuotaOverview): number {
  const configured = Number.parseInt(process.env.OPENCLAW_MAX_CONCURRENT_CODEX_RUNS?.trim() ?? "", 10)
  if (Number.isFinite(configured) && configured > 0) return configured
  const recommended = overview.recommendedMaxConcurrentCodexRuns
  return typeof recommended === "number" && recommended > 0 ? recommended : maxConcurrentExecutionRunsPerTick()
}

function codexLaneStatus(
  status: CodexQuotaOverview["accounts"][number]["status"]
): "healthy" | "degraded" | "quota_exhausted" {
  if (status === "blocked") return "quota_exhausted"
  if (status === "warm" || status === "unknown") return "degraded"
  return "healthy"
}

function syncLaneHealthState(
  store: DispatcherStore,
  agents: Agent[],
  healthByAdapter: Record<string, AdapterHealthcheckResult>,
  codexQuota: CodexQuotaOverview
): void {
  const companyIds = Array.from(new Set(agents.map((agent) => agent.companyId)))
  const nowIso = new Date().toISOString()

  const upsertPoolHealth = (input: {
    companyId: string
    adapterType: Agent["adapterType"]
    laneLabel: string
    status: "healthy" | "degraded" | "quota_exhausted" | "auth_failed" | "rate_limited"
    reason: string
    cooldownUntil: string | null
    lastError: string | null
    lastSuccessAt: string | null
    metadata: Record<string, unknown>
    preserveCooldown?: boolean
  }) => {
    const existing = store.getAdapterLaneHealth(input.companyId, input.adapterType, "pool")
    const incomingFingerprint =
      typeof input.metadata.configurationFingerprint === "string" ? input.metadata.configurationFingerprint : null
    const existingFingerprint =
      typeof existing?.metadata.configurationFingerprint === "string"
        ? existing.metadata.configurationFingerprint
        : null
    const configurationChanged = Boolean(
      incomingFingerprint && existingFingerprint && incomingFingerprint !== existingFingerprint
    )
    const preserveExistingCooldown =
      input.preserveCooldown !== false &&
      !configurationChanged &&
      existing &&
      (existing.status === "rate_limited" ||
        existing.status === "quota_exhausted" ||
        existing.status === "auth_failed") &&
      laneIsCoolingDown(existing, nowIso) &&
      (input.status === "healthy" || input.status === "degraded")

    store.upsertAdapterLaneHealth({
      companyId: input.companyId,
      adapterType: input.adapterType,
      laneKey: "pool",
      laneLabel: input.laneLabel,
      status: preserveExistingCooldown ? existing.status : input.status,
      reason: preserveExistingCooldown ? existing.reason : input.reason,
      cooldownUntil: preserveExistingCooldown ? existing.cooldownUntil : input.cooldownUntil,
      lastError: preserveExistingCooldown ? existing.lastError : input.lastError,
      lastSuccessAt: preserveExistingCooldown ? existing.lastSuccessAt : input.lastSuccessAt,
      lastCheckedAt: nowIso,
      metadata: preserveExistingCooldown
        ? {
            ...input.metadata,
            preservedCooldown: true,
            preservedStatus: existing.status,
            preservedReason: existing.reason,
            preservedCooldownUntil: existing.cooldownUntil
          }
        : input.metadata
    })
  }

  for (const companyId of companyIds) {
    const adapterTypes = Array.from(
      new Set(agents.filter((agent) => agent.companyId === companyId).map((agent) => agent.adapterType))
    )
    for (const adapterType of adapterTypes) {
      const health = healthByAdapter[adapterType]
      if (!health) continue
      const healthcheckAgent = selectAdapterHealthcheckAgent(
        agents.filter((agent) => agent.companyId === companyId),
        adapterType
      )
      const status = health.ok ? "healthy" : classifyLaneStatusFromMessage(health.message)
      upsertPoolHealth({
        companyId,
        adapterType,
        laneLabel: `${adapterType} pool`,
        status,
        reason: health.message,
        cooldownUntil: health.ok ? null : defaultCooldownUntil(status),
        lastError: health.ok ? null : health.message,
        lastSuccessAt: health.ok ? nowIso : null,
        metadata: {
          source: "healthcheck",
          configurationFingerprint: adapterHealthConfigurationFingerprint(healthcheckAgent)
        }
      })
    }

    const companyCodexAgents = agents.filter(
      (agent) => agent.companyId === companyId && agent.adapterType === "codex_local"
    )
    if (companyCodexAgents.length === 0 || companyCodexAgents.every(agentUsesManagedCodexQuota)) {
      upsertPoolHealth({
        companyId,
        adapterType: "codex_local",
        laneLabel: "codex_local pool",
        status:
          codexQuota.assessment === "blocked"
            ? "quota_exhausted"
            : codexQuota.assessment === "degraded" || codexQuota.assessment === "unknown"
              ? "degraded"
              : "healthy",
        reason: `assessment=${codexQuota.assessment}; availableAccounts=${codexQuota.availableAccounts}`,
        cooldownUntil: codexQuota.assessment === "blocked" ? defaultCooldownUntil("quota_exhausted") : null,
        lastError: codexQuota.assessment === "blocked" ? "all cached Codex accounts are exhausted" : null,
        lastSuccessAt: codexQuota.availableAccounts > 0 ? nowIso : null,
        metadata: {
          source: "managed_codex_quota",
          assessment: codexQuota.assessment,
          activeAccount: codexQuota.activeAccount,
          bestAccount: codexQuota.bestAccount,
          availableAccounts: codexQuota.availableAccounts,
          healthyAccounts: codexQuota.healthyAccounts,
          warmAccounts: codexQuota.warmAccounts,
          blockedAccounts: codexQuota.blockedAccounts
        }
      })
    }

    for (const account of codexQuota.accounts) {
      const status = codexLaneStatus(account.status)
      store.upsertAdapterLaneHealth({
        companyId,
        adapterType: "codex_local",
        laneKey: `account:${account.name}`,
        laneLabel: account.name,
        status,
        reason: `quota cache status=${account.status}`,
        cooldownUntil: status === "quota_exhausted" ? defaultCooldownUntil("quota_exhausted") : null,
        lastError: status === "quota_exhausted" ? "quota cache reports account exhaustion" : null,
        lastSuccessAt: status === "healthy" ? nowIso : null,
        lastCheckedAt: nowIso,
        metadata: {
          active: account.active,
          cacheStale: account.cacheStale,
          weeklyUsed: account.effectiveWeeklyUsed,
          dailyUsed: account.effectiveDailyUsed,
          quotaSource: account.quotaSource
        }
      })
    }

    for (const lease of store.listRuntimeLeases(companyId, nowIso)) {
      const match = /^rate-limit:([^:]+)(?::(.+))?$/.exec(lease.scope)
      if (!match) continue
      const adapterType = match[1] as Agent["adapterType"]
      const laneKey = match[2]?.trim() || "pool"
      if (!["codex_local", "gemini_local", "azure_foundry"].includes(adapterType)) continue
      store.upsertAdapterLaneHealth({
        companyId,
        adapterType,
        laneKey,
        laneLabel: laneKey === "pool" ? `${adapterType} pool` : laneKey,
        status: "rate_limited",
        reason: `shared rate-limit lease held by ${lease.holder} until ${lease.expiresAt}`,
        cooldownUntil: lease.expiresAt,
        lastError: "predictive rate-limit circuit open",
        lastSuccessAt: null,
        lastCheckedAt: nowIso,
        metadata: {
          source: "runtime_lease",
          leaseId: lease.id,
          leaseKind: lease.leaseKind,
          holder: lease.holder,
          ...lease.metadata
        }
      })
    }
  }
}

function adapterPoolReason(
  store: DispatcherStore,
  companyId: string,
  adapterType: Agent["adapterType"],
  nowIso: string
): string | null {
  const lane = store.getAdapterLaneHealth(companyId, adapterType, "pool")
  if (!lane) return null
  if (lane.status === "healthy") return null
  if (laneIsCoolingDown(lane, nowIso)) {
    return lane.reason
      ? `${lane.reason}; cooldown_until=${lane.cooldownUntil}`
      : `cooldown active until ${lane.cooldownUntil}`
  }
  if (lane.status === "quota_exhausted" || lane.status === "auth_failed" || lane.status === "rate_limited") {
    return lane.reason ?? `${adapterType} pool is ${lane.status}`
  }
  return null
}

function adapterFailoverLadder(
  primary: Agent["adapterType"],
  routeLadder: readonly Agent["adapterType"][] = []
): Agent["adapterType"][] {
  const preferred: Agent["adapterType"][] =
    primary === "gemini_local"
      ? ["gemini_local", "codex_local", "azure_foundry"]
      : primary === "codex_local"
        ? ["codex_local", "azure_foundry", "gemini_local"]
        : ["azure_foundry", "codex_local", "gemini_local"]
  const seen = new Set<Agent["adapterType"]>()
  const ladder: Agent["adapterType"][] = [...preferred, ...routeLadder, "codex_local", "gemini_local", "azure_foundry"]
  return ladder.filter((adapterType) => {
    if (seen.has(adapterType)) return false
    seen.add(adapterType)
    return true
  })
}

function executionLane(
  provider: string | undefined,
  adapterType: Agent["adapterType"]
): { key: string; label: string } {
  if (provider && provider.includes(":")) {
    const [, suffix] = provider.split(":", 2)
    if (suffix?.trim()) {
      return {
        key: adapterType === "azure_foundry" ? `endpoint:${suffix.trim()}` : `lane:${suffix.trim()}`,
        label: suffix.trim()
      }
    }
  }
  return { key: "pool", label: `${adapterType} pool` }
}

function updateExecutionLaneHealth(input: {
  store: DispatcherStore
  companyId: string
  agent: Agent
  provider?: string | undefined
  ok: boolean
  message: string | null
}): void {
  const { store, companyId, agent, provider, ok, message } = input
  const adapterType = agent.adapterType
  const lane = executionLane(provider, adapterType)
  const nowIso = new Date().toISOString()
  const status = ok ? "healthy" : classifyLaneStatusFromMessage(message ?? `${adapterType} execution failed`)

  store.upsertAdapterLaneHealth({
    companyId,
    adapterType,
    laneKey: lane.key,
    laneLabel: lane.label,
    status,
    reason: message,
    cooldownUntil: ok ? null : defaultCooldownUntil(status),
    lastError: ok ? null : message,
    lastSuccessAt: ok ? nowIso : null,
    lastCheckedAt: nowIso,
    metadata: {
      source: "execution",
      provider: provider ?? adapterType,
      configurationFingerprint: adapterHealthConfigurationFingerprint(agent)
    }
  })

  if (lane.key !== "pool") {
    store.upsertAdapterLaneHealth({
      companyId,
      adapterType,
      laneKey: "pool",
      laneLabel: `${adapterType} pool`,
      status,
      reason: message,
      cooldownUntil: ok ? null : defaultCooldownUntil(status),
      lastError: ok ? null : message,
      lastSuccessAt: ok ? nowIso : null,
      lastCheckedAt: nowIso,
      metadata: {
        source: "execution_pool_rollup",
        provider: provider ?? adapterType,
        configurationFingerprint: adapterHealthConfigurationFingerprint(agent)
      }
    })
  }
}

function nextAutomationRunAt(automation: Automation, from: Date): string | null {
  const nextRun = nextCronRun(automation.cron, from)
  return nextRun ? nextRun.toISOString() : null
}

function runCommand(command: string, args: string[], cwd: string): CommandResult {
  const result = executeCommand(command, args, {
    cwd,
    env: commandEnv()
  })

  return {
    ok: result.ok,
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.exitCode
  }
}

function parsePorcelainPaths(stdout: string): string[] {
  const entries = stdout.split("\0").filter(Boolean)
  const paths: string[] = []

  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!
    if (entry.length < 4) continue
    const status = entry.slice(0, 2)
    const path = entry.slice(3)
    if (path) paths.push(path)
    if (status.includes("R") || status.includes("C")) {
      const originalPath = entries[index + 1]
      if (originalPath) paths.push(originalPath)
      index += 1
    }
  }

  return Array.from(new Set(paths))
}

function scopePrefixes(task: Task): string[] {
  const prefixes = [...task.changedFiles, ...task.allowedPaths].map((entry) => entry.replace(/^\/+/, ""))
  return Array.from(new Set(prefixes.filter(Boolean)))
}

function assertCleanOutsideRunScope(task: Task, changedFiles: string[]): void {
  const prefixes = scopePrefixes(task)
  if (prefixes.length === 0) return

  const outside = changedFiles.filter(
    (file) => !prefixes.some((prefix) => file === prefix || file.startsWith(`${prefix.replace(/\/+$/, "")}/`))
  )
  if (outside.length > 0) {
    throw new Error(`Working tree has changes outside run scope: ${outside.join(", ")}`)
  }
}

function nestedGitCheckoutRoot(cwd: string, relativePath: string): string | null {
  const parts = relativePath.replace(/\/+$/g, "").split("/").filter(Boolean)
  let current = ""

  for (const part of parts) {
    current = current ? join(current, part) : part
    if (existsSync(join(cwd, current, ".git"))) {
      return current
    }
  }

  return null
}

function sharedDependencyPaths(repoPath: string): Set<string> {
  const paths = executionDependencyPaths(repoPath)
  return new Set([...paths.shared, ...paths.isolated])
}

function isSharedExecutionDependencyPath(relativePath: string, paths: ReadonlySet<string>): boolean {
  const normalized = relativePath.replace(/\\/g, "/").replace(/\/+$/g, "")
  return paths.has(normalized)
}

function gitAddFailureIsIgnoredPath(result: CommandResult): boolean {
  const output = `${result.stderr}\n${result.stdout}`
  return /ignored by one of your \.gitignore files|use -f if you really want to add/i.test(output)
}

function stageRepositoryPath(cwd: string, path: string): CommandResult {
  const addResult = runCommand("git", ["add", "--", path], cwd)
  if (addResult.ok || !gitAddFailureIsIgnoredPath(addResult)) {
    return addResult
  }

  return runCommand("git", ["add", "-f", "--", path], cwd)
}

function stageRepositoryChanges(cwd: string): CommandResult & { skippedNestedGitCheckouts: string[] } {
  const dependencyPaths = sharedDependencyPaths(cwd)
  const status = runCommand("git", ["status", "--porcelain", "-z"], cwd)
  if (!status.ok) {
    return { ...status, skippedNestedGitCheckouts: [] }
  }

  const skippedNestedGitCheckouts: string[] = []
  for (const path of parsePorcelainPaths(status.stdout)) {
    if (isSharedExecutionDependencyPath(path, dependencyPaths)) {
      continue
    }

    const nestedRoot = nestedGitCheckoutRoot(cwd, path)
    if (nestedRoot) {
      if (!skippedNestedGitCheckouts.includes(nestedRoot)) {
        skippedNestedGitCheckouts.push(nestedRoot)
      }
      continue
    }

    const addResult = stageRepositoryPath(cwd, path)
    if (!addResult.ok) {
      return { ...addResult, skippedNestedGitCheckouts }
    }
  }

  return { ok: true, stdout: "", stderr: "", status: 0, skippedNestedGitCheckouts }
}

function currentBranch(cwd: string): string {
  const result = runCommand("git", ["branch", "--show-current"], cwd)
  if (!result.ok) {
    throw new Error(result.stderr.trim() || "Failed to resolve current branch")
  }
  return result.stdout.trim() || "HEAD"
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "task"
  )
}

function branchNameForTask(task: Task): string {
  const ref = task.workflowId ?? task.id
  return `openclaw/${ref.slice(0, 8)}-${slugify(task.title)}`
}

function gitCommitRefExists(repoPath: string, ref: string): boolean {
  return runCommand("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], repoPath).ok
}

function remoteDefaultBranch(repoPath: string): string | null {
  const result = runCommand("git", ["ls-remote", "--symref", "origin", "HEAD"], repoPath)
  if (!result.ok) return null
  const match = /^ref:\s+refs\/heads\/([^\s]+)\s+HEAD/m.exec(result.stdout)
  return match?.[1] ?? null
}

function baseBranchExists(repoPath: string, branchName: string): boolean {
  const remoteRef = `refs/remotes/origin/${branchName}`
  const fetch = runCommand("git", ["fetch", "origin", `+refs/heads/${branchName}:${remoteRef}`], repoPath)
  return fetch.ok && gitCommitRefExists(repoPath, remoteRef)
}

function resolvePromotionBaseBranch(repoPath: string, preferredBranch: string | null | undefined): string {
  const candidates = [preferredBranch?.trim() || null, remoteDefaultBranch(repoPath), "master", "main"].filter(
    (branch): branch is string => Boolean(branch)
  )

  for (const branch of Array.from(new Set(candidates))) {
    if (baseBranchExists(repoPath, branch)) return branch
  }

  return preferredBranch?.trim() || currentBranch(repoPath)
}

function resolvePromotionStartRef(input: {
  repoPath: string
  branchName: string
  headSha?: string | null
}): { ref: string; source: "local_branch" | "remote_branch" | "saved_head" } | { error: string } {
  const { repoPath, branchName, headSha } = input
  if (gitCommitRefExists(repoPath, branchName)) {
    return { ref: branchName, source: "local_branch" }
  }

  const remoteRef = `refs/remotes/origin/${branchName}`
  const fetch = runCommand("git", ["fetch", "origin", `+refs/heads/${branchName}:${remoteRef}`], repoPath)
  if (fetch.ok && gitCommitRefExists(repoPath, remoteRef)) {
    return { ref: remoteRef, source: "remote_branch" }
  }

  if (headSha && gitCommitRefExists(repoPath, headSha)) {
    return { ref: headSha, source: "saved_head" }
  }

  const details = fetch.stderr.trim() || fetch.stdout.trim()
  return {
    error:
      `Implementation branch ${branchName} is not available locally or on origin` +
      (headSha ? `, and saved head ${headSha} is not available in this checkout.` : ".") +
      (details ? ` git fetch said: ${details}` : "")
  }
}

function countPromotionCommitsAhead(input: {
  repoPath: string
  baseBranch: string
}): { ok: true; count: number; baseRef: string } | { ok: false; error: string } {
  const { repoPath, baseBranch } = input
  const remoteRef = `refs/remotes/origin/${baseBranch}`
  runCommand("git", ["fetch", "origin", `+refs/heads/${baseBranch}:${remoteRef}`], repoPath)
  const baseRef = gitCommitRefExists(repoPath, remoteRef) ? remoteRef : baseBranch
  if (!gitCommitRefExists(repoPath, baseRef)) {
    return { ok: false, error: `Base branch ${baseBranch} is not available locally or on origin.` }
  }

  const result = runCommand("git", ["rev-list", "--count", `${baseRef}..HEAD`], repoPath)
  if (!result.ok) {
    return { ok: false, error: result.stderr.trim() || "Failed to compare promotion branch with base." }
  }

  const count = Number.parseInt(result.stdout.trim(), 10)
  if (!Number.isFinite(count)) {
    return { ok: false, error: `Failed to parse ahead count from git rev-list: ${result.stdout.trim()}` }
  }
  return { ok: true, count, baseRef }
}

function synchronizePromotionWithBase(input: {
  repoPath: string
  baseBranch: string
}): { ok: true; baseRef: string; merged: boolean } | { ok: false; error: string; conflictedPaths: string[] } {
  const { repoPath, baseBranch } = input
  const remoteRef = `refs/remotes/origin/${baseBranch}`
  const fetch = runCommand("git", ["fetch", "origin", `+refs/heads/${baseBranch}:${remoteRef}`], repoPath)
  if (!fetch.ok) {
    const details = fetch.stderr.trim() || fetch.stdout.trim()
    return {
      ok: false,
      error: `Failed to fetch latest base branch origin/${baseBranch}.${details ? ` ${details}` : ""}`,
      conflictedPaths: []
    }
  }
  const baseRef = gitCommitRefExists(repoPath, remoteRef) ? remoteRef : baseBranch
  if (!gitCommitRefExists(repoPath, baseRef)) {
    const details = fetch.stderr.trim() || fetch.stdout.trim()
    return {
      ok: false,
      error: `Base branch ${baseBranch} is not available locally or on origin.${details ? ` ${details}` : ""}`,
      conflictedPaths: []
    }
  }

  const containsBase = runCommand("git", ["merge-base", "--is-ancestor", baseRef, "HEAD"], repoPath)
  if (containsBase.ok) {
    return { ok: true, baseRef, merged: false }
  }
  if (containsBase.status !== 1) {
    return {
      ok: false,
      error: containsBase.stderr.trim() || `Failed to compare promotion branch with ${baseRef}.`,
      conflictedPaths: []
    }
  }

  const merge = runCommand("git", ["merge", "--no-edit", "--no-stat", baseRef], repoPath)
  if (merge.ok) {
    return { ok: true, baseRef, merged: true }
  }

  const conflicts = runCommand("git", ["diff", "--name-only", "--diff-filter=U"], repoPath)
  const conflictedPaths = conflicts.ok
    ? conflicts.stdout
        .split("\n")
        .map((path) => path.trim())
        .filter(Boolean)
    : []
  runCommand("git", ["merge", "--abort"], repoPath)
  const details = merge.stderr.trim() || merge.stdout.trim()
  const conflictSummary = conflictedPaths.length > 0 ? ` Conflicts: ${conflictedPaths.join(", ")}.` : ""
  return {
    ok: false,
    error: `Failed to synchronize promotion branch with ${baseRef}.${conflictSummary}` + (details ? ` ${details}` : ""),
    conflictedPaths
  }
}

export function runBranchIsMergedIntoExecutionBase(
  repoPath: string,
  task: Task,
  run: Run,
  options: { fetchOrigin?: boolean } = {}
): boolean {
  const inferredBranchName = branchNameForRun(task, run.id)
  const candidateRef =
    run.branchName && gitCommitRefExists(repoPath, run.branchName)
      ? run.branchName
      : gitCommitRefExists(repoPath, inferredBranchName)
        ? inferredBranchName
        : run.headSha && gitCommitRefExists(repoPath, run.headSha)
          ? run.headSha
          : null
  if (!candidateRef) {
    return false
  }

  // A run branch is created before the agent starts and can therefore remain
  // parked on the execution base when inference or verification fails before
  // a task commit is written. Once the base branch advances, that empty branch
  // is also an ancestor of the base and must not be mistaken for delivered
  // implementation work.
  const subject = runCommand("git", ["log", "-1", "--format=%s", candidateRef], repoPath)
  if (!subject.ok || subject.stdout.trim() !== `openclaw: ${task.title}`) {
    return false
  }

  if (options.fetchOrigin !== false) {
    runCommand("git", ["fetch", "origin"], repoPath)
  }
  const baseRef = resolveExecutionBaseRef(repoPath)
  if (!gitCommitRefExists(repoPath, baseRef)) {
    return false
  }

  return runCommand("git", ["merge-base", "--is-ancestor", candidateRef, baseRef], repoPath).ok
}

type ExecutionWorkspace = {
  branchName: string
  baseRef?: string
  baseSha?: string
  worktreePath: string
  manifestPath: string
}

type PreservedExecutionWorkspace = {
  branchName: string
  headSha: string | null
  worktreePath: string
  manifestPath: string
}

type InheritedExecutionSource = {
  reason: "repair_source" | "review_repair" | "preserved_retry"
  taskId: string
  runId: string
  branchName: string
  ref: string
  source: "local_branch" | "remote_branch" | "saved_head"
  worktreePath: string | null
  manifestPath: string | null
}

type DiskHeadroomCheck = {
  ok: boolean
  path: string
  availableBytes: number
  totalBytes: number
  requiredBytes: number
  availablePercent: number
  message: string
}

function branchNameForRun(task: Task, runId: string): string {
  return `openclaw/run/${runId.slice(0, 8)}-${slugify(task.title)}`
}

function worktreeRootForProject(project: Project, profile: ProjectProfile | null): string {
  const configured = profile?.artifactPolicy?.worktreeRootDir
  if (configured?.trim()) {
    return isAbsolute(configured) ? configured : resolve(project.repoPath, configured)
  }
  return join(project.repoPath, ".openclaw", "worktrees")
}

function envNonNegativeNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function minWorktreeFreeBytes(): number {
  return envNonNegativeNumber("OPENCLAW_MIN_WORKTREE_FREE_BYTES", 2 * 1024 * 1024 * 1024)
}

function minWorktreeFreePercent(): number {
  return envNonNegativeNumber("OPENCLAW_MIN_WORKTREE_FREE_PERCENT", 5)
}

function formatBytes(value: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"]
  let scaled = value
  let unit = 0
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024
    unit += 1
  }
  return `${scaled.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

function checkWorktreeDiskHeadroom(root: string): DiskHeadroomCheck {
  mkdirSync(root, { recursive: true })
  const stats = statfsSync(root)
  const availableBytes = Number(stats.bavail) * Number(stats.bsize)
  const totalBytes = Number(stats.blocks) * Number(stats.bsize)
  const percentRequirement = totalBytes * (minWorktreeFreePercent() / 100)
  const requiredBytes = Math.max(minWorktreeFreeBytes(), percentRequirement)
  const availablePercent = totalBytes > 0 ? (availableBytes / totalBytes) * 100 : 0
  const message = `Worktree filesystem has ${formatBytes(availableBytes)} free (${availablePercent.toFixed(
    1
  )}%); requires at least ${formatBytes(requiredBytes)}.`

  return {
    ok: availableBytes >= requiredBytes,
    path: root,
    availableBytes,
    totalBytes,
    requiredBytes,
    availablePercent,
    message
  }
}

function isDiskSpaceWorktreeError(message: string): boolean {
  return /no space left|enospc|disk full|unable to write file|cannot create directory/i.test(message)
}

function projectSupportsGitWorktrees(project: Project): boolean {
  if (!commandExists("git")) return false
  const result = runCommand("git", ["rev-parse", "--is-inside-work-tree"], project.repoPath)
  return result.ok && result.stdout.trim() === "true"
}

function existingGitRef(repoPath: string, ref: string): string | null {
  const result = runCommand("git", ["show-ref", "--verify", "--quiet", ref], repoPath)
  return result.ok ? ref : null
}

function resolveExecutionBaseRef(repoPath: string): string {
  const originHead = runCommand("git", ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], repoPath)
  if (originHead.ok) {
    const remoteHead = originHead.stdout.trim()
    if (remoteHead.startsWith("origin/")) {
      const branch = remoteHead.slice("origin/".length)
      const ref = existingGitRef(repoPath, `refs/remotes/origin/${branch}`)
      if (ref) return `origin/${branch}`
    }
  }

  for (const branch of ["main", "master"]) {
    const remoteRef = existingGitRef(repoPath, `refs/remotes/origin/${branch}`)
    if (remoteRef) return `origin/${branch}`

    const localRef = existingGitRef(repoPath, `refs/heads/${branch}`)
    if (localRef) return branch
  }

  return "HEAD"
}

function prepareExecutionWorkspace(input: {
  project: Project
  profile: ProjectProfile | null
  task: Task
  runId: string
  baseRef?: string
}): ExecutionWorkspace {
  const root = worktreeRootForProject(input.project, input.profile)
  mkdirSync(root, { recursive: true })

  const branchName = branchNameForRun(input.task, input.runId)
  const workspaceName = `${input.runId.slice(0, 8)}-${slugify(input.task.title)}`
  const worktreePath = join(root, workspaceName)
  const manifestPath = join(root, `${workspaceName}.manifest.json`)

  if (existsSync(worktreePath)) {
    unlinkSharedExecutionDependencies(worktreePath)
    rmSync(worktreePath, { recursive: true, force: true })
  }

  runCommand("git", ["worktree", "prune"], input.project.repoPath)
  const baseRef = input.baseRef ?? resolveExecutionBaseRef(input.project.repoPath)
  const base = runCommand("git", ["rev-parse", baseRef], input.project.repoPath)
  if (!base.ok) {
    throw new Error(base.stderr.trim() || `Failed to resolve execution base ${baseRef}`)
  }
  const baseSha = base.stdout.trim()
  const add = runCommand("git", ["worktree", "add", "-B", branchName, worktreePath, baseRef], input.project.repoPath)
  if (!add.ok) {
    throw new Error(add.stderr.trim() || `Failed to create execution worktree from ${baseRef}`)
  }

  linkSharedExecutionDependencies(input.project.repoPath, worktreePath)

  writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        taskId: input.task.id,
        runId: input.runId,
        branchName,
        baseRef,
        baseSha,
        worktreePath,
        createdAt: new Date().toISOString()
      },
      null,
      2
    )
  )

  return { branchName, baseRef, baseSha, worktreePath, manifestPath }
}

function preparePromotionWorkspace(input: {
  project: Project
  profile: ProjectProfile | null
  task: Task
  runId: string
  branchName: string
  startRef: string
}): ExecutionWorkspace {
  const root = worktreeRootForProject(input.project, input.profile)
  mkdirSync(root, { recursive: true })

  const workspaceName = `promotion-${input.runId.slice(0, 8)}-${slugify(input.task.title)}`
  const worktreePath = join(root, workspaceName)
  const manifestPath = join(root, `${workspaceName}.manifest.json`)

  if (existsSync(worktreePath)) {
    unlinkSharedExecutionDependencies(worktreePath)
    runCommand("git", ["worktree", "remove", "--force", worktreePath], input.project.repoPath)
    rmSync(worktreePath, { recursive: true, force: true })
  }

  runCommand("git", ["worktree", "prune"], input.project.repoPath)
  const base = runCommand("git", ["rev-parse", input.startRef], input.project.repoPath)
  if (!base.ok) {
    throw new Error(base.stderr.trim() || `Failed to resolve promotion base ${input.startRef}`)
  }
  const baseSha = base.stdout.trim()
  const add = runCommand(
    "git",
    ["worktree", "add", "-B", input.branchName, worktreePath, input.startRef],
    input.project.repoPath
  )
  if (!add.ok) {
    throw new Error(add.stderr.trim() || `Failed to create promotion worktree from ${input.startRef}`)
  }

  writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        taskId: input.task.id,
        runId: input.runId,
        branchName: input.branchName,
        baseRef: input.startRef,
        baseSha,
        worktreePath,
        kind: "promotion",
        createdAt: new Date().toISOString()
      },
      null,
      2
    )
  )

  return {
    branchName: input.branchName,
    baseRef: input.startRef,
    baseSha,
    worktreePath,
    manifestPath
  }
}

export type DiffNumstatEntry = {
  path: string
  added: number
  deleted: number
}

export function deterministicFallbackDiffBudgetViolation(entries: DiffNumstatEntry[]): string | null {
  const perFileLimit = 400
  const totalLimit = 800
  const oversizedFile = entries.find((entry) => entry.added + entry.deleted > perFileLimit)
  if (oversizedFile) {
    return `${oversizedFile.path} changes ${oversizedFile.added + oversizedFile.deleted} lines (limit ${perFileLimit})`
  }
  const total = entries.reduce((sum, entry) => sum + entry.added + entry.deleted, 0)
  return total > totalLimit ? `the patch changes ${total} lines (limit ${totalLimit})` : null
}

function isTestEvidencePath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").toLowerCase()
  const fileName = normalized.split("/").at(-1) ?? normalized
  return (
    /(^|\/)(?:__tests__|tests?|e2e|fixtures?|snapshots?)(\/|$)/.test(normalized) ||
    /\.(?:test|spec)\.[^/]+$/.test(fileName) ||
    /\.snap$/.test(fileName) ||
    /^(?:conftest\.py|pytest\.ini|vitest\.config\.[^/]+|jest\.config\.[^/]+)$/.test(fileName)
  )
}

export function deterministicFallbackTestOnlyViolation(paths: string[], cwd = process.cwd()): string | null {
  const dependencyPaths = sharedDependencyPaths(cwd)
  const meaningfulPaths = Array.from(
    new Set(
      paths.map((path) => path.trim()).filter((path) => path && !isSharedExecutionDependencyPath(path, dependencyPaths))
    )
  )
  if (meaningfulPaths.length === 0 || meaningfulPaths.some((path) => !isTestEvidencePath(path))) {
    return null
  }
  return `the patch changes only test evidence: ${meaningfulPaths.join(", ")}`
}

function executionWorkspaceDiffNumstat(worktree: ExecutionWorkspace): DiffNumstatEntry[] {
  if (!worktree.baseSha) return []
  const diff = runCommand("git", ["diff", "--numstat", worktree.baseSha, "--"], worktree.worktreePath)
  if (!diff.ok) {
    throw new Error(diff.stderr.trim() || "Failed to inspect execution worktree change size")
  }
  return diff.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const [added, deleted, ...pathParts] = line.split("\t")
      if (!/^\d+$/.test(added ?? "") || !/^\d+$/.test(deleted ?? "") || pathParts.length === 0) return []
      return [
        {
          path: pathParts.join("\t"),
          added: Number.parseInt(added!, 10),
          deleted: Number.parseInt(deleted!, 10)
        }
      ]
    })
}

function executionWorkspaceMeaningfulChangedPaths(worktree: ExecutionWorkspace): string[] {
  const dependencyPaths = sharedDependencyPaths(worktree.worktreePath)
  const status = runCommand("git", ["status", "--porcelain", "-z", "--untracked-files=all"], worktree.worktreePath)
  if (!status.ok) {
    throw new Error(status.stderr.trim() || "Failed to inspect execution worktree status")
  }
  const meaningfulPaths = parsePorcelainPaths(status.stdout).filter(
    (path) => !isSharedExecutionDependencyPath(path, dependencyPaths)
  )
  if (worktree.baseSha) {
    const diff = runCommand("git", ["diff", "--name-only", "-z", worktree.baseSha, "--"], worktree.worktreePath)
    if (!diff.ok) {
      throw new Error(diff.stderr.trim() || "Failed to inspect execution worktree changed paths")
    }
    meaningfulPaths.push(
      ...diff.stdout
        .split("\0")
        .map((path) => path.trim())
        .filter((path) => path && !isSharedExecutionDependencyPath(path, dependencyPaths))
    )
  }
  return Array.from(new Set(meaningfulPaths))
}

function executionWorkspaceCumulativeChangedPaths(worktree: ExecutionWorkspace, comparisonBaseRef?: string): string[] {
  const dependencyPaths = sharedDependencyPaths(worktree.worktreePath)
  const meaningfulPaths = executionWorkspaceMeaningfulChangedPaths(worktree)
  const defaultBaseRef = comparisonBaseRef ?? resolveExecutionBaseRef(worktree.worktreePath)
  const mergeBase = runCommand("git", ["merge-base", defaultBaseRef, "HEAD"], worktree.worktreePath)
  if (!mergeBase.ok) {
    throw new Error(mergeBase.stderr.trim() || `Failed to resolve cumulative execution base from ${defaultBaseRef}`)
  }
  const diff = runCommand(
    "git",
    ["diff", "--name-only", "-z", mergeBase.stdout.trim(), "HEAD", "--"],
    worktree.worktreePath
  )
  if (!diff.ok) {
    throw new Error(diff.stderr.trim() || "Failed to inspect cumulative inherited execution changed paths")
  }
  meaningfulPaths.push(
    ...diff.stdout
      .split("\0")
      .map((path) => path.trim())
      .filter((path) => path && !isSharedExecutionDependencyPath(path, dependencyPaths))
  )
  return Array.from(new Set(meaningfulPaths))
}

function executionWorkspaceHasMeaningfulChanges(worktree: ExecutionWorkspace): boolean {
  if (executionWorkspaceMeaningfulChangedPaths(worktree).length > 0) return true
  if (!worktree.baseSha) {
    return false
  }

  const head = runCommand("git", ["rev-parse", "HEAD"], worktree.worktreePath)
  if (!head.ok) {
    throw new Error(head.stderr.trim() || "Failed to resolve execution worktree HEAD")
  }
  const ahead = runCommand(
    "git",
    ["rev-list", "--count", `${worktree.baseSha}..${head.stdout.trim()}`],
    worktree.worktreePath
  )
  if (!ahead.ok) {
    throw new Error(ahead.stderr.trim() || "Failed to compare execution worktree HEAD with its base")
  }
  return Number.parseInt(ahead.stdout.trim(), 10) > 0
}

function captureWorkspaceChanges(input: { worktree: ExecutionWorkspace; task: Task }): {
  headSha: string
  committed: boolean
  skippedNestedGitCheckouts: string[]
} {
  if (input.task.labels.includes("deterministic-fallback")) {
    const violation = deterministicFallbackDiffBudgetViolation(executionWorkspaceDiffNumstat(input.worktree))
    if (violation) {
      throw new Error(
        `Deterministic fallback exceeded its narrow change budget: ${violation}. Remove unrelated formatting or split the work before promotion.`
      )
    }
  }

  const status = runCommand("git", ["status", "--porcelain"], input.worktree.worktreePath)
  if (!status.ok) {
    throw new Error(status.stderr.trim() || "Failed to inspect execution worktree status")
  }

  let committed = false
  let skippedNestedGitCheckouts: string[] = []
  if (status.stdout.trim()) {
    const addResult = stageRepositoryChanges(input.worktree.worktreePath)
    if (!addResult.ok) {
      throw new Error(addResult.stderr.trim() || "Failed to stage execution worktree changes")
    }
    skippedNestedGitCheckouts = addResult.skippedNestedGitCheckouts

    const stagedDiff = runCommand("git", ["diff", "--cached", "--quiet"], input.worktree.worktreePath)
    if (!stagedDiff.ok && stagedDiff.status !== 1) {
      throw new Error(stagedDiff.stderr.trim() || "Failed to inspect staged execution worktree changes")
    }
    if (stagedDiff.status === 1) {
      const commit = runCommand("git", ["commit", "-m", `openclaw: ${input.task.title}`], input.worktree.worktreePath)
      if (!commit.ok && !commit.stderr.includes("nothing to commit")) {
        throw new Error(commit.stderr.trim() || "Failed to commit execution worktree changes")
      }
      committed = commit.ok
    }
  }

  const head = runCommand("git", ["rev-parse", "HEAD"], input.worktree.worktreePath)
  if (!head.ok) {
    throw new Error(head.stderr.trim() || "Failed to resolve execution worktree HEAD")
  }
  const headSha = head.stdout.trim()
  if (!committed && input.worktree.baseSha) {
    const ahead = runCommand(
      "git",
      ["rev-list", "--count", `${input.worktree.baseSha}..${headSha}`],
      input.worktree.worktreePath
    )
    if (!ahead.ok) {
      throw new Error(ahead.stderr.trim() || "Failed to compare execution worktree HEAD with its base")
    }
    committed = Number.parseInt(ahead.stdout.trim(), 10) > 0
  }
  return { headSha, committed, skippedNestedGitCheckouts }
}

function captureRepositoryChanges(input: { repoPath: string; task: Task; runId: string }): {
  branchName: string
  baseBranch: string
  headSha: string
  committed: boolean
  skippedNestedGitCheckouts: string[]
} {
  const branchName = branchNameForRun(input.task, input.runId)
  const changedFiles = parsePorcelainPaths(runCommand("git", ["status", "--porcelain", "-z"], input.repoPath).stdout)
  assertCleanOutsideRunScope(input.task, changedFiles)

  const baseBranch = currentBranch(input.repoPath)
  const existing = runCommand("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], input.repoPath)
  const checkout =
    existing.ok && baseBranch !== branchName
      ? runCommand("git", ["switch", branchName], input.repoPath)
      : baseBranch === branchName
        ? { ok: true, stdout: "", stderr: "", status: 0 }
        : runCommand("git", ["switch", "-c", branchName], input.repoPath)
  if (!checkout.ok) {
    throw new Error(checkout.stderr.trim() || `Failed to create branch ${branchName}`)
  }

  const status = runCommand("git", ["status", "--porcelain"], input.repoPath)
  if (!status.ok) {
    throw new Error(status.stderr.trim() || "Failed to inspect repository status")
  }

  let committed = false
  let skippedNestedGitCheckouts: string[] = []
  if (status.stdout.trim()) {
    const addResult = stageRepositoryChanges(input.repoPath)
    if (!addResult.ok) {
      throw new Error(addResult.stderr.trim() || "Failed to stage repository changes")
    }
    skippedNestedGitCheckouts = addResult.skippedNestedGitCheckouts

    const stagedDiff = runCommand("git", ["diff", "--cached", "--quiet"], input.repoPath)
    if (!stagedDiff.ok && stagedDiff.status !== 1) {
      throw new Error(stagedDiff.stderr.trim() || "Failed to inspect staged repository changes")
    }
    if (stagedDiff.status === 1) {
      const commit = runCommand("git", ["commit", "-m", `openclaw: ${input.task.title}`], input.repoPath)
      if (!commit.ok && !commit.stderr.includes("nothing to commit")) {
        throw new Error(commit.stderr.trim() || "Failed to commit repository changes")
      }
      committed = commit.ok
    }
  }

  const head = runCommand("git", ["rev-parse", "HEAD"], input.repoPath)
  if (!head.ok) {
    throw new Error(head.stderr.trim() || "Failed to resolve repository HEAD")
  }
  return {
    branchName,
    baseBranch,
    headSha: head.stdout.trim(),
    committed,
    skippedNestedGitCheckouts
  }
}

function cleanupExecutionWorkspace(project: Project, worktree: ExecutionWorkspace): CommandResult {
  unlinkSharedExecutionDependencies(worktree.worktreePath)
  const remove = runCommand("git", ["worktree", "remove", "--force", worktree.worktreePath], project.repoPath)
  if (remove.ok) {
    rmSync(worktree.manifestPath, { force: true })
    return remove
  }
  rmSync(worktree.worktreePath, { recursive: true, force: true })
  rmSync(worktree.manifestPath, { force: true })
  return { ok: true, stdout: "", stderr: remove.stderr, status: 0 }
}

function extractRepoSlug(project: Project): string | null {
  const remote = runCommand("git", ["remote", "get-url", "origin"], project.repoPath)
  if (!remote.ok) return null
  const value = remote.stdout.trim()
  const sshMatch = /[:/]([^/:]+\/[^/]+?)(?:\.git)?$/.exec(value)
  return sshMatch?.[1] ?? null
}

function summarizeChecks(statusCheckRollup: unknown): { passing: boolean; pending: boolean; failing: boolean } {
  if (!Array.isArray(statusCheckRollup) || statusCheckRollup.length === 0) {
    return { passing: true, pending: false, failing: false }
  }

  let pending = false
  let failing = false
  for (const entry of statusCheckRollup) {
    if (!entry || typeof entry !== "object") continue
    const record = entry as Record<string, unknown>
    const status = typeof record.status === "string" ? record.status.toUpperCase() : null
    const conclusion = typeof record.conclusion === "string" ? record.conclusion.toUpperCase() : null
    const state = typeof record.state === "string" ? record.state.toUpperCase() : null
    if (status === "PENDING" || status === "IN_PROGRESS" || state === "PENDING") {
      pending = true
    }
    if (
      conclusion === "FAILURE" ||
      conclusion === "TIMED_OUT" ||
      conclusion === "CANCELLED" ||
      conclusion === "ACTION_REQUIRED" ||
      state === "FAILURE"
    ) {
      failing = true
    }
  }

  return {
    passing: !pending && !failing,
    pending,
    failing
  }
}

function reviewDecisionApproved(reviewDecision: unknown): boolean {
  return typeof reviewDecision === "string" && reviewDecision.toUpperCase() === "APPROVED"
}

function mergeFlagForMethod(method: PromotionRecord["mergeMethod"]): "--squash" | "--merge" | "--rebase" {
  switch (method) {
    case "merge":
      return "--merge"
    case "rebase":
      return "--rebase"
    case "squash":
      return "--squash"
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function nextReleaseTag(tags: string[], releaseTagBase: string | null | undefined): string {
  const base = releaseTagBase?.trim()
  if (base) {
    const normalizedBase = base.startsWith("v") ? base : `v${base}`
    const matcher = new RegExp(`^${escapeRegExp(normalizedBase)}(?:\\.(\\d+))?$`)
    let maxSuffix = 0
    for (const tag of tags) {
      const match = matcher.exec(tag.trim())
      if (!match) continue
      maxSuffix = Math.max(maxSuffix, Number.parseInt(match[1] ?? "0", 10))
    }
    return `${normalizedBase}.${maxSuffix + 1}`
  }

  const incrementSemanticTag = (tag: string): string | null => {
    const match = tag.trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?$/)
    if (!match) return null
    const major = Number.parseInt(match[1]!, 10)
    if (!match[2]) return `v${major}.0.1`
    const minor = Number.parseInt(match[2], 10)
    if (!match[3]) return `v${major}.${minor + 1}`
    const patch = Number.parseInt(match[3], 10)
    if (match[4]) {
      return `v${major}.${minor}.${patch}.${Number.parseInt(match[4], 10) + 1}`
    }
    return `v${major}.${minor}.${patch + 1}`
  }

  const versions = tags
    .map((tag) => {
      const match = tag.trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?$/)
      if (!match) return null
      return {
        tag,
        parts: [
          Number.parseInt(match[1]!, 10),
          Number.parseInt(match[2] ?? "0", 10),
          match[3] ? Number.parseInt(match[3], 10) : null,
          match[4] ? Number.parseInt(match[4], 10) : null
        ] as const
      }
    })
    .filter((entry): entry is { tag: string; parts: readonly [number, number, number | null, number | null] } =>
      Boolean(entry)
    )
    .sort((left, right) => {
      for (let index = 0; index < 4; index += 1) {
        const delta = (right.parts[index] ?? -1) - (left.parts[index] ?? -1)
        if (delta !== 0) return delta
      }
      return 0
    })

  const latest = versions[0]
  if (!latest) return "v0.1.0.1"
  return incrementSemanticTag(latest.tag) ?? "v0.1.0.1"
}

function releaseNotesForPromotion(input: {
  task: Task
  promotion: PromotionRecord
  prNumber: number | null
  prUrl: string | null
  headSha: string
}): string {
  const taskPackage = input.task.taskPackage
  const persona = taskPackage?.personaProvenance?.personaId ?? input.task.personaId ?? input.task.stage ?? "unassigned"
  const acceptance = taskPackage?.acceptanceCriteria?.length
    ? taskPackage.acceptanceCriteria.map((item) => `  - ${item}`).join("\n")
    : "  - Not captured."
  return [
    `Automated OpenClaw release for ${input.task.title}.`,
    "",
    `- Promotion: ${input.promotion.id}`,
    `- Pull request: ${input.prNumber ? `#${input.prNumber}` : "n/a"}`,
    `- Pull request URL: ${input.prUrl ?? "n/a"}`,
    `- Target SHA: ${input.headSha}`,
    `- Persona: ${persona}`,
    `- Lane: ${input.task.laneId ?? taskPackage?.likelyOwnershipLane ?? "n/a"}`,
    `- Portfolio bucket: ${taskPackage?.portfolioBucket ?? "n/a"}`,
    `- Task source: ${taskPackage?.taskSourceIntent ?? input.task.source}`,
    `- User outcome: ${taskPackage?.userOutcome ?? input.task.description ?? input.task.title}`,
    "",
    "Acceptance criteria:",
    acceptance,
    "",
    "This release was created after the promotion PR merged successfully."
  ].join("\n")
}

function publishedReleaseUrl(repoSlug: string, tagName: string): string {
  return `https://github.com/${repoSlug}/releases/tag/${tagName}`
}

function createPromotionRelease(input: {
  project: Project
  task: Task
  promotion: PromotionRecord
  prNumber: number | null
  prUrl: string | null
  headSha: string
  targetRef: string
  releaseTagBase?: string | null | undefined
}): { ok: true; tagName: string; url: string; notes: string } | { ok: false; error: string } {
  const repoSlug = extractRepoSlug(input.project)
  if (!repoSlug) return { ok: false, error: "could not resolve GitHub repo slug from origin remote" }

  const list = runCommand(
    "gh",
    [
      "release",
      "list",
      "--repo",
      repoSlug,
      "--limit",
      "100",
      "--json",
      "tagName,isDraft,isPrerelease,publishedAt,createdAt"
    ],
    input.project.repoPath
  )
  if (!list.ok) {
    return { ok: false, error: list.stderr.trim() || list.stdout.trim() || "failed to list GitHub releases" }
  }

  let tags: string[] = []
  try {
    const releases = JSON.parse(list.stdout || "[]") as Array<Record<string, unknown>>
    tags = releases
      .filter((release) => release.isDraft !== true && release.isPrerelease !== true)
      .map((release) => (typeof release.tagName === "string" ? release.tagName.trim() : ""))
      .filter(Boolean)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }

  const tagName = nextReleaseTag(tags, input.releaseTagBase)
  const notes = releaseNotesForPromotion({
    task: input.task,
    promotion: input.promotion,
    prNumber: input.prNumber,
    prUrl: input.prUrl,
    headSha: input.headSha
  })
  const create = runCommand(
    "gh",
    [
      "release",
      "create",
      tagName,
      "--repo",
      repoSlug,
      "--target",
      input.targetRef,
      "--title",
      tagName,
      "--notes",
      notes
    ],
    input.project.repoPath
  )
  if (!create.ok) {
    return { ok: false, error: create.stderr.trim() || create.stdout.trim() || "failed to create GitHub release" }
  }

  return { ok: true, tagName, url: publishedReleaseUrl(repoSlug, tagName), notes }
}

function verificationChecksFromRollup(statusCheckRollup: unknown): VerificationCheckResult[] {
  if (!Array.isArray(statusCheckRollup)) return []
  const checks: VerificationCheckResult[] = []
  for (const entry of statusCheckRollup) {
    if (!entry || typeof entry !== "object") continue
    const record = entry as Record<string, unknown>
    const name =
      (typeof record.name === "string" && record.name) ||
      (typeof record.context === "string" && record.context) ||
      "check"
    const conclusion = typeof record.conclusion === "string" ? record.conclusion.toUpperCase() : null
    const state = typeof record.state === "string" ? record.state.toUpperCase() : null
    const passed =
      conclusion === "SUCCESS" || conclusion === "NEUTRAL" || conclusion === "SKIPPED" || state === "SUCCESS"
    checks.push({ command: name, passed })
  }
  return checks
}

function verificationSummaryLooksPassed(summary: string | null): boolean {
  if (!summary?.trim()) return false
  const normalized = summary.toLowerCase()
  if (/\b(no verification command|none|verification gate blocked)\b/.test(normalized)) return false
  return !/\b(fail(?:ed|ing)?|error|timed out|cancelled|blocked)\b/.test(normalized)
}

function localVerificationChecksForPromotion(
  store: DispatcherStore,
  promotionSubject: Task
): VerificationCheckResult[] {
  const relevantTaskIds = new Set<string>([
    promotionSubject.id,
    ...store.listChildTasks(promotionSubject.id).map((child) => child.id)
  ])
  const verifiedRuns = store
    .listRuns(20000)
    .filter(
      (run) =>
        relevantTaskIds.has(run.taskId) &&
        run.status === "succeeded" &&
        verificationSummaryLooksPassed(run.verificationSummary)
    )
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))

  if (verifiedRuns.length === 0) return []

  const summaries = Array.from(
    new Set(
      verifiedRuns.map((run) => run.verificationSummary?.trim()).filter((value): value is string => Boolean(value))
    )
  )
  return [
    {
      command: `local verification: ${summaries.slice(0, 3).join("; ")}`,
      passed: true
    }
  ]
}

function reviewVerdictFromDecision(reviewDecision: unknown): ReviewVerdict | null {
  if (typeof reviewDecision !== "string") return null
  switch (reviewDecision.toUpperCase()) {
    case "APPROVED":
      return "approved"
    case "CHANGES_REQUESTED":
      return "changes_requested"
    default:
      return null
  }
}

function extractBlockingThreads(payload: unknown): Array<Record<string, unknown>> {
  const repository =
    payload && typeof payload === "object" && "data" in payload ? (payload as Record<string, unknown>).data : null
  const pullRequest =
    repository && typeof repository === "object" && "repository" in repository
      ? (repository as Record<string, unknown>).repository
      : null
  const threads =
    pullRequest && typeof pullRequest === "object" && "pullRequest" in pullRequest
      ? (pullRequest as Record<string, unknown>).pullRequest
      : null
  const nodes =
    threads && typeof threads === "object" && "reviewThreads" in threads
      ? (threads as Record<string, unknown>).reviewThreads
      : null
  const list = nodes && typeof nodes === "object" && "nodes" in nodes ? (nodes as Record<string, unknown>).nodes : null

  if (!Array.isArray(list)) return []

  return list.filter((entry) => {
    if (!entry || typeof entry !== "object") return false
    const record = entry as Record<string, unknown>
    return record.isResolved !== true && record.isOutdated !== true
  }) as Array<Record<string, unknown>>
}

function dependencySatisfied(store: DispatcherStore, task: Task): boolean {
  return task.dependsOnTaskIds.every((taskId) => {
    const dependency = store.getTaskById(taskId)
    if (task.kind === "review") {
      return (
        dependency.status === "review_needed" ||
        dependency.status === "promotion_pending" ||
        dependency.status === "done"
      )
    }
    if (task.kind === "promote") {
      return dependency.status === "promotion_pending" || dependency.status === "done"
    }
    return dependency.status === "done"
  })
}

function terminalDependencyBlockers(store: DispatcherStore, task: Task): Task[] {
  return task.dependsOnTaskIds
    .map((taskId) => store.getTaskById(taskId))
    .filter((dependency) => dependency.status === "failed" || dependency.status === "blocked")
}

function executionPathForTask(
  store: DispatcherStore,
  task: Task,
  agent: Agent,
  runId: string,
  persona: Persona | null
): TelemetryPathNode[] {
  const path: TelemetryPathNode[] = []

  if (task.workflowId) {
    path.push({
      kind: "workflow",
      id: task.workflowId,
      label: task.workflowId.slice(0, 8),
      metadata: {
        projectId: task.projectId
      }
    })
  }

  const seen = new Set<string>()
  const lineage: Task[] = []
  let cursor: Task | null = task
  while (cursor && !seen.has(cursor.id)) {
    lineage.unshift(cursor)
    seen.add(cursor.id)
    const parentId = cursor.parentTaskId ?? cursor.lineageParentId
    if (!parentId) break
    try {
      cursor = store.getTaskById(parentId)
    } catch {
      break
    }
  }

  for (const entry of lineage) {
    path.push({
      kind: "task",
      id: entry.id,
      label: entry.title,
      metadata: {
        kind: entry.kind,
        stage: entry.stage,
        laneId: entry.laneId
      }
    })
  }

  if (persona) {
    path.push({
      kind: "persona",
      id: persona.id,
      label: persona.name,
      metadata: {
        stage: persona.stage,
        preferredAdapterType: persona.preferredAdapterType
      }
    })
  }

  path.push(
    {
      kind: "agent",
      id: agent.id,
      label: agent.name,
      metadata: {
        adapterType: agent.adapterType,
        model: agent.model
      }
    },
    {
      kind: "adapter",
      id: agent.adapterType,
      label: agent.adapterType,
      metadata: {
        model: agent.model
      }
    },
    {
      kind: "run",
      id: runId,
      label: runId.slice(0, 8),
      metadata: {
        taskKind: task.kind
      }
    }
  )

  return path
}

function jobOrder(jobId: JobId): number {
  switch (jobId) {
    case "queue-refresh":
      return 0
    case "execution-sweep":
      return 1
    case "review-sweep":
      return 2
    case "promotion-sweep":
      return 3
    case "github-pr-sweep":
      return 4
    case "daily-telegram-digest":
      return 5
  }
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function verificationTimeoutMs(): number {
  return Math.min(2 * 60 * 60 * 1000, Math.max(30_000, envInt("OPENCLAW_VERIFICATION_TIMEOUT_MS", 15 * 60 * 1000)))
}

function staleRunThresholdMs(): number {
  return envInt("OPENCLAW_STALE_RUN_THRESHOLD_MS", 35 * 60 * 1000)
}

function queuedTaskWindow(): number {
  return envInt("OPENCLAW_QUEUED_TASK_WINDOW", 40)
}

function maxPlannerRunsPerTick(): number {
  return envInt("OPENCLAW_MAX_PLANNER_RUNS_PER_TICK", 1)
}

function maxConcurrentExecutionRunsPerTick(): number {
  return envInt("OPENCLAW_MAX_CONCURRENT_IMPLEMENT_RUNS_PER_TICK", 5)
}

const COOPERATIVE_RATE_POOL_BLOCK_REASON = "Cooperative rate limit lease check failed"

type CooperativeRatePoolAvailability = {
  allowed: boolean
  allocated: number | null
  used: number | null
  resetAt: string | null
}

function cooperativeRatePoolPath(stateRepoPath: string): string {
  const profileId = bestProfileMatch(stateRepoPath)?.profileId
  const profile = profileId ? loadProjectProfile(profileId) : null
  const backend = normalizeOpenClawStateBackend(profile?.stateBackend ?? {})
  const statePath = openClawStatePath(backend, "rate-pool.json", "shared")
  return join(stateRepoPath, statePath.path)
}

function cooperativeRatePoolAvailability(input: {
  stateRepoPath: string
  agentName: string
  priority: number
  now?: Date
}): CooperativeRatePoolAvailability {
  try {
    const path = cooperativeRatePoolPath(input.stateRepoPath)
    if (!existsSync(path)) {
      return { allowed: true, allocated: null, used: null, resetAt: null }
    }
    const pool = JSON.parse(readFileSync(path, "utf8"))
    const coordinated = coordinateRatePool({
      pool,
      agentName: input.agentName,
      priority: input.priority,
      now: input.now ?? new Date()
    })
    const allocation = coordinated.pool.allocations[input.agentName]
    return {
      allowed: coordinated.allowed,
      allocated: allocation?.allocated ?? null,
      used: allocation?.used ?? null,
      resetAt: coordinated.pool.resetAt
    }
  } catch {
    return { allowed: true, allocated: null, used: null, resetAt: null }
  }
}

function adapterSupportsConcurrentAgentRuns(adapterType: Agent["adapterType"]): boolean {
  const configured = process.env.OPENCLAW_CONCURRENT_LOCAL_AGENT_RUNS?.trim().toLowerCase()
  if (configured === "false" || configured === "0") return false
  return adapterType === "codex_local" || adapterType === "gemini_local"
}

function parseIsoMillis(value: string | null): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function taskSelectionOrder(task: Task): number {
  switch (task.kind) {
    case "plan":
      return 0
    case "promote":
      return 1
    case "review":
      return 2
    case "fix_review_feedback":
    case "repair":
      return 3
    case "implement":
      return 4
    default:
      return 5
  }
}

function failureFixCooldownMs(): number {
  return envInt("OPENCLAW_FAILURE_FIX_COOLDOWN_MS", 6 * 60 * 60 * 1000)
}

function transientRetryDelayMs(attempt: number): number {
  const baseDelayMs = envInt("OPENCLAW_TRANSIENT_RETRY_BASE_DELAY_MS", 2 * 60 * 1000)
  const maxDelayMs = envInt("OPENCLAW_TRANSIENT_RETRY_MAX_DELAY_MS", 6 * 60 * 60 * 1000)
  const exponent = Math.max(0, Math.min(attempt - 1, 16))
  return Math.min(maxDelayMs, baseDelayMs * 2 ** exponent)
}

function consecutiveTransientFailureCount(store: DispatcherStore, task: Task, excludeRunId: string): number {
  const priorRuns = store
    .listProjectRuns(task.projectId)
    .filter((run) => run.taskId === task.id && run.id !== excludeRunId)

  let count = 0
  for (let index = priorRuns.length - 1; index >= 0; index -= 1) {
    const run = priorRuns[index]!
    if (run.status !== "failed" || run.retryClass !== "transient") break
    count += 1
  }
  return count
}

function normalizeFailureReason(reason: string): string {
  return reason
    .split("\n")
    .map((line) =>
      line
        .trim()
        .replace(/[A-Za-z]:[\\/][^\s]+|\/[^\s]+/g, "<path>")
        .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
        .replace(/\b0x[0-9a-f]+\b/gi, "<hex>")
        .replace(/\b\d+\b/g, "<num>")
    )
    .filter(Boolean)
    .join("\n")
    .slice(0, 4000)
}

function buildFailureSignature(task: Task, reason: string): string {
  const normalized = normalizeFailureReason(reason)
  const seed = [task.kind, task.laneId ?? "", task.requestedAdapterType ?? "", task.stage ?? "", normalized].join("|")
  return createHash("sha256").update(seed).digest("hex").slice(0, 16)
}

export function failureRetryClass(
  message: string,
  failureCategory: AdapterFailureCategory | null = null
): RunRetryClass {
  if (failureCategory) return "transient"
  const normalized = message.toLowerCase()
  if (
    /no repository changes|produced no code changes|returned a plan|returned a task package|test-only patch|only test evidence/.test(
      normalized
    )
  ) {
    return "policy"
  }
  if (
    /verification command failed|pytest|ruff|eslint|tsc|vitest|playwright|npm run|component size guard|assertionerror|nameerror|typeerror|syntaxerror|failed tests?|no module named|cannot find module|working tree has changes outside run scope|nothing to commit/.test(
      normalized
    )
  ) {
    return "verification"
  }
  if (
    /timed?\s*out|timeout|etimedout|econnreset|econnrefused|eai_again|enotfound|network|socket hang up|temporarily unavailable|service unavailable|503|429|rate limit|quota|out of credits|credits? (?:exhausted|depleted)|stale run|stale claim|lease expired|lock file|index\.lock/.test(
      normalized
    )
  ) {
    return "transient"
  }
  if (/policy|approval|required review|forbidden|outside run scope|human/.test(normalized)) {
    return "policy"
  }
  return "unknown"
}

function isAiAdapterExecutionFailure(message: string, failureCategory: AdapterFailureCategory | null = null): boolean {
  if (failureCategory) return true
  const normalized = message.toLowerCase()
  return (
    /gemini|codex|adapter|model|inference|spawn(?:sync)?/.test(normalized) &&
    /timed?\s*out|timeout|etimedout|quota|out of credits|credits? (?:exhausted|depleted)|rate limit|rate_limited|429|resource_exhausted|resource exhausted/.test(
      normalized
    )
  )
}

function shouldRetryWithoutNewHumanPatch(
  message: string,
  failureCategory: AdapterFailureCategory | null = null
): boolean {
  const retryClass = failureRetryClass(message, failureCategory)
  if (retryClass === "verification" || retryClass === "policy") {
    return false
  }
  return retryClass === "transient" || retryClass === "unknown" || isAiAdapterExecutionFailure(message)
}

function shouldAllowFailureRetryOrFollowUp(
  task: Task,
  message: string,
  failureCategory: AdapterFailureCategory | null = null
): boolean {
  if (task.source === "repo_health" || task.labels.includes("repo-health")) {
    return true
  }
  return shouldRetryWithoutNewHumanPatch(message, failureCategory)
}

function fallbackAdaptersAfterExecutionFailure(
  adapterType: Agent["adapterType"] | null | undefined
): Agent["adapterType"][] {
  if (adapterType === "gemini_local") return ["codex_local", "azure_foundry"]
  if (adapterType === "codex_local") return ["azure_foundry", "gemini_local"]
  if (adapterType === "azure_foundry") return ["codex_local", "gemini_local"]
  return []
}

function isActiveRecoveryTask(task: Task): boolean {
  return (
    task.kind === "fix_review_feedback" &&
    (task.status === "queued" || task.status === "running" || task.status === "review_needed")
  )
}

function isCodeProducingTask(task: Task): boolean {
  return task.kind === "implement" || task.kind === "repair" || task.kind === "fix_review_feedback"
}

const TERMINAL_RECOVERY_REASONS = new Set([
  "blocked_state_retired_for_persona_ideation",
  "historical_blocker_archived",
  "over_retry_quarantined"
])

function isHistoricalArchivedTask(task: Task): boolean {
  return task.lastRecoveryReason !== null && TERMINAL_RECOVERY_REASONS.has(task.lastRecoveryReason)
}

const ACTIVE_TASK_STATUSES = new Set(["queued", "running", "review_needed", "promotion_pending", "blocked"])
const DEFAULT_REPO_HEALTH_FOLLOW_UP_DEDUPE_WINDOW_HOURS = 72
const REPO_HEALTH_GUARD_RECORDED_EVENT = "repo-health-guard-recorded"
const REPO_HEALTH_GUARD_CLEARED_EVENT = "repo-health-guard-cleared"

type RepoHealthFailureGuard = {
  taskId: string
  eventId: string
  recordedAt: string
  failureSignature: string
  normalizedFailureReason: string
  repeatedFailureCount: number
}

function taskLastTouchedAtMs(task: Task): number {
  const candidates = [task.completedAt, task.updatedAt, task.createdAt]
    .map((value) => (value ? Date.parse(value) : Number.NaN))
    .filter((value) => Number.isFinite(value))
  return candidates.length > 0 ? Math.max(...candidates) : Number.NEGATIVE_INFINITY
}

function payloadLaneId(payload: Record<string, unknown>): string | null {
  const laneId = payload.laneId
  return typeof laneId === "string" && laneId.trim().length > 0 ? laneId.trim() : null
}

export class DispatcherExecutor {
  private readonly memory: MemoryService

  constructor(
    private readonly store: DispatcherStore,
    private readonly adapters: AdapterRegistry,
    public auditWriterFactory?: (projectId: string) => AuditWriter
  ) {
    this.memory = new MemoryService(store)
  }

  private audit(projectId: string): AuditWriter | null {
    if (!this.auditWriterFactory) return null
    return this.auditWriterFactory(projectId)
  }

  private loadProjectProfile(project: Project): ProjectProfile | null {
    return resolveProjectProfile(project.repoPath)
  }

  private async runPlannerWithFallback(input: {
    company: Company
    project: Project
    profile: ProjectProfile
    automation: Automation
    plannerPersona: Persona | null
    snapshot: ReturnType<typeof collectRepoPlanningSnapshot>
    quota: CodexQuotaOverview | null
    activeTaskCount: number
  }): Promise<Awaited<ReturnType<typeof runPlannerAutomation>>> {
    const candidates = plannerAgentCandidates({
      agents: this.store.listAgents(input.company.id),
      plannerPersona: input.plannerPersona,
      profile: input.profile,
      quota: input.quota
    })
    if (candidates.length === 0) {
      throw new Error("No available planner agent found.")
    }

    let lastError: Error | null = null
    for (const [index, plannerAgent] of candidates.entries()) {
      const adapter = this.adapters[plannerAgent.adapterType]
      if (!adapter) {
        lastError = new Error(`Missing adapter implementation for ${plannerAgent.adapterType}`)
        continue
      }
      try {
        return await runPlannerAutomation({
          store: this.store,
          adapter,
          company: input.company,
          project: input.project,
          profile: input.profile,
          automation: input.automation,
          plannerAgent,
          plannerPersonaId: input.plannerPersona?.id ?? null,
          snapshot: input.snapshot,
          quota: input.quota,
          activeTaskCount: input.activeTaskCount
        })
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        const nextAgent = candidates[index + 1] ?? null
        const failedRun = this.store.listRecentPlannerRuns(input.project.id, 1)[0] ?? null
        if (failedRun && nextAgent) {
          this.store.appendPlannerEvent(
            failedRun.id,
            "planner-adapter-fallback",
            "Planner adapter failed; retrying queue generation on the configured fallback adapter.",
            {
              failedAdapterType: plannerAgent.adapterType,
              fallbackAdapterType: nextAgent.adapterType,
              error: lastError.message
            }
          )
        }
        this.audit(input.project.id)?.append("planner-run-failed", {
          automationId: input.automation.id,
          projectId: input.project.id,
          failedAdapterType: plannerAgent.adapterType,
          fallbackAdapterType: nextAgent?.adapterType ?? null,
          error: lastError.message
        })
      }
    }

    throw lastError ?? new Error("Planner automation failed without an available adapter.")
  }

  private isRepoHealthTask(task: Task): boolean {
    return task.source === "repo_health" || task.labels.includes("repo-health")
  }

  private findActiveRepoHealthFailureGuard(projectId: string): RepoHealthFailureGuard | null {
    const repoHealthTasks = this.store.listProjectTasks(projectId).filter((task) => this.isRepoHealthTask(task))
    let latestRecord: RepoHealthFailureGuard | null = null
    let latestClearAtMs = Number.NEGATIVE_INFINITY
    let latestSuccessfulSweepAtMs = Number.NEGATIVE_INFINITY

    for (const task of repoHealthTasks) {
      if (task.status === "done") {
        latestSuccessfulSweepAtMs = Math.max(latestSuccessfulSweepAtMs, taskLastTouchedAtMs(task))
      }
      for (const event of this.store.getTaskEvents(task.id)) {
        const createdAtMs = Date.parse(event.createdAt)
        if (!Number.isFinite(createdAtMs)) {
          continue
        }
        if (event.kind === REPO_HEALTH_GUARD_CLEARED_EVENT) {
          latestClearAtMs = Math.max(latestClearAtMs, createdAtMs)
          continue
        }
        if (event.kind !== REPO_HEALTH_GUARD_RECORDED_EVENT) {
          continue
        }
        const data = event.data ?? {}
        const failureSignature = typeof data.failureSignature === "string" ? data.failureSignature : null
        const normalizedFailureReason =
          typeof data.normalizedFailureReason === "string" ? data.normalizedFailureReason : null
        if (!failureSignature || !normalizedFailureReason) {
          continue
        }
        const repeatedFailureCount =
          typeof data.repeatedFailureCount === "number" && Number.isFinite(data.repeatedFailureCount)
            ? data.repeatedFailureCount
            : 1
        if (!latestRecord || latestRecord.recordedAt < event.createdAt) {
          latestRecord = {
            taskId: task.id,
            eventId: event.id,
            recordedAt: event.createdAt,
            failureSignature,
            normalizedFailureReason,
            repeatedFailureCount
          }
        }
      }
    }

    if (!latestRecord) {
      return null
    }
    const recordedAtMs = Date.parse(latestRecord.recordedAt)
    if (!Number.isFinite(recordedAtMs)) {
      return null
    }
    if (latestClearAtMs >= recordedAtMs) {
      return null
    }
    if (latestSuccessfulSweepAtMs > recordedAtMs) {
      return null
    }
    return latestRecord
  }

  private recordRepoHealthFailureGuard(task: Task, message: string): RepoHealthFailureGuard | null {
    if (!this.isRepoHealthTask(task)) {
      return null
    }

    const failureSignature = buildFailureSignature(task, message)
    const normalizedFailureReason = normalizeFailureReason(message)
    const previousGuard = this.findActiveRepoHealthFailureGuard(task.projectId)
    const repeatedFailureCount =
      previousGuard && previousGuard.failureSignature === failureSignature ? previousGuard.repeatedFailureCount + 1 : 1

    const event = this.store.appendTaskEvent(
      task.id,
      REPO_HEALTH_GUARD_RECORDED_EVENT,
      "Recorded repo health sweep failure guard after repeated review failure.",
      {
        failureSignature,
        normalizedFailureReason,
        repeatedFailureCount
      }
    )

    return {
      taskId: task.id,
      eventId: event.id,
      recordedAt: event.createdAt,
      failureSignature,
      normalizedFailureReason,
      repeatedFailureCount
    }
  }

  async dispatchNext(projectRef: string): Promise<{
    executedRuns: number
    blockedTasks: number
    skippedTasks: number
    followUpTasks: number
  }> {
    const project = this.store.resolveProject(projectRef)
    const now = new Date()
    const companyId = project.companyId
    this.reapStaleRuns(companyId, now)
    this.releaseZombieAgents(companyId)
    this.refreshBlockedAgents(companyId)
    const healthByAdapter = await this.adapterHealth(this.store.listAgents(companyId))
    return this.runQueuedTasks({
      companyId,
      healthByAdapter,
      projectIds: new Set([project.id]),
      executionWake: new Map([
        [
          project.id,
          {
            wakeReason: "manual",
            heartbeatJobId: null,
            triggeredAt: now.toISOString()
          }
        ]
      ]),
      triggeredAt: now.toISOString()
    })
  }

  async dispatchTask(taskId: string): Promise<{
    executedRuns: number
    blockedTasks: number
    skippedTasks: number
    followUpTasks: number
  }> {
    const task = this.store.getTaskById(taskId)
    const now = new Date()
    const companyId = task.companyId
    this.reapStaleRuns(companyId, now)
    this.releaseZombieAgents(companyId)
    this.refreshBlockedAgents(companyId)
    const healthByAdapter = await this.adapterHealth(this.store.listAgents(companyId))
    return this.runQueuedTasks({
      companyId,
      healthByAdapter,
      projectIds: new Set([task.projectId]),
      taskIds: new Set([task.id]),
      executionWake: new Map([
        [
          task.projectId,
          {
            wakeReason: "manual",
            heartbeatJobId: null,
            triggeredAt: now.toISOString()
          }
        ]
      ]),
      triggeredAt: now.toISOString()
    })
  }

  private async adapterHealth(agents: Agent[]): Promise<Record<string, AdapterHealthcheckResult>> {
    const adapterTypes = Array.from(new Set(agents.map((agent) => agent.adapterType)))
    const entries = await Promise.all(
      adapterTypes.map(async (adapterType) => {
        const adapter = this.adapters[adapterType]
        if (!adapter) {
          return [adapterType, { ok: false, message: `adapter ${adapterType} not registered` }] as const
        }
        const agent = selectAdapterHealthcheckAgent(agents, adapterType)
        if (!agent) {
          return [adapterType, { ok: false, message: `no active ${adapterType} agents` }] as const
        }
        return [adapterType, await adapter.healthcheck(agent)] as const
      })
    )

    return Object.fromEntries(entries)
  }

  private refreshBlockedAgents(companyId?: string): void {
    for (const agent of this.store.listAgents(companyId)) {
      const budget = this.store.getBudgetStatus(agent)
      if (budget.blocked) {
        this.store.setAgentStatus(agent.id, "blocked")
      } else if (agent.status === "blocked") {
        this.store.setAgentStatus(agent.id, "idle")
      }
    }
  }

  private releaseZombieAgents(companyId?: string): number {
    let released = 0
    for (const agent of this.store.listAgents(companyId)) {
      if (agent.status !== "running") continue
      if (this.store.hasActiveRunForAgent(agent.id)) continue
      const budget = this.store.getBudgetStatus(agent)
      this.store.setAgentStatus(agent.id, budget.blocked ? "blocked" : "idle")
      released += 1
    }
    return released
  }

  private dueJobSpecs(companyId: string | undefined, at: Date): JobSpec[] {
    const deduped = new Map<string, JobSpec>()
    for (const jobSpec of this.store.listJobSpecs(companyId)) {
      if (!isJobDue(jobSpec, at)) {
        continue
      }
      deduped.set(`${jobSpec.projectId}:${jobSpec.jobId}`, jobSpec)
    }

    return Array.from(deduped.values()).sort(
      (left, right) =>
        jobOrder(left.jobId) - jobOrder(right.jobId) ||
        left.projectId.localeCompare(right.projectId) ||
        left.jobId.localeCompare(right.jobId)
    )
  }

  private reapStaleRuns(companyId: string | undefined, at: Date): number {
    const threshold = staleRunThresholdMs()
    const nowIso = at.toISOString()
    let reaped = 0

    // 1. Reap tasks where the runner process itself seems to have hung or died without updating DB
    for (const run of this.store.listRunningRuns(companyId)) {
      const startedAt = parseIsoMillis(run.startedAt) ?? parseIsoMillis(run.createdAt)
      const latestEventAt = this.store
        .getRunEvents(run.id)
        .map((event) => parseIsoMillis(event.createdAt))
        .filter((eventAt): eventAt is number => eventAt !== null)
        .reduce((latest, eventAt) => Math.max(latest, eventAt), Number.NEGATIVE_INFINITY)
      const lastActivityAt = Math.max(startedAt ?? Number.NEGATIVE_INFINITY, latestEventAt)
      const ownerPid = readAgentLoopOwnerPid(this.store, run.id)
      const ownerExited = ownerPid !== null && !ownerProcessIsAlive(ownerPid)
      if (!ownerExited && (!Number.isFinite(lastActivityAt) || at.getTime() - lastActivityAt < threshold)) {
        continue
      }

      const task = this.store.getTaskById(run.taskId)
      const audit = this.audit(task.projectId)
      const recoveryError = ownerExited
        ? `Run owner process ${ownerPid} exited without completing it and was reaped.`
        : `Run exceeded stale threshold of ${threshold}ms and was reaped.`
      this.store.appendRunEvent(run.id, "warn", "Reaped stale running run", {
        thresholdMs: threshold,
        startedAt: run.startedAt,
        lastActivityAt: Number.isFinite(lastActivityAt) ? new Date(lastActivityAt).toISOString() : null,
        ownerPid,
        ownerExited
      })
      this.store.completeRun(run.id, {
        status: "failed",
        errorText: recoveryError
      })

      if (task.status === "running") {
        const recoveredStatus = task.retryCount + 1 <= task.maxRetries ? "queued" : "failed"
        this.store.recoverTaskClaim(task.id, {
          status: recoveredStatus,
          reason: "stale_run_reaped",
          blockedReason: recoveredStatus === "queued" ? "recovered:stale_run_reaped" : "recovered:stale_run_exhausted",
          lastError: recoveryError,
          incrementRetry: true
        })
        this.store.appendTaskEvent(task.id, "stale-run-reaped", "Recovered stale running task during tick startup.", {
          runId: run.id,
          thresholdMs: threshold,
          requeueStatus: recoveredStatus
        })
        audit?.append("recovery-performed", {
          taskId: task.id,
          runId: run.id,
          reason: ownerExited ? "owner_process_exit" : "execution_timeout",
          recoveryStatus: recoveredStatus
        })
      }

      if (run.agentId) {
        const agent = this.store.getAgentById(run.agentId)
        const budget = this.store.getBudgetStatus(agent)
        this.store.setAgentStatus(run.agentId, budget.blocked ? "blocked" : "idle")
      }

      reaped += 1
    }

    // 2. Reap tasks where the claim/lease has expired
    const expiredTasks = this.store.findExpiredClaims(nowIso)
    for (const task of expiredTasks) {
      if (companyId && task.companyId !== companyId) continue

      const audit = this.audit(task.projectId)
      this.store.recoverTaskClaim(task.id, {
        status: "queued",
        reason: "claim_timeout",
        blockedReason: "recovered:claim_timeout",
        lastError: "Task lease expired and was reclaimed."
      })
      this.store.appendTaskEvent(task.id, "lease-expired", "Task lease expired and was reclaimed during tick startup.")
      audit?.append("task-reclaimed", { taskId: task.id, reason: "claim_timeout", recoveryStatus: "queued" })
      reaped += 1
    }

    return reaped
  }

  private recoverStaleLaneBlocks(companyId: string | undefined, projectIds?: Set<string>): number {
    let recovered = 0
    const projects = projectIds
      ? Array.from(projectIds).map((projectId) => this.store.getProjectById(projectId))
      : this.store.listProjects(companyId)

    for (const project of projects) {
      if (companyId && project.companyId !== companyId) continue

      for (const task of this.store.listProjectTasks(project.id)) {
        if (task.status !== "blocked" || (task.kind !== "implement" && task.kind !== "promote") || !task.laneId) {
          continue
        }
        if (!task.blockedReason?.startsWith("lane_busy_with_active_pr")) continue
        if (this.store.isLaneBusy(task.projectId, task.laneId, task.id)) continue

        this.store.updateTaskStatus(task.id, "queued", {
          blockedReason: null,
          lastError: null
        })
        this.store.appendTaskEvent(
          task.id,
          "stale-lane-block-requeued",
          "Requeued task after its blocking promotion was no longer active.",
          {
            laneId: task.laneId,
            previousBlockedReason: task.blockedReason
          }
        )
        recovered += 1
      }
    }

    return recovered
  }

  private recoverStalePromotionRecords(companyId: string | undefined, projectIds?: Set<string>): number {
    let recovered = 0

    for (const promotion of this.store.listPromotions(companyId)) {
      if (projectIds && !projectIds.has(promotion.projectId)) continue
      if (promotion.promotionStatus === "merged") continue

      if (promotion.promotionStatus === "failed") {
        const remoteMergeMayHaveRecovered =
          promotion.prNumber !== null && /pull request|mergePullRequest/i.test(promotion.lastError ?? "")
        if (remoteMergeMayHaveRecovered && this.reconcileRemoteMergedPromotion(promotion)) {
          recovered += 1
        }
        continue
      }

      if (this.reconcileRemoteMergedPromotion(promotion)) {
        recovered += 1
        continue
      }

      const promotionSubject = this.store.getTaskById(promotion.taskId)
      if (promotionSubject.status !== "blocked" && promotionSubject.status !== "failed") {
        continue
      }
      if (!promotionSubject.blockedReason?.startsWith("promotion_failed:")) {
        continue
      }

      const message =
        promotionSubject.lastError ??
        promotionSubject.blockedReason ??
        `Promotion subject ${promotionSubject.id} is ${promotionSubject.status}.`
      this.store.updatePromotion(promotion.id, {
        promotionStatus: "failed",
        lastError: message
      })
      this.store.appendTaskEvent(
        promotionSubject.id,
        "stale-promotion-record-failed",
        "Recovered stale active promotion record for a failed promotion.",
        {
          promotionId: promotion.id,
          previousPromotionStatus: promotion.promotionStatus
        }
      )
      this.audit(promotion.projectId)?.append("promotion-transition", {
        taskId: promotionSubject.id,
        promotionId: promotion.id,
        laneId: promotionSubject.laneId,
        to: "failed",
        reason: "stale_failed_subject_recovery"
      })
      recovered += 1
    }

    return recovered
  }

  private reconcileRemoteMergedPromotion(promotion: PromotionRecord): boolean {
    if (!commandExists("gh")) return false

    const project = this.store.getProjectById(promotion.projectId)
    const pullRequestRef = promotion.prNumber ? String(promotion.prNumber) : promotion.branchName
    const view = runCommand(
      "gh",
      ["pr", "view", pullRequestRef, "--json", "number,state,mergedAt,headRefOid,url"],
      project.repoPath
    )
    if (!view.ok) return false

    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(view.stdout || "{}") as Record<string, unknown>
    } catch {
      return false
    }
    if (payload.state !== "MERGED" && typeof payload.mergedAt !== "string") return false

    const mergedAt = typeof payload.mergedAt === "string" ? payload.mergedAt : new Date().toISOString()
    const prNumber = typeof payload.number === "number" ? payload.number : promotion.prNumber
    const prUrl = typeof payload.url === "string" ? payload.url : promotion.prUrl
    const headSha = typeof payload.headRefOid === "string" ? payload.headRefOid : promotion.headSha
    this.store.updatePromotion(promotion.id, {
      promotionStatus: "merged",
      mergedAt,
      prNumber,
      prUrl,
      headSha,
      lastReviewSyncAt: new Date().toISOString(),
      lastChecksSyncAt: new Date().toISOString(),
      lastError: null
    })

    const promotionSubject = this.store.getTaskById(promotion.taskId)
    if (promotionSubject.status !== "done") {
      this.store.updateTaskStatus(promotionSubject.id, "done", {
        blockedReason: null,
        lastError: null
      })
    }
    for (const promoteTask of this.store.listChildTasks(promotionSubject.id, "promote")) {
      if (promoteTask.status === "done" || promoteTask.status === "running") continue
      this.store.updateTaskStatus(promoteTask.id, "done", {
        blockedReason: null,
        lastError: null
      })
    }

    const message = `Reconciled merged pull request ${prNumber ? `#${prNumber}` : pullRequestRef} with the dispatcher promotion record.`
    this.store.appendTaskEvent(promotionSubject.id, "promotion-remote-merge-reconciled", message, {
      promotionId: promotion.id,
      prNumber,
      prUrl,
      mergedAt
    })
    this.audit(promotion.projectId)?.append("promotion-transition", {
      taskId: promotionSubject.id,
      promotionId: promotion.id,
      laneId: promotionSubject.laneId,
      to: "merged",
      prNumber,
      prUrl,
      reason: "remote_merge_reconciled"
    })
    return true
  }

  private recoverRetryablePromotionBlocks(companyId: string | undefined, projectIds?: Set<string>): number {
    let recovered = 0
    const projects = projectIds
      ? Array.from(projectIds).map((projectId) => this.store.getProjectById(projectId))
      : this.store.listProjects(companyId)

    for (const project of projects) {
      if (companyId && project.companyId !== companyId) continue
      const profile = this.loadProjectProfile(project)
      const promotionPolicy = profile?.promotionPolicy

      for (const task of this.store.listProjectTasks(project.id)) {
        if (task.kind !== "promote" || task.status !== "blocked") continue

        const reason = task.blockedReason ?? ""
        let recoveryReason: string | null = null
        if (reason === "waiting_for_pr_approval" && promotionPolicy?.requireReviewDecision !== "approved") {
          recoveryReason = "approval_policy_relaxed"
        } else if (reason === "waiting_for_manual_merge" && promotionPolicy?.autoMerge === true) {
          recoveryReason = "auto_merge_enabled"
        }
        if (!recoveryReason) continue

        this.store.updateTaskStatus(task.id, "queued", {
          blockedReason: null,
          lastError: null
        })
        this.store.appendTaskEvent(
          task.id,
          "retryable-promotion-block-requeued",
          "Requeued blocked promotion task for another promotion gate check.",
          {
            previousBlockedReason: reason,
            recoveryReason
          }
        )
        recovered += 1
      }
    }

    return recovered
  }

  private recoverCompletedReviewFeedbackPromotions(companyId: string | undefined, projectIds?: Set<string>): number {
    let recovered = 0
    const projects = projectIds
      ? Array.from(projectIds).map((projectId) => this.store.getProjectById(projectId))
      : this.store.listProjects(companyId)

    for (const project of projects) {
      if (companyId && project.companyId !== companyId) continue

      for (const task of this.store.listProjectTasks(project.id)) {
        if (
          task.kind !== "fix_review_feedback" ||
          task.source !== "promotion_feedback" ||
          task.status !== "done" ||
          !task.parentTaskId
        ) {
          continue
        }
        const run = this.store.getLatestRunForTask(task.id)
        if (!run || run.status !== "succeeded") continue
        recovered += this.resumePromotionAfterReviewFeedback(task, project, run.id)
      }
    }

    return recovered
  }

  private recoverCompletedReviewRepairParents(companyId: string | undefined, projectIds?: Set<string>): number {
    let recovered = 0
    const projects = projectIds
      ? Array.from(projectIds).map((projectId) => this.store.getProjectById(projectId))
      : this.store.listProjects(companyId)

    for (const project of projects) {
      if (companyId && project.companyId !== companyId) continue

      for (const repairTask of this.store.listProjectTasks(project.id)) {
        if (
          repairTask.kind !== "fix_review_feedback" ||
          repairTask.status !== "done" ||
          !repairTask.parentTaskId ||
          !repairTask.labels.includes("review-repair")
        ) {
          continue
        }
        const promotion = this.store.getPromotionByTaskId(repairTask.id)
        if (promotion?.promotionStatus !== "merged") continue

        const originalTask = this.store.getTaskById(repairTask.parentTaskId)
        if (originalTask.status !== "blocked" || !originalTask.blockedReason?.startsWith("review_outcome:")) {
          continue
        }

        this.store.updateTaskStatus(originalTask.id, "done", {
          blockedReason: null,
          lastError: null
        })
        this.store.appendTaskEvent(
          originalTask.id,
          "review-repair-promoted-parent-recovered",
          "Closed the original task after its reviewed repair was promoted.",
          {
            repairTaskId: repairTask.id,
            promotionId: promotion.id,
            prNumber: promotion.prNumber
          }
        )
        this.store.appendTaskEvent(
          repairTask.id,
          "review-repair-original-parent-recovered",
          "Closed the original rejected task after repair promotion.",
          {
            originalTaskId: originalTask.id,
            promotionId: promotion.id,
            prNumber: promotion.prNumber
          }
        )
        if (originalTask.workflowId) this.store.refreshWorkflowStatus(originalTask.workflowId)
        this.audit(project.id)?.append("review-transition", {
          taskId: originalTask.id,
          repairTaskId: repairTask.id,
          promotionId: promotion.id,
          prNumber: promotion.prNumber,
          from: "blocked",
          to: "done",
          reason: "review_repair_promoted"
        })
        recovered += 1
      }
    }

    return recovered
  }

  private recoverMergedFailedImplementationTasks(companyId: string | undefined, projectIds?: Set<string>): number {
    let recovered = 0
    const projects = projectIds
      ? Array.from(projectIds).map((projectId) => this.store.getProjectById(projectId))
      : this.store.listProjects(companyId)

    for (const project of projects) {
      if (companyId && project.companyId !== companyId) continue
      let originFetched = false

      for (const task of this.store.listProjectTasks(project.id)) {
        if (task.status !== "failed" && task.status !== "blocked") continue
        if (isHistoricalArchivedTask(task)) continue
        if (!isCodeProducingTask(task)) continue
        if (
          task.status === "blocked" &&
          task.blockedReason &&
          (task.blockedReason.startsWith("verification_failure") || task.blockedReason.startsWith("scope_invalid"))
        ) {
          continue
        }

        const run = this.store.getLatestRunForTask(task.id)
        if (!run || run.status === "succeeded") {
          continue
        }
        const capturedChanges = this.store
          .getRunEvents(run.id)
          .filter(
            (event) =>
              event.message === "Execution worktree changes captured" ||
              event.message === "Execution repository changes captured"
          )
          .at(-1)
        if (capturedChanges?.data?.committed === false) {
          continue
        }
        if (!originFetched) {
          runCommand("git", ["fetch", "origin"], project.repoPath)
          originFetched = true
        }
        if (!runBranchIsMergedIntoExecutionBase(project.repoPath, task, run, { fetchOrigin: false })) {
          continue
        }
        const branchName = run.branchName ?? branchNameForRun(task, run.id)
        const head = runCommand("git", ["rev-parse", branchName], project.repoPath)
        const headSha = run.headSha ?? (head.ok ? head.stdout.trim() : null)

        this.store.completeRun(run.id, {
          status: "succeeded",
          branchName,
          headSha,
          verificationSummary: run.verificationSummary ?? "recovered: implementation branch already merged into base",
          responseText: run.responseText ?? "Recovered from stale failed state after branch was merged into base.",
          retryClass: "none"
        })

        const recoveredStatus = task.reviewRequired ? "review_needed" : "promotion_pending"
        this.store.updateTaskStatus(task.id, recoveredStatus, {
          blockedReason: null,
          lastError: null
        })
        this.store.appendTaskEvent(
          task.id,
          "merged-run-state-recovered",
          "Recovered stale failed task because its implementation branch is already merged into the base branch.",
          {
            runId: run.id,
            branchName,
            headSha,
            recoveredStatus
          }
        )
        this.store.appendRunEvent(run.id, "info", "Recovered failed run after branch was already merged", {
          taskId: task.id,
          previousStatus: run.status,
          recoveredStatus
        })
        if (task.workflowId) {
          this.store.refreshWorkflowStatus(task.workflowId)
        }
        recovered += 1
      }
    }

    return recovered
  }

  private recoverSatisfiedDependencyBlocks(companyId: string | undefined, projectIds?: Set<string>): number {
    let recovered = 0
    const projects = projectIds
      ? Array.from(projectIds).map((projectId) => this.store.getProjectById(projectId))
      : this.store.listProjects(companyId)

    for (const project of projects) {
      if (companyId && project.companyId !== companyId) continue

      for (const task of this.store.listProjectTasks(project.id)) {
        if (task.status !== "blocked") continue
        if (!task.blockedReason?.startsWith("dependency_")) continue
        if (!dependencySatisfied(this.store, task)) continue

        this.store.updateTaskStatus(task.id, "queued", {
          blockedReason: null,
          lastError: null
        })
        this.store.appendTaskEvent(
          task.id,
          "dependency-block-recovered",
          "Requeued stale dependency block after prerequisites became satisfied.",
          {
            previousBlockedReason: task.blockedReason,
            dependencies: task.dependsOnTaskIds
          }
        )
        if (task.workflowId) {
          this.store.refreshWorkflowStatus(task.workflowId)
        }
        recovered += 1
      }
    }

    return recovered
  }

  private selectPersonaAgent(
    task: Task,
    agents: Agent[]
  ): { agent: Agent | null; persona: Persona | null; reason: string | null } {
    if (!task.personaId) {
      return { agent: null, persona: null, reason: null }
    }

    const persona = this.store.getPersonaById(task.personaId)
    if (persona.status === "paused") {
      return { agent: null, persona, reason: `persona ${persona.name} is paused` }
    }

    const dispatchableAgents = agents.filter((candidate) => this.isDispatchableAgent(candidate))

    const preferredByName =
      activeAgentsForAdapter(dispatchableAgents, persona.preferredAdapterType).find(
        (candidate) => candidate.name === persona.name
      ) ?? null

    if (preferredByName) {
      return { agent: preferredByName, persona, reason: `matched persona ${persona.name}` }
    }

    const stageCompatibleAgents = dispatchableAgents.filter((candidate) => agentMatchesPersonaStage(candidate, persona))
    const preferredByStage = selectBestAgentForTask(
      task,
      stageCompatibleAgents.length > 0 ? stageCompatibleAgents : dispatchableAgents,
      persona.preferredAdapterType,
      persona
    ).agent

    if (preferredByStage) {
      return { agent: preferredByStage, persona, reason: `matched persona stage ${persona.stage}` }
    }

    return {
      agent: null,
      persona,
      reason: `no available agent for persona ${persona.name}`
    }
  }

  private isDispatchableAgent(agent: Agent): boolean {
    return agent.heartbeatEnabled && agent.status !== "paused" && agent.status !== "blocked"
  }

  private updateTaskAndWorkflow(
    taskId: string,
    status: Task["status"],
    patch: Parameters<DispatcherStore["updateTaskStatus"]>[2]
  ): void {
    this.store.updateTaskStatus(taskId, status, patch)
    const task = this.store.getTaskById(taskId)
    if (task.workflowId) {
      this.store.refreshWorkflowStatus(task.workflowId)
    }
  }

  private recordRunMemory(task: Task, runId: string): void {
    const run = this.store.getRunById(runId)
    void this.memory.recordRunMemory(task, run).catch(() => undefined)
  }

  private async loadRelevantMemory(task: Task, agent: Agent, project: Project, runId: string): Promise<string | null> {
    try {
      await this.memory.upsertRepoMemory(project, agent)
      const items = await this.memory.retrieveRelevantMemory(task, agent, project)
      if (items.length > 0) {
        this.store.appendRunEvent(runId, "info", "Relevant memory attached", {
          chunks: items.map((item) => ({
            sourceKind: item.chunk.sourceKind,
            sourceRef: item.chunk.sourceRef
          }))
        })
      }
      return this.memory.formatPromptMemory(items)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.store.appendRunEvent(runId, "warn", "Memory retrieval failed; continuing without it", {
        error: message
      })
      return null
    }
  }

  private async syncDueAutomations(companyId: string | undefined, at: Date): Promise<number> {
    let executed = 0

    for (const automation of this.store.listDueAutomations(companyId, at.toISOString())) {
      const payload = automation.payload
      const projectRef = typeof payload.projectRef === "string" ? payload.projectRef : automation.projectId
      if (!projectRef) {
        this.store.updateAutomation(automation.id, {
          lastRunAt: at.toISOString(),
          nextRunAt: nextAutomationRunAt(automation, at)
        })
        executed += 1
        continue
      }

      if (automation.kind === "queue_refresh") {
        const project = this.store.resolveProject(projectRef)
        const company = this.store.getCompanyById(project.companyId)
        const profile = this.loadProjectProfile(project)
        if (profile?.planner?.enabled) {
          const plannerPersona = this.store.findPersonaByStage(company.id, "planner")
          const forcePlannerRefresh = process.env.OPENCLAW_FORCE_PLANNER_REFRESH === "1"
          const activeWork = plannerActiveTasks(this.store.listProjectTasks(project.id))
          const quota = readCodexQuotaOverview()
          const capacity = buildPlannerCapacityPlan({
            profile,
            quota,
            activeTaskCount: forcePlannerRefresh ? 0 : activeWork.length
          })
          if (capacity.availableTaskSlots <= 0 && !forcePlannerRefresh) {
            this.audit(project.id)?.append("planner-capacity-skipped", {
              automationId: automation.id,
              projectId: project.id,
              activeTaskCount: capacity.activeTaskCount,
              targetQueueDepth: capacity.targetQueueDepth,
              availableTaskSlots: capacity.availableTaskSlots,
              maxTasks: capacity.maxTasks,
              quotaAssessment: capacity.quotaAssessment,
              codexParallelism: capacity.codexParallelism,
              reason: capacity.reason
            })
          } else {
            const snapshot = collectRepoPlanningSnapshot({
              project,
              profile,
              tasks: this.store.listProjectTasks(project.id),
              memoryHighlights: [],
              outcomeStats: this.store.getLaneOutcomeStats(project.id),
              excludedStaleTaskIds: plannerSatisfiedTaskIdsFromRuns(this.store.listProjectRuns(project.id))
            })
            try {
              const plannerResult = await this.runPlannerWithFallback({
                company,
                project,
                profile,
                automation,
                plannerPersona,
                snapshot,
                quota,
                activeTaskCount: forcePlannerRefresh ? 0 : activeWork.length
              })
              this.audit(project.id)?.append("planner-run-finished", {
                plannerRunId: plannerResult.plannerRunId,
                createdTaskIds: plannerResult.createdTaskIds,
                createdCount: plannerResult.createdTaskIds.length
              })
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              this.audit(project.id)?.append("planner-run-failed", {
                automationId: automation.id,
                projectId: project.id,
                error: message
              })
            }
          }
        }
      } else if (automation.kind === "repo_health") {
        const project = this.store.resolveProject(projectRef)
        const company = this.store.getCompanyById(project.companyId)
        const activeRepoHealthGuard = this.findActiveRepoHealthFailureGuard(project.id)
        const templateValues = {
          ...getBuiltinAutomationVariableValues(at),
          company: company.name,
          project: project.name,
          repo: project.repoPath,
          ...payload
        }
        const title =
          typeof payload.title === "string"
            ? (interpolateAutomationTemplate(payload.title, templateValues) ?? payload.title)
            : "Repo health sweep"
        const description =
          typeof payload.description === "string"
            ? (interpolateAutomationTemplate(payload.description, templateValues) ?? payload.description)
            : "Run a reviewer verification sweep for the repository."

        if (activeRepoHealthGuard) {
          this.audit(project.id)?.append("repo-health-guard-suppressed", {
            automationId: automation.id,
            taskTitle: title,
            guardedTaskId: activeRepoHealthGuard.taskId,
            failureSignature: activeRepoHealthGuard.failureSignature,
            repeatedFailureCount: activeRepoHealthGuard.repeatedFailureCount
          })
        } else {
          this.store.createTask({
            projectRef,
            title,
            description,
            labels: ["automation", "repo-health"],
            kind: "review",
            stage: "reviewer",
            priority: 50,
            source: "repo_health",
            laneId: payloadLaneId(payload),
            maxRetries: 0
          })
        }
      } else if (automation.kind === "memory_maintenance") {
        const project = this.store.resolveProject(projectRef)
        const company = this.store.getCompanyById(project.companyId)
        const templateValues = {
          ...getBuiltinAutomationVariableValues(at),
          company: company.name,
          project: project.name,
          repo: project.repoPath,
          ...payload
        }
        this.store.createTask({
          projectRef,
          title:
            typeof payload.title === "string"
              ? (interpolateAutomationTemplate(payload.title, templateValues) ?? payload.title)
              : "Memory maintenance sweep",
          description:
            typeof payload.description === "string"
              ? (interpolateAutomationTemplate(payload.description, templateValues) ?? payload.description)
              : "Review recent memory files and promote durable context into long-term memory.",
          labels: ["automation", "memory-maintenance"],
          kind: "review",
          stage: "reviewer",
          priority: 30,
          source: "maintenance",
          maxRetries: 0
        })
      } else if (automation.kind === "db_backup") {
        const project = this.store.resolveProject(projectRef)
        const payloadPath = typeof payload.outputPath === "string" ? payload.outputPath : null
        const backup = this.store.backupRuntimeState(payloadPath ?? undefined)
        this.audit(project.id)?.append("db-backup-created", {
          automationId: automation.id,
          backupPath: backup.backupPath,
          sourcePath: backup.sourcePath
        })
      } else if (automation.kind === "db_compact") {
        const project = this.store.resolveProject(projectRef)
        const compacted = this.store.compactRuntimeActivity({
          dryRun: payload.dryRun === true,
          backup: payload.backup !== false,
          vacuum: payload.vacuum !== false
        })
        this.audit(project.id)?.append("db-compaction-finished", {
          automationId: automation.id,
          backupPath: compacted.backup?.backupPath ?? null,
          dryRun: compacted.dryRun,
          vacuumed: compacted.vacuumed,
          removed: compacted.removed,
          before: compacted.before,
          after: compacted.after
        })
      } else if (
        automation.kind === "pending_review_sync" ||
        automation.kind === "blocked_promotion_retry" ||
        automation.kind === "stale_pr_followup"
      ) {
        for (const promotion of this.store.listPromotions(companyId)) {
          const promotionSubject = this.store.getTaskById(promotion.taskId)
          if (promotionSubject.projectId !== projectRef) continue
          const promotionTasks =
            promotionSubject.kind === "promote"
              ? [promotionSubject]
              : this.store.listChildTasks(promotionSubject.id, "promote")
          for (const promotionTask of promotionTasks) {
            if (isHistoricalArchivedTask(promotionTask) || promotionTask.status !== "blocked") continue
            const blockedReason = promotionTask.blockedReason ?? ""
            const retryableBlock =
              blockedReason === "waiting_for_checks" ||
              blockedReason === "waiting_for_pr_approval" ||
              blockedReason === "waiting_for_manual_merge" ||
              blockedReason.startsWith("lane_busy_with_active_pr")
            if (!retryableBlock) continue
            this.store.updateTaskStatus(promotionTask.id, "queued", {
              blockedReason: null,
              lastError: null
            })
            this.store.appendTaskEvent(
              promotionTask.id,
              "scheduled-promotion-retry-requeued",
              "Scheduled promotion sync requeued a retryable promotion gate.",
              {
                automationId: automation.id,
                promotionId: promotion.id,
                promotionSubjectTaskId: promotionSubject.id,
                previousBlockedReason: blockedReason
              }
            )
          }
        }
      }

      const completedAt = new Date()
      this.store.updateAutomation(automation.id, {
        lastRunAt: completedAt.toISOString(),
        nextRunAt: nextAutomationRunAt(automation, completedAt)
      })
      executed += 1
    }

    return executed
  }

  private createReviewTasks(projectId: string): ReviewSweepResult {
    let created = 0
    let recovered = 0

    for (let task of this.store.listProjectTasks(projectId)) {
      if (isHistoricalArchivedTask(task)) continue
      if (
        task.status === "done" &&
        task.reviewRequired &&
        isCodeProducingTask(task) &&
        this.store.getLatestSuccessfulImplementationRunForTask(task.id) &&
        !this.store.getPromotionByTaskId(task.id)
      ) {
        this.store.updateTaskStatus(task.id, "review_needed", {
          blockedReason: null,
          lastError: null
        })
        this.store.appendTaskEvent(
          task.id,
          "review-needed-recovered",
          "Recovered completed implementation task that still requires review.",
          {
            previousStatus: "done"
          }
        )
        task = this.store.getTaskById(task.id)
      }

      if (task.status !== "review_needed" || task.kind === "review") {
        continue
      }

      const reviewChildren = this.store.listChildTasks(task.id, "review")
      const completedReview = reviewChildren.find((child) => child.status === "done")
      const activeReview = reviewChildren.some((child) => child.status === "queued" || child.status === "running")
      if (completedReview && !activeReview) {
        const reviewResult = this.reviewResultForChild(task, completedReview)
        if (!reviewResult) {
          this.blockParentWithoutReviewEvidence(task, completedReview)
          continue
        }
        if (reviewResult.outcome !== "approve") {
          this.blockParentForReviewOutcome(task, completedReview, reviewResult)
          continue
        }
        this.store.updateTaskStatus(task.id, "promotion_pending", {
          assignedAgentId: task.assignedAgentId ?? completedReview.assignedAgentId ?? null,
          blockedReason: null,
          lastError: null
        })
        this.store.appendTaskEvent(
          task.id,
          "review-passed-recovered",
          "Recovered completed child review and moved task to promotion pending.",
          {
            reviewTaskId: completedReview.id
          }
        )
        this.store.appendTaskEvent(
          completedReview.id,
          "review-passed-parent-recovered",
          "Recovered parent task transition to promotion pending.",
          {
            parentTaskId: task.id
          }
        )
        this.audit(task.projectId)?.append("review-transition", {
          taskId: task.id,
          from: "review_needed",
          to: "promotion_pending",
          reviewTaskId: completedReview.id,
          recovered: true
        })
        this.cleanupSuccessfulTaskWorktree(task, this.store.getProjectById(task.projectId), "review-passed-recovered")
        recovered += 1
        continue
      }

      if (
        reviewChildren.some(
          (child) => child.status === "queued" || child.status === "running" || child.status === "done"
        )
      ) {
        continue
      }
      const terminalReviewFailure = reviewChildren.find((child) => {
        if (isHistoricalArchivedTask(child)) return false
        const reason = child.blockedReason ?? ""
        const lastError = child.lastError ?? ""
        const retiredDuplicate =
          reason.startsWith("retired:blocked_state_retired") || lastError.startsWith("retired:blocked_state_retired")
        if (retiredDuplicate) return false
        return child.status === "blocked" || child.status === "failed"
      })
      if (terminalReviewFailure) {
        const reason = `review_failed:${terminalReviewFailure.id}`
        const lastError =
          terminalReviewFailure.lastError ??
          terminalReviewFailure.blockedReason ??
          `Review task ${terminalReviewFailure.id} ended as ${terminalReviewFailure.status}.`
        this.store.updateTaskStatus(task.id, "blocked", {
          blockedReason: reason,
          lastError
        })
        this.store.appendTaskEvent(
          task.id,
          "review-child-blocked",
          "Blocked parent task because a child review task failed or blocked.",
          {
            reviewTaskId: terminalReviewFailure.id,
            reviewTaskStatus: terminalReviewFailure.status
          }
        )
        continue
      }

      const descriptionLines = [
        `Review parent task: ${task.id}`,
        `Parent title: ${task.title}`,
        task.description ? "" : null,
        task.description
      ].filter((value): value is string => Boolean(value && value.trim()))

      const reviewTask = this.store.createTask({
        projectRef: task.projectId,
        title: `Review: ${task.title}`,
        description: descriptionLines.join("\n"),
        labels: Array.from(new Set([...task.labels, "review"])),
        changedFiles: task.changedFiles,
        taskPackage: task.taskPackage,
        kind: "review",
        priority: Math.max(task.priority, 70),
        parentTaskId: task.id,
        requestedAdapterType: "codex_local",
        reviewRequired: false,
        approvalRequired: false,
        maxRetries: 1
      })

      this.store.appendTaskEvent(task.id, "review-task-created", "Created child review task.", {
        reviewTaskId: reviewTask.id
      })
      this.store.appendTaskEvent(reviewTask.id, "review-task-linked", "Linked to parent task for review.", {
        parentTaskId: task.id
      })
      created += 1
    }

    return { created, recovered }
  }

  runReviewSweep(projectId: string): ReviewSweepResult {
    return this.createReviewTasks(projectId)
  }

  private promoteReviewedTasks(projectId: string): number {
    let created = 0

    for (const task of this.store.listProjectTasks(projectId)) {
      if (isHistoricalArchivedTask(task)) continue
      if (task.status !== "promotion_pending") {
        continue
      }

      const reviewTask = this.store.listChildTasks(task.id, "review").find((candidate) => candidate.status === "done")

      if (!reviewTask) {
        const hasActiveReview = this.store
          .listChildTasks(task.id, "review")
          .some((candidate) => candidate.status === "queued" || candidate.status === "running")
        const hasActivePromotion = this.store
          .listChildTasks(task.id, "promote")
          .some((candidate) => candidate.status === "queued" || candidate.status === "running")
        if (!hasActiveReview && !hasActivePromotion) {
          this.store.updateTaskStatus(task.id, "review_needed", {
            blockedReason: null,
            lastError: null,
            lastRecoveryAt: new Date().toISOString(),
            lastRecoveryReason: "promotion_pending_without_completed_review"
          })
          this.store.appendTaskEvent(
            task.id,
            "promotion-review-recovered",
            "Recovered promotion-pending task without a completed review by returning it to review.",
            {
              previousStatus: "promotion_pending"
            }
          )
        }
        continue
      }

      const reviewResult = this.reviewResultForChild(task, reviewTask)
      if (!reviewResult) {
        this.blockParentWithoutReviewEvidence(task, reviewTask)
        continue
      }
      if (reviewResult.outcome !== "approve") {
        this.blockParentForReviewOutcome(task, reviewTask, reviewResult)
        continue
      }

      const promoteChildren = this.store.listChildTasks(task.id, "promote")
      const terminalPromoteFailure = promoteChildren.find((candidate) => {
        if (isHistoricalArchivedTask(candidate)) return false
        const reason = candidate.blockedReason ?? ""
        const lastError = candidate.lastError ?? ""
        const retiredDuplicate =
          reason.startsWith("retired:blocked_state_retired") || lastError.startsWith("retired:blocked_state_retired")
        if (retiredDuplicate) return false
        if (candidate.status === "failed") return true
        if (candidate.status !== "blocked") return false
        return !(
          reason.startsWith("lane_busy_with_active_pr") ||
          reason === "waiting_for_manual_merge" ||
          reason === "waiting_for_pr_approval" ||
          reason === "waiting_for_checks" ||
          reason === "awaiting_review_feedback"
        )
      })
      if (terminalPromoteFailure) {
        const reason = `promotion_failed:${terminalPromoteFailure.id}`
        const lastError =
          terminalPromoteFailure.lastError ??
          terminalPromoteFailure.blockedReason ??
          `Promotion task ${terminalPromoteFailure.id} ended as ${terminalPromoteFailure.status}.`
        this.store.updateTaskStatus(task.id, "blocked", {
          blockedReason: reason,
          lastError
        })
        this.store.appendTaskEvent(
          task.id,
          "promote-child-blocked",
          "Blocked parent task because a child promotion task failed or blocked.",
          {
            promoteTaskId: terminalPromoteFailure.id,
            promoteTaskStatus: terminalPromoteFailure.status
          }
        )
        continue
      }

      const existingPromoteTask = promoteChildren.find(
        (candidate) =>
          candidate.status === "queued" ||
          candidate.status === "running" ||
          candidate.status === "done" ||
          candidate.status === "blocked"
      )
      if (existingPromoteTask) {
        continue
      }

      const promoteTask = this.store.createTask({
        projectRef: task.projectId,
        title: `Promote: ${task.title}`,
        description: [`Promote reviewed implementation task: ${task.id}`, `Parent title: ${task.title}`].join("\n"),
        labels: Array.from(new Set([...task.labels, "promotion"])),
        changedFiles: task.changedFiles,
        taskPackage: task.taskPackage,
        kind: "promote",
        priority: Math.max(task.priority, 80),
        parentTaskId: task.id,
        dependsOnTaskIds: [reviewTask.id],
        requestedAdapterType: "codex_local",
        reviewRequired: false,
        approvalRequired: false,
        maxRetries: 1,
        laneId: task.laneId ?? task.taskPackage?.likelyOwnershipLane ?? null
      })
      this.store.appendTaskEvent(task.id, "promote-task-created", "Created child promote task after review approval.", {
        reviewTaskId: reviewTask.id,
        promoteTaskId: promoteTask.id
      })
      this.store.appendTaskEvent(promoteTask.id, "promote-task-linked", "Linked to reviewed implementation task.", {
        parentTaskId: task.id,
        reviewTaskId: reviewTask.id
      })
      created += 1
    }

    return created
  }

  runPromotionSweep(projectId: string): number {
    return this.promoteReviewedTasks(projectId)
  }

  async runPlannerRefresh(projectRef: string): Promise<{
    plannerRunId: string
    createdTaskIds: string[]
    createdTasks: number
  }> {
    const project = this.store.resolveProject(projectRef)
    if (!holdsExecutionOwner(project.repoPath, "legacy"))
      return withExecutionOwner(project.repoPath, "legacy", () => this.runPlannerRefresh(projectRef))
    const company = this.store.getCompanyById(project.companyId)
    const profile = this.loadProjectProfile(project)
    if (!profile) {
      throw new Error(`Could not resolve project profile for ${project.repoPath}`)
    }
    if (!profile.planner?.enabled) {
      throw new Error(`Planner is disabled for profile ${profile.profileId}`)
    }

    const forcePlannerRefresh = process.env.OPENCLAW_FORCE_PLANNER_REFRESH === "1"
    const activeWork = plannerActiveTasks(this.store.listProjectTasks(project.id))
    const quota = readCodexQuotaOverview()
    const capacity = buildPlannerCapacityPlan({
      profile,
      quota,
      activeTaskCount: forcePlannerRefresh ? 0 : activeWork.length
    })
    if (capacity.availableTaskSlots <= 0 && !forcePlannerRefresh) {
      this.audit(project.id)?.append("planner-capacity-skipped", {
        projectId: project.id,
        activeTaskCount: capacity.activeTaskCount,
        targetQueueDepth: capacity.targetQueueDepth,
        availableTaskSlots: capacity.availableTaskSlots,
        maxTasks: capacity.maxTasks,
        quotaAssessment: capacity.quotaAssessment,
        codexParallelism: capacity.codexParallelism,
        reason: capacity.reason
      })
      return {
        plannerRunId: "skipped-active-work",
        createdTaskIds: [],
        createdTasks: 0
      }
    }

    recoverDeadPlannerOwnerRuns({
      store: this.store,
      projectId: project.id
    })
    const activePlannerRun = this.store.listRunningPlannerRuns(project.id)[0] ?? null
    if (activePlannerRun) {
      return {
        plannerRunId: activePlannerRun.id,
        createdTaskIds: [],
        createdTasks: 0
      }
    }

    const plannerPersona = this.store.findPersonaByStage(company.id, "planner")
    const snapshot = collectRepoPlanningSnapshot({
      project,
      profile,
      tasks: this.store.listProjectTasks(project.id),
      memoryHighlights: [],
      outcomeStats: this.store.getLaneOutcomeStats(project.id),
      excludedStaleTaskIds: plannerSatisfiedTaskIdsFromRuns(this.store.listProjectRuns(project.id))
    })
    const result = await this.runPlannerWithFallback({
      company,
      project,
      profile,
      automation: {
        id: "manual",
        companyId: company.id,
        projectId: project.id,
        name: "manual-queue-refresh",
        kind: "queue_refresh",
        status: "active",
        cron: "",
        nextRunAt: null,
        payload: { projectRef: project.id },
        lastRunAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      plannerPersona,
      snapshot,
      quota,
      activeTaskCount: forcePlannerRefresh ? 0 : activeWork.length
    })
    return {
      plannerRunId: result.plannerRunId,
      createdTaskIds: result.createdTaskIds,
      createdTasks: result.createdTaskIds.length
    }
  }

  acknowledgeAutomationRun(projectRef: string, automationName: string, completedAt = new Date()): number {
    const project = this.store.resolveProject(projectRef)
    const matching = this.store
      .listAutomations(project.companyId)
      .filter((automation) => automation.projectId === project.id && automation.name === automationName)
    for (const automation of matching) {
      this.store.updateAutomation(automation.id, {
        lastRunAt: completedAt.toISOString(),
        nextRunAt: nextAutomationRunAt(automation, completedAt)
      })
    }
    return matching.length
  }

  private advanceReviewedParent(reviewTask: Task, project: Project, runId: string): number {
    if (reviewTask.kind !== "review" || !reviewTask.parentTaskId) {
      return 0
    }

    const parentTask = this.store.getTaskById(reviewTask.parentTaskId)
    if (parentTask.status !== "review_needed") {
      return 0
    }

    const reviewResult = this.reviewResultForChild(parentTask, reviewTask)
    if (!reviewResult) {
      this.blockParentWithoutReviewEvidence(parentTask, reviewTask, runId)
      return 0
    }
    if (reviewResult.outcome !== "approve") {
      return this.blockParentForReviewOutcome(parentTask, reviewTask, reviewResult, runId) ? 1 : 0
    }

    this.store.updateTaskStatus(parentTask.id, "promotion_pending", {
      assignedAgentId: parentTask.assignedAgentId ?? reviewTask.assignedAgentId ?? null,
      lastError: null
    })
    this.store.appendTaskEvent(parentTask.id, "review-passed", "Successful review moved task to promotion pending.", {
      reviewTaskId: reviewTask.id
    })
    this.store.appendTaskEvent(
      reviewTask.id,
      "review-passed-parent-updated",
      "Parent task moved to promotion pending.",
      {
        parentTaskId: parentTask.id
      }
    )
    this.store.appendRunEvent(runId, "info", "Review completed; parent task moved to promotion_pending", {
      parentTaskId: parentTask.id
    })
    this.audit(parentTask.projectId)?.append("review-transition", {
      taskId: parentTask.id,
      from: "review_needed",
      to: "promotion_pending",
      reviewTaskId: reviewTask.id,
      runId
    })
    this.cleanupSuccessfulTaskWorktree(parentTask, project, "review-passed", runId)
    return 0
  }

  private reviewResultForChild(parentTask: Task, reviewTask: Task): ReviewResult | null {
    const reviewResult = this.store.getLatestReviewResultForTask(parentTask.id)
    if (!reviewResult?.reviewerRunId) {
      return null
    }
    try {
      const reviewerRun = this.store.getRunById(reviewResult.reviewerRunId)
      if (reviewerRun.taskId !== reviewTask.id || reviewerRun.status !== "succeeded") {
        return null
      }
    } catch {
      return null
    }
    return reviewResult
  }

  private blockParentWithoutReviewEvidence(parentTask: Task, reviewTask: Task, runId?: string): void {
    const reason = `review_evidence_missing:${reviewTask.id}`
    this.store.updateTaskStatus(parentTask.id, "blocked", {
      blockedReason: reason,
      lastError: "A completed review task did not have matching deterministic approval evidence."
    })
    this.store.appendTaskEvent(
      parentTask.id,
      "review-evidence-missing",
      "Blocked promotion because the completed review had no matching deterministic result.",
      { reviewTaskId: reviewTask.id, reviewerRunId: runId ?? null }
    )
    this.store.appendTaskEvent(
      reviewTask.id,
      "review-parent-blocked-without-evidence",
      "Parent task was blocked because deterministic review evidence was missing.",
      { parentTaskId: parentTask.id }
    )
    this.blockQueuedPromotionChildren(parentTask, reason)
    if (runId) {
      this.store.appendRunEvent(runId, "error", "Review completed without promotable deterministic evidence", {
        parentTaskId: parentTask.id,
        reviewTaskId: reviewTask.id
      })
    }
    this.audit(parentTask.projectId)?.append("review-transition", {
      taskId: parentTask.id,
      from: parentTask.status,
      to: "blocked",
      reviewTaskId: reviewTask.id,
      runId: runId ?? null,
      reason
    })
  }

  private blockParentForReviewOutcome(
    parentTask: Task,
    reviewTask: Task,
    reviewResult: ReviewResult,
    runId?: string
  ): boolean {
    const existingRepairTaskId = reviewResult.repairTaskId
    const repairTask = this.store.createRepairTaskFromReview(reviewResult.id)
    const reason = `review_outcome:${reviewResult.outcome}`
    this.store.updateTaskStatus(parentTask.id, "blocked", {
      blockedReason: reason,
      lastError: reviewResult.summary
    })
    this.store.appendTaskEvent(
      parentTask.id,
      "review-outcome-blocked",
      "Blocked promotion and queued repair work because deterministic review did not approve the change.",
      {
        reviewTaskId: reviewTask.id,
        reviewResultId: reviewResult.id,
        outcome: reviewResult.outcome,
        repairTaskId: repairTask.id,
        repairTaskCreated: existingRepairTaskId === null
      }
    )
    this.store.appendTaskEvent(
      reviewTask.id,
      "review-parent-blocked",
      "Parent task was blocked by the deterministic review outcome.",
      {
        parentTaskId: parentTask.id,
        reviewResultId: reviewResult.id,
        outcome: reviewResult.outcome,
        repairTaskId: repairTask.id
      }
    )
    this.blockQueuedPromotionChildren(parentTask, reason)
    if (runId) {
      this.store.appendRunEvent(runId, "warn", "Review outcome blocked parent promotion and queued repair work", {
        parentTaskId: parentTask.id,
        reviewResultId: reviewResult.id,
        outcome: reviewResult.outcome,
        repairTaskId: repairTask.id
      })
    }
    this.audit(parentTask.projectId)?.append("review-transition", {
      taskId: parentTask.id,
      from: parentTask.status,
      to: "blocked",
      reviewTaskId: reviewTask.id,
      reviewResultId: reviewResult.id,
      outcome: reviewResult.outcome,
      repairTaskId: repairTask.id,
      runId: runId ?? null
    })
    return existingRepairTaskId === null
  }

  private blockQueuedPromotionChildren(parentTask: Task, reason: string): void {
    for (const promotionTask of this.store.listChildTasks(parentTask.id, "promote")) {
      if (promotionTask.status !== "queued") {
        continue
      }
      this.store.updateTaskStatus(promotionTask.id, "blocked", {
        blockedReason: reason,
        lastError: "Promotion was invalidated by the deterministic review gate."
      })
      this.store.appendTaskEvent(
        promotionTask.id,
        "promotion-invalidated-by-review",
        "Blocked queued promotion because deterministic review did not approve its parent task.",
        { parentTaskId: parentTask.id, reason }
      )
    }
  }

  private resumePromotionAfterReviewFeedback(feedbackTask: Task, project: Project, runId: string): number {
    if (
      feedbackTask.kind !== "fix_review_feedback" ||
      feedbackTask.source !== "promotion_feedback" ||
      !feedbackTask.parentTaskId
    ) {
      return 0
    }

    const promotionSubject = this.store.getTaskById(feedbackTask.parentTaskId)
    const promotion = this.store.getPromotionByTaskId(promotionSubject.id)
    const promoteTasks =
      promotionSubject.kind === "promote"
        ? [promotionSubject]
        : this.store.listChildTasks(promotionSubject.id, "promote")
    const retryablePromoteTasks = promoteTasks.filter(
      (candidate) => candidate.status === "blocked" && candidate.blockedReason === "awaiting_review_feedback"
    )

    if (retryablePromoteTasks.length === 0) {
      return 0
    }

    const reviewThreadIds = feedbackTask.labels
      .filter((label) => label.startsWith("review-thread:"))
      .map((label) => label.slice("review-thread:".length))
      .filter(Boolean)
    const resolvedReviewThreadIds: string[] = []
    const failedReviewThreadIds: string[] = []

    if (promotion && commandExists("gh")) {
      for (const threadId of reviewThreadIds) {
        const resolution = runCommand(
          "gh",
          [
            "api",
            "graphql",
            "-f",
            "query=mutation($threadId:ID!) { resolveReviewThread(input:{threadId:$threadId}) { thread { id isResolved } } }",
            "-F",
            `threadId=${threadId}`
          ],
          project.repoPath
        )
        if (resolution.ok) {
          resolvedReviewThreadIds.push(threadId)
        } else {
          failedReviewThreadIds.push(threadId)
          this.store.appendRunEvent(runId, "warn", "Failed to resolve addressed pull request review thread", {
            promotionId: promotion.id,
            prNumber: promotion.prNumber,
            threadId,
            stderr: resolution.stderr
          })
        }
      }
    }

    for (const promoteTask of retryablePromoteTasks) {
      this.store.updateTaskStatus(promoteTask.id, "queued", {
        blockedReason: null,
        lastError: null
      })
      this.store.appendTaskEvent(
        promoteTask.id,
        "review-feedback-fixed-promotion-requeued",
        "Requeued promotion immediately after its review-feedback task succeeded.",
        {
          feedbackTaskId: feedbackTask.id,
          promotionId: promotion?.id ?? null,
          resolvedReviewThreadIds,
          failedReviewThreadIds
        }
      )
    }

    if (promotion?.promotionStatus === "awaiting_fixes") {
      this.store.updatePromotion(promotion.id, {
        promotionStatus: "waiting_for_review",
        lastError: null
      })
    }
    this.store.appendTaskEvent(
      feedbackTask.id,
      "review-feedback-fixed-promotion-requeued",
      "Successful review feedback fix resumed the blocked promotion.",
      {
        parentTaskId: promotionSubject.id,
        promoteTaskIds: retryablePromoteTasks.map((task) => task.id),
        promotionId: promotion?.id ?? null,
        resolvedReviewThreadIds,
        failedReviewThreadIds
      }
    )
    this.store.appendRunEvent(runId, "info", "Review feedback fixed; promotion requeued", {
      parentTaskId: promotionSubject.id,
      promoteTaskIds: retryablePromoteTasks.map((task) => task.id),
      promotionId: promotion?.id ?? null,
      resolvedReviewThreadIds,
      failedReviewThreadIds
    })
    this.audit(feedbackTask.projectId)?.append("promotion-transition", {
      taskId: promotionSubject.id,
      promotionId: promotion?.id ?? null,
      laneId: promotionSubject.laneId,
      to: "waiting_for_review",
      reason: "review_feedback_fixed",
      feedbackTaskId: feedbackTask.id,
      resolvedReviewThreadIds,
      failedReviewThreadIds
    })
    return retryablePromoteTasks.length
  }

  private cleanupSuccessfulTaskWorktree(
    task: Task,
    project: Project,
    reason: string,
    eventRunId?: string | null
  ): void {
    const implementationRun = this.store.getLatestSuccessfulImplementationRunForTask(task.id)
    if (!implementationRun?.worktreePath || !implementationRun.branchName) {
      return
    }

    const workspace: ExecutionWorkspace = {
      branchName: implementationRun.branchName,
      worktreePath: implementationRun.worktreePath,
      manifestPath: implementationRun.manifestPath ?? `${implementationRun.worktreePath}.manifest.json`
    }
    const cleanup = cleanupExecutionWorkspace(project, workspace)
    if (!cleanup.ok) {
      this.store.appendRunEvent(eventRunId ?? implementationRun.id, "warn", "Execution worktree cleanup failed", {
        worktreePath: workspace.worktreePath,
        reason,
        stderr: cleanup.stderr
      })
      return
    }

    this.store.updateRunWorkspace(implementationRun.id, {
      worktreePath: null,
      manifestPath: null
    })
    this.store.appendRunEvent(implementationRun.id, "info", "Execution worktree cleaned up", {
      worktreePath: workspace.worktreePath,
      reason
    })
    if (eventRunId && eventRunId !== implementationRun.id) {
      this.store.appendRunEvent(eventRunId, "info", "Cleaned implementation worktree", {
        implementationRunId: implementationRun.id,
        worktreePath: workspace.worktreePath,
        reason
      })
    }
  }

  private cleanupRunExecutionWorkspace(input: {
    runId: string
    project: Project
    workspace: ExecutionWorkspace | null
    reason: string
    clearRunWorkspace?: boolean
  }): void {
    if (!input.workspace) {
      return
    }

    const cleanup = cleanupExecutionWorkspace(input.project, input.workspace)
    if (!cleanup.ok) {
      this.store.appendRunEvent(input.runId, "warn", "Execution worktree cleanup failed", {
        worktreePath: input.workspace.worktreePath,
        reason: input.reason,
        stderr: cleanup.stderr
      })
      return
    }

    if (input.clearRunWorkspace) {
      this.store.updateRunWorkspace(input.runId, {
        worktreePath: null,
        manifestPath: null
      })
    }
    this.store.appendRunEvent(input.runId, "info", "Execution worktree cleaned up", {
      worktreePath: input.workspace.worktreePath,
      reason: input.reason
    })
  }

  private cleanupInheritedPreservedExecutionSource(input: {
    runId: string
    project: Project
    source: InheritedExecutionSource | null
    reason: string
  }): void {
    if (
      (input.source?.reason !== "preserved_retry" && input.source?.reason !== "repair_source") ||
      !input.source.worktreePath
    ) {
      return
    }

    const sourceRun = this.store.getRunById(input.source.runId)
    if (!sourceRun.worktreePath) {
      return
    }

    const workspace: ExecutionWorkspace = {
      branchName: input.source.branchName,
      worktreePath: sourceRun.worktreePath,
      manifestPath: sourceRun.manifestPath ?? input.source.manifestPath ?? `${sourceRun.worktreePath}.manifest.json`
    }
    const cleanup = cleanupExecutionWorkspace(input.project, workspace)
    if (!cleanup.ok) {
      this.store.appendRunEvent(input.runId, "warn", "Inherited preserved worktree cleanup failed", {
        sourceRunId: input.source.runId,
        worktreePath: workspace.worktreePath,
        reason: input.reason,
        stderr: cleanup.stderr
      })
      return
    }

    this.store.updateRunWorkspace(input.source.runId, {
      worktreePath: null,
      manifestPath: null
    })
    this.store.appendRunEvent(input.source.runId, "info", "Preserved worktree transferred to retry", {
      retryRunId: input.runId,
      worktreePath: workspace.worktreePath,
      reason: input.reason
    })
    this.store.appendRunEvent(input.runId, "info", "Inherited preserved worktree cleaned up", {
      sourceRunId: input.source.runId,
      worktreePath: workspace.worktreePath,
      reason: input.reason
    })
  }

  private preserveFailedRunExecutionWorkspace(input: {
    runId: string
    task: Task
    workspace: ExecutionWorkspace | null
    reason: string
  }): PreservedExecutionWorkspace | null {
    if (!input.workspace) {
      return null
    }

    const dependencyPaths = sharedDependencyPaths(input.workspace.worktreePath)
    const status = runCommand("git", ["status", "--porcelain", "-z"], input.workspace.worktreePath)
    const meaningfulPaths = status.ok
      ? parsePorcelainPaths(status.stdout).filter((path) => !isSharedExecutionDependencyPath(path, dependencyPaths))
      : []
    const ahead = input.workspace.baseRef
      ? runCommand(
          "git",
          ["rev-list", "--count", `${input.workspace.baseRef}..${input.workspace.branchName}`],
          input.workspace.worktreePath
        )
      : null
    const branchHasCommits = Boolean(ahead?.ok && Number(ahead.stdout.trim()) > 0)
    const preservedChangedPaths = Array.from(
      new Set([...meaningfulPaths, ...executionWorkspaceCumulativeChangedPaths(input.workspace)])
    )

    if (status.ok && meaningfulPaths.length === 0 && !branchHasCommits) {
      return null
    }

    try {
      const captured = captureWorkspaceChanges({
        worktree: input.workspace,
        task: input.task
      })
      this.store.updateRunMetadata(input.runId, {
        changedFiles: preservedChangedPaths
      })
      this.store.updateRunWorkspace(input.runId, {
        branchName: input.workspace.branchName,
        headSha: captured.headSha,
        worktreePath: input.workspace.worktreePath,
        manifestPath: input.workspace.manifestPath
      })
      this.store.appendRunEvent(input.runId, "warn", "Execution worktree preserved after failure", {
        branchName: input.workspace.branchName,
        headSha: captured.headSha,
        worktreePath: input.workspace.worktreePath,
        manifestPath: input.workspace.manifestPath,
        committed: captured.committed,
        reason: input.reason,
        changedFiles: preservedChangedPaths,
        skippedNestedGitCheckouts: captured.skippedNestedGitCheckouts
      })
      return {
        branchName: input.workspace.branchName,
        headSha: captured.headSha,
        worktreePath: input.workspace.worktreePath,
        manifestPath: input.workspace.manifestPath
      }
    } catch (error) {
      const head = runCommand("git", ["rev-parse", "HEAD"], input.workspace.worktreePath)
      const headSha = head.ok ? head.stdout.trim() : null
      this.store.appendRunEvent(input.runId, "warn", "Execution worktree retained after preservation capture failed", {
        branchName: input.workspace.branchName,
        headSha,
        worktreePath: input.workspace.worktreePath,
        manifestPath: input.workspace.manifestPath,
        reason: input.reason,
        error: error instanceof Error ? error.message : String(error)
      })
      return {
        branchName: input.workspace.branchName,
        headSha,
        worktreePath: input.workspace.worktreePath,
        manifestPath: input.workspace.manifestPath
      }
    }
  }

  private restoreProjectCheckoutAfterPromotion(input: {
    project: Project
    runId: string
    baseBranch: string
    promotionBranchName: string
    reason: string
  }): void {
    const status = runCommand("git", ["status", "--porcelain"], input.project.repoPath)
    if (!status.ok) {
      this.store.appendRunEvent(input.runId, "warn", "Could not inspect checkout before promotion cleanup", {
        branchName: input.promotionBranchName,
        baseBranch: input.baseBranch,
        reason: input.reason,
        stderr: status.stderr
      })
      return
    }
    if (status.stdout.trim()) {
      this.store.appendRunEvent(input.runId, "warn", "Skipped promotion checkout restore because repository is dirty", {
        branchName: input.promotionBranchName,
        baseBranch: input.baseBranch,
        reason: input.reason
      })
      return
    }

    const fetch = runCommand("git", ["fetch", "--prune", "origin", input.baseBranch], input.project.repoPath)
    if (!fetch.ok) {
      this.store.appendRunEvent(input.runId, "warn", "Could not fetch base branch before promotion checkout restore", {
        branchName: input.promotionBranchName,
        baseBranch: input.baseBranch,
        reason: input.reason,
        stderr: fetch.stderr
      })
    }

    const localBaseExists = runCommand(
      "git",
      ["rev-parse", "--verify", "--quiet", `${input.baseBranch}^{commit}`],
      input.project.repoPath
    ).ok
    const checkout = localBaseExists
      ? runCommand("git", ["checkout", input.baseBranch], input.project.repoPath)
      : runCommand("git", ["checkout", "-b", input.baseBranch, `origin/${input.baseBranch}`], input.project.repoPath)
    if (!checkout.ok) {
      this.store.appendRunEvent(input.runId, "warn", "Could not restore checkout after promotion", {
        branchName: input.promotionBranchName,
        baseBranch: input.baseBranch,
        reason: input.reason,
        stderr: checkout.stderr
      })
      return
    }

    const fastForward = runCommand("git", ["merge", "--ff-only", `origin/${input.baseBranch}`], input.project.repoPath)
    if (!fastForward.ok) {
      this.store.appendRunEvent(input.runId, "warn", "Could not fast-forward base branch after promotion restore", {
        branchName: input.promotionBranchName,
        baseBranch: input.baseBranch,
        reason: input.reason,
        stderr: fastForward.stderr
      })
      return
    }

    this.store.appendRunEvent(input.runId, "info", "Restored project checkout after promotion", {
      branchName: input.promotionBranchName,
      baseBranch: input.baseBranch,
      reason: input.reason
    })
  }

  private async executeAdapterRun(input: {
    adapter: AdapterDefinition
    owner: Company
    project: Project
    stateRepoPath: string
    task: Task
    agent: Agent
    runId: string
    sessionKey: string
    sessionState: SessionState | null
    storedSessionState: SessionState | null
    runtimeIdentity: RuntimeIdentityPayload
    wakeContext: { wakeReason: WakeReason; heartbeatJobId: JobId | null; triggeredAt: string }
    basePrompt: string
    budgetMetadata: ReturnType<typeof shapeExecutionPrompt>["budgetMetadata"]
  }): Promise<AutonomousExecutionOutcome> {
    if (!holdsExecutionOwner(input.project.repoPath, "legacy"))
      return withExecutionOwner(input.project.repoPath, "legacy", () => this.executeAdapterRun(input))
    assertExecutionOwnership()
    const autonomousMode = autonomousExecutionEnabled()
    const directives: AutonomousDirective[] = []
    let sessionState = input.sessionState
    let prompt = autonomousMode
      ? buildAutonomousPrompt({
          basePrompt: input.basePrompt,
          adapter: input.adapter,
          turn: 0
        })
      : input.basePrompt
    let latestResult: AdapterExecutionResult | null = null
    let latestResponseText = ""

    // Cooperative Rate Limit Lease check
    let ratePoolPath: string | null = null
    let ratePool: any = null
    let rateLimitAllowed = true
    try {
      ratePoolPath = cooperativeRatePoolPath(input.stateRepoPath)

      if (existsSync(ratePoolPath)) {
        ratePool = JSON.parse(readFileSync(ratePoolPath, "utf8"))
      }

      const coordinated = coordinateRatePool({
        pool: ratePool,
        agentName: input.agent.name,
        priority: input.task.priority ?? 2,
        now: new Date()
      })
      ratePool = coordinated.pool
      rateLimitAllowed = coordinated.allowed

      // Write updated lease back
      mkdirSync(dirname(ratePoolPath), { recursive: true })
      writeFileSync(ratePoolPath, JSON.stringify(ratePool, null, 2), "utf8")
    } catch (err) {
      this.store.appendRunEvent(
        input.runId,
        "warn",
        `Could not resolve or update cooperative rate pool: ${err instanceof Error ? err.message : String(err)}`
      )
    }

    if (!rateLimitAllowed) {
      this.store.appendRunEvent(
        input.runId,
        "warn",
        `Cooperative rate limit lease check failed for agent ${input.agent.name} (priority: ${input.task.priority ?? 2}). Execution deferred.`
      )
      return {
        result: {
          ok: false,
          response: `Cooperative rate limit lease check failed for agent ${input.agent.name} (priority: ${input.task.priority ?? 2})`,
          error: COOPERATIVE_RATE_POOL_BLOCK_REASON,
          failureCategory: "quota"
        },
        responseText: COOPERATIVE_RATE_POOL_BLOCK_REASON,
        blocked: true,
        blockedReason: COOPERATIVE_RATE_POOL_BLOCK_REASON,
        turns: 1,
        directives: []
      }
    }

    for (let turn = 0; turn < (autonomousMode ? maxAutonomousTurns() : 1); turn += 1) {
      const toolStartedAt = new Date().toISOString()
      emitAgentLoopTool(this.store, input.runId, "start", {
        toolName: "adapter.execute",
        turn: turn + 1,
        adapterType: input.agent.adapterType,
        provider: input.adapter.label,
        model: input.agent.model,
        sessionKey: input.sessionKey,
        sessionDisplayId: sessionState?.sessionDisplayId ?? null,
        startedAt: toolStartedAt
      })

      const adapterStartedAtMs = Date.now()
      let adapterHeartbeatCount = 0
      let adapterHeartbeatModel = input.agent.model
      const adapterHeartbeat = setInterval(
        () => {
          adapterHeartbeatCount += 1
          try {
            const currentRun = this.store.getRunById(input.runId)
            if (currentRun.status !== "running") return
            this.store.appendRunEvent(input.runId, "info", "Adapter execution heartbeat", {
              adapterType: input.agent.adapterType,
              provider: input.adapter.label,
              model: adapterHeartbeatModel,
              turn: turn + 1,
              elapsedMs: Date.now() - adapterStartedAtMs,
              heartbeatCount: adapterHeartbeatCount
            })
          } catch {
            // A terminal transition may race the timer; heartbeats are best-effort.
          }
        },
        envInt("OPENCLAW_RUN_HEARTBEAT_INTERVAL_MS", 2 * 60 * 1000)
      )
      adapterHeartbeat.unref()
      try {
        latestResult = await input.adapter.execute({
          company: input.owner,
          project: input.project,
          task: input.task,
          agent: input.agent,
          prompt,
          runId: input.runId,
          wakeReason: input.wakeContext.wakeReason,
          heartbeatJobId: input.wakeContext.heartbeatJobId,
          triggeredAt: input.wakeContext.triggeredAt,
          sessionKey: input.sessionKey,
          sessionState,
          runtimeIdentity: input.runtimeIdentity,
          log: (level, message, data) => {
            if (message.startsWith("Launching ") && typeof data?.model === "string" && data.model.trim()) {
              adapterHeartbeatModel = data.model
            }
            this.store.appendRunEvent(input.runId, level, message, data ?? null)
          }
        })
      } catch (error) {
        emitAgentLoopTool(this.store, input.runId, "error", {
          toolName: "adapter.execute",
          turn: turn + 1,
          adapterType: input.agent.adapterType,
          provider: input.adapter.label,
          model: input.agent.model,
          startedAt: toolStartedAt,
          endedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error)
        })
        throw error
      } finally {
        clearInterval(adapterHeartbeat)
      }

      emitAgentLoopTool(this.store, input.runId, latestResult.ok ? "end" : "error", {
        toolName: "adapter.execute",
        turn: turn + 1,
        adapterType: input.agent.adapterType,
        provider: input.adapter.label,
        model: input.agent.model,
        startedAt: toolStartedAt,
        endedAt: new Date().toISOString(),
        result: summarizeAdapterResult(latestResult)
      })
      if (latestResult.response.trim()) {
        emitAgentLoopAssistantDelta(this.store, input.runId, stripAutonomousDirective(latestResult.response), {
          turn: turn + 1,
          block: "message",
          provider: latestResult.metadata?.provider ?? input.adapter.label,
          model: latestResult.metadata?.model ?? input.agent.model
        })
      }

      const tokensUsed = latestResult.usage?.totalTokens ?? 0
      if (tokensUsed > 0 && ratePoolPath) {
        try {
          if (existsSync(ratePoolPath)) {
            ratePool = JSON.parse(readFileSync(ratePoolPath, "utf8"))
          }
          ratePool = recordRatePoolUsage(ratePool, input.agent.name, tokensUsed)
          writeFileSync(ratePoolPath, JSON.stringify(ratePool, null, 2), "utf8")
        } catch (err) {
          this.store.appendRunEvent(
            input.runId,
            "warn",
            `Could not record cooperative rate pool usage: ${err instanceof Error ? err.message : String(err)}`
          )
        }
      }

      const continuation =
        latestResult.continuation ??
        (latestResult.sessionState
          ? {
              sessionDisplayId: latestResult.sessionDisplayId ?? null,
              state: latestResult.sessionState
            }
          : null)
      if (continuation) {
        const previousContext = readSessionContextWindowState(sessionState ?? input.storedSessionState)
        sessionState = this.store.upsertSessionState({
          sessionKey: input.sessionKey,
          companyId: input.owner.id,
          projectId: input.project.id,
          taskId: input.task.id,
          agentId: input.agent.id,
          adapterType: input.agent.adapterType,
          sessionDisplayId: continuation.sessionDisplayId,
          state: attachSessionContextWindowState(
            continuation.state,
            buildSessionContextWindowState({
              previous: previousContext,
              budget: input.budgetMetadata,
              response: latestResult.response,
              recordedAt: input.wakeContext.triggeredAt,
              rawInputTokens: latestResult.usage?.inputTokens ?? null
            })
          )
        })
      }

      latestResponseText = stripAutonomousDirective(latestResult.response)
      const inferredBlockedReason = latestResult.ok
        ? inferTerminalBlockedReason(input.task, latestResponseText || latestResult.response)
        : null
      if (!latestResult.ok || !autonomousMode) {
        return {
          result: latestResult,
          responseText: latestResponseText || latestResult.response,
          blocked: Boolean(inferredBlockedReason),
          blockedReason: inferredBlockedReason,
          turns: turn + 1,
          directives
        }
      }

      const directive = parseAutonomousDirective(latestResult.response)
      if (!directive) {
        this.store.appendRunEvent(
          input.runId,
          "warn",
          "Autonomous directive missing; accepting current response as terminal.",
          {
            turn: turn + 1
          }
        )
        return {
          result: latestResult,
          responseText: latestResponseText || latestResult.response,
          blocked: Boolean(inferredBlockedReason),
          blockedReason: inferredBlockedReason,
          turns: turn + 1,
          directives
        }
      }

      directives.push(directive)
      this.store.appendRunEvent(input.runId, "info", "Autonomous directive parsed", {
        turn: turn + 1,
        action: directive.action,
        summary: directive.summary,
        hasNextPrompt: Boolean(directive.nextPrompt)
      })
      if (directive.selfReflection) {
        this.store.appendTaskEvent(input.task.id, "autonomous-reflection", directive.selfReflection, {
          runId: input.runId,
          turn: turn + 1,
          action: directive.action
        })
      }

      if (directive.action === "complete") {
        return {
          result: latestResult,
          responseText: latestResponseText || directive.summary || latestResult.response,
          blocked: false,
          blockedReason: null,
          turns: turn + 1,
          directives
        }
      }

      if (directive.action === "blocked") {
        return {
          result: latestResult,
          responseText: latestResponseText || directive.summary || latestResult.response,
          blocked: true,
          blockedReason: directive.summary ?? "Autonomous execution reported a blocker.",
          turns: turn + 1,
          directives
        }
      }

      if (turn + 1 >= maxAutonomousTurns()) {
        throw new Error(`Autonomous turn limit of ${maxAutonomousTurns()} reached without a terminal decision.`)
      }

      prompt = buildAutonomousPrompt({
        basePrompt: input.basePrompt,
        adapter: input.adapter,
        turn: turn + 1,
        summary: directive.summary ?? latestResponseText,
        selfReflection: directive.selfReflection,
        nextPrompt: directive.nextPrompt
      })
    }

    throw new Error("Autonomous execution ended without producing a result.")
  }

  private handleFailure(
    task: Task,
    runId: string,
    claimToken: string,
    message: string,
    assignedAgentId: string | null,
    failureCategory: AdapterFailureCategory | null = null
  ): { followUpTasks: number } {
    const retryClass = failureRetryClass(message, failureCategory)
    const blockedClassification = classifyBlockedReason(message, retryClass)
    const retryAllowed =
      task.kind === "promote"
        ? retryClass === "transient" && task.retryCount + 1 <= task.maxRetries
        : shouldAllowFailureRetryOrFollowUp(task, message, failureCategory)
    const failedAgent = assignedAgentId ? this.store.getAgentById(assignedAgentId) : null
    const fallbackAdapterType =
      retryAllowed && failedAgent && isAiAdapterExecutionFailure(message, failureCategory)
        ? this.selectFallbackAdapterAfterExecutionFailure(task, failedAgent.adapterType)
        : null
    const deferTransientAdapterFailure =
      retryAllowed &&
      task.kind !== "promote" &&
      retryClass === "transient" &&
      failedAgent !== null &&
      isAiAdapterExecutionFailure(message, failureCategory)
    const transientFailureAttempt =
      fallbackAdapterType !== null || deferTransientAdapterFailure
        ? consecutiveTransientFailureCount(this.store, task, runId) + 1
        : null
    const retryDelayMs =
      transientFailureAttempt === null
        ? null
        : fallbackAdapterType !== null && transientFailureAttempt === 1
          ? 0
          : transientRetryDelayMs(transientFailureAttempt)
    const retryScheduledAt =
      retryDelayMs === null || retryDelayMs === 0 ? null : new Date(Date.now() + retryDelayMs).toISOString()
    this.store.appendRunEvent(runId, "error", "Task failed", {
      error: message,
      retryClass,
      retryAllowed,
      blockedClassification
    })
    this.store.completeRun(runId, {
      status: "failed",
      errorText: message,
      retryClass
    })
    const failure = this.store.failClaimedTask(task.id, claimToken, message, assignedAgentId, {
      retryAllowed,
      blockedReason: retryAllowed ? null : `${blockedClassification}:${retryClass}`,
      incrementRetry: fallbackAdapterType === null && !deferTransientAdapterFailure
    })
    this.recordRunMemory(failure.task, runId)

    if (!failure.applied) {
      this.store.appendRunEvent(runId, "warn", "Task lease was lost before failure handling completed", {
        taskId: task.id
      })
      return { followUpTasks: 0 }
    }

    if (fallbackAdapterType && failedAgent) {
      const requestedAdapterAlreadyMatched = fallbackAdapterType === failure.task.requestedAdapterType
      this.store.updateTask(failure.task.id, {
        assignedAgentId: null,
        requestedAdapterType: fallbackAdapterType,
        scheduledAt: retryScheduledAt
      })
      this.store.appendTaskEvent(
        failure.task.id,
        "adapter-failure-rerouted",
        "Released the failed assignee and requeued the task to a fallback adapter.",
        {
          fromAdapterType: failedAgent.adapterType,
          toAdapterType: fallbackAdapterType,
          requestedAdapterAlreadyMatched,
          retryCharged: false,
          transientFailureAttempt,
          retryDelayMs,
          retryScheduledAt,
          retryClass,
          blockedClassification,
          error: message.slice(0, 4000)
        }
      )
      this.store.appendRunEvent(runId, "warn", "Released failed assignee and requeued task to fallback adapter", {
        taskId: failure.task.id,
        fromAdapterType: failedAgent.adapterType,
        toAdapterType: fallbackAdapterType,
        requestedAdapterAlreadyMatched,
        retryCharged: false,
        transientFailureAttempt,
        retryDelayMs,
        retryScheduledAt,
        retryClass,
        blockedClassification
      })
    } else if (deferTransientAdapterFailure && failedAgent) {
      this.store.updateTask(failure.task.id, {
        assignedAgentId: null,
        scheduledAt: retryScheduledAt
      })
      this.store.appendTaskEvent(
        failure.task.id,
        "adapter-failure-deferred",
        "Released the failed assignee and deferred the task until adapter capacity recovers.",
        {
          adapterType: failedAgent.adapterType,
          requestedAdapterType: failure.task.requestedAdapterType,
          retryCharged: false,
          transientFailureAttempt,
          retryDelayMs,
          retryScheduledAt,
          retryClass,
          blockedClassification,
          error: message.slice(0, 4000)
        }
      )
      this.store.appendRunEvent(runId, "warn", "Deferred transient adapter failure without charging a retry", {
        taskId: failure.task.id,
        adapterType: failedAgent.adapterType,
        requestedAdapterType: failure.task.requestedAdapterType,
        retryCharged: false,
        transientFailureAttempt,
        retryDelayMs,
        retryScheduledAt,
        retryClass,
        blockedClassification
      })
    }

    this.recordTaskOutcome(failure.task, runId, {
      stage: "execution",
      result: "failure",
      reason: message,
      retryCount: failure.task.retryCount
    })

    if (!failure.followUpRequired) {
      const refreshed = this.store.getTaskById(task.id)
      if (!retryAllowed && failure.applied) {
        this.store.appendTaskEvent(
          refreshed.id,
          "human-action-required",
          "OpenClaw blocked this task instead of rerunning AI inference for a deterministic failure.",
          {
            retryClass,
            blockedClassification,
            error: message.slice(0, 4000)
          }
        )
        this.store.appendRunEvent(runId, "warn", "Blocked task instead of rerunning AI inference", {
          taskId: refreshed.id,
          retryClass,
          blockedClassification,
          blockedReason: refreshed.blockedReason
        })
      }
      if (refreshed.workflowId) {
        this.store.refreshWorkflowStatus(refreshed.workflowId)
      }
      return { followUpTasks: 0 }
    }

    if (failure.task.kind === "promote") {
      this.store.updateTaskStatus(failure.task.id, "blocked", {
        blockedReason: "human_action_required:promotion_failure",
        lastError: message
      })
      this.store.appendRunEvent(runId, "warn", "Blocked promotion failure instead of creating AI follow-up", {
        taskId: failure.task.id,
        retryClass,
        error: message.slice(0, 4000)
      })
      this.store.appendTaskEvent(
        failure.task.id,
        "human-action-required",
        "Promotion failed after deterministic retries; OpenClaw blocked it instead of rerunning AI inference.",
        {
          retryClass,
          error: message.slice(0, 4000)
        }
      )
      if (failure.task.workflowId) {
        this.store.refreshWorkflowStatus(failure.task.workflowId)
      }
      return { followUpTasks: 0 }
    }

    if (failure.task.workflowId) {
      this.store.refreshWorkflowStatus(failure.task.workflowId)
    }
    const repoHealthGuard = this.recordRepoHealthFailureGuard(failure.task, message)
    if (repoHealthGuard) {
      this.store.appendRunEvent(runId, "warn", "Recorded repo health sweep failure guard", {
        taskId: failure.task.id,
        failureSignature: repoHealthGuard.failureSignature,
        repeatedFailureCount: repoHealthGuard.repeatedFailureCount
      })
    }
    if (failure.task.kind === "follow_up" || failure.task.labels.includes("follow-up")) {
      this.store.appendRunEvent(runId, "warn", "Skipped recursive follow-up task creation", {
        taskId: failure.task.id,
        title: failure.task.title
      })
      return { followUpTasks: 0 }
    }
    const fixTaskResult = this.createFailureFixTask(failure.task, message)
    if (fixTaskResult.task) {
      this.store.appendRunEvent(
        runId,
        fixTaskResult.created ? "info" : "warn",
        fixTaskResult.created ? "Created validation fix task" : "Reused validation fix task",
        {
          taskId: failure.task.id,
          fixTaskId: fixTaskResult.task.id,
          failureSignature: fixTaskResult.signature
        }
      )
      return { followUpTasks: fixTaskResult.created ? 1 : 0 }
    }
    if (failure.task.kind === "implement" || failure.task.kind === "fix_review_feedback") {
      this.store.appendRunEvent(runId, "warn", "Suppressed duplicate validation fix task", {
        taskId: failure.task.id,
        failureSignature: fixTaskResult.signature
      })
      return { followUpTasks: 0 }
    }
    const existingRepoHealthFollowUp = this.findEquivalentRepoHealthFollowUp(failure.task)
    if (existingRepoHealthFollowUp) {
      this.store.appendRunEvent(runId, "warn", "Suppressed duplicate repo health follow-up task", {
        taskId: failure.task.id,
        existingTaskId: existingRepoHealthFollowUp.id,
        existingTaskStatus: existingRepoHealthFollowUp.status
      })
      return { followUpTasks: 0 }
    }
    this.store.createFollowUpTask(failure.task, message)
    return { followUpTasks: 1 }
  }

  private selectFallbackAdapterAfterExecutionFailure(
    task: Task,
    failedAdapterType: Agent["adapterType"]
  ): Agent["adapterType"] | null {
    const requiresTools =
      task.kind === "implement" || task.kind === "fix_review_feedback"
        ? taskRequiresTools(task)
        : taskHasHardExecutionSignals(task)
    const agents = this.store.listAgents(task.companyId)
    const nowIso = new Date().toISOString()

    for (const adapterType of fallbackAdaptersAfterExecutionFailure(failedAdapterType)) {
      if (requiresTools && adapterType === "azure_foundry") continue
      if (!agents.some((agent) => agent.adapterType === adapterType && this.isDispatchableAgent(agent))) continue
      if (adapterPoolReason(this.store, task.companyId, adapterType, nowIso)) continue
      return adapterType
    }
    return null
  }

  private findEquivalentRepoHealthFollowUp(task: Task): Task | null {
    if (task.source !== "repo_health" && !task.labels.includes("repo-health")) {
      return null
    }

    const project = this.store.getProjectById(task.projectId)
    const profile = this.loadProjectProfile(project)
    const dedupeWindowHours =
      profile?.planner.dedupeWindowHours && profile.planner.dedupeWindowHours > 0
        ? profile.planner.dedupeWindowHours
        : DEFAULT_REPO_HEALTH_FOLLOW_UP_DEDUPE_WINDOW_HOURS
    const windowStartMs = Date.now() - dedupeWindowHours * 60 * 60 * 1000
    const followUpTitle = `Follow-up: ${task.title}`

    return (
      this.store.listProjectTasks(project.id).find((candidate) => {
        if (candidate.id === task.id) return false
        if (candidate.kind !== "follow_up" && !candidate.labels.includes("follow-up")) return false
        if (!candidate.labels.includes("repo-health")) return false
        if (candidate.title !== followUpTitle) return false
        if (ACTIVE_TASK_STATUSES.has(candidate.status)) return true
        return taskLastTouchedAtMs(candidate) >= windowStartMs
      }) ?? null
    )
  }

  private createFailureFixTask(task: Task, reason: string): { task: Task | null; created: boolean; signature: string } {
    const signature = buildFailureSignature(task, reason)
    if (task.kind !== "implement") {
      return { task: null, created: false, signature }
    }

    const signatureLabel = `validation-signature:${signature}`
    const current = this.store.getTaskById(task.id)
    const now = Date.now()
    const recentRecovery =
      current.lastRecoveryReason === signature &&
      current.lastRecoveryAt !== null &&
      Number.isFinite(Date.parse(current.lastRecoveryAt)) &&
      now - Date.parse(current.lastRecoveryAt) < failureFixCooldownMs()

    const existing = this.store
      .listProjectTasks(task.projectId)
      .find(
        (candidate) =>
          candidate.kind === "fix_review_feedback" &&
          candidate.labels.includes(signatureLabel) &&
          isActiveRecoveryTask(candidate)
      )
    if (existing) {
      if (!existing.description?.includes(`Related failing task: ${task.id}`)) {
        this.store.updateTask(existing.id, {
          description: [existing.description ?? "", "", `Related failing task: ${task.id}`].join("\n").trim()
        })
      }
      this.store.updateTask(task.id, {
        lastRecoveryReason: signature,
        lastRecoveryAt: new Date(now).toISOString()
      })
      return { task: existing, created: false, signature }
    }

    if (recentRecovery) {
      return { task: null, created: false, signature }
    }

    const description = [
      `Parent task failed validation after retries: ${task.id}`,
      `Parent title: ${task.title}`,
      "",
      "Fix the implementation so the verification commands pass. Keep the original task scope and do not broaden the feature.",
      "",
      "Failure output:",
      reason.slice(0, 6000),
      task.description ? "" : null,
      task.description
    ]
      .filter((value): value is string => Boolean(value?.trim()))
      .join("\n")

    const fixTask = this.store.createTask({
      projectRef: task.projectId,
      workflowId: task.workflowId,
      personaRef: task.personaId,
      stage: task.stage === "reviewer" || task.stage === "promoter" ? "coder" : task.stage,
      dependsOnTaskIds: [],
      priority: task.priority + 5,
      scheduledAt: null,
      source: "manual",
      title: `Fix validation failure: ${task.title}`,
      description,
      labels: Array.from(new Set([...task.labels, "validation-fix", "review-feedback", signatureLabel])),
      changedFiles: task.changedFiles,
      taskPackage: task.taskPackage,
      kind: "fix_review_feedback",
      parentTaskId: task.id,
      requestedAdapterType: "codex_local",
      laneId: task.laneId,
      allowedPaths: task.allowedPaths,
      requiredReading: task.requiredReading,
      verificationCommands: task.verificationCommands,
      lineageRootId: task.lineageRootId ?? task.id,
      lineageParentId: task.id,
      taskPackagePath: task.taskPackagePath,
      artifactDir: task.artifactDir,
      reviewRequired: task.reviewRequired,
      approvalRequired: false,
      maxRetries: 0
    })
    this.store.updateTask(task.id, {
      lastRecoveryReason: signature,
      lastRecoveryAt: new Date(now).toISOString()
    })
    this.store.appendTaskEvent(task.id, "validation-fix-created", "Created code fix task after validation failure.", {
      fixTaskId: fixTask.id,
      failureSignature: signature
    })
    return { task: fixTask, created: true, signature }
  }

  private recordTaskOutcome(
    task: Task,
    runId: string | null,
    partial: {
      stage: OutcomeStage
      result: TaskOutcomeResult
      reason?: string | null
      verificationPassed?: boolean | null
      reviewVerdict?: ReviewVerdict | null
      retryCount?: number
      turns?: number | null
      costCents?: number | null
      tokensTotal?: number | null
      durationMs?: number | null
      reflection?: string | null
      metadata?: Record<string, unknown>
    }
  ): void {
    try {
      this.store.recordTaskOutcome({
        companyId: task.companyId,
        projectId: task.projectId,
        taskId: task.id,
        runId,
        laneId: task.laneId,
        adapterType: task.requestedAdapterType,
        stage: partial.stage,
        result: partial.result,
        reason: partial.reason ?? null,
        verificationPassed: partial.verificationPassed ?? null,
        reviewVerdict: partial.reviewVerdict ?? null,
        retryCount: partial.retryCount ?? task.retryCount,
        turns: partial.turns ?? null,
        costCents: partial.costCents ?? null,
        tokensTotal: partial.tokensTotal ?? null,
        durationMs: partial.durationMs ?? null,
        reflection: partial.reflection ?? null,
        metadata: partial.metadata ?? null
      })
    } catch {
      // The outcome ledger is best-effort telemetry; never break the run loop over it.
    }
  }

  private async runReviewTask(
    task: Task,
    project: Project,
    runId: string,
    claimToken: string
  ): Promise<{ followUpTasks: number }> {
    this.store.appendRunEvent(runId, "info", "Review task started", {
      verificationCommands: verificationCommands(task, project)
    })

    const verificationProject = this.reviewVerificationProject(task, project, runId)
    if (verificationProject.repoPath !== project.repoPath) {
      const linkedDependencies = linkSharedExecutionDependencies(project.repoPath, verificationProject.repoPath)
      if (linkedDependencies.length > 0) {
        this.store.appendRunEvent(runId, "info", "Shared execution dependencies refreshed before review verification", {
          linkedDependencies
        })
      }
    }
    const verification = await verificationOk(task, verificationProject, (level, message, data) => {
      this.store.appendRunEvent(runId, level, message, data ?? null)
    })

    if (!verification.ok) {
      const failure = this.handleFailure(
        task,
        runId,
        claimToken,
        verification.error ?? "Review verification failed",
        null
      )
      emitAgentLoopTerminalFromRun(this.store, this.store.getRunById(runId), { stage: "review" })
      return failure
    }

    let reviewResultId: string | null = null
    let reviewOutcome: string | null = null
    if (task.parentTaskId) {
      const implementationRun = this.store.getLatestSuccessfulImplementationRunForTask(task.parentTaskId)
      if (implementationRun) {
        try {
          const reviewResult = reviewCompletedRun(this.store, implementationRun.id, { reviewerRunId: runId })
          reviewResultId = reviewResult.id
          reviewOutcome = reviewResult.outcome
          this.store.updateRunReviewVerdict(
            implementationRun.id,
            reviewResult.outcome === "approve"
              ? "approved"
              : reviewResult.outcome === "request_changes" || reviewResult.outcome === "needs_tests"
                ? "changes_requested"
                : "blocked"
          )
          this.store.appendRunEvent(runId, "info", "Deterministic review evidence persisted", {
            implementationRunId: implementationRun.id,
            reviewResultId: reviewResult.id,
            outcome: reviewResult.outcome,
            riskLevel: reviewResult.riskLevel,
            severity: reviewResult.severity,
            findingCount: reviewResult.findings.length
          })
          this.store.appendTaskEvent(
            task.parentTaskId,
            "deterministic-review-recorded",
            "Persisted deterministic review evidence during the scheduled review gate.",
            {
              reviewTaskId: task.id,
              reviewerRunId: runId,
              implementationRunId: implementationRun.id,
              reviewResultId: reviewResult.id,
              outcome: reviewResult.outcome,
              riskLevel: reviewResult.riskLevel,
              severity: reviewResult.severity
            }
          )
        } catch (error) {
          this.store.appendRunEvent(runId, "warn", "Deterministic review evidence could not be persisted", {
            implementationRunId: implementationRun.id,
            error: error instanceof Error ? error.message : String(error)
          })
        }
      }
    }

    this.store.completeRun(runId, {
      status: "succeeded",
      responseText:
        reviewOutcome === "approve" ? "review approved" : `review completed: ${reviewOutcome ?? "no result"}`,
      verificationSummary: verification.summary ?? "no verification command"
    })
    emitAgentLoopTerminalFromRun(this.store, this.store.getRunById(runId), { stage: "review" })
    const taskUpdated = this.store.completeClaimedTask(task.id, claimToken, "done", {
      lastError: null,
      blockedReason: null
    })
    this.recordRunMemory(this.store.getTaskById(task.id), runId)
    if (!taskUpdated) {
      this.store.appendRunEvent(runId, "warn", "Review finished after lease loss; task state left unchanged", {
        taskId: task.id
      })
      return { followUpTasks: 0 }
    }
    this.audit(task.projectId)?.append("review-transition", {
      taskId: task.id,
      from: "running",
      to: "done",
      runId,
      verificationSummary: verification.summary ?? "no verification command",
      reviewResultId,
      reviewOutcome
    })
    const refreshed = this.store.getTaskById(task.id)
    if (refreshed.workflowId) {
      this.store.refreshWorkflowStatus(refreshed.workflowId)
    }
    return { followUpTasks: this.advanceReviewedParent(refreshed, project, runId) }
  }

  private reviewVerificationProject(task: Task, project: Project, runId: string): Project {
    if (!task.parentTaskId) {
      return project
    }

    const implementationRun = this.store.getLatestSuccessfulImplementationRunForTask(task.parentTaskId)
    if (!implementationRun) {
      return project
    }

    let worktreePath = implementationRun.worktreePath
    if (!worktreePath || !existsSync(join(worktreePath, ".git"))) {
      const restored = this.restoreReviewVerificationWorktree(implementationRun, task, project, runId)
      if (restored && existsSync(join(restored, ".git"))) {
        worktreePath = restored
        this.store.appendRunEvent(runId, "info", "Review verification worktree restored from implementation branch", {
          parentTaskId: task.parentTaskId,
          implementationRunId: implementationRun.id,
          branchName: implementationRun.branchName,
          headSha: implementationRun.headSha,
          worktreePath
        })
      }
    }

    if (!worktreePath || !existsSync(join(worktreePath, ".git"))) {
      this.store.appendRunEvent(runId, "warn", "Review verification worktree missing; falling back to project repo", {
        parentTaskId: task.parentTaskId,
        implementationRunId: implementationRun.id,
        branchName: implementationRun.branchName,
        headSha: implementationRun.headSha,
        worktreePath
      })
      return project
    }

    this.store.appendRunEvent(runId, "info", "Review verification using implementation worktree", {
      parentTaskId: task.parentTaskId,
      implementationRunId: implementationRun.id,
      worktreePath
    })
    return {
      ...project,
      repoPath: worktreePath
    }
  }

  private restoreReviewVerificationWorktree(
    implementationRun: {
      id: string
      branchName: string | null
      headSha: string | null
      worktreePath: string | null
      manifestPath: string | null
    },
    task: Task,
    project: Project,
    runId: string
  ): string | null {
    const branchRef = implementationRun.branchName
      ? gitCommitRefExists(project.repoPath, implementationRun.branchName)
        ? implementationRun.branchName
        : null
      : null
    const startRef = branchRef ?? implementationRun.headSha
    if (!startRef || !gitCommitRefExists(project.repoPath, startRef)) {
      return null
    }

    const profile = this.loadProjectProfile(project)
    const root = worktreeRootForProject(project, profile)
    const worktreePath =
      implementationRun.worktreePath ?? join(root, `${implementationRun.id.slice(0, 8)}-review-${slugify(task.title)}`)
    const manifestPath = implementationRun.manifestPath ?? `${worktreePath}.manifest.json`
    mkdirSync(dirname(worktreePath), { recursive: true })
    if (existsSync(worktreePath) && !existsSync(join(worktreePath, ".git"))) {
      unlinkSharedExecutionDependencies(worktreePath)
      runCommand("git", ["worktree", "remove", "--force", worktreePath], project.repoPath)
      rmSync(worktreePath, { recursive: true, force: true })
      this.store.appendRunEvent(runId, "warn", "Removed stale review worktree shell before restoration", {
        implementationRunId: implementationRun.id,
        worktreePath
      })
    }
    runCommand("git", ["worktree", "prune"], project.repoPath)
    const result = runCommand("git", ["worktree", "add", "--detach", worktreePath, startRef], project.repoPath)
    if (result.ok) {
      writeFileSync(
        manifestPath,
        JSON.stringify(
          {
            taskId: task.parentTaskId,
            reviewTaskId: task.id,
            implementationRunId: implementationRun.id,
            branchName: implementationRun.branchName,
            headSha: implementationRun.headSha,
            startRef,
            worktreePath,
            restoredAt: new Date().toISOString()
          },
          null,
          2
        )
      )
      this.store.updateRunWorkspace(implementationRun.id, {
        branchName: implementationRun.branchName,
        headSha: implementationRun.headSha,
        worktreePath,
        manifestPath
      })
      return worktreePath
    }

    this.store.appendRunEvent(runId, "warn", "Failed to restore review verification worktree", {
      implementationRunId: implementationRun.id,
      branchName: implementationRun.branchName,
      headSha: implementationRun.headSha,
      startRef,
      worktreePath,
      stderr: result.stderr
    })
    return null
  }

  private ensureFeedbackTask(
    task: Task,
    threads: Array<Record<string, unknown>>,
    promotion: PromotionRecord | null = null
  ): string | null {
    const existing = this.store
      .listChildTasks(task.id, "fix_review_feedback")
      .find((child) => child.status === "queued" || child.status === "running")
    if (existing) {
      return existing.id
    }

    const workflowTask = task.workflowId ? this.store.listWorkflowTasks(task.workflowId) : []
    const coderPersonaId =
      workflowTask.find((candidate) => candidate.stage === "coder")?.personaId ??
      (task.workflowId ? (this.store.findPersonaByStage(task.companyId, "coder")?.id ?? null) : null)
    const comments = threads.map((thread, index) => {
      const path = typeof thread.path === "string" ? thread.path : null
      const line = typeof thread.line === "number" ? thread.line : null
      const commentNodes =
        thread.comments && typeof thread.comments === "object" && "nodes" in thread.comments
          ? (thread.comments as { nodes?: unknown[] }).nodes
          : []
      const firstComment =
        Array.isArray(commentNodes) && commentNodes[0] && typeof commentNodes[0] === "object"
          ? (commentNodes[0] as Record<string, unknown>)
          : null
      const body = typeof firstComment?.body === "string" ? firstComment.body : "Review feedback"
      const author =
        firstComment?.author && typeof firstComment.author === "object" && "login" in firstComment.author
          ? String((firstComment.author as { login?: unknown }).login ?? "reviewer")
          : "reviewer"
      return {
        id: typeof firstComment?.id === "string" ? firstComment.id : `${task.id}:review:${index + 1}`,
        author,
        body,
        state: "open",
        path,
        line
      }
    })
    const summary =
      promotion && comments.length > 0
        ? formatPullRequestFeedback({
            feedback: {
              url: promotion.prUrl ?? `PR #${promotion.prNumber ?? "pending"}`,
              branchName: promotion.branchName,
              reason: "changes_requested",
              comments
            },
            baseBranch: promotion.baseBranch,
            includeConflictInstructions: false
          })
        : threads
            .map((thread, index) => {
              const path = typeof thread.path === "string" ? thread.path : "unknown"
              const line = typeof thread.line === "number" ? thread.line : null
              const commentNodes =
                thread.comments && typeof thread.comments === "object" && "nodes" in thread.comments
                  ? (thread.comments as { nodes?: unknown[] }).nodes
                  : []
              const firstComment =
                Array.isArray(commentNodes) && commentNodes[0] && typeof commentNodes[0] === "object"
                  ? (commentNodes[0] as Record<string, unknown>)
                  : null
              const body = typeof firstComment?.body === "string" ? firstComment.body : "Review feedback"
              return `${index + 1}. ${path}${line ? `:${line}` : ""} - ${body}`
            })
            .join("\n")
    const branchInstruction = promotion
      ? `Update the original PR branch by default: ${promotion.branchName}. Do not create a replacement branch or PR unless explicitly instructed.`
      : "Update the original PR branch by default. Do not create a replacement branch or PR unless explicitly instructed."

    const reviewThreadLabels = threads
      .map((thread) => (typeof thread.id === "string" ? `review-thread:${thread.id}` : null))
      .filter((label): label is string => Boolean(label))
    const fixTask = this.store.createTask({
      projectRef: task.projectId,
      workflowId: task.workflowId,
      personaRef: coderPersonaId,
      stage: "coder",
      title: `Address review feedback for ${task.title}`,
      description: `Resolve blocking pull request feedback.\n\n${branchInstruction}\n\n${summary}`,
      labels: ["review-feedback", ...reviewThreadLabels, ...task.labels],
      changedFiles: task.changedFiles,
      taskPackage: task.taskPackage,
      kind: "fix_review_feedback",
      parentTaskId: task.id,
      priority: task.priority + 10,
      source: "promotion_feedback",
      requestedAdapterType: "codex_local",
      maxRetries: 1
    })
    const sourceRun = this.store.getLatestSuccessfulImplementationRunForTask(task.id)
    if (sourceRun?.agentId) {
      const reviewPaths = comments.map((comment) => comment.path).filter((path): path is string => Boolean(path))
      const sourceAssignment = this.store.getTeamAssignmentByRunId(sourceRun.id)
      this.store.createTeamReviewerLockouts({
        companyId: task.companyId,
        projectId: task.projectId,
        taskId: fixTask.id,
        sourceTaskId: task.id,
        sourceRunId: sourceRun.id,
        sourceAssignmentId: sourceAssignment?.id ?? null,
        lockedAgentId: sourceRun.agentId,
        reviewerActor: comments[0]?.author ?? "reviewer",
        artifactPaths: reviewPaths.length > 0 ? reviewPaths : fixTask.changedFiles,
        reason: `Blocking pull request feedback requires an independent revision of ${task.title}.`
      })
    }
    this.store.updateTask(task.id, {
      dependsOnTaskIds: Array.from(new Set([...task.dependsOnTaskIds, fixTask.id]))
    })
    this.store.appendTaskEvent(
      task.id,
      "review-feedback-detected",
      "Created fix task from unresolved PR review threads.",
      {
        feedbackTaskId: fixTask.id,
        threads: threads.length
      }
    )
    return fixTask.id
  }

  private reconcileRecoveredWorkflowTask(task: Task): void {
    if (task.kind !== "fix_review_feedback" || !task.parentTaskId || !task.workflowId) {
      return
    }

    const workflowTasks = this.store.listWorkflowTasks(task.workflowId)
    const parentTask = workflowTasks.find((candidate) => candidate.id === task.parentTaskId)
    if (!parentTask) {
      return
    }

    for (const candidate of workflowTasks) {
      if (!candidate.dependsOnTaskIds.includes(parentTask.id)) {
        continue
      }
      const nextDepends = Array.from(
        new Set(
          candidate.dependsOnTaskIds.map((dependencyId) => (dependencyId === parentTask.id ? task.id : dependencyId))
        )
      )
      this.store.updateTask(candidate.id, {
        dependsOnTaskIds: nextDepends
      })
      this.store.appendTaskEvent(
        candidate.id,
        "validation-recovery-rewired",
        "Rebound workflow dependency to successful validation-fix task.",
        {
          previousDependencyTaskId: parentTask.id,
          recoveryTaskId: task.id
        }
      )
    }
  }

  private runPromoteTask(
    task: Task,
    project: Project,
    company: Company,
    runId: string,
    claimToken: string
  ): { followUpTasks: number } {
    const run = this.store.getRunById(runId)
    const promotionSubject = task.parentTaskId ? this.store.getTaskById(task.parentTaskId) : task
    if (promotionSubject.reviewRequired) {
      const completedReview = this.store
        .listChildTasks(promotionSubject.id, "review")
        .find((candidate) => candidate.status === "done")
      const reviewResult = completedReview ? this.reviewResultForChild(promotionSubject, completedReview) : null
      if (!completedReview || !reviewResult || reviewResult.outcome !== "approve") {
        if (!completedReview || !reviewResult) {
          if (completedReview) {
            this.blockParentWithoutReviewEvidence(promotionSubject, completedReview)
          } else {
            this.store.updateTaskStatus(promotionSubject.id, "blocked", {
              blockedReason: "review_evidence_missing:no_completed_review",
              lastError: "Promotion started without a completed deterministic review."
            })
          }
        } else {
          this.blockParentForReviewOutcome(promotionSubject, completedReview, reviewResult)
        }
        const reason = reviewResult
          ? `review_outcome:${reviewResult.outcome}`
          : `review_evidence_missing:${completedReview?.id ?? "no_completed_review"}`
        const message = `Promotion blocked by deterministic review gate (${reason}).`
        this.store.completeRun(run.id, {
          status: "failed",
          responseText: null,
          errorText: message,
          verificationSummary: "deterministic review gate blocked promotion"
        })
        this.store.completeClaimedTask(task.id, claimToken, "blocked", {
          blockedReason: reason,
          lastError: message
        })
        this.store.appendTaskEvent(
          task.id,
          "promotion-invalidated-by-review",
          "Stopped promotion because the parent task lacks deterministic approval.",
          { parentTaskId: promotionSubject.id, reviewResultId: reviewResult?.id ?? null, reason }
        )
        this.store.appendRunEvent(run.id, "error", message, {
          parentTaskId: promotionSubject.id,
          reviewResultId: reviewResult?.id ?? null
        })
        return { followUpTasks: 0 }
      }
    }
    if (!commandExists("git")) {
      return this.handleFailure(task, run.id, claimToken, "git not found", null)
    }
    if (!commandExists("gh")) {
      return this.handleFailure(task, run.id, claimToken, "gh not found", null)
    }
    const repositoryCheck = runCommand("git", ["rev-parse", "--is-inside-work-tree"], project.repoPath)
    if (!repositoryCheck.ok || repositoryCheck.stdout.trim() !== "true") {
      const reason = repositoryCheck.stderr.trim() || `${project.repoPath} is not a Git worktree`
      return this.handleFailure(task, run.id, claimToken, `promotion failed: ${reason}`, null)
    }

    const implementationRun = this.store.getLatestSuccessfulImplementationRunForTask(promotionSubject.id)
    const branchName = implementationRun?.branchName ?? branchNameForTask(promotionSubject)
    const profile = this.loadProjectProfile(project)
    const promotionPolicy = profile?.promotionPolicy
    const mergeMethod = promotionPolicy?.mergeMethod ?? "squash"
    let baseBranch: string
    try {
      baseBranch = resolvePromotionBaseBranch(project.repoPath, null)
    } catch (error) {
      return this.handleFailure(task, run.id, claimToken, error instanceof Error ? error.message : String(error), null)
    }
    const existingPromotion = this.store.getPromotionByTaskId(promotionSubject.id)
    let promotion =
      existingPromotion ??
      this.store.createPromotion({
        companyId: company.id,
        projectId: project.id,
        workflowId: promotionSubject.workflowId,
        taskId: promotionSubject.id,
        branchName,
        baseBranch,
        mergeMethod
      })
    let resolvedBaseBranch: string
    try {
      resolvedBaseBranch = resolvePromotionBaseBranch(project.repoPath, promotion.baseBranch)
    } catch (error) {
      return this.handleFailure(task, run.id, claimToken, error instanceof Error ? error.message : String(error), null)
    }
    if (resolvedBaseBranch !== promotion.baseBranch) {
      promotion = this.store.updatePromotion(promotion.id, {
        baseBranch: resolvedBaseBranch,
        lastError: null
      })
      this.store.appendRunEvent(run.id, "info", "Adjusted promotion base branch to available repository default", {
        previousBaseBranch: existingPromotion?.baseBranch ?? "main",
        baseBranch: resolvedBaseBranch
      })
    }
    let restoreCheckoutOnExit = false
    let promotionWorkspace: ExecutionWorkspace | null = null
    const completeWithCheckoutRestored = <T>(result: T, reason: string): T => {
      if (promotionWorkspace) {
        const cleanup = cleanupExecutionWorkspace(project, promotionWorkspace)
        this.store.updateRunWorkspace(run.id, { worktreePath: null, manifestPath: null })
        this.store.appendRunEvent(
          run.id,
          cleanup.ok ? "info" : "warn",
          cleanup.ok ? "Promotion worktree cleaned up" : "Promotion worktree cleanup failed",
          {
            worktreePath: promotionWorkspace.worktreePath,
            reason,
            stderr: cleanup.stderr || null
          }
        )
        promotionWorkspace = null
      }
      if (!restoreCheckoutOnExit) {
        return result
      }
      restoreCheckoutOnExit = false
      this.restoreProjectCheckoutAfterPromotion({
        project,
        runId: run.id,
        baseBranch: promotion.baseBranch,
        promotionBranchName: promotion.branchName,
        reason
      })
      return result
    }
    const failPromotion = (message: string): { followUpTasks: number } => {
      this.store.updatePromotion(promotion.id, {
        promotionStatus: "failed",
        lastError: message
      })
      return completeWithCheckoutRestored(
        this.handleFailure(task, run.id, claimToken, message, null),
        "promotion-failed"
      )
    }

    this.cleanupSuccessfulTaskWorktree(promotionSubject, project, "promotion-start", run.id)
    const startRef = implementationRun?.branchName
      ? resolvePromotionStartRef({
          repoPath: project.repoPath,
          branchName: implementationRun.branchName,
          headSha: implementationRun.headSha
        })
      : null
    if (startRef && "error" in startRef) {
      return failPromotion(startRef.error)
    }
    if (startRef && "source" in startRef) {
      this.store.appendRunEvent(run.id, "info", "Resolved promotion implementation ref", {
        branchName: implementationRun?.branchName ?? null,
        startRef: startRef.ref,
        source: startRef.source
      })
    }
    let promotionRepoPath = project.repoPath
    if (startRef && "source" in startRef) {
      try {
        promotionWorkspace = preparePromotionWorkspace({
          project,
          profile,
          task,
          runId: run.id,
          branchName: promotion.branchName,
          startRef: startRef.ref
        })
        promotionRepoPath = promotionWorkspace.worktreePath
        this.store.updateRunWorkspace(run.id, {
          worktreePath: promotionWorkspace.worktreePath,
          manifestPath: promotionWorkspace.manifestPath
        })
        this.store.appendRunEvent(run.id, "info", "Prepared isolated promotion worktree", {
          branchName: promotion.branchName,
          startRef: startRef.ref,
          worktreePath: promotionWorkspace.worktreePath
        })
      } catch (error) {
        return failPromotion(error instanceof Error ? error.message : String(error))
      }
    } else {
      const checkout = runCommand("git", ["checkout", "-B", promotion.branchName], project.repoPath)
      if (!checkout.ok) {
        return failPromotion(checkout.stderr.trim() || "Failed to create promotion branch")
      }
      restoreCheckoutOnExit = true
    }

    const status = runCommand("git", ["status", "--porcelain"], promotionRepoPath)
    if (!status.ok) {
      return failPromotion(status.stderr.trim() || "Failed to inspect repository status")
    }

    if (!implementationRun?.branchName && status.stdout.trim()) {
      const addResult = stageRepositoryChanges(promotionRepoPath)
      if (!addResult.ok) {
        return failPromotion(addResult.stderr.trim() || "Failed to stage changes")
      }
      if (addResult.skippedNestedGitCheckouts.length > 0) {
        this.store.appendTaskEvent(task.id, "promotion-skipped-nested-git-checkouts", "Skipped nested git checkouts.", {
          paths: addResult.skippedNestedGitCheckouts
        })
      }

      const stagedDiff = runCommand("git", ["diff", "--cached", "--quiet"], promotionRepoPath)
      if (!stagedDiff.ok && stagedDiff.status !== 1) {
        return failPromotion(stagedDiff.stderr.trim() || "Failed to inspect staged changes")
      }

      if (stagedDiff.status === 1) {
        const commitResult = runCommand("git", ["commit", "-m", `openclaw: ${task.title}`], promotionRepoPath)
        if (!commitResult.ok && !commitResult.stderr.includes("nothing to commit")) {
          return failPromotion(commitResult.stderr.trim() || "Failed to commit changes")
        }
      }
    }

    const baseSync = synchronizePromotionWithBase({
      repoPath: promotionRepoPath,
      baseBranch: promotion.baseBranch
    })
    if (!baseSync.ok) {
      this.store.appendRunEvent(run.id, "error", "Failed to synchronize promotion branch with latest base", {
        baseBranch: promotion.baseBranch,
        conflictedPaths: baseSync.conflictedPaths
      })
      return failPromotion(baseSync.error)
    }
    this.store.appendRunEvent(
      run.id,
      "info",
      baseSync.merged
        ? "Synchronized promotion branch with latest base"
        : "Promotion branch already contains latest base",
      {
        baseBranch: promotion.baseBranch,
        baseRef: baseSync.baseRef,
        merged: baseSync.merged
      }
    )

    const head = runCommand("git", ["rev-parse", "HEAD"], promotionRepoPath)
    if (!head.ok) {
      return failPromotion(head.stderr.trim() || "Failed to resolve HEAD SHA")
    }
    const headSha = head.stdout.trim()

    const ahead = countPromotionCommitsAhead({
      repoPath: promotionRepoPath,
      baseBranch: promotion.baseBranch
    })
    if (ahead.ok && ahead.count === 0) {
      const message = `Promotion branch ${promotion.branchName} is already integrated with ${ahead.baseRef}; no PR needed.`
      this.store.updatePromotion(promotion.id, {
        branchName: promotion.branchName,
        headSha,
        promotionStatus: "merged",
        mergedAt: new Date().toISOString(),
        lastError: null
      })
      this.store.completeRun(run.id, {
        status: "succeeded",
        responseText: message,
        branchName: promotion.branchName,
        headSha,
        verificationSummary: "already integrated"
      })
      this.recordRunMemory(this.store.getTaskById(task.id), run.id)
      this.store.completeClaimedTask(task.id, claimToken, "done", {
        blockedReason: null,
        lastError: null
      })
      if (promotionSubject.id !== task.id) {
        this.store.updateTaskStatus(promotionSubject.id, "done", {
          assignedAgentId: task.assignedAgentId,
          lastError: null
        })
      }
      this.store.appendTaskEvent(promotionSubject.id, "promotion-already-integrated", message, {
        promoteTaskId: task.id,
        promotionId: promotion.id,
        baseRef: ahead.baseRef
      })
      this.store.appendTaskEvent(task.id, "promotion-already-integrated", message, {
        parentTaskId: promotionSubject.id,
        promotionId: promotion.id,
        baseRef: ahead.baseRef
      })
      if (task.workflowId) {
        this.store.refreshWorkflowStatus(task.workflowId)
      }
      this.audit(task.projectId)?.append("promotion-transition", {
        taskId: promotionSubject.id,
        promoteTaskId: task.id,
        promotionId: promotion.id,
        laneId: promotionSubject.laneId,
        to: "merged",
        reason: "already_integrated",
        baseRef: ahead.baseRef
      })
      this.cleanupSuccessfulTaskWorktree(promotionSubject, project, "promotion-already-integrated", run.id)
      return completeWithCheckoutRestored({ followUpTasks: 0 }, "promotion-already-integrated")
    }

    if ((promotionPolicy?.mode ?? "manual") === "manual") {
      const message = `Prepared local promotion branch ${promotion.branchName}; profile policy does not allow PR creation.`
      this.store.updatePromotion(promotion.id, {
        branchName: promotion.branchName,
        headSha,
        promotionStatus: "ready_to_merge",
        lastError: null
      })
      this.store.completeRun(run.id, {
        status: "succeeded",
        responseText: message,
        branchName: promotion.branchName,
        headSha,
        verificationSummary: "local promotion branch ready"
      })
      this.recordRunMemory(this.store.getTaskById(task.id), run.id)
      this.store.completeClaimedTask(task.id, claimToken, "done", {
        blockedReason: null,
        lastError: null
      })
      if (promotionSubject.id !== task.id) {
        this.store.updateTaskStatus(promotionSubject.id, "done", {
          assignedAgentId: task.assignedAgentId,
          blockedReason: null,
          lastError: null
        })
      }
      this.store.appendTaskEvent(promotionSubject.id, "promotion-local-branch-ready", message, {
        promoteTaskId: task.id,
        promotionId: promotion.id,
        branchName: promotion.branchName,
        headSha
      })
      if (promotionSubject.id !== task.id) {
        this.store.appendTaskEvent(task.id, "promotion-local-branch-ready", message, {
          parentTaskId: promotionSubject.id,
          promotionId: promotion.id,
          branchName: promotion.branchName,
          headSha
        })
      }
      if (task.workflowId) this.store.refreshWorkflowStatus(task.workflowId)
      this.audit(task.projectId)?.append("promotion-transition", {
        taskId: promotionSubject.id,
        promoteTaskId: task.id,
        promotionId: promotion.id,
        laneId: promotionSubject.laneId,
        to: "ready_to_merge",
        reason: "manual_local_branch",
        branchName: promotion.branchName,
        headSha
      })
      this.cleanupSuccessfulTaskWorktree(promotionSubject, project, "promotion-local-branch-ready", run.id)
      return completeWithCheckoutRestored({ followUpTasks: 0 }, "promotion-local-branch-ready")
    }

    const push = runCommand(
      "git",
      ["push", "--force-with-lease", "-u", "origin", promotion.branchName],
      promotionRepoPath
    )
    if (!push.ok) {
      return failPromotion(push.stderr.trim() || "Failed to push branch")
    }

    if (!promotion.prNumber) {
      const createResult = runCommand(
        "gh",
        [
          "pr",
          "create",
          "--base",
          promotion.baseBranch,
          "--head",
          promotion.branchName,
          "--title",
          promotionSubject.title,
          "--body",
          `Automated promotion for ${promotionSubject.title}`
        ],
        project.repoPath
      )
      if (!createResult.ok && !createResult.stderr.includes("already exists")) {
        return failPromotion(createResult.stderr.trim() || "Failed to create pull request")
      }
    }

    const view = runCommand(
      "gh",
      [
        "pr",
        "view",
        promotion.branchName,
        "--json",
        "number,url,headRefOid,isDraft,reviewDecision,statusCheckRollup,mergeStateStatus"
      ],
      project.repoPath
    )
    if (!view.ok) {
      return failPromotion(view.stderr.trim() || "Failed to inspect pull request")
    }

    const viewJson = JSON.parse(view.stdout || "{}") as Record<string, unknown>
    const prNumber = typeof viewJson.number === "number" ? viewJson.number : promotion.prNumber
    const prUrl = typeof viewJson.url === "string" ? viewJson.url : promotion.prUrl
    const prHeadSha = typeof viewJson.headRefOid === "string" ? viewJson.headRefOid : headSha
    const reviewApproved = reviewDecisionApproved(viewJson.reviewDecision)
    const mergeStateStatus =
      typeof viewJson.mergeStateStatus === "string" ? viewJson.mergeStateStatus.toUpperCase() : null

    if (viewJson.isDraft === true && promotionPolicy?.autoMerge === true) {
      const ready = runCommand("gh", ["pr", "ready", String(prNumber ?? promotion.branchName)], project.repoPath)
      if (!ready.ok) {
        return failPromotion(ready.stderr.trim() || `Failed to mark pull request #${prNumber ?? "?"} ready for review`)
      }
      this.store.appendTaskEvent(task.id, "promotion-pr-marked-ready", "Marked draft pull request ready for review.", {
        promotionId: promotion.id,
        prNumber,
        prUrl
      })
    }

    if (mergeStateStatus === "DIRTY") {
      const message = `Pull request #${prNumber ?? "?"} is not mergeable (mergeStateStatus=DIRTY). Rebase or resolve conflicts before promotion.`
      this.store.updatePromotion(promotion.id, {
        branchName: promotion.branchName,
        prNumber,
        prUrl,
        headSha: prHeadSha,
        lastReviewSyncAt: new Date().toISOString(),
        lastChecksSyncAt: new Date().toISOString(),
        promotionStatus: "failed",
        lastError: message
      })
      this.store.completeRun(run.id, {
        status: "succeeded",
        responseText: message,
        branchName: promotion.branchName,
        prNumber,
        headSha: prHeadSha,
        verificationSummary: "pull request has merge conflicts"
      })
      this.recordRunMemory(this.store.getTaskById(task.id), run.id)
      this.store.completeClaimedTask(task.id, claimToken, "blocked", {
        blockedReason: "human_action_required:promotion_conflict",
        lastError: message
      })
      this.store.appendTaskEvent(task.id, "promotion-pr-not-mergeable", message, {
        promotionId: promotion.id,
        prNumber,
        prUrl,
        mergeStateStatus
      })
      if (task.workflowId) {
        this.store.refreshWorkflowStatus(task.workflowId)
      }
      this.audit(task.projectId)?.append("promotion-transition", {
        taskId: promotionSubject.id,
        promoteTaskId: task.id,
        promotionId: promotion.id,
        laneId: promotionSubject.laneId,
        to: "failed",
        prNumber,
        prUrl,
        reason: "mergeStateStatus=DIRTY"
      })
      return completeWithCheckoutRestored({ followUpTasks: 0 }, "promotion-conflict")
    }

    const repoSlug = extractRepoSlug(project)
    let blockingThreads: Array<Record<string, unknown>> = []
    if (repoSlug && prNumber) {
      const [owner, name] = repoSlug.split("/")
      const graphql = runCommand(
        "gh",
        [
          "api",
          "graphql",
          "-f",
          "query=query($owner:String!, $name:String!, $number:Int!) { repository(owner:$owner, name:$name) { pullRequest(number:$number) { reviewThreads(first:100) { nodes { isResolved isOutdated path line comments(first:20) { nodes { id body author { login } } } } } } } }",
          "-F",
          `owner=${owner}`,
          "-F",
          `name=${name}`,
          "-F",
          `number=${prNumber}`
        ],
        project.repoPath
      )
      if (graphql.ok) {
        blockingThreads = extractBlockingThreads(JSON.parse(graphql.stdout || "{}"))
      }
    }

    this.store.updatePromotion(promotion.id, {
      branchName: promotion.branchName,
      prNumber,
      prUrl,
      headSha: prHeadSha,
      lastReviewSyncAt: new Date().toISOString(),
      lastChecksSyncAt: new Date().toISOString(),
      promotionStatus: "waiting_for_review",
      lastError: null
    })
    this.audit(task.projectId)?.append("promotion-transition", {
      taskId: promotionSubject.id,
      promoteTaskId: task.id,
      promotionId: promotion.id,
      laneId: promotionSubject.laneId,
      to: "waiting_for_review",
      prNumber,
      prUrl
    })
    this.cleanupSuccessfulTaskWorktree(promotionSubject, project, "promotion-pr-created", run.id)

    if (blockingThreads.length > 0) {
      const feedbackTaskId = this.ensureFeedbackTask(promotionSubject, blockingThreads, {
        ...promotion,
        prNumber,
        prUrl,
        headSha: prHeadSha
      })
      this.store.completeRun(run.id, {
        status: "succeeded",
        responseText: `Created feedback task ${feedbackTaskId ?? "existing"} for unresolved review threads`,
        branchName: promotion.branchName,
        prNumber,
        headSha: prHeadSha,
        verificationSummary: "awaiting review fixes"
      })
      this.recordRunMemory(this.store.getTaskById(task.id), run.id)
      this.recordTaskOutcome(task, run.id, {
        stage: "reviewer",
        result: "rejected",
        reason: `Unresolved review threads (${blockingThreads.length})`,
        reviewVerdict: "changes_requested",
        metadata: { feedbackTaskId, prNumber }
      })
      this.store.updatePromotion(promotion.id, {
        promotionStatus: "awaiting_fixes"
      })
      this.store.completeClaimedTask(task.id, claimToken, "blocked", {
        blockedReason: "awaiting_review_feedback",
        lastError: null
      })
      this.audit(task.projectId)?.append("promotion-transition", {
        taskId: promotionSubject.id,
        promoteTaskId: task.id,
        promotionId: promotion.id,
        laneId: promotionSubject.laneId,
        to: "awaiting_fixes",
        prNumber,
        feedbackTaskId
      })
      return completeWithCheckoutRestored({ followUpTasks: 0 }, "promotion-awaiting-fixes")
    }

    const checks =
      promotionPolicy?.requireCi === false
        ? { passing: true, pending: false, failing: false }
        : summarizeChecks(viewJson.statusCheckRollup)
    if (checks.failing || checks.pending) {
      this.store.completeRun(run.id, {
        status: "succeeded",
        responseText: checks.failing
          ? "Promotion waiting for failing checks to recover"
          : "Promotion waiting for checks",
        branchName: promotion.branchName,
        prNumber,
        headSha: prHeadSha,
        verificationSummary: checks.failing ? "checks failing" : "checks pending"
      })
      this.recordRunMemory(this.store.getTaskById(task.id), run.id)
      this.store.updatePromotion(promotion.id, {
        promotionStatus: checks.failing ? "blocked" : "waiting_for_checks",
        lastError: checks.failing ? "required checks failing" : null
      })
      this.store.completeClaimedTask(task.id, claimToken, "blocked", {
        blockedReason: checks.failing ? "failing_checks" : "waiting_for_checks",
        lastError: checks.failing ? "required checks failing" : null
      })
      this.audit(task.projectId)?.append("promotion-transition", {
        taskId: promotionSubject.id,
        promoteTaskId: task.id,
        promotionId: promotion.id,
        laneId: promotionSubject.laneId,
        to: checks.failing ? "blocked" : "waiting_for_checks",
        prNumber
      })
      return completeWithCheckoutRestored(
        { followUpTasks: 0 },
        checks.failing ? "promotion-checks-failing" : "promotion-checks-pending"
      )
    }

    if (promotionPolicy?.autoMerge !== true) {
      this.store.completeRun(run.id, {
        status: "succeeded",
        responseText: "Promotion ready, waiting for manual merge because autoMerge is disabled",
        branchName: promotion.branchName,
        prNumber,
        headSha: prHeadSha,
        verificationSummary: "waiting for manual merge"
      })
      this.recordRunMemory(this.store.getTaskById(task.id), run.id)
      this.store.updatePromotion(promotion.id, {
        promotionStatus: "ready_to_merge",
        lastError: null
      })
      this.store.completeClaimedTask(task.id, claimToken, "blocked", {
        blockedReason: "waiting_for_manual_merge",
        lastError: null
      })
      this.audit(task.projectId)?.append("promotion-transition", {
        taskId: promotionSubject.id,
        promoteTaskId: task.id,
        promotionId: promotion.id,
        laneId: promotionSubject.laneId,
        to: "ready_to_merge",
        prNumber,
        autoMerge: false
      })
      return completeWithCheckoutRestored({ followUpTasks: 0 }, "promotion-manual-merge")
    }

    if (promotionPolicy?.requireReviewDecision === "approved" && !reviewApproved) {
      this.store.completeRun(run.id, {
        status: "succeeded",
        responseText: "Promotion waiting for PR approval",
        branchName: promotion.branchName,
        prNumber,
        headSha: prHeadSha,
        verificationSummary: "waiting for PR approval"
      })
      this.recordRunMemory(this.store.getTaskById(task.id), run.id)
      this.store.updatePromotion(promotion.id, {
        promotionStatus: "waiting_for_review",
        lastError: null
      })
      this.store.completeClaimedTask(task.id, claimToken, "blocked", {
        blockedReason: "waiting_for_pr_approval",
        lastError: null
      })
      this.audit(task.projectId)?.append("promotion-transition", {
        taskId: promotionSubject.id,
        promoteTaskId: task.id,
        promotionId: promotion.id,
        laneId: promotionSubject.laneId,
        to: "waiting_for_review",
        prNumber
      })
      return completeWithCheckoutRestored({ followUpTasks: 0 }, "promotion-waiting-for-review")
    }

    this.store.updatePromotion(promotion.id, {
      promotionStatus: "ready_to_merge",
      lastError: null
    })
    this.audit(task.projectId)?.append("promotion-transition", {
      taskId: promotionSubject.id,
      promoteTaskId: task.id,
      promotionId: promotion.id,
      laneId: promotionSubject.laneId,
      to: "ready_to_merge",
      prNumber
    })

    const promotionProfile = this.loadProjectProfile(project)
    const statusChecks = verificationChecksFromRollup(viewJson.statusCheckRollup)
    const verificationChecks =
      statusChecks.length > 0 ? statusChecks : localVerificationChecksForPromotion(this.store, promotionSubject)
    const gateDecision = evaluateVerificationGate({
      checks: verificationChecks,
      reviewVerdict: reviewVerdictFromDecision(viewJson.reviewDecision),
      requireAtLeastOneCheck: (promotionProfile?.verificationRules?.length ?? 0) > 0
    })
    if (!gateDecision.allowed) {
      this.store.completeRun(run.id, {
        status: "succeeded",
        responseText: `Promotion blocked by verification gate: ${gateDecision.reason}`,
        branchName: promotion.branchName,
        prNumber,
        headSha: prHeadSha,
        verificationSummary: "verification gate blocked"
      })
      this.recordRunMemory(this.store.getTaskById(task.id), run.id)
      this.store.updatePromotion(promotion.id, { promotionStatus: "blocked" })
      this.store.completeClaimedTask(task.id, claimToken, "blocked", {
        blockedReason: "verification_gate",
        lastError: gateDecision.reason
      })
      this.recordTaskOutcome(task, run.id, {
        stage: "promotion",
        result: "blocked",
        reason: gateDecision.reason,
        verificationPassed: false,
        metadata: {
          failedCommands: gateDecision.failedCommands,
          prNumber,
          localVerificationFallback: statusChecks.length === 0
        }
      })
      this.audit(task.projectId)?.append("promotion-transition", {
        taskId: task.id,
        promotionId: promotion.id,
        laneId: task.laneId,
        to: "blocked",
        prNumber,
        reason: gateDecision.reason
      })
      return { followUpTasks: 0 }
    }

    const merge = runCommand(
      "gh",
      ["pr", "merge", String(prNumber), mergeFlagForMethod(promotion.mergeMethod), "--delete-branch=false"],
      project.repoPath
    )
    if (!merge.ok) {
      const message = merge.stderr.trim() || "Failed to merge pull request"
      this.store.updatePromotion(promotion.id, {
        promotionStatus: "failed",
        lastError: message
      })
      return completeWithCheckoutRestored(
        this.handleFailure(task, run.id, claimToken, message, null),
        "promotion-merge-failed"
      )
    }

    this.store.updatePromotion(promotion.id, {
      promotionStatus: "merged",
      mergedAt: new Date().toISOString(),
      lastError: null
    })
    let releaseResult: { tagName: string; url: string; notes: string } | null = null
    if (promotionPolicy?.autoRelease === true) {
      const publishedRelease = createPromotionRelease({
        project,
        task: promotionSubject,
        promotion,
        prNumber,
        prUrl,
        headSha: prHeadSha,
        targetRef: promotion.baseBranch,
        releaseTagBase: promotionPolicy.releaseTagBase
      })
      if (!publishedRelease.ok) {
        const message = `Promotion merged, but release publication failed: ${publishedRelease.error}`
        this.store.updatePromotion(promotion.id, {
          promotionStatus: "merged",
          lastError: message
        })
        this.store.completeRun(run.id, {
          status: "succeeded",
          responseText: message,
          branchName: promotion.branchName,
          prNumber,
          headSha: prHeadSha,
          verificationSummary: "release publication failed"
        })
        this.recordRunMemory(this.store.getTaskById(task.id), run.id)
        this.store.completeClaimedTask(task.id, claimToken, "blocked", {
          blockedReason: "release_publication_failed",
          lastError: message
        })
        this.store.appendTaskEvent(task.id, "release-publication-failed", message, {
          promotionId: promotion.id,
          prNumber,
          prUrl,
          error: publishedRelease.error
        })
        this.store.appendTaskEvent(promotionSubject.id, "release-publication-failed", message, {
          promotionId: promotion.id,
          promoteTaskId: task.id,
          prNumber,
          prUrl,
          error: publishedRelease.error
        })
        if (task.workflowId) {
          this.store.refreshWorkflowStatus(task.workflowId)
        }
        this.audit(task.projectId)?.append("promotion-transition", {
          taskId: promotionSubject.id,
          promoteTaskId: task.id,
          promotionId: promotion.id,
          laneId: promotionSubject.laneId,
          to: "merged",
          prNumber,
          prUrl,
          releaseError: publishedRelease.error
        })
        return completeWithCheckoutRestored({ followUpTasks: 0 }, "promotion-release-failed")
      }

      releaseResult = publishedRelease
      const existingRelease = this.store
        .listReleases(project.id)
        .find((release) => release.version === publishedRelease.tagName)
      if (!existingRelease) {
        this.store.createRelease({
          projectRef: project.id,
          name: publishedRelease.tagName,
          version: publishedRelease.tagName,
          status: "released",
          releasedAt: new Date().toISOString(),
          notes: publishedRelease.notes
        })
      }
    }

    this.store.completeRun(run.id, {
      status: "succeeded",
      responseText: releaseResult
        ? `Merged pull request #${prNumber ?? "?"} and published release ${releaseResult.tagName}`
        : `Merged pull request #${prNumber ?? "?"}`,
      branchName: promotion.branchName,
      prNumber,
      headSha: prHeadSha,
      verificationSummary: releaseResult ? `merged; released ${releaseResult.tagName}` : "merged"
    })
    this.recordRunMemory(this.store.getTaskById(task.id), run.id)
    this.store.completeClaimedTask(task.id, claimToken, "done", {
      blockedReason: null,
      lastError: null
    })
    if (promotionSubject.id !== task.id) {
      this.store.updateTaskStatus(promotionSubject.id, "done", {
        assignedAgentId: task.assignedAgentId,
        lastError: null
      })
    }
    this.store.appendTaskEvent(promotionSubject.id, "promotion-merged", "Promotion merged into main.", {
      prNumber,
      prUrl,
      promoteTaskId: task.id,
      releaseTag: releaseResult?.tagName ?? null,
      releaseUrl: releaseResult?.url ?? null
    })
    this.store.appendTaskEvent(task.id, "promotion-merged", "Promotion task merged parent implementation into main.", {
      parentTaskId: promotionSubject.id,
      prNumber,
      prUrl,
      releaseTag: releaseResult?.tagName ?? null,
      releaseUrl: releaseResult?.url ?? null
    })
    if (releaseResult) {
      this.store.appendTaskEvent(
        promotionSubject.id,
        "release-published",
        "Published GitHub release after promotion.",
        {
          releaseTag: releaseResult.tagName,
          releaseUrl: releaseResult.url,
          promoteTaskId: task.id,
          prNumber,
          prUrl
        }
      )
      this.store.appendTaskEvent(task.id, "release-published", "Published GitHub release after promotion.", {
        parentTaskId: promotionSubject.id,
        releaseTag: releaseResult.tagName,
        releaseUrl: releaseResult.url,
        prNumber,
        prUrl
      })
    }
    this.recordTaskOutcome(task, run.id, {
      stage: "promotion",
      result: "success",
      reason: `Merged pull request #${prNumber ?? "?"}`,
      verificationPassed: true,
      metadata: { prNumber, prUrl }
    })
    this.audit(task.projectId)?.append("promotion-transition", {
      taskId: promotionSubject.id,
      promoteTaskId: task.id,
      promotionId: promotion.id,
      laneId: promotionSubject.laneId,
      to: "merged",
      prNumber,
      prUrl,
      releaseTag: releaseResult?.tagName ?? null,
      releaseUrl: releaseResult?.url ?? null
    })
    this.cleanupSuccessfulTaskWorktree(promotionSubject, project, "promotion-merged", run.id)
    return completeWithCheckoutRestored({ followUpTasks: 0 }, "promotion-merged")
  }

  private async runQueuedTasks(input: {
    companyId?: string | undefined
    healthByAdapter: Record<string, AdapterHealthcheckResult>
    projectIds?: Set<string>
    taskIds?: Set<string>
    executionWake?: Map<string, { wakeReason: WakeReason; heartbeatJobId: JobId | null; triggeredAt: string }>
    triggeredAt: string
  }): Promise<{
    executedRuns: number
    blockedTasks: number
    skippedTasks: number
    followUpTasks: number
  }> {
    const { companyId, healthByAdapter, projectIds, taskIds, executionWake = new Map(), triggeredAt } = input
    let executedRuns = 0
    let blockedTasks = 0
    let skippedTasks = 0
    let followUpTasks = 0
    let plannerRunsThisTick = 0
    let promotionMaterializedDuringSweep = false
    const runningExecutionTasks = new Set<Promise<void>>()
    const runningExecutionLanes = new Map<string, Promise<void>>()
    const codexQuota = readCodexQuotaOverview()
    this.recoverStalePromotionRecords(companyId, projectIds)
    this.recoverStaleLaneBlocks(companyId, projectIds)
    this.recoverRetryablePromotionBlocks(companyId, projectIds)
    this.recoverCompletedReviewFeedbackPromotions(companyId, projectIds)
    this.recoverCompletedReviewRepairParents(companyId, projectIds)
    this.recoverMergedFailedImplementationTasks(companyId, projectIds)
    this.recoverSatisfiedDependencyBlocks(companyId, projectIds)

    const queuedTasks = this.store
      .listQueuedTasks(companyId)
      .filter((task) => (!projectIds || projectIds.has(task.projectId)) && (!taskIds || taskIds.has(task.id)))
      .sort(
        (left, right) =>
          taskSelectionOrder(left) - taskSelectionOrder(right) ||
          right.priority - left.priority ||
          left.createdAt.localeCompare(right.createdAt)
      )

    const runnableCandidates = queuedTasks.filter((task) => dependencySatisfied(this.store, task))
    const blockedCandidates = queuedTasks.filter((task) => !dependencySatisfied(this.store, task))
    const selectedTasks = [...runnableCandidates, ...blockedCandidates].slice(0, queuedTaskWindow())
    const queuedPromotionBacklog = queuedTasks.some((task) => task.kind === "promote")

    for (const task of selectedTasks) {
      const executionLaneKey = isCodeProducingTask(task) && task.laneId ? `${task.projectId}:${task.laneId}` : null
      const runningLaneTask = executionLaneKey ? runningExecutionLanes.get(executionLaneKey) : null
      if (runningLaneTask) {
        this.store.appendTaskEvent(
          task.id,
          "lane-execution-serialized",
          "Waiting for the active implementation in this ownership lane before starting overlapping work.",
          { laneId: task.laneId }
        )
        await runningLaneTask
      }
      if (executionLaneKey) {
        const activeLaneRun = this.store.listRunningRuns(companyId).find((run) => {
          if (run.taskId === task.id) return false
          const activeTask = this.store.getTaskById(run.taskId)
          return (
            activeTask.projectId === task.projectId &&
            activeTask.laneId === task.laneId &&
            isCodeProducingTask(activeTask)
          )
        })
        if (activeLaneRun) {
          this.store.appendTaskEvent(
            task.id,
            "lane-execution-deferred",
            "Deferred overlapping implementation because this ownership lane has an active run.",
            { laneId: task.laneId, activeRunId: activeLaneRun.id, activeTaskId: activeLaneRun.taskId }
          )
          skippedTasks += 1
          continue
        }
      }
      const codexConcurrencyLimit = effectiveCodexConcurrencyLimit(codexQuota)
      const prefersCodex =
        task.requestedAdapterType === "codex_local" || task.taskPackage?.adapterPreference === "codex_local"
      while (
        prefersCodex &&
        runningExecutionTasks.size > 0 &&
        activeCodexRuns(this.store, companyId) >= codexConcurrencyLimit
      ) {
        await Promise.race(runningExecutionTasks)
      }
      if (runningExecutionTasks.size >= maxConcurrentExecutionRunsPerTick()) {
        await Promise.race(runningExecutionTasks)
      }

      if (task.kind === "plan" && plannerRunsThisTick >= maxPlannerRunsPerTick()) {
        skippedTasks += 1
        continue
      }

      if (task.kind === "follow_up" && queuedPromotionBacklog) {
        this.store.appendTaskEvent(
          task.id,
          "promotion-backlog-deferred",
          "Deferred AI follow-up while promotion tasks are queued.",
          {
            queuedPromotionTasks: queuedTasks.filter((candidate) => candidate.kind === "promote").length
          }
        )
        skippedTasks += 1
        continue
      }

      const dependencyBlockers = terminalDependencyBlockers(this.store, task)
      if (dependencyBlockers.length > 0) {
        const blockingDependency = dependencyBlockers[0]!
        this.store.updateTaskStatus(task.id, "blocked", {
          blockedReason: `dependency_${blockingDependency.status}:${blockingDependency.id}`
        })
        this.store.appendTaskEvent(
          task.id,
          "dependency-blocked",
          "Task blocked because a prerequisite reached a terminal non-success state.",
          {
            blockedDependencies: dependencyBlockers.map((dependency) => ({
              taskId: dependency.id,
              title: dependency.title,
              status: dependency.status,
              lastError: dependency.lastError
            }))
          }
        )
        blockedTasks += 1
        continue
      }

      if (!dependencySatisfied(this.store, task)) {
        skippedTasks += 1
        continue
      }

      const project = this.store.getProjectById(task.projectId)
      const owner = this.store.getCompanyById(task.companyId)
      let agents = this.store.listAgents(task.companyId)
      const wakeContext = resolveWakeContext(executionWake, project.id, triggeredAt)

      if (task.kind === "review") {
        const started = this.store.startRunWithClaim({
          companyId: owner.id,
          projectId: project.id,
          taskId: task.id,
          kind: "review",
          wakeReason: wakeContext.wakeReason,
          heartbeatJobId: wakeContext.heartbeatJobId
        })
        if (!started) {
          skippedTasks += 1
          continue
        }
        this.audit(task.projectId)?.append("task-claimed", {
          taskId: task.id,
          kind: "review",
          runId: started.run.id,
          claimExpiresAt: started.lease.claimExpiresAt
        })
        emitAgentLoopLifecycle(this.store, started.run.id, "start", {
          taskId: task.id,
          kind: "review",
          ownerPid: process.pid,
          wakeReason: wakeContext.wakeReason,
          heartbeatJobId: wakeContext.heartbeatJobId
        })
        executedRuns += 1
        followUpTasks += (await this.runReviewTask(task, project, started.run.id, started.lease.claimToken))
          .followUpTasks
        if (task.parentTaskId && this.store.getTaskById(task.parentTaskId).status === "promotion_pending") {
          promotionMaterializedDuringSweep =
            this.promoteReviewedTasks(project.id) > 0 || promotionMaterializedDuringSweep
        }
        continue
      }

      if (task.kind === "promote") {
        const promotionSubjectTaskId = task.parentTaskId ?? task.id
        if (task.laneId && this.store.isLaneBusy(task.projectId, task.laneId, promotionSubjectTaskId)) {
          const blockingPromotion = this.store.getPromotionByLane(task.projectId, task.laneId, promotionSubjectTaskId)
          this.store.updateTaskStatus(task.id, "blocked", {
            blockedReason: blockingPromotion
              ? `lane_busy_with_active_pr:${blockingPromotion.id}`
              : "lane_busy_with_active_pr"
          })
          this.store.appendTaskEvent(task.id, "lane-pr-blocked", "Lane already has an open promotion PR.", {
            laneId: task.laneId,
            blockingPromotionId: blockingPromotion?.id ?? null,
            blockingTaskId: blockingPromotion?.taskId ?? null
          })
          this.audit(task.projectId)?.append("lane-blocked", {
            taskId: task.id,
            laneId: task.laneId,
            blockingPromotionId: blockingPromotion?.id ?? null,
            blockingTaskId: blockingPromotion?.taskId ?? null
          })
          blockedTasks += 1
          continue
        }

        const started = this.store.startRunWithClaim({
          companyId: owner.id,
          projectId: project.id,
          taskId: task.id,
          kind: "promote",
          wakeReason: wakeContext.wakeReason,
          heartbeatJobId: wakeContext.heartbeatJobId
        })
        if (!started) {
          skippedTasks += 1
          continue
        }
        this.audit(task.projectId)?.append("task-claimed", {
          taskId: task.id,
          kind: "promote",
          runId: started.run.id,
          claimExpiresAt: started.lease.claimExpiresAt
        })
        emitAgentLoopLifecycle(this.store, started.run.id, "start", {
          taskId: task.id,
          kind: "promote",
          ownerPid: process.pid,
          wakeReason: wakeContext.wakeReason,
          heartbeatJobId: wakeContext.heartbeatJobId
        })
        executedRuns += 1
        followUpTasks += this.runPromoteTask(
          task,
          project,
          owner,
          started.run.id,
          started.lease.claimToken
        ).followUpTasks
        emitAgentLoopTerminalFromRun(this.store, this.store.getRunById(started.run.id), { stage: "promotion" })
        continue
      }

      if (promotionMaterializedDuringSweep) {
        break
      }

      if (task.approvalRequired) {
        const approval = this.store.getLatestApprovalRequest(task.id)
        if (!approval || approval.status !== "approved") {
          this.store.ensureApprovalRequest(task.id, "Task is marked as approval-required.")
          this.store.updateTaskStatus(task.id, "blocked", {
            blockedReason: "awaiting_approval"
          })
          blockedTasks += 1
          continue
        }
      }

      if (this.store.hasActiveRunForTask(task.id)) {
        skippedTasks += 1
        continue
      }

      const canRunInParallel = task.kind === "plan" || task.kind === "implement" || task.kind === "fix_review_feedback"
      if (!canRunInParallel && runningExecutionTasks.size > 0) {
        await Promise.all(runningExecutionTasks)
        runningExecutionTasks.clear()
      }

      const hasActiveExecutionWave = runningExecutionTasks.size > 0
      const dispatchableAgents = agents.filter((candidate) => this.isDispatchableAgent(candidate))
      const reviewerLockouts = this.store.findTeamReviewerLockouts(task.projectId, taskArtifactPaths(task), {
        taskId: task.id
      })
      const lockedAgentIds = new Set(reviewerLockouts.map((lockout) => lockout.lockedAgentId))
      const reviewerEligibleAgents = dispatchableAgents.filter((candidate) => !lockedAgentIds.has(candidate.id))
      if (reviewerLockouts.length > 0) {
        this.store.appendTaskEvent(
          task.id,
          "reviewer-lockout-applied",
          "Excluded rejected authors from independent revision routing.",
          {
            lockedAgentIds: Array.from(lockedAgentIds),
            artifactPaths: Array.from(new Set(reviewerLockouts.map((lockout) => lockout.artifactPath))),
            reviewerActors: Array.from(new Set(reviewerLockouts.map((lockout) => lockout.reviewerActor)))
          }
        )
      }
      let schedulableAgents = hasActiveExecutionWave
        ? reviewerEligibleAgents.filter((candidate) => !this.store.hasActiveRunForAgent(candidate.id))
        : reviewerEligibleAgents
      const taskNeedsTools =
        task.kind === "implement" || task.kind === "fix_review_feedback"
          ? taskRequiresTools(task)
          : taskHasHardExecutionSignals(task)
      let routingAgents = taskNeedsTools
        ? schedulableAgents.filter((candidate) => candidate.adapterType !== "azure_foundry")
        : schedulableAgents
      if (schedulableAgents.length === 0 && hasActiveExecutionWave) {
        await Promise.all(runningExecutionTasks)
        runningExecutionTasks.clear()
        agents = this.store.listAgents(task.companyId)
        const refreshedDispatchableAgents = agents
          .filter((candidate) => this.isDispatchableAgent(candidate))
          .filter((candidate) => !lockedAgentIds.has(candidate.id))
        schedulableAgents = refreshedDispatchableAgents
        routingAgents = taskNeedsTools
          ? schedulableAgents.filter((candidate) => candidate.adapterType !== "azure_foundry")
          : schedulableAgents
      }

      const personaSelection = this.selectPersonaAgent(task, routingAgents)
      if (taskNeedsTools && personaSelection.agent?.adapterType === "azure_foundry") {
        personaSelection.agent = null
        personaSelection.reason = `persona ${personaSelection.persona?.name ?? "unknown"} skipped for tool-using repo execution`
      }
      if (
        task.requestedAdapterType &&
        personaSelection.agent &&
        personaSelection.agent.adapterType !== task.requestedAdapterType
      ) {
        personaSelection.reason =
          `persona ${personaSelection.persona?.name ?? "unknown"} skipped because ` +
          `${task.requestedAdapterType} was explicitly requested`
        personaSelection.agent = null
      }
      const routingHealthByAdapter = { ...healthByAdapter }
      const costValueDecision = buildCostValueDecision(task, personaSelection.persona?.stage ?? task.stage)
      const codexRoutingAgents = routingAgents.filter((candidate) => candidate.adapterType === "codex_local")
      const codexRoutingDeferralReason = codexQuotaDeferralReason(
        codexQuota,
        activeCodexRuns(this.store, companyId),
        codexRoutingAgents.length === 0 || codexRoutingAgents.every(agentUsesManagedCodexQuota)
      )
      if (codexRoutingDeferralReason) {
        routingHealthByAdapter.codex_local = {
          ok: false,
          message: `Codex quota constrained: ${codexRoutingDeferralReason}`
        }
      }
      for (const adapterType of ["codex_local", "gemini_local", "azure_foundry"] as const) {
        const poolReason =
          adapterType === "codex_local" &&
          codexRoutingAgents.some((candidate) => !agentUsesManagedCodexQuota(candidate))
            ? null
            : adapterPoolReason(this.store, owner.id, adapterType, triggeredAt)
        if (poolReason) {
          routingHealthByAdapter[adapterType] = {
            ok: false,
            message: poolReason
          }
        }
      }
      if (personaSelection.agent) {
        const personaAdapterHealth = routingHealthByAdapter[personaSelection.agent.adapterType]
        if (personaAdapterHealth && !personaAdapterHealth.ok) {
          personaSelection.reason =
            `persona ${personaSelection.persona?.name ?? "unknown"} skipped because ` +
            `${personaSelection.agent.adapterType} is unavailable: ${personaAdapterHealth.message}`
          personaSelection.agent = null
        }
      }

      const routedDecision = routeTask({
        task,
        rules: this.store.listRoutingRules(),
        agents: routingAgents,
        healthByAdapter: routingHealthByAdapter
      })
      let decision: RouteDecision = personaSelection.agent
        ? {
            ...routedDecision,
            adapterType: personaSelection.agent.adapterType,
            reason: personaSelection.reason ?? "matched persona",
            rule: null,
            agent: personaSelection.agent,
            fallbackLadder: [personaSelection.agent.adapterType],
            selectionReasons: [personaSelection.reason ?? "matched persona", ...routedDecision.selectionReasons],
            agentSelection: {
              agent: personaSelection.agent,
              reason: personaSelection.reason ?? "matched persona",
              candidates: [
                {
                  agentId: personaSelection.agent.id,
                  agentName: personaSelection.agent.name,
                  adapterType: personaSelection.agent.adapterType,
                  model: personaSelection.agent.model,
                  modelFamily: normalizedModelFamily(personaSelection.agent),
                  score: 1000,
                  estimatedCostUsd: null,
                  reasons: [personaSelection.reason ?? "matched persona"]
                }
              ]
            }
          }
        : routedDecision

      let agent: Agent | null = null
      let agentSelection: AgentSelectionDecision | null = null
      let selectedBudget: BudgetStatus | null = null
      const primaryAdapterType = decision.adapterType
      const failoverAgents = routingAgents
      const failoverLadder = adapterFailoverLadder(decision.adapterType, decision.fallbackLadder)
      const dispatchAttempts: Array<{
        adapterType: Agent["adapterType"]
        reason: string
        retryable: boolean
      }> = []
      let codexQuotaEventRecorded = false
      let cooperativeRatePoolEventRecorded = false
      const ratePoolAvailabilityByAgent = new Map<string, CooperativeRatePoolAvailability>()
      const ratePoolAvailabilityFor = (candidate: Agent): CooperativeRatePoolAvailability => {
        const cached = ratePoolAvailabilityByAgent.get(candidate.id)
        if (cached) return cached
        const availability = cooperativeRatePoolAvailability({
          stateRepoPath: project.repoPath,
          agentName: candidate.name,
          priority: task.priority ?? 2,
          now: new Date(triggeredAt)
        })
        ratePoolAvailabilityByAgent.set(candidate.id, availability)
        return availability
      }
      const recordCodexQuotaDeferred = (reason: string) => {
        if (codexQuotaEventRecorded) return
        codexQuotaEventRecorded = true
        this.store.appendTaskEvent(
          task.id,
          "codex-quota-deferred",
          "Deferred Codex execution because quota headroom or concurrency policy is constrained.",
          {
            reason,
            assessment: codexQuota.assessment,
            availableAccounts: codexQuota.availableAccounts,
            healthyAccounts: codexQuota.healthyAccounts,
            warmAccounts: codexQuota.warmAccounts,
            recommendedMaxConcurrentCodexRuns: codexQuota.recommendedMaxConcurrentCodexRuns,
            activeAccount: codexQuota.activeAccount,
            bestAccount: codexQuota.bestAccount
          }
        )
      }

      for (const adapterType of failoverLadder) {
        const adapterAgents = failoverAgents.filter((candidate) => candidate.adapterType === adapterType)
        const candidateAgents =
          task.assignedAgentId && adapterType === primaryAdapterType
            ? adapterAgents.filter((candidate) => candidate.id === task.assignedAgentId)
            : adapterAgents
        if (adapterAgents.length === 0) {
          dispatchAttempts.push({
            adapterType,
            reason: "no compatible dispatchable agents",
            retryable: false
          })
          continue
        }

        const managedCodexDeferralReason =
          adapterType === "codex_local"
            ? codexQuotaDeferralReason(codexQuota, activeCodexRuns(this.store, companyId), true)
            : null
        const quotaEligibleCandidateAgents = managedCodexDeferralReason
          ? candidateAgents.filter((candidate) => !agentUsesManagedCodexQuota(candidate))
          : candidateAgents
        if (candidateAgents.length === 0) {
          dispatchAttempts.push({
            adapterType,
            reason: `assigned agent ${task.assignedAgentId} is unavailable for dispatch`,
            retryable: true
          })
          continue
        }

        const ratePoolEligibleCandidateAgents = quotaEligibleCandidateAgents.filter(
          (candidate) => ratePoolAvailabilityFor(candidate).allowed
        )
        const ratePoolBlockedCandidates = quotaEligibleCandidateAgents
          .filter((candidate) => !ratePoolAvailabilityFor(candidate).allowed)
          .map((candidate) => ({
            agentId: candidate.id,
            agentName: candidate.name,
            ...ratePoolAvailabilityFor(candidate)
          }))
        if (ratePoolBlockedCandidates.length > 0 && !cooperativeRatePoolEventRecorded) {
          cooperativeRatePoolEventRecorded = true
          this.store.appendTaskEvent(
            task.id,
            "cooperative-rate-pool-agent-skipped",
            "Skipped agents without cooperative rate-pool headroom before allocating execution work.",
            {
              adapterType,
              candidates: ratePoolBlockedCandidates
            }
          )
        }
        if (quotaEligibleCandidateAgents.length > 0 && ratePoolEligibleCandidateAgents.length === 0) {
          const nextResetAt = ratePoolBlockedCandidates
            .map((candidate) => candidate.resetAt)
            .filter((value): value is string => Boolean(value))
            .sort()[0]
          dispatchAttempts.push({
            adapterType,
            reason: `all compatible agents have exhausted cooperative rate-pool allocations${nextResetAt ? ` until ${nextResetAt}` : ""}`,
            retryable: true
          })
          continue
        }

        const selectedAdapterHealth = routingHealthByAdapter[adapterType]
        if (selectedAdapterHealth && !selectedAdapterHealth.ok) {
          const reason = selectedAdapterHealth.message || `${adapterType} is unhealthy`
          dispatchAttempts.push({ adapterType, reason, retryable: true })
          if (adapterType === "codex_local") {
            recordCodexQuotaDeferred(
              codexQuotaDeferralReason(
                codexQuota,
                activeCodexRuns(this.store, companyId),
                candidateAgents.every(agentUsesManagedCodexQuota)
              ) ?? reason
            )
          }
          continue
        }

        const poolReason =
          adapterType === "codex_local" &&
          quotaEligibleCandidateAgents.some((candidate) => !agentUsesManagedCodexQuota(candidate))
            ? null
            : adapterPoolReason(this.store, owner.id, adapterType, triggeredAt)
        if (poolReason) {
          dispatchAttempts.push({ adapterType, reason: poolReason, retryable: true })
          if (adapterType === "codex_local") {
            const deferralReason = codexQuotaDeferralReason(
              codexQuota,
              activeCodexRuns(this.store, companyId),
              candidateAgents.every(agentUsesManagedCodexQuota)
            )
            if (deferralReason) recordCodexQuotaDeferred(deferralReason)
          }
          continue
        }

        if (adapterType === "codex_local") {
          const deferralReason = codexQuotaDeferralReason(
            codexQuota,
            activeCodexRuns(this.store, companyId),
            candidateAgents.every(agentUsesManagedCodexQuota)
          )
          if (deferralReason) {
            dispatchAttempts.push({ adapterType, reason: deferralReason, retryable: true })
            recordCodexQuotaDeferred(deferralReason)
            continue
          }
        }

        const personaRankedAgents = personaSelection.persona
          ? ratePoolEligibleCandidateAgents.filter((candidate) =>
              agentMatchesPersonaStage(candidate, personaSelection.persona!)
            )
          : ratePoolEligibleCandidateAgents
        const rankedAgentSelection = selectBestAgentForTask(
          task,
          personaRankedAgents.length > 0 ? personaRankedAgents : ratePoolEligibleCandidateAgents,
          adapterType,
          personaSelection.persona
        )
        const candidateAgent = rankedAgentSelection.agent
        if (!candidateAgent) {
          dispatchAttempts.push({
            adapterType,
            reason: "no active agent matched the task and persona constraints",
            retryable: false
          })
          continue
        }

        if (
          !candidateAgent.heartbeatEnabled ||
          candidateAgent.status === "paused" ||
          candidateAgent.status === "blocked"
        ) {
          dispatchAttempts.push({
            adapterType,
            reason: `selected agent ${candidateAgent.name} is ${candidateAgent.status}`,
            retryable: candidateAgent.status !== "blocked"
          })
          continue
        }

        if (
          this.store.hasActiveRunForAgent(candidateAgent.id) &&
          !adapterSupportsConcurrentAgentRuns(candidateAgent.adapterType)
        ) {
          if (runningExecutionTasks.size > 0) {
            await Promise.all(runningExecutionTasks)
            runningExecutionTasks.clear()
          }
          if (this.store.hasActiveRunForAgent(candidateAgent.id)) {
            dispatchAttempts.push({
              adapterType,
              reason: `selected agent ${candidateAgent.name} already has an active run`,
              retryable: true
            })
            continue
          }
        }

        const candidateBudget = this.store.getBudgetStatus(candidateAgent)
        if (candidateBudget.blocked) {
          this.store.setAgentStatus(candidateAgent.id, "blocked")
          dispatchAttempts.push({
            adapterType,
            reason: `selected agent ${candidateAgent.name} is blocked by budget policy`,
            retryable: false
          })
          continue
        }

        agent = candidateAgent
        agentSelection = rankedAgentSelection
        selectedBudget = candidateBudget
        break
      }

      if (!agent) {
        const hasPotentialAgent = failoverLadder.some((adapterType) =>
          agents.some((candidate) => candidate.adapterType === adapterType)
        )
        this.store.appendTaskEvent(
          task.id,
          "agent-selection-deferred",
          "Deferred execution because all routed adapter capabilities are currently unavailable.",
          {
            requestedAdapterType: decision.adapterType,
            assignedAgentId: task.assignedAgentId ?? null,
            fallbackLadder: failoverLadder,
            attempts: dispatchAttempts,
            compatibleAgents: agents
              .filter((candidate) => failoverLadder.includes(candidate.adapterType))
              .map((candidate) => ({
                agentId: candidate.id,
                name: candidate.name,
                adapterType: candidate.adapterType,
                status: candidate.status,
                heartbeatEnabled: candidate.heartbeatEnabled
              }))
          }
        )
        if (!hasPotentialAgent && dispatchAttempts.every((attempt) => !attempt.retryable)) {
          this.store.updateTaskStatus(task.id, "blocked", {
            blockedReason: `no_available_agent:${decision.adapterType}`
          })
          blockedTasks += 1
        } else {
          skippedTasks += 1
        }
        continue
      }

      const effectiveAgentSelection: AgentSelectionDecision = agentSelection ?? {
        agent,
        reason: "selected dispatchable fallback agent",
        candidates: []
      }
      const originalAdapterType = decision.adapterType
      const originalReason = decision.reason
      decision = {
        ...decision,
        agent,
        agentSelection: effectiveAgentSelection
      }
      if (agent.adapterType !== originalAdapterType) {
        const failoverReason =
          dispatchAttempts.find((attempt) => attempt.adapterType === originalAdapterType)?.reason ??
          "selected adapter was unavailable"
        decision = {
          ...decision,
          adapterType: agent.adapterType,
          reason: `adapter failover from ${originalAdapterType} to ${agent.adapterType}: ${failoverReason}`,
          rule: null,
          selectedModel: agent.model,
          modelFamily: normalizedModelFamily(agent),
          modelRoutingReason: `adapter failover selected runnable ${agent.adapterType} agent ${agent.name}`,
          fallbackLadder: failoverLadder,
          selectionReasons: [
            `adapter failover from ${originalAdapterType} to ${agent.adapterType}: ${failoverReason}`,
            ...decision.selectionReasons
          ]
        }
        this.store.appendTaskEvent(
          task.id,
          "adapter-failover-routed",
          "Rerouted task to a fallback adapter because the selected route was unavailable.",
          {
            fromAdapterType: originalAdapterType,
            toAdapterType: agent.adapterType,
            fromReason: originalReason,
            failoverReason,
            fallbackLadder: failoverLadder,
            attempts: dispatchAttempts
          }
        )
      }
      decision = coerceRouteDecisionModelForAgent(decision, agent)
      const budget = selectedBudget ?? this.store.getBudgetStatus(agent)

      if (task.kind === "implement" && task.laneId && this.store.isLaneBusy(task.projectId, task.laneId, task.id)) {
        const blockingPromotion = this.store.getPromotionByLane(task.projectId, task.laneId, task.id)
        this.store.updateTaskStatus(task.id, "blocked", {
          blockedReason: blockingPromotion
            ? `lane_busy_with_active_pr:${blockingPromotion.id}`
            : "lane_busy_with_active_pr"
        })
        this.audit(task.projectId)?.append("lane-blocked", {
          taskId: task.id,
          laneId: task.laneId,
          blockingPromotionId: blockingPromotion?.id ?? null,
          blockingTaskId: blockingPromotion?.taskId ?? null
        })
        blockedTasks += 1
        continue
      }

      const executionAgent: Agent =
        decision.selectedModel !== agent.model ? { ...agent, model: decision.selectedModel } : agent
      const routingPolicy = {
        selectedModel: decision.selectedModel,
        reasoningEffort: decision.reasoningEffort,
        modelFamily: decision.modelFamily,
        modelRoutingReason: decision.modelRoutingReason,
        complexityScore: decision.risk.complexityScore,
        complexityScore100: decision.risk.complexityScore100,
        importanceScore: decision.risk.importanceScore,
        valueScore100: decision.risk.valueScore100,
        complexityBand: decision.risk.complexityBand,
        importanceBand: decision.risk.importanceBand,
        domains: decision.risk.domains,
        complexitySignals: decision.risk.complexitySignals,
        importanceSignals: decision.risk.importanceSignals,
        promptRouteRank: decision.risk.promptRouteRank,
        costEstimate: decision.costEstimate
      }
      const supportsGitWorktrees = projectSupportsGitWorktrees(project)
      const projectProfileForExecution = this.loadProjectProfile(project)
      if (supportsGitWorktrees) {
        const diskHeadroom = checkWorktreeDiskHeadroom(worktreeRootForProject(project, projectProfileForExecution))
        if (!diskHeadroom.ok) {
          this.store.appendTaskEvent(
            task.id,
            "worktree-disk-deferred",
            "Deferred execution because the worktree filesystem does not have enough free space.",
            {
              worktreeRoot: diskHeadroom.path,
              availableBytes: diskHeadroom.availableBytes,
              totalBytes: diskHeadroom.totalBytes,
              requiredBytes: diskHeadroom.requiredBytes,
              availablePercent: diskHeadroom.availablePercent,
              reason: diskHeadroom.message
            }
          )
          skippedTasks += 1
          continue
        }
      }
      const sessionKey = computeSessionKey(executionAgent, project, task)
      const teamRoute = evaluatePersistedTeamRoute(this.store, task, executionAgent)
      if (teamRoute.decision.blocked) {
        const conflictingAssignmentIds = Array.from(
          new Set(teamRoute.decision.candidates.flatMap((candidate) => candidate.conflictingAssignmentIds))
        )
        this.store.appendTaskEvent(
          task.id,
          teamRoute.decision.blockKind === "conflict" ? "artifact-conflict-deferred" : "team-route-deferred",
          teamRoute.decision.blockKind === "conflict"
            ? "Deferred execution because another active assignment owns an overlapping artifact scope."
            : "Deferred execution because the durable team router found no available assignment slot.",
          {
            blockKind: teamRoute.decision.blockKind,
            reason: teamRoute.decision.reason,
            artifactPaths: teamRoute.artifactPaths,
            conflictingAssignmentIds,
            candidates: teamRoute.decision.candidates
          }
        )
        this.audit(task.projectId)?.append("team-route-deferred", {
          taskId: task.id,
          agentId: executionAgent.id,
          blockKind: teamRoute.decision.blockKind,
          artifactPaths: teamRoute.artifactPaths,
          conflictingAssignmentIds
        })
        skippedTasks += 1
        continue
      }
      const started = this.store.startRunWithClaim({
        companyId: owner.id,
        projectId: project.id,
        taskId: task.id,
        agentId: executionAgent.id,
        adapterType: executionAgent.adapterType,
        kind: task.kind,
        sessionKey,
        wakeReason: wakeContext.wakeReason,
        heartbeatJobId: wakeContext.heartbeatJobId,
        teamAssignment: {
          artifactPaths: teamRoute.artifactPaths,
          routingReason: teamRoute.decision.reason,
          routingDecision: {
            team: teamRoute.decision,
            dispatcher: {
              reason: decision.reason,
              selectedAgentId: executionAgent.id,
              selectedAgentName: executionAgent.name,
              selectedAdapterType: executionAgent.adapterType,
              selectedModel: executionAgent.model
            }
          }
        }
      })
      if (!started) {
        const lockouts = this.store.findTeamReviewerLockouts(project.id, teamRoute.artifactPaths, {
          taskId: task.id,
          lockedAgentId: executionAgent.id
        })
        if (lockouts.length > 0) {
          this.store.appendTaskEvent(
            task.id,
            "reviewer-lockout-deferred",
            "Deferred execution because a reviewer lockout won the atomic run lease race.",
            {
              lockedAgentId: executionAgent.id,
              artifactPaths: Array.from(new Set(lockouts.map((lockout) => lockout.artifactPath))),
              reviewerActors: Array.from(new Set(lockouts.map((lockout) => lockout.reviewerActor)))
            }
          )
        }
        const conflicts = this.store.findTeamArtifactConflicts(project.id, teamRoute.artifactPaths)
        if (conflicts.length > 0) {
          this.store.appendTaskEvent(
            task.id,
            "artifact-conflict-deferred",
            "Deferred execution because an overlapping artifact claim won the atomic run lease race.",
            {
              artifactPaths: teamRoute.artifactPaths,
              conflictingAssignmentIds: Array.from(new Set(conflicts.map((claim) => claim.assignmentId))),
              conflictingTaskIds: Array.from(new Set(conflicts.map((claim) => claim.taskId)))
            }
          )
        }
        skippedTasks += 1
        continue
      }
      this.audit(task.projectId)?.append("task-claimed", {
        taskId: task.id,
        kind: task.kind,
        runId: started.run.id,
        agentId: executionAgent.id,
        teamAssignmentId: started.assignment?.id ?? null,
        artifactPaths: started.assignment?.artifactPaths ?? [],
        claimExpiresAt: started.lease.claimExpiresAt
      })

      const claimToken = started.lease.claimToken
      const liveTask = this.store.getTaskById(task.id)
      emitAgentLoopLifecycle(this.store, started.run.id, "start", {
        runId: started.run.id,
        ownerPid: process.pid,
        acceptedAt: started.run.createdAt,
        startedAt: started.run.startedAt,
        taskId: liveTask.id,
        taskKind: liveTask.kind,
        projectId: project.id,
        agentId: executionAgent.id,
        agentName: executionAgent.name,
        adapterType: executionAgent.adapterType,
        model: executionAgent.model,
        sessionKey
      })
      this.store.updateRunMetadata(started.run.id, {
        agentLoop: {
          version: 1,
          acceptedAt: started.run.createdAt,
          sessionKey,
          streams: ["lifecycle", "assistant", "tool"]
        },
        teamRouting: {
          assignmentId: started.assignment?.id ?? null,
          artifactPaths: started.assignment?.artifactPaths ?? [],
          reason: teamRoute.decision.reason,
          candidates: teamRoute.decision.candidates
        }
      })
      if (started.assignment) {
        this.store.appendRunEvent(started.run.id, "info", "Durable team assignment persisted", {
          assignmentId: started.assignment.id,
          agentId: started.assignment.agentId,
          artifactPaths: started.assignment.artifactPaths,
          routingReason: started.assignment.routingReason
        })
      }

      let executionWorkspace: ExecutionWorkspace | null = null
      let executionProject: Project = project
      let inheritedExecutionSource: InheritedExecutionSource | null = null

      try {
        if (supportsGitWorktrees) {
          try {
            const gitSync = await syncRepoAndWorktrees({
              repoPath: project.repoPath,
              timeoutMs: 30_000
            })
            this.store.appendRunEvent(started.run.id, "info", "Git sync completed", {
              repoPath: gitSync.repoPath,
              root: gitSync.root,
              worktrees: gitSync.worktrees,
              warnings: gitSync.warnings
            })
          } catch (err) {
            this.store.appendRunEvent(started.run.id, "warn", "Git sync failed", {
              error: err instanceof Error ? err.message : String(err)
            })
          }

          const repairSourceRunId =
            liveTask.kind === "repair"
              ? liveTask.labels.find((label) => label.startsWith("repair-for:"))?.slice("repair-for:".length) || null
              : null
          const repairSourceRun = repairSourceRunId ? this.store.getRunById(repairSourceRunId) : null
          const preservedSourceRun = isCodeProducingTask(liveTask)
            ? repairSourceRun?.branchName
              ? repairSourceRun
              : this.store.getLatestPreservedExecutionRunForTask(liveTask.id, started.run.id)
            : null
          if (preservedSourceRun?.branchName) {
            const sourceRef = resolvePromotionStartRef({
              repoPath: project.repoPath,
              branchName: preservedSourceRun.branchName,
              headSha: preservedSourceRun.headSha
            })
            if ("error" in sourceRef) {
              throw new Error(`Failed to resume preserved execution for ${liveTask.id}: ${sourceRef.error}`)
            }
            inheritedExecutionSource = {
              reason: repairSourceRun?.id === preservedSourceRun.id ? "repair_source" : "preserved_retry",
              taskId: repairSourceRun?.id === preservedSourceRun.id ? preservedSourceRun.taskId : liveTask.id,
              runId: preservedSourceRun.id,
              branchName: preservedSourceRun.branchName,
              ref: sourceRef.ref,
              source: sourceRef.source,
              worktreePath: preservedSourceRun.worktreePath,
              manifestPath: preservedSourceRun.manifestPath
            }
          } else if (liveTask.kind === "fix_review_feedback" && liveTask.parentTaskId) {
            const sourceRun = this.store.getLatestSuccessfulImplementationRunForTask(liveTask.parentTaskId)
            if (sourceRun?.branchName) {
              const sourceRef = resolvePromotionStartRef({
                repoPath: project.repoPath,
                branchName: sourceRun.branchName,
                headSha: sourceRun.headSha
              })
              if ("error" in sourceRef) {
                throw new Error(
                  `Failed to inherit rejected implementation for review repair ${liveTask.id}: ${sourceRef.error}`
                )
              }
              inheritedExecutionSource = {
                reason: "review_repair",
                taskId: liveTask.parentTaskId,
                runId: sourceRun.id,
                branchName: sourceRun.branchName,
                ref: sourceRef.ref,
                source: sourceRef.source,
                worktreePath: sourceRun.worktreePath,
                manifestPath: sourceRun.manifestPath
              }
            }
          }

          executionWorkspace = prepareExecutionWorkspace({
            project,
            profile: projectProfileForExecution,
            task: liveTask,
            runId: started.run.id,
            ...(inheritedExecutionSource ? { baseRef: inheritedExecutionSource.ref } : {})
          })

          this.store.updateRunWorkspace(started.run.id, {
            branchName: executionWorkspace.branchName,
            worktreePath: executionWorkspace.worktreePath,
            manifestPath: executionWorkspace.manifestPath
          })
          executionProject = {
            ...project,
            repoPath: executionWorkspace.worktreePath
          }
          this.store.appendRunEvent(started.run.id, "info", "Execution worktree allocated", {
            branchName: executionWorkspace.branchName,
            baseRef: executionWorkspace.baseRef,
            inheritedSourceReason: inheritedExecutionSource?.reason ?? null,
            repairSourceTaskId:
              inheritedExecutionSource?.reason === "review_repair" ||
              inheritedExecutionSource?.reason === "repair_source"
                ? inheritedExecutionSource.taskId
                : null,
            repairSourceRunId:
              inheritedExecutionSource?.reason === "review_repair" ||
              inheritedExecutionSource?.reason === "repair_source"
                ? inheritedExecutionSource.runId
                : null,
            repairSourceRefKind:
              inheritedExecutionSource?.reason === "review_repair" ||
              inheritedExecutionSource?.reason === "repair_source"
                ? inheritedExecutionSource.source
                : null,
            retrySourceTaskId:
              inheritedExecutionSource?.reason === "preserved_retry" ? inheritedExecutionSource.taskId : null,
            retrySourceRunId:
              inheritedExecutionSource?.reason === "preserved_retry" ? inheritedExecutionSource.runId : null,
            retrySourceRefKind:
              inheritedExecutionSource?.reason === "preserved_retry" ? inheritedExecutionSource.source : null,
            worktreePath: executionWorkspace.worktreePath,
            manifestPath: executionWorkspace.manifestPath
          })
        } else {
          this.store.appendRunEvent(started.run.id, "warn", "Execution worktree allocation skipped", {
            reason: "project repoPath is not a git worktree",
            repoPath: project.repoPath
          })
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (isDiskSpaceWorktreeError(message)) {
          this.store.appendRunEvent(
            started.run.id,
            "error",
            "Execution worktree allocation deferred by disk headroom.",
            {
              error: message
            }
          )
          this.store.completeRun(started.run.id, {
            status: "cancelled",
            errorText: message,
            verificationSummary: "worktree-disk-deferred"
          })
          const taskUpdated = this.store.completeClaimedTask(liveTask.id, claimToken, "queued", {
            assignedAgentId: executionAgent.id,
            lastError: message,
            blockedReason: "worktree_disk_headroom"
          })
          if (taskUpdated) {
            this.store.appendTaskEvent(
              liveTask.id,
              "worktree-disk-deferred",
              "Requeued execution because the worktree checkout hit a disk-space error.",
              {
                runId: started.run.id,
                reason: message
              }
            )
          }
          skippedTasks += 1
          continue
        }
        const failure = this.handleFailure(liveTask, started.run.id, claimToken, message, executionAgent.id)
        emitAgentLoopTerminalFromRun(this.store, this.store.getRunById(started.run.id), {
          stage: "workspace-preparation"
        })
        followUpTasks += failure.followUpTasks
        skippedTasks += 1
        continue
      }

      const adapter = this.adapters[executionAgent.adapterType]
      if (!adapter) {
        this.store.completeRun(started.run.id, {
          status: "failed",
          errorText: `Missing adapter implementation for ${executionAgent.adapterType}`
        })
        emitAgentLoopTerminalFromRun(this.store, this.store.getRunById(started.run.id), {
          stage: "adapter-resolution",
          adapterType: executionAgent.adapterType
        })
        this.store.completeClaimedTask(task.id, claimToken, "failed", {
          assignedAgentId: executionAgent.id,
          lastError: `Missing adapter implementation for ${executionAgent.adapterType}`
        })
        this.cleanupRunExecutionWorkspace({
          runId: started.run.id,
          project,
          workspace: executionWorkspace,
          reason: "missing-adapter",
          clearRunWorkspace: true
        })
        blockedTasks += 1
        continue
      }

      const storedSessionState = this.store.getSessionState(sessionKey)
      const sessionRotation = evaluateSessionRotation({
        agent: executionAgent,
        capabilities: adapter.capabilities,
        sessionState: storedSessionState,
        now: wakeContext.triggeredAt
      })
      const sessionState = sessionRotation.rotate ? null : storedSessionState
      const run = started.run
      const runtimeIdentity = buildRuntimeIdentity({
        runId: run.id,
        task: liveTask,
        project: executionProject,
        company: owner,
        agent: executionAgent,
        adapter,
        sessionKey,
        sessionState,
        routing: routingPolicy,
        wakeReason: wakeContext.wakeReason,
        heartbeatJobId: wakeContext.heartbeatJobId,
        triggeredAt: wakeContext.triggeredAt
      })
      const executionPath = executionPathForTask(this.store, liveTask, executionAgent, run.id, personaSelection.persona)
      const tracer = createExecutionTracer({
        runId: run.id,
        name: `openclaw.run.${liveTask.kind}`,
        executionPath,
        attributes: {
          companyId: owner.id,
          projectId: executionProject.id,
          taskId: liveTask.id,
          taskKind: liveTask.kind,
          workflowId: liveTask.workflowId,
          laneId: liveTask.laneId,
          agentId: executionAgent.id,
          agentName: executionAgent.name,
          adapterType: executionAgent.adapterType,
          model: executionAgent.model,
          wakeReason: wakeContext.wakeReason
        }
      })
      const rootSpan = tracer.root()
      let telemetryStatus: "ok" | "error" = "error"
      let telemetryAttributes: Record<string, unknown> = {}

      executedRuns += 1
      if (liveTask.kind === "plan") {
        plannerRunsThisTick += 1
      }
      this.store.setAgentStatus(executionAgent.id, "running")
      this.store.updateRunMetadata(run.id, {
        scheduler: {
          selectedAdapterType: executionAgent.adapterType,
          selectedAgentId: executionAgent.id,
          selectedAgentName: executionAgent.name,
          routingReason: decision.reason,
          fallbackLadder: decision.fallbackLadder,
          taskShape: decision.taskShape,
          teamAssignmentId: started.assignment?.id ?? null,
          teamArtifactPaths: started.assignment?.artifactPaths ?? [],
          teamRoutingReason: teamRoute.decision.reason,
          executionPath,
          modelRouting: routingPolicy
        },
        costValuePolicy: costValueDecision,
        telemetry: {
          traceId: tracer.trace.traceId,
          rootSpanId: tracer.trace.rootSpanId,
          executionPath
        }
      })
      this.store.appendRunEvent(run.id, "info", "Run started", {
        adapterType: decision.adapterType,
        routingReason: decision.reason,
        routingShape: decision.taskShape,
        routingFallbackLadder: decision.fallbackLadder,
        routingSelectionReasons: decision.selectionReasons,
        routingScorecard: decision.scorecard,
        selectedAgent: {
          id: executionAgent.id,
          name: executionAgent.name,
          adapterType: executionAgent.adapterType,
          model: executionAgent.model
        },
        modelRouting: routingPolicy,
        modelSelection: agentSelection,
        teamRouting: {
          assignmentId: started.assignment?.id ?? null,
          artifactPaths: started.assignment?.artifactPaths ?? [],
          reason: teamRoute.decision.reason
        },
        costValuePolicy: costValueDecision,
        runtimeIdentity
      })
      this.audit(task.projectId)?.append("run-started", {
        runId: run.id,
        taskId: liveTask.id,
        agentId: executionAgent.id,
        adapterType: executionAgent.adapterType,
        routingReason: decision.reason,
        routingShape: decision.taskShape,
        selectedModel: executionAgent.model,
        reasoningEffort: decision.reasoningEffort,
        runtimeIdentity
      })
      if (personaSelection.persona) {
        this.store.appendRunEvent(run.id, "info", "Persona selected", {
          persona: {
            id: personaSelection.persona.id,
            name: personaSelection.persona.name,
            stage: personaSelection.persona.stage,
            ownedLanes: personaSelection.persona.ownedLanes,
            preferredAdapterType: personaSelection.persona.preferredAdapterType
          },
          routingReason: personaSelection.reason
        })
      }
      if (liveTask.taskPackage) {
        this.store.appendRunEvent(run.id, "info", "Task package attached", {
          taskPackage: liveTask.taskPackage
        })
      }
      this.store.appendRunEvent(run.id, "info", "Verification strategy selected", {
        verificationCommands: verificationCommands(liveTask, executionProject)
      })
      if (sessionRotation.rotate) {
        this.store.appendRunEvent(run.id, "info", "Session rotation applied", {
          reason: sessionRotation.reason,
          previousSessionDisplayId: storedSessionState?.sessionDisplayId ?? null
        })
        rootSpan.event("session.rotation", {
          attributes: {
            reason: sessionRotation.reason,
            previousSessionDisplayId: storedSessionState?.sessionDisplayId ?? null
          }
        })
      }

      const executionTask = (async (): Promise<void> => {
        let agentLoopTerminalEmitted = false
        const emitTerminalLifecycle = (payload: Record<string, unknown> = {}) => {
          if (agentLoopTerminalEmitted) return
          const event = emitAgentLoopTerminalFromRun(this.store, this.store.getRunById(run.id), payload)
          if (event) agentLoopTerminalEmitted = true
        }

        try {
          const memorySpan = tracer.startSpan({
            name: "memory.retrieve",
            kind: "memory",
            attributes: {
              sessionKey,
              hadPreviousSession: Boolean(storedSessionState)
            }
          })
          const relevantMemory = await this.loadRelevantMemory(liveTask, executionAgent, project, run.id)
          memorySpan.succeed({
            attributes: {
              attachedMemory: Boolean(relevantMemory)
            }
          })
          const toolingCache = new RunToolingCache(run.id)
          const recentTaskEvents = this.store.getTaskEvents(liveTask.id)
          const recentRun = this.store.getLatestRunForTask(liveTask.id)
          const recentRunEvents = recentRun ? this.store.getRunEvents(recentRun.id) : []
          const parentTask = liveTask.parentTaskId ? this.store.getTaskById(liveTask.parentTaskId) : null
          const promptSpan = tracer.startSpan({
            name: "prompt.build",
            kind: "stage",
            attributes: {
              taskEventCount: recentTaskEvents.length,
              previousRunEventCount: recentRunEvents.length
            }
          })
          const promptAssembly = shapeExecutionPrompt({
            company: owner,
            project: executionProject,
            task: liveTask,
            agent: executionAgent,
            instructions: readOptionalFile(executionAgent.instructionsPath),
            previousSession: sessionRotation.rotate ? null : storedSessionState,
            sessionHandoffMarkdown: sessionRotation.handoffMarkdown,
            relevantMemory,
            runtimeIdentity,
            recentTaskEvents,
            recentRun,
            recentRunEvents,
            parentTask,
            toolingCache,
            responseCompressionMode: projectProfileForExecution?.responsePolicy?.compressionMode ?? null
          })
          promptSpan.succeed({
            attributes: {
              compactionApplied: promptAssembly.budgetMetadata.compactionApplied,
              responseCompressionMode: promptAssembly.responseCompression.mode,
              responseCompressionSource: promptAssembly.responseCompression.source,
              estimatedTokens: promptAssembly.budgetMetadata.estimatedAfterTokens,
              selectedFiles: promptAssembly.budgetMetadata.selectedFiles?.length ?? 0,
              summarizedFiles: promptAssembly.budgetMetadata.summarizedFiles?.length ?? 0
            }
          })
          const prompt = promptAssembly.prompt
          const promptHash = createHash("sha256").update(prompt).digest("hex")
          const variant = this.store.upsertPromptVariant({
            projectId: executionProject.id,
            scope: liveTask.stage || executionAgent.role || "unknown",
            label: executionAgent.name,
            promptHash
          })
          this.store.updateRunMetadata(run.id, {
            promptBudget: promptAssembly.budgetMetadata,
            responseCompression: promptAssembly.responseCompression,
            tooling: promptAssembly.telemetry,
            promptVariantId: variant.id
          })
          this.store.appendRunEvent(run.id, "info", "Prompt budget estimated", {
            ...promptAssembly.budgetMetadata
          })
          if (promptAssembly.budgetMetadata.compactionApplied === true) {
            this.store.appendRunEvent(run.id, "info", "Prompt compaction applied", {
              reasons: promptAssembly.budgetMetadata.reasons ?? [],
              selectedFiles: promptAssembly.budgetMetadata.selectedFiles ?? [],
              summarizedFiles: promptAssembly.budgetMetadata.summarizedFiles ?? [],
              oversizedAttachments: promptAssembly.budgetMetadata.attachments
                .filter((attachment) => attachment.oversized)
                .map((attachment) => attachment.path)
            })
          }
          if (promptAssembly.responseCompression.mode !== "off") {
            this.store.appendRunEvent(run.id, "info", "Response compression enabled", {
              mode: promptAssembly.responseCompression.mode,
              source: promptAssembly.responseCompression.source
            })
          }
          const adapterSpan = tracer.startSpan({
            name: "adapter.execute",
            kind: "adapter",
            attributes: {
              adapterType: executionAgent.adapterType,
              provider: adapter.label,
              model: executionAgent.model,
              sessionRotationApplied: sessionRotation.rotate
            }
          })
          const execution = await this.executeAdapterRun({
            adapter,
            owner,
            project: executionProject,
            stateRepoPath: project.repoPath,
            task: liveTask,
            agent: executionAgent,
            runId: run.id,
            sessionKey,
            sessionState,
            storedSessionState,
            runtimeIdentity,
            wakeContext,
            basePrompt: prompt,
            budgetMetadata: promptAssembly.budgetMetadata
          })
          const result = execution.result
          const finalResponseText = execution.responseText
          this.store.updateRunMetadata(run.id, {
            responseCompression: {
              ...promptAssembly.responseCompression,
              responseCharacters: finalResponseText?.length ?? 0,
              estimatedResponseTokens: finalResponseText ? Math.ceil(finalResponseText.length / 4) : 0,
              actualOutputTokens: result.usage?.outputTokens ?? null
            }
          })
          adapterSpan.annotate({
            provider: result.metadata?.provider ?? adapter.label,
            transport: result.metadata?.transport ?? null,
            autonomousTurns: execution.turns,
            autonomousBlocked: execution.blocked,
            failureCategory: result.failureCategory ?? null
          })
          this.store.updateRunMetadata(run.id, {
            autonomousExecution: autonomousExecutionEnabled()
              ? {
                  enabled: true,
                  turns: execution.turns,
                  directives: execution.directives
                }
              : {
                  enabled: false,
                  turns: execution.turns
                }
          })

          if (execution.blocked && execution.blockedReason === COOPERATIVE_RATE_POOL_BLOCK_REASON) {
            adapterSpan.succeed({
              attributes: {
                deferred: true,
                reason: COOPERATIVE_RATE_POOL_BLOCK_REASON
              }
            })
            this.store.completeRun(run.id, {
              status: "cancelled",
              errorText: COOPERATIVE_RATE_POOL_BLOCK_REASON,
              verificationSummary: "cooperative-rate-pool-deferred"
            })
            const taskUpdated = this.store.completeClaimedTask(liveTask.id, claimToken, "queued", {
              assignedAgentId: null,
              lastError: null,
              blockedReason: null
            })
            if (taskUpdated) {
              this.store.appendTaskEvent(
                liveTask.id,
                "cooperative-rate-pool-deferred",
                "Deferred execution until a cooperative rate-pool allocation is available.",
                { runId: run.id }
              )
            }
            this.cleanupRunExecutionWorkspace({
              runId: run.id,
              project,
              workspace: executionWorkspace,
              reason: "cooperative-rate-pool-deferred",
              clearRunWorkspace: true
            })
            skippedTasks += 1
            telemetryStatus = "ok"
            telemetryAttributes = {
              deferred: true,
              reason: COOPERATIVE_RATE_POOL_BLOCK_REASON
            }
            return
          }

          if (!result.ok) {
            const adapterError = result.error ?? result.stderr ?? "Adapter execution failed"
            const codeProducingTask =
              liveTask.kind === "implement" || liveTask.kind === "repair" || liveTask.kind === "fix_review_feedback"
            const preservedWorkspace = codeProducingTask
              ? this.preserveFailedRunExecutionWorkspace({
                  runId: run.id,
                  task: liveTask,
                  workspace: executionWorkspace,
                  reason: "adapter-failed"
                })
              : null
            const failureMessage = preservedWorkspace
              ? [
                  adapterError,
                  "",
                  `Implementation worktree preserved for repair: ${preservedWorkspace.worktreePath}`,
                  `Preserved branch: ${preservedWorkspace.branchName}`,
                  preservedWorkspace.headSha ? `Preserved head: ${preservedWorkspace.headSha}` : null
                ]
                  .filter((value): value is string => Boolean(value))
                  .join("\n")
              : adapterError
            const retryClass = failureRetryClass(adapterError, result.failureCategory ?? null)
            adapterSpan.fail(failureMessage, {
              usage: result.usage ?? null
            })
            if (retryClass !== "unknown") {
              updateExecutionLaneHealth({
                store: this.store,
                companyId: owner.id,
                agent: executionAgent,
                provider: result.metadata?.provider,
                ok: false,
                message: adapterError
              })
            }
            const failure = this.handleFailure(
              liveTask,
              run.id,
              claimToken,
              failureMessage,
              executionAgent.id,
              result.failureCategory ?? null
            )
            if (preservedWorkspace) {
              this.store.updateRunWorkspace(run.id, {
                branchName: preservedWorkspace.branchName,
                headSha: preservedWorkspace.headSha,
                worktreePath: preservedWorkspace.worktreePath,
                manifestPath: preservedWorkspace.manifestPath
              })
              this.cleanupInheritedPreservedExecutionSource({
                runId: run.id,
                project,
                source: inheritedExecutionSource,
                reason: "newer-adapter-failure-captured"
              })
            }
            followUpTasks += failure.followUpTasks
            this.audit(task.projectId)?.append("run-finished", {
              runId: run.id,
              taskId: liveTask.id,
              status: "failed",
              runtimeIdentity: result.runtimeIdentity ?? runtimeIdentity,
              error: failureMessage
            })
            telemetryAttributes = {
              error: failureMessage,
              failureCategory: result.failureCategory ?? null
            }

            this.store.recordBudgetUsage(
              owner.id,
              agent.id,
              agent.budgetWindow,
              usageUnits(budget, result.usage?.totalTokens)
            )
            if (!preservedWorkspace) {
              this.cleanupRunExecutionWorkspace({
                runId: run.id,
                project,
                workspace: executionWorkspace,
                reason: "adapter-failed",
                clearRunWorkspace: true
              })
            }
            return
          }

          if (execution.blocked) {
            const codeProducingTask =
              liveTask.kind === "implement" || liveTask.kind === "repair" || liveTask.kind === "fix_review_feedback"
            const preservedWorkspace = codeProducingTask
              ? this.preserveFailedRunExecutionWorkspace({
                  runId: run.id,
                  task: liveTask,
                  workspace: executionWorkspace,
                  reason: "autonomous-blocked"
                })
              : null
            const blockedReason = preservedWorkspace
              ? [
                  execution.blockedReason,
                  "",
                  `Implementation worktree preserved for repair: ${preservedWorkspace.worktreePath}`,
                  `Preserved branch: ${preservedWorkspace.branchName}`,
                  preservedWorkspace.headSha ? `Preserved head: ${preservedWorkspace.headSha}` : null
                ]
                  .filter((value): value is string => Boolean(value))
                  .join("\n")
              : execution.blockedReason
            adapterSpan.succeed({
              usage: result.usage ?? null,
              attributes: {
                sessionDisplayId: result.sessionDisplayId ?? null
              }
            })
            updateExecutionLaneHealth({
              store: this.store,
              companyId: owner.id,
              agent: executionAgent,
              provider: result.metadata?.provider,
              ok: true,
              message: null
            })
            this.store.completeRun(run.id, {
              status: "succeeded",
              sessionDisplayId: result.sessionDisplayId ?? null,
              responseText: finalResponseText,
              errorText: blockedReason,
              usage: result.usage ?? null,
              branchName: preservedWorkspace?.branchName ?? null,
              headSha: preservedWorkspace?.headSha ?? null,
              verificationSummary: "autonomous-blocked"
            })
            if (preservedWorkspace) {
              this.store.updateRunWorkspace(run.id, {
                worktreePath: preservedWorkspace.worktreePath,
                manifestPath: preservedWorkspace.manifestPath
              })
              this.cleanupInheritedPreservedExecutionSource({
                runId: run.id,
                project,
                source: inheritedExecutionSource,
                reason: "newer-autonomous-blocker-captured"
              })
            }
            this.recordRunMemory(this.store.getTaskById(liveTask.id), run.id)
            this.store.appendRunEvent(run.id, "warn", "Autonomous execution reported a blocker.", {
              blockedReason
            })
            this.store.updateRunMetadata(run.id, {
              tooling: toolingCache.snapshot()
            })
            const taskUpdated = this.store.completeClaimedTask(liveTask.id, claimToken, "blocked", {
              assignedAgentId: executionAgent.id,
              lastError: blockedReason,
              blockedReason: "autonomous_blocked"
            })
            if (taskUpdated) {
              this.store.appendTaskEvent(
                liveTask.id,
                "autonomous-blocked",
                "Task blocked by autonomous execution mode.",
                {
                  runId: run.id,
                  reason: blockedReason,
                  preservedBranch: preservedWorkspace?.branchName ?? null,
                  preservedHead: preservedWorkspace?.headSha ?? null
                }
              )
            }
            this.audit(task.projectId)?.append("run-finished", {
              runId: run.id,
              taskId: liveTask.id,
              status: "blocked",
              runtimeIdentity: result.runtimeIdentity ?? runtimeIdentity,
              blockedReason
            })
            telemetryAttributes = {
              blockedReason,
              verificationSummary: "autonomous-blocked"
            }
            this.store.recordBudgetUsage(
              owner.id,
              agent.id,
              agent.budgetWindow,
              usageUnits(budget, result.usage?.totalTokens)
            )
            if (!preservedWorkspace) {
              this.cleanupRunExecutionWorkspace({
                runId: run.id,
                project,
                workspace: executionWorkspace,
                reason: "autonomous-blocked",
                clearRunWorkspace: true
              })
            }
            return
          }

          adapterSpan.succeed({
            usage: result.usage ?? null,
            attributes: {
              sessionDisplayId: result.sessionDisplayId ?? null
            }
          })
          const codeProducingTask =
            liveTask.kind === "implement" || liveTask.kind === "repair" || liveTask.kind === "fix_review_feedback"
          const preservedReviewRepairBaselineHeadSha =
            inheritedExecutionSource?.reason === "preserved_retry" &&
            liveTask.kind === "fix_review_feedback" &&
            liveTask.parentTaskId
              ? (this.store.getLatestSuccessfulImplementationRunForTask(liveTask.parentTaskId)?.headSha ?? null)
              : null
          const inheritedWorkspaceHasMeaningfulChanges =
            (inheritedExecutionSource?.reason === "preserved_retry" ||
              inheritedExecutionSource?.reason === "repair_source") &&
            executionWorkspace
              ? executionWorkspaceCumulativeChangedPaths(
                  executionWorkspace,
                  preservedReviewRepairBaselineHeadSha ?? undefined
                ).length > 0
              : false
          if (
            codeProducingTask &&
            executionWorkspace &&
            !responseReportsVerifiedExistingImplementation(finalResponseText) &&
            !inheritedWorkspaceHasMeaningfulChanges &&
            !executionWorkspaceHasMeaningfulChanges(executionWorkspace)
          ) {
            const emptyReviewRepair =
              liveTask.kind === "fix_review_feedback" && inheritedExecutionSource?.reason === "preserved_retry"
            const message = emptyReviewRepair
              ? "Review repair produced no repository changes beyond the inherited implementation before verification; block instead of spending a verification cycle on unchanged review evidence."
              : "Implementation produced no repository changes before verification; block instead of spending a verification cycle on an empty patch. The adapter likely returned a plan or task package instead of editing code."
            this.store.appendRunEvent(
              run.id,
              "warn",
              emptyReviewRepair
                ? "Skipped verification for zero-diff review repair"
                : "Skipped verification for zero-diff implementation",
              {
                taskId: liveTask.id,
                worktreePath: executionWorkspace.worktreePath,
                inheritedSourceReason: inheritedExecutionSource?.reason ?? null,
                repairBaselineHeadSha: preservedReviewRepairBaselineHeadSha
              }
            )
            const failure = this.handleFailure(liveTask, run.id, claimToken, message, executionAgent.id)
            followUpTasks += failure.followUpTasks
            this.audit(task.projectId)?.append("run-finished", {
              runId: run.id,
              taskId: liveTask.id,
              status: "failed",
              runtimeIdentity: result.runtimeIdentity ?? runtimeIdentity,
              error: message
            })
            telemetryAttributes = { error: message, verificationSkipped: "zero-diff" }
            this.store.recordBudgetUsage(
              owner.id,
              agent.id,
              agent.budgetWindow,
              usageUnits(budget, result.usage?.totalTokens)
            )
            if (emptyReviewRepair) {
              this.cleanupInheritedPreservedExecutionSource({
                runId: run.id,
                project,
                source: inheritedExecutionSource,
                reason: "zero-diff-review-repair"
              })
            }
            this.cleanupRunExecutionWorkspace({
              runId: run.id,
              project,
              workspace: executionWorkspace,
              reason: "no-repository-changes",
              clearRunWorkspace: true
            })
            return
          }
          const changedPaths =
            codeProducingTask && executionWorkspace
              ? liveTask.kind === "fix_review_feedback" ||
                inheritedExecutionSource?.reason === "preserved_retry" ||
                inheritedExecutionSource?.reason === "repair_source"
                ? executionWorkspaceCumulativeChangedPaths(executionWorkspace)
                : executionWorkspaceMeaningfulChangedPaths(executionWorkspace)
              : []
          if (codeProducingTask) {
            this.store.updateRunMetadata(run.id, {
              changedFiles: changedPaths
            })
          }
          if (codeProducingTask && executionWorkspace && liveTask.labels.includes("deterministic-fallback")) {
            const diffBudgetViolation = deterministicFallbackDiffBudgetViolation(
              executionWorkspaceDiffNumstat(executionWorkspace)
            )
            const testOnlyViolation = deterministicFallbackTestOnlyViolation(changedPaths, project.repoPath)
            const policyFailure = diffBudgetViolation
              ? {
                  message: `Deterministic fallback policy exceeded its narrow change budget before verification: ${diffBudgetViolation}. Remove unrelated formatting or split the work before promotion.`,
                  event: "Skipped verification for oversized deterministic fallback",
                  reason: "oversized-deterministic-fallback"
                }
              : testOnlyViolation
                ? {
                    message: `Deterministic fallback produced a test-only patch before verification; block because the task requires meaningful source behavior: ${testOnlyViolation}.`,
                    event: "Skipped verification for test-only deterministic fallback",
                    reason: "test-only-deterministic-fallback"
                  }
                : null
            if (policyFailure) {
              this.store.appendRunEvent(run.id, "warn", policyFailure.event, {
                taskId: liveTask.id,
                worktreePath: executionWorkspace.worktreePath,
                changedPaths
              })
              const failure = this.handleFailure(liveTask, run.id, claimToken, policyFailure.message, executionAgent.id)
              followUpTasks += failure.followUpTasks
              this.audit(task.projectId)?.append("run-finished", {
                runId: run.id,
                taskId: liveTask.id,
                status: "failed",
                runtimeIdentity: result.runtimeIdentity ?? runtimeIdentity,
                error: policyFailure.message
              })
              telemetryAttributes = { error: policyFailure.message, verificationSkipped: policyFailure.reason }
              this.store.recordBudgetUsage(
                owner.id,
                agent.id,
                agent.budgetWindow,
                usageUnits(budget, result.usage?.totalTokens)
              )
              this.cleanupRunExecutionWorkspace({
                runId: run.id,
                project,
                workspace: executionWorkspace,
                reason: policyFailure.reason,
                clearRunWorkspace: true
              })
              return
            }
          }
          const effectiveVerificationCommands = verificationCommandsWithChangedTests(
            liveTask,
            executionProject,
            changedPaths
          )
          const focusedChangedTestCommands = focusedChangedTestVerificationCommands(
            changedPaths,
            executionPolicyForRepo(project.repoPath)
          )
          if (focusedChangedTestCommands.length > 0) {
            this.store.appendRunEvent(run.id, "info", "Focused verification inferred from changed test files", {
              changedPaths,
              commands: focusedChangedTestCommands
            })
          }
          const verificationSpan = tracer.startSpan({
            name: "verification",
            kind: "verification",
            attributes: {
              commandCount: effectiveVerificationCommands.length
            }
          })
          if (executionWorkspace) {
            const linkedDependencies = linkSharedExecutionDependencies(
              project.repoPath,
              executionWorkspace.worktreePath
            )
            if (linkedDependencies.length > 0) {
              this.store.appendRunEvent(run.id, "info", "Shared execution dependencies refreshed before verification", {
                linkedDependencies
              })
            }
          }
          const verification = await verificationOk(
            liveTask,
            executionProject,
            (level, message, data) => {
              this.store.appendRunEvent(run.id, level, message, data ?? null)
            },
            toolingCache,
            effectiveVerificationCommands,
            focusedChangedTestCommands
          )

          if (!verification.ok) {
            const verificationError = verification.error ?? "Verification failed"
            const preservedWorkspace = codeProducingTask
              ? this.preserveFailedRunExecutionWorkspace({
                  runId: run.id,
                  task: liveTask,
                  workspace: executionWorkspace,
                  reason: "verification-failed"
                })
              : null
            const failureMessage = preservedWorkspace
              ? [
                  verificationError,
                  "",
                  `Implementation worktree preserved for repair: ${preservedWorkspace.worktreePath}`,
                  `Preserved branch: ${preservedWorkspace.branchName}`,
                  preservedWorkspace.headSha ? `Preserved head: ${preservedWorkspace.headSha}` : null
                ]
                  .filter((value): value is string => Boolean(value))
                  .join("\n")
              : verificationError
            verificationSpan.fail(failureMessage, {
              attributes: {
                verificationSummary: verification.summary ?? null
              }
            })
            this.store.updateRunMetadata(run.id, {
              tooling: toolingCache.snapshot()
            })
            const failure = this.handleFailure(liveTask, run.id, claimToken, failureMessage, executionAgent.id)
            if (preservedWorkspace) {
              this.store.updateRunWorkspace(run.id, {
                branchName: preservedWorkspace.branchName,
                headSha: preservedWorkspace.headSha,
                worktreePath: preservedWorkspace.worktreePath,
                manifestPath: preservedWorkspace.manifestPath
              })
              this.cleanupInheritedPreservedExecutionSource({
                runId: run.id,
                project,
                source: inheritedExecutionSource,
                reason: "newer-verification-failure-captured"
              })
            }
            followUpTasks += failure.followUpTasks
            this.audit(task.projectId)?.append("run-finished", {
              runId: run.id,
              taskId: liveTask.id,
              status: "failed",
              runtimeIdentity: result.runtimeIdentity ?? runtimeIdentity,
              error: failureMessage
            })
            telemetryAttributes = {
              error: failureMessage,
              verificationSummary: verification.summary ?? null
            }

            this.store.recordBudgetUsage(
              owner.id,
              agent.id,
              agent.budgetWindow,
              usageUnits(budget, result.usage?.totalTokens)
            )
            if (!preservedWorkspace) {
              this.cleanupRunExecutionWorkspace({
                runId: run.id,
                project,
                workspace: executionWorkspace,
                reason: "verification-failed",
                clearRunWorkspace: true
              })
            }
            return
          }
          verificationSpan.succeed({
            attributes: {
              verificationSummary: verification.summary ?? null
            }
          })

          const capturedWorkspace = executionWorkspace
            ? captureWorkspaceChanges({
                worktree: executionWorkspace,
                task: liveTask
              })
            : null
          const capturedRepository =
            !executionWorkspace && commandExists("git") && existsSync(join(executionProject.repoPath, ".git"))
              ? captureRepositoryChanges({
                  repoPath: executionProject.repoPath,
                  task: liveTask,
                  runId: run.id
                })
              : null
          if (executionWorkspace && capturedWorkspace) {
            this.store.updateRunWorkspace(run.id, {
              branchName: executionWorkspace.branchName,
              headSha: capturedWorkspace.headSha,
              worktreePath: executionWorkspace.worktreePath,
              manifestPath: executionWorkspace.manifestPath
            })
            this.store.appendRunEvent(run.id, "info", "Execution worktree changes captured", {
              branchName: executionWorkspace.branchName,
              headSha: capturedWorkspace.headSha,
              committed: capturedWorkspace.committed,
              skippedNestedGitCheckouts: capturedWorkspace.skippedNestedGitCheckouts
            })
          }
          if (capturedRepository) {
            this.store.updateRunWorkspace(run.id, {
              branchName: capturedRepository.branchName,
              headSha: capturedRepository.headSha,
              worktreePath: null,
              manifestPath: null
            })
            this.store.appendRunEvent(run.id, "info", "Execution repository changes captured", {
              branchName: capturedRepository.branchName,
              baseBranch: capturedRepository.baseBranch,
              headSha: capturedRepository.headSha,
              committed: capturedRepository.committed,
              skippedNestedGitCheckouts: capturedRepository.skippedNestedGitCheckouts
            })
          }

          const committedChanges = Boolean(
            capturedWorkspace?.committed || capturedRepository?.committed || inheritedWorkspaceHasMeaningfulChanges
          )
          const alreadySatisfied =
            codeProducingTask &&
            Boolean(capturedWorkspace || capturedRepository) &&
            !committedChanges &&
            verification.summary !== null &&
            responseReportsVerifiedExistingImplementation(finalResponseText)
          const successfulVerificationSummary = alreadySatisfied
            ? ["already satisfied", verification.summary].filter(Boolean).join("; ")
            : verification.summary
          if (alreadySatisfied) {
            this.store.appendRunEvent(
              run.id,
              "info",
              "Verified that the requested implementation already exists; no repository changes required",
              {
                taskId: liveTask.id,
                verificationSummary: verification.summary ?? null
              }
            )
            this.store.appendTaskEvent(
              liveTask.id,
              "implementation-already-satisfied",
              "Closed duplicate implementation task after verification passed with no patch required.",
              { runId: run.id }
            )
          }
          if (
            codeProducingTask &&
            (capturedWorkspace || capturedRepository) &&
            !committedChanges &&
            !alreadySatisfied
          ) {
            const message =
              "Implementation produced no repository changes after verification; block instead of marking the task done. The adapter likely returned a plan or task package instead of editing code."
            const failure = this.handleFailure(liveTask, run.id, claimToken, message, executionAgent.id)
            followUpTasks += failure.followUpTasks
            this.audit(task.projectId)?.append("run-finished", {
              runId: run.id,
              taskId: liveTask.id,
              status: "failed",
              runtimeIdentity: result.runtimeIdentity ?? runtimeIdentity,
              error: message
            })
            telemetryAttributes = {
              error: message,
              verificationSummary: verification.summary ?? null
            }
            this.store.recordBudgetUsage(
              owner.id,
              agent.id,
              agent.budgetWindow,
              usageUnits(budget, result.usage?.totalTokens)
            )
            this.cleanupRunExecutionWorkspace({
              runId: run.id,
              project,
              workspace: executionWorkspace,
              reason: "no-repository-changes",
              clearRunWorkspace: true
            })
            return
          }

          updateExecutionLaneHealth({
            store: this.store,
            companyId: owner.id,
            agent: executionAgent,
            provider: result.metadata?.provider,
            ok: true,
            message: null
          })
          this.store.completeRun(run.id, {
            status: "succeeded",
            sessionDisplayId: result.sessionDisplayId ?? null,
            responseText: finalResponseText,
            errorText: null,
            usage: result.usage ?? null,
            branchName: executionWorkspace?.branchName ?? capturedRepository?.branchName ?? null,
            headSha: capturedWorkspace?.headSha ?? capturedRepository?.headSha ?? null,
            verificationSummary: successfulVerificationSummary
          })
          this.cleanupInheritedPreservedExecutionSource({
            runId: run.id,
            project,
            source: inheritedExecutionSource,
            reason: "retry-completed"
          })
          this.recordRunMemory(this.store.getTaskById(liveTask.id), run.id)
          this.store.appendRunEvent(run.id, "info", "Run completed successfully", {
            responsePreview: finalResponseText.slice(0, 200),
            adapterMetadata: result.metadata ?? {
              adapterType: adapter.type,
              provider: adapter.label,
              model: executionAgent.model,
              capabilities: adapter.capabilities
            },
            tooling: toolingCache.snapshot(),
            runtimeIdentity: result.runtimeIdentity ?? runtimeIdentity
          })
          this.store.updateRunMetadata(run.id, {
            tooling: toolingCache.snapshot()
          })
          this.audit(task.projectId)?.append("run-finished", {
            runId: run.id,
            taskId: liveTask.id,
            status: "succeeded",
            runtimeIdentity: result.runtimeIdentity ?? runtimeIdentity,
            adapterMetadata: result.metadata ?? {
              adapterType: adapter.type,
              provider: adapter.label,
              model: executionAgent.model,
              capabilities: adapter.capabilities
            }
          })
          const taskUpdated = this.store.completeClaimedTask(
            liveTask.id,
            claimToken,
            alreadySatisfied ? "done" : getSuccessfulTaskStatus(liveTask),
            {
              assignedAgentId: executionAgent.id,
              lastError: null
            }
          )
          if (!taskUpdated) {
            this.store.appendRunEvent(run.id, "warn", "Run finished after lease loss; task state left unchanged", {
              taskId: liveTask.id
            })
          } else {
            const refreshedTask = this.store.getTaskById(liveTask.id)
            this.reconcileRecoveredWorkflowTask(refreshedTask)
            this.resumePromotionAfterReviewFeedback(refreshedTask, project, run.id)
            if (refreshedTask.workflowId) {
              this.store.refreshWorkflowStatus(refreshedTask.workflowId)
            }
            this.advanceReviewedParent(refreshedTask, project, run.id)
            if (executionWorkspace) {
              this.cleanupRunExecutionWorkspace({
                runId: run.id,
                project,
                workspace: executionWorkspace,
                reason: "run-completed"
              })
            }
            this.recordTaskOutcome(refreshedTask, run.id, {
              stage: "execution",
              result: "success",
              reason: successfulVerificationSummary ?? null,
              verificationPassed: verification.ok,
              tokensTotal: result.usage?.totalTokens ?? null
            })
          }
          telemetryStatus = "ok"
          telemetryAttributes = {
            verificationSummary: successfulVerificationSummary ?? null,
            completedTaskStatus: alreadySatisfied ? "done" : getSuccessfulTaskStatus(liveTask),
            adapterProvider: result.metadata?.provider ?? adapter.label
          }
          this.store.recordBudgetUsage(
            owner.id,
            agent.id,
            agent.budgetWindow,
            usageUnits(budget, result.usage?.totalTokens)
          )
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const codeProducingTask =
            liveTask.kind === "implement" || liveTask.kind === "repair" || liveTask.kind === "fix_review_feedback"
          const preservedWorkspace = codeProducingTask
            ? this.preserveFailedRunExecutionWorkspace({
                runId: run.id,
                task: liveTask,
                workspace: executionWorkspace,
                reason: "run-exception"
              })
            : null
          const failureMessage = preservedWorkspace
            ? [
                message,
                "",
                `Implementation worktree preserved for repair: ${preservedWorkspace.worktreePath}`,
                `Preserved branch: ${preservedWorkspace.branchName}`,
                preservedWorkspace.headSha ? `Preserved head: ${preservedWorkspace.headSha}` : null
              ]
                .filter((value): value is string => Boolean(value))
                .join("\n")
            : message
          updateExecutionLaneHealth({
            store: this.store,
            companyId: owner.id,
            agent: executionAgent,
            provider: executionAgent.adapterType,
            ok: false,
            message
          })
          const failure = this.handleFailure(liveTask, run.id, claimToken, failureMessage, executionAgent.id)
          if (preservedWorkspace) {
            this.store.updateRunWorkspace(run.id, {
              branchName: preservedWorkspace.branchName,
              headSha: preservedWorkspace.headSha,
              worktreePath: preservedWorkspace.worktreePath,
              manifestPath: preservedWorkspace.manifestPath
            })
            this.cleanupInheritedPreservedExecutionSource({
              runId: run.id,
              project,
              source: inheritedExecutionSource,
              reason: "newer-run-exception-captured"
            })
          }
          followUpTasks += failure.followUpTasks
          if (!preservedWorkspace) {
            this.cleanupRunExecutionWorkspace({
              runId: run.id,
              project,
              workspace: executionWorkspace,
              reason: "run-exception",
              clearRunWorkspace: true
            })
          }
          this.audit(task.projectId)?.append("run-finished", {
            runId: run.id,
            taskId: liveTask.id,
            status: "failed",
            runtimeIdentity,
            error: failureMessage
          })
          rootSpan.event("run.exception", {
            level: "error",
            message,
            attributes: {
              adapterType: executionAgent.adapterType
            }
          })
          telemetryAttributes = {
            error: failureMessage
          }
        } finally {
          const trace = tracer.finish({
            status: telemetryStatus,
            attributes: telemetryAttributes
          })
          const telemetrySummary = summarizeExecutionTrace(trace)
          const compactTelemetry = {
            traceId: trace.traceId,
            rootSpanId: trace.rootSpanId,
            runId: trace.runId,
            startedAt: trace.startedAt,
            finishedAt: trace.finishedAt,
            latencyMs: trace.latencyMs,
            status: trace.status,
            executionPath: trace.executionPath,
            totals: trace.totals,
            spanCount: trace.spans.length,
            eventCount: trace.events.length,
            compacted: true,
            originalBytes: Buffer.byteLength(JSON.stringify(trace))
          }
          this.store.updateRunMetadata(run.id, {
            telemetry: compactTelemetry,
            telemetrySummary
          })
          this.store.appendRunEvent(run.id, telemetryStatus === "ok" ? "info" : "warn", "Telemetry trace captured", {
            telemetry: telemetrySummary
          })
          const refreshedAgent = this.store.getAgentById(executionAgent.id)
          const refreshedBudget = this.store.getBudgetStatus(refreshedAgent)
          this.store.setAgentStatus(executionAgent.id, refreshedBudget.blocked ? "blocked" : "idle")
          emitTerminalLifecycle({
            runtimeIdentity,
            telemetryStatus
          })
        }
      })()
      if (canRunInParallel) {
        let trackedExecutionTask: Promise<void>
        trackedExecutionTask = executionTask.finally(() => {
          runningExecutionTasks.delete(trackedExecutionTask)
          if (executionLaneKey && runningExecutionLanes.get(executionLaneKey) === trackedExecutionTask) {
            runningExecutionLanes.delete(executionLaneKey)
          }
        })
        runningExecutionTasks.add(trackedExecutionTask)
        if (executionLaneKey) runningExecutionLanes.set(executionLaneKey, trackedExecutionTask)
      } else {
        await executionTask
      }
    }

    await Promise.all(runningExecutionTasks)

    this.recoverCompletedReviewRepairParents(companyId, projectIds)

    return {
      executedRuns,
      blockedTasks,
      skippedTasks,
      followUpTasks
    }
  }

  async runTask(taskId: string): Promise<TickSummary> {
    const task = this.store.getTaskById(taskId)
    const project = this.store.getProjectById(task.projectId)
    if (!holdsExecutionOwner(project.repoPath, "legacy"))
      return withExecutionOwner(project.repoPath, "legacy", () => this.runTask(taskId))
    if (task.status !== "queued") {
      throw new Error(`Task ${task.id} is ${task.status}; targeted execution requires queued status`)
    }
    const now = new Date()
    this.reapStaleRuns(task.companyId, now)
    this.releaseZombieAgents(task.companyId)
    this.refreshBlockedAgents(task.companyId)
    const allAgents = this.store.listAgents(task.companyId)
    const healthByAdapter = await this.adapterHealth(allAgents)
    syncLaneHealthState(this.store, allAgents, healthByAdapter, readCodexQuotaOverview())
    const summary = await this.runQueuedTasks({
      companyId: task.companyId,
      healthByAdapter,
      projectIds: new Set([task.projectId]),
      taskIds: new Set([task.id]),
      triggeredAt: now.toISOString()
    })
    const refreshedTask = this.store.getTaskById(task.id)
    const targetedTaskBlocked =
      refreshedTask.status === "blocked" ||
      refreshedTask.status === "failed" ||
      refreshedTask.status === "needs_human_review"
    return {
      ...summary,
      blockedTasks: Math.max(summary.blockedTasks, targetedTaskBlocked ? 1 : 0),
      executedJobs: 0,
      createdReviewTasks: 0
    }
  }

  async tick(companyRef?: string | null): Promise<TickSummary> {
    const company = companyRef ? this.store.resolveCompany(companyRef) : null
    const companyId = company?.id
    for (const project of this.store.listProjects(companyId)) {
      if (!holdsExecutionOwner(project.repoPath, "legacy"))
        return withExecutionOwner(project.repoPath, "legacy", () => this.tick(companyRef))
    }
    assertExecutionOwnership()
    const now = new Date()
    this.reapStaleRuns(companyId, now)
    this.releaseZombieAgents(companyId)
    this.refreshBlockedAgents(companyId)

    const allAgents = this.store.listAgents(companyId)
    const healthByAdapter = await this.adapterHealth(allAgents)
    const codexQuota = readCodexQuotaOverview()
    syncLaneHealthState(this.store, allAgents, healthByAdapter, codexQuota)
    const nowIso = now.toISOString()
    // Queue-refresh planning can take several minutes. Start due automations now,
    // but let the execution sweep claim already-queued work while planning is in
    // flight so a slow planner cannot leave implementation capacity idle.
    const automationsPromise = this.syncDueAutomations(companyId, now)
    const dueJobSpecs = this.dueJobSpecs(companyId, now)
    const projectsWithJobSpecs = new Set(this.store.listJobSpecs(companyId).map((jobSpec) => jobSpec.projectId))
    const unscheduledProjects = new Set(
      this.store
        .listProjects(companyId)
        .filter((project) => !projectsWithJobSpecs.has(project.id))
        .map((project) => project.id)
    )
    const executionProjects = new Set<string>(unscheduledProjects)
    const dueExecutionSweepProjects = new Set<string>()
    const executionWake = new Map<
      string,
      { wakeReason: WakeReason; heartbeatJobId: JobId | null; triggeredAt: string }
    >()
    let executedJobs = 0
    let createdReviewTasks = 0

    for (const jobSpec of dueJobSpecs.filter((entry) => entry.jobId === "execution-sweep")) {
      executionProjects.add(jobSpec.projectId)
      dueExecutionSweepProjects.add(jobSpec.projectId)
      executionWake.set(jobSpec.projectId, {
        wakeReason: "execution_sweep",
        heartbeatJobId: jobSpec.jobId,
        triggeredAt: nowIso
      })
    }

    // Materialize lifecycle children before a potentially long execution sweep.
    // The scheduled sweeps below still run after execution so transitions created
    // during this tick are reconciled immediately as well.
    for (const projectId of dueExecutionSweepProjects) {
      const review = this.createReviewTasks(projectId)
      createdReviewTasks += review.created
      this.promoteReviewedTasks(projectId)
    }

    const executionPromise = this.runQueuedTasks({
      companyId,
      healthByAdapter,
      projectIds: executionProjects.size > 0 ? executionProjects : new Set<string>(),
      executionWake,
      triggeredAt: nowIso
    })
    const [executedAutomations, executionSummary] = await Promise.all([automationsPromise, executionPromise])

    for (const jobSpec of dueJobSpecs.filter((entry) => entry.jobId !== "execution-sweep")) {
      const jobRun = this.store.createJobRun({
        jobSpecId: jobSpec.id,
        triggeredAt: nowIso
      })
      executedJobs += 1

      try {
        let resultSummary = "no-op"
        let data: Record<string, unknown> = {}

        if (jobSpec.jobId === "review-sweep") {
          const review = this.createReviewTasks(jobSpec.projectId)
          createdReviewTasks += review.created
          const createdSummary =
            review.created === 1 ? "created 1 review task" : `created ${review.created} review tasks`
          const recoveredSummary =
            review.recovered === 1 ? "recovered 1 reviewed parent" : `recovered ${review.recovered} reviewed parents`
          resultSummary = `${createdSummary}; ${recoveredSummary}`
          data = { createdReviewTasks: review.created, recoveredReviewParents: review.recovered }
        } else if (jobSpec.jobId === "promotion-sweep") {
          const promoted = this.promoteReviewedTasks(jobSpec.projectId)
          resultSummary = promoted === 1 ? "promoted 1 task" : `promoted ${promoted} tasks`
          data = { promotedTasks: promoted }
        } else {
          resultSummary = `${jobSpec.jobId} is managed by the profile-aware director runtime`
          data = { delegated: true, jobId: jobSpec.jobId }
        }

        this.store.completeJobRun(jobRun.id, {
          status: "succeeded",
          resultSummary,
          data,
          completedAt: nowIso
        })
        this.store.updateJobSpecRuntime(jobSpec.id, {
          lastTriggeredAt: nowIso,
          lastResult: resultSummary
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.store.completeJobRun(jobRun.id, {
          status: "failed",
          resultSummary: message,
          data: { error: message },
          completedAt: nowIso
        })
        this.store.updateJobSpecRuntime(jobSpec.id, {
          lastTriggeredAt: nowIso,
          lastResult: `failed: ${message}`
        })
      }
    }

    for (const jobSpec of dueJobSpecs.filter((entry) => entry.jobId === "execution-sweep")) {
      const resultSummary = "execution sweep processed queued tasks"
      const jobRun = this.store.createJobRun({
        jobSpecId: jobSpec.id,
        triggeredAt: nowIso
      })
      this.store.completeJobRun(jobRun.id, {
        status: "succeeded",
        resultSummary,
        data: { projectId: jobSpec.projectId },
        completedAt: nowIso
      })
      this.store.updateJobSpecRuntime(jobSpec.id, {
        lastTriggeredAt: nowIso,
        lastResult: resultSummary
      })
      executedJobs += 1
    }

    return {
      executedRuns: executionSummary.executedRuns,
      blockedTasks: executionSummary.blockedTasks,
      skippedTasks: executionSummary.skippedTasks,
      followUpTasks: executionSummary.followUpTasks,
      executedJobs: executedJobs + executedAutomations,
      createdReviewTasks
    }
  }
}
