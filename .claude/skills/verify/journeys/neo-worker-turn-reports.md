# Worker turn reports preserve replay protection with shared turn receipts

Use the neo-quiet-wake.md journey and the shared isolated setup in SKILL.md.
Turn reports reach Neo through the attention entry (`neo.attention.tell`): a
finished or running turn is a digest line, a turn that ends failed or needs_you,
carries a turn question, or belongs to a blocked todo wakes Neo, and a report is
dropped when an open card covers its todo or when the worker is the ask's focused
discussion. Preserve every byte of the worker's report.

A report's identity is its text for one todo: an exact repeat under a different
transport ID or time, including after a NeoService restart, adds nothing.
Changed bytes under a reused ID or a different worker add one report each. A
different todo bound to the same worker turn adds none; use
worker-turn-delivery.md for that isolated-daemon proof. Polling the same
historical turn with a changed worker status or waiting reason must not add
reports; the first observed status is durable per turn. An older turn read
together with a newer one is dropped as superseded. Only the exact final-line
blocker contract in worker-blocker-lines.md changes a todo blocker; arbitrary
prose never infers a message kind. The unit contracts also check whitespace
changes and empty text versus the literal no-reply fallback; neither is an exact
repeat.

Keep observed.json, readonly-quiet.json, overlaps.json, all model request bodies
and proof.log. The report path does not change the public UI; browser behavior
is unverified. Earlier batch-display journeys cover public worker batches.

## Replay protection

Per-todo/dispatch/turn observations persist across service recreation, so a
historical turn whose current status changes renders the same text and adds
nothing. Of several historical turns read at once, only the newest is told.
Changed bytes under a reused turn ID remain deliverable, and a delivery that
failed is told on the next read.

## Worker identification

Use worker-report-identity.md to inspect notice report identity at the real Neo
recipient input. Every report carries the existing worker name, complete
adapter-prefixed session ref, and link when supplied by the driver. Identity
metadata is taken from the current status while the report's first-observed
status and replay receipts retain their existing semantics.
