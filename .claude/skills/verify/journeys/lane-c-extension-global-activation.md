# Activate global extension configuration writes

Use proof-run.sh with lane-c-extension-global-activation.ts on Bun and cached
Deno (VERIFY_PROOF_RUNTIME=deno). Shared setup owns a fresh HOME/data, ephemeral
listener, scrubbed credentials, saved evidence and immediate data cleanup. No
provider, HTTP mock, GitHub, real credential or live daemon/8399 is used.

Commit the failing native public-RPC proof first. Self-check cached/new main
UPSERT guards, then deny all main INSERT INTO external_event_extension_configs
executions. The existing public enable RPC must initially fail at that guard.
After wiring only the global setter to the merged command, enable/disable/list
must preserve exact JSON, synthetic secret reference, creation time, callbacks
and lifecycle status. Callbacks run main-side only after successful admission.

Concurrent enables coalesce to one start. A synthetic start failure compensates
its known committed enable with the previous config; a post-statement SQL error
rolls back without running the callback. A held WAL writer keeps enable pending
and the prior stopped config visible while health stays responsive. On release,
commit and callback precede success, retaining the caller's captured timestamp.
The intentional 1.2-second lock does not meet the 250 ms write-latency target.

Before-post refusal must not write, start or replay. Drop an actual committed
worker reply: the public request rejects, list shows its authoritative committed
enabled config but stopped lifecycle, no start/compensating write is attempted,
and later reads never replay it. This proof does not claim mixed enable/disable
concurrency repair or lifecycle recovery after an unknown receipt.

Pin the full 49-line merged command/helper hashes and contracts, unchanged
validation/clock/read/table helpers and lifecycle/RPC/caller roots. Their dynamic
plugin/transitive framework/startup closure is outside this owned wiring audit.
Reads, Space setter and constructor DDL remain separate. Update the earlier
extraction proof to require zero public main UPSERTs while retaining its direct
scratch-helper rollback contracts. Evidence: extension-global-activation.json.
Close owned socket, lock, processors and app before cleanup. Deployment is Neo-owned.
