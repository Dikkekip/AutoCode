import { createHash } from "node:crypto"
import { type NativeProposal, nativeHighRiskPaths, nativePathAllowed, nativePolicyDigest } from "@openclaw/domain"
import type { NativeAutonomyRuntime } from "./runtime.js"

export interface NativeHumanInputConfig {
  boardId: string
  telegramTarget: string
  ownerIds: string[]
  accountId?: string
  maxRoutineHours: number
  maxRoutineCostCents: number
}
export interface NativeIdeaDecision {
  id: string
  proposalId: string
  roundId: string
  digest: string
  title: string
  benefit: string
  reasons: string[]
  effortHours: number | null
  costCents: number | null
  required: boolean
  state: "pending" | "approved" | "skipped" | "routine"
  createdAt: number
  decidedAt?: number
  decidedBy?: string
  delivery?: "sending" | "sent" | "uncertain"
  plannerCardId?: string
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
export function validateNativeHumanInput(raw: NativeHumanInputConfig): NativeHumanInputConfig {
  if (
    !raw?.boardId ||
    !/^[1-9][0-9]+$/.test(raw.telegramTarget) ||
    !Array.isArray(raw.ownerIds) ||
    !raw.ownerIds.length ||
    raw.ownerIds.some((id) => !/^[1-9][0-9]+$/.test(id)) ||
    !raw.ownerIds.includes(raw.telegramTarget) ||
    !Number.isFinite(raw.maxRoutineHours) ||
    raw.maxRoutineHours <= 0 ||
    !Number.isSafeInteger(raw.maxRoutineCostCents) ||
    raw.maxRoutineCostCents < 0
  )
    throw new Error("Human input requires an explicit private Telegram owner and bounded routine-work limits")
  return structuredClone(raw)
}
export class NativeHumanInput {
  readonly config: NativeHumanInputConfig
  constructor(
    readonly runtime: NativeAutonomyRuntime,
    config: NativeHumanInputConfig
  ) {
    this.config = validateNativeHumanInput(config)
    if (config.boardId !== runtime.policy.boardId) throw new Error("Human input board mismatch")
  }
  snapshot(proposalId: string, proposal: NativeProposal, roundId: string): NativeIdeaDecision {
    const quality = proposal.quality,
      h = quality?.hypothesis
    const reasons: string[] = []
    if (!quality) reasons.push("No complete evidence and effort estimate")
    if (quality?.risk === "high") reasons.push(...quality.riskReasons, "Persona marked this high impact")
    const protectedPaths = [...nativeHighRiskPaths, ...(this.runtime.policy.quality?.highRiskPaths ?? [])]
    if (
      proposal.allowedPaths.some(
        (path) =>
          /[*?[\]{}]/.test(path) ||
          !/\.[^/]+$/.test(path) ||
          protectedPaths.some((root) => nativePathAllowed(path, root))
      )
    )
      reasons.push("Touches protected application or deployment scope")
    if (h && h.effortHours > this.config.maxRoutineHours) reasons.push("Exceeds routine effort limit")
    if (h && h.costCents > this.config.maxRoutineCostCents) reasons.push("Exceeds routine cost estimate")
    const digest = hash({ proposalId, proposal, policy: nativePolicyDigest(this.runtime.policy), config: this.config })
    const id = digest.slice(0, 16)
    const previous = this.runtime.store.get<NativeIdeaDecision>("idea-decision", id)
    if (previous) {
      if (previous.digest !== digest) throw new Error("Idea identifier collision")
      return previous
    }
    return {
      id,
      digest,
      proposalId,
      roundId,
      title: proposal.title,
      benefit: quality?.expectedBenefit ?? proposal.goal,
      reasons: [...new Set(reasons)],
      effortHours: h?.effortHours ?? null,
      costCents: h?.costCents ?? null,
      required: reasons.length > 0,
      state: reasons.length ? "pending" : "routine",
      createdAt: Date.now()
    }
  }
  gate(proposalId: string, proposal: NativeProposal, roundId: string) {
    const idea = this.snapshot(proposalId, proposal, roundId)
    if (!this.runtime.store.get("idea-decision", idea.id))
      this.runtime.store.commit([{ kind: "idea-decision", id: idea.id, value: idea, expectedVersion: 0 }], {
        kind: "idea.requested",
        subject: idea.id,
        value: { proposalId, required: idea.required }
      })
    return { allowed: idea.state === "routine" || idea.state === "approved", idea }
  }
  list() {
    return this.runtime.store
      .list<NativeIdeaDecision>("idea-decision")
      .map((row) => row.value)
      .filter((idea) => {
        const entry = this.runtime.store.get<{ proposal: NativeProposal; roundId: string }>("proposal", idea.proposalId)
        return entry && this.snapshot(idea.proposalId, entry.proposal, entry.roundId).digest === idea.digest
      })
  }
  decide(id: string, outcome: "approve" | "skip", senderId: string, assertAuthorized: () => void) {
    assertAuthorized()
    if (!this.config.ownerIds.includes(senderId)) throw new Error("Configured Telegram owner required")
    const idea = this.list().find((item) => item.id === id)
    if (!idea) throw new Error("Unknown or stale idea; use /ideas for current decisions")
    if (idea.state !== "pending") {
      if (idea.state === (outcome === "approve" ? "approved" : "skipped")) return idea
      throw new Error("Idea already decided; a new proposal is required to change the decision")
    }
    const value = {
      ...idea,
      state: outcome === "approve" ? ("approved" as const) : ("skipped" as const),
      decidedAt: Date.now(),
      decidedBy: `telegram:${senderId}`
    }
    assertAuthorized()
    this.runtime.store.commit(
      [{ kind: "idea-decision", id, value, expectedVersion: this.runtime.store.version("idea-decision", id) }],
      {
        kind: "idea.decided",
        subject: id,
        value: { state: value.state, decidedBy: value.decidedBy, digest: value.digest }
      }
    )
    return value
  }
  async queueApproved() {
    for (const idea of this.list().filter((item) => item.state === "approved" && !item.plannerCardId)) {
      const round = this.runtime.store.get<{ cards: string[] }>("round", idea.roundId)
      if (!round) continue
      const card = await this.runtime.createCard({
        boardId: this.runtime.policy.boardId,
        title: `Reconsider approved idea: ${idea.title}`,
        agentId: this.runtime.policy.plannerAgentId,
        status: "ready",
        idempotencyKey: `idea:${idea.id}:planner`,
        workspace: { kind: "dir", path: this.runtime.policy.repository },
        notes: JSON.stringify({
          roundId: idea.roundId,
          proposalId: idea.proposalId,
          instructions: [
            "The operator approved the product direction for this exact idea. Re-read autocode_proposals and attempt autocode_admit only if evidence, scope, ranking and budget still permit it.",
            "This decision does not approve code, tests, deployment, or weaker verification. Do not override existing decisions or expand scope. Complete with the actual admission result."
          ]
        })
      })
      const current = this.runtime.store.get<{ cards: string[] }>("round", idea.roundId)!
      this.runtime.store.commit(
        [
          {
            kind: "round",
            id: idea.roundId,
            value: { ...current, cards: [...new Set([...current.cards, card.id])] },
            expectedVersion: this.runtime.store.version("round", idea.roundId)
          },
          {
            kind: "idea-decision",
            id: idea.id,
            value: { ...idea, plannerCardId: card.id },
            expectedVersion: this.runtime.store.version("idea-decision", idea.id)
          }
        ],
        { kind: "idea.planner-queued", subject: idea.id, value: { cardId: card.id } }
      )
    }
  }
}
export function formatNativeIdea(idea: NativeIdeaDecision): string {
  const line = (s: string, max: number) => s.replace(/[\r\n]+/g, " ").slice(0, max)
  return [
    `Decision ${idea.id}: ${line(idea.title, 180)}`,
    `Benefit: ${line(idea.benefit, 260)}`,
    `Estimate: ${idea.effortHours ?? "unknown"}h; additional cost ${idea.costCents ?? "unknown"} cents (estimate).`,
    `Why ask: ${line(idea.reasons.join("; "), 300)}`,
    `/idea approve ${idea.id}`,
    `/idea skip ${idea.id}`,
    "Waiting for your direction. Routine work continues. This does not waive tests or agent review."
  ].join("\n")
}
