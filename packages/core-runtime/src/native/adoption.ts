import { fileURLToPath } from "node:url"
import { validateNativeAutonomyPolicy } from "@openclaw/domain"
import type { ProjectProfile } from "@openclaw/project-profiles"

/** Preserve existing persona missions, portfolio weights, lane scopes, and verification rules. */
export function nativePolicyFromProfile(profile: ProjectProfile, repository: string, baseBranch: string) {
  return validateNativeAutonomyPolicy({
    version: 1,
    enabled: false,
    quality: {
      skillPath: fileURLToPath(new URL("../../../../skills/native-coding/SKILL.md", import.meta.url))
    },
    boardId: profile.profileId,
    repository,
    repositoryKind: "application",
    baseBranch,
    plannerAgentId: "planner",
    coderAgentId: "coder",
    reviewerAgentId: "release-quality-reviewer",
    workerConcurrency: 1,
    personasPerRound: 3,
    maxTasksPerRound: Math.min(6, profile.planner.maxTasksPerRun),
    dedupeWindowHours: profile.planner.dedupeWindowHours,
    discoveryDailyRoundLimit: 24,
    personas: profile.managerStateDefaults.managerPersonas.flatMap((persona) => {
      const paths = [
        ...new Set(
          profile.laneDefinitions
            .filter((lane) => persona.ownedLaneIds.includes(lane.laneId))
            .flatMap((lane) => lane.allowedPaths)
        )
      ]
      if (!paths.length) return []
      return [
        {
          personaId: persona.id,
          goals: [persona.focus],
          successObservations: persona.successSignals?.length ? persona.successSignals : [persona.focus],
          allowedPaths: paths,
          weight: persona.taskQuotaWeight ?? 1,
          investigationAgentId: `native-research-${persona.id}`,
          ...(persona.ideationPrompt ? { ideationPrompt: persona.ideationPrompt } : {})
        }
      ]
    }),
    verification: profile.verificationRules.flatMap((rule) => {
      const paths = [
        ...new Set(
          profile.laneDefinitions
            .filter((lane) => lane.verificationRuleId === rule.ruleId)
            .flatMap((lane) => lane.allowedPaths)
        )
      ]
      if (!paths.length) return []
      return rule.commands.map((text) => ({ argv: ["bash", "-lc", text], cwd: ".", timeoutSeconds: 1800, paths }))
    }),
    deployment: null
  })
}
