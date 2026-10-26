# HTTP polling page commands through the DB gateway

Use the existing checkout and installed dependencies. Run heavy jobs serially.
The runner prints `memory_pressure` and disk space and refuses to run under
25% free memory or 25 GiB free disk:

```sh
python3 .claude/skills/verify/coding-poll-db-run.py bun before
python3 .claude/skills/verify/coding-poll-db-run.py bun verify
python3 .claude/skills/verify/coding-poll-db-run.py deno before --executable "$DENO"
python3 .claude/skills/verify/coding-poll-db-run.py deno verify --executable "$DENO"
```

`DENO` names an existing Deno 2.9.4 executable; cached modules only are allowed.
No install or simulator is used. Each run owns fresh HOME, TMPDIR and DB paths,
an ephemeral non-8399 daemon, a refusing synthetic gh and tiny local Git fixtures.
The Git fixture rewrites only synthetic repository URLs to its own local bare
origin. No provider/model turn, real HTTP, existing database or credential is
used. Save raw JSON and request records before the runner immediately removes
the entire temporary daemon directory. `run.json` records guards and cleanup.

Before mode temporarily restores only `poll-facts.ts` and `poll-http.ts` from
the pinned origin/dev revision, then restores the draft in finally. Do not run
before mode alongside checks, tests or another proof. Fixture writes and row
assertions are outside the measurement window. Actual polling RPC processing
must reproduce poll-page SQL on main before migration and record zero afterward.

Two watched spaces share one synthetic repository. Drive the real
`space.github.pollOnce` WebSocket RPC through initial, conditional repeat,
failure, recovery and expiration cycles. The approval reaches each space once;
repeat and failed cycles cannot duplicate it. Recovery adds one newer approval
per space. Failure preserves cursors, prior JSON and successful timestamps.

Seed old watcher validators without matching raw coverage: cold and expired
pages must not send them upstream. A valid repeat must exercise 304. Expiration
must bound retained raw pages while preserving an unrelated legacy row and its
raw bytes. Stored HTTP metadata must omit the synthetic unsafe headers. Reopen
the daemon, retain the rows, and poll again without duplicating approvals.

In fixed mode, hold an old-cycle collector while a newer cycle commits through
the writer. The older response must reject as superseded rather than borrow
newer coverage; a stale writer receipt must return accepted=false with the
winner's same authoritative snapshot and revision.

A separate process holds the synthetic WAL writer for 1.2 seconds during an
external-page collection. Cleanup must commit before HTTP acquisition. A real
`system.health` RPC must finish below 250 ms and loop lag below one second.
The supplementary collector also waits 300 ms for its synthetic response, so
its affected duration exceeds 250 ms. This measures the collector under the
lock, not the complete public polling RPC under contention: other watched-repo
and event-family writes remain outside this slice. Keep that limitation and
latency miss in evidence. Gateway timings and serialized sizes are recorded;
worker queue, SQL and clone time are not separately attributed.

The two failing regressions preceded the fix: a main-instance coverage read and
cleanup against read-only main despite a bound writer. Focused tests preserve
ETag binding, cycle/credential isolation, sanitized metadata, partial and failed
coverage, late-response fencing, bounded retries, cleanup rollback and retention.

The synchronous record primitive remains used by the production connector PR
and review-thread adapters; those migrations are later lane-A slices. It is not
an exhausted compatibility setter. `observed.json` summarizes the four retained
runs; raw evidence is the source for each measurement.
