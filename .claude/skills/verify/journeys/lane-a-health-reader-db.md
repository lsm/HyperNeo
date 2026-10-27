# Health notifications read through the DB reader

Use resource guards and fresh isolation from SKILL.md. Run heavy jobs serially.

```sh
python3 .claude/skills/verify/lane-a-health-reader-run.py bun before
python3 .claude/skills/verify/lane-a-health-reader-run.py bun verify
python3 .claude/skills/verify/lane-a-health-reader-run.py deno verify --executable "$DENO"
```

DENO names an existing cached runtime. Each run owns a synthetic HOME/data/TMPDIR,
an ephemeral non-8399 daemon and a refusing gh. HTTP is denied. No simulator,
credentials, live daemon/data, provider or GUI is used. Before mode restores only
health-delivery.ts and pr-ledger.ts from the recorded origin/dev, then restores
the draft in finally; do not edit concurrently. Preserve and commit the failing
real-job regression before implementing the reader routing.

A persisted daemon job runs production deliverCodingHealth with a durable
incident notice and synthetic keyed receiver. Inside the job, a synthetic writer
transaction is held. The receiver must be offered that committed notice before
the lock is released. It refuses delivery, so no acknowledgement write is needed.
The baseline waits for the writer lock even though its command only reads.
A 1.2-second deadline releases the owned lock and fails the assertion; it is a
contention discriminator, not a production latency measurement.

Then recover, restart and retry the existing delivery flow. A failed acknowledgement
after receiver acceptance must leave health unchanged. Concurrent retries retain
keys/bodies, accept each notice durably once, and stop resending after acknowledgement
and restart. This preserves retry semantics and does not promise exactly-once
external notification. No transaction spans a receiver call.

Instrument health/alias SQL on main during jobs, excluding fixtures/assertions;
fixed runs require zero target SQL. Gateway mode, duration and JSON sizes are
recorded, without separate queue/clone/SQL attribution. CI also offers a durable
notice through a query-only gateway. This is a real job proof with a synthetic
receiver, not an actual Neo mailbox, consumption, full coding sweep, GUI,
whole-daemon SQL absence or general latency/RSS/WAL benchmark.

Bind final Bun/Deno runs to committed application/helper trees. After that commit,
only this journey and its evidence folder may change. Audit before push:

```sh
bun --no-install --no-env-file .claude/skills/verify/lane-a-health-reader-proof-binding.ts HEAD
```

The `bun-verify` directory is the deliberately failing pre-fix job committed
before the fix. It already had zero target SQL on main; its read was on the
writer and waited for forced lock release. The final pair in observed.json
requires read-mode lookup commands, writer-mode acknowledgements, no forced
release and the offered notice while the lock remains held. Raw receipts and
cleanup records are retained. The original delivery helper was also run in both
runtimes after updating its instrumentation; legacy-* directories retain those
successful compatibility checks. Its old binding applies only to its original PR.
