import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { test } from "node:test"

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex")
test("rebind verifies original artifacts and sources before preserving measurements", () => {
  const root = mkdtempSync(join(tmpdir(), "rebind-provenance-"))
  try {
    const source = join(root, "source.json")
    const artifact = join(root, "measurement.json")
    const policy = join(root, "policy.json")
    const database = join(root, "evidence.db")
    writeFileSync(source, "original transcript")
    const body = {
      version: 1,
      agentId: "coder",
      model: "fixture-model",
      benchmarkId: "fixture",
      datasetDigest: "a".repeat(64),
      policyDigest: "b".repeat(64),
      mode: "live",
      measuredAt: Date.now() - 1000,
      expiresAt: Date.now() + 60_000,
      capabilities: {
        contextTokens: 32000,
        structuredOutput: true,
        tools: ["read"],
        cancellation: true,
        sessionResume: true,
        costPerVerifiedOutcome: null
      },
      sources: [{ path: source, sha256: sha(readFileSync(source)) }]
    }
    const raw = JSON.stringify(body)
    writeFileSync(artifact, raw)
    const evidence = { ...body, artifact: { path: artifact, sha256: sha(raw) } }
    const evidenceId = sha(JSON.stringify(evidence))
    writeFileSync(
      policy,
      JSON.stringify({
        version: 1,
        enabled: true,
        boardId: "fixture",
        repository: root,
        repositoryKind: "application",
        baseBranch: "main",
        plannerAgentId: "planner",
        coderAgentId: "coder",
        reviewerAgentId: "reviewer",
        personas: [
          { personaId: "research", goals: ["inspect"], successObservations: ["observed"], allowedPaths: ["src"] }
        ],
        verification: [{ argv: ["true"], cwd: "." }],
        deployment: { command: { argv: ["true"], cwd: "." }, check: { argv: ["true"], cwd: "." } }
      })
    )
    const db = new DatabaseSync(database)
    db.exec("CREATE TABLE native_records(kind TEXT, id TEXT, data TEXT)")
    const put = db.prepare("INSERT INTO native_records VALUES(?,?,?)")
    put.run("capability-evidence", evidenceId, JSON.stringify(evidence))
    put.run(
      "capability-requirements",
      "fixture",
      JSON.stringify({
        policyDigest: body.policyDigest,
        roles: { coder: { evidenceId, requirements: { contextTokens: 8000, tools: ["read"] } } }
      })
    )
    db.close()
    const run = (name) =>
      spawnSync(
        process.execPath,
        ["scripts/rebind-native-capabilities.mjs", policy, database, join(root, name), "fixture-rebind"],
        { encoding: "utf8" }
      )
    writeFileSync(artifact, "tampered")
    assert.match(run("artifact-tamper").stderr, /Capability artifact changed/)
    writeFileSync(artifact, raw)
    writeFileSync(source, "tampered source")
    assert.match(run("source-tamper").stderr, /Capability source changed/)
    writeFileSync(source, "original transcript")
    const result = run("valid")
    assert.equal(result.status, 0, result.stderr)
    const rebound = JSON.parse(readFileSync(join(root, "valid", "coder.json")))
    assert.equal(rebound.measuredAt, body.measuredAt)
    assert.equal(rebound.expiresAt, body.expiresAt)
    assert.deepEqual(rebound.capabilities, body.capabilities)
    assert.deepEqual(rebound.sources, body.sources)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
