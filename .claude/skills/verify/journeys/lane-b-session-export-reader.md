# Session exports read a complete snapshot off main

Run `lane-b-session-export-reader.ts` through `proof-run.sh`, then repeat with
`VERIFY_PROOF_RUNTIME=deno` and the cached Deno runtime on PATH. This owns a fresh
synthetic daemon on an ephemeral non-8399 port, with disposable HOME/data and
external HTTP refused. No provider turn, credentials or model mock is needed.

Seed consumed, failed and pending user inputs, a full ordinary reply over 16 KiB,
a parent/child tool exchange, hidden metadata, an ordinary result and another
session through production writers. Capture the existing unprojected repository
output before measurement, serialized through JSON as on the wire. Actual JSON
export RPCs must match it completely;
default and explicit Markdown must match each other and include the full ordinary
text. Preserve scoping, empty exports and ordinary/conversation not-found errors.

Deny all target session/message SQL on the main connection, including cached
statements. Cold and concurrent exports must pass while a separate WAL writer's
uncommitted counter remains visible only to that writer. A later committed reply
must appear on the next export. An injected reader failure must reject the RPC,
leave health usable and allow a later read to recover without actor restoration.
Verify the original stored message hash is unchanged and the actor cache stays
empty. The baseline must fail on main SQL; commit that proof before the fix.

Unit contracts also cover the implicit store, the nonwaiting preparation gate,
the existing 10,000-message selection limit, exact Markdown and cached runtime
session metadata. Export continues to use the existing formatter and full message
selection; this does not introduce a new bounded summary or pagination contract.

Retain hashes, complete-response comparison results, latency, loop lag, RSS, WAL
size and combined worker round-trip/reply encoding measurements. This does not
separate SQL, queue and cloning costs. Startup migration is settled before target
SQL is measured; its remaining main reads are outside this slice. Close owned
resources and save JSON before removing temporary daemon data. Deployment/UI
smoke stays pending with Neo. The 10,000-message selection boundary is unit-tested;
large exports and oversized transport latency are not established by this fixture.
