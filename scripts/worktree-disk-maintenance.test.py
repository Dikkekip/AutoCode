import importlib.util
from pathlib import Path
import os
import json
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("maintenance", Path(__file__).with_name("worktree-disk-maintenance.py"))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class MaintenanceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.repo = self.root / "repo"
        self.trees = self.root / "trees"
        self.tree = self.trees / "task"
        self.repo.mkdir()
        m.run("git", "init", str(self.repo))
        m.run("git", "-C", str(self.repo), "config", "user.email", "test@example.invalid")
        m.run("git", "-C", str(self.repo), "config", "user.name", "Test")
        (self.repo / ".gitignore").write_text("node_modules/\n")
        (self.repo / "source.txt").write_text("original")
        m.run("git", "-C", str(self.repo), "add", ".")
        m.run("git", "-C", str(self.repo), "commit", "-m", "initial")
        m.run("git", "-C", str(self.repo), "worktree", "add", "-b", "task", str(self.tree))
        self.dep = self.tree / "node_modules"
        self.dep.mkdir()
        (self.dep / "generated").write_text("reinstallable")
        old = time.time() - 48 * 3600
        for path in [self.dep / "generated", self.dep]:
            os.utime(path, (old, old))
        self.receipt = self.root / "window.json"
        self.window = {
            "version": 1, "repository": str(self.repo.resolve()),
            "worktreeRoot": str(self.trees.resolve()), "issuedAt": time.time() - 1,
            "expiresAt": time.time() + 120, "statement": m.WINDOW_STATEMENT,
        }
        self.write_window()
        self.mounts = patch.object(m, "container_mounts", return_value=[])
        self.process = patch.object(m, "process_uses", return_value=False)
        self.mounts.start()
        self.process.start()

    def write_window(self):
        self.receipt.write_text(json.dumps(self.window))
        self.receipt.chmod(0o600)

    def maintain(self, apply=False):
        return m.maintain(self.repo, self.trees, apply=apply, window_receipt=self.receipt)

    def tearDown(self):
        self.mounts.stop()
        self.process.stop()
        self.temp.cleanup()

    def test_preserves_dirty_source_and_unmerged_commits(self):
        (self.tree / "source.txt").write_text("uncommitted important work")
        before = m.run("git", "-C", str(self.tree), "status", "--porcelain").stdout
        report = self.maintain(apply=True)
        self.assertFalse(self.dep.exists())
        self.assertGreater(report["reclaimedBytes"], 0)
        self.assertEqual(before, m.run("git", "-C", str(self.tree), "status", "--porcelain").stdout)
        self.assertNotIn("locked", m.worktrees(self.repo)[1])

    def test_dry_run(self):
        self.assertEqual(self.maintain()["candidates"], [str(self.dep)])
        self.assertTrue(self.dep.exists())

    def test_lock_mount_process_and_recent_install_protected(self):
        with patch.object(m, "container_mounts", return_value=[self.tree]):
            self.assertFalse(self.maintain(True)["removed"])
        with patch.object(m, "process_uses", return_value=True):
            self.assertFalse(self.maintain(True)["removed"])
        m.run("git", "-C", str(self.repo), "worktree", "lock", str(self.tree))
        self.assertFalse(self.maintain(True)["removed"])
        m.run("git", "-C", str(self.repo), "worktree", "unlock", str(self.tree))
        (self.dep / "generated").write_text("recent")
        self.assertFalse(self.maintain(True)["removed"])
        self.assertTrue(self.dep.exists())

    def test_tracked_dependency_and_symlink_protected(self):
        m.run("git", "-C", str(self.tree), "add", "-f", "node_modules/generated")
        self.assertFalse(self.maintain(True)["removed"])
        other = self.tree / "other"
        other.mkdir()
        (other / "node_modules").symlink_to(self.dep)
        self.assertEqual(list(m.dependency_paths(self.tree)), [self.dep])

    def test_docker_failure_aborts(self):
        with patch.object(m, "container_mounts", side_effect=RuntimeError("docker down")):
            with self.assertRaises(RuntimeError):
                self.maintain(True)
        self.assertTrue(self.dep.exists())


    def test_apply_without_window_refuses_before_inspection_or_lock(self):
        with patch.object(m, "container_mounts") as mounts, patch.object(m, "run") as run:
            with self.assertRaisesRegex(ValueError, "requires --operator-window"):
                m.maintain(self.repo, self.trees, apply=True)
            mounts.assert_not_called()
            run.assert_not_called()
        self.assertTrue(self.dep.exists())

    def test_cli_apply_without_window_fails_closed(self):
        result = m.run(sys.executable, str(Path(m.__file__)), "--repo", str(self.repo),
                       "--worktree-root", str(self.trees), "--apply", check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("requires --operator-window", result.stderr)
        self.assertTrue(self.dep.exists())
        self.assertNotIn("locked", m.worktrees(self.repo)[1])

    def test_readonly_private_receipt_is_valid_and_dryrun_needs_no_receipt(self):
        self.receipt.chmod(0o400)
        self.assertEqual(m.maintain(self.repo, self.trees)["candidates"], [str(self.dep)])
        self.assertEqual(self.maintain(True)["removed"], [str(self.dep)])

    def test_invalid_window_never_mutates(self):
        valid = dict(self.window)
        for change in [
            {"version": True}, {"extra": "unknown"}, {"repository": str(self.trees)},
            {"worktreeRoot": str(self.repo)}, {"statement": "not exclusive"},
            {"expiresAt": time.time() - 1}, {"issuedAt": time.time() + 30},
            {"expiresAt": time.time() + 1000}, {"issuedAt": float("nan")},
            {"expiresAt": float("inf")}, {"issuedAt": True},
        ]:
            with self.subTest(change=change):
                self.window = {**valid, **change}
                self.write_window()
                with patch.object(m, "container_mounts") as mounts, patch.object(m, "run") as run:
                    with self.assertRaises(ValueError):
                        self.maintain(True)
                    mounts.assert_not_called()
                    run.assert_not_called()
                self.assertTrue(self.dep.exists())

    def test_unsafe_window_paths_and_permissions_refused(self):
        real = self.receipt
        link = self.root / "symlink.json"
        link.symlink_to(real)
        for path in [link, self.repo / "window.json", self.tree / "window.json"]:
            if path != link:
                path.write_bytes(real.read_bytes())
                path.chmod(0o600)
            with self.subTest(path=path), self.assertRaises(ValueError):
                m.maintain(self.repo, self.trees, True, window_receipt=path)
        real.chmod(0o644)
        with self.assertRaisesRegex(ValueError, "private"):
            self.maintain(True)
        real.chmod(0o600)
        self.root.chmod(0o755)
        with self.assertRaisesRegex(ValueError, "0700"):
            self.maintain(True)
        self.root.chmod(0o700)
        with patch.object(m.os, "getuid", return_value=os.getuid() + 1):
            with self.assertRaisesRegex(ValueError, "owner-controlled"):
                self.maintain(True)
        self.assertTrue(self.dep.exists())

    def test_nonregular_and_malformed_receipts_refused(self):
        self.receipt.unlink()
        os.mkfifo(self.receipt, 0o600)
        with self.assertRaisesRegex(ValueError, "regular file"):
            self.maintain(True)
        self.receipt.unlink()
        self.receipt.write_text("not json")
        self.receipt.chmod(0o600)
        with self.assertRaises(ValueError):
            self.maintain(True)
        self.assertTrue(self.dep.exists())

    def test_expiry_or_replacement_before_delete_preserves_dependencies_and_unlocks(self):
        original_run = m.run
        for replace in [False, True]:
            with self.subTest(replace=replace):
                now = time.time()
                self.window["issuedAt"] = now - 1
                self.window["expiresAt"] = now + 120
                self.write_window()
                clock = [now]
                def run(*args, **kwargs):
                    result = original_run(*args, **kwargs)
                    if args[0] == "du":
                        if replace:
                            self.window["expiresAt"] += 1
                            self.write_window()
                        else:
                            clock[0] += 301
                    return result
                with patch.object(m, "run", side_effect=run), patch.object(m.time, "time", side_effect=lambda: clock[0]):
                    with self.assertRaisesRegex(ValueError, "stale|changed"):
                        self.maintain(True)
                self.assertTrue(self.dep.exists())
                self.assertNotIn("locked", m.worktrees(self.repo)[1])

    def test_valid_window_still_rechecks_new_activity_after_lock(self):
        with patch.object(m, "process_uses", side_effect=[False, True]):
            result = self.maintain(True)
        self.assertEqual(result["removed"], [])
        self.assertEqual(result["skipped"][-1]["reason"], "became_active")
        self.assertTrue(self.dep.exists())
        self.assertNotIn("locked", m.worktrees(self.repo)[1])


if __name__ == "__main__":
    unittest.main()
