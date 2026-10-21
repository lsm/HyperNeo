## SQLite worker closure and opt-in native stall capture

On macOS with Xcode command-line tools, use a fresh owned absolute directory:

```bash
RUN=$(mktemp -d /private/tmp/hn-sqlite-close-XXXXXX)
bash .claude/skills/verify/sqlite-worker-close.sh verify 9384 "$RUN"
RUN=$(mktemp -d /private/tmp/hn-sqlite-sample-XXXXXX)
HYPERNEO_NATIVE_LAG_PROFILE=1 \
  bash .claude/skills/verify/sqlite-worker-close.sh sample 9384 "$RUN"
```

The shell compiles a native interposer inside that run directory and launches an
isolated daemon with a blank environment, its own HOME/data/DB and port. It delays
only an explicit WAL checkpoint on the helper's synthetic worker database by
1,800 ms. A retained prepared statement and worker termination expose Bun's
process-wide database-registry mutex: an independent WebSocket client requests a
new statement on the daemon's different database while that checkpoint runs.
No real settings, DB, provider, credentials or daemon are used.

`reproduce` on the regression commit records about 1,817 ms heartbeat lag and
1,816 ms RPC latency. Fixed `verify` requires the retained statement to be closed,
no termination checkpoint, unchanged results (219 and 7966), and heartbeat lag,
query and RPC each below 250 ms. The measured fixed values were 1.01 ms lag,
0.027 ms query and 0.77 ms RPC. This is a controlled native hazard reproduction,
not attribution of the historical off-CPU gaps or proof every stall is fixed.

`sample` deliberately uses upstream Bun's default close for its synthetic worker
to keep the old hazard reproducible without changing production code. It starts
the real watchdog explicitly (test daemons normally skip it). A timestamped
`stack.native-*.txt` must be triggered before the blocked RPC recovers and contain
a native Call graph; inspect both the blocked main thread and checkpoint worker.
The helper awaits the one-second sampler and stops its clients, worker, watchdog
and daemon. Output includes the exact trigger/recovery times and maximum lag.

For an authorized deployment, `HYPERNEO_NATIVE_LAG_PROFILE=1` enables the same
Darwin-only capture on the existing watchdog worker: a 100 ms heartbeat/check,
a one-second native sample after a heartbeat is at least 1 s late, once per
unrecovered episode and only one sampler in flight. Files extend the configured
watchdog stack path with the trigger timestamp. Default is off; the existing
60 s stall action, startup arming, suspension handling and shutdown fuse are
unchanged. Capture begins during the block, rather than from the recovered
main-thread slow-tick callback. Native stacks are local diagnostic artifacts;
do not enable the flag on a real daemon without the coordinator's authorization.

Focused `sqlite-worker-close.test.ts` invokes real Bun children to check retained
statement invalidation, an actual FTS merge's post-close receipt and unchanged
search results, and opt-in/off native capture without a stall action at 2 s.
`sqlite.worker.lifecycle` carries merge/close durations, opened/closed wall times
and parent receipt time, with no DB path or content. Those lifecycle spans and a
checkpoint stack support correlation; whole-tick counters remain tick-scoped.
