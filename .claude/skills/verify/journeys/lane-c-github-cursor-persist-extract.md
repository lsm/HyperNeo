# Extract GitHub poll cursor persistence

Run proof-run.sh with lane-c-github-cursor-persist-extract.ts under Bun. Shared setup owns
scrubbed HOME/data, free ephemeral port, evidence and cleanup. No model or HTTP mock is
needed. Never use live daemon/8399, credentials or deployment. Refuse external HTTP/GitHub
commands. Disable webhook reconciliation and use a 60-second interval through the existing
options callback; cleanup stops the timer before it fires.

Finish startup body copy and stop processors. Seed two synthetic Spaces and
non-polling watched rows. Enable polling through the real setPollingEnabled RPC.
After public writer activation, reject target main cursor UPDATEs and require
zero main cursor writes. Check the committed JSON/time/id, check-run activation
marker/reset, preserved unrelated cursor endpoints/ETag and peer row, unchanged
creation/last-poll times and matching saved public listConfig projection. Disable
polling without rewriting the cursor. Exact helper bindings and clock/serialization
order remain pinned by focused helper tests; callback reads are outside this proof.

Scratch SQLite contains only the watched table. Pin a single existing clock read
after serialization, void result, exact changed columns and caller rollback.
Preparation precedes serialization/clock; serialization failure precedes the clock
and write, with unchanged rows. Focused tests also pin exact legacy/helper SQL,
bindings, error order, row-id isolation and missing-id void result. The clock
stays inside the extracted kernel to preserve the existing evaluation order.

Measure the complete helper plus conservative wrapper/constructor. Pin all other
repository units and public/config-store/app roots unchanged. Full transitive
consumers, UPSERT/reset policy, plugin and startup closure are outside this audit;
worker command construction and public wiring have separate measured proofs.
Save github-cursor-persist-extract.json. Close scratch DB/socket/processors/app
and restore hooks in finally, then let the wrapper remove owned temporary data.
Deployment smoke stays with Neo.
