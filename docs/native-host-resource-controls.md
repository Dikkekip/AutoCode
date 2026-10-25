# Host memory safeguards

Native AutoCode checks host headroom, gateway RSS, and Linux memory PSI before dispatching workers or acquiring verification/release capacity. Pressure defers effects without blocking or cancelling workflows. Reconciliation retries after 60 seconds of recovery. `autocode.status` exposes `resourcePressure`; durable `resource.deferred` events record why a start was held.

The defaults reserve 15% of host RAM (at least 512 MiB), budget 2 GiB per new worker, hold starts when gateway RSS reaches 25% of host RAM (at most 3 GiB), and hold starts when memory PSI `full avg10` reaches 5%. A dispatch batch cannot exceed its estimated available memory budget. All boards in the same gateway share reservations for in-flight starts and verification/release operations, so concurrent operations cannot claim the same headroom. Independent gateway/CLI processes do not share these temporary reservations. Missing or malformed required memory telemetry holds starts. Exhausted swap alone does not trigger a hold when RAM and PSI are healthy.

Operators can configure these integer fields in the reviewed native policy:

```json
{
  "resourceControls": {
    "minAvailableMiB": 2304,
    "maxGatewayRssMiB": 3072,
    "workerReserveMiB": 2048,
    "maxMemoryPressurePercent": 5,
    "recoveryHoldSeconds": 60
  }
}
```

Admission is a headroom estimate, not a hard memory allocation. Existing workers can grow after admission. Run verification and coder commands in operator-owned sandboxes with memory, swap and PID limits; keep their concurrency within the host budget. Manual builds and other processes outside AutoCode need their own limits.

## Gateway containment and idle recovery

For a 16 GiB Linux host, an operator can install this systemd **user-service drop-in** for `openclaw-gateway.service` after reviewing the total budget and draining active work:

```ini
[Service]
MemoryAccounting=yes
MemoryHigh=3G
MemoryMax=4G
MemorySwapMax=512M
OOMPolicy=kill
```

These limits include descendants in the gateway service's cgroup. `MemoryHigh` throttles allocation; `MemoryMax` is the final containment boundary. Reaching it can terminate active work, so admission and idle recovery should act earlier. The existing service restart policy must remain enabled. Do not add a global Node heap flag: it can override worker-thread resource limits.

`scripts/native-memory-watch.mjs` is an external, low-memory watchdog suitable for a one-minute user timer. It samples the gateway's `/proc` RSS and allows recovery only after three samples spanning at least two minutes above the threshold, a complete idle Workboard inventory across all boards, and a one-hour restart cooldown. It rechecks the PID and idle inventory before requesting a restart. Unknown, paginated, claimed, or active work prevents recovery. Start with observation mode:

```sh
node scripts/native-memory-watch.mjs --state /absolute/operator-state/memory-watch.json --openclaw /absolute/path/to/openclaw
```

Add `--apply` only when idle gateway restarts have been authorized. `--max-rss-mib` defaults to 3072; configure it below the reviewed service ceiling. The state file contains only PID/counters/timestamps. Observation mode never restarts the service or consumes a restart cooldown. The supervisor needs no model request and must run outside the gateway cgroup.

The idle observation is not an atomic dispatch lock. A concurrent manual start remains possible; use the normal framework drain procedure before an operator-initiated restart. This change does not install service limits, timers, or a new live runtime automatically.
