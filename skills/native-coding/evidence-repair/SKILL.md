---
name: evidence-repair
description: Diagnose and correct a native candidate that failed verification or review using retained attempt evidence and the remaining repair budget.
---

# Repair with evidence

Use `repairPlan.current` and its bounded history when supplied. Compare candidate revisions, failing checks, unsatisfied criteria, and the prior rationale. The original feature request supplies context; the remaining failed criteria define the correction. Review feedback does not widen the admitted scope.

Reproduce the smallest failure that distinguishes the current hypothesis from the alternatives. A second failure of the same command is not necessarily the same root cause. Inspect its evidence before changing strategy. If the candidate and failure evidence have not changed, diagnose the blocker rather than repeating the previous patch or asking for another identical run.

Make the correction at the layer that owns the defect. Preserve previously working acceptance behavior and required verification authority. Do not lower assertions or remove checks to obtain success. Report what changed, which prior failure it addresses, the new proof, and remaining uncertainty.

AutoCode allows at most two automatic repair attempts and can stop earlier for repeated candidate/evidence pairs. A new session does not reset that limit. If blocked, preserve the worktree and receipts for the existing workflow recovery path. Submission still requires `autocode_submit`; fresh independent verification and review remain necessary.
