# @openclaw/evaluation

Evaluation framework package for OpenClaw.

This package consolidates the useful pieces reviewed from:

- AgentScope evaluation: benchmark/task/metric abstractions, resumable file storage, repeat-aware execution, aggregate reporting
- Paperclip `evals/`: prompt snapshot suites, deterministic assertions, and repo-owned fixtures for agent behavior checks

Included modules:

- `runner`: repeat-aware evaluation execution with resumable storage
- `storage`: file-backed JSON persistence for runs, tasks, solutions, metrics, and summaries
- `reporting`: aggregate summaries plus Markdown/JSON artifact writers
- `snapshot`: typed prompt snapshot suites and assertion helpers
- `retrieval`: retrieval dataset evaluation helpers migrated from `@openclaw/domain`
- `fixtures/paperclip-heartbeat`: first-party Paperclip heartbeat snapshot suite
