# Bun daemon boot probe

Use shared isolation/resource setup in ../SKILL.md. Run the helper with the
default Bun runtime through proof-run.sh:

    bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence scripts/bun-daemon-boot-probe.ts

The helper owns a fresh source-daemon child, HOME/data/workspace and ephemeral
127.0.0.1 port (never 8399). It refuses inherited provider credentials and creates
a refusing GitHub stub; no model turn or live daemon is involved.

Commit the unavailable-probe regression before construction. After construction,
require HTTP 200, an authenticated local-credential WebSocket health response,
empty manual-session SDK status/page/live-query results and >80 migrated tables.
The live snapshot must already be present when its subscribe acknowledgement
arrives. Record snapshotBeforeAck=true only after
that assertion; do not wait for a late snapshot to turn an ordering failure into
success. Open the database read-only only for the table count; do not seed or
mutate it.

The native regression preloads tests/unit/fixtures/bun-boot-ack-order.mjs from
the daemon package into the probe process only. It holds the actual incoming
snapshot at the client socket boundary, forwards the real acknowledgement and
releases the snapshot later. That order must fail with the ordering assertion,
pass unset and the owned daemon child reaped; a normal run must still pass.
The daemon, local credential and RPC requests remain real and isolated.

Send real SIGTERM to the owned child and require code 0 plus the graceful
shutdown log, not a forced kill. Failure cleanup closes the owned socket and
stops/waits for the child; preserve child log and JSON evidence before the parent
wrapper removes synthetic data. External cancellation must not leave the child.
If a test times out waiting for readiness, forward TERM to its probe and await
the probe's close before removing data. Never SIGKILL only that parent. The
startup-wait regression uses a delayed synthetic child to prove this cleanup
without waiting for a slow machine or leaving an orphan. Test deadlines must
allow the probe's startup and child-cleanup deadlines to finish. The unit runner's
probe process has a 60-second outer cap and its test has 90 seconds, leaving time to
reap the child after cancellation. Cancellation readiness allows the same
30-second startup window as the probe; its test also allows 90 seconds.

The Bun native entry point now calls this probe first through proof-run.sh.
Its failure must retain status/evidence, suppress the runner success marker and
skip every domain case. Require the retained daemon log to contain both graceful
shutdown lines without database-close errors before crediting native success.

This proves POSIX source startup/shutdown. Native Windows signal behavior, GUI,
compiled binaries and model/provider behavior are separate contracts.
