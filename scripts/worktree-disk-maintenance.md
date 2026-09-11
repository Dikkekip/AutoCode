# Worktree dependency maintenance

`worktree-disk-maintenance.py` audits a dedicated Git worktree root. Dry-run is the default. It identifies only ignored, untracked, real `node_modules` directories with no writes in six hours. It never removes source, commits, worktrees, review artifacts, Docker images, or volumes.

```sh
python3 scripts/worktree-disk-maintenance.py --repo /path/to/repo --worktree-root /path/to/managed/worktrees
python3 scripts/worktree-disk-maintenance.test.py
```

Unattended `--apply` is refused. Git worktree locks are advisory: installed Workboard direct starts do not honor them, so they cannot prevent a worker starting between the final process check and deletion. Do not enable an hourly apply timer or add a permanent window receipt to a service.

An operator may perform a short maintenance window after pausing native execution, holding scheduling, proving relevant sessions and operations terminal, and excluding **all direct Workboard starts and workspace edits** until cleanup finishes. The operator controls that exclusion; this script does not provide an atomic direct-start lock or pause anything itself. Preserve existing pause/scheduler ownership when restoring operation.

Create a receipt outside both the repository and managed worktree root, in an operator-owned directory with mode `0700`. The receipt must be an operator-owned regular file with mode `0600` or `0400`; symlink paths are rejected. Supply exactly these fields, using canonical absolute paths and current Unix timestamps in seconds:

```json
{
  "version": 1,
  "repository": "/path/to/repo",
  "worktreeRoot": "/path/to/managed/worktrees",
  "issuedAt": 2000000000,
  "expiresAt": 2000000120,
  "statement": "native-paused-scheduling-held-direct-starts-excluded"
}
```

The example timestamps are placeholders. The window must already have begun and expire within five minutes of issuance. The statement is an explicit operator assertion of the conditions above, not automatically verified gateway evidence. Run:

```sh
python3 scripts/worktree-disk-maintenance.py --repo /path/to/repo --worktree-root /path/to/managed/worktrees --apply --operator-window /private/operator/window.json
```

A missing, malformed, unsafe, stale, future-dated or mismatched receipt stops apply before Git lock acquisition or deletion. The same receipt bytes and expiry are checked again before each lock and immediately before each deletion. Expiry or replacement stops further work; an owned Git lock is released on failure. Keep the operator window active until the process exits, including a deletion already begun before expiry.

Requires Linux `/proc`, Git, Docker CLI access, and Python 3. Containers with overlapping bind mounts, Git-locked worktrees, active process references, tracked dependencies, symlinks, and recent installs remain protected even with a valid receipt. Docker inspection failure aborts. Unknown inaccessible same-user processes fail closed; privilege-separated login managers and foreign PID namespaces are excluded, with container storage protected via bind mounts. Mutation acquires a Git worktree lock and rechecks processes and mounts, but those checks supplement the operator window and do not replace it.

Native OpenClaw remains the owner of managed worktree lifecycle and sandbox retirement. Entire worktrees require a separate merge, dirtiness, ownership, and runtime audit before removal. Reinstallable dependencies may be recreated by a later task after the maintenance window closes.
