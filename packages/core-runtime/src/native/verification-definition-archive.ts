/** Explicit operator-pinned historical text. Nothing in this module executes a verifier. */
import { isUtf8 } from "node:buffer"
import { constants } from "node:fs"
import { open, realpath } from "node:fs/promises"
import { isAbsolute, relative } from "node:path"
import { type NativeAutonomyPolicy, nativeVerificationRuleId } from "@openclaw/domain"
import { nativeContentDigest } from "./provenance.js"
import { redactNativeSourceText } from "./source-redaction.js"

const maxArchive = 2 * 1024 * 1024
const maxDefinition = 32_768

export interface NativeArchivedVerifierDefinition {
  path: string
  content: string
  sha256: string
  complete: true
  provenance: {
    kind: "operator-pinned-historical-archive"
    archiveSha256: string
    sourceContextId: string
    coverage: "top-level-only"
    helperClosure: "unverified"
    executionAvailable: false
  }
}

function need(ok: unknown): asserts ok {
  if (!ok) throw new Error("Invalid operator verifier definition archive")
}
function object(value: unknown): Record<string, unknown> {
  need(value && typeof value === "object" && !Array.isArray(value))
  return value as Record<string, unknown>
}
function keys(value: Record<string, unknown>, expected: string[]) {
  need(JSON.stringify(Object.keys(value).sort()) === JSON.stringify(expected.sort()))
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)])
    )
  return value
}
function outside(root: string, file: string): boolean {
  const rel = relative(root, file)
  return rel === ".." || rel.startsWith("../") || isAbsolute(rel)
}

export async function readNativeVerificationDefinitionArchive(policy: NativeAutonomyPolicy) {
  const archive = policy.verificationDefinitionArchive
  need(archive && policy.verificationSandbox?.backend === "docker")
  need(/^sha256:[a-f0-9]{64}$/.test(policy.verificationSandbox.image))
  need(typeof process.getuid === "function" && constants.O_NOFOLLOW !== undefined)
  need(outside(policy.repository, archive.path))
  const [repository, file] = await Promise.all([realpath(policy.repository), realpath(archive.path)])
  need(file === archive.path && outside(repository, file))
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  let raw: Buffer
  try {
    const before = await handle.stat({ bigint: true })
    need(
      before.isFile() &&
        before.nlink === 1n &&
        (before.uid === BigInt(process.getuid()) || before.uid === 0n) &&
        (before.mode & 0o022n) === 0n &&
        before.size > 0n &&
        before.size <= BigInt(maxArchive)
    )
    const buffer = Buffer.alloc(maxArchive + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
      if (!bytesRead) break
      length += bytesRead
    }
    const after = await handle.stat({ bigint: true })
    need(
      length <= maxArchive &&
        BigInt(length) === before.size &&
        ["dev", "ino", "size", "mode", "uid", "nlink", "mtimeNs", "ctimeNs"].every(
          (key) => before[key as keyof typeof before] === after[key as keyof typeof after]
        )
    )
    raw = buffer.subarray(0, length)
  } finally {
    await handle.close()
  }
  need(nativeContentDigest(raw) === archive.sha256 && isUtf8(raw))
  const manifest = object(JSON.parse(raw.toString("utf8")))
  keys(manifest, [
    "schemaVersion",
    "image",
    "executionAvailable",
    "coverage",
    "helperClosure",
    "sourceContextId",
    "commands"
  ])
  need(
    manifest.schemaVersion === 1 &&
      manifest.image === policy.verificationSandbox.image &&
      manifest.executionAvailable === false &&
      manifest.coverage === "top-level-only" &&
      manifest.helperClosure === "unverified" &&
      typeof manifest.sourceContextId === "string" &&
      /^[a-f0-9]{64}$/.test(manifest.sourceContextId)
  )
  need(Array.isArray(manifest.commands) && manifest.commands.length === policy.verification.length)
  const expected = new Map(policy.verification.map((command) => [nativeVerificationRuleId(command), command]))
  need(expected.size === policy.verification.length)
  const definitions = new Map<string, NativeArchivedVerifierDefinition>()
  // Validate the entire standing set before exposing even a selected definition.
  for (const value of manifest.commands) {
    const entry = object(value)
    keys(entry, ["ruleId", "command", "definition"])
    need(typeof entry.ruleId === "string" && expected.has(entry.ruleId) && !definitions.has(entry.ruleId))
    const command = expected.get(entry.ruleId)!
    need(JSON.stringify(canonical(entry.command)) === JSON.stringify(canonical(command)))
    const definition = object(entry.definition)
    keys(definition, ["path", "content", "sha256"])
    // biome-ignore lint/suspicious/noControlCharactersInRegex: reject binary verifier text
    const binary = typeof definition.content === "string" && /[\x00-\x08\x0e-\x1f\ufffd]/.test(definition.content)
    need(
      definition.path === command.argv[0] &&
        typeof definition.content === "string" &&
        Buffer.byteLength(definition.content) <= maxDefinition &&
        !binary &&
        Buffer.from(definition.content, "utf8").toString("utf8") === definition.content &&
        redactNativeSourceText(definition.content) === definition.content &&
        definition.sha256 === nativeContentDigest(definition.content)
    )
    definitions.set(entry.ruleId, {
      path: command.argv[0]!,
      content: definition.content,
      sha256: definition.sha256 as string,
      complete: true,
      provenance: {
        kind: "operator-pinned-historical-archive",
        archiveSha256: archive.sha256,
        sourceContextId: manifest.sourceContextId,
        coverage: "top-level-only",
        helperClosure: "unverified",
        executionAvailable: false
      }
    })
  }
  return definitions
}
