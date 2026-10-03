# Timeline shortcut verifier coverage addendum

This extends the staged 2026-09-28 verifier proposal. The LawyerRAG live
native policy remains unchanged.

- Workflow: `677da28ab99617978de2a764662d31ebf52491cc50c02daab6f1e91eb7d74f73`
- Exact attempt 3 candidate: `b2cc0138564d071a6a1b0b0018bd29c954464642`
- Base: `3b806029f6a80014bd5d4502b19a75c372ca0763`
- Staged policy: `/tmp/lawyerrag-native-verifier-coverage-timeline-20260928.json`
- Reviewed shell coverage image: `sha256:909490f7dac9eff6628d6fb600ac512f62bb1cc25e7edba17b22f4f88e286e93`
- New local image: `sha256:315b87f18f544711b35be36303ed713768362fb6c48e97bcfd01cb8a6388ae86`
- Candidate policy digest: `683649454ab3df67b63fbcc180a74eb809fbcd0c0401591db9e528b1900933e9`
- Draft capability review: `/home/dikkekip/LawyerRAG/.openclaw/operator-artifacts/verifier-coverage-20260928/capability-timeline-draft/plan.json`

The proposal adds the path-selected `timeline-shortcut-ownership` rule,
making 45 rules in total. The protected command requires both
`useTimelineNavigation.test.tsx` and
`TimelineView.filters.contract.test.tsx`, then runs them with Vitest. No
global sandbox inputs were added; the production candidate snapshot admits
changed committed files.

The exact attempt 3 candidate passed 28/28 tests through the production
snapshot path in `/tmp/native-timeline-coverage-production-path-20260928.json`.
Removing the mounted consumer test from that snapshot returned exit code 1
in `/tmp/native-timeline-coverage-missing-test-20260928.json`. The staged
policy doctor passes every check except `measured-role-capabilities`; its
separate, unregistered 22-role draft validates all roles.

This diagnostic does not accept the candidate. Independent design review
requested stronger focus ownership and actual filtering assertions, as well
as standing selection of both changed suites. Attempt 4 ended without an
authenticated candidate. Preserve both attempts and retry only through the
exact operator recovery process after the design and policy gates are ready.
Activation requires independent review of this expanded policy and the
capability draft bound to its digest.
