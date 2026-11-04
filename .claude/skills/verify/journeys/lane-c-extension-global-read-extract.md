# Extract global extension configuration lookup

Use the shared isolation/resource setup in `../SKILL.md` with
`lane-c-extension-global-read-extract.ts` through `proof-run.sh` on Bun and Deno.
It owns a fresh HOME/data, ephemeral daemon, refusing GitHub/HTTP stub and
synthetic extensions that never start providers. Never use the live daemon/8399.

Characterize the real `externalEvents.extensions.list` WebSocket RPC before the
new helper is available: exact valid nested/Unicode JSON, synthetic secret
reference, missing-row defaults, nullable optional fields, canonical enable flags,
malformed/non-object JSON fallback and source isolation. The first rung remains
on main; explicitly count those main SELECTs and make no off-main claim.

Commit the failing helper-availability contract first. After verbatim extraction,
the constructor-free lookup uses the supplied scratch connection, returns those
same values and sees caller-owned uncommitted changes that roll back. The store
still rejects bad source ids before any query. Unit characterization pins the
same observable records (plus legacy noncanonical flags on its permissive fixture) independently of the store/helper shared implementation.

Measure the full new query/row/parser module and owned store read/setup units,
including the Space readers sharing the moved parser. Pin exact SQL and query
AST, row/parser bodies, unchanged validators, writers, DDL and public/framework
roots; no data exclusions or public/runtime transitive closure claim. Refresh
prior bounded config-interface pins for the smaller delegation root, not a new
audit of its transitive implementation. Keep the owned graph under 200 lines.

Retain JSON, wrapper status and public latency/RSS/WAL evidence before cleanup.
No worker fault, queue/clone timings, GUI, real provider, live deployment or full
boot/drain proof is claimed. Build the reader command and activate it only in
later gated PRs. Constructor DDL and all config reads remain on main here;
final #8714 stays open.
