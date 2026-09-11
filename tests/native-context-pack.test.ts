import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { buildNativeContextPack, readNativeExcerpt } from "../packages/core-runtime/src/native/context-pack.js"

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
