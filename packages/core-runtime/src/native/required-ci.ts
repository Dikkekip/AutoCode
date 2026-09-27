// Native required-CI authorization. GitHub REST check runs and branch protection are read-only inputs.
import type { NativeAutonomyPolicy } from "@openclaw/domain"

export class NativeCiPending extends Error {}

export async function assertNativeRequiredCi(
  policy: NativeAutonomyPolicy,
  cwd: string,
  headSha: string,
  github: (cwd: string, args: string[]) => Promise<string>,
  now = Date.now()
) {
  const required = policy.requiredCi
  if (!required?.checks.length) throw new Error("Reviewed required CI policy is missing")
  if (required.requireBranchProtection !== false) {
    const protection = JSON.parse(
      await github(cwd, [
        "api",
        `repos/{owner}/{repo}/branches/${encodeURIComponent(policy.baseBranch)}/protection/required_status_checks`
      ])
    )
    if (!Array.isArray(protection.checks) || !Array.isArray(protection.contexts))
      throw new Error("GitHub branch protection requirements unavailable or malformed")
    for (const check of protection.checks) {
      if (
        !required.checks.some(
          (c) => c.name === check.context && (check.app_id === null || check.app_id === -1 || c.appId === check.app_id)
        )
      )
        throw new Error("Required CI policy does not cover branch protection")
    }
    for (const context of protection.contexts)
      if (!required.checks.some((c) => c.name === context))
        throw new Error("Required CI policy does not cover branch protection")
  }
  const runs: any[] = []
  for (let page = 1; ; page++) {
    if (page > 100) throw new Error("GitHub CI pagination exceeded bounded limit")
    const response = JSON.parse(
      await github(cwd, [
        "api",
        `repos/{owner}/{repo}/commits/${headSha}/check-runs?per_page=100&filter=latest&page=${page}`
      ])
    )
    const pages = Array.isArray(response) ? response : [response]
    if (!pages.length || pages.some((p) => !Array.isArray(p.check_runs))) throw new Error("Malformed GitHub check runs")
    const batch = pages.flatMap((p) => p.check_runs)
    runs.push(...batch)
    if (batch.length < 100) break
  }
  for (const expected of required.checks) {
    const matches = runs.filter((run) => run.name === expected.name && run.app?.id === expected.appId)
    if (matches.length === 0) throw new NativeCiPending(`Waiting for required CI check to appear: ${expected.name}`)
    if (matches.length !== 1) throw new Error(`Missing or ambiguous required CI check: ${expected.name}`)
    const run = matches[0]
    if (run.head_sha === headSha && ["queued", "in_progress", "waiting", "pending"].includes(run.status))
      throw new NativeCiPending(`Waiting for required CI: ${expected.name}`)
    const finished = Date.parse(run.completed_at),
      started = Date.parse(run.started_at)
    if (
      run.head_sha !== headSha ||
      run.status !== "completed" ||
      run.conclusion !== "success" ||
      !Number.isFinite(finished) ||
      !Number.isFinite(started) ||
      finished < started ||
      finished > now ||
      now - finished > required.maxAgeSeconds * 1000
    )
      throw new Error(`Required CI check is stale, mismatched or not successful: ${expected.name}`)
  }
}
