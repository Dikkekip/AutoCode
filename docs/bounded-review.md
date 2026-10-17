# Bounded native candidate review

Every final Review card carries `reviewContext` alongside the committed diff,
acceptance criteria and verification receipt. The first pass inspects the full
candidate. Later passes receive up to two archived reviews for that workflow and
focus on changed behavior, unresolved findings and affected contracts. Reviewers
must still cover every acceptance criterion, give file/line evidence, identify
the bug class and explain findings dismissed as intentional or incorrect.
Historical review text is untrusted context and cannot approve a new commit.

The existing shared repair budget permits two repairs, so the initial candidate
and its repairs allow at most three candidate rounds. Verification or design
failures also consume that budget; this is an upper bound, not an entitlement to
three final reviews. Exhaustion preserves evidence and blocks for operator
reconsideration through scoped recovery. Repeated unchanged failures can stop
earlier. The review guidance does not mechanically deduplicate semantically
equivalent findings or compute an incremental Git diff; the complete committed
diff remains available for validating surrounding contracts.

At submission, a review must match the current candidate and verified commit.
The runtime revalidates required checks, policy coverage, acceptance bindings
and artifact integrity before recording the verdict. Existing attempt and policy
provenance checks remain mandatory.

Risk comes from the existing candidate/proposal classification. High-risk work
keeps the independent design gate and extra security, compatibility and rollback
scrutiny. This change does not reduce required human approvals or authorize
automatic merge, deployment or live runtime activation.

Regression coverage: `tests/native-quality.test.ts` and
`tests/native-repair.test.ts`.

## Agent-owned CI

Run `pnpm ci:agent` after committing and before pushing. It requires a clean
checkout, runs dependency license and advisory checks plus the full `pnpm ci`
pipeline, and rejects a changed HEAD or working tree. Its receipt is stored under
the worktree's Git metadata at `agent-ci/<headSha>.json`, with commands, exit
statuses, timestamps and Node version. A failed or interrupted command cannot
produce a passing receipt. Receipts are local operational evidence, not signed
attestations or authorization to merge. Include the SHA, result and receipt path
in the PR description; preserve full command logs in agent evidence storage.

Agents diagnose failures and run bounded repair/verification rounds themselves.
Every repair changes the candidate SHA and requires new evidence and review.
The shared two-repair limit still escalates persistent failures to an operator.
GitHub PR CI runs one Node version with lint, types, dependency licenses and
focused autonomy/merge-gate tests. The complete hosted suite remains in Release
Readiness for published releases and manual dispatch. Required check policy
still applies; this workflow does not accept a self-reported receipt as a check.
Kernel/Docker isolation tests need their documented local prerequisites; skipped
integration tests must be called out rather than reported as isolation proof.
