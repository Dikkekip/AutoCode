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
