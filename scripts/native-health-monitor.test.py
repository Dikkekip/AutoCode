import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("monitor", Path(__file__).with_name("native-health-monitor.py"))
monitor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(monitor)


class HealthTests(unittest.TestCase):
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
