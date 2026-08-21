# sdk_messages planner-statistics and index sweep (Track A5)

Post-fix verification sweep over the daemon's hot queries, run after the query-shape fixes
landed (#1130 deliveryRetryInfo extraction, #1131 worker_shutting_down boundary CTE, #1134
ordered send-status index). All measurements come from the 3.69M-row APFS clone of the
production daemon DB at `/tmp/hyperneo-bench/daemon-clone.db` (31 GB, largest session
167,972 messages), with the SQL taken from the post-fix `dev` tree via
`packages/daemon/scripts/benchmark/explain-sweep.ts`.

## Method

1. Captured `EXPLAIN QUERY PLAN` for every named LiveQuery plus the status/repo queries
   with **no** planner statistics (the state all prior benchmark numbers were taken in —
   `ANALYZE` had been aborted and `sqlite_stat1` did not exist).
2. Ran `ANALYZE` on the clone to completion (single-digit minutes on the 3.69M-row table)
   and re-captured every plan.
3. On a second COW clone, dropped `idx_sdk_messages_send_status` and the benchmark-only
   `idx_bench_session_subtype_ts` and re-captured again, to confirm nothing regresses
   without them.
4. Audited every shipped query that filters on `message_type` or `consumed_seq` for
   consumers of the two candidate-dead indexes.

## Effect of ANALYZE on the hot plans

Plans were already correct before statistics landed — the query-shape fixes, not the
planner, were the win. `ANALYZE` only tightened row estimates (the `notused` estimate
column) and flipped two incidental index choices:

- `spaceTaskActivity.byTask` per-session `COUNT(*)` arm: `idx_bench_session_subtype_ts` →
  `idx_sdk_messages_session_uuid` (both covering full-session scans, equivalent).
- `renderableTextMessages`: `idx_sdk_messages_session_timestamp_id` →
  `idx_sdk_messages_renderable_terminal (session_id=?, is_renderable=?)` — a genuine
  improvement that only appears with stats present.
- `node_executions` lookups consolidated onto `idx_node_executions_unique_agent`.

The messages.bySession LiveQuery plan is identical pre/post `ANALYZE`: `top_level` seeks
`idx_sdk_messages_session_timestamp_id (session_id=?)`, the shutdown boundary CTE
materializes with the same index, delivery-retry state joins via
`idx_message_delivery_session_active` + an automatic covering index, and the `subagent`
CTE uses `idx_sdk_messages_parent_tool_use_id`. No correlated per-row subqueries remain.

## Index decision table

Verdicts are per post-`ANALYZE` plans on the clone, cross-checked against every shipped
query touching the leading columns.

| Index | Used by (observed plan) | Decision |
| --- | --- | --- |
| `idx_sdk_messages_session_timestamp_id` | messages.bySession `top_level` + boundary CTE, backgroundTaskMetadata, getSDKMessagesByType, renderable (pre-stats) | Keep |
| `idx_sdk_messages_parent_tool_use_id` | subagent CTE, recomputeVisibleMessageCount, hasTerminalResultAfter, getErrorTerminalResultSubtypeAfter | Keep |
| `idx_sdk_messages_session_subtype_parent` | backgroundTaskMetadata (recent_progress, terminal checks, task_starts) | Keep |
| `idx_sdk_messages_session_uuid` | uuid→row lookups, spaceTaskActivity COUNT arm | Keep |
| `idx_sdk_messages_renderable_terminal` | getRenderableTextMessages (post-stats) | Keep |
| `idx_sdk_messages_send_status_timestamp` (#1134) | status.count (covering), status.userCount/userProject, messages.byStatus — chosen over everything else in both directions | Keep — verified used |
| `idx_sdk_messages_task_id` | `task_id=? ORDER BY timestamp` shapes | Keep |
| `idx_sdk_messages_task_session` | spaceTaskMessages, task_shutdown_boundaries CTE | Keep |
| `idx_sdk_messages_task_turn` | actorMessages, taskMilestones, compact recent_turns (covering range on conversation_turn_index) | Keep |
| `idx_sdk_messages_task_session_turn` | spaceTaskActivity contributing_sessions (covering) | Keep |
| `idx_sdk_messages_unnormalized_replacements` | replacement-projection reconcile; partial and empty after backfill, no steady-state churn | Keep |
| `idx_sdk_messages_type` | **Nothing.** Only consumer shape is session-scoped (`getSDKMessagesByType`, FTS sync, byStatus predicates); planner always picks a session-leading index — verified by EXPLAIN, stats or not | **Drop (migration 199)** |
| `idx_sdk_messages_consumed_seq` | **Nothing.** All shipped `consumed_seq` predicates are session-scoped (hasTerminalResultAfter, getErrorTerminalResultSubtypeAfter) and plan via `idx_sdk_messages_parent_tool_use_id` / `session_uuid`; only 9,072 of 3.69M rows are non-NULL | **Drop (migration 199)** |
| `idx_sdk_messages_send_status` (legacy 2-col) | Superseded by the #1134 ordered index; dropped by migration 197; confirmed redundant again post-stats | Drop (already shipped) |
| `(session_id, message_subtype_norm, timestamp DESC, id DESC)` | Benchmark hypothesis (`idx_bench_session_subtype_ts`). **Refuted**: messages.bySession still prefers `session_timestamp_id` + bounded temp sort even with fresh stats; its two incidental uses (backgroundTaskMetadata recent_progress, spaceTaskActivity MAX arm) are served equally by `session_subtype_parent` / `session_uuid` after removal — verified by re-planning on a clone with it dropped | **Do not add** |

sessions table: `sessions.list` full-scans and sorts ~5k rows both pre and post stats. The
predicate (`type NOT IN (...)`, `json_valid(session_context)` CASE, `status != 'archived'`)
is not indexable, and at this table size the scan is the known residual cost — no index
change recommended. `idx_sessions_type` is used (by-type listing, durable worker lookup);
`idx_sessions_status_last_active` is not chosen by `sessions.list` (non-equality status
predicate) but remains useful for equality-status maintenance queries.

## Production mechanics

The daemon runs `PRAGMA optimize` on clean close (`DatabaseCore.close`), but a
long-lived daemon that is killed or crashes never gets there, so `sqlite_stat1` can stay
empty indefinitely. This sweep shows empty stats do not break the hot plans after the SQL
fixes — statistics are a refinement, not a dependency. The offline `ANALYZE`/`VACUUM`
procedure lives in [docs/db-maintenance.md](../db-maintenance.md).

## Write-amplification impact of the drops

`sdk_messages` INSERTs maintained 14 indexes; every one of them is a B-tree write per
saved SDK message on a table whose `sdk_message` blobs dominate a 31 GB file. Removing the
two dead ones cuts steady-state index maintenance on the hottest write path with no
observed plan regression (re-verified post-drop on the clone). Migration 199 is a
`DROP INDEX IF EXISTS` pair: near-instant for `consumed_seq` (9k entries) and a
page-freelist walk for `type` (3.69M entries), same order of cost as migration 197's
already-shipped drop.

## Raw artifacts

- Plans, no stats: `/tmp/hyperneo-bench/explain_pre_analyze_v2.txt`
- Plans, post-ANALYZE: `/tmp/hyperneo-bench/explain_post_analyze.txt`
- Plans, post-ANALYZE + dead-index drop: `/tmp/hyperneo-bench/explain_test_post_drop.txt`
- Harness: `packages/daemon/scripts/benchmark/explain-sweep.ts` (`BENCH_DB_PATH` env to
  retarget; reads the named-query SQL straight from the daemon source so it tracks `dev`)
