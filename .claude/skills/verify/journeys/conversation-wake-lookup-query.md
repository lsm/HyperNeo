## Conversation wake lookup query

Run the actual isolated daemon with synthetic HOME/data/DB and a free non-8399
port. The helper seeds 140,000 SDK headers, 1,400 pending schedule-wake metadata rows, then zero and two
scheduled wakes. No model, credentials, live data or GUI is involved.

```bash
RUN=$(mktemp -d /private/tmp/hn-wake-query-XXXXXX)
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/wake-query.ts verify 9377 "$RUN"
```

On the regression commit, `verify` must fail the VM-work budget; `reproduce`
records the original excessive traversal without failing. Fixed code must return
exactly zero then two wakes from the real `neo.snapshot` WebSocket door and the
Bun repository. `observed.json` retains query plans, repository/RPC timings, exact
SQLite VM steps and SQLite page-cache miss/hit deltas. These counters use public
SQLite C APIs through Python's linked SQLite library in read-only mode on the
synthetic DB. Compare its reported SQLite version with Bun's reported version;
page-cache misses mean SQLite page reads, not physical disk reads. A fresh
connection does not flush the operating system cache. This is controlled query
work evidence, not proof of the cause of historical off-CPU waits. The helper
closes its socket and daemon in `finally`. Focused tests also retain empty and
populated views, scope, chronological ordering and both pagination directions.
