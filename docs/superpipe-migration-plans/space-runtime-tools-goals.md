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
| `packages/daemon/src/lib/space/tools/space-agent-tools.ts:send_message_to_task` | Large if-cascade with target parse, handle resolution, worker activation, inject/queue | ONE `deliver-task-message` pipeline — target-admission and delivery-mode gates as direct inline stages (review correction: no nested `decisionRun`s) | Mixed read/decide/effect; activation is an awaitable effect that must be followed by resnapshot and conditional inject/queue. |
| `packages/daemon/src/lib/space/tools/space-agent-tools.ts:approve_pending_completion` | Validate caller, snapshot task, branch (approve/reject), effect status change + post-approval dispatch | `stagedRun` (shared with `spaceTask.approvePendingCompletion`) | Tool and RPC share the same state machine. The approve branch is an effect followed by resnapshot and a blocked-reason effect on dispatch failure. |
| `packages/daemon/src/lib/space/tools/space-agent-tools.ts:review_goal_outcome` | Discovery or claim path; claim uses `claimOutcomeNotification` | Discovery is a snapshot stage; claim calls `goalService.claimOutcomeNotification` as ONE effect (its inner sync pipeline stays atomic inside `runAtomic`) → halt with its result. |
| `packages/daemon/src/lib/space/tools/space-agent-tools.ts:get_task_detail` | Identifier/lookup/space check/return | `decisionRun` | Pure target-resolution and return; no effects. |
| `packages/daemon/src/lib/space/tools/space-agent-tools.ts:list_task_members` | Identifier/lookup/space check/workflow run check/list executions | ONE complete `list-task-members` pipeline — shared target-resolution logic, the workflow-run branch, and the execution read as its stages (review correction round 23) | The lookup is part of the tool operation, not a shell follow-on. Shares the target-resolution core with `get_task_detail`. |
| `packages/daemon/src/lib/space/tools/node-agent-tools.ts:get_task` | Same pattern as `get_task_detail` | `decisionRun` (shared `task-target-resolution` core) | Node-agent and Space-agent lookups should converge on one `decisionRun`. |
| `packages/daemon/src/lib/rpc-handlers/space-task-handlers.ts:validateWorkflowModelOverrides` | Validation rules as ordinary helpers / direct early stages of the single `spaceTask.update` RPC pipeline (review correction round 22) | No effects; returns normalized map or reject. |
| `packages/daemon/src/lib/rpc-handlers/space-task-handlers.ts:spaceTask.update` | Large if-cascade around status transitions, dependency block, override validation | ONE direct RPC pipeline — override validation, `routeTaskUpdate` (shared plain helper or inline gates), and the effect flow composed together (review correction round 22: no `routeTaskUpdate` `decisionRun`, no imported tool decision runner before a staged shell) | Single composition for the whole update operation; parity with the tool path. |
| `packages/daemon/src/lib/rpc-handlers/space-task-handlers.ts:spaceTask.approvePendingCompletion` | Same semantics as `approve_pending_completion` tool | `stagedRun` shared core | Unify with the tool path. |
| `packages/daemon/src/lib/rpc-handlers/space-task-handlers.ts:spaceTask.publish` | Same semantics as tool `publish_task` and `onPublishTask` | ONE direct mixed pipeline per caller operation (admission + `publishTask` effect + event emission) | `routePublishTask` already exists as shared plain logic; unification is the main win. |
| `packages/daemon/src/lib/space/goals/goal-automation-service.ts:onTaskCompleted` | Snapshot task/goal/scope/evidence, threshold check, optional job enqueue | One mixed decision/effect pipeline — admission gates plus the `enqueue` effect stage (review correction: an admission-only pipeline with shell interpretation preserves the hand-rolled outer split) | The job queue push is a stage of the same pipeline. |
| `packages/daemon/src/lib/space/goals/goal-automation-service.ts:onSelfNag` | Snapshot scope/goal/policy/cursor/evidence, decide whether to enqueue self-nag | One mixed decision/effect pipeline — admission gates plus the `enqueue` effect stage | Same pattern as `onTaskCompleted`. |
| `packages/daemon/src/lib/space/goals/goal-automation-schedule-sync.ts:syncGoalAutomationSelfNagScheduleForScope` | List schedules, pause/update/create schedule records | Direct sync `superpipe` (`.end`) inside the optional `db` transaction (review correction: `stagedRun` is async-only) | Effects on `ScheduleService`; must commit atomically with the sync transaction. |
| `packages/daemon/src/lib/space/goals/goal-service.ts:claimOutcomeNotification` | Inside `runAtomic`; snapshot notification/goal, `decideClaimAdmission`, `apply`, update status | Direct sync `superpipe` (`.end`) inside `runAtomic` — `stagedRun` is async-only and would commit early | Atomic claim; effect stage is the goal update and notification status flip. |
| `packages/daemon/src/lib/space/goals/goal-service.ts:handleTaskTerminal` | Inside `runAtomic`; decide reportable terminal, update task, clear active, next task, record notification | Direct sync `superpipe` (`.end`) inside `runAtomic` — `stagedRun` is async-only and would commit early | Most complex goal effect chain; needs gather/decide/effect stages. |
| `packages/daemon/src/lib/space/runtime/space-runtime.ts:registerSubscription` | Validate topic, validate task, check limit, trie insert, repo upsert, redispatch | Direct sync `superpipe` (`.end`) — review correction: `registerSubscription` completes synchronously and callers like `registerRunInterests` inspect `result.success` immediately in a loop; `stagedRun` (`endAsync`) would change that contract to a Promise and add await gaps between the interest-count snapshot and trie mutations | In-memory rollback on repo failure stays; redispatch stays the pipeline's final best-effort effect with an in-stage catch (round 5). |
| `packages/daemon/src/lib/space/runtime/space-runtime.ts:validateSubscriptionTargetTask` | Pure check: task exists, belongs to run, not terminal | Ordinary pure helper or direct branches of the synchronous registration pipeline (review correction: not a separate `decisionRun`, and no `stagedRun` — see the corrected `registerSubscription` design) | Trivial target gate. |
| `packages/daemon/src/lib/space/runtime/agent-message-routing-gates.ts:decideGenericAddressRouting` | Pure multi-branch routing by `ParsedAddress` kind | Ordinary pure helper or direct gates of the message-routing operation (review correction: no standalone runner — it runs once per target after `send` already entered message routing) | Precedence stays testable via direct helper unit tests. |
| `packages/daemon/src/lib/space/runtime/agent-message-routing-gates.ts:resolveNodeAgentTargets` | Pure multi-branch target resolution | Stays an ORDINARY PURE HELPER (restructured into named linear gates) consumed by `agent-message-router.ts` until the COMPLETE `deliverMessage` operation migrates as one pipeline in a future plan — no standalone runner, and no folding into the current admission-only `decisionRun` (review correction PR #2983 round 2) | Wiring its stages into `agent-message-routing-pipeline.ts` today would still leave `deliverMessage`'s channel/activation/inject/queue effects imperative behind the runner — a split composition. |
| `packages/daemon/src/lib/space/runtime/activation-routing.ts:decideActivationRouting` | Pure multi-branch decision | Classification stages/plain helpers of the ONE complete `activateTargetSessionsForMessage` mixed pipeline (reset/activation/resnapshot/spawn effects included) | A standalone runner would execute three nested pipelines per activation while leaving the imperative cascade. |
| `packages/daemon/src/lib/space/runtime/last-message-classifier.ts:classifyLastMessageForIdleAgent` | Pure multi-branch classification of last SDK message | Ordinary pure helper or gates composed into each complete idle-detection/recovery caller operation (review correction round 23) | The three SpaceRuntime callers act on the classification; a standalone nested pipeline migrates no complete path. |
| `packages/daemon/src/lib/space/runtime/task-agent-manager.ts:onArchiveTask` | Active-run guard, archive, emit | ONE complete mixed pipeline (routing + `archiveTask` effect + event emission), sharing `routeArchiveTask` as plain logic (review correction round 22) | Not a shared admission runner; the callback operation composes whole. |
| `packages/daemon/src/lib/space/runtime/task-agent-manager.ts:onPublishTask` | Publish, emit | ONE complete mixed pipeline (routing + `publishTask` effect + event emission), sharing `routePublishTask` as plain logic (review correction round 22) | Same as above. |

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

  Review correction (PR #2983): this site has ALREADY been migrated — `deliverDirectSteerUnderCoordination` is now a thin wrapper around `runDirectSteerFlush` in `direct-steer-flush-pipeline.ts` (a direct raw `superpipe` pipeline with an outcome-halt dep), with dedicated pipeline and manager tests. The long hand-rolled cascade this section described no longer exists, and a `stagedRun` conversion is NOT required (the landed raw pipeline already satisfies ADR 0004 and the one-direct-pipeline rule; converting it would churn a green path for no composition gain). The remaining `DirectSteerFlushOutcome` contract stays exactly as landed.
- **Proposed combinator**: none — keep the landed `direct-steer-flush-pipeline.ts` as-is; no second version is ever added.
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
- **Pure core design**: The admission branches are DIRECT decide stages of this staged flow (review correction: no separately executed `decideDirectSteerFlush` `decisionRun` — describe only the inline gate group):
  - `sessionMissing`
  - `sessionNotProcessing`
  - `parentTaskLimited`
  - `noDeferredRows`
  - `noSteerEssences`
  - `proceed`
- **Shell/effect wiring**: The `TaskAgentManager` calls `runDirectSteerFlush({ sessionId, bufferedEntries })`. Effects call `db.getUserMessagesByStatus`, `db.saveUserMessage`, `deliverMessage`, `db.updateMessageStatus`, `publishMessageStatusChanged`. `passengerDbId` is a shared mutable box, similar to `SpawnAttemptBox` in `spawn-flow.ts`, because it must be visible to later effect/resnapshot stages. The saved steer row gets its OWN external mutable box for the same reason (review correction round 22: a `stagedRun` effect cannot return the row or persist a `steerDbId` assignment on its copied view).
- **Step-by-step migration**:
  1. Superseded (review correction PR #2983): steps 2-13 below predate the
     landed `direct-steer-flush-pipeline.ts` and are KEPT FOR HISTORY ONLY —
     do NOT implement them; they would add a second version of an operation
     that is already wired. The only permissible follow-up is a pins-only
     slice if a coverage gap in the existing suites is demonstrated.
  2. First `snapshot` gathers session, processing status, parent-task limited, deferred rows, and partitions entries.
  3. `decide` stages express the admission branches DIRECTLY (review
     correction: no separately executed `decideDirectSteerFlush` `decisionRun`
     inside this staged flow — that splits the business path across two
     composition boundaries; the branches become this pipeline's own decide
     stages).
  4. `effect` `save-passenger-copy` (when `proceed`) writes the passenger row and publishes `deferred`. Register `compensate` that calls `discardPassengerCopy`.
  5. `resnapshot` re-reads session and parent-task state.
  6. Second `decide` aborts if the session left processing or became
     limited. Review correction: this branch must run a GUARDED CLEANUP
     EFFECT (`consume-passenger-copy`, the same status update the current
     implementation performs in this race, INCLUDING the
     `messages.statusChanged` publication for the consumed row — review
     correction: `discardPassengerCopy` publishes that event today and the
     success-path publication in step 12 is never reached on this branch;
     without it LiveQuery subscribers keep displaying the discarded
     passenger as `deferred` until a later refresh) BEFORE halting — `stagedRun`
     unwinds compensations only on errors or `superseded`, not on a
     successful halt, so the registered `discardPassengerCopy` compensation
     would NOT run here and the copied row would remain `deferred` alongside
     its original source rows.
  7. `effect` `save-steer-row` saves the steer message and stores the saved
     row (with its database ID) in the steer-row external mutable box.
  8. `resnapshot` copies the saved steer row out of the external box into
     ctx — the enqueue-failure handling and the status publications consume
     the SAVED row, not the pre-save draft (review correction round 22).
  9. `effect` `enqueue-steer-delivery` calls `deliverMessage`. On throw, mark
     the steer row `failed`, PUBLISH its `messages.statusChanged` transition
     (review correction round 15: the current code publishes the failed row;
     step 12's publications are success-only and never reached here, so
     without it LiveQuery/runtime subscribers will not observe the failed
     row until a refresh), and trigger the passenger compensation.
  10. `effect` `consume-source-rows` updates source row statuses.
  11. `effect` `record-steer-metrics` calls `recordDirectSteerEnqueued()` and
      `recordDirectSteerEnqueuedClass(...)` for every steered class (review
      correction: these counters feed external-event queue health reporting
      and are asserted by the existing direct-steer suite; omitting them
      makes migrated deliveries disappear from telemetry).
  12. `effect` `publish-status-transitions` publishes the steer row's
      `enqueued` status and the `messages.statusChanged` event marking all
      source rows `consumed` (review correction: without these publications
      LiveQuery/runtime subscribers keep showing the source rows as
      `deferred` and miss the enqueued steer until a later refresh).
  13. `halt` returns `{ enqueued: true, eventCount }`.
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
  5. `effect` `save-fold-row` calls `saveFoldRowIdempotently` with deterministic
     UUID and stores its return via an EXTERNAL MUTABLE BOX (a
     `SpawnAttemptBox`-style holder owned by the shell) ALLOCATED PER
     INVOCATION — created inside the exported per-call shell and captured by
     that invocation, NEVER at module/runner scope (review correction
     PR #2983 round 3: a reusable `stagedRun` runner shares a module-scope
     box, so two concurrent query flushes for different sessions overwrite
     it between save and resnapshot and one session receives the other's
     digest row and database ID — same discipline as the overflow fold's
     envelope box), followed by a
     `resnapshot` stage that provides `saved` to later stages and the halt
     (review correction round 21: `stagedRun` invokes effects with
     `stripUnwind(view)` — a shallow copy — and merges only `$unwind`, so
     assigning `view.saved`/`state.saved` from inside the effect is
     discarded; `stagedRun` effects may also return only
     `void`/`won`/`superseded` (`staged-run.ts:405-412`). Apply the same
     external-box fix to the overflow fold's saved envelope). If this fails, the superseded stale folds are already gone; this is
     fine because the source rows are still `deferred` and the next flush will
     recompute. However, for true atomicity consider a single `foldDigest` repo
     primitive.
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
  4. `effect` `save-overflow-envelope` saves the fold row idempotently and
     stores its return (`dbId` + UUID-adjusted message) in an EXTERNAL
     MUTABLE BOX declared OUTSIDE the run, followed by a `resnapshot` stage
     that copies the saved envelope back into ctx (review correction rounds
     20/22: `stagedRun` effect stages may return only `void`/`won`/`superseded`
     (`staged-run.ts:405-412`) AND receive a shallow-copied view
     (`stripUnwind(view)`), so both a returned object and an assignment on
     the shared `OverflowFoldState` are discarded — the same
     external-box-plus-resnapshot design as the flush fold; without it the
     halt cannot build `DeferredEventOverflowFoldResult`).
  5. `effect` `mark-overflow-superseded` marks the overflow rows.
  6. `resnapshot` reads the saved envelope out of the external box into ctx.
  7. `halt` returns the result.
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
- **Pure core design**: Routing branches are DIRECT decide stages of this staged flow (review correction: do not extract `decidePostApprovalRoute` as a separate `decisionRun`) with branches: `notApproved`, `noRoutes`, `alreadyRouted`, `missingWorkflow`, `emptyInstructions`, `proceed`. Review correction: `multiRoutes` is NOT a decision branch — the current router WARNS and then continues with the FIRST route; a terminal `multiRoutes` decision would halt the pipeline before `proceed`. Record it as a nonterminal side annotation (`warnings` array) stamped before the decide stage, and `proceed` carries `routes[0]`. Review correction PR #2983 round 5: the annotation is CONSUMED, not just stored — a guarded logging effect before `reserve-dispatch` emits every accumulated warning (the current router's multi-route warning), so the migrated path never silently ignores extra dispatchable routes.
- **Shell/effect wiring**: The `PostApprovalRouter` shell calls `stagedRun('post-approval-route', ...)` with `deps`. Effects call `resolveCompletionOutcome`, `taskRepo.updateTask`, `goalService.handleTaskTerminal`, `evolutionScopeService.captureCompletedTaskEvidence`, `spawner.spawnPostApprovalSubSession`, `clearPendingCompletionState`. The final `halt` returns `PostApprovalRouteResult`.
- **Step-by-step migration**:
  1. `snapshot` gathers task (fresh), workflow, routes, liveness.
  2. `decide` stages express the routing branches DIRECTLY (review
     correction: do not extract and run a separate `decidePostApprovalRoute`
     runner from this staged flow — a second composition boundary for the
     same dispatch operation; the branches are this pipeline's decide
     stages).
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
     `status = 'approved'` AND `postApprovalSessionId` is either NULL, the
     EXACT DEAD session ID observed by this snapshot's liveness probe, or
     backed by an EXPIRED reservation token —
     review correction: when a previous dispatch's session is present but
     dead, the current router deliberately falls through and spawns a
     replacement overwriting the stale ID; requiring `IS NULL` alone would
     make every such retry lose the CAS forever, so the claim atomically
     clear-and-claims the stale ID. Review correction PR #2983 round 3: a
     process death between this reservation and the spawn/release leaves a
     durable token no compensation ever releases, so an expired token is
     likewise atomically takeable — only a LIVE token blocks. Add a
     dead-session replacement test and an expired-token takeover test) that stamps a
     reservation (dispatch claim) BEFORE any session is spawned (review
     correction — resnapshot-after-spawn cannot prevent concurrent dispatch:
     two callers can both pass admission, spawn separate sessions, and only
     then discover one task update lost). Its `compensate` releases the
     reservation ONLY while no session has been spawned — and because
     `stagedRun` invokes the compensation with the view captured when
     `reserve-dispatch` completed (BEFORE the spawn, so its captured
     `spawnedSessionId` is permanently unset), the guard must consult the
     EXTERNAL spawn box and the verified-termination result, never its
     captured stage view (review correction round 23: a view-captured guard
     releases the claim even while the spawned session is live or its
     termination is unverified, letting a retry spawn a second session).
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
     NON-releasable; failure cleanup owns the session, not the claim). The
     spawn effect writes the spawned session ID and start time into an
     EXTERNAL MUTABLE BOX (SpawnAttemptBox-style) — the effect view is a
     shallow copy, so assigning `spawnedSessionId` on the shared state would
     be discarded and `record-dispatched-session` would record a null ID;
     the step-8 compensate reads the box DIRECTLY so it can terminate the
     session even when the failure precedes the resnapshot.
  9. `resnapshot` copies the spawned session ID and start time from the
     external box into ctx (`spawnedSessionId`/`startedAt`) before the
     dispatch record is written.
  10. `effect` `record-dispatched-session` converts the reservation into the
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
  11. `halt` returns `spawn` result.
- **Tests**: `packages/daemon/tests/unit/5-space/runtime/post-approval-router.test.ts` and `packages/daemon/tests/unit/5-space/runtime/post-approval-routing-integration.test.ts`. Add a `stagedRun` contract test that verifies each branch, the reservation CAS (including the concurrent-caller race: second caller halts at `reserve-dispatch` and no session is spawned), the spawn compensation path, AND the round-4 row: `record-dispatched-session` throwing terminates this caller's spawned session and then CONDITIONALLY RELEASES the claim after verified termination (task becomes dispatchable again); the claim is retained ONLY when termination cannot be confirmed — never left durably held with no live session, which would block every retry at `reserve-dispatch`.
- **Risks/caveats**: This is the most effect-heavy site. The current code does not use CAS; concurrent spawns can overwrite the task — hence the reservation-before-spawn step above; without it, a conditional `record-dispatched-session` alone protects the row but leaves the losing spawned session orphaned and active. The compensations are asymmetric by design: claim-release only pre-spawn, session-termination only post-spawn. `goalService.handleTaskTerminal` must remain inside the same transaction as the task update if possible; otherwise the task could be `done` without the goal seeing it.

### `packages/daemon/src/lib/space/tools/space-agent-tools.ts:send_message_to_task`

- **Current summary**: Resolves a task, validates it, resolves a target (`node_id` or `target`), handles long-horizon handles, worker targets, and session targets, and either injects into a live session, activates the node and re-injects, or queues a pending message.
- **Proposed combinator**: ONE direct mixed pipeline `deliver-task-message` (review correction: target-admission and delivery-mode gates are direct stages — no nested `decisionRun`s).
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
- **Pure core design**: ONE direct pipeline `deliver-task-message`
  (review correction: a `stagedRun` containing two separately executed
  `decisionRun`s splits this delivery business path across three composition
  boundaries). Its gate groups run inline: the target-admission gates
  (`task_id`/`task_number`, space, archived, the DEPRECATED `task-agent`
  target rejection — `target`/`node_id === 'task-agent'` returns the exact
  `Target "task-agent" is no longer supported. Use a worker target or
  node_id.` error at its current precedence, after the space/archived gates
  and before target presence/resolution — review correction PR #2983
  round 5, target presence, workflow run)
  followed by the delivery-mode gates (`injectLive`, `activateAndInject`,
  `queue`, `deliverLongTerm`), self-guarding so first match wins.
- **Shell/effect wiring** (review correction): ON THE NODE-EXECUTION DELIVERY
  BRANCHES ONLY — after the node-resolution gates and before the first of
  `injectLive`, activation/reinject, and `queue`, an effect records
  `replyRoutingRegistry.set(task.id, mySessionId, resolved.agentName)` — the
  node-agent router later reads that exact task/agent entry to send the
  worker's reply back to the originating session; omitting it routes replies
  to the default Space destination. Review correction PR #2983 round 2: this effect
  must NOT run on the `deliverLongTerm` arm — the long-term `@handle`/`@role`
  path returns through `SpaceDeliveryFacade.routeMessage` BEFORE any
  `NodeExecution` is assigned (`resolved` is null there), and its replies
  ride the message envelope's `replyToSessionId`/`replyTargetHandle` fields
  instead of the registry, so a `resolved.agentName` dereference there is a
  null access (or a bogus worker route). Pin it with a reply-routing parity
  test covering the node arms AND the long-term arm's registry absence.
  Other effects:
  `taskRepo.getTask`, `taskRepo.getTaskByNumber`, `nodeExecutionRepo.listByWorkflowRun`, `workflowRunRepo.getRun`, `resolveHandleForTaskRouting`, `translateTaskMessageTarget`, `activateNode`, `taskAgentManager.injectSubSessionMessage`, `pendingMessageQueue.enqueue`. `auditing` and `jsonResult` mapping stay in the tool shell.
- **Step-by-step migration**:
  1. Target-resolution/admission gates become DIRECT stages of the single `deliver-task-message` pipeline (review correction: no separate `decideTaskMessageTarget` runner).
  2. The target parse and execution resolution run in the pipeline's snapshot stages.
  3. Delivery-mode gates are DIRECT decide stages of the same pipeline (no second `decisionRun`).
  4. Guarded `effect` branches:
     - `deliverToSpaceAgent`: an AVAILABILITY GATE first (review correction
       PR #2983 round 4: an `@handle`/`@role` target with no `messageResolver`
       or `longTermAgentDelivery` returns the specific
       `long_term_agent_messaging_unavailable` failure today — audited
       `failed`, no facade call, never a dereference of a missing
       dependency), then `SpaceDeliveryFacade.routeMessage`.
     - `injectLive`: `taskAgentManager.injectSubSessionMessage`. Review
       correction: an `injectLive` THROW on a stale live session is NOT a
       pipeline failure — the current tool catches it
       (`space-agent-tools.ts:2674-2710`) and falls through `activateNode` →
       resnapshot → reinject. Model it as an `inject-failed` branch (or an
       in-stage catch that diverts) so the flow continues into activation;
       pin it with a stale-live-session test.
     - `activate`: an AVAILABILITY GATE first (review correction PR #2983
       round 3: when the resolved node has no live session and `activateNode`
       is not configured, the current tool returns the specific
       `activation_callback_missing` failure — `Node "<agent>" has no live
       session and no activation callback is configured.` — without
       attempting activation or queueing; the pipeline models this as a gate
       branch with that exact response, never a call into an absent
       dependency), then `activateNode` — with an explicit CAUGHT-FAILURE branch
       (review correction: when `activateNode` throws, or the refreshed
       session injection throws, the current tool catches the error, audits
       it, and returns a specific `{ success: false, error: ... }` result; an
       ordinary effect failure would terminate the run with an error outcome
       before the final tool-result mapping).
     - `resnapshot` execution after activation.
     - `injectAfterActivation`: re-inject.
     - `queue`: GUARDED — when activation produced no session AND no
       `pendingMessageQueue` is configured, the current tool still returns
       SUCCESS with `queued: false` and the retry message `Node "<agent>"
       was activated but does not yet have a live session; the message was
       not queued because no pending message queue is configured. Retry
       after the node starts.` (review correction PR #2983 round 4: the
       queue stage is an OPTIONAL dependency with its own non-throwing
       fallback shape, never a required effect or an error when absent);
       otherwise `pendingMessageQueue.enqueue`.
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
- **Pure core design**: Authorization (`unauthorized`), task-state (`notFound`, `spaceMismatch`, `notPending`, `notReview`), and approve/reject branches are DIRECT decide stages of the shared `approve-pending-completion` pipeline (review correction: delegating them to a separately composed `decideApprovePendingCompletion` runner splits one approval/rejection operation across two pipelines), so the subsequent status, dispatch, and blocked-reason effect stages remain part of the same composition.
- **Shell/effect wiring**:
  - Tool shell: validates `callerRole === 'coordinator' | 'legacy_task_agent'`, sets `callerMayApprove`, runs the pipeline, maps to `jsonResult`.
  - RPC shell: sets `callerMayApprove = true`, runs the pipeline, returns the final task.
  - Effects: `taskManager.setTaskStatus` (`approved` or `in_progress`), `runtime.dispatchPostApproval`, `taskManager.updateTask` (blocked reason or approval reason), `taskRepo.getTask` (resnapshot), and the final `space.task.updated` publication stage (review correction rounds 22/23 — see step 9, ordered before the halt).
- **Step-by-step migration**:
  1. Extract the function into `packages/daemon/src/lib/space/runtime/approve-pending-completion-pipeline.ts`.
  2. `snapshot` loads task.
  3. `decide` admission.
  4. Guarded `effect` `set-approved` (when `approve`) calls `taskManager.setTaskStatus(task.id, 'approved')` — review correction: do NOT call this before `dispatchPostApproval` and then rely on dispatch to observe it; `dispatchPostApproval` skips its own status transition when it sees `approved`, and that transition is where `approvalSource`/`approvalReason` are stamped. Either keep `runtime.dispatchPostApproval` as the approval primitive (preferred — the pipeline records intent and dispatch performs the stamping) or include `approvalSource`/`approvalReason` in this initial write; the shared pipeline state must carry the source either way.
  5. `effect` `dispatch-post-approval` calls `runtime.dispatchPostApproval` with an IN-STAGE catch (review correction: a dispatch throw AFTER the task is committed `approved` is an EXPECTED post-commit failure in the current tool/RPC paths — they catch it, verify the approved status, and persist `postApprovalBlockedReason`; an uncaught effect throw would terminate and unwind the `stagedRun`, so the resnapshot and blocked-reason stages could never run). The stage stores the error in a `dispatchError` external box instead of rethrowing (a `stagedRun` effect cannot merge the assignment into its copied view) — and the box is ALLOCATED PER INVOCATION, created inside the exported per-call shell and captured by that invocation, NEVER at module/runner scope (review correction PR #2983 round 2: a reusable `stagedRun` runner constructed once shares a module-scope box, so two overlapping approvals overwrite it between dispatch and resnapshot — one task misses its dispatch failure or receives the other's `postApprovalBlockedReason`; same discipline as the overflow fold's saved-envelope box).
  6. `resnapshot` refreshes the task AND materializes the caught dispatch
     error out of the external box into ctx (a post-dispatch `decide` stage
     then selects the blocked-reason path) — the guarded step 7 branches on
     the RESNAPSHOTTED error/flag, never on the box (review correction
     round 23: a resnapshot that only refreshes the task leaves the guarded
     stage with nothing to branch on, so the blocked reason is silently
     skipped).
  7. `effect` `record-blocked-reason` (when dispatch threw) updates `postApprovalBlockedReason`.
  8. Guarded `effect` `set-rejected` (when `reject`) calls `taskManager.setTaskStatus` then `updateTask` with reason.
  9. ONE COMMON FINAL `resnapshot` refreshes the task after the
      `record-blocked-reason`/`set-rejected` writes and BEFORE publication
      (review correction PR #2983 round 2: staged effects cannot merge their returned
      task into the copied view, so without this stage `publish-task-updated`
      and the halt reuse the step-6 task — a rejected task would be published
      and returned as still `review`, and a dispatch-failure task would omit
      `postApprovalBlockedReason`. Current behavior to preserve: the approve
      arm re-reads the task AFTER the blocked-reason write, and the reject
      arm publishes the second write's returned task).
  10. Guarded `effect` `publish-task-updated` emits `space.task.updated`
      with that finally refreshed task after approving OR rejecting, BEFORE the
      halt (review correction rounds 22/23: the publication is a stage of
      the SHARED pipeline ordered before the terminal `halt` — a stage after
      the halt never executes, so `SpaceStore` would stay stale; and it is
      not a shell effect, because keeping the tool's `emitTaskUpdated` and
      the RPC's event publication in the shells duplicates the same business
      event per caller and lets a future caller of the shared pipeline skip
      it — rejected tasks would stay displayed in `review` and
      dispatch-failure metadata would go missing). The shells keep only
      caller-specific result mapping (`jsonResult` for the tool, the final
      task for the RPC).
  11. `halt` returns final `SpaceTask`.
- **Tests**: `packages/daemon/tests/unit/2-handlers/rpc-handlers/space-task-handlers.test.ts` and `packages/daemon/tests/unit/5-space/runtime/space-agent-tools.test.ts`. Add a shared test module for the pipeline that runs the same inputs through both shells, including a row asserting `approvalSource`/`approvalReason` survive both shells.
- **Risks/caveats**: Unification is the main goal: do not leave the tool and RPC with slightly different error messages or preconditions. The dispatch-failure path must still leave the task `approved`; the pipeline must not roll that back. Audit metadata (`approvalSource`, `approvalReason`) must not be silently dropped by the approval-order change above.

### `packages/daemon/src/lib/space/tools/space-agent-tools.ts:review_goal_outcome`

- **Current summary**: Two modes: (1) list claimable outcome notifications, (2) claim a notification and optionally apply a goal update. The claim path calls `goalService.claimOutcomeNotification`, which uses `decideClaimAdmission` and then applies the update.
- **Proposed combinator**: Outer staged flow for discovery/claim admission only; the claim branch performs ONE effect calling `goalService.claimOutcomeNotification` (review correction round 22: do NOT reuse/import the claim-admission `decisionRun` here — its gates live inside the service's atomic sync claim pipeline).
- **Input snapshot design**:
  ```ts
  interface ReviewGoalOutcomeState {
    args: ReviewGoalOutcomeInput;
    goalService: SpaceGoalService;
    notifications: SpaceGoalOutcomeNotification[] | null;
    notification: SpaceGoalOutcomeNotification | null;
    goal: SpaceGoal | null;
    claimResult: ClaimOutcomeNotificationResult | null;
  }
  ```
- **Pure core design**:
  - `decideReviewGoalOutcomeMode`: branches `discover` (no `notification_id` and no updates) or `claim`.
  - Inside `claim`, call `goalService.claimOutcomeNotification` as one effect; do NOT re-inline `decideClaimAdmission` from `claim-admission-gates.ts` outside the service's atomic boundary.
- **Shell/effect wiring**: Effects: `goalService.listClaimableOutcomeNotifications`, `goalService.claimOutcomeNotification` (or, after migration, an inline effect that invokes the same sync claim pipeline).
- **Step-by-step migration**:
  1. Define `stagedRun('review-goal-outcome', ...)`.
  2. `snapshot` validates `hasGoalUpdate` vs `disposition` rules, and — on
     the claim path — the REQUIRED-IDENTIFIER gate (missing `goal_id`/
     `task_id` returns the exact current `goal_id and task_id are required
     when notification_id is provided` response, not an identity denial
     from the service) plus the IN-SPACE goal gate (`requireGoalInSpace`
     equivalent) BEFORE the claim effect, so a foreign-space goal reference
     never reaches `claimOutcomeNotification` (review correction
     PR #2983 round 5).
  3. `decide` mode: `discover` or `claim`.
  4. Branch `discover` → `snapshot` list notifications → `halt`.
  5. Branch `claim` → ONE `effect` calling `goalService.claimOutcomeNotification`
     with the claim args (review correction: duplicating its inner
     admission/apply/status-flip effects as separate `stagedRun` stages runs
     them OUTSIDE the service's `runAtomic` boundary — two concurrent
     claimers can both pass a stale admission and mutate the goal, or a
     failure can leave the goal updated with the notification still pending).
     The admission `decisionRun` is not re-imported here; the service's sync
     claim pipeline stays the single atomic home. Review correction PR #2983 round 2:
     the effect's return value CANNOT reach the halt directly — `stagedRun`
     effects may return only `void`/`won`/`superseded` and receive a
     shallow-copied view, and the claim result is exactly the
     `claimed`/`already_applied`/`denied` verdict the tool maps into its
     response — so the effect stores it in a `claimResult` EXTERNAL MUTABLE
     BOX ALLOCATED PER INVOCATION (created inside the exported per-call
     shell, never at module/runner scope — a shared box lets two concurrent
     claims cross-return each other's verdict), a `resnapshot` stage copies
     it into ctx.claimResult, and only THEN does `halt` return it.
- **Tests**: `packages/daemon/tests/unit/4-space-storage/space-goal-claim.test.ts` and `packages/daemon/tests/unit/5-space/runtime/space-agent-tools.test.ts`.
- **Risks/caveats**: The `claimOutcomeNotification` call is currently inside `runAtomic` in `goal-service.ts`; after unification the atomicity should not be broken. Either keep `goalService.claimOutcomeNotification` as the effect primitive or call the same sync claim pipeline from both places — never an async `stagedRun` inside the transaction.

### `packages/daemon/src/lib/space/tools/space-agent-tools.ts:get_task_detail` and `packages/daemon/src/lib/space/tools/space-agent-tools.ts:list_task_members`

- **Current summary**: `get_task_detail` looks up a task by `task_id` or `task_number`, checks space, and returns it. `list_task_members` does the same plus requires a workflow run and lists its `NodeExecution`s.
- **Proposed combinator**: `decisionRun` shared core (`task-target-resolution`); `get_task_detail` maps its decision to `jsonResult`, while `list_task_members` composes those gates INTO its complete pipeline (review correction round 23 — no admission-only fragment with a shell-side execution read).
- **Input snapshot design**:
  ```ts
  interface TaskTargetResolutionCtx {
    identifier: { task_id?: string; task_number?: number };
    spaceId: string;
    task: SpaceTask | null;
  }
  ```
- **Pure core design**: `decideTaskTargetResolution` with branches: `missingIdentifier`, `notFound`, `spaceMismatch`, `resolved`. Review correction: the node-agent `get_task` shell must MAP `spaceMismatch` to `notFound` (or normalize an out-of-space task to `null` before the decision) — the current handler deliberately masks a valid foreign-space task as the same `Task not found` response as an unknown UUID, and exposing `spaceMismatch` would reveal that the foreign task exists, changing the tool contract. Review correction PR #2983 round 3: `get_task_detail` masks the SAME way — its current `SpaceTaskManager.getTask`/`getTaskByNumber` lookups already normalize a foreign-space task to `null`, so the migrated shell maps `spaceMismatch` to the identical `Task not found` response (P10); only `list_task_members` keeps its existing explicit `does not belong to this space` mismatch response, which it emits today.
- **Shell/effect wiring**:
  - `get_task_detail` shell: runs the `decisionRun`, maps `spaceMismatch` to the same `Task not found` response as `notFound` (round-3 correction above), returns `jsonResult`.
  - `list_task_members`: ONE complete pipeline — shared target-resolution
    stages, then if
    `task.workflowRunId` is null returns `success: true, executions: []`
    PLUS the existing `task_id` and the message `This task has no associated
    workflow run.` (review correction: returning only the bare shape changes
    the tool's response contract and removes the task correlation callers
    receive on every successful arm), otherwise reads
    `nodeExecutionRepo.listByWorkflowRun`.
- **Step-by-step migration**:
  1. Create `packages/daemon/src/lib/space/tools/task-target-resolution-pipeline.ts` exporting `decideTaskTargetResolution`.
  2. Replace the inline if-cascades in both tools with the `decisionRun`.
  3. `list_task_members` composes the workflow-run branch and the `nodeExecutionRepo.listByWorkflowRun` read as stages of its complete pipeline (review correction round 23 — not a post-decision shell read).
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
- **Proposed combinator**: Ordinary pure helpers / direct early stages INSIDE the single `spaceTask.update` RPC pipeline (review correction round 22: no standalone validation `decisionRun` — see the wiring below).
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
- **Shell/effect wiring** (review correction): keep the workflow-override validation rules as ORDINARY PURE HELPERS or direct early stages INSIDE the single `spaceTask.update` RPC pipeline — do not create a standalone `decideWorkflowModelOverrides` runner that the shell invokes before its own direct pipeline, which would split validation, routing, and effects across composition boundaries. If `reject`, throw. If `valid`, apply the normalized value. Because `workflowManager.getWorkflow` is a snapshot read, pass the workflow in as part of the snapshot; do not call the manager inside the pipeline.
- **Step-by-step migration** (review correction round 21): extract the validation rules as ordinary pure helpers / direct early stages INSIDE the single `spaceTask.update` RPC pipeline — do NOT create a standalone validation `decisionRun` module for the handler to invoke. The `throw` sites become rejection branches of that pipeline.
- **Tests**: `packages/daemon/tests/unit/2-handlers/rpc-handlers/space-task-handlers.test.ts`.
- **Risks/caveats**: The function is `async` but contains no awaits. Keep the validation helpers synchronous inside the update pipeline; if a future lookup becomes async, revisit the pipeline's stage boundaries then.

### `packages/daemon/src/lib/rpc-handlers/space-task-handlers.ts:spaceTask.update`

- **Current summary**: Validates input, workflow overrides, handles dependency-added blocked transitions, recovery transitions, stop/park for status, set_status, and field-only updates. Emits `space.task.updated`.
- **Proposed combinator**: ONE direct RPC pipeline for `spaceTask.update` — workflow-override validation, routing (`routeTaskUpdate` as shared plain helper logic or inline gates), and effects compose in it; review correction round 22: no wrapping `routeTaskUpdate` in a new `decisionRun`, and no importing a tool decision runner into a staged run.
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
  - Review correction: `routeTaskUpdate` is the single source of truth for
    the TOOL admission only; the RPC keeps its HUMAN-APPROVAL branch before
    the shared admission — when `spaceTask.update` receives
    `status: 'done'` for a task in `review`, the current RPC deliberately
    calls `setTaskStatus` and stamps `approvalSource: 'human'`, which
    `routeTaskUpdate` rejects as `review_to_done` because it was designed
    for the agent tool. Either keep that RPC branch ahead of the shared
    decision or parameterize it per caller; do not make the tool route an
    unqualified source of truth for both. It already lives in `task-transition-routing.ts` as `routeTaskUpdate`. Review correction: retain it as an ORDINARY PURE HELPER (or inline its routing gates) inside the single `spaceTask.update` RPC pipeline — do NOT wrap it in a separate `decisionRun` for callers to invoke, which would recreate the composition boundaries the corrected design removes.
  - Review correction PR #2983 round 2: the TOOL side composes its COMPLETE update
    operation as ONE direct pipeline in `space-tool-pipeline.ts` — the
    autonomy gate and the shared `routeTaskUpdate` predicates as its early
    stages, then the selected `plan.action` mutation effects
    (`park_stopped`, `recover_transition`, `stop_for_status`, `set_status`,
    `fields_only`), the cascaded-task publications (today's
    `onCascadedTasks` emissions), and the final publication stage — all
    before its halt; `space-agent-tools.ts:update_task`'s imperative
    `switch` cascade after `decideUpdateTask` is deleted and the tool shell
    keeps only `jsonResult` mapping and audit. Merely aligning the existing
    admission runner's gate order would leave the tool operation split
    across the `decideUpdateTask` `decisionRun` and imperative shell
    effects — exactly the split the one-direct-pipeline rule forbids.
    Review correction PR #2983 round 3: the final publication stage is
    guarded by the routing action's `emitTaskUpdated` metadata
    (`always`/`only_with_field_updates`/`never`) — the park/recover/stop
    runtime methods already emit `space.task.updated` via `safeOnTaskUpdated`,
    so an unconditional final emission duplicates the event and reruns
    lifecycle subscribers.
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
  1. Keep `routeTaskUpdate` as shared plain helper logic (review correction round 21: no separate `task-update-routing-pipeline.ts` runner — the tool pipeline would then nest a routing runner inside itself).
  2. Have both callers consume those routing predicates as direct stages/helpers of their own complete update operations.
  3. Rewrite `spaceTask.update` handler as ONE direct RPC pipeline (review correction: workflow-override validation, task-update routing, and effects must not run as separate pipelines — retain the shared predicates as pure helpers or inline their gates into this single pipeline, then execute the effect flow within it; no two `decisionRun`s before a `stagedRun`), branching on `plan.action` inside.
  4. Unify dependency-block logic with the tool's `park_stopped` and `recover_transition` paths.
  5. `emitTaskUpdated` and `emitCascadedTasks` run as guarded effect stages INSIDE the pipeline before its final halt (review correction round 23 — not a post-pipeline shell step, which splits the operation at its publication boundary and lets future exits or callers omit subscriber updates).
- **Tests**: `packages/daemon/tests/unit/2-handlers/rpc-handlers/space-task-handlers.test.ts` and `packages/daemon/tests/unit/5-space/tools/space-tool-pipeline.test.ts`. Add parity tests that feed the same `TaskUpdateRoutingInput` to both the tool and the RPC.
- **Risks/caveats**: This is the biggest unification site. The RPC has extra preconditions (e.g., rejecting direct `review`/`approved` transitions) that the tool also enforces through `routeTaskUpdate`, but the wording is slightly different. Align the messages. The dependency-added path is unique to the RPC and must be preserved.

### `packages/daemon/src/lib/rpc-handlers/space-task-handlers.ts:spaceTask.publish`

- **Current summary**: Fetches task, checks `draft`, calls `taskManager.publishTask`, emits `space.task.updated`.
- **Proposed combinator**: Review correction round 21 — one direct mixed pipeline per caller operation (`publish_task` tool, RPC `spaceTask.publish`, `onPublishTask`), with admission gates (`routePublishTask` retained as shared plain logic) AND the `publishTask` effect + event emission composed in the same pipeline; not an admission-only runner whose publications stay in shells.
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
- **Shell/effect wiring**: `effect` `publish` calls `taskManager.publishTask`, and the `space.task.updated` emission is an effect stage INSIDE each complete publish pipeline before its halt (review correction round 23 — not a shell effect; callers of the shared flow must not be able to skip it); `halt` returns the task. The RPC and tool shells keep response-shape mapping AND their caller-specific audit records (review correction PR #2983 round 5: the tool's success path records `logAudit('publish_task', { previousStatus }, task_id)` — the admission snapshot's status — and dropping it removes the audit trail for agent-initiated publication; the RPC keeps its own logging contract likewise).
- **Step-by-step migration**:
  1. Compose each caller's complete publish operation as ONE mixed pipeline: admission stages (`routePublishTask` as shared plain logic) → `publishTask` effect stage → event-emission stage.
  2. Do NOT replace all three paths with calls to an admission-only `decisionRun` while `publishTask`/emission stay in shells — that splits the operation at its central effect boundary.
- **Tests**: `packages/daemon/tests/unit/2-handlers/rpc-handlers/space-task-handlers.test.ts` and `packages/daemon/tests/unit/5-space/runtime/space-agent-tools.test.ts`.
- **Risks/caveats**: `publish_task` in the space-agent tool currently uses `taskRepo.getTask` (sync), while the RPC uses `taskManager.getTask` (async). Align on `taskManager` or `taskRepo`.

### `packages/daemon/src/lib/space/runtime/task-agent-manager.ts:onArchiveTask` and `onPublishTask`

- **Current summary**: Thin callbacks passed to node-agent MCP. `onArchiveTask` checks active workflow run, then archives. `onPublishTask` just publishes.
- **Proposed combinator**: Review correction round 22 — each callback (`onArchiveTask`, `onPublishTask`) composes as ONE complete mixed pipeline: routing (shared plain logic) → `archiveTask`/`publishTask` effect stage → event-emission stage. Shared admission runners with the central effects left in shells keep the callback operations split.
- **Input snapshot design**: Same as `TaskPublishState` / `ArchiveTaskState` from `task-transition-routing.ts`.
- **Pure core design**: Reuse `routePublishTask` and `routeArchiveTask` as SHARED PLAIN LOGIC — the routing predicates are stages of each caller's own pipeline, not separately-run runners. Review correction PR #2983 round 2: `routeArchiveTask` ALREADY accepts `hasWorkflowRun`/`runActive` and already returns the `archive_active_run` rejection — no slice adds the active-run admission to it.
- **Shell/effect wiring**: The pipeline's effect stages call `boundTaskManager.archiveTask` / `publishTask`, then emit `space.task.updated`.
- **Step-by-step migration**:
  1. Review correction PR #2983 round 2: skip the former "make `routeArchiveTask` gain the active-run check" step — the check is already implemented (and already consumed by the `archive_task` tool); `routeArchiveTask` is already the canonical archive admission core, unchanged by this plan.
  2. Give `onArchiveTask` and the `archive_task` tool each a complete pipeline consuming that shared logic plus their archive/effect/emission stages.
  3. Give `onPublishTask` a complete pipeline consuming `routePublishTask` plus its publish/effect/emission stages.
- **Tests**: `packages/daemon/tests/unit/5-space/agent/task-agent-manager-*.test.ts` and `packages/daemon/tests/unit/5-space/runtime/space-agent-tools.test.ts`.
- **Risks/caveats**: Review correction PR #2983 round 2: `routeArchiveTask`'s `archive_active_run` message and `onArchiveTask`'s active-run error are already byte-identical (modulo the id source); pin that parity in P14 rather than changing either message.

### `packages/daemon/src/lib/space/goals/goal-automation-service.ts:onTaskCompleted`

- **Current summary**: After a task completes, checks goal active, scope, threshold, evidence count, then enqueues a `GOAL_AUTOMATION_EXECUTE` job.
- **Proposed combinator**: One mixed decision/effect pipeline (review correction: admission gates plus the `enqueue` effect stage compose directly in one named operation pipeline; no admission-only pipeline with an imperative `if (proceed) enqueue` outside).
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
- **Pure core design**: `decideCompletedTaskAutomation` with branches: `notApplicable`, `disabled`, `ambiguousScope`, `missingScope`, `belowThreshold`, `proceed`. `proceed` carries `count`. Review correction: when the completed task has NO explicit `evolutionScopeId` and more than one goal scope exists, the current `onTaskCompleted` returns `ambiguous_scope` BEFORE calling `resolveScopeForTask` — the ctx must snapshot the ambiguity flag (scope count) separately from the resolved `scope`, and `ambiguousScope` must win over `missingScope`, or a null resolution is indistinguishable from a genuinely missing scope.
- **Shell/effect wiring** (review correction round 20): the snapshot/admission gates AND the `this.enqueue(...)` job-queue effect compose directly in ONE named completed-task-automation pipeline; the service shell only gathers inputs and returns `GoalAutomationEnqueueResult`.
- **Step-by-step migration**:
  1. Create the mixed pipeline (snapshot stage reads evidence/cursor inputs gathered by the shell).
  2. Move the gate logic from `onTaskCompleted` into its admission stages.
  3. Add the guarded `enqueue` effect stage (`proceed`) to the SAME pipeline.
  4. `onTaskCompleted` becomes: gather snapshot → run the pipeline once → return its result.
- **Tests**: `packages/daemon/tests/unit/5-space/goal-automation-service.test.ts`.
- **Risks/caveats**: The admission table must be unit-tested independently of the job queue. The `below_threshold` branch carries `count`; ensure that is preserved in the decision payload.

### `packages/daemon/src/lib/space/goals/goal-automation-service.ts:onSelfNag`

- **Current summary**: Given a goal/schedule/scope, checks goal active, scope, cron, evidence, then enqueues a self-nag job.
- **Proposed combinator**: One mixed decision/effect pipeline (review correction: admission gates plus the `enqueue` effect stage compose directly in one named operation pipeline; no admission-only pipeline with an imperative `if (proceed) enqueue` outside).
- **Input snapshot design**: Similar to `onTaskCompleted` but with `scheduleId` and `selfNagCronExpression`.
- **Pure core design**: `decideSelfNagAutomation` branches (`disabled`, `missingScope`, `notApplicable`, `proceed`) are direct decide stages of ONE mixed self-nag pipeline (review correction round 19: no admission-only pipeline — the `enqueue` effect stage composes directly in the same operation).
- **Shell/effect wiring**: The shell only snapshots inputs and maps the result; the `GOAL_AUTOMATION_EXECUTE` enqueue is an effect stage of the pipeline.
- **Step-by-step migration**: Compose snapshot → admission stages → guarded `enqueue` stage in one directly named self-nag pipeline.
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
- **Pure core design**: `decideSelfNagScheduleSync` with branches: `pauseAllNoGoal`, `missingGoalNoOp`, `pauseNoCron`, `update`, `create`, `noOp`. Review correction: `pauseAllNoGoal` fires only when `scope.spaceGoalId` itself is ABSENT; when the goal reference is set but the goal is missing or inactive, the current implementation returns WITHOUT pausing that goal's schedule (a no-op) — the ctx must carry the goal-reference state separately (not collapsed into `goal: null`) and route to `missingGoalNoOp`, or the migration silently changes missing/deactivated-goal behavior. Review correction: `pauseOrphans` is NOT a decision branch — it is not mutually exclusive with `update`/`create` (the current code first pauses stale schedules from a previous goal, then continues syncing the active goal's schedule; a scope can have both). It runs as a preliminary unconditional `effect` before `decide`, so a scope with both a stale schedule and a valid current policy still reaches `update`/`create`.
- **Shell/effect wiring**: Effects call `pauseScheduleStrict(scheduleService, id)` for EVERY pause arm — orphan pauses, pause-all, and pause-no-cron — plus `scheduleService.updateSchedule`, `resumeSchedule`, `createGoalSchedule` (review correction PR #2983 round 4: `pauseScheduleStrict` treats an already missing/non-active schedule as benign (its `not found|not active` catch) but THROWS when a CAS-losing `pauseSchedule` returns anything but `paused`, so a concurrently fired/rescheduled schedule aborts the transaction instead of letting both the stale and the replacement self-nag schedules run; a bare `pauseSchedule` stage would either abort on benign disappearances or continue after a lost CAS). Review correction — when `db` is supplied, the flow composes as a direct SYNCHRONOUS `superpipe` pipeline with `.end` executed inside `db.transaction(fn)()`: `stagedRun` executes through `endAsync`, so wrapping it in the synchronous SQLite transaction would commit as soon as the Promise is returned, leaving the normal tool paths (which pass `config.db`) with orphan pauses committed without the replacement schedule. When `db` is absent the same sync pipeline runs best-effort.
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
- **Pure core design**: Inline the authorization, identity, and revision gates DIRECTLY into this claim pipeline (review correction round 17: wrapping `decideClaimAdmission`/its `claimAdmissionRun` executes a nested runner inside one atomic claim operation — import the gates themselves or retain admission as an ordinary pure helper), with the already-applied RETURN placed AFTER the authorization and identity gates and BEFORE the unsuperseded/revision gates (review correction PR #2983 round 2: the current method returns `already_applied` only for an AUTHORIZED, IDENTITY-BOUND retry whose notification already carries `dispositionStatus`, deliberately skipping revision validation — running the already-applied gate first would classify an unauthorized retry as `already_applied`, and running revision validation before it would deny a valid idempotent retry after the goal revision advances as `stale_revision`; without the gate at all, any non-`pending` notification is classified `deny/superseded` and an idempotent retry of a successfully applied outcome becomes an error). Halt rules (review correction): `decideClaimAdmission` ALWAYS returns a non-null decision, so a blanket `!decided` halt would exit for `admit` too and every admitted claim would no-op — halt ONLY on `deny`; `admit` and `already_applied` continue to their effect/return stages.
- **Shell/effect wiring**: Effects: `params.apply(goal)` (if `mutatesGoalState`), `outcomeNotificationRepo.updateStatus`. The shell is the `runAtomic` block; the sync pipeline runs inside it.
- **Step-by-step migration** (review correction — sync pipeline stages, not `stagedRun` steps):
  1. Replace the inline `decideClaimAdmission` call with the sync `superpipe` pipeline whose gates IMPORT the authorization/identity/revision gate functions directly (review correction round 18: do NOT wrap-and-invoke `claimAdmissionRun` from inside this atomic pipeline — that nests a runner within one claim operation).
  2. Gather stage loads notification and goal, computes `authorizedAgentIds`.
  3. Decide stage runs authorization → identity gates FIRST, then the
     already-applied return for retries whose notification already carries
     `dispositionStatus` (which intentionally SKIPS revision validation), with
     the unsuperseded/revision gates applied only to PENDING claims — the same
     order as the corrected P33 slice, never already-applied-first; halt only
     on `deny` (never a blanket `!decided` — `admit` must continue).
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
  3b. Admission gates BEFORE any update or terminal effect (review
      correction): missing task → halt; missing goal → halt; goal-space
      mismatch (`goal.spaceId !== existing.spaceId`) → return `null` — the
      current `handleTaskTerminal` returns `null` before entering
      `runAtomic` for a foreign-space goal (pinned by the cross-space test);
      without these gates the pipeline could clear an active-task pointer
      and record terminal bookkeeping against a foreign goal.
  3c. Nonterminal transitions stamp the structured result (current goal,
      `nextTask: null`, existing `terminalGeneration`, `notification: null`)
      BEFORE halting (review correction: the current method returns that
      shaped result, not `null`; halting without it loses the branch's
      return contract — add a parity row).
  3. Decide stage `is-terminal` is the plain terminal-status check (NOT
     `decideReportableTerminal`); if `false`, halt (`.end` returns early).
     The reportability decision runs later, at the notification stage.
  4. `effect` `update-task` applies `transition.updates`.
  5. `resnapshot` task.
  6. `decide` `already-notified` checks existing notifications for this
     `terminalGeneration`; when set, HALT immediately, returning the current
     goal and a null notification (review correction: the existing method
     returns BEFORE clearing the active task, recording another goal event,
     rerunning evidence/automation, or creating another next task — an
     idempotent retry must not repeat any terminal bookkeeping; pin the retry
     path in the parity tests).
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
      Keep the local catch/log boundary. Review correction PR #2983 round 3:
      the stage ALSO retains the NESTED `db.transaction` savepoint the
      current code wraps around `createImmediateTaskInternal`
      (`goal-service.ts:446-454`) — calling the helper directly inside the
      OUTER transaction means a mid-creation throw, though caught, has
      already committed its partial task/goal writes into the outer
      transaction, which can leave an orphan task or an inconsistent
      active-task pointer; the savepoint rolls the failed creation back to
      its pre-call state before the catch records the notification.
  13. `resnapshot` goal.
  14. `effect` `record-outcome-notification`.
  15. `halt` returns `{ goal, nextTask, terminalGeneration, notification }`.
  16. Post-commit shell (review correction): AFTER `runAtomic` resolves, the
      shell invokes `emitTaskCreated` (when a next task was created) and
      `onOutcomeNotification` (when a notification was recorded), deferring
      both via `setImmediate` when `transition.deferPostCommitEffects` is set
      — carry that flag in the pipeline state and retain this step; without it
      migrated goal progress stops waking subscribers or announcing the next
      task.
- **Tests**: `packages/daemon/tests/unit/4-space-storage/space-goal-service.test.ts` and `packages/daemon/tests/unit/5-space/runtime/goal-outcome-wake-flip.test.ts`.
- **Risks/caveats**: Review correction — Forge evidence capture (`evolutionScopeService.captureCompletedTaskEvidence`) and goal automation (`goalAutomationService.onTaskCompleted`) are BEST-EFFORT in the current code (each is wrapped in its own catch around `goal-service.ts:426-440` and failures are logged, then the flow continues to clear the active task and record the notification). Their pipeline stages must retain those local catch/log boundaries: an ordinary effect stage whose throw escapes would roll back the entire terminal transition inside `runAtomic`. This is the most complex goal effect chain. Because it runs inside `runAtomic`, the transaction provides atomicity. Review correction — `stagedRun` is async-only (`endAsync`), so it cannot run inside the synchronous `db.transaction(fn)()` wrapper without committing early (the transaction commits when the Promise is returned, and the task/goal/notification effects then land outside it, breaking `terminalGeneration` deduplication). Compose this path as a direct synchronous `superpipe` pipeline with `.end` inside the existing `runAtomic`, using the transaction-bound repo methods; an async `runAtomic` variant cannot preserve atomicity without an async-capable DB transaction primitive. Do not introduce in-flow retries.

### `packages/daemon/src/lib/space/runtime/space-runtime.ts:registerSubscription` and `validateSubscriptionTargetTask`

- **Current summary**: `registerSubscription` validates and normalizes a topic, validates the target task for dynamic subscriptions, checks an interest limit, removes an existing entry, inserts into `topicTrie`, persists to `workflowEventSubscriptionRepo`, and triggers a redispatch. `validateSubscriptionTargetTask` is a pure task-status check.
- **Proposed combinator**: Direct SYNCHRONOUS `superpipe` pipeline with `.end` for `registerSubscription` (review correction: it currently completes synchronously and production callers like `registerRunInterests` inspect `result.success` immediately while registering static interests in a loop — `stagedRun` executes through `endAsync`, which changes the contract to a Promise and adds await gaps between the interest-count snapshot and trie mutations; trie and repository operations here are synchronous, so the sync pipeline with the existing in-memory rollback preserves everything). `validateSubscriptionTargetTask` becomes an ORDINARY PURE HELPER or direct branches of the same synchronous registration pipeline (review correction: defining it as a separate `decisionRun` used as this pipeline's target-validation gate splits each dynamic registration across two pipelines — this private validation is an internal stage of registration).
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
- **Shell/effect wiring**: Effects: `topicTrie.remove`, `topicTrie.insert`, `workflowEventSubscriptionRepo.upsert`, `redispatchRetainedExternalEvents`. Review correction round 22: the sync `.end` pipeline has NO `stagedRun` compensation stack, so there is no `compensate` on `persist-subscription` to assign — if `workflowEventSubscriptionRepo.upsert` throws, the SHELL's explicit in-memory rollback removes the inserted trie entry and re-inserts `displaced` (steps below).
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
  8. Review correction PR #2983 round 5 — `redispatch` IS the pipeline's FINAL
     GUARDED EFFECT, with an IN-STAGE catch/log boundary that swallows its
     errors: an earlier correction moved it to a post-pipeline shell step
     because a throw after `persist-subscription` would unwind the persist
     rollback, but an in-stage catch removes that failure path entirely
     while keeping the delivery nudge inside the ONE registration operation
     (a shell step would let a future direct caller of `registerSubscriptionRun`
     persist a subscription without nudging retained events). It stays a
     best-effort nudge, never a consistency write: its catch logs and
     returns, so the persist rollback can never be triggered by it.
  9. `.end` returns `{ success: false, error }` for EVERY ordinary validation
     branch (invalid topic, missing run, invalid target task — review
     correction round 21: the current method returns false there and
     `registerRunInterests` relies on that false value to reject invalid
     static interests; returning `{ success: true }` for them would silently
     accept registrations that were never inserted). The `limitReached` branch
     must THROW after rolling back any displaced entry — the current
     `registerSubscription` throws
     `cannot register more than 10 event interests` and
     `space-runtime-external-events.test.ts` asserts that exception.
- **Tests**: `packages/daemon/tests/unit/5-space/runtime/space-runtime-list-subscriptions.test.ts` and `packages/daemon/tests/unit/5-space/runtime/space-runtime-workflow-subscription-persistence.test.ts`. Add a row where `redispatchRetainedExternalEvents` throws: the subscription must remain both persisted and present in the trie.
- **Risks/caveats**: `topicTrie` is in-memory shared state. The current manual rollback on repo error is exactly the in-memory compensation pattern. `workflowEventSubscriptionRepo.upsert` should be CAS-guarded; the shell's explicit rollback undoes the trie change on failure. The limit check must be re-gathered between any write and the next read (the `existingInterests` snapshot already does this).

### `packages/daemon/src/lib/space/runtime/agent-message-routing-gates.ts:decideGenericAddressRouting`

- **Current summary**: Routes a parsed address to one of several actions: `deliverToCoordinator`, `deliverToSession`, `failSessionUnauthorized`, `deliverViaMessagingFacade`, `failUnsupported`, `failUnsupportedKind`, `deliverToWorker`, `failInvalidWorker`, `notFound`.
- **Proposed combinator**: Ordinary pure helper or ordered gates composed directly into the message-routing operation (review correction rounds 20–22: no standalone runner — see below).
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
- **Pure core design**: `decideGenericAddressRouting` stays an ordinary pure helper with branches in the same order as the current if-cascade (the `decodeURIComponent` catch is its `failInvalidWorker` branch), unit-tested directly.
- **Shell/effect wiring**: None; the caller (`AgentMessageRouter.deliverGenericMessage`) interprets the decision. Keep the function pure.
- **Step-by-step migration** (review correction round 21): keep this classifier as an ORDINARY PURE HELPER or compose its ordered gates as direct stages of the existing message-routing operation — do NOT create/invoke a standalone `generic-address-routing` runner, which would add one nested pipeline per target after `send` has already entered message routing.
- **Tests**: `packages/daemon/tests/unit/5-space/runtime/agent-message-routing-pipeline.test.ts` and `packages/daemon/tests/unit/5-space/agent/agent-message-router.test.ts`.
- **Risks/caveats**: This is called once per target in `deliverGenericMessage`; keep it a plain helper so the per-target loop adds no pipeline overhead. Review correction round 20: keep `decideGenericAddressRouting` as an ORDINARY PURE HELPER (or compose its gates into the existing routing operation) — `send` has already run `decideAgentMessageRouting` when `delegateGeneric` chooses it, and `deliverGenericMessage` then invokes this classifier once per target, so a standalone runner would add one nested pipeline per target to one message-routing operation. Preserve the current `notFound` fall-through with `target`.

### `packages/daemon/src/lib/space/runtime/agent-message-routing-gates.ts:resolveNodeAgentTargets`

- **Current summary**: Resolves a target string or array against the declared channel topology, permitted targets, peer agents, node groups, and authorization.
- **Proposed combinator**: Review correction PR #2983 round 2 — `resolveNodeAgentTargets` STAYS an ordinary pure helper (restructured into named linear self-guarding gates under the existing export), consumed by `agent-message-router.ts` exactly where it is called today; its gates compose as direct stages of a pipeline only when the COMPLETE `AgentMessageRouter.deliverMessage` operation migrates as its own heavyweight plan. No standalone `decisionRun`, and no moving the stages into `agent-message-routing-pipeline.ts` in this plan: that module is the admission/classification runner whose result `deliverMessage` interprets imperatively (channel delivery, session activation, injection, queuing, result folding all run after it returns), so wiring the resolution stages into it would still leave the delivery business path split at its effect boundary.
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
- **Pure core design**: The helper's BODY is restructured as LINEAR named self-guarding gates with NO early-return `!dep`-style halts between resolution gates (review correction round 4: `!hasTargets` after each resolution gate halts the WHOLE resolution once a known target is found, so `unauthorized`/`resolved` never execute and the shared `canSend` check is still bypassed). The resolution gates (`starPermitted`, `arrayTarget`, `spaceAgentTarget`, `peerTarget`, `nodeGroupTarget`, `declaredTarget`, `topologyTarget`) are nonterminal self-guarding no-ops once a resolution has matched — guarded by a separate `resolutionMatched` boolean, NOT by `targetAgentNames.length` (review correction: `target === []` and empty node groups deliberately resolve to `{ status: 'resolved', targetAgentNames: [] }`, which a length guard would misroute to `unknownTarget`; add empty-array and empty-node-group parity rows). Only the terminal gates set the outcome, in order: `noPermittedTargets` (review correction: `target === '*'` with an empty `permittedTargets` list is a DISTINCT public outcome with its own topology-specific explanation — it must not collapse into `unknownTarget`), `unknownTarget` (no resolution matched), `unauthorized` (`canSend` fails for any resolved target), `resolved` (carries the authorized `targetAgentNames`). Terminal gates match only when no outcome is set yet.
- **Shell/effect wiring**: Review correction PR #2983 round 2 — `agent-message-router.ts:deliverMessage` keeps calling the plain helper inside the `resolution` input it hands `decideAgentMessageRouting`, unchanged by this plan; do NOT create a separately imported `node-agent-target-resolution-pipeline.ts`, and do NOT move the gates into `agent-message-routing-pipeline.ts` while that module remains the admission runner whose delivery effects stay imperative in `deliverMessage`. The gates become direct stages only inside the complete `deliverMessage` delivery pipeline of a future heavyweight plan (channel routing, session activation, injection, queuing, and result folding composed with them).
- **Step-by-step migration**:
  1. Restructure `resolveNodeAgentTargets` in `agent-message-routing-gates.ts` into the named linear gates above, keeping the export name, signature, and `ResolveNodeAgentTargetsOutcome` union (review correction PR #2983 round 2: no rename, no deprecated re-export shim — its consumers do not change in this plan).
  2. Keep `agent-message-router.ts` consuming the helper exactly as today; no rewiring slice follows.
  3. When the complete `deliverMessage` operation migrates as its own plan, compose these gates as direct stages of that single delivery pipeline.
  4. Update tests accordingly.
- **Tests**: `packages/daemon/tests/unit/5-space/runtime/agent-message-routing-gates.test.ts`.
- **Risks/caveats**: The helper is called in `agent-message-router.ts` and in tests; both keep calling it. The `decision`/outcome union remains `ResolveNodeAgentTargetsOutcome`.

### `packages/daemon/src/lib/space/runtime/activation-routing.ts:decideActivationRouting`

- **Current summary**: Given existing execution facts and workflow resolvability, decides whether to reuse, reset, reject, spawn, or return empty.
- **Proposed combinator**: Review correction round 20 — migrate the COMPLETE activation business path (`activateTargetSessionsForMessage`, which invokes the classifier three times around resume/rehydration, reset, workflow activation, resnapshot, and spawn effects) to ONE mixed/resnapshot pipeline; these classifications become its stages or plain helpers. Converting only the classifier into a standalone runner would execute a new pipeline three times while preserving the imperative outer cascade. Review correction PR #2983 round 3: the effect inventory explicitly includes the leading `tryResumeNodeAgentSession` rehydration/pending-flush effect with a FRESH execution/liveness snapshot before classification, and the spawn stage keeps its bounded shape — the 30-second `unref`'ed timeout race with `clearTimeout` in `finally`, timeout and superseded spawn errors mapping to the logged benign empty result, other errors rethrown.
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
- **Pure core design**: `decideActivationRouting` with gates: `reuseInProgressOrBlocked` (review correction: returns `reuse_existing` ONLY when the existing execution has a LIVE `agentSessionId`; when the execution is `in_progress`/`blocked` but has NO live session it must return `reset_pending_and_continue` so the stale execution is reset before continuing — without that branch a literal implementation falls through toward `spawn`, losing recovery of dead worker executions), `rejectUndeclared`, `returnEmpty`, `spawn`.
- **Shell/effect wiring**: The caller (`TaskAgentManager` activation logic) interprets the decision and executes the chosen action.
- **Step-by-step migration**:
  1. Create `packages/daemon/src/lib/space/runtime/activation-routing-pipeline.ts`.
  2. Review correction round 21 — migrate the COMPLETE activation operation (`activateTargetSessionsForMessage`, which invokes this classification three times around resume/rehydration, reset, workflow activation, resnapshot, and spawn effects — see the round-3 note above) to ONE mixed/resnapshot pipeline; these branches are its stages (not a standalone `activation-routing` `decisionRun`, which would execute three nested runners while leaving the imperative outer cascade intact).
  3. Keep `decideActivationRouting` exported as the plain classification helper the complete activation pipeline's stages call.
- **Tests**: `packages/daemon/tests/unit/5-space/runtime/activation-routing.test.ts`.
- **Risks/caveats**: The current `existing` fact object is normalized to `null`. Preserve that normalization in the pipeline's input snapshot.

### `packages/daemon/src/lib/space/runtime/last-message-classifier.ts:classifyLastMessageForIdleAgent`

- **Current summary**: Classifies the last SDK message for an idle agent as terminal or not, with a reason. Handles `result`, `assistant`, errors, content blocks, and `end_turn`.
- **Proposed combinator**: Ordinary pure helper (or gates composed directly into each caller's complete idle-detection/recovery pipeline — review correction round 23: no standalone `last-message-classifier` runner; the three callers perform the terminal action, so a nested classification pipeline adds a runner without migrating any complete path).
- **Input snapshot design**:
  ```ts
  interface LastMessageClassificationCtx {
    message: SDKMessage | null | undefined;
    decision: LastMessageClassification | null;
  }
  ```
- **Pure core design**: `decideLastMessageForIdleAgent` with gates: `missingMessage`, `hollowResultMessage` (review correction: `isHollowTaskNotificationResult` is checked BEFORE the terminal result classification — zero-token, empty task-notification wakeups return NONTERMINAL so the follow-up turn can arrive; a generic result arm would mark an idle agent finished prematurely; keep the existing error/text/usage exceptions), `resultMessage`, `nonAssistantMessage`, `assistantError`, `contentBlockClassification`, `endTurn`, `defaultNotTerminal`. The content-block gate can be a single helper that scans the blocks and returns the appropriate `LastMessageClassification`.
- **Shell/effect wiring**: The callers (`SpaceRuntime` idle detection and recovery paths) consume `LastMessageClassification` and act on `terminal` — compose these gates directly into those complete caller operations when those operations migrate; until then the helper stays a plain function.
- **Step-by-step migration**:
  1. Keep `classifyLastMessageForIdleAgent` as a plain synchronous helper
     with its branch order unit-tested directly (no new pipeline module —
     review correction round 23).
  2. When a caller's complete idle-detection/recovery operation migrates to
     a pipeline, compose these gates as stages of THAT pipeline.
  3. Replace the inline function with the helper call where extracted.
- **Tests**: `packages/daemon/tests/unit/4-space-storage/storage/hidden-subtype-idle-detection.test.ts` and `packages/daemon/tests/unit/5-space/runtime/last-message-classifier.test.ts` if it exists.
- **Risks/caveats**: The classifier is called when the runtime checks for idle agents. Keep it a synchronous plain helper to avoid microtask interleaving with the tick. The content-block scan is a small loop; it stays inside the helper.

---

## Suggested migration order

1. **Phase 0 — Pure decisionRun extractions (no effects)**
   - `last-message-classifier.ts` (plain-helper extraction of `classifyLastMessageForIdleAgent` — review correction round 23: no standalone runner)
   - `agent-message-routing-gates.ts` (`decideGenericAddressRouting` and `resolveNodeAgentTargets` as plain helpers — no standalone runners, and no admission-only wiring of the resolver into the routing `decisionRun`; review correction PR #2983 round 2)
   - `validateWorkflowModelOverrides` (plain validation helpers destined for the `spaceTask.update` pipeline)
   - `task-target-resolution-pipeline.ts` (for `get_task` / `get_task_detail` / `list_task_members`)

2. **Phase 1 — Complete per-caller task pipelines over shared plain routing logic**
   - KEEP `routeTaskUpdate`/`routePublishTask`/`routeArchiveTask` as ordinary pure shared helpers in `task-transition-routing.ts` — no `task-update-routing-pipeline.ts` or other new runner modules (review correction PR #2983: the old extraction bullets reintroduced the nested composition boundary the corrected design removed).
   - Compose each caller's COMPLETE operation pipeline (validation + routing gates as stages → mutation effect → `space.task.updated` emission): `spaceTask.update`, `spaceTask.publish`, `spaceTask.approvePendingCompletion`, `publish_task`/`archive_task` tools, and the `onPublishTask`/`onArchiveTask` callbacks.
   - `space-tool-pipeline.ts` keeps its gates as plain logic consumed by the tool's own complete pipeline — no shared `decideTaskUpdate` runner to invoke.

3. **Phase 2 — Staged effect flows with clear atomicity**
   - `approve-pending-completion-pipeline.ts`
   - `review-goal-outcome` / `claimOutcomeNotification`
   - `registerSubscription`
   - `syncGoalAutomationSelfNagScheduleForScope`
   - `goal-automation-admission-pipeline.ts` (`onTaskCompleted`, `onSelfNag` — mixed pipelines with their `enqueue` effect stages; review correction round 22: NOT Phase-0 pure extractions, or the admission-only intermediate ships first)

4. **Phase 3 — Heavyweight staged flows**
   - `post-approval-router.ts:route`
   - `activateTargetSessionsForMessage` (the complete effectful activation operation; review correction round 22: not a Phase-0 classifier extraction)
   - `deliverDirectSteerUnderCoordination`
   - `handleTaskTerminal`
   - `send_message_to_task`
   - `foldDeferredExternalEventsAtFlush` and `foldDeferredExternalEventOverflow`

---

## Focused PR breakdown

Every slice below obeys the standing two-tier review budget: production Δ ≲100 lines per slice (hard cap ~150 only for types-dominated additive cores), and test Δ ≲350 counted separately from production code. Pins are split by dimension family (decision tables vs effect/publication behavior), never by truncating a table mid-family. If a slice outgrows its budget while being authored or reviewed, split it further BEFORE opening it — never grow a PR past budget mid-review — and never fold unrelated fixes or drive-by import/formatting churn into a file a slice touches.

Each slice carries a phase label: 📌 **pins** (production Δ = 0; characterization/decision-table rows of current behavior, i.e. the contract later slices intentionally change), ➕ **additive core** (pure module/pipeline landed unwired from production), 🔧 **apply** (wire call sites; one arm/route/site per slice), and trailing **cleanup**. Tiny slices may combine 📌+🔧. Ordering follows the rules above: pins before extraction, primitives (shared helpers/cores) before consumers. Pin and additive-core slices are parallel-safe leaves across disjoint file families; apply slices chain on their cores. An additive core may land unwired only as a TEMPORARY landing state — its apply slice wires the COMPLETE business operation, never an admission-only or classifier-only pipeline whose effects stay imperative (the review corrections forbid that end state).

The slices follow the `Suggested migration order` phases and together cover every site in `Per-site detailed plans` exactly once: pins characterize the site, one additive core builds its pipeline, one apply slice (per call site) wires it — except the sites the review corrections keep as plain helpers (generic address routing, the last-message classifier, and node-agent target resolution — whose gates join a pipeline only when the complete `deliverMessage` operation migrates, per review correction PR #2983 round 2), which pin and extract/restructure without ever shipping a standalone runner.

**Phase 0 — pure extractions and their pins**

### P1 — `test(space): pin last-message classification decision table`

- 📌 pins — prod Δ = 0, test Δ ≲200
- **Scope**: Characterization rows for `classifyLastMessageForIdleAgent` in `packages/daemon/src/lib/space/runtime/last-message-classifier.ts`: `missingMessage`, hollow task-notification results (nonterminal), terminal `result` with the error/text/usage exceptions, `assistant` errors, content-block scan, `end_turn`, default nonterminal. Parallel-safe leaf.
- **Lands**: the classification table the P2 core must reproduce is pinned before any extraction.
- **Excludes**: any production change.
- **Tests**: `packages/daemon/tests/unit/4-space-storage/storage/hidden-subtype-idle-detection.test.ts`; `packages/daemon/tests/unit/5-space/runtime/last-message-classifier.test.ts` if it exists.
- **Depends on**: none.

### P2 — `refactor(space): extract and pin the plain last-message classification helper`

- 🔧 apply — prod Δ ≲40, test Δ ≲100
- **Scope**: `classifyLastMessageForIdleAgent` stays an ORDINARY synchronous plain helper in `packages/daemon/src/lib/space/runtime/last-message-classifier.ts` with its branch order (`missingMessage`, `hollowResultMessage`, `resultMessage`, `nonAssistantMessage`, `assistantError`, `contentBlockClassification`, `endTurn`, `defaultNotTerminal`) extracted/named and unit-tested directly — review correction round 23: NO standalone `last-message-classifier` pipeline module (the three SpaceRuntime callers perform the terminal action; a nested classification runner migrates no complete path). The content-block scan stays inside the helper. Parallel-safe leaf.
- **Lands**: the classification table is a directly unit-tested plain helper; no pipeline module exists.
- **Excludes**: composing the gates into caller operations (P3).
- **Tests**: the P1 rows against the extracted helper.
- **Depends on**: P1.

### P3 — `refactor(space): compose the classification gates into caller idle-detection pipelines when they migrate`

- 🔧 apply (deferred) — prod Δ ≲50, test Δ ≲100
- **Scope**: When a `SpaceRuntime` caller's complete idle-detection/recovery operation migrates to a pipeline, compose the P2 classification gates as DIRECT stages of THAT pipeline (review correction round 23 — the gates live inside each complete caller operation, never a standalone runner); until such a caller migration lands, the helper stays a plain function.
- **Lands**: no standalone classifier pipeline ever ships; the gates join a complete operation only when that operation itself migrates.
- **Excludes**: creating a `last-message-classifier-pipeline.ts` module (forbidden by round 23).
- **Tests**: the P1 suites stay green through the caller migration.
- **Depends on**: P2.

### P4 — `test(space): pin generic address routing helper branches`

- 📌 pins — prod Δ = 0, test Δ ≲200
- **Scope**: Direct unit rows for `decideGenericAddressRouting` in `packages/daemon/src/lib/space/runtime/agent-message-routing-gates.ts`: branch order, the `decodeURIComponent` catch as `failInvalidWorker`, and the `notFound` fall-through carrying `target`. Per the review corrections this helper STAYS a plain function — these pins are the complete migration for this site. Parallel-safe leaf.
- **Lands**: the per-target routing contract is pinned with zero pipeline overhead added.
- **Excludes**: any runner wrapper (forbidden by the corrections).
- **Tests**: `packages/daemon/tests/unit/5-space/runtime/agent-message-routing-pipeline.test.ts`, `packages/daemon/tests/unit/5-space/agent/agent-message-router.test.ts`.
- **Depends on**: none.

### P5 — `test(space): pin node-agent target resolution outcomes`

- 📌 pins — prod Δ = 0, test Δ ≸250
- **Scope**: Characterization rows for `resolveNodeAgentTargets`: `target === []` and empty node groups resolve to `{ status: 'resolved', targetAgentNames: [] }`; `'*'` with empty `permittedTargets` returns the distinct `noPermittedTargets` outcome; `canSend` authorization applies AFTER resolution (an unauthorized resolved target must not bypass the check). Parallel-safe leaf.
- **Lands**: the resolution contract the P6 gates must reproduce is pinned.
- **Excludes**: production changes.
- **Tests**: `packages/daemon/tests/unit/5-space/runtime/agent-message-routing-gates.test.ts`.
- **Depends on**: none.

### P6 — `refactor(space): restructure the plain node-agent target-resolution helper into named linear gates`

- 🔧 apply — prod Δ ≲100, test Δ ≲250
- **Scope**: Review correction PR #2983 round 2 — REDEFINED from "add resolution stages to the routing pipeline": `resolveNodeAgentTargets` stays in `packages/daemon/src/lib/space/runtime/agent-message-routing-gates.ts` as an ORDINARY PURE HELPER under the SAME export name and signature, with its body restructured into the named linear gates (`starPermitted`, `arrayTarget`, `spaceAgentTarget`, `peerTarget`, `nodeGroupTarget`, `declaredTarget`, `topologyTarget`) — self-guarding via a `resolutionMatched` boolean (NOT `targetAgentNames.length`), no early halts between resolution gates; only the terminal gates set the outcome (`noPermittedTargets`, `unknownTarget`, `unauthorized`, `resolved`). `targetAgentNames` stays an explicit side field. NO changes to `agent-message-routing-pipeline.ts`, NO rename/`decideNodeAgentTargets` export, NO deprecated re-export shim — `agent-message-router.ts` and the tests keep calling the helper unchanged (wiring the gates into the admission runner would leave `deliverMessage`'s delivery effects imperative behind it — a split composition this plan must not ship). Parallel-safe leaf.
- **Lands**: the resolution+authorization gate group is directly unit-testable as a plain helper; the router's calling code is untouched.
- **Excludes**: any `agent-message-routing-pipeline.ts` change (forbidden by round 2), a separate `node-agent-target-resolution-pipeline.ts` (forbidden), and router rewiring (P7 is deferred).
- **Tests**: the P5 rows re-run against the restructured helper, plus empty-array/empty-node-group parity rows.
- **Depends on**: P5.

### P7 — `refactor(space): compose the resolution gates into the complete delivery pipeline when that operation migrates`

- 🔧 apply (deferred) — prod Δ ≲50, test Δ ≲100
- **Scope**: Review correction PR #2983 round 2 — REDEFINED from "wire the message router to in-pipeline target resolution": when the COMPLETE `AgentMessageRouter.deliverMessage` operation (channel routing, session activation, injection, queuing, result folding included) migrates to ONE pipeline under a future heavyweight plan, compose the P6 gates as DIRECT stages of THAT pipeline. Until then `agent-message-router.ts` keeps calling the plain helper and this plan wires nothing: `agent-message-routing-pipeline.ts` is the admission runner whose result `deliverMessage` interprets imperatively, and moving resolution into it would claim a "single pipeline" while the business operation stays split at its effect boundary.
- **Lands**: no admission-only wiring ships from this plan; the gates join a pipeline only when the complete delivery operation migrates.
- **Excludes**: creating a router-delivery pipeline in this plan (out of scope) and `decideGenericAddressRouting` (already final per P4).
- **Tests**: the P5 suites stay green through any future caller migration.
- **Depends on**: P6.

### P8 — `test(tools): pin task-lookup tool response contracts`

- 📌 pins — prod Δ = 0, test Δ ≲200
- **Scope**: Pin the response shapes of `get_task_detail`, `list_task_members` (including the no-workflow-run arm returning `success: true`, `executions: []`, the `task_id`, and the `This task has no associated workflow run.` message; and its explicit `does not belong to this space` mismatch response), and node-agent `get_task` — including the masking of a valid foreign-space task to the same `Task not found` response as an unknown UUID, which BOTH `get_task` and `get_task_detail` perform today (review correction PR #2983 round 3: `get_task_detail`'s `taskManager.getTask` normalizes a foreign-space task to `null`, so the migrated shell must keep mapping `spaceMismatch` to the identical masked response — only `list_task_members` exposes the explicit mismatch). Parallel-safe leaf.
- **Lands**: the tool contracts the shared core must preserve (and the `spaceMismatch` mapping rules) are pinned.
- **Excludes**: production changes.
- **Tests**: `packages/daemon/tests/unit/5-space/runtime/space-agent-tools.test.ts`, `packages/daemon/tests/unit/5-space/agent/node-agent-tools.test.ts`.
- **Depends on**: none.

### P9 — `feat(tools): add task-target-resolution decisionRun core (unwired)`

- ➕ additive core — prod Δ ≲80, test Δ ≲150
- **Scope**: New `packages/daemon/src/lib/space/tools/task-target-resolution-pipeline.ts` exporting `decideTaskTargetResolution` with branches `missingIdentifier`, `notFound`, `spaceMismatch`, `resolved`; the shell gathers the task (async lookup stays outside) and passes `task`/`taskInSpace` in. Parallel-safe leaf.
- **Lands**: the shared lookup admission core exists; no tool uses it yet.
- **Excludes**: tool rewiring (P10, P11).
- **Tests**: branch rows for the three rejection arms in the P8 suites' style.
- **Depends on**: P8.

### P10 — `refactor(tools): run get_task_detail on task-target-resolution and list_task_members as a complete pipeline`

- 🔧 apply — prod Δ ≲100, test Δ ≲150
- **Scope**: In `packages/daemon/src/lib/space/tools/space-agent-tools.ts`: `get_task_detail` runs the P9 `decisionRun` and maps its decision to `jsonResult`, mapping `spaceMismatch` to the same masked `Task not found` response as `notFound` (review correction PR #2983 round 3 — the current `taskManager` lookup already normalizes foreign-space tasks to `null`; surfacing a distinct mismatch would reveal foreign-task existence); `list_task_members` composes the shared target-resolution gates INTO its ONE complete `list-task-members` pipeline, with its EXPLICIT mismatch response retained, the workflow-run branch (null run → `success: true, executions: []` plus the existing `task_id` and the `This task has no associated workflow run.` message) and the `nodeExecutionRepo.listByWorkflowRun` read as STAGES — no admission-only fragment with a shell-side execution read (review correction round 23).
- **Lands**: both lookup tools share one admission core, and `list_task_members` is a single complete pipeline; P8 pins stay green.
- **Excludes**: `send_message_to_task` (P55–P57) and the node-agent tool (P11).
- **Tests**: `packages/daemon/tests/unit/5-space/runtime/space-agent-tools.test.ts` (missing identifier / not found / space mismatch rows).
- **Depends on**: P9.

### P11 — `refactor(tools): route node-agent get_task through task-target-resolution`

- 🔧 apply — prod Δ ≲40, test Δ ≲80
- **Scope**: `get_task` in `packages/daemon/src/lib/space/tools/node-agent-tools.ts` imports `decideTaskTargetResolution` and maps `spaceMismatch` to the pinned `Task not found` response; the inline `taskRepo` checks are deleted.
- **Lands**: node-agent and Space-agent lookups converge on one `decisionRun` with identical error messages and `success` shapes.
- **Excludes**: other node-agent tools.
- **Tests**: `packages/daemon/tests/unit/5-space/agent/node-agent-tools.test.ts`.
- **Depends on**: P9 (parallel-safe with P10).

### P12 — `test(handlers): pin workflow-override validation gates`

- 📌 pins — prod Δ = 0, test Δ ≲250
- **Scope**: Decision-table rows for `validateWorkflowModelOverrides` in `packages/daemon/src/lib/rpc-handlers/space-task-handlers.ts`: `overridesUndefined`, `lockedAfterStart` (task already started), `nullOverrides`, `invalidMap`, `noWorkflow`, `workflowDisabled`, `invalidKey` (`nodeId:agentName`), `valid` normalization. Parallel-safe leaf.
- **Lands**: the validation contract the P13 helpers and P22 pipeline stages must reproduce is pinned.
- **Excludes**: production changes.
- **Tests**: `packages/daemon/tests/unit/2-handlers/rpc-handlers/space-task-handlers.test.ts`.
- **Depends on**: none.

### P13 — `feat(handlers): add plain workflow-override validation helpers (unwired)`

- ➕ additive core — prod Δ ≲90, test Δ ≲200
- **Scope**: The validation rules as ordinary SYNCHRONOUS pure helpers (no standalone `decisionRun` module, per review correction round 22); the workflow is passed in as a snapshot value — `workflowManager.getWorkflow` stays a shell read. The handler keeps its current path. Parallel-safe leaf; wired as early stages by P22/P23.
- **Lands**: the gate table is directly unit-testable and ready to compose into the single `spaceTask.update` pipeline.
- **Excludes**: changing `validateWorkflowModelOverrides`'s current callers.
- **Tests**: the P12 table re-run against the helpers.
- **Depends on**: P12.

**Phase 1 — shared task-mutation cores and unifications**

### P14 — `test(space): pin task-transition routing core contracts`

- 📌 pins — prod Δ = 0, test Δ ≲250
- **Scope**: Pin the plain-helper contracts in `packages/daemon/src/lib/space/tools/task-transition-routing.ts`: `routeTaskUpdate` precedence (including the `review_to_done` rejection the tool enforces and the RPC deliberately bypasses), `routePublishTask` not-draft rejection, and `routeArchiveTask`'s rejections — INCLUDING its already-landed `archive_active_run` rejection, whose message must be pinned as already identical to the active-run error `onArchiveTask` returns (review correction PR #2983 round 2: `routeArchiveTask` already accepts `hasWorkflowRun`/`runActive` and returns that exact rejection, so no admission-primitive slice precedes the archive pipeline core — the former P15 was a no-op and is removed; slices renumber from here). Parallel-safe leaf.
- **Lands**: the shared predicates the complete pipelines consume are pinned before any change.
- **Excludes**: production changes.
- **Tests**: `packages/daemon/tests/unit/5-space/tools/space-tool-pipeline.test.ts`.
- **Depends on**: none.

### P15 — `feat(space): add complete task publish pipeline core (unwired)`

- ➕ additive core — prod Δ ≲100, test Δ ≸200
- **Scope**: One complete mixed publish pipeline (admission stages running `routePublishTask` as shared plain logic → `publishTask` effect stage → `space.task.updated` emission stage INSIDE the pipeline before its halt, all in the same composition, deps injected). NOT an admission-only runner with publications left in shells (review corrections rounds 21/23 — a shell effect would let callers skip the emission). Review correction (PR #2983): the emission stage is BEST-EFFORT with a local `.catch(...)` + log, matching today's publish-then-notify paths — the task is already committed, so an event-bus failure must NOT turn a successful mutation into a failed request (callers would retry an operation that now rejects because the task is no longer a draft). The same best-effort emission rule applies to the archive, approval, and update pipelines' publication stages. Parallel-safe leaf.
- **Lands**: the complete publish operation exists as a named pipeline; no caller wired.
- **Excludes**: RPC/tool/callback wiring (P16–P18).
- **Tests**: branch rows (reject not-found / not-in-space / not-draft; publish effect + emission ordering).
- **Depends on**: P14.

### P16 — `refactor(handlers): run spaceTask.publish on the publish pipeline`

- 🔧 apply — prod Δ ≲50, test Δ ≲100
- **Scope**: The `spaceTask.publish` handler in `space-task-handlers.ts` runs the P15 pipeline and maps its halt to the RPC response.
- **Lands**: the RPC publish operation is one complete pipeline.
- **Excludes**: tool and callback callers.
- **Tests**: `packages/daemon/tests/unit/2-handlers/rpc-handlers/space-task-handlers.test.ts`.
- **Depends on**: P15.

### P17 — `refactor(tools): run publish_task on the publish pipeline`

- 🔧 apply — prod Δ ≲50, test Δ ≲100
- **Scope**: The `publish_task` tool in `space-agent-tools.ts` runs the P15 pipeline; align its sync `taskRepo.getTask` lookup with the RPC's `taskManager.getTask` (pick one, per the doc's caveat). Review correction PR #2983 round 5: the tool shell RETAINS its success audit — `logAudit('publish_task', { previousStatus }, task_id)` from the admission snapshot — after the pipeline halts; only the response mapping and this audit stay in the shell.
- **Lands**: tool and RPC publish share the same complete composition.
- **Excludes**: `onPublishTask` (P18).
- **Tests**: `packages/daemon/tests/unit/5-space/runtime/space-agent-tools.test.ts`.
- **Depends on**: P15 (parallel-safe with P16).

### P18 — `refactor(space): run onPublishTask on the publish pipeline`

- 🔧 apply — prod Δ ≲40, test Δ ≲100
- **Scope**: The `onPublishTask` callback in `packages/daemon/src/lib/space/runtime/task-agent-manager.ts` runs the P15 pipeline (routing + publish effect + emission inside the composition).
- **Lands**: all three publish caller operations are complete pipelines; no shell duplicates the event emission.
- **Excludes**: the `space-task-operations.ts` shared-shell question (open question 5).
- **Tests**: `packages/daemon/tests/unit/5-space/agent/task-agent-manager-*.test.ts`.
- **Depends on**: P15.

### P19 — `feat(space): add complete task archive pipeline core (unwired)`

- ➕ additive core — prod Δ ≲90, test Δ ≲150
- **Scope**: One complete mixed archive pipeline consuming `routeArchiveTask` — whose `runActive` admission ALREADY EXISTS in `task-transition-routing.ts` (review correction PR #2983 round 2: no primitive slice builds it; the P14 pins cover the active-run reject and its message parity with `onArchiveTask`) — as plain-logic admission stages → `archiveTask` effect stage → `space.task.updated` emission stage. Parallel-safe leaf.
- **Lands**: the complete archive operation exists as a named pipeline; no caller wired.
- **Excludes**: tool and callback wiring (P20, P21).
- **Tests**: branch rows including the active-run reject with message parity.
- **Depends on**: P14.

### P20 — `refactor(tools): run archive_task on the archive pipeline`

- 🔧 apply — prod Δ ≲50, test Δ ≲100
- **Scope**: The `archive_task` tool in `space-agent-tools.ts` runs the P19 pipeline and maps the routing reject to its error response.
- **Lands**: the tool's archive operation is one complete pipeline.
- **Excludes**: `onArchiveTask` (P21).
- **Tests**: `packages/daemon/tests/unit/5-space/runtime/space-agent-tools.test.ts`.
- **Depends on**: P19.

### P21 — `refactor(space): run onArchiveTask on the archive pipeline`

- 🔧 apply — prod Δ ≲40, test Δ ≲100
- **Scope**: The `onArchiveTask` callback in `task-agent-manager.ts` runs the P19 pipeline; its active-run throw becomes the routing reject with the pinned message.
- **Lands**: both archive callers are complete pipelines.
- **Excludes**: `space-task-operations.ts` shared shells.
- **Tests**: `packages/daemon/tests/unit/5-space/agent/task-agent-manager-*.test.ts`.
- **Depends on**: P19 (parallel-safe with P20).

### P22 — `feat(handlers): add the one-pipeline spaceTask.update core (unwired)`

- ➕ additive core — prod Δ ≲150 (types/stage-dominated cap), test Δ ≲350
- **Scope**: ONE direct RPC update pipeline: the P13 validation helpers as early rejection/normalization stages; the RPC human-approval branch (`status: 'done'` on a `review` task stamps `approvalSource: 'human'`) AHEAD of the shared `routeTaskUpdate` predicates (kept as plain helper logic or inline gates — no routing `decisionRun`, no imported tool runner); branch effects `park_stopped`, `recover_transition`, `stop_for_status`, `set_status`, `fields_only` via injected deps; a fresh-task resnapshot + lock gate before EVERY effect that can persist `workflowModelOverrides`; `emitTaskUpdated`/`emitCascadedTasks` as guarded effect stages INSIDE the pipeline before its final halt (review correction round 23 — not a post-pipeline shell step, which splits the operation at its publication boundary). Parallel-safe leaf.
- **Lands**: the complete update operation exists as one composition; the handler still runs its old path.
- **Excludes**: handler rewiring (P23) and the tool's complete update pipeline (P24).
- **Tests**: branch/parity rows for every `plan.action` and the re-check-lock rows.
- **Depends on**: P13, P14.

### P23 — `refactor(handlers): run spaceTask.update on its single pipeline`

- 🔧 apply — prod Δ ≲100, test Δ ≸250
- **Scope**: Rewrite the `spaceTask.update` handler to execute the P22 pipeline; unify the dependency-added blocked-transition logic with the tool's `park_stopped`/`recover_transition` paths; align tool/RPC error wording; preserve the RPC-only preconditions.
- **Lands**: the whole update operation runs as one named pipeline.
- **Excludes**: `space-tool-pipeline.ts` changes (P24).
- **Tests**: `packages/daemon/tests/unit/2-handlers/rpc-handlers/space-task-handlers.test.ts`.
- **Depends on**: P22.

### P24 — `refactor(tools): run update_task as the tool's one complete pipeline`

- 🔧 apply — prod Δ ≲100, test Δ ≸250
- **Scope**: Review correction PR #2983 round 2 — REDEFINED from "align the admission runner's gate order": `space-tool-pipeline.ts` becomes the tool's COMPLETE update operation as ONE direct pipeline (autonomy gate → shared `routeTaskUpdate` predicates as early stages → the selected `plan.action` mutation effects `park_stopped`/`recover_transition`/`stop_for_status`/`set_status`/`fields_only` → the cascaded-task publications of today's `onCascadedTasks` emissions → the final publication stage, all before its halt). Review correction PR #2983 round 3: the final publication is NOT unconditional — it is guarded by the routing action's existing `emitTaskUpdated` metadata (`always` for `set_status`/`fields_only`, `only_with_field_updates` for `park_stopped`/`recover_transition`, `never` for `stop_for_status`), because the park/recover/stop runtime methods already publish `space.task.updated` via `safeOnTaskUpdated` themselves and an unconditional final stage would emit duplicate events and rerun lifecycle subscribers. `space-agent-tools.ts:update_task`'s imperative `switch` cascade after `decideUpdateTask` is deleted; the shell keeps `jsonResult` mapping and audit. Leaving the admission-only `decideUpdateTask` runner in place would keep the tool operation split across a `decisionRun` and imperative shell effects.
- **Lands**: the tool's whole update operation is one named composition; tool and RPC share gate order, pinned by parity tests feeding the same `TaskUpdateRoutingInput` to both callers.
- **Excludes**: publish/archive/approve flows.
- **Tests**: `packages/daemon/tests/unit/5-space/tools/space-tool-pipeline.test.ts` parity rows plus per-`plan.action` effect/publication rows, including the per-action emission-guard rows (no duplicate publication on park/recover/stop without field updates; none at all on `stop_for_status`).
- **Depends on**: P23.

**Phase 2 — staged effect flows with clear atomicity**

### P25 — `test(space): pin approve/reject behavior across tool and RPC shells`

- 📌 pins — prod Δ = 0, test Δ ≲250
- **Scope**: Pin the current dual-shell contract: approve sets `approved` then dispatches; a dispatch failure AFTER commit leaves the task `approved` with `postApprovalBlockedReason`; reject restores `in_progress` with a reason; `approvalSource`/`approvalReason` survive both shells; each shell publishes `space.task.updated`. Parallel-safe leaf.
- **Lands**: the state machine the shared pipeline must preserve is pinned before unification.
- **Excludes**: production changes.
- **Tests**: `packages/daemon/tests/unit/2-handlers/rpc-handlers/space-task-handlers.test.ts`, `packages/daemon/tests/unit/5-space/runtime/space-agent-tools.test.ts`.
- **Depends on**: none.

### P26 — `feat(space): add shared approve-pending-completion pipeline core (unwired)`

- ➕ additive core — prod Δ ≲150 (types/stage-dominated cap), test Δ ≲300
- **Scope**: New `packages/daemon/src/lib/space/runtime/approve-pending-completion-pipeline.ts`: `stagedRun('approve-pending-completion')` with DIRECT decide stages (`unauthorized`, `notFound`, `spaceMismatch`, `notPending`, `notReview`, approve/reject — no separately composed admission runner); `runtime.dispatchPostApproval` kept as the approval primitive (or `approvalSource`/`approvalReason` stamped in the initial write — state carries the source either way); an IN-STAGE catch on dispatch storing the error in a `dispatchError` external box ALLOCATED PER INVOCATION — created inside the exported per-call shell, never at module/runner scope (review correction PR #2983 round 2: a shared box lets two overlapping approvals cross-write `postApprovalBlockedReason` or miss a dispatch failure); a resnapshot that refreshes the task AND materializes the caught error into ctx so later guarded stages branch on the resnapshotted flag, never the box; guarded `record-blocked-reason`; the reject-path effects; ONE common final task resnapshot after the blocked-reason/reject writes (review correction PR #2983 round 2: without it the publication and halt reuse the post-dispatch task, so a rejected task publishes as still `review` and a dispatch-failure task omits `postApprovalBlockedReason`); and a guarded shared `publish-task-updated` stage emitting `space.task.updated` with that finally refreshed task after approving OR rejecting, ordered BEFORE the halt (review correction rounds 22/23 — a stage after the halt never executes, and a shell effect lets callers skip the publication). Parallel-safe leaf.
- **Lands**: the one approval/rejection state machine exists; both shells still run their old paths.
- **Excludes**: shell rewiring (P27, P28); post-approval routing internals (P43–P47).
- **Tests**: stagedRun contract rows for every branch, the dispatch-failure path, the shared publication, and an overlapping-approval row proving two concurrent invocations never cross-read each other's `dispatchError` box (review correction PR #2983 round 2).
- **Depends on**: P25.

### P27 — `refactor(tools): run approve_pending_completion on the shared pipeline`

- 🔧 apply — prod Δ ≲60, test Δ ≲100
- **Scope**: The tool shell validates `callerRole === 'coordinator' | 'legacy_task_agent'`, sets `callerMayApprove`, runs the P26 pipeline, maps to `jsonResult`; its `emitTaskUpdated` moves into the pipeline's publication stage.
- **Lands**: the tool approval path runs the shared pipeline.
- **Excludes**: the RPC shell (P28).
- **Tests**: `packages/daemon/tests/unit/5-space/runtime/space-agent-tools.test.ts`.
- **Depends on**: P26.

### P28 — `refactor(handlers): run spaceTask.approvePendingCompletion on the shared pipeline`

- 🔧 apply — prod Δ ≲50, test Δ ≸200
- **Scope**: The RPC shell sets `callerMayApprove = true`, runs the P26 pipeline, returns the final task; add the shared test module running identical inputs through BOTH shells (including the `approvalSource`/`approvalReason` row).
- **Lands**: tool and RPC share one state machine with no divergent preconditions or messages.
- **Excludes**: new shell-specific publications (they now live in the pipeline).
- **Tests**: `packages/daemon/tests/unit/2-handlers/rpc-handlers/space-task-handlers.test.ts` plus the shared cross-shell module.
- **Depends on**: P27 (for the cross-shell module).

### P29 — `test(space): pin registerSubscription's synchronous contract`

- 📌 pins — prod Δ = 0, test Δ ≲200
- **Scope**: Pin the current `registerSubscription` behavior in `packages/daemon/src/lib/space/runtime/space-runtime.ts`: synchronous completion with `result.success` inspected immediately by `registerRunInterests`; the `cannot register more than 10 event interests` throw; in-memory rollback on repo failure; replacement-at-capacity allowed (displaced entry removed before counting). Parallel-safe leaf.
- **Lands**: the sync API and rollback contract the pipeline must preserve are pinned.
- **Excludes**: production changes.
- **Tests**: `packages/daemon/tests/unit/5-space/runtime/space-runtime-list-subscriptions.test.ts`, `packages/daemon/tests/unit/5-space/runtime/space-runtime-workflow-subscription-persistence.test.ts`.
- **Depends on**: none.

### P30 — `feat(space): add synchronous registration pipeline and target gates (unwired)`

- ➕ additive core — prod Δ ≲150 (types-dominated cap), test Δ ≲300
- **Scope**: New `packages/daemon/src/lib/space/runtime/subscription-target-gates.ts` exporting `decideSubscriptionTarget` (`invalidTopic`, `missingRun`, `invalidTask`, `limitReached`, `proceed` — extracted from `validateSubscriptionTargetTask`, as direct branches not a separate runner), plus the direct SYNCHRONOUS `registerSubscriptionRun` (`superpipe` + `.end`; NOT `stagedRun`, which is async-only and would change the sync contract): snapshot gathers run/task/displaced/interest count MINUS the displaced entry; stages `remove-existing-trie-entry` → `insert-trie-entry` → `persist-subscription` with a shell-rollback hook (the sync pipeline has no compensation stack) → the FINAL GUARDED `redispatch-retained-events` effect with an IN-STAGE catch/log that swallows its errors (review correction PR #2983 round 5: the nudge belongs to the one registration operation — a future direct caller of the pipeline must not be able to skip it — and the in-stage catch makes it incapable of triggering the persist rollback); `.end` returns `{ success: false, error }` for every validation branch and `limitReached` throws after rollback. Parallel-safe leaf.
- **Lands**: the sync registration pipeline and its target gates exist unwired.
- **Excludes**: wiring `space-runtime.ts` (P31).
- **Tests**: gate table rows plus limit/replacement rows and a redispatch-throw row (swallowed in-stage; subscription stays persisted and in the trie).
- **Depends on**: P29.

### P31 — `refactor(space): run registerSubscription on the sync registration pipeline`

- 🔧 apply — prod Δ ≲60, test Δ ≲150
- **Scope**: `space-runtime.ts:registerSubscription` executes the P30 pipeline — including its final in-stage-caught `redispatch-retained-events` effect — inside its shell's explicit in-memory rollback (review correction PR #2983 round 5: the redispatch is the pipeline's own final guarded effect, not a shell step).
- **Lands**: registration stays synchronous with its exception contract; a redispatch throw can no longer leave a persisted-but-trie-missing subscription, and no caller can skip the nudge.
- **Excludes**: CAS-guarding `workflowEventSubscriptionRepo.upsert` beyond current behavior.
- **Tests**: the P29 suites plus a redispatch-throw row (subscription stays persisted and in the trie).
- **Depends on**: P30.

### P32 — `test(goals): pin outcome-claim admission semantics`

- 📌 pins — prod Δ = 0, test Δ ≲200
- **Scope**: Pin `claimOutcomeNotification` in `packages/daemon/src/lib/space/goals/goal-service.ts`: the already-applied check (`notification.status === params.dispositionStatus`) runs BEFORE admission and returns `already_applied` after authorization/identity checks; `deny`/`superseded` outcomes; admit applies the goal update and flips the notification status exactly once. Parallel-safe leaf.
- **Lands**: the claim contract (including idempotent retry) is pinned before the sync pipeline replaces the inline logic.
- **Excludes**: production changes.
- **Tests**: `packages/daemon/tests/unit/4-space-storage/space-goal-claim.test.ts`.
- **Depends on**: none.

### P33 — `feat(goals): add synchronous atomic claim pipeline (unwired)`

- ➕ additive core — prod Δ ≲120, test Δ ≲250
- **Scope**: Direct sync `superpipe` pipeline with `.end` shaped to run inside the existing `runAtomic` (never `stagedRun` — `endAsync` would commit the transaction early): gather loads notification/goal/`authorizedAgentIds`; decide runs authorization → identity gates IMPORTED directly from `claim-admission-gates.ts` (no `claimAdmissionRun` nesting), THEN the already-applied return for retries whose notification already carries `dispositionStatus` — which intentionally SKIPS revision validation — and the unsuperseded/revision gates run only on PENDING claims (review correction PR #2983: already-applied-first would classify an unauthorized retry as `already_applied`, and revision-before-already-applied would deny an authorized idempotent retry after the goal revision advances as `stale_revision`), halting ONLY on `deny` (a blanket `!decided` halt would no-op every admitted claim); guarded effect `apply-goal-update` (when `admit` and `mutatesGoalState`); `update-notification-status` guarded to `admit` only. Parallel-safe leaf.
- **Lands**: the atomic claim pipeline exists; `goal-service.ts` still runs its inline path.
- **Excludes**: wiring inside `runAtomic` (P34).
- **Tests**: gate-order rows, admit/deny/already-applied arms, no-redundant-write row.
- **Depends on**: P32.

### P34 — `refactor(goals): run claimOutcomeNotification on the sync claim pipeline`

- 🔧 apply — prod Δ ≲60, test Δ ≲100
- **Scope**: The `runAtomic` block in `goal-service.ts` executes the P33 pipeline; `params.apply` is not awaited if synchronous.
- **Lands**: the claim runs as one atomic named composition; P32 pins stay green.
- **Excludes**: `handleTaskTerminal` (P51–P53).
- **Tests**: `packages/daemon/tests/unit/4-space-storage/space-goal-claim.test.ts`.
- **Depends on**: P33.

### P35 — `feat(tools): add review-goal-outcome staged core (unwired)`

- ➕ additive core — prod Δ ≸90, test Δ ≸200
- **Scope**: `stagedRun('review-goal-outcome')`: snapshot validates `hasGoalUpdate` vs `disposition` rules AND the claim path's required-identifier gate (missing `goal_id`/`task_id` → the exact current validation response) plus the in-space goal gate (`requireGoalInSpace` equivalent) before any claim effect (review correction PR #2983 round 5); `decideReviewGoalOutcomeMode` branches `discover`/`claim`; the claim branch performs ONE effect calling `goalService.claimOutcomeNotification` (after P34, the same sync claim pipeline) — never re-inlining `decideClaimAdmission` outside the service's atomic boundary — whose result is stored in a `claimResult` EXTERNAL MUTABLE BOX ALLOCATED PER INVOCATION (created inside the exported per-call shell, never module/runner scope — `stagedRun` effects return only `void`/`won`/`superseded` and receive a shallow-copied view, so the halt cannot otherwise return the `claimed`/`already_applied`/`denied` verdict), followed by a `resnapshot` copying the box into ctx before the halt; `discover` lists claimable notifications and halts. Parallel-safe leaf.
- **Lands**: the discovery/claim tool flow exists as one staged composition whose halt can return the claim verdict.
- **Excludes**: tool rewiring (P36).
- **Tests**: mode rows plus claim delegation rows, and an overlapping-claims row proving two concurrent invocations never cross-return each other's verdict through the box.
- **Depends on**: P34.

### P36 — `refactor(tools): run review_goal_outcome on its staged pipeline`

- 🔧 apply — prod Δ ≲60, test Δ ≲100
- **Scope**: The `review_goal_outcome` handler in `space-agent-tools.ts` executes the P35 pipeline; atomicity stays inside the service's `runAtomic`.
- **Lands**: both tool modes run one named composition.
- **Excludes**: changes to the service's claim internals (already final in P34).
- **Tests**: `packages/daemon/tests/unit/4-space-storage/space-goal-claim.test.ts`, `packages/daemon/tests/unit/5-space/runtime/space-agent-tools.test.ts`.
- **Depends on**: P35.

### P37 — `test(goals): pin goal-automation admission and schedule-sync behavior`

- 📌 pins — prod Δ = 0, test Δ ≲350 (split by family: admission decision table rows vs schedule-sync behavior rows)
- **Scope**: Pin `onTaskCompleted` (admission table; `ambiguous_scope` returned BEFORE `resolveScopeForTask` when no explicit scope and multiple scopes exist; `below_threshold` carries `count`), `onSelfNag` (first-scope fallback — `resolveScopeForGoal` never returns null for multiple scopes; explicit-scope validation only), and `syncGoalAutomationSelfNagScheduleForScope` (`pauseAllNoGoal` only when `scope.spaceGoalId` is absent; missing/inactive referenced goal is a NO-OP; stale-schedule orphan pause coexists with `update`/`create`; every pause goes through `pauseScheduleStrict` — benign on an already missing/non-active schedule, throwing on a lost pause CAS — review correction PR #2983 round 4). Parallel-safe leaf.
- **Lands**: the admission tables and schedule-sync semantics the pipelines must preserve are pinned.
- **Excludes**: production changes.
- **Tests**: `packages/daemon/tests/unit/5-space/goal-automation-service.test.ts`, `packages/daemon/tests/unit/2-handlers/job-handlers/task-schedule-fire.handler.test.ts`.
- **Depends on**: none.

### P38 — `feat(goals): add goal-automation admission pipelines with enqueue effects (unwired)`

- ➕ additive core — prod Δ ≲150 (types-dominated cap), test Δ ≲300
- **Scope**: New `goal-automation-admission-pipeline.ts` with TWO complete DIRECT SYNCHRONOUS `superpipe` pipelines using `.end` (review correction PR #2983: `onTaskCompleted` is invoked synchronously inside `handleTaskTerminal`'s `runAtomic` block and P52 keeps it a synchronous best-effort effect — a `stagedRun`/`.endAsync` composition would return a Promise the transaction never awaits, enqueueing after commit with rejections bypassing the surrounding try/catch; same discipline as the schedule-sync and goal-service sections): `onTaskCompleted` (snapshot reads evidence/cursor inputs; admission gates `notApplicable`, `disabled`, `ambiguousScope` (ambiguity flag snapshotted separately, winning over `missingScope`), `missingScope`, `belowThreshold` (carries `count`), `proceed`; guarded `enqueue` effect stage in the SAME composition) and `onSelfNag` (gates `disabled`, `missingScope`, `notApplicable`, `proceed`; guarded `enqueue` stage). No admission-only variant with an imperative `if (proceed) enqueue` outside (review corrections). Parallel-safe leaf.
- **Lands**: both automation operations exist as one-pipeline compositions with their job-queue effects.
- **Excludes**: service rewiring (P39, P40).
- **Tests**: the P37 admission tables re-run against the pipelines, independent of the job queue.
- **Depends on**: P37.

### P39 — `refactor(goals): run onTaskCompleted on its complete pipeline (admission + enqueue effect)`

- 🔧 apply — prod Δ ≲50, test Δ ≲100
- **Scope**: `goal-automation-service.ts:onTaskCompleted` gathers inputs, runs the P38 pipeline once, returns its `GoalAutomationEnqueueResult`.
- **Lands**: the completed-task automation enqueue is one named composition.
- **Excludes**: `onSelfNag` (P40).
- **Tests**: `packages/daemon/tests/unit/5-space/goal-automation-service.test.ts`.
- **Depends on**: P38.

### P40 — `refactor(goals): run onSelfNag on its complete pipeline (admission + enqueue effect)`

- 🔧 apply — prod Δ ≲50, test Δ ≲100
- **Scope**: `goal-automation-service.ts:onSelfNag` gathers inputs and runs its P38 pipeline; the first-scope fallback contract from P37 is preserved.
- **Lands**: both automation paths are migrated.
- **Excludes**: schedule sync (P41, P42).
- **Tests**: `packages/daemon/tests/unit/5-space/goal-automation-service.test.ts`.
- **Depends on**: P38 (parallel-safe with P39).

### P41 — `feat(goals): add synchronous self-nag schedule-sync pipeline (unwired)`

- ➕ additive core — prod Δ ≲120, test Δ ≲250
- **Scope**: Direct sync `selfNagScheduleSyncRun` (`superpipe` + `.end`, synchronous effects) for `syncGoalAutomationSelfNagScheduleForScope`: gather lists schedules/goal/policy; PRELIMINARY unconditional `pause-orphan-schedules` effect (not a decision branch — it coexists with `update`/`create`); decide stage selects the current-schedule branch (`pauseAllNoGoal`, `missingGoalNoOp`, `pauseNoCron`, `update`, `create`, `noOp`) with goal-reference state carried separately and NO `!branchDecided` halt (a `!dep` halt would skip the guarded mutations after orphan cleanup); guarded mutation effects call `scheduleService` — with EVERY pause arm routed through `pauseScheduleStrict` (review correction PR #2983 round 4: benign on an already missing/non-active schedule, THROWING when a lost pause CAS leaves it active, so the transaction cannot proceed to update/create and run two self-nag schedules at once — a bare `pauseSchedule` stage loses that concurrency contract). Parallel-safe leaf.
- **Lands**: the schedule-sync flow exists as one sync composition ready to run inside the transaction.
- **Excludes**: wiring the service (P42).
- **Tests**: branch rows including orphan-plus-update coexistence and missing-vs-absent goal distinction, plus a concurrent-fire/reschedule row (a pause CAS lost to a concurrent fire throws; a benign disappearance does not).
- **Depends on**: P37.

### P42 — `refactor(goals): run schedule sync on the sync pipeline inside its transaction`

- 🔧 apply — prod Δ ≲60, test Δ ≲150
- **Scope**: `goal-automation-schedule-sync.ts` composes the P41 pipeline inside the optional `db.transaction` (`.end` executes synchronously within it — `stagedRun` would commit when its Promise is returned); best-effort when `db` is absent.
- **Lands**: orphan pauses can no longer commit without the replacement schedule.
- **Excludes**: new CAS semantics on `scheduleService`.
- **Tests**: the P37 suites plus a mid-flow-throw-with-`db` row (no partial pause/update commits).
- **Depends on**: P41.

**Phase 3 — heavyweight staged flows**

### P43 — `test(space): pin post-approval routing branches`

- 📌 pins — prod Δ = 0, test Δ ≲300
- **Scope**: Pin `PostApprovalRouter.route` branch behavior: `multiRoutes` WARNS and continues with the first route (never a terminal branch); `no-route` terminalization via `goalService.handleTaskTerminal`; dead-previous-session fall-through that spawns a replacement overwriting the stale ID; expected spawn failures (`isSpawnSupersededError`/`isTransientSpawnError`) clearing pending-completion fields and recording `postApprovalBlockedReason`. Parallel-safe leaf.
- **Lands**: the routing contract (including the concurrency gaps the CAS will close) is pinned.
- **Excludes**: production changes.
- **Tests**: `packages/daemon/tests/unit/5-space/runtime/post-approval-router.test.ts`, `packages/daemon/tests/unit/5-space/runtime/post-approval-routing-integration.test.ts`.
- **Depends on**: none.

### P44 — `feat(space): add claimPostApprovalDispatch reservation CAS primitive (unwired)`

- ➕ additive core — prod Δ ≲80, test Δ ≲200
- **Scope**: New task-repo primitive `claimPostApprovalDispatch`: a conditional update where `status = 'approved'` AND the dispatch slot is claimable — `postApprovalSessionId` is NULL, OR it holds the EXACT dead session ID observed by the caller's liveness probe (so dead-session retries do not lose the CAS forever), OR any existing reservation token is EXPIRED (past its expiry timestamp — review correction PR #2983 round 3: a holder that dies between `reserve-dispatch` and spawn/release never runs its compensation, and the durable token stays; rejecting on any existing token leaves the approved task permanently blocked, while ignoring tokens entirely permits concurrent spawns, so an expired token must be ATOMICALLY replaceable by a fresh claim); plus the conditional (token-scoped) release. Review correction PR #2983 round 5: expiry-based takeover is safe ONLY with a spawn-bound fence — the token's TTL must STRICTLY EXCEED a hard upper bound on the spawn (the route pipeline wraps `spawnPostApprovalSubSession` in a deadline shorter than the TTL, mirroring the activation pipeline's bounded spawn; today's spawner has NO deadline, so an unbounded spawn could outlive the token and let another router double-spawn while the first session is still being created/attached/injected), or the holder must renew the lease while the spawn is live; the primitive's contract states the TTL > spawn-bound invariant. Review correction (PR #2983): the reservation token must be stored in a SEPARATE durable field (e.g. `post_approval_dispatch_token` + expiry) with its schema migration — NEVER in `postApprovalSessionId`: a token stored there is observed by concurrent callers as a session with no live process, satisfies the "exact dead session ID" replacement condition, and lets the second caller overwrite the first claim and spawn a second session — the exact race this primitive closes. Reservation-form values are ineligible for dead-session replacement by construction (only by expiry).
- **Lands**: the reservation primitive the route pipeline requires exists and is tested in isolation.
- **Excludes**: any caller.
- **Tests**: CAS unit rows: win, lose, dead-ID clear-and-claim, token-scoped release, a row proving a LIVE reservation token is NOT treated as a dead session ID (no replacement while the claim is in flight), an EXPIRED-RESERVATION TAKEOVER row (a token past its expiry is atomically replaced by the new claim with no concurrent-spawn window — review correction PR #2983 round 3), and a TTL-FENCING row (the expiry strictly exceeds the spawn deadline, so takeover can never fire while a bounded spawn is still live — review correction PR #2983 round 5).
- **Depends on**: P43.

### P45 — `feat(space): add post-approval route stages for admission and reservation (unwired)`

- ➕ additive core — prod Δ ≲150 (types/stage-dominated cap), test Δ ≲250
- **Scope**: First stage set of the route pipeline: `PostApprovalRouteState`; routing branches as DIRECT decide stages (`notApproved`, `noRoutes`, `alreadyRouted`, `missingWorkflow`, `emptyInstructions`, `proceed`) with `multiRoutes` stamped as a nonterminal `warnings` annotation carrying `routes[0]` AND a guarded `emit-warnings` logging effect before `reserve-dispatch` that logs every accumulated warning (review correction PR #2983 round 5: the current router warns about extra dispatchable routes; an annotation nothing consumes silently drops it); `terminalize-no-route` delegating to `goalService.handleTaskTerminal` with the direct update + fallback evidence capture ONLY on a `null` return; `reserve-dispatch` running the P44 CAS BEFORE any spawn, with `compensate` releasing the claim ONLY pre-spawn — the guard consults the EXTERNAL spawn box and the verified-termination result, never its captured stage view (review correction round 23: `stagedRun` compensations receive the view captured when `reserve-dispatch` completed, before the spawn, so a view-captured guard would release the claim while the spawned session is live or its termination is unverified).
- **Lands**: the admission and reservation half of the route flow exists as pipeline stages.
- **Excludes**: spawn/dispatch stages and the composed `stagedRun` (P46); router wiring (P47).
- **Tests**: branch rows for every decide stage, the multi-route warning emission row, and the reservation compensation guard.
- **Depends on**: P44.

### P46 — `feat(space): add post-approval spawn/dispatch stages and compose the route pipeline (unwired)`

- ➕ additive core — prod Δ ≲150 (types/stage-dominated cap), test Δ ≲350
- **Scope**: Remaining stages plus the SINGLE `stagedRun('post-approval-route')` composition (one pipeline per business path — it lands whole here): `spawn-post-approval-sub-session` wrapped in a DEADLINE SHORTER THAN THE RESERVATION TTL (review correction PR #2983 round 5: without a bound, a slow spawn outlives the token and another router's expiry takeover double-spawns; a deadline-bounded race or lease renewal keeps expiry takeover fenced), catching EXPECTED failures in-stage (diverting to the clear/block/skip branch) and compensating UNEXPECTED failures by terminating the spawned session (the claim is non-releasable post-spawn); the spawned session ID/start time written to a `SpawnAttemptBox`-style EXTERNAL mutable box; `resnapshot` copying them into ctx; `record-dispatched-session` converting the reservation via the same CAS, whose loss terminates THIS caller's session and CONDITIONALLY RELEASES the claim after verified termination.
- **Lands**: the complete post-approval route pipeline exists unwired, with its asymmetric compensations.
- **Excludes**: router wiring (P47).
- **Tests**: contract rows — concurrent-caller race (second caller halts at `reserve-dispatch`, no session spawned), dead-session replacement, spawn compensation, and the round-4 conditional release (claim never left durably held with no live session).
- **Depends on**: P45.

### P47 — `refactor(space): run PostApprovalRouter.route on the staged pipeline`

- 🔧 apply — prod Δ ≲80, test Δ ≲150
- **Scope**: The `PostApprovalRouter` shell gathers the snapshot and executes the P46 pipeline with its deps; the imperative if-cascade is deleted.
- **Lands**: the most effect-heavy routing site is one named composition; P43 pins stay green.
- **Excludes**: changes to `goalService.handleTaskTerminal` itself (P51–P53).
- **Tests**: `post-approval-router.test.ts`, `post-approval-routing-integration.test.ts`.
- **Depends on**: P46.

### P48 — `test(space): pin activation routing classification`

- 📌 pins — prod Δ = 0, test Δ ≲250
- **Scope**: Pin `decideActivationRouting` in `packages/daemon/src/lib/space/runtime/activation-routing.ts`: `reuseInProgressOrBlocked` returns `reuse_existing` ONLY with a LIVE `agentSessionId` (dead `in_progress`/`blocked` executions must classify toward reset, not spawn); `rejectUndeclared`; `returnEmpty`; `spawn`; plus the caller's three invocation points around reset/activation/resnapshot/spawn. Review correction PR #2983 round 3 — ALSO pin the operation-level facts the complete pipeline must preserve: the operation AWAITS `tryResumeNodeAgentSession` FIRST (an indexed persisted session gets its pending messages flushed; an unindexed one is rehydrated) BEFORE the execution/liveness snapshot that feeds classification, so a restorable session classifies as reusable rather than dead; and the spawn arm races `spawnWorkflowNodeAgentForExecution` against a 30-second `unref`'ed timeout (`clearTimeout` in `finally`), mapping BOTH the timeout and a superseded spawn error to the benign empty result (logged), with other spawn errors rethrown; and the reset arm DELETES the non-live `agentSessionId` from `agentSessionIndex` BEFORE the reset CAS (review correction PR #2983 round 4 — a leftover index entry makes a later resume flush pending messages to the dead session instead of rehydrating it). Parallel-safe leaf.
- **Lands**: the classification table — including the dead-worker recovery row and the resume-first/timeout/supersession outcome rows — is pinned before the operation migrates.
- **Excludes**: production changes.
- **Tests**: `packages/daemon/tests/unit/5-space/runtime/activation-routing.test.ts` plus the activation-timeout/resume suites that exist today (retained verbatim by P50).
- **Depends on**: none.

### P49 — `feat(space): add the complete activation operation pipeline (unwired)`

- ➕ additive core — prod Δ ≲150 (types/stage-dominated cap), test Δ ≸300
- **Scope**: New `packages/daemon/src/lib/space/runtime/activation-routing-pipeline.ts` hosting the COMPLETE `activateTargetSessionsForMessage` operation as ONE mixed/resnapshot pipeline. Review correction PR #2983 round 3 — the effect inventory is: (a) the RESUME/REHYDRATION effect first (`tryResumeNodeAgentSession`: flush pending messages for an indexed persisted session, or rehydrate the unindexed one) followed by a FRESH execution/liveness snapshot before any classification — omitting it lets a restorable session classify as dead, get reset, and be replaced by a duplicate spawn; (b) the STALE-INDEX CLEANUP plus reset CAS — DELETE the non-live `agentSessionId` from `agentSessionIndex` BEFORE the `casExecutionStatus`-to-`pending` CAS (review correction PR #2983 round 4: skipping the deletion leaves the dead session indexed, so a later resume attempt flushes pending messages to it instead of rehydrating; superseded CAS → benign empty), (c) workflow activation, (d) resnapshot, and (e) the BOUNDED spawn stage: race the spawn against the 30-second `unref`'ed timeout with `clearTimeout` in `finally`, map timeout AND superseded spawn errors to the logged benign empty result, rethrow other spawn errors — never an unqualified await. `decideActivationRouting` is RETAINED as the exported plain classification helper the pipeline's stages call (with the dead-worker `reset_pending_and_continue` behavior) — no standalone `activation-routing` `decisionRun` executing three nested runners. The normalized-to-`null` `existing` fact is preserved in the input snapshot.
- **Lands**: the complete activation business path exists as one composition.
- **Excludes**: `TaskAgentManager` wiring (P50); the `activateNode` effect inside `send_message_to_task` (P55–P57).
- **Tests**: stage rows for reset/activation/spawn arms reusing the P48 table, plus rows for the resume-before-classification ordering, the stale-index cleanup before the reset CAS, and the timeout/supersession spawn outcomes.
- **Depends on**: P48.

### P50 — `refactor(space): run activateTargetSessionsForMessage on its pipeline`

- 🔧 apply — prod Δ ≲80, test Δ ≸150
- **Scope**: `task-agent-manager.ts` activation logic delegates to the P49 pipeline; the imperative outer cascade is deleted. Review correction PR #2983 round 3: the apply RETAINS the existing activation-timeout and resume/rehydration suites verbatim — they are the contract that the pipeline's bounded spawn and resume-first stages must keep satisfying.
- **Lands**: activation is one named composition; the P48 pins stay green.
- **Excludes**: direct-steer flush (already migrated — no slices; review correction PR #2983).
- **Tests**: `packages/daemon/tests/unit/5-space/runtime/activation-routing.test.ts` extended to the wired operation, plus the retained activation-timeout suite.
- **Depends on**: P49.

### P51 — `test(goals): pin handleTaskTerminal contract`

- 📌 pins — prod Δ = 0, test Δ ≲300
- **Scope**: Pin `handleTaskTerminal` in `goal-service.ts`: foreign-space goal returns `null` before `runAtomic`; nonterminal transitions return the structured result (current goal, `nextTask: null`, `terminalGeneration`, `notification: null`); an existing `terminalGeneration` notification makes the retry return BEFORE clearing the active task or repeating any bookkeeping; Forge evidence capture and goal automation are best-effort with local catches; next-task creation runs inside its NESTED `db.transaction` savepoint, so a mid-creation failure rolls back its own partial writes while the notification is still recorded (review correction PR #2983 round 3); post-commit `emitTaskCreated`/`onOutcomeNotification` honoring `deferPostCommitEffects`. Parallel-safe leaf.
- **Lands**: the most complex goal chain's contract is pinned.
- **Excludes**: production changes.
- **Tests**: `packages/daemon/tests/unit/4-space-storage/space-goal-service.test.ts`, `packages/daemon/tests/unit/5-space/runtime/goal-outcome-wake-flip.test.ts`.
- **Depends on**: none.

### P52 — `feat(goals): add synchronous handleTaskTerminal pipeline core (unwired)`

- ➕ additive core — prod Δ ≲150 (types/stage-dominated cap), test Δ ≲350
- **Scope**: Direct sync `handleTaskTerminalRun` (`superpipe` + `.end`, synchronous effects, shaped to run inside `runAtomic` — never `stagedRun`): admission gates (missing task/goal halt; goal-space mismatch returns `null`; nonterminal stamps the structured result BEFORE halting); the PLAIN terminal-status check as the decide stage (NOT `decideReportableTerminal`, which is invoked only at the notification stage); `update-task` → resnapshot → `already-notified` halt → `clear-active-task`, `record-goal-event`, best-effort `capture-evidence`/`run-automation` (local catch boundaries retained), best-effort `create-next-task` INSIDE its existing NESTED `db.transaction` savepoint (review correction PR #2983 round 3: a caught failure without the savepoint still commits the creation's partial task/goal writes into the outer transaction — orphan task or inconsistent active-task pointer), resnapshot, `record-outcome-notification`; state carries `deferPostCommitEffects`.
- **Lands**: the complete terminal bookkeeping chain exists as one sync composition.
- **Excludes**: wiring inside `runAtomic` and the post-commit shell (P53); any `runAtomic` async conversion (off the table).
- **Tests**: stage rows for every arm, the idempotent-retry halt, the best-effort catch boundaries, and a next-task savepoint row (a creation that throws mid-way leaves no partial task/goal writes behind).
- **Depends on**: P51.

### P53 — `refactor(goals): run handleTaskTerminal on the sync atomic pipeline`

- 🔧 apply — prod Δ ≲80, test Δ ≸200
- **Scope**: The `runAtomic` block executes the P52 pipeline using transaction-bound repo methods; the post-commit shell keeps `emitTaskCreated` and `onOutcomeNotification` with the `setImmediate` deferral when `transition.deferPostCommitEffects` is set.
- **Lands**: terminal transitions are one atomic named composition; migrated goal progress keeps waking subscribers.
- **Excludes**: in-flow retries.
- **Tests**: `space-goal-service.test.ts`, `goal-outcome-wake-flip.test.ts`, plus nonterminal and already-notified parity rows.
- **Depends on**: P52.

### P54 — `test(tools): pin send_message_to_task delivery arms`

- 📌 pins — prod Δ = 0, test Δ ≲350 (split by family: target-resolution arms vs delivery-mode arms)
- **Scope**: Pin `send_message_to_task` in `space-agent-tools.ts`: target disambiguation (`task_id`/`task_number`), the DEPRECATED `task-agent` target rejection for BOTH input forms (`target === 'task-agent'` and `node_id === 'task-agent'`, at its current precedence after the space/archived gates — review correction PR #2983 round 5), long-horizon handle resolution, worker activation, queue fallback, the stale-live-session `inject` throw falling through `activateNode` → reinject, the MISSING-ACTIVATION-CALLBACK arm (no live session and no `activateNode` configured → the specific `activation_callback_missing` failure with no activation attempt and no queueing — review correction PR #2983 round 3), the caught `activateNode` failure returning `{ success: false, error }`, the OPTIONAL-DEPENDENCY FALLBACKS (an `@handle`/`@role` target without the long-term resolver/delivery dependencies → the `long_term_agent_messaging_unavailable` failure; activation with no session and no `pendingMessageQueue` → SUCCESS with `queued: false` and the `Retry after the node starts.` message — review correction PR #2983 round 4), and the `replyRoutingRegistry.set(task.id, mySessionId, resolved.agentName)` entry worker replies depend on — INCLUDING that it is written only on the node-execution arms and NOT on the long-term `@handle`/`@role` arm, whose replies ride the envelope's `replyToSessionId`/`replyTargetHandle` instead (review correction PR #2983 round 2). Parallel-safe leaf.
- **Lands**: every delivery arm — especially the reply-routing pin — is characterized before the cascade is replaced.
- **Excludes**: production changes.
- **Tests**: `packages/daemon/tests/unit/5-space/runtime/space-agent-tools.test.ts`.
- **Depends on**: none.

### P55 — `feat(tools): add deliver-task-message target-admission core (unwired)`

- ➕ additive core — prod Δ ≲150 (types/stage-dominated cap), test Δ ≲250
- **Scope**: First half of the ONE `deliver-task-message` pipeline: `DeliverTaskMessageState`; snapshot stages running the target parse (`ParsedAddress`), handle resolution, and execution resolution; the target-admission gates (`task_id`/`task_number`, space, archived, the deprecated `task-agent` target rejection at its pinned precedence for both input forms — review correction PR #2983 round 5, target presence, workflow run) as direct inline stages; and the effect recording `replyRoutingRegistry.set(...)` on the NODE-EXECUTION path only — after the node-resolution gates, before the `injectLive`/activation/`queue` arms, and never on the `deliverLongTerm` arm where `resolved` is null and replies ride the envelope's reply handle (review correction PR #2983 round 2).
- **Lands**: the admission half of the delivery business path exists as pipeline stages.
- **Excludes**: delivery-mode gates and effect arms (P56); tool wiring (P57).
- **Tests**: admission rows (including both deprecated `task-agent` input forms) plus the reply-routing parity pin (node arms write the registry; the long-term arm does not).
- **Depends on**: P54.

### P56 — `feat(tools): add deliver-task-message delivery-mode stages and compose the pipeline (unwired)`

- ➕ additive core — prod Δ ≲150 (types/stage-dominated cap), test Δ ≸350
- **Scope**: Remaining stages plus the single composed `deliver-task-message` pipeline (ONE pipeline — no nested `decisionRun`s): self-guarding delivery-mode gates (`injectLive`, `activateAndInject`, `queue`, `deliverLongTerm`, first match wins); guarded effect arms `deliverToSpaceAgent` behind an AVAILABILITY GATE (no `messageResolver`/`longTermAgentDelivery` → the exact `long_term_agent_messaging_unavailable` failure — review correction PR #2983 round 4), `injectLive` (a stale-live-session throw diverts into activation via an `inject-failed` branch or in-stage catch), an `activate` AVAILABILITY GATE (no live session AND no `activateNode` configured → the exact `activation_callback_missing` failure response, no activation attempt, no queueing — review correction PR #2983 round 3) ahead of the `activate` arm with its explicit caught-failure branch, `resnapshot` after activation, `injectAfterActivation`, and an OPTIONAL `queue` stage (absent `pendingMessageQueue` after an activation without a session → SUCCESS with `queued: false` and the pinned retry message — review correction PR #2983 round 4); `halt` returning `DeliverTaskMessageResult`. Activation is not compensable — current fallback semantics are preserved.
- **Lands**: the complete delivery pipeline exists unwired.
- **Excludes**: folding `AgentMessageRouter` into the pipeline (long-term delivery keeps delegating); tool wiring (P57).
- **Tests**: arm rows for inject/activate/queue fallback, the stale-live-session divert, the missing-callback gate row, and both optional-dependency fallback rows (long-term deps absent; no queue configured).
- **Depends on**: P55.

### P57 — `refactor(tools): run send_message_to_task on the deliver-task-message pipeline`

- 🔧 apply — prod Δ ≲100, test Δ ≲150
- **Scope**: The tool handler executes the P56 pipeline; `auditing` and `jsonResult` mapping stay in the shell.
- **Lands**: the tool's if-cascade is one named composition; P54 pins stay green.
- **Excludes**: the task-lookup admission core (already final in P10/P11).
- **Tests**: `packages/daemon/tests/unit/5-space/runtime/space-agent-tools.test.ts`.
- **Depends on**: P56.

### P58 — `test(events): pin deferred fold behaviors`

- 📌 pins — prod Δ = 0, test Δ ≲250
- **Scope**: Pin both folds in `packages/daemon/src/lib/external-events/deferred-event-digest.ts`: the no-digest-rows halt; deterministic-UUID idempotency (a re-run finds the existing fold row); the supersede-then-save-then-mark ordering; the overflow cap boundary; fold-vs-raw selection. Parallel-safe leaf.
- **Lands**: the idempotency and ordering contracts are pinned.
- **Excludes**: production changes.
- **Tests**: `packages/daemon/tests/unit/4-space-storage/storage/deferred-event-digest.test.ts`.
- **Depends on**: none.

### P59 — `feat(events): add fold-deferred-at-flush staged core (unwired)`

- ➕ additive core — prod Δ ≲120, test Δ ≲250
- **Scope**: `stagedRun('fold-deferred-at-flush')` with `FlushFoldState`: `partitionDeferredExternalEventRows` as the first decide stage (halts `no-fold` on empty `digestRows`); effects `supersede-stale-folds` → `save-fold-row` (idempotent, deterministic UUID, return stored via an EXTERNAL MUTABLE BOX ALLOCATED PER INVOCATION — created inside the exported per-call shell, never module/runner scope, per review correction PR #2983 round 3 — followed by a `resnapshot` — `stagedRun` effects return only `void`/`won`/`superseded` and receive a shallow-copied view) → `mark-sources-superseded`; `halt` returns `DeferredEventDigestFlushResult`.
- **Lands**: the flush fold exists as one staged composition.
- **Excludes**: wiring (P60); the optional single `foldDeferredRows` repo primitive (open question 4).
- **Tests**: staged rows — no digest rows, duplicate deterministic UUID, failure after save before mark, and an overlapping-flush row proving two concurrent invocations never cross-return each other's saved digest row through the box (review correction PR #2983 round 3).
- **Depends on**: P58.

### P60 — `refactor(events): run flush folding on the staged pipeline`

- 🔧 apply — prod Δ ≲60, test Δ ≲100
- **Scope**: `foldDeferredExternalEventsAtFlush` executes the P59 pipeline with `DeferredEventDigestRowOps` injected as a dep; the flush loop stays outside.
- **Lands**: the flush fold is one named composition; P58 pins stay green.
- **Excludes**: the overflow fold (P61, P62).
- **Tests**: `deferred-event-digest.test.ts` including the overflow interaction row.
- **Depends on**: P59.

### P61 — `feat(events): add fold-deferred-overflow staged core (unwired)`

- ➕ additive core — prod Δ ≲100, test Δ ≸200
- **Scope**: `stagedRun('fold-deferred-overflow')` with `OverflowFoldState`: `planDeferredExternalEventOverflow` as the decide stage (`noOverflow` halts with `null`); `save-overflow-envelope` storing the saved envelope (`dbId` + UUID-adjusted message) in an external mutable box ALLOCATED PER INVOCATION — created inside the exported per-call shell and captured by that invocation's closure, NEVER at module scope (review correction PR #2983: a reusable runner shares a module-scope box across concurrent folds, so two sessions folding at once overwrite each other between save and resnapshot and one result returns the other's `dbId`/message); `mark-overflow-superseded`; a `resnapshot` copying the saved envelope back into ctx; `halt` returns `DeferredEventOverflowFoldResult`.
- **Lands**: the overflow fold exists as one staged composition with the same external-box discipline.
- **Excludes**: wiring (P62).
- **Tests**: cap-boundary and fold-vs-raw rows.
- **Depends on**: P59 (shares the box pattern and module).

### P62 — `refactor(events): run overflow folding on the staged pipeline`

- 🔧 apply — prod Δ ≲50, test Δ ≲80
- **Scope**: `foldDeferredExternalEventOverflow` executes the P61 pipeline.
- **Lands**: both deferred folds are named compositions; P58 pins stay green.
- **Excludes**: the transactional repo primitive (open question 4).
- **Tests**: `deferred-event-digest.test.ts`.
- **Depends on**: P61.

**Trailing cleanup**

### P63 — `chore(space): remove migration shims and superseded helpers`

- cleanup — prod Δ ≲100, test Δ ≲50
- **Scope**: Delete the superseded `validateWorkflowModelOverrides` body and any imperative remnants the applies left behind (e.g. `validateSubscriptionTargetTask` if still exported); sweep for orphaned helpers. Review correction PR #2983 round 2: no deprecated `resolveNodeAgentTargets` re-export exists to delete — P6/P7 keep the helper plain under its own name, so the resolver has no cleanup item. Add an ADR note only if one of the doc's open questions (4 or 5) resolves into a decision during implementation.
- **Lands**: only the pipeline-based paths remain.
- **Excludes**: behavior changes.
- **Tests**: full affected suites stay green.
- **Depends on**: the FINAL apply slice for every helper/remnant it removes — P23 (`validateWorkflowModelOverrides` callers), P31 (subscription wiring), P42 (schedule-sync remnants — the schedule-sync apply slice, NOT a message-delivery slice; review correction PR #2983 round 2), P53 (`handleTaskTerminal`), P57 (send_message_to_task delivery remnants, if the sweep finds any), P62 (overflow fold) — not merely the last heavyweight slices (review correction PR #2983; numbering after the direct-steer and archive-admission slice removals).

---

## Open questions

1. ~~**Async `stagedRun` inside synchronous `runAtomic`**~~ Resolved by review: keep both as sync `superpipe` pipelines with `.end` inside the existing `runAtomic`. Converting `runAtomic` to an async variant is OFF the table — `stagedRun` returns a Promise, the SQLite transaction wrapper is synchronous, and either option commits before the task/goal/notification writes finish, breaking terminal-generation deduplication.
2. ~~**Goal-service transaction boundaries**~~ Resolved by review: `handleTaskTerminal` never becomes a `stagedRun` outside the transaction. The sync pipeline's effect stages run inside `runAtomic` and use the transaction-bound repo methods; atomicity comes from the transaction, not from the pipeline.
3. ~~**Post-approval router atomicity and CAS**~~ Resolved by review: yes — the tokenized `claimPostApprovalDispatch` reservation (with the verified-release rules in the steps above) is REQUIRED, not optional; retaining the current blind update lets two concurrent `route` calls both pass the snapshot, spawn separate live sessions, and overwrite the task row.
4. **Deferred digest atomic primitive**: Should `foldDeferredExternalEventsAtFlush` and `foldDeferredExternalEventOverflow` be backed by a single `foldDeferredRows` repository primitive that supersedes and inserts under one transaction, rather than a multi-effect `stagedRun`?
5. **Unification of tool and RPC shells**: Several task flows (`publish`, `approve`, `archive`, `update`) are duplicated between `space-agent-tools.ts`, `node-agent-tools.ts`, `space-task-handlers.ts`, and `task-agent-manager.ts`. Do we create a `space-task-operations.ts` module with shared shells, or keep the pipeline in one place and call it from each handler?
6. ~~**Hot-path `decideGenericAddressRouting`**~~ Resolved by review: it stays an ordinary pure helper called inline in the per-target loop — no runner, so there is no overhead question.
7. ~~**Mid-turn steer resnapshot timing**~~ Resolved by review (PR #2983): moot — `deliverDirectSteerUnderCoordination` already runs the landed `direct-steer-flush-pipeline.ts` raw pipeline; no `stagedRun` conversion (and therefore no `stagedRun` compensation modeling) is planned for this site.
