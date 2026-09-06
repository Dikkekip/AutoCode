# OpenClaw State

- `bootstrap/` contains committed seed state: categories, queue defaults, manager goals, notification policy, and promotion policy.
- `current/` contains live mutable state for the autonomous loop and should stay git-ignored.
- Commit only reusable seed state and documentation.
- Do not copy another repository's `current/` runtime artifacts into this project.
