# Agent gates & recovery migration plan

## Scope and combinator fit

This plan covers the hand-rolled gate/parse/recovery functions in
`packages/daemon/src/lib/agent/` that decide how a session classifies errors,
arms cooldowns, trips breakers, denies loops, and reclaims deliveries. The
governing record is `docs/adr/0004-superpipe-pipelines.md` (rev. 2026-08-25):
one direct superpipe pipeline per business path, stages freely mixing decision,
transform, and effect work, `!dep` halts for early exits, no pre-classification
into combinator categories, and no new combinators.

Every site in scope is **pure and synchronous**: no I/O, no awaits, no DB
writes, no resource ownership. `stagedRun`
(`packages/daemon/src/lib/space/runtime/staged-run.ts`) is therefore not
appropriate anywhere here — it exists for async snapshot → decide → effect →
resnapshot flows with CAS outcomes and compensation
(`verified-stop-flow.ts`, `spawn-flow.ts`). The two tools used are:

- **`decisionRun`** (`packages/daemon/src/lib/space/runtime/decision-pipeline.ts`)
  — first-match-wins gate cascade over a typed `ctx.decision`; gates are named
  exported functions; the run halts at the first gate that stamps a non-null
  decision. Used for: mutually exclusive outcome cascades (retry arms, breaker
  arms, ack priority rows) and for nullable first-match parse cascades where
  each strategy gate stamps a boxed/non-null decision on success and the
  wrapper falls back to `null`/`undefined` when no gate fired.
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
| `turn-outcome-classification.ts:classifyTurnCompletion` | Gates/helpers of the complete delivery-turn completion operation incl. recovery effects (review correction round 22) |
| `turn-outcome-classification.ts:decideReconcileAdmission` | Admission stages of the complete `reconcile-stranded-deliveries` pipelines (review correction round 22) | `reconcile-stranded-deliveries` |
| `limit-error-classifier.ts:assessLimitError` | raw superpipe transform | `limit-error-assess` |
| `limit-error-classifier.ts:resolveLimitKind`, `isBillingTerminal` | none (leaves) | — |
| `repeated-tool-error-gates.ts:decideConsecutiveError` | Classification stages of the complete error-observation pipeline incl. state/reset/evidence/recovery effects (review correction round 22) | `repeated-tool-error-observation` |
| `loop-detector-gates.ts:decideIdenticalArgsLoop`, `decideBashDeadLoop` | `decisionRun` composing both (new `loop-detector-pipeline.ts`) | `tool-call-loop-admission` |
| `circuit-breaker-transitions.ts:extractErrorPattern` | Ordinary pure helper consumed by the complete circuit-breaker check operation (review correction round 21: no standalone runner) |
| `circuit-breaker-transitions.ts:buildTripMessage` | Plain helper consumed by the complete breaker-check pipeline (review correction round 22) | — |
| `fallback-recovery.ts:extractResetTimestamp` | Ordinary pure helper over inline parse logic (review correction: no separate parse or cooldown pipelines — `computeCooldown` is consumed as a pure helper by `rate-limit-trip`) |
| `fallback-recovery.ts:computeCooldown` | Ordinary pure helper for `rate-limit-trip`'s cooldown-resolution stage (review correction round 17: `fallback-cooldown` as a separate runner makes every no-hint trip execute a nested pipeline) |
| `fallback-recovery.ts:resolveFallbackChain`, `classifyLimitKind` | none (leaves) | — |
| `rate-limit-watchdog-gates.ts:decideRateLimitTrip` | Classification helper/stages of the complete rate-limit scheduling pipeline (review correction round 22) |
| `rate-limit-watchdog-gates.ts:refinedResetAtMs` | none (leaf) | — |
| `message-delivery.ts:classifyReclaimTermination` | Gates of the complete reclaim operation incl. the guarded marker-clear effect (review correction round 22) |
| `message-delivery.ts:asMessageDeliveryPayload` | raw superpipe transform | `message-delivery-payload` |
| `query-runner.ts:parseApiValidationError` | `decisionRun` (after extraction to a module) | `api-validation-parse` |
| `query-runner.ts:terminalUserMessageFor` | `decisionRun` (after extraction to a module) | `terminal-user-message` |
| `message-delivery-pipeline.ts:applyFlushFinalGate` | already `decisionRun` (`message-turn-end-flush`) | no change |
| `ack-selection.ts:selectPersistedAckRow`, `selectYieldedAckRow` | Priority tables as plain helpers/stages of complete yielded/persisted acknowledgment pipelines (review correction round 21: selection-only runners split each ack path at its effect boundary) |

Overlaps with sibling plans: `query-retry-routing.ts`, the delivery routing
cores, and the turn-end/ack apply chain belong to
`docs/superpipe-migration-plans/agent-routing.md` and the pilot proposal's
Chains A/B/C (`docs/agent-layer-superpipe-pilot-proposal.md`). This plan
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
compensated. No site in this plan performs effects, so none uses it.

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
    input: TurnCompletionInput;        // producedResult, turnError, errorResultSubtype, deliveryTurnStalled, claimGuardHeld
    detail: string | null;             // side annotation from the detail gate
    decision: TurnCompletionOutcome | null;
  }
  export type TurnCompletionPipelineInput = Omit<TurnCompletionCtx, 'detail' | 'decision'>;
  ```
  Output stays `TurnCompletionOutcome` exactly as today — the union is
  consumed by the shell's throw/escalate interpretation and by re-export from
  `message-delivery-pipeline.ts:193-199`.
- **pure core design.** Gates (all exported for tests):
  1. `applyProducedResultGate` — `input.producedResult` →
     `decided(ctx, { outcome: 'completed' })`.
  2. `applyTurnDetailGate` — always runs; computes `detail` from the
     preference chain `turnError.userMessage || turnError.message ||
     subtype-template || stall-template || default` and stores it in `ctx.detail`
     without deciding (transform gate; mirrors
     `applyUsageAccountingGate`).
  3. `applyTerminalTurnErrorGate` — `input.turnError &&
     isTerminalTurnError(...)` →
     `decided(ctx, { outcome: 'terminal_error', detail, category })`.
  4. `applyTerminalSubtypeGate` — no turn error, subtype present,
     `!isRetryableErrorResultSubtype(subtype)` →
     `decided(ctx, { outcome: 'terminal_error', … })`.
  5. `applyRecoverableFinalGate` — always decides
     `{ outcome: 'recoverable_error', detail, category, reopenForRetry }`.
  Because gate 2 always populates `detail` before any deciding gate reads it,
  the `??` fallbacks in the deciding gates collapse to `ctx.detail!` guarded
  by the wrapper (keep a defensive `??` recompute if preferred — see
  `turn-end-pipeline.ts:102-112` precedent).
- **shell/effect wiring.** Review correction round 22: keep the classifier
  gates as helpers or DIRECT STAGES of the complete delivery-turn completion
  operation — its effect stages perform the arm interpretations currently
  imperative in `agent-session.ts` (`terminal_error` → throw terminal;
  `recoverable_error` → zero-progress escalation, optional
  `reopenDeliveryForRetry`, throw recoverable; `completed` → clear
  `zeroProgressDeliveryFailures` and return). Converting only the classifier
  into a runner while those recovery effects stay in `agent-session.ts`
  splits the completion operation at its decision/effect boundary.
- **step-by-step migration.** Review correction round 23: migrate the
  COMPLETE delivery-turn completion operation in ONE step — the
  classification gates land as stages of the completion pipeline together
  with the recovery effect stages (terminal throw, zero-progress escalation,
  optional `reopenDeliveryForRetry`, `zeroProgressDeliveryFailures`
  clearing); no classifier-first intermediate with a delegate wrapper that
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
  session-state update, and submitted-message settlement as its stages. No
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
  → status; `message-delivery.ts` checks V2 → (lock) → selection. The lock is
  an effect and stays in the shell.
- **shell/effect wiring.** Review correction round 22 — BOTH call sites
  run the complete reconciliation pipeline; neither keeps an imperative
  cascade behind an admission-only runner. The two snapshots differ
  honestly: `agent-session.ts:2852-2859` supplies `processingStatus` (its
  busy-status admission stage runs), while
  `message-delivery.ts:reconcileStrandedDeliveries` exposes no session
  status to snapshot (its `processingStatus` is `null` and the busy-status
  stage passes — inventing a status default or skipping busy sessions there
  would be a contract change). The standalone path's stage order: V2-flag
  gate → coordinated lock → `selectStrandedDeliveries` filtering against
  active/in-flight UUIDs → enqueue → session-state update → submitted-message
  settlement; the V2-flag predicate is shared.
- **step-by-step migration.** 1) Compose the complete reconciliation
  pipeline (admission gates + lock/select/enqueue/update/settle stages);
  2) rewire BOTH `agent-session.ts:2852-2859` and
  `message-delivery.ts:reconcileStrandedDeliveries` to run it with their own
  snapshots; 3) keep the exported narrow function as a delegate or delete it
  (only tests import it directly).
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
  2. `parseTextResetStage` — runs the reset-parsing stages INLINE
     (`extractResetTimestamp` stays exported as an ordinary pure helper over
     those stages; review correction: calling its wrapper here would execute
     a separate nested pipeline run and split the complete cooldown path).
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
    state: ErrorObservationState;   // { lastError, consecutiveCount } — snapshot, not mutated
    lastInterventionAt: number | undefined;
    threshold: number;
    interventionCooldownMs: number;
    now: number;
    consecutiveCount: number | null;  // side annotation from the count stage
    decision: ConsecutiveErrorDecision | null;
  }
  ```
- **pure core design.** Gates:
  1. `applyInterventionCooldownGate` — the `now - lastInterventionAt <
     cooldownMs` check → `cooldown_reset`.
  2. `applyStreakCountGate` — transform: `sameAsLast ? count+1 : 1` into
     `ctx.consecutiveCount` (never decides).
  3. `applyThresholdGate` — `consecutiveCount >= threshold` → `intervene`.
  4. `applyCountFinalGate` — decides `count` with the new `lastError`.
- **shell/effect wiring.** Review correction round 22: compose the COMPLETE
  error-observation operation as one pipeline — the classification stages
  followed by effect stages for state mutation (`this.state.lastError = …`),
  `reset()`, Forge evidence emission, and recovery-message routing (the
  guardrail loop keeps its per-block iteration, but each observation runs the
  whole pipeline; do not leave those effects imperative in the shell).
- **step-by-step migration.** 1) Add gates + effect stages +
  `decideConsecutiveError` pipeline wrapper; 2) the guardrail's per-error
  call invokes that complete pipeline; 3) no other callers exist.
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
    prevRing: BashFailureRing | undefined;     // snapshot from bashFailures
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
  1. `applyDisabledGate` — `!enabled` or (no threshold and not bash) →
     `allow` with the passthrough streak (identity advance is not needed;
     today the disabled path returns `{}` and *deletes* the scope ledger —
     preserve exactly: model as `action: 'allow', resetLedger: true` or keep
     the delete in the shell keyed on the same condition; pick the explicit
     `resetLedger` flag).
  2. `applyArgKeyStage` — transform: `buildArgKey(toolName, input, cwd)`.
  3. `applyStreakAdvanceStage` — transform: `advanceLoopStreak` → `streak`.
  4. `applyBashRingStage` — bash-only transform: `evaluateBashFailureRing`
     (pure read of `prevRing`); non-bash rows skip via a guard gate that
     leaves `ring: null`.
  5. `applyBashDeadLoopGate` — bash and `streak.count >= bash.threshold` and
     ring all-failures → `decideBashDeadLoop(...)` mapped into a deny
     decision (delegate to the existing function — it stays exported).
  6. `applyIdenticalArgsGate` — non-bash, threshold met →
     `decideIdenticalArgsLoop(...)`.
  7. `applyAllowFinalGate` — decides `allow` with next streak and
     `ringExpired`.
- **shell/effect wiring.** Review correction round 23: the COMPLETE
  loop-admission pipeline performs the state effects as guarded stages —
  the shell (`buildPreToolUseCallback`) shrinks to snapshot
  (`state.ledger.get(scope)`, `state.bashFailures.get(ringKey)`; the ring
  fingerprint is computed lazily only on the bash arm, `prevRing`
  undefined for non-bash — the bash stages are guarded) and run. Inside the
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
  callback rewiring. Add pipeline rows: disabled+non-threshold row resets
  the ledger; bash row with expired ring both denies-not and reports
  `ringExpired`; identical-args row where the deny reason embeds
  `summariseArgs` output.
- **risks/caveats.** This is the only site in the plan on a genuinely
  hot-ish path (every PreToolUse). Overhead is still trivial versus a tool
  round-trip, but do **not** pipeline `buildArgKey`/`stableStringify`
  (per-call, allocates) or `sweepLedger` (a Map iteration with a size
  condition — keep in shell). The ledger/ring Maps are state: they stay in
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
  (`ApiErrorCircuitBreaker.checkMessage`: rapid-fire check → pattern
  classification → occurrence recording → `trip()`/cooldown release), as the
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
- **shell/effect wiring.** Review correction round 21: migrate the COMPLETE
  breaker check path directly — keep the text classifiers as ordinary pure
  helpers and compose rapid-fire check → pattern classification → occurrence
  recording (`recentErrors`, `messageTimestampsByAgent`, `state`) → `trip()`
  (with its async `onTrip` effect) → cooldown release as ONE mixed business
  operation, instead of swapping only the classifiers for runners while
  leaving recording/transitions/trip imperative (that splits every breaker
  check at its central effects).
- **step-by-step migration.** 1) Compose ONE complete breaker-check pipeline
  (`ApiErrorCircuitBreaker.checkMessage`): rapid-fire check → pattern
  classification → occurrence recording → `trip()`/cooldown release as its
  stages, with the text classifiers kept as plain helpers (review correction
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
  pass `jitterFn` spies). Add halt rows: iso match prevents local-datetime
  evaluation (spy on the later gate), relative-delay `delayMs > 0` guard.
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
- **proposed combinator.** Review correction round 22: the trip classification is helper/direct-stage logic of the ONE complete rate-limit scheduling pipeline (classification → retry charging → generation revalidation → `scheduleCooldown` → LLM-refinement trigger), as the corrected wiring below prescribes.
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
  `computeCooldown(errorMessage, retryCount, now)`; 3)
  `applyGiveUpGate` — `!cooldown.freeWait && retryCount >= maxAutoRetries`
  → `give-up`; 4) `applyCooldownFinalGate` — decides `cooldown` with
  `charge: !freeWait`.
- **shell/effect wiring.** Review correction round 22: compose the COMPLETE
  scheduling operation once — the trip-classification gates plus retry
  charging, generation revalidation, `scheduleCooldown`, and LLM-refinement
  triggering as effect stages of the same pipeline; leaving those effects in
  the watchdog shell while only the classifier is a runner preserves a
  classifier/effect split for every rate-limit trip.
- **step-by-step migration.** 1) Gates + effect stages + complete
  scheduling pipeline (cooldown classification as helper/direct stage
  logic); 2) `scheduleRetry` invokes it.
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
  omitted, origin default) and reclaim rows (all four input combinations
  plus precedence — terminalIdle beats successResult).
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
  persisted-ack region around `:400-460`/`:666-710` (status-flag-driven
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
  enqueued, submitted, AND deferred (review correction) — publishes ALL
  THREE events the current handler publishes after changing status:
  `state.sdkMessages.delta`, `sdk.message`, and the tool-result-consumed
  event; restricting SDK-delta publication to the deferred arm makes
  normally yielded messages and tool results disappear from downstream
  SDK-message consumers. Parity tests cover enqueued, submitted, and
  deferred rows; the persisted
  paths at `:400-460` similarly route through `decidePersistedAckRow`, with
  per-row ownership revalidation immediately before every acknowledgement
  (the loop is snapshot-then-await-consume — C3b's Phase 0 guarded
  transition). Effects (`markDeliveryConsumed*`, `messages.statusChanged`
  publishes, `signalDeliveryConsumed`) are stages of the same complete
  pipelines (review correction round 23 — they do not stay in the handler).
- **step-by-step migration.** Review correction round 23: no selection-only
  intermediate — the priority tables stay plain helpers until each complete
  acknowledgment pipeline can land. 1) At the C3b window, add each complete
  pipeline (yielded first, then persisted) — selection stages PLUS the
  consumption, ownership-revalidation, and publication effect stages in the
  same composition — and wire `handleMessageYielded` / the persisted paths
  to it in the same change; 2) the selector functions stay exported plain
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

1. **`fallback-recovery.ts` pipelines** (`fallback-reset-parse`,
   fallback cooldown helper) — foundation for steps 3 and 4; strongest existing
   pin suite; zero callers change.
2. **`rate-limit-watchdog-gates.ts`** (`rate-limit-trip`) — consumes 1's
   `computeCooldown`/`cooldownFromReset`; #2779 already isolated the core.
3. **`limit-error-classifier.ts`** (`limit-error-assess` raw transform) —
   consumes 1's `extractResetTimestamp`; highest classification risk, so it
   lands with its pin suite green and the stage-precedence rows added.
4. **`turn-outcome-classification.ts`** (`agent-turn-completion` +
   `message-reconcile-admission`) — self-contained; the reconcile-admission
   apply touches `agent-session.ts` + `message-delivery.ts`, coordinate with
   in-flight Chain A/B work on those files.
5. **`repeated-tool-error-gates.ts`** (`repeated-tool-error-gate`) —
   isolated core, existing tests.
6. **`loop-detector-gates.ts` + new `loop-detector-pipeline.ts`**
   (`tool-call-loop-admission`) — the only new module and the only shell
   (hook) rewiring among the gate sites; hook tests are the parity proof.
7. **`circuit-breaker-transitions.ts`** (`circuit-breaker-error-pattern`,
   `circuit-breaker-trip-message`) — self-contained; message templates
   frozen.
8. **`message-delivery.ts`** (`message-reclaim-termination`,
   `message-delivery-payload`) — small, but adds the first direct payload
   tests; coordinate with Chain A applies on the same file.
9. **`query-runner.ts` extractions** (`api-validation-parse`,
   `terminal-user-message`) — the only true *extractions* (private →
   module); includes deleting the duplicated-regex tests.
10. **`ack-selection.ts` pipelines** (`ack-persisted-select`,
    `ack-yielded-select`) — pipeline composition can land any time; the
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
  iso-beats-local-datetime halt row (spy on the later strategy) and the
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
  complete `rate-limit-trip` scheduling pipeline, landed unwired —
  `applyBillingTerminalGate`, `applyCooldownResolutionStage` (calls
  `cooldownFromReset`/`computeCooldown` directly), `applyGiveUpGate`,
  `applyCooldownFinalGate`, plus effect stages for retry charging, generation
  revalidation, `scheduleCooldown`, and LLM-refinement triggering expressed
  over ctx-injected collaborators; `refinedResetAtMs` stays a leaf;
  `rate-limit-watchdog.ts` untouched.
- **lands.** The complete scheduling operation exists as one pipeline, pinned
  by tests, before any wiring.
- **excludes.** The `scheduleRetry` rewiring (PR 3), the wider chain-resolve →
  availability → fallback-select horizon (open question 3), and any
  pipelining of `refinedResetAtMs`.
- **tests.** Existing `rate-limit-watchdog-gates.test.ts` rows keep passing;
  add the billing-terminal halt row (cooldown resolution never runs) and the
  usable-free-wait-hint row that never reaches `give-up` at
  `retryCount === maxAutoRetries`.
- **depends on.** PR 1.

### PR 3 — `refactor(agent): wire scheduleRetry to the rate-limit-trip pipeline`

🔧 apply — prod Δ ≲80, test Δ ≲150

- **scope.** `packages/daemon/src/lib/agent/rate-limit-watchdog.ts:211-253`
  (`scheduleRetry`): injects the watchdog's collaborators and invokes the
  complete pipeline — classification, retry charging, generation
  revalidation, `scheduleCooldown`, and LLM-refinement triggering all run as
  stages of the same operation; no imperative interpretation cascade remains
  in the shell.
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
  ctx + gates (`applyProducedResultGate`, transform `applyTurnDetailGate`
  with the preference-chain detail, `applyTerminalTurnErrorGate`,
  `applyTerminalSubtypeGate`, `applyRecoverableFinalGate` with the verbatim
  `?? true` reopen default) plus the recovery effect stages of the complete
  delivery-turn completion operation — terminal throw, zero-progress
  escalation, optional `reopenDeliveryForRetry`, recoverable throw,
  `completed` clearing `zeroProgressDeliveryFailures` — over ctx-injected
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

- **scope.** `agent-session.ts:2375-2394` (no-result branch of the delivery
  turn wait) invokes the complete pipeline with its effect stages;
  `classifyTurnCompletion` becomes a one-line delegate (deleted only once no
  test imports remain).
- **lands.** Classification and its recovery effects run as one complete
  operation in production.
- **excludes.** The reconcile paths in the same file (PR 10).
- **tests.** `turn-outcome-classification.test.ts` green; delegate rows keep
  passing.
- **depends on.** PR 6.

### PR 8 — `refactor(agent): add reconcile-stranded-deliveries pipeline core`

➕ additive core — prod Δ ≲150, test Δ ≲350

- **scope.** `turn-outcome-classification.ts`: admission gates
  (`applyDeliveryV2Gate`, `applyJobQueueGate`, `applyBusyStatusGate`,
  `applyRunGate`) as direct stages of the complete
  `reconcile-stranded-deliveries` pipeline — coordinated lock,
  `selectStrandedDeliveries` filtering against active/in-flight UUIDs,
  enqueue, session-state update, submitted-message settlement — with the
  shared V2-flag predicate and a `processingStatus: null` pass-through for
  the status-less entry; `decideReconcileAdmission` stays exported as the
  narrow delegate.
- **lands.** The complete reconciliation operation exists, unwired, ready for
  both invocation paths.
- **excludes.** Both call-site rewirings (PRs 9–10) and the busy-set
  `ReadonlySet` promotion (open question 4).
- **tests.** Existing delegate rows keep passing; add `v2_disabled`/
  `no_job_queue` admission rows, the `busy`-skips-even-with-V2-and-jobQueue
  row, and the `null` `processingStatus` never-skips row.
- **depends on.** PR 7 (same file, sequenced).

### PR 9 — `refactor(agent): wire the standalone reconcile path to its pipeline`

🔧 apply — prod Δ ≲100, test Δ ≲100

- **scope.** `message-delivery.ts:205-215`
  (`reconcileStrandedDeliveries`): runs the complete pipeline with its own
  snapshot (`processingStatus: null` — busy-status stage passes); the
  lock/select/enqueue/update/settle work becomes pipeline stages, not an
  imperative cascade behind an admission-only runner.
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
  preamble is replaced by the complete pipeline (this path supplies
  `processingStatus`, so its busy-status admission stage runs).
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
  gates (`applyInterventionCooldownGate`, transform `applyStreakCountGate`,
  `applyThresholdGate`, `applyCountFinalGate`) plus the effect stages the
  guardrail performs imperatively today — state mutation, `reset()`, Forge
  evidence emission on `intervene`, recovery-message routing — as the
  complete error-observation pipeline, landed unwired over a state snapshot
  (not `this.state`); the guardrail file is untouched.
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
  `packages/daemon/src/lib/agent/repeated-tool-error-guardrail.ts:93-117`
  (`observeToolResultErrors`): each error row invokes the whole pipeline;
  the shell keeps only the per-block iteration and the injected
  `Date.now()`.
- **lands.** State/reset/evidence/recovery effects run inside the same
  pipeline as the three classification arms in production.
- **excludes.** Any change to the exported decision type.
- **tests.** `repeated-tool-error-guardrail.test.ts` passes unchanged.
- **depends on.** PR 11.

**Phase 6 — `loop-detector-gates.ts` + new `loop-detector-pipeline.ts`**

### PR 13 — `refactor(agent): add tool-call-loop-admission pipeline core`

➕ additive core — prod Δ ≲150 (new module + ctx types), test Δ ≲350

- **scope.** New `packages/daemon/src/lib/agent/loop-detector-pipeline.ts`:
  `decisionRun('tool-call-loop-admission')` — `applyDisabledGate` (`allow` +
  explicit `resetLedger`), `applyArgKeyStage`, `applyStreakAdvanceStage`,
  bash-guarded `applyBashRingStage`, delegating `applyBashDeadLoopGate` and
  `applyIdenticalArgsGate` (both stay exported), `applyAllowFinalGate`, plus
  the `decideToolCallLoopAdmission` wrapper carrying the next streak and
  `ringExpired` in the decision. The hook is untouched.
- **lands.** The PreToolUse admission business path exists as one pipeline;
  the ledger/ring Maps remain the only state, in the hook closure per ADR
  decision 5.
- **excludes.** The hook rewiring (PR 14), `buildArgKey`/`stableStringify`/
  `sweepLedger` pipelining (stay leaf/shell), and the PostToolUse(Failure)
  `recordBashRingOutcome` callbacks (already pure folds).
- **tests.** `loop-detector-gates.test.ts` unchanged; new pipeline rows —
  disabled resets the ledger, expired ring reports `ringExpired`, deny reason
  embeds `summariseArgs` output.
- **depends on.** none — parallel-safe leaf.

### PR 14 — `refactor(agent): wire the PreToolUse hook to loop admission`

🔧 apply — prod Δ ≲100, test Δ ≲150

- **scope.** `packages/daemon/src/lib/agent/loop-detector-hook.ts:118-200`
  (`buildPreToolUseCallback`) shrinks to snapshot → run → interpret:
  `resetLedger` deletes the scope ledger, `set(scope, decision.streak)` on
  BOTH allow and deny, expired-ring delete, `sweepLedger`, and the deny log +
  `permissionDecision` hook output.
- **lands.** The hook callback is the pipeline's reducer body in production.
- **excludes.** PostToolUse(Failure) callbacks (pure state folds, stay
  direct).
- **tests.** `loop-detector-hook.test.ts` is the rewiring parity proof
  (verify deny logging stays in the shell).
- **depends on.** PR 13.

**Phase 7 — `circuit-breaker-transitions.ts`**

### PR 15 — `refactor(agent): add complete circuit-breaker check pipeline core`

➕ additive core — prod Δ ≲120, test Δ ≲250

- **scope.** `packages/daemon/src/lib/agent/api-error-circuit-breaker.ts`:
  the complete breaker-check pipeline, landed unwired — rapid-fire check →
  pattern classification → occurrence recording (`recentErrors`,
  `messageTimestampsByAgent`, `state`) → `trip()` (async `onTrip`) → cooldown
  release as mixed stages over ctx-injected collaborators;
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
  complete pipeline; recording, trip, and cooldown-release effects are its
  stages, not imperative shell code.
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
  "reclaim termination" against the CURRENT `classifyReclaimTermination`
  (`message-delivery.ts:235-244`): all four input combinations plus
  terminalIdle-beats-successResult precedence.
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
  caller code.
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
  wrapper returns `ctx.decision?.text ?? null`.
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

➕ additive core — prod Δ ≲150 (two complete-operation cores), test Δ ≲300

- **scope.** `packages/daemon/src/lib/agent/ack-selection.ts`: the priority
  tables become the direct selection stages of TWO COMPLETE acknowledgment
  pipelines (corrected round 21/22 from the migration order's selection-only
  `ack-persisted-select`/`ack-yielded-select` step) — persisted
  (`applyEnqueuedGate`, `applyDeferredGate`, `applySubmittedGate`,
  `applyConsumedGate`, final `applyNoneGate`) and yielded
  (`applyEnqueuedGate`, `applySubmittedGate`, `applyDeferredGate`, final
  `applyNoneGate` — submitted before deferred, intentionally different) —
  with consumption, ownership-revalidation, and ALL publication stages
  composed into the same operations over ctx-injected collaborators, plus
  `decidePersistedAckRow`/`decideYieldedAckRow` wrappers;
  `selectPersistedAckRow`/`selectYieldedAckRow` stay exported; lands
  unwired-but-green (tests consume the wrappers immediately; knip satisfied
  without `@public`).
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
  enqueued, submitted, AND deferred — publishes all three events
  (`state.sdkMessages.delta`, `sdk.message`, tool-result-consumed);
  consumption, ownership revalidation, and publications run as stages of the
  same operation, not an outer imperative handler cascade.
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

- **scope.** `sdk-message-handler.ts:400-460`/`:666-710`: the
  status-flag-driven consumption regions route through
  `decidePersistedAckRow` with per-row ownership revalidation immediately
  before every acknowledgement (snapshot-then-await-consume, C3b's Phase 0
  guarded transition); `markDeliveryConsumed*`, `messages.statusChanged`
  publishes, and `signalDeliveryConsumed` run as stages of the same
  operation.
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
3. **Watchdog composition horizon.** `RateLimitWatchdog.scheduleRetry`
   (`rate-limit-watchdog.ts:136-254`) is the natural future "one business
   path" pipeline (chain resolve → availability → fallback select → trip →
   cooldown), but it awaits availability checks and owns generation state —
   an async direct-superpipe (`.endAsync`) with generation-guard
   revalidation, not a `decisionRun`. Should that be scoped as its own
   migration plan (it would consume this plan's `rate-limit-trip` output as
   a stage), including B5d's fencing gaps the pilot proposal flagged
   (post-await `retryCount` write, `fireCooldownRetry` finalizer)?
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
6. **Loop-admission ledger reset semantics.** The disabled/no-threshold path
   currently *deletes* the scope's ledger entry (`loop-detector-hook.ts:131`).
   The pipeline models this as `resetLedger: true` on the allow decision;
   confirm that flag-on-decision shape is preferred over keeping the delete
   in the shell keyed on the same predicate.
