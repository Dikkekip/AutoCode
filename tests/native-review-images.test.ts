import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { deflateSync } from "node:zlib"
import { afterEach, expect, it } from "vitest"
import {
  inspectNativeReviewPng,
  nativeReviewImageManifest,
  readNativeReviewImage
} from "../packages/core-runtime/src/native/review-images.js"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function crc32(bytes: Buffer) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(type: string, data: Buffer) {
  const out = Buffer.alloc(data.length + 12)
  out.writeUInt32BE(data.length)
  out.write(type, 4)
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, out.length - 4)), out.length - 4)
  return out
}
function png(
  options: {
    width?: number
    height?: number
    depth?: number
    color?: number
    filter?: number
    rows?: Buffer
    interlace?: number
    pixel?: number
  } = {}
) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(options.width ?? 1)
  header.writeUInt32BE(options.height ?? 1, 4)
  header[8] = options.depth ?? 8
  header[9] = options.color ?? 2
  header[12] = options.interlace ?? 0
  const channels = header[9] === 6 ? 4 : 3
  const rows = options.rows ?? Buffer.from([options.filter ?? 0, ...Array(channels).fill(options.pixel ?? 100)])
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0))
  ])
}
function repository() {
  const root = mkdtempSync(join(tmpdir(), "native-review-image-"))
  roots.push(root)
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
  git("init")
  git("config", "user.name", "Synthetic reviewer fixture")
  git("config", "user.email", "fixture@example.invalid")
  writeFileSync(join(root, "view.png"), png())
  git("add", ".")
  git("commit", "-m", "base image")
  const base = git("rev-parse", "HEAD")
  const commit = () => {
    git("add", "-A")
    git("commit", "-m", "candidate image")
    const head = git("rev-parse", "HEAD")
    const raw = execFileSync(
      "git",
      ["diff", "--no-ext-diff", "--no-textconv", "--raw", "--no-abbrev", "--no-renames", "-z", base, head],
      { cwd: root, encoding: "utf8" }
    )
    return { head, raw }
  }
  return { root, git, base, commit }
}

it.each([2, 6])("accepts the supported RGB/RGBA PNG encoding %s", (color) => {
  expect(inspectNativeReviewPng(png({ color }))).toEqual({ width: 1, height: 1 })
})

it.each([
  ["signature", () => Buffer.from("not a PNG")],
  [
    "CRC",
    () => {
      const bytes = png()
      bytes[29] = bytes[29]! ^ 1
      return bytes
    }
  ],
  ["truncated chunk", () => png().subarray(0, -1)],
  ["trailing bytes", () => Buffer.concat([png(), Buffer.from("unreviewed")])],
  ["zero width", () => png({ width: 0 })],
  ["large width", () => png({ width: 4097 })],
  ["large height", () => png({ height: 4097 })],
  ["unsupported depth", () => png({ depth: 16 })],
  ["unsupported color", () => png({ color: 3 })],
  ["interlacing", () => png({ interlace: 1 })],
  ["invalid filter", () => png({ filter: 5 })],
  ["decoded rows", () => png({ rows: Buffer.from([0, 1]) })],
  ["decompression bound", () => png({ rows: Buffer.alloc(1000000) })],
  ["encoded byte bound", () => Buffer.alloc(2 * 1024 * 1024 + 1)]
] as const)("refuses %s before providing image evidence", (_name, make) => {
  expect(() => inspectNativeReviewPng(make())).toThrow()
})

it("binds both image sides to committed blobs and ignores dirty worktree bytes", async () => {
  const s = repository()
  const candidate = png({ pixel: 200 })
  writeFileSync(join(s.root, "view.png"), candidate)
  const { head, raw } = s.commit()
  writeFileSync(join(s.root, "view.png"), "UNCOMMITTED PRIVATE CONTENT")
  const manifest = await nativeReviewImageManifest(s.root, s.base, head, raw)
  expect(manifest.complete).toBe(true)
  expect(manifest.unavailable).toEqual([])
  expect(manifest.images.map((image) => [image.side, image.revision])).toEqual([
    ["base", s.base],
    ["head", head]
  ])
  expect(await readNativeReviewImage(s.root, manifest.images[0]!)).toEqual(png())
  expect(await readNativeReviewImage(s.root, manifest.images[1]!)).toEqual(candidate)
  await expect(readNativeReviewImage(s.root, { ...manifest.images[1]!, sha256: "0".repeat(64) })).rejects.toThrow(
    /differs from committed/
  )
})

it("represents image additions and deletions with only the existing side", async () => {
  const s = repository()
  s.git("rm", "view.png")
  writeFileSync(join(s.root, "new.png"), png({ pixel: 201 }))
  const { head, raw } = s.commit()
  const manifest = await nativeReviewImageManifest(s.root, s.base, head, raw)
  expect(manifest.complete).toBe(true)
  expect(manifest.images.map((image) => [image.path, image.side])).toEqual([
    ["new.png", "head"],
    ["view.png", "base"]
  ])
})

it.each([
  "unsupported extension",
  "invalid PNG",
  "oversized PNG",
  "symlink"
])("retains incomplete evidence for %s", async (kind) => {
  const s = repository()
  if (kind === "unsupported extension") {
    s.git("rm", "view.png")
    writeFileSync(join(s.root, "view.bin"), Buffer.from([0, 1, 2]))
  } else if (kind === "invalid PNG") writeFileSync(join(s.root, "view.png"), Buffer.from([0, 1, 2]))
  else if (kind === "oversized PNG") writeFileSync(join(s.root, "view.png"), Buffer.alloc(2 * 1024 * 1024 + 1))
  else {
    s.git("rm", "view.png")
    symlinkSync("outside-review-scope", join(s.root, "view.png"))
  }
  const { head, raw } = s.commit()
  const manifest = await nativeReviewImageManifest(s.root, s.base, head, raw)
  expect(manifest.complete).toBe(false)
  expect(manifest.unavailable.length).toBeGreaterThan(0)
})

it("refuses binary paths absent from the classified raw changes", async () => {
  const s = repository()
  writeFileSync(join(s.root, "view.png"), png({ pixel: 201 }))
  const { head, raw } = s.commit()
  await expect(
    nativeReviewImageManifest(s.root, s.base, head, raw.replace("view.png", "different.png"))
  ).rejects.toThrow(/differ.*committed changes|differs from classified/)
})

it("bounds file count before opening candidate image blobs", async () => {
  const s = repository()
  for (let i = 0; i < 9; i++) writeFileSync(join(s.root, `${i}.png`), png({ pixel: i }))
  const { head, raw } = s.commit()
  const manifest = await nativeReviewImageManifest(s.root, s.base, head, raw)
  expect(manifest).toEqual({
    binaryFileCount: 9,
    images: [],
    unavailable: [{ path: "0.png", reason: "Binary review file count exceeds bound" }],
    complete: false
  })
})

it("does not hide PNG inspection through a text diff attribute", async () => {
  const s = repository()
  writeFileSync(join(s.root, ".gitattributes"), "*.png diff\n")
  writeFileSync(join(s.root, "view.png"), png({ pixel: 80 }))
  const { head, raw } = s.commit()
  const manifest = await nativeReviewImageManifest(s.root, s.base, head, raw)
  expect(manifest).toMatchObject({ complete: true, binaryFileCount: 1 })
  expect(manifest.images.map((image) => image.side)).toEqual(["base", "head"])
})
it("rejects substituted raw blob identities even for the same path", async () => {
  const s = repository()
  writeFileSync(join(s.root, "view.png"), png({ pixel: 80 }))
  const { head, raw } = s.commit()
  const forged = raw.replace(/ ([a-f0-9]{40}) M\0/, " " + "a".repeat(40) + " M\0")
  expect(forged).not.toBe(raw)
  await expect(nativeReviewImageManifest(s.root, s.base, head, forged)).rejects.toThrow(/exact committed changes/)
})
it("rejects a reserved PNG chunk bit and trailing compressed data", () => {
  const image = png()
  const header = image.subarray(8, 33)
  const rows = deflateSync(Buffer.from([0, 100, 100, 100]))
  const end = chunk("IEND", Buffer.alloc(0))
  expect(() =>
    inspectNativeReviewPng(
      Buffer.concat([signatureForTest(), header, chunk("abca", Buffer.alloc(0)), chunk("IDAT", rows), end])
    )
  ).toThrow(/Invalid review PNG chunk/)
  expect(() =>
    inspectNativeReviewPng(
      Buffer.concat([signatureForTest(), header, chunk("IDAT", Buffer.concat([rows, Buffer.from("trailing")])), end])
    )
  ).toThrow(/Trailing review PNG compressed data/)
})
function signatureForTest() {
  return Buffer.from("89504e470d0a1a0a", "hex")
}

it.each(["acTL", "iCCP", "zTXt"])("keeps animation or compressed metadata chunk %s unsupported", (type) => {
  const image = png()
  const bytes = Buffer.concat([image.subarray(0, 33), chunk(type, Buffer.alloc(8)), image.subarray(33)])
  expect(() => inspectNativeReviewPng(bytes)).toThrow(/Unsupported review PNG chunk/)
})
