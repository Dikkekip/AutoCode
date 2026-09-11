# Native persona-driven application coding

For the first setup, start with [Getting started](getting-started.md). This reference covers the native integration, quality gates, and dedicated research tools.

The `autocode` OpenClaw plugin moves discovery and work ownership onto native Workboard and Automations. The framework retains persona admission, artifact-scope reservations, independent verification, and application promotion gates. Framework work remains blocked for human review.

## Ownership and completion

Workboard owns cards, claims, managed worktrees, native task/session/run identifiers, and execution history. `native-evidence.db` stores proposal provenance, review and verification receipts, migration mappings, external-operation intents, and reconciliation locks. It is not another dispatch queue. Existing dispatcher state is an archive after cutover.

Discovery, admission, and reconciliation use 120-second leases renewed every 40 seconds. Each store instance has a unique owner identity; each successful acquisition increments a persisted fencing token. Startup preserves existing leases and operation evidence. Expired owners cannot renew, commit protected evidence, or authorize further gateway or release effects after takeover. Ownership validation, protected journal writes, and synchronous verification receipt writes share a SQLite write transaction. Verification rechecks authorization after asynchronous input preparation before launching a command. Released lease rows remain so tokens cannot be reused. Tests inject the lease clock and exercise takeover from a separate Node process.

Lease loss cannot revoke an external request already sent. Its recorded operation intent remains available for recovery; reconciliation must confirm the remote outcome before attempting another effect.

An investigation is a real turn by a named persona. Weighted rotation chooses three personas, sequential dependencies preserve the planner concurrency limit, and a separate planner compares their recorded proposals. Each persona can propose at most two alternatives; a round may admit none. Existing persona goals and lane checks can be imported with `native prepare`. Defaults admit at most six tasks per round, cap new quality-enabled discovery at twenty-four rounds daily (legacy policies default to twelve), and apply backlog/scope backpressure. OpenClaw owns provider accounts and cooldowns; the legacy account switcher is not called.

Implementation, verification, review, merge, and deployment are separate cards. The workflow card remains blocked until deployment has an exact-revision receipt. A worker's `workboard_complete` is not a release authorization. Managed implementation worktrees start from `origin/<baseBranch>`, preserving a stale or dirty local branch. The coder must call `autocode_submit` from its assigned card session with its managed worktree; the host broker records any scoped source edits as a commit without exposing shared Git metadata to the sandbox; the reviewer must call `autocode_review` from the separate assigned review session. Structured host-executed checks, independent review, and GitHub CI must all pass for the submitted head.

Sandboxed roles need Autocode and Workboard tools allowed in both the role tool policy and `tools.sandbox.tools`. Before dispatch, the native adapter binds the assigned sandbox workspace through the public configuration API and starts only that prepared Workboard card. It does not rebind a role with an active Workboard card. Scratch research cards retain their native workspace behavior.

The submission broker rejects outside-scope files and symlinks, snapshots bounded regular source files through checked file descriptors, and uses Git plumbing with hooks and filters disabled. It preserves untracked runtime persona notes locally and excludes them from the candidate. An ended implementation without a submission becomes an explicit recovery blocker; retry preserves the prior attempt and requires an operator recovery decision.

Verification and review rejection allow at most two repair handoffs against the preserved worktree. Missing proof, an empty patch, outside-scope changes, changed candidate code, missing reviewer, unresolved external effects, and exhausted repair budgets block progress. The native path fails closed on failing tests; it does not infer success from summary text or automatically waive baseline failures.

## Prepare and inspect

Build with `pnpm build`. Native commands emit JSON; `quality` also offers a readable default and takes `--policy` before its subcommand:

```bash
pnpm dispatcher native prepare --profile /application/.openclaw/profile.json \
  --repository /application --base main --out /application/.openclaw/native.json
pnpm dispatcher native --policy /application/.openclaw/native.json doctor
pnpm dispatcher native --policy /application/.openclaw/native.json migration plan \
  --source /application/.openclaw/dispatcher.db --out /tmp/native-migration.json
```

`prepare` preserves persona missions, weights, path patterns, and lane verification commands. It creates a paused policy with no deployment command. Review agent mappings and install paths; execution readiness checks reject enabled projects with missing native roles, active legacy ownership, or incomplete deployment configuration. Service startup does not wait on RPCs to its own Gateway; checks run before native dispatch, adoption, or agent tools, and failures remain retryable after the underlying problem is fixed. Applications need a deployment command and an independent revision/workflow check before activation. Native policy may also live in a project's `nativeAutonomy` profile field.

The deployment command receives `AUTOCODE_SHA`, `AUTOCODE_WORKFLOW_ID`, and `AUTOCODE_REPOSITORY`. It must build/release/deploy the requested merged SHA, using the application's established deployment mechanism. Its check must emit only JSON to stdout:

```json
{"deployedSha":"<full merged commit SHA>","workflowPassed":true}
```

A health endpoint alone is insufficient: the check must exercise the representative user workflow. Command argv is passed without interpolation, cwd must stay within the configured root, and timeout/output evidence is retained under `.openclaw/native-artifacts`. Optional rollback is an operator-configured, tested application command; a rollback command exit does not mark the workflow successfully deployed.

## Plugin and native scheduling

The linked plugin requires this built framework checkout to remain at a stable path:

```bash
openclaw plugins install --link /framework/plugins/autocode
openclaw plugins enable workboard
```

Include both `autocode` and `workboard` in `plugins.allow`, then configure `plugins.entries.autocode.config.projects` as an array of absolute native policy file paths. Use supported OpenClaw config/installation commands; never edit its generated registry or database. The plugin uses public registration APIs and the authenticated OpenClaw CLI for RPC. OpenClaw 2026.9.1 reserves its in-process `runtime.gateway.request` helper for bundled/official plugins. Projects require `plugins.entries.autocode.config.openclawCommand` to be the absolute active CLI path; a bare command can select an incompatible legacy installation from Gateway PATH. Generated bundle imports are confined to tests.

Allow the optional `autocode_*` tools only on the configured native agents. Quality-enabled investigators use `autocode_inspect`, `autocode_propose`, and `autocode_investigation_finish`; the planner uses `autocode_proposals`, `autocode_admit`, and `autocode_defer`; the coder uses `autocode_submit`; and the independent reviewer uses `autocode_design_review` and `autocode_review`. Legacy investigation rounds retain `autocode_propose`. These host-integration tools reject sandboxed callers; configure host workspace authority explicitly. Native workboard tools still own worker claim/heartbeat/completion. Do not authorize agents to edit the integration or its policy while performing application work.

After loading the plugin, install native jobs with explicit executable paths:

```bash
pnpm dispatcher native --policy /application/.openclaw/native.json install-automations \
  --node /absolute/path/to/node --cli /framework/apps/dispatcher-cli/dist/index.js
```

New jobs are disabled, use durable declaration keys, and execute quality-enabled discovery hourly (legacy discovery every two hours) plus reconciliation every five minutes. Lifecycle hooks nudge the reconciliation job only when it is enabled. Existing job enablement is preserved on repeat installation. Startup of an enabled policy runs readiness checks before accepting work. To stop new dispatch and promotion without losing accepted sessions:

```bash
pnpm dispatcher native --policy /application/.openclaw/native.json pause
pnpm dispatcher native --policy /application/.openclaw/native.json status
```

The pause is durable. Do not reactivate work by changing SQLite directly. After enabling the reviewed policy and passing the rollout gates, reload the plugin and use `native resume`; it reruns readiness checks before clearing the durable pause. Operator activation remains a separate rollout step.

## Migration and rollout

Migration refuses active legacy runs, active automations, changed previews, cycles, or unresolved prerequisites. It takes a validated SQLite backup before native writes. Completed/failed/cancelled tasks remain historical; unfinished cards retain their legacy status and full evidence artifacts. Import uses idempotency keys and safe scheduled holds while linking dependencies, then blocks imported cards. Repeating an import never resets cards that an operator has activated.

```bash
pnpm dispatcher native --policy /application/.openclaw/native.json migration apply \
  --plan /tmp/native-migration.json --backup /backups/dispatcher-before-native.db
```

Do not directly dispatch imported coding cards: they must be reconciled into the proposal/verification workflow first, including preserved worktree and review evidence. Keep both old and new execution paused while reconciling. Canary activation requires an isolated application profile with working release and workflow-check commands. Run for at least 72 hours and ten verified deployments, with no duplicate merge/deploy effects or missing proof. Inject accepted-run disconnects, gateway restarts, quota failures, and post-merge interruptions; require recovery within two reconciliation intervals. Start application cutover at one worker; increase to two only after acceptance. Retain the old runtime and state for seven days before removal.

Unknown merge and deployment outcomes are reconciled with GitHub and the deployed revision, never blindly replayed. Pause native dispatch before rollback; reconcile accepted sessions and external effects before restoring a legacy owner. Full production cutover and the observation period are not established by unit tests or a successful plugin load.

## Validation

`pnpm check` exercises the repository suite. Focused tests cover proposal authority, pause behavior, interrupted import, commit-bound verification, CI waiting, release idempotency, and uncertain deployment receipts. `node scripts/native-contract-smoke.mjs /installed/openclaw` exercises the installed Workboard implementation with isolated stores, including its actual dependency and idempotency behavior, plus plugin registration. Generated bundle discovery is confined to that compatibility test.

Imported cards remain blocked until explicitly adopted with `native --policy <policy.json> migration adopt --legacy-key <projectId:taskId>`. Adoption retains scope, persona provenance, acceptance criteria, run artifacts, and dependencies. Existing clean candidate worktrees receive fresh independent verification; otherwise a recovery coder receives the preserved evidence. Paused projects do not dispatch adopted work, and unfinished dependencies prevent progression. Blocked legacy tasks require rescoping before adoption.


## Skill-backed quality contract

Newly prepared policies include `quality` with an absolute `skillPath`, a 300-second investigation budget and high-risk path rules. Existing policies without this field and already-admitted workflows retain their previous contract. Native profile conversion preserves custom `ideationPrompt` instructions and creates dedicated `native-research-<personaId>` research role mappings.

Research roles must have an explicit tool allowlist containing only `autocode_context`, `autocode_inspect`, `autocode_propose`, `autocode_investigation_finish`, `workboard_complete`, and optionally `workboard_heartbeat`. Do not grant shell, filesystem editing, agent spawning, or provider-specific tool overrides. The readiness check verifies these restrictions. Copy the source persona model and mission into each dedicated role; do not change existing application-worker permissions. Research uses scratch workspaces and reads committed application files through the authenticated inspection tool.

Each native investigation receives the configured reviewed skill content, content hash, persona brief and recent decisions/review outcomes. Newly prepared policies use the `native-coding` bundle; existing configured skill paths remain unchanged. It performs repository analysis and prompt synthesis within the same bounded inference session. The host records native session provenance; this demonstrates which session produced the artifact, not the quality of the model reasoning. A successful proposal needs a concrete problem, user workflow, expected benefit, approach, non-goals, risk assessment and one verification method per acceptance criterion. Evidence must identify files actually inspected during that session. The host binds file hashes and revision to the proposal.

A skill can declare an adjacent `<skillPath>.bundle.json` manifest with `{ "version": 1, "resources": ["relative/path.md"] }`. Resources must be distinct regular Markdown files beneath the entrypoint directory; absolute paths, traversal, symlinks, and recursive entrypoint inclusion are rejected. At most 16 resources and 512,000 total UTF-8 bytes are accepted. Manifest order and resource paths/content determine the composed text. Bootstrap, discovery, and doctor use the same loader; changing or removing a resource changes the digest and requires the existing evaluated promotion process. Single-file skills retain their original text digest. The loader composes instructions only; it never executes scripts.

Inspect the exact composed digest and policy digest with `pnpm dispatcher native --policy /absolute/path/to/native.json skill inspect`. Add `--include-text` to review the complete instructions. Inspection is local and read-only: it does not contact OpenClaw, register a snapshot, or change activation. Use these digests with the existing administrator bootstrap procedure after review.

Every native task card embeds Caveman full response guidance in its `responseStyle` context, including cards that retrieve oversized context through `autocode_context`. This preserves terse agent communication without requiring an external skill installation. Structured tool output, evidence, verification, code, documentation and safety-sensitive prose retain their full requirements. Legacy dispatcher runs retain their existing response-compression settings and overrides.

Finish investigations with `autocode_investigation_finish` before completing the Workboard card. Use `no_op` when no useful gap exists. Missing skill content prevents discovery; expired or failed sessions without a completed contract cannot supply admitted proposals. Unchanged code, goals, skill content and feedback skip repeated investigations. Native card budgets and idempotent keys bound and recover partial rounds. The installed Workboard clamps retry budgets to at least one and does not pass its card deadline to inference; the plugin therefore checks deadlines every 15 seconds and calls the public `sessions.abort` API for expired sessions, including after pause or restart. Tool submissions reject expired or replaced investigation sessions immediately. Actual cancellation can lag the deadline by the polling interval and gateway latency.

The planner records admission rationale or `autocode_defer` reasons. Identical decided problems require changed evidence before reconsideration; the planner also compares semantically equivalent ideas and already-implemented features. These semantic judgments are not inferred from a deterministic score. Stale evidence requires a fresh investigation.

High-risk path rules and risk keywords can raise agent-supplied risk. High-risk proposals get an independent design-review card before implementation becomes ready. Rejected designs block the workflow for rescoping. Both design and implementation reviews use `{criteria:[{criterion,satisfied,evidence}],findings:[{blocking,description}]}`; approval requires evidence for every criterion and no blocking findings. High-risk design approval and structured implementation evidence are checked again before release.

Inspect durable outcomes with:

```bash
pnpm dispatcher native --policy /application/.openclaw/native.json quality
pnpm dispatcher native --policy /application/.openclaw/native.json quality --json
```

The report includes completed/no-op/failed/timed-out investigations, session and skill provenance, decisions, first-pass approvals, repairs and exact-revision deployments. Keep persona weights stable until sufficient outcomes exist.

### Pilot acceptance

Run full CI, `tests/native-quality.test.ts`, and `scripts/native-contract-smoke.mjs <installed-openclaw-root>` before activation. Validate synthetic gaps, no-op repositories, stale evidence, repeated proposals, risky changes, interrupted discovery and review rejection. Then prepare your target project with one worker, configure its established deployment and representative workflow check, and pass `native doctor`. Snapshot and migrate legacy evidence using the existing migration commands before cutover. Do not enable legacy and native execution together. Treat three feature-or-fix workflows with independent acceptance evidence and exact-revision deployment receipts as the initial pilot checkpoint. Complete the longer cutover observation described above before increasing concurrency or retiring the legacy runtime. These are operator acceptance targets, not automatically enforced counters. If readiness or execution fails, pause native work and preserve evidence; do not resume legacy ownership while native runs or unresolved external operations exist.

Workboard limits card notes to 4,000 characters. Larger contexts are preserved in the native evidence journal; the card contains an instruction to call `autocode_context`. Grant this read-only tool to all native worker roles. It returns context only to the agent and active session assigned to that card. The complete persona brief, skill and acceptance criteria are preserved rather than truncated.

Run the project-specific contract smoke before activation:

~~~bash
node scripts/native-project-smoke.mjs /absolute/path/to/application/.openclaw/native.json /absolute/path/to/installed/openclaw/package
~~~

It reads the real policy and committed Git tree, then exercises the installed Workboard implementation using isolated stores. It checks actual card limits, complete context preservation, duplicate-round prevention, and paused reconciliation without starting agents or deploying code.

### Persona self-prompting and duplicate findings

Research personas write a short investigation brief before investigating and retain it in the implementation prompt. The brief must preserve the fixed source-evidence, countercheck, uncertainty and acceptance requirements. The planner compares underlying behavior and user workflows, records duplicate deferrals, and reports uninvestigated or inconclusive goals. Coverage reporting is a prompt requirement, not a mechanically verified claim of complete repository coverage.

Equivalent findings retain separate persona proposal records so each investigation can complete. Repeating a submission reuses its existing ID, including records created before persona IDs were added to proposal keys. Admission still rejects an equivalent decided problem with unchanged evidence.

### Candidate execution isolation

Native verification requires Linux and `/usr/bin/bwrap` (Bubblewrap with
`--disable-userns` support). Other platforms, missing tools, and denied namespace
creation fail closed. There is no host-execution fallback. See the
[Bubblewrap manual](https://manpages.debian.org/bookworm/bubblewrap/bwrap.1.en.html)
for the namespace and process-lifetime guarantees used by this runner.

Configure `verificationSandbox` in the administrator-controlled native policy:

```json
{
  "backend": "bubblewrap",
  "rootFilesystem": "/opt/openclaw/build-root",
  "inputFiles": ["package.json", "pnpm-lock.yaml", "src/index.ts"]
}
```

Provision a dedicated, root-owned build filesystem containing the required Linux
runtime, libraries and offline dependencies. Its entire contents must be trusted,
credential-free and unwritable by candidate workers (including nested directories).
Never use a host filesystem snapshot containing user homes, Gateway configuration,
deployment credentials, policy files or evidence. The runner rejects `/` and
non-administrator-owned or group/world-writable roots. Provision `/work`, `/proc`,
`/dev` and `/tmp` mount points. Host tool installations and caches are not inherited.

`inputFiles` is an exact allowlist of committed regular source files. Review it as
a data-disclosure boundary: do not include credentials or administrative policy,
regardless of filename. Directories, globs, symlinks, Git metadata and recognized
credential/policy filenames are refused. Untracked files are never copied. Each
command gets a fresh private copy at `/work`; generated build output is discarded
when it exits. Include all build inputs, and combine dependent build/test steps in
one command. Network access is disabled; dependencies must be provisioned offline.

Only `CI`, `NODE_ENV`, `TZ`, `LANG`, `LC_ALL`, `SOURCE_DATE_EPOCH`, `FORCE_COLOR` and
`NO_COLOR` are inherited. `PATH`, `HOME` and `TMPDIR` use sandbox-local defaults.
Loader hooks, host shell profiles and arbitrary environment secrets are excluded.
The sandbox has isolated PID, network and user namespaces, no capabilities, no
nested user namespaces, a read-only build root, private temporary storage and only
a disposable writable source copy. The parent writes exclusive verification
receipts after command termination; evidence storage is never mounted.
`verifyNativeCandidate` and `runNativeCommand` accept an optional `AbortSignal`.
Timeout, abort and output overflow terminate the Bubblewrap supervisor, which kills
its sandbox processes.

Deployment uses a separate privileged runner. Existing policies must explicitly
set `deployment.authorized: true`; `deployment.environmentAllowlist` names only the
credentials needed by the configured deployment/check/rollback commands. Review
those commands as privileged code, preferably invoking administrator-owned release
tools. Candidate verification never receives this allowlist. Release gates still
apply before deployment, and absent authorization blocks release effects. Each
execution records a new receipt rather than overwriting prior evidence.

The Linux CI isolation suite provisions a minimal BusyBox filesystem and checks
secret invisibility, writes, evidence integrity, cancellation and output bounds.
To run it on a provisioned Linux host:
`NATIVE_TEST_ROOTFS=/opt/openclaw/test-root pnpm exec vitest run tests/native-verification-isolation.test.ts`.
Without that explicit fixture, kernel tests are skipped; configuration and
fail-closed tests still run on other platforms.

### Benefit-based admission

Quality investigations must include `quality.hypothesis`: a metric and unit, numeric baseline and target, direction (`increase` or `decrease`), baseline evidence paths, evidence strength (`observed`, `reproduced`, or `measured`), confidence from 0 to 1, explicit uncertainty, estimated `effortHours` and `costCents`, a measurement plan, and structured alternatives. Alternatives must include both `no_op` and `change`, each with a description and rationale. Baseline paths must belong to the proposal's inspected evidence. The existing problem, user workflow, expected benefit and risk contract remains required. Evidence-strength and confidence claims are investigator estimates, not independently calibrated probabilities.

`quality.admissionBudget` sets the per-round effort and cost envelope (default: 24 hours and 10,000 cents). Admissions reserve these estimates durably; retries do not spend twice. Existing concurrency, scope, task count and release gates still apply. Finish all investigations before admission, including useful no-op conclusions. `autocode_proposals` exposes rankings and decisions; the admission tool enforces them. Historical proposals without a hypothesis must be reinvestigated in quality mode.

The selector rejects targets already satisfied by the baseline and confidence-adjusted relative gains below 5%. Routine work needs confidence of at least 0.6. Work over eight hours or 5,000 cents needs reproduced evidence and confidence of 0.8. High-risk work needs measured evidence and confidence of 0.9. Eligible proposals rank by bounded relative gain times confidence and configured persona goal weight, divided by effort plus cost (1,000 cents equals one effort unit); high risk halves the score. These are transparent initial policy heuristics, not learned utility estimates. ID ordering breaks ties. The selector defers proposals that cannot fit the remaining round budget. Rejections and deferrals return a normal decision without implementation cards, retaining rationale and uncertainty. Reconsider them through a fresh investigation.

A successful deployment check may return `benefitObservation: {metric, unit, value, evidence}` alongside `deployedSha` and `workflowPassed`. The runtime binds the measurement to the deployed revision and the original hypothesis, recording `supported`, `not_supported`, or `unmeasured`. Revision verification alone never proves benefit. Missing or incomparable measurements remain unmeasured, and observed improvement does not establish causality. Quality reports and subsequent investigation feedback retain this result. The measurement plan should specify the observation window and relevant confounders.

`evaluateNativeAdmission` replays fixed inputs against a capacity-only, arrival-order baseline and the new selector, reporting held-out realized utility, effort and cost separately from proposal counts. `tests/native-admission-selector.test.ts` fixes satisfied, low-value, costly speculative, risky, budget-constrained and no-op scenarios. The baseline is an explicit deterministic capacity comparator; it does not claim to reproduce historical LLM planner judgments. Completed and no-op investigations both count as successful investigations.

### Agent tool ownership

OpenClaw may create an agent tool registry without starting plugin services in that registry. Native agent tools therefore forward through the authenticated `autocode.tool` Gateway method when no local service instance exists. The Gateway owns the board runtime, evidence store and execution locks. The bridge accepts only registered native tools, uses the agent factory's identity/session context, and retains existing card-session and readiness checks. Confined sessions cannot use the host bridge.

### Recovering an uninspected infrastructure failure

Pause native execution before calling the operator-only `autocode.retryInvestigation` Gateway method with `boardId`, `roundId`, `personaId` and a repair `reason`. Recovery is allowed once, only after the worker has ended and before it has inspected source or produced proposals. It preserves the original attempt in the evidence journal and the same Workboard card, records a failed Workboard attempt, clears only the current execution association, and grants the retried attempt its normal bounded session window. Repeating an accepted recovery request is idempotent. Investigations with source evidence require a new round rather than resetting their budget.


Large source files can be read in bounded pages with `autocode_inspect`. Omit `offset` for the first page, then pass the returned `nextOffset` unchanged with the same round, persona and path until it is `null`. Each response contains at most 64,000 UTF-16 code units and does not split a Unicode surrogate pair. Reads preserve whitespace, use the investigation's recorded commit, and journal inspected ranges. Continuation does not extend the session budget or permit access outside the persona scope.


Implementation, adoption, and repair cards wait in `blocked` status until admission capacity and any design review permit execution. `scheduled` is reserved for an actual schedule. Reconciliation can recover older framework-created undated scheduled holds while preserving an explicit future start time.

Verification exits 126 (not executable) and 127 (not found) block for operator inspection of the command artifact. They do not create coding repair handoffs or consume the repair budget; the candidate and verification evidence remain available. Repair the verification environment before using the explicit recovery workflow. Other failing checks retain the normal bounded repair behavior.

When independent verification fails, compare the failed command and affected files with the candidate's base revision before broadening a repair. Preserve the original candidate and receipts. An identical baseline failure is an upstream dependency, not a passing gate, and must not be hidden by weakening the required check. Keep the admitted file scope intact when recording that dependency.

Automatic repair handoffs include a `repairPlan` containing current and previous candidate identities, failed checks, unmet review criteria, and the remaining two-attempt budget. Repeating an identical candidate/base and failure-evidence digest stops early with a durable blocker during reconciliation. Changed evidence can permit the remaining attempt; it is not proof of progress. Older attempts without repair observations remain readable and retain the hard attempt limit. Explicit operator recovery remains separate from automatic repair.

Context packs prioritize explicit requests, literal relative imports (up to two hops), and probable colocated or test-directory tests before alphabetical fallback. Per-file allocation reserves space for neighboring evidence. `selection`, `omitted`, and `omittedFileCount` explain what was read and what is missing. Import matching remains textual; aliases, computed dependencies, and truncated content require further investigation. See the [controlled comparison](upstream-ideas.md#reproduce-the-comparison).

### Reviewed verification authority and required CI

Existing verification receipts must be regenerated after this migration. Configure
`verificationAuthority.reviewedRevision` as the reviewed policy source revision and
`verificationAuthority.acceptance` as exact `{criterion, ruleIds}` bindings. Each
required command must invoke an administrator-provisioned executable beneath
`/opt/openclaw/checks/` inside the immutable sandbox root. Provision real independent
acceptance checks there; a wrapper that merely runs candidate-controlled package
scripts does not establish independent acceptance authority. Candidate source remains
untrusted. No check implementation is automatically installed by the framework.

Changing tests, package/lock files, scripts, build/test configuration or workflow
configuration additionally requires an independent policy approval in
`verificationAuthority.approvedChanges`: `{path, blobSha, reviewedBy}`. Use the exact
new Git blob ID, or `deleted` for removal. Revisions and policy changes invalidate
old receipts. This allows reviewed test maintenance without silently retaining the
old verification authority. The protected root and policy must remain unwritable
by candidate agents.

Where a criterion requires manual observation, its binding may use an empty
`ruleIds` array and `manualEvidence: {artifact, sha256, reviewedBy, headSha}`. The
artifact is an absolute path to independently reviewed evidence outside candidate
storage; its SHA-256 and candidate revision are checked again at release. Manual
observations do not replace required automated verification rules. Parent-created
command artifacts are hashed and checked before release; candidate output cannot
supply successful receipts. Command arguments are omitted from persisted evidence.

Application release also requires `requiredCi: {checks: [{name, appId}],
maxAgeSeconds}` with reviewed GitHub App identities. The release service queries
GitHub REST check runs for the exact reviewed commit and requires one completed,
successful, fresh run for every configured identity. Missing, ambiguous, skipped,
neutral, malformed and stale checks never authorize merge. Queued checks remain
pending. Repository branch-protection required checks must be covered by policy;
unavailable protection metadata fails closed. Repositories using only rulesets
must configure equivalent supported branch protection before this release path is
usable. Server-side protection and exact-head merge matching remain enabled.

### Protected receipt provenance

Verification now emits a version-one, parent-owned provenance envelope with an
immutable attempt/workflow identity, repository identity, base/head and raw-diff
digests, the reviewed policy snapshot and digest, skill digest, execution identity,
required check IDs, verifier Node/Git/platform versions and artifact hashes. The
snapshot and artifact files are restricted evidence and must not be published as
raw status output. Public summaries omit policy command arguments and sessions.
Independent review records the exact envelope digest and attempt ID. Reusing the
same commit in a repair attempt does not reuse review authority. Legacy records
remain readable but cannot authorize release; submit and verify through a new
reviewed attempt. Envelope files remain inspectable after candidate cleanup. No
cryptographic signature is claimed; protection relies on the privileged evidence
store and sandbox exclusion. The sandbox build-root toolchain remains an
administrator-provisioned dependency; the recorded host toolchain does not claim a
reproducible build-root image hash.

### Deployment health and restoration

Application deployment policy must name `targetId`, the expected
`artifactSha256`, `previousKnownGood: {revision, artifactSha256}`,
`observationSeconds` and `reconciliationSeconds`. The reconciliation deadline must
cover the observation window. Operators review these values for each release;
the framework never guesses a known-good artifact or changes production policy.
Before deployment, the independent check must confirm the previous known-good
identity and health. It receives `AUTOCODE_TARGET_ID`, `AUTOCODE_SHA`,
`AUTOCODE_ARTIFACT_SHA256`, workflow and attempt identifiers.

The configured check returns `{targetId, deployedSha, artifactSha256, healthy,
workflowPassed, observedAt, rolloutState}`. `observedAt` is an epoch-millisecond
observation timestamp; `rolloutState` is `settled` or `in_progress` from the actual
release controller. A valid receipt identifies the expected target, revision and
artifact. Healthy settled observations must span the configured parent-timed
window before completion. Polling intervals do not prove continuous health between
observations. Observation failure resets the window. A command exit code alone
never confirms a deployment or restoration.

Target ownership is durable across workflows sharing the supported native evidence
store. All writers to a target must use that same authority; this does not claim a
distributed lock across unrelated stores or independently configured hosts. An
unresolved deployment holds its target after timeout, interruption or a reconciliation
deadline. Read-only health reconciliation continues, but deployment is never replayed.
A confirmed settled unhealthy rollout can initiate the separately authorized rollback
before the deadline. Rollback has its own journal and independently verifies the
known-good target/revision/artifact and observation window. A lost rollback response
never causes another rollback command. Failed or ambiguous restoration retains the
hold and requires operator recovery.

Schema/migration changes require `forwardOnly: true` and a separately reviewed
`compatibilityPlan: {reviewedBy, artifact, sha256}`. Generic rollback is forbidden in
that mode. A shell command is not a database recovery plan. Pause or emergency freeze
blocks each new deployment/rollback; emergency freeze cancels owned command processes,
while independent health reconciliation remains read-only. Optional command
`idleTimeoutSeconds` and `outputLimitBytes` bound execution alongside total timeout.
Receipts distinguish cancellation, timeout, output limits and ordinary nonzero exits;
all remain non-authorizing until independent target evidence resolves the outcome.

### Promotion modes and canary evidence

Policies without `mode` now default to `observe`, even if `enabled` is true. Choose
and review a mode explicitly before resuming. The code enforces these permissions:

| Mode | Permitted work |
| --- | --- |
| `observe` | Read-only inspection and operator preflight |
| `propose` | Investigation and proposals |
| `implement-human-review` | Bounded implementation, verification and independent review; merge/release stays with a human |
| `staging-canary` | Reviewed release effects only against an explicit staging target |
| `application-release` | Reviewed application release with live staging evidence and an explicit production target |

Release modes require reviewed budgets and an independent `promotion` approval:
`{approvedBy, approvedAt, policyDigest, canaryArtifact: {path, sha256}}`.
`nativePromotionDigest` computes the policy digest excluding its approval field;
`nativeCanaryScopeDigest` binds the application scope, required checks and artifact.
A changed policy, replaced report, broadened scope, agent acting as its own operator,
or mismatched target invalidates promotion. Framework release remains human-gated
in every mode. Drain existing work before changing modes; never erase unresolved
effects to make a mode change convenient. Failures pause/freeze through the existing
operator controls and preserve evidence, rather than silently promoting/demoting
in-flight policy snapshots.

A controlled fixture report may support an operator's staging decision, but can
never authorize production. `application-release` requires a successful report
explicitly recording live staging execution, no mocked stages, a nonzero observation
window and operator sign-off. A report's declaration is not an independent attestation
of reality: the operator must verify its source evidence and target controller.
Provider capability evidence is separate from deterministic software fixtures.
No task count alone promotes a mode.

### Disposable native benchmark and canary runbook

The versioned `native-boundaries-v1` benchmark runs a committed JSON configuration
fix through native submission, protected receipt generation and independent review,
plus no-op, scope-escape, verifier-authority, stale-attempt and injected-instruction
cases. Its fixture uses real temporary Git repositories, SQLite and native gates.
Gateway, agents and OS sandbox process execution are explicitly doubled; the
trusted parent checks the committed input copy as JSON. Separate Linux kernel
isolation tests remain required. Release tests exercise controlled target-health,
rollback, seeded lost responses and pause/replay; the separate-process lease test
checks real SQLite ownership across process startup.

Run after the normal build/typecheck prerequisite:

```bash
pnpm typecheck
pnpm exec vitest run --fileParallelism=false tests/native-benchmark.test.ts tests/native-promotion-mode.test.ts tests/native-release.test.ts tests/native-process-lease.test.ts
```

To retain a new report, set `NATIVE_BENCHMARK_REPORT` to an unused absolute output
path when running the benchmark test. Reports are written exclusively, carry
benchmark/dataset/policy/skill/toolchain/budget metadata, list actual and mocked
steps, and represent missing provider cost as `null`. The generic fixture is bound
to its disposable repository and does not authorize an unrelated application.
`compareNativeBenchmarkReports` compares two recorded runs only when dataset,
policy and budgets match; controlled comparisons measure software regressions,
not model or prompt efficacy. They still require explicit human review for skill
promotion.

For a real staging canary, use an application-specific disposable fixture first,
review all required checks and rollback compatibility, record exact target/artifact
identity, configure an observation window and deadline, and obtain operator approval.
Keep production untouched. Stop and preserve artifacts on any scope escape, failed
required check, unknown external outcome, unhealthy target, exhausted budget or
ownership conflict. Review actual staging observation and restoration evidence
before issuing a separate application-release approval. Supplied policies remain
paused/observe until that review; running this test suite never activates them.

### Docker verification on restricted Linux hosts

An explicit `verificationSandbox: {backend: "docker", image: "sha256:<64 hex digits>", inputFiles: [...]}` selects a locally provisioned immutable Docker image. The image must include the administrator-reviewed `/opt/openclaw/checks/` executables and build dependencies. Candidate commands run without network or inherited credentials, with a read-only image, dropped capabilities, bounded resources, and only committed source copies mounted at `/work`. Cancellation removes the container as well as its client. Bubblewrap remains supported; there is no automatic unrestricted fallback.

OpenClaw 2026.9.1 and 2026.9.2 have reviewed Workboard contracts. In `implement-human-review` mode release remains disabled; named CI identities become mandatory before switching to a release mode.

Before first discovery, pause execution and use the administrator-only `autocode.skill.bootstrap` Gateway method with `boardId`, the reviewed immutable skill `digest`, `policyDigest`, and a `reason`. The method checks the authenticated administrator context and exact configured content; it cannot replace an already active skill. Skill changes still require evaluated promotion.


Source modules whose names contain `secrets`, `credentials`, or `policy` remain excluded by default. If a build needs one, the operator can include its exact path in `verificationSandbox.inputFiles` and add `reviewedSourceFiles: [{path: "libs/common/src/secrets.py", blobSha: "<full Git blob ID>", reviewedBy: "<operator identity>"}]` to the same sandbox configuration. Review the committed source first and obtain its blob ID with `git rev-parse <reviewed-commit>:<path>`. Only explicit source-code extensions qualify; hidden directories, environment files, PEM files and JSON policy or credential data cannot be exempted. Snapshot preparation checks every approved blob before copying any files. A changed module requires fresh review and policy approval; neither candidate content nor a worker request can update the allowance.
