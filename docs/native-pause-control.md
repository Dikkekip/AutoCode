# Native pause and release control

`autocode.pause` revokes permission for new work. It does not cancel requests already sent to OpenClaw, GitHub, Git, or the deployment runner. Workboard and Automations remain the execution owner; native memory, subagents, and their evidence are unchanged.

Pause and explicit `autocode.resume` each atomically persist a fresh opaque control revision and a `control.paused` or `control.resumed` audit event in `native-evidence.db`. Resume retains the existing admin scope, enabled-policy requirement, and readiness checks. A pause during those awaited checks invalidates that resume attempt. A successful resume authorizes a new call; it never revives a call that began under an older revision.

Discovery, admission, submission, repair, reconciliation, and release carry their original authorization through awaited steps. The runtime checks that authorization at native runnable-card creation/promotion and dispatch boundaries. Release checks it immediately before push, PR creation, merge, deployment, and rollback. Blocked/scheduled evidence cards, completion updates, and observation of existing operations may continue while paused. A pause is a waiting condition, not a permanent workflow failure requiring an unrelated repair.

## Reconciliation and uncertainty

Push, PR, merge, and deployment attempts have durable operation records. A successful response or matching remote evidence confirms the attempt. Push recovery reads the exact remote branch SHA; PR recovery matches the candidate head; merge recovery reads GitHub's merge commit; deployment recovery requires the exact merged SHA and a passing workflow receipt. Unknown effects are not blindly replayed. Transport errors and unconfirmed outcomes remain visible in operation records and release waiting events. Resume does not clear those records or bypass independent review, scope, design, or revision gates.

Paused reconciliation can observe existing release operations and record their outcomes. It must still satisfy the evidence gates needed to interpret that release; missing/stale local evidence can require operator investigation. Confirmed completion may be recorded while paused, since completion is evidence of work already accepted, not authorization to initiate more work.

OpenClaw remains authoritative for accepted native cards and runs. A card made runnable before pause may still be started by native Automations, and a dispatch request already submitted may still start workers. Pause does not call abort on native subagents or attempt to implement a second scheduler. Existing independent investigation budget enforcement is unchanged.

## Emergency freeze and owned command cancellation

`autocode.freeze` / `dispatcher native freeze` pauses new work and advances a separate persistent freeze revision. This aborts owned local commands in the current process; other processes observe the revision on a 100 ms poll. The freeze revision survives resume, so a freeze/resume between polls still cancels the old command. Plain pause drains accepted work and does not abort its process signal.

The common process adapter handles AbortSignal, graceful process-group termination, forced cleanup after its grace period, idle/wall timeouts and output overflow. Candidate sandbox commands fail with typed cancellation/timeout/output-limit outcomes. Tests exercise an actual local process tree. Windows process-tree guarantees remain unsupported; native execution requires the Linux sandbox policy.

Aborting a process or requesting a native session abort does not prove that an external service rejected an already-sent operation. Keep uncertain deployment/merge intents and reconcile them against remote revision/health truth. Freeze does not erase claims, receipts, or operation records. Resume still requires reviewed enabled policy and doctor readiness.

## External race boundary

The final local control read and external acceptance are not one distributed transaction. Another process can pause after the last read, or a local CLI may already be submitting a request when pause arrives. Such an operation can still complete. There is no claim of instantaneous cancellation, and an interrupted response is not proof of rejection. An operation journaled immediately before a process interruption may be uncertain even if the request never reached the external service. Preserve that uncertainty for inspection rather than guessing and replaying it.

Tests inject pause between awaited steps and after mock external acceptance. They assert that later new effects stop, that already accepted operations can finish and be reconciled, and that explicit resume does not duplicate push, PR, merge, or deployment effects. These tests do not establish remote cancellation guarantees.

## Compatibility and rollout

No schema migration, dependency, scheduler, or production policy change is needed for this control revision. Existing `control/pause` records without a revision use the legacy revision until the first explicit pause/resume. Existing operation records remain valid; unknown outcomes continue to block replay. `autocode.status` adds the effective paused state and revision. Pause/resume responses add revision and timestamp fields.

Use the administrative pause/resume methods; direct edits to the pause record do not provide revision or audit guarantees. Upgrade all runtime processes that share a journal before relying on revocation: older binaries do not enforce the new checks. Framework changes still require independent human review and separate release authorization. The test suite uses mocked external release effects; no live push, merge, deployment, or autonomy activation is required to verify these boundaries.

## Original implementation record (before backlog integration, 2026-09-06)

Reproduction before implementation:

```sh
pnpm exec vitest run tests/native-release.test.ts --fileParallelism=false
```

Result: exit 1, 1 failed / 7 passed. The new test paused during an awaited PR read; the release promise incorrectly resolved after proceeding through merge and deployment.

Final native regression command:

```sh
GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false pnpm exec vitest run tests/native-release.test.ts tests/native-pause-plugin.test.ts tests/native-autonomy.test.ts tests/native-quality.test.ts --fileParallelism=false
```

Result: exit 0, 4 files / 66 tests passed (25 release, 4 plugin pause, 15 native autonomy, 22 native quality). The process-local Git setting permits unsigned temporary fixture commits; it does not change repository or user configuration. Without it, the sandbox cannot access the user's signing agent. An intermediate run also exposed a concurrent admission-test mismatch; the final native run passed after that separate work changed.

```sh
pnpm typecheck
pnpm exec biome check packages/core-runtime/src/native/control.ts packages/core-runtime/src/native/runtime.ts packages/core-runtime/src/native/release.ts packages/core-runtime/src/native/plugin.ts packages/core-runtime/src/native/quality.ts tests/native-release.test.ts tests/native-pause-plugin.test.ts
git diff --check
```

Results: all exit 0; Biome checked 7 files without fixes. SHA-256 comparisons confirmed those seven source/test files did not change during final validation. Base HEAD was `51d44ff7f630ad639bd8a1ad6d70a0c0f5e59734`; implementation remains uncommitted. Other tasks concurrently modified the shared working tree, including overlapping files, and their changes were preserved.

Pause-specific file scope:

- `packages/core-runtime/src/native/control.ts`: asynchronous call-chain revision, atomic administrative control/audit records.
- `packages/core-runtime/src/native/runtime.ts`: revision propagation, dispatch/promotion/verification checks, paused release observation.
- `packages/core-runtime/src/native/release.ts`: effect-boundary checks, durable push reconciliation, preservation of uncertain external outcomes.
- `packages/core-runtime/src/native/plugin.ts`: audited admin pause/resume and rejection of an overtaken resume.
- `packages/core-runtime/src/native/quality.ts`: retain the discovery call's revision across awaits.
- `tests/native-release.test.ts`: pause, accepted-operation race, explicit resume, uncertainty, native dispatch, and verification tests.
- `tests/native-pause-plugin.test.ts`: admin scope, audit, disabled policy, readiness failure, and concurrent pause tests.
- `docs/native-pause-control.md`: behavior, compatibility, remaining race, and validation record.

Live OpenClaw/GitHub/deployment end-to-end validation: **BLOCKED**; only fixture gateways and release I/O were exercised, and no live release authorization was supplied. Full-repository tests were not run for this scoped change. Independent human review and separately authorized framework release remain pending.
