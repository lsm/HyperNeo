# Polling usage read command construction

Use shared setup in `../SKILL.md`. Run `proof-run.sh` with
`lane-c-github-polling-usage-read.ts` under Bun. The isolated daemon owns a fresh
synthetic HOME/database, refusing GitHub/HTTP stubs, authenticated WebSocket and ephemeral
port. Stop processors and finish startup body copy before seeding target rows. Never use
live data, credentials or port 8399.

Invoke the two registered typed read operations through the daemon gateway.
Trap target SELECTs on main only while invoking those commands; fail on any
fallback. Capability usage must short-circuit configured rows, then joined Space
intent, then the supplied session scope, preserving cursor and schema failures.
Timer usage checks active rows globally, including orphans. Results transfer only
booleans. Pure stage tests pin every early-exit arm and query precedence.

Check a real public listConfig readback separately, with the main trap disabled:
capability callback activation has its own #9649 journey, and timer activation
is still separate. This construction proof makes neither activation claim.
Verify query-only no-write/no-notification behavior, fresh reads after commits,
health/read response while a competing writer holds its transaction, native
deferred-snapshot consistency and reader failure without main fallback. A failed
reader may be read again explicitly; it must never replay a write.

Measure with `lane-c-github-polling-usage-measure.cjs`: the complete 47-line command,
53-line query and 44-line mapper total 144, or 152 with the shared registrations,
with no exclusions. Only append registrations to the shared op/smoke
lists; no gateway, app, service or lifecycle changes. Keep named direct pipelines
and all timers/resources in the owning shell. Record latency, clone bytes, RSS,
WAL and maximum loop lag; separate queue/SQL/clone timings remain unexposed.
Retain `github-polling-usage-read.json` before shared cleanup. No full public
transitive audit, GUI, real GitHub or deployment claim; #9438/#8714 remain open.
