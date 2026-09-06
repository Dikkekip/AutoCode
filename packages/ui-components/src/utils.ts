export function toIsoString(value: Date | string | undefined | null): string | undefined {
  if (!value) return undefined
  return typeof value === "string" ? value : value.toISOString()
}

export function formatTimeLabel(value: string | undefined): string {
  if (!value) return ""
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat("en", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(date)
}

export function relativeTime(value: string | undefined): string | undefined {
  if (!value) return undefined
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return undefined
  const diffMs = Date.now() - date.getTime()
  const absMs = Math.abs(diffMs)
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour

  const format = (amount: number, unit: Intl.RelativeTimeFormatUnit) =>
    new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(amount, unit)

  if (absMs < minute) return format(Math.round(diffMs / 1000), "second")
  if (absMs < hour) return format(Math.round(diffMs / minute), "minute")
  if (absMs < day) return format(Math.round(diffMs / hour), "hour")
  return format(Math.round(diffMs / day), "day")
}

export function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

export function truncate(value: string, max = 120): string {
  if (value.length <= max) return value
  return `${value.slice(0, Math.max(0, max - 3))}...`
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

export function formatUnknown(value: unknown): string {
  if (typeof value === "string") return value
  if (value === undefined || value === null) return ""
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export function summarizeToolInput(input: unknown): string | undefined {
  if (typeof input === "string") {
    const summary = truncate(compactWhitespace(input), 80)
    return summary || undefined
  }

  const record = asRecord(input)
  if (!record) {
    const serialized = truncate(compactWhitespace(formatUnknown(input)), 80)
    return serialized || undefined
  }

  const candidates = [
    record.command,
    record.cmd,
    record.path,
    record.filePath,
    record.file_path,
    record.query,
    record.prompt,
    record.message,
    record.url
  ]

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return truncate(compactWhitespace(candidate), 80)
    }
  }

  const keys = Object.keys(record)
  if (keys.length === 0) return undefined
  return truncate(`payload: ${keys.slice(0, 3).join(", ")}`, 80)
}

export function toneForStatus(status: string | undefined) {
  switch (status) {
    case "completed":
    case "idle":
    case "succeeded":
      return "success" as const
    case "error":
    case "failed":
      return "error" as const
    case "running":
    case "streaming":
    case "queued":
    case "working":
      return "info" as const
    default:
      return "neutral" as const
  }
}
