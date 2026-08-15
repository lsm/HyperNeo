# Long-Horizon Marketing Agent Roadmap

**Status:** Proposed

## Purpose

Build the platform capabilities required for a long-horizon marketing agent to act as a durable manager: maintain multiple goals, delegate bounded work, react to external and internal events, schedule future-self wakeups, integrate worker outcomes, update structured state, and preserve knowledge across context windows.

Marketing is the forcing scenario, but the design applies to every long-horizon (LH) Space agent.

## Prerequisite: Message Delivery V2

Message Delivery V2 landed in PR #2417, but current adoption is flag-gated ordinary chat. Space/LH injectors still persist and feed session message queues directly.

This roadmap depends on completing a narrow V2 foundation before owner-report routing and reminder/event migration:

1. Expose durable acceptance receipts (`jobId`, `messageUuid`, role).
2. Expose delivery-status lookup with explicit accepted/consumed/completed/failed semantics.
3. Add an LH durable-injection adapter that ensures the target session, persists one deterministic SDK message, and transfers last-mile ownership to V2.

Domain systems remain upstream of V2:

```text
outcome report / reminder / external event / inactive-agent inbox
  -> domain persistence, routing, and activation
  -> concrete session
  -> Message Delivery V2
  -> SDK/provider
```

Do not implement owner-report delivery before this prerequisite is complete. In particular, durable enqueue is not synonymous with model-visible delivery, and V2 does not currently rehydrate missing sessions.

Space task **#860, “Add idempotent message delivery ownership,”** is the active Message Delivery V2 follow-up and the concrete prerequisite for this roadmap's V1–V3 foundation. It is itself sequenced after task #859. Rebase this roadmap's implementation work on the merged `dev` state from #860 rather than duplicating its generic delivery ownership or ordinary chat/Space submission work.

> Note: PR #2341 is already merged and is unrelated to Message Delivery V2. PR #2417 is the merged V2 substrate; task #860 owns the active follow-up.

## State and authority model

Use each storage layer for one purpose:

- **Space goals:** operational truth—objective, rolling summary, progress, metrics, next steps, task pointers, and check-in cadence.
- **Tasks/workflows:** bounded execution.
- **Outcome reports:** immutable worker observations and recommendations awaiting owner disposition.
- **Goal events:** append-only audit of applied goal state changes.
- **Agent memory:** durable knowledge, decisions, channel playbooks, audience insights, and operating conventions.
- **Forge:** evidence, experiments, episodes, lessons, and proposals.
- **Prompt context:** immediate working set only.

Authority is intentionally separated:

```text
bounded worker -> immutable outcome report -> primary LH goal owner
                                              |- integrate evidence
                                              |- update rolling goal state
                                              |- choose next work
                                              `- schedule future wakeup

coordinator -> ownership governance, conflict resolution, explicit fallback
```

Workers report facts and recommendations. They do not directly manage durable goal strategy. The primary owner applies or rejects reports. The coordinator handles missing/unavailable ownership and privileged changes.

### Required invariants

1. At most one LH assignment with relationship `owner` per goal.
2. `manager` and `watcher` remain many-to-many and are not mutation-authoritative by default.
3. One immutable outcome report is created atomically with each reportable terminal transition, keyed by a durable task terminal generation.
4. Task completion does not depend on successful report notification, but terminal capture cannot be skipped by a worker.
5. Notification retries cannot duplicate reports or recipient inbox messages.
6. Workers may propose rolling-state changes but cannot apply them after migration.
7. Only the current owner, an explicit fallback coordinator, or human authority may decide and apply a report; current ownership is validated inside the decision transaction.
8. Decision and goal mutation are atomic and idempotent.
9. Applied updates continue through `SpaceGoalService` so goal events and recurring-goal rules remain authoritative.
10. Forge evidence is a retryable projection, not the outcome source of truth.
11. Lifecycle events are durably captured in the same transaction as their domain mutation, with asynchronous post-commit publication and reconciliation.
12. Restrictions ship only after owner routing and decision/apply paths work.

## Delivery architecture

Use V2 for every final injection into a resolved concrete LH-agent session. Keep specialized ledgers for upstream business state and activation.

A safe V2 contract must distinguish:

- **accepted:** SDK message and delivery job are durable;
- **consumed:** prompt crossed the selected SDK-admission boundary;
- **completed:** owning turn ended, not necessarily business success;
- **failed/rejected:** delivery cannot proceed or exhausted retries.

The source system decides which receipt advances its own record. Reminder occurrences, external-event deliveries, inbox rows, and outcome reports do not necessarily share the same threshold.

## Implementation plan

The target is one behavioral contract per PR, normally no more than 200 changed production lines (tests excluded). A cohesive PR may reach 250 lines; split any larger change that contains multiple contracts.

### Stage V — Message Delivery V2 last mile

#### V1. Delivery acceptance receipt

- Return job ID, message UUID, and turn/steer role from enqueue.
- Define durable `accepted` semantics.
- Do not migrate Space callers yet.

**Estimate:** 70–120 production lines.

#### V2. Delivery status lookup

- Query by job ID or `(sessionId, messageUuid)`.
- Distinguish accepted, consumed, completed, failed, and rejected/skipped outcomes.
- Document role-specific completion semantics.

**Estimate:** 80–140 lines.

#### V3. LH durable-injection adapter

- Ensure or rehydrate the target LH session before enqueue.
- Accept a caller-provided deterministic UUID.
- Persist one SDK user message and enqueue it through V2.
- Return explicit receipt data instead of a boolean `delivered` result.

**Estimate:** 120–190 lines.

#### V4. Migrate LH reminder delivery

- Preserve the deterministic reminder-occurrence UUID.
- Advance one-shot/cron state only at the selected receipt boundary.
- Define terminal-delivery failure recovery before advancement:
  - do not mark a one-shot occurrence fired merely on durable acceptance;
  - a terminal V2 failure creates a new attempt generation or explicit degraded/manual-retry state rather than silently skipping the occurrence;
  - deterministic occurrence identity plus attempt generation prevents repeated scans from colliding with the failed delivery.
- Remove bespoke probes/timeouts only after V2 provides equivalent guarantees.

**Estimate:** 100–180 lines, likely deletion-heavy.

#### V5. Migrate LH external-event delivery

- Correlate external-event delivery key with V2 message/job identity.
- Keep subscription, TTL, activation, and source-delivery state upstream.
- Remove duplicate last-mile retry ownership only after V2 acceptance.

**Estimate:** 120–200 lines.

#### V6. Migrate inactive LH inbox delivery

- Preserve actor activation and inbox persistence.
- Mark inbox rows terminal according to an explicit V2 receipt.
- Prevent restart races from creating duplicate transcript rows.

**Estimate:** 90–170 lines.

Task-agent and Space-chat injection require separate later migration because they also carry defer, image, cooldown, reset-context, topology, and reply-session behavior.

### Stage L — Native Space lifecycle events

#### L1. Lifecycle topic and payload contract

- Canonical `space/task.*` and `space/goal.*` grammar.
- Typed actions and payloads containing stable IDs, statuses, labels, and linkage.

**Estimate:** 100–170 lines.

#### L2. Lifecycle emitter leaf

- Publish through the existing durable external-event service.
- Build stable dedupe keys and event essence.
- Wire composition only; no mutation producers.

**Estimate:** 120–200 lines.

#### L3. Goal-service producer wiring

- Emit goal creation, status, progress, check-in, and task-trigger events.
- Persist an outbox lifecycle-event record in the same transaction as the goal mutation.
- Publish the outbox record asynchronously after commit; a relay/reconciler must recover committed-but-unpublished records.

**Estimate:** 130–220 lines.

#### L4. Task-manager producer wiring

- Emit task creation and meaningful status transitions after successful updates.
- Persist each task lifecycle outbox record atomically with its state transition; do not rely on a separate post-commit publisher call.

**Estimate:** 130–220 lines.

#### L5. Lifecycle bypass-path coverage

Audit and wire paths that bypass nominal services/managers, including scheduled task creation, dependency cascades, automation, and post-approval completion.

**Estimate:** 150–250 lines.

#### L6. Lifecycle completeness audit

Maintain a mutation-path coverage matrix and close remaining production gaps. Most changes should be tests and small corrections.

**Estimate:** 0–100 production lines.

### Stage S — Subscription precision and controls

#### S1. Typed filter contract

Start with a narrow, versionable contract:

```ts
interface SpaceLifecycleSubscriptionFilter {
  labelsAny?: string[];
  statusesAny?: SpaceLifecycleStatus[];
}
```

- Define normalization and any-match behavior for each supported field; multiple fields combine with AND.
- Reject unsupported fields.
- Migrate **all** built-in template filters before enabling strict rejection:
  - `labels` filters to `labelsAny` for marketing, product-quality-manager, and research;
  - coordinator `statuses` filters to typed `statusesAny` or equivalent exact status topics.
- Backfill or repair already persisted legacy `labels` and `statuses` subscription rows in the same release so existing agents do not silently lose matching.
- Handle the singular `{ label: ... }` metadata written by the existing `subscribe_agent_event` MCP contract. It is not payload filtering: either move it to a separate typed display-label field with a migration or intentionally map it to payload semantics before rejecting it. Update the MCP contract so it cannot continue creating unsupported filters.

**Estimate:** 140–210 lines.

#### S2. Runtime filter enforcement

- Carry filters into LH subscription targets.
- Evaluate them before registering expected delivery.
- Preserve behavior through rehydration and retries.

**Estimate:** 70–140 lines.

#### S3. LH subscription UI

- Per-agent list/create/edit/status/delete controls.
- Separate topic glob editing from structured payload filters.
- Reuse existing RPC and web-store CRUD.

**Estimate:** 140–240 lines.

### Stage G — Goal ownership and outcome integration

#### G1. Primary-owner invariant

- First reconcile pre-existing duplicate `owner` rows deterministically or require an explicit repair decision, because existing databases may already contain multiple owners for a goal.
- Only after reconciliation/add data-repair coverage, add a partial unique constraint for one `owner` per goal.
- Preserve multiple managers/watchers.
- Make unassignment relationship-specific.

**Estimate:** 130–220 lines.

#### G2. Owner resolver and atomic reassignment

- Add `getPrimaryGoalOwner` and `replacePrimaryGoalOwner`.
- Return explicit no-owner/unavailable/fallback reasons.

**Estimate:** 100–170 lines.

#### G3. Ownership RPC and MCP parity

- Relationship-aware list/assign/unassign operations.
- Same-Space validation and deterministic conflicts.
- Restrict owner assignment/reassignment/unassignment to the coordinator or explicit human authority. Same-Space validation alone is insufficient because this MCP server is attached to ad-hoc member and LH sessions.
- Owners, managers, and watchers may read their assignments; only governance authorities mutate the primary owner.

**Estimate:** 120–190 lines.

#### G4. Ownership UI

- Goal owner picker/readout.
- Agent managed-goals/scopes section.
- Visible unowned/degraded fallback state.

**Estimate:** 140–230 lines.

#### G5. Immutable outcome-report schema and repository

Add a narrow `space_goal_outcome_reports` model with:

- Space, goal, durable task identity, and terminal-generation identity;
- reporter session/node identity;
- immutable outcome summary, observations, recommendations, proposed goal update, and evidence references;
- creation and routing metadata.

Before this schema, add a durable task terminal-generation identifier to the task/terminal transition. Every reportable transition into a terminal status must atomically allocate or advance that generation, and the report uniqueness key must be `(task_id, terminal_generation)` rather than a timestamp such as `completedAt`, which is assigned too late and may change on reopen/re-completion.

Preserve immutable reports when a linked task would be hard-deleted: either replace hard deletion with archival for reported tasks, or store a durable task identity independent of the foreign key and prohibit deleting the report. Do not use a default cascading foreign key that erases the only outcome record, and do not null the identity key.

Do not provide payload update/delete methods.

**Estimate:** 150–230 lines.

#### G6. Terminal transition captures outcome report

- Define one shared reportable-terminal predicate before implementation. Goal-linked tasks entering `done` or `blocked` require reports; `cancelled` and `archived` require reports only when they terminate previously active goal work rather than an administrative cleanup. The predicate must be versioned and covered by tests so every writer applies the same rule.
- Add a durable task-scoped pending-outcome record for supervised/pre-terminal submissions. A worker can submit structured observations, recommendations, proposed updates, and evidence references while a task is in `review`; that payload must survive until approval and post-approval work complete. The terminal transition atomically consumes the pending outcome into the immutable report and terminal generation.
- Create the report as part of the central reportable terminal transition, not as an optional model-invoked tool. A worker may submit the structured outcome payload before or during completion, but the terminal command/transition must guarantee one report exists even when the worker omits the tool call.
- Audit every reportable terminal writer and route it through the atomic transition. This must include direct repository writers such as `PostApprovalRouter.route`, whose no-route branch currently completes with `taskRepo.updateTask` and intentionally bypasses `setTaskStatus`.
- Keep notification/routing asynchronous and non-blocking.
- Validate the caller/session associated with the linked task/goal when a structured payload is supplied.
- If a linked Forge scope exists, create a durable pending/failed Forge-projection record with the report and let a reconciler retry that projection; keep the outcome report authoritative.

This is the required behavior currently absent from `mark_complete.goal_update`; without terminal-capture, a normal completion can produce no report.

**Estimate:** 190–270 lines; split pending-outcome persistence from terminal capture if it exceeds 250.

#### G7. Owner routing through V2

- Resolve the current primary owner.
- Activate/rehydrate the owner session.
- Deliver through the LH V2 adapter.
- Use explicit coordinator fallback when the owner is absent or unavailable.
- Tie route generation to an ownership version. `replacePrimaryGoalOwner` must invalidate or supersede routes for unresolved reports and enqueue a fresh deterministic route to the new owner; a routed former owner must not leave the report stranded even though it cannot decide it.
- Atomically persist durable routing work with report creation or require the dispatcher to scan every unrouted/superseded report. Delivery identity must be deterministic from report ID plus route generation so restart recovery is idempotent.
- Persist routing outcome without blocking task completion; a committed report must not be lost because the daemon exits before the asynchronous route call starts.

**Dependencies:** G1–G6 and V1–V3.

**Estimate:** 170–250 lines.

#### G8. Owner decision and atomic apply

- List/read reports for the primary owner.
- Define coordinator and human read/list/decision authorization in this same PR so a report routed through fallback cannot remain undiscoverable.
- Accept as proposed, apply edited, acknowledge without mutation, or reject.
- Atomically transition disposition and update the goal.
- Validate current ownership inside the same transaction that claims the report and updates the goal: a checked-but-since-reassigned owner must lose the claim. Coordinator and human override remain explicit exceptions.
- Reference the report in the goal event.
- Apply recurring-goal progress rules.

**Estimate:** 170–250 lines.

#### G9. Authorization and compatibility migration

- Restrict every goal-mutating MCP/RPC operation—not only worker paths or `mark_complete`—to the current primary owner, coordinator, or explicit human authority. This includes `update_goal`, pause/resume, archive/complete, schedule/cadence changes, and goal-task triggering. Managers, watchers, unrelated LH agents, and ordinary member sessions must not bypass owner disposition by rewriting goal strategy directly.
- Deprecate direct `mark_complete.goal_update` application in favor of outcome-report submission and owner disposition.
- Apply equivalent owner authority to Forge rollups.
- Preserve coordinator/human override policy.
- Migrate centralized worker prompts and the `mark_complete` schema descriptions before enabling restrictions. Existing goal-linked workers are instructed to update goals through goal tools or `goal_update`; they must instead be instructed to submit reports and let the owner decide.

**Estimate:** 160–240 lines.

### Stage R — Direct LH reminders and self-nagging

Forge goal-automation self-nag remains a separate evidence-processing mechanism. This stage concerns direct future-self LH-agent reminders.

#### R1. Reminder lifecycle APIs

- Update title/body/schedule.
- Pause, resume, and semantic cancel.
- Recompute cron `nextRunAt` and explicitly handle past one-shot resumes.
- Add MCP parity, including cron reminders and paused/fired status filters.
- Enforce mutation authorization inside every MCP handler, not only RPC/UI: the reminder's owning LH agent, explicit coordinator authority, or human authority may edit/pause/resume/cancel; ordinary ad-hoc member sessions must not mutate another agent's wakeups.

**Estimate:** 170–250 lines.

#### R2. Optional single-goal link and bounded context

Each reminder links to zero or one goal. Portfolio reminders remain unlinked and tell the agent to inspect assigned goals. On create/edit, validate `goal.spaceId === reminder.spaceId`; goal IDs are globally addressable, so a plain foreign key is not enough. Revalidate the link at fire time and treat a cross-Space, deleted, or archived link as unavailable rather than injecting context.

At fire time, include bounded current state:

- goal identity, status, type, and priority;
- progress only for non-recurring goals;
- truncated summary;
- limited metrics and next steps;
- active/last task IDs.

Do not inject task results, transcripts, event history, Forge evidence, or every assigned goal.

**Estimate:** 110–180 lines.

#### R3. Reminder UI: list/create/cancel

- Full reminder list for the selected LH agent.
- One-shot and cron creation.
- Status, timezone, next run, and last run.
- User-facing cancellation calls the R1 semantic-cancel API and preserves cancelled reminders and firing history in the full list. Physical deletion, if retained, is a separate administrative action rather than the default cancel behavior.
- Reminder-count refresh.

**Estimate:** 120–200 lines.

#### R4. Reminder UI: edit/pause/resume/goal link

- Edit schedule and prompt.
- Pause/resume controls.
- Optional goal selector and context indicator.

**Estimate:** 100–180 lines.

## Dependencies and parallelism

```text
V1 -> V2 -> V3 -> V4
              |-> V5
              `-> V6

L1 -> L2 -> L3
       |-> L4
L3 + L4 -> L5 -> L6

L1 -> S1 -> S2 -> S3

G1 -> G2 -> G3 -> G4
G1 -> G5 -> G6
V3 + G2 + G6 -> G7 -> G8 -> G9

R1 -> R2 -> R3 -> R4
V3 -> V4 before reminder V2 migration is considered complete
```

Parallel starting points: V1, L1, G1, and R1. G5 is **not** an independent starting point; it follows G1 so report routing records can reference the authoritative primary-owner model.

## Scope intentionally deferred

- Task-agent and Space-chat V2 migration.
- Broad LH operations dashboard; contextual controls ship first.
- Full goal-history viewer; recent events already render and pagination is optional polish.
- Automatic ownership from template `ownershipPatterns`.
- Arbitrary subscription-filter DSL.
- A second goal/mission model or planner service.
- Reddit, X, email, CMS, analytics, and outbound publishing connectors.
- Automatic objective rewriting or external publication without explicit authority.

Each external connector is a separate project requiring credentials, ingestion/polling/webhooks, normalization, permissions, rate limiting, outbound approval, and connector-specific testing.

## Estimate and review policy

The roadmap contains **28 PRs**:

- V2 last mile: 6
- Lifecycle publication: 6
- Subscription filtering/UI: 3
- Goal authority/outcomes: 9
- Reminders: 4

Most should remain below 200 changed production lines. Use 250 as a soft ceiling. A PR above 250 must either be split or explain why one cohesive behavioral contract requires the larger diff.

Tests are not included in these estimates. Schema migrations, failure-path tests, concurrency tests, restart/retry tests, and authorization tests are required where relevant.

## Success criteria

A marketing LH agent can:

1. Own multiple structured goals while each goal has one primary owner.
2. Receive immutable worker outcomes without workers rewriting strategy.
3. Integrate outcomes into metrics, summary, and next steps exactly once.
4. Delegate follow-up work according to autonomy and authority.
5. React to relevant goal/task lifecycle events using enforced filters.
6. Create, edit, pause, resume, cancel, and link future-self reminders.
7. Wake reliably through Message Delivery V2 after the target session is resolved.
8. Preserve operational truth in goals, knowledge in memory, and learning evidence in Forge.
9. Fall back visibly to the coordinator when ownership is absent or unavailable.
10. Continue operating across daemon restarts and model context resets without relying on transcript context as durable state.
