# Daemon DB Maintenance Runbook

Operational procedures for reclaiming dead space and refreshing planner statistics in
long-lived daemon databases (default location: `~/.hyperneo/data/daemon.db`, override with
`--db-path` / `DB_PATH`).

Use this runbook when:

- The DB file is much larger than its live data (deleted/moved rows leave free pages that
  SQLite only reuses lazily — the file never shrinks on its own).
- Queries pick bad plans after large data changes (planner statistics in `sqlite_stat1` are
  missing or stale).
- You are about to upgrade a daemon whose DB is too large for the automatic migration
  backup (see [Migration backups](#migration-backups)).

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

You need roughly **2× the current DB size** of free space beyond the file itself
(1× backup + 1× VACUUM temp) — on a 31 GB DB that is ~62 GB free.

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
time sqlite3 "$DB" "PRAGMA optimize;"
```

`PRAGMA optimize` selectively runs `ANALYZE` on tables whose stats are missing or stale
(and samples a bounded number of rows, so it stays fast even on multi-million-row tables).
The daemon also runs `PRAGMA optimize` on every clean shutdown, so this manual step only
matters after killed daemons or right after a VACUUM.

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

- **Stats:** `PRAGMA optimize` on every clean daemon shutdown
  (`packages/daemon/src/storage/database-core.ts`, `DatabaseCore.close()`).
- **WAL growth:** SQLite's default auto-checkpoint keeps the WAL bounded during operation,
  and clean shutdown truncates it.
- **Space reuse:** free pages left by deletes are reused for future writes before the file
  grows again — but never returned to the OS without VACUUM.

`auto_vacuum` is deliberately not enabled: it must be set before the DB is populated (or
followed by a full VACUUM anyway), only returns trailing pages, and adds write overhead.

## Migration backups

Before running schema migrations the daemon copies the whole DB file into
`<db-dir>/backups/daemon-<timestamp>.db` (keeping the 3 most recent). On a very large DB
that copy is itself an operational hazard — a 31 GB DB meant a 31 GB copy per upgrade and
up to ~93 GB retained.

Databases larger than **1 GiB** therefore skip the automatic migration backup; the daemon
logs a warning when this happens. Before upgrading a large production DB, take an offline
backup manually (step 3 above) while the daemon is stopped.

The bound is controlled by `HYPERNEO_DB_MIGRATION_BACKUP_MAX_BYTES`:

| Value       | Behavior                                              |
| ----------- | ---------------------------------------------------- |
| unset       | skip the migration backup above 1 GiB (default)      |
| `1073741824`| same as unset (explicit 1 GiB)                        |
| `0`         | always create migration backups, regardless of size   |
| other bytes | custom bound; invalid values fall back to 1 GiB       |

## Measured reference numbers

From the verification run of this runbook (2026-08-20, Apple Silicon laptop, APFS SSD,
sqlite 3.50.2). Clone built with the daemon's own schema: 30,000 `sdk_messages` rows with
~8 KB payloads (263 MB file), then 12,000 rows (40 %) deleted via session cascade.

| Step                      | Duration | Result                                        |
| ------------------------- | -------- | --------------------------------------------- |
| `.backup` of 263 MB       | 1.1 s    | consistent 263 MB snapshot                    |
| `VACUUM`                  | 2.0 s    | 263 MB → 157 MB, freelist 26,665 → 0          |
| `PRAGMA optimize`         | 0.02 s   | `sqlite_stat1` 0 → 20 entries                 |
| full `ANALYZE` (18k rows) | 0.04 s   | 42 entries (minutes at production row counts) |
| `PRAGMA integrity_check`  | 0.3 s    | ok                                            |
| daemon reopen after VACUUM| —        | schema, rows, FTS table, payloads intact      |

Production scale (31 GB, 3.69 M rows) extrapolates to: backup ~1–2 minutes, VACUUM tens of
minutes, `PRAGMA optimize` seconds-to-a-minute, `integrity_check` under a minute.
