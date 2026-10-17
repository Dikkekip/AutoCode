# AutoCode contributor guidance

This repository contains an autonomous coding framework built on OpenClaw.

- Runtime code lives in `packages/`; CLI commands live in `apps/dispatcher-cli/`.
- Keep project-specific behavior in `profiles/` and preserve reusable framework boundaries.
- Install dependencies with `pnpm install --frozen-lockfile` (Node 22.20+ on 22.x, or 24.12+).
- Run `pnpm typecheck`, focused tests with `pnpm exec vitest run <test-files>`, and `pnpm lint` for relevant changes. `pnpm run ci` runs the complete validation pipeline.
- Before pushing a completed candidate, commit the changes and run `pnpm ci:agent` in that clean checkout. Agents own the full CI run, dependency license/advisory checks, diagnosis and bounded repairs. Recommit fixes and rerun against the new SHA; preserve the receipt path in the PR description. GitHub runs a smaller independent merge gate. A local receipt is evidence, not a replacement for required human approval or required GitHub checks. Stop and escalate when the repair budget is exhausted.
- Do not commit credentials, personal notes, runtime state, local backups, or generated build output.
- Use placeholder service endpoints in examples; operators configure their own resources.
- Preserve unrelated work and do not publish or deploy without authorization.
