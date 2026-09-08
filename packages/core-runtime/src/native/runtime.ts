import { createHash, randomUUID } from "node:crypto"
import { existsSync, realpathSync } from "node:fs"
import { resolve } from "node:path"
import {
  artifactScopesOverlap,
  assertNativeReleaseGate,
  type assessNativeBenefit,
  type NativeAssessment,
  type NativeAutonomyPolicy,
  type NativeLifecycle,
  type NativeProposal,
  type NativeReviewEvidence,
  type NativeRiskAssessment,
  type NativeVerificationEvidence,
  type NativeWorkflowState,
  nativeProposalKey,
  nextNativeAttempt,
  recoverNativeLifecycle,
  redactCommandText,
  redactLogText,
  selectNativePersonas,
  transitionNativeLifecycle,
  upgradeNativeLifecycle,
  validateNativeAssessment,
  validateNativeLifecycle,
  validateNativeProposal
} from "@openclaw/domain"
import { assertExecutionOwnership, holdsExecutionOwner, withExecutionOwner } from "@openclaw/os-adapters"
import { NativeBudgetLedger } from "./budget-ledger.js"
import { assertConfiguredNativeCapabilities, configuredNativeModels } from "./capabilities.js"
import { NativeControl, NativeControlRevoked } from "./control.js"
import { type NativeCard, type NativeGateway, nativeCard, nativeCards } from "./gateway.js"
import { exportNativeLessons, type NativeMemoryConfig } from "./memory.js"
import { reconcileNativeNotifications } from "./notifications.js"
import { nativeOutcomeReport } from "./outcomes.js"
import { assertNativeMode, nativeModeAllows } from "./promotion-mode.js"
import { assertNativeProvenance, nativeContentDigest, nativeVerificationDigest } from "./provenance.js"
import { NativeQualityRuntime } from "./quality.js"
import {
  type NativeRecoveryAction,
  type NativeRecoveryPlan,
  nativeRecoveryDigest,
  planNativeRecovery
} from "./recovery.js"
import { NativeReleasePending, releaseNativeWorkflow } from "./release.js"
import { type NativeEvidenceStore, NativeLeaseLost, type NativeRecordWrite, NativeRevisionConflict } from "./store.js"
import { type NativeTraceStage, nativePolicyTraceDigest, nativeTraceReport, withNativeStageTrace } from "./telemetry.js"
import {
  commitNativeCandidate,
  containedDirectory,
  inspectNativeCandidate,
  nativeVerificationCommands,
  verifyNativeCandidate
} from "./verification.js"

export interface NativeWorkflow {
  lifecycle?: NativeLifecycle
  archivedAt?: string
  submission?: { agentId: string; sessionKey: string; executionId: string }
  recovery?: {
    action: string
    planDigest: string
    operator: string
    fromAttemptId: string
    reason: string
    at: string
    supersededBy?: string
  }
  benefitEvidence?: ReturnType<typeof assessNativeBenefit>
  proposal: NativeProposal
  rootCardId: string
  implementationCardId: string
  reviewCardId?: string
  stageCards: Record<string, string>
  candidate?: Awaited<ReturnType<typeof inspectNativeCandidate>>
  verification?: NativeVerificationEvidence
  review?: NativeReviewEvidence
  prNumber?: number
  mergedSha?: string
  deployedSha?: string
  blocker?: string
  dependencyCardIds?: string[]
  designCardId?: string
  designEvidenceComplete?: boolean
  designCardDigest?: string
  riskAssessment?: NativeRiskAssessment
  designReview?: {
    receiptVersion?: 1
    attemptId?: string
    policyDigest?: string
    skillDigest?: string
    verdict: string
    rationale: string
    sessionKey: string
    assessment: NativeAssessment
    digest?: string
  }
  repairCount?: number
}
export class NativeAutonomyRuntime {
  readonly control: NativeControl
  constructor(
    readonly policy: NativeAutonomyPolicy,
    readonly gateway: NativeGateway,
    readonly store: NativeEvidenceStore
  ) {
    this.control = new NativeControl(store, () => policy.enabled)
    this.gateway = {
      request: async (method, params) => {
        store.authorizeEffect()
        assertExecutionOwnership()
        if (
          method === "workboard.cards.dispatchWithOptions" ||
          (["workboard.cards.create", "workboard.cards.move"].includes(method) &&
            !["scheduled", "blocked", "done"].includes(String(params.status)))
        )
          this.control.assert()
        if (method === "workboard.cards.dispatchWithOptions") await this.authorizeDispatch(gateway)
        return gateway.request(method, params)
      }
    }
  }
  get hasOwnership(): boolean {
    return holdsExecutionOwner(this.policy.repository, "native")
  }
  withOwnership<T>(action: () => Promise<T>): Promise<T> {
    return withExecutionOwner(this.policy.repository, "native", action)
  }
  reserveBudget(workflowId: string, attemptId: string, purpose: string, operationId: string, safety = false): void {
    const policy = this.policy.budgets
    if (!policy) {
      if (nativeModeAllows(this.policy, "release")) throw new Error("Release modes require reviewed budget estimates")
      return
    }
    new NativeBudgetLedger(this.store, policy).reserve({
      id: `native:${operationId}`,
      projectId: this.policy.boardId,
      workflowId,
      attemptId,
      purpose,
      amount: policy.estimates?.[purpose] ?? {},
      safety
    })
  }
  private async authorizeDispatch(gateway: NativeGateway): Promise<void> {
    const cards = (await nativeCards(gateway, this.policy.boardId)).filter(
      (c) =>
        ["ready", "todo"].includes(c.status) ||
        (c.status === "scheduled" && (c.metadata?.automation?.scheduledAt ?? Infinity) <= Date.now())
    )
    if (!cards.length) return
    if (nativeModeAllows(this.policy, "release")) {
      const config = await gateway.request("config.get", {})
      assertConfiguredNativeCapabilities(
        this.store,
        this.policy,
        configuredNativeModels(config.config ?? config.parsed, this.policy)
      )
    }
    const workflows = this.store.list<NativeWorkflow>("workflow")
    for (const card of cards) {
      const action =
        card.agentId === this.policy.coderAgentId
          ? "implement"
          : card.agentId === this.policy.reviewerAgentId
            ? "review"
            : card.agentId === this.policy.plannerAgentId
              ? "propose"
              : this.policy.personas.some((p) => (p.investigationAgentId ?? p.personaId) === card.agentId)
                ? "investigate"
                : null
      if (!action) throw new Error("Dispatch contains a card without a reviewed native role")
      assertNativeMode(this.policy, action)
      const workflow = workflows.find((w) =>
        [w.value.implementationCardId, w.value.reviewCardId, w.value.designCardId].includes(card.id)
      )
      const attemptId = workflow?.value.lifecycle?.attemptId ?? `card:${card.id}`
      this.reserveBudget(
        workflow?.id ?? `card:${card.id}`,
        attemptId,
        card.title.startsWith("Repair ") ? "repair" : action,
        `worker:${card.id}:${attemptId}`
      )
    }
  }
  async createCard(input: Record<string, unknown>, writes: NativeRecordWrite[] = []): Promise<NativeCard> {
    const key = String(input.idempotencyKey ?? "")
    if (!key) throw new Error("Native card creation requires a durable correlation key")
    const intentId = `card:${key}`
    const previousIntent = this.store.get<{ input: Record<string, unknown>; card?: NativeCard }>(
      "effect-intent",
      intentId
    )
    if (previousIntent?.card) {
      if (writes.length)
        this.store.commit(writes, {
          kind: "effect.reconciled",
          subject: intentId,
          value: { cardId: previousIntent.card.id }
        })
      return previousIntent.card
    }
    if (previousIntent && JSON.stringify(previousIntent.input) !== JSON.stringify(input))
      throw new Error("Card intent changed during replay")
    if (!previousIntent)
      this.store.commit(
        [...writes, { kind: "effect-intent", id: intentId, value: { input, state: "pending" }, expectedVersion: 0 }],
        { kind: "effect.prepared", subject: intentId, value: { correlationKey: key } }
      )
    if (previousIntent && writes.length)
      this.store.commit(writes, { kind: "effect.retrying", subject: intentId, value: { correlationKey: key } })
    const card = await this.createCardEffect(input)
    this.store.commit([{ kind: "effect-intent", id: intentId, value: { input, card, state: "confirmed" } }], {
      kind: "effect.confirmed",
      subject: intentId,
      value: { cardId: card.id }
    })
    return card
  }
  private async createCardEffect(input: Record<string, unknown>): Promise<NativeCard> {
    const notes = input.notes
    if (typeof notes !== "string" || notes.length <= 4000) return nativeCard(this.gateway, input)
    const contextId = createHash("sha256")
      .update(JSON.stringify([input.idempotencyKey, notes]))
      .digest("hex")
    const previous = this.store.get<{ notes: string; agentId?: string; cardId?: string }>("card-context", contextId)
    const context = previous ?? { notes, ...(typeof input.agentId === "string" ? { agentId: input.agentId } : {}) }
    this.store.put("card-context", contextId, context)
    const card = await nativeCard(this.gateway, {
      ...input,
      notes: JSON.stringify({
        boardId: this.policy.boardId,
        contextId,
        instructions:
          "Before acting, call autocode_context(boardId, contextId) to retrieve your complete task context, including the prompt skill, scope, acceptance criteria and instructions. Do not proceed without retrieving it."
      })
    })
    this.store.put("card-context", contextId, { ...context, cardId: card.id })
    return card
  }
  async readContext(agentId: string, sessionKey: string, contextId: string) {
    const context = this.store.get<{ notes: string; agentId?: string; cardId?: string }>("card-context", contextId)
    if (!context || (context.agentId && context.agentId !== agentId))
      throw new Error("Context is not assigned to this agent")
    const card = (await nativeCards(this.gateway, this.policy.boardId)).find((c) => c.id === context.cardId)
    this.assertSession(card, sessionKey)
    if (card?.agentId !== agentId) throw new Error("Context is not assigned to this agent")
    this.store.event("context.read", contextId, { agentId, sessionKey, cardId: card.id })
    return { contextId, notes: context.notes }
  }
  get quality() {
    return new NativeQualityRuntime(this)
  }
  isPaused(): boolean {
    return this.control.state.paused
  }
  assertEnabled(): void {
    this.control.assert()
  }
  async freeze() {
    const control = this.control.freeze()
    const requested: string[] = [],
      unavailable: string[] = []
    try {
      const owned = new Set(
        this.store
          .list<NativeWorkflow>("workflow")
          .flatMap(({ value }) => [value.implementationCardId, value.reviewCardId, value.designCardId])
          .filter(Boolean)
      )
      for (const { value } of this.store.list<{ cardId?: string }>("investigation"))
        if (value.cardId) owned.add(value.cardId)
      const cards = await nativeCards(this.gateway, this.policy.boardId)
      for (const card of cards) {
        const key = card.execution?.sessionKey ?? card.sessionKey
        if (
          !owned.has(card.id) ||
          !card.agentId ||
          !key ||
          (card.status !== "running" && card.execution?.status !== "running")
        )
          continue
        const identity = { cardId: card.id, sessionDigest: nativeContentDigest(key), revision: control.revision }
        this.store.event("control.cancellation-requested", card.id, identity)
        try {
          await this.gateway.request("sessions.abort", {
            key,
            agentId: card.agentId,
            ...((card.runId ?? card.execution?.runId) ? { runId: card.runId ?? card.execution?.runId } : {})
          })
          requested.push(card.id)
          this.store.event("control.cancellation-accepted", card.id, identity)
        } catch {
          unavailable.push(card.id)
          this.store.event("control.cancellation-unresolved", card.id, identity)
        }
      }
    } catch {
      unavailable.push("board-snapshot")
      this.store.event("control.cancellation-unavailable", this.policy.boardId, { revision: control.revision })
    }
    return {
      ...control,
      requested,
      unavailable,
      note: "Owned command cancellation requested; session abort responses are not proof of termination. Claims and uncertain effects remain preserved."
    }
  }
  verificationForAgent(evidence: NativeVerificationEvidence | undefined) {
    if (!evidence) return undefined
    return {
      headSha: evidence.headSha,
      checks: evidence.checks,
      plan: evidence.plan,

      attemptId: evidence.provenance?.attemptId,
      verificationDigest: nativeVerificationDigest(evidence)
    }
  }
  reservesScope(workflow: NativeWorkflow): boolean {
    return !workflow.deployedSha && workflow.lifecycle?.state !== "cancelled" && !workflow.archivedAt
  }
  async planWorkflowRecovery(
    workflowId: string,
    action: NativeRecoveryAction,
    reason: string,
    successorId?: string
  ): Promise<NativeRecoveryPlan> {
    const workflow = this.store.get<NativeWorkflow>("workflow", workflowId)
    if (!workflow) throw new Error("Unknown workflow")
    const lifecycle = workflow.lifecycle ?? upgradeNativeLifecycle(workflowId, workflow)
    const owned = new Set(
      [
        workflow.rootCardId,
        workflow.implementationCardId,
        workflow.reviewCardId,
        workflow.designCardId,
        ...Object.values(workflow.stageCards)
      ].filter((id): id is string => Boolean(id))
    )
    const cards = (await nativeCards(this.gateway, this.policy.boardId)).filter((card) => owned.has(card.id))
    const successor = successorId ? this.store.get<NativeWorkflow>("workflow", successorId) : null
    return planNativeRecovery(
      {
        boardId: this.policy.boardId,
        workflowId,
        workflowVersion: this.store.version("workflow", workflowId),
        workflowDigest: nativeRecoveryDigest(workflow),
        policyDigest: nativeRecoveryDigest(this.policy),
        lifecycle,
        control: this.control.state,
        cards: cards
          .map((card) => ({
            id: card.id,
            status: card.status,
            ...(card.execution?.status ? { executionStatus: card.execution.status } : {}),
            ...((card.runId ?? card.execution?.runId) ? { runId: String(card.runId ?? card.execution?.runId) } : {}),
            ...(card.updatedAt === undefined ? {} : { updatedAt: card.updatedAt })
          }))
          .sort((a, b) => a.id.localeCompare(b.id)),
        missingCards: [...owned].filter((id) => !cards.some((card) => card.id === id)).sort(),
        operations: [
          ...this.store
            .list<any>("deployment-target")
            .filter((op) => op.value.workflowId === workflowId)
            .map((op) => ({
              id: `deployment-target:${op.id}`,
              value: {
                state: op.value.state === "healthy" ? "confirmed" : op.value.state,
                digest: nativeRecoveryDigest(op.value)
              },
              version: this.store.version("deployment-target", op.id)
            })),
          ...this.store
            .list<any>("operation")
            .filter((op) => op.id.startsWith(`${workflowId}:`))
            .map((op) => ({
              id: op.id,
              value: { state: op.value.state, digest: nativeRecoveryDigest(op.value) },
              version: this.store.version("operation", op.id)
            })),
          ...this.store
            .list<any>("effect-intent")
            .filter((op) => op.id.startsWith(`card:workflow:${workflowId}:`) || op.id === `card:workflow:${workflowId}`)
            .map((op) => ({
              id: op.id,
              value: { state: op.value.state, digest: nativeRecoveryDigest(op.value) },
              version: this.store.version("effect-intent", op.id)
            }))
        ].sort((a, b) => a.id.localeCompare(b.id)),
        ...(successor && successorId
          ? {
              successor: {
                id: successorId,
                version: this.store.version("workflow", successorId),
                terminal: !this.reservesScope(successor)
              }
            }
          : {}),
        hasPullRequest: Boolean(workflow.prNumber),
        hasMerge: Boolean(workflow.mergedSha),
        archived: Boolean(workflow.archivedAt)
      },
      action,
      reason
    )
  }
  dashboardSnapshot() {
    const records = this.store.list<NativeWorkflow>("workflow").filter(({ value }) => !value.archivedAt)
    const outcomes = nativeOutcomeReport(this.store)
    return {
      version: 1 as const,
      source: "live" as const,
      observedAt: new Date().toISOString(),
      boardId: this.policy.boardId,
      omitted: Math.max(0, records.length - 100),
      workflows: records.slice(0, 100).map(({ id, value }) => ({
        version: 1 as const,
        boardId: this.policy.boardId,
        workflowId: id,
        lifecycle: value.lifecycle ?? upgradeNativeLifecycle(id, value),
        candidate: value.candidate ? { headSha: value.candidate.headSha } : null,
        review: value.review ? { verdict: value.review.verdict, headSha: value.review.headSha } : null,
        blocker: value.blocker ? redactLogText(redactCommandText(value.blocker)).slice(0, 2000) : null,
        nextActions: value.blocker
          ? ["Inspect this workflow and generate an explicit recovery plan"]
          : ["Observe the current workflow evidence; native Workboard owns execution"]
      })),
      metrics: {
        admitted: outcomes.denominators.admitted,
        verifiedDeployments: outcomes.denominators.deployed,
        totalKnownCost: outcomes.cost.unknownWorkflows ? null : outcomes.cost.knownCents
      }
    }
  }
  async explainWorkflow(workflowId: string) {
    const workflow = this.store.get<NativeWorkflow>("workflow", workflowId)
    if (!workflow) throw new Error("Unknown workflow")
    const plan = await this.planWorkflowRecovery(
      workflowId,
      workflow.blocker ? "retry" : "cancel",
      "Read-only recovery assessment"
    )
    const contention = this.store
      .list<NativeWorkflow>("workflow")
      .filter(
        (item) =>
          item.id !== workflowId &&
          this.reservesScope(item.value) &&
          workflow.proposal.allowedPaths.some((path) =>
            item.value.proposal.allowedPaths.some((other) => artifactScopesOverlap(path, other))
          )
      )
      .map((item) => item.id)
    return {
      version: 1,
      boardId: this.policy.boardId,
      workflowId,
      observedAt: new Date().toISOString(),
      policyDigest: plan.snapshot.policyDigest,
      lifecycle: plan.snapshot.lifecycle,
      control: plan.snapshot.control,
      scope: workflow.proposal.allowedPaths,
      reservesScope: this.reservesScope(workflow),
      contention,
      blocker: workflow.blocker ? redactLogText(redactCommandText(workflow.blocker)).slice(0, 2000) : null,
      dependencies: workflow.dependencyCardIds ?? [],
      cards: plan.snapshot.cards,
      missingCards: plan.snapshot.missingCards,
      candidate: workflow.candidate
        ? { headSha: workflow.candidate.headSha, baseSha: workflow.candidate.baseSha, files: workflow.candidate.files }
        : null,
      verification: workflow.verification
        ? {
            headSha: workflow.verification.headSha,
            checks: workflow.verification.checks.map((check) => ({ ruleId: check.ruleId, exitCode: check.exitCode }))
          }
        : null,
      review: workflow.review ? { verdict: workflow.review.verdict, headSha: workflow.review.headSha } : null,
      operations: plan.snapshot.operations,
      recovery: workflow.recovery ?? null,
      archivedAt: workflow.archivedAt ?? null,
      trace: nativeTraceReport(this.store, this.policy.boardId, workflowId),
      nextActions: plan.blockers.length
        ? plan.blockers
        : ["Generate an exact recovery plan and explicitly apply it; this explanation changes no state"]
    }
  }
  async applyWorkflowRecovery(
    plan: NativeRecoveryPlan,
    operator: string
  ): Promise<{ applied: boolean; workflowId: string; action: NativeRecoveryAction }> {
    if (!this.hasOwnership) return this.withOwnership(() => this.applyWorkflowRecovery(plan, operator))
    if (plan?.snapshot?.boardId !== this.policy.boardId || typeof operator !== "string" || !operator.trim())
      throw new Error("Attributed operator recovery for this board required")
    const workflowId = plan.snapshot.workflowId
    if (!this.store.holdsLease(`workflow:${workflowId}`))
      return this.withWorkflowLease(workflowId, () => this.applyWorkflowRecovery(plan, operator))
    const applied = this.store.get<{
      state: string
      result: { applied: boolean; workflowId: string; action: NativeRecoveryAction }
    }>("recovery", plan.digest)
    if (applied?.state === "applied") return applied.result
    const lease = this.store.acquire("reconcile", 120_000)
    if (!lease) throw new Error("Reconciliation is active; retry recovery after it drains")
    return this.store.withLease(lease, 120_000, async () => {
      const admission = this.store.acquire("admission", 120_000)
      if (!admission) throw new Error("Admission is active; retry recovery after it drains")
      return this.store.withLease(admission, 120_000, async () => {
        const current = await this.planWorkflowRecovery(
          workflowId,
          plan.action,
          plan.reason,
          plan.snapshot.successor?.id
        )
        if (current.digest !== plan.digest || nativeRecoveryDigest({ ...plan, digest: undefined }) !== plan.digest)
          throw new Error("Recovery plan is stale or edited; generate a new plan")
        if (!current.allowed) throw new Error(current.blockers.join("; "))
        const workflow = this.store.get<NativeWorkflow>("workflow", workflowId)!
        const previous = workflow.lifecycle ?? upgradeNativeLifecycle(workflowId, workflow)
        const before = structuredClone(workflow)
        this.store.put("recovery", plan.digest, { state: "prepared", plan, operator })
        if (plan.action === "archive") workflow.archivedAt = new Date().toISOString()
        else {
          workflow.recovery = {
            action: plan.action,
            planDigest: plan.digest,
            operator,
            fromAttemptId: previous.attemptId,
            reason: plan.reason,
            at: new Date().toISOString(),
            ...(plan.snapshot.successor ? { supersededBy: plan.snapshot.successor.id } : {})
          }
          if (plan.action === "retry") {
            delete workflow.candidate
            delete workflow.verification
            delete workflow.review
            delete workflow.reviewCardId
            delete workflow.designReview
            delete workflow.designCardId
            delete workflow.designCardDigest
            delete workflow.riskAssessment
            delete workflow.submission
            delete workflow.blocker
            workflow.lifecycle = recoverNativeLifecycle(previous, workflow)
            workflow.repairCount = workflow.lifecycle.attempt
            const card = await this.createCard({
              boardId: this.policy.boardId,
              title: `Recover: ${workflow.proposal.title}`,
              status: "blocked",
              agentId: this.policy.coderAgentId,
              idempotencyKey: `recovery:${workflowId}:attempt:${workflow.lifecycle.attempt}`,
              maxRetries: 1,
              workspace: {
                kind: "worktree",
                sourcePath: this.policy.repository,
                sourceBranch: `origin/${this.policy.baseBranch}`
              },
              notes: JSON.stringify({
                workflowId,
                proposal: workflow.proposal,
                previousAttemptId: previous.attemptId,
                instructions:
                  "Recover the preserved scoped task. Edit a fresh candidate and call autocode_submit to record its scoped commit before workboard_complete. Fresh verification and independent review are required. Do not push, merge or deploy."
              })
            })
            workflow.implementationCardId = card.id
            workflow.stageCards = {}
          } else workflow.lifecycle = recoverNativeLifecycle(previous, workflow)
        }
        const latest = await this.planWorkflowRecovery(
          workflowId,
          plan.action,
          plan.reason,
          plan.snapshot.successor?.id
        )
        if (latest.digest !== plan.digest)
          throw new Error("Recovery prerequisites changed during preparation; preserve the prepared intent and replan")
        const result = { applied: true, workflowId, action: plan.action }
        this.store.commit(
          [
            {
              kind: "attempt-history",
              id: `${workflowId}:${previous.attemptId}:${plan.digest}`,
              value: before,
              expectedVersion: 0
            },
            { kind: "workflow", id: workflowId, value: workflow, expectedVersion: plan.snapshot.workflowVersion },
            ...(plan.action === "retry"
              ? [
                  {
                    kind: "admission",
                    id: workflowId,
                    value: { ...this.store.get<any>("admission", workflowId), phase: "prepared" }
                  }
                ]
              : []),
            { kind: "recovery", id: plan.digest, value: { state: "applied", plan, operator, result } }
          ],
          {
            kind: "recovery.applied",
            subject: workflowId,
            value: {
              planDigest: plan.digest,
              action: plan.action,
              operator,
              reason: plan.reason,
              attemptId: workflow.lifecycle?.attemptId
            }
          },
          undefined,
          () => {
            if (this.control.state.revision !== plan.snapshot.control.revision || !this.control.state.paused)
              throw new Error("Control changed during recovery")
            if (
              plan.snapshot.successor &&
              this.store.version("workflow", plan.snapshot.successor.id) !== plan.snapshot.successor.version
            )
              throw new Error("Successor changed during recovery")
          }
        )
        return result
      })
    })
  }
  async status() {
    const cards = await nativeCards(this.gateway, this.policy.boardId)
    return {
      boardId: this.policy.boardId,
      enabled: this.policy.enabled,
      control: this.control.state,
      counts: cards.reduce<Record<string, number>>((acc, c) => {
        acc[c.status] = (acc[c.status] ?? 0) + 1
        return acc
      }, {}),
      workflows: this.store
        .list<NativeWorkflow>("workflow")
        .filter(({ value }) => !value.archivedAt)
        .map(({ id, value }) => ({
          lifecycle: value.lifecycle ?? upgradeNativeLifecycle(id, value),
          reservesScope: this.reservesScope(value),
          recovery: value.recovery ?? null,
          id,
          title: value.proposal.title,
          personaId: value.proposal.personaId,
          deployedSha: value.deployedSha ?? null,
          risk: value.riskAssessment?.risk ?? value.proposal.quality?.risk ?? "routine",
          riskAssessment: value.riskAssessment ?? null,
          designApproved: this.quality.designApproved(value),
          blocker: value.blocker ?? null
        })),
      operations: this.store.list("operation")
    }
  }
  async discover(): Promise<{ created: string[]; reason?: string }> {
    assertNativeMode(this.policy, "investigate")
    if (!this.hasOwnership) return this.withOwnership(() => this.discover())
    if (!this.control.active) return this.control.run(() => this.discover())
    if (this.policy.quality) return this.quality.discover()
    this.assertEnabled()
    const lease = this.store.acquire("discovery", 120_000)
    if (!lease) return { created: [], reason: "discovery already running" }
    return this.store.withLease(lease, 120_000, async () => {
      const rounds = this.store.list<{ personas: string[]; phase?: string }>("round")
      const pending = rounds.find((r) => r.value.phase === "building")
      const cards = await nativeCards(this.gateway, this.policy.boardId)
      if (
        !pending &&
        cards.some(
          (c) => c.title.startsWith("Investigate:") && ["todo", "ready", "running", "review"].includes(c.status)
        )
      ) {
        return { created: [], reason: "persona round still active" }
      }
      if (
        !pending &&
        cards.filter((c) => ["todo", "ready", "running"].includes(c.status)).length > 2 * this.policy.workerConcurrency
      ) {
        return { created: [], reason: "downstream backpressure" }
      }
      const now = Date.now(),
        since = now - 86_400_000
      if (!pending && rounds.filter((r) => r.updatedAt >= since).length >= this.policy.discoveryDailyRoundLimit)
        return { created: [], reason: "daily discovery limit" }
      const counts: Record<string, number> = {}
      for (const round of rounds.filter((r) => r.updatedAt >= now - 7 * 86_400_000))
        for (const id of round.value.personas) counts[id] = (counts[id] ?? 0) + 1
      const personas = pending
        ? pending.value.personas.map((id) => {
            const persona = this.policy.personas.find((p) => p.personaId === id)
            if (!persona) throw new Error(`Pending persona ${id} no longer configured`)
            return persona
          })
        : selectNativePersonas(this.policy, counts)
      const roundId = pending?.id ?? randomUUID()
      this.store.put("round", roundId, {
        personas: personas.map((p) => p.personaId),
        startedAt: now,
        phase: "building"
      })
      const created: string[] = []
      for (const persona of personas) {
        const card = await this.createCard({
          boardId: this.policy.boardId,
          title: `Investigate: ${persona.personaId}`,
          agentId: persona.personaId,
          status: created.length ? "todo" : "ready",
          parents: created.slice(-1),
          idempotencyKey: `round:${roundId}:${persona.personaId}`,
          workspace: { kind: "dir", path: this.policy.repository },
          notes: JSON.stringify({
            roundId,
            mission: persona,
            instructions: [
              "Investigate repository evidence for your own goals. Do not edit application or framework code.",
              "Compare up to two distinct alternatives. Use autocode_propose with roundId and a proposal containing personaId, goal, title, evidence [{path,observation}], allowedPaths, acceptance, alternatives, implementationPrompt.",
              "No proposal is valid when there is no useful evidence-backed improvement. Record that conclusion.",
              "Use workboard_complete to finish this investigation, with evidence and proposal IDs."
            ],
            recentOutcomes: this.store
              .list<NativeWorkflow>("workflow")
              .slice(-10)
              .map((w) => ({
                title: w.value.proposal.title,
                personaId: w.value.proposal.personaId,
                deployed: Boolean(w.value.deployedSha),
                blocker: w.value.blocker
              }))
          })
        })
        created.push(card.id)
      }
      const planner = await this.createCard({
        boardId: this.policy.boardId,
        title: `Select persona ideas: ${roundId}`,
        agentId: this.policy.plannerAgentId,
        status: "todo",
        parents: created,
        idempotencyKey: `round:${roundId}:admission`,
        workspace: { kind: "dir", path: this.policy.repository },
        notes: JSON.stringify({
          roundId,
          instructions: [
            "Read the completed persona investigations and use autocode_proposals for this round.",
            "Compare evidence, user value, complexity, scope, and rejected alternatives. Admit only the strongest bounded slices using autocode_admit(proposalId, rationale).",
            "Do not invent proposals or concatenate every idea. No admissions is a valid result. Never edit code in this planning session.",
            "Complete the Workboard card with admitted IDs and reasons for deferred alternatives."
          ]
        })
      })
      created.push(planner.id)
      this.store.put("round", roundId, {
        personas: personas.map((p) => p.personaId),
        cards: created,
        startedAt: now,
        phase: "dispatched"
      })
      return { created }
    })
  }
  propose(agentId: string, roundId: string, raw: unknown): { proposalId: string } {
    assertNativeMode(this.policy, "propose")
    this.assertEnabled()
    const round = this.store.get<{ personas: string[]; qualityVersion?: number }>("round", roundId)
    if (round?.qualityVersion) throw new Error("Quality proposals require an authenticated investigation session")
    const proposal = validateNativeProposal(raw, this.policy)
    if (proposal.personaId !== agentId || !round?.personas.includes(agentId))
      throw new Error("Only the investigating persona can submit its proposal")
    const proposalId = `${roundId}:${nativeProposalKey(proposal)}`
    if (this.store.get("proposal", proposalId)) return { proposalId }
    const existing = this.store
      .list<{ roundId: string; proposal: NativeProposal }>("proposal")
      .filter((p) => p.value.roundId === roundId && p.value.proposal.personaId === agentId)
    if (existing.length >= 2) throw new Error("Persona proposal limit reached")
    for (const evidence of proposal.evidence) {
      if (!existsSync(resolve(this.policy.repository, evidence.path)))
        throw new Error(`Missing evidence path: ${evidence.path}`)
      containedDirectory(this.policy.repository, evidence.path)
    }
    this.store.put("proposal", proposalId, { roundId, proposal })
    this.store.event("persona.proposed", proposalId, { personaId: agentId, goal: proposal.goal })
    return { proposalId }
  }
  async admit(
    agentId: string,
    proposalId: string,
    rationale: string
  ): Promise<{ workflowId?: string; duplicate?: boolean; admitted?: false; decision?: unknown; reason?: string }> {
    assertNativeMode(this.policy, "implement")
    if (!this.hasOwnership) return this.withOwnership(() => this.admit(agentId, proposalId, rationale))
    if (!this.control.active) return this.control.run(() => this.admit(agentId, proposalId, rationale))
    this.assertEnabled()
    if (agentId !== this.policy.plannerAgentId || !rationale.trim())
      throw new Error("Admission requires planner rationale")
    const entry = this.store.get<{ roundId: string; proposal: NativeProposal }>("proposal", proposalId)
    if (!entry) throw new Error("Unknown proposal")
    const existingAdmission = entry.proposal.quality
      ? this.store.list<{ proposalId?: string }>("admission").find((item) => item.value.proposalId === proposalId)
      : undefined
    const id = entry.proposal.quality
      ? (existingAdmission?.id ?? createHash("sha256").update(proposalId).digest("hex"))
      : nativeProposalKey(entry.proposal)
    const previous = this.store.get<NativeWorkflow>("workflow", id)
    if (previous) {
      const original = this.store.get<{ proposalId?: string }>("admission", id)
      if (entry.proposal.quality && original?.proposalId && original.proposalId !== proposalId) {
        const decision = {
          outcome: "rejected",
          rationale: `Equivalent proposal already admitted: ${original.proposalId}`,
          uncertainty: entry.proposal.quality.hypothesis.uncertainty,
          workflowId: id
        }
        this.store.put("decision", proposalId, decision)
        return { admitted: false, decision }
      }
      return { workflowId: id, duplicate: true }
    }
    const lease = this.store.acquire("admission", 120_000)
    if (!lease) throw new Error("Admission already running")
    return this.store.withLease(lease, 120_000, async () => {
      let selection: ReturnType<NativeQualityRuntime["selection"]>[number] | undefined
      if (entry.proposal.quality || this.policy.quality) {
        const decision = this.store.get<{ outcome: string }>("decision", proposalId)
        if (decision && decision.outcome !== "admitted") return { admitted: false as const, decision }
        if (
          this.store
            .list<{ roundId: string; state: string }>("investigation")
            .some((i) => i.value.roundId === entry.roundId && i.value.state === "pending")
        )
          return { admitted: false as const, reason: "Investigations still pending" }
        selection = this.quality.selection(entry.roundId).find((d) => d.id === proposalId)
        if (!selection) throw new Error("Benefit hypothesis required; refresh investigation")
        if (selection.outcome !== "selected") {
          this.store.put("decision", proposalId, selection)
          this.store.event("proposal.decided", proposalId, selection)
          return { admitted: false as const, decision: selection }
        }
        await this.quality.admission(proposalId, entry.proposal, entry.roundId)
      }
      const admissions = this.store.list<{ roundId: string }>("admission")
      if (admissions.filter((a) => a.value.roundId === entry.roundId).length >= this.policy.maxTasksPerRound)
        throw new Error("Round admission limit reached")
      const workflows = this.store.list<NativeWorkflow>("workflow")
      const normalizedTitle = (title: string) => title.toLowerCase().replace(/\W+/g, " ").trim()
      if (
        !entry.proposal.quality &&
        workflows.some(
          (w) =>
            w.updatedAt >= Date.now() - this.policy.dedupeWindowHours * 3_600_000 &&
            normalizedTitle(w.value.proposal.title) === normalizedTitle(entry.proposal.title)
        )
      )
        throw new Error("Equivalent recent proposal already admitted")
      if (
        workflows.filter((w) => this.reservesScope(w.value) && !w.value.blocker).length >=
        2 * this.policy.workerConcurrency
      )
        throw new Error("Runnable backlog is full")
      for (const w of workflows.filter((w) => this.reservesScope(w.value))) {
        if (
          entry.proposal.allowedPaths.some((a) =>
            w.value.proposal.allowedPaths.some((b) => artifactScopesOverlap(a, b))
          )
        ) {
          throw new Error(`Artifact scope reserved by ${w.id}`)
        }
      }
      const root = await this.createCard({
        boardId: this.policy.boardId,
        title: entry.proposal.title,
        status: "blocked",
        idempotencyKey: `workflow:${id}`,
        labels: ["autocode:workflow"],
        notes: JSON.stringify({ ...entry, rationale })
      })
      const implementation = await this.createCard({
        boardId: this.policy.boardId,
        title: `Implement: ${entry.proposal.title}`,
        status: "blocked",
        agentId: this.policy.coderAgentId,
        idempotencyKey: `workflow:${id}:implement`,
        maxRetries: 2,
        workspace: {
          kind: "worktree",
          sourcePath: this.policy.repository,
          sourceBranch: `origin/${this.policy.baseBranch}`
        },
        notes: JSON.stringify({
          workflowId: id,
          ...entry.proposal,
          instructions: [
            "Implement this admitted scope in the managed worktree. The autocode_submit broker records the scoped commit; sandbox Git metadata is intentionally unavailable.",
            "Call autocode_submit(workflowId, worktreePath) before workboard_complete. Do not push, merge, release, or deploy.",
            "Framework modifications require human review. Preserve unrelated work."
          ]
        })
      })
      const workflow: NativeWorkflow = {
        lifecycle: upgradeNativeLifecycle(id, {}),
        proposal: entry.proposal,
        rootCardId: root.id,
        implementationCardId: implementation.id,
        stageCards: {}
      }
      this.store.commit(
        [
          { kind: "workflow", id, value: workflow, expectedVersion: 0 },
          {
            kind: "admission",
            id,
            value: { roundId: entry.roundId, rationale, proposalId, selection, phase: "prepared" }
          },
          { kind: "decision", id: proposalId, value: { outcome: "admitted", rationale, selection, workflowId: id } }
        ],
        { kind: "workflow.admitted", subject: id, value: { proposalId, attemptId: workflow.lifecycle!.attemptId } }
      )
      return { workflowId: id, duplicate: false }
    })
  }
  private async dependenciesComplete(workflow: NativeWorkflow): Promise<boolean> {
    if (!workflow.dependencyCardIds?.length) return true
    const cards = await nativeCards(this.gateway, this.policy.boardId)
    return workflow.dependencyCardIds.every((id) => cards.some((card) => card.id === id && card.status === "done"))
  }
  async adoptLegacy(legacyKey: string): Promise<{ workflowId: string }> {
    if (!this.hasOwnership) return this.withOwnership(() => this.adoptLegacy(legacyKey))
    const task = this.store.get<{
      id: string
      title: string
      status: string
      notes: string
      dependencies: string[]
      cardId: string
    }>("migration-task", legacyKey)
    if (!task) throw new Error("Unknown imported legacy task")
    if (!["queued", "review_needed", "promotion_pending"].includes(task.status))
      throw new Error("Blocked legacy work requires explicit rescoping before adoption")
    const workflowId = createHash("sha256").update(`legacy:${legacyKey}`).digest("hex")
    if (this.store.get("workflow", workflowId)) return { workflowId }
    const original = JSON.parse(task.notes)
    const personaId = original.package?.personaProvenance?.personaId ?? original.personaId
    const persona = this.policy.personas.find((p) => p.personaId === personaId)
    if (!persona) throw new Error("Imported task has no configured persona provenance")
    const proposal = validateNativeProposal(
      {
        personaId,
        goal: persona.goals[0],
        title: task.title,
        evidence: [
          {
            path: ".",
            observation: `Preserved legacy task ${legacyKey}; original package and run evidence are attached.`
          }
        ],
        allowedPaths: original.allowedPaths,
        acceptance: original.package?.acceptanceCriteria,
        alternatives: ["Preserve the already-selected legacy scope instead of generating replacement work."],
        implementationPrompt: original.description
      },
      this.policy
    )
    const projectId = legacyKey.slice(0, legacyKey.lastIndexOf(":"))
    const parents = task.dependencies.map((id) => {
      const mapping = this.store.get<{ cardId: string }>("migration-map", `${projectId}:${id}`)
      if (!mapping) throw new Error(`Missing imported dependency ${id}`)
      return mapping.cardId
    })
    const implementation = await this.createCard({
      boardId: this.policy.boardId,
      title: `Implement: ${task.title}`,
      status: "blocked",
      parents,
      agentId: this.policy.coderAgentId,
      idempotencyKey: `workflow:${workflowId}:implement`,
      workspace: {
        kind: "worktree",
        sourcePath: this.policy.repository,
        sourceBranch: `origin/${this.policy.baseBranch}`
      },
      notes: JSON.stringify({
        workflowId,
        proposal,
        preservedEvidence: original.evidence,
        instructions:
          "Recover useful preserved changes and implement the original acceptance criteria. Call autocode_submit(workflowId, worktreePath) to record the scoped commit, then workboard_complete. Do not merge or deploy."
      })
    })
    const workflow: NativeWorkflow = {
      proposal,
      rootCardId: task.cardId,
      implementationCardId: implementation.id,
      stageCards: {},
      dependencyCardIds: parents
    }
    for (const evidence of original.evidence ?? []) {
      if (!evidence.worktree_path || !existsSync(evidence.worktree_path)) continue
      try {
        workflow.candidate = await inspectNativeCandidate(this.policy, evidence.worktree_path, proposal.allowedPaths)
        break
      } catch {
        /* Preserve the original evidence references for the assigned recovery worker. */
      }
    }
    workflow.lifecycle = upgradeNativeLifecycle(workflowId, workflow)
    this.store.commit(
      [
        { kind: "workflow", id: workflowId, value: workflow, expectedVersion: 0 },
        { kind: "admission", id: workflowId, value: { legacyKey, phase: workflow.candidate ? "admitted" : "prepared" } }
      ],
      {
        kind: "migration.adopted",
        subject: workflowId,
        value: { legacyKey, preservedCandidate: Boolean(workflow.candidate) }
      }
    )
    return { workflowId }
  }
  async submit(
    agentId: string,
    sessionKey: string,
    workflowId: string,
    worktreePath: string
  ): Promise<{ accepted: boolean; headSha: string }> {
    assertNativeMode(this.policy, "implement")
    if (!this.hasOwnership) return this.withOwnership(() => this.submit(agentId, sessionKey, workflowId, worktreePath))
    if (!this.control.active) return this.control.run(() => this.submit(agentId, sessionKey, workflowId, worktreePath))
    if (!this.store.holdsLease(`workflow:${workflowId}`))
      return this.withWorkflowLease(workflowId, () => this.submit(agentId, sessionKey, workflowId, worktreePath))
    this.assertEnabled()
    if (agentId !== this.policy.coderAgentId || !sessionKey) throw new Error("Only the assigned coder can submit")
    const workflow = this.requireWorkflow(workflowId)
    const card = (await nativeCards(this.gateway, this.policy.boardId)).find(
      (c) => c.id === workflow.implementationCardId
    )
    this.assertSession(card, sessionKey)
    const workspace = card?.metadata?.automation?.workspace?.path
    if (!workspace || realpathSync(worktreePath) !== realpathSync(workspace))
      throw new Error("Candidate must be the card's managed worktree")
    if (workflow.candidate)
      throw new Error("Candidate already submitted; reconcile existing evidence before resubmission")
    const committed = await commitNativeCandidate(
      this.policy,
      worktreePath,
      workflow.proposal.allowedPaths,
      workflow.proposal.title,
      () => {
        this.control.assert()
        this.store.authorizeEffect()
      }
    )
    if (committed) this.store.event("candidate.committed", workflowId, { headSha: committed, agentId, sessionKey })
    const candidate = await inspectNativeCandidate(this.policy, worktreePath, workflow.proposal.allowedPaths)
    await this.quality.classifyCandidate(workflowId, workflow, candidate, "submission")
    if (!(await this.quality.ensureDesign(workflowId, workflow)))
      throw new Error("High-risk implementation requires approved design review for the current candidate")
    workflow.candidate = candidate
    workflow.submission = { agentId, sessionKey, executionId: card?.execution?.runId ?? card?.runId ?? sessionKey }
    this.transitionWorkflow(workflowId, workflow, "verification")
    return { accepted: true, headSha: workflow.candidate.headSha }
  }
  async review(
    agentId: string,
    sessionKey: string,
    workflowId: string,
    headSha: string,
    verdict: NativeReviewEvidence["verdict"],
    rationale: string,
    assessment?: NativeAssessment
  ): Promise<{ recorded: boolean }> {
    assertNativeMode(this.policy, "review")
    if (!this.hasOwnership)
      return this.withOwnership(() =>
        this.review(agentId, sessionKey, workflowId, headSha, verdict, rationale, assessment)
      )
    if (!this.store.holdsLease(`workflow:${workflowId}`))
      return this.withWorkflowLease(workflowId, () =>
        this.review(agentId, sessionKey, workflowId, headSha, verdict, rationale, assessment)
      )
    this.assertEnabled()
    if (
      agentId !== this.policy.reviewerAgentId ||
      agentId === this.policy.coderAgentId ||
      !rationale.trim() ||
      !["approved", "changes_requested"].includes(verdict)
    )
      throw new Error("Independent reviewer and rationale required")
    const workflow = this.requireWorkflow(workflowId)
    const card = (await nativeCards(this.gateway, this.policy.boardId)).find((c) => c.id === workflow.reviewCardId)
    this.assertSession(card, sessionKey)
    if (!workflow.verification || workflow.verification.headSha !== headSha)
      throw new Error("Review must match verified candidate")
    const structured = workflow.proposal.quality
      ? validateNativeAssessment(assessment, workflow.proposal.acceptance, verdict === "approved")
      : undefined
    const attemptId = workflow.lifecycle!.attemptId
    assertNativeProvenance(this.policy, workflow.verification, {
      workflowId,
      attemptId,
      skillDigest: workflow.proposal.quality?.skillHash ?? nativeContentDigest(workflow.proposal.implementationPrompt)
    })
    workflow.review = {
      receiptVersion: 1,
      attemptId,
      verificationDigest: nativeVerificationDigest(workflow.verification),
      headSha,
      agentId,
      sessionKey,
      verdict,
      rationale,
      ...(structured ? { assessment: structured } : {})
    }
    await this.traceWorkflow(workflowId, workflow, "review", async () =>
      this.transitionWorkflow(workflowId, workflow, verdict === "approved" ? "release" : "review")
    )
    return { recorded: true }
  }
  async requestRepair(id: string, workflow: NativeWorkflow, reason: string): Promise<void> {
    assertNativeMode(this.policy, "implement")
    if (!this.hasOwnership) return this.withOwnership(() => this.requestRepair(id, workflow, reason))
    if (!this.control.active) return this.control.run(() => this.requestRepair(id, workflow, reason))
    if (!this.store.holdsLease(`workflow:${id}`))
      return this.withWorkflowLease(id, () => this.requestRepair(id, workflow, reason))
    this.assertEnabled()
    const unavailable = workflow.verification?.checks.find((check) => [126, 127].includes(check.exitCode ?? 0))
    if (unavailable)
      throw new Error(
        `Verification command unavailable (exit ${unavailable.exitCode}): ${unavailable.argv[0]}; inspect ${unavailable.artifact} and repair the verification environment before operator recovery. Candidate and repair budget preserved.`
      )
    const previousLifecycle = workflow.lifecycle ?? upgradeNativeLifecycle(id, workflow)
    const attempt = (workflow.repairCount ?? 0) + 1
    if (attempt > 2 || !workflow.candidate) throw new Error(`Repair budget exhausted: ${reason}`)
    const signature = createHash("sha256").update(reason).digest("hex")
    this.store.put("attempt-evidence", `${id}:${attempt}`, {
      candidate: workflow.candidate,
      verification: workflow.verification,
      review: workflow.review,
      signature,
      reason
    })
    const card = await this.createCard({
      boardId: this.policy.boardId,
      title: `Repair ${attempt}: ${workflow.proposal.title}`,
      status: "blocked",
      agentId: this.policy.coderAgentId,
      idempotencyKey: `workflow:${id}:repair:${attempt}`,
      maxRetries: 1,
      workspace: { kind: "dir", path: workflow.candidate.cwd },
      notes: JSON.stringify({
        workflowId: id,
        proposal: workflow.proposal,
        reason,
        candidate: workflow.candidate,
        verification: this.verificationForAgent(workflow.verification),
        review: workflow.review,
        instructions:
          "Repair the preserved implementation within its admitted scope. Make a real correction; do not weaken required tests. The submission broker records the scoped commit. Call autocode_submit with workflowId and worktreePath, then workboard_complete. Independent verification and review will run again."
      })
    })
    workflow.repairCount = attempt
    workflow.implementationCardId = card.id
    delete workflow.candidate
    delete workflow.verification
    delete workflow.review
    delete workflow.reviewCardId
    delete workflow.blocker
    workflow.lifecycle = nextNativeAttempt(previousLifecycle, workflow)
    this.store.commit(
      [
        { kind: "workflow", id, value: workflow },
        {
          kind: "admission",
          id,
          value: { ...this.store.get<Record<string, unknown>>("admission", id), phase: "prepared" }
        }
      ],
      {
        kind: "workflow.repair-requested",
        subject: id,
        value: { attempt, attemptId: workflow.lifecycle.attemptId, reason, signature }
      }
    )
  }
  assertSession(card: NativeCard | undefined, sessionKey: string): void {
    if (
      !card ||
      !sessionKey ||
      (card.sessionKey ?? card.execution?.sessionKey) !== sessionKey ||
      card.status !== "running"
    ) {
      throw new Error("Tool caller does not own the active Workboard session")
    }
  }
  requireWorkflow(id: string): NativeWorkflow {
    const value = this.store.get<NativeWorkflow>("workflow", id)
    if (!value) throw new Error("Unknown workflow")
    if (!value.lifecycle) {
      value.lifecycle = upgradeNativeLifecycle(id, value)
      this.store.commit([{ kind: "workflow", id, value }], {
        kind: "workflow.upgraded",
        subject: id,
        value: value.lifecycle
      })
    }
    validateNativeLifecycle(value.lifecycle, value)
    return value
  }
  traceWorkflow<T>(
    id: string,
    workflow: NativeWorkflow,
    stage: NativeTraceStage,
    action: () => Promise<T>
  ): Promise<T> {
    return withNativeStageTrace(
      this.store,
      {
        boardId: this.policy.boardId,
        workflowId: id,
        attemptId: workflow.lifecycle?.attemptId ?? `${id}:legacy`,
        stage,
        policyDigest: nativePolicyTraceDigest(this.policy),
        cardId: workflow.implementationCardId,
        ...(workflow.submission
          ? { sessionId: workflow.submission.sessionKey, runId: workflow.submission.executionId }
          : {})
      },
      action
    )
  }
  transitionWorkflow(id: string, workflow: NativeWorkflow, state: NativeWorkflowState): void {
    const previous = workflow.lifecycle ?? upgradeNativeLifecycle(id, workflow)
    const next = transitionNativeLifecycle(previous, state, workflow)
    workflow.lifecycle = next
    if (JSON.stringify(this.store.get("workflow", id)) === JSON.stringify(workflow)) return
    this.store.commit([{ kind: "workflow", id, value: workflow }], {
      kind: "workflow.transitioned",
      subject: id,
      value: {
        from: previous.state,
        ...next,
        reviewVerdict: workflow.review?.verdict,
        deployedSha: workflow.deployedSha,
        mergedSha: workflow.mergedSha
      }
    })
  }
  async stage(id: string, workflow: NativeWorkflow, stage: string, status: string, notes: string): Promise<string> {
    if (stage === "Review")
      workflow.lifecycle = transitionNativeLifecycle(
        workflow.lifecycle ?? upgradeNativeLifecycle(id, workflow),
        "review",
        workflow
      )
    const card = await this.createCard(
      {
        boardId: this.policy.boardId,
        title: `${stage}: ${workflow.proposal.title}`,
        status,
        idempotencyKey: `workflow:${id}:${stage}:${workflow.candidate?.headSha ?? "none"}`,
        notes,
        ...(stage === "Review"
          ? { agentId: this.policy.reviewerAgentId, workspace: { kind: "dir", path: workflow.candidate!.cwd } }
          : {})
      },
      [{ kind: "workflow", id, value: workflow }]
    )
    workflow.stageCards[stage] = card.id
    this.store.put("workflow", id, workflow)
    return card.id
  }
  async withWorkflowLease<T>(id: string, action: () => Promise<T>): Promise<T> {
    const key = `workflow:${id}`
    if (this.store.holdsLease(key)) return action()
    const lease = this.store.acquire(key, 120_000)
    if (!lease) throw new Error("Workflow is advancing; retry against fresh evidence")
    return this.store.withLease(lease, 120_000, action)
  }
  async withCapacity<T>(pool: "verification" | "release", limit: number, action: () => Promise<T>): Promise<T | null> {
    for (let slot = 0; slot < limit; slot++) {
      const lease = this.store.acquire(`capacity:${pool}:${slot}`, 120_000)
      if (lease) return this.store.withLease(lease, 120_000, action)
    }
    return null
  }
  async advanceWorkflow(id: string): Promise<number> {
    const lease = this.store.acquire(`workflow:${id}`, 120_000)
    if (!lease) return 0
    return this.store.withLease(lease, 120_000, () => this.advanceWorkflowStep(id))
  }
  async advanceWorkflowStep(id: string): Promise<number> {
    let advanced = 0
    const w = this.requireWorkflow(id)
    if (w.lifecycle?.state === "cancelled" || w.archivedAt) return advanced
    if (w.deployedSha) {
      for (const cardId of [w.stageCards.Deploy, w.rootCardId].filter(Boolean)) {
        await this.gateway.request("workboard.cards.move", { id: cardId, status: "done" })
      }
      return advanced
    }
    if (w.blocker || !w.candidate || !(await this.dependenciesComplete(w))) return advanced
    try {
      if (this.isPaused()) {
        // Observe accepted release effects even while new execution is disabled.
        if (w.review?.verdict === "approved" && this.store.list("operation").some((op) => op.id.startsWith(`${id}:`)))
          await this.withCapacity("release", 1, async () => {
            await releaseNativeWorkflow(this, id, w)
            return true
          })
        return advanced
      }
      if (!nativeModeAllows(this.policy, "verify")) return advanced
      this.control.assert()
      if (w.review?.verdict === "changes_requested") {
        await this.requestRepair(id, w, w.review.rationale)
        advanced++
        return advanced
      }
      if (!w.verification) {
        if (!w.submission)
          throw new Error(
            "Legacy candidate lacks authenticated submission identity; use an explicit retry recovery plan"
          )
        this.reserveBudget(id, w.lifecycle!.attemptId, "verify", `verify:${id}:${w.lifecycle!.attemptId}`)
        const cardId = await this.stage(id, w, "Verify", "blocked", "Independent commit-bound verification")
        const verification = await this.withCapacity("verification", this.policy.workerConcurrency, () =>
          this.traceWorkflow(id, w, "verification", () =>
            verifyNativeCandidate(
              this.policy,
              w.candidate!,
              resolve(this.policy.repository, ".openclaw/native-artifacts", id, w.candidate!.headSha),
              this.control.signal,
              {
                authorize: () => {
                  this.store.authorizeEffect()
                  this.control.assert()
                },
                mutate: (action) => this.store.fencedMutation(action)
              },
              w.proposal.acceptance,
              {
                workflowId: id,
                attemptId: w.lifecycle!.attemptId,
                skillDigest: w.proposal.quality?.skillHash ?? nativeContentDigest(w.proposal.implementationPrompt),
                executionId: w.submission!.executionId,
                agentId: w.submission!.agentId,
                sessionKey: w.submission!.sessionKey
              }
            )
          )
        )
        if (!verification) return advanced
        w.verification = verification
        this.store.put("workflow", id, w)
        if (
          w.verification.checks.length !== nativeVerificationCommands(this.policy, w.candidate.files).length ||
          w.verification.checks.some((c) => c.exitCode !== 0)
        ) {
          await this.requestRepair(
            id,
            w,
            `Verification failed: ${JSON.stringify(w.verification.checks.filter((c) => c.exitCode !== 0).map((c) => ({ argv: c.argv, exitCode: c.exitCode })))}`
          )
          advanced++
          return advanced
        }
        await this.gateway.request("workboard.cards.move", { id: cardId, status: "done" })
        advanced++
      }
      if (!w.reviewCardId) {
        w.reviewCardId = await this.stage(
          id,
          w,
          "Review",
          "ready",
          JSON.stringify({
            workflowId: id,
            candidate: w.candidate,
            verification: this.verificationForAgent(w.verification),
            proposal: w.proposal,
            instructions:
              "Independently inspect the commit and acceptance criteria. Use autocode_review(workflowId, headSha, verdict, rationale, assessment), where assessment is {criteria:[{criterion,satisfied,evidence}],findings:[{blocking,description}]}. Address every acceptance criterion with concrete evidence. Then workboard_complete. Do not edit the candidate or deploy."
          })
        )
        this.store.put("workflow", id, w)
      }
      if (w.review?.verdict === "approved" && nativeModeAllows(this.policy, "release")) {
        assertNativeReleaseGate({
          headSha: w.candidate.headSha,
          authorAgentId: this.policy.coderAgentId,
          reviewerAgentId: this.policy.reviewerAgentId,
          verification: w.verification,
          review: w.review
        })
        const released = await this.withCapacity("release", 1, async () => {
          await releaseNativeWorkflow(this, id, w)
          return true
        })
        if (released) advanced++
      }
    } catch (error) {
      if (error instanceof NativeLeaseLost || error instanceof NativeRevisionConflict) return advanced
      if (error instanceof NativeReleasePending || error instanceof NativeControlRevoked) {
        this.store.event("release.waiting", id, { reason: error.message })
        return advanced
      }
      w.blocker = String(error)
      this.transitionWorkflow(id, w, "blocked")
      try {
        await this.gateway.request("workboard.cards.comment", {
          id: w.rootCardId,
          body: w.blocker.slice(0, 1900)
        })
      } catch {
        /* Durable blocker remains available to native status and the next reconciliation. */
      }
    }

    return advanced
  }
  async reconcile(): Promise<{ advanced: number; paused?: boolean }> {
    if (!this.hasOwnership) return this.withOwnership(() => this.reconcile())
    if (!this.control.active) return this.control.run(() => this.reconcile())
    const lease = this.store.acquire("reconcile", 120_000)
    if (!lease) return { advanced: 0 }
    let advanced = 0
    try {
      // Only board decisions and native dispatch share this short lease. No candidate command runs here.
      const selected = await this.store.withLease(lease, 120_000, async () => {
        if (this.policy.quality && !this.isPaused()) await this.quality.syncInvestigations()
        for (const admission of this.store
          .list<{ phase: string }>("admission")
          .filter(
            (a) => a.value.phase === "prepared" && !this.isPaused() && nativeModeAllows(this.policy, "implement")
          )) {
          const workflowLease = this.store.acquire(`workflow:${admission.id}`, 120_000)
          if (!workflowLease) continue
          await this.store.withLease(workflowLease, 120_000, async () => {
            const w = this.requireWorkflow(admission.id)
            if (!this.reservesScope(w)) return
            if (w.blocker || !(await this.dependenciesComplete(w))) return
            if (!(await this.quality.ensureDesign(admission.id, w))) return
            const cards = await nativeCards(this.gateway, this.policy.boardId)
            const workerCards = new Set(
              this.store.list<NativeWorkflow>("workflow").map((item) => item.value.implementationCardId)
            )
            const occupied = cards.filter(
              (card) =>
                card.id !== w.implementationCardId &&
                workerCards.has(card.id) &&
                ["ready", "running"].includes(card.status)
            ).length
            if (occupied >= this.policy.workerConcurrency) return
            const implementation = cards.find((card) => card.id === w.implementationCardId)
            if (!implementation) throw new Error("Prepared implementation card is missing")
            const scheduledAt = implementation.metadata?.automation?.scheduledAt
            if (scheduledAt && scheduledAt > Date.now()) return
            // Migrate owned undated legacy holds without overriding operator schedules.
            if (implementation.status === "scheduled" && !scheduledAt) {
              this.control.assert()
              await this.gateway.request("workboard.cards.update", {
                id: implementation.id,
                ...(implementation.updatedAt ? { expectedUpdatedAt: implementation.updatedAt } : {}),
                patch: { status: "blocked" }
              })
            }
            this.control.assert()
            await this.gateway.request("workboard.cards.move", {
              id: w.implementationCardId,
              status: this.policy.repositoryKind === "framework" ? "blocked" : "ready"
            })
            this.store.put("admission", admission.id, { ...admission.value, phase: "admitted" })
          })
        }

        // Ended implementations without a submission must remain visible and recoverable.
        // Never revive a Workboard execution or discard its historical association here.
        const waiting = this.store
          .list<NativeWorkflow>("workflow")
          .filter(
            ({ value }) =>
              !value.candidate && !value.blocker && !value.archivedAt && value.lifecycle?.state !== "cancelled"
          )
        if (waiting.length) {
          const cards = await nativeCards(this.gateway, this.policy.boardId)
          for (const { id } of waiting) {
            const workflowLease = this.store.acquire(`workflow:${id}`, 120_000)
            if (!workflowLease) continue
            await this.store.withLease(workflowLease, 120_000, async () => {
              const w = this.requireWorkflow(id)
              if (w.candidate || w.blocker) return
              const card = cards.find((c) => c.id === w.implementationCardId)
              if (!card || ["running", "ready", "scheduled"].includes(card.status)) return
              if (
                !card.execution ||
                !["failed", "cancelled", "review", "completed", "done", "blocked", "timed_out", "timeout"].includes(
                  card.execution.status ?? ""
                )
              )
                return
              w.blocker = `Implementation ended (${card.execution.status}) without an authenticated candidate submission; review the attempt and use operator recovery`
              this.transitionWorkflow(id, w, "blocked")
              this.store.event("implementation.ended-without-candidate", id, {
                cardId: card.id,
                status: card.execution.status
              })
            })
          }
        }

        const ids = this.store
          .list<NativeWorkflow>("workflow")
          .filter(
            ({ value }) =>
              !value.blocker && value.lifecycle?.state !== "cancelled" && !value.archivedAt && Boolean(value.candidate)
          )
          .map(({ id }) => id)
          .sort()
        const previous = this.store.get<{ lastId: string }>("reconcile-cursor", this.policy.boardId)?.lastId
        const offset = previous ? (ids.indexOf(previous) + 1) % Math.max(1, ids.length) : 0
        const ordered = [...ids.slice(offset), ...ids.slice(0, offset)].slice(
          0,
          Math.max(2, this.policy.workerConcurrency * 2)
        )
        if (ordered.length) this.store.put("reconcile-cursor", this.policy.boardId, { lastId: ordered.at(-1)! })
        if (!this.isPaused() && nativeModeAllows(this.policy, "investigate")) {
          this.control.assert()
          await this.gateway.request("workboard.cards.dispatchWithOptions", {
            boardId: this.policy.boardId,
            maxStarts: this.policy.workerConcurrency
          })
        }
        return ordered
      })
      // Pools and workflow leases are persisted; Promise concurrency never grants ownership.
      const results = await Promise.allSettled(selected.map((id) => this.advanceWorkflow(id)))
      for (const result of results) {
        if (result.status === "fulfilled") advanced += result.value
        else if (
          !(result.reason instanceof NativeLeaseLost) &&
          !(result.reason instanceof NativeRevisionConflict) &&
          !(result.reason instanceof NativeControlRevoked)
        )
          throw result.reason
      }
      if (this.isPaused()) return { advanced, paused: true }
      return { advanced }
    } catch (error) {
      if (error instanceof NativeControlRevoked) return { advanced, paused: true }
      throw error
    } finally {
      try {
        reconcileNativeNotifications(this.store, this.policy.boardId)
        const memoryConfig = this.store.get<NativeMemoryConfig>("native-memory-config", this.policy.boardId)
        if (memoryConfig) exportNativeLessons(this.store, memoryConfig)
      } catch {
        /* No effect retries from telemetry. */
      }
    }
  }
}
