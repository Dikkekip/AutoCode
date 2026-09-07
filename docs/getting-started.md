# Getting started with AutoCode

AutoCode is an autonomous coding framework built on OpenClaw. Personas investigate improvements, a planner selects useful work, and separate implementation and review stages produce evidence before release.

This guide covers the native quality workflow. Start with a paused project policy and validate the workflow before enabling autonomous execution.

## 1. Build without activating agents

You need Git, pnpm 10.30.3, and a Node version supported by both the framework and your OpenClaw installation. The framework requires Node 22.20+ on 22.x, or 24.12+ (matching the locked Linux build dependencies); OpenClaw can impose stricter requirements. Native contracts were checked against OpenClaw 2026.9.1.

~~~bash
git clone https://github.com/Dikkekip/AutoCode.git
cd AutoCode
git checkout master
pnpm install --frozen-lockfile
pnpm build
pnpm dispatcher native --help
~~~

These commands do not start a coding loop. Keep the checkout at a stable path because the plugin references its built files. Run the complete repository checks with:

~~~bash
pnpm run ci
~~~

Native execution uses Workboard and native-evidence.db. Existing dispatcher projects must transfer ownership before activation; do not enable both execution owners for one project.

## 2. Prepare a paused project policy

Start with a Git repository whose default branch has an origin tracking ref. This example assumes a pnpm application with src/, tests/, and a working pnpm test command. Adjust the profile for another layout.

Run from the framework checkout, replacing the application path and branch:

~~~bash
pnpm dispatcher native prepare \
  --profile profiles/minimal-repo/profile.json \
  --repository /absolute/path/to/application \
  --base main \
  --out /absolute/path/to/application/.openclaw/native.json
~~~

Preparation refuses to overwrite an existing file. It creates a disabled policy; it does not register agents, install the plugin, or start jobs. The minimal profile has one persona, pm-general. Larger profiles rotate up to three personas per round by default.

Review the generated JSON:

| Setting | What to configure |
| --- | --- |
| boardId | A unique Workboard board for this project; initially the profile ID. |
| repository, baseBranch | The development repository and its actual default branch. |
| personas | Goals, success observations, owned paths, weights, and custom ideationPrompt briefs. |
| quality.skillPath | A readable absolute path to prompt-engineering-expert/SKILL.md. |
| verification | Host-run commands covering permitted changes. Replace the sample pnpm test when necessary. |
| plannerAgentId, coderAgentId, reviewerAgentId | Registered roles; the reviewer must differ from the coder. |
| workerConcurrency | Keep one during the pilot. |
| deployment | Deployment and application-workflow verification commands; initially null. |

For an existing dispatcher project, use its .openclaw/profile.json as input. Conversion preserves persona instructions and lane rules but does not migrate task state. Policies without a quality object retain the earlier native behavior.

## 3. Register roles and load the plugin

Use your installed OpenClaw's supported agent/configuration commands. Inspect registered roles with:

~~~bash
openclaw agents list --json
~~~

For each persona, register the dedicated investigationAgentId from the policy. For the minimal profile this is native-research-pm-general. Preserve the intended persona mission and existing model selection. Give research roles only this tool configuration:

~~~json
{
  "tools": {
    "allow": [
      "autocode_context",
      "autocode_inspect",
      "autocode_propose",
      "autocode_investigation_finish",
      "workboard_complete",
      "workboard_heartbeat"
    ]
  }
}
~~~

Do not add shell, editing, spawning, alsoAllow, or provider-specific overrides. Research runs in scratch workspaces and reads committed files through the inspection tool. Readiness checks inspect these permissions.

The planner needs proposal, admission, and deferral tools. The coder needs autocode_submit. The reviewer needs autocode_design_review and autocode_review. All worker roles need native completion/heartbeat tools. See the [native tool reference](native-autonomy.md#plugin-and-native-scheduling).

After reviewing the plugin source and host access, install from the stable checkout:

~~~bash
openclaw plugins install --link /absolute/path/to/autocode/plugins/autocode
openclaw plugins enable workboard
~~~

OpenClaw may request local-source trust and persistent capability consent. Resolve those through its supported approval flow. A local plugin runs with the OpenClaw user's host access; a disabled project policy is not a sandbox for the plugin itself.

Include workboard and autocode in plugins.allow, preserving other plugins. Set plugins.entries.autocode.enabled to true and its config to:

~~~json
{
  "projects": ["/absolute/path/to/application/.openclaw/native.json"],
  "openclawCommand": "/absolute/path/to/openclaw"
}
~~~

Use the absolute active executable. Apply changes through supported OpenClaw configuration commands and reload the gateway using your installation's service procedure. Leave the project policy disabled until readiness is complete.

## 4. Configure release proof

The deployment adapter receives AUTOCODE_SHA, AUTOCODE_WORKFLOW_ID, and AUTOCODE_REPOSITORY. It must deploy that exact merged commit through the application's established release mechanism.

The independent check must verify the running revision and exercise an application workflow. Its stdout must contain only this JSON shape:

~~~json
{"deployedSha":"<full merged commit SHA>","workflowPassed":true}
~~~

Send diagnostic logs to stderr. Health endpoints alone do not satisfy this contract. A document application might ingest a synthetic PDF into a dedicated test matter and verify the resulting document is usable. Configure fixture cleanup; do not default to real user records.

Commands use structured argv, a repository-contained cwd, and a timeout. See the [deployment interface](native-autonomy.md#prepare-and-inspect). Builds, release tags, and workflow fixtures belong to the application profile; there is no universal deployment command.

~~~bash
pnpm dispatcher native \
  --policy /absolute/path/to/application/.openclaw/native.json \
  --openclaw /absolute/path/to/openclaw doctor
~~~

An ok: false report lists missing prerequisites and exits nonzero. Check enabled separately: readiness does not mean activation.

Check compatibility before using another OpenClaw version:

~~~bash
node scripts/native-contract-smoke.mjs /absolute/path/to/installed/openclaw/package
~~~

This exercises isolated stores. It does not establish live model quality or deployment success.

## 5. Transfer ownership and activate

Existing dispatcher users must pause legacy automations/timers and let accepted work settle before migration. Confirm that no legacy runs remain active; keep native execution disabled during the transfer.

~~~bash
pnpm dispatcher native --policy /absolute/path/to/application/.openclaw/native.json \
  migration plan --source /absolute/path/to/application/.openclaw/dispatcher.db \
  --out /absolute/path/to/native-migration.json
~~~

Review the preview, then apply it with a new backup filename:

~~~bash
pnpm dispatcher native --policy /absolute/path/to/application/.openclaw/native.json \
  migration apply --plan /absolute/path/to/native-migration.json \
  --backup /absolute/path/to/backups/dispatcher-before-native.db
~~~

Imported unfinished tasks remain held. Adopt eligible work with migration adopt --legacy-key <projectId:taskId> so scope, evidence, dependencies, and review gates stay attached. Never directly dispatch imported coding cards. Fresh projects without legacy state skip migration.

Install native jobs:

~~~bash
pnpm dispatcher native --policy /absolute/path/to/application/.openclaw/native.json \
  --openclaw /absolute/path/to/openclaw install-automations \
  --node /absolute/path/to/node \
  --cli /absolute/path/to/autocode/apps/dispatcher-cli/dist/index.js
~~~

New jobs are disabled and their IDs are returned. Quality discovery runs hourly; reconciliation runs every five minutes. Existing jobs retain their enablement state.

After all readiness checks pass, set the policy's enabled field to true, reload the plugin, and call native --policy <file> resume. Enable the returned jobs through OpenClaw. Resume does not change the policy file or enable cron jobs. Keep one worker and follow the [cutover acceptance targets](native-autonomy.md#migration-and-rollout).

## Daily operation

~~~bash
pnpm dispatcher native --policy /absolute/path/to/application/.openclaw/native.json status
pnpm dispatcher native --policy /absolute/path/to/application/.openclaw/native.json quality
pnpm dispatcher native --policy /absolute/path/to/application/.openclaw/native.json quality --json
~~~

Status shows card counts, workflows, blockers, and external operations. Quality explains investigations and decisions, and reports first-pass approvals, repairs, and verified deployments. Use Workboard to inspect individual cards and sessions.

| Observation | Next action |
| --- | --- |
| No new proposals | Check no-op reasons, unchanged inputs, active rounds, daily limits, and backlog pressure. Empty rounds are valid. |
| Prompt skill unavailable | Restore the readable skill file. Incomplete investigations are not admitted. |
| Evidence changed | Investigate the changed code again before admission. |
| Design changes required | Rescope using the findings; do not manually ready the held implementation. |
| Verification/review failed | Inspect artifacts and acceptance evidence. Repairs are bounded; exhausted budgets need intervention. |
| Deployment outcome unresolved | Inspect the live revision and recorded operation before retrying. |
| Unknown quality command | Check out and build the revision documented above. |
| Native RPC unavailable | Check the active binary, plugin activation, capability consent, and gateway logs. |

To stop new dispatch and promotion:

~~~bash
pnpm dispatcher native --policy /absolute/path/to/application/.openclaw/native.json pause
~~~

Pause preserves accepted sessions and evidence; it is not general cancellation. Research deadline enforcement continues. Resolve accepted runs and uncertain release effects before restoring legacy ownership. Keep provider credentials, policy secrets, runtime databases, and logs out of Git.

Workboard limits card notes to 4,000 characters. Larger contexts are preserved in the native evidence journal; the card contains an instruction to call `autocode_context`. Grant this read-only tool to all native worker roles. It returns context only to the agent and active session assigned to that card. The complete persona brief, skill and acceptance criteria are preserved rather than truncated.
