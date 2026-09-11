import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, isAbsolute, relative, resolve } from "node:path"
import { promisify } from "node:util"
import {
  type NativeAcceptanceBinding,
  type NativeAutonomyPolicy,
  type NativeCommand,
  type NativeVerificationContext,
  type NativeVerificationCoveragePlan,
  type NativeVerificationEvidence,
  type NativeVerificationSandbox,
  nativeCoderAgentIds,
  nativePathAllowed,
  nativePolicyDigest,
  nativeVerificationRuleId,
  redactLogText,
  validateNativeAutonomyPolicy,
  validateNativeVerificationSandbox
} from "@openclaw/domain"

import {
  allowlistedEnvironment,
  BUILD_ENVIRONMENT_ALLOWLIST,
  executeCommandAsync,
  executeDockerSandboxedCommand,
  executeSandboxedCommand
} from "@openclaw/os-adapters"

import { nativeContentDigest, nativeRepositoryIdentity } from "./provenance.js"
import { snapshotNativeInputs } from "./snapshot.js"

export interface NativeVerificationAuthority {
  authorize(): void
  mutate(action: () => void): void
}

const exec = promisify(execFile)
export async function nativeGitRaw(cwd: string, ...args: string[]): Promise<string> {
  const result = await exec("git", args, { cwd, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 })
  return result.stdout
}
export async function nativeGit(cwd: string, ...args: string[]): Promise<string> {
  const output = await nativeGitRaw(cwd, ...args)
  return args.includes("-z") ? output : output.trim()
}
export function containedDirectory(root: string, child: string): string {
  const actualRoot = realpathSync(root),
    actual = realpathSync(resolve(root, child))
  const rel = relative(actualRoot, actual)
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new Error("Command directory escapes worktree")
  return actual
}
const runtimeNotes = new Set([
  "DREAMS.md",
  "IDENTITY.md",
  "SOUL.md",
  "USER.md",
  "MEMORY.md",
  "BOOTSTRAP.md",
  "HEARTBEAT.md",
  "TOOLS.md"
])
function isRuntimeNote(path: string): boolean {
  return runtimeNotes.has(path) || path.startsWith("memory/dreaming/")
}
async function candidateChanges(cwd: string): Promise<string[]> {
  let filters = ""
  try {
    filters = await nativeGit(
      cwd,
      "config",
      "--name-only",
      "--get-regexp",
      "^filter\\..*\\.(clean|process|smudge|required)$"
    )
  } catch (error) {
    if ((error as { code?: number }).code !== 1) throw error
  }
  const options = [
    "-c",
    "core.fsmonitor=false",
    ...filters
      .split("\n")
      .filter(Boolean)
      .flatMap((key) => ["-c", `${key}=${key.endsWith(".required") ? "false" : ""}`])
  ]
  const tracked = await nativeGit(
    cwd,
    ...options,
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--name-only",
    "--no-renames",
    "-z",
    "HEAD"
  )
  const staged = await nativeGit(
    cwd,
    ...options,
    "diff",
    "--cached",
    "--no-ext-diff",
    "--no-textconv",
    "--name-only",
    "--no-renames",
    "-z"
  )
  const untracked = await nativeGit(cwd, ...options, "ls-files", "--others", "--exclude-standard", "-z")
  return [
    ...new Set(
      [
        ...tracked.split("\0"),
        ...staged.split("\0"),
        ...untracked.split("\0").filter((path) => !isRuntimeNote(path))
      ].filter(Boolean)
    )
  ]
}
async function assertCandidateRepository(policy: NativeAutonomyPolicy, worktree: string): Promise<string> {
  const cwd = realpathSync(worktree)
  if (cwd === realpathSync(policy.repository)) throw new Error("Candidate must use an isolated worktree")
  const common = realpathSync(await nativeGit(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"))
  const source = realpathSync(
    await nativeGit(policy.repository, "rev-parse", "--path-format=absolute", "--git-common-dir")
  )
  if (common !== source) throw new Error("Candidate does not belong to configured repository")
  return cwd
}
/** Trusted submission broker: snapshot only admitted regular code files without running Git hooks or filters. */
export async function commitNativeCandidate(
  policy: NativeAutonomyPolicy,
  worktree: string,
  allowedPaths: string[],
  title: string,
  authorize: () => void
): Promise<string | undefined> {
  const cwd = await assertCandidateRepository(policy, worktree)
  const files = await candidateChanges(cwd)
  if (!files.length) return undefined
  const rejected = files.filter(
    (file) =>
      !allowedPaths.some((root) => nativePathAllowed(file, root)) ||
      isRuntimeNote(file) ||
      file
        .split("/")
        .some((part) =>
          /^(\.git.*|\.openclaw|\.codex|\.ssh|\.aws|\.env(?:\..*)?|.*(?:credentials|secrets).*|.*\.pem)$/i.test(part)
        )
  )
  if (rejected.length) {
    const examples = rejected.slice(0, 10).map((file) => redactLogText(file).slice(0, 200))
    throw new Error(
      `Candidate contains uncommitted files outside admitted code scope (${rejected.length}): ${JSON.stringify(examples)}. ` +
        "Inspect git status for the complete list. Moving or removing tracked files creates deletions; " +
        "restore only generated files changed by your own tooling to their committed state. " +
        "Preserve unrelated work and do not widen the admitted scope."
    )
  }
  for (const file of files) {
    const path = resolve(cwd, file)
    const stat = lstatSync(path, { throwIfNoEntry: false })
    if (stat) {
      if (!stat.isFile() || relative(cwd, realpathSync(path)).startsWith(".."))
        throw new Error("Candidate commit requires contained regular files")
    }
  }
  const oldHead = await nativeGit(cwd, "rev-parse", "HEAD")
  await nativeGit(cwd, "merge-base", "--is-ancestor", `origin/${policy.baseBranch}`, oldHead)
  const temporary = mkdtempSync(resolve(tmpdir(), "native-commit-"))
  const gitInput = async (args: string[], input?: Buffer) => {
    authorize()
    const pending = exec(
      "git",
      ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "commit.gpgSign=false", ...args],
      {
        cwd,
        timeout: 30_000,
        maxBuffer: 8 * 1024 * 1024,
        env: {
          PATH: "/usr/bin:/bin",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_INDEX_FILE: resolve(temporary, "index"),
          GIT_AUTHOR_NAME: "AutoCode",
          GIT_AUTHOR_EMAIL: "autocode@localhost",
          GIT_COMMITTER_NAME: "AutoCode",
          GIT_COMMITTER_EMAIL: "autocode@localhost"
        }
      }
    )
    pending.child.stdin?.end(input)
    return (await pending).stdout.trim()
  }
  const git = (...args: string[]) => gitInput(args)
  try {
    await git("read-tree", oldHead)
    for (const file of files) {
      const path = resolve(cwd, file)
      if (!lstatSync(path, { throwIfNoEntry: false })) await git("update-index", "--force-remove", "--", file)
      else {
        const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
        let bytes: Buffer, mode: string
        try {
          const stat = fstatSync(fd)
          // Check the opened descriptor, not a pathname that a running worker can swap.
          if (
            !stat.isFile() ||
            stat.size > 32 * 1024 * 1024 ||
            relative(cwd, realpathSync(`/proc/self/fd/${fd}`)).startsWith("..")
          )
            throw new Error("Candidate snapshot escaped its bounded regular file")
          bytes = Buffer.alloc(stat.size + 1)
          let length = 0
          while (length < bytes.length) {
            const count = readSync(fd, bytes, length, bytes.length - length, length)
            if (!count) break
            length += count
          }
          if (length !== stat.size) throw new Error("Candidate file size changed during snapshot")
          bytes = bytes.subarray(0, length)
          mode = stat.mode & 0o111 ? "100755" : "100644"
        } finally {
          closeSync(fd)
        }
        const oid = await gitInput(["hash-object", "-w", "--stdin"], bytes)
        await git("update-index", "--add", "--cacheinfo", mode, oid, file)
      }
    }
    const tree = await git("write-tree")
    const sha = await git("commit-tree", tree, "-p", oldHead, "-m", title.slice(0, 200))
    await git("update-ref", "HEAD", sha, oldHead)
    // Synchronize only this worktree's index; never checkout or overwrite worker edits.
    authorize()
    await nativeGit(cwd, "-c", "core.hooksPath=/dev/null", "read-tree", sha)
    return sha
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}
export async function inspectNativeCandidate(policy: NativeAutonomyPolicy, worktree: string, allowedPaths: string[]) {
  const cwd = await assertCandidateRepository(policy, worktree)
  if ((await candidateChanges(cwd)).length) throw new Error("Commit candidate changes before verification")
  const headSha = await nativeGit(cwd, "rev-parse", "HEAD")
  const baseSha = await nativeGit(cwd, "rev-parse", `origin/${policy.baseBranch}`)
  await nativeGit(cwd, "merge-base", "--is-ancestor", baseSha, headSha)
  // Treat renames as deletion + addition so both endpoints require scope and coverage.
  const files = (await nativeGit(cwd, "diff", "--name-only", "--no-renames", "-z", `${baseSha}...${headSha}`))
    .split("\0")
    .filter(Boolean)
  if (!files.length) throw new Error("Candidate has no repository changes")
  if (files.some((p) => !allowedPaths.some((root) => nativePathAllowed(p, root)))) {
    throw new Error("Candidate changed files outside admitted scope")
  }
  return { cwd, headSha, baseSha, files, branch: await nativeGit(cwd, "branch", "--show-current") }
}
function requireNewCommandArtifact(artifact: string) {
  // lstat also detects dangling symlinks. This avoids wasted execution, while
  // the final exclusive write remains the authority against concurrent writers.
  if (lstatSync(artifact, { throwIfNoEntry: false })) {
    throw Object.assign(new Error(`Command receipt already exists: ${artifact}`), { code: "EEXIST" })
  }
}

async function recordCommand(
  command: NativeCommand,
  cwd: string,
  artifact: string,
  execute: () => Promise<{ stdout: string; stderr: string }>,
  authority?: NativeVerificationAuthority
) {
  const startedAt = new Date().toISOString()
  let stdout = "",
    stderr = "",
    exitCode: number | null = null,
    outcome = "success"
  authority?.authorize()
  requireNewCommandArtifact(artifact)
  try {
    const result = await execute()
    stdout = result.stdout
    stderr = result.stderr
    exitCode = 0
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; code?: number; message?: string; outcome?: string }
    stdout = e.stdout ?? ""
    stderr = e.stderr || e.message || "Command failed"
    exitCode = typeof e.code === "number" ? e.code : null
    outcome = e.outcome ?? (exitCode === null ? "unknown" : "nonzero")
  }
  const finishedAt = new Date().toISOString()
  const persist = () => {
    mkdirSync(dirname(artifact), { recursive: true })
    // Refuse existing files and symlinks; only the privileged parent creates receipts.
    writeFileSync(
      artifact,
      JSON.stringify(
        {
          argv: command.argv.map((arg, index) => (index === 0 ? redactLogText(arg) : "[REDACTED ARGUMENT]")),
          cwd,
          startedAt,
          finishedAt,
          exitCode,
          outcome,
          stdout: redactLogText(stdout),
          stderr: redactLogText(stderr)
        },
        null,
        2
      ),
      { mode: 0o600, flag: "wx" }
    )
  }
  if (authority) authority.mutate(persist)
  else persist()
  return {
    argv: command.argv.map((arg, index) => (index === 0 ? redactLogText(arg) : "[REDACTED ARGUMENT]")),
    cwd,
    startedAt,
    finishedAt,
    exitCode,
    outcome,
    artifact,
    stdout
  }
}

/** Privileged host execution is only available to explicitly authorized deployment policy. */
export async function runNativeDeploymentCommand(
  command: NativeCommand,
  root: string,
  artifact: string,
  env: Record<string, string>,
  authorization: { authorized?: boolean; environmentAllowlist?: string[] },
  signal?: AbortSignal
) {
  if (authorization.authorized !== true) throw new Error("Privileged deployment execution is not authorized")
  const cwd = containedDirectory(root, command.cwd)
  return recordCommand(command, cwd, resolve(dirname(artifact), `${randomUUID()}-${basename(artifact)}`), async () => {
    const result = await executeCommandAsync(command.argv[0]!, command.argv.slice(1), {
      cwd,
      env: {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        ...allowlistedEnvironment(BUILD_ENVIRONMENT_ALLOWLIST),
        ...allowlistedEnvironment(authorization.environmentAllowlist ?? []),
        ...env
      },
      timeoutMs: command.timeoutSeconds * 1000,
      idleTimeoutMs: command.idleTimeoutSeconds === undefined ? undefined : command.idleTimeoutSeconds * 1000,
      maxBufferBytes: command.outputLimitBytes ?? 16777216,
      abortSignal: signal,
      terminateProcessGroup: true,
      timeoutKillGraceMs: 250,
      terminateOnOutputLimit: true,
      truncateOutput: false
    })
    if (!result.ok)
      throw Object.assign(new Error(result.error?.message ?? "Deployment command failed"), {
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
  })
}

export async function runNativeCommand(
  command: NativeCommand,
  root: string,
  artifact: string,
  sandbox?: NativeVerificationSandbox,
  signal?: AbortSignal,
  authority?: NativeVerificationAuthority
) {
  authority?.authorize()
  if (!sandbox) throw new Error("Required verification sandbox is not configured")
  const config = validateNativeVerificationSandbox(sandbox)
  const rootFilesystem = config.backend === "bubblewrap" ? realpathSync(config.rootFilesystem) : ""
  if (config.backend === "bubblewrap") {
    const rootStat = statSync(rootFilesystem)
    if (rootFilesystem === "/" || rootStat.uid !== 0 || (rootStat.mode & 0o022) !== 0)
      throw new Error("Sandbox root filesystem must be administrator-owned and immutable to workers")
  }
  const cwd = containedDirectory(root, command.cwd)
  requireNewCommandArtifact(artifact)
  const workspace = mkdtempSync(resolve(tmpdir(), "native-verification-"))
  try {
    // Read committed blobs, never candidate symlinks, untracked secrets or host git metadata.
    const sha = await nativeGit(root, "rev-parse", "HEAD")
    await snapshotNativeInputs(
      root,
      workspace,
      sha,
      config.inputFiles,
      signal,
      () => authority?.authorize(),
      config.reviewedSourceFiles
    )
    const sandboxCwd = resolve("/work", relative(realpathSync(root), cwd))
    mkdirSync(resolve(workspace, relative(realpathSync(root), cwd)), { recursive: true })
    return await recordCommand(
      command,
      cwd,
      artifact,
      () => {
        const options = {
          workspace,
          cwd: sandboxCwd,
          timeoutMs: command.timeoutSeconds * 1000,
          ...(command.idleTimeoutSeconds === undefined ? {} : { idleTimeoutMs: command.idleTimeoutSeconds * 1000 }),
          ...(command.outputLimitBytes === undefined ? {} : { maxBufferBytes: command.outputLimitBytes }),
          ...(signal ? { signal } : {})
        }
        return config.backend === "docker"
          ? executeDockerSandboxedCommand(command.argv, { ...options, image: config.image })
          : executeSandboxedCommand(command.argv, { ...options, rootFilesystem })
      },
      authority
    )
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
}
export function planNativeVerification(policy: NativeAutonomyPolicy, files: string[]): NativeVerificationCoveragePlan {
  const validated = validateNativeAutonomyPolicy(policy)
  const coverage = [...new Set(files)].sort().map((path) => ({
    path,
    ruleIds: validated.verification
      .filter((rule) => !rule.paths || rule.paths.some((root) => nativePathAllowed(path, root)))
      .map(nativeVerificationRuleId),
    exemptionIds: (validated.verificationExemptions ?? []).filter((e) => e.paths.includes(path)).map((e) => e.id)
  }))
  return {
    policyDigest: nativePolicyDigest(validated),
    ruleIds: validated.verification
      .map(nativeVerificationRuleId)
      .filter((id) => coverage.some((entry) => entry.ruleIds.includes(id))),
    exemptions: (validated.verificationExemptions ?? []).filter((e) =>
      coverage.some((entry) => entry.exemptionIds.includes(e.id))
    ),
    coverage,
    uncoveredPaths: coverage
      .filter((entry) => !entry.ruleIds.length && !entry.exemptionIds.length)
      .map((entry) => entry.path)
  }
}
export function nativeVerificationCommands(policy: NativeAutonomyPolicy, files: string[]): NativeCommand[] {
  const plan = planNativeVerification(policy, files)
  if (plan.uncoveredPaths.length)
    throw new Error(
      `Verification coverage missing for: ${plan.uncoveredPaths.map((p) => JSON.stringify(p)).join(", ")}`
    )
  return validateNativeAutonomyPolicy(policy).verification.filter((command) =>
    plan.ruleIds.includes(nativeVerificationRuleId(command))
  )
}
export async function verifyNativeCandidate(
  policy: NativeAutonomyPolicy,
  candidate: { cwd: string; headSha: string; baseSha: string; files: string[] },
  artifactRoot: string,
  signal?: AbortSignal,
  authority?: NativeVerificationAuthority,
  acceptance: string[] = [],
  context?: NativeVerificationContext
): Promise<NativeVerificationEvidence> {
  policy = structuredClone(policy)
  const plan = planNativeVerification(policy, candidate.files)
  const checks: NativeVerificationEvidence["checks"] = []
  const bindings: NativeAcceptanceBinding[] = []
  const receipt: NativeVerificationEvidence = {
    headSha: candidate.headSha,
    baseSha: candidate.baseSha,
    plan,
    checks,
    acceptance: bindings
  }
  const writeReceipt = () => {
    mkdirSync(artifactRoot, { recursive: true })
    writeFileSync(resolve(artifactRoot, "receipt.json"), JSON.stringify(receipt, null, 2), { mode: 0o600 })
  }
  const persist = () => (authority ? authority.mutate(writeReceipt) : writeReceipt())
  persist()
  if (!plan.coverage.length) throw new Error("Candidate has no repository changes")
  const commands = nativeVerificationCommands(policy, candidate.files)
  await assertNativeVerificationAuthority(policy, candidate)
  bindings.push(...nativeAcceptanceBindings(policy, acceptance, plan.ruleIds, candidate.headSha))
  for (const [i, command] of commands.entries()) {
    if ((await nativeGit(candidate.cwd, "rev-parse", "HEAD")) !== candidate.headSha)
      throw new Error("Candidate changed during verification")
    const { stdout: _stdout, ...check } = await runNativeCommand(
      command,
      candidate.cwd,
      resolve(artifactRoot, `${i}-${randomUUID()}.json`),
      policy.verificationSandbox,
      signal,
      authority
    )
    checks.push({
      ...check,
      ruleId: nativeVerificationRuleId(command),
      artifactSha256: createHash("sha256").update(readFileSync(check.artifact)).digest("hex")
    })
    persist()
    if (check.exitCode !== 0) break
  }
  if (
    (await nativeGit(candidate.cwd, "rev-parse", "HEAD")) !== candidate.headSha ||
    (await nativeGit(candidate.cwd, "status", "--porcelain", "--untracked-files=no"))
  ) {
    throw new Error("Verification modified candidate code")
  }
  authority?.authorize()
  if (context) {
    const diff = await nativeGit(
      candidate.cwd,
      "diff",
      "--raw",
      "--no-abbrev",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      "-z",
      candidate.baseSha,
      candidate.headSha
    )
    receipt.provenance = {
      ...context,
      version: 1,
      repositoryId: nativeRepositoryIdentity(policy),
      baseSha: candidate.baseSha,
      headSha: candidate.headSha,
      diffDigest: nativeContentDigest(diff),
      policyDigest: plan.policyDigest,
      policySnapshot: policy,
      checkIds: plan.ruleIds,
      toolchain: {
        node: process.version,
        git: await nativeGit(candidate.cwd, "--version"),
        platform: process.platform,
        arch: process.arch,
        sandbox: policy.verificationSandbox?.backend ?? "no-executed-checks"
      },
      artifacts: checks.map((check) => ({ ruleId: check.ruleId, path: check.artifact, sha256: check.artifactSha256! }))
    }
    const raw = JSON.stringify(receipt.provenance),
      path = resolve(artifactRoot, `${randomUUID()}-provenance.json`)
    const write = () => writeFileSync(path, raw, { mode: 0o600, flag: "wx" })
    if (authority) authority.mutate(write)
    else write()
    receipt.provenanceArtifact = { path, sha256: nativeContentDigest(raw) }
    persist()
  }
  return receipt
}

/** Reviewed definitions identify each acceptance check; candidate output cannot invent bindings. */
export function nativeAcceptanceBindings(
  policy: NativeAutonomyPolicy,
  criteria: string[],
  selected: string[],
  headSha: string
) {
  const authority = policy.verificationAuthority
  if (!authority || !/^[a-f0-9]{40,64}$/.test(authority.reviewedRevision))
    throw new Error("Verification requires a reviewed policy revision and acceptance bindings")
  return criteria.map((criterion) => {
    const matches = authority.acceptance.filter((binding) => binding.criterion === criterion)
    if (
      matches.length !== 1 ||
      (!matches[0]!.ruleIds.length && !matches[0]!.manualEvidence) ||
      matches[0]!.ruleIds.some((id) => !selected.includes(id))
    )
      throw new Error(`Missing or ambiguous acceptance check binding: ${criterion}`)
    const manual = matches[0]!.manualEvidence
    if (
      manual &&
      (manual.headSha !== headSha ||
        nativeCoderAgentIds(policy).includes(manual.reviewedBy) ||
        !isAbsolute(manual.artifact) ||
        createHash("sha256").update(readFileSync(manual.artifact)).digest("hex") !== manual.sha256)
    )
      throw new Error("Manual acceptance evidence is stale or fails independent integrity validation")
    return matches[0]!
  })
}

export function assertNativeVerificationEvidence(
  policy: NativeAutonomyPolicy,
  candidate: { headSha: string; baseSha: string; files: string[] },
  evidence: NativeVerificationEvidence,
  acceptance: string[]
) {
  const plan = planNativeVerification(policy, candidate.files)
  if (
    evidence.headSha !== candidate.headSha ||
    evidence.baseSha !== candidate.baseSha ||
    JSON.stringify(plan) !== JSON.stringify(evidence.plan)
  )
    throw new Error("Verification receipt does not match current policy and candidate coverage")
  const bindings = nativeAcceptanceBindings(policy, acceptance, plan.ruleIds, candidate.headSha)
  if (JSON.stringify(bindings) !== JSON.stringify(evidence.acceptance))
    throw new Error("Verification acceptance bindings changed")
  for (const id of plan.ruleIds) {
    const checks = evidence.checks.filter((check) => check.ruleId === id)
    if (checks.length !== 1 || checks[0]!.exitCode !== 0)
      throw new Error("Missing or ambiguous required verification check")
    const check = checks[0]!
    if (
      !check.artifactSha256 ||
      createHash("sha256").update(readFileSync(check.artifact)).digest("hex") !== check.artifactSha256
    )
      throw new Error("Verification artifact integrity check failed")
    const receipt = JSON.parse(readFileSync(check.artifact, "utf8"))
    if (receipt.exitCode !== 0 || receipt.startedAt !== check.startedAt || receipt.finishedAt !== check.finishedAt)
      throw new Error("Verification artifact does not match trusted result")
  }
}

export async function assertNativeVerificationAuthority(
  policy: NativeAutonomyPolicy,
  candidate: { cwd: string; headSha: string; files: string[] },
  git = nativeGit
) {
  for (const check of policy.verification) {
    if (!check.argv[0]?.startsWith("/opt/openclaw/checks/") || check.argv[0].includes(".."))
      throw new Error(
        "Required checks must use administrator-owned /opt/openclaw/checks executables in the sandbox root"
      )
  }
  for (const path of candidate.files) {
    if (
      !/(^|\/)(?:tests?|__tests__|scripts|\.github|\.openclaw)(?:\/|$)|(?:^|\/)(?:package\.json|[^/]*lock[^/]*|[^/]*(?:vitest|jest|pytest|webpack|vite|tsconfig|eslint|biome)[^/]*|Makefile|Dockerfile)$|\.(?:test|spec)\.[^/]+$/.test(
        path
      )
    )
      continue
    const entry = await git(candidate.cwd, "ls-tree", candidate.headSha, "--", path)
    const blobSha = entry ? entry.split(/\s+/)[2] : "deleted"
    if (
      !(policy.verificationAuthority?.approvedChanges ?? []).some(
        (approval) =>
          approval.path === path &&
          approval.blobSha === blobSha &&
          !nativeCoderAgentIds(policy).includes(approval.reviewedBy)
      )
    )
      throw new Error(`Verification authority change requires independent policy approval: ${path}`)
  }
}
