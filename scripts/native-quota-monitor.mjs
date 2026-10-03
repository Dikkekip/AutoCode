#!/usr/bin/env node
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { atomicState } from "./native-quota-reset.mjs"

export function validateMonitorConfig(config) {
  for (const key of ["guardConfigPath", "snapshotPath", "openclawPath", "boardId"]) {
    if (typeof config[key] !== "string" || !config[key].trim()) throw new Error(`Missing ${key}`)
  }
  for (const key of ["guardConfigPath", "snapshotPath", "openclawPath"]) {
    if (!isAbsolute(config[key])) throw new Error(`${key} must be absolute`)
  }
  if (resolve(config.guardConfigPath) === resolve(config.snapshotPath)) {
    throw new Error("Snapshot must not overwrite guard configuration")
  }
}

export async function monitor(config, dependencies = {}) {
  validateMonitorConfig(config)
  const exec = dependencies.exec ?? execFileSync
  const read = dependencies.read ?? readFileSync
  const save = dependencies.save ?? atomicState
  const now = dependencies.now ?? (() => new Date().toISOString())
  let previous
  try {
    previous = JSON.parse(read(config.snapshotPath, "utf8"))
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
  const result = JSON.parse(
    exec(
      process.execPath,
      [fileURLToPath(new URL("./native-quota-reset.mjs", import.meta.url)), "--config", config.guardConfigPath],
      { encoding: "utf8", timeout: 210000, maxBuffer: 1048576 }
    )
  )
  const snapshot = { ...result, pause: previous?.pause ?? null }
  // Never resume an operator pause or treat an uncertain reset as spent.
  if (result.action === "exhausted" && ["reset", "alreadyRedeemed"].includes(result.resetOutcome) && !snapshot.pause) {
    const response = JSON.parse(
      exec(
        config.openclawPath,
        [
          "gateway",
          "call",
          "autocode.pause",
          "--json",
          "--timeout",
          "30000",
          "--params",
          JSON.stringify({ boardId: config.boardId })
        ],
        { encoding: "utf8", timeout: 40000, maxBuffer: 1048576 }
      )
    )
    if (response.paused !== true || !response.revision) throw new Error("Native quota pause was not confirmed")
    snapshot.pause = { at: now(), revision: response.revision }
  }
  await save(config.snapshotPath, snapshot)
  return snapshot
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== "--config")
      throw new Error("Usage: native-quota-monitor.mjs --config /absolute/path/config.json")
    const config = JSON.parse(readFileSync(process.argv[3], "utf8"))
    if ([config.guardConfigPath, config.snapshotPath].some((path) => resolve(path) === resolve(process.argv[3]))) {
      throw new Error("Monitor configuration must be separate from guard configuration and snapshot")
    }
    console.log(JSON.stringify(await monitor(config)))
  } catch (error) {
    console.error(JSON.stringify({ action: "error", reason: error.message }))
    process.exitCode = 1
  }
}
