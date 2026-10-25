# Query observations through the DB gateway

Run in the existing checkout with installed dependencies. The runner prints
free data-volume space and refuses to run below 25 GiB:

```sh
python3 .claude/skills/verify/coding-query-db-run.py bun before
python3 .claude/skills/verify/coding-query-db-run.py bun verify
python3 .claude/skills/verify/coding-query-db-run.py deno before --executable "$DENO"
python3 .claude/skills/verify/coding-query-db-run.py deno verify --executable "$DENO"
```

`DENO` names an existing Deno 2.9.4 executable; Deno uses cached modules only.
No runtime or dependency installation occurs. Every invocation creates its own
synthetic HOME, TMPDIR and DB, starts an ephemeral non-8399 daemon, refuses real
HTTP, and uses a gh stub that refuses unsupported requests. It uses no model,
provider, credentials, existing database, UI or real GitHub request. Save the
raw JSON and request records before the runner immediately removes the entire
temporary daemon directory. `run.json` records available space and cleanup.

Before mode temporarily restores only `query-facts.ts` from the pinned
origin/dev revision, then restores the draft in finally. Do not run before
mode concurrently with checks, tests or another proof. Both runtimes must
reproduce query SQL on main before migration and record zero afterward.
Fixture row assertions are outside measurement; alias SQL in other fact
families is distinguished by its calling source frame.

The real `neo.github.read` WebSocket operation receives five concurrent bounded
queries. They must share one upstream acquisition and identical sorted,
truncated results. Changed data must refresh; failed and malformed acquisition
must return unreadable while retaining the previous JSON and observation time.
Daemon reopen must retain the data, then recover to a successful empty view.

Next, five staggered relative-window RPCs must share one acquisition and the
actual winning interval. Three subsequent settled reads must acquire afresh
with advancing lower bounds. Stored rows remain one explicit query plus one
rolling-window query. This catches accidental reuse of an old interval from
the coverage read and per-call row growth.

In fixed mode, a collector waits while a newer interval and value commit through
the real writer. The old response must return the winner without advancing its
revision. A separate process then holds the synthetic WAL writer lock for 1.2
seconds while a real `system.health` RPC runs. Health must finish under 250 ms
and main-loop lag below one second. The intentionally delayed 300 ms upstream
and held writer miss the 250 ms affected-operation target; retain those misses.
Gateway evidence includes elapsed calls and serialized argument/reply sizes;
it does not separately attribute worker queue, SQL or cloning time.

The failing regression commit precedes the fix. Focused unit cases also cover
case/alias coverage, all query dimensions, changed and failed views, bounded
busy retries, rollback on rejected persistence, one-winner admission and rolling
interval fencing. The existing ledger tests are unchanged. See `observed.json`
and each run's raw evidence for measurements and limits.
