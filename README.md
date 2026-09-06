# AutoCode: autonomous coding framework

This repository contains an autonomous coding framework built on OpenClaw. It turns persona investigations into scoped implementation tasks, independent reviews, and verified application releases. OpenClaw provides the agent sessions and native Workboard/Automations infrastructure; this repository supplies the coding workflow and its quality gates.

The extraction target for AutoAgentClaw is documented in [docs/framework-map.md](docs/framework-map.md). That map names which behaviors are inherited from LawyerRAG, which ideas are borrowed from sibling repos, and which repo-specific behaviors must stay in profiles.

## Native autonomous application coding

The new [native integration](docs/native-autonomy.md) runs persona discovery on Workboard and native Automations, with independent verification, review, and deployment gates. `dispatcher native prepare`, `doctor`, `migration plan/apply`, `status`, and `pause` provide the migration and operator interface. New policies and automations start paused; framework self-release remains subject to human review.

## Start here

- **New users:** follow the [getting-started guide](docs/getting-started.md) to build the framework and prepare a paused project policy.
- **Native operators:** use the [native reference](docs/native-autonomy.md) for configuration, migration, tool contracts, and release checks.
- **Existing dispatcher projects:** the commands below remain the legacy dispatcher path. Native Workboard uses a separate evidence store; do not run both execution owners against the same project.

## Legacy dispatcher quickstart

```bash
pnpm install
pnpm build
pnpm dispatcher init
pnpm dispatcher company create "OpenClaw Labs"
pnpm dispatcher project add "autocode" --repo-path "$PWD"
pnpm dispatcher agent add codex-coder --role "Software Engineer" --adapter codex_local
pnpm dispatcher persona sync-openclaw --project autocode
pnpm dispatcher task create "Improve the CLI UX" --project autocode --label ui
pnpm dispatcher task generate --project autocode --goal-file goal.md
pnpm dispatcher tick
pnpm dispatcher run list
```

If you want the dispatcher to keep advancing its own state until the queue settles, use autonomous mode:

```bash
pnpm dispatcher tick --autonomous
pnpm dispatcher tick --autonomous --caveman
pnpm dispatcher tick --caveman ultra
pnpm dispatcher director cycle --project autocode --autonomous
```

That mode enables per-run self-prompt/self-reflection continuations and repeats dispatcher passes until work drains, blocks, or hits the configured pass limit.

`--caveman` enables full response compression for that command; pass `off`, `lite`, `full`, or `ultra` to select a level or temporarily disable a profile default. Full-cycle queue refresh supports the same override:

```bash
pnpm dispatcher queue-refresh run --project autocode --full-cycle --caveman lite
```

For a durable project default, set the profile policy in `.openclaw/profile.json`:

```json
{
  "responsePolicy": {
    "compressionMode": "full"
  }
}
```

Task labels such as `caveman`, `caveman:ultra`, or `response:off` override the profile for one task. CLI overrides take precedence over agent and profile settings. Compression preserves exact commands, identifiers, errors, and requirements, and explicitly keeps normal prose for security warnings, approvals, irreversible actions, user-facing copy, code, commits, PR text, and structured output. Each run records the selected mode/source plus response characters and actual output tokens in run metadata.

Generated goal items are independent by default so available agents can execute them in parallel. Add an explicit dependency only when a task requires another task's merged code:

```text
Acceptance criteria:
- Add the shared task schema.
- Wire the CLI to the shared task schema. [depends-on: 1]
```

Dependency selectors may use a one-based item number or the exact title/problem text of another generated item. The dispatcher validates the graph before creating any tasks.

Routed runs also receive a durable team assignment. Planner target paths and task changed-file scopes become atomic artifact claims, so non-overlapping tasks can fan out while overlapping work waits before an adapter or worktree starts. Claims are released when a run succeeds, fails, is cancelled, or its lease is recovered.

Inspect current and historical ownership with:

```bash
pnpm dispatcher team assignments --project autocode
pnpm dispatcher team claims --project autocode
pnpm dispatcher team claims --project autocode --status released
pnpm dispatcher team lockouts --project autocode
pnpm dispatcher team inbox --agent codex-coder
```

When review creates a repair or PR-feedback task, the rejected author is locked out of that task's artifact scopes. Routing selects another eligible agent, posts a durable reviewer handoff to its inbox, and clears the lockout after the independent revision succeeds. Inbox messages can be acknowledged with `dispatcher team acknowledge <message-id> --agent <agent>`.

Run linting, formatting, and tests explicitly before committing. CI validates pull requests.

Useful developer-tooling commands:

```bash
pnpm lint
pnpm lint:fix
pnpm format
pnpm format:check
pnpm check
pnpm ci
```

The runtime persists state in `.openclaw/dispatcher.db`.

## Source Citation Middleware

OpenClaw now includes reusable summary citation middleware at `@openclaw/source-citations`.

It extracts the LawyerRAG-style source index normalization, strict citation validation, and structured provenance packaging into a generic wrapper so any LLM summary flow can:

- prepare a canonical source catalog with stable location tags like `[S1@p4-5]`
- force summaries to cite only known source/location pairs
- normalize legacy `[1]` citations into location-aware tags
- emit provenance payloads that map every inline tag back to a verifiable source ref and location

The package exposes `createSourceCitationMiddleware(...)` plus `runSummaryWithSourceCitations(...)` for simple wrapper-based use.

## Planner Loop

OpenClaw now includes a planner-backed `queue-refresh` loop. Instead of only seeding static tasks, the runtime can:

- collect deterministic repo signals such as churn, stale tasks, verification rules, directives, and TODO/FIXME hits
- run the planner persona against that snapshot
- validate structured JSON planner output
- dedupe candidates against queued and recent tasks
- queue new task packages immediately
- persist planner artifacts and events under repo-owned `.openclaw` state

Useful commands:

```bash
corepack pnpm dispatcher queue-refresh run --project autocode
corepack pnpm dispatcher queue-refresh explain --project autocode
corepack pnpm dispatcher planner artifacts --project autocode
corepack pnpm dispatcher status
```

Installed repos now also get an editable planner prompt at `.openclaw/planner/planner.prompt.md`.

## Runtime Identity And Heartbeats

OpenClaw now injects a stable runtime identity envelope into local adapters on every wake, retry, and continuation. That identity is exposed to adapter processes through:

- `OPENCLAW_RUNTIME_IDENTITY_JSON`
- `OPENCLAW_RUNTIME_KEY`
- `OPENCLAW_EXECUTION_KEY`
- `OPENCLAW_WAKE_REASON`
- `OPENCLAW_SESSION_KEY`

The payload keeps two identifiers separate:

- `runtimeKey`: stable continuation identity for the task/agent/project session
- `executionKey`: per-run execution identity for tracing, retries, and audits

Execution sweeps mark runs with `execution_sweep` wake metadata so operator tooling can distinguish heartbeat-driven work from manual dispatch.

## Embeddings / Memory Env

If you enable memory embeddings, prefer the dedicated embedding env names so local coder agents do not inherit Azure/OpenAI-compatible base URLs by accident:

```bash
EMBEDDING_OPENAI_BASE_URL=https://your-endpoint/openai/v1/
EMBEDDING_OPENAI_EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_AZURE_OPENAI_API_KEY=replace-me
```

Legacy `OPENAI_*` variables still work as fallback for embeddings, but they may leak into downstream CLIs such as Codex if you also use them for local agent execution.

## Install the legacy dispatcher into another repo

If you want to adopt this framework for an existing project, bootstrap that target repo with:

```bash
bash scripts/install-dispatcher.sh /path/to/target-repo
```

You can also call the installer directly:

```bash
pnpm build
node apps/dispatcher-cli/dist/index.js install /path/to/target-repo
```

That installer will:

- create `.openclaw/agents/` instruction templates for `codex` and `gemini`
- seed the repo-owned autonomy scaffold from `skills/openclaw-autonomy-framework/` for `main`/`planner`/`reviewer`/`promoter`
- seed `.openclaw/planner/planner.prompt.md` plus planner policy defaults from the selected profile
- create repo-local launcher scripts at `.openclaw/bin/dispatcher` and `scripts/openclaw-dispatcher.sh`
- initialize `.openclaw/dispatcher.db`
- create the initial company, project, and default agents
- append safe runtime ignores to the target repo `.gitignore`
- auto-detect a reasonable verify command when possible

The autonomy scaffold is installed as create-only repo-owned state by default, so existing `.openclaw` policies keep winning unless you explicitly force a refresh.

After install, teammates can stay inside the target repo:

```bash
cd /path/to/target-repo
./scripts/openclaw-dispatcher.sh doctor
./scripts/openclaw-dispatcher.sh task create "Tighten onboarding copy" --project "target-repo"
./scripts/openclaw-dispatcher.sh tick
```

If the original framework checkout moves, point the wrapper at the new location with `OPENCLAW_DISPATCHER_FRAMEWORK_DIR=/path/to/autocode`.

Example with explicit naming:

```bash
bash scripts/install-dispatcher.sh /path/to/target-repo \
  --company-name "Acme AI" \
  --project-name "acme-web" \
  --codex-name "acme-coder" \
  --gemini-name "acme-ui"
```

Example with explicit tool/model lanes:

```bash
bash scripts/install-dispatcher.sh /path/to/target-repo \
  --tools codex,gemini,foundry \
  --codex-model gpt-5.4-mini \
  --gemini-model gemini-2.5-pro \
  --foundry-model Kimi-K2.6
```

`foundry` installs an Azure Foundry/Kimi planning and review agent. Configure Foundry credentials with the adapter env vars, for example `OPENCLAW_AZURE_FOUNDRY_ENDPOINTS` plus `OPENCLAW_AZURE_FOUNDRY_API_KEY`.

## Native OpenClaw agents and provider accounts

Dispatcher execution uses OpenClaw v2 native sessions by default. Runtime persona ids map to named OpenClaw agents, each run is visible in the OpenClaw session list, and independent subtasks can fan out through native `sessions_spawn` handoffs. Provision or refresh the persona workspaces after installing a profile or changing runtime personas:

```bash
pnpm dispatcher persona sync-openclaw --project autocode --dry-run
pnpm dispatcher persona sync-openclaw --project autocode
openclaw agents list --json
openclaw models status --json
```

The dispatcher can orchestrate these named sessions without modifying subagent authorization. If the operator also wants `sessions_spawn` handoffs, review and explicitly apply the least-privilege controller/reviewer graph with `persona sync-openclaw --project <ref> --enable-handoffs`.

Account selection, cooldowns, and quota fallback are owned by OpenClaw's provider profile store. When a native turn rejects an unavailable model, the dispatcher tries the compatible model ladder (Astra → Sol → Terra → Luna → legacy models). Other native execution failures are not replayed through that ladder. Dispatcher code does not switch `~/.codex/auth.json` or launch a standalone Codex process in the default path. `OPENCLAW_CODEX_TRANSPORT=direct` is an explicit rollback mode for diagnosing older installations; it retains the legacy ACPX/account-switcher implementation but should not be enabled for normal operation.

### Task complexity and persona ideation

Codex routing selects both a model and reasoning effort. Complexity below 35 with value below 35 uses GPT-5.6 Luna for small implementation work; routine implementation uses Terra. Complexity of 70–89, high importance, or sensitive high-value work uses Sol with high reasoning. Complexity of 90 or more uses `gpt-6-astra` with high reasoning; complexity and value both at least 92 use Astra with max reasoning. Explicit budget tasks keep Terra, and preserved-commit recovery keeps its bounded Sol policy. Provider and explicit assignment rules continue to apply. The route records scores, rationale, and estimated cost.

Set `planner.costPolicy.preferredPlannerModel` to `auto` to scale persona planning across Terra, Sol, and Astra at complexity boundaries 70 and 90. The built-in LawyerRAG profile enables this. Existing installed profiles with a model pin keep that pin until changed. Planning scope is scored from changed files, lane hotspots, stale tasks, and directives; explicit model preferences and non-Codex provider compatibility remain respected.

Persona ideation compares distinct alternatives through domain, maintainer, and verification perspectives. Candidates should record decisive repository evidence, rejected alternatives, invariants, and a before/after acceptance observation, while rotating underrepresented personas. Model-proposed implementation complexity is separate from user value and prompt length. These are prompt quality requirements, not proof that an idea is correct; existing validation, deduplication, review, and execution gates still apply.

Provider profile files contain secrets. Inspect them only through OpenClaw commands and do not commit or copy their contents into dispatcher logs.

Dispatcher surfaces for usage-limit awareness:

```bash
corepack pnpm dispatcher quota status
corepack pnpm dispatcher budget status
corepack pnpm dispatcher status
```

`quota status` reads cached multi-account Codex headroom and recommends a safe Codex concurrency level. The executor also uses that cached headroom to defer Codex work when all saved accounts are exhausted, instead of waiting for hard quota failures on every run.

The planner loop uses the same quota view. When Codex headroom is degraded, OpenClaw reduces planner-created work volume and can fall back to the profile’s planner adapter preference.
