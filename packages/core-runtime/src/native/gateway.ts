import { execFile } from "node:child_process"
import { accessSync, constants, realpathSync, statSync } from "node:fs"
import { createRequire } from "node:module"
import { delimiter, isAbsolute, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"

export interface OwnedInvestigationAbort {
  boardId: string
  roundId: string
  personaId: string
  cardId: string
  agentId: string
  sessionKey: string
  runId: string
}
export type OwnedInvestigationAbortResult = { status: "pending" | "terminal" }
export type NativeAdminAbortCall = (
  method: "sessions.abort",
  options: { json: true; timeout: string },
  params: { key: string; agentId: string; runId: string },
  extra: { scopes: ["operator.admin"]; progress: false }
) => Promise<unknown>
export function resolveNativeGatewaySdkPath(command: string, searchPath = process.env.PATH ?? ""): string {
  const candidates =
    isAbsolute(command) || command.includes(sep)
      ? [resolve(command)]
      : searchPath.split(delimiter).map((directory) => resolve(directory || ".", command))
  let executable: string | undefined
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK)
      if (!statSync(candidate).isFile()) continue
      executable = realpathSync(candidate)
      break
    } catch {
      /* Follow execFile PATH search, never treating a same-named directory as the CLI. */
    }
  }
  if (!executable) throw new Error("Configured OpenClaw executable unavailable")
  // Only the public package export is resolved, relative to the actual CLI installation.
  return createRequire(executable).resolve("openclaw/plugin-sdk/gateway-runtime")
}
async function loadAdminAbortCall(command: string): Promise<NativeAdminAbortCall> {
  const sdk = await import(pathToFileURL(resolveNativeGatewaySdkPath(command)).href)
  if (typeof sdk.callGatewayFromCli !== "function") throw new Error("Public gateway SDK unavailable")
  return sdk.callGatewayFromCli
}
export interface NativeGateway {
  request<T = any>(method: string, params: Record<string, unknown>): Promise<T>
  abortOwnedInvestigation?(input: OwnedInvestigationAbort): Promise<OwnedInvestigationAbortResult>
}
/** Never fall back to offline dispatch or a second execution runtime. */
export class NativeCliGateway implements NativeGateway {
  constructor(
    readonly command = "openclaw",
    private readonly loadAbortCall: (command: string) => Promise<NativeAdminAbortCall> = loadAdminAbortCall
  ) {}
  async abortOwnedInvestigation(input: OwnedInvestigationAbort): Promise<OwnedInvestigationAbortResult> {
    for (const value of Object.values(input))
      if (typeof value !== "string" || !value.trim()) throw new Error("Incomplete investigation ownership")
    const readOwnedCard = async () => {
      const result = await this.request<{ cards: any[] }>("workboard.cards.list", { boardId: input.boardId })
      const card = result.cards.find((item) => item.id === input.cardId)
      const launch = card?.metadata?.automation?.launch
      if (
        !card ||
        (card.boardId && card.boardId !== input.boardId) ||
        card.agentId !== input.agentId ||
        card.metadata?.automation?.boardId !== input.boardId ||
        card.metadata?.automation?.idempotencyKey !== `round:${input.roundId}:${input.personaId}` ||
        card.sessionKey !== input.sessionKey ||
        card.runId !== input.runId ||
        (card.execution?.sessionKey && card.execution.sessionKey !== input.sessionKey) ||
        (card.execution?.runId && card.execution.runId !== input.runId) ||
        launch?.phase !== "accepted" ||
        launch.acceptedSessionKey !== input.sessionKey ||
        launch.acceptedRunId !== input.runId
      )
        throw new Error("Investigation cancellation ownership mismatch")
      return card
    }
    const sessionTerminal = async (card: any) => {
      const result = await this.request<{ sessions: any[] }>("sessions.list", { search: input.sessionKey, limit: 10 })
      const session = result.sessions.find((item) => item.key === input.sessionKey && item.agentId === input.agentId)
      return Boolean(
        session &&
          session.hasActiveRun === false &&
          session.hasActiveSubagentRun === false &&
          Array.isArray(session.activeRunIds) &&
          session.activeRunIds.length === 0 &&
          Number.isFinite(session.endedAt) &&
          Number.isFinite(card.execution?.startedAt ?? card.startedAt) &&
          session.endedAt >= (card.execution?.startedAt ?? card.startedAt) &&
          ["done", "completed", "failed", "cancelled", "timed_out", "timeout", "killed"].includes(session.status)
      )
    }
    let card = await readOwnedCard()
    if (await sessionTerminal(card)) return { status: "terminal" }
    if (card.status !== "running" || card.execution?.status !== "running") return { status: "pending" }
    const call = await this.loadAbortCall(this.command)
    // Loading the SDK may take time: revalidate the exact accepted run immediately before admin RPC.
    card = await readOwnedCard()
    if (card.status !== "running" || card.execution?.status !== "running") return { status: "pending" }
    const raw = await call(
      "sessions.abort",
      { json: true, timeout: "30000" },
      { key: input.sessionKey, agentId: input.agentId, runId: input.runId },
      { scopes: ["operator.admin"], progress: false }
    )
    const result = raw as { ok?: boolean; status?: string; abortedRunId?: string | null }
    if (
      result?.ok !== true ||
      !["aborted", "no-active-run"].includes(result.status ?? "") ||
      (result.abortedRunId != null && result.abortedRunId !== input.runId)
    )
      throw new Error("Investigation cancellation was not acknowledged")
    card = await readOwnedCard()
    return { status: (await sessionTerminal(card)) ? "terminal" : "pending" }
  }
  version(): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(this.command, ["--version"], { timeout: 10_000, maxBuffer: 4096 }, (error, stdout) => {
        if (error) return reject(new Error("Native CLI version unavailable"))
        const version = stdout.trim().match(/(?:^|\s)(\d{4}\.\d+\.\d+(?:-[\w.]+)?)(?:$|\s)/)?.[1]
        if (!version) return reject(new Error("Native CLI version contract unavailable"))
        resolve(version)
      })
    })
  }
  request<T = any>(method: string, params: Record<string, unknown>): Promise<T> {
    const timeout =
      method === "autocode.reconcile"
        ? 7_200_000
        : ["autocode.policy.refresh.apply", "autocode.discover", "autocode.dispatch", "autocode.doctor"].includes(
              method
            )
          ? 180_000
          : 30_000
    return new Promise((resolve, reject) => {
      execFile(
        this.command,
        ["gateway", "call", method, "--json", "--timeout", String(timeout), "--params", JSON.stringify(params)],
        { timeout: timeout + 10_000, maxBuffer: 16 * 1024 * 1024 },
        (error, stdout, stderr) => {
          let payload: any
          try {
            payload = JSON.parse(stdout)
          } catch {
            /* A failed CLI may not emit JSON. */
          }
          const remoteError = typeof payload?.error?.message === "string" ? payload.error.message : undefined
          if (error || (payload?.ok === false && remoteError)) {
            // execFile's message contains the complete command, including private
            // proposal arguments. Preserve the CLI's structured error instead.
            const detail =
              remoteError ||
              stderr.trim().slice(0, 2000) ||
              `CLI exited with ${error?.code ?? error?.signal ?? "an error"}`
            return reject(new Error(`Native RPC ${method} failed: ${detail}`))
          }
          try {
            resolve(JSON.parse(stdout) as T)
          } catch {
            reject(new Error(`Native RPC ${method} returned invalid JSON`))
          }
        }
      )
    })
  }
}
export interface NativeCard {
  id: string
  boardId?: string
  title: string
  status: string
  agentId?: string
  sessionKey?: string
  runId?: string
  startedAt?: number
  updatedAt?: number
  execution?: { sessionKey?: string; runId?: string; status?: string; startedAt?: number }
  metadata?: {
    claim?: { ownerId?: string; expiresAt?: number }
    links?: Array<{ type: string; targetCardId?: string }>
    automation?: { idempotencyKey?: string; scheduledAt?: number; workspace?: { path?: string } }
  }
}
/** Versioned subset consumed by this runtime. Unknown statuses fail closed until reviewed. */
export const NATIVE_GATEWAY_CONTRACT_VERSION = 1
export const NATIVE_CARD_STATUSES = [
  "todo",
  "ready",
  "running",
  "review",
  "blocked",
  "scheduled",
  "done",
  "cancelled"
] as const
export function nativeObject(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} contract: expected object`)
  return value as Record<string, any>
}
export function decodeNativeCard(value: unknown, boardId?: string): NativeCard {
  const card = nativeObject(value, "Workboard card")
  for (const key of ["id", "title", "status"])
    if (typeof card[key] !== "string" || !card[key]) throw new Error(`Workboard card contract: invalid ${key}`)
  if (!NATIVE_CARD_STATUSES.includes(card.status)) throw new Error("Workboard card contract: unsupported status")
  if (
    card.boardId !== undefined &&
    (typeof card.boardId !== "string" || !card.boardId || (boardId && card.boardId !== boardId))
  )
    throw new Error("Workboard card contract: wrong board identity")
  for (const record of [card, ...(card.execution ? [nativeObject(card.execution, "Workboard execution")] : [])]) {
    for (const key of ["agentId", "sessionKey", "runId"])
      if (record[key] != null && (typeof record[key] !== "string" || !record[key]))
        throw new Error(`Workboard card contract: invalid ${key}`)
    for (const key of ["startedAt", "updatedAt"])
      if (record[key] != null && (!Number.isFinite(record[key]) || record[key] < 0))
        throw new Error(`Workboard card contract: invalid ${key}`)
  }
  if (
    card.execution?.status != null &&
    ![
      "idle",
      "pending",
      "running",
      "review",
      "completed",
      "done",
      "failed",
      "cancelled",
      "timed_out",
      "timeout",
      "blocked"
    ].includes(card.execution.status)
  )
    throw new Error("Workboard execution contract: unsupported status")
  if (card.metadata != null) {
    const metadata = nativeObject(card.metadata, "Workboard metadata")
    if (metadata.automation != null) {
      const automation = nativeObject(metadata.automation, "Workboard automation")
      if (automation.workspace != null) {
        const workspace = nativeObject(automation.workspace, "Workboard workspace")
        if (workspace.path != null && typeof workspace.path !== "string")
          throw new Error("Workboard workspace contract: invalid path")
      }
    }
  }
  return card as NativeCard
}
export async function nativeCards(gateway: NativeGateway, boardId: string): Promise<NativeCard[]> {
  if (typeof boardId !== "string" || !boardId.trim()) throw new Error("Workboard contract: board identity required")
  const result = nativeObject(await gateway.request("workboard.cards.list", { boardId }), "Workboard cards.list")
  if (!Array.isArray(result.cards)) throw new Error("Workboard cards.list contract unavailable")
  // This supported list contract returns all cards. Never silently accept a partial future response.
  if (result.hasMore === true || result.nextCursor != null)
    throw new Error("Workboard cards.list contract: unsupported partial listing")
  const cards = result.cards.map((card: unknown) => decodeNativeCard(card, boardId))
  if (new Set(cards.map((card) => card.id)).size !== cards.length)
    throw new Error("Workboard cards.list contract: duplicate identity")
  return cards
}
export async function nativeCard(gateway: NativeGateway, input: Record<string, unknown>): Promise<NativeCard> {
  const result = nativeObject(await gateway.request("workboard.cards.create", input), "Workboard cards.create")
  return decodeNativeCard(result.card, typeof input.boardId === "string" ? input.boardId : undefined)
}
