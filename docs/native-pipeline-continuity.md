# Keeping the native pipeline moving

A running scheduler does not prove that candidates can pass verification and
reach deployment. Inspect Workboard access, accepted worker executions,
candidate receipts, independent review and release operations separately.

The September 27 recovery found four framework defects:

- Source redaction treated keyboard equality comparisons as secret assignments,
  leaving reviewers with an incomplete patch. The source-only filter now
  preserves comparisons against known browser keyboard names; credential
  assignment, private-key and token filtering remain covered by regression tests.
- Design reviewers saw opaque executable names. Their context now includes the
  bounded text and digest of path-selected verifier scripts from the configured
  immutable image. Missing, binary or redacted definitions are explicitly
  incomplete. This is planning evidence; execution and acceptance remain later
  gates.
- Policy changes made successful verification receipts permanently stale.
  Before any release operation starts, the reconciler can archive intact receipts
  and regenerate verification and reviews for the same candidate. It preserves
  the implementation attempt and coding repair budget. Changed artifacts and
  accepted external release operations are not reset. Verification cards are
  keyed by attempt and policy; review cards by receipt.
- The isolated input allowlist omitted newly admitted test files. Verification
  now includes committed candidate additions and removes admitted deletions.
  Unchanged inputs still require the baseline allowlist. Credential paths,
  unapproved policy source and symlinks remain rejected.

The health monitor reports candidate, verified, merged and deployed counts. It
flags both an entirely blocked pipeline and workflows waiting for workers when
no work is runnable. Research activity cannot hide a fully blocked delivery
pipeline. It remains a read-only monitor; it does not reset tasks or restart
services.

For LawyerRAG, `profiles/lawyerrag/Dockerfile.native-verifier` overlays a reviewed
verifier image with dependencies from a reviewed dependency image and installs
`native-ui-component-tests.sh`. Resolve and record both local image references
before building, then configure the resulting immutable image ID. The additional
rule must select `apps/reports-ui/src/components/ui/**` and execute
`/opt/openclaw/checks/ui-components`. The script checks the dependency lockfile
before running all UI primitive tests, including newly added regression tests.
Keep all existing required checks.

Refresh a stale baseline input list and reviewed source blobs against the actual
current base; do not copy untracked files or silently accept changed protected
blobs. Candidate diagnostics are not native acceptance receipts. After the
operator applies the reviewed policy through its governance controls, recover
blocked work through an exact recovery plan and let fresh verification and
independent review run normally.

An explicit operator retry receives two fresh coding repair chances. Its immutable
attempt number keeps increasing, while its repair counter starts at zero. Repair
cards and archived evidence use the immutable attempt number, so a new budget
cannot reuse an old card or overwrite earlier evidence. Automatic reconciliation
does not reset an exhausted budget.

The native CLI allows three minutes for resume readiness and workspace config
updates, matching the existing doctor deadline. A timed-out caller does not prove
the server rejected a mutation; inspect live state before retrying it.

Operational recovery also required restarting a gateway whose own SQLite
lifecycle lock prevented Workboard access. The restart restored access; it does
not establish a permanent fix for the upstream lock lifecycle. Dispatch and
reconciliation schedules that auto-disabled during the outage require explicit
restoration after Workboard and policy readiness are verified.
