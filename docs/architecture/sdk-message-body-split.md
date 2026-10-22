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
| #4/#16/#21 user messages by status (count, ids, list) | JSON filter over the session | `(session_id, send_status, message_type, user_status_eligible, timestamp, id, sdk_uuid)` covering index; list reads a tail page |
| #22 queued inputs | done in #7744 (send-status index) | plus `input_kind` column, no JSON |
| #23/#30 last consumed/human input | tail LIMIT 1 behind a JSON predicate, scans when nothing matches | partial consumed-input time index and `(session_id, message_type, input_kind, timestamp)` seek |
| #32 restart evidence | JSON `json_each` tail | partial restart-prompt index ordered by session, status, type, timestamp, id; excludes tool results before scanning |
| #39/#67 consumed task input since | EXISTS over the session | `(session_id, task_id, task_input_eligible, timestamp, sdk_uuid)` partial consumed-user index |
| #42 unresolved action | EXISTS over action rows | `(session_id, message_subtype, resolved)` partial action index |
| #55 input-evidence probe | EXISTS over the session | partial `(session_id, consumed_seq, sdk_uuid)` boundary seeks; missing and equal-watermark ambiguity probes use separate UNION ALL seeks |
| #12/#46 task starts and latest progress per background task | whole subtype, `json_extract` partitions | `(session_id, message_subtype_norm, bg_task_id, timestamp)` and `(…, bg_tool_use_id, timestamp)`, latest per key via seek |
| visible count recompute | covered by #7746's `idx_sdk_messages_session_visible` | unchanged, index-only |
| shutdown boundary (#47) | covered by #7746 | unchanged |
| #48 task messages, #49 session group | return the whole task or group | paged: a tail window plus "load earlier", same contract as `messages.bySession` |
| #50 `rebuildMessageSearchRows` | re-reads every body of the session on status/type/context change | rebuild only rows whose inputs changed (status changes don't change search text); its own slice |
| #26 rewind `getUserMessages`, #40 assistant messages since | whole session, rare paths | key or range reads by seq; bodies joined for the returned rows only |
| #68, #74 | cross-session or scope copies | unchanged (admin and tooling paths), noted |

#7746's covering indexes stay. They're merged (0ffa0390) and present in `createIndexes` and m409. With the body gone, a non-indexed scan of a session reads small rows (5 ms for 55k rows in the benchmark below), but constraint 3 still requires index-only reads, and those two indexes provide them.

Slice 4 adds the scan-table indexes in migration 416 and the fresh-schema path.
Partial receipt, terminal-result, last-result and exchange time indexes also bound
adapter reads; the first-block expression index uses the original COALESCE rule.
All index keys and predicates use metadata only. Body outputs remain unchanged
until slices 8–9.

Slice 5 switches the live-query/repository predicates to these columns. The
transcript query selects only its capped top-level window; a TypeScript row
expander extracts tool-use ids from that window and fetches children by indexed
parent id. The live-query engine expands before hashing both snapshots and
deltas, so late child updates and window eviction retain the original behavior.
The active-turn CTE carries its selected metadata once, avoiding downstream
joins that can choose a whole-session scan. Body output projections (including
block/text extraction) stay in place for slices 8–9. Migration 417 adds a covering
session-window index so the bounded transcript selection never filters body pages;
the body is read by rowid only after the window is selected.

Slice 8 switches repository body outputs (#5–45) to a shared hydration query:
materialize the existing metadata selection first, then join only its chosen
rowids to `sdk_message_bodies`, with `COALESCE` falling back to the legacy body.
The caller's output order is repeated after hydration. Background-task ranking
and union arms now carry metadata only; they hydrate after selecting the latest
progress per key. Search admission and delivery normalization use the same body
source. Existing legacy-only rows, mixed copy state and side-only bodies preserve
the read contract. No historical copy, schema migration, trimming or new deletion
path is introduced. Live-query/adapter outputs remain for slice 9.

Slice 9 routes the remaining live-query, runtime, evolution and adapter body
outputs through the shared split-body reader. A scalar rowid lookup preserves
existing SQL output shapes, with the same side-first/legacy fallback as repository
hydration. Session feeds and background metadata use explicit joins to preserve
their existing no-correlated-subquery query-plan contracts. Background metadata
ranking and capped trace selection carry rowids
until the output projection. Both delivery-outbox reads, scoped SQL copies, lazy
task projection repair and the two result `json_set` source reads use that path.
Historical migration SQL and the intentional dual-write copy still read the
legacy column; runtime readers have a guard contract against direct legacy reads.
No historical copy, schema migration, body trimming or deletion is added here.

## Migration

Slice 7 installs the split projection triggers in migration 419 and the fresh
schema. Row upserts update metadata columns only; body upserts update flags,
artifact keys and JSON subtype only. Required insert fields are initialized when
either upsert creates a projection. Shared SQL expressions preserve the legacy
JSON/type/artifact semantics. Status updates of existing projections never parse
the body. An UPDATE encountering a missing historical projection first fills it
from the side body or legacy fallback, only when the projection id is absent;
this prevents an empty scaffold from defeating the count-based lazy repair. Blanking
the old column fires neither projection writer. Existing task detachment removes
only its projection; reattachment restores body fields using the side body or
the historical body until copying is complete. These rare classification paths
are separate from status updates. Message/body deletion policies are unchanged.
The empty `sdk_message_body_copy_active` singleton table suppresses body projection
only during the future copy job's own transaction; commit/rollback removes the
active flag with that transaction. Slice 7 performs no historical copy or rewrite.

Slice 6 creates `sdk_message_bodies` in migration 418 and the fresh schema. All
eight current repository body-write sites use `writeSdkMessageBody` to update
the original row (including its derived columns) and upsert the body in one
transaction. The old inventory's ninth write, the compaction stamp, is already
folded into the SDK insert. Reads and historical bodies are unchanged; no old
bodies are copied yet. Status-only updates do not rewrite the side table.
`sdk_message_bodies_ad` only follows an existing `sdk_messages` row deletion;
it introduces no message deletion, retention or trimming policy. Undeleted
messages and full tool results retain their exact body bytes.

Only the cheap schema steps run at startup. The body copy runs online as a background job: the dual write (slice 6) and the `COALESCE` reads (slices 8–9) make a half-copied table correct to read. That matters because the iMac database is about 30× the synthetic one. At startup the copy would keep the daemon down for minutes; online, it runs in chunks that yield between transactions, with no downtime. All numbers below are measured on synthetic data: 110k rows and 850 MB of JSON, about twice the laptop's live body bytes.

1. **Backup and disk check.** Slice 10 runs after bind, outside startup. It uses the guarded runtime capacity seam and refuses unknown free space or free space below twice the main DB plus WAL size; a runtime without workers logs an explicit refusal. A worker creates a SQLite-consistent `VACUUM INTO` snapshot from a read-only connection, fsyncs it, then verifies `quick_check`, the complete logical-body digest and a full-file SHA-256. Only then may the main connection change message rows. The pinned backup is `data/backups/sdk-message-bodies-v1/<DB basename>-<UUID>.db`, outside ordinary migration-backup rotation; its verification manifest is retained alongside it. Before starting a worker, persist the unique backup destination in a migration marker using zero busy wait and asynchronous lock retries. Every pre-first-chunk failure or restart reuses that destination; only its own incomplete `.partial` may be replaced, never other files or verified backups. A resumed cursor requires its original backup and manifest to exist and verify again. No backup failure permits copy/blank to proceed.
2. **Columns.** `ALTER TABLE ADD COLUMN` × 15: 33 ms (measured with 14). Each add is guarded by `pragma_table_xinfo` (the existing idiom), so a restart after a crash re-enters this step safely. In practice slice 2 has already added and backfilled them, and this step is a no-op.
3. **Chunked pass (background job).** Slice 10 uses up to 128 metadata rows or 1 MiB of body bytes, whichever comes first; one oversized row is processed alone. `octet_length` reads stored column sizes before loading bodies. A transaction stops adding rows after a 20 ms work target, persisting only its actual cursor. Each `BEGIN IMMEDIATE` has zero busy wait on the main connection and yields/retries if another writer owns the lock. After a transaction reaches 250 ms, log `slow_chunk_pause`, checkpoint and pause asynchronously for one second in the current run before the next chunk; keep its verified channel/cursor instead of forcing whole-backup verification each time. Cancellation clears the pause timer immediately. A process restart still verifies the original backup in full; disk latency cannot be preempted inside SQLite. Each chunk:
   - backfills the derived columns from the JSON;
   - copies the body into `sdk_message_bodies` with SQLite-native SQL, preferring any existing authoritative side body;
   - sets `sdk_message = ''`;
   - independently hashes each full selected body before and after copying in the same transaction, persisting both hash-chain states with its cursor;
   - clears its copy-suppression flag before commit, yields, and checkpoints WAL in the worker.

   The cursor carries the initial high-water seq, pinned backup path, start time and both audit chains. Rows arriving later are already dual-written by the production writers, so the cutoff can complete under continuous traffic. A normal write after a copied row remains authoritative in the side table. The copy's before/after hashes cover every migrated version byte-for-byte; they are not two snapshots of a changing whole database. Static synthetic acceptance additionally compares a full ordered logical-body hash across the entire DB. Progress logs include disk admission, verified backup path/size/quick-check, every committed chunk, final audit hashes/runtime and a 10 ms heartbeat's maximum lag. No copy work is awaited by daemon startup. Close marks the core closed before cancellation: delayed Space provisioning cannot start maintenance or retry after shutdown. Transient creation/copy failures may retry with committed chunks readable via the side-first fallback. Backup verification failures, invalid original/reserved backup locations, invalid persisted cursor data and mismatched audit hashes share a typed terminal error: stop automatic retries and log the pinned path (or unknown when unreadable) at error level for operator action. They never authorize replacing/deleting a verified backup or repairing stored state automatically.

   Shipped-slice validation: 90k synthetic rows, 1.455 GB DB including complete 735 KB tool results, 13.08 s including verified backup, two SIGKILL/restarts (before the first chunk and after it) and final offline hash. Max event-loop lag 24.53 ms, max transaction 8.51 ms, 381 real WebSocket health/transcript replies (max 16.00 ms), sampled allocated peak 2.245 GB including permanent backup/WAL. Startup was 50.72 ms first run and 36.15 ms on final resume. Exactly one reserved backup was reused without changing its mtime; unrelated backup/manifest/partial sentinels stayed byte-identical. Separate 65-second synthetic lifecycle observations compare the old closed-DB/repeated-verification bug with closed-start refusal and terminal error-level verification handling, including invalid pinned paths and disagreeing persisted audit hashes. A deliberate 300 ms UPDATE delay separately proves slow-chunk pause/resume with one backup verification instead of the old two; it is fault injection, not a physical disk performance measurement. These are synthetic measurements, not an iMac runtime forecast. The earlier design's 5k-row/16 MB estimates do not describe the shipped 128-row/1 MiB configuration.
4. **Retire the column** in two independently reviewed PRs. The online precursor always keeps complete side bodies at all eight writing sites and retains side-first `COALESCE` runtime reads in both modes until the downtime PR. After normal migrations and derived backfill, startup begins with safe dual writes and logs its per-connection mode at production WARN. If the copy was already complete and not reversed at startup, a read-only worker validates historical coverage without delaying server bind or delivery polling; successful verification enables side-only writes on that connection. Failed or cancelled verification retains dual writes. A complete slice-10 marker, no reversed marker and zero missing side bodies select side-only writes, retaining an empty legacy INSERT value for the existing NOT NULL constraint. Otherwise startup selects dual-write, mirrors each complete side body into legacy atomically and serves normally while the existing background copy runs. Fresh databases follow the same rule. Copy completion during the live process does not trigger a mode change; the next start schedules coverage verification in the worker. Historical payload-page reads never gate daemon availability. The separate downtime PR removes runtime fallbacks, compatibility INSERT values and the column only after verifying complete side coverage and logical hashes; legitimate nonempty legacy copies left by dual-writes are not a refusal condition. Prefer SQLite's native `ALTER TABLE ... DROP COLUMN` if synthetic schema/foreign-key/trigger/index contracts prove it preserves everything; otherwise use the 12-step rebuild with all dependent objects recreated. Its duration must be measured on the synthetic 1.455 GB fixture, including a new verified stop-point backup and rollback. The earlier 1–2 s estimate is not this measurement. Do not merge the downtime PR until Neo relays the human's window, and do not infer other daemons' completion from the laptop. Copy start/finish/progress observability also needs a focused follow-up: production defaults to WARN and filters the slice-10 INFO events before file logging; changing a live setting is not part of verification.

The body-derived `task_message_rows` trigger on `sdk_message_bodies` (slice 7) must not run for copied rows, but it must keep running for every other write. Slice 7 creates the one-row table `sdk_message_body_copy_active` empty, and the trigger's `WHEN NOT EXISTS (SELECT 1 FROM sdk_message_body_copy_active)` fires whenever it's empty. That covers every write from slice 7 on, and after the copy ends. The copy job inserts the row at the start of each chunk transaction and deletes it before commit. Chunks run synchronously on the daemon's single connection, so no other write can happen while the row exists. The skip therefore covers exactly the copy's own inserts, with no seq comparison, so a NULL cutoff or a reused rowid can't disable it. Copied bodies are unchanged, so the projection rows the trigger would recompute are already correct, and the measured copy cost (taken without the trigger) is the shipped cost.
5. **Markers.** Slice 10's migration (steps 1–3) and slice 11's (step 4) each set their own marker only after their last step.

Crash safety: each marker is set only after its last step, so a crash anywhere makes the next run re-enter the migration, and every step is safe to re-run. A crash inside a chunk rolls back that chunk's flag row with the rest of its transaction. Steps 2 and 4 are guarded as described. In step 3 every chunk is one transaction, and the copy is `INSERT OR IGNORE` from the rows not yet blanked. A restart picks up where `sdk_message <> ''` rows remain, and a half-done chunk rolls back with its transaction. Rows already blanked always have their body copied in the same transaction. 

Space: the file grows from 943 MB to 1,190 MB in the benchmark (+26%), with 249 MB free and reused by later writes. There's no VACUUM on the boot path (as in #2961). Expected sizes:

- **Laptop:** about 1.1–1.2 GB; the copy pass takes about 7–8 s of chunk work in total.
- **iMac:** about +26% at peak, so up to about 48 GB, and roughly 4–8 minutes of chunk work spread over normal running. The 2× free-disk check is the binding constraint there.

The earlier design estimated 1–2 s for the laptop rebuild and roughly a minute for an older iMac row count. These are not measured downtime-path acceptance numbers. Re-measure the current synthetic 1.455 GB fixture and include backup/verification/rollback before proposing a window; the iMac separately needs its actual build, row count and free-space assessment.

Rollback has two paths:

- **The reverse script** is the durable path: stop the daemon, then run `bun packages/daemon/scripts/restore-sdk-message-bodies.ts <DB path> --restore-legacy`. It acquires the same DB PID lock, copies complete bodies back in yielding byte-bounded chunks, and re-adds the legacy column if absent. It retains the side table and pinned backup, preserving messages written after the backup. A reversed marker disables automatic copy; slice 11 must require completion without that marker before rebuilding. No automatic rollback, side-table deletion or message deletion is added.
- **Restoring the step-1 backup** loses everything written since that snapshot and is a manual fallback only. This pinned backup is not subject to the three-backup rotation used by unrelated schema migrations.

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
10. **Migration.** Guarded columns at startup. The chunked copy and blank runs as an online background job, with the body trigger skipping copied rows through the transaction-local flag described above, a free-disk check (refuse under 2× the DB size) and per-chunk progress logging. Malformed JSON gets NULL columns and is counted. Plus the reverse script. The blanked column stays.
11. **Retire.** Online precursor: after migrations/backfill, choose dual-write while the copy is incomplete, reversed or missing any side body; on the next start validate an already-complete copy in a read-only worker, serving with dual writes until zero gaps are verified. Log pending and final modes at WARN; retain side-first COALESCE reads until column removal. Every write keeps its complete side body. Scheduled downtime PR: verified stop-point backup, column removal and the last compatibility references, preserving all schema objects and bodies (step 4). Nonempty legacy copies left by concurrent dual-writes are legitimate: validate side completeness and full logical hashes rather than requiring empty legacy text.
12. **Session-length fixes outside the split:** #48/#49 paging and #50 targeted search rebuild.

Slices 2–5 also speed up today's daemon on their own, before any body moves.
