# LawyerRAG native verifier coverage, September 28

The protected overlay adds two path-selected commands without replacing any
existing checks:

| Rule | Selected candidate paths | Protected command |
| --- | --- | --- |
| `incident-deadline-handoff` | `IncidentDeadlineActionRow.tsx`, `IncidentDeadlineActionQueue.test.tsx` | `/opt/openclaw/checks/incident-deadline-handoff` |
| `swipe-base-comparison` | `SwipeActionRow.tsx`, `SwipeActionRow.test.tsx` | `/opt/openclaw/checks/swipe-base-comparison` |

The swipe baseline is the `SwipeActionRow.tsx` blob `46dfc3a7170b6ffa6efb5fa51f855b024d6eeaa1`
from LawyerRAG revision `3b806029f6a80014bd5d4502b19a75c372ca0763`.
The comparison uses the same candidate test file with that pinned production
source and with the candidate production source. Both expected base failures
and candidate passes are required.

Before building, verify that the local image tag
`native-verifier:complete-browser-repair-20260927` resolves to
`sha256:322160d84121c50584a821e6546958dc7a0ffdfe01d8ef0d7cc995ebfc7b82ba`.
Build from this directory with `docker build --network=none -f
Dockerfile.native-verifier-coverage --build-arg
BASE_VERIFIER_IMAGE=native-verifier:complete-browser-repair-20260927 -t
native-verifier:coverage-20260928 .` The resulting local image ID was
`sha256:159dc23c0766d9a0ef15ae971d7909a9d4642623045d77ee3cee589d17b1bd83`.

Isolated diagnostics against exact blocked candidates passed: the incident
queue suite ran 23 tests on `5e8a3d6c0f2b25b5914dc1c6ff0de2bace570021`, and the
swipe comparison observed both expected base failures and candidate passes
on `17271f3b57420f6cac435fb4d6451963adb5def9`.

The policy preview is `/tmp/lawyerrag-native-verifier-coverage-20260928.json`.
The live policy has not been changed. Policy refresh requires paused, idle
native execution and new independently reviewed capability evidence bound to
the candidate policy digest. Retain all existing checks and workflow evidence
when refreshing and recovering these two exact workflows.
