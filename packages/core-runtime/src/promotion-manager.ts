import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { DispatcherStore } from "@openclaw/db"
import type { Project, PromotionRecord, Run, Task } from "@openclaw/domain"
import { repairBackendPytestPaths } from "@openclaw/executor"
import { bestProfileMatch, loadProjectProfile, type PromotionPolicy } from "@openclaw/project-profiles"

export type PromotionTarget = "local_branch" | "pull_request" | "release_candidate" | "main_branch"

export type PromotionGateId =
  | "task_completed"
  | "verification_passed"
  | "review_approved"
  | "security_findings"
  | "diff_scope"
  | "required_tests"
  | "changelog_release_notes"
  | "profile_policy"

export interface PromotionGateDecision {
  id: PromotionGateId
  label: string
  passed: boolean
  required: boolean
  explanation: string
  evidence: string[]
}

export interface PromotionPolicySnapshot {
  source: "repo" | "builtin" | "default"
  profileId: string | null
  mode: PromotionPolicy["mode"]
  maxOpenPrsPerLane: number
  allowParallelLanes: boolean
  mergeMethod: PromotionPolicy["mergeMethod"]
  requireCi: boolean
  requireReviewDecision: PromotionPolicy["requireReviewDecision"]
  allowMainWithoutHumanApproval: boolean
}

export interface PromotionCheckResult {
  runId: string
  taskId: string
  projectId: string
  target: PromotionTarget
  promotable: boolean
  checkedAt: string
  artifactPath: string
  branchName: string
  gates: PromotionGateDecision[]
  policy: PromotionPolicySnapshot
  existingPromotion: PromotionRecord | null
}

export interface PromotionCheckOptions {
  target?: PromotionTarget
  humanApproved?: boolean
  persist?: boolean
}

const DEFAULT_PROMOTION_POLICY: PromotionPolicySnapshot = {
  source: "default",
  profileId: null,
  mode: "manual",
  maxOpenPrsPerLane: 1,
  allowParallelLanes: false,
  mergeMethod: "squash",
  requireCi: false,
  requireReviewDecision: "manual",
  allowMainWithoutHumanApproval: false
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []
}

function boolFromMetadata(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null
}

function sanitizedBranchPart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
}

export function branchNameForPromotionRun(run: Run, task: Task): string {
  return run.branchName ?? `openclaw/${sanitizedBranchPart(task.laneId ?? task.kind)}/${task.id.slice(0, 8)}`
}

function commitChangedFiles(project: Project, run: Run): string[] {
  if (!run.headSha) return []
  try {
    return execFileSync("git", ["show", "--name-only", "--format=", run.headSha], {
      cwd: project.repoPath,
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 1024 * 1024
    })
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

function changedFilesFor(project: Project, run: Run, task: Task): string[] {
  const metadata = run.metadata ?? {}
  return Array.from(
    new Set([
      ...task.changedFiles,
      ...commitChangedFiles(project, run),
      ...stringArray(metadata.changedFiles),
      ...stringArray(metadata.filesTouched),
      ...stringArray(metadata.modifiedFiles)
    ])
  ).sort()
}

function testsRunFor(run: Run): string[] {
  const metadata = run.metadata ?? {}
  return Array.from(
    new Set([
      ...stringArray(metadata.testsRun),
      ...stringArray(metadata.commandsRun),
      ...(run.verificationSummary ? [run.verificationSummary] : [])
    ])
  )
}

function executableChecklistCommands(task: Task): string[] {
  return (task.taskPackage?.verificationChecklist ?? []).filter((entry) =>
    /^(git|pytest|pnpm|npm|make|uv|ruff|cd)\b/.test(entry.trim())
  )
}

function commandWasRun(command: string, testsRun: string[]): boolean {
  const normalized = command.trim()
  if (!normalized) return true
  return testsRun.some((entry) => entry.includes(normalized) || normalized.includes(entry))
}

function pathAllowed(path: string, allowedPath: string): boolean {
  const normalized = allowedPath.replace(/\\/g, "/").replace(/^\.\/+/, "")
  const candidate = path.replace(/\\/g, "/").replace(/^\.\/+/, "")
  if (normalized === "." || normalized === "**" || normalized === "*") return true
  if (normalized.endsWith("/**")) return candidate.startsWith(normalized.slice(0, -3))
  if (normalized.endsWith("/*")) return candidate.startsWith(normalized.slice(0, -1))
  return candidate === normalized || candidate.startsWith(`${normalized.replace(/\/+$/, "")}/`)
}

function loadPolicy(project: Project): PromotionPolicySnapshot {
  const localPath = join(project.repoPath, ".openclaw", "profile.json")
  if (existsSync(localPath)) {
    const parsed = JSON.parse(readFileSync(localPath, "utf8")) as unknown
    if (isRecord(parsed) && isRecord(parsed.promotionPolicy)) {
      const policy = parsed.promotionPolicy
      return {
        ...DEFAULT_PROMOTION_POLICY,
        source: "repo",
        profileId: typeof parsed.profileId === "string" ? parsed.profileId : null,
        mode: policy.mode === "ready_pr" ? "ready_pr" : "manual",
        maxOpenPrsPerLane:
          typeof policy.maxOpenPrsPerLane === "number"
            ? policy.maxOpenPrsPerLane
            : DEFAULT_PROMOTION_POLICY.maxOpenPrsPerLane,
        allowParallelLanes: policy.allowParallelLanes === true,
        mergeMethod:
          policy.mergeMethod === "merge" || policy.mergeMethod === "rebase" || policy.mergeMethod === "squash"
            ? policy.mergeMethod
            : DEFAULT_PROMOTION_POLICY.mergeMethod,
        requireCi: policy.requireCi === true,
        requireReviewDecision:
          policy.requireReviewDecision === "approved"
            ? "approved"
            : policy.requireReviewDecision === "none"
              ? "none"
              : "manual",
        allowMainWithoutHumanApproval: policy.allowMainWithoutHumanApproval === true
      }
    }
  }

  const match = bestProfileMatch(project.repoPath)
  if (!match) return DEFAULT_PROMOTION_POLICY
  const profile = loadProjectProfile(match.profileId)
  return {
    ...profile.promotionPolicy,
    source: "builtin",
    profileId: profile.profileId,
    allowMainWithoutHumanApproval: false
  }
}

function hasHighSecurityFinding(run: Run, taskEvents: ReturnType<DispatcherStore["getTaskEvents"]>): boolean {
  const metadataFindings = run.metadata?.securityFindings
  const findings = Array.isArray(metadataFindings) ? metadataFindings : []
  const highFromMetadata = findings.some(
    (finding) =>
      isRecord(finding) &&
      typeof finding.severity === "string" &&
      ["high", "critical"].includes(finding.severity.toLowerCase())
  )
  const highFromEvents = taskEvents.some((event) => {
    const severity = isRecord(event.data) && typeof event.data.severity === "string" ? event.data.severity : null
    return event.kind.includes("security") && severity !== null && ["high", "critical"].includes(severity.toLowerCase())
  })
  return highFromMetadata || highFromEvents
}

function changelogNeeded(run: Run, task: Task): boolean {
  const metadata = run.metadata ?? {}
  const explicit = boolFromMetadata(metadata.changelogRequired ?? metadata.releaseNotesNeeded)
  if (explicit !== null) return explicit
  return task.labels.some((label) =>
    ["release", "release-notes", "changelog", "public-api", "breaking-change"].includes(label)
  )
}

function changelogUpdated(run: Run, files: string[]): boolean {
  const metadata = run.metadata ?? {}
  if (metadata.changelogUpdated === true || metadata.releaseNotesUpdated === true) return true
  return files.some((file) => /(^|\/)(CHANGELOG|RELEASES?|release-notes)(\.|\/|$)/i.test(file))
}

function promotionArtifactPath(project: Project, runId: string, target: PromotionTarget): string {
  return join(project.repoPath, ".openclaw", "state", "current", "promotions", runId, `${target}.json`)
}

function persistPromotionCheck(store: DispatcherStore, result: PromotionCheckResult): void {
  mkdirSync(dirname(result.artifactPath), { recursive: true })
  writeFileSync(result.artifactPath, `${JSON.stringify(result, null, 2)}\n`, "utf8")
  store.updateRunMetadata(result.runId, {
    promotion: {
      target: result.target,
      promotable: result.promotable,
      artifactPath: result.artifactPath,
      checkedAt: result.checkedAt
    }
  })
  store.appendTaskEvent(result.taskId, "promotion-check-persisted", "Persisted promotion gate decision artifact.", {
    runId: result.runId,
    target: result.target,
    promotable: result.promotable,
    artifactPath: result.artifactPath
  })
}

export function evaluatePromotionRun(
  store: DispatcherStore,
  runId: string,
  options: PromotionCheckOptions = {}
): PromotionCheckResult {
  const target = options.target ?? "pull_request"
  const run = store.getRunById(runId)
  const task = store.getTaskById(run.taskId)
  const project = store.getProjectById(run.projectId)
  const taskEvents = store.getTaskEvents(task.id)
  const reviewChildren = store.listChildTasks(task.id, "review")
  const deterministicReview = store.getLatestReviewResultForTask(task.id)
  const files = changedFilesFor(project, run, task)
  const taskRequiredCommands = Array.from(new Set([...task.verificationCommands, ...executableChecklistCommands(task)]))
  const requiredCommands = Array.from(
    new Set(
      (taskRequiredCommands.length > 0
        ? taskRequiredCommands
        : project.verifyCommand
          ? [project.verifyCommand]
          : []
      ).map((command) => repairBackendPytestPaths(command, project.repoPath))
    )
  )
  const testsRun = testsRunFor(run)
  const policy = loadPolicy(project)
  const existingPromotion = store.getPromotionByTaskId(task.id)
  const branchName = existingPromotion?.branchName ?? branchNameForPromotionRun(run, task)
  const activeLanePromotion =
    task.laneId && !policy.allowParallelLanes ? store.getPromotionByLane(task.projectId, task.laneId, task.id) : null

  const verificationText = [run.verificationSummary, run.errorText].filter(Boolean).join("\n").toLowerCase()
  const verificationLooksFailed = /\b(fail(?:ed|ing)?|error|timed out|cancelled|blocked)\b/.test(verificationText)
  const legacyReviewApproved =
    run.reviewVerdict === "approved" || taskEvents.some((event) => event.kind === "review-passed")
  const reviewApproved = deterministicReview ? deterministicReview.outcome === "approve" : legacyReviewApproved
  const outOfScope =
    task.allowedPaths.length === 0
      ? []
      : files.filter((file) => !task.allowedPaths.some((allowed) => pathAllowed(file, allowed)))
  const missingCommands = requiredCommands.filter((command) => !commandWasRun(command, testsRun))
  const needsChangelog = changelogNeeded(run, task)
  const hasHighFinding = hasHighSecurityFinding(run, taskEvents)
  const taskPromotionReady = task.status === "done" || task.status === "promotion_pending"

  const gates: PromotionGateDecision[] = [
    {
      id: "task_completed",
      label: "Task completed",
      passed: run.status === "succeeded" && taskPromotionReady,
      required: true,
      explanation:
        run.status === "succeeded" && taskPromotionReady
          ? "Run succeeded and the task is ready for promotion."
          : `Run status is ${run.status}; task status is ${task.status}.`,
      evidence: [`run.status=${run.status}`, `task.status=${task.status}`]
    },
    {
      id: "verification_passed",
      label: "Verification passed",
      passed: run.status === "succeeded" && !verificationLooksFailed,
      required: true,
      explanation:
        run.status === "succeeded" && !verificationLooksFailed
          ? "Run verification does not report a failure."
          : "Run status or verification summary indicates failure.",
      evidence: [run.verificationSummary ? `verification=${run.verificationSummary}` : "verification=<none>"]
    },
    {
      id: "review_approved",
      label: "Review approved",
      passed: reviewApproved,
      required: true,
      explanation: reviewApproved ? "Reviewer approval evidence is present." : "No approved review evidence was found.",
      evidence: [
        run.reviewVerdict ? `run.reviewVerdict=${run.reviewVerdict}` : "run.reviewVerdict=<none>",
        `deterministic_review=${deterministicReview?.outcome ?? "<none>"}`,
        `review_children_done=${reviewChildren.filter((child) => child.status === "done").length}`
      ]
    },
    {
      id: "security_findings",
      label: "No high-severity security findings",
      passed: !hasHighFinding,
      required: true,
      explanation: hasHighFinding
        ? "High or critical security finding evidence blocks promotion."
        : "No high or critical findings were found.",
      evidence: [`security_events=${taskEvents.filter((event) => event.kind.includes("security")).length}`]
    },
    {
      id: "diff_scope",
      label: "Diff within allowed scope",
      passed: task.allowedPaths.length === 0 ? true : files.length > 0 && outOfScope.length === 0,
      required: true,
      explanation:
        task.allowedPaths.length === 0
          ? "No allowed-path policy is configured for this task."
          : outOfScope.length === 0 && files.length > 0
            ? "All changed files are inside allowed paths."
            : "Changed files are missing or outside allowed paths.",
      evidence: [
        `allowed_paths=${task.allowedPaths.length ? task.allowedPaths.join(",") : "<none>"}`,
        `changed_files=${files.length ? files.join(",") : "<none>"}`,
        `out_of_scope=${outOfScope.length ? outOfScope.join(",") : "<none>"}`
      ]
    },
    {
      id: "required_tests",
      label: "Required tests executed",
      passed: missingCommands.length === 0,
      required: true,
      explanation:
        missingCommands.length === 0
          ? "Required verification commands are accounted for."
          : "Some required verification commands are missing.",
      evidence: [
        `required=${requiredCommands.length ? requiredCommands.join(" | ") : "<none>"}`,
        `missing=${missingCommands.length ? missingCommands.join(" | ") : "<none>"}`
      ]
    },
    {
      id: "changelog_release_notes",
      label: "Changelog/release notes updated when needed",
      passed: !needsChangelog || changelogUpdated(run, files),
      required: true,
      explanation: !needsChangelog
        ? "This run does not require changelog or release-note updates."
        : changelogUpdated(run, files)
          ? "Changelog or release-note update evidence is present."
          : "Changelog or release notes are required but not updated.",
      evidence: [`needed=${needsChangelog}`, `updated=${changelogUpdated(run, files)}`]
    },
    {
      id: "profile_policy",
      label: "Project profile promotion policy satisfied",
      passed:
        target === "local_branch"
          ? true
          : target === "main_branch"
            ? options.humanApproved === true || policy.allowMainWithoutHumanApproval
            : policy.mode === "ready_pr" && !activeLanePromotion,
      required: true,
      explanation:
        target === "local_branch"
          ? "Local branch promotion is allowed after safety gates pass."
          : target === "main_branch"
            ? options.humanApproved === true || policy.allowMainWithoutHumanApproval
              ? "Main-branch promotion has explicit human approval or profile allowance."
              : "Main-branch promotion requires explicit human approval unless the profile allows otherwise."
            : policy.mode !== "ready_pr"
              ? `Profile promotion mode is ${policy.mode}; ${target} requires ready_pr.`
              : activeLanePromotion
                ? `Lane already has active promotion ${activeLanePromotion.id}.`
                : "Profile policy allows ready PR promotion.",
      evidence: [
        `policy.source=${policy.source}`,
        `profile=${policy.profileId ?? "<none>"}`,
        `mode=${policy.mode}`,
        `target=${target}`,
        `active_lane_promotion=${activeLanePromotion?.id ?? "<none>"}`
      ]
    }
  ]

  const result: PromotionCheckResult = {
    runId,
    taskId: task.id,
    projectId: project.id,
    target,
    promotable: gates.every((gate) => !gate.required || gate.passed),
    checkedAt: new Date().toISOString(),
    artifactPath: promotionArtifactPath(project, runId, target),
    branchName,
    gates,
    policy,
    existingPromotion
  }

  if (options.persist !== false) {
    persistPromotionCheck(store, result)
  }

  return result
}
