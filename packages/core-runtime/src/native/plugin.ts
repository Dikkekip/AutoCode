import { isAbsolute, resolve } from "node:path"
import type { NativeReviewEvidence } from "@openclaw/domain"
import { authorizeNativeTool, resolveNativeToolRuntime } from "./broker.js"
import { loadNativePolicy, nativeDoctor } from "./doctor.js"
import { NativeCliGateway } from "./gateway.js"
import { assertNativeMode } from "./promotion-mode.js"
import { NativeAutonomyRuntime } from "./runtime.js"
import { loadNativeSkillText } from "./skill-bundle.js"
import { bootstrapNativeSkill, nativeSkillPolicyDigest, registerNativeSkill } from "./skills.js"
import { NativeEvidenceStore } from "./store.js"
import { NativeWorkspaceGateway } from "./workspaces.js"

// Tool catalogs can register the plugin again without starting another service.
// Share only live, in-process service instances; this is never an RPC identity bridge.
const runtimeKey = Symbol.for("autocode.native.service-runtimes.v1")
const processRegistry = globalThis as typeof globalThis & { [runtimeKey]?: Map<string, NativeAutonomyRuntime> }
processRegistry[runtimeKey] ??= new Map<string, NativeAutonomyRuntime>()
const activeInstances = processRegistry[runtimeKey]

/** Structural public plugin API; no imports from OpenClaw's generated internal bundles. */
export function registerNativeAutonomyPlugin(api: any): void {
  const instances = new Map<string, NativeAutonomyRuntime>()
  const ready = new Set<NativeAutonomyRuntime>()
  const checking = new Map<string, Promise<void>>()
  let stopped = false
  let budgetTimer: ReturnType<typeof setInterval> | undefined
  let budgetCheck: Promise<void> | undefined
  const policyFiles = api.pluginConfig?.projects ?? []
  const runtime = (boardId: string): NativeAutonomyRuntime => {
    const item = instances.get(boardId) ?? activeInstances.get(boardId)
    if (!item) throw new Error(`Unknown native board: ${boardId}`)
    return item
  }
  // OpenClaw reserves runtime.gateway.request for bundled/official plugins. Use its
  // authenticated public CLI instead; never import private RPC/auth internals.
  const command = api.pluginConfig?.openclawCommand
  if (policyFiles.length && (typeof command !== "string" || !isAbsolute(command))) {
    throw new Error(
      "Configure autocode.openclawCommand as the absolute active OpenClaw executable; Gateway PATH may select a legacy CLI"
    )
  }
  const gateway = new NativeCliGateway(command ?? "openclaw")
  // Service startup precedes the Gateway accepting authenticated RPCs. Validate
  // before execution instead of waiting on the same Gateway during its startup.
  const ensureReady = async (r: NativeAutonomyRuntime): Promise<void> => {
    if (!r.policy.enabled || ready.has(r)) return
    const pending = checking.get(r.policy.boardId)
    if (pending) return pending
    const check: Promise<void> = nativeDoctor(r.policy, gateway)
      .then((report) => {
        if (stopped || activeInstances.get(r.policy.boardId) !== r)
          throw new Error("Native service stopped during readiness check")
        if (!report.ok)
          throw new Error(`Native activation blocked: ${JSON.stringify(report.checks.filter((c) => !c.ok))}`)
        ready.add(r)
      })
      .finally(() => {
        if (checking.get(r.policy.boardId) === check) checking.delete(r.policy.boardId)
      })
    checking.set(r.policy.boardId, check)
    return check
  }
  api.registerService({
    id: "autocode-evidence",
    start: async () => {
      stopped = false
      for (const file of policyFiles) {
        const policy = loadNativePolicy(file)
        if (instances.has(policy.boardId) || activeInstances.has(policy.boardId))
          throw new Error(`Duplicate native board ${policy.boardId}`)
        const store = new NativeEvidenceStore(resolve(policy.repository, ".openclaw/native-evidence.db"))
        instances.set(
          policy.boardId,
          new NativeAutonomyRuntime(
            policy,
            new NativeWorkspaceGateway(
              gateway,
              policy,
              () => {
                const owner = instances.get(policy.boardId)
                if (!owner?.hasOwnership) throw new Error("Native workspace dispatch ownership unavailable")
                owner.control.assert()
                store.authorizeEffect()
              },
              api.runtime?.worktrees
            ),
            store
          )
        )
        activeInstances.set(policy.boardId, instances.get(policy.boardId)!)
      }
      budgetTimer = setInterval(() => {
        if (budgetCheck) return
        budgetCheck = (async () => {
          for (const r of instances.values()) {
            try {
              await r.quality.enforceBudgets()
            } catch (error) {
              api.logger.warn(`Investigation budget enforcement failed: ${String(error)}`)
            }
          }
        })().finally(() => {
          budgetCheck = undefined
        })
      }, 15_000)
      budgetTimer.unref()
    },
    stop: async () => {
      stopped = true
      ready.clear()
      checking.clear()
      if (budgetTimer) clearInterval(budgetTimer)
      await budgetCheck
      for (const value of instances.values()) {
        if (activeInstances.get(value.policy.boardId) === value) activeInstances.delete(value.policy.boardId)
        value.store.close()
      }
      instances.clear()
    }
  })
  for (const [method, action, scope] of [
    ["autocode.quality", (r: NativeAutonomyRuntime) => r.quality.report(), "operator.read"],
    ["autocode.status", (r: NativeAutonomyRuntime) => r.status(), "operator.read"],
    ["autocode.doctor", (r: NativeAutonomyRuntime) => nativeDoctor(r.policy, gateway), "operator.read"],
    ["autocode.discover", (r: NativeAutonomyRuntime) => r.discover(), "operator.admin"],
    ["autocode.reconcile", (r: NativeAutonomyRuntime) => r.reconcile(), "operator.admin"]
  ] as const) {
    api.registerGatewayMethod(
      method,
      async ({ params, respond }: any) => {
        try {
          const r = runtime(params.boardId)
          if (scope === "operator.admin") await ensureReady(r)
          respond(true, await action(r))
        } catch (error) {
          respond(false, undefined, { code: "autocode_error", message: String(error) })
        }
      },
      { scope }
    )
  }
  api.registerGatewayMethod(
    "autocode.dashboard",
    async ({ params, respond }: any) => {
      try {
        respond(true, runtime(params.boardId).dashboardSnapshot())
      } catch (error) {
        respond(false, undefined, { code: "autocode_error", message: String(error) })
      }
    },
    { scope: "operator.read" }
  )
  api.registerGatewayMethod(
    "autocode.workflow.explain",
    async ({ params, respond }: any) => {
      try {
        respond(true, await runtime(params.boardId).explainWorkflow(params.workflowId))
      } catch (error) {
        respond(false, undefined, { code: "autocode_error", message: String(error) })
      }
    },
    { scope: "operator.read" }
  )
  api.registerGatewayMethod(
    "autocode.workflow.recover.plan",
    async ({ params, respond }: any) => {
      try {
        respond(
          true,
          await runtime(params.boardId).planWorkflowRecovery(
            params.workflowId,
            params.action,
            params.reason,
            params.successorId
          )
        )
      } catch (error) {
        respond(false, undefined, { code: "autocode_error", message: String(error) })
      }
    },
    { scope: "operator.read" }
  )
  api.registerGatewayMethod(
    "autocode.workflow.recover.apply",
    async ({ params, respond }: any) => {
      try {
        respond(true, await runtime(params.boardId).applyWorkflowRecovery(params.plan, "authenticated operator.admin"))
      } catch (error) {
        respond(false, undefined, { code: "autocode_error", message: String(error) })
      }
    },
    { scope: "operator.admin" }
  )
  api.registerGatewayMethod(
    "autocode.freeze",
    async ({ params, respond }: any) => {
      try {
        respond(true, await runtime(params.boardId).freeze())
      } catch (error) {
        respond(false, undefined, { code: "autocode_error", message: String(error) })
      }
    },
    { scope: "operator.admin" }
  )
  api.registerGatewayMethod(
    "autocode.skill.bootstrap",
    async ({ params, respond, client }: any) => {
      try {
        const r = runtime(params.boardId)
        if (!r.control.state.paused) throw new Error("Pause execution before skill bootstrap")
        const operatorId = client?.connect?.device?.id ?? client?.connect?.client?.id
        if (!operatorId || !client?.connect?.scopes?.includes("operator.admin"))
          throw new Error("Authenticated administrator context required")
        if (!r.policy.quality) throw new Error("No investigation skill configured")
        const snapshot = registerNativeSkill(r.store, loadNativeSkillText(r.policy.quality.skillPath))
        const policyDigest = nativeSkillPolicyDigest(r.policy)
        if (params.digest !== snapshot.digest || params.policyDigest !== policyDigest)
          throw new Error("Review the current exact skill and policy digests before bootstrap")
        bootstrapNativeSkill(
          r.store,
          r.policy.boardId,
          snapshot.digest,
          policyDigest,
          { operatorId, rationale: params.reason },
          [
            r.policy.plannerAgentId,
            r.policy.coderAgentId,
            r.policy.reviewerAgentId,
            ...r.policy.personas.map((p) => p.investigationAgentId ?? p.personaId)
          ]
        )
        respond(true, { digest: snapshot.digest, policyDigest })
      } catch (error) {
        respond(false, undefined, { code: "autocode_error", message: String(error) })
      }
    },
    { scope: "operator.admin" }
  )
  api.registerGatewayMethod(
    "autocode.pause",
    async ({ params, respond }: any) => {
      try {
        const r = runtime(params.boardId)
        const control = r.control.change(true)
        respond(true, { ...control, note: "No new dispatch or promotion; accepted native runs remain visible." })
      } catch (error) {
        respond(false, undefined, { code: "autocode_error", message: String(error) })
      }
    },
    { scope: "operator.admin" }
  )
  api.registerGatewayMethod(
    "autocode.resume",
    async ({ params, respond }: any) => {
      try {
        const r = runtime(params.boardId)
        if (!r.policy.enabled) throw new Error("Policy is disabled; enable the reviewed native policy before resuming")
        const revision = r.control.state.revision
        const readiness = await nativeDoctor(r.policy, gateway)
        if (!readiness.ok) throw new Error(`Resume blocked: ${JSON.stringify(readiness.checks.filter((c) => !c.ok))}`)
        const control = r.control.change(false, revision)
        ready.add(r)
        respond(true, control)
      } catch (error) {
        respond(false, undefined, { code: "autocode_error", message: String(error) })
      }
    },
    { scope: "operator.admin" }
  )
  api.registerGatewayMethod(
    "autocode.adopt",
    async ({ params, respond }: any) => {
      try {
        const r = runtime(params.boardId)
        await ensureReady(r)
        respond(true, await r.adoptLegacy(params.legacyKey))
      } catch (error) {
        respond(false, undefined, { code: "autocode_error", message: String(error) })
      }
    },
    { scope: "operator.admin" }
  )
  api.registerGatewayMethod(
    "autocode.retryInvestigation",
    async ({ params, respond }: any) => {
      try {
        respond(
          true,
          await runtime(params.boardId).quality.retryUninspected(params.roundId, params.personaId, params.reason)
        )
      } catch (error) {
        respond(false, undefined, { code: "autocode_error", message: String(error) })
      }
    },
    { scope: "operator.admin" }
  )
  const field = { type: "string", minLength: 1 }
  const tool = (
    name: string,
    description: string,
    properties: Record<string, unknown>,
    execute: (p: any, ctx: any) => unknown,
    optional: string[] = ["assessment"]
  ) => ({
    name,
    label: name,
    description,
    parameters: {
      type: "object",
      properties: { boardId: field, ...properties },
      required: ["boardId", ...Object.keys(properties).filter((key) => !optional.includes(key))],
      additionalProperties: false
    },
    execute: async (p: any, ctx: any) => {
      const r = runtime(p.boardId)
      assertNativeMode(
        r.policy,
        ["autocode_propose", "autocode_defer", "autocode_investigation_finish"].includes(name)
          ? "propose"
          : ["autocode_review", "autocode_design_review"].includes(name)
            ? "review"
            : ["autocode_admit", "autocode_submit"].includes(name)
              ? "implement"
              : "inspect"
      )
      await ensureReady(r)
      await authorizeNativeTool(r, name, p, ctx)
      return r.withOwnership(() => Promise.resolve(execute(p, ctx)))
    }
  })
  const tools = [
    tool(
      "autocode_context",
      "Retrieve complete context for your assigned active card before acting.",
      { contextId: field },
      (p, ctx) => runtime(p.boardId).readContext(ctx.agentId, ctx.sessionKey, p.contextId)
    ),

    tool(
      "autocode_inspect",
      "Read committed files in your assigned persona scope. Empty path lists files. Pass a returned nextOffset as offset to continue a truncated file.",
      {
        roundId: field,
        personaId: field,
        path: { type: "string" },
        startLine: { type: "integer", minimum: 1 },
        lineCount: { type: "integer", minimum: 1, maximum: 1000 },
        contextPack: { type: "boolean", default: false },
        offset: {
          type: "integer",
          minimum: 0,
          description: "Continuation offset returned by the previous read; omit for the first page."
        }
      },
      (p, ctx) =>
        runtime(p.boardId).quality.inspect(ctx.agentId, ctx.sessionKey, p.roundId, p.personaId, p.path, p.offset, {
          ...(p.startLine === undefined ? {} : { startLine: p.startLine }),
          ...(p.lineCount === undefined ? {} : { lineCount: p.lineCount }),
          ...(p.contextPack === undefined ? {} : { contextPack: p.contextPack })
        }),
      ["offset", "startLine", "lineCount", "contextPack"]
    ),
    tool(
      "autocode_investigation_finish",
      "Record completed or no_op investigation before completing the card.",
      { roundId: field, personaId: field, outcome: { type: "string", enum: ["completed", "no_op"] }, reason: field },
      (p, ctx) =>
        runtime(p.boardId).quality.finish(ctx.agentId, ctx.sessionKey, p.roundId, p.personaId, p.outcome, p.reason)
    ),
    tool(
      "autocode_defer",
      "Planner records why a proposal was deferred or rejected.",
      { proposalId: field, reason: field },
      (p, ctx) => runtime(p.boardId).quality.defer(ctx.agentId, p.proposalId, p.reason)
    ),
    tool(
      "autocode_design_review",
      "Independent design coverage decision before verification. Assess planned acceptance coverage; executed acceptance remains gated by independent verification and final review.",
      {
        workflowId: field,
        verdict: { type: "string", enum: ["approved", "changes_requested"] },
        rationale: field,
        assessment: { type: "object", additionalProperties: true }
      },
      (p, ctx) =>
        runtime(p.boardId).quality.designReview(
          ctx.agentId,
          ctx.sessionKey,
          p.workflowId,
          p.verdict,
          p.rationale,
          p.assessment
        )
    ),
    tool(
      "autocode_propose",
      "Record an evidence-backed proposal from your own persona investigation.",
      {
        roundId: field,
        proposal: {
          type: "object",
          required: [
            "personaId",
            "goal",
            "title",
            "evidence",
            "allowedPaths",
            "acceptance",
            "alternatives",
            "implementationPrompt"
          ],
          properties: {
            personaId: field,
            goal: { type: "string", description: "Exactly copy one configured persona.goals entry." },
            title: field,
            evidence: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                required: ["path", "observation"],
                properties: { path: field, observation: field }
              }
            },
            allowedPaths: { type: "array", minItems: 1, items: field },
            acceptance: { type: "array", minItems: 1, items: field },
            alternatives: {
              type: "array",
              minItems: 1,
              items: field,
              description: "Strings describing alternatives and why they were rejected or deferred."
            },
            implementationPrompt: field,
            quality: {
              type: "object",
              description: "Required for persona quality investigations.",
              required: [
                "problem",
                "userWorkflow",
                "expectedBenefit",
                "approach",
                "nonGoals",
                "risk",
                "riskReasons",
                "verification"
              ],
              properties: {
                problem: field,
                userWorkflow: field,
                expectedBenefit: field,
                approach: field,
                nonGoals: { type: "array", minItems: 1, items: field },
                risk: {
                  type: "string",
                  enum: ["routine", "high"],
                  description:
                    "Use high when independent design review is needed; medium and low are not accepted values."
                },
                riskReasons: { type: "array", items: field },
                verification: {
                  type: "array",
                  minItems: 1,
                  items: {
                    type: "object",
                    required: ["criterion", "method"],
                    properties: {
                      criterion: {
                        type: "string",
                        description: "Exactly copy one acceptance criterion; cover each once."
                      },
                      method: field
                    }
                  }
                }
              }
            }
          }
        }
      },
      (p, ctx) => {
        const r = runtime(p.boardId)
        return r.store.get<{ qualityVersion?: number }>("round", p.roundId)?.qualityVersion
          ? r.quality.propose(ctx.agentId, ctx.sessionKey, p.roundId, p.proposal)
          : r.propose(ctx.agentId, p.roundId, p.proposal)
      }
    ),
    tool(
      "autocode_proposals",
      "Read persona proposals with budget-aware value rankings for a discovery round.",
      { roundId: field },
      (p) => {
        const r = runtime(p.boardId)
        const ranking = r.quality.selection(p.roundId)
        return r.store
          .list<any>("proposal")
          .filter((item) => item.value.roundId === p.roundId)
          .map((item) => ({
            ...item,
            selection: ranking.find((d) => d.id === item.id),
            decision: r.store.get("decision", item.id)
          }))
      }
    ),
    tool(
      "autocode_admit",
      "Planner-only admission of a recorded persona proposal.",
      { proposalId: field, rationale: field },
      (p, ctx) => runtime(p.boardId).admit(ctx.agentId, p.proposalId, p.rationale)
    ),
    tool(
      "autocode_submit",
      "Submit scoped edits from the assigned managed worktree. The host broker records a commit without exposing Git metadata to the sandbox, then independently verifies it. Never include agent notes or credentials.",
      { workflowId: field, worktreePath: field },
      (p, ctx) => runtime(p.boardId).submit(ctx.agentId, ctx.sessionKey, p.workflowId, p.worktreePath)
    ),
    tool(
      "autocode_review",
      "Assigned independent reviewer records a commit-bound decision.",
      {
        workflowId: field,
        headSha: field,
        verdict: { enum: ["approved", "changes_requested"], type: "string" },
        rationale: field,
        assessment: { type: "object", additionalProperties: true }
      },
      (p, ctx) =>
        runtime(p.boardId).review(
          ctx.agentId,
          ctx.sessionKey,
          p.workflowId,
          p.headSha,
          p.verdict as NativeReviewEvidence["verdict"],
          p.rationale,
          p.assessment
        )
    )
  ]
  api.registerGatewayMethod(
    "autocode.tool",
    async ({ params, respond }: any) => {
      try {
        // An operator-authenticated CLI connection does not authenticate a model's
        // claimed agent/session. No supported cross-process agent binding exists here.
        const r = instances.get(params.arguments?.boardId)
        r?.store.event("tool.denied", r.policy.boardId, { reason: "untrusted RPC agent context" })
        throw new Error("Native remote tool broker unavailable: trusted local plugin factory context required")
      } catch (error) {
        respond(false, undefined, { code: "autocode_error", message: String(error) })
      }
    },
    { scope: "operator.admin" }
  )
  api.registerTool(
    (ctx: any) =>
      tools.map((definition) => ({
        ...definition,
        execute: async (_id: string, params: any) => {
          // Sandboxed sessions can call the narrow broker: identity comes from
          // the host factory closure, while board/card ownership is resolved server-side.
          if (!activeInstances.has(params.boardId))
            throw new Error("Native remote tool broker unavailable: trusted local plugin factory context required")
          await ensureReady(runtime(params.boardId))
          const assigned = await resolveNativeToolRuntime(activeInstances.values(), ctx)
          if (assigned.policy.boardId !== params.boardId) {
            assigned.store.event("tool.denied", assigned.policy.boardId, {
              reason: "board selector differs from live assignment"
            })
            throw new Error("Native tool denied: board is not assigned to this session")
          }
          const result = await definition.execute(params, ctx)
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: result }
        }
      })),
    { names: tools.map((t) => t.name), optional: true }
  )
  api.on("subagent_ended", async () => {
    for (const r of instances.values()) {
      if (!r.policy.enabled) continue
      // The durable native automation is the owner; lifecycle events merely nudge it.
      const schedule = r.store.get<{ reconcileJobId: string }>("automation", r.policy.boardId)
      if (schedule) {
        try {
          await gateway.request("cron.run", { id: schedule.reconcileJobId, mode: "if-enabled" })
        } catch (error) {
          api.logger.warn(`Autocode reconciliation nudge failed: ${String(error)}`)
        }
      }
    }
  })
}
