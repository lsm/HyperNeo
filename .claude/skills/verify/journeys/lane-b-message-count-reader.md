# Transcript counts use one reader snapshot

Run `lane-b-message-count-reader.ts` through `proof-run.sh` in a fresh synthetic
source daemon, then repeat with `VERIFY_PROOF_RUNTIME=deno`. No provider, model,
credential, GUI or external HTTP is involved; the helper owns an ephemeral port.

Seed consumed and enqueued inputs, a top-level reply, a child reply, hidden system
metadata and a result through production writers. The actual `message.count`
WebSocket RPC must return the existing top-level count, including its current
result and delivery-status rules. Empty sessions and absent conversations return
zero; missing ordinary sessions retain their error. Another session stays scoped.

Deny cached and new session/message SQL on the main connection. Cold and concurrent
warm reads must succeed while a separate connection holds a WAL write transaction,
with its uncommitted counter still invisible outside that transaction. Later
committed messages must change the next count. Inject a reader failure: the affected
RPC rejects, health stays usable and the next request recovers without an actor or
main fallback. The baseline must fail on main SQL before changing production code.

The helper waits for startup body-copy and message-column migration before measuring.
Unit coverage also pins the existing nonwaiting migration gate and the explicit-store
requirement for conversation fallback. Record latency, loop lag, RSS, WAL size and
combined worker round-trip/encoding measurements. Queue, SQL and cloning costs are
not individually isolated. Save the evidence before removing owned daemon data.
This source proof leaves deployed-build and UI verification pending with Neo.
