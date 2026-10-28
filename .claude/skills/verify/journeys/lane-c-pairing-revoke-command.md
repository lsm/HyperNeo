# Build the pairing revocation writer command

Remeasure the full local call graph with lane-c-pairing-revoke-command-measure.cjs;
it must stay within 200 lines. Run lane-c-pairing-revoke-command-types.cjs with
Bun from the repository root to typecheck the focused test and its imports using
the daemon tests' strict configuration. The construction test must use the typed
repository command, so its arguments and receipt remain checked. Report the full
`bun run typecheck:tests` result separately: its existing diagnostic backlog and
missing CI coverage are tracked in https://github.com/lsm/HyperNeo/issues/4691.
The focused check is not evidence that the whole test suite typechecks.

This construction slice registers a data-only command. The public device.revoke
mutation and its connection-closing callback stay unchanged; activation must prove
those effects separately, including recovery after a lost commit receipt.

Run lane-c-pairing-revoke-command.ts with proof-run.sh using Bun, then Deno via
VERIFY_PROOF_RUNTIME=deno. The wrapper supplies disposable HOME/data, no provider
credentials, a refusing GitHub stub and ephemeral listeners. The helper refuses
external HTTP and launches only the real Bun CLI's devices reader against its
explicit owned session-door socket. No live daemon or port 8399 is used.

The committed local Bun evidence was produced with Bun 1.4.3, rather than the
repository's pinned release runtime 1.4.2. It proves that local runtime only;
native-daemon proof under Bun 1.4.2 remains unverified here. CI pins Bun 1.4.2
for its tests and for the CLI readback in the Deno smoke. The separate Deno
daemon evidence uses the pinned Deno 2.9.4. Reuse an existing pinned runtime
when available; do not install a runtime merely to relabel these results.

Commit the failing native-command proof first: the baseline rejects the missing
registered command. Deny new and cached main statements for active-device lookup
and revocation updates. First assert that the guard rejects a cached main read
and a newly prepared main update; reset the deliberate self-check counter before
command execution. Fixture and assertion reads leave measurement synchronously.
Then prove authorization, committed receipts and the real CLI reader's revoked
status. Refuse unpaired, relay, agent and revoked-human callers without changing
the target; retain the session-door exception and repeated-target refusal.

Hold another WAL writer while staging the actor's revocation. The queued command
must wait while health responds and uncommitted fixture state stays invisible;
after release, current authorization must refuse the target mutation. Force an
AFTER UPDATE trigger error and check rollback. Fail the native worker before
posting and lose a successful commit reply: reject, retain the correct persisted
state, never replay, and allow a later independent command to recover.

Record loop lag, command/health latency, worker request/reply bytes and round-trip,
RSS and WAL. Queue, SQL and clone time are not isolated. Save only flags/refusals
and numeric data, never raw codes, credentials or CLI output. Close sockets, jobs,
workers and daemon before the wrapper saves evidence and removes disposable data.
Public revocation effects, browser layout and deployment remain unverified.
