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
3. One immutable outcome report is created per reportable terminal generation.
4. Task completion does not depend on successful report notification.
5. Notification retries cannot duplicate reports or recipient inbox messages.
6. Workers may propose rolling-state changes but cannot apply them after migration.
7. Only the current owner, an explicit fallback coordinator, or human authority may decide and apply a report.
8. Decision and goal mutation are atomic and idempotent.
9. Applied updates continue through `SpaceGoalService` so goal events and recurring-goal rules remain authoritative.
10. Forge evidence is a retryable projection, not the outcome source of truth.
11. Restrictions ship only after owner routing and decision/apply paths work.

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
- Remove bespoke probes/timeouts only after V2 provides equivalent guarantees.

**Estimate:** 90–170 lines, likely deletion-heavy.

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
- Publish only after committed mutations.

**Estimate:** 130–220 lines.

#### L4. Task-manager producer wiring

- Emit task creation and meaningful status transitions after successful updates.

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
}
```

- Define normalization and any-match behavior.
- Reject unsupported fields.
- Migrate the marketing template from ambiguous `labels`.

**Estimate:** 100–170 lines.

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

- Add a partial unique constraint for one `owner` per goal.
- Preserve multiple managers/watchers.
- Make unassignment relationship-specific.

**Estimate:** 110–180 lines.

#### G2. Owner resolver and atomic reassignment

- Add `getPrimaryGoalOwner` and `replacePrimaryGoalOwner`.
- Return explicit no-owner/unavailable/fallback reasons.

**Estimate:** 100–170 lines.

#### G3. Ownership RPC and MCP parity

- Relationship-aware list/assign/unassign operations.
- Same-Space validation and deterministic conflicts.

**Estimate:** 100–170 lines.

#### G4. Ownership UI

- Goal owner picker/readout.
- Agent managed-goals/scopes section.
- Visible unowned/degraded fallback state.

**Estimate:** 140–230 lines.

#### G5. Immutable outcome-report schema and repository

Add a narrow `space_goal_outcome_reports` model with:

- Space, goal, task, and terminal-generation identity;
- reporter session/node identity;
- immutable outcome summary, observations, recommendations, proposed goal update, and evidence references;
- creation and routing metadata.

Use terminal generation rather than only task ID because tasks can reopen. Do not provide payload update/delete methods.

**Estimate:** 150–230 lines.

#### G6. Worker outcome-report tool

- Validate the caller is associated with the linked task/goal.
- Insert idempotently without mutating goal state.
- Optionally project to Forge evidence when a linked scope exists.

**Estimate:** 140–220 lines.

#### G7. Owner routing through V2

- Resolve the current primary owner.
- Activate/rehydrate the owner session.
- Deliver through the LH V2 adapter.
- Use explicit coordinator fallback when the owner is absent or unavailable.
- Persist routing outcome without blocking task completion.

**Dependencies:** G1–G6 and V1–V3.

**Estimate:** 150–240 lines.

#### G8. Owner decision and atomic apply

- List/read reports for the owner.
- Accept as proposed, apply edited, acknowledge without mutation, or reject.
- Atomically transition disposition and update the goal.
- Reference the report in the goal event.
- Apply recurring-goal progress rules.

**Estimate:** 170–250 lines.

#### G9. Authorization and compatibility migration

- Restrict worker direct rolling-state mutations.
- Deprecate direct `mark_complete.goal_update` application in favor of reporting.
- Apply equivalent owner authority to Forge rollups.
- Preserve coordinator/human override policy.

**Estimate:** 130–220 lines.

### Stage R — Direct LH reminders and self-nagging

Forge goal-automation self-nag remains a separate evidence-processing mechanism. This stage concerns direct future-self LH-agent reminders.

#### R1. Reminder lifecycle APIs

- Update title/body/schedule.
- Pause, resume, and semantic cancel.
- Recompute cron `nextRunAt` and explicitly handle past one-shot resumes.
- Add MCP parity, including cron reminders and paused/fired status filters.

**Estimate:** 150–230 lines.

#### R2. Optional single-goal link and bounded context

Each reminder links to zero or one goal. Portfolio reminders remain unlinked and tell the agent to inspect assigned goals.

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
- Cancel/delete behavior and reminder-count refresh.

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
       `-> L5
L3 + L4 + L5 -> L6

L1 -> S1 -> S2 -> S3

G1 -> G2 -> G3 -> G4
G1 -> G5 -> G6
V3 + G2 + G6 -> G7 -> G8 -> G9

R1 -> R2 -> R3 -> R4
V3 -> V4 before reminder V2 migration is considered complete
```

Parallel starting points: V1, L1, G1, G5, and R1.

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
