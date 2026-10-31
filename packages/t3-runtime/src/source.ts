import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { isAbsolute } from "node:path"
import { digest } from "./personas.js"

export interface T3Source {
  repository: string
  revision: string
  files: Array<{ path: string; objectId: string; mode: string }>
  digest: string
}

export function sourcePath(path: string): string {
  if (
    !path ||
    isAbsolute(path) ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.split("/").some((s) => !s || s === "." || s === "..")
  )
    throw new Error("Expected a repository-relative literal source path")
  return path
}

function git(repository: string, args: string[]): string {
  if (!isAbsolute(repository)) throw new Error("Absolute repository required")
  const bytes = execFileSync("git", ["--no-optional-locks", "-C", repository, ...args], {
    maxBuffer: 16 * 1024 * 1024,
    timeout: 10_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1" }
  })
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
}

/** A committed tree inventory, including file modes and blob identities; no working-tree data. */
export function captureT3Source(repository: string, revision = "HEAD"): T3Source {
  if (revision !== "HEAD" && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision))
    throw new Error("Expected HEAD or a full commit ID")
  const resolved = git(repository, ["rev-parse", "--verify", `${revision}^{commit}`]).trim()
  const files = git(repository, ["ls-tree", "-rz", "--full-tree", resolved])
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const match = /^(\d+) (blob|commit) ([a-f0-9]+)\t([\s\S]+)$/.exec(entry)
      if (!match) throw new Error("Unexpected Git tree entry")
      return { path: sourcePath(match[4]!), objectId: match[3]!, mode: match[1]! }
    })
  const identity = { repository, revision: resolved, files }
  return { ...identity, digest: digest(identity) }
}

export function assertT3Source(source: T3Source): void {
  const { repository, revision, files } = source
  if (
    !isAbsolute(repository) ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision) ||
    !Array.isArray(files) ||
    files.length === 0
  )
    throw new Error("Invalid committed source manifest")
  const paths = new Set<string>()
  for (const file of files) {
    sourcePath(file.path)
    if (
      paths.has(file.path) ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(file.objectId) ||
      !["100644", "100755", "120000", "160000"].includes(file.mode)
    )
      throw new Error("Invalid or duplicate source manifest entry")
    paths.add(file.path)
  }
  if (digest({ repository, revision, files }) !== source.digest) throw new Error("Source manifest digest mismatch")
}

export function assertT3CurrentSource(source: T3Source, requireClean = true): void {
  assertT3Source(source)
  if (git(source.repository, ["rev-parse", "HEAD"]).trim() !== source.revision) throw new Error("Source head moved")
  if (requireClean && git(source.repository, ["status", "--porcelain", "--untracked-files=normal"]).length)
    throw new Error("Source checkout contains uncommitted changes")
  if (captureT3Source(source.repository, source.revision).digest !== source.digest)
    throw new Error("Source inventory changed")
}

/** Read a bounded regular blob. Symlinks and gitlinks are never followed. */
export function readT3SourceFile(
  source: T3Source,
  path: string,
  maxBytes = 256 * 1024
): { content: string; digest: string } {
  assertT3Source(source)
  sourcePath(path)
  const entry = source.files.find((file) => file.path === path)
  if (!entry || !["100644", "100755"].includes(entry.mode))
    throw new Error("Source path is not a captured regular file")
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024)
    throw new Error("Invalid source read bound")
  const size = Number(git(source.repository, ["cat-file", "-s", entry.objectId]).trim())
  if (!Number.isSafeInteger(size) || size > maxBytes) throw new Error("Source blob exceeds read budget")
  const content = git(source.repository, ["cat-file", "blob", entry.objectId])
  return { content, digest: createHash("sha256").update(content).digest("hex") }
}
