# Reconcile an externally changed deployment baseline

When production changes outside native AutoCode, the previous healthy target may no longer match the live revision. Native deployment continues to require independently confirmed baseline health. It does not infer a replacement baseline from a failed check.

An authenticated operator can use `autocode.deployment.baseline.plan` with `boardId`, `workflowId`, `revision`, `artifactSha256`, and a bounded `reason`. Retain and review the complete returned plan, then pass it unchanged as `plan` to `autocode.deployment.baseline.apply` with the same `boardId`. Apply requires `operator.admin` and an independent verified operator identity. Agent tools do not expose this operation.

The runtime must be explicitly paused, unfrozen, and drained. The selected workflow must already have an approved merge, an unchanged staged artifact, and no deploy or rollback operation. The previous target must be recorded as healthy and owned by another release. Fixed-artifact policies, uncertain effects, active sessions, active leases, and held targets require their existing recovery procedures.

The server binds the plan to the current runtime generation, policy, pause revision, workflow, previous target, and staged artifact versions. Apply runs only the deployment policy's configured health check against the supplied exact baseline identity. It requires fresh, settled, healthy results with a passing workflow, then repeats the public idle proof and local authority checks before committing.

One atomic commit retains the original target and staged record with the health artifact and operator identity in `deployment-baseline-adoption`, records the confirmed baseline under an explicit operator owner, and updates only the selected staged artifact's `previousKnownGood`. Candidate, verification, review, merge, and deployment history remain intact. Apply leaves execution paused and runs no prepare, deploy, or rollback command. Resuming the normal native loop retains all existing release checks.
