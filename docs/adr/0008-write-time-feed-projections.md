# ADR 0008: Write-Time Projections for Live Feeds

## Status

Proposed — 2026-10-06. Amends ADR 0001: the database stays the message bus and
LiveQuery stays the subscription mechanism, but a live feed must read a
projection maintained at write time, not re-derive its rows from raw history on
every change. Tracks #5571.

## Context

### Measured cost

`packages/daemon/scripts/benchmark/space-task-feeds.ts` (#5756) replays scoped
`sdk_messages` writes against a copy of the tts database (5.9M messages) and
times each Space task feed. Warm medians per write:

| feed | 3k msgs | 12k msgs | 87k msgs |
| --- | --- | --- | --- |
| `spaceTaskMessages.byTask.compact` (task thread) | 250 ms | 736 ms | 2,548 ms |
| `spaceTaskActiveTurn.byTask` (task thread) | 81 ms | 173 ms | 1,019 ms |
| `spaceTaskActivity.byTask` (task thread) | 6 ms | 31 ms | 175 ms |
| `taskMilestones.byTask` (Timeline tab) | 1,220 ms | 1,300 ms | 1,434 ms |
| total with the Timeline tab open | 1.6 s | 2.2 s | 5.2 s |

SQLite runs synchronously on the daemon's event loop, so each evaluation
blocks every session and RPC for its full duration. A streaming agent writes
several messages a second; the debounce (250 ms) cannot absorb multi-second
evaluations, so a long task stalls the whole daemon. For comparison,
`messages.bySession` measures ~1.7 ms per write, flat across sizes.

### Why it is slow: four design faults

1. **Read-time derivation.** Every displayed row (sender label, kind, delivery
   state, replacement status, turn grouping, shutdown visibility) is derived on
   every read by 1,000+ line SQL from raw `sdk_messages` plus side tables. One
   new message re-derives the whole task history. The compact feed is
   "windowed", but its CTEs scan every task message (and `json_each` every
   `tool_use`) before the window applies, so its cost is linear in task size.
2. **Re-run-and-diff evaluation.** `LiveQueryEngine.evaluateQuery` re-runs the
   full SQL, hashes every row and diffs. The writer knows exactly which rows
   changed, but `TableChangeScope` has no row field: `messageIdsScope`
   (`reactive-database.ts` ~179/204) receives message ids and drops them.
3. **Unreliable change events.** Many writes emit nothing: every
   `markDelivery*`/`reopen*` call on `getSDKMessageRepo()`,
   `sdk_message_replacements`, and `job_queue` enqueue/cancel/reschedule. Others
   emit unscoped events: `NodeExecutionRepository.notify()` fires on every
   `touchLastActivity`, i.e. on every tool use in any session, and re-runs every
   task feed in the daemon. Feeds stay correct only because some unrelated event
   re-runs them later.
4. **Overlapping feeds.** One task screen holds four subscriptions that each
   re-derive overlapping state from the same rows.

The Timeline tab's flat ~1.3 s has two separate causes, both full scans:
`delivery_job_errors` reads every `message_delivery` job in every status (no
status predicate, so the partial indexes do not apply), and `github_rows` joins
`space_external_event_deliveries` on `task_id`, which has no index.

The target architecture already says read models are projections downstream of
committed writes (`docs/architecture/target-architecture/storage-unit-of-work-and-outbox.md`,
principle 7). The implementation drifted from it.

### Precedent in this repo

Write-time derivation already exists where it was cheap:

- `conversation_turn_index`, `task_id` and `sdk_message_replacements` are
  computed inside the `sdk_messages` insert transaction.
- `sessions.visible_message_count` is maintained in repository code in the
  same transaction.
- `session_counters` is maintained by SQLite triggers.
- `message_search_content` is fed from a dirty queue written in the same
  transaction and drained asynchronously.

Triggers serve small pure-SQL aggregates; anything that parses JSON or needs
TypeScript logic runs in repository code.

## Decision

### 1. Live feeds read projections

A live feed's per-write cost must not grow with history. Its query reads a
projection table through an index and touches at most its window of rows.
Deriving rows from raw history at read time is not allowed for a live feed.
Budget: one evaluation under 10 ms at any task size on the benchmark DB.

### 2. One task feed projection

Add `space_task_feed_rows`, one row per displayed entry:

| column | meaning |
| --- | --- |
| `task_id`, `row_key` | identity; `row_key` is stable (e.g. `msg:<id>`, `turn:<session>:<n>`, `lifecycle:started`) |
| `seq` | ordering key: source rowid, monotonic per insert |
| `session_id`, `turn_index` | grouping |
| `kind`, `category`, `tone` | thread kind and Timeline category, both decided at write time |
| `delivery_state`, `replacement_state`, `visible` | mutable state updated by the writes that change it |
| `summary_json` | display payload (text, thinking or last tools, already reduced) |
| `created_at`, `updated_at` | timestamps |

Indexes: `(task_id, seq)` for the thread window, `(task_id, category, seq)`
for the Timeline.

Labels are not stored. Rows keep `session_id`; the query joins the small keyed
tables (`sessions`, `node_executions`, agents) for only the window's rows, so a
rename never rewrites history.

The thread feed, the active turn and the Timeline become filtered reads of this
one table. The activity feed (one row per session) becomes a small per-session
projection or stays as is once its scans are bounded; it is already the
cheapest.

### 3. The projector runs in the write transaction

A single module, `space/task-feed-projector.ts`, owns the projection. The
writers call it inside their existing transactions:

- the three `sdk_messages` insert choke points in `SDKMessageRepository`;
- `applyMessageStatusPlan`, which already funnels status, timestamp and turn
  promotion;
- the content rewrites, `updateMessageTimestamp`, `deletePendingUserMessage`
  and the rewind delete;
- replacement edge writes (mark the target row superseded or retracted);
- `job_queue` delivery transitions that change a message's delivery state;
- `space_tasks` lifecycle writes for the Timeline's lifecycle rows.

Each call touches the rows it changes and nothing else. A message write is
O(1) in history.

### 4. Change events carry row keys

`TableChangeScope` gains `rowKeys`. The projector emits one scoped event per
transaction for `space_task_feed_rows` with `{ taskId, rowKeys }`. Projection
writes are the only source of feed events, which fixes the missing and
unscoped events in one place rather than at each scattered writer.

The first cut keeps re-run-and-diff: re-running a windowed index read is cheap
enough. A later step lets the engine refresh only `rowKeys` for queries that
declare a key column.

### 5. Backfill and parity

- A background job projects existing tasks, newest first, in bounded batches.
  `space_tasks.feed_projected_at` records completion; until it is set, a task's
  feeds keep using the legacy SQL.
- The legacy SQL stays as the oracle until deleted. A parity test builds
  fixtures, runs both paths and requires identical visible output. The
  benchmark script gains a shadow mode that compares both paths on a real DB
  copy before each feed is switched.

### 6. Cheap fixes ship first, independently

These do not wait for the projection:

- add a status predicate to `delivery_job_errors` and an index on
  `space_external_event_deliveries(task_id)`, removing the Timeline's flat cost;
- scope `NodeExecutionRepository` change events by task and session, so a tool
  use stops re-running every task feed in the daemon.

## Alternatives considered

- **Window the existing SQL earlier.** This bounds the thread feed only. Turn
  grouping, replacement status and shutdown visibility depend on later history,
  so the CTEs still need much of the task. Milestones and active turn stay
  linear.
- **Incremental evaluation inside the engine.** Cache rows per subscription and
  patch them from change events. Every late change (replacement, status flip,
  rewind, relabel) needs bespoke patch logic in the engine, away from the
  writer that knows what changed, and drift needs a periodic full recompute.
  The projector does the same work at the writer, once, for all subscribers.
- **Evaluate live queries on a worker thread.** This stops the event loop from
  blocking but keeps the multi-second CPU cost per write. It is a mitigation
  worth keeping in mind, not a fix.

## Consequences

- Feeds cost O(window) per write regardless of task length, and the daemon
  stops stalling on long tasks.
- About 3,000 lines of feed SQL are replaced by one projector and short queries.
- Every writer that changes displayed state must call the projector. The
  projector is the one place to review, and a parity test guards it, but a
  writer that bypasses the repository silently leaves the feed stale. A
  repository-level test asserts every listed write path calls it.
- The projection adds storage (roughly one row per displayed message) and one
  extra write per message.
- The backfill of the 5.9M-message tts history runs once, in the background.

## Rollout

One PR per rung (ADR 0004 ladder):

1. Cheap fixes: the Timeline scans, scoped `node_executions` events.
2. Pin: parity fixtures from the legacy SQL for thread, active turn and Timeline.
3. Build: `space_task_feed_rows` migration and the projector, with tests; not
   yet called.
4. Wire: insert and status-plan paths call the projector.
5. Wire: replacement, rewind, delivery job and lifecycle paths call it.
6. Backfill job and `feed_projected_at`.
7. Switch the thread feed and active turn behind a flag; shadow-compare on the
   tts copy.
8. Switch the Timeline.
9. Delete the legacy feed SQL.

Steps 7 and 8 are judged by `space-task-feeds.ts`: under 10 ms per evaluation
at 87k messages.
