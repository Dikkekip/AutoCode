# AutoCode contributor guidance

This repository contains an autonomous coding framework built on OpenClaw.

- Runtime code lives in `packages/`; CLI commands live in `apps/dispatcher-cli/`.
- Keep project-specific behavior in `profiles/` and preserve reusable framework boundaries.
- Install dependencies with `pnpm install --frozen-lockfile` (Node >=22.16).
- Run `pnpm typecheck`, focused tests with `pnpm exec vitest run <test-files>`, and `pnpm lint` for relevant changes. `pnpm ci` runs the complete validation pipeline.
- Do not commit credentials, personal notes, runtime state, local backups, or generated build output.
- Use placeholder service endpoints in examples; operators configure their own resources.
- Preserve unrelated work and do not publish or deploy without authorization.
