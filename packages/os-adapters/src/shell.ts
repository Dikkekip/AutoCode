import { type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns, spawn, spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"

export const OUTPUT_LIMIT_LINES = 2000
export const OUTPUT_LIMIT_BYTES = 50_000
const OUTPUT_PREVIEW_LINES = 50

export interface ProcessExecutionOptions {
  cwd?: string | undefined
  env?: NodeJS.ProcessEnv | undefined
  input?: string | undefined
  abortSignal?: AbortSignal | undefined
  terminateOnOutputLimit?: boolean | undefined
  timeoutMs?: number | undefined
  idleTimeoutMs?: number | undefined
  timeoutKillGraceMs?: number | undefined
  maxBufferBytes?: number | undefined
  outputPath?: string | null | undefined
  encoding?: BufferEncoding | undefined
  truncateOutput?: boolean | undefined
  terminateProcessGroup?: boolean | undefined
}

export interface ProcessExecutionResult {
  ok: boolean
  stdout: string
  stderr: string
  interleaved: string
  fallbackResponse: string | null
  exitCode: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  error: Error | null
  outputTruncated: boolean
  truncationReason: string | null
}

export interface ShellExecutionOptions extends ProcessExecutionOptions {
  shell?: string
  preferLoginPath?: boolean
}

function trailingUtf8Bytes(value: string, maxBytes: number): string {
  const encoded = Buffer.from(value, "utf8")
  if (encoded.length <= maxBytes) return value
  let start = encoded.length - maxBytes
  while (start < encoded.length && (encoded[start]! & 0xc0) === 0x80) start += 1
  return encoded.subarray(start).toString("utf8")
}

export function isFlatpak(): boolean {
  return process.platform !== "win32" && existsSync("/.flatpak-info")
}

const KNOWN_POSIX_SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh"])

function configuredPosixShell(value: string | undefined): string | null {
  const candidate = value?.trim()
  if (!candidate) return null
  if (candidate.includes("/") || candidate.includes("\\")) {
    return existsSync(candidate) ? candidate : null
  }
  return KNOWN_POSIX_SHELLS.has(candidate) ? candidate : null
}

export function preferredShell(): string {
  if (process.platform === "win32") {
    return process.env.OPENCLAW_SHELL?.trim() || process.env.GOOSE_SHELL?.trim() || process.env.ComSpec?.trim() || "cmd"
  }

  return (
    configuredPosixShell(process.env.OPENCLAW_SHELL) ||
    configuredPosixShell(process.env.GOOSE_SHELL) ||
    (existsSync("/bin/bash") ? "/bin/bash" : "") ||
    configuredPosixShell(process.env.SHELL) ||
    "sh"
  )
}

export function preferredPosixShell(candidates: readonly string[] = ["zsh", "bash", "sh"]): string {
  for (const candidate of candidates) {
    if (commandExists(candidate)) {
      return candidate
    }
  }
  return "sh"
}

export function commandExists(command: string, options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): boolean {
  if (command.includes("/") || command.includes("\\")) {
    return existsSync(command)
  }

  if (process.platform === "win32") {
    const result = spawnSync("cmd", ["/C", "where", command], {
      cwd: options.cwd,
      env: options.env,
      encoding: "utf8"
    })
    return result.status === 0
  }

  const shell = preferredShell()
  const result = spawnSync(shell, ["-lc", `command -v -- ${shellQuote(command)}`], {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8"
  })
  return result.status === 0
}

export function executeCommand(
  command: string,
  args: string[],
  options: ProcessExecutionOptions = {}
): ProcessExecutionResult {
  if (options.outputPath && existsSync(options.outputPath)) {
    unlinkSync(options.outputPath)
  }

  const result = spawnSync(command, args, spawnOptions(options))
  const fallbackOutput = options.outputPath ? readAndRemoveOutput(options.outputPath) : null
  return normalizeSpawnResult(result, fallbackOutput, options)
}

export async function executeCommandAsync(
  command: string,
  args: string[],
  options: ProcessExecutionOptions = {}
): Promise<ProcessExecutionResult> {
  if (options.outputPath && existsSync(options.outputPath)) {
    unlinkSync(options.outputPath)
  }

  return new Promise((resolve) => {
    let stdout = ""
    let stderr = ""
    let outputTruncated = false
    let truncationReason: string | null = null
    let cancelled = false
    let timedOut = false
    let settled = false
    let exitFallback: NodeJS.Timeout | null = null
    let childError: Error | null = null
    let lastOutputSignature: string | null = null
    const maxBuffer = options.maxBufferBytes ?? 1024 * 1024 * 10

    const useProcessGroup = shouldUseProcessGroup(options)
    const processScopeId = useProcessGroup && process.platform === "linux" ? randomUUID() : null
    if (options.abortSignal?.aborted) {
      const error = new Error("Process cancelled before initiation")
      error.name = "AbortError"
      resolve(
        normalizeProcessResult(
          { status: null, signal: null, stdout: "", stderr: "", error, timedOut: false },
          null,
          options
        )
      )
      return
    }
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: processScopeId
        ? { ...(options.env ?? process.env), OPENCLAW_PROCESS_SCOPE_ID: processScopeId }
        : options.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: useProcessGroup
    })
    const childPid = child.pid
    const cancel = () => {
      cancelled = true
      childError = new Error("Process cancelled")
      childError.name = "AbortError"
      terminateChild(child, childPid, "SIGTERM", useProcessGroup, processScopeId)
      scheduleChildKill(child, childPid, options, useProcessGroup, processScopeId, () => settled)
    }
    options.abortSignal?.addEventListener("abort", cancel, { once: true })
    if (options.abortSignal?.aborted) cancel()

    const timeout =
      typeof options.timeoutMs === "number" && options.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true
            terminateChild(child, childPid, "SIGTERM", useProcessGroup, processScopeId)
            scheduleChildKill(child, childPid, options, useProcessGroup, processScopeId, () => settled)
          }, options.timeoutMs)
        : null

    timeout?.unref()

    const resetIdleTimer = (): void => {
      if (!idleTimeout) return
      clearTimeout(idleTimeout)
      idleTimeout = scheduleIdleTimeout()
    }

    const scheduleIdleTimeout = (): NodeJS.Timeout | null => {
      if (typeof options.idleTimeoutMs !== "number" || options.idleTimeoutMs <= 0) return null
      const idleTimer = setTimeout(() => {
        timedOut = true
        const error = new Error(`Process produced no output for ${options.idleTimeoutMs} ms`)
        error.name = "TimeoutError"
        childError = error
        terminateChild(child, childPid, "SIGTERM", useProcessGroup, processScopeId)
        scheduleChildKill(
          child,
          childPid,
          { ...options, timeoutKillGraceMs: Math.min(killGraceMs(options), 1_000) },
          useProcessGroup,
          processScopeId,
          () => settled
        )
      }, options.idleTimeoutMs)
      idleTimer.unref()
      return idleTimer
    }

    const outputPollInterval =
      options.outputPath && typeof options.idleTimeoutMs === "number" && options.idleTimeoutMs > 0
        ? setInterval(
            () => {
              const signature = fileProgressSignature(options.outputPath)
              if (signature && signature !== lastOutputSignature) {
                lastOutputSignature = signature
                resetIdleTimer()
              }
            },
            Math.max(250, Math.min(1_000, Math.floor(options.idleTimeoutMs / 4)))
          )
        : null
    outputPollInterval?.unref()

    let idleTimeout = scheduleIdleTimeout()

    const append = (kind: "stdout" | "stderr", chunk: Buffer | string): void => {
      resetIdleTimer()
      const text = chunk.toString()
      const current = kind === "stdout" ? stdout : stderr
      if (Buffer.byteLength(current, "utf8") + Buffer.byteLength(text, "utf8") > maxBuffer) {
        if (options.terminateOnOutputLimit && !outputTruncated) {
          childError = new Error("Process output limit exceeded")
          childError.name = "OutputLimitError"
          terminateChild(child, childPid, "SIGTERM", useProcessGroup, processScopeId)
          scheduleChildKill(child, childPid, options, useProcessGroup, processScopeId, () => settled)
        }
        outputTruncated = true
        truncationReason = `Output exceeded ${maxBuffer} byte buffer.`
        const compacted = trailingUtf8Bytes(current + text, Math.max(1, Math.floor(maxBuffer / 2)))
        if (kind === "stdout") stdout = compacted
        else stderr = compacted
        return
      }
      if (kind === "stdout") stdout += text
      else stderr += text
    }

    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return
      settled = true
      options.abortSignal?.removeEventListener("abort", cancel)
      if (cancelled) {
        childError = new Error("Process cancelled")
        childError.name = "AbortError"
      }
      if (timeout) clearTimeout(timeout)
      if (idleTimeout) clearTimeout(idleTimeout)
      if (outputPollInterval) clearInterval(outputPollInterval)
      if (exitFallback) clearTimeout(exitFallback)
      const fallbackOutput = options.outputPath ? readAndRemoveOutput(options.outputPath) : null
      const result = normalizeProcessResult(
        {
          status: code,
          signal,
          stdout,
          stderr,
          error: childError,
          timedOut
        },
        fallbackOutput,
        options
      )
      resolve({
        ...result,
        outputTruncated: result.outputTruncated || outputTruncated,
        truncationReason: [result.truncationReason, truncationReason].filter(Boolean).join(" ") || null
      })
    }

    child.stdout?.on("data", (chunk) => append("stdout", chunk))
    child.stderr?.on("data", (chunk) => append("stderr", chunk))
    child.on("error", (error) => {
      childError = error
    })
    child.on("exit", (code, signal) => {
      if (useProcessGroup) {
        terminateChild(child, childPid, "SIGTERM", useProcessGroup, processScopeId)
        scheduleChildKill(child, childPid, options, useProcessGroup, processScopeId, () => settled)
      }
      // A detached descendant can retain the wrapper's stdio descriptors after
      // the wrapper exits. Node then never emits `close`, leaving callers stuck
      // even though there is no command process left to wait for. Give normal
      // stream draining and process-group cleanup a grace period, then settle
      // from the authoritative `exit` result.
      exitFallback = setTimeout(() => {
        child.stdin?.destroy()
        child.stdout?.destroy()
        child.stderr?.destroy()
        finish(code, signal ?? null)
      }, killGraceMs(options))
    })
    child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") {
        childError = error
      }
    })
    child.on("close", (code, signal) => {
      finish(code, signal ?? null)
    })

    if (options.input !== undefined) {
      child.stdin?.write(options.input, (error: Error | null | undefined) => {
        const writeError = error as NodeJS.ErrnoException | null | undefined
        if (writeError && writeError.code !== "EPIPE") {
          childError = writeError
        }
      })
    }
    child.stdin?.end()
  })
}

export function executeShell(commandLine: string, options: ShellExecutionOptions = {}): ProcessExecutionResult {
  const shell = options.shell ?? preferredShell()
  const loginPath =
    options.preferLoginPath !== false && process.platform !== "win32" ? resolveLoginShellPath(shell) : null
  const env = loginPath ? { ...options.env, PATH: loginPath } : options.env

  if (process.platform === "win32") {
    const shellName = basename(shell).toLowerCase()
    if (shellName === "pwsh" || shellName === "powershell") {
      return executeCommand(shell, ["-NoProfile", "-NonInteractive", "-Command", commandLine], { ...options, env })
    }
    if (shellName === "cmd" || shellName === "cmd.exe") {
      return executeCommand(shell, ["/C", commandLine], { ...options, env })
    }
    return executeCommand(shell, ["-c", commandLine], { ...options, env })
  }

  if (isFlatpak()) {
    const shellArg =
      process.env.OPENCLAW_SHELL?.trim() || process.env.GOOSE_SHELL?.trim() ? shell : basename(shell) || "bash"
    return executeCommand("flatpak-spawn", ["--host", "--watch-bus", shellArg, "-c", commandLine], { ...options, env })
  }

  return executeCommand(shell, ["-c", commandLine], { ...options, env })
}

export async function executeShellAsync(
  commandLine: string,
  options: ShellExecutionOptions = {}
): Promise<ProcessExecutionResult> {
  const shell = options.shell ?? preferredShell()
  const loginPath =
    options.preferLoginPath !== false && process.platform !== "win32" ? resolveLoginShellPath(shell) : null
  const env = loginPath ? { ...options.env, PATH: loginPath } : options.env

  if (process.platform === "win32") {
    const shellName = basename(shell).toLowerCase()
    if (shellName === "pwsh" || shellName === "powershell") {
      return executeCommandAsync(shell, ["-NoProfile", "-NonInteractive", "-Command", commandLine], {
        ...options,
        env
      })
    }
    if (shellName === "cmd" || shellName === "cmd.exe") {
      return executeCommandAsync(shell, ["/C", commandLine], { ...options, env })
    }
    return executeCommandAsync(shell, ["-c", commandLine], { ...options, env })
  }

  if (isFlatpak()) {
    const shellArg =
      process.env.OPENCLAW_SHELL?.trim() || process.env.GOOSE_SHELL?.trim() ? shell : basename(shell) || "bash"
    return executeCommandAsync("flatpak-spawn", ["--host", "--watch-bus", shellArg, "-c", commandLine], {
      ...options,
      env
    })
  }

  return executeCommandAsync(shell, ["-c", commandLine], { ...options, env })
}

export function buildOutputPath(prefix: string, identifier: string): string {
  return join(tmpdir(), `${prefix}-${identifier}.txt`)
}

export function saveTextOutput(path: string, content: string): void {
  writeFileSync(path, content, "utf8")
}

function spawnOptions(options: ProcessExecutionOptions): SpawnSyncOptionsWithStringEncoding {
  return {
    cwd: options.cwd,
    env: options.env,
    input: options.input,
    encoding: options.encoding ?? "utf8",
    timeout: options.timeoutMs,
    maxBuffer: options.maxBufferBytes ?? 1024 * 1024 * 10
  }
}

function shouldUseProcessGroup(options: ProcessExecutionOptions): boolean {
  return Boolean(options.terminateProcessGroup) && process.platform !== "win32"
}

function killGraceMs(options: ProcessExecutionOptions): number {
  const value = options.timeoutKillGraceMs
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 5_000
}

function terminateChild(
  child: ReturnType<typeof spawn>,
  pid: number | undefined,
  signal: NodeJS.Signals,
  processGroup: boolean,
  processScopeId: string | null
): void {
  terminateDescendants(pid, signal)
  terminateScopedProcesses(processScopeId, signal)
  if (processGroup) {
    terminatePidGroup(pid, signal)
  }
  try {
    child.kill(signal)
  } catch {}
}

function terminatePidGroup(pid: number | undefined, signal: NodeJS.Signals): boolean {
  if (!pid || process.platform === "win32") return false
  try {
    process.kill(-pid, signal)
    return true
  } catch {
    return false
  }
}

function terminateDescendants(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid || process.platform === "win32") return
  try {
    spawnSync("pkill", [`-${signal}`, "-P", String(pid)], { stdio: "ignore" })
  } catch {}
}

function scopedProcessIds(processScopeId: string | null): number[] {
  if (!processScopeId || process.platform !== "linux") return []
  const marker = Buffer.from(`OPENCLAW_PROCESS_SCOPE_ID=${processScopeId}\0`)
  try {
    return readdirSync("/proc", { withFileTypes: true }).flatMap((entry) => {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) return []
      const pid = Number.parseInt(entry.name, 10)
      if (!Number.isFinite(pid) || pid === process.pid) return []
      try {
        return readFileSync(`/proc/${entry.name}/environ`).includes(marker) ? [pid] : []
      } catch {
        return []
      }
    })
  } catch {
    return []
  }
}

function terminateScopedProcesses(processScopeId: string | null, signal: NodeJS.Signals): void {
  for (const pid of scopedProcessIds(processScopeId)) {
    try {
      process.kill(pid, signal)
    } catch {}
  }
}

function scheduleChildKill(
  child: ReturnType<typeof spawn>,
  pid: number | undefined,
  options: ProcessExecutionOptions,
  processGroup: boolean,
  processScopeId: string | null,
  settled: () => boolean
): void {
  setTimeout(() => {
    if (settled() && scopedProcessIds(processScopeId).length === 0) return
    terminateChild(child, pid, "SIGKILL", processGroup, processScopeId)
  }, killGraceMs(options)).unref()
}

function fileProgressSignature(path: string | null | undefined): string | null {
  if (!path) return null
  try {
    const stat = statSync(path)
    return `${stat.size}:${stat.mtimeMs}`
  } catch {
    return null
  }
}

function normalizeSpawnResult(
  result: SpawnSyncReturns<string>,
  fallbackOutput: string | null,
  options: ProcessExecutionOptions
): ProcessExecutionResult {
  return normalizeProcessResult(
    {
      status: result.status,
      signal: result.signal ?? null,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      error: result.error ?? null,
      timedOut:
        result.error?.name === "TimeoutError" ||
        (typeof result.error?.message === "string" && /\btime(?:d)? out\b/i.test(result.error.message))
    },
    fallbackOutput,
    options
  )
}

function normalizeProcessResult(
  result: {
    status: number | null
    signal: NodeJS.Signals | null
    stdout: string
    stderr: string
    error: Error | null
    timedOut: boolean
  },
  fallbackOutput: string | null,
  options: ProcessExecutionOptions
): ProcessExecutionResult {
  const rawStdout = result.stdout ?? ""
  const rawStderr = result.stderr ?? ""
  const interleavedSource =
    rawStdout || rawStderr
      ? [rawStdout.trimEnd(), rawStderr.trimEnd()].filter(Boolean).join("\n")
      : (fallbackOutput ?? "")
  const stdoutPreview = options.truncateOutput ? truncateOutput(rawStdout) : passthroughOutput(rawStdout)
  const stderrPreview = options.truncateOutput ? truncateOutput(rawStderr) : passthroughOutput(rawStderr)
  const interleavedPreview = options.truncateOutput
    ? truncateOutput(interleavedSource)
    : passthroughOutput(interleavedSource)
  const reasons = [
    stdoutPreview.truncationReason,
    stderrPreview.truncationReason,
    interleavedPreview.truncationReason
  ].filter((value): value is string => Boolean(value))

  return {
    ok: result.status === 0 && !result.error && !result.signal && !result.timedOut,
    stdout: stdoutPreview.text,
    stderr: stderrPreview.text,
    interleaved: interleavedPreview.text,
    fallbackResponse: fallbackOutput,
    exitCode: result.status,
    signal: result.signal ?? null,
    timedOut: result.timedOut,
    error: result.error ?? null,
    outputTruncated:
      stdoutPreview.outputTruncated || stderrPreview.outputTruncated || interleavedPreview.outputTruncated,
    truncationReason: reasons.length > 0 ? Array.from(new Set(reasons)).join(" ") : null
  }
}

function passthroughOutput(value: string): {
  text: string
  outputTruncated: boolean
  truncationReason: string | null
} {
  return {
    text: value,
    outputTruncated: false,
    truncationReason: null
  }
}

function truncateOutput(value: string): {
  text: string
  outputTruncated: boolean
  truncationReason: string | null
} {
  const totalBytes = Buffer.byteLength(value, "utf8")
  const lines = value.split("\n")
  const exceededLines = lines.length > OUTPUT_LIMIT_LINES
  const exceededBytes = totalBytes > OUTPUT_LIMIT_BYTES
  if (!exceededLines && !exceededBytes) {
    return {
      text: value,
      outputTruncated: false,
      truncationReason: null
    }
  }

  const preview = lines.slice(Math.max(0, lines.length - OUTPUT_PREVIEW_LINES)).join("\n")
  return {
    text: preview,
    outputTruncated: true,
    truncationReason: exceededLines
      ? `Output exceeded ${OUTPUT_LIMIT_LINES} line limit (${lines.length} lines total).`
      : `Output exceeded ${OUTPUT_LIMIT_BYTES} byte limit (${totalBytes} bytes total).`
  }
}

function resolveLoginShellPath(shell: string): string | null {
  if (process.platform === "win32") {
    return null
  }

  const runner = isFlatpak() ? "flatpak-spawn" : shell
  const args = isFlatpak()
    ? ["--host", "--watch-bus", basename(shell) || "bash", "-l", "-i", "-c", "echo $PATH"]
    : ["-l", "-i", "-c", "echo $PATH"]

  const result = spawnSync(runner, args, {
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "utf8",
    timeout: 5_000
  })

  if (result.status !== 0) {
    return null
  }

  const lines = (result.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  return lines.at(-1) ?? null
}

function readAndRemoveOutput(path: string): string | null {
  if (!existsSync(path)) {
    return null
  }

  const content = readFileSync(path, "utf8").trim()
  unlinkSync(path)
  return content || null
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Only non-secret build settings are inherited; never HOME, PATH or loader/startup hooks. */
export const BUILD_ENVIRONMENT_ALLOWLIST = [
  "CI",
  "NODE_ENV",
  "TZ",
  "LANG",
  "LC_ALL",
  "SOURCE_DATE_EPOCH",
  "FORCE_COLOR",
  "NO_COLOR"
] as const

export function allowlistedEnvironment(
  names: readonly string[],
  source: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const env: Record<string, string> = Object.create(null)
  for (const name of names) if (source[name] !== undefined) env[name] = source[name]!
  return env
}

/** No host mounts other than a private source copy. Namespace creation is mandatory. */
export async function executeSandboxedCommand(
  argv: string[],
  options: {
    rootFilesystem: string
    workspace: string
    cwd: string
    timeoutMs: number
    idleTimeoutMs?: number
    signal?: AbortSignal
    maxBufferBytes?: number
  }
) {
  if (process.platform !== "linux" || !existsSync("/usr/bin/bwrap"))
    throw new Error("Required Bubblewrap verification isolation is unavailable")
  const env = {
    ...allowlistedEnvironment(BUILD_ENVIRONMENT_ALLOWLIST),
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: "/tmp/home",
    TMPDIR: "/tmp"
  }
  const result = await executeCommandAsync(
    "/usr/bin/bwrap",
    [
      "--unshare-all",
      "--unshare-user",
      "--disable-userns",
      "--die-with-parent",
      "--new-session",
      "--cap-drop",
      "ALL",
      "--clearenv",
      "--ro-bind",
      options.rootFilesystem,
      "/",
      "--bind",
      options.workspace,
      "/work",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--tmpfs",
      "/tmp",
      "--dir",
      "/tmp/home",
      "--chdir",
      options.cwd,
      ...Object.entries(env).flatMap(([key, value]) => ["--setenv", key, value]),
      "--",
      ...argv
    ],
    {
      env: {},
      cwd: "/",
      timeoutMs: options.timeoutMs,
      idleTimeoutMs: options.idleTimeoutMs,
      timeoutKillGraceMs: 250,
      maxBufferBytes: options.maxBufferBytes ?? 16 * 1024 * 1024,
      abortSignal: options.signal,
      terminateProcessGroup: true,
      terminateOnOutputLimit: true,
      truncateOutput: false
    }
  )
  if (!result.ok) {
    const error = Object.assign(new Error(result.error?.message ?? "Sandbox command failed"), {
      stdout: result.stdout,
      stderr: result.stderr,
      code: result.exitCode,
      outcome:
        result.error?.name === "AbortError"
          ? "cancelled"
          : result.timedOut
            ? "timeout"
            : result.outputTruncated
              ? "output_limit"
              : result.signal
                ? "signal"
                : "nonzero"
    })
    throw error
  }
  return { stdout: result.stdout, stderr: result.stderr }
}

/** Explicit Docker isolation for hosts without unprivileged user namespaces; never an automatic fallback. */
export async function executeDockerSandboxedCommand(
  argv: string[],
  options: {
    image: string
    workspace: string
    cwd: string
    timeoutMs: number
    idleTimeoutMs?: number
    signal?: AbortSignal
    maxBufferBytes?: number
  }
) {
  if (!/^sha256:[a-f0-9]{64}$/.test(options.image)) throw new Error("Immutable Docker image ID required")
  if (!options.workspace.startsWith("/") || options.workspace.includes(",")) throw new Error("Invalid source mount")
  if (options.cwd !== "/work" && !options.cwd.startsWith("/work/")) throw new Error("Invalid sandbox working directory")
  const name = `autocode-verification-${randomUUID()}`
  const environment = {
    ...allowlistedEnvironment(BUILD_ENVIRONMENT_ALLOWLIST),
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: "/tmp/home",
    TMPDIR: "/tmp"
  }
  try {
    const result = await executeCommandAsync(
      "/usr/bin/docker",
      [
        "run",
        "--rm",
        "--init",
        "--pull=never",
        "--name",
        name,
        "--network=none",
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--pids-limit=256",
        "--memory=4g",
        "--cpus=2",
        "--user",
        `${process.getuid!()}:${process.getgid!()}`,
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,size=512m,mode=1777",
        "--mount",
        `type=bind,source=${options.workspace},target=/work`,
        "--workdir",
        options.cwd,
        "--entrypoint",
        "/usr/bin/env",
        options.image,
        "-i",
        ...Object.entries(environment).map(([key, value]) => `${key}=${value}`),
        ...argv
      ],
      {
        env: { PATH: "/usr/bin:/bin" },
        cwd: "/",
        timeoutMs: options.timeoutMs,
        idleTimeoutMs: options.idleTimeoutMs,
        timeoutKillGraceMs: 250,
        maxBufferBytes: options.maxBufferBytes ?? 16 * 1024 * 1024,
        abortSignal: options.signal,
        terminateProcessGroup: true,
        terminateOnOutputLimit: true,
        truncateOutput: false
      }
    )
    if (!result.ok)
      throw Object.assign(new Error(result.error?.message ?? "Docker sandbox command failed"), {
        stdout: result.stdout,
        stderr: result.stderr,
        code: result.exitCode,
        outcome:
          result.error?.name === "AbortError"
            ? "cancelled"
            : result.timedOut
              ? "timeout"
              : result.outputTruncated
                ? "output_limit"
                : result.signal
                  ? "signal"
                  : "nonzero"
      })
    return { stdout: result.stdout, stderr: result.stderr }
  } finally {
    // Killing the Docker client does not stop its container. Always remove the execution by our generated name.
    await executeCommandAsync("/usr/bin/docker", ["rm", "--force", name], {
      env: { PATH: "/usr/bin:/bin" },
      cwd: "/",
      timeoutMs: 10_000,
      maxBufferBytes: 4096
    })
  }
}
