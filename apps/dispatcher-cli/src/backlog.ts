import { spawnSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { basename, join, relative } from "node:path"
import type { DispatcherStore } from "@openclaw/db"
import type { AdapterType, BacklogCandidate, BacklogEffortEstimate, Project, TaskPackage } from "@openclaw/domain"

type RawBacklogCandidate = Omit<
  BacklogCandidate,
  "id" | "companyId" | "projectId" | "status" | "acceptedTaskId" | "duplicateOf" | "createdAt" | "updatedAt"
>

export type BacklogGenerationSummary = {
  project: Project
  candidates: BacklogCandidate[]
  duplicateCount: number
  inspectedSignals: string[]
}

const SKIP_DIRS = new Set([
  ".git",
  ".openclaw/state/current",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".venv",
  "__pycache__"
])

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java"])
const DOC_EXTENSIONS = new Set([".md", ".mdx", ".rst"])

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)))
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

function slug(value: string): string {
  return normalize(value).replace(/\s+/g, "-").slice(0, 80)
}

function extname(path: string): string {
  const dot = path.lastIndexOf(".")
  return dot === -1 ? "" : path.slice(dot)
}

function walkFiles(root: string): string[] {
  const files: string[] = []
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name)
      const rel = relative(root, absolute)
      if ([...SKIP_DIRS].some((skip) => rel === skip || rel.startsWith(`${skip}/`) || entry.name === skip)) continue
      if (entry.isDirectory()) {
        visit(absolute)
        continue
      }
      if (entry.isFile()) files.push(rel)
    }
  }
  visit(root)
  return files
}

function safeRead(path: string): string {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return ""
  }
}

function safeJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
  } catch {
    return null
  }
}

function runShell(command: string, cwd: string, timeoutMs = 20_000): { status: number | null; output: string } {
  const result = spawnSync(command, {
    cwd,
    shell: true,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024 * 3
  })
  return {
    status: result.status,
    output: [result.stdout ?? "", result.stderr ?? ""].join("\n").trim()
  }
}

function packageScripts(repoPath: string): Record<string, string> {
  const pkg = safeJson(join(repoPath, "package.json"))
  const scripts = pkg?.scripts
  return scripts && typeof scripts === "object" ? (scripts as Record<string, string>) : {}
}

function commandForScript(repoPath: string, script: string): string {
  if (existsSync(join(repoPath, "pnpm-lock.yaml"))) return `corepack pnpm ${script}`
  if (existsSync(join(repoPath, "yarn.lock"))) return `corepack yarn ${script}`
  return `npm run ${script}`
}

function hasTaskDuplicate(
  existing: BacklogCandidate[],
  tasks: ReturnType<DispatcherStore["listProjectTasks"]>,
  raw: RawBacklogCandidate
): string | null {
  const exactBacklog = existing.find(
    (candidate) => candidate.dedupeKey === raw.dedupeKey && candidate.status === "accepted"
  )
  if (exactBacklog) return exactBacklog.id

  const normalizedTitle = normalize(raw.title)
  const task = tasks.find((entry) => {
    if (!["queued", "running", "review_needed", "promotion_pending", "blocked", "done"].includes(entry.status)) {
      return false
    }
    const hasDedupe =
      entry.labels.includes(`backlog-dedupe:${raw.dedupeKey}`) ||
      entry.labels.includes(`planner-dedupe:${raw.dedupeKey}`)
    return hasDedupe || normalize(entry.title) === normalizedTitle
  })
  return task?.id ?? null
}

function todoCandidates(project: Project, files: string[]): RawBacklogCandidate[] {
  return files
    .filter((file) => SOURCE_EXTENSIONS.has(extname(file)) || DOC_EXTENSIONS.has(extname(file)))
    .flatMap((file) => {
      const lines = safeRead(join(project.repoPath, file)).split(/\r?\n/)
      return lines
        .map((text, index) => ({ text: text.trim(), line: index + 1 }))
        .filter((hit) => /\b(TODO|FIXME)\b/i.test(hit.text))
        .slice(0, 3)
        .map((hit) => ({
          title: `Resolve TODO/FIXME in ${file}`,
          description: `Address the outstanding comment at ${file}:${hit.line}: ${hit.text}`,
          valueScore: 62,
          riskScore: /fixme/i.test(hit.text) ? 48 : 30,
          effortEstimate: "S" as BacklogEffortEstimate,
          recommendedPersona: "coder",
          suggestedAdapter: "codex_local" as AdapterType,
          verificationCommand: project.verifyCommand,
          dependencies: [],
          reason:
            "Explicit code comments are concrete, scoped maintenance work and often unblock future autonomous execution.",
          dedupeKey: `todo-fixme:${file}:${hit.line}:${slug(hit.text)}`,
          sourceSignals: [`todo_fixme:${file}:${hit.line}`],
          labels: ["backlog", "todo-fixme"],
          changedFiles: [file]
        }))
    })
}

function largeFileCandidates(project: Project, files: string[]): RawBacklogCandidate[] {
  return files
    .filter((file) => SOURCE_EXTENSIONS.has(extname(file)))
    .map((file) => ({ file, lines: safeRead(join(project.repoPath, file)).split(/\r?\n/).length }))
    .filter((entry) => entry.lines >= 450)
    .sort((left, right) => right.lines - left.lines)
    .slice(0, 8)
    .map((entry) => ({
      title: `Split high-risk large file ${entry.file}`,
      description: `${entry.file} is ${entry.lines} lines. Create a narrow extraction plan around one cohesive responsibility, then verify behavior stays unchanged.`,
      valueScore: clampScore(55 + entry.lines / 80),
      riskScore: clampScore(35 + entry.lines / 100),
      effortEstimate: entry.lines > 900 ? "L" : "M",
      recommendedPersona: "architect",
      suggestedAdapter: "codex_local",
      verificationCommand: project.verifyCommand,
      dependencies: [],
      reason:
        "Large files reduce reviewability and autonomous edit safety; split only a small, test-backed responsibility.",
      dedupeKey: `large-file:${entry.file}`,
      sourceSignals: [`large_file:${entry.file}:${entry.lines}`],
      labels: ["backlog", "large-file", "architecture"],
      changedFiles: [entry.file]
    }))
}

function duplicatedCodeCandidates(project: Project, files: string[]): RawBacklogCandidate[] {
  const occurrences = new Map<string, string[]>()
  for (const file of files.filter((entry) => SOURCE_EXTENSIONS.has(extname(entry)))) {
    const lines = safeRead(join(project.repoPath, file)).split(/\r?\n/)
    for (let index = 0; index < lines.length - 2; index += 1) {
      const block = lines
        .slice(index, index + 3)
        .map((line) => line.trim())
        .filter((line) => line.length > 12 && !line.startsWith("//") && !line.startsWith("*"))
      if (block.length !== 3) continue
      const key = block.join(" ")
      const current = occurrences.get(key) ?? []
      current.push(`${file}:${index + 1}`)
      occurrences.set(key, current)
    }
  }

  return [...occurrences.entries()]
    .filter(([, refs]) => new Set(refs.map((ref) => ref.split(":")[0])).size >= 2 && refs.length >= 3)
    .sort((left, right) => right[1].length - left[1].length)
    .slice(0, 5)
    .map(([block, refs], index) => ({
      title: `Remove duplicated logic cluster ${index + 1}`,
      description: `The same 3-line code shape appears ${refs.length} times. Extract only if a local helper preserves clarity; otherwise add tests around the shared behavior first.`,
      valueScore: clampScore(50 + refs.length * 4),
      riskScore: 50,
      effortEstimate: "M",
      recommendedPersona: "coder",
      suggestedAdapter: "codex_local",
      verificationCommand: project.verifyCommand,
      dependencies: [],
      reason:
        "Duplication multiplies future maintenance cost, but this should be handled as a narrow, test-backed cleanup.",
      dedupeKey: `dup-code:${slug(block)}`,
      sourceSignals: refs.slice(0, 8).map((ref) => `duplicate_code:${ref}`),
      labels: ["backlog", "duplication"],
      changedFiles: Array.from(new Set(refs.map((ref) => ref.split(":")[0]!).filter(Boolean))).slice(0, 8)
    }))
}

function docsGapCandidates(project: Project, files: string[]): RawBacklogCandidate[] {
  const packageDirs = new Set(
    files
      .filter((file) => basename(file) === "package.json" && file !== "package.json")
      .map((file) => file.slice(0, -"package.json".length).replace(/\/$/, ""))
  )
  return [...packageDirs]
    .filter((dir) => !files.includes(`${dir}/README.md`))
    .slice(0, 8)
    .map((dir) => ({
      title: `Document package ${dir}`,
      description: `Add a concise README for ${dir} covering purpose, public entry points, verification commands, and ownership notes.`,
      valueScore: 48,
      riskScore: 18,
      effortEstimate: "S",
      recommendedPersona: "coder",
      suggestedAdapter: "codex_local",
      verificationCommand: project.verifyCommand,
      dependencies: [],
      reason: "Documentation gaps slow autonomous agents because they must rediscover package intent on every run.",
      dedupeKey: `docs-gap:${dir}`,
      sourceSignals: [`documentation_gap:${dir}/README.md`],
      labels: ["backlog", "documentation", "autonomy"],
      changedFiles: [`${dir}/README.md`]
    }))
}

function architectureProfileCandidates(project: Project, files: string[]): RawBacklogCandidate[] {
  const candidates: RawBacklogCandidate[] = []
  const hasControlPlane = files.some((file) => file.startsWith(".openclaw/agents/"))
  const hasAgents = files.includes("AGENTS.md")
  if (!hasAgents) {
    candidates.push({
      title: "Add repo-local agent operating instructions",
      description:
        "Create AGENTS.md with project-specific safety rules, verification commands, ownership notes, and memory conventions.",
      valueScore: 72,
      riskScore: 24,
      effortEstimate: "S",
      recommendedPersona: "planner",
      suggestedAdapter: "codex_local",
      verificationCommand: project.verifyCommand,
      dependencies: [],
      reason:
        "Repo-local instructions reduce architecture drift and give autonomous agents a safer default operating profile.",
      dedupeKey: "profile-violation:missing-agents-md",
      sourceSignals: ["profile_violation:missing_AGENTS.md"],
      labels: ["backlog", "autonomy", "profile-violation"],
      changedFiles: ["AGENTS.md"]
    })
  }
  if (!hasControlPlane) {
    candidates.push({
      title: "Install or refresh OpenClaw control-plane profile",
      description:
        "Add the minimal .openclaw agent/profile files so recurring autonomous sweeps have explicit planner, reviewer, and promotion boundaries.",
      valueScore: 78,
      riskScore: 36,
      effortEstimate: "M",
      recommendedPersona: "planner",
      suggestedAdapter: "codex_local",
      verificationCommand: "dispatcher doctor",
      dependencies: [],
      reason:
        "A missing control-plane profile is architecture drift for an autonomous repo; fixing it improves future queue generation and routing.",
      dedupeKey: "architecture-drift:missing-openclaw-control-plane",
      sourceSignals: ["architecture_drift:missing_.openclaw/agents"],
      labels: ["backlog", "autonomy", "architecture"],
      changedFiles: [".openclaw/agents/planner.md", ".openclaw/agents/reviewer.md"]
    })
  }
  return candidates
}

function commandCandidates(project: Project): RawBacklogCandidate[] {
  const candidates: RawBacklogCandidate[] = []
  const scripts = packageScripts(project.repoPath)
  const checks: Array<{ kind: string; command: string; value: number; risk: number }> = []
  if (project.verifyCommand) checks.push({ kind: "verification", command: project.verifyCommand, value: 88, risk: 70 })
  if (scripts.lint)
    checks.push({ kind: "lint", command: commandForScript(project.repoPath, "lint"), value: 76, risk: 42 })
  if (scripts.test && !project.verifyCommand)
    checks.push({ kind: "tests", command: commandForScript(project.repoPath, "test"), value: 86, risk: 68 })

  for (const check of checks) {
    const result = runShell(check.command, project.repoPath)
    if (result.status === 0) continue
    const timedOut = result.status === null
    candidates.push({
      title: timedOut ? `Stabilize flaky or hanging ${check.kind} command` : `Fix failing ${check.kind} command`,
      description: `Command: ${check.command}\n\nRecent output:\n${result.output.slice(0, 3000)}`,
      valueScore: check.value,
      riskScore: timedOut ? 82 : check.risk,
      effortEstimate: timedOut ? "M" : "S",
      recommendedPersona: "coder",
      suggestedAdapter: "codex_local",
      verificationCommand: check.command,
      dependencies: [],
      reason: "Reliable verification is a prerequisite for safe autonomous implementation and promotion.",
      dedupeKey: `command:${check.kind}:${slug(check.command)}`,
      sourceSignals: [timedOut ? `flaky_command:${check.command}` : `failing_command:${check.command}`],
      labels: ["backlog", check.kind, "verification"],
      changedFiles: []
    })
  }
  return candidates
}

function coverageCandidates(project: Project): RawBacklogCandidate[] {
  const summary = safeJson(join(project.repoPath, "coverage", "coverage-summary.json"))
  const total = summary?.total
  if (!total || typeof total !== "object") return []
  const statements = (total as Record<string, { pct?: number }>).statements?.pct
  if (typeof statements !== "number" || statements >= 70) return []
  return [
    {
      title: "Raise low test coverage on critical paths",
      description: `Coverage summary reports ${statements}% statement coverage. Add focused regression tests around the riskiest untested behavior before broad implementation work.`,
      valueScore: 82,
      riskScore: 64,
      effortEstimate: "M",
      recommendedPersona: "coder",
      suggestedAdapter: "codex_local",
      verificationCommand: project.verifyCommand,
      dependencies: [],
      reason:
        "Low coverage limits autonomous safety; testability work increases the quality of future automated changes.",
      dedupeKey: "coverage:low-total-statements",
      sourceSignals: [`low_test_coverage:statements:${statements}`],
      labels: ["backlog", "testability", "coverage"],
      changedFiles: []
    }
  ]
}

function staleDependencyCandidates(project: Project, files: string[]): RawBacklogCandidate[] {
  if (!files.includes("package.json")) return []
  const pkg = safeJson(join(project.repoPath, "package.json"))
  const dependencyCount = ["dependencies", "devDependencies", "peerDependencies"]
    .map((key) => pkg?.[key])
    .filter((value): value is Record<string, string> => Boolean(value) && typeof value === "object")
    .reduce((count, deps) => count + Object.keys(deps).length, 0)
  if (dependencyCount === 0) return []
  const mtime = statSync(join(project.repoPath, "package.json")).mtimeMs
  const ageDays = (Date.now() - mtime) / (1000 * 60 * 60 * 24)
  if (ageDays < 45) return []
  return [
    {
      title: "Audit stale dependency surface",
      description: `package.json has ${dependencyCount} declared dependencies and has not changed in roughly ${Math.round(ageDays)} days. Run the package manager's outdated audit, then update only low-risk patch/minor packages with tests.`,
      valueScore: 58,
      riskScore: 45,
      effortEstimate: "M",
      recommendedPersona: "coder",
      suggestedAdapter: "codex_local",
      verificationCommand: project.verifyCommand,
      dependencies: [],
      reason:
        "Dependency freshness reduces security and compatibility drift, but updates should be split into safe batches.",
      dedupeKey: "dependencies:stale-audit",
      sourceSignals: [`stale_dependencies:package_json_age_days:${Math.round(ageDays)}`],
      labels: ["backlog", "dependencies"],
      changedFiles: ["package.json"]
    }
  ]
}

function runtimeErrorCandidates(project: Project, store: DispatcherStore): RawBacklogCandidate[] {
  const runs = store
    .listRuns(100)
    .filter((run) => run.projectId === project.id && (run.errorText || run.status === "failed"))
    .slice(-50)
  const buckets = new Map<string, number>()
  for (const run of runs) {
    const key = slug((run.errorText ?? run.status).slice(0, 180))
    buckets.set(key, (buckets.get(key) ?? 0) + 1)
  }
  return [...buckets.entries()]
    .filter(([, count]) => count >= 2)
    .slice(0, 5)
    .map(([key, count]) => ({
      title: "Investigate repeated runtime error",
      description: `${count} recent runs failed with the same error signature. Add observability or a guardrail before retrying similar work.`,
      valueScore: 84,
      riskScore: 72,
      effortEstimate: "M",
      recommendedPersona: "coder",
      suggestedAdapter: "codex_local",
      verificationCommand: project.verifyCommand,
      dependencies: [],
      reason: "Repeated runtime errors waste autonomous cycles; fixing them improves throughput and reliability.",
      dedupeKey: `runtime-error:${key}`,
      sourceSignals: [`repeated_runtime_error:${key}:${count}`],
      labels: ["backlog", "observability", "runtime-error"],
      changedFiles: []
    }))
}

function oldHighRiskTaskCandidates(
  project: Project,
  tasks: ReturnType<DispatcherStore["listProjectTasks"]>
): RawBacklogCandidate[] {
  const now = Date.now()
  return tasks
    .filter((task) => ["blocked", "review_needed", "promotion_pending"].includes(task.status))
    .map((task) => ({ task, ageDays: (now - Date.parse(task.createdAt)) / (1000 * 60 * 60 * 24) }))
    .filter((entry) => Number.isFinite(entry.ageDays) && entry.ageDays >= 7)
    .slice(0, 6)
    .map(({ task, ageDays }) => ({
      title: `Resolve stale high-risk task: ${task.title}`,
      description: `Task ${task.id} has been ${task.status} for about ${Math.round(ageDays)} days. Decide whether to unblock, split, or close it.`,
      valueScore: 70,
      riskScore: 75,
      effortEstimate: "S",
      recommendedPersona: "planner",
      suggestedAdapter: "codex_local",
      verificationCommand: project.verifyCommand,
      dependencies: [task.id],
      reason: "Old risky work clogs the queue and can mask newer autonomous priorities.",
      dedupeKey: `stale-task:${task.id}`,
      sourceSignals: [`old_high_risk_task:${task.id}:${task.status}`],
      labels: ["backlog", "queue-health"],
      changedFiles: task.changedFiles
    }))
}

function rank(candidate: BacklogCandidate): number {
  const autonomyBoost = candidate.labels.includes("autonomy") || candidate.labels.includes("verification") ? 12 : 0
  const testabilityBoost =
    candidate.labels.includes("testability") || candidate.labels.includes("observability") ? 10 : 0
  return candidate.valueScore * 2 + candidate.riskScore + autonomyBoost + testabilityBoost
}

export function generateBacklog(input: {
  store: DispatcherStore
  projectRef: string
  runCommands?: boolean
}): BacklogGenerationSummary {
  const project = input.store.resolveProject(input.projectRef)
  const files = walkFiles(project.repoPath)
  const tasks = input.store.listProjectTasks(project.id)
  const existing = input.store.listBacklogCandidates(project.id)
  const rawCandidates = [
    ...todoCandidates(project, files),
    ...largeFileCandidates(project, files),
    ...duplicatedCodeCandidates(project, files),
    ...docsGapCandidates(project, files),
    ...architectureProfileCandidates(project, files),
    ...coverageCandidates(project),
    ...staleDependencyCandidates(project, files),
    ...runtimeErrorCandidates(project, input.store),
    ...oldHighRiskTaskCandidates(project, tasks),
    ...((input.runCommands ?? true) ? commandCandidates(project) : [])
  ]

  const seen = new Set<string>()
  let duplicateCount = 0
  const persisted: BacklogCandidate[] = []
  for (const raw of rawCandidates) {
    const localDuplicate = seen.has(raw.dedupeKey)
    seen.add(raw.dedupeKey)
    const duplicateOf = localDuplicate ? raw.dedupeKey : hasTaskDuplicate(existing, tasks, raw)
    if (duplicateOf) duplicateCount += 1
    const candidate = input.store.upsertBacklogCandidate({
      projectId: project.id,
      status: duplicateOf ? "duplicate" : "candidate",
      ...raw,
      duplicateOf
    })
    if (!duplicateOf && candidate.status === "candidate") persisted.push(candidate)
  }

  return {
    project,
    candidates: persisted.sort((left, right) => rank(right) - rank(left)).slice(0, 30),
    duplicateCount,
    inspectedSignals: [
      "TODO/FIXME comments",
      "failing tests",
      "stale dependencies",
      "duplicated code",
      "large files",
      "low test coverage",
      "lint issues",
      "flaky commands",
      "architecture drift",
      "profile violations",
      "repeated runtime errors",
      "documentation gaps",
      "old high-risk tasks"
    ]
  }
}

export function backlogCandidateTaskPackage(candidate: BacklogCandidate, project: Project): TaskPackage {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    repoProfile: "backlog-generator",
    likelyOwnershipLane: candidate.labels.includes("documentation") ? "docs" : "general",
    laneReason: candidate.reason,
    inferenceSignals: candidate.sourceSignals,
    requiredReading: ["AGENTS.md", "README.md"].filter((file) => existsSync(join(project.repoPath, file))),
    verificationChecklist: candidate.verificationCommand ? [candidate.verificationCommand] : [],
    contractUpdateReminders: [],
    personaProvenance: candidate.recommendedPersona
      ? {
          personaId: candidate.recommendedPersona,
          personaName: candidate.recommendedPersona,
          source: "backlog",
          rationale: candidate.reason
        }
      : undefined,
    userOutcome: candidate.description,
    acceptanceCriteria: candidate.verificationCommand
      ? [`Run verification: ${candidate.verificationCommand}`]
      : ["Define focused verification before completion."],
    taskSourceIntent: "backlog",
    repoNotes: [
      `value_score=${candidate.valueScore}`,
      `risk_score=${candidate.riskScore}`,
      `effort_estimate=${candidate.effortEstimate}`,
      `dedupe_key=${candidate.dedupeKey}`
    ]
  }
}
