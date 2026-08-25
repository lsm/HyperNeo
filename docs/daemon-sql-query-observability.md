# Daemon SQL query observability

The production daemon database is intentionally retained and allowed to grow
(~29 GiB and rising as of 2026-08). Query regressions at that scale show up as
multi-second startup stalls or sluggish transcripts long before any test
notices. This document describes the two pieces of instrumentation that make
such regressions visible: always-on slow-query telemetry on the primary daemon
connection, and a strictly read-only live-scale regression harness.

## Slow-query telemetry

The primary daemon SQLite connection (the one shared by the repositories and
the live-query engine) is wrapped by `SQLiteQueryObserver`
(`packages/daemon/src/storage/sqlite-query-observability.ts`). Every executed
statement — `get`, `all`, `run`, lazy `iterate`, and direct `exec` — is timed,
and each execution is fingerprinted by a normalized form of its SQL
(`sqlite-query-normalization.ts`). Normalization strips comments, string/blob
literals, numbers, and bind placeholders, and redacts quoted-identifier
contents, so events never contain bound values, message bodies, tokens, or
credentials. `rowsScanned` is deliberately absent: `bun:sqlite` exposes no
scan-status counters without native bindings, and rows returned / rows changed
are the honest available signals.

Two structured events are emitted under module
`hyperneo:daemon:sqlite.query`:

- `sqlite.query.slow` (level `warn`) — one event per execution at or above the
  slow threshold, carrying `fingerprint`, `normalizedSql`, `operation`,
  `durationMs`, `thresholdMs`, `outcome`, and row metrics where known.
- `sqlite.query.summary` (level `info`) — a periodic rolling summary (default
  every 5 minutes, plus one final summary at shutdown) listing the slowest
  normalized queries with execution counts, slow counts, error counts, and
  total/average/max durations, so trends are visible as the corpus grows.

Aggregation is bounded (default 500 query groups per window). When the window
is full, a new query shape only displaces the retained group with the smallest
observed max duration; otherwise the execution is counted as discarded, and
both counters appear in the summary.

### Configuration

| Environment variable | Default | Meaning |
| --- | ---: | --- |
| `HYPERNEO_SQL_QUERY_OBSERVABILITY` | `on` | `0`/`false`/`off` disables; any other explicit value enables (even in `NODE_ENV=test`, where it is otherwise off) |
| `HYPERNEO_SQL_QUERY_SLOW_THRESHOLD_MS` | `250` | slow-query warn threshold |
| `HYPERNEO_SQL_QUERY_SUMMARY_INTERVAL_MS` | `300000` | summary cadence |
| `HYPERNEO_SQL_QUERY_MAX_QUERY_GROUPS` | `500` | retained query shapes per window |
| `HYPERNEO_SQL_QUERY_SUMMARY_LIMIT` | `10` | top queries per summary |

Invalid values fail closed to the defaults. Worker connections (message-search,
db-query tools) are out of scope by design; they opt in explicitly through the
same constructor option when that becomes necessary.

## Live-scale regression harness

```bash
bun run perf:daemon-live-scale -- --db /path/to/daemon.db
BENCH_DB_PATH=/path/to/daemon.db bun run perf:daemon-live-scale -- --json
```

The harness (`packages/daemon/scripts/benchmark/`) runs the hot query set
against the real database: `messages.bySession` snapshot/delta (the exact
production SQL plus the background-task metadata side query), `listWorkflows`
including its per-workflow node reads, the three consumed-sequence watermark
probes, the message-search admission lookup with the real policy pipeline, and
the job-queue dequeue candidate select (never the claim update).

Safety model, in layers:

1. The database is opened with `{ readonly: true }` and
   `PRAGMA query_only = ON`, and the `query_only` flag is read back and
   verified before anything runs.
2. Only the production-owned SQL constants and builders are executed — the
   harness never instantiates the storage facade, repositories that write, the
   dequeue/claim path, index flushes, or maintenance routines.
3. Every statement passes a lexical read-only guard (`SELECT`/`WITH`/
   `EXPLAIN` only) before it is prepared.
4. No long-lived read transaction is opened, so a live daemon's WAL is never
   pinned.

Reports exist as human text and stable JSON (`--json`), include
`EXPLAIN QUERY PLAN` output per statement, and gate on p95 latency per case
(`--threshold-ms`, `--profile-threshold-ms <profile>=<ms>`). Exit codes: `0`
pass, `1` threshold or input regression (suppress with `--no-fail` for
report-only runs), `2` usage/open/verification errors. Reports never contain
resolved identifiers, message bodies, or payload values.

Run it against the live database directly — it is read-only by construction —
or against an APFS clone when you want cold-cache numbers. CI covers the
parser, read-only enforcement, threshold evaluation, and the correctness of
each profile against a small fixture; wall-clock gates at live scale are a
manual/scheduled operation because the 29 GiB corpus cannot ship with PR CI.
