# OpenClaw 2026.9.6 migration lease workaround

On a host with 63 agent stores, Codex post-session repair repeatedly exceeded the
60-second agent maintenance lease. Both `doctor --fix` and Gateway startup failed
with `plugin-doctor-post-session-state` and `core:agent-database-maintenance/global
was lost`. Increasing only that call's lease to 300 seconds allowed Doctor to
complete and record the Codex migration. The surrounding plugin lifecycle lease
already uses 300 seconds. Restoring the original module reproduced the failure on
Gateway startup, so a one-time migration patch is insufficient on this build.

`scripts/openclaw-migration-lease.py` is an explicit, local workaround for the
exact inspected 2026.9.6 build. It changes one lease argument. Ownership checks,
heartbeat behavior, migration logic, and completion gates stay intact. It pins
the package version and original module SHA-256, stores private recovery bytes,
and refuses unknown builds or independent installed-file changes. It does not
edit SQLite or certify successful startup. This is not an upstream OpenClaw fix.

Pause native dispatch and stop the Gateway before applying. Wait for any existing
Doctor or update process to finish; never change package files underneath it.
Stop scheduled account reloads for the maintenance window, recording what needs
to be restored. Then use the actual installation and a private receipt directory:

```sh
python3 scripts/openclaw-migration-lease.test.py
python3 scripts/openclaw-migration-lease.py \
  --package-root /absolute/path/to/openclaw \
  --receipt-dir /private/operator-artifacts/migration-lease
node --check /absolute/path/to/openclaw/dist/state-migrations.plugin-doctor-DlRpG3T4.mjs
```

Run supported Doctor repair if migration is unfinished, start the Gateway, and
verify native Doctor, real model canaries, scheduling, and resumed work. Preserve
the receipt with the installed version. Subsequent package updates may overwrite
this workaround; reassess the upstream behavior rather than automatically
patching another build. A longer lease also increases the worst-case delay before
a crashed maintenance owner can be reclaimed.

To restore while Gateway and Doctor are stopped, use the same arguments with
`--restore`. Restoration refuses modified backup bytes or unrelated installed
changes. Restoring this affected build is expected to reproduce the startup
failure on the observed large-store host.
