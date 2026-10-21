## Worktree project resolution responsiveness

Use an owned fresh run directory; the helper requires its own HOME/data and port.

```bash
RUN=$(mktemp -d /private/tmp/hn-worktree-resolution-XXXXXX)
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/worktree-resolution-lag.ts verify 9383 "$RUN"
```

The actual `work.find` RPC runs the real Codex adapter against a synthetic Codex
SQLite state and mirrors the resulting project into the isolated daemon database.
Its sole worktree has a `.git` FIFO: an independent Python writer waits until a
reader opens it, then releases a valid pointer after 1.4 seconds. An external
WebSocket client probes `system.health` while the read is pending. The returned
project must be the main repository, and the thread keeps its worktree location.
`observed.json` records response time, maximum main-loop lag and health latency.
The failing `reproduce` journey reports about 1,405 ms loop lag and 1,406 ms health
latency. After async resolution, the same journey reports about 1.7 ms lag and
0.56 ms health latency, while discovery still awaits the full storage delay.
All helper-owned clients, writer and daemon stop in `finally`. No real Codex
store, `.git` pointer, credentials, provider, GUI or port 8399 is used.

The focused `worktree-resolution.test.ts` also checks that concurrent and repeated
lookups of an unchanged regular pointer perform only one content read. Changed
metadata, a missing pointer, read errors and replacement must refresh/recover.
Phase tests cover Codex SQLite open/configure/query/close,
worktree resolution, grouping and each adapter's async success/failure boundary.
Async worktree and adapter spans include awaits and are not exclusive main-thread
blocking time. The synthetic reproduction proves a concrete blocking hazard;
it does not attribute the historical 02:23:43 eight-second gap.
