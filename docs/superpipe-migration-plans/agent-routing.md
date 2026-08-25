# Agent routing migration plan

## Scope and combinator fit

This plan covers the hand-rolled routing/gate functions in `packages/daemon/src/lib/agent/` that are the pure, synchronous decision cores for the SDK message and turn lifecycle. The governing architecture record is `docs/adr/0004-superpipe-pipelines.md`: one direct superpipe pipeline per business path, no pre-categorization into decision vs staged vs transform, and no new combinators.

All sites in scope are **pure, in-memory, synchronous classifiers/planners** with no I/O, no DB writes, no async work, and no resource ownership. Because of that, `stagedRun` is not appropriate anywhere in this migration. `stagedRun` is reserved for async multi-stage flows with snapshot → decide → effect → resnapshot cycles and compensation (see `packages/daemon/src/lib/space/runtime/verified-stop-flow.ts` and `spawn-flow.ts`).

The right tools for this layer are:

- **`decisionRun`** — first-match-wins gate cascade for a typed `ctx.decision`. Use this when the natural shape of the problem is a sequence of mutually exclusive branches that stop once one fires.
- **Raw `superpipe` transform (`.pipe(...).end('ctx')`)** — for a pure, single-pass transform with a custom halt condition (`!dep`) and no `decision` field. This is appropriate when the output is an intermediate plan or a nullable value rather than the final `decision` of a `decisionRun`.

For each function below, the plan picks the combinator that matches the existing control flow while exposing the branch order and stage contract to tests.

| Symbol | Proposed combinator | Rationale |
| --- | --- | --- |
| `turn-end-routing.ts:routeTurnEnd` | `decisionRun` | A long first-match cascade over `sessionState` and `result` events that stops once a `TurnEndPlan` is produced. |
| `query-retry-routing.ts:classifyQueryRetryRoute` | `decisionRun` (`query-retry-classify`) | Pure classifier with ten mutually exclusive retry/terminal arms. |
| `query-retry-routing.ts:resolveDecision` | `decisionRun` (`query-retry-finalize`) | Maps a `QueryRetryRoute` to a `QueryRetryDecision`; the `rate_limit_handoff` `declined` branch is a recursive call back into the classifier/finalizer. |
| `query-retry-routing.ts:decideProviderTerminalCategory` | None (pure core leaf) | Regex classifier used by the terminal gate; not a pipeline on its own. |
| `query-retry-routing.ts:resolveTerminalMessageHint` | None (pure core leaf) | Hint producer used by the terminal gate; not a pipeline on its own. |
| `delivery-turn-routing.ts:resolveSteerAdmission` | `decisionRun` (`steer-admission`) | `aborted`/`park`/`promote`/`awaiting_acceptance`/`feed` first-match cascade. |
| `delivery-turn-routing.ts:planDeliveryRoleArbitration` | `decisionRun` (`delivery-role-arbitration`) | `reuse` vs `enqueue` decision with fallback role computation. |
| `handler-outcome-routing.ts:routeDriveTurnOutcome` | `decisionRun` (`drive-turn-outcome`) | Maps `DriveTurnOutcome` to a `HandlerOutcomeRoute`. |
| `handler-outcome-routing.ts:routeFeedSteerOutcome` | `decisionRun` (`feed-steer-outcome`) | Maps `FeedSteerOutcome` to a `HandlerOutcomeRoute` with park-budget gates. |
| `context-reset-planner.ts:planInjectContextReset` | `decisionRun` (`inject-context-reset`) | Six-guard sequential cascade that admits `clear_before_deliver` only when every guard passes. |
| `context-reset-planner.ts:planTurnEndFlushContextReset` | `decisionRun` (`turn-end-flush-context-reset`) | Three-guard cascade for `clear_then_flush` vs `flush_without_clear`. |
| `message-ownership-gates.ts:resolveDeliveryRole` | `decisionRun` (`delivery-role`) | Small priority table with TypeScript overloads. |

## Existing superpipe examples to emulate

### `decisionRun` patterns

The daemon already uses `decisionRun` from `packages/daemon/src/lib/space/runtime/decision-pipeline.ts` for pure admission/routing paths. The closest examples are:

1. **`packages/daemon/src/lib/agent/turn-end-pipeline.ts`** — `decisionRun('sdk-turn-end', [...])` composes usage accounting, ack selection, and `routeTurnEnd` as named gates. It shows how an existing pipeline can delegate to another decision function and how a final gate can fall back to recomputing an upstream value when it is missing.
2. **`packages/daemon/src/lib/agent/message-delivery-pipeline.ts`** — `decisionRun('message-inject-delivery', [...])` and `decisionRun('message-turn-end-flush', [...])`. Shows gates that set side annotations (e.g., `reopenFailedDelivery`) without deciding, gates that delegate to `context-reset-planner`/`message-ownership-gates`, and a final arbiter gate.
3. **`packages/daemon/src/lib/space/runtime/run-tick-decision-pipeline.ts`** — Long `decisionRun` gate list with lazy thunks for expensive facts and cheap short-circuit paths.
4. **`packages/daemon/src/lib/space/runtime/agent-message-routing-pipeline.ts`** — Short `decisionRun` with typed decision union and per-condition gates.
5. **`packages/daemon/src/lib/agent/query-retry-routing.ts`** — The current `queryRetryDecisionRun` is exactly the pattern to extend: a `decisionRun` with a classifier gate that does **not** set `decision` and a mapping gate that does.

### Raw `superpipe` patterns

The only current raw `superpipe` pipeline in the daemon is `packages/daemon/src/lib/space/runtime/external-event-steer-admission-pipeline.ts`. It demonstrates:

- `superpipe({ admissionSettled })(name).input(['ctx']).pipe(gate, 'ctx', 'ctx').pipe('!admissionSettled', 'ctx')... .end('ctx')` for a custom halt guard.
- A sequence of guard, enrich, partition, and finalize stages.
- Using `decided(ctx, decision)` and a boolean guard to model early exit.

This is the model to copy if a site needs a `plan`- or `route`-shaped output rather than a `decision`-shaped output.

### `stagedRun` patterns (not used here, but reference)

- `packages/daemon/src/lib/space/runtime/verified-stop-flow.ts` — async session stop with `snapshot`/`resnapshot`, `decide`, `effect`, `halt`, and `when`-guarded branch arms.
- `packages/daemon/src/lib/space/runtime/spawn-flow.ts` — long async flow with CAS outcomes (`'won' | 'superseded'`) and compensations.

None of the agent routing sites require `stagedRun` because none perform durable writes or async work inside the routing function.

## Per-site detailed plans

### `packages/daemon/src/lib/agent/turn-end-routing.ts:routeTurnEnd`

- **Current summary:** A 170-line hand-rolled cascade that maps a `TurnEndEvent` (`result` or `sessionState`) plus `TurnEndFlags` and `queryMode` to a `TurnEndPlan`. The plan controls idle-fencing, `finishTurn`, queue replay, suppression timer handling, and flag transitions for the next turn. It is the final routing gate inside the existing `turn-end-pipeline.ts` `decisionRun`.
- **Proposed combinator:** `decisionRun` named `sdk-turn-end-routing`. A `TurnEndPlanCtx` carries `flags`, `event`, `queryMode`, and a `decision: TurnEndPlan | null`.
- **Input/output snapshot design:**
  - Input: `{ flags: TurnEndFlags; event: TurnEndEvent; queryMode: 'immediate' | 'manual; }` (the wrapper injects `decision: null`).
  - Output: `TurnEndPlan`.
- **Pure core design:** Decompose the cascade into named gates, each returning either `ctx` or `{ ...ctx, decision: <plan> }`. `decisionRun` halts (`!hasDecided`) after the first gate that produces a plan.
  - `applySessionStateNonIdleGate` — `event.kind === 'sessionState' && event.state !== 'idle'`.
  - `applySessionStateClearAwaitingGate` — `event.kind === 'sessionState' && event.state === 'idle' && flags.clearAwaitingTrailingIdle`.
  - `applySessionStateSuppressedIdleGate` — `event.kind === 'sessionState' && event.state === 'idle' && flags.suppressIdleOnNextResult`.
  - `applySessionStateIdleFinishGate` — `event.kind === 'sessionState' && event.state === 'idle'` (default idle finish).
  - `applyResultPreRecoveryGate` — `event.kind === 'result' && event.result.isLimitRecoveryEngaged === null`.
  - `applyResultRecoveryEngagedGate` — `event.kind === 'result' && event.result.isLimitRecoveryEngaged === true`.
  - `applyResultArmedClearErrorGate` — `event.kind === 'result' && event.result.confirmsArmedClear && !event.result.isSuccess && event.result.isLimitRecoveryEngaged === false`.
  - `applyResultConfirmArmedClearGate` — `event.kind === 'result' && event.result.confirmsArmedClear && event.result.isLimitRecoveryEngaged === false`.
  - `applyResultLegacySuccessGate` — `event.kind === 'result' && event.result.isTopLevel && event.result.isSuccess && !flags.suppressIdleOnNextResult && !flags.usesSessionStateChangedTurnEnd && !flags.expectsSessionStateIdleAfterResult && event.result.isLimitRecoveryEngaged === false`.
  - `applyResultDefaultGate` — all remaining `result` cases.
  `makePlan` and `canReplay` remain private helpers used by the gates.
- **Shell/effect wiring:** The exported `routeTurnEnd(flags, event, ctx)` becomes a thin wrapper around `turnEndRouteRun(...)`. It returns `ctx.decision`. The immediate shell is `turn-end-pipeline.ts`, which copies the returned plan into `ctx.plan` and then the final `applyFinalGate` assembles the full `TurnEndPipelineDecision`. The actual effects (setIdle, cancel/rearm timers, replay queue) are executed by `AgentSession`/queue code that consumes the plan, not by the routing pipeline.
- **Step-by-step migration:**
  1. Introduce `TurnEndPlanCtx` and `turnEndRouteRun` in `turn-end-routing.ts`.
  2. Extract each top-level branch into a named gate function.
  3. Keep `makePlan`, `canReplay`, and `resetTurnEndFlags` as pure helpers.
  4. Replace the body of `routeTurnEnd` with the runner call and a fallback `makePlan(flags)` if `decision` is somehow null.
  5. Leave `turn-end-pipeline.ts` unchanged except to confirm it still calls `routeTurnEnd` with the same signature.
- **Tests:** Keep `turn-end-routing.test.ts` as a parity suite (it already calls `routeTurnEnd`). Add `turn-end-routing-gates.test.ts` that tests each gate independently: no-op when conditions do not match, correct plan when they do, and that `!hasDecided` halts. Add a contract test that `applyDefaultResultGate` always produces a plan for any `result` not caught earlier. Ensure `turn-end-pipeline.test.ts` still passes.
- **Risks/caveats:** The `sessionState` and `result` branches are not strictly mutually exclusive until the guard conditions are checked, so gate order must mirror the current `if` order exactly. `makePlan` is called by several gates with different `nextFlags` and `afterEffectsFlags`; any mismatch in flag merging is a regression. `queryMode` only affects `allowQueueReplay` but must be threaded through every `makePlan` call. `turn-end-pipeline.ts` is not yet wired into runtime in this branch (only tests import it), but the migration must still keep its API stable.

---

### `packages/daemon/src/lib/agent/query-retry-routing.ts:classifyQueryRetryRoute`

- **Current summary:** A 37-branch cascade that classifies a query failure into one of the `QueryRetryRoute` arms (`startup_timeout_retry`, `message_not_found_retry`, `transient_retry`, `provider_backoff`, `rate_limit_handoff`, `api_validation`, `aborted_noop`, `cleanup_noop`, `superseded_noop`, `terminal`). It is the classifier gate of the query-retry pipeline and is called by `query-runner.ts` on the error hot path.
- **Proposed combinator:** `decisionRun` named `query-retry-classify`. The context carries `QueryRetryRouteInput` plus `decision: QueryRetryRoute | null`.
- **Input/output snapshot design:**
  - Input: `QueryRetryRouteInput` (`errorSignal`, `env`).
  - Output: `QueryRetryRoute`.
- **Pure core design:** Each arm of the current cascade becomes a gate. The `decisionRun` stops (`!hasDecided`) once one gate fires.
  - `applySupersededClassifyGate`
  - `applyCleanupClassifyGate`
  - `applyStartupTimeoutClassifyGate`
  - `applyMessageNotFoundClassifyGate`
  - `applyTransientClassifyGate` (with `isQueryInterrupted` check)
  - `applyProviderBackoffClassifyGate`
  - `applyAbortClassifyGate`
  - `applyApiValidationClassifyGate`
  - `applyRateLimitHandoffClassifyGate` (`isRateLimit && env.hasRateLimitHandoff && rateLimitHint !== null`)
  - `applyTerminalClassifyGate` (default, calls `decideProviderTerminalCategory` and `resolveTerminalMessageHint`)
- **Shell/effect wiring:** The exported `classifyQueryRetryRoute(input)` becomes a wrapper that runs `queryRetryClassifyRun` and returns `ctx.decision`. It is used by `decideQueryRetry` and by `resolveDecision` (for the `rate_limit_handoff` `declined` recompute). `query-runner.ts` does not call it directly; it calls `decideQueryRetry`.
- **Step-by-step migration:**
  1. Define `QueryRetryClassifyCtx` and `queryRetryClassifyRun`.
  2. Move each `if` branch into a gate that returns `decided(ctx, route)` when matched.
  3. Keep `isQueryInterrupted` as a private helper.
  4. Update `decideQueryRetry` and `resolveDecision` to call the wrapper.
- **Tests:** `query-retry-routing.test.ts` already covers `classifyQueryRetryRoute` directly; keep as parity. Add `query-retry-classify-gates.test.ts` with a matrix that asserts each gate fires exactly for its matching conditions and that precedence order is respected (e.g., `superseded` beats `cleanup`, `cleanup` beats `startup_timeout`).
- **Risks/caveats:** This is the hottest error path in the daemon. The gate order must preserve the exact precedence of the current cascade. The `transient` and `provider_backoff` gates share `isRetryableProviderError` and `attempt < maxProviderRetries` checks; make sure the boundary between them remains the same. The `rate_limit_handoff` gate must keep the `env.hasRateLimitHandoff && rateLimitHint !== null` condition. The `terminal` gate relies on `decideProviderTerminalCategory` and `resolveTerminalMessageHint`; do not change them as part of this migration.

---

### `packages/daemon/src/lib/agent/query-retry-routing.ts:resolveDecision`

- **Current summary:** A large `switch (route.action)` that converts a `QueryRetryRoute` into a `QueryRetryDecision` (route + `QueryRetryFinalizer`). It handles `rate_limit_handoff` accepted/declined/thrown/undefined, and for `declined` it recursively reclassifies with `hasRateLimitHandoff: false` and re-resolves.
- **Proposed combinator:** `decisionRun` named `query-retry-finalize`. The context carries `route`, `env`, optional `errorSignal`, and `decision: QueryRetryDecision | null`.
- **Input/output snapshot design:**
  - Input: `{ route: QueryRetryRoute; env: QueryRetryEnvironment; errorSignal?: QueryRetryErrorSignal; }`.
  - Output: `QueryRetryDecision`.
- **Pure core design:** Each `case` in the switch becomes a gate. Because only one case matches a given `route.action`, the `decisionRun` will run through unmatched gates (they return `ctx`) and halt on the first match. `applyRateLimitHandoffFinalizeGate` is the only non-trivial gate: it branches on `env.rateLimitHandoffResult` and, for `declined`, calls `classifyQueryRetryRoute` and `resolveDecision` recursively with a `hasRateLimitHandoff: false` environment to compute the final decision.
  - `applySupersededNoopFinalizer`
  - `applyCleanupNoopFinalizer`
  - `applyStartupTimeoutRetryFinalizer`
  - `applyMessageNotFoundRetryFinalizer`
  - `applyTransientRetryFinalizer`
  - `applyProviderBackoffFinalizer`
  - `applyAbortedNoopFinalizer`
  - `applyApiValidationFinalizer`
  - `applyRateLimitHandoffFinalizer`
  - `applyTerminalFinalizer`
- **Shell/effect wiring:** `resolveDecision` becomes a private wrapper that runs `queryRetryFinalizeRun` and returns `ctx.decision`. It is called by `decideQueryRetry` and recursively by the `rate_limit_handoff` `declined` branch. The `QueryRetryFinalizer` produced is a pure data object (with closures for `skipFinalizerIdle`) consumed by `query-runner.ts` to decide which teardown steps to skip.
- **Step-by-step migration:**
  1. Define `QueryRetryFinalizeCtx` and `queryRetryFinalizeRun`.
  2. Replace each `case` with a gate that checks `ctx.route.action === '<action>'` and sets `ctx.decision`.
  3. Move the `rate_limit_handoff` switch into `applyRateLimitHandoffFinalizeGate`.
  4. Keep `makeFinalizer`, `skipIdleDueToRecovery`, `skipFinalizerIdleDueToLifecycle`, and `skipFinalizerIdleAlways` as helpers used by the gates.
  5. Update `decideQueryRetry` to call `classifyQueryRetryRoute` then `resolveDecision`.
- **Tests:** `query-retry-routing.test.ts` is the parity suite. Add `query-retry-finalize-gates.test.ts` that tests each finalizer gate per `route.action`, including the `rate_limit_handoff` `accepted`/`declined`/`thrown`/`undefined` branches and the recursive recompute. Add a contract test that the recursive `declined` path returns the same decision as the current hand-rolled function.
- **Risks/caveats:** The `rate_limit_handoff` `declined` branch is recursive. In the new design it will call `classifyQueryRetryRoute` and `resolveDecision` from inside a gate. Ensure the recursion terminates: after reclassification `hasRateLimitHandoff` is `false`, so the classify run cannot return `rate_limit_handoff` again. `makeFinalizer` uses `skipFinalizerIdle` as a closure over `env` (e.g., `skipIdleDueToRecovery` and `skipFinalizerIdleDueToLifecycle`). The final test in `query-retry-routing.test.ts` calls `skipFinalizerIdle` with a resnapped env and expects a different result, so the closure must capture the right values; keep the helper definitions exactly as closures, not pre-resolved booleans. `resolveDecision` is currently not exported, so the migration can keep it private.

---

### `packages/daemon/src/lib/agent/query-retry-routing.ts:decideProviderTerminalCategory`

- **Current summary:** Regex/text classifier that maps an error signal plus provider family to an `ErrorCategory`. It is a pure transform leaf used only by the terminal gate of the query-retry classifier.
- **Proposed combinator:** No independent superpipe combinator. Retained as a pure core function invoked by `applyTerminalClassifyGate`.
- **Input/output snapshot design:**
  - Input: `QueryRetryErrorSignal`, `QueryRetryEnvironment`.
  - Output: `ErrorCategory`.
- **Pure core design:** Keep the current `ErrorCategory` mapping logic. The function is stable and well-covered indirectly through `classifyQueryRetryRoute` and `decideQueryRetry`.
- **Shell/effect wiring:** Called by `applyTerminalClassifyGate` to build the `terminal` route. The resulting `ErrorCategory` is later used by `query-runner.ts` and `error-manager.ts`.
- **Step-by-step migration:** No structural change. Optionally add a dedicated exported name or keep it private; the migration does not need to alter it.
- **Tests:** No direct tests today. Add `query-retry-terminal-classifier.test.ts` with a table-driven matrix covering each `ErrorCategory` (auth, connection, rate limit, timeout, model, permission, system, provider auth, provider unavailable) and the provider-family-specific 503/401 handling.
- **Risks/caveats:** The regex set is the contract with `ErrorManager` and user-facing messages. Any change to a category mapping is a user-visible behavioral change. Keep the regexes byte-for-byte.

---

### `packages/daemon/src/lib/agent/query-retry-routing.ts:resolveTerminalMessageHint`

- **Current summary:** Produces an optional hint string (`startup_timeout`, `conversation_not_found`, `message_not_found`, `provider_exhausted`, `transient_exhausted`) for terminal routes. Pure transform leaf.
- **Proposed combinator:** No independent superpipe combinator. Retained as a pure core function invoked by `applyTerminalClassifyGate`.
- **Input/output snapshot design:**
  - Input: `QueryRetryErrorSignal`, `QueryRetryEnvironment`.
  - Output: `string | undefined`.
- **Pure core design:** Keep the current hint logic.
- **Shell/effect wiring:** Called by `applyTerminalClassifyGate` to build the `terminal` route. The hint is surfaced in user-facing terminal messages by `query-runner.ts`.
- **Step-by-step migration:** No structural change.
- **Tests:** Add `query-retry-terminal-hint.test.ts` covering each hint condition and the `undefined` cases.
- **Risks/caveats:** The hint strings are the contract with `query-runner.ts` and the UI. Keep them exact.

---

### `packages/daemon/src/lib/agent/delivery-turn-routing.ts:resolveSteerAdmission`

- **Current summary:** Decides what to do with an incoming steer: `aborted` (claim superseded or invalid delivery), `park` (session queued), `promote` (session idle/waiting/cooldown/interrupted), `awaiting_acceptance` (ACP with pending ownership), or `feed` (default processing path). Called from `AgentSession.feedDeliverySteer` inside a `withSessionLock` block.
- **Proposed combinator:** `decisionRun` named `steer-admission`.
- **Input/output snapshot design:**
  - Input: `{ claimCurrent: boolean; status: AgentProcessingState['status']; deliveryValid: boolean; hasLiveQuery: boolean; provider: string; queueOwnsMessage: boolean; }`.
  - Output: `SteerAdmissionDecision`.
- **Pure core design:** Gates in first-match order:
  - `applyClaimSupersededGate` — `!claimCurrent`.
  - `applyProcessingInvalidGate` — `status === 'processing' && !deliveryValid`.
  - `applyProcessingPromoteGate` — `status === 'processing' && !hasLiveQuery`.
  - `applyProcessingAcpAwaitGate` — `status === 'processing' && provider === 'acp' && queueOwnsMessage`.
  - `applyProcessingFeedGate` — `status === 'processing'`.
  - `applyQueuedParkGate` — `status === 'queued'`.
  - `applyPromoteGate` — default (idle/waiting_for_input/rate_limit_cooldown/interrupted).
- **Shell/effect wiring:** The exported `resolveSteerAdmission(args)` wraps `steerAdmissionRun`. It returns `ctx.decision`. `AgentSession.feedDeliverySteer` consumes the decision to return `aborted`/`park`/`promote`/`awaiting_acceptance`/`feed` and then either admits the steer or not.
- **Step-by-step migration:**
  1. Define `SteerAdmissionCtx` and `steerAdmissionRun`.
  2. Port each branch to a gate.
  3. Keep `isSteerDeliveryValid` and `classifyAcknowledgedSteer` unchanged (they are out of scope and used elsewhere).
  4. Keep the wrapper `resolveSteerAdmission` exported with the same signature.
- **Tests:** `delivery-turn-routing.test.ts` is the parity suite. Add `steer-admission-gates.test.ts` with an `it.each` matrix covering every `status` × `deliveryValid` × `hasLiveQuery` × `provider` × `queueOwnsMessage` × `claimCurrent` combination and asserting the first gate that fires.
- **Risks/caveats:** `status` includes `idle`, `queued`, `processing`, `waiting_for_input`, `rate_limit_cooldown`, `interrupted`. The default `applyPromoteGate` handles all non-`processing`/non-`queued` values, so any new status added to `AgentProcessingState` would silently promote unless the gate list is updated. The `processing` sub-gates must be ordered: invalid → promote (no live query) → ACP await → feed. `deliveryValid` is a computed predicate, not a raw row; keep that computation in the caller.

---

### `packages/daemon/src/lib/agent/delivery-turn-routing.ts:planDeliveryRoleArbitration`

- **Current summary:** Decides whether a delivery reuses an existing active role or enqueues a new one. Computes the role and, for fresh implicit deliveries, a `uniqueConstraintFallback` (`steer`) in case a unique constraint hits at enqueue time. Called by `message-delivery.ts:deliverMessage` and `message-delivery-outbox.ts:persistAndEnqueueDelivery` synchronously before `jobQueue.enqueue`.
- **Proposed combinator:** `decisionRun` named `delivery-role-arbitration`.
- **Input/output snapshot design:**
  - Input: `{ existingActiveRole: MessageDeliveryRole | null; requestedRole?: MessageDeliveryRole; }`.
  - Output: `DeliveryRoleArbitration`.
- **Pure core design:**
  - `applyReuseGate` — `existingActiveRole !== null`; decision is `{ action: 'reuse', role: existingActiveRole }`. (Can call `resolveDeliveryRole` for consistency, or use `existingActiveRole` directly.)
  - `applyEnqueueGate` — all other cases. Compute:
    - `role = resolveDeliveryRole({ existingActiveRole: null, requestedRole, uniqueConstraintHit: false })`
    - `constrained = resolveDeliveryRole({ existingActiveRole: null, requestedRole, uniqueConstraintHit: true })`
    - `uniqueConstraintFallback = requestedRole === undefined && constrained !== 'explicit_role_rejected' ? constrained : null`
    - Decide `{ action: 'enqueue', role, uniqueConstraintFallback }`.
- **Shell/effect wiring:** The wrapper `planDeliveryRoleArbitration(args)` returns `ctx.decision`. Callers then pass `role` (and `uniqueConstraintFallback` for the outbox) to `jobQueue.enqueue`. The actual SQLite enqueue and unique-constraint fallback handling live in the caller, not the pipeline.
- **Step-by-step migration:**
  1. Define `DeliveryRoleArbitrationCtx` and `deliveryRoleArbitrationRun`.
  2. Port the two branches to gates.
  3. Keep calling `resolveDeliveryRole` as a helper.
- **Tests:** `delivery-turn-routing.test.ts` covers all reuse/enqueue cases. Add `delivery-role-arbitration-gates.test.ts` testing `applyReuseGate` (existing active role wins over any requested role) and `applyEnqueueGate` for all `requestedRole` × `uniqueConstraintHit` combinations.
- **Risks/caveats:** `resolveDeliveryRole` has TypeScript overloads. The `applyEnqueueGate` must call it with the correct `uniqueConstraintHit` flag. The `uniqueConstraintFallback` is only set when `requestedRole` is undefined and the constrained result is not `explicit_role_rejected`; preserve that logic exactly because `message-delivery-outbox.ts` relies on it to fall back from `turn` to `steer` on a unique constraint.

---

### `packages/daemon/src/lib/agent/handler-outcome-routing.ts:routeDriveTurnOutcome`

- **Current summary:** Maps a `DriveTurnOutcome` (`completed`, `blocked`, `recovery_pending`, `aborted`, `turn_terminated`) to a `HandlerOutcomeRoute` that the `MESSAGE_DELIVERY` job handler uses to decide requeue/mutation/result. Called from `message-delivery.handler.ts` after `session.driveDeliveryTurn`.
- **Proposed combinator:** `decisionRun` named `drive-turn-outcome`.
- **Input/output snapshot design:**
  - Input: `DriveTurnOutcome`.
  - Output: `HandlerOutcomeRoute`.
- **Pure core design:**
  - `applyBlockedGate` — `outcome === 'blocked'`.
  - `applyRecoveryPendingGate` — `outcome === 'recovery_pending'`.
  - `applyAbortedGate` — `outcome === 'aborted'`.
  - `applyTurnTerminatedGate` — `outcome === 'turn_terminated'`.
  - `applyCompletedGate` — default.
- **Shell/effect wiring:** Wrapper `routeDriveTurnOutcome(result)` returns `ctx.decision`. `message-delivery.handler.ts` checks for `deadLetter` (not produced by this path), applies `settleSkipped`, and calls `jobQueue.requeue` if needed.
- **Step-by-step migration:**
  1. Define `DriveTurnOutcomeCtx` and `driveTurnOutcomeRun`.
  2. Port each branch to a gate.
- **Tests:** `handler-outcome-routing.test.ts` is parity. Add `drive-turn-outcome-gates.test.ts` covering each outcome.
- **Risks/caveats:** Trivial mapping, but the `HandlerOutcomeRoute` fields (e.g., `reclaimSkip: 'turn_terminated'`, `settleSkipped`) are consumed by `message-delivery.handler.ts`. Keep the object shapes identical.

---

### `packages/daemon/src/lib/agent/handler-outcome-routing.ts:routeFeedSteerOutcome`

- **Current summary:** Maps a `FeedSteerOutcome` (`consumed`, `awaiting_acceptance`, `promote`, `park`, `aborted`) plus `parkCount`, `waitingForInput`, and `now` to a `HandlerOutcomeRoute`. Handles park budgets and ACP acceptance budgets, including dead-letter paths.
- **Proposed combinator:** `decisionRun` named `feed-steer-outcome`.
- **Input/output snapshot design:**
  - Input: `{ outcome: FeedSteerOutcome; parkCount: number; waitingForInput: boolean; now: number; }`.
  - Output: `HandlerOutcomeRoute`.
- **Pure core design:**
  - `applyAbortedGate` — `outcome === 'aborted'`.
  - `applyParkWaitingInputGate` — `outcome === 'park' && waitingForInput`.
  - `applyParkDeadLetterGate` — `outcome === 'park' && parkCount >= MAX_STEER_PARKS`.
  - `applyParkRequeueParkedGate` — `outcome === 'park'`.
  - `applyAwaitingAcceptanceDeadLetterGate` — `outcome === 'awaiting_acceptance' && parkCount >= MAX_ACP_STEER_PARKS`.
  - `applyAwaitingAcceptanceRequeueParkedGate` — `outcome === 'awaiting_acceptance'`.
  - `applyPromoteGate` — `outcome === 'promote'`.
  - `applyConsumedGate` — default.
- **Shell/effect wiring:** Wrapper `routeFeedSteerOutcome(result, args)` returns `ctx.decision`. `message-delivery.handler.ts` checks for `deadLetter`, applies `settleSkipped`, and calls `jobQueue.requeue`, `requeueParked`, or `requeueAs`.
- **Step-by-step migration:**
  1. Define `FeedSteerOutcomeCtx` and `feedSteerOutcomeRun`.
  2. Port each branch to a gate. `MESSAGE_DELIVERY_PARK_MS` stays a module-level constant.
- **Tests:** `handler-outcome-routing.test.ts` is parity. Add `feed-steer-outcome-gates.test.ts` covering `park` with and without `waitingForInput`, at and over `MAX_STEER_PARKS`, `awaiting_acceptance` at and over `MAX_ACP_STEER_PARKS`, `promote`, `aborted`, and `consumed`.
- **Risks/caveats:** The park-budget thresholds (`MAX_STEER_PARKS`, `MAX_ACP_STEER_PARKS`) are the boundary between requeue and dead-letter. The `message-delivery.handler.ts` also has a pre-check for `MAX_ACP_STEER_PARKS` when `sendStatus === 'submitted'`; do not change that. `waitingForInput` bypasses the normal steer park budget, so the `applyParkWaitingInputGate` must fire before the budget gate.

---

### `packages/daemon/src/lib/agent/context-reset-planner.ts:planInjectContextReset`

- **Current summary:** Six-guard sequential cascade that decides whether to clear conversation context before delivering a newly persisted message. Only admits `clear_before_deliver` for `task` inputs on a non-busy session with prior context, a slot that resets context, no active delivery job, and no unconsumed delivered work.
- **Proposed combinator:** `decisionRun` named `inject-context-reset`.
- **Input/output snapshot design:**
  - Input: `{ inputKind: string; isBusy: boolean; hasPriorContext: boolean; slotResetsContext: boolean; hasActiveDeliveryJob: boolean; hasUnconsumedDeliveredWork: boolean; }`.
  - Output: `InjectContextResetPlan`.
- **Pure core design:**
  - `applyNotTaskInputGate`
  - `applyBusyGate`
  - `applyNoPriorContextGate`
  - `applySlotNotResetGate`
  - `applyActiveDeliveryJobGate`
  - `applyUnconsumedWorkGate`
  - `applyClearBeforeDeliverGate` (default)
- **Shell/effect wiring:** Wrapper `planInjectContextReset(args)` returns `ctx.decision`. It is called by `message-delivery-pipeline.ts:applyInjectContextResetGate`, which sets the outer pipeline's `ctx.decision` to the plan. The actual context clear is performed by the delivery path, not this function.
- **Step-by-step migration:**
  1. Define `InjectContextResetCtx` and `injectContextResetRun`.
  2. Port each guard to a gate.
  3. Keep the wrapper exported.
- **Tests:** `context-reset-planner.test.ts` is parity. Add `inject-context-reset-gates.test.ts` covering each guard and the "first false conjunct wins" precedence (e.g., `not_task_input` beats `session_busy`).
- **Risks/caveats:** The guard order encodes the `reason` priority. Reordering would change the reported `reason` for inputs that fail multiple guards (the test "the first false conjunct wins" asserts this). `hasActiveDeliveryJob` outranks `hasUnconsumedDeliveredWork`.

---

### `packages/daemon/src/lib/agent/context-reset-planner.ts:planTurnEndFlushContextReset`

- **Current summary:** Three-guard cascade for turn-end flush context reset. Admits `clear_then_flush` only when the slot resets context, there is prior context, no active delivery job, and there is at least one task deliverable. Otherwise falls back to `flush_without_clear` (with an optional `active_delivery_job` reason).
- **Proposed combinator:** `decisionRun` named `turn-end-flush-context-reset`.
- **Input/output snapshot design:**
  - Input: `{ slotResetsContext: boolean; hasPriorContext: boolean; hasActiveDeliveryJob: boolean; taskDeliverableCount: number; }`.
  - Output: `TurnEndFlushContextResetPlan`.
- **Pure core design:**
  - `applyClearThenFlushGate` — all four conditions true.
  - `applyActiveDeliveryJobGate` — `slotResetsContext && hasPriorContext && hasActiveDeliveryJob`.
  - `applyFlushWithoutClearGate` — default.
- **Shell/effect wiring:** Wrapper `planTurnEndFlushContextReset(args)` returns `ctx.decision`. Called by `message-delivery-pipeline.ts:applyFlushContextResetGate`. The clear, if any, is performed by the turn-end flush path.
- **Step-by-step migration:**
  1. Define `TurnEndFlushContextResetCtx` and `turnEndFlushContextResetRun`.
  2. Port the three branches to gates.
- **Tests:** `context-reset-planner.test.ts` is parity. Add `turn-end-flush-context-reset-gates.test.ts`.
- **Risks/caveats:** `taskDeliverableCount` is computed by the caller from the flush plan. The default path does not set a `reason` except in the active-delivery-job case. Ensure the `active_delivery_job` reason only appears when the slot resets context and prior context is present, matching the current second branch.

---

### `packages/daemon/src/lib/agent/message-ownership-gates.ts:resolveDeliveryRole`

- **Current summary:** Small priority table that resolves which `MessageDeliveryRole` (`turn`/`steer`) to use. With `uniqueConstraintHit: true` it may return the sentinel `explicit_role_rejected`. It uses TypeScript overloads to distinguish the normal and constraint-hit return types. Called by `planDeliveryRoleArbitration`, `message-delivery.ts:deliverMessage`, and `message-delivery-outbox.ts:persistAndEnqueueDelivery`.
- **Proposed combinator:** `decisionRun` named `delivery-role`.
- **Input/output snapshot design:**
  - Input: `{ existingActiveRole: MessageDeliveryRole | null; requestedRole?: MessageDeliveryRole; uniqueConstraintHit: boolean; }`.
  - Output: `DeliveryRoleResolution = MessageDeliveryRole | 'explicit_role_rejected'` (or `MessageDeliveryRole` for the `uniqueConstraintHit: false` overload).
- **Pure core design:**
  - `applyExistingRoleGate` — `existingActiveRole !== null`; decide it.
  - `applyExplicitTurnRejectedGate` — `requestedRole === 'turn' && uniqueConstraintHit`; decide `'explicit_role_rejected'`.
  - `applyExplicitRequestedGate` — `requestedRole !== undefined`; decide it.
  - `applyConstraintFallbackGate` — `uniqueConstraintHit`; decide `'steer'`.
  - `applyDefaultTurnGate` — default; decide `'turn'`.
- **Shell/effect wiring:** Keep the overloaded exported function `resolveDeliveryRole(args)` as a wrapper around `deliveryRoleRun` returning `ctx.decision`. For the `uniqueConstraintHit: false` overload, the wrapper can safely narrow/cast the result to `MessageDeliveryRole` because the gates guarantee it. Callers in `delivery-turn-routing.ts`, `message-delivery.ts`, and `message-delivery-outbox.ts` continue to use the wrapper unchanged.
- **Step-by-step migration:**
  1. Define `DeliveryRoleCtx` and `deliveryRoleRun`.
  2. Port the priority table to gates.
  3. Keep the existing overloads on the wrapper, casting from the runner's `DeliveryRoleResolution` as needed.
- **Tests:** `message-ownership-gates.test.ts` covers all cases. Add `delivery-role-gates.test.ts` testing each gate and the overload behavior.
- **Risks/caveats:** The overload contract is load-bearing: `uniqueConstraintHit: false` must never return `'explicit_role_rejected'`. The `applyExplicitTurnRejectedGate` must fire only for `requestedRole === 'turn'`, not for `requestedRole === 'steer'`. This function is on the hot path for every message delivery, so the `decisionRun` microsecond overhead (≈2 µs) is acceptable but should be benchmarked if any performance regression is observed.

---

## Suggested migration order

1. **`message-ownership-gates.ts:resolveDeliveryRole`** — smallest, foundational, and used by `delivery-turn-routing.ts`. Completing it first validates the pattern and the overload-preservation strategy.
2. **`delivery-turn-routing.ts`** (`resolveSteerAdmission`, `planDeliveryRoleArbitration`) — next-smallest, and they exercise `resolveDeliveryRole`.
3. **`handler-outcome-routing.ts`** (`routeDriveTurnOutcome`, `routeFeedSteerOutcome`) — independent, simple, and shows dead-letter/branch guard patterns.
4. **`context-reset-planner.ts`** (`planInjectContextReset`, `planTurnEndFlushContextReset`) — independent, but heavily covered by `message-delivery-pipeline.test.ts`, which is a good integration check.
5. **`query-retry-routing.ts`** (`classifyQueryRetryRoute`, `resolveDecision`, helpers) — more complex due to the recursive `rate_limit_handoff` `declined` path. Doing it after the simpler sites makes the gate/finalizer split easier to validate.
6. **`turn-end-routing.ts:routeTurnEnd`** — largest and most branches. Last so it can reuse the gate-extraction conventions established earlier. It is only used by `turn-end-pipeline.ts`, which is test-only in this snapshot, so it can be validated with existing unit tests before the pipeline is wired into runtime.

## Open questions

1. **Should `routeTurnEnd` be folded into `turn-end-pipeline.ts`?** ADR 0004 says one pipeline per business path. The business path is "SDK turn-end outcome," and `turn-end-pipeline.ts` already owns it. This plan keeps `routeTurnEnd` as a separate `decisionRun` inside `turn-end-routing.ts` to match the scope, but an alternative is to replace `applyTurnEndRoutingGate` and `applyFinalGate` with a single set of `decide` stages directly in `turn-end-pipeline.ts`.
2. **Should `classifyQueryRetryRoute` and `resolveDecision` remain two separate `decisionRun`s or be one combined pipeline?** Splitting them makes each one easier to test in isolation but requires `resolveDecision` to recursively call back into `classifyQueryRetryRoute`. A single combined `decisionRun` (`applyClassifierGate` sets `route`, subsequent per-route finalizer gates set `decision`) would avoid the recursive wrapper but makes the rate-limit `declined` recompute harder to express.
3. **How should the `rate_limit_handoff` `declined` recompute be modeled without a recursive call?** The current design and this plan keep a recursive call to `classifyQueryRetryRoute`/`resolveDecision`. If recursion is undesirable, the finalizer gate could inline the reclassification logic, but this duplicates the classifier gates.
4. **Is `resolveDeliveryRole` too hot for `decisionRun` overhead?** It runs on every message enqueue. The `decisionRun` overhead is ~2 µs per call, but if deliveries become a bottleneck, this function may be a candidate to keep as a plain function or a raw `superpipe` transform with no gates. A microbenchmark should confirm.
5. **Should the exported function names be kept as wrappers or replaced with `decideXxx` runners?** This plan preserves `routeTurnEnd`, `classifyQueryRetryRoute`, `resolveDecision` (private), `resolveSteerAdmission`, `planDeliveryRoleArbitration`, `routeDriveTurnOutcome`, `routeFeedSteerOutcome`, `planInjectContextReset`, `planTurnEndFlushContextReset`, and `resolveDeliveryRole` as the public API to avoid churning every caller. The internal `decideXxx` runners are private.
6. **Are `message-ownership-gates.ts:planFlushDelivery` and `decideDeferAdmission` in scope?** They are not in the requested symbol list, but they are also pure admission functions used by `message-delivery-pipeline.ts`. They are natural follow-up migration targets after `resolveDeliveryRole`.
