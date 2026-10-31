import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  captureT3Source,
  resolveT3Personas,
  retainT3DispatchBrief,
  T3CallbackTransport,
  T3Coordinator,
  T3Host,
  T3Journal,
  T3WorkflowEngine
} from "@autocode/t3-runtime"
import { loadProjectProfile } from "@openclaw/project-profiles"
import { afterEach, describe, expect, it } from "vitest"

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "autocode-t3-coordinator-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const repository = join(dir, "repo")
  execFileSync("git", ["init", "--quiet", repository])
  writeFileSync(join(repository, "source.ts"), "export const ready = true\n")
  execFileSync("git", ["-C", repository, "add", "."])
  execFileSync("git", [
    "-C",
    repository,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture"
  ])
  const source = captureT3Source(repository)
  const journal = new T3Journal(join(dir, "journal.sqlite"))
  cleanups.push(() => journal.close())
  const lease = journal.acquire("autocode-project")!
  const personas = resolveT3Personas(loadProjectProfile("minimal-repo"))
  const engine = new T3WorkflowEngine(
    journal,
    {
      goal: "Fix backend",
      lanes: ["backend"],
      maxAdmitted: 1,
      maxDispatches: 20,
      estimatedTokenBudget: 20_000,
      maxRepairs: 1,
      deadline: Date.now() + 60_000,
      rolePersonas: {
        research: ["backend-engineer"],
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
  engine.startResearch(lease, "research-one", "backend-engineer", source)
  const capabilities = {
    parentThreadId: "parent",
    inheritedProviderInstanceId: "codex-instance",
    runtimeMode: "full-access",
    features: { appOwnedSubagents: true, cancellation: true, scheduledTasks: true },
    providers: [
      {
        providerInstanceId: "codex-instance",
        driverKind: "codex",
        canRunChildTask: true,
        canRunCrossProviderChildTask: true,
        constraints: [],
        models: [{ id: "fixture-model", options: [{ id: "effort", values: ["medium"] }] }]
      }
    ]
  }
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  let behavior: ((name: string, args: Record<string, unknown>) => unknown) | undefined
  const host = new T3Host(
    new T3CallbackTransport(async (name, args) => {
      calls.push({ name, args })
      const custom = behavior?.(name, args)
      if (custom !== undefined) return custom
      if (name === "orchestrator_capabilities") return capabilities
      if (name === "t3_thread_read")
        return { thread: { threadId: "parent", projectId: "t3-project", archived: false, worktreePath: null } }
      if (name === "t3_project_read") return { workspaceRoot: repository }
      if (name === "delegate_task")
        return {
          taskId: "host-task",
          model: "fixture-model",
          options: [{ id: "effort", value: "medium" }],
          providerInstanceId: "codex-instance",
          status: "running",
          next: "Completion wakes this thread, so end your turn. Do not wait on it or poll it.",
          link: "t3://fixture-child"
        }
      if (name === "task_cancel") return { taskId: "host-task", status: "cancel_requested" }
      throw new Error(`Unexpected fixture tool ${name}`)
    })
  )
  const config = {
    parentThreadId: "parent",
    projectId: "t3-project",
    researchBoundary: "accept-prompt-only" as const,
    routes: {
      codex_local: { providerInstanceId: "codex-instance", model: "fixture-model", options: { effort: "medium" } }
    }
  }
  const coordinator = new T3Coordinator(engine, host, config)
  const content = "Inspect source without implementing."
  const skill = { content, digest: createHash("sha256").update(content).digest("hex") }
  function completedResult() {
    const assignment = engine.get(lease.projectId, "research-one").value.assignments.at(-1)!
    return {
      taskId: "host-task",
      model: "fixture-model",
      options: [{ id: "effort", value: "medium" }],
      providerInstanceId: "codex-instance",
      status: "completed",
      hasPendingChildRuns: false,
      hasPendingQuestion: false,
      workState: "result_available",
      latestTerminalStatus: "completed",
      latestTerminalRunId: "host-run",
      summary: JSON.stringify({
        assignmentId: assignment.id,
        role: assignment.role,
        revision: assignment.revision,
        personaDigest: assignment.personaDigest,
        promptDigest: assignment.promptDigest,
        sourceManifestDigest: source.digest,
        result: { noOp: "Source satisfies goal", inspectedPaths: ["source.ts"] }
      })
    }
  }
  return {
    source,
    repository,
    engine,
    journal,
    lease,
    coordinator,
    host,
    config,
    capabilities,
    calls,
    skill,
    completedResult,
    setBehavior: (callback: typeof behavior) => {
      behavior = callback
    }
  }
}

describe("event-driven T3 coordinator", () => {
  it("dispatches the actual persona prompt once and reattaches a durable receipt after restart", async () => {
    const f = fixture()
    const result = await f.coordinator.dispatch(f.lease, "research-one", f.skill, 100)
    expect(result.next).toContain("end your turn")
    const delegate = f.calls.find((call) => call.name === "delegate_task")!
    expect(delegate.args).toMatchObject({
      isolation: "shared",
      mode: "async",
      target: { providerInstanceId: "codex-instance", options: { effort: "medium" } }
    })
    const launch = String(delegate.args.task)
    expect(launch.length).toBeLessThan(3000)
    const brief = readFileSync(JSON.parse(launch.match(/Brief: (.+)/)![1]!), "utf8")
    expect(brief).toContain("Backend Engineer")
    expect(brief).toContain("accept-prompt-only")
    expect(brief).toContain('"governance"')
    expect(launch).toContain(createHash("sha256").update(brief).digest("hex"))
    const restarted = new T3Coordinator(f.engine, f.host, f.config)
    expect((await restarted.dispatch(f.lease, "research-one", f.skill, 100)).taskId).toBe(result.taskId)
    expect(f.calls.filter((call) => call.name === "delegate_task")).toHaveLength(1)
    expect(f.calls.some((call) => call.name === "task_status")).toBe(false)
    expect(f.engine.usage(f.lease.projectId).dispatches).toBe(1)
  })

  it("records uncertain sends and refuses to replay even when the reply was lost", async () => {
    const f = fixture()
    f.setBehavior((name) => {
      if (name === "delegate_task") throw new Error("Lost connection after send")
    })
    await expect(f.coordinator.dispatch(f.lease, "research-one", f.skill, 100)).rejects.toThrow("Lost connection")
    await expect(f.coordinator.dispatch(f.lease, "research-one", f.skill, 100)).rejects.toThrow("outcome uncertain")
    const assignment = f.engine.get(f.lease.projectId, "research-one").value.assignments.at(-1)!
    expect(f.journal.effect(`delegate:${assignment.id}`)?.status).toBe("uncertain")
    expect(f.calls.filter((call) => call.name === "delegate_task")).toHaveLength(1)
  })

  it("atomically imports a bound completion wake, deduplicates it, and requires result application", async () => {
    const f = fixture()
    const { assignmentId } = await f.coordinator.dispatch(f.lease, "research-one", f.skill, 100)
    f.setBehavior((name) => (name === "task_status" ? f.completedResult() : undefined))
    const result = await f.coordinator.onCompletionWake(f.lease, "research-one", assignmentId, "wake-one")
    expect(result.result).toMatchObject({ noOp: "Source satisfies goal" })
    expect(await f.coordinator.onCompletionWake(f.lease, "research-one", assignmentId, "wake-two")).toEqual(result)
    expect(f.calls.filter((call) => call.name === "task_status")).toHaveLength(1)
    await expect(f.coordinator.dispatch(f.lease, "research-one", f.skill, 100)).rejects.toThrow(
      "Import the observed result"
    )
    f.engine.completeResearch(f.lease, "research-one", assignmentId, {
      noOp: "Source satisfies goal",
      inspectedPaths: ["source.ts"]
    })
    expect(f.engine.get(f.lease.projectId, "research-one").value.phase).toBe("no-op")
  })

  it("refuses pending descendants and forged output bindings", async () => {
    const f = fixture()
    const { assignmentId } = await f.coordinator.dispatch(f.lease, "research-one", f.skill, 100)
    f.setBehavior((name) =>
      name === "task_status" ? { ...f.completedResult(), hasPendingChildRuns: true } : undefined
    )
    await expect(f.coordinator.onCompletionWake(f.lease, "research-one", assignmentId, "wake")).rejects.toThrow(
      "pending work"
    )
    f.setBehavior((name) =>
      name === "task_status"
        ? { ...f.completedResult(), summary: JSON.stringify({ assignmentId: "other" }) }
        : undefined
    )
    await expect(f.coordinator.onCompletionWake(f.lease, "research-one", assignmentId, "wake")).rejects.toThrow(
      "binding mismatch"
    )
    expect(f.journal.read(f.lease.projectId, "completion", assignmentId)).toBeNull()
  })

  it("fails closed on unsupported tool restrictions, unavailable providers and wrong checkout binding", async () => {
    const f = fixture()
    const restricted = new T3Coordinator(f.engine, f.host, { ...f.config, researchBoundary: "require-tool-allowlist" })
    await expect(restricted.dispatch(f.lease, "research-one", f.skill, 100)).rejects.toThrow(
      "Unsupported T3 capability"
    )
    expect(f.calls).toHaveLength(0)
    f.capabilities.providers[0]!.canRunChildTask = false
    await expect(f.coordinator.dispatch(f.lease, "research-one", f.skill, 100)).rejects.toThrow("provider unavailable")
    f.capabilities.providers[0]!.canRunChildTask = true
    f.setBehavior((name) => (name === "t3_project_read" ? { workspaceRoot: tmpdir() } : undefined))
    const moved = new T3Coordinator(f.engine, f.host, f.config)
    await expect(moved.dispatch(f.lease, "research-one", f.skill, 100)).rejects.toThrow("checkout does not match")
    expect(f.calls.some((call) => call.name === "delegate_task")).toBe(false)
  })

  it("freezes admission immediately while cancellation remains pending until a terminal wake", async () => {
    const f = fixture()
    const { assignmentId } = await f.coordinator.dispatch(f.lease, "research-one", f.skill, 100)
    f.engine.setControl(f.lease, "frozen", "Operator stop")
    await f.coordinator.cancelAssignment(f.lease, "research-one", assignmentId, "Operator stop")
    await f.coordinator.cancelAssignment(f.lease, "research-one", assignmentId, "Operator stop")
    expect(f.calls.filter((call) => call.name === "task_cancel")).toHaveLength(1)
    expect(f.engine.get(f.lease.projectId, "research-one").value.assignments.at(-1)?.status).toBe("running")
    await expect(f.coordinator.dispatch(f.lease, "research-one", f.skill, 100)).rejects.toThrow("paused or frozen")
    f.setBehavior((name) =>
      name === "task_status"
        ? { ...f.completedResult(), status: "cancelled", latestTerminalStatus: "cancelled", summary: null }
        : undefined
    )
    await f.coordinator.onCompletionWake(f.lease, "research-one", assignmentId, "cancel-wake")
    f.engine.cancel(f.lease, "research-one", "Cancellation observed")
    expect(f.engine.get(f.lease.projectId, "research-one").value.phase).toBe("cancelled")
  })

  it("prepares a disabled schedule and native goal command without creating host work", () => {
    const f = fixture()
    expect(() => f.coordinator.scheduleRequest(1000)).toThrow("at least 60000ms")
    expect(f.coordinator.scheduleRequest(60_000)).toMatchObject({
      enabled: false,
      bindToCurrentThread: true,
      schedule: { type: "interval", everyMs: 60_000 }
    })
    expect(f.coordinator.goalCommand()).toBe("/goal Fix backend")
    expect(f.calls).toHaveLength(0)
  })

  it("persists a disabled schedule once and retains an uncertain lost reply", async () => {
    const f = fixture()
    f.setBehavior((name) =>
      name === "schedule_task"
        ? {
            scheduledTaskId: "schedule-one",
            enabled: false,
            projectId: "t3-project",
            boundThreadId: "parent"
          }
        : undefined
    )
    expect(await f.coordinator.saveDisabledSchedule(f.lease, 60_000)).toMatchObject({ enabled: false })
    await f.coordinator.saveDisabledSchedule(f.lease, 60_000)
    expect(f.calls.filter((call) => call.name === "schedule_task")).toHaveLength(1)
    f.setBehavior((name) => {
      if (name === "schedule_task") throw new Error("Lost schedule reply")
    })
    await expect(f.coordinator.saveDisabledSchedule(f.lease, 120_000)).rejects.toThrow("Lost schedule reply")
    await expect(f.coordinator.saveDisabledSchedule(f.lease, 120_000)).rejects.toThrow("outcome uncertain")
    expect(f.calls.filter((call) => call.name === "schedule_task")).toHaveLength(2)
  })

  it("settles a pre-run interruption without inventing a run identity", async () => {
    const f = fixture()
    const { assignmentId } = await f.coordinator.dispatch(f.lease, "research-one", f.skill, 100)
    f.setBehavior((name) =>
      name === "task_status"
        ? {
            ...f.completedResult(),
            status: "interrupted",
            latestTerminalStatus: null,
            latestTerminalRunId: null,
            childRunId: null,
            summary: null
          }
        : undefined
    )
    await f.coordinator.onCompletionWake(f.lease, "research-one", assignmentId, "interruption-wake")
    expect(f.engine.get(f.lease.projectId, "research-one").value.assignments.at(-1)).toMatchObject({
      status: "cancelled",
      runId: null
    })
  })

  it("retains an uncertain dispatch when the host returns a different model", async () => {
    const f = fixture()
    f.setBehavior((name) =>
      name === "delegate_task"
        ? {
            taskId: "host-task",
            providerInstanceId: "codex-instance",
            model: "unexpected-model",
            status: "running",
            next: "End your turn",
            link: "t3://fixture-child"
          }
        : undefined
    )
    await expect(f.coordinator.dispatch(f.lease, "research-one", f.skill, 100)).rejects.toThrow()
    const assignment = f.engine.get(f.lease.projectId, "research-one").value.assignments.at(-1)!
    expect(f.journal.effect(`delegate:${assignment.id}`)?.status).toBe("uncertain")
    await expect(f.coordinator.dispatch(f.lease, "research-one", f.skill, 100)).rejects.toThrow("outcome uncertain")
    expect(f.calls.filter((call) => call.name === "delegate_task")).toHaveLength(1)
  })

  it("deduplicates ticks while giving a changed policy a distinct investigation", () => {
    const f = fixture()
    const first = f.coordinator.researchTick(f.lease, f.source, f.skill.digest)[0]!
    expect(f.coordinator.researchTick(f.lease, f.source, f.skill.digest)[0]?.id).toBe(first.id)
    const changed = new T3WorkflowEngine(f.journal, { ...f.engine.policy, maxDispatches: 21 }, [
      ...f.engine.personas.values()
    ])
    const coordinator = new T3Coordinator(changed, f.host, f.config)
    expect(coordinator.researchTick(f.lease, f.source, f.skill.digest)[0]?.id).not.toBe(first.id)
    expect(() => changed.assertPolicy(first)).toThrow("policy")
  })
})

it("retains long briefs intact across retries and rejects substituted files or unsafe directories", () => {
  const dir = mkdtempSync(join(tmpdir(), "autocode-t3-brief-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, "journal.sqlite")
  const id = "a".repeat(64)
  const content = "complete proposal and persona ".repeat(2000)
  const first = retainT3DispatchBrief(path, id, content, { assignmentId: id })
  expect(retainT3DispatchBrief(path, id, content, { assignmentId: id })).toBe(first)
  expect(first.length).toBeLessThan(3000)
  const brief = join(dir, "briefs", `${id}.txt`)
  expect(readFileSync(brief, "utf8")).toBe(content)
  expect(() => retainT3DispatchBrief(path, id, "different", {})).toThrow("changed")
  rmSync(brief)
  symlinkSync(path, brief)
  expect(() => retainT3DispatchBrief(path, id, content, {})).toThrow()
  chmodSync(dir, 0o755)
  expect(() => retainT3DispatchBrief(path, "b".repeat(64), content, {})).toThrow("private")
})
