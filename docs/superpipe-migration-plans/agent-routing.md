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
| `turn-end-routing.ts:routeTurnEnd` | Gates extend the existing `turn-end-pipeline.ts` `decisionRun` (no separate runner) | The routing cascade is the final gate group of the one SDK turn-end business path. |
| `query-retry-routing.ts:classifyQueryRetryRoute` | Classifier gates of the single `route-query-retry` direct pipeline | Pure classifier with ten mutually exclusive retry/terminal arms; first match wins via self-guarding stages. |
| `query-retry-routing.ts:resolveDecision` | Finalizer gates of the same `route-query-retry` pipeline | Maps a `QueryRetryRoute` to a `QueryRetryDecision`; the `rate_limit_handoff` `declined` branch re-runs the single pipeline with an amended env. |
| `query-retry-routing.ts:decideProviderTerminalCategory` | None (pure core leaf) | Regex classifier used by the terminal gate; not a pipeline on its own. |
| `query-retry-routing.ts:resolveTerminalMessageHint` | None (pure core leaf) | Hint producer used by the terminal gate; not a pipeline on its own. |
| `delivery-turn-routing.ts:resolveSteerAdmission` | `decisionRun` (`steer-admission`) | `aborted`/`park`/`promote`/`awaiting_acceptance`/`feed` first-match cascade. |
| `delivery-turn-routing.ts:planDeliveryRoleArbitration` | `decisionRun` (`delivery-role-arbitration`) | `reuse` vs `enqueue` decision with fallback role computation. |
| `handler-outcome-routing.ts:routeDriveTurnOutcome` | `decisionRun` (`drive-turn-outcome`) | Maps `DriveTurnOutcome` to a `HandlerOutcomeRoute`. |
| `handler-outcome-routing.ts:routeFeedSteerOutcome` | `decisionRun` (`feed-steer-outcome`) | Maps `FeedSteerOutcome` to a `HandlerOutcomeRoute` with park-budget gates. |
| `context-reset-planner.ts:planInjectContextReset` | Ordinary pure helper consumed by `message-delivery-pipeline.ts` (review correction: its own `decisionRun` would make every inject-delivery run execute an inner pipeline) | Six-guard sequential cascade that admits `clear_before_deliver` only when every guard passes. |
| `context-reset-planner.ts:planTurnEndFlushContextReset` | Ordinary pure helper (review correction: called by `applyFlushContextResetGate` inside `message-turn-end-flush` — its own `decisionRun` would nest a pipeline per flush) | Three-guard cascade for `clear_then_flush` vs `flush_without_clear`. |
| `message-ownership-gates.ts:resolveDeliveryRole` | Ordinary pure priority-table helper (review correction: not a `decisionRun` — it is called twice inside the arbitration pipeline and from other delivery paths; a runner here would nest pipeline executions per call) | Small priority table with TypeScript overloads. |

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
- **Proposed combinator:** Review correction — do NOT create a separate `sdk-turn-end-routing` `decisionRun`. `routeTurnEnd` is the final routing gate of the ONE SDK turn-end business path, which `turn-end-pipeline.ts` already owns; extend `turn-end-pipeline.ts` directly with these routing gates (CLAUDE.md: one pipeline per business path), rather than leaving the path split across nested pipelines. The gate list below is unchanged; it joins the existing pipeline in place of the current `applyTurnEndRoutingGate` delegation.
- **Input/output snapshot design:**
  - Input: `{ flags: TurnEndFlags; event: TurnEndEvent; queryMode: 'immediate' | 'manual; }` (the wrapper injects `decision: null`).
  - Output: `TurnEndPlan`.
- **Pure core design:** Decompose the cascade into named gates, each populating `ctx.plan` WITHOUT deciding and WITHOUT overwriting: every routing gate begins with `if (ctx.plan !== null) return ctx;` (review correction: the gate predicates OVERLAP — an idle event with `clearAwaitingTrailingIdle` also reaches the default idle gate, and an armed-clear error also reaches the broader confirm gate — so unguarded later gates would overwrite the higher-priority plan before `applyFinalGate`; the self-guard preserves first-match precedence without halting the outer pipeline, so final usage/ack assembly still runs). Only the pipeline's existing `applyFinalGate` sets `decision` from `ctx.plan`.
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
- **Shell/effect wiring:** The exported `routeTurnEnd(flags, event, ctx)` stays as a thin wrapper for the parity suite, invoking the extended `turn-end-pipeline.ts` runner and returning the plan decision. In production the gates run inline in that pipeline: the plan lands in `ctx.plan` and the final `applyFinalGate` assembles the full `TurnEndPipelineDecision`. The actual effects (setIdle, cancel/rearm timers, replay queue) are executed by `AgentSession`/queue code that consumes the plan, not by the routing pipeline.
- **Step-by-step migration:**
  1. Extract each top-level branch of the `routeTurnEnd` cascade into a named gate function in `turn-end-routing.ts` (gates are exported; `makePlan`, `canReplay`, and `resetTurnEndFlags` stay pure helpers).
  2. Extend `turn-end-pipeline.ts`'s gate list with these routing gates in the current routing position, replacing the `applyTurnEndRoutingGate` delegation to the hand-rolled cascade.
  3. Replace the body of `routeTurnEnd` with a call into the extended pipeline and a fallback `makePlan(flags)` if `decision` is somehow null (wrapper kept for the parity suite).
  4. Confirm `turn-end-pipeline.test.ts` and `turn-end-routing.test.ts` both stay green.
- **Tests:** Keep `turn-end-routing.test.ts` as a parity suite (it already calls `routeTurnEnd`). Add `turn-end-routing-gates.test.ts` that tests each gate independently: no-op when conditions do not match, correct plan when they do, and that later routing gates PRESERVE an existing non-null `ctx.plan` (review correction: these gates set only `ctx.plan`, never `ctx.decision`, so `!hasDecided` cannot halt until `applyFinalGate`; asserting plan precedence — not decision halting — keeps the outer pipeline free to reach its final usage/ack assembly). Add a contract test that `applyDefaultResultGate` always produces a plan for any `result` not caught earlier. Ensure `turn-end-pipeline.test.ts` still passes.
- **Risks/caveats:** The `sessionState` and `result` branches are not strictly mutually exclusive until the guard conditions are checked, so gate order must mirror the current `if` order exactly. `makePlan` is called by several gates with different `nextFlags` and `afterEffectsFlags`; any mismatch in flag merging is a regression. `queryMode` only affects `allowQueueReplay` but must be threaded through every `makePlan` call. `turn-end-pipeline.ts` is not yet wired into runtime in this branch (only tests import it), but the migration must still keep its API stable.

---

### `packages/daemon/src/lib/agent/query-retry-routing.ts:classifyQueryRetryRoute`

- **Current summary:** A 37-branch cascade that classifies a query failure into one of the `QueryRetryRoute` arms (`startup_timeout_retry`, `message_not_found_retry`, `transient_retry`, `provider_backoff`, `rate_limit_handoff`, `api_validation`, `aborted_noop`, `cleanup_noop`, `superseded_noop`, `terminal`). It is the classifier gate of the query-retry pipeline and is called by `query-runner.ts` on the error hot path.
- **Proposed combinator:** Review correction — `classifyQueryRetryRoute` and `resolveDecision` compose as ONE directly named pipeline (`route-query-retry`) for the business operation, not two separately-run pipelines. It is a **direct raw `superpipe` pipeline, not a `decisionRun`** (`decisionRun` hardcodes its halt predicate to `ctx.decision !== null`, `decision-pipeline.ts:11`), and it uses **NO `!dep` halts between stage groups**: `!dep` halts the entire run, so a halt after each classifier stage would exit before any finalizer could set `ctx.decision` and `decideQueryRetry` could never return a decision. The pipeline is LINEAR with self-guarding stages: every classifier stage is a no-op once `route` is set (first match wins, later stages decline to overwrite), and every finalizer stage matches on `ctx.route.action === '<action>' && ctx.decision === null` (at most one fires). `.end('ctx')` returns the ctx carrying both `route` and `decision`.
- **Input/output snapshot design:**
  - Input: `QueryRetryRouteInput` (`errorSignal`, `env`).
  - Output: `QueryRetryDecision` (route + finalizer).
- **Pure core design:** The single pipeline runs two stage groups, linearly, with self-guarding stages (see combinator note: no `!hasRoute` halts — they would terminate the whole run). Each classifier stage is a no-op once `route` is set, so no later classifier — including the default terminal gate — can overwrite an earlier route:
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

  Then the finalizer gates run against the now-set `route` (each matches at most one `route.action`).
- **Shell/effect wiring:** The exported `classifyQueryRetryRoute(input)` becomes a wrapper that runs `routeQueryRetryRun` and returns `ctx.route`; `decideQueryRetry` returns `ctx.decision` from the same single run. `query-runner.ts` does not call it directly; it calls `decideQueryRetry`.
- **Step-by-step migration:**
  1. Define `QueryRetryRoutingCtx` and `routeQueryRetryRun` (one pipeline).
  2. Move each classifier `if` branch into a gate that sets `route`; the finalizer gates read `route` and set `decision`.
  3. Keep `isQueryInterrupted` as a private helper.
  4. Update `decideQueryRetry` to call the single-pipeline wrapper.
- **Tests:** `query-retry-routing.test.ts` already covers `classifyQueryRetryRoute` directly; keep as parity. Add `query-retry-gates.test.ts` with a matrix that asserts each classifier gate fires exactly for its matching conditions and that precedence order is respected (e.g., `superseded` beats `cleanup`, `cleanup` beats `startup_timeout`).
- **Risks/caveats:** This is the hottest error path in the daemon. The gate order must preserve the exact precedence of the current cascade. The `transient` and `provider_backoff` gates share `isRetryableProviderError` and `attempt < maxProviderRetries` checks; make sure the boundary between them remains the same. The `rate_limit_handoff` gate must keep the `env.hasRateLimitHandoff && rateLimitHint !== null` condition. The `terminal` gate relies on `decideProviderTerminalCategory` and `resolveTerminalMessageHint`; do not change them as part of this migration.

---

### `packages/daemon/src/lib/agent/query-retry-routing.ts:resolveDecision`

- **Current summary:** A large `switch (route.action)` that converts a `QueryRetryRoute` into a `QueryRetryDecision` (route + `QueryRetryFinalizer`). It handles `rate_limit_handoff` accepted/declined/thrown/undefined, and for `declined` it recursively reclassifies with `hasRateLimitHandoff: false` and re-resolves.
- **Proposed combinator:** Part of the single `route-query-retry` `decisionRun` described above (review correction: no separately-run finalizer pipeline — classifier and finalizer compose as one business-path pipeline). This section describes its finalizer stage group only. The context carries `route`, `env`, optional `errorSignal`, and `decision: QueryRetryDecision | null`.
- **Input/output snapshot design:**
  - Input: `{ route: QueryRetryRoute; env: QueryRetryEnvironment; errorSignal?: QueryRetryErrorSignal; }`.
  - Output: `QueryRetryDecision`.
- **Pure core design:** Each `case` in the switch becomes a gate. Because only one case matches a given `route.action`, the finalizer gates run through unmatched gates (they return `ctx`) and halt once one sets `decision`. `applyRateLimitHandoffFinalizeGate` is the only non-trivial gate: it branches on `env.rateLimitHandoffResult` and, for `declined`, FIRST re-checks `isQueryInterrupted` — a handoff declined after the lifecycle became interrupted (or with the abort signal set) whose error name is not `AbortError` currently returns `aborted_noop` with recovery-aware finalizer flags, and a naive rerun would fall through to a terminal rate-limit route instead — and only otherwise performs the amended-environment reclassification INLINE — as pure helper stages within the CURRENT run (`classifyRoutePure(env with hasRateLimitHandoff: false, errorSignal)` + finalizer mapping helpers; review correction round 16: invoking `routeQueryRetryRun` from inside a gate would nest the business operation inside itself and contradict the single-invocation instruction). Termination is by construction: with `hasRateLimitHandoff: false` the classifier cannot select `rate_limit_handoff` again.
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
- **Shell/effect wiring:** `resolveDecision` stays a private wrapper for parity tests: it seeds `route` and runs `routeQueryRetryRun`, returning `ctx.decision`. Production callers use the single-run `decideQueryRetry`. The `QueryRetryFinalizer` produced is a pure data object (with closures for `skipFinalizerIdle`) consumed by `query-runner.ts` to decide which teardown steps to skip.
- **Step-by-step migration:**
  1. Add the finalizer gates to the SAME `routeQueryRetryRun` pipeline, after the classifier gates (review correction: no separate `queryRetryFinalizeRun` runner and no separate `resolveDecision` production call — that would recreate two composition boundaries; the business path is one pipeline).
  2. Replace each `case` with a gate that checks `ctx.route.action === '<action>'` and `ctx.decision === null`, then sets `ctx.decision`.
  3. Move the `rate_limit_handoff` switch into `applyRateLimitHandoffFinalizeGate`; its `declined` branch recomputes via the inline pure helpers (amended env) WITHIN the current run.
  4. Keep `makeFinalizer`, `skipIdleDueToRecovery`, `skipFinalizerIdleDueToLifecycle`, and `skipFinalizerIdleAlways` as helpers used by the gates.
  5. Update `decideQueryRetry` to invoke `routeQueryRetryRun` ONCE and return `ctx.decision`.
- **Tests:** `query-retry-routing.test.ts` is the parity suite. Add `query-retry-finalize-gates.test.ts` that tests each finalizer gate per `route.action`, including the `rate_limit_handoff` `accepted`/`declined`/`thrown`/`undefined` branches and the `declined` recompute. Add a contract test that the `declined` path returns the same decision as the current hand-rolled function.
- **Risks/caveats:** `makeFinalizer` uses `skipFinalizerIdle` as a closure over `env` (e.g., `skipIdleDueToRecovery` and `skipFinalizerIdleDueToLifecycle`). The final test in `query-retry-routing.test.ts` calls `skipFinalizerIdle` with a resnapped env and expects a different result, so the closure must capture the right values; keep the helper definitions exactly as closures, not pre-resolved booleans. `resolveDecision` is currently not exported, so the migration can keep it private.

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
- **Proposed combinator:** Review correction round 20 — arbitration stays an ORDINARY PURE SHARED HELPER composed into each complete delivery pipeline (`deliverMessage`, `persistAndEnqueueDelivery`): its reuse/enqueue branches plus the corresponding `jobQueue.enqueue` effect and unique-constraint handling are stages of those delivery operations. A standalone admission-only arbitration pipeline leaves the central enqueue effect outside, splitting both delivery callers at that boundary.
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
- **Shell/effect wiring:** The plain helper `planDeliveryRoleArbitration(args)` returns the arbitration result; each complete delivery pipeline then runs its own `jobQueue.enqueue` effect stage with unique-constraint handling (review correction: the enqueue must be a stage of the same delivery operation, not left in an imperative caller).
- **Step-by-step migration:**
  1. Extract the reuse/enqueue branch logic as ordinary helper gates (review correction round 21: no `DeliveryRoleArbitrationCtx`/`deliveryRoleArbitrationRun` runner).
  2. Compose those helpers with the `jobQueue.enqueue` effect and unique-constraint handling INSIDE each complete delivery operation (`deliverMessage`, `persistAndEnqueueDelivery`) so the enqueue boundary is not split out of the business path.
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
- **Proposed combinator:** Review correction — keep this planner as an ORDINARY PURE HELPER (its six-guard cascade intact); `message-delivery-pipeline.ts` calls it directly. Converting it to its own `decisionRun` while `message-inject-delivery` calls it would make every inject-delivery operation execute an inner pipeline to obtain one of the outer pipeline's decisions.
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
  1. Extract the six guards as pure helper functions (review correction: no `InjectContextResetRun` runner — this planner stays an ordinary pure helper consumed by `message-inject-delivery`).
  2. Port each guard to a gate.
  3. Keep the wrapper exported.
- **Tests:** `context-reset-planner.test.ts` is parity. Add `inject-context-reset-gates.test.ts` covering each guard and the "first false conjunct wins" precedence (e.g., `not_task_input` beats `session_busy`).
- **Risks/caveats:** The guard order encodes the `reason` priority. Reordering would change the reported `reason` for inputs that fail multiple guards (the test "the first false conjunct wins" asserts this). `hasActiveDeliveryJob` outranks `hasUnconsumedDeliveredWork`.

---

### `packages/daemon/src/lib/agent/context-reset-planner.ts:planTurnEndFlushContextReset`

- **Current summary:** Three-guard cascade for turn-end flush context reset. Admits `clear_then_flush` only when the slot resets context, there is prior context, no active delivery job, and there is at least one task deliverable. Otherwise falls back to `flush_without_clear` (with an optional `active_delivery_job` reason).
- **Proposed combinator:** Review correction — keep this planner as an ORDINARY PURE HELPER; the existing `message-turn-end-flush` pipeline's `applyFlushContextResetGate` calls it directly. Converting it to its own `decisionRun` makes every turn-end flush execute a nested pipeline; keep the three reset gates as pure logic here or inline them into `message-turn-end-flush`.
- **Input/output snapshot design:**
  - Input: `{ slotResetsContext: boolean; hasPriorContext: boolean; hasActiveDeliveryJob: boolean; taskDeliverableCount: number; }`.
  - Output: `TurnEndFlushContextResetPlan`.
- **Pure core design:**
  - `applyClearThenFlushGate` — all four conditions true.
  - `applyActiveDeliveryJobGate` — `slotResetsContext && hasPriorContext && hasActiveDeliveryJob`.
  - `applyFlushWithoutClearGate` — default.
- **Shell/effect wiring:** Wrapper `planTurnEndFlushContextReset(args)` returns `ctx.decision`. Called by `message-delivery-pipeline.ts:applyFlushContextResetGate`. The clear, if any, is performed by the turn-end flush path.
- **Step-by-step migration:**
  1. Extract the three reset guards as ordinary pure helpers (review correction round 20: no `TurnEndFlushContextResetCtx`/`turnEndFlushContextResetRun` runner — `message-turn-end-flush` calls this planner from `applyFlushContextResetGate`, so a runner would nest a reset pipeline per flush).
  2. Port the three branches to gates.
- **Tests:** `context-reset-planner.test.ts` is parity. Add `turn-end-flush-context-reset-gates.test.ts`.
- **Risks/caveats:** `taskDeliverableCount` is computed by the caller from the flush plan. The default path does not set a `reason` except in the active-delivery-job case. Ensure the `active_delivery_job` reason only appears when the slot resets context and prior context is present, matching the current second branch.

---

### `packages/daemon/src/lib/agent/message-ownership-gates.ts:resolveDeliveryRole`

- **Current summary:** Small priority table that resolves which `MessageDeliveryRole` (`turn`/`steer`) to use. With `uniqueConstraintHit: true` it may return the sentinel `explicit_role_rejected`. It uses TypeScript overloads to distinguish the normal and constraint-hit return types. Called by `planDeliveryRoleArbitration`, `message-delivery.ts:deliverMessage`, and `message-delivery-outbox.ts:persistAndEnqueueDelivery`.
- **Proposed combinator:** None (review correction) — retain the priority table as an ordinary pure helper; it is called twice inside the arbitration pipeline and from other delivery paths, so a runner would nest pipeline executions per call.
- **Input/output snapshot design (helper signature):**
  - Input: `{ existingActiveRole: MessageDeliveryRole | null; requestedRole?: MessageDeliveryRole; uniqueConstraintHit: boolean; }`.
  - Output: `DeliveryRoleResolution = MessageDeliveryRole | 'explicit_role_rejected'` (or `MessageDeliveryRole` for the `uniqueConstraintHit: false` overload).
- **Pure core design:**
  - `applyExistingRoleGate` — `existingActiveRole !== null`; decide it.
  - `applyExplicitTurnRejectedGate` — `requestedRole === 'turn' && uniqueConstraintHit`; decide `'explicit_role_rejected'`.
  - `applyExplicitRequestedGate` — `requestedRole !== undefined`; decide it.
  - `applyConstraintFallbackGate` — `uniqueConstraintHit`; decide `'steer'`.
  - `applyDefaultTurnGate` — default; decide `'turn'`.
- **Shell/effect wiring:** Review correction — keep `resolveDeliveryRole(args)` as the ORDINARY PURE HELPER it is today (priority-table function, overloads unchanged). Do NOT convert it to a `deliveryRoleRun` runner: `planDeliveryRoleArbitration` calls it TWICE inside its enqueue gate, so a runner would execute a nested pipeline twice per arbitration and split one operation across three pipeline runs. Callers in `delivery-turn-routing.ts`, `message-delivery.ts`, and `message-delivery-outbox.ts` continue to call the plain helper unchanged.
- **Step-by-step migration:**
  1. Keep `resolveDeliveryRole` as an ordinary pure priority-table helper (review correction — no `DeliveryRoleCtx`/`deliveryRoleRun` conversion).
  2. The arbitration gates (`applyReuseGate`, `applyEnqueueGate`) call the helper directly as pure functions.
- **Tests:** `message-ownership-gates.test.ts` covers all cases unchanged.
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

1. ~~**Should `routeTurnEnd` be folded into `turn-end-pipeline.ts`?**~~ Resolved by review: yes — the routing gates extend `turn-end-pipeline.ts` directly (one pipeline per business path); no separate `sdk-turn-end-routing` runner.
2. ~~**Should `classifyQueryRetryRoute` and `resolveDecision` remain two separate `decisionRun`s or be one combined pipeline?**~~ Resolved by review: they compose as ONE `route-query-retry` pipeline invoked ONCE per operation; the `rate_limit_handoff` `declined` branch recomputes INLINE (pure helper stages, amended env) within that single run.
3. ~~**How should the `rate_limit_handoff` `declined` recompute be modeled without a recursive call?**~~ Resolved by review: the finalizer gate recomputes INLINE via pure helper stages (amended env) within the current single run — it never re-invokes `routeQueryRetryRun`, and no classifier gates are duplicated.
4. ~~**Is `resolveDeliveryRole` too hot for `decisionRun` overhead?**~~ Moot after review: it remains a plain priority-table helper (also called twice inside arbitration), so no per-call combinator overhead exists. The `decisionRun` overhead is ~2 µs per call, but if deliveries become a bottleneck, this function may be a candidate to keep as a plain function or a raw `superpipe` transform with no gates. A microbenchmark should confirm.
5. **Should the exported function names be kept as wrappers or replaced with `decideXxx` runners?** This plan preserves `routeTurnEnd`, `classifyQueryRetryRoute`, `resolveDecision` (private), `resolveSteerAdmission`, `planDeliveryRoleArbitration`, `routeDriveTurnOutcome`, `routeFeedSteerOutcome`, `planInjectContextReset`, `planTurnEndFlushContextReset`, and `resolveDeliveryRole` as the public API to avoid churning every caller. The internal `decideXxx` runners are private.
6. **Are `message-ownership-gates.ts:planFlushDelivery` and `decideDeferAdmission` in scope?** They are not in the requested symbol list, but they are also pure admission functions used by `message-delivery-pipeline.ts`. They are natural follow-up migration targets after `resolveDeliveryRole`.
