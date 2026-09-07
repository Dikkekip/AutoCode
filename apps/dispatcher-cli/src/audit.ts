import { existsSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"
import type { DispatcherStore } from "@openclaw/db"

export interface AuditCheckResult {
  name: string
  passed: boolean
  pointsEarned: number
  pointsPossible: number
  notes: string
}

export interface AuditReport {
  repoPath: string
  score: number
  level: "L0" | "L1" | "L2" | "L3"
  levelDescription: string
  checks: AuditCheckResult[]
  recommendations: string[]
}

export function auditProject(repoPath: string, store?: DispatcherStore | null): AuditReport {
  const resolvedPath = resolve(repoPath)
  const checks: AuditCheckResult[] = []

  // Check 1: Loop Cadence & Config (25 pts possible)
  let loopMdExists = false
  if (existsSync(join(resolvedPath, "LOOP.md")) || existsSync(join(resolvedPath, ".openclaw", "LOOP.md"))) {
    loopMdExists = true
  }
  checks.push({
    name: "Loop Cadence Documentation (LOOP.md)",
    passed: loopMdExists,
    pointsEarned: loopMdExists ? 15 : 0,
    pointsPossible: 15,
    notes: loopMdExists ? "LOOP.md file found." : "Missing LOOP.md file outlining loop goals and cadence."
  })

  let jobsConfigured = false
  if (store) {
    try {
      const jobs = store.listJobSpecs()
      if (jobs.length > 0) {
        jobsConfigured = true
      }
    } catch {
      // Ignored
    }
  }
  checks.push({
    name: "Dispatcher Cron Jobs Configured",
    passed: jobsConfigured,
    pointsEarned: jobsConfigured ? 10 : 0,
    pointsPossible: 10,
    notes: jobsConfigured
      ? "Loop schedules configured in dispatcher database."
      : "No scheduled cron jobs found in the runtime store."
  })

  // Check 2: Active Loop State (20 pts possible)
  let stateFileExists = false
  if (
    existsSync(join(resolvedPath, "STATE.md")) ||
    existsSync(join(resolvedPath, ".openclaw", "STATE.md")) ||
    existsSync(join(resolvedPath, ".openclaw", "state", "README.md"))
  ) {
    stateFileExists = true
  }
  checks.push({
    name: "Durable State File (STATE.md)",
    passed: stateFileExists,
    pointsEarned: stateFileExists ? 10 : 0,
    pointsPossible: 10,
    notes: stateFileExists ? "Durable state file found." : "Missing STATE.md to track loop memory and active issues."
  })

  let storeHasTasks = false
  if (store) {
    try {
      const projects = store.listProjects()
      const project = projects.find((p) => resolve(p.repoPath) === resolvedPath)
      if (project) {
        const tasks = store.listProjectTasks(project.id)
        if (tasks.length > 0) {
          storeHasTasks = true
        }
      }
    } catch {
      // Ignored
    }
  }
  checks.push({
    name: "Dispatcher Task Queues",
    passed: storeHasTasks,
    pointsEarned: storeHasTasks ? 10 : 0,
    pointsPossible: 10,
    notes: storeHasTasks
      ? "Active or completed tasks found in queue database."
      : "No tasks registered in dispatcher queue database."
  })

  // Check 3: Adoption Policies & Profiles (15 pts possible)
  const profileJsonExists = existsSync(join(resolvedPath, ".openclaw", "profile.json"))
  checks.push({
    name: "Project Profile (profile.json)",
    passed: profileJsonExists,
    pointsEarned: profileJsonExists ? 5 : 0,
    pointsPossible: 5,
    notes: profileJsonExists ? "profile.json configured." : "Missing .openclaw/profile.json."
  })

  const policyJsonExists =
    existsSync(join(resolvedPath, ".openclaw", "policy.json")) ||
    existsSync(join(resolvedPath, "policy.json")) ||
    existsSync(join(resolvedPath, ".openclaw", "profile.json")) // profile.json often acts as fallback
  checks.push({
    name: "Governance and Risk Policy",
    passed: policyJsonExists,
    pointsEarned: policyJsonExists ? 10 : 0,
    pointsPossible: 10,
    notes: policyJsonExists
      ? "Policy file or adoption rules configured."
      : "No policy.json found; loops will use defaults."
  })

  // Check 4: Autonomy Skills (20 pts possible)
  const skillsDir = join(resolvedPath, ".openclaw", "skills")
  let skillsList: string[] = []
  if (existsSync(skillsDir)) {
    try {
      skillsList = readdirSync(skillsDir).map((s) => s.toLowerCase().replace(/\.md$/, ""))
    } catch {
      // Ignored
    }
  }

  const hasTriage = skillsList.includes("loop-triage")
  const hasVerifier = skillsList.includes("loop-verifier")
  const hasBudget = skillsList.includes("loop-budget")
  const hasMinFix = skillsList.includes("minimal-fix")

  let loopSkillsScore = 0
  if (hasTriage) loopSkillsScore += 3
  if (hasVerifier) loopSkillsScore += 3
  if (hasBudget) loopSkillsScore += 3
  if (hasMinFix) loopSkillsScore += 3

  checks.push({
    name: "Loop Autonomy Skills (Triage, Verifier, Budget, Minimal Fix)",
    passed: hasTriage && hasVerifier && hasBudget && hasMinFix,
    pointsEarned: loopSkillsScore,
    pointsPossible: 12,
    notes: `Found ${[hasTriage && "triage", hasVerifier && "verifier", hasBudget && "budget", hasMinFix && "minimal-fix"].filter(Boolean).join(", ") || "none"} loop skills.`
  })

  const hasRecovery = skillsList.includes("error-recovery")
  const hasReflect = skillsList.includes("reflect")
  const hasMemory = skillsList.includes("tiered-memory")

  let generalSkillsScore = 0
  if (hasRecovery) generalSkillsScore += 2
  if (hasReflect) generalSkillsScore += 2
  if (hasMemory) generalSkillsScore += 2

  checks.push({
    name: "General Autonomy Skills (Recovery, Reflect, Memory)",
    passed: hasRecovery && hasReflect && hasMemory,
    pointsEarned: generalSkillsScore,
    pointsPossible: 6,
    notes: `Found ${[hasRecovery && "recovery", hasReflect && "reflect", hasMemory && "memory"].filter(Boolean).join(", ") || "none"} general skills.`
  })

  const customSkillsCount = skillsList.filter(
    (s) =>
      ![
        "loop-triage",
        "loop-verifier",
        "loop-budget",
        "minimal-fix",
        "error-recovery",
        "reflect",
        "tiered-memory"
      ].includes(s)
  ).length
  checks.push({
    name: "Custom Project Skills",
    passed: customSkillsCount > 0,
    pointsEarned: customSkillsCount > 0 ? 2 : 0,
    pointsPossible: 2,
    notes:
      customSkillsCount > 0 ? `Found ${customSkillsCount} custom skill file(s).` : "No custom project-specific skills."
  })

  // Check 5: Budget Controls & Spend Logs (20 pts possible)
  let budgetControlExists = false
  if (
    existsSync(join(resolvedPath, "loop-budget.md")) ||
    existsSync(join(resolvedPath, ".openclaw", "loop-budget.md"))
  ) {
    budgetControlExists = true
  }
  checks.push({
    name: "Budget Limits (loop-budget.md)",
    passed: budgetControlExists,
    pointsEarned: budgetControlExists ? 10 : 0,
    pointsPossible: 10,
    notes: budgetControlExists
      ? "loop-budget.md file configured."
      : "Missing loop-budget.md to enforce token spend ceilings."
  })

  let runsExists = false
  if (
    existsSync(join(resolvedPath, "loop-run-log.md")) ||
    existsSync(join(resolvedPath, ".openclaw", "loop-run-log.md"))
  ) {
    runsExists = true
  } else if (store) {
    try {
      const runs = store.listRuns(5)
      if (runs.length > 0) {
        runsExists = true
      }
    } catch {
      // Ignored
    }
  }
  checks.push({
    name: "Run / Spend Logs (loop-run-log.md)",
    passed: runsExists,
    pointsEarned: runsExists ? 10 : 0,
    pointsPossible: 10,
    notes: runsExists ? "Historical run records found." : "Missing run logs/records of loop executions."
  })

  // Calculate Score and Level
  const score = checks.reduce((sum, c) => sum + c.pointsEarned, 0)
  let level: "L0" | "L1" | "L2" | "L3" = "L0"
  let levelDescription = ""

  if (score < 30) {
    level = "L0"
    levelDescription = "Ground Zero (No autonomous configuration or state tracking)"
  } else if (score < 60) {
    level = "L1"
    levelDescription = "Assisted Reporting (Read-Only triage, no unattended edits)"
  } else if (score < 85) {
    level = "L2"
    levelDescription = "Guarded Operations (Unattended edits allowed, gated by verifiers/caps)"
  } else {
    level = "L3"
    levelDescription = "Fully Autonomous Execution (Safe, self-governing loops)"
  }

  // Compile Recommendations
  const recommendations: string[] = []
  if (!loopMdExists) {
    recommendations.push("- Create `LOOP.md` or `.openclaw/LOOP.md` to define loop goals, cadence, and human gates.")
  }
  if (!stateFileExists) {
    recommendations.push("- Create `STATE.md` to provide a dashboard of active loop issues and tasks.")
  }
  if (!hasTriage || !hasVerifier || !hasBudget || !hasMinFix) {
    recommendations.push(
      "- Seed the loop autonomy skills (`loop-triage`, `loop-verifier`, `loop-budget`, `minimal-fix`) into `.openclaw/skills/`."
    )
  }
  if (!budgetControlExists) {
    recommendations.push("- Establish a `loop-budget.md` file setting daily token limits and kill switches.")
  }
  if (!runsExists) {
    recommendations.push("- Set up `loop-run-log.md` to record loop iterations and token expenditure.")
  }
  if (!jobsConfigured) {
    recommendations.push("- Configure dispatcher cron jobs to run automations periodically.")
  }

  return {
    repoPath: resolvedPath,
    score,
    level,
    levelDescription,
    checks,
    recommendations
  }
}

export function renderAuditSummary(report: AuditReport): string[] {
  const scoreBar = "█".repeat(Math.round(report.score / 5)) + "░".repeat(20 - Math.round(report.score / 5))
  const lines: string[] = [
    "OpenClaw Loop Readiness Audit",
    "==================================================",
    `Repo Path:   ${report.repoPath}`,
    `Score:       ${report.score}/100  [${scoreBar}]`,
    `Level:       ${report.level} - ${report.levelDescription}`,
    "",
    "Checks Checklist:",
    "--------------------------------------------------"
  ]

  for (const c of report.checks) {
    const status = c.passed ? "[PASS]" : "[FAIL]"
    lines.push(`${status.padEnd(7)} ${c.name} (${c.pointsEarned}/${c.pointsPossible} pts)`)
    lines.push(`        Note: ${c.notes}`)
  }

  if (report.recommendations.length > 0) {
    lines.push("", "Recommendations to graduate to next level:")
    lines.push("--------------------------------------------------")
    for (const r of report.recommendations) {
      lines.push(r)
    }
  }

  lines.push("", "Docs: docs/framework-map.md")
  return lines
}
