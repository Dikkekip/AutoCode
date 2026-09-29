import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { loadNativeSkillText, NATIVE_SKILL_MAX_BYTES } from "../packages/core-runtime/src/native/skill-bundle.js"
import {
  bootstrapNativeSkill,
  registerNativeSkill,
  resolveNativeSkill
} from "../packages/core-runtime/src/native/skills.js"
import { NativeEvidenceStore } from "../packages/core-runtime/src/native/store.js"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true })
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "skill-bundle-"))
  roots.push(root)
  const path = join(root, "SKILL.md")
  writeFileSync(path, "Investigate with evidence.")
  mkdirSync(join(root, "resources"))
  writeFileSync(join(root, "resources/repair.md"), "Keep previous failure evidence.")
  const manifest = (resources: unknown[]) =>
    writeFileSync(`${path}.bundle.json`, JSON.stringify({ version: 1, resources }))
  return { root, path, manifest }
}
describe("composed native skill snapshots", () => {
  it("preserves single-file digests and pins every declared resource", () => {
    const f = fixture()
    expect(loadNativeSkillText(f.path)).toBe("Investigate with evidence.")
    f.manifest(["resources/repair.md"])
    const store = new NativeEvidenceStore(join(f.root, "evidence.db"))
    try {
      const snapshot = registerNativeSkill(store, loadNativeSkillText(f.path))
      bootstrapNativeSkill(
        store,
        "board",
        snapshot.digest,
        "policy",
        { operatorId: "operator", rationale: "reviewed" },
        ["coder"]
      )
      expect(resolveNativeSkill(store, "board", f.path, "policy").text).toContain("Keep previous failure evidence.")
      writeFileSync(join(f.root, "resources/repair.md"), "Changed supporting instructions.")
      expect(() => resolveNativeSkill(store, "board", f.path, "policy")).toThrow(/promotion/)
      expect(store.get("skill-version", snapshot.digest)).toEqual(snapshot)
    } finally {
      store.close()
    }
  })
  it("rejects escapes, duplicate resources, recursive entrypoints and unsupported contracts", () => {
    const f = fixture()
    for (const paths of [
      ["../outside.md"],
      ["/outside.md"],
      ["resources\\repair.md"],
      ["resources/repair.md", "resources/repair.md"],
      ["SKILL.md"],
      [null],
      []
    ]) {
      f.manifest(paths)
      expect(() => loadNativeSkillText(f.path)).toThrow()
    }
    writeFileSync(`${f.path}.bundle.json`, JSON.stringify({ version: 2, resources: ["resources/repair.md"] }))
    expect(() => loadNativeSkillText(f.path)).toThrow(/manifest/)
  })
  it("rejects linked resources, directories, missing resources and linked manifests", () => {
    const f = fixture()
    symlinkSync(join(f.root, "resources"), join(f.root, "linked"))
    f.manifest(["linked/repair.md"])
    expect(() => loadNativeSkillText(f.path)).toThrow(/links/)
    f.manifest(["resources/missing.md"])
    expect(() => loadNativeSkillText(f.path)).toThrow()
    mkdirSync(join(f.root, "directory.md"))
    f.manifest(["directory.md"])
    expect(() => loadNativeSkillText(f.path)).toThrow(/regular/)
    rmSync(`${f.path}.bundle.json`)
    symlinkSync(join(f.root, "resources/repair.md"), `${f.path}.bundle.json`)
    expect(() => loadNativeSkillText(f.path)).toThrow(/regular/)
  })
  it("enforces a cumulative UTF-8 byte limit and rejects binary text", () => {
    const f = fixture()
    writeFileSync(f.path, "é".repeat(NATIVE_SKILL_MAX_BYTES / 2 + 1))
    expect(() => loadNativeSkillText(f.path)).toThrow(/byte budget/)
    writeFileSync(f.path, "entry")
    f.manifest(["resources/repair.md"])
    writeFileSync(join(f.root, "resources/repair.md"), "x".repeat(NATIVE_SKILL_MAX_BYTES))
    expect(() => loadNativeSkillText(f.path)).toThrow(/byte budget/)
    writeFileSync(join(f.root, "resources/repair.md"), Buffer.from([0xff]))
    expect(() => loadNativeSkillText(f.path)).toThrow()
  })
  it("loads the bundled native workflow without any sibling repositories installed", () => {
    const path = fileURLToPath(new URL("../skills/native-coding/SKILL.md", import.meta.url))
    const text = loadNativeSkillText(path)
    expect(Buffer.byteLength(text)).toBeLessThan(24_000)
    expect(text).toContain("autocode_submit")
    expect(text).toContain("Baseline")
  })
})
