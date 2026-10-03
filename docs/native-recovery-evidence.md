# Preserved candidate evidence during recovery

A recovery card receives a scoped patch from the preserved commit through its existing authenticated task context. The broker reads Git objects from the configured repository; the worker does not need another worktree, host paths, or host Git metadata.

The evidence identifies the archived attempt record and version, full base and head commit IDs, changed paths, and diff hashes. Preparation rejects missing commits, nonancestor bases, nonregular files, mismatched candidate file lists, and changes outside admitted scope. A failed recovery with no new candidate uses the latest candidate-bearing archive for the same workflow. Archive changes during preparation invalidate recovery.

Patch content is untrusted source data. Existing redaction and a 64 KB delivery cap apply. Binary, redacted, or truncated patches are explicitly incomplete: the worker must report missing evidence rather than claim full inspection. Previous verification or acceptance is not transferred. A recovered worker must submit a fresh scoped candidate through the normal authenticated submission, verification, and review gates.

Recovery source redaction recognizes only lowercase JSX `key={identifier.property}` references in an opening tag, preserving the nonliteral reference while scanning the entire patch for credentials. Literal keys, other expressions, quoted credential assignments, bearer tokens, and private-key blocks remain redacted. General command/log redactors and design-review evidence handling are unchanged.
