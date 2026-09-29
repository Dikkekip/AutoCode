---
name: harness-experiment
description: Compare prompt, skill, tool, and orchestration changes using a fixed baseline, paired cases, and an explicit experiment budget.
---

# Evaluate a harness change

Baseline first: run the unmodified harness on representative cases and preserve the source revision, skill digest, dataset identity, configuration, actual outcomes, and observed usage. Missing cost remains unknown. Do not change the model, evaluator, or benchmark task definitions as an incidental part of the experiment.

State one causal hypothesis, such as dependency-prioritized context reducing irrelevant reads or retained failure deltas reducing repeated repairs. Change one coherent behavior, then rerun the same cases under the same constraints. Inspect individual regressions as well as the aggregate result. More activity or longer reasoning is not a success metric.

Track passed cases, regressions, safety failures, attempts, commands, and time where measured. Count interrupted and invalid runs explicitly. Reserve enough budget for verification; stop when the experiment limit is reached. Prefer the simpler implementation when outcomes are equivalent.

Retain candidates that meet the predefined acceptance rule; explain discarded experiments using observed failures. Never teach the harness task-specific answers or weaken the evaluator. A controlled comparison establishes fixture behavior only. Claims about live model effectiveness need representative repeated live trials.

Native skill promotion uses the reviewed composed digest and protected benchmark plus injection artifacts. An experiment report proposes a change; it does not bootstrap, promote, activate agents, or expand release authority.
