/** Read verifier definitions from operator-owned toolchains, never from a candidate. */
import { execFile } from "node:child_process"
import { readFile, realpath, stat } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"
import { promisify } from "node:util"
import { type NativeAutonomyPolicy, type NativeVerificationSandbox, nativeVerificationRuleId } from "@openclaw/domain"
import { nativeContentDigest } from "./provenance.js"
import { redactNativeSourceText } from "./source-redaction.js"
import { nativeVerificationCommands } from "./verification.js"

const exec = promisify(execFile)
const limit = 32_768
const immutableDefinitions = new Map<string, string>()

export async function readNativeVerifierDefinition(sandbox: NativeVerificationSandbox, path: string): Promise<string> {
  if (!isAbsolute(path) || path.split("/").includes("..")) throw new Error("Not an absolute verifier path")
  if (sandbox.backend === "docker") {
    if (!/^sha256:[a-f0-9]{64}$/.test(sandbox.image)) throw new Error("Verifier image is not immutable")
    const key = `${sandbox.image}:${path}`
    const cached = immutableDefinitions.get(key)
    if (cached !== undefined) return cached
    // No candidate mount, network, shell or executable from the candidate.
    const { stdout } = await exec(
      "docker",
      [
        "run",
        "--rm",
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
  files: string[],
  readDefinition = readNativeVerifierDefinition
) {
  const commands = []
  for (const command of nativeVerificationCommands(policy, files)) {
    let definition: { path: string; content?: string; sha256?: string; complete: boolean; reason?: string }
    try {
      if (!policy.verificationSandbox) throw new Error("No toolchain")
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
    } catch {
      definition = {
        path: command.argv[0]!,
        complete: false,
        reason: "Toolchain executable is not available as bounded text; do not infer its coverage from its filename."
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
