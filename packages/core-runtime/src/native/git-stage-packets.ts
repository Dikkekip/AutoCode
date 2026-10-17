import { execFileSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type GitStagePlan,
  gitStageDigest,
  gitStageId,
  gitStagePath,
  gitStageSha,
  type NativeAutonomyPolicy,
  type NativeProposal,
  redactCommandText,
  redactLogText,
  renderGitStageReport,
  validateGitStagePlan
} from "@openclaw/domain"
import type { NativeWorkflow } from "./runtime.js"
import { type NativeEvidenceStore, type NativeRecordWrite, NativeRevisionConflict } from "./store.js"

interface StageExport {
  schemaVersion: 1
  workflowId: string
  sequence: number
  eventId: string
  files: Record<string, string>
  commit?: string
}

/** Local, host-only Git object transport. Never reads a working tree or imports authority from Git. */
export class NativeGitStagePackets {
  readonly ref: string
  private readonly owner: string
  constructor(
    readonly policy: NativeAutonomyPolicy,
    readonly store: NativeEvidenceStore
  ) {
    this.ref = `refs/heads/autocode/coordination/${gitStageDigest(policy.boardId).slice(0, 16)}`
    this.owner = gitStageDigest(JSON.stringify([realpathSync(policy.repository), realpathSync(store.path)]))
  }
  private git(args: string[], input?: string, index?: string, raw = false): string {
    const result = execFileSync(
      "/usr/bin/git",
      ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-C", this.policy.repository, ...args],
      {
        env: {
          PATH: "/usr/bin:/bin",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_NO_REPLACE_OBJECTS: "1",
          GIT_AUTHOR_NAME: "AutoCode",
          GIT_AUTHOR_EMAIL: "autocode@localhost",
          GIT_COMMITTER_NAME: "AutoCode",
          GIT_COMMITTER_EMAIL: "autocode@localhost",
          ...(index ? { GIT_INDEX_FILE: index } : {})
        },
        encoding: "utf8",
        input,
        timeout: 10_000,
        maxBuffer: 2_000_000,
        stdio: ["pipe", "pipe", "pipe"]
      }
    )
    return raw ? result : result.trimEnd()
  }
  sourceRevision(): string {
    return gitStageSha(this.git(["rev-parse", "--verify", `refs/remotes/origin/${this.policy.baseBranch}^{commit}`]))
  }
  plan(workflowId: string, proposal: NativeProposal): GitStagePlan {
    const quality = proposal.quality
    if (!quality?.sessionKey || !quality.skillHash || !quality.revision)
      throw new Error("Git stage packets require a skill-backed, source-bound investigation; refresh the proposal")
    const sourceBaseSha = this.sourceRevision()
    if (sourceBaseSha !== quality.revision) throw new Error("Git stage plan source changed; refresh investigation")
    const plan: GitStagePlan = {
      schemaVersion: 1,
      boardId: this.policy.boardId,
      workflowId,
      planId: gitStageDigest(JSON.stringify([workflowId, proposal])),
      revision: 1,
      sourceBaseSha,
      skillDigest: quality.skillHash,
      coderPrompt: proposal.implementationPrompt,
      coderPromptDigest: gitStageDigest(proposal.implementationPrompt),
      goal: proposal.goal,
      title: proposal.title,
      allowedPaths: proposal.allowedPaths,
      acceptance: proposal.acceptance,
      alternatives: proposal.alternatives,
      evidence: proposal.evidence,
      nonGoals: quality.nonGoals,
      verification: quality.verification,
      producerSessionId: quality.sessionKey,
      admittedByAgentId: this.policy.plannerAgentId,
      dependencyWorkflowIds: proposal.dependsOnWorkflowIds ?? []
    }
    const serialized = JSON.stringify(plan)
    if (redactLogText(redactCommandText(serialized)) !== serialized)
      throw new Error("Git stage plan contains sensitive text; revise it before admission")
    validateGitStagePlan(plan)
    if (Buffer.byteLength(renderGitStageReport(plan)) > 256_000)
      throw new Error("Git stage HTML plan exceeds size limit")
    return plan
  }
  project(id: string, value: unknown, sequence: number): NativeRecordWrite[] {
    const workflow = value as NativeWorkflow
    const plan = workflow.gitStagePlan
    const previous = this.store.get<NativeWorkflow>("workflow", id)
    if (!plan) {
      if (previous?.gitStagePlan) throw new Error("Cannot remove an admitted Git stage plan")
      return [] // Existing workflows keep their admitted contract.
    }
    validateGitStagePlan(plan)
    if (plan.workflowId !== id || plan.boardId !== this.policy.boardId)
      throw new Error("Git stage workflow identity mismatch")
    if (
      plan.coderPrompt !== workflow.proposal.implementationPrompt ||
      JSON.stringify(plan.allowedPaths) !== JSON.stringify(workflow.proposal.allowedPaths) ||
      JSON.stringify(plan.acceptance) !== JSON.stringify(workflow.proposal.acceptance) ||
      JSON.stringify(plan.dependencyWorkflowIds) !== JSON.stringify(workflow.proposal.dependsOnWorkflowIds ?? [])
    )
      throw new Error("Git stage proposal changed after admission")
    if (JSON.stringify(plan) !== JSON.stringify(previous?.gitStagePlan ?? plan))
      throw new Error("Git stage plan is immutable; admit a successor workflow")
    const eventId = gitStageDigest(`${id}:${sequence}`)
    const candidate = workflow.candidate?.headSha
    if (candidate) gitStageSha(candidate)
    const event = {
      schemaVersion: 1,
      boardId: this.policy.boardId,
      workflowId: id,
      eventId,
      sequence,
      previousEventId: sequence === 1 ? null : gitStageDigest(`${id}:${sequence - 1}`),
      planId: plan.planId,
      planRevision: plan.revision,
      kind:
        sequence === 1
          ? "plan.accepted"
          : workflow.review && JSON.stringify(workflow.review) !== JSON.stringify(previous?.review)
            ? `review.${workflow.review.verdict}`
            : workflow.verification && JSON.stringify(workflow.verification) !== JSON.stringify(previous?.verification)
              ? "verification.finished"
              : candidate && candidate !== previous?.candidate?.headSha
                ? "candidate.submitted"
                : workflow.lifecycle?.state === "completed"
                  ? "workflow.completed"
                  : "workflow.snapshot",
      state: workflow.lifecycle?.state ?? "implementation",
      attemptId: workflow.lifecycle?.attemptId,
      candidateCodeSha: candidate ?? null,
      executionId: workflow.submission?.executionId ?? null,
      sessionId: workflow.submission?.sessionKey ?? null,
      verificationDigest: workflow.verification ? gitStageDigest(JSON.stringify(workflow.verification)) : null,
      review: workflow.review
        ? {
            headSha: workflow.review.headSha,
            verdict: workflow.review.verdict,
            receiptDigest: gitStageDigest(JSON.stringify(workflow.review))
          }
        : null,
      mergedSha: workflow.mergedSha ?? null,
      deployedSha: workflow.deployedSha ?? null,
      blocked: Boolean(workflow.blocker)
    }
    const root = `workflows/${gitStageId(id)}`
    const files: Record<string, string> = { [`${root}/events/${eventId}.json`]: `${JSON.stringify(event)}\n` }
    const handoff = {
      schemaVersion: 1,
      workflowId: id,
      planId: plan.planId,
      eventId,
      nextRole: ["completed", "cancelled"].includes(event.state)
        ? "none"
        : workflow.blocker
          ? "operator"
          : workflow.review?.verdict === "changes_requested"
            ? "coder"
            : workflow.review?.verdict === "approved"
              ? "release"
              : workflow.lifecycle?.state === "design_wait"
                ? "reviewer"
                : workflow.verification
                  ? "reviewer"
                  : candidate
                    ? "verifier"
                    : "coder",
      candidateCodeSha: candidate ?? null,
      state: event.state,
      review: workflow.review
        ? {
            verdict: workflow.review.verdict,
            rationale: workflow.review.rationale,
            assessment: workflow.review.assessment
              ? {
                  criteria: workflow.review.assessment.criteria.slice(0, 24),
                  findings: workflow.review.assessment.findings.slice(0, 24),
                  truncated:
                    workflow.review.assessment.criteria.length > 24 || workflow.review.assessment.findings.length > 24
                }
              : undefined
          }
        : null,
      verification: workflow.verification?.checks.slice(0, 100).map((check) => ({ exitCode: check.exitCode })),
      blocker: workflow.blocker ?? null
    }
    const handoffJson = JSON.stringify(handoff, (_key, item) =>
      typeof item === "string" ? redactLogText(redactCommandText(item)).slice(0, 2000) : item
    )
    files[`${root}/handoffs/${eventId}.json`] = `${handoffJson}\n`
    const safeText = handoffJson.slice(0, 32_000).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    files[`${root}/handoffs/${eventId}.html`] =
      `<!doctype html><html lang="en"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'"><title>Stage handoff</title><h1>Stage handoff</h1><p>Preview limited to 32,000 characters. Full JSON is in the sibling artifact; full evidence remains in authenticated context.</p><pre>${safeText}</pre></html>\n`
    if (sequence === 1) {
      const directory = `${root}/plans/${plan.planId}`
      files[`${directory}/plan.json`] = `${JSON.stringify(plan)}\n`
      files[`${directory}/coder.prompt.md`] = plan.coderPrompt
      files[`${directory}/report.html`] = renderGitStageReport(plan)
    }
    return [
      {
        kind: "git-stage-export",
        id: `${id}:${sequence}`,
        expectedVersion: 0,
        value: { schemaVersion: 1, workflowId: id, sequence, eventId, files } satisfies StageExport
      }
    ]
  }
  private tip(): string | null {
    const ref = this.git(["for-each-ref", "--format=%(objectname)", this.ref])
    return ref ? gitStageSha(ref) : null
  }
  private read(tip: string, path: string): string | null {
    gitStageSha(tip)
    gitStagePath(path)
    const entry = this.git(["ls-tree", tip, "--", path])
    if (!entry) return null
    if (!entry.startsWith("100644 blob ")) throw new Error("Git stage artifact must be a regular blob")
    return this.git(["cat-file", "blob", `${tip}:${path}`], undefined, undefined, true)
  }
  private publish(packet: StageExport): string {
    gitStageId(packet.workflowId)
    if (
      packet.schemaVersion !== 1 ||
      !Number.isSafeInteger(packet.sequence) ||
      packet.sequence < 1 ||
      packet.eventId !== gitStageDigest(`${packet.workflowId}:${packet.sequence}`) ||
      Object.keys(packet.files).some((path) => !path.startsWith(`workflows/${packet.workflowId}/`))
    )
      throw new Error("Invalid Git stage export envelope")
    const metadata = JSON.stringify({ schemaVersion: 1, boardId: this.policy.boardId, owner: this.owner })
    const directory = mkdtempSync(join(tmpdir(), "autocode-git-packet-"))
    const index = join(directory, "index")
    try {
      for (let attempt = 0; attempt < 5; attempt++) {
        this.store.authorizeEffect()
        const tip = this.tip()
        if (tip && this.read(tip, "publisher.json") !== metadata)
          throw new Error("Git stage branch belongs to another evidence store; refusing split authority")
        if (
          packet.sequence > 1 &&
          (!tip ||
            !this.read(
              tip,
              `workflows/${packet.workflowId}/events/${gitStageDigest(`${packet.workflowId}:${packet.sequence - 1}`)}.json`
            ))
        )
          throw new Error("Git stage predecessor is missing; restore accepted history")
        const files = { "publisher.json": metadata, ...packet.files }
        let complete = Boolean(tip)
        for (const [path, content] of Object.entries(files)) {
          gitStagePath(path)
          if (Buffer.byteLength(content) > 256_000) throw new Error("Git stage artifact exceeds size limit")
          const existing = tip ? this.read(tip, path) : null
          if (existing !== null && existing !== content) throw new Error("Immutable Git stage artifact conflict")
          if (existing === null) complete = false
        }
        if (complete && tip) return tip // Crash after update-ref: acknowledge the already-published event.
        this.git(tip ? ["read-tree", tip] : ["read-tree", "--empty"], undefined, index)
        for (const [path, content] of Object.entries(files)) {
          const blob = this.git(["hash-object", "-w", "--stdin"], content)
          this.git(["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], undefined, index)
        }
        const tree = this.git(["write-tree"], undefined, index)
        const commit = this.git(
          ["commit-tree", tree, ...(tip ? ["-p", tip] : [])],
          `AutoCode stage ${packet.eventId}\n`
        )
        this.store.authorizeEffect()
        try {
          this.git(["update-ref", this.ref, commit, tip ?? "0".repeat(commit.length)])
          return commit
        } catch (error) {
          if (this.tip() === tip) throw error
        }
      }
      throw new Error("Git stage publication contention; retry reconciliation")
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
  flush(workflowId?: string): void {
    const pending = this.store
      .list<StageExport>("git-stage-export")
      .filter(({ value }) => !value.commit && (!workflowId || value.workflowId === workflowId))
      .sort((a, b) => a.value.workflowId.localeCompare(b.value.workflowId) || a.value.sequence - b.value.sequence)
    for (const { id, value } of pending) {
      const version = this.store.version("git-stage-export", id)
      if (this.store.get<StageExport>("git-stage-export", id)?.commit) continue
      const commit = this.publish(value)
      try {
        this.store.commit([{ kind: "git-stage-export", id, value: { ...value, commit }, expectedVersion: version }], {
          kind: "git-stage.published",
          subject: id,
          value: { commit }
        })
      } catch (error) {
        if (!(error instanceof NativeRevisionConflict) || !this.store.get<StageExport>("git-stage-export", id)?.commit)
          throw error
      }
    }
  }
  context(id: string, plan: GitStagePlan) {
    validateGitStagePlan(plan)
    if (plan.workflowId !== id || plan.boardId !== this.policy.boardId)
      throw new Error("Git stage context identity mismatch")
    this.flush(id)
    const first = this.store.get<StageExport>("git-stage-export", `${id}:1`)
    if (!first?.commit || first.workflowId !== id) throw new Error("Git stage plan publication is pending")
    const root = `workflows/${gitStageId(id)}/plans/${gitStageId(plan.planId)}`
    const content = this.read(first.commit, `${root}/coder.prompt.md`)
    // Compare both Git blob identity and exact bytes, including trailing whitespace.
    const expected = this.git(["hash-object", "--stdin"], plan.coderPrompt)
    const actual = this.git(["rev-parse", `${first.commit}:${root}/coder.prompt.md`])
    if (expected !== actual || content !== plan.coderPrompt) throw new Error("Git stage prompt digest mismatch")
    return {
      ref: this.ref,
      commit: first.commit,
      planId: plan.planId,
      revision: plan.revision,
      sourceBaseSha: plan.sourceBaseSha,
      coderPromptDigest: plan.coderPromptDigest,
      coderPrompt: plan.coderPrompt
    }
  }
  status() {
    const tip = this.tip()
    if (
      tip &&
      this.read(tip, "publisher.json") !==
        JSON.stringify({ schemaVersion: 1, boardId: this.policy.boardId, owner: this.owner })
    )
      throw new Error("Git stage publisher identity mismatch")
    const exports = this.store.list<StageExport>("git-stage-export")
    return {
      enabled: true,
      transport: "local",
      ref: this.ref,
      tip,
      pending: exports
        .filter(({ value }) => !value.commit)
        .map(({ id, value }) => ({ id, workflowId: value.workflowId })),
      published: exports.filter(({ value }) => value.commit).length
    }
  }
}
