# Message Delivery Lifecycle Simplification — adopt SDK 0.3.233 native signals

- **Status:** **Proposed — Phase 0 pending.** Extends (does not replace)
  [`message-delivery-v2.md`](./message-delivery-v2.md). Tracking: issue
  [#2548](https://github.com/lsm/HyperNeo/issues/2548), Space umbrella task #983.
- **Date:** 2026-08-16
- **Owners:** Marc Liu
- **SDK baseline:** `@anthropic-ai/claude-agent-sdk` 0.3.233 (native CLI 2.1.233) —
  upgraded in PR #2546. All type references below verified against the installed
  `sdk.d.ts` / `sdk.mjs` in `packages/daemon/node_modules`.

---

## 1. Problem

Message-delivery v2 landed 2026-08-09 (#2417) and became default 2026-08-10
(#2431). In the seven days since it has required six delivery fixes
(#2447, #2463, #2471, #2476, #2477, #2499), and the five core files now carry
66 Codex-review fix references in comments (43 in `agent-session.ts` alone).
Each fix adds a fence, a durable marker, or a grace window; the fences
interact; the next fix adds a grace window for the fence.

Root cause: **every one of those fixes is inference for a state the SDK did
not report.** We guess when a turn ended, when a message was consumed, whether
a queued message survived an interrupt, and whether a silent turn is stalled.
SDK 0.3.233 now *publishes* most of those states. The inference was the only
option when it was written; it is now largely replaceable.

## 2. What the SDK now publishes

Verified against the installed 0.3.233 types and wrapper bundle:

| Signal | Shape | Pins down |
| --- | --- | --- |
| `interrupt()` receipt | `{ still_queued: string[] }` — uuids that WILL still run (already consumed by `InterruptHandler`) | Queue survivors at interrupt |
| `interrupt` + `cancel_queued: true` | `{ still_queued: [], cancelled: string[] }`; each survivor emits terminal `cancelled` lifecycle. Capability `interrupt_cancel_queued_v1`. **Not reachable via the wrapper's `interrupt()` (no args) — raw control request only.** | One-round-trip stop-everything |
| `query.cancelAsyncMessage(uuid)` | `Promise<cancelled: boolean>` — "Drops a pending async user message from the command queue by uuid." **Exists at runtime in the 0.3.233 bundle but is untyped in the `Query` interface** (same situation `terminal_slash_commands` was in). | Per-message cancellation |
| `command_lifecycle` (untyped) | `command_uuid` + state machine `queued / started / running / completed / failed / cancelled` | Per-uuid queue lifecycle. The interrupt docs confirm lifecycle events apply to *uuid-stamped async user messages*, not just slash commands |
| `session_state_changed` | `{ state: 'idle' \| 'running' \| 'requires_action' }`. SDK docs call idle the *"authoritative turn-over signal"* — fires after heldBackResult flushes and the bg-agent do-while exits | Turn end, SDK-pinned |
| `conversation_reset` | `{ new_conversation_id }` | Fresh-transcript boundary |
| Input-message fields | `uuid` (we already stamp it — this is what the receipt and cancel key on); `origin` (`SDKMessageOrigin`, the human-trust P1 from #2548 §D); `shouldQuery: false` — *"appended to the transcript without triggering an assistant turn; merged into the next user message that does query"* (our `deferred` mode, natively); `priority?: 'now' \| 'next' \| 'later'` (undocumented) | Transcript-vs-turn semantics |
| `control_request_progress` | `{ request_id, status: 'started' \| 'api_retry', … }` | Long-control-request liveness |
| `keep_alive` | `{ type: 'keep_alive' }` | WS liveness |
| `background_tasks_changed` + `query.backgroundTasks(toolUseId?)` | REPLACE-semantics task list | Background task truth |
| init `capabilities` | `interrupt_receipt_v1`, `interrupt_cancel_queued_v1`, `queued_notifications`, … | Feature detection — **we do not capture this today** |

## 3. Where we guess today

| # | Heuristic | Where | What it guesses |
| --- | --- | --- | --- |
| 1 | Turn end inferred twice — `result` AND `session_state_changed` idle, arbitrated by `usesSessionStateChangedTurnEnd` / `expectsSessionStateIdleAfterResult` / `lastResultWasSuccess` / `suppressIdleOnNextResult` / `beginTerminalIdle` fences | `sdk-message-handler.ts` (turn-end block) | Which signal ends the turn |
| 2 | Spurious-fire grace — a turn-end landing ≤250 ms after kickoff admission is assumed to be the previous turn's teardown; re-arm up to twice | `agent-session.ts` (`SPURIOUS_TURN_END_GRACE_MS` block) | Whose idle that was |
| 3 | Three acknowledgment paths for one consume: yield-ack (`onMessageYielded`), SDK-replay-ack (lookup chain across `enqueued`/`deferred`/`submitted`/`consumed`), turn-end sweep (`acknowledgeOldestQueuedUserOnTurnEnd`) | `sdk-message-handler.ts` | Whether the SDK consumed our message |
| 4 | Interrupt choreography — durable cancel sweep → abort → SDK interrupt → receipt → skip grace-wait → **close the subprocess to kill survivors** → 200 ms race | `interrupt-handler.ts` steps 1–6 | We kill the whole session because individual survivors could not be cancelled |
| 5 | Stall watchdog + 30 s queue timeout — every incoming message resets a no-progress window; `stream_event` partials exist partly as a liveness heartbeat | `agent-session.ts`, `message-queue.ts` | Is a silent turn alive |
| 6 | Crash forensics — `classifyReclaimTermination(successResult, markerExists, terminalIdleInFlight)` reconstructs whether a crashed turn succeeded from DB rows and `delivery_turn_end` markers | `message-delivery.ts` | What happened before the crash |
| 7 | Two queues reconciled by a sweeper — our `send_status` state machine vs. the SDK's internal queue → stranded reconciler (#856), orphan terminalization, `notifyChange` hacks | `message-delivery.ts`, `interrupt-handler.ts` | Queue-ownership agreement |
| 8 | Timestamp games — re-timestamp at consume, strictly-increasing `consumedAt` (#2338) | `sdk-message-handler.ts` | Where the SDK placed the message |

## 4. Replacement map

| Guess | SDK-pinned replacement | Net deletion |
| --- | --- | --- |
| #4 subprocess-close-to-kill-survivors | receipt `still_queued` → `cancelAsyncMessage(uuid)` per survivor | Grace race + forced close (~60 lines); session stays warm — no restart tax per interrupt |
| #1 + #2 dual turn-end, fences, grace window | `session_state_changed: idle` as the only turn-end trigger; `result` becomes pure metadata (cost/usage/error classification) | ~150 lines across two files |
| #3 ack triplet | `command_lifecycle` per-uuid states (gated on Phase 0 evidence) | Turn-end sweep + 4-status lookup chain (~100 lines) |
| #5 stall heartbeat | `command_lifecycle` running/completed + `keep_alive` | Watchdog keyed to real states instead of any-message resets |
| #6 crash forensics | Partially — durable markers stay ours, but turn outcome becomes readable instead of reconstructed | Shrinks, does not vanish |
| #7 dual queues | `job_queue` demoted to *durability only* ("ensure eventually delivered"); SDK receipt/lifecycle = runtime truth | Reconciler shrinks to pre-start stranding |
| defer mode | `shouldQuery: false` (investigation-first; touches queue UI) | Potentially the promote/replay machinery |

## 5. The linchpin unknown

Phases 3–5 hinge on one question: **does `command_lifecycle` fire for plain
user prompts, or only slash commands?** The docs lean yes — the CLI's own name
for the queue is the "command queue", `cancel_async_message` drops "a pending
async user message from the command queue", and cancelled survivors get a
"terminal `cancelled` lifecycle" — but the name says *command* and nobody has
verified it on real traffic. **Phase 0 resolves this with data before any
behavior change.**

## 6. Phased plan

Each phase is independently shippable, capability-gated, and keeps the old
path as fallback for CLIs that lack the capability.

### Phase 0 — Instrument (no behavior change)

Stop discarding the new signals silently; log them.

- In `SDKMessageHandler.handleMessage`, the filters added in #2546
  (`command_lifecycle`, `conversation_reset`, `active_goal`,
  `background_tasks_changed`, `control_request_progress`) currently `return`
  early. Add a `logger.debug` (verbose-gated) of the full payload before each
  return.
- Capture `capabilities` from the init message into session metadata (or a
  dedicated field) so later phases can capability-gate and we can audit what
  the fleet actually runs.
- Collect ≥48 h of traces from real workloads. Answer: (a) does
  `command_lifecycle` fire for plain prompts? (b) with which states and at
  what boundaries relative to `onSent` and the turn `result`? (c) is
  `session_state_changed: idle` emitted for every turn end on CLI 2.1.233?

**Gate:** Phase 3+ proceed only on this evidence. Phases 1–2 need only the
capabilities capture.

### Phase 1 — Interrupt without homicide (small, high value)

On receipt `still_queued`, call `cancelAsyncMessage(uuid)` per survivor instead
of closing the subprocess.

- Extend `QueryLike` with an optional `cancelAsyncMessage?(uuid: string):
  Promise<boolean>`; runtime method already exists on the wrapper's Query
  object (untyped — same pattern as `supportedCommands`).
- Capability-gate on `interrupt_receipt_v1` from init `capabilities`; keep the
  close-the-subprocess path for CLIs without it.
- Delete the survivor-driven STEP 3 grace-skip / STEP 4 forced close once the
  cancel path is proven (keep the normal close path for genuine teardown).
- Verify: unit test around `InterruptHandler` with a stubbed receipt +
  cancel; online test asserting the session stays warm (no subprocess respawn)
  after an interrupt with queued survivors.

### Phase 2 — One turn-end authority

Promote `session_state_changed: idle` to the only turn-end trigger.

- `result` messages stop publishing idle; they remain the source for
  cost/usage metadata, error classification (`isSDKResultSuccess`), and the
  retryable-subtype taxonomy.
- Delete the result-path idle, `expectsSessionStateIdleAfterResult`,
  `suppressIdleOnNextResult` (re-examine the in-stream `/clear` case on the new
  authority), the `beginTerminalIdle` fence choreography, and the
  `SPURIOUS_TURN_END_GRACE_MS` block.
- Fallback: if the first turns of a session produce no `session_state_changed`
  at all (older CLI), fall back to the result path — i.e. keep a thin
  capability check, not the full dual choreography.
- Verify: the existing turn-end/idle unit tests ported to the new single
  trigger; daemon online shard green; E2E steer/interrupt suites.

### Phase 3 — One acknowledgment path (gated on Phase 0)

Map `send_status` flips onto `command_lifecycle` states:
`queued→enqueued`, `started/running→consumed`, `completed/failed→` turn
outcome.

- Delete `acknowledgeOldestQueuedUserOnTurnEnd` (the turn-end sweep) and the
  4-status lookup chain; keep the SDK-replay ack for resume flows.
- `onSent` demotes to a transport ack and stops flipping `send_status`
  (or flips to a new intermediate `admitted` status if the UI wants it).

### Phase 4 — defer mode → `shouldQuery: false` (investigation)

Our defer mode could become a native transcript-append. Touches the queue UI
(queued-message badges, promote affordance) and the replay kickoff paths.
Investigation first; only proceed if the CLI's merge semantics match our UX.

### Phase 5 — Queue-ownership split

`job_queue` = crash-recovery durability only; SDK receipt/lifecycle = runtime
truth. The stranded reconciler keeps only the pre-start case (message persisted
but no job ever enqueued). This is the largest deletion and lands last.

## 7. Non-goals / what stays

- **`job_queue` durability.** Crash recovery is genuinely ours; the SDK gives
  runtime truth, not durability. No phase removes durable ownership.
- **ACP paths.** Acceptance-boundary semantics are a different provider
  contract; they stay separate throughout.
- **Anything before Phase 0's evidence is in.** `cancelAsyncMessage` being
  untyped in the interface is a warning that this surface is fresh; every
  consuming phase gates on init `capabilities`, never on version sniffing.

## 8. Relationship to issue #2548

- §D (origin stamping P1) slots into the input-contract work above — the
  `origin` field is stamped at feed time in the same place `uuid` already is.
- §B (filtered signals) and §C (`cancel_async_message`, interrupt receipts)
  are consumed by Phases 0–3.
- §A (renderers for `prompt_suggestion`, `tool_use_summary`) and §E (type-only
  types) are UI/typing work outside this doc's scope and stay tracked in
  #2548 directly.
