export type WorkspaceCommandKind = "command" | "service" | "job"
export type WorkspaceCommandSourceKey = "commands" | "services" | "jobs"

export interface WorkspaceCommandDefinition {
  id: string
  name: string
  kind: WorkspaceCommandKind
  command: string | null
  cwd: string | null
  lifecycle: "shared" | "ephemeral" | null
  disabledReason: string | null
  source: {
    key: WorkspaceCommandSourceKey
    index: number
  }
  rawConfig: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function slug(value: string | null | undefined): string | null {
  const normalized = (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return normalized.length > 0 ? normalized : null
}

function uniqueId(seen: Set<string>, id: string, source: WorkspaceCommandSourceKey, index: number): string {
  if (!seen.has(id)) {
    seen.add(id)
    return id
  }
  const fallback = `${id}-${source}-${index + 1}`
  seen.add(fallback)
  return fallback
}

function entries(
  config: Record<string, unknown> | null | undefined,
  key: WorkspaceCommandSourceKey
): Record<string, unknown>[] {
  const value = config?.[key]
  return Array.isArray(value) ? value.filter(isRecord) : []
}

function commandKind(entry: Record<string, unknown>, source: WorkspaceCommandSourceKey): WorkspaceCommandKind {
  const explicit = readString(entry.kind)
  if (explicit === "service" || explicit === "job" || explicit === "command") return explicit
  if (source === "services") return "service"
  if (source === "jobs") return "job"
  return "command"
}

function buildCommand(
  entry: Record<string, unknown>,
  source: WorkspaceCommandSourceKey,
  index: number
): WorkspaceCommandDefinition {
  const kind = commandKind(entry, source)
  const fallbackName =
    kind === "service" ? `Service ${index + 1}` : kind === "job" ? `Job ${index + 1}` : `Command ${index + 1}`
  const name = readString(entry.name) ?? readString(entry.label) ?? readString(entry.title) ?? fallbackName
  const id = slug(readString(entry.id)) ?? `${kind}:${slug(name) ?? index + 1}`

  return {
    id,
    name,
    kind,
    command: readString(entry.command),
    cwd: readString(entry.cwd),
    lifecycle: kind === "service" ? (entry.lifecycle === "ephemeral" ? "ephemeral" : "shared") : null,
    disabledReason: readString(entry.disabledReason),
    source: { key: source, index },
    rawConfig: { ...entry }
  }
}

export function listWorkspaceCommandDefinitions(
  config: Record<string, unknown> | null | undefined
): WorkspaceCommandDefinition[] {
  if (!config) return []
  const seen = new Set<string>()
  const commands = [
    ...entries(config, "commands").map((entry, index) => buildCommand(entry, "commands", index)),
    ...entries(config, "services").map((entry, index) => buildCommand(entry, "services", index)),
    ...entries(config, "jobs").map((entry, index) => buildCommand(entry, "jobs", index))
  ]

  return commands.map((command) => ({
    ...command,
    id: uniqueId(seen, command.id, command.source.key, command.source.index)
  }))
}

export function findWorkspaceCommandDefinition(
  config: Record<string, unknown> | null | undefined,
  id: string | null | undefined
): WorkspaceCommandDefinition | null {
  const requested = readString(id)
  if (!requested) return null
  const requestedSlug = slug(requested)
  return (
    listWorkspaceCommandDefinitions(config).find(
      (command) => command.id === requested || (requestedSlug != null && slug(command.id) === requestedSlug)
    ) ?? null
  )
}

export function listWorkspaceServiceDefinitions(
  config: Record<string, unknown> | null | undefined
): WorkspaceCommandDefinition[] {
  return listWorkspaceCommandDefinitions(config).filter((command) => command.kind === "service")
}
