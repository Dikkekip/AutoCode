import { readFileSync, realpathSync } from "node:fs"
import type { NativeAutonomyPolicy } from "@openclaw/domain"
import { nativeCoderAgentIds } from "@openclaw/domain"
import { assertExecutionOwnership } from "@openclaw/os-adapters"
import { loadNativePolicy, nativeDoctor } from "./doctor.js"
import { type NativeCard, type NativeGateway, nativeCards, nativeObject } from "./gateway.js"
import { nativeGovernanceDigest, requireNativeHuman } from "./governance.js"
import type { NativeAutonomyRuntime } from "./runtime.js"
import { nativeRuntimeGeneration } from "./runtime-lifetime.js"
import { NATIVE_SKILL_CONTRACT_VERSION, nativeSkillPolicyDigest } from "./skills.js"

export interface NativePolicyRefreshPlan {
  version: 1
  boardId: string
  loadedDigest: string
  candidateDigest: string
  controlRevision: string
  runtimeGeneration: string
}
export const nativeLoadedPolicyDigest = (policy: NativeAutonomyPolicy) => nativeGovernanceDigest(policy)
const agents = (policy: NativeAutonomyPolicy) =>
  [
    policy.plannerAgentId,
    ...nativeCoderAgentIds(policy),
    policy.reviewerAgentId,
    ...policy.personas.flatMap((p) => [p.personaId, p.investigationAgentId ?? p.personaId])
  ].sort()
const roleTopology = (policy: NativeAutonomyPolicy) => ({
  planner: policy.plannerAgentId,
  primaryCoder: policy.coderAgentId,
  coders: nativeCoderAgentIds(policy),
  reviewer: policy.reviewerAgentId,
  investigations: policy.personas
    .map((persona) => [persona.personaId, persona.investigationAgentId ?? persona.personaId])
    .sort(([a], [b]) => a!.localeCompare(b!))
})
function candidate(runtime: NativeAutonomyRuntime, file: string): NativeAutonomyPolicy {
  const value = loadNativePolicy(file)
  if (
    value.boardId !== runtime.policy.boardId ||
    realpathSync(value.repository) !== realpathSync(runtime.policy.repository) ||
    value.repository !== runtime.policy.repository ||
    value.baseBranch !== runtime.policy.baseBranch ||
    value.repositoryKind !== runtime.policy.repositoryKind ||
    JSON.stringify(roleTopology(value)) !== JSON.stringify(roleTopology(runtime.policy))
  ) {
    throw new Error("Policy refresh cannot change board, repository, base, or agent topology")
  }
  return value
}
export function nativeSkillBindingStatus(runtime: NativeAutonomyRuntime, policy = runtime.policy) {
  if (!policy.quality) return { ok: true, required: false }
  const digest = nativeGovernanceDigest(readFileSync(policy.quality.skillPath, "utf8"))
  const active = runtime.store.get<{ digest: string; policyDigest: string; contractVersion: number }>(
    "active-skill",
    policy.boardId
  )
  return {
    ok:
      active?.digest === digest &&
      active.policyDigest === nativeSkillPolicyDigest(policy) &&
      active.contractVersion === NATIVE_SKILL_CONTRACT_VERSION,
    required: true
  }
}
export function assertNativeSkillBinding(runtime: NativeAutonomyRuntime) {
  if (!nativeSkillBindingStatus(runtime).ok)
    throw new Error("Skill or policy changed; evaluated human promotion required before resume or execution")
}
export function planNativePolicyRefresh(runtime: NativeAutonomyRuntime, file: string): NativePolicyRefreshPlan {
  const control = runtime.control.state
  if (!control.paused || runtime.store.get<{ paused: boolean }>("control", "pause")?.paused !== true)
    throw new Error("Pause native execution before policy refresh")
  const value = candidate(runtime, file)
  return {
    version: 1,
    boardId: runtime.policy.boardId,
    loadedDigest: nativeLoadedPolicyDigest(runtime.policy),
    candidateDigest: nativeLoadedPolicyDigest(value),
    controlRevision: control.revision,
    runtimeGeneration: nativeRuntimeGeneration(runtime)
  }
}
function validatePlan(value: unknown): asserts value is NativePolicyRefreshPlan {
  const p = nativeObject(value, "Policy refresh plan")
  if (
    Object.keys(p).sort().join(",") !==
      "boardId,candidateDigest,controlRevision,loadedDigest,runtimeGeneration,version" ||
    p.version !== 1 ||
    typeof p.boardId !== "string" ||
    typeof p.controlRevision !== "string" ||
    typeof p.runtimeGeneration !== "string" ||
    !/^[a-f0-9]{64}$/.test(String(p.loadedDigest)) ||
    !/^[a-f0-9]{64}$/.test(String(p.candidateDigest))
  )
    throw new Error("Invalid exact policy refresh plan")
}
function localIdle(runtime: NativeAutonomyRuntime) {
  if (runtime.store.db.prepare("SELECT 1 FROM native_locks WHERE expires_at>? LIMIT 1").get(Date.now()))
    throw new Error("Native operation lease remains active")
  for (const kind of ["operation", "effect-intent"]) {
    if (runtime.store.list<{ state?: string }>(kind).some(({ value }) => value.state !== "confirmed"))
      throw new Error("Uncertain native effects require reconciliation before policy refresh")
  }
}
// Public Workboard updates may clear the current association while preserving
// the protected accepted launch and attempts. Attempt endedAt is bookkeeping:
// terminal execution updates rewrite it; the session remains the execution clock.
function historicalAcceptedRun(card: NativeCard) {
  const raw = (card.metadata?.automation as Record<string, unknown> | undefined)?.launch
  if (raw == null) return undefined
  const launch = nativeObject(raw, "Workboard launch")
  if (
    launch.phase !== "accepted" ||
    [card.execution, card.sessionKey, card.runId, card.startedAt].some((v) => v != null)
  )
    return undefined
  const nonempty = (value: unknown): value is string => typeof value === "string" && Boolean(value.trim())
  if (
    !nonempty(launch.acceptedSessionKey) ||
    !nonempty(launch.acceptedRunId) ||
    launch.requestedSessionKey !== launch.acceptedSessionKey ||
    launch.provisionalRunId !== launch.acceptedRunId ||
    !Number.isFinite(launch.preparedAt) ||
    launch.preparedAt < 0 ||
    !Number.isFinite(launch.acceptedAt) ||
    launch.acceptedAt < launch.preparedAt
  )
    throw new Error("Historical accepted launch identity or timing is uncertain")
  const attempts = (card.metadata as Record<string, unknown> | undefined)?.attempts
  if (!Array.isArray(attempts)) throw new Error("Historical accepted launch lacks terminal attempt")
  const matching = attempts.filter((a) => a?.id === launch.acceptedRunId || a?.runId === launch.acceptedRunId)
  const attempt = matching[0]
  if (
    matching.length !== 1 ||
    !attempt ||
    attempt.id !== launch.acceptedRunId ||
    attempt.runId !== launch.acceptedRunId ||
    attempt.sessionKey !== launch.acceptedSessionKey ||
    !["succeeded", "failed", "blocked", "stopped"].includes(attempt.status) ||
    !Number.isFinite(attempt.startedAt) ||
    attempt.startedAt < 0 ||
    attempt.startedAt > launch.acceptedAt ||
    !Number.isFinite(attempt.endedAt) ||
    attempt.endedAt! < attempt.startedAt
  )
    throw new Error("Historical accepted launch lacks unique terminal attempt proof")
  return {
    key: launch.acceptedSessionKey as string,
    run: launch.acceptedRunId as string,
    started: Math.max(attempt.startedAt, launch.acceptedAt)
  }
}
const SESSION_PAGE_SIZE = 1000
const MAX_SESSION_ROWS = 10000

async function remoteIdle(runtime: NativeAutonomyRuntime, gateway: NativeGateway) {
  const first = await nativeCards(gateway, runtime.policy.boardId)
  const checkCards = (cards: typeof first) => {
    if (
      cards.some(
        (c) =>
          ["running", "ready", "scheduled"].includes(c.status) ||
          ["pending", "running"].includes(c.execution?.status ?? "")
      )
    )
      throw new Error("Owned Workboard work is not quiescent")
  }
  checkCards(first)
  const ownedAgents = new Set(agents(runtime.policy))
  const historical = new Map(first.map((card) => [card.id, historicalAcceptedRun(card)]))
  const ownedKeys = new Set(
    first.flatMap((c) => [c.sessionKey, c.execution?.sessionKey, historical.get(c.id)?.key]).filter(Boolean)
  )
  const seen = new Set<string>()
  const ownedSessions = new Map<string, Record<string, any>>()
  let offset = 0
  let expectedTotal: number | undefined
  for (let page = 0; page < 50; page++) {
    const result = nativeObject(
      await gateway.request("sessions.list", {
        limit: SESSION_PAGE_SIZE,
        offset,
        archived: "all",
        includeGlobal: true,
        includeUnknown: true,
        configuredAgentsOnly: false
      }),
      "Policy refresh sessions"
    )
    if (
      !Array.isArray(result.sessions) ||
      result.sessions.length > SESSION_PAGE_SIZE ||
      seen.size + result.sessions.length > MAX_SESSION_ROWS ||
      typeof result.hasMore !== "boolean" ||
      !Number.isSafeInteger(result.totalCount) ||
      result.totalCount < 0 ||
      result.totalCount > MAX_SESSION_ROWS ||
      (expectedTotal !== undefined && expectedTotal !== result.totalCount)
    )
      throw new Error("Incomplete or changing session listing")
    expectedTotal = result.totalCount
    for (const raw of result.sessions) {
      const s = nativeObject(raw, "Policy refresh session")
      if (typeof s.key !== "string" || seen.has(s.key)) throw new Error("Duplicate or missing session identity")
      seen.add(s.key)
      if (ownedAgents.has(s.agentId) || ownedKeys.has(s.key)) {
        ownedSessions.set(s.key, s)
        if (
          s.hasActiveRun !== false ||
          (s.hasActiveSubagentRun !== false && s.hasActiveSubagentRun !== undefined) ||
          !Array.isArray(s.activeRunIds) ||
          s.activeRunIds.length ||
          ["running", "pending", "queued"].includes(s.status)
        )
          throw new Error("Owned agent session is active or ambiguous")
      }
    }
    if (!result.hasMore) {
      if (seen.size !== expectedTotal || result.nextOffset != null) throw new Error("Incomplete session pagination")
      if ([...ownedKeys].some((key) => !seen.has(key!)))
        throw new Error("Owned card session is missing from complete listing")
      for (const card of first) {
        const rawLaunch = (card.metadata?.automation as Record<string, unknown> | undefined)?.launch
        const launch = rawLaunch == null ? undefined : nativeObject(rawLaunch, "Workboard launch")
        const archived = historical.get(card.id)
        const key = card.execution?.sessionKey ?? card.sessionKey ?? archived?.key
        const run = card.execution?.runId ?? card.runId ?? archived?.run
        const executionAgent = (card.execution as Record<string, unknown> | undefined)?.agentId
        if (
          (card.sessionKey && card.execution?.sessionKey && card.sessionKey !== card.execution.sessionKey) ||
          (card.runId && card.execution?.runId && card.runId !== card.execution.runId) ||
          (executionAgent != null && executionAgent !== card.agentId)
        )
          throw new Error("Contradictory Workboard execution identity")

        if (
          launch?.phase === "accepted" &&
          (launch.acceptedSessionKey !== key || launch.acceptedRunId !== run || !key || !run)
        )
          throw new Error("Accepted Workboard launch identity is uncertain")
        if (card.status === "review" && (!key || !run)) throw new Error("Review card lacks exact terminal run identity")
        if (run) {
          const session = key ? ownedSessions.get(key) : undefined
          const started = card.execution?.startedAt ?? card.startedAt ?? archived?.started
          if (
            !session ||
            typeof card.agentId !== "string" ||
            session.agentId !== card.agentId ||
            !Number.isFinite(started) ||
            !Number.isFinite(session.endedAt) ||
            session.endedAt < started! ||
            !["done", "completed", "failed", "cancelled", "timed_out", "timeout", "killed"].includes(session.status)
          )
            throw new Error("Owned accepted run lacks terminal session proof")
        }
      }
      const last = await nativeCards(gateway, runtime.policy.boardId)
      checkCards(last)
      if (nativeGovernanceDigest(first) !== nativeGovernanceDigest(last))
        throw new Error("Workboard changed during policy refresh")
      return { cards: first.length, sessions: seen.size }
    }
    if (
      !Number.isSafeInteger(result.nextOffset) ||
      result.nextOffset !== offset + result.sessions.length ||
      result.nextOffset <= offset
    )
      throw new Error("Invalid session pagination")
    offset = result.nextOffset
  }
  throw new Error("Session pagination exceeds bounded refresh proof")
}
/** Called only inside the plugin's exclusive runtime-lifetime barrier. */
export async function applyNativePolicyRefresh(
  runtime: NativeAutonomyRuntime,
  file: string,
  rawPlan: unknown,
  operatorId: string,
  reason: string,
  gateway: NativeGateway,
  prepare: (policy: NativeAutonomyPolicy) => () => void,
  assertGeneration: () => void
) {
  validatePlan(rawPlan)
  if (typeof reason !== "string" || reason.length > 2000) throw new Error("Bounded policy refresh reason required")
  requireNativeHuman({ operatorId, rationale: reason }, agents(runtime.policy))
  const assertPlan = () => {
    assertGeneration()
    if (nativeGovernanceDigest(planNativePolicyRefresh(runtime, file)) !== nativeGovernanceDigest(rawPlan))
      throw new Error("Policy or pause revision changed; generate a fresh refresh plan")
  }
  assertPlan()
  return runtime.withOwnership(async () => {
    assertExecutionOwnership()
    localIdle(runtime)
    const evidence = await remoteIdle(runtime, gateway)
    const next = candidate(runtime, file)
    const doctor = await nativeDoctor(next, gateway)
    if (!doctor.ok)
      throw new Error(`Policy refresh doctor failed: ${JSON.stringify(doctor.checks.filter((c) => !c.ok))}`)
    // Recheck remote state after slow doctor calls and local authority just before publication.
    await remoteIdle(runtime, gateway)
    assertPlan()
    localIdle(runtime)
    assertExecutionOwnership()
    const skillBinding = nativeSkillBindingStatus(runtime, next)
    const publish = prepare(next)
    runtime.store.commit(
      [],
      {
        kind: "policy.refreshed",
        subject: runtime.policy.boardId,
        value: { ...rawPlan, operatorId, reason, evidence, skillBinding, paused: true }
      },
      undefined,
      () => {
        assertPlan()
        localIdle(runtime)
        assertExecutionOwnership()
      }
    )
    publish()
    return {
      ...rawPlan,
      loadedDigest: nativeLoadedPolicyDigest(next),
      previousDigest: rawPlan.loadedDigest,
      control: runtime.control.state,
      skillBinding,
      doctor,
      requiresPromotion: !skillBinding.ok
    }
  })
}
