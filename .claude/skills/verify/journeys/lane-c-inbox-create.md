# Build the GitHub inbox creation command

Use proof-run.sh with lane-c-inbox-create.ts on Bun and native cached Deno
(VERIFY_PROOF_RUNTIME=deno). Shared setup checks resources, scrubs credentials,
creates fresh HOME/data and ephemeral listeners, saves evidence and removes data.
No model, GitHub access, real credentials or live daemon is used. This construction
invokes the registered writer and reads its committed receipt/count through the
isolated daemon; public GitHub event delivery remains unchanged and unverified.

Commit a failing native command reproduction before adding its registration.
Self-check cached and new SQL traps, then refuse inbox INSERT and single-ID receipt
SELECT on main. Require pass=true/mainSqlAttempts=0. Preserve caller UUID/time,
all receipt fields and nested JSON, optional/literal metadata and distinct requests.
A duplicate UUID has one concurrent winner and does not rewrite its receipt.
Corrupt receipt JSON in an AFTER INSERT trigger: decoding fails and the transaction
must roll back both insert and trigger effects. Unit contracts separately throw
on receipt lookup and pin legacy createItem(params) UUID/default-time behavior.

Hold another WAL writer for 1.2 seconds: command reply waits, health stays responsive,
and caller UUID/time survive queueing. The held command is not a sub-250-ms pass.
Reject before post and lose a committed reply: retain the error and never replay;
a later independent duplicate request fails and leaves the original row unchanged.
Record timings, payload/reply bytes, event-loop lag, RSS/WAL and SQL hashes without
raw inbox contents. Stop sockets, processors, locks and app before removing data.

Run focused repository/gateway/facade tests, the strict checker, source/diff
measurement and repository checks. The unchanged synchronous storage facade and
GitHub filter/security/event handlers are outside this construction. Their full
graph is not audited here; the separate wiring PR must prevent processEvent's
catch from inserting a fallback after an unknown-outcome write. Browser layout,
native Bun 1.4.2 if another Bun is installed, and Neo-owned deployment smoke remain
unverified by this command proof. No shared core changes beyond own append-only
operation registration and smoke line are permitted.
