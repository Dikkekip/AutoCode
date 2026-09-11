# AutoCode framework map

AutoCode adds coding policy and evidence gates to OpenClaw's native Workboard, sessions, and Automations. Workboard owns task scheduling, claims, managed worktrees, and execution history. AutoCode records the evidence needed to admit work, verify a candidate, review it independently, and authorize a release.

## Native runtime

| Area | Source | Responsibility |
| --- | --- | --- |
| CLI | `apps/dispatcher-cli/src/native-autonomy.ts` | Prepare policy, inspect readiness and outcomes, pause/freeze, and plan recovery or migration. |
| Plugin | `plugins/autocode/`, `packages/core-runtime/src/native/plugin.ts` | Register authenticated tools and connect configured projects to OpenClaw. |
| Workflow | `packages/core-runtime/src/native/runtime.ts`, `quality.ts` | Investigation, admission, implementation, review, and reconciliation. |
| Authority | `control.ts`, `broker.ts`, `capabilities.ts`, `promotion-mode.ts` | Control revisions, trusted caller identity, measured role eligibility, and operating modes. |
| Verification | `verification.ts`, `required-ci.ts`, `provenance.ts` | Protected checks, committed change coverage, exact-revision CI, and evidence receipts. |
| Release | `release.ts`, `deployment.ts`, `deployment-health.ts` | Reviewed release effects, deployment identity, health observation, and rollback evidence. |
| Recovery | `store.ts`, `recovery.ts`, `budget-ledger.ts` | Durable transactions, leases, bounded budgets, and explicit recovery from uncertain operations. |
| Outcomes | `outcomes.ts`, `telemetry.ts`, `memory.ts`, `skills.ts` | Outcome evidence, stage traces, governed memory, and reviewed skill versions. |

Paths in the last six rows are relative to `packages/core-runtime/src/native/`. [Native implementation status](native-implementation-status.md) records the supported boundaries and deferred work. [The native reference](native-autonomy.md) documents operator contracts.

## Shared packages

- `packages/domain`: validated policy, lifecycle types, routing contracts, and shared rules.
- `packages/project-profiles`: application profiles and validated execution policy.
- `packages/os-adapters`: filesystem/process operations, isolated workspaces, and execution ownership.
- `packages/db`: dispatcher storage, schema, and backup retention for compatibility and migration.
- `packages/executor`, `packages/team-router`, `packages/orchestra-codex`: dispatcher execution, planning, ownership, and handoffs retained for supported compatibility paths.
- `packages/adapters`, `packages/acpx`: agent transport and adapter contracts, including explicitly selected compatibility transports.
- `packages/audit-runtime`, `packages/telemetry`, `packages/memory-runtime`, `packages/evaluation`: reusable audit, telemetry, memory, and evaluation support.
- `packages/ui-components`: embeddable operator views and dashboard contracts.
- `packages/rag-processors`, `packages/source-citations`: reusable document-processing and citation components.

The package namespaces remain `@openclaw/*`; AutoCode is the repository and framework name. Renaming internal namespaces is not required to use the native runtime.

## Project boundaries

Application paths, commands, lane ownership, persona goals, and deployment behavior belong in `profiles/` or an installed project policy. The minimal profile is a generic starting point. The LawyerRAG profile is an explicit compatibility example, not an implicit framework default.

Execution policy covers JavaScript/Python verification, dependency preparation, diagnostic compatibility, and supported promotion import preferences. Installed profiles are fully validated before execution. Preserve application customizations when upgrading a profile; older incomplete profiles need their missing fields supplied before use.

`tests/fixtures/profile-repositories/split-services` exercises a different application layout so profile-based behavior is checked independently of the compatibility example.

## Bundled skills

Only framework-integrated or profile-referenced guidance is bundled:

- `native-coding`: the default native investigation bundle, including focused investigation, context retrieval, evidence-based repair, durable handoffs, contract changes, and harness experiments. All declared resources participate in its reviewed digest.
- `prompt-engineering-expert`: retained for existing policies that explicitly configure its single-file guidance.
- `openclaw-autonomy-framework`: templates consumed by the dispatcher installer.
- `error-recovery`, `reflect`, `tiered-memory`, `loop-budget`, `loop-triage`, `loop-verifier`, `minimal-fix`: installer-referenced guidance for existing dispatcher projects.
- `codex-account-switcher`: the explicit compatibility transport and cached quota inspection helper.
- `openclaw-workspace-bootstrap`: the profile-referenced workspace bootstrap template.

Operator credentials, runtime state, and personal notes do not belong in these assets. Native provider authentication is owned by OpenClaw.

See [upstream ideas](upstream-ideas.md) for the nine-repository analysis, applied patterns, source revisions, and controlled comparison.

## Validation

Use [verification lanes](verification-lanes.md) for the local pipeline, Linux isolation tests, and installed-contract checks. Keep fixture-based validation separate from claims about live model effectiveness or production deployment.
