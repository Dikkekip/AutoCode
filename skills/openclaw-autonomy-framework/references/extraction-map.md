# Extraction map from LawyerRAG

This skill is the genericized carve-out of the reusable control-plane ideas that were previously encoded in `LawyerRAG/.openclaw/`.

## Source areas that informed the generic templates

- `LawyerRAG/.openclaw/README.md`
  - became the generic `.openclaw/README.md` template
- `LawyerRAG/.openclaw/agents/*.md`
  - became generic `main`, `planner`, `reviewer`, `promoter` role templates
- `LawyerRAG/.openclaw/jobs/*.json`
  - became reusable recurring job templates
- `LawyerRAG/.openclaw/state/bootstrap/manager_state.json`
  - became generic manager/goals/projects bootstrap state
- `LawyerRAG/.openclaw/state/bootstrap/categories.json`
  - became generic categories/lanes bootstrap state
- `LawyerRAG/.openclaw/state/bootstrap/queue.json`
  - became a starter queue template with reusable concurrency/rotation settings
- `LawyerRAG/.openclaw/state/bootstrap/{notification_config,promotion_policy,runtime,prompt_library,locks,open_prs,promotion_queue}.json`
  - became generic policy/state skeletons

## Intentionally not copied

- `LawyerRAG/.openclaw/state/current/*`
  - live runtime state, lane locks, task history, session history, and mutable evidence
- LawyerRAG-specific repo slug, chat target, allowed paths, verification commands, and product lanes
- LawyerRAG product architecture docs and project-specific coding scripts

## Result

The new skill gives other repos the same control-plane shape without inheriting LawyerRAG's product-specific queue, blockers, live sessions, or notification targets.
