export type DiagnosticsSectionKind = "system" | "session" | "config" | "logs" | "state" | "artifacts"

export interface DiagnosticsSection {
  kind: DiagnosticsSectionKind
  title: string
  paths: string[]
  sensitive: boolean
  reason: string
}

export interface DiagnosticsManifestInput {
  generatedAt?: string | undefined
  sessionId?: string | null | undefined
  projectId?: string | null | undefined
  projectName?: string | null | undefined
  taskId?: string | null | undefined
  runId?: string | null | undefined
  runtimeVersion?: string | null | undefined
  extraPaths?: string[] | undefined
}

export interface DiagnosticsManifest {
  version: 1
  bundleName: string
  generatedAt: string
  runtimeVersion: string | null
  context: {
    sessionId: string | null
    projectId: string | null
    projectName: string | null
    taskId: string | null
    runId: string | null
  }
  sections: DiagnosticsSection[]
  privacyNotice: string
}

function safeName(value: string | null | undefined): string {
  const normalized = (value ?? "openclaw")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return normalized || "openclaw"
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const trimmed = value.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    result.push(trimmed)
  }
  return result
}

export function createDiagnosticsManifest(input: DiagnosticsManifestInput = {}): DiagnosticsManifest {
  const generatedAt = input.generatedAt ?? new Date().toISOString()
  const bundleName = `diagnostics_${safeName(input.sessionId ?? input.runId ?? input.taskId)}_${generatedAt.slice(0, 10)}.zip`
  const scopedStatePaths = uniqueStrings([
    ".openclaw/dispatcher.db",
    input.taskId ? `.openclaw/tasks/${input.taskId}` : "",
    input.runId ? `.openclaw/runs/${input.runId}` : "",
    ...(input.extraPaths ?? [])
  ])

  return {
    version: 1,
    bundleName,
    generatedAt,
    runtimeVersion: input.runtimeVersion ?? null,
    context: {
      sessionId: input.sessionId ?? null,
      projectId: input.projectId ?? null,
      projectName: input.projectName ?? null,
      taskId: input.taskId ?? null,
      runId: input.runId ?? null
    },
    sections: [
      {
        kind: "system",
        title: "System information",
        paths: ["package.json", "pnpm-lock.yaml", "tsconfig.build.json"],
        sensitive: false,
        reason: "Runtime version, package graph, and build settings help reproduce environment issues."
      },
      {
        kind: "session",
        title: "Session transcript and run metadata",
        paths: uniqueStrings([
          input.sessionId ? `.openclaw/sessions/${input.sessionId}` : "",
          input.runId ? `.openclaw/runs/${input.runId}` : ""
        ]),
        sensitive: true,
        reason: "Session data can include prompts, responses, task context, and repository excerpts."
      },
      {
        kind: "config",
        title: "OpenClaw configuration",
        paths: [".openclaw/profile.json", ".openclaw/policy.json", ".openclaw/jobs"],
        sensitive: true,
        reason: "Configuration may include adapter names, internal paths, and policy details."
      },
      {
        kind: "logs",
        title: "Recent runtime logs",
        paths: [".openclaw/logs"],
        sensitive: true,
        reason: "Logs are necessary for debugging but can contain command output and error details."
      },
      {
        kind: "state",
        title: "Scoped runtime state",
        paths: scopedStatePaths,
        sensitive: true,
        reason: "State explains scheduler decisions, locks, and claims around the failing task or run."
      }
    ],
    privacyNotice:
      "Review diagnostics before sharing. Bundles may contain prompts, repository excerpts, paths, logs, task state, and configuration values."
  }
}

export function diagnosticsSensitivePaths(manifest: DiagnosticsManifest): string[] {
  return uniqueStrings(manifest.sections.filter((section) => section.sensitive).flatMap((section) => section.paths))
}
