# Native implementation status

This is a capability and limitation map for the current native runtime. Workboard and Automations own execution; application activation requires independent verification, reviewed policy, and operator approval. See [verification lanes](verification-lanes.md) for reproducible checks.

## Capability map

| ID | Implementation and evidence location | Compatibility or practical boundary |
|---|---|---|
| 01 | `native/control.ts`, runtime/plugin freeze; native pause/freeze/release tests | Drain stops new effects; freeze requests cancellation. Accepted remote work can remain uncertain. |
| 02 | `os-adapters/shell.ts`, native verification isolation and protected mounts | Real Linux bubblewrap boundary required; unsupported hosts fail closed. |
| 03 | `native/broker.ts`, plugin factory caller resolution, doctor role permissions | Trusted local plugin context; caller-supplied identity is not authentication. Remote tool-only bridge is unsupported. |
| 04 | Verification coverage plans over committed added/deleted/renamed paths | Every path requires a reviewed rule or explicit exemption. |
| 05 | Actual-diff risk and digest-bound design approval; native risk tests | Material candidate, scope, design or policy changes invalidate approval. |
| 06 | Protected verification authority, acceptance bindings and artifacts | Candidate test success cannot replace protected acceptance authority. |
| 07 | Renewable SQLite leases and fencing tokens; two-connection/process tests | Single-host SQLite; no distributed exactly-once claim. |
| 08 | `native/required-ci.ts`, exact head/app/context/freshness checks | Unsupported ruleset-only requirements fail closed; no admin bypass. |
| 09 | Domain native lifecycle and immutable attempts | Legacy records remain recovery input, not current release authority. |
| 10 | Store CAS transactions containing state, audit and external intent | Unknown outcomes require observation; failed responses do not prove rejection. |
| 11 | `native/recovery.ts`, reviewed digest-bound recovery plans | Recovery requires pause and an independent operator; retry creates a fresh attempt. |
| 12 | Short board decision lease, rotating per-workflow leases and bounded slots | Workboard remains the queue; verification/release concurrency is bounded. |
| 13 | Shared process runner cancellation, deadlines, idle/output limits and descendant cleanup | Remote session abort acceptance is not proof of termination. |
| 14 | **Deferred:** automatic bounded rebase/reverification was not added to this checkpoint | Existing release gate blocks a stale base; operator recovery and fresh verification/review remain required. |
| 15 | Terminal lifecycle, scoped reservations and operator recovery | Uncertain release effects retain their scope until resolved. |
| 16 | `os-adapters/execution-owner.ts`, native/legacy entry guards and cutover | Trusted ownership database is outside candidate repositories; cooperative service boundary. |
| 17 | Versioned Gateway validators and doctor checks | Reviewed OpenClaw 2026.9.1 contract; no installed live SDK/Gateway certification in this workspace. |
| 18 | `native/provenance.ts`, protected attempt/code/policy/toolchain/artifact receipts | Legacy or mismatched receipts do not authorize release. |
| 19 | Schema migration, decoders, indexes, pagination, online backup and conservative retention | Automatic artifact deletion remains disabled without a complete ownership/reference catalog. |
| 20 | Native stage tracing with stable workflow/attempt identities | Trace failure cannot replay an external operation. |
| 21 | Immutable admission cohorts and verified/retained outcome reporting | Missing usage stays unknown; activity counts are not success. |
| 22 | CLI explanation and recovery inspection | Explanations include policy/evidence/freshness and bounded next actions. |
| 23 | `ui-components/native-evidence.tsx`, validated dashboard snapshot/RPC | Embeddable read-only view; live OpenClaw UI mounting and assistive-technology QA remain host integration work. |
| 24 | Local notification incident outbox, dedupe, quiet hours and acknowledgement | Delivery transport is not configured; no operator messages are sent by these tests. |
| 25 | Target claims, exact artifact identity, timed health observation and known-good rollback | Real deployment/provider service validation requires a disposable target. |
| 26 | Versioned native benchmark using real Git/SQLite and controlled execution boundaries | Controlled fixture, not measured model efficacy or a completed live deployment. |
| 27 | Adversarial repository content, cross-role broker and protected-check tests | These fixtures do not establish hostile multi-tenant isolation. |
| 28 | Seeded pause/lost-response replay, separate-process leases and crash recovery tests | Reconciliation preserves uncertainty instead of asserting exactly-once delivery. |
| 29 | CI Node matrix, explicit Node test family and compiled native smoke | Linux kernel isolation and supported runtime lanes must pass in CI. |
| 30 | Pinned actions, least-privilege CI, frozen lockfile, license/audit checks and exact-source witness | Release requires a clean exact revision and successful verification; outages fail visibly. |
| 31 | Native memory bridge with protected provenance, retention, human promotion and invalidation | Derived lessons cannot grant authority; absent retained evidence yields no promoted lesson. |
| 32 | Existing evidence-based selector plus reviewed exploration capacity | Scores express reviewed preferences; they are not fabricated performance measurements. |
| 33 | Bounded problem/workflow/scope/evidence and resolution-aware dedupe | New evidence/reversals can reopen; exact operator overrides expire. |
| 34 | Revision-bound ranged reads and bounded context packs | Literal static links and filename heuristics are labelled; no complete semantic impact guarantee. |
| 35 | Protected measured capability requirements for fixed native roles | Unknown capabilities/fallbacks fail closed. Dynamic model escalation remains disabled. |
| 36 | Atomic project/day/workflow/attempt reservations and actual/unknown settlement | Missing usage is held conservatively; no fabricated provider cost or cooldown bypass. |
| 37 | Immutable skill snapshots and independently reviewed evaluation/promotion/rollback | Controlled comparisons cannot certify live skill efficacy. |
| 38 | Existing module/profile extraction and boundary checks retained | Legacy runtime remains available under explicit ownership; no wholesale rewrite. |
| 39 | Private source export policy, portable doctor diagnostics and clean repository handoff | Source export exclusion alone does not sanitize old Git history; cleanup is coordinated separately. |
| 40 | Enforced observe/propose/human-review/staging/application modes and scoped canary evidence | Supplied defaults remain paused/observe; production requires live retained evidence and operator sign-off. |

## Operator actions and remaining environment evidence

Keep native execution paused while migrating policy, ownership and evidence. Register independent verification authority, exact CI requirements, skill snapshots and measured capabilities through authenticated operator code. Configure explicit conservative budgets and deployment target/known-good identity before any staged application canary. Observe retained outcomes for the reviewed window before considering scope promotion. No production deployment, provider benchmark or unattended autonomy activation was performed as part of this implementation.

See `native-evidence-maintenance.md`, `native-capability-routing.md`, `native-evidence-view.md`, `native-pause-control.md` and the native canary runbook for operational boundaries. Retain private backups outside release exports. 
