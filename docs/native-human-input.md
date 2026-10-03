# Short human decisions before implementation

The native plugin can ask the configured private Telegram owner for product
direction while routine work continues without a reply. This is an upstream idea
gate, not approval of code, verification policy or deployment.

Configure `plugins.entries.autocode.config.humanInput` with one object per board:

```json
{
  "boardId": "my-application",
  "telegramTarget": "123456789",
  "ownerIds": ["123456789"],
  "accountId": "default",
  "telegramDelivery": false,
  "maxRoutineHours": 8,
  "maxRoutineCostCents": 5000
}
```

Proactive delivery defaults to disabled. Set `telegramDelivery: true` only after
the operator authorizes that destination and the brief content. Commands and the
high-impact hold still work with delivery disabled.

Use a paired private Telegram account. Group chats, another account, unpaired
senders and agent-supplied tool identities cannot approve an idea. The destination
must be an explicit configured owner; the integration does not contact colleagues
or forward retrieved documents.

The planner still ranks evidence-backed proposals and checks reservations. A
selected idea needs direction when its persona marks high risk, it touches a
protected or broad scope, its estimated effort or cost exceeds the configured
limit, or its implementation contract is incomplete. Routine file-scoped proposals
proceed without waiting. Estimates are not provider-spend measurements.

A pending decision sends one short brief with benefit, estimated effort/cost and
the reason for asking. Reply `/idea approve ID` or `/idea skip ID`; `/ideas` lists
current pending decisions. Silence leaves high-impact work pending and never
counts as approval. Approved direction creates an authenticated planner task;
normal evidence, scope, deduplication and budget checks run again. Existing
technical rejections and review findings are not overridden. Changing a proposal,
policy or decision configuration invalidates its old approval.

Only two unsent pending briefs are attempted each minute. Unknown delivery
outcomes are retained without automatic re-sending; `/ideas` remains available.
There is no repeated reminder loop. Decisions and delivery state live in the
native evidence store, written by the owning runtime rather than direct SQL.

This feature does not itself enable production releases. `application-release`
still requires a complete deployment adapter, real staging observation, immutable
release provenance, named CI and the operator-authorized promotion policy. A
Telegram idea approval must never be represented as those technical receipts.
