---
name: openclaw-workspace-bootstrap
description: Create or repair a clean OpenClaw workspace baseline without copying machine-local runtime state. Use when setting up a fresh workspace, rebuilding AGENTS.md/SOUL.md/USER.md/TOOLS.md/IDENTITY.md/HEARTBEAT.md/BOOTSTRAP.md, adding a privacy-friendly .gitignore, or generating a local `.openclaw/workspace-state.json` during bootstrap instead of committing OpenClaw config into git.
---

Use `scripts/bootstrap-workspace.sh` to seed a workspace with the standard baseline files.

## Workflow

1. Run the script with a target path.
2. Use `--with-bootstrap` when the workspace should include the first-run onboarding file.
3. Use `--with-memory` when the workspace should include a blank `MEMORY.md`.
4. Use `--with-workspace-state` only for local runtime initialization; do not commit the generated `.openclaw/workspace-state.json`.
5. Prefer reviewing `git diff` after bootstrapping so local customizations are obvious.

## Commands

```bash
# Initialize a new workspace skeleton
bash skills/openclaw-workspace-bootstrap/scripts/bootstrap-workspace.sh --path /path/to/workspace --with-bootstrap --with-memory

# Recreate missing baseline files without overwriting existing ones
bash skills/openclaw-workspace-bootstrap/scripts/bootstrap-workspace.sh --path .

# Force-refresh templates and generate local runtime state
bash skills/openclaw-workspace-bootstrap/scripts/bootstrap-workspace.sh --path . --force --with-workspace-state
```

## Notes

- The script is idempotent by default: it skips existing files unless `--force` is passed.
- The generated `.gitignore` excludes `MEMORY.md`, `memory/`, and `.openclaw/` so personal notes and local runtime state stay out of git by default.
- Keep repo-specific or personal customizations outside this skill unless they are safe to publish.
