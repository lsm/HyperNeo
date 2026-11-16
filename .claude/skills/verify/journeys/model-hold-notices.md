# Neo model hold notices

Use shared isolation and cleanup in `../SKILL.md`.

```bash
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/model-hold-notices.ts
```

The helper boots an isolated daemon on an ephemeral loopback port, with a fresh
HOME and database. It seeds a synthetic Neo session and changes only its recorded
processing state. The real driver-refresh job runs through the job processor.
An authenticated WebSocket reads `neo.snapshot` and observes `neo.session.notice`,
the existing phone-alert event.

Observe one `needs_you` event for login, one for a limit whose reset is over
30 minutes after its start, no duplicate event on repeated refresh, and no
current notice after recovery. A five-minute limit sends no alert. The helper
prints explicit counts and saves `model-hold-notices.json`. Unit contracts also
cover receipt restoration after restart, short-limit boundaries, and quiet
network/overload holds. This proof uses recorded holds without provider calls.
It closes the socket and daemon in `finally`.
