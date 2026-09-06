# Loop Engineering Ideas Imported Into OpenClaw

This note tracks Loop Engineering concepts that have been translated into OpenClaw-native surfaces. The goal is to import useful autonomous loop patterns, readiness audits, cost estimation formulas, and loop-focused autonomy skills into the OpenClaw codebase.

## Implemented

- **Loop Autonomy Skills**:
  - `skills/loop-budget/SKILL.md`: Controls token usage and run log spend, enforcing early exit when over budget or no work is actionable.
  - `skills/loop-triage/SKILL.md`: Triages commits, CI/test failures, tickets, and chat threads into prioritized reports.
  - `skills/loop-verifier/SKILL.md`: Defines a strict checker (Maker/Checker split) to run tests and verify diff scopes before approval.
  - `skills/minimal-fix/SKILL.md`: Guides implementers to propose the smallest possible diff addressing only the target issue.
- **Loop Readiness Auditor**: `apps/dispatcher-cli/src/audit.ts` implements `pnpm dispatcher audit` to grade repository state files, skills, configuration, and logs (scoring 0–100 and determining L0–L3 levels).
- **Token Cost Estimator**: `apps/dispatcher-cli/src/cost.ts` implements `pnpm dispatcher cost` to compute simulated daily and monthly token consumption and caps based on cadence and level blend ratios.
- **Patterns Registry**: `packages/domain/src/patterns-registry.ts` houses structured JSON properties of standard loop patterns (PR Babysitter, Daily Triage, CI Sweeper, etc.).
- **Installer Integration**: `apps/dispatcher-cli/src/install.ts` automatically seeds the new loop skills into target repositories under `.openclaw/skills/` during project setup.

## Candidate Follow-Ups

- Feed the results of `pnpm dispatcher audit` directly into the dispatcher `doctor` command.
- Generate an interactive markdown report and graphical representation of readiness scores.
- Allow loading custom local loop patterns in `pnpm dispatcher cost` via a local configuration file.
