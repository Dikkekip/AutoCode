import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import type {
  LaneOutcomeStats,
  PlannerSignalCollectorKind,
  Project,
  RepoPlanningSnapshot,
  Task
} from "@openclaw/domain"
import { proposeLanesFromSignals } from "@openclaw/domain"
import type { ProjectProfile } from "@openclaw/project-profiles"

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" })
  return result.status === 0 ? (result.stdout ?? "") : ""
}

function gitChangedFiles(project: Project): string[] {
  const output = run("git", ["status", "--porcelain"], project.repoPath)
  return output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .filter(Boolean)
    .slice(0, 200)
}

function trackedFiles(project: Project): string[] {
  const gitOutput = run("git", ["ls-files"], project.repoPath)
  const output = gitOutput || run("rg", ["--files"], project.repoPath)
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((path) => !path.includes("node_modules/") && !path.includes(".venv/") && !path.includes(".openclaw/state/"))
    .slice(0, 5000)
}

function todoFixmeHits(project: Project, profile: ProjectProfile): RepoPlanningSnapshot["todoFixmeHits"] {
  const markerPattern = String.raw`(^|[^[:alnum:]_])(TODO|FIXME)(\([^)]*\))?[[:space:]]*:`
  const result = spawnSync("git", ["grep", "-n", "-I", "-E", markerPattern, "--", "."], {
    cwd: project.repoPath,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 5
  })
  if (result.status !== 0 && !result.stdout) return []
  return (result.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = /^(.*?):(\d+):(.*)$/.exec(line)
      if (!match) return null
      const path = (match[1] ?? "").replace(/^\.\//, "")
      const laneId = profile.laneDefinitions.find((lane) => fileMatchesLane(path, lane))?.laneId ?? null
      return {
        path,
        line: Number.parseInt(match[2] ?? "0", 10),
        text: (match[3] ?? "").trim(),
        laneId
      }
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    .slice(0, 50)
}

function lanePrefix(pattern: string): string {
  const wildcardIndex = pattern.search(/[*{]/)
  return wildcardIndex === -1 ? pattern.replace(/\/+$/, "") : pattern.slice(0, wildcardIndex).replace(/\/+$/, "")
}

function fileMatchesLane(file: string, lane: ProjectProfile["laneDefinitions"][number]): boolean {
  return lane.allowedPaths.some((pattern) => {
    const prefix = lanePrefix(pattern)
    return prefix.length === 0 || file.startsWith(prefix)
  })
}

function laneHotspots(profile: ProjectProfile, changedFiles: string[]): RepoPlanningSnapshot["laneHotspots"] {
  return profile.planner.allowedLanes
    .map((laneId) => {
      const lane = profile.laneDefinitions.find((entry) => entry.laneId === laneId)
      if (!lane) return null
      const matched = changedFiles.filter((file) => fileMatchesLane(file, lane))
      return {
        laneId,
        fileCount: matched.length,
        files: matched.slice(0, 20)
      }
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    .sort((left, right) => right.fileCount - left.fileCount)
}

function laneInventory(profile: ProjectProfile, files: string[]): RepoPlanningSnapshot["laneInventory"] {
  return profile.laneDefinitions.map((lane) => {
    const matched = files.filter((file) => fileMatchesLane(file, lane))
    const testFiles = matched.filter((file) => /(^|\/)(tests?|__tests__|e2e)(\/|$)|\.(test|spec)\./i.test(file))
    return {
      laneId: lane.laneId,
      fileCount: matched.length,
      testFileCount: testFiles.length,
      publicFacades: Array.from(new Set(lane.publicFacades ?? [])).slice(0, 8),
      sampleFiles: matched.slice(0, 12)
    }
  })
}

function directives(project: Project): string[] {
  const files = [
    join(project.repoPath, ".openclaw", "program.md"),
    join(project.repoPath, "AGENTS.md"),
    join(project.repoPath, "README.md")
  ]
  return files
    .filter((path) => existsSync(path))
    .flatMap((path) =>
      readFileSync(path, "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 20)
    )
    .slice(0, 40)
}

export function collectRepoPlanningSnapshot(input: {
  project: Project
  profile: ProjectProfile
  tasks: Task[]
  memoryHighlights: string[]
  outcomeStats?: LaneOutcomeStats[]
  excludedStaleTaskIds?: ReadonlySet<string>
}): RepoPlanningSnapshot {
  const changed = gitChangedFiles(input.project)
  const inventoryFiles = trackedFiles(input.project)
  const staleStatuses = new Set(["queued", "running", "blocked", "review_needed", "promotion_pending"])
  const now = Date.now()
  const verificationCommands = Array.from(new Set(input.profile.verificationRules.flatMap((rule) => rule.commands)))
  const activeCollectors = input.profile.planner.signalCollectors as PlannerSignalCollectorKind[]
  const hotspots = laneHotspots(input.profile, changed)
  const outcomeStats = input.outcomeStats ?? []
  const laneProposals = proposeLanesFromSignals({
    hotspots,
    stats: outcomeStats,
    existingLaneIds: input.profile.laneDefinitions.map((lane) => lane.laneId)
  })

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    projectId: input.project.id,
    projectName: input.project.name,
    repoPath: input.project.repoPath,
    profileId: input.profile.profileId,
    projectVerifyCommand: input.project.verifyCommand,
    changedFiles: changed,
    laneHotspots: hotspots,
    laneInventory: laneInventory(input.profile, inventoryFiles),
    verificationCommands,
    staleTasks: input.tasks
      .filter(
        (task) =>
          staleStatuses.has(task.status) &&
          !task.labels.includes("deterministic-fallback") &&
          !input.excludedStaleTaskIds?.has(task.id)
      )
      .map((task) => ({
        id: task.id,
        title: task.title,
        kind: task.kind,
        status: task.status,
        laneId: task.laneId,
        ageHours: Number.isFinite(Date.parse(task.createdAt))
          ? Math.round(((now - Date.parse(task.createdAt)) / (1000 * 60 * 60)) * 10) / 10
          : null
      }))
      .slice(0, 30),
    promotionBlockers: input.tasks
      .filter((task) => task.kind === "promote" && (task.status === "blocked" || task.status === "queued"))
      .map((task) => ({
        taskId: task.id,
        title: task.title,
        status: task.status,
        laneId: task.laneId
      }))
      .slice(0, 20),
    memoryHighlights: input.memoryHighlights.slice(0, 20),
    directives: directives(input.project),
    todoFixmeHits: activeCollectors.includes("todo_fixme") ? todoFixmeHits(input.project, input.profile) : [],
    sourceCollectors: activeCollectors,
    laneOutcomeStats: outcomeStats,
    laneProposals
  }
}
