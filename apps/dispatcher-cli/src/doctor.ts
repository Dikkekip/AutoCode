import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { azureFoundryAdapter } from "@openclaw/adapter-azure-foundry"
import { codexLocalAdapter } from "@openclaw/adapter-codex-local"
import { geminiLocalAdapter } from "@openclaw/adapter-gemini-local"
import { DispatcherStore } from "@openclaw/db"
import type {
  AdapterDefinition,
  AdapterExecutionContext,
  AdapterExecutionResult,
  AdapterHealthcheckResult,
  AdapterType,
  Agent,
  Company,
  Project,
  RuntimeIdentityPayload,
  SessionState,
  Task
} from "@openclaw/domain"
import { DispatcherExecutor } from "@openclaw/executor"
import { loadProjectProfile } from "@openclaw/project-profiles"
import { type AuditReport, auditProject } from "./audit.js"

export type DoctorFailureClass =
  | "binary_missing"
  | "auth_missing"
  | "quota_exhausted"
  | "timeout"
  | "transport_error"
  | "model_unavailable"
  | "session_unavailable"
  | "session_resume_failed"
  | "planner_failed"
  | "recovery_failed"
  | "healthcheck_failed"
  | "execution_failed"
  | "unknown"

export type DoctorLaneStatus = "pass" | "fail"

export interface DoctorLaneSpec {
  id: string
  label: string
  adapterType: AdapterType
  requestedModel: string
  transport: string
  expectsSessionResume: boolean
}

export interface DoctorFailure {
  class: DoctorFailureClass
  stage: "healthcheck" | "execution" | "session" | "planner" | "recovery"
  message: string
}

export interface DoctorLaneResult {
  id: string
  label: string
  adapterType: AdapterType
  requestedModel: string
  modelUsed: string | null
  provider: string | null
  transportUsed: string
  status: DoctorLaneStatus
  healthcheckOk: boolean
  healthcheckMessage: string
  healthcheckLatencyMs: number
  executionOk: boolean
  sessionOk: boolean | null
  latencyMs: number
  responsePreview: string | null
  sessionDisplayId: string | null
  failure: DoctorFailure | null
  healed?: {
    originalModel: string
    workingModel: string
    message: string
  } | null
}

export interface DoctorSyntheticCheck {
  id: "planner" | "recovery"
  label: string
  status: "pass" | "fail" | "skipped"
  latencyMs: number
  failure: DoctorFailure | null
  details: Record<string, unknown>
}

export interface DoctorModuleCheck {
  id: "repo_path" | "database" | "backup"
  label: string
  status: "pass" | "fail"
  failure: DoctorFailure | null
  details: Record<string, unknown>
}

export interface DoctorReport {
  version: 1
  startedAt: string
  finishedAt: string
  repoPath: string
  syntheticRepo: boolean
  exitCode: number
  summary: {
    passed: number
    failed: number
    total: number
  }
  lanes: DoctorLaneResult[]
  syntheticChecks: DoctorSyntheticCheck[]
  moduleChecks: DoctorModuleCheck[]
  loopReadiness: AuditReport | null
  wrapper: {
    repo: string | null
    db: string | null
    framework: string | null
  }
}

export interface RunDoctorOptions {
  repoPath?: string | null
  store?: DispatcherStore | null
  includePlanner?: boolean
  includeRecovery?: boolean
}

type DoctorFixture = {
  root: string
  cleanup: () => void
}

type DoctorAgentTemplate = Pick<
  Agent,
  "id" | "model" | "command" | "env" | "instructionsPath" | "heartbeatEnabled" | "heartbeatIntervalSec"
>

const ADAPTERS: Record<AdapterType, AdapterDefinition> = {
  codex_local: codexLocalAdapter,
  gemini_local: geminiLocalAdapter,
  azure_foundry: azureFoundryAdapter
}
const DEFAULT_DOCTOR_ADAPTER_TIMEOUT_MS = 120_000

function doctorAdapterTimeoutMs(): string {
  const raw = process.env.OPENCLAW_DOCTOR_ADAPTER_TIMEOUT_MS?.trim()
  const parsed = raw ? Number.parseInt(raw, 10) : DEFAULT_DOCTOR_ADAPTER_TIMEOUT_MS
  return String(Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DOCTOR_ADAPTER_TIMEOUT_MS)
}

export const DOCTOR_LANES: DoctorLaneSpec[] = [
  {
    id: "codex-gpt-5.6-sol",
    label: "codex_local GPT-5.6 Sol",
    adapterType: "codex_local",
    requestedModel: "gpt-5.6-sol",
    transport: "cli/codex-exec",
    expectsSessionResume: true
  },
  {
    id: "codex-gpt-5.6-terra",
    label: "codex_local GPT-5.6 Terra",
    adapterType: "codex_local",
    requestedModel: "gpt-5.6-terra",
    transport: "cli/codex-exec",
    expectsSessionResume: true
  },
  {
    id: "codex-gpt-5.6-luna",
    label: "codex_local GPT-5.6 Luna",
    adapterType: "codex_local",
    requestedModel: "gpt-5.6-luna",
    transport: "cli/codex-exec",
    expectsSessionResume: true
  },
  {
    id: "codex-gpt-5.5",
    label: "codex_local GPT-5.5",
    adapterType: "codex_local",
    requestedModel: "gpt-5.5",
    transport: "cli/codex-exec",
    expectsSessionResume: true
  },
  {
    id: "codex-gpt-5.4-mini",
    label: "codex_local gpt-5.4-mini",
    adapterType: "codex_local",
    requestedModel: "gpt-5.4-mini",
    transport: "cli/codex-exec",
    expectsSessionResume: true
  },
  {
    id: "codex-gpt-5.3-codex-spark",
    label: "codex_local gpt-5.3-codex-spark",
    adapterType: "codex_local",
    requestedModel: "gpt-5.3-codex-spark",
    transport: "cli/codex-exec",
    expectsSessionResume: true
  },
  {
    id: "gemini-pro",
    label: "gemini_local pro",
    adapterType: "gemini_local",
    requestedModel: "gemini-2.5-pro",
    transport: "cli/gemini-json",
    expectsSessionResume: true
  },
  {
    id: "gemini-flash",
    label: "gemini_local flash",
    adapterType: "gemini_local",
    requestedModel: "gemini-2.5-flash",
    transport: "cli/gemini-json",
    expectsSessionResume: true
  },
  {
    id: "foundry-kimi",
    label: "azure_foundry Kimi-2.6",
    adapterType: "azure_foundry",
    requestedModel: "Kimi-K2.6",
    transport: "https/azure-foundry-chat-completions",
    expectsSessionResume: false
  },
  {
    id: "foundry-gpt-5.4-mini",
    label: "azure_foundry gpt-5.4-mini",
    adapterType: "azure_foundry",
    requestedModel: "gpt-5.4-mini",
    transport: "https/azure-foundry-chat-completions",
    expectsSessionResume: false
  }
]

function nowIso(): string {
  return new Date().toISOString()
}

function createSyntheticDoctorRepo(): DoctorFixture {
  const root = mkdtempSync(join(tmpdir(), "openclaw-doctor-"))
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, "README.md"), "# OpenClaw Doctor Fixture\n", "utf8")
  writeFileSync(join(root, ".gitignore"), "node_modules/\n", "utf8")
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true })
  }
}

function chooseTemplateAgent(
  store: DispatcherStore | null,
  adapterType: AdapterType,
  requestedModel: string,
  repoPath: string
): DoctorAgentTemplate | null {
  if (!store) return null

  const project = store.findProjectByRepoPath(repoPath)
  if (!project) return null
  const scopedAgents = store.listAgents(project.companyId)
  const candidates = scopedAgents.filter((agent) => agent.adapterType === adapterType)
  const exact =
    candidates.find((agent) => agent.model?.toLowerCase() === requestedModel.toLowerCase()) ??
    candidates.find((agent) => agent.model === null) ??
    candidates[0]

  return exact
    ? {
        id: exact.id,
        model: exact.model,
        command: exact.command,
        env: exact.env,
        instructionsPath: exact.instructionsPath,
        heartbeatEnabled: exact.heartbeatEnabled,
        heartbeatIntervalSec: exact.heartbeatIntervalSec
      }
    : null
}

function buildAgent(spec: DoctorLaneSpec, template: DoctorAgentTemplate | null): Agent {
  return {
    id: `doctor-agent-${spec.id}`,
    companyId: "doctor-company",
    name: spec.id,
    role: "OpenClaw operator harness lane check",
    adapterType: spec.adapterType,
    status: "idle",
    model: spec.requestedModel,
    instructionsPath: template?.instructionsPath ?? null,
    command: template?.command ?? null,
    env: {
      ...(template?.env ?? {}),
      OPENCLAW_GEMINI_TIMEOUT_MS: template?.env?.OPENCLAW_GEMINI_TIMEOUT_MS ?? doctorAdapterTimeoutMs(),
      OPENCLAW_CODEX_TIMEOUT_MS: template?.env?.OPENCLAW_CODEX_TIMEOUT_MS ?? doctorAdapterTimeoutMs()
    },
    heartbeatEnabled: template?.heartbeatEnabled ?? true,
    heartbeatIntervalSec: template?.heartbeatIntervalSec ?? 300,
    budgetLimit: null,
    budgetWindow: "monthly",
    lastHeartbeatAt: null,
    createdAt: nowIso(),
    updatedAt: nowIso()
  }
}

function buildEntities(
  repoPath: string,
  agent: Agent,
  laneId: string
): {
  company: Company
  project: Project
  task: Task
} {
  const company: Company = {
    id: "doctor-company",
    name: "OpenClaw Doctor",
    description: "Synthetic operator harness company",
    createdAt: nowIso()
  }
  const project: Project = {
    id: "doctor-project",
    companyId: company.id,
    name: "doctor-project",
    repoPath,
    verifyCommand: null,
    profileId: null,
    profilePath: null,
    profile: {},
    createdAt: nowIso(),
    updatedAt: nowIso()
  }
  const task: Task = {
    id: `doctor-task-${laneId}`,
    companyId: company.id,
    projectId: project.id,
    workflowId: null,
    goalId: null,
    milestoneId: null,
    parentTaskId: null,
    dependsOnTaskIds: [],
    personaId: null,
    stage: null,
    title: `Doctor lane ${laneId}`,
    description: "Validate adapter health and one real execution.",
    labels: ["doctor"],
    changedFiles: [],
    taskPackage: null,
    kind: "user",
    priority: 100,
    scheduledAt: null,
    source: "manual",
    status: "queued",
    assignedAgentId: agent.id,
    requestedAdapterType: agent.adapterType,
    laneId,
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
    createdAt: nowIso(),
    updatedAt: nowIso(),
    completedAt: null
  }
  return { company, project, task }
}

function buildRuntimeIdentity(
  task: Task,
  project: Project,
  agent: Agent,
  session: SessionState | null
): RuntimeIdentityPayload {
  return {
    version: 1,
    runtimeKey: `doctor:${task.id}:${agent.id}`,
    executionKey: `doctor-exec:${randomUUID()}`,
    companyId: task.companyId,
    projectId: project.id,
    projectName: project.name,
    repoPath: project.repoPath,
    taskId: task.id,
    taskKind: task.kind,
    taskTitle: task.title,
    workflowId: task.workflowId,
    laneId: task.laneId,
    agentId: agent.id,
    agentName: agent.name,
    adapterType: agent.adapterType,
    model: agent.model,
    wake: {
      reason: "manual",
      heartbeatJobId: null,
      triggeredAt: nowIso()
    },
    continuation: {
      sessionKey: session?.sessionKey ?? `doctor:${agent.id}:${task.id}`,
      sessionDisplayId: session?.sessionDisplayId ?? null,
      retryCount: task.retryCount,
      attempt: task.retryCount + 1,
      heartbeatEnabled: agent.heartbeatEnabled,
      heartbeatIntervalSec: agent.heartbeatIntervalSec,
      supportsSessionResume: ADAPTERS[agent.adapterType].capabilities.supportsSessionResume,
      nativeContextManagement: ADAPTERS[agent.adapterType].capabilities.nativeContextManagement
    },
    scope: {
      allowedPaths: [],
      requiredReading: [],
      verificationCommands: []
    }
  }
}

function buildContext(input: {
  repoPath: string
  agent: Agent
  prompt: string
  laneId: string
  runId: string
  sessionState: SessionState | null
}): AdapterExecutionContext {
  const { company, project, task } = buildEntities(input.repoPath, input.agent, input.laneId)
  const runtimeIdentity = buildRuntimeIdentity(task, project, input.agent, input.sessionState)
  return {
    company,
    project,
    task,
    agent: input.agent,
    prompt: input.prompt,
    runId: input.runId,
    wakeReason: "manual",
    heartbeatJobId: null,
    triggeredAt: runtimeIdentity.wake.triggeredAt,
    sessionKey: runtimeIdentity.continuation.sessionKey,
    sessionState: input.sessionState,
    runtimeIdentity,
    log: () => undefined
  }
}

function sessionStateFromResult(result: AdapterExecutionResult, agent: Agent, laneId: string): SessionState | null {
  const continuation =
    result.continuation ??
    (result.sessionState
      ? {
          sessionDisplayId: result.sessionDisplayId ?? null,
          state: result.sessionState
        }
      : null)

  if (!continuation) return null
  return {
    sessionKey: `doctor:${agent.id}:${laneId}`,
    id: `doctor:${agent.id}:${laneId}`,
    status: "active",
    companyId: agent.companyId,
    projectId: "doctor-project",
    taskId: `doctor-task-${laneId}`,
    agentId: agent.id,
    adapterType: agent.adapterType,
    sessionDisplayId: continuation.sessionDisplayId,
    state: continuation.state,
    updatedAt: nowIso()
  }
}

function buildExecutionPrompt(spec: DoctorLaneSpec, token: string): string {
  return [
    "OpenClaw operator harness validation.",
    "Do not edit files.",
    "Do not explain your reasoning.",
    `Reply with exactly: DOCTOR_OK ${spec.id} ${token}`
  ].join("\n")
}

function buildSessionSeedPrompt(token: string): string {
  return [
    "OpenClaw continuation validation.",
    "Do not edit files.",
    "Remember this token for the next turn.",
    `Reply with exactly: READY ${token}`
  ].join("\n")
}

function buildSessionResumePrompt(token: string): string {
  return [
    "OpenClaw continuation validation.",
    "Do not edit files.",
    "What token were you asked to remember in the previous turn?",
    `Reply with exactly: ${token}`
  ].join("\n")
}

function responseContainsToken(response: string, token: string): boolean {
  return response.toLowerCase().includes(token.toLowerCase())
}

export function classifyDoctorFailure(input: { stage: DoctorFailure["stage"]; message: string }): DoctorFailureClass {
  const text = input.message.toLowerCase()

  if (input.stage === "planner") return "planner_failed"
  if (input.stage === "recovery") return "recovery_failed"
  if (input.stage === "session" && text.includes("no continuation")) return "session_unavailable"
  if (input.stage === "session") return "session_resume_failed"
  if (text.includes("not found") || text.includes("enoent")) return "binary_missing"
  if (
    text.includes("api key") ||
    text.includes("credential") ||
    text.includes("unauthorized") ||
    text.includes("forbidden") ||
    text.includes("401") ||
    text.includes("403") ||
    text.includes("auth")
  ) {
    return "auth_missing"
  }
  if (
    text.includes("quota") ||
    text.includes("quota_exhausted") ||
    text.includes("rate limit") ||
    text.includes("usage limit") ||
    text.includes("out of credits") ||
    /credits?\s+(?:exhausted|depleted)/.test(text) ||
    text.includes("service_disabled") ||
    text.includes("accessnotconfigured") ||
    text.includes("gemini for google cloud api") ||
    text.includes("429") ||
    text.includes("too many requests")
  ) {
    return "quota_exhausted"
  }
  if (text.includes("timed out") || text.includes("timeout") || text.includes("etimedout")) return "timeout"
  if (text.includes("model") && text.includes("not listed")) return "model_unavailable"
  if (text.includes("http") || text.includes("fetch") || text.includes("econn") || text.includes("enotfound")) {
    return "transport_error"
  }
  if (input.stage === "healthcheck") return "healthcheck_failed"
  if (input.stage === "execution") return "execution_failed"
  return "unknown"
}

function summarizeFailure(stage: DoctorFailure["stage"], message: string): DoctorFailure {
  return {
    class: classifyDoctorFailure({ stage, message }),
    stage,
    message
  }
}

function fakeLocalDoctorAdaptersEnabled(): boolean {
  const raw = process.env.OPENCLAW_DOCTOR_FAKE_LOCAL_ADAPTERS?.trim().toLowerCase()
  return raw === "1" || raw === "true" || raw === "yes"
}

function fakePassingLocalLane(
  spec: DoctorLaneSpec,
  agent: Agent,
  healthcheck: AdapterHealthcheckResult
): DoctorLaneResult {
  return {
    id: spec.id,
    label: spec.label,
    adapterType: spec.adapterType,
    requestedModel: spec.requestedModel,
    modelUsed: agent.model,
    provider: spec.adapterType === "codex_local" ? "codex" : "gemini",
    transportUsed: spec.transport,
    status: "pass",
    healthcheckOk: true,
    healthcheckMessage: healthcheck.message,
    healthcheckLatencyMs: 0,
    executionOk: true,
    sessionOk: spec.expectsSessionResume ? true : null,
    latencyMs: 0,
    responsePreview: `DOCTOR_OK ${spec.id}`,
    sessionDisplayId: `${spec.id}-session`,
    failure: null
  }
}

function getFallbackModelsForAdapter(adapterType: AdapterType, requestedModel: string): string[] {
  let candidates: string[] = []
  if (adapterType === "azure_foundry") {
    try {
      const raw = process.env.OPENCLAW_AZURE_FOUNDRY_ENDPOINTS
      if (raw) {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) {
          for (const endpoint of parsed) {
            if (Array.isArray(endpoint.models)) {
              for (const m of endpoint.models) {
                if (typeof m === "string") candidates.push(m)
              }
            }
          }
        }
      }
    } catch {}
    const defaults = ["Kimi-K2.6", "gpt-5.4-mini", "Kimi-2.6", "gpt-5.4"]
    for (const d of defaults) {
      if (!candidates.includes(d)) candidates.push(d)
    }
  } else if (adapterType === "codex_local") {
    candidates = [
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex-spark"
    ]
  } else if (adapterType === "gemini_local") {
    candidates = ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash-exp"]
  }

  return candidates.filter((m) => m.toLowerCase() !== requestedModel.toLowerCase())
}

async function testModel(
  spec: DoctorLaneSpec,
  model: string,
  repoPath: string,
  template: DoctorAgentTemplate | null
): Promise<{
  ok: boolean
  healthcheckOk: boolean
  healthcheckMessage: string
  healthcheckLatencyMs: number
  executionOk: boolean
  sessionOk: boolean | null
  latencyMs: number
  responsePreview: string | null
  sessionDisplayId: string | null
  modelUsed: string
  provider: string | null
  failure: DoctorFailure | null
}> {
  const adapter = ADAPTERS[spec.adapterType]
  const testSpec = { ...spec, requestedModel: model }
  const agent = buildAgent(testSpec, template)
  const fakeLocalAdapters = fakeLocalDoctorAdaptersEnabled()
  if (fakeLocalAdapters && spec.adapterType === "codex_local") {
    agent.env = { ...agent.env, OPENCLAW_CODEX_ACCOUNT_POOL_ENABLED: "false" }
  }

  const healthcheckStarted = Date.now()
  const healthcheck = await adapter.healthcheck(agent)
  const healthcheckLatencyMs = Date.now() - healthcheckStarted
  if (!healthcheck.ok) {
    return {
      ok: false,
      healthcheckOk: false,
      healthcheckMessage: healthcheck.message,
      healthcheckLatencyMs,
      executionOk: false,
      sessionOk: spec.expectsSessionResume ? false : null,
      latencyMs: 0,
      responsePreview: null,
      sessionDisplayId: null,
      modelUsed: model,
      provider: null,
      failure: summarizeFailure("healthcheck", healthcheck.message)
    }
  }

  if (fakeLocalAdapters && (spec.adapterType === "codex_local" || spec.adapterType === "gemini_local")) {
    const fakeResult = fakePassingLocalLane(testSpec, agent, healthcheck)
    return {
      ok: true,
      healthcheckOk: true,
      healthcheckMessage: healthcheck.message,
      healthcheckLatencyMs: 0,
      executionOk: true,
      sessionOk: spec.expectsSessionResume ? true : null,
      latencyMs: 0,
      responsePreview: fakeResult.responsePreview,
      sessionDisplayId: fakeResult.sessionDisplayId,
      modelUsed: model,
      provider: fakeResult.provider,
      failure: null
    }
  }

  const executionToken = randomUUID().slice(0, 8)
  const executionStarted = Date.now()
  const firstResult = await adapter.execute(
    buildContext({
      repoPath,
      agent,
      prompt: buildExecutionPrompt(testSpec, executionToken),
      laneId: spec.id,
      runId: `doctor-run-${spec.id}-1-fallback`,
      sessionState: null
    })
  )
  let totalLatencyMs = Date.now() - executionStarted

  if (!firstResult.ok) {
    return {
      ok: false,
      healthcheckOk: true,
      healthcheckMessage: healthcheck.message,
      healthcheckLatencyMs,
      executionOk: false,
      sessionOk: spec.expectsSessionResume ? false : null,
      latencyMs: totalLatencyMs,
      responsePreview: (firstResult.response || "").slice(0, 160) || null,
      sessionDisplayId: firstResult.sessionDisplayId ?? null,
      modelUsed: firstResult.metadata?.model ?? model,
      provider: firstResult.metadata?.provider ?? null,
      failure: summarizeFailure("execution", firstResult.error ?? "lane execution failed")
    }
  }

  if (!responseContainsToken(firstResult.response, executionToken)) {
    return {
      ok: false,
      healthcheckOk: true,
      healthcheckMessage: healthcheck.message,
      healthcheckLatencyMs,
      executionOk: false,
      sessionOk: spec.expectsSessionResume ? false : null,
      latencyMs: totalLatencyMs,
      responsePreview: (firstResult.response || "").slice(0, 160) || null,
      sessionDisplayId: firstResult.sessionDisplayId ?? null,
      modelUsed: firstResult.metadata?.model ?? model,
      provider: firstResult.metadata?.provider ?? null,
      failure: summarizeFailure("execution", `unexpected response payload: ${firstResult.response.slice(0, 200)}`)
    }
  }

  let sessionOk: boolean | null = null
  let responsePreview = (firstResult.response || "").slice(0, 160) || null
  if (spec.expectsSessionResume) {
    const sessionToken = randomUUID().slice(0, 8)
    const seedStarted = Date.now()
    const seeded = await adapter.execute(
      buildContext({
        repoPath,
        agent,
        prompt: buildSessionSeedPrompt(sessionToken),
        laneId: spec.id,
        runId: `doctor-run-${spec.id}-session-seed-fallback`,
        sessionState: null
      })
    )
    totalLatencyMs += Date.now() - seedStarted

    const continuationState = seeded.ok ? sessionStateFromResult(seeded, agent, spec.id) : null
    if (!seeded.ok) {
      return {
        ok: false,
        healthcheckOk: true,
        healthcheckMessage: healthcheck.message,
        healthcheckLatencyMs,
        executionOk: true,
        sessionOk: false,
        latencyMs: totalLatencyMs,
        responsePreview,
        sessionDisplayId: seeded.sessionDisplayId ?? null,
        modelUsed: seeded.metadata?.model ?? firstResult.metadata?.model ?? model,
        provider: seeded.metadata?.provider ?? firstResult.metadata?.provider ?? null,
        failure: summarizeFailure("session", seeded.error ?? "session seed execution failed")
      }
    }
    if (!continuationState) {
      return {
        ok: false,
        healthcheckOk: true,
        healthcheckMessage: healthcheck.message,
        healthcheckLatencyMs,
        executionOk: true,
        sessionOk: false,
        latencyMs: totalLatencyMs,
        responsePreview,
        sessionDisplayId: null,
        modelUsed: seeded.metadata?.model ?? firstResult.metadata?.model ?? model,
        provider: seeded.metadata?.provider ?? firstResult.metadata?.provider ?? null,
        failure: summarizeFailure("session", "no continuation state returned by adapter")
      }
    }

    const resumeStarted = Date.now()
    const resumed = await adapter.execute(
      buildContext({
        repoPath,
        agent,
        prompt: buildSessionResumePrompt(sessionToken),
        laneId: spec.id,
        runId: `doctor-run-${spec.id}-session-resume-fallback`,
        sessionState: continuationState
      })
    )
    totalLatencyMs += Date.now() - resumeStarted
    responsePreview = (resumed.response || "").slice(0, 160) || responsePreview
    sessionOk = resumed.ok && responseContainsToken(resumed.response, sessionToken)
    if (!sessionOk) {
      return {
        ok: false,
        healthcheckOk: true,
        healthcheckMessage: healthcheck.message,
        healthcheckLatencyMs,
        executionOk: true,
        sessionOk: false,
        latencyMs: totalLatencyMs,
        responsePreview,
        sessionDisplayId: resumed.sessionDisplayId ?? continuationState.sessionDisplayId,
        modelUsed: resumed.metadata?.model ?? seeded.metadata?.model ?? firstResult.metadata?.model ?? model,
        provider: resumed.metadata?.provider ?? seeded.metadata?.provider ?? firstResult.metadata?.provider ?? null,
        failure: summarizeFailure(
          "session",
          resumed.ok
            ? `session token was not recovered from resumed context: ${resumed.response.slice(0, 200)}`
            : (resumed.error ?? "resume execution failed")
        )
      }
    }
  }

  return {
    ok: true,
    healthcheckOk: true,
    healthcheckMessage: healthcheck.message,
    healthcheckLatencyMs,
    executionOk: true,
    sessionOk,
    latencyMs: totalLatencyMs,
    responsePreview,
    sessionDisplayId: firstResult.sessionDisplayId ?? null,
    modelUsed: firstResult.metadata?.model ?? model,
    provider: firstResult.metadata?.provider ?? null,
    failure: null
  }
}

async function executeLane(
  spec: DoctorLaneSpec,
  repoPath: string,
  template: DoctorAgentTemplate | null,
  store: DispatcherStore | null
): Promise<DoctorLaneResult> {
  const primaryResult = await testModel(spec, spec.requestedModel, repoPath, template)
  if (primaryResult.ok) {
    return {
      id: spec.id,
      label: spec.label,
      adapterType: spec.adapterType,
      requestedModel: spec.requestedModel,
      modelUsed: primaryResult.modelUsed,
      provider: primaryResult.provider,
      transportUsed: spec.transport,
      status: "pass",
      healthcheckOk: primaryResult.healthcheckOk,
      healthcheckMessage: primaryResult.healthcheckMessage,
      healthcheckLatencyMs: primaryResult.healthcheckLatencyMs,
      executionOk: primaryResult.executionOk,
      sessionOk: primaryResult.sessionOk,
      latencyMs: primaryResult.latencyMs,
      responsePreview: primaryResult.responsePreview,
      sessionDisplayId: primaryResult.sessionDisplayId,
      failure: null
    }
  }

  // Attempt self-healing / fallback if store is available
  if (store) {
    const fallbacks = getFallbackModelsForAdapter(spec.adapterType, spec.requestedModel)
    for (const fallbackModel of fallbacks) {
      const fallbackResult = await testModel(spec, fallbackModel, repoPath, template)
      if (fallbackResult.ok) {
        // Heal by updating the corresponding agent(s) in the database
        const project = store.findProjectByRepoPath(repoPath)
        if (project) {
          const scopedAgents = store.listAgents(project.companyId)
          const targetAgents = scopedAgents.filter(
            (a) =>
              a.adapterType === spec.adapterType &&
              (a.model === spec.requestedModel || (template && a.id === template.id))
          )
          for (const targetAgent of targetAgents) {
            store.updateAgent(targetAgent.id, { model: fallbackResult.modelUsed })
          }
        }

        return {
          id: spec.id,
          label: spec.label,
          adapterType: spec.adapterType,
          requestedModel: spec.requestedModel,
          modelUsed: fallbackResult.modelUsed,
          provider: fallbackResult.provider,
          transportUsed: spec.transport,
          status: "pass",
          healthcheckOk: fallbackResult.healthcheckOk,
          healthcheckMessage: fallbackResult.healthcheckMessage,
          healthcheckLatencyMs: fallbackResult.healthcheckLatencyMs,
          executionOk: fallbackResult.executionOk,
          sessionOk: fallbackResult.sessionOk,
          latencyMs: fallbackResult.latencyMs,
          responsePreview: fallbackResult.responsePreview,
          sessionDisplayId: fallbackResult.sessionDisplayId,
          failure: null,
          healed: {
            originalModel: spec.requestedModel,
            workingModel: fallbackResult.modelUsed,
            message: `switched agent model from ${spec.requestedModel} to ${fallbackResult.modelUsed}`
          }
        }
      }
    }
  }

  // Fallback to original failed result if nothing worked
  return {
    id: spec.id,
    label: spec.label,
    adapterType: spec.adapterType,
    requestedModel: spec.requestedModel,
    modelUsed: primaryResult.modelUsed,
    provider: primaryResult.provider,
    transportUsed: spec.transport,
    status: "fail",
    healthcheckOk: primaryResult.healthcheckOk,
    healthcheckMessage: primaryResult.healthcheckMessage,
    healthcheckLatencyMs: primaryResult.healthcheckLatencyMs,
    executionOk: primaryResult.executionOk,
    sessionOk: primaryResult.sessionOk,
    latencyMs: primaryResult.latencyMs,
    responsePreview: primaryResult.responsePreview,
    sessionDisplayId: primaryResult.sessionDisplayId,
    failure: primaryResult.failure
  }
}

function fakeAdapter(type: AdapterType, execute: AdapterDefinition["execute"]): AdapterDefinition {
  const capabilities = ADAPTERS[type].capabilities
  return {
    type,
    label: ADAPTERS[type].label,
    capabilities,
    prepare: async () => ({ argv: [], cwd: process.cwd(), env: process.env }),
    execute,
    resume: async (sessionState) => sessionState?.state ?? null,
    parseResult: (stdout, stderr) => ({ ok: true, response: stdout, stdout, stderr }),
    healthcheck: async () => ({ ok: true, message: "ok" })
  }
}

async function runPlannerSyntheticCheck(): Promise<DoctorSyntheticCheck> {
  const started = Date.now()
  const fixture = createSyntheticDoctorRepo()
  const dbPath = join(fixture.root, "planner-doctor.db")
  try {
    const store = new DispatcherStore(dbPath)
    store.migrate()
    mkdirSync(join(fixture.root, ".openclaw"), { recursive: true })
    writeFileSync(
      join(fixture.root, ".openclaw", "profile.json"),
      JSON.stringify(loadProjectProfile("minimal-repo"), null, 2),
      "utf8"
    )

    const company = store.createCompany({ name: "Doctor Planner" })
    const project = store.createProject({
      companyRef: company.id,
      name: "planner",
      repoPath: fixture.root,
      verifyCommand: null
    })
    store.createAgent({
      companyRef: company.id,
      name: "planner",
      role: "Planner",
      adapterType: "codex_local"
    })
    store.createPersona({
      companyRef: company.id,
      name: "planner",
      stage: "planner",
      preferredAdapterType: "codex_local"
    })

    const executor = new DispatcherExecutor(store, {
      codex_local: fakeAdapter("codex_local", async (context) => ({
        ok: true,
        response: JSON.stringify({
          version: 1,
          summary: "doctor planner generated one task",
          candidates: [
            {
              title: "Doctor planner candidate",
              description: "Synthetic planner validation candidate.",
              kind: "implement",
              lane: "app-core",
              personaId: null,
              preferredAdapterType: "codex_local",
              priority: 70,
              requiredReading: ["README.md"],
              verificationChecklist: ["echo doctor-planner-ok"],
              contractUpdateReminders: [],
              repoNotes: [],
              dependencies: [],
              tags: ["planner-generated"],
              riskLevel: "low",
              governanceClass: "normal",
              dedupeKey: "doctor:planner:candidate",
              sourceSignals: [context.task.title],
              estimatedCost: 1,
              createMode: "queue_now"
            }
          ]
        })
      })),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" })),
      azure_foundry: fakeAdapter("azure_foundry", async () => ({ ok: true, response: "unused" }))
    })

    const result = await executor.runPlannerRefresh(project.id)
    const plannerRuns = store.listRecentPlannerRuns(project.id, 1)
    const createdTasks = store.listProjectTasks(project.id).filter((task) => task.labels.includes("planner-generated"))
    if (plannerRuns.length !== 1 || result.createdTasks !== 1 || createdTasks.length !== 1) {
      return {
        id: "planner",
        label: "synthetic planner orchestration",
        status: "fail",
        latencyMs: Date.now() - started,
        failure: summarizeFailure("planner", "planner refresh did not materialize the expected task"),
        details: {
          createdTasks: result.createdTasks,
          plannerRuns: plannerRuns.length,
          plannerGeneratedTasks: createdTasks.length
        }
      }
    }

    return {
      id: "planner",
      label: "synthetic planner orchestration",
      status: "pass",
      latencyMs: Date.now() - started,
      failure: null,
      details: {
        plannerRunId: result.plannerRunId,
        createdTasks: result.createdTasks
      }
    }
  } catch (error) {
    return {
      id: "planner",
      label: "synthetic planner orchestration",
      status: "fail",
      latencyMs: Date.now() - started,
      failure: summarizeFailure("planner", error instanceof Error ? error.message : String(error)),
      details: {}
    }
  } finally {
    fixture.cleanup()
  }
}

async function runRecoverySyntheticCheck(): Promise<DoctorSyntheticCheck> {
  const started = Date.now()
  const fixture = createSyntheticDoctorRepo()
  const dbPath = join(fixture.root, "recovery-doctor.db")
  const previousThreshold = process.env.OPENCLAW_STALE_RUN_THRESHOLD_MS
  try {
    const store = new DispatcherStore(dbPath)
    store.migrate()
    const company = store.createCompany({ name: "Doctor Recovery" })
    const project = store.createProject({
      companyRef: company.id,
      name: "recovery",
      repoPath: fixture.root,
      verifyCommand: null
    })
    const agent = store.createAgent({
      companyRef: company.id,
      name: "codex",
      role: "Engineer",
      adapterType: "codex_local"
    })

    const staleTask = store.createTask({
      projectRef: project.id,
      title: "Stale task",
      requestedAdapterType: "codex_local"
    })
    const staleLease = store.claimTask(staleTask.id, { ownerAgentId: agent.id })
    if (!staleLease) {
      throw new Error("could not create stale claim")
    }
    const staleRun = store.createRun({
      companyId: company.id,
      projectId: project.id,
      taskId: staleTask.id,
      agentId: agent.id,
      adapterType: "codex_local",
      sessionKey: `${agent.id}:${project.id}:${staleTask.id}`
    })
    const staleTimestamp = new Date(Date.now() - 60_000).toISOString()
    store.updateTaskStatus(staleTask.id, "running", {
      claimStatus: "claimed",
      claimToken: staleLease.claimToken,
      claimExpiresAt: new Date(Date.now() - 30_000).toISOString(),
      claimOwnerRunId: staleRun.id,
      claimOwnerAgentId: agent.id,
      claimedAt: staleTimestamp
    })

    process.env.OPENCLAW_STALE_RUN_THRESHOLD_MS = "1"

    const executor = new DispatcherExecutor(store, {
      codex_local: fakeAdapter("codex_local", async () => ({ ok: true, response: "done" })),
      gemini_local: fakeAdapter("gemini_local", async () => ({ ok: true, response: "unused" })),
      azure_foundry: fakeAdapter("azure_foundry", async () => ({ ok: true, response: "unused" }))
    })

    const freshTask = store.createTask({
      projectRef: project.id,
      title: "Fresh task",
      requestedAdapterType: "codex_local"
    })
    const summary = await executor.tick(company.id)
    const staleAfter = store.getTaskById(staleTask.id)
    const freshAfter = store.getTaskById(freshTask.id)
    if (
      summary.executedRuns < 1 ||
      staleAfter.lastRecoveryReason !== "stale_run_reaped" ||
      freshAfter.status !== "done"
    ) {
      return {
        id: "recovery",
        label: "synthetic queue recovery",
        status: "fail",
        latencyMs: Date.now() - started,
        failure: summarizeFailure("recovery", "stale run recovery did not unblock the queue as expected"),
        details: {
          executedRuns: summary.executedRuns,
          staleRecoveryReason: staleAfter.lastRecoveryReason,
          freshStatus: freshAfter.status
        }
      }
    }

    return {
      id: "recovery",
      label: "synthetic queue recovery",
      status: "pass",
      latencyMs: Date.now() - started,
      failure: null,
      details: {
        executedRuns: summary.executedRuns,
        staleRecoveryReason: staleAfter.lastRecoveryReason
      }
    }
  } catch (error) {
    return {
      id: "recovery",
      label: "synthetic queue recovery",
      status: "fail",
      latencyMs: Date.now() - started,
      failure: summarizeFailure("recovery", error instanceof Error ? error.message : String(error)),
      details: {}
    }
  } finally {
    if (previousThreshold === undefined) delete process.env.OPENCLAW_STALE_RUN_THRESHOLD_MS
    else process.env.OPENCLAW_STALE_RUN_THRESHOLD_MS = previousThreshold
    fixture.cleanup()
  }
}

function runDoctorModuleChecks(repoPath: string, store: DispatcherStore | null): DoctorModuleCheck[] {
  const checks: DoctorModuleCheck[] = []

  checks.push({
    id: "repo_path",
    label: "repository path",
    status: existsSync(repoPath) ? "pass" : "fail",
    failure: existsSync(repoPath)
      ? null
      : summarizeFailure("healthcheck", `Repository path does not exist: ${repoPath}`),
    details: { repoPath }
  })

  if (store) {
    try {
      const row = store.db.prepare("SELECT 1 AS ok").get() as { ok?: number }
      checks.push({
        id: "database",
        label: "dispatcher database",
        status: row.ok === 1 ? "pass" : "fail",
        failure: row.ok === 1 ? null : summarizeFailure("healthcheck", "Dispatcher database did not respond."),
        details: { dbPath: store.dbPath }
      })
    } catch (error) {
      checks.push({
        id: "database",
        label: "dispatcher database",
        status: "fail",
        failure: summarizeFailure("healthcheck", error instanceof Error ? error.message : String(error)),
        details: { dbPath: store.dbPath }
      })
    }

    checks.push({
      id: "backup",
      label: "runtime backup",
      status: existsSync(store.dbPath) ? "pass" : "fail",
      failure: existsSync(store.dbPath)
        ? null
        : summarizeFailure("healthcheck", `Dispatcher database file is not present: ${store.dbPath}`),
      details: { dbPath: store.dbPath }
    })
  }

  return checks
}

export function aggregateDoctorReport(input: Omit<DoctorReport, "exitCode" | "summary">): DoctorReport {
  const passed = input.lanes.filter((lane) => lane.status === "pass").length
  const failed = input.lanes.length - passed
  const syntheticFailures = input.syntheticChecks.filter((check) => check.status === "fail").length
  return {
    ...input,
    exitCode: failed > 0 || syntheticFailures > 0 ? 1 : 0,
    summary: {
      passed,
      failed,
      total: input.lanes.length
    }
  }
}

function formatLatency(ms: number): string {
  return `${ms}ms`
}

export function renderDoctorSummary(report: DoctorReport): string[] {
  const lines = [
    "OpenClaw doctor",
    `repo: ${report.repoPath}`,
    `mode: ${report.syntheticRepo ? "synthetic" : "live-repo"}`,
    `summary: ${report.summary.passed}/${report.summary.total} lane checks passed`,
    ""
  ]

  if (report.wrapper.repo || report.wrapper.db) {
    lines.push("Wrapper:")
    lines.push(`dispatcher wrapper: ok`)
    lines.push(`repo: ${report.wrapper.repo ?? report.repoPath}`)
    lines.push(`db: ${report.wrapper.db ?? "n/a"}`)
    lines.push(`framework: ${report.wrapper.framework ?? "embedded default"}`)
    lines.push("")
  }

  if (report.moduleChecks.length > 0) {
    lines.push("Checks:")
    for (const check of report.moduleChecks) {
      lines.push([check.label, check.status.toUpperCase(), check.failure?.message ?? "-"].join(" | "))
    }
    lines.push("")
  }

  lines.push("Matrix:")
  lines.push("lane | status | latency | model | transport | root_cause")
  for (const lane of report.lanes) {
    const statusLabel = lane.healed ? "HEALED" : lane.status.toUpperCase()
    lines.push(
      [
        lane.label,
        statusLabel,
        formatLatency(lane.latencyMs),
        lane.modelUsed ?? lane.requestedModel,
        lane.transportUsed,
        lane.healed ? lane.healed.message : (lane.failure?.message ?? "-")
      ].join(" | ")
    )
  }

  if (report.syntheticChecks.length > 0) {
    lines.push("")
    lines.push("Synthetic checks:")
    for (const check of report.syntheticChecks) {
      lines.push(
        [check.label, check.status.toUpperCase(), formatLatency(check.latencyMs), check.failure?.message ?? "-"].join(
          " | "
        )
      )
    }
  }

  if (report.loopReadiness) {
    const lr = report.loopReadiness
    const bar = "█".repeat(Math.round(lr.score / 5)) + "░".repeat(20 - Math.round(lr.score / 5))
    lines.push("")
    lines.push("Loop Readiness:")
    lines.push(`score: ${lr.score}/100  [${bar}]`)
    lines.push(`level: ${lr.level} - ${lr.levelDescription}`)
    for (const c of lr.checks) {
      const status = c.passed ? "[PASS]" : "[FAIL]"
      lines.push(`${status.padEnd(7)} ${c.name} (${c.pointsEarned}/${c.pointsPossible} pts)`)
    }
    if (lr.recommendations.length > 0) {
      lines.push("")
      lines.push("Recommendations:")
      for (const r of lr.recommendations) {
        lines.push(r)
      }
    }
  }

  lines.push("")
  lines.push(`exit_code: ${report.exitCode}`)
  return lines
}

export async function runDoctor(options: RunDoctorOptions = {}): Promise<DoctorReport> {
  const startedAt = nowIso()
  const fixture = options.repoPath ? null : createSyntheticDoctorRepo()
  const repoPath = resolve(options.repoPath ?? fixture!.root)
  const lanes: DoctorLaneResult[] = []
  const syntheticChecks: DoctorSyntheticCheck[] = []

  try {
    for (const spec of DOCTOR_LANES) {
      const template = chooseTemplateAgent(options.store ?? null, spec.adapterType, spec.requestedModel, repoPath)
      lanes.push(await executeLane(spec, repoPath, template, options.store ?? null))
    }

    if (options.store) {
      const project = options.store.findProjectByRepoPath(repoPath)
      if (project) {
        for (const lane of lanes) {
          options.store.upsertAdapterLaneHealth({
            companyId: project.companyId,
            adapterType: lane.adapterType,
            laneKey: `doctor-lane-${lane.id}`,
            laneLabel: lane.label,
            status: lane.status === "pass" ? "healthy" : "degraded",
            reason: lane.status === "pass" ? null : (lane.failure?.message ?? "Lane check failed"),
            lastError: lane.status === "pass" ? null : (lane.failure?.message ?? "Lane check failed"),
            lastSuccessAt: lane.status === "pass" ? nowIso() : null,
            lastCheckedAt: nowIso(),
            metadata: {
              model: lane.modelUsed ?? lane.requestedModel,
              failureCategory: lane.failure?.class ?? null,
              provider: lane.provider ?? null,
              healed: lane.healed ?? null
            }
          })
        }
      }
    }

    if (options.includeRecovery) {
      syntheticChecks.push(await runRecoverySyntheticCheck())
    }
    if (options.includePlanner) {
      syntheticChecks.push(await runPlannerSyntheticCheck())
    }

    return aggregateDoctorReport({
      version: 1,
      startedAt,
      finishedAt: nowIso(),
      repoPath,
      syntheticRepo: fixture !== null,
      lanes,
      syntheticChecks,
      moduleChecks: runDoctorModuleChecks(repoPath, options.store ?? null),
      loopReadiness: auditProject(repoPath, options.store ?? null),
      wrapper: {
        repo: process.env.OPENCLAW_DOCTOR_WRAPPER_REPO ?? null,
        db: process.env.OPENCLAW_DOCTOR_WRAPPER_DB ?? null,
        framework: process.env.OPENCLAW_DOCTOR_WRAPPER_FRAMEWORK ?? null
      }
    })
  } finally {
    fixture?.cleanup()
  }
}
