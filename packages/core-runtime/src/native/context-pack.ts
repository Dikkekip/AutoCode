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
  if (paths.length > 128) throw new Error("Context requested paths exceed file limit")
  for (const path of paths) validate(source, path)
  const all = (await git(source, ["ls-tree", "-r", "--name-only", "-z", source.revision]))
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .filter((path) => source.allowedPaths.some((root) => nativePathAllowed(path, root)))
  const known = new Set(all)
  type SelectionReason = "requested" | "import" | "test" | "fallback"
  const requested = [...new Set(paths)]
  const pending = requested.map((path) => ({ path, reason: "requested" as SelectionReason, depth: 0 }))
  const queued = new Set(requested)
  const attempted = new Set<string>()
  const excerpts: Awaited<ReturnType<typeof readNativeExcerpt>>[] = []
  const selection: Array<{ path: string; reason: SelectionReason; depth: number }> = []
  const impacts: Array<{
    source: string
    target: string
    kind: "import" | "test"
    confidence: "literal-path" | "filename-heuristic"
  }> = []
  const omitted: Array<{ path: string; reason: string }> = []
  // Only enqueue related files from the committed, in-scope tree. Breadth-first
  // traversal bounds dependency depth and never displaces explicit requests.
  const enqueue = (path: string, reason: SelectionReason, depth: number) => {
    if (known.has(path) && !queued.has(path)) {
      queued.add(path)
      pending.push({ path, reason, depth })
    }
  }
  const tests = all.filter((path) => /\.(?:test|spec)\.[^/]+$/.test(path))
  const addTests = (path: string, depth: number) => {
    const stem = path.replace(/\.[^/.]+$/, "")
    const name = posix.basename(stem)
    for (const target of tests) {
      const colocated = target.startsWith(`${stem}.test.`) || target.startsWith(`${stem}.spec.`)
      const testDirectory = /(?:^|\/)(?:tests?|__tests__)\//.test(target)
      const targetName = posix.basename(target)
      if (
        colocated ||
        (testDirectory && (targetName.startsWith(`${name}.test.`) || targetName.startsWith(`${name}.spec.`)))
      ) {
        impacts.push({ source: path, target, kind: "test", confidence: "filename-heuristic" })
        enqueue(target, "test", depth)
      }
    }
  }
  for (const path of requested) addTests(path, 1)
  let remaining = maxBytes
  let fallbackIndex = 0
  const totalCandidates = all.length + requested.filter((path) => !known.has(path)).length
  while (attempted.size < maxFiles && remaining > 0) {
    if (!pending.length) {
      while (fallbackIndex < all.length && queued.has(all[fallbackIndex]!)) fallbackIndex++
      if (fallbackIndex >= all.length) break
      enqueue(all[fallbackIndex++]!, "fallback", 0)
    }
    const item = pending.shift()!
    attempted.add(item.path)
    selection.push(item)
    // Reserve room for neighboring evidence instead of allowing the first file
    // to consume the entire pack. UTF-8 clipping remains in readNativeExcerpt.
    const remainingFiles = Math.min(maxFiles - attempted.size + 1, totalCandidates - attempted.size + 1)
    const share = Math.max(1, Math.floor(remaining / Math.max(1, Math.min(8, remainingFiles))))
    let excerpt: Awaited<ReturnType<typeof readNativeExcerpt>>
    try {
      excerpt = await readNativeExcerpt(source, item.path, { maxBytes: Math.min(share, 16000) })
    } catch {
      omitted.push({ path: item.path, reason: "unavailable, non-text, linked or over 1 MiB" })
      continue
    }
    excerpts.push(excerpt)
    remaining -= Buffer.byteLength(excerpt.content)
    for (const match of excerpt.content.matchAll(
      /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)["'](\.[^"'\n]+)["']/g
    )) {
      const base = posix.normalize(posix.join(posix.dirname(item.path), match[1]!))
      const candidates = [
        base,
        base.replace(/\.js$/, ".ts"),
        base.replace(/\.js$/, ".tsx"),
        ...[".ts", ".tsx", ".js", "/index.ts", "/index.tsx", "/index.js"].map((ext) => base + ext)
      ].filter((p) => known.has(p))
      const unique = [...new Set(candidates)]
      if (unique.length === 1) {
        impacts.push({ source: item.path, target: unique[0]!, kind: "import", confidence: "literal-path" })
        if (item.depth < 2 && item.reason !== "fallback") enqueue(unique[0]!, "import", item.depth + 1)
      }
    }
    // Seeds' imports precede filename heuristics; subsequent hops remain breadth-first.
    pending.sort((a, b) => a.depth - b.depth || (a.reason === "import" ? 0 : 1) - (b.reason === "import" ? 0 : 1))
  }
  for (const item of pending) omitted.push({ path: item.path, reason: remaining < 1 ? "byte budget" : "file budget" })
  return {
    version: 1 as const,
    revision: source.revision,
    excerpts,
    impacts,
    selection,
    omitted,
    omittedFileCount: all.filter((path) => !excerpts.some((excerpt) => excerpt.path === path)).length,
    budget: { maxBytes, usedBytes: maxBytes - remaining, maxFiles },
    limitations: [
      "Literal path matching is not full language semantic resolution",
      "Dynamic expressions, truncated and omitted source are not an exhaustive impact map",
      "Related files are prioritized from bounded excerpts with at most two import hops; filename test matches are heuristic"
    ],
    untrustedContent: true
  }
}
