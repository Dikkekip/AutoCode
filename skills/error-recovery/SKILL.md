---
name: error-recovery
description: Use a consistent recovery pattern when agent work fails because of timeouts, rate limits, tool errors, invalid output, verification failures, or unclear blockers.
---

Use this when work fails or degrades. Pick one pattern, explain the choice briefly, and continue with bounded action.

## Patterns

| Pattern | Use When | Action |
| --- | --- | --- |
| retry | Transient timeout, lock, flaky network, or temporary rate limit | Retry the same approach with backoff, at most 3 attempts |
| fallback | The primary tool, model, path, or strategy repeatedly fails | Switch to a viable alternative and record the tradeoff |
| diagnose | The failure cause is unclear | Gather narrow evidence before changing code or retrying |
| escalate | The task is blocked by missing access, destructive risk, or impossible constraints | Surface the blocker and stop the risky action |
| degrade | Full success is unavailable but useful partial output is possible | Deliver the partial result with exact caveats |

## Selection

- Rate limit or timeout: retry once, then fallback if another route exists.
- Verification failure: diagnose first; retry only after a concrete fix.
- Invalid model/tool output: fallback to stricter validation or a simpler prompt.
- Missing credentials, external side effects, or destructive ambiguity: escalate.
- Optional enhancement blocked by environment: degrade and document what remains.

## Guardrails

- Do not silently loop. After the third failure in the same category, escalate.
- Do not hide partial failure behind a successful status.
- Write durable lessons to memory or docs when the failure changes future behavior.
