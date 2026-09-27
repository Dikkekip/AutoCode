import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("monitor", Path(__file__).with_name("native-health-monitor.py"))
monitor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(monitor)


class HealthTests(unittest.TestCase):
    def test_running_research_does_not_hide_a_fully_blocked_pipeline(self):
        now = 2_000_000
        jobs = [{"name": f"autocode:demo:{r}", "enabled": True,
                 "state": {"lastRunAtMs": now, "lastRunStatus": "ok"}}
                for r in ("discover", "dispatch", "reconcile")]
        status = {"enabled": True, "workflows": [
            {"id": "w", "blocker": "stale receipt", "candidateSha": "abc", "verifiedSha": "abc"}]}
        report = monitor.summarize("demo", status, [{"id": "research", "status": "running"}], jobs, now)
        self.assertEqual(report["health"], "attention")
        self.assertIn("all unfinished workflows are blocked", report["issues"][0])
        self.assertEqual(report["pipeline"], {"candidates": 1, "verified": 1, "merged": 0, "deployed": 0})

    def test_detects_stranded_coding_but_allows_reconciler_verification(self):
        now = 2_000_000
        jobs = [{"name": f"autocode:demo:{r}", "enabled": True,
                 "state": {"lastRunAtMs": now, "lastRunStatus": "ok"}}
                for r in ("discover", "dispatch", "reconcile")]
        workflow = {"id": "w", "lifecycle": {"state": "implementation"}}
        status = {"enabled": True, "workflows": [workflow]}
        self.assertEqual(monitor.summarize("demo", status, [], jobs, now)["health"], "attention")
        workflow["lifecycle"]["state"] = "verification"
        self.assertEqual(monitor.summarize("demo", status, [], jobs, now)["health"], "observed")

    def test_runtime_pending_cannot_be_hidden_by_running_cards(self):
        now = 2_000_000
        jobs = [{"name": f"autocode:demo:{r}", "enabled": True,
                 "state": {"lastRunAtMs": now, "lastRunStatus": "ok"}}
                for r in ("discover", "dispatch", "reconcile")]
        cards = [{"id": "coder", "status": "running"}]
        gateway = {"modelRuntime": {"degraded": False, "pendingAgents": ["coder"]}}
        result = monitor.summarize("demo", {"enabled": True}, cards, jobs, now, gateway)
        self.assertEqual(result["health"], "attention")
        self.assertIn("pending preparation", result["issues"][0])
        gateway["modelRuntime"] = {"degraded": False, "pendingAgents": []}
        gateway["workerPools"] = {"modelCatalog": {"activeTasks": 1, "pendingTasks": 1}}
        result = monitor.summarize("demo", {"enabled": True}, cards, jobs, now, gateway)
        self.assertEqual(result["health"], "observed")
        self.assertEqual(result["gateway"]["modelCatalog"]["pendingTasks"], 1)

    def test_optional_startup_projection_is_an_evidence_gap(self):
        now = 2_000_000
        jobs = [{"name": f"autocode:demo:{r}", "enabled": True,
                 "state": {"lastRunAtMs": now, "lastRunStatus": "ok"}}
                for r in ("discover", "dispatch", "reconcile")]
        # Actual 2026.9.6 status shape after config publication: startup
        # projection omitted, while worker pool facts remain present.
        gateway = {"runtimeVersion": "2026.9.6", "workerPools": {
            "modelCatalog": {"activeTasks": 1, "pendingTasks": 1}}}
        result = monitor.summarize("demo", {"enabled": True}, [], jobs, now, gateway)
        self.assertEqual(result["health"], "observed")
        self.assertFalse(result["gateway"]["modelRuntimeReported"])
        self.assertIsNone(result["gateway"]["modelRuntime"])
        self.assertIn("unreported readiness", result["evidenceLimit"])
        gateway["modelRuntime"] = {"degraded": True, "pendingAgents": []}
        result = monitor.summarize("demo", {"enabled": True}, [], jobs, now, gateway)
        self.assertEqual(result["health"], "attention")
        self.assertTrue(result["gateway"]["modelRuntimeReported"])

    def test_green_schedules_do_not_hide_stalled_work(self):
        now = 2_000_000
        jobs = [{"name": f"autocode:demo:{r}", "enabled": True,
                 "state": {"lastRunAtMs": now, "lastRunStatus": "ok"}}
                for r in ("discover", "dispatch", "reconcile")]
        result = monitor.summarize("demo", {"enabled": True},
                                   [{"id": "stalled", "status": "ready", "updatedAt": 1}], jobs, now)
        self.assertEqual(result["health"], "attention")
        self.assertIn("stalled", result["issues"][0])

    def test_waiting_planner_is_visible_after_interrupted_research(self):
        now = 2_000_000
        jobs = [{"name": f"autocode:demo:{r}", "enabled": True,
                 "state": {"lastRunAtMs": now, "lastRunStatus": "ok"}}
                for r in ("discover", "dispatch", "reconcile")]
        cards = [{"id": "planner", "status": "todo", "updatedAt": 1},
                 {"id": "research", "status": "blocked", "updatedAt": 1}]
        result = monitor.summarize("demo", {"enabled": True}, cards, jobs, now)
        self.assertEqual(result["waitingCards"], ["planner"])
        self.assertEqual(result["health"], "attention")
        self.assertIn("todo card", result["issues"][0])
        cards[1]["status"] = "running"
        self.assertEqual(monitor.summarize("demo", {"enabled": True}, cards, jobs, now)["issues"], [])

    def test_long_running_schedule_is_not_failed_due_to_old_error(self):
        jobs = [{"name": f"autocode:demo:{r}", "enabled": True,
                 "state": {"lastRunAtMs": 1, "lastRunStatus": "error", "runningAtMs": 1}}
                for r in ("discover", "dispatch", "reconcile")]
        result = monitor.summarize("demo", {"enabled": True}, [], jobs, 2_000_000)
        self.assertEqual(result["issues"], [])
        self.assertEqual(result["health"], "observed")

    def test_disabled_missing_and_stale_schedules_are_visible(self):
        jobs = [{"name": "autocode:demo:dispatch", "enabled": False},
                {"name": "autocode:demo:reconcile", "enabled": True, "state": {"lastRunAtMs": 1}}]
        result = monitor.summarize("demo", {"enabled": True}, [], jobs, 2_000_000)
        self.assertEqual(len(result["issues"]), 3)


if __name__ == "__main__":
    unittest.main()
