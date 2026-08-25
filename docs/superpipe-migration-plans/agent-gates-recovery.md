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
| `turn-outcome-classification.ts:classifyTurnCompletion` | `decisionRun` | `agent-turn-completion` |
| `turn-outcome-classification.ts:decideReconcileAdmission` | `decisionRun` | `message-reconcile-admission` |
| `limit-error-classifier.ts:assessLimitError` | raw superpipe transform | `limit-error-assess` |
| `limit-error-classifier.ts:resolveLimitKind`, `isBillingTerminal` | none (leaves) | — |
| `repeated-tool-error-gates.ts:decideConsecutiveError` | `decisionRun` | `repeated-tool-error-gate` |
| `loop-detector-gates.ts:decideIdenticalArgsLoop`, `decideBashDeadLoop` | `decisionRun` composing both (new `loop-detector-pipeline.ts`) | `tool-call-loop-admission` |
| `circuit-breaker-transitions.ts:extractErrorPattern` | `decisionRun` | `circuit-breaker-error-pattern` |
| `circuit-breaker-transitions.ts:buildTripMessage` | `decisionRun` | `circuit-breaker-trip-message` |
| `fallback-recovery.ts:extractResetTimestamp` | `decisionRun` | `fallback-reset-parse` |
| `fallback-recovery.ts:computeCooldown` | `decisionRun` | `fallback-cooldown` |
| `fallback-recovery.ts:resolveFallbackChain`, `classifyLimitKind` | none (leaves) | — |
| `rate-limit-watchdog-gates.ts:decideRateLimitTrip` | `decisionRun` | `rate-limit-trip` |
| `rate-limit-watchdog-gates.ts:refinedResetAtMs` | none (leaf) | — |
| `message-delivery.ts:classifyReclaimTermination` | `decisionRun` | `message-reclaim-termination` |
| `message-delivery.ts:asMessageDeliveryPayload` | raw superpipe transform | `message-delivery-payload` |
| `query-runner.ts:parseApiValidationError` | `decisionRun` (after extraction to a module) | `api-validation-parse` |
| `query-runner.ts:terminalUserMessageFor` | `decisionRun` (after extraction to a module) | `terminal-user-message` |
| `message-delivery-pipeline.ts:applyFlushFinalGate` | already `decisionRun` (`message-turn-end-flush`) | no change |
| `ack-selection.ts:selectPersistedAckRow`, `selectYieldedAckRow` | `decisionRun` + call-site wiring | `ack-persisted-select`, `ack-yielded-select` |

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
- **proposed combinator.** `decisionRun('agent-turn-completion', [gates])`.
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
- **shell/effect wiring.** `agent-session.ts:2375` swaps
  `classifyTurnCompletion({...})` for `decideTurnCompletion({ input: {...} })`
  (same args, boxed). Interpretation of each arm in the shell is unchanged:
  `terminal_error` → throw terminal; `recoverable_error` → zero-progress
  escalation, optional `reopenDeliveryForRetry`, throw recoverable;
  `completed` → clear `zeroProgressDeliveryFailures` and return.
- **step-by-step migration.**
  1. Add the ctx/gate/pipeline code in `turn-outcome-classification.ts`;
     keep `classifyTurnCompletion` exported as a one-line delegate
     (`decideTurnCompletion({ input }).decision`) so no caller changes.
  2. Delete the delegate once `agent-session.ts` and any test imports moved.
  3. No re-export changes needed in `message-delivery-pipeline.ts` (it
     re-exports the symbol, not the implementation).
- **tests.** Existing suite must pass byte-identical (parity proof). Add two
  pipeline-contract rows: (a) a spy gate after `applyProducedResultGate`
  asserts the cascade halted (later gate not invoked); (b) `detail` gate runs
  even when gate 1 decides (it precedes gate 1 in the list only if ordered
  first — with the order above, `completed` short-circuits detail computation;
  assert `completed` rows never build a detail string, preserving the current
  laziness).
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
- **proposed combinator.** `decisionRun('message-reconcile-admission', …)`
  absorbing the caller preambles into pure gates.
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
- **shell/effect wiring.** Review correction — only the
  `agent-session.ts:2852-2859` call site is rewired to this pipeline.
  `message-delivery.ts:reconcileStrandedDeliveries` keeps its own preamble:
  it has NO processing-status gate (its arguments expose no session status to
  snapshot), checks the V2 flag, takes the lock, and filters persisted rows
  against active/in-flight UUIDs via `selectStrandedDeliveries`. Treating the
  two preambles as duplicates would either invent a status default or start
  skipping reconciliation for busy sessions — a contract change. The
  standalone path's admission semantics stay as-is; at most its V2-flag check
  reuses the `applyDeliveryV2Gate` predicate.
- **step-by-step migration.** 1) Add gates + pipeline; 2) rewire
  `agent-session.ts:2852-2859` only; 3) keep the exported
  narrow function as a delegate or delete it (only tests import it directly).
- **tests.** Existing `decideReconcileAdmission` rows keep passing via the
  delegate; add admission rows for `v2_disabled`/`no_job_queue` (currently
  untestable — they live inline) and one row pinning that a `busy` status
  skips even when V2 and jobQueue are present (agent-session path only).
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
  2. `parseTextResetStage` — `extractResetTimestamp(rawText, now)` → `parsed`.
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
- **proposed combinator.** `decisionRun('repeated-tool-error-gate', …)`.
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
- **shell/effect wiring.** The guardrail loop keeps its shape: classification
  (`classifyToolResultContent`) stays a leaf (it is a content reducer, P6
  territory — do not pipeline the per-block loop), the per-error call becomes
  the pipeline, and the shell applies state mutations (`this.state.lastError
  = …`), `reset()`, evidence emission, and recovery routing per arm.
- **step-by-step migration.** 1) Add gates + pipeline +
  `decideConsecutiveError` wrapper (seed `consecutiveCount: null`,
  `decision: null`); 2) guardrail call site unchanged signature; 3) no other
  callers exist.
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
- **proposed combinator.** One `decisionRun('tool-call-loop-admission', …)`
  in a new `packages/daemon/src/lib/agent/loop-detector-pipeline.ts`,
  composing streak/ring transforms with the two decision gates (ADR "one
  pipeline per business path": the path is PreToolUse loop admission; the
  hook callback is its reducer body, P6).
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
- **shell/effect wiring.** `buildPreToolUseCallback` shrinks to: snapshot
  (`state.ledger.get(scope)`, `state.bashFailures.get(ringKey)`) — note the
  ring key needs the Bash arg key even on non-bash rows? No: compute the
  fingerprint only on the bash arm; the shell may compute it lazily and pass
  `prevRing` as undefined for non-bash (the pipeline's bash stages are
  guarded) — run the pipeline, then interpret the ledger outcome (review
  correction: when the decision carries `resetLedger`, DELETE the scope
  from `state.ledger` — matching the current hook, which deletes the
  session's ledger entry for the unmonitored/no-threshold branch; an
  unconditional `set(scope, decision.streak)` would resurrect the old
  streak after an intervening unmonitored tool call and can trigger a
  false loop denial on return to the monitored tool), then `set(scope,
  decision.streak)` only for allow decisions WITHOUT `resetLedger`, run
  `sweepLedger`, delete expired ring, and on `deny` log + return the `permissionDecision: 'deny'`
  hook output with `permissionDecisionReason`. PostToolUse(Failure)
  callbacks keep calling `recordBashRingOutcome` directly (they are pure
  state folds on the ring, already leaf functions).
- **step-by-step migration.** 1) Create `loop-detector-pipeline.ts` with
  ctx/gates/pipeline + `decideToolCallLoopAdmission` wrapper; 2) rewire
  `buildPreToolUseCallback`; 3) keep `decideIdenticalArgsLoop` /
  `decideBashDeadLoop` exported (pipeline delegates; direct tests stay); 4)
  update `loop-detector-hook.test.ts` spy expectations if it counts logger
  calls (deny logging moves to the shell — verify it stays there).
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
- **proposed combinator.** `decisionRun('circuit-breaker-error-pattern', …)`
  for `extractErrorPattern` (nullable first-match; no definitive-null arm —
  every gate just fails to match, wrapper returns `ctx.decision ?? null`);
  `decisionRun('circuit-breaker-trip-message', …)` for `buildTripMessage`
  (final gate always decides with the fallback template, so the wrapper never
  needs a fallback).
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
- **shell/effect wiring.** `ApiErrorCircuitBreaker` swaps the two direct
  calls for the wrappers (`decideErrorPattern`, `decideTripMessage`); state
  writes (`recentErrors`, `messageTimestampsByAgent`, `state`), the `trip()`
  callback, and cooldown release stay in the class. `checkMessage` itself is
  a candidate for a future mixed pipeline (rapid-fire → pattern → record →
  trip) but that involves the async `onTrip` effect and belongs to a later
  composition pass, not this plan.
- **step-by-step migration.** 1) Add both gate sets + pipelines in
  `circuit-breaker-transitions.ts`; keep the two functions as wrappers;
  2) no `api-error-circuit-breaker.ts` changes required (wrapper keeps
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
- **proposed combinator.** `decisionRun('fallback-reset-parse', …)` and
  `decisionRun('fallback-cooldown', …)`. `resolveFallbackChain` and
  `classifyLimitKind` stay leaves (see Scope).
- **input/output snapshot design.**
  ```ts
  interface ResetParseCtx { errorMessage: string; now: number; decision: ParsedReset | null; }
  interface CooldownCtx {
    errorMessage: string;
    cooldownRetryCount: number;
    now: number;
    jitterFn: () => number;
    parsed: ParsedReset | null;   // transform stage output
    decision: CooldownDecision | null;
  }
  ```
- **pure core design.** Reset-parse gates: `applyIsoWithTzGate`,
  `applyLocalDatetimeGate`, `applyEpochMillisGate`, `applyEpochSecondsGate`,
  `applyRelativeDelayGate` — each iterates its matches and stamps the first
  valid one; no final decider; wrapper returns `ctx.decision ?? null`
  (semantics: `decisionRun` halts exactly when a strategy finds a valid
  reset, which *is* the current short-circuit). Cooldown gates:
  `applyParseStage` (transform: `extractResetTimestamp` — call the wrapper,
  not the gates, so the two pipelines stay decoupled), then
  `applyParsedResetGate` (stamps the free-wait decision) and final
  `applyBackoffLadderGate` (ladder clamp + cap + jitter + floor).
- **shell/effect wiring.** No shell changes: all consumers call the wrappers,
  which keep the exact signatures (`computeCooldown(errorMessage, count,
  now?, jitterFn?)`).
- **step-by-step migration.** 1) Pipelines + wrappers in
  `fallback-recovery.ts`; 2) everything else continues to compile unchanged
  (same exports); 3) land before the `limit-error-assess` apply so stage 2
  of that transform calls the finished wrapper.
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
  hint is usable, otherwise `computeCooldown`; non-free-wait at/over
  `maxAutoRetries` → `give-up`; else `cooldown` with `charge`. Consumers:
  `rate-limit-watchdog.ts:211-253` (`scheduleRetry` — interprets by
  charging `retryCount`, scheduling cooldown, firing LLM refinement for
  ladder arms). Extracted as pure gates in #2779; pinned by
  `rate-limit-watchdog-gates.test.ts` + `rate-limit-watchdog.test.ts`.
- **proposed combinator.** `decisionRun('rate-limit-trip', …)`.
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
- **shell/effect wiring.** `scheduleRetry` keeps its generation fencing,
  fallback selection, and post-trip interpretation (charge increment,
  `scheduleCooldown`, refinement trigger); only the trip call becomes the
  wrapper `decideRateLimitTrip` (same name; same input shape — callers
  unchanged).
- **step-by-step migration.** 1) Gates + pipeline + wrapper (seed
  `cooldown: null`); 2) no consumer edits.
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
- **proposed combinator.** `decisionRun('message-reclaim-termination', …)`
  and raw superpipe transform `message-delivery-payload`.
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
- **shell/effect wiring.** `reclaimTurnAlreadySucceeded` swaps the direct
  call for the wrapper; `clearDeliveryTurnEnd` on `redrive` stays in the
  shell (DB effect). Both payload call sites keep their null-handling
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
  exclusion (framed 429 that would otherwise match the plain arm), malformed
  JSON body falling through to the plain arm where applicable, halt rows.
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
- **proposed combinator.** `decisionRun('ack-persisted-select', …)` and
  `decisionRun('ack-yielded-select', …)` wrapping the priority tables, plus
  the C3b call-site wiring the selectors were extracted for.
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
- **shell/effect wiring.** This is Chain C's C3b apply and is **gated on the
  pilot proposal's sequencing** (after the B5 series; coordination on open
  PRs touching `sdk-message-handler.ts`). When it lands:
  `handleMessageYielded` replaces its probe chain with row snapshots →
  `decideYieldedAckRow` → per-arm interpretation (consume+publish, deferred
  consume with sdk-message delta publish, none → return); the persisted
  paths at `:400-460` similarly route through `decidePersistedAckRow`, with
  per-row ownership revalidation immediately before every acknowledgement
  (the loop is snapshot-then-await-consume — C3b's Phase 0 guarded
  transition). Effects (`markDeliveryConsumed*`, `messages.statusChanged`
  publishes, `signalDeliveryConsumed`) stay in the handler.
- **step-by-step migration.** 1) Add the two pipelines + `decide*` wrappers
  (selectors stay exported — tests and the pipelines use them; alternatively
  the gates *are* the selectors' rows, and the original functions become
  wrappers); 2) keep everything unwired-but-green until the C3b window;
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
   `fallback-cooldown`) — foundation for steps 3 and 4; strongest existing
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
