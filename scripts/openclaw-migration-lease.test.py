#!/usr/bin/env python3
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("lease", Path(__file__).with_name("openclaw-migration-lease.py"))
lease = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lease)


class LeaseRepairTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "package"
        self.receipts = Path(self.tmp.name) / "receipts"
        self.target = self.root / lease.MODULE
        self.target.parent.mkdir(parents=True)
        self.original = b"before\n" + lease.OLD + b" => keepOwnershipChecks();\nafter\n"
        self.target.write_bytes(self.original)
        (self.root / "package.json").write_text(json.dumps({"version": lease.VERSION}))
        self.pin = patch.object(lease, "ORIGINAL_SHA256", lease.digest(self.original))
        self.pin.start()
        self.addCleanup(self.pin.stop)

    def test_roundtrip_changes_only_timeout_and_preserves_private_backup(self):
        self.assertEqual(lease.repair(self.root, self.receipts), "applied")
        self.assertEqual(self.target.read_bytes(), self.original.replace(lease.OLD, lease.NEW))
        self.assertEqual((self.receipts / "original.mjs").stat().st_mode & 0o777, 0o600)
        self.assertEqual(lease.repair(self.root, self.receipts), "already applied")
        self.assertEqual(lease.repair(self.root, self.receipts, True), "restored")
        self.assertEqual(self.target.read_bytes(), self.original)

    def test_other_version_or_build_is_untouched(self):
        (self.root / "package.json").write_text('{"version":"2026.9.7"}')
        with self.assertRaises(ValueError):
            lease.repair(self.root, self.receipts)
        self.assertEqual(self.target.read_bytes(), self.original)
        (self.root / "package.json").write_text(json.dumps({"version": lease.VERSION}))
        self.target.write_bytes(self.original + b"changed")
        with self.assertRaises(ValueError):
            lease.repair(self.root, self.receipts)
        self.assertEqual(self.target.read_bytes(), self.original + b"changed")

    def test_restore_refuses_concurrent_edits_or_corrupt_backup(self):
        lease.repair(self.root, self.receipts)
        patched = self.target.read_bytes()
        self.target.write_bytes(patched + b"another change")
        with self.assertRaises(ValueError):
            lease.repair(self.root, self.receipts, True)
        self.assertEqual(self.target.read_bytes(), patched + b"another change")
        self.target.write_bytes(patched)
        (self.receipts / "original.mjs").write_bytes(b"bad backup")
        with self.assertRaises(ValueError):
            lease.repair(self.root, self.receipts, True)
        self.assertEqual(self.target.read_bytes(), patched)

    def test_ambiguous_calls_are_rejected(self):
        for data in [b"no call", lease.OLD + lease.OLD, lease.NEW]:
            with self.assertRaises(ValueError):
                lease.rewrite(data)


if __name__ == "__main__":
    unittest.main()
