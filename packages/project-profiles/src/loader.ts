import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { mergePersonaDefinitions, type PersonaDefinition } from "@openclaw/domain"
import { validateProjectProfile } from "./schema.js"
import type { ProfileDetectionMatch, ProjectProfile, ProjectProfileInstallFile, RepoDetectionSignal } from "./types.js"

function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
}

export function builtInProfilesDir(root = repoRoot()): string {
  return join(root, "profiles")
}

export function builtInProfilePath(profileId: string, root = repoRoot()): string {
  return join(builtInProfilesDir(root), profileId, "profile.json")
}

export function listBuiltInProfileIds(root = repoRoot()): string[] {
  const dir = builtInProfilesDir(root)
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, "profile.json")))
    .map((entry) => entry.name)
    .sort()
}

export function loadProjectProfile(profileId: string, root = repoRoot()): ProjectProfile {
  const path = builtInProfilePath(profileId, root)
  if (!existsSync(path)) {
    throw new Error(`Profile not found: ${profileId}`)
  }
  return validateProjectProfile(JSON.parse(readFileSync(path, "utf8")) as unknown)
}

export function loadProjectProfilePersonas(profileId?: string | null, root = repoRoot()): PersonaDefinition[] {
  if (!profileId) return mergePersonaDefinitions()
  const profile = loadProjectProfile(profileId, root)
  return mergePersonaDefinitions(undefined, profile.personas ?? [])
}

function signalMatches(repoPath: string, signal: RepoDetectionSignal): boolean {
  const target = join(repoPath, signal.path)
  switch (signal.kind) {
    case "file":
      return existsSync(target)
    case "directory":
      return existsSync(target)
    default:
      return false
  }
}

export function detectProfilesForRepo(repoPath: string, root = repoRoot()): ProfileDetectionMatch[] {
  const matches: ProfileDetectionMatch[] = []
  for (const profileId of listBuiltInProfileIds(root)) {
    const profile = loadProjectProfile(profileId, root)
    const hitSignals = profile.repoDetectionSignals.filter((signal) => signalMatches(repoPath, signal))
    const score = hitSignals.reduce((sum, signal) => sum + signal.weight, 0)
    if (score > 0) {
      matches.push({ profileId, score, matches: hitSignals })
    }
  }
  return matches.sort((left, right) => right.score - left.score || left.profileId.localeCompare(right.profileId))
}

export function bestProfileMatch(repoPath: string, root = repoRoot()): ProfileDetectionMatch | null {
  return detectProfilesForRepo(repoPath, root)[0] ?? null
}

function renderProgram(profile: ProjectProfile): string {
  return [
    "# OpenClaw Program",
    "",
    `This is the repo-local steering surface for the ${profile.displayName} profile.`,
    "Edit this file to steer the installed framework without changing framework internals.",
    "",
    "## Directive",
    "",
    ...profile.adoptionPolicy.operatorDirective.map((line) => `- ${line}`),
    "",
    "## Keep / Discard Rules",
    "",
    "- Keep framework changes when they improve the reusable runtime, installer contract, or adapter boundary.",
    "- Move repository-specific policy into the installed profile, local recipes, or repo-owned wrapper files.",
    "- Preserve durable orchestration records under the profile artifact paths before replacing workflow assumptions.",
    "",
    "## Editable Surfaces",
    "",
    "- `.openclaw/program.md` for operator steering",
    "- `.openclaw/agents/*.md` for installed prompts",
    "- `.openclaw/recipes/README.md` for repo-local recipes",
    "- `.openclaw/profile.json` for selected profile policy",
    "- `.openclaw/planner/planner.prompt.md` for repo-local autonomous planning behavior"
  ].join("\n")
}

function renderRecipes(profile: ProjectProfile): string {
  const lines = [
    "# OpenClaw Recipes",
    "",
    "Keep prompts, recipes, and extension notes editable in-repo.",
    "Add repo-local entries here before editing framework packages for one-off adoption needs."
  ]

  for (const recipe of profile.adoptionPolicy.recipeSeeds) {
    lines.push(
      "",
      `## ${recipe.title}`,
      "",
      `Use when: ${recipe.whenToUse}`,
      "",
      ...recipe.steps.map((step) => `- ${step}`)
    )
  }

  return lines.join("\n")
}

function renderContributing(profile: ProjectProfile): string {
  return [
    "# OpenClaw Contribution Workflow",
    "",
    "Keep adoption work open, test-backed, and easy to audit.",
    "",
    "## Default Rules",
    "",
    "- Keep changes focused and routed through profile data or thin adapters where possible.",
    "- Add or update focused tests for runtime, installer, or profile contract changes.",
    "- Preserve durable orchestration records in the configured artifact directories when changing planner behavior.",
    "- Discuss major runtime or governance changes in `.openclaw/proposals/` before broad implementation.",
    "",
    "## Extension Points",
    "",
    ...profile.adoptionPolicy.extensionPoints.map(
      (point) => `- \`${point.kind}\` ${point.extensionId}: ${point.summary} (${point.delivery})`
    ),
    "",
    "## Manual Follow-Up",
    "",
    ...profile.adoptionPolicy.manualSteps.map((step) => `- ${step}`)
  ].join("\n")
}

function renderProposals(): string {
  return [
    "# OpenClaw Proposals",
    "",
    "Use this directory for short proposal notes before major profile, adapter, or runtime changes.",
    "",
    "Suggested shape:",
    "- problem",
    "- proposal",
    "- affected packages or profiles",
    "- tests and rollout plan",
    "- audit or orchestration artifacts to preserve"
  ].join("\n")
}

function renderPlannerPrompt(profile: ProjectProfile): string {
  return [
    `# ${profile.displayName} OpenClaw Planner Prompt`,
    "",
    "Emit valid planner JSON only. Do not include markdown fences or prose.",
    "",
    "The top-level object must contain `version: 1`, `summary`, and a `candidates` array.",
    "",
    "When the queue contains only blocked, failed, or changes-requested work, do not retry those same task titles. Use the persona ideation roster supplied by the runtime to create fresh, repo-evidenced vertical feature-slice coding tasks.",
    "",
    "Prefer these task patterns:",
    "",
    ...profile.managerStateDefaults.managerPersonas.map(
      (persona) => `- Tasks from \`${persona.id}\`: ${persona.focus}.`
    ),
    "",
    "Each candidate must:",
    "",
    "- Use a real `personaId` from the supplied persona ideation roster.",
    "- Use an allowed lane from the supplied lane list.",
    "- Be a real user-facing or operator-facing feature slice, not a cosmetic patchlet.",
    "- Do not emit test-only, witness-only, or cosmetic titles such as `Add ... unit tests`, `Add ... regression`, `Add contract witness ...`, `Cover ... encoding`, `Add helper text ...`, or `Show ... labels`.",
    "- Treat tests, contract checks, and docs as acceptance evidence for the feature slice, not as the feature by themselves.",
    "- Stay independently reviewable in one PR by keeping the slice coherent and lane-scoped.",
    "- Keep independent candidates dependency-free so they can run in parallel.",
    "- When merged code from another candidate is required, reference that candidate's `dedupeKey` in `dependencies`.",
    "- Dependency keys must reference candidates in the same output and form an acyclic graph.",
    `- Cross-lane dependencies are ${profile.planner.governance.allowCrossLaneDependencies ? "allowed" : "disabled"} by profile policy.`,
    "- Cite repo-search evidence in `sourceSignals`, `requiredReading`, or `repoNotes`.",
    "- Include concrete `requiredReading` and `verificationChecklist`.",
    "- Avoid broad repo-health sweeps.",
    "- Avoid model-budget-wasting retry loops.",
    "",
    "Expected shape:",
    "",
    "{",
    '  "version": 1,',
    '  "summary": "short planner summary",',
    '  "candidates": [',
    "    {",
    '      "title": "Task title",',
    '      "description": "Why this work matters now",',
    '      "kind": "implement",',
    '      "lane": "lane-id",',
    '      "personaId": "backend-engineer",',
    '      "portfolioBucket": "backend_api",',
    '      "userOutcome": "short user or operator outcome",',
    '      "acceptanceCriteria": ["observable done criterion"],',
    '      "taskSourceIntent": "persona_ideation",',
    '      "preferredAdapterType": "codex_local",',
    '      "priority": 60,',
    '      "requiredReading": ["README.md"],',
    '      "verificationChecklist": [],',
    '      "contractUpdateReminders": [],',
    '      "repoNotes": [],',
    '      "dependencies": [],',
    '      "tags": ["planner-generated", "persona-ideated"],',
    '      "riskLevel": "medium",',
    '      "governanceClass": "normal",',
    '      "dedupeKey": "stable-dedupe-key",',
    '      "sourceSignals": ["persona-ideation"],',
    '      "estimatedCost": 1,',
    '      "createMode": "queue_now"',
    "    }",
    "  ]",
    "}"
  ].join("\n")
}

export function projectProfileInstallFiles(targetPath: string, profile: ProjectProfile): ProjectProfileInstallFile[] {
  const openclawDir = join(targetPath, ".openclaw")
  const stateBootstrapDir = join(openclawDir, "state", "bootstrap")
  const jobsDir = join(openclawDir, "jobs")

  const files = new Map<string, { content: string; reason: string }>([
    [
      join(openclawDir, "profile.json"),
      { content: JSON.stringify(profile, null, 2) + "\n", reason: "selected project profile policy" }
    ],
    [
      join(stateBootstrapDir, "framework-map.json"),
      {
        content: JSON.stringify(profile.framework, null, 2) + "\n",
        reason: "framework extraction map for the selected profile"
      }
    ],
    [
      join(stateBootstrapDir, "manager_state.json"),
      {
        content: JSON.stringify(profile.managerStateDefaults, null, 2) + "\n",
        reason: "profile-backed manager seed state"
      }
    ],
    [
      join(stateBootstrapDir, "runtime.json"),
      {
        content:
          JSON.stringify(
            {
              version: 1,
              project: profile.displayName,
              sourceProfileId: profile.profileId,
              frameworkVersion: profile.framework.version,
              requiredJobIds: profile.jobDefinitions.map((job) => job.jobId),
              promotionPolicy: profile.promotionPolicy,
              notificationPolicy: profile.notificationPolicy,
              artifactPolicy: profile.artifactPolicy
            },
            null,
            2
          ) + "\n",
        reason: "profile-backed runtime bootstrap contract"
      }
    ],
    [
      join(openclawDir, "program.md"),
      { content: renderProgram(profile) + "\n", reason: "editable human steering surface for the installed profile" }
    ],
    [
      join(openclawDir, "planner", "planner.prompt.md"),
      { content: renderPlannerPrompt(profile) + "\n", reason: "editable planner persona prompt contract" }
    ],
    [
      join(openclawDir, "recipes", "README.md"),
      {
        content: renderRecipes(profile) + "\n",
        reason: "editable recipe surface for repo-local prompt and workflow additions"
      }
    ],
    [
      join(openclawDir, "CONTRIBUTING.md"),
      {
        content: renderContributing(profile) + "\n",
        reason: "open contribution workflow for profile, adapter, and runtime changes"
      }
    ],
    [
      join(openclawDir, "proposals", "README.md"),
      { content: renderProposals() + "\n", reason: "proposal path for major installer and runtime changes" }
    ]
  ])

  for (const job of profile.jobDefinitions) {
    files.set(join(jobsDir, `${job.jobId}.json`), {
      content:
        JSON.stringify(
          {
            id: job.jobId,
            cron: job.cron,
            timezone: job.timezone,
            entryAgent: job.entryAgent ?? null,
            command: `dispatcher director job ${job.jobId}`
          },
          null,
          2
        ) + "\n",
      reason: `installed scheduled job from profile ${profile.profileId}`
    })
  }

  return Array.from(files.entries())
    .map(([absolutePath, file]) => ({
      absolutePath,
      relativePath: relative(targetPath, absolutePath) || absolutePath,
      content: file.content,
      reason: file.reason
    }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
}

export function installProjectProfile(
  targetPath: string,
  profile: ProjectProfile,
  options?: { force?: boolean }
): { written: string[]; kept: string[] } {
  const written: string[] = []
  const kept: string[] = []
  for (const file of projectProfileInstallFiles(targetPath, profile)) {
    if (existsSync(file.absolutePath) && !options?.force && readFileSync(file.absolutePath, "utf8") !== file.content) {
      kept.push(file.relativePath)
      continue
    }
    mkdirSync(dirname(file.absolutePath), { recursive: true })
    writeFileSync(file.absolutePath, file.content, "utf8")
    written.push(file.relativePath)
  }

  return { written, kept }
}

/** Resolve installed policy before detection, preserving policy across linked Git worktrees.
 * Invalid installed profiles are errors, never a reason to silently select a default.
 */
export function resolveProjectProfile(repoPath: string): ProjectProfile | null {
  const installed = (root: string) => join(root, ".openclaw", "profile.json")
  let root = repoPath
  if (!existsSync(installed(root))) {
    try {
      const common = execFileSync("git", ["rev-parse", "--git-common-dir"], {
        cwd: repoPath,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      }).trim()
      root = dirname(resolve(repoPath, common))
    } catch {
      /* Repository snapshots need not contain Git metadata. */
    }
  }
  if (existsSync(installed(root))) {
    return validateProjectProfile(JSON.parse(readFileSync(installed(root), "utf8")))
  }
  const match = bestProfileMatch(root)
  return match ? loadProjectProfile(match.profileId) : null
}
