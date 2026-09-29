---
name: durable-handoff
description: Prepare concise implementation and recovery handoffs that preserve user intent, evidence, and the next executable action across agent sessions.
---

# Preserve a handoff

Give the next worker enough information to act without replaying the conversation:

- Purpose: the user outcome, current task scope, and why the change matters.
- Identity: workflow, attempt, managed worktree, and candidate or source revision when available.
- Current facts: completed work and exact evidence, separated from plans and unverified claims.
- Remaining work: unmet acceptance criteria, failed checks, unresolved dependencies, and the next concrete action.
- Constraints: non-goals, ownership boundaries, remaining budget, and effects whose outcomes are still unknown.

On a repair, carry forward the specific delta from earlier attempts. Do not merely resend the original request. On interruption, retrieve the current Workboard task context and inspect the preserved workspace before resuming. A summary can locate evidence but cannot replace current receipts or prove that an external effect failed.

Keep corrected decisions as the current instruction while retaining relevant historical evidence. Never present an abandoned approach as the final outcome. A worker's completion report must map its results to acceptance criteria; the receiving coordinator validates those results before advancing the workflow.

Use existing task notes and native context storage. Do not create a second queue, silently restart owned work, or contact people as a side effect of writing a handoff.
