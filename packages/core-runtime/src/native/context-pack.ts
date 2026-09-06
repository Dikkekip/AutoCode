// New: bounded committed-source context. Content is untrusted data, never execution authority.
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { posix } from "node:path"
import { promisify } from "node:util"
import { nativePathAllowed } from "@openclaw/domain"

const exec = promisify(execFile)
export interface NativeContextSource {
  root: string
  revision: string
  allowedPaths: string[]
}
const hash = (content: Uint8Array | string) => createHash("sha256").update(content).digest("hex")
function validate(source: NativeContextSource, path?: string) {
  if (!/^[a-f0-9]{40,64}$/.test(source.revision)) throw new Error("Context requires an exact revision")
  if (
    path !== undefined &&
    (!path ||
      path.includes("\0") ||
      path.startsWith("/") ||
      path.split("/").some((p) => p === "." || p === "..") ||
      !source.allowedPaths.some((root) => nativePathAllowed(path, root)))
  )
    throw new Error("Context path escapes assigned scope")
}
async function git(source: NativeContextSource, args: string[], maxBuffer = 1024 * 1024) {
  validate(source)
  return (await exec("git", args, { cwd: source.root, encoding: "buffer", timeout: 10000, maxBuffer })).stdout
}
export async function readNativeExcerpt(
  source: NativeContextSource,
  path: string,
  options: { startLine?: number; lineCount?: number; maxBytes?: number } = {}
) {
  validate(source, path)
  const startLine = options.startLine ?? 1,
    lineCount = options.lineCount ?? 120,
    maxBytes = options.maxBytes ?? 16000
  if (
    ![startLine, lineCount, maxBytes].every((n) => Number.isSafeInteger(n) && n > 0) ||
    lineCount > 1000 ||
    maxBytes > 64000
  )
    throw new Error("Context range exceeds bounded line/byte limits")
  const tree = (await git(source, ["ls-tree", "-z", source.revision, "--", path])).toString("utf8")
  const match = /^(100644|100755) blob ([a-f0-9]{40,64})\t([^\0]+)\0$/.exec(tree)
  if (!match || match[3] !== path) throw new Error("Context requires a tracked regular file; links are not followed")
  const bytes = await git(source, ["cat-file", "blob", match[2]!])
  if (bytes.includes(0)) throw new Error("Context file is binary")
  let content: string
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw new Error("Context file is not UTF-8 text")
  }
  const lines = content.split("\n")
  if (startLine > lines.length) throw new Error("Context start line exceeds committed content")
  const selected = lines.slice(startLine - 1, startLine - 1 + lineCount).join("\n")
  let excerpt = "",
    size = 0
  for (const char of selected) {
    const n = Buffer.byteLength(char)
    if (size + n > maxBytes) break
    excerpt += char
    size += n
  }
  const endLine = startLine + (excerpt.match(/\n/g)?.length ?? 0)
  const truncated = excerpt.length < selected.length || startLine - 1 + lineCount < lines.length
  return {
    path,
    revision: source.revision,
    blobId: match[2]!,
    sha256: hash(bytes),
    startLine,
    endLine,
    content: excerpt,
    totalLines: lines.length,
    totalBytes: bytes.length,
    truncated,
    nextLine: truncated ? (excerpt.length < selected.length ? endLine : endLine + 1) : null,
    partialLastLine: excerpt.length < selected.length
  }
}
export async function buildNativeContextPack(
  source: NativeContextSource,
  paths: string[],
  options: { maxBytes?: number; maxFiles?: number } = {}
) {
  validate(source)
  const maxBytes = options.maxBytes ?? 48000,
    maxFiles = options.maxFiles ?? 64
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 128000 ||
    !Number.isSafeInteger(maxFiles) ||
    maxFiles < 1 ||
    maxFiles > 128
  )
    throw new Error("Context pack budget invalid")
  for (const path of paths) validate(source, path)
  const all = (await git(source, ["ls-tree", "-r", "--name-only", "-z", source.revision]))
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .filter((path) => source.allowedPaths.some((root) => nativePathAllowed(path, root)))
  const selected = [...new Set([...paths, ...all])].slice(0, maxFiles),
    known = new Set(all)
  const excerpts: Awaited<ReturnType<typeof readNativeExcerpt>>[] = []
  const impacts: Array<{
    source: string
    target: string
    kind: "import" | "test"
    confidence: "literal-path" | "filename-heuristic"
  }> = []
  const omitted: Array<{ path: string; reason: string }> = []
  let remaining = maxBytes
  for (const path of selected) {
    if (remaining < 1) {
      omitted.push({ path, reason: "byte budget" })
      continue
    }
    let excerpt: Awaited<ReturnType<typeof readNativeExcerpt>>
    try {
      excerpt = await readNativeExcerpt(source, path, { maxBytes: Math.min(remaining, 16000) })
    } catch {
      omitted.push({ path, reason: "unavailable, non-text, linked or over 1 MiB" })
      continue
    }
    excerpts.push(excerpt)
    remaining -= Buffer.byteLength(excerpt.content)
    for (const match of excerpt.content.matchAll(/(?:from\s*|import\s*|require\s*\()?["'](\.[^"'\n]+)["']/g)) {
      const base = posix.normalize(posix.join(posix.dirname(path), match[1]!))
      const candidates = [
        base,
        base.replace(/\.js$/, ".ts"),
        ...[".ts", ".tsx", ".js", "/index.ts"].map((ext) => base + ext)
      ].filter((p) => known.has(p))
      const unique = [...new Set(candidates)]
      if (unique.length === 1)
        impacts.push({ source: path, target: unique[0]!, kind: "import", confidence: "literal-path" })
    }
  }
  for (const path of paths) {
    const stem = path.replace(/\.[^/.]+$/, "")
    for (const target of all.slice(0, 1000))
      if (target.startsWith(`${stem}.test.`) || target.startsWith(`${stem}.spec.`))
        impacts.push({ source: path, target, kind: "test", confidence: "filename-heuristic" })
  }
  return {
    version: 1 as const,
    revision: source.revision,
    excerpts,
    impacts,
    omitted,
    omittedFileCount: Math.max(0, all.length - selected.length),
    budget: { maxBytes, usedBytes: maxBytes - remaining, maxFiles },
    limitations: [
      "Literal path matching is not full language semantic resolution",
      "Dynamic imports and omitted source are not an exhaustive impact map"
    ],
    untrustedContent: true
  }
}
