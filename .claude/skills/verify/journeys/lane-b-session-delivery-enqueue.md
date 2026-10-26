# Session delivery enqueue on the writer

Run `lane-b-session-delivery-enqueue.ts` with Bun and Deno in a fresh synthetic
run under env -i, NODE_ENV=test, HOME=<run>/home and HYPERNEO_DATA_DIR=<run>/data.
No credentials, provider/model turn, HTTP mock, UI or live daemon is involved.
The helper uses an ephemeral non-8399 port. It records processors created only
by its own daemon, restores the temporary start observer, then stops and awaits
all owned processors before seeding input. No delivery can start a provider turn.

Seed an unloaded manual session and an orphaned enqueued SDK input through the
database facade. The real session.get RPC must load the session and recover that
input into a delivery job. Then publish a real message.persisted event for a
second synthetic input, exercising the existing AgentSession event subscriber.
Public message.status must remain queued for both, with committed recovery/chat
receipts retaining their payload fields and retry budget. A main-connection guard
rejects every job INSERT throughout these operations. The baseline must fail;
fixed Bun/Deno runs must show zero target main writes and both pending receipts.

A fixture SQL trigger rejects a third input inside the actual writer transaction.
Its public status must become failed with no delivery job. Command failures are
tagged inside the operation body and cross the gateway only after the transaction
unwinds; commit, transport and worker failures remain untagged. Unit coverage
rejects a receipt read after insertion and verifies rollback. A separately
committed receipt-loss regression commits the real job, then rejects the reply:
the input must remain enqueued with its receipt intact, without guessed failure
publication or replay. This does not establish real worker-death recovery.

Save evidence/session-delivery-enqueue.json before removing owned temporary data.
The helper restores its observer/SQL guard and closes resources in finally. It
does not prove provider execution, restart recovery's separate resend callback,
contention, worker death or large-body latency. That core-owned callback receives
only its explicitly authorized companion await in this slice.
