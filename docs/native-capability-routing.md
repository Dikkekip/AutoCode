# Measured native role eligibility

New module: `packages/core-runtime/src/native/capabilities.ts`. Fixed operator-configured OpenClaw roles are checked against provider-neutral measurements of context capacity, structured output, tool support, cancellation, session resume and cost per verified outcome. Missing measurements remain unknown. Required unknown capabilities deny eligibility; requiring known cost denies unknown cost.

An authenticated service operator registers a protected, hashed benchmark artifact and approves requirements bound to the current policy digest. These service APIs are not agent tools. Evidence binds agent, model, dataset, benchmark, policy and expiry. Changes to the artifact, model or policy invalidate eligibility. Controlled fixtures exercise the contract but cannot certify a live model. Configured automatic fallback models without their own measured selection contract are rejected for release modes.

The doctor checks this evidence for staging-canary and application-release modes. The native runtime must recheck eligibility at activation boundaries; a prior readiness result must not authorize a changed model. The implementation retains reviewed role assignments and does not manipulate OpenClaw provider accounts, cooldowns or tool grants. A cost observation alone cannot expand a model's authority.

## Optional task tiers

`coderRouting` partitions `coderAgentIds` into independent `simple`, `routine` and `veryComplex` pools. The primary coder must belong to `routine`. Each pool must be nonempty, with no duplicate or unassigned identities. Load balancing operates only within the selected pool. Existing policies without routing retain their reviewed pool behavior.

Configure the routine role with `openai/gpt-6.1-sol`, the simple role with `openai/gpt-5.6-terra`, and the very complex role with `openai/gpt-6-astra`. Verify exact provider availability before changing active roles. A local Codex model catalog alone does not certify the OpenClaw provider route.

### Registering a model newer than OpenClaw's bundled catalog

OpenClaw 2026.9.6 can reject `openai/gpt-6.1-sol` as unknown even when the native Codex client can execute it. An isolated configuration with the following observed model metadata successfully passed `models status --agent main --probe --probe-provider openai` on that exact model:

```json
{
  "models": {
    "providers": {
      "openai": {
        "baseUrl": "https://chatgpt.com/backend-api/codex",
        "auth": "oauth",
        "api": "openai-chatgpt-responses",
        "models": [{
          "id": "gpt-6.1-sol",
          "name": "GPT-6.1-Sol",
          "reasoning": true,
          "input": ["text", "image"],
          "contextWindow": 272000
        }]
      }
    }
  }
}
```

This is a tested subscription-route canary configuration. Review existing provider endpoints, adapters and auth settings before applying model metadata to a live configuration; provider settings also affect other consumers. Preserve their intended routes. The matching agent model policy selects `agentRuntime.id: "codex"` under its `models["openai/gpt-6.1-sol"]` entry, with no fallback.

Install the official `@openclaw/codex` package through OpenClaw's supported installer in the isolated state directory. Pointing `plugins.load.paths` at another installation does not establish trusted package provenance or register privileged harness features. In the tested isolated configuration, explicit `plugins.load.paths: []` prevented default paths from overriding the official isolated installation. Use `plugins registry --refresh` to rebuild its managed registry.

The successful auth probe establishes route availability. It does not replace role-specific capability measurements, independent skill review, promotion approval or live deployment verification.

Example policy fragment for three already-reviewed isolated coder identities:

```json
{
  "coderAgentId": "coder",
  "coderAgentIds": ["coder", "coder-2", "coder-3"],
  "coderRouting": {
    "simple": ["coder-2"],
    "routine": ["coder"],
    "veryComplex": ["coder-3"],
    "simplePaths": ["docs"],
    "veryComplexPaths": []
  }
}
```

Set the corresponding OpenClaw agent primary models explicitly with empty fallback lists: coder to Sol 6.1, coder-2 to Terra, coder-3 to Astra. Use Sol 6.1 for ordinary investigation, planning and review identities after measuring each binding. Tool-executed deterministic verification does not need a model turn. Keep advanced research identities on Astra only where their reviewed task contract warrants it. This fragment is a configuration proposal, not an activation or capability attestation.

Proposals may include `complexity: {tier: "simple" | "routine" | "very-complex", rationale: "..."}`. Missing complexity defaults to routine. Simple classification requires every allowed path to fall within operator-reviewed `simplePaths` and no recorded high risk. Keep these paths limited to work appropriate for Terra, such as documentation. A declared very complex task, overlap with `veryComplexPaths`, or a second repair selects the very complex pool. Empty scope lists disable the corresponding scope rule. The agent cannot lower a scope-imposed tier. A busy complex worker never causes a task to run on Terra or Sol.

This chooses among existing independent agent identities; it does not change model or tool authority per card. Recovery starts a new bounded repair budget. Existing card assignments, candidates, receipts and reviews remain intact. Changes to either the policy or configured models require fresh capability eligibility and policy-bound approvals before release-mode activation.

Operators must obtain actual benchmark evidence for their configured models before enabling release modes. This implementation supplies no fabricated provider measurements and does not activate a live deployment.
