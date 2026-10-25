import type { OperationalDigestSummary } from "../telegram-digest.js"
import type { NativeGateway } from "./gateway.js"

/** Workboard completion is worker activity; only deployment receipts count as shipped work. */
export async function collectNativeOperationalDigestSummary(
  gateway: NativeGateway,
  input: { boardId: string; repository: string; projectName: string; windowHours?: number; now?: Date }
): Promise<OperationalDigestSummary> {
  const now = input.now ?? new Date()
  const windowHours = Math.min(168, Math.max(1, input.windowHours ?? 24))
  const since = now.getTime() - windowHours * 3600_000
  const [status, board] = await Promise.all([
    gateway.request<any>("autocode.status", { boardId: input.boardId }),
    gateway.request<any>("workboard.cards.list", { boardId: input.boardId })
  ])
  if (status.boardId !== input.boardId || !Array.isArray(status.workflows) || !Array.isArray(board.cards))
    throw new Error("Native operational digest contract unavailable")
  if (board.hasMore === true || board.nextCursor != null) throw new Error("Native digest cannot use a partial board")
  const recent = (workflow: any) => Number.isFinite(workflow.updatedAt) && workflow.updatedAt >= since
  const deployed = status.workflows.filter((w: any) => w.lifecycle?.state === "completed" && w.deployedSha && recent(w))
  const failed = status.workflows.filter((w: any) => w.lifecycle?.state === "blocked" && w.blocker && recent(w))
  const task = (w: any) => ({ id: w.id, title: w.title, completedAt: new Date(w.updatedAt).toISOString() })
  const reasons = new Map<string, number>()
  for (const w of failed) {
    const reason = String(w.blocker)
      .split("\n")[0]!
      .replace(/https?:\/\/\S+/g, "[url]")
      .slice(0, 120)
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1)
  }
  const counts: Record<string, number> = {}
  for (const card of board.cards)
    if (!card.archivedAt && card.status !== "done") counts[card.status] = (counts[card.status] ?? 0) + 1
  const pressureSignals: OperationalDigestSummary["pressureSignals"] = []
  if (status.control?.paused) pressureSignals.push({ severity: "warn", summary: "native board paused" })
  if (status.resourcePressure?.allowed === false)
    pressureSignals.push({
      severity: "warn",
      summary: `new starts deferred: ${status.resourcePressure.reasons.join(", ")}`
    })
  const recoveries = status.workflows.filter((w: any) => w.recovery?.at && Date.parse(w.recovery.at) >= since)
  return {
    projectId: input.boardId,
    projectName: input.projectName,
    repoPath: input.repository,
    generatedAt: now.toISOString(),
    windowHours,
    runtimeAuthority: "native",
    controlPaused: status.control?.paused === true,
    workerCompletions: board.cards.filter((c: any) => c.status === "done" && c.completedAt >= since).length,
    tasksCompleted: deployed.length,
    tasksFailed: failed.length,
    recentCompletedTasks: deployed.map(task).slice(-3).reverse(),
    recentFailedTasks: failed.map(task).slice(-3).reverse(),
    topFailureReasons: [...reasons]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 3),
    activeQueuesByStatus: counts,
    stuckQueuesByStatus: {},
    modelUsage: [],
    pressureSignals,
    notableRecoveries: recoveries.length ? [{ label: "native workflow recoveries", count: recoveries.length }] : []
  }
}
