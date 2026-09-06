---
name: openclaw-dispatch
description: Dispatch plain-language prompts into the OpenClaw autonomous loop, choose or confirm the lane, refresh the queue, run execution/review/promotion sweeps, and inspect or recover stalled runs. Use when the user asks to dispatch work, run the autonomous loop, queue a task, kick off Codex, resume the loop, or diagnose OpenClaw queue, lock, review, or promotion state.
---

# OpenClaw Dispatch

## Use this skill
- Turn a human prompt into one lane-scoped OpenClaw task.
- Keep the autonomous loop moving end to end.
- Prefer repo-owned commands and lineage over ad hoc manual edits.

## Dispatch flow
1. Identify the target lane and expected outcome.
2. If the lane is unclear, ask one clarifying question before dispatching.
3. Refresh the queue.
4. Run execution.
5. Run review.
6. Run promotion.
7. Report what moved, what is blocked, and what is next.

## Lane selection
- Use existing repo lanes, not generic buckets, when possible.
- Reuse the current task lineage if the queue already contains the work.
- Keep one active worker per lane.

## Commands
- `bash scripts/run_dispatcher_cycle.sh` for a full loop tick.
- `python3 scripts/openclaw_director.py health` for live state.
- `python3 scripts/openclaw_director.py queue-refresh`
- `python3 scripts/openclaw_director.py execution-sweep`
- `python3 scripts/openclaw_director.py review-sweep`
- `python3 scripts/openclaw_director.py promotion-sweep`

## When blocked
- Inspect `.openclaw/state/current/queue.json`, `locks.json`, and `.openclaw/logs/dispatcher-*.log`.
- Release stale runtime locks before creating fresh work.
- Do not edit product code in runtime/deploy checkouts.

## Output
- Say which lane is active.
- Say whether work is queued, in progress, awaiting review, or promotable.
- Say the next command only if the user wants the loop continued.
