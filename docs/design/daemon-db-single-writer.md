# Daemon database: one writer, no SQLite on the main thread

Status: draft. Three owners move the daemon's database work: the gateway owner
(gateway core, this plan, the guard), the `sessions` owner and the
`sdk_messages` owner. Nothing below lands until it is approved.

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
- **A table with blind writers switches in one PR.** `sdk_messages` has them
  (`updateMessageStatus`, `updateMessageTimestamp`), so all of its writers move
  together. Until a cross-table sequence becomes one op at its owner's switch
  (session teardown, for example), it stays split across connections, as it is
  today.
- **Ops record the same change scope the proxy computed,** including
  `messageSubtype`, which notice subscriptions filter on.

## Blind writers of `sessions` outside `SessionRepository`

The `sessions` switch has to cover these, so it can prove it is complete:
- `session/operations.ts` `session.state.update`: `processing_state`,
  `last_active_at`.
- `state-projection-service`: `last_error`.
- `task-agent-manager`'s delete of never-streamed sessions.
- `space-runtime-service`'s direct `sessionRepo.updateSession`.
- The `SpaceTaskRepository` archive cascade (switches with it, above).
- `SDKMessageRepository`'s `visible_message_count` (moves with `sdk_messages`).

The first four are routed through the facade before the switch.
`.claude/skills/verify/session-write-awaits.ts` checks that every caller
awaits. Fenced compare-and-set writers (`casSessionInputDraft`,
`casSessionRuntimeSettings`, `takeRestartCooldownResume`) are safe next to main
writers and don't block the order.

## Ownership and cross-table ops

| Owner | Tables | Cross-table ops it owns |
|---|---|---|
| `sessions` owner | `sessions` (all columns, including `processing_state` and metadata), `session_incarnations`, session child rows deleted with a session | `updateSession` with its search-row rebuild, delete and retitle (search rows are written inside the op); `deleteSession` with `mcp_enablement`, `delivery_turn_end`, `neo_goals` and children's `parent_id`; `createSession` with its workspace-ownership check |
| `sdk_messages` owner | `sdk_messages`, `sdk_message_bodies`, consumed seq, replacement edges, the delivery outbox | `saveSDKMessage` with its admission: body, replacement edges, `message_search_pending` schedule and the `sessions.visible_message_count` badge, all in one op; session teardown (mailbox failures, `cancelForSessionWithMessages`, `markDeliveryFailedByUuid`, deferred rows) as one op; `JobQueueRepository.transitionDeliverySendStatusFenced` (it writes `sdk_messages` and moves in the `sdk_messages` switch, not with the job queue); the SDK body copy |
| gateway owner | gateway core, `DB_OPS`, the guard; `job_queue` (except the method above); pairing; external events; `message_search_*` flush and FTS merge; `work_feed_*`; `pack_coding_*`; `space_*`, `neo_*`, goals, evolution, agent memory, schedules and every remaining table | `SpaceTaskRepository.updateTask/archiveTask` with the terminal-task session archive (in the joint `sessions` + `space_tasks` switch); the project mirror |

`visible_message_count` is written only by message code, so it is a
`sdk_messages` column in practice and moves with the `sdk_messages` switch.

The delivery outbox inserts the `sdk_messages` row and enqueues its job in one
transaction. That is one `sdk_messages` op and is never split across the job
queue's move.

`delivery_turn_end` belongs to the `sdk_messages` owner (`recordDeliveryTurnEnd`).
`deleteSession` deletes its rows inside the `sessions` op. So that a record
landing after a delete leaves no orphan, the record op inserts only while its
session exists, checked in the same transaction.

## Order

1. In review or ready: pairing writes (#8299), job claims and settlements
   (#8300), session-event writer folded in, search-index flush in batches,
   change replay with `gatewayFor(db)` and the external-event TTL sweep,
   `pack_coding_*` writers together.
2. Async callers first (the `sessions` and `sdk_messages` owners' prep PRs). These change no write
   location.
3. Switches, one at a time: `sessions` together with `space_tasks`, then
   `sdk_messages`, then the remaining repositories by subsystem.
   `SpaceTaskRepository.updateTask/archiveTask` archives a terminal task's worker
   sessions in the same transaction (`SET status = 'archived'`), a blind write
   to `sessions.status`. Moving either table alone leaves that column with blind
   writers on two connections, and a queued write could un-archive, or
   re-archive, a session. Every dev merge deploys, so two PRs merged back to back
   can't be relied on. The two tables switch in one PR, built by both owners.
4. Fold the remaining writer workers (FTS merge, project mirror, body copy).
5. Guard step 1 (`query_only` on main).
6. Reads by subsystem, LiveQuery last, then guard step 2.

## Not in scope

No schema changes, no data trimming, and no change to what the daemon stores.
The goal is only where the work runs.
