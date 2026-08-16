# Long-Horizon Agent Roadmap

**Status:** Proposed

## Purpose

Build the platform capabilities required for any long-horizon (LH) Space agent to act as a durable manager: maintain multiple goals, delegate bounded work, react to external and internal events, schedule future-self wakeups, integrate worker outcomes, update structured state, and preserve knowledge across context windows.

Marketing is the first forcing scenario, but the architecture is intentionally general and applies to coordinator, product-quality, release, research, security, sales, and custom LH agents.

## Minimal core

The full roadmap below is the robust target. It should not block first dogfooding. We already have goal persistence, goal tasks, LH sessions, assignments, reminders, task tools, agent memory, and Forge. The smallest useful core is therefore **five PRs**, sequenced after the Message Delivery V2 follow-up in task #860.

### MC1. Goal owner assignment and resolver

- Use the existing LH-agent/goal assignment relationship.
- Enforce or safely resolve one primary owner per goal.
- Add `getPrimaryGoalOwner(goalId)` and coordinator fallback.
- Reconcile duplicate owners deterministically before enforcing the invariant.
- Keep managers/watchers non-authoritative for now.

**Why it matters:** routing and goal authority need a stable destination.  
**Estimated size:** 130–220 production lines.

### MC2. Minimal owner wake-up on goal-task terminal state

- At the existing goal terminal seam, resolve the primary owner.
- Persist a minimal outcome-notification record.
- Wake the owner through the LH durable-injection adapter from task #860 / V3.
- Include the completed task result, linked goal, and current rolling goal state.
- Fall back to the coordinator when no usable owner exists.

This intentionally reuses task results and current delivery/inbox primitives instead of building the full immutable report model first.

**Why it matters:** the goal now reacts to work completing instead of waiting for a human or a weekly reminder.  
**Estimated size:** 170–250 production lines.

### MC3. Owner goal-review MCP tool

Add one explicit tool such as `review_goal_outcome` that the awakened owner can call. It receives:

- goal ID;
- completed task ID;
- optional structured observations and metric changes;
- summary, next steps, and follow-up intent.

The tool validates that the caller is the current primary owner or coordinator fallback, then applies the update through `SpaceGoalService`. Workers do not get this tool.

**Why it matters:** the LH agent becomes responsible for integrating outcomes and deciding next actions without immediately reworking every existing worker prompt or terminal path.  
**Estimated size:** 150–230 production lines.

### MC4. Minimal goal detail and ownership UI

- Show the primary owner on goal detail.
- Let a coordinator/human assign or reassign the owner.
- Show the latest owner-review outcome and next check-in.

Use existing goal history, task links, and goal editing surfaces. Do not build a broad dashboard yet.

**Why it matters:** operators can see and correct goal ownership before relying on autonomous behavior.  
**Estimated size:** 120–200 production lines.

### MC5. Prompt and template migration for the core loop

- Teach LH templates to create/own goals, inspect linked task outcomes, call the review tool, and create follow-up work.
- Teach goal workers to report bounded results without claiming ownership of overall strategy.
- Update the marketing template only as the first dogfood profile; keep the mechanism generic.

**Why it matters:** existing primitives only become a management loop when the prompts use the same contract.  
**Estimated size:** 80–160 production lines.

### MC6. Inactivity self-nag

Add a configurable inactivity watchdog for each LH agent. Keep the first version deliberately simple: use the latest message timestamp in the agent's persistent session as its last activity time.

- Read the latest message timestamp for the LH agent's persistent session.
- If `now - latestMessageAt` exceeds the configured threshold, inject a wake-up message into that session.
- The injected message becomes the latest session message, so the inactivity window naturally resets.
- This covers external events, reminders, task/goal wake-ups, direct human messages, agent-to-agent messages, and ongoing session work without a separate activity taxonomy.
- Make the threshold and prompt configurable per agent.
- Support enable/pause/resume and run-now controls.
- Do not fire while the agent or Space is paused, stopped, disabled, or archived.

Default policy can be enabled every 8 hours with a prompt such as:

> No session activity has been recorded for the configured period. Review assigned goals, active or stuck tasks, pending follow-ups, and current status. Create follow-up work or request help if needed.

**Why it matters:** an LH agent should not silently remain idle when no external event or task outcome arrives.
**Estimated size:** 140–220 production lines.

### Minimal-core boundaries

This core deliberately does **not** yet provide:

- full immutable outcome-report schema;
- terminal-generation bookkeeping for every terminal writer;
- typed lifecycle-event outbox;
- typed lifecycle subscription filters;
- reminder editing and goal-linked context;
- broad subscription or dashboard UI;
- every authorization restriction in the final architecture.

Those remain in the robust roadmap below. The minimal core is a dogfood bridge: it makes LH goal ownership usable while preserving the later migration path.

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
- Consume terminal V2 `failed`/`rejected` status before marking the source delivery terminal. A terminal V2 failure must create a new delivery-attempt generation or an explicit retryable/degraded source state; it must not leave the upstream event treated as handed off when the agent never received it.

**Estimate:** 140–220 lines.

#### V6. Migrate inactive LH inbox delivery

- Preserve actor activation and inbox persistence.
- Mark inbox rows delivered only at the current `consumed` boundary, preserving existing behavior; durable V2 acceptance alone is insufficient because a later terminal V2 failure must not silently lose the message.
- Persist the V2 job/message correlation and convert terminal failed/rejected delivery into another inbox attempt or a visible degraded state before the row leaves pending scans.
- Prevent restart races from creating duplicate transcript rows.

**Estimate:** 100–180 lines.

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

#### S1. Typed lifecycle filter contract

This contract applies only to `source: 'space'` lifecycle subscriptions. Preserve existing source-specific filter schemas for GitHub, CRM, calendar, and other connectors rather than imposing lifecycle-only fields on every source.

Start with a narrow, versionable lifecycle contract:

```ts
interface SpaceLifecycleSubscriptionFilter {
  labelsAny?: string[];
  statusesAny?: SpaceLifecycleStatus[];
}
```

- Define normalization and any-match behavior for each supported lifecycle field; multiple fields combine with AND.
- Reject unsupported fields only for lifecycle subscriptions; validate non-lifecycle filters against their own source-specific contracts.
- Migrate **all** built-in Space lifecycle template filters before enabling strict rejection:
  - `labels` filters to `labelsAny` for marketing, product-quality-manager, and research;
  - coordinator `statuses` filters to typed `statusesAny` or equivalent exact status topics.
- Backfill or repair already persisted legacy lifecycle `labels` and `statuses` subscription rows in the same release so existing agents do not silently lose matching.
- Handle the singular `{ label: ... }` metadata written by the existing `subscribe_agent_event` MCP contract. It is not payload filtering: either move it to a separate typed display-label field with a migration or intentionally map it to payload semantics before rejecting it. Update the MCP contract so it cannot continue creating unsupported lifecycle filters.

**Estimate:** 150–220 lines.

#### S2. Runtime filter enforcement

- Carry filters into LH subscription targets.
- Evaluate them before registering expected delivery.
- Preserve behavior through rehydration and retries.

**Estimate:** 70–140 lines.

#### S3. LH subscription authorization and UI

- Enforce authorization inside MCP tool handlers, not merely the UI/RPC: only the target LH agent, coordinator, or explicit human authority may create/edit/status/delete that agent's subscriptions. Ordinary member sessions must not add broad wakeups to or remove wakeups from another LH agent.
- Per-agent list/create/edit/status/delete controls.
- Separate topic glob editing from structured payload filters.
- Reuse existing RPC and web-store CRUD.

**Estimate:** 170–250 lines.

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
- Add a durable task-scoped pending-outcome record for supervised/pre-terminal submissions. A worker can submit structured observations, recommendations, proposed updates, and evidence references while a task is in `review`; that payload must survive until approval and post-approval work complete. Bind the pending outcome to an execution/review generation, and clear or supersede it whenever that attempt is rejected, reopened, or retried so stale work cannot be consumed later. The terminal transition atomically consumes the current pending outcome into the immutable report and terminal generation.
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
- Tie route generation to an ownership and availability version. `replacePrimaryGoalOwner` must invalidate or supersede routes for unresolved reports and enqueue a fresh deterministic route to the new owner; owner pause/disable/archive and hard-delete transitions must do the same, routing visibly to the coordinator fallback. Those availability/configuration mutations themselves require target-agent, coordinator, or human authority inside the MCP handlers so an ordinary member cannot disable, reconfigure, or delete an owner to divert pending reports. A routed former or unavailable owner must not leave the report stranded even though it cannot decide it.
- Atomically persist durable routing work with report creation or require the dispatcher to scan every unrouted/superseded report. Delivery identity must be deterministic from report ID plus route generation so restart recovery is idempotent.
- Persist routing outcome without blocking task completion; a committed report must not be lost because the daemon exits before the asynchronous route call starts.
- Consume terminal V2 `failed`/`rejected` status for report notifications. Such a failure creates a new route-attempt generation or visible retryable/degraded routing state; the existing deterministic identity must not collide with the failed V2 job, and recovery must cover routed-but-terminal-failed reports as well as unrouted/superseded reports.

**Dependencies:** G1–G6 and V1–V3.

**Estimate:** 170–250 lines.

#### G8. Owner decision MCP/RPC and atomic apply

- Expose report list/read/decide through `space-agent-tools` as well as RPC/UI. The routed primary owner is an LH-agent session and cannot autonomously integrate a notification if only repository/UI operations exist.
- List/read reports for the primary owner.
- Define coordinator and human read/list/decision authorization in this same PR so a report routed through fallback cannot remain undiscoverable.
- Accept as proposed, apply edited, acknowledge without mutation, or reject.
- Atomically transition disposition and update the goal.
- Validate current ownership inside the same transaction that claims the report and updates the goal: a checked-but-since-reassigned owner must lose the claim. Coordinator and human override remain explicit exceptions.
- Capture a base goal revision with each report and validate it inside the decision transaction. Terminal goal bookkeeping (active/last task pointer updates) and report creation must share one transaction, with the base revision sampled after that bookkeeping, or the revision semantics must explicitly exclude those automatic changes. If an independent goal change has occurred since the report, reject the stale proposal and require explicit merge or edited apply; a full replacement apply must never overwrite newer goal state.
- Reference the report in the goal event.
- Apply recurring-goal progress rules.

**Estimate:** 190–270 lines; split MCP parity from repository/transaction work if it exceeds 250.

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
- Enforce authorization inside every MCP handler, not only RPC/UI, for create as well as edit/pause/resume/cancel: the reminder's owning LH agent, explicit coordinator authority, or human authority may schedule or mutate a wake-up for that agent; ordinary ad-hoc member sessions must not inject or mutate another agent's wakeups.

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
V3 + G1 + G2 + G3 + G4 + G5 + G6 -> G7 -> G8 -> G9

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

The roadmap contains **6 minimal-core PRs plus 28 robust-roadmap PRs**:

- Minimal core: 6
- V2 last mile: 6
- Lifecycle publication: 6
- Subscription filtering/UI: 3
- Goal authority/outcomes: 9
- Reminders: 4

Most should remain below 200 changed production lines. Use 250 as a soft ceiling. A PR above 250 must either be split or explain why one cohesive behavioral contract requires the larger diff.

Tests are not included in these estimates. Schema migrations, failure-path tests, concurrency tests, restart/retry tests, and authorization tests are required where relevant.

## Success criteria

An LH agent can:

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
