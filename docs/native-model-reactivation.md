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
Sol remains registered, but the coding pool uses Terra with Astra fallback until
a fresh Sol canary succeeds. Catalog presence alone must not activate a model.

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
waiting over 15 minutes without a running worker. Existing workflow blockers are
retained for inspection. `observed` means the snapshot checks passed; it does not
prove worker process liveness, successful implementation, or deployment. An RPC
failure replaces the snapshot with `unknown`, never a stale healthy report.
Long-running jobs are not restarted because of an old error or timestamp.

Hourly worktree maintenance must use audit mode. Its documented `--apply` contract
requires a short operator maintenance window and excludes unattended deletion.
Do not add a permanent window receipt to a timer.
