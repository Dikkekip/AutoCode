import type { BlockedClassification, Project, Run, RunEvent, Task, TaskPackage } from "./types.js"

export const MAX_REPAIR_ATTEMPTS = 2
const MAX_REPAIR_ERROR_OUTPUT_CHARS = 16_384

export type RepairTaskStatus = "created" | "already_exists" | "needs_human_review"

export interface RepairTaskPlan {
  originalTaskId: string
  failedRunId: string
  attempt: number
  title: string
  description: string
  labels: string[]
  changedFiles: string[]
  allowedPaths: string[]
  filesToInspect: string[]
  filesToAvoid: string[]
  verificationCommands: string[]
  taskPackage: TaskPackage | null
}

export function classifyBlockedReason(message: string, retryClass?: string | null): BlockedClassification {
  const text = `${retryClass ?? ""}\n${message}`.toLowerCase()
  if (
    /\b(quota|quota_exhausted|rate[\s-]?limit|429|resource exhausted|limit reached|usage limit|out of credits|credits? (?:exhausted|depleted)|service_disabled|accessnotconfigured)\b/.test(
      text
    ) ||
    text.includes("gemini for google cloud api")
  ) {
    return "quota"
  }
  if (/\b(verification|check failed|test failed|pytest|vitest|tsc|typecheck|lint|biome)\b/.test(text)) {
    return "verification_failure"
  }
  if (/\b(adapter|model|tool|capability|not available|missing adapter|unsupported)\b/.test(text)) {
    return "adapter_capability"
  }
  if (/\b(conflict|merge conflict|not mergeable|rebase|dirty working tree)\b/.test(text)) return "merge_conflict"
  if (/\b(dependency|depends on|missing package|module not found|not found)\b/.test(text)) return "missing_dependency"
  if (/\b(scope|outside run scope|outside strict allowed|no repository changes|no files changed)\b/.test(text)) {
    return "scope_invalid"
  }
  if (/\b(human|manual|approval|secret|credential|permission denied|auth)\b/.test(text)) return "needs_human"
  if (retryClass === "transient") return "transient"
  return "unknown"
}

function unique(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value))))
}

const SHELL_COMMAND_PREFIXES = [
  "./",
  "../",
  "/",
  "cd ",
  "npm ",
  "pnpm ",
  "yarn ",
  "corepack ",
  "uv ",
  "python ",
  "python3 ",
  "pytest ",
  "ruff ",
  "node ",
  "npx ",
  "playwright ",
  "make ",
  "git ",
  "gh ",
  "bash ",
  "sh ",
  "docker ",
  "docker-compose ",
  "go ",
  "cargo "
] as const

function looksLikeExecutableCommand(command: string): boolean {
  const trimmed = command.trim()
  if (!trimmed) return false
  if (/^(run|ensure|confirm|verify|check|inspect)\b/i.test(trimmed) && !/^(ruff|pytest)\b/i.test(trimmed)) {
    return false
  }
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(trimmed)) {
    return true
  }
  return SHELL_COMMAND_PREFIXES.some((prefix) => trimmed.startsWith(prefix))
}

function eventOutput(events: RunEvent[], messages: string[]): string[] {
  return events
    .filter((event) => messages.includes(event.message))
    .flatMap((event) => {
      const data = event.data ?? {}
      const command = typeof data.command === "string" ? data.command : null
      const output = typeof data.output === "string" ? data.output : null
      if (!output) return []
      return command ? [`$ ${command}\n${output}`] : [output]
    })
}

function exactErrorOutput(run: Run, events: RunEvent[]): string {
  const outputs = unique([
    run.errorText,
    ...eventOutput(events, ["Verification stdout", "Verification stderr"]),
    ...events
      .filter((event) => event.level === "error")
      .map((event) => {
        const data = event.data ? `\n${JSON.stringify(event.data, null, 2)}` : ""
        return `${event.message}${data}`
      })
  ])

  const combined = outputs.length > 0 ? outputs.join("\n\n") : "No error output was recorded for this run."
  if (combined.length <= MAX_REPAIR_ERROR_OUTPUT_CHARS) return combined

  const omittedChars = combined.length - MAX_REPAIR_ERROR_OUTPUT_CHARS
  return `[... ${omittedChars} characters omitted from repair evidence ...]\n${combined.slice(
    -MAX_REPAIR_ERROR_OUTPUT_CHARS
  )}`
}

function likelyCauses(run: Run, events: RunEvent[]): string[] {
  const text = [
    run.errorText,
    run.verificationSummary,
    ...events.map((event) => event.message),
    ...eventOutput(events, [])
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase()
  const causes: string[] = []

  if (text.includes("verification") || run.retryClass === "verification") {
    causes.push("The implementation completed but one or more verification commands failed.")
  }
  if (text.includes("type") || text.includes("tsc") || text.includes("typescript")) {
    causes.push("A TypeScript type or build contract may have been broken.")
  }
  if (text.includes("lint") || text.includes("biome")) {
    causes.push("Formatting or lint rules may not match the repository conventions.")
  }
  if (text.includes("test") || text.includes("expect") || text.includes("assert")) {
    causes.push("A focused test expectation no longer matches the implementation behavior.")
  }
  if (run.reviewVerdict === "changes_requested" || text.includes("review")) {
    causes.push("Review feedback requested a smaller correction before promotion.")
  }
  if (causes.length === 0) {
    causes.push("The failed run output should be inspected to identify the narrowest correction.")
  }

  return causes
}

function deriveVerificationCommands(task: Task, project: Project): string[] {
  const checklistCommands = (task.taskPackage?.verificationChecklist ?? []).filter(looksLikeExecutableCommand)
  if (checklistCommands.length > 0) return unique(checklistCommands)

  const taskCommands = task.verificationCommands.filter(looksLikeExecutableCommand)
  if (taskCommands.length > 0) return unique(taskCommands)

  return project.verifyCommand && looksLikeExecutableCommand(project.verifyCommand) ? [project.verifyCommand] : []
}

function changedFilesRecordedForRun(run: Run): string[] {
  const metadata = run.metadata ?? {}
  return Array.isArray(metadata.changedFiles)
    ? metadata.changedFiles.filter((value): value is string => typeof value === "string")
    : []
}

function deriveFilesToInspect(task: Task, run: Run): string[] {
  const metadataChangedFiles = changedFilesRecordedForRun(run)
  return unique([
    ...task.changedFiles,
    ...metadataChangedFiles,
    ...(task.allowedPaths.length > 0 ? task.allowedPaths : []),
    ...(task.taskPackage?.requiredReading ?? []),
    ...(run.manifestPath ? [run.manifestPath] : [])
  ])
}

function smallerAllowedScope(task: Task, run: Run, filesToInspect: string[]): string[] {
  const implementationFiles = unique([...task.changedFiles, ...changedFilesRecordedForRun(run)])
  if (implementationFiles.length > 0) return implementationFiles
  if (task.allowedPaths.length > 0) return unique(task.allowedPaths)
  return filesToInspect.slice(0, Math.max(1, Math.min(filesToInspect.length, 5)))
}

function renderSection(title: string, lines: string[]): string {
  const body = lines.length > 0 ? lines.map((line) => `- ${line}`).join("\n") : "- none"
  return `${title}:\n${body}`
}

export function buildRepairTaskPlan(input: {
  run: Run
  task: Task
  project: Project
  runEvents: RunEvent[]
  attempt: number
  projectProfileId?: string | null
}): RepairTaskPlan {
  const filesToInspect = deriveFilesToInspect(input.task, input.run)
  const allowedPaths = smallerAllowedScope(input.task, input.run, filesToInspect)
  const filesToAvoid =
    allowedPaths.length > 0
      ? ["Any file outside the strict allowed scope unless the original task explicitly allowed broader changes."]
      : ["Do not edit unrelated files. Ask for human review if the failure cannot be isolated."]
  const verificationCommands = deriveVerificationCommands(input.task, input.project)
  const exactOutput = exactErrorOutput(input.run, input.runEvents)
  const causes = likelyCauses(input.run, input.runEvents)
  const blockedClassification = classifyBlockedReason(exactOutput, input.run.retryClass)
  const originalDescription = input.task.description ?? "No original description was recorded."
  const maxAttemptsLine = `${MAX_REPAIR_ATTEMPTS}; this is attempt ${input.attempt}.`

  const description = [
    "Original objective:",
    input.task.title,
    "",
    originalDescription,
    "",
    "What failed:",
    `Run ${input.run.id} ended with status ${input.run.status}.`,
    input.run.reviewVerdict ? `Review verdict: ${input.run.reviewVerdict}.` : null,
    input.run.verificationSummary ? `Verification summary: ${input.run.verificationSummary}.` : null,
    "",
    "Exact error output:",
    "```",
    exactOutput,
    "```",
    "",
    renderSection("Likely causes", causes),
    "",
    renderSection("Strict allowed scope", allowedPaths),
    "Repair must be smaller than the original task. Do not expand scope unless explicitly allowed by the operator.",
    "",
    renderSection("Files to inspect", filesToInspect),
    "",
    renderSection("Files to avoid", filesToAvoid),
    "",
    renderSection("Verification commands", verificationCommands),
    "",
    `Max attempts: ${maxAttemptsLine}`,
    "Fallback behavior:",
    `- If this repair cannot pass within ${MAX_REPAIR_ATTEMPTS} attempts, stop and escalate to needs_human_review.`,
    "- If the fix requires files outside the strict allowed scope, stop and explain the required broader scope.",
    "- If the error output is insufficient, gather only task-local evidence and ask for human review."
  ]
    .filter((value): value is string => value !== null)
    .join("\n")

  return {
    originalTaskId: input.task.id,
    failedRunId: input.run.id,
    attempt: input.attempt,
    title: `Repair attempt ${input.attempt}: ${input.task.title}`,
    description,
    labels: unique([...input.task.labels, "repair", `repair-for:${input.run.id}`]),
    changedFiles: allowedPaths,
    allowedPaths,
    filesToInspect,
    filesToAvoid,
    verificationCommands,
    taskPackage: input.task.taskPackage
      ? {
          ...input.task.taskPackage,
          repoProfile: input.projectProfileId ?? input.task.taskPackage.repoProfile,
          requiredReading: unique([...input.task.taskPackage.requiredReading, ...filesToInspect]),
          verificationChecklist: verificationCommands,
          blockedClassification,
          taskSourceIntent: "repair",
          portfolioBucket: "validation_repair",
          personaProvenance: input.task.taskPackage.personaProvenance
            ? {
                ...input.task.taskPackage.personaProvenance,
                source: "repair",
                portfolioBucket: "validation_repair",
                rationale: `Repairing ${blockedClassification} blocker from run ${input.run.id}.`
              }
            : undefined,
          extraInstructions: unique([
            ...(input.task.taskPackage.extraInstructions ?? []),
            "This is a scoped repair task. Fix only the recorded failure and do not broaden the original scope."
          ])
        }
      : null
  }
}
