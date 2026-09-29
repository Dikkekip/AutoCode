# API regression verification coverage proposal

The live verification policy is unchanged. A separate protected command selects API-library tests from the host-written, exact-head changed-file manifest. It validates the manifest and path scope, deduplicates changed tests and existing source companions, rejects missing files and symlinks escaping the API snapshot, compares the candidate dependency lockfile with the pinned image, and executes the selected Vitest files without network access.

The command is additive to existing build, boundary and contract checks. It does not change the feature selector or permit a candidate to choose arbitrary verification commands. The proposed rule watches changed `apps/reports-ui/src/lib/api/**/*.test.ts` and `*.test.tsx` paths. Source-only API changes retain their standing verification plan and independent design review.

## Reviewable artifacts

- Source: `native-changed-api-tests.mjs`
- Image build: `Dockerfile.native-verifier-api-tests`
- Exact reviewed staged parent: `sha256:0f6fb6cf0f58391d47e6d8817f837e0ea39475b9533d3d65d2f2ddcefda0372b`
- New local image: `sha256:4cf759021cfd9022decfc44a322ef69e2c3e7553681f3902243b4480b480935a`
- Cumulative 49-rule proposal: `/tmp/native-continuity-deployment-20260929/lawyerrag-native-policy-api-test-proposal.json`
- Policy digest: `3e2049ffbd8d21821b980700c2a6635085768ead907abc6a96955e89a013ca83`
- Selection proof: `/tmp/native-continuity-deployment-20260929/api-test-policy-selection-proof.json`

The candidate's two changed API paths select the three original standing checks (`legacy-016`, `legacy-017`, `legacy-018`) and the new `changed-api-tests` command, with no uncovered paths. An isolated container selected committed `client.test.ts` from native candidate `ff48082898fe6b49f3cfe65bbf1bb57455df6782` and passed all 21 tests. This resolves the independent reviewer's specific missing-selection concern in the proposed plan; it is diagnostic evidence, not acceptance of the candidate or approval of the policy.

Ten selector regression cases pass, including malformed manifests, traversal, command-like paths, absent selected tests and symlink escapes. All 54 Node tests, type checking and lint passed after adding the selector to the standard Node test command.

The image builds from the previously staged verifier proposal, which already includes feature coverage and the critical timing-oracle repair. Both that parent proposal and this addition require independent verification-authority review before activation. Fresh capability eligibility and policy-bound promotion approvals are still required. No accepted evidence or approvals have been copied, relabeled or registered for the new digest.
