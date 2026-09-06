#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join } from "node:path"
import { pathToFileURL } from "node:url"

const DEFAULT_STATE_OUTPUT = ".openclaw/state/current/release-witness.json"
const DEFAULT_NOTES_OUTPUT = ".openclaw/state/current/release-witness.md"

export const RELEASE_WITNESS_PATTERNS = [
  {
    id: "capability-witness",
    source: "https://github.com/ruvnet/ruflo",
    adaptation:
      "Record release evidence as machine-readable markers so capability drift can be checked without rerunning model ideation."
  },
  {
    id: "checkpoint-hooks",
    source: "https://github.com/ruvnet/ruflo",
    adaptation:
      "Treat release publication as a post-task checkpoint with target commit, verification, and rollback context."
  },
  {
    id: "semantic-drift",
    source: "https://github.com/ruvnet/ruflo",
    adaptation:
      "Separate exact commit matching from semantic evidence so later code movement does not hide whether a capability still exists."
  }
]

function runCapture(command, args, cwd) {
  return spawnSync(command, args, { cwd, encoding: "utf8" })
}

function requireOk(result, label) {
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || result.error?.message || "").trim()
    throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`)
  }
  return result.stdout.trim()
}

function parseArgs(argv) {
  const parsed = {
    apply: false,
    repo: null,
    targetRef: "origin/master",
    stateOutput: DEFAULT_STATE_OUTPUT,
    notesOutput: DEFAULT_NOTES_OUTPUT,
    verificationCommands: [],
    skipVerification: false
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--apply") {
      parsed.apply = true
    } else if (arg === "--repo") {
      parsed.repo = argv[++index] ?? null
    } else if (arg === "--target-ref") {
      parsed.targetRef = argv[++index] ?? parsed.targetRef
    } else if (arg === "--state-output") {
      parsed.stateOutput = argv[++index] ?? parsed.stateOutput
    } else if (arg === "--notes-output") {
      parsed.notesOutput = argv[++index] ?? parsed.notesOutput
    } else if (arg === "--verify-command") {
      const command = argv[++index]
      if (command) parsed.verificationCommands.push(command)
    } else if (arg === "--skip-verification") {
      parsed.skipVerification = true
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "Usage: node scripts/release-witness.mjs [options]",
          "",
          "Options:",
          "  --apply                       Create the GitHub release",
          "  --repo <owner/name>            GitHub repository slug",
          "  --target-ref <ref>             Git ref to release (default: origin/master)",
          "  --state-output <path>          JSON witness output path",
          "  --notes-output <path>          Markdown release notes output path",
          "  --verify-command <command>     Verification command to run before release; repeatable",
          "  --skip-verification            Do not run verification commands"
        ].join("\n")
      )
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return parsed
}

function readPackageVersion(repoRoot) {
  const packagePath = join(repoRoot, "package.json")
  const payload = JSON.parse(readFileSync(packagePath, "utf8"))
  return typeof payload.version === "string" && payload.version.trim() ? payload.version.trim() : "0.0.0"
}

/** Publication evidence must describe the exact clean checkout that ran the checks. */
export function assertReleaseSource({ targetSha, headSha, dirty, verification, apply }) {
  if (targetSha !== headSha) throw new Error("Release target differs from the checkout being verified")
  if (dirty.trim()) throw new Error("Release verification requires a clean committed checkout")
  if (apply && (!verification.length || verification.some((check) => check.skipped || check.status !== 0)))
    throw new Error("Publication requires successful, non-skipped verification")
}

export function releaseManifest(repoRoot) {
  const artifacts = []
  function visit(relative) {
    const path = join(repoRoot, relative)
    if (!existsSync(path)) return
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || entry.name === "node_modules") continue
      const child = `${relative}/${entry.name}`
      if (entry.isDirectory()) visit(child)
      else if (child.includes("/dist/") && /\.(?:js|mjs|cjs|json|ts)$/.test(child))
        artifacts.push({ path: child, sha256: hashFile(join(repoRoot, child)) })
    }
  }
  visit("packages")
  visit("apps")
  return {
    schemaVersion: 1,
    toolchain: { node: process.version, platform: process.platform, architecture: process.arch },
    dependencyGraph: { path: "pnpm-lock.yaml", sha256: hashFile(join(repoRoot, "pnpm-lock.yaml")) },
    artifacts: artifacts.sort((a, b) => a.path.localeCompare(b.path))
  }
}

function hashFile(path) {
  if (!existsSync(path)) return null
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

export function nextReleaseTag(latestTag, packageVersion) {
  const version = packageVersion.trim().replace(/^v/, "")
  const match = latestTag?.trim().match(/^v(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?$/)
  if (!match) return `v${version}.1`

  const latestBase = `${match[1]}.${match[2]}.${match[3]}`
  if (latestBase !== version) return `v${version}.1`
  return `v${latestBase}.${Number.parseInt(match[4] ?? "0", 10) + 1}`
}

function resolveCommit(repoRoot, ref) {
  const result = runCapture("git", ["rev-parse", `${ref}^{commit}`], repoRoot)
  if (result.status !== 0) return null
  return result.stdout.trim() || null
}

function remoteDefaultBranch(repoRoot) {
  const result = runCapture("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], repoRoot)
  if (result.status !== 0) return null
  return result.stdout.trim() || null
}

function fetchTarget(repoRoot, targetRef) {
  const remoteMatch = targetRef.match(/^origin\/([^~^:]+)$/)
  if (!remoteMatch) return
  requireOk(runCapture("git", ["fetch", "origin", remoteMatch[1], "--quiet"], repoRoot), "git fetch")
}

function fetchTags(repoRoot) {
  runCapture("git", ["fetch", "--tags", "--quiet"], repoRoot)
}

export function releaseCommitRefCandidates(release) {
  if (!release) return []
  const refs = []
  if (release.tagName) refs.push(`refs/tags/${release.tagName}`)
  if (release.targetCommitish) refs.push(release.targetCommitish)
  return refs
}

function resolveReleaseCommit(repoRoot, release) {
  fetchTags(repoRoot)
  for (const ref of releaseCommitRefCandidates(release)) {
    const sha = resolveCommit(repoRoot, ref)
    if (sha) return sha
  }
  return null
}

function ghArgs(repo) {
  return repo ? ["--repo", repo] : []
}

function latestPublishedRelease(repoRoot, repo) {
  const list = runCapture(
    "gh",
    ["release", "list", "--limit", "20", "--json", "tagName,isDraft,isPrerelease,publishedAt", ...ghArgs(repo)],
    repoRoot
  )
  requireOk(list, "gh release list")
  const releases = JSON.parse(list.stdout || "[]")
  const latest = Array.isArray(releases)
    ? releases.find((release) => release && !release.isDraft && !release.isPrerelease && release.tagName)
    : null
  if (!latest) return null

  const view = runCapture(
    "gh",
    ["release", "view", latest.tagName, "--json", "targetCommitish", ...ghArgs(repo)],
    repoRoot
  )
  const targetCommitish = view.status === 0 ? JSON.parse(view.stdout || "{}").targetCommitish : null
  return {
    tagName: latest.tagName,
    publishedAt: latest.publishedAt ?? null,
    targetCommitish: typeof targetCommitish === "string" ? targetCommitish : null
  }
}

function runVerificationCommands(repoRoot, commands, skipVerification) {
  if (skipVerification) {
    return commands.map((command) => ({ command, skipped: true, status: null }))
  }
  return commands.map((command) => {
    const startedAt = new Date().toISOString()
    const result = spawnSync(command, [], { cwd: repoRoot, encoding: "utf8", shell: true })
    return {
      command,
      skipped: false,
      status: result.status,
      startedAt,
      finishedAt: new Date().toISOString(),
      ok: result.status === 0
    }
  })
}

export function buildReleaseWitness(input) {
  const packageHash = hashFile(join(input.repoRoot, "package.json"))
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    dryRun: !input.apply,
    repository: input.repo,
    packageVersion: input.packageVersion,
    latestRelease: input.latestRelease,
    targetRef: input.targetRef,
    targetSha: input.targetSha,
    current: input.latestReleaseSha === input.targetSha,
    nextTag: input.nextTag,
    releaseTitle: input.releaseTitle,
    created: false,
    witnessPatterns: RELEASE_WITNESS_PATTERNS,
    manifest: releaseManifest(input.repoRoot),
    sourceMarkers: [
      {
        path: "package.json",
        sha256: packageHash,
        marker: `"version": "${input.packageVersion}"`
      },
      {
        path: "scripts/release-witness.mjs",
        sha256: hashFile(join(input.repoRoot, "scripts", "release-witness.mjs")),
        marker: "RELEASE_WITNESS_PATTERNS"
      }
    ],
    verification: input.verification
  }
}

export function releaseNotes(witness) {
  const verificationLines =
    witness.verification.length === 0
      ? ["- No verification commands were configured for this witness."]
      : witness.verification.map((entry) => {
          if (entry.skipped) return `- skipped: ${entry.command}`
          return `- ${entry.ok ? "passed" : "failed"}: ${entry.command}`
        })

  return [
    `# ${witness.releaseTitle}`,
    "",
    "OpenClaw framework release witness.",
    "",
    `- Target: ${witness.targetRef} @ ${witness.targetSha}`,
    `- Package version: ${witness.packageVersion}`,
    `- Previous release: ${witness.latestRelease?.tagName ?? "none"}`,
    "",
    "Verification:",
    ...verificationLines,
    "",
    "Borrowed orchestration patterns:",
    ...witness.witnessPatterns.map((pattern) => `- ${pattern.id}: ${pattern.adaptation}`)
  ].join("\n")
}

function writeText(path, text, repoRoot) {
  const resolved = isAbsolute(path) ? path : join(repoRoot, path)
  mkdirSync(dirname(resolved), { recursive: true })
  writeFileSync(resolved, text, "utf8")
  return resolved
}

async function main() {
  const repoRoot = process.cwd()
  const args = parseArgs(process.argv.slice(2))
  const targetRef =
    args.targetRef === "origin/default" ? (remoteDefaultBranch(repoRoot) ?? "origin/master") : args.targetRef
  fetchTarget(repoRoot, targetRef)

  const packageVersion = readPackageVersion(repoRoot)
  const latestRelease = latestPublishedRelease(repoRoot, args.repo)
  const targetSha = resolveCommit(repoRoot, targetRef)
  if (!targetSha) throw new Error(`Could not resolve target ref: ${targetRef}`)
  const sourceState = () => ({
    targetSha,
    headSha: resolveCommit(repoRoot, "HEAD"),
    dirty: requireOk(runCapture("git", ["status", "--porcelain", "--untracked-files=normal"], repoRoot), "git status")
  })
  assertReleaseSource({ ...sourceState(), verification: [], apply: false })
  const latestReleaseSha = latestRelease ? resolveReleaseCommit(repoRoot, latestRelease) : null
  const nextTag = nextReleaseTag(latestRelease?.tagName ?? null, packageVersion)
  const releaseTitle = `OpenClaw framework ${nextTag}`
  const verificationCommands = args.verificationCommands.length > 0 ? args.verificationCommands : ["pnpm ci"]
  const verification = runVerificationCommands(repoRoot, verificationCommands, args.skipVerification)
  const failedVerification = verification.find((entry) => !entry.skipped && entry.status !== 0)

  assertReleaseSource({ ...sourceState(), verification, apply: args.apply })

  const witness = buildReleaseWitness({
    repoRoot,
    apply: args.apply,
    repo: args.repo,
    packageVersion,
    latestRelease,
    latestReleaseSha,
    targetRef,
    targetSha,
    nextTag,
    releaseTitle,
    verification
  })

  if (latestReleaseSha === targetSha) {
    witness.skipped = true
    witness.reason = "latest_release_already_targets_ref"
  } else if (failedVerification) {
    witness.skipped = false
    witness.error = `verification failed: ${failedVerification.command}`
  } else if (args.apply) {
    assertReleaseSource({ ...sourceState(), verification, apply: true })
    const notesPath = writeText(args.notesOutput, releaseNotes(witness), repoRoot)
    requireOk(
      runCapture(
        "gh",
        [
          "release",
          "create",
          nextTag,
          "--target",
          targetSha,
          "--title",
          releaseTitle,
          "--notes-file",
          notesPath,
          ...ghArgs(args.repo)
        ],
        repoRoot
      ),
      "gh release create"
    )
    witness.created = true
    witness.releaseUrl = args.repo ? `https://github.com/${args.repo}/releases/tag/${nextTag}` : null
  }

  writeText(args.notesOutput, releaseNotes(witness), repoRoot)
  const statePath = writeText(args.stateOutput, `${JSON.stringify(witness, null, 2)}\n`, repoRoot)
  console.log(JSON.stringify({ ...witness, statePath }, null, 2))
  if (witness.error) process.exit(1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
