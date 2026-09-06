# Measured native role eligibility

New module: `packages/core-runtime/src/native/capabilities.ts`. Fixed operator-configured OpenClaw roles are checked against provider-neutral measurements of context capacity, structured output, tool support, cancellation, session resume and cost per verified outcome. Missing measurements remain unknown. Required unknown capabilities deny eligibility; requiring known cost denies unknown cost.

An authenticated service operator registers a protected, hashed benchmark artifact and approves requirements bound to the current policy digest. These service APIs are not agent tools. Evidence binds agent, model, dataset, benchmark, policy and expiry. Changes to the artifact, model or policy invalidate eligibility. Controlled fixtures exercise the contract but cannot certify a live model. Configured automatic fallback models without their own measured selection contract are rejected for release modes.

The doctor checks this evidence for staging-canary and application-release modes. The native runtime must recheck eligibility at activation boundaries; a prior readiness result must not authorize a changed model. The implementation retains fixed reviewed role assignments and does not manipulate OpenClaw provider accounts, cooldowns or tool grants. Dynamic model ranking and automatic escalation are not enabled by this contract. A cost observation alone cannot expand a model's authority.

Operators must obtain actual benchmark evidence for their configured models before enabling release modes. This implementation supplies no fabricated provider measurements and does not activate a live deployment.
