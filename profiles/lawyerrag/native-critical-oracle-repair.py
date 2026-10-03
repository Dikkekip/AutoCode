#!/usr/bin/env python3
"""Patch one reviewed asynchronous assertion in the pinned critical UI oracle."""

import hashlib
import os
from pathlib import Path


ORACLE = Path("/opt/openclaw/fixtures/critical-review/BundleDetail.test.tsx")
INSTALLER = Path("/opt/openclaw/checks/install-critical-fixture-oracles.py")


def replace_pinned(path: Path, old_hash: str, replacements: list[tuple[str, str]], new_hash: str, mode: int) -> None:
    original = path.read_bytes()
    if hashlib.sha256(original).hexdigest() != old_hash:
        raise SystemExit(f"Reviewed critical fixture changed: {path}")
    text = original.decode("utf-8")
    for old, new in replacements:
        if text.count(old) != 1:
            raise SystemExit(f"Expected one reviewed fixture field in {path}: {old[:40]}")
        text = text.replace(old, new, 1)
    result = text.encode("utf-8")
    if hashlib.sha256(result).hexdigest() != new_hash:
        raise SystemExit(f"Unexpected patched critical fixture digest: {path}")
    os.chmod(path, 0o600)
    path.write_bytes(result)
    os.chmod(path, mode)


replace_pinned(
    ORACLE,
    "078b0acaab09aff9564e143c6f887bb2cc06cb2f387018e3189d9d2e89488eae",
    [
        (
            "    expect(targetRow).toHaveTextContent(\n"
            "      /chronology source review match: previously checked source evidence/i,\n"
            "    );",
            "    await waitFor(() => expect(targetRow).toHaveTextContent(\n"
            "      /chronology source review match: previously checked source evidence/i,\n"
            "    ));",
        )
    ],
    "3d7ff3a596c6a787cc2a6b23ba616787ff58e4d5fd46a00e1e49a3d1418e70dc",
    0o444,
)
replace_pinned(
    INSTALLER,
    "49ce22c067a7c3c97246351bd3bf7ac4d59c43139696b89554ad9ab7e4efee07",
    [
        (
            "'oracleSha256': '078b0acaab09aff9564e143c6f887bb2cc06cb2f387018e3189d9d2e89488eae'",
            "'oracleSha256': '3d7ff3a596c6a787cc2a6b23ba616787ff58e4d5fd46a00e1e49a3d1418e70dc'",
        ),
        (
            "'oracleBlob': '5c82f6c854b14ab6e4d0f13da6b4808996f8c658'",
            "'oracleBlob': '978330f2be52ba776dbb74aea12e12663017eb7a'",
        ),
        (
            "'allowedInputs': {'77bc1d397dff50602a96151fb9435e0febf77ea205a50ac5b1e692ff588036ef'",
            "'allowedInputs': {'7cc40c9457f63da2c2fb376288ba73948f7341b31fbb8abb63246ee7ac6be4c3': '6b5d1abb17322029c131a6e5f20e5957d0d9559e', '77bc1d397dff50602a96151fb9435e0febf77ea205a50ac5b1e692ff588036ef'",
        ),
    ],
    "961d40f80319ec68804b5df149e1416e970fbf56c2592d62fab6391727df5e0c",
    0o555,
)
