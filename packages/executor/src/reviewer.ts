import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { DispatcherStore } from "@openclaw/db"
import type {
  ReviewFinding,
  ReviewOutcome,
  ReviewResult,
  ReviewRiskLevel,
  ReviewSeverity,
  Run,
  Task
} from "@openclaw/domain"
import { executeCommand } from "@openclaw/os-adapters"

const SEVERITY_RANK: Record<ReviewSeverity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4
}

function maxSeverity(values: ReviewSeverity[]): ReviewSeverity {
  return values.reduce<ReviewSeverity>(
    (current, next) => (SEVERITY_RANK[next] > SEVERITY_RANK[current] ? next : current),
    "info"
  )
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)))
}

function runGit(repoPath: string, args: string[]): string | null {
  const result = executeCommand("git", args, {
    cwd: repoPath,
    env: process.env,
    timeoutMs: 60_000,
    maxBufferBytes: 1024 * 1024
  })
  if (!result.ok) return null
  return result.stdout.trim()
}

function isExecutionDependencyPath(file: string): boolean {
  const normalized = file.replaceAll("\\", "/").replace(/^\/+/, "")
  return /(^|\/)(?:node_modules|\.venv)(?:\/|$)/.test(normalized)
}

function collectDiff(projectRepoPath: string, run: Run, task: Task): { diff: string | null; changedFiles: string[] } {
  const repoPath = run.worktreePath && existsSync(run.worktreePath) ? run.worktreePath : projectRepoPath
  const statusFiles =
    runGit(repoPath, ["status", "--porcelain"])
      ?.split("\n")
      .map((line) => line.slice(3).trim()) ?? []
  const hintedFiles = task.changedFiles
  const showFiles = run.headSha ? (runGit(repoPath, ["show", "--name-only", "--format=", run.headSha]) ?? "") : ""
  const files = unique([...hintedFiles, ...statusFiles, ...showFiles.split("\n")]).filter(
    (file) => !isExecutionDependencyPath(file)
  )
  const scopedFiles = files.length > 0 ? ["--", ...files] : []
  const diff =
    (run.headSha ? runGit(repoPath, ["show", "--stat", "--patch", "--format=short", run.headSha]) : null) ??
    runGit(repoPath, ["diff", "--stat", "--patch", ...scopedFiles]) ??
    runGit(repoPath, ["diff", "--cached", "--stat", "--patch", ...scopedFiles])

  return {
    diff: diff ? diff.slice(0, 80_000) : null,
    changedFiles: files
  }
}

function addedDiffText(diffText: string): string {
  return diffText
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .join("\n")
}

function addedImplementationExports(diffText: string): string[] {
  return unique(
    diffText.split("\n").flatMap((line) => {
      if (!line.startsWith("+") || line.startsWith("+++")) return []
      const match = /^\+\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const)\s+([A-Za-z_$][\w$]*)/.exec(
        line
      )
      return match?.[1] ? [match[1]] : []
    })
  )
}

function unreferencedAddedImplementationExports(repoPath: string, run: Run, diffText: string): string[] {
  const headSha = run.headSha
  if (!headSha) return []
  return addedImplementationExports(diffText).filter((name) => {
    const matches = runGit(repoPath, ["grep", "-n", "-F", name, headSha])
    if (!matches) return false
    return matches.split("\n").filter(Boolean).length <= 1
  })
}

function taskPrompt(task: Task, run: Run): string {
  return [
    `Title: ${task.title}`,
    `Description: ${task.description ?? "No description provided."}`,
    `Labels: ${task.labels.join(", ") || "none"}`,
    `Run response: ${run.responseText ?? "none"}`
  ].join("\n")
}

function acceptanceCriteria(task: Task): string {
  const criteria = [
    ...(task.taskPackage?.acceptanceCriteria?.map((item) => `Acceptance criterion: ${item}`) ?? []),
    ...task.verificationCommands.map((command) => `Verification command: ${command}`),
    ...(task.taskPackage?.verificationChecklist.map((item) => `Checklist: ${item}`) ?? []),
    ...(task.taskPackage?.contractUpdateReminders.map((item) => `Contract reminder: ${item}`) ?? [])
  ]
  return criteria.length > 0 ? criteria.join("\n") : "No explicit acceptance criteria recorded."
}

function verificationOutput(store: DispatcherStore, run: Run): string {
  const eventLines = store.getRunEvents(run.id).flatMap((event) => {
    const data = event.data ? ` ${JSON.stringify(event.data)}` : ""
    if (/verification/i.test(event.message) || /stdout|stderr/i.test(event.message)) {
      return [`[${event.level}] ${event.message}${data}`]
    }
    return []
  })
  return [
    `Run status: ${run.status}`,
    `Verification summary: ${run.verificationSummary ?? "none"}`,
    ...eventLines
  ].join("\n")
}

function architectureRules(repoPath: string, task: Task): string {
  const profilePath = join(repoPath, ".openclaw", "profile.json")
  const profile = existsSync(profilePath) ? readFileSync(profilePath, "utf8").slice(0, 20_000) : null
  const taskRules = [
    ...(task.taskPackage?.requiredReading.map((item) => `Required reading: ${item}`) ?? []),
    ...(task.taskPackage?.contractUpdateReminders.map((item) => `Contract reminder: ${item}`) ?? []),
    ...(task.taskPackage?.repoNotes.map((item) => `Repo note: ${item}`) ?? [])
  ]
  return [profile ? `Profile:\n${profile}` : "No repo profile file found.", ...taskRules].join("\n\n")
}

function isTestOnlyFile(file: string): boolean {
  const normalized = file.replaceAll("\\", "/")
  return (
    /(^|\/)(?:__tests__|tests?|specs?)(?:\/|$)/i.test(normalized) ||
    /(?:^|\/)[^/]+\.(?:test|spec)\.[^/]+$/i.test(normalized)
  )
}

function taskExplicitlyRequiresTestCoverage(task: Task): boolean {
  return (task.taskPackage?.acceptanceCriteria ?? []).some((criterion) =>
    /\b(?:add|include|update)\b[^.\n]{0,80}\btests?\b|\b(?:focused|regression|unit|integration|contract|component|e2e)\b[^.\n]{0,80}\btests?\s+(?:must\s+)?cover\b|\btests?\s+(?:must\s+)?cover\b/i.test(
      criterion
    )
  )
}

function testFilesWithAddedCoverage(diffText: string): string[] {
  const files = new Set<string>()
  let currentFile: string | null = null

  for (const line of diffText.split("\n")) {
    const fileMatch = /^diff --git a\/.+ b\/(.+)$/.exec(line)
    if (fileMatch?.[1]) {
      currentFile = fileMatch[1]
      continue
    }
    if (
      currentFile &&
      isTestOnlyFile(currentFile) &&
      line.startsWith("+") &&
      !line.startsWith("+++") &&
      line.slice(1).trim()
    ) {
      files.add(currentFile)
    }
  }

  return Array.from(files)
}

function taskExplicitlyRequiresUserFacingUi(task: Task): boolean {
  return (task.taskPackage?.acceptanceCriteria ?? []).some((criterion) =>
    /\b(?:incident detail|viewer|panel|screen|workspace|section|controls?|button|navigation|accessible|visible|renders?|displays?|presents?)\b/i.test(
      criterion
    )
  )
}

function uiFilesWithAddedBehavior(diffText: string): string[] {
  const files = new Set<string>()
  let currentFile: string | null = null

  for (const line of diffText.split("\n")) {
    const fileMatch = /^diff --git a\/.+ b\/(.+)$/.exec(line)
    if (fileMatch?.[1]) {
      currentFile = fileMatch[1]
      continue
    }
    if (!currentFile || isTestOnlyFile(currentFile) || !/\.[jt]sx$/i.test(currentFile)) continue
    if (!line.startsWith("+") || line.startsWith("+++")) continue
    const added = line.slice(1).trim()
    if (
      /<[A-Za-z/]|\b(?:return|if|switch|const|let|function)\b|\b(?:on[A-Z]\w*|aria-[\w-]+|role|className|disabled|tabIndex)=/.test(
        added
      )
    ) {
      files.add(currentFile)
    }
  }

  return Array.from(files)
}

function isArchitectureOrPersistenceFile(file: string): boolean {
  const normalized = file.replaceAll("\\", "/")
  if (isTestOnlyFile(normalized)) return false
  return (
    /(^|\/)(?:schema|schemas|migration|migrations|architecture)(?=$|[/.])/i.test(normalized) ||
    /(^|\/)agent\/rules(?:\/|$)/i.test(normalized) ||
    /(^|\/)profile\.json$/i.test(normalized)
  )
}

function riskForFiles(files: string[]): ReviewRiskLevel {
  if (
    files.some(
      (file) =>
        /(^|\/)(auth|security|crypto|secrets?|permissions?)|\.env/i.test(file) || isArchitectureOrPersistenceFile(file)
    )
  ) {
    return "high"
  }
  if (
    files.some((file) => /package(-lock)?\.json|pnpm-lock\.yaml|tsconfig|biome|eslint|github\/workflows/i.test(file))
  ) {
    return "medium"
  }
  if (files.length > 8) return "high"
  if (files.length > 3) return "medium"
  return "low"
}

function pathAllowed(path: string, allowedPath: string): boolean {
  const normalizedPath = path.replace(/^\/+/, "")
  const normalizedAllowed = allowedPath.replace(/^\/+/, "").replace(/\/+$/, "")
  if (!normalizedAllowed) return false
  if (normalizedAllowed.endsWith("/**")) {
    const prefix = normalizedAllowed.slice(0, -3).replace(/\/+$/, "")
    return normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`)
  }
  if (normalizedAllowed.endsWith("/*")) {
    const prefix = normalizedAllowed.slice(0, -2).replace(/\/+$/, "")
    if (!normalizedPath.startsWith(`${prefix}/`)) return false
    return !normalizedPath.slice(prefix.length + 1).includes("/")
  }
  return normalizedPath === normalizedAllowed || normalizedPath.startsWith(`${normalizedAllowed}/`)
}

function verificationLooksFailed(text: string): boolean {
  return (
    /\bverification command failed\b/i.test(text) ||
    /\brun status:\s*(?:failed|cancelled|blocked)\b/i.test(text) ||
    /(?:^|\n)[ \t]*(?:FAIL|FAILED)[ \t]+\S+/i.test(text) ||
    /\b(?:test files|tests|test suites|suites)\b[^\n]*\b[1-9]\d*\s+failed\b/i.test(text) ||
    /\b[1-9]\d*\s+failed\b/i.test(text) ||
    /\bfailed,\s*[1-9]\d*\s+passed\b/i.test(text)
  )
}

function worseRisk(left: ReviewRiskLevel, right: ReviewRiskLevel): ReviewRiskLevel {
  const rank: Record<ReviewRiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 }
  return rank[right] > rank[left] ? right : left
}

function addFinding(
  findings: ReviewFinding[],
  finding: Omit<ReviewFinding, "files" | "areas"> & { files?: string[]; areas?: string[] }
): void {
  findings.push({
    files: finding.files ?? [],
    areas: finding.areas ?? [],
    severity: finding.severity,
    summary: finding.summary,
    requiredFixes: finding.requiredFixes
  })
}

function outcomeFrom(findings: ReviewFinding[], run: Run): ReviewOutcome {
  if (findings.some((finding) => finding.summary.toLowerCase().includes("secret"))) return "security_blocked"
  if (findings.some((finding) => finding.summary.toLowerCase().includes("architecture"))) return "architecture_blocked"
  if (
    run.status !== "succeeded" ||
    findings.some((finding) => finding.summary.toLowerCase().includes("verification"))
  ) {
    return "needs_tests"
  }
  if (findings.some((finding) => SEVERITY_RANK[finding.severity] >= SEVERITY_RANK.high)) {
    return "needs_human_review"
  }
  if (findings.length > 0) return "request_changes"
  return "approve"
}

function promotionRecommendation(outcome: ReviewOutcome, riskLevel: ReviewRiskLevel): string {
  if (outcome !== "approve") return "Do not promote until required fixes are complete and reviewed again."
  if (riskLevel === "high" || riskLevel === "critical") {
    return "Promotion requires explicit human approval because the reviewed change is high risk."
  }
  return "Promote automatically when downstream promotion checks pass."
}

function suggestedRepairPrompt(task: Task, findings: ReviewFinding[], outcome: ReviewOutcome): string {
  const fixes = findings.flatMap((finding) => finding.requiredFixes)
  return [
    `Repair review findings for task ${task.id}: ${task.title}`,
    `Review outcome: ${outcome}`,
    "",
    "Required fixes:",
    ...(fixes.length > 0 ? fixes.map((fix) => `- ${fix}`) : ["- Re-run the autonomous review after making changes."]),
    "",
    "Preserve the original task scope and rerun the recorded verification commands before marking complete."
  ].join("\n")
}

export function reviewCompletedRun(
  store: DispatcherStore,
  runId: string,
  options: { reviewerRunId?: string | null; materializeDirectReviewCarrier?: boolean } = {}
): ReviewResult {
  const run = store.getRunById(runId)
  const task = store.getTaskById(run.taskId)
  const project = store.getProjectById(run.projectId)
  const diff = collectDiff(project.repoPath, run, task)
  const changedFiles = diff.changedFiles.length > 0 ? diff.changedFiles : task.changedFiles
  const verification = verificationOutput(store, run)
  const architecture = architectureRules(project.repoPath, task)
  const findings: ReviewFinding[] = []
  let riskLevel = riskForFiles(changedFiles)

  if (run.status !== "succeeded") {
    addFinding(findings, {
      severity: "high",
      summary: "Run did not complete successfully.",
      requiredFixes: ["Fix the failed run before requesting promotion."],
      areas: ["run status"]
    })
  }

  if (
    changedFiles.length > 0 &&
    (!run.verificationSummary || /no verification command|none/i.test(run.verificationSummary))
  ) {
    addFinding(findings, {
      severity: changedFiles.length > 0 ? "medium" : "low",
      summary: "Verification evidence is missing.",
      requiredFixes: ["Run or add an appropriate verification command and capture the output."],
      files: changedFiles,
      areas: ["verification"]
    })
  }

  const verificationEvidence = [verification, run.responseText ?? "", run.errorText ?? ""].join("\n")
  if (verificationLooksFailed(verificationEvidence)) {
    addFinding(findings, {
      severity: "high",
      summary: "Verification evidence reports a failure.",
      requiredFixes: ["Fix the failing verification and rerun the recorded verification commands before promotion."],
      files: changedFiles,
      areas: ["verification"]
    })
  }

  if (task.allowedPaths.length > 0) {
    const outOfScope = changedFiles.filter((file) => !task.allowedPaths.some((allowed) => pathAllowed(file, allowed)))
    if (outOfScope.length > 0) {
      riskLevel = worseRisk(riskLevel, "high")
      addFinding(findings, {
        severity: "high",
        summary: "Run changed files outside the task allowed scope.",
        requiredFixes: [
          `Restrict the diff to allowed paths (${task.allowedPaths.join(", ")}) or update the task scope explicitly.`
        ],
        files: outOfScope,
        areas: ["diff scope"]
      })
    }
  }

  const diffText = diff.diff ?? ""
  if (/BEGIN (RSA|OPENSSH|DSA|EC) PRIVATE KEY|api[_-]?key|password\s*=|secret\s*=/i.test(diffText)) {
    riskLevel = "critical"
    addFinding(findings, {
      severity: "critical",
      summary: "Potential secret or private credential appears in the diff.",
      requiredFixes: ["Remove the secret, rotate it if it was real, and replace it with a safe configuration path."],
      files: changedFiles,
      areas: ["security"]
    })
  }

  if (changedFiles.some(isArchitectureOrPersistenceFile)) {
    riskLevel = worseRisk(riskLevel, "high")
    addFinding(findings, {
      severity: "high",
      summary: "Architecture or persistence rules may be affected.",
      requiredFixes: [
        "Confirm the change against project architecture/profile rules and add migration coverage if needed."
      ],
      files: changedFiles,
      areas: ["architecture/profile rules"]
    })
  }

  if (/TODO|FIXME|XXX/.test(addedDiffText(diffText))) {
    addFinding(findings, {
      severity: "medium",
      summary: "Diff introduces unresolved TODO/FIXME markers.",
      requiredFixes: ["Resolve or justify the marker before promotion."],
      files: changedFiles,
      areas: ["changed files"]
    })
  }

  if (/["'](?:data-testid|aria-[\w-]+)=/.test(addedDiffText(diffText))) {
    addFinding(findings, {
      severity: "medium",
      summary: "Diff embeds a JSX test or accessibility attribute inside a string literal.",
      requiredFixes: [
        "Move data-testid and aria-* values to real JSX attributes instead of class names or other string literals."
      ],
      files: changedFiles,
      areas: ["frontend semantics"]
    })
  }

  const unreferencedExports = unreferencedAddedImplementationExports(project.repoPath, run, diffText)
  if (unreferencedExports.length > 0) {
    addFinding(findings, {
      severity: "medium",
      summary:
        "Diff adds exported implementation code that is neither wired into the application nor covered by a caller.",
      requiredFixes: [
        `Wire or test the new implementation exports before promotion: ${unreferencedExports.join(", ")}.`
      ],
      files: changedFiles,
      areas: ["feature integration"]
    })
  }

  const changedImplementationFiles = changedFiles.filter((file) => !isTestOnlyFile(file))
  if (
    changedImplementationFiles.length > 0 &&
    taskExplicitlyRequiresTestCoverage(task) &&
    testFilesWithAddedCoverage(diffText).length === 0
  ) {
    addFinding(findings, {
      severity: "medium",
      summary: "Task explicitly requires test coverage, but the diff adds no verification assertions.",
      requiredFixes: [
        "Add focused test coverage for the requested behavior instead of relying only on existing tests or removing test code."
      ],
      files: changedImplementationFiles,
      areas: ["verification coverage"]
    })
  }

  if (taskExplicitlyRequiresUserFacingUi(task) && uiFilesWithAddedBehavior(diffText).length === 0) {
    addFinding(findings, {
      severity: "medium",
      summary: "Task explicitly requires user-facing UI behavior, but the diff adds no executable UI change.",
      requiredFixes: [
        "Implement and wire the requested user-facing behavior in a UI consumer, including its accessible states and actions."
      ],
      files: changedImplementationFiles,
      areas: ["feature integration"]
    })
  }

  const severity = maxSeverity(findings.map((finding) => finding.severity))
  const outcome = outcomeFrom(findings, run)
  const requiredFixes = unique(findings.flatMap((finding) => finding.requiredFixes))
  const summary =
    outcome === "approve"
      ? `Approved ${changedFiles.length} changed file(s) with ${riskLevel} risk.`
      : `Review found ${findings.length} issue(s); outcome=${outcome}; risk=${riskLevel}.`

  let reviewerRunId = options.reviewerRunId ?? null
  let directReviewTaskId: string | null = null
  if (!reviewerRunId && options.materializeDirectReviewCarrier && task.kind !== "review" && task.reviewRequired) {
    const previousReview = store.getLatestReviewResultForTask(task.id)
    if (previousReview?.runId === run.id && previousReview.reviewerRunId) {
      try {
        const previousReviewerRun = store.getRunById(previousReview.reviewerRunId)
        const previousReviewTask = store.getTaskById(previousReviewerRun.taskId)
        if (
          previousReviewerRun.status === "succeeded" &&
          previousReviewTask.kind === "review" &&
          previousReviewTask.parentTaskId === task.id &&
          previousReviewTask.status === "done"
        ) {
          reviewerRunId = previousReviewerRun.id
          directReviewTaskId = previousReviewTask.id
        }
      } catch {
        // A stale carrier reference is replaced below with a complete direct-review carrier.
      }
    }

    if (!reviewerRunId) {
      const directReviewTask = store.createTask({
        projectRef: task.projectId,
        title: `Review: ${task.title}`,
        description: [`Direct deterministic review for parent task ${task.id}.`, task.description]
          .filter(Boolean)
          .join("\n\n"),
        labels: Array.from(new Set([...task.labels, "review", "direct-review"])),
        changedFiles: task.changedFiles,
        taskPackage: task.taskPackage,
        kind: "review",
        priority: Math.max(task.priority, 70),
        parentTaskId: task.id,
        requestedAdapterType: "codex_local",
        reviewRequired: false,
        approvalRequired: false,
        maxRetries: 0
      })
      const directReviewerRun = store.createRun({
        companyId: run.companyId,
        projectId: run.projectId,
        taskId: directReviewTask.id,
        kind: "review",
        wakeReason: "manual"
      })
      store.completeRun(directReviewerRun.id, {
        status: "succeeded",
        responseText: `direct deterministic review ${outcome}`,
        verificationSummary: `Reviewed implementation run ${run.id}: ${run.verificationSummary ?? "no verification summary"}`,
        reviewVerdict:
          outcome === "approve"
            ? "approved"
            : outcome === "request_changes" || outcome === "needs_tests"
              ? "changes_requested"
              : "blocked"
      })
      store.updateTaskStatus(directReviewTask.id, "done", {
        lastError: null,
        blockedReason: null
      })
      reviewerRunId = directReviewerRun.id
      directReviewTaskId = directReviewTask.id
      store.appendTaskEvent(
        directReviewTask.id,
        "direct-review-carrier-completed",
        "Completed a durable review child for the direct deterministic review.",
        {
          parentTaskId: task.id,
          implementationRunId: run.id,
          reviewerRunId: directReviewerRun.id,
          outcome
        }
      )
    }
  }

  const result = store.createReviewResult({
    companyId: run.companyId,
    projectId: run.projectId,
    runId: run.id,
    taskId: task.id,
    reviewerRunId,
    outcome,
    summary,
    findings,
    severity,
    changedFiles,
    riskLevel,
    requiredFixes,
    suggestedRepairPrompt: suggestedRepairPrompt(task, findings, outcome),
    promotionRecommendation: promotionRecommendation(outcome, riskLevel),
    inspectedDiff: diff.diff,
    inspectedTaskPrompt: taskPrompt(task, run),
    inspectedAcceptanceCriteria: acceptanceCriteria(task),
    inspectedVerificationOutput: verification,
    inspectedArchitectureRules: architecture
  })
  if (directReviewTaskId) {
    store.appendTaskEvent(
      task.id,
      "direct-review-carrier-linked",
      "Linked the direct deterministic review to a completed review child.",
      {
        reviewTaskId: directReviewTaskId,
        reviewerRunId,
        reviewResultId: result.id,
        implementationRunId: run.id,
        outcome
      }
    )
  }
  return result
}
