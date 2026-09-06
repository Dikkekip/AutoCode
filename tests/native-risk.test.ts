import { execFileSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { NativeAutonomyRuntime, type NativeWorkflow } from "../packages/core-runtime/src/native/runtime.js"
import { NativeEvidenceStore } from "../packages/core-runtime/src/native/store.js"
import { inspectNativeCandidate } from "../packages/core-runtime/src/native/verification.js"
import { validateNativeAutonomyPolicy } from "../packages/domain/src/index.js"

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn()
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "native-risk-"))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" }).trim()
  git("init", "-b", "main")
  git("config", "user.name", "Test")
  git("config", "user.email", "test@example.invalid")
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  write("src/view.ts", "const navigation = false\n")
  write("src/auth/old.ts", "const auth = true\n")
  git("add", "src")
  git("commit", "-m", "base")
  git("update-ref", "refs/remotes/origin/main", "HEAD")
  const baseSha = git("rev-parse", "HEAD")
  const policy = validateNativeAutonomyPolicy({
    version: 1,
    enabled: true,
    mode: "implement-human-review",
    boardId: "risk",
    repository: root,
    repositoryKind: "application",
    baseBranch: "main",
    plannerAgentId: "planner",
    coderAgentId: "coder",
    reviewerAgentId: "reviewer",
    quality: { skillPath: join(root, "skill.md"), highRiskPaths: ["src/auth/**"] },
    personas: [
      { personaId: "ux", goals: ["navigation"], successObservations: ["works"], allowedPaths: ["."], weight: 1 }
    ],
    verification: [{ argv: ["test"], cwd: "." }],
    deployment: null
  })
  const cards: any[] = []
  const gateway = {
    async request<T = any>(method: string, params: any): Promise<T> {
      if (method === "workboard.cards.list") return { cards } as T
      if (method === "workboard.cards.create") {
        let card = cards.find((c) => c.idempotencyKey === params.idempotencyKey)
        if (!card) {
          card = { ...params, id: `card-${cards.length}` }
          cards.push(card)
        }
        return { card } as T
      }
      return {} as T
    }
  }
  const store = new NativeEvidenceStore(join(root, "evidence.db"))
  cleanup.push(() => store.close())
  const runtime = new NativeAutonomyRuntime(policy, gateway, store)
  const w: NativeWorkflow = {
    proposal: {
      personaId: "ux",
      goal: "navigation",
      title: "Routine navigation only",
      evidence: [],
      allowedPaths: ["."],
      acceptance: ["works"],
      alternatives: [],
      implementationPrompt: "Routine, safe change; no sensitive behavior"
    },
    rootCardId: "root",
    implementationCardId: "impl",
    stageCards: {}
  }
  const candidate = () => ({ cwd: root, baseSha, headSha: git("rev-parse", "HEAD"), files: [], branch: "candidate" })
  const commit = (...paths: string[]) => {
    git("add", "--", ...paths)
    git("commit", "-m", "candidate")
  }
  return { root, git, write, commit, runtime, w, candidate, cards, store }
}

describe("native candidate risk", () => {
  it.each([
    ["src/auth/new.ts", "const login = true", "protected path"],
    ["src/scripts/build.js", "console.log('build')", "protected path"],
    ["src/package.json", '{"scripts":{"install":"run"},"dependencies":{"new":"1"}}', "protected path"],
    ["pnpm-lock.yaml", "lockfileVersion: 9", "protected path"],
    [".github/workflows/build.yml", "permissions: write-all", "protected path"],
    ["src/contracts/api.ts", "type API = string", "protected path"],
    ["src/api.ts", "export interface API { token: string }", "public contract"],
    ["src/policy.ts", "const policy = { permissions: 'admin' }", "permission declaration"]
  ])("escalates %s under a broad scope despite routine text", async (path, content, reason) => {
    const s = fixture()
    s.write(path, content)
    s.commit(path)
    await s.runtime.quality.classifyCandidate("w", s.w, s.candidate(), "submission")
    expect(s.w.riskAssessment!.risk).toBe("high")
    expect(s.w.riskAssessment!.reasons.join(" ")).toContain(reason)
    expect(s.w.riskAssessment!.reasons.join(" ")).toContain(path)
  })
  it.each(["delete", "rename-out", "rename-in"])("classifies protected %s endpoints", async (operation) => {
    const s = fixture()
    if (operation === "delete") s.git("rm", "src/auth/old.ts")
    if (operation === "rename-out") s.git("mv", "src/auth/old.ts", "src/ordinary.ts")
    if (operation === "rename-in") s.git("mv", "src/view.ts", "src/auth/view.ts")
    s.commit("src")
    await s.runtime.quality.classifyCandidate("w", s.w, s.candidate(), "submission")
    expect(s.w.riskAssessment!.risk).toBe("high")
    expect(s.w.riskAssessment!.reasons.join(" ")).toContain("src/auth/")
  })
  it("classifies executable permissions even on an ordinary source path", async () => {
    const s = fixture()
    chmodSync(join(s.root, "src/view.ts"), 0o755)
    s.commit("src/view.ts")
    await s.runtime.quality.classifyCandidate("w", s.w, s.candidate(), "submission")
    expect(s.w.riskAssessment!.reasons.join(" ")).toContain("100644 -> 100755")
  })
  it("protects a multiline public contract whose changed member has no export keyword", async () => {
    const s = fixture()
    s.write("src/api.ts", "export interface API {\n  token: string\n}\n")
    s.commit("src/api.ts")
    const baseSha = s.git("rev-parse", "HEAD")
    s.write("src/api.ts", "export interface API {\n  token: number\n}\n")
    s.commit("src/api.ts")
    await s.runtime.quality.classifyCandidate("w", s.w, { ...s.candidate(), baseSha }, "submission")
    expect(s.w.riskAssessment!.reasons.join(" ")).toContain("public type contract")
  })
  it("keeps ordinary changes routine and recomputes release risk from current policy", async () => {
    const s = fixture()
    s.write("src/view.ts", "const navigation = true\n")
    s.commit("src/view.ts")
    await s.runtime.quality.classifyCandidate("w", s.w, s.candidate(), "submission")
    expect(s.w.riskAssessment!.risk).toBe("routine")
    s.runtime.policy.quality!.highRiskPaths.push("src/view.ts")
    await s.runtime.quality.classifyCandidate("w", s.w, s.candidate(), "release")
    expect(s.w.riskAssessment!.risk).toBe("high")
    const event = s.store.db
      .prepare("SELECT data FROM native_events WHERE kind='risk.classified' ORDER BY id DESC LIMIT 1")
      .get()!
    expect(JSON.parse(String(event.data))).toMatchObject({ phase: "release", previousRisk: "routine", risk: "high" })
  })
  it("rejects a rename whose source lies outside admitted scope", async () => {
    const s = fixture()
    const worktree = join(s.root, "candidate")
    s.git("worktree", "add", "-b", "candidate", worktree)
    s.git("-C", worktree, "mv", "src/auth/old.ts", "src/new.ts")
    s.git("-C", worktree, "commit", "-m", "rename")
    await expect(inspectNativeCandidate(s.runtime.policy, worktree, ["src/new.ts"])).rejects.toThrow(
      /outside admitted scope/
    )
  })
  it.each([
    "scope",
    "design",
    "policy",
    "candidate"
  ])("invalidates approval after a material %s change", async (change) => {
    const s = fixture()
    s.write("src/auth/old.ts", "const auth = false\n")
    s.commit("src/auth/old.ts")
    await s.runtime.quality.classifyCandidate("w", s.w, s.candidate(), "submission")
    await s.runtime.quality.ensureDesign("w", s.w)
    const card = s.cards.at(-1)
    card.status = "running"
    card.sessionKey = "design-session"
    await s.runtime.quality.designReview("reviewer", card.sessionKey, "w", "approved", "Design sufficient", {
      criteria: [{ criterion: "works", satisfied: true, evidence: "Inspected design" }],
      findings: []
    })
    const approved = s.runtime.requireWorkflow("w")
    expect(await s.runtime.quality.ensureDesign("w", approved)).toBe(true)
    if (change === "scope") approved.proposal.allowedPaths = ["src"]
    if (change === "design") approved.proposal.implementationPrompt = "Different design"
    if (change === "policy") s.runtime.policy.quality!.highRiskPaths.push("src/other/**")
    if (change === "candidate") {
      s.write("src/auth/old.ts", "const auth = 'changed again'\n")
      s.commit("src/auth/old.ts")
      await s.runtime.quality.classifyCandidate("w", approved, s.candidate(), "submission")
    }
    expect(await s.runtime.quality.ensureDesign("w", approved)).toBe(false)
    expect(approved.designReview).toBeUndefined()
    expect(approved.designCardId).not.toBe(card.id)
    await expect(
      s.runtime.quality.designReview("reviewer", card.sessionKey, "w", "approved", "Stale session", {
        criteria: [{ criterion: "works", satisfied: true, evidence: "Old context" }],
        findings: []
      })
    ).rejects.toThrow(/session/)
  })
})
