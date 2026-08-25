# Space runtime, tools, and goals migration plan

This plan covers the hand-rolled decision/effect cascades in the Space runtime, the Space and node-agent MCP tools, and the goal/Forge automation paths that are natural fits for the direct superpipe discipline in ADR 0004. The objective is to move each business path to **one named pipeline** (`decisionRun`, `stagedRun`, or a raw `superpipe` transform) while preserving existing behavior, keeping the class as the shell that reads snapshots and executes effects.

---

## Scope and combinator fit

| File:symbol | Current shape | Proposed combinator | Rationale |
| --- | --- | --- | --- |
| `packages/daemon/src/lib/space/runtime/task-agent-manager.ts:deliverDirectSteerUnderCoordination` | Long async cascade with mid-flow resnapshot, compensation (`discardPassengerCopy`), and DB effects | `stagedRun` | Multi-step flow: snapshot → decide → effect (passenger save) → resnapshot → effect (steer save/deliver/consume). Existing compensation pattern maps to `compensate`. |
| `packages/daemon/src/lib/external-events/deferred-event-digest.ts:foldDeferredExternalEventsAtFlush` | Partition, build digest, idempotent save, supersede sources | `stagedRun` | Has three ordered DB effects. Idempotency must be preserved; failure mid-way can duplicate or orphan rows. |
| `packages/daemon/src/lib/external-events/deferred-event-digest.ts:foldDeferredExternalEventOverflow` | Plan overflow (pure), then save envelope and supersede sources | `stagedRun` (with a `decide` stage that wraps `planDeferredExternalEventOverflow`) | Same staged-effect discipline as flush; planning is a pure branch. |
| `packages/daemon/src/lib/space/runtime/post-approval-router.ts:PostApprovalRouter.route` | Long if-cascade: no route, done terminal, spawn, skip, already-routed, with DB and sub-session effects | `stagedRun` | Needs snapshot, decide branches, effect stages (terminal write, spawn, task update), and resnapshot after spawn. |
| `packages/daemon/src/lib/space/tools/space-agent-tools.ts:send_message_to_task` | Large if-cascade with target parse, handle resolution, worker activation, inject/queue | `stagedRun` | Mixed read/decide/effect; activation is an awaitable effect that must be followed by resnapshot and conditional inject/queue. |
| `packages/daemon/src/lib/space/tools/space-agent-tools.ts:approve_pending_completion` | Validate caller, snapshot task, branch (approve/reject), effect status change + post-approval dispatch | `stagedRun` (shared with `spaceTask.approvePendingCompletion`) | Tool and RPC share the same state machine. The approve branch is an effect followed by resnapshot and a blocked-reason effect on dispatch failure. |
| `packages/daemon/src/lib/space/tools/space-agent-tools.ts:review_goal_outcome` | Discovery or claim path; claim uses `claimOutcomeNotification` | `stagedRun` that reuses existing `claim-admission-gates.ts` `decisionRun` | Discovery is a snapshot; claim is snapshot → `decideClaimAdmission` → effect (`apply` + `updateStatus`) → halt. |
| `packages/daemon/src/lib/space/tools/space-agent-tools.ts:get_task_detail` | Identifier/lookup/space check/return | `decisionRun` | Pure target-resolution and return; no effects. |
| `packages/daemon/src/lib/space/tools/space-agent-tools.ts:list_task_members` | Identifier/lookup/space check/workflow run check/list executions | `decisionRun` (admission), shell reads executions | Pure admission, then a read-only list. Can share the target gate with `get_task_detail`. |
| `packages/daemon/src/lib/space/tools/node-agent-tools.ts:get_task` | Same pattern as `get_task_detail` | `decisionRun` (shared `task-target-resolution` core) | Node-agent and Space-agent lookups should converge on one `decisionRun`. |
| `packages/daemon/src/lib/rpc-handlers/space-task-handlers.ts:validateWorkflowModelOverrides` | Pure validation of a string map against workflow nodes/agents | `decisionRun` | No effects; returns normalized map or reject. |
| `packages/daemon/src/lib/rpc-handlers/space-task-handlers.ts:spaceTask.update` | Large if-cascade around status transitions, dependency block, override validation | `stagedRun` or `decisionRun` + staged shell | The routing core `routeTaskUpdate` is already a pure function; this path should reuse/extend the existing `space-tool-pipeline.ts` `decisionRun` and add a staged shell for runtime effects. |
| `packages/daemon/src/lib/rpc-handlers/space-task-handlers.ts:spaceTask.approvePendingCompletion` | Same semantics as `approve_pending_completion` tool | `stagedRun` shared core | Unify with the tool path. |
| `packages/daemon/src/lib/rpc-handlers/space-task-handlers.ts:spaceTask.publish` | Same semantics as tool `publish_task` and `onPublishTask` | `stagedRun` or `decisionRun` + shell | `routePublishTask` already exists; unification is the main win. |
| `packages/daemon/src/lib/space/goals/goal-automation-service.ts:onTaskCompleted` | Snapshot task/goal/scope/evidence, threshold check, optional job enqueue | `decisionRun` (admission), shell enqueues | No mid-flow effects; the only effect is the final job queue push. |
| `packages/daemon/src/lib/space/goals/goal-automation-service.ts:onSelfNag` | Snapshot scope/goal/policy/cursor/evidence, decide whether to enqueue self-nag | `decisionRun` (admission), shell enqueues | Same pattern as `onTaskCompleted`. |
| `packages/daemon/src/lib/space/goals/goal-automation-schedule-sync.ts:syncGoalAutomationSelfNagScheduleForScope` | List schedules, pause/update/create schedule records | Direct sync `superpipe` (`.end`) inside the optional `db` transaction (review correction: `stagedRun` is async-only) | Effects on `ScheduleService`; must commit atomically with the sync transaction. |
| `packages/daemon/src/lib/space/goals/goal-service.ts:claimOutcomeNotification` | Inside `runAtomic`; snapshot notification/goal, `decideClaimAdmission`, `apply`, update status | Direct sync `superpipe` (`.end`) inside `runAtomic` — `stagedRun` is async-only and would commit early | Atomic claim; effect stage is the goal update and notification status flip. |
| `packages/daemon/src/lib/space/goals/goal-service.ts:handleTaskTerminal` | Inside `runAtomic`; decide reportable terminal, update task, clear active, next task, record notification | Direct sync `superpipe` (`.end`) inside `runAtomic` — `stagedRun` is async-only and would commit early | Most complex goal effect chain; needs gather/decide/effect stages. |
| `packages/daemon/src/lib/space/runtime/space-runtime.ts:registerSubscription` | Validate topic, validate task, check limit, trie insert, repo upsert, redispatch | Direct sync `superpipe` (`.end`) — review correction: `registerSubscription` completes synchronously and callers like `registerRunInterests` inspect `result.success` immediately in a loop; `stagedRun` (`endAsync`) would change that contract to a Promise and add await gaps between the interest-count snapshot and trie mutations | In-memory rollback on repo failure stays; the redispatch best-effort move (below) still applies. |
| `packages/daemon/src/lib/space/runtime/space-runtime.ts:validateSubscriptionTargetTask` | Pure check: task exists, belongs to run, not terminal | `decisionRun` (or a `decide` stage inside the `registerSubscription` `stagedRun`) | Trivial target gate. |
| `packages/daemon/src/lib/space/runtime/agent-message-routing-gates.ts:decideGenericAddressRouting` | Pure multi-branch routing by `ParsedAddress` kind | `decisionRun` | Already called inside a per-target loop; replacing the if-cascade with a `decisionRun` makes the precedence testable. |
| `packages/daemon/src/lib/space/runtime/agent-message-routing-gates.ts:resolveNodeAgentTargets` | Pure multi-branch target resolution | `decisionRun` | Currently used to feed `agent-message-routing-pipeline.ts`. Make it a first-class `decisionRun` and the pipeline can read its `decision`. |
| `packages/daemon/src/lib/space/runtime/activation-routing.ts:decideActivationRouting` | Pure multi-branch decision | `decisionRun` | Simple cascade; `decisionRun` is the right fit. |
| `packages/daemon/src/lib/space/runtime/last-message-classifier.ts:classifyLastMessageForIdleAgent` | Pure multi-branch classification of last SDK message | `decisionRun` | First classification wins; map to gates. |
| `packages/daemon/src/lib/space/runtime/task-agent-manager.ts:onArchiveTask` | Active-run guard, archive, emit | `decisionRun` (or `stagedRun`) shared with `archive_task` tool | Already a thin wrapper; unify with `routeArchiveTask` and the archive effect. |
| `packages/daemon/src/lib/space/runtime/task-agent-manager.ts:onPublishTask` | Publish, emit | `decisionRun` (or `stagedRun`) shared with `publish_task` tool and RPC | Same as above. |

---

## Existing superpipe examples to emulate

The repo already has several proven pipelines. Use these as the model for each shape rather than inventing new patterns.

### `decisionRun` examples (P3 / P7)

| Module | Pattern | What to copy |
| --- | --- | --- |
| `packages/daemon/src/lib/space/runtime/pending-drain-decision-pipeline.ts` | P3 decide-once | A small typed `Ctx` with `decision: null`, `decided` helper, terminal fallback, and per-gate unit tests. |
| `packages/daemon/src/lib/space/runtime/spawn-admission-decision-pipeline.ts` | P3 + ordered precedence | Multi-gate precedence (`live` beats `concurrent` beats `task status` ...). The final `applyProceedGate` returns a default. |
| `packages/daemon/src/lib/space/runtime/run-tick-decision-pipeline.ts` | P3 + lazy inputs | `readLazyInput` for values that may be a function or a concrete value. Each gate is a pure `(ctx) => ctx`. |
| `packages/daemon/src/lib/space/runtime/external-event-delivery-pipeline.ts` | P3 + post-activation re-decide | Two `decisionRun`s chained by the shell: `decideExternalEventDelivery` then, after the activation effect, `decidePostActivationDelivery`. |
| `packages/daemon/src/lib/space/tools/space-tool-pipeline.ts` | P3 + tool autonomy gate | Wraps `routeTaskUpdate` from `task-transition-routing.ts` and adds an autonomy gate at the front. Shows how a tool-specific pipeline composes a shared routing core. |
| `packages/daemon/src/lib/space/goals/claim-admission-gates.ts` | P3 | Five ordered gates: `authorized`, `unsuperseded`, `identity-bound`, `revision-match`, `admit`. The output is `ClaimAdmissionDecision`. |
| `packages/daemon/src/lib/space/goals/reportable-terminal-gates.ts` | P3 + domain-specific terminal logic | `decideReportableTerminal` with branches `none`/`notify`/`supersede_notify`. |
| `packages/daemon/src/lib/space/goals/goal-owner-resolution.ts` | P3 + data-driven ranking | Filters/sorts `candidates` and decides `resolved`/`degraded`/`coordinator_fallback`/`no_recipient`. |

### `stagedRun` examples (P8)

| Module | Pattern | What to copy |
| --- | --- | --- |
| `packages/daemon/src/lib/space/runtime/spawn-flow.ts` | P8 full lifecycle | `snapshot` → `decide` (wraps `spawn-admission-decision-pipeline.ts`) → guarded `effect`/`halt` branches, `resnapshot` after the async `createSpawnedSession`, `compensate` on `reserve-task-spawn` and `reserve-and-spawn-session`. |
| `packages/daemon/src/lib/space/runtime/verified-stop-flow.ts` | P8 + retry loop as re-snapshot | `snapshot` → `decide` → `effect` (interrupt) → `resnapshot` → `decide` (retry) → `effect` → `resnapshot` ... `halt`. Shows how to model retries with resnapshot and guarded branches. |

### Raw `superpipe` examples (P1 / P4 / mixed)

| Module | Pattern | What to copy |
| --- | --- | --- |
| `packages/daemon/src/lib/space/runtime/external-event-steer-admission-pipeline.ts` | P1/P3/P4 raw transform | A pipeline that **enriches** the context (`steerEssences`, `passengerEssences`, `classes`, `eventClass`) and uses `!admissionSettled` after each transform. Use this when the pipeline needs to accumulate derived fields, not just stamp a single `decision`. |

---

## Per-site detailed plans

### `packages/daemon/src/lib/space/runtime/task-agent-manager.ts:deliverDirectSteerUnderCoordination`

- **Current summary**: Flushes a buffered list of direct-steer entries for a session. It checks session liveness, parent-task rate limit, deferred row presence, partitions `steerEssences`/`passengerEssences`, optionally saves a passenger message, re-checks session state, saves a steer message, enqueues delivery, and marks the original rows `consumed`. It has an in-memory compensation `discardPassengerCopy` for the passenger save.
- **Proposed combinator**: `stagedRun`.
- **Input snapshot design**:
  ```ts
  interface DirectSteerFlushState {
    sessionId: string;
    bufferedEntries: DirectSteerBufferEntry[];
    session: AgentSession | null;
    processingStatus: AgentProcessingState['status'];
    parentTaskLimited: boolean;
    deferredRows: PendingAgentMessageRecord[];
    steerable: DirectSteerBufferEntry[];
    steerEssences: ExternalEventEssenceEntry[];
    passengerEssences: ExternalEventEssenceEntry[];
    carriedDropped: number;
    passengerDbId: string | null;
    steerDbId: string | null;
  }
  ```
- **Pure core design**: Extract a `decideDirectSteerFlush` `decisionRun` for the pure gates:
  - `sessionMissing`
  - `sessionNotProcessing`
  - `parentTaskLimited`
  - `noDeferredRows`
  - `noSteerEssences`
  - `proceed`
- **Shell/effect wiring**: The `TaskAgentManager` calls `runDirectSteerFlush({ sessionId, bufferedEntries })`. Effects call `db.getUserMessagesByStatus`, `db.saveUserMessage`, `deliverMessage`, `db.updateMessageStatus`, `publishMessageStatusChanged`. `passengerDbId` is a shared mutable box, similar to `SpawnAttemptBox` in `spawn-flow.ts`, because it must be visible to later effect/resnapshot stages.
- **Step-by-step migration**:
  1. Move `deliverDirectSteerUnderCoordination` into `stagedRun('direct-steer-flush', (s) => [...])`.
  2. First `snapshot` gathers session, processing status, parent-task limited, deferred rows, and partitions entries.
  3. `decide` runs `decideDirectSteerFlush` over the snapshot.
  4. `effect` `save-passenger-copy` (when `proceed`) writes the passenger row and publishes `deferred`. Register `compensate` that calls `discardPassengerCopy`.
  5. `resnapshot` re-reads session and parent-task state.
  6. Second `decide` aborts if the session left processing or became
     limited. Review correction: this branch must run a GUARDED CLEANUP
     EFFECT (`consume-passenger-copy`, the same status update the current
     implementation performs in this race) BEFORE halting — `stagedRun`
     unwinds compensations only on errors or `superseded`, not on a
     successful halt, so the registered `discardPassengerCopy` compensation
     would NOT run here and the copied row would remain `deferred` alongside
     its original source rows.
  7. `effect` `save-steer-row` saves the steer message.
  8. `effect` `enqueue-steer-delivery` calls `deliverMessage`. On throw, mark the steer row `failed` and trigger the passenger compensation.
  9. `effect` `consume-source-rows` updates source row statuses.
  10. `effect` `record-steer-metrics` calls `recordDirectSteerEnqueued()` and
      `recordDirectSteerEnqueuedClass(...)` for every steered class (review
      correction: these counters feed external-event queue health reporting
      and are asserted by the existing direct-steer suite; omitting them
      makes migrated deliveries disappear from telemetry).
  11. `effect` `publish-status-transitions` publishes the steer row's
      `enqueued` status and the `messages.statusChanged` event marking all
      source rows `consumed` (review correction: without these publications
      LiveQuery/runtime subscribers keep showing the source rows as
      `deferred` and miss the enqueued steer until a later refresh).
  12. `halt` returns `{ enqueued: true, eventCount }`.
- **Tests**: `packages/daemon/tests/unit/5-space/runtime/task-agent-manager-direct-steer.test.ts` covers the existing behavior. Add a parity harness and per-stage unit tests (`task-agent-manager-direct-steer-pipeline.test.ts`) that mock `saveUserMessage`, `deliverMessage`, and `updateMessageStatus`.
- **Risks/caveats**: This is the `#1398 continuation` site. The existing code intentionally stops if the session leaves `processing` while preserving passengers. A `stagedRun` must replicate that exact resnapshot timing. Do not add retries; the ADR forbids in-flow retry. Compensation is in-memory only; if the process dies between passenger save and consume, the passenger row is left `deferred` and will be reconciled by the normal flush path, which is acceptable.

### `packages/daemon/src/lib/external-events/deferred-event-digest.ts:foldDeferredExternalEventsAtFlush`

- **Current summary**: Takes `DeferredDeliveryRow[]`, partitions them into digest/remainder with `partitionDeferredExternalEventRows`, builds a digest message, supersedes stale folds with the same deterministic UUID, saves a new fold row idempotently, marks source rows `superseded`, and returns the digest row and remainder.
- **Proposed combinator**: `stagedRun` (the fold operation is a single business path with multiple ordered effects).
- **Input snapshot design**:
  ```ts
  interface FlushFoldState {
    sessionId: string;
    rows: DeferredDeliveryRow[];
    partition: { digestRows: DeferredDeliveryRow[]; remainder: DeferredDeliveryRow[]; digestEvents: ExternalEventEssenceEntry[]; droppedCount: number } | null;
    digestText: string;
    sourceDbIds: string[];
    keepUuid: string;
    saved: { dbId: string; message: SDKUserMessage } | null;
  }
  ```
- **Pure core design**: `partitionDeferredExternalEventRows` is already pure; keep it as the first `decide` stage that halts with `no-fold` when `digestRows` is empty.
- **Shell/effect wiring**: Effects are `ops.supersedeStaleFolds`, `saveFoldRowIdempotently`, `ops.markSuperseded`. The `DeferredEventDigestRowOps` interface should be passed as a dep. The final `halt` returns `{ digestRow, remainder, foldedCount }`.
- **Step-by-step migration**:
  1. Define `stagedRun<FlushFoldState>('fold-deferred-at-flush', (s) => [...])`.
  2. `snapshot` runs `partitionDeferredExternalEventRows` and stores `partition`.
  3. `decide` halts (`!proceed` branch) if `partition.digestRows.length === 0`.
  4. `effect` `supersede-stale-folds` calls `ops.supersedeStaleFolds(keepUuid)`.
  5. `effect` `save-fold-row` calls `saveFoldRowIdempotently` with deterministic UUID. If this fails, the superseded stale folds are already gone; this is fine because the source rows are still `deferred` and the next flush will recompute. However, for true atomicity consider a single `foldDigest` repo primitive.
  6. `effect` `mark-sources-superseded` calls `ops.markSuperseded(sourceDbIds)`.
  7. `halt` builds and returns `DeferredEventDigestFlushResult`.
- **Tests**: `packages/daemon/tests/unit/4-space-storage/storage/deferred-event-digest.test.ts`. Add `stagedRun`-specific tests: no digest rows, duplicate deterministic UUID, failure after save before mark (verify idempotency), and overflow fold interaction.
- **Risks/caveats**: The current `saveFoldRowIdempotently` is already idempotent by deterministic UUID, which mitigates crash/replay. The `supersedeStaleFolds` + `markSuperseded` sequence is not atomic; consider wrapping in a repo transaction or adding a single `foldAndSupersede` primitive. Do not expose the pipeline as a loop; the flush loop stays outside.

### `packages/daemon/src/lib/external-events/deferred-event-digest.ts:foldDeferredExternalEventOverflow`

- **Current summary**: Plans which rows exceed the cap using `planDeferredExternalEventOverflow`, builds an envelope message, saves it, and marks overflow rows `superseded`.
- **Proposed combinator**: `stagedRun` with the planning step as a `decide` stage.
- **Input snapshot design**: Same row set as above plus `cap: number` and the `plan: DeferredEventOverflowFold | null`.
- **Pure core design**: `planDeferredExternalEventOverflow` is already pure. Move it into a `decide` stage that branches `overflow`/`no-overflow`. It returns the plan as a branch payload.
- **Shell/effect wiring**: Effects are `buildDeferredEventDigestEnvelopeText`, `buildSyntheticExternalEventMessage`, `saveFoldRowIdempotently`, `ops.markSuperseded`. The `halt` returns `DeferredEventOverflowFoldResult`.
- **Step-by-step migration**:
  1. Define `stagedRun<OverflowFoldState>('fold-deferred-overflow', (s) => [...])`.
  2. `snapshot` copies input rows and cap.
  3. `decide` runs `planDeferredExternalEventRows` and branches `noOverflow` (halt with `null`) or `overflow`.
  4. `effect` `save-overflow-envelope` saves the fold row idempotently.
  5. `effect` `mark-overflow-superseded` marks the overflow rows.
  6. `halt` returns the result.
- **Tests**: Same `deferred-event-digest.test.ts` plus tests for the cap boundary and fold-vs-raw selection.
- **Risks/caveats**: The two effects must be idempotent or transactionally guarded. If `markSuperseded` fails, a re-run will find the existing envelope by UUID and skip the save, but the source rows will not be superseded, potentially inflating the queue until the next attempt. A single repo primitive or transaction is preferred.

### `packages/daemon/src/lib/space/runtime/post-approval-router.ts:PostApprovalRouter.route`

- **Current summary**: Routes an `approved` task through post-approval workflow. It collects routes from the workflow, decides between `no-route` (terminal `done`), `already-routed`, `skipped`, or `spawn`. For `no-route` it updates the task, may call `goalService.handleTaskTerminal`, and captures Forge evidence. For `spawn` it interpolates the template, spawns a sub-session, and updates the task with `postApprovalSessionId`/`postApprovalStartedAt`.
- **Proposed combinator**: `stagedRun`.
- **Input snapshot design**:
  ```ts
  interface PostApprovalRouteState {
    task: SpaceTask;
    workflow: SpaceWorkflow | null;
    context: PostApprovalRouteContext;
    allRoutes: PostApprovalRoute[];
    dispatchable: PostApprovalRoute[];
    existingSessionAlive: boolean;
    route?: PostApprovalRoute;
    interpolated: { text: string; missingKeys: string[] } | null;
    spawnedSessionId: string | null;
    startedAt: number | null;
  }
  ```
- **Pure core design**: Extract a `decidePostApprovalRoute` `decisionRun` with branches: `notApproved`, `noRoutes`, `alreadyRouted`, `missingWorkflow`, `emptyInstructions`, `proceed`. Review correction: `multiRoutes` is NOT a decision branch — the current router WARNS and then continues with the FIRST route; a terminal `multiRoutes` decision would halt the pipeline before `proceed`. Record it as a nonterminal side annotation (`warnings` array) stamped before the decide stage, and `proceed` carries `routes[0]`.
- **Shell/effect wiring**: The `PostApprovalRouter` shell calls `stagedRun('post-approval-route', ...)` with `deps`. Effects call `resolveCompletionOutcome`, `taskRepo.updateTask`, `goalService.handleTaskTerminal`, `evolutionScopeService.captureCompletedTaskEvidence`, `spawner.spawnPostApprovalSubSession`, `clearPendingCompletionState`. The final `halt` returns `PostApprovalRouteResult`.
- **Step-by-step migration**:
  1. `snapshot` gathers task (fresh), workflow, routes, liveness.
  2. `decide` runs `decidePostApprovalRoute`.
  3. Branch `notApproved` → `halt` with `skipped`.
  4. Branch `noRoutes` → `effect` `terminalize-no-route`: when the task
     belongs to a goal, PASS the terminal updates to
     `goalService.handleTaskTerminal` and do NOT independently update the
     task or capture evidence — the handler performs both inside its atomic
     bookkeeping path (review correction: doing the direct update + evidence
     capture unconditionally creates a non-atomic task/goal transition and
     invokes the Forge capture twice). The direct update + fallback evidence
     capture runs ONLY when `handleTaskTerminal` returns `null` (non-goal
     task or handler declined), and that fallback capture keeps its local
     catch. `compensate` is not practical here; wrap the branch in a repo
     transaction or use a `claimTaskStatus` CAS.
  5. Branch `alreadyRouted` → `halt`.
  6. Branch `missingWorkflow`/`emptyInstructions` → `effect` `clear-pending-state`, `halt`.
  7. Branch `proceed` → `effect` `reserve-dispatch` FIRST: an atomic
     `claimPostApprovalDispatch` CAS on the task (conditional update where
     `postApprovalSessionId IS NULL AND status = 'approved'`) that stamps a
     reservation (dispatch claim) BEFORE any session is spawned (review
     correction — resnapshot-after-spawn cannot prevent concurrent dispatch:
     two callers can both pass admission, spawn separate sessions, and only
     then discover one task update lost). Its `compensate` releases the
     reservation ONLY while no session has been spawned — the compensate is
     guarded on the state's `spawnedSessionId` being unset, so a later-stage
     failure can never unwind the claim after spawning.
  8. `effect` `spawn-post-approval-sub-session` catches and classifies the
     EXPECTED failures in-stage (review correction round 8:
     `isSpawnSupersededError` and `isTransientSpawnError` are caught by the
     current router, which clears pending-completion fields, records the
     specific `postApprovalBlockedReason`, releases the unconsumed
     reservation, and returns `{ mode: 'skipped' }` — a generic effect
     failure would unwind and escape, losing that durable blocked state).
     The in-stage catch diverts to the existing clear/block/skip branch;
     compensation-based failure propagation applies only to UNEXPECTED
     errors. Its `compensate` for unexpected failures
     terminates/ends the spawned sub-session (review correction round 3: the
     only previously specified compensation released the reservation, so a
     `record-dispatched-session` throw or CAS loss would make the task
     dispatchable again while the spawned session stayed live — a retry then
     creates a second orphan. After a successful spawn the claim is
     NON-releasable; failure cleanup owns the session, not the claim).
  9. `effect` `record-dispatched-session` converts the reservation into the
     final `postApprovalSessionId`/`postApprovalStartedAt` via the same
     conditional CAS (the loser of the reservation race halts at step 7
     without ever spawning; if this CAS loses despite the reservation, the
     unwind runs step 8's compensate and terminates THIS caller's spawned
     session — the winner's claim is never touched). Review correction
     round 4: after that termination is VERIFIED, this caller must
     conditionally release its own dispatch claim (a conditional delete
     scoped to this caller's reservation token — or use an
     expiring/tokenized claim): leaving the reservation in place with no
     live post-approval session makes every retry lose at `reserve-dispatch`
     and permanently blocks the approved task. Retain the claim only when
     session termination cannot be confirmed (crash window), where the
     expiring-claim fallback eventually unblocks).
  10. `halt` returns `spawn` result.
- **Tests**: `packages/daemon/tests/unit/5-space/runtime/post-approval-router.test.ts` and `packages/daemon/tests/unit/5-space/runtime/post-approval-routing-integration.test.ts`. Add a `stagedRun` contract test that verifies each branch, the reservation CAS (including the concurrent-caller race: second caller halts at `reserve-dispatch` and no session is spawned), the spawn compensation path, AND the round-4 row: `record-dispatched-session` throwing terminates this caller's spawned session and then CONDITIONALLY RELEASES the claim after verified termination (task becomes dispatchable again); the claim is retained ONLY when termination cannot be confirmed — never left durably held with no live session, which would block every retry at `reserve-dispatch`.
- **Risks/caveats**: This is the most effect-heavy site. The current code does not use CAS; concurrent spawns can overwrite the task — hence the reservation-before-spawn step above; without it, a conditional `record-dispatched-session` alone protects the row but leaves the losing spawned session orphaned and active. The compensations are asymmetric by design: claim-release only pre-spawn, session-termination only post-spawn. `goalService.handleTaskTerminal` must remain inside the same transaction as the task update if possible; otherwise the task could be `done` without the goal seeing it.

### `packages/daemon/src/lib/space/tools/space-agent-tools.ts:send_message_to_task`

- **Current summary**: Resolves a task, validates it, resolves a target (`node_id` or `target`), handles long-horizon handles, worker targets, and session targets, and either injects into a live session, activates the node and re-injects, or queues a pending message.
- **Proposed combinator**: `stagedRun` (with nested `decisionRun`s for sub-admissions).
- **Input snapshot design**:
  ```ts
  interface DeliverTaskMessageState {
    args: SendMessageToTaskInput;
    task: SpaceTask | null;
    allExecutions: NodeExecution[];
    run: SpaceWorkflowRun | null;
    workflow: SpaceWorkflow | null;
    resolved: NodeExecution | null;
    genericTarget: string | null;
    address: ParsedAddress | null;
  }
  ```
- **Pure core design**: Compose two `decisionRun`s:
  - `decideTaskMessageTarget`: resolves `task_id`/`task_number`, space, archived, target presence, workflow run.
  - `decideDeliveryMode`: given `resolved` and `address`, decides `injectLive`, `activateAndInject`, `queue`, `deliverLongTerm`.
- **Shell/effect wiring**: Effects: `taskRepo.getTask`, `taskRepo.getTaskByNumber`, `nodeExecutionRepo.listByWorkflowRun`, `workflowRunRepo.getRun`, `resolveHandleForTaskRouting`, `translateTaskMessageTarget`, `activateNode`, `taskAgentManager.injectSubSessionMessage`, `pendingMessageQueue.enqueue`. `auditing` and `jsonResult` mapping stay in the tool shell.
- **Step-by-step migration**:
  1. Move the target-resolution/admission block into a `decideTaskMessageTarget` `decisionRun`.
  2. Move the target parse and execution resolution into a `snapshot` stage.
  3. `decide` `delivery-mode` runs the second `decisionRun`.
  4. Guarded `effect` branches:
     - `deliverToSpaceAgent`: call `SpaceDeliveryFacade.routeMessage`.
     - `injectLive`: `taskAgentManager.injectSubSessionMessage`. Review
       correction: an `injectLive` THROW on a stale live session is NOT a
       pipeline failure — the current tool catches it
       (`space-agent-tools.ts:2674-2710`) and falls through `activateNode` →
       resnapshot → reinject. Model it as an `inject-failed` branch (or an
       in-stage catch that diverts) so the flow continues into activation;
       pin it with a stale-live-session test.
     - `activate`: `activateNode`.
     - `resnapshot` execution after activation.
     - `injectAfterActivation`: re-inject.
     - `queue`: `pendingMessageQueue.enqueue`.
  5. `halt` returns a `DeliverTaskMessageResult` that the shell maps to `jsonResult` and audits.
- **Tests**: `packages/daemon/tests/unit/5-space/runtime/space-agent-tools.test.ts`. Add `send_message_to_task` pipeline tests for target disambiguation, long-horizon handle, worker activation, and queue fallback.
- **Risks/caveats**: This tool is large. Do not try to fold the entire `AgentMessageRouter` into the same pipeline; `send_message_to_task` delegates to the router for long-term agents and resolves workers itself. The activation effect is not compensable; if activation succeeds and the subsequent inject fails, the message may be queued or reported as failed, which is the current behavior. Keep the current fallback semantics.

### `packages/daemon/src/lib/space/tools/space-agent-tools.ts:approve_pending_completion` and `packages/daemon/src/lib/rpc-handlers/space-task-handlers.ts:spaceTask.approvePendingCompletion`

- **Current summary**: Both approve or reject a `review`/`pendingCheckpointType: task_completion` task. If approved, set status `approved` and dispatch post-approval; if dispatch fails after commit, record `postApprovalBlockedReason`. If rejected, set `in_progress` and record reason.
- **Proposed combinator**: `stagedRun` shared core, named `approve-pending-completion`.
- **Input snapshot design**:
  ```ts
  interface ApprovePendingCompletionState {
    callerMayApprove: boolean;
    task: SpaceTask | null;
    approved: boolean;
    reason: string | null;
    dispatchErr?: unknown;
  }
  ```
- **Pure core design**: `decideApprovePendingCompletion` `decisionRun` with branches: `unauthorized`, `notFound`, `spaceMismatch`, `notPending`, `notReview`, `approve`, `reject`.
- **Shell/effect wiring**:
  - Tool shell: validates `callerRole === 'coordinator' | 'legacy_task_agent'`, sets `callerMayApprove`, runs the pipeline, maps to `jsonResult`.
  - RPC shell: sets `callerMayApprove = true`, runs the pipeline, returns the final task.
  - Effects: `taskManager.setTaskStatus` (`approved` or `in_progress`), `runtime.dispatchPostApproval`, `taskManager.updateTask` (blocked reason or approval reason), `taskRepo.getTask` (resnapshot).
- **Step-by-step migration**:
  1. Extract the function into `packages/daemon/src/lib/space/runtime/approve-pending-completion-pipeline.ts`.
  2. `snapshot` loads task.
  3. `decide` admission.
  4. Guarded `effect` `set-approved` (when `approve`) calls `taskManager.setTaskStatus(task.id, 'approved')` — review correction: do NOT call this before `dispatchPostApproval` and then rely on dispatch to observe it; `dispatchPostApproval` skips its own status transition when it sees `approved`, and that transition is where `approvalSource`/`approvalReason` are stamped. Either keep `runtime.dispatchPostApproval` as the approval primitive (preferred — the pipeline records intent and dispatch performs the stamping) or include `approvalSource`/`approvalReason` in this initial write; the shared pipeline state must carry the source either way.
  5. `effect` `dispatch-post-approval` calls `runtime.dispatchPostApproval` with an IN-STAGE catch (review correction: a dispatch throw AFTER the task is committed `approved` is an EXPECTED post-commit failure in the current tool/RPC paths — they catch it, verify the approved status, and persist `postApprovalBlockedReason`; an uncaught effect throw would terminate and unwind the `stagedRun`, so the resnapshot and blocked-reason stages could never run). The stage stores the error in a `dispatchError` side box instead of rethrowing, and the guarded steps 6–7 branch on it.
  6. `resnapshot` task.
  7. `effect` `record-blocked-reason` (when dispatch threw) updates `postApprovalBlockedReason`.
  8. Guarded `effect` `set-rejected` (when `reject`) calls `taskManager.setTaskStatus` then `updateTask` with reason.
  9. `halt` returns final `SpaceTask`.
- **Tests**: `packages/daemon/tests/unit/2-handlers/rpc-handlers/space-task-handlers.test.ts` and `packages/daemon/tests/unit/5-space/runtime/space-agent-tools.test.ts`. Add a shared test module for the pipeline that runs the same inputs through both shells, including a row asserting `approvalSource`/`approvalReason` survive both shells.
- **Risks/caveats**: Unification is the main goal: do not leave the tool and RPC with slightly different error messages or preconditions. The dispatch-failure path must still leave the task `approved`; the pipeline must not roll that back. Audit metadata (`approvalSource`, `approvalReason`) must not be silently dropped by the approval-order change above.

### `packages/daemon/src/lib/space/tools/space-agent-tools.ts:review_goal_outcome`

- **Current summary**: Two modes: (1) list claimable outcome notifications, (2) claim a notification and optionally apply a goal update. The claim path calls `goalService.claimOutcomeNotification`, which uses `decideClaimAdmission` and then applies the update.
- **Proposed combinator**: `stagedRun` that reuses the existing `decisionRun` from `claim-admission-gates.ts`.
- **Input snapshot design**:
  ```ts
  interface ReviewGoalOutcomeState {
    args: ReviewGoalOutcomeInput;
    goalService: SpaceGoalService;
    notifications: SpaceGoalOutcomeNotification[] | null;
    notification: SpaceGoalOutcomeNotification | null;
    goal: SpaceGoal | null;
  }
  ```
- **Pure core design**:
  - `decideReviewGoalOutcomeMode`: branches `discover` (no `notification_id` and no updates) or `claim`.
  - Inside `claim`, use `decideClaimAdmission` from `claim-admission-gates.ts`.
- **Shell/effect wiring**: Effects: `goalService.listClaimableOutcomeNotifications`, `goalService.claimOutcomeNotification` (or, after migration, an inline effect that invokes the same sync claim pipeline).
- **Step-by-step migration**:
  1. Define `stagedRun('review-goal-outcome', ...)`.
  2. `snapshot` validates `hasGoalUpdate` vs `disposition` rules.
  3. `decide` mode: `discover` or `claim`.
  4. Branch `discover` → `snapshot` list notifications → `halt`.
  5. Branch `claim` → `snapshot` notification and goal; `decide` `claim-admission` (import existing `decisionRun`); `effect` `apply-goal-update` (when `mutatesGoalState`); `effect` `update-notification-status`; `halt`.
- **Tests**: `packages/daemon/tests/unit/4-space-storage/space-goal-claim.test.ts` and `packages/daemon/tests/unit/5-space/runtime/space-agent-tools.test.ts`.
- **Risks/caveats**: The `claimOutcomeNotification` call is currently inside `runAtomic` in `goal-service.ts`; after unification the atomicity should not be broken. Either keep `goalService.claimOutcomeNotification` as the effect primitive or call the same sync claim pipeline from both places — never an async `stagedRun` inside the transaction.

### `packages/daemon/src/lib/space/tools/space-agent-tools.ts:get_task_detail` and `packages/daemon/src/lib/space/tools/space-agent-tools.ts:list_task_members`

- **Current summary**: `get_task_detail` looks up a task by `task_id` or `task_number`, checks space, and returns it. `list_task_members` does the same plus requires a workflow run and lists its `NodeExecution`s.
- **Proposed combinator**: `decisionRun` shared core (`task-target-resolution`) plus shell reads.
- **Input snapshot design**:
  ```ts
  interface TaskTargetResolutionCtx {
    identifier: { task_id?: string; task_number?: number };
    spaceId: string;
    task: SpaceTask | null;
  }
  ```
- **Pure core design**: `decideTaskTargetResolution` with branches: `missingIdentifier`, `notFound`, `spaceMismatch`, `resolved`.
- **Shell/effect wiring**:
  - `get_task_detail` shell: runs the `decisionRun`, returns `jsonResult`.
  - `list_task_members` shell: runs the `decisionRun`, then if `task.workflowRunId` is null returns `success: true, executions: []`, otherwise reads `nodeExecutionRepo.listByWorkflowRun`.
- **Step-by-step migration**:
  1. Create `packages/daemon/src/lib/space/tools/task-target-resolution-pipeline.ts` exporting `decideTaskTargetResolution`.
  2. Replace the inline if-cascades in both tools with the `decisionRun`.
  3. `list_task_members` adds a post-decision read for the executions.
- **Tests**: `packages/daemon/tests/unit/5-space/runtime/space-agent-tools.test.ts`. Add tests for missing identifier, not found, and space mismatch.
- **Risks/caveats**: `get_task_detail` is currently `await taskManager.getTaskByNumber` (async), while `taskRepo.getTaskByNumber` is sync. The `decisionRun` should accept a `getTaskByNumber` function returning a `Promise` or `SpaceTask`? `decisionRun` is sync; gather the task in the shell before calling the pipeline, or use a `stagedRun` if the lookup must be in the pipeline. Because lookups are fast and the rest is pure, gather in the shell and pass `task`/`taskInSpace` to the `decisionRun`.

### `packages/daemon/src/lib/space/tools/node-agent-tools.ts:get_task`

- **Current summary**: Same as `get_task_detail` but in the node-agent tool set. It currently checks `taskRepo` directly.
- **Proposed combinator**: `decisionRun` (shared `task-target-resolution` core from above).
- **Input snapshot design**: Same as `get_task_detail`.
- **Pure core design**: Use `decideTaskTargetResolution`.
- **Shell/effect wiring**: `node-agent-tools.ts` shell runs the `decisionRun` and maps to `jsonResult`.
- **Step-by-step migration**: Import `decideTaskTargetResolution` from the new shared module and delete the inline checks.
- **Tests**: `packages/daemon/tests/unit/5-space/agent/node-agent-tools.test.ts`.
- **Risks/caveats**: Ensure the node-agent tool's `get_task` and the Space-agent `get_task_detail` produce the same error messages and `success` shape.

### `packages/daemon/src/lib/rpc-handlers/space-task-handlers.ts:validateWorkflowModelOverrides`

- **Current summary**: Validates `workflowModelOverrides` after the task has started; normalizes the map; checks the selected workflow exists and is not disabled; validates every key matches `nodeId:agentName`.
- **Proposed combinator**: `decisionRun`.
- **Input snapshot design**:
  ```ts
  interface WorkflowOverrideValidationCtx {
    overrides: unknown;
    task: Pick<SpaceTask, 'workflowRunId' | 'startedAt' | 'preferredWorkflowId' | 'spaceId'>;
    workflow: SpaceWorkflow | null;
    workflowSelected: boolean;
    decision: { action: 'valid'; value: Record<string, string> | null } | { action: 'reject'; reason: string } | null;
  }
  ```
- **Pure core design**: Gates: `overridesUndefined`, `lockedAfterStart`, `nullOverrides`, `invalidMap`, `noWorkflow`, `workflowDisabled`, `invalidKey`, `valid`.
- **Shell/effect wiring**: The `spaceTask.update` shell calls `decideWorkflowModelOverrides({ ... })`. If `reject`, throw. If `valid`, apply the normalized value. Because `workflowManager.getWorkflow` is a snapshot read, pass the workflow in as part of the snapshot; do not call the manager inside the pipeline.
- **Step-by-step migration**: Rename the current function to a `decisionRun` module; the current `throw` sites become `decision` branches. The RPC handler calls `decide...` and throws on `reject`.
- **Tests**: `packages/daemon/tests/unit/2-handlers/rpc-handlers/space-task-handlers.test.ts`.
- **Risks/caveats**: The function is `async` but contains no awaits. Keep it sync in the `decisionRun`; if a future lookup becomes async, wrap in `stagedRun`.

### `packages/daemon/src/lib/rpc-handlers/space-task-handlers.ts:spaceTask.update`

- **Current summary**: Validates input, workflow overrides, handles dependency-added blocked transitions, recovery transitions, stop/park for status, set_status, and field-only updates. Emits `space.task.updated`.
- **Proposed combinator**: `stagedRun` whose first `decide` stage uses the existing `routeTaskUpdate` function (or a new `decisionRun` wrapper) and the existing `decideUpdateTask` from `space-tool-pipeline.ts`.
- **Input snapshot design**:
  ```ts
  interface RpcTaskUpdateState {
    space: Space;
    currentTask: SpaceTask;
    updateParams: UpdateSpaceTaskParams;
    validatedOverrides: Record<string, string> | null | undefined;
    runtimeAvailable: boolean;
    plan: TaskUpdateRouting | null;
    updatedTask: SpaceTask | null;
    emitTaskUpdated: boolean;
  }
  ```
- **Pure core design**:
  - `decideTaskUpdate` should be the single source of truth for both the tool and the RPC. It already lives in `task-transition-routing.ts` as `routeTaskUpdate`. Wrap it in a `decisionRun` in `packages/daemon/src/lib/space/tools/task-update-routing-pipeline.ts`.
  - The tool's `space-tool-pipeline.ts` should call this core after its autonomy gate, rather than calling `routeTaskUpdate` directly, so the gate order is shared.
- **Shell/effect wiring**: The RPC handler's shell executes the selected branch:
  - `reject` → throw.
  - `park_stopped` → `spaceRuntimeService.parkStoppedWorkflowTask` then optional field update.
  - `recover_transition` → `spaceRuntimeService.recoverWorkflowBackedTask` then optional field update.
  - `stop_for_status` → `spaceRuntimeService.stopWorkflowBackedTaskForStatus`.
  - `set_status` → `taskManager.setTaskStatus`.
  - `fields_only` → `taskManager.updateTask`.
  - Review correction: the current handler calls
    `ensureWorkflowOverridesStillUnlocked` immediately before EACH subsequent
    field update; the pipeline must re-check the lock (fresh task resnapshot
    + lock gate) before EVERY effect that can persist `workflowModelOverrides`
    fields. Validating overrides only before routing is not enough: another
    request can start the task (`startedAt`/`workflowRunId` set) while this
    pipeline awaits a recover/park/stop operation, after which the stale
    admission would write locked overrides.
- **Step-by-step migration**:
  1. Create `packages/daemon/src/lib/space/tools/task-update-routing-pipeline.ts` exporting `decideTaskUpdate` as a `decisionRun`.
  2. Update `space-tool-pipeline.ts` to import and call `decideTaskUpdate` from there.
  3. Rewrite `spaceTask.update` handler to first run `validateWorkflowModelOverrides` (as a `decisionRun`), then `decideTaskUpdate`, then a `stagedRun` or switch on `plan.action`.
  4. Unify dependency-block logic with the tool's `park_stopped` and `recover_transition` paths.
  5. Move `emitTaskUpdated` and `emitCascadedTasks` into the `stagedRun` `halt` or as a post-pipeline shell step.
- **Tests**: `packages/daemon/tests/unit/2-handlers/rpc-handlers/space-task-handlers.test.ts` and `packages/daemon/tests/unit/5-space/tools/space-tool-pipeline.test.ts`. Add parity tests that feed the same `TaskUpdateRoutingInput` to both the tool and the RPC.
- **Risks/caveats**: This is the biggest unification site. The RPC has extra preconditions (e.g., rejecting direct `review`/`approved` transitions) that the tool also enforces through `routeTaskUpdate`, but the wording is slightly different. Align the messages. The dependency-added path is unique to the RPC and must be preserved.

### `packages/daemon/src/lib/rpc-handlers/space-task-handlers.ts:spaceTask.publish`

- **Current summary**: Fetches task, checks `draft`, calls `taskManager.publishTask`, emits `space.task.updated`.
- **Proposed combinator**: `decisionRun` (or `stagedRun`) shared with `publish_task` tool and `onPublishTask`.
- **Input snapshot design**:
  ```ts
  interface TaskPublishState {
    taskExists: boolean;
    taskInSpace: boolean;
    currentStatus: string;
    taskId: string;
  }
  ```
- **Pure core design**: `decideTaskPublish` using the existing `routePublishTask` in `task-transition-routing.ts`. Branches: `reject` (not found / not in space / not draft), `publish`.
- **Shell/effect wiring**: `effect` `publish` calls `taskManager.publishTask`; `halt` returns the task. The RPC and tool shells map to their response shapes and emit events.
- **Step-by-step migration**:
  1. Create `packages/daemon/src/lib/space/tools/task-publish-pipeline.ts` with `decideTaskPublish`.
  2. Replace the tool `publish_task`, the RPC `spaceTask.publish`, and `onPublishTask` with calls to the same `decisionRun`.
  3. If `stagedRun` is chosen, add an `effect` stage for `publish` and a `halt` that returns the task.
- **Tests**: `packages/daemon/tests/unit/2-handlers/rpc-handlers/space-task-handlers.test.ts` and `packages/daemon/tests/unit/5-space/runtime/space-agent-tools.test.ts`.
- **Risks/caveats**: `publish_task` in the space-agent tool currently uses `taskRepo.getTask` (sync), while the RPC uses `taskManager.getTask` (async). Align on `taskManager` or `taskRepo`.

### `packages/daemon/src/lib/space/runtime/task-agent-manager.ts:onArchiveTask` and `onPublishTask`

- **Current summary**: Thin callbacks passed to node-agent MCP. `onArchiveTask` checks active workflow run, then archives. `onPublishTask` just publishes.
- **Proposed combinator**: `decisionRun` (or `stagedRun`) shared with the tool and RPC publish/archive paths.
- **Input snapshot design**: Same as `TaskPublishState` / `ArchiveTaskState` from `task-transition-routing.ts`.
- **Pure core design**: Reuse `decideTaskPublish` and `decideTaskArchive`. `decideTaskArchive` should add the `runActive` check that `onArchiveTask` currently does inline.
- **Shell/effect wiring**: `boundTaskManager.archiveTask` / `publishTask`, then emit `space.task.updated`.
- **Step-by-step migration**:
  1. Make `routeArchiveTask` the canonical archive admission core and add the active-run check to it.
  2. Create `decideTaskArchive` `decisionRun`.
  3. Replace `onArchiveTask` and `archive_task` tool with the shared core.
  4. Replace `onPublishTask` with the shared `decideTaskPublish`.
- **Tests**: `packages/daemon/tests/unit/5-space/agent/task-agent-manager-*.test.ts` and `packages/daemon/tests/unit/5-space/runtime/space-agent-tools.test.ts`.
- **Risks/caveats**: `onArchiveTask` currently throws for active runs; `routeArchiveTask` already returns a `reject` for that. Ensure the error message matches.

### `packages/daemon/src/lib/space/goals/goal-automation-service.ts:onTaskCompleted`

- **Current summary**: After a task completes, checks goal active, scope, threshold, evidence count, then enqueues a `GOAL_AUTOMATION_EXECUTE` job.
- **Proposed combinator**: `decisionRun` (admission) plus shell effect.
- **Input snapshot design**:
  ```ts
  interface CompletedTaskAutomationCtx {
    task: SpaceTask | null;
    goal: SpaceGoal | null;
    scope: EvolutionScope | null;
    policy: GoalForgeAutomationPolicy;
    threshold: number | null;
    dueEvidenceCount: number;
    decision: GoalAutomationAdmissionDecision | null;
  }
  ```
- **Pure core design**: `decideCompletedTaskAutomation` with branches: `notApplicable`, `disabled`, `missingScope`, `ambiguousScope`, `belowThreshold`, `proceed`. `proceed` carries `count`.
- **Shell/effect wiring**: The `GoalAutomationService` shell calls `decideCompletedTaskAutomation`; if `proceed`, it calls `this.enqueue(...)`. Return `GoalAutomationEnqueueResult`.
- **Step-by-step migration**:
  1. Create `packages/daemon/src/lib/space/goals/goal-automation-admission-pipeline.ts`.
  2. Move the gate logic from `onTaskCompleted` into `decideCompletedTaskAutomation`.
  3. Keep the evidence selection and cursor reads in the shell as snapshot input.
  4. `onTaskCompleted` becomes: read snapshot → `decisionRun` → if `proceed`, `enqueue`.
- **Tests**: `packages/daemon/tests/unit/5-space/goal-automation-service.test.ts`.
- **Risks/caveats**: The admission table must be unit-tested independently of the job queue. The `below_threshold` branch carries `count`; ensure that is preserved in the decision payload.

### `packages/daemon/src/lib/space/goals/goal-automation-service.ts:onSelfNag`

- **Current summary**: Given a goal/schedule/scope, checks goal active, scope, cron, evidence, then enqueues a self-nag job.
- **Proposed combinator**: `decisionRun` (admission) plus shell effect.
- **Input snapshot design**: Similar to `onTaskCompleted` but with `scheduleId` and `selfNagCronExpression`.
- **Pure core design**: `decideSelfNagAutomation` with branches: `disabled`, `missingScope`, `notApplicable`, `proceed`.
- **Shell/effect wiring**: Same as `onTaskCompleted`; the shell enqueues when `proceed`.
- **Step-by-step migration**: Add `decideSelfNagAutomation` to the same `goal-automation-admission-pipeline.ts`.
- **Tests**: `packages/daemon/tests/unit/5-space/goal-automation-service.test.ts`.
- **Risks/caveats**: Review correction — `resolveScopeForGoal` falls back to the FIRST scope (`listScopes(...)[0] ?? null`); multiple scopes do NOT make it return `null`. Do not add an ambiguous-scope rejection: when no explicit `scopeId` is supplied, the first scope is used, and legacy schedules without `goalAutomationScopeId` metadata depend on that fallback. Keep validating an explicitly supplied scope against the goal and space only.

### `packages/daemon/src/lib/space/goals/goal-automation-schedule-sync.ts:syncGoalAutomationSelfNagScheduleForScope`

- **Current summary**: Lists schedules for a scope, pauses stale ones, pauses all if the goal is gone, updates an existing schedule, or creates a new one based on the policy.
- **Proposed combinator**: Direct sync `superpipe` pipeline (`.end`) inside the `db.transaction` shell (review correction: `stagedRun` is async-only; the sync SQLite transaction would commit when its Promise is returned).
- **Input snapshot design**:
  ```ts
  interface SelfNagScheduleSyncState {
    scope: EvolutionScope;
    allScopeSchedules: Schedule[];
    goal: SpaceGoal | null;
    policy: GoalForgeAutomationPolicy;
    existing: Schedule | null;
  }
  ```
- **Pure core design**: `decideSelfNagScheduleSync` with branches: `pauseAllNoGoal`, `pauseNoCron`, `update`, `create`, `noOp`. Review correction: `pauseOrphans` is NOT a decision branch — it is not mutually exclusive with `update`/`create` (the current code first pauses stale schedules from a previous goal, then continues syncing the active goal's schedule; a scope can have both). It runs as a preliminary unconditional `effect` before `decide`, so a scope with both a stale schedule and a valid current policy still reaches `update`/`create`.
- **Shell/effect wiring**: Effects call `scheduleService.pauseSchedule`, `updateSchedule`, `resumeSchedule`, `createGoalSchedule`. Review correction — when `db` is supplied, the flow composes as a direct SYNCHRONOUS `superpipe` pipeline with `.end` executed inside `db.transaction(fn)()`: `stagedRun` executes through `endAsync`, so wrapping it in the synchronous SQLite transaction would commit as soon as the Promise is returned, leaving the normal tool paths (which pass `config.db`) with orphan pauses committed without the replacement schedule. When `db` is absent the same sync pipeline runs best-effort.
- **Step-by-step migration**:
  1. Define the direct sync pipeline `selfNagScheduleSyncRun` (`superpipe` + `.end`, effect functions synchronous).
  2. Gather stage lists schedules, reads goal and policy.
  3. Effect stage `pause-orphan-schedules` pauses stale schedules unconditionally (preliminary, nonterminal).
  4. Decide stage selects the current-schedule branch and stores it in ctx
     (review correction: NO `!branchDecided` halt — a `!dep` halt exits the
     whole pipeline, so none of the guarded effects could run and an active
     goal's schedule would be left stale or absent after orphan cleanup;
     only the actual `noOp` branch halts).
  5. Guarded effect stages inspect the selected branch and execute the
     matching schedule mutation.
  6. `.end` returns `void` or `{ scheduleId }`.
- **Tests**: `packages/daemon/tests/unit/2-handlers/job-handlers/task-schedule-fire.handler.test.ts` and any goal-automation schedule tests. Add a row where a schedule mutation throws mid-flow with `db` present: no partial pause/update commits.
- **Risks/caveats**: `scheduleService` operations are not currently CAS. The optional `db` transaction is the only atomicity mechanism. If `db` is absent, the flow is best-effort. All effect stages must run synchronously inside the transaction and throw on failure; the transaction rolls back.

### `packages/daemon/src/lib/space/goals/goal-service.ts:claimOutcomeNotification`

- **Current summary**: Inside `runAtomic`, loads notification and goal, checks authorization, identity, and revision, applies optional goal update, and flips the notification status.
- **Proposed combinator**: Direct sync `superpipe` pipeline with `.end`, executed inside the existing synchronous `runAtomic` (review correction: `stagedRun` is async-only — `endAsync` — and cannot run inside `db.transaction(fn)()` without committing before the effects finish).
- **Input snapshot design**:
  ```ts
  interface ClaimOutcomeState {
    notification: SpaceGoalOutcomeNotification | null;
    goal: SpaceGoal | null;
    authorizedAgentIds: string[];
    decision: ClaimAdmissionDecision;
    appliedGoal: SpaceGoal;
  }
  ```
- **Pure core design**: Reuse the existing `decideClaimAdmission` from `claim-admission-gates.ts` as the decide stage, preceded by an already-applied gate (review correction: the current method checks `notification.status === params.dispositionStatus` BEFORE admission and returns `already_applied` after authorization and identity checks — without that gate, any non-`pending` notification is classified `deny/superseded` and an idempotent retry of a successfully applied outcome becomes an error). Halt rules (review correction): `decideClaimAdmission` ALWAYS returns a non-null decision, so a blanket `!decided` halt would exit for `admit` too and every admitted claim would no-op — halt ONLY on `deny`; `admit` and `already_applied` continue to their effect/return stages.
- **Shell/effect wiring**: Effects: `params.apply(goal)` (if `mutatesGoalState`), `outcomeNotificationRepo.updateStatus`. The shell is the `runAtomic` block; the sync pipeline runs inside it.
- **Step-by-step migration** (review correction — sync pipeline stages, not `stagedRun` steps):
  1. Replace the inline `decideClaimAdmission` call with the sync `superpipe` pipeline that wraps it.
  2. Gather stage loads notification and goal, computes `authorizedAgentIds`.
  3. Decide stage runs the already-applied gate, then `decideClaimAdmission`;
     halt only on `deny` (never a blanket `!decided` — `admit` must continue).
  4. Effect stage `apply-goal-update` (when `admit` and `mutatesGoalState`) calls `params.apply`.
  5. Effect stage `update-notification-status` calls `outcomeNotificationRepo.updateStatus` — GUARDED to `admit` only (review correction: the current method returns `already_applied` BEFORE any write; letting that branch reach this stage would re-write the status on an idempotent retry, bumping `updatedAt` and turning a successful retry into an error if the redundant write fails).
  6. `.end` returns `ClaimOutcomeNotificationResult`.
- **Tests**: `packages/daemon/tests/unit/4-space-storage/space-goal-claim.test.ts`.
- **Risks/caveats**: Review correction — `stagedRun` always executes through `endAsync` and returns a Promise, while `runAtomic` invokes the synchronous `db.transaction(fn)()` wrapper. Passing an async pipeline to that wrapper commits as soon as the Promise is returned, so the apply/status-flip effects would run outside the transaction. Use a direct synchronous `superpipe` pipeline with `.end` inside the existing `runAtomic` (effect functions stay synchronous); merely converting `runAtomic` to an async variant cannot preserve atomicity without an async-capable database transaction primitive. The `params.apply` callback may be synchronous in current usage but is typed as a plain function; ensure it is not awaited if sync.

### `packages/daemon/src/lib/space/goals/goal-service.ts:handleTaskTerminal`

- **Current summary**: Inside `runAtomic`, updates the task if needed, decides whether the new status is terminal, clears active task, records goal event, captures Forge evidence, calls goal automation, creates the next goal task if `autoTriggerNext`, and records an outcome notification.
- **Proposed combinator**: Direct sync `superpipe` pipeline with `.end`, executed inside the existing synchronous `runAtomic` (review correction: `stagedRun` is async-only — `endAsync` — and cannot run inside `db.transaction(fn)()` without committing before the effects finish).
- **Input snapshot design**:
  ```ts
  interface HandleTaskTerminalState {
    existing: SpaceTask;
    goal: SpaceGoal;
    nextStatus: SpaceTaskStatus;
    transition: { fromStatus?: SpaceTaskStatus | null; updates?: InternalUpdateSpaceTaskParams };
    terminal: boolean;
    taskAfterUpdate: SpaceTask;
    goalAfterClear: SpaceGoal;
    nextTask: SpaceTask | null;
    notification: SpaceGoalOutcomeNotification | null;
  }
  ```
- **Pure core design**: Review correction — admission uses a PLAIN terminal-status gate (the current `handleTaskTerminal` admits every terminal status, including administrative transitions like cancelling an unstarted goal task or archiving an already-terminal task); `decideReportableTerminal` from `reportable-terminal-gates.ts` returns `none` for exactly those cases, so using it as admission would halt before `clearActiveTaskIfMatches` and the remaining bookkeeping. Invoke the reportability decision only at the notification stage.
- **Shell/effect wiring**: Effects: `taskRepo.updateTask`, `goalRepo.clearActiveTaskIfMatches`, `recordGoalEvent`, `evolutionScopeService.captureCompletedTaskEvidence`, `goalAutomationService.onTaskCompleted`, `createImmediateTaskInternal`, `recordOutcomeNotification`. The `runAtomic` shell wraps the sync pipeline (a `stagedRun` here would return a Promise and commit the transaction before the effects finish).
- **Step-by-step migration** (review correction — sync pipeline stages, not `stagedRun` steps):
  1. Define the direct sync pipeline `handleTaskTerminalRun` (`superpipe` + `.end`, synchronous effect functions).
  2. Gather stage loads task and goal, computes `nextStatus`.
  3. Decide stage `is-terminal` is the plain terminal-status check (NOT
     `decideReportableTerminal`); if `false`, halt (`.end` returns early).
     The reportability decision runs later, at the notification stage.
  4. `effect` `update-task` applies `transition.updates`.
  5. `resnapshot` task.
  6. `decide` `already-notified` checks existing notifications for this `terminalGeneration`.
  7. `effect` `clear-active-task`.
  8. `effect` `record-goal-event`.
  9. `effect` `capture-evidence` (when `done`).
  10. `effect` `run-automation` (when `done`).
  11. `resnapshot` goal.
  12. `effect` `create-next-task` (when `autoTriggerNext`/`pendingNextRun`/`active`).
      Review correction round 6: this stage is ALSO best-effort — the current
      implementation catches creation failures at `goal-service.ts:445-461`
      and continues to record the outcome notification; an uncaught stage
      throw would abort and roll back the terminal bookkeeping transaction.
      Keep the local catch/log boundary.
  13. `resnapshot` goal.
  14. `effect` `record-outcome-notification`.
  15. `halt` returns `{ goal, nextTask, terminalGeneration, notification }`.
- **Tests**: `packages/daemon/tests/unit/4-space-storage/space-goal-service.test.ts` and `packages/daemon/tests/unit/5-space/runtime/goal-outcome-wake-flip.test.ts`.
- **Risks/caveats**: Review correction — Forge evidence capture (`evolutionScopeService.captureCompletedTaskEvidence`) and goal automation (`goalAutomationService.onTaskCompleted`) are BEST-EFFORT in the current code (each is wrapped in its own catch around `goal-service.ts:426-440` and failures are logged, then the flow continues to clear the active task and record the notification). Their pipeline stages must retain those local catch/log boundaries: an ordinary effect stage whose throw escapes would roll back the entire terminal transition inside `runAtomic`. This is the most complex goal effect chain. Because it runs inside `runAtomic`, the transaction provides atomicity. Review correction — `stagedRun` is async-only (`endAsync`), so it cannot run inside the synchronous `db.transaction(fn)()` wrapper without committing early (the transaction commits when the Promise is returned, and the task/goal/notification effects then land outside it, breaking `terminalGeneration` deduplication). Compose this path as a direct synchronous `superpipe` pipeline with `.end` inside the existing `runAtomic`, using the transaction-bound repo methods; an async `runAtomic` variant cannot preserve atomicity without an async-capable DB transaction primitive. Do not introduce in-flow retries.

### `packages/daemon/src/lib/space/runtime/space-runtime.ts:registerSubscription` and `validateSubscriptionTargetTask`

- **Current summary**: `registerSubscription` validates and normalizes a topic, validates the target task for dynamic subscriptions, checks an interest limit, removes an existing entry, inserts into `topicTrie`, persists to `workflowEventSubscriptionRepo`, and triggers a redispatch. `validateSubscriptionTargetTask` is a pure task-status check.
- **Proposed combinator**: Direct SYNCHRONOUS `superpipe` pipeline with `.end` for `registerSubscription` (review correction: it currently completes synchronously and production callers like `registerRunInterests` inspect `result.success` immediately while registering static interests in a loop — `stagedRun` executes through `endAsync`, which changes the contract to a Promise and adds await gaps between the interest-count snapshot and trie mutations; trie and repository operations here are synchronous, so the sync pipeline with the existing in-memory rollback preserves everything); `decisionRun` for `validateSubscriptionTargetTask` (used as the target-validation gate).
- **Input snapshot design**:
  ```ts
  interface RegisterSubscriptionState {
    workflowRunId: string;
    taskId: string;
    nodeId: string;
    agentName: string;
    topic: string;
    subscriptionKind: 'static' | 'dynamic';
    run: SpaceWorkflowRun | null;
    task: SpaceTask | null;
    displaced: WorkflowSubscriptionTarget | undefined;
    existingInterests: number;
  }
  ```
- **Pure core design**: `decideSubscriptionTarget` (or `decideSubscriptionValidation`) with branches: `invalidTopic`, `missingRun`, `invalidTask`, `limitReached`, `proceed`.
- **Shell/effect wiring**: Effects: `topicTrie.remove`, `topicTrie.insert`, `workflowEventSubscriptionRepo.upsert`, `redispatchRetainedExternalEvents`. The `compensate` on `persist-subscription` should remove the trie entry and re-insert `displaced`.
- **Step-by-step migration**:
  1. Extract `validateSubscriptionTargetTask` into `packages/daemon/src/lib/space/runtime/subscription-target-gates.ts` as `decideSubscriptionTarget`.
  2. Define the direct SYNCHRONOUS pipeline `registerSubscriptionRun`
     (`superpipe` + `.end`; review correction — NOT `stagedRun`, which would
     change the currently synchronous API to a Promise and add await gaps
     between the interest-limit snapshot and trie mutations).
  3. `snapshot` gathers run, task, displaced, existing interest count MINUS the displaced entry (review correction: the current implementation removes the exact existing entry BEFORE counting, so a replacement at capacity stays allowed; counting the displaced entry would trip `limitReached` on every re-register at the limit). Retain rollback of the displaced entry as before.
  4. `decide` runs target/topic/limit gates.
  5. Stage `remove-existing-trie-entry` removes old entry (on a later
     stage's throw, the shell's explicit in-memory rollback re-inserts it).
  6. Stage `insert-trie-entry` inserts the new one.
  7. Stage `persist-subscription` (when `dynamic`) calls
     `workflowEventSubscriptionRepo.upsert`; on throw, the shell's rollback
     removes the trie entry and re-inserts `displaced` (explicit shell
     rollback replaces `compensate` in the sync pipeline).
  8. Review correction — `redispatch` is NOT a compensable `effect` stage: because it runs after `persist-subscription`, any throw would unwind the persist compensation after the DB upsert already succeeded, leaving the subscription persisted but absent from the live trie until restart. Move `redispatchRetainedExternalEvents` to a post-success best-effort step in the shell AFTER the pipeline completes (swallow-and-log its errors; it is a delivery nudge, not a consistency write). The pipeline's last stage is the `persist-subscription` effect.
  9. `halt` returns `{ success: true }` or an error.
- **Tests**: `packages/daemon/tests/unit/5-space/runtime/space-runtime-list-subscriptions.test.ts` and `packages/daemon/tests/unit/5-space/runtime/space-runtime-workflow-subscription-persistence.test.ts`. Add a row where `redispatchRetainedExternalEvents` throws: the subscription must remain both persisted and present in the trie.
- **Risks/caveats**: `topicTrie` is in-memory shared state. The current manual rollback on repo error is exactly the in-memory compensation pattern. `workflowEventSubscriptionRepo.upsert` should be CAS-guarded or the `stagedRun` `compensate` must be able to undo the trie change. The limit check must be re-gathered between any write and the next read (the `existingInterests` snapshot already does this).

### `packages/daemon/src/lib/space/runtime/agent-message-routing-gates.ts:decideGenericAddressRouting`

- **Current summary**: Routes a parsed address to one of several actions: `deliverToCoordinator`, `deliverToSession`, `failSessionUnauthorized`, `deliverViaMessagingFacade`, `failUnsupported`, `failUnsupportedKind`, `deliverToWorker`, `failInvalidWorker`, `notFound`.
- **Proposed combinator**: `decisionRun`.
- **Input snapshot design**:
  ```ts
  interface GenericAddressRoutingCtx {
    address: ParsedAddress;
    target: string;
    spaceAgentAvailable: boolean;
    messagingFacadeAvailable: boolean;
    replyToSessionId: string | null;
    workflowRunId: string;
    decision: GenericAddressRoutingDecision | null;
  }
  ```
- **Pure core design**: `decideGenericAddressRouting` as a `decisionRun` with gates in the same order as the current if-cascade. The `decodeURIComponent` catch becomes a `failInvalidWorker` gate.
- **Shell/effect wiring**: None; the caller (`AgentMessageRouter.deliverGenericMessage`) interprets the decision. Keep the function pure.
- **Step-by-step migration**:
  1. Create `packages/daemon/src/lib/space/runtime/generic-address-routing-pipeline.ts`.
  2. Define `decisionRun('generic-address-routing', [...])`.
  3. Replace the if-cascade with ordered gates.
  4. Update `agent-message-router.ts` to call the new function.
- **Tests**: `packages/daemon/tests/unit/5-space/runtime/agent-message-routing-pipeline.test.ts` and `packages/daemon/tests/unit/5-space/agent/agent-message-router.test.ts`.
- **Risks/caveats**: This is called once per target in `deliverGenericMessage`. `decisionRun` adds ~2 µs per call, negligible compared to the downstream delivery. The `notFound` branch currently falls through; ensure the `decisionRun` terminal fallback is `notFound` with `target`.

### `packages/daemon/src/lib/space/runtime/agent-message-routing-gates.ts:resolveNodeAgentTargets`

- **Current summary**: Resolves a target string or array against the declared channel topology, permitted targets, peer agents, node groups, and authorization.
- **Proposed combinator**: `decisionRun`.
- **Input snapshot design**:
  ```ts
  interface ResolveNodeAgentTargetsCtx {
    target: string | string[];
    fromAgentName: string;
    fromNodeName: string;
    peerAgentNames: string[];
    nodeGroups?: Record<string, string[]>;
    declaredAgentNames: Set<string> | string[];
    permittedTargets: string[];
    spaceAgentAvailable: boolean;
    canSend: (fromNode: string, toNode: string) => boolean;
    targetAgentNames: string[];
    decision: ResolveNodeAgentTargetsOutcome | null;
  }
  ```
  Review correction: `targetAgentNames` is an explicit side field. The
  current resolver first computes the resolved names and THEN applies the
  shared `canSend` authorization to every resolved target — authorization
  comes after resolution, so resolution must be nonterminal.
- **Pure core design**: A direct `superpipe` pipeline (not a plain `decisionRun`), LINEAR with self-guarding stages and NO `!dep` halts between resolution stages (review correction round 4: `!hasTargets` after each resolution stage halts the WHOLE run once a known target is found, so `unauthorized`/`resolved` never execute and the shared `canSend` check is still bypassed). The resolution stages (`starPermitted`, `arrayTarget`, `spaceAgentTarget`, `peerTarget`, `nodeGroupTarget`, `declaredTarget`, `topologyTarget`) are nonterminal self-guarding no-ops once `targetAgentNames` is populated (first match wins, later stages decline to overwrite). Only the terminal stages set `decision`, in order: `noPermittedTargets` (review correction: `target === '*'` with an empty `permittedTargets` list is a DISTINCT public outcome with its own topology-specific explanation — it must not collapse into `unknownTarget`), `unknownTarget` (no resolution matched), `unauthorized` (`canSend` fails for any resolved target), `resolved` (carries the authorized `targetAgentNames`). Terminal stages match only when `decision === null`.
- **Shell/effect wiring**: None; the result is consumed by `decideAgentMessageRouting` in `agent-message-routing-pipeline.ts`.
- **Step-by-step migration**:
  1. Create `packages/daemon/src/lib/space/runtime/node-agent-target-resolution-pipeline.ts`.
  2. Replace `resolveNodeAgentTargets` with `runNodeAgentTargetResolution(input).decision`.
  3. Update `agent-message-routing-pipeline.ts` to import the new pipeline.
- **Tests**: `packages/daemon/tests/unit/5-space/runtime/agent-message-routing-gates.test.ts`.
- **Risks/caveats**: The current `resolveNodeAgentTargets` is called in `agent-message-router.ts` and in tests. Change the export name to `decideNodeAgentTargets` and keep a deprecated re-export if needed for a transitional phase. The `decision` union should remain `ResolveNodeAgentTargetsOutcome`.

### `packages/daemon/src/lib/space/runtime/activation-routing.ts:decideActivationRouting`

- **Current summary**: Given existing execution facts and workflow resolvability, decides whether to reuse, reset, reject, spawn, or return empty.
- **Proposed combinator**: `decisionRun`.
- **Input snapshot design**:
  ```ts
  interface ActivationRoutingCtx {
    existingExecution: ActivationExistingExecutionFacts | null;
    workflowNodeId?: string;
    agentDeclaredOnNode: boolean;
    taskRunWorkflowResolvable: boolean;
    executionResolvable: boolean;
    decision: ActivationRoutingDecision | null;
  }
  ```
- **Pure core design**: `decideActivationRouting` with gates: `reuseInProgressOrBlocked`, `rejectUndeclared`, `returnEmpty`, `spawn`.
- **Shell/effect wiring**: The caller (`TaskAgentManager` activation logic) interprets the decision and executes the chosen action.
- **Step-by-step migration**:
  1. Create `packages/daemon/src/lib/space/runtime/activation-routing-pipeline.ts`.
  2. Define `decisionRun('activation-routing', [...])`.
  3. Update `activation-routing.ts` to export the new `decideActivationRouting`.
- **Tests**: `packages/daemon/tests/unit/5-space/runtime/activation-routing.test.ts`.
- **Risks/caveats**: The current `existing` fact object is normalized to `null`. Preserve that normalization in the `decisionRun` input adapter.

### `packages/daemon/src/lib/space/runtime/last-message-classifier.ts:classifyLastMessageForIdleAgent`

- **Current summary**: Classifies the last SDK message for an idle agent as terminal or not, with a reason. Handles `result`, `assistant`, errors, content blocks, and `end_turn`.
- **Proposed combinator**: `decisionRun`.
- **Input snapshot design**:
  ```ts
  interface LastMessageClassificationCtx {
    message: SDKMessage | null | undefined;
    decision: LastMessageClassification | null;
  }
  ```
- **Pure core design**: `decideLastMessageForIdleAgent` with gates: `missingMessage`, `hollowResultMessage` (review correction: `isHollowTaskNotificationResult` is checked BEFORE the terminal result classification — zero-token, empty task-notification wakeups return NONTERMINAL so the follow-up turn can arrive; a generic result arm would mark an idle agent finished prematurely; keep the existing error/text/usage exceptions), `resultMessage`, `nonAssistantMessage`, `assistantError`, `contentBlockClassification`, `endTurn`, `defaultNotTerminal`. The content-block gate can be a single helper that scans the blocks and returns the appropriate `LastMessageClassification`.
- **Shell/effect wiring**: The caller (`SpaceRuntime` idle detection) consumes `LastMessageClassification` and acts on `terminal`.
- **Step-by-step migration**:
  1. Create `packages/daemon/src/lib/space/runtime/last-message-classifier-pipeline.ts`.
  2. Define `decisionRun('last-message-classifier', [...])`.
  3. Replace the inline function with the `decisionRun` call.
- **Tests**: `packages/daemon/tests/unit/4-space-storage/storage/hidden-subtype-idle-detection.test.ts` and `packages/daemon/tests/unit/5-space/runtime/last-message-classifier.test.ts` if it exists.
- **Risks/caveats**: The classifier is called when the runtime checks for idle agents. Keep it synchronous (`decisionRun`) to avoid microtask interleaving with the tick. The content-block scan is a small loop; it can live inside one gate.

---

## Suggested migration order

1. **Phase 0 — Pure decisionRun extractions (no effects)**
   - `last-message-classifier.ts`
   - `activation-routing.ts`
   - `agent-message-routing-gates.ts` (`decideGenericAddressRouting` and `resolveNodeAgentTargets`)
   - `validateWorkflowModelOverrides`
   - `goal-automation-admission-pipeline.ts` (`onTaskCompleted`, `onSelfNag`)
   - `task-target-resolution-pipeline.ts` (for `get_task` / `get_task_detail` / `list_task_members`)

2. **Phase 1 — Shared task mutation decision/pipeline modules**
   - Extract `task-update-routing-pipeline.ts`, `task-publish-pipeline.ts`, `task-archive-pipeline.ts`.
   - Unify `spaceTask.update`, `spaceTask.publish`, `spaceTask.approvePendingCompletion`, and their tool counterparts on the new shared cores.
   - Update `space-tool-pipeline.ts` to consume the shared `decideTaskUpdate`.

3. **Phase 2 — Staged effect flows with clear atomicity**
   - `approve-pending-completion-pipeline.ts`
   - `review-goal-outcome` / `claimOutcomeNotification`
   - `registerSubscription`
   - `syncGoalAutomationSelfNagScheduleForScope`

4. **Phase 3 — Heavyweight staged flows**
   - `post-approval-router.ts:route`
   - `deliverDirectSteerUnderCoordination`
   - `handleTaskTerminal`
   - `send_message_to_task`
   - `foldDeferredExternalEventsAtFlush` and `foldDeferredExternalEventOverflow`

---

## Open questions

1. ~~**Async `stagedRun` inside synchronous `runAtomic`**~~ Resolved by review: keep both as sync `superpipe` pipelines with `.end` inside the existing `runAtomic`. Converting `runAtomic` to an async variant is OFF the table — `stagedRun` returns a Promise, the SQLite transaction wrapper is synchronous, and either option commits before the task/goal/notification writes finish, breaking terminal-generation deduplication.
2. ~~**Goal-service transaction boundaries**~~ Resolved by review: `handleTaskTerminal` never becomes a `stagedRun` outside the transaction. The sync pipeline's effect stages run inside `runAtomic` and use the transaction-bound repo methods; atomicity comes from the transaction, not from the pipeline.
3. **Post-approval router atomicity and CAS**: The current post-approval path uses blind `taskRepo.updateTask`. Should we introduce a `claimPostApprovalDispatch` reservation/CAS in `SpaceTaskRepository` before migrating to `stagedRun`?
4. **Deferred digest atomic primitive**: Should `foldDeferredExternalEventsAtFlush` and `foldDeferredExternalEventOverflow` be backed by a single `foldDeferredRows` repository primitive that supersedes and inserts under one transaction, rather than a multi-effect `stagedRun`?
5. **Unification of tool and RPC shells**: Several task flows (`publish`, `approve`, `archive`, `update`) are duplicated between `space-agent-tools.ts`, `node-agent-tools.ts`, `space-task-handlers.ts`, and `task-agent-manager.ts`. Do we create a `space-task-operations.ts` module with shared shells, or keep the pipeline in one place and call it from each handler?
6. **Hot-path `decideGenericAddressRouting`**: It is called once per target in a `for` loop. Is this loop small enough that the `decisionRun` overhead is acceptable? If targets can be large, consider a raw `superpipe` transform or keep it inline.
7. **Mid-turn steer resnapshot timing**: `deliverDirectSteerUnderCoordination` has a critical resnapshot between passenger save and steer save. How do we represent the `discardPassengerCopy` compensation in `stagedRun` so that it runs on any later stage failure, not just the steer save?
