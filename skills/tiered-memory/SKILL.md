---
name: tiered-memory
description: Keep agent context small by separating active session notes, compact recent summaries, and durable project knowledge.
---

Use this when loading, writing, or compacting memory.

## Tiers

| Tier | OpenClaw Surface | Load Policy | Contents |
| --- | --- | --- | --- |
| hot | `memory/YYYY-MM-DD.md`, active task artifacts | Always for current work | Current task, last actions, blockers, fresh decisions |
| cold | recent `memory/*.md` summaries | On demand for continuity | Compressed prior sessions, unresolved threads, recent decisions |
| wiki | `MEMORY.md`, repo docs, `TOOLS.md`, stable skills | Selectively | Durable conventions, stable architecture, reusable procedures |

## Writing Policy

- Hot notes are raw and chronological.
- Cold notes should be compressed summaries, not transcripts.
- Wiki entries must be stable, reusable, and safe to expose in the current context.

## Promotion

- End of substantial work: summarize hot notes into the daily memory file.
- Every few days: review daily notes and promote durable lessons into wiki-tier files.
- Remove or correct stale wiki facts when newer work invalidates them.
