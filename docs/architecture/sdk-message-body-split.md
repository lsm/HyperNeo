# Moving the SDK message JSON out of `sdk_messages`

Status: design, approved direction (human, 2026-10-20). No code yet.

## Problem

`sdk_messages.sdk_message` holds the full SDK message JSON. Live there are about 97k rows and 390 MB of it; Neo root alone is 45.7k rows and 215 MB, and 301 MB is user-role `tool_result` rows of up to 700 KB each. The column sits before `timestamp`, `send_status`, `parent_tool_use_id` and the other small columns. So any read of those columns that isn't covered by an index walks the row's JSON overflow pages. Many filters also call `json_extract` on the body. On the laptop daemon, session-wide statements took 8–27 s and blocked the event loop.

## Constraints

1. `sdk_messages` keeps only small columns. The body lives in a side table and is read only when a caller needs the body itself. No filter, count, ORDER BY or boundary may touch body pages.
2. Tool results are kept forever, in full. No truncation, trimming, retention or deletion.
3. Session length must not matter. Reads are a tail (`ORDER BY … LIMIT`) or by key, and every session-wide scan becomes index-only.

## Schema

```sql
CREATE TABLE sdk_message_bodies (
  seq INTEGER PRIMARY KEY,          -- = sdk_messages.seq (rowid), one row per message
  sdk_message TEXT NOT NULL
);
CREATE TRIGGER sdk_message_bodies_ad AFTER DELETE ON sdk_messages
BEGIN DELETE FROM sdk_message_bodies WHERE seq = old.seq; END;
```

`sdk_messages` loses `sdk_message` and gains the values the filters read today. Each is derived once by one pure function, `deriveSdkMessageColumns(message)`, which runs at insert and in every writer that changes the body:

| column | from | used by (inventory #) |
|---|---|---|
| `input_kind TEXT` | `$.inputKind` | 22, 23, 30, 39, 64, 65, 67 |
| `is_replay INTEGER` | `$.isReplay` | 4, 16, 21, 52, 55, 56, 61 |
| `is_synthetic INTEGER` | `$.isSynthetic` | 39, 67 |
| `is_error INTEGER` | `$.is_error` | 1, 2 |
| `internal_compaction_turn INTEGER` | `$.internal_compaction_turn` | 1, 2, 38, 55, 56, 61, 63, 66 |
| `recovery_intercepted INTEGER`, `recovery_billing_terminal INTEGER` | same paths | 1, 2, 3, 56 |
| `info_level INTEGER` | `$.level = 'info'` | 9, 47, 48, 57–59 |
| `resolved INTEGER` | `$.resolved` | 42, 57–59 |
| `bg_task_id TEXT` | `COALESCE($.task_id, task_id)`: the SDK background task id, falling back to the `task_id` column exactly as #12/#46 key today | 12, 46 |
| `bg_tool_use_id TEXT` | `$.tool_use_id` of `task_progress` | 12, 46 |
| `hook_id TEXT` | `$.hook_id` | 52 |
| `first_block_type TEXT` | `$.message.content[0].type` | 55, 56, 61, 64, 65, 66 (via fragments #53, #62) |
| `has_tool_result INTEGER` | any content block of type `tool_result` | 32 |
| `tool_result_only INTEGER` | has a `tool_result` block and no non-empty text block (the roster drops these rows but keeps tool result plus text) | 52 |

`$.type`, `$.subtype` and `$.uuid` already have columns (`message_type`, `message_subtype`, `sdk_uuid`), so those filters switch to the columns. `json_valid` guards go away: bodies are written by the daemon and are always valid JSON.

## Read and write paths

The inventory has 73 statements (3 inserts, 6 body updates, 32 body outputs, 16 filters, 16 both). The 32 body outputs are the 30 numbers listed below, with #40 counted twice for its two variants, plus the db-query copy #74. #53 (`CONSUMED_INPUT`) and #62 (`LANDED_INPUT`) are SQL fragments, not statements. They are rewritten wherever they're used: #53 inside #55, #56 and #61, and #62 inside #64 and #65. Rules:

- **Writers** (#6, 41, 45 insert; #7, 35, 36, 37, 43, 44 update). One repository helper writes the row and its body in one transaction and sets the derived columns. The `json_set` updates become a body update plus a column update in the same transaction.
- **Filters** (#1–4, 16, 21–23, 30, 32, 38, 39, 42, 55, 61, 67) use the new columns and never join the body.
- **Body outputs** (#5, 8, 10, 11, 13–15, 17–20, 24–29, 31, 33, 34, 40, 49, 51, 54, 68–73) first pick their rows from `sdk_messages`, then join the body by `seq` on the chosen rows only. Tail and key reads stay tail and key reads. Until the migration (slice 10) has copied every old body, the read is `LEFT JOIN sdk_message_bodies b USING (seq)` with `COALESCE(b.sdk_message, sm.sdk_message)`, so rows written before the dual write still return their body. Slice 11 drops the fallback together with the column.
- **Both** (#9, 12, 46–48, 50, 52, 56, 57–60, 63–66) are split into the two steps above. In `messages.bySession` (#47), the subagent rows are joined through `tool_use` ids read from the bodies of the chosen window. They're extracted in TypeScript from the ≤200 window rows already loaded, then fetched `WHERE parent_tool_use_id IN (…)`. No JSON is scanned in SQL.
- **`task_message_rows` triggers** (#57–59). Today they parse the body on every insert and on almost every status update (`task_message_rows_au` fires on `send_status`, `timestamp`, `is_terminal` and more). The work splits into two parts:
  - The body-derived part (flags, artifact keys, `json_subtype`) runs from a trigger on `sdk_message_bodies` insert and update.
  - The row-derived part (status, timestamp, turn) runs from a trigger on `sdk_messages` that copies plain columns and never reads the body.
- **db-query scope** (#74). `materializeScopedTable` builds its column list from `PRAGMA table_xinfo`. Agents see `sdk_messages` through a view that joins the body, so the visible shape doesn't change.

## Session-wide scans and how each becomes index-only

| statement | today | after |
|---|---|---|
| #4/#16/#21 user messages by status (count, ids, list) | JSON filter over the session | `(session_id, send_status, message_type, is_replay)` index-only; list reads a tail page |
| #22 queued inputs | done in #7744 (send-status index) | plus `input_kind` column, no JSON |
| #23/#30 last consumed/human input | tail LIMIT 1 behind a JSON predicate, scans when nothing matches | `(session_id, input_kind, timestamp)` seek |
| #32 restart evidence | JSON `json_each` tail | `(session_id, has_tool_result, timestamp)` seek |
| #39/#67 consumed task input since | EXISTS over the session | `(session_id, task_id, input_kind, timestamp)` seek |
| #42 unresolved action | EXISTS over action rows | `(session_id, message_subtype_norm, resolved)` seek |
| #55 input-evidence probe | EXISTS over the session | `(session_id, first_block_type, timestamp)` seek |
| #12/#46 task starts and latest progress per background task | whole subtype, `json_extract` partitions | `(session_id, message_subtype_norm, bg_task_id, timestamp)` and `(…, bg_tool_use_id, timestamp)`, latest per key via seek |
| visible count recompute | covered by #7746's `idx_sdk_messages_session_visible` | unchanged, index-only |
| shutdown boundary (#47) | covered by #7746 | unchanged |
| #48 task messages, #49 session group | return the whole task or group | paged: a tail window plus "load earlier", same contract as `messages.bySession` |
| #50 `rebuildMessageSearchRows` | re-reads every body of the session on status/type/context change | rebuild only rows whose inputs changed (status changes don't change search text); its own slice |
| #26 rewind `getUserMessages`, #40 assistant messages since | whole session, rare paths | key or range reads by seq; bodies joined for the returned rows only |
| #68, #74 | cross-session or scope copies | unchanged (admin and tooling paths), noted |

#7746's covering indexes stay. With the body gone, a non-indexed scan of a session reads small rows (5 ms for 55k rows in the benchmark below), but constraint 3 still requires index-only reads, and those two indexes provide them.

## Migration

It runs at startup, before the server binds, like m212. All numbers below are measured on synthetic data: 110k rows and 850 MB of JSON, about twice the live body bytes.

1. **Backup.** The existing pre-migration backup (`createBackup`, a full copy into `data/backups/daemon.db/`) runs first. About 1 GB of disk and a few seconds.
2. **Columns.** `ALTER TABLE ADD COLUMN` × 15: 33 ms (measured with 14). Each add is guarded by `pragma_table_xinfo` (the existing idiom), so a restart after a crash re-enters this step safely. In practice slice 2 has already added and backfilled them, and this step is a no-op.
3. **Chunked pass.** 5k-row transactions, each:
   - backfills the derived columns from the JSON;
   - copies the body into `sdk_message_bodies`;
   - sets `sdk_message = ''`;
   - checkpoints the WAL.

   Measured: column backfill 10.2 s, copy plus blank 9.4 s. One pass with both is about 15 s synthetic, so about 7–8 s live. WAL peak 51 MB.
4. **Rebuild without the column** (ships in slice 11, not slice 10, together with removing every code reference to `sdk_message`; until then the blanked column stays, so a daemon built between the two slices still prepares its dual-write and `COALESCE` statements). The table is now small: 12-step copy, swap and index recreate, about 1–2 s. It is re-entrant: a leftover `sdk_messages_new` from a crash is dropped and rebuilt, and the step is skipped once `sdk_message` is gone from `pragma_table_xinfo('sdk_messages')`.

The body-derived `task_message_rows` trigger on `sdk_message_bodies` (slice 7) is dropped for the step 3 copy and recreated right after it. The copied bodies are unchanged, so the rows it would recompute are already correct, and the measured copy cost (taken without the trigger) is the shipped cost.
5. **Markers.** Slice 10's migration (steps 1–3) and slice 11's (step 4) each set their own marker only after their last step.

Crash safety: each marker is set only after its last step, so a crash anywhere makes the next boot re-enter the migration, and every step is safe to re-run. Steps 2 and 4 are guarded as described. In step 3 every chunk is one transaction, and the copy is `INSERT OR IGNORE` from the rows not yet blanked. A restart picks up where `sdk_message <> ''` rows remain, and a half-done chunk rolls back with its transaction. Rows already blanked always have their body copied in the same transaction. The trigger drop and recreate are idempotent (`IF EXISTS` / `IF NOT EXISTS`).

Space: the file grows from 943 MB to 1,190 MB in the benchmark (+26%), with 249 MB free and reused by later writes. There's no VACUUM on the boot path (as in #2961). Live should land around 1.1–1.2 GB.

Rollback: restore the step-1 backup, which loses anything written since. A reverse script ships with the migration slice as a manual tool: it re-adds the column, copies bodies back by seq, and drops the side table.

## Benefit measured

Same synthetic DB:
- A session-wide filter on non-indexed columns over a 55k-row session: before, 2,369 ms cold and 43 ms warm; after, 5 ms cold and 4 ms warm.
- Count via the #7746 index: 80 → 1.4 ms.

## Slices (100–200 production lines each, one PR per rung)

1. **Pin.** Characterization tests for the filter results of #1–4, 12, 21–23, 30, 32, 38, 39, 42, 46, 55, 61, 67 and the `task_message_rows` projection. For #12/#46, that includes a row whose JSON lacks `task_id` and resolves through the column.
2. **Build columns.** `deriveSdkMessageColumns`, migration adds and backfills the 15 columns (chunked), all writers set them.
3. **Wire repository filters** to the columns (#1–4, 16, 21–23, 30, 32, 38, 39, 42).
4. **Wire adapter and runtime filters** (#55, 56, 61–67) and the indexes from the scan table.
5. **Wire live-query filters** (#9, 12, 46, 47 with the TypeScript tool_use join, 48, 52).
6. **Build the bodies table** with dual write; reads unchanged.
7. **Split the `task_message_rows` triggers** into body-derived (on `sdk_message_bodies`, which now exists and receives every new body) and row-derived parts.
8. **Switch body outputs**, part 1: repository (#5–45), with the `LEFT JOIN … COALESCE` fallback.
9. **Switch body outputs**, part 2: live queries, adapters, runtime, the db-query view, same fallback.
10. **Migration.** Guarded columns, chunked copy and blank with the body trigger dropped, a free-disk check (refuse under 2× the DB size), per-chunk progress logging, plus the reverse script. The blanked column stays.
11. **Delete.** Remove the dual write, the `COALESCE` fallback and every reference to the old column, and in the same slice the re-entrant rebuild that drops it (step 4).
12. **Session-length fixes outside the split:** #48/#49 paging and #50 targeted search rebuild.

Slices 2–5 also speed up today's daemon on their own, before any body moves.
