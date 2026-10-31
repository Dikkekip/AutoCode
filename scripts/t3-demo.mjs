import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"
import { loadProjectProfile } from "../packages/project-profiles/dist/index.js"
import {
  captureT3Source,
  resolveT3Personas,
  T3CallbackTransport,
  T3Coordinator,
  T3Host,
  T3Journal,
  T3WorkflowEngine,
  verifyT3Candidate
} from "../packages/t3-runtime/dist/index.js"

const args = process.argv.slice(2)
if (args.length !== 2 || args[0] !== "--image" || !/^sha256:[a-f0-9]{64}$/.test(args[1])) {
  console.error("Usage: node scripts/t3-demo.mjs --image sha256:<local protected fixture verifier image ID>")
  process.exit(2)
}
const image = args[1]
const directory = mkdtempSync(join(tmpdir(), "autocode-t3-demo-"))
const repository = join(directory, "repository")
const fixtureWorktree = join(directory, "simulated-host-worktree")
const privateRoot = join(directory, "verifier")
mkdirSync(privateRoot, { mode: 0o700 })
const git = (cwd, ...argv) => execFileSync("git", ["-C", cwd, ...argv], { encoding: "utf8", timeout: 10_000 }).trim()
execFileSync("git", ["init", "--quiet", repository])
writeFileSync(join(repository, "value.json"), '{"value":1}\n')
git(repository, "add", ".")
const commit = (cwd, message) =>
  git(cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", message)
commit(repository, "Fixture baseline")
const source = captureT3Source(repository)
const profile = loadProjectProfile("minimal-repo")
profile.personas.push({
  id: "fixture-safety-researcher",
  extends: "security-engineer",
  responsibilities: ["Investigate exact fixture values with source evidence"]
})
profile.managerStateDefaults.managerPersonas.push({
  id: "fixture-safety-researcher",
  focus: "Deterministic fixture behavior",
  ownedLaneIds: ["backend"],
  preferredAdapterType: "codex_local",
  ideationPrompt: "Explain the value mismatch from committed source before proposing any change",
  successSignals: ["Protected acceptance passes"],
  blockedEscalation: "Retain uncertainty and ask the fixture owner",
  taskQuotaWeight: 2
})
const personas = resolveT3Personas(profile)
const journal = new T3Journal(join(directory, "evidence.sqlite"))
let lease = journal.acquire("fixture-project", 120_000)
assert(lease)
const engine = new T3WorkflowEngine(
  journal,
  {
    goal: "Return the agreed fixture value",
    lanes: ["backend"],
    maxAdmitted: 1,
    maxDispatches: 10,
    estimatedTokenBudget: 10_000,
    maxRepairs: 1,
    deadline: Date.now() + 120_000,
    rolePersonas: {
      research: ["fixture-safety-researcher"],
      planner: ["planner"],
      design: ["cto-system-architect"],
      implementation: ["backend-engineer"],
      verification: ["qa-engineer"],
      review: ["code-reviewer"],
      release: ["release-manager"]
    }
  },
  personas
)
const content =
  "Preserve the full persona contract, inspect exact committed source, and return only the bound role result."
const skill = { content, digest: createHash("sha256").update(content).digest("hex") }
const transcript = []
const tasks = new Map()
let candidateRevision
const host = new T3Host(
  new T3CallbackTransport(async (name, arguments_) => {
    transcript.push({ name, arguments: arguments_ })
    if (name === "orchestrator_capabilities")
      return {
        parentThreadId: "fixture-parent",
        inheritedProviderInstanceId: "fixture-provider",
        runtimeMode: "full-access",
        features: { appOwnedSubagents: true, cancellation: true, scheduledTasks: true },
        providers: [
          {
            providerInstanceId: "fixture-provider",
            driverKind: "codex",
            canRunChildTask: true,
            canRunCrossProviderChildTask: true,
            constraints: [],
            models: [{ id: "scripted-fixture", options: [] }]
          }
        ]
      }
    if (name === "t3_project_read") return { id: "fixture-t3-project", workspaceRoot: repository }
    if (name === "t3_thread_read")
      return {
        thread:
          arguments_.threadId === "fixture-parent"
            ? { threadId: "fixture-parent", projectId: "fixture-t3-project", archived: false, worktreePath: null }
            : {
                threadId: "fixture-implementation",
                parentThreadId: "fixture-parent",
                relationshipToParent: "subagent",
                projectId: "fixture-t3-project",
                worktreePath: fixtureWorktree
              }
      }
    if (name === "delegate_task") {
      const binding = JSON.parse(arguments_.task.split("\nBinding: ").at(-1))
      const taskId = `fixture-${binding.role}`
      assert(arguments_.task.includes(personas.find((p) => p.digest === binding.personaDigest).definition.id))
      if (binding.role === "research") assert(arguments_.task.includes("Explain the value mismatch"))
      if (binding.role === "implementation") {
        assert.equal(arguments_.isolation, "worktree")
        // This checkout belongs to the scripted host fixture. No real T3 task or agent is created.
        git(repository, "worktree", "add", "--quiet", "--detach", fixtureWorktree, source.revision)
        writeFileSync(join(fixtureWorktree, "value.json"), '{"value":2}\n')
        git(fixtureWorktree, "add", ".")
        commit(fixtureWorktree, "Implement fixture proposal")
        candidateRevision = git(fixtureWorktree, "rev-parse", "HEAD")
      }
      tasks.set(taskId, binding)
      return {
        taskId,
        providerInstanceId: "fixture-provider",
        model: "scripted-fixture",
        options: [],
        childThreadId: binding.role === "implementation" ? "fixture-implementation" : `fixture-${binding.role}-thread`,
        status: "running",
        link: null,
        next: "Completion wakes this thread, so end your turn. Do not wait on it or poll it."
      }
    }
    if (name === "task_status") {
      const binding = tasks.get(arguments_.taskId)
      assert(binding)
      const results = {
        research: {
          proposal: {
            title: "Correct fixture value",
            problem: "Committed fixture returns 1 while acceptance requires 2",
            goal: engine.policy.goal,
            lane: "backend",
            scope: ["value.json"],
            inspectedPaths: ["value.json"],
            acceptance: ["Fixture value equals 2"],
            dependencies: [],
            risk: "high",
            estimatedTokens: 1000
          }
        },
        planner: { decision: "admit", reason: "Concrete source mismatch, bounded scope and available budget" },
        design: {
          approved: true,
          reason: "Only the fixture value changes; immutable harness independently judges acceptance"
        },
        implementation: { revision: candidateRevision },
        verification: {
          analysis: "A protected host verifier must run; this scripted message is not verification evidence"
        },
        review: {
          revision: candidateRevision,
          accepted: true,
          findings: [],
          criteria: [
            {
              criterion: "Fixture value equals 2",
              passed: true,
              evidence: "Fixture-only scripted review, bound to the actual protected verifier receipt"
            }
          ]
        },
        release: { ready: true }
      }
      return {
        taskId: arguments_.taskId,
        providerInstanceId: "fixture-provider",
        model: "scripted-fixture",
        options: [],
        status: "completed",
        hasPendingChildRuns: false,
        hasPendingQuestion: false,
        workState: "result_available",
        latestTerminalStatus: "completed",
        latestTerminalRunId: `fixture-run-${binding.role}`,
        summary: JSON.stringify({ ...binding, result: results[binding.role] })
      }
    }
    throw new Error(`Unexpected fixture tool: ${name}`)
  })
)
const coordinator = new T3Coordinator(engine, host, {
  parentThreadId: "fixture-parent",
  projectId: "fixture-t3-project",
  researchBoundary: "accept-prompt-only",
  routes: { codex_local: { providerInstanceId: "fixture-provider", model: "scripted-fixture", options: {} } }
})

try {
  const research = coordinator.researchTick(lease, source, skill.digest)[0]
  assert(research)
  assert.equal(coordinator.researchTick(lease, source, skill.digest)[0].id, research.id)
  const stages = [research.board]
  for (let i = 0; i < 7; i++) {
    const item = engine.get(lease.projectId, research.id).value
    const dispatched = await coordinator.dispatch(lease, item.id, skill, 500)
    // Simulate separate coordinator turns on completion. No live delegate is running or polled.
    journal.release(lease)
    lease = journal.acquire("fixture-project", 120_000)
    assert(lease)
    await coordinator.onCompletionWake(lease, item.id, dispatched.assignmentId, `fixture-wake-${i}`)
    if (item.phase === "verification") {
      await verifyT3Candidate({
        journal,
        lease,
        assignmentId: dispatched.assignmentId,
        source,
        candidate: item.candidate,
        privateRoot,
        policy: {
          image,
          argv: ["/opt/autocode/verifier/check"],
          timeoutMs: 15_000,
          maxSourceBytes: 1024 * 1024,
          maxFileBytes: 1024 * 1024
        }
      })
    }
    const updated = await coordinator.applyCompletedResult(lease, item.id, dispatched.assignmentId)
    stages.push(updated.board)
  }
  const final = engine.get(lease.projectId, research.id).value
  assert.equal(final.phase, "ready")
  assert.equal(final.board, "PR approved")
  assert.equal(final.mergedRevision, null)
  assert(final.verification.passed)
  assert(isAbsolute(directory))
  const summary = {
    evidenceLevel: "Scripted T3 host fixture; actual isolated Docker verification; no live T3 workers",
    workflowId: final.id,
    sourceRevision: source.revision,
    candidateRevision: final.candidate.revision,
    candidateTreeDigest: final.candidate.treeDigest,
    personaIds: final.assignments.map((a) => a.personaId),
    stages,
    phase: final.phase,
    verification: final.verification,
    usage: engine.usage(lease.projectId),
    schedule: coordinator.scheduleRequest(60_000),
    goalCommand: coordinator.goalCommand(),
    published: false,
    merged: false,
    deployed: false,
    recurringScheduleActivated: false
  }
  writeFileSync(join(directory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 })
  writeFileSync(join(directory, "host-fixture-transcript.json"), `${JSON.stringify(transcript, null, 2)}\n`, {
    mode: 0o600
  })
  console.log(
    JSON.stringify(
      { phase: final.phase, evidenceLevel: summary.evidenceLevel, summary: join(directory, "summary.json") },
      null,
      2
    )
  )
} finally {
  if (lease) journal.release(lease)
  journal.close()
}
