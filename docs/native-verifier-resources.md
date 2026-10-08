# Verification resource capacity

Docker verification defaults to a 256-task cgroup limit. Linux counts threads as
tasks, so multi-process browser suites can exhaust this limit even with available
memory. A failed Chromium launch is not evidence that the candidate application
is defective.

Projects can set `verificationSandbox.pidsLimit` to an integer between 64 and 4096.
The setting is Docker-only and is part of the validated policy, so it participates
in policy provenance. Omitting it preserves the default of 256. Both policy
validation and the command adapter reject unlimited, fractional, and excessive
values before executing Docker.

Docker verification otherwise defaults to 4096 MiB and 2 CPUs. Projects can set
`verificationSandbox.memoryMb` (512–16384, integer) and
`verificationSandbox.cpus` (0.25–8) to smaller reviewed budgets. The memory limit
also sets the container's memory-plus-swap limit to the same value, so a verifier
cannot push the host into swap. These settings are Docker-only, validated twice,
and included in policy provenance. Choose the smallest values that pass the real
browser/build gates; an OOM or throttled timeout is a resource-policy failure, not
candidate evidence.

```json
{
  "verificationSandbox": {
    "backend": "docker",
    "image": "sha256:<reviewed-image-id>",
    "inputFiles": ["src/example.ts"],
    "pidsLimit": 1024,
    "memoryMb": 3072,
    "cpus": 1
  }
}
```

Investigate failures using the exact candidate, immutable verifier image, command,
and persisted output. Compare cgroup `pids.events` and `pids.max` where available.
Validate a proposed limit using a separate diagnostic receipt before refreshing
the live policy. Keep network isolation, read-only root, privilege restrictions,
memory/CPU limits, all assertions, deadlines, and acceptance gates intact.

Do not import diagnostic results as native acceptance. A previously blocked
workflow still needs the normal operator recovery procedure, fresh commit-bound
verification, and independent review. Do not restart a live verifier merely
because a monitoring call expires.

The September 26 capacity diagnostic in the installed verifier image reproduced
thread creation failure at 254 threads with `pids.max=256` and `pids.events max=1`.
The same diagnostic created all 300 threads at a 1024 limit with no limit events.
This establishes the resource constraint; the unchanged browser gate must still
pass independently for each candidate.
