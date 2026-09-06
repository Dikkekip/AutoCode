import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { runOpenClawNativeTurn } from "@openclaw/adapter-codex-local"
import type { Persona, PersonaDefinition, Project, RepoContext } from "@openclaw/domain"

export type PersonaImprovementPromptInput = {
  project: Project
  profileId: string | null
  repoContext: RepoContext
  runtimePersonas: Persona[]
  profilePersonas: PersonaDefinition[]
  generatedAt: string
}

export type PersonaImprovementPaths = {
  promptPath: string
  proposalPath: string
}

export type RunOpenClawPersonaImprovementInput = {
  repoPath: string
  prompt: string
  proposalPath: string
  openclawCommand?: string | undefined
  agentId?: string | undefined
  model?: string | null | undefined
}

function linesOrNone(values: string[], prefix = "- "): string[] {
  return values.length > 0 ? values.map((value) => `${prefix}${value}`) : [`${prefix}none`]
}

function formatRuntimePersona(persona: Persona): string {
  return [
    `- ${persona.name}`,
    `  stage: ${persona.stage}`,
    `  lanes: ${persona.ownedLanes.join(", ") || "none"}`,
    `  adapter: ${persona.preferredAdapterType}`,
    `  instructions: ${persona.instructionsPath ?? "none"}`
  ].join("\n")
}

function formatProfilePersona(persona: PersonaDefinition): string {
  return [
    `- ${persona.id} (${persona.name})`,
    `  role: ${persona.role}`,
    `  lanes: ${persona.allowedLanes.join(", ") || "none"}`,
    `  adapter: ${persona.defaultAdapterPreference}`,
    `  required reading: ${persona.requiredReading.join(", ") || "none"}`,
    `  verification: ${persona.verificationRules.join(" | ") || "none"}`
  ].join("\n")
}

function formatRepoContext(context: RepoContext): string {
  return [
    "## Detected Repo Context",
    "",
    `Profile name: ${context.profileName}`,
    `Project verify command: ${context.projectVerifyCommand ?? "none"}`,
    "",
    "### Stacks",
    ...linesOrNone(
      context.stackProfiles.map(
        (profile) => `${profile.path}: ${profile.label} (${profile.stack.join(", ") || "stack unknown"})`
      )
    ),
    "",
    "### Contracts",
    ...linesOrNone(context.contractProfiles.map((profile) => `${profile.path}: ${profile.label}`)),
    "",
    "### Lane Docs",
    ...linesOrNone(context.laneDocProfiles.map((profile) => `${profile.path}: ${profile.label}`)),
    "",
    "### Shared Reading",
    ...linesOrNone(context.sharedReadItems.map((item) => `${item.path}: ${item.reason}`)),
    "",
    "### Codex Reading",
    ...linesOrNone(context.codexReadItems.map((item) => `${item.path}: ${item.reason}`)),
    "",
    "### Gemini/UI Reading",
    ...linesOrNone(context.geminiReadItems.map((item) => `${item.path}: ${item.reason}`)),
    "",
    "### Verification",
    ...linesOrNone(
      [...context.codexVerifyCommands, ...context.geminiVerifyCommands].map(
        (command) => `${command.command}: ${command.reason}`
      )
    ),
    "",
    "### Repo Notes",
    ...linesOrNone(context.repoNotes)
  ].join("\n")
}

export function renderPersonaImprovementPrompt(input: PersonaImprovementPromptInput): string {
  return [
    "# OpenClaw Persona Improvement Prompt",
    "",
    "You are improving the OpenClaw persona setup for an already-installed repository.",
    "Inspect the codebase as needed, but do not edit files. Produce a proposal that a human can review before applying.",
    "",
    "## Repository",
    "",
    `Project: ${input.project.name}`,
    `Repo path: ${input.project.repoPath}`,
    `Selected profile: ${input.profileId ?? "none"}`,
    `Generated at: ${input.generatedAt}`,
    "",
    formatRepoContext(input.repoContext),
    "",
    "## Runtime Personas",
    "",
    ...(input.runtimePersonas.length > 0 ? input.runtimePersonas.map(formatRuntimePersona) : ["- none"]),
    "",
    "## Profile Persona Definitions",
    "",
    ...(input.profilePersonas.length > 0 ? input.profilePersonas.map(formatProfilePersona) : ["- none"]),
    "",
    "## Task",
    "",
    "Create a repo-specific persona improvement proposal.",
    "",
    "Required output format:",
    "",
    "```markdown",
    "# Persona Improvement Proposal",
    "",
    "## Summary",
    "- concise assessment of the current persona fit",
    "",
    "## Recommended Persona Changes",
    "- persona id/name",
    "- change type: keep, update, split, merge, add, pause",
    "- rationale tied to repo evidence",
    "- owned lanes",
    "- preferred adapter",
    "- required reading",
    "- verification rules",
    "",
    "## Suggested Prompt File Updates",
    "- exact target file under .openclaw/agents/ or .openclaw/planner/",
    "- replacement text or patch-style bullets",
    "",
    "## Profile Override Suggestions",
    "- JSON snippets suitable for .openclaw/profile.json personas overrides",
    "",
    "## Risks And Manual Review",
    "- anything a human should decide before applying",
    "```",
    "",
    "Rules:",
    "- Base recommendations on files, detected stacks, contracts, and verification commands in this repo.",
    "- Keep personas lane-bounded and auditable.",
    "- Do not invent agents that are not useful for this repo.",
    "- Prefer profile overrides and repo-owned prompt updates over framework internals.",
    "- Do not include secrets or private local environment values.",
    "- Do not apply the changes yourself."
  ].join("\n")
}

export function defaultPersonaImprovementPaths(repoPath: string, generatedAt: string): PersonaImprovementPaths {
  const stamp = generatedAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")
  const base = join(repoPath, ".openclaw", "proposals", `persona-improvement-${stamp}`)
  return {
    promptPath: `${base}.prompt.md`,
    proposalPath: `${base}.proposal.md`
  }
}

export function writePersonaImprovementPrompt(path: string, prompt: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${prompt.trimEnd()}\n`, "utf8")
}

export async function runOpenClawPersonaImprovement(input: RunOpenClawPersonaImprovementInput): Promise<string> {
  mkdirSync(dirname(input.proposalPath), { recursive: true })
  const result = await runOpenClawNativeTurn({
    cwd: input.repoPath,
    prompt: input.prompt,
    agentId: input.agentId ?? "planner",
    model: input.model,
    thinking: "high",
    label: `persona-improvement-${basename(input.repoPath)}`,
    command: input.openclawCommand,
    timeoutMs: 30 * 60 * 1000
  })
  if (!result.ok) {
    throw new Error(result.error ?? "OpenClaw native persona improvement failed")
  }
  if (!existsSync(input.proposalPath) && result.response.trim()) {
    writeFileSync(input.proposalPath, `${result.response.trimEnd()}\n`, "utf8")
  }
  return existsSync(input.proposalPath) ? readFileSync(input.proposalPath, "utf8") : result.response
}

export function resolvePersonaImprovementOutput(
  repoPath: string,
  output: string | undefined,
  fallback: string
): string {
  if (!output) return fallback
  return resolve(repoPath, output)
}

export function proposalDisplayPath(repoPath: string, path: string): string {
  const resolvedRepo = resolve(repoPath)
  const resolvedPath = resolve(path)
  return resolvedPath.startsWith(resolvedRepo) ? resolvedPath.slice(resolvedRepo.length + 1) || basename(path) : path
}
