---
name: contract-change
description: Plan and verify behavior-preserving refactors and compatibility transitions across APIs, schemas, configuration, or deployment definitions.
---

# Check contract changes

Identify readers, writers, callers, configuration sources, and rollout stages before changing a shared shape. Specify the behavior that must remain stable, including failure behavior, ordering, defaults, and supported older versions. Use the project's profile and contract files to find its actual environments and checks.

For a refactor, establish focused proof before moving an ownership boundary and run the same proof after the move. Keep behavior changes explicit in the task scope. For a migration, define the forward path, recovery path, and mixed-version interval. Where applicable, expand compatibility, migrate, verify, then contract only within the authorized stage.

For configuration changes, check each relevant representation: local startup, deployment templates, service consumers, and operational validation. When the project already has a machine-readable contract, extend its checks rather than encoding another source of truth in the prompt. Keep project-specific endpoints and service names in the project profile.

Acceptance proof should cover a representative user workflow and affected old/new paths. State which environments were actually exercised. A local fixture or rendered deployment template does not establish a successful live rollout. Destructive cleanup and later migration stages require their own task scope.
