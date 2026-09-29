# Changed feature verifier coverage proposal

The live LawyerRAG policy remains unchanged pending independent review of the
capability evidence and exact policy digest. This proposal extends the staged
current feature policy; it supersedes that proposal for activation.

- Staged policy: `/tmp/lawyerrag-native-verifier-coverage-changed-tests-20260928.json`
- Policy digest: `c36c6d174f28e29fa36bd8412d3a4074c4b23abab93a6945ee7c30deecd9abfd`
- Base image: `sha256:f5cf87b95deec3fec5b9e0b687cd137b4c1ee753ab2de0de2ac50f01fe61717a`
- New local image: `sha256:bc9b743a0787f257c0e9f0fe304334ddee64cf319c836f7b3e3d6e867797e035`
- Capability review draft: `/home/dikkekip/LawyerRAG/.openclaw/operator-artifacts/verifier-coverage-20260928/capability-changed-tests-draft/plan.json`

The 48th protected rule applies when a candidate changes a feature `*.test.ts`
or `*.test.tsx` file. The host
captures the exact committed candidate head and changed paths, then writes a
manifest into the disposable verification snapshot. The container selects only
committed changed test files or existing companion tests for changed TypeScript
feature sources. It fails closed when no test is selected. Source-only feature
changes still use the existing path-selected rules and require independent
design review. The manifest is not
accepted from the candidate Git tree, and Git metadata is absent in the
container. The command verifies the unchanged dependency lockfile and runs
Vitest with network disabled.

The exact duplicate receipt candidate `c797cb36d0650746392cb512fb857b7e35d29ff6`
selected `DuplicateReceiptReview.test.tsx` and passed 11/11 tests in a disposable
no-network snapshot. The exact desktop shortcut candidate
`4e6458b06cd8abf3af5c1703588884a7a995fc78` selected
`WorkflowQuickActions.test.tsx` and passed 28/28. These are diagnostic runs,
not candidate acceptance or a design review verdict.

On 2026-09-29, the exact blocked intake candidate
`4ffebc4900968b58008509ef9c57473662c4c1f5` selected its changed
`IngestionIntakePausePanel.test.tsx` and passed 15/15 tests in a disposable
no-network snapshot. The live `legacy-014` rule does not select that changed
test. Compared with the live policy, this staged policy changes only the
verifier image and adds eight rules; all 40 existing rules are identical. This
diagnostic run does not resolve the candidate's separate design evidence and
accessibility review objections.

The exact missing-metadata filter candidate
`cf4fd504c973f0e4289a00a553bd649b2c0ea503` selected its changed
`PdfWorkspaceMissingMetadataReview.test.tsx` and passed 4/4 tests in a
disposable no-network snapshot on 2026-09-29. This addresses only the
reviewer's concern that the changed test was absent from the live standing
selection. It does not establish persistent caller behavior or an actionable
assistive-technology and narrow-viewport procedure; the candidate remains
blocked pending those separate design requirements and independent policy
review.

Head-bound caller inspection for that candidate gives a narrower, inspectable
claim. `PdfWorkspaceSections.tsx` passes
`metadataFilter === 'missing_metadata'` to the banner's `isActive` prop.
`PdfWorkspace.tsx` implements `handleShowMissingMetadata` by clearing the search
query and calling `updateWorkspaceSort` with `metadataFilter:
'missing_metadata'`. That helper navigates to `/pdf` with
`mergePdfWorkspaceSortSearch` and `replace: true`; the component reads
`metadataFilter` from `parsedWorkspaceSearch` and includes it in
`serializePdfWorkspaceSortSearch`. The selected state therefore follows the
URL filter state at this exact head. This is source inspection, not a rendered
caller regression test or proof that a reviewer can complete the workflow.

Proposed manual review procedure for the exact candidate, still unexecuted:

1. Seed a matter with at least one attachment missing title, date, source, or
   disclosure metadata and one complete attachment. Open `/pdf`, activate
   **Review missing metadata**, then confirm the URL filter, visible subset,
   and button's selected state agree. Reload, then open the resulting URL in a
   fresh tab to check state restoration; clear the active filter and verify it
   resets. The filter update replaces the current history entry, so browser
   back is not a suitable state-restoration check here.
2. With a screen reader, move to the **Vedlegg incomplete metadata review
   banner** and its **Review missing metadata** button. Confirm the count and
   purpose are announced, the button reports pressed before and after
   activation, and the active subset summary is discoverable. Use Enter and
   Space from the button, then clear the filter and confirm pressed is false.
3. Repeat at 320px and 375px CSS viewport widths with 200% browser zoom.
   Check that both review buttons remain visible, usable by touch and keyboard,
   and free of horizontal overflow; confirm focus remains visible and the
   selected state is clear without relying on color alone.

Record browser, screen reader, viewport, observed URL, focused control,
announcements, screenshots, and any deviations before asking the independent
reviewer to reconsider. Passing the four component tests alone is insufficient.

A broad ingestion directory suite was tested and rejected: it passed 252 tests
but failed one unrelated preexisting TaskMonitor assertion. Selecting tests
from exact changed paths avoids making unrelated baseline failures block every
candidate in that directory. Only 142 of 467 current feature `.tsx` sources
have a same-name companion test, so applying this rule to all feature sources
would block many source-only candidates. The earlier exact WhatsApp and ingestion rules
remain in the staged policy and still require independent review.

The 22-role capability draft only rebinds unchanged measurements and role
requirements to this proposed policy digest. It is unregistered. Neither the
policy nor capability evidence may be activated before independent approval.
