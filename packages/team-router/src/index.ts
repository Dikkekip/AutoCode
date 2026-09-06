/**
 * Team Router / Swarm Orchestrator
 *
 * Adapts three concrete Squad patterns for OpenClaw:
 * - Evented delegation inspired by Squad's EventBus
 * - Peer mailbox messaging inspired by the decisions/inbox drop-box pattern
 * - Conflict resolution inspired by reviewer lockout and write partitioning
 */

import { randomUUID } from "node:crypto"
import type { Agent, AgentStatus, PlanSubtask, Task, TaskKind } from "@openclaw/domain"
import {
  normalizeArtifactScope as normalizeArtifactPath,
  artifactScopesOverlap as pathsOverlap,
  normalizeArtifactScopes as uniqueNormalized
} from "@openclaw/domain"

export interface TeamAgentProfile {
  id: string
  name: string
  role: string
  status: AgentStatus
  capabilities: string[]
  lanes: string[]
  reviewer?: boolean
  maxParallelAssignments?: number
  metadata?: Record<string, unknown>
}

export interface DelegationTask {
  id: string
  title: string
  summary: string
  kind: TaskKind
  priority: number
  requiredCapabilities: string[]
  preferredLanes: string[]
  dependsOn: string[]
  artifactPaths: string[]
  requesterAgentId?: string | null
  preferredAssigneeId?: string | null
  metadata?: Record<string, unknown>
}

export type DelegationTaskState = "queued" | "assigned" | "completed" | "blocked"

export interface DelegationTaskRecord {
  task: DelegationTask
  state: DelegationTaskState
  assignmentId: string | null
  blockedReason: string | null
  completedAt: string | null
}

export interface DelegationAssignment {
  assignmentId: string
  taskId: string
  agentId: string
  agentName: string
  artifactPaths: string[]
  startedAt: string
}

export interface ReviewerLockRecord {
  artifactPath: string
  lockedAgentId: string
  reviewerAgentId: string
  taskId: string | null
  reason: string
  createdAt: string
}

export interface ArtifactClaim {
  assignmentId: string
  taskId: string
  agentId: string
  artifactPath: string
  claimedAt: string
}

export interface ConflictEvaluation {
  allowed: boolean
  lockoutPaths: string[]
  conflictingAssignmentIds: string[]
}

export interface ConflictDeadlockReport {
  taskId: string
  artifactPaths: string[]
  eligibleAgentIds: string[]
  blockedAgentIds: string[]
  reason: string
}

export interface TeamRoutingCandidate {
  agentId: string
  agentName: string
  score: number
  available: boolean
  capabilityMatches: string[]
  laneMatches: string[]
  reasons: string[]
  blockedReasons: string[]
  lockoutPaths: string[]
  conflictingAssignmentIds: string[]
}

export type RoutingBlockKind = "deadlock" | "capacity" | "conflict" | "unavailable"

export interface TeamRoutingDecision {
  taskId: string
  selectedAgent: TeamAgentProfile | null
  candidates: TeamRoutingCandidate[]
  reason: string
  blocked: boolean
  blockKind: RoutingBlockKind | null
  deadlock: ConflictDeadlockReport | null
}

export type TeamMessageKind = "decision" | "question" | "handoff" | "blocker" | "status"

export interface TeamMessage {
  id: string
  threadId: string
  fromAgentId: string
  toAgentId: string
  kind: TeamMessageKind
  subject: string
  body: string
  taskId: string | null
  artifactPaths: string[]
  createdAt: string
  acknowledgedAt: string | null
}

export type TeamEventType =
  | "delegation:queued"
  | "delegation:assigned"
  | "delegation:completed"
  | "delegation:blocked"
  | "message:posted"
  | "message:acknowledged"
  | "conflict:lockout"
  | "conflict:deadlock"

export interface TeamEventPayloadMap {
  "delegation:queued": {
    task: DelegationTask
  }
  "delegation:assigned": {
    task: DelegationTask
    assignment: DelegationAssignment
  }
  "delegation:completed": {
    task: DelegationTask
    assignment: DelegationAssignment
    summary: string | null
  }
  "delegation:blocked": {
    task: DelegationTask
    decision: TeamRoutingDecision
  }
  "message:posted": TeamMessage
  "message:acknowledged": TeamMessage
  "conflict:lockout": {
    task: DelegationTask
    assignment: DelegationAssignment
    locks: ReviewerLockRecord[]
    reviewerAgentId: string
    reason: string
  }
  "conflict:deadlock": ConflictDeadlockReport
}

export interface TeamEvent<T extends TeamEventType = TeamEventType> {
  type: T
  payload: TeamEventPayloadMap[T]
  timestamp: string
}

export type TeamEventHandler<T extends TeamEventType = TeamEventType> = (event: TeamEvent<T>) => void | Promise<void>

type Clock = () => Date

function nowIso(clock: Clock): string {
  return clock().toISOString()
}

function normalizeValue(value: string): string {
  return value.trim().toLowerCase()
}

function countByAgent(assignments: Iterable<DelegationAssignment>): Map<string, number> {
  const counts = new Map<string, number>()
  for (const assignment of assignments) {
    counts.set(assignment.agentId, (counts.get(assignment.agentId) ?? 0) + 1)
  }
  return counts
}

function intersect(left: string[], right: string[]): string[] {
  const rightSet = new Set(right.map(normalizeValue))
  return left.filter((value) => rightSet.has(normalizeValue(value)))
}

export function delegationTaskFromPlanSubtask(
  subtask: PlanSubtask,
  options: {
    kind?: TaskKind
    priority?: number
    preferredLanes?: string[]
    requiredCapabilities?: string[]
    requesterAgentId?: string | null
    preferredAssigneeId?: string | null
    metadata?: Record<string, unknown>
  } = {}
): DelegationTask {
  return {
    id: subtask.id,
    title: subtask.label,
    summary: subtask.goal,
    kind: options.kind ?? "implement",
    priority: options.priority ?? 0,
    requiredCapabilities: options.requiredCapabilities ?? [],
    preferredLanes: options.preferredLanes ?? [],
    dependsOn: subtask.dependsOn,
    artifactPaths: subtask.files,
    ...(options.requesterAgentId !== undefined ? { requesterAgentId: options.requesterAgentId } : {}),
    ...(options.preferredAssigneeId !== undefined ? { preferredAssigneeId: options.preferredAssigneeId } : {}),
    ...(options.metadata ? { metadata: options.metadata } : {})
  }
}

export function taskArtifactPaths(task: Pick<Task, "changedFiles" | "allowedPaths">): string[] {
  return uniqueNormalized(task.changedFiles.length > 0 ? task.changedFiles : task.allowedPaths)
}

export function delegationTaskFromDispatcherTask(
  task: Task,
  options: {
    requiredCapabilities?: string[]
    preferredAssigneeId?: string | null
    metadata?: Record<string, unknown>
  } = {}
): DelegationTask {
  return {
    id: task.id,
    title: task.title,
    summary: task.description ?? task.title,
    kind: task.kind,
    priority: task.priority,
    requiredCapabilities: options.requiredCapabilities ?? [],
    preferredLanes: task.laneId ? [task.laneId] : [],
    dependsOn: task.dependsOnTaskIds,
    artifactPaths: taskArtifactPaths(task),
    preferredAssigneeId: options.preferredAssigneeId ?? task.assignedAgentId,
    metadata: {
      projectId: task.projectId,
      workflowId: task.workflowId,
      stage: task.stage,
      labels: task.labels,
      ...options.metadata
    }
  }
}

export function teamAgentProfileFromDispatcherAgent(
  agent: Agent,
  options: {
    capabilities?: string[]
    lanes?: string[]
    reviewer?: boolean
    maxParallelAssignments?: number
  } = {}
): TeamAgentProfile {
  return {
    id: agent.id,
    name: agent.name,
    role: agent.role,
    status: agent.status,
    capabilities: options.capabilities ?? [],
    lanes: options.lanes ?? [],
    reviewer: options.reviewer ?? false,
    maxParallelAssignments: options.maxParallelAssignments ?? 1,
    metadata: {
      adapterType: agent.adapterType,
      model: agent.model
    }
  }
}

export class TeamEventBus {
  private handlers = new Map<TeamEventType, Set<TeamEventHandler>>()
  private wildcardHandlers = new Set<TeamEventHandler>()

  subscribe<T extends TeamEventType>(type: T, handler: TeamEventHandler<T>): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set())
    }

    const typedHandlers = this.handlers.get(type)!
    const castHandler = handler as TeamEventHandler
    typedHandlers.add(castHandler)

    return () => {
      typedHandlers.delete(castHandler)
      if (typedHandlers.size === 0) {
        this.handlers.delete(type)
      }
    }
  }

  subscribeAll(handler: TeamEventHandler): () => void {
    this.wildcardHandlers.add(handler)
    return () => this.wildcardHandlers.delete(handler)
  }

  async emit<T extends TeamEventType>(
    type: T,
    payload: TeamEventPayloadMap[T],
    timestamp: string = new Date().toISOString()
  ): Promise<TeamEvent<T>> {
    const event: TeamEvent<T> = { type, payload, timestamp }
    const typedHandlers = this.handlers.get(type) ?? new Set<TeamEventHandler>()

    for (const handler of typedHandlers) {
      await handler(event as TeamEvent)
    }

    for (const handler of this.wildcardHandlers) {
      await handler(event as TeamEvent)
    }

    return event
  }
}

export class PeerMessageBus {
  private readonly messages = new Map<string, TeamMessage>()

  constructor(
    private readonly events: TeamEventBus = new TeamEventBus(),
    private readonly clock: Clock = () => new Date()
  ) {}

  async postMessage(input: {
    fromAgentId: string
    toAgentId: string
    kind: TeamMessageKind
    subject: string
    body: string
    taskId?: string | null
    threadId?: string | null
    artifactPaths?: string[]
  }): Promise<TeamMessage> {
    const message: TeamMessage = {
      id: randomUUID(),
      threadId: input.threadId ?? randomUUID(),
      fromAgentId: input.fromAgentId,
      toAgentId: input.toAgentId,
      kind: input.kind,
      subject: input.subject,
      body: input.body,
      taskId: input.taskId ?? null,
      artifactPaths: uniqueNormalized(input.artifactPaths ?? []),
      createdAt: nowIso(this.clock),
      acknowledgedAt: null
    }

    this.messages.set(message.id, message)
    await this.events.emit("message:posted", message, message.createdAt)
    return message
  }

  listInbox(agentId: string, options: { includeAcknowledged?: boolean } = {}): TeamMessage[] {
    return Array.from(this.messages.values())
      .filter((message) => message.toAgentId === agentId)
      .filter((message) => (options.includeAcknowledged ? true : message.acknowledgedAt === null))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  }

  listThread(threadId: string): TeamMessage[] {
    return Array.from(this.messages.values())
      .filter((message) => message.threadId === threadId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  }

  async acknowledgeMessage(messageId: string, agentId: string): Promise<TeamMessage> {
    const current = this.messages.get(messageId)
    if (!current) {
      throw new Error(`Unknown team message: ${messageId}`)
    }
    if (current.toAgentId !== agentId) {
      throw new Error(`Agent ${agentId} cannot acknowledge message ${messageId}`)
    }

    const updated: TeamMessage = {
      ...current,
      acknowledgedAt: nowIso(this.clock)
    }

    this.messages.set(messageId, updated)
    await this.events.emit("message:acknowledged", updated, updated.acknowledgedAt ?? new Date().toISOString())
    return updated
  }
}

export class ConflictTracker {
  private readonly reviewerLocks = new Map<string, Map<string, ReviewerLockRecord>>()
  private readonly claimsByAssignment = new Map<string, ArtifactClaim[]>()

  applyReviewerLock(input: {
    artifactPaths: string[]
    lockedAgentId: string
    reviewerAgentId: string
    taskId?: string | null
    reason: string
    createdAt?: string
  }): ReviewerLockRecord[] {
    const locks: ReviewerLockRecord[] = []

    for (const artifactPath of uniqueNormalized(input.artifactPaths)) {
      if (!this.reviewerLocks.has(artifactPath)) {
        this.reviewerLocks.set(artifactPath, new Map())
      }
      const byAgent = this.reviewerLocks.get(artifactPath)!
      const record: ReviewerLockRecord = {
        artifactPath,
        lockedAgentId: input.lockedAgentId,
        reviewerAgentId: input.reviewerAgentId,
        taskId: input.taskId ?? null,
        reason: input.reason,
        createdAt: input.createdAt ?? new Date().toISOString()
      }
      byAgent.set(input.lockedAgentId, record)
      locks.push(record)
    }

    return locks
  }

  clearReviewerLock(artifactPath: string, lockedAgentId?: string): void {
    const normalized = normalizeArtifactPath(artifactPath)
    const byAgent = this.reviewerLocks.get(normalized)
    if (!byAgent) return

    if (lockedAgentId) {
      byAgent.delete(lockedAgentId)
    } else {
      byAgent.clear()
    }

    if (byAgent.size === 0) {
      this.reviewerLocks.delete(normalized)
    }
  }

  claimArtifacts(input: {
    assignmentId: string
    taskId: string
    agentId: string
    artifactPaths: string[]
    claimedAt?: string
  }): ArtifactClaim[] {
    const claims = uniqueNormalized(input.artifactPaths).map((artifactPath) => ({
      assignmentId: input.assignmentId,
      taskId: input.taskId,
      agentId: input.agentId,
      artifactPath,
      claimedAt: input.claimedAt ?? new Date().toISOString()
    }))

    this.claimsByAssignment.set(input.assignmentId, claims)
    return claims
  }

  releaseClaim(assignmentId: string): void {
    this.claimsByAssignment.delete(assignmentId)
  }

  evaluate(task: DelegationTask, agentId: string): ConflictEvaluation {
    const artifactPaths = uniqueNormalized(task.artifactPaths)
    const lockoutPaths = new Set<string>()
    const conflictingAssignmentIds = new Set<string>()

    for (const artifactPath of artifactPaths) {
      for (const [lockedPath, byAgent] of this.reviewerLocks) {
        if (pathsOverlap(artifactPath, lockedPath) && byAgent.has(agentId)) {
          lockoutPaths.add(lockedPath)
        }
      }

      for (const [assignmentId, claims] of this.claimsByAssignment) {
        if (claims.some((claim) => pathsOverlap(artifactPath, claim.artifactPath))) {
          conflictingAssignmentIds.add(assignmentId)
        }
      }
    }

    return {
      allowed: lockoutPaths.size === 0 && conflictingAssignmentIds.size === 0,
      lockoutPaths: Array.from(lockoutPaths).sort(),
      conflictingAssignmentIds: Array.from(conflictingAssignmentIds).sort()
    }
  }

  detectDeadlock(task: DelegationTask, eligibleAgentIds: string[]): ConflictDeadlockReport | null {
    if (task.artifactPaths.length === 0 || eligibleAgentIds.length === 0) {
      return null
    }

    const blockedAgentIds = eligibleAgentIds.filter((agentId) => this.evaluate(task, agentId).lockoutPaths.length > 0)
    if (blockedAgentIds.length !== eligibleAgentIds.length) {
      return null
    }

    return {
      taskId: task.id,
      artifactPaths: uniqueNormalized(task.artifactPaths),
      eligibleAgentIds: [...eligibleAgentIds].sort(),
      blockedAgentIds: blockedAgentIds.sort(),
      reason: "All eligible agents are locked out of the requested artifacts."
    }
  }

  getLockedAgents(artifactPath: string): string[] {
    const normalized = normalizeArtifactPath(artifactPath)
    const byAgent = this.reviewerLocks.get(normalized)
    return byAgent ? Array.from(byAgent.keys()).sort() : []
  }

  listClaims(): ArtifactClaim[] {
    return Array.from(this.claimsByAssignment.values()).flat()
  }
}

export class TeamRouter {
  constructor(private readonly conflicts: ConflictTracker = new ConflictTracker()) {}

  routeTask(
    task: DelegationTask,
    agents: TeamAgentProfile[],
    options: {
      activeAssignments?: Iterable<DelegationAssignment>
    } = {}
  ): TeamRoutingDecision {
    const activeCounts = countByAgent(options.activeAssignments ?? [])
    const candidates: TeamRoutingCandidate[] = agents.map((agent) =>
      this.buildCandidate(task, agent, activeCounts.get(agent.id) ?? 0)
    )

    const availableCandidates = candidates
      .filter((candidate) => candidate.available)
      .sort((left, right) => right.score - left.score || left.agentName.localeCompare(right.agentName))

    if (availableCandidates.length > 0) {
      const winner = availableCandidates[0]!
      const selectedAgent = agents.find((agent) => agent.id === winner.agentId) ?? null
      return {
        taskId: task.id,
        selectedAgent,
        candidates,
        reason: winner.reasons.join("; "),
        blocked: false,
        blockKind: null,
        deadlock: null
      }
    }

    const deadlockPool = candidates
      .filter((candidate) => candidate.blockedReasons.length > 0)
      .filter((candidate) => candidate.blockedReasons.every((reason) => reason.startsWith("reviewer lockout")))
      .map((candidate) => candidate.agentId)
    const deadlock =
      deadlockPool.length === candidates.length ? this.conflicts.detectDeadlock(task, deadlockPool) : null

    let blockKind: RoutingBlockKind = "unavailable"
    if (deadlock) {
      blockKind = "deadlock"
    } else if (candidates.some((candidate) => candidate.blockedReasons.some((reason) => reason.includes("capacity")))) {
      blockKind = "capacity"
    } else if (
      candidates.some((candidate) => candidate.conflictingAssignmentIds.length > 0 || candidate.lockoutPaths.length > 0)
    ) {
      blockKind = "conflict"
    }

    return {
      taskId: task.id,
      selectedAgent: null,
      candidates,
      reason: deadlock?.reason ?? "No eligible agent is currently available for this task.",
      blocked: true,
      blockKind,
      deadlock
    }
  }

  private buildCandidate(
    task: DelegationTask,
    agent: TeamAgentProfile,
    activeAssignments: number
  ): TeamRoutingCandidate {
    const capabilityMatches = intersect(task.requiredCapabilities, agent.capabilities)
    const laneMatches = intersect(task.preferredLanes, agent.lanes)
    const conflict = this.conflicts.evaluate(task, agent.id)
    const blockedReasons: string[] = []
    const reasons: string[] = []
    let score = task.priority

    if (task.preferredAssigneeId && task.preferredAssigneeId === agent.id) {
      score += 100
      reasons.push("explicit assignee preference")
    }

    if (capabilityMatches.length > 0) {
      score += capabilityMatches.length * 40
      reasons.push(`capabilities matched: ${capabilityMatches.join(", ")}`)
    } else if (task.requiredCapabilities.length > 0) {
      score -= 10
      reasons.push("fallback without direct capability match")
    }

    if (laneMatches.length > 0) {
      score += laneMatches.length * 20
      reasons.push(`lane fit: ${laneMatches.join(", ")}`)
    }

    if (task.kind === "review" && agent.reviewer) {
      score += 25
      reasons.push("reviewer authority")
    }

    if (agent.status === "paused" || agent.status === "blocked") {
      blockedReasons.push(`agent status ${agent.status}`)
    } else if (agent.status === "idle") {
      score += 15
      reasons.push("agent is idle")
    } else {
      score += 5
      reasons.push("agent already warm")
    }

    const capacity = agent.maxParallelAssignments ?? 1
    if (activeAssignments >= capacity) {
      blockedReasons.push(`agent at capacity (${activeAssignments}/${capacity})`)
    } else {
      score += Math.max(0, 12 - activeAssignments * 6)
      reasons.push(`capacity available (${activeAssignments}/${capacity})`)
    }

    if (conflict.lockoutPaths.length > 0) {
      blockedReasons.push(`reviewer lockout on ${conflict.lockoutPaths.join(", ")}`)
    }

    if (conflict.conflictingAssignmentIds.length > 0) {
      blockedReasons.push(`artifact already claimed by ${conflict.conflictingAssignmentIds.join(", ")}`)
    }

    return {
      agentId: agent.id,
      agentName: agent.name,
      score,
      available: blockedReasons.length === 0,
      capabilityMatches,
      laneMatches,
      reasons,
      blockedReasons,
      lockoutPaths: conflict.lockoutPaths,
      conflictingAssignmentIds: conflict.conflictingAssignmentIds
    }
  }
}

export class SwarmOrchestrator {
  readonly events: TeamEventBus
  readonly messages: PeerMessageBus
  readonly conflicts: ConflictTracker
  readonly router: TeamRouter

  private readonly taskRecords = new Map<string, DelegationTaskRecord>()
  private readonly activeAssignments = new Map<string, DelegationAssignment>()
  private readonly clock: Clock

  constructor(
    private readonly input: {
      agents: TeamAgentProfile[]
      maxParallelAssignments?: number
      clock?: Clock
      events?: TeamEventBus
      messages?: PeerMessageBus
      conflicts?: ConflictTracker
      router?: TeamRouter
    }
  ) {
    this.clock = input.clock ?? (() => new Date())
    this.events = input.events ?? new TeamEventBus()
    this.conflicts = input.conflicts ?? new ConflictTracker()
    this.router = input.router ?? new TeamRouter(this.conflicts)
    this.messages = input.messages ?? new PeerMessageBus(this.events, this.clock)
  }

  async enqueue(tasks: DelegationTask[]): Promise<void> {
    for (const task of tasks) {
      this.taskRecords.set(task.id, {
        task: {
          ...task,
          artifactPaths: uniqueNormalized(task.artifactPaths),
          dependsOn: Array.from(new Set(task.dependsOn))
        },
        state: "queued",
        assignmentId: null,
        blockedReason: null,
        completedAt: null
      })

      await this.events.emit("delegation:queued", { task }, nowIso(this.clock))
    }
  }

  async dispatchReady(): Promise<{
    assignments: DelegationAssignment[]
    blocked: TeamRoutingDecision[]
  }> {
    const assignments: DelegationAssignment[] = []
    const blocked: TeamRoutingDecision[] = []
    const capacity = this.input.maxParallelAssignments ?? Number.POSITIVE_INFINITY
    let remainingGlobalSlots = Math.max(0, capacity - this.activeAssignments.size)

    if (remainingGlobalSlots === 0) {
      return { assignments, blocked }
    }

    const readyTasks = Array.from(this.taskRecords.values())
      .filter((record) => record.state === "queued")
      .filter((record) =>
        record.task.dependsOn.every((dependencyId) => this.taskRecords.get(dependencyId)?.state === "completed")
      )
      .sort((left, right) => right.task.priority - left.task.priority || left.task.id.localeCompare(right.task.id))

    for (const record of readyTasks) {
      if (remainingGlobalSlots <= 0) {
        break
      }

      const decision = this.router.routeTask(record.task, this.input.agents, {
        activeAssignments: this.activeAssignments.values()
      })

      if (!decision.selectedAgent) {
        if (decision.blockKind === "deadlock") {
          record.state = "blocked"
          record.blockedReason = decision.reason
          if (decision.deadlock) {
            await this.events.emit("conflict:deadlock", decision.deadlock, nowIso(this.clock))
          }
        }

        blocked.push(decision)
        await this.events.emit("delegation:blocked", { task: record.task, decision }, nowIso(this.clock))
        continue
      }

      const assignment: DelegationAssignment = {
        assignmentId: randomUUID(),
        taskId: record.task.id,
        agentId: decision.selectedAgent.id,
        agentName: decision.selectedAgent.name,
        artifactPaths: record.task.artifactPaths,
        startedAt: nowIso(this.clock)
      }

      this.activeAssignments.set(assignment.assignmentId, assignment)
      this.conflicts.claimArtifacts({
        assignmentId: assignment.assignmentId,
        taskId: assignment.taskId,
        agentId: assignment.agentId,
        artifactPaths: assignment.artifactPaths,
        claimedAt: assignment.startedAt
      })

      record.state = "assigned"
      record.assignmentId = assignment.assignmentId
      record.blockedReason = null

      assignments.push(assignment)
      remainingGlobalSlots -= 1
      await this.events.emit("delegation:assigned", { task: record.task, assignment }, assignment.startedAt)
    }

    return { assignments, blocked }
  }

  async completeAssignment(assignmentId: string, summary: string | null = null): Promise<void> {
    const assignment = this.activeAssignments.get(assignmentId)
    if (!assignment) {
      throw new Error(`Unknown assignment: ${assignmentId}`)
    }

    const record = this.taskRecords.get(assignment.taskId)
    if (!record) {
      throw new Error(`Unknown task for assignment: ${assignment.taskId}`)
    }

    this.activeAssignments.delete(assignmentId)
    this.conflicts.releaseClaim(assignmentId)

    record.state = "completed"
    record.assignmentId = null
    record.blockedReason = null
    record.completedAt = nowIso(this.clock)

    await this.events.emit("delegation:completed", { task: record.task, assignment, summary }, record.completedAt)
  }

  async failAssignment(assignmentId: string, reason: string, options: { requeue?: boolean } = {}): Promise<void> {
    const assignment = this.activeAssignments.get(assignmentId)
    if (!assignment) {
      throw new Error(`Unknown assignment: ${assignmentId}`)
    }

    const record = this.taskRecords.get(assignment.taskId)
    if (!record) {
      throw new Error(`Unknown task for assignment: ${assignment.taskId}`)
    }

    this.activeAssignments.delete(assignmentId)
    this.conflicts.releaseClaim(assignmentId)

    record.state = options.requeue ? "queued" : "blocked"
    record.assignmentId = null
    record.blockedReason = options.requeue ? null : reason

    const decision: TeamRoutingDecision = {
      taskId: record.task.id,
      selectedAgent: null,
      candidates: [],
      reason,
      blocked: true,
      blockKind: "unavailable",
      deadlock: null
    }

    await this.events.emit("delegation:blocked", { task: record.task, decision }, nowIso(this.clock))
  }

  async rejectAssignment(input: {
    assignmentId: string
    reviewerAgentId: string
    reason: string
  }): Promise<ReviewerLockRecord[]> {
    const assignment = this.activeAssignments.get(input.assignmentId)
    if (!assignment) {
      throw new Error(`Unknown assignment: ${input.assignmentId}`)
    }

    const record = this.taskRecords.get(assignment.taskId)
    if (!record) {
      throw new Error(`Unknown task for assignment: ${assignment.taskId}`)
    }

    const locks = this.conflicts.applyReviewerLock({
      artifactPaths: assignment.artifactPaths,
      lockedAgentId: assignment.agentId,
      reviewerAgentId: input.reviewerAgentId,
      taskId: assignment.taskId,
      reason: input.reason,
      createdAt: nowIso(this.clock)
    })

    this.activeAssignments.delete(input.assignmentId)
    this.conflicts.releaseClaim(input.assignmentId)
    record.state = "queued"
    record.assignmentId = null
    record.blockedReason = null

    await this.events.emit(
      "conflict:lockout",
      {
        task: record.task,
        assignment,
        locks,
        reviewerAgentId: input.reviewerAgentId,
        reason: input.reason
      },
      nowIso(this.clock)
    )

    return locks
  }

  requeueTask(taskId: string): void {
    const record = this.taskRecords.get(taskId)
    if (!record) {
      throw new Error(`Unknown task: ${taskId}`)
    }

    if (record.state !== "completed") {
      record.state = "queued"
      record.assignmentId = null
      record.blockedReason = null
    }
  }

  getTaskRecord(taskId: string): DelegationTaskRecord | null {
    return this.taskRecords.get(taskId) ?? null
  }

  listActiveAssignments(): DelegationAssignment[] {
    return Array.from(this.activeAssignments.values()).sort((left, right) =>
      left.startedAt.localeCompare(right.startedAt)
    )
  }

  snapshot(): {
    tasks: DelegationTaskRecord[]
    assignments: DelegationAssignment[]
    claims: ArtifactClaim[]
  } {
    return {
      tasks: Array.from(this.taskRecords.values()).map((record) => ({ ...record, task: { ...record.task } })),
      assignments: this.listActiveAssignments(),
      claims: this.conflicts.listClaims()
    }
  }
}
