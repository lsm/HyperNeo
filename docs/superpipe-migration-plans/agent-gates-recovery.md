# Agent gates & recovery migration plan

## Scope and combinator fit

This plan covers the hand-rolled gate/parse/recovery functions in
`packages/daemon/src/lib/agent/` that decide how a session classifies errors,
arms cooldowns, trips breakers, denies loops, and reclaims deliveries. The
governing record is `docs/adr/0004-superpipe-pipelines.md` (rev. 2026-08-25):
one direct superpipe pipeline per business path, stages freely mixing decision,
transform, and effect work, `!dep` halts for early exits, no pre-classification
into combinator categories, and no new combinators.

Every site in scope is a **pure and synchronous classifier today**: no I/O,
no awaits, no DB writes, no resource ownership inside the classified cores.
The COMPLETE operations this plan composes them into add guarded effect
stages over injected collaborators — several of them awaited (the breaker's
`onTrip`, reconciliation's state updates, repeated-error intervention,
acknowledgement publications; see the `stagedRun`
note below) — so those compose as direct async-capable pipelines, never as
synchronous-only runners. `stagedRun`
(`packages/daemon/src/lib/space/runtime/staged-run.ts`) is still not
appropriate anywhere here — it exists for async snapshot → decide → effect →
resnapshot flows with CAS outcomes and compensation
(`verified-stop-flow.ts`, `spawn-flow.ts`). The two tools used are:

- **`decisionRun`** (`packages/daemon/src/lib/space/runtime/decision-pipeline.ts`)
  — first-match-wins gate cascade over a typed `ctx.decision`; gates are named
  exported functions; the run halts at the first gate that stamps a non-null
  decision. Reserved (review correction PR #2981) for the genuinely PURE
  parse cascades whose whole job is the decision — the nullable first-match
  parsers (`api-validation-parse`, `terminal-user-message`) where each
  strategy gate stamps a boxed/non-null decision on success and the wrapper
  falls back to `null`/`undefined` when no gate fired. Every operation with
  post-decision effect stages (retry arms, breaker arms, ack priority rows,
  loop admission, …) composes as a direct pipeline with in-stage skip
  guards instead — `decisionRun`'s per-gate halt would make those effects
  unreachable.
- **Raw `superpipe` transform** (`.pipe(stage, 'ctx', 'ctx')…end('ctx')`, the
  `external-event-steer-admission-pipeline.ts` shape) — a single-pass
  enrichment with several derived outputs and no single terminal decision.
  Used for: conjunctive validation (`asMessageDeliveryPayload`) and
  multi-field assessment (`assessLimitError`).

Two structural rules applied throughout:

1. **Nullable outcome convention.** When "no match" is a legitimate outcome of
   a first-match cascade (`extractResetTimestamp`, `extractErrorPattern`,
   `parseApiValidationError`, `terminalUserMessageFor`), a gate that must
   *terminate with the null-ish answer* (e.g. the 429 exclusion in
   `parseApiValidationError`) stamps a boxed decision — `{ text: null }` — so
   the halt actually fires; gates that merely *fail to find* leave `decision`
   null and the exported wrapper returns the unboxed fallback. Cascades with no
   definitive-null arm skip the box entirely.
2. **Leaves stay leaves.** ADR 0004 composes pipelines where they fit; it does
   not require wrapping every three-line ternary. `resolveLimitKind`,
   `isBillingTerminal`, `classifyLimitKind`, `resolveFallbackChain`,
   `refinedResetAtMs`, `summariseArgs`, `limitKindForRateLimitType`, and the
   `stableStringify`/`buildArgKey` pair remain plain exported functions: a
   pipeline around them adds overhead and indirection but no named-stage test
   surface beyond the direct unit tests they already have. They are consumed
   by pipeline stages.

| Site | Combinator | Pipeline name |
| --- | --- | --- |
| `turn-outcome-classification.ts:classifyTurnCompletion` | Gates/helpers of the complete delivery-turn completion operation incl. recovery effects and the guarded delivery-turn-end marker clear (review corrections round 22 + PR #2981) | `delivery-turn-completion` |
| `turn-outcome-classification.ts:decideReconcileAdmission` | Admission stages of the complete `reconcile-stranded-deliveries` pipelines (review correction round 22) | `reconcile-stranded-deliveries` |
| `limit-error-classifier.ts:assessLimitError` | raw superpipe transform | `limit-error-assess` |
| `limit-error-classifier.ts:resolveLimitKind`, `isBillingTerminal` | none (leaves) | — |
| `repeated-tool-error-gates.ts:decideConsecutiveError` | Per-row reducer pipeline of the complete error-observation operation (orchestration owns the loop per ADR 0004 P6): classification-once with reset/ignore arms, scope gate, state/reset/evidence/recovery effects with stage-local failure isolation (review corrections round 22 + PR #2981) | `repeated-tool-error-observation` |
| `loop-detector-gates.ts:decideIdenticalArgsLoop`, `decideBashDeadLoop` | Direct pipeline composing both (new `loop-detector-pipeline.ts`; review correction PR #2981: NOT `decisionRun`, whose per-gate `!hasDecided` halt would stop execution before the ledger/ring/logging/output effect stages) | `tool-call-loop-admission` |
| `circuit-breaker-transitions.ts:extractErrorPattern` | Ordinary pure helper consumed by the complete circuit-breaker check operation (review correction round 21: no standalone runner) | `breaker-check` |
| `circuit-breaker-transitions.ts:buildTripMessage` | Plain helper consumed by the complete breaker-check pipeline (review correction round 22) | — |
| `fallback-recovery.ts:extractResetTimestamp` | Ordinary pure helper over inline parse logic (review correction: no separate parse or cooldown pipelines — `computeCooldown` is consumed as a pure helper by `rate-limit-trip`) | — |
| `fallback-recovery.ts:computeCooldown` | Ordinary pure helper for `rate-limit-trip`'s cooldown-resolution stage (review correction round 17: `fallback-cooldown` as a separate runner makes every no-hint trip execute a nested pipeline) | — |
| `fallback-recovery.ts:resolveFallbackChain`, `classifyLimitKind` | none (leaves) | — |
| `rate-limit-watchdog-gates.ts:decideRateLimitTrip` | Classification helper/stages of the complete rate-limit scheduling pipeline (review correction round 22) | `rate-limit-trip` |
| `rate-limit-watchdog-gates.ts:refinedResetAtMs` | none (leaf) | — |
| `message-delivery.ts:classifyReclaimTermination` | Gates of the complete reclaim operation incl. the guarded marker-clear effect (review correction round 22) | `message-reclaim` |
| `message-delivery.ts:asMessageDeliveryPayload` | raw superpipe transform | `message-delivery-payload` |
| `query-runner.ts:parseApiValidationError` | `decisionRun` (after extraction to a module) | `api-validation-parse` |
| `query-runner.ts:terminalUserMessageFor` | `decisionRun` (after extraction to a module) | `terminal-user-message` |
| `message-delivery-pipeline.ts:applyFlushFinalGate` | already `decisionRun` (`message-turn-end-flush`) | no change |
| `ack-selection.ts:selectPersistedAckRow`, `selectYieldedAckRow` | Priority tables as plain helpers/stages of complete yielded/persisted acknowledgment pipelines (review correction round 21: selection-only runners split each ack path at its effect boundary) | `ack-yielded` / `ack-persisted` |

Overlaps with sibling plans: `query-retry-routing.ts`, the delivery routing
cores, and the turn-end/ack apply chain belong to the agent-routing plan
(review correction PR #2981: that sibling plan lands as its own PR in the
same series — lsm/HyperNeo#2980 — it is not a file in THIS PR's tree) and
the pilot proposal's Chains A/B/C
(`docs/agent-layer-superpipe-pilot-proposal.md`). This plan
touches `ack-selection.ts` only for the combinator composition; the
`sdk-message-handler.ts` apply step is Chain C's C3b and stays gated on it.

## Existing superpipe examples to emulate

### `decisionRun` patterns

1. `packages/daemon/src/lib/agent/turn-end-pipeline.ts` —
   `decisionRun('sdk-turn-end', [usage gate, ack gate, routing gate, final
   gate])`. Shows side-annotation fields (`usage`, `ackSelection`) computed by
   non-deciding gates, a delegating gate that calls another pure core, and a
   final gate that merges everything into `decision`.
2. `packages/daemon/src/lib/agent/message-delivery-pipeline.ts` —
   `decisionRun('message-inject-delivery', …)` and
   `decisionRun('message-turn-end-flush', …)`. Shows a gate that flips a side
   flag without deciding (`applyFailedReopenGate`), delegation into
   `context-reset-planner`/`message-ownership-gates`, and the exported
   `decideX` wrapper that seeds null fields and applies a fallback.
3. `packages/daemon/src/lib/agent/query-retry-routing.ts` —
   `queryRetryDecisionRun`: a classifier gate that never decides plus a
   mapping gate that always does. This is the closest shape for
   `decideRateLimitTrip` and `decideConsecutiveError`.
4. `packages/daemon/src/lib/space/runtime/run-tick-decision-pipeline.ts` —
   long gate list, cheap short-circuit gates first.
5. `packages/daemon/src/lib/space/runtime/agent-message-routing-pipeline.ts` —
   short cascade with a typed decision union.

### Raw `superpipe` transform pattern

`packages/daemon/src/lib/space/runtime/external-event-steer-admission-pipeline.ts`
is the model for both raw-transform sites:

```ts
const pipeline = (
  superpipe<{ settled: (ctx: Ctx) => boolean }>({ settled })(name) as PipelineAPI
)
  .input(['ctx'])
  .pipe(stageA, 'ctx', 'ctx')
  .pipe('!settled', 'ctx')
  .pipe(stageB, 'ctx', 'ctx')
  …
  .end('ctx');
```

Exported stage functions, a `decided(ctx, decision)` helper, and a wrapper
that seeds `decision: null`. `assessLimitError` and `asMessageDeliveryPayload`
copy this shape; neither needs a custom settled guard (linear stages), so a
plain `superpipe({})(name)` function registry suffices.

### `stagedRun` (reference only)

`verified-stop-flow.ts` and `spawn-flow.ts` — async, CAS-guarded,
compensated. Review correction (PR #2981): several planned pipelines in this
plan DO perform awaited effects — the breaker's async `onTrip`,
reconciliation's awaited state updates, repeated-error intervention work,
acknowledgement publications, and the loop ledger
writes. (The reclaim marker clear is SYNCHRONOUS today —
`clearDeliveryTurnEnd` is a sync DB write consumed by two synchronous
boolean call sites, so that one pipeline stays on synchronous `.end`;
review correction PR #2981.) Those compose as direct async-capable pipelines (`.endAsync` /
awaited effect stages over injected collaborators) so the promises are
actually awaited; synchronous `decisionRun`/`.end` runners are reserved for
the PURE classifier cores only. `stagedRun` itself stays reference-only —
none of these sites needs its compensation machinery.

## Per-site detailed plans

### `turn-outcome-classification.ts:classifyTurnCompletion`

- **current summary.** Hand-rolled cascade at
  `packages/daemon/src/lib/agent/turn-outcome-classification.ts:21-53`:
  `producedResult` → `completed`; else compute a `detail` string from
  `turnError`/`errorResultSubtype`/`deliveryTurnStalled`; `turnError` terminal
  (via `isTerminalTurnError` from `message-delivery.ts`) → `terminal_error`;
  non-retryable `errorResultSubtype` without a turn error → `terminal_error`;
  else `recoverable_error` with `reopenForRetry: claimGuardHeld ?? true`.
  Called from `agent-session.ts:2375-2394` inside the no-result branch of the
  delivery turn wait; the shell throws
  `MessageDeliveryTerminalTurnError`/`MessageDeliveryRecoverableTurnError`,
  escalates zero-progress failures, and reopens for retry. Pinned by
  `tests/unit/1-core/agent/turn-outcome-classification.test.ts` (~270 lines,
  15+ rows). Extracted as a pure core in #2639 (pilot 4 PR 4).
- **proposed combinator.** Review correction round 22: the classification gates are helpers or DIRECT stages of the complete delivery-turn completion operation (including its recovery effects) — no standalone `agent-turn-completion` classifier runner.
- **input/output snapshot design.**
  ```ts
  interface TurnCompletionCtx {
    input: TurnCompletionInput;        // producedResult, deliveryTurnStalled,
                                       // recoveryPending, manualRecoveryPause, cooldownRetryAt, now,
                                       // kickoffAcknowledged, kickoffAckInvalidated, alreadyConsumed
    turnError: StructuredError | null; // failure-arm stage output (lazy — see gate 3)
    errorResultSubtype: string | null; // failure-arm stage output (lazy — see gate 3)
    claimGuardHeld: boolean | undefined; // failure-arm stage output (lazy — see gate 7)
    detail: string | null;             // side annotation from the detail gate
    decision: TurnCompletionOutcome | null;
  }
  export type TurnCompletionPipelineInput = Omit<TurnCompletionCtx, 'detail' | 'decision'>;
  ```
  The input snapshot carries only cheap, NON-destructive reads (the DB
  `producedResult` query, the
  `deliveryTurnStalled`/recovery-pending flag reads, the escalation
  eligibility flags, and the injected `now`). `turnError`,
  `errorResultSubtype`, and
  `claimGuardHeld` are produced INSIDE the pipeline by failure-arm stages
  over injected collaborators (`consumeTerminalTurnError(turnStartedAt)`,
  `getErrorTerminalResultSubtypeAfter(...)`,
  `claimGuard()`) — never eagerly in the shell: `consumeTerminalTurnError`
  clears `lastTerminalError` (`agent-session.ts:2545-2549`) and successful
  turns must not perform that mutation, the claim guard must not run on
  the successful arm, and today the subtype query runs only inside the
  failure arm after the recovery-pending branch returns
  (`agent-session.ts:2378-2380` — review correction PR #2981: gathering it
  eagerly makes every successful or parked turn perform an irrelevant DB
  query whose transient failure can convert a completed or safely parked
  delivery into an error). Output stays
  `TurnCompletionOutcome`, EXTENDED with the `recovery_pending` arm
  (`{ outcome: 'recovery_pending'; retryAt: number }`) the pipeline now owns
  (see gate 2) — the union is consumed by the shell's
  throw/escalate/park interpretation and by re-export from
  `message-delivery-pipeline.ts:193-199`.
- **pure core design.** Gates (all exported for tests):
  1. `applyProducedResultGate` — `input.producedResult` →
     `decided(ctx, { outcome: 'completed' })`. Runs FIRST, before any
     destructive-snapshot stage, so successful turns consume nothing.
  2. `applyRecoveryPendingGate` (review correction PR #2981) —
     `!producedResult && recoveryPending` → `decided(ctx, { outcome:
     'recovery_pending', retryAt })` where `retryAt = manualRecoveryPause ?
     now + MANUAL_RECOVERY_PARK_MS : Math.max(now +
     MESSAGE_DELIVERY_PARK_MS, cooldownRetryAt ?? 0)` (verbatim from
     `agent-session.ts:2364-2374`); its effect stages perform that branch's
     marker clear and parking log. Without this gate the arm stays an
     imperative branch outside the "complete" operation.
  3. `applyTurnErrorConsumeStage` — failure-arm effect/transform stage:
     calls the injected `consumeTerminalTurnError(turnStartedAt)` and stores
     the result in `ctx.turnError`, and gathers
     `ctx.errorResultSubtype` via the injected repo query (lazy by
     construction — only reached when
     neither gate 1 nor gate 2 decided; review correction PR #2981).
  4. `applyTurnDetailGate` — computes `detail` from the
     preference chain `turnError.userMessage || turnError.message ||
     subtype-template || stall-template || default` and stores it in `ctx.detail`
     without deciding (transform gate; mirrors
     `applyUsageAccountingGate`).
  5. `applyTerminalTurnErrorGate` — `ctx.turnError &&
     isTerminalTurnError(...)` →
     `decided(ctx, { outcome: 'terminal_error', detail, category })`.
  6. `applyTerminalSubtypeGate` — no turn error, subtype present,
     `!isRetryableErrorResultSubtype(subtype)` →
     `decided(ctx, { outcome: 'terminal_error', … })`.
  7. `applyClaimGuardStage` — failure-arm stage: invokes the injected
     `claimGuard()` (if provided) and stores `claimGuardHeld` — the guard is
     never invoked on the successful or recovery-pending arms.
  8. `applyRecoverableFinalGate` — always decides
     `{ outcome: 'recoverable_error', detail, category, reopenForRetry }`.
  Because gate 4 always populates `detail` before any deciding gate reads it,
  the `??` fallbacks in the deciding gates collapse to `ctx.detail!` guarded
  by the wrapper (keep a defensive `??` recompute if preferred — see
  `turn-end-pipeline.ts:102-112` precedent).
- **shell/effect wiring.** Review correction round 22 + PR #2981: keep the
  classifier gates as helpers or DIRECT STAGES of the complete delivery-turn
  completion operation — its effect stages perform the arm interpretations
  currently imperative in `agent-session.ts` (the guarded
  `clearDeliveryTurnEnd` marker clear as the leading effect of every
  non-`completed` arm — the recovery-pending branch clears it at
  `agent-session.ts:2369` and every failed turn that proceeds past that
  branch clears it again BEFORE classification and any throw (`:2377`),
  while the `completed`-via-`producedResult` arm never clears it; dropping
  it would leave the stale marker for later reclaim logic to select
  `redrive`; `recovery_pending` → marker clear + parking log + return the
  parked result with `retryAt`; `terminal_error` → throw terminal;
  `recoverable_error` → zero-progress escalation GUARDED by the eligibility
  inputs (`!kickoffAcknowledged && !kickoffAckInvalidated &&
  !alreadyConsumed`, verbatim from `agent-session.ts:2392-2394` — the three
  flags ride in the ctx; an unconditional escalation stage accumulates false
  failures and can dead-letter an acknowledged delivery; an escalated
  terminal replaces the thrown error), optional `reopenDeliveryForRetry`,
  throw recoverable; `completed` → clear `zeroProgressDeliveryFailures` and
  return). Converting only the classifier
  into a runner while those recovery effects stay in `agent-session.ts`
  splits the completion operation at its decision/effect boundary.
- **step-by-step migration.** Review correction round 23: migrate the
  COMPLETE delivery-turn completion operation in ONE step — the
  classification gates land as stages of the completion pipeline together
  with the recovery effect stages (guarded `clearDeliveryTurnEnd` marker
  clear, recovery-pending parking, terminal throw, eligibility-guarded
  zero-progress escalation, optional `reopenDeliveryForRetry`,
  `zeroProgressDeliveryFailures` clearing); no
  classifier-first intermediate with a delegate wrapper that
  leaves `agent-session.ts` interpreting arms imperatively.
  1. Add the ctx/gate/effect-stage code in `turn-outcome-classification.ts`
     and rewire `agent-session.ts`'s completion call site to the complete
     pipeline in the same change.
  2. Keep `classifyTurnCompletion` exported as a thin delegate only if the
     parity suite still imports it; delete it otherwise.
  3. No re-export changes needed in `message-delivery-pipeline.ts` (it
     re-exports the symbol, not the implementation).
- **tests.** Existing suite must pass byte-identical (parity proof). Add two
  pipeline-contract rows (review correction — both must hold for
  `producedResult: true`): (a) a spy gate after `applyProducedResultGate`
  asserts the cascade halted and the later detail gate was NEVER invoked;
  (b) `completed` rows never build a detail string (the current classifier
  returns `completed` before reading any error-detail fields — preserve that
  laziness; do not also require the detail gate to run).
- **risks/caveats.** The `detail` preference chain is user-visible in thrown
  errors; a gate-order slip (detail gate after the first deciding gate)
  silently yields `undefined` detail. The `?? true` default on
  `reopenForRetry` must ride inside the final gate verbatim — it encodes
  "reopen unless the claim guard explicitly said otherwise".

### `turn-outcome-classification.ts:decideReconcileAdmission`

- **current summary.** Three-value status gate at
  `turn-outcome-classification.ts:73-84`: `processing|queued|waiting_for_input`
  → `skip`, else `run`. Two consumers perform the *same* three-check preamble
  inline before calling it: `agent-session.ts:2852-2859`
  (`isMessageDeliveryV2Enabled()` + `jobQueue` presence + status gate) and
  `message-delivery.ts:205-215` (`reconcileStrandedDeliveries`: V2 flag +
  lock + status gate via `selectStrandedDeliveries` flow). The duplicated
  preamble is the actual hand-rolled cascade.
- **proposed combinator.** Review correction round 22: compose the
  COMPLETE reconciliation operation as one pipeline per invocation path —
  the preamble gates are direct admission stages, followed by the
  coordinated lock, `selectStrandedDeliveries` row filtering, enqueue,
  and session-state update as its stages, with submitted-message
  settlement appended ONLY on the agent-session variant (review correction
  PR #2981 — see the wiring note below). No
  admission-only runner in front of an imperative effect cascade.
- **input/output snapshot design.**
  ```ts
  interface ReconcileAdmissionCtx {
    deliveryV2Enabled: boolean;
    jobQueuePresent: boolean;
    processingStatus: string;
    decision: { action: 'skip'; reason: 'v2_disabled' | 'no_job_queue' | 'busy' } | { action: 'run' } | null;
  }
  ```
  The `reason` discriminates skip causes for logging/tests — a pure addition;
  the public `decideReconcileAdmission(args: { processingStatus })` signature
  stays for the narrow legacy call if desired.
- **pure core design.** Three gates in precedence order:
  `applyDeliveryV2Gate` (skip `v2_disabled`), `applyJobQueueGate` (skip
  `no_job_queue`), `applyBusyStatusGate` (skip `busy`), final
  `applyRunGate`. Order matters: today `agent-session.ts` checks V2 → jobQueue
  → status; `message-delivery.ts` checks V2 → (lock) → selection. The
  coordinated lock is an effect stage INSIDE each complete pipeline variant
  (review correction PR #2981) — it encloses selection and enqueueing in
  both current paths, so keeping it in the shell would leave the central
  concurrency effect outside the operation that owns the whole
  select-and-enqueue path.
- **shell/effect wiring.** Review correction round 22 — BOTH call sites
  run the complete reconciliation pipeline; neither keeps an imperative
  cascade behind an admission-only runner. The two snapshots differ
  honestly: `agent-session.ts:2852-2859` supplies `processingStatus` (its
  busy-status admission stage runs), while
  `message-delivery.ts:reconcileStrandedDeliveries` exposes no session
  status to snapshot (its `processingStatus` is `null` and the busy-status
  stage passes — inventing a status default or skipping busy sessions there
  would be a contract change). Both variants are ORCHESTRATION-shaped per
  ADR 0004 P6 (review correction PR #2981: pipelines are per-event reducer
  bodies, never the loop — the row folds live in the reconciliation
  orchestration, which invokes a reducer pipeline per stranded row and,
  on the session variant, per stale submitted row, keeping individual
  state transitions explicit). The two variants also differ in effects
  (review correction PR #2981): the standalone path's order is V2-flag
  gate → coordinated lock → `selectStrandedDeliveries` filtering against
  active/in-flight UUIDs → the per-row re-enqueue reducer fold (enqueue +
  session-state update) — NO
  submitted-message settlement (that path only queries `enqueued` rows and
  its `StrandedDeliveryDb` interface cannot query or fail `submitted` rows,
  `message-delivery.ts:201-203`; wiring settlement there would introduce new
  message-failure behavior); the agent-session variant wraps its
  selection/enqueue orchestration in `withSessionResetCoordination` AROUND the
  coordinated lock (`agent-session.ts:2867-2883`; review correction PR
  #2981: the reset-coordination envelope is part of that variant's prefix —
  without it, reconciliation overlapping a conversation reset can select
  and enqueue rows during the reset and resurrect a delivery the reset is
  clearing), and appends the
  submitted-row settlement fold (`agent-session.ts:2884-2905`) in its
  own coordinated-lock orchestration — settlement is NOT under reset coordination
  today, and the prefix is not literally "the same" as the standalone
  variant's — closing with the guarded summary-log stage
  (`if (reEnqueued > 0 || settled > 0)` log at `:2906-2909`; review
  correction PR #2981: it runs after both counts are known, inside the
  operation — dropping it loses the operational signal, leaving it in the
  caller keeps a decision-dependent effect outside the operation). The
  V2-flag predicate is shared. The
  session-state update and settlement publication effect stages carry
  today's per-row failure containment (review correction PR #2981:
  `message-delivery.ts:221-225` and `agent-session.ts:2875-2879` catch each
  `setQueuedIfIdle` rejection and keep processing later rows;
  `agent-session.ts:2896-2902` contains each settlement publication
  rejection) AND keep the settlement publications as FIRE-AND-FORGET
  `void publish(...).catch(...)` launches under the lock, exactly as today
  (review correction PR #2981: an awaited publication stage would let a
  slow or non-settling subscriber hold the session lock indefinitely,
  blocking subsequent delivery and reconciliation work; the database
  settlement itself stays inside the reducer and lock) — without stage-local catches, a transient failure would
  abort the pipeline, skip remaining re-enqueues or settlement, and reject
  reconciliation where it currently succeeds.
- **step-by-step migration.** 1) Compose the TWO complete reconciliation
  pipeline variants (admission gates + lock/select/enqueue/update stages;
  the submitted-message settlement stage exists ONLY on the agent-session
  variant — the standalone variant has no settlement stage, matching the
  PR 8/9 scopes); 2) rewire BOTH `agent-session.ts:2852-2859` and
  `message-delivery.ts:reconcileStrandedDeliveries` to run their variant
  with their own snapshots; 3) keep the exported narrow function as a
  delegate or delete it (only tests import it directly).
- **tests.** Existing `decideReconcileAdmission` rows keep passing via the
  delegate; add admission rows for `v2_disabled`/`no_job_queue` (currently
  untestable — they live inline) and one row pinning that a `busy` status
  skips even when V2 and jobQueue are present, plus a row that a `null`
  `processingStatus` snapshot (the `message-delivery.ts` entry) never
  skips.
- **risks/caveats.** `message-delivery.ts:reconcileStrandedDeliveries` is
  also invoked from the idle callback (B5e territory in the pilot proposal);
  coordinate the apply PR so it does not collide with Chain B's fencing work
  on the same continuation.

### `limit-error-classifier.ts:assessLimitError`

- **current summary.** The central limit detector at
  `limit-error-classifier.ts:114-183`. Computes in sequence: structured reset
  from `rateLimitInfo` (`structuredResetAtMs`), structured-rejected flag,
  text-parsed reset (`extractResetTimestamp`), a `billingTerminal` boolean
  OR-ing six signals, text/status/tag/terminal `*Limit` booleans, then a
  single `isLimit` OR; if not a limit, returns the canonical negative
  assessment; otherwise derives `kind` (`resolveLimitKind`), `confidence`,
  and `source` via if/else precedence. Callers:
  `query-runner.ts:932` (streaming catch signal build),
  `acp/acp-query-runner.ts:1009` (same for ACP), and
  `sdk-message-handler.ts:1220` (`assessResultLimitError`, synthetic result
  path — feeds the watchdog hint). Pinned by
  `tests/unit/1-core/agent/limit-error-classifier.test.ts`.
- **proposed combinator.** Raw superpipe transform
  `limit-error-assess` — this is enrichment with several derived outputs and
  an early terminal answer, not a first-match decision cascade: the `isLimit`
  OR reads *all* detector outputs, and `source`/`confidence`/`kind` are
  computed jointly afterwards.
- **input/output snapshot design.**
  ```ts
  interface LimitAssessCtx {
    signal: LimitErrorSignal;
    now: number;
    parsed: ParsedReset | null;         // stage output
    structuredReset: number | null;     // stage output
    structuredRejected: boolean;        // stage output
    billingTerminal: boolean;           // stage output
    detection: { textLimit: boolean; statusLimit: boolean; tagLimit: boolean; terminalLimit: boolean } | null;
    assessment: LimitErrorAssessment | null;  // final stage output
    decision: null;                      // unused; kept for wrapper symmetry? No — omit entirely
  }
  ```
  Omit `decision` — the raw-transform shape from
  `external-event-steer-admission-pipeline.ts` does not require it; the
  wrapper returns `ctx.assessment` and seeds stage outputs as `null/false`.
  Public signature `assessLimitError(signal, now?)` is preserved.
- **pure core design.** Linear stages:
  1. `parseStructuredResetStage` — `rateLimitInfo` →
     `structuredReset`/`structuredRejected`.
  2. `parseTextResetStage` — calls the plain `extractResetTimestamp` helper
     DIRECTLY (review correction PR #2981: it is an ordinary pure helper,
     not a pipeline, so calling it cannot execute a nested run — and
     re-implementing its five ordered strategies inline here would create a
     second parser that can drift from the helper still used by
     `computeCooldown`/`isBillingTerminal`).
  3. `resolveBillingStage` — OR of `httpStatus===402`,
     `sdkErrorTag === 'billing_error'` (review correction: the SDK tag
     contributes only on that exact equality — treating raw `sdkErrorTag`
     truthiness as an operand makes every non-empty tag, notably the common
     `rate_limit` tag, billing-terminal when no reset is present and the
     watchdog surfaces billing instead of scheduling its cooldown),
     `isStructuredBillingTerminal`, `isBillingTerminal(rawText, now)`, gated
     on `resetAtMs === null` (structured reset and parsed reset merge first:
     fold the `structuredReset ?? parsed?.resetAtMs ?? null` merge into the
     head of this stage or a tiny merge stage).
  4. `detectLimitMarkersStage` — text/status/tag/terminal booleans
     (`terminalLimit` keeps the `PROMPT_TOO_LONG_RE` carve-out).
  5. `emitAssessmentStage` — the `isLimit` OR; negative canonical answer, or
     the full assessment with `resolveLimitKind` /
     confidence / source precedence. One `!detected` style halt is available
     but not required; keep the run linear so every row exercises all stages
     exactly as the function does today.
- **shell/effect wiring.** No shell change: the three call sites keep calling
  `assessLimitError`. In `query-runner.ts:932`/ACP the result feeds the
  `QueryRetryErrorSignal`; in `sdk-message-handler.ts:1220` it becomes the
  watchdog `LimitRetryHint` → `decideRateLimitTrip`.
- **step-by-step migration.** 1) Add stages + pipeline; `assessLimitError`
  becomes `limitAssessRun({ signal, now }).assessment` with a defensive
  fallback to the current imperative body only if the migration lands before
  `extractResetTimestamp`'s own pipeline (otherwise no fallback needed);
  2) leave `resolveLimitKind`/`isBillingTerminal`/`normalizeEpochMs`/
  `cooldownFromReset` exports untouched (imported by
  `rate-limit-watchdog-gates.ts` and tests).
- **tests.** The existing classifier suite is the parity proof (it covers GLM
  bracket codes, framed 429, structured events, 402 billing, epoch
  normalization). Add stage-level rows: `source` precedence
  (`rate_limit_event` > `sdk-error-tag` > `http-status` > `parsed:*` >
  `billing` > `text`), and one row where a structured reset suppresses the
  text-parse result (`structuredReset ?? parsed` merge).
- **risks/caveats.** This is the highest-blast-radius classifier in the plan:
  a regressed `isLimit`/`billingTerminal` flips retry arms into terminal
  errors (or vice versa) for real providers. The
  `resetAtMs === null` precondition inside `billingTerminal` is load-bearing
  (a parseable reset means the limit is not billing-terminal); if stage
  ordering accidentally computes billing before the merge, GLM/Anthropic
  429-with-reset rows regress. `Date.now()` stays an injected `now` parameter
  — never read inside stages. Do not pipeline the leaf regex helpers
  (`looksLikeLimitText` etc. are hot relative to the rest — they run per
  caught error, which is fine, but wrapping them adds nothing).

### `repeated-tool-error-gates.ts:decideConsecutiveError`

- **current summary.** Three-arm gate at
  `repeated-tool-error-gates.ts:99-126`: intervention cooldown active →
  `cooldown_reset`; else count same-vs-different fingerprint, `>= threshold` →
  `intervene`; else `count` with new state. Called per error row from
  `RepeatedToolErrorGuardrail.observeToolResultErrors`
  (`repeated-tool-error-guardrail.ts:93-117`); the guardrail interprets by
  mutating `this.state` and, on `intervene`, emitting Forge evidence and
  routing a recovery message. Extracted as a pure core in #2702; pinned by
  `tests/unit/1-core/agent/repeated-tool-error-gates.test.ts` +
  `repeated-tool-error-guardrail.test.ts`.
- **proposed combinator.** Review correction round 21: compose the COMPLETE error-observation operation as one pipeline — classification stages (the three arms) plus the effect stages the guardrail currently performs imperatively (state update, reset, Forge evidence emission on `intervene`, recovery-message routing). Keeping the classifier a runner while state/effects stay in the guardrail shell preserves the decision/effect split this migration removes.
- **input/output snapshot design.**
  ```ts
  interface ConsecutiveErrorCtx {
    toolName: string;
    fingerprint: string;
    state: ErrorObservationState;   // { lastError, consecutiveCount } — FIRST row's snapshot; the
                                    // iteration threads the updated state forward (see below)
    lastInterventionAt: number | undefined;
    threshold: number;
    interventionCooldownMs: number;
    now: number;
    consecutiveCount: number | null;  // side annotation from the count stage
    decision: ConsecutiveErrorDecision | null;
  }
  ```
  This is the PER-ERROR decision context. The observation stays ONE
  business operation at the ORCHESTRATION level, with the row loop OUTSIDE
  the pipeline per ADR 0004's P6 rule ("pipeline as reducer body, never
  the loop"; review correction PR #2981): the observation body runs the
  scope gate and classifies the whole message ONCE (its `reset`/`ignore`
  arms resolved there — never per block), then iterates the deduplicated
  `classification.errors` rows, invoking this per-row REDUCER pipeline for
  each and OR-aggregating the `triggered` result exactly as the current
  loop does (`repeated-tool-error-guardrail.ts:91-119`). Classification-once
  is preserved (a message with multiple error blocks or interleaved
  success blocks is one observation — re-classifying per row would change
  outcomes), while the loop, state threading, and aggregation live in the
  observation orchestration, not inside one opaque stage. The orchestration
  THREADS THE UPDATED STATE between rows: today each row's classification
  reads the state written by the preceding
  row (`:93-112` live reads), so each reducer invocation receives the state
  the previous one wrote — evaluating every row against the initial snapshot
  changes outcomes (streak `B × 1` plus errors `A` then `B` at threshold 2
  ends at `B × 1` today, but snapshot-frozen evaluation would see `B × 2`
  on the second row and falsely intervene).
- **pure core design.** Gates:
  1. `applyInterventionCooldownGate` — the `now - lastInterventionAt <
     cooldownMs` check → `cooldown_reset`.
  2. `applyStreakCountGate` — transform: `sameAsLast ? count+1 : 1` into
     `ctx.consecutiveCount` (never decides).
  3. `applyThresholdGate` — `consecutiveCount >= threshold` → `intervene`.
  4. `applyCountFinalGate` — decides `count` with the new `lastError`.
- **shell/effect wiring.** Review correction round 22 + PR #2981: compose the
  COMPLETE error-observation operation as one pipeline — the scope
  precondition FIRST (review correction PR #2981: `applyScopeGate` —
  `getTaskForSession()` returning no task or a task without
  `evolutionScopeId` decides the passthrough `false` BEFORE classification,
  mirroring `repeated-tool-error-guardrail.ts:75-76`; the ctx carries the
  resolved `evolutionScopeId: string | null`, and without this gate
  unscoped sessions could mutate the streak and enter intervention effects
  that require a scoped task), then content
  classification (`classifyToolResultContent` as a helper/direct entry
  stage whose `reset` arm performs the state reset and whose `ignore` arm
  passes through, mirroring `repeated-tool-error-guardrail.ts:78-89` — the
  guardrail classifies BEFORE the per-error loop and immediately `reset()`s
  success blocks or error-free content, so the operation must start there,
  not at the error rows), then the per-error REDUCER pipeline
  (classification stages followed
  by effect stages for the keyed `lastInterventionByKey` intervention
  timestamp write (`repeated-tool-error-guardrail.ts:127-132`, read by
  later classifications at `:97-99`; review correction PR #2981: without
  it the same key re-crosses the threshold within
  `interventionCooldownMs` and re-emits evidence/recovery instead of taking
  `cooldown_reset`), state mutation (`this.state.lastError = …`),
  `reset()`, Forge evidence emission, and recovery-message routing) invoked
  ONCE PER ROW by the observation orchestration, which owns the loop,
  threads the updated state between rows, and OR-aggregates `triggered`
  (review correction PR #2981, per ADR 0004 P6 "pipeline as reducer body,
  never the loop": the row loop is NOT a pipeline stage; classification
  stays once-per-message, so a later block's reset cannot race an earlier
  row's intervention and multiple errors still aggregate);
  the observation injects a CLOCK FUNCTION, not a frozen timestamp — the
  orchestration evaluates it per error row
  (`repeated-tool-error-guardrail.ts:102`, passing the fresh value into each
  reducer invocation)
  and again when recording the intervention timestamp (`:127-131`; review
  correction PR #2981: a single entry-time value freezes cooldown decisions
  across an awaited earlier intervention — a later key whose cooldown
  expires mid-observation counts today but would falsely take
  `cooldown_reset`, and new cooldowns would start early).
  The evidence-emission and routing effect stages preserve today's
  stage-local failure isolation (`repeated-tool-error-guardrail.ts:134-152`):
  an evidence-emission throw is caught and logged while recovery routing
  still runs, and a rejected recovery publication is caught so
  `observeToolResultErrors` never rejects — the existing suite pins both
  cases; consecutive unguarded stages would let an evidence failure abort
  routing or a routing failure escape the guardrail, so the per-stage
  try/catch containment (or equivalent stage-local handlers) is required.
- **step-by-step migration.** 1) Add gates + effect stages +
  `decideConsecutiveError` pipeline wrapper; 2) `observeToolResultErrors`
  becomes the observation ORCHESTRATION: scope gate, classification-once
  with its `reset`/`ignore` arms, then the row loop invoking the reducer
  pipeline per row with the threaded state and per-row clock, aggregating
  `triggered` (review correction PR #2981, per ADR 0004 P6: the loop stays
  in the orchestration — the pipeline is the per-row reducer; classification
  never re-runs per row); 3) no other callers exist.
- **tests.** Existing gates suite passes unchanged. Add: halt row (threshold
  gate fires → final gate not reached), and cooldown row asserting
  `lastInterventionAt === undefined` never trips the cooldown gate.
- **risks/caveats.** The count stage must not decide, or the `intervene` arm
  loses access to the computed `consecutiveCount`. `now` stays injected
  (guardrail passes `Date.now()`); never call `Date.now()` in a gate.
  Frequency: once per tool-error row per assistant message — pipeline
  overhead (~2.6 µs) is noise next to the DB/evidence effects around it.

### `loop-detector-gates.ts:decideIdenticalArgsLoop`, `decideBashDeadLoop`

- **current summary.** Two deny/allow gates:
  `decideIdenticalArgsLoop` (`loop-detector-gates.ts:163-174`, threshold +
  `summariseArgs` → deny reason) and `decideBashDeadLoop`
  (`:176-192`, threshold + all-failures ring → deny). The real hand-rolled
  cascade lives in the hook callback `buildPreToolUseCallback`
  (`loop-detector-hook.ts:118-200`): enabled check → threshold-presence /
  bash branch → `advanceLoopStreak` + ledger write + sweep → bash ring
  evaluation (with expiry cleanup) → `decideBashDeadLoop` or
  `decideIdenticalArgsLoop` → deny hook output. PostToolUse(Failure)
  callbacks only update the ring. Extracted as pure gates in #2704; pinned by
  `loop-detector-gates.test.ts` + `loop-detector-hook.test.ts`.
- **proposed combinator.** Review correction round 23: ONE complete
  PreToolUse loop-admission pipeline in a new
  `packages/daemon/src/lib/agent/loop-detector-pipeline.ts` — the
  streak/ring transforms and decision gates FOLLOWED BY guarded effect
  stages for the ledger delete/`set` (per the `resetLedger` rules below),
  `sweepLedger`, expired-ring deletion, deny logging, and the deny hook
  output. The Maps stay shell-owned resources passed to the pipeline as
  deps; the pipeline commits the next-state decision, so it can never be
  invoked without its state effects.
- **input/output snapshot design.**
  ```ts
  interface LoopAdmissionCtx {
    eventName: string;
    enabled: boolean;
    toolName: string;
    input: Record<string, unknown>;
    cwd: string | undefined;
    thresholds: Record<string, number>;
    bashEnabled: boolean;
    bash: { threshold: number; failuresRequired: number };
    windowMs: number;
    now: number;
    prevStreak: LoopStreakState | undefined;   // snapshot from the ledger
    prevRing: BashFailureRing | undefined;     // looked up INSIDE the bash stage via the ring-map dep —
                                               // the ring key depends on the argKey-derived fingerprint
    argKey: string | null;                     // stage output
    streak: LoopStreakState | null;            // stage output
    ring: BashFailureRingEvaluation | null;    // stage output
    decision:
      | { action: 'allow'; streak: LoopStreakState; ringExpired: boolean }
      | { action: 'deny'; reason: string; streak: LoopStreakState }
      | null;
  }
  ```
  The decision carries the **next** streak state so the shell can write the
  ledger without recomputation; `ringExpired` tells the shell to drop the
  stale ring entry (today's `loop-detector-hook.ts:156` cleanup).
- **pure core design.** Gates/stages:
  1. `applyPreToolUseEventGate` — `eventName !== 'PreToolUse'` → decide the
     empty-`{}` passthrough BEFORE any state transform (review correction
     PR #2981: `buildPreToolUseCallback` returns `{}` immediately for
     non-PreToolUse payloads, `loop-detector-hook.ts:118-120`, and the hook
     suite pins it; unlike the disabled/no-threshold arm this gate performs
     NO ledger deletion — an accidentally dispatched `PostToolUse` payload
     for a monitored tool must not advance the ledger or be denied).
  2. `applyDisabledGate` — `!enabled` → `allow` passthrough with NO ledger
     or ring effects of any kind (review correction PR #2981: the current
     callback returns at `loop-detector-hook.ts:118` BEFORE deriving a
     scope or touching either map — a disabled invocation with preexisting
     state is a no-op, not a mutation; conflating it with the no-threshold
     branch changes behavior).
  3. `applyUnmonitoredGate` — enabled but (no threshold and not bash) →
     `allow` with the passthrough streak and `resetLedger: true` (this and
     only this branch deletes the scope ledger today,
     `loop-detector-hook.ts:130-132`).
  4. `applyArgKeyStage` — transform: `buildArgKey(toolName, input, cwd)`.
  5. `applyStreakAdvanceStage` — transform: `advanceLoopStreak` → `streak`.
  6. `applyBashRingStage` — bash-only transform: `evaluateBashFailureRing`
     (pure read of `prevRing`); non-bash rows skip via a guard gate that
     leaves `ring: null`.
  7. `applyBashDeadLoopGate` — bash and `streak.count >= bash.threshold` and
     ring all-failures → `decideBashDeadLoop(...)` mapped into a deny
     decision (delegate to the existing function — it stays exported).
  8. `applyIdenticalArgsGate` — non-bash, threshold met →
     `decideIdenticalArgsLoop(...)`.
  9. `applyAllowFinalGate` — decides `allow` with next streak and
     `ringExpired`.
- **shell/effect wiring.** Review correction round 23: the COMPLETE
  loop-admission pipeline performs the state effects as guarded stages —
  the shell (`buildPreToolUseCallback`) shrinks to snapshot
  (`input.hook_event_name` → `ctx.eventName` for the leading event gate,
  `state.ledger.get(scope)`; review correction PR #2981: the ring entry is
  NOT snapshotted in the shell — its key depends on the fingerprint
  derived from `buildArgKey`, which runs as `applyArgKeyStage` INSIDE the
  pipeline, exactly as the current hook derives the fingerprint before
  reading the ring (`loop-detector-hook.ts:149-152`). The bash stage
  performs the guarded `state.bashFailures.get(ringKey)` lookup itself via
  the ring map passed as a dep, carrying the derived ring key forward for
  the expiry cleanup; duplicating `buildArgKey` in the shell or supplying
  an undefined `prevRing` would make the all-failures check miss real Bash
  dead loops) and run. Inside the
  pipeline, after the decision gates: when the decision carries
  `resetLedger`, DELETE the scope from `state.ledger` (matching the current
  hook, which deletes the session's ledger entry for the
  unmonitored/no-threshold branch; an unconditional `set(scope,
  decision.streak)` would resurrect the old streak after an intervening
  unmonitored tool call and can trigger a false loop denial on return to
  the monitored tool); otherwise `set(scope, decision.streak)` for BOTH
  allow and deny decisions (review correction: the current hook writes the
  advanced streak BEFORE returning the deny response; skipping the write on
  deny leaves the pre-threshold count and timestamp, so repeated denials
  stop refreshing the window and the same retried call is re-admitted once
  the stale entry ages out); then `sweepLedger`, expired-ring deletion, and
  on `deny` logging plus the `permissionDecision: 'deny'` hook output with
  `permissionDecisionReason`. The Maps are passed to the pipeline as deps —
  shell-owned resources, pipeline-committed mutations. PostToolUse(Failure)
  callbacks keep calling `recordBashRingOutcome` directly (they are pure
  state folds on the ring, already leaf functions).
- **step-by-step migration.** 1) Create `loop-detector-pipeline.ts` with
  ctx/gates + the guarded state-effect stages (ledger delete/set,
  `sweepLedger`, ring cleanup, deny logging, deny output) — the complete
  admission operation, landed and wired in one change; 2) rewire
  `buildPreToolUseCallback` to snapshot + run it; 3) keep
  `decideIdenticalArgsLoop` / `decideBashDeadLoop` exported (gate delegates;
  direct tests stay); 4) update `loop-detector-hook.test.ts` spy
  expectations if it counts logger calls (deny logging is a pipeline stage
  now).
- **tests.** Gate suites unchanged. Hook suite is the parity proof for the
  callback rewiring. Add pipeline rows: non-PreToolUse payload returns `{}`
  with NO ledger/ring mutation (the event gate runs before any state
  transform); disabled row is a NO-OP passthrough (no ledger touch) while
  the enabled no-threshold row resets
  the ledger (review correction PR #2981: only the no-threshold branch
  deletes, `loop-detector-hook.ts:130-132`); bash row with expired ring
  both denies-not and reports
  `ringExpired`; identical-args row where the deny reason embeds
  `summariseArgs` output.
- **risks/caveats.** This is the only site in the plan on a genuinely
  hot-ish path (every PreToolUse). Overhead is still trivial versus a tool
  round-trip, but do **not** wrap `buildArgKey`/`stableStringify` or the
  `sweepLedger` body in runners of their own (per-call, allocates; a Map
  iteration with a size condition) — they stay leaf FUNCTIONS whose
  invocations run as pipeline stages (review correction PR #2981: the
  `sweepLedger` CALL is a state-effect stage of the admission pipeline, not
  shell code). The ledger/ring Maps are state: they stay in
  the hook closure per ADR decision 5; the pipeline decides one admission,
  never owns the fold.

### `circuit-breaker-transitions.ts:extractErrorPattern`, `buildTripMessage`

- **current summary.** `extractErrorPattern`
  (`circuit-breaker-transitions.ts:66-111`): image-size short-circuit, then
  `<local-command-stderr>` extraction whose content is matched against fatal
  patterns (prompt_too_long with optional max-tokens, connection_error,
  image_size_error, invalid_request_error fallback) and an `Error:\s*(\d{3})\s*{`
  API-status arm (400/429 only); null otherwise. `buildTripMessage`
  (`:171-254`): template mapping by trip reason (`rapid_fire`,
  `prompt_too_long[:maxTokens]`, `invalid_request_error`, `image_size_error`,
  `connection_error`, `api_error:429`/generic, fallback `Error detected:
  ${reason}`). Consumers: `ApiErrorCircuitBreaker.checkMessage`
  (`api-error-circuit-breaker.ts:43-102`) — extracts text, pattern, records
  occurrences, trips; `getTripMessage` (`:140`) renders the user-facing trip
  banner. Pinned by `api-error-circuit-breaker.test.ts` (transition
  functions are also covered there and in #2759's extraction tests).
- **proposed combinator.** Review correction round 22: no standalone
  classifier runners — `extractErrorPattern` and `buildTripMessage` stay
  plain helpers consumed by the ONE complete breaker-check pipeline
  (`ApiErrorCircuitBreaker.checkMessage`: message-type gate → rapid-fire
  check — writing the advanced per-agent ring IMMEDIATELY,
  `api-error-circuit-breaker.ts:56-62`, BEFORE the content exits, so
  ordinary non-error messages still persist timestamps and the breaker can
  trip on normal message loops; review correction PR #2981 → message-text extraction with its empty-text false-return gate
  (`extractMessageText(msg.message?.content)`,
  `api-error-circuit-breaker.ts:69-73` — review correction PR #2981: the
  pattern classifiers consume the FLATTENED string, not raw SDK block-array
  content) → pattern
  classification → occurrence recording → `trip()` — cooldown release is
  EXCLUDED from `checkMessage`, see the wiring note below), as the
  corrected migration steps below prescribe.
- **input/output snapshot design.**
  ```ts
  interface ErrorPatternCtx { messageContent: string; decision: string | null; }
  interface TripMessageCtx { tripReason: string | null; decision: { text: string } | null; }
  ```
  `buildTripMessage`'s null-reason case becomes the first gate
  (`applyUnknownReasonGate` → `{ text: 'Unknown error' }`).
- **pure core design.** Pattern gates in current precedence order:
  `applyImageSizeGate` (top-level image-size test), `applyStderrGate`
  (transform: extracts stderr inner text into `ctx.stderrContent`), then
  inside-stderr gates — `applyPromptTooLongGate` (uses
  `matchPromptTooLong`, stamps `prompt_too_long[:maxTokens]`),
  `applyConnectionErrorGate`, `applyImageSizeInStderrGate`,
  `applyInvalidRequestGate`, `applyApiErrorStatusGate` (400/429), and no
  final decider (wrapper `?? null`). Note the current code nests the fatal
  patterns loop *before* the api-error match and only inside the stderr
  block — gate order must reproduce that nesting exactly (patterns first,
  api-status second, both stderr-scoped). Trip-message gates:
  `applyUnknownReasonGate`, `applyRapidFireGate`,
  `applyPromptTooLongGate` (`startsWith`), `applyInvalidRequestGate`,
  `applyImageSizeGate`, `applyConnectionGate`, `applyApiErrorGate`
  (`startsWith('api_error:')` with 429 special case), final
  `applyGenericReasonGate`.
- **shell/effect wiring.** Review correction round 21 + PR #2981: migrate the
  COMPLETE breaker check path directly — keep the text classifiers as
  ordinary pure helpers and compose message-type gate (the leading
  `msg.type !== 'user'` check at `api-error-circuit-breaker.ts:49-51` is the
  FIRST stage, BEFORE any timestamp mutation — `sdk-message-handler.ts:764`
  sends every SDK message through `checkMessage`, and without this gate
  assistant messages would enter rapid-fire accounting and trip falsely) →
  rapid-fire check — with the per-agent timestamp-ring write INSIDE this
  stage (`:56-62`, before any content exit; review correction PR #2981:
  moving it to occurrence recording after the exits would drop ordinary
  non-error messages' timestamps and break rapid-fire tripping on normal
  loops) → message-text extraction with its empty-text
  false-return gate (`extractMessageText(msg.message?.content)`,
  `api-error-circuit-breaker.ts:69-73` — the pattern classifiers consume
  the flattened string, not raw block-array content; review correction PR
  #2981) → pattern
  classification → occurrence recording (`recentErrors`,
  `messageTimestampsByAgent`, `state`) → `trip()` (with its async `onTrip`
  effect — the injected callback's rejection CAUGHT AND LOGGED INSIDE the
  stage, `api-error-circuit-breaker.ts:109-115`, pinned by
  `api-error-circuit-breaker.test.ts:642-651`: `checkMessage()` still
  resolves `true` with the breaker tripped; review correction PR #2981:
  plain `.endAsync` propagation would reject `checkMessage()` and abort
  SDK-message processing after the breaker state already changed) as ONE
  mixed business operation, instead of swapping only the
  classifiers for runners while leaving recording/transitions/trip
  imperative (that splits every breaker check at its central effects).
  Cooldown release is NOT a `checkMessage` stage (review correction PR
  #2981, matching the PR 15/16 scopes below): today only `isTripped()`
  performs it via `shouldReleaseCooldown` + `reset()`
  (`api-error-circuit-breaker.ts:132-136`), and folding release into the
  check would clear breaker state, recent errors, and per-agent rapid-fire
  timestamps at the WRONG time (e.g. on a check after expiry before
  `isTripped` is queried) and break the `isTripped` API contract — release
  stays a SEPARATE entry-point operation (its own small pipeline or the
  existing method).
- **step-by-step migration.** 1) Compose ONE complete breaker-check pipeline
  (`ApiErrorCircuitBreaker.checkMessage`): rapid-fire check (per-agent ring
  written here, `:56-62`, before the content exits) → message-text
  extraction and its empty-text exit (`:69-73`) → pattern
  classification → occurrence recording → `trip()` as its stages (cooldown
  release stays out of `checkMessage` entirely — see the wiring note above),
  with the text classifiers kept as plain helpers (review correction
  round 21/22: no standalone classifier pipelines with "no changes to
  `api-error-circuit-breaker.ts`" — that recreates the split);
  2) keep the two functions as helpers;
  3) wrapper keeps
  signatures); 3) optional: move the trip banner templates untouched — they
  are copy (user-visible strings, do not reword).
- **tests.** Existing breaker suite passes unchanged. Add: stderr-scoped
  precedence rows (`prompt_too_long` beats `invalid_request_error` when both
  match; api-status arm unreachable when a fatal pattern matched), and a
  halt row for the trip-message cascade.
- **risks/caveats.** Pattern precedence changes which errors trip the breaker
  and after how many occurrences — a reordered gate silently changes
  `patternCount` accumulation for mixed-error sessions. The
  top-of-function image-size test runs against the *whole* message content,
  while the nested one runs against stderr content only — keep both gates
  reading the right input (`messageContent` vs `ctx.stderrContent`).

### `fallback-recovery.ts:extractResetTimestamp`, `computeCooldown`

- **current summary.** `extractResetTimestamp`
  (`fallback-recovery.ts:138-175`): five-strategy first-match parse
  (ISO-with-TZ → local datetime → epoch-millis → epoch-seconds →
  relative-delay), each candidate validated by `isValidReset` (future,
  within `MAX_RESET_HORIZON_MS`). `computeCooldown` (`:188-221`): parsed
  reset → `parsed-reset` free-wait cooldown with `RESET_BUFFER_MS`; else
  backoff-ladder index clamped to the ladder and cap, jittered via injected
  `jitterFn`, floored at 60 s. Consumers:
  `limit-error-classifier.ts:126,197` (via `assessLimitError`,
  `isBillingTerminal`), `rate-limit-watchdog-gates.ts:40`
  (`decideRateLimitTrip`), `rate-limit-watchdog.ts:535,545` (deferred
  cooldown after fallback re-entry failure). Pinned by
  `tests/unit/1-core/agent/fallback-recovery.test.ts`.
- **proposed combinator.** Review correction: `computeCooldown` stays an
  ORDINARY PURE HELPER (reset parsing inline as helper logic or direct stages
  of `rate-limit-trip`'s cooldown-resolution stage) — no standalone
  `fallback-cooldown` runner, because the watchdog would otherwise invoke an
  inner pipeline on every no-reset-hint trip. `resolveFallbackChain` and
  `classifyLimitKind` stay leaves (see Scope).
- **input/output snapshot design.** Plain helper signatures (review
  correction round 21 — no decision contexts): `extractResetTimestamp(
  errorMessage, now?): ParsedReset | null` and `computeCooldown(
  errorMessage, count, now?, jitterFn?): CooldownDecision`.
- **pure core design.** Reset parsing is ordered strategy logic inside the
  helper: iso-with-tz → local datetime → epoch millis → epoch seconds →
  relative delay, first valid match wins (the current short-circuit).
  Cooldown rules consume that parse result directly: free-wait when a usable
  reset was parsed, otherwise the backoff ladder (`applyParsedResetGate`
  semantics become plain branches; ladder clamp + cap + jitter + floor in the
  final branch). `rate-limit-trip`'s cooldown-resolution stage calls these
  helpers directly — no inner reset/cooldown runner on the no-hint watchdog path. and final
  `applyBackoffLadderGate` (ladder clamp + cap + jitter + floor).
- **shell/effect wiring.** No shell changes: all consumers call the wrappers,
  which keep the exact signatures (`computeCooldown(errorMessage, count,
  now?, jitterFn?)`).
- **step-by-step migration.** 1) Keep `computeCooldown` as PLAIN HELPER LOGIC
  in `fallback-recovery.ts` (reset parsing inline; review correction round 20:
  no cooldown pipeline or wrapper — `rate-limit-trip`'s stage calls the
  helper directly); 2) everything else
  continues to compile unchanged (same exports); 3) land before the
  `limit-error-assess` apply, which consumes the helper.
- **tests.** Existing `fallback-recovery.test.ts` is the parity proof
  (strategy coverage, horizon rejection, ladder clamping, jitter bounds —
  pass `jitterFn` spies). Add rows: iso match beats a coexisting local
  datetime, asserted via the returned `ParsedReset.strategy` (no spy — the
  strategies are module-private with no injected seam; review correction
  PR #2981), relative-delay `delayMs > 0` guard.
- **risks/caveats.** Reset parsing drives real cooldown durations; strategy
  order and the horizon bounds must not drift (a wrongly-ordered gate can
  turn a 7-day-horizon rejection into an epoch-seconds false positive).
  `jitterFn` defaults to the SIGNED adapter `() => Math.random() * 2 - 1`
  (review correction: jitter spans `[-1, 1)` — passing raw `Math.random`
  would make every unparsed rate-limit cooldown land at or above the ladder
  base instead of varying on both sides, materially lengthening retry
  waits). Keep it a ctx field, never a gate global, so tests stay
  deterministic. The regexes use `g` flags with
  `matchAll` — leave them module-level exactly as-is (stateful `lastIndex`
  hazards if copied into closures carelessly).

### `rate-limit-watchdog-gates.ts:decideRateLimitTrip`

- **current summary.** `decideRateLimitTrip`
  (`rate-limit-watchdog-gates.ts:20-45`): billing-terminal hint →
  `surface-billing`; else pick `cooldownFromReset(hint.resetAtMs)` when the
  hint is usable, otherwise `computeCooldown` (pure helper); non-free-wait at/over
  `maxAutoRetries` → `give-up`; else `cooldown` with `charge`. Consumers:
  `rate-limit-watchdog.ts:211-253` (`scheduleRetry` — interprets by
  charging `retryCount`, scheduling cooldown, firing LLM refinement for
  ladder arms). Extracted as pure gates in #2779; pinned by
  `rate-limit-watchdog-gates.test.ts` + `rate-limit-watchdog.test.ts`.
- **proposed combinator.** Review correction round 22 + PR #2981: the trip classification is helper/direct-stage logic of the ONE complete rate-limit scheduling pipeline covering the FULL `scheduleRetry` flow (initialization — cancel the cooldown timer, record the error, record the
hint ONLY when supplied (`if (hint)`, `:146`; cleared on episode change
`:154-164`) — → no-user-message gate (logs and returns `false` before episode mutation, `rate-limit-watchdog.ts:148-151`) → `lastUserMessage` state write (`:152`, the value the cooldown timer's retry callback later reads at `:412`) → episode/generation entry and reset → current-model resolution + `triedKeys` recording (generation fence `:168-173`) → chain resolution (fence `:178-183`) → per-entry canonical model-ID resolution (`resolveModelId`) + availability checks → fallback selection with its immediate-fallback arm (fence before the immediate-fallback launch, `:206-211`; the launch stays FIRE-AND-FORGET — `void this.fireImmediateFallback(...)` at `:217` with its internal error containment, the operation returning `true` immediately while `fallbackPending` stays observable; review correction PR #2981: awaiting it would change caller timing and serialize the retry's recursive fallback/cooldown handling; the canonical-key selector lets `triedKeys` exclude the same physical model under an alias, `:187-203`) — the stages currently at `rate-limit-watchdog.ts:142-223` come FIRST, each prefix decision point keeping its guarded diagnostic log (the superseded-abort infos, the fallback-switch info, and the chain-exhausted info at `:169-171,179-181,207-214,220-222`; review correction PR #2981: without them asynchronous cancellation and fallback behavior become silent) — then trip classification (cooldown resolution reading a FRESH clock per `:230`, with `ctx.retryCount` already overwritten by the per-episode reset stage and `ctx.hint` re-read from the shared state per `:225-230` — `:154-159` precedes the `:228` read today; the `surface-billing` and `give-up` arms carry their guarded warning-log effects before returning `false`, `:230-244` — review correction PR #2981) → generation revalidation (`:246-251`) → retry charging → `scheduleCooldown` → LLM-refinement trigger gated on the armed result (the full `armed && reason === 'backoff-ladder' && classifyUnknownLimit && generation-current` guard, `:257-265`; review correction PR #2981: when a newer timer took ownership with the generation unchanged, `scheduleCooldown` returns `false` and refinement must NOT fire — a stale classification could later replace the newer cooldown); revalidation precedes charging exactly as today, or a superseded invocation could charge the new episode's retry budget), as the corrected wiring below prescribes.
- **input/output snapshot design.**
  ```ts
  interface RateLimitTripCtx {
    hint: LimitRetryHint | null;
    errorMessage: string;
    retryCount: number;
    maxAutoRetries: number;
    now: number;
    cooldown: CooldownDecision | null;   // transform stage output
    decision: RateLimitTripDecision | null;
  }
  ```
  Output stays `RateLimitTripDecision` (`surface-billing` | `give-up` |
  `cooldown` with `charge`).
- **pure core design.** Gates: 1) `applyBillingTerminalGate` (hint flag →
  `surface-billing`); 2) `applyCooldownResolutionStage` — transform: usable
  hinted reset (future, within horizon) → `cooldownFromReset`, else
  `computeCooldown(errorMessage, retryCount, now)`. Two freshness rules
  (review correction PR #2981): the stage reads a FRESH clock (an injected
  clock function evaluated there, or a `now`-refresh stage immediately
  before it) — today `Date.now()` is taken AFTER the async prefix
  (`rate-limit-watchdog.ts:230`), and an entry-time value can treat an
  already-expired hinted reset as usable or misalign relative-reset
  `retryAtMs` values with the armed timer; and the per-episode reset stage
  OVERWRITES `ctx.retryCount` before this stage reads it (the `:154-159`
  reset precedes the `:228` read today — an entry snapshot that survives
  the reset makes a brand-new episode start on a later ladder rung or hit
  `give-up`). A third freshness rule: `ctx.hint` is RE-READ from the
  shared watchdog state immediately before gate 1 (review correction PR
  #2981: today `decideRateLimitTrip` reads `this.lastHint` only AFTER the
  awaits, `rate-limit-watchdog.ts:225-230` — when two same-episode calls
  overlap and the later one supplies a structured/billing hint, the
  generation is unchanged and the earlier run must see the newer
  classification, not its entry-time copy); 3)
  `applyGiveUpGate` — `!cooldown.freeWait && retryCount >= maxAutoRetries`
  → `give-up`; 4) `applyCooldownFinalGate` — decides `cooldown` with
  `charge: !freeWait`.
- **shell/effect wiring.** Review correction round 22 + PR #2981: compose the
  COMPLETE scheduling operation once — the `scheduleRetry` prefix stages
  (initialization — cancel the cooldown timer, record the error, record the
  hint ONLY when one is supplied (`if (hint)`, `:146` — a same-episode call
  omitting a hint retains the prior structured reset; cleared only on
  episode change, `:154-164`) — and
  the no-user-message early gate that logs and returns `false` before any
  episode mutation (`rate-limit-watchdog.ts:148-151`), then the
  `lastUserMessage` state write (`:152` — the cooldown timer's retry
  callback reads it at `:412`, so omitting it makes a first cooldown retry
  with `null` or a later episode retry the previous episode's message);
  episode/generation
  entry and reset, current-model resolution +
  `triedKeys` recording, `resolveFallbackChain`, per-entry canonical
  model-ID resolution (`resolveModelId`) plus availability checks,
  `selectNextFallback` with its immediate-fallback arm (the launch stays
  FIRE-AND-FORGET — `void this.fireImmediateFallback(...)` at `:217`, the
  operation returning `true` immediately with `fallbackPending`
  observable; review correction PR #2981) and the
  canonical-key selector that lets `triedKeys` exclude the same physical
  model under an alias (`:187-203`) — with each of today's generation
  fences carried in position (`:168-173` after current-model resolution,
  `:178-183` after chain resolution, `:206-211` before the
  immediate-fallback launch; review correction PR #2981: without them a
  superseded invocation can add stale `triedKeys`, overwrite the new
  episode's chain, or launch a fallback after cancellation; each prefix
  decision point keeping its guarded diagnostic log, `:169-171,179-181,
  207-214,220-222`) —
  `rate-limit-watchdog.ts:142-223`) FIRST, then the trip-classification
  gates plus generation revalidation (`:246-251`), retry charging,
  `scheduleCooldown`,
  and LLM-refinement triggering as effect stages of the same pipeline —
  revalidation runs BEFORE charging, exactly as today, so a superseded
  invocation aborts without charging the new episode's retry budget, and
  refinement is gated on the armed result (the full
  `armed && reason === 'backoff-ladder' && classifyUnknownLimit &&
  generation-current` guard, `rate-limit-watchdog.ts:257-265`; review
  correction PR #2981: when a newer timer took ownership with the
  generation unchanged, `scheduleCooldown` returns `false` and firing
  refinement anyway could later replace that newer cooldown with a stale
  classification);
  leaving the prefix or those effects in the watchdog shell while only the
  classifier is a runner preserves a classifier/effect split (or a
  pipeline-plus-imperative-prefix) for every rate-limit trip — the PR 2/3
  scopes below compose exactly this full path.
- **step-by-step migration.** 1) Gates + effect stages + complete
  scheduling pipeline covering the FULL flow — initialization and
  no-user-message gate and the `lastUserMessage` write first, then the
  prefix (chain resolve with the generation fences `:168-173,178-183,206-211`
  → canonical
  resolution → availability → fallback select), then cooldown
  classification as
  helper/direct stage logic with generation revalidation BEFORE retry
  charging; 2) `scheduleRetry` invokes it with no
  imperative prefix remaining (PRs 2–3).
- **tests.** Existing suites pass unchanged. Add a halt row
  (billing-terminal hint skips cooldown resolution entirely — spy stage) and
  a row where a usable hint with `freeWait` never reaches `give-up` even at
  `retryCount === maxAutoRetries` (the current precedence: free waits are
  not counted).
- **risks/caveats.** The `usableHintedReset` window check
  (`> now && <= now + MAX_RESET_HORIZON_MS`) silently degrades to the ladder
  when a hint is stale — that is intentional and must survive as a *gate
  input* to `cooldownFromReset`, not as an exception. `refinedResetAtMs`
  stays a leaf (single normalization + window filter; consumed by
  `fireLlmRefinement` at `rate-limit-watchdog.ts:269`).

### `message-delivery.ts:classifyReclaimTermination`, `asMessageDeliveryPayload`

- **current summary.** `classifyReclaimTermination`
  (`message-delivery.ts:235-244`): three-value first-match
  (`terminalIdleInFlight` → `live`; `successResult` → `terminated`;
  `markerExists` → `redrive`; else `live`) — consumed by
  `agent-session.ts:2732-2744` (`reclaimTurnAlreadySucceeded` clears the
  marker on `redrive`). `asMessageDeliveryPayload` (`:246-265`):
  conjunctive validation + normalization of job payloads — string ids,
  role ∈ {turn, steer}, origin default `'chat'`, parentToolUseId
  string-or-null, batchUuids filtered to non-empty strings and omitted when
  empty. Consumers: `job-handlers/message-delivery.handler.ts:37` (throws on
  null payload) and `app.ts:852` (dead-letter settlement).
- **proposed combinator.** Review correction round 22: the termination
  gates are DIRECT stages of the ONE complete reclaim pipeline (snapshot →
  decision → guarded `clearDeliveryTurnEnd` on `redrive` → final result); the
  raw superpipe transform `message-delivery-payload` stays as-is.
- **input/output snapshot design.**
  ```ts
  interface ReclaimTerminationCtx {
    successResult: boolean;
    markerExists: boolean;
    terminalIdleInFlight: boolean;
    decision: ReclaimTerminationDecision | null;
  }
  interface DeliveryPayloadCtx {
    raw: Record<string, unknown>;
    ids: { sessionId: string; messageUuid: string; role: 'turn' | 'steer' } | null;
    batchUuids: string[] | undefined;
    decision: MessageDeliveryPayload | null;
  }
  ```
  For the transform, `decision` holds the assembled payload at the final
  stage; `null` means invalid (the `!dep`-free linear form: stage failure
  leaves `ids`/`decision` null and the wrapper returns null).
- **pure core design.** Reclaim gates: `applyTerminalIdleGate`,
  `applySuccessResultGate`, `applyMarkerGate`, final `applyLiveGate`.
  Payload stages: 1) `validateIdsStage` — typeof checks on sessionId/
  messageUuid/role, stamps `ids` or leaves null (early return is implicit —
  later stages guard on `ids !== null` via `?dep` or explicit checks; with a
  linear raw pipeline, each later stage starts with `if (!ctx.ids) return
  ctx;` which is the plain conjunctive shape); 2) `normalizeOriginStage`; 3)
  `normalizeParentToolUseIdStage`; 4) `normalizeBatchUuidsStage`; 5)
  `assemblePayloadStage`.
- **shell/effect wiring.** Review correction round 22: compose snapshot →
  decision → GUARDED `clearDeliveryTurnEnd` effect (on `redrive`) → final
  result as ONE complete reclaim pipeline — the current operation clears the
  delivery-turn-end marker immediately when the redrive result arrives, so a
  selection-only runner leaves that DB effect split out into the caller.
  Both payload call sites keep their null-handling
  (handler throws; app dead-letter path bails).
- **step-by-step migration.** 1) Add gates/pipelines in `message-delivery.ts`
  (or a small `delivery-payload-parse.ts` if the file's import weight
  matters — prefer in place, the file already owns these types); 2) wrappers
  keep both signatures; 3) no consumer edits.
- **tests.** No direct unit suite exists for either symbol today (covered
  indirectly via handler/session tests). Add
  `tests/unit/1-core/agent/message-delivery-payload.test.ts`: validation
  rows (missing ids, bad role, non-string batch members, empty batchUuids
  omitted, origin default). Reclaim rows are covered by the EXISTING
  direct suite at
  `tests/unit/4-space-storage/storage/sdk-message-repository.test.ts:3519-3621`
  (all eight combinations plus precedence) — extend or MOVE that table
  rather than duplicating it here (review correction
  PR #2981, matching the PR 18 scope); the precedence that must survive:
  terminalIdle beats
  successResult; success wins over the marker when both are true and
  `terminalIdleInFlight: false` → `terminated`.
- **risks/caveats.** `asMessageDeliveryPayload` runs on every delivery job
  claim — cheap, but keep the pipeline linear with no per-stage allocation
  beyond the payload itself. The `origin` field is cast, not validated
  (any string passes) — preserve the cast; tightening it is a behavior
  change for forward-compat payloads and out of scope.

### `query-runner.ts:parseApiValidationError`, `terminalUserMessageFor`

- **current summary.** Private methods on `QueryRunner`:
  `parseApiValidationError` (`query-runner.ts:1740-1789`) — excludes
  429-looking text (`looksLikeRateLimit429`), then three match arms
  (`4xx {json}` with parsed error body, plain `4xx text`, inner-JSON
  `error.message` matching `4xx text`), each rendering a markdown
  `**API Error (status)**` notice; null otherwise. Used at `:949` to build
  `QueryRetryErrorSignal.apiValidationText`.
  `terminalUserMessageFor` (`:1791-1832`) — maps `messageHint` →
  user-facing message (startup_timeout with workspace + timeout constants,
  conversation_not_found, message_not_found, provider_exhausted with retry
  count, transient_exhausted); undefined otherwise; used at `:1388` as the
  `errorManager.handleError` user message. Tests: **none direct** —
  `query-runner.test.ts:5398-5454` *duplicates the regex locally* instead of
  exercising the method; `:3460` pins one rendered notice end-to-end.
- **proposed combinator.** Extract to modules first (private methods cannot
  be pipelined or tested directly):
  `packages/daemon/src/lib/agent/api-validation-parse.ts` and
  `packages/daemon/src/lib/agent/terminal-user-message.ts`, then
  `decisionRun('api-validation-parse', …)` and
  `decisionRun('terminal-user-message', …)`.
- **input/output snapshot design.**
  ```ts
  interface ApiValidationParseCtx {
    rawError: unknown;                 // Error or stringified
    errorMessage: string | null;       // transform stage output
    decision: { text: string | null } | null;   // boxed: text null = definitively not applicable
  }
  interface TerminalMessageCtx {
    messageHint: string | undefined;
    maxProviderRetries: number;
    startupTimeoutMs: number;
    workspacePath: string | undefined;   // session.workspacePath ?? 'unbound'
    decision: { text: string | undefined } | null;
  }
  ```
  Boxing is required for `api-validation-parse`: the 429-exclusion arm must
  *halt* with the null answer so later arms cannot match; the wrapper
  returns `ctx.decision?.text ?? null`. For `terminal-user-message` the
  unknown hint is the final gate's answer (`{ text: undefined }`); wrapper
  returns `ctx.decision?.text`.
- **pure core design.** Api-validation gates:
  `applyErrorMessageStage` (transform: `error instanceof Error ?
  error.message : String(error)`), `applyRateLimitExclusionGate`
  (`looksLikeRateLimit429` → `{ text: null }`), `applyJsonBodyGate`
  (regex + JSON.parse + error-body render; review correction: when the
  structured `4xx {…}` regex MATCHES but `JSON.parse` fails, the gate
  DECIDES `{ text: null }` — boxing a definitive null so the row cannot
  fall through; the current function returns `null` immediately at that
  point, and falling through would let `applyPlainStatusGate` match the
  same text and reroute `400 {invalid json}` from the terminal-error path
  to `api_validation`), `applyPlainStatusGate`, `applyInnerJsonGate` (outer
  JSON.parse + inner `4xx text` match), no final decider — unmatched leaves
  decision null → wrapper null. Terminal-message gates:
  `applyStartupTimeoutGate`, `applyConversationNotFoundGate`,
  `applyMessageNotFoundGate`, `applyProviderExhaustedGate`,
  `applyTransientExhaustedGate`, final `applyNoHintGate` (`{ text:
  undefined }`). `STARTUP_TIMEOUT_MS` becomes the injected
  `startupTimeoutMs` ctx field (it is a module constant today; injection
  keeps the core pure and testable without env fiddling).
- **shell/effect wiring.** `QueryRunner` deletes both methods;
  `:949` calls `parseApiValidationError(error)`;
  `:1388` calls `terminalUserMessageFor({ messageHint:
  route.messageHint, maxProviderRetries, startupTimeoutMs:
  STARTUP_TIMEOUT_MS, workspacePath: session.workspacePath ??
  'unbound' })` — note the current method interns the `'unbound'` fallback
  inside each template; the extraction moves that default into the ctx
  snapshot so templates read one field. The ACP runner has no
  `parseApiValidationError` (verified) — no parity work needed there beyond
  the existing `assessLimitError` share.
- **step-by-step migration.** 1) Create both modules with pure functions +
  pipelines (zero QueryRunner imports — they must not import the runner);
  move `looksLikeRateLimit429` (`query-runner.ts:106-116`) and its tests
  (`query-runner.test.ts:6396-6430`) into `api-validation-parse.ts`,
  re-exporting from the runner if compatibility requires (review
  correction PR #2981: otherwise the exclusion gate needs a circular import
  or a duplicate nested-JSON 429 parser);
  2) add direct unit tests; 3) swap the two call sites; 4) delete the
  private methods; 5) replace the duplicated-regex test block in
  `query-runner.test.ts:5398-5454` with imports from the new module (those
  tests currently pin a *copy* of the pattern — a live footgun).
- **tests.** New `api-validation-parse.test.ts`: the three arms, 429
  exclusion (framed 429 that would otherwise match the plain arm), a
  malformed-JSON row asserting the DEFINITIVE-NULL halt (text matching the
  structured `4xx {…}` regex whose `JSON.parse` fails must return `null`
  immediately — never fall through to the plain arm), halt rows.
  New `terminal-user-message.test.ts`: every hint, unknown hint → undefined,
  interpolated constants (workspace, retries, timeout ms). Keep
  `query-runner.test.ts:3460`'s end-to-end notice row green.
- **risks/caveats.** The api-validation text is written into the session as
  an assistant error message (`displayErrorAsAssistantMessage`) — template
  drift is user-visible. The 429 exclusion interacts with the retry router:
  without it a 429 would render an api-validation notice instead of entering
  the rate-limit handoff; the halt row is mandatory. Do not read
  `process.env` inside the extracted functions (`STARTUP_TIMEOUT_MS` is
  resolved at module load in `query-runner.ts` — inject the value, keep the
  env read where it lives).

### `message-delivery-pipeline.ts:applyFlushFinalGate`

- **current summary.** Already composed:
  `decisionRun('message-turn-end-flush', [applyFlushEmptyGate,
  applyFlushOwnershipGate, applyFlushContextResetGate,
  applyFlushFinalGate])` (`message-delivery-pipeline.ts:181-191`). The final
  gate merges `flushPlan` + `contextReset` into the terminal
  `TurnEndFlushPlan` decision (`:162-179`), with `?? { action: 'noop' }` /
  `?? { action: 'flush_without_clear' }` fallbacks that are dead-defensive
  (the pipeline only reaches the final gate when the empty-gate did not
  decide, and both transform gates always populate their fields).
- **proposed combinator.** None — already `decisionRun`. Listed to close the
  scope inventory: this file is the *reference example*, not a migration
  target.
- **step-by-step migration.** No production change. Optional cleanup only if
  touched for other reasons: the `??` fallbacks may stay (cheap, and they
  keep the gate total); do not "simplify" them away in a drive-by.
- **tests.** `message-delivery-pipeline.test.ts` already covers the flush
  plans; nothing to add.
- **risks/caveats.** None. Any future change here should follow the existing
  gate style (`decided()` helper, delegating gates into
  `message-ownership-gates`/`context-reset-planner`).

### `ack-selection.ts:selectPersistedAckRow`, `selectYieldedAckRow`

- **current summary.** Pure priority selectors extracted in #2921 (pilot
  Chain C, C2c): `selectPersistedAckRow` (`ack-selection.ts:8-19`) maps
  `enqueued → deferred → submitted → consumed → none` to consume/already/
  none; `selectYieldedAckRow` (`:23-32`) maps `enqueued → submitted →
  deferred → none`. **No production call sites** — the equivalent cascades
  still live inline as `getMessageByStatusAndUuid` probe chains in
  `sdk-message-handler.ts:647-660` (yielded path: `enqueued ?? submitted`,
  then deferred fallback with a distinct consume+publish flow) and the
  persisted-ack region around `:396-427`/`:666-710` (status-flag-driven
  consumption). Pinned only by `tests/unit/1-core/agent/ack-selection.test.ts`.
- **proposed combinator.** Review correction round 22: the priority tables are
  plain helpers / direct selection stages of TWO COMPLETE acknowledgment
  pipelines (yielded and persisted) whose later stages perform consumption,
  ownership revalidation, and all publications — not two selection-only
  `decisionRun`s with an outer imperative cascade.
- **input/output snapshot design.**
  ```ts
  interface AckSelectCtx {
    enqueued: boolean;
    deferred: boolean;
    submitted: boolean;
    consumed: boolean;           // persisted variant only
    decision: PersistedAckSelection | YieldedAckSelection | null;
  }
  ```
  Boolean inputs, not status strings — the shell derives them from row
  probes/flags (`sendStatus === 'enqueued'` etc.), keeping the core free of
  DB vocabulary.
- **pure core design.** Persisted gates: `applyEnqueuedGate`,
  `applyDeferredGate`, `applySubmittedGate`, `applyConsumedGate`
  (`already_consumed`), final `applyNoneGate`. Yielded gates:
  `applyEnqueuedGate`, `applySubmittedGate`, `applyDeferredGate` (note the
  *different* precedence vs persisted: submitted before deferred), final
  `applyNoneGate`.
- **shell/effect wiring.** Review correction round 21: each acknowledgment
  business path (yielded AND persisted) composes as ONE complete pipeline —
  the priority tables act as plain helpers/direct selection stages, followed
  by the consumption, ownership-revalidation, and ALL publication effect
  stages (`markDeliveryConsumed*`, `messages.statusChanged`,
  `state.sdkMessages.delta`, `sdk.message`, tool-result-consumed,
  `signalDeliveryConsumed`) inside the same operation — not a selection-only
  runner with an outer imperative handler cascade. This is Chain C's C3b apply and is **gated on the
  pilot proposal's sequencing** (after the B5 series; coordination on open
  PRs touching `sdk-message-handler.ts`). When it lands:
  `handleMessageYielded` replaces its probe chain with row snapshots →
  `decideYieldedAckRow` → per-arm interpretation. EVERY consumed arm —
  enqueued, submitted, AND deferred (review correction) — consumes via the
  same GUARDED repository transition as the immediate arm (expected
  status/ownership verification, `superseded` outcome, timestamp on the
  verified path, `sdk-message-handler.ts:655-658,691-694`; review
  correction PR #2981) and publishes ALL
  FOUR events the current handler publishes around the status change
  (`messages.statusChanged` first at `:660-668,696-703`, then):
  `state.sdkMessages.delta`, `sdk.message`, and the tool-result-consumed
  event; restricting SDK-delta publication to the deferred arm makes
  normally yielded messages and tool results disappear from downstream
  SDK-message consumers. Failure semantics split by kind (review
  correction PR #2981): a transactional status/timestamp stage failure
  PROPAGATES to the queue boundary — `handleMessageYielded` becomes async
  and EVERY caller sequences the promise
  (`MessageQueue.messageGenerator` per `message-queue.ts:347-359`;
  `QueryRunner.createMessageGeneratorWrapper` per
  `query-runner.ts:1704-1715`, requeueing or aborting the already-yielded
  entry on failure since it moved to `yielded` pre-invocation
  (`:361-366`); `markMessageAccepted` before its consumed
  query per `sdk-message-handler.ts:551-559`; the registration adapter
  returning the promise per `:140-142` and the ACP `onAccepted` contract
  per `acp-query-adapter.ts:29`/`acp-client.ts:272,286`, with the producer
  at `acp-query-runner.ts:739-742` setting `accepted` only after
  settlement and a shared IN-FLIGHT acceptance promise serializing the
  synchronously dispatched notifications (`acp-client.ts:479-483`,
  `:283-287`; review correction PR #2981), and `messageGenerator`
  rechecking claim ownership before `claimed.delete`/`yielded.add`
  (`:361-362`), via a claim RESERVATION/FINALIZATION protocol or a CAS
  compensation guarded to this exact transition — the queue claim and the
  DB transaction cannot be coupled atomically, and a blind restore could
  overwrite a concurrent defer/delete/status change (review correction PR
  #2981))) — while each
  individual
  PUBLICATION promise keeps its today-style `.catch` containment AND
  fire-and-forget scheduling (await only the transactional
  status/timestamp work; a slow subscriber must never block the yield —
  review correction PR #2981) so a
  publication failure never becomes an unhandled rejection. EVERY
  successful or already-consumed acknowledgment arm —
  yielded and immediate alike — also sets the
  `acknowledgedPersistedUserThisTurn` state flag as an effect stage
  (`sdk-message-handler.ts:422,445,666,704`; review correction PR #2981):
  the later successful result reads it at `:1163` to decide whether the
  turn-end batch acknowledgment runs, so dropping the write would consume
  an additional queued user message that was not acknowledged during the
  turn. Parity tests cover enqueued, submitted, and deferred rows. The
  TWO persisted-path regions are DISTINCT operations (review correction PR
  #2981): the immediate single-message acknowledgment
  `acknowledgePersistedUserMessage` (`:396-427`) routes through
  `decidePersistedAckRow`, with per-row ownership revalidation immediately
  before every acknowledgement (snapshot-then-await-consume — C3b's Phase 0
  guarded transition), consuming via a GUARDED repository transition — an
  atomic primitive verifying the row's expected status and ownership,
  returning a `superseded` outcome when they changed, applying the
  status-plus-`updateMessageTimestamp` write only on the verified path —
  NOT the blind by-DB-ID `updateMessageStatus` batch
  (`sdk-message-handler.ts:435-438`; review correction PR #2981: the
  current write is blind to concurrent status/ownership changes — under a
  snapshot-then-await-consume design it can consume a replacement-owned
  row and publish a false acknowledgment; the timestamp write must still
  land for all three statuses per the send-status tests);
  the turn-end batch acknowledgment (`:464-523`) is
  NOT a status-priority cascade — it scans only `enqueued` users, applies
  the durable/yielded/pending ownership filters, expands batch UUIDs,
  computes strictly increasing `consumedAt` values and persists them via
  `updateMessageTimestamp` — the CALCULATION runs early, but the DB update
  applies only after `markDeliveriesConsumedAtTurnEnd` succeeds and
  supplies `consumedId` (`:490-500`; review correction PR #2981: marking
  first and updating the returned row avoids mutating the timestamp of a
  message the repository declined to consume when the terminal result is
  ineligible or the kickoff lost ownership) — before publishing the
  replays timed with those
  values (`:478-521`; review correction PR #2981: omitting the monotonic
  timestamp computation and DB update leaves persisted rows at their old
  enqueue times while publishing newly timed replays, so later
  timestamp-ordered snapshots misplace those user messages), and
  consumes them at turn end — as an acknowledgment ORCHESTRATION owning the
  row loop per ADR 0004 P6 (review correction PR #2981: the pipeline is the
  per-row reducer, never the loop — the orchestration scans and iterates
  the eligible rows, threads `lastConsumedAt`, and continues past
  unsuccessful marks): each row invokes the per-row acknowledgment
  pipeline and acknowledges yielded queue entries via
  `messageQueue.acknowledgeYielded(messageId)` — which removes the entry
  from `MessageQueue.yielded` and resolves its enqueue promise
  (`message-queue.ts:226-231`) — signaling consumption ONLY for the
  returned-consumed UUIDs when it succeeds (`:495-499`; review correction
  PR #2981: without that guarded stage a yielded entry stays tracked and
  its producer promise unresolved after the DB row is consumed) — never
  through the persisted selector (routing it
  through `decidePersistedAckRow` would make deferred/submitted/consumed
  rows eligible where they are currently ignored and would conflate the
  batch operation with the single-message acknowledgment). Effects — the
  FULL publication set each region performs
  (`markDeliveryConsumed*`, `messages.statusChanged`,
  `state.sdkMessages.delta`, `sdk.message` on the immediate path, and
  tool-result-consumed publications, plus `signalDeliveryConsumed` in the
  turn-end loop — review correction PR #2981: no publication is dropped)
  — are stages of the same complete pipelines (review correction round 23
  — they do not stay in the handler).
- **step-by-step migration.** Review correction round 23: no selection-only
  intermediate — the priority tables stay plain helpers until each complete
  acknowledgment pipeline can land. 1) At the C3b window, add each complete
  pipeline (yielded first, then the persisted immediate path, then the
  turn-end batch pipeline) — selection stages PLUS the
  consumption, ownership-revalidation, and publication effect stages in the
  same composition — and wire `handleMessageYielded`, the immediate
  persisted path, and the turn-end batch loop to their pipelines in the
  same change; 2) the selector functions stay exported plain
  helpers consumed by the selection stages (tests keep using them directly);
  3) apply per Chain C sequencing.
- **tests.** Existing `ack-selection.test.ts` rows keep passing through the
  wrappers. Add precedence-halt rows and — at apply time — characterization
  rows from the C1b pin table (sendStatus × ownership × yielded/claimed ×
  pending × active-equality, per the proposal).
- **risks/caveats.** Knip: the unwired exports are currently
  test-only; ensure the `check` knip guard stays satisfied (the existing
  exports already coexist with it — the new wrappers are consumed by tests
  immediately, so no `@public` escape hatch should be needed). The two
  selectors' *different* precedence orders are intentional (persisted rows
  may already be deferred; yielded rows may not) — the pipeline names must
  not be "unified" into one configurable cascade.

## Suggested migration order

Ordered by dependency direction, existing-pin density, and blast radius.
Every step is independently shippable; each keeps the exported function
signatures stable so consumers do not churn.

1. **`fallback-recovery.ts` helper characterization** (pins only —
   `extractResetTimestamp`/`computeCooldown` stay plain helpers; no
   `fallback-reset-parse` or `fallback-cooldown` pipeline is ever created,
   per the PR 1 correction) — foundation for steps 3 and 4; strongest
   existing pin suite; zero callers change.
2. **`rate-limit-watchdog-gates.ts`** (`rate-limit-trip`) — consumes 1's
   `computeCooldown`/`cooldownFromReset`; #2779 already isolated the core.
3. **`limit-error-classifier.ts`** (`limit-error-assess` raw transform) —
   consumes 1's `extractResetTimestamp`; highest classification risk, so it
   lands with its pin suite green and the stage-precedence rows added.
4. **`turn-outcome-classification.ts`** (`delivery-turn-completion` +
   `reconcile-stranded-deliveries`) — self-contained; the reconcile-admission
   apply touches `agent-session.ts` + `message-delivery.ts`, coordinate with
   in-flight Chain A/B work on those files.
5. **`repeated-tool-error-gates.ts`** (`repeated-tool-error-observation`) —
   isolated core, existing tests.
6. **`loop-detector-gates.ts` + new `loop-detector-pipeline.ts`**
   (`tool-call-loop-admission`) — the only new module and the only shell
   (hook) rewiring among the gate sites; hook tests are the parity proof.
7. **`circuit-breaker-transitions.ts`** (`breaker-check`; the pattern/trip
   templates stay plain helpers — no standalone
   `circuit-breaker-error-pattern`/`circuit-breaker-trip-message` runners,
   per the PR 15 correction) — self-contained; message templates frozen.
8. **`message-delivery.ts`** (`message-reclaim`,
   `message-delivery-payload`) — small, but adds the first direct payload
   tests; coordinate with Chain A applies on the same file.
9. **`query-runner.ts` extractions** (`api-validation-parse`,
   `terminal-user-message`) — the only true *extractions* (private →
   module); includes deleting the duplicated-regex tests.
10. **`ack-selection.ts` pipelines** (`ack-yielded`, `ack-persisted` — the
    complete acknowledgment operations, replacing the selection-only
    `ack-persisted-select`/`ack-yielded-select` labels per the PR 26
    correction) — pipeline composition can land any time; the
    sdk-message-handler apply is Chain C's C3b and follows its gating.

Finish with the ADR pilot-log note in `docs/adr/history/0004-pilots.md` and,
per repo convention, zero comments in all touched sources.

## Focused PR breakdown

Every slice below is one PR under the two-tier review budget: production Δ
≲100 lines (hard cap ~150 only for types-dominated additive cores), test Δ
≲350 lines counted separately from production, pins split by dimension family
rather than by truncation, docs-only slices Δ ≲150. Each slice carries a
phase label — 📌 pins (production Δ = 0; characterization/decision-table tests
of current behavior), ➕ additive core (pure module/pipeline landed unwired),
🔧 apply (wires call sites, one arm/route/site per slice), or cleanup; tiny
slices may combine 📌+🔧. Ordering follows the "Suggested migration order"
phases above: pins before extraction, primitives before consumers, same-file
applies sequenced for surgical diffs, no unrelated fixes folded in; slices
marked "parallel-safe leaf" have no cross-dependency and can land in any
order. An additive core may land unwired only as a temporary state — its
apply slice wires the COMPLETE business operation, and production is never
left wired to an admission-only or classifier-only pipeline whose effects
stay imperative (the review corrections forbid that end state). Every slice
lands with the repo compiling, tests green, and zero comments in touched
sources. Coverage is exhaustive: the only per-site section without a slice is
`message-delivery-pipeline.ts:applyFlushFinalGate`, already a `decisionRun`
(reference example, no production change).

**Phase 1 — `fallback-recovery.ts` helpers**

### PR 1 — `test(agent): pin fallback reset/cooldown helper strategy order`

📌 pins — prod Δ = 0, test Δ ≲100

- **scope.** `tests/unit/1-core/agent/fallback-recovery.test.ts` only,
  dimension family "strategy order and guards" against the CURRENT
  `extractResetTimestamp`/`computeCooldown` in
  `packages/daemon/src/lib/agent/fallback-recovery.ts`: the
  iso-beats-local-datetime precedence row (review correction PR #2981: ONE
  input containing BOTH a valid ISO-with-TZ timestamp and a valid local
  datetime, asserting `ParsedReset.strategy === 'iso8601'` — the strategy
  regexes/parse functions are module-private lexical calls with no
  collaborator to spy on at prod Δ = 0, and the returned `strategy` field is
  the observable) and the
  relative-delay `delayMs > 0` guard row. No production change — the helpers
  stay plain exported functions (review corrections rounds 17/20/21 forbid
  any `fallback-reset-parse`/`fallback-cooldown` runner or wrapper), and
  `resolveFallbackChain`/`classifyLimitKind` remain untouched leaves.
- **lands.** The helper contracts PRs 2 and 4 consume are pinned.
- **excludes.** The rate-limit scheduling and limit-error-assess pipelines
  that consume the helpers (PRs 2–5).
- **tests.** This slice is the test addition; the existing suite stays the
  parity proof (strategy coverage, horizon rejection, ladder clamping,
  jitter bounds).
- **depends on.** none — parallel-safe leaf.

**Phase 2 — `rate-limit-watchdog-gates.ts`**

### PR 2 — `refactor(agent): add rate-limit-trip scheduling pipeline core`

➕ additive core — prod Δ ≲150 (types-dominated complete-operation core), test Δ ≲350

- **scope.** `packages/daemon/src/lib/agent/rate-limit-watchdog-gates.ts`: the
  complete `rate-limit-trip` scheduling pipeline, landed unwired — review
  correction (PR #2981): the FULL `scheduleRetry` operation composes, not
  just its trip tail: the initialization stages (cancel cooldown timer,
  record the error, record the hint ONLY when one is supplied — `if (hint)`
  at `:146`, retaining the prior structured reset for same-episode calls
  that omit a hint; cleared only on episode change at `:154-164`) and the
  no-user-message early gate that logs and
  returns `false` (`rate-limit-watchdog.ts:148-151`), then the
  `lastUserMessage` state write (`:152`), then the leading
  per-episode reset (`:154-164`), current canonical-model resolution and
  `triedKeys` recording (`:166-175`, generation fence `:168-173`),
  chain-resolution (`resolveFallbackChain`, fence `:178-183`),
  per-entry canonical
  model-ID resolution, availability, and fallback-selection stages
  currently at
  `rate-limit-watchdog.ts:142-223` come FIRST, then
  `applyBillingTerminalGate`, `applyCooldownResolutionStage` (calls
  `cooldownFromReset`/`computeCooldown` directly), `applyGiveUpGate`,
  `applyCooldownFinalGate`, plus effect stages for generation revalidation
  (`:246-251`), retry charging,
  `scheduleCooldown`, and LLM-refinement triggering expressed
  over ctx-injected collaborators — revalidation BEFORE charging, exactly
  as today; `refinedResetAtMs` stays a leaf. An
  imperative prefix left in `scheduleRetry` would split the rate-limit
  recovery business path, contrary to the one-direct-pipeline rule.
- **lands.** The complete scheduling operation exists as one pipeline, pinned
  by tests, before any wiring.
- **excludes.** The `scheduleRetry` rewiring (PR 3) and any pipelining of
  `refinedResetAtMs`. The chain-resolve → availability → fallback-select
  prefix is IN scope (review correction PR #2981; open question 3 resolves
  to: include it).
- **tests.** Existing `rate-limit-watchdog-gates.test.ts` rows keep passing;
  add the billing-terminal halt row (cooldown resolution never runs) and the
  usable-free-wait-hint row that never reaches `give-up` at
  `retryCount === maxAutoRetries`.
- **depends on.** PR 1.

### PR 3 — `refactor(agent): wire scheduleRetry to the rate-limit-trip pipeline`

🔧 apply — prod Δ ≲80, test Δ ≲150

- **scope.** `packages/daemon/src/lib/agent/rate-limit-watchdog.ts:142-267`
  (the FULL `scheduleRetry`, review correction PR #2981): injects the
  watchdog's collaborators and invokes the complete pipeline —
  initialization, the no-user-message gate, and the `lastUserMessage`
  write, chain
  resolution (each of today's generation fences carried in position —
  `rate-limit-watchdog.ts:168-173,178-183,206-211` — and each prefix
  decision point keeping its guarded diagnostic log, `:169-171,179-181,
  207-214,220-222`; review correction PR #2981), canonical
  resolution, availability, fallback selection (the immediate-fallback
  launch staying FIRE-AND-FORGET per `:217`),
  classification (the `surface-billing` and `give-up` arms keeping their
  guarded warning-log effects before returning `false`, `:230-244`),
  generation revalidation, retry
  charging, `scheduleCooldown`, and LLM-refinement
  triggering (gated on the armed result per `:257-265`) all run as stages
  of the same operation; no imperative
  interpretation cascade or prefix remains in the shell.
- **lands.** Every rate-limit trip runs the COMPLETE scheduling operation as
  one pipeline — never a classifier-only runner with imperative effects.
- **excludes.** `fireCooldownRetry`/B5d fencing-gap work (pilot proposal
  territory).
- **tests.** `rate-limit-watchdog.test.ts` passes unchanged (parity); extend
  only if a collaborator-injection seam needs a row.
- **depends on.** PR 2.

**Phase 3 — `limit-error-classifier.ts`**

### PR 4 — `refactor(agent): add limit-error-assess transform core`

➕ additive core — prod Δ ≲100, test Δ ≲350

- **scope.** `packages/daemon/src/lib/agent/limit-error-classifier.ts`: the
  raw `limit-error-assess` superpipe transform landed alongside the current
  imperative body — `parseStructuredResetStage`, `parseTextResetStage` (plain
  `extractResetTimestamp` helper call, no nested run), the
  `structuredReset ?? parsed?.resetAtMs ?? null` merge feeding
  `resolveBillingStage` (exact `sdkErrorTag === 'billing_error'` equality
  only, gated on `resetAtMs === null`), `detectLimitMarkersStage`
  (`PROMPT_TOO_LONG_RE` carve-out preserved), `emitAssessmentStage`;
  `resolveLimitKind`/`isBillingTerminal`/`normalizeEpochMs`/`cooldownFromReset`
  exports untouched.
- **lands.** The transform and its wrapper exist, pinned by tests, with
  `assessLimitError` still running the imperative body.
- **excludes.** The body flip (PR 5), the leaf regex helpers
  (`looksLikeLimitText` etc.), and the handler-seam signal assembly (open
  question 2 stays snapshot).
- **tests.** Existing `limit-error-classifier.test.ts` is the parity table;
  add `source`-precedence rows (`rate_limit_event` > `sdk-error-tag` >
  `http-status` > `parsed:*` > `billing` > `text`) and the
  structured-reset-suppresses-text-parse row against the transform.
- **depends on.** PR 1.

### PR 5 — `refactor(agent): route assessLimitError through limit-error-assess`

🔧 apply — prod Δ ≲30, test Δ ≲50

- **scope.** `limit-error-classifier.ts`: the `assessLimitError(signal,
  now?)` body becomes the transform run; the three call sites
  (`query-runner.ts:932`, `acp/acp-query-runner.ts:1009`,
  `sdk-message-handler.ts:1220`) change nothing — signature preserved, `now`
  stays injected.
- **lands.** The central limit detector is pipeline-backed in production.
- **excludes.** Any call-site edits (none needed).
- **tests.** Classifier suite green byte-identical.
- **depends on.** PR 4.

**Phase 4 — `turn-outcome-classification.ts`**

### PR 6 — `refactor(agent): add delivery-turn completion pipeline core`

➕ additive core — prod Δ ≲150 (types-dominated complete-operation core), test Δ ≲350

- **scope.** `packages/daemon/src/lib/agent/turn-outcome-classification.ts`:
  ctx + gates (`applyProducedResultGate`, `applyRecoveryPendingGate` with its
  parking effects, failure-arm `applyTurnErrorConsumeStage` and
  `applyClaimGuardStage`, transform `applyTurnDetailGate`
  with the preference-chain detail, `applyTerminalTurnErrorGate`,
  `applyTerminalSubtypeGate`, `applyRecoverableFinalGate` with the verbatim
  `?? true` reopen default) plus the recovery effect stages of the complete
  delivery-turn completion operation — the guarded `clearDeliveryTurnEnd`
  marker clear as the leading effect of EVERY non-`completed` arm
  (`agent-session.ts:2369,2377`; review correction PR #2981: PR 7 calls it
  out for `recovery_pending`, and the terminal/recoverable throws need it
  just as much — a stale marker after a thrown failure makes later reclaim
  classification select `redrive`), terminal throw, eligibility-guarded
  (`!kickoffAcknowledged && !kickoffAckInvalidated && !alreadyConsumed`)
  zero-progress escalation, optional `reopenDeliveryForRetry`, recoverable
  throw, `completed` clearing `zeroProgressDeliveryFailures`,
  `recovery_pending` parking — over ctx-injected
  collaborators, landed unwired; `classifyTurnCompletion` keeps its current
  body.
- **lands.** The complete completion operation exists as one pipeline before
  wiring; no standalone `agent-turn-completion` classifier runner is ever
  added.
- **excludes.** The `agent-session.ts` wiring (PR 7), the reconcile work
  (PRs 8–10), and `message-delivery-pipeline.ts` re-export churn (none
  needed — it re-exports the symbol, not the implementation).
- **tests.** Existing `turn-outcome-classification.test.ts` parity rows run
  against the pipeline; add the two contract rows: a spy gate proves the
  cascade halted after `producedResult` (detail gate never invoked), and
  `completed` rows never build a detail string.
- **depends on.** none — parallel-safe leaf.

### PR 7 — `refactor(agent): wire agent-session turn completion to its pipeline`

🔧 apply — prod Δ ≲100, test Δ ≲150

- **scope.** Review correction (PR #2981): the invocation moves OUTSIDE the
  `if (!producedResult)` conditional (`agent-session.ts:2363-2401`) — today
  `classifyTurnCompletion` only runs in the no-result branch while the
  successful-turn `zeroProgressDeliveryFailures` clearing happens
  imperatively at `:2402`; wiring only the no-result branch would leave the
  success arm imperative and the `applyProducedResultGate` + `completed`
  clearing stages unreachable in production. ALL FOUR outcomes traverse the
  complete pipeline with its effect stages (review correction PR #2981):
  `completed`, `recovery_pending` (the `agent-session.ts:2364-2374` parking
  branch becomes the pipeline's `applyRecoveryPendingGate` + its marker
  clear/parking-log effects — leaving it an imperative branch in front of
  the invocation would keep the "complete operation" split), 
  `terminal_error`, and `recoverable_error`. The shell snapshots only the
  cheap non-destructive inputs; `consumeTerminalTurnError`, the
  `errorResultSubtype` query, and `claimGuard`
  are invoked by the pipeline's failure-arm stages (behind the
  produced-result and recovery-pending gates), so routing successful or
  parked turns through the pipeline performs none of them — no
  `lastTerminalError` clear (`agent-session.ts:2545-2549`), no claim-guard
  invocation, no irrelevant subtype query.
  `classifyTurnCompletion` becomes
  a one-line delegate (deleted only once no test imports remain).
- **lands.** Classification and its recovery effects run as one complete
  operation in production, on successful AND failed turns.
- **excludes.** The reconcile paths in the same file (PR 10).
- **tests.** `turn-outcome-classification.test.ts` green; delegate rows keep
  passing.
- **depends on.** PR 6.

### PR 8 — `refactor(agent): add reconcile-stranded-deliveries pipeline core`

➕ additive core — prod Δ ≲150, test Δ ≲350

- **scope.** `turn-outcome-classification.ts`: admission gates
  (`applyDeliveryV2Gate`, `applyJobQueueGate`, `applyBusyStatusGate`,
  `applyRunGate`) as direct stages of the complete
  `reconcile-stranded-deliveries` operation — admission, coordinated lock,
  `selectStrandedDeliveries` filtering against active/in-flight UUIDs at
  the ORCHESTRATION level, then a per-row reducer pipeline for the
  enqueue + session-state update fold (ADR 0004 P6: the row loop is
  orchestration, the pipeline is the per-row reducer; review correction
  PR #2981) — with the shared V2-flag predicate and
  a `processingStatus: null` pass-through for the status-less entry;
  `decideReconcileAdmission` stays exported as the narrow delegate. Review
  correction (PR #2981): submitted-message SETTLEMENT exists only on the
  `AgentSession.reconcileStrandedDeliveries` path
  (`agent-session.ts:2884-2905`); the standalone
  `message-delivery.ts:205-230` path only re-enqueues stranded `enqueued`
  rows and its DB interface cannot query or fail `submitted` rows — so there
  are TWO complete pipelines sharing the admission/select stages: the
  session variant WITH its settlement stage and the standalone variant
  WITHOUT it (wiring settlement into the standalone path would introduce new
  message-failure behavior, not preserve parity).
- **lands.** Both complete reconciliation operations exist, unwired, each
  shaped like its real invocation path.
- **excludes.** Both call-site rewirings (PRs 9–10) and the busy-set
  `ReadonlySet` promotion (open question 4).
- **tests.** Existing delegate rows keep passing; add `v2_disabled`/
  `no_job_queue` admission rows, the `busy`-skips-even-with-V2-and-jobQueue
  row, and the `null` `processingStatus` never-skips row.
- **depends on.** PR 7 (same file, sequenced).

### PR 9 — `refactor(agent): wire the standalone reconcile path to its pipeline`

🔧 apply — prod Δ ≲100, test Δ ≲100

- **scope.** `message-delivery.ts:205-215`
  (`reconcileStrandedDeliveries`): runs its complete pipeline (the
  standalone variant — NO settlement stage) with its own snapshot
  (`processingStatus: null` — busy-status stage passes); the
  lock/select/enqueue/update work becomes pipeline stages, not an
  imperative cascade behind an admission-only runner; the session-state
  update stage carries today's per-row catch containment
  (`message-delivery.ts:221-225` — one rejected row never aborts the
  remaining re-enqueues).
- **lands.** The standalone entry point (also invoked from the idle callback)
  runs the complete operation with parity behavior (re-enqueue only).
- **lands.** The standalone entry point (also invoked from the idle callback)
  runs the complete operation.
- **excludes.** `agent-session.ts:2852-2859` (PR 10) and Chain B's fencing on
  the idle-callback continuation (coordinate, do not fold in).
- **tests.** The PR 8 admission rows via this snapshot shape plus the
  handler/session suites that cover this path indirectly.
- **depends on.** PR 8; coordinate with in-flight Chain A/B work on
  `message-delivery.ts`.

### PR 10 — `refactor(agent): wire the agent-session reconcile path to its pipeline`

🔧 apply — prod Δ ≲60, test Δ ≲100

- **scope.** `agent-session.ts:2852-2859`: the inline V2 + jobQueue + status
  preamble is replaced by the complete operation (this path supplies
  `processingStatus`, so its busy-status admission stage runs); its
  selection/enqueue orchestration keeps the `withSessionResetCoordination`
  envelope around the coordinated lock (`:2867-2883`, review correction PR
  #2981), the row folds invoke per-row reducer pipelines (ADR 0004 P6),
  and the settlement fold keeps its own lock-only orchestration; the
  variant ends with the guarded summary-log stage (`:2906-2909`) after
  both counts are known.
- **lands.** The duplicated three-check preamble is gone from both
  consumers.
- **excludes.** Everything else in `agent-session.ts`.
- **tests.** Reconcile admission rows via the pipeline; existing session
  suites green.
- **depends on.** PRs 7 and 8 (same files, sequenced).

**Phase 5 — `repeated-tool-error-gates.ts`**

### PR 11 — `refactor(agent): add repeated-tool-error-observation pipeline core`

➕ additive core — prod Δ ≲120, test Δ ≲250

- **scope.** `packages/daemon/src/lib/agent/repeated-tool-error-gates.ts`:
  the ROW-ONLY reducer core (review correction PR #2981: the scope gate
  and the whole-message `classifyToolResultContent` call stay in the
  ONCE-PER-MESSAGE orchestration that PR 12 lands — embedding them in this
  core would re-run classification for every error row and repeat
  reset/ignore handling) — the gates (`applyInterventionCooldownGate`,
  transform `applyStreakCountGate`, `applyThresholdGate`,
  `applyCountFinalGate`) plus the effect stages the guardrail performs
  imperatively today — the keyed `lastInterventionByKey` timestamp write
  (`:127-132`, review correction PR #2981), state mutation, `reset()`,
  Forge evidence emission on
  `intervene`, recovery-message routing (each effect carrying today's
  stage-local
  try/catch containment, `repeated-tool-error-guardrail.ts:134-152`, so an
  evidence failure never aborts routing and a routing failure never rejects
  the observer) — as the per-row REDUCER pipeline the observation
  orchestration invokes (review correction PR #2981, per ADR 0004 P6
  "pipeline as reducer body, never the loop": the error-row loop,
  state threading, and `triggered` OR-aggregation over the deduplicated
  `classification.errors` live in the `observeToolResultErrors`
  orchestration, not as pipeline stages), landed unwired
  over ctx-injected
  STATE COLLABORATORS (review correction PR #2981: a pipeline operating on a
  state SNAPSHOT can never update the guardrail's real `lastError`, count,
  or intervention map, and passing the live object as a plain snapshot field
  contradicts the snapshot boundary) — the core receives explicit
  write-state / reset / evidence-emission PORTS as deps, so the same stages
  mutate the real guardrail state once PR 12 injects it — and each
  invocation receives the state the PREVIOUS row's invocation wrote (the
  orchestration threads it; review correction PR #2981: today each row
  reads the state written by the preceding row,
  `repeated-tool-error-guardrail.ts:93-112`;
  a frozen initial snapshot falsely intervenes on alternating-streak
  sequences); the guardrail file
  is untouched in this slice.
- **lands.** The complete observation operation exists as one pipeline before
  wiring.
- **excludes.** The guardrail rewiring (PR 12) and the surrounding guardrail
  lifecycle (registration/disposal).
- **tests.** Existing gates suite unchanged; add the threshold-halt row
  (final gate not reached) and the `lastInterventionAt === undefined`
  never-trips-cooldown row.
- **depends on.** none — parallel-safe leaf.

### PR 12 — `refactor(agent): wire guardrail observation to its pipeline`

🔧 apply — prod Δ ≲80, test Δ ≲100

- **scope.**
  `packages/daemon/src/lib/agent/repeated-tool-error-guardrail.ts:74-120`
  (`observeToolResultErrors`): the method becomes the observation
  ORCHESTRATION — the scope
  precondition (`:74-76`), content
  classification with its `reset`/`ignore` arms (`:78-89`), then the
  error-row loop invoking the per-row reducer pipeline with the threaded
  state and `triggered` aggregation (`:91-119`; review correction PR
  #2981, per ADR 0004 P6: the loop stays in the orchestration — the
  pipeline is the per-row reducer);
  the shell-level per-block invocation is gone, classification runs once
  per message, and the observation injects a CLOCK FUNCTION the
  orchestration evaluates per
  error row and passes to the intervention-timestamp write (review
  correction PR #2981: scoping the reducer to error rows only would drop
  the success-block reset arm, and a frozen entry-time clock falsely takes
  `cooldown_reset` on later rows).
- **lands.** State/reset/evidence/recovery effects run inside the same
  pipeline as the three classification arms in production.
- **excludes.** Any change to the exported decision type.
- **tests.** `repeated-tool-error-guardrail.test.ts` passes unchanged.
- **depends on.** PR 11.

**Phase 6 — `loop-detector-gates.ts` + new `loop-detector-pipeline.ts`**

### PR 13 — `refactor(agent): add tool-call-loop-admission pipeline core`

➕ additive core — prod Δ ≲150 (new module + ctx types), test Δ ≲350

- **scope.** New `packages/daemon/src/lib/agent/loop-detector-pipeline.ts`:
  a DIRECT superpipe pipeline `tool-call-loop-admission` (review correction
  PR #2981: NOT `decisionRun` — it appends `!hasDecided` after every gate
  (`decision-pipeline.ts:14-16`), so the first gate to stamp a decision
  would halt execution before the state-effect stages; the first-match
  semantics come from IN-STAGE skip guards (`if (ctx.decision !== null)
  return ctx;` at the top of each later decision gate), NOT from `!decided`
  halts — ADR 0004 `!dep` terminates the run, so a halt between gates would
  still keep the effect tail from running; with in-stage guards every gate
  passes through and the guarded effects
  below always run after classification, keyed on the stamped decision) —
  `applyPreToolUseEventGate`,
  `applyDisabledGate` (no-op `allow` passthrough, NO ledger effects),
  `applyUnmonitoredGate` (allow + explicit `resetLedger` — ONLY this arm
  deletes the ledger; review correction PR #2981), `applyArgKeyStage`,
  `applyStreakAdvanceStage`, bash-guarded
  `applyBashRingStage`, delegating `applyBashDeadLoopGate` and
  `applyIdenticalArgsGate` (both stay exported), `applyAllowFinalGate`, plus
  the GUARDED STATE-EFFECT stages — ledger delete on `resetLedger`,
  `set(scope, streak)` on BOTH allow and deny, expired-ring delete,
  `sweepLedger`, deny logging, and the deny `permissionDecision` hook output
  — operating over the ledger/ring Maps passed in as deps (shell-owned
  resources, pipeline-committed mutations; review correction PR #2981). The
  hook is untouched.
- **lands.** The PreToolUse admission business path exists as one pipeline;
  the ledger/ring Maps remain the only state, in the hook closure per ADR
  decision 5.
- **excludes.** The hook rewiring (PR 14), `buildArgKey`/`stableStringify`/
  `sweepLedger` staying leaf FUNCTIONS (their invocations are pipeline
  stages, per the state-effect list above), and the PostToolUse(Failure)
  `recordBashRingOutcome` callbacks (already pure folds).
- **tests.** `loop-detector-gates.test.ts` unchanged; new pipeline rows —
  non-PreToolUse payload returns `{}` with no state mutation, disabled row
  is a no-op passthrough while the no-threshold row resets the ledger,
  expired ring reports `ringExpired`, deny reason
  embeds `summariseArgs` output.
- **depends on.** none — parallel-safe leaf.

### PR 14 — `refactor(agent): wire the PreToolUse hook to loop admission`

🔧 apply — prod Δ ≲100, test Δ ≲150

- **scope.** `packages/daemon/src/lib/agent/loop-detector-hook.ts:118-200`
  (`buildPreToolUseCallback`) shrinks to snapshot → run ONLY (review
  correction PR #2981, matching the corrected site design; the snapshot
  carries the raw event name so the pipeline's event gate — not the shell —
  filters non-PreToolUse payloads before any state transform): the ledger
  delete/write, expired-ring cleanup, `sweepLedger`, deny logging, and deny
  hook-output construction are the PIPELINE's guarded state-effect stages
  (from PR 13), not callback-side interpretation — leaving them in the
  callback recreates the decision/effect split this migration removes.
- **lands.** The hook callback is snapshot-and-run only; the complete
  admission operation — classification AND its state commits — runs as one
  pipeline in production.
- **excludes.** PostToolUse(Failure) callbacks (pure state folds, stay
  direct).
- **tests.** `loop-detector-hook.test.ts` is the rewiring parity proof
  (verify deny logging still fires — as a pipeline stage, asserted through
  the wired hook, not by keeping it in the shell).
- **depends on.** PR 13.

**Phase 7 — `circuit-breaker-transitions.ts`**

### PR 15 — `refactor(agent): add complete circuit-breaker check pipeline core`

➕ additive core — prod Δ ≲120, test Δ ≲250

- **scope.** `packages/daemon/src/lib/agent/api-error-circuit-breaker.ts`:
  the complete breaker-check pipeline, landed unwired — message-type gate
  (`msg.type !== 'user'`, `api-error-circuit-breaker.ts:49-51`, first —
  review correction PR #2981) → rapid-fire check (per-agent ring written
  here, `:56-62`, before the content exits; review correction PR #2981) →
  message-text extraction with its empty-text false-return gate
  (`:69-73`, flattened-string input; review correction PR #2981) →
  pattern classification → occurrence recording (`recentErrors`,
  `messageTimestampsByAgent`, `state`) → `trip()` (async `onTrip` with
  today's catch-and-log containment — an injected-callback rejection never
  rejects `checkMessage()`, `:109-115`, pinned by
  `api-error-circuit-breaker.test.ts:642-651`; review correction PR
  #2981) as mixed
  stages over ctx-injected collaborators. Review correction (PR #2981):
  cooldown release is NOT part of `checkMessage` — today only `isTripped()`
  performs it via `shouldReleaseCooldown` + `reset()`
  (`api-error-circuit-breaker.ts:132-136`), and folding release into the
  check pipeline would clear breaker state, recent errors, and rapid-fire
  timestamps at the WRONG time (e.g. on a check after expiry before
  `isTripped` is queried) and break the `isTripped` API contract. Release
  stays a SEPARATE entry-point operation (its own small pipeline or the
  existing method);
  `circuit-breaker-transitions.ts` `extractErrorPattern` (stderr-scoped
  patterns-then-api-status nesting; whole-message vs stderr-scoped image-size
  inputs) and `buildTripMessage` stay plain helpers its stages call;
  `getTripMessage` (`:140`) untouched.
- **lands.** The complete check operation exists as one pipeline; no
  standalone `circuit-breaker-error-pattern`/`circuit-breaker-trip-message`
  runners are ever added.
- **excludes.** The `checkMessage` wiring (PR 16) and any banner template
  rewording (frozen user-visible copy).
- **tests.** `api-error-circuit-breaker.test.ts` unchanged; add stderr-scoped
  precedence rows (`prompt_too_long` beats `invalid_request_error`; api-status
  arm unreachable after a fatal pattern) and a trip-message cascade halt row.
- **depends on.** none — parallel-safe leaf.

### PR 16 — `refactor(agent): wire checkMessage to the breaker-check pipeline`

🔧 apply — prod Δ ≲60, test Δ ≲50

- **scope.** `api-error-circuit-breaker.ts:43-102` (`checkMessage`) runs the
  complete pipeline; recording and trip effects are its stages, not
  imperative shell code. Cooldown release stays in `isTripped()` (review
  correction PR #2981) — it is a separate entry-point operation, never a
  `checkMessage` stage.
- **lands.** Every breaker check composes classification with its effects in
  production.
- **excludes.** `getTripMessage` — rendering stays exactly as-is.
- **tests.** Breaker suite green unchanged.
- **depends on.** PR 15.

**Phase 8 — `message-delivery.ts`**

### PR 17 — `test(agent): characterize delivery payload validation`

📌 pins — prod Δ = 0, test Δ ≲150

- **scope.** New `tests/unit/1-core/agent/message-delivery-payload.test.ts`,
  dimension family "payload validation" against the CURRENT
  `asMessageDeliveryPayload` (`message-delivery.ts:246-265`): missing ids,
  bad role, non-string batch members, empty batchUuids omitted, origin
  default/cast. No production change; no direct suite exists today (only
  indirect handler/session coverage).
- **lands.** The payload contract the PR 19 transform must preserve is
  pinned.
- **excludes.** Reclaim rows (PR 18) and any production change.
- **tests.** This slice is the pin table.
- **depends on.** none — parallel-safe leaf.

### PR 18 — `test(agent): characterize reclaim termination precedence`

📌 pins — prod Δ = 0, test Δ ≲100

- **scope.** Extends `message-delivery-payload.test.ts`, dimension family
  "reclaim termination" against the CURRENT   `classifyReclaimTermination`
  (`message-delivery.ts:235-244`): review correction (PR #2981): a direct
  `classifyReclaimTermination` suite ALREADY EXISTS at
  `tests/unit/4-space-storage/storage/sdk-message-repository.test.ts:3519-3621`
  covering all eight boolean combinations and the success-over-marker
  precedence case — REUSE or MOVE that table rather than duplicating it
  (two copies would have to be updated together on every contract change);
  this slice keeps the new file focused on the genuinely uncovered payload
  validation rows. The precedence that must survive the move: terminalIdle
  beats successResult, and success wins over the marker
  (`successResult && markerExists`, `terminalIdleInFlight: false` →
  `terminated`; the marker arm fires only when `successResult: false` —
  expecting `redrive` there would teach the replacement to clear the
  marker and rerun a completed delivery).
- **lands.** The reclaim contract the PR 19 gates must preserve is pinned.
- **excludes.** Payload validation rows (PR 17).
- **tests.** This slice is the pin table.
- **depends on.** none — parallel-safe leaf.

### PR 19 — `refactor(agent): add reclaim and delivery-payload pipeline cores`

➕ additive core — prod Δ ≲150 (two cores + ctx types), test Δ ≲200

- **scope.** `message-delivery.ts`: reclaim gates (`applyTerminalIdleGate`,
  `applySuccessResultGate`, `applyMarkerGate`, `applyLiveGate`) as direct
  stages of the complete reclaim pipeline — snapshot → decision → guarded
  `clearDeliveryTurnEnd` on `redrive` → final result, the marker-clear as an
  effect stage over ctx-injected marker ops — plus the raw
  `message-delivery-payload` transform (`validateIdsStage`,
  `normalizeOriginStage`, `normalizeParentToolUseIdStage`,
  `normalizeBatchUuidsStage`, `assemblePayloadStage`, linear `!dep`-free
  form); both wrappers keep signatures and bodies until PRs 20–21.
- **lands.** Both cores exist unwired, pinned by the PR 17–18 tables
  re-run against them.
- **excludes.** Tightening the `origin` cast (forward-compat behavior
  change), consumer edits at `message-delivery.handler.ts:37`/`app.ts:852`
  (none needed), and Chain A's delivery-routing cores (sibling plan).
- **tests.** The PR 17–18 pin tables pass against the cores.
- **depends on.** PRs 17 and 18 (pins before extraction).

### PR 20 — `refactor(agent): wire reclaim marker-clear into its pipeline`

🔧 apply — prod Δ ≲80, test Δ ≲100

- **scope.** `agent-session.ts:2732-2744`
  (`reclaimTurnAlreadySucceeded`): runs the complete reclaim pipeline; the
  guarded `clearDeliveryTurnEnd` on `redrive` is a pipeline effect, not
  caller code. The pipeline stays SYNCHRONOUS (`.end`, not `.endAsync` —
  review correction PR #2981): `clearDeliveryTurnEnd` is a synchronous DB
  write today, and both callers consume the result synchronously in boolean
  conditions (`agent-session.ts:2034,2073` — an async pipeline's promise
  would be truthy for every `alreadyConsumed` delivery, misclassifying
  live/redrive turns as `turn_terminated`).
- **lands.** The redrive marker-clear DB effect runs inside the reclaim
  operation in production.
- **excludes.** The payload flip (PR 21).
- **tests.** Reclaim pin rows via the pipeline; session suites green.
- **depends on.** PR 19; sequence after PR 10 (both edit `agent-session.ts`)
  and coordinate with Chain A applies on the same file.

### PR 21 — `refactor(agent): route asMessageDeliveryPayload through its transform`

🔧 apply — prod Δ ≲30, test Δ ≲50

- **scope.** `message-delivery.ts`: the `asMessageDeliveryPayload` body
  becomes the transform run; consumers at
  `job-handlers/message-delivery.handler.ts:37` (throws on null) and
  `app.ts:852` (dead-letter bail) keep their null-handling unchanged.
- **lands.** Delivery-job payloads validate through the linear transform in
  production.
- **excludes.** Everything else.
- **tests.** Payload pin table green.
- **depends on.** PR 19; sequence after PR 9 (both edit
  `message-delivery.ts`).

**Phase 9 — `query-runner.ts` extractions**

### PR 22 — `refactor(agent): add api-validation-parse module and pipeline`

➕ additive core — prod Δ ≲120, test Δ ≲300

- **scope.** New `packages/daemon/src/lib/agent/api-validation-parse.ts`
  (zero QueryRunner imports): `decisionRun('api-validation-parse')` —
  `applyErrorMessageStage`, `applyRateLimitExclusionGate` (boxed
  `{ text: null }` halt), `applyJsonBodyGate` (regex match with failing
  `JSON.parse` decides the definitive null — never falls through to the plain
  arm), `applyPlainStatusGate`, `applyInnerJsonGate`, no final decider;
  wrapper returns `ctx.decision?.text ?? null`. The module also RECEIVES the
  `looksLikeRateLimit429` helper moved from `query-runner.ts:106-116` with
  its tests (`query-runner.test.ts:6396-6430`), re-exporting from
  `query-runner.ts` if compatibility requires (review correction PR #2981:
  leaving the helper in the runner forces a circular import or a duplicated
  nested-JSON 429 parser under the zero-QueryRunner-import constraint, and
  the retry exclusion must not drift from API-validation parsing).
- **lands.** The extracted classifier exists unwired with direct parity
  tests.
- **excludes.** The QueryRunner swap and duplicated-regex test replacement
  (PR 23); ACP runner (verified no parity work needed).
- **tests.** New `api-validation-parse.test.ts`: the three match arms,
  framed 429 that would otherwise match the plain arm, the malformed-JSON
  definitive-null halt row, halt rows.
- **depends on.** none — parallel-safe leaf.

### PR 23 — `refactor(agent): wire QueryRunner to api-validation-parse`

🔧 apply — prod Δ ≲60, test Δ ≲150

- **scope.** `query-runner.ts`: deletes the private `parseApiValidationError`
  (`:1740-1789`) and calls the module at `:949`;
  `query-runner.test.ts:5398-5454` replaces the duplicated-regex block with
  imports from the new module.
- **lands.** The duplicated-regex test footgun is gone; production uses the
  pipeline.
- **excludes.** `terminalUserMessageFor` (PRs 24–25).
- **tests.** `query-runner.test.ts:3460`'s end-to-end notice row stays green.
- **depends on.** PR 22.

### PR 24 — `refactor(agent): add terminal-user-message module and pipeline`

➕ additive core — prod Δ ≲100, test Δ ≲250

- **scope.** New `packages/daemon/src/lib/agent/terminal-user-message.ts`
  (zero QueryRunner imports): `decisionRun('terminal-user-message')` —
  `applyStartupTimeoutGate`, `applyConversationNotFoundGate`,
  `applyMessageNotFoundGate`, `applyProviderExhaustedGate`,
  `applyTransientExhaustedGate`, final `applyNoHintGate`
  (`{ text: undefined }`); `STARTUP_TIMEOUT_MS` becomes the injected
  `startupTimeoutMs` ctx field (no `process.env` read inside the module).
- **lands.** The extracted mapper exists unwired with direct tests.
- **excludes.** The QueryRunner swap (PR 25).
- **tests.** New `terminal-user-message.test.ts`: every hint, unknown hint →
  `undefined`, interpolated workspace/retries/timeout constants.
- **depends on.** none — parallel-safe leaf.

### PR 25 — `refactor(agent): wire QueryRunner to terminal-user-message`

🔧 apply — prod Δ ≲60, test Δ ≲50

- **scope.** `query-runner.ts`: deletes `terminalUserMessageFor`
  (`:1791-1832`); `:1388` builds the ctx snapshot with the single
  `'unbound'` workspace default and injects `STARTUP_TIMEOUT_MS` (the env
  read stays where it lives in `query-runner.ts`).
- **lands.** Both private-method extractions are complete.
- **excludes.** PR 23's work (land it first — same file).
- **tests.** Terminal-message suite plus `query-runner.test.ts` green.
- **depends on.** PR 24; sequence after PR 23.

**Phase 10 — `ack-selection.ts` pipelines**

### PR 26 — `refactor(agent): add ack yielded/persisted pipeline cores`

➕ additive core — prod Δ ≲200 (three complete-operation cores), test Δ ≲350

- **scope.** `packages/daemon/src/lib/agent/ack-selection.ts`: the priority
  tables become the direct selection stages of the COMPLETE acknowledgment
  pipelines (corrected round 21/22 from the migration order's selection-only
  `ack-persisted-select`/`ack-yielded-select` step) — persisted
  (`applyEnqueuedGate`, `applyDeferredGate`, `applySubmittedGate`,
  `applyConsumedGate`, final `applyNoneGate`) and yielded
  (`applyEnqueuedGate`, `applySubmittedGate`, `applyDeferredGate`, final
  `applyNoneGate` — submitted before deferred, intentionally different) —
  with consumption, ownership-revalidation, and ALL publication stages
  composed into the same operations over ctx-injected collaborators, plus
  `decidePersistedAckRow`/`decideYieldedAckRow` wrappers; ALSO the
  turn-end batch core `ack-turn-end-batch` (review correction PR #2981,
  shaped per ADR 0004 P6): the acknowledgment ORCHESTRATION scans
  `enqueued` users, applies the durable/yielded/pending ownership filters,
  expands batch UUIDs, threads `lastConsumedAt` for the monotonic
  `consumedAt` values, and invokes the PER-ROW reducer pipeline —
  consumption via `markDeliveriesConsumedAtTurnEnd`, the DB
  `updateMessageTimestamp` applied after the successful mark supplies
  `consumedId` (`:490-500`), the guarded `messageQueue.acknowledgeYielded`
  stage, and the row's publications — continuing past unsuccessful marks;
  the loop is never a pipeline stage, and the whole thing is never routed
  through the persisted
  selector; `selectPersistedAckRow`/`selectYieldedAckRow` stay exported;
  lands unwired-but-green (tests consume the wrappers immediately; knip
  satisfied without `@public`).
- **lands.** Both complete pipelines exist and are pinned before the Chain C
  window.
- **excludes.** The `sdk-message-handler.ts` applies (PRs 27–28) and any
  unification of the two precedence orders (forbidden).
- **tests.** `tests/unit/1-core/agent/ack-selection.test.ts` rows keep
  passing through the wrappers; add precedence-halt rows for both cascades.
- **depends on.** none — parallel-safe leaf.

### PR 27 — `refactor(agent): wire the yielded ack path to its pipeline (C3b)`

🔧 apply — prod Δ ≲100, test Δ ≲350

- **scope.**
  `packages/daemon/src/lib/agent/sdk-message-handler.ts:647-660`
  (`handleMessageYielded`): probe chain replaced by row snapshots →
  `decideYieldedAckRow` → per-arm interpretation where EVERY consumed arm —
  enqueued, submitted, AND deferred — consumes via a GUARDED repository
  transition carrying the supplied `consumedAt` (an atomic primitive
  verifying expected status and ownership, returning `superseded` when
  they changed, applying the status-plus-`updateMessageTimestamp(dbId,
  consumedAt)` write only on the verified path,
  `sdk-message-handler.ts:655-658,691-694`; review correction PR #2981:
  stage boundaries can allow a defer, failure, or ownership change AFTER
  row selection, and the blind by-ID batch would overwrite the newer
  status, mark an ineligible prompt consumed, and publish a false
  acknowledgment — matching PR 28's immediate-arm requirement; the
  send-status timestamp assertion holds on the verified path) and
  publishes FOUR events — `messages.statusChanged` FIRST in every consumed
  arm (`:660-668,696-703`; review correction PR #2981: omitting it leaves
  consumers displaying the row as enqueued/submitted after the DB marked it
  consumed), then
  (`state.sdkMessages.delta`, `sdk.message`, tool-result-consumed);
  consumption, ownership revalidation, and publications run as stages of the
  same operation, not an outer imperative handler cascade. Failure
  semantics split by kind (review
  correction PR #2981): a transactional status/timestamp stage failure MUST
  PROPAGATE to the queue boundary — `handleMessageYielded` becomes async
  and EVERY caller sequences the promise:
  `MessageQueue.messageGenerator` awaits before yielding
  (`message-queue.ts:347-359`: today a synchronous throw there removes the
  claim and rejects the enqueue; an async pipeline swallowed behind the
  void callback would let the queue move the message into `yielded` despite
  the failed acknowledgment and leave a rejected promise unhandled).
  After the await, `MessageQueue.messageGenerator` RECHECKS that the
  message is still claimed before its unconditional
  `claimed.delete`/`yielded.add` (`message-queue.ts:361-362`; review
  correction PR #2981: a `clear()`/`remove()` during the pending
  acknowledgment would otherwise resurrect an interrupted prompt into
  `yielded` and feed it to the SDK after its enqueue promise already
  settled). Because the transactional stage has ALREADY marked the row
  `consumed` by then, and the queue claim lives only in `MessageQueue`
  while the repository transaction covers only the database (review
  correction PR #2981: an ownership check INSIDE the atomic transition
  cannot couple the two states — a `clear()`/`remove()` between that check
  and the generator's post-await recheck still loses the claim with the
  row left consumed), the plan requires a CLAIM RESERVATION/FINALIZATION
  protocol — the queue marks the claim as being-finalized so concurrent
  `clear()`/`remove()` during the window is refused or deferred and the
  generator's recheck consults the same reservation — or an EXPLICITLY
  GUARDED COMPENSATION: a CAS restore tied to this exact transition
  (status AND epoch must still match what THIS acknowledgment wrote; a
  blind restore could overwrite a concurrent defer/delete/status change),
  since reconciliation scans only `enqueued` rows and a stranded
  consumed-but-never-sent prompt is unrecoverable — and the
  suppressed-callback wrapper
  performs the equivalent yielded-ownership check after ITS await;
  `QueryRunner.createMessageGeneratorWrapper` — which suppresses the queue
  callback and invokes `onMessageYielded` itself
  (`query-runner.ts:1704-1715`) — awaits or handles the rejection, and
  because the entry has ALREADY moved to `yielded` before this wrapper's
  invocation (`message-queue.ts:361-366`), it REQUEUES
  (`requeueYielded`) or explicitly aborts/rejects the yielded entry before
  propagating an acknowledgment failure (review correction PR #2981:
  leaving it in `yielded` strands the prompt with an unsettled enqueue
  promise until the queue timeout — which resolves rather than reports for
  durable entries — while the DB row stays retryable);
  `markMessageAccepted` awaits before its consumed-row query for the ACP
  acceptance path (`sdk-message-handler.ts:551-559`, where the current
  synchronous `try/catch` no longer contains an async rejection); and the
  ADAPTER contracts are threaded too — the registration wrapper must
  return the promise instead of discarding it
  (`sdk-message-handler.ts:140-142`), the ACP `onAccepted` void
  contract (`acp-query-adapter.ts:29`, `acp-client.ts:272`) is updated or
  its invocation at `acp-client.ts:286` sequenced, AND the callback
  PRODUCER at `acp-query-runner.ts:739-742` returns/awaits the
  `markMessageAccepted` promise through the chain, setting
  `accepted = true` only after the acknowledgment settles (review
  correction PR #2981: otherwise TypeScript is free to discard the
  promise and a transactional rejection stays unhandled while ACP
  processing continues as accepted). Because `AcpClient` dispatches
  subscribers SYNCHRONOUSLY (`handleNotification`, `acp-client.ts:479-483`)
  while the `accept()` guard holds only a boolean with no in-flight state
  (`:283-287`), making the chain async requires a shared IN-FLIGHT
  acceptance promise that back-to-back `session/update` notifications
  reuse, that the response path awaits before completing, and that RESETS
  after a rejection so a later notification can retry (review correction
  PR #2981) — while
  the individual PUBLICATION promises keep
  today's per-publication `.catch` containment AND today's
  FIRE-AND-FORGET scheduling (review correction PR #2981: the handler
  launches `messages.statusChanged`, `sdk.message`, and
  tool-result-consumed with `.catch(...)` but never awaits them,
  `sdk-message-handler.ts:659-687,696-710` — with the queue now awaiting
  the pipeline, awaiting the publications would let a slow or non-settling
  event subscriber block the SDK message from ever being yielded; await
  ONLY the transactional status/timestamp work, launch publications as
  `void …catch(…)`), so a publication failure
  never becomes an unhandled rejection or escapes the handler. Every
  consumed arm also sets
  the `acknowledgedPersistedUserThisTurn` flag (`:666,704`) as an effect
  stage (review correction PR #2981) — the turn-end batch acknowledgment
  gates on that flag at `:1163`, so dropping the write would consume an
  additional queued user message later in the turn.
- **lands.** The yielded acknowledgment business path is one complete
  pipeline in production.
- **excludes.** The persisted regions (PR 28).
- **tests.** Parity rows for enqueued/submitted/deferred publications plus
  characterization rows from the C1b pin table (sendStatus × ownership ×
  yielded/claimed × pending × active-equality).
- **depends on.** PR 26 and the pilot proposal's Chain C sequencing (after
  the B5 series; coordinate on open PRs touching `sdk-message-handler.ts`).

### PR 28 — `refactor(agent): wire the persisted ack path to its pipeline (C3b)`

🔧 apply — prod Δ ≲100, test Δ ≲300

- **scope.** `sdk-message-handler.ts:396-427` and the turn-end persisted-ack
  loop `:464-523` only (review correction PR #2981: `:666-710` is inside
  `handleMessageYielded` — that region belongs to PR 27 in full; reworking it
  here would rework the yielded handler twice and leave the actual
  turn-end persisted loop unmigrated). The TWO regions wire to DISTINCT
  compositions (review correction PR #2981): the immediate single-message
  acknowledgment (`acknowledgePersistedUserMessage`, `:396-427`) routes
  through `decidePersistedAckRow` with per-row ownership revalidation
  immediately before every acknowledgement (snapshot-then-await-consume,
  C3b's Phase 0 guarded transition), consuming via a GUARDED repository
  transition — an atomic primitive verifying expected status and
  ownership, returning `superseded` when they changed, applying the
  status-plus-`updateMessageTimestamp` write only on the verified path
  (NOT the blind by-DB-ID batch at `:435-438`; review correction PR
  #2981 — a blind write can consume a replacement-owned row under the
  awaited boundary), publishing `messages.statusChanged`,
  `state.sdkMessages.delta`, `sdk.message`, and tool-result-consumed after
  consumption (`:440-461`) — an effect list of only
  `markDeliveryConsumed*`/`messages.statusChanged`/`signalDeliveryConsumed`
  would drop the replay and tool-result publications from the immediate
  path; the turn-end loop (`:464-523`) becomes the `ack-turn-end-batch`
  ORCHESTRATION (loop outside the pipeline per ADR 0004 P6, review
  correction PR #2981: enqueued-only scan, durable/yielded/pending
  ownership filters, batch-UUID expansion, `lastConsumedAt` threading)
  invoking the per-row reducer pipeline —
  monotonic `consumedAt` computation (DB
  `updateMessageTimestamp` applied after the successful mark supplies
  `consumedId`, `:490-500`),
  `markDeliveriesConsumedAtTurnEnd`,
  the guarded `messageQueue.acknowledgeYielded` stage
  (`:495-499`, `message-queue.ts:226-231` — consumption is signaled only
  for the returned-consumed UUIDs when it succeeds; review correction PR
  #2981),
  `signalDeliveryConsumed`, `messages.statusChanged`,
  `state.sdkMessages.delta`, and tool-result-consumed, the replays timed
  with the computed values per `:508-511`) — NEVER the persisted
  selector, which would make deferred/submitted/consumed rows eligible
  where they are currently ignored. The immediate path's consumed AND
  already-consumed arms set the `acknowledgedPersistedUserThisTurn` flag
  (`:422,445`) as effect stages (review correction PR #2981) — the
  turn-end batch itself only READS that flag at `:1163` to decide whether
  to run, so a missing write would consume an additional queued user
  message that was not acknowledged during the turn. ALL publications each
  region performs
  today run as stages of its pipeline.
- **lands.** Both acknowledgment paths run as complete pipelines; the Chain C
  C3b apply is complete.
- **excludes.** Chain B/B5-series changes to the same file.
- **tests.** Persisted-arm parity rows plus C1b characterization rows.
- **depends on.** PR 27 (same file, sequenced) and Chain C sequencing.

### PR 29 — `docs(adr): record agent gates & recovery pilots in the pilot log`

cleanup — docs Δ ≲150

- **scope.** `docs/adr/history/0004-pilots.md`: the closing pilot-log note
  covering this plan's pipelines; docs only.
- **lands.** The migration is recorded per the "Suggested migration order"
  closing instruction; `bun run check` (including `check:no-comments`) stays
  green.
- **excludes.** Any source change — those belong to PRs 1–28.
- **tests.** None beyond the repo guards.
- **depends on.** PRs 1–28.

## Open questions

1. **Boxed-null convention adoption.** This plan boxes null-ish terminal
   answers (`{ text: null }`) only where a gate must *halt* with the
   negative answer (api-validation 429 exclusion, terminal-message unknown
   hint). Should that convention be written into ADR 0004's taxonomy table
   (a P3/P1 refinement), or stay a codebase idiom documented per pipeline?
2. **`assessLimitError` caller enrichment.** `sdk-message-handler.ts:1220`
   assembles the signal (`lastSdkErrorTag`, `lastRateLimitInfo`,
   `terminal_reason`) inline before calling the classifier. Should that
   assembly become part of a wider `result-limit-assess` mixed pipeline at
   the handler seam, or stay shell snapshotting? This plan assumes snapshot
   (classifier stays module-pure); revisit when Chain C rewires the handler.
3. **Watchdog composition horizon.** RESOLVED (review correction PR #2981):
   the FULL `RateLimitWatchdog.scheduleRetry`
   (`rate-limit-watchdog.ts:142-267`) composes in THIS plan as the complete
   `rate-limit-trip` scheduling pipeline (PRs 2–3) — chain resolve →
   availability → fallback select → trip → cooldown, as an async
   direct-superpipe (`.endAsync`) with generation-guard revalidation, not a
   `decisionRun`; no separate migration plan and no tail-only variant
   remains anywhere in this document. Still open for a follow-up: B5d's
   fencing gaps the pilot proposal flagged (post-await `retryCount` write,
   `fireCooldownRetry` finalizer) — those stay excluded from PR 3.
4. **`decideReconcileAdmission` busy-set scope.** The skip set is
   `processing | queued | waiting_for_input` as a closed list. The pipeline
   input keeps it a string; if `ProcessingStateManager` ever grows a status,
   the gate silently admits during it. Promote to a `ReadonlySet` constant
   in the gates module during migration, or leave the string comparisons
   as-is for minimal diff?
5. **`parseApiValidationError` module home.** New sibling module vs folding
   into `limit-error-classifier.ts` (both are error-text classifiers). This
   plan proposes separate modules to keep the limit classifier free of
   api-validation template concerns; confirm at review.
6. **Loop-admission ledger reset semantics.** The ENABLED no-threshold
   branch *deletes* the scope's ledger entry
   (`loop-detector-hook.ts:130-132`); the disabled arm is a no-op
   passthrough (review correction PR #2981). The pipeline models the
   no-threshold deletion as `resetLedger: true` on that arm's allow
   decision;
   confirm that flag-on-decision shape is preferred over keeping the delete
   in the shell keyed on the same predicate.
