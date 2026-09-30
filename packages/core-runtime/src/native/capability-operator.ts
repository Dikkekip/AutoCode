import { resolve } from "node:path"
import { type NativeAutonomyPolicy, nativeCoderAgentIds, nativePolicyDigest } from "@openclaw/domain"
import {
  approveNativeCapabilityRequirements,
  type NativeCapabilityEvidence,
  type NativeCapabilityRequirement,
  nativeCapabilityEligibility,
  registerNativeCapabilityEvidence
} from "./capabilities.js"
import { requireNativeHuman } from "./governance.js"
import type { NativeAutonomyRuntime } from "./runtime.js"

type Roles = Record<string, { evidenceId: string; requirements: NativeCapabilityRequirement }>
interface OperatorMethods {
  registerMethod: (name: string, handler: (input: any) => Promise<void>, options: { scope: string }) => void
  runtime: (boardId: string) => NativeAutonomyRuntime
  candidatePolicy: (boardId: string) => NativeAutonomyPolicy
  configuredModels: (policy: NativeAutonomyPolicy) => Promise<Record<string, string>>
}
const roleIds = (p: NativeAutonomyPolicy) =>
  [
    ...new Set([
      p.plannerAgentId,
      ...nativeCoderAgentIds(p),
      p.reviewerAgentId,
      ...p.personas.map((x) => x.investigationAgentId ?? x.personaId)
    ])
  ].sort()
const topology = (p: NativeAutonomyPolicy) =>
  JSON.stringify({
    repository: p.repository,
    boardId: p.boardId,
    baseBranch: p.baseBranch,
    repositoryKind: p.repositoryKind,
    planner: p.plannerAgentId,
    coders: nativeCoderAgentIds(p),
    primaryCoder: p.coderAgentId,
    reviewer: p.reviewerAgentId,
    personas: p.personas.map((x) => [x.personaId, x.investigationAgentId ?? x.personaId]).sort()
  })
const sameRequirements = (a: NativeCapabilityRequirement, b: NativeCapabilityRequirement) =>
  a &&
  b &&
  Object.keys(b).sort().join(",") ===
    "cancellation,contextTokens,requireKnownCost,sessionResume,structuredOutput,tools" &&
  a.contextTokens === b.contextTokens &&
  a.structuredOutput === b.structuredOutput &&
  a.cancellation === b.cancellation &&
  a.sessionResume === b.sessionResume &&
  a.requireKnownCost === b.requireKnownCost &&
  Array.isArray(b.tools) &&
  JSON.stringify([...a.tools].sort()) === JSON.stringify([...b.tools].sort())

/** Authenticated service administration only. This does not execute or invent benchmarks. */
export function registerNativeCapabilityOperatorMethods(deps: OperatorMethods): void {
  for (const action of ["register", "approve"] as const) {
    deps.registerMethod(
      `autocode.capabilities.${action}`,
      async ({ params, client, respond }) => {
        try {
          if (!client?.connect?.scopes?.includes("operator.admin")) throw new Error("Operator admin scope required")
          const operatorId = client?.connect?.device?.id ?? client?.connect?.client?.id
          const allowed = [
            "boardId",
            "policyDigest",
            "requirementsPolicyDigest",
            "controlRevision",
            "reason",
            action === "register" ? "evidence" : "roles"
          ]
          if (!params || Object.keys(params).some((key) => !allowed.includes(key)))
            throw new Error("Unknown capability administration argument")
          const r = deps.runtime(params.boardId)
          const policy = deps.candidatePolicy(params.boardId)
          if (topology(policy) !== topology(r.policy)) throw new Error("Candidate role topology changed")
          const ids = roleIds(policy)
          const authority = { operatorId, rationale: params.reason }
          requireNativeHuman(authority, [...ids, ...policy.personas.map((x) => x.personaId)])
          const digest = nativePolicyDigest(policy)
          if (params.policyDigest !== digest) throw new Error("Current exact candidate policy digest required")
          const baseline = r.store.get<{ policyDigest: string; roles: Roles }>(
            "capability-requirements",
            policy.boardId
          )
          if (
            !baseline ||
            params.requirementsPolicyDigest !== baseline.policyDigest ||
            Object.keys(baseline.roles).sort().join(",") !== ids.join(",")
          )
            throw new Error("Existing independently reviewed role requirements required")
          const original = JSON.stringify(baseline)
          const assertCurrent = () => {
            const control = r.control.state
            if (
              !control.paused ||
              control.revision !== params.controlRevision ||
              r.store.get<{ paused: boolean }>("control", "pause")?.paused !== true
            )
              throw new Error("Exact paused control revision required")
            if (
              deps.runtime(params.boardId) !== r ||
              nativePolicyDigest(deps.candidatePolicy(params.boardId)) !== digest
            )
              throw new Error("Candidate policy or service generation changed")
            if (JSON.stringify(r.store.get("capability-requirements", policy.boardId)) !== original)
              throw new Error("Reviewed role requirements changed")
          }
          assertCurrent()
          const models = await deps.configuredModels(policy)
          assertCurrent()
          if (action === "register") {
            const evidence = params.evidence as NativeCapabilityEvidence
            const requirement = baseline.roles[evidence?.agentId]?.requirements
            if (!requirement || !models[evidence.agentId]) throw new Error("Evidence role is not configured")
            const result = nativeCapabilityEligibility(evidence, requirement, {
              agentId: evidence.agentId,
              model: models[evidence.agentId]!,
              policyDigest: digest
            })
            if (!result.eligible) throw new Error(`Live capability evidence ineligible: ${result.reasons.join("; ")}`)
            const evidenceId = registerNativeCapabilityEvidence(
              r.store,
              evidence,
              resolve(policy.repository, ".openclaw/native-artifacts/capabilities"),
              authority,
              ids
            )
            respond(true, { evidenceId, policyDigest: digest, eligibility: result })
          } else {
            const roles = params.roles as Roles
            if (
              !roles ||
              Object.keys(roles).sort().join(",") !== ids.join(",") ||
              ids.some(
                (id) =>
                  Object.keys(roles[id] ?? {})
                    .sort()
                    .join(",") !== "evidenceId,requirements" ||
                  !sameRequirements(baseline.roles[id]!.requirements, roles[id]!.requirements)
              )
            )
              throw new Error("Preserve every independently reviewed role requirement exactly")
            const decisions = approveNativeCapabilityRequirements(r.store, policy, roles, models, authority)
            respond(true, { policyDigest: digest, decisions })
          }
        } catch (error) {
          respond(false, undefined, { code: "autocode_error", message: String(error) })
        }
      },
      { scope: "operator.admin" }
    )
  }
}
