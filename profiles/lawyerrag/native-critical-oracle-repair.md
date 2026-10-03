# Bundle critical test oracle repair proposal

The live verifier image and verification authority are unchanged. This patch prepares a new image for independent review; it does not permit a failed candidate to skip a check.

The exact candidate `db9553c5ccf0515b30213209f12fd6e9a596d6be` passed `legacy-006`, `legacy-007`, and `legacy-008`. Its live `legacy-009` check failed one of 510 critical tests: `BundleDetail` expected the chronology source-return cue immediately after asynchronous focus and tab restoration. The candidate changed only `BundleList.tsx` and its test. In the same current verifier image, the failing `BundleDetail` test passed when run alone. This supports a timing interaction in the broad suite; it does not prove the application behavior always succeeds.

The pinned critical oracle overwrites `BundleDetail.test.tsx` inside the isolated verifier snapshot. Editing only the application repository's test cannot change this check: the fixture installer rejects unreviewed test content and replaces allowed inputs with its pinned oracle. `native-critical-oracle-repair.py` therefore verifies exact old hashes, changes only the oracle's immediate cue assertion to `await waitFor(...)`, updates the installer's oracle hash and Git blob pin, and accepts the matching application test source hash for a future source update. The installer keeps its reviewed fixture integrity checks. An unexpected base image or fixture fails the image build.

Local no-network diagnostic evidence on the exact candidate:

- Current live verifier image `sha256:322160d84121c50584a821e6546958dc7a0ffdfe01d8ef0d7cc995ebfc7b82ba`: `legacy-009` failed one critical test; 509 passed.
- Staged verifier image plus the proposed oracle and installer, `sha256:4dd2a64f900988bc065c1604161c8a2b844ef9bf1a786f2827a7299f296b8ef0`: the same rule passed 510 critical tests and 54 feature tests.
- Source-controlled patch script image `sha256:0f6fb6cf0f58391d47e6d8817f837e0ea39475b9533d3d65d2f2ddcefda0372b`: the exact same rule on the exact candidate also passed 510 critical tests and 54 feature tests. The patched oracle and installer SHA-256 hashes are `3d7ff3a596c6a787cc2a6b23ba616787ff58e4d5fd46a00e1e49a3d1418e70dc` and `961d40f80319ec68804b5df149e1416e970fbf56c2592d62fab6391727df5e0c`.

The diagnostic does not approve verification policy, candidate code, final acceptance, or release. Before activation, an independent reviewer must inspect the old and new oracle content, the image build and immutable digest, the accepted source hashes, and the proposed policy/capability revision. Preserve the original failed receipt and require fresh commit-bound verification under the approved policy.

The local combined-policy draft is `/tmp/native-continuity-deployment-20260929/lawyerrag-native-policy-critical-oracle-proposal.json`. Its digest is `7c68099e445e397904985f69171029f5343fd3ef34e56d0d15cb65d44be64bb2`; all 48 rules and every other policy field match the previous changed-feature proposal, with only `verificationSandbox.image` set to the source-built oracle image `sha256:0f6fb6cf0f58391d47e6d8817f837e0ea39475b9533d3d65d2f2ddcefda0372b`. The authority `reviewedRevision` is unchanged and does not approve this new digest.
