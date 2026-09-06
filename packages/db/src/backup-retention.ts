import { readdirSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"

const DEFAULT_RUNTIME_BACKUP_KEEP_COUNT = 5

function runtimeBackupKeepCount(): number {
  const raw = process.env.OPENCLAW_RUNTIME_BACKUP_KEEP_COUNT
  if (!raw) return DEFAULT_RUNTIME_BACKUP_KEEP_COUNT
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RUNTIME_BACKUP_KEEP_COUNT
}

export function pruneRuntimeBackups(directory: string, prefix: string, suffix: string | null = null): void {
  const keepCount = runtimeBackupKeepCount()
  try {
    const backups = readdirSync(directory)
      .map((name) => {
        const path = join(directory, name)
        const stats = statSync(path)
        return { name, path, mtimeMs: stats.mtimeMs, isFile: stats.isFile() }
      })
      .filter(
        (entry) => entry.isFile && entry.name.startsWith(prefix) && (suffix === null || entry.name.endsWith(suffix))
      )
      .sort((left, right) => right.mtimeMs - left.mtimeMs)

    for (const backup of backups.slice(keepCount)) {
      rmSync(backup.path, { force: true })
    }
  } catch {
    // Backup pruning must never make the backup itself fail.
  }
}
