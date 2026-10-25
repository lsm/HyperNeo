# Explicit Neo event paths wake immediately

Use the in-process RPC setup in SKILL.md with
`PROOF=.claude/skills/verify/neo-wake-events.ts`. Preflight port 8000 only.
The helper owns the isolated daemon, disposable HOME/data directory, refusing
GitHub stub and loopback SSE model. It disables external registry MCP servers
and the SDK sandbox only for this synthetic transport proof.

Run six actual event-delivery paths against the daemon's real mailbox and SDK:
the PR sweep's wakeNeo escalation, the sendToRef PR-owner tell, an immediate
mailSessionEvent GitHub feedback delivery, an accepted human Track kickoff, a
scheduled Neo reminder, and a restart-recovery continuation.
Each must cause exactly one coordinator request immediately. The synthetic
Track notice is supplied directly to the same domain method used after the
human operation admits a notice; this does not verify GUI admission or clicks.

Keep evidence/observed.json, model request JSON files and proof.log. Before the
fix, the PR escalation and owner-tell paths already pass, while GitHub feedback
is parked. The Track unit reproduction also fails before the fix. After the
two call-site fixes, the first four paths cause one coordinator request each. No text
content is inspected to decide whether these events wake Neo.

The reminder uses the real scheduler fire and delivery code: its stored outcome
must be fired and its prompt must immediately reach the model. For recovery,
close the owned daemon, mark only its synthetic Neo session as processing after
observing consumed input and assistant work, then restart it against the same
synthetic DB. Its actual startup recovery producer must immediately cause one
model request. The pre-fix gate leaves both paths at zero turns; the fixed
structured producers bring each to one. The original four paths remain at one.

Run neo-session-track, neo-note-delivery-mode and session-event-delivery suites,
plus the ordinary neo-wake-queue journey to retain the twenty-message quiet burst.
The daemon-app-mailbox-registration tests also pin ordinary-session delivery
while Neo ownership moves out of the storage slice into the final gate.
This proves delivery behavior with synthetic event fixtures, not real GitHub
network polling, Desktop automation, model reasoning, or OS sandbox enforcement.
