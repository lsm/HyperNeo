# Message Delivery v2 — Durable Delivery on `job_queue`

- **Status:** **Default-on** (opt out with `HYPERNEO_MESSAGE_DELIVERY_V2=0`). Supersedes the incremental approach in [`message-delivery-lifecycle.md`](./message-delivery-lifecycle.md) (task #859 phase 2).
- **Date:** 2026-08-08
- **Owners:** Marc Liu; design input from Reviewer pass (rounds 1–28)

---

## Default-on & rollback

Message-delivery v2 is the **default** dispatch path. Every primary kickoff —
ordinary chat (`message.persisted` → `AgentSession.deliverChatMessage`) and the
Space / long-term-agent / task-agent injectors — routes through the
`deliverMessage` chokepoint so each user message becomes one durable
`message_delivery` job_queue row with atomic single-owner claim, lease
heartbeat, `reclaimStale` crash recovery, and `(session, UUID)`-scoped
consumption acknowledgment.

**Roll back without a redeploy** by setting, before daemon start:

```
HYPERNEO_MESSAGE_DELIVERY_V2=0     # or =false
```

With the flag off, `isMessageDeliveryV2Enabled()` (read at runtime in
`packages/daemon/src/lib/agent/message-delivery.ts`) returns false and every
entry point falls back to the legacy inline path it owned before v2:

- Ordinary chat: `message.persisted` → `startQueryAndEnqueue` (inline
  `ensureQueryStarted` + `enqueueWithId`) instead of `deliverChatMessage`.
- Space / long-term-agent / task-agent injectors: `ensureQueryStarted` +
  `enqueueWithId` instead of `deliverAndMarkQueued`.

The legacy deferred-message replay, UI promote-deferred, and rate-limit
auto-retry kickoffs stay on the inline path under both modes (they are the
explicit follow-up migration; `recoverOrphanedConsumedMessages` is retained as
their crash backstop and carries a `durableOwned` guard so it never fights v2-
owned messages). The flag is read at runtime (no persisted-config skew), so an
operator can flip it and restart to recover without a code change.

---

## 1. Problem

Phase 1 added an append-only `message_delivery_lifecycle` ledger for delivery
observability on top of the existing in-memory `MessageQueue`. The in-memory
queue and the durable store (`sdk_messages` + the ledger) are **two sources of
truth**, and the code must reconcile them.

That reconciliation is structurally a long tail. Over 28 review rounds, every
finding was the same root cause phrased differently: *transient queue state
(a generation bump, a 429, a startup timeout, a model switch) left the durable
state inconsistent.* Fixes accreted new state — `onMessageTerminal`,
`isRateLimitRecoveryPending`, `_consumedUserMessages`, the `retryPending`
rejection marker, post-await ownership guards, transfer/abandon branches in
both runners — that then needed **its own** reconciliation, which the next
round found on a sibling path. When fixes add state instead of removing it,
you are fighting the design, not implementing it.

## 2. Goal

Ground delivery **ownership, retry, crash-recovery, idempotency, and
diagnostics** in one durable place — the codebase's existing `job_queue`.
Demote the in-memory `MessageQueue` to pure transport. Every user message —
new-turn or steered — takes one unified durable path.

## 3. Non-goals

- Changing the SDK streaming generator (it stays the live transport).
- Changing `sdk_messages` (it stays the content/transcript store).
- Per-attempt latency dashboards / sub-stage timeline granularity.

## 4. Why `job_queue`

`job_queue` (`packages/daemon/src/storage/`) is a durable, SQLite-backed work
queue. The "job" name is incidental — the payload is arbitrary JSON, a "queue"
is just a named lane. It already provides what delivery needs:

| delivery need            | `job_queue` primitive                                                |
| ------------------------ | ------------------------------------------------------------------- |
| atomic claim (no double) | `dequeue`: `SELECT pending + UPDATE→processing` in one transaction  |
| retry + backoff + dead   | `fail()` → `2^retryCount·1s` → `dead`                               |
| crash recovery           | `reclaimStale`: `processing→pending` on startup + every 60s         |
| idempotent enqueue       | `enqueueUniquePending(matchPayload)`                               |
| scheduling               | `runAt`                                                             |
| priority / concurrency   | `priority`, `maxConcurrent`                                         |
| retention                | `cleanup(beforeMs)`                                                 |

It is battle-tested by `memory-consolidation`, `cleanup`,
`goal-automation-execute`, `task-schedule-fire`,
`long-horizon-agent-reminder-fire`, and `github-poll`. Reusing it collapses
the entire "in-memory vs store disagreement" bug class at the source: there is
one durable claim, atomic, no race to reconcile.

### 4a. Why not just use `sdk_messages` as the queue?

`sdk_messages` is durable storage, but it is the **transcript** —
rendering/UI-coupled (visible-message-count, conversation turns, badges). It
lacks claim/retry/reclaim/scheduling, and adding them there means reinventing
`job_queue` inside a transcript table, while coupling delivery lifecycle to
rendering history. That coupling is exactly what produced the
`send_status`-vs-ledger drift in phase 1 (a `failed` terminal in the ledger
while `send_status` stayed `consumed`).

The clean cut: **`sdk_messages` = content; `job_queue` = thin delivery
lifecycle referencing it by UUID.** No duplication, clean separation.

## 5. Architecture

```
┌─ DURABLE TRUTH (survives restart) ──────────────────────┐
│  job_queue  (lane: "message_delivery")                  │
│   one row per delivery · pending→processing→completed   │
│   atomic claim · retry+backoff · reclaimStale · dedup   │
└──────────────────────────────────────────────────────────┘
            │ claim (dequeue)              ▲ complete/fail
            ▼                              │
┌─ DELIVERY HANDLER (new) ─────────────────────────────────┐
│  message-delivery.handler.ts                             │
│   owns one job → routes by session state:                │
│     idle   → drive a new turn (feed transport, await)    │
│     active → feed the live transport as a steer          │
└──────────────────────────────────────────────────────────┘
            │ yields messages              ▲ result/progress
            ▼                              │
┌─ IN-MEMORY TRANSPORT (ephemeral, never authoritative) ───┐
│  MessageQueue.messageGenerator()   [KEPT as transport]   │
│   restarts empty · mid-turn steering lives here          │
└──────────────────────────────────────────────────────────┘
```

The in-memory queue is **demoted to transport**. It holds nothing
authoritative; on restart it is empty and the durable queue re-issues. Every
phase-1 bug required the in-memory set to be reconciled with the store — with
this layering that is no longer expressible.

## 6. Schema — reuse `job_queue`, add one index

No new table. Use lane `"message_delivery"`. Payload is a **thin reference**
(content stays in `sdk_messages`):

```ts
payload: { sessionId, messageUuid, role: 'turn' | 'steer', origin, parentToolUseId? }
```

One new partial unique index — the DB-guard that enforces "one active turn
per session" **and** decides role atomically:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS uq_message_delivery_active_turn
  ON job_queue (queue, json_extract(payload, '$.sessionId'))
  WHERE queue = 'message_delivery'
    AND json_extract(payload, '$.role') = 'turn'
    AND status IN ('pending', 'processing');
```

Steers (`role = 'steer'`) are excluded, so they coexist with the active turn.

**Two creation paths (both required):** the index is created in (a) `createIndexes`
(the fresh-DB path, reached via `createTables`) AND (b) migration 182 (the
existing-DB upgrade path). `runMigrations` runs BEFORE `createTables`
(`database-core.ts`), so on a fresh install migration 182 early-returns (no
`job_queue` yet) — without the `createIndexes` copy the index would be absent and
every turn insert would succeed (no steers). See Codex (#3742693688).

## 7. Unified entry — `deliverMessage`

Every origin (ordinary chat, `injectMessageIntoSession`, `spaceAgentInjector`,
`injectLongTermAgentMessage`, `startQueryAndEnqueue`) calls one chokepoint:

```ts
deliverMessage(sessionId, messageUuid, content, origin):
  1. saveUserMessage(sessionId, ...) → sdk_messages         // content (already durable)
  2. try:
       jobQueue.enqueue({ queue:'message_delivery',
                          payload:{ sessionId, messageUuid, role:'turn', origin } })
     catch UNIQUE (uq_message_delivery_active_turn):
       jobQueue.enqueue({ ..., role:'steer' })              // DB index is the role arbiter
```

The index conflict is the atomic role decision — no app-level race between
"check session state" and "insert." If a turn exists → steer; if not → turn.
A parked/blocked turn-job still counts as active, so a message arriving during
`sdk_resume_choice` correctly becomes a steer, not a competing turn.

## 8. Handler — `message-delivery.handler.ts`

Registered in `app.ts` next to the other `jobProcessor.register(...)` calls
(~line 929). `maxConcurrent` sized for cross-session parallelism;
**per-session serialization** via an in-process session lock (two worker slots
could otherwise claim a turn + its steer concurrently):

```ts
jobProcessor.register(MESSAGE_DELIVERY, async (job) => {
  const { sessionId, messageUuid, role } = job.payload;
  return withSessionLock(sessionId, async () => {
    if (role === 'turn') return driveTurn(sessionId, messageUuid, job);

    // role === 'steer'
    if (stateManager.getState(sessionId).status !== 'processing') {
      // turn ended between enqueue and claim → promote to the next turn
      jobQueue.enqueue({ queue:'message_delivery',
                         payload:{ ...job.payload, role:'turn' } });
      return repo.complete(job.id, { superseded: true });
    }
    return feedSteer(sessionId, messageUuid, job);
  });
});
```

- `driveTurn`: `ensureQueryStarted()` → `'blocked'` ⇒ return job to pending
  with `runAt = now + park` (no 30s-timeout-then-fail). Else feed transport →
  await SDK result → `repo.complete(job.id)` on success / `repo.fail(job.id,
  reason)` on error (queue does backoff → `dead`).
- `feedSteer`: `await session.messageQueue.enqueueWithId(messageUuid,
  content)` — resolves on `onSent` (SDK consumed) → `complete`; rejects on
  clear/turn-end/error → `fail` (retry re-feeds or promotes).
- `withSessionLock`: in-process `Map<sessionId, Mutex>`. Keeps steer-feeds out
  of the brief turn start/stop windows (generator not yet ready, queue being
  cleared). The feed itself is concurrent-safe; the lock guards lifecycle
  transitions.

## 9. Steering — detailed semantics

Steering = a user message sent while the agent is mid-turn. It must feed the
**active turn's** live SDK generator (not start a new turn), and it must be
**durable** (crash/error before SDK consume → redeliver).

### Lifecycle

**Enqueue** — same `deliverMessage` chokepoint as turns (§7). Role is decided
by the DB index: the `role:'turn'` insert either succeeds or hits
`uq_message_delivery_active_turn`, in which case it is inserted as
`role:'steer'`. Atomic, no race.

**Claim + process:**

1. Claim via dequeue (**FIFO within session** — §11 wrinkle).
2. Acquire `withSessionLock`.
3. If no active turn (it ended between enqueue and claim): re-enqueue the
   payload as `role:'turn'` (promote), complete this steer-job
   `{superseded:true}`.
4. Else: `await messageQueue.enqueueWithId(messageUuid, content)`.
   - resolves (`onSent` / SDK consumed) → `repo.complete(job.id)`.
   - rejects (clear / turn-end / error) → `repo.fail(job.id, reason)` → retry
     → re-feed (if active) or promote (if idle).

### Completion = SDK consume (the crux of durable steering)

The steer job completes when the SDK **consumes** the message, not when it is
fed to the transport. `enqueueWithId` already returns a promise that resolves
on `onSent` (the generator's yield-callback), so `await enqueueWithId(...)`
**is** the "delivered" signal. The job stays `processing` across the await, so
a crash before consume → `reclaimStale` → redelivered. The original turn never
consumed it (it crashed), so there is no duplicate — effectively exactly-once
for the crash case.

Both phase-1 requirements are satisfied: **unified path** (every message is a
`job_queue` row) **+ durable redelivery** (processing until SDK consume, then
reclaimStale).

### Cross-slot concurrency

The steer-job and its turn-job run in different `JobQueueProcessor` slots, but
it is one Node event loop: the turn handler is suspended at `await sdkResult`,
the generator suspended at `yield`. When the steer handler calls
`enqueueWithId`, the generator resumes, yields the steer, the SDK consumes it,
`onSent` resolves the steer's await. No cross-process coordination —
cooperative scheduling within the daemon.

## 10. Recovery & scheduling — free

- **Crash recovery** = `reclaimStale` (already runs eagerly on startup + every
  60s). A `processing` delivery whose daemon died goes back to `pending`.
  **Delete `recoverOrphanedConsumedMessages`.**
- **Retry** = `fail()` → exponential backoff → `dead`. Delete the bespoke
  retry branches, `_consumedUserMessages`, and the `autoRetryPending` /
  `rateLimitCooldownPending` machinery.
- **Scheduling** = `runAt` for parked/blocked/resume-choice. Delete the
  30s-enqueue-TTL-then-fail hacks.

## 11. Diagnostics — re-point the RPCs

`messageDelivery.diagnostics` (`rpc-handlers/index.ts:827`) and
`messageDelivery.timeline` (`:841`) become thin `job_queue` queries:

- **unclaimed** = `pending` with old `created_at`
- **stale** = `processing` past the stale window
- **failed** = `dead`
- **timeline** = the job's status transitions + `error` / `retryCount`

No `message_delivery_lifecycle` table; no migrations 181/182.

## 12. Migration sequence (off the current PR)

1. Add the lane + index + handler + `deliverMessage` behind a flag. Route
   **ordinary chat** first.
2. Migrate the Space injectors onto `deliverMessage`.
3. Re-point diagnostics RPCs at `job_queue`.
4. **Decommission:** drop `message_delivery_lifecycle` (+ migrations
   181/182), drop `recoverOrphanedConsumedMessages`, and delete the accreted
   reconciliation machinery: `autoRetryPending`, `rateLimitCooldownPending`,
   `isRateLimitRecoveryPending`, `_consumedUserMessages`, `onMessageTerminal`,
   the `retryPending` rejection marker, the post-await ownership guards, and
   the transfer/abandon branches in both runners. The durable claim makes
   them all unnecessary.

Each step is independently shippable; the flag lets ordinary chat move first
while Space injectors and recovery are migrated incrementally.

## 13. Conformance tests (lifted from the 28 review rounds)

Each phase-1 finding becomes a test the new design must pass **by
construction**:

- double-fault survives a second error (retry budget = `job_queue.fail`, not a
  counter)
- retry-pending never double-delivers (atomic claim)
- crash mid-delivery → redelivered (`reclaimStale`)
- blocked resume-choice → parked, not failed (`runAt`)
- multi-prompt / steered → all delivered (turn drains its steers, FIFO)
- consumed-then-clear races → **untestable** (no in-memory truth to diverge)
- ledger / `send_status` drift → **untestable** (one status column)

The 28 rounds are not wasted — they are a precise spec of every interleaving
the delivery path must handle.

## 14. Decisions

1. **Reuse `job_queue` directly** (no sibling table).
2. **Per-session serialization** via the partial unique index (DB-guard) +
   in-process session lock.
3. **Steering unified** — every message is a `job_queue` row; role decided by
   the DB index; completion = SDK consume.
4. **No timeline granularity** beyond `job_queue` status transitions (no event
   log, no ledger).

## 15. Open implementation specifics

- **Steer slot occupancy (resolved):** steers are now claimed in a separate
  processor "exempt" pass that is NOT subject to `maxConcurrent`, so a mid-turn
  steer reaches the live turn even when every capped slot is driving a turn
  (the turn-job no longer starves steers). `dequeue(exclude=steer)` leaves steers
  for `dequeueExempt`; both share a separate exempt budget so neither starves the
  other. See `JobQueueProcessor.tick` + Codex (#2587).
- **FIFO within a session (resolved):** `job_queue.dequeue` orders by
  `priority DESC, run_at ASC, created_at ASC` — the `created_at` tiebreaker
  delivers same-priority steers/turns in send order.
- **30s `enqueueWithId` TTL (resolved):** delivery feeds call `enqueueWithId` with
  `{ durable: true }`. The TTL still fires, but for a **yielded** message (the SDK
  already holds the UUID) it RESOLVES instead of rejecting — a reject → retry →
  re-feed would execute the user's request twice. A never-yielded message still
  rejects (genuine stall; a retry cannot duplicate). `reclaimStale` remains the
  crash-liveness check. See `MessageQueue` + Codex (#3742616720).

### 15a. Resolved this iteration (Codex holistic pass)

- **Consumed kickoff not re-fed (#2592):** the handler loads `send_status` and,
  on reclaim of a `consumed` turn, drives it with `alreadyConsumed` (no feed) —
  the SDK resume-from-history already holds it, so re-feeding would duplicate.
  `deferred`/`failed` messages are skipped outright. **Caveat (Codex follow-up):**
  this applies to CRASH RECLAIM only. When the bridge CONFIRMS a driven turn
  produced no result (recoverable error or stall reset), it flips the row back to
  `enqueued` (`markDeliveryRetryableByUuid`) so the automatic retry RE-FEEDS — a
  resumed query only loads history; it does not continue an incomplete trailing
  user turn, so a no-feed re-drive would burn the retry budget without another
  provider attempt (the rate-limit recovery path re-enqueues for the same reason).
- **Dead-letter → `failed` (#2595):** the lane's `onDead` hook marks the
  persisted message `send_status='failed'` + publishes, so an exhausted job
  surfaces a terminal error instead of vanishing behind pagination.
- **Shutdown requeue (#2593):** `app.cleanup()` requeues in-flight
  `message_delivery` jobs to pending before draining the processor, so they're
  instantly reclaimable on the next boot (not stuck `processing` with a fresh
  heartbeat for the 5-min stale window, nor misrouting new prompts as steers).
- **Queued state on park (#2599):** a blocked startup (sdk_resume_choice) calls
  `stateManager.setQueued` before parking, so the session reports queued (not
  idle) and later deferrals are honored.
- **Archived sessions (#3742616723):** the handler rejects delivery (completes,
  does not drive) for sessions whose persisted status is `archived`.
- **Dedicated delivery budget (#3742774839):** `message_delivery` runs on its own
  `JobQueueProcessor` instance (`HYPERNEO_MESSAGE_DELIVERY_MAX_CONCURRENT`, default
  64), so long-lived turns no longer share/starve the main processor's budget
  (task schedules, long-horizon reminders, GitHub polling, cleanup, memory
  consolidation). Steers still exempt-bypass the delivery budget. Cross-lane
  contention is now zero.
- **Archive barrier + revalidate-before-feed (#3742774841, #3696):** the archive
  path cancels jobs at the START (phase 0), `deliverChatMessage` skips enqueue
  for already-archived sessions (enqueue-time barrier), and the bridge
  revalidates (session not archived AND message still `enqueued`) under the
  per-session lock immediately before feeding — closing both the archive TOCTOU
  and the removePending TOCTOU as one pattern. An invalid feed returns `aborted`
  (complete, do not feed).

---

## 16. Phase 3 hardening (task #861) — recovery, outbox, exactly-once quality

Delivery semantics stay **at-least-once**. Phase 3 closes the remaining
correctness and observability gaps, not by rewriting the reclaim/re-feed model
but by hardening it.

- **Transactional outbox (item 2):** ordinary chat now saves the user message
  AND enqueues its `message_delivery` job in one `db.transaction`
  (`persistAndEnqueueDelivery`, `lib/agent/message-delivery-outbox.ts`). A crash
  between save and enqueue can no longer strand a saved-but-not-enqueued row —
  the gap is eliminated by construction. `saveUserMessage` is split into a
  composable `saveUserMessageCore` (the tx body) + `runPostSaveSideEffects`.
- **Synchronous consumed-flip (item 12):** the bridge flips `send_status →
  'consumed'` synchronously the moment the SDK acknowledges consumption (onSent),
  before any further await (`markDeliveryConsumedByUuid`). The at-least-once
  duplicate window [SDK yield, persisted consumed-flip] shrinks to sub-ms, so
  `reclaimStale` almost always observes `'consumed'` and the status-aware reload
  skips the re-feed.
- **Migrated kickoff paths (items 3 + 14):** the legacy inline kickoffs
  (`handleQueryTrigger`, `sendEnqueuedMessagesOnTurnEnd`, the
  `session.messages.promotePending` RPC) route through `deliverMessage` instead
  of `ensureQueryStarted` + `enqueueWithId`, so a manual-flush / turn-end-replay
  / promoted "next turn" message flows through the durable owner with the full
  at-least-once + synchronous-consumed-flip guarantees. The dormant
  `query.sendEnqueuedOnTurnEnd` event (declared but never published) is removed.
  `executeRateLimitAutoRetry` stays on `startQueryAndEnqueue`: it is in-band
  recovery within an active durable turn (the job stays `processing`; coordinated
  via `suppressDeliveryWaiters`), so `deliverMessage` would no-op there.
- **Orphan reconciler (item 4):** `reconcileStrandedDeliveries`
  (`lib/agent/message-delivery.ts` + the `AgentSession` wrapper) recovers the one
  case `job_queue` cannot see by itself — a persisted user message stuck
  `enqueued` with no active `message_delivery` job (the #856 stranded-pending
  shape). It re-enqueues the SAME canonical UUID (never a second user row;
  content is reloaded from storage), is idempotent + safe under concurrent
  ticks/workers, and runs on each idle transition, on a periodic unref'd 60s
  timer, and as a startup pass. It also settles stale `submitted` rows →
  `failed` (orphaned ACP) so they surface.
- **Decommission (item 7):** `recoverOrphanedConsumedMessages` is deleted
  (`message-recovery-handler.ts` + its test + the `AgentSession` call). Its
  consumed-orphan responsibility moved to the durable owner (`reclaimStale`
  re-drives `consumed` via `alreadyConsumed`); its submitted-orphan
  responsibility moved to the reconciler. The legacy-owned-turn guards and the
  now-dead `hasActiveTurnDelivery` repo method are removed — with every kickoff
  path on `deliverMessage`, every v2 turn is a durable turn job and the unique
  index is the sole role arbiter.
- **Lease + reclaim (item 5):** a slow-but-alive turn (long MCP startup / model
  startup / provider request) is never falsely reclaimed — the handler
  heartbeats `started_at` (`touchStartedAt`, every 60s) throughout the turn
  await, well inside the 5-min stale window; `reclaimStale` only reclaims jobs
  whose handler stopped heartbeating (a crash). The status-aware reload then
  prevents a duplicate feed on re-drive. Covered by a regression test. A
  reclaim pass that unfreezes a whole crash herd also jitters each re-enqueued
  job's `run_at` across a randomized [0, min(M·2s, 30s)] window
  (`staleReclaimJitterDelays` in `job-queue-processor.ts`): N simultaneous SDK
  cold-starts (each resuming a large transcript) all blow the 15s startup
  timeout and self-sustain a retry loop, so replacement claims must roll
  rather than stampede; a single reclaimed job is re-enqueued with no delay.
- **Backoff / cancel / terminal (item 8):** bounded exponential backoff + max
  attempts + terminal failure come from the lane (`fail()` → `2^retryCount·1s` →
  `dead` → `onDead` → `send_status='failed'`). User-cancelled messages are not
  retried — interrupt cancels the session's delivery jobs and terminalizes the
  rows (`InterruptHandler.handleInterrupt`), so the reconciler never re-enqueues
  them. Archived sessions are rejected outright by the handler's
  `isSessionArchived` guard.
- **Operational diagnostics (items 6 + 13):** the `messageDelivery.diagnostics`
  RPC is a thin `job_queue` query (status counts: pending = unclaimed,
  processing = stale, dead = failed) paired with the exactly-once observability
  snapshot (`DeliveryMetrics`): feed-count-per-UUID (ground-truth duplicate
  detector — any UUID handed to the SDK >1 time is a real breach, since the SDK
  does not dedup), reclaim-outcome breakdown (`alreadyConsumed`/`alreadySubmitted`
  skips = duplicates prevented; `stillEnqueued` = re-drive; `noContent`), and
  residual-window latency P50/P99. Because at-least-once accepts duplicates,
  these metrics are how we know when the accepted failure actually happens.

## 17. Phase 4 — delivery state in the UI (task #862)

Phase 3 made delivery ownership durable and recoverable but kept the lifecycle
hidden: a user message was invisible in the transcript until it reached
`consumed` (or `failed`), so users inferred "stuck" state from system/init
messages. Phase 4 surfaces the lifecycle explicitly and retires nothing the
generic reconciler does not already cover.

### Delivery status model

A shared `MessageDeliveryStatus` (`queued | processing | retrying | delivered |
failed`) is mapped from `send_status` (+ the active `message_delivery` job's
`retry_count` for `retrying`) by `sendStatusToDeliveryStatus` in
`packages/shared`. The mapping:

| `send_status` | active job `retry_count > 0`? | `MessageDeliveryStatus` |
|---------------|-------------------------------|-------------------------|
| `deferred`    | no / yes                      | `queued` / `retrying`   |
| `enqueued`    | no / yes                      | `queued` / `retrying`   |
| `submitted`   | no / yes                      | `processing` / `retrying` |
| `consumed`    | —                             | `delivered`             |
| `failed`      | —                             | `failed`                |

### Feed changes

`messages.bySession` and `spaceTaskMessages.byTask(.compact)` now:

- **Widen visibility** so `deferred`/`enqueued`/`submitted` user rows appear
  (previously filtered to `consumed`/`failed`). Daemon-side reads
  (`SDKMessageRepository.getSDKMessages`) keep the old filter, so prompt context
  and rewind see only settled rows — only the web transcript feed widens.
- **Emit `deliveryStatus`** (ordinary chat) / the full lifecycle (Space threads,
  expanded from `delivered`/`failed`) via the shared mapper.
- **Surface retrying** through a session-scoped `EXISTS` against the active
  `message_delivery` job (`retry_count > 0`), bounded by
  `idx_message_delivery_session_active`.

The widened feed also gives a natural **optimistic echo with no web-side
optimistic insert**: the persisted `enqueued` row appears within milliseconds of
send via the reactive-DB flush, then transitions in place by its stable row id.
A `send_status` UPDATE emits an `updated` delta on the SAME row — never a
duplicate `added` — so retry / state changes update the one visible message
(covered end-to-end by `live-query-delivery-status.test.ts`).

### UI

`SDKUserMessage` renders a `DeliveryStateBadge` for `queued` / `processing` /
`retrying` / `failed`; `delivered` hides the badge to avoid noisy indicators on
normal fast delivery. `DeliveryStateBadge` is generalized to cover both
`MessageDeliveryStatus` and `ActorMessageDeliveryState` so the chat and Space
thread surfaces share one visual language.

### Steer-consumed propagation (item 11)

A steer's SDK-consumed signal is `onSent`. `feedDeliverySteer` already flips
`send_status → consumed` synchronously at `onSent` (phase 3, item 12) and
publishes `messages.statusChanged`; the reactive DB detects the column change
and the widened feed now shows the steer row transitioning `queued → processing
→ delivered` rather than appearing only after consumption. No additional emit
is needed — the certain/consumed state is terminal for delivery under the
at-least-once model. (ACP's consume boundary is acceptance, handled by
`markMessageAccepted`, unchanged.)

### Wake / recovery audit (items 6 + 7)

Audited the Space runtime for wake/retry logic now potentially redundant given
the generic reconciler. Conclusion: **no demonstrably redundant mechanism
remains** — the agent-level duplicate (`recoverOrphanedConsumedMessages`) was
already decommissioned in phase 3. The surviving Space recovery paths each own
a distinct failure mode and inject *system*-origin messages (not stranded-user
re-deliveries), so they do not duplicate `reconcileStrandedDeliveries`:

- non-terminal-idle **nudge** / runtime **nag** / terminal-error **continue** —
  an agent that went idle or errored mid-work (no stranded user message to
  re-deliver; the reconciler has nothing to act on);
- **restart-notice** — post-restart rehydration;
- **external-event digest requeue** (`requeuePersistedPendingDeliveries`) — the
  separate external-event delivery store, not the `message_delivery` lane;
- `/compact` injection.

Per the task's "remove only demonstrably redundant workarounds; retain
Space-specific orchestration semantics," these are retained.

### Reactivity scoping (review hardening)

The retry signal makes `job_queue` a dependency of every transcript/task feed.
To avoid every unrelated job (schedules, cleanup, polling, workflow) re-running
all open feeds, the change notifiers are scoped:

- `messageDeliveryProcessor.setChangeNotifier` notifies `job_queue` SESSION-scoped
  (derived from the delivery job payload's `sessionId`), so only that session's
  feed re-evaluates — the retry-signal reactivity stays correct.
- The generic `JobQueueProcessor` (non-delivery lanes) passes the scope through
  when a job payload carries `sessionId`/`taskId`; the app-level generic notifier
  is a no-op for `job_queue` since no feed depends on it outside `message_delivery`.

### Turn anchoring (full feed)

The full `spaceTaskMessages.byTask` feed emits pending (deferred/enqueued/
submitted) rows for their delivery badge, but only SETTLED (consumed/failed)
user rows become `turnUserMessageId` sentinels — `saveUserMessageCore` withholds
a conversation anchor until the row settles, and subsequent assistant rows must
not inherit a pending prompt's id as their turn.

### Interrupt / revoke reactivity

`handleInterrupt` (cancel-everything path) and `revokePendingDelivery` both
write through the raw db — cancelling `job_queue` rows and flipping `sdk_messages`
statuses — and both now `notifyChange('sdk_messages' | 'job_queue')` session-scoped
after the lock closes, so the widened delivery feeds drop the queued/retrying
badge immediately instead of staying stuck until an unrelated write or reconnect.
`message_delivery` jobs' payloads carry `sessionId`, which the processor derives
into the change scope.
