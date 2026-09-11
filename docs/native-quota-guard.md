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
