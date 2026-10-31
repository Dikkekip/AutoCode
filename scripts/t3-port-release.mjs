import { spawnSync } from "node:child_process"
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto"
import { lstatSync, readFileSync, realpathSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { assertNativeRequiredCi } from "@openclaw/core-runtime/required-ci"
import {
  assertT3CurrentSource,
  captureT3Source,
  digest,
  expectedPublicationCycle,
  T3_PUBLICATION_LIMITS as L,
  publicationEffectId,
  publicationHash,
  publicationMetadata,
  publicationOperations,
  publicationPath,
  T3_PORT_POLICY,
  T3Publication,
  validatePublicationCustody
} from "../packages/t3-runtime/dist/index.js"

// Only the established owner imports the mutation API with its current engine and lease.
// The executable surface is read-only. No config file can manufacture an owner or trust root.
export class BoundedCommandError extends Error {
  constructor(command, outcome) {
    super(
      `Bounded ${command} failed; ${outcome.terminal ? "known local termination; remote outcome requires observation" : "outcome may be uncertain"}`
    )
    this.name = "BoundedCommandError"
    this.outcome = outcome
  }
}
function processCommand(command, args, cwd, maxBytes, timeoutMs) {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > L.operationMs ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > L.assetBytes + 1
  )
    throw new Error("Invalid command resource bounds")
  const r = spawnSync(command, args, {
    cwd,
    detached: true,
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: maxBytes,
    encoding: null,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1", GH_PROMPT_DISABLED: "1" },
    input: undefined
  })
  let processGroupAbsent = false
  if (Number.isSafeInteger(r.pid) && r.pid > 0) {
    try {
      process.kill(-r.pid, 0)
    } catch (error) {
      if (error.code === "ESRCH") processGroupAbsent = true
    }
  }
  const outputLimited =
    r.error?.code === "ENOBUFS" || (r.stdout?.length ?? 0) > maxBytes || (r.stderr?.length ?? 0) > L.outputBytes
  const outcome = {
    pid: r.pid,
    exitCode: r.status,
    signal: r.signal,
    timedOut: r.error?.code === "ETIMEDOUT",
    outputLimited,
    processGroupAbsent,
    terminal:
      !r.error &&
      r.signal === null &&
      Number.isSafeInteger(r.status) &&
      r.status >= 0 &&
      !outputLimited &&
      processGroupAbsent
  }
  return { r, outcome }
}
export function boundedCommand(command, args, cwd, maxBytes = L.outputBytes, timeoutMs = L.operationMs) {
  const { r, outcome } = processCommand(command, args, cwd, maxBytes, timeoutMs)
  const explicitUnprotected =
    command === "gh" &&
    args.length === 3 &&
    args[0] === "api" &&
    args[1] === "--include" &&
    args[2] === `repos/${T3_PORT_POLICY.repository}/branches/${encodeURIComponent(T3_PORT_POLICY.branch)}/protection` &&
    r.status === 1 &&
    /^HTTP\/\S+ 404\b/.test(r.stdout?.toString() ?? "")
  if (!outcome.terminal || (r.status !== 0 && !explicitUnprotected)) throw new BoundedCommandError(command, outcome)
  return r.stdout
}

/** Runner private key never leaves this invocation closure. Only actual process outcomes are signed.
 * A surviving process group, timeout, signal, overflow or ambiguous spawn failure produces no proof.
 * Detached descendants that escape the group are outside this cooperative trusted gh boundary. */
function senderInvocation(owner, plan, index, payload, args) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519")
  const invocation = {
    id: randomUUID(),
    planDigest: plan,
    effectId: publicationEffectId(plan, index),
    index,
    payloadDigest: digest(payload),
    argvDigest: digest(["gh", ...args]),
    owner: owner.lease.owner,
    fence: owner.lease.fence,
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString()
  }
  const timeoutMs = owner.senderTimeoutMs ?? L.operationMs
  let invoked = false
  return {
    invocation,
    execute() {
      if (invoked) throw new Error("Original sender invocation cannot be retried")
      invoked = true
      const startedAt = Date.now()
      const { r, outcome } = processCommand("gh", args, owner.source.repository, L.outputBytes, timeoutMs)
      let proof = null
      if (outcome.terminal) {
        const body = {
          invocation,
          pid: outcome.pid,
          exitCode: outcome.exitCode,
          signal: null,
          timedOut: false,
          outputLimited: false,
          processGroupAbsent: true,
          startedAt,
          endedAt: Date.now()
        }
        proof = { body, signature: sign(null, Buffer.from(digest(body)), privateKey).toString("base64") }
      }
      return { proof, error: !outcome.terminal || r.status !== 0 ? new BoundedCommandError("gh", outcome) : null }
    }
  }
}
const git = (cwd, args, max) => boundedCommand("git", ["--no-optional-locks", "-C", cwd, ...args], cwd, max)
export const gh = (cwd, args, max) => boundedCommand("gh", args, cwd, max)

function json(bytes) {
  if (bytes.length > L.outputBytes) throw new Error("API response bound exceeded")
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
}
function assertRepository(repository) {
  if (repository !== T3_PORT_POLICY.repository) throw new Error("Wrong publication repository")
}
export async function requiredPortCi(repository, cwd, revision, run = gh, now = Date.now()) {
  assertRepository(repository)
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("Full candidate SHA required")
  const policy = { baseBranch: T3_PORT_POLICY.branch, requiredCi: T3_PORT_POLICY.requiredCi }
  let calls = 0
  await assertNativeRequiredCi(
    policy,
    cwd,
    revision,
    async (_cwd, args) => {
      if (++calls > L.pages) throw new Error("CI API pagination bound exceeded")
      const bound = args.map((a) => a.replace("repos/{owner}/{repo}/", `repos/${repository}/`))
      const result = await run(cwd, bound)
      if (Buffer.byteLength(result) > L.outputBytes) throw new Error("CI API response bound exceeded")
      return result.toString()
    },
    now
  )
}

async function api(cwd, repository, path, run = gh, max = L.outputBytes) {
  assertRepository(repository)
  return json(await run(cwd, ["api", `repos/${repository}${path === "" ? "" : `/${path}`}`], max))
}
async function pages(cwd, repository, path, run) {
  const all = []
  for (let n = 1; n <= L.pages; n++) {
    const batch = await api(cwd, repository, `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${n}`, run)
    if (!Array.isArray(batch) || batch.length > 100) throw new Error("Malformed API page")
    all.push(...batch)
    if (batch.length < 100) return all
  }
  throw new Error("API pagination bound exceeded")
}

/** This approved unprotected-branch disposition still discovers all fresh protections and parent rules.
 * Newly configured protection is deliberately unsupported and blocks, rather than bypassing human gates. */
export async function discoverPortPolicy(repository, cwd, revision, run = gh) {
  const repo = await api(cwd, repository, "", run)
  const branch = await api(cwd, repository, `branches/${encodeURIComponent(T3_PORT_POLICY.branch)}`, run)
  const rules = await api(cwd, repository, `rules/branches/${encodeURIComponent(T3_PORT_POLICY.branch)}`, run)
  const rulesets = await pages(cwd, repository, "rulesets?includes_parents=true", run)
  if (
    repo.full_name !== repository ||
    repo.default_branch === T3_PORT_POLICY.branch ||
    branch.name !== T3_PORT_POLICY.branch ||
    branch.commit?.sha !== revision ||
    branch.protected !== false ||
    !Array.isArray(rules) ||
    rules.length ||
    rulesets.length
  )
    throw new Error("Changed, unsupported or inaccessible branch/human protection policy")
  // --include returns an HTTP status even for an error. Distinguish explicit absence from inaccessible 404s.
  const raw = await run(cwd, [
    "api",
    "--include",
    `repos/${repository}/branches/${encodeURIComponent(T3_PORT_POLICY.branch)}/protection`
  ])
  if (Buffer.byteLength(raw) > L.outputBytes) throw new Error("Protection response bound exceeded")
  const text = raw.toString(),
    split = text.search(/\r?\n\r?\n/)
  if (
    split < 0 ||
    !/^HTTP\/\S+ 404\b/.test(text) ||
    JSON.parse(text.slice(split).trim()).message !== "Branch not protected"
  )
    throw new Error("Explicit unprotected branch observation required")
}

function octal(buffer, offset, length, n) {
  const text = n.toString(8).padStart(length - 1, "0")
  if (text.length !== length - 1) throw new Error("Tar numeric bound exceeded")
  buffer.write(text + "\0", offset, length, "ascii")
}
function header(name, mode, size) {
  const h = Buffer.alloc(512)
  h.write(name, 0, 100, "ascii")
  octal(h, 100, 8, mode)
  octal(h, 108, 8, 0)
  octal(h, 116, 8, 0)
  octal(h, 124, 12, size)
  octal(h, 136, 12, 0)
  h.fill(32, 148, 156)
  h[156] = 48
  h.write("ustar\0", 257, "ascii")
  h.write("00", 263, "ascii")
  const sum = h.reduce((a, b) => a + b, 0)
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii")
  return h
}

/** Separate strict reader, not tar's first-stream listing. Inspect every byte after EOF too. */
export function inspectPortArchive(bytes, inventory) {
  if (!Buffer.isBuffer(bytes) || bytes.length > L.archiveBytes || bytes.length % 512 || inventory.length > L.files)
    throw new Error("Archive expansion or file count bound exceeded")
  const found = new Set(),
    expected = new Map(inventory.map((x) => [x.path, x]))
  if (expected.size !== inventory.length) throw new Error("Duplicate archive inventory")
  let at = 0,
    total = 0,
    ended = false
  const number = (h, a, b) => {
    const s = h.subarray(a, b).toString("ascii")
    if (!/^[0-7]+\0 *$/.test(s)) throw new Error("Unsafe tar number")
    return Number.parseInt(s, 8)
  }
  while (at < bytes.length) {
    const h = bytes.subarray(at, at + 512)
    if (h.every((b) => b === 0)) {
      if (bytes.length - at < 1024 || !bytes.subarray(at).every((b) => b === 0))
        throw new Error("Hidden trailing tar stream or malformed EOF")
      ended = true
      break
    }
    if (h.some((b) => b > 127)) throw new Error("Non-ASCII tar header")
    const nul = h.subarray(0, 100).indexOf(0)
    const name = h.subarray(0, nul < 0 ? 100 : nul).toString("ascii")
    publicationPath(name)
    if (nul >= 0 && h.subarray(nul, 100).some((b) => b !== 0)) throw new Error("Hidden tar name suffix")
    const copy = Buffer.from(h)
    copy.fill(32, 148, 156)
    if (
      number(h, 148, 156) !== copy.reduce((a, b) => a + b, 0) ||
      h[156] !== 48 ||
      !h.subarray(257, 265).equals(Buffer.from("ustar\0" + "00")) ||
      h.subarray(157, 257).some((b) => b !== 0) ||
      h.subarray(265).some((b) => b !== 0) ||
      number(h, 108, 116) !== 0 ||
      number(h, 116, 124) !== 0 ||
      number(h, 136, 148) !== 0
    )
      throw new Error("Unsafe tar entry or extension")
    const size = number(h, 124, 136),
      mode = number(h, 100, 108),
      file = expected.get(name)
    total += size
    if (
      !file ||
      found.has(name) ||
      size > L.fileBytes ||
      total > L.totalBytes ||
      mode !== file.mode ||
      size !== file.size
    )
      throw new Error("Archive inventory or expansion mismatch")
    const end = at + 512 + size,
      padded = at + 512 + Math.ceil(size / 512) * 512
    if (
      padded > bytes.length ||
      bytes.subarray(end, padded).some((b) => b !== 0) ||
      publicationHash(bytes.subarray(at + 512, end)) !== file.sha256 ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(file.objectId) ||
      createHash(file.objectId.length === 40 ? "sha1" : "sha256")
        .update(`blob ${size}\0`)
        .update(bytes.subarray(at + 512, end))
        .digest("hex") !== file.objectId
    )
      throw new Error("Archive bytes mismatch")
    found.add(name)
    at = padded
  }
  if (!ended || found.size !== expected.size) throw new Error("Incomplete archive")
  return digest(inventory)
}

export function buildPortAssets(source, exportPolicy) {
  assertT3CurrentSource(source)
  const { revision, treeDigest, files } = exportPolicy
  if (
    revision !== source.revision ||
    treeDigest !== digest({ revision: source.revision, files: source.files }) ||
    !Array.isArray(files) ||
    !files.length ||
    files.length > L.files ||
    new Set(files).size !== files.length
  )
    throw new Error("Reviewed exact-candidate export allowlist required")
  // Build inputs are explicit; an allowlist omitting a workspace package cannot claim a buildable source archive.
  const required = source.files.filter(
    (f) =>
      /^(packages|apps)\//.test(f.path) ||
      /^(package.json|pnpm-lock.yaml|pnpm-workspace.yaml|tsconfig[^/]*\.json|docs\/t3-autonomy.md)$/.test(f.path)
  )
  if (required.some((f) => !files.includes(f.path))) throw new Error("Export omits required workspace/build inputs")
  const parts = [],
    inventory = []
  let total = 0
  for (const path of [...files].sort()) {
    publicationPath(path)
    const entry = source.files.find((f) => f.path === path)
    if (!entry || !["100644", "100755"].includes(entry.mode)) throw new Error("Export requires committed regular blobs")
    const size = Number(git(source.repository, ["cat-file", "-s", entry.objectId]).toString().trim())
    total += size
    if (!Number.isSafeInteger(size) || size < 0 || size > L.fileBytes || total > L.totalBytes)
      throw new Error("Export byte bound exceeded")
    const bytes = git(source.repository, ["cat-file", "blob", entry.objectId], L.fileBytes + 1)
    if (bytes.length !== size) throw new Error("Blob size mismatch")
    const mode = entry.mode === "100755" ? 0o755 : 0o644
    inventory.push({ path, objectId: entry.objectId, mode, size, sha256: publicationHash(bytes) })
    parts.push(header(path, mode, size), bytes, Buffer.alloc((512 - (size % 512)) % 512))
  }
  parts.push(Buffer.alloc(1024))
  const archive = Buffer.concat(parts)
  const inventoryDigest = inspectPortArchive(archive, inventory)
  const archiveName = `autocode-t3-${source.revision}.tar`
  const manifest = Buffer.from(
    JSON.stringify(
      {
        format: "source",
        revision,
        treeDigest,
        exportPolicyDigest: digest(exportPolicy),
        build: ["pnpm install --frozen-lockfile", "pnpm build"],
        inventory,
        archive: { name: archiveName, sha256: publicationHash(archive) }
      },
      null,
      2
    ) + "\n"
  )
  if (manifest.length > L.outputBytes) throw new Error("Manifest output bound exceeded")
  const checksums = Buffer.from(
    `${publicationHash(archive)}  ${archiveName}\n${publicationHash(manifest)}  manifest.json\n`
  )
  return {
    assets: [
      { name: archiveName, bytes: archive },
      { name: "manifest.json", bytes: manifest },
      { name: "SHA256SUMS", bytes: checksums }
    ],
    inventoryDigest
  }
}

async function remote(cwd, identity, run, download = true) {
  const repository = identity.repository
  const refs = await pages(cwd, repository, `git/matching-refs/tags/${encodeURIComponent(identity.tag)}`, run)
  const matches = refs.filter((r) => r.ref === `refs/tags/${identity.tag}`)
  let revision = null
  if (matches.length > 1) throw new Error("Ambiguous tag")
  if (matches.length === 1) {
    let object = matches[0].object
    for (let n = 0; object.type === "tag"; n++) {
      if (n >= L.pages || !/^[a-f0-9]{40}$/.test(object.sha)) throw new Error("Tag peel bound exceeded")
      object = (await api(cwd, repository, `git/tags/${object.sha}`, run)).object
    }
    if (object.type !== "commit" || !/^[a-f0-9]{40}$/.test(object.sha)) throw new Error("Malformed peeled tag")
    revision = object.sha
  }
  const releases = await pages(cwd, repository, "releases", run)
  const selected = releases.filter((r) => r.tag_name === identity.tag)
  if (selected.length > 1) throw new Error("Ambiguous release")
  const stable = await api(cwd, repository, "releases/latest", run)
  if (
    stable.id !== T3_PORT_POLICY.stableLatest.id ||
    stable.tag_name !== T3_PORT_POLICY.stableLatest.tag ||
    stable.prerelease ||
    stable.draft
  )
    throw new Error("Stable latest changed")
  const release = selected[0] ?? null,
    assets = []
  if (release) {
    if (!Number.isSafeInteger(release.id) || release.id < 1) throw new Error("Malformed release identity")
    const listed = await pages(cwd, repository, `releases/${release.id}/assets`, run)
    if (listed.length > L.assets) throw new Error("Remote asset count bound exceeded")
    for (const a of listed) {
      const expected = identity.assets.find((x) => x.name === a.name)
      if (!expected || a.size !== expected.size || a.size > L.assetBytes || !Number.isSafeInteger(a.id) || a.id < 1)
        throw new Error("Unexpected remote asset or size bound exceeded")
      if (download) {
        const bytes = await run(
          cwd,
          ["api", "-H", "Accept: application/octet-stream", `repos/${repository}/releases/assets/${a.id}`],
          L.assetBytes + 1
        )
        if (bytes.length !== a.size || publicationHash(bytes) !== expected.sha256)
          throw new Error("Downloaded asset mismatch")
      }
      assets.push({ name: a.name, size: a.size, sha256: expected.sha256, id: a.id })
    }
  }
  return {
    repository,
    tag: identity.tag,
    revision,
    stableLatest: { id: stable.id, tag: stable.tag_name },
    release: release && {
      id: release.id,
      tag: release.tag_name,
      target: release.target_commitish,
      prerelease: release.prerelease,
      draft: release.draft,
      title: release.name,
      body: release.body
    },
    assets,
    observedAt: Date.now()
  }
}

export function operationArguments(identity, index, assetPath) {
  const op = identity.operations[index]
  if (op?.kind === "tag")
    return [
      "api",
      "--method",
      "POST",
      `repos/${identity.repository}/git/refs`,
      "-f",
      `ref=refs/tags/${identity.tag}`,
      "-f",
      `sha=${identity.revision}`
    ]
  if (op?.kind === "release")
    return [
      "release",
      "create",
      identity.tag,
      "--repo",
      identity.repository,
      "--target",
      identity.revision,
      "--verify-tag",
      "--prerelease",
      "--latest=false",
      "--title",
      op.payload.title,
      "--notes",
      op.payload.notes
    ]
  if (op?.kind === "asset" && assetPath)
    return ["release", "upload", identity.tag, assetPath, "--repo", identity.repository]
  throw new Error("Invalid publication operation arguments")
}

function current(owner, identity) {
  const { engine, lease, source, attestation, trustedPublicKey } = owner
  new T3Publication(engine).gate(lease)
  assertT3CurrentSource(source)
  const actual = captureT3Source(source.repository, identity.revision)
  if (
    actual.revision !== source.revision ||
    digest({ revision: actual.revision, files: actual.files }) !== identity.treeDigest ||
    git(source.repository, ["branch", "--show-current"]).toString().trim() !== identity.branch
  )
    throw new Error("Dirty, moved or wrong-branch publication candidate")
  const workflow = engine.get(lease.projectId, identity.workflowId).value
  git(source.repository, ["merge-base", "--is-ancestor", workflow.source.revision, identity.revision])
  const paths = git(source.repository, [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--name-only",
    "-z",
    workflow.source.revision,
    identity.revision,
    "--"
  ])
    .toString()
    .split("\0")
    .filter(Boolean)
    .sort()
  if (
    digest(paths) !== digest([...workflow.candidate.changedPaths].sort()) ||
    paths.some((p) => !identity.scope.some((s) => p === s || p.startsWith(`${s}/`)))
  )
    throw new Error("Publication changed-path custody mismatch")
  if (
    validatePublicationCustody(engine, lease.projectId, identity.workflowId, attestation, trustedPublicKey) !==
      identity.evidenceDigest ||
    !attestation.body.authorization.tags.includes(identity.tag) ||
    attestation.body.exportPolicyDigest !== identity.exportPolicyDigest ||
    attestation.body.release?.title !== identity.title ||
    attestation.body.release?.notesSha256 !== publicationHash(identity.notes)
  )
    throw new Error("Publication custody changed or tag unauthorized")
}

export async function preparePortPublication(
  owner,
  workflowId,
  tag,
  exportPolicy,
  run = gh,
  metadata = publicationMetadata(owner.source.revision, tag)
) {
  const { engine, lease, source, attestation, trustedPublicKey } = owner
  const w = engine.get(lease.projectId, workflowId).value
  const evidenceDigest = validatePublicationCustody(engine, lease.projectId, workflowId, attestation, trustedPublicKey)
  const base = {
    projectId: lease.projectId,
    workflowId,
    revision: source.revision,
    treeDigest: w.candidate.treeDigest,
    scope: w.proposal.scope,
    estimatedTokens: w.proposal.estimatedTokens,
    workflowPolicyDigest: w.policyDigest,
    publicationPolicyDigest: digest(T3_PORT_POLICY),
    exportPolicyDigest: digest(exportPolicy),
    evidenceDigest,
    repository: T3_PORT_POLICY.repository,
    branch: T3_PORT_POLICY.branch,
    tag,
    ...metadata,
    assets: []
  }
  if (!/^v0\.2\.0-t3\.[1-4]$/.test(tag)) throw new Error("Invalid port prerelease tag")
  current(owner, base)
  const built = buildPortAssets(source, exportPolicy)
  if (
    built.inventoryDigest !== attestation.body.archiveCheck.inventoryDigest ||
    publicationHash(built.assets[0].bytes) !== attestation.body.archiveDigest
  )
    throw new Error("Independent archive custody mismatch")
  base.assets = built.assets.map((a) => ({ name: a.name, size: a.bytes.length, sha256: publicationHash(a.bytes) }))
  const identity = { ...base, operations: publicationOperations(base) }
  await discoverPortPolicy(identity.repository, source.repository, identity.revision, run)
  await requiredPortCi(identity.repository, source.repository, identity.revision, run)
  const observed = await remote(source.repository, identity, run)
  if (observed.revision || observed.release || observed.assets.length)
    throw new Error("Fresh publication collides with existing remote objects")
  current(owner, identity)
  const plan = new T3Publication(engine).prepare(lease, identity)
  return { plan, assets: built.assets, expectedCycle: expectedPublicationCycle(identity) }
}

export async function sendPortOperation(owner, plan, index, assetPath, run = gh) {
  const publication = new T3Publication(owner.engine),
    r = publication.get(owner.lease.projectId, plan),
    i = r.identity
  current(owner, i)
  await discoverPortPolicy(i.repository, owner.source.repository, i.revision, run)
  await requiredPortCi(i.repository, owner.source.repository, i.revision, run)
  const before = await remote(owner.source.repository, i, run)
  if (
    (r.observation?.release && before.release?.id !== r.observation.release.id) ||
    r.observation?.assets.some((previous) => !before.assets.some((asset) => digest(asset) === digest(previous)))
  )
    throw new Error("Previously observed remote identity changed before send")
  const op = i.operations[index]
  if (before.release && (before.release.title !== i.title || before.release.body !== i.notes))
    throw new Error("Remote release metadata conflicts before send")
  if (
    !op ||
    (index === 0 ? !!before.revision || !!before.release : before.revision !== i.revision) ||
    (op.kind === "release" && before.release) ||
    (op.kind === "asset" &&
      (!before.release?.prerelease ||
        before.release.draft ||
        before.release.target !== i.revision ||
        before.assets.some((a) => a.name === op.payload.name)))
  )
    throw new Error("Remote collision or missing prerequisite")
  if (op.kind === "asset") {
    const stat = lstatSync(assetPath)
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== op.payload.size || stat.size > L.assetBytes)
      throw new Error("Asset file or byte bound invalid")
    const bytes = readFileSync(assetPath)
    if (
      bytes.length !== op.payload.size ||
      publicationHash(bytes) !== op.payload.sha256 ||
      assetPath.split("/").at(-1) !== op.payload.name
    )
      throw new Error("Asset payload changed")
    // No arbitrary command flags or symlink redirection as a file argument.
    if (realpathSync(assetPath) !== assetPath || !assetPath.startsWith("/"))
      throw new Error("Canonical asset path required")
  }
  current(owner, i)
  const args = operationArguments(i, index, assetPath)
  const sender = senderInvocation(owner, plan, index, op.payload, args)
  publication.begin(owner.lease, plan, index, sender.invocation)
  // Fence immediately before the original runner can transmit.
  current(owner, i)
  publication.gate(owner.lease)
  const outcome = sender.execute()
  // Retain original signed termination BEFORE any remote read, including known nonzero exit.
  if (outcome.proof) publication.terminalSender(owner.lease, plan, index, outcome.proof)
  if (outcome.error) throw outcome.error
  const observation = await remote(owner.source.repository, i, run)
  publication.observe(owner.lease, plan, index, observation)
  return observation
}

/** Read-only remote reconciliation: never calls begin, sends or retries. Lost sender custody stays blocked. */
export async function reconcilePortPublication(owner, plan, run = gh) {
  const publication = new T3Publication(owner.engine),
    r = publication.get(owner.lease.projectId, plan)
  const observation = await remote(owner.source.repository, r.identity, run)
  for (let n = 0; n < r.identity.operations.length; n++) {
    if (r.senders[String(n)]?.terminal) {
      try {
        publication.observe(owner.lease, plan, n, observation)
      } catch {
        /* incomplete/conflicting observations retain uncertainty */
      }
    }
  }
  publication.settle(owner.lease, plan, observation)
  return publication.get(owner.lease.projectId, plan)
}

async function main(args) {
  if (args[0] !== "check-ci" || args.length !== 5 || args[1] !== "--repository" || args[3] !== "--candidate")
    throw new Error(
      "Read-only usage: check-ci --repository Dikkekip/AutoCode --candidate FULL_SHA; mutations require the existing in-process owner"
    )
  await requiredPortCi(args[2], process.cwd(), args[4])
  console.log("Exact candidate required CI passed; this is not publication authority")
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e.message)
    process.exitCode = 1
  })
}
