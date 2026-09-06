import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

type PackageManager = "pnpm" | "npm" | "yarn"
type RepoAudience = "shared" | "codex" | "gemini"

type PackageJson = {
  packageManager?: string
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

export type RepoInstructionItem = {
  path: string
  reason: string
}

export type RepoStackProfile = {
  kind: "frontend" | "backend" | "workspace"
  path: string
  label: string
  stack: string[]
}

export type RepoContractProfile = {
  path: string
  label: string
}

export type RepoLaneDocProfile = {
  path: string
  label: string
}

export type RepoControlPlaneSignal = {
  path: string
  note: string
}

export type RepoVerifyCommand = {
  command: string
  reason: string
}

export type RepoProfile = {
  profileName: string
  sharedReads: string[]
  codexReads: string[]
  geminiReads: string[]
  repoMap: string[]
  codexVerify: string[]
  geminiVerify: string[]
  repoNotes: string[]
  uiRoots: string[]
  backendRoots: string[]
  contractPaths: string[]
  sharedReadItems: RepoInstructionItem[]
  codexReadItems: RepoInstructionItem[]
  geminiReadItems: RepoInstructionItem[]
  stackProfiles: RepoStackProfile[]
  contractProfiles: RepoContractProfile[]
  laneDocProfiles: RepoLaneDocProfile[]
  controlPlaneSignals: RepoControlPlaneSignal[]
  codexVerifyCommands: RepoVerifyCommand[]
  geminiVerifyCommands: RepoVerifyCommand[]
  projectVerifyCommand: string | null
}

export type RepoContext = RepoProfile

type RepoSnapshot = {
  fileExists: (relativePath: string) => boolean
  dirExists: (relativePath: string) => boolean
  readText: (relativePath: string) => string | null
  readJson: <T>(relativePath: string) => T | null
  listDirectories: (relativePath: string) => string[]
  detectPackageManager: (relativePath?: string) => PackageManager
}

function createSnapshot(targetPath: string): RepoSnapshot {
  function absolute(relativePath: string): string {
    return relativePath === "." ? targetPath : join(targetPath, relativePath)
  }

  return {
    fileExists(relativePath: string): boolean {
      return existsSync(absolute(relativePath))
    },
    dirExists(relativePath: string): boolean {
      try {
        return statSync(absolute(relativePath)).isDirectory()
      } catch {
        return false
      }
    },
    readText(relativePath: string): string | null {
      try {
        return readFileSync(absolute(relativePath), "utf8")
      } catch {
        return null
      }
    },
    readJson<T>(relativePath: string): T | null {
      const text = this.readText(relativePath)
      if (!text) return null

      try {
        return JSON.parse(text) as T
      } catch {
        return null
      }
    },
    listDirectories(relativePath: string): string[] {
      try {
        return readdirSync(absolute(relativePath), { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
      } catch {
        return []
      }
    },
    detectPackageManager(relativePath = "."): PackageManager {
      return detectPackageManagerAt(targetPath, relativePath)
    }
  }
}

function detectPackageManagerAt(targetPath: string, relativePath = "."): PackageManager {
  const packageJsonPath =
    relativePath === "." ? join(targetPath, "package.json") : join(targetPath, relativePath, "package.json")

  if (existsSync(packageJsonPath)) {
    try {
      const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as PackageJson
      if (parsed.packageManager?.startsWith("pnpm")) return "pnpm"
      if (parsed.packageManager?.startsWith("yarn")) return "yarn"
      if (parsed.packageManager?.startsWith("npm")) return "npm"
    } catch {
      // Ignore parse failure and keep the lockfile heuristic below.
    }
  }

  const dir = relativePath === "." ? targetPath : join(targetPath, relativePath)
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm"
  if (existsSync(join(dir, "yarn.lock"))) return "yarn"
  return "npm"
}

function uniq<T>(values: T[], keyOf: (value: T) => string): T[] {
  const seen = new Set<string>()
  const result: T[] = []

  for (const value of values) {
    const key = keyOf(value)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(value)
  }

  return result
}

function packageJsonAt(snapshot: RepoSnapshot, areaPath: string): PackageJson | null {
  const packageJsonPath = areaPath === "." ? "package.json" : `${areaPath}/package.json`
  return snapshot.readJson<PackageJson>(packageJsonPath)
}

function pathInArea(areaPath: string, relativePath: string): string {
  return areaPath === "." ? relativePath : `${areaPath}/${relativePath}`
}

function displayDir(areaPath: string): string {
  if (areaPath === ".") return "./"
  return areaPath.endsWith("/") ? areaPath : `${areaPath}/`
}

function packageScriptCommand(packageManager: PackageManager, scriptName: string): string {
  if (packageManager === "npm") {
    return scriptName === "test" ? "npm test" : `npm run ${scriptName}`
  }

  if (packageManager === "yarn") {
    return scriptName === "test" ? "yarn test" : `yarn ${scriptName}`
  }

  return scriptName === "test" ? "pnpm test" : `pnpm run ${scriptName}`
}

function contractTestCommand(packageManager: PackageManager): string {
  return packageManager === "yarn"
    ? "yarn test __contracts__/"
    : `${packageScriptCommand(packageManager, "test")} -- __contracts__/`
}

function commandInDir(areaPath: string, command: string): string {
  return areaPath === "." ? command : `cd ${areaPath} && ${command}`
}

function combinedDependencyKeys(packageJson: PackageJson): Set<string> {
  return new Set([...Object.keys(packageJson.dependencies ?? {}), ...Object.keys(packageJson.devDependencies ?? {})])
}

function makefileTargets(snapshot: RepoSnapshot): Set<string> {
  const makefile = snapshot.readText("Makefile")
  if (!makefile) return new Set()

  const targets = new Set<string>()
  for (const line of makefile.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(".")) continue

    const match = /^([A-Za-z0-9_.-]+)\s*:/.exec(trimmed)
    if (match?.[1]) targets.add(match[1])
  }

  return targets
}

function formatStack(profile: RepoStackProfile): string {
  const stackSuffix = profile.stack.length > 0 ? ` (${profile.stack.join(", ")})` : ""
  return `\`${profile.path}\` - ${profile.label}${stackSuffix}`
}

function formatContract(profile: RepoContractProfile): string {
  return `\`${profile.path}\` - ${profile.label}`
}

function formatLaneDoc(profile: RepoLaneDocProfile): string {
  return `\`${profile.path}\` - ${profile.label}`
}

function formatSignal(profile: RepoControlPlaneSignal): string {
  return `\`${profile.path}\` - ${profile.note}`
}

function formatVerify(command: RepoVerifyCommand): string {
  return command.command
}

function addRead(profile: RepoProfile, audience: RepoAudience, path: string, reason: string): void {
  const item = { path, reason }
  if (audience === "shared") profile.sharedReadItems.push(item)
  if (audience === "codex") profile.codexReadItems.push(item)
  if (audience === "gemini") profile.geminiReadItems.push(item)
}

function addStack(profile: RepoProfile, stack: RepoStackProfile): void {
  profile.stackProfiles.push(stack)
  if (stack.kind === "frontend" && stack.path !== "./") {
    profile.uiRoots.push(stack.path)
  }
  if (stack.kind === "backend") {
    profile.backendRoots.push(stack.path)
  }
}

function addContract(profile: RepoProfile, contract: RepoContractProfile): void {
  profile.contractProfiles.push(contract)
  profile.contractPaths.push(contract.path)
}

function addLaneDoc(profile: RepoProfile, laneDoc: RepoLaneDocProfile): void {
  profile.laneDocProfiles.push(laneDoc)
}

function addSignal(profile: RepoProfile, signal: RepoControlPlaneSignal): void {
  profile.controlPlaneSignals.push(signal)
}

function addVerify(profile: RepoProfile, audience: "codex" | "gemini", command: string, reason: string): void {
  const item = { command, reason }
  if (audience === "codex") profile.codexVerifyCommands.push(item)
  if (audience === "gemini") profile.geminiVerifyCommands.push(item)
}

function addNote(profile: RepoProfile, note: string): void {
  profile.repoNotes.push(note)
}

function detectSharedGuidance(snapshot: RepoSnapshot, profile: RepoProfile): void {
  if (snapshot.fileExists("AGENTS.md")) {
    addRead(profile, "shared", "AGENTS.md", "repo-local working rules and ownership expectations")
  }

  if (snapshot.fileExists(".openclaw/README.md")) {
    addRead(profile, "shared", ".openclaw/README.md", "repo-owned control-plane overview")
  }

  if (snapshot.fileExists("docs/DIRECTORY_MAP.md")) {
    addRead(profile, "shared", "docs/DIRECTORY_MAP.md", "directory map for repo navigation")
  }
}

function detectControlPlane(snapshot: RepoSnapshot, profile: RepoProfile): void {
  if (snapshot.fileExists(".openclaw/control-plane.json")) {
    addRead(profile, "shared", ".openclaw/control-plane.json", "repo-owned control-plane policy")
    addSignal(profile, {
      path: ".openclaw/control-plane.json",
      note: "This repository already has a repo-owned `.openclaw` control plane. Align dispatcher work with it instead of inventing a parallel workflow."
    })
  }

  if (snapshot.dirExists(".openclaw/state/current")) {
    addSignal(profile, {
      path: ".openclaw/state/current/",
      note: "Treat `.openclaw/state/current/` as the live coordination surface when that state is present."
    })
  }
}

function detectContracts(snapshot: RepoSnapshot, profile: RepoProfile): void {
  if (snapshot.fileExists("contracts/openapi.yaml")) {
    addContract(profile, {
      path: "contracts/openapi.yaml",
      label: "canonical OpenAPI contract"
    })
  }

  if (snapshot.dirExists("contracts/schemas")) {
    addContract(profile, {
      path: "contracts/schemas/",
      label: "shared schema definitions"
    })
  }
}

function detectLaneDocs(snapshot: RepoSnapshot, profile: RepoProfile): void {
  const docs: Array<{
    path: string
    label: string
    audience?: RepoAudience
    reason?: string
  }> = [
    {
      path: "agent/rules/development-workflow.md",
      label: "backend workflow rules",
      audience: "codex",
      reason: "backend development workflow rules"
    },
    {
      path: "agent/rules/architecture.md",
      label: "backend architecture rules",
      audience: "codex",
      reason: "backend architecture guardrails"
    },
    {
      path: "docs/ARCHITECTURE.md",
      label: "system architecture overview",
      audience: "codex",
      reason: "system architecture overview"
    },
    {
      path: "docs/TESTING.md",
      label: "testing strategy",
      audience: "codex",
      reason: "testing strategy and verification expectations"
    }
  ]

  for (const directory of snapshot.listDirectories("specs")) {
    if (!directory.endsWith("-implementation-index")) continue
    const frontend = /(?:frontend|(?:^|-)ui(?:-|$))/.test(directory)
    const backend = /(?:^|-)backend(?:-|$)/.test(directory)
    if (!frontend && !backend) continue
    docs.push({
      path: `specs/${directory}/spec.md`,
      label: frontend ? "frontend ownership map" : "backend ownership map",
      audience: frontend ? "gemini" : "codex",
      reason: frontend ? "frontend lane ownership and route map" : "backend lane ownership and implementation map"
    })
  }

  for (const doc of docs) {
    if (!snapshot.fileExists(doc.path)) continue
    addLaneDoc(profile, { path: doc.path, label: doc.label })
    if (doc.audience && doc.reason) {
      addRead(profile, doc.audience, doc.path, doc.reason)
    }
  }
}

function detectNodeAreas(snapshot: RepoSnapshot, profile: RepoProfile): void {
  const candidates = [".", ...snapshot.listDirectories("apps").map((entry) => `apps/${entry}`)]

  for (const areaPath of candidates) {
    const packageJson = packageJsonAt(snapshot, areaPath)
    if (!packageJson) continue

    const dependencyKeys = combinedDependencyKeys(packageJson)
    const scripts = packageJson.scripts ?? {}
    const packageManager = snapshot.detectPackageManager(areaPath)
    const stack: string[] = []

    if (dependencyKeys.has("next")) stack.push("Next.js")
    else if (dependencyKeys.has("vite")) stack.push("Vite")
    else stack.push("Node.js")

    if (dependencyKeys.has("react")) stack.push("React")
    if (dependencyKeys.has("typescript") || snapshot.fileExists(pathInArea(areaPath, "tsconfig.json"))) {
      stack.push("TypeScript")
    }
    if (dependencyKeys.has("vitest")) stack.push("Vitest")
    if (dependencyKeys.has("@playwright/test") || "ui:audit" in scripts || "test:e2e" in scripts) {
      stack.push("Playwright")
    }

    const looksLikeFrontend =
      dependencyKeys.has("react") ||
      dependencyKeys.has("next") ||
      dependencyKeys.has("vite") ||
      "ui:audit" in scripts ||
      "test:e2e" in scripts ||
      "test:critical" in scripts

    if (looksLikeFrontend) {
      addStack(profile, {
        kind: "frontend",
        path: displayDir(areaPath),
        label: "frontend application",
        stack
      })

      const uiDocs: Array<{ path: string; reason: string }> = [
        {
          path: pathInArea(areaPath, "APPLICATION_DESIGN_PRINCIPLES.md"),
          reason: "product design principles for UI changes"
        },
        {
          path: pathInArea(areaPath, "STYLE_RECIPE.md"),
          reason: "visual language and styling recipe"
        },
        {
          path: pathInArea(areaPath, "src/utils/uiAuditScanner.ts"),
          reason: "route and UI audit scanner behavior"
        },
        {
          path: pathInArea(areaPath, "e2e/ui-audit-crawl.spec.ts"),
          reason: "UI audit crawl expectations"
        }
      ]

      for (const doc of uiDocs) {
        if (snapshot.fileExists(doc.path)) {
          addRead(profile, "gemini", doc.path, doc.reason)
        }
      }

      if ("check" in scripts) {
        addVerify(
          profile,
          "gemini",
          commandInDir(areaPath, packageScriptCommand(packageManager, "check")),
          "run the frontend check pipeline"
        )
      }
      if ("test:critical" in scripts) {
        addVerify(
          profile,
          "gemini",
          commandInDir(areaPath, packageScriptCommand(packageManager, "test:critical")),
          "cover critical route and UI regressions"
        )
      }
      if (snapshot.dirExists(pathInArea(areaPath, "src/__contracts__")) && "test" in scripts) {
        addVerify(
          profile,
          "gemini",
          commandInDir(areaPath, contractTestCommand(packageManager)),
          "re-check frontend API contract coverage"
        )
      }
      if (snapshot.fileExists(pathInArea(areaPath, "e2e/ui-audit-crawl.spec.ts")) && "ui:audit" in scripts) {
        addVerify(
          profile,
          "gemini",
          commandInDir(areaPath, packageScriptCommand(packageManager, "ui:audit")),
          "re-run the UI audit crawl when route surfaces change"
        )
      }

      continue
    }

    if (areaPath === ".") {
      addStack(profile, {
        kind: "workspace",
        path: "./",
        label: "Node.js workspace",
        stack: [...new Set([...stack, packageManager])]
      })
    }
  }
}

function pythonRunner(pyprojectText: string | null): string {
  if (!pyprojectText) return "pytest"
  return pyprojectText.includes("[tool.uv") || pyprojectText.includes("[dependency-groups]")
    ? "uv run pytest"
    : "pytest"
}

function detectPythonAreas(snapshot: RepoSnapshot, profile: RepoProfile): void {
  const candidates = [".", ...snapshot.listDirectories("apps").map((entry) => `apps/${entry}`)]
  const targets = makefileTargets(snapshot)

  for (const areaPath of candidates) {
    const pyproject = snapshot.readText(pathInArea(areaPath, "pyproject.toml"))
    const pytest = snapshot.readText(pathInArea(areaPath, "pytest.ini"))
    if (!pyproject && !pytest) continue

    const stack = ["Python"]
    const lowerPyproject = pyproject?.toLowerCase() ?? ""
    if (lowerPyproject.includes("fastapi")) stack.push("FastAPI")
    if (lowerPyproject.includes("[tool.uv") || lowerPyproject.includes("[dependency-groups]")) stack.push("uv")
    if (pytest) stack.push("pytest")

    addStack(profile, {
      kind: "backend",
      path: displayDir(areaPath),
      label: "backend service",
      stack
    })

    const contractsDir = pathInArea(areaPath, "tests/contracts")
    if (snapshot.dirExists(contractsDir)) {
      const markers =
        (pytest?.includes("contract:") ?? false) ||
        (pytest?.includes("openapi:") ?? false) ||
        (pytest?.includes("backward_compat:") ?? false)
      const verifyCommand = `${pythonRunner(pyproject)} --no-cov tests/contracts/ -v${markers ? ' -m "contract or openapi or backward_compat"' : ""}`
      addVerify(
        profile,
        "codex",
        commandInDir(areaPath, verifyCommand),
        "validate backend contract behavior before finishing"
      )
    }

    if (snapshot.fileExists("contracts/openapi.yaml") && targets.has("test-openapi")) {
      addVerify(profile, "codex", "make test-openapi", "validate the canonical OpenAPI contract")
    }
  }
}

function finalizeProfile(profile: RepoProfile): RepoProfile {
  profile.sharedReadItems = uniq(profile.sharedReadItems, (item) => item.path)
  profile.codexReadItems = uniq(profile.codexReadItems, (item) => item.path)
  profile.geminiReadItems = uniq(profile.geminiReadItems, (item) => item.path)
  profile.stackProfiles = uniq(profile.stackProfiles, (item) => item.path)
  profile.contractProfiles = uniq(profile.contractProfiles, (item) => item.path)
  profile.laneDocProfiles = uniq(profile.laneDocProfiles, (item) => item.path)
  profile.controlPlaneSignals = uniq(profile.controlPlaneSignals, (item) => item.path)
  profile.codexVerifyCommands = uniq(profile.codexVerifyCommands, (item) => item.command)
  profile.geminiVerifyCommands = uniq(profile.geminiVerifyCommands, (item) => item.command)
  profile.repoNotes = uniq(profile.repoNotes, (item) => item)
  profile.uiRoots = uniq(profile.uiRoots, (item) => item)
  profile.backendRoots = uniq(profile.backendRoots, (item) => item)
  profile.contractPaths = uniq(profile.contractPaths, (item) => item)

  profile.sharedReads = profile.sharedReadItems.map((item) => item.path)
  profile.codexReads = profile.codexReadItems.map((item) => item.path)
  profile.geminiReads = profile.geminiReadItems.map((item) => item.path)
  profile.repoMap = [
    ...profile.stackProfiles.map(formatStack),
    ...profile.contractProfiles.map(formatContract),
    ...profile.laneDocProfiles.map(formatLaneDoc)
  ]
  profile.codexVerify = profile.codexVerifyCommands.map(formatVerify)
  profile.geminiVerify = profile.geminiVerifyCommands.map(formatVerify)

  const hasFrontend = profile.stackProfiles.some((item) => item.kind === "frontend")
  const hasBackend = profile.stackProfiles.some((item) => item.kind === "backend")
  if (hasFrontend && hasBackend) {
    profile.profileName = "mixed-frontend-backend"
  } else if (hasBackend) {
    profile.profileName = "python-backend"
  } else if (profile.stackProfiles.some((item) => item.kind === "workspace")) {
    profile.profileName = "node-workspace"
  } else {
    profile.profileName = "generic"
  }

  return profile
}

export function detectVerifyCommand(targetPath: string): string | null {
  const snapshot = createSnapshot(targetPath)
  const packageJson = packageJsonAt(snapshot, ".")
  if (packageJson) {
    const scripts = packageJson.scripts ?? {}
    const packageManager = snapshot.detectPackageManager(".")
    if (scripts.check) return packageScriptCommand(packageManager, "check")
    if (scripts.test) return packageScriptCommand(packageManager, "test")
    if (scripts.lint) return packageScriptCommand(packageManager, "lint")
  }

  if (snapshot.fileExists("pyproject.toml") || snapshot.fileExists("pytest.ini")) {
    return "pytest"
  }

  if (snapshot.fileExists("Cargo.toml")) {
    return "cargo test"
  }

  return null
}

export function detectRepoProfile(targetPath: string, verifyCommand: string | null): RepoProfile {
  const snapshot = createSnapshot(targetPath)
  const profile: RepoProfile = {
    profileName: "generic",
    sharedReads: [],
    codexReads: [],
    geminiReads: [],
    repoMap: [],
    codexVerify: [],
    geminiVerify: [],
    repoNotes: [],
    uiRoots: [],
    backendRoots: [],
    contractPaths: [],
    sharedReadItems: [],
    codexReadItems: [],
    geminiReadItems: [],
    stackProfiles: [],
    contractProfiles: [],
    laneDocProfiles: [],
    controlPlaneSignals: [],
    codexVerifyCommands: [],
    geminiVerifyCommands: [],
    projectVerifyCommand: verifyCommand
  }

  detectSharedGuidance(snapshot, profile)
  detectControlPlane(snapshot, profile)
  detectContracts(snapshot, profile)
  detectLaneDocs(snapshot, profile)
  detectNodeAreas(snapshot, profile)
  detectPythonAreas(snapshot, profile)

  if (verifyCommand) {
    addNote(profile, `Project-level verify command: \`${verifyCommand}\`.`)
  }

  if (profile.stackProfiles.length === 0 && snapshot.fileExists("README.md")) {
    addNote(
      profile,
      "No strong stack signals were detected yet. Start with `README.md` and inspect the repo before assuming lane ownership."
    )
  }

  return finalizeProfile(profile)
}

export function detectRepoContext(targetPath: string, verifyCommand: string | null): RepoContext {
  return detectRepoProfile(targetPath, verifyCommand)
}
