import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { CORE_INSTALL_SURFACE } from "@openclaw/core-runtime"
import { DispatcherStore } from "@openclaw/db"
import type { AdapterType, PersonaDefinition, PersonaStage } from "@openclaw/domain"
import { planOpenClawStateSync } from "@openclaw/domain"
import {
  bestProfileMatch,
  loadProjectProfile,
  loadProjectProfilePersonas,
  type ProjectProfile,
  projectProfileInstallFiles
} from "@openclaw/project-profiles"
import {
  detectRepoContext,
  detectVerifyCommand,
  type RepoContext,
  type RepoContractProfile,
  type RepoControlPlaneSignal,
  type RepoInstructionItem,
  type RepoLaneDocProfile,
  type RepoStackProfile,
  type RepoVerifyCommand
} from "./repo-context.js"

type InstallOptions = {
  targetPath: string
  companyName?: string | null
  projectName?: string | null
  verifyCommand?: string | null
  tools?: InstallTool[] | null
  codexName: string
  geminiName: string
  foundryName: string
  codexRole: string
  geminiRole: string
  foundryRole: string
  codexModel?: string | null
  geminiModel?: string | null
  foundryModel?: string | null
  force?: boolean
  dryRun?: boolean
  diff?: boolean
  updatePrompts?: boolean
  updateFramework?: boolean
  profileId?: string | null
}

type FileStatus = "created" | "updated" | "kept"
type FileOwnership = "dispatcher-generated" | "autonomy-framework" | "profile-selected" | "repo-owned"
type FileKind =
  | "agent-prompt"
  | "bootstrap"
  | "repo-readme"
  | "gitignore"
  | "dispatcher-bin"
  | "repo-wrapper"
  | "profile-runtime"

type InstallFilePlan = {
  path: string
  relativePath: string
  ownership: FileOwnership
  kind: FileKind
  status: FileStatus
  reason: string
  diff: string | null
  beforeContent: string | null
  afterContent: string | null
  executable: boolean
}

type InstallSummary = {
  targetPath: string
  dbPath: string
  dryRun: boolean
  diff: boolean
  updatePrompts: boolean
  updateFramework: boolean
  companyCreated: boolean
  projectCreated: boolean
  codexCreated: boolean
  geminiCreated: boolean
  foundryCreated: boolean
  verifyCommand: string | null
  personasSynced: number
  jobsSynced: number
  routingRulesSynced: number
  filePlans: InstallFilePlan[]
  stateNote: string | null
  profileId: string | null
  manualSteps: string[]
  toolAgents: Array<{ name: string; adapterType: AdapterType; model: string | null; created: boolean }>
}

export type InstallTool = "codex" | "gemini" | "foundry"

type PlannedTextFileInput = {
  targetPath: string
  path: string
  ownership: FileOwnership
  kind: FileKind
  content: string
  overwrite: "always" | "force" | "never"
  force?: boolean
  reasonWhenOutOfScope?: string
  includeDiff?: boolean
  executable?: boolean
  skipWhenMissing?: boolean
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true })
}

function frameworkRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
}

function autonomyTemplateRoot(): string {
  return join(frameworkRoot(), "skills", "openclaw-autonomy-framework", "assets", "templates")
}

function renderUnifiedDiff(relativePath: string, beforeContent: string | null, afterContent: string): string | null {
  if (beforeContent === afterContent) {
    return null
  }

  const beforeLines = (beforeContent ?? "").split("\n")
  const afterLines = afterContent.split("\n")
  let prefix = 0

  while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) {
    prefix += 1
  }

  let beforeSuffix = beforeLines.length - 1
  let afterSuffix = afterLines.length - 1
  while (beforeSuffix >= prefix && afterSuffix >= prefix && beforeLines[beforeSuffix] === afterLines[afterSuffix]) {
    beforeSuffix -= 1
    afterSuffix -= 1
  }

  const lines = [`--- ${relativePath}`, `+++ ${relativePath}`]

  for (const line of beforeLines.slice(0, prefix)) {
    lines.push(` ${line}`)
  }

  for (const line of beforeLines.slice(prefix, beforeSuffix + 1)) {
    lines.push(`-${line}`)
  }

  for (const line of afterLines.slice(prefix, afterSuffix + 1)) {
    lines.push(`+${line}`)
  }

  for (const line of beforeLines.slice(beforeSuffix + 1)) {
    lines.push(` ${line}`)
  }

  return lines.join("\n")
}

function planTextFile(input: PlannedTextFileInput): InstallFilePlan {
  const existed = existsSync(input.path)
  const beforeContent = existed ? readFileSync(input.path, "utf8") : null
  const relativePath = relative(input.targetPath, input.path) || "."
  const diff = input.includeDiff ? renderUnifiedDiff(relativePath, beforeContent, input.content) : null

  if (!existed && input.skipWhenMissing) {
    return {
      path: input.path,
      relativePath,
      ownership: input.ownership,
      kind: input.kind,
      status: "kept",
      reason: input.reasonWhenOutOfScope ?? "not touched",
      diff: null,
      beforeContent,
      afterContent: beforeContent,
      executable: input.executable ?? false
    }
  }

  if (!existed) {
    return {
      path: input.path,
      relativePath,
      ownership: input.ownership,
      kind: input.kind,
      status: "created",
      reason: input.reasonWhenOutOfScope ?? "missing file will be generated",
      diff,
      beforeContent,
      afterContent: input.content,
      executable: input.executable ?? false
    }
  }

  if (beforeContent === input.content) {
    return {
      path: input.path,
      relativePath,
      ownership: input.ownership,
      kind: input.kind,
      status: "kept",
      reason: input.reasonWhenOutOfScope ?? "already matches generated content",
      diff: null,
      beforeContent,
      afterContent: input.content,
      executable: input.executable ?? false
    }
  }

  if (input.overwrite === "always" || (input.overwrite === "force" && input.force)) {
    return {
      path: input.path,
      relativePath,
      ownership: input.ownership,
      kind: input.kind,
      status: "updated",
      reason: input.reasonWhenOutOfScope ?? "existing file will be refreshed",
      diff,
      beforeContent,
      afterContent: input.content,
      executable: input.executable ?? false
    }
  }

  const reason =
    input.reasonWhenOutOfScope ??
    (input.overwrite === "never"
      ? "repo-owned file is preserved"
      : "existing file differs and is preserved unless you pass --force")

  return {
    path: input.path,
    relativePath,
    ownership: input.ownership,
    kind: input.kind,
    status: "kept",
    reason,
    diff,
    beforeContent,
    afterContent: input.content,
    executable: input.executable ?? false
  }
}

function planGitignore(
  targetPath: string,
  includeDiff: boolean,
  updatePrompts: boolean,
  updateFramework: boolean
): InstallFilePlan {
  const gitignorePath = join(targetPath, ".gitignore")
  const entries = ["# OpenClaw dispatcher runtime", ".openclaw/dispatcher.db", ".openclaw/logs/"]
  const current = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : ""
  const missing = entries.filter((entry) => !current.includes(entry))
  const prefix = current.trimEnd()
  const next = [prefix, prefix ? "" : null, ...missing].filter((value): value is string => value !== null).join("\n")
  const afterContent = `${next}\n`

  if (updatePrompts || updateFramework) {
    return {
      path: gitignorePath,
      relativePath: relative(targetPath, gitignorePath) || ".",
      ownership: "repo-owned",
      kind: "gitignore",
      status: "kept",
      reason: updatePrompts ? "not touched by --update-prompts" : "not touched by --update-framework",
      diff: null,
      beforeContent: existsSync(gitignorePath) ? current : null,
      afterContent: existsSync(gitignorePath) ? current : afterContent,
      executable: false
    }
  }

  if (missing.length === 0) {
    return {
      path: gitignorePath,
      relativePath: relative(targetPath, gitignorePath) || ".",
      ownership: "repo-owned",
      kind: "gitignore",
      status: "kept",
      reason: "dispatcher ignore entries are already present",
      diff: null,
      beforeContent: existsSync(gitignorePath) ? current : null,
      afterContent: existsSync(gitignorePath) ? current : afterContent,
      executable: false
    }
  }

  return {
    path: gitignorePath,
    relativePath: relative(targetPath, gitignorePath) || ".",
    ownership: "repo-owned",
    kind: "gitignore",
    status: existsSync(gitignorePath) ? "updated" : "created",
    reason: "adds dispatcher runtime paths while leaving repo-owned ignore rules intact",
    diff: includeDiff
      ? renderUnifiedDiff(
          relative(targetPath, gitignorePath) || ".",
          existsSync(gitignorePath) ? current : null,
          afterContent
        )
      : null,
    beforeContent: existsSync(gitignorePath) ? current : null,
    afterContent,
    executable: false
  }
}

function addSection(lines: string[], title: string, items: string[]): void {
  if (items.length === 0) return

  lines.push("", `## ${title}`, "")
  for (const item of items) {
    lines.push(`- ${item}`)
  }
}

function formatRead(item: RepoInstructionItem): string {
  return `\`${item.path}\` - ${item.reason}`
}

function formatStack(profile: RepoStackProfile): string {
  const stackSuffix = profile.stack.length > 0 ? ` (${profile.stack.join(", ")})` : ""
  return `\`${profile.path}\` - ${profile.label}${stackSuffix}`
}

function formatContract(profile: RepoContractProfile): string {
  return `\`${profile.path}\` - ${profile.label}`
}

function formatLaneDoc(profile: RepoLaneDocProfile): string {
  return `\`${profile.path}\` - ${profile.label}`
}

function formatSignal(profile: RepoControlPlaneSignal): string {
  return `\`${profile.path}\` - ${profile.note}`
}

function formatVerify(command: RepoVerifyCommand): string {
  return `\`${command.command}\` - ${command.reason}`
}

function codexInstructions(projectName: string, context: RepoContext): string {
  const lines = [
    "# Codex Coder",
    "",
    `You are the primary implementation agent for ${projectName}.`,
    "",
    "## Focus",
    "",
    "- Backend work, architecture, tests, contracts, refactors, automation, and general coding tasks",
    "- Use the repo profile below to pick the right backend lane, contract surface, and verification commands before editing",
    "- Prefer safe, incremental changes with clear verification",
    "- Preserve existing workflows and lane ownership instead of broadening scope",
    "- End each run with a concise summary of what changed, what was verified, or what blocked progress",
    "- Use the `/caveman full` skill to reduce token output and communicate tersely"
  ]

  addSection(lines, "Read First", context.sharedReadItems.map(formatRead))
  addSection(lines, "Backend Reading", context.codexReadItems.map(formatRead))
  addSection(lines, "Detected Stacks", context.stackProfiles.map(formatStack))
  addSection(lines, "Contracts", context.contractProfiles.map(formatContract))
  addSection(lines, "Lane Docs", context.laneDocProfiles.map(formatLaneDoc))
  addSection(lines, "Control Plane Signals", context.controlPlaneSignals.map(formatSignal))
  addSection(lines, "Repo Notes", context.repoNotes)

  lines.push(
    "",
    "## Working Style",
    "",
    "- Treat Codex as the default executor for implementation work",
    "- Deliver the assigned vertical feature slice end to end while keeping unrelated changes out of scope",
    "- If a backend change affects contracts, update the canonical contract, tests, and dependent clients together"
  )

  addSection(lines, "Verification", context.codexVerifyCommands.map(formatVerify))

  return lines.join("\n")
}

function geminiInstructions(projectName: string, context: RepoContext): string {
  const lines = [
    "# Gemini UI",
    "",
    `You are the UI and design-focused implementation agent for ${projectName}.`,
    "",
    "## Focus",
    "",
    "- Frontend, UX, visual polish, copy, layout, and interaction design",
    "- Use the repo profile below to find the active frontend lane, supporting docs, and route-level verification commands before editing",
    "- Preserve the existing design language unless the task explicitly asks for redesign",
    "- Respect ownership boundaries and route-level consistency instead of shipping isolated polish",
    "- End each run with a concise summary of the UI or UX changes made and how they were checked",
    "- Use the `/caveman full` skill to reduce token output and communicate tersely"
  ]

  addSection(lines, "Read First", context.sharedReadItems.map(formatRead))
  addSection(lines, "UI Reading", context.geminiReadItems.map(formatRead))
  addSection(lines, "Detected Stacks", context.stackProfiles.map(formatStack))
  addSection(lines, "Contracts", context.contractProfiles.map(formatContract))
  addSection(lines, "Lane Docs", context.laneDocProfiles.map(formatLaneDoc))
  addSection(lines, "Control Plane Signals", context.controlPlaneSignals.map(formatSignal))
  addSection(lines, "Repo Notes", context.repoNotes)

  lines.push(
    "",
    "## Working Style",
    "",
    "- Use the existing frontend architecture and shared UI primitives before inventing new patterns",
    "- When route surfaces change, include route-consistency and UI audit thinking in the task",
    "- Keep visual changes intentional, but do not drift from the repo's established product language unless asked"
  )

  addSection(lines, "Verification", context.geminiVerifyCommands.map(formatVerify))

  return lines.join("\n")
}

function foundryInstructions(projectName: string, context: RepoContext): string {
  const lines = [
    "# Foundry Kimi Strategist",
    "",
    `You are the Azure Foundry / Kimi planning and review agent for ${projectName}.`,
    "",
    "## Focus",
    "",
    "- Long-context planning, architectural critique, review strategy, governance checks, and risky-change analysis",
    "- Use the repo profile below to identify contracts, lane boundaries, required reading, and verification gates",
    "- Prefer written proposals, review findings, and task decomposition over direct implementation unless explicitly assigned",
    "- Call out unclear ownership, missing verification, and cross-lane coupling before recommending execution",
    "- End each run with concrete next actions, affected lanes, and verification requirements"
  ]

  addSection(lines, "Read First", context.sharedReadItems.map(formatRead))
  addSection(
    lines,
    "Planning And Review Reading",
    [...context.codexReadItems, ...context.geminiReadItems].map(formatRead)
  )
  addSection(lines, "Detected Stacks", context.stackProfiles.map(formatStack))
  addSection(lines, "Contracts", context.contractProfiles.map(formatContract))
  addSection(lines, "Lane Docs", context.laneDocProfiles.map(formatLaneDoc))
  addSection(lines, "Control Plane Signals", context.controlPlaneSignals.map(formatSignal))
  addSection(lines, "Repo Notes", context.repoNotes)

  lines.push(
    "",
    "## Working Style",
    "",
    "- Treat Kimi/Foundry as the high-context planner and reviewer lane",
    "- Keep recommendations grounded in repo evidence and explicit risk",
    "- Do not turn proposals into code changes unless the task explicitly asks for implementation"
  )

  addSection(lines, "Verification", [...context.codexVerifyCommands, ...context.geminiVerifyCommands].map(formatVerify))

  return lines.join("\n")
}

function normalizeInstallTools(tools: InstallTool[] | null | undefined): InstallTool[] {
  const requested: InstallTool[] = tools && tools.length > 0 ? tools : ["codex", "gemini"]
  return Array.from(new Set(requested)).sort((left, right) => {
    const order: InstallTool[] = ["codex", "gemini", "foundry"]
    return order.indexOf(left) - order.indexOf(right)
  })
}

function dispatcherReadme(input: {
  companyName: string
  projectName: string
  verifyCommand: string | null
  codexName: string
  geminiName: string
  foundryName: string
  tools: InstallTool[]
  profile: ProjectProfile | null
}): string {
  const frameworkDir = frameworkRoot()
  const coreManaged = CORE_INSTALL_SURFACE.coreManagedFiles.map((item) => `- ${item}`)
  const autonomyManaged = [
    "- `.openclaw/agents/main.md`, `planner.md`, `reviewer.md`, `promoter.md`",
    "- `.openclaw/state/README.md`",
    "- generic `.openclaw/state/bootstrap/*.json` queue, category, and policy seeds"
  ]
  const profileManaged = input.profile
    ? [
        `- ${input.profile.profileId} profile data and bootstrap state`,
        ...CORE_INSTALL_SURFACE.profileManagedFiles.map((item) => `- ${item}`)
      ]
    : ["- No built-in profile was selected during install."]
  const manualFollowUp = input.profile?.adoptionPolicy.manualSteps ?? CORE_INSTALL_SURFACE.manualFollowUp

  return [
    "# OpenClaw Dispatcher Bootstrap",
    "",
    "This repository has been bootstrapped for the OpenClaw dispatcher framework.",
    "",
    `- Company: ${input.companyName}`,
    `- Project: ${input.projectName}`,
    `- Verify command: ${input.verifyCommand ?? "not auto-detected"}`,
    `- Installed profile: ${input.profile?.profileId ?? "none"}`,
    `- Enabled tools: ${input.tools.join(", ")}`,
    `- Default coding agent: ${input.tools.includes("codex") ? input.codexName : "not installed"}`,
    `- Default UI agent: ${input.tools.includes("gemini") ? input.geminiName : "not installed"}`,
    `- Default Foundry/Kimi agent: ${input.tools.includes("foundry") ? input.foundryName : "not installed"}`,
    "",
    "## Common commands",
    "",
    "Run these from the target repository:",
    "",
    "```bash",
    "./scripts/openclaw-dispatcher.sh doctor",
    "./scripts/openclaw-dispatcher.sh install . --update-framework",
    `./scripts/openclaw-dispatcher.sh task create "Your task title" --project "${input.projectName}"`,
    "./scripts/openclaw-dispatcher.sh tick",
    "./scripts/openclaw-dispatcher.sh run list",
    "```",
    "",
    "Override the framework checkout by exporting `OPENCLAW_DISPATCHER_FRAMEWORK_DIR` before running the wrapper.",
    "Use `install . --update-framework` after rebuilding or switching the framework checkout. It refreshes repo-local runtime shims without rewriting dispatcher database state, queued work, or generated prompts.",
    "",
    `Default framework directory detected during install: \`${frameworkDir}\``,
    "",
    "The generated agent instruction files under `.openclaw/agents/` use a structured repo profile when the target project already exposes guidance such as `AGENTS.md`, frontend/backend lane docs, contracts, or an existing `.openclaw` control plane.",
    "",
    "## Installed By Core",
    "",
    ...coreManaged,
    "",
    "## Installed By Autonomy Framework",
    "",
    ...autonomyManaged,
    "",
    "## Installed By Selected Profile",
    "",
    ...profileManaged,
    "",
    "## Manual Follow-Up",
    "",
    ...manualFollowUp.map((step) => `- ${step}`)
  ].join("\n")
}

function dispatcherBinScript(): string {
  const frameworkDir = frameworkRoot()

  return [
    "#!/bin/sh",
    "set -eu",
    "",
    `FRAMEWORK_DIR="${frameworkDir}"`,
    `if [ -n "\${OPENCLAW_DISPATCHER_FRAMEWORK_DIR:-}" ]; then`,
    '  FRAMEWORK_DIR="$OPENCLAW_DISPATCHER_FRAMEWORK_DIR"',
    "fi",
    "",
    'exec node "$FRAMEWORK_DIR/apps/dispatcher-cli/dist/index.js" "$@"'
  ].join("\n")
}

function repoWrapperScript(): string {
  return [
    "#!/bin/sh",
    "set -eu",
    "",
    'REPO_ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"',
    'DB_PATH="$REPO_ROOT/.openclaw/dispatcher.db"',
    `FRAMEWORK_DIR="\${OPENCLAW_DISPATCHER_FRAMEWORK_DIR:-$HOME/.openclaw/workspace}"`,
    'DISPATCHER="$REPO_ROOT/.openclaw/bin/dispatcher"',
    "USE_NODE_DISPATCHER=0",
    "",
    'if [ ! -x "$DISPATCHER" ]; then',
    '  if [ -x "$FRAMEWORK_DIR/.openclaw/bin/dispatcher" ]; then',
    '    DISPATCHER="$FRAMEWORK_DIR/.openclaw/bin/dispatcher"',
    '  elif [ -f "$FRAMEWORK_DIR/apps/dispatcher-cli/dist/index.js" ]; then',
    '    DISPATCHER="$FRAMEWORK_DIR/apps/dispatcher-cli/dist/index.js"',
    "    USE_NODE_DISPATCHER=1",
    "  else",
    '    echo "dispatcher wrapper: dispatcher not found" >&2',
    '    echo "checked: $REPO_ROOT/.openclaw/bin/dispatcher" >&2',
    '    echo "checked: $FRAMEWORK_DIR/.openclaw/bin/dispatcher" >&2',
    '    echo "checked: $FRAMEWORK_DIR/apps/dispatcher-cli/dist/index.js" >&2',
    "    exit 127",
    "  fi",
    "fi",
    "",
    `if [ "\${1:-}" = "doctor" ]; then`,
    '  echo "dispatcher wrapper: ok"',
    '  echo "repo: $REPO_ROOT"',
    '  echo "db: $DB_PATH"',
    '  echo "framework: $FRAMEWORK_DIR"',
    '  echo "dispatcher: $DISPATCHER"',
    "  exit 0",
    "fi",
    "",
    'if [ "$USE_NODE_DISPATCHER" = "1" ]; then',
    '  exec node "$DISPATCHER" --db "$DB_PATH" "$@"',
    "fi",
    "",
    'exec "$DISPATCHER" --db "$DB_PATH" "$@"'
  ].join("\n")
}

function listFilesRecursive(root: string): string[] {
  const results: string[] = []

  function walk(current: string): void {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolutePath = join(current, entry.name)
      if (entry.isDirectory()) {
        walk(absolutePath)
        continue
      }
      if (entry.isFile()) {
        results.push(absolutePath)
      }
    }
  }

  walk(root)
  return results.sort()
}

function renderAutonomyTemplate(
  content: string,
  input: {
    projectName: string
    repoSlug: string
    repoRoot: string
  }
): string {
  return content
    .replaceAll("__PROJECT_NAME__", input.projectName)
    .replaceAll("__REPO_SLUG__", input.repoSlug)
    .replaceAll("__REPO_ROOT__", input.repoRoot)
}

function inferRepoSlug(targetPath: string): string {
  try {
    const originUrl = readFileSync(join(targetPath, ".git", "config"), "utf8")
    const match =
      /url\s*=\s*git@github\.com:([^\s]+?)(?:\.git)?$/m.exec(originUrl) ??
      /url\s*=\s*https:\/\/github\.com\/([^\s]+?)(?:\.git)?$/m.exec(originUrl)
    return match?.[1] ?? "owner/repo"
  } catch {
    return "owner/repo"
  }
}

function inferPersonaStage(personaId: string): PersonaStage {
  const normalized = personaId.toLowerCase()
  if (normalized.includes("plan")) return "planner"
  if (normalized.includes("review") || normalized.includes("qa") || normalized.includes("security")) return "reviewer"
  if (normalized.includes("promot") || normalized.includes("release")) return "promoter"
  return "coder"
}

function personaInstructionsPath(targetPath: string, personaId: string): string | null {
  const knownAgentFileByPersona = new Map<string, string>([
    ["planner", ".openclaw/agents/planner.md"],
    ["code-reviewer", ".openclaw/agents/reviewer.md"],
    ["qa-engineer", ".openclaw/agents/reviewer.md"],
    ["release-manager", ".openclaw/agents/promoter.md"]
  ])
  const relativePath = knownAgentFileByPersona.get(personaId)
  return relativePath ? join(targetPath, relativePath) : null
}

function syncPersonaDefinitions(
  store: DispatcherStore,
  companyId: string,
  targetPath: string,
  definitions: PersonaDefinition[]
): number {
  let synced = 0

  for (const definition of definitions) {
    store.upsertPersona({
      companyRef: companyId,
      name: definition.id,
      stage: inferPersonaStage(definition.id),
      ownedLanes: definition.allowedLanes,
      preferredAdapterType: definition.defaultAdapterPreference,
      instructionsPath: personaInstructionsPath(targetPath, definition.id),
      status: "active" as const
    })
    synced += 1
  }

  return synced
}

function syncManagerPersonas(store: DispatcherStore, companyId: string, profile: ProjectProfile): number {
  let synced = 0

  for (const manager of profile.managerStateDefaults.managerPersonas) {
    store.upsertPersona({
      companyRef: companyId,
      name: manager.id,
      stage: inferPersonaStage(manager.id),
      ownedLanes: manager.ownedLaneIds,
      preferredAdapterType: manager.preferredAdapterType,
      instructionsPath: null,
      status: "active" as const
    })
    synced += 1
  }

  return synced
}

function syncProfileRuntime(
  store: DispatcherStore,
  input: {
    companyId: string
    projectId: string
    targetPath: string
    profile: ProjectProfile | null
  }
): { personasSynced: number; jobsSynced: number; routingRulesSynced: number } {
  if (!input.profile) {
    return { personasSynced: 0, jobsSynced: 0, routingRulesSynced: 0 }
  }

  let routingRulesSynced = 0
  for (const rule of input.profile.routingRules) {
    const current = store.findRoutingRuleByName(rule.name)
    if (!current) {
      store.createRoutingRule({
        name: rule.name,
        priority: rule.priority,
        targetAdapterType: rule.targetAdapterType,
        patterns: rule.patterns,
        isFallback: rule.isFallback ?? false
      })
    } else {
      store.updateRoutingRule(current.id, {
        priority: rule.priority,
        targetAdapterType: rule.targetAdapterType,
        patterns: rule.patterns,
        isFallback: rule.isFallback ?? false
      })
    }
    routingRulesSynced += 1
  }

  let jobsSynced = 0
  for (const job of input.profile.jobDefinitions) {
    store.upsertJobSpec({
      companyId: input.companyId,
      projectId: input.projectId,
      jobId: job.jobId,
      sourcePath: `.openclaw/jobs/${job.jobId}.json`,
      cron: job.cron,
      timezone: job.timezone,
      entryAgent: job.entryAgent ?? null
    })
    jobsSynced += 1
  }

  return {
    personasSynced:
      syncPersonaDefinitions(
        store,
        input.companyId,
        input.targetPath,
        loadProjectProfilePersonas(input.profile.profileId)
      ) + syncManagerPersonas(store, input.companyId, input.profile),
    jobsSynced,
    routingRulesSynced
  }
}

function autonomyFrameworkPlans(options: {
  targetPath: string
  projectName: string
  force: boolean
  diff: boolean
  updatePrompts: boolean
  skippedPaths?: Set<string>
}): InstallFilePlan[] {
  if (options.updatePrompts) {
    return []
  }

  const templateRoot = autonomyTemplateRoot()
  const repoSlug = existsSync(join(options.targetPath, ".git", "config"))
    ? inferRepoSlug(options.targetPath)
    : "owner/repo"

  return listFilesRecursive(templateRoot)
    .filter((absolutePath) => !absolutePath.endsWith("/.openclaw/README.md"))
    .map((absolutePath) => {
      const relativeTemplatePath = relative(templateRoot, absolutePath)
      const targetFilePath = join(options.targetPath, relativeTemplatePath)
      if (options.skippedPaths?.has(targetFilePath)) {
        return null
      }
      const content = renderAutonomyTemplate(readFileSync(absolutePath, "utf8"), {
        projectName: options.projectName,
        repoSlug,
        repoRoot: options.targetPath
      })

      return planTextFile({
        targetPath: options.targetPath,
        path: targetFilePath,
        ownership: "autonomy-framework",
        kind: "profile-runtime",
        content,
        overwrite: "force",
        force: options.force,
        reasonWhenOutOfScope:
          "generic autonomy scaffold is seeded when missing and preserved once repo-owned or profile-owned content exists",
        includeDiff: options.diff
      })
    })
    .filter((file): file is InstallFilePlan => file !== null)
}

function importedSkillSeedPlans(options: {
  targetPath: string
  force: boolean
  diff: boolean
  updatePrompts: boolean
}): InstallFilePlan[] {
  if (options.updatePrompts) return []
  const skills = [
    {
      id: "error-recovery",
      title: "Error Recovery",
      source: "skills/error-recovery/SKILL.md",
      use: "Use when an agent hits repeated failures, flaky commands, missing dependencies, or ambiguous retry/fallback decisions."
    },
    {
      id: "reflect",
      title: "Reflect",
      source: "skills/reflect/SKILL.md",
      use: "Use after repeated mistakes or corrective feedback to capture a short reusable lesson."
    },
    {
      id: "tiered-memory",
      title: "Tiered Memory",
      source: "skills/tiered-memory/SKILL.md",
      use: "Use to decide whether context belongs in hot session memory, durable project memory, or repo documentation."
    },
    {
      id: "loop-budget",
      title: "Loop Budget",
      source: "skills/loop-budget/SKILL.md",
      use: "Use to evaluate and log daily token expenditure caps and force early termination when over budget."
    },
    {
      id: "loop-triage",
      title: "Loop Triage",
      source: "skills/loop-triage/SKILL.md",
      use: "Use to scan for new issues, CI failures, commits, or chat threads to compile a prioritized task list."
    },
    {
      id: "loop-verifier",
      title: "Loop Verifier",
      source: "skills/loop-verifier/SKILL.md",
      use: "Use as an independent checker in a maker/checker split to verify diff scope and execute test suites."
    },
    {
      id: "minimal-fix",
      title: "Minimal Fix",
      source: "skills/minimal-fix/SKILL.md",
      use: "Use to produce the smallest possible code change that addresses only the targeted issue without refactoring unrelated code."
    }
  ]

  return skills.map((skill) =>
    planTextFile({
      targetPath: options.targetPath,
      path: join(options.targetPath, ".openclaw", "skills", `${skill.id}.md`),
      ownership: "repo-owned",
      kind: "profile-runtime",
      content: [
        `# ${skill.title}`,
        "",
        `Source skill: \`${skill.source}\` in the OpenClaw framework checkout.`,
        "",
        "## When To Use",
        "",
        skill.use,
        "",
        "## Operator Note",
        "",
        "This repo-owned seed is intentionally small. Replace it with local project guidance if your team needs a stricter workflow."
      ].join("\n"),
      overwrite: "never",
      force: options.force,
      reasonWhenOutOfScope: "repo-owned imported skill seed is created only when missing",
      includeDiff: options.diff
    })
  )
}

function planInstallFiles(options: {
  targetPath: string
  companyName: string
  projectName: string
  verifyCommand: string | null
  codexName: string
  geminiName: string
  foundryName: string
  tools: InstallTool[]
  force: boolean
  diff: boolean
  updatePrompts: boolean
  updateFramework: boolean
  repoContext: RepoContext
  profile: ProjectProfile | null
}): InstallFilePlan[] {
  const openclawDir = join(options.targetPath, ".openclaw")
  const agentsDir = join(openclawDir, "agents")
  const codexPath = join(agentsDir, `${options.codexName}.md`)
  const geminiPath = join(agentsDir, `${options.geminiName}.md`)
  const foundryPath = join(agentsDir, `${options.foundryName}.md`)
  const bootstrapPath = join(openclawDir, "dispatcher-bootstrap.md")
  const readmePath = join(openclawDir, "README.md")
  const dispatcherBinPath = join(openclawDir, "bin", "dispatcher")
  const wrapperPath = join(options.targetPath, "scripts", "openclaw-dispatcher.sh")
  const bootstrapContent = dispatcherReadme({
    companyName: options.companyName,
    projectName: options.projectName,
    verifyCommand: options.verifyCommand,
    codexName: options.codexName,
    geminiName: options.geminiName,
    foundryName: options.foundryName,
    tools: options.tools,
    profile: options.profile
  })

  const promptOverwrite = options.updatePrompts ? "always" : "force"

  const promptPlans: InstallFilePlan[] = [
    ...(!options.updateFramework && options.tools.includes("codex")
      ? [
          planTextFile({
            targetPath: options.targetPath,
            path: codexPath,
            ownership: "dispatcher-generated" as const,
            kind: "agent-prompt" as const,
            content: codexInstructions(options.projectName, options.repoContext),
            overwrite: promptOverwrite,
            force: options.force,
            ...(options.updatePrompts
              ? {}
              : {
                  reasonWhenOutOfScope:
                    "existing prompt differs and is preserved unless you pass --force or --update-prompts"
                }),
            includeDiff: options.diff
          })
        ]
      : []),
    ...(!options.updateFramework && options.tools.includes("gemini")
      ? [
          planTextFile({
            targetPath: options.targetPath,
            path: geminiPath,
            ownership: "dispatcher-generated" as const,
            kind: "agent-prompt" as const,
            content: geminiInstructions(options.projectName, options.repoContext),
            overwrite: promptOverwrite,
            force: options.force,
            ...(options.updatePrompts
              ? {}
              : {
                  reasonWhenOutOfScope:
                    "existing prompt differs and is preserved unless you pass --force or --update-prompts"
                }),
            includeDiff: options.diff
          })
        ]
      : []),
    ...(!options.updateFramework && options.tools.includes("foundry")
      ? [
          planTextFile({
            targetPath: options.targetPath,
            path: foundryPath,
            ownership: "dispatcher-generated" as const,
            kind: "agent-prompt" as const,
            content: foundryInstructions(options.projectName, options.repoContext),
            overwrite: promptOverwrite,
            force: options.force,
            ...(options.updatePrompts
              ? {}
              : {
                  reasonWhenOutOfScope:
                    "existing prompt differs and is preserved unless you pass --force or --update-prompts"
                }),
            includeDiff: options.diff
          })
        ]
      : [])
  ]

  const bootstrapPlan = planTextFile({
    targetPath: options.targetPath,
    path: bootstrapPath,
    ownership: "dispatcher-generated",
    kind: "bootstrap",
    content: bootstrapContent,
    overwrite: options.updatePrompts || options.updateFramework ? "never" : "force",
    force: options.force,
    reasonWhenOutOfScope: options.updatePrompts
      ? "not touched by --update-prompts"
      : options.updateFramework
        ? "not touched by --update-framework"
        : "existing bootstrap note is preserved unless you pass --force",
    includeDiff: options.diff,
    skipWhenMissing: options.updatePrompts || options.updateFramework
  })

  const dispatcherBinPlan = planTextFile({
    targetPath: options.targetPath,
    path: dispatcherBinPath,
    ownership: "dispatcher-generated",
    kind: "dispatcher-bin",
    content: dispatcherBinScript(),
    overwrite: options.updateFramework ? "always" : options.updatePrompts ? "never" : "force",
    force: options.force,
    reasonWhenOutOfScope: options.updatePrompts
      ? "not touched by --update-prompts"
      : options.updateFramework
        ? "repo-local dispatcher shim is checked and refreshed to point at the current framework checkout"
        : "existing dispatcher shim is preserved unless you pass --force",
    includeDiff: options.diff,
    executable: true,
    skipWhenMissing: options.updatePrompts
  })

  const repoWrapperPlan = planTextFile({
    targetPath: options.targetPath,
    path: wrapperPath,
    ownership: "dispatcher-generated",
    kind: "repo-wrapper",
    content: repoWrapperScript(),
    overwrite: options.updatePrompts ? "never" : "force",
    force: options.force,
    reasonWhenOutOfScope: options.updatePrompts
      ? "not touched by --update-prompts"
      : options.updateFramework
        ? "repo-local wrapper is created when missing and preserved during framework refresh unless you pass --force"
        : "existing repo-local wrapper is preserved unless you pass --force",
    includeDiff: options.diff,
    executable: true,
    skipWhenMissing: options.updatePrompts
  })

  const readmePlan = planTextFile({
    targetPath: options.targetPath,
    path: readmePath,
    ownership: "repo-owned",
    kind: "repo-readme",
    content: bootstrapContent,
    overwrite: "never",
    reasonWhenOutOfScope: options.updatePrompts
      ? "not touched by --update-prompts"
      : options.updateFramework
        ? "not touched by --update-framework"
        : existsSync(readmePath)
          ? "repo-owned README is preserved"
          : "missing repo-owned README will be seeded with dispatcher guidance",
    includeDiff: false,
    skipWhenMissing: options.updatePrompts || options.updateFramework
  })

  const dispatcherPlans: InstallFilePlan[] = options.updateFramework
    ? [dispatcherBinPlan, repoWrapperPlan]
    : [
        ...promptPlans,
        bootstrapPlan,
        dispatcherBinPlan,
        repoWrapperPlan,
        readmePlan,
        planGitignore(options.targetPath, false, options.updatePrompts, options.updateFramework)
      ]

  const profileInstallFiles =
    options.updatePrompts || options.updateFramework || !options.profile
      ? []
      : projectProfileInstallFiles(options.targetPath, options.profile)

  const profilePlans = profileInstallFiles.map((file) =>
    planTextFile({
      targetPath: options.targetPath,
      path: file.absolutePath,
      ownership: "profile-selected",
      kind: "profile-runtime",
      content: file.content,
      overwrite: "force",
      force: options.force,
      reasonWhenOutOfScope: file.reason,
      includeDiff: options.diff
    })
  )

  const autonomyPlans = options.updateFramework
    ? []
    : autonomyFrameworkPlans({
        targetPath: options.targetPath,
        projectName: options.projectName,
        force: options.force,
        diff: options.diff,
        updatePrompts: options.updatePrompts,
        skippedPaths: new Set(profileInstallFiles.map((file) => file.absolutePath))
      })

  const skillPlans = options.updateFramework
    ? []
    : importedSkillSeedPlans({
        targetPath: options.targetPath,
        force: options.force,
        diff: options.diff,
        updatePrompts: options.updatePrompts
      })

  return [...dispatcherPlans, ...skillPlans, ...autonomyPlans, ...profilePlans]
}

function applyFilePlans(filePlans: InstallFilePlan[]): void {
  for (const file of filePlans) {
    if (file.status === "kept") {
      continue
    }

    ensureDir(dirname(file.path))
    writeFileSync(file.path, file.afterContent ?? "", "utf8")
    if (file.executable) {
      chmodSync(file.path, 0o755)
    }
  }
}

function ensureCompany(store: DispatcherStore, name: string): { id: string; created: boolean } {
  try {
    const existing = store.resolveCompany(name)
    return { id: existing.id, created: false }
  } catch {
    const created = store.createCompany({ name })
    return { id: created.id, created: true }
  }
}

function ensureProject(
  store: DispatcherStore,
  companyId: string,
  name: string,
  repoPath: string,
  verifyCommand: string | null,
  profile: ProjectProfile | null
): { created: boolean } {
  try {
    const existing = store.resolveProject(name, companyId)
    store.updateProject(existing.id, {
      verifyCommand,
      profileId: profile?.profileId ?? null,
      profilePath: profile ? join(repoPath, ".openclaw", "profile.json") : null,
      profile: profile ? (profile as unknown as Record<string, unknown>) : {}
    })
    return { created: false }
  } catch {
    store.createProject({
      companyRef: companyId,
      name,
      repoPath,
      verifyCommand,
      profileId: profile?.profileId ?? null,
      profilePath: profile ? join(repoPath, ".openclaw", "profile.json") : null,
      profile: profile ? (profile as unknown as Record<string, unknown>) : {}
    })
    return { created: true }
  }
}

function ensureAgent(
  store: DispatcherStore,
  input: {
    companyId: string
    name: string
    role: string
    adapterType: AdapterType
    instructionsPath: string
    model?: string | null
  }
): { created: boolean } {
  try {
    store.resolveAgent(input.name, input.companyId)
    return { created: false }
  } catch {
    store.createAgent({
      companyRef: input.companyId,
      name: input.name,
      role: input.role,
      adapterType: input.adapterType,
      instructionsPath: input.instructionsPath,
      model: input.model ?? null
    })
    return { created: true }
  }
}

export function installDispatcherFramework(options: InstallOptions): InstallSummary {
  const targetPath = resolve(options.targetPath)
  const dryRun = options.dryRun ?? false
  const diff = options.diff ?? false
  const updatePrompts = options.updatePrompts ?? false
  const updateFramework = options.updateFramework ?? false
  const force = options.force ?? false
  const tools = normalizeInstallTools(options.tools)

  if (updatePrompts && updateFramework) {
    throw new Error("--update-prompts and --update-framework are separate scoped refresh modes; choose one")
  }

  if (!dryRun) {
    ensureDir(targetPath)
  }

  const projectName = options.projectName?.trim() || basename(targetPath)
  const companyName = options.companyName?.trim() || `${projectName} Company`
  const verifyCommand = options.verifyCommand ?? detectVerifyCommand(targetPath)
  const repoContext = detectRepoContext(targetPath, verifyCommand)
  const profileId = options.profileId?.trim() || (bestProfileMatch(targetPath)?.profileId ?? null)
  const profile = profileId ? loadProjectProfile(profileId) : null
  const dbPath = DispatcherStore.defaultDbPath(targetPath)
  const filePlans = planInstallFiles({
    targetPath,
    companyName,
    projectName,
    verifyCommand,
    codexName: options.codexName,
    geminiName: options.geminiName,
    foundryName: options.foundryName,
    tools,
    force,
    diff,
    updatePrompts,
    updateFramework,
    repoContext,
    profile
  })

  const manualSteps = [...(profile?.adoptionPolicy.manualSteps ?? CORE_INSTALL_SURFACE.manualFollowUp)]
  if (profile?.stateBackend) {
    try {
      const syncPlan = planOpenClawStateSync(profile.stateBackend)
      if (syncPlan.backend.mode !== "workspace") {
        manualSteps.push(`Configure Git state sync: ${syncPlan.description}`)
        for (const cmd of syncPlan.operatorCommands) {
          manualSteps.push(`  Run operator sync command: ${cmd}`)
        }
        if (syncPlan.backend.syncHooks) {
          if (syncPlan.hookCommands.preCommit.length > 0) {
            manualSteps.push(`  Add pre-commit hook: ${syncPlan.hookCommands.preCommit.join(" && ")}`)
          }
          if (syncPlan.hookCommands.postMerge.length > 0) {
            manualSteps.push(`  Add post-merge hook: ${syncPlan.hookCommands.postMerge.join(" && ")}`)
          }
        }
      }
    } catch (err) {
      manualSteps.push(`Failed to plan state backend sync: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (dryRun) {
    return {
      targetPath,
      dbPath,
      dryRun,
      diff,
      updatePrompts,
      updateFramework,
      companyCreated: false,
      projectCreated: false,
      codexCreated: false,
      geminiCreated: false,
      foundryCreated: false,
      verifyCommand,
      personasSynced: 0,
      jobsSynced: 0,
      routingRulesSynced: 0,
      filePlans,
      profileId,
      manualSteps,
      toolAgents: [],
      stateNote: updatePrompts
        ? "Dry run only. --update-prompts limits changes to generated agent prompts and leaves dispatcher state untouched."
        : updateFramework
          ? "Dry run only. --update-framework limits changes to repo-local dispatcher runtime shims and leaves dispatcher state untouched."
          : existsSync(dbPath)
            ? "Dry run only. The dispatcher database already exists and would be reused when you rerun without --dry-run."
            : "Dry run only. The dispatcher database plus default company, project, and agent records would be created when you rerun without --dry-run."
    }
  }

  applyFilePlans(filePlans)

  if (updatePrompts || updateFramework) {
    return {
      targetPath,
      dbPath,
      dryRun,
      diff,
      updatePrompts,
      updateFramework,
      companyCreated: false,
      projectCreated: false,
      codexCreated: false,
      geminiCreated: false,
      foundryCreated: false,
      verifyCommand,
      personasSynced: 0,
      jobsSynced: 0,
      routingRulesSynced: 0,
      filePlans,
      profileId,
      manualSteps: profile?.adoptionPolicy.manualSteps ?? CORE_INSTALL_SURFACE.manualFollowUp,
      toolAgents: [],
      stateNote: updatePrompts
        ? "Prompt refresh only. Dispatcher database, company/project records, and bootstrap files were left untouched."
        : "Framework refresh only. Dispatcher database, queued work, company/project records, and generated prompts were left untouched."
    }
  }

  const store = new DispatcherStore(dbPath)
  store.migrate()

  try {
    const company = ensureCompany(store, companyName)
    const project = ensureProject(store, company.id, projectName, targetPath, verifyCommand, profile)
    const toolAgents: InstallSummary["toolAgents"] = []
    if (tools.includes("codex")) {
      const codex = ensureAgent(store, {
        companyId: company.id,
        name: options.codexName,
        role: options.codexRole,
        adapterType: "codex_local",
        instructionsPath: join(targetPath, ".openclaw", "agents", `${options.codexName}.md`),
        model: options.codexModel ?? null
      })
      toolAgents.push({
        name: options.codexName,
        adapterType: "codex_local",
        model: options.codexModel ?? null,
        created: codex.created
      })
    }
    if (tools.includes("gemini")) {
      const gemini = ensureAgent(store, {
        companyId: company.id,
        name: options.geminiName,
        role: options.geminiRole,
        adapterType: "gemini_local",
        instructionsPath: join(targetPath, ".openclaw", "agents", `${options.geminiName}.md`),
        model: options.geminiModel ?? null
      })
      toolAgents.push({
        name: options.geminiName,
        adapterType: "gemini_local",
        model: options.geminiModel ?? null,
        created: gemini.created
      })
    }
    if (tools.includes("foundry")) {
      const foundry = ensureAgent(store, {
        companyId: company.id,
        name: options.foundryName,
        role: options.foundryRole,
        adapterType: "azure_foundry",
        instructionsPath: join(targetPath, ".openclaw", "agents", `${options.foundryName}.md`),
        model: options.foundryModel ?? "Kimi-K2.6"
      })
      toolAgents.push({
        name: options.foundryName,
        adapterType: "azure_foundry",
        model: options.foundryModel ?? "Kimi-K2.6",
        created: foundry.created
      })
    }
    const runtimeSync = syncProfileRuntime(store, {
      companyId: company.id,
      projectId: store.resolveProject(projectName, company.id).id,
      targetPath,
      profile
    })

    return {
      targetPath,
      dbPath,
      dryRun,
      diff,
      updatePrompts,
      updateFramework,
      companyCreated: company.created,
      projectCreated: project.created,
      codexCreated: toolAgents.find((agent) => agent.adapterType === "codex_local")?.created ?? false,
      geminiCreated: toolAgents.find((agent) => agent.adapterType === "gemini_local")?.created ?? false,
      foundryCreated: toolAgents.find((agent) => agent.adapterType === "azure_foundry")?.created ?? false,
      verifyCommand,
      ...runtimeSync,
      filePlans,
      profileId,
      manualSteps,
      toolAgents,
      stateNote: null
    }
  } finally {
    store.close()
  }
}
