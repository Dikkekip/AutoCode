# Changed feature verifier coverage proposal

The live LawyerRAG policy remains unchanged pending independent review of the
capability evidence and exact policy digest. This proposal extends the staged
current feature policy; it supersedes that proposal for activation.

- Staged policy: `/tmp/lawyerrag-native-verifier-coverage-changed-features-20260928.json`
- Policy digest: `411a9ee517f457da7457661247702e63a17464decbd0a5956ad000e916451407`
- Base image: `sha256:f5cf87b95deec3fec5b9e0b687cd137b4c1ee753ab2de0de2ac50f01fe61717a`
- New local image: `sha256:bc9b743a0787f257c0e9f0fe304334ddee64cf319c836f7b3e3d6e867797e035`
- Capability review draft: `/home/dikkekip/LawyerRAG/.openclaw/operator-artifacts/verifier-coverage-20260928/capability-changed-features-draft/plan.json`

The 48th protected rule applies to `apps/reports-ui/src/features/**`. The host
captures the exact committed candidate head and changed paths, then writes a
manifest into the disposable verification snapshot. The container selects only
committed changed test files or existing companion tests for changed TypeScript
feature sources. It fails closed when no test is selected. The manifest is not
accepted from the candidate Git tree, and Git metadata is absent in the
container. The command verifies the unchanged dependency lockfile and runs
Vitest with network disabled.

The exact duplicate receipt candidate `c797cb36d0650746392cb512fb857b7e35d29ff6`
selected `DuplicateReceiptReview.test.tsx` and passed 11/11 tests in a disposable
no-network snapshot. The exact desktop shortcut candidate
`4e6458b06cd8abf3af5c1703588884a7a995fc78` selected
`WorkflowQuickActions.test.tsx` and passed 28/28. These are diagnostic runs,
not candidate acceptance or a design review verdict.

A broad ingestion directory suite was tested and rejected: it passed 252 tests
but failed one unrelated preexisting TaskMonitor assertion. Selecting tests
from exact changed paths avoids making unrelated baseline failures block every
candidate in that directory. The earlier exact WhatsApp and ingestion rules
remain in the staged policy and still require independent review.

The 22-role capability draft only rebinds unchanged measurements and role
requirements to this proposed policy digest. It is unregistered. Neither the
policy nor capability evidence may be activated before independent approval.
