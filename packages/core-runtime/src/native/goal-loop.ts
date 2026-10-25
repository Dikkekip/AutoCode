import type { NativeProposal } from "@openclaw/domain"

/** A Workboard-scoped objective for native agents; not an interactive Codex /goal command. */
export function nativeGoalLoopContract(proposal: NativeProposal) {
  const methods = new Map(proposal.quality?.verification.map((item) => [item.criterion, item.method]) ?? [])
  return {
    outcome: proposal.title,
    verification: proposal.acceptance.map((criterion) => ({
      criterion,
      method: methods.get(criterion) ?? "Inspect the candidate and verify this criterion with concrete evidence."
    })),
    constraints: [
      "Preserve unrelated work and existing behavior outside the admitted scope.",
      "Do not weaken required checks or push, merge, release, or deploy from the coding card."
    ],
    boundaries: proposal.allowedPaths,
    iteration:
      "Plan a small change, edit, run a focused check, inspect the result, repair failures, and repeat while useful in-scope work remains. Record what changed, what the check showed, and the next best action in the card.",
    budget:
      "Respect the Workboard card deadline, retry limit, and native policy limits. Exhausting a limit is a stop for this attempt, not evidence of completion.",
    completion:
      "Submit the scoped candidate with autocode_submit before workboard_complete. Submission is a handoff; native verification and independent review decide whether the outcome is complete.",
    blocked:
      "If no defensible in-scope path remains, report the attempts, evidence, blocker, and input needed in the card. Do not claim completion or submit an unverified candidate."
  }
}
