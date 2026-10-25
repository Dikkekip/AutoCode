import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  buildNativeContextPack,
  readNativeExcerpt,
  searchNativeSource
} from "../packages/core-runtime/src/native/context-pack.js"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "native-context-"))
  roots.push(root)
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim()
  git("init", "-b", "main")
  git("config", "user.name", "Fixture")
  git("config", "user.email", "fixture@example.invalid")
  git("config", "commit.gpgsign", "false")
  mkdirSync(join(root, "src"))
  writeFileSync(
    join(root, "src/a.ts"),
    'import { b } from "./b.js"\n' + Array.from({ length: 1000 }, (_, i) => `// line ${i + 2}`).join("\n")
  )
  writeFileSync(join(root, "src/b.ts"), "export const b = 1\n")
  writeFileSync(join(root, "src/a.test.ts"), 'import "./a.js"\n')
  writeFileSync(join(root, "src/binary"), Buffer.from([0, 1, 2]))
  symlinkSync("../../outside", join(root, "src/link"))
  git("add", ".")
  git("commit", "-qm", "fixture")
  return { root, revision: git("rev-parse", "HEAD"), allowedPaths: ["src"] }
}
function extend(f: ReturnType<typeof fixture>, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(f.root, path, ".."), { recursive: true })
    writeFileSync(join(f.root, path), text)
  }
  execFileSync("git", ["add", "."], { cwd: f.root })
  execFileSync("git", ["commit", "-qm", "extend"], { cwd: f.root })
  f.revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: f.root, encoding: "utf8" }).trim()
  return f
}
describe("revision-bound native context", () => {
  it("locates a late literal symbol without returning source or crediting a full-file read", async () => {
    const f = extend(fixture(), {
      "src/large.py": "# introductory context\n".repeat(14000) + "def persist_detach():\n    return 42\n"
    })
    const first = await searchNativeSource(f, "src/large.py", "def persist_detach(")
    writeFileSync(join(f.root, "src/large.py"), "untrusted dirty checkout\n")
    expect(await searchNativeSource(f, "src/large.py", "def persist_detach(")).toEqual(first)
    expect(first).toMatchObject({
      revision: f.revision,
      lineNumbers: [14001],
      matchingLineCount: 1,
      truncated: false,
      navigationOnly: true,
      blobId: expect.stringMatching(/^[a-f0-9]{40}$/),
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/)
    })
    expect(first).not.toHaveProperty("content")
    const excerpt = await readNativeExcerpt(f, "src/large.py", { startLine: first.lineNumbers[0], lineCount: 2 })
    expect(excerpt.content).toContain("return 42")
    expect(excerpt.sha256).toBe(first.sha256)
    expect(excerpt.blobId).toBe(first.blobId)
  })
  it("treats patterns literally, distinguishes case and bounds matching line numbers", async () => {
    const f = extend(fixture(), { "src/search.ts": "a.*b a.*b\n".repeat(70) + "AXXB\naZZb\n" })
    const found = await searchNativeSource(f, "src/search.ts", "a.*b")
    expect(found.lineNumbers).toEqual(Array.from({ length: 50 }, (_, i) => i + 1))
    expect(found.matchingLineCount).toBe(70)
    expect(found.truncated).toBe(true)
    expect((await searchNativeSource(f, "src/search.ts", "A.*B")).matchingLineCount).toBe(0)
  })
  it("rejects unsafe queries and noncanonical or unreadable source", async () => {
    const f = extend(fixture(), { "src/oversize.ts": "x".repeat(1024 * 1024 + 1) })
    writeFileSync(join(f.root, "src/invalid-utf8"), Buffer.from([0xff, 0xfe]))
    execFileSync("git", ["add", "."], { cwd: f.root })
    execFileSync("git", ["commit", "-qm", "invalid utf8 fixture"], { cwd: f.root })
    f.revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: f.root, encoding: "utf8" }).trim()
    for (const query of ["", "   ", "x\ny", "x\ry", "x\0y", "x".repeat(129), "\u00e9".repeat(65)])
      await expect(searchNativeSource(f, "src/a.ts", query)).rejects.toThrow(/literal/)
    for (const path of ["../outside", "src/link", "src/binary", "src/oversize.ts", "src/invalid-utf8", "src/missing"])
      await expect(searchNativeSource(f, path, "x")).rejects.toThrow()
    await expect(searchNativeSource({ ...f, allowedPaths: ["src/b.ts"] }, "src/a.ts", "x")).rejects.toThrow(/scope/)
    await expect(searchNativeSource({ ...f, revision: "main" }, "src/a.ts", "x")).rejects.toThrow(/revision/)
  })
  it("ignores local replacement refs when binding search and excerpt to the assigned commit", async () => {
    const f = fixture()
    const original = f.revision
    extend(f, { "src/b.ts": "export const replacement_only = 9\n" })
    execFileSync("git", ["replace", original, f.revision], { cwd: f.root })
    const source = { ...f, revision: original }
    expect((await searchNativeSource(source, "src/b.ts", "replacement_only")).matchingLineCount).toBe(0)
    expect((await readNativeExcerpt(source, "src/b.ts")).content).toBe("export const b = 1\n")
  })
  it("reads later lines with stable content digest despite dirty checkout", async () => {
    const f = fixture()
    const first = await readNativeExcerpt(f, "src/a.ts", { startLine: 900, lineCount: 3 })
    writeFileSync(join(f.root, "src/a.ts"), "untrusted changed checkout")
    const second = await readNativeExcerpt(f, "src/a.ts", { startLine: 900, lineCount: 3 })
    expect(second).toEqual(first)
    expect(first.content).toContain("// line 900")
    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(first.nextLine).toBe(903)
    expect(first.startLine).toBe(900)
  })
  it("rejects stale refs, path escape, symlink and binary content", async () => {
    const f = fixture()
    for (const path of ["../outside", "src/link", "src/binary", "package.json"])
      await expect(readNativeExcerpt(f, path)).rejects.toThrow()
    await expect(readNativeExcerpt({ ...f, revision: "main" }, "src/a.ts")).rejects.toThrow(/revision/)
  })
  it("bounds excerpts and impact work and distinguishes literal imports from test-name hints", async () => {
    const f = fixture()
    const p = await buildNativeContextPack(f, ["src/a.ts"], { maxBytes: 256, maxFiles: 4 })
    expect(Buffer.byteLength(p.excerpts.map((x) => x.content).join(""))).toBeLessThanOrEqual(256)
    expect(p.impacts).toContainEqual(
      expect.objectContaining({ source: "src/a.ts", target: "src/b.ts", confidence: "literal-path" })
    )
    expect(p.impacts).toContainEqual(
      expect.objectContaining({ target: "src/a.test.ts", confidence: "filename-heuristic" })
    )
    expect(p.excerpts[0]!.truncated).toBe(true)
    expect(p.revision).toBe(f.revision)
  })
  it("retrieves dependencies and tests before alphabetical filler under the same file budget", async () => {
    const f = extend(fixture(), {
      "src/000-filler.ts": "// unrelated\n".repeat(200),
      "src/z-entry.ts": 'import { dep } from "./z-dep.js";\n' + "// large entry\n".repeat(500),
      "src/z-dep.ts": "export const dep = 42\n",
      "src/z-entry.test.ts": 'import "./z-entry.js"\n'
    })
    const pack = await buildNativeContextPack(f, ["src/z-entry.ts"], { maxFiles: 3, maxBytes: 1024 })
    expect(pack.excerpts.map((excerpt) => excerpt.path)).toEqual([
      "src/z-entry.ts",
      "src/z-dep.ts",
      "src/z-entry.test.ts"
    ])
    expect(pack.selection.map((entry) => entry.reason)).toEqual(["requested", "import", "test"])
    expect(pack.excerpts[1]!.content).toContain("42")
    expect(pack.budget.usedBytes).toBeLessThanOrEqual(1024)
    expect(pack.omittedFileCount).toBe(6)
  })
  it("keeps explicit paths ahead of inferred neighbors, handles cycles and labels separate test-directory hints", async () => {
    const f = extend(fixture(), {
      "src/other.ts": "// explicit\n",
      "src/b.ts": 'export { a } from "./a.js"; const unrelated = "./other.js";\n',
      "src/tests/a.spec.ts": 'import "../a.js";\n'
    })
    const pack = await buildNativeContextPack(f, ["src/a.ts", "src/other.ts", "src/a.ts"], { maxFiles: 5 })
    expect(pack.excerpts.slice(0, 2).map((entry) => entry.path)).toEqual(["src/a.ts", "src/other.ts"])
    expect(new Set(pack.excerpts.map((entry) => entry.path)).size).toBe(pack.excerpts.length)
    expect(pack.impacts).toContainEqual(expect.objectContaining({ target: "src/tests/a.spec.ts", kind: "test" }))
    expect(pack.impacts).not.toContainEqual(expect.objectContaining({ source: "src/b.ts", target: "src/other.ts" }))
  })
  it("never retrieves imports outside scope and exposes omitted explicit requests", async () => {
    const f = extend(fixture(), {
      "outside.ts": "// not authorized",
      "src/a.ts": 'import "../outside.js"; import "./missing.js";\n'
    })
    const pack = await buildNativeContextPack(f, ["src/a.ts", "src/b.ts"], { maxFiles: 1 })
    expect(pack.excerpts.map((entry) => entry.path)).toEqual(["src/a.ts"])
    expect(pack.impacts.filter((entry) => entry.kind === "import")).toEqual([])
    expect(pack.omitted).toContainEqual({ path: "src/b.ts", reason: "file budget" })
    await expect(buildNativeContextPack(f, Array(129).fill("src/a.ts"))).rejects.toThrow(/file limit/)
  })
})
