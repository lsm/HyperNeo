# Construct the global extension configuration reader

Use shared isolation/resource setup in `../SKILL.md` with
`lane-c-extension-global-reader-command.ts` through `proof-run.sh` under Bun and
Deno. It owns a synthetic daemon, ephemeral listener, refusing GitHub/HTTP stub,
canonical config rows and extensions that never start providers. Never use the
live daemon/8399, real credentials or a model turn.

First characterize the real extension-list RPC. The baseline then posts the
new read operation to the actual worker and fails as unregistered. Commit that
failure before constructing and registering the command. Its only argument is
source data; it returns the complete cloneable configuration using the merged
lookup and JSON modules. Self-check cached/new main SELECT traps and reject
that SQL throughout direct reader jobs. Public list/write/health comparisons run
with that trap disabled: the public getter is intentionally not wired here.

Read valid nested/Unicode data, synthetic secret references, missing defaults,
malformed/non-object JSON and independent sources. With a competing uncommitted
WAL writer, read the prior committed snapshot while health responds. Hold an
actual reader reply, disable the source through the real public global RPC, then
release: the held result retains its own snapshot and a new read sees the commit.
Refuse admission and lose an actual completed read reply. Both errors propagate
without main fallback or automatic retry; a later independent read recovers.

Count the complete new command and unchanged query/JSON modules plus the two
append-only registry lines and one smoke line; no data exclusions or shared/core
change beyond those registrations. Pin their full hashes and the untouched
public getter/caller/framework roots, without claiming full transitive closure.
Construction does not activate the public getter or move constructor DDL.

Keep evidence JSON, wrapper status, round-trip/clone bytes, loop/health/RSS/WAL
metrics before cleanup. Internal queue/SQL timing is unexposed. Worker failures
are synthetic error events, not OS kills; cancellation, GUI, live deployment and
full startup/shutdown ownership are unverified. Public getter wiring follows
only after this PR merges. Final #8714 remains incomplete.
