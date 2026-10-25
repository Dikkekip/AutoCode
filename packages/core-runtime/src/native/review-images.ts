import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { promisify } from "node:util"
import { inflateSync } from "node:zlib"
import { nativeGit } from "./verification.js"

const exec = promisify(execFile)
const maximumImageBytes = 2 * 1024 * 1024
const maximumImages = 16
const maximumTotalBytes = 16 * 1024 * 1024
const signature = Buffer.from("89504e470d0a1a0a", "hex")
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")

export interface NativeReviewImage {
  path: string
  side: "base" | "head"
  revision: string
  blobId: string
  sha256: string
  byteLength: number
  width: number
  height: number
  mimeType: "image/png"
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** Bounded screenshot subset: metadata-free, non-interlaced eight-bit RGB/RGBA PNGs. */
export function inspectNativeReviewPng(bytes: Buffer): { width: number; height: number } {
  if (bytes.length > maximumImageBytes || bytes.length < 57 || !bytes.subarray(0, 8).equals(signature))
    throw new Error("Review image must be a bounded PNG")
  let offset = 8
  let width = 0
  let height = 0
  let channels = 0
  let ended = false
  let seenData = false
  let dataEnded = false
  let paletteSeen = false
  const compressed: Buffer[] = []
  while (offset < bytes.length) {
    if (bytes.length - offset < 12) throw new Error("Truncated review PNG chunk")
    const length = bytes.readUInt32BE(offset)
    if (length > bytes.length - offset - 12) throw new Error("Truncated review PNG payload")
    const type = bytes.toString("ascii", offset + 4, offset + 8)
    const data = bytes.subarray(offset + 8, offset + 8 + length)
    if (
      !/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type) ||
      crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== bytes.readUInt32BE(offset + 8 + length)
    )
      throw new Error("Invalid review PNG chunk")
    if (offset === 8 && type !== "IHDR") throw new Error("Review PNG requires initial IHDR")
    if (type === "IHDR") {
      if (offset !== 8 || length !== 13) throw new Error("Invalid review PNG header")
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      channels = data[9] === 2 ? 3 : data[9] === 6 ? 4 : 0
      if (
        !width ||
        !height ||
        width > 4096 ||
        height > 4096 ||
        width * height > 16777216 ||
        data[8] !== 8 ||
        !channels ||
        data[10] ||
        data[11] ||
        data[12]
      )
        throw new Error("Unsupported review PNG dimensions or encoding")
    } else if (type === "IDAT") {
      if (dataEnded) throw new Error("Nonconsecutive review PNG image data")
      seenData = true
      compressed.push(data)
    } else if (type === "IEND") {
      if (length || !seenData || offset + 12 !== bytes.length) throw new Error("Invalid review PNG end")
      ended = true
    } else {
      // Metadata/profile compression and animation introduce additional decoders
      // and visual states. Keep unsupported chunks incomplete rather than guessing.
      if (type !== "PLTE") throw new Error("Unsupported review PNG chunk")
      if (type === "PLTE") {
        if (paletteSeen || seenData || !length || length > 768 || length % 3)
          throw new Error("Invalid review PNG palette")
        paletteSeen = true
      }
      if (seenData) dataEnded = true
    }
    offset += length + 12
  }
  if (!ended) throw new Error("Review PNG requires IEND")
  const rowBytes = width * channels
  const expectedBytes = height * (rowBytes + 1)
  const input = Buffer.concat(compressed)
  const inflated = inflateSync(input, { maxOutputLength: expectedBytes, info: true }) as unknown as {
    buffer: Buffer
    engine: { bytesWritten: number }
  }
  if (inflated.engine.bytesWritten !== input.length) throw new Error("Trailing review PNG compressed data")
  const decoded = inflated.buffer
  if (decoded.length !== expectedBytes) throw new Error("Review PNG decoded size differs from header")
  for (let row = 0; row < height; row++)
    if (decoded[row * (rowBytes + 1)]! > 4) throw new Error("Invalid review PNG row filter")
  return { width, height }
}

async function blob(root: string, blobId: string): Promise<Buffer> {
  if (!/^[a-f0-9]{40,64}$/.test(blobId) || /^0+$/.test(blobId)) throw new Error("Exact review blob required")
  const size = await nativeGit(root, "--no-replace-objects", "cat-file", "-s", blobId)
  if (!/^\d+$/.test(size) || Number(size) > maximumImageBytes) throw new Error("Review image blob exceeds byte bound")
  const result = await exec("git", ["--no-replace-objects", "cat-file", "blob", blobId], {
    cwd: root,
    timeout: 30_000,
    maxBuffer: maximumImageBytes,
    encoding: "buffer"
  })
  if (result.stdout.length !== Number(size)) throw new Error("Review blob size changed")
  return result.stdout
}

/** rawChanges must be the exact already classified, scope-checked Git raw diff. */
export async function nativeReviewImageManifest(root: string, baseSha: string, headSha: string, rawChanges: string) {
  if (![baseSha, headSha].every((sha) => /^[a-f0-9]{40,64}$/.test(sha)))
    throw new Error("Exact review revisions required")
  const committedRaw = await nativeGit(
    root,
    "--no-replace-objects",
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--raw",
    "--no-abbrev",
    "--no-renames",
    "-z",
    baseSha,
    headSha
  )
  if (committedRaw !== rawChanges) throw new Error("Image review objects differ from exact committed changes")
  const fields = rawChanges.split("\0").filter(Boolean)
  const changes = new Map<string, RegExpMatchArray>()
  if (fields.length % 2) throw new Error("Malformed classified review changes")
  for (let index = 0; index < fields.length; index += 2) {
    const match = fields[index]!.match(/^:(\d{6}) (\d{6}) ([a-f0-9]{40,64}) ([a-f0-9]{40,64}) [A-Z]$/)
    if (!match || changes.has(fields[index + 1]!)) throw new Error("Malformed classified review entry")
    changes.set(fields[index + 1]!, match)
  }
  const stat = await nativeGit(
    root,
    "--no-replace-objects",
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "--numstat",
    "-z",
    baseSha,
    headSha,
    "--"
  )
  const binaryPaths = [
    ...new Set([
      ...stat
        .split("\0")
        .filter((entry) => entry.startsWith("-\t-\t"))
        .map((entry) => entry.slice(4)),
      ...[...changes.keys()].filter((path) => path.endsWith(".png"))
    ])
  ]
  if (binaryPaths.length > maximumImages / 2)
    return {
      images: [],
      unavailable: [{ path: binaryPaths[0]!, reason: "Binary review file count exceeds bound" }],
      complete: false,
      binaryFileCount: binaryPaths.length
    }
  const images: NativeReviewImage[] = []
  const unavailable: Array<{ path: string; reason: string }> = []
  let totalBytes = 0
  for (const path of binaryPaths) {
    const metadata = changes.get(path)
    if (!metadata) throw new Error("Binary review file differs from classified changes")
    try {
      if (!path.endsWith(".png")) throw new Error("Binary review format is unsupported")
      const entries: NativeReviewImage[] = []
      for (const side of ["base", "head"] as const) {
        const before = side === "base"
        const mode = metadata[before ? 1 : 2]!
        if (mode === "000000") continue
        if (mode !== "100644") throw new Error("Review images must be ordinary nonexecutable Git files")
        if (images.length + entries.length >= maximumImages) throw new Error("Review image count exceeds bound")
        const blobId = metadata[before ? 3 : 4]!
        const bytes = await blob(root, blobId)
        totalBytes += bytes.length
        if (totalBytes > maximumTotalBytes) throw new Error("Aggregate review image bytes exceed bound")
        const dimensions = inspectNativeReviewPng(bytes)
        entries.push({
          path,
          side,
          revision: before ? baseSha : headSha,
          blobId,
          sha256: sha256(bytes),
          byteLength: bytes.length,
          ...dimensions,
          mimeType: "image/png"
        })
      }
      images.push(...entries)
    } catch (error) {
      unavailable.push({ path, reason: error instanceof Error ? error.message : "Review image unavailable" })
    }
  }
  return { images, unavailable, complete: unavailable.length === 0, binaryFileCount: binaryPaths.length }
}

export async function readNativeReviewImage(root: string, image: NativeReviewImage): Promise<Buffer> {
  const bytes = await blob(root, image.blobId)
  const dimensions = inspectNativeReviewPng(bytes)
  if (
    sha256(bytes) !== image.sha256 ||
    bytes.length !== image.byteLength ||
    dimensions.width !== image.width ||
    dimensions.height !== image.height ||
    image.mimeType !== "image/png"
  )
    throw new Error("Review image differs from committed manifest")
  return bytes
}
