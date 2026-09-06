import { existsSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import type { AdapterExecutionContext, AdapterExecutionResult, AdapterFailureCategory } from "@openclaw/domain"
import {
  buildOutputPath as buildManagedOutputPath,
  commandExists as commandExistsOnPath,
  executeCommand,
  executeCommandAsync
} from "@openclaw/os-adapters"

export type PreparedAcpxInvocation = {
  argv: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  stdin?: string
  outputPath?: string | null
  sessionCwd: string
  repoPath: string
}

export type AcpxFailurePatterns = {
  auth?: RegExp[]
  quota?: RegExp[]
  modelNotFound?: RegExp[]
  sessionCorruption?: RegExp[]
}

type BuildAcpxEnvOptions = {
  blockedKeys?: readonly string[]
  preserveBlockedKeysEnvVar?: string
  extraEnv?: NodeJS.ProcessEnv
  sessionCwd: string
}

type RunAcpxInvocationOptions = {
  commandLabel: string
  timeoutMs: number
  idleTimeoutMs?: number | undefined
  parseOutput: (stdout: string, stderr: string, fallbackResponse: string | null) => AdapterExecutionResult
  failurePatterns?: AcpxFailurePatterns
  maxBufferBytes?: number
}

const DEFAULT_MAX_BUFFER_BYTES = 1024 * 1024 * 10
const MAX_FAILURE_OUTPUT_CHARS = 16_384
const SESSION_CWD_ENV_KEYS = ["OPENCLAW_SESSION_CWD", "OPENCLAW_ACPX_CWD"] as const
const AUTH_FAILURE_PATTERNS = [
  /\bauth(?:entication)?\b.*\b(failed|required|expired|invalid)\b/i,
  /\blog(?:ged)?\s*in\b.*\brequired\b/i,
  /\bplease log(?:\s|-)?in\b/i,
  /\bunauthori[sz]ed\b/i,
  /\bforbidden\b/i,
  /\binvalid (?:api key|credentials|token)\b/i,
  /\bcredential(?:s)?\b.*\b(missing|expired|invalid|required)\b/i,
  /\boauth\b.*\b(failed|expired|invalid|required)\b/i
] as const
const QUOTA_FAILURE_PATTERNS = [
  /\brate[\s-]?limit\b/i,
  /\btoo many requests\b/i,
  /\b429\b/,
  /\busage limit\b/i,
  /\bout of credits\b/i,
  /\bcredits?\s+(?:exhausted|depleted)\b/i,
  /\bquota\b/i,
  /\btokens? (?:exceeded|exhausted)\b/i,
  /\blimit reached\b/i,
  /\bresource exhausted\b/i
] as const
const MODEL_NOT_FOUND_PATTERNS = [
  /\bmodel\b.*\bnot found\b/i,
  /\bunknown model\b/i,
  /\binvalid model\b/i,
  /\bunsupported model\b/i,
  /\bno such model\b/i,
  /\bmodel alias\b.*\binvalid\b/i
] as const
const SESSION_CORRUPTION_PATTERNS = [
  /\bsession\b.*\b(corrupt|corrupted|invalid|missing|not found|expired)\b/i,
  /\bresume\b.*\b(failed|invalid|missing|not found)\b/i,
  /\bcheckpoint\b.*\b(corrupt|invalid|missing|not found)\b/i,
  /\bconversation\b.*\b(corrupt|invalid|missing|not found)\b/i,
  /\bstate\b.*\b(corrupt|invalid)\b/i
] as const

export function runtimeIdentityEnv(context: AdapterExecutionContext): NodeJS.ProcessEnv {
  return {
    OPENCLAW_RUNTIME_IDENTITY_JSON: JSON.stringify(context.runtimeIdentity),
    OPENCLAW_RUNTIME_KEY: context.runtimeIdentity.runtimeKey,
    OPENCLAW_EXECUTION_KEY: context.runtimeIdentity.executionKey,
    OPENCLAW_WAKE_REASON: context.runtimeIdentity.wake.reason,
    OPENCLAW_SESSION_KEY: context.runtimeIdentity.continuation.sessionKey
  }
}

export function commandExists(command: string): boolean {
  return commandExistsOnPath(command)
}

export function scrubEnv(
  env: NodeJS.ProcessEnv,
  blockedKeys: readonly string[],
  preserveBlockedKeysEnvVar?: string
): NodeJS.ProcessEnv {
  if (preserveBlockedKeysEnvVar && env[preserveBlockedKeysEnvVar] === "1") {
    return { ...env }
  }

  const next: NodeJS.ProcessEnv = { ...env }
  for (const key of blockedKeys) {
    delete next[key]
  }
  return next
}

function sessionCwdOverride(context: AdapterExecutionContext): string | null {
  for (const key of SESSION_CWD_ENV_KEYS) {
    const candidate = context.agent.env[key]
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim()
    }
  }

  const ambientCandidate = process.env.OPENCLAW_ACPX_CWD
  if (typeof ambientCandidate === "string" && ambientCandidate.trim()) {
    return ambientCandidate.trim()
  }

  return null
}

export function resolveSessionCwd(context: AdapterExecutionContext): string {
  const override = sessionCwdOverride(context)
  if (!override) return context.project.repoPath

  const resolved = isAbsolute(override) ? resolve(override) : resolve(context.project.repoPath, override)
  if (!existsSync(resolved)) {
    throw new Error(`Configured ACPX session cwd does not exist: ${resolved}`)
  }

  const stat = statSync(resolved)
  if (!stat.isDirectory()) {
    throw new Error(`Configured ACPX session cwd is not a directory: ${resolved}`)
  }

  return resolved
}

export function buildAcpxEnv(context: AdapterExecutionContext, options: BuildAcpxEnvOptions): NodeJS.ProcessEnv {
  const baseEnv = {
    ...process.env,
    ...context.agent.env,
    ...runtimeIdentityEnv(context),
    OPENCLAW_ACPX_TRANSPORT: "1",
    OPENCLAW_ACPX_REPO_ROOT: context.project.repoPath,
    OPENCLAW_ACPX_SESSION_CWD: options.sessionCwd,
    OPENCLAW_REPO_ROOT: context.project.repoPath,
    OPENCLAW_SESSION_CWD: options.sessionCwd,
    ...options.extraEnv
  }

  if (!options.blockedKeys || options.blockedKeys.length === 0) {
    return baseEnv
  }

  return scrubEnv(baseEnv, options.blockedKeys, options.preserveBlockedKeysEnvVar)
}

export function classifyFailureCategory(input: {
  error?: Error | null
  stdout?: string
  stderr?: string
  signal?: NodeJS.Signals | null
  failurePatterns?: AcpxFailurePatterns
}): AdapterFailureCategory {
  const stdout = input.stdout ?? ""
  const stderr = input.stderr ?? ""
  const errorMessage = input.error?.message ?? ""
  const errorCode = (input.error as (Error & { code?: string }) | null | undefined)?.code
  const combined = [errorMessage, stderr, stdout].filter(Boolean).join("\n")

  if (
    input.error?.name === "TimeoutError" ||
    errorCode === "ETIMEDOUT" ||
    /\b(?:timed out|timeout)\b/i.test(combined)
  ) {
    return "timeout"
  }

  const sessionPatterns = [...SESSION_CORRUPTION_PATTERNS, ...(input.failurePatterns?.sessionCorruption ?? [])]
  if (sessionPatterns.some((pattern) => pattern.test(combined))) {
    return "session-corruption"
  }

  const modelPatterns = [...MODEL_NOT_FOUND_PATTERNS, ...(input.failurePatterns?.modelNotFound ?? [])]
  if (modelPatterns.some((pattern) => pattern.test(combined))) {
    return "model-not-found"
  }

  const authPatterns = [...AUTH_FAILURE_PATTERNS, ...(input.failurePatterns?.auth ?? [])]
  if (authPatterns.some((pattern) => pattern.test(combined))) {
    return "auth"
  }

  const quotaPatterns = [...QUOTA_FAILURE_PATTERNS, ...(input.failurePatterns?.quota ?? [])]
  if (quotaPatterns.some((pattern) => pattern.test(combined))) {
    return "quota"
  }

  return "transport"
}

export function withFailureCategory(
  result: AdapterExecutionResult,
  category: AdapterFailureCategory,
  error: string
): AdapterExecutionResult {
  return {
    ...result,
    ok: false,
    error,
    failureCategory: category
  }
}

export function compactAcpxFailureOutput(output: string, maxChars = MAX_FAILURE_OUTPUT_CHARS): string {
  const normalized = output.trim()
  if (!normalized || normalized.length <= maxChars) return normalized

  const omittedChars = normalized.length - maxChars
  return `[... ${omittedChars} characters omitted ...]\n${normalized.slice(-maxChars)}`
}

export function buildOutputPath(prefix: string, taskId: string): string {
  return buildManagedOutputPath(prefix, taskId)
}

export function runPreparedAcpxInvocation(
  context: AdapterExecutionContext,
  prepared: PreparedAcpxInvocation,
  options: RunAcpxInvocationOptions
): AdapterExecutionResult {
  const command = prepared.argv[0]!
  const argv = prepared.argv.slice(1)
  const startedAt = Date.now()

  context.log("info", `Launching ${options.commandLabel}`, {
    command,
    argv,
    model: context.agent.model,
    cwd: prepared.cwd,
    repoPath: prepared.repoPath,
    sessionCwd: prepared.sessionCwd,
    timeoutMs: options.timeoutMs,
    idleTimeoutMs: options.idleTimeoutMs ?? null,
    transport: "acpx"
  })

  const result = executeCommand(command, argv, {
    cwd: prepared.cwd,
    env: prepared.env,
    input: prepared.stdin,
    timeoutMs: options.timeoutMs,
    idleTimeoutMs: options.idleTimeoutMs,
    maxBufferBytes: options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES,
    outputPath: prepared.outputPath,
    terminateProcessGroup: true
  })

  return normalizeAcpxResult(context, result, options, Math.max(0, Date.now() - startedAt))
}

function normalizeAcpxResult(
  context: AdapterExecutionContext,
  result: ReturnType<typeof executeCommand>,
  options: RunAcpxInvocationOptions,
  latencyMs: number
): AdapterExecutionResult {
  const stdout = result.stdout
  const stderr = result.stderr
  const fallbackResponse = result.fallbackResponse
  if (stdout.trim()) {
    context.log("info", `${options.commandLabel} stdout captured`, { bytes: stdout.length })
  }
  if (stderr.trim()) {
    context.log("warn", `${options.commandLabel} stderr captured`, { bytes: stderr.length })
  }
  context.log(
    result.exitCode === 0 && !result.error && !result.signal ? "info" : "warn",
    `${options.commandLabel} invocation completed`,
    {
      latencyMs,
      exitStatus: result.exitCode,
      signal: result.signal ?? null,
      stdoutBytes: stdout.length,
      stderrBytes: stderr.length,
      outputTruncated: result.outputTruncated,
      truncationReason: result.truncationReason
    }
  )

  const parsed = options.parseOutput(stdout, stderr, fallbackResponse)
  parsed.stdout = stdout
  parsed.stderr = stderr
  if (parsed.usage) {
    context.log("info", `${options.commandLabel} usage captured`, {
      usage: parsed.usage,
      latencyMs
    })
  }

  if (result.timedOut) {
    const timeoutError = new Error(`ETIMEDOUT: ${options.commandLabel} execution timed out`)
    timeoutError.name = "TimeoutError"
    const failureInput: Parameters<typeof classifyFailureCategory>[0] = { error: timeoutError, stdout, stderr }
    if (result.signal) failureInput.signal = result.signal
    if (options.failurePatterns) failureInput.failurePatterns = options.failurePatterns
    const category = classifyFailureCategory(failureInput)
    return withFailureCategory(parsed, category, `${options.commandLabel} execution failed: ${timeoutError.message}`)
  }

  if (result.error) {
    const failureInput: Parameters<typeof classifyFailureCategory>[0] = { error: result.error, stdout, stderr }
    if (result.signal) failureInput.signal = result.signal
    if (options.failurePatterns) failureInput.failurePatterns = options.failurePatterns
    const category = classifyFailureCategory(failureInput)
    return withFailureCategory(parsed, category, `${options.commandLabel} execution failed: ${result.error.message}`)
  }

  if (result.signal) {
    const failureInput: Parameters<typeof classifyFailureCategory>[0] = { stdout, stderr, signal: result.signal }
    if (options.failurePatterns) failureInput.failurePatterns = options.failurePatterns
    const category = classifyFailureCategory(failureInput)
    return withFailureCategory(
      parsed,
      category,
      compactAcpxFailureOutput(stderr) || `${options.commandLabel} terminated by signal ${result.signal}`
    )
  }

  if (result.exitCode !== 0) {
    const failureInput: Parameters<typeof classifyFailureCategory>[0] = { stdout, stderr }
    if (result.signal) failureInput.signal = result.signal
    if (options.failurePatterns) failureInput.failurePatterns = options.failurePatterns
    const category = classifyFailureCategory(failureInput)
    return withFailureCategory(
      parsed,
      category,
      compactAcpxFailureOutput(stderr) ||
        compactAcpxFailureOutput(stdout) ||
        `${options.commandLabel} exited with status ${result.exitCode ?? "unknown"}`
    )
  }

  return parsed
}

export async function runPreparedAcpxInvocationAsync(
  context: AdapterExecutionContext,
  prepared: PreparedAcpxInvocation,
  options: RunAcpxInvocationOptions
): Promise<AdapterExecutionResult> {
  const command = prepared.argv[0]!
  const argv = prepared.argv.slice(1)
  const startedAt = Date.now()

  context.log("info", `Launching ${options.commandLabel}`, {
    command,
    argv,
    model: context.agent.model,
    cwd: prepared.cwd,
    repoPath: prepared.repoPath,
    sessionCwd: prepared.sessionCwd,
    timeoutMs: options.timeoutMs,
    idleTimeoutMs: options.idleTimeoutMs ?? null,
    transport: "acpx"
  })

  const result = await executeCommandAsync(command, argv, {
    cwd: prepared.cwd,
    env: prepared.env,
    input: prepared.stdin,
    timeoutMs: options.timeoutMs,
    idleTimeoutMs: options.idleTimeoutMs,
    maxBufferBytes: options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES,
    outputPath: prepared.outputPath,
    terminateProcessGroup: true
  })

  return normalizeAcpxResult(context, result, options, Math.max(0, Date.now() - startedAt))
}

export function discoverCodexAccountSwitcher(repoPath: string, explicitPath?: string | null): string | null {
  const frameworkDir = process.env.OPENCLAW_DISPATCHER_FRAMEWORK_DIR
  const openclawHome = process.env.OPENCLAW_HOME
  const candidates = [
    explicitPath,
    join(repoPath, "skills", "codex-account-switcher", "scripts", "codex-accounts.py"),
    frameworkDir ? join(frameworkDir, "skills", "codex-account-switcher", "scripts", "codex-accounts.py") : null,
    openclawHome
      ? join(openclawHome, "workspace", "skills", "codex-account-switcher", "scripts", "codex-accounts.py")
      : null,
    join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
      "skills",
      "codex-account-switcher",
      "scripts",
      "codex-accounts.py"
    ),
    join(homedir(), ".openclaw", "workspace", "skills", "codex-account-switcher", "scripts", "codex-accounts.py"),
    join(homedir(), ".codex", "skills", "codex-account-switcher", "scripts", "codex-accounts.py"),
    commandExists("codex-auth") ? "codex-auth" : null
  ]

  for (const candidate of candidates) {
    if (candidate && (existsSync(candidate) || (!isAbsolute(candidate) && commandExists(candidate)))) {
      return candidate
    }
  }

  return null
}
