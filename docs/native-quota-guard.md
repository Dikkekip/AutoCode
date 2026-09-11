# Native quota reset guard

`scripts/native-quota-reset.mjs` is an optional operator command for one explicitly authorized banked Codex reset. It reads the locally authenticated Codex account through app-server. It does not change native policy, pause or resume boards, send notifications, switch accounts, or buy credits.

Create an operator-owned configuration outside the repository, with mode 0600:

```json
{
  "email": "operator@example.test",
  "accountId": "backend-account-id",
  "creditId": "explicitly-approved-credit-id",
  "statePath": "/var/lib/operator/native-quota-state.json",
  "codexPath": "/opt/codex/bin/codex",
  "allowReset": true
}
```

Run `node scripts/native-quota-reset.mjs --config /absolute/path/config.json`. Linux `flock` serializes commands sharing a state path, including retries after process failure; a competing invocation exits 75. The state directory must be private to the operator. Preserve the state file and its configuration across scheduled runs. Do not delete state or change the credit binding to rearm an existing authorization. Keep one authoritative state path per approved credit.

The guard requires matching email and backend account ID, explicit backend denial of ordinary included usage, exhausted Codex quota, a known false spend-control flag, and the exact available unexpired credit before starting a reset. Backend permission unavailable, account mismatch, unknown limits, and spend-control restrictions prevent consumption. A durable atomic mode-0600 state write records a stable idempotency key before the consume RPC. Transport uncertainty leaves that attempt pending: later calls replay the same key even if the first call consumed the only credit. Unknown backend permission still blocks replay.

A read after the reset must explicitly allow ordinary usage before the guard reports `continue`. Only `reset` or `alreadyRedeemed` proves redemption. Definitive `nothingToReset` and `noCredit` outcomes remain recorded and require operator review on later denial; they never report a successful reset or allocate another key. An exhausted window after a proven redemption reports `exhausted`. Native Automation operators may use that structured outcome to pause their board with its supported control API, taking care not to resume an unrelated operator pause.

Output is one JSON result with `action` (`continue`, `blocked`, or `exhausted`) and sanitized usage details when available. Transport/configuration failures produce `action: error` on stderr and exit 1. No passwords or tokens are persisted. Malformed state fails closed; an absent file initializes the first authorized attempt; process interruption before a successful first state write has no remote side effect. Run `node --test scripts/native-quota-reset.test.mjs` for the isolated reset-state tests.

## Optional native board monitor

`scripts/native-quota-monitor.mjs` runs the guard and saves a private, atomic status snapshot. It calls the supported `autocode.pause` API only when the guard reports `exhausted` after a proven `reset` or `alreadyRedeemed` outcome. It never resumes a board, retries an uncertain reset independently, or changes scheduling. A previously recorded pause remains intact. An unconfirmed pause fails without replacing the previous snapshot.

Keep a separate operator-owned monitor configuration outside Git, with mode 0600:

```json
{
  "guardConfigPath": "/var/lib/operator/quota-guard.json",
  "snapshotPath": "/var/lib/operator/quota-status.json",
  "openclawPath": "/opt/openclaw/bin/openclaw",
  "boardId": "example-board"
}
```

Run `node scripts/native-quota-monitor.mjs --config /absolute/path/monitor.json`. Schedule a single monitor invocation at a time; the reset guard serializes redemption, but the wrapper does not serialize board control or snapshot updates. Keep the snapshot in a private operator directory and preserve it across runs. Do not commit either configuration, account bindings, reset identifiers, or status snapshots. Publishing this wrapper does not replace an already deployed operator script. Validate with `node --test scripts/native-quota-monitor.test.mjs scripts/native-quota-reset.test.mjs`.
