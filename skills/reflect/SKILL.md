---
name: reflect
description: Capture in-session lessons after repeated errors, corrective feedback, or failed assumptions so the same session does not repeat the mistake.
---

Use this when a failure or correction should change the next action.

## Trigger Levels

| Level | Trigger | Required Response |
| --- | --- | --- |
| high | Same mistake repeats, user says it is wrong again, or a risky assumption caused damage | Stop, write a reflection, change approach, and escalate if it recurs |
| medium | Tool error after prior warning, misunderstood requirement, or failed verification after a fix | Write a reflection before the next similar action |
| low | First-time minor adjustment with obvious cause | Adjust directly; no formal reflection needed |

## Reflection Entry

Write a short entry in the current working notes or memory file:

```md
## Reflection

- Failed: <what failed>
- Cause: <why it happened>
- Change: <what I will do differently before the next similar action>
```

## Rules

- Check existing reflection entries before repeating the same category of action.
- If a reflected failure happens again, do not keep retrying silently.
- Promote durable lessons to `MEMORY.md`, `AGENTS.md`, `TOOLS.md`, or a relevant skill only when they should affect future sessions.
