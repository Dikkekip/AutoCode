import { createHash, verify } from "node:crypto"
import type { T3Journal, T3Lease } from "./journal.js"
import { digest } from "./personas.js"
import type { T3Workflow, T3WorkflowEngine } from "./workflow.js"

export const T3_PORT_POLICY = {
  repository: "Dikkekip/AutoCode",
  branch: "port/t3-personas-20261031",
  requiredCi: { checks: [{ name: "AutoCode CI", appId: 15368 }], maxAgeSeconds: 86400, requireBranchProtection: false },
  stableLatest: { id: 416051123, tag: "v0.1.0.7" },
  prerelease: true,
  latest: false
} as const

export const T3_PUBLICATION_LIMITS = {
  files: 2000,
  fileBytes: 4 * 1024 * 1024,
  totalBytes: 32 * 1024 * 1024,
  archiveBytes: 40 * 1024 * 1024,
  assetBytes: 40 * 1024 * 1024,
  operationMs: 30_000,
  outputBytes: 2 * 1024 * 1024,
  pages: 10,
  assets: 8
} as const

export function publicationHash(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex")
}
export function publicationHex(value: string): void {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error("Invalid publication digest")
}
export function publicationPath(path: string): void {
  if (
    typeof path !== "string" ||
    path.length > 100 ||
    !/^[a-zA-Z0-9_@.-]+(?:\/[a-zA-Z0-9_@.-]+)*$/.test(path) ||
    path.split("/").some((p) => p === "." || p === ".." || p.startsWith("-")) ||
    /(^|\/)(?:\.git|private|briefs|receipts|node_modules|dist|coverage)(\/|$)/i.test(path) ||
    /(^|\/)(?:\.env[^/]*|credentials(?:\.[^/]*)?|[^/]+\.(?:sqlite|db|pem|key|bak))$/i.test(path)
  )
    throw new Error("Unsafe or private publication export path")
}
export interface T3PublicationAsset {
  name: string
  sha256: string
  size: number
}
export interface T3PublicationOperation {
  kind: "tag" | "release" | "asset"
  payload: Record<string, unknown>
}
export interface T3PublicationIdentity {
  projectId: string
  workflowId: string
  revision: string
  treeDigest: string
  scope: string[]
  estimatedTokens: number
  workflowPolicyDigest: string
  publicationPolicyDigest: string
  exportPolicyDigest: string
  evidenceDigest: string
  repository: string
  branch: string
  tag: string
  title: string
  notes: string
  assets: T3PublicationAsset[]
  operations: T3PublicationOperation[]
}
export interface T3PublicationObservation {
  repository: string
  tag: string
  revision: string
  stableLatest: { id: number; tag: string }
  release: {
    id: number
    tag: string
    target: string
    prerelease: boolean
    draft: boolean
    title: string
    body: string
  } | null
  assets: Array<T3PublicationAsset & { id: number }>
  observedAt: number
}
export interface T3PublicationReservation {
  identity: T3PublicationIdentity
  planDigest: string
  state: "open" | "settled"
  sendsDisabled: boolean
  /** Terminal send receipt only when this adapter observed process termination. A timeout is never terminal custody. */
  senders: Record<
    string,
    {
      owner: string
      fence: number
      terminal: boolean
      invocation: T3SenderInvocation
      termination: T3SenderTermination | null
    }
  >
  dispositions: Record<string, "observed" | "disabled-unsent">
  observation: T3PublicationObservation | null
}

/** A new ephemeral runner key is bound before transmission, never replaced during recovery. */
export interface T3SenderInvocation {
  id: string
  planDigest: string
  effectId: string
  index: number
  payloadDigest: string
  argvDigest: string
  owner: string
  fence: number
  publicKey: string
}
export interface T3SenderTermination {
  body: {
    invocation: T3SenderInvocation
    pid: number
    exitCode: number
    signal: null
    timedOut: false
    outputLimited: false
    processGroupAbsent: true
    startedAt: number
    endedAt: number
  }
  signature: string
}
function assertTermination(invocation: T3SenderInvocation, proof: T3SenderTermination): void {
  const b = proof?.body
  if (
    !b ||
    digest(b.invocation) !== digest(invocation) ||
    !Number.isSafeInteger(b.pid) ||
    b.pid < 1 ||
    !Number.isSafeInteger(b.exitCode) ||
    b.exitCode < 0 ||
    b.exitCode > 255 ||
    b.signal !== null ||
    b.timedOut !== false ||
    b.outputLimited !== false ||
    b.processGroupAbsent !== true ||
    !Number.isSafeInteger(b.startedAt) ||
    !Number.isSafeInteger(b.endedAt) ||
    b.endedAt < b.startedAt ||
    !verify(null, Buffer.from(digest(b)), invocation.publicKey, Buffer.from(proof.signature, "base64"))
  )
    throw new Error("Trustworthy original sender termination custody required")
}
export function publicationMetadata(revision: string, tag: string): { title: string; notes: string } {
  return {
    title: `AutoCode T3 ${tag}`,
    notes: `AutoCode T3 source prerelease\n\nSource: ${revision}\nSource archive; build with pnpm install --frozen-lockfile and pnpm build.\nPublication is not deployment, merge or closure.\n`
  }
}
function exactUtf8(value: string): boolean {
  return (
    typeof value === "string" &&
    Buffer.from(value, "utf8").toString("utf8") === value &&
    !value.includes("\0") &&
    Buffer.byteLength(value) <= T3_PUBLICATION_LIMITS.outputBytes
  )
}
export function expectedPublicationCycle(i: T3PublicationIdentity): {
  commit: string
  title: string
  notesSha256: string
  assets: Record<string, string>
} {
  validateIdentity(i)
  return {
    commit: i.revision,
    title: i.title,
    notesSha256: publicationHash(i.notes),
    assets: Object.fromEntries(i.assets.map((a) => [a.name, a.sha256]))
  }
}

export function publicationOperations(i: Omit<T3PublicationIdentity, "operations">): T3PublicationOperation[] {
  return [
    { kind: "tag", payload: { repository: i.repository, ref: `refs/tags/${i.tag}`, sha: i.revision } },
    {
      kind: "release",
      payload: {
        repository: i.repository,
        tag: i.tag,
        target: i.revision,
        prerelease: true,
        latest: false,
        title: i.title,
        notes: i.notes
      }
    },
    ...i.assets.map((asset) => ({
      kind: "asset" as const,
      payload: { repository: i.repository, tag: i.tag, ...asset }
    }))
  ]
}
export function publicationEffectId(planDigest: string, index: number): string {
  return `publication:${planDigest}:${index}`
}

/** Also used by ordinary admission and lifecycle transitions. Corrupt/orphan reservations fail closed,
 * including terminal workflows and settled records whose proof is incomplete. */
export function publicationReservations(journal: T3Journal, projectId: string): T3PublicationReservation[] {
  const rows = journal.list<T3PublicationReservation>(projectId, "publication")
  const open = new Set<string>()
  for (const row of rows) {
    const r = row.value,
      i = r.identity
    if (
      !i ||
      row.id !== r.planDigest ||
      digest(i) !== r.planDigest ||
      i.projectId !== projectId ||
      !["open", "settled"].includes(r.state) ||
      typeof r.sendsDisabled !== "boolean" ||
      !r.senders ||
      !r.dispositions
    )
      throw new Error("Malformed publication reservation")
    validateIdentity(i)
    if (Array.isArray(r.senders) || Array.isArray(r.dispositions)) throw new Error("Malformed publication ownership")
    for (const [key, sender] of Object.entries(r.senders)) {
      if (
        !/^(0|[1-9][0-9]*)$/.test(key) ||
        Number(key) >= i.operations.length ||
        !sender ||
        typeof sender.owner !== "string" ||
        !sender.owner.trim() ||
        !Number.isSafeInteger(sender.fence) ||
        sender.fence < 1 ||
        typeof sender.terminal !== "boolean"
      )
        throw new Error("Malformed publication sender ownership")
      const invocation = sender.invocation
      if (
        !invocation ||
        !/^[a-f0-9-]{36}$/.test(invocation.id) ||
        invocation.planDigest !== r.planDigest ||
        invocation.effectId !== publicationEffectId(r.planDigest, Number(key)) ||
        invocation.index !== Number(key) ||
        invocation.payloadDigest !== digest(i.operations[Number(key)]!.payload) ||
        invocation.owner !== sender.owner ||
        invocation.fence !== sender.fence ||
        typeof invocation.publicKey !== "string"
      )
        throw new Error("Conflicting sender invocation")
      publicationHex(invocation.argvDigest)
      if (sender.terminal) assertTermination(invocation, sender.termination!)
      else if (sender.termination !== null) throw new Error("Conflicting sender termination")
      const effect = journal.effect(publicationEffectId(r.planDigest, Number(key)))
      if (
        !effect ||
        effect.projectId !== projectId ||
        effect.tool !== `publication.${i.operations[Number(key)]!.kind}` ||
        digest(effect.arguments) !== digest(i.operations[Number(key)]!.payload)
      )
        throw new Error("Conflicting publication effect ownership")
    }
    for (const [key, disposition] of Object.entries(r.dispositions)) {
      if (
        !/^(0|[1-9][0-9]*)$/.test(key) ||
        Number(key) >= i.operations.length ||
        !["observed", "disabled-unsent"].includes(disposition)
      )
        throw new Error("Malformed publication disposition")
    }
    const w = journal.read<T3Workflow>(projectId, "workflow", i.workflowId)?.value
    if (
      !w?.proposal ||
      w.policyDigest !== i.workflowPolicyDigest ||
      digest(w.proposal.scope) !== digest(i.scope) ||
      w.proposal.estimatedTokens !== i.estimatedTokens ||
      (r.state === "open" && (w.candidate?.revision !== i.revision || w.candidate.treeDigest !== i.treeDigest))
    )
      throw new Error("Orphan or conflicting publication reservation")
    if (r.state === "settled") assertSettlement(journal, r)
    else {
      if (open.has(i.workflowId)) throw new Error("Conflicting publication plans for workflow")
      open.add(i.workflowId)
    }
  }
  return rows.map((r) => r.value).filter((r) => r.state === "open")
}
function validateIdentity(i: T3PublicationIdentity): void {
  if (
    i.repository !== T3_PORT_POLICY.repository ||
    i.branch !== T3_PORT_POLICY.branch ||
    !/^[a-f0-9]{40}$/.test(i.revision) ||
    !/^v0\.2\.0-t3\.[1-4]$/.test(i.tag) ||
    !exactUtf8(i.title) ||
    !i.title.trim() ||
    i.title.includes("\n") ||
    i.title.includes("\r") ||
    !exactUtf8(i.notes) ||
    !i.notes.trim() ||
    !i.notes.includes(i.revision) ||
    !i.projectId ||
    !i.workflowId ||
    !Array.isArray(i.scope) ||
    !i.scope.length ||
    !Number.isSafeInteger(i.estimatedTokens) ||
    i.estimatedTokens < 1 ||
    !Array.isArray(i.assets) ||
    i.assets.length < 3 ||
    i.assets.length > T3_PUBLICATION_LIMITS.assets
  )
    throw new Error("Invalid publication identity")
  for (const h of [
    i.treeDigest,
    i.workflowPolicyDigest,
    i.publicationPolicyDigest,
    i.exportPolicyDigest,
    i.evidenceDigest
  ])
    publicationHex(h)
  if (i.publicationPolicyDigest !== digest(T3_PORT_POLICY)) throw new Error("Unreviewed publication policy")
  let total = 0
  const names = new Set<string>()
  for (const a of i.assets) {
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,99}$/.test(a.name) ||
      names.has(a.name) ||
      !Number.isSafeInteger(a.size) ||
      a.size < 1 ||
      a.size > T3_PUBLICATION_LIMITS.assetBytes
    )
      throw new Error("Invalid publication asset")
    publicationHex(a.sha256)
    names.add(a.name)
    total += a.size
  }
  if (total > T3_PUBLICATION_LIMITS.archiveBytes + T3_PUBLICATION_LIMITS.outputBytes)
    throw new Error("Publication aggregate asset bound exceeded")
  const { operations: _operations, ...base } = i
  if (digest(i.operations) !== digest(publicationOperations(base))) throw new Error("Publication payload changed")
}

function assertObservation(r: T3PublicationReservation, o: T3PublicationObservation, index: number): void {
  const i = r.identity
  if (
    o.repository !== i.repository ||
    o.tag !== i.tag ||
    o.revision !== i.revision ||
    digest(o.stableLatest) !== digest(T3_PORT_POLICY.stableLatest) ||
    !Number.isSafeInteger(o.observedAt)
  )
    throw new Error("Remote publication observation conflicts")
  if (r.observation?.release && o.release?.id !== r.observation.release.id)
    throw new Error("Remote release identity changed")
  if (r.observation?.assets.some((previous) => !o.assets.some((asset) => digest(asset) === digest(previous))))
    throw new Error("Previously observed remote asset changed")
  if (
    (index >= 1 || o.release !== null) &&
    (!o.release ||
      !Number.isSafeInteger(o.release.id) ||
      o.release.id < 1 ||
      o.release.tag !== i.tag ||
      o.release.target !== i.revision ||
      o.release.prerelease !== true ||
      o.release.draft !== false ||
      typeof o.release.title !== "string" ||
      o.release.title !== i.title ||
      typeof o.release.body !== "string" ||
      o.release.body !== i.notes)
  )
    throw new Error("Remote release observation conflicts")
  const op = i.operations[index]!
  if (op.kind === "asset") {
    const matches = o.assets.filter((a) => a.name === op.payload.name)
    if (
      matches.length !== 1 ||
      !Number.isSafeInteger(matches[0]!.id) ||
      matches[0]!.id < 1 ||
      matches[0]!.sha256 !== op.payload.sha256 ||
      matches[0]!.size !== op.payload.size
    )
      throw new Error("Remote downloaded asset observation conflicts")
  }
  if (
    o.assets.some((a) => !i.assets.some((p) => p.name === a.name && p.sha256 === a.sha256 && p.size === a.size)) ||
    new Set(o.assets.map((a) => a.name)).size !== o.assets.length
  )
    throw new Error("Unexpected remote assets")
}
function assertSettlement(journal: T3Journal, r: T3PublicationReservation): void {
  if (!r.sendsDisabled) throw new Error("Publication sends remain enabled")
  for (let n = 0; n < r.identity.operations.length; n++) {
    const key = String(n),
      effect = journal.effect(publicationEffectId(r.planDigest, n))
    if (r.dispositions[key] === "disabled-unsent" && !r.senders[key] && (!effect || effect.status === "prepared"))
      continue
    if (
      r.dispositions[key] !== "observed" ||
      !r.observation ||
      !effect ||
      effect.tool !== `publication.${r.identity.operations[n]!.kind}` ||
      effect.status !== "confirmed" ||
      !r.senders[key]?.terminal ||
      effect.projectId !== r.identity.projectId ||
      digest(effect.arguments) !== digest(r.identity.operations[n]!.payload)
    )
      throw new Error("Publication settlement is incomplete; retain reservation")
    assertObservation(r, r.observation, n)
  }
}

/** Signed content-addressed owner custody. The key is supplied in-process by the established owner,
 * never from a worker, CLI receipt path, repository or packet. No signing key is distributed here. */
export interface T3PublicationAttestation {
  body: {
    workflowId: string
    revision: string
    treeDigest: string
    issuedAt: number
    expiresAt: number
    publicationPolicyDigest: string
    exportPolicyDigest: string
    archiveDigest: string
    release: { title: string; notesSha256: string }
    authorization: { repository: string; branch: string; tags: string[]; deadline: number }
    ci: {
      receipt: Record<string, unknown>
      execution: {
        headBefore: string
        headAfter: string
        cleanBefore: boolean
        cleanAfter: boolean
        receiptDigest: string
        terminalId: string
        exitCode: number
        argv: string[]
      }
    }
    qualification: {
      image: string
      policyDigest: string
      changedPaths: string[]
      criteria: string[]
      terminalId: string
      cleanup: string
      negativeControls: string[]
    }
    archiveCheck: {
      archiveDigest: string
      inventoryDigest: string
      checkerImage: string
      terminalId: string
      cleanup: string
    }
  }
  signature: string
}
export function validatePublicationCustody(
  engine: T3WorkflowEngine,
  projectId: string,
  workflowId: string,
  attestation: T3PublicationAttestation,
  trustedPublicKey: string,
  now = Date.now()
): string {
  if (
    !trustedPublicKey ||
    !attestation?.body ||
    !verify(null, Buffer.from(digest(attestation.body)), trustedPublicKey, Buffer.from(attestation.signature, "base64"))
  )
    throw new Error("Trusted publication custody signature required")
  const b = attestation.body,
    w = engine.get(projectId, workflowId).value,
    c = w.candidate
  if (
    w.phase !== "ready" ||
    !w.admitted ||
    !c ||
    !w.proposal ||
    !w.verification?.passed ||
    w.verification.revision !== c.revision ||
    w.verification.treeDigest !== c.treeDigest ||
    !w.review?.accepted ||
    w.review.revision !== c.revision ||
    w.review.findings.length ||
    w.review.criteria.length !== w.proposal.acceptance.length ||
    new Set(w.review.criteria.map((x) => x.criterion)).size !== w.proposal.acceptance.length ||
    w.proposal.acceptance.some(
      (a) => !w.review!.criteria.some((x) => x.criterion === a && x.passed && x.evidence.trim())
    )
  )
    throw new Error("Exact candidate readiness and complete review required")
  engine.assertPolicy(w)
  if (Buffer.byteLength(JSON.stringify(attestation)) > T3_PUBLICATION_LIMITS.outputBytes)
    throw new Error("Publication custody exceeds byte bound")
  for (const n of [b.issuedAt, b.expiresAt, b.authorization.deadline])
    if (!Number.isSafeInteger(n)) throw new Error("Invalid publication custody time")
  if (
    b.workflowId !== workflowId ||
    b.revision !== c.revision ||
    b.treeDigest !== c.treeDigest ||
    b.issuedAt > now ||
    b.expiresAt <= now + T3_PUBLICATION_LIMITS.operationMs ||
    now - b.issuedAt > 86400_000 ||
    b.authorization.deadline <= now + T3_PUBLICATION_LIMITS.operationMs ||
    b.authorization.repository !== T3_PORT_POLICY.repository ||
    b.authorization.branch !== T3_PORT_POLICY.branch ||
    b.publicationPolicyDigest !== digest(T3_PORT_POLICY)
  )
    throw new Error("Stale or mismatched publication custody")
  for (const h of [b.exportPolicyDigest, b.archiveDigest, b.archiveCheck.inventoryDigest]) publicationHex(h)
  const roles = ["implementation", "verification", "review", "release"] as const
  const assignments = roles.map((role) =>
    w.assignments.filter((a) => a.role === role && a.revision === c.revision && a.resultApplied).at(-1)
  )
  // Implementation's assignment targets the source revision, so identify it by candidate task instead.
  assignments[0] = w.assignments.find((a) => a.role === "implementation" && a.taskId === c.implementationTaskId)
  if (
    assignments.some((a) => !a || a.status !== "completed" || !a.resultApplied || !a.runId || !a.taskId) ||
    new Set(assignments.map((a) => a!.personaId)).size !== roles.length ||
    new Set(assignments.map((a) => a!.taskId)).size !== roles.length
  )
    throw new Error("Independent retained publication assignments required")
  for (const a of assignments) {
    if (
      engine.personas.get(a!.personaId)?.digest !== a!.personaDigest ||
      !engine.policy.rolePersonas[a!.role].includes(a!.personaId)
    )
      throw new Error("Retained publication persona binding changed")
    const envelope = engine.journal.read<Record<string, unknown>>(projectId, "completion", a!.id)?.value
    const events = engine.journal.db
      .prepare("SELECT data FROM events WHERE project=? AND kind='completion.observed' AND subject=?")
      .all(projectId, a!.id)
    const observations = events.map((e) => JSON.parse(String(e.data)))
    if (
      !envelope ||
      Object.entries({
        assignmentId: a!.id,
        role: a!.role,
        revision: a!.revision,
        personaDigest: a!.personaDigest,
        promptDigest: a!.promptDigest,
        sourceManifestDigest: w.source.digest
      }).some(([k, v]) => envelope[k] !== v) ||
      !observations.some(
        (e) =>
          e.status === "completed" &&
          e.runId === a!.runId &&
          e.receipt?.taskId === a!.taskId &&
          e.receipt.latestTerminalRunId === a!.runId &&
          e.receipt.latestTerminalStatus === "completed" &&
          e.receipt.providerInstanceId === a!.providerInstanceId &&
          e.receipt.hasPendingChildRuns === false &&
          e.receipt.hasPendingQuestion === false &&
          e.receipt.workState === "result_available" &&
          digest(JSON.parse(e.receipt.summary)) === digest(envelope)
      )
    )
      throw new Error("Retained completion and terminal custody required")
    const result = envelope.result as Record<string, unknown>
    if (
      (a!.role === "implementation" && result.revision !== c.revision) ||
      (a!.role === "release" && result.ready !== true)
    ) {
      throw new Error("Completion result differs from retained readiness")
    }
    if (a!.role === "review") {
      const { taskId: _taskId, ...review } = w.review!
      if (digest(result) !== digest(review) || w.review!.taskId !== a!.taskId)
        throw new Error("Review completion mismatch")
    }
  }
  const verifier = assignments[1]!,
    effect = engine.journal.effect(`verify:${verifier.id}`)
  const retained = engine.journal.read<Record<string, unknown>>(projectId, "verification-receipt", verifier.id)?.value
  const receipt = effect?.result?.receipt as Record<string, any> | undefined
  if (
    effect?.projectId !== projectId ||
    effect.status !== "confirmed" ||
    effect.tool !== "protected_verification" ||
    digest(effect.arguments) !== digest({ source: w.source.digest, candidate: c, policy: retained?.policy }) ||
    digest(effect.result?.evidence) !== digest(w.verification) ||
    !receipt ||
    digest(receipt) !== w.verification.receiptDigest ||
    digest(retained?.receipt) !== digest(receipt) ||
    digest(retained?.policy) !== w.verification.policyDigest ||
    digest(retained?.candidate) !== digest(c) ||
    receipt.cleanup?.status !== "VERIFIED_ABSENT" ||
    receipt.containerExitCode !== 0 ||
    receipt.failure ||
    receipt.identity?.id !== receipt.cid ||
    receipt.identity?.image !== b.qualification.image ||
    b.qualification.policyDigest !== w.verification.policyDigest ||
    !/^sha256:[a-f0-9]{64}$/.test(b.qualification.image) ||
    !b.qualification.terminalId ||
    b.qualification.cleanup !== "VERIFIED_ABSENT" ||
    !b.qualification.negativeControls.length ||
    c.changedPaths.some((p) => !b.qualification.changedPaths.includes(p)) ||
    w.proposal.acceptance.some((a) => !b.qualification.criteria.includes(a))
  )
    throw new Error("Qualified protected execution custody required")
  const ci = b.ci.receipt as Record<string, any>,
    execution = b.ci.execution
  if (
    ci.version !== 1 ||
    ci.status !== "passed" ||
    ci.headSha !== c.revision ||
    !Number.isFinite(Date.parse(ci.startedAt)) ||
    !Number.isFinite(Date.parse(ci.finishedAt)) ||
    Date.parse(ci.startedAt) > Date.parse(ci.finishedAt) ||
    Date.parse(ci.finishedAt) > now ||
    now - Date.parse(ci.finishedAt) > 86400_000 ||
    !Array.isArray(ci.checks) ||
    ci.checks.length !== 3 ||
    ["deps:licenses", "deps:audit", "ci"].some((name, n) => {
      const check = ci.checks[n]
      return (
        digest(check.command) !== digest(["pnpm", "run", name]) ||
        check.exitCode !== 0 ||
        check.signal !== null ||
        !Number.isFinite(Date.parse(check.startedAt)) ||
        !Number.isFinite(Date.parse(check.finishedAt)) ||
        Date.parse(check.startedAt) < Date.parse(ci.startedAt) ||
        Date.parse(check.finishedAt) > Date.parse(ci.finishedAt) ||
        Date.parse(check.finishedAt) < Date.parse(check.startedAt)
      )
    }) ||
    execution.headBefore !== c.revision ||
    execution.headAfter !== c.revision ||
    !execution.cleanBefore ||
    !execution.cleanAfter ||
    execution.receiptDigest !== digest(ci) ||
    !execution.terminalId ||
    execution.exitCode !== 0 ||
    digest(execution.argv) !== digest(["pnpm", "ci:agent"])
  )
    throw new Error("Clean exact-SHA ci:agent execution custody required")
  if (
    b.archiveCheck.archiveDigest !== b.archiveDigest ||
    !/^sha256:[a-f0-9]{64}$/.test(b.archiveCheck.checkerImage) ||
    !b.archiveCheck.terminalId ||
    b.archiveCheck.cleanup !== "VERIFIED_ABSENT"
  )
    throw new Error("Independent archive qualification required")
  return digest(attestation)
}

/** No transport or credentials in this domain module. Every send gets a fresh owner gate. */
export class T3Publication {
  constructor(
    readonly engine: T3WorkflowEngine,
    private readonly clock = Date.now
  ) {}

  prepare(lease: T3Lease, identity: T3PublicationIdentity): string {
    validateIdentity(identity)
    return this.engine.journal.transaction(lease, () => {
      this.gate(lease)
      publicationReservations(this.engine.journal, lease.projectId)
      const w = this.engine.get(lease.projectId, identity.workflowId).value
      if (
        identity.projectId !== lease.projectId ||
        w.phase !== "ready" ||
        !w.admitted ||
        w.policyDigest !== identity.workflowPolicyDigest ||
        w.candidate?.revision !== identity.revision ||
        w.candidate.treeDigest !== identity.treeDigest ||
        digest(w.proposal?.scope) !== digest(identity.scope) ||
        w.proposal?.estimatedTokens !== identity.estimatedTokens
      )
        throw new Error("Publication workflow binding mismatch")
      if (
        this.engine.journal
          .list<T3PublicationReservation>(lease.projectId, "publication")
          .some((r) => r.value.identity.workflowId === identity.workflowId || r.value.identity.tag === identity.tag)
      )
        throw new Error("Retained publication exists; reconcile separately")
      const planDigest = digest(identity)
      this.engine.journal.write(
        "publication",
        planDigest,
        {
          identity: structuredClone(identity),
          planDigest,
          state: "open",
          sendsDisabled: false,
          senders: {},
          dispositions: {},
          observation: null
        } satisfies T3PublicationReservation,
        0
      )
      return planDigest
    })
  }

  get(projectId: string, plan: string): T3PublicationReservation {
    publicationReservations(this.engine.journal, projectId)
    const row = this.engine.journal.read<T3PublicationReservation>(projectId, "publication", plan)
    if (!row) throw new Error("Unknown publication plan")
    return row.value
  }

  begin(lease: T3Lease, plan: string, index: number, invocation: T3SenderInvocation): T3PublicationOperation {
    const r = this.get(lease.projectId, plan),
      op = r.identity.operations[index]
    if (!op || !Number.isSafeInteger(index)) throw new Error("Unknown publication operation")
    const id = publicationEffectId(plan, index)
    if (
      !invocation ||
      !/^[a-f0-9-]{36}$/.test(invocation.id) ||
      invocation.planDigest !== plan ||
      invocation.effectId !== id ||
      invocation.index !== index ||
      invocation.payloadDigest !== digest(op.payload) ||
      invocation.owner !== lease.owner ||
      invocation.fence !== lease.fence ||
      typeof invocation.publicKey !== "string" ||
      !invocation.publicKey.includes("PUBLIC KEY")
    )
      throw new Error("Invalid original sender invocation")
    publicationHex(invocation.argvDigest)
    // Reservation was committed before either effect transaction. No nesting or awaits.
    const effect = this.engine.journal.reserveEffect(lease, id, `publication.${op.kind}`, op.payload)
    if (effect.status !== "prepared") throw new Error("Publication already attempted; observe, never retry")
    this.engine.journal.transaction(lease, () => {
      this.gate(lease)
      const row = this.engine.journal.read<T3PublicationReservation>(lease.projectId, "publication", plan)!
      if (row.value.state !== "open" || row.value.sendsDisabled || row.value.senders[String(index)])
        throw new Error("Publication sends disabled")
      for (let n = 0; n < index; n++)
        if (row.value.dispositions[String(n)] !== "observed") throw new Error("Observe prior operation before sending")
      row.value.senders[String(index)] = {
        owner: lease.owner,
        fence: lease.fence,
        terminal: false,
        invocation: structuredClone(invocation),
        termination: null
      }
      this.engine.journal.write("publication", plan, row.value, row.version)
    })
    this.engine.journal.markEffect(lease, id, "prepared", "uncertain")
    this.gate(lease)
    return op
  }

  /** May recover under a successor lease only with a valid proof from the ORIGINAL bound runner key. */
  terminalSender(lease: T3Lease, plan: string, index: number, proof: T3SenderTermination): void {
    this.engine.journal.transaction(lease, () => {
      const row = this.engine.journal.read<T3PublicationReservation>(lease.projectId, "publication", plan)!
      const sender = row.value.senders[String(index)]
      if (!sender) throw new Error("Original sender custody required")
      assertTermination(sender.invocation, proof)
      if (proof.body.endedAt > this.clock()) throw new Error("Future sender termination")
      if (sender.termination && digest(sender.termination) !== digest(proof))
        throw new Error("Conflicting sender termination")
      sender.termination = structuredClone(proof)
      sender.terminal = true
      this.engine.journal.write("publication", plan, row.value, row.version)
    })
  }

  observe(lease: T3Lease, plan: string, index: number, observation: T3PublicationObservation): void {
    const r = this.get(lease.projectId, plan),
      id = publicationEffectId(plan, index)
    if (!r.senders[String(index)]?.terminal) throw new Error("Delayed sender unresolved; retain uncertainty")
    assertObservation(r, observation, index)
    if (observation.observedAt > this.clock() || this.clock() - observation.observedAt > 30_000)
      throw new Error("Remote observation is stale")
    const effect = this.engine.journal.effect(id)
    if (effect?.status === "uncertain")
      this.engine.journal.markEffect(lease, id, "uncertain", "confirmed", { observation })
    else if (effect?.status !== "confirmed") throw new Error("No uncertain publication intent")
    this.engine.journal.transaction(lease, () => {
      const row = this.engine.journal.read<T3PublicationReservation>(lease.projectId, "publication", plan)!
      row.value.observation = structuredClone(observation)
      row.value.dispositions[String(index)] = "observed"
      this.engine.journal.write("publication", plan, row.value, row.version)
    })
  }

  /** Disable all future sends and settle only observed terminal operations or genuinely unsent ones.
   * Missing/absent remote objects, timeouts and owner loss cannot clear an uncertain operation. */
  settle(lease: T3Lease, plan: string, observation?: T3PublicationObservation): void {
    this.engine.journal.transaction(lease, () => {
      const row = this.engine.journal.read<T3PublicationReservation>(lease.projectId, "publication", plan)!
      row.value.sendsDisabled = true
      for (let n = 0; n < row.value.identity.operations.length; n++) {
        const effect = this.engine.journal.effect(publicationEffectId(plan, n))
        if (!row.value.senders[String(n)] && (!effect || effect.status === "prepared"))
          row.value.dispositions[String(n)] = "disabled-unsent"
      }
      // Always retain disabling even when settlement cannot yet release reservation.
      try {
        if (Object.keys(row.value.senders).length) {
          if (!observation || observation.observedAt > this.clock() || this.clock() - observation.observedAt > 30_000)
            throw new Error("Fresh authoritative settlement observation required")
          for (const key of Object.keys(row.value.senders)) assertObservation(row.value, observation, Number(key))
          row.value.observation = structuredClone(observation)
        }
        assertSettlement(this.engine.journal, row.value)
        row.value.state = "settled"
      } catch {
        /* unresolved stays reserved */
      }
      this.engine.journal.write("publication", plan, row.value, row.version)
    })
  }

  gate(lease: T3Lease): void {
    this.engine.journal.assertOwner(lease, T3_PUBLICATION_LIMITS.operationMs + 1000)
    if (
      this.engine.control(lease.projectId).mode !== "running" ||
      this.clock() + T3_PUBLICATION_LIMITS.operationMs >= this.engine.policy.deadline
    )
      throw new Error("Publication paused, frozen or expired")
  }
}
