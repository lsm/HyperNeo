# Scoped Self-Evolve Engine

## Purpose

NeoKai Forge should not be limited to improving workflows or codebases. It should be a general self-evolution engine that can attach to any long-horizon objective.

The user may want to improve:

- a codebase,
- a workflow,
- a product,
- a marketing campaign,
- a research program,
- a business process,
- a personal knowledge system,
- a community growth loop,
- a hiring pipeline,
- a documentation system,
- a multi-month mission.

The self-evolve system should work across all of these by separating **scope** from **domain**.

## Core idea

The engine should be conceptualized as:

```text
SelfEvolveEngine(scope)
```

A scope defines what objective is being improved. Inside that scope, the engine can improve workflows, target artifacts, and NeoKai itself.

Previous framing:

```text
workflow run → workflow improvement
```

More general framing:

```text
scoped objective → evidence → episode → findings → scoped improvements
```

The system is no longer only “learn from workflow runs.” It becomes “learn from any evidence attached to an objective.”

## EvolutionScope

The top-level abstraction is **EvolutionScope**.

```ts
type EvolutionScopeKind =
	| 'task'
	| 'workflow'
	| 'space'
	| 'project'
	| 'mission'
	| 'campaign'
	| 'research_program'
	| 'business_process'
	| 'community'
	| 'personal_system'
	| 'custom';

type EvolutionScope = {
	id: string;
	kind: EvolutionScopeKind;
	name: string;
	objective: string;
	parentScopeId?: string;
	childScopeIds: string[];
	metricDefinitions: MetricDefinition[];
	artifactKinds: TargetArtifactKind[];
	evidenceSources: EvidenceSource[];
	evolutionPolicy: SpaceEvolutionPolicy;
	retentionPolicy: EvolutionRetentionPolicy;
	evaluatorIds: string[];
	createdAt: string;
	updatedAt: string;
};
```

The scope answers:

- What are we trying to improve?
- What metrics define progress?
- What evidence sources matter?
- What artifacts can change?
- Which policies govern changes?
- Which memories belong here?
- Which child scopes inherit or report to this scope?

## Scope versus domain

A scope is the objective boundary. A domain is the kind of improvement inside that objective.

Domains remain:

1. **Workflow Evolution** — improve how agents do work.
2. **Target Artifact Evolution** — improve the thing being worked on.
3. **NeoKai Product Evolution** — improve NeoKai itself.

A single scope can produce findings in all three domains.

Example:

```text
Scope: Grow NeoKai to 100k GitHub stars

Workflow finding:
- Launch retrospectives need metric snapshots before strategy review.

Target artifact finding:
- README intro does not show concrete product value quickly enough.

NeoKai product finding:
- NeoKai needs a campaign dashboard that links tasks, content, and metrics.
```

## Scope hierarchy

Long-horizon work naturally decomposes into nested scopes.

Example hierarchy:

```text
Global NeoKai
└── Mission: Grow NeoKai to 100k GitHub stars
    ├── Campaign: Hacker News launch
    ├── Campaign: README conversion improvement
    ├── Campaign: Developer demo videos
    ├── Campaign: Community outreach
    ├── Project: Website/docs polish
    └── Workflow: Marketing content production
```

Each child scope can run its own episodes and maintain its own lessons. Important lessons can roll up to the parent scope after validation.

Learning flow:

```text
task lesson → campaign lesson → mission lesson → product lesson
```

Promotion across scope boundaries requires stronger validation, redaction, and human approval.

## Long-horizon marketing example: 100k GitHub stars

A user creates a mission scope:

```ts
const scope: EvolutionScope = {
	id: 'scope_neokai_100k_stars',
	kind: 'campaign',
	name: 'Get NeoKai to 100k GitHub stars',
	objective:
		'Grow NeoKai GitHub repository to 100,000 stars through sustained product, content, community, and distribution work.',
	parentScopeId: 'scope_neokai_product',
	childScopeIds: [],
	metricDefinitions: [
		{ key: 'github_stars', label: 'GitHub stars', direction: 'increase' },
		{ key: 'weekly_star_growth', label: 'Weekly star growth', direction: 'increase' },
		{ key: 'visitor_to_star_conversion', label: 'Visitor to star conversion', direction: 'increase' },
		{ key: 'content_impressions', label: 'Content impressions', direction: 'increase' },
		{ key: 'launch_conversion', label: 'Launch conversion', direction: 'increase' },
		{ key: 'community_mentions', label: 'Community mentions', direction: 'increase' },
		{ key: 'issue_engagement', label: 'Issue engagement', direction: 'increase' },
		{ key: 'contributor_retention', label: 'Contributor retention', direction: 'increase' },
	],
	artifactKinds: ['documents', 'knowledge_graph', 'process', 'tooling', 'mixed'],
	evidenceSources: [],
	evolutionPolicy: defaultCampaignEvolutionPolicy,
	retentionPolicy: defaultCampaignRetentionPolicy,
	evaluatorIds: ['campaign_evaluator', 'content_evaluator', 'product_growth_evaluator'],
	createdAt: now,
	updatedAt: now,
};
```

The engine then treats campaign work as an evolving system.

Loop:

```text
goal: 100k GitHub stars
→ generate campaign strategy
→ create and run tasks
→ collect campaign evidence
→ judge campaign episode
→ extract lessons
→ update strategy
→ create next tasks
→ route product findings into NeoKai issues or PRs
→ repeat weekly
```

Tasks under the scope might include:

- improve README first screen,
- write launch post,
- publish demo video,
- contact specific communities,
- analyze traffic sources,
- compare competitor positioning,
- collect user objections,
- improve onboarding flow,
- build landing page,
- create social clips,
- run documentation polish sprint,
- review GitHub issue engagement.

Evidence sources might include:

- GitHub star history,
- GitHub traffic and referrers,
- website analytics,
- social post metrics,
- community comments,
- Discord/Slack feedback,
- GitHub issues,
- user interviews,
- task outputs,
- conversations,
- campaign retrospectives,
- competitor analysis,
- product demo recordings.

## Evidence model

A scoped engine must accept evidence from many sources, not only workflow runs.

```ts
type EvidenceSourceKind =
	| 'workflow_run'
	| 'task'
	| 'session'
	| 'conversation'
	| 'metric_snapshot'
	| 'external_event'
	| 'manual_note'
	| 'document'
	| 'github'
	| 'analytics'
	| 'social'
	| 'survey'
	| 'interview';

type EvidenceSource = {
	id: string;
	scopeId: string;
	kind: EvidenceSourceKind;
	name: string;
	config: unknown;
	trustLevel: EpisodeTrustLevel;
	redactionPolicyId?: string;
};

type EvidenceRef = {
	id: string;
	sourceId: string;
	kind: EvidenceSourceKind;
	uri?: string;
	timeRange?: { start: string; end: string };
	summary: string;
	redactionStatus: 'not_needed' | 'pending' | 'redacted';
};
```

This lets the engine attach many kinds of information to the same objective.

Examples:

```text
conversation → user says README feels too abstract
metric_snapshot → weekly stars dropped after launch
social → demo clip got high saves but low GitHub clicks
workflow_run → docs polish task completed
manual_note → HN commenters ask for architecture diagram
```

## Scoped episode model

A workflow run is only one possible episode source. A scoped episode can summarize a week, a campaign experiment, a research sprint, or a task sequence.

```ts
type ScopedEvolutionEpisode = {
	id: string;
	scopeId: string;
	source:
		| 'workflow_run'
		| 'task'
		| 'session'
		| 'conversation'
		| 'metric_snapshot'
		| 'external_event'
		| 'manual_note'
		| 'rollup';
	timeWindow?: { start: string; end: string };
	evidence: EvidenceRef[];
	outcome: OutcomeSummary;
	metricDeltas: MetricDelta[];
	findings: EvolutionFinding[];
	lessons: EvolutionMemory[];
	nextActions: TaskProposal[];
	createdAt: string;
};
```

For a long-horizon marketing goal, the natural unit may be a weekly rollup:

```text
Campaign episode: Week of 2026-05-18
Evidence:
- GitHub stars +430
- launch post got 80k impressions
- README clickthrough improved after GIF added
- user comments show confusion about Spaces vs Sessions
Findings:
- demo-first messaging performs better than architecture-first messaging
- onboarding docs need a clearer “first 5 minutes” path
Next actions:
- produce 90-second Spaces demo
- rewrite README first section
- create issue for onboarding telemetry
```

## Scoped memories

WorkflowLessons are too narrow for arbitrary scopes. The engine needs a broader memory union.

```ts
type EvolutionMemory =
	| WorkflowLesson
	| CampaignLesson
	| ProductLesson
	| AudienceInsight
	| ChannelInsight
	| CompetitorInsight
	| ExperimentResult
	| MetricAnomaly
	| StrategicDecision;
```

### CampaignLesson

```ts
type CampaignLesson = {
	id: string;
	scopeId: string;
	status: WorkflowLessonStatus;
	audience?: string;
	channel?: string;
	rule: string;
	why: string;
	evidenceEpisodeIds: string[];
	confidence: number;
	createdAt: string;
	updatedAt: string;
};
```

Example:

```text
For launch posts, short demo GIF above the fold outperforms architecture-heavy intros.
Why: two prior campaign episodes showed higher GitHub clickthrough when the first screen showed product use, not internals.
How to apply: future launch content should open with a concrete UI demo and one-sentence value proposition.
```

### AudienceInsight

```ts
type AudienceInsight = {
	id: string;
	scopeId: string;
	audience: string;
	insight: string;
	evidenceEpisodeIds: string[];
	confidence: number;
};
```

Example:

```text
Developer-tool users respond strongly to “multi-session Claude Code UI” but need concrete screenshots before understanding “Space workflows.”
```

### ExperimentResult

```ts
type ExperimentResult = {
	id: string;
	scopeId: string;
	hypothesis: string;
	action: string;
	metricDeltas: MetricDelta[];
	result: 'supported' | 'not_supported' | 'inconclusive';
	lesson?: string;
};
```

Example:

```text
Hypothesis: README demo GIF above fold increases visitor-to-star conversion.
Action: Add 12-second GIF and shorten first paragraph.
Result: supported.
Metric delta: conversion increased from 3.1% to 4.8% over 7 days.
```

## Metrics

Scopes need objective-specific metrics.

```ts
type MetricDirection = 'increase' | 'decrease' | 'target' | 'maintain';

type MetricDefinition = {
	key: string;
	label: string;
	description?: string;
	direction: MetricDirection;
	targetValue?: number;
	unit?: string;
};

type MetricSnapshot = {
	id: string;
	scopeId: string;
	capturedAt: string;
	values: Record<string, number>;
	source: string;
};

type MetricDelta = {
	metricKey: string;
	before?: number;
	after?: number;
	delta?: number;
	window: { start: string; end: string };
	confidence: number;
};
```

For 100k GitHub stars, metric snapshots might track:

- total stars,
- stars/day,
- stars/week,
- GitHub profile views,
- repo visitors,
- referrer sources,
- README conversion,
- issue engagement,
- contributor conversion,
- community mentions.

## Experiments

Long-horizon objectives need explicit experiments.

```ts
type EvolutionExperiment = {
	id: string;
	scopeId: string;
	hypothesis: string;
	plannedAction: string;
	ownerTaskIds: string[];
	metricKeys: string[];
	startAt?: string;
	endAt?: string;
	status: 'planned' | 'running' | 'completed' | 'cancelled';
	result?: ExperimentResult;
};
```

Experiment examples:

```text
Hypothesis: A short demo video improves star conversion more than a long architecture post.
Action: publish 90-second demo and compare referrer conversion over one week.
Metrics: GitHub stars, visitor-to-star conversion, social saves.
```

```text
Hypothesis: “Claude Code desktop UI” positioning is clearer than “AI workspace runtime.”
Action: A/B test landing page headline in campaign posts.
Metrics: clickthrough rate, star conversion, comment confusion rate.
```

## Task proposal generation

A scoped engine should not only summarize. It should propose next actions.

```ts
type TaskProposal = {
	id: string;
	scopeId: string;
	title: string;
	description: string;
	domain: EvolutionDomain;
	reason: string;
	expectedImpact: 'low' | 'medium' | 'high';
	evidenceEpisodeIds: string[];
	priority: 'low' | 'normal' | 'high' | 'urgent';
	canAutoCreate: boolean;
};
```

For the 100k-star campaign, task proposals might be:

- Rewrite README intro around a 12-second demo GIF.
- Create “first 5 minutes with NeoKai” quickstart.
- Publish comparison post: NeoKai vs terminal-only Claude Code workflows.
- Build lightweight analytics dashboard for star/referrer trend.
- Create GitHub issue for confusing onboarding state discovered from comments.
- Interview 5 users who starred but did not try the app.

## Scope evaluators

Each scope kind needs evaluators. The evaluator maps evidence to score, lessons, and next actions.

```ts
type ScopeEvaluator = {
	id: string;
	supportedScopeKinds: EvolutionScopeKind[];
	judgeEpisode(episode: ScopedEvolutionEpisode): EvaluationResult;
	extractLessons(episode: ScopedEvolutionEpisode): EvolutionMemory[];
	suggestNextActions(episode: ScopedEvolutionEpisode): TaskProposal[];
};
```

### Campaign evaluator

For growth or marketing campaigns:

- reads metric snapshots,
- compares expected versus actual metric deltas,
- identifies channel performance,
- extracts audience insights,
- detects message-market fit signals,
- proposes campaign experiments,
- routes product blockers into NeoKai product findings.

### Research evaluator

For paper/research programs:

- checks source coverage,
- identifies unresolved questions,
- extracts taxonomy changes,
- detects contradictory claims,
- updates graph/rubric,
- proposes next papers or experiments.

### Business process evaluator

For operational processes:

- checks cycle time,
- bottlenecks,
- handoff quality,
- error recurrence,
- checklist completion,
- proposes process changes.

### Code/project evaluator

For software projects:

- checks tests,
- build status,
- bug recurrence,
- review feedback,
- issue velocity,
- architectural drift,
- proposes code/docs/process tasks.

## Scope policies

Different scopes have different blast radius.

Example policy for marketing campaign:

```text
workflow: create_task
targetArtifact: create_artifact / create_task
neokaiProduct: create_issue draft only
allowPublicPosting: false by default
allowNeoKaiCodeChanges: false
allowWorkflowVariantPromotion: true with review
learningBudget: weekly campaign review + 3 experiments
```

Example policy for NeoKai-on-NeoKai engineering mission:

```text
workflow: create_pr with review
targetArtifact: create_pr
neokaiProduct: create_pr
allowNeoKaiCodeChanges: true
allowWorkflowVariantPromotion: true with validation
learningBudget: high
```

Example policy for private research program:

```text
workflow: suggest
targetArtifact: create_artifact
neokaiProduct: observe_only
allowCrossScopeTransfer: false
retention: summaries only
```

## Rollups

Long-horizon scopes need rollups at a cadence.

Rollup types:

- daily task rollup,
- weekly campaign review,
- monthly mission review,
- milestone retrospective,
- metric anomaly review,
- post-launch retrospective.

Rollup output:

```text
- what changed?
- what worked?
- what failed?
- which metrics moved?
- which lessons should be active?
- which assumptions were invalidated?
- what should we try next?
- what should we stop doing?
- what product/workflow changes are blocking progress?
```

For the 100k-star mission, weekly rollups are probably the most important loop.

## Relationship to missions and goals

NeoKai’s Mission/Goal system is the natural home for long-horizon scopes.

A Mission can own an EvolutionScope:

```text
Mission: Grow NeoKai to 100k GitHub stars
EvolutionScope: same objective, metrics, evidence sources, policies
```

Mission executions become scoped episodes. Recurring missions become recurring rollups. Measurable missions provide metric definitions and success signals.

This makes Mission/Goal V2 more than task scheduling. It becomes long-horizon learning infrastructure.

## Relationship to workflows

Workflows remain important, but they are child mechanisms, not the whole system.

A campaign scope may use many workflows:

- research workflow,
- content drafting workflow,
- review workflow,
- analytics workflow,
- product issue workflow,
- outreach workflow.

Forge should learn both:

1. which workflows work best for the scope,
2. how to improve each workflow.

## Relationship to NeoKai product evolution

Scoped objectives can produce NeoKai product findings.

For the 100k-star campaign, examples:

- product demo is hard to record because Spaces UI lacks a clean demo mode,
- onboarding lacks telemetry to measure conversion,
- GitHub issue importer would help turn campaign feedback into roadmap items,
- public docs generator is missing.

These should route to NeoKai product feedback. Under explicit policy, they can become GitHub issues or NeoKai PRs.

## Safety and privacy for broad scopes

Broad scopes collect broad evidence. This increases privacy risk.

Rules:

- each evidence source has a trust level,
- each evidence source has a redaction policy,
- cross-scope lesson promotion is opt-in,
- public outputs require redaction,
- private conversations should not become global lessons,
- campaign metrics can be shared more broadly than raw user interviews,
- external comments can be quoted only if source/publication policy allows it.

The scope should define retention:

```text
raw evidence retention: 30 days
summary retention: 1 year
metric snapshots: indefinite
private interview notes: no cross-scope transfer
public campaign metrics: shareable inside organization
```

## UI model

### Scope page

Each EvolutionScope should have a page showing:

- objective,
- metrics,
- recent metric snapshots,
- child scopes,
- active experiments,
- recent episodes,
- active lessons,
- proposed tasks,
- product findings,
- policy settings.

### Metric timeline

Shows progress over time:

- actual metric values,
- annotations for experiments,
- launches,
- product changes,
- workflow changes,
- anomalies.

### Episode timeline

Shows evidence and learning:

```text
Week 1: README rewrite experiment
Week 2: HN launch
Week 3: onboarding polish
Week 4: demo video campaign
```

### Lessons board

Shows scoped memories:

- active,
- candidate,
- challenged,
- deprecated.

### Next actions board

Shows generated TaskProposals with controls:

- accept,
- edit,
- schedule,
- assign workflow,
- dismiss,
- convert to issue.

## Implementation sequence

### Milestone 1: Scope abstraction

Add EvolutionScope model and associate it with Missions, Spaces, workflows, and tasks.

Deliverables:

- scope table,
- parent/child scope relationship,
- basic UI page,
- policy fields,
- metric definitions.

### Milestone 2: Evidence attachment

Allow tasks, sessions, conversations, metric snapshots, and manual notes to attach to a scope.

Deliverables:

- EvidenceSource,
- EvidenceRef,
- redaction status,
- trust level,
- source timeline.

### Milestone 3: Scoped episodes

Create episodes from workflow runs and manual rollups.

Deliverables:

- ScopedEvolutionEpisode,
- weekly rollup generator,
- findings and lessons attached to scope.

### Milestone 4: Scope evaluators

Add evaluator interface and first evaluators.

Deliverables:

- code/project evaluator,
- campaign evaluator,
- research evaluator,
- process evaluator skeleton.

### Milestone 5: Metrics and experiments

Add metrics and experiment tracking.

Deliverables:

- MetricSnapshot,
- MetricDelta,
- EvolutionExperiment,
- experiment timeline annotations.

### Milestone 6: Task proposals

Generate next actions from scoped episodes.

Deliverables:

- TaskProposal,
- accept/edit/dismiss controls,
- conversion to SpaceTask or GitHub issue.

### Milestone 7: Cross-scope promotion

Allow validated lessons to move from child scope to parent scope or from Space-local to organization-shared.

Deliverables:

- promotion workflow,
- redaction checks,
- conflict checks,
- provenance chain.

## Minimal version for the 100k-star goal

Smallest useful version:

1. Create campaign EvolutionScope linked to a Mission.
2. Track GitHub stars manually or via metric snapshots.
3. Attach campaign tasks and conversations to the scope.
4. Run weekly rollup episode.
5. Extract campaign lessons and next task proposals.
6. Route product blockers to NeoKai product feedback.
7. Show metrics + lessons + next actions on scope page.

This gives a real long-horizon learning loop without requiring autonomous mutation.

## Final architecture principle

NeoKai Forge should be a scoped self-evolution engine for any long-horizon objective.

Workflow improvement is one domain inside the engine, not the engine itself.

The general loop is:

```text
scope objective
→ scoped evidence
→ scoped episode
→ scoped findings
→ scoped memories and task proposals
→ validated improvements
→ next evidence cycle
```

This lets NeoKai improve code projects, marketing campaigns, research programs, business processes, and NeoKai itself using one shared substrate.
