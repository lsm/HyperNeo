# Daemon database: one writer, no SQLite on the main thread

Status: draft for agreement between the three sessions moving the daemon's
database work (fullstack 2 owns the gateway and this plan, ccd-dev1 owns
`sessions`, ccd-dev2 owns `sdk_messages`). Nothing below lands until the human
approves it.

## Why

The daemon's event loop blocks for seconds at a time. CPU is idle while it
blocks: the main thread is waiting out `busy_timeout` because another connection
holds SQLite's write lock. Today several connections write: the main thread,
the gateway writer, the session-event writer (which also claims jobs), the FTS
merge worker and the project mirror worker. Any one of them
holding the lock for seconds stalls every main-thread write behind it. The
dequeue index fix (#8284) removed the worst holder. It did not remove the cause.

## End state

1. **One writer connection.** The gateway's write lane (`storage/db-gateway/`,
   #8286) is the only connection that writes. Every other writer folds into it.
   One writer means no lock contention between connections and no
   `busy_timeout` waits anywhere.
2. **Every write is a named op.** An op is `defineDbOp({ name, mode, run(db,
   args, changes) })`, or `defineRepositoryOp` for a set of repository methods.
   It is registered in `DB_OPS` and called as `await gateway.run(op, args)`.
   **One op is one transaction and the unit of atomicity.** A business write
   that touches several tables is one op, never several.
3. **Reads and checks happen inside the op.** A read-check-write on the main
   thread (load row, decide, write) becomes one op that reads, decides and
   writes in its own transaction. Values that depend on current state are never
   computed on main and posted later.
4. **Change notifications come from the op.** The op records the tables (and
   scope) it changed through `changes.notifyChange`. Main replays them into
   `ReactiveDatabase` after the commit and before the caller's promise resolves,
   so a live query re-reads committed rows. The proxy-emits-after-promise change
   (#8296/#8298, which overlap) is the bridge while facade methods are still
   proxied. A method moved to an op drops its proxy mapping, so nothing notifies
   twice.
5. **Ops are short.** An op holds the only write lock, so it must finish in
   tens of milliseconds. Bulk work (purges, cleanup, FTS merge, backfills,
   re-index) runs as repeated bounded batch ops, so other writes interleave. The
   gateway logs any op over 250 ms with its name.
6. **Reads leave the main thread too.** Read ops run on the gateway's read lane
   (read-only connections). The existing reader workers (`sdk-status-reader`,
   `message-search-worker`, `db-query-worker`) fold into that lane. LiveQuery
   re-runs its queries there and diffs on main.
7. **Guard.**
   - Step 1, once all writes are ops: main's connection opens with
     `PRAGMA query_only=ON` after migrations.
   - Step 2, once reads are ops: `Database.getDatabase()` and every repository
     constructed on main are deleted. A CI check rejects any `sqlite-compat`
     value import outside `storage/db-gateway/` and op modules.

## The ordering rule while tables move

A write moved to the gateway runs later than a main-thread write issued after
it. That reorders only blind writes: a value computed outside the transaction,
or a last-writer-wins column. So:

- **A column moves when all its blind writers move.** Ops that compute their
  value inside the transaction (`count = count + 1`, `RETURNING`, fenced
  `WHERE status = ?`, insert-or-ignore) are safe next to main-thread writers.
- **A cross-table op moves with the latest of its tables.** It never splits.

## Ownership and cross-table ops

| Owner | Tables | Cross-table ops it owns |
|---|---|---|
| ccd-dev1 | `sessions` (all columns, including `processing_state` and metadata), `session_incarnations`, session child rows deleted with a session | `updateSession` with its search-row rebuild, delete and retitle (search rows are written inside the op); `deleteSession` with `mcp_enablement`, `delivery_turn_end`, `neo_goals` and children's `parent_id`; `createSession` with its workspace-ownership check |
| ccd-dev2 | `sdk_messages`, `sdk_message_bodies`, consumed seq, replacement edges, the delivery outbox | `saveSDKMessage` with its admission: body, replacement edges, `message_search_pending` schedule and the `sessions.visible_message_count` badge, all in one op; session teardown (mailbox failures, `cancelForSessionWithMessages`, `markDeliveryFailedByUuid`, deferred rows) as one op; `JobQueueRepository.transitionDeliverySendStatusFenced` (it writes `sdk_messages` and moves in the `sdk_messages` switch, not with the job queue); the SDK body copy |
| fullstack 2 | gateway core, `DB_OPS`, the guard; `job_queue` (except the method above); pairing; external events; `message_search_*` flush and FTS merge; `work_feed_*`; `pack_coding_*`; `space_*`, `neo_*`, goals, evolution, agent memory, schedules and every remaining table | `SpaceTaskRepository.updateTask/archiveTask` with the terminal-task session archive (moves after the `sessions` switch); the project mirror |

`visible_message_count` is written only by message code, so it is a
`sdk_messages` column in practice and moves with ccd-dev2's switch.

## Order

1. In review or ready: pairing writes (#8299), job claims and settlements
   (#8300), session-event writer folded in, search-index flush in batches,
   change replay with `gatewayFor(db)` and the external-event TTL sweep,
   `pack_coding_*` writers together.
2. Async callers first (ccd-dev1 and ccd-dev2 prep PRs). These change no write
   location.
3. Switches, one owner at a time: `sessions`, then `sdk_messages`, then
   `space_tasks` with its session archive, then the remaining repositories by
   subsystem.
4. Fold the remaining writer workers (FTS merge, project mirror, body copy).
5. Guard step 1 (`query_only` on main).
6. Reads by subsystem, LiveQuery last, then guard step 2.

## Not in scope

No schema changes, no data trimming, and no change to what the daemon stores.
The goal is only where the work runs.
