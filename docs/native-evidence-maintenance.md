# Native evidence maintenance

New in this change: the evidence store has schema version 1. Opening a version-zero database upgrades its tables and indexes in one SQLite transaction, preserving locks, fencing tokens, workflow history and effect keys. Unsupported future versions are rejected before schema changes. A failed migration rolls back; restore a verified copy or repair the diagnosed schema under operator review before retrying.

New files are created in directories with mode 0700; the database and existing WAL/shared-memory files are restricted to 0600. Existing parent directory ownership and permissions remain the operator's responsibility. SQLite remains a single-host service boundary, not a distributed lease system. Candidate sandboxes must not mount this directory.

`NativeEvidenceStore.integrity()` checks SQLite integrity and decodes persisted JSON records, including lifecycle validation when present. Legacy records without modern lifecycle/receipt fields remain readable for recovery; reading them does not grant release authority. The workflow and receipt gates require their stronger current contracts. Diagnostics identify the record kind and ID; they do not print record contents.

`page(kind, { limit, after })` bounds a query to at most 1,000 records, with a cursor scoped to the kind and ordered by update time and ID. Concurrent updates can move records across pages; take a consistent backup for a historical audit requiring snapshot isolation. The compatibility `list()` method remains available to existing callers and is not a bounded query.

`await store.backupTo(newAbsoluteDestination)` uses SQLite's online backup API, including committed WAL data, verifies the copy and refuses an existing destination. Keep the backup private. To restore, pause and stop the native service, retain the original database and its WAL/shared-memory files together, validate the backup, and configure a separate restored database path before restarting paused. Never replace a database beneath a running service. Downgrading the binary requires a compatible backup; changing the schema number is not a rollback.

Retention is deliberately conservative. `pruneCaches(before, limit)` can delete only explicitly disposable `context-cache` records. It retains version tombstones and writes an audit event. Workflows, attempts, receipts, unresolved operations, events and artifact references are preserved. Automatic filesystem artifact deletion is not enabled: the runtime does not yet have a complete ownership/reference catalog capable of proving that an artifact is unreferenced. External backup retention and any artifact cleanup require a reviewed inventory.

Validation fixtures cover version-zero upgrade, interrupted migration rollback, future-version rejection, consistent backup/reopen, same-timestamp pagination, malformed records and preservation of pending deployment evidence through retention.
