# Hearing run sheet verifier coverage addendum

This addendum extends the staged 2026-09-28 verifier coverage proposal. It is
not active in the LawyerRAG native policy.

- Blocked workflow: `8b4de654e0489e10accdc35313b1a33e5a3dc7de8f68f5a53771ce712c79cd56`
- Exact candidate: `19967ed4c1ecbd0358d3eace251e59ffacf66d13`
- Base: `3b806029f6a80014bd5d4502b19a75c372ca0763`
- Staged policy: `/tmp/lawyerrag-native-verifier-coverage-hearing-20260928.json`
- Prior reviewed coverage image: `sha256:159dc23c0766d9a0ef15ae971d7909a9d4642623045d77ee3cee589d17b1bd83`
- New local image: `sha256:abb736ffaef0693ca9c43bf93e4af9008a3ce3d2ab98bd2745e2d8acf1b9afd7`
- Candidate policy digest: `de75e51afa40bab0399565531ee34b4766307ecb9976b4bd699498079917ed71`
- Draft capability review: `/home/dikkekip/LawyerRAG/.openclaw/operator-artifacts/verifier-coverage-20260928/capability-hearing-draft/plan.json`

The addendum adds one path-selected `bundle-hearing-runsheet` rule. The
protected command requires `BundleHearingRunSheet.test.tsx` and the existing
`bundleHearingRunSheetExport.test.ts` before running Vitest. The new test is
admitted from a candidate commit by `nativeCandidateSandbox`; it is not a
global sandbox input, since older candidates do not contain it. The proposal
keeps all 42 previously staged rules and all global inputs.

The exact committed candidate passed both suites in the protected image: 6/6
tests in `/tmp/native-hearing-coverage-complete-20260928.json`. An earlier run
with the new test omitted returned exit code 0 after executing only the export
suite; that artifact is `/tmp/native-hearing-coverage-20260928.json` and is
**not** acceptance evidence. The corrected command returned exit code 1 when
the new test was deliberately omitted, recorded in
`/tmp/native-hearing-coverage-missing-test-20260928.json`.

The production snapshot path also passed 6/6 tests in
`/tmp/native-hearing-coverage-production-path-20260928.json`. The staged
policy doctor passes all checks except `measured-role-capabilities`.
That gate requires independently reviewed evidence for the new policy digest;
the separate, unregistered draft validates all 22 unchanged roles against the
current gateway configuration.

Activation requires independent approval of the expanded policy and capability
evidence bound to its new digest. After approval, pause native execution at a
clear session boundary, validate the policy, refresh it, and retry the exact
blocked workflow with a new immutable attempt. Design review, commit-bound
verification, final review, and deployment gates still apply.
