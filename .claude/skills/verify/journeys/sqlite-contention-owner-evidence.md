## SQLite contention owner and transaction phases

```bash
RUN=$(mktemp -d /private/tmp/hn-sqlite-contention-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" HYPERNEO_SQL_QUERY_OBSERVABILITY=1 \
  bun .claude/skills/verify/sqlite-contention.ts "$RUN"
```

This is the isolated DB option: no daemon, HTTP port, model, credentials, real
settings or real database is used. The helper starts the actual gateway worker
through a test-only registry fixture. That fixture writes a fabricated row, then
holds its immediate write transaction for 650 ms. A shared-memory signal proves
the writer acquired its transaction before main attempts its own write.

`observed.json` must name `test.holdWriter`, its gateway request ID, connection /
transaction identity, original worker timestamp, and BEGIN acquired, body and
COMMIT phase wall times and elapsed durations. Main's BEGIN waits at least
200 ms; the holder's body spans at least 600 ms. A deliberate 120 ms main-thread
pause after the waiter commits proves forwarded receipt time differs from the
worker's original time. The two successful writes retain their exact results.

A second synthetic hold uses a 10 ms busy timeout on this test connection only,
to observe failed BEGIN attempts and the unchanged 25/50 ms default retry sleeps.
The final outcome must be exhausted, with the failed transaction's phase/ID.
The rejected write creates no row. Production busy_timeout, retry policy,
durability, SQL and connection lifetime are unchanged.

Then actual merge and mirror workers contend with another synthetic writer.
Both must forward slow SQL with original time and request identity, and retain
`merged` / `false` results. Five rows remain. `events.jsonl` is the real structured
log stream; the helper closes all owned connections and workers in finally.
The unit contract invokes the same real Bun proof under CI's Node/Vitest runner.

Interpretation: phases measure native transaction boundaries, not an internal
SQLite busy-handler counter. `begin/acquired` on an immediate outer transaction
is writer acquisition; deferred BEGIN alone does not prove a write lock.
Nested boundaries are labelled savepoints. Body exceptions use a rollback tail;
a failed COMMIT tail includes native error cleanup. Error phase outcomes describe
the transaction's error, not independent proof that cleanup failed. Phases are
emitted on slow transaction completion, so they cannot identify a currently hung
writer until it reports. A successful long BEGIN or COMMIT is elapsed wait/work,
not proof of lock versus fsync. Historical stalls remain unattributed unless
positive owner evidence correlates on the same database and wall interval.
No DB path, bound values or SQL error message is added to diagnostic metadata.

The proof correlates the known holder's body interval with the waiter's BEGIN
interval, and requires that body to finish before the waiter enters its body.
It imposes no ordering tolerance on the worker's post-COMMIT stamp: a replay
control delays only that observed stamp by one second and still correlates,
while a disjoint holder interval is rejected. These are replay controls, not a
claim that the real worker was descheduled. Interval and close summaries must
retain worker provenance but carry no single operation or request identity.

Before opening any synthetic DB, the helper builds both actual worker modules
with a loader that rejects application-config or credential-discovery imports.
The old worker config import fails this check before any credential code can run.
The passing graph contains neither; parent code resolves observability options
and includes them in each worker request. The subsequent real worker runs still
verify forwarded slow SQL, proving that configuration forwarding retained the
requested instrumentation. No human-login mode or real credentials are used.
