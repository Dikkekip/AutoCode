---
name: investigate-first
description: Diagnose uncertain failures and substantiate AutoCode improvement proposals with source evidence and falsifiable hypotheses.
---

# Investigate first

Separate the observed behavior from the proposed cause. Start with the supplied persona goal and user workflow, then find the code that owns the failing transition. State the strongest current hypothesis and the cheapest observation that could disprove it. Trace callers, state ownership, and failure output before choosing an edit.

For an ambiguous failure, compare plausible causes using evidence rather than generating patches for each guess. Record revision, path, relevant range, and the observed behavior. An absent search match is weak evidence until alternate names and likely owners have been checked. Distinguish a reproducible defect from missing credentials, unavailable services, or an unsupported environment.

Stop exploration once the mechanism and smallest sufficient scope are supported, or when a precise missing fact prevents a conclusion. Implementation authorization carries through into fixing a diagnosed problem; a research-only assignment ends with findings or a proposal.

For a native proposal, connect problem → user impact → responsible mechanism → proposed change → acceptance proof. Include an alternative, uncertainty, and non-goals. Prefer a useful no-change finding over an invented task. Do not turn speculative performance benefits into measured claims.
