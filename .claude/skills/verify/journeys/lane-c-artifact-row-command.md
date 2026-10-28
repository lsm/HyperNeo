# Build immutable artifact row publication writer

Run proof-run.sh with lane-c-artifact-row-command.ts on Bun and native cached
Deno (VERIFY_PROOF_RUNTIME=deno). Shared setup checks resources, scrubs credentials,
owns fresh HOME/data and ephemeral listeners, retains evidence and removes data.
No provider turn, capture, GitHub, real credentials or live daemon/8399 is used.

Commit failing registered-writer and native gateway reproductions first. The new
command takes only the existing save arguments: caller context, IDs, fingerprint,
hash, reference, producer, source path and optional revision/bundle/logical ID.
The worker uses the unchanged legacy save and its clock; validate every retained
binding and exact canonical receipt within that transaction. Return the saved
reference, receipt bytes and stored timestamp only after the worker commits.

Both native runtimes must pass cached/new main SQL guard self-checks, then execute
zero targeted INSERT/receipt-SELECT statements on main during command calls.
Compare the committed result through the real artifact.file.get RPC. That existing
reader still runs on main and is outside the command SQL measurement. Public
capture/publication callers are unchanged; activation follows separately.

Two concurrent same-request candidates retain only one immutable row; duplicates
reject without overwrite. Hold a competing WAL writer for 1.2 seconds: the receipt
waits, health stays responsive. Admission rejection leaves no row. Losing an actual
committed reply rejects with unknown outcome and never automatically replays;
an explicitly repeated insert still rejects. Invalid producer JSON and missing exact
receipt roll back publication/trigger effects. Unit tests additionally inject lookup
errors and mismatched receipt/fingerprint/producer rows and check full rollback.

Measure the complete local command/save/receipt/constructor/read graph to <=200;
record unchanged dependency hashes and honest limits. No filesystem, callback or
network value crosses admission. The worker's operation shell owns the transaction.
Record request/reply sizes, timing, event-loop lag, RSS/WAL. The deliberate lock
wait is not a sub-250-ms latency pass. Native Bun 1.4.2 when unavailable, capture
bytes/ownership closure, browser and Neo deployment remain unverified. Close owned
sockets, locks, processors and app before the wrapper removes temporary data.
