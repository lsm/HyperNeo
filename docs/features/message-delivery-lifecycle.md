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
| `failed` | Delivery did not complete (timeout / orphaned-after-restart / delivery error) | `QueryLifecycleManager` failure paths + `MessageRecoveryHandler` orphan recovery |

### Mapping to the delivery concept

- **Persistence** = `persisted`. The message is durably stored; nothing else
  has happened.
- **Wake** = `wake_requested`. The daemon asked the SDK query to run. A
  `blocked` wake (the SDK transcript file is missing and the user must choose a
  resume strategy) is captured in the event's `detail.queryStart` — such a
  message will have `wake_requested` but no `accepted`.
- **SDK acceptance** = `consumed`. The SDK has taken the message as input and
  begins a turn. (This is the boundary the next phase's idempotent ownership
  will key on: "did the SDK acknowledge this input?")
- **Progress** = `first_progress`. The SDK produced its first output for the
  turn.
- **Completion** = `completed` (turn ran to a terminal result) or `failed`
  (delivery never completed).

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
db.messageDeliveryLifecycle.getDiagnostics({ sessionId?, staleMs?, sinceMs? })
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

Both are also exposed as read-only RPCs for runtime inspection:

- `messageDelivery.diagnostics` `{ sessionId?, staleMs?, sinceMs? }`
- `messageDelivery.timeline` `{ messageId }`

## The stranded shape

A message is "stranded" when it is persisted (and possibly accepted/consumed)
but the session is idle and no assistant/system progress followed. The
diagnostics surface this directly:

- A message stuck at `persisted` or `wake_requested` appears in `unclaimed`.
- A message stuck at any non-terminal stage appears in `stale`.
- A message that was `consumed` but whose daemon crashed before the SDK
  responded is marked `failed` with `detail.reason = 'orphaned_after_restart'`
  by `MessageRecoveryHandler` on the next session load.

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
