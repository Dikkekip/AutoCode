import type { AdapterType, JobId, TaskKind } from "@openclaw/domain"

export type AskIntent =
  | "production_readiness"
  | "architecture_risk_scan"
  | "ui_polish_tasks"
  | "codex_fix_tests"
  | "review_completed_runs"
  | "create_safe_prs"
  | "explain_director_stop"
  | "deployment_or_production_action"
  | "ambiguous"

export type AskAction =
  | {
      type: "create_task"
      title: string
      description: string
      labels: string[]
      kind: TaskKind
      requestedAdapterType?: AdapterType | null
      reviewRequired?: boolean
      approvalRequired?: boolean
    }
  | {
      type: "create_workflow"
      title: string
      description: string
      labels: string[]
    }
  | {
      type: "create_many_tasks"
      count: number
      titlePrefix: string
      description: string
      labels: string[]
      kind: TaskKind
    }
  | {
      type: "run_job"
      jobId: JobId
      description: string
    }
  | {
      type: "read_completed_runs"
      limit: number
    }
  | {
      type: "explain_director_stop"
      limit: number
    }
  | {
      type: "clarify"
      question: string
      proposal?: string
    }
  | {
      type: "block"
      reason: string
    }

export type InterpretedAskCommand = {
  utterance: string
  intent: AskIntent
  confidence: "high" | "medium" | "low"
  summary: string
  dangerous: boolean
  requiresConfirmation: boolean
  productionOrDeployment: boolean
  action: AskAction
}

function normalizeUtterance(utterance: string): string {
  return utterance
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function extractCount(text: string, fallback: number): number {
  const match = text.match(/\b(\d{1,2})\b/)
  if (!match) return fallback
  const count = Number.parseInt(match[1]!, 10)
  return Number.isFinite(count) && count > 0 ? Math.min(count, 25) : fallback
}

function containsAny(text: string, needles: string[]): boolean {
  return needles.some((needle) => text.includes(needle))
}

export function interpretAskCommand(utterance: string): InterpretedAskCommand {
  const normalized = normalizeUtterance(utterance)

  const explicitDeploymentAction =
    /\b(deploy|deployment|release to prod|production deploy|prod deploy|terraform apply|kubectl apply|migrate production)\b/.test(
      normalized
    ) && !containsAny(normalized, ["production readiness", "prod readiness"])

  if (!normalized) {
    return {
      utterance,
      intent: "ambiguous",
      confidence: "low",
      summary: "No command text was provided.",
      dangerous: false,
      requiresConfirmation: false,
      productionOrDeployment: false,
      action: {
        type: "clarify",
        question: "What should OpenClaw do?"
      }
    }
  }

  if (explicitDeploymentAction) {
    return {
      utterance,
      intent: "deployment_or_production_action",
      confidence: "high",
      summary: "The request appears to ask for a production or deployment action.",
      dangerous: true,
      requiresConfirmation: true,
      productionOrDeployment: true,
      action: {
        type: "block",
        reason:
          "Natural-language production or deployment actions are blocked unless a project profile explicitly permits them."
      }
    }
  }

  if (containsAny(normalized, ["production readiness", "prod readiness", "production ready"])) {
    return {
      utterance,
      intent: "production_readiness",
      confidence: "high",
      summary: "Create a planner-backed workflow to improve the repo for production readiness.",
      dangerous: true,
      requiresConfirmation: true,
      productionOrDeployment: false,
      action: {
        type: "create_workflow",
        title: "Improve this repo for production readiness",
        description:
          "Audit reliability, operability, verification, safety, and deployment-adjacent readiness without deploying or changing production systems.",
        labels: ["production-readiness", "repo-health"]
      }
    }
  }

  if (containsAny(normalized, ["riskiest architecture", "architecture problems", "architecture risks"])) {
    return {
      utterance,
      intent: "architecture_risk_scan",
      confidence: "high",
      summary: "Create an architecture review task focused on the highest-risk problems.",
      dangerous: false,
      requiresConfirmation: true,
      productionOrDeployment: false,
      action: {
        type: "create_task",
        title: "Find the riskiest architecture problems",
        description:
          "Inspect architecture boundaries, coupling, state flow, runtime failure modes, and missing tests. Return the highest-risk findings first with concrete remediation tasks.",
        labels: ["architecture", "risk-review"],
        kind: "review",
        reviewRequired: false,
        approvalRequired: false
      }
    }
  }

  if (containsAny(normalized, ["ui polish", "polish tasks", "interface polish"])) {
    const count = extractCount(normalized, 10)
    return {
      utterance,
      intent: "ui_polish_tasks",
      confidence: "high",
      summary: `Generate ${count} small UI polish tasks.`,
      dangerous: false,
      requiresConfirmation: true,
      productionOrDeployment: false,
      action: {
        type: "create_many_tasks",
        count,
        titlePrefix: "UI polish",
        description:
          "Small, independently verifiable UI polish item. Keep scope narrow, preserve existing design patterns, and include responsive verification.",
        labels: ["ui", "polish"],
        kind: "implement"
      }
    }
  }

  if (containsAny(normalized, ["codex fix failing tests", "codex fix tests", "fix failing tests", "let codex fix"])) {
    return {
      utterance,
      intent: "codex_fix_tests",
      confidence: "high",
      summary: "Create a Codex-local task to fix failing tests.",
      dangerous: true,
      requiresConfirmation: true,
      productionOrDeployment: false,
      action: {
        type: "create_task",
        title: "Let Codex fix failing tests",
        description:
          "Run the relevant failing tests, identify the smallest coherent fixes, update tests only when expectations are stale, and summarize verification.",
        labels: ["tests", "codex"],
        kind: "implement",
        requestedAdapterType: "codex_local",
        reviewRequired: true,
        approvalRequired: false
      }
    }
  }

  if (containsAny(normalized, ["review all completed runs", "completed runs", "review completed runs"])) {
    return {
      utterance,
      intent: "review_completed_runs",
      confidence: "high",
      summary: "Show recently completed runs for operator review.",
      dangerous: false,
      requiresConfirmation: false,
      productionOrDeployment: false,
      action: {
        type: "read_completed_runs",
        limit: 25
      }
    }
  }

  if (containsAny(normalized, ["create prs", "create pr", "open prs", "open pr"])) {
    return {
      utterance,
      intent: "create_safe_prs",
      confidence: "medium",
      summary: "Run the promotion sweep that can create PRs for approved safe changes.",
      dangerous: true,
      requiresConfirmation: true,
      productionOrDeployment: false,
      action: {
        type: "run_job",
        jobId: "promotion-sweep",
        description: "Create or sync PRs only through the configured promotion policy and review gates."
      }
    }
  }

  if (containsAny(normalized, ["why the director stopped", "why director stopped", "explain director stopped"])) {
    return {
      utterance,
      intent: "explain_director_stop",
      confidence: "high",
      summary: "Explain the latest director stop reason and recent decisions.",
      dangerous: false,
      requiresConfirmation: false,
      productionOrDeployment: false,
      action: {
        type: "explain_director_stop",
        limit: 5
      }
    }
  }

  return {
    utterance,
    intent: "ambiguous",
    confidence: "low",
    summary: "The command could not be mapped to a safe dispatcher action.",
    dangerous: false,
    requiresConfirmation: false,
    productionOrDeployment: false,
    action: {
      type: "clarify",
      question: "Should this become a task, a workflow, a director job, or a read-only review?",
      proposal: `Dry-run proposal: create a manual task titled "${utterance.trim()}".`
    }
  }
}

export function structuredAskCommand(command: InterpretedAskCommand): Record<string, unknown> {
  return {
    utterance: command.utterance,
    intent: command.intent,
    confidence: command.confidence,
    summary: command.summary,
    dangerous: command.dangerous,
    requiresConfirmation: command.requiresConfirmation,
    productionOrDeployment: command.productionOrDeployment,
    action: command.action
  }
}

export function renderAskPlan(command: InterpretedAskCommand): string[] {
  const lines = [
    "Planned action:",
    `intent: ${command.intent}`,
    `confidence: ${command.confidence}`,
    `summary: ${command.summary}`,
    `dangerous: ${command.dangerous ? "yes" : "no"}`,
    `requires_confirmation: ${command.requiresConfirmation ? "yes" : "no"}`
  ]

  switch (command.action.type) {
    case "create_task":
      lines.push(
        "action: create_task",
        `title: ${command.action.title}`,
        `kind: ${command.action.kind}`,
        `labels: ${command.action.labels.join(", ") || "none"}`,
        `adapter: ${command.action.requestedAdapterType ?? "auto"}`
      )
      break
    case "create_workflow":
      lines.push(
        "action: create_workflow",
        `title: ${command.action.title}`,
        `labels: ${command.action.labels.join(", ") || "none"}`
      )
      break
    case "create_many_tasks":
      lines.push(
        "action: create_many_tasks",
        `count: ${command.action.count}`,
        `title_prefix: ${command.action.titlePrefix}`,
        `labels: ${command.action.labels.join(", ") || "none"}`
      )
      break
    case "run_job":
      lines.push("action: run_job", `job: ${command.action.jobId}`, `description: ${command.action.description}`)
      break
    case "read_completed_runs":
      lines.push("action: read_completed_runs", `limit: ${command.action.limit}`)
      break
    case "explain_director_stop":
      lines.push("action: explain_director_stop", `limit: ${command.action.limit}`)
      break
    case "clarify":
      lines.push("action: clarify", `question: ${command.action.question}`)
      if (command.action.proposal) lines.push(`proposal: ${command.action.proposal}`)
      break
    case "block":
      lines.push("action: blocked", `reason: ${command.action.reason}`)
      break
  }

  return lines
}
