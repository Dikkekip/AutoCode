# AutoCode

**Autonomous coding workflows built on OpenClaw’s native Workboard, agent sessions, and Automations.**

AutoCode turns repository investigations into scoped implementation work, independent reviews, and evidence-backed application releases. OpenClaw owns scheduling, task claims, worktrees, and sessions. AutoCode adds the project policy, verification rules, review gates, and release evidence.

## How it works

```text
Investigate → Propose → Admit → Implement → Verify → Review → Release
```

- **Investigate:** dedicated research personas inspect committed source and propose improvements with evidence and acceptance criteria.
- **Admit:** the planner checks scope, duplicate work, capacity, and policy before accepting a proposal.
- **Implement:** an assigned coding agent works within the approved scope and submits a candidate revision.
- **Verify and review:** protected checks and an independent reviewer evaluate the exact candidate. Sensitive changes can require design approval; repairs remain bounded.
- **Release:** when the operating mode permits it, release gates check the candidate, required CI, merge, deployment, and representative application workflow. Uncertain external operations remain visible for reconciliation.

Workboard remains the execution owner. AutoCode’s `native-evidence.db` records provenance, verification and review receipts, operation intents, and recovery state. It is not a second task queue.

## Get started

You need Git, pnpm 10.30.3, and Node.js 22.20+ on the 22.x line, or 24.12+. Native operation also requires a compatible OpenClaw installation with Workboard, Automations, and configured agent roles. The documented contract baseline is OpenClaw 2026.9.1; check compatibility with your installed version. Candidate execution requires the supported Linux isolation setup described in the [native reference](docs/native-autonomy.md).

### 1. Build AutoCode

```bash
git clone https://github.com/Dikkekip/AutoCode.git
cd AutoCode
pnpm install --frozen-lockfile
pnpm build
pnpm dispatcher native --help
```

Building does not activate agents. Keep this checkout at a stable path: the linked plugin uses its compiled files.

### 2. Prepare a project

Run from the AutoCode checkout, replacing the application path and base branch:

```bash
pnpm dispatcher native prepare \
  --profile profiles/minimal-repo/profile.json \
  --repository /absolute/path/to/application \
  --base main \
  --out /absolute/path/to/application/.openclaw/native.json
```

This creates a disabled policy with `observe` as the default mode. It does not install the plugin, register agents, or start jobs. Adapt the profile’s paths and verification commands to your application.

### 3. Connect OpenClaw and check readiness

Follow the [getting-started guide](docs/getting-started.md) to register independent roles, link `plugins/autocode`, configure the project policy, and install disabled native automations. Then check readiness:

```bash
pnpm dispatcher native \
  --policy /absolute/path/to/application/.openclaw/native.json \
  --openclaw /absolute/path/to/openclaw doctor
```

Review the policy and resolve readiness failures before enabling it. Activation, operating mode, and automation enablement are separate controls. Application deployment commands and acceptance checks belong to the project; AutoCode does not supply a universal deployment script.

## Choose the operating mode

| Mode | Intended scope |
| --- | --- |
| `observe` | Inspect and observe without authorizing investigations, proposals, or implementation. |
| `propose` | Investigate and develop proposals for review without authorizing implementation. |
| `implement-human-review` | Implement with independent verification and human review. |
| `staging-canary` | Permit bounded staging work with reviewed canary evidence. |
| `application-release` | Permit application releases subject to the configured evidence and approval gates. |

Modes do not bypass scope, budget, authority, or readiness checks. Release modes require measured role capabilities and application-specific evidence. Framework self-release remains subject to human review.

## Operate a project

Run these commands from the AutoCode checkout:

```bash
pnpm dispatcher native --policy /absolute/path/to/application/.openclaw/native.json status
pnpm dispatcher native --policy /absolute/path/to/application/.openclaw/native.json quality
pnpm dispatcher native --policy /absolute/path/to/application/.openclaw/native.json workflow --help
pnpm dispatcher native --policy /absolute/path/to/application/.openclaw/native.json pause
```

Use Workboard to inspect cards and agent sessions. `quality` reports investigation and review outcomes; `workflow` provides explanations and reviewed recovery plans.

**Pause** stops new work while preserving accepted sessions and evidence. **Freeze** additionally cancels owned local commands. Neither proves that an already-sent merge or deployment was cancelled. Resume requires an enabled, reviewed policy and readiness checks. See [pause, freeze, and recovery](docs/native-pause-control.md).

Provider authentication and account selection belong to OpenClaw. Configure your own endpoints and credentials; AutoCode has no built-in Azure resource endpoints. Keep credentials, runtime databases, logs, and operator notes outside Git.

## Documentation

- [Getting started](docs/getting-started.md): project setup, roles, plugin installation, and activation.
- [Native reference](docs/native-autonomy.md): tool contracts, policy, verification, deployment, and migration.
- [Role capability requirements](docs/native-capability-routing.md): measured eligibility for configured native roles.
- [Evidence maintenance](docs/native-evidence-maintenance.md): storage, backup, and retention.
- [Evidence view](docs/native-evidence-view.md): the embeddable, read-only operator view.
- [Implementation status and remaining work](docs/native-implementation-status.md): implemented boundaries, validation results, and deferred work.
- [Framework map](docs/framework-map.md): package responsibilities and project-profile boundaries.

## Development

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:node
pnpm build
pnpm runtime:smoke
```

`pnpm run ci` runs the complete local pipeline. `pnpm deps:licenses` and `pnpm deps:audit` check dependencies. Formatting and validation run explicitly; no Git hooks are installed.

The CLI lives in `apps/dispatcher-cli/`, framework code in `packages/`, project policies in `profiles/`, and reusable agent guidance in `skills/`. Local and controlled-fixture tests establish implementation behavior; they do not certify a production deployment or model effectiveness.

## Migrating from the dispatcher

Existing projects should pause legacy execution, settle active work, and use `native migration plan` and `native migration apply` to transfer eligible state. Native Workboard and the legacy dispatcher must not run as competing execution owners for the same project. Follow the [migration guide](docs/getting-started.md#5-transfer-ownership-and-activate) before cutover.
