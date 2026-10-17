# Git stage packets: planner, Promptify, coder, and reviewer

Status: proposed implementation plan, 2026-10-16. This update defines the protocol and stage prompts; it does not enable a runtime integration. Base: locally available `origin/master`, `348443ae0e6d10aa6c7ff53fdc2e8145d6232a04`.

## Intended behavior

A Codex-backed planning session investigates the code, develops alternatives, applies the prompt-engineering skill, and produces the implementation prompt for a separate coding session. The host commits the admitted plan and prompt into a Git stage packet. The coder consumes that exact packet, submits code, and hands it to an independent reviewer. Agents can wait for dependencies and request revisions through durable handoffs that survive session loss.

Git carries versioned instructions, messages, and evidence references. OpenClaw Workboard continues to own runnable cards, claims, sessions, and managed worktrees. AutoCode continues to own admission and protected evidence. Git history provides a portable record; an agent-written file or HTML page cannot authorize execution, review, merge, or release.

## Reuse before adding machinery

- Native investigation and admission: `packages/core-runtime/src/native/quality.ts` already assemble skill-backed research and ordered `implementationPrompt` proposals.
- Promptify: `packages/executor/src/planner/promptify.ts` already synthesizes persona instructions and focused verification for the legacy planner. Reuse its concepts through a provider-neutral contract; do not start the legacy dispatcher alongside native execution.
- Handoffs: `packages/domain/src/handoffs.ts` already validate context, scope, evidence, questions, and next actions.
- Dependencies: `packages/domain/src/dependency-graph.ts` already validates dependency graphs. Preserve the native prerequisite semantics when materializing cards.
- Native context, workspaces, and evidence remain in their existing modules. Extend their contracts rather than introducing another task scheduler.

The existing skill is `skills/prompt-engineering-expert/SKILL.md`; there is no separate installed skill named Promptify in the inspected checkout. Here, Promptify names the stage that applies that skill and compiles the coder prompt. Record the actual skill content hash. Keep the configured model explicit on each OpenClaw role; this design asks for Codex-backed planning and coding without hardcoding a model name.

## Stage sequence and gates

1. **Planning / ideation:** the planner receives the user goal, committed source revision, persona mission, scope, and recent relevant outcomes. It inspects code, compares change and no-op alternatives, identifies uncertainty, and creates a bounded implementation plan.
2. **Promptify:** the same planning session applies the prompt-engineering skill to write the coder prompt. Its output covers architecture, ordered steps, expected files, acceptance, focused checks, risks, and stopping conditions. It may revise the prompt before submitting the proposal. A separate model call is optional; a separate handoff artifact is required.
3. **Admission / plan review:** existing policy checks scope, duplicates, prerequisites, budget, and required design review. The host commits the accepted packet. Only then does the implementation card become eligible. Rejection returns reasons to planning without starting a coder.
4. **Doing:** a separate Codex coding session receives the packet commit and assigned managed worktree. It reads the admitted prompt through authenticated context, implements the scope, and calls `autocode_submit`. The host broker creates or validates the code commit using the existing confinement contract.
5. **To Review:** host verification and the independent reviewer evaluate the exact submitted code SHA. Failure creates a bounded repair handoff with findings and that SHA. Keep existing author lockouts, routing, and repair limits.
6. **PR approved / Done:** existing PR, required CI, merge, and deployment rules apply. Done requires the completion evidence configured for that workflow. A stage report cannot substitute for a merge or deployment receipt.

The planning role is read-only against application source. Its proposed artifacts are returned through host tools and committed by the host. The coder has scoped source editing, but no direct access to shared Git metadata or coordination refs. The reviewer cannot be the implementation author.

## Packet storage

Use an opt-in dedicated branch such as `autocode/coordination/<boardId>`, with an isolated host-managed checkout or object writer. Keep coordination commits out of application feature branches. A private repository or explicitly approved private remote can carry packets across machines; local Git is sufficient for the first pilot. No remote publication is implied by enabling local packets.

Each workflow owns paths such as:

```text
workflows/<workflowId>/
  events/<eventId>.json
  plans/<planId>/plan.json
  plans/<planId>/coder.prompt.md
  plans/<planId>/report.html
  handoffs/<handoffId>.json
```

Events, plans, and handoffs are immutable once accepted. New findings and repairs append artifacts. An optional index is derived and rebuildable. Do not commit evidence databases, complete transcripts, credentials, local absolute paths, or raw logs. Export bounded, redacted evidence summaries; store private evidence behind existing authenticated tools.

Commit messages are for people. Runtime parsing uses validated files and exact Git object IDs. A plan payload records the source base SHA and artifact digests; its containing Git commit is recorded externally after writing, avoiding a self-referential commit hash. Likewise, a handoff identifies its code SHA independently of its coordination commit.

## Proposed contracts

These fields are design requirements, not current tool or policy schemas. Version and validate the new envelope separately from the existing version-1 handoff payload.

A plan includes `schemaVersion`, `boardId`, `workflowId`, `planId`, `revision`, `sourceBaseSha`, `goal`, `evidence`, `alternatives`, `allowedPaths`, `nonGoals`, `acceptance`, `verification`, `dependencies`, `risk`, `implementationSteps`, `coderPromptPath`, `coderPromptDigest`, `skillDigest`, and the producing planner run/session IDs. Each dependency identifies a workflow and the required accepted milestone, normally merged code. A changed base or plan requires revalidation before coding.

An event includes `schemaVersion`, `eventId`, `idempotencyKey`, `boardId`, `workflowId`, `sequence`, `previousEventId`, `kind`, `planId`, `planRevision`, `actorRole`, `runId`, `sessionId`, `claimGeneration`, `occurredAt`, and artifact paths/digests. Candidate-related events also include `candidateCodeSha`. Protected verification and review events reference host-issued receipt IDs. Identity is checked against the authenticated tool caller; author metadata in Git is insufficient.

Examples of event kinds are `plan.accepted`, `implementation.started`, `candidate.submitted`, `verification.finished`, `review.changes_requested`, `review.approved`, and `workflow.completed`. Human-input and blocked handoffs record the actual missing prerequisite. Unknown schema versions, unsupported transitions, mismatched IDs, stale claim generations, and forged receipt references fail closed.

## Atomic publication and recovery

1. Validate the authenticated request and current Workboard claim. Atomically persist the transition and a pending Git export in the existing evidence transaction. Use a stable idempotency key per logical action.
2. The host exporter reads the current coordination ref, creates a commit with the new immutable artifacts, and updates the ref using compare-and-swap against the observed tip. Concurrent writers retry from the new tip; they never overwrite another writer's artifact or force-push history.
3. Acknowledge the committed object ID in evidence. Enable the dependent card only after its required packet is available. A crash after the ref update is reconciled by finding the same event/idempotency key in history and acknowledging it without another logical transition.
4. Workboard remains the claim authority. Validate a monotonic claim generation for mutating completion calls so an expired worker cannot publish results after reassignment. Git fetches and timestamps are not locks.
5. On restart, reconcile pending exports before waking dependent work. Duplicate notifications are safe; duplicate sessions are prevented by the native card/session identity. Unknown outcome stays visible and blocks progression until reconciled.

Use one host publisher per board initially. Any later cross-host mode needs a shared Workboard authority, conditional remote ref updates with explicit expected tips, and fetch/ack recovery tests. Independent databases must not each dispatch work from the same branch. Git transport failure must leave accepted code and evidence recoverable without marking the next stage ready.

## Waiting and messages

Agents return a structured handoff and finish their bounded session when waiting. Automations reconcile accepted milestones and wake the next exact card. They do not spend model tokens polling Git or sleep while holding a coder slot.

The host rechecks prerequisites when dispatching, including merged dependency code and the source revision used to prepare the worktree. Cycles and missing dependencies are rejected. A clarification request carries recipient role, question, relevant artifact IDs, and the milestone it blocks; an answer becomes a new accepted event. Free-form messages cannot change scope or approval state.

If implementation changes after review, verification and approval for the previous code SHA do not apply. A revised plan invalidates any not-yet-started prompt assignment; active work requires an explicit supersession/recovery decision. Already admitted workflows keep their current contract unless migrated through a reviewed process.

## HTML instructions and reports

Generate static `report.html` from the accepted plan, coder prompt, and safe evidence summaries. It should show the goal, stage instructions, next role, prerequisites, expected files, checks, decisions, and revision identifiers. Commit the HTML beside its source artifacts so the stage can be inspected at that point in history.

The host passes the canonical prompt and structured scope to the assigned agent. HTML is a readable view of those same instructions. Escape all content and disallow scripts, inline handlers, remote assets, and active embeds. Treat application files and agent messages as untrusted material; they cannot override policy or skill authority. Validate repository-relative paths and artifact sizes before reading or publishing.

## Implementation slices

### 1. Contracts and local Git writer

Add `packages/domain/src/git-stage-packets.ts` and a host-only `packages/core-runtime/src/native/git-stage-packets.ts`. Implement versioned validation, deterministic artifact digests, immutable IDs, safe paths, local ref compare-and-swap, and publication reconciliation. Add pending export storage using the existing evidence migration mechanism. Leave dispatch behavior unchanged and transport disabled by default.

Acceptance: a disposable repository contains an accepted plan, prompt, and report; two contending writers preserve both events; replay and a crash between commit and acknowledgement produce one logical event. A host-only adapter cannot be invoked from the candidate sandbox.

### 2. Planner and Promptify packet production

Extend native quality proposal/admission and authenticated context to preserve the plan, generated coder prompt, skill digest, source revision, and producing session IDs. Wire the configured Codex-backed planner role to the [planning brief](prompts/git-stage-planner.md). Admission publishes the complete packet before implementation eligibility. Keep legacy Promptify compatibility without starting another execution owner.

Acceptance: code-grounded ideation produces a scoped plan and usable coder prompt; missing acceptance, missing required evidence, malformed output, or prompt digest mismatch prevents admission. Plan review policy remains effective.

### 3. Coder, waits, review, and repair

Extend native context, runtime, and workspaces to bind the exact packet revision to the assigned implementation session. Use the [coder contract](prompts/git-stage-coder.md). Publish submission, protected verification, independent review, and repair handoffs. Use native Workboard prerequisites and fence stale workers. The [reviewer contract](prompts/git-stage-reviewer.md) defines the next-stage response.

Acceptance: the coder receives the planner-produced prompt, submits a real change, and an independent reviewer requests a repair or approves that exact SHA. Restart during a dependency wait launches no duplicate coder. Changing the candidate invalidates earlier approval.

### 4. Operator surface and bounded pilot

Add optional versioned policy configuration for local packet transport and inspection commands that show workflow, plan commit, code commit, publisher health, pending exports, and blocked prerequisite. Update native docs and readiness diagnostics. Introduce remote transport only after the local pilot succeeds and its destination is authorized.

Acceptance: one disposable end-to-end workflow demonstrates planner session, committed prompt, separate coder session, actual code SHA, host verification, independent review, restart recovery, and completion through the configured gate. Preserve the receipt chain. Runtime activation and framework release require their existing review and readiness gates.

## Required verification

Write focused tests for packet validation, prompt fidelity, traversal/symlink rejection, HTML escaping, competing ref updates, export replay, stale claims, missing/cyclic dependencies, cross-workflow artifact substitution, forged approvals, changed plan/base/candidate revisions, and restart during waits. Use temporary real Git repositories for ref/publication tests. Exercise a failing check and a rejected review through repair; a happy-path report alone is insufficient.

Run `pnpm typecheck`, relevant focused Vitest files, and lint for each implementation slice. Broaden checks where shared native contracts change. This documentation-only update uses link/path checks and `git diff --check`; runtime behavior has not been implemented or tested by this update.

Roll out disabled, then local export-only, then one disposable workflow with one coder. On rollback, stop new packet-dependent admissions, preserve accepted workflows/artifacts, and reconcile pending publications. Never replay the Git branch as a second execution queue or rewrite accepted history.
