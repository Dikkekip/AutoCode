# T3 persona runtime

The experimental `@autocode/t3-runtime` package ports AutoCode's persona workflow to T3's advertised MCP tools. The existing OpenClaw backend remains available. This backend prepares an unpublished, exact-head candidate; it does not publish, merge, deploy, retire OpenClaw, migrate live records, or activate recurring work.

## Baseline and boundaries

Development starts from AutoCode master `0651747ba6af56a0e32fef05968639313ba45b04` (integrated framework repairs). The pre-existing recovery checkout at `b2ade227d1e5f650b896eb0c41a5a4b46dc32d75` and native image/session review worktrees were preserved. The recovery branch removes substantial integrated runtime work relative to master and is not copied wholesale. OpenClaw-specific later discovery/session fixes are not transplanted into the independent T3 transport. This is an additive backend, not an adoption of an existing paused native runtime.

The contract audit used installed T3 0.1.5. The adapter calls advertised MCP tools only, never private server RPCs, the installed binary, T3's SQLite database, a provider CLI, or another session's credentials. An authenticated callback, an agent-owned stdio relay and a bounded Streamable HTTP transport are available. Capability and parent/project/checkout checks precede delegation. Missing providers, mappings, models or options are errors; there is no automatic fallback.

| Responsibility | Reuse or replacement |
| --- | --- |
| Persona definitions and inheritance | Reuse `@openclaw/domain` built-ins and merge semantics |
| Project/manager missions, ideation, quotas and escalation | Reuse validated `@openclaw/project-profiles` definitions |
| Scheduling, children, managed worktrees and completion wakes | T3 advertised `schedule_task`, `delegate_task`, `task_status`, `task_cancel` and thread/project reads |
| AutoCode policy, dependencies, admission, reservations and candidate evidence | New fenced AutoCode journal and workflow engine |
| Verification isolation | Reuse the host-independent immutable Docker runner from `@openclaw/os-adapters`; no OpenClaw service or Gateway |
| Goals | Native provider-thread `/goal` commands; no invented MCP goal endpoints |
| PR publication, linking/watches, merge and deployment | Operator release lane after separate authorization; not activated by this development backend |

## Persona contract

All 15 built-ins remain: `ceo-product-owner`, `cto-system-architect`, `engineering-manager`, `planner`, `backend-engineer`, `frontend-engineer`, `devops-engineer`, `security-engineer`, `qa-engineer`, `code-reviewer`, `release-manager`, `documentation-engineer`, `memory-curator`, `incident-commander`, and `prompt-engineer`. Custom IDs and `extends` use the existing resolver. The resolved definition, prompt style, allowed lanes, forbidden actions, required reading and verification rules are included in the actual worker prompt, along with the matching manager's focus, lanes, adapter preference, ideation prompt, success signals, quota weight and escalation.

Persona/configuration, committed source inventory, skill content, role brief and actual dispatch payload are hashed and retained. Provider instance, requested model/options, task identity and observed terminal run identity are retained in assignments/effects/events. A worker must echo its binding envelope. Its prose is never a host receipt. Reported inspected paths must belong to the captured tree; this is source binding, not an independent proof that a model read every file. Prompts preserve required reading instructions; arbitrary natural-language rules do not become an enforced sandbox.

Live qualification observed the host shortening a long initial child message and omitting the proposal. Dispatch now retains the complete persona/skill/context brief in a private, read-only file beside the application journal and sends a short launch message with its absolute path, full-content SHA-256 and binding envelope. The worker must read and verify that complete brief before acting. These local artifacts require shared filesystem access on the owning environment; remote routing is not supported by this handoff. Retries require the identical retained brief. Governance snapshots include policy, consumed estimated budget and workflow summaries and remain fixed for that assignment. The generated AutoCode profile uses committed repository reading paths rather than assuming an installed `.openclaw` project tree.

Each research persona gets one investigation per source/persona/goal/skill identity, even across duplicate schedule/webhook deliveries. A no-op retains its explanation and inspected paths. A proposal retains its problem, source, goal, lane, literal path scopes, acceptance criteria, dependencies, risk and estimate. The independent planner can admit, defer or reject. Admission enforces current source, goal identity, duplicates at that revision, closed dependencies, project capacity, overlapping scope reservations and conservative remaining estimated budget. Candidate changes must lie inside the admitted scope. Different configured personas perform implementation, verification, review and release; planner/design independence is also checked against implementation. Quota weights affect selection among authorized role personas.

The board vocabulary remains:

```text
Planning -> To Research -> Researching -> Planning
Planning -> To Do -> Doing -> To Review -> PR approved -> Done
```

High-risk proposals require design approval. Verification and independent review bind to the exact candidate commit/tree. Review must cover every acceptance criterion with evidence, have no blocking findings, and use an independent persona. Rejections and observed head changes revoke checks/review and retain the prior candidate as repair context. Repairs have a hard limit. `PR approved` is the local release-ready state, not proof that GitHub reviews or checks passed. `Done` requires a trusted observation of actual merge **and** closure; the demo deliberately stops before it.

## Build and run the local demonstration

From the AutoCode checkout:

```bash
pnpm install --frozen-lockfile
pnpm exec tsc -b packages/t3-runtime
pnpm exec vitest run tests/t3-*.test.ts
```

The demo needs a locally available Node 24 Debian image and Docker access as a nonroot user. Select an approved cached base image by repository digest. Build the tiny protected fixture harness with network disabled, then pin its resulting image ID:

```bash
docker build --pull=false --network=none \
  --build-arg BASE_IMAGE=node@sha256:REPLACE_WITH_APPROVED_CACHED_REPOSITORY_DIGEST \
  -t autocode-t3-demo-verifier:local scripts/t3-demo-verifier
docker image inspect autocode-t3-demo-verifier:local --format '{{.Id}}'
node scripts/t3-demo.mjs --image sha256:REPLACE_WITH_RESULTING_LOCAL_IMAGE_ID
```

The demo creates its own private disposable repository and a **scripted T3 host fixture**, with a custom research mission and the independent role sequence. It does not create a real child/thread or call a real provider. It exports the committed candidate and actually runs the protected Docker verifier with no network, no capabilities, no host credentials, a read-only root, a nonroot UID/GID, and bounded resources/time/output. The acceptance harness resides at `/opt/autocode/verifier/check` in the immutable image, outside the writable candidate mount. Terminal state and container absence are independently observed by the Docker runner. A JSON summary, private journal and fixture transcript are retained in the printed temporary directory.

This establishes local integration and actual verifier execution. Scripted research/review outputs are fixture evidence, not model quality or live T3 delegation evidence. The demo records `published=false`, `merged=false`, `deployed=false` and `recurringScheduleActivated=false`.

## Configure a real T3 coordinator

1. Bind an operator-owned T3 parent thread to the intended repository/worktree. Its committed HEAD must match the investigation source and remain clean. Do not repoint another active thread or create an unrequested top-level thread. The current chat's project does not imply the target repository is bound.
2. Create a private directory outside the source checkout. Generate an editable complete profile with `node examples/t3-persona-profile.mjs /absolute/private/profile.json`, or supply an existing validated full profile JSON. Built-in IDs may alternatively be selected with `profileId`.
3. Copy [the configuration example](../examples/t3-config.json) into private storage. Set exact repository, parent/project IDs, state/skill paths, a fixed absolute deadline, limits, and explicit legacy-adapter-to-provider/model mappings from `orchestrator_capabilities`. The example deadline is a placeholder; set the intended bounded window. Policy/persona changes invalidate existing workflow identity and require a new investigation or an explicit future migration.
4. In an active T3 agent session, set `"transport": "stdio"` and use [the agent relay](#agent-owned-tool-relay); omit `endpoint` and `tokenFile`. For independent HTTP embedding, use an explicitly authorized, thread-scoped T3 MCP endpoint/credential. In T3, use `request_secret` with file delivery when credential delivery is needed. Configure that private token-file path. Do not paste credentials into chat, command arguments, profiles, Git, or query strings. The CLI accepts only a small regular private token file owned by its user; it does not discover tokens in session databases/configuration. A read-only OAuth client or an unscoped token may lack delegation authority; rejection is a blocker, not a reason to scrape a provider token.
5. Copy [the role result contract](t3-role-contract.md) to the configured skill path or create a compatible operator-owned skill. Its exact content digest is recorded. Configure a qualified immutable verifier image containing the project's trusted acceptance harness outside `/work`; the fixture image checks only the demo and cannot validate a real application.
6. Choose the research boundary explicitly. The default `require-tool-allowlist` fails closed on the audited T3 delegation contract. Only an operator decision to accept prompt-level research restrictions may set `accept-prompt-only`. This does not create an enforced read-only tool boundary. All roles still inherit the parent runtime permission mode.

Commands run from this checkout after building:

```bash
node scripts/t3-coordinator.mjs status --config /absolute/private/config.json
node scripts/t3-coordinator.mjs goal --config /absolute/private/config.json
node scripts/t3-coordinator.mjs tick --config /absolute/private/config.json
```

`goal` prints the supported native goal command. Apply it in the correctly bound provider thread if authorized. `tick` admits investigation identities and dispatches at most one responsibility. When it returns a delegate's `next`, end the turn as instructed. Do not put `tick` or `task_status` in a polling loop.

### Agent-owned tool relay

With `transport=stdio`, the coordinator emits one line beginning `AUTOCODE_T3_REQUEST ` followed by JSON `{type:"t3.tool.request",id,name,arguments}`. The owning T3 agent calls that exact advertised tool through its existing authenticated tool interface and sends one JSON line to the coordinator's stdin: `{type:"t3.tool.response",id,result}`. `result` is the complete tool result object. On a failed call, return `{type:"t3.tool.response",id,error:true}`; do not include sensitive diagnostic payloads. Forward only the seven coordinator tools permitted by the relay, never arbitrary methods from source content. No bearer token is needed in this mode.

Keep the coordinator process attached to the agent's interactive command session. Return replies to that same process; do not restart it to recover a lost reply. Each exchange has bounded bytes, a 60-second response deadline and one outstanding request. Timeout, malformed reply, wrong identity or closure poisons the transport and leaves sent mutations for reconciliation. The agent must preserve the native tool receipt and respect `next`: after an asynchronous delegate is attached and the coordinator exits, end the turn. Resume only on a real completion wake. This relay is an agent integration, not an unattended daemon or a background polling loop.

Call native `orchestrator_capabilities` once per parent thread, and retain its exact result in the owning agent's context for subsequent relay requests. Refresh only after a capability error or an operator-requested provider change. Never use another thread's cached parent identity. The coordinator still checks parent/project/source and every dispatch receipt. Parent binding and a clean committed source are required even when the agent itself can read arbitrary local files.

On a **real T3 completion wake**, handle that exact assignment:

```bash
node scripts/t3-coordinator.mjs complete --config /absolute/private/config.json \
  --workflow WORKFLOW_ID --assignment ASSIGNMENT_ID --wake DELIVERY_EVENT_ID
```

Completion reads the terminal host state once, checks descendants/questions/identity, atomically retains the result and settles the task, then applies validated role data. Implementation source is collected from the host-reported child worktree, not a worker-supplied path. The verifier role invokes the trusted host verifier before its result can advance. Repeated wakes reuse retained completion data. A later coordinator turn may dispatch the next responsibility. The parent agent remains responsible for handling T3 questions/approvals through the host; this backend never grants them itself.

`schedule-disabled` persists an interval schedule **disabled**, using the same authenticated parent binding and durable intent. The returned next-run field is not a workflow success receipt. Before any later activation, install the exact coordinator command/config handoff in its prompt and obtain the applicable activation authority. Interval schedules have a 60-second minimum. Fixed-time and webhook configuration remain native T3 operator surfaces; duplicate deliveries through the same `researchTick` identities remain safe. Webhook content is untrusted and must not select credentials, policy or shell commands.

## Ownership, recovery and stop controls

The private AutoCode journal has its own application identity/schema and rejects another application's database. Project leases use a retained monotonic fence, expiry and compare-and-swap revisions. A second owner cannot admit/dispatch while the lease is held. Each command releases its lease after its bounded turn; active task records and scope reservations survive. The verifier requires enough lease lifetime for execution and cleanup. Lost ownership prevents evidence settlement; retained uncertain intents then require reconciliation.

External effects move `prepared -> uncertain` **before** sending, then `confirmed` only after a validated receipt. Lost replies are not retried, even though T3 accepts client request IDs. A confirmed dispatch can reattach after restart without sending again. An uncertain dispatch with no known task ID remains blocked until authoritative custody establishes its outcome. Preserve that intent and observation; use the trusted journal reconciliation API only after checking the actual original identity/outcome. `reconciled-absent` does not automatically replay the request. Verifier creation/terminal/cleanup observations are retained separately; a coordinator crash can leave a container requiring identity-bound cleanup. Never delete arbitrary containers by name or reinterpret cleanup success as a passed test.

`status` reads local recovery state and does not query running child tasks. Native completion delivery is the trigger for task-result reads. Errors, missing credentials/provider capacity, quota failures, malformed results and stale source are explicit; there is no account switch, quota reset or weakened verifier fallback. Dispatch limits and estimated-token reservations are hard AutoCode limits. T3's advertised task result does not expose authoritative provider token usage, so **estimated** budget accounting is not an exact provider billing cap.

```bash
node scripts/t3-coordinator.mjs pause --config /absolute/private/config.json --reason 'Operator pause'
node scripts/t3-coordinator.mjs freeze --config /absolute/private/config.json --reason 'Operator freeze'
node scripts/t3-coordinator.mjs resume --config /absolute/private/config.json --reason 'Explicit operator resume'
```

Pause blocks research admission, new dispatch and release acceptance; already delivered evidence may still be retained. Freeze applies that gate immediately and requests cancellation of known running tasks, including descendants through `task_cancel`. A cancellation request is not terminal. Unknown/uncertain dispatches and pending cancellation receipts remain listed and keep their reservations. Queued ticks can still arrive from a native schedule; the durable gate prevents them dispatching. Resume never automatically enables a schedule or changes a provider goal. Native goal pause/resume is Codex-specific and must be applied in its provider thread; other providers have different controls. Already dispatched external operations cannot be revoked by a prompt or by this local gate.

## Verification and release limits

The protected runner exports exact Git blobs, including executable modes, without `.git`. It rejects symlinks and submodules until a supported export policy exists. File/aggregate sizes, execution time, process/memory/CPU use and output are bounded. An immutable image alone is insufficient: the operator must qualify the protected harness and its acceptance policy. Candidate-controlled test scripts remain candidate-controlled even inside a sandbox; use trusted acceptance logic in the image where that distinction matters.

The host tool catalogue is negotiated once per coordinator instance/thread. The current adapter requires the configured model/options to appear in that negotiated catalogue; truncated catalogues require explicit further negotiation by an integrator. There is no CLI command to silently install/enable providers. Remote linked environments, native PR linking/watching and external publication remain T3 release-lane tools. No thread handoff, PR watch, push, merge or deployment is performed by these commands. The trusted `recordClosure` API records observed merge/closure; it does not execute them.

## Cutover checklist

1. Keep the current native runtime owner, pause and evidence unchanged while developing. Qualify this backend on a disposable correctly bound T3 project with the intended providers, credentials and protected image. Separate that live evidence from the scripted demo.
2. Record current ownership, drain/stop evidence, unresolved tasks/effects, exact repository head and verifier policy. Preserve inherited failed or unwaived gates. Do not infer drainage from a schedule/service status alone.
3. Review persona/profile equivalence and all policy/credential/research-isolation decisions. Start with a separate private journal; there is no automatic live-record migration.
4. With explicit cutover authority, freeze the prior owner and prove descendants/external effects settled before admitting the same project in T3. Save schedules disabled; activate only the reviewed owner/schedule after acceptance. Never run both backends against the same reserved scope.
5. Roll back by freezing T3, observing cancellation and reconciling uncertain effects, preserving its journal/candidates, then explicitly transferring ownership back. Do not reset budgets or throw away evidence to make a blocked run appear healthy.

See [the validation record](t3-validation.md) for observed results and remaining qualification boundaries.

## Fenced port prerelease publication (owner API)

The port uses `scripts/t3-port-release.mjs`, independently of the existing stable
release helper. The reviewed policy is `T3_PORT_POLICY` in `publication.ts`:
`Dikkekip/AutoCode`, delivery branch `port/t3-personas-20261031`, full 40-character
candidate SHA, tags `v0.2.0-t3.1` through `v0.2.0-t3.4`, prerelease true and latest
false. Prepublication requires the unique **AutoCode CI** check from app 15368,
completed successfully on that SHA within 86400 seconds. The public
`@openclaw/core-runtime/required-ci` entrypoint supplies the unchanged native
policy, including duplicate rejection. **AutoCode Release Readiness** is a distinct,
supplementary postpublication check. Neither local CI nor that future check
replaces prepublication approval.

The reviewed `requireBranchProtection=false` disposition applies only while fresh
repository, delivery-branch, explicit unprotected response, effective branch rules
and parent-inclusive ruleset discovery all confirm the unprotected branch. Any new
protection or human gate currently blocks this adapter as unsupported. API errors
and inaccessible policy block too. The adapter never changes protection or invents
human approval. The stable-latest baseline is release 416051123 / `v0.1.0.7`;
every remote observation checks it.

This executable offers only a read-only diagnostic:

```bash
node scripts/t3-port-release.mjs check-ci --repository Dikkekip/AutoCode --candidate FULL_SHA
```

Mutation requires the established coordinator owner to import
`preparePortPublication`, `sendPortOperation`, and `reconcilePortPublication` and
pass its existing engine and current project lease. There is no CLI switch, worker
relay tool, journal acquisition, competing owner, schedule or credential delivery
in this adapter. Build the workspace first. GitHub authentication stays in the
trusted owner environment. Injected read transports are a testing/embedding boundary; only the trusted owner
may supply them. Mutations always run the actual local `gh` subprocess; an injected
read callback cannot supply sender termination evidence.

The owner supplies a pinned Ed25519 verification key **in process**, outside the
candidate, and an attestation signed over the UTF-8 lowercase canonical `digest(body)`.
The `T3PublicationAttestation` type defines the exact packet: workflow, SHA/tree,
policy/export/archive digests, issuance/expiry, approved release title and exact
UTF-8 notes SHA-256, explicit tag authorization/deadline,
complete clean `ci:agent` receipt plus actual execution/terminal identity,
immutable changed-feature harness qualification and negative controls, and an
independent immutable archive check with terminal/cleanup custody. This is an
owner evidence integration contract, not a bundled attestation issuer. The owner
must independently obtain real execution observations before signing; it must not
sign worker receipt claims. Arbitrary receipt paths and preparation summaries are
insufficient. Publication also independently reads retained workflow assignments,
bound completion envelopes and observed terminal events, confirmed protected
effects, verification policy/receipt digests, criterion-complete independent review
and release-manager readiness from the existing journal. Missing custody blocks.

Keep attestation packets, trust roots, raw CI receipts, qualification records,
archive checker observations and journal records in operator-owned private storage
outside Git. The existing new-admission journal remains the sole runtime; the
original frozen run, its failed receipts and repair/deadline limits remain unchanged.
This source does not establish a qualified publication harness or actual custody.

Exports require a separately reviewed literal committed-file allowlist bound to
candidate/tree; its digest is signed with the archive check. `buildPortAssets`
requires the committed workspace/build inputs, reads regular blobs only, and emits
an uncompressed source tar, `manifest.json` and `SHA256SUMS`. Notes contain the full
SHA and fixed build instructions (`pnpm install --frozen-lockfile`, `pnpm build`).
This is source requiring supported Node/pnpm, not an installed binary. The explicit
allowlist remains an operator review requirement; filename exclusions cannot prove
that arbitrary source content is public or sanitize old Git history.

The archive reader is separate from the writer and inspects every block, payload,
mode, checksum, padding and all trailing bytes. It rejects links, extensions,
unsafe/private paths, duplicate/missing files and a second tar stream after EOF.
Bounds are fixed in `T3_PUBLICATION_LIMITS`: 2000 files, 4 MiB per source blob,
32 MiB aggregate source, 40 MiB archive/download per asset, 8 assets, 2 MiB API or
command output, ten API pages, and 30 seconds per subprocess. The independent
qualified checker must inspect the completed exact archive, including adversarial
trailing streams; a candidate-local test is not that qualification.

Preparation checks clean exact HEAD/tree, delivery branch, evidence, policy, CI,
and fresh tag/release/asset collisions before committing a reservation and the
complete immutable operation inventory in one fenced transaction. Operations are
separate: exact tag creation, release creation using `--verify-tag --target SHA
--prerelease --latest=false`, then one upload per asset. No force, overwrite,
clobber, delete or default-branch mutation is available. Assets must be canonical
regular files matching the retained name, size and SHA-256.

Before each send, the owner rechecks control, lease lifetime, source, evidence
freshness/deadline, remote policy, required CI and collisions. Each payload-bound
effect is prepared separately, then becomes uncertain **before** transmission.
A normal process exit only establishes local termination when the original
runner also observes the process group absent. The same custody is retained for a
known nonzero exit; that exit never means remote rejection. Remote observation must
still verify peeled tag SHA, release identity/target/prerelease status/title/body, unchanged
stable latest and downloaded asset size/hash. No command response alone settles a
publication. Reconciliation is a separate read-only remote operation and never
retries an absent object. Pause/expiry permits observation under a valid owner
lease, but never a new send.

Ordinary admission counts the union of active workflows and unresolved publication
reservations once for capacity, scope and remaining estimated budget, including
stale terminal workflow records. Malformed/orphan/conflicting reservations block
admission. Cancellation, closure and head invalidation cannot release an open
publication reservation. Settlement atomically disables all future sends and
requires observations for every attempted operation; genuinely unsent operations
get explicit disabled dispositions. A crash before effect preparation still leaves
the complete reservation. Timeout or lost ownership cannot establish original sender
termination: such plans conservatively stay reserved even if a remote read reports
absence or presence. There is no unsafe timeout-based release or takeover path.

Tests in `t3-publication.test.ts` and `t3-workflow.test.ts` exercise these contracts
with disposable Git/journal, signed fixture packets and scripted GitHub responses,
including the built public entrypoint and actual read-only executable. They are not
live GitHub publication, human approval, protected changed-feature qualification,
or independent exact-candidate acceptance. Publication never calls `recordClosure`
or assigns Done. All remaining feature-matrix gaps and automatic-rebase deferral
still apply; four actual distinct release cycles remain required.

### Prior failed CI and fresh export guard

Retained unapproved candidate `e56121496f993cfe5d5ac76e74e2c0824976b10c`
failed full `pnpm ci:agent`: licenses/audit passed, but the string-only
workspace-resolution guard rejected the core-runtime export map. That receipt
remains failed. The independently admitted fifteen-path revision now repairs the
guard; it needs its own clean committed-SHA full CI receipt, protected acceptance,
independent exact-candidate review and release-manager readiness.

The guard accepts only a string root export or literal subpath map including `.`;
each value is a local string or ordered `{types, default}` pair. Other conditions
(including import/require), nested conditions, patterns, arrays, null and mixed
shapes fail closed. Every runtime/declaration target and applicable top-level
`types` file must be an existing regular file in the exact canonical workspace,
without symlink redirection. Package and root consumers resolve every public
runtime subpath through the expected dependency identity. Intended pnpm package
links remain supported; borrowed graphs, symlinked directories/manifests/targets,
missing declarations and foreign packages remain rejected. The public core root
and `required-ci` exports remain available, with a matching root development
workspace dependency/lockfile; T3 runtime gains no core-runtime dependency.

### Original sender custody and exact release metadata

Each attempted operation records a unique invocation ID, original owner/fence,
plan/effect/index, payload and argv digests, and an ephemeral runner public key
before transmission. The private key remains inside the original runner closure.
Only an actual normal exit with bounded output and observed process-group absence
produces signed termination evidence (PID, exit code and times). The adapter
retains it before remote reads, including when `gh` exits nonzero. A successor can
validate retained evidence against that original key; it cannot replace the key,
relabel a fence or set a terminal boolean to discharge uncertainty. A crash before
proof retention remains blocking. Timeout, signal, output overflow, spawn failure,
lost ownership or a surviving process group produces no accepted proof. The
trusted cooperative `gh` process and descendants must stay in their assigned
process group; this is not containment of malicious same-UID processes escaping
that group. Such a transport requires separate process containment qualification.
The default subprocess deadline is 30 seconds; an owner may lower it, never raise
it. No runner invocation is retried.

`publicationMetadata` provides the fixed sanitized default. An owner may supply
separately approved metadata to preparation; its exact title and notes hash must
match the signed custody packet. The complete title/body enters the immutable
identity and release payload before plan/effect hashing. Arguments use the planned
values. Malformed UTF-8 strings, NULs and missing/empty approved values are rejected.
Remote `name`/`body` must exactly match during confirmation, subsequent asset sends
and fresh final settlement. Missing, empty, altered, newline-different and
Unicode-different values block settlement even after an earlier valid observation;
no trimming or normalization occurs. `expectedPublicationCycle` and preparation's
`expectedCycle` expose `{commit, title, notesSha256, assets}` with full accepted SHA
and a filename-to-SHA-256 map. This expected record is not remote or sender proof.

Local fixtures cover real original subprocess exits at tag/release/every asset,
nonzero exit after synthetic remote acceptance, signal, timeout, surviving
process-group descendants, forged/mismatched proofs, successor recovery, missing
sender custody and exact metadata differences. The remote is scripted; no live
GitHub release, changed-feature harness qualification or protected acceptance is
established. The archive parser also verifies Git blob identities from actual
contents. All twelve acceptance criteria still require downstream independent
exact-candidate review and the qualified protected adapter/archive checks.
