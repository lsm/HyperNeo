# Build the atomic human-device recovery writer

Use proof-run.sh with lane-c-human-reset-command.ts on Bun, then the installed
pinned Deno via VERIFY_PROOF_RUNTIME=deno. The wrapper supplies disposable HOME,
data, credentials-free environment and ephemeral listeners, then saves evidence
and removes temporary daemon data. Reuse dependencies; no live daemon, real key
file, busy port, port 8399 or external network is involved. Record actual versions:
local Bun 1.4.3 is not proof of the pinned Bun 1.4.2 native runtime. Deno is 2.9.4.

This construction registers a data-only reset command. Its input is one numeric
time; its receipt contains only reset/conversation IDs, time and cleared device
IDs/names. The public reset operation stays on its existing path until a separate
wiring PR. Do not call that mutation while target SQL is denied in this journey.

Commit a failing native proof before construction: the fresh worker rejects the
missing command, and the real device/publication state remains unchanged. Pin
the already-registered core neoPublicationWrites append contract in the unit test:
plain receipt, strict validation/refusals, idempotent publication identity, and
shared outer transaction/savepoint rollback. Record the exact stable dependency
subtree and hashes with the measurement helper. Neo authorized treating that
already-worker-owned subtree as a separately audited dependency; do not edit it.
The reset's existing direct repository append is the same implementation exposed
by that registered command. Keep reset state and its notice in one transaction.

Self-check cached/new main SQL guards for reset mutations and conversation lookup,
then deny them. Seed synthetic human devices and a relay. The native command
must return committed cleared humans; real CLI devices and public
neo.publication.read must show retained history and complete chunked notices
without secrets. Existing connection observation closes a revoked phone; the
relay remains usable. This does not prove direct reset-operation notification.

Pin old-code invalidation and one replacement consuming recovery. Fail the second
notice insert: even the first notice, recovery row, code expiry and revocation
must roll back. Also pin an append refusal rolling back reset state in the unit
contract. Hold another WAL writer while changing the active-human set: health
must respond, outside reads must see committed state only, and the command must
select the current set after acquiring the writer. Concurrent empty resets each
keep a distinct notice. Fail before post and lose a committed reply: preserve the
correct state, never replay, and allow a later independent command to recover.

Run the focused strict test checker; it does not establish that the repository's
whole test suite typechecks (the existing backlog is tracked in #4691). Remeasure
local call graph and changed production lines to at most 200. Save flags, byte/
timing metrics, RSS and WAL; do not save IDs, names, codes, credentials or CLI
output. SQL, queue and clone time are not isolated. Close all owned clients,
processors and daemon before proof-run saves evidence and removes its data.
Browser layout, public reset wiring and deployment remain unverified here.
