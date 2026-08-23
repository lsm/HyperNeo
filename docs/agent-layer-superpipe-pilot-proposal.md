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
replacement-installed environment — and **a stale-write guard alone is
insufficient**: the old attempt snapshots its restore map before the import,
while a replacement running `applyEnvVarsToProcessForSession` during that await
saves the old attempt's provider values as its own baseline; a guard that then
skips the stale restore leaves the replacement later restoring those stale
values instead of the daemon's originals. Provider-environment ownership must
be serialized across replacements (no apply until the prior restoration
completes) or made generation-scoped/stacked — and **daemon-wide, not
per-session**: `process.env` is process-global, the mutation happens before
startup-gate admission (:641–661 vs :686–701), and the gate permits multiple
concurrent sessions by default, so two overlapping sessions corrupt each other
regardless of generations (A applies, B snapshots A while applying B, A
restores the daemon baseline, B then restores "A" — leaving provider A's
credentials in `process.env`); the remedy is **daemon-wide serialization of
the entire environment-dependent window — credential reads through
apply through spawn/use — or
eliminating the shared mutation** (per-session env passed to the spawn rather
than `process.env`). Stack/restore ownership alone is *not* an acceptable
alternative: a session applies its environment at :641–661 but spawns only
after gate admission at :686–713, so another session can interpose its
environment in between and the first session launches with the wrong
credentials even when every restore later unwinds perfectly — which is
serialization across the whole apply-to-use span by another name — though for
the QueryRunner path the critical section can **end at the env copy**: the
runner copies provider values into `queryOptions.env` (`:664–671`) and
`defaultSpawn` passes `opts.env` straight to `nodeSpawn` (`:41–47`), so once
the copy is made later global mutations cannot change that subprocess — the
lease covers ambient reads, apply, copy, and restore, then releases **before
startup-gate waiting** rather than for the query's lifetime (holding through
"use" would serialize every session and coordinated auth/model request
indefinitely) — and the early restore **atomically clears or transfers the
snapshot**, neutralizing the finalizer's later backstop: both runners'
finalizers otherwise restore `ctx.originalEnvVars` again
(query-runner `:1321–1328`, acp `:760–764`), and with another session owning
the environment by then that second restore overwrites its credentials
outside the lease; direct SDK paths that do not snapshot an env (GitHub spawns,
model loading) take a bounded lease around their call or an isolated
environment. The window
moreover **begins before the apply**: the auth gate reads ambient credentials
at :492 and `optionsBuilder.build()` copies `CLAUDE_CODE_OAUTH_TOKEN` at
query-options-builder.ts:781–783, both ahead of the mutation at :660 where a
lease would naturally start — so a runner starting under another owner's
applied environment copies that owner's token, and
`refreshQueryEnvFromProcess(... preserveAnthropicOAuthToken: true)` retains it
after the owner restores; ownership is acquired before the auth/options reads
or those reads stop being ambient — and the **ACP runner has its own
pre-apply snapshot**: `preCleanupAuth` captures `ANTHROPIC_AUTH_TOKEN` and
`CLAUDE_CODE_OAUTH_TOKEN` at acp-query-runner.ts:451–454 *before* the apply at
`:456`, then injects them into the subprocess environment at `:532–536`, so
the ACP process can launch with another session's credentials despite a
serialized apply/restore; the ACP lease begins before `:451` or stops reading
ambient auth there — and **before the provider auth gate itself**: the
availability/auth awaits at `:416–417` run before even the pre-`:440` lease,
and a replacement starting during them has the stale run call
`errorManager.handleError()` in the unavailable-provider branch
(`:422–429`), publishing an authentication error/reset into the
replacement — ACP ownership is acquired before the auth gate, or lifecycle
is revalidated after every pre-lease await with the owner propagated
through the error helper, with a replacement-during-auth-check pin — and
**before `optionsBuilder.build()` at `:440`**: the
non-Anthropic branch copies ambient provider credentials and routing values
(query-options-builder.ts:785–809), and the later
`refreshQueryEnvFromProcess(... omitProviderManagedPreserveAuth: true)` at
`:522–526` preserves the captured auth, so a lease starting at `:451` still
captures another owner's values during options building; ACP ownership
precedes `build()` or that build stops reading ambient credentials.
The coordinator must also be **reentrancy-safe — conditionally, per lease
lifetime**: under the required copy-and-restore boundary the lease is already
released before startup-gate admission, so no recursive arm can hold it and
nothing extra is owed; if a deliberately longer-lived or reentrant lease is
ever chosen instead, the
startup-timeout, message-not-found, and transient arms recurse at `:967`,
`:1007`, and `:1063` *without* restoring the environment — the outer attempt's
`finally` cannot release the daemon-wide lease while the nested attempt must
acquire it before its credential reads, a self-deadlock (the provider-5xx arm
already restores at `:1116–1123` before recursing), and under that design the
other recursive arms release/transfer ownership before recursion (pinned
ordering). Ambient credential **readers** join the
coordination too: `AnthropicProvider.isAvailable()` reads `process.env`
directly (anthropic-provider.ts:99–110) and is called outside any ownership
boundary (auth-handlers.ts:73–86, provider-handlers.ts:187–208,
model-service.ts:183–188), so while a non-Anthropic session holds the window
those calls can report Anthropic authenticated on another provider's temporary
token — or unavailable while its baseline is cleared; **`AuthManager` is a
separate reader path of the same kind**: `EnvManager.getApiKey()`/
`getOAuthToken()` read the same temporary `process.env` values
(env-manager.ts:4–14), and `auth.status`, `system.config`, and global state
projection call `getAuthStatus()` through them (auth-handlers.ts:55–57,
system-handlers.ts:71–81, state-projection-service.ts:302–314), so a
non-Anthropic window can report authentication via that session's injected
`ANTHROPIC_AUTH_TOKEN`; ambient provider-auth
readers acquire the same lease or read an immutable daemon baseline — with
**reentrancy made explicit**: a QueryRunner already holds the lease before its
auth gate yet then calls the enrolled `provider.isAvailable()`/
`getAuthStatus()` readers during startup, so a non-reentrant mutex deadlocks
on its own lease; the lease propagates current ownership into enrolled
readers (or supports reentrancy, or in-owner-window reads use the immutable
baseline), with a startup pin — all
owner and reader enrollments, `AuthManager`/`EnvManager` and the **logout
reader** included, are
scheduled in the dedicated **Prerequisite PR 0** in the Recommendation, since
no chain PR delivers it — the logout reader is
`ProviderCredentialManager.hasEnvironmentCredentials()`
(credentials/provider-credential-manager.ts:77–80), which `auth.logout`'s
environment-managed early return consumes (auth-handlers.ts:182–189): during a
foreign lease it sees the temporary key, deletes the stored credential, yet
skips the in-memory clear and `providers.changed` notification (`:228–231`),
leaving the user authenticated after the lease restores despite the logout.
— and
**the coordinator must live at the shared `ProviderService` boundary, not in
QueryRunner**: the same global environment has other concurrent owners —
`acp-query-runner.ts:456` (`applyEnvVarsToProcessForSession`) and
`evolution-conversation-analysis-service.ts:287`,
`evolution-episode-service.ts:752`, `llm-workflow-selector.ts:48`,
`session-lifecycle.ts:934` (`applyEnvVarsToProcessForProvider`) — so a
QueryRunner-scoped coordinator still lets any of these snapshot or restore
another owner's values; the mechanism is enforced in `ProviderService` itself
(or every caller is explicitly migrated) — and **one owner bypasses
ProviderService entirely**: `AnthropicProvider.loadModelsFromSdk` mutates the
same `process.env` directly (`applyEnvVarsForSdk`, anthropic-provider.ts:145)
and holds the mutation across the awaited `supportedModels()` until
restoration (:172), reached via `model-service.ts:187` and
`provider-handlers.ts:435,476`; model enumeration concurrent with a session
query can therefore snapshot/restore another owner's values despite a
ProviderService coordinator — this direct owner joins the coordinator or
eliminates its shared mutation too — and **two more production spawns mutate
the environment directly and partially**: `github/security-agent.ts:162–183`
and `github/router-agent.ts:202–223` replace only `ANTHROPIC_API_KEY` /
`CLAUDE_CODE_OAUTH_TOKEN` (restored in `finally`) without clearing the active
session's `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, or model variables, so
a GitHub inference running while a provider session owns `process.env` spawns
its SDK subprocess against the session's endpoint or credentials; both paths
join the coordinator or use an isolated subprocess environment. The common finalizer shares the flaw at the
largest scale: it snapshots staleness once at :1295, then can await the
provider-service import and `setIdle` before clearing shared environment state,
consumed-message state, and `ctx.queryPromise` at :1321–1338 — a replacement
starting after that snapshot can have its environment restored/erased and its
live query promise nulled by the stale finalizer, so the window joins the pins
and shared mutations require generation/identity revalidation after the
finalizer's awaits — **and its trailing `setIdle` (:1331–1332) is gated on a
full route-appropriate lifecycle check, not identity alone**: an interrupt sets
processing to `interrupted` and clears the abort controller *without* a
generation bump (interrupt-handler.ts:105, :152–155), so identity guards pass
and the finalizer could publish an idle transition while interruption is still
cancelling SDK work. The
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
  query-runner code, so **Chain B's PRs 1–4 are not blocked** by this PR (they
  sequence only behind #2661) — but Chain B **PR 5 edits
  `acp-query-runner.ts`** and therefore sequences after (or explicitly
  coordinates with) ACP split 8/10, which owns that file.
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
   compensating transition. An expected-status CAS is *not* blanket groundwork:
   the ack/consume paths run check→write synchronously in the
   single-process daemon (`consumePersistedUserMessage` commits its
   `updateMessageStatus` before its first await, sdk-message-handler.ts:302–306;
   `handleMessageYielded` is synchronous through its update, :520–526) — but the
   turn-end fallback-ack **loop** has inter-row awaits:
   `acknowledgeOldestQueuedUserOnTurnEnd` snapshots all eligible rows
   (:338–345), then awaits `messages.statusChanged` between consuming
   successive rows (:370–374), so a later selected UUID can acquire new durable
   or in-memory ownership during that await and still be marked consumed,
   letting the new delivery be skipped without reaching the SDK. Chain C's
   groundwork therefore requires eligibility/ownership revalidation (ideally an
   atomic guarded transition) immediately before each acknowledgement in the
   loop.
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
  cascade (:840–1291) **plus the common finalizer's post-await guards
  (:1292–1340)** — the finalizer window is an apply obligation, not just a pin,
  so its generation/identity revalidation after the provider-service import and
  `setIdle` awaits is in scope; the four-copy teardown liturgy (:912–934, :972–1002,
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
  (:1240–1289) — **after a full lifecycle resnapshot** (generation plus
  cleaning-up/processing-status/abort-signal, matching the adjacent validation
  and terminal routes): the handoff effect awaits
  (e.g. its no-prompt path awaits `setIdle`), so a replacement may have taken
  the session — or teardown begun without a generation bump — by the time
  `declined` returns (scheduleRetry can return false at
  rate-limit-watchdog.ts:197–203 after its own awaits), and a stale result must
  route to
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
  and like the declined handoff, the route takes a **post-display full
  lifecycle resnapshot** (generation plus cleaning-up/processing-status/
  abort-signal — cleanup can begin without a generation bump, § above): the
  display is awaited (`:1161–1165`), so a replacement may
  hold the session or teardown may be underway by the time `setIdle()` runs,
  and a stale post-display
  result routes to superseded/no-op **which cancels its owned terminal-idle
  fence** — `beginTerminalIdle()` has already incremented both counters
  (processing-state-manager.ts:86–90) and only a later `setIdle()` consumes
  them (:143–175), so a no-op that merely skips the trailing idle leaks the
  fence and leaves `terminalIdleInFlight` misleading
  `reclaimTurnAlreadySucceeded` (agent-session.ts:1833–1845, consuming
  `classifyReclaimTermination` from message-delivery.ts:246–255) until some
  successor happens to
  idle; the stale branch cancels its fence (or the fence is generation-scoped)
  rather than just skipping the idle —
  before idling the replacement; the same fence-unwind applies to the terminal
  route's post-`errorManager` stale branch — and the unwind also covers the
  **thrown-effect path**: if `displayErrorAsAssistantMessage` or
  `errorManager.handleError` rejects after `beginTerminalIdle()`, execution
  never reaches either stale branch, and if the guarded finalizer then skips
  its `setIdle()` both fence counters stay leaked with reclaim still reporting
  the turn live; fence cleanup is required in the thrown-effect/`finally`
  route, not only on successful stale results — and the **ACP runner shares
  the leak**: `acp-query-runner.ts:906` calls `beginTerminalIdle()`, awaits
  `errorManager.handleError()` through `:920`, and its finalizer calls
  `setIdle()` only under the non-stale guard (`:736–767`), so a replacement
  during that await does **not leak the fence** — `handleRunError` awaits
  `handleError` (:907–920) and then calls `setIdle()` unconditionally
  (:921) — **but a stale unconditional consume is itself harmful**: it writes
  the shared state to idle and drains the *replacement's* current idle
  waiters (processing-state-manager.ts:143–175), so the successor can be
  reported complete while still running. The ACP terminal path therefore
  takes a **post-effect generation/lifecycle resnapshot** before `:921`:
  when ownership changed it cancels the owned fence instead of idling — and
  **ownership stays guarded throughout `setIdle` itself**: the manager writes
  the shared idle state synchronously then awaits the `session.updated`
  publish (processing-state-manager.ts:156), and its `finally` clears *every*
  waiter (`:168–175`), including successor waiters installed during that
  await — so a replacement starting between the resnapshot and the publish is
  still drained by the stale call; the state transition and waiter drain are
  generation/owner-scoped, with a replacement-during-publish interleaving
  pinned;
  the **rejection interleaving** remains the leak case — a `handleError`
  throw propagates past `:921` to the stale-gated finalizer backstop
  (:736, :766–767), which skips, leaving the ACP-owned fence
  live; the ACP terminal path uses the same owned-fence
  cancellation primitive for its rejection interleaving;
  folding it into `terminal(category)` would replace the actionable validation
  text with generic category handling |
  terminal(category, message_hint) — the category alone does not determine the
  user message: :1247–1269 selects tailored text per variant (an exhausted
  startup timeout and an ordinary timeout are both `TIMEOUT`, but only the
  former gets startup-specific guidance), so the route carries the hint/subtype
  and the decision table asserts it instead of the interpreter re-deriving it —
  **with a post-effect lifecycle resnapshot — and the owner propagates into
  the helper**: `broadcastError()` awaits `updateApiConnectionStatus()`
  before publishing `session.error` (error-manager.ts:436–450), so the old
  terminal route publishes its reset/error state after the replacement has
  taken over but before the caller's post-effect check runs; the owner is
  passed into `errorManager` and revalidated before its post-await
  publication. `errorManager.handleError` is
  awaited (:1271–1285) before the common `setIdle` (:1289), so a replacement or
  cleanup can take ownership during that effect, and a stale result routes to
  no-op before the trailing idle, symmetric with the api-validation and
  declined-handoff routes` —
  interpreted by thin shell arms. Routing note the table
  must preserve: rate-limit errors — explicit HTTP-429 **and** text-form — do
  not enter the provider-backoff arm: `isRetryableProviderError` excludes all
  `\b4\d{2}\b` matches, and text-only "rate limit" errors fail it too because
  `RETRYABLE_PROVIDER_ERROR_TEXT` is built from taxonomy entries that supply
  `looseTextSubstrings`, which the generic rate-limit entry does not. They reach
  the watchdog handoff only when the **terminal cascade's own precedence**
  selects RATE_LIMIT: provider-auth and provider-unavailable checks run *before*
  the rate-limit branch (:1175–1218), so a mixed message like
  `429 service unavailable` on a non-Anthropic provider classifies
  PROVIDER_UNAVAILABLE, not a handoff — the classifier must derive its route
  from that complete category cascade (or be handed the precomputed category)
  rather than from an isolated rate-limit test. Both route
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
  otherwise duplicate the notice — and its **failure is deliberately
  non-fatal**: production wraps the call in try/catch (:1090–1096), so a DB or
  publish failure still lets teardown, backoff, re-enqueue, and recursion
  proceed; the staged effect must normalize that failure internally (or stay in
  the shell) rather than fail the pass under the stage-failure contract — and
  since the notice's publication (`state.sdkMessages.delta`) is already
  emitted when the row saves, staging it additionally demands a commit-time
  outbox or an ordered inverse update event in its compensation (unwinding
  only the row leaves connected clients displaying a notice the DB no longer
  has) — and the inverse-event option is **not implementable against the
  current channel contract**: `SDKMessagesUpdate` defines only `added`
  (shared/state-types.ts:173–176) and `mergeSDKMessagesDelta` merges only
  `typedDelta.added` (web/src/lib/state.ts:48–54), so a removal/update
  published on `state.sdkMessages.delta` is silently dropped by clients;
  choosing that option requires extending and testing the channel contract
  and client merge for removal first, otherwise the valid implementation is
  the commit-time outbox; keeping the non-fatal notice entirely outside the staged pass avoids
  both obligations and is the preferred shape — but **publication must also be
  gated on the save result**: `saveSDKMessage` catches database errors and
  returns `false` (sdk-message-repository.ts:594–597) while
  `displayErrorAsAssistantMessage` ignores that result and still emits the
  delta (:1637–1643), so clients can receive a notice that never existed in
  the DB — the save result is checked and publication suppressed (or
  atomically outboxed), and the returned-false path is pinned.
  and the **prompt re-enqueue** at
  `messageQueue.enqueueWithId` (:1145) is likewise an external session
  injection with unconditional insertion: it needs a conditional durable
  reservation plus idempotence or exact compensation, or it too stays in the
  shell, since replay after a later-stage failure can re-append the consumed
  prompt and a crash leaves no reconciliation record — and the effect must
  **not await the enqueue promise**: that promise is the *consumption*
  acknowledgement, not insertion completion, and production detaches it before
  recursing into `runQuery` whose new generator does the consuming; an awaited
  stage would block on a consumer that has not started and time out every
  retry. The admission effect is synchronous insertion with a detached/stored
  acknowledgement (or shell-retained), and pins record that recursion begins
  without awaiting consumption — **with the detached acknowledgement owned**:
  the promise rejects when the entry is cleared, times out, or rejected before
  consumption (message-queue.ts:95–128, :141–155), and production attaches
  `.catch(() => {})` at `:1145`; the admission stage attaches a rejection
  handler or transfers the promise to a defined owner, and the rejection path
  is pinned alongside the non-await ordering — discarding the detached promise
  is an unhandled rejection; the existing generation guards inform the resnapshot stage but must not
  be presented as complete fencing — PR 1 pins the unfenced windows (transient
  arm :1024–1034 ahead of :1060; every arm's awaited `setIdle` ahead of its
  first guard; the message-not-found pointer consumption at :970 is *not* one —
  the stale-generation return at :849–851 reaches it with no intervening await)
  as characterization — **and closing the reachable ones is an explicit
  apply-PR requirement**: the apply arms add a **full lifecycle resnapshot**
  (generation **and** cleaning-up/processing-status/abort-signal —
  `QueryLifecycleManager.cleanup()` sets the cleanup flag and enters `stop()`
  *without* incrementing the query generation, query-lifecycle-manager.ts:652–663,
  :180–243, so a generation-only check can pass while teardown is in progress —
  and **queue-running state** joins the resnapshot: the queue is stopped at
  :188 before any generation bump, and the provider-backoff revalidation
  itself cancels when `messageQueue.isRunning()` is false (:1127–1133), so a
  backoff sleep can finish mid-teardown with every other field still current —
  but the predicates are **route-specific, not a blanket gate**: a legitimate
  startup timeout has already aborted its own controller (:766–768) and stopped
  its own queue (:833–835), and its arm deliberately restarts that queue
  (:936–942), so abort/queue-running values that are *expected* for the route
  must not cancel it; each arm validates the fields it does not itself set)
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
     route — and add the finalizer's post-await generation/identity guards
     (:1292–1340) here, so the pinned window is actually closed in production;
     route; arms become interpreters.
  4. **PR 4 (dedup):** collapse the four teardown liturgies into one
     parameterized helper.
  5. **PR 5 (fence & idle-transition ownership):** implements the
     owned-terminal-fence cancellation and owner-scoped idle machinery this
     proposal requires but no earlier PR touches — the stale-route fence
     cancels (query-runner terminal/validation/handoff routes), the ACP
     terminal path takes its post-effect resnapshot and fence-cancel before
     `setIdle` (acp-query-runner.ts:921) **and a full lifecycle resnapshot
     before `beginTerminalIdle` at `:906`** — the fence immediately fires
     every current waiter's `onEnd` and can persist a turn-end marker for the
     replacement, which a later cancel cannot undo, so the resnapshot (or an
     owner-scoped `beginTerminalIdle` that filters whose waiters it fires)
     precedes the fence, with replacement/cleanup during the rate-limit
     handoff await (`:893–895`) pinned — and the **cooldown state write
     inside the handoff is fenced too**: `scheduleCooldown` awaits
     `setRateLimitCooldown()` at rate-limit-watchdog.ts:233–237 *before*
     checking its episode generation (`:239`), so a stale handoff can mark
     the replacement as in cooldown even though PR 5 later detects
     staleness; query/turn ownership is revalidated immediately before that
     state write (or the cooldown transition is owner-scoped), with a
     replacement-during-fallback-resolution pin — **extended to every
     post-await watchdog write**: episode A resuming after fallback/chain
     resolution writes `triedKeys` and assigns `chain` before the generation
     checks (rate-limit-watchdog.ts:149–176), and its detached
     `fireImmediateFallback` unconditionally clears the shared
     `fallbackPending` flag in `finally` (`:346–355`) — either can alter
     episode B's candidate selection or make `retryNow()` admit another
     retry during B's switch; every post-await watchdog write, the detached
     finalizer included, is generation-fenced — and
     `ProcessingStateManager.setIdle`
     gains the generation/owner-scoped state transition and waiter drain with
     the replacement-during-publish interleaving pinned — **and the
     post-publication idle callback joins the scope**: a stale `setIdle()`
     resuming after the publish runs `onIdleCallback`
     (processing-state-manager.ts:157–160), which — with a settings change
     having set `pendingRestartReason` for the now-processing replacement —
     fires `executeDeferredRestartIfPending()` (agent-session.ts:413–418)
     and restarts the replacement instead of waiting for its own idle
     boundary; ownership is rechecked before the callback and across its
     awaits, or the callback is owner-scoped as well — and the **detached
     reconciliation it spawns is fenced too**: the callback detaches
     `reconcileStrandedDeliveries()` (agent-session.ts:413–417), whose
     continuation snapshots processing state before awaiting session locks
     and then re-enqueues or fails durable deliveries (`:1957–1997`), so a
     replacement starting during either lock await receives reconciliation
     effects from the stale idle transition; the query/turn owner propagates
     into the detached reconciliation and is revalidated inside each locked
     mutation section
     (processing-state-manager.ts:156, :168–175) — using a **separate
     query-owner token, not the existing `idleWaiters.gen`**: that field
     stores the *rate-limit episode* generation
     (agent-session.ts:1390–1392 → processing-state-manager.ts:44–45,
     :79–83), and reinterpreting it as query ownership strands the current
     delivery waiter or drains another query's when the numbers coincide;
     each waiter carries both filters, with query-replacement and
     rate-limit-episode filtering each pinned — **plus a turn/delivery
     owner**: a successor delivery on the still-live query (`ensureQueryStarted`
     reuses it) installs its waiter with the *same* query generation
     (`:1390–1393`), so the previous turn's `setIdle()` finally-drain
     (`:168–175`) accepts and prematurely completes it under a query-only
     filter; each waiter scopes to its turn/delivery as a third owner, with
     the same-query successor interleaving pinned. This PR also carries the
     **notice-publication fix**: `displayErrorAsAssistantMessage` gates its
     `state.sdkMessages.delta` emission on `saveSDKMessage`'s boolean with
     the returned-false path pinned — and gates **both** same-named helpers:
     the QueryRunner's (`query-runner.ts:1619–1643`) and
     `SDKMessageHandler.displayErrorAsAssistantMessage`
     (sdk-message-handler.ts:239 ignores the save and emits at `:241–245`;
     called from `handleCircuitBreakerTrip`), each with its returned-false
     pin — otherwise the shell-retained helpers
     stay unchanged and clients keep receiving notices absent from the DB —
     and suppression **still surfaces the failure**: the `api_validation`
     route skips `errorManager` by design, so with the delta gated and the
     save failing (SQLite full or transiently erroring) the session would
     silently stop; the helper publishes a non-persisted `session.error`
     fallback (or equivalent user-visible signal) on the returned-false
     path, pinned alongside the suppression.
     PR 5 also implements the **ownership-fenced SDK dispatch — for BOTH
     runners**: each propagates its query generation through its
     `handleSDKMessage` (adding the
     owner token to `SDKMessageHandlerContext`) and validates it before the
     shared handler begins its fence, with the late old-generation result
     after a stop-timeout replacement pinned — validating the **full
     lifecycle, not the generation alone**: `cleanup()` sets `isCleaningUp`
     without bumping the generation (`:652–655`), so cleanup-without-
     replacement leaves the owner check passing while a late top-level result
     enters the handler during `stop()` and fires the fence and its current
     delivery waiters (`:720–722`), potentially acknowledging a delivery or
     persisting turn completion mid-teardown; `isCleaningUp()` is part of the
     dispatch-entry validation — the ACP runner has its own
     generationless dispatch (`acp-query-runner.ts:925–929` calls the shared
     `ctx.onSDKMessage` without its local `queryGeneration`), so fencing only
     the QueryRunner would leave ACP able to fire the replacement's terminal
     callbacks; the ACP late-result case is pinned too — and **ACP adapter
     callbacks fire before the yield**: `AcpQueryAdapter` invokes `onAccepted`
     and `onConfigOptionsUpdate` ahead of iterating (`acp-query-adapter.ts:53–68`),
     and the runner's callbacks (`acp-query-runner.ts:630–643`) consume
     delivery state or update the model cache immediately — a stale late
     acceptance can consume the replacement's re-enqueued UUID or overwrite
     its model state even though the eventual SDK message is dropped; every
     adapter callback binds to the run generation and validates before its
     effect, with late-acceptance and pre-yield config-notification pins.
     The **ACP handshake continuation is fenced too**: a stale run still
     awaiting `initialize`/auth/session-load resumes before any iterator
     exists (`:588–598` persists the old session ID, updates the shared model
     cache, restores the queue callback, and can clear the replacement's
     startup timer) — lifecycle is revalidated after each awaited handshake
     operation and before every shared write or handoff, with a
     replacement-during-handshake pin. The **startup callbacks are
     generation-bound too**: a replacement captures the old run's
     `onMessageEnqueued` as `previousOnMessageEnqueued` (`:485`), so a later
     enqueue invokes the old callback first — outside the post-handshake
     continuation checks — where it can install an old-generation startup
     timer (`:487–493`), prevent the replacement installing its own, and
     eventually close the replacement's shared `ctx.queryObject`
     (`:491–520`); both the enqueue and timer callbacks bind to the run
     generation, closing only the owned query object, with an
     enqueue-during-stale-handshake pin. Three more ACP ownership gaps join
     PR 5: the **retry arm** — its entry check (`:802–804`) is stale once a
     replacement lands during the awaited `setIdle()`/process-exit, after
     which the old arm re-enqueues, closes the replacement's shared
     `ctx.queryObject` (`:839–843`), resets the process-exit promise, and
     recurses (`:858`); lifecycle is revalidated after each retry await and
     before those shared mutations/recursion, with a
     replacement-during-ACP-retry pin. The **adapter's unconditional
     `finally`** (`:701–704`) — a stopped adapter exiting after the
     replacement re-enqueued the same UUID runs `markACPDeliveryFailed`,
     transitioning the *current* `enqueued`/`deferred`/`submitted` row to
     `failed` (sdk-message-repository.ts:1686–1697) even with every pre-yield
     callback rejected; the finalizer is generation/claim-fenced, with an
     adapter-exit-after-replacement pin. And **every await inside the leased
     setup window** — `ensureRequiredMcpServersForAcp()` and
     `proxyBridge.start()` block after lease acquisition, a replacement can
     bump the generation there, and a stale spawn at `:539–548` lands *after*
     `stop()`'s tracked-process snapshot so the stale-gated finalizer never
     closes it, leaving an unowned ACP process; ownership is revalidated
     after each setup await and immediately before spawn, unwinding the
     bridge/lease when stale. The **ACP finalizer is revalidated after its
     awaited idle transition**: owner-scoping `setIdle` itself does not
     fence the caller, and an old finalizer passing its one-time generation
     check before a replacement starts during the `session.updated` publish
     resumes at `:780` clearing the replacement's `ctx.queryPromise` — its
     detached `processExitSnapshot.then(...)` continuation also lacks the
     owner and can later publish `query.trigger` for the successor; the
     finalizer revalidates after the idle await before clearing shared
     fields, and the detached continuation binds to the old run owner. And
     the **outer prompt generator is fenced at
     its own boundary**: a stale continuation awaiting `onModelsFetched()`
     can still enter `messageQueue.messageGenerator` (`:603–606`), and
     because the generator snapshots its generation only when iteration
     begins (`message-queue.ts:272–283`) it snapshots the *replacement's*
     generation, claims the replacement's prompt, and mutates processing
     state (`:610–615`) — later callback fencing cannot return that prompt
     from `yielded`; ownership is checked before entering and immediately
     after each yield of the outer prompt generator, stale claims are
     requeued, and the same ownership binding applies to late pulls of
     QueryRunner's `createMessageGeneratorWrapper` — **and to the pre-yield
     consumption callback**: `messageGenerator` invokes `onMessageYielded`
     *before* yielding (message-queue.ts:316–323), and that callback marks
     the durable message consumed and publishes it through
     `handleMessageYielded`, so a stale generator blocked in
     `waitForNextMessage` performs those effects before any post-yield
     wrapper check runs; the run owner is passed into `MessageQueue` and
     validated before the callback (or the callback is suppressed and
     invoked only after the wrapper's ownership check). The
     generation check
     also runs **immediately after the iterator yields, before any shared
     startup/message bookkeeping** — the old loop clears
     `ctx.startupTimeoutTimer` and sets `ctx.firstMessageReceived` at
     `:790–801` ahead of the handler, and a stale first message doing so
     cancels the replacement's startup timeout, hanging it indefinitely even
     though the handler guard later drops the message — **and the ACP runner
     has the same pre-handler bookkeeping** (`:662–671` sets
     `firstMessageReceived`/`receivedAcpMessageDuringRun`, persists
     `acpInstructionsSent`, and its timer-clear path at `:1124`), so its
     generation check also runs immediately after its iterator yields, with
     the ACP late-first-message interleaving pinned — **and revalidation
     repeats after the prompt-setup awaits downstream of the yield**:
     `stateManager.setProcessing()` (`:611`) and
     `applyStoredAcpThinkingLevel()` (`:618`) both await after the post-yield
     check has passed, and a stale continuation resuming there overwrites
     `_lastConsumedUserMessage`, creates an adapter, assigns it to the
     replacement-owned `ctx.queryObject`, and installs a startup timer;
     lifecycle is revalidated after each of those awaits and before the
     shared writes. **Permission callbacks
     are fenced too**: both runs install a generationless
     `createCanUseToolCallback` (`:517–519`, acp `:438`), and ACP permission
     notifications invoke it out-of-band (`:547` → `:281–298`) — a late
     permission request from a stopped process reaches
     `interceptAskUserQuestion` and can supersede the replacement's pending
     question (`:164–185`) without ever passing the SDK-message guard; the
     callbacks bind to the run generation and reject stale permission
     requests in both runners, with a late-callback replacement pin — and
     the owner is **attempt-scoped, not generation-scoped**: every retry arm
     recurses with the *unchanged* `queryGeneration` (query-runner `:967`,
     `:1007`, `:1063`; acp `:858`), so after a `RETRY_EXIT_TIMEOUT_MS`
     teardown a late `onAccepted`, config update, permission request, or SDK
     message from the predecessor still passes a generation check and can
     consume the retry's re-enqueued UUID or mutate its shared state; a
     per-`runQuery` **attempt token** is allocated before recursion and
     invalidated **before the recursive `runQuery` is invoked** — not merely
     on the predecessor's exit, which `RETRY_EXIT_TIMEOUT_MS` can outlive,
     leaving the token valid while the retry already runs — with callbacks
     and iterators
     bound to it, and a late-callback-after-retry-teardown-timeout pin — **and
     the separate PreToolUse hook joins them**: `query-runner.ts:518`
     independently installs `createPreToolUseHook()`, whose
     `interceptAskUserQuestion` call (`:220–224`) can replace the successor's
     pending resolver through the same shared question state; that hook binds
     to the **attempt token** (not the run generation, which retries leave
     unchanged) and is included in the late-callback pin — and
     **ownership is revalidated after the user answers**: an entry-only
     binding does not reject an in-flight request, so a replacement starting
     while the question awaits its answer would receive that answer as
     `allow` at the old process, which may then execute the stale tool;
     lifecycle and turn ownership are revalidated when the question promise
     settles, the stale process is denied, and only the old question state
     unwinds before returning — **and the response/cancel handlers validate
     before their shared mutations, not only at resolution**:
     `handleQuestionResponse` records the answer and awaits
     `setProcessing()` (`:303–307`) before resolving the promise
     (`:341–348`), and the cancel path performs the same transition
     (`:384–390`), so a stale card submitted after a replacement marks the
     replacement processing and persists stale question history before the
     post-answer check ever runs; the pending resolver is bound to its
     query/turn owner and both handlers validate before mutating — **and
     after `setWaitingForInput()` before the
     `question.asked` publication** (`:197–201`): a replacement starting
     during that await would otherwise have the old tool-use ID published
     over its own pending question, queueing the response for the wrong
     request while the replacement stays waiting. The
     stale stop
     **returns a distinct outcome that propagates to the runner**: both
     wrappers unconditionally call `onMarkApiSuccess` after `onSDKMessage`
     (`:1512–1515`, acp `:926–929`), so a stale successful result would
     otherwise run `rateLimitWatchdog.reset()` and cancel the replacement's
     active cooldown — the wrappers skip all post-handler success bookkeeping
     on the stale outcome — and the runner's catch carries the same outcome
     past `drainDeliveryWaitersOnTerminalSDKMessage` (`:804–812`), whose bare
     `setIdle()` would otherwise mark the replacement idle, skipping or
     owner-scoping that drain when the emitting generation no longer owns the
     session — and the **whole catch is fenced, not just the drain**:
     QueryRunner still calls `errorManager.handleError` (`:814–820`) and ACP
     has its own catch (`:679–693`) doing the unscoped drain plus error
     publication; ownership is revalidated before the entire catch in both
     runners and all of its shared effects are skipped when stale, so a
     rejected stale handler can publish no reset error and idle no
     replacement. The requirement is
     assigned here because no other step touches the runner/context boundary.
     Because it edits `acp-query-runner.ts` and `sdk-message-handler.ts`,
     **PR 5 sequences after — or
     explicitly coordinates with — ACP split 8/10 and open PR #2543** (the
     collision exemption
     in §3 covers Chain B's query-runner scope only, and this PR steps
     outside it), and **Chain C's apply PR sequences after this PR**, whose
     fence primitive C's exceptional-exit contract consumes. Without this PR
     the plan would characterize the leaks and leave them in production.
  6. **PR 6 (cleanup/ADR note).**
- **Phase 0 primitives:** none for the *routing* state (generation counter,
  recoveryState, timers — all in-memory; the startup gate is the in-memory
  analog of spawn reservation, no DB primitive warranted in a single process
  whose children die with the daemon). **But if the backoff arm is staged, its
  two external effects require Phase 0 primitives** (ADR :148–153), matching
  the arm's own design above: a durable reservation with an idempotency key for
  the persisted/published retry notice, and a conditional durable reservation
  plus idempotence-or-exact-compensation for the prompt queue injection —
  otherwise both effects stay outside the staged pass in the shell.
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
  per-chunk behavior — while the **reset** calls
  (`resetThinkingTokenTracking` at :754 on top-level results and :962 on
  session-state idle) are turn-boundary and must survive the extraction:
  retain them explicitly in the shell (or add a reset action to the plan and
  pin those rows), since losing them carries
  `lastStampedThinkingTokensEstimate` into the next turn and undercounts its
  thinking delta.
- **ADR pattern:** `decisionRun` for the flag machine (flags in →
  `{idle_fence, early_set_idle, finish_turn, allow_queue_replay, next_flags}`
  plan out — the legacy direct `setIdle` (:746–750) is a distinct action from
  `finishTurn`'s own `setIdle` (:946), and the doubled transition it creates is
  pinned behavior — and `idle_fence` vs `early_set_idle` are **separate
  publication phases, not one aggregate plan**: `beginTerminalIdle()` runs
  *before* the awaited `sdk.message` publish while the direct `setIdle()` runs
  *after* it, so applying both from a single pre- or post-publication point
  either idles too early or delays the fence and changes the partial state
  left when publication rejects; the core models pre-publication and
  post-publication phases separately (or both actions stay at their shell
  positions) — and a **publication rejection unwinds the handler-owned
  fence**: `InternalEventBus.publish` rejects on subscriber failure
  (internal-event-bus.ts:145–157) after `beginTerminalIdle()` incremented both
  counters but before the direct `setIdle()` (:746–749), and if a replacement
  lands while the subscriber is awaited, **cleaning-up suppresses the fence
  consumer**: the per-message error path's drain
  (`drainDeliveryWaitersOnTerminalSDKMessage`, query-runner.ts:810–812) is
  gated only on `!isCleaningUp()` and its bare `setIdle()`
  (message-delivery.ts:13–14) consumes the fence for a top-level result
  regardless of staleness — so a replacement alone does not leak the fence,
  but when cleanup has begun the drain is skipped and this handler-owned
  fence stays live, misleading
  `reclaimTurnAlreadySucceeded`; and the unwind covers **every exceptional
  handler exit while the fence is pending**, not only rejection of the initial
  publication: with `usesSessionStateChangedTurnEnd` the direct `setIdle()`
  (`:746–750`) is skipped so the fence stays pending after the publish, and a
  later awaited effect — e.g. `session.errorClear` (`:932–934`) — can reject;
  with cleanup started the runner's catch skips its drain (`:810–812`) and the
  fence leaks identically; the failure path cancels its owned fence
  while retaining the pre/post-publication ordering — and all of this
  presupposes **the dispatch itself is ownership-fenced**: `handleSDKMessage`
  passes no `queryGeneration` and `SDKMessageHandlerContext` exposes no owner
  token (query-runner.ts:1512–1515, :302), so after a `stop()` timeout a late
  top-level result from the old iterator still reaches the shared handler and
  `beginTerminalIdle()` synchronously fires every current waiter's `onEnd` —
  including the replacement's — before any unwind can run; the runner
  propagates and validates ownership before the handler begins its fence,
  with a late old-generation result after replacement pinned — and the token
  is **retained through the handler, not checked only at entry**: a
  replacement starting while `internalEventBus.publish('sdk.message')` is
  awaited lets the stale handler resume into the unscoped `setIdle()` at
  `:746–748`, marking the replacement idle and draining its waiters; the
  owner token is revalidated after each awaited effect **and the stale
  handler stops there** — owner-scoped idle transitions alone are *not* a
  sufficient alternative: with `usesSessionStateChangedTurnEnd` the immediate
  `setIdle()` (`:746–750`) is skipped entirely, after which the stale result
  still mutates shared flags (`:752–755`) and runs `handleResultMessage`,
  updating session accounting and acknowledging queued work (`:891–934`);
  revalidate-and-stop is the requirement — and the stop **cancels the
  handler-owned fence first**: `beginTerminalIdle()` has already incremented
  the counters, so merely stopping leaves them live and delivery reclaim
  returns `live` until some later idle transition; cancellation precedes the
  stale return (assigned to PR 5 with the interleaving pin), with a
  replacement-during-`sdk.message`-publication pin — with the
  **turn/delivery owner propagated through the handler as well**: a
  successor delivery on the same live query has a new turn owner but the
  same query generation, so post-await validation accepting on generation
  alone still resumes the old handler into flag/accounting mutations and
  potentially `finishTurn()`, idling or acknowledging the successor's work
  even though turn-scoped waiter filtering stops the original drain; the
  handler revalidates the turn owner after its awaits, with the same-query
  interleaving pinned — and **ownership propagates into detached
  continuations**: `handleMessage` detaches `refreshContextUsage()` at
  `:793–795`, and after the handler returns its token can no longer cancel
  the refresh's later awaits — which update the shared `contextTracker`,
  publish `context.updated`, and may enqueue `/compact` into the
  replacement queue (`:1106–1140`); every detached refresh continuation
  captures and revalidates the query/turn owner **and the attempt token**
  before updating or
  enqueueing — retries preserve the query generation and turn owner while
  invalidating only the attempt token, so a predecessor refresh finishing
  after the retry starts still passes the query/turn checks and would
  update the tracker, publish stale usage, or enqueue `/compact` into the
  retry — and the **guardrail recovery enqueue and circuit-breaker trip
  join them**: `routeRecoveryMessage` detaches `messageQueue.enqueue`
  (sdk-message-handler.ts:155–158) whose synchronous admission delivers the
  old turn's recovery prompt to the replacement before any outer check, so
  the invoking owner is captured and validated immediately before routing;
  and the trip callback (`handleCircuitBreakerTrip`) resuming after its
  `session.errorClear` await inspects the shared `ctx.queryObject/
  queryPromise`, calls `lifecycleManager.stop()`, then idles and publishes
  errors — able to stop and reset the replacement — so the query/turn owner
  is propagated into the callback and revalidated after each of its awaits
  before every remaining shared effect. Model discovery is fenced at its cache write too:
  `getSupportedModelsFromQuery` sets `modelsCache` immediately after the
  `supportedModels()` await (model-service.ts:120–127) — before any
  post-fetch generator check, detached at query-runner.ts:773–775, and
  outside `refreshInProgress`/`cacheGeneration` so a replacement's cache
  clear does not fence the late write; the run owner is passed into
  discovery and validated immediately before `modelsCache.set`; and the
  parallel **slash-command discovery** is fenced at the same boundary:
  `SlashCommandManager.fetchAndCache()` captures the current query, awaits
  `supportedCommands()`, then writes `slashCommands`,
  `session.availableCommands`, and the DB (slash-command-manager.ts:95–125)
  — a replacement or provider/model switch during that await has the
  predecessor overwrite the successor's commands and set
  `commandsFetchedFromSDK`, making the successor's `updateFromInit()` return
  early (`:53–54`); the same owner/attempt validation precedes these cache
  writes; the
  core also returns the updated flag state, since the scoped machine mutates it:
  results set `lastResultWasSuccess`; suppressed **successful** results clear
  `suppressIdleOnNextResult` (:936–937 is success-gated at :765–766), so a
  suppressed error result leaves the flag set for the following result — the
  error row retains the flag and PR 1 pins that asymmetry; the transitions are
  **phased, not aggregate**: `lastResultWasSuccess` is set at :753 while the
  suppression clear happens at :936 only after several awaited metadata/ack/
  error-clear effects, so an effect failure leaves flags partially updated —
  the core models phase-specific transitions (or the mutations stay at their
  current shell locations), and PR 1 pins those failure paths; non-idle
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
- **Phase 0 primitives:** no blanket CAS — the single-row ack/consume flips
  (`acknowledgePersistedUserMessage` :265–296 → `consumePersistedUserMessage`
  :298–331, `handleMessageYielded` :512–595) run check→write synchronously —
  but the turn-end fallback-ack loop does not: its snapshot-then-await-consume
  shape (`:338–345` snapshot, `:370–374` awaited publish between rows) lets a
  later selected UUID acquire new ownership mid-loop, so the loop requires
  per-row eligibility/ownership revalidation before each acknowledgement
  (ideally an atomic guarded transition). Transactional ownership creation
  (§4.3) remains the Q4 fix where a job insert must accompany a status change.
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
  the stagedRun failure contract it needs a durable conditional startup intent
  **plus** idempotence-or-compensation, or stays
  outside the staged pass as a shell-preceding step; DB reloads,
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
  bindings when identity changed) — **and immediately after the awaited
  `ensureQueryStarted` for every path** (:1365): the `alreadyConsumed` branch
  bypasses the whole `!alreadyConsumed` block and never reaches a
  pre-`admitWithId` check, so without a post-startup resnapshot a stale pass
  can bind the observer/waiter and return `driving` against the replacement
  query — and the post-startup resnapshot is **full lifecycle, not identity
  alone**: `cleanup()` sets its flag without advancing generation and awaits
  work inside `stop()`, so `ensureQueryStarted` can resume with the newly
  expected query identity while the claim is still current, and the pass would
  install the waiter/observer and return `driving` as cleanup stops its queue;
  cleaning-up, queue-running, abort, and route-appropriate processing state
  are all rechecked before either branch proceeds — **along with delivery
  ownership**: claim currency and `messageDeliveryValid` are re-checked too,
  because the `alreadyConsumed` path's only `claimGuard`/validity checks ran
  *before* the await and the path bypasses the later `!alreadyConsumed`
  checks, so without them a superseded handler still installs the
  waiter/observer and returns `driving` for the replacement query — claim
  supersession joins the interleaving pin — and **ownership is revalidated
  after the SDK acknowledgement too**: `driveDeliveryTurn` awaits
  `started.acknowledgment` (`:1517–1523`) after every earlier check has
  passed, and a claim superseded during that await resumes into
  `markDeliveryBatchConsumed()` and consumption signaling even when
  replacement teardown resolved the yielded durable entry via
  `MessageQueue.clear()` — cleared, not consumed; the full
  **lifecycle/abort state is rechecked alongside delivery ownership** after
  the acknowledgement — in **both** acknowledgment consumers:
  `driveDeliveryTurn` and `feedDeliverySteer`, which independently awaits
  `action.acknowledgment` (`:1734–1746`) and then unconditionally marks a
  non-ACP delivery consumed (`:1747–1752`); `MessageQueue.clear()` resolves
  rather than rejects yielded acknowledgments, so a cleared steer resumes
  through that path and consumes/signals the durable row unchecked — the
  same full lifecycle and delivery-owner resnapshot precedes the steer's
  metrics and consumption effects, and in the turn path precedes the durable
  status/signaling effects — cleanup can clear a yielded entry's
  acknowledgment (message-queue.ts:156–162 resolves it) without superseding
  the claim or losing the abort race, and the continuation at
  `:1523–1526`/`:1537–1549` would otherwise persist consumption for a
  cleared prompt — pinned by a
  **deterministic interleaving test** (deferred `ensureQueryStarted` promise;
  start cleanup before resolving it; assert the resnapshot disarms the
  preinstalled observer, creates no idle waiter, and returns without
  `driving`), since routing tables and ordinary transcripts never exercise an
  await-boundary interleaving by accident. The
  query — and the **existing-entry path needs the same revalidation**:
  the `existing` branch (:1479–1483) never calls `admitWithId`, so a guard
  placed only there is bypassed; revalidate and rebuild the waiter/observer
  immediately before returning `driving` on both fresh-admission and
  existing-entry paths — or a stale attempt
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
     queue admits **and removals** — the content-mismatch path calls
     `messageQueue.remove(messageUuid)` before aborting and that removal
     resolves the entry's acknowledgement (:1467–1473 → message-queue.ts:165–178)
     — plus DB marks and job mutations per scenario, with removal-triggered
     acknowledgement resolution in the staged-effect inventory); **call-site
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
  if `ensureQueryStarted` stays inside the staged pass, **both obligations**
  apply, not a choice between them (ADR :148–153, :201–219): a durable
  conditional startup intent (the crash-recovery/dedup record) **and**
  idempotence or compensation for the spawned query — the
  in-memory startup permit provides neither, and compensation alone leaves no
  dedup record while durable dedup alone cannot unwind a spawned query on a
  later stage failure; otherwise startup remains a shell-preceding step outside
  the pass.
  The admission block's installed resources — `deliveryResponseObserver` and
  the `waitForIdleTransition` waiter (:1350–1393) — likewise need registered
  cleanup compensations (a stale observer can attribute the replacement turn's
  first response to the failed delivery; the waiter can fire against a later
  idle transition), or their ownership stays in the shell. The reclaim path adds
  a persistent write of its own: `reclaimTurnAlreadySucceeded` can invoke
  `clearDeliveryTurnEnd` for an already-consumed delivery with a bare turn-end
  marker (`:1347`, `:1386` → `:1836–1843`), erasing a crash-recovery marker with
  no guard — that clear is a conditional compensable effect (or shell-retained
  with equivalent failure handling) so a later-stage failure restores the marker.
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

**Task-sizing update (2026-08-23, §8):** every PR below is decomposed into
sub-PRs at a ≤200-line review budget — 16 tracked PRs → **56 PR-sized tasks**
(PR 0 → 0a–0g, chains per §8). Gates moved since the survey: **#2661 merged**
(Chain B apply PRs unblocked), **#2543 still open** (Chain A held), and the
watchdog owner's stream is active (#2772 pins, #2779 open extraction) so B5d
coordinates with it. §8 anchors are current dev (`c7638c276`).

**Prerequisite PR 0 — provider-environment coordinator.** The daemon-wide
credential isolation this proposal requires (§1(a)) is delivered by no chain
PR and must not ride along implicitly: one dedicated PR implements the
ProviderService-boundary coordinator (credential-reads → apply →
**copy-and-restore** serialization for the QueryRunner path — the lease
releases at the immutable `queryOptions.env` copy, before startup-gate
admission, per the bounded critical section in §1(a) — and **ACP gets its own
bounded section**: it applies at `:456`, builds `acpEnv` at `:522–536`, and
synchronously spawns `AcpClient` at `:539–548`, but restores only in the
finalizer (`:760–764`), so a full-lifetime lease would block every other
session indefinitely; the ACP lease spans only through the transport's
process-environment snapshot/spawn, then restores and releases before the
handshake/message loop, with a concurrent-session pin — and the lease
**begins before the ambient reads**: `isAvailable()` and
`optionsBuilder.build()` run ahead of the apply and capture ambient
credentials/routing into `queryOptions.env` that the later refresh
preserves, so starting at the apply snapshot alone would let an overlapping
session's window contaminate the launch. Bounded use-time leases
apply only to direct SDK paths that do not snapshot an environment), enrolls
every owner and reader in the inventory — both
runners, the four ProviderService services, the Anthropic model loader, the
GitHub security/router spawns, and the ambient availability readers — handles
ACP's pre-apply snapshot and the recursive arms' release-before-recursion, and
ships concurrency pins for each interleaving named above (cross-session
overlap, replacement-during-apply, reader-during-window) — plus
**post-acquisition revalidation and service lease boundaries**: a stale run
blocked awaiting the lease can acquire it *after* a replacement bumped the
generation (`runQuery` has no setup-time check), then proceed through reads,
apply, copy, and spawn overwriting the replacement — both runners take a full
lifecycle resnapshot immediately after every awaited lease acquisition and
before any apply/copy/spawn work, **and the QueryRunner revalidates after
each awaited setup operation just as ACP does**: a replacement bumping the
generation while the old runner already owns the lease and awaits
`provider.isAvailable()`, `optionsBuilder.build()`, or an MCP
invariant/self-heal callback would otherwise resume into the setup effects
of `:462–639` (`errorManager.handleError`,
`provider.setSessionThinkingConfig`, and the session-mutating self-heal
callbacks) against the replacement's session; the lifecycle check follows
every awaited setup operation and precedes its subsequent shared effects;
and the four ProviderService services (title
generation, conversation analysis, episode judging, workflow selection) all
build a complete immutable `options.env` via `mergeProviderEnvVars` before
iterating their query (session-lifecycle.ts:952–984,
evolution-episode-service.ts:752–782, and the analogous paths), so each
restores and releases **immediately after constructing its SDK environment**,
not in the post-inference finalizer — a full-response lease would block every
session startup and credential reader for the model's entire latency. It lands
before or
with Chain B's apply PRs — and **after (or explicitly coordinating with) ACP
split 8/10 and open PR #2661**: the split owns `acp-query-runner.ts` around
the same `:451–456` snapshot/apply region PR 0's ACP handling edits, and #2661
touches `query-runner.ts`, whose credential-read/apply/copy region PR 0 also
edits; running concurrently risks conflicting or lost ownership changes. PR 0
moreover **enrolls or sanitizes env-inheriting spawns**: uncoordinated
subprocesses launched without an `env` — e.g. the workflow executor's
user-supplied condition expressions via `Bun.spawn(['sh','-c',…])`
(workflow-executor.ts:32–37, :127–137) — inherit the active session's API
keys, tokens, and routing variables during the lease window; every such spawn
is enrolled, sanitized, or the ambient reads move to an immutable baseline so
the mutation window can no longer span awaits — §8.1's 0f/0g split carries
the repo-wide inventory and its mechanical application (the sweep there finds
ten-plus sites beyond the workflow executor and github agents).

Create chain B first (sequence its apply PRs after #2661 merges), chain C in
parallel once #2661/#2543 clear, chain A as the wave-2 capstone after #2543
(its turn-end loop no longer depends on a Chain C artifact — §4.2 — so A can
start once #2543 lands and the facade is free of another chain's in-flight
edits). Add `output-limiter-hook.ts` to the policy-core pilot series. Hold
model-switch/rewind/question-handler extractions until ACP 8/10 settles (#2548
part 2 has landed as #2696).

## 8. Sub-PR decomposition — ≤200-line review budget (2026-08-23)

Task-size review pass over the 16 tracked PRs above (prerequisite PR 0 + 15
chain PRs: B1–B6, C1–C4, A1–A5; 17 counting the `output-limiter-hook.ts`
policy-core addition, which stays a single small task in that series).
Question answered: is each PR the smallest unit that fits a focused review?
Verdict: **only 4 were already at budget (B4, B6, C4, A5); the other 12
decompose into 52 slices — 56 PR-sized tasks in all** — PR 0 → 7, B1 → 5,
B2 → 2, B3 → 4, B5 → 12, C1 → 3, C2 → 3, C3 → 3, A1 → 4, A2 → 4, A3 → 3,
A4 → 2, plus the 4 unsplit parents (57 tasks counting the separate
output-limiter addition).

Budget rule per sub-PR: production Δ ≲100 lines (hard cap ~150 only for
types-dominated additive cores), prose/ADR Δ ≲150, test Δ ≲350 — table rows
are mechanical, so a pins PR that would exceed ~350 test lines splits by
dimension family, never by truncating rows. **Flagged assumption: tests are
counted separately from production code.** If tests must also fit inside the
200-line total, the pins PRs split another 2–3× by dimension family, and any
additive-core/enrollment slice whose prod+test estimate exceeds ~200 splits
its full table suite into a companion pins PR that immediately follows —
under the current table estimates that is 0a (~230), 0b (~285), 0c (~220),
and B5e (~210); every other core/apply/cleanup slice already fits as-is.

Sub-PR IDs are letter suffixes on the reviewed parent (B5a = first slice of
B5), so §5's reviewed scope carries over unchanged. **Namespace task titles
with an `agent-layer` prefix** (e.g. "agent-layer B5a"): dev commit titles now
carry `chain A/B/C PR n/5` labels from the parallel space/session-layer
surveys (#2766/#2767/#2771), which collide with bare letter IDs.

### 8.0 Land-state delta since the survey (dev `c7638c276`)

§1–§7 anchors are as-of-survey; §8 anchors are current dev:

- **#2661 merged** (limit-error pipeline; #2664 added the LLM classification
  tier) → Chain B apply PRs (B3\*) are **unblocked**. The tier introduced
  `limit-error-llm-classifier.ts`, a new env-merging reader — enrolled in 0d.
- **#2543 still open** → Chain A remains gated as before.
- **#2728** (Pilot 4 PR 8) moved the delivery job handler to
  `job-handlers/message-delivery.handler.ts` (194 ln) — Chain A's
  `message-delivery.handler.ts` anchors in §5 refer to that file.
- **Watchdog stream active**: #2772 pins the trip/reset decision table, #2779
  (open) extracts the trip/reset core as pure gates → B5d's fencing lands on
  those gates; coordinate with that owner. If #2779 lands first, B5d shrinks
  to gate interpretation at the call site.
- Size drift: query-runner.ts 1,645→1,692; agent-session.ts 2,226→2,388;
  processing-state-manager.ts →387; sdk-message-handler.ts →1,474. Shifted
  anchors used below — query-runner: runQuery :455, env copy :688, catch
  :864, arms :969/:1013/:1069–1230, finalizer :1315–1360. ACP: preCleanupAuth
  :459, acpEnv :530–544, spawn :551, beginTerminalIdle :938, setIdle :953.
  PSM: releaseIdleWaiters :79, beginTerminalIdle :86, setIdle :143. SMH: ack
  :392, handleMessageYielded :639, result/limit :886–891, trailing-idle
  :1158–1273, finishTurn :1234, cost :1071. Agent-session: driveDeliveryTurn
  :1434, feedDeliverySteer :1847, reconcile :2112.

### 8.1 Prerequisite PR 0 → seven sub-PRs

| sub-PR | scope (current anchor) | prod Δ | test Δ |
|---|---|---|---|
| 0a | `provider-env-coordinator.ts` additive core: lease token, acquire/release, owner/reader registry — unwired | ~110 | ~120 |
| 0b | QueryRunner enrollment: lease around :492–525 credential read/apply + :688 immutable copy; full lifecycle resnapshot after every awaited setup op (:462–639 effects) | ~85 | ~200 |
| 0c | ACP enrollment: **lease begins before the ambient reads** — `isAvailable()` (:421) and `optionsBuilder.build()` (:441) run before the `:456–459` preCleanupAuth snapshot, and build() captures ambient credentials/routing into `queryOptions.env` which the `:530` refresh then preserves, so a lease starting at the snapshot can still launch ACP with another session's credentials; lease spans reads → apply → acpEnv (:530–544) → spawn (:551), restore+release before handshake; cross-session contamination-at-build + replacement-during-lease pins | ~80 | ~140 |
| 0d | ProviderService services: restore/release immediately after `mergeProviderEnvVars` at the five readers — session-lifecycle :1085, evolution-episode :774, evolution-conversation-analysis, llm-workflow-selector, limit-error-llm-classifier (new since survey) | ~60 | ~80 |
| 0e | Ambient readers + Anthropic model loader enrollment (isAvailable/AuthManager/EnvManager/logout) | ~40 | ~40 |
| 0f | Env-less spawn **inventory** as the reviewable artifact + the enroll/sanitize/immutable-baseline decision — the Recommendation names workflow-executor :33/:127 and the github agents, but a current-dev sweep finds env-inheriting launches in at least: dialog-handlers :70, hook-executor :301, sdk-cli-resolver curl :205/:228, copilot bun-node-wrapper :13, worktree-manager :544, space-worktree-manager (10 execFileSync sites), artifact-git-ops :35, space-manager exec, process-watchdog, credential-discovery :4, connector spawner seams (github-connector :18, presets :19/:62) | ~25 | ~30 |
| 0g | Mechanical application of 0f's decision across every inventoried site (sanitized env or immutable baseline); query-runner's SDK `nodeSpawn` and the ACP transport spawn are explicitly env'd and get verification rows, not changes | ~90 | ~60 |

Order: 0a → 0e → (0f → 0g) → then (0b ∥ 0c ∥ 0d) — **the ambient-reader and spawn protections land before any lease owner activates the mutation window**, so no intermediate land state mutates process.env while readers/subprocesses are still unenrolled (or 0b–0d wait and land atomically with 0e/0g). 0b/0c carry the Recommendation's
post-acquisition revalidation passes (including the ACP setup-window
revalidation that closes the stale-spawn-never-closed gap); 0d–0g are
independent leaves. **0c holds the ACP split 8/10 coordination gate** (the split owns `acp-query-runner.ts` around the same snapshot/apply region; §Recommendation), and 0b's region gate (#2661) has merged.

### 8.2 Chain B → twenty-five sub-PRs

| sub-PR | scope (current anchor) | prod Δ | test Δ |
|---|---|---|---|
| B1a | pins: startup-arm decision rows — attempt-zero × processing status × abort-controller × cleaning-up × prompt redeliverability (:969–1013) | 0 | ~300 |
| B1b | pins: transient/provider rows — attempt × cap exhaustion × provider family (Anthropic SYSTEM vs PROVIDER_UNAVAILABLE) × billing-429 (:1069–1230), plus the unmatched-AbortError `aborted_noop(clear_queue)` row (queue cleared, no terminal handling, no spurious error display) | 0 | ~240 |
| B1e | pins: lifecycle-dimension cross rows — processing status × abort-controller signal × cleaning-up across **every** arm family incl. the transient/provider gates and their backoff revalidation (:1145–1158) and `aborted_noop` — an aborted controller that blocks a transient retry vs the otherwise identical non-aborted case is a row (split from B1b to honor the ~350 test cap) | 0 | ~140 |
| B1c | pins: 429-handoff suppression contract (`rateLimitCooldownScheduled` ⇒ no errorManager/setIdle) + per-arm teardown-liturgy inventory | 0 | ~250 |
| B1d | pins: unfenced-window map — guard placement pinned as-is, not assumed complete | 0 | ~150 |
| B2a | `query-retry-routing.ts` classifier core + types, unwired | ~110 | ~60 |
| B2b | decisionRun composition + recoveryState/supersede → arm mapping | ~50 | ~60 |
| B3a | apply startup arms (:969, :1013) — arms become interpreters, each with the route-specific lifecycle/queue-running resnapshot immediately after its awaited `setIdle`, before re-enqueue, shared mutation, or recursion | ~50 | ~45 |
| B3b | apply provider/transient arms (:1069–1230), incl. the unmatched-AbortError `aborted_noop(clear_queue)` route — clears the queue and skips the entire terminal path via the `!isAbortError` gate (:1158–1291 region), a distinct classifier route that neither the startup nor provider arms cover — the transient arm's resnapshot lands before `_lastConsumedUserMessage` can be re-read and re-enqueued into the successor's queue, ahead of the existing later guard | ~85 | ~60 |
| B3c | finalizer post-await generation/identity guards (:1315–1360) — closes B1d's pinned window in production | ~40 | ~60 |
| B3d | apply the terminal & handoff routes the classifier emits beyond the retry arms — `api_validation`, the scheduled/declined/thrown rate-limit handoff (the B1c suppression contract's production side), `terminal(category, message_hint)`, and the cleanup/superseded routes — one interpreter branch per route with each route's post-effect ownership handling left as the B5 fence seam | ~70 | ~60 |
| B4 | teardown-liturgy dedup: one parameterized helper, four call sites (unsplit) | ~90 | ~40 |
| B5a | attempt-token primitive: invalidated before retry recursion (:1150); PreToolUse hook binds to it (:518 region) | ~70 | ~90 |
| B5b | owned-terminal-fence cancellation: query-runner terminal/validation/handoff routes (beginTerminalIdle owners :1185/:1267), plus finalizer revalidation after the idle await before clearing shared fields and owner-binding the detached `processExitSnapshot.then(...)` continuation that can publish `query.trigger` for the successor | ~70 | ~90 |
| B5c | ACP terminal: full lifecycle resnapshot before beginTerminalIdle (:938) + post-effect resnapshot/fence-cancel before setIdle (:953); **the owned fence is also cancelled from the rejection path** — when `errorManager.handleError()` itself rejects after ownership changed, execution never reaches the post-effect resnapshot, so the rejection/finally path cancels the fence (the leak-only-in-rejection-interleaving case; consumes B5b's cancellation primitive) | ~60 | ~75 |
| B5d | **all** post-await watchdog-write fencing at the watchdog boundary — `scheduleCooldown` :233–237 pre-generation-check write, `triedKeys`/`chain` :149–176, detached `fireImmediateFallback` finally :346–355 — lands on #2779's pure gates; owner coordination, excluded-module rule holds | ~30 | ~50 |
| B5e | owner-scoped idle in PSM: beginTerminalIdle owner filter (:86), setIdle waiter-consume scoping (:143) incl. the post-publication `onIdleCallback` invocation block (:161–170), releaseIdleWaiters episode filter (:79); waiter admission carries **all three owner filters — query, rate-limit-episode, and turn/delivery** (a successor delivery on the same live query has a new turn owner but the same query owner; the handler revalidates the turn owner after its awaits); replacement-during-publish + same-query-successor pins; **the detached `reconcileStrandedDeliveries` continuation the idle callback starts carries the query/turn owner and revalidates inside each locked mutation section**, so a stale reconciliation cannot re-enqueue or fail the successor's durable deliveries | ~95 | ~115 |
| B5f | ownership-fenced SDK dispatch **for both runners**: generation/owner token propagated through `handleSDKMessage` into the shared handler context and validated before its fence; `isCleaningUp()` joins dispatch-entry validation (cleanup-without-replacement); ACP's generationless dispatch (:925–929 region) fenced identically; **the output iterator's pre-dispatch bookkeeping is fenced at each yield** — the stale iterator clears `ctx.startupTimeoutTimer` and sets `ctx.firstMessageReceived` (query-runner) and ACP additionally records receipt, persists `acpInstructionsSent`, and has its own timer-clear path, all before the dispatch boundary; the shared handler **retains the query/turn/attempt owner and revalidates after each awaited effect — publication, metadata, acknowledgements — cancelling its owned fence before a stale return** (the same-query-successor case: generation unchanged, turn owner changed); late old-generation result + stale-iterator-bookkeeping pins; **a rejected stale dispatch returns a distinct stale outcome, and both runner wrappers skip their post-handler success bookkeeping on it** (`onMarkApiSuccess`, watchdog reset) so a late predecessor message cannot cancel the successor's active cooldown | ~80 | ~105 |
| B5g | ACP adapter + handshake-continuation generation binding: `onAccepted`/`onConfigOptionsUpdate` pre-yield callbacks (acp-query-adapter :53–68), `onMessageEnqueued` wrapper install in **acp-query-runner** (:493–524; queue-side hook message-queue.ts :53/:112) + its startup-timer (:497–503 region) close only the owned query object; the stale handshake continuation that overwrites `_lastConsumedUserMessage`, creates/assigns the adapter to the replacement-owned `ctx.queryObject`, and installs a startup timer is revalidated after each await and before those shared writes; the adapter's unconditional finally (:701–704) is generation/claim-fenced so a stopped adapter cannot `markACPDeliveryFailed` the replacement's re-enqueued row; enqueue-during-stale-handshake + adapter-exit-after-replacement pins; the binding is **B5a's attempt token, not the generation alone** — ACP retries preserve `queryGeneration`, so the adapter/handshake callbacks and iterators validate the per-attempt token exactly as B5f/B5l do, closing the retry-teardown-timeout interleaving | ~75 | ~95 |
| B5h | ACP retry-arm revalidation: entry check (:802–804 region) stale after awaited setIdle/process-exit — revalidate after each retry await and before the re-enqueue/queryObject-close/process-exit-reset/recursion (:839–858); replacement-during-ACP-retry pin | ~50 | ~70 |
| B5i | whole-catch ownership fencing in both runners: revalidate before the entire catch — QueryRunner `errorManager.handleError` (:838 region) and ACP's own catch (:679–693) with its unscoped drain; `drainDeliveryWaitersOnTerminalSDKMessage` (:804–812) skips or owner-scopes when the emitter no longer owns the session — the guard consumes **B5a's attempt token, not the generation alone** (retry recursion preserves `queryGeneration`), with a late-catch-after-retry pin; **exceptional handler exits cancel their fence**: when `sdk.message` publication or a later awaited handler effect rejects while cleanup skips the runner's idle drain, the rejection/finally path cancels the handler-owned terminal fence so `terminalIdleInFlight` cannot stay set (delivery reclaim reporting a completed turn as live); **the route owner propagates into `errorManager.broadcastError`**, revalidated after its `updateApiConnectionStatus` await and before publishing `session.error` (B3d's seam); stale-handler-publishes-nothing pin | ~75 | ~95 |
| B5j | notice-publication fallback: error-display helpers that return false on a failed persist (save ignored, emit-only path) publish a non-persisted `session.error` fallback — the `api_validation` route skips `errorManager` by design, so a gated save failure must not silence the session; returned-false pins for both callers; **`handleCircuitBreakerTrip` binds to its query/turn owner and revalidates after its `session.errorClear` await** before inspecting the shared query object, stopping the lifecycle, idling, or publishing reset errors | ~40 | ~55 |
| B5k | prompt-generator boundary fencing at the message-queue seam: ownership checked before entering `messageQueue.messageGenerator` and immediately after each yield (a stale continuation awaiting `onModelsFetched()` snapshots the *replacement's* generation at :603–606 / message-queue :272–283, claims its prompt, and mutates processing state :610–615); stale claims requeued; late pulls of `createMessageGeneratorWrapper` bound identically; the pre-yield `onMessageYielded` consumption callback (message-queue :316–323) validates the run owner — passed into `MessageQueue` — before marking the durable message consumed/published, or is suppressed until after the wrapper's check; iterators bind to B5a's attempt token; **model/slash-command discovery helpers (`supportedModels()`, `supportedCommands()`) write shared caches inside their awaits before the generator resumes — the owner/attempt token propagates into both and is validated immediately before their cache and DB writes**, so a stale attempt cannot overwrite the successor's models/commands or suppress its refresh; **detached handler continuations launched with `void` — `refreshContextUsage()` — capture the query/turn/attempt owner at launch and revalidate before updating the context tracker, publishing `context.updated`, or enqueueing `/compact`** (late-after-retry pin) | ~95 | ~115 |
| B5l | permission-callback fencing in both runners: the generationless `createCanUseToolCallback` installs (query-runner :517–519, acp :438) bind to the run generation/attempt token and reject stale requests — ACP permission notifications invoke it out-of-band (:547 → :281–298) and a late request from a stopped process can supersede the replacement's pending question (:164–185) without passing the SDK-message guard; **the answer path is fenced end-to-end** — lifecycle/turn ownership is revalidated when the question promise resolves and before the response/cancel mutations and the `question.asked` publication, so a stale ask cannot persist resolved-question history or drive `setProcessing` against the replacement; late-callback replacement + stale-answer pins (the PreToolUse-hook half of this binding is B5a's) | ~60 | ~80 |
| B6 | cleanup + ADR note | ~15 | doc ~40 |

Order: B1\* → B2\* → B3\* (B3c is region-independent of B3a/b and can lead);
B4 after B3; **B5a ∥ B5e first (primitives), then B5b (owned-fence
cancellation primitive — PSM today exposes only `beginTerminalIdle()` and
fence consumption via `setIdle()`, so nothing downstream can cancel a fence
until this lands), then B5f and B5c (both consume B5b's primitive; B5f also
consumes B5a's token), then B5g, B5h, B5i, B5k, B5l in parallel; B5d coordinates
with #2779; B5j is an independent leaf behind the #2543 gate and sequences
after B5f's handler-context owner primitive**. The B5 slices that edit `sdk-message-handler.ts` or `acp-query-runner.ts` (B5f–B5i, B5k, B5l — **and B5j**, whose circuit-breaker callback edits the same handler) hold §5's coordination gate on open #2543 alongside the #2779 coordination for B5d. B5's setup-window revalidation
(stale ACP spawn after `stop()`'s snapshot) is owned by 0c, not duplicated
here. Chain C apply PRs follow the **complete B5 series (B5a–B5l)** — C's
exceptional-exit contract consumes the dispatch/catch fencing of B5f/B5i,
not only B5e's owner-scoped idle (§5).

### 8.3 Chain C → ten sub-PRs

| sub-PR | scope (current anchor) | prod Δ | test Δ |
|---|---|---|---|
| C1a | pins: flag-machine truth table — suppress × mode × expectsIdle × lastResultWasSuccess × result kind × top-level-result bit × queryMode × **current session-state event kind/state (idle event calls finishTurn/replay/flag-reset; non-idle only arms the expectation; no-event rows too — or the §5 shell-retention alternative, stated explicitly)**, **phase and failure-path boundaries are dimensions** — the terminal fence fires before `sdk.message` publication while direct idle follows it; `lastResultWasSuccess` updates before later awaited metadata/error-clear effects and suppression clears after them; rows where the publication or a later effect fails assert the intermediate flag state they leave; `next_flags` asserted on every row; **thinking-token reset action (`resetThinkingTokenTracking` on top-level results and on session-state idle) is a matrix action or explicitly retained in the shell**; manual-mode no-replay gate (:1234) | 0 | ~350 |
| C1b | pins: ack-selection table — sendStatus × durable ownership × yielded/claimed × pending-in-memory × active-message equality (:392–440, :639) | 0 | ~250 |
| C1c | pins: cost-reset table (:1071–1150) + legacy-fragility characterization (terminal-fence + double-setIdle; stale lastResultWasSuccess window) | 0 | ~150 |
| C2a | `turn-end-routing.ts` pure core (flag machine + finish/replay gates) | ~90 | ~60 |
| C2b | `usage-accounting.ts` pure core | ~70 | ~60 |
| C2c | `ack-selection.ts` pure core — the plain sendStatus × ownership × yielded/claimed × pending × active-equality selector C1b pins and C3b applies (no additive slice previously created it) | ~40 | ~50 |
| C3a | apply turn-end routing at :886–891 and :1158–1273; the extraction **preserves B5i's exceptional-exit fence cancellation** — the rejection/finally cleanup that keeps `terminalIdleInFlight` from surviving a failed turn-end is pinned as a characterization row so the rewiring cannot drop it (B5i owns the mechanism) | ~60 | ~50 |
| C3b | apply ack selection at :392–440/:639, applying **C2c's** selector with per-row ownership revalidation in the turn-end fallback-ack loop immediately before every acknowledgement (the loop is snapshot-then-await-consume, so a later row can gain a durable owner mid-loop — Phase 0 guarded transition) | ~55 | ~50 |
| C3c | apply usage accounting at :1071–1150 | ~40 | ~30 |
| C4 | cleanup + ADR note | ~10 | doc ~35 |

Order: C1\* → C2\* → C3\*; C2a ∥ C2b ∥ C2c; **C3 apply after the complete B5
series (B5a–B5l)**, whose dispatch/catch fencing the exceptional-exit
contract consumes — owner-scoped idle (B5e) alone does not stop a stale
handler resuming after an awaited publish (§8.2); **and C3 remains gated on
#2543** — the §5 contract sequences Chain C after both #2661 and #2543
(sdk-message-handler overlap, §3), and only #2661 has merged.

### 8.4 Chain A → fourteen sub-PRs

| sub-PR | scope (current anchor) | prod Δ | test Δ |
|---|---|---|---|
| A1a | pins: transcript parity harness — driveDeliveryTurn (:1434) + feedDeliverySteer (:1847), queue admit **and removal** instrumentation (removal-triggered ack resolution) | 0 | ~350 |
| A1b | pins: role-arbitration call-site characterization — deliverMessage reuse/propagate (message-delivery.ts:97–139) vs outbox in-transaction steer conversion | 0 | ~180 |
| A1c | pins: steer-ladder decision table — status × queryPromise × provider type × claim-current × delivery validity × queue ownership (:1847 region, claimGuard :1858) | 0 | ~300 |
| A1d | pins: handler-outcome tables — preflight gates (:34–85), outcome→mutation map (:104–188), park budgets + waiting-for-input asymmetry | 0 | ~280 |
| A2a | `delivery-turn-routing.ts` — steer ladder + role-arbitration composition over `resolveDeliveryRole` | ~85 | ~60 |
| A2b | handler outcome routing module (post-preflight table) | ~70 | ~60 |
| A2c | `reconciler-sweep.ts` (stale-submitted selection) | ~40 | ~40 |
| A2d | `message-queue-timeout-policy.ts` (pending/claimed/yielded × durable timeout decision) | ~45 | ~40 |
| A3a | wire steer ladder at :1847 + handler outcome interpretation, plus the steer-continuation hardening: `feedDeliverySteer` rechecks lifecycle and claim ownership after the acknowledgement await in **both** acknowledgement consumers — `MessageQueue.clear()` resolves rather than rejects a cleared entry's acknowledgement, so the resume path can otherwise mark the durable delivery consumed for a successor | ~75 | ~50 |
| A3b | wire role arbitration at message-delivery.ts:97–139 + outbox, **preceded by the Phase 0 transactional ownership creation** — the deferred→enqueued status change and delivery-job insert commit together (the outbox path's existing shape) or carry an explicit compensating transition on enqueue failure, so routing through `resolveDeliveryRole` cannot leave an ownerless durable row (§5 Chain A Phase 0 note) | ~70 | ~65 |
| A3c | wire sweep at :2112 + timeout policy at message-queue.ts:105–128 | ~35 | ~30 |
| A4a | claim-fenced batch-update primitive (additive; covers the two unfenced batch writes §5 named) **plus the UUID/claim-keyed admission reservation for `admitWithId`** — idempotent admission with durable intent, so a retry under the same live claim cannot append a UUID twice and a crash after admission leaves a durable record replay can deduplicate against; A4b's staged pass consumes this reservation as its external-effect prerequisite; **both batch writes register compensations** so a later stage's failure after a valid partial write restores narrowed/submitted rows | ~80 | ~95 |
| A4b | stagedRun admission pass for driveDeliveryTurn (rearm loop stays in the shell); `ensureQueryStarted` inside the pass gets a **durable conditional startup intent plus idempotent/compensated spawn** (retry or crash after spawning leaves a durable record, not a duplicate or unowned query) — or startup moves ahead of the pass, decision pinned; a **full lifecycle / delivery-ownership / query-identity resnapshot runs immediately after the `ensureQueryStarted` await on both the `alreadyConsumed` and fresh/existing-entry paths** (cleanup, claim supersession, or replacement during startup must not install an observer or return `driving` for the wrong query; deterministic cleanup-during-startup pin), and the submitted-status publication uses deferred/transactional or versioned ordering so subscribers never observe a submitted state that admission may still unwind | ~105 | ~95 |
| A5 | cleanup: dead-code removal + ADR pilot note | ~10 | doc ~35 |

Order: A1\* → A2\* (A2c/A2d ∥ A2a/A2b) → A3\* → A4a → A4b → A5. All gated on
#2543 (§3) **and on the shared `agent-session.ts` facade being free of
in-flight B/C apply edits** — §4's one-chain-at-a-time constraint and the
Recommendation's "facade is free" condition survive #2543 merging.

### 8.5 Split discipline for the orchestrator

When a sub-PR still grows past budget mid-implementation, split by the same
axes used here — pins: by dimension family; cores: by exported module; apply:
by call-site region; hardening: by fenced invariant — not by arbitrary line
counts. A sub-PR that cannot fit ~150 production lines without dropping an
edge case is mis-scoped upstream: bring the edge case back as a table row or
a named invariant in the parent's scope, rather than widening the diff.
