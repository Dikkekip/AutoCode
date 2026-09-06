/** CLI recovery plans are read-only until an explicit saved-plan apply. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { registerNativeAutonomyCommands } from "../apps/dispatcher-cli/src/native-autonomy.js"
import { NativeCliGateway } from "../packages/core-runtime/src/native/gateway.js"

const { Command } = createRequire(resolve("apps/dispatcher-cli/package.json"))("commander")
const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "native-recovery-cli-"))
  roots.push(root)
  const policy = join(root, "policy.json"),
    out = join(root, "plan.json")
  writeFileSync(
    policy,
    JSON.stringify({
      version: 1,
      enabled: false,
      boardId: "board",
      repository: root,
      repositoryKind: "framework",
      baseBranch: "main",
      plannerAgentId: "planner",
      coderAgentId: "coder",
      reviewerAgentId: "reviewer",
      personas: [
        { personaId: "research", goals: ["navigation"], successObservations: ["page opens"], allowedPaths: ["src"] }
      ],
      verification: [{ argv: ["true"], cwd: "." }]
    })
  )
  const output: string[] = []
  const run = async (...args: string[]) => {
    const program = new Command().exitOverride()
    registerNativeAutonomyCommands(program, { stdout: (value) => output.push(value) })
    await program.parseAsync(["native", "--policy", policy, ...args], { from: "user" })
  }
  return { root, out, run, output }
}
it("routes explain and plan as read-only requests and applies only the saved exact document", async () => {
  const s = fixture(),
    plan = { version: 1, digest: "exact", snapshot: { boardId: "board" } }
  const request = vi.spyOn(NativeCliGateway.prototype, "request").mockResolvedValue(plan)
  await s.run("workflow", "explain", "--id", "workflow")
  expect(request).toHaveBeenLastCalledWith("autocode.workflow.explain", { boardId: "board", workflowId: "workflow" })
  await s.run(
    "workflow",
    "recover",
    "--plan",
    "--id",
    "workflow",
    "--action",
    "cancel",
    "--reason",
    "Obsolete",
    "--out",
    s.out
  )
  expect(request).toHaveBeenLastCalledWith("autocode.workflow.recover.plan", {
    boardId: "board",
    workflowId: "workflow",
    action: "cancel",
    reason: "Obsolete"
  })
  expect(JSON.parse(readFileSync(s.out, "utf8"))).toEqual(plan)
  await s.run("workflow", "recover", "--apply", s.out)
  expect(request).toHaveBeenLastCalledWith("autocode.workflow.recover.apply", { boardId: "board", plan })
})
it("does not overwrite an existing plan or mix an apply with new decisions", async () => {
  const s = fixture()
  vi.spyOn(NativeCliGateway.prototype, "request").mockResolvedValue({})
  writeFileSync(s.out, "preserve")
  await expect(s.run("workflow", "recover", "--plan", "--id", "w", "--reason", "why", "--out", s.out)).rejects.toThrow(
    /exist/
  )
  expect(readFileSync(s.out, "utf8")).toBe("preserve")
  await expect(s.run("workflow", "recover", "--apply", s.out, "--reason", "edited")).rejects.toThrow(
    /only an exact saved plan/
  )
})
it("exposes emergency freeze as a distinct operator request", async () => {
  const s = fixture(),
    request = vi.spyOn(NativeCliGateway.prototype, "request").mockResolvedValue({ frozen: true })
  await s.run("freeze")
  expect(request).toHaveBeenCalledWith("autocode.freeze", { boardId: "board" })
})
