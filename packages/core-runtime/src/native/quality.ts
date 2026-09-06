import { createHash, randomUUID } from "node:crypto"
import {
  type NativeAssessment,
  type NativeProposal,
  type NativeProposalQuality,
  nativeHighRiskPaths,
  nativePathAllowed,
  nativeProblemKey,
  qualityText,
  selectNativeImprovements,
  selectNativePersonas,
  validateNativeAssessment,
  validateNativeBenefitHypothesis,
  validateNativeProposal
} from "@openclaw/domain"
import { buildNativeContextPack, readNativeExcerpt } from "./context-pack.js"
import { decideNativeDuplicate } from "./dedupe.js"
import { type NativeCard, nativeCards } from "./gateway.js"
import { type NativeMemoryConfig, verifiedNativeLessons } from "./memory.js"
import { nativeOutcomeReport } from "./outcomes.js"
import { assertNativeMode } from "./promotion-mode.js"
import type { NativeAutonomyRuntime, NativeWorkflow } from "./runtime.js"
import { nativeSkillPolicyDigest, resolveNativeSkill } from "./skills.js"
import { nativePolicyTraceDigest, withNativeStageTrace } from "./telemetry.js"
import { nativeGit, nativeGitRaw } from "./verification.js"

export interface Investigation {
  roundId: string
  personaId: string
  agentId: string
  closed?: boolean
  startedAt?: number
  cardId?: string
  revision: string
  fingerprint: string
  skillHash: string
  skillContractVersion?: 1
  skillPolicyDigest?: string
  skillText: string
  state: "pending" | "completed" | "no_op" | "failed" | "timed_out"
  reason?: string
  sessionKey?: string | undefined
  runId?: string | undefined
}
interface QualityRound {
  personas: string[]
  cards: string[]
  phase: string
  startedAt: number
  qualityVersion: 1
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const active = (c: NativeCard) => ["todo", "ready", "running", "review", "scheduled"].includes(c.status)
export class NativeQualityRuntime {
  constructor(readonly runtime: NativeAutonomyRuntime) {}
  get policy() {
    return this.runtime.policy
  }
  get store() {
    return this.runtime.store
  }
  get gateway() {
    return this.runtime.gateway
  }
  designDigest(w: NativeWorkflow): string {
    return hash({
      version: 1,
      attemptId: w.lifecycle?.attemptId ?? null,
      rules: nativeHighRiskPaths,
      proposal: w.proposal,
      policy: this.policy,
      changes: w.riskAssessment?.changesDigest
    })
  }
  requiresDesign(w: NativeWorkflow): boolean {
    return w.proposal.quality?.risk === "high" || w.riskAssessment?.risk === "high"
  }
  designApproved(w: NativeWorkflow): boolean {
    return w.designReview?.verdict === "approved" && w.designReview.digest === this.designDigest(w)
  }
  async ensureDesign(id: string, w: NativeWorkflow): Promise<boolean> {
    if (!w.lifecycle && this.requiresDesign(w)) this.runtime.transitionWorkflow(id, w, "design_wait")
    const digest = this.designDigest(w)
    if (w.designReview && w.designReview.digest !== digest) {
      this.store.event("design.invalidated", id, {
        previousDigest: w.designReview.digest ?? null,
        digest,
        reason: "Design, scope, policy or candidate changes changed"
      })
      delete w.designReview
    }
    this.store.put("workflow", id, w)
    if (!this.requiresDesign(w) || this.designApproved(w)) {
      if (w.lifecycle?.state === "design_wait")
        this.runtime.transitionWorkflow(
          id,
          w,
          w.review?.verdict === "approved"
            ? "release"
            : w.verification
              ? "review"
              : w.candidate
                ? "verification"
                : "implementation"
        )
      return true
    }
    this.runtime.transitionWorkflow(id, w, "design_wait")
    const card = await this.runtime.createCard({
      boardId: this.policy.boardId,
      title: `Design review: ${w.proposal.title}`,
      agentId: this.policy.reviewerAgentId,
      status: "ready",
      maxRuntimeSeconds: 600,
      idempotencyKey: `workflow:${id}:design:${digest}`,
      workspace: { kind: "scratch" },
      notes: JSON.stringify({
        workflowId: id,
        digest,
        proposal: w.proposal,
        riskAssessment: w.riskAssessment,
        repository: this.policy.repository,
        instructions:
          "Inspect the committed diff between riskAssessment.baseSha and riskAssessment.headSha in the repository when present. Independently evaluate the design, candidate changes, contracts, sensitive data, recovery and acceptance verification. Call autocode_design_review with verdict, rationale and assessment {criteria:[{criterion,satisfied,evidence}],findings:[{blocking,description}]}, then workboard_complete."
      })
    })
    w.designCardId = card.id
    w.designCardDigest = digest
    this.store.put("workflow", id, w)
    return false
  }
  async classifyCandidate(
    id: string,
    w: NativeWorkflow,
    candidate: NonNullable<NativeWorkflow["candidate"]>,
    phase: "submission" | "release",
    git = nativeGit
  ): Promise<void> {
    // Disable rename detection: both endpoints are classified and checked for scope.
    // Raw object IDs include content and modes, without executing candidate code.
    const raw = await git(
      candidate.cwd,
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--raw",
      "--no-abbrev",
      "--no-renames",
      "-z",
      candidate.baseSha,
      candidate.headSha
    )
    if (!raw) throw new Error("Cannot classify empty candidate diff")
    const fields = raw.split("\0").filter(Boolean)
    const reasons: string[] = []
    const patterns = [...new Set([...nativeHighRiskPaths, ...(this.policy.quality?.highRiskPaths ?? [])])]
    for (let i = 0; i < fields.length; i += 2) {
      const meta = fields[i]!,
        path = fields[i + 1]
      const match = /^:(\d{6}) (\d{6}) [a-f0-9]+ [a-f0-9]+ ([ADMT])$/.exec(meta)
      if (!match || !path) throw new Error("Cannot classify candidate diff")
      if (!w.proposal.allowedPaths.some((root) => nativePathAllowed(path, root)))
        throw new Error(`Candidate changed files outside admitted scope: ${path}`)
      for (const rule of patterns)
        if (nativePathAllowed(path, rule)) reasons.push(`${match[3]} ${path}: protected path rule ${rule}`)
      if (
        match[1] !== match[2] &&
        (match[3] === "M" ||
          match[3] === "T" ||
          [match[1], match[2]].some((mode) => mode === "100755" || mode === "120000" || mode === "160000"))
      )
        reasons.push(`${match[3]} ${path}: file permissions or type ${match[1]} -> ${match[2]}`)
      const patch = await git(
        candidate.cwd,
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--unified=0",
        candidate.baseSha,
        candidate.headSha,
        "--",
        path
      )
      if (/^[+-](?![+-]).*\b(export|module\.exports|exports\.|public\s|permissions\s*:)/m.test(patch))
        reasons.push(`${match[3]} ${path}: public contract or permission declaration changed`)
      // Multi-line contract edits need not repeat an export/public keyword in the patch.
      // Conservatively protect files declaring a public type, including removed declarations.
      const objects = meta.split(" ")
      for (const [mode, oid] of [
        [match[1], objects[2]],
        [match[2], objects[3]]
      ]) {
        if (!oid || !mode?.startsWith("100")) continue
        const content = await git(candidate.cwd, "cat-file", "blob", oid)
        if (
          /\bexport\s+(?:declare\s+)?(?:interface|type|class)\b|\bpublic\s+(?:interface|class|enum)\b/.test(content)
        ) {
          reasons.push(`${match[3]} ${path}: file declares a public type contract`)
          break
        }
        if (/^#!/.test(content)) {
          reasons.push(`${match[3]} ${path}: executable script content`)
          break
        }
      }
    }
    if (w.proposal.quality?.risk === "high")
      reasons.push("Proposal declares high risk (cannot be downgraded by candidate hints)")
    if (
      /authenticat|permission|sensitive.data|migration|public.contract|deploy/i.test(
        [w.proposal.quality?.problem, w.proposal.quality?.approach, ...w.proposal.acceptance].join(" ")
      )
    )
      reasons.push(
        "Design text indicates authentication, permissions, sensitive data, migration, public contract or deployment risk"
      )
    const previous = w.riskAssessment
    const risk = reasons.length || w.proposal.quality?.risk === "high" ? "high" : "routine"
    w.riskAssessment = {
      risk,
      reasons,
      changesDigest: hash(raw),
      baseSha: candidate.baseSha,
      headSha: candidate.headSha
    }
    this.store.put("workflow", id, w)
    this.store.event("risk.classified", id, {
      phase,
      previousRisk: previous?.risk ?? w.proposal.quality?.risk ?? "routine",
      ...w.riskAssessment,
      proposalReasons: w.proposal.quality?.riskReasons ?? []
    })
  }
  async files(revision: string): Promise<string[]> {
    return (await nativeGit(this.policy.repository, "ls-tree", "-r", "--name-only", revision))
      .split("\n")
      .filter(Boolean)
  }
  async evidenceHash(revision: string, path: string): Promise<string> {
    // Only Git objects from the recorded commit are read; never execute repository instructions.
    const content = await nativeGit(this.policy.repository, "ls-tree", "-r", revision, "--", path)
    if (!content) throw new Error(`Evidence is not tracked at inspected revision: ${path}`)
    return hash(content)
  }
  async syncInvestigations() {
    const cards = await nativeCards(this.gateway, this.policy.boardId)
    for (const item of this.store.list<Investigation>("investigation")) {
      const entry = item.value
      if (entry.state !== "pending" || !entry.cardId) continue
      const card = cards.find((c) => c.id === entry.cardId)
      if (!card) continue
      const startedAt = card.execution?.startedAt ?? card.startedAt
      if (startedAt) entry.startedAt ??= startedAt
      entry.sessionKey ??= card.sessionKey ?? card.execution?.sessionKey
      entry.runId = card.runId ?? card.execution?.runId
      const status = card.execution?.status ?? card.status
      if (["timeout", "timed_out"].includes(status)) entry.state = "timed_out"
      else if (!active(card) || (card.status === "review" && card.execution?.status !== "running"))
        entry.state = "failed"
      if (entry.state !== "pending") entry.reason = `Native session ended without a complete investigation: ${status}`
      this.store.put("investigation", item.id, entry)
    }
    return cards
  }
  async enforceBudgets(): Promise<void> {
    if (!this.policy.quality || !this.store.list<Investigation>("investigation").some((r) => !r.value.closed)) return
    const cards = await nativeCards(this.gateway, this.policy.boardId)
    for (const item of this.store.list<Investigation>("investigation")) {
      const entry = item.value
      const card = cards.find((c) => c.id === entry.cardId)
      if (!card || entry.closed) continue
      if (!active(card)) {
        this.store.put("investigation", item.id, { ...entry, closed: true })
        continue
      }
      if (card.status !== "running") continue
      const sessionKey = card.sessionKey ?? card.execution?.sessionKey
      const startedAt = entry.startedAt ?? card.execution?.startedAt ?? card.startedAt
      if (!sessionKey || !startedAt) continue
      const expired = Date.now() >= startedAt + this.policy.quality.sessionSeconds * 1000
      const replaced = entry.sessionKey && entry.sessionKey !== sessionKey
      entry.sessionKey ??= sessionKey
      entry.startedAt ??= startedAt
      this.store.put("investigation", item.id, entry)
      if (!expired && !replaced && !["failed", "timed_out"].includes(entry.state)) continue
      const reason = replaced
        ? "Investigation session replaced; begin a new round"
        : "Investigation exceeded its inference budget"
      this.store.put("investigation", item.id, { ...entry, state: "timed_out", reason, startedAt })
      // Native maxRuntimeSeconds marks cards but does not pass a timeout to inference.
      // Abort the exact owned session through the public API, including after restart/pause.
      await this.gateway.request("sessions.abort", {
        key: sessionKey,
        agentId: entry.agentId,
        ...(card.runId ? { runId: card.runId } : {})
      })
      await this.gateway.request("workboard.cards.move", { id: card.id, status: "blocked" })
      this.store.event("investigation.timed-out", item.id, { reason, sessionKey })
    }
  }
  async retryUninspected(roundId: string, personaId: string, reason: string) {
    assertNativeMode(this.policy, "investigate")
    if (!this.runtime.isPaused()) throw new Error("Pause native execution before retrying an investigation")
    qualityText(reason, "Recovery reason")
    const key = `${roundId}:${personaId}`
    const lease = this.store.acquire(`retry:${key}`, 120_000)
    if (!lease) throw new Error("Investigation retry already running")
    return this.store.withLease(lease, 120_000, async () => {
      const previous = this.store.get<{ phase: string; original: Investigation }>("investigation-retry", key)
      if (previous?.phase === "ready") return { cardId: previous.original.cardId, duplicate: true }
      const entry = previous?.original ?? this.store.get<Investigation>("investigation", key)
      if (!entry?.cardId || !["pending", "failed"].includes(entry.state))
        throw new Error("Only an unfinished investigation can be retried")
      if (this.store.get<QualityRound>("round", roundId)?.phase === "failed")
        throw new Error("Round already retired; begin a new round")
      if (
        this.store.list("inspection").some((r) => r.id.startsWith(`${key}:`)) ||
        this.store
          .list<any>("proposal")
          .some((r) => r.value.roundId === roundId && r.value.proposal?.personaId === personaId)
      )
        throw new Error("Investigation already produced source evidence; preserve it and begin a new round")
      let card = (await nativeCards(this.gateway, this.policy.boardId)).find((c) => c.id === entry.cardId)
      if (
        !card ||
        !["review", "blocked", ...(previous ? ["ready"] : [])].includes(card.status) ||
        card.execution?.status === "running"
      )
        throw new Error("Investigation must have a terminal worker before recovery")
      if (!previous)
        this.store.put("investigation-retry", key, {
          phase: "prepared",
          original: entry,
          reason,
          at: new Date().toISOString()
        })
      if (card.status === "review") {
        card = (await this.gateway.request("workboard.cards.block", { id: card.id, reason })).card
        if (!card) throw new Error("Workboard did not return the blocked recovery card")
      }
      await this.gateway.request("workboard.cards.update", {
        id: card.id,
        ...((card as any).updatedAt ? { expectedUpdatedAt: (card as any).updatedAt } : {}),
        patch: { status: "ready", execution: null, sessionKey: null, runId: null, startedAt: null }
      })
      const { startedAt: _startedAt, sessionKey: _sessionKey, runId: _runId, closed: _closed, ...fresh } = entry
      this.store.put("investigation", key, { ...fresh, state: "pending", closed: false })
      this.store.put("investigation-retry", key, {
        phase: "ready",
        original: entry,
        reason,
        at: new Date().toISOString()
      })
      this.store.event("investigation.retry-prepared", key, { cardId: card.id, reason })
      return { cardId: card.id, duplicate: false }
    })
  }
  async discover(): Promise<{ created: string[]; reason?: string }> {
    assertNativeMode(this.policy, "investigate")
    if (!this.runtime.control.active) return this.runtime.control.run(() => this.discover())
    return withNativeStageTrace(
      this.store,
      {
        boardId: this.policy.boardId,
        workflowId: `discovery:${this.policy.boardId}`,
        attemptId: randomUUID(),
        stage: "discovery",
        policyDigest: nativePolicyTraceDigest(this.policy)
      },
      () => this.discoverUntraced()
    )
  }
  private async discoverUntraced(): Promise<{ created: string[]; reason?: string }> {
    this.runtime.assertEnabled()
    const lease = this.store.acquire("discovery", 120_000)
    if (!lease) return { created: [], reason: "discovery already running" }
    return this.store.withLease(lease, 120_000, async () => {
      const reconcileLease = this.store.acquire("reconcile", 120_000)
      if (!reconcileLease) return { created: [], reason: "reconciliation already running" }
      return this.store.withLease(reconcileLease, 120_000, async () => {
        let cards = await this.syncInvestigations()
        for (const round of this.store.list<QualityRound>("round")) {
          if (round.value.phase === "building" || round.value.phase === "failed") continue
          const entries = this.store.list<Investigation>("investigation").filter((e) => e.value.roundId === round.id)
          if (!entries.some((e) => ["failed", "timed_out"].includes(e.value.state))) continue
          const owned = cards.filter((c) => round.value.cards.includes(c.id))
          // A live worker retains ownership even if another investigation failed.
          if (owned.some((c) => c.status === "running" || c.execution?.status === "running")) continue
          const reason = "Research round ended without complete investigations; evidence retained for review."
          for (const card of owned.filter(active))
            await this.gateway.request("workboard.cards.block", { id: card.id, reason })
          // Journal only after every hold succeeds; retry partial RPC failures safely.
          this.store.put("round", round.id, { ...round.value, phase: "failed" })
          this.store.event("round.failed", round.id, { reason })
          cards = await this.syncInvestigations()
        }

        const rounds = this.store.list<QualityRound>("round")
        const pending = rounds.find((r) => r.value.qualityVersion === 1 && r.value.phase === "building")
        if (!pending && rounds.some((r) => r.value.cards?.some((id) => cards.some((c) => c.id === id && active(c)))))
          return { created: [], reason: "persona round still active" }
        if (
          !pending &&
          (cards.filter(active).length > 2 * this.policy.workerConcurrency ||
            this.store
              .list<NativeWorkflow>("workflow")
              .filter((w) => this.runtime.reservesScope(w.value) && !w.value.blocker).length >=
              2 * this.policy.workerConcurrency)
        )
          return { created: [], reason: "downstream backpressure" }
        const now = Date.now()
        if (
          !pending &&
          rounds.filter((r) => r.value.startedAt >= now - 86_400_000).length >= this.policy.discoveryDailyRoundLimit
        )
          return { created: [], reason: "daily discovery limit" }
        let skillText: string
        try {
          skillText = resolveNativeSkill(
            this.store,
            this.policy.boardId,
            this.policy.quality!.skillPath,
            nativeSkillPolicyDigest(this.policy)
          ).text
        } catch (error) {
          const reason =
            error instanceof Error && /Skill|promotion/.test(error.message)
              ? "Prompt skill requires reviewed bootstrap or promotion"
              : "Prompt skill unavailable"
          this.store.event("discovery.deferred", this.policy.boardId, { reason })
          return { created: [], reason }
        }
        if (!skillText.trim()) return { created: [], reason: "Prompt skill is empty" }
        const skillHash = hash(skillText)
        const revision = await nativeGit(this.policy.repository, "rev-parse", `origin/${this.policy.baseBranch}`)
        const counts: Record<string, number> = {}
        for (const round of rounds.filter((r) => r.value.startedAt >= now - 7 * 86_400_000))
          for (const id of round.value.personas) counts[id] = (counts[id] ?? 0) + 1
        const roundId = pending?.id ?? randomUUID()
        const tree = (await nativeGit(this.policy.repository, "ls-tree", "-r", revision)).split("\n").filter(Boolean)
        const selected = pending
          ? pending.value.personas
          : selectNativePersonas({ ...this.policy, personasPerRound: this.policy.personas.length }, counts).map(
              (p) => p.personaId
            )
        const entries: Investigation[] = []
        for (const id of selected) {
          const existing = this.store.get<Investigation>("investigation", `${roundId}:${id}`)
          if (existing) {
            entries.push(existing)
            continue
          }
          const persona = this.policy.personas.find((p) => p.personaId === id)!
          const objects = tree.filter((entry) =>
            persona.allowedPaths.some((root) => nativePathAllowed(entry.slice(entry.indexOf("\t") + 1), root))
          )
          const feedback = this.feedback(id)
          const fingerprint = hash({ persona, objects, feedback, skillHash })
          if (
            this.store
              .list<Investigation>("investigation")
              .some(
                (r) =>
                  r.value.personaId === id &&
                  r.value.fingerprint === fingerprint &&
                  ["completed", "no_op"].includes(r.value.state)
              )
          )
            continue
          entries.push({
            roundId,
            personaId: id,
            agentId: persona.investigationAgentId ?? id,
            revision,
            fingerprint,
            skillHash,
            skillContractVersion: 1,
            skillPolicyDigest: nativeSkillPolicyDigest(this.policy),
            skillText,
            state: "pending"
          })
          if (entries.length >= this.policy.personasPerRound) break
        }
        if (!entries.length) return { created: [], reason: "relevant code, goals and feedback unchanged" }
        this.store.put("round", roundId, {
          personas: entries.map((e) => e.personaId),
          cards: pending?.value.cards ?? [],
          phase: "building",
          startedAt: pending?.value.startedAt ?? now,
          qualityVersion: 1
        })
        for (const entry of entries) this.store.put("investigation", `${roundId}:${entry.personaId}`, entry)
        const created: string[] = []
        for (const entry of entries) {
          const key = `${roundId}:${entry.personaId}`
          // Journal before external creation so retries use identical content and idempotency keys.
          this.store.put("investigation", key, entry)
          const persona = this.policy.personas.find((p) => p.personaId === entry.personaId)!
          const card = await this.runtime.createCard({
            boardId: this.policy.boardId,
            title: `Investigate: ${entry.personaId}`,
            agentId: entry.agentId,
            status: created.length ? "todo" : "ready",
            parents: created.slice(-1),
            idempotencyKey: `round:${roundId}:${entry.personaId}`,
            maxRuntimeSeconds: this.policy.quality!.sessionSeconds,
            maxRetries: 1,
            workspace: { kind: "scratch" },
            skills: ["prompt-engineering-expert"],
            notes: JSON.stringify({
              roundId,
              persona,
              revision: entry.revision,
              skillHash: entry.skillHash,
              promptSkill: entry.skillText,
              recentOutcomes: this.feedback(entry.personaId),
              instructions: [
                "Use autocode_inspect(roundId, personaId, path) to inspect committed repository files. Empty path lists owned files. When truncated, pass the returned nextOffset as offset to continue reading the same committed file. No shell, editing, deployment or release tools are available in this research role.",
                "Run a short real investigation for your persona goals. Use the supplied prompt-engineering-expert skill to create at most two bounded implementation prompts for useful features or fixes.",
                "First write a short persona-specific investigation brief: questions, counterchecks, stopping criteria and expected evidence. Apply it, then include the brief with your implementationPrompt. Self-prompting must retain the fixed evidence, uncertainty and acceptance requirements.",
                "The proposal goal must exactly copy one of persona.goals. Do not replace it with a newly phrased task goal; put that task-specific outcome in title and quality.expectedBenefit.",
                "Submit via autocode_propose. Include personaId, goal, title, evidence [{path,observation}], allowedPaths, acceptance, alternatives, implementationPrompt, and quality {problem,userWorkflow,expectedBenefit,approach,nonGoals,risk,riskReasons,verification:[{criterion,method}]}. Alternatives must be non-empty strings. quality.risk must be routine or high, and riskReasons must be an array of strings. Every criterion needs a verification method. quality.hypothesis is required: {metric,unit,baseline,target,direction:increase|decrease,baselineEvidence:[inspected evidence paths],evidenceStrength:observed|reproduced|measured,confidence:0..1,uncertainty,effortHours,costCents,measurementPlan,alternatives:[{kind:no_op|change,description,rationale}]}. Include both no_op and change; quantify benefit without inventing measurements.",

                "The prompt must cover approach, constraints, non-goals and acceptance verification. Do not manufacture ideas or claim a template was an inference session.",
                "Finish with autocode_investigation_finish(roundId,personaId,outcome,reason), where outcome is completed or no_op, then workboard_complete. No useful improvement is a valid no_op."
              ]
            })
          })
          entry.cardId = card.id
          this.store.put("investigation", key, entry)
          created.push(card.id)
        }
        const planner = await this.runtime.createCard({
          boardId: this.policy.boardId,
          title: `Select persona ideas: ${roundId}`,
          agentId: this.policy.plannerAgentId,
          status: "todo",
          parents: created,
          idempotencyKey: `round:${roundId}:admission`,
          maxRuntimeSeconds: 300,
          maxRetries: 1,
          workspace: { kind: "scratch" },
          notes: JSON.stringify({
            roundId,
            instructions: [
              "Read autocode_proposals. Compare user value, evidence strength, complexity, dependencies and risk. Admit only useful bounded slices; zero admissions is valid.",
              "Use autocode_admit(proposalId,rationale) for selections. Use autocode_defer(proposalId,reason) for every rejected or deferred alternative, including already implemented or equivalent problems with different titles. Never invent or edit proposals.",
              "Group equivalent findings by underlying behavior and user workflow, not titles or persona labels. Preserve each persona contribution, admit one implementation per problem, and defer duplicates with the selected proposal ID.",
              "In the completion report, map persona goals to inspected evidence and selected or deferred findings. Identify uncovered goals as uninvestigated or inconclusive; do not invent a proposal just to fill coverage gaps.",
              "Complete the Workboard card with selections and reasons."
            ]
          })
        })
        created.push(planner.id)
        this.store.put("round", roundId, {
          personas: entries.map((e) => e.personaId),
          cards: created,
          phase: "dispatched",
          startedAt: pending?.value.startedAt ?? now,
          qualityVersion: 1
        })
        return { created }
      })
    })
  }
  feedback(personaId: string) {
    const memory = this.store.get<NativeMemoryConfig>("native-memory-config", this.policy.boardId)
    return {
      verifiedLessons: memory
        ? verifiedNativeLessons(this.store, memory.projectId, personaId)
            .slice(-5)
            .map(({ id, value }) => ({
              id,
              title: value.title,
              content: value.content,
              attemptId: value.attemptId,
              receiptDigest: value.receiptDigest,
              untrustedContent: true
            }))
        : [],
      decisions: this.store
        .list<{ proposal: NativeProposal }>("proposal")
        .filter((p) => p.value.proposal.personaId === personaId)
        .flatMap((p) => {
          const decision = this.store.get("decision", p.id)
          return decision ? [{ proposal: p.value.proposal.title, decision }] : []
        })
        .slice(-10),
      workflows: this.store
        .list<NativeWorkflow>("workflow")
        .filter((w) => w.value.proposal.personaId === personaId)
        .slice(-10)
        .map(({ id, value: w }) => ({
          id,
          title: w.proposal.title,
          deployed: Boolean(w.deployedSha),
          blocker: w.blocker,
          review: w.review,
          repairs: w.repairCount ?? 0,
          benefit: w.benefitEvidence
        }))
    }
  }
  async investigation(agentId: string, sessionKey: string, roundId: string, personaId: string) {
    this.runtime.assertEnabled()
    const entry = this.store.get<Investigation>("investigation", `${roundId}:${personaId}`)
    if (!entry || entry.agentId !== agentId || entry.state !== "pending")
      throw new Error("No active assigned investigation")
    const card = (await nativeCards(this.gateway, this.policy.boardId)).find((c) => c.id === entry.cardId)
    this.runtime.assertSession(card, sessionKey)
    if (entry.sessionKey && entry.sessionKey !== sessionKey)
      throw new Error("Investigation belongs to its original session")
    entry.startedAt ??= card?.execution?.startedAt ?? card?.startedAt ?? Date.now()
    if (Date.now() >= entry.startedAt + this.policy.quality!.sessionSeconds * 1000)
      throw new Error("Investigation inference budget expired")
    entry.sessionKey = sessionKey
    this.store.put("investigation", `${roundId}:${personaId}`, entry)
    return entry
  }
  async inspect(
    agentId: string,
    sessionKey: string,
    roundId: string,
    personaId: string,
    path: string,
    offset = 0,
    options: { startLine?: number; lineCount?: number; contextPack?: boolean } = {}
  ) {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Inspection offset must be a non-negative integer")
    const entry = await this.investigation(agentId, sessionKey, roundId, personaId)
    const persona = this.policy.personas.find((p) => p.personaId === personaId)!
    const files = (await this.files(entry.revision)).filter((p) =>
      persona.allowedPaths.some((root) => nativePathAllowed(p, root))
    )
    if (!path) {
      if (offset) throw new Error("File listing does not accept a continuation offset")
      return { revision: entry.revision, files }
    }
    if (!files.includes(path)) throw new Error("Inspection path must be a tracked file in persona scope")
    const source = { root: this.policy.repository, revision: entry.revision, allowedPaths: persona.allowedPaths }
    if (options.contextPack || options.startLine !== undefined || options.lineCount !== undefined) {
      if (offset) throw new Error("Line/context inspection cannot mix a character continuation offset")
      const pack = options.contextPack ? await buildNativeContextPack(source, [path]) : undefined
      const excerpts = pack?.excerpts ?? [await readNativeExcerpt(source, path, options)]
      for (const excerpt of excerpts) {
        const key = `${roundId}:${personaId}:${excerpt.path}`
        const previous = this.store.get<{ lineRanges?: unknown[] }>("inspection", key)
        this.store.put("inspection", key, {
          ...previous,
          revision: entry.revision,
          path: excerpt.path,
          sessionKey,
          sha256: excerpt.sha256,
          blobId: excerpt.blobId,
          lineRanges: [
            ...(previous?.lineRanges ?? []),
            { startLine: excerpt.startLine, endLine: excerpt.endLine, partialLastLine: excerpt.partialLastLine }
          ]
        })
      }
      if (pack) return { revision: entry.revision, path, contextPack: pack, untrustedContent: true }
      return { ...excerpts[0]!, untrustedContent: true }
    }
    const content = await nativeGitRaw(this.policy.repository, "show", `${entry.revision}:${path}`)
    if (content.includes("\0")) throw new Error("Inspection file is binary")
    const sha256 = createHash("sha256").update(content).digest("hex")
    if (offset > content.length) throw new Error("Inspection offset exceeds the recorded file length")
    if (
      offset > 0 &&
      /[\uDC00-\uDFFF]/.test(content.charAt(offset)) &&
      /[\uD800-\uDBFF]/.test(content.charAt(offset - 1))
    )
      throw new Error("Inspection offset splits a Unicode character; use the returned nextOffset")
    let end = Math.min(content.length, offset + 64_000)
    if (
      end < content.length &&
      /[\uD800-\uDBFF]/.test(content.charAt(end - 1)) &&
      /[\uDC00-\uDFFF]/.test(content.charAt(end))
    )
      end--
    const key = `${roundId}:${personaId}:${path}`
    const ranges = this.store.get<{ ranges?: Array<{ start: number; end: number }> }>("inspection", key)?.ranges ?? []
    if (!ranges.some((r) => r.start === offset && r.end === end)) ranges.push({ start: offset, end })
    this.store.put("inspection", key, {
      ...this.store.get<Record<string, unknown>>("inspection", key),
      revision: entry.revision,
      path,
      sessionKey,
      ranges,
      sha256
    })
    return {
      revision: entry.revision,
      path,
      content: content.slice(offset, end),
      sha256,
      startLine: content.slice(0, offset).split("\n").length,
      endLine: content.slice(0, end).split("\n").length,
      untrustedContent: true,
      offset,
      nextOffset: end < content.length ? end : null,
      totalChars: content.length,
      truncated: end < content.length
    }
  }
  async propose(agentId: string, sessionKey: string, roundId: string, raw: any) {
    assertNativeMode(this.policy, "propose")
    const entry = await this.investigation(agentId, sessionKey, roundId, raw?.personaId)
    const proposal = validateNativeProposal(raw, this.policy)
    const q = raw.quality
    if (!q) throw new Error("Skill-generated implementation contract required")
    const hypothesis = validateNativeBenefitHypothesis(q.hypothesis)
    const required = ["problem", "userWorkflow", "expectedBenefit", "approach"] as const
    for (const key of required) qualityText(q[key], key)
    if (
      !Array.isArray(q.nonGoals) ||
      !q.nonGoals.length ||
      q.nonGoals.some((s: unknown) => !qualityText(s, "non-goal"))
    )
      throw new Error("Non-goals required")
    if (!["routine", "high"].includes(q.risk) || !Array.isArray(q.riskReasons))
      throw new Error("quality.risk must be routine or high; quality.riskReasons must be an array of strings")
    if (
      !Array.isArray(q.verification) ||
      q.verification.length !== proposal.acceptance.length ||
      new Set(q.verification.map((v: any) => v.criterion)).size !== proposal.acceptance.length ||
      proposal.acceptance.some(
        (a) => !q.verification.some((v: any) => v.criterion === a && qualityText(v.method, "verification method"))
      )
    )
      throw new Error("Map every acceptance criterion to verification")
    const evidenceHashes: Record<string, string> = {}
    for (const e of proposal.evidence) {
      if (!this.store.get("inspection", `${roundId}:${proposal.personaId}:${e.path}`))
        throw new Error("Evidence must reference a file inspected in this investigation")
      evidenceHashes[e.path] = await this.evidenceHash(entry.revision, e.path)
    }
    if (hypothesis.baselineEvidence.some((path) => !evidenceHashes[path]))
      throw new Error("Baseline evidence must reference inspected proposal evidence paths")
    const scopedFiles = (await this.files(entry.revision)).filter((p) =>
      proposal.allowedPaths.some((root) => nativePathAllowed(p, root))
    )
    const pathReasons = [...proposal.allowedPaths, ...scopedFiles].flatMap((p) =>
      this.policy
        .quality!.highRiskPaths.filter((root) => nativePathAllowed(p, root))
        .map((root) => `${p}: protected path rule ${root}`)
    )
    const highRisk =
      [...proposal.allowedPaths, ...scopedFiles].some((p) =>
        this.policy.quality!.highRiskPaths.some((root) => nativePathAllowed(p, root))
      ) ||
      /authenticat|permission|sensitive.data|migration|public.contract|deploy/i.test(
        [q.problem, q.approach, ...proposal.acceptance].join(" ")
      )
    const quality: NativeProposalQuality = {
      ...Object.fromEntries(required.map((key) => [key, q[key].trim()])),
      hypothesis,
      nonGoals: q.nonGoals,
      risk: highRisk ? "high" : q.risk,
      riskReasons: [...q.riskReasons, ...pathReasons, ...(highRisk ? ["Project path or textual risk rule"] : [])],
      verification: q.verification,
      revision: entry.revision,
      skillHash: entry.skillHash,
      ...(entry.skillContractVersion ? { skillContractVersion: entry.skillContractVersion } : {}),
      ...(entry.skillPolicyDigest ? { skillPolicyDigest: entry.skillPolicyDigest } : {}),
      sessionKey,
      evidenceHashes
    } as NativeProposalQuality
    proposal.quality = quality
    const key = nativeProblemKey(quality.problem, quality.userWorkflow)
    // Keep each persona's evidence and completion accounting, even for the same problem.
    // Reuse legacy IDs on retry so in-flight rounds survive an upgrade.
    const previous = this.store
      .list<{ roundId: string; proposal: NativeProposal }>("proposal")
      .find(
        (p) =>
          p.value.roundId === roundId &&
          p.value.proposal.personaId === proposal.personaId &&
          p.value.proposal.quality &&
          nativeProblemKey(p.value.proposal.quality.problem, p.value.proposal.quality.userWorkflow) === key
      )
    if (previous) return { proposalId: previous.id }
    const proposalId = `${roundId}:${proposal.personaId}:${key}`
    if (
      this.store
        .list<{ roundId: string; proposal: NativeProposal }>("proposal")
        .filter((p) => p.value.roundId === roundId && p.value.proposal.personaId === proposal.personaId).length >= 2
    )
      throw new Error("Persona proposal limit reached")
    this.store.put("proposal", proposalId, { roundId, proposal })
    this.store.event("persona.proposed", proposalId, {
      personaId: proposal.personaId,
      sessionKey,
      skillHash: entry.skillHash,
      risk: quality.risk,
      riskReasons: quality.riskReasons
    })
    return { proposalId }
  }
  async finish(
    agentId: string,
    sessionKey: string,
    roundId: string,
    personaId: string,
    outcome: string,
    reason: string
  ) {
    const entry = await this.investigation(agentId, sessionKey, roundId, personaId)
    if (!["completed", "no_op"].includes(outcome)) throw new Error("Invalid investigation outcome")
    const proposals = this.store
      .list<{ roundId: string; proposal: NativeProposal }>("proposal")
      .filter((p) => p.value.roundId === roundId && p.value.proposal.personaId === personaId)
    if ((outcome === "completed") !== Boolean(proposals.length))
      throw new Error("Investigation outcome does not match recorded proposals")
    this.store.put("investigation", `${roundId}:${personaId}`, {
      ...entry,
      state: outcome,
      reason: qualityText(reason, "reason"),
      sessionKey
    })
    return { recorded: true }
  }
  selection(roundId: string) {
    const spent = this.store
      .list<{ roundId: string; proposalId: string }>("admission")
      .filter((a) => a.value.roundId === roundId)
    const budget = { ...(this.policy.quality?.admissionBudget ?? { effortHours: 24, costCents: 10000 }) }
    for (const admission of spent) {
      const h = this.store.get<{ proposal: NativeProposal }>("proposal", admission.value.proposalId)?.proposal.quality
        ?.hypothesis
      if (h) {
        budget.effortHours -= h.effortHours
        budget.costCents -= h.costCents
      }
    }
    const candidates = this.store
      .list<{ roundId: string; proposal: NativeProposal }>("proposal")
      .filter((p) => p.value.roundId === roundId && !this.store.get("decision", p.id))
      .flatMap(({ id, value: { proposal } }) => {
        if (!proposal.quality?.hypothesis) return []
        const persona = this.policy.personas.find(
          (p) => p.personaId === proposal.personaId && p.goals.includes(proposal.goal)
        )
        if (!persona) return []
        return [
          {
            id,
            goal: proposal.goal,
            weight: persona.weight,
            risk: proposal.quality.risk,
            hypothesis: proposal.quality.hypothesis
          }
        ]
      })
    const goalAdmissions: Record<string, number> = {}
    let explored = 0
    for (const admission of spent) {
      const proposal = this.store.get<{ proposal: NativeProposal }>("proposal", admission.value.proposalId)?.proposal
      if (proposal) goalAdmissions[proposal.goal] = (goalAdmissions[proposal.goal] ?? 0) + 1
      if (
        this.store.get<{ selection?: { exploration?: boolean } }>("decision", admission.value.proposalId)?.selection
          ?.exploration
      )
        explored++
    }
    return selectNativeImprovements(
      candidates,
      {
        effortHours: Math.max(0, budget.effortHours),
        costCents: Math.max(0, budget.costCents)
      },
      Math.max(0, this.policy.maxTasksPerRound - spent.length),
      { slots: Math.max(0, (this.policy.quality?.explorationSlots ?? 0) - explored), goalAdmissions }
    )
  }
  async admission(proposalId: string, proposal: NativeProposal, roundId: string) {
    const q = proposal.quality
    if (!q) throw new Error("New quality rounds require a complete implementation contract")
    const entry = this.store.get<Investigation>("investigation", `${roundId}:${proposal.personaId}`)
    if (entry?.state !== "completed") throw new Error("Investigation has not completed successfully")
    const revision = await nativeGit(this.policy.repository, "rev-parse", `origin/${this.policy.baseBranch}`)
    for (const [path, expected] of Object.entries(q.evidenceHashes))
      if ((await this.evidenceHash(revision, path)) !== expected) {
        this.defer(this.policy.plannerAgentId, proposalId, "Evidence changed; refresh investigation")
        throw new Error("Evidence changed; refresh investigation")
      }
    const decision = this.store.get<{ outcome: string }>("decision", proposalId)
    if (decision?.outcome === "deferred") throw new Error("Deferred proposal requires a new investigation")
    const duplicate = decideNativeDuplicate(this.store, proposalId, proposal, this.policy.dedupeWindowHours)
    if (duplicate.suppress) throw new Error("Equivalent decided problem requires new evidence or reviewed override")
  }
  defer(agentId: string, proposalId: string, reason: string) {
    this.runtime.assertEnabled()
    if (agentId !== this.policy.plannerAgentId || !this.store.get("proposal", proposalId))
      throw new Error("Only planner can decide recorded proposals")
    const explanation = qualityText(reason, "reason")
    const previous = this.store.get<{ outcome: string }>("decision", proposalId)
    if (previous?.outcome === "admitted") throw new Error("Cannot defer an admitted proposal")
    if (previous?.outcome === "rejected") return { recorded: true }
    this.store.put("decision", proposalId, { ...previous, outcome: "deferred", reason: explanation })
    return { recorded: true }
  }
  async designReview(
    agentId: string,
    sessionKey: string,
    workflowId: string,
    verdict: string,
    rationale: string,
    assessment: NativeAssessment
  ): Promise<{ recorded: boolean }> {
    assertNativeMode(this.policy, "review")
    if (!this.store.holdsLease(`workflow:${workflowId}`))
      return this.runtime.withWorkflowLease(workflowId, () =>
        this.designReview(agentId, sessionKey, workflowId, verdict, rationale, assessment)
      )
    this.runtime.assertEnabled()
    const w = this.runtime.requireWorkflow(workflowId)
    if (agentId !== this.policy.reviewerAgentId || agentId === this.policy.coderAgentId)
      throw new Error("Independent design reviewer required")
    const card = (await nativeCards(this.gateway, this.policy.boardId)).find((c) => c.id === w.designCardId)
    this.runtime.assertSession(card, sessionKey)
    if (!["approved", "changes_requested"].includes(verdict)) throw new Error("Invalid design verdict")
    const result = validateNativeAssessment(assessment, w.proposal.acceptance, verdict === "approved")
    const digest = this.designDigest(w)
    if (w.designCardDigest !== digest) throw new Error("Design review context changed; request a fresh design review")
    w.designReview = {
      verdict,
      rationale: qualityText(rationale, "rationale"),
      sessionKey,
      assessment: result,
      digest,
      receiptVersion: 1,
      ...(w.lifecycle ? { attemptId: w.lifecycle.attemptId } : {}),
      policyDigest: nativePolicyTraceDigest(this.policy),
      ...(w.proposal.quality ? { skillDigest: w.proposal.quality.skillHash } : {})
    }
    this.store.event("design.reviewed", workflowId, { verdict, digest, sessionKey })
    if (verdict !== "approved") w.blocker = `Design changes required: ${rationale}`
    this.runtime.transitionWorkflow(
      workflowId,
      w,
      verdict !== "approved"
        ? "blocked"
        : w.review?.verdict === "approved"
          ? "release"
          : w.verification
            ? "review"
            : w.candidate
              ? "verification"
              : "implementation"
    )
    return { recorded: true }
  }
  report() {
    const investigations = this.store.list<Investigation>("investigation").map(({ id, value }) => ({
      id,
      personaId: value.personaId,
      state: value.state,
      reason: value.reason,
      revision: value.revision,
      skillHash: value.skillHash,
      sessionKey: value.sessionKey,
      runId: value.runId
    }))
    const workflows = this.store.list<NativeWorkflow>("workflow")
    const outcomes = nativeOutcomeReport(this.store)
    return {
      boardId: this.policy.boardId,
      qualityEnabled: Boolean(this.policy.quality),
      riskAssessments: workflows.map(({ id, value }) => ({
        workflowId: id,
        assessment: value.riskAssessment,
        risk: value.riskAssessment?.risk ?? value.proposal.quality?.risk ?? "routine",
        designApproved: this.designApproved(value)
      })),
      investigations,
      successfulInvestigations: investigations.filter((i) => ["completed", "no_op"].includes(i.state)).length,
      benefitEvidence: workflows.map((w) => ({ workflowId: w.id, benefit: w.value.benefitEvidence })),
      decisions: this.store.list("decision"),
      outcomes,
      firstPassReviews: outcomes.workflows.filter((w) => w.firstPassReview).length,
      reviewedWorkflows: outcomes.denominators.reviewed,
      repairs: outcomes.workflows.reduce((n, w) => n + w.repairs, 0),
      verifiedDeployments: outcomes.denominators.deployed
    }
  }
}
