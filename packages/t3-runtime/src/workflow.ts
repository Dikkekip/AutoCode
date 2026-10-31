import type { T3Journal, T3Lease, T3Record } from "./journal.js"
import { digest, type T3Persona, type T3Role } from "./personas.js"
import { assertT3Source, sourcePath, type T3Source } from "./source.js"

export type T3Board =
  | "Planning"
  | "To Research"
  | "Researching"
  | "To Do"
  | "Doing"
  | "To Review"
  | "PR approved"
  | "Done"
export type T3Phase = T3Role | "ready" | "done" | "no-op" | "rejected" | "cancelled"
export interface T3Proposal {
  title: string
  problem: string
  goal: string
  lane: string
  scope: string[]
  inspectedPaths: string[]
  acceptance: string[]
  dependencies: string[]
  risk: "low" | "medium" | "high"
  estimatedTokens: number
}
export interface T3Assignment {
  id: string
  role: T3Role
  personaId: string
  personaDigest: string
  promptDigest: string
  providerInstanceId: string
  revision: string
  taskId: string | null
  runId: string | null
  status: "prepared" | "running" | "completed" | "failed" | "cancelled"
  resultApplied: boolean
}
export interface T3Candidate {
  revision: string
  treeDigest: string
  changedPaths: string[]
  implementationTaskId: string
}
export interface T3Verification {
  revision: string
  treeDigest: string
  policyDigest: string
  receiptDigest: string
  passed: boolean
  isolation: "protected"
}
export interface T3Review {
  revision: string
  accepted: boolean
  findings: string[]
  criteria: Array<{ criterion: string; passed: boolean; evidence: string }>
}
export interface T3Workflow {
  id: string
  policyDigest: string
  source: T3Source
  research: { inspectedPaths: string[]; conclusion: "proposal" | "no-op"; summary: string } | null
  researchPersonaId: string
  phase: T3Phase
  board: T3Board
  proposal: T3Proposal | null
  fingerprint: string | null
  assignments: T3Assignment[]
  candidate: T3Candidate | null
  verification: T3Verification | null
  review: (T3Review & { taskId: string }) | null
  designApproved: boolean
  repairs: number
  reason: string | null
  admitted: boolean
  mergedRevision: string | null
  repairFrom: {
    candidate: T3Candidate | null
    verification: T3Verification | null
    review: (T3Review & { taskId: string }) | null
  } | null
}
export interface T3Policy {
  goal: string
  lanes: string[]
  maxAdmitted: number
  maxDispatches: number
  estimatedTokenBudget: number
  maxRepairs: number
  deadline: number
  rolePersonas: Record<T3Role, string[]>
}
export interface T3Control {
  mode: "running" | "paused" | "frozen"
  reason: string
}
export interface T3Usage {
  dispatches: number
  estimatedTokens: number
  perPersona: Record<string, number>
}

function nonempty(value: string, label: string): void {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} required`)
}
function hex(value: string, label: string, length: string): void {
  if (
    typeof value !== "string" ||
    !new RegExp(length === "40,64" ? "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" : `^[a-f0-9]{${length}}$`).test(value)
  )
    throw new Error(`Invalid ${label}`)
}
function positive(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${label}`)
}
function overlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
}
function terminal(phase: T3Phase): boolean {
  return ["done", "no-op", "rejected", "cancelled"].includes(phase)
}
const board: Record<T3Phase, T3Board> = {
  research: "To Research",
  planner: "Planning",
  design: "To Do",
  implementation: "To Do",
  verification: "To Review",
  review: "To Review",
  release: "PR approved",
  ready: "PR approved",
  done: "Done",
  "no-op": "Planning",
  rejected: "Planning",
  cancelled: "Planning"
}

/** Trusted coordinator API. Worker text is data and must be decoded/validated before calling this API.
 * All state transitions are fenced and journaled; no method dispatches tools or trusts a worker's release claim. */
export class T3WorkflowEngine {
  readonly personas: Map<string, T3Persona>
  readonly policy: T3Policy
  readonly policyDigest: string

  constructor(
    readonly journal: T3Journal,
    policy: T3Policy,
    personas: T3Persona[],
    private readonly clock = Date.now
  ) {
    this.policy = structuredClone(policy)
    this.personas = new Map(structuredClone(personas).map((p) => [p.definition.id, p]))
    this.policyDigest = digest({ policy: this.policy, personas: [...this.personas.values()] })
    nonempty(policy.goal, "Project goal")
    for (const key of ["maxAdmitted", "maxDispatches", "estimatedTokenBudget", "deadline"] as const)
      positive(policy[key], key)
    if (!Number.isSafeInteger(policy.maxRepairs) || policy.maxRepairs < 0) throw new Error("Invalid repair budget")
    if (!policy.lanes.length || new Set(policy.lanes).size !== policy.lanes.length)
      throw new Error("Unique project lanes required")
    for (const role of [
      "research",
      "planner",
      "design",
      "implementation",
      "verification",
      "review",
      "release"
    ] as const) {
      if (!policy.rolePersonas[role]?.length || policy.rolePersonas[role].some((id) => !this.personas.has(id)))
        throw new Error(`Configured persona required for ${role}`)
    }
    for (const persona of this.personas.values()) {
      if (digest({ definition: persona.definition, manager: persona.manager }) !== persona.digest)
        throw new Error("Persona digest mismatch")
      const weight = persona.manager?.taskQuotaWeight ?? 1
      if (!Number.isFinite(weight) || weight <= 0) throw new Error("Invalid persona quota weight")
    }
  }

  get(projectId: string, id: string): T3Record<T3Workflow> {
    const row = this.journal.read<T3Workflow>(projectId, "workflow", id)
    if (!row) throw new Error(`Unknown workflow: ${id}`)
    return row
  }

  control(projectId: string): T3Control {
    return this.journal.read<T3Control>(projectId, "control", "project")?.value ?? { mode: "running", reason: "" }
  }

  setControl(lease: T3Lease, mode: T3Control["mode"], reason: string): void {
    if (!["running", "paused", "frozen"].includes(mode)) throw new Error("Invalid project control")
    nonempty(reason, "Control reason")
    this.journal.transaction(lease, () => {
      const previous = this.journal.read<T3Control>(lease.projectId, "control", "project")
      this.journal.write("control", "project", { mode, reason }, previous?.version ?? 0)
    })
  }

  startResearch(lease: T3Lease, id: string, personaId: string, source: T3Source): T3Workflow {
    nonempty(id, "Workflow ID")
    assertT3Source(source)
    this.authorizePersona(personaId, "research")
    return this.journal.transaction(lease, () => {
      this.assertRunning(lease)
      const prior = this.journal.read<T3Workflow>(lease.projectId, "workflow", id)
      if (prior) {
        if (prior.value.policyDigest !== this.policyDigest)
          throw new Error("Research policy changed; use a new investigation identity")
        if (prior.value.researchPersonaId !== personaId || prior.value.source.digest !== source.digest)
          throw new Error("Research delivery identity collision")
        return prior.value
      }
      const item: T3Workflow = {
        id,
        policyDigest: this.policyDigest,
        source: structuredClone(source),
        research: null,
        researchPersonaId: personaId,
        phase: "research",
        board: "To Research",
        proposal: null,
        fingerprint: null,
        assignments: [],
        candidate: null,
        verification: null,
        review: null,
        designApproved: false,
        repairs: 0,
        reason: null,
        admitted: false,
        mergedRevision: null,
        repairFrom: null
      }
      this.journal.write("workflow", id, item, 0)
      return item
    })
  }

  /** Quota weight influences selection within explicitly authorized role personas; never changes providers. */
  selectPersona(projectId: string, role: T3Role): T3Persona {
    const usage = this.usage(projectId)
    const ids = this.policy.rolePersonas[role]
    return ids
      .map((id) => this.personas.get(id)!)
      .sort((a, b) => {
        const score = (p: T3Persona) => (usage.perPersona[p.definition.id] ?? 0) / (p.manager?.taskQuotaWeight ?? 1)
        return score(a) - score(b) || a.definition.id.localeCompare(b.definition.id)
      })[0]!
  }

  prepareAssignment(
    lease: T3Lease,
    id: string,
    assignment: Omit<T3Assignment, "taskId" | "runId" | "status" | "resultApplied">,
    estimatedTokens: number
  ): T3Workflow {
    positive(estimatedTokens, "Dispatch token reservation")
    return this.change(lease, id, (item) => {
      this.assertRunning(lease)
      if (
        item.phase !== assignment.role ||
        item.assignments.some((a) => a.status === "prepared" || a.status === "running")
      )
        throw new Error("Workflow is not dispatchable")
      if (item.assignments.at(-1)?.status === "completed" && !item.assignments.at(-1)?.resultApplied)
        throw new Error("Import the observed result before dispatching another responsibility")
      this.authorizePersona(assignment.personaId, assignment.role)
      const persona = this.personas.get(assignment.personaId)!
      if (assignment.personaDigest !== persona.digest) throw new Error("Assignment persona changed")
      if (assignment.role === "research" && assignment.personaId !== item.researchPersonaId)
        throw new Error("Research persona changed")
      const revision = item.candidate?.revision ?? item.source.revision
      if (assignment.revision !== revision) throw new Error("Assignment source is stale")
      nonempty(assignment.id, "Assignment ID")
      nonempty(assignment.providerInstanceId, "Provider identity")
      hex(assignment.promptDigest, "prompt digest", "64")
      if (
        this.journal
          .list<T3Workflow>(lease.projectId, "workflow")
          .some((row) => row.value.assignments.some((a) => a.id === assignment.id))
      )
        throw new Error("Assignment identity already exists")
      const implementation = item.assignments.filter((a) => a.role === "implementation")
      if (
        ["verification", "review", "release"].includes(assignment.role) &&
        implementation.some((a) => a.personaId === assignment.personaId)
      )
        throw new Error("Implementation must have independent verification, review and release personas")
      if (assignment.role === "planner" && assignment.personaId === item.researchPersonaId)
        throw new Error("Planner admission must be independent from the proposing persona")
      if (
        assignment.role === "implementation" &&
        item.assignments.some(
          (a) =>
            ["planner", "design", "verification", "review", "release"].includes(a.role) &&
            a.personaId === assignment.personaId
        )
      )
        throw new Error("Implementation must be independent from governance and acceptance personas")
      if (
        ["verification", "review", "release"].includes(assignment.role) &&
        item.assignments.some(
          (a) =>
            ["verification", "review", "release"].includes(a.role) &&
            a.role !== assignment.role &&
            a.personaId === assignment.personaId
        )
      )
        throw new Error("Verification, review and release require distinct personas")
      if (
        item.proposal &&
        assignment.role === "implementation" &&
        !persona.definition.allowedLanes.includes(item.proposal.lane)
      )
        throw new Error("Implementation persona does not own this lane")
      const usage = this.usage(lease.projectId)
      if (
        usage.dispatches >= this.policy.maxDispatches ||
        usage.estimatedTokens + estimatedTokens > this.policy.estimatedTokenBudget
      )
        throw new Error("Project dispatch or estimated token budget exhausted")
      const previous = this.journal.read<T3Usage>(lease.projectId, "usage", "project")
      this.journal.write(
        "usage",
        "project",
        {
          dispatches: usage.dispatches + 1,
          estimatedTokens: usage.estimatedTokens + estimatedTokens,
          perPersona: { ...usage.perPersona, [assignment.personaId]: (usage.perPersona[assignment.personaId] ?? 0) + 1 }
        },
        previous?.version ?? 0
      )
      item.assignments.push({ ...assignment, taskId: null, runId: null, status: "prepared", resultApplied: false })
      if (assignment.role === "research") item.board = "Researching"
      if (assignment.role === "implementation") item.board = "Doing"
    })
  }

  attachTask(lease: T3Lease, id: string, assignmentId: string, taskId: string): void {
    nonempty(taskId, "Host task ID")
    this.change(lease, id, (item) => {
      const assignment = item.assignments.find((a) => a.id === assignmentId)
      if (
        !assignment ||
        !["prepared", "running"].includes(assignment.status) ||
        (assignment.taskId && assignment.taskId !== taskId)
      )
        throw new Error("Unexpected task receipt")
      if (
        this.journal
          .list<T3Workflow>(lease.projectId, "workflow")
          .some((row) => row.value.assignments.some((a) => a.id !== assignmentId && a.taskId === taskId))
      )
        throw new Error("Task reused for another responsibility")
      assignment.taskId = taskId
      assignment.status = "running"
    })
  }

  /** Call only with observed terminal host state after a completion wake, not an assistant's claimed completion. */
  settleTask(
    lease: T3Lease,
    id: string,
    assignmentId: string,
    receipt: {
      taskId: string
      runId: string | null
      status: "completed" | "failed" | "cancelled"
      hasPendingChildRuns: boolean
    },
    observation?: { envelope: Record<string, unknown>; wakeId: string; receipt: Record<string, unknown> }
  ): void {
    this.change(lease, id, (item) => {
      const assignment = item.assignments.find((a) => a.id === assignmentId)
      if (
        !assignment ||
        assignment.taskId !== receipt.taskId ||
        assignment.status !== "running" ||
        receipt.hasPendingChildRuns !== false
      )
        throw new Error("Task is not terminal or identity mismatched")
      if (receipt.runId !== null) nonempty(receipt.runId, "Observed terminal run")
      else if (receipt.status === "completed") throw new Error("Completed task requires an observed terminal run")
      if (
        receipt.runId !== null &&
        this.journal
          .list<T3Workflow>(lease.projectId, "workflow")
          .some((row) => row.value.assignments.some((a) => a.id !== assignmentId && a.runId === receipt.runId))
      )
        throw new Error("Terminal run reused for another responsibility")
      if (!["completed", "failed", "cancelled"].includes(receipt.status)) throw new Error("Invalid terminal task state")
      assignment.runId = receipt.runId
      assignment.status = receipt.status
      if (observation) {
        this.journal.write("completion", assignmentId, observation.envelope, 0)
        this.journal.event("completion.observed", assignmentId, {
          wakeId: observation.wakeId,
          runId: receipt.runId,
          status: receipt.status,
          receipt: observation.receipt
        })
      }
      if (receipt.status !== "completed") item.reason = `Task ${receipt.status}; explicit recovery required`
    })
  }

  completeResearch(
    lease: T3Lease,
    id: string,
    assignmentId: string,
    result: { proposal: T3Proposal } | { noOp: string; inspectedPaths: string[] }
  ): void {
    this.change(lease, id, (item) => {
      this.completed(item, assignmentId, "research")
      const paths = "proposal" in result ? result.proposal.inspectedPaths : result.inspectedPaths
      if (
        !Array.isArray(paths) ||
        !paths.length ||
        paths.some((path) => !item.source.files.some((file) => file.path === sourcePath(path)))
      )
        throw new Error("Research needs captured inspected paths")
      if ("noOp" in result) {
        nonempty(result.noOp, "No-op explanation")
        item.research = { inspectedPaths: [...paths], conclusion: "no-op", summary: result.noOp }
        item.reason = result.noOp
        this.move(item, "no-op")
        return
      }
      const proposal = result.proposal
      for (const field of ["title", "problem", "goal", "lane"] as const) nonempty(proposal[field], field)
      positive(proposal.estimatedTokens, "Proposal estimate")
      if (
        !this.policy.lanes.includes(proposal.lane) ||
        !this.personas.get(item.researchPersonaId)!.definition.allowedLanes.includes(proposal.lane)
      )
        throw new Error("Proposal lane is not authorized")
      if (!Array.isArray(proposal.scope) || !proposal.scope.length) throw new Error("Proposal scope required")
      for (const path of proposal.scope) sourcePath(path)
      if (!Array.isArray(proposal.acceptance) || !proposal.acceptance.length)
        throw new Error("Acceptance criteria required")
      for (const criterion of proposal.acceptance) nonempty(criterion, "Acceptance criterion")
      if (
        !["low", "medium", "high"].includes(proposal.risk) ||
        !Array.isArray(proposal.dependencies) ||
        proposal.dependencies.some((s) => typeof s !== "string" || !s || s === id)
      )
        throw new Error("Invalid proposal risk or dependencies")
      item.proposal = structuredClone(proposal)
      item.research = { inspectedPaths: [...paths], conclusion: "proposal", summary: proposal.problem }
      item.fingerprint = digest({
        sourceRevision: item.source.revision,
        problem: proposal.problem.trim().toLowerCase(),
        lane: proposal.lane,
        scope: [...new Set(proposal.scope)].sort()
      })
      this.move(item, "planner")
    })
  }

  plan(
    lease: T3Lease,
    id: string,
    assignmentId: string,
    decision: "admit" | "defer" | "reject",
    reason: string,
    currentSourceDigest: string
  ): void {
    this.change(lease, id, (item) => {
      this.assertRunning(lease)
      this.completed(item, assignmentId, "planner")
      nonempty(reason, "Planner reason")
      if (!["admit", "defer", "reject"].includes(decision)) throw new Error("Invalid planner decision")
      item.reason = reason
      if (decision === "defer") return
      if (decision === "reject") {
        this.move(item, "rejected")
        return
      }
      if (currentSourceDigest !== item.source.digest) throw new Error("Proposal source is stale; investigate again")
      const proposal = item.proposal!
      if (proposal.goal !== this.policy.goal) throw new Error("Proposal does not address current project goal")
      const others = this.journal
        .list<T3Workflow>(lease.projectId, "workflow")
        .filter((row) => row.id !== id)
        .map((row) => row.value)
      if (
        others.some(
          (other) => other.fingerprint === item.fingerprint && !["rejected", "cancelled"].includes(other.phase)
        )
      )
        throw new Error("Duplicate proposal")
      for (const dependency of proposal.dependencies)
        if (!others.some((other) => other.id === dependency && other.phase === "done"))
          throw new Error("Unclosed dependency")
      const active = others.filter((other) => other.admitted && !terminal(other.phase))
      if (active.length >= this.policy.maxAdmitted) throw new Error("Project admission capacity reached")
      if (active.some((other) => other.proposal!.scope.some((a) => proposal.scope.some((b) => overlap(a, b)))))
        throw new Error("Scope is reserved by another workflow")
      if (
        this.usage(lease.projectId).estimatedTokens +
          proposal.estimatedTokens +
          active.reduce((total, other) => total + other.proposal!.estimatedTokens, 0) >
        this.policy.estimatedTokenBudget
      )
        throw new Error("Insufficient estimated token budget for proposal")
      item.admitted = true
      this.move(item, proposal.risk === "high" ? "design" : "implementation")
    })
  }

  design(lease: T3Lease, id: string, assignmentId: string, approved: boolean, reason: string): void {
    this.change(lease, id, (item) => {
      this.completed(item, assignmentId, "design")
      nonempty(reason, "Design decision")
      if (typeof approved !== "boolean") throw new Error("Design verdict must be boolean")
      item.reason = reason
      item.designApproved = approved
      this.move(item, approved ? "implementation" : "rejected")
    })
  }

  recordCandidate(lease: T3Lease, id: string, assignmentId: string, candidate: T3Candidate): void {
    this.change(lease, id, (item) => {
      const assignment = this.completed(item, assignmentId, "implementation")
      if (item.proposal!.risk === "high" && !item.designApproved) throw new Error("High-risk design approval required")
      hex(candidate.revision, "candidate revision", "40,64")
      hex(candidate.treeDigest, "candidate tree digest", "64")
      if (candidate.implementationTaskId !== assignment.taskId || candidate.revision === item.source.revision)
        throw new Error("Candidate has no isolated implementation identity")
      if (
        !Array.isArray(candidate.changedPaths) ||
        !candidate.changedPaths.length ||
        candidate.changedPaths.some(
          (path) => !item.proposal!.scope.some((scope) => sourcePath(path) === scope || path.startsWith(`${scope}/`))
        )
      )
        throw new Error("Candidate changed paths outside admitted scope")
      item.candidate = structuredClone(candidate)
      item.verification = null
      item.review = null
      this.move(item, "verification")
    })
  }

  recordVerification(lease: T3Lease, id: string, assignmentId: string, evidence: T3Verification): void {
    this.change(lease, id, (item) => {
      this.completed(item, assignmentId, "verification")
      if (
        typeof evidence.passed !== "boolean" ||
        evidence.isolation !== "protected" ||
        evidence.revision !== item.candidate?.revision ||
        evidence.treeDigest !== item.candidate.treeDigest
      )
        throw new Error("Verification does not bind the protected exact candidate")
      hex(evidence.policyDigest, "verification policy", "64")
      hex(evidence.receiptDigest, "verification receipt", "64")
      item.verification = structuredClone(evidence)
      if (evidence.passed) this.move(item, "review")
      else this.repair(item, "Protected verification failed")
    })
  }

  recordReview(lease: T3Lease, id: string, assignmentId: string, result: T3Review): void {
    this.change(lease, id, (item) => {
      const assignment = this.completed(item, assignmentId, "review")
      if (
        result.revision !== item.candidate?.revision ||
        !item.verification?.passed ||
        item.verification.revision !== result.revision
      )
        throw new Error("Review is not bound to a verified exact candidate")
      if (
        typeof result.accepted !== "boolean" ||
        !Array.isArray(result.findings) ||
        result.findings.some((s) => typeof s !== "string") ||
        (result.accepted && result.findings.length)
      )
        throw new Error("Blocking findings cannot be approved")
      if (
        !Array.isArray(result.criteria) ||
        result.criteria.length !== item.proposal!.acceptance.length ||
        new Set(result.criteria.map((c) => c.criterion)).size !== result.criteria.length ||
        result.criteria.some(
          (c) =>
            !item.proposal!.acceptance.includes(c.criterion) ||
            typeof c.passed !== "boolean" ||
            typeof c.evidence !== "string" ||
            !c.evidence.trim()
        ) ||
        (result.accepted && result.criteria.some((c) => !c.passed))
      )
        throw new Error("Independent evidence for every acceptance criterion required")
      item.review = { ...structuredClone(result), taskId: assignment.taskId! }
      if (result.accepted) this.move(item, "release")
      else this.repair(item, result.findings.join("\n") || "Independent review rejected candidate")
    })
  }

  releaseReady(lease: T3Lease, id: string, assignmentId: string, observedHead: string): void {
    this.change(lease, id, (item) => {
      this.assertRunning(lease)
      this.completed(item, assignmentId, "release")
      this.assertAccepted(item, observedHead)
      this.move(item, "ready")
    })
  }

  /** An observed head change revokes checks and acceptance; never silently reuse them on new source. */
  invalidateHead(lease: T3Lease, id: string, observedHead: string): void {
    hex(observedHead, "observed head", "40,64")
    this.change(lease, id, (item) => {
      if (terminal(item.phase)) throw new Error("Closed workflow cannot change candidate")
      if (item.assignments.some((a) => ["prepared", "running"].includes(a.status)))
        throw new Error("Cancel and reconcile active tasks before changing candidate")
      if (!item.candidate || item.candidate.revision === observedHead) return
      const latest = item.assignments.at(-1)
      if (latest?.status === "completed") latest.resultApplied = true
      this.repair(item, `Candidate head moved to ${observedHead}; re-collect implementation and evidence`)
    })
  }

  /** This does NOT merge. A trusted release adapter must first observe actual merge AND closure. */
  recordClosure(
    lease: T3Lease,
    id: string,
    receipt: { candidateRevision: string; mergedRevision: string; closed: boolean; evidence: string }
  ): void {
    this.change(lease, id, (item) => {
      this.assertRunning(lease)
      if (item.phase !== "ready" || !receipt.closed) throw new Error("Actual merge and closure are required for Done")
      this.assertAccepted(item, receipt.candidateRevision)
      hex(receipt.mergedRevision, "merged revision", "40,64")
      nonempty(receipt.evidence, "Merge/closure observation")
      item.mergedRevision = receipt.mergedRevision
      this.journal.event("release.observed", id, receipt)
      this.move(item, "done")
    })
  }

  cancel(lease: T3Lease, id: string, reason: string): void {
    this.change(lease, id, (item) => {
      nonempty(reason, "Cancellation reason")
      if (item.assignments.some((a) => ["prepared", "running"].includes(a.status)))
        throw new Error("Cancel and reconcile descendants before closing workflow")
      if (terminal(item.phase)) throw new Error("Workflow is already closed")
      item.reason = reason
      this.move(item, "cancelled")
    })
  }

  usage(projectId: string): T3Usage {
    return (
      this.journal.read<T3Usage>(projectId, "usage", "project")?.value ?? {
        dispatches: 0,
        estimatedTokens: 0,
        perPersona: {}
      }
    )
  }

  assertPolicy(item: T3Workflow): void {
    if (item.policyDigest !== this.policyDigest)
      throw new Error("Workflow policy or personas changed; explicit migration or a new investigation is required")
  }

  private authorizePersona(id: string, role: T3Role): void {
    if (!this.personas.has(id) || !this.policy.rolePersonas[role].includes(id))
      throw new Error(`Persona is not authorized for ${role}`)
  }

  private assertRunning(lease: T3Lease): void {
    if (this.control(lease.projectId).mode !== "running") throw new Error("Project is paused or frozen")
    if (this.clock() >= this.policy.deadline) throw new Error("Project time budget exhausted")
  }

  private completed(item: T3Workflow, id: string, role: T3Role): T3Assignment {
    const assignment = item.assignments.find((a) => a.id === id)
    if (
      item.phase !== role ||
      !assignment ||
      item.assignments.at(-1)?.id !== id ||
      assignment.role !== role ||
      assignment.status !== "completed" ||
      assignment.resultApplied
    )
      throw new Error(`Observed completed ${role} assignment required`)
    if (assignment.revision !== (item.candidate?.revision ?? item.source.revision))
      throw new Error("Completed assignment targets a stale revision")
    assignment.resultApplied = true
    return assignment
  }

  private assertAccepted(item: T3Workflow, head: string): void {
    if (
      !item.candidate ||
      item.candidate.revision !== head ||
      !item.verification?.passed ||
      item.verification.revision !== head ||
      !item.review?.accepted ||
      item.review.revision !== head
    )
      throw new Error("Exact-head independent acceptance required")
  }

  private move(item: T3Workflow, phase: T3Phase): void {
    item.phase = phase
    item.board = board[phase]
  }

  private repair(item: T3Workflow, reason: string): void {
    item.reason = reason
    item.repairFrom = { candidate: item.candidate, verification: item.verification, review: item.review }
    item.candidate = null
    item.verification = null
    item.review = null
    item.repairs++
    this.move(item, item.repairs > this.policy.maxRepairs ? "rejected" : "implementation")
  }

  private change(lease: T3Lease, id: string, action: (item: T3Workflow) => void): T3Workflow {
    return this.journal.transaction(lease, () => {
      const row = this.get(lease.projectId, id)
      this.assertPolicy(row.value)
      action(row.value)
      this.journal.write("workflow", id, row.value, row.version)
      return row.value
    })
  }
}
