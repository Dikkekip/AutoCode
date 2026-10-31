import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import {
  decodeT3ToolResult,
  renderT3PersonaPrompt,
  resolveT3Personas,
  T3CallbackTransport,
  T3Host,
  T3Journal,
  T3OwnershipLost,
  T3RevisionConflict
} from "@autocode/t3-runtime"
import { builtInPersonas } from "@openclaw/domain"
import { loadProjectProfile } from "@openclaw/project-profiles"
import { afterEach, describe, expect, it } from "vitest"

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

function journal(clock: () => number = Date.now): { store: T3Journal; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "autocode-t3-foundation-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, "evidence.sqlite")
  const store = new T3Journal(path, clock)
  cleanups.push(() => store.close())
  return { store, path }
}

describe("T3 durable ownership and evidence", () => {
  it("fences a stale coordinator across independent connections and preserves takeover tokens", () => {
    let now = 100
    const { store, path } = journal(() => now)
    const other = new T3Journal(path, () => now)
    cleanups.push(() => other.close())
    const first = store.acquire("project", 10)!
    expect(other.acquire("project", 10)).toBeNull()
    store.transaction(first, () => store.write("workflow", "one", { stage: "research" }, 0))
    now = 111
    const second = other.acquire("project", 10)!
    expect(second.fence).toBeGreaterThan(first.fence)
    expect(() => store.transaction(first, () => store.write("workflow", "one", {}, 1))).toThrow(T3OwnershipLost)
    expect(() => store.release(first)).toThrow(T3OwnershipLost)
    expect(other.read("project", "workflow", "one")?.version).toBe(1)
    other.release(second)
    expect(store.acquire("project", 10)?.fence).toBeGreaterThan(second.fence)
  })

  it("rolls back stale revisions and work whose lease expires inside the transaction", () => {
    let now = 0
    const { store } = journal(() => now)
    const lease = store.acquire("project", 10)!
    store.transaction(lease, () => store.write("workflow", "one", { stage: "research" }, 0))
    expect(() => store.transaction(lease, () => store.write("workflow", "one", {}, 0))).toThrow(T3RevisionConflict)
    expect(() =>
      store.transaction(lease, () => {
        store.write("workflow", "one", { stage: "implementation" }, 1)
        now = 11
      })
    ).toThrow(T3OwnershipLost)
    expect(store.read("project", "workflow", "one")?.value).toEqual({ stage: "research" })
  })

  it("retains uncertain effects through reopen and rejects payload collisions or blind replay", () => {
    const { store, path } = journal()
    const lease = store.acquire("project")!
    store.reserveEffect(lease, "task-one", "delegate_task", { task: "implementation" })
    store.markEffect(lease, "task-one", "prepared", "uncertain")
    store.release(lease)
    const restarted = new T3Journal(path)
    cleanups.push(() => restarted.close())
    const next = restarted.acquire("project")!
    expect(restarted.reserveEffect(next, "task-one", "delegate_task", { task: "implementation" }).status).toBe(
      "uncertain"
    )
    expect(() => restarted.reserveEffect(next, "task-one", "delegate_task", { task: "other" })).toThrow(
      "different payload"
    )
    expect(() => restarted.markEffect(next, "task-one", "uncertain", "prepared")).toThrow("Invalid effect transition")
    restarted.markEffect(next, "task-one", "uncertain", "confirmed", { taskId: "accepted-task" })
    expect(restarted.effect("task-one")?.result?.taskId).toBe("accepted-task")
  })

  it("refuses another application's database without adding journal tables", () => {
    const dir = mkdtempSync(join(tmpdir(), "autocode-t3-foreign-"))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const path = join(dir, "foreign.sqlite")
    const db = new DatabaseSync(path)
    cleanups.push(() => db.close())
    db.exec("CREATE TABLE unrelated(id INTEGER)")
    expect(() => new T3Journal(path)).toThrow("another application's database")
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='leases'").get()).toBeUndefined()
  })
})

describe("T3 persona preservation", () => {
  it("retains built-ins, custom inheritance, manager missions and distinct prompt/skill provenance", () => {
    const profile = loadProjectProfile("minimal-repo")
    profile.personas!.push({
      id: "t3-security-researcher",
      extends: "security-engineer",
      responsibilities: ["Find source-backed tenant boundary failures"],
      requiredReading: ["SECURITY.md"]
    })
    profile.managerStateDefaults.managerPersonas.push({
      id: "t3-security-researcher",
      focus: "Tenant isolation",
      ownedLaneIds: ["app-core"],
      preferredAdapterType: "codex_local",
      ideationPrompt: "Investigate cross-tenant authorization with concrete source evidence.",
      successSignals: ["No cross-tenant data exposure"],
      blockedEscalation: "Ask the security owner",
      taskQuotaWeight: 2
    })
    const personas = resolveT3Personas(profile)
    expect(personas.map((p) => p.definition.id)).toEqual(expect.arrayContaining(builtInPersonas.map((p) => p.id)))
    const security = personas.find((p) => p.definition.id === "t3-security-researcher")!
    expect(security.definition.forbiddenActions).toEqual(
      builtInPersonas.find((p) => p.id === "security-engineer")!.forbiddenActions
    )
    expect(security.definition.requiredReading).toEqual(["SECURITY.md"])
    expect(security.manager?.taskQuotaWeight).toBe(2)
    const content = "Preserve acceptance evidence and source identity."
    const input = {
      role: "research" as const,
      projectGoal: "Tenant safety",
      repository: "/fixture/repository",
      revision: "a".repeat(40),
      sourceManifestDigest: "b".repeat(64),
      skill: { content, digest: createHash("sha256").update(content).digest("hex") },
      context: { priorDecisions: [] }
    }
    const securityPrompt = renderT3PersonaPrompt({ ...input, persona: security })
    const backendPrompt = renderT3PersonaPrompt({
      ...input,
      persona: personas.find((p) => p.definition.id === "backend-engineer")!
    })
    expect(securityPrompt.text).toContain("Investigate cross-tenant authorization")
    expect(securityPrompt.text).toContain("Ask the security owner")
    expect(securityPrompt.digest).not.toBe(backendPrompt.digest)
    expect(() =>
      renderT3PersonaPrompt({ ...input, persona: security, skill: { ...input.skill, content: "changed" } })
    ).toThrow("Skill content")
  })
})

describe("advertised T3 tool boundary", () => {
  it("uses the injected authenticated caller and refuses missing required host capabilities", async () => {
    const calls: string[] = []
    const host = new T3Host(
      new T3CallbackTransport(async (name) => {
        calls.push(name)
        return { structuredContent: { runtimeMode: "full-access", providers: [], features: {} } }
      })
    )
    await expect(host.capabilities()).rejects.toThrow("T3 capability unavailable")
    expect(calls).toEqual(["orchestrator_capabilities"])
  })

  it("decodes a structured MCP reply without accepting prose or a reported error", () => {
    expect(decodeT3ToolResult({ content: [{ type: "text", text: '{"taskId":"one"}' }] })).toEqual({ taskId: "one" })
    expect(() => decodeT3ToolResult({ isError: true, structuredContent: { taskId: "one" } })).toThrow(
      "reported an error"
    )
    expect(() => decodeT3ToolResult({ content: [{ type: "text", text: "Task succeeded" }] })).toThrow()
  })
})
