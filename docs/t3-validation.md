# T3 backend validation

Development baseline: `0651747ba6af56a0e32fef05968639313ba45b04`. This record describes the experimental additive backend, not production adoption. Node 24.22.2 and pnpm 10.30.3 were used on 2026-10-31.

## Reproducible checks

```bash
pnpm exec tsc -b packages/t3-runtime
pnpm typecheck
pnpm exec vitest run tests/t3-*.test.ts
pnpm lint
pnpm run ci
```

The focused suite covers persona inheritance and actual prompts; private journal identity, independent competing owners, monotonic fences, expiry and transactional rollback; committed source custody and tampering; proposal/no-op provenance and duplicate delivery; planner admission, dependencies, capacity, scopes and budgets; high-risk design; independent exact-head checks and acceptance coverage; rejected review, bounded repair and moved heads; restart and uncertain effects; model/provider/project binding; pending descendants, cancellation before a run starts, pause/freeze; disabled schedules; and bounded authenticated JSON/SSE MCP transport.

The complete repository pipeline also runs existing dispatcher and native runtime smoke checks. Its native Gateway is synthetic; those checks do not establish live T3 adoption. New T3 tests use callback/HTTP host fixtures and disposable Git repositories. They do not call provider models. Full-suite counts and the final committed SHA are available in the local CI receipt when `pnpm ci:agent` is run from the clean committed checkout. Receipts live under `git rev-parse --git-path agent-ci`, outside source.

## Actual Docker demonstration

```bash
node scripts/t3-demo.mjs --image sha256:b6a53c55ae53419fad5345d02cd59dc0b551dddec1bfca7e9ac42f0a51ceec09
```

Observed retained local evidence: `/tmp/autocode-t3-demo-MmJNte/summary.json`, with its private SQLite journal and scripted host transcript. This temporary path is host-local evidence, not a portable committed artifact. Re-run the script to obtain a fresh fixture and summary on another machine. Build the harness as documented in [setup](t3-autonomy.md) when the image is absent.

The fixture reached `ready` / `PR approved` through seven distinct responsibilities: custom safety researcher, planner, design architect, implementer, QA verifier, independent reviewer and release manager. The source and candidate are real commits in its disposable repository. It released/reacquired coordinator ownership between turns and retained exact candidate, prompt, persona, result, review and verification bindings.

The protected harness actually executed in Docker and passed. Retained inspection showed `NetworkMode=none`, `ReadonlyRootfs=true`, `CapDrop=[ALL]`, `no-new-privileges`, `Privileged=false`, a nonroot `1000:1000` user and only the private exported candidate mounted at `/work`. The runner retained terminal exit and verified container absence. The harness was outside the candidate at `/opt/autocode/verifier/check` in the immutable image. This fixture checks a small JSON value; it does not qualify a real application's acceptance harness.

The summary explicitly records `published=false`, `merged=false`, `deployed=false`, and `recurringScheduleActivated=false`. No actual child/thread or provider was used; host role outputs were scripted. `Done` was not assigned to this unmerged candidate.

## CLI smoke and remaining qualification

Startup follow-up added an authenticated agent-owned stdio relay, avoiding a separate HTTP credential when an owning T3 agent forwards its advertised tools. Eight relay tests cover chunked/correlated responses, tool restrictions, concurrent calls, timeout, malformed/mismatched/oversized replies, closure and lost-effect handling. The executable launch regression exercises the generated profile through admission/implementation and forwards scripted host replies through the actual CLI. It verifies exit while the parent's stdin remains attached. This caught and fixed a pipe lifetime bug. These are host fixtures, not live T3 delegation.

The follow-up also corrected the shipped example's lane mismatch: custom research personas explicitly allow `app-core`, and implementation uses the minimal profile's `minimal-runtime-engineer`. A status-only smoke did not expose the original mismatch; the regression now checks the actual proposal and implementation path.

The profile generator and example configuration were exercised together using a private fixture. Local `status`, `goal`, `pause`, persisted paused `status`, and `resume` succeeded without a token file or host calls. The generated custom research managers use the minimal profile's existing `app-core` lane and retain distinct missions and quota weights.

Live qualification subsequently started in a dedicated, correctly bound T3 project through the stdio relay using inherited Codex settings. A real security researcher returned a source-bound proposal; the independent planner deferred because the host's initial message omitted the proposal and the inherited profile referenced absent `.openclaw` files. The complete native receipts and deferred result remain in private startup state. This is live research/deferral evidence, not end-to-end workflow qualification. Dispatch now uses a short launch envelope and complete hashed local brief; regressions cover long-brief retention, restart/uncertain-effect behavior, file substitution and required reading for configured roles. The audited T3 0.1.5 contract cannot enforce a research tool allowlist: accepting prompt-only restrictions does not establish a read-only sandbox.

A separate protected journal acceptance image was built from the cached Node digest and trusted baseline inputs. Its tests/config/executable execute from the read-only image, outside candidate control; only the journal source is overlaid. Sandbox qualification passed seven baseline checks, reproduced two filesystem defects and rejected a deliberately broken module, with terminal and verified-cleanup receipts. Earlier harness startup failures are retained. This is scoped harness qualification, not a passing repaired candidate, whole-application validation, ownership/race proof or release approval. Broader candidate scopes require corresponding protected acceptance checks.

Native goals use provider-thread commands; the CLI prints them and does not claim an invented goal MCP endpoint. Interval schedules can be saved disabled, with durable uncertain-send handling. Activation, fixed-time/webhook setup, provider goal controls and PR linking/watching remain native operator surfaces. Pause/freeze gates queued work and requests known-task cancellation; it cannot revoke an already dispatched external operation. Token budgets are estimates because authoritative provider usage is not advertised.

No production schedule, live record, ownership pause, OpenClaw service or existing worktree was changed. Publication, merge, deployment and migration remain outside this development evidence. The [cutover checklist](t3-autonomy.md#cutover-checklist) describes the separately authorized qualification and ownership transfer.

## Live journal lock-loss follow-up

Live persona research, independent admission, managed-worktree implementation and
QA reached protected exact-candidate verification and independent review. Although
the scoped protected harness and full host CI passed, review reproduced a blocking
POSIX lock-loss defect: closing a separately opened journal descriptor released
another same-process SQLite connection's transaction locks. The original candidate
remains unaccepted. The run was frozen at its repair limit; its native review was
retained but could not be applied because object findings violated the string-only
result contract. No release approval is inferred from passing tests.

The local follow-up removes raw descriptor opens for existing journal files. New
files are created privately at an unpublished staging path, closed, then published
with an exclusive hard link. A concurrent existing path is never overwritten or
independently opened. Admission still requires trusted directory custody and private,
owned regular files/sidecars; it does not claim protection against root or malicious
same-UID actors. Hard-link support on the state filesystem is required for new files.
The brief two-link publication transition has a bounded metadata wait; persistent
hardlinks remain rejected. Only SQLite manages descriptors for published databases.

Cross-process regressions hold a foreign database's write transaction open, prove a
second process is blocked before and after application-ID or sidecar rejection, and
prove that it can acquire the lock after rollback. Both failed against the reviewed
implementation. Local follow-up evidence does not resume the frozen coordinator,
replace its retained results or grant independent review/release approval.
