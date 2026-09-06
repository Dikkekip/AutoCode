# OpenClaw autonomous loop

## Loop order
1. `queue-refresh`
2. `execution-sweep`
3. `review-sweep`
4. `promotion-sweep`

Run them in that order when you want the repo to keep moving.

## What each step does
- `queue-refresh`, reconcile the live queue against bootstrap state, manager-seeded work, and recovery rules.
- `execution-sweep`, dispatch eligible queued work into Codex-backed runs.
- `review-sweep`, dispatch reviewer work for awaiting-review handoffs.
- `promotion-sweep`, publish ready PRs or report that nothing is promotable yet.

## State to inspect
- `.openclaw/state/current/queue.json`
- `.openclaw/state/current/locks.json`
- `.openclaw/state/current/runtime.json`
- `.openclaw/state/current/manager_state.json`
- `.openclaw/logs/dispatcher-sync.log`
- `.openclaw/logs/dispatcher-tick.log`

## Common failure modes
- Stale `running` lane, release the lock if the session is dead.
- Empty queue, refresh first and confirm the manager state still seeds tasks.
- Awaiting-review backlog, run review before trying more execution.
- Nothing promotable, that is normal, keep the loop cycling.

## Good reporting
Report only:
- active lane
- current state
- next step
- blocker, if any
