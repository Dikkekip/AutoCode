/** Read verifier definitions from operator-owned toolchains, never from a candidate. */
import { execFile } from "node:child_process"
import { readFile, realpath, stat } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"
import { promisify } from "node:util"
import {
  type NativeAutonomyPolicy,
  type NativeCommand,
  type NativeVerificationSandbox,
  nativeVerificationRuleId,
  validateNativeAutonomyPolicy
} from "@openclaw/domain"
import { historicalBa7Definitions } from "./historical-ba7-definitions.js"
import { nativeContentDigest } from "./provenance.js"
import { redactNativeSourceText } from "./source-redaction.js"
import { nativeVerificationCommands } from "./verification.js"

const exec = promisify(execFile)
const limit = 32_768
const immutableDefinitions = new Map<string, string>()

/** Fixed diagnostics only: Docker stderr can contain private daemon and registry details. */
export class NativeVerifierUnavailableError extends Error {
  constructor() {
    super("Pinned verifier image is unavailable locally; restore the reviewed toolchain before verification.")
  }
}

export async function assertNativeVerifierImageAvailable(image: string): Promise<void> {
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new NativeVerifierUnavailableError()
  try {
    const { stdout } = await exec("docker", ["image", "inspect", "--format", "{{.Id}}", image], {
      timeout: 5_000,
      maxBuffer: 1_024,
      encoding: "utf8"
    })
    if (stdout.trim() !== image) throw new NativeVerifierUnavailableError()
  } catch {
    throw new NativeVerifierUnavailableError()
  }
}

export async function readNativeVerifierDefinition(sandbox: NativeVerificationSandbox, path: string): Promise<string> {
  if (!isAbsolute(path) || path.split("/").includes("..")) throw new Error("Not an absolute verifier path")
  if (sandbox.backend === "docker") {
    if (!/^sha256:[a-f0-9]{64}$/.test(sandbox.image)) throw new Error("Verifier image is not immutable")
    // Cached source bytes do not prove that the execution toolchain still exists.
    await assertNativeVerifierImageAvailable(sandbox.image)
    const key = `${sandbox.image}:${path}`
    const cached = immutableDefinitions.get(key)
    if (cached !== undefined) return cached
    // No candidate mount, network, shell or executable from the candidate.
    const { stdout } = await exec(
      "docker",
      [
        "run",
        "--rm",
        "--pull=never",
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        "64",
        "--memory",
        "64m",
        "--entrypoint",
        "/bin/cat",
        sandbox.image,
        "--",
        path
      ],
      { timeout: 10_000, maxBuffer: limit, encoding: "utf8" }
    )
    if (immutableDefinitions.size >= 128) immutableDefinitions.clear()
    immutableDefinitions.set(key, stdout)
    return stdout
  }
  const root = await realpath(sandbox.rootFilesystem)
  const file = await realpath(resolve(root, `.${path}`))
  const rel = relative(root, file)
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new Error("Verifier escapes toolchain")
  const info = await stat(file)
  if (!info.isFile() || info.size > limit) throw new Error("Verifier definition is not a bounded file")
  return readFile(file, "utf8")
}

// This capture is historical source evidence, never an image-presence or execution receipt.
// Keep the trust anchor in reviewed FRAME source, with no policy/path override.
function historicalDefinition(sandbox: NativeVerificationSandbox, command: NativeCommand) {
  if (
    sandbox.backend !== "docker" ||
    Buffer.byteLength(historicalBa7Definitions) > 2_097_152 ||
    nativeContentDigest(historicalBa7Definitions) !== "745eb66616d78ed001b88c61f88f1cab6e4e84a26adcda66b7abd6a6200b92f9"
  )
    throw new Error("No trusted historical definition")
  const capture = JSON.parse(historicalBa7Definitions) as {
    image: string
    sourceContextId: string
    provenanceSha256: string
    auditSha256: string
    definitions: Array<{ ruleId: string; command: NativeCommand; path: string; sha256: string; content: string }>
  }
  // Compare all command fields, including absence of additional execution bounds.
  const binding = (value: NativeCommand) =>
    JSON.stringify([
      value.id,
      value.argv,
      value.cwd,
      value.timeoutSeconds,
      value.paths,
      value.idleTimeoutSeconds,
      value.outputLimitBytes
    ])
  const entry = capture.definitions.find(
    (value) => value.ruleId === nativeVerificationRuleId(command) && binding(value.command) === binding(command)
  )
  if (
    sandbox.image !== capture.image ||
    !entry ||
    entry.path !== command.argv[0] ||
    nativeContentDigest(entry.content) !== entry.sha256
  )
    throw new Error("Historical definition binding mismatch")
  return {
    source: entry.content,
    provenance: {
      kind: "historical-operator-capture" as const,
      image: capture.image,
      sourceContextId: capture.sourceContextId,
      provenanceSha256: capture.provenanceSha256,
      auditSha256: capture.auditSha256,
      scope: "top-level-definition-source-only" as const,
      imagePresenceAttested: false,
      executionAttested: false
    }
  }
}

export async function nativeVerificationCommandContext(
  policy: NativeAutonomyPolicy,
  files: string[] | null,
  readDefinition = readNativeVerifierDefinition
) {
  const commands = []
  // Before implementation, show every standing rule with its path conditions.
  // This is policy context, not a claim about the eventual candidate selection.
  const selected =
    files === null ? validateNativeAutonomyPolicy(policy).verification : nativeVerificationCommands(policy, files)
  for (const command of selected) {
    let definition: {
      path: string
      content?: string
      sha256?: string
      complete: boolean
      reason?: string
      provenance?: ReturnType<typeof historicalDefinition>["provenance"]
    }
    try {
      if (!policy.verificationSandbox) throw new Error("No toolchain")
      let source: string
      let provenance: ReturnType<typeof historicalDefinition>["provenance"] | undefined
      try {
        source = await readDefinition(policy.verificationSandbox, command.argv[0]!)
      } catch {
        // Only unavailable reads fall back. Successful malformed/redacted reads
        // must still fail the same bounded-text/redaction checks below.
        const historical = historicalDefinition(policy.verificationSandbox, command)
        source = historical.source
        provenance = historical.provenance
      }
      // biome-ignore lint/suspicious/noControlCharactersInRegex: reject binary and malformed UTF-8 definitions
      if (Buffer.byteLength(source) > limit || /[\x00-\x08\x0e-\x1f\ufffd]/.test(source))
        throw new Error("Not a bounded text definition")
      const content = redactNativeSourceText(source)
      definition = {
        path: command.argv[0]!,
        content,
        sha256: nativeContentDigest(source),
        complete: content === source,
        ...(provenance ? { provenance } : {})
      }
    } catch (error) {
      definition = {
        path: command.argv[0]!,
        complete: false,
        reason:
          error instanceof NativeVerifierUnavailableError
            ? error.message
            : "Toolchain executable is not available as bounded text; do not infer its coverage from its filename."
      }
    }
    commands.push({
      ruleId: nativeVerificationRuleId(command),
      ...command,
      definition,
      toolchain: policy.verificationSandbox?.backend === "docker" ? { image: policy.verificationSandbox.image } : null
    })
  }
  return commands
}
