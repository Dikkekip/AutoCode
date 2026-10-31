import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join } from "node:path"
import { type DockerSandboxReceipt, executeDockerSandboxedCommand } from "@openclaw/os-adapters"
import type { T3Journal, T3Lease } from "./journal.js"
import { digest } from "./personas.js"
import { assertT3CurrentSource, assertT3Source, captureT3Source, type T3Source } from "./source.js"
import type { T3Candidate, T3Verification } from "./workflow.js"

function git(repository: string, args: string[], buffer = 16 * 1024 * 1024): Buffer {
  return execFileSync("git", ["--no-optional-locks", "-C", repository, ...args], {
    maxBuffer: buffer,
    timeout: 10_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1" }
  })
}
function commonDirectory(repository: string): string {
  return realpathSync(git(repository, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).toString().trim())
}
function treeDigest(source: T3Source): string {
  return digest({ revision: source.revision, files: source.files })
}

/** Collect independently from a T3-reported implementation worktree, never from the worker's JSON. */
export function collectT3Candidate(
  source: T3Source,
  worktree: string,
  expectedRevision: string,
  implementationTaskId: string
): T3Candidate {
  assertT3Source(source)
  if (
    !isAbsolute(worktree) ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(expectedRevision) ||
    !implementationTaskId.trim()
  )
    throw new Error("Invalid candidate collection identity")
  if (
    realpathSync(worktree) === realpathSync(source.repository) ||
    commonDirectory(worktree) !== commonDirectory(source.repository)
  )
    throw new Error("Candidate must be a separate worktree of the admitted repository")
  const candidate = captureT3Source(worktree, expectedRevision)
  assertT3CurrentSource(candidate)
  git(worktree, ["merge-base", "--is-ancestor", source.revision, expectedRevision])
  const changedPaths = git(worktree, [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--name-only",
    "-z",
    source.revision,
    expectedRevision,
    "--"
  ])
    .toString()
    .split("\0")
    .filter(Boolean)
  if (!changedPaths.length) throw new Error("Implementation has no committed changes")
  return { revision: expectedRevision, treeDigest: treeDigest(candidate), changedPaths, implementationTaskId }
}

export interface T3VerifierPolicy {
  image: string
  /** A trusted executable baked into the immutable image, outside candidate-controlled /work. */
  argv: string[]
  timeoutMs: number
  maxSourceBytes: number
  maxFileBytes: number
}
export interface T3VerifierResult {
  evidence: T3Verification
  receipt: DockerSandboxReceipt
}

/** Trusted verifier host. The candidate is exported to a disposable directory without .git,
 * symlinks, submodules, credentials or host package directories. No host execution fallback. */
export async function verifyT3Candidate(input: {
  journal: T3Journal
  lease: T3Lease
  assignmentId: string
  source: T3Source
  candidate: T3Candidate
  policy: T3VerifierPolicy
  privateRoot: string
  signal?: AbortSignal
}): Promise<T3VerifierResult> {
  const { journal, lease, assignmentId, source, candidate, privateRoot } = input
  const policy = structuredClone(input.policy)
  assertT3Source(source)
  if (
    !/^sha256:[a-f0-9]{64}$/.test(policy.image) ||
    !policy.argv.length ||
    !/^\/opt\/autocode\/verifier\/[a-zA-Z0-9._-]+$/.test(policy.argv[0]!)
  )
    throw new Error("Immutable image with a protected verifier executable required")
  if (policy.argv.some((arg) => typeof arg !== "string" || arg.includes("\0")))
    throw new Error("Invalid verifier argument")
  for (const [key, maximum] of [
    ["timeoutMs", 600_000],
    ["maxSourceBytes", 1024 * 1024 * 1024],
    ["maxFileBytes", 64 * 1024 * 1024]
  ] as const)
    if (!Number.isSafeInteger(policy[key]) || policy[key] < 1 || policy[key] > maximum)
      throw new Error(`Invalid verifier ${key}`)
  if (!isAbsolute(privateRoot) || realpathSync(privateRoot) !== privateRoot)
    throw new Error("Canonical private verifier directory required")
  const privateDirectory = statSync(privateRoot)
  if (
    !privateDirectory.isDirectory() ||
    privateDirectory.uid !== process.getuid?.() ||
    (privateDirectory.mode & 0o077) !== 0
  )
    throw new Error("Verifier directory must be owned by this user and private (0700)")
  journal.assertOwner(lease, policy.timeoutMs + 30_000)
  const snapshot = captureT3Source(source.repository, candidate.revision)
  if (treeDigest(snapshot) !== candidate.treeDigest) throw new Error("Candidate tree changed before verification")
  if (snapshot.files.length > 20_000) throw new Error("Verifier source export exceeds file count budget")
  if (snapshot.files.some((file) => !["100644", "100755"].includes(file.mode)))
    throw new Error("Verifier cannot safely export symlinks or submodules; explicit support required")
  const effectId = `verify:${assignmentId}`
  const effect = journal.reserveEffect(lease, effectId, "protected_verification", {
    source: source.digest,
    candidate,
    policy
  })
  if (effect.status !== "prepared")
    throw new Error("Verification already attempted; reconcile retained container/evidence before a new attempt")
  const workspace = mkdtempSync(join(privateRoot, "source-"))
  let observed: DockerSandboxReceipt | null = null
  try {
    let total = 0
    for (const file of snapshot.files) {
      const size = Number(git(source.repository, ["cat-file", "-s", file.objectId]).toString().trim())
      total += size
      if (!Number.isSafeInteger(size) || size < 0 || size > policy.maxFileBytes || total > policy.maxSourceBytes)
        throw new Error("Verifier source export exceeds size budget")
      const destination = join(workspace, file.path)
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
      writeFileSync(destination, git(source.repository, ["cat-file", "blob", file.objectId], policy.maxFileBytes + 1), {
        mode: file.mode === "100755" ? 0o700 : 0o600,
        flag: "wx"
      })
    }
    journal.markEffect(lease, effectId, "prepared", "uncertain")
    const observe = async (receipt: Readonly<DockerSandboxReceipt>) => {
      observed = structuredClone(receipt)
      journal.transaction(lease, () => {
        const previous = journal.read(lease.projectId, "verification-receipt", assignmentId)
        journal.write(
          "verification-receipt",
          assignmentId,
          { candidate, policy, workspace, receipt },
          previous?.version ?? 0
        )
      })
    }
    try {
      await executeDockerSandboxedCommand(policy.argv, {
        image: policy.image,
        workspace,
        cwd: "/work",
        timeoutMs: policy.timeoutMs,
        maxBufferBytes: 1024 * 1024,
        ...(input.signal ? { signal: input.signal } : {}),
        observer: { created: observe, settled: observe }
      })
    } catch (error) {
      // A substantive nonzero is reportable only with a terminal, identity-bound receipt and verified cleanup.
      if (!observed) throw error
    }
    const receipt = observed as DockerSandboxReceipt | null
    if (
      !receipt?.identity ||
      !receipt.cid ||
      receipt.identity.id !== receipt.cid ||
      receipt.identity.image !== policy.image ||
      receipt.cleanup.status !== "VERIFIED_ABSENT" ||
      !Number.isInteger(receipt.containerExitCode)
    )
      throw new Error("Protected verification has unresolved runtime custody; reconcile before retry")
    const evidence: T3Verification = {
      revision: candidate.revision,
      treeDigest: candidate.treeDigest,
      policyDigest: digest(policy),
      receiptDigest: digest(receipt),
      isolation: "protected",
      passed: receipt.containerExitCode === 0 && !receipt.failure
    }
    journal.markEffect(lease, effectId, "uncertain", "confirmed", { evidence, receipt })
    return { evidence, receipt }
  } finally {
    // Cleanup only our generated source directory; retained journal receipts survive its removal.
    rmSync(workspace, { recursive: true, force: true })
  }
}
