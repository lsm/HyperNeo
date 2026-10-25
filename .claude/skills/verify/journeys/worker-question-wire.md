# Worker blockers immediately open a card and wake Neo once

Use SKILL.md's shared in-process setup with
`PROOF=.claude/skills/verify/worker-question-wire.ts`. Preflight port 8000 only.
The helper owns its daemon, fresh HOME/data/DB, refusing GitHub stub and local
Anthropic SSE model. External MCP servers are disabled. The SDK sandbox is
disabled only in this synthetic transport fixture; this is not an OS sandbox proof.

Send through the bound worker session door's message.send RPC; read the card
through actual WebSocket RPC:

```json
{"name":"message.send","input":{"to":"<neo>","kind":"blocked","text":"Original report","question":{"todoId":"<assigned todo>","title":"Choose a destination","options":["Staging","Production"],"language":"en"}}}
```

The session door binds the worker caller and strips any supplied `from` field.
Operation tests also reject a foreign worker. Workers cannot choose a claimed
source identity in the question payload. The bound door is necessary for large
reports, since publishing a full outbox report requires the calling session.

Before returning, the send must persist one existing-system card with source
attribution, original report and a needs-human hold. Eight changed-text repeats
reuse its durable receipt. Process that wake through the real mailbox/SDK and
observe exactly one Neo request to the loopback model. Repeat using kind question,
then stop/restart only the fixture daemon against its synthetic DB and repeat
again: no second wake or model request may occur. The runner must send neither
a worker reminder nor a reminder escalation for that held todo. The fixture
worker has a stay-quiet instruction; blockers still pass the operation door.

Repeat in a second fresh run, adding `old` after the helper's run-directory
argument. It seeds an older open card before the first worker report and must
still give exactly one reused card and one Neo model turn. Operation contracts
additionally cover wake-write rollback, malformed reports, repeated ambiguous
reports and a hold arriving during the nudge's async status lookup.

An optional third fresh run uses `triage` instead of `old`: a large report with
no card payload is published in full and wakes Neo once for triage. Its repeats
publish fresh references with the same hash but reuse the original receipt and
never add another wake. This run has two model turns total, one for the todo card
and one for the separate ambiguous incident; restart adds none.

Use `media` in another fresh run for envelope-form image-only reports. Two valid
PNG reports must retain their image blocks, receive different incident receipts,
and produce two separate Neo turns; repeating an image reuses its receipt.
Together with the initial card, this run has three turns. The initial handled
card report must also retain its original conversation record before returning.

The `recover` and `expired` modes mark the first undelivered job dead or run the
actual mailbox expiry sweep at a synthetic 25-hour boundary before processing it.
A repeat must create a replacement admission, keep the same card/hold, and
deliver exactly one Neo turn. The fixture then cleans completed jobs and restarts:
the consumed SDK input must still prevent redelivery. Operation contracts also
cover repeated failures, dead-job cleanup before recovery, and cardless triage.

Keep evidence/observed.json, the model request files, cleanup.json and the proof
log. This proves RPC, durable queue, SDK wake and synthetic runner behavior.
GUI rendering, real-worker language compliance, answer delivery and hold release
are outside this journey; delivery/resume belongs to #8732 (slice 3).
