# Explicit Neo event paths wake immediately

Use the in-process RPC setup in SKILL.md with
`PROOF=.claude/skills/verify/neo-wake-events.ts`. Preflight port 8000 only.
The helper owns the isolated daemon, disposable HOME/data directory, refusing
GitHub stub and loopback SSE model. It disables external registry MCP servers
and the SDK sandbox only for this synthetic transport proof.

Run four actual event-delivery paths against the daemon's real mailbox and SDK:
the PR sweep's wakeNeo escalation, the sendToRef PR-owner tell, an immediate
mailSessionEvent GitHub feedback delivery, and an accepted human Track kickoff.
Each must cause exactly one coordinator request immediately. The synthetic
Track notice is supplied directly to the same domain method used after the
human operation admits a notice; this does not verify GUI admission or clicks.

Keep evidence/observed.json, model request JSON files and proof.log. Before the
fix, the PR escalation and owner-tell paths already pass, while GitHub feedback
is parked. The Track unit reproduction also fails before the fix. After the
two call-site fixes, all four paths cause one coordinator request each. No text
content is inspected to decide whether these events wake Neo.

Run neo-session-track, neo-note-delivery-mode and session-event-delivery suites,
plus the ordinary neo-wake-queue journey to retain the twenty-message quiet burst.
This proves delivery behavior with synthetic event fixtures, not real GitHub
network polling, Desktop automation, model reasoning, or OS sandbox enforcement.
