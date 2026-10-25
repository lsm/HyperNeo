# Worker turn reports deliver once per exact todo/status payload

Use the neo-quiet-wake.md journey and the shared isolated setup in SKILL.md.
The report cases run through the real Codex adapter, todo runner, NeoService,
DB writer, mailbox, SDK and loopback model. First reports must reach the model
even with notify:false or focused-discussion metadata. Preserve the focused
status-only authority warning and every byte of the worker's report.

Check an exact repeat under a different transport ID/time, including after a
NeoService restart, adds no request. A changed reason under a reused ID,
changed status, or a different todo adds one request each. Do not infer kinds
from report text. The unit contracts also check whitespace changes and empty
text versus the literal no-reply fallback; neither is an exact repeat.

Keep observed.json, readonly-quiet.json, overlaps.json, all model request bodies
and proof.log. The report path does not change the public UI; browser behavior
is unverified. Earlier batch-display journeys cover public worker batches.
