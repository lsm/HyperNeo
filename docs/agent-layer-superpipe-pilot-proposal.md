# Agent layer (`lib/agent/`) survey → superpipe pilot-chain proposal

Task #1217. Survey basis: `origin/dev` @ `b7f20b4f3` (2026-08-21) — line
citations re-verified against current dev after #2696 (SDK interrupt receipt +
refusal rewind), #2698, #2699, and #2700 landed; those commits shifted
sdk-message-handler.ts (+7…+36 through its length), interrupt-handler.ts
(+10…+66), and agent-session.ts (+4 past :1091), and the affected references
below use the refreshed numbers. ADR 0004 (incl.
the `stagedRun` amendment and the pilot-3/5 records) read in full; pilot-4
in-layer precedent read first-hand (`message-delivery-pipeline.ts`,
`message-ownership-gates.ts`, `turn-outcome-classification.ts`,
`context-reset-planner.ts`). Analysis only — this document proposes, it does not
implement.

**Churn-evidence caveat (load-bearing):** the clone's git history is squashed at
the 2026-08-16 import (`105f40d45`, PR #2552 — the tree root). `--since=6months`
therefore covers **5 days**, and pre-import fix history is reachable only via PR
numbers. In-window touches: agent-session.ts 8 / 2 fixes, query-mode-handler.ts
7 / 3, query-runner.ts 6 / 3, sdk-message-handler.ts 5 / 1, message-delivery.ts
5 / 1, query-options-builder.ts 5 / 2. The "top fix-density file" claim cannot
be verified from local git; PR-level evidence (#2447, #2478, #2493, #2572,
#2579, #2598, #2656, #2671, open #2543) points at the **delivery subsystem +
query lifecycle** as the recurring fix area, with pre-rename ancestors of
sdk-message-handler showing the same dedup/ack bug class back to Dec 2025.

## 1. Layer map — major sub-flows

### (a) Query lifecycle

| File | Lines | Entry points | Owned mutable state | Covering tests |
| --- | --- | --- | --- | --- |
| `query-runner.ts` | 1,645 | `QueryRunner.start()` :338, `runQuery` :431–1341, `handleSDKMessage` :1512, `createMessageGeneratorWrapper` :1478, `createAbortableQuery` :1517 | `_lastConsumedUserMessage` :322, `_consumedUserMessages` :327; everything else on `ctx` (AgentSession fields) | `query-runner.test.ts` (3,352 ln) + two startup-gate suites (437 + 393 ln) |
| `query-lifecycle-manager.ts` | 666 | `stop` :180, `restart` :245, `reset` :281, `ensureQueryStarted` :400, `startQueryAndEnqueue` :495, `restartQuery` :623 | `timeoutDeliveryRetryCounts` :69; ctx `pendingRestartReason` | `query-lifecycle-manager.test.ts` (1,648 ln) |
| `query-mode-handler.ts` | 202 | `handleQueryTrigger` :34, `sendEnqueuedMessagesOnTurnEnd` :144, replay :176 | stateless (ctx only) | `query-mode-handler.test.ts` (891 ln) |
| `sdk-startup-gate.ts` | 122 | `SdkStartupConcurrencyGate.acquire` :47, permit `release` :88 | `active`/`waiters` (module singleton) | `sdk-startup-gate.test.ts` (176 ln) |
| `query-options-builder.ts` | 1,146 | `build()` :287, `addSessionStateOptions` :497 | `canUseTool`/`askUserQuestionHook` injected per spawn; `deferredPermissionMode` recorded by `build()` :465–471 | `query-options-builder.test.ts` |

`runQuery` is confirmed as one ~900-line staged flow (:431–1341): provider/auth
gate (:450–510) → options build + hooks (:517–526) → MCP invariants + self-heal
(:528–639) → **process-env mutation (:641–671, before gate admission)** →
startup-gate acquire (:686–701) → spawn (:713) → deferred permission (:719) →
startup-timeout timer (:739) → per-event loop (:781–824) → catch classification
(:840–867) → **four retry arms** (startup-timeout :869–968, message-not-found
:969–1008, transient :1010–1064, provider 5xx backoff :1066–1151 — explicit
HTTP-4xx including 429 is excluded by `isRetryableProviderError`
(`HTTP_4XX_STATUS_RE`, shared/provider/error-taxonomy.ts:376) and reaches the
terminal cascade's 429 handoff instead) → terminal
cascade + 429 handoff (:1153–1291) → finally (:1292–1340). The four retry arms
repeat one teardown liturgy four times (:912–934, :972–1002, :1018–1058,
:1078–1114). Generation guards (`retrySupersededByReplacement` :1471) close each
arm before it recurses, but they do **not** fence every async window: state
mutations precede the arm's guard in several places — the transient arm awaits
`setIdle` (:1024) and re-enqueues the consumed message (:1027–1034) before its
first check (:1060); the transient arm's window extends further — after
re-enqueueing it awaits its retry notice (:1036–1040), then closes the shared
query object and may reset the process-exit promise (:1042–1057) before its
first supersession check (:1060), so a replacement installed during that span
loses its query/process ownership to the stale attempt (pin through :1058 with
a resnapshot before touching those shared fields); the message-not-found arm
likewise awaits `setIdle` at
:978 before its first check at :980; and every arm's awaited `setIdle`
(:906, :978, :1024) precedes its first guard (:908, :1060) — so a replacement landing
inside those windows can have its state mutated by the stale arm. The 5xx arm's
revalidation gate (:1127–1138) sits immediately before the re-enqueue (:1140),
but the arm is not fully fenced either: it awaits `displayErrorAsAssistantMessage`
(:1091–1096), then closes the live query object and restores shared provider env
before reaching :1127, so a replacement installed during those awaits can be
closed or mutated by the stale attempt — this window joins PR 1's pins, and the
env restore-and-clear specifically (which can arrive even later, after the
process-exit await or dynamic import at :1105–1122) needs a further generation
check or an identity-guarded snapshot so a stale attempt cannot clear a
replacement-installed environment. The common finalizer shares the flaw at the
largest scale: it snapshots staleness once at :1295, then can await the
provider-service import and `setIdle` before clearing shared environment state,
consumed-message state, and `ctx.queryPromise` at :1321–1338 — a replacement
starting after that snapshot can have its environment restored/erased and its
live query promise nulled by the stale finalizer, so the window joins the pins
and shared mutations require generation/identity revalidation after the
finalizer's awaits. The
startup-timeout arm has the same shape after its last guard: it awaits
`displayErrorAsAssistantMessage` (:959–965) and recurses at :967 with no
entry-generation guard on `runQuery`, so a replacement landing during that await
lets the stale retry continue through setup and spawn — PR 1 pins this too, and
the apply shape adds a generation resnapshot immediately before each recursion
so the extraction does not widen these windows.

### (b) Delivery/ordering machinery (the loops around the pilot-4 cores)

| File | Lines | Role |
| --- | --- | --- |
| `message-delivery.ts` | 496 | `deliverMessage` role arbiter :97–139; `deliverBatchAndMarkQueued` :160–201; **production-dead module-level `reconcileStrandedDeliveries` :207–242**; consumption waiters :334–413; `withSessionLock` :438–466; `deliverAndMarkQueued` :468–496 |
| `message-delivery-outbox.ts` | 82 | `persistAndEnqueueDelivery` :36–82 — user row + job in one tx, UNIQUE→steer fallback |
| `message-queue.ts` | 358 | in-memory pending/claimed/yielded + generation fence; timeout policy :105–128 |
| `delivery-turn-stall-watchdog.ts` | 55 | timer owner; defers while outstanding tool / paused |
| `message-delivery-metrics.ts` | 168 | in-memory LRU metrics singleton |
| `job-handlers/message-delivery.handler.ts` | 189 | **outside the layer but part of the flow**: skip ladder :68–85, park budgets, promote-with-UNIQUE-fallback :175–187 |

Durable state: `sdk_messages.send_status` — a non-linear machine, not the linear
`deferred→enqueued→submitted→consumed|failed` pipeline: the repository also
performs guarded `deferred|enqueued|submitted → consumed|failed`
(sdk-message-repository.ts:1286–1301), park `enqueued→deferred` (:1444–1446),
fail from `enqueued|deferred|submitted` (:1691–1696), and reopen paths
(`failed→enqueued`, `consumed→enqueued` via `reopenDeliveryByUuid` :1816 and the
delivery-retry helpers). `job_queue` rows
(`message_delivery` queue, claim tokens, park/retry counts), delivery turn-end
markers. The partial unique index `uq_message_delivery_active_turn` is the real
turn/steer arbiter. Un-extracted decision logic: `deliverMessage` role
arbitration (the extracted `resolveDeliveryRole` core at
message-ownership-gates.ts:89–101 is **wired nowhere** — `deliverMessage`
re-implements it imperatively), the handler outcome→action mapping,
`feedDeliverySteer`'s status ladder (agent-session.ts:1696–1721),
`driveDeliveryTurn`'s admission cascade (agent-session.ts:1338–1497),
MessageQueue timeout policy (:105–128), `rebuildBatchDeliveryContent`
(agent-session.ts:1901–1931).

### (c) agent-session.ts facade (~2,226 ln)

Implements 13 handler-context interfaces; owns every satellite plus all shared
mutable state (query refs :215–220 mutated directly by five satellites,
delivery/turn fields :222–234, process tracking :235–241, reconcile timer
:245–246). Pure delegation for interrupt/rewind/questions/model-switch/config;
**contained logic**: fallback retry (`switchAndRetryForFallback` :782–830,
`executeRateLimitAutoRetry` :840–878), the entire v2 delivery-turn machine
(`driveDeliveryTurn` :1307–1642, `feedDeliverySteer` :1688–1755,
`deliverChatMessage` :1774–1822, `reconcileStrandedDeliveries` :1953–2004),
process tracking (:2006–2200). Pilot-4 core call sites confirmed:
`classifyTurnCompletion` :1624, `shouldRearmSpuriousTurnEnd` :1585,
`decideReconcileAdmission` :1958, `selectStrandedDeliveries` :1964.

### (d) State machines

- `ask-user-question-handler.ts` (624): implicit machine — idle → pending
  (`pendingResolver` :68 + `waiting_for_input`) → answered/cancelled/orphaned/
  queued-answer. Decision/effect interleaving throughout:
  `interceptAskUserQuestion` :75–211 (validate → queued-answer fast path →
  supersede → register → `setWaitingForInput` → publish), `handleQuestionResponse`
  :273–364 (records DB **before** the supersede re-check),
  `deliverQueuedAnswer` :514–582.
- `processing-state-manager.ts` (381): explicit status machine
  (idle/queued/processing/interrupted/waiting_for_input/rate_limit_cooldown +
  streaming phase) — almost pure bookkeeping; the only self-contained decision
  logic is `detectPhaseFromMessage` :318–362 and the waiter/fence drain semantics
  in `setIdle` :143–177.
- `model-switch-handler.ts` (302): single cascade `switchModel` :101–301 —
  validate → announce → provider resolution → active/inactive branch (inactive
  :178–204; active :205–239 → ACP in-place or `lifecycleManager.restart()`) →
  rollback :258–300.

### (e) sdk-message-handler.ts dispatch (~1,160 ln)

`handleMessage` :597–799: per-token-hot `stream_event` arm (:603–606, never
persists) → drop arms → circuit-breaker gate :632 → thinking-token stash
:653–663 → persisted-user ack :667–670 → usage zero-fill :676–687 → save
:702–709 → terminal-idle fence :720–722 → delta + bus publish :724–737 →
per-type sub-handlers (user :757, system :761, success result :765, assistant
:769, status :773, refusal fallback :777, refusal rewind target :781,
session-state idle :785, compact boundary :789). Biggest decision regions: the
**turn-end flag machine** (`suppressIdleOnNextResult`/
`usesSessionStateChangedTurnEnd`/`expectsSessionStateIdleAfterResult`/
`lastResultWasSuccess` across :720–755 + :936–973 — the un-extracted counterpart
of pilot-4's turn-outcome core), `acknowledgeOldestQueuedUserOnTurnEnd`
:333–392 (ownership/yield/claim filter :338–345 is a pure predicate), cost/usage
accounting with cost-reset detection :872–889 (inside `handleResultMessage`
:864–941), compact-fallback trigger :1120–1150. #2696 added the
`recordRefusalRewindTarget` arm :781–783.

### (f) Also present

`fallback-recovery.ts` (230) — **already pure** (chain selection, cooldown
ladder, limit classification). `context-fetcher.ts` (307) — `toContextInfo`
:131–306 already a pure cascade. `output-limiter-hook.ts` (202) — stateless
policy core of the same class as the excluded loop-detector (only consumer:
query-options-builder.ts:906–923). `interrupt-handler.ts` (~252, post-#2696) —
teardown plus a real decision region: receipt handling at :115–158 branches over
surviving queued messages, cancellation outcomes, and control deadlines, so it
is no longer purely linear teardown and belongs in extraction analysis.
`rewind-handler.ts` (667) — mode cascade + diff revert, **no
session lock / processing-state guard anywhere**. `coordinator/*` — pure agent
role configs. `event-subscription-setup.ts`, `session-config-handler.ts`,
`sdk-runtime-config.ts` — wiring/mutators.

## 2. Excluded modules — call-site interactions (noted, not proposed)

| Excluded file | Interactions with proposed flows |
| --- | --- |
| `rate-limit-watchdog.ts` | Owned by agent-session (:213, :358–401). Chain B touchpoint: query-runner.ts:1242 `onRateLimitExhausted` → boolean drives `recoveryState.rateLimitCooldownScheduled`, suppressing `beginTerminalIdle`/`errorManager`/`setIdle` (:1243–1245, :1288, :1331); watchdog retry re-enters via `executeRateLimitAutoRetry` → `startQueryAndEnqueue` with episode-generation supersede check (query-lifecycle-manager.ts:503–512). Chain A touchpoints: generation into `waitForIdleTransition` (agent-session.ts:1391, :1597), stall-watchdog pause (:1657), cancel on new turn (:1811–1812). |
| `api-error-circuit-breaker.ts` | Owned by sdk-message-handler (:80, :102); per-message gate at :632 (chain C region — position must not move); trip handler :183–223 calls `lifecycleManager.stop`; resets from query-lifecycle-manager.ts:250/296/319 (chain B's lifecycle neighbor). |
| `repeated-tool-error-guardrail.ts` | Owned by sdk-message-handler (:96, :113–160); fed at :1014–1032 (user/tool-result arm) and :1034–1064 (assistant tool-use recording); recovery route enqueues into MessageQueue. |
| `loop-detector-hook.ts` | Wired in query-options-builder.ts:874–927 (per-`build()` fresh hooks). No overlap with any proposed chain. |

`output-limiter-hook.ts` is **unassigned** and is the same class as these four —
recommend it join the policy-core pilot series as a fifth member rather than any
chain below.

## 3. Collision check

**ACP split 8/10 (task #1204, status: open, not started)** — its title says
"query-runner" but its scope is `lib/acp/acp-query-runner.ts` (~407 ln, a
separate module) + `lib/acp/acp-transport.ts`. Inside `lib/agent/` it touches
only: `model-switch-handler.ts` (+57, ACP session disposal on switch),
`query-lifecycle-manager.ts` (+7), `session-config-handler.ts` (+1) (verified via
diff of reference ref `origin/space/acp-devin-integration-verify-and-open-pr`).
**Conclusion: query-runner.ts pilot work does NOT need to sequence after ACP
8/10.** Only model-switch-handler work does (hence no model-switch chain below).
Dependencies of 8/10: splits 1, 2, 5, 6, and 7 have merged (#2689, #2698
(merged as `876c5a1` on 2026-08-22, after this survey's basis — it touched only
`lib/acp/`, `providers/`, and `rpc-handlers/`, not `lib/agent/`), #2688, #2699,
#2687); splits 3, 4, 9, and 10 are still open.

Other live collisions (all must land or stall before the corresponding chain's
apply PRs):

- **PR #2661 (open)** — limit-error pipeline: touches `query-runner.ts`,
  `sdk-message-handler.ts`, `agent-session.ts`, `fallback-recovery.ts`; adds
  `limit-error-classifier.ts`. Collides with chains B and C.
- **PR #2543 (open)** — Codex-findings triage: touches `agent-session.ts`,
  `message-delivery.ts`, `sdk-message-handler.ts`,
  `job-handlers/message-delivery.handler.ts`. Collides with chains A and C
  — those are exactly Chain A's target files as well as C regions. No
  query-runner code, so **Chain B is not blocked** by this PR (it sequences only
  behind #2661, per its own impact line).
- **Landed since the survey basis:** #2696 (Issue #2548 part 2 — SDK interrupt
  receipt + refusal rewind target; `61e5f9b`) touched interrupt-handler.ts,
  sdk-message-handler.ts, agent-session.ts — no longer a collision, but it added
  `withInterruptControlDeadline` (2 s default) around `queryObject.interrupt()`
  and the `recordRefusalRewindTarget` dispatch arm (:781–783); #2699/#2688/#2700
  stayed outside the layer.
- **In progress:** Pilot 4 PR 7 (`clearConversationContext` — agent-session.ts).
- Pilot-4 cores themselves are stable; chains below extend them, never reshape
  them.

## 4. Shared state & cross-sub-flow couplings (sequencing constraints)

1. **`agent-session.ts` is the shared shell for everything.** All chains route
   through its public fields. Only one chain should be in flight against the
   facade at a time.
2. **The idle transition is the coupling point between B, C, and A.**
   `setIdle`/`beginTerminalIdle`/`waitForIdleTransition` are driven by
   query-runner's finally (:1331) and sdk-message-handler's result path
   (:746–750, :936–946), and awaited by `driveDeliveryTurn`'s turn-end race
   (:1569–1605, generation-scoped with the watchdog's generation). Chain C makes
   these semantics explicit as a core, but Chain A's turn-end loop does **not**
   consume it: `driveDeliveryTurn` races the idle waiter/query promise/stall
   watchdog/abort signal and already rides the pilot-4 cores
   (`shouldRearmSpuriousTurnEnd` :1585, `classifyTurnCompletion` :1624). The real
   coupling is the shared `ProcessingStateManager` idle-transition contract; C
   before A is a facade-churn preference, not a hard ordering.
3. **`sdk_messages.send_status` writes are unguarded check-then-act across all
   three flows** (query-mode-handler.ts:55, sdk-message-handler ack/consume
   paths, agent-session reopen :1937–1951). Groundwork here needs more than a
   status CAS: an expected-status CAS only orders competing status writers — it
   does not make the status change and the delivery-job creation atomic, so an
   enqueue failure after `deferred→enqueued` still strands an owner-less row. The
   fix shape is transactional ownership creation (status change + job insert in
   one transaction, as `persistAndEnqueueDelivery` already does) or an explicit
   compensating transition. An expected-status CAS is explicitly *not* part of
   this groundwork: the ack/consume paths run check→write synchronously in the
   single-process daemon (`consumePersistedUserMessage` commits its
   `updateMessageStatus` before its first await, sdk-message-handler.ts:302–306;
   `handleMessageYielded` is synchronous through its update, :520–526), so a CAS
   would close no reachable race — it was retracted on the same
   run-to-completion grounds as the other withdrawn reports.
4. **MessageQueue is shared by B and A**: the runner's generator consumes it
   (:1478–1510); the delivery machine admits into it (agent-session.ts:1481–1483).
   Extraction must not reorder enqueue vs generation-fence semantics
   (message-queue.ts:279–297).
5. **The excluded policy pilots interleave**: B's terminal cascade must keep the
   `onRateLimitExhausted` contract stable while the watchdog pilot pins its
   trip/reset table; C must not move the circuit-breaker gate (:632) or guardrail
   feed points (:1014–1032, :1034–1064) while those pilots run.

## 5. Proposed pilot chains (ranked by impact-per-risk)

Established shape for every chain: PR 1 pins behavior test-only → pure-core
extractions additive → pipeline composition → apply at call sites → cleanup/ADR
note.

### Chain B (propose first): query-runner retry routing & teardown dedup

- **Scope:** query-runner.ts catch-classification + four retry arms + terminal
  cascade (:840–1291); the four-copy teardown liturgy (:912–934, :972–1002,
  :1018–1058, :1078–1114); supporting pure islands `looksLikeRateLimit429` :92
  and `parseApiValidationError` :1568 stay as-is.
- **ADR pattern:** `decisionRun` core —
  `classifyRetryRoute(error class, subtype, retryAttempt, retry cap exhausted —
  production gates the backoff arm with retryAttempt < getMaxProviderRetries()
  and separately detects exhaustion, so the runtime setting must be an input,
  :1066–1151 + getMaxProviderRetries; recoveryState, generation flags, lifecycle
  state as **two separate dimensions** — processing status and abort-controller
  signal — not one merged value, and **route-specific** rather than a blanket
  gate: processing status gates
  startup/transient (:898–904, :1010–1015) — note a redeliverable attempt-zero
  startup timeout is blocked when the status is `interrupted` but still taken
  when the status is `processing` and only `queryAbortController.signal.aborted`
  is true, since the signal reaches startup only via `isQueryInterrupted` in the
  transient/provider arms —
  but the message-not-found arm checks only attempt and cleanup state (:969) and
  deliberately still consumes the resume pointer and retries while interrupted —
  pin that asymmetry explicitly so the classifier does not suppress the route;
  prompt
  redeliverable — at attempt 0 a startup timeout with
  an empty consumed set and empty queue is futile and falls through to the
  terminal cascade via `canRedeliverPromptOnStartupRetry`, :887–905; provider
  family — the same exhausted error classifies `PROVIDER_UNAVAILABLE` vs
  `SYSTEM` by `session.config.provider`, :1169–1229) →
  startup_timeout_retry | message_not_found_retry |
  transient_retry | provider_backoff(5xx) | rate_limit_handoff |
  aborted_noop(clear_queue) — an AbortError matching no arm skips the entire
  terminal path via the `!isAbortError` gate (:1158–1291), **but the pre-gate
  `messageQueue.clear()` at :1153 still runs** — pending/claimed/yielded
  messages are drained on cancellation, so the route (or a shared pre-route
  effect) must preserve that clear; without this route the interpreter would
  classify intentional cancellation as
  terminal and display an error or run terminal-idle handling |
  cleanup_noop / superseded_noop — the early exits at :845–851 (cleaning-up
  begun, or generation replaced) return before queue-clear or any arm; as
  distinct routes (or shell-retained gates) those inputs cannot fall through to
  terminal handling |
  rate_limit_handoff(scheduled | declined | **thrown**) — the awaited
  `onRateLimitExhausted`
  outcome decides the post-effect route: `scheduled` suppresses terminal
  handling, while `declined` (no consumed prompt, exhausted watchdog budget)
  falls back to `beginTerminalIdle` + `errorManager` + `setIdle`
  (:1240–1289) — **after a generation resnapshot**: the handoff effect awaits
  (e.g. its no-prompt path awaits `setIdle`), so a replacement may have taken
  the session by the time `declined` returns, and a stale result must route to
  superseded/no-op before applying the declined terminal actions — and
  **`scheduleRetry` can reject** (it awaits fallback resolution and
  `setRateLimitCooldown`, rate-limit-watchdog.ts:149–215): production then
  exits the catch through `finally` *without* the declined branch's
  terminal actions, so a thrown-effect outcome is modeled explicitly (or
  exception propagation stays in the shell) rather than coercing the failure
  into `declined`; the handoff
  interpreter carries this post-effect decision as a
  pinned branch rather than nested routing |
  api_validation(text) — a parseable API validation failure (e.g.
  `400 prompt is too long`) is displayed verbatim with `markAsError` via
  `parseApiValidationError`/`displayErrorAsAssistantMessage` (:1568–1617,
  :1159–1165), deliberately skips `errorManager`, with no terminal category —
  **and still performs the idle transitions**: `beginTerminalIdle()` before the
  display and the common `setIdle()` afterward (:1287–1289), so an interpreter
  following only display-and-skip would strand the session in processing —
  and like the declined handoff, the route takes a **post-display generation
  resnapshot**: the display is awaited (`:1161–1165`), so a replacement may
  hold the session by the time `setIdle()` runs, and a stale post-display
  result routes to superseded/no-op before idling the replacement;
  folding it into `terminal(category)` would replace the actionable validation
  text with generic category handling |
  terminal(category, message_hint) — the category alone does not determine the
  user message: :1247–1269 selects tailored text per variant (an exhausted
  startup timeout and an ordinary timeout are both `TIMEOUT`, but only the
  former gets startup-specific guidance), so the route carries the hint/subtype
  and the decision table asserts it instead of the interpreter re-deriving it` —
  interpreted by thin shell arms. Routing note the table
  must preserve: rate-limit errors — explicit HTTP-429 **and** text-form — do
  not enter the provider-backoff arm: `isRetryableProviderError` excludes all
  `\b4\d{2}\b` matches, and text-only "rate limit" errors fail it too because
  `RETRYABLE_PROVIDER_ERROR_TEXT` is built from taxonomy entries that supply
  `looseTextSubstrings`, which the generic rate-limit entry does not. Both route
  to the terminal cascade's RATE_LIMIT category check, whose
  `category === RATE_LIMIT && !isNonRetryableBillingError` predicate hands off
  to the watchdog (:1234–1242) — note both that `looksLikeRateLimit429` (:92) is
  *not* that predicate (it rejects text-only forms and is called only from
  `parseApiValidationError`, :1571) and that non-resettable billing/quota
  failures ("429 quota exceeded") are excluded from cooldown recovery by
  `isNonRetryableBillingError` and fall through to terminal handling — the
  classifier therefore carries a billing-non-resettable input so a terminal
  billing failure cannot become repeated cooldown recovery. The backoff arm is
  whatever `isRetryableProviderError` accepts — 5xx **and** the full
  `RETRYABLE_PROVIDER_ERROR_TEXT` loose-text set
  (the overloaded/service-unavailable family including `temporarily
  unavailable`, the GLM strings `访问量过大`/`当前访问量过大`, and GLM `[1305]`)
  — **with terminal-text precedence**: `TERMINAL_PROVIDER_ERROR_TEXT` is checked
  before any 5xx acceptance, so e.g. `503 due to quota limits` is terminal, not
  backoff; the classifier input should be defined
  directly from `isRetryableProviderError` rather than a duplicated partial
  list. The backoff arm's
  sleep→revalidate→re-enqueue→recurse (:1066–1151) is a `stagedRun` candidate
  (async stages: sleep, re-check, re-enqueue) but sync-core-first per Decision
  item 5 — note the arm also **persists and publishes a retry notice** first
  (`displayErrorAsAssistantMessage`, :1091–1096 → :1619–1643, a fresh UUID per
  call): if staged, that write/publication is a reserved-and-compensable effect
  with an idempotency key, or it stays in the shell, since a retried pass can
  otherwise duplicate the notice; the existing generation guards inform the resnapshot stage but must not
  be presented as complete fencing — PR 1 pins the unfenced windows (transient
  arm :1024–1034 ahead of :1060; every arm's awaited `setIdle` ahead of its
  first guard; the message-not-found pointer consumption at :970 is *not* one —
  the stale-generation return at :849–851 reaches it with no intervening await)
  as characterization — **and closing the reachable ones is an explicit
  apply-PR requirement**: the apply arms add a **full lifecycle resnapshot**
  (generation **and** cleaning-up/processing-status/abort-signal —
  `QueryLifecycleManager.cleanup()` sets the cleanup flag and enters `stop()`
  *without* incrementing the query generation, query-lifecycle-manager.ts:652–663,
  :180–243, so a generation-only check can pass while teardown is in progress)
  **immediately after each awaited `setIdle` — before reading or re-enqueueing
  the consumed message** (the transient arm's `:1027–1034` re-enqueue sits
  between its awaited `setIdle` and the `:1060` guard, so a stale arm could
  otherwise append the old prompt to the queue) — before
  touching shared query/process fields and immediately before each recursion,
  since staged async boundaries widen these windows. Teardown dedup is
  plain helper extraction, not a pipeline.
- **PR sketch:**
  1. **PR 1 (test-only pins):** decision-table tests for retry-route
     classification covering **every declared classifier input as a dimension**
     (error class × subtype × attempt × retry-cap exhaustion × lifecycle as
     **separate dimensions** — processing status, abort-controller signal, and
     cleaning-up — pinning that with status `processing` an aborted controller
     still permits a redeliverable attempt-zero startup retry while blocking
     transient/provider (:853–858, :898–904, :1010–1015, :1066–1070) ×
     prompt redeliverability × billing-non-resettable ×
     provider family — an exhausted 503 is `PROVIDER_UNAVAILABLE` on
     non-Anthropic/non-GLM providers but `SYSTEM` under Anthropic, :1169–1229 ×
     recoveryState/supersede flags → arm) — e.g. a configured cap of zero, an
     attempt-zero startup timeout with no prompt, and a billing-flavored 429 are
     all pinned rows — incl. the 429-handoff suppression contract (`rateLimitCooldownScheduled`
     ⇒ no `errorManager`/`setIdle`), the teardown-liturgy invariant (what each
     arm clears/closes/re-enqueues/restores), and the unfenced-window map above
     (guard placement pinned as-is, not assumed complete). The existing 3,352-line
     `query-runner.test.ts` (error categorization :2635, transient retry :1879,
     bounded 5xx retry :2143) plus the two startup-gate suites are the parity
     base; PR 1 adds the missing arm-by-arm table.
  2. **PR 2 (additive core):** new `query-retry-routing.ts` pure module +
     `decisionRun` composition, unwired.
  3. **PR 3 (apply):** interpret the core in the catch block; one branch per
     route; arms become interpreters.
  4. **PR 4 (dedup):** collapse the four teardown liturgies into one
     parameterized helper.
  5. **PR 5 (cleanup/ADR note).**
- **Phase 0 primitives:** none — state is in-memory (generation counter,
  recoveryState, timers). The startup gate is the in-memory analog of spawn
  reservation; no DB primitive warranted (single process, children die with the
  daemon).
- **Impact/risk:** three post-import fixes touch the file, two of them squarely
  inside Chain B's scope (#2572 futile startup-retry skip, #2579 startup-timeout
  failure hint; #2564 corrected deferred-permission application, adjacent to the
  same lifecycle but outside the catch classification); ~450
  lines of nested classification become a readable
  table; teardown dedup removes four copies of the most error-prone code in the
  layer. Risk low-moderate: best test coverage in the layer. **Sequence after PR
  #2661 merges** (it edits the terminal cascade region).

### Chain C (propose second, parallel-safe with B after #2661/#2543): sdk-message-handler turn-end & acknowledgement cores

- **Scope:** the turn-end flag machine (:720–755 + :936–973 →
  `setIdle`/`finishTurn`/queue-replay gating), turn-end fallback ack selection
  (:333–392, pure filter :338–345), cost/usage accounting with cost-reset
  detection (:872–889).
  **Explicitly out:** the `stream_event` arm (:603–606) and
  `detectPhaseFromMessage` — per-token hot, stay inline; the universal
  save/publish effects (:702–737) stay shell; **and thinking-token handling**
  (estimate stash :653–663, delta stamping :689–700) — these run for every
  `thinking_tokens` operational message and every assistant chunk with thinking
  on providers emitting incremental updates, so they are hot-path, not
  turn-boundary: keep inline unless separately benchmarked with pinned
  per-chunk behavior.
- **ADR pattern:** `decisionRun` for the flag machine (flags in →
  `{idle_fence, early_set_idle, finish_turn, allow_queue_replay, next_flags}`
  plan out — the legacy direct `setIdle` (:746–750) is a distinct action from
  `finishTurn`'s own `setIdle` (:946), and the doubled transition it creates is
  pinned behavior; the
  core also returns the updated flag state, since the scoped machine mutates it:
  results set `lastResultWasSuccess`; suppressed **successful** results clear
  `suppressIdleOnNextResult` (:936–937 is success-gated at :765–766), so a
  suppressed error result leaves the flag set for the following result — the
  error row retains the flag and PR 1 pins that asymmetry; non-idle
  session-state events set the expectation
  flags and idle events reset them (:739–755, :936–969); alternatively narrow
  the core to action routing with flag mutation explicitly in shell — the
  direct counterpart of
  pilot-4's `classifyTurnCompletion`, closing the gap that the v2 path has a
  core and the dispatch path doesn't); a P6-style pure reducer body for cost
  accounting only (executed sync); plain transform for
  ack selection.
- **PR sketch:**
  1. **PR 1 (pins):** flag-machine truth table (suppress ×
     sessionStateChanged-mode × expectsIdle × lastResultWasSuccess × success/
     error result × **top-level-result bit** — a nested result (non-null
     `parent_tool_use_id`) is saved and published but performs none of the
     idle/flag transitions an identical top-level result performs (:713–753);
     either the bit is a table dimension or the `isTopLevelResult` gate stays in
     the shell × queryMode × current session-state event kind/state (a
     non-idle event only records that an idle event is expected, while an idle
     event calls `finishTurn`, gates replay on `lastResultWasSuccess`, and
     resets all three flags — sdk-message-handler.ts:957–969; alternatively
     leave session-state handling in the shell with the core contract narrowed)
     → {idle / finish / replay} **with `next_flags` asserted on every row** (two
     rows can share immediate actions yet need different next flag state — e.g.
     a non-idle session-state event sets the idle expectation while a suppressed
     result clears `suppressIdleOnNextResult`) — `finishTurn` publishes
     `query.trigger` only outside `manual` mode, sdk-message-handler.ts:943–950,
     so manual sessions with identical flags must not replay deferred messages;
     the queryMode gate may alternatively stay in the shell with the core
     contract narrowed accordingly), incl. the known fragilities as
     characterization (the legacy path's terminal-fence-plus-double-`setIdle`
     sequence, S3 below; stale
     `lastResultWasSuccess` window — pinned, not fixed); ack-selection table
     over (sendStatus × durable ownership × yielded/claimed × pending-in-memory
     — eligibility requires `hasPendingOrClaimed(uuid)` false at
     sdk-message-handler.ts:341–345: a pending message with no durable job stays
     queued for the next turn while an unowned row may be consumed now, so the
     extracted selector needs this bit to avoid premature acknowledgement × active-message
     equality — a durable yielded message is eligible only when its UUID equals
     `activeMessageId`, sdk-message-handler.ts:338–345: the active yielded
     kickoff is consumed while a yielded steer of another turn stays enqueued;
     both outcomes are pinned by sdk-message-handler.test.ts:1327–1398 and
     :1549–1585, so the extracted selector must carry that bit); cost-reset table.
     The explicit-429/text-rate-limit routing pins stay in Chain B's PR 1 (they
     exercise query-runner classification, not this file).
     The 2,915-line suite + `usage-accounting-invariants.test.ts` (seeded-RNG
     invariants) are the parity base.
  2. **PR 2 (additive):** `turn-end-routing.ts` + `usage-accounting.ts` pure
     modules + pipeline composition, unwired.
  3. **PR 3 (apply):** interpret at :720–755/:936–973, :333–392, :872–889.
  4. **PR 4 (cleanup/ADR note).**
- **Phase 0 primitives:** none for race-closing — the ack/consume flips
  (`acknowledgePersistedUserMessage` :265–296 → `consumePersistedUserMessage`
  :298–331, `handleMessageYielded` :512–595) run check→write synchronously in
  the single-process daemon, so an expected-status CAS on `sdk_messages` would
  close no reachable race (retracted on the same run-to-completion grounds as
  the other withdrawn reports). Transactional ownership creation (§4.3) remains
  the Q4 fix where a job insert must accompany a status change.
- **Impact/risk:** targets the recurring ack/idle/duplicate-delivery bug class
  (pre-import ancestors show it since Dec 2025; #2598 in-window). All targets
  are per-turn-boundary (cold) — hot-path rule respected. Risk moderate: the
  flag machine's correctness is emission-order-dependent; pins must capture
  that. **Sequence after #2661 and #2543 merge.**

### Chain A (propose third — biggest ceiling, highest risk): v2 delivery-turn machinery

- **Scope:** `feedDeliverySteer` status ladder (agent-session.ts:1696–1721) and
  handler outcome→action mapping
  (job-handlers/message-delivery.handler.ts:31–189) as `decisionRun` gate sets;
  `deliverMessage`/outbox role arbitration (message-delivery.ts:97–139, outbox
  :52–72) — **wire the already-extracted but dead `resolveDeliveryRole` core**;
  `driveDeliveryTurn` admission cascade (:1338–1497) as `stagedRun` flows
  (effects: `ensureQueryStarted` — a spawned query is an external effect the
  startup gate's in-memory permit cannot unwind or durably deduplicate, so per
  the stagedRun failure contract it needs a reservation/compensation or stays
  outside the staged pass as a shell-preceding step; DB reloads,
  queue admit — idempotent or UNIQUE-guarded, **except** batch narrowing:
  `narrowActiveDeliveryBatchUuids` reads the active batch and updates matching
  queue admit — idempotent or UNIQUE-guarded, **except** batch narrowing:
  `narrowActiveDeliveryBatchUuids` reads the active batch and updates matching
  pending/processing jobs with no claim token or expected-payload predicate, so
  it needs the new primitive below before staging; and queue admission itself —
  `MessageQueue.admitWithId` unconditionally pushes even for an existing UUID,
  so while today's claimGuard→admit span is synchronous, staged async boundaries
  require a claim resnapshot **plus query-identity revalidation** (generation
  and `queryPromise` identity) immediately before `admitWithId` — a restart or
  replacement changes the query without changing the delivery claim, and
  admitting into the replacement queue while returning the old promise/generation
  makes the outer turn race treat the old query's completion as the admitted
  delivery's completion (:1378–1393, :1481–1493; rebuild waiter/observer
  bindings when identity changed) — or a stale attempt
  can enqueue a duplicate or canceled delivery — and since `admitWithId`
  unconditionally appends, the staged effect additionally needs UUID/claim-keyed
  idempotence or an exact-entry compensation, because a retried pass under the
  same still-current claim can otherwise double-admit — **plus a durable
  intent/reservation before admission**, since admission is an external
  side effect under the ADR (:148–153) and a crash or failed compensation after
  `admitWithId` leaves no durable record to deduplicate or reconcile a
  replay);
  `reconcileStrandedDeliveries` stale-submitted sweep (:1977–1997); MessageQueue
  timeout policy (:105–128) as plain transform. Includes removing the
  production-dead module-level `reconcileStrandedDeliveries`
  (message-delivery.ts:207–242) and dead `markMessageSubmissionFailed`
  (sdk-message-handler.ts:466–478).
- **ADR pattern:** mixed — `decisionRun` for the two ladders + role arbitration;
  `stagedRun` (P8) for `driveDeliveryTurn`, with the session lock staying in the
  shell (resource-ownership rule) and effect stages riding the existing
  UNIQUE-index/claim-fence guards (atomicity delegation is already partially
  true here — the index is the arbiter).
- **PR sketch:**
  1. **PR 1 (pins):** pilot-1-style transcript parity harness for
     `driveDeliveryTurn` + `feedDeliverySteer` + the job handler (instrument
     queue admits, DB marks, job mutations per scenario); **call-site
     characterization for role arbitration before PR 3 rewires
     `deliverMessage`/outbox through `resolveDeliveryRole`** — existing role ×
     requested role × UNIQUE outcome × entrypoint, since the two sites
     intentionally differ (`deliverMessage` reuses an active same-UUID role and
     propagates an explicit-role UNIQUE failure, message-delivery.ts:111–137;
     the outbox has no ownership precheck and converts an implicit turn
     collision to steer inside its transaction, outbox :52–72) so the wiring
     cannot silently duplicate a delivery or change rollback behavior; decision
     tables for
     the steer ladder (status × queryPromise × provider type × claim-current ×
     delivery
     validity × queue ownership — provider type is its own gate: with processing,
     live query, current claim, valid delivery, and an already-pending message
     held constant, ACP returns `awaiting_acceptance` while non-ACP proceeds to
     admission; claim currency is its own dimension: the inner
     `claimGuard` (:1699) must return `aborted` before the status ladder when
     the claim was superseded during the lock wait, for every status, while an
     invalid message only parks in the processing branch; queue
     ownership — `hasPendingOrInFlight(messageUuid)` distinguishes
     `awaiting_acceptance` from admitting a fresh feed, agent-session.ts:1701–1715)
     and handler outcomes (preflight gates × delivery-call result × role ×
     sendStatus × park budgets × waiting-for-input. Preflight: **unparseable
     payload → throw (:34–37, before every other check)**; stale claim →
     `stale_attempt`; archived session → fail batch members and settle; missing
     session → throw; missing content → settle as `no_content`
     (message-delivery.handler.ts:31–85) — or these are explicitly retained in
     the shell with the core's scope narrowed to post-preflight routing.
     Delivery-call result — `FeedSteerOutcome`/
     `DriveTurnOutcome`: identical tuples choose different mutations by outcome,
     park→requeue, awaiting_acceptance→requeueParked, promote→requeueAs('turn')
     with UNIQUE fallback, consumed→complete; turn results distinguish
     blocked/aborted/terminated, message-delivery.handler.ts:104–188 — plus role ×
     sendStatus × park budgets × waiting-for-input:
     a submitted steer parks under the ACP acceptance budget while an otherwise
     identical submitted turn settles as skipped — message-delivery.handler.ts:71–84,
     pinned by message-delivery-v2.test.ts:842–871; a waiting session requeues
     plain and bypasses park-budget dead-lettering,
     message-delivery.handler.ts:150–163).
     Existing base:
     `message-delivery-v2.test.ts` (1,400 ln conformance),
     `query-mode-handler.test.ts` (891), `agent-session.test.ts` delivery cases
     (:4985–5069).
  2. **PR 2 (additive cores):** `delivery-turn-routing.ts` (steer ladder +
     handler outcome tables + role-arbitration composition over the existing
     `resolveDeliveryRole`), plus two plain transforms covering the rest of the
     stated scope: `reconciler-sweep.ts` (stale-submitted selection for
     `reconcileStrandedDeliveries`) and `message-queue-timeout-policy.ts` (the
     pending/claimed/yielded×durable timeout decision).
  3. **PR 3 (apply ladders):** interpret at agent-session.ts:1696–1721, handler
     :31–189, message-delivery.ts:97–139 + outbox; wire the sweep at
     agent-session.ts:1977–1997 and the timeout policy at
     message-queue.ts:105–128.
  4. **PR 4 (stagedRun):** `driveDeliveryTurn` admission as a staged
     sub-pipeline; **the turn-end race/rearm loop stays in the shell**, which
     invokes one bounded staged pass per iteration — embedding the repeated
     await/mutate loop in a pipeline would make it recursively own control flow
     (ADR exclusions) — independent of chain C: the loop's decisions already
     ride the pilot-4 `shouldRearmSpuriousTurnEnd`/`classifyTurnCompletion`
     cores, so A's PR 4 needs only the shared idle-transition contract to hold,
     not a Chain C artifact.
  5. **PR 5 (cleanup: dead-code removal, ADR pilot note).**
- **Phase 0 primitives:** for the query-mode-handler write-before-ownership bug
  class, the structural fix is transactional ownership creation — status change
  and job insert committed together (the outbox path's existing shape), or an
  explicit compensating transition on enqueue failure; a bare `send_status`
  CAS/transition table only orders competing writers and leaves the stranded-row
  window open. Staging `driveDeliveryTurn` additionally requires a
  **claim-fenced batch-update primitive** before PR 4, covering two unfenced
  persistent effects: `narrowActiveDeliveryBatchUuids`'s read-then-update (no
  claim token or expected-payload predicate — a superseded handler could mutate
  a batch now owned by a replacement claim across the new async stage
  boundaries), and batch submission marking —
  `markDeliverySubmittedByUuids` selects `enqueued` rows then issues an
  unconditional status update with no claim token or expected status, so a
  superseded claim can mark the replacement's members `submitted` and halt
  before admitting them, leaving rows the handler treats as already submitted.
  **Guarded writes are mandatory, not an alternative to compensation**: per the
  stagedRun contract (ADR :169–177) every persistent write uses an atomic
  primitive carrying its read preconditions, with compensation an additional
  obligation — an unguarded update lets a stale pass mutate replacement-owned
  rows before any unwind, and its compensation can then overwrite newer state.
  Both effects take guarded writes **and** registered compensations —
  and the compensation must cover the **publication**, not just the row:
  `markDeliveryBatchSubmitted` fire-and-forgets a `messages.statusChanged`
  event (:1883–1896), so an unwind that restores rows to `enqueued` without a
  **deferred/transactional-outbox publication or idempotent versioned
  ordering** leaves subscribers believing the members remain submitted — a bare
  inverse notification is *not* sufficient, since the bus runs each publish's
  handlers via `Promise.all` with no ordering between concurrent publishes
  (internal-event-bus.ts:105–150) and a compensation can deliver `enqueued`
  before a slow subscriber finishes the earlier `submitted`. And
  if `ensureQueryStarted` stays inside the staged pass, a query-startup
  reservation/compensation (or durable dedup) is required after all — the
  in-memory startup permit neither compensates an already-spawned query after a
  later stage failure nor deduplicates replay, per the `stagedRun` failure
  contract; otherwise startup remains a shell-preceding step outside the pass.
  The admission block's installed resources — `deliveryResponseObserver` and
  the `waitForIdleTransition` waiter (:1350–1393) — likewise need registered
  cleanup compensations (a stale observer can attribute the replacement turn's
  first response to the failed delivery; the waiter can fire against a later
  idle transition), or their ownership stays in the shell.
- **Impact/risk:** highest ceiling — this is the repo's recurring fix area
  (delivery duplication, deferred-backlog gaps, park-vs-cancel), and ~500 lines
  of cascade become tables. Highest risk: session lock + job queue + four
  writers; **sequence after PR #2543 merges** (no Chain C artifact is a
  prerequisite — §4.2 — but avoid two chains editing the facade simultaneously).
  Partially outside the layer (job-handlers) — flag for orchestrator
  scoping.

**Deferred (not proposed now):** model-switch-handler (collides with ACP 8/10
+57; revisit after it lands — clean single-cascade `decisionRun` candidate with
a rollback asymmetry worth pinning, §7 items M5–M6); ask-user-question-handler
(nice implicit-machine extraction but low fix density; later wave);
rewind-handler (needs locking/guard design work before any extraction —
extraction now would calcify the missing guards).

## 6. Do NOT extract (confirmations + additions)

Confirmed per task: `live-query-handlers.ts` (rpc-handlers, SQL+wiring; perf
task #2660 — now done), `sdk-message-repository.ts` (storage),
`sdk-cli-resolver.ts` / `bash-scope.ts` / `reference-resolver.ts` (stable).

Additions from the survey:

- **Resource owners:** `sdk-startup-gate.ts` (permit/waiter queue),
  `delivery-turn-stall-watchdog.ts` (timer), `message-delivery-metrics.ts` (LRU
  singletons), `message-queue.ts` (queue itself — only its timeout policy is a
  core candidate), `processing-state-manager.ts` (state holder; only
  `detectPhaseFromMessage` :318–362 is extractable), `event-subscription-setup.ts`
  / `session-config-handler.ts` / `sdk-runtime-config.ts` (pure wiring/mutators).
- **Hot path:** sdk-message-handler `stream_event` arm (:596–599) and
  `detectPhaseFromMessage` — per-token, stay inline.
- **Already pure — no pipeline needed:** `fallback-recovery.ts`,
  `context-fetcher.ts` (`toContextInfo`), `reference-context-builder.ts`,
  `transient-error-patterns.ts`, `sdk-transcript-retention.ts`, `query-like.ts`,
  `coordinator/*` (configs; the one merge-precedence decision doesn't meet
  rule-of-three).
- **`builtin-skill-plugin-wrapper.ts`** — sequential filesystem effects, no
  decisions.
- **`context-tracker.ts:40`** — `setModel` is a no-op stub; the four call sites
  in model-switch-handler are dead coordination surface (delete or implement,
  don't extract).

## 7. Bugs / races noticed (report only)

**Query lifecycle:** (Q4)
deferred→enqueued written before durable V2 ownership; an enqueue failure leaves
owner-less `enqueued` rows (query-mode-handler.ts:55–68). (Q7) deferred restart
reason dropped + failure swallowed (query-lifecycle-manager.ts:644–649).
(Q8) deferred-permission TOCTOU (query-runner.ts:373–399). (Q10) process-env
mutated before startup-gate admission; queued session holds mutated env
(query-runner.ts:660 vs :690). (Q12) substring error classification over-matches
("permission"/"Exit code: 1" → PERMISSION, :1224–1229).
(Retractions, each verified against production callers: the Q2 suppressed-waiter
report — keeping waiters alive across a superseded retry is the handoff
contract; the successor's terminal `setIdle` drains them and restart/reset
failure paths call `releaseIdleWaiters()`. The Q6 stale-start report —
`ensureQueryStarted` (query-lifecycle-manager.ts:418–455) detects
running-with-null-promise and force-recovers, while restart/reset stop the
queue before clearing refs, so no production path reaches `start()` in that
state. The Q11 dynamic-cap report — `HYPERNEO_SDK_STARTUP_MAX_CONCURRENT` is
never mutated after startup outside tests, so FIFO permit transfer cannot
bypass a fixed cap. The Q9 429-handoff stranding report — episode generation
advances only via watchdog `cancel()`/`reset()` whose callers install a
replacement owner or normalize lifecycle. The Q3 `emitSdkResumeChoiceMessage`
TOCTOU report — check/save/re-check are await-free. The Q1 startup-timeout race
report — abort wins by breaking at :1542–1544 without yielding; a won frame
drains through microtasks into the timer-clear at :791–795 first.)

**Delivery:** (D1) dead duplicate `reconcileStrandedDeliveries` inlined instead
of using the extracted core (message-delivery.ts:207–242). (D2)
`resolveDeliveryRole` core dead — `deliverMessage` (:97–139) keeps the imperative
try/catch. Its `getActiveDeliveryRole` pre-check is *not* redundant and must be
preserved when wiring the core: the partial UNIQUE index dedupes only active
`turn` jobs per session — not message UUIDs or `steer` jobs — so re-delivering
an already-active UUID without an equivalent same-message ownership lookup would
enqueue a second turn or fall through to a duplicate steer. The check is
synchronous rather than racy, and callers
branch on turn-vs-steer for `setQueuedIfIdle` **and** for a lifecycle-critical
consumer any extraction must preserve: `deliverChatMessage` cancels the
rate-limit watchdog when a new turn is enqueued outside cooldown
(agent-session.ts:1811–1812), preventing a stale scheduled retry from competing
with the new turn owner.
(Retractions: three earlier reports in this space were false positives and are
withdrawn — `withSessionLock`'s abort path cannot leave an unhandled rejection
(lock-tail promises are resolver-only and never reject);
`waitForPendingOrInFlight` chains waiter callbacks rather than clobbering them;
the claim-check→yield span in `messageGenerator` is synchronous under JS
run-to-completion, so the 30s timeout cannot interleave between claim-check and
yield. A fourth, D3's queued-state rejection report, is also withdrawn:
`setQueuedIfIdle` assigns state synchronously and persists before its single
await with persistence errors caught internally, so the only swallowable
rejection is a late `session.updated` publish after state and delivery job
already exist — propagating it would wrongly fail a successful enqueue.)

**Facade/satellites:** (F1) ~~`queryObject.interrupt()` had no timeout~~ —
resolved since the survey basis by #2696: interrupt calls now run under
`withInterruptControlDeadline` (interrupt-handler.ts:117, 2 s default,
env-tunable at :10–17). (F2) rewind runs without session lock /
processing-state guard; races an in-flight turn (rewind-handler.ts:239–274,
:606–645). (F3) diff revert replaces first occurrence only; Write-created files
silently skipped (:374–400). (F4) selective rewind 10k-message window +
`messageIds[0]`-as-checkpoint (:436, :461, :513). (F5) terminal errors
correlated to turns by wall-clock, not uuid (agent-session.ts:1681–1686).
(Retractions: the earlier unbounded-
`recentlyExitedAgentRootPids` report is withdrawn — app.ts:316's ProcessWatchdog
polls `getTrackedAgentRootPidsSplit` every five minutes, which expires the map
(agent-session.ts:2052), so it is retention-bounded in production. The earlier
queued-answer-without-`ensureQueryStarted` report (M4) is likewise withdrawn:
the only production construction (agent-session.ts:339) always supplies the
callback; the gap exists only in test doubles. The earlier Space
reconciler-gate report (F6) is withdrawn too: gated sessions are constructed
with `autoReplayPendingMessages: false` (session-manager.ts:122–145) and the
runtime calls `replayPendingMessagesAfterRuntimeProvisioning` →
`replayPendingMessagesForImmediateMode` only after attaching the runtime MCP
servers (space-runtime-service.ts:787–805, :1473–1483, :1656–1658) — setting
`reconcilerProvisioned` there is the intended gate release, not a bypass.)

**State machines:** (M5)
model-switch TOCTOU: switch racing interrupt can resurrect a stopped query
(model-switch-handler.ts:177–237). (M6) rollback never restarts the query;
thinking-block strip not reverted (:258–300). (Retractions: the earlier M1
orphan-reason report is withdrawn — `rehydrate_failed` is telemetry-only and not
a persisted `QuestionCancelReason` (shared/state-types.ts:85 permits only
`user_cancelled` | `agent_session_terminated`), and the sole production caller
(space-runtime.ts:6161) passes `agent_session_terminated`, so no production
record disagrees with its event. The earlier M2
double-recording report is withdrawn — `resolvedQuestions` is keyed by
toolUseId, so the later `cancelled` write patches the `submitted` entry in place
(ask-user-question-handler.ts:594), exactly what the supersession test pins.
The earlier M3 deny-and-rethrow report is withdrawn — on `setWaitingForInput`
rejection the deny-resolve happens before the promise has been returned to any
caller (:184–192), so the SDK observes only the thrown error. The earlier M7
zombie-card report is withdrawn — a restored `waiting_for_input` card stays
actionable after restart: `handleQuestionResponse`'s resolver-null branch routes
into `deliverQueuedAnswer` (idle → production `ensureQueryStarted` →
`tool_result` injection), cancellation uses the same recovery path, and the
orphan sweep covers session teardown.)

**Dispatch:** (S1, accounting-only) top-level error results skip usage/cost
accounting and session metadata accumulation (sdk-message-handler.ts:765 vs
:872–912); the fallback-ack and `errorClear` skips on error are intentional —
`classifyTurnCompletion` owns error-result retry/terminal handling, and
acking/clearing there could consume retriable work or erase the failure.
(S2) `lastResultWasSuccess` readable stale across turns (reset only on idle
event, :957–973). (S3) a legacy-mode top-level success result fires the
terminal-idle fence (:720–722) and then two `setIdle` transitions for one result
(:746–750 direct, again via `finishTurn` at :936–946) — idempotent today, but
the doubled transition is fragile surface. (S4) `suppressIdleOnNextResult`
single-slot, two consumers (:720–722, :936–938). (S5) queue-yield callback vs
stream handler interleave on shared flags (:314, :534, :667). (S6)
`markMessageAccepted` swallows all errors (:420–423). (S7) `handleMessageYielded`
silent return on unknown uuid (:518–522). (S8) dead
`markMessageSubmissionFailed` (:466–478). (S9) fire-and-forget turn-end context
refresh can publish after teardown (:794).

## Recommendation

Create chain B first (sequence its apply PRs after #2661 merges), chain C in
parallel once #2661/#2543 clear, chain A as the wave-2 capstone after #2543
(its turn-end loop no longer depends on a Chain C artifact — §4.2 — so A can
start once #2543 lands and the facade is free of another chain's in-flight
edits). Add `output-limiter-hook.ts` to the policy-core pilot series. Hold
model-switch/rewind/question-handler extractions until ACP 8/10 settles (#2548
part 2 has landed as #2696).
