import { execFile } from "node:child_process"
import { existsSync, readFileSync, realpathSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { promisify } from "node:util"
import { type NativeAutonomyPolicy, validateNativeAutonomyPolicy } from "@openclaw/domain"
import { readExecutionOwnership } from "@openclaw/os-adapters"
import { assertConfiguredNativeCapabilities, configuredNativeModels } from "./capabilities.js"
import { NATIVE_GATEWAY_CONTRACT_VERSION, type NativeGateway, nativeCards, nativeObject } from "./gateway.js"
import { nativeModeAllows } from "./promotion-mode.js"
import type { NativeEvidenceStore } from "./store.js"

export function loadNativePolicy(path: string): NativeAutonomyPolicy {
  const value = JSON.parse(readFileSync(path, "utf8"))
  return validateNativeAutonomyPolicy(value.nativeAutonomy ?? value)
}
export async function nativeDoctor(
  policy: NativeAutonomyPolicy,
  gateway: NativeGateway,
  options: { platform?: NodeJS.Platform } = {}
) {
  const checks: Array<{ name: string; ok: boolean; detail: string }> = []
  const check = async (name: string, fn: () => Promise<string> | string) => {
    try {
      checks.push({ name, ok: true, detail: await fn() })
    } catch (error) {
      checks.push({ name, ok: false, detail: String(error) })
    }
  }
  await check("repository", () => realpathSync(policy.repository))
  await check("gateway-version", async () => {
    const versioned = gateway as NativeGateway & { version?: () => Promise<string> }
    if (!versioned.version) throw new Error("Native Gateway version unavailable; use the supported CLI transport")
    const version = await versioned.version()
    if (!["2026.9.1", "2026.9.2"].includes(version))
      throw new Error(`Unsupported OpenClaw version ${version}; reviewed contract supports 2026.9.1 and 2026.9.2`)
    return `OpenClaw ${version}; runtime contract v${NATIVE_GATEWAY_CONTRACT_VERSION}`
  })
  await check("workboard", async () => {
    const result = nativeObject(await gateway.request("workboard.boards.list", {}), "Workboard boards.list")
    if (!Array.isArray(result.boards) || result.boards.some((b: any) => !b || typeof b.id !== "string" || !b.id))
      throw new Error("Workboard boards.list contract: invalid board identities")
    if (!result.boards.some((b: any) => b.id === policy.boardId)) throw new Error("Configured native board is missing")
    await nativeCards(gateway, policy.boardId)
    return `Workboard read contract v${NATIVE_GATEWAY_CONTRACT_VERSION} validated; mutating capabilities require the installed contract smoke test`
  })
  await check("agents", async () => {
    const result = await gateway.request("agents.list", {})
    if (!Array.isArray(result?.agents) || result.agents.some((a: any) => !a || typeof a.id !== "string" || !a.id))
      throw new Error("agents.list contract: invalid agent identities")
    const ids = new Set(result.agents.map((a: any) => a.id))
    const required = [
      policy.plannerAgentId,
      policy.coderAgentId,
      policy.reviewerAgentId,
      ...policy.personas.map((p) => (policy.quality ? (p.investigationAgentId ?? p.personaId) : p.personaId))
    ]
    const missing = required.filter((id) => !ids.has(id))
    if (missing.length) throw new Error(`Missing native agents: ${missing.join(", ")}`)
    return "All configured personas and independent roles exist"
  })
  if (policy.quality) {
    await check("prompt-skill", () => {
      if (!readFileSync(policy.quality!.skillPath, "utf8").trim()) throw new Error("Prompt skill is empty")
      return "Prompt skill readable"
    })
    await check("research-tool-authority", async () => {
      const response = await gateway.request("config.get", {})
      const config = response.config ?? response.parsed
      if (!config) throw new Error("Cannot verify research tool permissions")
      const allowed = new Set([
        "autocode_context",
        "autocode_inspect",
        "autocode_propose",
        "autocode_investigation_finish",
        "workboard_complete",
        "workboard_heartbeat"
      ])
      for (const persona of policy.personas) {
        const id = persona.investigationAgentId
        if (!id || [policy.coderAgentId, policy.reviewerAgentId, policy.plannerAgentId].includes(id))
          throw new Error(`Dedicated research agent required for ${persona.personaId}`)
        const agent = config.agents?.entries?.[id] ?? config.agents?.list?.find((a: any) => a.id === id)
        const tools = agent?.tools
        if (
          !Array.isArray(tools?.allow) ||
          !tools.allow.length ||
          tools.allow.some((t: string) => !allowed.has(t)) ||
          tools.alsoAllow?.length ||
          tools.byProvider ||
          agent?.subagents?.allowAgents?.length
        )
          throw new Error(
            `Research agent ${id} must allow only native inspection, proposal, outcome and completion tools`
          )
        for (const tool of [
          "autocode_context",
          "autocode_inspect",
          "autocode_propose",
          "autocode_investigation_finish",
          "workboard_complete"
        ])
          if (!tools.allow.includes(tool)) throw new Error(`Research agent ${id} is missing ${tool}`)
      }
      return "Dedicated research roles restrict execution to read-only inspection and investigation records"
    })
  }
  await check("role-tool-authority", async () => {
    const response = nativeObject(await gateway.request("config.get", {}), "config.get")
    validateNativeRoleAuthority(policy, response.config ?? response.parsed)
    return "Planner, coder and reviewer have explicit narrow tools and confined execution; local trusted factory broker required"
  })
  if (policy.mode === "staging-canary" || policy.mode === "application-release") {
    await check("measured-role-capabilities", async () => {
      const response = nativeObject(await gateway.request("config.get", {}), "config.get")
      const models = configuredNativeModels(response.config ?? response.parsed, policy)
      const db = new DatabaseSync(join(policy.repository, ".openclaw/native-evidence.db"), { readOnly: true })
      try {
        const reader: Pick<NativeEvidenceStore, "get"> = {
          get: <T>(kind: string, id: string): T | null => {
            const row = db.prepare("SELECT data FROM native_records WHERE kind=? AND id=?").get(kind, id)
            return row ? (JSON.parse(String(row.data)) as T) : null
          }
        }
        const decisions = assertConfiguredNativeCapabilities(reader, policy, models)
        return `${decisions.length} configured roles have current protected live capability evidence; upstream retains account ownership`
      } finally {
        db.close()
      }
    })
  }
  await check("automation-contract", async () => {
    const response = nativeObject(await gateway.request("cron.list", { includeDisabled: true, offset: 0 }), "cron.list")
    if (
      !Array.isArray(response.jobs) ||
      response.jobs.some((j: any) => !j || typeof j.id !== "string" || !j.id) ||
      (response.hasMore !== undefined && typeof response.hasMore !== "boolean") ||
      (response.hasMore === true && (!Number.isSafeInteger(response.nextOffset) || response.nextOffset <= 0))
    )
      throw new Error("cron.list contract: invalid jobs or pagination")
    return "Automation read contract validated; no jobs created or activated"
  })
  await check("legacy-database", () => {
    const path = join(policy.repository, ".openclaw/dispatcher.db")
    if (!existsSync(path)) return "No legacy dispatcher"
    const db = new DatabaseSync(path, { readOnly: true })
    try {
      if (
        Number(db.prepare("SELECT count(*) AS n FROM runs WHERE status='running'").get()?.n) ||
        Number(db.prepare("SELECT count(*) AS n FROM automations WHERE status='active'").get()?.n)
      )
        throw new Error("Legacy dispatcher still owns active work")
      return "Legacy dispatcher paused"
    } finally {
      db.close()
    }
  })
  await check("execution-owner", () => {
    const owner = readExecutionOwnership(policy.repository)
    if (
      (owner && owner.owner !== "native") ||
      (!owner && existsSync(join(policy.repository, ".openclaw/dispatcher.db")))
    )
      throw new Error(
        "Transfer paused legacy execution ownership through a reviewed migration before native activation"
      )
    return owner
      ? `Native execution owner generation ${owner.generation}`
      : "Fresh native repository; ownership will be claimed on first execution"
  })
  await check("legacy-timers", async () => {
    const platform = options.platform ?? process.platform
    if (platform !== "linux")
      throw new Error(
        `Native activation unsupported on ${platform}: no reviewed legacy supervisor ownership probe; systemctl was not invoked`
      )
    const exec = promisify(execFile)
    const { stdout } = await exec(
      "systemctl",
      [
        "--user",
        "show",
        "openclaw-dispatcher-execution.timer",
        "openclaw-dispatcher-maintenance.timer",
        "-p",
        "ActiveState"
      ],
      { timeout: 10_000 }
    )
    if (/ActiveState=active/.test(stdout)) throw new Error("Legacy dispatcher timers are active")
    return "No active legacy dispatcher timers"
  })
  await check("deployment-policy", () => {
    if (policy.repositoryKind === "application" && !policy.deployment)
      throw new Error("Deployment and revision check commands required before activation")
    return policy.repositoryKind === "framework"
      ? "Framework work requires human review"
      : "Deployment and revision check configured"
  })
  await check("verification-authority", () => {
    const authority = policy.verificationAuthority
    if (!authority?.reviewedRevision || !authority.acceptance?.length)
      throw new Error("Reviewed verification authority and acceptance bindings required before activation")
    if (
      policy.verification.some(
        (check) => !check.argv[0]?.startsWith("/opt/openclaw/checks/") || check.argv[0].includes("..")
      )
    )
      throw new Error("Mandatory commands must use protected /opt/openclaw/checks executables")
    return "Reviewed verification authority declared; exact candidate and artifact bindings verified at submission and release"
  })
  await check("required-ci", () => {
    if (
      policy.repositoryKind === "application" &&
      nativeModeAllows(policy, "release") &&
      !policy.requiredCi?.checks.length
    )
      throw new Error("Named required CI checks and trusted app identities must be configured before activation")
    return !nativeModeAllows(policy, "release")
      ? "Automatic release is disabled by promotion mode; CI remains required before release activation"
      : policy.repositoryKind === "framework"
        ? "Framework release remains human-gated"
        : "Required CI policy configured; exact head checks are verified at release"
  })
  return { ok: checks.every((c) => c.ok), enabled: policy.enabled, boardId: policy.boardId, checks }
}

/** Local operator/plugin code remains trusted; these checks prevent delegated tool authority expansion. */
export function validateNativeRoleAuthority(policy: NativeAutonomyPolicy, value: unknown): void {
  const config = nativeObject(value, "Role config")
  const completion = ["workboard_complete", "workboard_heartbeat"]
  const roles = [
    {
      id: policy.plannerAgentId,
      tools: ["autocode_context", "autocode_proposals", "autocode_admit", "autocode_defer", ...completion],
      access: "ro"
    },
    {
      id: policy.coderAgentId,
      tools: ["autocode_context", "autocode_submit", "read", "write", "edit", "exec", "process", ...completion],
      access: "rw"
    },
    {
      id: policy.reviewerAgentId,
      tools: ["autocode_context", "autocode_review", "autocode_design_review", "read", ...completion],
      access: "ro"
    }
  ]
  if (new Set(roles.map((r) => r.id)).size !== roles.length)
    throw new Error("Independent planner, coder and reviewer identities required")
  for (const role of roles) {
    const agent = config.agents?.entries?.[role.id] ?? config.agents?.list?.find((a: any) => a.id === role.id)
    const tools = agent?.tools
    if (
      !Array.isArray(tools?.allow) ||
      !tools.allow.length ||
      tools.allow.some((tool: unknown) => !role.tools.includes(String(tool))) ||
      tools.alsoAllow?.length ||
      tools.byProvider ||
      agent?.subagents?.allowAgents?.length ||
      tools.elevated?.enabled !== false
    )
      throw new Error(
        `Role ${role.id} requires explicit narrow tools, elevated disabled and no provider/subagent expansion`
      )
    if (
      agent.sandbox?.mode !== "all" ||
      agent.sandbox?.workspaceAccess !== role.access ||
      agent.sandbox?.docker?.network !== "none"
    )
      throw new Error(`Role ${role.id} requires sandbox mode all, workspaceAccess ${role.access} and network none`)
    const defaults = config.agents?.defaults?.sandbox?.docker ?? {}
    const docker = { ...defaults, ...agent.sandbox.docker }
    if (
      docker.binds?.length ||
      docker.dangerouslyAllowReservedContainerTargets ||
      docker.dangerouslyAllowExternalBindSources ||
      docker.dangerouslyAllowContainerNamespaceJoin
    )
      throw new Error(`Role ${role.id} cannot add host mounts or sandbox escape overrides`)
    if (role.id === policy.coderAgentId && tools.exec?.host !== "sandbox")
      throw new Error(`Role ${role.id} requires exec.host sandbox`)
    for (const tool of role.tools.filter((tool) => tool.startsWith("autocode_") || tool === "workboard_complete"))
      if (!tools.allow.includes(tool)) throw new Error(`Role ${role.id} is missing ${tool}`)
    const sandboxTools = tools.sandbox?.tools ?? config.tools?.sandbox?.tools
    for (const tool of role.tools.filter((tool) => tool.startsWith("autocode_") || tool === "workboard_complete")) {
      const plugin = tool.startsWith("autocode_") ? "autocode" : "workboard"
      if (
        ![...(sandboxTools?.allow ?? []), ...(sandboxTools?.alsoAllow ?? [])].some((v) => v === tool || v === plugin) ||
        (sandboxTools?.deny ?? []).some((v: string) => v === "*" || v === tool || v === plugin)
      )
        throw new Error(`Role ${role.id} sandbox tool policy hides ${tool}`)
    }
  }
}
