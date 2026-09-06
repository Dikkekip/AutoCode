import { existsSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import type { Agent, Persona, Project, Task } from "./types.js"

export type PolicyDimension =
  | "file_access"
  | "command_execution"
  | "network_access"
  | "secret_handling"
  | "destructive_operations"
  | "branch_push"
  | "pr_creation"
  | "dependency_changes"
  | "infrastructure_changes"
  | "database_migrations"
  | "production_deployment"

export type PolicyAction =
  | "file.read"
  | "file.write"
  | "command.execute"
  | "network.access"
  | "secret.handle"
  | "destructive.operate"
  | "git.branch"
  | "git.push"
  | "pr.create"
  | "pr.merge"
  | "dependency.change"
  | "infrastructure.change"
  | "database.migrate"
  | "production.deploy"

export type PolicySource = "framework_default" | "project_profile" | "task_risk" | "persona_authority" | "runtime_flags"

export type PolicyRiskLevel = "low" | "medium" | "high"

export type PolicyPhase = "dispatch" | "promotion"

export interface PolicyRuntimeFlags {
  allowHighRiskActions?: boolean
  allowNetwork?: boolean
  allowDestructiveOperations?: boolean
  allowProductionDeployment?: boolean
  allowDatabaseMigrations?: boolean
  allowInfrastructureChanges?: boolean
  allowDependencyChanges?: boolean
  allowPush?: boolean
  allowPrCreation?: boolean
  allowPrMerge?: boolean
}

export interface ProjectPolicyProfile {
  allowedActions?: PolicyAction[]
  blockedActions?: PolicyAction[]
  allowNetwork?: boolean
  allowPush?: boolean
  allowPrCreation?: boolean
  allowPrMerge?: boolean
  allowDependencyChanges?: boolean
  allowInfrastructureChanges?: boolean
  allowDatabaseMigrations?: boolean
  allowProductionDeployment?: boolean
  allowDestructiveOperations?: boolean
}

export interface PolicyDecision {
  allowed: boolean
  phase: PolicyPhase
  riskLevel: PolicyRiskLevel
  actions: PolicyAction[]
  blockedActions: PolicyAction[]
  sources: PolicySource[]
  explanation: string
  reasons: string[]
  warnings: string[]
}

export interface PolicyEvaluationInput {
  phase: PolicyPhase
  project: Project
  task: Task
  agent?: Agent | null
  persona?: Persona | null
  projectPolicy?: ProjectPolicyProfile | null
  profile?: unknown
  runtimeFlags?: PolicyRuntimeFlags
  requestedActions?: PolicyAction[]
}

const HIGH_RISK_ACTIONS = new Set<PolicyAction>([
  "destructive.operate",
  "git.push",
  "pr.merge",
  "infrastructure.change",
  "database.migrate",
  "production.deploy"
])

const ACTION_DIMENSIONS: Record<PolicyAction, PolicyDimension> = {
  "file.read": "file_access",
  "file.write": "file_access",
  "command.execute": "command_execution",
  "network.access": "network_access",
  "secret.handle": "secret_handling",
  "destructive.operate": "destructive_operations",
  "git.branch": "branch_push",
  "git.push": "branch_push",
  "pr.create": "pr_creation",
  "pr.merge": "pr_creation",
  "dependency.change": "dependency_changes",
  "infrastructure.change": "infrastructure_changes",
  "database.migrate": "database_migrations",
  "production.deploy": "production_deployment"
}

function normalizeAction(value: unknown): PolicyAction | null {
  if (typeof value !== "string") return null
  const known = Object.keys(ACTION_DIMENSIONS) as PolicyAction[]
  return known.includes(value as PolicyAction) ? (value as PolicyAction) : null
}

function stringSet(values: Array<string | null | undefined>): string {
  return values
    .filter((value): value is string => Boolean(value && value.trim()))
    .join("\n")
    .toLowerCase()
}

function includesAny(haystack: string, needles: string[]): boolean {
  return needles.some((needle) => haystack.includes(needle))
}

export function runtimePolicyFlagsFromEnv(env: NodeJS.ProcessEnv = process.env): PolicyRuntimeFlags {
  const enabled = (name: string): boolean => {
    const value = env[name]?.trim().toLowerCase()
    return value === "1" || value === "true" || value === "yes"
  }

  return {
    allowHighRiskActions: enabled("OPENCLAW_POLICY_ALLOW_HIGH_RISK"),
    allowNetwork: enabled("OPENCLAW_POLICY_ALLOW_NETWORK"),
    allowDestructiveOperations: enabled("OPENCLAW_POLICY_ALLOW_DESTRUCTIVE"),
    allowProductionDeployment: enabled("OPENCLAW_POLICY_ALLOW_PRODUCTION_DEPLOY"),
    allowDatabaseMigrations: enabled("OPENCLAW_POLICY_ALLOW_DB_MIGRATIONS"),
    allowInfrastructureChanges: enabled("OPENCLAW_POLICY_ALLOW_INFRASTRUCTURE"),
    allowDependencyChanges: enabled("OPENCLAW_POLICY_ALLOW_DEPENDENCIES"),
    allowPush: enabled("OPENCLAW_POLICY_ALLOW_PUSH"),
    allowPrCreation: enabled("OPENCLAW_POLICY_ALLOW_PR_CREATE"),
    allowPrMerge: enabled("OPENCLAW_POLICY_ALLOW_PR_MERGE")
  }
}

export function loadProjectPolicy(repoPath: string): ProjectPolicyProfile | null {
  const path = join(repoPath, ".openclaw", "policy.json")
  if (!existsSync(path)) return null
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
  const allowedActions = Array.isArray(parsed.allowedActions)
    ? parsed.allowedActions.map(normalizeAction).filter((action): action is PolicyAction => action !== null)
    : []
  const blockedActions = Array.isArray(parsed.blockedActions)
    ? parsed.blockedActions.map(normalizeAction).filter((action): action is PolicyAction => action !== null)
    : []
  return {
    allowedActions,
    blockedActions,
    allowNetwork: parsed.allowNetwork === true,
    allowPush: parsed.allowPush === true,
    allowPrCreation: parsed.allowPrCreation === true,
    allowPrMerge: parsed.allowPrMerge === true,
    allowDependencyChanges: parsed.allowDependencyChanges === true,
    allowInfrastructureChanges: parsed.allowInfrastructureChanges === true,
    allowDatabaseMigrations: parsed.allowDatabaseMigrations === true,
    allowProductionDeployment: parsed.allowProductionDeployment === true,
    allowDestructiveOperations: parsed.allowDestructiveOperations === true
  }
}

function profilePolicyAllows(profile: unknown, action: PolicyAction): boolean {
  if (!profile || typeof profile !== "object") return false
  const record = profile as Record<string, unknown>
  const promotionPolicy = record.promotionPolicy as Record<string, unknown> | undefined
  if (action === "pr.create" && promotionPolicy?.mode === "ready_pr") return true
  if (action === "pr.merge" && promotionPolicy?.autoMerge === true) return true
  return false
}

function inferActions(task: Task, phase: PolicyPhase, project: Project): PolicyAction[] {
  const actions = new Set<PolicyAction>(["file.read"])
  const text = stringSet([
    task.title,
    task.description,
    task.kind,
    task.stage,
    task.laneId,
    ...task.labels,
    ...task.changedFiles,
    ...task.allowedPaths,
    ...task.verificationCommands,
    project.verifyCommand
  ])

  if (task.kind !== "review") actions.add("file.write")
  if (task.kind === "review" || task.verificationCommands.length > 0 || project.verifyCommand)
    actions.add("command.execute")

  if (phase === "promotion" || task.kind === "promote") {
    actions.add("command.execute")
    actions.add("network.access")
    actions.add("git.branch")
    actions.add("git.push")
    actions.add("pr.create")
    actions.add("pr.merge")
  }

  if (includesAny(text, ["http://", "https://", "api ", "download", "curl", "wget", "npm publish"])) {
    actions.add("network.access")
  }
  if (includesAny(text, ["secret", "token", "password", "credential", ".env", "api key", "apikey"])) {
    actions.add("secret.handle")
  }
  if (
    includesAny(text, ["delete", "remove", "drop ", "truncate", "reset --hard", "force push", "force-push", "destroy"])
  ) {
    actions.add("destructive.operate")
  }
  if (
    includesAny(text, [
      "package.json",
      "pnpm-lock",
      "package-lock",
      "yarn.lock",
      "requirements.txt",
      "pyproject.toml",
      "cargo.toml",
      "dependency"
    ])
  ) {
    actions.add("dependency.change")
  }
  if (
    includesAny(text, [
      "terraform",
      "pulumi",
      "helm",
      "kubernetes",
      "k8s",
      "cloudformation",
      "infra",
      ".github/workflows"
    ])
  ) {
    actions.add("infrastructure.change")
  }
  if (includesAny(text, ["migration", "migrate", "schema.sql", "alembic", "prisma/migrations", "knex"])) {
    actions.add("database.migrate")
  }
  if (
    includesAny(text, ["production", "prod deploy", "deploy prod", "release to prod", "kubectl apply", "azd deploy"])
  ) {
    actions.add("production.deploy")
  }

  return [...actions]
}

function inferRisk(task: Task, actions: PolicyAction[]): PolicyRiskLevel {
  const text = stringSet([task.title, task.description, ...task.labels])
  if (includesAny(text, ["risk:high", "high-risk", "high_risk", "production", "prod", "migration", "destructive"])) {
    return "high"
  }
  if (actions.some((action) => HIGH_RISK_ACTIONS.has(action))) return "high"
  if (
    actions.some((action) => action === "network.access" || action === "pr.create" || action === "dependency.change")
  ) {
    return "medium"
  }
  return "low"
}

function personaAllows(action: PolicyAction, persona: Persona | null | undefined, task: Task): boolean {
  const stage = persona?.stage ?? task.stage
  if (action === "pr.create" || action === "git.branch") return stage === "promoter" || task.kind === "promote"
  if (action === "git.push") return stage === "promoter" || task.kind === "promote"
  if (action === "pr.merge") return stage === "promoter" || task.kind === "promote"
  if (action === "command.execute") return stage !== "planner" || task.kind === "plan"
  return true
}

function explicitAllows(action: PolicyAction, projectPolicy: ProjectPolicyProfile | null | undefined): boolean {
  if (!projectPolicy) return false
  if (projectPolicy.allowedActions?.includes(action)) return true
  if (action === "network.access") return projectPolicy.allowNetwork === true
  if (action === "git.push") return projectPolicy.allowPush === true
  if (action === "pr.create") return projectPolicy.allowPrCreation === true
  if (action === "pr.merge") return projectPolicy.allowPrMerge === true
  if (action === "dependency.change") return projectPolicy.allowDependencyChanges === true
  if (action === "infrastructure.change") return projectPolicy.allowInfrastructureChanges === true
  if (action === "database.migrate") return projectPolicy.allowDatabaseMigrations === true
  if (action === "production.deploy") return projectPolicy.allowProductionDeployment === true
  if (action === "destructive.operate") return projectPolicy.allowDestructiveOperations === true
  return false
}

function runtimeAllows(action: PolicyAction, flags: PolicyRuntimeFlags | undefined): boolean {
  if (!flags) return false
  if (flags.allowHighRiskActions && HIGH_RISK_ACTIONS.has(action)) return true
  if (action === "network.access") return flags.allowNetwork === true
  if (action === "git.push") return flags.allowPush === true
  if (action === "pr.create") return flags.allowPrCreation === true
  if (action === "pr.merge") return flags.allowPrMerge === true
  if (action === "dependency.change") return flags.allowDependencyChanges === true
  if (action === "infrastructure.change") return flags.allowInfrastructureChanges === true
  if (action === "database.migrate") return flags.allowDatabaseMigrations === true
  if (action === "production.deploy") return flags.allowProductionDeployment === true
  if (action === "destructive.operate") return flags.allowDestructiveOperations === true
  return false
}

export function evaluatePolicy(input: PolicyEvaluationInput): PolicyDecision {
  const actions = Array.from(new Set(input.requestedActions ?? inferActions(input.task, input.phase, input.project)))
  const riskLevel = inferRisk(input.task, actions)
  const sources = new Set<PolicySource>(["framework_default", "task_risk"])
  const reasons: string[] = []
  const warnings: string[] = []
  const blockedActions: PolicyAction[] = []
  const projectPolicy = input.projectPolicy ?? null

  if (input.profile || projectPolicy) sources.add("project_profile")
  if (input.persona || input.task.stage) sources.add("persona_authority")
  if (input.runtimeFlags) sources.add("runtime_flags")

  for (const action of actions) {
    const explicitProjectAllow = explicitAllows(action, projectPolicy) || profilePolicyAllows(input.profile, action)
    const explicitRuntimeAllow = runtimeAllows(action, input.runtimeFlags)
    const projectBlocked = projectPolicy?.blockedActions?.includes(action) === true
    const highRisk = HIGH_RISK_ACTIONS.has(action)

    if (projectBlocked) {
      blockedActions.push(action)
      reasons.push(`${action} is blocked by project policy.`)
      continue
    }

    if (!personaAllows(action, input.persona, input.task)) {
      blockedActions.push(action)
      reasons.push(
        `${action} exceeds persona authority for stage ${input.persona?.stage ?? input.task.stage ?? "none"}.`
      )
      continue
    }

    if (action === "secret.handle") {
      blockedActions.push(action)
      reasons.push("Secret handling is never delegated into prompts or artifacts.")
      continue
    }

    if (action === "network.access" && !(explicitProjectAllow || explicitRuntimeAllow || input.phase === "promotion")) {
      blockedActions.push(action)
      reasons.push("Network access requires project policy or runtime flag allowance.")
      continue
    }

    if (highRisk && !(explicitProjectAllow || explicitRuntimeAllow)) {
      blockedActions.push(action)
      reasons.push(`${action} is high-risk and requires explicit project policy or runtime flag allowance.`)
    }
  }

  if (
    actions.some((action) => action === "file.write") &&
    input.task.allowedPaths.length === 0 &&
    input.task.changedFiles.length === 0
  ) {
    warnings.push("File write scope is broad because the task has no allowedPaths or changedFiles hints.")
  }

  const uniqueBlocked = Array.from(new Set(blockedActions))
  const allowed = uniqueBlocked.length === 0
  const dimensions = Array.from(new Set(actions.map((action) => ACTION_DIMENSIONS[action]))).join(", ")
  const explanation = allowed
    ? `Policy allowed ${input.phase} for ${input.task.id}; risk=${riskLevel}; dimensions=${dimensions}.`
    : `Policy blocked ${input.phase} for ${input.task.id}; risk=${riskLevel}; blocked=${uniqueBlocked.join(", ")}.`

  return {
    allowed,
    phase: input.phase,
    riskLevel,
    actions,
    blockedActions: uniqueBlocked,
    sources: [...sources],
    explanation,
    reasons: reasons.length > 0 ? Array.from(new Set(reasons)) : ["All requested actions are within policy."],
    warnings
  }
}

export function assertPathWithinProject(project: Project, path: string): boolean {
  const rel = relative(project.repoPath, path)
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"))
}
