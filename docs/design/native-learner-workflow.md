# Native Learner worker and learning workflow

**Status:** Proposed implementation specification  
**Scope:** Continuous-learning gap #1, with the minimum PR-agnostic terminal contract needed by gap #2 and the proposal-validation data needed by gap #3  
**Parent:** Goal `#951beac9`; originating task `#895`; design task `#917`

## Decision summary

Add a seventh preset **worker** agent, `Learner` (`handle: learner`), and a built-in single-node **Learning Workflow** (`handle: learning-workflow`). The worker operates an existing goal-linked Forge scope directly. It is not a long-horizon actor and does not own goals, schedules, or Forge scopes; the goal and scope remain the durable steering state, while long-horizon actors may retain `owner`/`manager`/`watcher` assignments.

The workflow has one start/end node and no channels, PR hooks, review gate, or post-approval route. At autonomy level 2 or higher, the Learner records a terminal decision artifact and calls `approve_task`; the existing no-route completion path transitions `in_progress → approved → done`. Below level 2 it calls `submit_for_approval`. No task-level `requires_pr` or `no_code` flag is introduced.

Goal automation remains the trigger source. Its completed-task threshold, self-nag schedule, and external-event subscriptions create a task pinned to `learning-workflow`; they no longer run the episode judge and then create a generic review task. The Learner performs the whole Forge cycle in the workflow so evidence selection, episode review, proposal validation, lessons, metrics, and completion share one accountable execution trace.

## Verified current state

The design builds on these existing seams rather than replacing them:

- Forge already stores goal-linked scopes, evidence, episodes, findings, lessons, proposals, and metric snapshots (`packages/shared/src/types/evolution.ts:3-290`).
- Episode generation already loads evidence, related tasks and workflow runs, metric history, active/candidate lessons, and proposed/accepted proposals (`packages/daemon/src/lib/space/evolution-episode-service.ts:213-258`). The judge creates a draft episode with `outcomeSummary` and findings, plus candidate lessons and proposed tasks linked through `evidenceEpisodeIds` (`packages/daemon/src/lib/space/evolution-episode-service.ts:173-211`).
- Proposal materialization is already atomic and idempotent and creates a goal/scope-linked task (`packages/daemon/src/lib/space/evolution-episode-service.ts:327-391`).
- Space member sessions expose the native Forge MCP operations: scope resolution, evidence and metric reads/writes, episode generation, review bundles, lesson/proposal updates, proposal-to-task conversion, and goal rollup (`packages/daemon/src/lib/space/tools/space-agent-tools.ts:3838-4459`).
- Goal automation already supports three trigger kinds: completed-task threshold, self-nag cron, and external-event subscription (`packages/daemon/src/lib/space/goals/goal-automation-service.ts:45-180`). Today the job handler invokes the episode service itself and creates an unpinned `Review Evolution retrospective` task (`packages/daemon/src/lib/job-handlers/goal-automation-execute.handler.ts:82-207`, `:293-318`).
- Worker node sessions already receive both `node-agent` and space-scoped `agent-memory` MCP servers (`packages/daemon/src/lib/space/runtime/task-agent-manager.ts:999-1281`, `:5132-5141`). The memory repository is currently keyed by `(space_id, key)`, not agent identity (`packages/daemon/src/storage/repositories/agent-memory-repository.ts:89-138`, `:187-199`).
- Forge scope ownership is currently a long-horizon-agent relation (`owner | manager | watcher`), with assignment APIs accepting only long-horizon agents (`packages/daemon/src/storage/schema/long-horizon-agents.ts:53-67`, `packages/daemon/src/lib/space/tools/space-agent-tools.ts:1837-1867`).
- The task state machine already permits `in_progress → approved` and `approved → done` (`packages/daemon/src/lib/space/managers/space-task-manager.ts:32-74`). `approve_task` is gated by `workflow.completionAutonomyLevel` (`packages/daemon/src/lib/space/tools/end-node-handlers.ts:373-415`). When a workflow declares no post-approval route, the router closes `approved → done` directly and captures terminal Forge evidence (`packages/daemon/src/lib/space/runtime/post-approval-router.ts:302-390`).
- Existing Research and Review-Only workflows are not suitable substitutes: Research requires a PR-ready hook and post-approval merge; Review-Only instructs its terminal agent to post a GitHub review (`packages/daemon/src/lib/space/workflows/built-in-workflows.ts:794-965`).

## Agent definition

### Identity and lifecycle

Add this preset to `seed-agents.ts`:

| Field | Value |
|---|---|
| Name | `Learner` |
| Handle | `learner` |
| Family | Worker (`SpaceWorkerAgent`) |
| Description | Operates goal-linked Forge learning cycles: evidence → episode → validated lessons and proposals. |
| Tool profile | Learner-specific capability profile, enforced through filtered MCP servers |
| Default model/thinking | Inherit the Space defaults; no Learner-specific provider contract |

This is deliberately a **worker**, not a long-horizon agent:

1. A learning cycle is bounded execution with a clear terminal result, so it fits a workflow node.
2. Schedules and external subscriptions already persist in goal/Forge automation; a second always-on Learner session would duplicate trigger ownership.
3. Forge scope ownership currently belongs to long-horizon actors. Changing that relationship merely to run a workflow would conflate steering ownership with execution.

A long-horizon `Product Quality Manager`, Coordinator, or future domain owner may own/manage/watch the scope. The Learner receives `goalId`, `scopeId`, trigger context, and evidence cursor in its task and operates that scope for one cycle.

### Tool surface

The Learner needs the normal node terminal tools plus a **curated subset of the existing Space tools**. This is an enforced v1 capability boundary, not prompt guidance. An empty worker `toolProfile` is insufficient because `deriveWorkerDisallowedTools` only filters deniable built-ins and an empty profile leaves all Space MCP operations available (`packages/daemon/src/lib/space/agents/tool-policy.ts:22-31`).

Add a Learner-specific MCP provisioning path in `TaskAgentManager`: construct filtered `space-agent` and `node-agent` servers whose registered tool names are limited to the allowlist below, and attach the ordinary agent-memory server. The filtered server is also **scope-bound** to the current task's `evolutionScopeId` and `goalId`: every object lookup and mutation handler must resolve the target's scope and reject cross-scope or mismatched-goal access, even when the object belongs to the same Space. This applies to evidence, metrics, episodes, lessons, proposals, validations, materialization, review bundles, and rollup. Do not rely on IDs supplied by the prompt or agent; inject the authorized scope into the handler context and include it in repository queries. The workflow agent must not receive the unfiltered Space server in parallel. Unknown/new Space tools therefore remain denied until deliberately added to this profile.

**Read/observe**

- `get_task`
- `get_goal`, `list_goal_events`
- `resolve_forge_scope`, `get_forge_scope`, `get_forge_timeline`
- `list_forge_evidence`, `list_forge_metric_snapshots`
- `list_forge_review_bundle`, `list_forge_lessons`, `list_forge_proposals`
- `list_forge_proposal_validations`
- `memory.search`, `memory.read`

**Forge mutation**

- `add_forge_manual_note`
- `attach_forge_task_evidence`, `attach_forge_workflow_run_evidence`
- `add_forge_metric_snapshot`
- `create_forge_episode`, `update_forge_episode`
- `create_forge_lesson`, `update_forge_lesson`
- `create_forge_task_proposal`, `update_forge_task_proposal`
- `create_forge_proposal_validation`
- `create_task_from_forge_proposal`
- `apply_forge_rollup`
- scope-wrapped `memory.write`; omit `memory.delete` in v1

**Workflow terminal**

- `save_artifact`
- `approve_task` when autonomy allows
- `submit_for_approval` otherwise
- `send_message` only for escalation, not a normal second-node handoff

The filtered servers must omit scope creation/relinking, agent-assignment, generic task creation, and every other Space mutation not listed above. A learning run may report `missing_scope` or request an owner decision, but it cannot silently change the steering topology. Prompt instructions remain defense in depth, not the authorization mechanism.

### Memory namespace

The current memory store is shared by every session in a Space, so the design must not claim storage-level per-agent isolation that does not exist. For the first implementation, enforce a **logical namespace**:

```text
learner/<scope-id>/<slug>
```

Every Learner-written key must use that prefix and tags must include `learner`, `forge`, and `scope:<scope-id>`. Enforce this in a Learner-specific memory wrapper that derives the prefix from the task-bound scope, rejects caller-supplied keys outside it, and adds the required tags server-side. Do not expose ordinary `memory.write` or any memory deletion operation to Learner in v1; deletion remains unavailable until storage-level ownership exists. Search/read may still surface shared Space memories and are not an authorization boundary. Store only operational heuristics not already represented by Forge rows—for example, source-specific metric collection instructions or a correction to evidence interpretation. Episodes, findings, proposal outcomes, and lessons remain in Forge and must not be duplicated into memory.

A follow-up may add repository-enforced owner namespaces. Until then, the enforced write wrapper prevents cross-namespace mutation, while the UI/background consolidation may still surface these memories to other agents.

## Workflow definition

```ts
export const LEARNING_WORKFLOW: SpaceWorkflow = {
  id: '',
  spaceId: '',
  name: 'Learning Workflow',
  handle: 'learning-workflow',
  description: 'Single-node Forge learning cycle with a PR-agnostic terminal.',
  nodes: [
    {
      id: 'tpl-learning-learn',
      name: 'Learn',
      agents: [
        {
          agentId: 'Learner',
          name: 'learner',
          customPrompt: { value: LEARNER_WORKFLOW_PROMPT },
        },
      ],
    },
  ],
  startNodeId: 'tpl-learning-learn',
  endNodeId: 'tpl-learning-learn',
  tags: ['learning', 'forge'],
  channels: [],
  hooks: [],
  gates: [],
  completionAutonomyLevel: 2,
  createdAt: 0,
  updatedAt: 0,
};
```

Critical absences are part of the contract:

- no `postApproval` route;
- no `pr_ready` hook;
- no GitHub review gate;
- no peer channel or reviewer node;
- no PR-specific artifact requirement.

`completionAutonomyLevel: 2` matches the risk of producing internal evidence, lessons, proposals, and draft/accepted follow-up work. Creating an execution task from a proposal remains separately visible and auditable.

Level 1 must not perform those durable mutations and then merely submit the already-mutated result for approval. Enforce a shared `requireLearningMutationAutonomy` check in the mutation handlers used by this workflow—episode accept/dismiss, lesson activation/dismissal, proposal acceptance/dismissal, proposal-validation finalization, and goal rollup. The check permits draft evidence, metric snapshots, draft episode/proposal creation, and **pending** proposal-validation creation needed to prepare a review bundle, but requires Space autonomy level 2 before changing review dispositions, finalizing a validation verdict, or changing goal state. At level 1, the Learner persists each complete expected/measured/proposed-verdict triple as a validation with `status: 'pending'`, saves a decision artifact whose `pending_validation_ids` and recommendation reference those rows, leaves all generated lessons/proposals in candidate/proposed state, and calls `submit_for_approval`. The `submit_for_approval` terminal handler—not a separate Learner-callable mutation—atomically validates that artifact and creates a cycle-level `learning_review_bundle` row keyed by `(taskId, revision)` with `status: 'pending'`, containing the recommended episode, lesson, proposal, validation, and rollup dispositions—even when there are no proposal validations. The task stores the current revision; retry of the same submission is idempotent. The authorized human review action atomically applies the current bundle or rejects it with an audit reason. Rejection marks that revision `rejected`, increments the task's bundle revision, and returns the task to `in_progress`; a corrected resubmission creates the new pending revision while preserving prior attempts. Only the current revision may be applied, and ordinary task approval cannot close the run or advance its cursor until it is `applied`. Thus the gate covers every level-1 cycle rather than depending on a nonempty `pending_validation_ids` list. Rejecting the checkpoint therefore leaves no accepted lesson, accepted proposal, final validation verdict, or goal rollup to undo. As with task materialization, tool visibility is optional UX and handler enforcement is the authorization boundary.

### Terminal artifact

Before terminal action, save one decision artifact. Both learning terminal handlers enforce it: `submit_for_approval` validates the current cycle artifact before creating a review bundle, and `approve_task` validates the same artifact and its task/scope/episode references before any run status, cursor, or continuation write. Missing, failed, stale, or inconsistent artifacts leave the task `in_progress` with a structured error:

```ts
save_artifact({
  shape: 'decision',
  kind: 'learning-cycle',
  key: `cycle:<task-id>`,
  summary: '<one-sentence cycle outcome>',
  data: {
    recommendation: '<accepted|dismissed|no_op>',
    task_id: '<task-id>',
    goal_id: '<goal-id>',
    scope_id: '<scope-id>',
    episode_id: '<episode-id|null>',
    trigger_kind: '<completed_task_threshold|self_nag|external_event|manual>',
    evidence_ids: ['...'],
    accepted_lesson_ids: ['...'],
    proposal_ids: ['...'],
    validated_proposal_ids: ['...'],
    pending_validation_ids: ['...'],
    metric_snapshot_ids: ['...'],
    created_task_ids: ['...'],
    unresolved: ['...'],
  },
});
```

`data.recommendation` is required by the generic `decision` artifact validator. It records the terminal episode disposition (`accepted` or `dismissed`), or `no_op` when no episode is created. Artifact identity is task/cycle based so the no-op path never fabricates an episode; `episode_id` is `null` in that branch. The artifact summarizes the cycle for workflow observability; Forge rows remain canonical.

## Trigger wiring

### One trigger service, one execution path

Retain the existing policy and trigger recognition:

- threshold: `GoalAutomationService.onTaskCompleted`;
- schedule: `onSelfNag` plus existing schedule reconciliation;
- external: `onExternalEventPublished` with cursor-based deduplication.

Change only the queued job's terminal action. `handleGoalAutomationExecute` should stop calling `episodeService.createFromEvidence` and stop creating a generic review task. Instead it creates one learning task with:

- `goalId` and `evolutionScopeId` set;
- `preferredWorkflowId` resolved from built-in handle `learning-workflow`;
- labels `['forge', 'learning', 'automation', <trigger-token>]`;
- structured metadata or a stable description containing all merged trigger contexts, cursor boundary, external event IDs when present, and candidate evidence IDs;
- a deterministic automation-cycle lineage key scoped to `(goalId, evolutionScopeId)` so retries and concurrent trigger kinds do not create duplicate tasks.

The task is the durable unit of work. Goal automation must serialize cycles at the goal/scope level, not separately by trigger kind: atomically acquire one active-cycle lease for `(goalId, evolutionScopeId)`, merge completed-task, self-nag, and external-event contexts into that cycle's durable pending-trigger set, and release the lease only when no task, review bundle, reserved continuation, or pending continuation outbox remains.

Use one canonical evidence cursor per `(goalId, evolutionScopeId)` for episode selection. Trigger-kind cursors remain only source-delivery dedup markers (for example, the last external event received); they never determine the Forge evidence window. On accepting an external-event publication, atomically create/idempotently resolve its Forge evidence **before** advancing the source-dedup marker or merging its trigger context, and order that evidence by an append-time Forge sequence rather than backdated `externalEvent.ingestedAt`. Store the external event ID as the uniqueness key and its ingestion time as metadata only. A delayed job therefore references evidence already positioned after the canonical boundary; legacy late evidence detected at or behind the boundary goes into the durable pending-trigger queue as an explicit claimed evidence ID and is processed without moving the cursor backward. When acquiring the lease, atomically read the global processed boundary, merge all pending trigger contexts, and claim the next contiguous evidence prefix. Terminal handling advances only this global cursor through the committed prefix. This prevents an older self-nag cursor from replaying evidence already processed for an external event and prevents a newer source cursor from skipping evidence unseen by another source. The Learner selects the claimed evidence (bounded by `maxEvidencePerEpisode`) and runs the judge.

Learning-workflow task completion is terminal evidence but must be marked `nonTriggeringForGoalAutomation` (or filtered by `preferredWorkflow.handle === 'learning-workflow'`) before `GoalAutomationService.onTaskCompleted`. It may remain visible in the Forge timeline, but it neither increments `completedTaskThreshold` nor recursively schedules another learning cycle.

Each trigger context carries a monotonically assigned pending-trigger sequence. The cycle's evidence claim records the greatest trigger sequence it covers. Terminal handling must reserve a continuation whenever **any** merged context—completed-task, self-nag, or external-event—has a later sequence or an explicit evidence ID not covered by the committed claim. It releases the goal/scope lease only when every pending context is covered or durably reserved for a continuation; no trigger kind depends on another notification to drain.

### Cursor semantics

Do **not** advance the automation cursor when the task is merely created. Advance it only after the learning workflow reaches `done`. The cursor remains a contiguous processed-prefix boundary: a completed cycle may advance it only through the greatest evidence position for which every preceding item is either included in that episode or explicitly recorded as examined and deferred to a durable next-cycle queue. It must never jump directly to the greatest selected evidence ID, because forcing trigger evidence beyond `maxEvidencePerEpisode` could otherwise strand the skipped prefix. A dismissed episode still counts as examined; a failed or human-rejected run does not advance the cursor.

The trigger evidence must therefore be selected together with prefix evidence up to the cap. If the trigger lies beyond the cap, persist it on a durable next-cycle queue as priority evidence rather than appending it across a gap. Terminal completion must commit the task's `done` transition, contiguous cursor update, and durable continuation-outbox row in one database transaction whenever that queue remains nonempty. An outbox dispatcher creates the continuation learning task with the advanced cursor boundary and deferred trigger context, using the same deterministic lineage key plus a monotonically increasing cycle sequence; idempotent consumption prevents duplicates. A startup/periodic reconciler scans completed learning cycles whose cursor/outbox terminal marker is absent and transactionally repairs it, closing the crash gap even if a legacy/non-transactional terminal path is encountered. The continuation does not depend on another external event, threshold notification, or self-nag tick. Continue chaining bounded prefix cycles until the deferred trigger is consumed and the queue is empty. The implementation may instead introduce a gap-aware cursor with explicit pending ranges, but a scalar cursor is valid only with this prefix-extension-and-continuation rule.

While a cycle for the same `(goal, scope)` is `open`, `in_progress`, `review`, `approved`, `blocked`, `rate_limited`, or `usage_limited`, coalesce every trigger kind into that task or its pending-trigger set. A pending level-1 review bundle, reserved continuation task ID, or unconsumed continuation-outbox row also holds the same goal/scope lease and counts as an active cycle. The terminal transaction reserves the continuation task identity before marking the predecessor done; a live notification during outbox dispatch merges into that reservation rather than creating a competing task. Preserve the existing completed-task active-lock/requeue behavior until this durable lease replaces the process-local lock.

### Manual runs

A user or long-horizon owner can create a task explicitly pinned to `learning-workflow`. This is not a fourth automation trigger kind; it is ordinary workflow execution and records `trigger_kind: manual` in the artifact. Manual runs have no automation trigger key or cursor boundary and never read, advance, or enqueue continuations for automation cursors; their selected evidence is linked to the manual episode without consuming it from any later automated window.

## Learner procedure

The workflow prompt must instruct the agent to execute this procedure, not merely describe the architecture.

### 1. Resolve and bound the cycle

1. Read the task, goal, and supplied trigger context.
2. Resolve `scopeId` from the task and verify it belongs to the goal.
3. Read scope policy, metric definitions, timeline, evidence after the supplied cursor, prior metric snapshots, candidate/active lessons, and open/created proposals.
4. Recall only scope-relevant Learner memory.
5. Select a coherent evidence cluster, capped by `maxEvidencePerEpisode`, while preserving a contiguous cursor prefix. Prioritize trigger evidence within that prefix; if it lies beyond the cap, durably defer it to the next cycle rather than skipping intervening evidence.
6. If there is no new evidence, record a no-op decision artifact and complete without creating an empty episode.

### 2. Observe and measure

1. Attach any missing task/workflow-run evidence that is referenced by the trigger.
2. Capture a **before/after or current** metric snapshot when metric definitions have observable values.
3. If a metric cannot be measured, record why in evidence rather than inventing a value.
4. Identify earlier proposals whose created tasks or expected verification windows are now represented in the evidence.

### 3. Create one episode

Call `create_forge_episode` with the selected evidence and a required `cycleKey` derived from the workflow task/run. Add `cycle_key` to episodes with a unique `(scope_id, cycle_key)` constraint, and make `createFromEvidence` an idempotent get-or-create transaction: a retry returns the existing episode and its already-created findings/lessons/proposals rather than invoking the judge or inserting children again. The service verifies that a reused key has the same task, scope, and evidence claim; mismatches fail as conflicts. On resume, the Learner first reads the review bundle/episode by cycle key and continues from its persisted state. The existing judge produces the draft episode, findings, candidate lessons, and candidate proposals only on the first insertion. Do not recreate these objects manually unless correcting a specific judge omission.

Review the generated bundle for:

- evidence grounding and cross-scope contamination;
- duplicate lessons/proposals;
- consistency with existing active lessons;
- result-artifact gaps already detected by the service;
- proposals missing required expected outcome or verification method.

Update `episode.outcomeSummary` if needed, then accept or dismiss the episode. Activate only evidence-backed lessons; dismiss duplicates or unsupported candidates.

### 4. Form proposals

Every proposal must include:

- **Expected outcome:** the observable change if the proposal works;
- **Verification method:** metric key/query/test/event source, comparison window or completion condition, and acceptance threshold;
- evidence episode links;
- a bounded action description and priority.

A proposal without both fields remains `proposed` and cannot be accepted or materialized into a task.

Use a one-high-confidence-proposal-per-cycle default to limit self-generated work. Additional candidates may remain proposed for later review. Proposal acceptance and task materialization are distinct authorities: level 2 may accept a proposal, but `create_task_from_forge_proposal` requires both Space autonomy level 3 or higher **and** `scope.policy.automation.createTasksFromAcceptedProposals === true`, plus the existing no-duplicate/idempotency checks.

Enforce this in the `create_task_from_forge_proposal` MCP handler (or a shared evolution scope-policy service called by it), before `episodeService.createTaskFromProposal`. The check must read the proposal's scope and current Space autonomy; callers using any workflow receive the same policy. Return a structured authorization error when either condition is absent. Hiding the tool from the Learner profile when scope opt-in is false is useful UX but is not the security boundary.

### 5. Validate earlier proposals

For each earlier proposal whose outcome is now measurable, create a validation record with an explicit triple:

```text
expected: <original expected outcome and threshold>
measured: <metric/evidence value, window, and source>
verdict: effective | ineffective | superseded
```

Verdict rules:

- `effective`: measured evidence meets the predeclared threshold;
- `ineffective`: the verification window closed and the threshold was not met, or regressions outweigh the expected gain;
- `superseded`: the intervention or target was replaced so the original causal claim is no longer testable; identify the replacement proposal/task.

Never rewrite the original expectation after observing results. Link the validation to the originating proposal, its created task when present, the validating episode, and metric snapshots.

Each completed validation produces or updates a lesson:

- effective → activate a rule describing what to repeat and under which conditions;
- ineffective → activate a caution describing what not to repeat and why;
- superseded → activate only when the replacement itself yields a reusable rule; otherwise retain the validation without forcing a lesson.

If no suitable candidate lesson exists, call `create_forge_lesson` with the validation-derived rule, `status: 'candidate'`, and links to the validating episode/proposal, then activate it only after the same level-2 disposition gate. Validation creation must not silently synthesize an active lesson because lesson review and validation finalization remain independently auditable.

### 6. Roll up and finish

1. Apply a concise goal rollup only when the episode is accepted **and** the goal type is `recurring`: summary, metric deltas, progress only when evidence supports it, and next steps. The current rollup service rejects dismissed episodes and every non-recurring goal. For an accepted `one_shot` or `measurable` goal, preserve the learning result in Forge and the terminal artifact but leave goal state unchanged; any later support for those goal types belongs in the goal service rather than this workflow. For a dismissed episode, preserve the dismissal reason and likewise leave goal state unchanged. In every path, advance the cursor only under the contiguous-prefix rule above.
2. Write only non-Forge operational heuristics to `learner/<scope-id>/...` memory.
3. Save the terminal learning-cycle artifact.
4. Call `approve_task` as the final action; if autonomy blocks it, call `submit_for_approval` instead.

## Additive data model for proposal validation

The current `TaskProposal` type has title, description, reason, priority, status, evidence episode IDs, and created task ID only (`packages/shared/src/types/evolution.ts:239-272`). Encoding validation in prose would make the core learning claim unqueryable. Add first-class fields without replacing the Forge model.

### Task proposal additions

```ts
interface TaskProposal {
  expectedOutcome: string | null;
  verificationMethod: {
    metricKeys: string[];
    source: string;
    comparison: 'before_after' | 'threshold' | 'event' | 'test';
    threshold: string;
    window?: string;
  } | null;
  acceptedSnapshot: {
    title: string;
    description: string;
    reason: string;
    priority: TaskProposal['priority'];
    expectedOutcome: string;
    verificationMethod: NonNullable<TaskProposal['verificationMethod']>;
    acceptedAt: number;
  } | null;
}

interface CreateTaskProposalParams {
  expectedOutcome?: string | null;
  verificationMethod?: TaskProposal['verificationMethod'];
}

interface UpdateTaskProposalParams {
  expectedOutcome?: string | null;
  verificationMethod?: TaskProposal['verificationMethod'];
}
```

Extend the repository/service params and the `create_forge_task_proposal` and `update_forge_task_proposal` MCP schemas—not only the stored interface—so the Learner can fill incomplete judge output. Draft/proposed and legacy rows may carry `null`; do not invent backfill values. On transition to `accepted`, the proposal service validates both verification fields and atomically snapshots the entire causal contract: action (`title`, `description`, `reason`, `priority`) plus expected outcome and verification method. While status is `accepted` or `created`, it rejects edits to any snapshotted field. Validation reads its expectation from this immutable snapshot, and task materialization must use the snapshot's action verbatim; remove or reject materialization-time action overrides.

For legacy `accepted` proposals lacking a snapshot, add an audited repair transition `accepted → proposed` that clears no evidence links, records `repairReason: 'missing_acceptance_snapshot'`, and permits completing the fields before normal re-acceptance creates the snapshot. A migration identifies/marks these rows as `needsRepair`; it must not invent expectations or silently snapshot mutable legacy content. Already-created proposals remain historical and cannot be repaired/materialized again. The task-materialization handler rejects `needsRepair` and repeats the completeness/snapshot invariant. Consumers must narrow nullable state before accessing verification fields.

### Proposal validation record

Add `evolution_proposal_validations` rather than overloading episode findings:

```ts
type ProposalVerdict = 'effective' | 'ineffective' | 'superseded';
type ProposalValidationStatus = 'pending' | 'final' | 'rejected';

interface ProposalValidation {
  id: string;
  scopeId: string;
  proposalId: string;
  validatingEpisodeId: string;
  metricSnapshotIds: string[];
  expected: string;
  measured: string;
  verdict: ProposalVerdict;
  status: ProposalValidationStatus;
  replacementProposalId: string | null;
  replacementTaskId: string | null;
  lessonId: string | null;
  createdAt: number;
  finalizedAt: number | null;
}
```

Uniqueness should be `(proposal_id, validating_episode_id)`. Exactly one of `replacementProposalId` or `replacementTaskId` may be set for a superseded verdict; both are null otherwise. Add create/list/finalize/reject service operations and include validations in `list_forge_review_bundle` and the judge prompt. Creation at level 1 stores `pending`; finalization/rejection is the autonomy-gated disposition. Keep `episode.outcomeSummary`, findings, and metric snapshots as the outcome evidence; this record is the missing explicit expected↔measured↔verdict link.

## PR-agnostic completion

No core task flag is needed. The workflow declares its execution contract structurally:

1. `endNodeId` points to `Learn`;
2. the end node receives terminal tools;
3. the workflow has no PR hook/gate and no `postApproval` route;
4. `completionAutonomyLevel` governs self-close versus human approval;
5. the terminal artifact is a generic `decision`, not a PR link.

On `approve_task`, the current runtime sets `reportedStatus='done'`, completes the run, transitions the task to `approved`, finds zero post-approval routes, and closes it to `done`. This is already PR-agnostic behavior. The implementation should add a regression test for this built-in workflow so future coding-specific validation cannot leak back into core completion.

A later generic workflow completion schema may formalize artifact expectations, but it must describe positive workflow-owned requirements (for example, terminal artifact kind), never `requires_pr`/`no_code` on tasks.

## Implementation slices

1. **Preset + workflow:** seed `Learner`; add `LEARNING_WORKFLOW`; export it; include it in built-in template hashing/restamping and tests. Add a migration following the existing preset-agent backfill pattern (for example m170/m172): insert the Learner preset into every existing Space idempotently **before** workflow restamping runs. This ordering is required because `seedBuiltInWorkflows` resolves template agent names and otherwise skips or throws when `Learner` is absent. Space-creation seeding alone does not update existing Spaces.
2. **Automation dispatch:** resolve the workflow; serialize triggers through a goal/scope lease; use a canonical evidence cursor; persist external-event evidence at publication with append ordering; sequence/merge all trigger contexts and drain uncovered contexts through continuations; exclude learning-task self-triggers; transactionally commit terminal state/cursor/reservation/outbox; reconcile legacy terminal writes; isolate manual runs; remove direct episode/review-task creation.
3. **Learner prompt + tool policy:** provision scope-bound filtered MCP servers; wrap memory writes with the enforced Learner/scope prefix and omit deletion; enforce level 2 in disposition/rollup handlers; make both terminal handlers validate the decision artifact; make `submit_for_approval` atomically create revisioned whole-cycle review bundles; add level-3 plus scope-policy materialization gating.
4. **Validation model:** add cycle-key-idempotent episodes; migrate nullable proposal fields and immutable full causal snapshots; extend mutation schemas; remove materialization overrides; add audited legacy repair; add pending/final/rejected validations with replacement links; feed validations to judging.
5. **Tests:** existing-Space migration; cross-trigger serialization/canonical cursor; publication-time and legacy-late external evidence; uncovered merged-context continuation for every trigger kind; self-trigger exclusion; cycle-key retry; autonomous artifact enforcement; no-op identity; level-1 bundle creation, rejection/resubmission revisions, apply and cursor guards; continuation races/reconciliation; manual isolation; paused coalescing; cross-scope denial; memory prefix/write/delete denial; validation/lesson availability; legacy proposal repair/immutable snapshots/no overrides; autonomy gates; rollup paths; validation links; no PR dependency.

## Open owner decisions

1. **One proposal per cycle:** Recommendation: default maximum one newly accepted/materialized proposal, configurable in scope policy; unlimited candidate proposals may remain `proposed`.
2. **Memory isolation timing:** Is the logical `learner/<scope-id>/` namespace sufficient for N1, or must repository-enforced agent ownership land first? Recommendation: ship logical namespacing with an explicit non-security warning; make enforced namespaces a separate migration.
3. **Superseded lessons:** Recommendation: do not force every superseded validation into a lesson; only create one when the replacement yields a reusable rule.
4. **Automation migration:** Existing pending automation review tasks should finish on their pinned/current workflow; only newly queued cycles use `learning-workflow`. Do not rewrite active tasks in place.

## Conclusion

The missing component is not another Forge store or another always-on coordinator. It is a bounded native execution path that lets a purpose-built worker use the stores already present, close without GitHub ceremony, and explicitly test whether prior proposals worked. The single-node Learning Workflow supplies that path while preserving the separation of Steering (goal), Learning (Forge), and Execution (workflow).
