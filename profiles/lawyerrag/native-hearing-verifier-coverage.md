# Hearing run sheet verifier coverage addendum

This addendum extends the staged 2026-09-28 verifier coverage proposal. It is
not active in the LawyerRAG native policy.

- Blocked workflow: `8b4de654e0489e10accdc35313b1a33e5a3dc7de8f68f5a53771ce712c79cd56`
- Exact candidate: `19967ed4c1ecbd0358d3eace251e59ffacf66d13`
- Base: `3b806029f6a80014bd5d4502b19a75c372ca0763`
- Staged policy: `/tmp/lawyerrag-native-verifier-coverage-hearing-20260928.json`
- Prior reviewed coverage image: `sha256:159dc23c0766d9a0ef15ae971d7909a9d4642623045d77ee3cee589d17b1bd83`
- New local image: `sha256:abb736ffaef0693ca9c43bf93e4af9008a3ce3d2ab98bd2745e2d8acf1b9afd7`
- Candidate policy digest: `e412599cf6700ca50d0848f6fe3233c804b1d2825dd9e378e8b5a17607e22dfd`
- Draft capability review: `/home/dikkekip/LawyerRAG/.openclaw/operator-artifacts/verifier-coverage-20260928/capability-hearing-draft/plan.json`

The addendum adds one path-selected `bundle-hearing-runsheet` rule and one
sandbox input file, `BundleHearingRunSheet.test.tsx`. The protected command
requires that component test and the existing `bundleHearingRunSheetExport.test.ts`
before running Vitest. It keeps all 42 rules and other inputs in the previously
staged policy.

The exact committed candidate passed both suites in the protected image: 6/6
tests in `/tmp/native-hearing-coverage-complete-20260928.json`. An earlier run
with the new test omitted returned exit code 0 after executing only the export
suite; that artifact is `/tmp/native-hearing-coverage-20260928.json` and is
**not** acceptance evidence. The corrected command returned exit code 1 when
the new test was deliberately omitted, recorded in
`/tmp/native-hearing-coverage-missing-test-20260928.json`.

The staged policy doctor passes all checks except `measured-role-capabilities`.
That gate requires independently reviewed evidence for the new policy digest;
the separate, unregistered draft validates all 22 unchanged roles against the
current gateway configuration.

Activation requires independent approval of the expanded policy and capability
evidence bound to its new digest. After approval, pause native execution at a
clear session boundary, validate the policy, refresh it, and retry the exact
blocked workflow with a new immutable attempt. Design review, commit-bound
verification, final review, and deployment gates still apply.
