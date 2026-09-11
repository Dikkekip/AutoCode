# Native investigation session budget

`quality.sessionSeconds` accepts an integer from 30 through 600 seconds. The default remains 300 seconds. Existing policies explicitly set to 300 remain at 300; a schema upgrade does not lengthen their sessions.

An administrator can explicitly choose a longer finite budget for investigations that need more source inspection, up to 600 seconds. This increases the possible wall time per investigation and may increase resource use. It does not change worker concurrency, quota handling, source inspection requirements, acceptance criteria, verification authority, planner admission, or review gates.

The configured budget feeds investigation card runtime and elapsed-time submission checks. Raising it does not guarantee process termination at the deadline; cancellation transport and ownership checks remain separate controls. Previously timed-out investigations and rejected submissions remain invalid. Use a fresh assigned investigation for new work after an approved policy change.

This ceiling extension changes schema validation only. Activating a longer budget requires an explicit policy change and a runtime that supports the extended range.
