# Squad Ideas Imported Into OpenClaw

This note tracks Squad concepts that have been translated into OpenClaw-native surfaces. The goal is to borrow the useful operating patterns without copying Squad's product vocabulary or storage layout.

## Implemented

- Cooperative rate limiting: `packages/domain/src/rate-limits.ts` adds traffic-light quota states, priority-aware admission, jittered retry windows, and predictive circuit-opening helpers.
- Failure recovery skill: `skills/error-recovery/SKILL.md` gives agents a shared retry/fallback/diagnose/escalate/degrade decision pattern.
- Reflection skill: `skills/reflect/SKILL.md` captures in-session lessons after repeated mistakes or corrective feedback.
- Tiered memory skill: `skills/tiered-memory/SKILL.md` maps Squad's hot/cold/wiki context split onto OpenClaw's daily memory, long-term memory, and repo docs.
- DevClaw role tiers: `packages/domain/src/role-tiers.ts` adds deterministic worker role/tier selection and persistent session keys without importing DevClaw model IDs.
- Goose task recipes: `packages/domain/src/task-recipes.ts` adds composable task recipe rendering and subrecipe expansion for OpenClaw task packages.
- Paperclip workspace commands: `packages/domain/src/workspace-commands.ts` normalizes repo runtime `commands`, `services`, and `jobs` into stable command definitions.
- Goose diagnostics: `packages/domain/src/diagnostics.ts` defines privacy-aware diagnostics manifests for sessions, logs, config, and scoped runtime state.
- DevClaw review feedback: `packages/domain/src/review-feedback.ts` formats PR review and merge-conflict feedback into branch-safe worker instructions.
- Paperclip budget helpers: `packages/domain/src/budget.ts` adds budget pressure classification and OpenAI-compatible biller inference.
- Goose context hints: `packages/domain/src/context-hints.ts` parses hierarchical agent hint files and `@file` references into a deterministic prompt bundle.
- Paperclip routine variables: `packages/domain/src/automation-template.ts` now extracts and syncs automation template variables while excluding built-ins.
- Paperclip command redaction: `packages/domain/src/log-redaction.ts` now redacts command-line flags, env assignments, bearer headers, OpenAI keys, GitHub tokens, and JWTs before command text is logged.
- DevClaw workflow transitions: `packages/domain/src/workflow-transitions.ts` captures deterministic role/result transitions for development, review, test, and research loops.
- Squad state backend evolution: `packages/domain/src/state-backends.ts` normalizes OpenCLAW state backend choices, preserves compatibility aliases, derives runtime/bootstrap state paths, and plans detached-Git sync hooks without importing Squad storage layout.
- Squad dependency-aware fan-out: planner and task-factory graphs now validate stable dependency keys, persist prerequisite task ids, run independent slices in parallel, and hold downstream coding until prerequisite code is merged.
- Squad durable team routing: dispatcher-selected agents now pass through TeamRouter preflight, and the run-claim transaction persists routing evidence plus normalized artifact ownership. Overlapping assignments are deferred atomically and ownership is released on terminal or recovered runs; `dispatcher team assignments` and `dispatcher team claims` expose the state.
- Squad reviewer independence: rejected implementation authors receive task-scoped artifact lockouts, replacement agents receive durable mailbox handoffs, and successful independent revisions clear the lockout. Lockouts and inboxes survive dispatcher restarts and are inspectable from `dispatcher team`.

## Candidate Follow-Ups

- Persist shared rate-limit leases through the state backend planner so multiple dispatcher processes coordinate before hitting provider limits.
- Feed predictive circuit state into adapter health checks and route scoring.
- Add installer seeding for the new skills when bootstrapping target repos.
- Wire recipes into `.openclaw/recipes` loading so operators can attach reusable task packs from repo-owned files.
- Use worker role tiers as an optional adapter/model selection signal once model policy is profile-driven.
- Add a dispatcher `diagnostics` command that materializes the diagnostics manifest into a redacted zip bundle.
- Feed PR feedback formatting into promotion repair tasks so fix workers update the original branch by default.
- Load context hint bundles during task packaging so repo-owned `AGENTS.md`, `.goosehints`, or configured context files become first-class required reading.
- Use workflow transition rules to drive review/test/research task state instead of spreading transition logic across runtime code.
- Wire state backend plans into dispatcher install/upgrade commands so operators can opt into detached or two-layer state syncing from profile config.
- Add mailbox delivery hooks for external notification adapters while keeping SQLite as the acknowledgement source of truth.
