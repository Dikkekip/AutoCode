# Repository ideas applied to AutoCode

Reviewed the nine sibling repositories in the local AutoAgentClaw workspace on 2026-09-11. This is a repository-wide inventory with targeted reading of orchestration, skills, recovery, context, evaluation, and contract code; it is not a line-by-line audit of every file. The reference revisions below identify the inspected snapshots. No upstream code was executed to activate agents.

## Source inventory

| Repository | Inspected revision | Relevant evidence paths in that repository | Main ideas |
| --- | --- | --- | --- |
| AgentScope | `907b542ad74d90b55bff50986758fd290dff2aa9` | `src/agentscope/pipeline/_goal_pipeline.py`, `src/agentscope/skill/_local_loader.py` | Separate executor/verifier, structured failure feedback, persisted iteration limits, discoverable skill metadata. |
| AutoAgent | `eb3f185dc9faac276955b4fe5feb93c8f836b644` | `README.md`, `program.md` | Baseline-first harness experiments, immutable evaluator boundary, fixed model/configuration, per-case results, prefer simplicity on ties. |
| Caveman | `15581d14007fd01fb3f132016741962f34936ca2` | `skills/investigate-first/SKILL.md`, `skills/surgical-patch/SKILL.md`, `skills/verify-and-stop/SKILL.md`, `skills/safe-refactor/SKILL.md`, `skills/migration/SKILL.md`, `LICENSE`, `LICENSE.BSL` | Evidence before edits, narrow corrections, sufficient verification, behavior-preserving refactors, explicit migration stages, compact factual context. |
| DevClaw | `f454f104b56c749584ba4b7d05406966cbdb04bd` | `README.md`, `lib/dispatch/message-builder.ts`, `lib/dispatch/pr-context.ts`, `lib/services/heartbeat/` | Deterministic orchestration, separate role guidance, focused returning-review context, external task owner, branch continuity. |
| Goose | `846cbeaf5157f9be8a22aec93bd2ba9c5ddad983` | `README.md`, `crates/goose-context-management/src/structured.rs`, `crates/goose-context-management/src/prompts/compaction_summary.md` | Composable workflows and structured summaries preserving intent, files, errors, pending work, and next step. |
| LawyerRAG | `5f61b4e02cd05b964ba1e6a9911221b9dc7d5702` | `AGENTS.md`, `scripts/check-dapr-contract.py`, `README.md` | Machine-readable contracts, reader/writer compatibility, local/deployment parity, representative application verification. |
| Loop Engineering | `8a432a2efe202f6447eb003dd1d1f9682655e940` | `README.md`, `tools/loop-context/src/context-manager.ts`, `tools/loop-context/src/budget-resolver.ts`, `tools/loop-gate/src/gate.ts`, `skills/loop-constraints/SKILL.md` | Failure-history circuit breakers, bounded budgets, mechanical gates separate from historical decisions, progressive autonomy supported by outcomes. |
| Paperclip | `d56be3f3fcc9ce672473daf58b89a05fd8f23818` | `README.md`, `server/src/services/recovery/run-liveness-continuations.ts`, `server/src/services/heartbeat-policy.ts` | Bounded continuation, idempotent wake identity, assignment and budget checks before resuming, concrete next action. |
| Squad | `9587fcde60cead6922c92e70b996e645759d4b51` | `packages/squad-sdk/src/skills/skill-loader.ts`, `templates/skills/iterative-retrieval/SKILL.md`, `templates/skills/session-recovery/SKILL.md`, `templates/skills/history-hygiene/SKILL.md` | Motivation and acceptance in handoffs, retry deltas, validation by the receiving coordinator, durable session evidence, focused skills. |

## Applied changes

| Idea | AutoCode integration | Observable behavior |
| --- | --- | --- |
| Retrieve related evidence before filler | `packages/core-runtime/src/native/context-pack.ts` | Explicit requests remain first; bounded literal-import traversal and probable tests precede alphabetical fallback. Output explains selection reasons and omitted files. |
| Reserve room for neighboring evidence | Same context pack | Fair per-file allocation prevents a large first file from consuming the whole pack. UTF-8 byte, file, revision, and scope limits remain enforced. |
| Distinguish a dependency from an arbitrary string | Same context pack | Import/from/require forms supply literal-path leads. An unrelated quoted relative path alone no longer creates an import edge. This remains a textual heuristic. |
| Retain failure deltas across repairs | `native/repair.ts`, `native/runtime.ts` | Repair context contains prior/current candidate identity, failed checks, unmet review criteria, remaining attempts, and a concrete next action. |
| Stop repeated attempts without new evidence | Same repair integration | The same candidate/base and failure-evidence digest stops a second automatic repair. A changed candidate or new evidence can use the remaining attempt. The hard two-repair limit remains. |
| Compose skills without mutable hidden instructions | `native/skill-bundle.ts`, `native/skills.ts`, `native/plugin.ts`, `native/doctor.ts` | Explicit local resource manifests are bounded, validated, and included in the immutable reviewed text digest. Supporting-file changes invalidate approval. |
| Inspect skills before activating them | `native skill inspect [--include-text]` | Offline, read-only CLI output shows the exact composed skill and policy digests used by bootstrap, with optional full instructions. |
| Make repository skills usable by the default workflow | `skills/native-coding/`, `native/adoption.ts`, `native/quality.ts` | Newly prepared policies use a native workflow skill plus six focused modules. Discovery delivers the reviewed bundle; investigation prompts pass applicable guidance into admitted implementation work. |
| Preserve intent and next action across session boundaries | `skills/native-coding/durable-handoff/` and repair context | Separate observations, completed work, pending criteria, uncertain effects, and next action. Retain existing Workboard ownership and authenticated context retrieval. |
| Validate cross-environment contract changes | `skills/native-coding/contract-change/` | Guidance traces readers/writers and supported rollout stages, reuses project contracts, and keeps endpoints and service names in profiles. |
| Compare actual outcomes against a fixed baseline | `scripts/benchmark-context-selection.mjs`, `skills/native-coding/harness-experiment/` | A reproducible Git-based retrieval comparison records relevant excerpts, irrelevant excerpts, bytes, regressions, and candidate artifact/dataset digests. |

## Useful ideas already present

Avoid creating competing implementations of these existing capabilities:

| Pattern | Existing AutoCode owner |
| --- | --- |
| Task scheduling, claims, managed worktrees, session lifecycle | Native OpenClaw Workboard; AutoCode does not add a second scheduler. |
| Independent verification and reviewer roles | `native/verification.ts`, `runtime.ts`, `broker.ts`. |
| Explicit authority and policy gates | `native/control.ts`, `promotion-mode.ts`, `provenance.ts`, `required-ci.ts`. |
| Idempotent effects, unknown outcomes, restart recovery | `native/store.ts`, `runtime.ts`, `recovery.ts`. |
| Atomic per-attempt and aggregate budgets | `native/budget-ledger.ts`. |
| Model/role eligibility from measured capabilities | `native/capabilities.ts`; heuristic role tiers also exist in compatibility domain code. |
| Durable lessons with evidence and invalidation | `native/memory.ts`. |
| Proposal deduplication and changed-evidence reopening | `native/dedupe.ts`, `quality.ts`. |
| Admission capacity and dependency checks | `native/runtime.ts`, `quality.ts`. |
| Composable task recipes and workspace commands | Domain helpers exercised by `tests/imported-ideas.test.ts`. |
| Controlled benchmark plus injection gates for skill promotion | `native/benchmark.ts`, `skills.ts`. |
| Deployment identity, health observation, rollback evidence | `native/deployment.ts`, `deployment-health.ts`. |

## Deliberately deferred

- **A second orchestration engine or autonomous nested teams:** Workboard already owns execution. Importing another scheduler would introduce competing claims, retries, and budgets. New orchestration should first demonstrate a missing Workboard capability.
- **Self-editing active skills or automatic model escalation:** Keep experimentation separate from reviewed promotion and measured eligibility. A benchmark gain does not grant execution authority.
- **Full semantic repository graphs:** The new retriever is a bounded literal-path and filename heuristic. Language servers, alias resolution, reverse dependency indexes, Python module resolution, and dynamic dispatch need separate implementations and language-specific tests.
- **LLM-generated conversation compaction:** The handoff structure is adopted, but OpenClaw owns session compaction. AutoCode does not add another model call or fabricate a summary of inaccessible session history.
- **Automated destructive migration/contraction or stale-base rebase:** Existing scoped recovery and fresh verification remain the path. Mixed-version and uncertain remote effects need explicit evidence.
- **Application-specific Dapr/Azure logic:** Transfer the contract-checking method; keep LawyerRAG's service names, deployments, data, and credentials out of generic framework code.
- **Caveman Engine runtime:** Its engine-linked directories are under BSL-1.1. This change uses independently written framework code and concepts from the MIT skill area; no BSL runtime is vendored.

## Reproduce the comparison

```bash
pnpm install --frozen-lockfile
pnpm benchmark:context --out /tmp/autocode-context-comparison.json
pnpm exec vitest run tests/native-context-pack.test.ts tests/native-repair.test.ts tests/native-skill-bundle.test.ts tests/native-autonomy.test.ts tests/native-skill-governance.test.ts
pnpm run ci
```

The checked-in [controlled report](benchmarks/context-selection.json) compares the previous alphabetical packing policy with related-file selection under identical four-file/2,048-byte budgets. Its five synthetic cases test excerpt availability; they do not measure coding success, token costs, or a tenfold gain. The source-policy baseline intentionally uses the same committed-file reader as the candidate to isolate selection changes.

The six modules and router validate with the skill-creator validator. Native tests exercise immutable resource promotion, path/UTF-8/size boundaries, explicit-path priority, dependency cycles, repair history, legacy attempts, and unchanged-failure stopping. Live model effectiveness and installed OpenClaw certification remain separate evidence.

Local validation on Node 22.23.1 and pnpm 10.30.3:

- The original focused baseline passed 55 tests before implementation.
- The updated core integration suite passed 72 tests.
- `pnpm run ci` passed lint, typecheck, 877 Vitest tests in 106 files, five Node tests, build, and both runtime smoke checks. Three optional environment-dependent isolation tests were skipped. Lint reports existing warnings outside these changes.
- After adding the offline skill-inspection command, its focused CLI/governance suite passed all 12 tests; typecheck and compiled runtime smoke were repeated.
- The controlled retrieval comparison passed all five candidate cases against two baseline passes, with no baseline-to-candidate regressions. Each run records its compiled candidate artifact digest.

These are local implementation checks, not an activated autonomous deployment. Existing configured skills and active snapshots are preserved; new policies select the new bundle and still start disabled.

## Attribution

Implementations are written for AutoCode's existing native contracts. Skill guidance adapts concepts from the listed repositories instead of importing their service configuration or executing their instructions. MIT notices for adapted sources are retained in [third-party/idea-sources](../third-party/idea-sources/). AgentScope and Goose informed design concepts; no Apache-licensed runtime code or prompt template is reproduced. AutoAgent labels its README MIT but has no standalone license file in this snapshot. LawyerRAG is treated as an application example, not a source of vendored code.
