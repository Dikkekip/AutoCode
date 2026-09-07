import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { copyRepoFixture, createLawyerRagControlPlane, createTempWorkspace } from "./helpers.js"
import { HAS_NODE_SQLITE } from "./node-sqlite.js"

let DispatcherStore: typeof import("@openclaw/db").DispatcherStore | null = null
let runCli: typeof import("../apps/dispatcher-cli/src/index.js").runCli | null = null
if (HAS_NODE_SQLITE) {
  ;({ DispatcherStore } = await import("@openclaw/db"))
  ;({ runCli } = await import("../apps/dispatcher-cli/src/index.js"))
}

const describeDb = HAS_NODE_SQLITE ? describe : describe.skip

describeDb("dispatcher installer", () => {
  const cleanups: Array<() => void> = []

  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.()
  })

  it("bootstraps a generic Node repo and is safe to rerun", async () => {
    const workspace = createTempWorkspace("dispatcher-install")
    cleanups.push(workspace.cleanup)
    copyRepoFixture("generic-node", workspace.repoPath)

    const output: string[] = []
    const io = {
      stdout: (message: string) => output.push(message),
      stderr: (message: string) => output.push(message)
    }

    await runCli!(["install", workspace.repoPath, "--company-name", "Acme AI", "--project-name", "demo-app"], io)
    await runCli!(["install", workspace.repoPath, "--company-name", "Acme AI", "--project-name", "demo-app"], io)

    const dbPath = join(workspace.repoPath, ".openclaw", "dispatcher.db")
    expect(existsSync(dbPath)).toBe(true)
    expect(existsSync(join(workspace.repoPath, ".openclaw", "README.md"))).toBe(true)
    expect(existsSync(join(workspace.repoPath, ".openclaw", "dispatcher-bootstrap.md"))).toBe(true)
    expect(existsSync(join(workspace.repoPath, ".openclaw", "program.md"))).toBe(true)
    expect(existsSync(join(workspace.repoPath, ".openclaw", "recipes", "README.md"))).toBe(true)
    expect(existsSync(join(workspace.repoPath, ".openclaw", "CONTRIBUTING.md"))).toBe(true)
    expect(existsSync(join(workspace.repoPath, ".openclaw", "proposals", "README.md"))).toBe(true)
    expect(existsSync(join(workspace.repoPath, ".openclaw", "state", "README.md"))).toBe(true)
    expect(existsSync(join(workspace.repoPath, ".openclaw", "state", "bootstrap", "queue.json"))).toBe(true)
    expect(existsSync(join(workspace.repoPath, ".openclaw", "state", "bootstrap", "categories.json"))).toBe(true)
    expect(existsSync(join(workspace.repoPath, ".openclaw", "profile.json"))).toBe(true)
    expect(existsSync(join(workspace.repoPath, ".openclaw", "bin", "dispatcher"))).toBe(true)
    expect(existsSync(join(workspace.repoPath, ".openclaw", "agents", "codex-coder.md"))).toBe(true)
    expect(existsSync(join(workspace.repoPath, ".openclaw", "agents", "gemini-ui.md"))).toBe(true)
    expect(existsSync(join(workspace.repoPath, ".openclaw", "agents", "main.md"))).toBe(true)
    expect(existsSync(join(workspace.repoPath, ".openclaw", "agents", "planner.md"))).toBe(true)
    expect(existsSync(join(workspace.repoPath, ".openclaw", "agents", "reviewer.md"))).toBe(true)
    expect(existsSync(join(workspace.repoPath, ".openclaw", "agents", "promoter.md"))).toBe(true)
    expect(existsSync(join(workspace.repoPath, "scripts", "openclaw-dispatcher.sh"))).toBe(true)

    const store = new DispatcherStore!(dbPath)
    try {
      expect(store.listCompanies()).toHaveLength(1)
      expect(store.listProjects()).toHaveLength(1)
      expect(store.listAgents()).toHaveLength(2)
      expect(store.listPersonas().map((persona) => persona.name)).toEqual(
        expect.arrayContaining(["planner", "backend-engineer", "frontend-engineer", "code-reviewer", "pm-general"])
      )
      expect(store.listPersonas().find((persona) => persona.name === "planner")?.instructionsPath).toBe(
        join(workspace.repoPath, ".openclaw", "agents", "planner.md")
      )
      expect(store.listJobSpecs()).toHaveLength(6)
      expect(store.listRoutingRules().map((rule) => rule.name)).toContain("minimal-default")
      const project = store.resolveProject("demo-app", "Acme AI")
      expect(project.verifyCommand).toBe("pnpm test")
      expect(project.profileId).toBe("minimal-repo")
      expect(project.profilePath).toBe(join(workspace.repoPath, ".openclaw", "profile.json"))
      expect(project.profile.profileId).toBe("minimal-repo")
    } finally {
      store.close()
    }

    const codexInstructions = readFileSync(join(workspace.repoPath, ".openclaw", "agents", "codex-coder.md"), "utf8")
    const mainInstructions = readFileSync(join(workspace.repoPath, ".openclaw", "agents", "main.md"), "utf8")
    const program = readFileSync(join(workspace.repoPath, ".openclaw", "program.md"), "utf8")
    const recipes = readFileSync(join(workspace.repoPath, ".openclaw", "recipes", "README.md"), "utf8")
    const contributing = readFileSync(join(workspace.repoPath, ".openclaw", "CONTRIBUTING.md"), "utf8")
    const queue = readFileSync(join(workspace.repoPath, ".openclaw", "state", "bootstrap", "queue.json"), "utf8")
    expect(codexInstructions).toContain("`./` - Node.js workspace")
    expect(codexInstructions).toContain("Project-level verify command: `pnpm test`.")
    expect(mainInstructions).toContain("You are the autonomous director for demo-app.")
    expect(program).toContain("repo-local steering surface")
    expect(recipes).toContain("Minimal Health Check")
    expect(contributing).toContain("OpenClaw Contribution Workflow")
    expect(queue).toContain('"mode": "aggressive"')

    expect(output.join("\n")).toContain("Bootstrapped dispatcher into")
    expect(output.join("\n")).toContain("Autonomy-framework files:")
    expect(output.join("\n")).toContain("profile: minimal-repo")
    expect(output.join("\n")).toContain("personas synced:")
    expect(output.join("\n")).toContain("jobs synced: 6")
    expect(output.join("\n")).toContain("Profile-selected files:")
    expect(output.join("\n")).toContain("openclaw-dispatcher.sh doctor")
  })

  it("profiles a simple Python backend repo without requiring frontend structure", async () => {
    const workspace = createTempWorkspace("dispatcher-install-python")
    cleanups.push(workspace.cleanup)
    copyRepoFixture("python-backend", workspace.repoPath)

    await runCli!(["install", workspace.repoPath, "--force"], {
      stdout: () => undefined,
      stderr: () => undefined
    })

    const codexInstructions = readFileSync(join(workspace.repoPath, ".openclaw", "agents", "codex-coder.md"), "utf8")
    const geminiInstructions = readFileSync(join(workspace.repoPath, ".openclaw", "agents", "gemini-ui.md"), "utf8")

    expect(codexInstructions).toContain("`./` - backend service (Python, FastAPI, uv, pytest)")
    expect(codexInstructions).toContain("Project-level verify command: `pytest`.")
    expect(geminiInstructions).not.toContain("## UI Reading")
  })

  it("can install Codex, Gemini, and Foundry/Kimi tool lanes with explicit models", async () => {
    const workspace = createTempWorkspace("dispatcher-install-tools")
    cleanups.push(workspace.cleanup)
    copyRepoFixture("generic-node", workspace.repoPath)

    const output: string[] = []
    await runCli!(
      [
        "install",
        workspace.repoPath,
        "--tools",
        "codex,gemini,foundry",
        "--codex-model",
        "gpt-5.4-mini",
        "--gemini-model",
        "gemini-2.5-pro",
        "--foundry-model",
        "Kimi-K2.6"
      ],
      {
        stdout: (message: string) => output.push(message),
        stderr: (message: string) => output.push(message)
      }
    )

    const dbPath = join(workspace.repoPath, ".openclaw", "dispatcher.db")
    const store = new DispatcherStore!(dbPath)
    try {
      const agents = store.listAgents()
      expect(agents.map((agent) => agent.adapterType)).toEqual(
        expect.arrayContaining(["codex_local", "gemini_local", "azure_foundry"])
      )
      expect(agents.find((agent) => agent.adapterType === "codex_local")?.model).toBe("gpt-5.4-mini")
      expect(agents.find((agent) => agent.adapterType === "gemini_local")?.model).toBe("gemini-2.5-pro")
      expect(agents.find((agent) => agent.adapterType === "azure_foundry")?.model).toBe("Kimi-K2.6")
    } finally {
      store.close()
    }

    expect(existsSync(join(workspace.repoPath, ".openclaw", "agents", "foundry-kimi.md"))).toBe(true)
    expect(readFileSync(join(workspace.repoPath, ".openclaw", "agents", "foundry-kimi.md"), "utf8")).toContain(
      "Azure Foundry / Kimi planning and review agent"
    )
    expect(output.join("\n")).toContain("foundry agent: created")
    expect(output.join("\n")).toContain("foundry-kimi:azure_foundry/Kimi-K2.6:created")
  })

  it("renders repo-aware instructions from a LawyerRAG-style mixed repo profile", async () => {
    const workspace = createTempWorkspace("dispatcher-install-context")
    cleanups.push(workspace.cleanup)
    copyRepoFixture("lawyerrag-mixed", workspace.repoPath)
    createLawyerRagControlPlane(workspace.repoPath)

    await runCli!(["install", workspace.repoPath, "--force"], {
      stdout: () => undefined,
      stderr: () => undefined
    })

    const codexInstructions = readFileSync(join(workspace.repoPath, ".openclaw", "agents", "codex-coder.md"), "utf8")
    const geminiInstructions = readFileSync(join(workspace.repoPath, ".openclaw", "agents", "gemini-ui.md"), "utf8")
    const existingReadme = readFileSync(join(workspace.repoPath, ".openclaw", "README.md"), "utf8")
    const bootstrapReadme = readFileSync(join(workspace.repoPath, ".openclaw", "dispatcher-bootstrap.md"), "utf8")
    const program = readFileSync(join(workspace.repoPath, ".openclaw", "program.md"), "utf8")
    const recipes = readFileSync(join(workspace.repoPath, ".openclaw", "recipes", "README.md"), "utf8")
    const contributing = readFileSync(join(workspace.repoPath, ".openclaw", "CONTRIBUTING.md"), "utf8")

    expect(codexInstructions).toContain("AGENTS.md")
    expect(codexInstructions).toContain("specs/043-backend-implementation-index/spec.md")
    expect(codexInstructions).toContain("`apps/backend/` - backend service (Python, FastAPI, uv, pytest)")
    expect(codexInstructions).toContain("`contracts/openapi.yaml` - canonical OpenAPI contract")
    expect(codexInstructions).toContain("`make test-openapi` - validate the canonical OpenAPI contract")
    expect(codexInstructions).toContain(".openclaw/control-plane.json")

    expect(geminiInstructions).toContain("apps/reports-ui/APPLICATION_DESIGN_PRINCIPLES.md")
    expect(geminiInstructions).toContain(
      "`apps/reports-ui/` - frontend application (Vite, React, TypeScript, Vitest, Playwright)"
    )
    expect(geminiInstructions).toContain("`cd apps/reports-ui && npm run check` - run the frontend check pipeline")
    expect(geminiInstructions).toContain(
      "`cd apps/reports-ui && npm run ui:audit` - re-run the UI audit crawl when route surfaces change"
    )
    expect(geminiInstructions).toContain("Treat `.openclaw/state/current/` as the live coordination surface")

    expect(existingReadme).toBe("# Existing control plane\n")
    expect(bootstrapReadme).toContain("# OpenClaw Dispatcher Bootstrap")
    expect(bootstrapReadme).toContain("This repository has been bootstrapped for the OpenClaw dispatcher framework.")
    expect(bootstrapReadme).toContain("Installed By Selected Profile")
    expect(bootstrapReadme).toContain("lawyerrag profile data and bootstrap state")
    expect(bootstrapReadme).toContain("./scripts/openclaw-dispatcher.sh doctor")
    expect(bootstrapReadme).toContain("./scripts/openclaw-dispatcher.sh install . --update-framework")
    expect(bootstrapReadme).toContain("OPENCLAW_DISPATCHER_FRAMEWORK_DIR")
    expect(bootstrapReadme).toContain("structured repo profile")
    expect(program).toContain("Keep LawyerRAG-specific behavior in the installed profile")
    expect(recipes).toContain("Lane-Safe Backend Change")
    expect(contributing).toContain("runtime-idea-harvest")
  })

  it("supports dry-run previews with ownership labels and generated diffs", async () => {
    const workspace = createTempWorkspace("dispatcher-install-dry-run")
    cleanups.push(workspace.cleanup)
    copyRepoFixture("generic-node", workspace.repoPath)

    mkdirSync(join(workspace.repoPath, ".openclaw", "agents"), { recursive: true })
    writeFileSync(join(workspace.repoPath, ".openclaw", "README.md"), "# Existing control plane\n", "utf8")
    writeFileSync(join(workspace.repoPath, ".openclaw", "agents", "codex-coder.md"), "# stale prompt\n", "utf8")

    const output: string[] = []
    await runCli!(
      ["install", workspace.repoPath, "--company-name", "Acme AI", "--project-name", "demo-app", "--dry-run", "--diff"],
      {
        stdout: (message: string) => output.push(message),
        stderr: (message: string) => output.push(message)
      }
    )

    const fullOutput = output.join("\n")
    expect(fullOutput).toContain("Previewed dispatcher install")
    expect(fullOutput).toContain("mode: dry-run")
    expect(fullOutput).toContain("Dispatcher-generated files:")
    expect(fullOutput).toContain("Autonomy-framework files:")
    expect(fullOutput).toContain("Repo-owned files:")
    expect(fullOutput).toContain("would keep: .openclaw/agents/codex-coder.md")
    expect(fullOutput).toContain("would create: .openclaw/agents/main.md")
    expect(fullOutput).toContain("would create: .openclaw/state/bootstrap/categories.json")
    expect(fullOutput).toContain("would create: .openclaw/dispatcher-bootstrap.md")
    expect(fullOutput).toContain("would create: scripts/openclaw-dispatcher.sh")
    expect(fullOutput).toContain("would keep: .openclaw/README.md")
    expect(fullOutput).toContain("Generated diffs:")
    expect(fullOutput).toContain("```diff")
    expect(fullOutput).toContain("--- .openclaw/agents/codex-coder.md")

    expect(existsSync(join(workspace.repoPath, ".openclaw", "dispatcher.db"))).toBe(false)
    expect(existsSync(join(workspace.repoPath, ".openclaw", "dispatcher-bootstrap.md"))).toBe(false)
    expect(existsSync(join(workspace.repoPath, "scripts", "openclaw-dispatcher.sh"))).toBe(false)
    expect(readFileSync(join(workspace.repoPath, ".openclaw", "agents", "codex-coder.md"), "utf8")).toBe(
      "# stale prompt\n"
    )
  })

  it("refreshes only generated prompt files with --update-prompts", async () => {
    const workspace = createTempWorkspace("dispatcher-install-update-prompts")
    cleanups.push(workspace.cleanup)

    mkdirSync(join(workspace.repoPath, ".openclaw", "agents"), { recursive: true })
    writeFileSync(join(workspace.repoPath, ".openclaw", "agents", "codex-coder.md"), "# stale codex prompt\n", "utf8")
    writeFileSync(join(workspace.repoPath, ".openclaw", "agents", "gemini-ui.md"), "# stale gemini prompt\n", "utf8")
    writeFileSync(join(workspace.repoPath, ".openclaw", "dispatcher-bootstrap.md"), "# custom bootstrap\n", "utf8")

    const output: string[] = []
    await runCli!(
      ["install", workspace.repoPath, "--company-name", "Acme AI", "--project-name", "demo-app", "--update-prompts"],
      {
        stdout: (message: string) => output.push(message),
        stderr: (message: string) => output.push(message)
      }
    )

    const fullOutput = output.join("\n")
    expect(fullOutput).toContain("Refreshed dispatcher agent prompts")
    expect(fullOutput).toContain("scope: generated agent prompts only")
    expect(fullOutput).toContain("updated: .openclaw/agents/codex-coder.md")
    expect(fullOutput).toContain("updated: .openclaw/agents/gemini-ui.md")
    expect(fullOutput).toContain("kept: .openclaw/dispatcher-bootstrap.md")
    expect(fullOutput).toContain("kept: scripts/openclaw-dispatcher.sh")

    const codexInstructions = readFileSync(join(workspace.repoPath, ".openclaw", "agents", "codex-coder.md"), "utf8")
    const geminiInstructions = readFileSync(join(workspace.repoPath, ".openclaw", "agents", "gemini-ui.md"), "utf8")
    const bootstrapReadme = readFileSync(join(workspace.repoPath, ".openclaw", "dispatcher-bootstrap.md"), "utf8")

    expect(codexInstructions).toContain("You are the primary implementation agent for demo-app.")
    expect(geminiInstructions).toContain("You are the UI and design-focused implementation agent for demo-app.")
    expect(bootstrapReadme).toBe("# custom bootstrap\n")
    expect(existsSync(join(workspace.repoPath, ".openclaw", "dispatcher.db"))).toBe(false)
    expect(existsSync(join(workspace.repoPath, "scripts", "openclaw-dispatcher.sh"))).toBe(false)
  })

  it("refreshes framework shims without touching prompts or custom wrappers", async () => {
    const workspace = createTempWorkspace("dispatcher-install-update-framework")
    cleanups.push(workspace.cleanup)

    mkdirSync(join(workspace.repoPath, ".openclaw", "agents"), { recursive: true })
    mkdirSync(join(workspace.repoPath, ".openclaw", "bin"), { recursive: true })
    mkdirSync(join(workspace.repoPath, "scripts"), { recursive: true })
    const stalePrompt = "# stale codex prompt\n"
    const customWrapper = '#!/bin/sh\nexec python3 scripts/openclaw_director.py "$@"\n'
    writeFileSync(join(workspace.repoPath, ".openclaw", "agents", "codex-coder.md"), stalePrompt, "utf8")
    writeFileSync(join(workspace.repoPath, ".openclaw", "bin", "dispatcher"), "#!/bin/sh\necho stale\n", "utf8")
    writeFileSync(join(workspace.repoPath, "scripts", "openclaw-dispatcher.sh"), customWrapper, "utf8")

    const output: string[] = []
    await runCli!(
      ["install", workspace.repoPath, "--company-name", "Acme AI", "--project-name", "demo-app", "--update-framework"],
      {
        stdout: (message: string) => output.push(message),
        stderr: (message: string) => output.push(message)
      }
    )

    const fullOutput = output.join("\n")
    expect(fullOutput).toContain("Refreshed dispatcher framework shims")
    expect(fullOutput).toContain("scope: framework runtime files only")
    expect(fullOutput).toContain("updated: .openclaw/bin/dispatcher")
    expect(fullOutput).toContain("kept: scripts/openclaw-dispatcher.sh")
    expect(fullOutput).toContain("Framework refresh only")

    const dispatcherShim = readFileSync(join(workspace.repoPath, ".openclaw", "bin", "dispatcher"), "utf8")
    expect(dispatcherShim).toContain("OPENCLAW_DISPATCHER_FRAMEWORK_DIR")
    expect(dispatcherShim).toContain("apps/dispatcher-cli/dist/index.js")
    expect(readFileSync(join(workspace.repoPath, "scripts", "openclaw-dispatcher.sh"), "utf8")).toBe(customWrapper)
    expect(readFileSync(join(workspace.repoPath, ".openclaw", "agents", "codex-coder.md"), "utf8")).toBe(stalePrompt)
    expect(existsSync(join(workspace.repoPath, ".openclaw", "dispatcher.db"))).toBe(false)
  })

  it("creates a working repo-local doctor wrapper", async () => {
    const workspace = createTempWorkspace("dispatcher-install-wrapper")
    cleanups.push(workspace.cleanup)

    await runCli!(["install", workspace.repoPath], {
      stdout: () => undefined,
      stderr: () => undefined
    })

    const output = execFileSync(
      join(workspace.repoPath, "scripts", "openclaw-dispatcher.sh"),
      ["doctor", "--wrapper-check"],
      {
        encoding: "utf8"
      }
    )

    expect(output).toContain("dispatcher wrapper: ok")
    expect(output).toContain(`repo: ${workspace.repoPath}`)
    expect(output).toContain(".openclaw/dispatcher.db")
  })
})
