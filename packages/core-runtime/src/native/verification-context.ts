/** Read verifier definitions from operator-owned toolchains, never from a candidate. */
import { execFile } from "node:child_process"
import { readFile, realpath, stat } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"
import { promisify } from "node:util"
import {
  type NativeAutonomyPolicy,
  type NativeVerificationSandbox,
  nativeVerificationRuleId,
  validateNativeAutonomyPolicy
} from "@openclaw/domain"
import { nativeContentDigest } from "./provenance.js"
import { redactNativeSourceText } from "./source-redaction.js"
import { nativeVerificationCommands } from "./verification.js"
import {
  type NativeArchivedVerifierDefinition,
  readNativeVerificationDefinitionArchive
} from "./verification-definition-archive.js"

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

export async function nativeVerificationCommandContext(
  policy: NativeAutonomyPolicy,
  files: string[] | null,
  readDefinition = readNativeVerifierDefinition
) {
  const commands = []
  // Before implementation, show every standing rule with its path conditions.
  // This is policy context, not a claim about the eventual candidate selection.
  const normalized = validateNativeAutonomyPolicy(policy)
  const selected = files === null ? normalized.verification : nativeVerificationCommands(normalized, files)
  let archived: Map<string, NativeArchivedVerifierDefinition> | undefined
  if (normalized.verificationDefinitionArchive && selected.length) {
    try {
      archived = await readNativeVerificationDefinitionArchive(normalized)
    } catch {
      // A configured archive is an explicit authority choice. Never silently
      // replace invalid archive evidence with another definition source.
    }
  }
  // Every rule shares this policy's pinned image. A missing image cannot supply
  // later definitions either; bound the failure to this context, never cache it
  // across contexts where the operator may have restored the image.
  let unavailableImage: NativeVerifierUnavailableError | undefined
  for (const command of selected) {
    let definition: {
      path: string
      content?: string
      sha256?: string
      complete: boolean
      reason?: string
      provenance?: NativeArchivedVerifierDefinition["provenance"]
    }
    try {
      if (normalized.verificationDefinitionArchive) {
        const value = archived?.get(nativeVerificationRuleId(command))
        if (!value) throw new Error("Unavailable configured archive")
        definition = value
      } else {
        if (!policy.verificationSandbox) throw new Error("No toolchain")
        if (unavailableImage) throw unavailableImage
        const source = await readDefinition(policy.verificationSandbox, command.argv[0]!)
        // biome-ignore lint/suspicious/noControlCharactersInRegex: reject binary and malformed UTF-8 definitions
        if (Buffer.byteLength(source) > limit || /[\x00-\x08\x0e-\x1f\ufffd]/.test(source))
          throw new Error("Not a bounded text definition")
        const content = redactNativeSourceText(source)
        definition = {
          path: command.argv[0]!,
          content,
          sha256: nativeContentDigest(source),
          complete: content === source
        }
      }
    } catch (error) {
      if (policy.verificationSandbox?.backend === "docker" && error instanceof NativeVerifierUnavailableError)
        unavailableImage = error
      definition = {
        path: command.argv[0]!,
        complete: false,
        reason: normalized.verificationDefinitionArchive
          ? "Configured verifier definition archive is invalid or unavailable; no fallback or execution authority."
          : error instanceof NativeVerifierUnavailableError
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
