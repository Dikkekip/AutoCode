#!/usr/bin/env python3
"""Explicit, version-pinned workaround for OpenClaw's large-store migration lease."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import tempfile

VERSION = "2026.9.6"
MODULE = "dist/state-migrations.plugin-doctor-DlRpG3T4.mjs"
ORIGINAL_SHA256 = "ae30e1c7318f384f2042cb8c627bcba55aa42a4e2133aac64c87cccc49ef2a53"
OLD = b"withAgentDatabaseMaintenanceLease({ env: params.env }, async (agentLease)"
NEW = b"withAgentDatabaseMaintenanceLease({ env: params.env, leaseMs: 3e5 }, async (agentLease)"


def digest(data):
    return hashlib.sha256(data).hexdigest()


def rewrite(data):
    if data.count(OLD) != 1 or NEW in data:
        raise ValueError("Unexpected migration call; refusing to patch")
    return data.replace(OLD, NEW)


def atomic_write(path, data, mode):
    fd, name = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(name, mode)
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def repair(root, receipts, restore=False):
    root = root.resolve()
    if json.loads((root / "package.json").read_text())["version"] != VERSION:
        raise ValueError("Different OpenClaw version; reassess upstream before patching")
    target = root / MODULE
    if target.is_symlink():
        raise ValueError("Refusing a symlinked module")
    current = target.read_bytes()
    mode = target.stat().st_mode & 0o777
    backup = receipts / "original.mjs"
    receipt = receipts / "receipt.json"
    if restore:
        original = backup.read_bytes()
        if digest(original) != ORIGINAL_SHA256:
            raise ValueError("Backup checksum mismatch")
        patched = rewrite(original)
        if current not in (original, patched):
            raise ValueError("Installed file changed independently; refusing overwrite")
        atomic_write(target, original, mode)
        state = "restored"
    else:
        if digest(current) != ORIGINAL_SHA256:
            if backup.exists() and digest(backup.read_bytes()) == ORIGINAL_SHA256 and current == rewrite(backup.read_bytes()):
                return "already applied"
            raise ValueError("Installed checksum mismatch; refusing unknown build")
        patched = rewrite(current)
        receipts.mkdir(parents=True, exist_ok=True)
        if backup.exists() and backup.read_bytes() != current:
            raise ValueError("Existing backup differs; refusing overwrite")
        atomic_write(backup, current, 0o600)
        # Publish the recovery receipt before changing installed code.
        atomic_write(receipt, json.dumps({"version": VERSION, "module": MODULE,
            "originalSha256": digest(current), "patchedSha256": digest(patched),
            "leaseMs": 300000, "state": "prepared"}, indent=2).encode(), 0o600)
        if target.read_bytes() != current:
            raise ValueError("Installed file changed while preparing; refusing overwrite")
        atomic_write(target, patched, mode)
        state = "applied"
    data = json.loads(receipt.read_text())
    data["state"] = state
    atomic_write(receipt, json.dumps(data, indent=2).encode(), 0o600)
    return state


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package-root", type=Path, required=True)
    parser.add_argument("--receipt-dir", type=Path, required=True)
    parser.add_argument("--restore", action="store_true")
    args = parser.parse_args()
    print(repair(args.package_root, args.receipt_dir, args.restore))


if __name__ == "__main__":
    main()
