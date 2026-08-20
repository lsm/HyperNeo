# Daemon DB Maintenance Runbook

Operational procedures for reclaiming dead space and refreshing planner statistics in
long-lived daemon databases (default location: `~/.hyperneo/data/daemon.db`, override with
`--db-path` / `DB_PATH`).

Use this runbook when:

- The DB file is much larger than its live data (deleted/moved rows leave free pages that
  SQLite only reuses lazily — the file never shrinks on its own).
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

## What is handled automatically

- **Stats:** plain `PRAGMA optimize` on every clean daemon shutdown — the periodic,
  connection-aware form SQLite recommends for long-lived connections
  (`packages/daemon/src/storage/database-core.ts`, `DatabaseCore.close()`).
- **WAL growth:** SQLite's default auto-checkpoint keeps the WAL bounded during operation,
  and clean shutdown truncates it.
- **Space reuse:** free pages left by deletes are reused for future writes before the file
  grows again — but never returned to the OS without VACUUM.

`auto_vacuum` is deliberately not enabled: it must be set before the DB is populated (or
followed by a full VACUUM anyway), only returns trailing pages, and adds write overhead.

## Migration backups

Before running schema migrations the daemon always writes a backup into
`<db-dir>/backups/daemon-<timestamp>.db` — unconditionally, regardless of database size.
A backup is only attempted when a migration is actually pending, so plain daemon restarts
create no backups. The 3 most recent backups are kept; room for the next backup is freed
before it is written (retaining the two newest known-good backups meanwhile), and WAL
sidecar files are pruned with their backups.

The copy strategy is picked per attempt, fastest first, and logged
(`Migration backup created via <strategy> in <ms>ms`):

| Strategy          | When it runs                          | What it does                                                                                                         |
| ----------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `fs-copy`         | Bun runtime (the pinned runtime)      | File copy that clonefiles on APFS (near-instant, ~zero extra disk until divergence) and uses `copy_file_range` on Linux, which reflinks on btrfs/XFS and falls back to a full copy elsewhere. A non-empty `-wal` sidecar is copied next to the backup so committed WAL frames survive. |
| `vacuum-into`     | non-Bun runtimes                      | `VACUUM INTO` — SQLite's own consistent snapshot: includes committed WAL content without a checkpoint, and compacts free pages. |
| `checkpoint-copy` | last resort if the above two fail     | `PRAGMA wal_checkpoint(TRUNCATE)` followed by a plain full-file copy.                                                  |

If every strategy fails (for example the backups directory is not writable), the daemon
logs an error and proceeds with the migration — the same behavior as before. A failed
WAL-sidecar copy likewise discards the `fs-copy` attempt and falls through to a
self-contained snapshot, so a reported backup never silently misses WAL-resident data.

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
