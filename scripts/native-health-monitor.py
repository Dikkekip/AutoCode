#!/usr/bin/env python3
"""Read native execution evidence without restarting or changing any work."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time


def summarize(board, status, cards, jobs, now):
    issues = []
    control = status.get("control", {})
    if not status.get("enabled") or control.get("paused") or control.get("frozen"):
        issues.append("native execution disabled, paused, or frozen")
    schedules = []
    for role in ("discover", "dispatch", "reconcile"):
        name = f"autocode:{board}:{role}"
        job = next((j for j in jobs if j.get("name") == name), None)
        if not job:
            issues.append(f"missing schedule: {role}")
            continue
        state = job.get("state", {})
        schedules.append({"role": role, "enabled": job.get("enabled"),
                          "lastRunStatus": state.get("lastRunStatus"),
                          "lastRunAtMs": state.get("lastRunAtMs"),
                          "runningAtMs": state.get("runningAtMs")})
        if not job.get("enabled"):
            issues.append(f"disabled schedule: {role}")
        elif state.get("lastRunStatus") == "error" and not state.get("runningAtMs"):
            issues.append(f"failed schedule: {role}")
        elif not state.get("runningAtMs") and now - (state.get("lastRunAtMs") or 0) > 900_000:
            issues.append(f"schedule has no recent run: {role}")
    active = []
    ready = []
    for card in cards:
        if card.get("status") == "running":
            execution = card.get("execution") or {}
            active.append({"id": card["id"], "title": card.get("title"),
                           "model": execution.get("model"), "runId": execution.get("runId"),
                           "sessionKey": execution.get("sessionKey")})
        elif card.get("status") == "ready":
            ready.append(card["id"])
            if now - card.get("updatedAt", now) > 900_000 and not any(c.get("status") == "running" for c in cards):
                issues.append(f"ready card has waited over 15 minutes without a running worker: {card['id']}")
    workflows = [{"id": w["id"], "title": w.get("title"), "blocker": w.get("blocker")}
                 for w in status.get("workflows", []) if w.get("blocker")]
    return {"observedAtMs": now, "boardId": board,
            "health": "attention" if issues else "observed",
            "issues": issues, "schedules": schedules, "runningCards": active,
            "readyCards": ready, "counts": status.get("counts", {}),
            "blockedWorkflows": workflows,
            "evidenceLimit": "Card running state is not process liveness or proof of successful implementation/release."}


def collect(command, method, params):
    result = subprocess.run([command, "gateway", "call", method, "--json", "--timeout", "30000",
                             "--params", json.dumps(params)], capture_output=True, text=True, timeout=45)
    if result.returncode:
        # Tool errors may contain sensitive provider details; retain only method/code.
        raise RuntimeError(f"{method} failed with exit code {result.returncode}")
    return json.loads(result.stdout)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--openclaw", required=True)
    parser.add_argument("--board", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    now = int(time.time() * 1000)
    try:
        status = collect(args.openclaw, "autocode.status", {"boardId": args.board})
        cards = collect(args.openclaw, "workboard.cards.list", {"boardId": args.board})["cards"]
        jobs = collect(args.openclaw, "cron.list", {"includeDisabled": True})["jobs"]
        report = summarize(args.board, status, cards, jobs, now)
    except (OSError, RuntimeError, subprocess.TimeoutExpired, ValueError, KeyError) as error:
        report = {"observedAtMs": now, "boardId": args.board, "health": "unknown",
                  "issues": [str(error) if isinstance(error, RuntimeError) else type(error).__name__]}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(dir=args.output.parent, prefix=".native-health-")
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(report, stream, indent=2)
            stream.write("\n")
        os.replace(name, args.output)
    finally:
        if os.path.exists(name):
            os.unlink(name)
    print(json.dumps({"health": report["health"], "issues": report["issues"], "output": str(args.output)}))
    return 1 if report["health"] == "unknown" else 0


if __name__ == "__main__":
    raise SystemExit(main())
