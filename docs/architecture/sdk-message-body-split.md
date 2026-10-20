# Moving the SDK message JSON out of `sdk_messages`

Status: design, approved direction (human, 2026-10-20). No code yet.

## Problem

`sdk_messages.sdk_message` holds the full SDK message JSON. The statement numbers below (#1–#74) refer to `docs/reports/sdk-message-body-inventory.md`.

Two live databases matter:

- **Laptop daemon** (`~/.hyperneo/data/daemon.db`, 1 GB): about 97k rows and 390 MB of JSON; Neo root alone is 45.7k rows and 215 MB, and 301 MB is user-role `tool_result` rows of up to 700 KB each. The column sits before `timestamp`, `send_status`, `parent_tool_use_id` and the other small columns. So any read of those columns that isn't covered by an index walks the row's JSON overflow pages. Many filters also call `json_extract` on the body. On the laptop daemon, session-wide statements took 8–27 s and blocked the event loop.
- **iMac `tts` daemon**: 31 GB and 3.69M rows at the August measurement in `docs/reports/sdk-messages-index-sweep.md`, about 38 GB now, with a largest session of 168k messages. It's about 30× the laptop. It sets the migration's time and disk budget, which is why the copy runs online (see Migration).

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
| `user_status_eligible INTEGER` | JSON type is `user` and `isReplay` is absent or exactly boolean `false` | 4, 16, 21 |
| `task_input_eligible INTEGER` | JSON type is `user` and `inputKind` is `task`, or absent with `CAST(isSynthetic AS INTEGER) = 1` | 39, 67 |

Slice 3 adds these two eligibility columns beyond the original fifteen. Raw scalar
columns lose the distinction between a missing property and explicit JSON null,
or boolean false and numeric zero; the existing status and task predicates depend
on those distinctions. Both new columns come from `deriveSdkMessageColumns`, the
same writers, and the same chunked backfill. Migration 414 adds them safely; the
backfill's v2 completion/cursor markers ensure already-upgraded slice-2 databases
are re-derived before the new filters become reachable. Missing/false/0/null and
mismatched JSON message types retain their old selection behavior. String flag
values are stored as quoted JSON text so INTEGER affinity cannot turn a JSON
string such as `"1"` into numeric one. The task eligibility projection applies
SQLite's integer-prefix conversion directly to the source value.

`$.type`, `$.subtype` and `$.uuid` already have columns (`message_type`, `message_subtype`, `sdk_uuid`), so those filters switch to the columns. Bodies are written by the daemon through `JSON.stringify`, so they should always be valid JSON. That's an assumption, not a guarantee, so it gets a policy. The backfill derives columns only `WHEN json_valid(sdk_message)`. A malformed historical row keeps NULL derived columns, has its body copied unchanged, and is counted in the per-chunk log; it never fails the migration. Filters treat NULL columns the way today's guards treat invalid JSON: `messages.ts` keeps such rows visible through `OR NOT json_valid`, and the column filters keep them via `IS NULL` where today's do. With that in place, `json_valid` guards in read paths go away.

## Read and write paths

The inventory has 73 statements (3 inserts, 6 body updates, 32 body outputs, 16 filters, 16 both). The 32 body outputs are the 30 numbers listed below, with #40 counted twice for its two variants, plus the db-query copy #74. #53 (`CONSUMED_INPUT`) and #62 (`LANDED_INPUT`) are SQL fragments, not statements. They are rewritten wherever they're used: #53 inside #55, #56 and #61, and #62 inside #64 and #65. Rules:

- **Writers** (#6, 41, 45 insert; #7, 35, 36, 37, 43, 44 update). One repository helper writes the row and its body in one transaction and sets the derived columns. The `json_set` updates become a body update plus a column update in the same transaction.
- **Filters** (#1–4, 16, 21–23, 30, 32, 38, 39, 42, 55, 61, 67) use the new columns and never join the body.
- **Body outputs** (#5, 8, 10, 11, 13–15, 17–20, 24–29, 31, 33, 34, 40, 49, 51, 54, 68–73) first pick their rows from `sdk_messages`, then join the body by `seq` on the chosen rows only. Tail and key reads stay tail and key reads. Until the migration (slice 10) has copied every old body, the read is `LEFT JOIN sdk_message_bodies b USING (seq)` with `COALESCE(b.sdk_message, sm.sdk_message)`, so rows written before the dual write still return their body. Slice 11 drops the fallback together with the column.
- **Both** (#9, 12, 46–48, 50, 52, 56, 57–60, 63–66) are split into the two steps above. In `messages.bySession` (#47), the subagent rows are joined through `tool_use` ids read from the bodies of the chosen window. They're extracted in TypeScript from the ≤200 window rows already loaded, then fetched `WHERE parent_tool_use_id IN (…)`. No JSON is scanned in SQL.
- **`task_message_rows` triggers** (#57–59). Today they parse the body on every insert and on almost every status update (`task_message_rows_au` fires on `send_status`, `timestamp`, `is_terminal` and more). The work splits into two triggers with disjoint column ownership. Each upserts the projection row by id (`INSERT … ON CONFLICT(id) DO UPDATE`) and sets only its own columns, and neither deletes. The row trigger's `UPDATE OF` list doesn't include `sdk_message`, so blanking the old column fires neither trigger:
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

#7746's covering indexes stay. They're merged (0ffa0390) and present in `createIndexes` and m409. With the body gone, a non-indexed scan of a session reads small rows (5 ms for 55k rows in the benchmark below), but constraint 3 still requires index-only reads, and those two indexes provide them.

## Migration

Only the cheap schema steps run at startup. The body copy runs online as a background job: the dual write (slice 6) and the `COALESCE` reads (slices 8–9) make a half-copied table correct to read. That matters because the iMac database is about 30× the synthetic one. At startup the copy would keep the daemon down for minutes; online, it runs in chunks that yield between transactions, with no downtime. All numbers below are measured on synthetic data: 110k rows and 850 MB of JSON, about twice the laptop's live body bytes.

1. **Backup and disk check.** The existing pre-migration backup (`createBackup`, a full copy into `data/backups/daemon.db/`) runs first: about 1 GB on the laptop, 31–38 GB on the iMac. The copy refuses to start while free disk is under twice the DB size. It logs why and retries on the next run.
2. **Columns.** `ALTER TABLE ADD COLUMN` × 15: 33 ms (measured with 14). Each add is guarded by `pragma_table_xinfo` (the existing idiom), so a restart after a crash re-enters this step safely. In practice slice 2 has already added and backfilled them, and this step is a no-op.
3. **Chunked pass (background job).** Each chunk is one transaction bounded by bytes, not rows: up to 5k rows or 16 MB of body bytes (`sum(length(sdk_message))` in seq order), whichever comes first. A single row larger than the limit is a chunk on its own. There's a yield between chunks. A tool-heavy region with 700 KB results therefore never builds a multi-hundred-MB transaction, a WAL spike or a long event-loop block. Each chunk:
   - backfills the derived columns from the JSON;
   - copies the body into `sdk_message_bodies`;
   - sets `sdk_message = ''`;
   - checkpoints the WAL.

   Measured (5k-row chunks, average 7.7 MB): column backfill 10.2 s, copy plus blank 9.4 s. One pass with both is about 15 s synthetic, so about 7–8 s on the laptop. WAL peak 51 MB. A 16 MB byte cap keeps the per-chunk WAL and block time near those figures in any region of the table.
4. **Rebuild without the column** (ships in slice 11, not slice 10, together with removing every code reference to `sdk_message`; until then the blanked column stays, so a daemon built between the two slices still prepares its dual-write and `COALESCE` statements). The table is now small: 12-step copy, swap, then recreate the indexes and the triggers, about 1–2 s. `DROP TABLE sdk_messages` drops its triggers, so step 4 recreates them by name: the row-derived `task_message_rows` trigger (insert and update) and the `sdk_message_bodies_ad` cleanup. It also asserts they exist before it sets the marker. The repo precedent, runMigration15, recreates indexes only because no triggers existed then. It is re-entrant: a leftover `sdk_messages_new` from a crash is dropped and rebuilt, and the step is skipped once `sdk_message` is gone from `pragma_table_xinfo('sdk_messages')`.

The body-derived `task_message_rows` trigger on `sdk_message_bodies` (slice 7) must not run for copied rows, but it must keep running for every other write. Slice 7 creates the one-row table `sdk_message_body_copy_active` empty, and the trigger's `WHEN NOT EXISTS (SELECT 1 FROM sdk_message_body_copy_active)` fires whenever it's empty. That covers every write from slice 7 on, and after the copy ends. The copy job inserts the row at the start of each chunk transaction and deletes it before commit. Chunks run synchronously on the daemon's single connection, so no other write can happen while the row exists. The skip therefore covers exactly the copy's own inserts, with no seq comparison, so a NULL cutoff or a reused rowid can't disable it. Copied bodies are unchanged, so the projection rows the trigger would recompute are already correct, and the measured copy cost (taken without the trigger) is the shipped cost.
5. **Markers.** Slice 10's migration (steps 1–3) and slice 11's (step 4) each set their own marker only after their last step.

Crash safety: each marker is set only after its last step, so a crash anywhere makes the next run re-enter the migration, and every step is safe to re-run. A crash inside a chunk rolls back that chunk's flag row with the rest of its transaction. Steps 2 and 4 are guarded as described. In step 3 every chunk is one transaction, and the copy is `INSERT OR IGNORE` from the rows not yet blanked. A restart picks up where `sdk_message <> ''` rows remain, and a half-done chunk rolls back with its transaction. Rows already blanked always have their body copied in the same transaction. 

Space: the file grows from 943 MB to 1,190 MB in the benchmark (+26%), with 249 MB free and reused by later writes. There's no VACUUM on the boot path (as in #2961). Expected sizes:

- **Laptop:** about 1.1–1.2 GB; the copy pass takes about 7–8 s of chunk work in total.
- **iMac:** about +26% at peak, so up to about 48 GB, and roughly 4–8 minutes of chunk work spread over normal running. The 2× free-disk check is the binding constraint there.

Slice 11's rebuild without the column runs at startup on small rows: about 1–2 s on the laptop, and an estimated 1 minute for the iMac's 3.69M rows. That one deploy is scheduled.

Rollback has two paths:

- **The reverse script** is the durable path. It ships with slice 10 as a manual tool, works at any time and loses nothing. Before slice 11 it copies bodies back into the still-present column by seq. After slice 11 it first re-adds the column. Then it drops the side table.
- **Restoring the step-1 backup** is a short-window fallback only. `createBackup` keeps the last `MIGRATION_BACKUP_RETENTION` = 3 backups and every migrated boot writes one, so the pre-split backup ages out after three more migration runs. Restoring it also loses everything written since.

## Benefit measured

Same synthetic DB:
- A session-wide filter on non-indexed columns over a 55k-row session: before, 2,369 ms cold and 43 ms warm; after, 5 ms cold and 4 ms warm.
- Count via the #7746 index: 80 → 1.4 ms.

## Slices (100–200 production lines each, one PR per rung)

1. **Pin.** Characterization tests for the filter results of #1–4, 12, 21–23, 30, 32, 38, 39, 42, 46, 55, 61, 67 and the `task_message_rows` projection. For #12/#46, that includes a row whose JSON lacks `task_id` and resolves through the column.
2. **Build columns.** `deriveSdkMessageColumns`, migration adds and backfills the 15 columns (chunked), all writers set them.
3. **Wire repository filters** to the columns (#1–4, 16, 21–23, 30, 32, 38, 39, 42), adding the two typed eligibility projections above so the original predicates remain exact.
4. **Wire adapter and runtime filters** (#55, 56, 61–67) and the indexes from the scan table.
5. **Wire live-query filters** (#9, 12, 46, 47 with the TypeScript tool_use join, 48, 52).
6. **Build the bodies table** with dual write; reads unchanged.
7. **Split the `task_message_rows` triggers** into body-derived (on `sdk_message_bodies`, which now exists and receives every new body) and row-derived parts.
8. **Switch body outputs**, part 1: repository (#5–45), with the `LEFT JOIN … COALESCE` fallback.
9. **Switch body outputs**, part 2: live queries, adapters, runtime, the db-query view, same fallback.
10. **Migration.** Guarded columns at startup. The chunked copy and blank runs as an online background job, with the body trigger skipping copied rows by the seq cutoff, a free-disk check (refuse under 2× the DB size) and per-chunk progress logging. Malformed JSON gets NULL columns and is counted. Plus the reverse script. The blanked column stays.
11. **Delete.** Remove the dual write, the `COALESCE` fallback and every reference to the old column, and in the same slice the re-entrant rebuild that drops it (step 4).
12. **Session-length fixes outside the split:** #48/#49 paging and #50 targeted search rebuild.

Slices 2–5 also speed up today's daemon on their own, before any body moves.
