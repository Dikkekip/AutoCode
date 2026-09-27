import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

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


if __name__ == "__main__":
    unittest.main()
