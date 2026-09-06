// New: native outcome metrics are projections of immutable privileged journal events.
export interface NativeOutcomeEvent {
  id: number
  kind: string
  subject: string
  createdAt: number
  data: Record<string, unknown>
}
export interface NativeOutcomeWindow {
  from: number
  to: number
  asOf: number
  retentionMs: number
}
const rate = (numerator: number, denominator: number) => ({
  numerator,
  denominator,
  value: denominator ? numerator / denominator : null
})
/** Admission cohort [from,to); observation uses only events at/before asOf. No model text is graded. */
export function nativeOutcomeMetrics(events: readonly NativeOutcomeEvent[], window: NativeOutcomeWindow) {
  if (
    ![window.from, window.to, window.asOf, window.retentionMs].every(Number.isFinite) ||
    window.from > window.to ||
    window.to > window.asOf ||
    window.retentionMs < 0
  )
    throw new Error("Invalid native outcome observation window")
  const unique = new Map<number, NativeOutcomeEvent>()
  for (const event of events) {
    if (!Number.isSafeInteger(event.id) || !Number.isFinite(event.createdAt))
      throw new Error("Invalid native outcome event")
    const old = unique.get(event.id)
    if (old && JSON.stringify(old) !== JSON.stringify(event))
      throw new Error("Conflicting replay of native outcome event")
    unique.set(event.id, event)
  }
  const ordered = [...unique.values()]
    .filter((e) => e.createdAt <= window.asOf)
    .sort((a, b) => a.createdAt - b.createdAt || a.id - b.id)
  const admissions = new Map<string, NativeOutcomeEvent>()
  for (const event of ordered)
    if (["workflow.admitted", "migration.adopted"].includes(event.kind) && !admissions.has(event.subject))
      admissions.set(event.subject, event)
  const cohort = [...admissions.values()].filter((e) => e.createdAt >= window.from && e.createdAt < window.to)
  const workflows = cohort.map((admission) => {
    const history = ordered.filter((e) => e.subject === admission.subject && e.createdAt >= admission.createdAt)
    const transitions = history.filter((e) => e.kind === "workflow.transitioned")
    const deployments = history.filter(
      (e) => e.kind === "workflow.deployed" || (e.kind === "workflow.transitioned" && e.data.state === "completed")
    )
    const deployment = deployments[0]
    const deployedSha = deployments.map((e) => e.data.deployedSha).find((sha) => typeof sha === "string")
    const repairs = history.filter((e) => e.kind === "workflow.repair-requested")
    const attempts = new Set(history.map((e) => e.data.attemptId).filter((id): id is string => typeof id === "string"))
    const reviewed = transitions.some(
      (e) =>
        ["review", "release", "deployment", "completed"].includes(String(e.data.state)) ||
        typeof e.data.reviewVerdict === "string"
    )
    const firstPassReview = transitions.some((e) => e.data.reviewVerdict === "approved" && e.data.attempt === 0)
    const rolledBack = history.some((e) => e.kind === "workflow.rolled-back")
    const regressed = history.some((e) => e.kind === "workflow.regression")
    const last = transitions.at(-1)?.data.state
    const retention = history
      .filter(
        (e) =>
          e.kind === "workflow.retention-observed" &&
          e.data.deployedSha === deployedSha &&
          typeof e.data.observedUntil === "number" &&
          e.data.observedUntil <= window.asOf &&
          e.createdAt >= e.data.observedUntil
      )
      .at(-1)
    const retained =
      rolledBack || regressed || retention?.data.healthy === false
        ? false
        : deployment &&
            deployedSha &&
            retention?.data.healthy === true &&
            Number(retention.data.observedUntil) >= deployment.createdAt + window.retentionMs
          ? true
          : null
    const usage = history.filter((e) => e.kind === "workflow.usage" && e.data.complete === true).at(-1)
    const costCents =
      usage &&
      typeof usage.data.costCents === "number" &&
      Number.isFinite(usage.data.costCents) &&
      usage.data.costCents >= 0
        ? usage.data.costCents
        : null
    return {
      workflowId: admission.subject,
      admittedAt: admission.createdAt,
      attempts: attempts.size || null,
      reviewed,
      firstPassReview,
      repairs: repairs.length,
      deployed: Boolean(deployment),
      firstPassSuccess: Boolean(deployment) && !repairs.some((e) => e.createdAt <= deployment!.createdAt),
      deployedAt: deployment?.createdAt ?? null,
      deployedSha: deployedSha ?? null,
      timeToVerifiedDeploymentMs: deployment ? deployment.createdAt - admission.createdAt : null,
      retained,
      rolledBack,
      regressed,
      costCents,
      interventions: history.filter((e) => e.kind === "workflow.operator-action").length,
      state: rolledBack ? "rolled_back" : regressed ? "regressed" : (last ?? "pending"),
      censored: !deployment && !["blocked", "cancelled"].includes(String(last)),
      evidenceEventIds: history.map((e) => e.id)
    }
  })
  const deployed = workflows.filter((w) => w.deployed)
  const retained = workflows.filter((w) => w.retained === true)
  const observed = deployed.filter((w) => w.retained !== null)
  const knownCost = workflows.filter((w) => w.costCents !== null)
  const totalKnownCostCents = knownCost.reduce((n, w) => n + w.costCents!, 0)
  return {
    version: 1 as const,
    window,
    cohort: "workflows first admitted in [from,to); observed through asOf",
    denominators: {
      admitted: workflows.length,
      reviewed: workflows.filter((w) => w.reviewed).length,
      deployed: deployed.length,
      retentionObserved: observed.length,
      costKnown: knownCost.length
    },
    firstPassVerifiedSuccess: rate(workflows.filter((w) => w.firstPassSuccess).length, workflows.length),
    eventualVerifiedSuccess: rate(deployed.length, workflows.length),
    retainedSuccess: rate(retained.length, observed.length),
    rollbackRate: rate(deployed.filter((w) => w.rolledBack).length, deployed.length),
    regressionRate: rate(deployed.filter((w) => w.regressed).length, deployed.length),
    repairRecurrence: rate(
      workflows.filter((w) => w.repairs > 1).length,
      workflows.filter((w) => w.repairs > 0).length
    ),
    humanInterventionsPerWorkflow: rate(
      workflows.reduce((n, w) => n + w.interventions, 0),
      workflows.length
    ),
    timeToVerifiedDeploymentMs: {
      values: deployed.map((w) => w.timeToVerifiedDeploymentMs!),
      censored: workflows.filter((w) => w.censored).length
    },
    cost: {
      knownCents: totalKnownCostCents,
      unknownWorkflows: workflows.length - knownCost.length,
      centsPerRetainedImprovement:
        knownCost.length === workflows.length && retained.length ? totalKnownCostCents / retained.length : null
    },
    missingAdmissionHistory: new Set(
      ordered.filter((e) => e.kind.startsWith("workflow.") && !admissions.has(e.subject)).map((e) => e.subject)
    ).size,
    proposalCounts: {
      proposed: ordered.filter(
        (e) => e.kind === "persona.proposed" && e.createdAt >= window.from && e.createdAt < window.to
      ).length,
      rejected: ordered.filter(
        (e) =>
          e.kind === "proposal.decided" &&
          e.data.outcome === "rejected" &&
          e.createdAt >= window.from &&
          e.createdAt < window.to
      ).length
    },
    workflows
  }
}
