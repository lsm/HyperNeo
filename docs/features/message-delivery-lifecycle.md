# Message Delivery Lifecycle

HyperNeo persists every user message to SQLite before handing it to the Claude
Agent SDK. This document describes the **durable delivery lifecycle** that
correlates a persisted message — by its stable SDK message UUID — across every
stage from persistence to turn completion, and the observability built on top
of it.

This is **phase 1** (task #859): establish end-to-end correlation and
observability _before_ introducing automatic retries. The goal is that a
developer can take any message UUID and identify exactly where it stopped, and
that the next phase can build idempotent delivery ownership on an explicit,
tested acknowledgment model.

## Why

Confirmed stranded messages (task #856) — input that was persisted but never
produced a response, in both ordinary chats and Space workflow sessions — had
no durable per-message trail. The `sdk_messages.send_status` column tracked
only `deferred → enqueued → consumed → failed` with a single timestamp, which
could not distinguish "wake attempted but query blocked" from "SDK accepted but
never produced output" from "delivered and completed." The lifecycle ledger
adds the missing stages and a queryable timeline.

## The contract: persistence, wake, acceptance, progress, completion

A message moves through distinct, independently-observable phases. Each phase
is recorded as an append-only row in the `message_delivery_lifecycle` table.
The phases are _not_ redundant: a message can stop at any one of them, and each
stop point implies a different failure mode and a different fix.

| Stage | Meaning | Recorded when |
|---|---|---|
| `persisted` | Message written to `sdk_messages` (`send_status` enqueued/deferred) | inside `Database.saveUserMessage` — the single chokepoint for every persistence path |
| `wake_requested` | Daemon called `ensureQueryStarted()` to deliver this message | `QueryLifecycleManager.startQueryAndEnqueue` (chat) and `TaskAgentManager.injectMessageIntoSession` (Space) |
| `accepted` | Message entered the in-memory `MessageQueue` (daemon claimed it) | `MessageQueue.onMessageEnqueued` callback (uniform across all enqueue sites) |
| `consumed` | SDK pulled the message from the input generator — the turn begins | `SDKMessageHandler` yielded/ack callbacks (`handleMessageYielded`, `consumePersistedUserMessage`, `acknowledgeOldestQueuedUserOnTurnEnd`) |
| `first_progress` | First assistant output for this message's turn | `SDKMessageHandler.handleMessage` on the first assistant message of the turn |
| `completed` | SDK emitted a terminal result for this message's turn (success or error) | `SDKMessageHandler.handleMessage` on a result message |
| `failed` | Delivery did not complete (timeout / orphaned-after-restart / delivery error / circuit-breaker trip / interrupt) | `QueryLifecycleManager` failure paths + `MessageRecoveryHandler` orphan recovery + `SDKMessageHandler` circuit-breaker trip + `MessageQueue.onClear`/`onMessagesRejected` (interrupt/reset) |

### Mapping to the delivery concept

- **Persistence** = `persisted`. The message is durably stored; nothing else
  has happened. Recorded in the **same transaction** as the `sdk_messages`
  insert, so a crash between them cannot leave a delivered message with no
  ledger row.
- **Wake** = `wake_requested`. Recorded **before** awaiting `ensureQueryStarted()`,
  so a startup/auth/MCP rejection still leaves a wake marker — a message with
  `wake_requested` but no `accepted` was waked but never claimed (e.g. blocked on
  `sdk_resume_choice` or a startup failure).
- **SDK acceptance** = `consumed`. The SDK has taken the message as input and
  begins a turn. (This is the boundary the next phase's idempotent ownership
  will key on: "did the SDK acknowledge this input?")
- **Progress** = `first_progress`. The SDK produced its first output for the
  turn.
- **Completion** = `completed` (turn ran to a terminal result) or `failed`
  (delivery never completed, or the turn was deliberately terminated by the
  circuit breaker with `detail.reason = 'circuit_breaker_trip'`).

### Terminal attribution across shared turns

A single SDK turn can consume several **steered** messages before one terminal
result ends it (e.g. a user sends a follow-up while the agent is mid-response).
The terminal event — `completed` on the result, or `failed` on a circuit-breaker
trip — is attributed to **every** message consumed since the previous terminal
event, not just the latest. Without this, earlier steered messages would sit at
`consumed`/`first_progress` forever and read as stale.

### Cancellation

When a user removes a pending message (`session.messages.removePending` /
`Database.deletePendingUserMessage`), its lifecycle rows are deleted so an
intentionally-cancelled message does not pollute `unclaimed`/`stale`. There is
no `cancelled` stage; the timeline simply ends.

> **Note on `completed` vs model errors:** a terminal result is recorded as
> `completed` regardless of whether it is a success or an error
> (`detail.success` carries the outcome). Either way the message _was delivered
> and a turn ran to completion_ — that is the delivery-reliability signal. The
> `failed` stage is reserved for delivery-level failures: the SDK never
> consumed the message (timeout), or it was orphaned by a daemon restart, or
> the enqueue itself errored.

## Delivery paths all converge

Three entry channels — ordinary chat, Space node `send_message` / external-event
delivery, and daemon-restart replay — all reduce to the same final primitives:
`Database.saveUserMessage` (→ `persisted`) and `MessageQueue.enqueueWithId`
(→ `accepted` via the callback). The SDK consumes via `onMessageYielded`
(→ `consumed`). Because `persisted` and `accepted` are recorded at these
chokepoints, **every delivered message enters the ledger regardless of which
channel it arrived through**, including the Space/external-event paths that do
not go through `startQueryAndEnqueue`.

`wake_requested` is recorded at the two primary submit entry points
(`startQueryAndEnqueue`, `injectMessageIntoSession`); the recovery-replay path
(`QueryModeHandler`) and the rare inline injector paths rely on the
`accepted`/`consumed` chokepoints for coverage.

## Querying

### Timeline for a single message

```
db.messageDeliveryLifecycle.getTimeline(messageId)
```

Returns the ordered stages for a UUID — the direct answer to "where did this
message stop?"

### Diagnostics

```
db.messageDeliveryLifecycle.getDiagnostics({ sessionId?, staleMs?, sinceMs?, scanWindowMs? })
```

Returns:

- `totalsByLatestStage` — count of messages whose latest stage is each stage.
- `unclaimed` — messages that are `persisted`/`wake_requested` but never
  reached `accepted` (the daemon never claimed them into its queue). These are
  the strongest stranded signal.
- `stale` — messages whose latest stage is non-terminal and older than
  `staleMs` (default 60s).
- `latency` — `wakeToAccept`, `acceptToConsumed`, and `acceptToFirstProgress`
  summaries (count / avg / max) over recent traffic (`sinceMs`, default 1h).

The stuck-message / latest-stage scan is bounded by `scanWindowMs` (default 24h):
the ledger is append-only, so an unbounded daemon-wide scan would grow with
history. Stuck messages older than the window are invisible to this query —
raise `scanWindowMs` or enforce retention via `deleteOlderThan(cutoffMs)`.

> **Latency caveat (phase-1 limitation):** the latency summaries pair the first
> recorded source stage with the first target stage across all delivery
> attempts. Under the existing queue-timeout retry, source and target can come
> from different attempts, overstating latency by the retry gap. The
> authoritative per-attempt timeline is `getTimeline`; phase 2 (delivery-attempt
> IDs) will make these aggregates attempt-correct.

Both are also exposed as read-only RPCs for runtime inspection:

- `messageDelivery.diagnostics` `{ sessionId?, staleMs?, sinceMs?, scanWindowMs? }`
- `messageDelivery.timeline` `{ messageId }`

## The stranded shape

A message is "stranded" when it is persisted (and possibly accepted/consumed)
but the session is idle and no assistant/system progress followed. The
diagnostics surface this directly:

- A message stuck at `persisted` or `wake_requested` appears in `unclaimed`.
- A message stuck at any non-terminal stage appears in `stale`.
- A message that was `consumed` but whose daemon crashed before the SDK
  responded is marked `failed` with `detail.reason = 'orphaned_after_restart'`
  by `MessageRecoveryHandler` on the next session load — but only if it hadn't
  already reached a terminal stage (`completed`/`failed`) in the ledger.
- A turn interrupted/reset before a terminal result has its consumed messages
  marked `failed` with `detail.reason = 'interrupted'` via `MessageQueue.onClear`.
  **Accepted-but-unconsumed** messages — still in the in-memory queue when a
  `clear()` rejects them — are terminalized the same way via
  `MessageQueue.onMessagesRejected`, so an intentional cancel/interrupt doesn't
  leave them stuck at `accepted` reading as stale. `stop()` alone (normal turn
  end, session teardown) does NOT terminalize them: it leaves queued messages
  deliverable, so a steered message yielded just after its predecessor's result
  would otherwise collect a spurious `failed` before its `consumed`. A
  user-cancelled pending message (`session.messages.removePending`) is exempt:
  it leaves the queue via `MessageQueue.remove`, its ledger rows are deleted,
  and a later clear does not resurrect it.
- **Intentionally-deferred** messages (manual mode, or deferred while the session
  is busy/rate-limited) are excluded from `unclaimed`/`stale`: their `persisted`
  event carries `sendStatus: 'deferred'`, and no delivery was expected until
  replay. They surface again once waked/accepted.

**Phase 1 does not add automatic retry.** The ledger exists to produce reliable
evidence and correlation first; the next phase builds idempotent ownership and
retries on top of the `consumed` acknowledgment recorded here.

## Internal vs tracked messages

The lifecycle ledger tracks _user-message deliveries_ only. SDK-internal
messages (recovery instructions, tool-result echoes enqueued via
`MessageQueue.enqueue` with `internal: true`) are excluded — they are not
persisted user input and are not part of the delivery contract. The
`onMessageEnqueued` callback receives the `internal` flag and skips recording
for them.

## Known limitations (phase 1)

These are explicit, documented deferrals — consistent with the phase-1 goal of
establishing evidence and correlation before adding retries/ownership:

- **Latency across attempts** — the `MIN` pivots pair stages across delivery
  attempts; under the existing queue-timeout retry the aggregate can overstate
  latency by the retry gap. `getTimeline` is per-attempt authoritative; phase 2
  (delivery-attempt IDs) makes the aggregates attempt-correct.
- **Retention is caller-driven** — `deleteOlderThan` is provided but not
  auto-invoked; retention policy (cadence + age) is phase 2. It preserves
  terminal (`completed`/`failed`) evidence for any message whose sdk_messages row
  is still `send_status = 'consumed'`: since `send_status` has no delivered
  state, recovery relies on that ledger record to avoid re-orphaning a delivered
  message after a restart, so retention must not prune it.
- **Synthetic Space deliveries and orphan recovery** — node-to-node and
  long-horizon injectors persist ordinary text inputs with `isSynthetic: true`,
  and `MessageRecoveryHandler`'s pre-existing `isSynthetic` exclusion skips them
  when surfacing consumed-but-unanswered orphans. They therefore receive no
  terminal lifecycle event after a mid-turn restart (mirroring the pre-existing
  sdk_messages recovery gap). Broadening recovery to synthetic Space inputs is a
  separate, pre-existing concern.
- **Phantom `accepted` for synthetic enqueues** — an `AskUserQuestion`
  tool-result enqueue uses a non-persisted UUID and may record an `accepted`
  event. Marking it `internal` would suppress this but also skips `setProcessing`
  for the resumed answer turn (overlapping-send risk), so phase 1 accepts the
  low-signal phantom; it never receives `completed` (terminal attribution uses
  the consumed set only).
- **Rate-limit cooldown retries** — a 429 that schedules watchdog recovery does
  not record a terminal for the turn at teardown (it is `'retry_pending'`, so the
  retried delivery re-records `consumed` and can still reach `completed`). Both
  runners (`QueryRunner`, `AcpQueryRunner`) clear/stop the queue with the
  `'retry_pending'` reason only AFTER the 429 classification, and carry the flag
  across the provider/startup retry recursion so a cooldown classified in a
  nested attempt is respected by the outer frame's teardown too. The watchdog's
  re-enqueue re-registers the UUID via the idempotent consumed primitive, so a
  success ends at `completed`; a cooldown that is never retried (user cancels,
  session stops) leaves the turn's latest stage non-terminal (e.g. `consumed`)
  and it surfaces as stale — hardening the cooldown cancellation terminal is
  phase 2 (delivery-attempt ownership).

