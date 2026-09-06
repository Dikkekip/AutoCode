// New embeddable read-only native evidence view. Never defaults to demonstration data.
import { MetricGrid } from "./dashboard.js"
export interface NativeWorkflowExplanation {
  version: 1
  boardId: string
  workflowId: string
  lifecycle: { state: string; attemptId: string }
  candidate: { headSha: string } | null
  review: { verdict: string; headSha: string } | null
  blocker: string | null
  nextActions: string[]
}
export interface NativeEvidenceSnapshot {
  version: 1
  source: "live" | "demo"
  observedAt: string
  boardId: string
  workflows: NativeWorkflowExplanation[]
  metrics: { admitted: number; verifiedDeployments: number; totalKnownCost: number | null }
}
const states = new Set([
  "design_wait",
  "implementation",
  "verification",
  "review",
  "release",
  "deployment",
  "blocked",
  "cancelled",
  "completed"
])
/** Validate at the read boundary; no fixture fallback or control action is allowed here. */
export function decodeNativeEvidence(value: unknown): NativeEvidenceSnapshot {
  if (!value || typeof value !== "object") throw new Error("Native evidence is unavailable")
  const v = value as NativeEvidenceSnapshot
  if (
    v.version !== 1 ||
    !["live", "demo"].includes(v.source) ||
    !Number.isFinite(Date.parse(v.observedAt)) ||
    !v.boardId ||
    !Array.isArray(v.workflows)
  )
    throw new Error("Native evidence envelope is invalid")
  const ids = new Set<string>()
  for (const w of v.workflows) {
    if (
      w.version !== 1 ||
      w.boardId !== v.boardId ||
      !w.workflowId ||
      ids.has(w.workflowId) ||
      !w.lifecycle?.attemptId ||
      !states.has(w.lifecycle.state) ||
      !Array.isArray(w.nextActions) ||
      w.nextActions.some((x) => typeof x !== "string") ||
      (w.blocker !== null && typeof w.blocker !== "string")
    )
      throw new Error("Native workflow evidence is invalid")
    if (w.candidate && !/^[a-f0-9]{40,64}$/.test(w.candidate.headSha))
      throw new Error("Native candidate revision is invalid")
    if (
      w.review &&
      (!w.candidate ||
        w.review.headSha !== w.candidate.headSha ||
        !["approved", "changes_requested"].includes(w.review.verdict))
    )
      throw new Error("Native review revision is invalid")
    ids.add(w.workflowId)
  }
  if (
    !v.metrics ||
    ![v.metrics.admitted, v.metrics.verifiedDeployments].every((n) => Number.isSafeInteger(n) && n >= 0) ||
    v.metrics.verifiedDeployments > v.metrics.admitted ||
    (v.metrics.totalKnownCost !== null && (!Number.isFinite(v.metrics.totalKnownCost) || v.metrics.totalKnownCost < 0))
  )
    throw new Error("Native outcome metrics are invalid")
  return structuredClone(v)
}
export function NativeEvidenceView(props: {
  state: "loading" | "offline" | "ready"
  snapshot?: NativeEvidenceSnapshot
  now?: number
  staleAfterMs?: number
}) {
  if (props.state === "loading")
    return (
      <p role="status" aria-live="polite">
        Loading native evidence…
      </p>
    )
  if (props.state === "offline")
    return (
      <p role="status" aria-live="polite">
        Native evidence is offline. Refresh through the authenticated operator connection.
      </p>
    )
  if (!props.snapshot) return <p role="alert">Native evidence is unavailable.</p>
  let snapshot: NativeEvidenceSnapshot
  try {
    snapshot = decodeNativeEvidence(props.snapshot)
  } catch {
    return <p role="alert">Native evidence failed validation.</p>
  }
  const stale = (props.now ?? Date.now()) - Date.parse(snapshot.observedAt) > (props.staleAfterMs ?? 60000)
  return (
    <section aria-label="Native workflow evidence">
      <h2>
        {snapshot.source === "demo"
          ? "Demonstration data — synthetic native workflows"
          : "Live native workflow evidence"}
      </h2>
      <p role="status" aria-live="polite">
        {stale ? "Stale snapshot. " : ""}Observed <time dateTime={snapshot.observedAt}>{snapshot.observedAt}</time>.
        Board: {snapshot.boardId}. Read-only; Workboard owns execution.
      </p>
      <MetricGrid
        metrics={[
          { id: "admitted", label: "Admitted workflows", value: String(snapshot.metrics.admitted) },
          { id: "deployed", label: "Verified deployments", value: String(snapshot.metrics.verifiedDeployments) },
          {
            id: "cost",
            label: "Known cost",
            value: snapshot.metrics.totalKnownCost === null ? "Unknown" : String(snapshot.metrics.totalKnownCost)
          }
        ]}
      />
      {!snapshot.workflows.length ? (
        <p>No workflow evidence is available for this board.</p>
      ) : (
        <table>
          <caption>Attempt, revision, independent review and next permitted action</caption>
          <thead>
            <tr>
              {["Workflow / attempt", "State", "Candidate revision", "Review", "Waiting reason / next action"].map(
                (label) => (
                  <th key={label} scope="col">
                    {label}
                  </th>
                )
              )}
            </tr>
          </thead>
          <tbody>
            {snapshot.workflows.map((w) => (
              <tr key={w.workflowId}>
                <th scope="row">
                  {w.workflowId}
                  <br />
                  <small>{w.lifecycle.attemptId}</small>
                </th>
                <td>{w.lifecycle.state}</td>
                <td>
                  <code>{w.candidate?.headSha ?? "No candidate"}</code>
                </td>
                <td>{w.review?.verdict ?? "No review"}</td>
                <td>
                  {w.blocker && <p>{w.blocker}</p>}
                  <ul>
                    {[...new Set(w.nextActions)].map((action) => (
                      <li key={action}>{action}</li>
                    ))}
                  </ul>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
