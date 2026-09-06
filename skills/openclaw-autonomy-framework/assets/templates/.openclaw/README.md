# __PROJECT_NAME__ OpenClaw Control Plane

This directory is the repo-owned control plane for the autonomous __PROJECT_NAME__ improvement loop.

Tracked surfaces:

- `agents/` - role prompts for `main`, `planner`, `reviewer`, and `promoter`
- `jobs/` - recurring OpenClaw job specs committed with the repo
- `state/bootstrap/` - committed seed state, goals, queue defaults, and policy
- `state/current/` - live mutable runtime state (git-ignored)

Keep project-specific prompts, goals, lanes, and verification commands in this repo.
Do not copy live runtime artifacts from another repo.
