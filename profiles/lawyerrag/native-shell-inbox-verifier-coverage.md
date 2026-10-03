# Shell inbox verifier coverage addendum

This extends the staged 2026-09-28 verifier proposal. The LawyerRAG live
native policy remains unchanged.

- Workflow: `65bff34143f2f745eab1d48c75255c4408857d6965b6adc816ce8bb81d78f3f9`
- Exact attempt 2 candidate: `2e5f25efd018abbeb14e7885202afdb66865ffd4`
- Base: `3b806029f6a80014bd5d4502b19a75c372ca0763`
- Staged policy: `/tmp/lawyerrag-native-verifier-coverage-shell-20260928.json`
- Reviewed hearing coverage image: `sha256:abb736ffaef0693ca9c43bf93e4af9008a3ce3d2ab98bd2745e2d8acf1b9afd7`
- New local image: `sha256:909490f7dac9eff6628d6fb600ac512f62bb1cc25e7edba17b22f4f88e286e93`
- Candidate policy digest: `a4b45d58bdf0862b90303cc3b3d816f16dea9ca77da6b08aa80d9143b7847dab`
- Draft capability review: `/home/dikkekip/LawyerRAG/.openclaw/operator-artifacts/verifier-coverage-20260928/capability-shell-draft/plan.json`

The proposal adds one path-selected `shell-inbox-outcomes` rule, making 44
rules in total. The protected command requires both
`ShellNotificationInbox.test.tsx` and `ShellWorkActivityCenter.test.tsx` and
runs them with Vitest. The rule adds no global sandbox inputs. Candidate
snapshots admit changed committed files through `nativeCandidateSandbox`.

The exact attempt 2 candidate passed 93/93 tests through the production
snapshot path. The receipt is
`/tmp/native-shell-coverage-production-path-20260928.json`. This is a
coverage diagnostic, not acceptance of the candidate: independent design
review requested stronger assertions for exactly-once task preservation and
accessibility/state behavior, and the workflow advanced to attempt 3.

Attempt 3 committed `65d33b2ff36f25d2aa566e2f55791cc7595b5b48` and passed
96/96 protected tests in
`/tmp/native-shell-attempt3-coverage-production-path-20260928.json`.
Independent design review still requested a standing focused test gate and a
complete committed diff. A source redaction fix in this framework restores
the exact 21,607-byte attempt 3 diff without redaction; the gateway must load
that fix before a new review can use the complete evidence. Neither test
receipt substitutes for independent design and final review.

The separate, unregistered capability draft validates all 22 unchanged roles
against the current gateway configuration. Its reviewer status is pending
independent human review. Activation of this expanded policy and draft evidence
requires that approval, then a paused and idle policy refresh. Keep the exact
workflow and prior attempt evidence intact when retrying blocked work.
