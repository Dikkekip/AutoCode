import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { NativeGitStagePackets } from "../packages/core-runtime/src/native/git-stage-packets.js"
import type { NativeWorkflow } from "../packages/core-runtime/src/native/runtime.js"
import { NativeEvidenceStore } from "../packages/core-runtime/src/native/store.js"
import {
  gitStageDigest,
  gitStagePath,
  renderGitStageReport,
  validateGitStagePlan,
  validateGitStagePolicy
} from "../packages/domain/src/git-stage-packets.js"
import { type NativeProposal, validateNativeAutonomyPolicy } from "../packages/domain/src/native-autonomy.js"

const cleanups: Array<() => void> = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})
function setup() {
  const root = mkdtempSync(join(tmpdir(), "git-stage-packets-"))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim()
  git("init", "-b", "main")
  git("config", "user.name", "Fixture")
  git("config", "user.email", "fixture@example.invalid")
  writeFileSync(join(root, "source.txt"), "source\n")
  git("add", "source.txt")
  git("commit", "-m", "fixture")
  git("update-ref", "refs/remotes/origin/main", "HEAD")
  const policy = validateNativeAutonomyPolicy({
    version: 1,
    enabled: true,
    boardId: "fixture",
    repository: root,
    repositoryKind: "application",
    baseBranch: "main",
    plannerAgentId: "planner",
    coderAgentId: "coder",
    reviewerAgentId: "reviewer",
    gitStagePackets: { version: 1, enabled: true },
    personas: [
      {
        personaId: "dev",
        goals: ["Improve source"],
        successObservations: ["Works"],
        allowedPaths: ["source.txt"],
        weight: 1
      }
    ],
    verification: [{ argv: ["true"], cwd: ".", timeoutSeconds: 10 }],
    deployment: null
  })
  const store = new NativeEvidenceStore(join(root, "evidence.db"))
  cleanups.push(() => store.close())
  const packets = new NativeGitStagePackets(policy, store)
  store.workflowProjection = (id, value, version) => packets.project(id, value, version)
  const proposal: NativeProposal = {
    personaId: "dev",
    goal: "Improve source",
    title: "Source change",
    evidence: [{ path: "source.txt", observation: "Needs improvement" }],
    allowedPaths: ["source.txt"],
    acceptance: ["Works"],
    alternatives: ["Keep source unchanged"],
    implementationPrompt: "Implement source change.\n\n",
    quality: {
      revision: git("rev-parse", "HEAD"),
      skillHash: "b".repeat(64),
      sessionKey: "planner-session",
      nonGoals: ["Unrelated work"],
      verification: [{ criterion: "Works", method: "Focused test" }]
    } as NativeProposal["quality"]
  }
  const id = gitStageDigest("workflow")
  const plan = packets.plan(id, proposal)
  const workflow: NativeWorkflow = {
    proposal,
    gitStagePlan: plan,
    rootCardId: "root",
    implementationCardId: "coder",
    stageCards: {}
  }
  return { root, git, policy, store, packets, proposal, id, plan, workflow }
}
describe("local native Git stage packets", () => {
  it("validates opt-in policy and refuses remote transport and unsupported versions", () => {
    expect(validateGitStagePolicy({ version: 1, enabled: false })).toEqual({ version: 1, enabled: false })
    for (const value of [
      null,
      {},
      { version: 2, enabled: true },
      { version: 1, enabled: "yes" },
      { version: 1, enabled: true, remote: "origin" }
    ])
      expect(() => validateGitStagePolicy(value)).toThrow()
    for (const path of ["../secret", "/tmp/a", "a/../b", "a//b", ".git/config", "a\\b", "a\nfile"])
      expect(() => gitStagePath(path)).toThrow()
  })
  it("commits an admitted plan, exact prompt bytes, and inert HTML without changing application HEAD/index", () => {
    const s = setup(),
      head = s.git("rev-parse", "HEAD"),
      index = s.git("write-tree")
    s.store.put("workflow", s.id, s.workflow)
    expect(s.packets.status().pending).toHaveLength(1)
    const context = s.packets.context(s.id, s.plan)
    expect(context.coderPrompt).toBe(s.proposal.implementationPrompt)
    expect(s.git("show", `${context.commit}:workflows/${s.id}/plans/${s.plan.planId}/report.html`)).toContain(
      "Next role: coder"
    )
    expect(s.git("rev-parse", "HEAD")).toBe(head)
    expect(s.git("write-tree")).toBe(index)
    expect(s.packets.status().pending).toEqual([])
    const before = s.git("rev-list", "--count", s.packets.ref)
    s.packets.flush()
    expect(s.git("rev-list", "--count", s.packets.ref)).toBe(before)
  })
  it("recovers a crash after ref publication without duplicating the event", () => {
    const s = setup()
    s.store.put("workflow", s.id, s.workflow)
    const fail = vi.spyOn(s.store, "commit").mockImplementationOnce(() => {
      throw new Error("crash before acknowledgement")
    })
    expect(() => s.packets.flush()).toThrow("crash before acknowledgement")
    fail.mockRestore()
    expect(s.git("rev-list", "--count", s.packets.ref)).toBe("1")
    const resumed = new NativeGitStagePackets(s.policy, s.store)
    resumed.flush()
    expect(resumed.status().pending).toEqual([])
    expect(s.git("rev-list", "--count", s.packets.ref)).toBe("1")
  })
  it("rolls back the workflow and outbox together when the evidence transaction fails", () => {
    const s = setup()
    expect(() =>
      s.store.commit([{ kind: "workflow", id: s.id, value: s.workflow, expectedVersion: 99 }], {
        kind: "fixture",
        subject: s.id,
        value: {}
      })
    ).toThrow("Stale native record")
    expect(s.store.get("workflow", s.id)).toBeNull()
    expect(s.store.list("git-stage-export")).toEqual([])
  })
  it("preserves ordered history across workflow updates and a second host publisher instance", () => {
    const s = setup()
    s.store.put("workflow", s.id, s.workflow)
    s.packets.flush()
    const workflow = s.store.get<NativeWorkflow>("workflow", s.id)!
    workflow.blocker = "Await source clarification"
    s.store.put("workflow", s.id, workflow)
    new NativeGitStagePackets(s.policy, s.store).flush()
    expect(s.git("rev-list", "--count", s.packets.ref)).toBe("2")
    const event = gitStageDigest(`${s.id}:2`)
    expect(JSON.parse(s.git("show", `${s.packets.ref}:workflows/${s.id}/events/${event}.json`))).toMatchObject({
      sequence: 2,
      previousEventId: gitStageDigest(`${s.id}:1`),
      blocked: true
    })
    expect(JSON.parse(s.git("show", `${s.packets.ref}:workflows/${s.id}/handoffs/${event}.json`))).toMatchObject({
      nextRole: "operator",
      blocker: "Await source clarification"
    })
  })
  it("refuses split evidence authority on an existing board ref", () => {
    const s = setup()
    s.store.put("workflow", s.id, s.workflow)
    s.packets.flush()
    const other = new NativeEvidenceStore(join(s.root, "other.db"))
    cleanups.push(() => other.close())
    const packets = new NativeGitStagePackets(s.policy, other)
    other.workflowProjection = (id, value, version) => packets.project(id, value, version)
    other.put("workflow", s.id, structuredClone(s.workflow))
    expect(() => packets.flush()).toThrow("another evidence store")
  })
  it("retries a competing compare-and-swap update and preserves both workflows", () => {
    const s = setup(),
      otherId = gitStageDigest("other-workflow")
    s.store.put("workflow", s.id, s.workflow)
    s.store.put("workflow", otherId, { ...s.workflow, gitStagePlan: s.packets.plan(otherId, s.proposal) })
    const second = new NativeGitStagePackets(s.policy, s.store)
    const original = (s.packets as any).git.bind(s.packets)
    let competed = false
    vi.spyOn(s.packets as any, "git").mockImplementation((...args: any[]) => {
      if (args[0][0] === "update-ref" && !competed) {
        competed = true
        second.flush(otherId)
      }
      return original(...args)
    })
    s.packets.flush(s.id)
    const tree = s.git("ls-tree", "-r", "--name-only", s.packets.ref)
    expect(tree).toContain(`workflows/${s.id}/events/`)
    expect(tree).toContain(`workflows/${otherId}/events/`)
    expect(s.git("rev-list", "--count", s.packets.ref)).toBe("2")
    expect(s.packets.status().pending).toEqual([])
  })
  it("refuses an injected symlink at the next immutable event path", () => {
    const s = setup()
    s.store.put("workflow", s.id, s.workflow)
    s.packets.flush()
    const old = s.git("rev-parse", s.packets.ref)
    s.git("read-tree", old)
    const blob = execFileSync("git", ["-C", s.root, "hash-object", "-w", "--stdin"], {
      input: "../../secret",
      encoding: "utf8"
    }).trim()
    s.git(
      "update-index",
      "--add",
      "--cacheinfo",
      `120000,${blob},workflows/${s.id}/events/${gitStageDigest(`${s.id}:2`)}.json`
    )
    const commit = s.git("commit-tree", s.git("write-tree"), "-p", old, "-m", "injected symlink")
    s.git("update-ref", s.packets.ref, commit, old)
    const workflow = s.store.get<NativeWorkflow>("workflow", s.id)!
    workflow.blocker = "wait"
    s.store.put("workflow", s.id, workflow)
    expect(() => s.packets.flush()).toThrow("regular blob")
    expect(s.packets.status().pending).toHaveLength(1)
  })
  it("rejects altered prompts, cross-workflow plans, and source changes before admission", () => {
    const s = setup()
    expect(() => validateGitStagePlan({ ...s.plan, coderPrompt: "Different scope" })).toThrow("prompt")
    expect(() => s.packets.project("c".repeat(64), s.workflow, 1)).toThrow("identity mismatch")
    s.store.put("workflow", s.id, s.workflow)
    const changed = s.store.get<NativeWorkflow>("workflow", s.id)!
    changed.proposal.implementationPrompt = "Escalate permissions"
    expect(() => s.store.put("workflow", s.id, changed)).toThrow("proposal changed")
    s.git("commit", "--allow-empty", "-m", "new base")
    s.git("update-ref", "refs/remotes/origin/main", "HEAD")
    expect(() => s.packets.plan(s.id, s.proposal)).toThrow("source changed")
  })
  it("escapes active HTML and requires complete acceptance coverage", () => {
    const s = setup(),
      prompt = '<script>alert("x")</script><img src="https://example.invalid/x">'
    const plan = { ...s.plan, coderPrompt: prompt, coderPromptDigest: gitStageDigest(prompt) }
    const html = renderGitStageReport(plan)
    expect(html).toContain("&lt;script&gt;")
    expect(html).not.toContain("<script>")
    expect(html).not.toContain("<img")
    expect(html).toContain("default-src 'none'")
    expect(() => validateGitStagePlan({ ...plan, verification: [] })).toThrow("verification")
  })
  it("redacts bounded handoffs as valid JSON and rejects an oversized HTML plan before admission", () => {
    const s = setup()
    s.store.put("workflow", s.id, s.workflow)
    s.packets.flush()
    const workflow = s.store.get<NativeWorkflow>("workflow", s.id)!
    const secret = "secret-value-should-not-be-committed"
    workflow.blocker = `Authorization: Bearer ${secret} <script>bad()</script> ${"x".repeat(5000)}`
    s.store.put("workflow", s.id, workflow)
    s.packets.flush()
    const event = gitStageDigest(`${s.id}:2`)
    const raw = s.git("show", `${s.packets.ref}:workflows/${s.id}/handoffs/${event}.json`)
    expect(JSON.parse(raw).blocker.length).toBeLessThanOrEqual(2000)
    expect(raw).not.toContain(secret)
    const html = s.git("show", `${s.packets.ref}:workflows/${s.id}/handoffs/${event}.html`)
    expect(html).not.toContain("<script>")
    expect(html).not.toContain(secret)
    expect(() => s.packets.plan(s.id, { ...s.proposal, implementationPrompt: "<".repeat(100_000) })).toThrow(
      "HTML plan exceeds"
    )
  })
  it("keeps the first acknowledged commit stable when two publishers acknowledge the same event", () => {
    const s = setup()
    s.store.put("workflow", s.id, s.workflow)
    const second = new NativeGitStagePackets(s.policy, s.store)
    const commit = s.store.commit.bind(s.store)
    let raced = false
    vi.spyOn(s.store, "commit").mockImplementation((...args) => {
      if (!raced && (args[0][0]?.value as any)?.commit) {
        raced = true
        second.flush(s.id)
      }
      return commit(...args)
    })
    s.packets.flush(s.id)
    expect(s.packets.status().pending).toEqual([])
    expect(s.git("rev-list", "--count", s.packets.ref)).toBe("1")
  })
})
