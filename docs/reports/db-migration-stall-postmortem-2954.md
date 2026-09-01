# Large-Database Migration Stall: Postmortem and Design Lessons (#2954)

Incident 2026-08-25, fixed by #2961. This report records what we measured while
fixing it, so the next GB-scale schema refactor starts from evidence instead of
SQLite defaults and folklore.

## Incident summary

On a production DB (29 GB file, 4.4M `sdk_messages` rows), migration 212 — a
`sdk_messages` PK rewrite (`id TEXT` → `seq INTEGER PRIMARY KEY`) — blocked
daemon startup for ~80 minutes inside one `BEGIN…COMMIT`, writing ~19.7 GB of
WAL at ~6 rows/sec. CPU sat at 20–40% of one core while the physical disk was
idle: the bottleneck was pager thrash, not storage. After commit the file was
40.3 GB with a 17.3 GB freelist, and because reclaims were recorded only after
a VACUUM ran, the next startup had a second full-database stall queued.

Root causes, in the order they mattered:

1. The whole copy was one atomic transaction — nothing could checkpoint,
   nothing could survive a crash.
2. SQLite's default page cache (~2 MB) is sized for embedded devices; the
   pager spilled dirty pages to WAL on nearly every insert
   (observed: `pagerStress → pagerWalFrames → unixWrite`).
3. Index sorts went through file-backed temp storage (no `temp_store`).
4. An unconditional boot-path `VACUUM main` waited behind every rewrite with a
   non-empty freelist.

## What the fix did (#2961)

- Chunked the copy into ~200k-row transactions; an interrupted run resumes
  from `MAX(seq)` of a schema-compatible partial table; drop/rename/index
  swap stays atomic.
- Raised `cache_size`/`temp_store`/`mmap_size` **only around migrations** and
  restored bounded runtime defaults afterward.
- Recorded rewrite-migration space reclaims without VACUUM; shrinking the
  file is the manual offline procedure in `docs/db-maintenance.md`.

## Measurements

All numbers from copies of the real DB (readonly snapshot via `VACUUM INTO`),
4,420,697 rows / 23.2 GiB live, Bun 1.3.x on Apple Silicon-class hardware.

### Cache size stops mattering once you chunk

Full migration over a 1M-row synthetic fixture at five cache ceilings:

| cache_size | end-to-end |
| --- | --- |
| default (~8 MiB) | 114 s |
| −524288 (512 MiB) | 124 s |
| −1048576 | 119 s |
| −2097152 | 143 s |
| −8388608 | 125 s |

Flat within noise. Chunk boundaries give the pager a chance to checkpoint and
reset; once that exists, a bigger cache buys nothing. "We have lots of RAM" is
not an argument for a big runtime cache either: steady-state daemon working
sets are small and index-driven, and the OS page cache serves large cold reads
for free. Keep big pragmas scoped to the migration window.

### Production-scale redo

| metric | incident (old code) | chunked + resumable |
| --- | --- | --- |
| copy + swap | ~80 min, crash = restart at zero | ~43 min clean-path on a fresh compacted copy |
| WAL peak during copy | 19.7 GB | ~0.16–0.83 GB (autocheckpoint between chunks) |
| crash mid-migration | full restart | lost ≤1 chunk; resume skipped the finished copy instantly |
| next-boot VACUUM | +24 min blocking startup | none (reclaim recorded in ~6 ms) |

The swap transaction (drop old table + rename + rebuild all 10 indexes) was
measured step by step at production scale: DROP ≈ 4.6 min (page-freeing only,
near-zero WAL writes), then 3–13 min per index rebuild — the swap phase, not
the row copy, dominates once copying is chunked. Real random-UUID ids and
3–7 KB payloads are what make index builds slow; see the caveat below before
trusting synthetic fixtures for this kind of estimate.

### Correctness under repeated hard kills

Two SIGKILLs landed mid-migration during benchmarking. Both times: committed
chunks survived, the in-flight chunk rolled back, old table untouched until
the atomic swap. Resumption verified the partial table's schema before
trusting its watermark and dropped an incompatible leftover instead of
resuming onto it. Final state verified exact: row count, distinct
seq 1..4420697, zero FK violations, `integrity_check: ok`.

## Lessons for future database refactors

1. **Never ship a GB-scale table rewrite as one transaction.** One transaction
   means unbounded WAL, no checkpoint relief, and total loss on crash. Batch
   by a monotonic watermark and make the final swap (drop/rename/indexes) the
   only atomic unit.
2. **Design resumability in from the start.** Copying into a staging table
   with a natural high-water mark (`MAX(seq)`) turns a crash from "restart the
   migration" into "skip to where you left off". Verify the staging table's
   schema before resuming; drop leftovers that do not match.
3. **Index rebuilds dominate; cache tuning does not save you.** After
   chunking, expect the swap's index builds to be the long pole at millions of
   rows. Consolidating redundant indexes (three of ours led with `session_id`)
   is worth more than any pragma — measure hot paths with `EXPLAIN QUERY PLAN`
   before the migration ships, not after it stalls.
4. **SQLite defaults are embedded-device sized.** Raise `cache_size`,
   `temp_store = MEMORY`, and `mmap_size` for bulk work — and restore bounded
   values afterward so a long-lived server connection never carries a 512 MB
   ceiling or uncapped in-memory sorts.
5. **Keep multi-minute maintenance off the boot path.** Free pages are reused
   by future writes; a VACUUM that only shrinks the file is an offline task,
   not a startup gate. Record completion markers without requiring the
   expensive step to have run.
6. **Synthetic fixtures flatter legacy code paths.** A monotonic-id fixture
   made the old single-transaction copy look fine (~12k rows/s); the real
   random-UUID data thrashed at ~6 rows/s. Benchmark on production-shaped keys
   and payload sizes — a readonly `VACUUM INTO` snapshot copy is a cheap,
   consistent way to get one.
7. **Measure the thing you removed, too.** Timing the deleted boot-path VACUUM
   (24 min) justified it as strongly as timing the new copy path.

## Benchmark methodology notes

- Snapshot production read-only via `VACUUM INTO ?` from a `readonly: true`
  connection — never open the live DB writable, even for benchmarks.
- Sample `-wal` size from a separate process: synchronous migrations block the
  JS event loop, so in-process timers never fire.
- Pre-migration backup cost on APFS is ~1 s for 40 GiB (`copyFileSync` uses
  clonefile copy-on-write); don't optimize backup strategy without checking
  the filesystem first.
- Reverting a migrated DB back to pre-migration shape (chunked copy in
  reverse + atomic swap) is a practical way to produce a repeatable
  pre-migration fixture from live data.
