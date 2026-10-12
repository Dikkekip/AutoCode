// Rebind unchanged, unexpired live capability measurements to a reviewed policy
// digest. This does not run or claim a new benchmark.

import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { nativePolicyDigest, validateNativeAutonomyPolicy } from "../packages/domain/dist/index.js"

const [policyPath, databasePath, outputDirectory, suffix] = process.argv.slice(2)
if (!suffix) throw new Error("Usage: rebind policy.json native-evidence.db absolute-output-directory benchmark-suffix")

const policy = validateNativeAutonomyPolicy(JSON.parse(readFileSync(policyPath, "utf8")))
const policyDigest = nativePolicyDigest(policy)
const database = new DatabaseSync(databasePath, { readOnly: true })
const record = (kind, id) => {
  const row = database.prepare("SELECT data FROM native_records WHERE kind=? AND id=?").get(kind, id)
  if (!row) throw new Error(`Missing ${kind}:${id}`)
  return JSON.parse(row.data)
}
const baseline = record("capability-requirements", policy.boardId)
mkdirSync(outputDirectory, { recursive: true })
const requests = []
const roles = {}
for (const [agentId, role] of Object.entries(baseline.roles).sort(([a], [b]) => a.localeCompare(b))) {
  const prior = record("capability-evidence", role.evidenceId)
  if (prior.agentId !== agentId || prior.mode !== "live" || prior.expiresAt <= Date.now())
    throw new Error(`Cannot rebind ineligible or expired evidence for ${agentId}`)
  const artifactPath = resolve(outputDirectory, `${agentId}.json`)
  const { artifact: priorArtifact, ...measurements } = prior
  const evidenceBody = {
    ...measurements,
    benchmarkId: `${prior.benchmarkId}-${suffix}`,
    policyDigest,
    policyRebind: {
      previousPolicyDigest: prior.policyDigest,
      previousEvidenceId: role.evidenceId,
      previousArtifact: priorArtifact,
      reason:
        "Persona-loop skill binding only. Role topology, configured models, tools, requirements, original live measurements, sources, and expiry remain unchanged. No new benchmark claimed."
    }
  }
  const raw = `${JSON.stringify(evidenceBody, null, 2)}\n`
  writeFileSync(artifactPath, raw, { flag: "wx", mode: 0o600 })
  const evidence = {
    ...evidenceBody,
    artifact: { path: artifactPath, sha256: createHash("sha256").update(raw).digest("hex") }
  }
  requests.push(evidence)
  roles[agentId] = { requirements: role.requirements }
}
database.close()
writeFileSync(resolve(outputDirectory, "register-requests.json"), `${JSON.stringify(requests, null, 2)}\n`, {
  flag: "wx",
  mode: 0o600
})
writeFileSync(
  resolve(outputDirectory, "approval-template.json"),
  `${JSON.stringify({ policyDigest, requirementsPolicyDigest: baseline.policyDigest, roles }, null, 2)}\n`,
  { flag: "wx", mode: 0o600 }
)
console.log(
  JSON.stringify(
    {
      boardId: policy.boardId,
      policyDigest,
      previousPolicyDigest: baseline.policyDigest,
      evidenceCount: requests.length,
      outputDirectory: basename(outputDirectory)
    },
    null,
    2
  )
)
