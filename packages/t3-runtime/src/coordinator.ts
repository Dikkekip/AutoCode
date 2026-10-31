import { realpathSync } from "node:fs"
import type { AdapterType } from "@openclaw/domain"
import { collectT3Candidate } from "./artifacts.js"
import type { T3Lease } from "./journal.js"
import { digest, renderT3PersonaPrompt, type T3Role } from "./personas.js"
import { assertT3CurrentSource, type T3Source } from "./source.js"
import { type T3Capabilities, type T3Host, t3Object } from "./transport.js"
import type { T3Proposal, T3Review, T3Verification, T3Workflow, T3WorkflowEngine } from "./workflow.js"

export interface T3Route {
  providerInstanceId: string
  model: string
  options: Record<string, string | boolean>
}
export interface T3CoordinatorConfig {
  parentThreadId: string
  projectId: string
  /** Every legacy adapter preference requires an explicit operator mapping. No implicit provider swaps. */
  routes: Partial<Record<AdapterType, T3Route>>
  /** T3 0.1.5 has no delegated tool allowlist. Default fails closed; explicit acceptance is recorded. */
  researchBoundary: "require-tool-allowlist" | "accept-prompt-only"
}
export interface T3DispatchResult {
  assignmentId: string
  taskId: string
  link: string | null
  next: string | null
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} missing`)
  return value
}

/** An event-driven coordinator embedded in an authenticated T3 tool caller.
 * Never polls, starts top-level threads, shells out to a provider, or reads session credentials. */
export class T3Coordinator {
  private capabilityPromise: Promise<T3Capabilities> | undefined
  readonly config: T3CoordinatorConfig

  constructor(
    readonly engine: T3WorkflowEngine,
    readonly host: T3Host,
    config: T3CoordinatorConfig
  ) {
    this.config = structuredClone(config)
    text(config.parentThreadId, "Parent thread")
    text(config.projectId, "Project")
    if (!["require-tool-allowlist", "accept-prompt-only"].includes(config.researchBoundary))
      throw new Error("Research boundary must be explicit")
  }

  /** Once per coordinator/thread. Reconstruct explicitly after a provider change or capability error. */
  capabilities(): Promise<T3Capabilities> {
    this.capabilityPromise ??= this.host.capabilities()
    return this.capabilityPromise
  }

  /** One investigation per committed source, persona, goal and skill, across duplicate schedule/webhook wakes. */
  researchTick(lease: T3Lease, source: T3Source, skillDigest: string): T3Workflow[] {
    if (!/^[a-f0-9]{64}$/.test(skillDigest)) throw new Error("Research skill digest required")
    assertT3CurrentSource(source)
    return this.engine.policy.rolePersonas.research.map((personaId) => {
      const persona = this.engine.personas.get(personaId)!
      const id = digest({
        project: lease.projectId,
        source: source.digest,
        persona: persona.digest,
        goal: this.engine.policy.goal,
        policy: this.engine.policyDigest,
        skill: skillDigest
      })
      return this.engine.startResearch(lease, id, personaId, source)
    })
  }

  async dispatch(
    lease: T3Lease,
    id: string,
    skill: { content: string; digest: string },
    estimatedTokens: number
  ): Promise<T3DispatchResult> {
    this.engine.journal.assertOwner(lease)
    if (this.engine.control(lease.projectId).mode !== "running") throw new Error("Project is paused or frozen")
    const item = this.engine.get(lease.projectId, id).value
    this.engine.assertPolicy(item)
    if (!["research", "planner", "design", "implementation", "verification", "review", "release"].includes(item.phase))
      throw new Error("Workflow has no dispatchable responsibility")
    const role = item.phase as T3Role
    if (role === "research" && this.config.researchBoundary === "require-tool-allowlist")
      throw new Error(
        "Unsupported T3 capability: enforced research tool allowlist; prompt-only operation requires explicit configuration"
      )
    const capabilities = await this.capabilities()
    await this.assertBinding(item, capabilities)
    if (!capabilities.features.appOwnedSubagents) throw new Error("T3 app-owned subagents unavailable")
    const pending = item.assignments.find((a) => a.status === "prepared" || a.status === "running")
    const persona = pending
      ? this.engine.personas.get(pending.personaId)!
      : role === "research"
        ? this.engine.personas.get(item.researchPersonaId)!
        : this.engine.selectPersona(lease.projectId, role)
    const preference = persona.manager?.preferredAdapterType ?? persona.definition.defaultAdapterPreference
    const route = this.config.routes[preference]
    if (!route) throw new Error(`No authorized T3 provider mapping for ${preference}`)
    this.assertRoute(capabilities, route)
    const revision = item.candidate?.revision ?? item.source.revision
    const assignmentId =
      pending?.id ?? digest({ project: lease.projectId, workflow: id, ordinal: item.assignments.length + 1 })
    const prompt = renderT3PersonaPrompt({
      persona,
      role,
      projectGoal: this.engine.policy.goal,
      repository: item.source.repository,
      revision,
      sourceManifestDigest: item.source.digest,
      skill,
      context: {
        assignmentId,
        workflowId: id,
        proposal: item.proposal,
        candidate: item.candidate,
        verification: item.verification,
        review: item.review,
        repairs: item.repairs,
        reason: item.reason,
        repairFrom: item.repairFrom,
        researchBoundary: this.config.researchBoundary,
        resultContract:
          "Return JSON with assignmentId, role, revision, personaDigest, promptDigest and sourceManifestDigest plus result. Never claim a host receipt or sandbox receipt.",
        candidateAccess:
          "For verification/review/release, inspect the explicit repository and commit, not an assumed child checkout HEAD. Only implementation may edit code. Never publish, merge, deploy or enable schedules."
      }
    })
    // The result cannot include its own prompt hash inside the hashed prompt. Append a separate binding trailer.
    const task = `${prompt.text}\n\nBinding: ${JSON.stringify({ assignmentId, role, revision, personaDigest: persona.digest, promptDigest: prompt.digest, sourceManifestDigest: item.source.digest })}`
    const args: Record<string, unknown> = {
      clientRequestId: assignmentId,
      task,
      title: `AutoCode ${role}: ${item.proposal?.title ?? persona.definition.name}`,
      role: this.hostRole(role),
      mode: "async",
      isolation: role === "implementation" ? "worktree" : "shared",
      runtimeMode: "inherit",
      interactionMode: "default",
      target: { providerInstanceId: route.providerInstanceId, model: route.model, options: route.options }
    }
    const effectId = `delegate:${assignmentId}`
    const effect = this.engine.journal.reserveEffect(lease, effectId, "delegate_task", args)
    if (!pending)
      this.engine.prepareAssignment(
        lease,
        id,
        {
          id: assignmentId,
          role,
          personaId: persona.definition.id,
          personaDigest: persona.digest,
          promptDigest: prompt.digest,
          providerInstanceId: route.providerInstanceId,
          revision
        },
        estimatedTokens
      )
    else if (pending.promptDigest !== prompt.digest || pending.providerInstanceId !== route.providerInstanceId)
      throw new Error("Prepared assignment configuration changed; reconcile before changing it")
    if (effect.status === "uncertain")
      throw new Error("Dispatch outcome uncertain; observe and reconcile the original request before further work")
    if (effect.status === "reconciled-absent")
      throw new Error("Dispatch observed absent; close this assignment explicitly before making a new request")
    let receipt = effect.result
    if (effect.status === "prepared") {
      if (this.engine.control(lease.projectId).mode !== "running") throw new Error("Project is paused or frozen")
      if (Date.now() >= this.engine.policy.deadline) throw new Error("Project time budget exhausted")
      this.engine.journal.markEffect(lease, effectId, "prepared", "uncertain")
      receipt = await this.host.invoke("delegate_task", args)
      this.validateDispatch(receipt, route)
      this.engine.journal.markEffect(lease, effectId, "uncertain", "confirmed", receipt)
    }
    if (!receipt) throw new Error("Confirmed dispatch lacks a receipt")
    this.validateDispatch(receipt, route)
    const taskId = text(receipt.taskId, "Task ID")
    this.engine.attachTask(lease, id, assignmentId, taskId)
    return {
      assignmentId,
      taskId,
      link: typeof receipt.link === "string" ? receipt.link : null,
      next: typeof receipt.next === "string" ? receipt.next : null
    }
  }

  /** Interpret only retained, bound worker data. Collect source/runtime facts independently.
   * Protected verification evidence must come from verifyT3Candidate's confirmed journal effect. */
  async applyCompletedResult(lease: T3Lease, id: string, assignmentId: string): Promise<T3Workflow> {
    const item = this.engine.get(lease.projectId, id).value
    const assignment = item.assignments.find((a) => a.id === assignmentId)
    if (!assignment || assignment.status !== "completed") throw new Error("Observed completed assignment required")
    if (assignment.resultApplied) return item
    const envelope = this.engine.journal.read<Record<string, unknown>>(
      lease.projectId,
      "completion",
      assignmentId
    )?.value
    if (!envelope) throw new Error("Retained worker result required")
    const result = t3Object(envelope.result, "Worker result.result")
    switch (assignment.role) {
      case "research":
        if (typeof result.noOp === "string")
          this.engine.completeResearch(lease, id, assignmentId, {
            noOp: result.noOp,
            inspectedPaths: result.inspectedPaths as string[]
          })
        else
          this.engine.completeResearch(lease, id, assignmentId, {
            proposal: t3Object(result.proposal, "Research proposal") as unknown as T3Proposal
          })
        break
      case "planner":
        assertT3CurrentSource(item.source)
        this.engine.plan(
          lease,
          id,
          assignmentId,
          result.decision as "admit" | "defer" | "reject",
          text(result.reason, "Planner reason"),
          item.source.digest
        )
        break
      case "design":
        this.engine.design(lease, id, assignmentId, result.approved as boolean, text(result.reason, "Design reason"))
        break
      case "implementation": {
        const worktree = await this.implementationWorktree(item, assignment.id)
        const candidate = collectT3Candidate(
          item.source,
          worktree,
          text(result.revision, "Candidate revision"),
          assignment.taskId!
        )
        this.engine.recordCandidate(lease, id, assignmentId, candidate)
        break
      }
      case "verification": {
        const effect = this.engine.journal.effect(`verify:${assignmentId}`)
        if (
          effect?.status !== "confirmed" ||
          effect.projectId !== lease.projectId ||
          effect.tool !== "protected_verification" ||
          !effect.result
        )
          throw new Error("A confirmed protected verifier receipt is required; worker claims are insufficient")
        this.engine.recordVerification(
          lease,
          id,
          assignmentId,
          t3Object(effect.result.evidence, "Protected verification evidence") as unknown as T3Verification
        )
        break
      }
      case "review":
        this.engine.recordReview(lease, id, assignmentId, result as unknown as T3Review)
        break
      case "release": {
        const implementation = item.assignments
          .filter((a) => a.role === "implementation" && a.status === "completed")
          .at(-1)
        if (!implementation || !item.candidate) throw new Error("Retained implementation required")
        const worktree = await this.implementationWorktree(item, implementation.id)
        const observed = collectT3Candidate(item.source, worktree, item.candidate.revision, implementation.taskId!)
        if (observed.treeDigest !== item.candidate.treeDigest || result.ready !== true)
          throw new Error("Release candidate is not ready or its tree changed")
        this.engine.releaseReady(lease, id, assignmentId, observed.revision)
        break
      }
    }
    return this.engine.get(lease.projectId, id).value
  }

  /** Invoke once in response to T3's completion wake. Repeated wake IDs are idempotent.
   * Returns untrusted worker JSON; host receipt and binding are checked before import into policy. */
  async onCompletionWake(
    lease: T3Lease,
    id: string,
    assignmentId: string,
    wakeId: string
  ): Promise<Record<string, unknown>> {
    text(wakeId, "Completion wake identity")
    this.engine.journal.assertOwner(lease)
    const item = this.engine.get(lease.projectId, id).value
    const assignment = item.assignments.find((a) => a.id === assignmentId)
    if (!assignment) throw new Error("Completion does not belong to this workflow")
    const prior = this.engine.journal.read<Record<string, unknown>>(lease.projectId, "completion", assignmentId)
    if (prior) return prior.value
    if (!assignment?.taskId || assignment.status !== "running")
      throw new Error("No running assignment for this completion")
    const receipt = await this.host.invoke("task_status", { taskId: assignment.taskId })
    const dispatchReceipt = this.engine.journal.effect(`delegate:${assignmentId}`)?.result
    if (
      receipt.taskId !== assignment.taskId ||
      receipt.providerInstanceId !== assignment.providerInstanceId ||
      !dispatchReceipt ||
      receipt.model !== dispatchReceipt.model ||
      receipt.hasPendingChildRuns !== false ||
      receipt.hasPendingQuestion !== false ||
      receipt.workState !== "result_available"
    )
      throw new Error(
        "Completion has pending work, a question or mismatched host identity; follow the host's next instruction"
      )
    const status = receipt.status === "interrupted" ? "cancelled" : receipt.status
    if (status !== "completed" && status !== "failed" && status !== "cancelled")
      throw new Error("Task is not terminal; do not poll")
    const runId = receipt.latestTerminalRunId === null ? null : text(receipt.latestTerminalRunId, "Terminal run")
    if (runId === null) {
      if (
        status === "completed" ||
        receipt.childRunId !== null ||
        (receipt.latestTerminalStatus !== null && receipt.latestTerminalStatus !== receipt.status)
      )
        throw new Error("No observed terminal run or queued cancellation identity")
    } else if (receipt.latestTerminalStatus !== receipt.status) throw new Error("Terminal run status mismatch")
    let envelope: Record<string, unknown>
    if (status === "completed") {
      envelope = t3Object(JSON.parse(text(receipt.summary, "Worker JSON result")), "Worker result")
      for (const [key, expected] of Object.entries({
        assignmentId,
        role: assignment.role,
        revision: assignment.revision,
        personaDigest: assignment.personaDigest,
        promptDigest: assignment.promptDigest,
        sourceManifestDigest: item.source.digest
      }))
        if (envelope[key] !== expected) throw new Error(`Worker result binding mismatch: ${key}`)
      t3Object(envelope.result, "Worker result.result")
    } else envelope = { assignmentId, status, observedStatus: receipt.status, reason: receipt.summary ?? null }
    // Result custody and task settlement commit atomically, including across coordinator restart.
    this.engine.settleTask(
      lease,
      id,
      assignmentId,
      { taskId: assignment.taskId, runId, status, hasPendingChildRuns: false },
      { envelope, wakeId, receipt }
    )
    return envelope
  }

  /** Freeze prevents further dispatch immediately. Existing tasks need explicit observed cancellation.
   * Effect uncertainty remains durable on lost replies; never send task_cancel by child thread ID. */
  async cancelAssignment(lease: T3Lease, id: string, assignmentId: string, reason: string): Promise<void> {
    const assignment = this.engine.get(lease.projectId, id).value.assignments.find((a) => a.id === assignmentId)
    if (!assignment?.taskId || assignment.status !== "running")
      throw new Error("Known running host task required for cancellation")
    const capabilities = await this.capabilities()
    if (!capabilities.features.cancellation) throw new Error("T3 task cancellation unavailable")
    const effectId = `cancel:${assignment.id}`
    const args = { taskId: assignment.taskId, reason, clientRequestId: digest({ cancel: assignment.id }) }
    const effect = this.engine.journal.reserveEffect(lease, effectId, "task_cancel", args)
    if (effect.status === "uncertain") throw new Error("Cancellation outcome uncertain; reconcile before retry")
    if (effect.status !== "prepared") return
    this.engine.journal.markEffect(lease, effectId, "prepared", "uncertain")
    const receipt = await this.host.invoke("task_cancel", args)
    if (
      receipt.taskId !== assignment.taskId ||
      !["cancel_requested", "completed", "failed", "cancelled", "interrupted"].includes(String(receipt.status))
    )
      throw new Error("Invalid host cancellation receipt")
    this.engine.journal.markEffect(lease, effectId, "uncertain", "confirmed", receipt)
    // A cancel_requested reply is not terminal. Wait for the host wake before closing reservations.
  }

  async freeze(
    lease: T3Lease,
    reason: string
  ): Promise<{ unresolved: Array<{ workflowId: string; assignmentId: string; reason: string }> }> {
    this.engine.setControl(lease, "frozen", reason)
    const unresolved: Array<{ workflowId: string; assignmentId: string; reason: string }> = []
    for (const row of this.engine.journal.list<T3Workflow>(lease.projectId, "workflow")) {
      for (const assignment of row.value.assignments.filter((a) => a.status === "prepared" || a.status === "running")) {
        if (!assignment.taskId) {
          unresolved.push({
            workflowId: row.id,
            assignmentId: assignment.id,
            reason: "Dispatch may be uncertain; reconcile its identity before cancellation"
          })
          continue
        }
        try {
          await this.cancelAssignment(lease, row.id, assignment.id, reason)
          unresolved.push({
            workflowId: row.id,
            assignmentId: assignment.id,
            reason: "Cancellation requested; terminal completion wake is still required"
          })
        } catch (error) {
          unresolved.push({
            workflowId: row.id,
            assignmentId: assignment.id,
            reason: error instanceof Error ? error.message : "Cancellation not confirmed"
          })
        }
      }
    }
    return { unresolved }
  }

  /** Save only a disabled recurring trigger. Activation remains an explicit operator action. */
  async saveDisabledSchedule(lease: T3Lease, everyMs: number): Promise<Record<string, unknown>> {
    const capabilities = await this.capabilities()
    if (!capabilities.features.scheduledTasks || capabilities.parentThreadId !== this.config.parentThreadId)
      throw new Error("Scheduled tasks unavailable or caller belongs to another parent")
    const parent = t3Object(
      (
        await this.host.invoke("t3_thread_read", {
          threadId: this.config.parentThreadId,
          limit: 1,
          maxCharsPerItem: 1,
          runLimit: 1
        })
      ).thread,
      "Schedule parent"
    )
    if (parent.projectId !== this.config.projectId || parent.archived !== false)
      throw new Error("Schedule project binding mismatch")
    const args = this.scheduleRequest(everyMs)
    const effectId = `schedule:${String(args.clientRequestId)}`
    const effect = this.engine.journal.reserveEffect(lease, effectId, "schedule_task", args)
    if (effect.status === "confirmed" && effect.result) return effect.result
    if (effect.status !== "prepared") throw new Error("Schedule outcome uncertain; reconcile before retry")
    this.engine.journal.markEffect(lease, effectId, "prepared", "uncertain")
    const receipt = await this.host.invoke("schedule_task", args)
    if (
      typeof receipt.scheduledTaskId !== "string" ||
      receipt.enabled !== false ||
      receipt.projectId !== this.config.projectId ||
      receipt.boundThreadId !== this.config.parentThreadId
    )
      throw new Error("Disabled schedule receipt does not match the requested binding")
    this.engine.journal.markEffect(lease, effectId, "uncertain", "confirmed", receipt)
    return receipt
  }

  recoveryReport(projectId: string): Record<string, unknown> {
    return {
      control: this.engine.control(projectId),
      usage: this.engine.usage(projectId),
      workflows: this.engine.journal.list<T3Workflow>(projectId, "workflow").map(({ value }) => ({
        id: value.id,
        phase: value.phase,
        board: value.board,
        reason: value.reason,
        candidateRevision: value.candidate?.revision ?? null,
        activeAssignments: value.assignments
          .filter((a) => ["prepared", "running"].includes(a.status))
          .map((a) => ({ id: a.id, role: a.role, taskId: a.taskId, status: a.status }))
      })),
      uncertainEffects: this.engine.journal
        .effects(projectId)
        .filter((effect) => effect.status === "uncertain")
        .map((effect) => ({
          id: effect.id,
          tool: effect.tool,
          instruction:
            "Retain the original intent. Observe authoritative identity/outcome before recording reconciliation; never blindly replay."
        }))
    }
  }

  /** Stable proposal for an operator to save using schedule_task; disabled by default. */
  scheduleRequest(everyMs: number): Record<string, unknown> {
    if (!Number.isSafeInteger(everyMs) || everyMs < 60_000)
      throw new Error("T3 schedule interval must be at least 60000ms")
    return {
      clientRequestId: digest({ project: this.config.projectId, coordinator: this.config.parentThreadId, everyMs }),
      projectId: this.config.projectId,
      bindToCurrentThread: true,
      enabled: false,
      title: "AutoCode persona research and reconciliation",
      schedule: { type: "interval", everyMs },
      prompt: `Resume the AutoCode coordinator for project ${this.config.projectId}. Acquire its durable project lease, honor pause/freeze and budgets, reconcile delivered completion events, then admit bounded persona work. Enqueue success is not workflow completion. Never replay uncertain effects, poll running delegates, publish, merge, deploy or enable schedules. End the turn when a delegate's next instruction requires it.`
    }
  }

  /** Native goals belong to the provider thread; this is the supported user command, not a fake MCP goal API. */
  goalCommand(): string {
    return `/goal ${this.engine.policy.goal}`
  }

  private async assertBinding(item: T3Workflow, capabilities: T3Capabilities): Promise<void> {
    if (capabilities.parentThreadId !== this.config.parentThreadId)
      throw new Error("Authenticated T3 caller is bound to another parent thread")
    const parent = t3Object(
      (
        await this.host.invoke("t3_thread_read", {
          threadId: this.config.parentThreadId,
          limit: 1,
          maxCharsPerItem: 1,
          runLimit: 1
        })
      ).thread,
      "Parent thread"
    )
    if (
      parent.threadId !== this.config.parentThreadId ||
      parent.projectId !== this.config.projectId ||
      parent.archived !== false
    )
      throw new Error("T3 project binding mismatch or parent archived")
    const project = await this.host.invoke("t3_project_read", { projectId: this.config.projectId })
    const workspace = parent.worktreePath ?? project.workspaceRoot
    if (typeof workspace !== "string" || realpathSync(workspace) !== realpathSync(item.source.repository))
      throw new Error(
        "T3 parent checkout does not match the AutoCode source repository; bind a proper project before dispatch"
      )
    // The host prepares implementation worktrees from this parent commit. Never change shared HEAD to repair binding.
    assertT3CurrentSource(item.source)
  }

  private async implementationWorktree(item: T3Workflow, assignmentId: string): Promise<string> {
    const effect = this.engine.journal.effect(`delegate:${assignmentId}`)
    const childThreadId = effect?.status === "confirmed" ? effect.result?.childThreadId : null
    const child = t3Object(
      (
        await this.host.invoke("t3_thread_read", {
          threadId: text(childThreadId, "Implementation child thread"),
          limit: 1,
          maxCharsPerItem: 1,
          runLimit: 1
        })
      ).thread,
      "Implementation child"
    )
    if (
      child.threadId !== childThreadId ||
      child.projectId !== this.config.projectId ||
      child.parentThreadId !== this.config.parentThreadId ||
      child.relationshipToParent !== "subagent"
    )
      throw new Error("Implementation child identity or project mismatch")
    const assignment = item.assignments.find((a) => a.id === assignmentId)
    if (!assignment?.taskId || effect?.result?.taskId !== assignment.taskId)
      throw new Error("Implementation task receipt mismatch")
    return text(child.worktreePath, "Host-managed implementation worktree")
  }

  private assertRoute(capabilities: T3Capabilities, route: T3Route): void {
    const provider = capabilities.providers.find((p) => p.providerInstanceId === route.providerInstanceId)
    if (
      !provider?.canRunChildTask ||
      (capabilities.inheritedProviderInstanceId !== provider.providerInstanceId &&
        !provider.canRunCrossProviderChildTask)
    )
      throw new Error("Configured T3 provider unavailable; no fallback is authorized")
    const model = provider.models.find((m) => m.id === route.model)
    if (!model)
      throw new Error("Configured model not in negotiated T3 catalogue; explicitly negotiate it before dispatch")
    for (const [id, value] of Object.entries(route.options))
      if (!model.options.some((option) => option.id === id && option.values.includes(value)))
        throw new Error(`Unavailable T3 model option: ${id}`)
  }

  private validateDispatch(receipt: Record<string, unknown>, route: T3Route): void {
    text(receipt.taskId, "Task ID")
    if (
      receipt.providerInstanceId !== route.providerInstanceId ||
      receipt.model !== route.model ||
      !["queued", "running", "waiting", "completed", "failed", "cancelled", "interrupted"].includes(
        String(receipt.status)
      )
    )
      throw new Error("T3 dispatch receipt identity or state mismatch")
    for (const [id, value] of Object.entries(route.options))
      if (
        !Array.isArray(receipt.options) ||
        !receipt.options.some((entry) => {
          const option = t3Object(entry, "Observed T3 option")
          return option.id === id && option.value === value
        })
      )
        throw new Error("T3 did not confirm the requested model options")
  }

  private hostRole(role: T3Role): string {
    return role === "verification" ? "test" : role === "planner" || role === "release" ? "general" : role
  }
}
