import importlib.util
from pathlib import Path
import os
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
        self.mounts = patch.object(m, "container_mounts", return_value=[])
        self.process = patch.object(m, "process_uses", return_value=False)
        self.mounts.start()
        self.process.start()

    def tearDown(self):
        self.mounts.stop()
        self.process.stop()
        self.temp.cleanup()

    def test_preserves_dirty_source_and_unmerged_commits(self):
        (self.tree / "source.txt").write_text("uncommitted important work")
        before = m.run("git", "-C", str(self.tree), "status", "--porcelain").stdout
        report = m.maintain(self.repo, self.trees, apply=True)
        self.assertFalse(self.dep.exists())
        self.assertGreater(report["reclaimedBytes"], 0)
        self.assertEqual(before, m.run("git", "-C", str(self.tree), "status", "--porcelain").stdout)
        self.assertNotIn("locked", m.worktrees(self.repo)[1])

    def test_dry_run(self):
        self.assertEqual(m.maintain(self.repo, self.trees)["candidates"], [str(self.dep)])
        self.assertTrue(self.dep.exists())

    def test_lock_mount_process_and_recent_install_protected(self):
        with patch.object(m, "container_mounts", return_value=[self.tree]):
            self.assertFalse(m.maintain(self.repo, self.trees, True)["removed"])
        with patch.object(m, "process_uses", return_value=True):
            self.assertFalse(m.maintain(self.repo, self.trees, True)["removed"])
        m.run("git", "-C", str(self.repo), "worktree", "lock", str(self.tree))
        self.assertFalse(m.maintain(self.repo, self.trees, True)["removed"])
        m.run("git", "-C", str(self.repo), "worktree", "unlock", str(self.tree))
        (self.dep / "generated").write_text("recent")
        self.assertFalse(m.maintain(self.repo, self.trees, True)["removed"])
        self.assertTrue(self.dep.exists())

    def test_tracked_dependency_and_symlink_protected(self):
        m.run("git", "-C", str(self.tree), "add", "-f", "node_modules/generated")
        self.assertFalse(m.maintain(self.repo, self.trees, True)["removed"])
        other = self.tree / "other"
        other.mkdir()
        (other / "node_modules").symlink_to(self.dep)
        self.assertEqual(list(m.dependency_paths(self.tree)), [self.dep])

    def test_docker_failure_aborts(self):
        with patch.object(m, "container_mounts", side_effect=RuntimeError("docker down")):
            with self.assertRaises(RuntimeError):
                m.maintain(self.repo, self.trees, True)
        self.assertTrue(self.dep.exists())


if __name__ == "__main__":
    unittest.main()
