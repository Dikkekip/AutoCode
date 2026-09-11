import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs"
import { dirname, isAbsolute, join, relative, sep } from "node:path"

export const NATIVE_SKILL_MAX_BYTES = 512_000

/** Bounded reads reject links and special files before reading any content. */
function readText(path: string, maxBytes: number): string {
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
    throw new Error("Skill requires a regular file; links are not followed")
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    if (!fstatSync(fd).isFile() || fstatSync(fd).size > maxBytes) throw new Error("Skill exceeds byte budget")
    const bytes = Buffer.alloc(maxBytes + 1)
    let size = 0
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null)
      if (!count) break
      size += count
    }
    if (size > maxBytes) throw new Error("Skill exceeds byte budget")
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size))
    if (!text.trim() || text.includes("\0")) throw new Error("Skill must contain nonempty UTF-8 text")
    return text
  } finally {
    closeSync(fd)
  }
}

/**
 * Optional SKILL.md.bundle.json composes an explicit, ordered set of resources.
 * Every delivered byte participates in the existing immutable skill digest.
 * Plain single-file skills retain their original text and digest.
 */
export function loadNativeSkillText(path: string): string {
  const entry = readText(path, NATIVE_SKILL_MAX_BYTES)
  const manifestPath = `${path}.bundle.json`
  try {
    lstatSync(manifestPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return entry
    throw error
  }
  const manifest = JSON.parse(readText(manifestPath, 16_000))
  if (
    !manifest ||
    manifest.version !== 1 ||
    Object.keys(manifest).some((key) => !["version", "resources"].includes(key)) ||
    !Array.isArray(manifest.resources) ||
    manifest.resources.length < 1 ||
    manifest.resources.length > 16 ||
    new Set(manifest.resources).size !== manifest.resources.length
  )
    throw new Error("Invalid skill bundle manifest")
  const root = realpathSync(dirname(path))
  const resources = manifest.resources.map((resource: unknown) => {
    if (
      typeof resource !== "string" ||
      !resource.endsWith(".md") ||
      isAbsolute(resource) ||
      resource.includes("\\") ||
      resource.includes("\0") ||
      resource.split("/").some((part) => !part || part === "." || part === "..")
    )
      throw new Error("Skill resource path escapes bundle")
    let current = root
    for (const part of resource.split("/")) {
      current = join(current, part)
      if (lstatSync(current).isSymbolicLink()) throw new Error("Skill resource links are not followed")
    }
    const rel = relative(root, realpathSync(current))
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || realpathSync(current) === realpathSync(path))
      throw new Error("Skill resource path escapes bundle or includes the entrypoint")
    return { path: resource, absolutePath: current }
  })
  let text = entry
  for (const resource of resources) {
    const heading = `\n\n---\nBundled skill resource: ${resource.path}\n\n`
    const remaining = NATIVE_SKILL_MAX_BYTES - Buffer.byteLength(text) - Buffer.byteLength(heading)
    if (remaining < 1) throw new Error("Skill bundle exceeds byte budget")
    text += heading + readText(resource.absolutePath, remaining)
  }
  return text
}
