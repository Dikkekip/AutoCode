# Native model reactivation and monitoring

Use the installed plugin's framework checkout for `dispatcher native`. An old
legacy wrapper can load a different policy validator. Confirm `plugins.load.paths`
and the existing automation command paths before changing policies or starting
legacy timers. Native Workboard and the legacy dispatcher must not both own a project.

For OpenClaw 2026.9.2, adding GPT-6 Sol requires all three configuration surfaces:

1. Add `openai/gpt-6-sol` to `agents.defaults.modelPolicy.allow` without removing
   existing entries. Do the same for `openai/gpt-5.6-terra` when enabling Terra.
2. Set each model's `agents.defaults.models` entry to
   `{"agentRuntime":{"id":"codex"}}`, and assign the intended agent roles.
3. This installed provider predates Sol subscription routing. Add a model-specific
   row to `models.providers.openai.models`, preserving any existing rows:

```json
{
  "id": "gpt-6-sol",
  "name": "GPT-6 Sol",
  "api": "openai-chatgpt-responses",
  "agentRuntime": {"id": "codex"},
  "reasoning": true,
  "input": ["text", "image"],
  "contextWindow": 1050000,
  "contextTokens": 272000,
  "maxTokens": 128000,
  "thinkingLevelMap": {
    "low": "low", "medium": "medium", "high": "high",
    "xhigh": "xhigh", "max": "max"
  }
}
```

Use `openclaw config patch --file ... --dry-run --json`, then apply the validated
patch. No credential replacement or generated package edits are required. Confirm
the gateway's hot reload and run isolated, non-delivering canaries. Check the
terminal receipt's requested and effective model: a fallback response does not
verify the requested model. The official Terra identifier is `gpt-5.6-terra`.

Model references: [GPT-6 Sol](https://developers.openai.com/api/docs/models/gpt-6-sol)
and [GPT-5.6 Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra).
Reassess this compatibility override after upgrading OpenClaw.

On 2026-09-26, the transport and reasoning configuration reached the provider,
but all three existing account canaries returned HTTP 400: Sol was not supported
with those ChatGPT accounts. Terra returned a successful exact-model receipt.
Sol remained registered, while the coding pool used Terra with Astra fallback
until a fresh Sol canary could succeed. Catalog presence alone must not activate
a model. The subsequently requested GPT-6 pairing is Sol and Luna:
`gpt-6-sol` and `gpt-6-luna`.

## After upgrading OpenClaw

OpenClaw 2026.9.6 includes native GPT-6 Sol and Luna routing. Remove a
compatibility-only Sol provider override after validating a scoped configuration
patch; preserve any unrelated provider settings. Register both model IDs in the
allowlist and bind them to the Codex runtime. Test each through an isolated,
non-delivering turn before assigning coding roles, and inspect requested and
effective model IDs to exclude fallback success.

An installed package version does not establish upgrade completion. If the CLI
requires session identity migration, stop the Gateway and use the supported
`openclaw doctor --fix --non-interactive` flow. Keep native dispatch paused while
maintenance runs. Avoid overlapping Doctor, update repair, Gateway startup, and
scheduled account reloads. Restore temporarily held timers after maintenance.
A migration lease failure must be investigated; do not edit SQLite records or
mark a plugin migration complete manually.

After an upgrade, inspect every owned cron command's executable path. A removed
user-installed Node path can leave jobs enabled but failing with `ENOENT`. Repair
the command through the supported cron API, preserving IDs and scheduling, then
inspect both terminal cron status and its diagnostic result. A successful command
that reports `reconciliation already running` has not created new investigations.
Run discovery sequentially when necessary so interrupted rounds can close through
normal reconciliation with their evidence retained.

Account synchronization must compare persisted credential content independent of
JSON field ordering and omitted optional values. Preserve newer gateway refreshes
and reload the gateway credential snapshot only after a real credential or account
order change. Journal pending reload before SDK writes and clear it only after a
successful reload, so partial writes and reload failures remain recoverable. An
unconditional five-minute reload can repeatedly invalidate model preparation with
`prepared model runtime publication was superseded`. Record the accepted run ID
and reconcile or abort that run through the public session API before retrying.

### OpenClaw 2026.9.6 catalog initialization workaround

A model can work through the Codex CLI while gateway turns never enter inference.
On the observed multi-agent installation, both the old Terra control and new GPT-6
turns stalled; auth diagnostics showed usable profiles. Gateway `status` reported
active and pending model-catalog work, and a plugin reload exposed
`plugin service startup timed out ... (codex/codex-session-catalog)`.

The installed Codex plugin supports these independent optional catalog settings:

```json
{"plugins":{"entries":{"codex":{"config":{
  "discovery":{"enabled":false},
  "sessionCatalog":{"enabled":false}
}}}}}
```

This isolates dynamic model enumeration and browsing external native Codex
sessions. It keeps the Codex execution harness registered and uses the explicitly
configured models. The external-session catalog is unavailable until re-enabled;
this is an operational workaround, not an upstream performance fix. Preserve a
private config backup, pause new work and reconcile accepted runs, validate a
scoped `config patch --dry-run --json`, then apply without `--json`. Wait for the
explicit successful hot-reload event before any canary. A failed hot reload is not
an applied runtime change. Verify requested/effective model identity and no fallback
in terminal receipts before changing role assignments. The observed Sol canary
completed through the Codex harness in about eight seconds after isolation.

This workaround did not establish reliable cold-start inference: subsequent Sol
and Luna gateway tests stalled, including an old-model control. Direct Codex CLI
tests succeeded for both models, and the plugin's bundled binary also ran Luna.
A five-second catalog-worker CPU profile showed substantial plugin source capture,
file hashing, and garbage collection. Captures included roughly 340 MB of bundled
Codex executables. This is measured preparation overhead, not proof of the turn
admission root cause: static turn admission and background catalog discovery are
separate paths. Preserve the profile and correlate accepted run IDs with trajectory
events and terminal outcomes before changing runtime guards or retrying work.

Built-in timeline tracing narrowed the observed Codex stall to `agent.startup`
stage `model-selection`; session preparation completed in about 109 ms. Native
runtimes always request thinking-catalog hydration, and the published owner's
native lookup can queue behind a pending catalog acquisition. An explicitly
configured `openclaw` runtime avoided that path: the Luna gateway canary completed
in 7.6 seconds, with requested/effective/response model `gpt-6-luna`, no fallback,
and `agentHarnessId: openclaw`. Its model-selection stage took about 10 ms.
This is an alternative execution runtime, not a repair to Codex catalog loading.
Validate sandbox tools and framework tool access as well as exact-model text
receipts before using it for coding. Keep a private configuration backup and
preserve account order, tool permissions, verification gates, and human review.

```json
{"agents":{"defaults":{"models":{
  "openai/gpt-6-luna":{"agentRuntime":{"id":"openclaw"}}
}}}}
```

The same built-in runtime subsequently passed Sol and Astra gateway canaries with
exact response-model identity and no fallback. Sol executed `pwd` through the
sandbox tool bridge and returned `/workspace`. The active role split uses Sol for
`coder` and `coder-3`, Luna for `coder-2`, and keeps Astra for planning/review and
most research roles. Each selected model has an explicit `openclaw` runtime.

After the doctor checks passed, native execution and the three schedules were
resumed with `implement-human-review` unchanged. A fresh Workboard research
session completed successfully with 45 tool calls, including authenticated
context, source inspection, proposal registration, investigation completion, and
Workboard completion. The controller started the next researcher automatically.
This proves research/tool handoff through the framework; it does not yet prove a
new implementation, passed verification, or release. Keep observing the planner
and coding handoffs and retain previous blocked attempts and review gates.

For targeted timings, use the supported `diagnostics.flags: ["timeline"]` and
`OPENCLAW_DIAGNOSTICS_TIMELINE_PATH` in a private operator directory. Inspect
unfinished spans and distinguish CLI processes from the gateway PID. Restore
the prior flags after diagnosis. Do not use debugger-evaluated dynamic imports
to clean up an inspector session: an uncaught VM import error can terminate the
gateway. The observed diagnostic cleanup failure was recovered by systemd while
native execution was paused; it was not an inference or provider failure.

## Monitoring

`scripts/native-health-monitor.py` reads native status, board cards, and schedules
through the gateway and atomically writes a private JSON report. It performs no
retries, restarts, queue mutations, or external message delivery. Schedule it using
an independent user timer so a stopped native scheduler remains observable.

```sh
python3 scripts/native-health-monitor.test.py
python3 scripts/native-health-monitor.py --openclaw /absolute/path/to/openclaw \
  --board my-project --output /private/operator-artifacts/native-health.json
```

Reports flag missing, disabled, failed, or unobserved schedules and ready cards
or todo cards waiting over 15 minutes without a running worker. This includes a
planner held behind interrupted research. Existing workflow blockers are
retained for inspection. `observed` means the snapshot checks passed; it does not
prove worker process liveness, successful implementation, or deployment. An RPC
failure replaces the snapshot with `unknown`, never a stale healthy report.
Long-running jobs are not restarted because of an old error or timestamp.
Reports also flag explicitly degraded or pending gateway model preparation and
include the model-catalog worker's task counts. The optional `modelRuntime` startup
projection can be absent after configuration publication; record
`modelRuntimeReported: false` as an evidence gap without inventing a runtime
failure. Neither `status` nor `health` guarantees this projection is present. Active catalog tasks alone do not
establish a stalled turn; a ready gateway likewise does not prove inference ran.

Hourly worktree maintenance must use audit mode. Its documented `--apply` contract
requires a short operator maintenance window and excludes unattended deletion.
Do not add a permanent window receipt to a timer.
