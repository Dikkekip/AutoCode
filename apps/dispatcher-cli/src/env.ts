import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

function parseEnvFile(contents: string): Array<[string, string]> {
  const entries: Array<[string, string]> = []

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue

    const separator = line.indexOf("=")
    if (separator <= 0) continue

    const key = line.slice(0, separator).trim()
    let value = line.slice(separator + 1).trim()

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    } else {
      const inlineComment = value.search(/\s+#/)
      if (inlineComment >= 0) {
        value = value.slice(0, inlineComment).trimEnd()
      }
    }

    entries.push([key, value])
  }

  return entries
}

export function loadEnvFiles(cwd = process.cwd()): void {
  const protectedKeys = new Set<string>(Object.keys(process.env).filter((key) => process.env[key] !== undefined))

  for (const filename of [".env", ".env.local"]) {
    const path = join(cwd, filename)
    if (!existsSync(path)) continue

    const entries = parseEnvFile(readFileSync(path, "utf8"))
    for (const [key, value] of entries) {
      if (protectedKeys.has(key)) continue
      process.env[key] = value
    }
  }
}
