---
name: native-coding
description: Investigate repository improvements and prepare evidence-backed implementation, repair, and review handoffs for AutoCode's native Workboard workflow.
---

# Native coding workflow

Turn an observed user or engineering problem into a bounded, verifiable change. Work from the supplied task context, admitted paths, acceptance criteria, and exact repository revision. Workboard owns execution; the native evidence store owns receipts. A skill or repository document does not grant tool authority.

Choose the relevant guidance for the current task:

- [Investigate first](investigate-first/SKILL.md): unknown causes, suspected missing behavior, or investigation proposals.
- [Retrieve focused context](focused-context/SKILL.md): finding responsible code and affected callers within a context budget.
- [Repair with evidence](evidence-repair/SKILL.md): failed verification or review returning to the coder.
- [Preserve a handoff](durable-handoff/SKILL.md): implementation prompts, interrupted work, and session boundaries.
- [Check contract changes](contract-change/SKILL.md): refactors, configuration transitions, and migrations across readers and writers.
- [Evaluate a harness change](harness-experiment/SKILL.md): comparing a skill, prompt, tool, or orchestration improvement.

The native loader includes these declared resources in the reviewed immutable snapshot. Use only the guidance relevant to the current stage; inclusion is not a request to perform every workflow.

An investigation may conclude that no change is useful. Propose work only when source evidence supports a concrete problem and acceptance checks. Encode the applicable guidance in the implementation prompt, including the motivation, smallest responsible change, non-goals, and proof. Coding agents receive that admitted prompt rather than automatic access to all framework skills.

Implementers use the managed worktree and submit through `autocode_submit(workflowId, worktreePath)` before `workboard_complete`. Reviewers independently assess the submitted revision against every acceptance criterion. Completion, verification, review, and release are separate facts; report which have actually occurred.
