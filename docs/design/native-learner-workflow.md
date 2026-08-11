# Native Learner worker and learning workflow

**Status:** Proposed implementation specification  
**Scope:** Continuous-learning gap #1, with the minimum PR-agnostic terminal contract needed by gap #2 and the proposal-validation data needed by gap #3  
**Parent:** Goal `#951beac9`; originating task `#895`; design task `#917`

## Decision summary

Add a seventh preset **worker** agent, `Learner` (`handle: learner`), and a built-in single-node **Learning Workflow** (`handle: learning-workflow`). The worker operates an existing goal-linked Forge scope directly. It is not a long-horizon actor and does not own goals, schedules, or Forge scopes; the goal and scope remain the durable steering state, while long-horizon actors may retain `owner`/`manager`/`watcher` assignments.

The workflow has one start/end node and no channels, PR hooks, review gate, or post-approval route. At autonomy level 2 or higher, the Learner records a terminal decision artifact and calls `approve_task`; the existing no-route completion path transitions `in_progress → approved → done`. Below level 2 it calls `submit_for_approval`; the resulting pending level-1 review bundle may be applied only by a verified human operator action, never by a coordinator or task-agent session. No task-level `requires_pr` or `no_code` flag is introduced.

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

Add a Learner-specific MCP provisioning path in `TaskAgentManager`: construct filtered `space-agent` and `node-agent` servers whose registered tool names are limited to the allowlist below, and provision a **filtered Learner memory server** in place of the ordinary `agent-memory` server. Do not attach the ordinary server: `createAgentMemoryMcpServer` registers unrestricted `memory.write` and `memory.delete`, which would defeat the enforced namespace below. The filtered Learner memory server exposes only the scope-derived prefix-enforcing `memory.write` wrapper described in the Memory namespace section, plus `memory.search`/`memory.read`, and omits deletion entirely.

This omission must survive the required-servers self-heal. `agent-memory` is on `requiredWorkflowSubSessionMcpServers()` (`task-agent-manager.ts:4899`), and `ensureNodeAgentAttached` (`:4923-4949`) calls `reinjectAgentMemoryMcpServer` (`:5114-5122`) on every spawn/rehydrate, which would otherwise re-inject the ordinary unfiltered `agent-memory` server before the first turn. Implement one of: (a) drop `'agent-memory'` from the required list for Learner sessions, or (b) make `reinjectAgentMemoryMcpServer` Learner-aware so it re-injects the filtered server. Either path must guarantee that after `ensureNodeAgentAttached` runs the session exposes the filtered server only (ordinary `memory.delete` absent).

The filtered server is also **scope-bound** to the current task's `evolutionScopeId` and `goalId`: every object lookup and mutation handler must resolve the target's scope and reject cross-scope or mismatched-goal access, even when the object belongs to the same Space. This applies to evidence, metrics, episodes, lessons, proposals, validations, materialization, review bundles, and rollup. Do not rely on IDs supplied by the prompt or agent; inject the authorized scope into the handler context and include it in repository queries. The workflow agent must not receive the unfiltered Space server in parallel. Unknown/new Space tools therefore remain denied until deliberately added to this profile.

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
- `create_forge_proposal_validation`, `finalize_forge_proposal_validation`, `reject_forge_proposal_validation`
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

Level 1 must not perform those durable mutations and then merely submit the already-mutated result for approval. Enforce a shared `requireLearningMutationAutonomy` check in the mutation handlers used by this workflow—episode accept/dismiss, lesson activation/dismissal, proposal acceptance/dismissal, proposal-validation finalization, and goal rollup. The check evaluates the **pinned `cycleAutonomyMode`** (see step 6), not a live re-read of Space autonomy, so a mid-cycle lowering cannot strand the run. It permits draft evidence, metric snapshots, draft episode/proposal creation, and **pending** proposal-validation creation needed to prepare a review bundle, but requires level 2 before changing review dispositions, finalizing a validation verdict, or changing goal state. At level 1, the Learner persists each complete expected/measured/proposed-verdict triple as a validation with `status: 'pending'`, saves a decision artifact whose `pending_validation_ids` and recommendation reference those rows, leaves all generated lessons/proposals in candidate/proposed state, and calls `submit_for_approval`. The `submit_for_approval` terminal handler—not a separate Learner-callable mutation—atomically validates that the artifact contains an exhaustive disposition for every episode, candidate lesson, proposed task, pending validation, and the complete proposed rollup payload, then copies that immutable recommendation into a cycle-level `learning_review_bundle` row keyed by `(taskId, revision)` with `status: 'pending'`—even when there are no proposal validations. It rejects missing, duplicate, unknown, or unaccounted-for object IDs rather than inferring recommendations from mutable Forge state. The bundle also stores, for every referenced Forge row, an immutable reviewed snapshot: the accepted/proposed content plus a version/`updatedAt` precondition (or content hash) for each episode, lesson, proposal, validation, metric snapshot, and rollup target. The task stores the current revision; retry of the same submission is idempotent. The authorized human review action is a dedicated, operator-verified surface—**not** the existing `approve_pending_completion` MCP path, which remains exposed to coordinator and legacy task-agent sessions and is therefore unsafe for learning-bundle application. The handler requires a verified human/operator authorization context and stamps the true actor; an AI coordinator applying the bundle is rejected. Apply atomically finalizes the bundle's dispositions, but first re-reads each referenced row and rejects the apply if any row's version/hash differs from the bundle's reviewed snapshot, so an intervening edit cannot substitute different content for what the human reviewed. A `stale_reviewed_version` failure terminalizes that attempt (`status: 'stale'`) **and** increments the task's bundle revision in the same transaction before returning the task to `in_progress`, so a corrected `submit_for_approval` creates a new pending revision with refreshed snapshots instead of reusing the stale idempotency key and failing forever. Explicit human rejection likewise marks the revision `rejected`, increments the revision, and returns the task to `in_progress`. Both transitions atomically reject that revision's pending validations (`status: 'rejected'`, recorded in the supersede chain) before the revision is terminalized—since a bundle may reference validations from its own revision only and only one current pending/final row may exist, the next revision cannot reuse or replace them unless they are first rejected. A corrected resubmission then creates replacement validations under the new attempt key. Only the current revision may be applied, and ordinary task approval cannot close the run or advance its cursor until it is `applied`. Thus the gate covers every level-1 cycle rather than depending on a nonempty `pending_validation_ids` list. Rejecting the checkpoint therefore leaves no accepted lesson, accepted proposal, final validation verdict, or goal rollup to undo. As with task materialization, tool visibility is optional UX and handler enforcement is the authorization boundary.

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
    cycle_autonomy_mode: '<1|2|3|4|5>',
    goal_id: '<goal-id>',
    scope_id: '<scope-id>',
    episode_id: '<episode-id|null>',
    triggers: [
      { kind: '<completed_task_threshold|self_nag|external_event>', key: '<...>', sequence: 0 },
      { kind: 'manual', key: 'task:<task-id>', sequence: 0 },
    ],
    evidence_ids: ['...'],
    episode_disposition: '<accept|dismiss|none>',
    lesson_dispositions: [{ lesson_id: '...', action: '<activate|dismiss|retain>' }],
    proposal_dispositions: [{ proposal_id: '...', action: '<accept|dismiss|retain>' }],
    validation_dispositions: [{ validation_id: '...', action: '<finalize|reject>' }],
    pending_validation_ids: ['...'],
    rollup: {
      action: '<apply|skip>',
      summary: '<...>',
      metric_deltas: { '<key>': '<value>' },
      next_steps: ['...'],
    },
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

- threshold: `GoalAutomationService.onTaskCompleted`, with each completed-task occurrence first written to a durable trigger outbox;
- schedule: `onSelfNag` plus existing schedule reconciliation, with each occurrence first written to a durable trigger outbox;
- external: `onExternalEventPublished` with cursor-based deduplication, persisting each occurrence to a durable trigger outbox atomically with its evidence and dedup-marker update.

Change only the queued job's terminal action. `handleGoalAutomationExecute` should stop calling `episodeService.createFromEvidence` and stop creating a generic review task. Instead it creates one learning task with:

- `goalId` and `evolutionScopeId` set;
- `preferredWorkflowId` resolved by the built-in workflow's **canonical template identity** (`templateSlug: 'learning-workflow'`), not by display name or handle. An existing Space may already contain a user workflow named `Learning Workflow` or using handle `learning-workflow`; `createWorkflow` rejects duplicates on those unique fields, and resolving by handle could fail or select the unrelated custom workflow—bypassing the secured Learner node and filtered MCP provisioning. The built-in seed carries a collision-safe `templateSlug` (distinct from display name/handle), the migration seeds under that identity despite name/handle conflicts, and automation resolves `preferredWorkflowId` to that seeded row.
- labels `['forge', 'learning', 'automation', <trigger-token>]`;
- structured metadata or a stable description containing all merged trigger contexts, cursor boundary, external event IDs when present, and candidate evidence IDs;
- a deterministic automation-cycle lineage key scoped to `(goalId, evolutionScopeId)` so retries and concurrent trigger kinds do not create duplicate tasks.

The task is the durable unit of work. Goal automation must serialize cycles at the goal/scope level, not separately by trigger kind. In one transaction, acquire the active-cycle lease for `(goalId, evolutionScopeId)`, merge trigger contexts into its durable pending set, claim evidence while reserving a `triggerEvidenceBudget` out of `maxEvidencePerEpisode` for trigger-referenced rows the Learner will attach later, and reserve the initial task ID plus a task-creation outbox row. The dispatcher materializes that reserved task idempotently. A startup/periodic reconciler repairs every leased cycle with a reservation but no task/outbox delivery; triggers coalesced during the gap cannot strand the scope. Release the lease only when no task, review bundle, reserved task, or pending outbox remains.

For self-nag, the schedule-fire transaction must insert a unique occurrence into the trigger outbox **before/with** `updateAfterFireIfPending`; delivery merges that occurrence into the goal/scope lease idempotently. Advancing the cron schedule is therefore not acknowledgement of trigger delivery, and reconciliation retries undelivered occurrences after crashes or enqueue failures.

The same durability applies to completed-task thresholding. The terminal handlers currently invoke `GoalAutomationService.onTaskCompleted` synchronously and only log failures (`end-node-handlers.ts:203-211`, `post-approval-router.ts:376-383`, `space-task-handlers.ts:640-648`). Insert the completed-task occurrence into the trigger outbox **with** the task's `done` transition, and let the goal/scope dispatcher merge it into the lease idempotently rather than firing inline. A reconciler scans durable completed-task evidence whose threshold occurrence was never delivered and re-enqueues it, so a capture/queue failure after the task is already `done`—especially at threshold 1 with no later task—cannot permanently lose the learning cycle.

External events need the same treatment. `onExternalEventPublished` must, in one transaction, create/idempotently resolve the Forge evidence, write a unique external-event occurrence to the trigger outbox, and advance the source-dedup marker; the goal/scope dispatcher then merges that occurrence into the lease idempotently. A crash after the dedup marker advances but before the occurrence is merged cannot drop the trigger: the reconciler re-delivers outbox occurrences whose lease merge is absent, preserving event-specific provenance without relying on a redelivery.

Use one canonical evidence cursor per `(goalId, evolutionScopeId)` for episode selection. Before enabling the new dispatcher, migrate existing evidence deterministically to append sequences ordered by `(created_at, id)`. For each scope, derive the safely processed prefix only from evidence linked to terminal accepted/dismissed episodes **proven to originate from legacy automation** (for example, episodes whose source task was queued by the legacy goal-automation handler)—never from manually reviewed episodes, which by contract do not consume automation evidence. Where an episode's origin is ambiguous (manual vs. legacy automation, or unverifiable), leave its evidence pending rather than advancing the boundary over it. Combine that proven-processed set with the intersection of legacy trigger cursor ranges; seed the canonical cursor only through the contiguous prefix both agree on. Persist every later evidence interval indicated by any legacy cursor but not proven processed as explicit pending ranges/IDs, so migration neither replays committed episodes nor skips divergent legacy windows—nor silently skips evidence that only a manual run ever touched. Run this migration and invariant check transactionally before automation resumes.

Trigger-kind cursors remain only source-delivery dedup markers (for example, the last external event received); they never determine the Forge evidence window. On accepting an external-event publication, atomically create/idempotently resolve its Forge evidence **before** advancing the source-dedup marker or merging its trigger context, and order that evidence by an append-time Forge sequence rather than backdated `externalEvent.ingestedAt`. Store the external event ID as the uniqueness key and its ingestion time as metadata only. A delayed job therefore references evidence already positioned after the canonical boundary; legacy late evidence detected at or behind the boundary goes into the durable pending-trigger queue as an explicit claimed evidence ID and is processed without moving the cursor backward. When acquiring the lease, atomically read the global processed boundary, merge all pending trigger contexts, and claim the next contiguous evidence prefix. Terminal handling advances only this global cursor through the committed prefix. This prevents an older self-nag cursor from replaying evidence already processed for an external event and prevents a newer source cursor from skipping evidence unseen by another source. The Learner selects the claimed evidence (bounded by `maxEvidencePerEpisode`) and runs the judge.

Learning-workflow task completion is terminal evidence but must be marked `nonTriggeringForGoalAutomation` on the task before `GoalAutomationService.onTaskCompleted`, and the filter must compare the workflow's canonical `templateSlug === 'learning-workflow'`—**not** its handle. The collision-safe seeding may give the built-in workflow a non-`learning-workflow` handle when a user workflow already owns that handle, so a handle check would either fail to exclude the built-in completion (recursive scheduling at threshold 1) or wrongly suppress the user workflow. The completion may remain visible in the Forge timeline, but it neither increments `completedTaskThreshold` nor recursively schedules another learning cycle.

Each trigger context carries a monotonically assigned pending-trigger sequence. The cycle's evidence claim records the greatest trigger sequence it covers. Terminal handling must reserve a continuation whenever **any** merged context—completed-task, self-nag, or external-event—has a later sequence or an explicit evidence ID not covered by the committed claim. It releases the goal/scope lease only when every pending context is covered or durably reserved for a continuation; no trigger kind depends on another notification to drain.

### Cursor semantics

Do **not** advance the automation cursor when the task is merely created. Advance it only after the learning workflow reaches `done`. The cursor remains a contiguous processed-prefix boundary: a completed cycle may advance it only through the greatest evidence position for which every preceding item is either included in that episode or explicitly recorded as examined and deferred to a durable next-cycle queue. It must never jump directly to the greatest selected evidence ID, because forcing trigger evidence beyond `maxEvidencePerEpisode` could otherwise strand the skipped prefix. A dismissed episode still counts as examined; a failed or human-rejected run does not advance the cursor.

An abandoned learning task (cancelled or archived before `done`) must release its goal/scope lease without losing the work it had claimed—and without duplicating work it has already committed. Prefer staging all gated cycle mutations (episode accept/dismiss, lesson activation, rollup, materialization) into the single terminal transaction so a pre-terminal abandonment has committed nothing to duplicate. If the implementation mutates incrementally instead, the abandonment transition must detect any already-committed effect for that cycle key and reconcile it—mark the cycle's evidence as examined in the gap-aware processed set, and rely on the `(scope_id, cycle_key)` episode uniqueness plus the immutable acceptance snapshot to suppress a duplicate episode/rollup/task from a replacement—rather than unconditionally requeuing a fresh claim. Only when no cycle mutation has committed may the transition atomically return the frozen evidence claim and unmerged trigger contexts to the durable pending-trigger set (or reserve a replacement task) before releasing the lease; the cursor/processed set is not advanced. If the task is in `review` (level-1 pending bundle), the same cancellation/archive transition must first atomically reject the current pending bundle revision and its pending validations—otherwise the lease contract's "pending bundle keeps the lease active" rule leaves the scope leased forever, or releasing it leaves validations that block replacement rows next cycle. The reconciler scans completed cycles missing terminal markers and leased cycles whose task is terminal-abandoned, classifies which case applies, and re-dispatches or finalizes accordingly, so an abandoned window is neither permanently occupying the scope, silently dropped, nor duplicated.

Abandoned learning tasks must not be retried through the generic `retry_task` path, which currently permits `cancelled` workflow tasks and reopens them (`space-agent-tools.ts:2510-2528`): retrying the original after a replacement was reserved would run two tasks over the same evidence with no lease owner. Either mark learning-workflow cancellations non-retryable, or have retry atomically reclaim the goal/scope lease and revoke any queued replacement before restoring the run.

The trigger evidence must therefore be selected together with prefix evidence up to the cap. If the trigger lies beyond the cap, persist it on a durable next-cycle queue as priority evidence rather than appending it across a gap. Terminal completion must commit the task's `done` transition, contiguous cursor update, and durable continuation-outbox row in one database transaction whenever that queue remains nonempty. An outbox dispatcher creates the continuation learning task with the advanced cursor boundary and deferred trigger context, using the same deterministic lineage key plus a monotonically increasing cycle sequence; idempotent consumption prevents duplicates. A startup/periodic reconciler scans completed learning cycles whose cursor/outbox terminal marker is absent and transactionally repairs it, closing the crash gap even if a legacy/non-transactional terminal path is encountered. The continuation does not depend on another external event, threshold notification, or self-nag tick. Continue chaining bounded prefix cycles until the deferred trigger is consumed and the queue is empty. The implementation may instead introduce a gap-aware cursor with explicit pending ranges, but a scalar cursor is valid only with this prefix-extension-and-continuation rule.

While a cycle for the same `(goal, scope)` is `open`, `in_progress`, `review`, `approved`, `blocked`, `rate_limited`, or `usage_limited`, coalesce every trigger kind into that task or its pending-trigger set. A pending level-1 review bundle, reserved continuation task ID, or unconsumed continuation-outbox row also holds the same goal/scope lease and counts as an active cycle. The terminal transaction reserves the continuation task identity before marking the predecessor done; a live notification during outbox dispatch merges into that reservation rather than creating a competing task. Preserve the existing completed-task active-lock/requeue behavior until this durable lease replaces the process-local lock.

### Manual runs

A user or long-horizon owner can create a task explicitly pinned to `learning-workflow`. This is not a fourth automation trigger kind; it is ordinary workflow execution and records a single `manual` entry in the artifact's `triggers[]` array, with a task-local `key: 'task:<task-id>'` and `sequence: 0` (no automation trigger key, no dedup cursor metadata). Manual runs have no automation trigger key or cursor boundary and never read, advance, or enqueue continuations for automation cursors; their selected evidence is linked to the manual episode without consuming it from any later automated window. They are still scope mutations, however: a manual run must acquire (or wait on) the same goal/scope mutation lease used by automated cycles before executing its dispositions, so a concurrent automated cycle and a manual run at autonomy ≥ 2 cannot both disposition the same episodes, lessons, proposals, validations, or goal rollup. The lease is acquired in a distinct manual mode that does not advance or block the canonical automation cursor.

## Learner procedure

The workflow prompt must instruct the agent to execute this procedure, not merely describe the architecture.

### 1. Resolve and bound the cycle

1. Read the task, goal, and supplied trigger context.
2. Resolve `scopeId` from the task and verify it belongs to the goal.
3. Read scope policy, metric definitions, timeline, evidence after the supplied cursor, prior metric snapshots, candidate/active lessons, and open/created proposals.
4. Recall only scope-relevant Learner memory.
5. Attach any missing task/workflow-run evidence referenced by the trigger, and atomically extend the frozen cycle claim to include exactly those rows. This runs **before** the empty-claim check so a trigger whose only evidence is a missing referenced row is never silently marked covered. The dispatcher reserves a `triggerEvidenceBudget` out of `maxEvidencePerEpisode` at claim time for these attachments; the exact-match episode check validates the union of reserved prefix evidence plus attached trigger rows, which must remain ≤ `maxEvidencePerEpisode`. If the prefix already fills the cap and a newly attached trigger row would exceed it, the handler defers that attached row (and its trigger context) to a continuation rather than extending a full claim—never omit it and never exceed the cap.

   Attachments must not create a noncontiguous processed set. A newly attached row receives an append sequence at the tail of the evidence log, so if the scope has a backlog beyond the reserved prefix the attachment would land at, say, position 101 while the prefix is 1–8—and a scalar cursor advanced through 8 would either reprocess 101 later or strand 9–100. Therefore the canonical processed boundary is a **gap-aware set** (processed evidence IDs plus explicit pending ranges), not a scalar. A cycle that includes an out-of-prefix trigger attachment records those IDs as claimed ranges in that set and terminalizes them as examined; intervening unprocessed ranges remain pending. The implementation may use a scalar cursor only for cycles whose processed set is genuinely contiguous; any attachment beyond the contiguous prefix requires the gap-aware representation so no evidence is reprocessed or stranded.
6. Select a coherent evidence cluster from the remaining capacity after trigger reservation, capped by `maxEvidencePerEpisode`, while preserving a contiguous cursor prefix. Prioritize trigger evidence within that prefix; if it lies beyond the cap, durably defer it to the next cycle rather than skipping intervening evidence.
7. Before declaring the claim empty, run the observation pre-checks: capture any due metric snapshot (a scheduled self-nag often fires precisely when a verification window has elapsed, with no new preexisting evidence), and identify earlier proposals whose verification window has now closed or whose outcome is otherwise measurable (due validations). The cycle is **not** no-op if any of these holds, even when the pre-existing evidence claim is empty—the freshly captured snapshot is attached via the observation claim-extension path and the due proposal proceeds to validation. Only when there is no new evidence, no observable metric, and no due validation may the Learner record a no-op decision artifact and complete without creating an empty episode; this prevents scheduled cycles from repeatedly reporting `no_op` while an awaited proposal never gets validated.

### 2. Observe and measure

Observation steps create new evidence (metric snapshots create both a snapshot and a Forge evidence row; manual notes append evidence). These run after the claim is frozen, so each such creation uses the same authorized claim-extension path as trigger attachments: the handler reserves an `observationEvidenceBudget` (distinct from the trigger budget, sized in scope policy, default small) at claim time and atomically extends the claim with the new row, or—if the union would exceed the cap—defers that observation to the next cycle without consuming it in the current episode (the snapshot is still persisted as standalone metric data). Observation evidence appended beyond the contiguous prefix is subject to the same gap-aware processed-set rule as trigger attachments—it is recorded as a claimed range, never allowed to strand or reprocess intervening evidence. The exact-match episode check therefore never rejects observation evidence as `evidence_claim_conflict`, and the canonical cursor does not reprocess an observation already used by a validation/artifact.

1. Capture a **before/after or current** metric snapshot when metric definitions have observable values.
2. If a metric cannot be measured, record why in evidence rather than inventing a value.
3. Identify earlier proposals whose created tasks or expected verification windows are now represented in the evidence.

### 3. Create one episode

Call `create_forge_episode` with the selected evidence and a required `cycleKey` derived from the workflow task/run. Add `cycle_key` to episodes with a unique `(scope_id, cycle_key)` constraint, and make `createFromEvidence` an idempotent get-or-create transaction: a retry returns the existing episode and its already-created findings/lessons/proposals rather than invoking the judge or inserting children again. The handler must not trust the evidence IDs supplied by the model on the first call: inject the server-validated evidence claim into the handler and require an **exact set match** (same IDs, no omissions, no out-of-window extras) before the initial judge transaction; a mismatch fails with `evidence_claim_conflict` and the canonical cursor is never advanced. For automated cycles the claim is the server-reserved goal/scope lease claim (prefix evidence plus trigger attachments). For **manual** cycles there is no automation lease, so the Learner-built selection is committed as a task-local manual claim through a dedicated server-validated manual creation path: the handler validates the supplied set against `maxEvidencePerEpisode` (rejecting an oversized claim rather than letting an unbounded payload reach the judge), records the bounded evidence set against the task once, then enforces exact-match against that recorded manual claim on retry—manual evidence is never consumed from any automation window. Reuse checks compare against the recorded claim, not against whatever the first call happened to persist. On resume, the Learner first reads the review bundle/episode by cycle key and continues from its persisted state. The existing judge produces the draft episode, findings, candidate lessons, and candidate proposals only on the first insertion. Do not recreate these objects manually unless correcting a specific judge omission.

Bound metric history before invoking the judge. `buildEpisodeInput` currently calls `listMetricSnapshots(scope.id)` unbounded (`evolution-episode-service.ts:224`), so a long-running recurring scope serializes its entire accumulated history into every prompt and cost grows with scope lifetime. The implementation must pass an evidence/validation window plus a bounded baseline (for example the earliest and most-recent N snapshots per metric) to the judge, never the full history—keeping prompt size and cost bounded regardless of scope age.

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

A proposal without both fields remains `proposed` and cannot be accepted or materialized into a task. Acceptance (and task materialization) additionally requires every one of the proposal's causal `evidenceEpisodeIds` to be **accepted**: a proposal generated from a dismissed episode cannot be accepted or materialized, since the cycle has declared its evidence unusable. The accept and materialize handlers enforce this, and a level-1 bundle may not pair an episode-dismiss disposition with acceptance of a proposal linked to that episode.

Use a one-high-confidence-proposal-per-cycle default to limit self-generated work. Additional candidates may remain proposed for later review. Proposal acceptance and task materialization are distinct authorities: level 2 may accept a proposal, but `create_task_from_forge_proposal` requires both Space autonomy level 3 or higher **and** `scope.policy.automation.createTasksFromAcceptedProposals === true`, plus the existing no-duplicate/idempotency checks.

Enforce this in the `create_task_from_forge_proposal` MCP handler (or a shared evolution scope-policy service called by it), before `episodeService.createTaskFromProposal`. The autonomy leg uses the cycle's pinned `cycleAutonomyMode` when a learning-cycle context exists (not a live re-read of Space autonomy), so materialization is consistent with the rest of the cycle. A non-Learner caller has no learning cycle and therefore no pinned mode; for those previously supported callers the handler falls back to the caller's current effective Space autonomy. The scope opt-in leg always reads current `scope.policy.automation.createTasksFromAcceptedProposals`. Return a structured authorization error when either condition is absent. Hiding the tool from the Learner profile when scope opt-in is false is useful UX but is not the security boundary.

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

Never rewrite the original expectation after observing results. Link the validation to the originating proposal, its created task when present, the validating episode, and metric snapshots. Finalization requires its validating episode to be **accepted**: an episode dismissed in the same cycle for weak or contaminated evidence cannot ground an effective/ineffective verdict or activate a lesson. The finalize handler enforces this; a validation linked to a dismissed episode must remain rejected/deferred, and a level-1 bundle may not pair an episode-dismiss disposition with a validation `finalize`.

Each completed validation produces or updates a lesson:

- effective → activate a rule describing what to repeat and under which conditions;
- ineffective → activate a caution describing what not to repeat and why;
- superseded → activate only when the replacement itself yields a reusable rule; otherwise retain the validation without forcing a lesson.

If no suitable candidate lesson exists, call `create_forge_lesson` with the validation-derived rule, `status: 'candidate'`, and links to the validating episode/proposal, then activate it only after the same level-2 disposition gate. Validation creation must not silently synthesize an active lesson because lesson review and validation finalization remain independently auditable.

### 6. Roll up and finish

1. Apply a concise goal rollup only when the episode is accepted **and** the goal type is `recurring`: summary, metric deltas, and next steps. The current rollup service rejects dismissed episodes and every non-recurring goal, and it strips `progress` before calling the goal service (`evolution-episode-service.ts:409-410`); `SpaceGoalService.updateGoal` independently deletes progress for recurring goals (`goal-service.ts:151-157`). Do **not** set `rollup.progress` until a dedicated recurring-progress mechanism exists in the goal service; record evidence-backed progress as a metric snapshot and in the terminal artifact's `rollup.metric_deltas` (matching the validated schema) instead, so the field is never silently dropped. For an accepted `one_shot` or `measurable` goal, preserve the learning result in Forge and the terminal artifact but leave goal state unchanged; any later support for those goal types belongs in the goal service rather than this workflow. For a dismissed episode, preserve the dismissal reason and likewise leave goal state unchanged. In every path, advance the cursor only under the contiguous-prefix rule above.
2. Write only non-Forge operational heuristics to `learner/<scope-id>/...` memory.
3. Save the terminal learning-cycle artifact.
4. Call `approve_task` as the final action; if autonomy blocks it, call `submit_for_approval` instead.

Autonomy must be pinned for the whole cycle. Capture a `cycleAutonomyMode` (the Space autonomy level effective at cycle start) on the learning task and use it consistently in every mutation and terminal handler for that cycle. If the Space autonomy is lowered after the Learner has already passed the level-2/3 gates, `approve_task`/`submit_for_approval` and every disposition handler still use the pinned mode, so the run cannot strand itself with half-applied Forge rows, a half-updated goal, or follow-up tasks that a later rejection cannot undo. (Equivalently, stage all gated mutations and commit them in one atomic terminal transaction.) The pinned mode is recorded in the terminal artifact.

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
    evidenceEpisodeIds: string[];
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

Extend the repository/service params and the `create_forge_task_proposal` and `update_forge_task_proposal` MCP schemas—not only the stored interface—so the Learner can fill incomplete judge output. Draft/proposed and legacy rows may carry `null`; do not invent backfill values. On transition to `accepted`, the proposal service validates both verification fields and atomically snapshots the entire causal contract: action (`title`, `description`, `reason`, `priority`), expected outcome, verification method, **and the evidence episode links** (`evidenceEpisodeIds`). While status is `accepted` or `created`, it rejects edits to any snapshotted field, including evidence links, so provenance used by validation and materialization cannot be reassigned after the outcome is known. `UpdateTaskProposalParams.evidenceEpisodeIds` edits are rejected in those states. Validation reads its expectation from this immutable snapshot, and task materialization must use the snapshot's action and evidence links verbatim; remove or reject materialization-time action/evidence overrides.

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
  attemptKey: string;
  bundleRevision: number | null;
  supersedesValidationId: string | null;
  replacementProposalId: string | null;
  replacementTaskId: string | null;
  lessonId: string | null;
  createdAt: number;
  finalizedAt: number | null;
}
```

Uniqueness should be `(proposal_id, validating_episode_id, attempt_key)`. `attemptKey` is a per-cycle attempt revision that exists on both paths: for level-1 cycles it equals the bundle revision (`bundleRevision` non-null); for autonomous (level ≥ 2) cycles there is no review bundle, so `bundleRevision` is null and `attemptKey` is the cycle/episode attempt sequence—giving autonomous validations a defined, queryable revision without inventing bundle semantics. A rejected validation is immutable; corrected resubmission creates the next attempt with `supersedesValidationId` pointing to it, preserving the audit chain. Only one pending/final validation may be current for a proposal/episode, and a bundle may reference validations from its own revision only. Exactly one of `replacementProposalId` or `replacementTaskId` may be set for a superseded verdict; both are null otherwise. `replacementTaskId` must reference a task linked to the same goal/Forge scope, and the finalize handler validates that relation—rejecting an unrelated task so the audit chain cannot be corrupted. `lessonId` is **required** (non-null, same-scope active lesson) when finalizing an `effective` or `ineffective` verdict—the reusable rule is the point of the cycle; it stays nullable only for `superseded` verdicts that yield no reusable rule. The finalize handler enforces this. Add create/list/finalize/reject service operations and include validations in `list_forge_review_bundle` and the judge prompt. Creation at level 1 stores `pending`; finalization/rejection is the autonomy-gated disposition. Keep `episode.outcomeSummary`, findings, and metric snapshots as the outcome evidence; this record is the missing explicit expected↔measured↔verdict link.

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

   Make the preset **collision-safe**. An existing Space may already contain a user-created agent named `Learner`; `SpaceAgentManager.create` rejects the backfill as a name collision, while `seedBuiltInWorkflows` resolves a template slot by the first case-insensitive name match and would bind `learning-workflow` to the unrelated custom agent. Give the preset a canonical identity distinct from display name—a stable preset `slug`/`presetId` (for example `learner`) that `SpaceAgentManager` treats as authoritative for built-ins, and require workflow template resolution to match that preset identity rather than an arbitrary agent name. Where a user `Learner` already exists, the migration backfills the preset under the canonical identity (optionally with a distinct display name) and never silently re-binds the workflow to the user's agent. The Learner-specific provisioning path likewise identifies sessions by preset identity, not display name, so automation always runs the secured prompt and filtered servers.
2. **Automation dispatch:** resolve the workflow; serialize triggers through a goal/scope lease; use a canonical evidence cursor; persist external-event evidence at publication with append ordering; sequence/merge all trigger contexts and drain uncovered contexts through continuations; exclude learning-task self-triggers; transactionally commit terminal state/cursor/reservation/outbox; reconcile legacy terminal writes; isolate manual runs; remove direct episode/review-task creation.
3. **Learner prompt + tool policy:** provision scope-bound filtered MCP servers and a filtered Learner memory server (prefix-enforced writes, no delete) instead of the ordinary agent-memory server, and make that choice survive the required-servers self-heal (drop `'agent-memory'` from the required list for Learner sessions, or make `reinjectAgentMemoryMcpServer` re-inject the filtered server); enforce level 2 in disposition/rollup handlers; make both terminal handlers validate the decision artifact; make `submit_for_approval` atomically create revisioned whole-cycle review bundles with reviewed-row snapshots; make initial episode creation enforce the server-reserved evidence claim; route level-1 bundle apply through a verified-operator surface that is excluded from `approve_pending_completion` and rejects stale rows; add level-3 plus scope-policy materialization gating.
4. **Validation model:** add cycle-key-idempotent episodes; migrate nullable proposal fields and immutable full causal snapshots; extend mutation schemas; remove materialization overrides; add audited legacy repair; add pending/final/rejected validations with replacement links; feed validations to judging.
5. **Tests:** existing-Space migration restricted to legacy-automation-origin episodes for cursor seeding (manual/ambiguous evidence left pending), Learner name-collision backfill under a canonical preset identity, built-in workflow seeded under a canonical templateSlug despite user name/handle collisions with automation resolving that identity, goal/scope lease held for active legacy automation reviews until terminal, and legacy-episode cursor reconciliation on release (no duplicate native episode); cross-trigger serialization/canonical cursor; publication-time and legacy-late external evidence; durable external-event outbox merged idempotently with evidence+dedup (crash after dedup marker does not drop the trigger); trigger-evidence attachment ordered before the no-op check with reserved trigger budget and cap-preserving deferral (no `evidence_claim_conflict`, no over-cap claim); gap-aware processed set for trigger/observation attachments beyond the contiguous prefix (no reprocess, no strand); observation/due-validation pre-check before the no-op exit (a self-nag with no preexisting evidence still validates an elapsed proposal instead of repeating no_op); observation-evidence (metric snapshot/manual note) claim extension and over-cap deferral; bounded metric history passed to the judge on a long-lived scope; manual task-local claim exact-match path with server-enforced maxEvidencePerEpisode, manual `triggers[]` entry, and manual-vs-automated lease serialization; uncovered merged-context continuation for every trigger kind; abandoned-task handling that reconciles already-committed cycle effects (no duplicate episode/rollup/task), retires pending bundles/validations when cancelled in review, requeues only uncommitted claims, and is non-retryable (or retry reclaims lease + revokes replacement); self-trigger exclusion by templateSlug/nonTriggeringForGoalAutomation (not handle) including the colliding-handle case; durable completed-task threshold outbox and recovery when inline fire fails (threshold 1); cycle-key retry and recorded-claim exact-match rejection on the first call; autonomous artifact enforcement with `pending_validation_ids` present in the schema; no-op identity; ordered multi-trigger `triggers` array in the artifact; pinned `cycleAutonomyMode` used by Learner materialization and surviving a mid-cycle lowering, with non-Learner callers falling back to current effective autonomy (no stranded half-applied run); level-1 bundle creation, rejection/stale revision advance with atomic pending-validation retirement, no-retain validation disposition, resubmission creating replacement validations, verified-operator-only apply, and coordinator rejection; autonomous (level ≥ 2) validation finalize/reject tool availability with null bundleRevision and attempt-key uniqueness, effective/ineffective finalization requiring a same-scope active lesson (superseded nullable), and same-scope validation of replacementTaskId; rejected/deferred validation linked to a dismissed episode (no finalize); proposal acceptance/materialization requiring accepted causal episodes (no accept from a dismissed episode; no bundle dismiss-episode+accept-proposal); continuation races/reconciliation; manual isolation; paused coalescing; cross-scope denial; filtered memory server (prefix/write/delete denial) surviving a rehydrate through `ensureNodeAgentAttached`; validation/lesson availability; legacy proposal repair/immutable snapshots (incl. evidence links)/no overrides; autonomy gates; accepted recurring rollup with progress recorded as `metric_deltas` (no silent drop) plus non-recurring/dismissed no-rollup paths; validation links; no PR dependency.

## Open owner decisions

1. **One proposal per cycle:** Recommendation: default maximum one newly accepted/materialized proposal, configurable in scope policy; unlimited candidate proposals may remain `proposed`.
2. **Memory isolation timing:** Is the logical `learner/<scope-id>/` namespace sufficient for N1, or must repository-enforced agent ownership land first? Recommendation: ship logical namespacing with an explicit non-security warning; make enforced namespaces a separate migration.
3. **Superseded lessons:** Recommendation: do not force every superseded validation into a lesson; only create one when the replacement yields a reusable rule.
4. **Automation migration:** Existing pending automation review tasks should finish on their pinned/current workflow; only newly queued cycles use `learning-workflow`. Do not rewrite active tasks in place. To preserve serialization across the cutover, the upgrade migration must seed (or hold) the new goal/scope lease for every active legacy automation review task on each affected scope and release it only when that task reaches a terminal status; otherwise a freshly delivered trigger can start a Learning Workflow while the legacy reviewer is still accepting/dismissing that scope's episodes, lessons, and proposals. On reaching terminal status, the held lease must be released in the **same** transaction that reconciles the legacy episode into the canonical cursor/pending-range state: advance the contiguous processed prefix through evidence linked to the accepted/dismissed episode, or record those IDs as examined/deferred. Releasing the lease without this reconciliation lets the next native cycle reclaim the same evidence and generate a duplicate episode.

## Conclusion

The missing component is not another Forge store or another always-on coordinator. It is a bounded native execution path that lets a purpose-built worker use the stores already present, close without GitHub ceremony, and explicitly test whether prior proposals worked. The single-node Learning Workflow supplies that path while preserving the separation of Steering (goal), Learning (Forge), and Execution (workflow).
