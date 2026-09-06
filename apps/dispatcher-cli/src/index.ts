#!/usr/bin/env node
import { execFileSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { azureFoundryAdapter } from "@openclaw/adapter-azure-foundry"
import { codexLocalAdapter } from "@openclaw/adapter-codex-local"
import { geminiLocalAdapter } from "@openclaw/adapter-gemini-local"
import {
  type AutonomousDirectorCycleReport,
  archiveHistoricalBlockedTasks,
  backupRuntimeState,
  DirectorRuntime,
  diagnoseQueueHealth,
  evaluatePromotionRun,
  type PromotionCheckResult,
  type PromotionTarget,
  pruneDuplicateQueuedWorkflows,
  type QueueHealthSummary,
  type QueueRefreshFullCycleReport,
  repairQueueHealth,
  resetRuntimeState
} from "@openclaw/core-runtime"
import { DispatcherStore } from "@openclaw/db"
import {
  type AdapterDefinition,
  type AdapterExecutionContext,
  type AdapterHealthcheckResult,
  type AdapterType,
  type Agent,
  createDiagnosticsManifest,
  diagnosticsSensitivePaths,
  evaluatePolicy,
  extractTaskReferenceIdentifiers,
  type HandoffStatus,
  type HandoffVerificationStatus,
  type JobId,
  type JobSpec,
  LOOP_PATTERNS,
  loadProjectPolicy,
  MAX_REPAIR_ATTEMPTS,
  type PersonaDefinition,
  type PolicyDecision,
  type Project,
  type ResponseCompressionMode,
  type ReviewResult,
  type RouteDecision,
  type RoutingRule,
  readCodexQuotaOverview,
  redactLogText,
  renderHandoffArtifact,
  routeTask,
  runtimePolicyFlagsFromEnv,
  shouldOpenPredictiveCircuit,
  type Task,
  type TaskKind,
  type TeamArtifactClaimStatus,
  type TeamAssignmentStatus,
  type TeamReviewerLockoutStatus,
  validateHandoffArtifact,
  validatePersonaSet
} from "@openclaw/domain"
import {
  type AutonomousCompanyEvaluationOutput,
  evaluateAutonomousCompany,
  renderAutonomousCompanyEvaluationText
} from "@openclaw/evaluation"
import { DispatcherExecutor, readAgentLoopEvents, reviewCompletedRun, waitForAgentRun } from "@openclaw/executor"
import { type MemoryCompactionPolicy, MemoryService } from "@openclaw/memory-runtime"
import { scaffoldCodexOrchestra } from "@openclaw/orchestra-codex"
import {
  bestProfileMatch,
  installProjectProfile,
  listBuiltInProfileIds,
  loadProjectProfile,
  loadProjectProfilePersonas,
  resolveProjectProfile
} from "@openclaw/project-profiles"
import { Command } from "commander"
import { CronExpressionParser } from "cron-parser"
import { type ZipEntry, zipStoredEntries } from "./archive.js"
import { type InterpretedAskCommand, interpretAskCommand, renderAskPlan, structuredAskCommand } from "./ask.js"
import { auditProject, renderAuditSummary } from "./audit.js"
import { backlogCandidateTaskPackage, generateBacklog } from "./backlog.js"
import { estimateCost, renderCostReport } from "./cost.js"
import { renderDoctorSummary, runDoctor } from "./doctor.js"
import { loadEnvFiles } from "./env.js"
import {
  assertGitHubCliAvailable,
  auditGitHubReleases,
  createRunBranch,
  createRunPullRequest,
  renderRunPrStatus,
  resolveGitHubRunContext,
  syncGitHubReleases
} from "./github.js"
import type { InstallTool } from "./install.js"
import { installDispatcherFramework } from "./install.js"
import { registerNativeAutonomyCommands } from "./native-autonomy.js"
import { syncOpenClawNativePersonas } from "./openclaw-native.js"
import {
  defaultPersonaImprovementPaths,
  proposalDisplayPath,
  renderPersonaImprovementPrompt,
  resolvePersonaImprovementOutput,
  runOpenClawPersonaImprovement,
  writePersonaImprovementPrompt
} from "./persona-improve.js"
import {
  loadPromptProjectProfile,
  type PromptPersonaInput,
  type PromptTemplateId,
  promptInputFromTask,
  promptPersonaFromPersona,
  renderCodexPrompt
} from "./prompt-renderer.js"
import { detectRepoContext } from "./repo-context.js"
import { syncRepoOwnedOpenclaw } from "./sync.js"
import { generateDispatchableTaskPackages, materializeGeneratedTaskPackages } from "./task-factory.js"
import {
  buildTaskPackage,
  renderTaskPackage,
  taskPackageFromHandoff,
  verificationCommandsFromDescription
} from "./task-package.js"

type Io = {
  stdout: (message: string) => void
  stderr: (message: string) => void
}

type AutonomousQueueState = {
  queuedTasks: number
  runningTasks: number
  reviewNeededTasks: number
  promotionPendingTasks: number
  blockedTasks: number
  runningRuns: number
}

function runVerificationPreview(summary: string | null): string {
  const normalized = summary?.replace(/\s+/g, " ").trim()
  if (!normalized) return "n/a"
  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized
}

function collectValues(value: string, previous: string[]): string[] {
  return [...previous, value]
}

function parseInstallTools(value: string): InstallTool[] {
  const aliases = new Map<string, InstallTool>([
    ["codex", "codex"],
    ["gemini", "gemini"],
    ["foundry", "foundry"],
    ["azure", "foundry"],
    ["azure_foundry", "foundry"],
    ["kimi", "foundry"]
  ])
  const tools = value
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .map((entry) => {
      const tool = aliases.get(entry)
      if (!tool) {
        throw new Error(`Unsupported install tool "${entry}". Use codex, gemini, or foundry.`)
      }
      return tool
    })
  if (tools.length === 0) {
    throw new Error("Install tools cannot be empty. Use codex, gemini, foundry, or a comma-separated list.")
  }
  return Array.from(new Set(tools))
}

function parseEnv(entries: string[]): Record<string, string> {
  return Object.fromEntries(
    entries.map((entry) => {
      const separator = entry.indexOf("=")
      if (separator === -1) {
        throw new Error(`Invalid env entry "${entry}". Use KEY=VALUE.`)
      }
      return [entry.slice(0, separator), entry.slice(separator + 1)]
    })
  )
}

function writeBlock(io: Io, lines: string[]): void {
  io.stdout(`${lines.join("\n")}\n`)
}

function commandExists(command: string): boolean {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue
    const candidate = join(dir, command)
    if (existsSync(candidate)) return true
  }
  return false
}

function dispatcherFrameworkRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
}

function discoverCodexAccountSwitcherForCli(): string | null {
  const explicitPath = process.env.CODEX_ACCOUNT_SWITCHER_SCRIPT
  const frameworkDir = process.env.OPENCLAW_DISPATCHER_FRAMEWORK_DIR ?? dispatcherFrameworkRoot()
  const openclawHome = process.env.OPENCLAW_HOME
  const home = process.env.HOME
  const candidates = [
    explicitPath,
    join(process.cwd(), "skills", "codex-account-switcher", "scripts", "codex-accounts.py"),
    join(frameworkDir, "skills", "codex-account-switcher", "scripts", "codex-accounts.py"),
    openclawHome
      ? join(openclawHome, "workspace", "skills", "codex-account-switcher", "scripts", "codex-accounts.py")
      : null,
    home
      ? join(home, ".openclaw", "workspace", "skills", "codex-account-switcher", "scripts", "codex-accounts.py")
      : null,
    home ? join(home, ".codex", "skills", "codex-account-switcher", "scripts", "codex-accounts.py") : null,
    commandExists("codex-auth") ? "codex-auth" : null
  ]

  for (const candidate of candidates) {
    if (!candidate) continue
    if (candidate === "codex-auth" || existsSync(candidate)) return candidate
  }
  return null
}

function codexDirForCli(): string {
  return process.env.OPENCLAW_CODEX_DIR ?? join(process.env.HOME ?? "", ".codex")
}

function codexAccountsDirForCli(): string {
  return process.env.OPENCLAW_CODEX_ACCOUNTS_DIR ?? join(codexDirForCli(), "accounts")
}

function codexAuthFileForCli(): string {
  return process.env.OPENCLAW_CODEX_AUTH_FILE ?? join(codexDirForCli(), "auth.json")
}

function codexRegistryPathForCli(): string {
  return join(codexAccountsDirForCli(), "registry.json")
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function readJsonFile(path: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"))
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function codexRegistryAccountDisplayName(account: Record<string, unknown>): string | null {
  return (
    normalizeString(account.alias) ??
    normalizeString(account.account_name) ??
    normalizeString(account.email) ??
    normalizeString(account.account_key)
  )
}

function findCodexRegistryAccountByName(accountName: string): Record<string, unknown> | null {
  const registry = readJsonFile(codexRegistryPathForCli())
  const accounts = registry?.accounts
  if (!Array.isArray(accounts)) return null
  for (const account of accounts) {
    if (!account || typeof account !== "object" || Array.isArray(account)) continue
    const candidate = account as Record<string, unknown>
    if (codexRegistryAccountDisplayName(candidate) === accountName) return candidate
  }
  return null
}

function runCodexAccountSwitcher(
  switcherPath: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): string {
  if (switcherPath === "codex-auth") {
    return execFileSync(switcherPath, args, {
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? process.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000
    })
  }

  const command = switcherPath.endsWith(".py") ? "python3" : switcherPath
  const commandArgs = switcherPath.endsWith(".py") ? [switcherPath, ...args] : args
  return execFileSync(command, commandArgs, {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000
  })
}

function switchCodexAuthToCachedAccount(accountName: string): string {
  const registryAccount = findCodexRegistryAccountByName(accountName)
  const accountKey = normalizeString(registryAccount?.account_key)
  const registryPath = codexRegistryPathForCli()
  const registrySnapshotName = accountKey ? `${Buffer.from(accountKey).toString("base64url")}.auth.json` : null
  const candidates = [
    join(codexAccountsDirForCli(), `${accountName}.json`),
    registrySnapshotName ? join(codexAccountsDirForCli(), registrySnapshotName) : null
  ].filter((path): path is string => Boolean(path))
  const source = candidates.find((candidate) => existsSync(candidate))
  const target = codexAuthFileForCli()
  if (!source) {
    throw new Error(
      `Saved Codex account snapshot not found for ${accountName}. Checked: ${candidates.join(", ") || "none"}`
    )
  }
  if (!existsSync(source)) {
    throw new Error(`Saved Codex account snapshot not found for ${accountName}: ${source}`)
  }
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(source, target)
  if (accountKey && existsSync(registryPath)) {
    const registry = readJsonFile(registryPath)
    if (registry) {
      registry.active_account_key = accountKey
      registry.active_account_activated_at_ms = Date.now()
      writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8")
    }
  }
  return source
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function collectCommaList(value: string, previous: string[]): string[] {
  const next = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
  return [...previous, ...next]
}

function renderReviewReport(review: ReviewResult): string[] {
  const lines = [
    `review_id: ${review.id}`,
    `run_id: ${review.runId}`,
    `task_id: ${review.taskId}`,
    `outcome: ${review.outcome}`,
    `severity: ${review.severity}`,
    `risk_level: ${review.riskLevel}`,
    `promotion_recommendation: ${review.promotionRecommendation}`,
    "",
    "Summary:",
    review.summary,
    "",
    "Findings:"
  ]

  if (review.findings.length === 0) {
    lines.push("- none")
  } else {
    for (const finding of review.findings) {
      lines.push(`- ${finding.severity}: ${finding.summary}`)
      lines.push(`  files: ${finding.files.join(", ") || "n/a"}`)
      lines.push(`  areas: ${finding.areas.join(", ") || "n/a"}`)
      lines.push(`  required_fixes: ${finding.requiredFixes.join(" | ") || "n/a"}`)
    }
  }

  lines.push("", "Required fixes:")
  if (review.requiredFixes.length === 0) {
    lines.push("- none")
  } else {
    for (const fix of review.requiredFixes) lines.push(`- ${fix}`)
  }

  lines.push("", "Suggested repair prompt:", review.suggestedRepairPrompt)
  if (review.repairTaskId) {
    lines.push("", `repair_task_id: ${review.repairTaskId}`)
  }
  return lines
}

function evaluationArtifactsDir(project: Project): string {
  return join(project.repoPath, ".openclaw", "evaluation")
}

function buildAutonomousCompanyEvaluation(
  store: DispatcherStore,
  projectRef: string,
  generatedAt = new Date().toISOString()
): AutonomousCompanyEvaluationOutput {
  const project = store.resolveProject(projectRef)
  const tasks = store.listProjectTasks(project.id)
  const runs = store.listProjectRuns(project.id)
  const runEvents = runs.flatMap((run) => store.getRunEvents(run.id))
  const personas = store.listPersonas(project.companyId)
  const agents = store.listAgents(project.companyId)
  const adapterHealth = store.listAdapterLaneHealth(project.companyId)
  const plannerRuns = store.listPlannerRuns(project.id)

  return evaluateAutonomousCompany({
    project: {
      id: project.id,
      name: project.name,
      repoPath: project.repoPath
    },
    generatedAt,
    tasks: tasks.map((task) => ({
      id: task.id,
      projectId: task.projectId,
      personaId: task.personaId,
      stage: task.stage,
      kind: task.kind,
      title: task.title,
      description: task.description,
      labels: task.labels,
      changedFiles: task.changedFiles,
      allowedPaths: task.allowedPaths,
      requiredReading: task.requiredReading,
      verificationCommands: task.verificationCommands,
      status: task.status,
      retryCount: task.retryCount,
      lastError: task.lastError,
      blockedReason: task.blockedReason,
      lastRecoveryAt: task.lastRecoveryAt,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      completedAt: task.completedAt
    })),
    runs: runs.map((run) => ({
      id: run.id,
      projectId: run.projectId,
      taskId: run.taskId,
      agentId: run.agentId,
      adapterType: run.adapterType,
      kind: run.kind,
      status: run.status,
      errorText: run.errorText,
      verificationSummary: run.verificationSummary,
      reviewVerdict: run.reviewVerdict,
      costCents: run.costCents,
      retryClass: run.retryClass,
      metadata: run.metadata,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      createdAt: run.createdAt
    })),
    runEvents: runEvents.map((event) => ({
      id: event.id,
      runId: event.runId,
      seq: event.seq,
      level: event.level,
      message: event.message,
      data: event.data,
      createdAt: event.createdAt
    })),
    personas: personas.map((persona) => ({
      id: persona.id,
      name: persona.name,
      stage: persona.stage,
      preferredAdapterType: persona.preferredAdapterType
    })),
    agents: agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      role: agent.role,
      adapterType: agent.adapterType
    })),
    adapterHealth: adapterHealth.map((entry) => ({
      adapterType: entry.adapterType,
      laneKey: entry.laneKey,
      status: entry.status,
      reason: entry.reason,
      lastError: entry.lastError
    })),
    plannerRuns: plannerRuns.map((run) => ({
      id: run.id,
      status: run.status,
      plannerPersonaId: run.plannerPersonaId,
      plannerAgentId: run.plannerAgentId,
      adapterType: run.adapterType,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      summaryJson: run.summaryJson
    }))
  })
}

function writeAutonomousCompanyEvaluationArtifacts(
  project: Project,
  output: AutonomousCompanyEvaluationOutput
): string[] {
  const directory = evaluationArtifactsDir(project)
  mkdirSync(directory, { recursive: true })
  const artifacts: Array<[string, unknown]> = [
    ["evaluation-snapshot.json", output.snapshot],
    ["trend-report.json", output.trendReport],
    ["persona-scorecards.json", output.personaScorecards],
    ["adapter-scorecards.json", output.adapterScorecards],
    ["project-health-report.json", output.projectHealthReport],
    ["planner-recommendations.json", output.recommendations],
    ["evaluation-output.json", output]
  ]
  for (const [name, payload] of artifacts) {
    writeFileSync(join(directory, name), `${JSON.stringify(payload, null, 2)}\n`, "utf8")
  }
  return artifacts.map(([name]) => join(directory, name))
}

function renderPolicyDecision(decision: PolicyDecision): string[] {
  return [
    `allowed: ${decision.allowed}`,
    `phase: ${decision.phase}`,
    `risk: ${decision.riskLevel}`,
    `actions: ${decision.actions.join(", ") || "none"}`,
    `blocked: ${decision.blockedActions.join(", ") || "none"}`,
    `sources: ${decision.sources.join(", ")}`,
    `explanation: ${decision.explanation}`,
    "reasons:",
    ...decision.reasons.map((reason) => `- ${reason}`),
    ...(decision.warnings.length > 0 ? ["warnings:", ...decision.warnings.map((warning) => `- ${warning}`)] : [])
  ]
}

function renderPromotionCheck(result: PromotionCheckResult): string[] {
  return [
    `promotion.run=${result.runId}`,
    `promotion.target=${result.target}`,
    `promotion.promotable=${result.promotable}`,
    `promotion.artifact=${result.artifactPath}`,
    ...result.gates.map((gate) => {
      const status = gate.passed ? "PASS" : "FAIL"
      return `${status} ${gate.id}: ${gate.explanation}`
    })
  ]
}

function parsePromotionTarget(value: string): PromotionTarget {
  switch (value) {
    case "branch":
    case "local_branch":
      return "local_branch"
    case "pr":
    case "pull_request":
      return "pull_request"
    case "rc":
    case "release_candidate":
      return "release_candidate"
    case "main":
    case "main_branch":
      return "main_branch"
    default:
      throw new Error(`Unsupported promotion target "${value}". Use branch, pr, rc, or main.`)
  }
}

function renderPersonaSummary(persona: PersonaDefinition): string {
  return `${persona.id} | ${persona.name} | role=${persona.role} | adapter=${persona.defaultAdapterPreference} | lanes=${persona.allowedLanes.join(", ") || "none"}`
}

function renderPersonaDetail(persona: PersonaDefinition): string[] {
  return [
    `id: ${persona.id}`,
    `name: ${persona.name}`,
    `role: ${persona.role}`,
    `default_adapter_preference: ${persona.defaultAdapterPreference}`,
    `allowed_lanes: ${persona.allowedLanes.join(", ") || "none"}`,
    "responsibilities:",
    ...persona.responsibilities.map((entry) => `- ${entry}`),
    "decision_authority:",
    ...persona.decisionAuthority.map((entry) => `- ${entry}`),
    "forbidden_actions:",
    ...persona.forbiddenActions.map((entry) => `- ${entry}`),
    "prompt_style:",
    `- voice: ${persona.promptStyle.voice}`,
    ...persona.promptStyle.format.map((entry) => `- format: ${entry}`),
    ...persona.promptStyle.interactionRules.map((entry) => `- interaction: ${entry}`),
    "required_reading:",
    ...persona.requiredReading.map((entry) => `- ${entry}`),
    "verification_rules:",
    ...persona.verificationRules.map((entry) => `- ${entry}`)
  ]
}

function renderTaskPackageBlock(lines: string[]): string[] {
  return ["Generated task package:", ...lines]
}

function handoffTitle(sourcePersona: string, targetPersona: string): string {
  return `Handoff: ${sourcePersona} -> ${targetPersona}`
}

function taskKindForHandoffTarget(targetPersona: string): TaskKind {
  const normalized = targetPersona.toLowerCase()
  if (normalized.includes("plan") || normalized === "cto") return "plan"
  if (normalized.includes("qa") || normalized.includes("review") || normalized.includes("security")) return "review"
  if (normalized.includes("repair") || normalized.includes("fix")) return "fix_review_feedback"
  if (normalized.includes("release") || normalized.includes("promot")) return "promote"
  return "implement"
}

function profileIdForProject(repoPath: string): string | null {
  return bestProfileMatch(repoPath)?.profileId ?? null
}

function isPromptTemplateId(value: string): value is PromptTemplateId {
  return [
    "implementation",
    "review",
    "repair",
    "refactor",
    "test-generation",
    "documentation",
    "architecture-analysis",
    "security-review"
  ].includes(value)
}

function parsePromptTemplate(value?: string): PromptTemplateId | null {
  if (!value) return null
  if (isPromptTemplateId(value)) return value
  throw new Error(
    `Unsupported prompt template "${value}". Use implementation, review, repair, refactor, test-generation, documentation, architecture-analysis, or security-review.`
  )
}

function fallbackPromptPersona(input: {
  id?: string
  name?: string
  stage?: string | null
  laneId?: string | null
}): PromptPersonaInput {
  const laneSuffix = input.laneId ? ` for ${input.laneId}` : ""
  return {
    id: input.id ?? "codex-engineer",
    name: input.name ?? `Codex Engineer${laneSuffix}`,
    stage: input.stage ?? "coder",
    ownedLanes: input.laneId ? [input.laneId] : []
  }
}

function formatPlannedStatus(status: "created" | "updated" | "kept", dryRun: boolean): string {
  if (!dryRun) return status
  if (status === "created") return "would create"
  if (status === "updated") return "would update"
  return "would keep"
}

function jobDate(value: unknown): Date | null {
  if (!value) return null
  if (value instanceof Date) return value
  if (typeof value === "object") {
    if ("toDate" in value && typeof value.toDate === "function") {
      return value.toDate()
    }
    if ("toJSDate" in value && typeof value.toJSDate === "function") {
      return value.toJSDate()
    }
    if ("valueOf" in value && typeof value.valueOf === "function") {
      const converted = value.valueOf()
      if (converted instanceof Date) {
        return converted
      }
      return new Date(String(converted))
    }
  }

  const parsed = new Date(String(value))
  return Number.isNaN(parsed.getTime()) ? null : parsed
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

function nextDueAt(job: JobSpec, now = new Date()): string | null {
  const nextRun = nextCronRun(job.cron, job.lastTriggeredAt ? new Date(job.lastTriggeredAt) : now, job.timezone)
  return jobDate(nextRun)?.toISOString() ?? null
}

function writeQueueHealth(io: Io, summary: QueueHealthSummary): void {
  writeBlock(io, [
    `queue_health.checked_at=${summary.checkedAt}`,
    `queue_health.dry_run=${summary.dryRun}`,
    `queue_health.detected=${summary.detected}`,
    `queue_health.repaired=${summary.repaired}`,
    `queue_health.stale_runs=${summary.counts.staleRuns}`,
    `queue_health.stale_claims=${summary.counts.staleClaims}`,
    `queue_health.zombie_agents=${summary.counts.zombieAgents}`,
    `queue_health.stale_planner_runs=${summary.counts.stalePlannerRuns}`,
    `queue_health.duplicate_planner_runs=${summary.counts.duplicatePlannerRuns}`,
    `queue_health.repaired_planner_lineages=${summary.counts.repairedPlannerLineages}`
  ])

  if (summary.actions.length === 0) return

  io.stdout("\nActions:\n")
  for (const action of summary.actions) {
    io.stdout(
      `- entity=${action.entity} reason=${action.reason} project=${action.projectId ?? "n/a"} task=${action.taskId ?? "n/a"} run=${action.runId ?? "n/a"} planner_run=${action.plannerRunId ?? "n/a"} agent=${action.agentId ?? "n/a"} canonical=${action.canonicalPlannerRunId ?? "n/a"} status=${action.recoveryStatus ?? "n/a"} detail=${action.detail ?? "n/a"}\n`
    )
  }
}

function writeDirectorReport(io: Io, report: AutonomousDirectorCycleReport): void {
  writeBlock(io, [
    "Autonomous director cycle complete.",
    `cycle_id=${report.cycleId}`,
    `project=${report.projectName}`,
    `profile=${report.profileId}`,
    `mode=${report.dryRun ? "dry-run" : "apply"}`,
    `autonomous=${report.autonomous}`,
    `passes=${report.passes}`,
    `stop_reason=${report.stopReason}`,
    `risk_score=${report.riskScore}`,
    `risk_threshold=${report.riskThreshold}`,
    `quota_used=${report.quotaUsed}`,
    `quota_limit=${report.quotaLimit}`,
    `pending.queued=${report.finalQueue.queuedTasks}`,
    `pending.running=${report.finalQueue.runningTasks}`,
    `pending.review_needed=${report.finalQueue.reviewNeededTasks}`,
    `pending.promotion_pending=${report.finalQueue.promotionPendingTasks}`,
    `pending.blocked=${report.finalQueue.blockedTasks}`,
    `pending.failed=${report.finalQueue.failedTasks}`,
    `pending.running_runs=${report.finalQueue.runningRuns}`,
    `pending.active_promotions=${report.finalQueue.activePromotions}`,
    `incident_notification=${report.incidentNotification?.delivery ?? "not-required"}`,
    `incident_notification_summary=${report.incidentNotification?.resultSummary ?? "none"}`
  ])

  if (report.decisions.length === 0) return

  for (const decision of report.decisions) {
    const stop = decision.stopReason ? ` stop=${decision.stopReason}` : ""
    io.stdout(
      `- pass=${decision.passIndex} action=${decision.action} status=${decision.status} risk=${decision.riskScore}/${decision.riskThreshold} quota=${decision.quotaUsed}/${decision.quotaLimit}${stop} reason=${decision.reason}\n`
    )
  }
}

function writeQueueRefreshFullCycleReport(io: Io, report: QueueRefreshFullCycleReport): void {
  writeBlock(io, [
    "Queue refresh full cycle complete.",
    `cycle_id=${report.cycleId}`,
    `project=${report.projectName}`,
    `profile=${report.profileId}`,
    `stop_reason=${report.stopReason}`,
    `passes=${report.passes.length}/${report.maxPasses}`,
    `queue_refresh.created_workflows=${report.queueRefresh.createdWorkflows}`,
    `queue_refresh.created_tasks=${report.queueRefresh.createdTasks}`,
    `queue_refresh.planner_run_id=${report.queueRefresh.plannerRunId ?? "none"}`,
    `queue_refresh.planner_created_tasks=${report.queueRefresh.plannerCreatedTasks ?? 0}`,
    `planner_created_task_ids=${report.plannerCreatedTaskIds.join(", ") || "none"}`,
    `runs=${report.runs.length}`,
    `promotions=${report.promotions.length}`,
    `releases=${report.releases.length}`,
    `pending.queued=${report.finalQueue.queuedTasks}`,
    `pending.running=${report.finalQueue.runningTasks}`,
    `pending.review_needed=${report.finalQueue.reviewNeededTasks}`,
    `pending.promotion_pending=${report.finalQueue.promotionPendingTasks}`,
    `pending.blocked=${report.finalQueue.blockedTasks}`,
    `pending.failed=${report.finalQueue.failedTasks}`,
    `pending.active_promotions=${report.finalQueue.activePromotions}`
  ])

  for (const pass of report.passes) {
    io.stdout(
      `- pass=${pass.index} progressed=${pass.progressed} runs=${pass.newRuns.length} queued=${pass.queue.queuedTasks} review=${pass.queue.reviewNeededTasks} promotion=${pass.queue.promotionPendingTasks} blocked=${pass.queue.blockedTasks}\n`
    )
  }

  for (const run of report.runs) {
    io.stdout(
      `- run=${run.runId} task=${run.taskId} kind=${run.taskKind} run_status=${run.runStatus} task_status=${run.taskStatus} loop=${run.loopStatus}/${run.lifecyclePhase ?? "none"} streams=${run.streams.join(",") || "none"} pr=${run.prNumber ?? "n/a"}\n`
    )
  }

  for (const promotion of report.promotions) {
    io.stdout(
      `- promotion=${promotion.id} task=${promotion.taskId} status=${promotion.status} pr=${promotion.prNumber ?? "n/a"} url=${promotion.prUrl ?? "n/a"} error=${promotion.lastError ?? "none"}\n`
    )
  }

  for (const release of report.releases) {
    io.stdout(
      `- release=${release.version ?? release.name} status=${release.status} released_at=${release.releasedAt ?? "n/a"}\n`
    )
  }
}

function writeDirectorExplanation(io: Io, decision: ReturnType<DispatcherStore["getLatestDirectorDecision"]>): void {
  if (!decision) {
    writeBlock(io, ["No director decisions found."])
    return
  }

  const queue = decision.input.queue as Record<string, unknown> | undefined
  const risk = decision.input.risk as { reasons?: unknown } | undefined
  const riskReasons = Array.isArray(risk?.reasons) ? risk.reasons.map(String) : []

  writeBlock(io, [
    `decision_id=${decision.id}`,
    `cycle_id=${decision.cycleId}`,
    `pass=${decision.passIndex}`,
    `action=${decision.action}`,
    `status=${decision.status}`,
    `dry_run=${decision.dryRun}`,
    `reason=${decision.reason}`,
    `stop_reason=${decision.stopReason ?? "none"}`,
    `risk=${decision.riskScore}/${decision.riskThreshold}`,
    `quota=${decision.quotaUsed}/${decision.quotaLimit}`,
    `created_at=${decision.createdAt}`,
    `completed_at=${decision.completedAt ?? "none"}`
  ])

  if (queue) {
    writeBlock(io, [
      "",
      "Queue snapshot:",
      `queued=${queue.queuedTasks ?? 0}`,
      `running=${queue.runningTasks ?? 0}`,
      `review_needed=${queue.reviewNeededTasks ?? 0}`,
      `promotion_pending=${queue.promotionPendingTasks ?? 0}`,
      `blocked=${queue.blockedTasks ?? 0}`,
      `running_runs=${queue.runningRuns ?? 0}`
    ])
  }

  if (riskReasons.length > 0) {
    io.stdout("\nRisk reasons:\n")
    for (const reason of riskReasons) {
      io.stdout(`- ${reason}\n`)
    }
  }

  if (decision.result) {
    io.stdout("\nResult:\n")
    io.stdout(`${JSON.stringify(decision.result, null, 2)}\n`)
  }
}

function profileRoutingRulesForProject(storeRules: RoutingRule[], projectRepoPath: string): RoutingRule[] {
  const match = bestProfileMatch(projectRepoPath)
  if (!match) return storeRules
  try {
    const profile = loadProjectProfile(match.profileId)
    const profileRules = profile.routingRules.map(
      (rule, index): RoutingRule => ({
        id: `profile:${profile.profileId}:${index}`,
        name: `profile:${rule.name}`,
        priority: rule.priority,
        targetAdapterType: rule.targetAdapterType,
        matchType: "keyword",
        patterns: rule.patterns,
        isFallback: rule.isFallback === true,
        createdAt: "1970-01-01T00:00:00.000Z"
      })
    )
    return [...profileRules, ...storeRules]
  } catch {
    return storeRules
  }
}

export function healthByAdapterForRouting(
  store: DispatcherStore,
  companyId: string
): Record<string, AdapterHealthcheckResult> {
  const health: Record<string, AdapterHealthcheckResult> = {
    codex_local: { ok: true, message: "ok" },
    gemini_local: { ok: true, message: "ok" },
    azure_foundry: { ok: true, message: "ok" }
  }

  const quota = readCodexQuotaOverview()
  if (quota.assessment === "blocked") {
    health.codex_local = { ok: false, message: "Codex quota blocked by quota cache" }
  }

  for (const adapterType of ["codex_local", "gemini_local", "azure_foundry"] as const) {
    const lanes = store.listAdapterLaneHealth(companyId, adapterType)
    let predictiveCircuitOpened = false
    for (const lane of lanes) {
      if (Array.isArray(lane.metadata?.samples)) {
        const samples = (lane.metadata.samples as any[]).map((s) => ({
          timestamp: Number(s.timestamp),
          remaining: Number(s.remaining)
        }))
        if (shouldOpenPredictiveCircuit({ samples })) {
          predictiveCircuitOpened = true
          break
        }
      }
    }
    if (predictiveCircuitOpened) {
      health[adapterType] = {
        ok: false,
        message: `${adapterType} predictive rate limit circuit open`
      }
      continue
    }

    const latestHealthy = lanes
      .filter((lane) => lane.status === "healthy" && lane.lastSuccessAt)
      .sort((left, right) => String(right.lastSuccessAt).localeCompare(String(left.lastSuccessAt)))[0]
    const recentRuns = store
      .listRuns(200)
      .filter((run) => run.companyId === companyId && run.adapterType === adapterType)
      .slice(0, 5)
    const mostRecentRunAt = recentRuns[0]?.finishedAt ?? recentRuns[0]?.startedAt ?? recentRuns[0]?.createdAt ?? null
    if (latestHealthy?.lastSuccessAt && (!mostRecentRunAt || latestHealthy.lastSuccessAt > mostRecentRunAt)) {
      continue
    }
    if (recentRuns.length >= 3 && recentRuns.slice(0, 3).every((run) => run.status === "failed")) {
      health[adapterType] = {
        ok: false,
        message: `${adapterType} has 3 recent failed runs`
      }
    }
  }

  return health
}

function routeDecisionForTask(store: DispatcherStore, task: Task): RouteDecision {
  const project = store.getProjectById(task.projectId)
  return routeTask({
    task,
    rules: profileRoutingRulesForProject(store.listRoutingRules(), project.repoPath),
    agents: store.listAgents(task.companyId),
    healthByAdapter: healthByAdapterForRouting(store, task.companyId)
  })
}

function routeExplanationPayload(decision: RouteDecision): Record<string, unknown> {
  return {
    selectedAdapter: decision.adapterType,
    selectedAgent: decision.agent
      ? {
          id: decision.agent.id,
          name: decision.agent.name,
          model: decision.agent.model
        }
      : null,
    taskShape: decision.taskShape,
    selectedModel: decision.selectedModel,
    reasoningEffort: decision.reasoningEffort,
    modelFamily: decision.modelFamily,
    modelRoutingReason: decision.modelRoutingReason,
    costEstimate: decision.costEstimate,
    risk: decision.risk,
    promptRouteRank: decision.risk.promptRouteRank,
    reasoning: decision.selectionReasons,
    fallbackLadder: decision.fallbackLadder,
    scorecard: decision.scorecard,
    agentCandidates: decision.agentSelection?.candidates ?? []
  }
}

function persistRouteExplanation(store: DispatcherStore, task: Task, decision: RouteDecision): Task {
  store.appendTaskEvent(
    task.id,
    "routing_explanation",
    "Routing explanation persisted",
    routeExplanationPayload(decision)
  )
  return task
}

function renderRouteDecision(task: Task, decision: RouteDecision, explain = false): string[] {
  const lines = [
    `task: ${task.id}`,
    `selected_adapter: ${decision.adapterType}`,
    `selected_agent: ${decision.agent?.name ?? "none"}`,
    `selected_model: ${decision.selectedModel ?? "none"}`,
    `reasoning_effort: ${decision.reasoningEffort}`,
    `model_family: ${decision.modelFamily}`,
    `estimated_cost_usd: ${decision.costEstimate.estimatedUsd ?? "unknown"}`,
    `estimated_tokens: ${decision.costEstimate.inputTokens} in / ${decision.costEstimate.outputTokens} out`,
    `prompt_pipeline: ${decision.risk.promptRouteRank.pipeline.join(" -> ")}`,
    `prompt_intent: ${decision.risk.promptRouteRank.intent}`,
    `complexity_estimate: ${decision.risk.promptRouteRank.complexityScore100}/100`,
    `value_estimate: ${decision.risk.promptRouteRank.valueScore100}/100`,
    `task_shape: ${decision.taskShape}`,
    `reason: ${decision.reason}`,
    `fallback_ladder: ${decision.fallbackLadder.join(" -> ")}`,
    `model_routing_reason: ${decision.modelRoutingReason}`,
    "",
    "Reasoning:",
    ...decision.risk.promptRouteRank.rankingReasons.map((reason) => `- ${reason}`),
    ...decision.selectionReasons.map((reason) => `- ${reason}`)
  ]

  if (explain) {
    lines.push("", "Scorecard:")
    for (const entry of decision.scorecard) {
      lines.push(
        `- ${entry.adapterType}: score=${entry.score} available=${entry.available ? "yes" : "no"} health=${
          entry.healthOk ? "ok" : "blocked"
        }`
      )
      for (const reason of entry.reasons.slice(0, 5)) {
        lines.push(`  - ${reason}`)
      }
    }
  }

  return lines
}

function syntheticTaskForGoal(input: {
  companyId: string
  projectId: string
  goal: string
  labels: string[]
  changedFiles: string[]
  lane?: string
  risk?: string
}): Task {
  const now = new Date().toISOString()
  return {
    id: "simulate",
    companyId: input.companyId,
    projectId: input.projectId,
    workflowId: null,
    goalId: null,
    milestoneId: null,
    parentTaskId: null,
    dependsOnTaskIds: [],
    personaId: null,
    stage: null,
    title: input.goal,
    description: input.risk ? `Risk level: ${input.risk}` : null,
    labels: input.labels,
    changedFiles: input.changedFiles,
    taskPackage: null,
    kind: "user",
    priority: 0,
    scheduledAt: null,
    source: "manual",
    status: "queued",
    assignedAgentId: null,
    requestedAdapterType: null,
    laneId: input.lane ?? null,
    allowedPaths: [],
    requiredReading: [],
    verificationCommands: [],
    claimStatus: "unclaimed",
    claimToken: null,
    claimExpiresAt: null,
    claimOwnerRunId: null,
    claimOwnerAgentId: null,
    claimedAt: null,
    lineageRootId: null,
    lineageParentId: null,
    taskPackagePath: null,
    reviewHandoffPath: null,
    artifactDir: null,
    reviewRequired: false,
    approvalRequired: false,
    retryCount: 0,
    maxRetries: 1,
    lastError: null,
    blockedReason: null,
    lastRecoveryAt: null,
    lastRecoveryReason: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null
  }
}

function withAutonomousExecutionEnv<T>(autonomousTurns: number, fn: () => Promise<T>): Promise<T> {
  const previousMode = process.env.OPENCLAW_AUTONOMOUS_EXECUTION_MODE
  const previousTurns = process.env.OPENCLAW_AUTONOMOUS_EXECUTION_MAX_TURNS
  process.env.OPENCLAW_AUTONOMOUS_EXECUTION_MODE = "1"
  process.env.OPENCLAW_AUTONOMOUS_EXECUTION_MAX_TURNS = String(autonomousTurns)

  return fn().finally(() => {
    if (previousMode === undefined) delete process.env.OPENCLAW_AUTONOMOUS_EXECUTION_MODE
    else process.env.OPENCLAW_AUTONOMOUS_EXECUTION_MODE = previousMode

    if (previousTurns === undefined) delete process.env.OPENCLAW_AUTONOMOUS_EXECUTION_MAX_TURNS
    else process.env.OPENCLAW_AUTONOMOUS_EXECUTION_MAX_TURNS = previousTurns
  })
}

function responseCompressionModeFromCli(value: boolean | string): ResponseCompressionMode | null {
  if (value === false) return null
  if (value === true) return "full"
  const normalized = value.trim().toLowerCase()
  if (normalized === "off" || normalized === "lite" || normalized === "full" || normalized === "ultra") {
    return normalized
  }
  throw new Error(`Invalid --caveman level ${value}. Expected off, lite, full, or ultra.`)
}

function applyResponseCompressionOverride(value: boolean | string): () => void {
  const mode = responseCompressionModeFromCli(value)
  if (!mode) return () => undefined
  const previous = process.env.OPENCLAW_RESPONSE_COMPRESSION_OVERRIDE
  process.env.OPENCLAW_RESPONSE_COMPRESSION_OVERRIDE = mode
  return () => {
    if (previous === undefined) delete process.env.OPENCLAW_RESPONSE_COMPRESSION_OVERRIDE
    else process.env.OPENCLAW_RESPONSE_COMPRESSION_OVERRIDE = previous
  }
}

function collectAutonomousQueueState(
  store: DispatcherStore,
  options: {
    companyId?: string
    projectId?: string
  } = {}
): AutonomousQueueState {
  const tasks = options.projectId ? store.listProjectTasks(options.projectId) : store.listTasks(options.companyId)
  const scopedTasks =
    options.companyId && options.projectId ? tasks.filter((task) => task.companyId === options.companyId) : tasks
  const runningRuns = store
    .listRunningRuns(options.companyId)
    .filter((run) => !options.projectId || run.projectId === options.projectId).length

  return {
    queuedTasks: scopedTasks.filter((task) => task.status === "queued").length,
    runningTasks: scopedTasks.filter((task) => task.status === "running").length,
    reviewNeededTasks: scopedTasks.filter((task) => task.status === "review_needed").length,
    promotionPendingTasks: scopedTasks.filter((task) => task.status === "promotion_pending").length,
    blockedTasks: scopedTasks.filter((task) => task.status === "blocked").length,
    runningRuns
  }
}

function autonomousQueueDrained(state: AutonomousQueueState): boolean {
  return (
    state.queuedTasks === 0 &&
    state.runningTasks === 0 &&
    state.reviewNeededTasks === 0 &&
    state.promotionPendingTasks === 0 &&
    state.runningRuns === 0
  )
}

function rearmAutonomousTransitionJobs(
  store: DispatcherStore,
  state: AutonomousQueueState,
  options: { companyId?: string; projectId?: string; triggeredSince?: string } = {}
): number {
  const jobIds = new Set<JobId>()
  if (state.queuedTasks > 0) jobIds.add("execution-sweep")
  if (state.reviewNeededTasks > 0) jobIds.add("review-sweep")
  if (state.promotionPendingTasks > 0) jobIds.add("promotion-sweep")
  if (jobIds.size === 0) return 0

  let rearmed = 0
  for (const jobSpec of store.listJobSpecs(options.companyId)) {
    if (options.projectId && jobSpec.projectId !== options.projectId) continue
    if (!jobIds.has(jobSpec.jobId)) continue
    if (
      options.triggeredSince &&
      jobSpec.lastTriggeredAt &&
      Date.parse(jobSpec.lastTriggeredAt) >= Date.parse(options.triggeredSince)
    ) {
      continue
    }
    store.updateJobSpecRuntime(jobSpec.id, {
      lastTriggeredAt: null,
      lastResult: "re-armed by autonomous tick"
    })
    rearmed += 1
  }
  return rearmed
}

function storeFrom(command: Command, fallbackDbPath?: string): DispatcherStore {
  const { db } = command.optsWithGlobals<{ db?: string }>()
  const optionSource = command.getOptionValueSource("db")
  const shouldUseFallback = Boolean(fallbackDbPath) && (!optionSource || optionSource === "default")
  const store = new DispatcherStore(shouldUseFallback ? fallbackDbPath : db)
  store.migrate()
  return store
}

function executorFrom(store: DispatcherStore): DispatcherExecutor {
  return new DispatcherExecutor(store, {
    [azureFoundryAdapter.type]: azureFoundryAdapter,
    [codexLocalAdapter.type]: codexLocalAdapter,
    [geminiLocalAdapter.type]: geminiLocalAdapter
  })
}

function resolveAskProject(store: DispatcherStore, projectRef?: string): Project {
  if (projectRef) return store.resolveProject(projectRef)
  const projects = store.listProjects()
  if (projects.length === 1) return projects[0]!
  if (projects.length === 0) throw new Error("No projects exist yet. Run `dispatcher project add` first.")
  throw new Error("Ambiguous project. Pass --project to choose which project the natural-language command targets.")
}

function profileIdForAskProject(project: Project, explicitProfileId?: string): string | null {
  if (explicitProfileId) return explicitProfileId
  return bestProfileMatch(project.repoPath)?.profileId ?? null
}

function profileAllowsPrCreation(profileId: string | null): boolean {
  if (!profileId) return false
  return loadProjectProfile(profileId).promotionPolicy.mode !== "manual"
}

function buildAskTaskPackage(project: Project, command: InterpretedAskCommand): ReturnType<typeof buildTaskPackage> {
  const action = command.action
  const title =
    action.type === "create_task" ? action.title : action.type === "create_workflow" ? action.title : command.summary
  const description =
    action.type === "create_task" || action.type === "create_workflow" ? action.description : command.summary
  const labels =
    action.type === "create_task" || action.type === "create_workflow" || action.type === "create_many_tasks"
      ? action.labels
      : []

  return buildTaskPackage({
    title,
    description,
    labels,
    changedFiles: [],
    requestedAdapterType: action.type === "create_task" ? (action.requestedAdapterType ?? null) : null,
    assignedAgentAdapterType: null,
    repoContext: detectRepoContext(project.repoPath, project.verifyCommand),
    repoPath: project.repoPath,
    verifyCommand: project.verifyCommand
  })
}

async function executeAskCommand(input: {
  store: DispatcherStore
  io: Io
  project: Project
  profileId: string | null
  command: InterpretedAskCommand
}): Promise<Record<string, unknown>> {
  const { store, io, project, profileId, command } = input
  const action = command.action

  if (action.type === "create_task") {
    const taskPackage = buildAskTaskPackage(project, command)
    const created = store.createTask({
      projectRef: project.id,
      title: action.title,
      description: action.description,
      labels: action.labels,
      taskPackage,
      kind: action.kind,
      requestedAdapterType: action.requestedAdapterType ?? null,
      reviewRequired: action.reviewRequired ?? false,
      approvalRequired: action.approvalRequired ?? false
    })
    writeBlock(io, [`Created task ${created.title}`, `id: ${created.id}`, `status: ${created.status}`])
    return { taskId: created.id, status: created.status }
  }

  if (action.type === "create_many_tasks") {
    const createdIds: string[] = []
    for (let index = 1; index <= action.count; index += 1) {
      const title = `${action.titlePrefix} ${index}`
      const taskPackage = buildTaskPackage({
        title,
        description: action.description,
        labels: action.labels,
        changedFiles: [],
        requestedAdapterType: null,
        assignedAgentAdapterType: null,
        repoContext: detectRepoContext(project.repoPath, project.verifyCommand),
        repoPath: project.repoPath,
        verifyCommand: project.verifyCommand
      })
      const created = store.createTask({
        projectRef: project.id,
        title,
        description: action.description,
        labels: action.labels,
        taskPackage,
        kind: action.kind
      })
      createdIds.push(created.id)
    }
    writeBlock(io, [`Created ${createdIds.length} tasks.`, ...createdIds.map((id) => `- ${id}`)])
    return { taskIds: createdIds }
  }

  if (action.type === "create_workflow") {
    const workflowRecord = store.createWorkflow({
      projectRef: project.id,
      title: action.title,
      description: action.description
    })
    const taskPackage = buildAskTaskPackage(project, command)
    const plannerPersona = store.findPersonaByStage(project.companyId, "planner")
    const coderPersona = store.findPersonaByStage(project.companyId, "coder")
    const reviewerPersona = store.findPersonaByStage(project.companyId, "reviewer")
    const promoterPersona = store.findPersonaByStage(project.companyId, "promoter")
    const planTask = store.createTask({
      projectRef: project.id,
      workflowId: workflowRecord.id,
      personaRef: plannerPersona?.id ?? null,
      stage: "planner",
      kind: "plan",
      title: `Plan: ${action.title}`,
      description: action.description,
      labels: action.labels,
      taskPackage,
      maxRetries: 1
    })
    store.updateWorkflow(workflowRecord.id, { rootTaskId: planTask.id })
    const implementTask = store.createTask({
      projectRef: project.id,
      workflowId: workflowRecord.id,
      personaRef: coderPersona?.id ?? null,
      stage: "coder",
      kind: "implement",
      dependsOnTaskIds: [planTask.id],
      title: `Implement: ${action.title}`,
      description: action.description,
      labels: action.labels,
      taskPackage,
      maxRetries: 1
    })
    const reviewTask = store.createTask({
      projectRef: project.id,
      workflowId: workflowRecord.id,
      personaRef: reviewerPersona?.id ?? null,
      stage: "reviewer",
      kind: "review",
      dependsOnTaskIds: [implementTask.id],
      title: `Review: ${action.title}`,
      description: "Review the implementation and verification before promotion.",
      labels: [...action.labels, "review"],
      taskPackage,
      maxRetries: 0
    })
    const promoteTask = store.createTask({
      projectRef: project.id,
      workflowId: workflowRecord.id,
      personaRef: promoterPersona?.id ?? null,
      stage: "promoter",
      kind: "promote",
      dependsOnTaskIds: [reviewTask.id],
      title: `Promote: ${action.title}`,
      description: "Create PR only after configured review and promotion gates allow it.",
      labels: [...action.labels, "promotion"],
      taskPackage,
      maxRetries: 2
    })
    writeBlock(io, [
      `Created workflow ${workflowRecord.title}`,
      `id: ${workflowRecord.id}`,
      `plan_task: ${planTask.id}`,
      `implement_task: ${implementTask.id}`,
      `review_task: ${reviewTask.id}`,
      `promote_task: ${promoteTask.id}`
    ])
    return {
      workflowId: workflowRecord.id,
      taskIds: [planTask.id, implementTask.id, reviewTask.id, promoteTask.id]
    }
  }

  if (action.type === "run_job") {
    if (action.jobId === "promotion-sweep" && !profileAllowsPrCreation(profileId)) {
      throw new Error(
        "PR creation is blocked because the selected or detected profile does not permit ready PR promotion."
      )
    }
    const runtime = new DirectorRuntime(store, executorFrom(store))
    const result = await runtime.runJob(project.id, action.jobId, profileId)
    writeBlock(io, [`job: ${result.jobId}`, `profile: ${result.profileId}`, `result: ${result.resultSummary}`])
    return { jobId: result.jobId, profileId: result.profileId, resultSummary: result.resultSummary }
  }

  if (action.type === "read_completed_runs") {
    const completed = store
      .listRuns(action.limit)
      .filter((run) => run.projectId === project.id && run.status !== "running")
      .slice(0, action.limit)
    if (completed.length === 0) {
      writeBlock(io, ["No completed runs found."])
      return { completedRuns: 0 }
    }
    writeBlock(
      io,
      completed.map(
        (run) =>
          `${run.id} | task=${run.taskId} | status=${run.status} | adapter=${run.adapterType ?? "n/a"} | finished=${run.finishedAt ?? "n/a"}`
      )
    )
    return { completedRuns: completed.length }
  }

  if (action.type === "explain_director_stop") {
    const decisions = store.listDirectorDecisions({ projectId: project.id, limit: action.limit })
    if (decisions.length === 0) {
      writeBlock(io, ["No director decisions found."])
      return { decisions: 0 }
    }
    const latest = decisions[0]!
    writeBlock(io, [
      `latest_decision: ${latest.id}`,
      `action: ${latest.action}`,
      `status: ${latest.status}`,
      `stop_reason: ${latest.stopReason ?? "n/a"}`,
      `reason: ${latest.reason}`,
      `risk: ${latest.riskScore}/${latest.riskThreshold}`,
      `quota: ${latest.quotaUsed}/${latest.quotaLimit}`,
      "",
      "Recent decisions:",
      ...decisions.map(
        (decision) =>
          `- ${decision.createdAt} | ${decision.action} | ${decision.status} | stop=${decision.stopReason ?? "n/a"} | ${decision.reason}`
      )
    ])
    return { decisions: decisions.length, latestDecisionId: latest.id, stopReason: latest.stopReason }
  }

  throw new Error(action.type === "block" ? action.reason : "Command requires clarification before execution.")
}

function resolveProjectForTaskFactory(store: DispatcherStore, ref?: string): Project {
  if (ref) return store.resolveProject(ref)
  const projects = store.listProjects()
  if (projects.length === 1) return projects[0]!
  if (projects.length === 0) throw new Error("No projects exist yet. Run `dispatcher project add` first.")
  throw new Error("Multiple projects exist. Pass --project to disambiguate.")
}

function loadProfileForProject(repoPath: string, profileId?: string): ReturnType<typeof loadProjectProfile> {
  const selected = profileId ?? bestProfileMatch(repoPath)?.profileId ?? "minimal-repo"
  try {
    return loadProjectProfile(selected)
  } catch (error) {
    if (profileId) throw error
    return loadProjectProfile("minimal-repo")
  }
}

function adapterFrom(type: string): AdapterDefinition {
  if (type === codexLocalAdapter.type) return codexLocalAdapter
  if (type === geminiLocalAdapter.type) return geminiLocalAdapter
  if (type === azureFoundryAdapter.type) return azureFoundryAdapter
  throw new Error(`Unsupported adapter "${type}". Use codex_local, gemini_local, or azure_foundry.`)
}

function buildAdapterSmokeContext(input: {
  adapterType: AdapterType
  adapterLabel: string
  repoPath: string
  command: string | null
  model: string | null
  prompt: string
  env: Record<string, string>
  sessionId: string | null
}): AdapterExecutionContext {
  const triggeredAt = new Date().toISOString()
  const sessionKey = `smoke:${input.adapterType}:${triggeredAt}`

  return {
    company: {
      id: "smoke-company",
      name: "OpenClaw Smoke",
      description: null,
      createdAt: triggeredAt
    },
    project: {
      id: "smoke-project",
      companyId: "smoke-company",
      name: "adapter-smoke",
      repoPath: input.repoPath,
      verifyCommand: null,
      profileId: null,
      profilePath: null,
      profile: {},
      createdAt: triggeredAt,
      updatedAt: triggeredAt
    },
    task: {
      id: "smoke-task",
      companyId: "smoke-company",
      projectId: "smoke-project",
      workflowId: null,
      goalId: null,
      milestoneId: null,
      parentTaskId: null,
      dependsOnTaskIds: [],
      personaId: null,
      stage: null,
      title: `${input.adapterLabel} smoke`,
      description: input.prompt,
      labels: ["smoke"],
      changedFiles: [],
      taskPackage: null,
      kind: "user",
      priority: 0,
      scheduledAt: null,
      source: "manual",
      status: "queued",
      assignedAgentId: null,
      requestedAdapterType: input.adapterType,
      laneId: null,
      allowedPaths: [],
      requiredReading: [],
      verificationCommands: [],
      claimStatus: "unclaimed",
      claimToken: null,
      claimExpiresAt: null,
      claimOwnerRunId: null,
      claimOwnerAgentId: null,
      claimedAt: null,
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
      createdAt: triggeredAt,
      updatedAt: triggeredAt,
      completedAt: null
    },
    agent: {
      id: "smoke-agent",
      companyId: "smoke-company",
      name: `smoke-${input.adapterType}`,
      role: input.adapterLabel,
      adapterType: input.adapterType,
      status: "idle",
      model: input.model,
      instructionsPath: null,
      command: input.command,
      env: input.env,
      heartbeatEnabled: true,
      heartbeatIntervalSec: 60,
      budgetLimit: null,
      budgetWindow: "monthly",
      lastHeartbeatAt: null,
      createdAt: triggeredAt,
      updatedAt: triggeredAt
    },
    prompt: input.prompt,
    runId: `smoke-run:${triggeredAt}`,
    wakeReason: "manual",
    heartbeatJobId: null,
    triggeredAt,
    sessionKey,
    sessionState: input.sessionId
      ? {
          sessionKey,
          id: sessionKey,
          status: "active",
          companyId: "smoke-company",
          projectId: "smoke-project",
          taskId: "smoke-task",
          agentId: "smoke-agent",
          adapterType: input.adapterType,
          sessionDisplayId: input.sessionId,
          state: { sessionId: input.sessionId },
          updatedAt: triggeredAt
        }
      : null,
    runtimeIdentity: {
      version: 1,
      runtimeKey: sessionKey,
      executionKey: `smoke-run:${triggeredAt}`,
      companyId: "smoke-company",
      projectId: "smoke-project",
      projectName: "adapter-smoke",
      repoPath: input.repoPath,
      taskId: "smoke-task",
      taskKind: "user",
      taskTitle: `${input.adapterLabel} smoke`,
      workflowId: null,
      laneId: null,
      agentId: "smoke-agent",
      agentName: `smoke-${input.adapterType}`,
      adapterType: input.adapterType,
      model: input.model,
      wake: {
        reason: "manual",
        heartbeatJobId: null,
        triggeredAt
      },
      continuation: {
        sessionKey,
        sessionDisplayId: input.sessionId,
        retryCount: 0,
        attempt: 1,
        heartbeatEnabled: true,
        heartbeatIntervalSec: 60,
        supportsSessionResume: true,
        nativeContextManagement: input.adapterType === "codex_local" ? "confirmed" : "unknown"
      },
      scope: {
        allowedPaths: [],
        requiredReading: [],
        verificationCommands: []
      }
    },
    log: () => undefined
  }
}

export function createProgram(
  io: Io = {
    stdout: (message) => process.stdout.write(message),
    stderr: (message) => process.stderr.write(message)
  }
): Command {
  const program = new Command()
  program
    .name("dispatcher")
    .description("CLI-first autonomous control plane for Codex, Gemini, and Azure Foundry")
    .option("--db <path>", "Path to the dispatcher SQLite database", DispatcherStore.defaultDbPath())

  registerNativeAutonomyCommands(program, io)

  program
    .command("ask")
    .description("Interpret a natural-language OpenClaw command")
    .argument("<utterance...>", "Natural-language command")
    .option("--project <ref>", "Project id or name")
    .option("--profile <profileId>", "Explicit profile for policy checks")
    .option("--dry-run", "Persist and preview the interpreted command without executing", false)
    .option("--yes", "Execute the interpreted command without an additional plan-only stop", false)
    .action(async function (
      utteranceParts: string[],
      options: { project?: string; profile?: string; dryRun: boolean; yes: boolean }
    ) {
      const utterance = utteranceParts.join(" ")
      const interpreted = interpretAskCommand(utterance)
      const store = storeFrom(this)
      let commandRecordId: string | null = null
      try {
        const needsProject = interpreted.action.type !== "clarify" && interpreted.action.type !== "block"
        const project = needsProject ? resolveAskProject(store, options.project) : null
        const profileId = project ? profileIdForAskProject(project, options.profile) : (options.profile ?? null)
        const initialStatus =
          interpreted.action.type === "block"
            ? "blocked"
            : interpreted.action.type === "clarify"
              ? "clarification_required"
              : options.dryRun
                ? "dry_run"
                : "planned"
        const commandRecord = store.createInterpretedCommand({
          companyId: project?.companyId ?? null,
          projectId: project?.id ?? null,
          utterance,
          intent: interpreted.intent,
          status: initialStatus,
          dryRun: options.dryRun,
          yes: options.yes,
          structured: {
            ...structuredAskCommand(interpreted),
            projectRef: options.project ?? null,
            profileId
          }
        })
        commandRecordId = commandRecord.id

        if (interpreted.action.type === "block") {
          writeBlock(io, [...renderAskPlan(interpreted), "", `persisted_command: ${commandRecord.id}`])
          return
        }

        if (interpreted.action.type === "clarify") {
          writeBlock(io, [...renderAskPlan(interpreted), "", `persisted_command: ${commandRecord.id}`])
          return
        }

        if (options.dryRun || !options.yes) {
          writeBlock(io, [
            ...renderAskPlan(interpreted),
            `project: ${project?.name ?? "n/a"}`,
            `profile: ${profileId ?? "none"}`,
            "",
            `persisted_command: ${commandRecord.id}`,
            options.dryRun ? "execution: skipped (dry-run)" : "execution: skipped (pass --yes to execute)"
          ])
          return
        }

        if (!project) throw new Error("Project resolution failed for executable command.")
        const result = await executeAskCommand({
          store,
          io,
          project,
          profileId,
          command: interpreted
        })
        store.updateInterpretedCommand(commandRecord.id, {
          status: "executed",
          result
        })
        writeBlock(io, [`persisted_command: ${commandRecord.id}`, "status: executed"])
      } catch (error) {
        if (commandRecordId) {
          store.updateInterpretedCommand(commandRecordId, {
            status: "failed",
            result: { error: error instanceof Error ? error.message : String(error) }
          })
        }
        throw error
      } finally {
        store.close()
      }
    })

  program
    .command("install [targetPath]")
    .description("Bootstrap the dispatcher into an existing project directory")
    .option("--company-name <name>", "Company name to create")
    .option("--project-name <name>", "Project name to create")
    .option("--verify <command>", "Verification command override")
    .option("--tools <list>", "Comma-separated tool lanes to install: codex, gemini, foundry", "codex,gemini")
    .option("--codex-name <name>", "Name for the default Codex agent", "codex-coder")
    .option("--gemini-name <name>", "Name for the default Gemini UI agent", "gemini-ui")
    .option("--foundry-name <name>", "Name for the default Azure Foundry/Kimi agent", "foundry-kimi")
    .option("--codex-role <role>", "Role for the default Codex agent", "Software Engineer")
    .option("--gemini-role <role>", "Role for the default Gemini agent", "UI Engineer")
    .option("--foundry-role <role>", "Role for the default Foundry/Kimi agent", "Planning and Review Strategist")
    .option("--codex-model <model>", "Optional default Codex model")
    .option("--gemini-model <model>", "Optional default Gemini model")
    .option("--foundry-model <model>", "Optional default Azure Foundry model", "Kimi-K2.6")
    .option("--force", "Overwrite generated instruction files", false)
    .option("--profile <profileId>", "Explicit project profile override")
    .option("--dry-run", "Preview dispatcher-managed file changes without writing anything", false)
    .option("--diff", "Show generated content diffs during preview or install", false)
    .option("--update-prompts", "Refresh only generated agent prompt files", false)
    .option(
      "--update-framework",
      "Refresh repo-local dispatcher runtime shims without touching dispatcher state",
      false
    )
    .action(
      (
        targetPath = ".",
        options: {
          companyName?: string
          projectName?: string
          verify?: string
          tools: string
          codexName: string
          geminiName: string
          foundryName: string
          codexRole: string
          geminiRole: string
          foundryRole: string
          codexModel?: string
          geminiModel?: string
          foundryModel?: string
          force: boolean
          profile?: string
          dryRun: boolean
          diff: boolean
          updatePrompts: boolean
          updateFramework: boolean
        }
      ) => {
        const summary = installDispatcherFramework({
          targetPath,
          companyName: options.companyName ?? null,
          projectName: options.projectName ?? null,
          verifyCommand: options.verify ?? null,
          tools: parseInstallTools(options.tools),
          codexName: options.codexName,
          geminiName: options.geminiName,
          foundryName: options.foundryName,
          codexRole: options.codexRole,
          geminiRole: options.geminiRole,
          foundryRole: options.foundryRole,
          codexModel: options.codexModel ?? null,
          geminiModel: options.geminiModel ?? null,
          foundryModel: options.foundryModel ?? null,
          force: options.force,
          profileId: options.profile ?? null,
          dryRun: options.dryRun,
          diff: options.diff,
          updatePrompts: options.updatePrompts,
          updateFramework: options.updateFramework
        })

        const dispatcherGenerated = summary.filePlans.filter((file) => file.ownership === "dispatcher-generated")
        const autonomyFramework = summary.filePlans.filter((file) => file.ownership === "autonomy-framework")
        const profileSelected = summary.filePlans.filter((file) => file.ownership === "profile-selected")
        const repoOwned = summary.filePlans.filter((file) => file.ownership === "repo-owned")
        const refreshLabel = summary.updatePrompts
          ? "prompt refresh"
          : summary.updateFramework
            ? "framework refresh"
            : "install"
        const scopeLabel = summary.updatePrompts
          ? "generated agent prompts only"
          : summary.updateFramework
            ? "framework runtime files only"
            : "full install"
        const header = summary.dryRun
          ? `Previewed dispatcher ${refreshLabel} for ${summary.targetPath}`
          : summary.updatePrompts
            ? `Refreshed dispatcher agent prompts in ${summary.targetPath}`
            : summary.updateFramework
              ? `Refreshed dispatcher framework shims in ${summary.targetPath}`
              : `Bootstrapped dispatcher into ${summary.targetPath}`

        writeBlock(io, [
          header,
          `database: ${summary.dbPath}`,
          `mode: ${summary.dryRun ? "dry-run" : "apply"}`,
          `scope: ${scopeLabel}`,
          `profile: ${summary.profileId ?? "none"}`,
          `verify command: ${summary.verifyCommand ?? "not configured"}`
        ])

        if (!summary.dryRun && !summary.updatePrompts && !summary.updateFramework) {
          writeBlock(io, [
            `company: ${summary.companyCreated ? "created" : "kept"}`,
            `project: ${summary.projectCreated ? "created" : "kept"}`,
            `codex agent: ${summary.codexCreated ? "created" : "kept"}`,
            `gemini agent: ${summary.geminiCreated ? "created" : "kept"}`,
            `foundry agent: ${summary.foundryCreated ? "created" : "kept"}`,
            `tool agents: ${
              summary.toolAgents
                .map(
                  (agent) =>
                    `${agent.name}:${agent.adapterType}${agent.model ? `/${agent.model}` : ""}:${
                      agent.created ? "created" : "kept"
                    }`
                )
                .join(", ") || "none"
            }`,
            `personas synced: ${summary.personasSynced}`,
            `routing rules synced: ${summary.routingRulesSynced}`,
            `jobs synced: ${summary.jobsSynced}`
          ])
        }

        if (summary.stateNote) {
          writeBlock(io, ["", `State: ${summary.stateNote}`])
        }

        writeBlock(io, ["", "Dispatcher-generated files:"])
        for (const file of dispatcherGenerated) {
          io.stdout(`- ${formatPlannedStatus(file.status, summary.dryRun)}: ${file.relativePath} (${file.reason})\n`)
        }

        if (autonomyFramework.length > 0) {
          writeBlock(io, ["", "Autonomy-framework files:"])
          for (const file of autonomyFramework) {
            io.stdout(`- ${formatPlannedStatus(file.status, summary.dryRun)}: ${file.relativePath} (${file.reason})\n`)
          }
        }

        if (profileSelected.length > 0) {
          writeBlock(io, ["", "Profile-selected files:"])
          for (const file of profileSelected) {
            io.stdout(`- ${formatPlannedStatus(file.status, summary.dryRun)}: ${file.relativePath} (${file.reason})\n`)
          }
        }

        if (repoOwned.length > 0) {
          writeBlock(io, ["", "Repo-owned files:"])
          for (const file of repoOwned) {
            io.stdout(`- ${formatPlannedStatus(file.status, summary.dryRun)}: ${file.relativePath} (${file.reason})\n`)
          }
        }

        if (summary.diff) {
          const diffs = dispatcherGenerated.filter((file) => file.diff)
          writeBlock(io, ["", "Generated diffs:"])

          if (diffs.length === 0) {
            io.stdout("- no generated content changes\n")
          }

          for (const file of diffs) {
            io.stdout(`\n${file.relativePath}\n`)
            io.stdout("```diff\n")
            io.stdout(`${file.diff}\n`)
            io.stdout("```\n")
          }
        }

        writeBlock(io, ["", "Manual follow-up:"])
        for (const step of summary.manualSteps) {
          io.stdout(`- ${step}\n`)
        }

        io.stdout("\nNext:\n")
        if (summary.dryRun) {
          io.stdout("- Re-run without `--dry-run` to apply the previewed changes\n")
          return
        }

        if (summary.updatePrompts) {
          io.stdout(`- Review the refreshed prompts under ${summary.targetPath}/.openclaw/agents/\n`)
          return
        }

        if (summary.updateFramework) {
          io.stdout(`- Review the repo-local dispatcher shim under ${summary.targetPath}/.openclaw/bin/\n`)
          io.stdout(
            `- Run \`${summary.targetPath}/scripts/openclaw-dispatcher.sh doctor\` to verify the local wrapper\n`
          )
          return
        }

        io.stdout(`- Review the agent instructions under ${summary.targetPath}/.openclaw/agents/\n`)
        io.stdout(`- Run \`${summary.targetPath}/scripts/openclaw-dispatcher.sh doctor\` to verify the local wrapper\n`)
        io.stdout(`- Create a task with \`${summary.targetPath}/scripts/openclaw-dispatcher.sh task create ...\`\n`)
        io.stdout(
          `- Run \`${summary.targetPath}/scripts/openclaw-dispatcher.sh tick\` to execute one heartbeat cycle\n`
        )
      }
    )

  program
    .command("init")
    .description("Initialize the dispatcher database and routing rules")
    .action(function () {
      const store = storeFrom(this)
      try {
        writeBlock(io, ["Dispatcher initialized.", `Database: ${store.dbPath}`])
      } finally {
        store.close()
      }
    })

  const dispatch = program.command("dispatch").description("Dispatch queued tasks through controlled adapter runs")
  dispatch
    .command("next")
    .requiredOption("--project <project>", "Project id or name")
    .description("Dispatch the next runnable queued task for a project")
    .action(async function (options: { project: string }) {
      const store = storeFrom(this)
      try {
        const executor = executorFrom(store)
        const summary = await executor.dispatchNext(options.project)
        writeBlock(io, [
          `dispatch.executed_runs=${summary.executedRuns}`,
          `dispatch.blocked_tasks=${summary.blockedTasks}`,
          `dispatch.skipped_tasks=${summary.skippedTasks}`,
          `dispatch.follow_up_tasks=${summary.followUpTasks}`
        ])
        if (summary.executedRuns === 0 && summary.blockedTasks === 0) {
          process.exitCode = 1
        }
      } finally {
        store.close()
      }
    })

  dispatch
    .command("task <taskId>")
    .description("Dispatch one queued task by id")
    .action(async function (taskId: string) {
      const store = storeFrom(this)
      try {
        const executor = executorFrom(store)
        const summary = await executor.dispatchTask(taskId)
        writeBlock(io, [
          `dispatch.task_id=${taskId}`,
          `dispatch.executed_runs=${summary.executedRuns}`,
          `dispatch.blocked_tasks=${summary.blockedTasks}`,
          `dispatch.skipped_tasks=${summary.skippedTasks}`,
          `dispatch.follow_up_tasks=${summary.followUpTasks}`
        ])
        if (summary.executedRuns === 0 && summary.blockedTasks === 0) {
          process.exitCode = 1
        }
      } finally {
        store.close()
      }
    })

  program
    .command("adapter-smoke <adapterType>")
    .description("Run a direct smoke test for an adapter/model lane")
    .option("--repo <path>", "Repository root to target", process.cwd())
    .option("--cwd <path>", "Session cwd override for auth-sensitive tools")
    .option("--command <path>", "Override adapter binary path")
    .option("--model <model>", "Model name or alias")
    .option("--prompt <text>", "Prompt to send to the adapter", "Reply with OK and identify the active model.")
    .option("--resume-session <id>", "Session id to resume before smoke execution")
    .option("--env <entry>", "Extra env KEY=VALUE", collectValues, [])
    .action(async function (
      this: Command,
      adapterType: string,
      options: {
        repo: string
        cwd?: string
        command?: string
        model?: string
        prompt: string
        resumeSession?: string
        env: string[]
      }
    ) {
      const adapter = adapterFrom(adapterType)
      const repoPath = resolve(options.repo)
      const env = parseEnv(options.env)
      if (options.cwd) {
        env.OPENCLAW_SESSION_CWD = resolve(repoPath, options.cwd)
      }

      const result = await adapter.execute(
        buildAdapterSmokeContext({
          adapterType: adapter.type,
          adapterLabel: adapter.label,
          repoPath,
          command: options.command ?? null,
          model: options.model ?? null,
          prompt: options.prompt,
          env,
          sessionId: options.resumeSession ?? null
        })
      )

      writeBlock(io, [
        `adapter: ${adapter.type}`,
        `transport: ${result.metadata?.transport ?? "unknown"}`,
        `repo: ${repoPath}`,
        `ok: ${result.ok ? "yes" : "no"}`,
        `model: ${options.model ?? "default"}`,
        `failure_category: ${result.failureCategory ?? "none"}`,
        `session_display_id: ${result.sessionDisplayId ?? result.continuation?.sessionDisplayId ?? "none"}`
      ])
      writeBlock(io, ["", "Response:", result.response || "(empty)"])

      if (result.error) {
        writeBlock(io, ["", `Error: ${result.error}`])
      }
      const store = storeFrom(this)
      try {
        const project = store.listProjects().find((candidate) => resolve(candidate.repoPath) === repoPath)
        if (project) {
          store.upsertAdapterLaneHealth({
            companyId: project.companyId,
            adapterType: adapter.type,
            laneKey: "adapter-smoke",
            laneLabel: "Adapter smoke",
            status: result.ok ? "healthy" : "degraded",
            reason: result.ok ? null : (result.error ?? result.stderr ?? "Adapter smoke failed"),
            lastError: result.ok ? null : (result.error ?? result.stderr ?? "Adapter smoke failed"),
            lastSuccessAt: result.ok ? new Date().toISOString() : null,
            metadata: {
              model: options.model ?? null,
              failureCategory: result.failureCategory ?? null,
              provider: result.metadata?.provider ?? null
            }
          })
        }
      } finally {
        store.close()
      }
      if (!result.ok) {
        process.exitCode = 1
      }
    })

  program
    .command("doctor")
    .description("Run the end-to-end operator harness across configured adapter lanes")
    .option("--project <repo>", "Validate against a live repository path instead of a synthetic repo")
    .option("--with-planner", "Run the optional synthetic planner orchestration validation", false)
    .option("--with-recovery", "Run the optional synthetic queue recovery validation", false)
    .option("--json", "Print structured JSON instead of the human-readable summary", false)
    .option("--json-file <path>", "Write the structured JSON report to a file")
    .option("--wrapper-check", "Print wrapper metadata only and skip lane execution", false)
    .action(async function (options: {
      project?: string
      withPlanner: boolean
      withRecovery: boolean
      json: boolean
      jsonFile?: string
      wrapperCheck: boolean
    }) {
      const store = storeFrom(this)
      try {
        if (options.wrapperCheck) {
          writeBlock(io, [
            "dispatcher wrapper: ok",
            `repo: ${process.env.OPENCLAW_DOCTOR_WRAPPER_REPO ?? process.cwd()}`,
            `db: ${process.env.OPENCLAW_DOCTOR_WRAPPER_DB ?? "n/a"}`,
            `framework: ${process.env.OPENCLAW_DOCTOR_WRAPPER_FRAMEWORK ?? "embedded default"}`
          ])
          return
        }

        const report = await runDoctor({
          repoPath: options.project ? resolve(options.project) : null,
          store,
          includePlanner: options.withPlanner,
          includeRecovery: options.withRecovery
        })

        if (options.jsonFile) {
          writeFileSync(resolve(options.jsonFile), `${JSON.stringify(report, null, 2)}\n`, "utf8")
        }

        if (options.json) {
          io.stdout(`${JSON.stringify(report, null, 2)}\n`)
        } else {
          writeBlock(io, renderDoctorSummary(report))
          if (options.jsonFile) {
            io.stdout(`json_report: ${resolve(options.jsonFile)}\n`)
          }
        }

        if (report.exitCode !== 0) {
          process.exitCode = report.exitCode
        }
      } finally {
        store.close()
      }
    })

  program
    .command("sync [targetPath]")
    .description("Import repo-owned .openclaw metadata into the dispatcher runtime")
    .option("--company-name <name>", "Override company name for the imported repo")
    .option("--project-name <name>", "Override project name for the imported repo")
    .option("--verify <command>", "Override project verification command")
    .action(function (
      targetPath = ".",
      options: {
        companyName?: string
        projectName?: string
        verify?: string
      }
    ) {
      const resolvedTargetPath = resolve(targetPath)
      const store = storeFrom(this, DispatcherStore.defaultDbPath(resolvedTargetPath))
      try {
        const summary = syncRepoOwnedOpenclaw({
          targetPath: resolvedTargetPath,
          store,
          companyName: options.companyName ?? null,
          projectName: options.projectName ?? null,
          verifyCommand: options.verify ?? null
        })

        writeBlock(io, [
          `Synchronized repo-owned .openclaw metadata from ${summary.targetPath}`,
          `database: ${summary.dbPath}`,
          `company: ${summary.company.status} (${summary.company.name})`,
          `project: ${summary.project.status} (${summary.project.name})`,
          "",
          "Sources:"
        ])

        for (const source of summary.sources) {
          io.stdout(`- ${source}\n`)
        }

        io.stdout("\nAgents:\n")
        if (summary.agents.length === 0) {
          io.stdout("- none\n")
        } else {
          for (const agent of summary.agents) {
            io.stdout(`- ${agent.status}: ${agent.name}`)
            if (agent.details.length > 0) {
              io.stdout(` (${agent.details.join("; ")})`)
            }
            io.stdout("\n")
          }
        }

        io.stdout("\nPersonas:\n")
        if (summary.personas.length === 0) {
          io.stdout("- none\n")
        } else {
          for (const persona of summary.personas) {
            io.stdout(`- ${persona.status}: ${persona.name}`)
            if (persona.details.length > 0) {
              io.stdout(` (${persona.details.join("; ")})`)
            }
            io.stdout("\n")
          }
        }

        io.stdout("\nJobs:\n")
        if (summary.jobs.length === 0) {
          io.stdout("- none\n")
        } else {
          for (const job of summary.jobs) {
            io.stdout(`- ${job.status}: ${job.name}`)
            if (job.details.length > 0) {
              io.stdout(` (${job.details.join("; ")})`)
            }
            io.stdout("\n")
          }
        }

        io.stdout("\nAutomations:\n")
        if (summary.automations.length === 0) {
          io.stdout("- none\n")
        } else {
          for (const automation of summary.automations) {
            io.stdout(`- ${automation.status}: ${automation.name}`)
            if (automation.details.length > 0) {
              io.stdout(` (${automation.details.join("; ")})`)
            }
            io.stdout("\n")
          }
        }

        io.stdout("\nRouting Rules:\n")
        if (summary.routingRules.length === 0) {
          io.stdout("- none\n")
        } else {
          for (const rule of summary.routingRules) {
            io.stdout(`- ${rule.status}: ${rule.name}`)
            if (rule.details.length > 0) {
              io.stdout(` (${rule.details.join("; ")})`)
            }
            io.stdout("\n")
          }
        }

        io.stdout("\nWorkflows:\n")
        if (summary.workflows.length === 0) {
          io.stdout("- none\n")
        } else {
          for (const workflow of summary.workflows) {
            io.stdout(`- ${workflow.status}: ${workflow.name}`)
            if (workflow.details.length > 0) {
              io.stdout(` (${workflow.details.join("; ")})`)
            }
            io.stdout("\n")
          }
        }

        io.stdout("\nSkipped:\n")
        if (summary.skipped.length === 0) {
          io.stdout("- none\n")
        } else {
          for (const item of summary.skipped) {
            io.stdout(`- ${item}\n`)
          }
        }

        io.stdout("\nCould Not Map:\n")
        if (summary.unmapped.length === 0) {
          io.stdout("- none\n")
        } else {
          for (const item of summary.unmapped) {
            io.stdout(`- ${item}\n`)
          }
        }

        io.stdout("\nWarnings:\n")
        if (summary.warnings.length === 0) {
          io.stdout("- none\n")
        } else {
          for (const warning of summary.warnings) {
            io.stdout(`- ${warning}\n`)
          }
        }
      } finally {
        store.close()
      }
    })

  const profile = program.command("profile").description("Inspect and install repo-agnostic OpenClaw project profiles")
  profile
    .command("list")
    .description("List built-in project profiles")
    .action(() => {
      writeBlock(io, listBuiltInProfileIds())
    })

  profile
    .command("inspect <profileId>")
    .description("Show a built-in project profile")
    .action((profileId: string) => {
      const loaded = loadProjectProfile(profileId)
      writeBlock(io, [
        `profile: ${loaded.profileId}`,
        `display_name: ${loaded.displayName}`,
        `version: ${loaded.version}`,
        `lanes: ${loaded.laneDefinitions.length}`,
        `categories: ${loaded.categoryDefinitions.length}`,
        `response_compression: ${loaded.responsePolicy?.compressionMode ?? "off"}`,
        `jobs: ${loaded.jobDefinitions.map((job) => job.jobId).join(", ")}`
      ])
    })

  profile
    .command("detect [targetPath]")
    .description("Detect the best built-in profile for a repository")
    .action((targetPath = ".") => {
      const resolved = resolve(targetPath)
      const match = bestProfileMatch(resolved)
      if (!match) {
        writeBlock(io, [`No profile match for ${resolved}`])
        return
      }

      writeBlock(io, [`best_profile: ${match.profileId}`, `score: ${match.score}`, "matched_signals:"])
      for (const signal of match.matches) {
        io.stdout(`- ${signal.kind}:${signal.path} (weight=${signal.weight})\n`)
      }
    })

  profile
    .command("install <profileId> [targetPath]")
    .description("Install a built-in project profile into a repo-local .openclaw directory")
    .option("--force", "Overwrite differing generated profile files", false)
    .action((profileId: string, targetPath = ".", options: { force: boolean }) => {
      const resolved = resolve(targetPath)
      const loaded = loadProjectProfile(profileId)
      const result = installProjectProfile(resolved, loaded, { force: options.force })
      writeBlock(io, [
        `Installed profile ${loaded.profileId} into ${resolved}`,
        `written: ${result.written.length}`,
        `kept: ${result.kept.length}`
      ])
      if (result.written.length > 0) {
        io.stdout("\nWritten:\n")
        for (const item of result.written) {
          io.stdout(`- ${item}\n`)
        }
      }
      if (result.kept.length > 0) {
        io.stdout("\nKept:\n")
        for (const item of result.kept) {
          io.stdout(`- ${item}\n`)
        }
      }
    })

  const director = program.command("director").description("Run the repo-agnostic director runtime")
  director
    .command("job <jobId>")
    .description("Run a single director job for a project")
    .requiredOption("--project <ref>", "Project id or name")
    .option("--profile <profileId>", "Explicit profile override")
    .option("--dry-run", "Preview digest payloads instead of sending external notifications", false)
    .option(
      "--full-cycle",
      "For queue-refresh, run persona ideation through execution, review, promotion, and release",
      false
    )
    .option("--wait", "Wait for agent-loop lifecycle events during --full-cycle", false)
    .option("--max-passes <count>", "Maximum full-cycle passes", "8")
    .option("--json", "Print structured JSON for --full-cycle", false)
    .action(async function (
      jobId: JobId,
      options: {
        project: string
        profile?: string
        dryRun: boolean
        fullCycle: boolean
        wait: boolean
        maxPasses: string
        json: boolean
      }
    ) {
      const store = storeFrom(this)
      try {
        const runtime = new DirectorRuntime(store, executorFrom(store))
        if (jobId === "queue-refresh" && options.fullCycle) {
          const report = await runtime.runQueueRefreshFullCycle(options.project, {
            profileId: options.profile ?? null,
            maxPasses: Number.parseInt(options.maxPasses, 10) || 8,
            waitForLoops: options.wait
          })
          if (options.json) {
            io.stdout(`${JSON.stringify(report, null, 2)}\n`)
          } else {
            writeQueueRefreshFullCycleReport(io, report)
          }
          return
        }

        const result =
          jobId === "daily-telegram-digest" && options.dryRun
            ? await (async () => {
                const digest = await runtime.sendDigest(options.project, {
                  profileId: options.profile ?? null,
                  kind: "daily",
                  dryRun: true
                })
                return {
                  jobId,
                  profileId:
                    options.profile ??
                    bestProfileMatch(store.resolveProject(options.project).repoPath)?.profileId ??
                    "unknown",
                  resultSummary: digest.resultSummary,
                  digest
                }
              })()
            : await runtime.runJob(options.project, jobId, options.profile ?? null)
        writeBlock(io, [`job: ${result.jobId}`, `profile: ${result.profileId}`, `result: ${result.resultSummary}`])
        if ("queueRefresh" in result && result.queueRefresh) {
          writeBlock(io, [
            "",
            `queue_refresh.created_workflows=${result.queueRefresh.createdWorkflows}`,
            `queue_refresh.created_tasks=${result.queueRefresh.createdTasks}`,
            `queue_refresh.consumed_handoffs=${result.queueRefresh.consumedHandoffs}`,
            `queue_refresh.planner_run_id=${result.queueRefresh.plannerRunId ?? "none"}`,
            `queue_refresh.planner_created_tasks=${result.queueRefresh.plannerCreatedTasks ?? 0}`,
            `queue_refresh.recovery_detected=${result.queueRefresh.recoverySummary?.detected ?? 0}`,
            `queue_refresh.recovery_repaired=${result.queueRefresh.recoverySummary?.repaired ?? 0}`,
            `queue_refresh.personas_synced=${result.queueRefresh.personasSynced}`,
            `queue_refresh.jobs_synced=${result.queueRefresh.jobsSynced}`,
            `queue_refresh.routing_rules_synced=${result.queueRefresh.routingRulesSynced}`
          ])
        }
        if ("tickSummary" in result && result.tickSummary) {
          writeBlock(io, [
            "",
            `tick.executed_runs=${result.tickSummary.executedRuns}`,
            `tick.blocked_tasks=${result.tickSummary.blockedTasks}`,
            `tick.skipped_tasks=${result.tickSummary.skippedTasks}`,
            `tick.follow_up_tasks=${result.tickSummary.followUpTasks}`,
            `tick.executed_jobs=${result.tickSummary.executedJobs}`,
            `tick.created_review_tasks=${result.tickSummary.createdReviewTasks}`
          ])
        }
        if (result.digest) {
          writeBlock(io, [
            "",
            `digest.delivery=${result.digest.delivery}`,
            `digest.kind=${result.digest.kind}`,
            `digest.window_hours=${result.digest.summary.windowHours}`,
            "",
            result.digest.message
          ])
        }
      } finally {
        store.close()
      }
    })

  director
    .command("digest")
    .description("Preview or send a Telegram ops digest for a project")
    .requiredOption("--project <ref>", "Project id or name")
    .option("--profile <profileId>", "Explicit profile override")
    .option("--kind <kind>", "Digest kind: daily or incident", "daily")
    .option("--hours <n>", "Lookback window in hours")
    .option("--send", "Send to Telegram instead of previewing locally", false)
    .action(async function (options: {
      project: string
      profile?: string
      kind: "daily" | "incident"
      hours?: string
      send: boolean
    }) {
      const store = storeFrom(this)
      try {
        const runtime = new DirectorRuntime(store, executorFrom(store))
        const parsedHours = options.hours ? Number.parseInt(options.hours, 10) || undefined : undefined
        const digest = await runtime.sendDigest(
          options.project,
          parsedHours === undefined
            ? {
                profileId: options.profile ?? null,
                kind: options.kind === "incident" ? "incident" : "daily",
                dryRun: !options.send
              }
            : {
                profileId: options.profile ?? null,
                kind: options.kind === "incident" ? "incident" : "daily",
                dryRun: !options.send,
                windowHours: parsedHours
              }
        )
        writeBlock(io, [
          `digest.delivery=${digest.delivery}`,
          `digest.kind=${digest.kind}`,
          `digest.window_hours=${digest.summary.windowHours}`,
          `digest.tasks_completed=${digest.summary.tasksCompleted}`,
          `digest.tasks_failed=${digest.summary.tasksFailed}`,
          "",
          digest.message
        ])
      } finally {
        store.close()
      }
    })

  director
    .command("cycle")
    .description("Run the auditable profile-aware director loop")
    .requiredOption("--project <ref>", "Project id or name")
    .option("--profile <profileId>", "Explicit profile override")
    .option("--autonomous", "Repeat queue refresh + tick until work settles", false)
    .option("--dry-run", "Record and print the next director decision without mutating queue/runtime state", false)
    .option("--max-passes <count>", "Maximum autonomous passes", "6")
    .option("--autonomous-turns <count>", "Maximum self-prompt turns per agent run", "4")
    .option("--risk-threshold <score>", "Pause when risk score reaches this threshold", "80")
    .option("--quota-limit <count>", "Maximum mutating director actions in one cycle", "20")
    .action(async function (options: {
      project: string
      profile?: string
      autonomous: boolean
      dryRun: boolean
      maxPasses: string
      autonomousTurns: string
      riskThreshold: string
      quotaLimit: string
    }) {
      const store = storeFrom(this)
      try {
        const runtime = new DirectorRuntime(store, executorFrom(store))
        const maxPasses = Number.parseInt(options.maxPasses, 10) || 6
        const autonomousTurns = Number.parseInt(options.autonomousTurns, 10) || 4
        await withAutonomousExecutionEnv(autonomousTurns, async () => {
          const report = await runtime.runAutonomousCycle(options.project, {
            profileId: options.profile ?? null,
            autonomous: options.autonomous,
            dryRun: options.dryRun,
            maxPasses,
            riskThreshold: Number.parseInt(options.riskThreshold, 10) || 80,
            quotaLimit: Number.parseInt(options.quotaLimit, 10) || 20
          })
          writeDirectorReport(io, report)
        })
      } finally {
        store.close()
      }
    })

  director
    .command("explain")
    .description("Explain an auditable director decision")
    .option("--last", "Explain the latest director decision", false)
    .option("--project <ref>", "Restrict --last to a project id or name")
    .action(function (options: { last: boolean; project?: string }) {
      const store = storeFrom(this)
      try {
        if (!options.last) {
          throw new Error("Pass --last to explain the latest director decision.")
        }
        const project = options.project ? store.resolveProject(options.project) : null
        writeDirectorExplanation(io, store.getLatestDirectorDecision(project?.id ?? null))
      } finally {
        store.close()
      }
    })

  const orchestra = program.command("orchestra").description("Genericized Codex orchestra artifact generation")
  orchestra
    .command("plan")
    .description("Scaffold task-package, plan, manifest, and reviewer handoff artifacts")
    .requiredOption("--project <ref>", "Project id or name")
    .option("--task <taskId>", "Existing task id to seed the plan from")
    .option("--prompt <text>", "Prompt text for the orchestra run")
    .option("--output-dir <path>", "Output directory", ".codex/orchestra-runs/manual")
    .option("--subagents <n>", "Planned subagent count", "3")
    .action(function (options: {
      project: string
      task?: string
      prompt?: string
      outputDir: string
      subagents: string
    }) {
      const store = storeFrom(this)
      try {
        const project = store.resolveProject(options.project)
        const task = options.task ? store.getTaskById(options.task) : null
        const prompt = options.prompt ?? task?.title ?? "Scaffold a generic OpenClaw orchestra run"
        const result = scaffoldCodexOrchestra({
          prompt,
          taskId: task?.id ?? "manual",
          lane: task?.laneId ?? task?.taskPackage?.likelyOwnershipLane ?? "general",
          outputDir: resolve(project.repoPath, options.outputDir),
          taskPackage: task?.taskPackage ?? null,
          subagents: Number.parseInt(options.subagents, 10) || 3
        })
        writeBlock(io, [
          `orchestra output: ${result.outputDir}`,
          `branch_hint: ${result.plan.branchHint}`,
          `subtasks: ${result.plan.subtasks.length}`,
          `manifest_status: ${result.manifest.status}`
        ])
      } finally {
        store.close()
      }
    })

  const state = program.command("state").description("Repair and maintain runtime state")
  state
    .command("backup")
    .description("Backup the dispatcher SQLite runtime database")
    .option("--output <path>", "Backup output path")
    .option("--json", "Print backup metadata as JSON", false)
    .action(function (options: { output?: string; json: boolean }) {
      const store = storeFrom(this)
      try {
        const backup = store.backupRuntimeState(options.output ? resolve(options.output) : undefined)
        if (options.json) {
          writeBlock(io, [JSON.stringify(backup, null, 2)])
          return
        }
        writeBlock(io, [`backup: ${backup.backupPath}`])
      } finally {
        store.close()
      }
    })

  const db = program.command("db").description("Database maintenance")
  db.command("backup")
    .description("Backup the dispatcher SQLite runtime database")
    .option("--output <path>", "Backup output path")
    .option("--json", "Print backup metadata as JSON", false)
    .action(function (options: { output?: string; json: boolean }) {
      const store = storeFrom(this)
      try {
        const backup = store.backupRuntimeState(options.output ? resolve(options.output) : undefined)
        if (options.json) {
          writeBlock(io, [JSON.stringify(backup, null, 2)])
          return
        }
        writeBlock(io, [`backup: ${backup.backupPath}`])
      } finally {
        store.close()
      }
    })

  db.command("compact")
    .description("Deduplicate activity, bound oversized run and task events, and reclaim SQLite space")
    .option("--dry-run", "Report duplicate activity rows without deleting them", false)
    .option("--no-backup", "Skip the automatic database backup")
    .option("--no-vacuum", "Skip VACUUM after deleting duplicate activity")
    .option("--max-run-event-bytes <num>", "Maximum persisted JSON bytes for each run event")
    .option("--max-run-text-bytes <num>", "Maximum persisted bytes for each run response or error field")
    .option("--json", "Print compaction metadata as JSON", false)
    .action(function (options: {
      dryRun: boolean
      backup: boolean
      vacuum: boolean
      maxRunEventBytes?: string
      maxRunTextBytes?: string
      json: boolean
    }) {
      const store = storeFrom(this)
      try {
        const maxRunEventBytes =
          options.maxRunEventBytes === undefined ? undefined : Number.parseInt(options.maxRunEventBytes, 10)
        const maxRunTextBytes =
          options.maxRunTextBytes === undefined ? undefined : Number.parseInt(options.maxRunTextBytes, 10)
        const result = store.compactRuntimeActivity({
          dryRun: options.dryRun,
          backup: options.dryRun ? false : options.backup,
          vacuum: options.vacuum,
          ...(maxRunEventBytes === undefined ? {} : { maxRunEventBytes }),
          ...(maxRunTextBytes === undefined ? {} : { maxRunTextBytes })
        })
        if (options.json) {
          writeBlock(io, [JSON.stringify(result, null, 2)])
          return
        }
        writeBlock(io, [
          `dry_run: ${result.dryRun}`,
          `backup: ${result.backup?.backupPath ?? "none"}`,
          `vacuumed: ${result.vacuumed}`,
          "removed:",
          `- run_events: ${result.removed.runEvents}`,
          `- task_events: ${result.removed.taskEvents}`,
          `- planner_events: ${result.removed.plannerEvents}`,
          `bounded_run_events: ${result.boundedRunEvents}`,
          `bounded_task_events: ${result.boundedTaskEvents}`,
          `max_run_event_bytes: ${result.maxRunEventBytes}`,
          `bounded_run_text_fields: ${result.boundedRunTextFields}`,
          `max_run_text_bytes: ${result.maxRunTextBytes}`,
          `compacted_run_metadata: ${result.compactedRunMetadata}`,
          `pages_before: ${result.before.pageCount}`,
          `free_pages_before: ${result.before.freelistCount}`,
          `pages_after: ${result.after.pageCount}`,
          `free_pages_after: ${result.after.freelistCount}`
        ])
      } finally {
        store.close()
      }
    })

  const worktree = program.command("worktree").description("Manage isolated execution workspaces")
  worktree
    .command("quarantine")
    .description("Pause project automations and release running work for an execution workspace")
    .requiredOption("--project <ref>", "Project id or name")
    .option("--path <path>", "Only cancel running runs for this worktree path")
    .action(function (options: { project: string; path?: string }) {
      const store = storeFrom(this)
      try {
        const result = store.quarantineExecutionWorkspace({
          projectRef: options.project,
          worktreePath: options.path ? resolve(options.path) : null
        })
        writeBlock(io, [
          "Workspace quarantined.",
          `project_id: ${result.projectId}`,
          `worktree_path: ${result.worktreePath ?? "all"}`,
          `paused_automations: ${result.pausedAutomations}`,
          `cancelled_runs: ${result.cancelledRuns}`,
          `requeued_tasks: ${result.requeuedTasks}`
        ])
      } finally {
        store.close()
      }
    })

  state
    .command("legacy-backup")
    .description("Backup the dispatcher SQLite runtime database with the legacy core helper")
    .action(function () {
      const store = storeFrom(this)
      try {
        writeBlock(io, [`backup: ${backupRuntimeState(store)}`])
      } finally {
        store.close()
      }
    })

  state
    .command("reset-runtime")
    .description("Clear volatile runtime state while keeping long-lived config")
    .option("--apply", "Confirm the destructive runtime reset", false)
    .action(function (options: { apply?: boolean }) {
      if (options.apply !== true) {
        throw new Error("Refusing to reset runtime state without explicit --apply confirmation.")
      }
      const store = storeFrom(this)
      try {
        const result = resetRuntimeState(store)
        writeBlock(io, [`backup: ${result.backupPath}`, "cleared_tables:"])
        for (const [table, count] of Object.entries(result.clearedTables)) {
          io.stdout(`- ${table}: ${count}\n`)
        }
      } finally {
        store.close()
      }
    })

  state
    .command("prune-duplicates")
    .description("Recover older untouched duplicate queued workflows")
    .action(function () {
      const store = storeFrom(this)
      try {
        const result = pruneDuplicateQueuedWorkflows(store)
        writeBlock(io, [
          `duplicate_workflows_recovered: ${result.duplicateWorkflowsRecovered}`,
          `duplicate_tasks_recovered: ${result.duplicateTasksRecovered}`
        ])
      } finally {
        store.close()
      }
    })

  state
    .command("archive-blocked")
    .description("Archive old blocked tasks as failed while preserving their audit history")
    .option("--company <ref>", "Company id or name")
    .option("--project <ref>", "Project id or name")
    .option("--older-than-hours <hours>", "Only archive tasks older than this many hours", "24")
    .option("--apply", "Apply the archival; otherwise show a dry run", false)
    .action(function (options: { company?: string; project?: string; olderThanHours: string; apply: boolean }) {
      const store = storeFrom(this)
      try {
        const project = options.project ? store.resolveProject(options.project, options.company ?? null) : null
        const company = options.company ? store.resolveCompany(options.company) : null
        const olderThanHours = Number.parseFloat(options.olderThanHours)
        if (!Number.isFinite(olderThanHours) || olderThanHours < 1) {
          throw new Error("--older-than-hours must be at least 1")
        }
        const companyId = project?.companyId ?? company?.id
        const result = archiveHistoricalBlockedTasks(store, {
          ...(companyId ? { companyId } : {}),
          ...(project?.id ? { projectId: project.id } : {}),
          olderThanHours,
          dryRun: !options.apply
        })
        writeBlock(io, [
          `dry_run: ${result.dryRun}`,
          `cutoff: ${result.cutoff}`,
          `candidates: ${result.candidateTaskIds.length}`,
          `archived: ${result.archivedTaskIds.length}`,
          `skipped_active: ${result.skippedActiveTaskIds.length}`
        ])
      } finally {
        store.close()
      }
    })

  state
    .command("diagnose-queue-health")
    .description("Dry-run diagnosis of stale claims, stale runs, zombie agents, and planner lineage issues")
    .option("--company <ref>", "Company id or name")
    .option("--project <ref>", "Project id or name")
    .action(function (options: { company?: string; project?: string }) {
      const store = storeFrom(this)
      try {
        const project = options.project ? store.resolveProject(options.project, options.company ?? null) : null
        const company = options.company ? store.resolveCompany(options.company) : null
        const scopedCompanyId = project?.companyId ?? company?.id
        const summary = diagnoseQueueHealth(store, {
          ...(scopedCompanyId ? { companyId: scopedCompanyId } : {}),
          ...(project?.id ? { projectId: project.id } : {})
        })
        writeQueueHealth(io, summary)
      } finally {
        store.close()
      }
    })

  state
    .command("recover-stale-runs")
    .description("Recover stale queue health issues, including runs, claims, zombie agents, and planner runs")
    .option("--company <ref>", "Company id or name")
    .option("--project <ref>", "Project id or name")
    .action(function (options: { company?: string; project?: string }) {
      const store = storeFrom(this)
      try {
        const project = options.project ? store.resolveProject(options.project, options.company ?? null) : null
        const company = options.company ? store.resolveCompany(options.company) : null
        const scopedCompanyId = project?.companyId ?? company?.id
        const summary = repairQueueHealth(store, {
          ...(scopedCompanyId ? { companyId: scopedCompanyId } : {}),
          ...(project?.id ? { projectId: project.id } : {})
        })
        writeQueueHealth(io, summary)
        writeBlock(io, ["", `recovered_runs: ${summary.counts.staleRuns}`])
      } finally {
        store.close()
      }
    })

  const jobs = program.command("jobs").description("Inspect recurring dispatcher jobs")
  jobs
    .command("list")
    .description("List imported recurring job specs")
    .option("--company <ref>", "Company id or name")
    .action(function (options: { company?: string }) {
      const store = storeFrom(this)
      try {
        const company = options.company ? store.resolveCompany(options.company) : null
        const jobSpecs = store.listJobSpecs(company?.id)
        if (jobSpecs.length === 0) {
          writeBlock(io, ["No imported job specs found."])
          return
        }

        writeBlock(
          io,
          jobSpecs.map((job) => {
            const project = store.getProjectById(job.projectId)
            return [
              `${project.name} | ${job.jobId}`,
              `cron=${job.cron}`,
              `tz=${job.timezone}`,
              `next_due=${nextDueAt(job) ?? "n/a"}`,
              `last_run=${job.lastTriggeredAt ?? "never"}`,
              `last_result=${job.lastResult ?? "n/a"}`
            ].join(" | ")
          })
        )
      } finally {
        store.close()
      }
    })

  const company = program.command("company").description("Manage companies")
  company
    .command("create <name>")
    .description("Create a company")
    .option("--description <description>", "Optional company description")
    .action(function (name: string, options: { description?: string }) {
      const store = storeFrom(this)
      try {
        const created = store.createCompany({
          name,
          description: options.description ?? null
        })
        writeBlock(io, [`Created company ${created.name}`, `id: ${created.id}`])
      } finally {
        store.close()
      }
    })

  company
    .command("list")
    .description("List companies")
    .action(function () {
      const store = storeFrom(this)
      try {
        const companies = store.listCompanies()
        if (companies.length === 0) {
          writeBlock(io, ["No companies found."])
          return
        }
        writeBlock(
          io,
          companies.map((entry) => {
            const projects = store.listProjects(entry.id).length
            const agents = store.listAgents(entry.id).length
            return `${entry.name} | id=${entry.id} | projects=${projects} | agents=${agents}`
          })
        )
      } finally {
        store.close()
      }
    })

  const project = program.command("project").description("Manage projects")
  project
    .command("add <name>")
    .description("Add a project")
    .requiredOption("--repo-path <path>", "Path to the project repository")
    .option("--verify <command>", "Verification command to run after each successful agent run")
    .option("--company <ref>", "Company id or name")
    .action(function (
      name: string,
      options: {
        repoPath: string
        verify?: string
        company?: string
      }
    ) {
      const store = storeFrom(this)
      try {
        const created = store.createProject({
          companyRef: options.company ?? null,
          name,
          repoPath: options.repoPath,
          verifyCommand: options.verify ?? null
        })
        writeBlock(io, [`Added project ${created.name}`, `id: ${created.id}`, `repo: ${created.repoPath}`])
      } finally {
        store.close()
      }
    })

  project
    .command("list")
    .description("List projects")
    .option("--company <ref>", "Company id or name")
    .action(function (options: { company?: string }) {
      const store = storeFrom(this)
      try {
        const companyRecord = options.company ? store.resolveCompany(options.company) : null
        const projects = store.listProjects(companyRecord?.id)
        if (projects.length === 0) {
          writeBlock(io, ["No projects found."])
          return
        }
        writeBlock(
          io,
          projects.map((entry) => {
            const tasks = store.listProjectTasks(entry.id)
            const repositories = store.listRepositories(entry.id)
            const active = tasks.filter((task) => task.status !== "done" && task.status !== "failed").length
            return `${entry.name} | id=${entry.id} | company=${entry.companyId} | repos=${repositories.length} | active_tasks=${active} | repo=${entry.repoPath}`
          })
        )
      } finally {
        store.close()
      }
    })

  const milestone = program.command("milestone").description("Manage milestones")
  milestone
    .command("create <name>")
    .description("Create a project milestone")
    .requiredOption("--project <ref>", "Project id or name")
    .option("--description <description>", "Milestone description")
    .option("--target-date <date>", "Target date, ideally YYYY-MM-DD")
    .action(function (
      name: string,
      options: {
        project: string
        description?: string
        targetDate?: string
      }
    ) {
      const store = storeFrom(this)
      try {
        const created = store.createMilestone({
          projectRef: options.project,
          name,
          description: options.description ?? null,
          targetDate: options.targetDate ?? null,
          status: "active"
        })
        writeBlock(io, [
          `Created milestone ${created.name}`,
          `id: ${created.id}`,
          `status: ${created.status}`,
          `target_date: ${created.targetDate ?? "n/a"}`
        ])
      } finally {
        store.close()
      }
    })

  const goal = program.command("goal").description("Manage goals")
  goal
    .command("create <title>")
    .description("Create a goal and generate its task tree")
    .requiredOption("--project <ref>", "Project id or name")
    .option("--description <description>", "Goal description")
    .option("--milestone <ref>", "Milestone id or name")
    .option("--product-area <ref>", "Product area id or name")
    .option("--task <title>", "Repeatable task title for the generated tree", collectValues, [])
    .option("--priority <value>", "Goal priority", "0")
    .action(function (
      title: string,
      options: {
        project: string
        description?: string
        milestone?: string
        productArea?: string
        task: string[]
        priority: string
      }
    ) {
      const store = storeFrom(this)
      try {
        const created = store.createGoal({
          projectRef: options.project,
          milestoneRef: options.milestone ?? null,
          productAreaRef: options.productArea ?? null,
          title,
          description: options.description ?? null,
          taskTitles: options.task,
          priority: Number.parseInt(options.priority, 10) || 0
        })
        const tasks = store.listProjectTasks(created.projectId).filter((task) => task.goalId === created.id)
        writeBlock(io, [
          `Created goal ${created.title}`,
          `id: ${created.id}`,
          `status: ${created.status}`,
          `root_task: ${created.rootTaskId ?? "n/a"}`,
          `generated_tasks: ${tasks.length}`
        ])
        for (const task of tasks) {
          io.stdout(`- ${task.kind} | ${task.status} | ${task.title}\n`)
        }
      } finally {
        store.close()
      }
    })

  const agent = program.command("agent").description("Manage agents")
  agent
    .command("wait <runId>")
    .description("Wait for an accepted agent run to reach a terminal lifecycle")
    .option("--timeout-ms <ms>", "Wait timeout in milliseconds", "30000")
    .option("--poll-ms <ms>", "Polling interval in milliseconds", "250")
    .action(async function (runId: string, options: { timeoutMs: string; pollMs: string }) {
      const store = storeFrom(this)
      try {
        const timeoutMs = Number.parseInt(options.timeoutMs, 10)
        const pollMs = Number.parseInt(options.pollMs, 10)
        const waitOptions: { timeoutMs?: number; pollMs?: number } = {}
        if (Number.isFinite(timeoutMs)) waitOptions.timeoutMs = timeoutMs
        if (Number.isFinite(pollMs)) waitOptions.pollMs = pollMs
        const result = await waitForAgentRun(store, runId, waitOptions)
        io.stdout(`${JSON.stringify(result, null, 2)}\n`)
      } finally {
        store.close()
      }
    })

  agent
    .command("events <runId>")
    .description("Print structured lifecycle, assistant, and tool stream events for a run")
    .action(function (runId: string) {
      const store = storeFrom(this)
      try {
        io.stdout(`${JSON.stringify({ runId, events: readAgentLoopEvents(store, runId) }, null, 2)}\n`)
      } finally {
        store.close()
      }
    })

  agent
    .command("add <name>")
    .description("Add an agent")
    .requiredOption("--role <role>", "Agent role or title")
    .requiredOption("--adapter <type>", "Adapter type: codex_local, gemini_local, or azure_foundry")
    .option("--company <ref>", "Company id or name")
    .option("--model <model>", "Model identifier")
    .option("--instructions <path>", "Instructions file to prepend to prompts")
    .option("--command <path>", "Override executable path for tests or custom installs")
    .option("--env <entry>", "Environment variable in KEY=VALUE format", collectValues, [])
    .option("--pause", "Create the agent in paused state", false)
    .option("--heartbeat-interval <seconds>", "Heartbeat interval in seconds", "300")
    .option("--budget-limit <units>", "Budget limit in usage units")
    .option("--budget-window <kind>", "Budget window kind: daily or monthly", "monthly")
    .action(function (
      name: string,
      options: {
        role: string
        adapter: AdapterType
        company?: string
        model?: string
        instructions?: string
        command?: string
        env: string[]
        pause: boolean
        heartbeatInterval: string
        budgetLimit?: string
        budgetWindow: "daily" | "monthly"
      }
    ) {
      const store = storeFrom(this)
      try {
        const created = store.createAgent({
          companyRef: options.company ?? null,
          name,
          role: options.role,
          adapterType: options.adapter,
          model: options.model ?? null,
          instructionsPath: options.instructions ?? null,
          command: options.command ?? null,
          env: parseEnv(options.env),
          status: options.pause ? "paused" : "idle",
          heartbeatIntervalSec: Number.parseInt(options.heartbeatInterval, 10),
          budgetLimit: options.budgetLimit ? Number.parseInt(options.budgetLimit, 10) : null,
          budgetWindow: options.budgetWindow
        })
        writeBlock(io, [
          `Added agent ${created.name}`,
          `id: ${created.id}`,
          `adapter: ${created.adapterType}`,
          `status: ${created.status}`
        ])
      } finally {
        store.close()
      }
    })

  const prompt = program.command("prompt").description("Render Codex-ready prompts")
  prompt
    .command("render")
    .description("Render a Codex-ready prompt from an existing task package or ad hoc task details")
    .option("--task <taskId>", "Existing task id to render")
    .option("--title <title>", "Ad hoc task title")
    .option("--project <ref>", "Project id or name for ad hoc rendering")
    .option("--persona <ref>", "Persona id or name for ad hoc rendering, or override for --task")
    .option("--description <description>", "Ad hoc task description")
    .option("--label <label>", "Repeatable ad hoc task label", collectValues, [])
    .option("--changed-file <path>", "Repeatable ad hoc changed-file hint", collectValues, [])
    .option("--template <id>", "Prompt template id")
    .option("--profile <profileId>", "Built-in project profile override")
    .action(function (options: {
      task?: string
      title?: string
      project?: string
      persona?: string
      description?: string
      label: string[]
      changedFile: string[]
      template?: string
      profile?: string
    }) {
      const template = parsePromptTemplate(options.template)
      const store = storeFrom(this)
      try {
        if (options.task) {
          const taskRecord = store.getTaskById(options.task)
          const projectRecord = store.getProjectById(taskRecord.projectId)
          const profileRecord = loadPromptProjectProfile(projectRecord, options.profile ?? null)
          const taskLane = taskRecord.laneId ?? taskRecord.taskPackage?.likelyOwnershipLane ?? null
          const personaRecord = options.persona
            ? store.resolvePersona(options.persona, projectRecord.companyId)
            : taskRecord.personaId
              ? store.getPersonaById(taskRecord.personaId)
              : taskRecord.stage
                ? store.findPersonaByStage(projectRecord.companyId, taskRecord.stage)
                : null
          const personaInput = personaRecord
            ? promptPersonaFromPersona(personaRecord)
            : fallbackPromptPersona({ stage: taskRecord.stage, laneId: taskLane })

          io.stdout(
            renderCodexPrompt(
              promptInputFromTask({
                task: taskRecord,
                project: projectRecord,
                persona: personaInput,
                profile: profileRecord,
                template
              })
            )
          )
          return
        }

        if (!options.title || !options.project || !options.persona) {
          throw new Error("Use either --task <taskId> or provide --title, --project, and --persona.")
        }

        const projectRecord = store.resolveProject(options.project)
        const personaRecord = store.resolvePersona(options.persona, projectRecord.companyId)
        const profileRecord = loadPromptProjectProfile(projectRecord, options.profile ?? null)
        const taskPackage = buildTaskPackage({
          title: options.title,
          description: options.description ?? null,
          labels: options.label,
          changedFiles: options.changedFile,
          requestedAdapterType: personaRecord.preferredAdapterType,
          assignedAgentAdapterType: null,
          repoContext: detectRepoContext(projectRecord.repoPath, projectRecord.verifyCommand),
          repoPath: projectRecord.repoPath,
          verifyCommand: projectRecord.verifyCommand
        })

        io.stdout(
          renderCodexPrompt({
            title: options.title,
            description: options.description ?? null,
            labels: options.label,
            changedFiles: options.changedFile,
            taskPackage,
            taskId: null,
            taskKind: null,
            laneId: taskPackage.likelyOwnershipLane,
            project: projectRecord,
            persona: promptPersonaFromPersona(personaRecord),
            profile: profileRecord,
            template
          })
        )
      } finally {
        store.close()
      }
    })

  const persona = program.command("persona").description("Manage personas")
  persona
    .command("sync-openclaw")
    .description("Provision runtime personas as native OpenClaw agents")
    .requiredOption("--project <ref>", "Project id or name")
    .option("--openclaw-command <path>", "OpenClaw CLI path")
    .option("--workspace-root <path>", "Root directory for native persona workspaces")
    .option("--model <provider/model>", "Default model for newly created native agents", "openai/gpt-5.4")
    .option(
      "--enable-handoffs",
      "Allow main/planner fan-out across the roster and worker handoff to the canonical reviewer",
      false
    )
    .option("--dry-run", "Report changes without creating agents or writing workspaces", false)
    .action(function (options: {
      project: string
      openclawCommand?: string
      workspaceRoot?: string
      model: string
      enableHandoffs: boolean
      dryRun: boolean
    }) {
      const store = storeFrom(this)
      try {
        const projectRecord = store.resolveProject(options.project)
        const personas = store.listPersonas(projectRecord.companyId).filter((entry) => entry.status === "active")
        const result = syncOpenClawNativePersonas({
          personas,
          projectName: projectRecord.name,
          openclawCommand: options.openclawCommand,
          workspaceRoot: options.workspaceRoot ? resolve(options.workspaceRoot) : undefined,
          model: options.model,
          apply: !options.dryRun,
          enableHandoffs: options.enableHandoffs
        })
        writeBlock(io, [
          `project: ${projectRecord.name}`,
          `mode: ${options.dryRun ? "dry-run" : "applied"}`,
          `requested_agents: ${result.requestedAgentIds.length}`,
          `existing_agents: ${result.existingAgentIds.length}`,
          `created_agents: ${result.createdAgentIds.join(", ") || "none"}`,
          `updated_workspaces: ${result.updatedWorkspaceIds.join(", ") || "none"}`,
          `subagent_policy_updated: ${result.subagentPolicyUpdated ? "yes" : "no"}`,
          ...(result.workspaceMismatches.length > 0
            ? [
                "workspace_mismatches:",
                ...result.workspaceMismatches.map(
                  (entry) => `- ${entry.agentId}: configured=${entry.configured} expected=${entry.expected}`
                )
              ]
            : [])
        ])
      } finally {
        store.close()
      }
    })

  persona
    .command("add <name>")
    .description("Add a persona")
    .requiredOption("--stage <stage>", "Persona stage: planner, coder, reviewer, promoter")
    .requiredOption("--adapter <type>", "Preferred adapter: codex_local, gemini_local, or azure_foundry")
    .option("--company <ref>", "Company id or name")
    .option("--instructions <path>", "Optional persona instructions file")
    .option("--owned-lane <lane>", "Repeatable owned lane", collectValues, [])
    .option("--pause", "Create the persona paused", false)
    .option("--budget-limit <units>", "Budget limit in usage units")
    .option("--budget-window <kind>", "Budget window kind: daily or monthly", "monthly")
    .action(function (
      name: string,
      options: {
        stage: "planner" | "coder" | "reviewer" | "promoter"
        adapter: AdapterType
        company?: string
        instructions?: string
        ownedLane: string[]
        pause: boolean
        budgetLimit?: string
        budgetWindow: "daily" | "monthly"
      }
    ) {
      const store = storeFrom(this)
      try {
        const created = store.createPersona({
          companyRef: options.company ?? null,
          name,
          stage: options.stage,
          ownedLanes: options.ownedLane,
          preferredAdapterType: options.adapter,
          instructionsPath: options.instructions ?? null,
          status: options.pause ? "paused" : "active",
          budgetLimit: options.budgetLimit ? Number.parseInt(options.budgetLimit, 10) : null,
          budgetWindow: options.budgetWindow
        })
        writeBlock(io, [
          `Added persona ${created.name}`,
          `id: ${created.id}`,
          `stage: ${created.stage}`,
          `adapter: ${created.preferredAdapterType}`,
          `status: ${created.status}`
        ])
      } finally {
        store.close()
      }
    })

  persona
    .command("list")
    .description("List built-in or project-profile personas")
    .option("--company <ref>", "Company id or name")
    .option("--profile <profileId>", "Apply project profile persona overrides")
    .option("--runtime", "List runtime personas from the dispatcher database", false)
    .action(function (options: { company?: string; profile?: string; runtime: boolean }) {
      if (!options.runtime) {
        const personas = loadProjectProfilePersonas(options.profile ?? null)
        writeBlock(io, personas.map(renderPersonaSummary))
        return
      }

      const store = storeFrom(this)
      try {
        const company = options.company ? store.resolveCompany(options.company) : null
        const personas = store.listPersonas(company?.id)
        if (personas.length === 0) {
          writeBlock(io, ["No personas found."])
          return
        }

        writeBlock(
          io,
          personas.map(
            (entry) =>
              `${entry.name} | stage=${entry.stage} | adapter=${entry.preferredAdapterType} | status=${entry.status} | lanes=${entry.ownedLanes.join(", ") || "none"}`
          )
        )
      } finally {
        store.close()
      }
    })

  persona
    .command("report")
    .description("Report runtime persona task distribution for a project")
    .requiredOption("--project <ref>", "Project id or name")
    .option("--limit <n>", "Number of recent tasks to inspect", "200")
    .action(function (options: { project: string; limit: string }) {
      const store = storeFrom(this)
      try {
        const project = store.resolveProject(options.project)
        const limit = Number.parseInt(options.limit, 10) || 200
        const tasks = store.listProjectTasks(project.id).slice(-Math.max(1, limit))
        const byPersona = new Map<string, number>()
        const byBucket = new Map<string, number>()
        for (const task of tasks) {
          let persona = task.taskPackage?.personaProvenance?.personaId ?? null
          if (!persona && task.personaId) {
            try {
              persona = store.getPersonaById(task.personaId).name
            } catch {
              persona = task.personaId
            }
          }
          persona ??= "unassigned"
          const bucket =
            task.taskPackage?.portfolioBucket ??
            task.labels.find((label) => label.startsWith("bucket:"))?.slice("bucket:".length) ??
            "unassigned"
          byPersona.set(persona, (byPersona.get(persona) ?? 0) + 1)
          byBucket.set(bucket, (byBucket.get(bucket) ?? 0) + 1)
        }
        writeBlock(io, [
          `project: ${project.name}`,
          `inspected_tasks: ${tasks.length}`,
          "by_persona:",
          ...Array.from(byPersona.entries()).map(([personaId, count]) => `- ${personaId}: ${count}`),
          "by_bucket:",
          ...Array.from(byBucket.entries()).map(([bucket, count]) => `- ${bucket}: ${count}`)
        ])
      } finally {
        store.close()
      }
    })

  persona
    .command("show <id>")
    .description("Show a built-in or project-profile persona")
    .option("--profile <profileId>", "Apply project profile persona overrides")
    .option("--runtime", "Show a runtime persona from the dispatcher database", false)
    .option("--company <ref>", "Company id or name for --runtime")
    .action(function (id: string, options: { profile?: string; runtime: boolean; company?: string }) {
      if (!options.runtime) {
        const personas = loadProjectProfilePersonas(options.profile ?? null)
        const found = personas.find((entry) => entry.id === id)
        if (!found) {
          throw new Error(`Persona not found: ${id}`)
        }
        writeBlock(io, renderPersonaDetail(found))
        return
      }

      const store = storeFrom(this)
      try {
        const company = options.company ? store.resolveCompany(options.company) : null
        const found = store.resolvePersona(id, company?.id)
        writeBlock(io, [
          `id: ${found.id}`,
          `name: ${found.name}`,
          `stage: ${found.stage}`,
          `adapter: ${found.preferredAdapterType}`,
          `status: ${found.status}`,
          `lanes: ${found.ownedLanes.join(", ") || "none"}`,
          `instructions: ${found.instructionsPath ?? "none"}`
        ])
      } finally {
        store.close()
      }
    })

  persona
    .command("validate")
    .description("Validate built-in personas and optional project-profile overrides")
    .option("--profile <profileId>", "Validate personas after applying a project profile")
    .option("--all-profiles", "Validate personas for every built-in project profile", false)
    .action((options: { profile?: string; allProfiles: boolean }) => {
      const profileIds = options.allProfiles ? listBuiltInProfileIds() : [options.profile ?? null]
      let failed = false

      for (const profileId of profileIds) {
        try {
          const personas = loadProjectProfilePersonas(profileId)
          const result = validatePersonaSet(personas)
          if (!result.valid) {
            failed = true
            writeBlock(io, [
              `persona_validation: failed`,
              `profile: ${profileId ?? "built-ins"}`,
              ...result.errors.map((error) => `- ${error}`)
            ])
          } else {
            writeBlock(io, [
              `persona_validation: ok`,
              `profile: ${profileId ?? "built-ins"}`,
              `personas: ${personas.length}`
            ])
          }
        } catch (error) {
          failed = true
          writeBlock(io, [
            `persona_validation: failed`,
            `profile: ${profileId ?? "built-ins"}`,
            `- ${error instanceof Error ? error.message : String(error)}`
          ])
        }
      }

      if (failed) {
        process.exitCode = 1
      }
    })

  persona
    .command("improve")
    .description("Generate a repo-specific prompt or native OpenClaw proposal for improving installed personas")
    .requiredOption("--project <ref>", "Project id or name")
    .option("--profile <profileId>", "Project profile override for persona definitions")
    .option("--output <path>", "Prompt output path, relative to the project repo")
    .option("--proposal-output <path>", "OpenClaw proposal output path, relative to the project repo")
    .option("--run-openclaw", "Run the native OpenClaw planner agent and write a proposal file", false)
    .option("--run-codex", "Deprecated alias for --run-openclaw", false)
    .option("--openclaw-command <command>", "OpenClaw command override")
    .option("--model <model>", "Optional OpenClaw provider/model override")
    .action(async function (options: {
      project: string
      profile?: string
      output?: string
      proposalOutput?: string
      runOpenclaw: boolean
      runCodex: boolean
      openclawCommand?: string
      model?: string
    }) {
      const store = storeFrom(this)
      try {
        const project = store.resolveProject(options.project)
        const profileId = options.profile ?? bestProfileMatch(project.repoPath)?.profileId ?? null
        const generatedAt = new Date().toISOString()
        const paths = defaultPersonaImprovementPaths(project.repoPath, generatedAt)
        const promptPath = resolvePersonaImprovementOutput(project.repoPath, options.output, paths.promptPath)
        const proposalPath = resolvePersonaImprovementOutput(
          project.repoPath,
          options.proposalOutput,
          paths.proposalPath
        )
        const prompt = renderPersonaImprovementPrompt({
          project,
          profileId,
          repoContext: detectRepoContext(project.repoPath, project.verifyCommand),
          runtimePersonas: store.listPersonas(project.companyId),
          profilePersonas: profileId ? loadProjectProfilePersonas(profileId) : loadProjectProfilePersonas(null),
          generatedAt
        })

        writePersonaImprovementPrompt(promptPath, prompt)

        const lines = [
          "Persona improvement prompt generated.",
          `project: ${project.name}`,
          `profile: ${profileId ?? "built-ins"}`,
          `prompt: ${proposalDisplayPath(project.repoPath, promptPath)}`
        ]

        if (options.runOpenclaw || options.runCodex) {
          await runOpenClawPersonaImprovement({
            repoPath: project.repoPath,
            prompt,
            proposalPath,
            openclawCommand: options.openclawCommand,
            agentId: "planner",
            model: options.model ?? null
          })
          lines[0] = "Persona improvement proposal generated."
          lines.push(`proposal: ${proposalDisplayPath(project.repoPath, proposalPath)}`)
        } else {
          lines.push("next: run with --run-openclaw to ask the native planner agent for a reviewable proposal")
        }

        writeBlock(io, lines)
      } finally {
        store.close()
      }
    })

  persona
    .command("update <ref>")
    .description("Update a persona")
    .option("--company <ref>", "Company id or name")
    .option("--stage <stage>", "Persona stage")
    .option("--adapter <type>", "Preferred adapter")
    .option("--instructions <path>", "Instructions path")
    .option("--owned-lane <lane>", "Repeatable owned lane", collectValues, [])
    .option("--status <status>", "Persona status: active or paused")
    .option("--budget-limit <units>", "Budget limit in usage units")
    .option("--budget-window <kind>", "Budget window kind: daily or monthly")
    .action(function (
      ref: string,
      options: {
        company?: string
        stage?: "planner" | "coder" | "reviewer" | "promoter"
        adapter?: AdapterType
        instructions?: string
        ownedLane: string[]
        status?: "active" | "paused"
        budgetLimit?: string
        budgetWindow?: "daily" | "monthly"
      }
    ) {
      const store = storeFrom(this)
      try {
        const company = options.company ? store.resolveCompany(options.company) : null
        const current = store.resolvePersona(ref, company?.id)
        const patch: {
          stage?: "planner" | "coder" | "reviewer" | "promoter"
          preferredAdapterType?: AdapterType
          instructionsPath?: string
          ownedLanes?: string[]
          status?: "active" | "paused"
          budgetLimit?: number
          budgetWindow?: "daily" | "monthly"
        } = {}
        if (options.stage) patch.stage = options.stage
        if (options.adapter) patch.preferredAdapterType = options.adapter
        if (options.instructions) patch.instructionsPath = options.instructions
        if (options.ownedLane.length > 0) patch.ownedLanes = options.ownedLane
        if (options.status) patch.status = options.status
        if (options.budgetLimit !== undefined) patch.budgetLimit = Number.parseInt(options.budgetLimit, 10)
        if (options.budgetWindow) patch.budgetWindow = options.budgetWindow
        const updated = store.updatePersona(current.id, patch)
        writeBlock(io, [
          `Updated persona ${updated.name}`,
          `stage: ${updated.stage}`,
          `adapter: ${updated.preferredAdapterType}`,
          `status: ${updated.status}`
        ])
      } finally {
        store.close()
      }
    })

  const route = program.command("route").description("Inspect deterministic task routing decisions")
  route
    .command("task <taskId>")
    .description("Route an existing task and persist the explanation")
    .action(function (taskId: string) {
      const store = storeFrom(this)
      try {
        const taskRecord = store.getTaskById(taskId)
        const decision = routeDecisionForTask(store, taskRecord)
        const updatedTask = persistRouteExplanation(store, taskRecord, decision)
        writeBlock(io, renderRouteDecision(updatedTask, decision, false))
      } finally {
        store.close()
      }
    })

  route
    .command("explain <taskId>")
    .description("Explain an existing task route and persist the detailed scorecard")
    .action(function (taskId: string) {
      const store = storeFrom(this)
      try {
        const taskRecord = store.getTaskById(taskId)
        const decision = routeDecisionForTask(store, taskRecord)
        const updatedTask = persistRouteExplanation(store, taskRecord, decision)
        writeBlock(io, renderRouteDecision(updatedTask, decision, true))
      } finally {
        store.close()
      }
    })

  route
    .command("simulate")
    .description("Simulate routing for an ad hoc goal without creating a task")
    .requiredOption("--goal <goal>", "Goal or task title to route")
    .option("--project <ref>", "Project id or name; defaults to the first project")
    .option("--label <label>", "Repeatable label hint", collectValues, [])
    .option("--changed-file <path>", "Repeatable changed-file hint", collectValues, [])
    .option("--lane <lane>", "Lane hint")
    .option("--risk <level>", "Risk level hint")
    .action(function (options: {
      goal: string
      project?: string
      label: string[]
      changedFile: string[]
      lane?: string
      risk?: string
    }) {
      const store = storeFrom(this)
      try {
        const project = options.project ? store.resolveProject(options.project) : store.listProjects()[0]
        if (!project) {
          throw new Error("No project found. Pass --project or create a project first.")
        }
        const syntheticInput: {
          companyId: string
          projectId: string
          goal: string
          labels: string[]
          changedFiles: string[]
          lane?: string
          risk?: string
        } = {
          companyId: project.companyId,
          projectId: project.id,
          goal: options.goal,
          labels: options.label,
          changedFiles: options.changedFile
        }
        if (options.lane !== undefined) syntheticInput.lane = options.lane
        if (options.risk !== undefined) syntheticInput.risk = options.risk
        const taskRecord = syntheticTaskForGoal(syntheticInput)
        const decision = routeDecisionForTask(store, taskRecord)
        writeBlock(io, renderRouteDecision(taskRecord, decision, true))
      } finally {
        store.close()
      }
    })

  const handoff = program.command("handoff").description("Manage structured persona handoffs")
  handoff
    .command("create")
    .description("Create and persist a handoff artifact")
    .requiredOption("--project <ref>", "Project id or name")
    .option("--from-file <path>", "Read a complete handoff artifact JSON file")
    .option("--source <persona>", "Source persona")
    .option("--target <persona>", "Target persona")
    .option("--context <summary>", "Context summary")
    .option("--completed-work <item>", "Repeatable completed-work entry", collectValues, [])
    .option("--open-question <item>", "Repeatable open-question entry", collectValues, [])
    .option("--risk <item>", "Repeatable risk entry", collectValues, [])
    .option("--required-file <path>", "Repeatable required-file entry", collectValues, [])
    .option("--verification-status <status>", "Verification status", "not_run")
    .option("--verification-summary <summary>", "Verification summary", "Verification has not run.")
    .option("--verification-evidence <item>", "Repeatable verification evidence entry", collectValues, [])
    .option("--next-action <action>", "Next recommended action")
    .option("--scope <summary>", "Allowed scope summary")
    .option("--scope-path <path>", "Repeatable allowed path", collectValues, [])
    .option("--scope-command <command>", "Repeatable allowed command", collectValues, [])
    .option("--scope-constraint <constraint>", "Repeatable scope constraint", collectValues, [])
    .option("--source-task <taskId>", "Source task id")
    .option("--metadata-json <json>", "Optional metadata JSON object")
    .action(function (options: {
      project: string
      fromFile?: string
      source?: string
      target?: string
      context?: string
      completedWork: string[]
      openQuestion: string[]
      risk: string[]
      requiredFile: string[]
      verificationStatus: string
      verificationSummary: string
      verificationEvidence: string[]
      nextAction?: string
      scope?: string
      scopePath: string[]
      scopeCommand: string[]
      scopeConstraint: string[]
      sourceTask?: string
      metadataJson?: string
    }) {
      const store = storeFrom(this)
      try {
        const draft = options.fromFile
          ? validateHandoffArtifact(JSON.parse(readFileSync(resolve(options.fromFile), "utf8")))
          : {
              sourcePersona: options.source ?? "",
              targetPersona: options.target ?? "",
              contextSummary: options.context ?? "",
              completedWork: options.completedWork,
              openQuestions: options.openQuestion,
              risks: options.risk,
              requiredFiles: options.requiredFile,
              verificationStatus: {
                status: options.verificationStatus as HandoffVerificationStatus,
                summary: options.verificationSummary,
                evidence: options.verificationEvidence
              },
              nextRecommendedAction: options.nextAction ?? "",
              allowedScope: {
                summary: options.scope ?? "",
                paths: options.scopePath,
                commands: options.scopeCommand,
                constraints: options.scopeConstraint
              },
              sourceTaskId: options.sourceTask ?? null,
              targetTaskId: null,
              metadata: options.metadataJson ? (JSON.parse(options.metadataJson) as Record<string, unknown>) : {}
            }
        const created = store.createHandoff({ ...draft, projectRef: options.project })
        writeBlock(io, [
          `Created handoff ${created.id}`,
          `status: ${created.status}`,
          `source: ${created.sourcePersona}`,
          `target: ${created.targetPersona}`,
          `artifact_path: ${created.artifactPath}`
        ])
      } finally {
        store.close()
      }
    })

  handoff
    .command("list")
    .description("List handoff artifacts")
    .option("--project <ref>", "Project id or name")
    .option("--status <status>", "Filter by handoff status")
    .option("--limit <count>", "Maximum rows", "50")
    .action(function (options: { project?: string; status?: HandoffStatus; limit: string }) {
      const store = storeFrom(this)
      try {
        const project = options.project ? store.resolveProject(options.project) : null
        const handoffs = store.listHandoffs({
          projectId: project?.id ?? null,
          status: options.status ?? null,
          limit: Number.parseInt(options.limit, 10) || 50
        })
        if (handoffs.length === 0) {
          writeBlock(io, ["No handoffs found."])
          return
        }
        for (const entry of handoffs) {
          io.stdout(
            `${entry.id} | ${entry.status} | ${entry.sourcePersona} -> ${entry.targetPersona} | artifact=${entry.artifactPath}\n`
          )
        }
      } finally {
        store.close()
      }
    })

  handoff
    .command("explain <handoffId>")
    .description("Render a handoff artifact for a receiving persona or human")
    .action(function (handoffId: string) {
      const store = storeFrom(this)
      try {
        const record = store.getHandoffById(handoffId)
        writeBlock(io, [
          `status: ${record.status}`,
          `artifact_path: ${record.artifactPath}`,
          "",
          ...renderHandoffArtifact(record.artifact)
        ])
      } finally {
        store.close()
      }
    })

  handoff
    .command("accept <handoffId>")
    .description("Accept a handoff and create a queued task package for the target persona")
    .option("--accepted-by <name>", "Actor accepting the handoff", "director")
    .option("--title <title>", "Task title override")
    .option("--no-create-task", "Accept without creating a task")
    .action(function (handoffId: string, options: { acceptedBy: string; title?: string; createTask: boolean }) {
      const store = storeFrom(this)
      try {
        const record = store.getHandoffById(handoffId)
        if (!options.createTask) {
          const accepted = store.acceptHandoff(handoffId, { acceptedBy: options.acceptedBy })
          writeBlock(io, [`Accepted handoff ${accepted.id}`, "created_task: none"])
          return
        }

        const project = store.getProjectById(record.projectId)
        const persona = store
          .listPersonas(project.companyId)
          .find((entry) => entry.id === record.targetPersona || entry.name === record.targetPersona)
        const basePackage = buildTaskPackage({
          title: options.title ?? handoffTitle(record.sourcePersona, record.targetPersona),
          description: record.artifact.contextSummary,
          labels: ["handoff", `handoff:${record.id}`, `target:${record.targetPersona}`],
          changedFiles: record.artifact.requiredFiles,
          requestedAdapterType: persona?.preferredAdapterType ?? null,
          assignedAgentAdapterType: null,
          repoContext: detectRepoContext(project.repoPath, project.verifyCommand),
          repoPath: project.repoPath,
          verifyCommand: project.verifyCommand
        })
        const taskPackage = taskPackageFromHandoff(record.artifact, basePackage, {
          sourceTaskId: record.sourceTaskId
        })
        const createdTask = store.createTask({
          projectRef: project.id,
          personaRef: persona?.id ?? null,
          stage: persona?.stage ?? null,
          kind: taskKindForHandoffTarget(record.targetPersona),
          priority: 0,
          title: options.title ?? handoffTitle(record.sourcePersona, record.targetPersona),
          description: renderHandoffArtifact(record.artifact).join("\n"),
          labels: [
            "handoff",
            `handoff:${record.id}`,
            `source:${record.sourcePersona}`,
            `target:${record.targetPersona}`
          ],
          changedFiles: record.artifact.requiredFiles,
          taskPackage,
          parentTaskId: record.sourceTaskId,
          laneId: taskPackage.likelyOwnershipLane,
          allowedPaths: record.artifact.allowedScope.paths,
          requiredReading: taskPackage.requiredReading,
          verificationCommands: taskPackage.verificationChecklist,
          reviewRequired: record.targetPersona.toLowerCase().includes("review"),
          approvalRequired: record.targetPersona.toLowerCase().includes("human"),
          maxRetries: 1
        })
        const accepted = store.acceptHandoff(handoffId, {
          targetTaskId: createdTask.id,
          acceptedBy: options.acceptedBy
        })
        writeBlock(io, [
          `Accepted handoff ${accepted.id}`,
          `created_task: ${createdTask.id}`,
          `status: ${createdTask.status}`,
          "",
          ...renderTaskPackageBlock(renderTaskPackage(taskPackage))
        ])
      } finally {
        store.close()
      }
    })

  const task = program.command("task").description("Manage tasks")
  task
    .command("refs <text>")
    .description("Extract task reference identifiers from text")
    .action((text: string) => {
      const refs = extractTaskReferenceIdentifiers(text)
      writeBlock(io, refs.length > 0 ? refs : ["No task references found."])
    })

  task
    .command("generate")
    .description("Generate small, dispatchable coding tasks from a high-level goal")
    .option("--project <ref>", "Project id or name")
    .option("--profile <profileId>", "Explicit project profile override")
    .option("--goal <goal>", "High-level goal statement")
    .option("--goal-file <path>", "Read the high-level goal from a file")
    .option("--dry-run", "Validate and preview packages without creating queued tasks", false)
    .action(function (options: {
      project?: string
      profile?: string
      goal?: string
      goalFile?: string
      dryRun: boolean
    }) {
      const store = storeFrom(this)
      try {
        const project = resolveProjectForTaskFactory(store, options.project)
        const profile = loadProfileForProject(project.repoPath, options.profile)
        const allTasks = store.listProjectTasks(project.id)
        const currentQueue = allTasks.filter((task) =>
          ["queued", "running", "review_needed", "promotion_pending", "blocked"].includes(task.status)
        )
        const recentCompletedTasks = allTasks.filter((task) => task.status === "done").slice(-20)
        const knownFailures = allTasks
          .filter((task) => task.status === "failed" || task.status === "blocked")
          .slice(-20)
        const packages = generateDispatchableTaskPackages({
          project,
          profile,
          currentQueue,
          recentCompletedTasks,
          knownFailures,
          ...(options.goal !== undefined ? { goal: options.goal } : {}),
          ...(options.goalFile !== undefined ? { goalFile: resolve(options.goalFile) } : {})
        })
        const result = materializeGeneratedTaskPackages({
          store,
          project,
          packages,
          dryRun: options.dryRun
        })

        writeBlock(io, [
          `task_factory.project=${project.name}`,
          `task_factory.profile=${profile.profileId}`,
          `task_factory.dry_run=${options.dryRun}`,
          `task_factory.generated=${result.packages.length}`,
          `task_factory.created=${result.decisions.filter((decision) => decision.action === "create").length}`,
          `task_factory.skipped_duplicates=${
            result.decisions.filter((decision) => decision.action === "skip_duplicate").length
          }`,
          "",
          JSON.stringify(result, null, 2)
        ])
      } finally {
        store.close()
      }
    })

  task
    .command("create <title>")
    .description("Create a task")
    .requiredOption("--project <ref>", "Project id or name")
    .option("--description <description>", "Task description")
    .option("--label <label>", "Repeatable task label", collectValues, [])
    .option("--changed-file <path>", "Repeatable changed-file hint", collectValues, [])
    .option("--agent <ref>", "Preferred or fixed agent")
    .option("--adapter <type>", "Preferred adapter override")
    .option("--preview", "Preview the generated task package without creating the task", false)
    .option("--review-required", "Require manual review before marking complete", false)
    .option("--approval-required", "Require approval before execution", false)
    .option("--max-retries <count>", "Max retries before follow-up task creation", "1")
    .action(function (
      title: string,
      options: {
        project: string
        description?: string
        label: string[]
        changedFile: string[]
        agent?: string
        adapter?: AdapterType
        preview: boolean
        reviewRequired: boolean
        approvalRequired: boolean
        maxRetries: string
      }
    ) {
      const store = storeFrom(this)
      try {
        const project = store.resolveProject(options.project)
        const assignedAgent = options.agent ? store.resolveAgent(options.agent, project.companyId) : null
        const taskPackage = buildTaskPackage({
          title,
          description: options.description ?? null,
          labels: options.label,
          changedFiles: options.changedFile,
          requestedAdapterType: options.adapter ?? null,
          assignedAgentAdapterType: assignedAgent?.adapterType ?? null,
          repoContext: detectRepoContext(project.repoPath, project.verifyCommand),
          repoPath: project.repoPath,
          verifyCommand: project.verifyCommand
        })

        if (options.preview) {
          writeBlock(io, [
            `Preview for task ${title}`,
            `project: ${project.name}`,
            "task creation: skipped",
            "",
            ...renderTaskPackageBlock(renderTaskPackage(taskPackage))
          ])
          return
        }

        const created = store.createTask({
          projectRef: options.project,
          title,
          description: options.description ?? null,
          labels: options.label,
          changedFiles: options.changedFile,
          allowedPaths: options.changedFile,
          verificationCommands: verificationCommandsFromDescription(options.description),
          taskPackage,
          assignedAgentRef: options.agent ?? null,
          requestedAdapterType: options.adapter ?? null,
          reviewRequired: options.reviewRequired,
          approvalRequired: options.approvalRequired,
          maxRetries: Number.parseInt(options.maxRetries, 10)
        })
        writeBlock(io, [
          `Created task ${created.title}`,
          `id: ${created.id}`,
          `status: ${created.status}`,
          "",
          ...renderTaskPackageBlock(renderTaskPackage(taskPackage))
        ])
      } finally {
        store.close()
      }
    })

  const backlog = program
    .command("backlog")
    .description("Generate and accept autonomous engineering backlog candidates")
  backlog
    .command("generate")
    .description("Inspect repo signals and persist prioritized backlog candidates")
    .requiredOption("--project <ref>", "Project id or name")
    .option("--skip-commands", "Skip running verification/lint/test commands during signal collection", false)
    .action(function (options: { project: string; skipCommands: boolean }) {
      const store = storeFrom(this)
      try {
        const summary = generateBacklog({
          store,
          projectRef: options.project,
          runCommands: !options.skipCommands
        })
        writeBlock(io, [
          `Backlog generated for ${summary.project.name}`,
          `persisted_candidates=${summary.candidates.length}`,
          `duplicates=${summary.duplicateCount}`,
          `signals=${summary.inspectedSignals.join(", ")}`
        ])

        if (summary.candidates.length === 0) {
          writeBlock(io, ["", "No new backlog candidates found."])
          return
        }

        io.stdout("\nPrioritized backlog:\n")
        for (const candidate of summary.candidates) {
          io.stdout(
            [
              `- id: ${candidate.id}`,
              `  title: ${candidate.title}`,
              `  value_score: ${candidate.valueScore}`,
              `  risk_score: ${candidate.riskScore}`,
              `  effort_estimate: ${candidate.effortEstimate}`,
              `  recommended_persona: ${candidate.recommendedPersona ?? "n/a"}`,
              `  suggested_adapter: ${candidate.suggestedAdapter ?? "n/a"}`,
              `  verification_command: ${candidate.verificationCommand ?? "n/a"}`,
              `  dependencies: ${candidate.dependencies.length > 0 ? candidate.dependencies.join(", ") : "none"}`,
              `  reason: ${candidate.reason}`
            ].join("\n") + "\n"
          )
        }
      } finally {
        store.close()
      }
    })

  backlog
    .command("accept <candidateId>")
    .description("Accept a backlog candidate and create a queued task package")
    .action(function (candidateId: string) {
      const store = storeFrom(this)
      try {
        const candidate = store.getBacklogCandidateById(candidateId)
        if (candidate.status === "accepted" && candidate.acceptedTaskId) {
          writeBlock(io, [`Backlog candidate already accepted.`, `task_id: ${candidate.acceptedTaskId}`])
          return
        }
        if (candidate.status === "duplicate") {
          throw new Error(
            `Backlog candidate ${candidate.id} is marked duplicate of ${candidate.duplicateOf ?? "unknown"}.`
          )
        }
        const project = store.getProjectById(candidate.projectId)
        const taskPackage = backlogCandidateTaskPackage(candidate, project)
        let personaRef: string | null = null
        if (candidate.recommendedPersona) {
          try {
            personaRef = store.resolvePersona(candidate.recommendedPersona, candidate.companyId).id
          } catch {
            personaRef = null
          }
        }
        const task = store.createTask({
          projectRef: project.id,
          title: candidate.title,
          description: candidate.description,
          labels: Array.from(
            new Set(["backlog-accepted", `backlog-dedupe:${candidate.dedupeKey}`, ...candidate.labels])
          ),
          changedFiles: candidate.changedFiles,
          taskPackage,
          kind: "implement",
          source: "maintenance",
          personaRef,
          requestedAdapterType: candidate.suggestedAdapter,
          priority: candidate.valueScore,
          requiredReading: taskPackage.requiredReading,
          verificationCommands: taskPackage.verificationChecklist,
          reviewRequired: candidate.riskScore >= 65,
          approvalRequired: candidate.riskScore >= 80,
          maxRetries: 1
        })
        store.acceptBacklogCandidate(candidate.id, task.id)
        writeBlock(io, [
          `Accepted backlog candidate ${candidate.id}`,
          `created_task_id: ${task.id}`,
          `title: ${task.title}`,
          "",
          ...renderTaskPackageBlock(renderTaskPackage(taskPackage))
        ])
      } finally {
        store.close()
      }
    })

  backlog
    .command("explain <candidateId>")
    .description("Explain why a backlog candidate was prioritized")
    .action(function (candidateId: string) {
      const store = storeFrom(this)
      try {
        const candidate = store.getBacklogCandidateById(candidateId)
        writeBlock(io, [
          `Backlog candidate ${candidate.id}`,
          `status: ${candidate.status}`,
          `title: ${candidate.title}`,
          `value_score: ${candidate.valueScore}`,
          `risk_score: ${candidate.riskScore}`,
          `effort_estimate: ${candidate.effortEstimate}`,
          `recommended_persona: ${candidate.recommendedPersona ?? "n/a"}`,
          `suggested_adapter: ${candidate.suggestedAdapter ?? "n/a"}`,
          `verification_command: ${candidate.verificationCommand ?? "n/a"}`,
          `dependencies: ${candidate.dependencies.length > 0 ? candidate.dependencies.join(", ") : "none"}`,
          `dedupe_key: ${candidate.dedupeKey}`,
          `duplicate_of: ${candidate.duplicateOf ?? "none"}`,
          `accepted_task_id: ${candidate.acceptedTaskId ?? "none"}`,
          "",
          "Reason:",
          candidate.reason,
          "",
          "Source signals:",
          ...(candidate.sourceSignals.length > 0 ? candidate.sourceSignals.map((signal) => `- ${signal}`) : ["- none"])
        ])
      } finally {
        store.close()
      }
    })

  const policy = program.command("policy").description("Evaluate autonomous agent safety policy")
  policy
    .command("check")
    .description("Evaluate policy for a queued task before dispatch")
    .requiredOption("--task <taskId>", "Task id to evaluate")
    .action(function (options: { task: string }) {
      const store = storeFrom(this)
      try {
        const taskRecord = store.getTaskById(options.task)
        const projectRecord = store.getProjectById(taskRecord.projectId)
        const persona = taskRecord.personaId ? store.getPersonaById(taskRecord.personaId) : null
        const agent = taskRecord.assignedAgentId ? store.getAgentById(taskRecord.assignedAgentId) : null
        const profile = resolveProjectProfile(projectRecord.repoPath)
        const dispatchDecision = evaluatePolicy({
          phase: "dispatch",
          project: projectRecord,
          task: taskRecord,
          agent,
          persona,
          profile,
          projectPolicy: loadProjectPolicy(projectRecord.repoPath),
          runtimeFlags: runtimePolicyFlagsFromEnv()
        })
        const lines = [`Task ${taskRecord.id}`, ...renderPolicyDecision(dispatchDecision)]
        if (taskRecord.kind === "promote") {
          const promotionDecision = evaluatePolicy({
            phase: "promotion",
            project: projectRecord,
            task: taskRecord,
            agent,
            persona,
            profile,
            projectPolicy: loadProjectPolicy(projectRecord.repoPath),
            runtimeFlags: runtimePolicyFlagsFromEnv(),
            requestedActions: [
              "file.read",
              "file.write",
              "command.execute",
              "network.access",
              "git.branch",
              "git.push",
              "pr.create",
              "pr.merge"
            ]
          })
          lines.push("", "Promotion gate:", ...renderPolicyDecision(promotionDecision))
        }
        writeBlock(io, lines)
      } finally {
        store.close()
      }
    })

  policy
    .command("explain")
    .description("Explain recorded policy decisions for a run")
    .requiredOption("--run <runId>", "Run id to inspect")
    .action(function (options: { run: string }) {
      const store = storeFrom(this)
      try {
        const runRecord = store.getRunById(options.run)
        const runEvents = store
          .getRunEvents(runRecord.id)
          .filter((event) => event.message.toLowerCase().includes("policy decision"))
        const taskEvents = store.getTaskEvents(runRecord.taskId).filter((event) => event.kind === "policy-decision")
        const lines = [`Run ${runRecord.id}`, `task: ${runRecord.taskId}`, `status: ${runRecord.status}`]
        if (runEvents.length === 0 && taskEvents.length === 0) {
          lines.push("No policy decision events recorded.")
        }
        for (const event of runEvents) {
          lines.push("", `[run:${event.seq}] ${event.level} ${event.message}`)
          if (event.data) lines.push(JSON.stringify(event.data, null, 2))
        }
        for (const event of taskEvents) {
          lines.push("", `[task] ${event.message}`)
          if (event.data) lines.push(JSON.stringify(event.data, null, 2))
        }
        writeBlock(io, lines)
      } finally {
        store.close()
      }
    })

  policy
    .command("validate")
    .description("Validate project policy inputs and default gates")
    .requiredOption("--project <project>", "Project id or name")
    .action(function (options: { project: string }) {
      const store = storeFrom(this)
      try {
        const projectRecord = store.resolveProject(options.project)
        const projectPolicy = loadProjectPolicy(projectRecord.repoPath)
        const sampleTask: Task = {
          id: "policy-validation-sample",
          companyId: projectRecord.companyId,
          projectId: projectRecord.id,
          workflowId: null,
          goalId: null,
          milestoneId: null,
          parentTaskId: null,
          dependsOnTaskIds: [],
          personaId: null,
          stage: "coder",
          title: "Validate policy engine",
          description: "Sample production database migration check",
          labels: ["risk:high"],
          changedFiles: ["migrations/001.sql"],
          taskPackage: null,
          kind: "implement",
          priority: 0,
          scheduledAt: null,
          source: "manual",
          status: "queued",
          assignedAgentId: null,
          requestedAdapterType: null,
          laneId: null,
          allowedPaths: ["migrations/"],
          requiredReading: [],
          verificationCommands: [],
          claimStatus: "unclaimed",
          claimToken: null,
          claimExpiresAt: null,
          claimOwnerRunId: null,
          claimOwnerAgentId: null,
          claimedAt: null,
          lineageRootId: null,
          lineageParentId: null,
          taskPackagePath: null,
          reviewHandoffPath: null,
          artifactDir: null,
          reviewRequired: false,
          approvalRequired: false,
          retryCount: 0,
          maxRetries: 1,
          lastError: null,
          blockedReason: null,
          lastRecoveryAt: null,
          lastRecoveryReason: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          completedAt: null
        }
        const decision = evaluatePolicy({
          phase: "dispatch",
          project: projectRecord,
          task: sampleTask,
          projectPolicy,
          runtimeFlags: {}
        })
        writeBlock(io, [
          `Project ${projectRecord.name}`,
          `policy_file: ${projectPolicy ? "ok" : "not found; framework defaults apply"}`,
          ...renderPolicyDecision(decision)
        ])
      } finally {
        store.close()
      }
    })

  const workflow = program.command("workflow").description("Manage persona-driven workflows")
  workflow
    .command("create <title>")
    .description("Create a workflow with planner, implementer, reviewer, and promoter tasks")
    .requiredOption("--project <ref>", "Project id or name")
    .option("--description <description>", "Workflow description")
    .option("--label <label>", "Repeatable workflow label", collectValues, [])
    .option("--changed-file <path>", "Repeatable changed-file hint", collectValues, [])
    .option("--priority <value>", "Workflow priority", "0")
    .action(function (
      title: string,
      options: {
        project: string
        description?: string
        label: string[]
        changedFile: string[]
        priority: string
      }
    ) {
      const store = storeFrom(this)
      try {
        const project = store.resolveProject(options.project)
        const workflowRecord = store.createWorkflow({
          projectRef: project.id,
          title,
          description: options.description ?? null
        })
        const taskPackage = buildTaskPackage({
          title,
          description: options.description ?? null,
          labels: options.label,
          changedFiles: options.changedFile,
          requestedAdapterType: null,
          assignedAgentAdapterType: null,
          repoContext: detectRepoContext(project.repoPath, project.verifyCommand),
          repoPath: project.repoPath,
          verifyCommand: project.verifyCommand
        })

        const plannerPersona = store.findPersonaByStage(project.companyId, "planner")
        const coderPersona = store.findPersonaByStage(project.companyId, "coder")
        const reviewerPersona = store.findPersonaByStage(project.companyId, "reviewer")
        const promoterPersona = store.findPersonaByStage(project.companyId, "promoter")
        const priority = Number.parseInt(options.priority, 10)

        const planTask = store.createTask({
          projectRef: project.id,
          workflowId: workflowRecord.id,
          personaRef: plannerPersona?.id ?? null,
          stage: "planner",
          kind: "plan",
          priority,
          title: `Plan: ${title}`,
          description: options.description ?? "Plan and scope the work.",
          labels: options.label,
          changedFiles: options.changedFile,
          taskPackage,
          source: "manual",
          maxRetries: 1
        })
        store.updateWorkflow(workflowRecord.id, { rootTaskId: planTask.id })

        const implementTask = store.createTask({
          projectRef: project.id,
          workflowId: workflowRecord.id,
          personaRef: coderPersona?.id ?? null,
          stage: "coder",
          kind: "implement",
          priority,
          dependsOnTaskIds: [planTask.id],
          title: `Implement: ${title}`,
          description: options.description ?? null,
          labels: options.label,
          changedFiles: options.changedFile,
          taskPackage,
          source: "manual",
          maxRetries: 1
        })

        const reviewTask = store.createTask({
          projectRef: project.id,
          workflowId: workflowRecord.id,
          personaRef: reviewerPersona?.id ?? null,
          stage: "reviewer",
          kind: "review",
          priority,
          dependsOnTaskIds: [implementTask.id],
          title: `Review: ${title}`,
          description: options.description ?? "Run verification before promotion.",
          labels: [...options.label, "review"],
          changedFiles: options.changedFile,
          taskPackage,
          source: "manual",
          maxRetries: 0
        })

        const promoteTask = store.createTask({
          projectRef: project.id,
          workflowId: workflowRecord.id,
          personaRef: promoterPersona?.id ?? null,
          stage: "promoter",
          kind: "promote",
          priority,
          dependsOnTaskIds: [reviewTask.id],
          title: `Promote: ${title}`,
          description: options.description ?? "Create PR, address review feedback, and merge.",
          labels: [...options.label, "promotion"],
          changedFiles: options.changedFile,
          taskPackage,
          source: "manual",
          maxRetries: 2
        })

        writeBlock(io, [
          `Created workflow ${workflowRecord.title}`,
          `id: ${workflowRecord.id}`,
          `plan_task: ${planTask.id}`,
          `implement_task: ${implementTask.id}`,
          `review_task: ${reviewTask.id}`,
          `promote_task: ${promoteTask.id}`
        ])
      } finally {
        store.close()
      }
    })

  workflow
    .command("status")
    .description("List workflows and their tasks")
    .option("--company <ref>", "Company id or name")
    .action(function (options: { company?: string }) {
      const store = storeFrom(this)
      try {
        const company = options.company ? store.resolveCompany(options.company) : null
        const workflows = store.listWorkflows(company?.id)
        if (workflows.length === 0) {
          writeBlock(io, ["No workflows found."])
          return
        }

        for (const entry of workflows) {
          io.stdout(`${entry.title} | id=${entry.id} | status=${entry.status}\n`)
          for (const taskEntry of store.listWorkflowTasks(entry.id)) {
            io.stdout(`- ${taskEntry.kind} | ${taskEntry.status} | ${taskEntry.title}\n`)
          }
        }
      } finally {
        store.close()
      }
    })

  program
    .command("tick")
    .description("Run one dispatcher heartbeat tick")
    .option("--company <ref>", "Company id or name")
    .option("--autonomous", "Repeat heartbeat passes until work settles", false)
    .option("--max-passes <count>", "Maximum autonomous passes", "6")
    .option("--autonomous-turns <count>", "Maximum self-prompt turns per agent run", "4")
    .option("--caveman [level]", "Set response compression: off, lite, full (default), or ultra", false)
    .action(async function (options: {
      company?: string
      autonomous: boolean
      maxPasses: string
      autonomousTurns: string
      caveman: boolean | string
    }) {
      const restoreResponseCompression = applyResponseCompressionOverride(options.caveman)
      const store = storeFrom(this)
      try {
        const executor = executorFrom(store)
        const company = options.company ? store.resolveCompany(options.company) : null
        const companyId = company?.id
        const maxPasses = Number.parseInt(options.maxPasses, 10) || 6
        const autonomousTurns = Number.parseInt(options.autonomousTurns, 10) || 4

        if (!options.autonomous) {
          const summary = await executor.tick(options.company ?? null)
          writeBlock(io, [
            "Tick complete.",
            `executed_runs: ${summary.executedRuns}`,
            `blocked_tasks: ${summary.blockedTasks}`,
            `skipped_tasks: ${summary.skippedTasks}`,
            `follow_up_tasks: ${summary.followUpTasks}`,
            `executed_jobs: ${summary.executedJobs}`,
            `created_review_tasks: ${summary.createdReviewTasks}`
          ])
          return
        }

        await withAutonomousExecutionEnv(autonomousTurns, async () => {
          let passes = 0
          let stopReason = "max_passes_reached"
          let finalState = collectAutonomousQueueState(store, {
            ...(companyId ? { companyId } : {})
          })

          while (passes < maxPasses) {
            passes += 1
            const passStartedAt = new Date().toISOString()
            const summary = await executor.tick(options.company ?? null)
            finalState = collectAutonomousQueueState(store, {
              ...(companyId ? { companyId } : {})
            })
            writeBlock(io, [
              `autonomous.pass=${passes}`,
              `executed_runs=${summary.executedRuns}`,
              `blocked_tasks=${summary.blockedTasks}`,
              `skipped_tasks=${summary.skippedTasks}`,
              `follow_up_tasks=${summary.followUpTasks}`,
              `executed_jobs=${summary.executedJobs}`,
              `created_review_tasks=${summary.createdReviewTasks}`,
              `pending.queued=${finalState.queuedTasks}`,
              `pending.running=${finalState.runningTasks}`,
              `pending.review_needed=${finalState.reviewNeededTasks}`,
              `pending.promotion_pending=${finalState.promotionPendingTasks}`,
              `pending.blocked=${finalState.blockedTasks}`,
              `pending.running_runs=${finalState.runningRuns}`
            ])

            const progressed = summary.executedRuns > 0 || summary.followUpTasks > 0 || summary.createdReviewTasks > 0
            if (autonomousQueueDrained(finalState)) {
              stopReason = "queue_drained"
              break
            }
            const rearmedJobs = rearmAutonomousTransitionJobs(store, finalState, {
              ...(companyId ? { companyId } : {}),
              ...(progressed ? {} : { triggeredSince: passStartedAt })
            })
            if (rearmedJobs > 0) {
              writeBlock(io, [`autonomous.rearmed_jobs=${rearmedJobs}`])
              continue
            }
            if (!progressed) {
              stopReason = "no_progress"
              break
            }
          }

          writeBlock(io, [
            "Autonomous tick complete.",
            `passes=${passes}`,
            `stop_reason=${stopReason}`,
            `pending.queued=${finalState.queuedTasks}`,
            `pending.running=${finalState.runningTasks}`,
            `pending.review_needed=${finalState.reviewNeededTasks}`,
            `pending.promotion_pending=${finalState.promotionPendingTasks}`,
            `pending.blocked=${finalState.blockedTasks}`,
            `pending.running_runs=${finalState.runningRuns}`
          ])
        })
      } finally {
        restoreResponseCompression()
        store.close()
      }
    })

  const runInspect = program.commands.find((command) => command.name() === "run") ?? program.command("run")
  runInspect.description("Inspect runs")
  runInspect
    .command("list")
    .description("List recent runs")
    .option("--limit <count>", "Number of runs to show", "20")
    .action(function (options: { limit: string }) {
      const store = storeFrom(this)
      try {
        const runs = store.listRuns(Number.parseInt(options.limit, 10))
        if (runs.length === 0) {
          writeBlock(io, ["No runs found."])
          return
        }

        writeBlock(
          io,
          runs.map(
            (entry) =>
              `${entry.id} | ${entry.status} | task=${entry.taskId} | agent=${entry.agentId} | adapter=${entry.adapterType} | verification=${runVerificationPreview(entry.verificationSummary)}`
          )
        )
      } finally {
        store.close()
      }
    })

  runInspect
    .command("logs <runId>")
    .description("Print logs for a run")
    .action(function (runId: string) {
      const store = storeFrom(this)
      try {
        const runRecord = store.getRunById(runId)
        const events = store.getRunEvents(runId)
        writeBlock(io, [
          `Run ${runRecord.id}`,
          `status: ${runRecord.status}`,
          `adapter: ${runRecord.adapterType}`,
          `session: ${runRecord.sessionDisplayId ?? "n/a"}`,
          ""
        ])
        for (const event of events) {
          io.stdout(`[${event.seq}] ${event.level.toUpperCase()} ${event.message}\n`)
          if (event.data) {
            io.stdout(`${JSON.stringify(event.data, null, 2)}\n`)
          }
        }
        if (runRecord.responseText) {
          io.stdout(`\nFinal response:\n${runRecord.responseText}\n`)
        }
        if (runRecord.errorText) {
          io.stdout(`\nError:\n${runRecord.errorText}\n`)
        }
      } finally {
        store.close()
      }
    })

  runInspect
    .command("show <runId>")
    .description("Show run status, trace, and artifact location")
    .action(function (runId: string) {
      const store = storeFrom(this)
      try {
        const runRecord = store.getRunById(runId)
        const events = store.getRunEvents(runId)
        const telemetry = runRecord.metadata?.telemetry
        const traceId =
          telemetry && typeof telemetry === "object" && "traceId" in telemetry
            ? String((telemetry as { traceId?: unknown }).traceId)
            : "n/a"
        const artifactDir =
          typeof runRecord.metadata?.artifacts === "object" &&
          runRecord.metadata.artifacts &&
          "artifactDir" in runRecord.metadata.artifacts
            ? String((runRecord.metadata.artifacts as { artifactDir?: unknown }).artifactDir)
            : "n/a"
        writeBlock(io, [
          `run.id=${runRecord.id}`,
          `run.status=${runRecord.status}`,
          `run.task_id=${runRecord.taskId}`,
          `run.agent_id=${runRecord.agentId ?? "n/a"}`,
          `run.adapter=${runRecord.adapterType ?? "n/a"}`,
          `run.trace_id=${traceId}`,
          `run.verification=${runRecord.verificationSummary ?? "n/a"}`,
          `run.artifacts=${artifactDir}`,
          `run.started_at=${runRecord.startedAt}`,
          `run.finished_at=${runRecord.finishedAt ?? "n/a"}`
        ])
        if (runRecord.errorText) {
          io.stdout(`run.error=${runRecord.errorText}\n`)
        }
        if (events.length > 0) {
          io.stdout("\nRecent events:\n")
          for (const event of events.slice(-8)) {
            io.stdout(`- ${event.seq} ${event.level}: ${event.message}\n`)
          }
        }
      } finally {
        store.close()
      }
    })

  runInspect
    .command("artifacts <runId>")
    .description("List persisted run artifacts")
    .option("--cat <name>", "Print one artifact file by name")
    .action(function (runId: string, options: { cat?: string }) {
      const store = storeFrom(this)
      try {
        const runRecord = store.getRunById(runId)
        const artifactDir =
          typeof runRecord.metadata?.artifacts === "object" &&
          runRecord.metadata.artifacts &&
          "artifactDir" in runRecord.metadata.artifacts
            ? String((runRecord.metadata.artifacts as { artifactDir?: unknown }).artifactDir)
            : null
        if (!artifactDir || !existsSync(artifactDir)) {
          throw new Error(`No artifact directory recorded for run ${runId}`)
        }
        if (options.cat) {
          const target = resolve(artifactDir, options.cat)
          const artifactRoot = resolve(artifactDir)
          if (!(target === artifactRoot || target.startsWith(`${artifactRoot}/`))) {
            throw new Error("Artifact path escapes the run artifact directory.")
          }
          io.stdout(readFileSync(target, "utf8"))
          return
        }
        writeBlock(io, [`run.id=${runId}`, `run.artifacts=${artifactDir}`])
        for (const name of readdirSync(artifactDir).sort()) {
          const path = join(artifactDir, name)
          const stat = statSync(path)
          io.stdout(`- ${name} ${stat.size} bytes\n`)
        }
      } finally {
        store.close()
      }
    })

  const github = program.command("github").description("Create branches and pull requests for approved runs")
  const githubBranch = github.command("branch").description("Manage GitHub branches for runs")
  githubBranch
    .command("create")
    .description("Create the deterministic OpenClaw branch for a run")
    .requiredOption("--run <runId>", "Run ID to publish")
    .action(function (options: { run: string }) {
      const store = storeFrom(this)
      try {
        assertGitHubCliAvailable()
        const context = resolveGitHubRunContext(store, options.run)
        const result = createRunBranch(context, store)
        writeBlock(io, [
          `branch: ${result.branchName}`,
          `base: ${result.baseBranch}`,
          `head_sha: ${result.headSha}`,
          `changed_files: ${result.changedFiles.length}`
        ])
      } finally {
        store.close()
      }
    })

  const githubPr = github.command("pr").description("Manage GitHub pull requests for runs")
  githubPr
    .command("create")
    .description("Commit, push, and open a GitHub pull request for a run")
    .requiredOption("--run <runId>", "Run ID to publish")
    .action(function (options: { run: string }) {
      const store = storeFrom(this)
      try {
        assertGitHubCliAvailable()
        const context = resolveGitHubRunContext(store, options.run)
        const result = createRunPullRequest(context, store)
        writeBlock(io, [
          `branch: ${result.branchName}`,
          `base: ${result.baseBranch}`,
          `pr: ${result.prNumber ?? "n/a"}`,
          `url: ${result.prUrl ?? "n/a"}`,
          `head_sha: ${result.headSha}`,
          `labels: ${result.labels.join(", ") || "none"}`,
          `body_artifact: ${result.bodyPath}`
        ])
      } finally {
        store.close()
      }
    })

  githubPr
    .command("status")
    .description("Show GitHub branch and PR metadata captured for a run")
    .requiredOption("--run <runId>", "Run ID to inspect")
    .action(function (options: { run: string }) {
      const store = storeFrom(this)
      try {
        const context = resolveGitHubRunContext(store, options.run)
        writeBlock(io, renderRunPrStatus(context))
      } finally {
        store.close()
      }
    })

  const githubRelease = github.command("release").description("Manage GitHub releases for dispatcher visibility")
  githubRelease
    .command("sync")
    .description("Import published GitHub releases into the OpenClaw release table")
    .requiredOption("--project <ref>", "Project id or name")
    .option("--repo <owner/name>", "GitHub repository slug; defaults to project origin")
    .option("--limit <count>", "Number of releases to inspect", "20")
    .action(function (options: { project: string; repo?: string; limit: string }) {
      const store = storeFrom(this)
      try {
        assertGitHubCliAvailable()
        const limit = Number.parseInt(options.limit, 10)
        const result = syncGitHubReleases(store, {
          projectRef: options.project,
          repo: options.repo ?? null,
          limit: Number.isFinite(limit) ? limit : 20
        })
        writeBlock(io, [
          `repo: ${result.repo}`,
          `imported: ${result.imported}`,
          `skipped: ${result.skipped}`,
          "releases:",
          ...result.releases.map(
            (release) =>
              `- ${release.imported ? "imported" : "existing"} ${release.tagName} | ${release.name} | db=${release.releaseId ?? "n/a"}`
          )
        ])
      } finally {
        store.close()
      }
    })

  githubRelease
    .command("audit")
    .description("Audit recent GitHub releases for persona-led autonomous development evidence")
    .requiredOption("--project <ref>", "Project id or name")
    .option("--repo <owner/name>", "GitHub repository slug; defaults to project origin")
    .option("--limit <count>", "Number of releases to inspect", "200")
    .action(function (options: { project: string; repo?: string; limit: string }) {
      const store = storeFrom(this)
      try {
        assertGitHubCliAvailable()
        const limit = Number.parseInt(options.limit, 10)
        const result = auditGitHubReleases(store, {
          projectRef: options.project,
          repo: options.repo ?? null,
          limit: Number.isFinite(limit) ? limit : 200
        })
        const personaRatio = result.inspected === 0 ? 0 : result.personaTagged / result.inspected
        const regressionRatio = result.inspected === 0 ? 0 : result.regressionLike / result.inspected
        writeBlock(io, [
          `repo: ${result.repo}`,
          `inspected: ${result.inspected}`,
          `newest: ${result.newestTag ?? "n/a"}`,
          `oldest: ${result.oldestTag ?? "n/a"}`,
          `persona_tagged: ${result.personaTagged} (${personaRatio.toFixed(3)})`,
          `regression_like: ${result.regressionLike} (${regressionRatio.toFixed(3)})`,
          `legal_domain_titles: ${result.legalDomain}`,
          "by_persona:",
          ...Object.entries(result.byPersona).map(([persona, count]) => `- ${persona}: ${count}`),
          "by_bucket:",
          ...Object.entries(result.byBucket).map(([bucket, count]) => `- ${bucket}: ${count}`)
        ])
      } finally {
        store.close()
      }
    })

  const repair = program.command("repair").description("Create and run scoped repair tasks for failed runs")
  repair
    .command("create")
    .description("Create a scoped Codex repair task for a failed run")
    .requiredOption("--run <runId>", "Failed run id")
    .action(function (options: { run: string }) {
      const store = storeFrom(this)
      try {
        const failedRun = store.getRunById(options.run)
        const project = store.getProjectById(failedRun.projectId)
        const result = store.createRepairTaskForRun(options.run, {
          projectProfileId: profileIdForProject(project.repoPath)
        })

        if (result.status === "needs_human_review") {
          writeBlock(io, [
            "Repair escalated.",
            `status: needs_human_review`,
            `original_task: ${result.originalTask.id}`,
            `failed_run: ${result.failedRun.id}`,
            `failed_repair_attempts: ${result.attempt - 1}`,
            `max_attempts: ${MAX_REPAIR_ATTEMPTS}`
          ])
          return
        }

        writeBlock(io, [
          result.status === "created" ? "Repair task created." : "Repair task already exists.",
          `repair_task: ${result.task.id}`,
          `original_task: ${result.originalTask.id}`,
          `failed_run: ${result.failedRun.id}`,
          `attempt: ${result.attempt}`,
          `max_attempts: ${MAX_REPAIR_ATTEMPTS}`,
          `allowed_scope: ${result.plan.allowedPaths.join(", ") || "none"}`,
          `verification_commands: ${result.plan.verificationCommands.join(" | ") || "none"}`
        ])
      } finally {
        store.close()
      }
    })

  repair
    .command("run")
    .description("Create a repair task for a failed run and execute one dispatcher tick")
    .requiredOption("--run <runId>", "Failed run id")
    .action(async function (options: { run: string }) {
      const store = storeFrom(this)
      try {
        const failedRun = store.getRunById(options.run)
        const project = store.getProjectById(failedRun.projectId)
        const result = store.createRepairTaskForRun(options.run, {
          projectProfileId: profileIdForProject(project.repoPath)
        })

        if (result.status === "needs_human_review") {
          writeBlock(io, [
            "Repair escalated.",
            `status: needs_human_review`,
            `original_task: ${result.originalTask.id}`,
            `failed_run: ${result.failedRun.id}`,
            `failed_repair_attempts: ${result.attempt - 1}`,
            `max_attempts: ${MAX_REPAIR_ATTEMPTS}`
          ])
          return
        }

        const executor = executorFrom(store)
        const summary = await executor.runTask(result.task.id)
        const completedRepairTask = store.getTaskById(result.task.id)
        writeBlock(io, [
          "Repair tick complete.",
          `repair_task: ${result.task.id}`,
          `attempt: ${result.attempt}`,
          `status: ${completedRepairTask.status}`,
          `executed_runs: ${summary.executedRuns}`,
          `blocked_tasks: ${summary.blockedTasks}`,
          `skipped_tasks: ${summary.skippedTasks}`,
          `follow_up_tasks: ${summary.followUpTasks}`
        ])
      } finally {
        store.close()
      }
    })

  repair
    .command("status")
    .description("List repair tasks and human-review escalations")
    .action(function () {
      const store = storeFrom(this)
      try {
        const repairTasks = store.listRepairTasks()
        const escalated = store.listTasks().filter((taskEntry) => taskEntry.status === "needs_human_review")

        if (repairTasks.length === 0 && escalated.length === 0) {
          writeBlock(io, ["No repair activity found."])
          return
        }

        if (repairTasks.length > 0) {
          io.stdout("Repair tasks:\n")
          for (const taskEntry of repairTasks) {
            const failedRunLabel = taskEntry.labels.find((label) => label.startsWith("repair-for:"))
            io.stdout(
              `- ${taskEntry.id} | ${taskEntry.status} | parent=${taskEntry.parentTaskId ?? "n/a"} | ${failedRunLabel ?? "run=n/a"} | retries=${taskEntry.retryCount}/${taskEntry.maxRetries}\n`
            )
          }
        }

        if (escalated.length > 0) {
          io.stdout("Needs human review:\n")
          for (const taskEntry of escalated) {
            io.stdout(`- ${taskEntry.id} | ${taskEntry.title} | reason=${taskEntry.blockedReason ?? "n/a"}\n`)
          }
        }
      } finally {
        store.close()
      }
    })

  const review = program.command("review").description("Autonomously review completed Codex runs")
  review
    .command("run <runId>")
    .description("Review a completed run and persist the review result")
    .option("--create-repair", "Create a repair task when the review has required fixes", false)
    .action(function (runId: string, options: { createRepair: boolean }) {
      const store = storeFrom(this)
      try {
        let result = reviewCompletedRun(store, runId, { materializeDirectReviewCarrier: true })
        store.updateRunReviewVerdict(
          runId,
          result.outcome === "approve"
            ? "approved"
            : result.outcome === "request_changes" || result.outcome === "needs_tests"
              ? "changes_requested"
              : "blocked"
        )
        if (result.outcome === "approve") {
          const run = store.getRunById(runId)
          const task = store.getTaskById(run.taskId)
          if (task.kind !== "review" && task.status === "review_needed") {
            store.updateTaskStatus(task.id, "promotion_pending", {
              assignedAgentId: task.assignedAgentId,
              lastError: null,
              blockedReason: null
            })
            store.appendTaskEvent(task.id, "review-passed", "Direct review moved task to promotion pending.", {
              reviewResultId: result.id,
              runId
            })
            store.appendRunEvent(runId, "info", "Direct review moved task to promotion_pending", {
              taskId: task.id,
              reviewResultId: result.id
            })
          }
        }
        if (options.createRepair && result.outcome !== "approve") {
          const repairTask = store.createRepairTaskFromReview(result.id)
          result = store.getReviewResultById(result.id)
          writeBlock(io, [`repair_task_id: ${repairTask.id}`, ""])
        }
        writeBlock(io, renderReviewReport(result))
      } finally {
        store.close()
      }
    })

  review
    .command("pending")
    .description("List review results that still need fixes or approval")
    .option("--project <ref>", "Project id or name")
    .action(function (options: { project?: string }) {
      const store = storeFrom(this)
      try {
        const project = options.project ? store.resolveProject(options.project) : null
        const reviewScope = project ? { projectId: project.id } : {}
        const results = store
          .listReviewResults(reviewScope)
          .filter(
            (entry) =>
              entry.outcome !== "approve" ||
              ((entry.riskLevel === "high" || entry.riskLevel === "critical") && !entry.approvedAt)
          )
        if (results.length === 0) {
          writeBlock(io, ["No pending review results found."])
          return
        }
        writeBlock(
          io,
          results.map(
            (entry) =>
              `${entry.id} | outcome=${entry.outcome} | severity=${entry.severity} | risk=${entry.riskLevel} | task=${entry.taskId} | repair=${entry.repairTaskId ?? "n/a"}`
          )
        )
      } finally {
        store.close()
      }
    })

  review
    .command("explain <reviewId>")
    .description("Show the persisted review report and inspected evidence")
    .action(function (reviewId: string) {
      const store = storeFrom(this)
      try {
        const result = store.getReviewResultById(reviewId)
        writeBlock(io, renderReviewReport(result))
        writeBlock(io, [
          "",
          "Inspected task prompt:",
          result.inspectedTaskPrompt ?? "n/a",
          "",
          "Acceptance criteria:",
          result.inspectedAcceptanceCriteria ?? "n/a",
          "",
          "Verification output:",
          result.inspectedVerificationOutput ?? "n/a",
          "",
          "Architecture/profile rules:",
          result.inspectedArchitectureRules ?? "n/a"
        ])
      } finally {
        store.close()
      }
    })

  program
    .command("approve <taskId>")
    .description("Approve a task that is waiting on approval")
    .option("--by <name>", "Approver identity", "operator")
    .action(function (taskId: string, options: { by: string }) {
      const store = storeFrom(this)
      try {
        const approval = store.approveTask(taskId, options.by)
        const latestRun = store.getLatestRunForTask(taskId)
        const reviewResult = latestRun ? store.getLatestReviewResultForRun(latestRun.id) : null
        if (reviewResult) {
          store.updateReviewResult(reviewResult.id, {
            approvedBy: options.by,
            approvedAt: approval.decidedAt ?? new Date().toISOString()
          })
        }
        writeBlock(io, [
          `Approved task ${taskId}`,
          `approval: ${approval.id}`,
          `by: ${approval.decidedBy ?? options.by}`
        ])
      } finally {
        store.close()
      }
    })

  const promote = program.command("promote").description("Evaluate and prepare completed run promotions")
  promote
    .command("check <runId>")
    .description("Check whether a completed autonomous run can be promoted")
    .option("--target <target>", "Promotion target: branch, pr, rc, or main", "pr")
    .option("--human-approved", "Record explicit human approval for main-branch target", false)
    .action(function (runId: string, options: { target: string; humanApproved: boolean }) {
      const store = storeFrom(this)
      try {
        const result = evaluatePromotionRun(store, runId, {
          target: parsePromotionTarget(options.target),
          humanApproved: options.humanApproved
        })
        writeBlock(io, renderPromotionCheck(result))
        if (!result.promotable) {
          process.exitCode = 1
        }
      } finally {
        store.close()
      }
    })

  promote
    .command("explain <runId>")
    .description("Explain every promotion gate for a completed run")
    .option("--target <target>", "Promotion target: branch, pr, rc, or main", "pr")
    .option("--human-approved", "Record explicit human approval for main-branch target", false)
    .action(function (runId: string, options: { target: string; humanApproved: boolean }) {
      const store = storeFrom(this)
      try {
        const result = evaluatePromotionRun(store, runId, {
          target: parsePromotionTarget(options.target),
          humanApproved: options.humanApproved
        })
        writeBlock(io, renderPromotionCheck(result))
        io.stdout("\nEvidence:\n")
        for (const gate of result.gates) {
          io.stdout(`- ${gate.id}: ${gate.evidence.join(" | ")}\n`)
        }
        if (!result.promotable) {
          process.exitCode = 1
        }
      } finally {
        store.close()
      }
    })

  promote
    .command("branch <runId>")
    .description("Create a local promotion branch after gates pass")
    .action(function (runId: string) {
      const store = storeFrom(this)
      try {
        const result = evaluatePromotionRun(store, runId, { target: "local_branch" })
        writeBlock(io, renderPromotionCheck(result))
        if (!result.promotable) {
          writeBlock(io, ["promotion.blocked=true", "branch_created=false"])
          process.exitCode = 1
          return
        }

        const project = store.getProjectById(result.projectId)
        const existing = execFileSync("git", ["branch", "--list", result.branchName], {
          cwd: project.repoPath,
          encoding: "utf8"
        }).trim()
        if (!existing) {
          execFileSync("git", ["branch", result.branchName], { cwd: project.repoPath, encoding: "utf8" })
        }

        const run = store.getRunById(runId)
        const task = store.getTaskById(result.taskId)
        const promotion =
          result.existingPromotion ??
          store.createPromotion({
            companyId: task.companyId,
            projectId: task.projectId,
            workflowId: task.workflowId,
            taskId: task.id,
            branchName: result.branchName,
            headSha: run.headSha,
            promotionStatus: "pending_pr",
            mergeMethod: result.policy.mergeMethod
          })
        store.appendTaskEvent(task.id, "promotion-branch-prepared", "Prepared local promotion branch.", {
          runId,
          branchName: result.branchName,
          promotionId: promotion.id,
          artifactPath: result.artifactPath
        })
        writeBlock(io, [`branch_created=${existing ? "false" : "true"}`, `branch=${result.branchName}`])
      } finally {
        store.close()
      }
    })

  promote
    .command("pr <runId>")
    .description("Prepare a pull-request promotion record after gates pass")
    .action(function (runId: string) {
      const store = storeFrom(this)
      try {
        const result = evaluatePromotionRun(store, runId, { target: "pull_request" })
        writeBlock(io, renderPromotionCheck(result))
        if (!result.promotable) {
          writeBlock(io, ["promotion.blocked=true", "pr_prepared=false"])
          process.exitCode = 1
          return
        }

        const run = store.getRunById(runId)
        const task = store.getTaskById(result.taskId)
        const promotion =
          result.existingPromotion ??
          store.createPromotion({
            companyId: task.companyId,
            projectId: task.projectId,
            workflowId: task.workflowId,
            taskId: task.id,
            branchName: result.branchName,
            headSha: run.headSha,
            promotionStatus: "pending_pr",
            mergeMethod: result.policy.mergeMethod
          })
        store.appendTaskEvent(task.id, "promotion-pr-prepared", "Prepared pull-request promotion record.", {
          runId,
          branchName: result.branchName,
          promotionId: promotion.id,
          artifactPath: result.artifactPath
        })
        writeBlock(io, [
          `pr_prepared=true`,
          `promotion=${promotion.id}`,
          "next: run `dispatcher tick` to create or sync the PR"
        ])
      } finally {
        store.close()
      }
    })

  const promotion = program.command("promotion").description("Inspect and drive promotion records")
  promotion
    .command("status")
    .description("List promotion records")
    .option("--company <ref>", "Company id or name")
    .action(function (options: { company?: string }) {
      const store = storeFrom(this)
      try {
        const company = options.company ? store.resolveCompany(options.company) : null
        const promotions = store.listPromotions(company?.id)
        if (promotions.length === 0) {
          writeBlock(io, ["No promotion records found."])
          return
        }

        writeBlock(
          io,
          promotions.map(
            (entry) =>
              `${entry.branchName} | task=${entry.taskId} | pr=${entry.prNumber ?? "n/a"} | status=${entry.promotionStatus} | base=${entry.baseBranch}`
          )
        )
      } finally {
        store.close()
      }
    })

  promotion
    .command("sync <taskId>")
    .description("Requeue a promotion task so the next tick syncs review/check state")
    .action(function (taskId: string) {
      const store = storeFrom(this)
      try {
        const task = store.getTaskById(taskId)
        if (task.kind !== "promote") {
          process.exitCode = 1
          writeBlock(io, [
            `promotion sync expects a promote task id; got ${task.kind} task ${taskId}`,
            "No task was requeued."
          ])
          return
        }
        store.updateTaskStatus(taskId, "queued", {
          blockedReason: null,
          lastError: null
        })
        writeBlock(io, [`Queued promotion task ${taskId}`, "next: run `dispatcher tick`"])
      } finally {
        store.close()
      }
    })

  const automation = program.command("automation").description("Manage automations")
  automation
    .command("add <name>")
    .description("Create an automation")
    .requiredOption("--kind <kind>", "Automation kind")
    .requiredOption("--cron <expr>", "Five-field cron expression")
    .option("--project <ref>", "Project id or name")
    .option("--company <ref>", "Company id or name")
    .option("--title <title>", "Optional task title for generated work")
    .option("--description <description>", "Optional task description for generated work")
    .option("--pause", "Create paused", false)
    .action(function (
      name: string,
      options: {
        kind:
          | "queue_refresh"
          | "repo_health"
          | "memory_maintenance"
          | "db_backup"
          | "db_compact"
          | "stale_pr_followup"
          | "pending_review_sync"
          | "blocked_promotion_retry"
        cron: string
        project?: string
        company?: string
        title?: string
        description?: string
        pause: boolean
      }
    ) {
      const store = storeFrom(this)
      try {
        const created = store.createAutomation({
          companyRef: options.company ?? null,
          projectRef: options.project ?? null,
          name,
          kind: options.kind,
          cron: options.cron,
          status: options.pause ? "paused" : "active",
          nextRunAt: new Date().toISOString(),
          payload: {
            projectRef: options.project ?? null,
            title: options.title ?? null,
            description: options.description ?? null
          }
        })
        writeBlock(io, [
          `Added automation ${created.name}`,
          `id: ${created.id}`,
          `kind: ${created.kind}`,
          `status: ${created.status}`,
          `next_run: ${created.nextRunAt ?? "n/a"}`
        ])
      } finally {
        store.close()
      }
    })

  automation
    .command("list")
    .description("List automations")
    .option("--company <ref>", "Company id or name")
    .action(function (options: { company?: string }) {
      const store = storeFrom(this)
      try {
        const company = options.company ? store.resolveCompany(options.company) : null
        const automations = store.listAutomations(company?.id)
        if (automations.length === 0) {
          writeBlock(io, ["No automations found."])
          return
        }

        writeBlock(
          io,
          automations.map(
            (entry) =>
              `${entry.name} | kind=${entry.kind} | status=${entry.status} | cron=${entry.cron} | next_run=${entry.nextRunAt ?? "n/a"}`
          )
        )
      } finally {
        store.close()
      }
    })

  automation
    .command("pause <ref>")
    .description("Pause an automation")
    .option("--company <ref>", "Company id or name when an automation name is shared")
    .action(function (ref: string, options: { company?: string }) {
      const store = storeFrom(this)
      try {
        const company = options.company ? store.resolveCompany(options.company) : null
        const automation = store.resolveAutomation(ref, company?.id ?? null)
        const updated = store.updateAutomation(automation.id, {
          status: "paused"
        })
        writeBlock(io, [`Paused automation ${updated.name}`])
      } finally {
        store.close()
      }
    })

  automation
    .command("run <ref>")
    .description("Run an automation on the next tick")
    .option("--company <ref>", "Company id or name when an automation name is shared")
    .action(function (ref: string, options: { company?: string }) {
      const store = storeFrom(this)
      try {
        const company = options.company ? store.resolveCompany(options.company) : null
        const automation = store.resolveAutomation(ref, company?.id ?? null)
        const updated = store.updateAutomation(automation.id, {
          status: "active",
          nextRunAt: new Date().toISOString()
        })
        writeBlock(io, [`Queued automation ${updated.name}`, "next: run `dispatcher tick`"])
      } finally {
        store.close()
      }
    })

  const team = program.command("team").description("Inspect durable team assignments and artifact ownership")
  team
    .command("assignments")
    .description("List routed team assignments")
    .option("--company <ref>", "Company id or name")
    .option("--project <ref>", "Project id or name")
    .option("--status <status>", "Assignment status")
    .option("--limit <count>", "Maximum assignments", "100")
    .action(function (options: { company?: string; project?: string; status?: string; limit: string }) {
      const store = storeFrom(this)
      try {
        const company = options.company ? store.resolveCompany(options.company) : null
        const project = options.project ? store.resolveProject(options.project, company?.id ?? null) : null
        const validStatuses: TeamAssignmentStatus[] = ["active", "completed", "failed", "cancelled", "released"]
        if (options.status && !validStatuses.includes(options.status as TeamAssignmentStatus)) {
          throw new Error(`Invalid team assignment status: ${options.status}`)
        }
        const companyId = project?.companyId ?? company?.id
        const parsedLimit = Number.parseInt(options.limit, 10)
        const assignments = store.listTeamAssignments({
          ...(companyId ? { companyId } : {}),
          ...(project ? { projectId: project.id } : {}),
          ...(options.status ? { status: options.status as TeamAssignmentStatus } : {}),
          limit: Number.isFinite(parsedLimit) ? parsedLimit : 100
        })
        if (assignments.length === 0) {
          writeBlock(io, ["No team assignments found."])
          return
        }

        writeBlock(
          io,
          assignments.map((assignment) => {
            const taskRecord = store.getTaskById(assignment.taskId)
            const agentRecord = store.getAgentById(assignment.agentId)
            const scopes = assignment.artifactPaths.length > 0 ? assignment.artifactPaths.join(",") : "unscoped"
            return `${assignment.id} | ${assignment.status} | ${agentRecord.name} | ${taskRecord.title} | scopes=${scopes} | run=${assignment.runId}`
          })
        )
      } finally {
        store.close()
      }
    })

  team
    .command("claims")
    .description("List artifact ownership claims")
    .option("--company <ref>", "Company id or name")
    .option("--project <ref>", "Project id or name")
    .option("--status <status>", "Claim status", "active")
    .action(function (options: { company?: string; project?: string; status: string }) {
      const store = storeFrom(this)
      try {
        const company = options.company ? store.resolveCompany(options.company) : null
        const project = options.project ? store.resolveProject(options.project, company?.id ?? null) : null
        const validStatuses: TeamArtifactClaimStatus[] = ["active", "released"]
        if (!validStatuses.includes(options.status as TeamArtifactClaimStatus)) {
          throw new Error(`Invalid team artifact claim status: ${options.status}`)
        }
        const companyId = project?.companyId ?? company?.id
        const claims = store.listTeamArtifactClaims({
          ...(companyId ? { companyId } : {}),
          ...(project ? { projectId: project.id } : {}),
          status: options.status as TeamArtifactClaimStatus
        })
        if (claims.length === 0) {
          writeBlock(io, ["No team artifact claims found."])
          return
        }

        writeBlock(
          io,
          claims.map((claim) => {
            const taskRecord = store.getTaskById(claim.taskId)
            const agentRecord = store.getAgentById(claim.agentId)
            return `${claim.artifactPath} | ${claim.status} | ${agentRecord.name} | ${taskRecord.title} | assignment=${claim.assignmentId}`
          })
        )
      } finally {
        store.close()
      }
    })

  team
    .command("lockouts")
    .description("List reviewer lockouts for independent revisions")
    .option("--company <ref>", "Company id or name")
    .option("--project <ref>", "Project id or name")
    .option("--status <status>", "Lockout status", "active")
    .action(function (options: { company?: string; project?: string; status: string }) {
      const store = storeFrom(this)
      try {
        const company = options.company ? store.resolveCompany(options.company) : null
        const project = options.project ? store.resolveProject(options.project, company?.id ?? null) : null
        const validStatuses: TeamReviewerLockoutStatus[] = ["active", "cleared"]
        if (!validStatuses.includes(options.status as TeamReviewerLockoutStatus)) {
          throw new Error(`Invalid team reviewer lockout status: ${options.status}`)
        }
        const companyId = project?.companyId ?? company?.id
        const lockouts = store.listTeamReviewerLockouts({
          ...(companyId ? { companyId } : {}),
          ...(project ? { projectId: project.id } : {}),
          status: options.status as TeamReviewerLockoutStatus
        })
        if (lockouts.length === 0) {
          writeBlock(io, ["No team reviewer lockouts found."])
          return
        }

        writeBlock(
          io,
          lockouts.map((lockout) => {
            const taskRecord = store.getTaskById(lockout.taskId)
            const lockedAgent = store.getAgentById(lockout.lockedAgentId)
            return `${lockout.artifactPath} | ${lockout.status} | locked=${lockedAgent.name} | reviewer=${lockout.reviewerActor} | task=${taskRecord.title} | thread=${lockout.threadId}`
          })
        )
      } finally {
        store.close()
      }
    })

  team
    .command("inbox")
    .description("List durable messages for an agent")
    .requiredOption("--agent <ref>", "Agent id or name")
    .option("--company <ref>", "Company id or name")
    .option("--all", "Include acknowledged messages", false)
    .option("--limit <count>", "Maximum messages", "100")
    .action(function (options: { agent: string; company?: string; all: boolean; limit: string }) {
      const store = storeFrom(this)
      try {
        const company = options.company ? store.resolveCompany(options.company) : null
        const agentRecord = store.resolveAgent(options.agent, company?.id)
        const parsedLimit = Number.parseInt(options.limit, 10)
        const messages = store.listTeamMessages({
          companyId: agentRecord.companyId,
          toAgentId: agentRecord.id,
          includeAcknowledged: options.all,
          limit: Number.isFinite(parsedLimit) ? parsedLimit : 100
        })
        if (messages.length === 0) {
          writeBlock(io, [`No team messages for ${agentRecord.name}.`])
          return
        }

        writeBlock(
          io,
          messages.map(
            (message) =>
              `${message.id} | ${message.kind} | from=${message.fromActor} | ${message.subject} | task=${message.taskId ?? "n/a"} | acknowledged=${message.acknowledgedAt ?? "no"}`
          )
        )
      } finally {
        store.close()
      }
    })

  team
    .command("acknowledge <message-id>")
    .description("Acknowledge a durable team message")
    .requiredOption("--agent <ref>", "Recipient agent id or name")
    .option("--company <ref>", "Company id or name")
    .action(function (messageId: string, options: { agent: string; company?: string }) {
      const store = storeFrom(this)
      try {
        const company = options.company ? store.resolveCompany(options.company) : null
        const agentRecord = store.resolveAgent(options.agent, company?.id)
        const message = store.acknowledgeTeamMessage(messageId, agentRecord.id)
        writeBlock(io, [`Acknowledged team message ${message.id}`, `agent: ${agentRecord.name}`])
      } finally {
        store.close()
      }
    })

  const status = program.command("status").description("Show dispatcher management dashboards")
  status
    .option("--company <ref>", "Company id or name")
    .option("--limit <count>", "Maximum recent tasks and promotions to show", "25")
    .option("--all", "Show all historical tasks and promotions", false)
  status.action(function (options: { company?: string; limit: string; all: boolean }) {
    const store = storeFrom(this)
    try {
      const parsedLimit = Number.parseInt(options.limit, 10)
      const detailLimit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 1_000) : 25
      const company = options.company ? store.resolveCompany(options.company) : null
      const workflows = store.listWorkflows(company?.id)
      const promotions = store.listPromotions(company?.id)
      const automations = store.listAutomations(company?.id)
      const tasks = store.listTasks(company?.id)
      const budgets = store.getBudgetStatuses(company?.id ?? null)
      const plannerRuns = store
        .listProjects(company?.id)
        .flatMap((project) => store.listRecentPlannerRuns(project.id, 1))
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      const activeTeamAssignments = store.listTeamAssignments({
        ...(company ? { companyId: company.id } : {}),
        status: "active"
      })
      const activeArtifactClaims = store.listTeamArtifactClaims({
        ...(company ? { companyId: company.id } : {}),
        status: "active"
      })
      const activeReviewerLockouts = store.listTeamReviewerLockouts({
        ...(company ? { companyId: company.id } : {}),
        status: "active"
      })
      const unreadTeamMessages = store.listTeamMessages({
        ...(company ? { companyId: company.id } : {}),
        includeAcknowledged: false,
        limit: 1_000
      })

      writeBlock(io, [
        `workflows: ${workflows.length}`,
        `queued_tasks: ${tasks.filter((entry) => entry.status === "queued").length}`,
        `blocked_tasks: ${tasks.filter((entry) => entry.status === "blocked").length}`,
        `active_promotions: ${
          promotions.filter((entry) => entry.promotionStatus !== "merged" && entry.promotionStatus !== "failed").length
        }`,
        `automations: ${automations.length}`,
        `planner_runs: ${plannerRuns.length}`,
        `active_team_assignments: ${activeTeamAssignments.length}`,
        `active_artifact_claims: ${activeArtifactClaims.length}`,
        `active_reviewer_lockouts: ${activeReviewerLockouts.length}`,
        `unread_team_messages: ${unreadTeamMessages.length}`
      ])

      if (tasks.length > 0) {
        const displayedTasks = options.all
          ? tasks
          : [...tasks]
              .reverse()
              .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
              .slice(0, detailLimit)
        io.stdout(
          `\nTasks by stage${options.all ? "" : ` (showing ${displayedTasks.length} of ${tasks.length} recent)`}:\n`
        )
        for (const entry of displayedTasks) {
          io.stdout(`- ${entry.stage ?? "none"} | ${entry.kind} | ${entry.status} | ${entry.title}\n`)
        }
      }

      if (promotions.length > 0) {
        const displayedPromotions = options.all
          ? promotions
          : [...promotions]
              .reverse()
              .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
              .slice(0, detailLimit)
        io.stdout(
          `\nPromotions${options.all ? "" : ` (showing ${displayedPromotions.length} of ${promotions.length} recent)`}:\n`
        )
        for (const entry of displayedPromotions) {
          io.stdout(`- ${entry.branchName} | pr=${entry.prNumber ?? "n/a"} | status=${entry.promotionStatus}\n`)
        }
      }

      if (automations.length > 0) {
        io.stdout("\nAutomations:\n")
        for (const entry of automations) {
          io.stdout(`- ${entry.name} | ${entry.kind} | ${entry.status} | next=${entry.nextRunAt ?? "n/a"}\n`)
        }
      }

      if (plannerRuns.length > 0) {
        io.stdout("\nPlanner:\n")
        for (const run of plannerRuns.slice(0, 5)) {
          const created = run.summaryJson?.createdTaskIds.length ?? 0
          io.stdout(`- ${run.projectId} | ${run.status} | created=${created} | started=${run.startedAt}\n`)
        }
      }

      if (activeTeamAssignments.length > 0) {
        io.stdout("\nTeam Assignments:\n")
        for (const assignment of activeTeamAssignments) {
          const taskRecord = store.getTaskById(assignment.taskId)
          const agentRecord = store.getAgentById(assignment.agentId)
          io.stdout(
            `- ${agentRecord.name} | ${taskRecord.title} | scopes=${assignment.artifactPaths.join(",") || "unscoped"}\n`
          )
        }
      }

      if (budgets.length > 0) {
        io.stdout("\nBudgets:\n")
        for (const entry of budgets) {
          const remaining = entry.remainingUnits === null ? "unlimited" : `${entry.remainingUnits}`
          io.stdout(
            `- ${entry.agent.name} | used=${entry.usageUnits} | remaining=${remaining} | blocked=${entry.blocked}\n`
          )
        }
      }

      const codexQuota = readCodexQuotaOverview()
      if (codexQuota.accounts.length > 0) {
        io.stdout("\nCodex Quota:\n")
        io.stdout(
          `- assessment=${codexQuota.assessment} | active=${codexQuota.activeAccount ?? "none"} | best=${codexQuota.bestAccount ?? "unknown"} | recommended_parallel_codex=${codexQuota.recommendedMaxConcurrentCodexRuns ?? "unknown"}\n`
        )
        for (const account of codexQuota.accounts) {
          const weekly = account.effectiveWeeklyUsed === null ? "?" : `${Math.round(account.effectiveWeeklyUsed)}%`
          const daily = account.effectiveDailyUsed === null ? "?" : `${Math.round(account.effectiveDailyUsed)}%`
          const age = account.cacheAgeSeconds === null ? "none" : `${account.cacheAgeSeconds}s`
          io.stdout(
            `- ${account.name}${account.active ? " *" : ""} | status=${account.status} | 7d=${weekly} | 5h=${daily} | cache_age=${age}\n`
          )
        }
      }
    } finally {
      store.close()
    }
  })

  status
    .command("company")
    .description("Show a company management overview")
    .option("--company <ref>", "Company id or name")
    .action(function (options: { company?: string }) {
      const store = storeFrom(this)
      try {
        const companyRecord = store.resolveCompany(options.company ?? null)
        const projects = store.listProjects(companyRecord.id)
        const agents = store.listAgents(companyRecord.id)
        const tasks = store.listTasks(companyRecord.id)
        const promotions = store.listPromotions(companyRecord.id)
        const automations = store.listAutomations(companyRecord.id)
        const activeTasks = tasks.filter((task) => task.status !== "done" && task.status !== "failed")

        writeBlock(io, [
          `Company ${companyRecord.name}`,
          `id: ${companyRecord.id}`,
          `projects: ${projects.length}`,
          `agents: ${agents.length}`,
          `active_tasks: ${activeTasks.length}`,
          `blocked_tasks: ${tasks.filter((task) => task.status === "blocked").length}`,
          `active_promotions: ${
            promotions.filter(
              (promotion) => promotion.promotionStatus !== "merged" && promotion.promotionStatus !== "failed"
            ).length
          }`,
          `automations: ${automations.filter((automation) => automation.status === "active").length}/${automations.length}`
        ])

        if (projects.length > 0) {
          io.stdout("\nProjects:\n")
          for (const projectRecord of projects) {
            const projectTasks = store.listProjectTasks(projectRecord.id)
            const projectMilestones = store.listMilestones(projectRecord.id)
            const projectGoals = store.listGoals(projectRecord.id)
            const queued = projectTasks.filter((task) => task.status === "queued").length
            const running = projectTasks.filter((task) => task.status === "running").length
            const blocked = projectTasks.filter((task) => task.status === "blocked").length
            io.stdout(
              `- ${projectRecord.name} | goals=${projectGoals.length} | milestones=${projectMilestones.length} | queued=${queued} | running=${running} | blocked=${blocked} | repo=${projectRecord.repoPath}\n`
            )
          }
        }
      } finally {
        store.close()
      }
    })

  status
    .command("project")
    .description("Show a project management overview")
    .requiredOption("--project <ref>", "Project id or name")
    .option("--company <ref>", "Company id or name")
    .action(function (options: { project: string; company?: string }) {
      const store = storeFrom(this)
      try {
        const projectRecord = store.resolveProject(options.project, options.company ?? null)
        const repositories = store.listRepositories(projectRecord.id)
        const milestones = store.listMilestones(projectRecord.id)
        const goals = store.listGoals(projectRecord.id)
        const tasks = store.listProjectTasks(projectRecord.id)
        const releases = store.listReleases(projectRecord.id)
        const taskStatus = (statusName: string) => tasks.filter((task) => task.status === statusName).length

        writeBlock(io, [
          `Project ${projectRecord.name}`,
          `id: ${projectRecord.id}`,
          `company: ${projectRecord.companyId}`,
          `repositories: ${repositories.length}`,
          `goals: ${goals.length}`,
          `milestones: ${milestones.length}`,
          `releases: ${releases.length}`,
          `queued_tasks: ${taskStatus("queued")}`,
          `running_tasks: ${taskStatus("running")}`,
          `review_needed_tasks: ${taskStatus("review_needed")}`,
          `blocked_tasks: ${taskStatus("blocked")}`,
          `done_tasks: ${taskStatus("done")}`
        ])

        if (repositories.length > 0) {
          io.stdout("\nRepositories:\n")
          for (const repository of repositories) {
            io.stdout(
              `- ${repository.name} | ${repository.role} | branch=${repository.defaultBranch} | path=${repository.path}\n`
            )
          }
        }

        if (milestones.length > 0) {
          io.stdout("\nMilestones:\n")
          for (const milestoneRecord of milestones) {
            const milestoneTasks = tasks.filter((task) => task.milestoneId === milestoneRecord.id)
            const done = milestoneTasks.filter((task) => task.status === "done").length
            const progress = milestoneTasks.length === 0 ? 0 : Math.round((done / milestoneTasks.length) * 100)
            io.stdout(
              `- ${milestoneRecord.name} | ${milestoneRecord.status} | progress=${progress}% | tasks=${done}/${milestoneTasks.length} | target=${milestoneRecord.targetDate ?? "n/a"}\n`
            )
          }
        }

        if (goals.length > 0) {
          io.stdout("\nGoals:\n")
          for (const goalRecord of goals) {
            const goalTasks = tasks.filter((task) => task.goalId === goalRecord.id)
            const active = goalTasks.filter((task) => task.status !== "done" && task.status !== "failed").length
            io.stdout(
              `- ${goalRecord.title} | ${goalRecord.status} | active_tasks=${active} | total_tasks=${goalTasks.length}\n`
            )
          }
        }
      } finally {
        store.close()
      }
    })

  const diagnostics = program
    .command("diagnostics [targetId]")
    .description("Prepare support diagnostics metadata and write a redacted zip bundle containing redacted files")
    .option("--output <path>", "Output zip path")
    .action(function (targetId: string | undefined, options: { output?: string }) {
      if (targetId === "manifest" || targetId === "bundle") {
        return
      }
      const store = storeFrom(this)
      try {
        let projectId: string | null = null
        let projectName: string | null = null
        let taskId: string | null = null
        let runId: string | null = null
        let sessionId: string | null = null

        if (targetId) {
          const run = store.listRuns(200).find((r) => r.id === targetId)
          if (run) {
            runId = run.id
            taskId = run.taskId
            projectId = run.projectId
            sessionId = run.sessionKey || run.sessionDisplayId
            const project = store.getProjectById(projectId)
            if (project) projectName = project.name
          } else {
            let task: Task | null = null
            try {
              task = store.getTaskById(targetId)
            } catch {}
            if (task) {
              taskId = task.id
              projectId = task.projectId
              if (projectId) {
                const project = store.getProjectById(projectId)
                if (project) projectName = project.name
              }
            } else {
              try {
                const project = store.resolveProject(targetId)
                if (project) {
                  projectId = project.id
                  projectName = project.name
                }
              } catch {
                sessionId = targetId
              }
            }
          }
        }

        const manifest = createDiagnosticsManifest({
          projectId,
          projectName,
          taskId,
          runId,
          sessionId
        })

        const entries: ZipEntry[] = [
          {
            name: "manifest.json",
            content: `${JSON.stringify(manifest, null, 2)}\n`
          }
        ]

        const baseDir = process.cwd()
        const allPaths = manifest.sections.flatMap((section) => section.paths)

        function readdirRecursive(dir: string, base: string): string[] {
          const results: string[] = []
          try {
            const list = readdirSync(dir)
            for (const file of list) {
              const fullPath = join(dir, file)
              const stats = statSync(fullPath)
              if (stats.isDirectory()) {
                results.push(...readdirRecursive(fullPath, base))
              } else if (stats.isFile()) {
                results.push(fullPath)
              }
            }
          } catch {
            // ignore
          }
          return results.map((p) => p.slice(base.length + 1))
        }

        for (const relPath of allPaths) {
          const absPath = resolve(baseDir, relPath)
          if (!existsSync(absPath)) continue

          const stats = statSync(absPath)
          if (stats.isFile()) {
            try {
              const content = readFileSync(absPath, "utf8")
              const redacted = redactLogText(content)
              entries.push({
                name: relPath,
                content: redacted
              })
            } catch {
              // ignore
            }
          } else if (stats.isDirectory()) {
            const files = readdirRecursive(absPath, absPath)
            for (const file of files) {
              const fileAbsPath = resolve(absPath, file)
              try {
                const content = readFileSync(fileAbsPath, "utf8")
                const redacted = redactLogText(content)
                entries.push({
                  name: join(relPath, file),
                  content: redacted
                })
              } catch {
                // ignore
              }
            }
          }
        }

        const bundle = zipStoredEntries(entries)
        const output = resolve(
          options.output ??
            `diagnostics-redacted-${targetId || "session"}-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`
        )
        mkdirSync(dirname(output), { recursive: true })
        writeFileSync(output, bundle)
        writeBlock(io, [`Wrote redacted diagnostics bundle containing files: ${output}`])
      } finally {
        store.close()
      }
    })

  diagnostics
    .command("manifest")
    .description("Print a privacy-aware diagnostics manifest as JSON")
    .option("--project <ref>", "Project id or name")
    .option("--session <id>", "Runtime session id")
    .option("--task <id>", "Task id")
    .option("--run <id>", "Run id")
    .option("--runtime-version <version>", "Runtime version label")
    .option("--extra-path <path>", "Additional path to include", collectValues, [])
    .action(function (options: {
      project?: string
      session?: string
      task?: string
      run?: string
      runtimeVersion?: string
      extraPath: string[]
    }) {
      const store = storeFrom(this)
      try {
        const projectRecord = options.project ? store.resolveProject(options.project) : null
        const manifest = createDiagnosticsManifest({
          projectId: projectRecord?.id ?? null,
          projectName: projectRecord?.name ?? null,
          sessionId: options.session ?? null,
          taskId: options.task ?? null,
          runId: options.run ?? null,
          runtimeVersion: options.runtimeVersion ?? null,
          extraPaths: options.extraPath
        })
        writeBlock(io, [
          JSON.stringify(
            {
              ...manifest,
              sensitivePaths: diagnosticsSensitivePaths(manifest)
            },
            null,
            2
          )
        ])
      } finally {
        store.close()
      }
    })
  diagnostics
    .command("bundle")
    .description("Write a redacted diagnostics zip bundle")
    .option("--project <ref>", "Project id or name")
    .option("--session <id>", "Runtime session id")
    .option("--task <id>", "Task id")
    .option("--run <id>", "Run id")
    .option("--runtime-version <version>", "Runtime version label")
    .option("--extra-path <path>", "Additional path to include", collectValues, [])
    .option("--output <path>", "Output zip path")
    .action(function (options: {
      project?: string
      session?: string
      task?: string
      run?: string
      runtimeVersion?: string
      extraPath: string[]
      output?: string
    }) {
      const store = storeFrom(this)
      try {
        const projectRecord = options.project ? store.resolveProject(options.project) : null
        const manifest = createDiagnosticsManifest({
          projectId: projectRecord?.id ?? null,
          projectName: projectRecord?.name ?? null,
          sessionId: options.session ?? null,
          taskId: options.task ?? null,
          runId: options.run ?? null,
          runtimeVersion: options.runtimeVersion ?? null,
          extraPaths: options.extraPath
        })
        const sensitivePaths = diagnosticsSensitivePaths(manifest)
        const bundle = zipStoredEntries([
          {
            name: "manifest.json",
            content: `${JSON.stringify({ ...manifest, sensitivePaths }, null, 2)}\n`
          },
          {
            name: "sensitive-paths.txt",
            content: `${sensitivePaths.join("\n")}\n`
          },
          {
            name: "redaction-summary.txt",
            content: [
              "This diagnostics bundle is redacted.",
              "It contains manifest metadata and sensitive path names only.",
              "It intentionally does not include raw logs, source files, environment files, tokens, or command output.",
              `Sensitive path count: ${sensitivePaths.length}`
            ].join("\n")
          }
        ])
        const output = resolve(
          options.output ?? `openclaw-diagnostics-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`
        )
        mkdirSync(dirname(output), { recursive: true })
        writeFileSync(output, bundle)
        writeBlock(io, [`Wrote redacted diagnostics bundle: ${output}`])
      } finally {
        store.close()
      }
    })

  const evalCommand = program.command("eval").description("Evaluate autonomous company performance from persisted runs")
  evalCommand
    .command("run")
    .description("Generate deterministic evaluation artifacts for a project")
    .requiredOption("--project <ref>", "Project id or name")
    .action(function (options: { project: string }) {
      const store = storeFrom(this)
      try {
        const project = store.resolveProject(options.project)
        const output = buildAutonomousCompanyEvaluation(store, project.id)
        const paths = writeAutonomousCompanyEvaluationArtifacts(project, output)
        writeBlock(io, [
          renderAutonomousCompanyEvaluationText(output),
          "",
          "Artifacts:",
          ...paths.map((path) => `- ${path}`)
        ])
      } finally {
        store.close()
      }
    })

  evalCommand
    .command("report")
    .description("Print the current evaluation report for a project")
    .requiredOption("--project <ref>", "Project id or name")
    .action(function (options: { project: string }) {
      const store = storeFrom(this)
      try {
        const output = buildAutonomousCompanyEvaluation(store, options.project)
        writeBlock(io, [renderAutonomousCompanyEvaluationText(output)])
      } finally {
        store.close()
      }
    })

  evalCommand
    .command("persona-scorecard")
    .description("Print persona scorecards")
    .option("--project <ref>", "Project id or name")
    .action(function (options: { project?: string }) {
      const store = storeFrom(this)
      try {
        const project = options.project ?? store.listProjects()[0]?.id
        if (!project) throw new Error("No project found. Pass --project after creating a project.")
        const output = buildAutonomousCompanyEvaluation(store, project)
        writeBlock(
          io,
          output.personaScorecards.map(
            (entry) =>
              `${entry.personaId} | ${entry.name} | stage=${entry.stage} | tasks=${entry.taskCount} | runs=${entry.runCount} | task_success=${entry.taskSuccessRate.value?.toFixed(3) ?? "n/a"} | verification=${entry.verificationPassRate.value?.toFixed(3) ?? "n/a"} | review_rejection=${entry.reviewRejectionRate.value?.toFixed(3) ?? "n/a"} | prompt_quality=${entry.promptQualityScore?.toFixed(3) ?? "n/a"}`
          )
        )
      } finally {
        store.close()
      }
    })

  evalCommand
    .command("adapter-scorecard")
    .description("Print adapter scorecards")
    .option("--project <ref>", "Project id or name")
    .action(function (options: { project?: string }) {
      const store = storeFrom(this)
      try {
        const project = options.project ?? store.listProjects()[0]?.id
        if (!project) throw new Error("No project found. Pass --project after creating a project.")
        const output = buildAutonomousCompanyEvaluation(store, project)
        writeBlock(
          io,
          output.adapterScorecards.map(
            (entry) =>
              `${entry.adapterType} | runs=${entry.runCount} | success=${entry.successRate.value?.toFixed(3) ?? "n/a"} | verification=${entry.verificationPassRate.value?.toFixed(3) ?? "n/a"} | avg_duration_sec=${entry.averageDurationSeconds?.toFixed(1) ?? "n/a"} | unsafe_blocks=${entry.unsafeActionBlocks}`
          )
        )
      } finally {
        store.close()
      }
    })

  const budget = program.command("budget").description("Inspect agent budget windows")
  budget
    .command("status")
    .description("Show budget status per agent")
    .option("--company <ref>", "Company id or name")
    .action(function (options: { company?: string }) {
      const store = storeFrom(this)
      try {
        const statuses = store.getBudgetStatuses(options.company ?? null)
        if (statuses.length === 0) {
          writeBlock(io, ["No agents found."])
          return
        }

        writeBlock(
          io,
          statuses.map((status) => {
            const limit = status.agent.budgetLimit === null ? "unlimited" : `${status.agent.budgetLimit}`
            const remaining = status.remainingUnits === null ? "unlimited" : `${status.remainingUnits}`
            return `${status.agent.name} | used=${status.usageUnits} | limit=${limit} | remaining=${remaining} | blocked=${status.blocked}`
          })
        )
      } finally {
        store.close()
      }
    })

  const quota = program.command("quota").description("Inspect Codex OAuth account quota headroom")
  quota
    .command("status")
    .description("Show cached Codex account quota status and recommended Codex concurrency")
    .action(() => {
      const overview = readCodexQuotaOverview()
      if (overview.accounts.length === 0) {
        writeBlock(io, ["No saved Codex accounts found under ~/.codex/accounts."])
        return
      }

      writeBlock(io, [
        `assessment: ${overview.assessment}`,
        `active_account: ${overview.activeAccount ?? "none"}`,
        `best_account: ${overview.bestAccount ?? "unknown"}`,
        `switcher_configured: ${overview.switcherConfigured}`,
        `available_accounts: ${overview.availableAccounts}`,
        `healthy_accounts: ${overview.healthyAccounts}`,
        `warm_accounts: ${overview.warmAccounts}`,
        `blocked_accounts: ${overview.blockedAccounts}`,
        `unknown_accounts: ${overview.unknownAccounts}`,
        `recommended_max_concurrent_codex_runs: ${overview.recommendedMaxConcurrentCodexRuns ?? "unknown"}`
      ])

      io.stdout("\nAccounts:\n")
      for (const account of overview.accounts) {
        const weekly = account.effectiveWeeklyUsed === null ? "?" : `${Math.round(account.effectiveWeeklyUsed)}%`
        const daily = account.effectiveDailyUsed === null ? "?" : `${Math.round(account.effectiveDailyUsed)}%`
        const cacheAge = account.cacheAgeSeconds === null ? "none" : `${account.cacheAgeSeconds}s`
        const score = account.score === null ? "?" : account.score.toFixed(1)
        io.stdout(
          `- ${account.name}${account.active ? " *" : ""} | status=${account.status} | 7d=${weekly} | 5h=${daily} | score=${score} | cache_age=${cacheAge}\n`
        )
      }

      if (!overview.switcherConfigured) {
        io.stdout("\nHint:\n")
        io.stdout(
          "- Run `dispatcher quota switch-best`, install `codex-auth` on PATH, or configure `CODEX_ACCOUNT_SWITCHER_SCRIPT`, so quota-aware retries can switch accounts automatically.\n"
        )
      }
    })
  quota
    .command("switch-best")
    .description("Switch auth.json to the best available Codex account")
    .option("--exclude <account>", "Account name to skip; repeat or comma-separate", collectCommaList, [] as string[])
    .option("--refresh-live", "Probe live quota through the embedded account switcher before selecting", false)
    .option("--json", "Print the switcher JSON payload", false)
    .action((options: { exclude: string[]; refreshLive: boolean; json: boolean }) => {
      const overview = readCodexQuotaOverview()
      const bestAccount = overview.bestAccount

      if (!options.refreshLive) {
        if (!bestAccount) {
          throw new Error("No best Codex account is known from cached quota state. Re-run with --refresh-live.")
        }
        const excluded = new Set(options.exclude)
        if (excluded.has(bestAccount)) {
          throw new Error(`Best cached Codex account ${bestAccount} is excluded. Re-run without excluding it.`)
        }
        const source = switchCodexAuthToCachedAccount(bestAccount)
        const payload = {
          switched_to: bestAccount,
          already_active: overview.activeAccount === bestAccount,
          mode: "cached",
          source,
          assessment: overview.assessment,
          available_accounts: overview.availableAccounts,
          recommended_max_concurrent_codex_runs: overview.recommendedMaxConcurrentCodexRuns
        }
        if (options.json) {
          io.stdout(`${JSON.stringify(payload, null, 2)}\n`)
          return
        }
        writeBlock(io, [
          `switcher: cached`,
          `status: ${payload.already_active ? "already_active" : "switched"}`,
          `account: ${bestAccount}`,
          `assessment: ${overview.assessment}`,
          `recommended_max_concurrent_codex_runs: ${overview.recommendedMaxConcurrentCodexRuns ?? "unknown"}`
        ])
        return
      }

      const switcherPath = discoverCodexAccountSwitcherForCli()
      if (!switcherPath) {
        throw new Error(
          "Codex account switcher not found. Set CODEX_ACCOUNT_SWITCHER_SCRIPT or install the bundled skills/codex-account-switcher asset."
        )
      }
      if (switcherPath === "codex-auth" && !bestAccount) {
        throw new Error("codex-auth is available, but no best Codex account is known from quota state.")
      }

      const args =
        switcherPath === "codex-auth"
          ? ["switch", bestAccount as string]
          : ["auto", "--json", ...options.exclude.flatMap((account) => ["--exclude", account])]
      const stdout = runCodexAccountSwitcher(switcherPath, args)
      const payload = parseJsonObject(stdout)

      if (options.json) {
        io.stdout(payload ? `${JSON.stringify(payload, null, 2)}\n` : stdout)
        return
      }

      if (!payload) {
        writeBlock(io, [`switcher: ${switcherPath}`, stdout.trim() || "switcher completed"])
        return
      }

      if (typeof payload.error === "string") {
        writeBlock(io, [
          `switcher: ${switcherPath}`,
          `status: failed`,
          `error: ${payload.error}`,
          `excluded_accounts: ${Array.isArray(payload.excluded_accounts) ? payload.excluded_accounts.join(", ") : "none"}`
        ])
        process.exitCode = 1
        return
      }

      const switchedTo = typeof payload.switched_to === "string" ? payload.switched_to : "unknown"
      const alreadyActive = payload.already_active === true
      const weeklyUsed =
        typeof payload.effective_weekly_used === "number" ? `${Math.round(payload.effective_weekly_used)}%` : "?"
      writeBlock(io, [
        `switcher: ${switcherPath}`,
        `status: ${alreadyActive ? "already_active" : "switched"}`,
        `account: ${switchedTo}`,
        `effective_weekly_used: ${weeklyUsed}`
      ])
    })

  const queueRefresh = program.command("queue-refresh").description("Run and inspect planner-backed queue refreshes")
  queueRefresh
    .command("run")
    .requiredOption("--project <ref>", "Project id or name")
    .option("--profile <profileId>", "Explicit profile override")
    .option("--full-cycle", "Run persona ideation through execution, review, promotion, and release", false)
    .option("--wait", "Wait for agent-loop lifecycle events during --full-cycle", false)
    .option("--max-passes <count>", "Maximum full-cycle passes", "8")
    .option("--json", "Print structured JSON for --full-cycle", false)
    .option("--caveman [level]", "Set response compression during --full-cycle", false)
    .action(async function (options: {
      project: string
      profile?: string
      fullCycle: boolean
      wait: boolean
      maxPasses: string
      json: boolean
      caveman: boolean | string
    }) {
      const restoreResponseCompression = applyResponseCompressionOverride(options.caveman)
      const store = storeFrom(this)
      try {
        if (options.fullCycle) {
          const runtime = new DirectorRuntime(store, executorFrom(store))
          const report = await runtime.runQueueRefreshFullCycle(options.project, {
            profileId: options.profile ?? null,
            maxPasses: Number.parseInt(options.maxPasses, 10) || 8,
            waitForLoops: options.wait
          })
          if (options.json) {
            io.stdout(`${JSON.stringify(report, null, 2)}\n`)
          } else {
            writeQueueRefreshFullCycleReport(io, report)
          }
          return
        }

        const executor = executorFrom(store)
        const result = await executor.runPlannerRefresh(options.project)
        writeBlock(io, [`planner_run_id: ${result.plannerRunId}`, `created_tasks: ${result.createdTasks}`])
        for (const taskId of result.createdTaskIds) {
          io.stdout(`- ${taskId}\n`)
        }
      } finally {
        restoreResponseCompression()
        store.close()
      }
    })

  queueRefresh
    .command("explain")
    .requiredOption("--project <ref>", "Project id or name")
    .option("--limit <n>", "Number of planner runs to show", "5")
    .action(function (options: { project: string; limit: string }) {
      const store = storeFrom(this)
      try {
        const project = store.resolveProject(options.project)
        const runs = store.listRecentPlannerRuns(project.id, Number.parseInt(options.limit, 10) || 5)
        if (runs.length === 0) {
          writeBlock(io, ["No planner runs found."])
          return
        }
        for (const run of runs) {
          io.stdout(
            `${run.id} | ${run.status} | created=${run.summaryJson?.createdTaskIds.length ?? 0} | started=${run.startedAt}\n`
          )
          if (run.snapshotJson) {
            io.stdout(
              `- changed_files=${run.snapshotJson.changedFiles.length} | stale_tasks=${run.snapshotJson.staleTasks.length}\n`
            )
          }
          for (const event of store.getPlannerEvents(run.id).slice(-5)) {
            io.stdout(`  [${event.seq}] ${event.kind} | ${event.message}\n`)
          }
        }
      } finally {
        store.close()
      }
    })

  const planner = program.command("planner").description("Inspect planner artifacts")
  planner
    .command("artifacts")
    .requiredOption("--project <ref>", "Project id or name")
    .option("--limit <n>", "Number of planner runs to inspect", "3")
    .action(function (options: { project: string; limit: string }) {
      const store = storeFrom(this)
      try {
        const project = store.resolveProject(options.project)
        const runs = store.listRecentPlannerRuns(project.id, Number.parseInt(options.limit, 10) || 3)
        if (runs.length === 0) {
          writeBlock(io, ["No planner artifacts found."])
          return
        }
        for (const run of runs) {
          io.stdout(`${run.id} | ${run.status}\n`)
          for (const artifact of store.listPlannerArtifacts(project.id, run.id)) {
            io.stdout(`- ${artifact.kind} | ${artifact.path}\n`)
          }
        }
      } finally {
        store.close()
      }
    })

  planner
    .command("portfolio")
    .description("Show recent planner-created task distribution by portfolio bucket and persona")
    .requiredOption("--project <ref>", "Project id or name")
    .option("--limit <n>", "Number of recent planner-created tasks to inspect", "200")
    .action(function (options: { project: string; limit: string }) {
      const store = storeFrom(this)
      try {
        const project = store.resolveProject(options.project)
        const limit = Number.parseInt(options.limit, 10) || 200
        const tasks = store
          .listProjectTasks(project.id)
          .filter((task) => task.labels.includes("planner-generated"))
          .slice(-Math.max(1, limit))
        const buckets = new Map<string, number>()
        const personas = new Map<string, number>()
        for (const task of tasks) {
          const bucket =
            task.taskPackage?.portfolioBucket ??
            task.labels.find((label) => label.startsWith("bucket:"))?.slice("bucket:".length) ??
            "unassigned"
          const persona = task.taskPackage?.personaProvenance?.personaId ?? "unassigned"
          buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1)
          personas.set(persona, (personas.get(persona) ?? 0) + 1)
        }
        writeBlock(io, [
          `project: ${project.name}`,
          `planner_tasks: ${tasks.length}`,
          "portfolio_buckets:",
          ...Array.from(buckets.entries()).map(([bucket, count]) => `- ${bucket}: ${count}`),
          "personas:",
          ...Array.from(personas.entries()).map(([personaId, count]) => `- ${personaId}: ${count}`)
        ])
      } finally {
        store.close()
      }
    })

  program
    .command("cost")
    .description("Project loop token consumption scenarios based on cadence and level")
    .option("--pattern <id>", "Loop pattern ID (e.g. daily-triage, pr-babysitter)")
    .option("--level <level>", "Readiness level (L1, L2, L3)", "L1")
    .option("--cadence <interval>", "Override default cadence (e.g. 15m, 1h, 1d)")
    .action((options: { pattern?: string; level: string; cadence?: string }) => {
      const levelVal = options.level.toUpperCase()
      if (levelVal !== "L1" && levelVal !== "L2" && levelVal !== "L3") {
        throw new Error(`Unsupported level "${options.level}". Use L1, L2, or L3.`)
      }

      if (options.pattern) {
        const pattern = LOOP_PATTERNS.find((p) => p.id === options.pattern)
        if (!pattern) {
          throw new Error(`Pattern "${options.pattern}" not found in registry.`)
        }
        const report = estimateCost(pattern, levelVal, options.cadence)
        writeBlock(io, renderCostReport(report))
      } else {
        io.stdout("Projecting token cost estimates for all registered loop patterns:\n\n")
        for (const pattern of LOOP_PATTERNS) {
          const report = estimateCost(pattern, levelVal, options.cadence)
          writeBlock(io, renderCostReport(report))
          io.stdout("\n--------------------------------------------------\n\n")
        }
      }
    })

  program
    .command("audit")
    .description("Audit the repository for loop engineering readiness scoring and levels")
    .option("--project <path>", "Path to target repository to audit", ".")
    .action(function (options: { project: string }) {
      const store = storeFrom(this)
      try {
        const report = auditProject(options.project, store)
        writeBlock(io, renderAuditSummary(report))
      } finally {
        store.close()
      }
    })

  const memoryCmd = program.command("memory").description("Inspect and manage project memory database")

  memoryCmd
    .command("status")
    .description("Show overview statistics of memory store for a project")
    .requiredOption("--project <ref>", "Project id or name")
    .action(async function (options: { project: string }) {
      const store = storeFrom(this)
      try {
        const project = store.resolveProject(options.project)
        const chunks = store.listMemoryChunks(project.id)

        const totalChunks = chunks.length
        const layerCounts: Record<string, number> = {}
        const audienceCounts: Record<string, number> = {}
        const lifecycleCounts: Record<string, number> = {}

        for (const chunk of chunks) {
          layerCounts[chunk.layer] = (layerCounts[chunk.layer] ?? 0) + 1
          audienceCounts[chunk.audience] = (audienceCounts[chunk.audience] ?? 0) + 1
          lifecycleCounts[chunk.lifecycleStatus] = (lifecycleCounts[chunk.lifecycleStatus] ?? 0) + 1
        }

        const lines = [
          `Project: ${project.name} (${project.id})`,
          `Total Memory Chunks: ${totalChunks}`,
          "",
          "By Layer:",
          ...Object.entries(layerCounts).map(([layer, count]) => `  - ${layer}: ${count}`),
          "",
          "By Audience:",
          ...Object.entries(audienceCounts).map(([audience, count]) => `  - ${audience}: ${count}`),
          "",
          "By Lifecycle Status:",
          ...Object.entries(lifecycleCounts).map(([status, count]) => `  - ${status}: ${count}`)
        ]

        writeBlock(io, lines)
      } finally {
        store.close()
      }
    })

  memoryCmd
    .command("list")
    .description("List recent memory chunks for a project")
    .requiredOption("--project <ref>", "Project id or name")
    .option("--limit <n>", "Limit the number of listed memory chunks", "10")
    .option("--layer <layer>", "Filter chunks by layer")
    .action(async function (options: { project: string; limit: string; layer?: string }) {
      const store = storeFrom(this)
      try {
        const project = store.resolveProject(options.project)
        let chunks = store.listMemoryChunks(project.id)
        if (options.layer) {
          chunks = chunks.filter((chunk) => chunk.layer === options.layer)
        }
        const limit = Number.parseInt(options.limit, 10) || 10
        const items = chunks.slice(0, limit)

        if (items.length === 0) {
          writeBlock(io, ["No memory chunks found."])
          return
        }

        const lines = items.map((chunk) => {
          const preview =
            chunk.content.length > 60
              ? `${chunk.content.slice(0, 57).replace(/\n/g, " ")}...`
              : chunk.content.replace(/\n/g, " ")
          return `${chunk.id.slice(0, 8)} | ${chunk.layer.padEnd(20)} | ${chunk.audience.padEnd(8)} | ${chunk.title.padEnd(30)} | ${preview}`
        })

        writeBlock(io, [
          `Listing ${items.length} of ${chunks.length} memory chunks:`,
          `ID       | Layer                | Audience | Title                          | Preview`,
          `---------+----------------------+----------+--------------------------------+---------------------`,
          ...lines
        ])
      } finally {
        store.close()
      }
    })

  memoryCmd
    .command("search")
    .description("Search memory store by keyword or semantic query using mock context")
    .requiredOption("--project <ref>", "Project id or name")
    .argument("<query>", "Search query string")
    .option("--limit <n>", "Maximum number of search results to return", "5")
    .action(async function (query: string, options: { project: string; limit: string }) {
      const store = storeFrom(this)
      try {
        const project = store.resolveProject(options.project)
        const memory = new MemoryService(store)

        const mockTask = {
          title: query,
          description: "",
          labels: [],
          changedFiles: [],
          stage: null,
          lastError: null
        } as unknown as Task

        const mockAgent = {
          adapterType: "codex_local"
        } as unknown as Agent

        const results = await memory.retrieveRelevantMemory(mockTask, mockAgent, project)
        const limit = Number.parseInt(options.limit, 10) || 5
        const items = results.slice(0, limit)

        if (items.length === 0) {
          writeBlock(io, ["No matching memory chunks found."])
          return
        }

        const lines = items.map((item) => {
          const score =
            item.similarity !== null
              ? `Cosine: ${item.similarity.toFixed(4)}`
              : `Keyword: ${item.keywordScore.toFixed(4)}`
          const label =
            item.chunk.sourceKind === "repo_doc" ? `${item.chunk.sourcePath ?? item.chunk.title}` : item.chunk.title
          const preview =
            item.chunk.content.length > 100
              ? `${item.chunk.content.slice(0, 97).replace(/\n/g, " ")}...`
              : item.chunk.content.replace(/\n/g, " ")
          return `- [${item.chunk.sourceKind}] ${label} (${score})\n  Preview: ${preview}`
        })

        writeBlock(io, [`Search Results for "${query}" (limit ${limit}):`, ...lines])
      } finally {
        store.close()
      }
    })

  memoryCmd
    .command("sync")
    .description("Scan repository files and update/upsert project memory chunks")
    .requiredOption("--project <ref>", "Project id or name")
    .option("--agent-type <type>", "Mock agent adapter type for scanning", "codex_local")
    .action(async function (options: { project: string; agentType: string }) {
      const store = storeFrom(this)
      try {
        const project = store.resolveProject(options.project)
        const memory = new MemoryService(store)

        const mockAgent = {
          adapterType: options.agentType
        } as unknown as Agent

        io.stdout(`Starting repository memory synchronization for ${project.name}...\n`)
        const beforeCount = store.listMemoryChunks(project.id).length
        await memory.upsertRepoMemory(project, mockAgent)
        const afterCount = store.listMemoryChunks(project.id).length

        writeBlock(io, [
          "Memory synchronization completed successfully.",
          `- Chunks before sync: ${beforeCount}`,
          `- Chunks after sync: ${afterCount}`,
          `- New/updated chunks: ${afterCount - beforeCount}`
        ])
      } finally {
        store.close()
      }
    })

  memoryCmd
    .command("compact")
    .description("Run memory compaction sweep to compress older memories into summary chunks")
    .requiredOption("--project <ref>", "Project id or name")
    .option("--max-chunks <num>", "Maximum chunks to allow before triggering compaction")
    .option("--keep-recent <num>", "Number of recent chunks to always keep uncompacted")
    .action(async function (options: { project: string; maxChunks?: string; keepRecent?: string }) {
      const store = storeFrom(this)
      try {
        const project = store.resolveProject(options.project)
        const memory = new MemoryService(store)

        const policy: Partial<MemoryCompactionPolicy> = {}
        if (options.maxChunks) {
          policy.maxChunks = Number.parseInt(options.maxChunks, 10)
        }
        if (options.keepRecent) {
          policy.keepRecent = Number.parseInt(options.keepRecent, 10)
        }

        io.stdout(`Starting memory compaction sweep for ${project.name}...\n`)
        const result = await memory.compactProjectMemory(project.id, policy)

        if (!result.summaryChunk) {
          writeBlock(io, [
            "No memory compaction was required.",
            `Skipped/kept chunks: ${result.skippedChunkIds.length}`
          ])
          return
        }

        writeBlock(io, [
          "Memory compaction completed successfully.",
          `Created summary chunk ID: ${result.summaryChunk.id}`,
          `Compacted chunk IDs (${result.compactedChunkIds.length}):`,
          ...result.compactedChunkIds.map((id) => `  - ${id}`),
          `Skipped/kept chunk IDs (${result.skippedChunkIds.length}):`,
          ...result.skippedChunkIds.map((id) => `  - ${id}`)
        ])
      } finally {
        store.close()
      }
    })

  return program
}

export async function runCli(argv: string[], io?: Io): Promise<void> {
  loadEnvFiles()
  const program = createProgram(io)
  await program.parseAsync(argv, { from: "user" })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
