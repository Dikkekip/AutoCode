import { existsSync, globSync, lstatSync, readFileSync, realpathSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, isAbsolute, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const repository = fileURLToPath(new URL("../", import.meta.url))

/** Finite public grammar: string root, or literal subpaths including "." whose
 * values are strings or ordered {types, default} pairs. No other conditions. */
function publicExports(value, name) {
  const fail = () => {
    throw new Error(`Unsupported conditional workspace exports: ${name}`)
  }
  const target = (v) => {
    if (typeof v === "string") return { runtime: v, declarations: [] }
    if (
      !v ||
      Array.isArray(v) ||
      typeof v !== "object" ||
      Object.keys(v).join(",") !== "types,default" ||
      typeof v.types !== "string" ||
      typeof v.default !== "string"
    )
      return fail()
    return { runtime: v.default, declarations: [v.types] }
  }
  if (typeof value === "string") return [[".", target(value)]]
  if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, ".")) return fail()
  return Object.entries(value).map(([key, v]) => {
    if (key !== "." && !/^\.\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(key)) return fail()
    return [key, target(v)]
  })
}
function localTarget(directory, target) {
  if (
    typeof target !== "string" ||
    !target.startsWith("./") ||
    target.includes("\\") ||
    target
      .slice(2)
      .split("/")
      .some((part) => !part || part === "." || part === ".." || part === "node_modules") ||
    /[%*?#\0]/.test(target)
  )
    throw new Error("Unsafe workspace target")
  const path = resolve(directory, target)
  if (!path.startsWith(`${directory}${sep}`)) throw new Error("Escaping workspace target")
  if (!existsSync(path)) throw new Error(`Cannot find module or declaration: ${path}`)
  if (realpathSync(path) !== path || !lstatSync(path).isFile()) throw new Error(`Symlinked workspace target: ${path}`)
  return path
}

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
  // Validate public runtime and declaration files even for currently unconsumed packages.
  for (const expected of manifests) {
    if (expected.value.exports === undefined) continue
    expected.exports = publicExports(expected.value.exports, expected.value.name)
    for (const [, targets] of expected.exports) {
      localTarget(expected.directory, targets.runtime)
      for (const type of targets.declarations) localTarget(expected.directory, type)
    }
    if (Object.hasOwn(expected.value, "types")) localTarget(expected.directory, expected.value.types)
  }
  const rootPath = resolve(root, "package.json")
  const consumers = [...manifests]
  if (existsSync(rootPath)) {
    if (realpathSync(rootPath) !== rootPath) throw new Error("Foreign workspace manifest: root")
    consumers.unshift({ manifestPath: rootPath, value: JSON.parse(readFileSync(rootPath, "utf8")) })
  }
  let bindings = 0
  for (const entry of consumers) {
    const require = createRequire(entry.manifestPath)
    const declarations = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].flatMap(
      (section) => Object.entries(entry.value[section] ?? {})
    )
    for (const [name, version] of declarations) {
      if (typeof version !== "string" || !version.startsWith("workspace:")) continue
      const expected = workspaces.get(name)
      if (!expected) throw new Error(`Unknown workspace dependency: ${entry.value.name} -> ${name}`)
      const foreign = () => {
        throw new Error(
          `Foreign workspace dependency: ${entry.value.name} -> ${name}; expected ${expected.directory}. Install and rebuild this checkout.`
        )
      }
      // Resolve package identity separately: containment of one borrowed entrypoint is insufficient.
      const binding = (require.resolve.paths(name) ?? []).map((path) => resolve(path, name)).find(existsSync)
      if (
        !binding ||
        realpathSync(binding) !== expected.directory ||
        realpathSync(dirname(binding)) !== dirname(binding)
      )
        foreign()
      const manifestPath = resolve(binding, "package.json")
      if (realpathSync(manifestPath) !== expected.manifestPath) foreign()
      if (!expected.exports) throw new Error(`Unsupported conditional workspace exports: ${name}`)
      for (const [subpath, targets] of expected.exports) {
        const specifier = subpath === "." ? name : name + subpath.slice(1)
        const resolved = require.resolve(specifier)
        if (resolved !== localTarget(expected.directory, targets.runtime) || realpathSync(resolved) !== resolved)
          foreign()
      }
      bindings++
    }
  }
  return { workspaces: workspaces.size, bindings }
}

/** OpenClaw evaluates a captured runtime; source is the host-owned original entry. */
export function assertPluginWorkspaceResolution(api) {
  if (typeof api?.source !== "string" || !isAbsolute(api.source))
    throw new Error("Trusted original plugin source path required for workspace validation")
  return assertWorkspaceResolution(resolve(dirname(realpathSync(api.source)), "../.."))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  console.log(JSON.stringify({ ok: true, ...assertWorkspaceResolution() }))
