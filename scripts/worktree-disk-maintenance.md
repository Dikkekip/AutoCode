# Worktree dependency maintenance

`worktree-disk-maintenance.py` audits a dedicated Git worktree root and removes only ignored, untracked `node_modules` directories with no writes in six hours. It never removes source, commits, worktrees, review artifacts, Docker images, or volumes. Run dry before applying:

```sh
python3 scripts/worktree-disk-maintenance.py --repo /path/to/repo --worktree-root /path/to/managed/worktrees
python3 scripts/worktree-disk-maintenance.py --repo /path/to/repo --worktree-root /path/to/managed/worktrees --apply
python3 scripts/worktree-disk-maintenance.test.py
```

Requires Linux `/proc`, Git, Docker CLI access, and Python 3. Containers with overlapping bind mounts, Git-locked worktrees, active process references, tracked dependencies, symlinks, and recent installs are protected. Docker inspection failure aborts. Unknown inaccessible same-user processes fail closed; privilege-separated login managers and foreign PID namespaces are excluded, with container storage protected via bind mounts. Acquire a Git worktree lock before mutation and recheck processes and mounts. The framework must honor Git worktree locks when assigning work.

Run hourly from the host user service manager. Use one unit per repository, `Type=oneshot`, an absolute interpreter/script path, `ExecStart` with the two explicit roots and `--apply`, and `OnUnitActiveSec=1h` in the timer. Journal output records reclaimed bytes and skip reasons. Native OpenClaw remains the owner of managed worktree lifecycle and sandbox retirement; this job supplements its retention GC with dependency reclamation. Dependencies will be reinstalled by resumed tasks. Entire worktrees require a separate merge, dirtiness, ownership, and runtime audit before removal.
