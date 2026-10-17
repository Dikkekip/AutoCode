import { createHash } from "node:crypto"

export interface GitStagePolicy {
  version: 1
  enabled: boolean
}
export function validateGitStagePolicy(value: any): GitStagePolicy {
  if (
    !value ||
    value.version !== 1 ||
    typeof value.enabled !== "boolean" ||
    Object.keys(value).some((key) => !["version", "enabled"].includes(key))
  )
    throw new Error("gitStagePackets requires version: 1 and enabled: boolean; only local transport is supported")
  return { version: 1, enabled: value.enabled }
}
export function gitStageDigest(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}
export function gitStageId(value: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("Invalid Git stage identity")
  return value
}
export function gitStageSha(value: string): string {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) throw new Error("Invalid Git stage source revision")
  return value
}
export function gitStagePath(value: string): string {
  if (
    value.length > 512 ||
    !/^[A-Za-z0-9_./-]+$/.test(value) ||
    value.startsWith("/") ||
    value.split("/").some((part) => !part || part === "." || part === ".." || part === ".git")
  )
    throw new Error("Invalid Git stage artifact path")
  return value
}
export interface GitStagePlan {
  schemaVersion: 1
  boardId: string
  workflowId: string
  planId: string
  revision: 1
  sourceBaseSha: string
  skillDigest: string
  coderPrompt: string
  coderPromptDigest: string
  goal: string
  title: string
  allowedPaths: string[]
  acceptance: string[]
  alternatives: string[]
  evidence: Array<{ path: string; observation: string }>
  nonGoals: string[]
  verification: Array<{ criterion: string; method: string }>
  producerSessionId: string
  admittedByAgentId: string
  dependencyWorkflowIds: string[]
}
export function validateGitStagePlan(plan: GitStagePlan): GitStagePlan {
  if (plan.schemaVersion !== 1 || plan.revision !== 1) throw new Error("Unsupported Git stage plan version")
  gitStageId(plan.workflowId)
  gitStageId(plan.planId)
  gitStageSha(plan.sourceBaseSha)
  gitStageId(plan.skillDigest)
  if (
    !plan.boardId ||
    !plan.producerSessionId ||
    !plan.admittedByAgentId ||
    !plan.goal?.trim() ||
    !plan.title?.trim() ||
    !plan.coderPrompt?.trim() ||
    Buffer.byteLength(JSON.stringify(plan)) > 256_000 ||
    gitStageDigest(plan.coderPrompt) !== plan.coderPromptDigest
  )
    throw new Error("Invalid Git stage prompt or plan identity")
  for (const values of [plan.allowedPaths, plan.acceptance, plan.alternatives])
    if (!Array.isArray(values) || !values.length || values.some((v) => typeof v !== "string" || !v.trim()))
      throw new Error("Incomplete Git stage plan")
  if (
    !plan.evidence?.length ||
    plan.acceptance.some(
      (criterion) => !plan.verification?.some((check) => check.criterion === criterion && check.method?.trim())
    )
  )
    throw new Error("Git stage plan requires evidence and acceptance verification")
  return plan
}
export function renderGitStageReport(plan: GitStagePlan): string {
  validateGitStagePlan(plan)
  const escapeHtml = (value: string) =>
    value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!)
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'"><title>${escapeHtml(plan.title)}</title><h1>${escapeHtml(plan.title)}</h1><p>${escapeHtml(plan.goal)}</p><p>Next role: coder. Requires host admission and completed prerequisites.</p><p>Plan ${plan.planId}, revision ${plan.revision}; source ${plan.sourceBaseSha}</p><h2>Coder instructions</h2><pre>${escapeHtml(plan.coderPrompt)}</pre><h2>Acceptance</h2><ul>${plan.acceptance.map((c) => `<li>${escapeHtml(c)}</li>`).join("")}</ul></html>\n`
}
