# Unresolved native card-intent custody

This administration route records `unresolved-held-no-replay` custody. It does not confirm external success or prove historical nonexecution. Original pending record bytes, input and version remain unchanged; an immutable sidecar and attributed native audit event carry the hold.

`autocode.effects.hold.plan` requires a paused runtime, exact unique intent IDs, bounded reason, no active native operation lease or uncertain operation, and no unselected pending effect. The server reads the original preparation event, its own local Gateway configuration and process boundary, and a bounded journal window. A unique observed local authorization rejection from a now-ended Gateway process supports the hold. Full original wire correlation is unavailable and that uncertainty remains explicit.

Each intent must belong either to a missing workflow **and** admission, or to an exact blocked local-rejection owner with matching preserved attempt archive. Complete Workboard inventory includes archived cards and all known raw, normalized and manual-prefixed correlation aliases. Unknown, incomplete or ambiguous observations refuse the plan. Canonical complete session/quiescence checks run before publication.

`autocode.effects.hold.apply` requires a verified administrator identity and the exact reviewed plan. It uses the same exclusive native-call barrier as policy refresh, rechecks source versions, ownership, local observations and remote absence, then commits sidecars and audit atomically. There is no new guest tool or grant.

Every native card-create path rejects a held key before preparation or replay. Native dispatch, policy refresh and recovery require unchanged custody and current absence; any later matching card, including archived/manual-prefixed cards, stops those native paths. Only safe cancellation or archival may follow for a blocked owner; retries do not consume a hold as effect success. A subsequent exact audited native cancellation preserves the hold and all old evidence.

This guarantee applies to native autonomous replay and dispatch. A deliberate future human administrator creating or starting work directly through Workboard is a separate authority. Observing such a matching card invalidates the absence proof and blocks native processing; this API does not silently broaden Workboard grants or claim to revoke independent human authority.

Policy mode, model roles, tool policy, source registration, verification rules, budgets, measurements and release gates are unchanged. In particular a custody hold never renews capability evidence or authorizes application release.
