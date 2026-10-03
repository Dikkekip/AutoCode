import { artifactScopesOverlap } from "./artifact-scopes.js"
import {
  type NativeAutonomyPolicy,
  type NativeProposal,
  nativeCoderAgentIds,
  nativePathAllowed
} from "./native-autonomy.js"

/** Operator-reviewed scope constraints can raise, but never lower, declared complexity. */
export function nativeCoderRoute(
  policy: NativeAutonomyPolicy,
  proposal: NativeProposal,
  options: { repairCount?: number; highRisk?: boolean } = {}
): { tier: "simple" | "routine" | "very-complex"; agentIds: readonly string[]; reason: string } {
  const routing = policy.coderRouting
  if (!routing) return { tier: "routine", agentIds: nativeCoderAgentIds(policy), reason: "Legacy reviewed coder pool" }
  if (
    proposal.complexity?.tier === "very-complex" ||
    (options.repairCount ?? 0) >= 2 ||
    proposal.allowedPaths.some((path) => routing.veryComplexPaths.some((root) => artifactScopesOverlap(path, root)))
  ) {
    return {
      tier: "very-complex",
      agentIds: routing.veryComplex,
      reason: "Declared complexity, complex scope or repeated repair"
    }
  }
  if (
    proposal.complexity?.tier === "simple" &&
    !options.highRisk &&
    proposal.quality?.risk !== "high" &&
    proposal.allowedPaths.length > 0 &&
    proposal.allowedPaths.every((path) => routing.simplePaths.some((root) => nativePathAllowed(path, root)))
  ) {
    return { tier: "simple", agentIds: routing.simple, reason: "Declared simple task within reviewed simple scope" }
  }
  return { tier: "routine", agentIds: routing.routine, reason: "Default substantive work" }
}
