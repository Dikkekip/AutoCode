import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { nativeDoctor, validateNativeRoleAuthority } from "../packages/core-runtime/src/native/doctor.js"
import type { NativeAutonomyPolicy } from "../packages/domain/src/native-autonomy.js"

const policy = {
  plannerAgentId: "planner",
  coderAgentId: "coder",
  reviewerAgentId: "reviewer",
  personas: [],
  repositoryKind: "framework",
  boardId: "app"
} as unknown as NativeAutonomyPolicy
function roles() {
  const completion = ["workboard_complete", "workboard_heartbeat"]
  return {
    agents: {
      entries: Object.fromEntries(
        [
          ["planner", ["autocode_context", "autocode_proposals", "autocode_admit", "autocode_defer", ...completion]],
          ["coder", ["autocode_context", "autocode_submit", "read", "write", "edit", "exec", "process", ...completion]],
          ["reviewer", ["autocode_context", "autocode_review", "autocode_design_review", "read", ...completion]]
        ].map(([id, allow]) => [
          String(id),
          {
            tools: { allow, elevated: { enabled: false }, exec: { host: "sandbox" } },
            sandbox: { mode: "all", workspaceAccess: id === "coder" ? "rw" : "ro", docker: { network: "none" } }
          }
        ])
      )
    }
  }
}
it("accepts explicit confined independent role authority", () => {
  expect(() => validateNativeRoleAuthority(policy, roles())).not.toThrow()
})
it.each([
  "exec",
  "write",
  "elevated",
  "sandbox",
  "provider",
  "delegation"
])("rejects reviewer authority expansion through %s", (kind) => {
  const config = roles() as any
  const reviewer = config.agents.entries.reviewer
  if (["exec", "write"].includes(kind)) reviewer.tools.allow.push(kind)
  if (kind === "elevated") reviewer.tools.elevated.enabled = true
  if (kind === "sandbox") reviewer.sandbox.workspaceAccess = "rw"
  if (kind === "provider") reviewer.tools.byProvider = { provider: { allow: ["exec"] } }
  if (kind === "delegation") reviewer.subagents = { allowAgents: ["coder"] }
  expect(() => validateNativeRoleAuthority(policy, config)).toThrow(/Role reviewer/)
})
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
it("reports malformed reads and unsupported supervisor without mutating Gateway state", async () => {
  const repository = mkdtempSync(join(tmpdir(), "native-doctor-"))
  roots.push(repository)
  const calls: string[] = []
  const gateway = {
    request: async <T = any>(method: string) => {
      calls.push(method)
      return {
        "workboard.boards.list": { boards: [{ id: 17 }] },
        "agents.list": { agents: "bad" },
        "config.get": { config: roles() },
        "cron.list": { jobs: [], hasMore: true, nextOffset: 0 }
      }[method] as T
    }
  }
  const report = await nativeDoctor({ ...policy, repository }, gateway, { platform: "darwin" })
  expect(report.ok).toBe(false)
  for (const name of ["workboard", "agents", "automation-contract", "legacy-timers"])
    expect(report.checks.find((c) => c.name === name)?.ok).toBe(false)
  expect(report.checks.find((c) => c.name === "legacy-timers")?.detail).toContain("systemctl was not invoked")
  expect(calls).toEqual(["workboard.boards.list", "agents.list", "config.get", "cron.list"])
})
