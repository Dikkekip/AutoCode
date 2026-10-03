# Deferring an unstarted operator request

An operator may discover that a queued brief needs replacement after validating a new defect. Use the native request deferral APIs while execution is paused and unfrozen:

1. Inspect the exact request through `autocode.requests.list`.
2. Call `autocode.requests.defer.plan` with `boardId`, `requestId`, and an attributed `reason`.
3. Review and preserve the returned plan. It binds the complete request snapshot, request revision, loaded policy, pause and freeze revisions, and runtime generation.
4. Call `autocode.requests.defer.apply` with that exact plan through an authenticated administrator connection. Inspect the returned deferred request, retained original request, and native audit before creating a replacement with a new idempotency key.

The plan is read only. Apply requires independent operator identity, current execution ownership, a queued request, and no associated round, investigation, inspection, proposal, effect intent, or workflow evidence. A changed plan, policy, pause revision, or request revision fails closed. Concurrent request updates roll back the archive and audit together.

Apply records the previous complete value in `operator-request-history`, moves the current request to `deferred`, and appends an attributed `operator-request.deferred` event. Existing native discovery excludes deferred requests. Execution remains paused. No external task is created and no application release or capability window is activated.

Keep the apply intent and response as operator evidence. If an RPC result is ambiguous, inspect the current request, history, and event before taking another action. Never automatically repeat the mutation. Started requests are rejected by this operation and retain their investigation and execution evidence.
