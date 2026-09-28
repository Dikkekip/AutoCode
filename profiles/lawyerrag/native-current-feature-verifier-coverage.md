# Current feature verifier coverage proposal

This extends the staged timeline verifier proposal. The LawyerRAG live policy
remains unchanged until an independent human reviews the new capability
evidence and exact policy digest.

- Staged policy: `/tmp/lawyerrag-native-verifier-coverage-current-features-20260928.json`
- Staged policy digest: `2872e24d4f275ddca1d9e56635d801111f2dd5c30a827399f0bb66e061a56343`
- Base image: `sha256:315b87f18f544711b35be36303ed713768362fb6c48e97bcfd01cb8a6388ae86`
- New local image: `sha256:f5cf87b95deec3fec5b9e0b687cd137b4c1ee753ab2de0de2ac50f01fe61717a`
- Capability review draft: `/home/dikkekip/LawyerRAG/.openclaw/operator-artifacts/verifier-coverage-20260928/capability-current-features-draft/plan.json`

The proposal adds two exact path-selected rules, making 47 rules. The
`whatsapp-search-keyboard` command runs `SearchPanel.test.tsx` and requires its
named Enter regression to fail against the protected source from base
`3b806029f6a80014bd5d4502b19a75c372ca0763` before running the candidate
suite. The `ingestion-task-status-recovery` command runs `TaskMonitor.test.tsx`.
Both commands use the immutable image and the existing dependency lockfile.
No global snapshot inputs or other standing commands were changed.

The exact WhatsApp attempt 0 commit `8fb71cd918630c982968a9103be0b929b0011fa3`
passed the new protected command on a disposable no-network snapshot: the
reviewed base failed the named Enter case and the candidate passed 8/8 tests.
The exact ingestion repair commit `47485336ba71004e34c3ae0fdf73e512b2ac65df`
passed 11/11 TaskMonitor tests through the new protected command on a
disposable no-network snapshot. These are verifier diagnostics, not candidate
acceptance. A prior TaskMonitor run against an in-progress worktree failed;
it was not commit-bound evidence and is superseded by the exact-commit run.

The later ingestion attempt 2 review asked why the existing reconciliation
assertion changed and why a dedup API mock was added. The reconciliation panel
at `apps/reports-ui/src/features/ingestion/components/BarnevernSourceBundleReconciliationPanel.tsx`
has the same Git blob `0db3305a9b478fff5600c5ef18d426e0ea866caf` at base and candidate.
Its rendered success text already says “Every reported source document has a
canonical accounting outcome” (line 239), which is what the revised assertion
checks. The unchanged panel also calls
`IngestionAPI.getBarnevernIngestionDedupReport` (line 156); the added mock
supplies that existing dependency in the TaskMonitor test harness. Independent
review must still decide whether the candidate preserves the assertion's
intended behavioral coverage.
The exact attempt 2 commit `fec3b9443e583371fb2c748928a7603df006aa8b`
also passed 11/11 TaskMonitor tests through the protected command in a fresh
disposable no-network snapshot.

Native doctor passes all checks except `measured-role-capabilities`. The
separate 22-role capability draft validates artifact hashes and role
eligibility but is unregistered. Its unchanged measurements need independent
review for the new policy digest before registration and policy refresh.
