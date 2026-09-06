import { describe, expect, it } from "vitest"

import {
  assertReleaseSource,
  buildReleaseWitness,
  nextReleaseTag,
  RELEASE_WITNESS_PATTERNS,
  releaseCommitRefCandidates,
  releaseManifest,
  releaseNotes
} from "../scripts/release-witness.mjs"

describe("release witness", () => {
  it("increments fourth-part framework release tags", () => {
    expect(nextReleaseTag(null, "0.1.0")).toBe("v0.1.0.1")
    expect(nextReleaseTag("v0.1.0.1", "0.1.0")).toBe("v0.1.0.2")
    expect(nextReleaseTag("v0.1.0.9", "0.1.0")).toBe("v0.1.0.10")
    expect(nextReleaseTag("v0.0.9.4", "0.1.0")).toBe("v0.1.0.1")
  })

  it("checks the stable release tag before a moving target branch", () => {
    expect(releaseCommitRefCandidates({ tagName: "v0.1.0.24", targetCommitish: "master" })).toEqual([
      "refs/tags/v0.1.0.24",
      "master"
    ])
  })

  it("records borrowed orchestration patterns as release evidence", () => {
    expect(RELEASE_WITNESS_PATTERNS.map((pattern) => pattern.id)).toEqual(
      expect.arrayContaining(["capability-witness", "checkpoint-hooks", "semantic-drift"])
    )

    const witness = buildReleaseWitness({
      repoRoot: process.cwd(),
      apply: false,
      repo: "Dikkekip/autocode",
      packageVersion: "0.1.0",
      latestRelease: null,
      latestReleaseSha: null,
      targetRef: "origin/master",
      targetSha: "abc123",
      nextTag: "v0.1.0.1",
      releaseTitle: "OpenClaw framework v0.1.0.1",
      verification: [{ command: "pnpm build", skipped: true, status: null }]
    })
    const notes = releaseNotes(witness)

    expect(witness.witnessPatterns).toHaveLength(3)
    expect(witness.sourceMarkers.some((marker) => marker.path === "scripts/release-witness.mjs")).toBe(true)
    expect(notes).toContain("OpenClaw framework release witness")
    expect(notes).toContain("capability-witness")
  })
})

describe("exact revision release publication", () => {
  const source = {
    targetSha: "a".repeat(40),
    headSha: "a".repeat(40),
    dirty: "",
    apply: true,
    verification: [{ command: "pnpm ci", skipped: false, status: 0 }]
  }
  it("rejects checks from another revision and dirty sources", () => {
    expect(() => assertReleaseSource({ ...source, headSha: "b".repeat(40) })).toThrow(/differs/)
    expect(() => assertReleaseSource({ ...source, dirty: " M package.json" })).toThrow(/clean/)
    expect(() => assertReleaseSource({ ...source, dirty: "?? unchecked.ts" })).toThrow(/clean/)
  })
  it("rejects empty, skipped and failed checks for publication", () => {
    for (const verification of [[], [{ status: 1 }], [{ status: 0, skipped: true }]])
      expect(() => assertReleaseSource({ ...source, verification })).toThrow(/non-skipped/)
    expect(() => assertReleaseSource(source)).not.toThrow()
  })
  it("hashes dependency graph and identifies actual toolchain", () => {
    const manifest = releaseManifest(process.cwd())
    expect(manifest.dependencyGraph.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(manifest.toolchain.node).toBe(process.version)
    expect(manifest.artifacts.every((file) => file.sha256.length === 64)).toBe(true)
  })
})
