# Sustained native execution

`scripts/native-continuous-loop.mjs` provides a recurring pipeline tick outside
the Gateway cron runner. It uses public native RPCs and the existing native
execution owner. It does not add an offline dispatcher.

Preview with `--openclaw <cli> --board <board> --state <private-json>`. Add
`--apply` for an authorized live tick. The systemd examples run one tick at a
time and retry sixty seconds after completion, including after an RPC failure.
Configure the executable paths and board before installing them. During cutover,
disable the old discovery, dispatch and reconcile jobs to keep one scheduling
owner. Preserve the old job definitions for rollback.

Every tick checks explicit board control and native readiness. It preserves
pauses and freezes, waits for active native leases and requires Doctor plus the
skill binding before reconciliation. Native reconciliation advances dispatch,
verification, review and bounded repair. Persisted effect records are historical
or unresolved evidence, not active leases; their presence must not starve other
work. The runtime retains authority over effect replay and custody.

Discovery runs only without ready or running cards, at most every thirty
minutes. Its timestamp is persisted before invocation to avoid immediate
duplication after a lost response. A failed reconciliation never triggers a
follow-on discovery call. Native admission still enforces budgets, reserved
scope, host capacity and role capability requirements.

This loop cannot fix a broken Gateway, enable a disabled Workboard plugin,
resume an operator pause or manufacture capability evidence. Restore those
through supported maintenance and configuration APIs. Doctor now identifies an
explicitly disabled, denied or absent-from-allowlist Workboard before making
calls to its unavailable handlers.

Verify the service's actual tick result and fresh Workboard card, run, session
and tool events. Follow candidates through commit-bound verification and
independent review before claiming completion. A healthy timer proves only that
another tick is scheduled.
