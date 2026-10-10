# Host resource safeguards

Native AutoCode checks host headroom, Gateway RSS, Linux memory PSI, and one-minute CPU load before dispatching workers or acquiring verification/release capacity. Pressure defers effects without cancelling workflows. Reconciliation retries after a stable recovery hold. `autocode.status` exposes `resourcePressure`; durable `resource.deferred` events record why a start was held.

Defaults reserve 15% of host RAM (at least 512 MiB), budget 2 GiB per new worker, hold starts when Gateway RSS reaches 25% of host RAM (at most 3 GiB), when memory PSI `full avg10` reaches 5%, or when one-minute load reaches 125% per available CPU. A dispatch batch cannot exceed its estimated memory capacity. All boards in the same Gateway share temporary reservations for verification and release operations.

Operators can configure these integer fields in the reviewed native policy:

```json
{
  "resourceControls": {
    "minAvailableMiB": 3072,
    "maxGatewayRssMiB": 3072,
    "workerReserveMiB": 2048,
    "maxMemoryPressurePercent": 5,
    "maxCpuLoadPercent": 100,
    "recoveryHoldSeconds": 60
  }
}
```

Admission is a headroom estimate, not a hard allocation. Existing workers can grow after admission. Docker verification therefore also supports hard `verificationSandbox.memoryMb` and `verificationSandbox.cpus` limits; its memory-plus-swap ceiling equals `memoryMb`, preventing a verifier from filling host swap. Manual builds outside AutoCode still need their own cgroup or systemd limits.
