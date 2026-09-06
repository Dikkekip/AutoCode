# AutoAgentClaw Framework Map

This document fixes the initial extraction shape for AutoAgentClaw so the workspace grows as a framework instead of accumulating LawyerRAG-specific branches.

## Core Runtime

- Inherit from LawyerRAG: queue refresh, job sweep lifecycle, lane-bounded task packaging, manager persona seeding, reviewer/promotion continuity from `LawyerRAG/scripts/openclaw_director.py`.
- Borrow from DevClaw: append-only event discipline and heartbeat-oriented background processing from `devclaw/lib/audit.ts`, `devclaw/docs/MANAGEMENT.md`, and `devclaw/docs/WORKFLOW.md`.
- Borrow from Paperclip: explicit adapter session-management and compaction policy instead of hidden per-adapter behavior from `paperclip/packages/adapter-utils/src/session-compaction.ts`.
- Implemented here: `queue-refresh` is now a real planner automation kind with repo-snapshot collection, append-only planner events, and artifact-backed task creation.
- Keep out of scope: LawyerRAG path allowlists, category names, and repo-local filenames as framework defaults. Those belong in profiles.
- Target packages: `packages/core-runtime`, `packages/domain`, `packages/executor`.

## Orchestra / Runtime Planning

- Inherit from LawyerRAG: promptify -> plan -> subtask -> reviewer handoff artifact chain from `LawyerRAG/scripts/codex_orchestra.py`.
- Borrow from Squad: dependency-aware fan-out, orchestration logging, and planner-normalized work items from `squad/packages/squad-sdk/src/platform/planner.ts` and `squad/templates/orchestration-log.md`.
- Borrow from AutoAgent: keep a human-readable directive file that constrains the harness and records keep/discard evaluation logic from `autoagent/program.md`.
- Implemented here: planner prompts are repo-owned, planner output is strict JSON, and queue refresh writes `planning-snapshot.json`, `planning-output.json`, `orchestration-log.md`, and planner events before creating deduped tasks.
- Implemented here: planner dependency graphs are validated, persisted as task prerequisites, and materialized in topological order so independent coding slices fan out while dependent slices wait for merged code.
- Implemented here: planner target paths flow into durable TeamRouter assignments and atomic artifact claims, preventing concurrent agents from editing overlapping scopes while leaving independent slices parallel.
- Keep out of scope: repo-specific prompt text, fixed subagent counts, and adapter-specific branch heuristics.
- Target packages: `packages/orchestra-codex`, `packages/domain`, `apps/dispatcher-cli`.

## Project Profile Schema

- Inherit from LawyerRAG: lanes, required-reading rules, verification rules, routing hints, manager seeds, promotion policy, and artifact policy currently encoded in `scripts/openclaw_director.py`.
- Borrow from Goose: editable/open governance and explicit major-change expectations from `goose/GOVERNANCE.md`.
- Borrow from DevClaw: operator-trust defaults and deterministic transition thinking from `devclaw/openclaw.plugin.json` and workflow docs.
- Implemented here: profile schema now carries planner policy, governance gates, default planner adapters/personas by lane, and planner artifact policy.
- Borrow from Caveman: selectable `lite`, `full`, and `ultra` response compression with explicit precision and safety exemptions.
- Implemented here: `responsePolicy.compressionMode` is validated profile data, while `dispatcher tick --caveman [level]` and full-cycle queue refresh provide transient overrides. Runs persist the resolved source, response size, and output-token telemetry.
- Keep out of scope: embedding any single repo's file layout into package code.
- Target packages: `packages/project-profiles`, `profiles/*`.

## Memory / Eval

- Inherit from LawyerRAG: embedding lifecycle hooks, queue refresh memory sync, and promotion/review artifacts as memory inputs.
- Borrow from AgentScope: memory compression, evaluation posture, and agent-to-agent/runtime abstraction from `agentscope/README.md`, `agentscope/tests/memory_compression_test.py`, and `agentscope/tests/evaluation_test.py`.
- Borrow from AutoAgent: benchmark-style keep/discard loop and verifier-first evolution from `autoagent/README.md` and `autoagent/program.md`.
- Keep out of scope: model-specific embedding providers as hardcoded framework dependencies.
- Target packages: `packages/memory-runtime`, `packages/domain`.

## Citation / Summary Provenance

- Inherit from LawyerRAG: strict inline citation validation, stable source-index tracking, and structured source payload shaping from `LawyerRAG/apps/backend/lawyer_rag/rag.py`.
- Implemented here: reusable source-citation middleware that prepares location-aware source tags, normalizes legacy numeric citations, validates final summaries against known source locations, and emits portable provenance for downstream runtimes.
- Keep out of scope: LawyerRAG-specific document labels, UI rendering rules, and storage-specific link formatting.
- Target packages: `packages/source-citations`.

## Audit / Ops

- Inherit from LawyerRAG: run events, task events, promotions, job runs, and stale-session cleanup expectations from the director runtime.
- Borrow from DevClaw: append-only NDJSON-style logging and atomic transition discipline.
- Borrow from Goose: transparent architectural change process and public review expectations for major framework shifts.
- Borrow from Squad: cooperative rate limiting, priority retry windows, predictive quota exhaustion, failure recovery, reflection, and tiered memory playbooks.
- Implemented here: rate-limit scheduling helpers live in `packages/domain/src/rate-limits.ts`, and agent-facing recovery/reflection/memory playbooks are bundled under `skills/`.
- Implemented here: team assignments, routing evidence, and artifact claims persist in SQLite at the task/run lease boundary, release through terminal and recovery paths, and are visible through the dispatcher CLI and management status.
- Implemented here: review rejection creates durable task-scoped author lockouts and blocker/handoff mailbox threads, so repair work routes to an independent eligible agent after restarts instead of silently returning to its author.
- Keep out of scope: channel-specific notification implementations beyond generic adapters and policy hooks.
- Target packages: `packages/audit-runtime`, `packages/core-runtime`, `apps/dispatcher-cli`.

## Adapters

- Inherit from LawyerRAG: codex/gemini lane preferences and thin executor boundaries.
- Borrow from Paperclip: adapter-declared session resume and compaction capability tables.
- Borrow from AgentScope: flexible tool/runtime abstractions and A2A-friendly posture.
- Borrow from Goose: provider choice stays explicit in adapter metadata instead of being hidden behind fake-uniform shims.
- Keep out of scope: adapter-specific policy branches inside core queue or planning logic.
- Target packages: `packages/executor`, `packages/domain`, `packages/orchestra-codex`.

Runtime identity and heartbeat scope are now first-class adapter concerns:

- `runtimeKey` is the stable continuation identifier for wakes, retries, and resumed sessions.
- `executionKey` is the per-run trace identifier for operator visibility and audits.
- Adapter capability differences stay explicit through declared session-resume and native-context metadata.

## Installer / Adoption

- Inherit from current workspace: repo bootstrap, profile install, wrappers, and safe `.gitignore` adoption path.
- Borrow from AutoAgent: `program.md` as a first-class human directive that explains what the harness is allowed to change.
- Borrow from Goose: editable prompts, recipes, and extensions as a platform principle rather than a closed runtime.
- Keep out of scope: one-shot LawyerRAG migration code living permanently in installer paths.
- Target packages: `apps/dispatcher-cli`, `packages/project-profiles`, `skills/openclaw-workspace-bootstrap`.

## Native cutover responsibility map and incremental boundaries

| Surface | Responsibilities retained after cutover | Transitional responsibilities to leave in place |
| --- | --- | --- |
| `packages/executor/src/runner.ts` | Compatibility verification, worktree inspection and dependency isolation for rollback and preserved work | Legacy dispatch, retries, quota selection, planner invocation, promotion and job execution. Native Workboard owns new execution; do not redesign this queue. |
| `packages/db/src/store.ts` | Historical tasks/runs/events, migration source, validated backup and archive inspection | Mutable dispatcher leases, automations, task transitions, routing and queue repair. Keep schema and migration contracts stable until the observation and rollback periods finish. |
| `apps/dispatcher-cli/src/index.ts` | Bootstrap/profile installation, native command registration, policy inspection, evidence export and migration entry points | Legacy tick/director/account-management commands; preserve command names during migration. |
| `packages/project-profiles/src` and `profiles/` | Validated repository policy, lanes, reading, verification and native conversion | Explicit opt-in execution compatibility for pre-native projects; never import baseline waivers into native verification. |

The native path uses `native-evidence.db`, not the dispatcher database. Its migration adapter still reads historical dispatcher state. Native verification fails closed; legacy baseline comparisons are not a reusable native execution gate. Removal remains conditional on the operator acceptance and rollback periods in [native-autonomy.md](native-autonomy.md#migration-and-rollout), not this refactor.

Review the extractions separately:

1. `execution-policy.ts` in project-profiles validates the optional execution compatibility surface; the existing `lawyerrag` profile is the compatibility profile. `verification-commands.ts` consumes explicit policy for focused tests, pytest coverage and nested target repair. Missing policy means no application-specific inference.
2. Executor `execution-policy.ts` resolves installed policy (including the main checkout for linked worktrees), then detected built-in policy. `execution-dependencies.ts` owns dependency sharing, manifest comparison, isolated installation and legacy virtualenv-link cleanup. The runner retains orchestration and delegates those mechanisms.
3. DB `backup-retention.ts` owns best-effort retention without changing backup creation, database schema or queue transactions. CLI `archive.ts` owns the existing stored ZIP encoding used for evidence exports. These remain useful for archive operations after cutover.

### Compatibility migration

Existing installed profiles are authoritative. To retain the former implicit LawyerRAG behavior, copy the `executionPolicy` object from `profiles/lawyerrag/profile.json` into `.openclaw/profile.json`, preserving local edits. A detected built-in profile already includes it. An installed profile without this object deliberately disables the compatibility behavior; native policies continue to use their explicit verification commands.

`nodeTestRoot` enables npm/Vitest focused tests under that root's `src`, shared `node_modules`, and isolated `npm ci` when manifests differ. `pythonTestRoot` enables focused pytest commands with coverage disabled and isolated `.venv`; optional `pythonTestFallback` identifies the nested package to search for missing test targets. `baselinePathRoots` resolves legacy diagnostic paths and opts focused commands into baseline comparison; `baselineChecks` maps repository command markers to the supported legacy diagnostic parsers. Paths must be safe repository-relative paths; unknown fields and malformed values are rejected. This is a bounded compatibility surface, not a new universal build system.

The exported verification helper names remain available. Callers of `focusedChangedTestVerificationCommands` must pass the validated execution policy as argument two; callers of `normalizeVerificationCommand` pass it as argument three after tool availability. Without it these helpers perform only generic behavior. `repairBackendPytestPaths` retains its historical name but resolves repository policy rather than assuming a package name.

Repository-context discovery now recognizes an available root OpenAPI make target independent of the Python service's directory. Imported workflow promoters use validated `promotionPolicy.importPersonaNames`, then the existing role/lane fallback. Copy this field from the compatibility profile too when preserving its preferred import persona. Application-name stopwords are no longer hidden context-ranking defaults.

Installed profiles are now fully validated on runtime resolution and CLI policy checks. Older partial profiles (for example, ones without `planner`) must be completed from their current built-in profile before resuming dispatch; to keep planning disabled, include the complete planner object with `enabled: false`. Invalid profiles fail before execution instead of being silently cast or replaced by detection. Keep the local persona and verification customizations when migrating.

Validation: the alternate `tests/fixtures/profile-repositories/split-services` repository uses `ui/console` and `services/catalog/catalog`. Tests cover a complete dispatcher implementation with inferred verification, real npm test execution, native policy conversion with the alternate lane scopes, linked-worktree policy resolution, dependency sharing and isolation, malformed policy rejection, compatibility opt-in, ZIP readability and backup retention.

Generated planner prompts now derive persona suggestions from the validated profile roster. Ownership document discovery recognizes implementation indexes without fixed application names or numbered spec paths. The historical `framework.*.inheritedFromLawyerRag` metadata key remains readable for profile compatibility; it records provenance and does not select application execution behavior.
