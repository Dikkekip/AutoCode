---
name: native-continuous-loop
description: Operate and diagnose the recurring native AutoCode coding, verification, review, and repair pipeline using live Workboard evidence. Use when native AutoCode stalls or needs sustained unattended execution.
---

# Native continuous loop

Resolve the framework root from its configured `plugins.load.paths` entry ending in `plugins/autocode`; the agent workspace may be elsewhere. Run `<framework-root>/scripts/native-continuous-loop.mjs --openclaw <cli> --board <board> --state <private-json>` to preview a tick; add `--apply` within authorized execution scope. The systemd examples serialize ticks and retry failed ticks after one minute. Use one scheduling owner per board; disable overlapping discovery/dispatch/reconcile schedules during cutover.

Each tick preserves operator pauses, waits for native operations, checks Doctor and the skill binding, then reconciles existing work. Reconciliation owns dispatch, verification, review and bounded repair. Idle capacity permits discovery at most every thirty minutes. It records discovery admission before calling the broker so a lost response does not immediately duplicate a round.

For a stall, inspect Gateway readiness, `autocode.status`, `autocode.doctor`, and the exact Workboard card/run/session. Missing handlers, unsupported runtime contracts, unavailable workspaces, host pressure and verification failures need distinct fixes. Preserve prior attempts and recovery artifacts. Never bypass a capability, independent review, CI or deployment gate to get a green status.

For each coding attempt, reproduce the observed failure, state a causal hypothesis, make a scoped correction and run the focused check. After a repeated failure, use the preserved repair history to choose a materially different approach; an unchanged retry is not progress. Exhausted recovery should block only that workflow so disjoint admitted work can continue.

Success requires fresh card/run/session/tool activity, then commit-bound verification and independent review. A timer, Gateway readiness, candidate or done card alone is insufficient. A timed-out mutation has unknown acceptance: inspect native state before retrying. The loop never resumes an operator pause or kills an active worker.
