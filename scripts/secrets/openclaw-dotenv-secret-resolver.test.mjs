import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmod, mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const resolverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "openclaw-dotenv-secret-resolver.mjs")

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "openclaw-dotenv-"))
  const envFile = path.join(directory, ".env")
  await writeFile(envFile, "ALLOWED_SECRET='safe-test-value'\nUNRELATED_SECRET=hidden\n", { mode: 0o600 })
  await chmod(envFile, 0o600)
  return envFile
}

function resolve(envFile, ids) {
  return spawnSync(process.execPath, [resolverPath, "--env-file", envFile, "--allow", "ALLOWED_SECRET"], {
    encoding: "utf8",
    input: JSON.stringify({
      protocolVersion: 1,
      provider: "test",
      ids
    })
  })
}

test("returns only explicitly allowlisted dotenv values", async () => {
  const result = resolve(await fixture(), ["ALLOWED_SECRET", "UNRELATED_SECRET"])

  assert.equal(result.status, 0)
  assert.equal(result.stderr, "")
  assert.deepEqual(JSON.parse(result.stdout), {
    protocolVersion: 1,
    values: { ALLOWED_SECRET: "safe-test-value" },
    errors: {
      UNRELATED_SECRET: { message: "secret id is not allowlisted" }
    }
  })
})

test("rejects malformed provider requests without printing a secret", async () => {
  const envFile = await fixture()
  const result = spawnSync(process.execPath, [resolverPath, "--env-file", envFile, "--allow", "ALLOWED_SECRET"], {
    encoding: "utf8",
    input: "{}"
  })

  assert.equal(result.status, 1)
  assert.equal(result.stdout, "")
  assert.match(result.stderr, /invalid secret provider request/u)
  assert.doesNotMatch(result.stderr, /safe-test-value/u)
})
