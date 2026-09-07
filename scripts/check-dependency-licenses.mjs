// New: dependency metadata policy, not a substitute for legal review of distribution obligations.
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"
export function validateLicenseInventory(inventory, policy, now = Date.now()) {
  if (policy?.version !== 1 || !Array.isArray(policy.allowedExpressions) || !Array.isArray(policy.exceptions))
    throw new Error("Invalid reviewed license policy")
  if (
    !inventory ||
    typeof inventory !== "object" ||
    Array.isArray(inventory) ||
    inventory.error ||
    !Object.keys(inventory).length
  )
    throw new Error("License inventory unavailable or malformed")
  const denied = []
  let packages = 0
  for (const [license, entries] of Object.entries(inventory)) {
    if (!Array.isArray(entries) || !entries.length) throw new Error("Malformed license inventory entries")
    for (const entry of entries) {
      if (typeof entry.name !== "string" || !Array.isArray(entry.versions) || !entry.versions.length)
        throw new Error("Malformed license package identity")
      packages++
      for (const version of entry.versions) {
        if (typeof version !== "string") throw new Error("Malformed license package version")
        const exception = policy.exceptions.find(
          (e) =>
            e.name === entry.name &&
            e.version === version &&
            e.license === license &&
            typeof e.approvedBy === "string" &&
            e.approvedBy.trim() &&
            typeof e.reason === "string" &&
            e.reason.trim() &&
            Date.parse(e.expiresAt) > now
        )
        if (!policy.allowedExpressions.includes(license) && !exception)
          denied.push({ name: entry.name, version, license })
      }
    }
  }
  if (denied.length) throw new Error(`Dependency license requires review: ${JSON.stringify(denied)}`)
  return { ok: true, packages, licenseExpressions: Object.keys(inventory).sort() }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const policy = JSON.parse(readFileSync("policies/dependency-licenses.json", "utf8"))
  const args = process.env.AUTOCODE_PNPM_STORE_DIR ? [`--config.store-dir=${process.env.AUTOCODE_PNPM_STORE_DIR}`] : []
  const result = spawnSync("pnpm", [...args, "licenses", "list", "--json"], {
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 8 * 1024 * 1024
  })
  if (result.status !== 0) {
    const detail = result.error?.message || result.stderr?.trim() || result.stdout?.trim() || "No diagnostic output"
    throw new Error(`License inventory failed (exit ${result.status}); no clean result is available: ${detail}`)
  }
  console.log(JSON.stringify(validateLicenseInventory(JSON.parse(result.stdout), policy), null, 2))
}
