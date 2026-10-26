import importlib.util
import os
import re
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("adapter", Path(__file__).with_name("native-release-adapter.py"))
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


class ReleaseAdapterTests(unittest.TestCase):
    def fixture(self):
        instance = adapter.Adapter.__new__(adapter.Adapter)
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        instance.c = {"targetId": "isolated-test", "releaseLock": str(Path(directory.name) / "release.lock")}
        instance.legacy = Mock(spec=["live_revision", "assert_deployments", "application_workflow"])
        instance.legacy.live_revision.return_value = {"sha": "a" * 40}
        manifest = {"revision": "a" * 40, "tag": "v1.0.0", "images": {}}
        instance.load = Mock(return_value=manifest)
        instance.assert_running_images = Mock()
        return instance, manifest

    def prepare_fixture(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        instance = adapter.Adapter.__new__(adapter.Adapter)
        instance.root = Path(directory.name) / "state"
        instance.root.mkdir()
        instance.source = Path(directory.name)
        instance.c = {"targetId": "isolated-test", "minimumBuildFreeGiB": 1}
        instance.legacy = Mock()
        instance.legacy.ROOT = Path(directory.name)
        instance.legacy.REPO = "example/project"
        instance.legacy.SEMVER = re.compile(r"v(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?")
        instance.legacy.git.return_value = ""
        instance.legacy.live_revision.return_value = {"sha": "b" * 40}
        instance.stage = Mock()
        instance.manifest = Mock(side_effect=lambda sha, tag: {"revision": sha, "tag": tag, "images": {}})
        return instance

    def test_prepare_preserves_unpublished_local_staging_tag_and_stages_next_patch(self):
        instance = self.prepare_fixture()
        commands = []
        def command(argv, **kwargs):
            commands.append(argv)
            if argv[:3] == ["gh", "release", "list"]:
                return json.dumps([{"tagName": "v3.0.26", "isDraft": False, "isPrerelease": False}])
            if argv[:3] == ["docker", "image", "ls"]:
                return "lawyerrag/backend:v3.0.27\nlawyerrag/reports-ui:v3.0.27"
            return ""
        with patch.object(adapter, "run", side_effect=command), \
             patch.object(adapter.shutil, "disk_usage", return_value=Mock(free=2*1024**3)), \
             patch.object(adapter.subprocess, "run", return_value=Mock(returncode=1)):
            result = instance.prepare("a" * 40)
        self.assertTrue(result["staged"])
        self.assertEqual(instance.stage.call_args.args[0]["tag"], "v3.0.28")
        tags = [argv for argv in commands if argv[:2] == ["docker", "tag"]]
        self.assertEqual([argv[-1] for argv in tags], ["lawyerrag/backend:v3.0.28", "lawyerrag/reports-ui:v3.0.28"])
        self.assertEqual(json.loads((instance.root / "manifests" / ("a"*40 + ".json")).read_text())["tag"], "v3.0.28")
        self.assertFalse(any("v3.0.27" in str(argv) for argv in tags))

    def test_prepare_accounts_for_partial_reservation_and_ignores_other_repositories(self):
        instance = self.prepare_fixture()
        def command(argv, **kwargs):
            if argv[:3] == ["gh", "release", "list"]:
                return json.dumps([{"tagName": "v3.0.26", "isDraft": False, "isPrerelease": False}])
            if argv[:3] == ["docker", "image", "ls"]:
                return "lawyerrag/reports-ui:v3.0.28\nother/backend:v3.0.999\nlawyerrag/backend:v4.0.999\nlawyerrag/backend:<none>"
            return ""
        with patch.object(adapter, "run", side_effect=command), \
             patch.object(adapter.shutil, "disk_usage", return_value=Mock(free=2*1024**3)), \
             patch.object(adapter.subprocess, "run", return_value=Mock(returncode=1)):
            instance.prepare("a" * 40)
        self.assertEqual(instance.stage.call_args.args[0]["tag"], "v3.0.29")

    def test_prepare_requires_local_reservation_inventory_before_build(self):
        instance = self.prepare_fixture()
        def command(argv, **kwargs):
            if argv[:3] == ["gh", "release", "list"]:
                return json.dumps([{"tagName": "v3.0.26", "isDraft": False, "isPrerelease": False}])
            raise RuntimeError("Docker inventory unavailable")
        with patch.object(adapter, "run", side_effect=command) as run, \
             patch.object(adapter.shutil, "disk_usage", return_value=Mock(free=2*1024**3)):
            with self.assertRaisesRegex(RuntimeError, "inventory unavailable"):
                instance.prepare("a" * 40)
        instance.stage.assert_not_called()
        instance.manifest.assert_not_called()
        self.assertFalse(any(call.args[0][:2] == ["docker", "compose"] for call in run.call_args_list))

    def test_prepare_refuses_racing_tag_without_manifest_or_staging(self):
        instance = self.prepare_fixture()
        def command(argv, **kwargs):
            if argv[:3] == ["gh", "release", "list"]:
                return json.dumps([{"tagName": "v3.0.26", "isDraft": False, "isPrerelease": False}])
            return ""
        with patch.object(adapter, "run", side_effect=command) as run, \
             patch.object(adapter.shutil, "disk_usage", return_value=Mock(free=2*1024**3)), \
             patch.object(adapter.subprocess, "run", return_value=Mock(returncode=0)):
            with self.assertRaisesRegex(RuntimeError, "refusing overwrite"):
                instance.prepare("a" * 40)
        instance.stage.assert_not_called()
        self.assertFalse((instance.root / "manifests" / ("a"*40 + ".json")).exists())
        self.assertFalse(any(call.args[0][:2] == ["docker", "tag"] for call in run.call_args_list))

    def test_settled_workflow_regression_is_negative_health_not_unknown_success(self):
        instance, manifest = self.fixture()
        instance.legacy.application_workflow.side_effect = RuntimeError("broken navigation")
        result = instance.check("a" * 40, adapter.digest(manifest))
        self.assertFalse(result["healthy"])
        self.assertFalse(result["workflowPassed"])
        self.assertEqual(result["rolloutState"], "settled")

    def test_wrong_identity_never_authorizes_rollback_from_negative_health(self):
        instance, manifest = self.fixture()
        instance.legacy.live_revision.return_value = {"sha": "b" * 40}
        with self.assertRaisesRegex(RuntimeError, "revision"):
            instance.check("a" * 40, adapter.digest(manifest))
        instance.legacy.application_workflow.assert_not_called()

    def test_target_change_during_health_observation_stays_unknown(self):
        instance, manifest = self.fixture()
        instance.legacy.live_revision.side_effect = [{"sha": "a" * 40}, {"sha": "b" * 40}]
        with self.assertRaisesRegex(RuntimeError, "changed"):
            instance.check("a" * 40, adapter.digest(manifest))

    def test_tampered_artifact_does_not_run_production_observation(self):
        instance, _ = self.fixture()
        with self.assertRaisesRegex(RuntimeError, "artifact"):
            instance.check("a" * 40, "b" * 64)
        instance.legacy.live_revision.assert_not_called()

    def test_retagged_release_is_rejected_before_use(self):
        with tempfile.TemporaryDirectory() as directory:
            instance = adapter.Adapter.__new__(adapter.Adapter)
            instance.root = Path(directory)
            manifest = {"revision": "a" * 40, "tag": "v1.0.0", "images": {"backend": "original"}}
            adapter.save(instance.root / "manifests" / ("a" * 40 + ".json"), manifest)
            instance.manifest = Mock(return_value={**manifest, "images": {"backend": "replaced"}})
            with self.assertRaisesRegex(RuntimeError, "identity changed"):
                instance.load("a" * 40)

    def test_configured_build_minimum_reaches_legacy_deployment_and_is_restored(self):
        instance, manifest = self.fixture()
        instance.root = Path(instance.c["releaseLock"]).parent
        instance.c["minimumBuildFreeGiB"] = 5
        sha = "a" * 40
        artifact = adapter.digest(manifest)
        adapter.save(instance.root / "staging" / (sha + ".json"), {"passed": True, "artifactSha256": artifact})
        before = os.environ.get("MIN_RELEASE_FREE_GIB")
        seen = []
        instance.legacy = Mock()
        instance.legacy.deploy.side_effect = lambda _: seen.append(os.environ.get("MIN_RELEASE_FREE_GIB"))
        instance.check = Mock(return_value={"healthy": True})
        self.assertEqual(instance.deploy(sha, artifact), {"healthy": True})
        self.assertEqual(seen, ["5"])
        self.assertEqual(os.environ.get("MIN_RELEASE_FREE_GIB"), before)
        instance.legacy.deploy.side_effect = RuntimeError("deployment failed")
        with self.assertRaisesRegex(RuntimeError, "deployment failed"):
            instance.deploy(sha, artifact)
        self.assertEqual(os.environ.get("MIN_RELEASE_FREE_GIB"), before)

    def test_build_minimum_remains_positive_and_defaults_to_existing_policy(self):
        instance, _ = self.fixture()
        self.assertEqual(instance.minimum_free_gib, 30)
        for value in [0, -1, False, "5"]:
            instance.c["minimumBuildFreeGiB"] = value
            with self.assertRaisesRegex(RuntimeError, "positive integer"):
                _ = instance.minimum_free_gib


if __name__ == "__main__":
    unittest.main()
