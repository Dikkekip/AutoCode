#!/usr/bin/env node

import { lstat, readFile } from "node:fs/promises"
import path from "node:path"

const MAX_REQUEST_BYTES = 64 * 1024

function parseArguments(argv) {
  let envFile
  const allowedIds = new Set()

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === "--env-file") {
      envFile = argv[index + 1]
      index += 1
      continue
    }
    if (argument === "--allow") {
      const id = argv[index + 1]
      if (id) {
        allowedIds.add(id)
      }
      index += 1
      continue
    }
    throw new Error(`unsupported argument: ${argument}`)
  }

  if (!envFile || !path.isAbsolute(envFile)) {
    throw new Error("--env-file must be an absolute path")
  }
  if (allowedIds.size === 0) {
    throw new Error("at least one --allow id is required")
  }

  return { envFile, allowedIds }
}

async function readRequest() {
  const chunks = []
  let byteCount = 0
  for await (const chunk of process.stdin) {
    byteCount += chunk.length
    if (byteCount > MAX_REQUEST_BYTES) {
      throw new Error("request exceeds maximum size")
    }
    chunks.push(chunk)
  }

  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"))
  if (
    parsed?.protocolVersion !== 1 ||
    typeof parsed.provider !== "string" ||
    !Array.isArray(parsed.ids) ||
    parsed.ids.some((id) => typeof id !== "string")
  ) {
    throw new Error("invalid secret provider request")
  }
  return parsed
}

function parseDotenv(contents) {
  const values = new Map()
  for (const line of contents.split(/\r?\n/u)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u)
    if (!match) {
      continue
    }

    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    } else {
      value = value.replace(/\s+#.*$/u, "").trimEnd()
    }
    values.set(match[1], value)
  }
  return values
}

async function readSecureDotenv(envFile) {
  const metadata = await lstat(envFile)
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("dotenv secret source must be a regular file")
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error("dotenv secret source must be owned by the current user")
  }
  if ((metadata.mode & 0o022) !== 0) {
    throw new Error("dotenv secret source must not be group- or world-writable")
  }
  return parseDotenv(await readFile(envFile, "utf8"))
}

async function main() {
  const { envFile, allowedIds } = parseArguments(process.argv.slice(2))
  const [request, dotenv] = await Promise.all([readRequest(), readSecureDotenv(envFile)])
  const values = {}
  const errors = {}

  for (const id of request.ids) {
    if (!allowedIds.has(id)) {
      errors[id] = { message: "secret id is not allowlisted" }
      continue
    }
    const value = dotenv.get(id)
    if (!value) {
      errors[id] = { message: "secret is missing or empty" }
      continue
    }
    values[id] = value
  }

  process.stdout.write(JSON.stringify({ protocolVersion: 1, values, errors }))
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`dotenv secret resolver failed: ${message}\n`)
  process.exitCode = 1
})
