---
name: openclaw-autonomy-framework
description: Install a reusable OpenClaw autonomous coding control plane into a project without copying project-specific runtime state. Use when extracting the generic multi-agent framework from one repo into another, setting up reusable `main`/`planner`/`reviewer`/`promoter` prompts, seeding generic goals/projects/categories/jobs under `.openclaw/`, or preparing a coding project for recurring autonomous queue/review/promotion sweeps.
---

Use `scripts/install-control-plane.sh` to install a generic control plane into a target repository.

## Workflow

1. Run the installer with the target repo path and project name.
2. Pass `--repo-slug owner/repo` when GitHub promotion should be preconfigured.
3. Review the generated `.openclaw/state/bootstrap/*.json` files and replace generic lanes, goals, verification hints, and notification targets with project-specific values.
4. Keep `.openclaw/state/current/` runtime-only and git-ignored.
5. Leave project-local coding scripts, product-specific prompts, and installed agents in the destination repo.

## Commands

```bash
# Install into a fresh repo
bash skills/openclaw-autonomy-framework/scripts/install-control-plane.sh \
  --path /path/to/repo \
  --project-name MyProject \
  --repo-slug owner/myproject

# Refresh templates in place
bash skills/openclaw-autonomy-framework/scripts/install-control-plane.sh \
  --path . \
  --project-name MyProject \
  --repo-slug owner/myproject \
  --force
```

## Output

The installer writes:

- `.openclaw/README.md`
- `.openclaw/agents/*.md`
- `.openclaw/jobs/*.json`
- `.openclaw/state/README.md`
- `.openclaw/state/bootstrap/*.json`
- `.gitignore` additions for `.openclaw/state/current/`

## Notes

- The templates are intentionally generic and should be customized after install.
- The generated bootstrap state carries reusable goals/projects/categories, not live task history.
- Do not copy `.openclaw/state/current/` from one product repo to another.
