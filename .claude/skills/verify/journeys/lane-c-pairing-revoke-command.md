# Build the pairing revocation writer command

This construction slice registers a data-only command. The public device.revoke
mutation and its connection-closing callback stay unchanged; activation must prove
those effects separately, including recovery after a lost commit receipt.

Run lane-c-pairing-revoke-command.ts with proof-run.sh using Bun, then Deno via
VERIFY_PROOF_RUNTIME=deno. The wrapper supplies disposable HOME/data, no provider
credentials, a refusing GitHub stub and ephemeral listeners. The helper refuses
external HTTP and launches only the real Bun CLI's devices reader against its
explicit owned session-door socket. No live daemon or port 8399 is used.

Commit the failing native-command proof first: the baseline rejects the missing
registered command. Deny new and cached main statements for active-device lookup
and revocation updates. Fixture and assertion reads leave measurement synchronously.
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
