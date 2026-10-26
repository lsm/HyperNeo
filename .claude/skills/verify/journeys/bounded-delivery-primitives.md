# Staged bounded-delivery primitives preserve current message behavior

This prerequisite extracts the bounded materializer and durable delivery-job
snapshot from the Neo queue change. Current producers do not emit its batch
metadata yet. The final wake-gate slice wires that producer; this slice must
leave ordinary delivery and existing large worker reports unchanged.

Run the neo-quiet-wake journey with its shared isolated-daemon setup. Retain its
0/0/1 quiet/quiet/human result, read-only history checks and two urgent retries.
Run complete-worker-report-in-one-send-handoff-pr2 with a separate fresh run;
the real SDK MCP and CLI must retain all 8,192 report bytes and SHA-256 reads.

Run neo-batch-bounds, message-delivery.handler, job-queue-repository and
message-send-simple unit contracts. The bounded helper's synthetic batch must
produce a small complete reference, restore every byte and reuse the identical
reference after reloading the durable job. Full queue/model integration belongs
to the final Neo wake queue journey, not this behavior-neutral prerequisite.
