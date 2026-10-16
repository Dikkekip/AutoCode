import { globSync, readFileSync, realpathSync } from "node:fs"
import { createRequire } from "node:module"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const repository = fileURLToPath(new URL("../", import.meta.url))

/** Reject foreign workspace packages before compiled-runtime registration or release checks. */
export function assertWorkspaceResolution(root = repository) {
  root = realpathSync(root)
  const patterns = readFileSync(resolve(root, "pnpm-workspace.yaml"), "utf8")
    .split("\n")
    .flatMap((line) => {
      const match = /^\s*-\s+(.+?)\s*$/.exec(line)
      if (!match) return []
      const pattern = match[1].replace(/^(['"])(.*)\1$/, "$2")
      if (isAbsolute(pattern) || pattern.includes("\\") || pattern.split("/").includes(".."))
        throw new Error("Unsafe workspace pattern")
      return [`${pattern}/package.json`]
    })
  if (!patterns.length) throw new Error("Workspace package patterns required")
  const manifests = [...new Set(globSync(patterns, { cwd: root }))].sort().map((path) => {
    const manifestPath = resolve(root, path)
    const directory = resolve(manifestPath, "..")
    if (
      realpathSync(directory) !== directory ||
      realpathSync(manifestPath) !== manifestPath ||
      !directory.startsWith(`${root}${sep}`)
    )
      throw new Error(`Foreign workspace manifest: ${manifestPath}`)
    return { manifestPath, directory, value: JSON.parse(readFileSync(manifestPath, "utf8")) }
  })
  const workspaces = new Map()
  for (const entry of manifests) {
    if (!entry.value.name || workspaces.has(entry.value.name)) throw new Error("Unique named workspaces required")
    workspaces.set(entry.value.name, entry)
  }
  if (!workspaces.size) throw new Error("Workspace manifests required")
  let bindings = 0
  for (const entry of manifests) {
    const require = createRequire(entry.manifestPath)
    const declarations = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].flatMap(
      (section) => Object.entries(entry.value[section] ?? {})
    )
    for (const [name, version] of declarations) {
      if (typeof version !== "string" || !version.startsWith("workspace:")) continue
      const expected = workspaces.get(name)
      if (!expected) throw new Error(`Unknown workspace dependency: ${entry.value.name} -> ${name}`)
      if (typeof expected.value.exports !== "string")
        throw new Error(`Unsupported conditional workspace exports: ${name}`)
      const resolved = realpathSync(require.resolve(name))
      const location = relative(expected.directory, resolved)
      if (!location || isAbsolute(location) || location === ".." || location.startsWith(`..${sep}`))
        throw new Error(
          `Foreign workspace dependency: ${entry.value.name} -> ${name}; expected ${expected.directory}; resolved ${resolved}. Install this checkout with pnpm install --offline --frozen-lockfile --ignore-scripts and rebuild.`
        )
      bindings++
    }
  }
  return { workspaces: workspaces.size, bindings }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  console.log(JSON.stringify({ ok: true, ...assertWorkspaceResolution() }))
