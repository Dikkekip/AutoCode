import { writeFileSync } from "node:fs"
import { isAbsolute } from "node:path"
import { loadProjectProfile, validateProjectProfile } from "../packages/project-profiles/dist/index.js"

const output = process.argv[2]
if (!output || !isAbsolute(output))
  throw new Error("Usage: node examples/t3-persona-profile.mjs /absolute/private/profile.json")
const profile = loadProjectProfile("minimal-repo")
// These roles run against this AutoCode source checkout, without an installed
// OpenClaw project's generated .openclaw tree.
for (const id of ["planner", "minimal-runtime-engineer", "qa-engineer", "code-reviewer", "release-manager"]) {
  const existing = profile.personas.find((persona) => persona.id === id)
  const reading = ["AGENTS.md", "docs/t3-autonomy.md", "docs/t3-role-contract.md", "docs/t3-validation.md"]
  if (existing) existing.requiredReading = reading
  else profile.personas.push({ id, requiredReading: reading })
}
profile.personas.push(
  {
    id: "t3-security-researcher",
    extends: "security-engineer",
    allowedLanes: ["app-core"],
    responsibilities: ["Investigate authorization boundaries from committed source"],
    requiredReading: ["AGENTS.md", "docs/t3-autonomy.md", "packages/t3-runtime/src/journal.ts"]
  },
  {
    id: "t3-performance-researcher",
    extends: "backend-engineer",
    allowedLanes: ["app-core"],
    responsibilities: ["Find measured or source-supported latency and resource bottlenecks"],
    requiredReading: ["AGENTS.md", "docs/t3-autonomy.md", "packages/t3-runtime/src/workflow.ts"]
  }
)
for (const [id, focus, ideationPrompt, weight] of [
  [
    "t3-security-researcher",
    "Authorization and isolation",
    "Inspect existing boundaries and propose one concrete source-backed fix or an explicit no-op. Do not broaden access.",
    2
  ],
  [
    "t3-performance-researcher",
    "Bounded resource use",
    "Trace an expensive source path, identify its evidence and uncertainty, and propose a measurable acceptance criterion or a no-op.",
    1
  ]
])
  profile.managerStateDefaults.managerPersonas.push({
    id,
    focus,
    ownedLaneIds: ["app-core"],
    preferredAdapterType: "codex_local",
    ideationPrompt,
    successSignals: ["Exact-source proposal accepted by an independent planner"],
    blockedEscalation: "Retain evidence and ask the project owner",
    taskQuotaWeight: weight
  })
writeFileSync(output, `${JSON.stringify(validateProjectProfile(profile), null, 2)}\n`, { mode: 0o600, flag: "wx" })
console.log(output)
