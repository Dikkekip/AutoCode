import { execFile } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, relative, resolve } from "node:path"

const MAX_BLOB = 64 * 1024 * 1024
const BATCH_BYTES = 16 * 1024 * 1024
const gitEnvironment = {
  PATH: "/usr/bin:/bin",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_NO_REPLACE_OBJECTS: "1"
}
function git(root: string, args: string[], maxBuffer: number, signal?: AbortSignal, input?: string) {
  return new Promise<Buffer>((resolve, reject) => {
    const child = execFile(
      "git",
      args,
      { cwd: root, env: gitEnvironment, encoding: "buffer", maxBuffer, timeout: 30_000, ...(signal ? { signal } : {}) },
      (error, stdout) => (error ? reject(error) : resolve(stdout))
    )
    // A rejected Git process can close its input before the bounded request is written.
    child.stdin?.on("error", (error) => reject(error))
    child.stdin?.end(input)
  })
}

/** Copy only explicitly admitted committed blobs; never run filters or read working-tree content. */
export async function snapshotNativeInputs(
  root: string,
  workspace: string,
  sha: string,
  inputFiles: string[],
  signal?: AbortSignal,
  authorize: () => void = () => {}
) {
  const check = () => {
    signal?.throwIfAborted()
    authorize()
  }
  check()
  if (!/^[a-f0-9]{40,64}$/.test(sha)) throw new Error("Snapshot requires an exact commit")
  const requested = new Set(inputFiles)
  if (requested.size !== inputFiles.length) throw new Error("Duplicate sandbox input")
  const tree = await git(root, ["ls-tree", "-r", "-z", "-l", sha], 32 * 1024 * 1024, signal)
  check()
  const entries = new Map<string, { file: string; oid: string; size: number; executable: boolean }>()
  for (const entry of tree.toString("utf8").split("\0")) {
    const tab = entry.indexOf("\t")
    const file = entry.slice(tab + 1)
    if (tab < 0 || !requested.has(file)) continue
    const match = /^(100644|100755) blob ([a-f0-9]{40,64}) +(\d+)$/.exec(entry.slice(0, tab))
    if (!match) throw new Error(`Sandbox input is not a committed regular file: ${file}`)
    const size = Number(match[3])
    if (!Number.isSafeInteger(size) || size > MAX_BLOB) throw new Error(`Sandbox input exceeds blob limit: ${file}`)
    const path = relative(workspace, resolve(workspace, file))
    if (!path || path === ".." || path.startsWith("../") || isAbsolute(file) || isAbsolute(path))
      throw new Error("Sandbox input escapes snapshot")
    entries.set(file, { file, oid: match[2]!, size, executable: match[1] === "100755" })
  }
  for (const file of inputFiles)
    if (!entries.has(file)) throw new Error(`Sandbox input is not a committed regular file: ${file}`)

  const files = inputFiles.map((file) => entries.get(file)!)
  let index = 0
  while (index < files.length) {
    check()
    const batch: typeof files = []
    let bytes = 0
    while (index < files.length && batch.length < 128) {
      const next = files[index]!
      if (batch.length && bytes + next.size > BATCH_BYTES) break
      batch.push(next)
      bytes += next.size
      index++
    }
    const output = await git(
      root,
      ["cat-file", "--batch"],
      bytes + batch.length * 128,
      signal,
      batch.map((entry) => `${entry.oid}\n`).join("")
    )
    check()
    let offset = 0
    for (const entry of batch) {
      check()
      const end = output.indexOf(10, offset)
      if (end < offset || output.subarray(offset, end).toString("ascii") !== `${entry.oid} blob ${entry.size}`)
        throw new Error("Git snapshot blob identity or size mismatch")
      const start = end + 1
      offset = start + entry.size
      if (offset >= output.length || output[offset] !== 10) throw new Error("Truncated Git snapshot blob")
      const target = resolve(workspace, entry.file)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, output.subarray(start, offset), { mode: entry.executable ? 0o700 : 0o600, flag: "wx" })
      offset++
    }
    if (offset !== output.length) throw new Error("Unexpected trailing Git snapshot output")
  }
}
