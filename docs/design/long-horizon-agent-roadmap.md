# Long-Horizon Agent Roadmap

**Status:** Proposed

## Purpose

Build the platform capabilities required for any long-horizon (LH) Space agent to act as a durable manager: maintain multiple goals, delegate bounded work, react to external and internal events, schedule future-self wakeups, integrate worker outcomes, update structured state, and preserve knowledge across context windows.

Marketing is the first forcing scenario, but the architecture is intentionally general and applies to coordinator, product-quality, release, research, security, sales, and custom LH agents.

## Minimal core

The full roadmap below is the robust target. It should not block first dogfooding. We already have goal persistence, goal tasks, LH sessions, assignments, reminders, task tools, agent memory, and Forge. The smallest useful core is therefore **six PRs**, sequenced after the Message Delivery V2 follow-up in task #860.

### MC1. Goal owner assignment and resolver

- Use the existing LH-agent/goal assignment relationship.
- Enforce or safely resolve one primary owner per goal.
- Add `getPrimaryGoalOwner(goalId)` and coordinator fallback.
- Gate the ownership mutation handlers now, not in G3: `assign_agent_to_goal`/`unassign_agent_from_goal` currently perform only same-Space checks and default assignments to `owner`, so an ordinary member could replace a legitimate owner with a controlled LH agent and inherit MC3 apply authority. Require coordinator or explicit human authorization in these MCP handlers from MC1 onward.
- Gate goal-mutating MCP tools the same way: `update_goal`, `pause_goal`, `resume_goal`, and `trigger_goal_task` also perform only same-Space checks while every Space member session receives `space-agent-tools`. Restrict them to the current primary owner, coordinator, or explicit human authority within MC1–MC3 so a member cannot bypass MC3's authorized, revision-checked review path by rewriting or pausing an owned goal directly. Include `apply_forge_rollup` in this gate now rather than deferring to G9: its handler checks only that the episode belongs to the Space, and `EvolutionEpisodeService.applyRollupGoalUpdate` then rewrites the linked recurring goal's summary, metrics, and next steps — a direct owner-gate bypass available to any member session. Extend the same gate to lifecycle mutations of **goal-linked tasks** (`retry_task`, `cancel_task`, `archive_task`, and `approve_task`): those transitions now create or supersede MC2 notifications and G6 reports, so a member could otherwise reopen a completed goal task to invalidate a pending owner decision or cancel active work to manufacture a terminal outcome — and `approve_task` in particular transitions any review task to `done` after only same-Space and autonomy checks, letting an unrelated member terminalize goal-linked work and cascade dependents in a sufficiently autonomous Space. Retain narrowly scoped authority for a worker completing its own task.
- Gate owner lifecycle mutations alongside them: `update_agent`, `pause_agent`, and `archive_agent` likewise only validate that the target belongs to the Space. MC1 reroutes notifications on those transitions, so without authorization an ordinary member could archive or pause the primary owner and divert pending reviews to the coordinator or disrupt future goal processing. Require target-agent, coordinator, or explicit human authority for these handlers in MC1 rather than deferring to G7. Target-agent self-service is limited to explicitly safe lifecycle fields: because LH sessions receive `space-agent-tools`, letting an agent pass the whole `update_agent` handler would let a compromised or poorly instructed agent rewrite its own `custom_prompt`, tool allowlist, provider/model, or `setting_sources`; configuration and permission changes require coordinator/human authority inside the handler.
- Reconcile duplicate owners deterministically before enforcing the invariant.
- Reassignment must supersede every unprocessed MC2 notification for the goal and deterministically reroute it to the new owner, so a pending wake can never remain stranded with the former owner while MC3 correctly rejects that former owner. Owner pause/disable/archive and hard-delete transitions must supersede and reroute the same way — to a usable replacement owner or visibly to the coordinator fallback — because the ownership row can remain unchanged while the recipient session becomes unusable.
- Atomically assign goal ownership at creation. The current `create_goal` handler creates no assignment row, so once MC1's gates are live an LH agent following MC5 would produce an unowned goal it immediately lacks authority to manage (and automatic `ownershipPatterns` are deferred). `create_goal` must atomically assign the authorized creator as primary owner, accept an explicitly governed owner parameter, or provide a safe self-claim path before those gates take effect.
- Make unassignment relationship-specific now rather than waiting for G1: the current repository delete matches only `(agent_id, goal_id)`, so removing an owner would also erase that agent's `manager`/`watcher` rows on the same goal. The MC1 handler must delete only the owner relationship.
- Keep managers/watchers non-authoritative for now.

**Why it matters:** routing and goal authority need a stable destination.  
**Estimated size:** 130–220 production lines.

### MC2. Minimal owner wake-up on goal-task terminal state

- At the existing goal terminal seam, apply the shared reportable-terminal predicate, then resolve the primary owner. The predicate is active-work-aware: the current `isTerminalTaskStatus` treats every `cancelled`/`archived` transition as terminal regardless of prior state, but archiving a queued/draft task or cancelling work before execution has no worker outcome to integrate and must not notify the owner. Only transitions that terminate previously active goal work generate notifications. It must also cover outcome-changing terminal-to-terminal transitions: an allowed recovery such as `in_progress → blocked → done` or `cancelled → done` starts from a non-active status yet produces a new final outcome — treat these as new terminal generations with their own notification, superseding the previous terminal record so it can neither remain routable nor be applied after the task's true completion. (G6 reuses this same predicate for report capture.)
- Introduce the monotonic per-goal revision counter here, before any notification records a base revision: add the counter to the goal model, increment it in every goal mutation, and migrate existing goals. Notifications recorded before the counter exists must have a defined policy — treated as always-stale so they terminalize through the edited-merge/disposition path rather than passing a comparison against a missing or timestamp-derived value.
- Introduce the durable task terminal generation here, not in G5: MC2 requires one notification per deterministic transition and treats repeated terminal outcomes as new generations, but today's terminal handlers are best-effort callbacks after the task write — a per-callback UUID duplicates notifications on callback retry, and a `(task, status)` key collapses legitimate reopen→recomplete cycles. Persist a monotonic terminal generation atomically with each terminal transition and carry it through every MC2 notification writer, or the minimal core cannot provide exactly-once owner outcomes.
- Persist a minimal outcome-notification record atomically with the terminal transition, or give the transition a deterministic identity and enforce one notification per identity with reconciliation for committed tasks missing notifications. The reconciler must exclude pre-MC2 history: on an existing database it would otherwise match every goal task terminalized before MC2 was installed — transitions with neither a notification nor the required post-bookkeeping revision — flooding owners with historical wakes or creating permanently stale records. Define a migration watermark or seed pre-MC2 terminal identities as already reconciled; any intentional historical backfill is a separate explicit operation.
- The notification stores the goal revision sampled after required terminal goal bookkeeping so later review can detect independent goal changes. Even when notification creation is deferred to reconciliation, the terminal transaction must durably capture that post-bookkeeping revision (for example on the terminal bookkeeping record); the reconciler copies the captured revision into the notification instead of sampling the then-current revision, which intervening goal edits may have advanced.
- Wake the owner through the LH durable-injection adapter from task #860 / V3.
- Include the completed task result, linked goal, and current rolling goal state — bounded. Task results and rolling goal fields are not size-limited in the current model, so an unbounded wake prompt can exceed the provider context limit and fail delivery repeatedly without the owner ever receiving the outcome. Persist the full data for audit, but inject a bounded summary plus stable IDs and provide tools for fetching additional details.
- Fall back visibly to the coordinator when no usable owner exists.
- Do not block task completion on notification delivery, but do not rely on best-effort post-commit notification that can be lost or duplicated.
- Consume terminal V2 `failed`/`rejected` delivery status for the wake: a failure **before SDK admission** creates a deterministic new delivery-attempt generation; a post-consumption terminal turn failure must not blindly re-inject the outcome under a new attempt (repeating autonomous side effects from the failed turn) and instead enters a visible degraded/escalated state or explicitly idempotent domain recovery, per the orthogonal-state contract. An accepted-but-terminally-failed delivery must not leave the notification unprocessed with the owner never awakened; the G7 recovery machinery does not exist yet during the MC-only phase.
- Reconcile completed-but-undisposed wakes. V2 `completed` only proves the turn ended, not that the owner called `review_goal_outcome` (tool error, context interruption, or ignored instruction). Unprocessed notifications whose latest delivery completed must receive bounded re-notification with backoff and eventual visible coordinator/human escalation. Each re-notification uses a fresh delivery identity — a durable re-notification-attempt generation on top of the notification identity — because an unchanged route/ownership would otherwise make V2 resolve the already-completed job instead of admitting another prompt. Escalation must transfer or explicitly share decision authority, which MC3 validates atomically; otherwise an escalated coordinator/human cannot dispose the notification while the original owner remains technically usable, and bounded re-notification still ends stranded.
- Supersede unprocessed notifications when their terminal transition is exited. Reopening a `done`/`blocked`/`cancelled` task currently clears the task result without advancing the goal revision or invalidating the notification; without supersession the reconciler keeps waking the owner and MC3's base-revision check can still pass, applying an obsolete terminal outcome over active rework.

This intentionally reuses task results and current delivery/inbox primitives instead of building the full immutable report model first.

**Sequencing:** gate wake injection and undisposed-notification reconciliation until MC3 and the receiving agents' MC5 prompt migration are enabled — or ship those contracts atomically with MC2. Injecting wakes the owner cannot yet dispose would churn the completed-but-undisposed reconciler into repeated re-notification and escalation for inherently unprocessable notifications.

**Why it matters:** the goal now reacts to work completing instead of waiting for a human or a weekly reminder.
**Estimated size:** 190–270 production lines; split deterministic terminal identity/notification persistence from owner delivery if it exceeds 250.

### MC3. Idempotent owner goal-review MCP tool

Add one explicit tool such as `review_goal_outcome` that the awakened owner can call. It receives:

- goal ID;
- completed task ID;
- the persisted MC2 notification identity;
- optional structured observations and metric changes;
- summary, next steps, and follow-up intent.

The tool validates — inside the same transaction that claims the notification — that the caller is the current primary owner or an explicitly authorized coordinator/human (fallback or escalation recipient), and that the notification is still unsuperseded. It must also bind the three identities: when one agent owns multiple goals, a stale or malformed call can pair goal A's notification with goal B's goal/task IDs, applying one outcome to the wrong goal while permanently marking the real notification processed. Derive the goal and task from the claimed notification — or atomically compare all three identities — before authorization and apply. A pre-transaction ownership check alone races with concurrent reassignment: the former owner could pass validation, watch MC1 supersede the notification, and still claim it and mutate the goal. It then atomically records the notification as processed and applies the update through `SpaceGoalService`. It must compare the notification's base goal revision inside the same transaction; if the goal changed independently after the notification, reject the stale proposal and require an explicit edited merge rather than overwriting newer summary, metrics, or next steps. Stale rejection must have a terminal path: the tool also exposes an explicit edited-merge operation that CASes the **current** revision, plus acknowledge/reject/supersede dispositions that terminalize the notification without mutating the goal. Without one, every retry compares against the same frozen notification revision, is rejected forever, and MC2 keeps re-notifying or escalating an outcome that can never be applied. The goal revision must be a monotonically incremented counter updated by every goal mutation — not `updatedAt`, which every mutation assigns via `Date.now()` and which can therefore collide for two mutations in the same millisecond, letting a stale proposal pass the comparison. Requested follow-up work must be persisted as a deterministic command or outbox entry in the same transaction and reconciled independently; committing only the processed-marker and goal update first would permanently lose the follow-up on a mid-review crash (retry returns the stored result), while creating it before the commit permits duplicates. Retrying a durable wake or retrying after a tool timeout must return the original processed result rather than appending duplicate goal events, reapplying metrics, or creating duplicate follow-up work. Workers do not get this tool.

**Why it matters:** the LH agent becomes responsible for integrating outcomes and deciding next actions without immediately reworking every existing worker prompt or terminal path.
**Estimated size:** 170–250 production lines.

### MC4. Minimal goal detail and ownership UI

- Show the primary owner on goal detail.
- Let a coordinator/human assign or reassign the owner.
- Show the latest owner-review outcome and next check-in.

Use existing goal history, task links, and goal editing surfaces. Do not build a broad dashboard yet.

**Why it matters:** operators can see and correct goal ownership before relying on autonomous behavior.  
**Estimated size:** 120–200 production lines.

### MC5. Prompt and template migration for the core loop

- Teach LH templates to create/own goals, inspect linked task outcomes, call the review tool, and create follow-up work.
- Migrate already-persisted agents, not just template definitions. `create_agent_from_template` copies `template.instructions` into the agent row and runtime prompt construction reads that stored value, so existing template-created agents (including the coordinator and the first dogfood agents) never see updated stock instructions. Ship a versioned, backward-compatible migration for agents still on prior stock instructions — or dynamically inject the core owner-review contract — while preserving user-customized prompts.
- Teach goal workers to report bounded results without claiming ownership of overall strategy.
- Update the marketing template only as the first dogfood profile; keep the mechanism generic.

**Why it matters:** existing primitives only become a management loop when the prompts use the same contract.  
**Estimated size:** 80–160 production lines.

### MC6. Inactivity self-nag

Add a configurable inactivity watchdog for each LH agent. Keep the first version deliberately simple: use the latest message timestamp in the agent's persistent session as its last activity time.

- Read the latest **successful/consumed** message timestamp for the LH agent's persistent session. For a session with no messages, use the session creation time, falling back to agent creation time, so new agents have a deterministic first inactivity window.
- If `now - lastActivityAt` exceeds the configured threshold, inject a wake-up message into that session.
- Atomically claim a deterministic inactivity window before injecting. While a nag delivery attempt for that window is accepted/in flight, subsequent and concurrent scans must not enqueue another nag — `lastActivityAt` stays stale until consumption, so an unclaimed scan would duplicate autonomous turns on every pass. Advance the attempt generation only after a terminal delivery failure. Bind the claim to the observed activity watermark and re-check immediately before V2 admission: fresh activity (a human message, external event, or ongoing turn) recorded between claim and admission supersedes the claimed nag, so an obsolete wake is never injected into an already-active session. The admission recheck must also consult a separate latest-accepted/enqueued intent watermark: a durably accepted but not yet SDK-consumed prompt leaves `lastActivityAt` unchanged, and without that watermark the nag would be admitted behind an already-pending prompt. It must also treat an active turn as activity: a consumed prompt whose turn remains in `processing`, `queued`, or rate-limit cooldown beyond the threshold does not advance message timestamps, so recheck the session's active processing state before admission (or maintain a turn-activity lease/heartbeat) — otherwise the watchdog nags a session that is still working. The consumed timestamp remains the value that resets the next inactivity window.
- A successfully consumed injected message becomes the latest session activity, so the inactivity window naturally resets. A persisted but failed/rejected nag must not reset the window; track the delivery attempt and — for failures **before SDK admission** — rearm a new attempt, or enter a visible degraded state on terminal delivery failure. A post-consumption turn failure follows the same orthogonal-state contract: degraded state or idempotent domain recovery, never blind re-injection of a nag whose turn may already have acted.
- This covers external events, reminders, task/goal wake-ups, direct human messages, agent-to-agent messages, and ongoing session work without a separate activity taxonomy.
- Make the threshold and prompt configurable per agent.
- Support enable/pause/resume and run-now controls.
- Do not fire while the agent or Space is paused, stopped, disabled, or archived. A scanner-time status test alone does not guarantee this across the claim-to-admission race: bind each claimed nag attempt to the current agent/Space availability generation and re-check it immediately before V2 admission, rejecting stale claims, or explicitly define and expose the point after which pausing can no longer prevent the wake. Bind the claim to the watchdog's own configuration generation too: an operator pausing the watchdog or editing its threshold/prompt after the claim but before admission must invalidate the claimed nag, so revalidate the watchdog's enabled state and generation at admission — otherwise a nag fires after the watchdog was paused, or injects obsolete prompt text.

Default policy can be enabled every 8 hours with a prompt such as:

> No session activity has been recorded for the configured period. Review assigned goals, active or stuck tasks, pending follow-ups, and current status. Create follow-up work or request help if needed.

**Why it matters:** an LH agent should not silently remain idle when no external event or task outcome arrives.
**Estimated size:** 140–220 production lines.

### Minimal-core boundaries

This core deliberately does **not** yet provide:

- full immutable outcome-report schema;
- report-scoped terminal-generation integration for every terminal writer (the durable task terminal generation itself lands in MC2);
- typed lifecycle-event outbox;
- typed lifecycle subscription filters;
- reminder editing and goal-linked context;
- broad subscription or dashboard UI;
- the remaining authorization hardening from the final architecture (report-decision override matrix, worker-mutation deprecation) and the atomic/idempotent Forge rollup transaction — Forge rollup **authority** is not deferred; `apply_forge_rollup` joins the MC1 owner/coordinator/human gate, and only its atomicity work remains in G9.

Those remain in the robust roadmap below. The minimal core is a dogfood bridge: it makes LH goal ownership usable while preserving the later migration path.

### Minimal-core cutover

Do not cut over at G6: report capture alone provides no owner integration path until G7 routing and G8 decision tools exist. The cutover must also not precede G9: while direct `mark_complete.goal_update` and other worker goal mutations remain live, a worker can mutate the goal directly after terminalizing and the owner can later apply a conflicting report proposal. Keep the migration flag disabled and the minimal notification/review path fully active until G8 decision tools ship, and enable the cutover only atomically with the G9 worker-schema/prompt/mutation restrictions (or fold those restrictions into the same atomic release):

- Stop creating new MC2 notifications at the same terminal seam when the cutover flag is enabled.
- Backfill or link pending MC2 notifications to their corresponding outcome reports so no pending wake is silently dropped. Notifications created before G6 retain only the task result and one post-bookkeeping revision — not the composition-time revision or a structured immutable proposal — so a backfilled report cannot truthfully support "accept as proposed": inventing a base revision would permit an unsafe accept, while rejecting the incomplete report outright would strand it once MC3 is disabled. Legacy backfilled reports carry no acceptable proposal and must be decided through the edited path with a current-revision CAS, or keep their MC3 disposition available through the migration.
- Correlate reports with **all** MC2 notification records, not only pending ones. During the G6–G8 coexistence a task termination creates both a report and a notification; when the owner already processed the MC2 notification, the duplicate report must be dispositioned or superseded at cutover so G7 does not keep routing and escalating an outcome that was already integrated (its stale base revision prevents application but does not terminalize it). The same correlation must cover the compatibility path: `end-node-handlers.ts` applies `mark_complete.goal_update` directly immediately after the terminal transition, which advances the goal revision and leaves the just-captured report stale even when its MC2 notification was never processed. For these reports, mark the proposed-update portion as already applied (correlating via the task-sourced goal event) while keeping the report pending for owner disposition — a direct `goal_update` applies only the rolling-goal mutation, so superseding the whole report would silently discard its unreviewed observations, recommendations, evidence, and follow-up intent. Full supersession is reserved for reports whose correlated MC2 record proves the outcome was actually reviewed — and even then only for the content the MC2 review actually covered. A processed MC2 notification proves the owner reviewed MC2's bounded task-result/current-goal payload; if the G6 report also captured structured observations, recommendations, evidence, or follow-up intent not duplicated in the task result, fully superseding the report would silently discard unreviewed information. Record the MC2-applied mutation and follow-up separately and retain a non-mutating disposition path for the report-only content, or include and identify that content in the MC2 review before treating the whole report as reviewed.
- Disable `review_goal_outcome` for goals covered by authoritative reports and redirect owners to the G8 decision tools.
- Update MC5 prompts in the same cutover so agents do not receive both the old and new instructions.
- Make the cutover idempotent and reversible behind the explicit migration flag until report capture/routing has been verified in production. Reversibility requires a defined reverse path before the flag is called reversible: outcomes committed while the flag was on exist only as reports, so rollback must include an idempotent reverse reconciliation (creating or restoring MC2 notifications for flag-on outcomes, or explicitly keeping G7 routing — but never both waking paths for the same outcome) and explicit routing ownership for pre-cutover, flag-on, and post-rollback records. The reverse reconciliation must preserve dispositions: a report already accepted, rejected, or acknowledged through G8 translates into a terminal/processed MC2 record carrying its stored result; pending notifications are created only for reports still unresolved at rollback — otherwise rollback wakes owners for already-disposed work, re-entering MC3's stale-review loop or duplicating an edited application and its follow-up work.

This prevents duplicate owner wake-ups, duplicate goal updates, and conflicting follow-up work during the transition.

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

The `job_queue` row must not be the only copy of terminal delivery status: `cleanup.handler.ts` deletes completed and dead rows after the retention window, so a status lookup after a long daemon shutdown can no longer distinguish completed from failed from never-accepted, stranding durable domain work. Every consumer (MC2, V4–V6, G7) must persist the terminal receipt in its own domain attempt record — or delivery status must be retained for the lifetime of its upstream record — and missing/expired lookups must have defined semantics rather than being treated as never-accepted.

Consumption and terminal turn outcome are orthogonal state. A prompt that crossed the SDK admission boundary but whose owning turn later exhausted retries is still consumed; redelivering it under a new UUID replays the same domain payload and can repeat autonomous tool side effects. New delivery-attempt generations are only for failures **before** SDK admission. A post-consumption terminal failure must surface as a distinct consumed-but-turn-failed state, and any post-consumption replay requires domain-level idempotency rather than a fresh blind injection.

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

- Preserve the deterministic reminder-occurrence UUID as the logical dedupe key, but include the reminder configuration generation (and retry attempt where applicable) in the V2 message identity: an edit that keeps `nextRunAt` unchanged would otherwise reuse `reminder:${id}:${nextRunAt}`, and V2's UUID lookup selects the earliest SDK row — continuing to resolve the rejected row's old content instead of the edited prompt.
- Advance one-shot/cron state only at the selected receipt boundary.
- Preserve the admission-time lifecycle guard through the migration. The V2 path (`message-delivery.handler.ts`, `AgentSession.messageDeliveryValid`) fences archived sessions but does not check Space or LH-agent availability, while `SpaceRuntimeService.deliverLongHorizonAgentReminder` rechecks those states immediately before direct injection today. V4 delivery must revalidate Space/agent availability at SDK admission and treat such rejection as an unconsumed, retryable occurrence — otherwise the migration can execute autonomous reminder work in a paused Space.
- Define terminal-delivery failure recovery before advancement:
  - do not mark a one-shot occurrence fired merely on durable acceptance;
  - a terminal V2 failure **before SDK admission** creates a new attempt generation or explicit degraded/manual-retry state rather than silently skipping the occurrence; a post-consumption terminal turn failure follows the orthogonal-state contract in the delivery architecture and must not blindly re-inject the same occurrence under a new UUID;
  - deterministic occurrence identity plus attempt generation prevents repeated scans from colliding with the failed delivery.
- Remove bespoke probes/timeouts only after V2 provides equivalent guarantees.

**Estimate:** 100–180 lines, likely deletion-heavy.

#### V5. Migrate LH external-event delivery

- Correlate external-event delivery key with V2 message/job identity.
- Deduplicate overlapping subscriptions per recipient: `SpaceRuntime.buildLongHorizonDeliveryKey` includes `subscriptionId`, so one event matching both `space/task.*` and `space/task.done` for the same agent would inject twice and duplicate autonomous side effects. Collapse all matching subscriptions into one delivery per `(event identity, agent)`, retaining the matched subscription IDs for audit and filter bookkeeping.
- Bind each delivery to the full matched subscription/version set — not a single subscription generation — and revalidate immediately before V2 admission: after coalescing, rejecting the whole delivery because one matched subscription changed would lose a wake another current subscription still justifies, while checking only one retained subscription could admit the event after every matching route disappeared. Admit when at least one current subscription still matches the event (updating the audit set), and revalidate target-agent and Space availability at the same point; a subscription edited, paused, or deleted after V2 acceptance is not revoked by source-side bookkeeping (`clearLongHorizonRetries` cannot revoke a transferred V2 job). Alternatively, explicitly define an earlier cutoff after which subscription changes can no longer prevent delivery.
- Keep subscription, TTL, activation, and source-delivery state upstream.
- Bound the injected prompt: `formatExternalEventEssence` copies `payload.body` into the prompt without a size limit, so a large event body can exceed the provider context limit and fail delivery repeatedly without the agent ever seeing the event. Persist the complete event for `get_external_event`, but inject only a bounded summary plus the stable event ID.
- Remove duplicate last-mile retry ownership only after V2 acceptance.
- Consume terminal V2 `failed`/`rejected` status before marking the source delivery terminal. A terminal V2 failure **before SDK admission** must create a new delivery-attempt generation or an explicit retryable/degraded source state — and that attempt generation must be part of the V2 message identity: reusing the stable `(event identity, agent)` UUID would make V2 resolve the existing failed SDK row instead of admitting the new attempt, permanently suppressing the event after a transient failure (the same rule V4 applies to edited reminders). A post-consumption turn failure follows the orthogonal-state contract (delivered/degraded state or explicitly idempotent domain recovery), never a blind re-injection under a new UUID that repeats autonomous tool side effects. It must not leave the upstream event treated as handed off when the agent never received it.

**Estimate:** 140–220 lines.

#### V6. Migrate inactive LH inbox delivery

- Preserve actor activation and inbox persistence.
- Mark inbox rows delivered only at the current `consumed` boundary, preserving existing behavior; durable V2 acceptance alone is insufficient because a later terminal V2 failure must not silently lose the message.
- Persist the V2 job/message correlation and convert terminal failed/rejected delivery **before SDK consumption** into another inbox attempt before the row leaves pending scans. A post-consumption turn failure must not create another attempt — the row is already delivered and re-injection would replay a model-visible prompt, repeating autonomous tool side effects; it follows the orthogonal-state contract (visible degraded state or domain-idempotent recovery) instead.
- Revalidate the target at SDK admission: the V2 path fences archived sessions but not LH-agent/Space availability, so bind each inbox delivery to the target's availability generation and recheck immediately before admission. A pre-consumption lifecycle rejection leaves the inbox row pending; without this guard the migration can run an autonomous inbox turn inside a paused Space.
- Prevent restart races from creating duplicate transcript rows.

**Estimate:** 100–180 lines.

Task-agent and Space-chat injection require separate later migration because they also carry defer, image, cooldown, reset-context, topology, and reply-session behavior.

### Stage L — Native Space lifecycle events

#### L1. Lifecycle topic and payload contract

- Canonical `space/task.*` and `space/goal.*` grammar.
- Typed actions and payloads containing stable IDs, statuses, labels, and linkage.
- Migrate legacy topic strings in the same release. Built-in templates in `long-horizon-agent-templates.ts` and persisted subscription rows still use `task.*`, `goal.*`, `task.done`, `goal.done`, and `task.created`; S1 repairs only filter fields, so without a topic migration these subscriptions silently stop matching native lifecycle events. Map each legacy topic to its canonical equivalent — including `goal.done` to the canonical completed-goal action — for both built-in definitions and persisted rows. Migrate the derived `source` alongside the topic: `subscribe_agent_event` rows store the legacy dot topic as their source via `sourceFromTopicPattern` (e.g. source `task.*`), so renaming only the topic produces a mismatched `(source, topic)` pair that rehydration rejects and that falls outside S1's `source: 'space'` filter migration. Those rows' source must become `space`. The migration must also merge collisions before updating route keys: a persisted set can already contain both a legacy MCP-created route `(source='task.*', topic='task.*')` and a canonical route `(source='space', topic='space/task.*')` for the same agent and filter, and canonicalizing the former collides under `UNIQUE(space_id, agent_id, source, topic, filter_json)`, failing the migration and blocking startup. Merge colliding rows deterministically — including their status and filter semantics — then update the surviving row's route keys.

**Estimate:** 100–170 lines.

#### L2. Lifecycle emitter leaf

- Publish through the existing durable external-event service, but override its default delivery TTL for lifecycle events: `EXTERNAL_EVENT_QUEUE_TTL_MS` defaults to five minutes and expires pending deliveries on the source event's creation time, so a daemon or target-agent outage longer than that turns the delivery `ttl_expired` while the outbox record is no longer unpublished — and replaying the same dedupe identity cannot restore the missed wake. Lifecycle delivery must use a non-expiring or source-specific TTL policy, or rearm the lifecycle outbox when external delivery expires, so ordinary downtime never silently drops task/goal transitions. Scope the non-expiring policy to deliveries for subscribers that existed at publication time: `SpaceRuntime.redispatchRetainedExternalEvents` replays unmatched published rows to newly registered subscriptions, so an unmatched event that never expires would hand a subscription created months later the Space's entire stale lifecycle history as a burst of obsolete autonomous turns. Apply a finite unmatched-event retention window or checkpoint new subscriptions at creation instead. If checkpointing is chosen, advance the checkpoint on **every** transition to active — and on route edits — not only at creation: resuming a paused/disabled subscription re-registers its target, and `redispatchRetainedExternalEvents` would otherwise match every non-expiring lifecycle event accumulated during the inactive period, producing the same stale-turn burst. Equivalently, exclude events predating the subscription's activation generation.
- Build stable dedupe keys and event essence. The dedupe key must include the durable lifecycle-outbox record ID or a monotonic mutation generation, not just entity ID plus action/status: an entity can validly re-enter the same status (`blocked → in_progress → blocked`), and `ExternalEventStore` deduplicates permanently on `(spaceId, source, dedupeKey)`, so a status-only key would collapse the later transition into an already-terminal duplicate that never publishes.
- Preserve per-entity event order. Asynchronous post-commit publication plus outbox reconciliation can publish an older transition after a newer one (a failed `blocked` publish, a successful `in_progress`, then the relayed `blocked` last), and a UUID outbox identity carries no ordering information. Attach a monotonic per-entity mutation generation to each outbox record and either relay each entity's events in generation order or suppress stale generations at delivery, so an LH agent never acts on a transition it has already moved past.
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
  - coordinator `statuses` filters to typed `statusesAny` or equivalent exact status topics, with topic-aware value normalization: the legacy `goal.*` filter contains `['active', 'blocked', 'done']`, but canonical goal statuses are `active`, `paused`, `completed`, `archived` — map `done` to `completed` and explicitly resolve the unsupported `blocked` value (a goal cannot be `blocked`) rather than performing a field-name-only conversion that fails strict validation or silently stops matching completed goals.
- Backfill or repair already persisted legacy lifecycle `labels` and `statuses` subscription rows in the same release so existing agents do not silently lose matching. Because the uniqueness constraint includes raw `filter_json`, an agent can already hold the same canonical route once with a legacy filter (`{"labels":["x"]}`) and once normalized (`{"labelsAny":["x"]}`); rewriting the legacy row would then collide and fail the migration, blocking startup. Detect and merge semantically equivalent normalized-filter rows — including their statuses — before updating persisted filters.
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

- Define one shared reportable-terminal predicate before implementation — exactly the predicate MC2 uses for owner notification, with one rule applied uniformly: a goal-linked task transition requires a report **only when it terminates previously active goal work**. The transition table permits non-active paths such as `open → done` and `open → blocked`; those administrative transitions, like archiving a queued/draft task or cancelling before execution, produce neither a report nor an MC2 notification. Like MC2, the predicate also covers outcome-changing terminal-to-terminal transitions: `blocked → done` or `cancelled → done` start from a non-active status but produce a new final outcome, so they create a new terminal generation with its own report and supersede the previous terminal record — after the G9 cutover disables MC2, missing these would leave valid recovery completions with no immutable report or owner wake while the earlier blocked/cancelled report stays actionable. The predicate must be versioned and covered by tests so every writer applies the same rule.
- Add a durable task-scoped pending-outcome record for supervised/pre-terminal submissions. A worker can submit structured observations, recommendations, proposed updates, and evidence references while a task is in `review`; that payload must survive until approval and post-approval work complete. Bind the pending outcome to an execution/review generation, and clear or supersede it whenever that attempt is rejected, reopened, or retried so stale work cannot be consumed later. The terminal transition atomically consumes the current pending outcome into the immutable report and terminal generation. The pending outcome must also capture the goal revision observed when the worker composed its proposal; if the owner edits the goal between submission and terminalization, the report must carry the composition-time revision so G8 validates or explicitly merges against what the worker actually saw — sampling only the post-terminal-bookkeeping revision would let a stale proposal overwrite the intervening edit. The report therefore stores **both** revisions: the composition-time revision (what the worker's proposal was based on) and the post-bookkeeping revision (the goal state after the terminal transition). Because every goal mutation increments the counter — including the terminal bookkeeping that clears `activeTaskId` before the report exists — G8 must reconcile the known bookkeeping delta when validating the composition revision, or comparing the frozen composition base against the current counter would make every such proposal permanently stale.
- Create the report as part of the central reportable terminal transition, not as an optional model-invoked tool. A worker may submit the structured outcome payload before or during completion, but the terminal command/transition must guarantee one report exists even when the worker omits the tool call.
- Audit every reportable terminal writer and route it through the atomic transition. This must include direct repository writers such as `PostApprovalRouter.route`, whose no-route branch currently completes with `taskRepo.updateTask` and intentionally bypasses `setTaskStatus`.
- Keep notification/routing asynchronous and non-blocking.
- Validate the caller/session associated with the linked task/goal when a structured payload is supplied.
- If a linked Forge scope exists, create a durable pending/failed Forge-projection record with the report and let a reconciler retry that projection; keep the outcome report authoritative.
- Supersede unresolved reports when their terminal generation is exited. The transition table permits a `blocked`, `done`, or `cancelled` task to reopen into active work; when that happens, reports still pending from the previous terminal generation must be superseded so G7 stops routing/escalating them and they can never be applied over the reworked outcome. Superseded reports remain immutable audit history. Hard deletion needs the same guarantee: if a reported task can be deleted while its report is unresolved, G8 can no longer validate the task's terminal generation and the report is stranded pending forever. Prohibit hard deletion while unresolved reports exist, atomically supersede those reports during deletion, or always replace deletion with archival for reported tasks.

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
- Consume terminal V2 `failed`/`rejected` status for report notifications. Such a failure **before SDK admission** creates a new route-attempt generation or visible retryable/degraded routing state; a post-consumption terminal turn failure follows the orthogonal-state contract (degraded state or explicitly idempotent domain recovery, never blind re-injection). The existing deterministic identity must not collide with the failed V2 job, and recovery must cover routed-but-terminal-failed reports as well as unrouted/superseded reports. Supersession must also reach the delivery boundary: an already-accepted V2 job is not revoked when the domain route is superseded, so bind each delivery to its notification/report route generation and revalidate its unsuperseded state, current ownership, and availability immediately before V2 admission — and atomically verify the report/notification is still **unresolved**, since an owner decision landing between re-notification acceptance and admission leaves ownership and route generation unchanged while making the wake obsolete. The same recheck applies to MC2 notifications superseded by reassignment or task reopening.
- Reconcile successfully delivered but undisposed reports. V2 `completed` only proves the turn ended, not that the owner called a decision tool. Pending reports whose latest delivery completed without disposition must receive bounded re-notification/backoff and eventual visible coordinator/human escalation. Each re-notification needs a fresh delivery identity: ownership and availability — and therefore the route generation — may be unchanged, so reusing `(report ID, route generation)` would make V2 resolve the already-completed job instead of admitting another prompt. Add a durable re-notification-attempt generation to the delivery identity.
- Coalesce with lifecycle wakes. Once lifecycle producers and G7 are both enabled, a reportable terminal transition emits the generic task-status event and independently routes the outcome report; an owner with a matching subscription (notably the coordinator's `task.*`) would receive two autonomous turns for the same completion, and V5's per-recipient subscription dedup cannot correlate a separate report delivery. Define a shared correlation policy that suppresses or coalesces the generic lifecycle wake for the report recipient while preserving delivery to other subscribers.

**Dependencies:** G1–G6 and V1–V3.

**Sequencing:** G7 report injection and undisposed-report reconciliation stay gated until the G9 cutover flag activates — which requires G8 decision tools and atomically disables the MC2 path. Gating only on G8 availability would begin report injection while MC2 is still active, so every terminal outcome in that window would produce two independently actionable wakes through two decision tools: duplicate autonomous turns, conflicting dispositions, and repeated stale-review escalation.

**Estimate:** 170–250 lines.

#### G8. Owner decision MCP/RPC and atomic apply

- Expose report list/read/decide through `space-agent-tools` as well as RPC/UI. The routed primary owner is an LH-agent session and cannot autonomously integrate a notification if only repository/UI operations exist.
- List/read reports for the primary owner.
- Define coordinator and human read/list/decision authorization in this same PR so a report routed through fallback cannot remain undiscoverable.
- Accept as proposed, apply edited, acknowledge without mutation, or reject.
- Atomically transition disposition and update the goal, and persist any requested follow-up work as deterministic commands or outbox entries in the same decision transaction, reconciled independently. This preserves MC3's reliability guarantee through the cutover: a crash after the decision commit must not lose accepted follow-up work, and retries must not duplicate it.
- Validate current ownership inside the same transaction that claims the report and updates the goal: a checked-but-since-reassigned owner must lose the claim. Coordinator and human override remain explicit exceptions. Claim the report conditionally on its unresolved, unsuperseded disposition and validate that its task's terminal generation is still current in the same transaction: reopening a task does not necessarily advance the goal revision, so without the generation check a superseded report's obsolete proposal can still pass the goal CAS and be applied over active rework.
- Capture both goal revisions — the monotonic per-goal counter defined in MC2 — with each report: the composition-time revision recorded with the G6 pending outcome (what the worker's proposal was based on) and the post-terminal-bookkeeping revision. Validate the proposal against the composition revision inside the decision transaction, reconciling the known terminal-bookkeeping increment, and treat any other divergence as an independent change requiring edited merge. Edited decisions must carry and atomically compare the current goal revision the owner observed when composing the edit — the same CAS protection MC3's edited merge has — so an edit composed against revision N cannot overwrite a concurrent authorized mutation that advanced the goal to N+1 before the decision transaction runs. Terminal goal bookkeeping (active/last task pointer updates) and report creation must share one transaction, with the base revision sampled after that bookkeeping, or the revision semantics must explicitly exclude those automatic changes. If an independent goal change has occurred since the report, reject the stale proposal and require explicit merge or edited apply; a full replacement apply must never overwrite newer goal state.
- Reference the report in the goal event.
- Apply recurring-goal progress rules.

**Estimate:** 190–270 lines; split MCP parity from repository/transaction work if it exceeds 250.

#### G9. Authorization and compatibility migration

- Restrict every goal-mutating MCP/RPC operation—not only worker paths or `mark_complete`—to the current primary owner, coordinator, or explicit human authority. This includes `update_goal`, pause/resume, archive/complete, schedule/cadence changes, and goal-task triggering. Managers, watchers, unrelated LH agents, and ordinary member sessions must not bypass owner disposition by rewriting goal strategy directly.
- Deprecate direct `mark_complete.goal_update` application in favor of outcome-report submission and owner disposition.
- Apply equivalent owner authority to Forge rollups, and make rollup application atomic and idempotent. `EvolutionEpisodeService.applyRollupGoalUpdate` is currently check-then-write: two racing `apply_forge_rollup` calls, or a crash between `SpaceGoalService.updateGoal` and storing `rollupAppliedAt`, can apply the same update twice and append duplicate goal events. Atomically claim the episode, mutate the goal, and mark the rollup applied in one transaction; retries must return the original result.
- Preserve coordinator/human override policy.
- Migrate centralized worker prompts and the `mark_complete` schema descriptions before enabling restrictions. Existing goal-linked workers are instructed to update goals through goal tools or `goal_update`; they must instead be instructed to submit reports and let the owner decide.

**Estimate:** 160–240 lines.

### Stage R — Direct LH reminders and self-nagging

Forge goal-automation self-nag remains a separate evidence-processing mechanism. This stage concerns direct future-self LH-agent reminders.

#### R1. Reminder lifecycle APIs

- Update title/body/schedule.
- Pause, resume, and semantic cancel.
- Recompute cron `nextRunAt` and explicitly handle past one-shot resumes.
- Supersede in-flight occurrences on mutation. The fire worker reads the reminder before delivering; an edit, pause, or cancel landing in between can otherwise still inject the old prompt and only discover the change afterward through its advance CAS. Bind each occurrence to a reminder configuration generation and check generation/status before V2 admission, or explicitly define and expose the point after which cancellation can no longer prevent delivery.
- Add MCP parity, including cron reminders and paused/fired status filters.
- Enforce authorization inside every MCP handler, not only RPC/UI, for create as well as edit/pause/resume/cancel: the reminder's owning LH agent, explicit coordinator authority, or human authority may schedule or mutate a wake-up for that agent; ordinary ad-hoc member sessions must not inject or mutate another agent's wakeups.

**Estimate:** 170–250 lines.

#### R2. Optional single-goal link and bounded context

Each reminder links to zero or one goal. Portfolio reminders remain unlinked and tell the agent to inspect assigned goals. On create/edit, validate `goal.spaceId === reminder.spaceId`; goal IDs are globally addressable, so a plain foreign key is not enough. Revalidate the link at fire time and treat a cross-Space, deleted, or archived link as unavailable rather than injecting context — and revalidate again immediately before V2 admission: the reminder configuration generation from R1 does not detect a goal-only mutation, so a goal archived, deleted, or moved between the fire-time lookup and admission would otherwise inject context for an unavailable goal. Bind the occurrence to the observed goal revision/status for that recheck, or define the fire-time lookup as the explicit point after which archival can no longer prevent delivery.

At fire time, include bounded current state:

- goal identity, status, type, and priority;
- progress only for non-recurring goals;
- truncated summary;
- limited metrics and next steps;
- active/last task IDs.

Do not inject task results, transcripts, event history, Forge evidence, or every assigned goal. Bound the reminder's own title/body projection as well: the fire handler copies both fields verbatim and the create APIs impose no size limit, so an oversized reminder can exceed the provider context limit and never wake the agent. Validate or truncate the injected projection while retaining the full reminder for audit.

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
S2 + S3 + L5 -> L3/L4 producer enablement

G1 -> G2 -> G3 -> G4
G1 -> G5 -> G6
V3 + G1 + G2 + G3 + G4 + G5 + G6 -> G7 -> G8 -> G9

R1 -> R2 -> R3 -> R4
V3 -> V4 before reminder V2 migration is considered complete
R1 -> V4: V4's generation-scoped V2 message identity requires the reminder configuration generation that R1 introduces; shipping V4 from V3 alone would force it to implement part of R1 outside its PR boundary.
```

Parallel starting points: V1, L1, G1, and R1. G5 is **not** an independent starting point; it follows G1 so report routing records can reference the authoritative primary-owner model.

S2 is a hard prerequisite for enabling the L3/L4 lifecycle producers — or publication must stay gated until filter enforcement is deployed. The LH runtime currently registers subscriptions by `source` and `topic` only and never evaluates the persisted `filter`, so once producers ship without S2, broad migrated subscriptions such as the coordinator's `task.*` would wake on every matching event regardless of intended status or label filters. S3's subscription-handler authorization is equally a prerequisite: today any same-Space member can add broad wakeups to or remove wakeups from another LH agent, so enabling native lifecycle flow before S3 lets members trigger unwanted autonomous turns or suppress a target's lifecycle processing. Enablement must additionally wait for L5: known bypass paths (`PostApprovalRouter`'s direct terminal write, scheduled task creation, dependency cascades, automation) commit state without lifecycle events until L5 wires them, so lifting the publication gate earlier tells agents native lifecycle delivery is active while silently missing transitions. Construction of L3/L4 may proceed earlier; only the enablement gate waits on S2 + S3 + L5.

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
