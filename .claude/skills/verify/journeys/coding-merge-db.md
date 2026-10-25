# Merge observations through the DB gateway

Use the sole existing checkout and installed dependencies. Run heavy work one
job at a time. The proof runner prints `memory_pressure` and disk space and
refuses to start below 25% free memory or 25 GiB free disk:

```sh
python3 .claude/skills/verify/coding-merge-db-run.py bun before
python3 .claude/skills/verify/coding-merge-db-run.py bun verify
python3 .claude/skills/verify/coding-merge-db-run.py deno before --executable "$DENO"
python3 .claude/skills/verify/coding-merge-db-run.py deno verify --executable "$DENO"
```

`DENO` names an existing Deno 2.9.4 executable; cached modules only are allowed.
No install occurs. Each run owns fresh HOME, TMPDIR and DB directories, an
unoccupied ephemeral non-8399 daemon, and a refusing synthetic gh. It uses no
model turn, provider, credentials, existing database, simulator or UI. Save
raw JSON and request records before the runner immediately removes the complete
temporary daemon directory. `run.json` records both resource guards and cleanup.

Before mode temporarily restores only `merge-facts.ts` and `pr-state-reader.ts`
from the pinned origin/dev revision, then restores the draft in finally. Do not
run before mode alongside tests, checks or another proof. Fixture rows and
assertions run outside measurement. Alias SQL from other families is separated
by its source frame. The baseline must reproduce target SQL on main and the
fixed run must record zero snapshot, admission, persistence and coverage SQL.

The real `neo.coding.smoke` WebSocket operation receives five concurrent cold
merge reads and must admit the synthetic independent QA evidence after one
upstream merge lookup. Covered merge facts must work when the upstream refuses,
including after app reopen. Mark successful evidence stale, fail and partially
answer the next acquisitions, and require unreadable admission while preserving
the old JSON and successful timestamp. Recovery must admit the same merged head.
A known CLOSED fact must refuse admission without another lookup.

The same daemon then exercises the actual workflow-worker MCP `task.transition`
completion gate. Known MERGED facts complete without lookup. OPEN and CLOSED
facts must refresh even while covered; a newly MERGED result can finish the
worker task. MERGED with a nullable commit may finish but each later demand must
acquire afresh. Failed and partial reads keep the task approved; recovery can
complete it. These calls catch a synchronous initial PR-state snapshot that a
merge collector-only proof would miss. No worker/model process is dispatched.

In fixed mode, hold a positive collector while a newer CLOSED observation commits
through the writer. The older result must return the winner; a later stale writer
receipt must say accepted=false and return the same authoritative coverage. The
real smoke RPC must refuse that PR. A separate process then holds the synthetic
WAL writer for 1.2 seconds during another merge refresh. Real `system.health`
must finish below 250 ms and maximum loop lag remain below one second. Once the
write commits, the corresponding smoke request must be admitted.

The synthetic merge lookup deliberately waits 300 ms, and the held writer exceeds
the 250 ms affected-operation target. Preserve those misses. Gateway evidence
records elapsed calls and argument/reply sizes; queue, SQL and cloning time are
not separately attributed. Other SQL in smoke and worker completion remains
outside this slice; this proves no whole-daemon absence of main SQL.

Two observable regressions were committed before the fix: main-instance refresh
coverage, and an explicit setter against a read-only main connection despite a
bound writer. Remove the exhausted synchronous setter, await fixture writes, and
retain the identity, revision, refusal and freshness expectations. Focused tests
also cover forced-demand coalescing, bounded retries, rollback, winning receipts
and the PR-state reader snapshot. See `observed.json` and the four raw runtime
comparisons for results and limits.
