# Card-covered repeat notices

Use the metadata-only setup from SKILL.md with Bun 1.4.2:

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/covered-notices.ts
```

The helper owns a random-port daemon, disposable HOME/DB, a refusing GitHub stub
and an authenticated local RPC socket. Real work.status reads terminal SDK
records, and production driver refresh delivers the first structured blocker
report to Neo's mailbox. Only its same-state repeat with the matching card still
open stays quiet. Closed/replaced cards, a changed blocker, additional evidence
and an ordinary accepted work.send receipt retain the next report.

The same refresh admits the first stalled reminder with its card already open.
Public message.status confirms a consumed or failed producer receipt. A consumed
same-state reminder with its card open stays quiet. A closed or unrelated card,
a new blocker and failed delivery each retain the next reminder. Save
covered-notices.json and proof.log, including the wrapper exit status. Both
service and daemon close in finally. This proves durable mailbox admission and
receipt handling without a model turn, live daemon, browser or external service.

Focused tests additionally cover start cards, daily check-only reminders, failed
report admission, and uncovered stalled-ask reminders. Existing stalled-ask-wake
and per-todo-stall-reminders journeys retain their uncovered reminder contracts.
