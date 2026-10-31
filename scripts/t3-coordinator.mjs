import { createHash } from "node:crypto"
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, realpathSync, statSync } from "node:fs"
import { dirname, isAbsolute, relative } from "node:path"
import { loadProjectProfile, validateProjectProfile } from "../packages/project-profiles/dist/index.js"
import {
  captureT3Source,
  resolveT3Personas,
  T3Coordinator,
  T3Host,
  T3Journal,
  T3McpHttpTransport,
  T3WorkflowEngine,
  verifyT3Candidate
} from "../packages/t3-runtime/dist/index.js"

const usage =
  "Usage: node scripts/t3-coordinator.mjs <status|tick|complete|pause|freeze|resume|goal|schedule-disabled> --config /absolute/private/config.json [--workflow ID --assignment ID --wake EVENT_ID] [--reason TEXT]"
const [command, ...arguments_] = process.argv.slice(2)
if (command === "--help" || command === "help") {
  console.log(usage)
  process.exit(0)
}
const allowed = new Set(["status", "tick", "complete", "pause", "freeze", "resume", "goal", "schedule-disabled"])
if (!allowed.has(command) || arguments_.length % 2) {
  console.error(usage)
  process.exit(2)
}
const flags = new Map()
for (let i = 0; i < arguments_.length; i += 2) {
  const key = arguments_[i],
    value = arguments_[i + 1]
  if (!["--config", "--workflow", "--assignment", "--wake", "--reason"].includes(key) || flags.has(key) || !value)
    throw new Error(usage)
  flags.set(key, value)
}
const configPath = flags.get("--config")
if (!configPath || !isAbsolute(configPath)) throw new Error("An absolute private coordinator config path is required")
function readBounded(path, maxBytes) {
  if (!isAbsolute(path) || !statSync(path).isFile() || statSync(path).size > maxBytes)
    throw new Error("Invalid or oversized configured input file")
  return readFileSync(path, "utf8")
}
const config = JSON.parse(readBounded(configPath, 1024 * 1024))
for (const key of ["repository", "journalPath", "skillFile", "tokenFile", "privateVerifierRoot"])
  if (typeof config[key] !== "string" || !isAbsolute(config[key])) throw new Error(`Absolute ${key} required`)
const repository = realpathSync(config.repository)
const stateRoot = dirname(config.journalPath)
for (const directory of [stateRoot, config.privateVerifierRoot]) {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const metadata = statSync(directory)
  const fromRepository = relative(repository, realpathSync(directory))
  if (
    realpathSync(directory) !== directory ||
    metadata.uid !== process.getuid?.() ||
    (metadata.mode & 0o077) !== 0 ||
    (!fromRepository.startsWith("../") && !isAbsolute(fromRepository))
  )
    throw new Error(
      "AutoCode state and verifier directories must be canonical, private and outside the source checkout"
    )
}
const profile = config.profilePath
  ? validateProjectProfile(JSON.parse(readBounded(config.profilePath, 1024 * 1024)))
  : loadProjectProfile(config.profileId)
const journal = new T3Journal(config.journalPath)
const engine = new T3WorkflowEngine(journal, config.policy, resolveT3Personas(profile))
const host = new T3Host(
  new T3McpHttpTransport({
    endpoint: config.endpoint,
    bearerToken: async () => {
      // Explicit operator-delivered credential only. Never inspect another session's config, environment or database.
      const descriptor = openSync(config.tokenFile, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const metadata = fstatSync(descriptor)
        if (
          !metadata.isFile() ||
          metadata.uid !== process.getuid?.() ||
          (metadata.mode & 0o077) !== 0 ||
          metadata.size < 1 ||
          metadata.size > 8192
        )
          throw new Error("MCP token file must be a small regular private file owned by this user")
        return readFileSync(descriptor, "utf8").trim()
      } finally {
        closeSync(descriptor)
      }
    }
  })
)
const coordinator = new T3Coordinator(engine, host, config.coordinator)
const output = (value) => console.log(JSON.stringify(value, null, 2))
let lease
try {
  if (command === "status") output(coordinator.recoveryReport(config.projectKey))
  else if (command === "goal")
    output({
      command: coordinator.goalCommand(),
      note: "Apply in the correctly bound provider thread. Goal creation is not an MCP method."
    })
  else {
    const verifierTimeout = config.verifier?.timeoutMs ?? 15_000
    if (!Number.isSafeInteger(verifierTimeout) || verifierTimeout < 1 || verifierTimeout > 600_000)
      throw new Error("Bounded verifier timeout required")
    lease = journal.acquire(config.projectKey, Math.max(120_000, verifierTimeout + 60_000))
    if (!lease) throw new Error("Another coordinator owns this project; no work was dispatched")
    if (command === "pause" || command === "resume") {
      engine.setControl(
        lease,
        command === "pause" ? "paused" : "running",
        flags.get("--reason") ?? `Operator ${command}`
      )
      output({
        control: engine.control(config.projectKey),
        nativeGoalCommand: command === "pause" ? "/goal pause" : "/goal resume",
        note: "Goal commands are Codex-specific; no schedule was enabled or provider goal modified by this command."
      })
    } else if (command === "freeze") output(await coordinator.freeze(lease, flags.get("--reason") ?? "Operator freeze"))
    else if (command === "schedule-disabled")
      output(await coordinator.saveDisabledSchedule(lease, config.scheduleEveryMs ?? 60_000))
    else if (command === "tick") {
      const content = readBounded(config.skillFile, 256 * 1024)
      const skill = { content, digest: createHash("sha256").update(content).digest("hex") }
      const source = captureT3Source(repository)
      coordinator.researchTick(lease, source, skill.digest)
      const next = journal
        .list(config.projectKey, "workflow")
        .map((row) => row.value)
        .find((item) => {
          if (
            item.policyDigest !== engine.policyDigest ||
            !["research", "planner", "design", "implementation", "verification", "review", "release"].includes(
              item.phase
            )
          )
            return false
          const last = item.assignments.at(-1)
          return (
            !last ||
            (last.status !== "running" &&
              last.status !== "prepared" &&
              !(last.status === "completed" && !last.resultApplied))
          )
        })
      if (next)
        output({
          workflowId: next.id,
          ...(await coordinator.dispatch(lease, next.id, skill, config.dispatchEstimatedTokens ?? 2000))
        })
      else
        output({
          next: "No dispatchable responsibility. Retain pending/uncertain work and await native completion wakes; do not poll.",
          state: coordinator.recoveryReport(config.projectKey)
        })
    } else if (command === "complete") {
      const id = flags.get("--workflow"),
        assignmentId = flags.get("--assignment"),
        wakeId = flags.get("--wake")
      if (!id || !assignmentId || !wakeId)
        throw new Error(
          "complete requires --workflow, --assignment and --wake from a real T3 completion delivery; never use it as a poll loop"
        )
      const envelope = await coordinator.onCompletionWake(lease, id, assignmentId, wakeId)
      const item = engine.get(config.projectKey, id).value
      const assignment = item.assignments.find((entry) => entry.id === assignmentId)
      if (assignment.status !== "completed")
        output({ terminal: envelope, state: coordinator.recoveryReport(config.projectKey) })
      else {
        if (
          assignment.role === "verification" &&
          !assignment.resultApplied &&
          journal.effect(`verify:${assignmentId}`)?.status !== "confirmed"
        ) {
          await verifyT3Candidate({
            journal,
            lease,
            assignmentId,
            source: item.source,
            candidate: item.candidate,
            policy: config.verifier,
            privateRoot: config.privateVerifierRoot
          })
        }
        const updated = await coordinator.applyCompletedResult(lease, id, assignmentId)
        output({
          workflowId: id,
          phase: updated.phase,
          board: updated.board,
          candidateRevision: updated.candidate?.revision ?? null,
          next: "Result retained. A later coordinator turn may dispatch the next responsibility; nothing was published or merged."
        })
      }
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Coordinator failed; inspect private recovery state")
  process.exitCode = 1
} finally {
  if (lease) {
    try {
      journal.release(lease)
    } catch {
      console.error("Lease expired or changed; durable intents require reconciliation")
    }
  }
  journal.close()
}
