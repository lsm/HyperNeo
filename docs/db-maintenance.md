# Daemon DB Maintenance Runbook

Operational procedures for reclaiming dead space and refreshing planner statistics in
long-lived daemon databases (default location: `~/.hyperneo/data/daemon.db`, override with
`--db-path` / `DB_PATH`).

Use this runbook when:

- The DB file is much larger than its live data (deleted/moved rows leave free pages that
  SQLite only reuses lazily — the file never shrinks on its own). For a large freelist where
  you also want the original file kept untouched as the backup (or want to opt the DB into
  `auto_vacuum=INCREMENTAL`), prefer the [full rebuild](#full-rebuild-export-and-swap).
- Queries pick bad plans after large data changes (planner statistics in `sqlite_stat1` are
  missing or stale).
- You want to know what the automatic migration backups cost on disk, or shrink a DB whose
  backups are full copies (see [Migration backups](#migration-backups)).

The daemon opens the DB in WAL mode with `busy_timeout=5000`, `synchronous=NORMAL`,
`foreign_keys=ON`, and holds a PID lock (`<db>.lock`) so only one daemon uses a DB at a time.
A clean shutdown runs `PRAGMA optimize` followed by `wal_checkpoint(TRUNCATE)`, so the `-wal`
file is normally empty or absent while the daemon is stopped.

## Diagnosis (read-only, safe while the daemon runs)

```bash
DB=~/.hyperneo/data/daemon.db

ls -lh "$DB" "$DB-wal" 2>/dev/null
sqlite3 "$DB" "PRAGMA page_size; PRAGMA page_count; PRAGMA freelist_count;"
```

`freelist_count / page_count` is the share of the file holding dead rows. In the incident
that motivated this runbook the production DB was 31 GB with a ~9.2 GB freelist
(2,305,413 of 8,364,000+ pages) — roughly 30 % of the file was reclaimable.

Rule of thumb: run the VACUUM procedure below when `freelist_count / page_count` exceeds
~0.25 **and** the absolute reclaim (freelist × page_size) is worth the downtime.

## Offline maintenance procedure (VACUUM)

Requires the `sqlite3` CLI (3.50.x verified). Total downtime = backup + VACUUM + optimize;
see [measured numbers](#measured-reference-numbers) to estimate.

### 1) Stop the daemon and confirm the lock is gone

```bash
DB=~/.hyperneo/data/daemon.db

# Stop the daemon process (Ctrl-C, service manager, or kill <pid>), then:
cat "$DB.lock" 2>/dev/null   # should print your daemon's (now dead) PID or not exist
ps -p "$(cat "$DB.lock" 2>/dev/null)" || echo "lock holder is not running"
```

A clean shutdown removes `<db>.lock` itself. If the daemon was killed the lock file may
remain, but the PID inside must not be a live process — the daemon refuses to start when
the PID in the lock is alive, and the maintenance steps below assume exclusive access.

### 2) Check free disk space

VACUUM rebuilds the database into a temporary file, and step 3 writes a full backup copy:

```bash
df -h "$(dirname "$DB")"
```

Budget up to **3× the current DB size** of free space beyond the file itself: 1× for the
step-3 backup copy plus up to 2× for VACUUM, which rebuilds into a temporary database and
journals the overwrite of the original (SQLite documents VACUUM alone as needing up to
twice the DB size in free space). On a 31 GB DB that is ~93 GB free; the journal share is
often smaller in practice, but do not provision the theoretical minimum.

### 3) Take a backup

```bash
sqlite3 "$DB" ".backup '$DB.pre-vacuum-$(date +%Y%m%d).db'"
```

The sqlite3 `.backup` command uses the online backup API: it produces a consistent
snapshot that includes committed WAL content (covers the killed-daemon case where
`<db>-wal` still holds data). Do not just `cp` the file while a `-wal` may be present,
and never delete `-wal`/`-shm` by hand.

### 4) VACUUM

```bash
time sqlite3 "$DB" "VACUUM;"
```

VACUUM must run outside a transaction and takes exclusive access for its duration.
Expect roughly linear time in DB size (measured: 2 s for 263 MB → extrapolate to tens of
minutes for a 31 GB DB on comparable storage).

### 5) Refresh planner statistics

```bash
time sqlite3 "$DB" "PRAGMA optimize=0x10002;"
```

Use the one-shot form `PRAGMA optimize=0x10002`: bit `0x10000` makes this fresh sqlite3
connection consider **all** tables (a plain `PRAGMA optimize` only considers tables the
connection itself has queried, so it can leave existing stale `sqlite_stat1` rows alone —
verified: after 15x row growth on a fresh connection, plain left the stats at the old
count while `0x10002` refreshed them), and bit `0x00002` runs `ANALYZE` on tables that
are missing stats or whose row counts changed roughly 10-fold. ANALYZE samples a bounded
number of rows, so this stays fast even on multi-million-row tables.

The daemon runs plain `PRAGMA optimize` on every clean shutdown — the periodic,
connection-aware form SQLite recommends for long-lived connections — so this manual step
only matters after killed daemons or right after a VACUUM.

A full `ANALYZE` is **not** part of the routine: on the 3.69 M-row production clone it
ran for minutes without completing. Only run it if query plans remain bad after
`PRAGMA optimize`:

```bash
time sqlite3 "$DB" "ANALYZE;"
```

### 6) Verify integrity and reclaim

```bash
sqlite3 "$DB" "PRAGMA integrity_check;"          # expect: ok
sqlite3 "$DB" "PRAGMA page_count; PRAGMA freelist_count;"
ls -lh "$DB"
```

Expect `freelist_count` = 0 and the file size to drop by roughly freelist × page_size.

### 7) Restart the daemon and confirm

Start the daemon as usual and check startup succeeds. Once you are confident, delete the
pre-vacuum backup copy to reclaim its disk.

## Full rebuild (export-and-swap)

`scripts/rebuild-daemon-db.ts` reclaims freelist space by rebuilding the database into a
fresh file instead of running VACUUM in place. Prefer it when:

- The freelist is large but an in-place VACUUM is unattractive: VACUUM needs up to 2× the
  DB size in free space and overwrites the original file, while the rebuild keeps the
  original untouched as the backup until the new file has proven itself.
- You want the database to opt into `auto_vacuum=INCREMENTAL`, which lets a later
  `PRAGMA incremental_vacuum` return trailing free pages on demand (see the caveat below).
  That setting must be applied before a database is populated (or followed by a full
  rebuild anyway) — exactly what this does.

The incident that motivated it (2026-08-23 forensics): the production daemon.db was
28.9 GiB with 1,537,196 freelist pages (~5.9 GiB, 20 % of the file). Two startup freezes
that day (137 s in the db.initialize region; a 145.7 s event-loop stall) were aggravated by
every boot, checkpoint, and page-cache warm-up paying the dead-pages tax.

### What the script does

1. Acquires the daemon PID lock (`<db>.lock`) and holds it for the whole rebuild — a daemon
   (or second rebuild) started mid-run reads the live PID and refuses to open the database.
   Refuses to start itself while the lock names a live PID unless `--force` is passed.
   Reclaiming a stale lock is serialized with an exclusive `<db>.lock.takeover` marker so
   only one contender ever removes it; a leaked marker (crash mid-takeover) makes further
   acquires fail with its path so an operator can verify and remove it — no process ever
   deletes another's marker.
2. If `<db>-wal` is non-empty (killed daemon), checkpoints it into the main file first —
   committed WAL frames are data and must not be lost.
3. Creates `<db>.rebuild-<timestamp>.db` with `auto_vacuum = INCREMENTAL` and WAL enabled
   before any object exists, attaches the original (the script never writes to it), and:
   - recreates every table in foreign-key dependency order (virtual tables after their
     content tables),
   - copies every row of every table, passing an explicit `rowid` for tables without an
     `INTEGER PRIMARY KEY` alias so rowid cursors stay stable; `WITHOUT ROWID` tables and
     generated columns are handled,
   - reconciles `sqlite_sequence` with max-semantics so AUTOINCREMENT tables never reissue
     ids even when the sequence is ahead of the max rowid,
   - rebuilds each FTS5 index from its content table (the `'rebuild'` command — shadow
     tables reject direct writes),
   - recreates indexes, views, and triggers after the data copy so triggers do not fire
     during import, and copies `PRAGMA user_version`.
4. Verifies before any swap: `PRAGMA quick_check` (or `integrity_check` with
   `--full-integrity`), `PRAGMA foreign_key_check`, per-table row counts (source vs
   rebuilt), schema-object parity for tables/indexes/triggers/views, the FTS5
   `'integrity-check'` command with `rank = 1` (which compares index postings against the
   external content table, not just internal structure), `user_version`, a zero freelist,
   and `auto_vacuum = INCREMENTAL`. Any failure removes the partial rebuild file and leaves
   the original untouched — zero rows are ever deleted by this procedure.
5. Swaps crash-safely: the rebuilt file first receives the original's ownership and
   permission bits (so a rebuild run under a different account cannot strand the daemon
   with a file it cannot write), the original is preserved under
   `<db>.pre-rebuild-<timestamp>` via a hard link, and the rebuilt file then atomically
   replaces the canonical path — the canonical path never goes missing, even if the
   process dies between the two steps, and a failure after promotion keeps the backup
   rather than deleting it. Non-empty WAL sidecars travel with their database; empty
   sidecars are dropped. Every checkpoint verifies it was not blocked by a foreign reader
   and fails closed when it was.

`sqlite_stat1` cannot be created or copied into a fresh database (the name is reserved), so
the rebuilt DB starts without planner statistics. The daemon's regular shutdown
`PRAGMA optimize` rebuilds them; if plans look bad immediately after a swap, run the
one-shot `PRAGMA optimize=0x10002` from step 5 of the VACUUM procedure above.

A caveat on `auto_vacuum = INCREMENTAL`: it does **not** shrink the file by itself. Deletes
still leave freelist pages that SQLite first reuses for new writes; trailing free pages are
returned to the filesystem only when `PRAGMA incremental_vacuum` runs (it can be given a
page budget and called periodically, and it never moves pages stranded mid-file). To shrink
the rebuilt DB during future maintenance windows:

```bash
sqlite3 "$DB" "PRAGMA incremental_vacuum;"
```

A caveat on POSIX ACLs and extended attributes: the rebuild copies ownership, group, and
mode bits, but Node/Bun do not expose portable ACL/xattr APIs. If the original database
relies on a per-file POSIX ACL (for example, a root-owned file whose ACL grants the daemon
account access) or on extended security attributes, the freshly created rebuild inherits
directory defaults and `chmod`/`chown` alone do not restore them. The original database is
kept as `$DB.pre-rebuild-<timestamp>` after a successful swap, so always read the metadata
from that retained backup and apply it to the swapped-in path. Note that `setfattr --restore`
applies the dump to the path recorded in its `# file:` header (the backup), not to the
target — rewrite the header or apply attributes explicitly:

```bash
BACKUP=$(ls -1t "$DB".pre-rebuild-* | head -1)
getfacl "$BACKUP" > /tmp/db.acl && setfacl -M /tmp/db.acl "$DB"
getfattr -d -m - "$BACKUP" 2>/dev/null \
  | sed "s|^# file: .*|# file: $DB|" > /tmp/db.attr \
  && setfattr --restore=/tmp/db.attr
# Fallback: apply each attribute explicitly when the dump format is not rewriteable.
getfattr -d -m - --absolute-names "$BACKUP" 2>/dev/null \
  | awk -v target="$DB" '/^#/ {next} NF {print target; print; print ""}' \
  | setfattr -h -S -
```

Alternatively, use the `--no-swap` flag, copy the rebuilt file into place with `cp -a`
(preserves ACLs and xattrs on filesystems that support them), then verify and let the next
daemon restart pick it up.

### Running it

```bash
DB=~/.hyperneo/data/daemon.db

df -h "$(dirname "$DB")"
bun run scripts/rebuild-daemon-db.ts --db-path "$DB"
```

Free-space budget: the new file (roughly the live-data size) exists on disk in addition to
the original until the backup is archived — for the 28.9 GiB production DB with a ~5.9 GiB
freelist that meant ~30 GiB free required; the script refuses to start with less than
(original size + 2 GiB) available. The import copies rowid tables in bounded batches of
50,000 rows and checkpoints after every batch, so the WAL never grows beyond one batch and
peak usage stays near original + rebuilt — except that each FTS5 index rebuild is a single
internal transaction whose WAL transiently holds the whole index; if an index is expected
to exceed the headroom, provision additional free space equal to its projected rebuilt
size. `WITHOUT ROWID` tables have no rowid cursor and are copied in a single transaction,
so the same provision applies if one of them is unusually large (the daemon schema keeps
such tables small).

The confirmation prompt must be answered with `rebuild` (pass `-y` to skip). `--no-swap`
builds and verifies but leaves both files in place, printing the commands for a manual
swap — they move the original's `-wal`/`-shm` sidecars aside first (so a leftover source
WAL is never applied to the rebuilt file), preserve the original via hard link, and
promote the rebuilt file with an atomic rename, keeping the canonical path present at
every step. The rebuilt snapshot only reflects the original as of that moment, so keep
the daemon stopped, swap immediately, and if anything wrote to the original in the
meantime, discard the rebuilt file and re-run; never promote a snapshot across a daemon
boot. `--full-integrity` switches verification to the slower `PRAGMA integrity_check`.

Downtime = import + verification, the same order of magnitude as a VACUUM (minutes to tens
of minutes for a ~29 GiB file). The original file is only touched by the initial WAL
checkpoint (when one is pending) and the final rename.

### After the swap

1. Start the daemon and confirm a clean boot: startup log, session list, message search.
2. Keep the `<db>.pre-rebuild-<timestamp>` backup until the rebuilt database has run for a
   while; archive or delete it at the operator's discretion — the script never does.
3. To roll back, stop the daemon, then preserve the rebuilt database via a hard link and
   restore the backup with an atomic rename, so the canonical path holds a complete
   database at every instant; move a rebuilt `<db>-wal` aside first, since SQLite would
   otherwise apply its frames to the wrong database and corrupt it:

   ```bash
   mv <db>-wal <db>.failed-rebuild-wal   # only if present
   mv <db>-shm <db>.failed-rebuild-shm   # only if present
   rm -f <db>.failed-rebuild && ln <db> <db>.failed-rebuild
   mv -f <db>.pre-rebuild-<timestamp> <db>
   mv <db>.pre-rebuild-<timestamp>-wal <db>-wal   # only if the backup has one
   ```

   On a filesystem without hard links (the script falls back to `cp` there too), replace
   the `rm -f ... && ln ...` line with `cp <db> <db>.failed-rebuild`.

### Scheduling

Run the one-time rebuild after the index audit (#1403) and migration-hygiene (#1404)
changes land, so the database is compacted once at the end instead of rewriting indexes
that are about to be dropped. The procedure itself is repeatable at any time — for example
after a future batch of rewrite migrations leaves a large freelist again.

## What is handled automatically

- **Rewrite migrations:** migrations that rebuild tables are declared with `rewrite(...)` in the
  migration runner. Their row copies run with a raised connection page cache, in-memory temp
  storage, and mmap reads, batched into ~200k-row transactions so the WAL auto-checkpoints
  between chunks and an interrupted copy resumes from the last committed chunk on the next
  startup. After those migrations commit the daemon records the rewrite markers as reclaimed
  **without running `VACUUM`**: the freelist pages a rewrite leaves behind are dead weight the
  daemon never shrinks on its own, so run the offline VACUUM procedure above when the file's
  high-water mark matters. Future table rewrites must use this declaration.
- **Stats:** plain `PRAGMA optimize` on every clean daemon shutdown — the periodic,
  connection-aware form SQLite recommends for long-lived connections
  (`packages/daemon/src/storage/database-core.ts`, `DatabaseCore.close()`).
- **WAL growth:** SQLite's default auto-checkpoint keeps the WAL bounded during operation,
  and clean shutdown truncates it.
- **Space reuse:** free pages left by ordinary deletes are reused for future writes before the
  file grows again. The daemon never runs `VACUUM` automatically; shrinking the file is always
  the manual procedure above.

`auto_vacuum` is not enabled on databases the daemon creates: it must be set before the DB
is populated (or followed by a full rebuild anyway), adds write overhead, and without an
explicit `PRAGMA incremental_vacuum` it never shrinks the file at all. The one-time
[full rebuild](#full-rebuild-export-and-swap) opts the production database into
`auto_vacuum = INCREMENTAL`, so future maintenance windows can return trailing free pages
with `PRAGMA incremental_vacuum` instead of a full VACUUM; pages stranded mid-file still
need a rebuild.

## Migration backups

Before running schema migrations the daemon always writes a backup into
`<db-dir>/backups/<db-file-name>/daemon-<timestamp>.db` — unconditionally, regardless of
database size. A backup is only attempted when a migration is actually pending, so plain
daemon restarts create no backups. Backups are namespaced per database file, so several
databases sharing one directory (for example the per-worktree development pattern) never
prune each other's snapshots; within a namespace the 3 most recent backups are kept, room
for the next backup is freed before it is written (retaining the two newest known-good
backups meanwhile), and WAL sidecar files are pruned with their backups. Releases before
this layout stored backups flat in `backups/` — those are not auto-pruned; remove them
manually after upgrading.

The copy strategy is picked per attempt, fastest first, and logged
(`Migration backup created via <strategy> in <ms>ms`):

| Strategy          | When it runs                          | What it does                                                                                                         |
| ----------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `fs-copy`         | Bun runtime (the pinned runtime)      | File copy that clonefiles on APFS (near-instant, ~zero extra disk until divergence) and uses `copy_file_range` on Linux, which reflinks on btrfs/XFS and falls back to a full copy elsewhere. A non-empty `-wal` sidecar is copied next to the backup so committed WAL frames survive. |
| `vacuum-into`     | non-Bun runtimes                      | `VACUUM INTO` — SQLite's own consistent snapshot: includes committed WAL content without a checkpoint, and compacts free pages. |
| `checkpoint-copy` | last resort if the above two fail     | `PRAGMA wal_checkpoint(TRUNCATE)` followed by a plain full-file copy; a blocked checkpoint (`busy ≠ 0`, for example a long-lived reader) also copies the `-wal` sidecar, and the attempt fails closed if that copy fails. |

If every strategy fails (for example the backups directory is not writable), the daemon
logs an error and proceeds with the migration — the same behavior as before. A failed
WAL-sidecar copy likewise discards the `fs-copy` attempt and falls through to a
self-contained snapshot, and only after the partial artifacts are confirmed removed, so a
stale sidecar can never sit beside a newer snapshot; a reported backup never silently
misses WAL-resident data.

To restore from a backup, copy the `.db` file and its `-wal` sidecar (when one is
present) back together — a sidecar exists exactly when the backup depends on WAL-resident
committed frames, and restoring only the `.db` would silently lose every post-checkpoint
transaction — then open the database once so SQLite folds the WAL in with a checkpoint.

Each backup is written under a `.tmp` name and published by atomic rename once the pair
completes, so a crash mid-copy never leaves a partial file at a retained name. Sweeping
runs when the next backup is created, not on a timer: leftover `.tmp` artifacts and
orphaned `.db-wal` sidecars are only removed once they have seen no write progress for an
hour, so a sidecar that is mid-publish (renamed before its database) or a long-running
copy is never mistaken for a crashed leftover.

Disk cost: on APFS (and reflink-capable Linux filesystems) retained backups are
copy-on-write clones, so keeping 3 costs almost nothing until the files diverge. On
filesystems without clone support every backup is a full copy, and an `fs-copy` backup
whose WAL holds committed frames (for example after an unclean shutdown, or while a
long-lived reader keeps checkpoints from completing) also retains a full copy of that
`-wal` sidecar — budget up to 3 × (DB + WAL) for an upgrade on such a volume, and run the
offline VACUUM procedure above first if that is a concern. The
`HYPERNEO_DB_MIGRATION_BACKUP_MAX_BYTES` size bound (which skipped backups for DBs over
1 GiB) was removed: large databases are exactly where a pre-migration backup matters most,
and with clone-based copies it is no longer expensive.

Measured on a 28.9 GB production clone (Apple Silicon laptop, APFS SSD, Bun runtime): the
`fs-copy` pre-migration backup completed in **1 ms** with ~0 bytes of net disk added
(APFS clone; volume free space unchanged), the whole pending-migration startup took ~4 s
(migration, catalog, and FTS work — not the backup), a restart with no pending migrations
created no new backup, and the backup opened and passed `PRAGMA integrity_check`.

## Measured reference numbers

From the verification run of this runbook (2026-08-20, Apple Silicon laptop, APFS SSD,
sqlite 3.50.2). Clone built with the daemon's own schema: 30,000 `sdk_messages` rows with
~8 KB payloads (263 MB file), then 12,000 rows (40 %) deleted via session cascade.

| Step                      | Duration | Result                                        |
| ------------------------- | -------- | --------------------------------------------- |
| `.backup` of 263 MB       | 1.1 s    | consistent 263 MB snapshot                    |
| `VACUUM`                  | 2.5 s    | 263 MB → 157 MB, freelist 26,665 → 0          |
| shutdown `PRAGMA optimize`| ~0       | `sqlite_stat1` 0 → 20 entries (in daemon close) |
| `PRAGMA optimize=0x10002` | 0.02 s   | `sqlite_stat1` 20 → 27 (covers unqueried tables) |
| full `ANALYZE` (18k rows) | 0.04 s   | 42 entries (minutes at production row counts) |
| `PRAGMA integrity_check`  | 0.3 s    | ok                                            |
| daemon reopen after VACUUM| —        | schema, rows, FTS table, payloads intact      |

Production scale (31 GB, 3.69 M rows) extrapolates to: backup ~1–2 minutes, VACUUM tens of
minutes, `PRAGMA optimize` seconds-to-a-minute, `integrity_check` under a minute.
