# Build the Bun daemon boot probe

Use shared isolation/resource setup in ../SKILL.md. Run the helper with the
default Bun runtime through proof-run.sh:

    bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence scripts/bun-daemon-boot-probe.ts

The helper owns a fresh source-daemon child, HOME/data/workspace and ephemeral
127.0.0.1 port (never 8399). It refuses inherited provider credentials and creates
a refusing GitHub stub; no model turn or live daemon is involved.

Commit the unavailable-probe regression before construction. After construction,
require HTTP 200, an authenticated local-credential WebSocket health response,
empty manual-session SDK status/page/live-query results and >80 migrated tables.
Open the database read-only only for the table count; do not seed or mutate it.

Send real SIGTERM to the owned child and require code 0 plus the graceful
shutdown log, not a forced kill. Failure cleanup closes the owned socket and
stops/waits for the child; preserve child log and JSON evidence before the parent
wrapper removes synthetic data. External cancellation must not leave the child.
If a test times out waiting for readiness, forward TERM to its probe and await
the probe's close before removing data. Never SIGKILL only that parent. The
startup-wait regression uses a delayed synthetic child to prove this cleanup
without waiting for a slow machine or leaving an orphan. Test deadlines must
allow the probe's startup and child-cleanup deadlines to finish.

This is a construction proof on POSIX source startup/shutdown. Native Windows
signal behavior, GUI, compiled binaries and model/provider behavior are separate
contracts. The old Deno runner, CI job, and 117-helper parity manifest are unchanged;
this is not proof that all native helpers have migrated to Bun. A later PR
extracts an old probe only after this construction merges.
