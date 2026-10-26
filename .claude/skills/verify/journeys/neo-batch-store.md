# Durable batch store survives a daemon writer round trip

Use the in-process RPC setup in SKILL.md with
`PROOF=.claude/skills/verify/neo-batch-store.ts`. No HTTP model mock is used, so
omit the 8000/8001 preflight loop and the proxy flag. The helper owns its ephemeral
daemon, synthetic HOME/data and refusing GitHub stub. No provider is registered.

Pause only this daemon's job processor, open Neo through RPC, and submit twenty
synthetic notes through the actual DB-writer operation. Enqueue and claim one
trigger through the real mailbox primitives. Supply the storage primitive's
explicit wake decision; classification belongs to the final gate slice.

First prepare and leave one synthetic mailbox job processing, then queue a
later note and flush the timer. Its batch must contain the later note without
copying the already admitted report. Submit another parked note and run the
full delivery teardown through the DB writer, with failEnqueued and failDeferred
enabled so already materialized SDK deliveries are cancelled too. The cancelled results must
include that note, and a later timer flush must create no mailbox job. Keep
evidence/review-cases.json; all three fields must be true. The old store makes
all three false. This deliberately exercises the storage API's explicit wake
decision, not the final gate's classification.

Observe an unchanged original report, all twenty notes in order in a separately
persisted SDK input, an intact job claim, and an identical retry snapshot. The
timer creates one SDK delivery directly, without a placeholder mailbox event.
Close the owned daemon and reopen its DB read-only to verify that the snapshot
and independent batch delivery persisted.
Keep evidence/observed.json and proof.log. Also run the queue-store, mailbox,
outbox and prompt-comparison unit contracts.

This verifies the store through the real isolated daemon's writer and SQLite
storage, not a model turn, wake classification or GUI behavior. Automatic wake
and UI behavior are covered by neo-automatic-worker-batch.md.
