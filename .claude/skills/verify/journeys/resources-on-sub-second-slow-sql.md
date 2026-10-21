## Resources on sub-second slow SQL

```bash
RUN=$(mktemp -d /private/tmp/hn-slow-sql-resources-XXXXXX)
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/slow-sql-resources.ts "$RUN"
```

This exercises the real Bun SQLite wrapper and daemon structured diagnostic log
stream. An owned Python connection holds a writer lock on a fresh synthetic WAL
DB for 0.6 s, then a calibrated recursive SQL query does CPU work. Neither case
needs a model, network port, real database or credential. The writer is stopped
in `finally`; the synthetic DB and `observed.json` remain as evidence.

Both slow records must carry `resourceScope: event_loop_tick`, monotonic tick
boundaries, and the same resource delta available to the lag monitor. The lock
wait must show over 400 ms off-CPU; recursive SQL must show over 250 ms CPU. They
can be below the 1 s event-loop warning threshold and still get resource data.
These are whole-tick counters, including other work and idle time, not exclusive
statement costs or proof that an historical query blocked on a lock or fsync.

While diagnostics are armed, slow warnings flush at the next existing 250 ms
resource sample (or shutdown); no per-statement resource syscall is added.
Outside the monitor, warnings retain immediate delivery without tick metadata.
Unavailable resource sampling leaves counters absent rather than fabricating
zeroes. Fast queries and summary aggregation keep their existing behavior.

Verify shutdown delivery through the actual daemon and its JSONL file sink:

```bash
RUN=$(mktemp -d /private/tmp/hn-slow-sql-shutdown-XXXXXX)
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/slow-sql-shutdown.ts "$RUN"
```

The helper enables query observation on its own synthetic DB and runs a real
recursive SQLite query immediately before normal cleanup or a synthetic cleanup
failure. `observed.json` must contain exactly one persisted slow record per case,
with tick resource context. It explicitly simulates watchdog arming (normally off
in test mode) and uses a 60 s sampler cadence to keep the query pending until
shutdown. The SQL execution, app cleanup and file sink are real; this does not
verify production watchdog activation. Both sinks must still be subscribed when
cleanup stops the lag monitor, before evidence flushing and sink teardown.
