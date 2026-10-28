# Activate pairing revocation on the writer

Run lane-c-pairing-revoke-activation.ts via proof-run.sh with Bun and then Deno.
Use separate evidence folders and the existing pinned Deno executable. The wrapper
supplies fresh HOME/data and removes all temporary daemon data after saving JSON.
No credentials, provider request, live daemon, busy listener or port 8399 is used.
Record actual runtime versions; local Bun 1.4.3 is a deviation from the repository's
pinned 1.4.2 and does not establish pinned native-daemon coverage.

Commit the failing real WebSocket regression before the fix. Self-check the guard
against cached reads and new updates, then deny active-device and revocation SQL
on the main connection. Fixture inspection leaves measurement synchronously.
Use real paired WebSocket clients and the real Bun CLI on the isolated session
socket. Revocation must commit, appear in the CLI devices reader, and close the
target connection. Unpaired/stale actors, missing targets, rollback and pre-post
failure retain their receipts and do not close an active target. Hold a competing
writer while revoking the actor: queued admission must recheck current authority
while health remains responsive and uncommitted state stays invisible.

Lose a successful writer reply and reject the first two read-worker admissions.
The original mutation must reject as unknown while read-only retries recover the
authoritative inactive state and close the target exactly once. Assert one write,
not a replay. A later independent request must recover. During a final lost reply,
keep read admission unavailable and close the real daemon: its gateway close signal
must stop retries without notifying an unconfirmed target. The last RPC must
reject; an undeliverable response after its connection closes is expected in this
shutdown case. Database-close errors or continued retries are failures. Preserve the existing
upgrade-lookup fence through its focused tests. Callbacks and lifecycle signals
stay on main; native requests contain only scalar identity data.

Remeasure the full local graph with the activation measurement helper; keep it
within 200 lines. Run the focused strict test checker and focused pairing suite.
Shared gateway changes are limited to Neo's authorized closing controller, signal
getter and abort at close entry. Record request/reply bytes, worker round trips,
RPC/health latency, loop lag and RSS; queue, SQL and clone time are not isolated.
Save flags and numeric data only, never raw codes, credentials or CLI output.
Public browser layout and deployment remain outside this proof.

Use --persistent-read-outage to reproduce the review finding. Keep the read lane
unavailable for one second after losing a committed writer reply. Record caller
settlement, reader admissions and actual victim connection state. Restore the
reader and require eventual closure with exactly one write admission. This pins
both a finite foreground recovery budget and the revocation fence; a cap that
simply drops recovery must not strand the revoked connection.
