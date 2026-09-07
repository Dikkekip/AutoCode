# Verification lanes

Run `pnpm install --frozen-lockfile` with pnpm 10.30.3. Node 22.16.0 is the minimum: native migration imports `backup` from `node:sqlite`, introduced in that patch. CI exercises 22.16.0, 24 and 26. A local pass on another Node version is not evidence that these matrix jobs passed.

| Lane | Command | Scope |
| --- | --- | --- |
| Static checks | `pnpm lint` and `pnpm typecheck` | Formatting, lint and project references |
| Unit/integration | `pnpm test` | Vitest `tests/**/*.test.ts` and `packages/**/*.test.ts` |
| Node tests | `pnpm test:node` | Secret resolver protocol and actual source archive exclusion |
| Built runtime | `pnpm build && pnpm runtime:smoke` | Compiled CLI plus real SQLite discovery, admission, replay, pause and restart; synthetic Gateway |
| Kernel isolation | `NATIVE_TEST_ROOTFS=/opt/native-test-root pnpm exec vitest run tests/native-verification-isolation.test.ts` | Linux Bubblewrap fixture; CI provisions its root |
| Installed contract | `node scripts/native-contract-smoke.mjs <installed-openclaw-root>` | Explicit opt-in disposable stores against an installed Workboard implementation |

The `.spec.ts` Playwright sample under `tests/fixtures/installer/` and `.test.js` sample under `tests/fixtures/profile-repositories/` are fixture input, not framework test lanes. Framework tests exercise their packaging/profile behavior. No account credentials are needed in the default lanes. An unavailable isolation or installed-contract fixture is a documented skip/block, not a successful live integration.

To prevent local user configuration from signing disposable Git fixtures, a local run may use `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false`. `npm_config_ignore_scripts=false` is needed by executable npm lifecycle fixtures. These are per-process overrides; do not modify global Git/npm settings.

# Action and dependency changes

GitHub Actions are pinned to the immutable revisions resolved from the existing v4 tags on 6 September 2026. Update the version comment and commit SHA together after reviewing the upstream release and running the matrix. Pull request checks have only `contents: read`; no release credentials belong in their environment.

Use frozen installs. Review new package lifecycle scripts and license/security reports before approving dependency changes. An unavailable registry or advisory service is unknown, not a clean scan. Do not bypass isolation or enable provider accounts to make CI pass.

# Private state and exports

`.gitattributes` excludes operator identity, memory, application backups and runtime state from `git archive` and GitHub source archives. The archive test checks the real exported path list. Some private-state paths were historically tracked: exclusions do not remove their Git history or make a clone private. Existing operators should relocate these files to a private workspace and review history separately before changing repository visibility. This release does not rewrite repository history or delete local operator files.
