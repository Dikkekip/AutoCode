# OpenClaw Workboard early completion repair

On 2026-09-28, timeline workflow
`677da28ab99617978de2a764662d31ebf52491cc50c02daab6f1e91eb7d74f73`
attempt 4 started Workboard card `a6810c15-b771-41af-a5ae-357bb56b094b`.
Workboard marked its execution succeeded and moved the card to review about
10 seconds after launch. The Gateway session did not end until about 45 seconds
after launch. The coder's first `autocode_context` call arrived while the
session was active but after the card moved to review, so the trusted
assigned-card broker denied it. The coder made no changes and the workflow
blocked without a candidate.

Installed OpenClaw 2026.9.6 Workboard maps both `agent_end` and
`subagent_ended` to terminal card state. This host's Workboard workers are
subagents. The version-pinned local repair skips the `agent_end` terminal
transition for a `:subagent:workboard-` session. The separate
`subagent_ended` hook and the 60-second Gateway session sweep still reconcile
actual completion. It changes no worker tool grant or native policy.

The installed bundle before repair has SHA-256
`b7fcfa540fff10995a9da51ed172385e4446a5c61a62575c7408a93bff8e90d4`.
Run `node scripts/patch-openclaw-workboard-agent-end.mjs --check
<installed-openclaw-root>` to validate the exact version and source before
applying. The `--apply` mode writes a private backup beside the bundle and
atomically replaces it. The expected patched SHA-256 is
`0082df4fb26bbe7b76033632937bb5db39b0daa353c099ed070d40bb69909758`.
Apply only after accepted Workboard sessions finish, then restart the Gateway
and verify a new coding card can retrieve context while running. A package
update changes the bundle and must be reviewed separately; this script fails
closed on any unrecognized source.
