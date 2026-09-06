export type OpenClawStateBackendMode = "workspace" | "detached-git" | "two-layer"

export type OpenClawStateFileKind = "runtime" | "bootstrap" | "shared"

export interface OpenClawStateBackendConfig {
  mode?: string | null | undefined
  rootDir?: string | null | undefined
  runtimeDir?: string | null | undefined
  bootstrapDir?: string | null | undefined
  branch?: string | null | undefined
  remote?: string | null | undefined
  syncHooks?: boolean | null | undefined
}

export interface OpenClawStateBackendDefinition {
  mode: OpenClawStateBackendMode
  rootDir: string
  runtimeDir: string
  bootstrapDir: string
  branch: string | null
  remote: string | null
  syncHooks: boolean
}

export interface OpenClawStatePath {
  key: string
  kind: OpenClawStateFileKind
  path: string
  persistent: boolean
}

export interface OpenClawStateSyncPlan {
  backend: OpenClawStateBackendDefinition
  description: string
  operatorCommands: string[]
  hookCommands: {
    preCommit: string[]
    postMerge: string[]
  }
}

const DEFAULT_ROOT_DIR = ".openclaw/state"
const DEFAULT_RUNTIME_DIR = "current"
const DEFAULT_BOOTSTRAP_DIR = "bootstrap"
const DEFAULT_DETACHED_BRANCH = "openclaw/state"
const DEFAULT_REMOTE = "origin"

const LEGACY_MODE_ALIASES: Record<string, OpenClawStateBackendMode> = {
  local: "workspace",
  worktree: "workspace",
  filesystem: "workspace",
  orphan: "detached-git",
  "git-orphan": "detached-git",
  "git-notes": "two-layer",
  twolayer: "two-layer",
  layered: "two-layer"
}

function normalizedString(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function cleanRelativePath(value: string | null | undefined, fallback: string): string {
  const cleaned = (normalizedString(value) ?? fallback).replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/g, "")
  return cleaned.length > 0 ? cleaned : fallback
}

function cleanGitToken(value: string | null | undefined, fallback: string): string {
  const token = normalizedString(value) ?? fallback
  return /^[A-Za-z0-9._/@-]+$/.test(token) ? token : fallback
}

function joinPath(...parts: string[]): string {
  return parts
    .map((part) => part.replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/")
}

export function normalizeOpenClawStateBackend(config: OpenClawStateBackendConfig = {}): OpenClawStateBackendDefinition {
  const rawMode = (normalizedString(config.mode) ?? "workspace").toLowerCase()
  const mode = (LEGACY_MODE_ALIASES[rawMode] ?? rawMode) as OpenClawStateBackendMode
  const supportedMode: OpenClawStateBackendMode =
    mode === "detached-git" || mode === "two-layer" || mode === "workspace" ? mode : "workspace"

  return {
    mode: supportedMode,
    rootDir: cleanRelativePath(config.rootDir, DEFAULT_ROOT_DIR),
    runtimeDir: cleanRelativePath(config.runtimeDir, DEFAULT_RUNTIME_DIR),
    bootstrapDir: cleanRelativePath(config.bootstrapDir, DEFAULT_BOOTSTRAP_DIR),
    branch: supportedMode === "workspace" ? null : cleanGitToken(config.branch, DEFAULT_DETACHED_BRANCH),
    remote: supportedMode === "workspace" ? null : cleanGitToken(config.remote, DEFAULT_REMOTE),
    syncHooks: Boolean(config.syncHooks)
  }
}

export function openClawStatePath(
  backend: OpenClawStateBackendDefinition,
  key: string,
  kind: OpenClawStateFileKind = "runtime"
): OpenClawStatePath {
  const safeKey = cleanRelativePath(key, "runtime.json")
  const baseDir =
    kind === "bootstrap"
      ? joinPath(backend.rootDir, backend.bootstrapDir)
      : kind === "runtime"
        ? joinPath(backend.rootDir, backend.runtimeDir)
        : backend.rootDir

  return {
    key: safeKey,
    kind,
    path: joinPath(baseDir, safeKey),
    persistent: backend.mode !== "workspace" || kind === "bootstrap" || kind === "shared"
  }
}

export function planOpenClawStateSync(config: OpenClawStateBackendConfig = {}): OpenClawStateSyncPlan {
  const backend = normalizeOpenClawStateBackend(config)
  if (backend.mode === "workspace") {
    return {
      backend,
      description: "Store OpenCLAW runtime state directly under the target workspace.",
      operatorCommands: [],
      hookCommands: { preCommit: [], postMerge: [] }
    }
  }

  const branch = backend.branch ?? DEFAULT_DETACHED_BRANCH
  const remote = backend.remote ?? DEFAULT_REMOTE
  const syncCommand = `git fetch ${remote} ${branch} && git read-tree --prefix=${backend.rootDir}/ ${remote}/${branch}`
  const pushCommand = `git subtree split --prefix=${backend.rootDir} -b ${branch} && git push ${remote} ${branch}`
  const hookCommands = backend.syncHooks
    ? {
        preCommit: [pushCommand],
        postMerge: [syncCommand]
      }
    : { preCommit: [], postMerge: [] }

  return {
    backend,
    description:
      backend.mode === "two-layer"
        ? "Keep bootstrap state in the workspace while syncing live runtime state through a detached Git branch."
        : "Sync all OpenCLAW state through a detached Git branch without making runtime churn part of normal code commits.",
    operatorCommands: [syncCommand, pushCommand],
    hookCommands
  }
}
