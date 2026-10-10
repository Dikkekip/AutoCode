# Minimal fix

Address one explicit problem with the smallest coherent change:

1. reproduce or inspect the exact failure when possible;
2. identify the narrow root cause rather than a distant symptom;
3. edit only admitted files required by that cause;
4. avoid drive-by refactors, weakened assertions, skipped checks, and expanded scope;
5. name the focused verification that should run before broader checks.

The implementer proposes evidence; the independent verifier and reviewer decide
whether it is sufficient.
