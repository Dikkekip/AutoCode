#!/usr/bin/env python3
"""Prune reinstallable dependencies in idle Git worktrees; source is never removed.

Dry-run by default. Docker availability and process inspection are required.
Git worktree locks protect ongoing runs, including during the deletion window.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import time


def run(*args, check=True):
    return subprocess.run(args, text=True, capture_output=True, check=check)


def inside(path, parent):
    return path == parent or parent in path.parents


def overlap(path, other):
    return inside(path, other) or inside(other, path)


def container_mounts():
    ids = run("docker", "ps", "-q").stdout.split()
    if not ids:
        return []
    return [Path(m["Source"]).resolve() for c in json.loads(run("docker", "inspect", *ids).stdout)
            for m in c["Mounts"] if m.get("Type") == "bind"]


def process_uses(path):
    for proc in Path("/proc").iterdir():
        if not proc.name.isdigit() or int(proc.name) == os.getpid():
            continue
        try:
            if proc.stat().st_uid != os.getuid():
                continue  # Container roots are covered by Docker bind mounts.
            for link in [proc / "cwd", *(proc / "fd").iterdir()]:
                try:
                    if inside(link.resolve(strict=True), path):
                        return True
                except FileNotFoundError:
                    pass
            if str(path).encode() in (proc / "cmdline").read_bytes():
                return True
        except (FileNotFoundError, ProcessLookupError):
            continue
        except PermissionError:
            # Privilege-separated login managers are not dependency consumers.
            # Foreign PID namespaces are containers, protected by bind mounts.
            try:
                foreign_namespace = os.readlink(proc / "ns/pid") != os.readlink("/proc/self/ns/pid")
            except PermissionError:
                foreign_namespace = any(line.startswith("NSpid:") and len(line.split()) > 2
                                        for line in (proc / "status").read_text().splitlines())
            try:
                manager = (proc / "comm").read_text().strip() in {"systemd", "(sd-pam)", "sshd"}
            except FileNotFoundError:
                continue
            if not foreign_namespace and not manager:
                return True  # Unknown inaccessible processes fail closed.
    return False


def worktrees(repo):
    entries = []
    for block in run("git", "-C", str(repo), "worktree", "list", "--porcelain").stdout.strip().split("\n\n"):
        data = dict(line.partition(" ")[::2] for line in block.splitlines())
        if "worktree" in data:
            entries.append(data)
    return entries


def dependency_paths(path):
    # Do not traverse dependencies or symlinks; only exact node_modules roots.
    for root, dirs, _files in os.walk(path, followlinks=False):
        dirs[:] = [d for d in dirs if d != ".git" and not (Path(root) / d).is_symlink()]
        if "node_modules" in dirs:
            dirs.remove("node_modules")
            yield Path(root) / "node_modules"


def eligible(path, dep, cutoff):
    relative = str(dep.relative_to(path))
    if dep.is_symlink() or not dep.is_dir():
        return False
    if run("git", "-C", str(path), "ls-files", "--", relative).stdout:
        return False
    if run("git", "-C", str(path), "check-ignore", "-q", "--", relative, check=False).returncode != 0:
        return False
    # New installs/builds must cool down even if their task has released its lock.
    latest = dep.stat().st_mtime
    for root, dirs, files in os.walk(dep, followlinks=False):
        for name in dirs + files:
            latest = max(latest, (Path(root) / name).lstat().st_mtime)
            if latest > cutoff:
                return False
    return latest <= cutoff


def maintain(repo, allowed_root, apply=False, idle_hours=6):
    repo, allowed_root = repo.resolve(), allowed_root.resolve()
    if allowed_root == Path("/") or repo == allowed_root:
        raise ValueError("Use a dedicated worktree root, not the repository or filesystem root")
    mounts = container_mounts()
    result = {"apply": apply, "removed": [], "candidates": [], "skipped": [], "reclaimedBytes": 0}
    cutoff = time.time() - idle_hours * 3600
    for entry in worktrees(repo):
        path = Path(entry["worktree"]).resolve()
        if path == repo or not inside(path, allowed_root):
            continue
        reason = None
        if "locked" in entry:
            reason = "git_locked"
        elif any(overlap(path, mount) for mount in mounts):
            reason = "container_bind_mount"
        elif process_uses(path):
            reason = "active_process"
        if reason:
            result["skipped"].append({"path": str(path), "reason": reason})
            continue
        deps = [dep for dep in dependency_paths(path) if eligible(path, dep, cutoff)]
        if not deps:
            continue
        result["candidates"].extend(map(str, deps))
        if not apply:
            continue
        # Never unlock another owner's lock; lock acquisition must succeed first.
        run("git", "-C", str(repo), "worktree", "lock", "--reason", "dependency disk maintenance", str(path))
        try:
            if process_uses(path) or any(overlap(path, m) for m in container_mounts()):
                result["skipped"].append({"path": str(path), "reason": "became_active"})
                continue
            for dep in deps:
                if not eligible(path, dep, cutoff):
                    continue
                blocks = int(run("du", "-s", "-B1", str(dep)).stdout.split()[0])
                shutil.rmtree(dep)
                result["removed"].append(str(dep))
                result["reclaimedBytes"] += blocks
        finally:
            run("git", "-C", str(repo), "worktree", "unlock", str(path))
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True, type=Path)
    parser.add_argument("--worktree-root", required=True, type=Path)
    parser.add_argument("--idle-hours", type=float, default=6)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    if args.idle_hours < 1:
        parser.error("idle-hours must be at least 1")
    print(json.dumps(maintain(args.repo, args.worktree_root, args.apply, args.idle_hours), indent=2))
