# API regression verification coverage proposal

The live verification policy is unchanged. A separate protected command selects API-library tests from the host-written, exact-head changed-file manifest. It validates the manifest and path scope, deduplicates changed tests and existing source companions, rejects missing files and symlinks escaping the API snapshot, compares the candidate dependency lockfile with the pinned image, and executes the selected Vitest files without network access.

The command is additive to existing build, boundary and contract checks. It does not change the feature selector or permit a candidate to choose arbitrary verification commands. The proposed rule watches changed `apps/reports-ui/src/lib/api/**/*.test.ts` and `*.test.tsx` paths. Source-only API changes retain their standing verification plan and independent design review.

## Reviewable artifacts

- Source: `native-changed-api-tests.mjs`
- Image build: `Dockerfile.native-verifier-api-tests`
- Exact reviewed staged parent: `sha256:0f6fb6cf0f58391d47e6d8817f837e0ea39475b9533d3d65d2f2ddcefda0372b`
- New local image: `sha256:765665fc6608a6462e1baf1b562b30e051081611f84ca0df61314d86342e050f`
- Cumulative 49-rule proposal: `/tmp/native-continuity-deployment-20260929/lawyerrag-native-policy-api-test-proposal.json`
- Policy digest: `03cd184a16f926ee265f8064b72d585094714f0fbc97389afb0c7a5605eb5706`
- Selection proof: `/tmp/native-continuity-deployment-20260929/api-test-policy-selection-proof.json`

The candidate's two changed API paths select the three original standing checks (`legacy-016`, `legacy-017`, `legacy-018`) and the new `changed-api-tests` command, with no uncovered paths. Isolated containers selected committed `client.test.ts` from native candidate `ff48082898fe6b49f3cfe65bbf1bb57455df6782` (21 tests passed) and latest candidate `29de78b8e170c2a73dcb82592f1277daaaae43d7` (22 tests passed). Both executions used the pinned image with networking disabled. This resolves the independent reviewer's specific missing-selection concern in the proposed plan; it is diagnostic evidence, not acceptance of either candidate or approval of the policy. The three original standing checks were not rerun as part of these focused diagnostics.

The latest workflow is blocked after exhausting its three code repair attempts on the same missing test-selection rule. Preserve its authenticated submission, candidate and review receipts. Further code retries cannot repair the standing policy. Recovery must follow independent policy review, fresh eligibility and promotion approvals, activation, and the supported workflow recovery contract; the existing candidate requires fresh design review and commit-bound verification.

Eleven selector regression cases pass, including malformed manifests, traversal, command-like paths, absent selected tests, symlink escapes and replacement of the entire API root with a symlink. The root-replacement regression first demonstrated acceptance of a test outside the intended API directory; implementation commit `6c9e230` rejects it. All 55 Node tests and lint passed after that fix. The rebuilt image passed the latest candidate's 22 API tests again with networking disabled.

Full CI passed on parent commit `c5c3e2c`: 120 test files and 1,286 Vitest tests passed (one file and seven tests skipped), 54 Node tests, lint, typecheck, build and both runtime smoke checks. The later root check is covered by the 55-test Node run and lint; full CI was not repeated after that two-line executable change.

The image builds from the previously staged verifier proposal, which already includes feature coverage and the critical timing-oracle repair. Both that parent proposal and this addition require independent verification-authority review before activation. Fresh capability eligibility and policy-bound promotion approvals are still required. No accepted evidence or approvals have been copied, relabeled or registered for the new digest.
