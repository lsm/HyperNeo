# Worker turn reports preserve replay protection with shared turn receipts

Use the neo-quiet-wake.md journey and the shared isolated setup in SKILL.md.
The report cases run through the real Codex adapter, todo runner, NeoService,
DB writer, mailbox, SDK and loopback model. First reports must reach the model
even with notify:false or focused-discussion metadata. Preserve the focused
status-only authority warning and every byte of the worker's report.

Check an exact repeat under a different transport ID/time, including after a
NeoService restart, adds no request. Changed bytes under a reused ID or a
different worker add one request each. A different todo bound to the same worker
turn adds no request, even if its first observation has a different live status;
use worker-turn-delivery.md for that isolated-daemon proof.
Polling the same historical turn with a changed worker status, waiting reason or
focus must not add requests; the first observed status is durable per turn. A new
transport turn can carry a new status, with exact todo/status payload repeats
suppressed. Do not infer kinds from report text. The unit contracts also check
whitespace changes and empty
text versus the literal no-reply fallback; neither is an exact repeat.

Keep observed.json, readonly-quiet.json, overlaps.json, all model request bodies
and proof.log. The report path does not change the public UI; browser behavior
is unverified. Earlier batch-display journeys cover public worker batches.

## Upgrade replay regression

The helper seeds 20 historical turn ends before the first-run cutoff, then
changes their current status. Neither step adds a model request. The one-time
cutoff and per-todo/dispatch/turn observations persist across service recreation;
this intentionally baselines pre-cutoff reports already replayed during #8776.
It never parses report text. A report ending after the cutoff must still reach
the model, including when first observed after a service restart. Changed bytes
under a reused turn ID remain deliverable; failed admission must remain retryable.
Preserve the red-run and fixed-run observed.json and model request bodies.
