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
first check (:1060); the message-not-found arm consumes the one-shot resume
pointer (:970) before any check; and every arm's awaited `setIdle`
(:906, :1024) precedes its first guard (:908, :1060) — so a replacement landing
inside those windows can have its state mutated by the stale arm. The 5xx arm is
the fenced one: its revalidation gate (:1127–1138) sits immediately before the
re-enqueue (:1140).

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
query-options-builder.ts:906–923). `interrupt-handler.ts` (175) — linear
teardown procedure. `rewind-handler.ts` (667) — mode cascade + diff revert, **no
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
Dependencies of 8/10 are mid-flight: splits 1 and 7 merged (#2689, #2687);
splits 2 (#2698 open), 5 (#2688 merged), 6 (#2699 open), plus 3, 4, 9, 10 still
open.

Other live collisions (all must land or stall before the corresponding chain's
apply PRs):

- **PR #2661 (open)** — limit-error pipeline: touches `query-runner.ts`,
  `sdk-message-handler.ts`, `agent-session.ts`, `fallback-recovery.ts`; adds
  `limit-error-classifier.ts`. Collides with chains B and C.
- **PR #2543 (open)** — Codex-findings triage: touches `agent-session.ts`,
  `message-delivery.ts`, `sdk-message-handler.ts`,
  `job-handlers/message-delivery.handler.ts`. Collides with chains B (lightly)
  and C.
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
   these semantics explicit as a core; chain A's turn-end-loop extraction
   consumes that core ⇒ C before A's loop PRs.
3. **`sdk_messages.send_status` writes are unguarded check-then-act across all
   three flows** (query-mode-handler.ts:55, sdk-message-handler ack/consume
   paths, agent-session reopen :1937–1951). Groundwork here needs more than a
   status CAS: an expected-status CAS only orders competing status writers — it
   does not make the status change and the delivery-job creation atomic, so an
   enqueue failure after `deferred→enqueued` still strands an owner-less row. The
   fix shape is transactional ownership creation (status change + job insert in
   one transaction, as `persistAndEnqueueDelivery` already does) or an explicit
   compensating transition; a CAS/transition table on `sdk-message-repository`
   complements that but cannot replace it.
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
  `classifyRetryRoute(error class, subtype, retryAttempt, recoveryState,
  generation flags) → startup_timeout_retry | message_not_found_retry |
  transient_retry | provider_backoff(5xx) | rate_limit_handoff |
  terminal(category)` — interpreted by thin shell arms. Routing note the table
  must preserve: explicit HTTP-429 errors do not enter the provider-backoff arm
  (`isRetryableProviderError` excludes all `\b4\d{2}\b` matches); they fall
  through to the terminal cascade where `looksLikeRateLimit429` (:92) routes them
  to the watchdog handoff (:1234–1245) — only text-form rate-limit errors without
  a 4xx status code can reach the backoff arm via
  `RETRYABLE_PROVIDER_ERROR_TEXT`. The backoff arm's
  sleep→revalidate→re-enqueue→recurse (:1066–1151) is a `stagedRun` candidate
  (async stages: sleep, re-check, re-enqueue) but sync-core-first per Decision
  item 5; the existing generation guards inform the resnapshot stage but must not
  be presented as complete fencing — PR 1 pins the unfenced windows (transient
  arm :1024–1034 ahead of :1060; message-not-found :970; every arm's awaited
  `setIdle` ahead of its first guard) as characterization, and tightening them is
  a behavior change deliberately left out of the refactor. Teardown dedup is
  plain helper extraction, not a pipeline.
- **PR sketch:**
  1. **PR 1 (test-only pins):** decision-table tests for retry-route
     classification (error class × attempt × recoveryState × supersede flags →
     arm), incl. the 429-handoff suppression contract (`rateLimitCooldownScheduled`
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
- **Impact/risk:** top in-window fix density (3 fixes / 5 days; #2572, #2579,
  #2549 pre-import); ~450 lines of nested classification become a readable
  table; teardown dedup removes four copies of the most error-prone code in the
  layer. Risk low-moderate: best test coverage in the layer. **Sequence after PR
  #2661 merges** (it edits the terminal cascade region).

### Chain C (propose second, parallel-safe with B after #2661/#2543): sdk-message-handler turn-end & acknowledgement cores

- **Scope:** the turn-end flag machine (:720–755 + :936–973 →
  `setIdle`/`finishTurn`/queue-replay gating), turn-end fallback ack selection
  (:333–392, pure filter :338–345), cost/usage accounting with cost-reset
  detection (:872–889), thinking-token delta stamping (:653–663 + :689–700).
  **Explicitly out:** the `stream_event` arm (:603–606) and
  `detectPhaseFromMessage` — per-token hot, stay inline; the universal
  save/publish effects (:702–737) stay shell.
- **ADR pattern:** `decisionRun` for the flag machine (flags in → `{idle_fence,
  finish_turn, allow_queue_replay}` plan out — the direct counterpart of
  pilot-4's `classifyTurnCompletion`, closing the gap that the v2 path has a
  core and the dispatch path doesn't); P6-style pure reducer bodies for cost
  accounting and thinking-delta stamping (executed sync); plain transform for
  ack selection.
- **PR sketch:**
  1. **PR 1 (pins):** flag-machine truth table (suppress ×
     sessionStateChanged-mode × expectsIdle × lastResultWasSuccess × success/
     error result → idle/finish/replay), incl. the known fragilities as
     characterization (the legacy path's terminal-fence-plus-double-`setIdle`
     sequence, S3 below; stale
     `lastResultWasSuccess` window — pinned, not fixed); ack-selection table
     over (sendStatus × durable ownership × yielded/claimed); cost-reset table;
     the explicit-429-vs-text-rate-limit routing split from Chain B's note.
     The 2,915-line suite + `usage-accounting-invariants.test.ts` (seeded-RNG
     invariants) are the parity base.
  2. **PR 2 (additive):** `turn-end-routing.ts` + `usage-accounting.ts` pure
     modules + pipeline composition, unwired.
  3. **PR 3 (apply):** interpret at :720–755/:936–973, :333–392, :872–889.
  4. **PR 4 (cleanup/ADR note);** optional separate Phase-0-style PR: expected-
     status CAS on `sdk_messages.send_status` with its own characterization pins
     (product-behavior change — racy flips become superseded outcomes).
- **Phase 0 primitives:** direct analog applies to the ack/consume flips
  (`acknowledgePersistedUserMessage` :265–296, `consumePersistedUserMessage`
  :298–331, `handleMessageYielded` :512–595): expected-status CAS on
  `sdk_messages`. Not the space primitives themselves — a new small primitive on
  `sdk-message-repository`; per §4.3, pair it with transactional ownership
  creation where a job insert must accompany the status change.
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
  `driveDeliveryTurn` admission cascade (:1338–1497) and turn-end race loop
  (:1553–1614) as `stagedRun` flows (effects: `ensureQueryStarted`, DB reloads,
  queue admit — each already idempotent or UNIQUE-guarded);
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
     queue admits, DB marks, job mutations per scenario); decision tables for
     the steer ladder (status × queryPromise × provider × validity →
     feed/park/promote/awaiting_acceptance) and handler outcomes
     (skip/park/requeue/requeueAs/settle × park budgets). Existing base:
     `message-delivery-v2.test.ts` (1,400 ln conformance),
     `query-mode-handler.test.ts` (891), `agent-session.test.ts` delivery cases
     (:4985–5069).
  2. **PR 2 (additive cores):** `delivery-turn-routing.ts` (steer ladder +
     handler outcome tables + role-arbitration composition over the existing
     `resolveDeliveryRole`).
  3. **PR 3 (apply ladders):** interpret at agent-session.ts:1696–1721, handler
     :31–189, message-delivery.ts:97–139 + outbox.
  4. **PR 4 (stagedRun):** `driveDeliveryTurn` admission + turn-end loop as
     staged sub-pipelines, consuming chain C's turn-end core.
  5. **PR 5 (cleanup: dead-code removal, ADR pilot note).**
- **Phase 0 primitives:** for the query-mode-handler write-before-ownership bug
  class, the structural fix is transactional ownership creation — status change
  and job insert committed together (the outbox path's existing shape), or an
  explicit compensating transition on enqueue failure; a bare `send_status`
  CAS/transition table only orders competing writers and leaves the stranded-row
  window open. Spawn reservation has no analog need here (in-memory startup gate
  suffices).
- **Impact/risk:** highest ceiling — this is the repo's recurring fix area
  (delivery duplication, deferred-backlog gaps, park-vs-cancel), and ~500 lines
  of cascade become tables. Highest risk: session lock + job queue + four
  writers; **sequence after PR #2543 merges and after chain C lands** (coupling
  §4.2). Partially outside the layer (job-handlers) — flag for orchestrator
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

**Query lifecycle:** (Q1) startup-timeout vs first-message race — timer abort
can throw after a frame arrived; message dropped (query-runner.ts:742–770 vs
:783–786). (Q2) superseded-retry exits abandon suppressed idle waiters
(:906–908, :978, :1024). (Retraction: the earlier `emitSdkResumeChoiceMessage`
TOCTOU report is withdrawn — its unresolved-check (:370), synchronous save
(:383), and re-check (:385–390) contain no await, so two invocations cannot
interleave in the single-process daemon.) (Q4)
deferred→enqueued written before durable V2 ownership; failure leaves owner-less
`enqueued` rows (query-mode-handler.ts:55–68); legacy path's stale `v2Owned`
snapshot can double-enqueue (:78–86). (Q6) `QueryRunner.start` silently
no-ops on stale running-with-null-promise state (:341–348). (Q7) deferred
restart reason dropped + failure swallowed (query-lifecycle-manager.ts:644–649).
(Q8) deferred-permission TOCTOU (query-runner.ts:373–399). (Q9) 429-handoff can
strand: superseded episode + skipped terminal path ⇒ no retry, no idle
(:1240–1242 + query-lifecycle-manager.ts:503–512). (Q10) process-env mutated
before startup-gate admission; queued session holds mutated env
(query-runner.ts:660 vs :690). (Q11) startup-gate cap re-read per call; release
bypasses cap re-check (sdk-startup-gate.ts:43–53, :102–107). (Q12) substring
error classification over-matches ("permission"/"Exit code: 1" → PERMISSION,
:1224–1229).

**Delivery:** (D1) dead duplicate `reconcileStrandedDeliveries` inlined instead
of using the extracted core (message-delivery.ts:207–242). (D2)
`resolveDeliveryRole` core dead — `deliverMessage` (:97–139) keeps the imperative
try/catch; its `getActiveDeliveryRole` pre-check is redundant with the UNIQUE
constraint rather than racy (check and enqueue are both synchronous), and callers
today only branch on turn-vs-steer for `setQueuedIfIdle`. (D3)
`deliverBatchAndMarkQueued`
swallows `setQueuedIfIdle` failure (message-delivery.ts:194–198).
(Retraction: three earlier reports in this space were false positives and are
withdrawn — `withSessionLock`'s abort path cannot leave an unhandled rejection
(lock-tail promises are resolver-only and never reject); 
`waitForPendingOrInFlight` chains waiter callbacks rather than clobbering them;
the claim-check→yield span in `messageGenerator` is synchronous under JS
run-to-completion, so the 30s timeout cannot interleave between claim-check and
yield.)

**Facade/satellites:** (F1) ~~`queryObject.interrupt()` had no timeout~~ —
resolved since the survey basis by #2696: interrupt calls now run under
`withInterruptControlDeadline` (interrupt-handler.ts:117, 2 s default,
env-tunable at :10–17). (F2) rewind runs without session lock /
processing-state guard; races an in-flight turn (rewind-handler.ts:239–274,
:606–645). (F3) diff revert replaces first occurrence only; Write-created files
silently skipped (:374–400). (F4) selective rewind 10k-message window +
`messageIds[0]`-as-checkpoint (:436, :461, :513). (F5) terminal errors
correlated to turns by wall-clock, not uuid (agent-session.ts:1681–1686). (F6)
`replayPendingMessagesForImmediateMode` force-enables the periodic reconciler
even for Space-gated sessions (:658). (Retraction: the earlier unbounded-
`recentlyExitedAgentRootPids` report is withdrawn — app.ts:316's ProcessWatchdog
polls `getTrackedAgentRootPidsSplit` every five minutes, which expires the map
(agent-session.ts:2052), so it is retention-bounded in production. The earlier
queued-answer-without-`ensureQueryStarted` report (M4) is likewise withdrawn:
the only production construction (agent-session.ts:339) always supplies the
callback; the gap exists only in test doubles.)

**State machines:** (M1) orphan records hardcode
`cancelReason:'agent_session_terminated'` while the event carries the real
reason (ask-user-question-handler.ts:454–477 — pinned by test). (M2) superseded
submit double-recorded submitted→cancelled (:303 vs :323). (M3)
`setWaitingForInput` throw ⇒ deny **and** rethrow to SDK (:184–195). (M5)
model-switch TOCTOU: switch racing interrupt can resurrect a stopped query
(model-switch-handler.ts:177–237). (M6) rollback never restarts the query;
thinking-block strip not reverted (:258–300). (M7) `waiting_for_input` restored
verbatim across restarts ⇒ zombie cards; recovery scattered
(processing-state-manager.ts:105–106). (M8) `persistToDatabase` swallows errors
— silent divergence (:116–125).

**Dispatch:** (S1) `handleResultMessage` success-only — error results skip
fallback ack + errorClear + accounting (sdk-message-handler.ts:765, :927–930).
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
parallel once #2661/#2543 clear, chain A as the wave-2 capstone after C and
#2543. Add `output-limiter-hook.ts` to the policy-core pilot series. Hold
model-switch/rewind/question-handler extractions until ACP 8/10 settles (#2548
part 2 has landed as #2696).
