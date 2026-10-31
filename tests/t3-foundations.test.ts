import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import * as fs from "node:fs"
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { pathToFileURL } from "node:url"
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
import { afterEach, describe, expect, it, vi } from "vitest"

// Expose configurable copies so ownership simulation changes only the selected
// lstat result; the underlying filesystem and all other calls remain real.
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>())
}))

const cleanups: Array<() => void> = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

function privateDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), "autocode-t3-foundation-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function journal(clock: () => number = Date.now): { store: T3Journal; path: string } {
  const path = join(privateDirectory(), "evidence.sqlite")
  const store = new T3Journal(path, clock)
  cleanups.push(() => store.close())
  return { store, path }
}

describe("T3 journal filesystem admission", () => {
  it.each([
    "foreign database",
    "unsafe sidecar"
  ])("preserves another connection's writer lock on %s rejection", (rejection) => {
    const path = join(privateDirectory(), "foreign.sqlite")
    const db = new DatabaseSync(path)
    chmodSync(path, 0o600)
    cleanups.push(() => db.close())
    db.exec("CREATE TABLE unrelated(id INTEGER); BEGIN IMMEDIATE; INSERT INTO unrelated VALUES(1)")
    if (rejection === "unsafe sidecar") writeFileSync(`${path}-shm`, "unsafe", { mode: 0o640 })
    const probe = () => {
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
        import { DatabaseSync } from "node:sqlite";
        const db = new DatabaseSync(process.argv[1]);
        try { db.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE; ROLLBACK"); process.stdout.write("unlocked"); }
        catch (error) { if (error.errcode !== 5) throw error; process.stdout.write("locked"); }
        finally { db.close(); }
      `,
          path
        ],
        { encoding: "utf8", timeout: 5_000 }
      )
      expect(result.error).toBeUndefined()
      expect(result.status, result.stderr).toBe(0)
      return result.stdout
    }
    expect(probe()).toBe("locked")
    expect(() => new T3Journal(path)).toThrow(
      rejection === "unsafe sidecar" ? "private, owned regular file" : "another application's database"
    )
    expect(probe()).toBe("locked")
    db.exec("ROLLBACK")
    expect(probe()).toBe("unlocked")
    expect(db.prepare("SELECT count(*) AS count FROM unrelated").get()?.count).toBe(0)
  })

  it.each(["", "external bytes"])("rejects a journal symlink without changing target %j", (content) => {
    const dir = privateDirectory()
    const target = join(dir, "external")
    writeFileSync(target, content, { mode: 0o640 })
    const before = statSync(target)
    const path = join(dir, "journal.sqlite")
    symlinkSync(target, path)
    expect(() => new T3Journal(path)).toThrow()
    expect(readFileSync(target, "utf8")).toBe(content)
    expect(statSync(target).mode).toBe(before.mode)
    expect(readdirSync(dir).sort()).toEqual(["external", "journal.sqlite"])
  })

  it("rejects symlink ancestors before creating directories or a journal", () => {
    const dir = privateDirectory()
    const target = join(dir, "target")
    mkdirSync(target, { mode: 0o700 })
    const alias = join(dir, "alias")
    symlinkSync(target, alias)
    expect(() => new T3Journal(join(alias, "nested", "journal.sqlite"))).toThrow("directory ancestors")
    expect(readdirSync(target)).toEqual([])
  })

  it.each([0o750, 0o707, 0o777])("rejects state directory mode %s without repairing it", (mode) => {
    const dir = privateDirectory()
    chmodSync(dir, mode)
    expect(() => new T3Journal(join(dir, "journal.sqlite"))).toThrow()
    expect(statSync(dir).mode & 0o777).toBe(mode)
    expect(readdirSync(dir)).toEqual([])
  })

  it("reaches the final-directory ownership check without changing the directory", () => {
    const dir = privateDirectory()
    const before = statSync(dir)
    const actualLstat = fs.lstatSync
    let checkedFinal = false
    // Root ownership is accepted for ancestors but forbidden for a nonroot
    // opener's final directory. Change only this stat; all ancestors stay real.
    if (process.getuid!() === 0) vi.spyOn(process, "getuid").mockReturnValue(12345)
    vi.spyOn(fs, "lstatSync").mockImplementation((...args: Parameters<typeof fs.lstatSync>) => {
      const stat = actualLstat(...args)
      if (args[0] !== dir) return stat
      checkedFinal = true
      return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { uid: 0 })
    })
    expect(() => new T3Journal(join(dir, "journal.sqlite"))).toThrow(
      "private state directory owned by the current user"
    )
    expect(checkedFinal).toBe(true)
    expect(statSync(dir).uid).toBe(before.uid)
    expect(statSync(dir).mode).toBe(before.mode)
    expect(readdirSync(dir)).toEqual([])
  })

  it("rejects writable nonsticky ancestors even when the immediate directory is private", () => {
    const dir = privateDirectory()
    const child = join(dir, "private")
    mkdirSync(child, { mode: 0o700 })
    chmodSync(dir, 0o777)
    expect(() => new T3Journal(join(child, "journal.sqlite"))).toThrow("directory ancestors")
    expect(readdirSync(child)).toEqual([])
  })

  it("creates missing directories, journal and SQLite sidecars privately and reopens normally", () => {
    const dir = privateDirectory()
    const state = join(dir, "new", "state")
    const path = join(state, "journal.sqlite")
    const store = new T3Journal(path)
    cleanups.push(() => store.close())
    expect(statSync(join(dir, "new")).mode & 0o777).toBe(0o700)
    expect(statSync(state).mode & 0o777).toBe(0o700)
    for (const file of [path, `${path}-wal`, `${path}-shm`]) {
      expect(statSync(file).mode & 0o777).toBe(0o600)
      expect(statSync(file).uid).toBe(process.getuid!())
    }
    const reopened = new T3Journal(path)
    cleanups.push(() => reopened.close())
    expect(reopened.acquire("project")).not.toBeNull()
  })

  it("rejects nonprivate, linked and nonregular journal files without changing them", () => {
    const dir = privateDirectory()
    const path = join(dir, "journal.sqlite")
    writeFileSync(path, "", { mode: 0o640 })
    expect(() => new T3Journal(path)).toThrow("private, owned regular file")
    expect(statSync(path).mode & 0o777).toBe(0o640)
    chmodSync(path, 0o600)
    const alias = join(dir, "hardlink")
    linkSync(path, alias)
    expect(() => new T3Journal(path)).toThrow("one link")
    expect(readFileSync(path).length).toBe(0)
    rmSync(alias)
    rmSync(path)
    mkdirSync(path, { mode: 0o700 })
    expect(() => new T3Journal(path)).toThrow()
    expect(readdirSync(path)).toEqual([])
  })

  it.each([
    "-wal",
    "-shm",
    "-journal"
  ])("rejects a redirected SQLite %s sidecar before database initialization", (suffix) => {
    const dir = privateDirectory()
    const target = join(dir, "external")
    writeFileSync(target, "untouched", { mode: 0o600 })
    const path = join(dir, "journal.sqlite")
    symlinkSync(target, `${path}${suffix}`)
    expect(() => new T3Journal(path)).toThrow("private, owned regular file")
    expect(readFileSync(target, "utf8")).toBe("untouched")
    expect(readFileSync(path).length).toBe(0)
  })

  it.each(["-wal", "-shm", "-journal"])("rejects nonprivate and hardlinked regular %s sidecars", (suffix) => {
    const dir = privateDirectory()
    const path = join(dir, "journal.sqlite")
    writeFileSync(path, "", { mode: 0o600 })
    const sidecar = `${path}${suffix}`
    writeFileSync(sidecar, "sidecar bytes", { mode: 0o640 })
    const before = readFileSync(sidecar)
    expect(() => new T3Journal(path)).toThrow("private, owned regular file")
    expect(statSync(sidecar).mode & 0o777).toBe(0o640)
    expect(readFileSync(sidecar)).toEqual(before)
    chmodSync(sidecar, 0o600)
    linkSync(sidecar, join(dir, "alias"))
    expect(() => new T3Journal(path)).toThrow("one link")
    expect(readFileSync(sidecar)).toEqual(before)
    expect(statSync(sidecar).nlink).toBe(2)
    expect(readFileSync(path).length).toBe(0)
  })

  it.each(["-wal", "-shm", "-journal"])("rejects a regular %s sidecar owned by another UID", (suffix) => {
    const dir = privateDirectory()
    const path = join(dir, "journal.sqlite")
    writeFileSync(path, "", { mode: 0o600 })
    const sidecar = `${path}${suffix}`
    writeFileSync(sidecar, "sidecar bytes", { mode: 0o600 })
    const before = statSync(sidecar)
    const actualLstat = fs.lstatSync
    let checkedSidecar = false
    vi.spyOn(fs, "lstatSync").mockImplementation((...args: Parameters<typeof fs.lstatSync>) => {
      const stat = actualLstat(...args)
      if (args[0] !== sidecar) return stat
      checkedSidecar = true
      return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { uid: before.uid + 1 })
    })
    expect(() => new T3Journal(path)).toThrow("private, owned regular file")
    expect(checkedSidecar).toBe(true)
    expect(statSync(sidecar).uid).toBe(before.uid)
    expect(statSync(sidecar).mode).toBe(before.mode)
    expect(readFileSync(sidecar, "utf8")).toBe("sidecar bytes")
    expect(readFileSync(path).length).toBe(0)
  })

  it.each([1, 2, 3])("supports bounded cross-process concurrent creation and reopen (round %s)", async () => {
    const path = join(privateDirectory(), "new", "state", "journal.sqlite")
    // Like the CLI integration test, exercise the built module after typecheck.
    const moduleUrl = pathToFileURL(resolve("packages/t3-runtime/dist/journal.js")).href
    const script = `
      import { T3Journal } from ${JSON.stringify(moduleUrl)};
      process.stdout.write("ready\\n");
      process.stdin.once("data", () => {
        try {
          const journal = new T3Journal(process.argv[1]);
          const lease = journal.acquire(process.argv[2]);
          if (!lease) throw new Error("Missing lease");
          journal.transaction(lease, () => journal.write("probe", "one", process.argv[2], 0));
          journal.release(lease);
          journal.close();
        } catch (error) { console.error(error); process.exitCode = 1; }
        process.stdin.destroy();
      });
    `
    for (const round of ["create", "reopen"]) {
      const children = Array.from({ length: 3 }, (_, index) =>
        spawn(process.execPath, ["--input-type=module", "--eval", script, path, `${round}-${index}`])
      )
      try {
        const completions = children.map(
          (child) =>
            new Promise<void>((done, reject) => {
              let errors = ""
              child.stderr.on("data", (chunk) => {
                errors += chunk.toString()
              })
              child.once("error", reject)
              child.once("close", (code) =>
                code === 0 ? done() : reject(new Error(`Journal child ${code}: ${errors}`))
              )
            })
        )
        const ready = children.map(
          (child) =>
            new Promise<void>((done, reject) => {
              child.stdout.once("data", () => done())
              child.once("error", reject)
              child.once("exit", () => reject(new Error("Journal child exited before startup barrier")))
            })
        )
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([
            (async () => {
              await Promise.all(ready)
              for (const child of children) child.stdin.end("go")
              await Promise.all(completions)
            })(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("Concurrent journal startup exceeded 10 seconds")), 10_000)
            })
          ])
        } finally {
          clearTimeout(timer)
        }
      } finally {
        // Observe exit after cancellation too; do not remove fixtures under a live child.
        await Promise.all(
          children.map(
            (child) =>
              new Promise<void>((done) => {
                if (child.exitCode !== null || child.signalCode !== null) return done()
                child.once("close", () => done())
                child.kill("SIGKILL")
              })
          )
        )
      }
    }
    const reopened = new T3Journal(path)
    cleanups.push(() => reopened.close())
    for (const round of ["create", "reopen"]) {
      for (let index = 0; index < 3; index++) {
        const project = `${round}-${index}`
        expect(reopened.read(project, "probe", "one")?.value).toBe(project)
      }
    }
    expect(statSync(path).mode & 0o777).toBe(0o600)
  }, 25_000)
})

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
    chmodSync(path, 0o600)
    const before = readFileSync(path)
    const mode = statSync(path).mode
    expect(() => new T3Journal(path)).toThrow("another application's database")
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='leases'").get()).toBeUndefined()
    expect(readFileSync(path)).toEqual(before)
    expect(statSync(path).mode).toBe(mode)
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
