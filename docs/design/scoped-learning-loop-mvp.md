# Scoped Learning Loop MVP

## Purpose

This document defines the MVP for HyperNeo Forge: a scoped self-evolution system that is useful end-to-end without requiring autonomous workflow mutation, self-PRs, or complex archive evolution.

The target is pragmatic:

```text
2x implementation effort → 10x practical result
```

The MVP should make HyperNeo meaningfully better by preserving learning across tasks, sessions, and long-horizon goals.

## MVP thesis

The first version should not be an autonomous self-mutation system.

It should be a **scoped evidence → episode → lesson → next task** loop.

Core loop:

```text
Scope created
→ task/session linked to scope
→ workflow runs normally
→ run completes
→ Forge creates Episode Summary
→ Episode Judge extracts findings, lessons, and next actions
→ user reviews/accepts
→ accepted lessons inject into next related task
→ accepted next actions become SpaceTasks
→ scope page shows learning over time
```

This gives compounding continuity without high safety risk.

## MVP promise

After using HyperNeo for real work, users should get clear answers to:

1. What did we learn?
2. What should we do next?
3. What should future agents remember?
4. What product or workflow friction kept recurring?
5. Is this long-horizon goal moving?

The current failure mode of agent systems is that learning evaporates between runs. The MVP fixes that.

## What is intentionally excluded

The MVP should not include:

- automatic workflow mutation,
- workflow variant archive,
- self-PR mode,
- GitHub issue auto-publishing,
- cross-scope lesson promotion,
- complex parent selection,
- full graph UI,
- automatic metric integrations,
- autonomous campaign execution,
- raw transcript mining at scale.

These belong in later versions after the basic learning loop proves useful.

## Why this can deliver 10x result

The MVP creates compounding value by making work persistent and reusable.

Without Forge:

```text
task completes
→ context disappears
→ next agent relearns same lesson
→ repeated failures recur
```

With Forge MVP:

```text
task completes
→ episode captures outcome
→ lesson is accepted
→ next task receives relevant lesson
→ next actions are proposed
→ scope accumulates progress
```

The 10x result comes from:

- fewer repeated mistakes,
- less manual handoff,
- faster next-task generation,
- better long-horizon continuity,
- reusable lessons,
- visible progress against objectives,
- product/workflow friction becoming visible.

## Why this is roughly 2x implementation effort

The MVP reuses existing HyperNeo primitives:

- Space tasks,
- workflow runs,
- artifacts,
- task creation,
- agent memory,
- Space-native recurring goals,
- linked goal check-in schedules,
- goal events,
- task message construction,
- Space UI patterns.

It mostly adds:

- a few tables,
- a Scope page,
- an Episode Judge service,
- lesson accept/dismiss flow,
- lesson injection into future scoped tasks,
- task proposal conversion.

It avoids major runtime rewrites.

## Existing recurring goal anchor

HyperNeo already has Space-native recurring goals that map well to the scoped learning loop.

Existing pieces:

- `space_goals.type` supports `recurring`.
- Goals can store `summary`, `progress`, `nextSteps`, `metrics`, and `preferredWorkflowId`.
- Goals can create linked check-in schedules through `checkInCronExpression`.
- Goal check-ins create SpaceTasks linked by `goalId`.
- Goal events track creation, updates, scheduled runs, triggered tasks, terminal tasks, and schedule changes.
- Goal task descriptions already include current summary and next steps.
- Terminal task handling can clear active tasks and queue/trigger next runs when `autoTriggerNext` is enabled.

This means the MVP does not need to invent a new long-horizon scheduler. It can attach `EvolutionScope` to existing recurring `SpaceGoal` records.

Recurring goal flow:

```text
Recurring SpaceGoal
→ scheduled check-in task
→ task/workflow runs normally
→ task reaches terminal state
→ Forge creates EvolutionEpisode
→ accepted lessons update scoped memory
→ accepted proposals become goal-linked SpaceTasks
→ rollup updates goal summary/progress/nextSteps
→ next scheduled check-in receives active lessons and updated context
```

For a campaign like “Grow HyperNeo to 100k GitHub stars,” the recurring goal can be weekly:

```text
Goal type: recurring
Check-in cadence: weekly
Task: review metrics, campaign evidence, lessons, and next actions
Forge output: episode, accepted lessons, proposed tasks, updated summary/progress/nextSteps
```

So `EvolutionScope` should be able to reference an existing `SpaceGoal`:

```ts
type EvolutionScope = {
	id: string;
	spaceGoalId?: string;
	kind: 'mission' | 'project' | 'campaign' | 'workflow' | 'custom';
	name: string;
	objective: string;
	parentScopeId?: string;
	metricDefinitions: MetricDefinition[];
	policy: EvolutionPolicy;
	createdAt: string;
	updatedAt: string;
};
```

In MVP terms, a recurring `SpaceGoal` can be the user-facing container and `EvolutionScope` can be the learning substrate attached to it.

## MVP primitives

The MVP needs five primitives:

1. EvolutionScope
2. EvidenceRef
3. EvolutionEpisode
4. EvolutionLesson
5. TaskProposal

## Primitive 1: EvolutionScope

EvolutionScope defines the objective being improved.

```ts
type EvolutionScope = {
	id: string;
	spaceGoalId?: string;
	kind: 'mission' | 'project' | 'campaign' | 'workflow' | 'custom';
	name: string;
	objective: string;
	parentScopeId?: string;
	metricDefinitions: MetricDefinition[];
	policy: EvolutionPolicy;
	createdAt: string;
	updatedAt: string;
};
```

MVP scope kinds:

- `mission` — long-horizon objective with repeated work.
- `project` — codebase, document set, or target artifact project.
- `campaign` — marketing/growth/community effort.
- `workflow` — specific process/workflow improvement.
- `custom` — fallback for user-defined goals.

### Example: 100k GitHub stars

```text
Scope: Grow HyperNeo to 100k GitHub stars
Kind: campaign
Objective: Reach 100k stars through product, content, community, and distribution work.
Metrics:
- github_stars
- weekly_star_growth
- content_impressions
- visitor_to_star_conversion
```

### Example: self-evolve MVP dogfood

```text
Scope: Build HyperNeo self-evolve system MVP
Kind: mission
Objective: Ship a usable scoped learning loop inside HyperNeo.
Metrics:
- completed MVP milestones
- number of accepted lessons reused
- repeated failure count
- time from task completion to next task creation
```

## Primitive 2: EvidenceRef

EvidenceRef attaches work and observations to a scope.

MVP evidence sources:

- completed SpaceTask,
- workflow run,
- conversation/session summary,
- manual note,
- metric snapshot.

```ts
type EvidenceRef = {
	id: string;
	scopeId: string;
	kind: 'task' | 'workflow_run' | 'session' | 'manual_note' | 'metric_snapshot';
	summary: string;
	sourceId?: string;
	createdAt: string;
};
```

### MVP UX

Users need simple actions:

- “Attach this task to scope”
- “Add note to scope”
- “Add metric snapshot”
- “Include this evidence in scope review”

Manual evidence is acceptable for MVP. Automatic integrations can come later.

## Primitive 3: EvolutionEpisode

EvolutionEpisode is the summarized learning unit.

It can be generated after:

- one completed task,
- one workflow run,
- a session,
- a manual scope review,
- a weekly rollup.

```ts
type EvolutionEpisode = {
	id: string;
	scopeId: string;
	title: string;
	timeWindow?: { start: string; end: string };
	evidenceIds: string[];
	outcomeSummary: string;
	findings: EvolutionFinding[];
	lessons: EvolutionLesson[];
	nextActions: TaskProposal[];
	createdAt: string;
};
```

Episode Judge input:

- scope objective,
- selected evidence,
- task result,
- artifacts,
- user feedback,
- manual notes,
- metric deltas,
- active lessons already used.

Episode Judge output:

```text
Outcome
What worked
What failed
Findings by domain
Candidate lessons
Next task proposals
HyperNeo friction
```

## Primitive 4: EvolutionLesson

Lessons are candidate by default. User accepts before they affect future tasks.

```ts
type EvolutionLesson = {
	id: string;
	scopeId: string;
	status: 'candidate' | 'active' | 'dismissed';
	appliesTo: string[];
	rule: string;
	why: string;
	evidenceEpisodeIds: string[];
	confidence: number;
	createdAt: string;
	updatedAt: string;
};
```

MVP lifecycle:

```text
candidate → active
candidate → dismissed
```

Later versions can add challenged, deprecated, archived, conflict resolution, decay, and cross-scope promotion.

### Lesson injection

When creating a new task under the same scope, HyperNeo should inject the top active lessons into the agent task message.

MVP rule:

```text
Inject at most 3 active lessons from the same scope.
```

The agent message should show them explicitly:

```text
## Relevant Scope Lessons
- For launch posts, open with product demo before architecture details. Evidence: episode 12.
- For workflow runtime changes, run gate transition tests before reporting done. Evidence: episode 7.
```

This is the biggest MVP value lever.

## Primitive 5: TaskProposal

TaskProposal turns learning into next actions.

```ts
type TaskProposal = {
	id: string;
	scopeId: string;
	title: string;
	description: string;
	reason: string;
	priority: 'low' | 'normal' | 'high';
	status: 'proposed' | 'accepted' | 'dismissed' | 'created';
	createdAt: string;
};
```

MVP actions:

- accept → creates SpaceTask,
- edit → creates SpaceTask with edits,
- dismiss → hides proposal.

### Example proposals for 100k-star campaign

```text
- Rewrite README top section with demo-first positioning.
- Add 12-second product GIF above the fold.
- Draft Hacker News launch post.
- Create metric snapshot task for weekly stars.
- Draft HyperNeo product finding: campaign dashboard needed.
```

## User flow

### 1. First-time scope setup

User creates a scope:

```text
Name: Grow HyperNeo to 100k GitHub stars
Kind: campaign
Objective: reach 100k stars through product, content, community, and distribution work
Metrics: GitHub stars, weekly growth, content impressions
Policy: create task proposals; no auto-posting; no auto-PRs
```

HyperNeo creates the scope page.

### 2. Daily work

User runs tasks normally.

Each task can be linked to a scope.

```text
Task: Improve README intro
Scope: Grow HyperNeo to 100k GitHub stars
```

The task message receives active lessons from the scope.

### 3. After task completion

Forge creates an episode draft:

```text
Episode: README intro improvement
Outcome: README now opens with demo-first positioning.
What worked: concrete screenshot made value prop clearer.
What failed: no conversion metric available yet.
Candidate lessons: demo-first intro may outperform architecture-first intro for new visitors.
Next actions: add metric snapshot; publish demo post; ask users for first-impression feedback.
HyperNeo friction: no built-in campaign metric tracker.
```

User reviews:

- accept lesson,
- create next task,
- dismiss weak finding.

### 4. Weekly rollup

User clicks:

```text
Run scope review
```

HyperNeo summarizes:

```text
Progress this week
Metric movement
What worked
What failed
Active lessons
Recommended next tasks
Product blockers
```

Rollup itself becomes an EvolutionEpisode.

## MVP services

### EvolutionScopeService

Responsibilities:

- create/update scopes,
- attach scopes to Missions/Spaces/tasks,
- list scope timeline,
- manage objective and metric definitions.

### EvolutionEvidenceService

Responsibilities:

- attach task/workflow/session/manual-note evidence,
- summarize evidence references,
- list evidence by scope.

### EvolutionEpisodeService

Responsibilities:

- build episode input,
- call Episode Judge,
- persist episode draft,
- update episode after user review.

### EvolutionLessonService

Responsibilities:

- accept/dismiss lessons,
- retrieve active lessons by scope,
- select top lessons for task-message injection.

### TaskProposalService

Responsibilities:

- accept/edit/dismiss proposals,
- create SpaceTasks from accepted proposals,
- link created tasks to same scope.

### ScopeRollupService

Responsibilities:

- summarize episodes and metrics,
- create weekly/manual rollup episodes,
- propose next cycle of work.

## Minimal tables

```text
evolution_scopes
evolution_evidence
evolution_episodes
evolution_lessons
evolution_task_proposals
evolution_metric_snapshots
```

`evolution_findings` can be a separate table or JSON inside `evolution_episodes` for MVP. Separate table is better if UI filtering is expected soon; JSON is faster to ship.

## Suggested schema sketch

### evolution_scopes

```sql
CREATE TABLE evolution_scopes (
	id TEXT PRIMARY KEY,
	kind TEXT NOT NULL,
	name TEXT NOT NULL,
	objective TEXT NOT NULL,
	parent_scope_id TEXT,
	metric_definitions_json TEXT NOT NULL DEFAULT '[]',
	policy_json TEXT NOT NULL DEFAULT '{}',
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
```

### evolution_evidence

```sql
CREATE TABLE evolution_evidence (
	id TEXT PRIMARY KEY,
	scope_id TEXT NOT NULL,
	kind TEXT NOT NULL,
	summary TEXT NOT NULL,
	source_id TEXT,
	created_at TEXT NOT NULL,
	FOREIGN KEY (scope_id) REFERENCES evolution_scopes(id) ON DELETE CASCADE
);
```

### evolution_episodes

```sql
CREATE TABLE evolution_episodes (
	id TEXT PRIMARY KEY,
	scope_id TEXT NOT NULL,
	title TEXT NOT NULL,
	time_window_start TEXT,
	time_window_end TEXT,
	evidence_ids_json TEXT NOT NULL DEFAULT '[]',
	outcome_summary TEXT NOT NULL,
	findings_json TEXT NOT NULL DEFAULT '[]',
	created_at TEXT NOT NULL,
	FOREIGN KEY (scope_id) REFERENCES evolution_scopes(id) ON DELETE CASCADE
);
```

### evolution_lessons

```sql
CREATE TABLE evolution_lessons (
	id TEXT PRIMARY KEY,
	scope_id TEXT NOT NULL,
	status TEXT NOT NULL,
	applies_to_json TEXT NOT NULL DEFAULT '[]',
	rule TEXT NOT NULL,
	why TEXT NOT NULL,
	evidence_episode_ids_json TEXT NOT NULL DEFAULT '[]',
	confidence REAL NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	FOREIGN KEY (scope_id) REFERENCES evolution_scopes(id) ON DELETE CASCADE
);
```

### evolution_task_proposals

```sql
CREATE TABLE evolution_task_proposals (
	id TEXT PRIMARY KEY,
	scope_id TEXT NOT NULL,
	title TEXT NOT NULL,
	description TEXT NOT NULL,
	reason TEXT NOT NULL,
	priority TEXT NOT NULL,
	status TEXT NOT NULL,
	created_task_id TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	FOREIGN KEY (scope_id) REFERENCES evolution_scopes(id) ON DELETE CASCADE
);
```

### evolution_metric_snapshots

```sql
CREATE TABLE evolution_metric_snapshots (
	id TEXT PRIMARY KEY,
	scope_id TEXT NOT NULL,
	captured_at TEXT NOT NULL,
	values_json TEXT NOT NULL,
	source TEXT NOT NULL,
	FOREIGN KEY (scope_id) REFERENCES evolution_scopes(id) ON DELETE CASCADE
);
```

## Episode Judge prompt shape

Episode Judge should produce structured JSON.

Input sections:

```text
## Scope
- name
- kind
- objective
- metrics

## Evidence
- task summaries
- artifact summaries
- manual notes
- metric snapshots

## Active Lessons Used
- lesson rule
- evidence

## Instructions
Create an episode summary for this scope.
Extract findings, candidate lessons, next task proposals, and HyperNeo friction.
Do not create durable lessons unless evidence supports them.
Prefer specific scoped lessons over generic advice.
```

Output schema:

```json
{
	"outcomeSummary": "...",
	"findings": [
		{
			"domain": "workflow|target_artifact|hyperneo_product",
			"kind": "friction|bug|optimization|missing_capability|new_opportunity",
			"impact": "low|medium|high",
			"confidence": 0.0,
			"evidence": ["..."],
			"proposedAction": "..."
		}
	],
	"lessons": [
		{
			"appliesTo": ["..."],
			"rule": "...",
			"why": "...",
			"confidence": 0.0
		}
	],
	"nextActions": [
		{
			"title": "...",
			"description": "...",
			"reason": "...",
			"priority": "low|normal|high"
		}
	],
	"neokaiFriction": ["..."]
}
```

## Frontend MVP pages

### Scope list

Shows:

- scope name,
- kind,
- objective,
- last updated,
- active lessons count,
- proposed tasks count.

### Scope detail

Tabs or sections:

- Overview,
- Evidence,
- Episodes,
- Lessons,
- Proposed Tasks,
- Metrics.

### Episode review

Shows:

- outcome summary,
- findings,
- candidate lessons with Accept/Dismiss,
- next actions with Create Task/Edit/Dismiss,
- HyperNeo friction notes.

### Task creation integration

When creating a task:

- select scope,
- show active lessons that will be injected,
- allow removing a lesson for this task.

## Integration points

### Attach tasks to scope

SpaceTask should optionally reference `evolutionScopeId`.

When a task is already linked to a recurring `SpaceGoal`, HyperNeo can derive the scope through `EvolutionScope.spaceGoalId`. This keeps existing goal-linked tasks working and avoids duplicating long-horizon ownership.

When task completes, HyperNeo can suggest creating an episode from it.

### Attach recurring goals to scope

A recurring SpaceGoal should be able to create or link an EvolutionScope.

MVP behavior:

- create scope from goal title/description/type,
- copy goal metrics into scope metric definitions where possible,
- attach scheduled check-in tasks as evidence,
- create episode when goal-linked task reaches terminal state,
- write accepted rollup summary back into goal `summary`, `progress`, and `nextSteps`,
- create accepted task proposals as goal-linked SpaceTasks.

This makes recurring goals the natural user-facing entry point for long-horizon scoped learning.

### Inject lessons into task message

When building a task agent message, retrieve active lessons for the task scope and append a section:

```text
## Relevant Scope Lessons
...
```

MVP injection should be visible, not hidden.

### Create tasks from proposals

Accepted proposal creates a SpaceTask with:

- same scope ID,
- proposal reason copied into task description,
- evidence episode linked.

## MVP phases

### Phase 1: Scope + manual evidence

Build:

- `EvolutionScope`,
- manual notes,
- metric snapshots,
- attach tasks to scope,
- scope page.

Result:

```text
Users can define a long-horizon objective and gather evidence.
```

### Phase 2: Episode Judge

Build:

- generate episode from completed task or selected evidence,
- produce findings, candidate lessons, next actions,
- show review UI.

Result:

```text
Every run can produce structured learning.
```

### Phase 3: Lesson injection

Build:

- accept/dismiss lessons,
- retrieve active lessons for scope,
- inject top 3 into new scoped task messages.

Result:

```text
Future agents benefit from past work.
```

### Phase 4: Next actions to tasks

Build:

- accept/edit proposal,
- create SpaceTask,
- link created task to same scope.

Result:

```text
Long-horizon scope drives task pipeline.
```

### Phase 5: Scope rollup

Build:

- weekly/manual rollup from episodes and metrics,
- active lessons board,
- progress summary,
- next recommendations.

Result:

```text
Campaigns and missions become self-improving loops.
```

## First dogfood target

Use the MVP on its own implementation.

```text
Scope: Build HyperNeo Forge MVP
Objective: verify a usable end-to-end scoped learning loop inside HyperNeo
Metrics:
- completed tasks
- accepted lessons
- reused lessons
- repeated failures
- time from task completion to next task creation
```

This validates the loop in a controlled HyperNeo-on-HyperNeo setting.

### MVP operation notes

Run the first dogfood loop manually:

1. Create recurring SpaceGoal `Build HyperNeo Forge MVP`.
2. Create a Forge scope linked to that goal with the five metrics above.
3. Attach a completed goal-linked SpaceTask as task evidence.
4. Add a metric snapshot for the same scope.
5. Generate an episode draft from selected evidence.
6. Accept one candidate lesson.
7. Convert one proposal into a goal-linked SpaceTask.
8. Confirm the next scoped task message includes `## Relevant Scope Lessons`.
9. Apply manual rollup to update goal summary, progress, next steps, and metrics.

Current MVP limitations:

- Episode judging drafts only; users still accept lessons, proposals, and rollups manually.
- Lesson reuse adds prompt policy context for scoped tasks, capped at three active lessons.
- Metrics are manual snapshots; no automatic metric integrations yet.
- Proposal conversion creates SpaceTasks but does not auto-start or auto-merge work.
- Local research artifacts stay outside git; `research-papers/` is ignored.

## Second dogfood target

Use the MVP on a non-code long-horizon objective.

```text
Scope: Grow HyperNeo to 100k GitHub stars
Objective: grow GitHub stars through product, content, community, and distribution work
Metrics:
- GitHub stars
- weekly star growth
- content impressions
- visitor-to-star conversion
```

This validates flexible scoped evolution beyond coding.

## MVP success criteria

After two weeks of dogfood:

```text
- 20+ tasks attached to scopes
- 10+ episodes generated
- 5+ lessons accepted
- 3+ lessons reused in later tasks
- 10+ next-action proposals created
- 5+ proposals converted to tasks
- at least 1 repeated failure avoided because an active lesson was injected
```

Qualitative success criteria:

- user trusts episode summaries,
- lessons feel specific rather than generic,
- next actions save planning time,
- scope page gives real sense of progress,
- lesson injection improves future agent behavior.

## Path to v2

If MVP succeeds, add:

- workflow variants,
- evaluator split,
- lesson lifecycle states beyond active/dismissed,
- GitHub issue drafts,
- metric integrations,
- cross-scope lesson promotion,
- workflow mutation archive,
- strategy diversity,
- strategy checkpoints,
- parent selection,
- provenance graph,
- rollback.

## Final principle

MVP should make HyperNeo remember, learn, and propose next steps inside a scope.

Do not start with autonomous mutation. Start with durable continuity.

The first win is simple:

```text
past work makes next work better
```
