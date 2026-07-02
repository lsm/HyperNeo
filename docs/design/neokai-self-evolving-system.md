# HyperNeo Self-Evolving System

## Status

Research and architecture proposal.

## Goal

HyperNeo should become a system that improves from use. Each completed run should generate evidence that can make future work cheaper, safer, and more capable after scoring, redaction, validation, and policy approval.

The system improves three things independently:

1. **Workflow** — how agents plan, coordinate, execute, review, and learn.
2. **Target artifact** — the codebase, document set, research corpus, business process, or other system the user is working on.
3. **HyperNeo itself** — product, runtime, UI, tools, prompts, memory, and workflow infrastructure.

The target ambition is not a vague “smarter agent.” It is a compounding system where roughly 2x implementation effort can produce 100x long-term value by turning high-quality run evidence into durable improvements: reusable strategies, workflow lessons, regression cases, product feedback, issue drafts, patches, and evolved workflow variants.

A run does not automatically improve HyperNeo. A run produces evidence. Evidence becomes improvement only after it passes the relevant domain policy.

## Source research

This design synthesizes three recent systems:

- **StraTA: Incentivizing Agentic Reinforcement Learning with Strategic Trajectory Abstraction** (`arXiv:2605.06642`)
- **Learning Beyond Gradients** by Jiayi Weng
- **Hyperagents** (`arXiv:2603.19461`)

Local copies used during research:

- `research-papers/strata-2605.06642.pdf`
- `research-papers/strata-2605.06642.txt`
- `research-papers/hyperagents-2603.19461.pdf`
- `research-papers/hyperagents-2603.19461.txt`
- `research-papers/learning-beyond-gradients.html`

The common insight is that agent systems should not only solve tasks. They should maintain an evolving substrate of strategies, artifacts, memories, tests, workflows, and meta-procedures that improves across runs.

## What StraTA contributes

StraTA adds an explicit strategy abstraction before action execution.

The method decomposes long-horizon agent behavior into two levels:

1. **Strategy generation** — sample a compact high-level strategy from the initial task state.
2. **Strategy-conditioned execution** — generate each action conditioned on both the current state and that strategy.

Instead of treating an entire trajectory as undifferentiated action tokens, StraTA gives the learning system a stable strategic object. This improves exploration and credit assignment.

### Core mechanics

For each task, StraTA:

1. Samples multiple candidate strategies.
2. Embeds and selects diverse strategies using farthest-point style selection.
3. Runs multiple rollouts under each strategy.
4. Scores actions and strategies separately.
5. Scores a strategy by the mean reward of its top-performing rollouts, so a good strategy is not overly punished for noisy execution.
6. Adds critical self-judgment, where the model reviews whether each action followed the strategy or advanced progress.
7. Trains strategy and action generation jointly with a hierarchical GRPO-style objective.

### Results

Reported results include:

- **ALFWorld 7B**: `93.1 ± 0.8%` success.
- **WebShop 7B**: `84.2 ± 0.3%` success, `91.2 ± 0.3` score.
- **SciWorld 7B**: `63.5 ± 0.7` overall score, outperforming several strong and closed-source baselines in the paper.

Ablations show both diverse strategy rollout and critical self-judgment matter. For example, on a Qwen2.5-3B setup, full StraTA reached `88.6 ± 1.9` on ALFWorld and `73.4 ± 1.0` WebShop success, above vanilla strategy hierarchy and single-component variants.

### HyperNeo translation

StraTA maps naturally to HyperNeo as **Strategy Cards**.

Before a workflow starts, HyperNeo should generate one or more compact strategy cards:

- problem framing,
- assumptions,
- subgoals,
- expected artifacts,
- risks,
- verification steps,
- success signals.

The selected strategy becomes shared context for the workflow. It is visible to all worker agents and reviewers. After the run, HyperNeo can judge whether the trace followed the strategy and whether the strategy itself was good.

This lets HyperNeo distinguish failures such as:

- bad strategy,
- good strategy but poor execution,
- good execution but wrong workflow,
- missing verification,
- unclear review gate,
- insufficient artifacts.

Without this split, every failure collapses into “agent failed.” With this split, HyperNeo gets actionable credit assignment.

## What Learning Beyond Gradients contributes

Learning Beyond Gradients argues that coding agents enable **Heuristic Learning**: learning by maintaining code systems, not by updating neural network weights.

A **Heuristic System** is not just a policy file. It includes:

- programmatic policy,
- explicit state representation,
- detectors,
- feedback channels,
- logs,
- tests,
- replays,
- trial history,
- memory,
- summaries,
- failure notes,
- version diffs,
- an agentic update loop.

The learning loop is:

```text
environment feedback / test failure / log anomaly
→ coding agent reads context
→ edits policy / test / memory
→ reruns
→ writes results into trials and summaries
→ compresses or refactors accumulated patches
→ repeats
```

### Key empirical examples

The article reports strong results from code-maintained heuristic systems:

- **Breakout**: improved `387 → 507 → 839 → 864`, reaching the theoretical maximum.
- **MuJoCo Ant**: evolved from CPG/PD gait to residual MPC, reaching `6146.2` mean over about `106,300` environment steps.
- **HalfCheetah**: staged-tree MPC plus gait/posture rules reached five-episode mean `11836.7`.
- **VizDoom D3 Battle**: pure cv2/NumPy policy reached mean `557.0`, min `440.0` across 10 seeds.
- **Atari57**: 342 unattended coding-agent trajectories reached median HNS around `0.81` native observations at about `9.7M` steps, in the range of PPO-style baselines at comparable scale.

The details matter more than the scores: performance came from explicit detectors, feedback loops, testable policies, replay artifacts, and repeated compression.

### Coupling complexity

The article introduces **coupling complexity**: how many interdependent states, rules, tests, feedback signals, and historical constraints an agent must maintain at once.

It is not the same as line count. A small system can be highly coupled if every rule interacts with every other rule.

Code-side factors that reduce coupling complexity:

- stable module boundaries,
- explicit interfaces,
- reproducible state,
- tests,
- replay artifacts,
- observability,
- low rollback cost.

Agent-side factors that increase maintainable complexity:

- stronger models,
- longer context,
- better memory,
- better tools,
- faster iteration.

The main warning is that a heuristic system that only accumulates patches becomes a big ball of mud. It needs periodic compression: merging lessons, deleting stale rules, refactoring brittle patches, and turning old capabilities into tests or replays.

### HyperNeo translation

HyperNeo workflows should be treated as heuristic systems.

A workflow is not just a prompt or DAG. It is:

- strategy policy,
- node prompts,
- channels,
- gates,
- artifacts,
- memory retrieval,
- review criteria,
- tool permissions,
- run traces,
- failure history,
- regression cases,
- human feedback,
- promotion rules.

Each workflow run should produce structured feedback. That feedback should become lessons, tests, replay cases, or workflow mutations. Then those improvements must be compressed so the system stays maintainable.

## What Hyperagents contributes

Hyperagents extend self-improving systems by making the meta-level modification procedure itself editable.

The paper defines:

- **Task agent** — solves a target task.
- **Meta agent** — modifies agents using code, archive, and evaluation history.
- **Hyperagent** — a single editable self-referential program combining task agent and meta agent.
- **Metacognitive self-modification** — modifying both task behavior and the future procedure that performs modifications.

DGM-H, the paper’s implementation, extends Darwin Gödel Machine-style self-improvement by placing hyperagents in the archive. Each archived agent can modify itself, evaluate the result, and add successful variants back to the archive.

### Core algorithm

The DGM-H loop is:

1. Evaluate initial agent on a task set.
2. Store `(agent, score)` in an archive.
3. Select archive parents using score plus novelty / under-explored lineage.
4. Ask a parent hyperagent to modify itself using its code and archive history.
5. Evaluate the child.
6. If valid, add it to the archive.
7. Repeat.

Parent selection balances:

- high performance,
- exploration,
- lineage diversity,
- avoiding repeatedly exploiting the same parent.

### Results

Reported examples include:

- **Polyglot coding**: DGM-H full score improved from `0.084 → 0.267`; train from `0.140 → 0.340`.
- **Paper review / robotics reward design**: DGM-H reached paper review `0.710` and robotics `0.372`, outperforming fixed or non-self-improving baselines.
- **IMO grading transfer**: DGM-H meta-improvements transferred to a new domain, reaching `0.630` after 50 iterations where baselines had `0.0` improvement.
- **Compounding**: transfer plus continued improvement reached about `0.640` after 200 iterations; starting from ProofAutoGrader plus transferred meta-procedure reached `0.700` vs `0.670` baseline.

The most important result is not one score. It is that meta-level discoveries transferred across domains. The system invented generally useful procedures such as performance tracking, persistent memory, trend windows, domain knowledge bases, structured checklists, and compute-aware strategies.

### Safety constraints

The paper keeps important pieces fixed for stability and safety:

- evaluation protocol,
- sandboxing,
- timeouts,
- task distribution,
- restricted internet,
- human oversight,
- parts of the outer loop.

It warns that self-improving systems may evolve faster than human audit capacity.

### HyperNeo translation

HyperNeo should allow agents to propose changes to workflows, lessons, artifact schemas, memory policies, and issue templates. But promotion must remain guarded.

Core rule:

**Agents may propose workflow and product evolution; HyperNeo owns validation and promotion.**

This captures Hyperagents’ upside without uncontrolled self-modification.

## Initial thought process

The first design focused on workflow improvement because HyperNeo already has Space workflows, gates, tasks, artifacts, and agent memory. That led to a straightforward mapping:

- StraTA → Strategy Cards.
- Learning Beyond Gradients → workflow episodes, artifacts, tests, lessons, compression.
- Hyperagents → workflow variant archive and guarded mutations.

That was useful but incomplete.

HyperNeo has three real use cases:

1. **Using HyperNeo to develop HyperNeo.**
2. **Using HyperNeo to develop other software.**
3. **Using HyperNeo for non-coding work.**

Those use cases reveal that workflow evolution is only one axis. Each run can also improve the target artifact and HyperNeo itself.

The corrected architecture separates three evolution targets:

1. **Workflow Evolution** — improve how agents do work.
2. **Target Artifact Evolution** — improve the thing being worked on.
3. **HyperNeo Product Evolution** — improve HyperNeo itself.

These three targets share evidence from the same run, but they require different permissions, validation, ownership, and blast-radius controls.

## Target architecture: HyperNeo Forge

The proposed system is **HyperNeo Forge**.

HyperNeo Forge is a self-evolution layer around Space workflows. It observes runs, extracts structured episodes, routes findings to evolution domains, stores lessons, proposes improvements, validates them, and promotes them only under policy.

High-level loop:

```text
task arrives
→ generate diverse strategies
→ select workflow and strategy
→ run existing Space workflow
→ collect artifacts, gates, traces, results, human feedback
→ judge outcome
→ split findings by evolution domain
→ compress durable lessons
→ propose workflow / target / HyperNeo improvements
→ validate against replay or tests
→ route to suggestion, task, issue, PR, or promoted variant
```

## Three evolution domains

### 1. Workflow Evolution

This domain improves how HyperNeo agents work.

Examples:

- better strategy prompts,
- better workflow selection,
- better node prompts,
- better review gates,
- better artifact schemas,
- better memory retrieval,
- better decomposition rules,
- better human-in-the-loop checkpoints,
- better completion criteria.

This domain is always relevant, regardless of whether the task is coding or non-coding.

### 2. Target Artifact Evolution

This domain improves the user’s actual work product.

For coding work, this means:

- source code,
- tests,
- build scripts,
- docs,
- architecture,
- dependency hygiene,
- issue lists,
- PRs.

For non-coding work, this may mean:

- research corpus,
- knowledge graph,
- operating manual,
- hiring process,
- GTM plan,
- legal review checklist,
- dataset,
- rubric,
- repeatable tool,
- generated script,
- workflow template.

The key is that “artifact” is broader than code.

### 3. HyperNeo Product Evolution

This domain improves HyperNeo itself.

Examples:

- missing UI affordance,
- brittle workflow runtime behavior,
- insufficient task context,
- weak memory retrieval,
- noisy permission prompts,
- confusing gate UX,
- missing browser automation affordance,
- poor artifact rendering,
- repeated failure in an agent tool,
- missing integration.

When HyperNeo is used to develop HyperNeo, this domain can create code patches directly. When HyperNeo is used on external projects, this should usually create issue drafts or GitHub issues under an explicit flag.

## Use case mapping

| Use case | Workflow evolves | Target artifact evolves | HyperNeo evolves |
| --- | --- | --- | --- |
| HyperNeo develops HyperNeo | yes | HyperNeo code | HyperNeo code directly |
| HyperNeo develops another codebase | yes | target repo code | HyperNeo issues or optional PRs under flag |
| HyperNeo does non-coding work | yes | user system/process/artifacts | HyperNeo issues or optional plugins under flag |

## Evolution policy

Each Space should define an evolution policy.

```ts
type EvolutionDomain =
	| 'workflow'
	| 'target_artifact'
	| 'neokai_product';

type EvolutionMode =
	| 'observe_only'
	| 'suggest'
	| 'create_task'
	| 'create_artifact'
	| 'create_template'
	| 'create_issue'
	| 'create_pr'
	| 'auto_apply_with_review';

type SpaceEvolutionPolicy = {
	workflow: EvolutionMode;
	targetArtifact: EvolutionMode;
	neokaiProduct: EvolutionMode;
	allowWorkflowVariantPromotion: boolean;
	allowTargetCodeChanges: boolean;
	allowTargetCodeChangesOnlyInsideActiveWorkspace: boolean;
	allowNeoKaiIssueCreation: boolean;
	allowNeoKaiCodeChanges: boolean;
	learningBudget: LearningBudget;
	retention: EvolutionRetentionPolicy;
};
```

Default safe policy:

```text
workflow: suggest
targetArtifact: suggest
neokaiProduct: observe_only
allowWorkflowVariantPromotion: false
allowTargetCodeChanges: true
allowTargetCodeChangesOnlyInsideActiveWorkspace: true
allowNeoKaiIssueCreation: false
allowNeoKaiCodeChanges: false
```

For HyperNeo-on-HyperNeo development:

```text
workflow: create_task or create_pr
targetArtifact: create_pr
neokaiProduct: create_pr
allowWorkflowVariantPromotion: true with review
allowNeoKaiCodeChanges: true
```

For external repo development:

```text
workflow: suggest or create_task
targetArtifact: create_pr
neokaiProduct: create_issue under explicit flag
allowNeoKaiCodeChanges: false by default
```

For non-coding work:

```text
workflow: suggest or create_task
targetArtifact: create_task / create_artifact / create_template
neokaiProduct: create_issue under explicit flag
allowTargetCodeChanges: optional, depending on whether generated tools are desired
```

## Core data model

### StrategyCard

StrategyCard is the StraTA-inspired high-level plan.

```ts
type StrategyCard = {
	id: string;
	spaceId: string;
	taskId: string;
	workflowId: string;
	taskFingerprint: string;
	summary: string;
	assumptions: string[];
	subgoals: string[];
	riskChecks: string[];
	expectedArtifacts: string[];
	successSignals: string[];
	candidateRank: number;
	diversityGroupId?: string;
	createdAt: string;
};
```

StrategyCards should be short, concrete, and visible in the agent task message.

### EvolutionEpisode

EvolutionEpisode is the central learning unit.

```ts
type TargetArtifactKind =
	| 'codebase'
	| 'documents'
	| 'knowledge_graph'
	| 'process'
	| 'dataset'
	| 'tooling'
	| 'mixed';

type EvolutionEpisode = {
	id: string;
	runId: string;
	spaceId: string;
	taskId?: string;
	workflowId?: string;
	strategyCardId?: string;
	target: {
		kind: TargetArtifactKind;
		repoUrl?: string;
		workspacePath?: string;
		description?: string;
	};
	outcome: RunOutcome;
	score: EpisodeScore;
	findings: EvolutionFinding[];
	lessons: WorkflowLesson[];
	artifactChanges: ArtifactChange[];
	productFeedback: ProductFeedback[];
	createdAt: string;
};
```

### EpisodeScore

```ts
type EpisodeScore = {
	success: number;
	humanApproval: number;
	regressionPass: number;
	artifactCompleteness: number;
	strategyAdherence: number;
	costPenalty: number;
	humanCorrectionPenalty: number;
	blockedPenalty: number;
	overall: number;
};
```

The score is not intended to be perfect. It is intended to be directionally useful for ranking variants and detecting regressions.

### EvolutionFinding

```ts
type EvolutionFinding = {
	id: string;
	domain: EvolutionDomain;
	kind:
		| 'bug'
		| 'friction'
		| 'missing_capability'
		| 'optimization'
		| 'regression'
		| 'new_opportunity';
	impact: 'low' | 'medium' | 'high';
	confidence: number;
	evidence: string[];
	proposedAction: string;
	route?: EvolutionRoute;
};
```

Findings are the output of the Episode Judge. The Evolution Router decides what to do with them.

### WorkflowLesson

WorkflowLesson is the compressed memory form.

```ts
type WorkflowLesson = {
	key: string;
	spaceId: string;
	appliesTo: string[];
	rule: string;
	why: string;
	evidenceRunIds: string[];
	confidence: number;
	expiresAt?: string;
	createdAt: string;
	updatedAt: string;
};
```

Lessons should be scoped and evidence-backed. They should not be raw transcripts.

### WorkflowVariant

WorkflowVariant is the Hyperagent-inspired archive unit.

```ts
type WorkflowVariant = {
	id: string;
	spaceId: string;
	baseWorkflowId: string;
	parentId?: string;
	status: 'candidate' | 'validated' | 'promoted' | 'rejected' | 'retired';
	mutation: WorkflowMutation;
	scores: {
		successRate: number;
		humanApprovalRate: number;
		regressionPassRate: number;
		medianCost: number;
		complexityScore: number;
	};
	lineageDepth: number;
	createdFromEpisodes: string[];
	createdAt: string;
};
```

### Supporting types

```ts
type RunOutcome =
	| 'success'
	| 'failed'
	| 'human_rejected'
	| 'timeout'
	| 'cancelled'
	| 'blocked';

type EvolutionRoute = {
	mode: EvolutionMode;
	target: 'workflow_variant' | 'task' | 'artifact' | 'issue' | 'pr' | 'feedback_inbox';
	requiresHumanApproval: boolean;
};

type ArtifactChange = {
	artifactId: string;
	kind: TargetArtifactKind;
	changeType: 'created' | 'updated' | 'validated' | 'rejected';
	summary: string;
};

type ProductFeedback = {
	id: string;
	component: string;
	problem: string;
	evidence: string[];
	proposedFix?: string;
	redactionStatus: 'not_needed' | 'pending' | 'redacted';
};

type WorkflowMutation = {
	type:
		| 'strategy_template'
		| 'node_prompt'
		| 'artifact_schema'
		| 'review_checklist'
		| 'gate_field'
		| 'gate_script_tightening'
		| 'memory_query'
		| 'workflow_selector_hint'
		| 'followup_task_template';
	description: string;
	patch: unknown;
};

type LearningBudget = {
	maxStrategiesPerTask: number;
	maxEpisodeJudgesPerRun: number;
	maxMutationValidationsPerDay: number;
	maxIssueDraftsPerDay: number;
	maxLearningTokensPerDay?: number;
};

type EvolutionRetentionPolicy = {
	storeRawTrace: boolean;
	storeSummaries: boolean;
	retentionDays: number;
	allowCrossSpaceTransfer: boolean;
};
```

## Existing HyperNeo seams

HyperNeo already has several places where Forge can attach with limited disruption.

### Workflow definitions

Shared workflow types live in:

- `packages/shared/src/types/space.ts`

Built-in workflow templates live in:

- `packages/daemon/src/lib/space/workflows/built-in-workflows.ts:1434`
- `packages/daemon/src/lib/space/workflows/built-in-workflows.ts:1574`

Forge can store learned variants separately first, then later allow promotion into real workflow templates.

### Workflow run lifecycle

Workflow runs start in:

- `packages/daemon/src/lib/space/runtime/space-runtime.ts:2021`

This is a natural place to attach strategy selection before a run starts.

### Agent task message

Custom task messages are built in:

- `packages/daemon/src/lib/space/agents/custom-agent.ts:239`

This is the safest place to inject:

- selected StrategyCard,
- relevant WorkflowLessons,
- expected artifacts,
- known failure modes.

### Gates

Gate evaluation lives in:

- `packages/daemon/src/lib/space/runtime/gate-evaluator.ts:4`

Forge can learn from gate failures and propose clearer gate fields, stricter artifact requirements, or better review checks.

### Artifacts

Node agents can save artifacts through:

- `packages/daemon/src/lib/space/tools/node-agent-tools.ts:1114`

Artifacts should become the main evidence source for episode summaries. They are cleaner than raw transcript mining.

### Task completion

Completion and approval paths live in:

- `packages/daemon/src/lib/space/tools/end-node-handlers.ts:241`

Forge should use terminal task state, approvals, and rejections as outcome signals.

### Agent memory

Persistent memory exists in:

- `packages/daemon/src/storage/repositories/agent-memory-repository.ts:41`
- `packages/daemon/src/storage/repositories/agent-memory-repository.ts:112`
- `packages/daemon/src/storage/schema/index.ts:698`

Forge should reuse this for scoped WorkflowLessons before adding a separate memory system.

## Runtime flow

### Step 1: Classify task and evolution domains

When a task starts, HyperNeo classifies:

- target artifact kind,
- workspace/repo target,
- whether this is HyperNeo-on-HyperNeo,
- allowed evolution modes,
- risk level,
- validation options.

This determines whether later findings can become suggestions, tasks, issues, PRs, or workflow variants.

### Step 2: Generate strategy candidates

For non-trivial tasks, generate multiple StrategyCards.

```text
Input: task title, task description, workspace context, relevant lessons, workflow candidates.
Output: N candidate StrategyCards.
```

Candidate generation should intentionally vary approaches:

- direct implementation,
- research-first,
- test-first,
- prototype-first,
- multi-agent split,
- human-gated path,
- low-risk conservative path.

### Step 3: Select diverse strategies

Use embedding diversity inspired by StraTA:

1. Embed candidate StrategyCard summaries.
2. Select one near the centroid to avoid an extreme outlier.
3. Add candidates with maximum distance from selected set.
4. Score each for feasibility and verification clarity.
5. Pick one or keep several for parallel exploration if task value is high.

This is cheap compared to failed long-horizon work.

### Step 4: Execute existing workflow

Run the selected workflow normally.

The agent message includes:

- task,
- role,
- workflow context,
- selected StrategyCard,
- relevant WorkflowLessons,
- expected artifacts,
- gates and completion criteria.

This preserves current Space runtime architecture.

### Step 5: Collect evidence

After terminal state or meaningful failure, collect:

- StrategyCard,
- workflow run metadata,
- node executions,
- gate states,
- artifacts,
- task status,
- approval/rejection details,
- tests/build results if available,
- user corrections,
- cost and wall-clock metrics.

Artifacts should be preferred over raw transcript whenever possible.

### Step 6: Judge episode

The Episode Judge creates:

- score,
- findings,
- lessons,
- artifact changes,
- product feedback.

It should answer:

- Did the strategy fit the task?
- Did execution follow the strategy?
- Which steps created value?
- Which steps were dead work?
- Which gates blocked progress?
- Which artifacts were missing?
- Did human review reject anything?
- Did a test or build catch an issue?
- Was there target artifact improvement opportunity?
- Was there HyperNeo product friction?

### Step 7: Route findings

The Evolution Router routes each finding by domain and policy.

```text
workflow finding
→ lesson / workflow task / variant candidate / gate proposal

target artifact finding
→ follow-up task / patch / issue / doc / generated tool

HyperNeo product finding
→ local feedback item / GitHub issue draft / GitHub issue / HyperNeo PR
```

### Step 8: Compress lessons

Compression is required.

Rules:

- Store at most a few lessons per run.
- Merge duplicate lessons.
- Decay low-confidence lessons.
- Remove lessons contradicted by later evidence.
- Prefer specific scoped rules over broad generic advice.
- Attach evidence run IDs.

Bad lesson:

```text
Always use tests.
```

Good lesson:

```text
For Space workflow runtime changes, run daemon unit tests that exercise gate transitions before reporting completion, because prior runs passed typecheck but failed approval edge cases.
```

### Step 9: Propose mutations

Workflow mutations should be tiny and typed.

Allowed v1 mutation types:

- add StrategyCard template,
- edit strategy-generation prompt,
- add expected artifact schema,
- add reviewer checklist item,
- add gate field,
- tighten gate script,
- change memory retrieval query,
- add workflow selector hint,
- add follow-up task template.

Disallowed v1 mutation types:

- delete safety gates,
- lower autonomy threshold,
- grant new tool permissions,
- change global system prompts,
- auto-merge code,
- mutate evaluator/scorer,
- bypass human review.

### Step 10: Validate and promote

Candidate improvements should be validated before promotion.

Validation can include:

- schema checks,
- workflow compile checks,
- replay against prior episodes,
- held-out task suite,
- test/build results,
- human review,
- no safety/autonomy regression.

Promotion rule:

```text
promote only if candidate improves or preserves success metrics,
passes regression checks,
and satisfies the Space evolution policy.
```

## HyperNeo-on-HyperNeo mode

This is the strongest self-evolution loop.

HyperNeo can directly improve itself because the target artifact and product are the same.

Flow:

```text
HyperNeo task runs in HyperNeo
→ workflow friction or product issue appears
→ Episode Judge records it
→ finding routes to target_artifact and neokai_product
→ agent creates HyperNeo code patch
→ tests validate patch
→ run creates WorkflowLesson or WorkflowVariant
→ future HyperNeo tasks benefit
```

Example:

```text
Repeated failure: task agents miss previous gate data.
Workflow finding: gate history must be summarized before execution.
HyperNeo product finding: task message lacks compact gate-history section.
Target artifact patch: edit buildCustomAgentTaskMessage().
Regression: add test for message includes gate-history summary.
Promotion: human reviews PR.
```

This is closest to Hyperagents because the system modifies the substrate it runs on.

Safety requirement: keep evaluator, branch protection, tests, and approval policies outside automatic mutation.

## External codebase mode

When HyperNeo develops another codebase, the primary obligation is to the target repo.

HyperNeo should improve:

1. workflow,
2. target repo,
3. HyperNeo product only under explicit flag.

Flow:

```text
user asks HyperNeo to work on repo X
→ HyperNeo patches repo X
→ episode records workflow and product friction
→ target findings become repo X issues/PRs/tasks
→ HyperNeo findings become local feedback by default
→ if enabled, HyperNeo findings become GitHub issues in HyperNeo repo
```

Default behavior should not mutate HyperNeo code while the user asked for work on another repo. The best default is issue generation, not self-PR.

HyperNeo issue should include:

- observed friction,
- affected workflow,
- reproduction trace,
- expected improvement,
- impact estimate,
- related run IDs,
- whether issue came from coding or non-coding work.

## Non-coding work mode

For non-coding work, target artifact evolution still applies. The artifact may be a system, not code.

Examples:

### Paper research

HyperNeo can improve:

- reading workflow,
- paper taxonomy,
- comparison rubric,
- knowledge graph,
- extraction templates,
- citation map,
- reusable summary format.

### Business planning

HyperNeo can improve:

- operating model,
- planning template,
- metrics dashboard spec,
- interview guide,
- decision log,
- stakeholder update cadence.

### Legal or policy review

HyperNeo can improve:

- checklist,
- risk taxonomy,
- evidence table,
- exception process,
- review workflow.

The “artifact” may be generated docs, structured data, process templates, scripts, or a small app. Code is optional.

## Product surfaces

### Space Learning tab

A Space-level tab should show:

- recent episodes,
- top lessons,
- workflow variants,
- pending suggestions,
- product feedback,
- target artifact follow-ups,
- enabled evolution policies.

### Run Episode view

Each run should show:

- selected StrategyCard,
- outcome score,
- what worked,
- what failed,
- findings by domain,
- generated lessons,
- proposed follow-ups,
- evidence artifacts.

### Workflow Variants view

For each workflow:

- current promoted version,
- candidate variants,
- lineage graph,
- scores,
- validation status,
- promotion/rejection controls.

### HyperNeo Product Feedback inbox

For HyperNeo product findings:

- local feedback item,
- issue draft,
- GitHub issue status,
- linked episodes,
- deduplication against prior findings.

## Validation suites

Self-evolution needs held-out tests.

For HyperNeo-on-HyperNeo:

- old bugfix tasks,
- UI tasks,
- workflow tasks,
- PR review tasks,
- paper research tasks,
- E2E health checks,
- daemon unit tests,
- message composition tests,
- gate transition tests.

For external repos:

- target repo tests,
- lint/typecheck/build,
- user-provided smoke tests,
- replayed prior task specs.

For non-coding work:

- rubric consistency checks,
- checklist completeness,
- source citation checks,
- artifact schema validation,
- human acceptance.

## Safety model

The system should be self-evolving, not self-unbounded.

Fixed by default:

- tool permission policies,
- autonomy thresholds,
- protected branch rules,
- evaluator/scorer implementation,
- promotion gates,
- GitHub publishing permissions,
- external side effects.

Mutable under policy:

- workflow prompts,
- StrategyCard templates,
- artifact schemas,
- reviewer checklists,
- memory retrieval queries,
- workflow variants,
- issue templates,
- target artifacts.

High-risk actions require human approval:

- creating public issues,
- opening PRs,
- changing HyperNeo code outside HyperNeo-on-HyperNeo mode,
- changing gates or autonomy,
- changing tool permissions,
- promoting workflow variants globally.

## Success metrics and 100x contract

The system needs measurable success criteria. Otherwise it will optimize for plausible stories instead of real improvement.

The 100x target should be interpreted as compound operational leverage, not one metric improving by 100x. Useful metrics include:

### Workflow metrics

- task success rate,
- human rejection rate,
- median time to accepted output,
- cost per accepted task,
- clarification loops per task,
- repeated failure recurrence,
- gate failure rate by gate type,
- artifact completeness rate,
- reviewer rework count,
- percentage of runs with usable lessons.

### Target artifact metrics

For codebases:

- tests passing,
- lint/typecheck/build success,
- defect recurrence,
- PR review rework,
- time from issue to merged fix,
- number of follow-up bugs caused by generated patches.

For non-code artifacts:

- human acceptance rate,
- citation completeness,
- rubric consistency,
- process checklist completion,
- dataset validation rate,
- number of repeated manual steps eliminated.

### HyperNeo product metrics

- repeated product friction clusters,
- product finding dedupe rate,
- issue draft to issue conversion rate,
- issue to fix latency,
- before/after impact of product fixes,
- number of runs affected by a promoted HyperNeo improvement.

Each promoted workflow variant, lesson, product change, or target artifact improvement should have a before/after view. The system should show whether the improvement actually improved later runs.

## Evaluation splits and anti-overfitting

Self-evolving systems can overfit their own evaluator. HyperNeo Forge should separate evidence used to generate improvements from evidence used to promote them.

Episode pools:

1. **Training episodes** — used to propose lessons, mutations, and product findings.
2. **Validation episodes** — used to decide whether a candidate should be promoted.
3. **Held-out benchmark episodes** — never used to generate mutations; used only for periodic evaluation.
4. **Shadow evaluations** — run a candidate workflow beside the current workflow on low-risk tasks before promotion.

Promotion rule:

```text
No workflow variant can be promoted using only the episodes that generated it.
```

For HyperNeo-on-HyperNeo, held-out tasks should include old bugfixes, UI tasks, PR review tasks, paper research tasks, workflow tasks, and E2E health-check tasks. For external repos, held-out validation should use target repo tests and user-provided smoke tests. For non-coding work, held-out validation should use rubric consistency, citation checks, and human acceptance.

## Threat model

Forge creates durable memory and self-improvement paths, so it needs explicit defenses.

Primary threats:

- prompt injection in artifacts becomes durable lesson poisoning,
- malicious external repo causes HyperNeo product issue spam,
- external project tricks HyperNeo into mutating itself,
- poisoned workflow variant weakens gates,
- candidate variant games evaluator instead of improving work,
- self-generated GitHub issue leaks private context,
- cross-space memory leakage,
- target repo secrets included in episodes,
- agent learns an unsafe workaround as a lesson,
- repeated low-quality episodes drown out high-quality signal.

Required rules:

```text
- Lessons from untrusted workspaces cannot affect global HyperNeo behavior.
- External repo episodes cannot create HyperNeo issues without redaction and approval.
- Raw secrets must never be stored in EvolutionEpisode.
- Workflow variants cannot modify evaluator, permissions, autonomy, or publishing paths.
- Public issue/PR generation must pass evidence redaction.
- Cross-space transfer is opt-in and scoped.
- Poisoned episodes can be marked invalid and all derived lessons/mutations can be retired.
```

Episode Judge output should include a trust level:

```ts
type EpisodeTrustLevel = 'trusted' | 'workspace_local' | 'untrusted' | 'poisoned';
```

Only trusted or workspace-local episodes can create active lessons. Untrusted episodes can create suggestions, but they cannot affect global workflow behavior.

## Transfer scope and privacy

Hyperagents show that meta-level improvements can transfer across domains. HyperNeo should support transfer, but scoped by privacy and trust.

Lesson scopes:

1. **Run-local** — usable only for current run continuation.
2. **Space-local** — default; usable only inside current Space.
3. **Project-local** — usable for a specific repo or artifact collection.
4. **User-private** — usable across user Spaces.
5. **Organization-shared** — usable across approved team Spaces.
6. **Global template** — bundled or recommended workflow improvement.

Promotion path:

```text
space-local → project-local → user-private / organization-shared → global template
```

Each promotion step requires stronger evidence, redaction, conflict checks, and approval. Public/global lessons should not contain private repo names, file paths, customer names, secrets, or proprietary details.

Default retention policy should store summaries and references, not full raw traces. Full trace storage should be opt-in, time-limited, and deletable.

## Strategy checkpoints

StraTA uses a fixed strategy for a rollout, but its own limitations note that fixed strategies can become restrictive when conditions change. HyperNeo should start with a StrategyCard, then allow controlled revision at checkpoints.

Checkpoint triggers:

- gate failure,
- test/build failure,
- reviewer rejection,
- unexpected tool failure,
- cost threshold crossed,
- task scope change,
- repeated failed action pattern,
- user correction.

At a checkpoint, HyperNeo chooses:

```text
continue current strategy
revise strategy
switch workflow
ask human
stop and summarize blocker
```

A StrategyCard revision should be recorded as a new version, not overwrite the original. Episode scoring should distinguish initial strategy quality from revision quality.

## Workflow selector

Selecting the wrong workflow can sink a task before execution begins. Workflow selection should be first-class evidence.

```ts
type WorkflowSelectionDecision = {
	id: string;
	taskFingerprint: string;
	candidateWorkflowIds: string[];
	selectedWorkflowId: string;
	reason: string;
	confidence: number;
	alternatives: string[];
	createdAt: string;
};
```

The Episode Judge should score workflow fit separately from strategy fit and execution quality.

## Variant parent selection

The WorkflowVariant archive should not always mutate the current best variant. It should balance exploitation and exploration, similar to DGM-H.

Parent selection should consider:

- performance,
- safety pass rate,
- novelty,
- under-explored lineage,
- recency,
- cost efficiency,
- complexity penalty.

Example scoring shape:

```text
parentWeight =
  performanceScore
  × safetyPassRate
  × noveltyBonus
  × underExploredLineageBonus
  × costEfficiency
  × complexityPenalty
```

This avoids local optima and keeps the archive from repeatedly exploiting one lineage.

## Workflow complexity budget

Learning Beyond Gradients warns that uncompressed heuristic systems become unmaintainable. HyperNeo should score workflow complexity and reject variants that add too much complexity for too little gain.

Complexity signals:

- workflow node count,
- gate count,
- artifact schema count,
- prompt length,
- injected lesson count,
- tool count,
- cross-node dependencies,
- number of strategy checkpoints,
- number of conditional branches,
- observed interaction bugs.

Promotion should consider a complexity budget:

```text
Reject candidate if it improves success by 2% but increases complexity by 40%, unless a human marks the task class high-impact enough to justify it.
```

Periodic compression should simplify workflows by merging redundant gates, deleting stale lessons, shrinking prompts, and replacing repeated instructions with artifact schemas or tests.

## Lesson lifecycle

WorkflowLessons need lifecycle states, not just create/update.

```ts
type WorkflowLessonStatus =
	| 'candidate'
	| 'active'
	| 'challenged'
	| 'deprecated'
	| 'archived';
```

Lifecycle:

1. **candidate** — extracted from one or more episodes, not injected by default.
2. **active** — validated enough to inject into future runs.
3. **challenged** — contradicted by later evidence or user feedback.
4. **deprecated** — replaced by a better lesson or no longer useful.
5. **archived** — retained for audit, never injected.

Conflict rule:

```text
If two active lessons conflict, inject neither automatically. Route conflict to review.
```

Retirement triggers:

- contradicted by later episode,
- stale after time,
- low retrieval usefulness,
- causes regression,
- superseded by broader lesson,
- user dismisses it repeatedly.

## Human feedback capture

Approval and rejection are not enough. Forge should capture structured human feedback.

For rejected or edited outputs, collect:

- rejection category,
- missing requirement,
- incorrect assumption,
- bad artifact,
- poor verification,
- unsafe action,
- style mismatch,
- reviewer note,
- accepted correction or diff.

This structured feedback should feed Episode Judge, but only after redaction and trust checks.

## Target artifact evaluators

Non-coding work needs evaluators too. Forge should use a plugin-shaped evaluator model by target artifact kind.

```ts
type ArtifactEvaluator = {
	kind: TargetArtifactKind;
	validate(artifactId: string, evidence: unknown): EvaluationResult;
	suggestRegressionCases(episode: EvolutionEpisode): RegressionCase[];
};
```

Examples:

- codebase evaluator: tests, lint, typecheck, build, smoke tests,
- research evaluator: citation coverage, contradiction checks, rubric completeness,
- process evaluator: checklist coverage, stakeholder acceptance,
- dataset evaluator: schema validation, row-level checks, drift checks,
- document evaluator: style, completeness, source traceability.

## Provenance and rollback

Every durable improvement needs traceability.

Provenance chain:

```text
episode → finding → lesson → mutation → variant → promotion → later outcomes
```

Rollback must support:

- retiring a lesson,
- reverting a promoted workflow variant,
- marking an episode poisoned,
- removing derived candidate mutations,
- closing or superseding generated issue drafts,
- reverting HyperNeo product settings.

If an episode is marked poisoned, all derived lessons and mutations should move to challenged or archived until reviewed.

## GitHub issue generation controls

HyperNeo product issue generation should be conservative.

Controls:

- cluster similar findings before creating issues,
- require repeated evidence or high impact,
- draft before publish,
- rate-limit issue creation,
- redact private context,
- score reproduction completeness,
- dedupe against open issues,
- link internal episode IDs only in private metadata,
- require approval before posting to public GitHub.

Issue drafts should include:

- problem statement,
- observed evidence,
- reproduction steps if available,
- expected improvement,
- affected workflow,
- impact estimate,
- redaction status.

## Mission and Goal integration

HyperNeo’s Mission/Goal system provides natural long-horizon feedback. Forge should treat mission executions as episode groups.

Integration points:

- each mission execution can create one or more EvolutionEpisodes,
- recurring missions provide repeated evaluation for workflow variants,
- measurable missions provide objective success signals,
- mission events can become long-horizon evidence,
- mission rollups can detect whether a promoted lesson improves outcomes over weeks.

For long-running goals, Forge should produce both per-run episodes and aggregate goal-level learning summaries.

## UI transparency

Users should be able to see why HyperNeo changed behavior.

When HyperNeo injects a lesson or selects a workflow variant, UI should show:

- which lesson or variant was used,
- confidence,
- evidence count,
- source scope,
- dismiss button,
- “do not use this again” control,
- link to episode evidence if permitted.

This avoids mysterious behavior changes and gives users control over bad lessons.

## Cost budget

Learning can become expensive. Each Space should enforce a learning budget.

Budget controls:

- max strategies per task,
- max episode-judge calls per run,
- max mutation validations per day,
- max issue drafts per day,
- max learning tokens per day,
- high-value-only parallel strategy mode.

If budget is exhausted, Forge should still record minimal evidence but skip expensive strategy diversity, mutation generation, and shadow evaluation.

## Self-PR isolation

HyperNeo self-PR mode needs strict isolation.

Rules:

- HyperNeo self-PRs always run in a separate worktree.
- Target repo PR and HyperNeo PR must never share a branch.
- External repo work cannot silently switch into HyperNeo code mutation.
- HyperNeo code changes require tests tied to finding type.
- Self-PR mode requires explicit Space policy.
- PR creation still requires human approval unless policy explicitly allows it.

## Implementation sequence

### Milestone 1: Episode recorder

Add durable recording of completed workflow runs.

Deliverables:

- `EvolutionEpisode` storage,
- episode summarizer,
- score skeleton,
- evidence collection from artifacts/gates/task state,
- UI episode view.

Value:

- immediate visibility,
- no risky mutation,
- foundation for learning.

### Milestone 2: StrategyCards

Add StraTA-inspired strategy generation before workflow execution.

Deliverables:

- candidate strategy generation,
- strategy selection,
- StrategyCard storage,
- message injection,
- strategy adherence judgment.

Value:

- better task framing,
- better reviewer expectations,
- better credit assignment.

### Milestone 3: WorkflowLessons

Add compressed lessons from episodes.

Deliverables:

- lesson extraction,
- evidence-backed memory writes,
- retrieval for similar tasks,
- message injection,
- lesson decay/merge rules.

Value:

- compounding improvement with low risk.

### Milestone 4: Evolution Router

Split findings into workflow, target artifact, and HyperNeo product domains.

Deliverables:

- `EvolutionFinding`,
- routing by Space policy,
- suggestion/task/issue draft creation,
- local HyperNeo product feedback inbox.

Value:

- supports all three use cases cleanly.

### Milestone 5: Workflow Variant Archive

Add Hyperagent-style archive for workflow variants.

Deliverables:

- variant storage,
- typed mutations,
- lineage,
- validation status,
- compare/promote UI.

Value:

- workflow evolution becomes explicit and auditable.

### Milestone 6: Guarded mutation and promotion

Allow agents to propose workflow mutations, validate them, and promote with review.

Deliverables:

- mutation generator,
- mutation validator,
- replay/regression suite,
- promotion gate,
- rollback.

Value:

- real self-improvement without uncontrolled self-modification.

### Milestone 7: HyperNeo issue generation flag

For external repo and non-coding modes, allow HyperNeo product findings to become GitHub issues.

Deliverables:

- flag in Space settings,
- issue draft format,
- dedupe,
- user approval path,
- GitHub integration.

Value:

- HyperNeo learns from all use, not only HyperNeo-on-HyperNeo development.

### Milestone 8: HyperNeo self-PR mode

For HyperNeo-on-HyperNeo spaces, allow product findings to become code changes.

Deliverables:

- separate worktree policy,
- tests required by finding type,
- PR creation path,
- stricter approval.

Value:

- full self-hosted improvement loop.

## Minimal prototype

The smallest useful version is:

```text
For every completed workflow run:
1. create a redacted EvolutionEpisode summary
2. judge Strategy / Outcome / Failures / Lessons
3. assign trust level and evolution scope
4. split findings into workflow / target / HyperNeo domains
5. store candidate WorkflowLessons with evidence links
6. retrieve active relevant lessons for the next similar task
7. show HyperNeo product findings in a local feedback inbox
8. allow user to dismiss bad lessons or mark episodes poisoned
```

This does not require autonomous mutation. It creates the data flywheel first.

## Why this can produce 100x results

The multiplier comes from compounding, not magic.

A single good lesson can affect hundreds of future runs. A single fixed workflow gate can prevent repeated review failures. A single artifact schema can make every future run easier to judge. A single HyperNeo issue generated from repeated friction can remove a product bottleneck for all users.

The system compounds because every run can generate reusable assets:

- strategies,
- lessons,
- replay cases,
- gate improvements,
- artifact schemas,
- workflow variants,
- target follow-ups,
- HyperNeo product feedback,
- tests,
- issues,
- PRs.

This is the shared thread across StraTA, Learning Beyond Gradients, and Hyperagents:

- **StraTA** teaches HyperNeo to separate strategy from execution.
- **Learning Beyond Gradients** teaches HyperNeo to maintain explicit artifacts, tests, memory, and compression loops.
- **Hyperagents** teaches HyperNeo to archive and evolve improvement procedures themselves, but under fixed evaluation and safety boundaries.

## Final architecture principle

HyperNeo should not only run agents. HyperNeo should maintain the system around agents.

That system includes workflows, strategies, target artifacts, product feedback, memories, gates, tests, and promotion rules.

The durable product is not one successful run. The durable product is a better HyperNeo after every validated learning cycle.
