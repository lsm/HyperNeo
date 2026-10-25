# Ancestry observations through the DB gateway

Use the existing checkout and installed dependencies. The runner prints free
space on the data volume and refuses to start below 25 GiB:

```sh
python3 .claude/skills/verify/coding-ancestry-db-run.py bun before
python3 .claude/skills/verify/coding-ancestry-db-run.py bun verify
python3 .claude/skills/verify/coding-ancestry-db-run.py deno before --executable "$DENO"
python3 .claude/skills/verify/coding-ancestry-db-run.py deno verify --executable "$DENO"
```

`DENO` names an existing Deno 2.9.4 executable; cached modules only are allowed.
There is no runtime or dependency installation. Every run owns a fresh HOME,
TMPDIR and synthetic DB, starts an ephemeral non-8399 daemon, refuses real
HTTP, and uses a gh stub that refuses unsupported requests. No provider,
model turn, credentials, existing database or UI is used. Evidence JSON and
synthetic request records are copied to a unique folder before the runner
immediately removes the entire temporary daemon directory. `run.json` records
free space and cleanup.

Before mode temporarily restores only `ancestry-facts.ts` from the pinned
origin/dev revision, then restores the draft in finally. Run proofs sequentially
and do not run before mode alongside tests or checks. Before must reproduce
target SQL on main; verify must record zero target SQL there. Fixture seeding,
retention assertions and the synthetic failure marker are outside measurement.
Alias SQL from other families is distinguished by its calling source frame.

Drive the real `neo.coding.smoke` WebSocket operation with synthetic independent
QA assignment and merge gate records. Five concurrent smoke requests must use
one ancestry comparison and admit the same merged head into the running build.
A known immutable comparison must be reused without upstream access, including
after daemon reopen. A known negative must refuse containment without another
comparison. Failed and partial acquisition must remain unknown; a later successful
comparison must admit the smoke. When a previously positive row is marked for
retry, failure must retain its old comparison and successful observation time
while refusing containment. Recovery must make it usable again.

In fixed mode, a held positive collector competes with a newer negative writer
observation. The negative wins, the older response returns its coverage without
advancing the revision, and the public smoke RPC must refuse containment.
A separate process then holds the synthetic WAL writer for 1.2 seconds during
another ancestry refresh. A real `system.health` RPC must finish below 250 ms,
and maximum loop lag must remain below one second. Once committed, the new
comparison must admit the corresponding public smoke request.

The fake comparison deliberately waits 300 ms and the held writer exceeds the
250 ms affected-operation target. Preserve those misses. Gateway evidence records
elapsed calls and argument/reply sizes; queue, SQL and cloning time are not
separately attributed. Other coding-family SQL in the smoke operation remains
outside this slice, so this is no claim that the entire RPC is free of main SQL.

The regression was committed before the fix. Focused unit tests cover bounded
reader/writer retries, coalescing, write rollback, later retry, retained failed
observations, immutable negatives, ordered SHA/host identity and a late positive
response. The synchronous record API is removed. Existing identity and race expectations
remain; their fixture writes now await the gateway. A regression binds a separate
writer and makes the main connection read-only to prove explicit observations
cannot bypass the gateway. `observed.json` summarizes
the four retained runtime comparisons; raw JSON is the source evidence.
