import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { DispatcherStore } from "@openclaw/db"
import { type Project, type Run, redactLogText, type Task } from "@openclaw/domain"

export type GitHubRunContext = {
  run: Run
  task: Task
  project: Project
  personaName: string | null
}

export type GitHubBranchResult = {
  branchName: string
  baseBranch: string
  headSha: string
  changedFiles: string[]
}

export type GitHubPrResult = GitHubBranchResult & {
  prNumber: number | null
  prUrl: string | null
  labels: string[]
  bodyPath: string
}

export type GitHubReleaseSyncResult = {
  repo: string
  imported: number
  skipped: number
  releases: Array<{
    tagName: string
    name: string
    imported: boolean
    releaseId: string | null
  }>
}

export type GitHubReleaseAuditResult = {
  repo: string
  inspected: number
  newestTag: string | null
  oldestTag: string | null
  personaTagged: number
  regressionLike: number
  legalDomain: number
  byPersona: Record<string, number>
  byBucket: Record<string, number>
  releases: Array<{
    tagName: string
    title: string
    publishedAt: string | null
    persona: string | null
    bucket: string | null
    regressionLike: boolean
  }>
}

type CommandResult = {
  ok: boolean
  stdout: string
  stderr: string
  status: number | null
}

function runCommand(command: string, args: string[], cwd: string): CommandResult {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: process.env
  })
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status
  }
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "task"
  )
}

function shortRunId(runId: string): string {
  return (
    runId
      .replace(/[^a-zA-Z0-9]/g, "")
      .slice(0, 12)
      .toLowerCase() || "run"
  )
}

export function deterministicBranchName(input: { runId: string; taskTitle: string }): string {
  return `openclaw/run/${shortRunId(input.runId)}-${slugify(input.taskTitle)}`
}

function parseChangedFiles(statusOutput: string): string[] {
  return statusOutput
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const path = line.slice(3)
      const renameIndex = path.indexOf(" -> ")
      return renameIndex === -1 ? path : path.slice(renameIndex + 4)
    })
}

function scopePrefixes(task: Task): string[] {
  const prefixes = [...task.changedFiles, ...task.allowedPaths].map((entry) => entry.replace(/^\/+/, ""))
  return Array.from(new Set(prefixes.filter(Boolean)))
}

function assertCleanOutsideRunScope(task: Task, changedFiles: string[]): void {
  const prefixes = scopePrefixes(task)
  if (prefixes.length === 0) return

  const outside = changedFiles.filter(
    (file) => !prefixes.some((prefix) => file === prefix || file.startsWith(`${prefix.replace(/\/+$/, "")}/`))
  )
  if (outside.length > 0) {
    throw new Error(`Working tree has changes outside run scope: ${outside.join(", ")}`)
  }
}

function git(cwd: string, args: string[]): CommandResult {
  return runCommand("git", args, cwd)
}

function gh(cwd: string, args: string[]): CommandResult {
  return runCommand("gh", args, cwd)
}

export function parseRepoSlug(remoteUrl: string): string | null {
  const sshMatch = /[:/]([^/:]+\/[^/]+?)(?:\.git)?$/.exec(remoteUrl.trim())
  return sshMatch?.[1] ?? null
}

function repoSlug(repoPath: string): string {
  const remote = git(repoPath, ["remote", "get-url", "origin"])
  if (!remote.ok) throw new Error(remote.stderr.trim() || "Failed to resolve origin remote")
  const slug = parseRepoSlug(remote.stdout)
  if (!slug) throw new Error(`Unable to parse GitHub repo slug from origin remote: ${remote.stdout.trim()}`)
  return slug
}

function currentBranch(repoPath: string): string {
  const result = git(repoPath, ["branch", "--show-current"])
  if (!result.ok) throw new Error(result.stderr.trim() || "Failed to resolve current branch")
  return result.stdout.trim() || "HEAD"
}

function defaultBaseBranch(repoPath: string): string {
  const remoteHead = git(repoPath, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
  if (remoteHead.ok) {
    const branch = remoteHead.stdout.trim().replace(/^origin\//, "")
    if (branch) return branch
  }
  const main = git(repoPath, ["show-ref", "--verify", "--quiet", "refs/remotes/origin/main"])
  return main.ok ? "main" : currentBranch(repoPath)
}

function headSha(repoPath: string): string {
  const result = git(repoPath, ["rev-parse", "HEAD"])
  if (!result.ok) throw new Error(result.stderr.trim() || "Failed to resolve HEAD SHA")
  return result.stdout.trim()
}

function branchOwner(repoPath: string): string {
  const slug = repoSlug(repoPath)
  return slug.split("/")[0] ?? slug
}

function workingTreeFiles(repoPath: string): string[] {
  const result = git(repoPath, ["status", "--porcelain"])
  if (!result.ok) throw new Error(result.stderr.trim() || "Failed to inspect working tree")
  return parseChangedFiles(result.stdout)
}

function changedFilesForCommit(repoPath: string, ref = "HEAD"): string[] {
  const result = git(repoPath, ["show", "--pretty=", "--name-only", ref])
  if (!result.ok) throw new Error(result.stderr.trim() || "Failed to inspect HEAD commit files")
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
}

function refHeadSha(repoPath: string, ref: string): string {
  const result = git(repoPath, ["rev-parse", ref])
  if (!result.ok) throw new Error(result.stderr.trim() || `Failed to resolve ${ref}`)
  return result.stdout.trim()
}

function publishRepoPath(context: GitHubRunContext): string {
  const worktreePath = context.run.worktreePath?.trim()
  return worktreePath && existsSync(worktreePath) ? worktreePath : context.project.repoPath
}

function ensureNotMainBranch(branchName: string): void {
  if (["main", "master", "trunk"].includes(branchName)) {
    throw new Error(`Refusing to push directly to protected base branch ${branchName}`)
  }
}

export function resolveGitHubRunContext(store: DispatcherStore, runId: string): GitHubRunContext {
  const run = store.getRunById(runId)
  const task = store.getTaskById(run.taskId)
  const project = store.getProjectById(run.projectId)
  const personaName = task.personaId ? (store.getPersonaById(task.personaId)?.name ?? null) : null
  return { run, task, project, personaName }
}

export function syncGitHubReleases(
  store: DispatcherStore,
  input: {
    projectRef: string
    repo?: string | null
    limit?: number | null
  }
): GitHubReleaseSyncResult {
  const project = store.resolveProject(input.projectRef)
  const repo = input.repo?.trim() || repoSlug(project.repoPath)
  const limit = Math.max(1, Math.min(input.limit ?? 20, 100))
  const result = gh(project.repoPath, [
    "release",
    "list",
    "--repo",
    repo,
    "--limit",
    String(limit),
    "--json",
    "tagName,name,isDraft,isPrerelease,publishedAt,createdAt"
  ])
  if (!result.ok) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || "Failed to list GitHub releases")
  }

  const existingVersions = new Set(
    store
      .listReleases(project.id)
      .map((release) => release.version)
      .filter((version): version is string => Boolean(version))
  )
  const releases = JSON.parse(result.stdout || "[]") as Array<Record<string, unknown>>
  let imported = 0
  let skipped = 0
  const synced: GitHubReleaseSyncResult["releases"] = []

  for (const release of releases) {
    if (release.isDraft || release.isPrerelease) {
      skipped += 1
      continue
    }
    const tagName = typeof release.tagName === "string" ? release.tagName.trim() : ""
    if (!tagName) {
      skipped += 1
      continue
    }
    const name = typeof release.name === "string" && release.name.trim() ? release.name.trim() : tagName
    if (existingVersions.has(tagName)) {
      skipped += 1
      synced.push({ tagName, name, imported: false, releaseId: null })
      continue
    }

    const publishedAt =
      typeof release.publishedAt === "string" && release.publishedAt.trim()
        ? release.publishedAt.trim()
        : typeof release.createdAt === "string" && release.createdAt.trim()
          ? release.createdAt.trim()
          : new Date().toISOString()
    const url = `https://github.com/${repo}/releases/tag/${tagName}`
    const created = store.createRelease({
      projectRef: project.id,
      name,
      version: tagName,
      status: "released",
      releasedAt: publishedAt,
      notes: `Imported from GitHub release ${url}`
    })
    existingVersions.add(tagName)
    imported += 1
    synced.push({ tagName, name, imported: true, releaseId: created.id })
  }

  return { repo, imported, skipped, releases: synced }
}

function increment(map: Record<string, number>, key: string | null): void {
  const normalized = key?.trim() || "unassigned"
  map[normalized] = (map[normalized] ?? 0) + 1
}

function matchMetadata(text: string, label: string): string | null {
  const pattern = new RegExp(`^- ${label}:\\s*(.+)$`, "im")
  const match = pattern.exec(text)
  return match?.[1]?.trim() || null
}

export function auditGitHubReleases(
  store: DispatcherStore,
  input: {
    projectRef: string
    repo?: string | null
    limit?: number | null
  }
): GitHubReleaseAuditResult {
  const project = store.resolveProject(input.projectRef)
  const repo = input.repo?.trim() || repoSlug(project.repoPath)
  const limit = Math.max(1, Math.min(input.limit ?? 200, 500))
  const pages = Math.ceil(limit / 100)
  const releases: Array<Record<string, unknown>> = []

  for (let page = 1; page <= pages; page += 1) {
    const pageLimit = Math.min(100, limit - releases.length)
    if (pageLimit <= 0) break
    const result = gh(project.repoPath, ["api", `/repos/${repo}/releases?per_page=${pageLimit}&page=${page}`])
    if (!result.ok) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || "Failed to audit GitHub releases")
    }
    const parsed = JSON.parse(result.stdout || "[]") as Array<Record<string, unknown>>
    if (parsed.length === 0) break
    releases.push(...parsed)
  }

  const byPersona: Record<string, number> = {}
  const byBucket: Record<string, number> = {}
  const inspected = releases
    .filter((release) => release.draft !== true && release.prerelease !== true)
    .slice(0, limit)
    .map((release) => {
      const tagName = typeof release.tag_name === "string" ? release.tag_name : ""
      const title = typeof release.name === "string" && release.name.trim() ? release.name.trim() : tagName
      const body = typeof release.body === "string" ? release.body : ""
      const text = `${title}\n${body}`
      const persona = matchMetadata(text, "Persona")
      const bucket = matchMetadata(text, "Portfolio bucket")
      const userOutcome = matchMetadata(text, "User outcome")
      const releaseSummary = body.split(/\r?\n/, 1)[0] ?? ""
      const regressionEvidence = `${title}\n${releaseSummary}\n${userOutcome ?? ""}`
      const regressionLike =
        /\b(regression|coverage|fixture|fallback|no-op|empty|missing)\b/i.test(regressionEvidence) ||
        /\b(add|harden|cover|verify)\b.*\b(tests?|coverage|fixtures?)\b/i.test(regressionEvidence)
      increment(byPersona, persona)
      increment(byBucket, bucket)
      return {
        tagName,
        title,
        publishedAt: typeof release.published_at === "string" ? release.published_at : null,
        persona,
        bucket,
        regressionLike,
        legalDomain:
          /\b(vedlegg|incident|court|evidence|matter|barnevern|saksinnsyn|lawyer|defendant|chronology|legal)\b/i.test(
            `${title}\n${body}`
          )
      }
    })

  return {
    repo,
    inspected: inspected.length,
    newestTag: inspected[0]?.tagName ?? null,
    oldestTag: inspected[inspected.length - 1]?.tagName ?? null,
    personaTagged: inspected.filter((release) => release.persona && release.persona !== "unassigned").length,
    regressionLike: inspected.filter((release) => release.regressionLike).length,
    legalDomain: inspected.filter((release) => release.legalDomain).length,
    byPersona,
    byBucket,
    releases: inspected
  }
}

export function createRunBranch(context: GitHubRunContext, store?: DispatcherStore): GitHubBranchResult {
  const repoPath = publishRepoPath(context)
  const existingGitHub =
    context.run.metadata?.github && typeof context.run.metadata.github === "object"
      ? (context.run.metadata.github as Record<string, unknown>)
      : {}
  const worktreePath = context.run.worktreePath?.trim()
  const branchName =
    worktreePath && existsSync(worktreePath)
      ? currentBranch(repoPath)
      : context.run.branchName || deterministicBranchName({ runId: context.run.id, taskTitle: context.task.title })
  ensureNotMainBranch(branchName)

  const repoBaseBranch = defaultBaseBranch(context.project.repoPath)
  const hasExecutionWorktree = Boolean(worktreePath && existsSync(worktreePath))
  if (!hasExecutionWorktree && context.run.branchName && context.run.headSha) {
    const existing = git(repoPath, ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`])
    if (!existing.ok) {
      const create = git(repoPath, ["branch", branchName, context.run.headSha])
      if (!create.ok) throw new Error(create.stderr.trim() || `Failed to restore branch ${branchName}`)
    }

    const restoredHeadSha = refHeadSha(repoPath, branchName)
    if (restoredHeadSha !== context.run.headSha) {
      throw new Error(
        `Promotion branch ${branchName} points at ${restoredHeadSha}, expected saved run head ${context.run.headSha}`
      )
    }

    const result = {
      branchName,
      baseBranch: repoBaseBranch,
      headSha: restoredHeadSha,
      changedFiles: changedFilesForCommit(repoPath, branchName)
    }
    store?.updateRunMetadata(context.run.id, {
      github: {
        ...existingGitHub,
        branchName: result.branchName,
        baseBranch: result.baseBranch,
        headSha: result.headSha,
        changedFiles: result.changedFiles
      }
    })
    return result
  }

  const changedFiles = workingTreeFiles(repoPath)
  assertCleanOutsideRunScope(context.task, changedFiles)

  const currentPublishBranch = currentBranch(repoPath)
  const existing = git(repoPath, ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`])
  const checkout =
    existing.ok && currentPublishBranch !== branchName
      ? git(repoPath, ["switch", branchName])
      : currentPublishBranch === branchName
        ? { ok: true, stdout: "", stderr: "", status: 0 }
        : git(repoPath, ["switch", "-c", branchName])
  if (!checkout.ok) throw new Error(checkout.stderr.trim() || `Failed to create branch ${branchName}`)

  const changedFileList = changedFiles.length > 0 ? changedFiles : changedFilesForCommit(repoPath)
  const result = {
    branchName,
    baseBranch: repoBaseBranch,
    headSha: headSha(repoPath),
    changedFiles: changedFileList
  }
  store?.updateRunMetadata(context.run.id, {
    github: {
      ...existingGitHub,
      branchName: result.branchName,
      baseBranch: result.baseBranch,
      headSha: result.headSha,
      changedFiles: result.changedFiles
    }
  })
  return result
}

function riskLabel(task: Task): string {
  const haystack = [task.title, task.description ?? "", ...task.labels, ...task.changedFiles].join(" ").toLowerCase()
  if (/migration|auth|security|payment|database|schema|infra|deploy|prod/.test(haystack)) return "risk:high"
  if (task.changedFiles.length > 8 || /refactor|runtime|adapter|dispatcher/.test(haystack)) return "risk:medium"
  return "risk:low"
}

function labelsFor(context: GitHubRunContext): string[] {
  const taskPackage = context.task.taskPackage
  const personaLabel = taskPackage?.personaProvenance?.personaId ?? context.personaName ?? context.task.stage
  return Array.from(
    new Set(
      [
        "openclaw",
        context.task.laneId ? `lane:${context.task.laneId}` : null,
        personaLabel ? `persona:${personaLabel}` : null,
        taskPackage?.portfolioBucket ? `bucket:${taskPackage.portfolioBucket}` : null,
        taskPackage?.taskSourceIntent ? `source:${taskPackage.taskSourceIntent}` : null,
        riskLabel(context.task)
      ].filter((label): label is string => Boolean(label))
    )
  )
}

function section(title: string, body: string | null | undefined): string {
  return `## ${title}\n${redactLogText(body?.trim() || "Not provided.")}`
}

function buildPrBody(context: GitHubRunContext, branch: GitHubBranchResult): string {
  const reviewReport = context.run.responseText ?? context.run.errorText ?? "No review report captured for this run."
  const rollback = `Revert the merge commit or run \`git revert ${branch.headSha}\` after merge. Before merge, close the PR and delete branch \`${branch.branchName}\`.`
  const taskPackage = context.task.taskPackage
  const persona = taskPackage?.personaProvenance?.personaId ?? context.personaName ?? context.task.stage ?? "Unassigned"
  const acceptance = taskPackage?.acceptanceCriteria?.length
    ? taskPackage.acceptanceCriteria.map((item) => `- ${item}`).join("\n")
    : "Not provided."
  const routeEvidence = [
    `Requested adapter: ${context.task.requestedAdapterType ?? taskPackage?.adapterPreference ?? "auto"}`,
    `Run adapter: ${context.run.adapterType ?? "n/a"}`,
    `Lane: ${context.task.laneId ?? taskPackage?.likelyOwnershipLane ?? "n/a"}`,
    `Portfolio bucket: ${taskPackage?.portfolioBucket ?? "n/a"}`,
    `Task source: ${taskPackage?.taskSourceIntent ?? context.task.source}`
  ].join("\n")
  return [
    section("Task Objective", context.task.description ?? context.task.title),
    section("Persona", persona),
    section("User Outcome", taskPackage?.userOutcome ?? context.task.description ?? context.task.title),
    section("Acceptance Criteria", acceptance),
    section("Route Decision", routeEvidence),
    section("Verification Output", context.run.verificationSummary ?? "Verification output was not captured."),
    section("Review Report", reviewReport),
    section(
      "Risk Assessment",
      `${riskLabel(context.task)}; changed files: ${branch.changedFiles.join(", ") || "none"}`
    ),
    section("Rollback Notes", rollback)
  ].join("\n\n")
}

function writePrBodyArtifact(project: Project, runId: string, body: string): string {
  const dir = join(project.repoPath, ".openclaw", "artifacts", "github")
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${shortRunId(runId)}-pr-body.md`)
  writeFileSync(path, body, "utf8")
  return path
}

function commitStructured(context: GitHubRunContext): void {
  if (!context.run.worktreePath && context.run.branchName && context.run.headSha) {
    return
  }
  const repoPath = publishRepoPath(context)
  const changedFiles = workingTreeFiles(repoPath)
  assertCleanOutsideRunScope(context.task, changedFiles)
  if (changedFiles.length === 0) return

  const add = git(repoPath, ["add", "-A"])
  if (!add.ok) throw new Error(add.stderr.trim() || "Failed to stage Codex changes")

  const message = [
    `openclaw(${context.task.laneId ?? "general"}): ${context.task.title}`,
    "",
    `Run: ${context.run.id}`,
    `Task: ${context.task.id}`,
    `Persona: ${context.personaName ?? context.task.stage ?? "unassigned"}`,
    `Risk: ${riskLabel(context.task)}`
  ].join("\n")
  const commit = git(repoPath, ["commit", "-m", message])
  if (!commit.ok && !commit.stderr.includes("nothing to commit")) {
    throw new Error(commit.stderr.trim() || "Failed to commit Codex changes")
  }
}

function _parsePrView(stdout: string): { prNumber: number | null; prUrl: string | null; headSha: string | null } {
  try {
    const json = JSON.parse(stdout || "{}") as Record<string, unknown>
    return {
      prNumber: typeof json.number === "number" ? json.number : null,
      prUrl: typeof json.url === "string" ? json.url : null,
      headSha: typeof json.headRefOid === "string" ? json.headRefOid : null
    }
  } catch {
    return { prNumber: null, prUrl: null, headSha: null }
  }
}

function parsePullRequest(stdout: string): { prNumber: number | null; prUrl: string | null; headSha: string | null } {
  try {
    const json = JSON.parse(stdout || "{}") as Record<string, unknown>
    return {
      prNumber: typeof json.number === "number" ? json.number : null,
      prUrl: typeof json.html_url === "string" ? json.html_url : typeof json.url === "string" ? json.url : null,
      headSha:
        json.head && typeof json.head === "object" && typeof (json.head as Record<string, unknown>).sha === "string"
          ? String((json.head as Record<string, unknown>).sha)
          : null
    }
  } catch {
    return { prNumber: null, prUrl: null, headSha: null }
  }
}

function findExistingPullRequest(
  repoPath: string,
  branchName: string
): {
  prNumber: number | null
  prUrl: string | null
  headSha: string | null
} {
  const slug = repoSlug(repoPath)
  const owner = branchOwner(repoPath)
  const result = gh(repoPath, [
    "api",
    `repos/${slug}/pulls`,
    "--method",
    "GET",
    "-f",
    `head=${owner}:${branchName}`,
    "-f",
    "state=open"
  ])
  if (!result.ok) {
    throw new Error(result.stderr.trim() || "Failed to inspect existing pull requests")
  }
  try {
    const payload = JSON.parse(result.stdout || "[]") as unknown[]
    if (!Array.isArray(payload) || payload.length === 0) {
      return { prNumber: null, prUrl: null, headSha: null }
    }
    return parsePullRequest(JSON.stringify(payload[0]))
  } catch {
    return { prNumber: null, prUrl: null, headSha: null }
  }
}

function ensureLabels(repoPath: string, labels: string[]): void {
  for (const label of labels) {
    gh(repoPath, ["label", "create", label, "--color", "ededed", "--description", "OpenClaw automation label"])
  }
}

export function createRunPullRequest(context: GitHubRunContext, store: DispatcherStore): GitHubPrResult {
  const repoPath = publishRepoPath(context)
  const branch = createRunBranch(context, store)
  commitStructured(context)
  const nextHeadSha = refHeadSha(repoPath, branch.branchName)

  const push = git(repoPath, ["push", "--force-with-lease", "-u", "origin", branch.branchName])
  if (!push.ok) throw new Error(push.stderr.trim() || "Failed to push branch")

  const refreshedBranch = { ...branch, headSha: nextHeadSha }
  const body = buildPrBody(context, refreshedBranch)
  const bodyPath = writePrBodyArtifact(context.project, context.run.id, body)
  const labels = labelsFor(context)
  ensureLabels(repoPath, labels)

  const slug = repoSlug(repoPath)
  let parsed = findExistingPullRequest(repoPath, refreshedBranch.branchName)
  if (parsed.prNumber == null) {
    const create = gh(repoPath, [
      "api",
      `repos/${slug}/pulls`,
      "--method",
      "POST",
      "-f",
      `title=${context.task.title}`,
      "-f",
      `head=${refreshedBranch.branchName}`,
      "-f",
      `base=${refreshedBranch.baseBranch}`,
      "-F",
      `body=@${bodyPath}`
    ])
    if (!create.ok) {
      throw new Error(create.stderr.trim() || "Failed to open pull request")
    }
    parsed = parsePullRequest(create.stdout)
  }

  if (labels.length > 0 && parsed.prNumber != null) {
    const editArgs = ["api", `repos/${slug}/issues/${parsed.prNumber}/labels`, "--method", "POST"]
    for (const label of labels) {
      editArgs.push("-f", `labels[]=${label}`)
    }
    const edit = gh(repoPath, editArgs)
    if (!edit.ok) throw new Error(edit.stderr.trim() || "Failed to add pull request labels")
  }

  const result = {
    ...refreshedBranch,
    headSha: parsed.headSha ?? refreshedBranch.headSha,
    prNumber: parsed.prNumber,
    prUrl: parsed.prUrl,
    labels,
    bodyPath
  }

  store.updateRunMetadata(context.run.id, {
    github: {
      branchName: result.branchName,
      baseBranch: result.baseBranch,
      headSha: result.headSha,
      prNumber: result.prNumber,
      prUrl: result.prUrl,
      labels: result.labels,
      bodyPath: result.bodyPath
    }
  })
  const promotion = store.getPromotionByTaskId(context.task.id)
  if (promotion) {
    store.updatePromotion(promotion.id, {
      branchName: result.branchName,
      baseBranch: result.baseBranch,
      headSha: result.headSha,
      prNumber: result.prNumber,
      prUrl: result.prUrl,
      promotionStatus: result.prNumber ? "waiting_for_review" : "pending_pr",
      lastError: null
    })
  }
  return result
}

export function renderRunPrStatus(context: GitHubRunContext): string[] {
  const github =
    context.run.metadata?.github && typeof context.run.metadata.github === "object"
      ? (context.run.metadata.github as Record<string, unknown>)
      : {}
  return [
    `run: ${context.run.id}`,
    `task: ${context.task.title}`,
    `branch: ${String(github.branchName ?? context.run.branchName ?? "n/a")}`,
    `base: ${String(github.baseBranch ?? "n/a")}`,
    `pr: ${String(github.prNumber ?? context.run.prNumber ?? "n/a")}`,
    `url: ${String(github.prUrl ?? "n/a")}`,
    `head_sha: ${String(github.headSha ?? context.run.headSha ?? "n/a")}`,
    `body_artifact: ${String(github.bodyPath ?? "n/a")}`
  ]
}

export function assertGitHubCliAvailable(): void {
  for (const command of ["git", "gh"]) {
    try {
      execFileSync("sh", ["-c", `command -v ${command}`], { encoding: "utf8", stdio: "ignore" })
    } catch {
      throw new Error(`${command} not found`)
    }
  }
}
