import { execFileSync, spawn } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  captureT3Source,
  digest,
  resolveT3Personas,
  T3Journal,
  type T3Role,
  T3WorkflowEngine
} from "@autocode/t3-runtime"
import { validateProjectProfile } from "@openclaw/project-profiles"
import { expect, it } from "vitest"

it("launches the shipped profile through admission and a lane-authorized implementation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "autocode-t3-launch-"))
  let journal: T3Journal | undefined
  try {
    const profilePath = join(directory, "profile.json")
    execFileSync(process.execPath, [resolve("examples/t3-persona-profile.mjs"), profilePath])
    const profile = validateProjectProfile(JSON.parse(readFileSync(profilePath, "utf8")))
    const config = JSON.parse(readFileSync(resolve("examples/t3-config.json"), "utf8"))
    const repository = join(directory, "repo")
    execFileSync("git", ["init", "--quiet", repository])
    writeFileSync(join(repository, "source.ts"), "export const value = 1\n")
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
    journal = new T3Journal(join(directory, "state/evidence.sqlite"))
    const lease = journal.acquire("launch-fixture")!
    const engine = new T3WorkflowEngine(journal, config.policy, resolveT3Personas(profile))
    let sequence = 0
    const completed = (id: string, role: T3Role) => {
      const persona = engine.personas.get(config.policy.rolePersonas[role][0])!
      const assignmentId = `assignment-${++sequence}`
      engine.prepareAssignment(
        lease,
        id,
        {
          id: assignmentId,
          role,
          personaId: persona.definition.id,
          personaDigest: persona.digest,
          promptDigest: digest({ assignmentId }),
          providerInstanceId: "fixture-provider",
          revision: source.revision
        },
        100
      )
      engine.attachTask(lease, id, assignmentId, `task-${sequence}`)
      engine.settleTask(lease, id, assignmentId, {
        taskId: `task-${sequence}`,
        runId: `run-${sequence}`,
        status: "completed",
        hasPendingChildRuns: false
      })
      return assignmentId
    }
    const researcher = config.policy.rolePersonas.research[0]
    engine.startResearch(lease, "launch", researcher, source)
    engine.completeResearch(lease, "launch", completed("launch", "research"), {
      proposal: {
        title: "Fix fixture",
        problem: "Bounded fixture problem",
        goal: config.policy.goal,
        lane: "app-core",
        inspectedPaths: ["source.ts"],
        scope: ["source.ts"],
        acceptance: ["Expected result"],
        risk: "low",
        dependencies: [],
        estimatedTokens: 1000
      }
    })
    engine.plan(lease, "launch", completed("launch", "planner"), "admit", "Bounded and source backed", source.digest)
    completed("launch", "implementation")
    expect(engine.get(lease.projectId, "launch").value.assignments.at(-1)?.personaId).toBe("minimal-runtime-engineer")
    for (const id of config.policy.rolePersonas.research)
      expect(engine.personas.get(id)?.definition.allowedLanes).toContain("app-core")

    // Exercise the actual executable and ensure an attached stdin does not keep it alive after dispatch.
    config.transport = "stdio"
    delete config.endpoint
    delete config.tokenFile
    Object.assign(config, {
      repository,
      profilePath,
      journalPath: join(directory, "cli/evidence.sqlite"),
      privateVerifierRoot: join(directory, "verifier"),
      skillFile: resolve("docs/t3-role-contract.md")
    })
    Object.assign(config.coordinator, {
      parentThreadId: "fixture-parent",
      projectId: "fixture-project",
      researchBoundary: "accept-prompt-only"
    })
    config.coordinator.routes.codex_local = {
      providerInstanceId: "fixture-provider",
      model: "fixture-model",
      options: {}
    }
    const configPath = join(directory, "config.json")
    writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 })
    const names: string[] = []
    const result = await new Promise<string>((resolveResult, reject) => {
      const child = spawn(process.execPath, [resolve("scripts/t3-coordinator.mjs"), "tick", "--config", configPath])
      let partial = "",
        output = "",
        errors = ""
      const timer = setTimeout(() => {
        child.kill("SIGTERM")
        reject(new Error("Coordinator did not exit after relay dispatch"))
      }, 5000)
      child.stderr.on("data", (chunk) => {
        errors += chunk.toString()
      })
      child.on("error", (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.on("close", (code) => {
        clearTimeout(timer)
        code === 0 ? resolveResult(output) : reject(new Error(`CLI exit ${code}: ${errors}`))
      })
      child.stdout.on("data", (chunk) => {
        partial += chunk.toString()
        while (partial.includes("\n")) {
          const boundary = partial.indexOf("\n"),
            line = partial.slice(0, boundary)
          partial = partial.slice(boundary + 1)
          if (!line.startsWith("AUTOCODE_T3_REQUEST ")) {
            output += `${line}\n`
            continue
          }
          const request = JSON.parse(line.slice("AUTOCODE_T3_REQUEST ".length))
          names.push(request.name)
          const responses: Record<string, unknown> = {
            orchestrator_capabilities: {
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
                  models: [{ id: "fixture-model", options: [] }]
                }
              ]
            },
            t3_thread_read: {
              thread: { threadId: "fixture-parent", projectId: "fixture-project", archived: false, worktreePath: null }
            },
            t3_project_read: { workspaceRoot: repository },
            delegate_task: {
              taskId: "fixture-task",
              providerInstanceId: "fixture-provider",
              model: "fixture-model",
              options: [],
              status: "running",
              next: "End your turn"
            }
          }
          if (!(request.name in responses)) {
            child.kill("SIGTERM")
            reject(new Error("Unexpected relay tool"))
            return
          }
          child.stdin.write(
            `${JSON.stringify({ type: "t3.tool.response", id: request.id, result: responses[request.name] })}\n`
          )
        }
      })
    })
    expect(JSON.parse(result).taskId).toBe("fixture-task")
    expect(names).toEqual(["orchestrator_capabilities", "t3_thread_read", "t3_project_read", "delegate_task"])
  } finally {
    journal?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
