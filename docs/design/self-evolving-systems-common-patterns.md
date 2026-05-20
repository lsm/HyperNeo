# Common Patterns Across StraTA, Learning Beyond Gradients, and Hyperagents

## Purpose

This note extracts the shared ideas across three self-improving agent-system papers and translates them into design principles for NeoKai.

Sources:

- **StraTA: Incentivizing Agentic Reinforcement Learning with Strategic Trajectory Abstraction** (`arXiv:2605.06642`)
- **Learning Beyond Gradients** by Jiayi Weng
- **Hyperagents** (`arXiv:2603.19461`)

The papers differ in mechanism and domain, but they converge on one core thesis:

> Agent systems improve when experience becomes durable, inspectable system structure instead of being lost inside one transient run.

In NeoKai terms, the learned object should not be only a model response. It should be a growing set of strategies, episodes, lessons, workflows, artifacts, tests, issue findings, product feedback, and validated variants.

## Short summary

The common loop is:

```text
generate structured candidate behavior
→ execute in environment
→ capture trace and outcome
→ judge what worked and why
→ store durable artifact
→ select or promote better variants
→ compress history
→ reuse in future tasks
```

Each paper instantiates this loop differently:

| Paper | Structured candidate | Execution trace | Durable artifact | Promotion signal |
| --- | --- | --- | --- | --- |
| StraTA | high-level strategy | strategy-conditioned trajectory | strategy/action credit assignment | reward and self-judgment |
| Learning Beyond Gradients | heuristic code/system patch | trials, logs, videos, tests, replays | code, detectors, tests, summaries, memory | environment score and regressions |
| Hyperagents | modified agent/meta-agent | evaluated archive child | agent code, archive, meta-memory | validation score and archive selection |

## 1. Learning moves from model weights into system structure

All three works shift learning away from opaque, one-shot responses and toward explicit system artifacts.

### StraTA

StraTA inserts a compact strategy before action generation. The strategy is a natural-language trajectory-level abstraction. It is not hidden inside low-level actions. Because it is explicit, the system can score strategy quality separately from action quality.

### Learning Beyond Gradients

Heuristic Learning makes code, tests, logs, trial summaries, replays, and memory the learned object. The system improves through edits to maintainable artifacts, not through gradient updates. Old behavior can be inspected, tested, refactored, deleted, or turned into regression cases.

### Hyperagents

Hyperagents treat the agent and meta-agent as editable programs. The system learns by changing its own code, prompts, memory, and improvement procedure, then storing variants in an archive with scores and lineage.

### NeoKai implication

NeoKai should treat workflows, prompts, gates, memory retrieval rules, artifact schemas, strategy templates, test suites, and product feedback as evolvable system structure.

A completed run should not disappear into chat history. It should become structured evidence that can produce:

- StrategyCards,
- EvolutionEpisodes,
- WorkflowLessons,
- RegressionCases,
- WorkflowVariants,
- ProductFindings,
- TargetArtifact improvements.

## 2. Long-horizon work needs abstraction

All three systems address the same failure mode: raw long-horizon traces are too noisy and detailed for effective learning.

### StraTA

Long-horizon agent tasks contain many local actions. Scoring only low-level actions gives weak credit assignment. StraTA abstracts the trajectory into a high-level strategy, then conditions execution on that strategy.

### Learning Beyond Gradients

A long debugging or control process generates many observations, failed trials, patches, logs, and ad hoc rules. Heuristic Learning requires summarizing these into detectors, policies, tests, replays, and compressed memory.

### Hyperagents

Long-term self-improvement generates many agent variants. Hyperagents abstract this history into an archive with performance, lineage, and meta-level discoveries.

### NeoKai implication

NeoKai should not store only raw transcripts. It needs layered abstractions:

```text
raw tool calls / chat / artifacts
→ episode summary
→ findings
→ lessons
→ workflow mutations
→ promoted variants
```

Each layer should be smaller, more durable, and easier to evaluate than the layer below it.

## 3. Credit assignment must move up a level

All three papers improve by asking a better question than “did the final output work?”

### StraTA

StraTA distinguishes:

- Was the strategy good?
- Was execution under the strategy good?
- Which action steps failed to follow strategy or advance progress?

This gives hierarchical credit assignment.

### Learning Beyond Gradients

Heuristic Learning distinguishes:

- Was the policy wrong?
- Was the state detector wrong?
- Was the test too narrow?
- Did memory mislead the agent?
- Did a new rule break an old behavior?
- Did feedback lack observability?

This turns failure into maintainable engineering work.

### Hyperagents

Hyperagents distinguish:

- Was the task agent weak?
- Was the meta-agent’s improvement procedure weak?
- Was parent selection poor?
- Did an archive variant transfer across domains?
- Did the self-modification create durable meta-knowledge?

### NeoKai implication

NeoKai should score each run along multiple dimensions:

- workflow fit,
- strategy quality,
- execution quality,
- artifact completeness,
- gate quality,
- memory usefulness,
- tool reliability,
- human-review acceptance,
- target artifact improvement,
- NeoKai product friction.

Without this, every failure becomes “agent failed,” which is too vague to improve from.

## 4. Explicit memory is central

All three systems depend on memory that survives beyond a single run.

### StraTA

StraTA uses trajectory structure during training: strategy, rollout group, action history, rewards, and self-judgment. The strategy gives memory-like continuity across the trajectory.

### Learning Beyond Gradients

Memory is central and concrete:

- trial records,
- summaries,
- failure notes,
- replays,
- videos,
- tests,
- version diffs,
- failed directions.

This memory is readable and editable.

### Hyperagents

The archive is memory. It stores agents, scores, variants, lineages, and meta-level improvements. Later modifications use the archive to avoid starting from scratch.

### NeoKai implication

NeoKai needs multiple memory layers:

| Memory type | Scope | Purpose |
| --- | --- | --- |
| run memory | one execution | reconstruct what happened |
| episode memory | one summarized run | judge and compare outcomes |
| lesson memory | task class / Space | guide future runs |
| variant archive | workflow lineage | evolve process safely |
| product feedback memory | NeoKai itself | improve product over time |
| regression memory | target artifact | prevent repeated bugs |

Memory must be scoped, redacted, and lifecycle-managed. Otherwise it becomes stale, poisoned, or too noisy.

## 5. Diversity and exploration matter

All three systems avoid greedy single-path optimization.

### StraTA

StraTA samples many candidate strategies, embeds them, and selects diverse strategies before rollout. This improves exploration and avoids overcommitting to one plausible plan.

### Learning Beyond Gradients

Heuristic Learning explores through code edits, policy variants, detector changes, test additions, parameter sweeps, and replay-guided fixes. It relies on trying alternatives and retaining what works.

### Hyperagents

Hyperagents select parents from an archive using performance and exploration pressure. This keeps the system from mutating only the current best variant and getting stuck in local optima.

### NeoKai implication

NeoKai should support controlled diversity:

- generate several StrategyCards,
- choose diverse strategies for high-value tasks,
- keep multiple workflow variants,
- explore underused workflow lineages,
- run shadow evaluations before promotion,
- maintain alternatives instead of always exploiting current best workflow.

Exploration should be budgeted. Not every task needs parallel strategies, but important or uncertain tasks benefit from diverse starts.

## 6. Self-judgment and reflection are necessary but not sufficient

All three systems include a reflection or critique step.

### StraTA

Critical self-judgment flags action steps that neither follow the strategy nor advance task progress. This improves action-level credit assignment.

### Learning Beyond Gradients

The coding agent inspects failures, logs, videos, tests, and scores. It then edits the system and reruns. Reflection is grounded by external feedback.

### Hyperagents

The meta-agent uses archive history and evaluations to decide how to modify agents. It can improve the improvement procedure itself.

### NeoKai implication

NeoKai should use reflection, but ground it in evidence:

```text
reflection + artifacts + tests + gates + human feedback + outcome metrics
```

Reflection without validation becomes narrative. Validation without reflection gives weak learning. The system needs both.

## 7. Reuse beats relearning

All three systems aim to avoid rediscovering the same insight.

### StraTA

The learned strategy/action hierarchy helps future rollouts choose better high-level plans and execute them more coherently.

### Learning Beyond Gradients

Old capabilities become tests, replays, detectors, rules, and summaries. The system preserves gains through software-maintenance practices.

### Hyperagents

Successful variants and meta-level improvements stay in the archive. Meta-improvements can transfer across domains, which is one of the paper’s key results.

### NeoKai implication

NeoKai should convert repeated work into reusable structures:

- task strategies,
- review checklists,
- artifact schemas,
- workflow variants,
- target-project regression tests,
- issue templates,
- product feedback clusters,
- known failure-mode detectors.

This is where compounding comes from.

## 8. Improvement needs external validation

All three systems rely on feedback signals outside the agent’s own preference.

### StraTA

Uses benchmark rewards, success rates, rollout groups, ablations, and self-judgment penalties.

### Learning Beyond Gradients

Uses environment scores, fixed seeds, tests, replays, videos, and regression behavior.

### Hyperagents

Uses task sets, evaluation scores, archive validity, validation/test splits, and sandboxed execution.

### NeoKai implication

NeoKai should not promote lessons or variants based only on plausible summaries.

Promotion should require evidence such as:

- passing tests,
- human approval,
- lower rejection rate,
- better artifact completeness,
- replay success,
- held-out task performance,
- reduced cost for same quality,
- no safety regression.

Core rule:

```text
No durable behavior change without validation.
```

## 9. Complexity must be managed through compression

All three systems face complexity pressure.

### StraTA

A fixed strategy helps structure behavior, but it can become restrictive if the environment changes. Strategy abstraction must be useful but not overly rigid.

### Learning Beyond Gradients

This is the clearest warning. A heuristic system that only accumulates patches becomes a “big ball of mud.” It must compress history into simpler structures.

### Hyperagents

Self-modification can grow beyond human audit capacity. The paper keeps evaluators, sandboxing, timeouts, and parts of the outer loop fixed for safety.

### NeoKai implication

NeoKai needs active compression:

- merge duplicate lessons,
- retire stale lessons,
- shrink prompts,
- replace repeated instructions with artifact schemas,
- replace fragile memory with regression tests,
- simplify workflows that accrete gates,
- reject variants with bad complexity/performance tradeoffs.

A more complex workflow is not automatically better. Complexity must buy measurable value.

## 10. The update procedure itself can become an object of improvement

This is most explicit in Hyperagents, but implied by all three.

### StraTA

The strategy generation and action execution procedure is trained jointly. The system improves not only actions, but how strategies are generated and used.

### Learning Beyond Gradients

The coding-agent loop improves its own supporting system: tests, logs, detectors, memory, and update practices.

### Hyperagents

The meta-agent can modify itself. The improvement procedure is editable and can produce cross-domain gains.

### NeoKai implication

NeoKai should eventually evolve not only workflows, but the process that improves workflows.

Examples:

- better StrategyCard generator,
- better Episode Judge rubric,
- better WorkflowVariant parent selection,
- better lesson compression,
- better issue dedupe,
- better target artifact evaluator,
- better replay suite construction.

But these meta-procedures are high risk. Early versions should be fixed or human-reviewed before promotion.

## 11. Safety boundaries must stay outside the self-modification loop

All three systems need boundaries, even when they enable improvement.

### StraTA

The method constrains optimization with reference models, KL regularization, clipping, format penalties, and benchmark-defined rewards.

### Learning Beyond Gradients

The system relies on tests, replays, reproducibility, rollback, and modularity to keep heuristic accumulation maintainable.

### Hyperagents

The paper explicitly keeps evaluation, sandboxing, timeouts, restricted internet, and oversight outside free self-modification.

### NeoKai implication

NeoKai should keep these fixed by default:

- evaluator/scorer,
- tool permissions,
- autonomy thresholds,
- GitHub publishing permissions,
- protected branch rules,
- promotion gates,
- redaction policy,
- cross-space transfer policy.

Agents can propose changes, but NeoKai must own validation and promotion.

## 12. Transfer is where compounding becomes large

One-off improvement is useful. Transfer creates leverage.

### StraTA

The strategy abstraction is reusable across tasks with similar long-horizon structure.

### Learning Beyond Gradients

A detector, test pattern, replay practice, or compression rule can be reused across many heuristic systems.

### Hyperagents

Meta-improvements transfer across domains. The paper’s IMO grading transfer result shows that learned improvement procedures can matter even when task content changes.

### NeoKai implication

NeoKai should distinguish scopes:

- run-local,
- Space-local,
- project-local,
- user-private,
- organization-shared,
- global template.

Promotion across scopes should require stronger redaction and validation. But done right, transfer is the biggest source of 100x results.

## Unified NeoKai design principle

Every run should produce structured evidence. Only validated evidence should become durable improvement.

```text
run
→ evidence
→ episode
→ finding
→ lesson / regression / mutation / issue / patch
→ validation
→ scoped promotion
→ future run improvement
```

This principle combines all three papers:

- **StraTA** gives strategy abstraction and hierarchical credit assignment.
- **Learning Beyond Gradients** gives durable artifacts, tests, replays, memory, and compression.
- **Hyperagents** gives archive-based self-improvement and meta-procedure evolution.

## Practical NeoKai artifacts

The shared pattern suggests these concrete artifacts:

### StrategyCard

High-level task strategy, generated before execution and revised at checkpoints.

### EvolutionEpisode

Structured summary of a workflow run with outcome, trace, artifacts, findings, and scores.

### WorkflowLesson

Compressed, scoped, evidence-backed lesson used in future runs.

### RegressionCase

Replayable or testable example preserving an old capability or failure mode.

### WorkflowVariant

Candidate workflow mutation with lineage, score, validation status, and rollback path.

### ProductFinding

Evidence-backed NeoKai product issue or improvement opportunity.

### TargetArtifactPatch

Patch, doc, template, script, process change, or artifact improvement in the user’s target system.

## Final takeaway

The common thread is not “agents should reflect.” It is stronger:

> Agents should convert experience into durable, validated, scoped system changes.

For NeoKai, that means the system should improve at three levels:

1. how work is done,
2. what work produces,
3. NeoKai itself.

The run is not the unit of value. The validated learning cycle is the unit of compounding.
